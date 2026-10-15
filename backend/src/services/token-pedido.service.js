'use strict';

const { HttpError } = require('../errors/HttpError');
const { hashTokenSessao, tokenSessaoTemFormatoValido } = require('../security/token');
const idempotencia = require('../utils/idempotencia');
const { exigirPodeReceberEpi } = require('../utils/situacao-funcionario');
const atendimentoRepo = require('../repositories/token-atendimento.repository');
const pedidoRepo = require('../repositories/token-pedido.repository');
const solicitacoesRepo = require('../repositories/token-solicitacoes.repository');
const solicitacaoRepo = require('../repositories/solicitacao-epi.repository');
const itemRepo = require('../repositories/solicitacao-epi-item.repository');
const numeracaoRepo = require('../repositories/solicitacao-epi-numeracao.repository');
const funcionarioRepo = require('../repositories/funcionario.repository');
const materialRepo = require('../repositories/material.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Atendimento Token — pedido do funcionário identificado (Etapa F). Cria a solicitação de EPI REAL de origem AUTOATENDIMENTO pelas mesmas
 * peças da 12G-6 (repositórios de solicitação, itens, numeração, idempotência e auditoria); não existe fluxo paralelo de aprovação, estoque,
 * reposição ou entrega: o pedido nasce PENDENTE e daí em diante é o fluxo existente (SST decide sem exigir estoque; a posição derivada reconhece
 * a reposição; só a entrega física baixa o lote e escreve a ficha). Nada aqui lê ou grava estoque.
 *
 * FRONTEIRA TRANSACIONAL. Requisição HTTP recebida NÃO é pedido aceito. Numa só transação: lock da chave de idempotência → lock da linha do tablet
 * (a mesma da ativação, revogação e rotação) com a credencial apresentada reconferida → atendimento do token → repetição? (resultado ORIGINAL) →
 * atendimento `FOR UPDATE`: aberto, não vencido pelo relógio do banco, funcionário ATIVO, não anterior à reativação (= PONTO DE ACEITE) → trabalhador
 * `FOR NO KEY UPDATE` → materiais `FOR SHARE` (ids crescentes, como a 12G) → GHE e autorização de cada item revalidados com o estado de agora →
 * duplicidade com itens em aberto do mesmo funcionário (Etapa G) → número, cabeçalho, itens, lateral 086, auditorias e atendimento encerrado
 * PEDIDO_ENVIADO → COMMIT. Aceite e persistência são UMA transação: não
 * existe pedido aceito e não gravado; o sucesso só é devolvido depois do COMMIT; qualquer falha é ROLLBACK de tudo (pedido, número e encerramento).
 * Depois do aceite a expiração do relógio não cancela nada; antes dele o pedido é recusado sem criar nada. Ordem de travas compatível com as
 * Etapas C, D e a 12G: idempotência → tablet → atendimento → trabalhador → materiais → numeração.
 *
 * UM PEDIDO POR ATENDIMENTO: o atendimento é encerrado (PEDIDO_ENVIADO) na mesma transação do pedido, sob o lock do atendimento; qualquer outro envio
 * (inclusive com OUTRA chave, simultâneo ou atrasado) encontra o atendimento encerrado e é recusado. Repetição idempotente = mesma chave, mesmo
 * atendimento e mesmo carrinho: devolve o pedido original, sem segundo pedido, mesmo com o atendimento já encerrado ou vencido.
 *
 * RECUPERAÇÃO (GET por chave): só devolve o pedido cuja lateral aponta para o atendimento do cookie apresentado (segredo, guardado só pelo hash), no
 * mesmo tablet e empresa; o atendimento encerrado por PEDIDO_ENVIADO NÃO é reaberto. A chave sozinha, com ou sem a credencial do tablet, não autoriza.
 */

const ACAO_CRIADA = 'SOLICITACAO_EPI_CRIADA';
const ACAO_ENCERRADO = 'TOKEN_ATENDIMENTO_ENCERRADO';

const atendimentoInvalido = () => HttpError.unauthorized('ATENDIMENTO_INVALIDO', 'Atendimento inválido ou expirado');
const naoAutorizado = () => HttpError.unauthorized('DISPOSITIVO_NAO_AUTORIZADO', 'Dispositivo não autorizado');
const pedidoNaoEncontrado = () => HttpError.notFound('PEDIDO_NAO_ENCONTRADO', 'Pedido não encontrado');
const recusar = (campo, codigo, mensagem) => HttpError.validacao([{ campo: `body.${campo}`, codigo, mensagem }]);
const itemNaoAutorizado = (indice) => new HttpError(409, 'ITEM_NAO_AUTORIZADO', 'Este item não está autorizado para o seu pedido', {
  detalhes: [{ campo: `body.itens[${indice}].materialId`, codigo: 'ITEM_NAO_AUTORIZADO', mensagem: 'Este item não está autorizado para o seu pedido' }],
});

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

/** A credencial apresentada ainda é a atual (ou a anterior, na carência) e o tablet segue ativo na empresa ativa (mesma regra da Etapa D). */
function credencialVale(tablet, credencialHash) {
  if (tablet === null || tablet.revogado_em !== null || tablet.empresa_ativa !== true) return false;
  return tablet.credencial_hash === credencialHash || tablet.credencial_anterior_hash === credencialHash;
}

const compararItens = (a, b) => {
  if (a.materialId !== b.materialId) return a.materialId - b.materialId;
  const ta = a.tamanho ?? '';
  const tb = b.tamanho ?? '';
  if (ta === tb) return 0;
  return ta < tb ? -1 : 1;
};

/** Itens em ordem canônica (a mesma requisição lógica vira a mesma, qualquer que seja a ordem recebida) e sem repetição de material+tamanho. */
function itensCanonicos(itens) {
  const vistos = new Set();
  const lista = itens.map((i, indice) => ({
    indice, materialId: i.materialId, tamanho: i.tamanho ?? null, quantidade: i.quantidade, motivo: i.motivo,
  }));
  for (const i of lista) {
    const chave = `${i.materialId}\n${i.tamanho ?? ''}`;
    if (vistos.has(chave)) throw recusar('itens', 'ITEM_REPETIDO', 'Cada material e tamanho aparece uma vez só no pedido');
    vistos.add(chave);
  }
  return lista.sort(compararItens);
}

/** Hash da requisição lógica: atendimento, funcionário e itens. Chave, IP, dispositivo e tudo que o servidor gera ficam de fora. */
function hashDoPedido({ atendimentoId, funcionarioId, itens }) {
  return idempotencia.hashRequisicao([
    'PEDIDO_AUTOATENDIMENTO', String(atendimentoId), funcionarioId, itens.map((i) => [i.materialId, i.tamanho ?? null, i.quantidade, i.motivo]),
  ]);
}

const visao = (solicitacao, itens) => ({
  numero: solicitacao.numero,
  status: solicitacao.status,
  quantidadeItens: solicitacao.quantidadeItens,
  itens: itens.map((i) => ({ materialId: i.materialId, tamanho: i.tamanho, quantidade: i.quantidade, motivo: i.motivo })),
});

async function auditarEncerramento(client, { empresaId, atendimentoId, dispositivoId, funcionarioId, motivo, ip, agente }) {
  await auditoriaRepo.registrar(client, {
    empresaId, usuarioId: null, acao: ACAO_ENCERRADO, referencia: String(atendimentoId), ip, dispositivo: agente, contexto: { motivo, dispositivoId, funcionarioId },
  });
}

const itemJaSolicitado = (indice) => new HttpError(409, 'ITEM_JA_SOLICITADO', 'Este item já foi solicitado', {
  detalhes: [{ campo: `body.itens[${indice}].materialId`, codigo: 'ITEM_JA_SOLICITADO', mensagem: 'Este item já foi solicitado' }],
});

/**
 * Prevenção de duplicidade (Etapa G, incremento sobre a F): cada item do carrinho é comparado, INDIVIDUALMENTE, com os itens EM ABERTO do
 * mesmo funcionário e da mesma empresa, por material físico e tamanho (sem tamanho compara com sem tamanho), sem olhar a quantidade
 * solicitada. Em aberto = quantidade ainda pendente > 0 (pedido PENDENTE; aprovado com aprovada > entregue), de pedido interno ou do
 * Totem, com ou sem estoque; entregue, cancelado, reprovado, encerrado e item reprovado nunca bloqueiam, e um pedido parcialmente entregue
 * só bloqueia os itens que ainda têm pendente. A definição de "em aberto" é a mesma da consulta do tablet.
 *
 * Roda dentro da transação, DEPOIS da trava do trabalhador (`FOR NO KEY UPDATE`, a mesma que a criação interna da 12G-6 toma antes de
 * gravar) e antes do número e do INSERT, em READ COMMITTED: um pedido concorrente do mesmo funcionário, interno ou do Totem, ou já foi
 * confirmado e é visto aqui, ou espera esta transação. Só 409 com a duplicidade confirmada; o corpo não revela o pedido existente.
 */
async function exigirSemDuplicidade(client, { empresaId, funcionarioId, itens }) {
  const abertos = await solicitacoesRepo.listarItensEmAberto(client, { empresaId, funcionarioId });
  if (abertos.length === 0) return;
  const emAberto = new Set(abertos.map((a) => `${a.materialId}\n${a.tamanho ?? ''}`));
  for (const i of itens) if (emAberto.has(`${i.materialId}\n${i.tamanho ?? ''}`)) throw itemJaSolicitado(i.indice);
}

/** Autorização e tamanhos de cada item, contra o catálogo da Etapa E no estado de agora (materiais já travados FOR SHARE). */
async function validarItens(client, { empresaId, gheId, itens }) {
  const gheOk = gheId !== null && await pedidoRepo.gheAtivo(client, empresaId, gheId);
  const ids = [...new Set(itens.map((i) => i.materialId))].sort((a, b) => a - b);
  await materialRepo.listarPorIdsParaVinculo(client, empresaId, ids);
  const autorizados = new Map();
  if (gheOk) {
    for (const m of await pedidoRepo.lerAutorizados(client, { empresaId, gheId, materialIds: ids })) {
      // Quem exige tamanho precisa de ao menos uma opção cadastrada (o catálogo da Etapa E já o exclui); quem não exige nunca é excluído por falta de grade.
      if (m.exige_tamanho !== true || m.tamanhos.length > 0) autorizados.set(m.id, m);
    }
  }
  for (const i of itens) if (!autorizados.has(i.materialId)) throw itemNaoAutorizado(i.indice);
  for (const i of itens) {
    const m = autorizados.get(i.materialId);
    if (m.exige_tamanho && i.tamanho === null) throw recusar(`itens[${i.indice}].tamanho`, 'TAMANHO_OBRIGATORIO', 'Este material exige tamanho');
    if (!m.exige_tamanho && i.tamanho !== null) throw recusar(`itens[${i.indice}].tamanho`, 'TAMANHO_NAO_SE_APLICA', 'Este material não usa tamanho');
    if (m.exige_tamanho && !m.tamanhos.includes(i.tamanho)) {
      throw recusar(`itens[${i.indice}].tamanho`, 'TAMANHO_FORA_DA_GRADE', 'Este tamanho não está disponível para o material');
    }
  }
}

/**
 * Finaliza o pedido. Devolve { repetida, pedido }.
 * @throws {HttpError} 400 itens; 401 dispositivo ou atendimento; 409 item não autorizado ou conflito de idempotência
 */
async function finalizar(pool, { dispositivo, credencialHash, token, corpo, ip = null, agente = null }) {
  if (!tokenSessaoTemFormatoValido(token)) throw atendimentoInvalido();
  const tokenHash = hashTokenSessao(token);
  const { chaveIdempotencia: chave } = corpo;
  const itens = itensCanonicos(corpo.itens);
  const { empresaId } = dispositivo;

  const resultado = await emTransacao(pool, async (client) => {
    await solicitacaoRepo.travarChave(client, empresaId, chave);
    const tablet = await atendimentoRepo.travarDispositivo(client, empresaId, dispositivo.id);
    if (!credencialVale(tablet, credencialHash)) return { negado: 'DISPOSITIVO' };
    const original = await pedidoRepo.buscarAtendimentoPorToken(client, { empresaId, dispositivoId: dispositivo.id, tokenHash });
    if (original === null) return { negado: 'ATENDIMENTO' };

    const hash = hashDoPedido({ atendimentoId: original.id, funcionarioId: original.funcionarioId, itens });
    const existente = await solicitacaoRepo.buscarPorChave(client, empresaId, chave);
    if (existente !== null) {
      const doPedido = await pedidoRepo.buscarAtendimentoDoPedido(client, { empresaId, solicitacaoId: existente.id });
      if (existente.requisicaoHash !== hash || doPedido === null || String(doPedido.atendimentoId) !== String(original.id)) {
        throw HttpError.conflict('IDEMPOTENCIA_CONFLITO', 'Esta chave de idempotência já foi usada em outro pedido');
      }
      return { repetida: true, pedido: visao(existente, await itemRepo.listarPorSolicitacao(client, empresaId, existente.id)) };
    }

    // Ponto de aceite: o atendimento é travado e conferido pelo relógio do banco.
    const atendimento = await atendimentoRepo.buscarAbertoPorToken(client, { empresaId, dispositivoId: dispositivo.id, tokenHash, travar: true });
    if (atendimento === null) return { negado: 'ATENDIMENTO' };
    const auditoriaDe = { empresaId, atendimentoId: atendimento.id, dispositivoId: dispositivo.id, funcionarioId: atendimento.funcionario_id, ip, agente };
    if (atendimento.vencido) {
      // O prazo se esgotou antes do aceite: fecha como INATIVIDADE (causa verdadeira) e recusa; o fechamento é confirmado, o pedido não existe.
      if (await atendimentoRepo.encerrar(client, { id: atendimento.id, motivo: 'INATIVIDADE' })) await auditarEncerramento(client, { ...auditoriaDe, motivo: 'INATIVIDADE' });
      return { negado: 'ATENDIMENTO' };
    }
    if (!atendimento.funcionario_ativo || atendimento.anterior_a_reativacao) return { negado: 'ATENDIMENTO' };

    const funcionario = await funcionarioRepo.buscarPorIdParaEntrega(client, empresaId, atendimento.funcionario_id);
    if (funcionario === null) return { negado: 'ATENDIMENTO' };
    try { exigirPodeReceberEpi(funcionario); } catch { return { negado: 'ATENDIMENTO' }; }

    await validarItens(client, { empresaId, gheId: funcionario.grupoHomogeneoId, itens });
    await exigirSemDuplicidade(client, { empresaId, funcionarioId: funcionario.id, itens });

    const solicitacao = await solicitacaoRepo.criar(client, {
      empresaId,
      numero: await numeracaoRepo.proximoNumero(client, empresaId),
      funcionarioId: funcionario.id,
      gheId: funcionario.grupoHomogeneoId,
      origemSolicitacao: 'AUTOATENDIMENTO',
      solicitanteUsuarioId: null,
      quantidadeItens: itens.length,
      observacao: null,
      chave,
      requisicaoHash: hash,
    });
    const gravados = [];
    for (const i of itens) {
      gravados.push(await itemRepo.criar(client, {
        empresaId, solicitacaoId: solicitacao.id, materialId: i.materialId, tamanho: i.tamanho, quantidade: i.quantidade, motivo: i.motivo, justificativa: null, previstoNoGhe: true,
      }));
    }
    await pedidoRepo.inserirLateral(client, { empresaId, solicitacaoId: solicitacao.id, dispositivoId: dispositivo.id, atendimentoId: atendimento.id });
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: null,
      acao: ACAO_CRIADA,
      referencia: String(solicitacao.id),
      ip,
      dispositivo: agente,
      contexto: {
        solicitacaoId: solicitacao.id,
        numero: solicitacao.numero,
        funcionarioId: funcionario.id,
        gheId: solicitacao.gheId,
        origemSolicitacao: solicitacao.origemSolicitacao,
        dispositivoId: dispositivo.id,
        atendimentoId: String(atendimento.id),
        itens: gravados.map((g) => ({ itemId: g.id, materialId: g.materialId, tamanho: g.tamanho, quantidade: g.quantidade, motivo: g.motivo })),
        idempotencia: { chave, requisicaoHash: hash },
      },
      dadosNovos: { status: solicitacao.status, quantidadeItens: solicitacao.quantidadeItens },
    });
    if (!(await pedidoRepo.encerrarComPedido(client, { id: atendimento.id }))) throw new Error('atendimento deixou de estar aberto sob a trava');
    await auditarEncerramento(client, { ...auditoriaDe, motivo: 'PEDIDO_ENVIADO' });
    return { repetida: false, pedido: visao(solicitacao, gravados) };
  });

  if (resultado.negado === 'DISPOSITIVO') throw naoAutorizado();
  if (resultado.negado === 'ATENDIMENTO') throw atendimentoInvalido();
  return resultado;
}

