'use strict';

const { HttpError } = require('../errors/HttpError');
const { exigirPodeReceberEpi } = require('../utils/situacao-funcionario');
const funcionarioRepo = require('../repositories/funcionario.repository');
const materialRepo = require('../repositories/material.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const empresaRepo = require('../repositories/empresa.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const operacaoRepo = require('../repositories/estoque-operacao.repository');
const parRepo = require('../repositories/estoque-par.repository');
const fichaRepo = require('../repositories/ficha-epi.repository');
const numeracaoRepo = require('../repositories/ficha-epi-numeracao.repository');
const entregaRepo = require('../repositories/entrega-epi.repository');
const itemRepo = require('../repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../repositories/entrega-epi-confirmacao.repository');
const solicitacaoRepo = require('../repositories/solicitacao-epi.repository');
const solicitacaoItemRepo = require('../repositories/solicitacao-epi-item.repository');
const coberturaRepo = require('../repositories/solicitacao-epi-cobertura.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const idempotencia = require('../utils/idempotencia');
const comum = require('./entrega-epi-comum');

/**
 * Entrega por solicitação (12C-2): o fluxo interno solicitação aprovada →
 * cobertura FIFO → lote escolhido → entrega física → estoque → ficha →
 * confirmação → auditoria → fechamento ENTREGUE. Só a camada de negócio, sem
 * HTTP. Autorização é das rotas, quando existirem (ação REALIZAR_ENTREGA);
 * empresaId e atorId vêm da sessão.
 *
 * O chamador informa o mínimo: a solicitação, a chave de idempotência, os
 * itens (item da solicitação, lote e quantidade) e a confirmação. Trabalhador,
 * material, tamanho, motivo, justificativas, previsão no GHE, justificativa
 * técnica fora do GHE e GHE vêm da solicitação e das relações gravadas, e o
 * item que traz qualquer um deles é recusado. A data operacional é a da
 * transação, em São Paulo.
 *
 * Uma entrega SOLICITACAO pertence a uma única solicitação, tem um item por
 * lote (a 058 não repete lote na entrega) e pode atender vários itens da
 * solicitação e vários lotes do mesmo item. A entrega é parcial por desenho:
 * a quantidade do ato, somada por item da solicitação (dividir entre lotes
 * não contorna), tem de caber no pendente (aprovada menos o já entregue) e na
 * cobertura FIFO do item naquele instante.
 *
 * Travas, na ordem aprovada, para não formar ciclo com decisão, entrada,
 * baixa e entrega direta: advisory da chave → solicitação (FOR NO KEY UPDATE)
 * → trabalhador (FOR NO KEY UPDATE) → materiais (FOR SHARE, ids crescentes)
 * → pares material+tamanho (advisory, ordem canônica) → lotes (FOR UPDATE,
 * ids crescentes) → contador da ficha. A cobertura é recalculada DEPOIS de
 * todas as travas; o gatilho da 066 só reafirma a trava da solicitação que
 * este serviço já tem, e a conferência dele continua sendo a última barreira.
 *
 * Ordem das validações: chave (resultado repetido) → solicitação entregável →
 * itens da solicitação → trabalhador e materiais ativos → lotes (existência,
 * material e tamanho do item, CA) → pendente → cobertura → saldo do lote.
 * A cobertura vem antes do saldo do lote para o erro ser o mesmo em qualquer
 * ordem de chegada de atos concorrentes.
 */

const {
  LIMITE_ITENS, LIMITE_INTEGER_POSTGRES, exigirId, inteiroPositivo, recusar, emTransacao, validarConfirmacao, calcularHashConteudo, aparar,
  enderecoDaEmpresa, publicarEntrega, repetirSeJaRegistrada, copiaDoMaterial, exigirClassificacaoDoMaterial, exigirCaValidoDoLote, exigirSaldoDoLote,
} = comum;

const ACAO_ENTREGA = 'ENTREGA_REGISTRADA';
const ACAO_ENTREGUE = 'SOLICITACAO_EPI_ENTREGUE';
const STATUS_ENTREGAVEIS = Object.freeze(['APROVADA', 'APROVADA_PARCIAL']);
const CAMPOS_DO_ITEM = Object.freeze(['solicitacaoItemId', 'loteId', 'quantidade']);
const NOME_DE_CAMPO = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MSG_FORMATO_INVALIDO = 'Formato inválido';

function validarItens(itens) {
  if (!Array.isArray(itens) || itens.length < 1 || itens.length > LIMITE_ITENS) {
    throw recusar('itens', 'ITENS_FORA_DO_LIMITE', `A entrega precisa ter de 1 a ${LIMITE_ITENS} itens`);
  }
  const lotes = new Set();
  const normalizados = itens.map((item, i) => {
    const campo = `itens[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw recusar(campo, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    // O que o servidor deriva da solicitação não vem do chamador; o nome do campo recusado só volta se for um nome comum.
    for (const nome of Object.keys(item)) {
      if (!CAMPOS_DO_ITEM.includes(nome)) throw recusar(NOME_DE_CAMPO.test(nome) ? `${campo}.${nome}` : campo, 'CAMPO_NAO_PERMITIDO', 'Campo não permitido');
    }
    if (!inteiroPositivo(item.solicitacaoItemId)) throw recusar(`${campo}.solicitacaoItemId`, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.loteId)) throw recusar(`${campo}.loteId`, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.quantidade) || item.quantidade > LIMITE_INTEGER_POSTGRES) {
      throw recusar(`${campo}.quantidade`, 'QUANTIDADE_INVALIDA', 'Quantidade inválida');
    }
    if (lotes.has(item.loteId)) throw recusar('itens', 'LOTE_REPETIDO', 'Cada lote aparece uma vez só na entrega');
    lotes.add(item.loteId);
    return { solicitacaoItemId: item.solicitacaoItemId, loteId: item.loteId, quantidade: item.quantidade };
  });
  // Ordem canônica: a mesma entrega lógica vira a mesma requisição, qualquer que seja a ordem recebida.
  return normalizados.sort((a, b) => a.solicitacaoItemId - b.solicitacaoItemId || a.loteId - b.loteId);
}

/**
 * Hash da requisição lógica, com a tag própria ENTREGA_SOLICITACAO (nunca
 * coincide com o da DIRETA): a solicitação, os itens em ordem canônica
 * (item da solicitação, lote, quantidade) e a confirmação. Chave, ator, IP,
 * dispositivo e tudo o que o servidor deriva ficam de fora.
 */
function hashDaRequisicao({ solicitacaoId, itens, confirmacao }) {
  const itensCanonicos = [...itens]
    .sort((a, b) => a.solicitacaoItemId - b.solicitacaoItemId || a.loteId - b.loteId)
    .map((i) => [i.solicitacaoItemId, i.loteId, i.quantidade]);
  return idempotencia.hashRequisicao([
    'ENTREGA_SOLICITACAO', solicitacaoId, itensCanonicos, confirmacao.modo, confirmacao.tracos ?? null, confirmacao.declaracaoVersao, confirmacao.declaracaoTexto,
  ]);
}

const resumoDaSolicitacao = (s) => ({ id: s.id, numero: s.numero, status: s.status, entregueEm: s.entregueEm });

/** Soma a quantidade do ato por item da solicitação: dividir entre lotes não contorna a validação. */
function totaisPorItem(itens) {
  const totais = new Map();
  for (const { solicitacaoItemId, quantidade } of itens) totais.set(solicitacaoItemId, (totais.get(solicitacaoItemId) ?? 0) + quantidade);
  return new Map([...totais].sort((a, b) => a[0] - b[0]));
}

/**
 * Registra a entrega de itens de UMA solicitação aprovada. Devolve a entrega,
 * a ficha, os itens, a confirmação e o resumo da solicitação (ENTREGUE quando
 * este ato entregou o que faltava). A repetição da mesma chave e do mesmo
 * conteúdo devolve a entrega original.
 *
 * @param {object} dados empresaId e atorId vêm da sessão
 * @returns {Promise<{repetida: boolean, ficha: object, entrega: object, itens: object[], confirmacao: object, solicitacao: object}>}
 * @throws {HttpError} 400 dado inválido; 404 solicitação, item, lote ou responsável fora da empresa;
 *   409 solicitação não entregável, item não aprovado, lote divergente, CA, quantidade acima do
 *   pendente ou da cobertura, saldo do lote, ou chave usada em outra entrega
 */
async function registrarEntregaPorSolicitacao(pool, {
  empresaId, atorId, solicitacaoId, itens, confirmacao, chaveIdempotencia, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const chave = idempotencia.chaveCanonica(chaveIdempotencia);
  if (chave === null) throw recusar('chaveIdempotencia', 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
  const pedidos = validarItens(itens);
  const confirmacaoN = validarConfirmacao(confirmacao);
  const requisicaoHash = hashDaRequisicao({ solicitacaoId, itens: pedidos, confirmacao: confirmacaoN });

  return emTransacao(pool, async (client) => {
    const repetida = await repetirSeJaRegistrada(client, empresaId, chave, requisicaoHash);
    if (repetida !== null) {
      return { ...repetida, solicitacao: resumoDaSolicitacao(await solicitacaoRepo.buscarPorId(client, empresaId, solicitacaoId)) };
    }

    const hoje = await entregaRepo.dataOperacionalDaTransacao(client);
    const solicitacao = await solicitacaoRepo.travarPorId(client, empresaId, solicitacaoId);
    if (solicitacao === null) throw HttpError.notFound('SOLICITACAO_NAO_ENCONTRADA', 'Solicitação não encontrada');
    if (!STATUS_ENTREGAVEIS.includes(solicitacao.status)) {
      throw HttpError.conflict('SOLICITACAO_NAO_ENTREGAVEL', 'A solicitação não está aprovada para entrega');
    }

    // Lidos depois da trava da solicitação: toda entrega da mesma solicitação espera por ela, e o entregue é o de agora.
    const itensDaSolicitacao = new Map((await solicitacaoItemRepo.listarPorSolicitacaoComEntregue(client, empresaId, solicitacaoId)).map((i) => [i.id, i]));
    for (const pedido of pedidos) {
      const alvo = itensDaSolicitacao.get(pedido.solicitacaoItemId);
      if (alvo === undefined) throw HttpError.notFound('ITEM_SOLICITACAO_NAO_ENCONTRADO', 'Item da solicitação não encontrado');
      if (alvo.decisao !== 'APROVADO') throw HttpError.conflict('ITEM_NAO_APROVADO', 'O item da solicitação não foi aprovado');
    }
    const totais = totaisPorItem(pedidos);
    const alvos = [...totais.keys()].map((id) => itensDaSolicitacao.get(id));

    const funcionario = await funcionarioRepo.buscarPorIdParaEntrega(client, empresaId, solicitacao.funcionarioId);
    if (funcionario === null || funcionario.ativo !== true) {
      // AFASTADO tem código próprio; inativo (ou ausente) segue SOLICITACAO_NAO_ENTREGAVEL.
      if (funcionario !== null && funcionario.situacao === 'AFASTADO') exigirPodeReceberEpi(funcionario);
      throw HttpError.conflict('SOLICITACAO_NAO_ENTREGAVEL', 'O trabalhador da solicitação está inativo');
    }
    const fichaExistente = await fichaRepo.buscarPorFuncionario(client, empresaId, funcionario.id);

    const materialIds = [...new Set(alvos.map((a) => a.materialId))].sort((a, b) => a - b);
    const materiais = new Map((await materialRepo.listarPorIdsParaVinculo(client, empresaId, materialIds)).map((m) => [m.id, m]));
    for (const id of materialIds) {
      const material = materiais.get(id);
      if (material === undefined || material.ativo !== true) {
        throw HttpError.conflict('SOLICITACAO_NAO_ENTREGAVEL', 'O material do item da solicitação está inativo');
      }
      exigirClassificacaoDoMaterial(material);
    }

    await parRepo.travarPares(client, empresaId, alvos.map((a) => ({ materialId: a.materialId, tamanho: a.tamanho })));
    const loteIds = pedidos.map((p) => p.loteId);
    const lotes = new Map((await operacaoRepo.travarLotesParaEntrega(client, empresaId, loteIds)).map((l) => [l.loteId, l]));
    for (const pedido of pedidos) {
      const lote = lotes.get(pedido.loteId);
      if (lote === undefined) throw HttpError.notFound('LOTE_NAO_ENCONTRADO', 'Lote não encontrado');
      const alvo = itensDaSolicitacao.get(pedido.solicitacaoItemId);
      if (lote.materialId !== alvo.materialId || (lote.tamanho ?? null) !== (alvo.tamanho ?? null)) {
        throw HttpError.conflict('LOTE_DIVERGENTE_DO_ITEM', 'O lote não é do material e do tamanho do item da solicitação');
      }
      exigirCaValidoDoLote(lote, materiais.get(alvo.materialId), hoje);
    }

    // Cobertura recalculada com tudo travado: nunca a calculada antes da trava do par.
    const cobertura = new Map((await coberturaRepo.listarCobertura(client, empresaId, { hoje, solicitacaoId })).map((c) => [c.itemId, c]));
    const solicitacaoItens = [];
    for (const [itemId, total] of totais) {
      const alvo = itensDaSolicitacao.get(itemId);
      const pendente = alvo.quantidadeAprovada - alvo.quantidadeEntregue;
      if (total > pendente) throw HttpError.conflict('QUANTIDADE_ACIMA_DO_PENDENTE', 'Quantidade maior que o pendente do item da solicitação');
      const coberta = cobertura.get(itemId)?.coberta ?? 0;
      if (total > coberta) throw HttpError.conflict('QUANTIDADE_ACIMA_DA_COBERTURA', 'Quantidade maior que a cobertura atual do item da solicitação');
      solicitacaoItens.push({
        solicitacaoItemId: itemId, quantidade: total, quantidadePendenteAntes: pendente, coberturaAntes: coberta, quantidadePendenteDepois: pendente - total,
      });
    }
    for (const pedido of pedidos) exigirSaldoDoLote(lotes.get(pedido.loteId), pedido.quantidade);

    const ghe = funcionario.grupoHomogeneoId === null ? null : await gheRepo.buscarPorId(client, empresaId, funcionario.grupoHomogeneoId);
    const empresa = await empresaRepo.buscarDetalhesPorId(client, empresaId);
    if (empresa === null) throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');
    const responsavel = await usuarioRepo.buscarPorId(client, empresaId, atorId);
    if (responsavel === null) throw HttpError.notFound('RESPONSAVEL_NAO_ENCONTRADO', 'Responsável não encontrado');

    const ficha = fichaExistente ?? await fichaRepo.criar(client, {
      empresaId, funcionarioId: funcionario.id, numero: await numeracaoRepo.proximoNumero(client, empresaId),
    });
    const entrega = await entregaRepo.criar(client, {
      empresaId,
      fichaId: ficha.id,
      responsavelId: atorId,
      gheId: ghe === null ? null : ghe.id,
      origem: 'SOLICITACAO',
      chave,
      requisicaoHash,
      empresa: {
        nome: empresa.razaoSocial.trim(), cnpj: empresa.cnpj, endereco: enderecoDaEmpresa(empresa), cidade: aparar(empresa.cidade), uf: aparar(empresa.uf)?.toUpperCase() ?? null,
      },
      trabalhador: { nome: funcionario.nome.trim(), matricula: aparar(funcionario.matricula), funcao: aparar(funcionario.funcao), setor: aparar(funcionario.setor) },
      gheNome: ghe === null ? null : ghe.nome.trim(),
      responsavelNome: responsavel.nome.trim(),
    });

    const saldosAntes = [];
    const itensGravados = [];
    for (const pedido of [...pedidos].sort((a, b) => a.loteId - b.loteId)) {
      const alvo = itensDaSolicitacao.get(pedido.solicitacaoItemId);
      const lote = lotes.get(pedido.loteId);
      saldosAntes.push({ loteId: lote.loteId, saldo: lote.saldo });
      // Motivo, justificativa, previsão no GHE e justificativa técnica da SST: os já gravados na solicitação e na decisão.
      const item = await itemRepo.criar(client, {
        empresaId,
        entregaId: entrega.id,
        materialId: alvo.materialId,
        loteId: pedido.loteId,
        quantidade: pedido.quantidade,
        motivo: alvo.motivo,
        justificativa: alvo.justificativa,
        previstoNoGhe: alvo.previstoNoGhe,
        justificativaForaGhe: alvo.previstoNoGhe ? null : alvo.justificativaDecisao,
        material: copiaDoMaterial(materiais.get(alvo.materialId)),
        solicitacaoItemId: alvo.id,
      });
      const operacao = await operacaoRepo.registrarEntrega(client, {
        empresaId, loteId: item.loteId, usuarioId: atorId, quantidade: item.quantidade, entregaItemId: item.id,
      });
      itensGravados.push({ item, operacao });
    }

    const itensLidos = await itemRepo.listarPorEntrega(client, empresaId, entrega.id);
    const hashConteudo = calcularHashConteudo({ entrega, ficha, itens: itensLidos, confirmacao: confirmacaoN });
    const confirmacaoGravada = await confirmacaoRepo.criar(client, {
      empresaId, entregaId: entrega.id, ...confirmacaoN, hashConteudo, ip, dispositivo,
    });
    const lotesDepois = await operacaoRepo.listarLotes(client, empresaId, loteIds);

    // Fechamento: com o entregue derivado de agora, se todos os itens aprovados estão completos a solicitação passa a ENTREGUE na mesma transação.
    const depois = (await solicitacaoItemRepo.listarPorSolicitacaoComEntregue(client, empresaId, solicitacaoId)).filter((i) => i.decisao === 'APROVADO');
    const completa = depois.every((i) => i.quantidadeEntregue === i.quantidadeAprovada);
    const fechada = completa ? await solicitacaoRepo.marcarEntregue(client, empresaId, solicitacaoId) : null;

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_ENTREGA,
      referencia: String(entrega.id),
      ip,
      dispositivo,
      contexto: {
        entregaId: entrega.id,
        origem: 'SOLICITACAO',
        solicitacaoId,
        ficha: { id: ficha.id, numero: ficha.numero },
        funcionarioId: funcionario.id,
        gheId: ghe === null ? null : ghe.id,
        responsavelId: atorId,
        itens: itensGravados.map(({ item, operacao }) => ({
          itemId: item.id,
          solicitacaoItemId: item.solicitacaoItemId,
          materialId: item.materialId,
          loteId: item.loteId,
          quantidade: item.quantidade,
          motivo: item.motivo,
          previstoNoGhe: item.previstoNoGhe,
          operacaoId: operacao.id,
        })),
        solicitacaoItens,
        entregaParcial: fechada === null,
        confirmacao: { modo: confirmacaoGravada.modo, declaracaoVersao: confirmacaoGravada.declaracaoVersao, hashConteudo },
        idempotencia: { chave, requisicaoHash },
      },
      dadosAnteriores: { saldos: saldosAntes },
      dadosNovos: { saldos: lotesDepois.map((l) => ({ loteId: l.loteId, saldo: l.saldo })) },
    });
    if (fechada !== null) {
      await auditoriaRepo.registrar(client, {
        empresaId,
        usuarioId: atorId,
        acao: ACAO_ENTREGUE,
        referencia: String(solicitacaoId),
        ip,
        dispositivo,
        contexto: {
          solicitacaoId,
          entregaId: entrega.id,
          funcionarioId: funcionario.id,
          itens: depois.map((i) => ({ solicitacaoItemId: i.id, quantidadeAprovada: i.quantidadeAprovada, quantidadeEntregue: i.quantidadeEntregue })),
        },
        dadosAnteriores: { status: solicitacao.status },
        dadosNovos: { status: 'ENTREGUE' },
      });
    }

    return {
      repetida: false,
      ficha: { id: ficha.id, numero: ficha.numero, funcionarioId: ficha.funcionarioId },
      entrega: publicarEntrega(entrega),
      itens: itensLidos,
      confirmacao: confirmacaoGravada,
      solicitacao: resumoDaSolicitacao(fechada ?? solicitacao),
    };
  });
}

module.exports = { LIMITE_ITENS, registrarEntregaPorSolicitacao, hashDaRequisicao };
