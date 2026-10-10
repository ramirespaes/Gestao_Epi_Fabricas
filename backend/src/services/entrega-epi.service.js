'use strict';

const { HttpError } = require('../errors/HttpError');
const { exigirPodeReceberEpi } = require('../utils/situacao-funcionario');
const funcionarioRepo = require('../repositories/funcionario.repository');
const materialRepo = require('../repositories/material.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const gheMaterialRepo = require('../repositories/ghe-material.repository');
const empresaRepo = require('../repositories/empresa.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const operacaoRepo = require('../repositories/estoque-operacao.repository');
const parRepo = require('../repositories/estoque-par.repository');
const coberturaRepo = require('../repositories/solicitacao-epi-cobertura.repository');
const fichaRepo = require('../repositories/ficha-epi.repository');
const numeracaoRepo = require('../repositories/ficha-epi-numeracao.repository');
const entregaRepo = require('../repositories/entrega-epi.repository');
const itemRepo = require('../repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../repositories/entrega-epi-confirmacao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const idempotencia = require('../utils/idempotencia');
const comum = require('./entrega-epi-comum');
const saldoLivre = require('./saldo-livre');
const auditoriaRecusa = require('./auditoria-recusa-saldo-livre');

/**
 * Registro da entrega DIRETA de EPI (Bloco 10). Uma transação só: chave de
 * idempotência → trabalhador → ficha → materiais → pares → lotes → validações
 * → saldo livre → numeração (se primeira entrega) → cabeçalho → itens →
 * operações ENTREGA → confirmação → hash de conteúdo → auditoria → COMMIT.
 * Qualquer falha desfaz tudo.
 *
 * A DIRETA só usa o saldo livre do par (empresa, material, tamanho): o que
 * está comprometido com solicitações aprovadas é reservado, e quem precisa
 * dele entrega pela solicitação. Recusa: 409 SALDO_LIVRE_INSUFICIENTE, com a
 * auditoria da recusa em transação própria, depois do ROLLBACK.
 *
 * Autorização é das rotas (ação REALIZAR_ENTREGA). empresaId e atorId vêm da
 * sessão. As cópias congeladas são lidas aqui, na transação; nada delas vem
 * do cliente. entregue_em e data_operacional são os DEFAULTs do banco.
 *
 * Travas, nesta ordem, para não formar ciclo com entrada, baixa, decisão e
 * entrega por solicitação: advisory da chave → trabalhador (FOR NO KEY
 * UPDATE) → materiais (FOR SHARE, ids crescentes) → pares material+tamanho
 * (advisory, ordem canônica) → lotes (FOR UPDATE, ids crescentes) → contador
 * da numeração. Os pares são achados por leitura sem trava, porque material e
 * tamanho do lote nunca mudam (042). A posição do par é lida depois das
 * travas, e o CHECK de saldo da 042 continua sendo a última barreira.
 *
 * O que esta entrega compartilha com a entrega por solicitação (confirmação,
 * hash de conteúdo, resultado repetido, cópias do documento, classificação do
 * material e regras do lote) está em entrega-epi-comum.js.
 */

const {
  LIMITE_ITENS, LIMITE_INTEGER_POSTGRES, exigirId, inteiroPositivo, recusar, emTransacao, normalizarTracos, declaracaoValida, validarConfirmacao,
  calcularHashConteudo, aparar, enderecoDaEmpresa, publicarEntrega, repetirSeJaRegistrada, copiaDoMaterial, exigirClassificacaoDoMaterial,
  exigirCaValidoDoLote, exigirSaldoDoLote,
} = comum;
const { MOTIVOS, JUSTIFICATIVA_MAXIMA } = itemRepo;
const ACAO_AUDITORIA = 'ENTREGA_REGISTRADA';
const CARACTERE_CONTROLE = /\p{Cc}/u;

const MSG_FORMATO_INVALIDO = 'Formato inválido';

function textoCanonico(valor, maximo) {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim().normalize('NFC');
  const tamanho = Array.from(texto).length;
  return tamanho === 0 || tamanho > maximo || CARACTERE_CONTROLE.test(texto) ? null : texto;
}

function justificativaOpcional(valor, campo) {
  if (valor === null || valor === undefined) return null;
  const texto = textoCanonico(valor, JUSTIFICATIVA_MAXIMA);
  if (texto === null) throw recusar(campo, 'JUSTIFICATIVA_INVALIDA', 'Justificativa inválida');
  return texto;
}

function validarItens(itens) {
  if (!Array.isArray(itens) || itens.length < 1 || itens.length > LIMITE_ITENS) {
    throw recusar('itens', 'ITENS_FORA_DO_LIMITE', `A entrega precisa ter de 1 a ${LIMITE_ITENS} itens`);
  }
  const lotes = new Set();
  const normalizados = itens.map((item, i) => {
    const campo = `itens[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw recusar(campo, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.materialId)) throw recusar(`${campo}.materialId`, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.loteId)) throw recusar(`${campo}.loteId`, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.quantidade) || item.quantidade > LIMITE_INTEGER_POSTGRES) {
      throw recusar(`${campo}.quantidade`, 'QUANTIDADE_INVALIDA', 'Quantidade inválida');
    }
    if (!MOTIVOS.includes(item.motivo)) throw recusar(`${campo}.motivo`, 'VALOR_NAO_PERMITIDO', 'Valor não permitido');
    const justificativa = justificativaOpcional(item.justificativa, `${campo}.justificativa`);
    if (item.motivo === 'OUTRO' && justificativa === null) {
      throw recusar(`${campo}.justificativa`, 'JUSTIFICATIVA_OBRIGATORIA', 'Justificativa obrigatória para o motivo OUTRO');
    }
    const justificativaForaGhe = justificativaOpcional(item.justificativaForaGhe, `${campo}.justificativaForaGhe`);
    if (lotes.has(item.loteId)) throw recusar('itens', 'LOTE_REPETIDO', 'Cada lote aparece uma vez só na entrega');
    lotes.add(item.loteId);
    return {
      materialId: item.materialId, loteId: item.loteId, quantidade: item.quantidade, motivo: item.motivo, justificativa, justificativaForaGhe,
    };
  });
  // Ordem canônica: a mesma entrega lógica vira a mesma requisição, qualquer que seja a ordem recebida.
  return normalizados.sort((a, b) => a.loteId - b.loteId);
}

/**
 * Hash da requisição lógica: trabalhador, itens em ordem canônica de lote e a
 * confirmação. Chave, ator, IP, dispositivo e tudo que o servidor gera ficam
 * de fora.
 */
function hashDaRequisicao({ funcionarioId, itens, confirmacao }) {
  const itensCanonicos = [...itens]
    .sort((a, b) => a.loteId - b.loteId)
    .map((i) => [i.materialId, i.loteId, i.quantidade, i.motivo, i.justificativa ?? null, i.justificativaForaGhe ?? null]);
  return idempotencia.hashRequisicao([
    'ENTREGA', funcionarioId, itensCanonicos, confirmacao.modo, confirmacao.tracos ?? null, confirmacao.declaracaoVersao, confirmacao.declaracaoTexto,
  ]);
}

function validarMateriais(materiais, idsPedidos) {
  const porId = new Map(materiais.map((m) => [m.id, m]));
  for (const id of idsPedidos) {
    const material = porId.get(id);
    if (material === undefined) throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', 'Material não encontrado');
    if (material.ativo !== true) throw HttpError.conflict('MATERIAL_INATIVO', 'Material inativo não pode ser entregue');
    exigirClassificacaoDoMaterial(material);
  }
  return porId;
}

function validarLote(lote, material, item, hoje) {
  if (lote === undefined) throw HttpError.notFound('LOTE_NAO_ENCONTRADO', 'Lote não encontrado');
  if (lote.materialId !== item.materialId) throw HttpError.conflict('LOTE_MATERIAL_DIVERGENTE', 'O lote não é do material informado');
  if (material.exigeTamanho && lote.tamanho === null) throw HttpError.conflict('LOTE_SEM_TAMANHO', 'Este material exige lote com tamanho');
  exigirCaValidoDoLote(lote, material, hoje);
  exigirSaldoDoLote(lote, item.quantidade);
}

/**
 * A DIRETA só usa o saldo livre do par: a soma do ato por par (dividir entre
 * lotes não contorna) cabe em L = max(0, U − D). A posição é lida com o par e
 * os lotes já travados, nunca antes.
 */
async function exigirSaldoLivre(client, empresaId, itens, lotes, hoje) {
  const somas = saldoLivre.somarPorPar(itens.map((i) => {
    const lote = lotes.get(i.loteId);
    return { materialId: lote.materialId, tamanho: lote.tamanho, quantidade: i.quantidade };
  }));
  const pares = [...somas.values()].map(({ materialId, tamanho }) => ({ materialId, tamanho }));
  const posicoes = await coberturaRepo.lerPosicoes(client, empresaId, pares, { hoje });
  const recusas = saldoLivre.recusasPorSaldoLivre(posicoes, somas);
  if (recusas.length > 0) throw saldoLivre.recusaPorSaldoLivre({ operacao: 'ENTREGA_DIRETA', recusas });
}

function decidirGhe(item, previstos) {
  const previsto = previstos.has(item.materialId);
  if (previsto && item.justificativaForaGhe !== null) {
    throw HttpError.conflict('JUSTIFICATIVA_FORA_GHE_NAO_SE_APLICA', 'O EPI está previsto no GHE do trabalhador: não cabe justificativa de exceção');
  }
  if (!previsto && item.justificativaForaGhe === null) {
    throw HttpError.conflict('JUSTIFICATIVA_FORA_GHE_OBRIGATORIA', 'O EPI não está previsto no GHE do trabalhador: informe a justificativa');
  }
  return previsto;
}

/**
 * Registra a entrega. O trabalhador e os materiais precisam existir na
 * empresa e estar ativos; cada lote precisa ser do material, ter tamanho
 * quando o material exige, CA válido na data operacional quando o material
 * exige CA e saldo para a quantidade. A ficha é criada na primeira entrega.
 *
 * @param {object} dados empresaId e atorId vêm da sessão
 * @returns {Promise<{repetida: boolean, ficha: object, entrega: object, itens: object[], confirmacao: object}>}
 * @throws {HttpError} 400 dado inválido; 404 trabalhador, material, lote ou responsável fora
 *   da empresa; 409 regra de negócio ou chave usada em outra entrega
 */
async function registrarEntrega(pool, {
  empresaId, atorId, funcionarioId, itens, confirmacao, chaveIdempotencia, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');
  const chave = idempotencia.chaveCanonica(chaveIdempotencia);
  if (chave === null) throw recusar('chaveIdempotencia', 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
  const itensN = validarItens(itens);
  const confirmacaoN = validarConfirmacao(confirmacao);
  const requisicaoHash = hashDaRequisicao({ funcionarioId, itens: itensN, confirmacao: confirmacaoN });

  try {
    return await entregarNaTransacao(pool, {
      empresaId, atorId, funcionarioId, itensN, confirmacaoN, chave, requisicaoHash, ip, dispositivo,
    });
  } catch (erro) {
    // Só depois do ROLLBACK: a recusa é auditada em transação própria e nunca troca o erro.
    await auditoriaRecusa.auditarRecusaDoErro(pool, { empresaId, atorId, ip }, erro);
    throw erro;
  }
}

async function entregarNaTransacao(pool, {
  empresaId, atorId, funcionarioId, itensN, confirmacaoN, chave, requisicaoHash, ip, dispositivo,
}) {
  return emTransacao(pool, async (client) => {
    const repetida = await repetirSeJaRegistrada(client, empresaId, chave, requisicaoHash);
    if (repetida !== null) return repetida;

    const hoje = await entregaRepo.dataOperacionalDaTransacao(client);
    const funcionario = await funcionarioRepo.buscarPorIdParaEntrega(client, empresaId, funcionarioId);
    if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Trabalhador não encontrado');
    exigirPodeReceberEpi(funcionario);
    // Lida depois da trava do trabalhador: uma primeira entrega simultânea já terá criado a ficha.
    const fichaExistente = await fichaRepo.buscarPorFuncionario(client, empresaId, funcionarioId);

    const materialIds = [...new Set(itensN.map((i) => i.materialId))].sort((a, b) => a - b);
    const materiais = validarMateriais(await materialRepo.listarPorIdsParaVinculo(client, empresaId, materialIds), materialIds);
    const loteIds = itensN.map((i) => i.loteId);
    // Material e tamanho do lote nunca mudam (042): a leitura sem trava só serve para achar os pares a travar.
    const pares = (await operacaoRepo.listarLotes(client, empresaId, loteIds)).map((l) => ({ materialId: l.materialId, tamanho: l.tamanho }));
    await parRepo.travarPares(client, empresaId, pares);
    const lotes = new Map((await operacaoRepo.travarLotesParaEntrega(client, empresaId, loteIds)).map((l) => [l.loteId, l]));
    for (const item of itensN) {
      validarLote(lotes.get(item.loteId), materiais.get(item.materialId), item, hoje);
    }
    await exigirSaldoLivre(client, empresaId, itensN, lotes, hoje);

    const ghe = funcionario.grupoHomogeneoId === null ? null : await gheRepo.buscarPorId(client, empresaId, funcionario.grupoHomogeneoId);
    const previstos = new Set(ghe === null ? [] : await gheMaterialRepo.listarMaterialIdsPrevistos(client, empresaId, ghe.id, materialIds));
    const decisoes = itensN.map((item) => ({ ...item, previstoNoGhe: decidirGhe(item, previstos) }));

    const empresa = await empresaRepo.buscarDetalhesPorId(client, empresaId);
    if (empresa === null) throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');
    const responsavel = await usuarioRepo.buscarPorId(client, empresaId, atorId);
    if (responsavel === null) throw HttpError.notFound('RESPONSAVEL_NAO_ENCONTRADO', 'Responsável não encontrado');

    const ficha = fichaExistente ?? await fichaRepo.criar(client, {
      empresaId, funcionarioId, numero: await numeracaoRepo.proximoNumero(client, empresaId),
    });
    const entrega = await entregaRepo.criar(client, {
      empresaId,
      fichaId: ficha.id,
      responsavelId: atorId,
      gheId: ghe === null ? null : ghe.id,
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
    for (const decisao of decisoes) {
      const lote = lotes.get(decisao.loteId);
      saldosAntes.push({ loteId: lote.loteId, saldo: lote.saldo });
      const item = await itemRepo.criar(client, {
        empresaId,
        entregaId: entrega.id,
        materialId: decisao.materialId,
        loteId: decisao.loteId,
        quantidade: decisao.quantidade,
        motivo: decisao.motivo,
        justificativa: decisao.justificativa,
        previstoNoGhe: decisao.previstoNoGhe,
        justificativaForaGhe: decisao.justificativaForaGhe,
        material: copiaDoMaterial(materiais.get(decisao.materialId)),
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

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA,
      referencia: String(entrega.id),
      ip,
      dispositivo,
      contexto: {
        entregaId: entrega.id,
        ficha: { id: ficha.id, numero: ficha.numero },
        funcionarioId,
        gheId: ghe === null ? null : ghe.id,
        responsavelId: atorId,
        itens: itensGravados.map(({ item, operacao }) => ({
          itemId: item.id, materialId: item.materialId, loteId: item.loteId, quantidade: item.quantidade, motivo: item.motivo, previstoNoGhe: item.previstoNoGhe, operacaoId: operacao.id,
        })),
        confirmacao: { modo: confirmacaoGravada.modo, declaracaoVersao: confirmacaoGravada.declaracaoVersao, hashConteudo },
        idempotencia: { chave, requisicaoHash },
      },
      dadosAnteriores: { saldos: saldosAntes },
      dadosNovos: { saldos: lotesDepois.map((l) => ({ loteId: l.loteId, saldo: l.saldo })) },
    });

    return {
      repetida: false,
      ficha: { id: ficha.id, numero: ficha.numero, funcionarioId: ficha.funcionarioId },
      entrega: publicarEntrega(entrega),
      itens: itensLidos,
      confirmacao: confirmacaoGravada,
    };
  });
}

module.exports = {
  LIMITE_ITENS, registrarEntrega, hashDaRequisicao, calcularHashConteudo, normalizarTracos, declaracaoValida,
};