/**
 * Resultado de uma finalização pela chave. Só leitura; não renova nada. Devolve { http, pedido }:
 *   202 EM_PROCESSAMENTO (a finalização com esta chave está em curso: a trava da chave é só TENTADA, nunca esperada);
 *   200 REGISTRADO (o pedido existe e é deste atendimento, aberto ou encerrado por PEDIDO_ENVIADO); 404 nenhum pedido com esta chave NESTE atendimento.
 * Atendimento inexistente, de outro tablet/empresa, vencido, encerrado sem pedido, funcionário inelegível ou anterior à reativação: 401.
 */
async function resultado(pool, { dispositivo, token, chave }) {
  if (!tokenSessaoTemFormatoValido(token)) throw atendimentoInvalido();
  const tokenHash = hashTokenSessao(token);
  const { empresaId } = dispositivo;
  // READ COMMITTED de propósito: depois de obter a trava da chave cada leitura enxerga o COMMIT da finalização que a segurava.
  return emTransacao(pool, async (client) => {
    if (await pedidoRepo.buscarAtendimentoPorToken(client, { empresaId, dispositivoId: dispositivo.id, tokenHash }) === null) throw atendimentoInvalido();
    if (!(await pedidoRepo.tentarTravarChave(client, empresaId, chave))) return { http: 202, pedido: { estado: 'EM_PROCESSAMENTO' } };
    const atendimento = await pedidoRepo.buscarAtendimentoPorToken(client, { empresaId, dispositivoId: dispositivo.id, tokenHash });
    const solicitacao = await solicitacaoRepo.buscarPorChave(client, empresaId, chave);
    if (solicitacao !== null && atendimento !== null && atendimento.motivoEncerramento === 'PEDIDO_ENVIADO') {
      const doPedido = await pedidoRepo.buscarAtendimentoDoPedido(client, { empresaId, solicitacaoId: solicitacao.id });
      if (doPedido !== null && String(doPedido.atendimentoId) === String(atendimento.id)) {
        return { http: 200, pedido: { estado: 'REGISTRADO', numero: solicitacao.numero, status: solicitacao.status, quantidadeItens: solicitacao.quantidadeItens } };
      }
    }
    const aberto = await atendimentoRepo.buscarAbertoPorToken(client, { empresaId, dispositivoId: dispositivo.id, tokenHash });
    if (aberto === null || aberto.vencido || !aberto.funcionario_ativo || aberto.anterior_a_reativacao) throw atendimentoInvalido();
    throw pedidoNaoEncontrado();
  });
}

module.exports = { finalizar, resultado, hashDoPedido, itensCanonicos };
