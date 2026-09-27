'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const materialRepo = require('../repositories/material.repository');
const loteRepo = require('../repositories/estoque-lote.repository');
const operacaoRepo = require('../repositories/estoque-operacao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { DIAS_ALERTA_VALIDADE_CA } = require('../schemas/itens-disponiveis.schema');
const {
  MOTIVOS_BAIXA, TAMANHO_MAXIMO, CA_NUMERO_MAXIMO, JUSTIFICATIVA_MAXIMA,
} = require('../schemas/estoque.schema');
const { exigirDataOperacional } = require('../utils/data-operacional');

/**
 * Serviço de estoque por lote (Bloco 9).
 *
 * Leituras (itens disponíveis, lotes de um material, validade e histórico
 * de operações) e as duas escritas do estoque: entrada, que cria um lote, e
 * baixa manual de um lote. Tudo passa por estoque_lotes e estoque_operacoes.
 * O saldo antigo por tamanho ficou só como histórico da migration 043, e
 * nenhuma rota o lê nem o grava.
 *
 * Autorização é decidida nas rotas, nunca aqui: leituras por permissão de
 * RECURSO; entrada e baixa pela AÇÃO `MOVIMENTAR_ESTOQUE` (migrations
 * 003/017), dimensão separada da edição do cadastro do material.
 *
 * MATERIAL INATIVO NÃO RECEBE ENTRADA: restrição estrutural, não de
 * permissão — vale para qualquer perfil, MASTER incluído. A baixa continua
 * possível, porque o estoque físico que existe precisa ser regularizado.
 */

// Teto do INTEGER do PostgreSQL para quantidades.
const LIMITE_INTEGER_POSTGRES = 2147483647;

const MSG_MATERIAL_NAO_ENCONTRADO = 'Material não encontrado';
const MSG_MATERIAL_INATIVO = 'Material inativo não pode ter estoque movimentado';
const MSG_TAMANHO_INVALIDO = 'Tamanho inválido';
const MSG_QUANTIDADE_INVALIDA = 'Quantidade inválida';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/** Mesmo padrão transacional de material.service.js e grupo-acesso.service.js. */
async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }
}

/**
 * Itens disponíveis (Parte C3): consulta agregada, somente leitura, sem
 * transação e sem auditoria. Empresa sempre da sessão (quem chama garante).
 * O prazo de alerta da validade do CA vem do schema (fonte única).
 *
 * O saldo vem dos lotes: disponível desconta o que está bloqueado por CA
 * vencido ou ausente, na data operacional recebida.
 */
async function listarDisponiveis(pool, {
  empresaId, hoje, categoria = null, tipo = null, tamanho = null, validade = null, pagina, limite,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirDataOperacional(hoje);
  const filtros = { categoria, tipo, tamanho, validade, hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA };
  const [itens, total, opcoes] = await Promise.all([
    loteRepo.listarDisponiveis(pool, empresaId, { ...filtros, pagina, limite }),
    loteRepo.contarDisponiveis(pool, empresaId, filtros),
    loteRepo.listarFiltrosDisponiveis(pool, empresaId),
  ]);
  return { itens, total, pagina, limite, filtros: opcoes };
}

function somarSaldos(lotes) {
  return lotes.reduce((total, l) => ({
    fisico: total.fisico + l.fisico,
    bloqueado: total.bloqueado + l.bloqueado,
    disponivel: total.disponivel + l.disponivel,
  }), { fisico: 0, bloqueado: 0, disponivel: 0 });
}

/**
 * E7 — validade de estoque: lotes com saldo da empresa, com a situação do CA
 * na data operacional, filtro, busca, página e os indicadores do conjunto
 * inteiro. As três leituras usam a mesma regra do repositório.
 */
async function listarValidade(pool, {
  empresaId, situacao = null, busca = null, pagina = 1, limite, hoje,
}) {
  const referencia = { hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA };
  const [lotes, total, indicadores] = await Promise.all([
    loteRepo.listarValidade(pool, empresaId, { ...referencia, situacao, busca, pagina, limite }),
    loteRepo.contarValidade(pool, empresaId, { ...referencia, situacao, busca }),
    loteRepo.resumirValidade(pool, empresaId, referencia),
  ]);
  return { hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA, indicadores, lotes, total, pagina, limite };
}

/**
 * E8 — operações de estoque: o histórico de estoque_operacoes da empresa, só
 * leitura, com o total do filtro para a paginação. Saldo inicial, entrada e
 * baixa vêm como foram gravados; nada aqui altera uma operação.
 */
async function listarOperacoes(pool, {
  empresaId, tipo = null, de = null, ate = null, busca = null, pagina = 1, limite,
}) {
  exigirId(empresaId, 'identificador de empresa');
  const filtros = { tipo, de, ate, busca };
  const [operacoes, total] = await Promise.all([
    operacaoRepo.listarHistorico(pool, empresaId, { ...filtros, pagina, limite }),
    operacaoRepo.contarHistorico(pool, empresaId, filtros),
  ]);
  return { operacoes, total, pagina, limite, paginas: Math.ceil(total / limite) };
}

/**
 * Lotes com saldo de um material, com físico, bloqueado e disponível por lote,
 * por tamanho e no total. Material inativo também responde: a consulta mostra
 * o estoque que existe; a inatividade é tratada por quem entrega.
 *
 * @throws {HttpError} 404 quando o material não existe nesta empresa
 */
async function listarLotes(pool, { empresaId, materialId, hoje }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(materialId, 'identificador de material');
  exigirDataOperacional(hoje);

  const material = await materialRepo.buscarPorId(pool, empresaId, materialId);
  if (material === null) {
    throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
  }

  const lotes = await loteRepo.listarPorMaterial(pool, empresaId, materialId, { hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA });
  const tamanhos = [...new Set(lotes.map((l) => l.tamanho))];
  const porTamanho = tamanhos.map((tamanho) => ({ tamanho, ...somarSaldos(lotes.filter((l) => l.tamanho === tamanho)) }));
  return { material, hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA, lotes, porTamanho, totais: somarSaldos(lotes) };
}

// ── Entrada e baixa por lote ────────────────────────────────────────

const ACAO_AUDITORIA_ENTRADA = 'ESTOQUE_ENTRADA';
const ACAO_AUDITORIA_BAIXA = 'ESTOQUE_BAIXA';
// Tamanhos de logs_auditoria.ip e logs_auditoria.dispositivo (migration 012).
const TAMANHO_MAXIMO_IP = 45;
const TAMANHO_MAXIMO_DISPOSITIVO = 150;
const CHAVE_FORMATO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATA_FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const CARACTERE_CONTROLE = /\p{Cc}/u;

const MSG_LOTE_NAO_ENCONTRADO = 'Lote não encontrado';
const MSG_SALDO_LOTE_INSUFICIENTE = 'Quantidade maior que o saldo do lote';
const MSG_IDEMPOTENCIA_CONFLITO = 'Esta chave de idempotência já foi usada em outra operação';
const MSG_TAMANHO_NAO_CLASSIFICADO = 'Defina no cadastro se o material exige tamanho antes de registrar entradas';

// Mesmo formato do 400 da validação da rota: campo, código e mensagem, sem o valor recebido.
function recusar(campo, codigo, mensagem) {
  return HttpError.validacao([{ campo: `body.${campo}`, codigo, mensagem }]);
}

function textoCanonico(valor, maximo) {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim().normalize('NFC');
  const tamanho = Array.from(texto).length;
  return tamanho === 0 || tamanho > maximo || CARACTERE_CONTROLE.test(texto) ? null : texto;
}

function dataDeCalendario(valor) {
  return typeof valor === 'string' && DATA_FORMATO.test(valor) && valor >= '0001-01-01'
    && new Date(`${valor}T00:00:00Z`).toISOString().slice(0, 10) === valor;
}

function exigirQuantidade(quantidade) {
  if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > LIMITE_INTEGER_POSTGRES) {
    throw recusar('quantidade', 'QUANTIDADE_INVALIDA', MSG_QUANTIDADE_INVALIDA);
  }
}

function chaveCanonica(chave) {
  const minuscula = typeof chave === 'string' ? chave.toLowerCase() : '';
  if (!CHAVE_FORMATO.test(minuscula)) {
    throw recusar('chaveIdempotencia', 'FORMATO_INVALIDO', 'Formato inválido');
  }
  return minuscula;
}

const limitar = (valor, maximo) => (typeof valor === 'string' ? valor.slice(0, maximo) : null);

// Hash da requisição lógica, com os valores já normalizados: é ele que diz se
// uma chave repetida é a mesma operação ou outra. O corpo cru não entra.
function hashRequisicao(partes) {
  return crypto.createHash('sha256').update(JSON.stringify(partes)).digest('hex');
}

// Consulto a chave antes de qualquer regra: se a operação já foi feita, a
// repetição recebe o resultado original, mesmo que o material tenha sido
// inativado ou a data tenha virado depois. A trava vale até o fim da transação.
async function repetirSeJaRegistrada(client, empresaId, chave, requisicaoHash) {
  await operacaoRepo.travarChave(client, empresaId, chave);
  const existente = await operacaoRepo.buscarPorChave(client, empresaId, chave);
  if (existente === null) {
    return null;
  }
  const { requisicaoHash: hashOriginal, ...operacao } = existente;
  if (hashOriginal !== requisicaoHash) {
    throw HttpError.conflict('IDEMPOTENCIA_CONFLITO', MSG_IDEMPOTENCIA_CONFLITO);
  }
  return { repetida: true, operacao, lote: await operacaoRepo.buscarLote(client, empresaId, operacao.loteId) };
}

/**
 * Entrada de estoque: cria um lote com o CA e a validade informados e a
 * operação ENTRADA. O CA é exigido em toda entrada, mesmo que o material
 * esteja marcado como dispensado de CA. A validade pode vencer hoje: o CA
 * vale até o fim do dia. O tamanho segue o material: obrigatório quando ele
 * exige, null quando não usa, e material não classificado não recebe entrada.
 * Não escreve em estoque_tamanhos.
 *
 * @param {object} dados empresaId e atorId vêm da sessão; hoje é a data operacional de São Paulo
 * @returns {Promise<{repetida: boolean, operacao: object, lote: object}>}
 * @throws {HttpError} 400 dado inválido, tamanho fora da regra do material ou CA vencido;
 *   404 material fora da empresa; 409 material inativo, não classificado quanto ao
 *   tamanho, ou chave usada em outra operação
 */
async function registrarEntrada(pool, {
  empresaId, atorId, materialId, tamanho, quantidade, caNumero, caValidade, chaveIdempotencia, hoje, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(materialId, 'identificador de material');
  exigirDataOperacional(hoje);

  const semTamanho = tamanho === null || tamanho === undefined;
  const tamanhoN = semTamanho ? null : textoCanonico(tamanho, TAMANHO_MAXIMO);
  if (!semTamanho && tamanhoN === null) throw recusar('tamanho', 'TAMANHO_INVALIDO', MSG_TAMANHO_INVALIDO);
  exigirQuantidade(quantidade);
  const caNumeroN = textoCanonico(caNumero, CA_NUMERO_MAXIMO);
  if (caNumeroN === null) throw recusar('caNumero', 'CA_NUMERO_INVALIDO', 'Número do CA inválido');
  if (!dataDeCalendario(caValidade)) throw recusar('caValidade', 'CA_VALIDADE_INVALIDA', 'Data de validade do CA inválida');
  const chave = chaveCanonica(chaveIdempotencia);
  const requisicaoHash = hashRequisicao(['ENTRADA', materialId, tamanhoN, quantidade, caNumeroN, caValidade]);

  return emTransacao(pool, async (client) => {
    const repetida = await repetirSeJaRegistrada(client, empresaId, chave, requisicaoHash);
    if (repetida !== null) {
      return repetida;
    }

    const material = await materialRepo.buscarPorIdParaAtualizacao(client, empresaId, materialId);
    if (material === null) {
      throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
    }
    if (material.ativo !== true) {
      throw HttpError.conflict('MATERIAL_INATIVO', MSG_MATERIAL_INATIVO);
    }
    if (material.exigeTamanho === null || material.exigeTamanho === undefined) {
      throw HttpError.conflict('MATERIAL_TAMANHO_NAO_CLASSIFICADO', MSG_TAMANHO_NAO_CLASSIFICADO);
    }
    if (material.exigeTamanho && tamanhoN === null) {
      throw recusar('tamanho', 'TAMANHO_OBRIGATORIO', 'Este material exige tamanho');
    }
    if (!material.exigeTamanho && tamanhoN !== null) {
      throw recusar('tamanho', 'TAMANHO_NAO_SE_APLICA', 'Este material não usa tamanho');
    }
    if (caValidade < hoje) {
      throw recusar('caValidade', 'CA_VENCIDO', 'A validade do CA precisa ser hoje ou uma data futura');
    }

    const { operacao, lote } = await operacaoRepo.registrarEntrada(client, {
      empresaId, materialId, usuarioId: atorId, tamanho: tamanhoN, quantidade, caNumero: caNumeroN, caValidade, chave, requisicaoHash,
    });
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_ENTRADA,
      referencia: String(lote.loteId),
      ip: limitar(ip, TAMANHO_MAXIMO_IP),
      dispositivo: limitar(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO),
      contexto: {
        operacaoId: operacao.id, materialId, loteId: lote.loteId, tamanho: tamanhoN, caNumero: caNumeroN, caValidade, quantidade,
      },
      dadosNovos: { saldo: lote.saldo },
    });
    return { repetida: false, operacao, lote };
  });
}

/**
 * Baixa manual de um lote. Vale também para material inativo e para lote com
 * CA vencido ou sem CA: a empresa precisa regularizar o estoque físico que
 * existe. A quantidade nunca passa do saldo do lote; o lote zerado continua
 * no histórico.
 *
 * @param {object} dados empresaId e atorId vêm da sessão
 * @returns {Promise<{repetida: boolean, operacao: object, lote: object}>}
 * @throws {HttpError} 400 dado inválido; 404 lote fora da empresa;
 *   409 saldo insuficiente ou chave usada em outra operação
 */
async function registrarBaixa(pool, {
  empresaId, atorId, loteId, quantidade, motivo, justificativa = null, chaveIdempotencia, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(loteId, 'identificador de lote');

  exigirQuantidade(quantidade);
  if (!MOTIVOS_BAIXA.includes(motivo)) throw recusar('motivo', 'VALOR_NAO_PERMITIDO', 'Valor não permitido');
  const justificativaN = justificativa === null || justificativa === undefined ? null : textoCanonico(justificativa, JUSTIFICATIVA_MAXIMA);
  if (justificativaN === null && justificativa !== null && justificativa !== undefined) {
    throw recusar('justificativa', 'JUSTIFICATIVA_INVALIDA', 'Justificativa inválida');
  }
  if (motivo === 'OUTRO' && justificativaN === null) {
    throw recusar('justificativa', 'JUSTIFICATIVA_OBRIGATORIA', 'Justificativa obrigatória para o motivo OUTRO');
  }
  const chave = chaveCanonica(chaveIdempotencia);
  const requisicaoHash = hashRequisicao(['BAIXA', loteId, quantidade, motivo, justificativaN]);

  return emTransacao(pool, async (client) => {
    const repetida = await repetirSeJaRegistrada(client, empresaId, chave, requisicaoHash);
    if (repetida !== null) {
      return repetida;
    }

    const lote = await operacaoRepo.buscarLoteParaBaixa(client, empresaId, loteId);
    if (lote === null) {
      throw HttpError.notFound('LOTE_NAO_ENCONTRADO', MSG_LOTE_NAO_ENCONTRADO);
    }
    if (quantidade > lote.saldo) {
      throw HttpError.conflict('SALDO_LOTE_INSUFICIENTE', MSG_SALDO_LOTE_INSUFICIENTE);
    }

    const operacao = await operacaoRepo.registrarBaixa(client, {
      empresaId, loteId, usuarioId: atorId, quantidade, motivo, justificativa: justificativaN, chave, requisicaoHash,
    });
    const loteAtualizado = await operacaoRepo.buscarLote(client, empresaId, loteId);
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_BAIXA,
      referencia: String(loteId),
      ip: limitar(ip, TAMANHO_MAXIMO_IP),
      dispositivo: limitar(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO),
      contexto: {
        operacaoId: operacao.id, materialId: lote.materialId, loteId, tamanho: lote.tamanho, caNumero: lote.caNumero,
        quantidade, motivo, justificativa: justificativaN,
      },
      dadosAnteriores: { saldo: lote.saldo },
      dadosNovos: { saldo: loteAtualizado.saldo },
    });
    return { repetida: false, operacao, lote: loteAtualizado };
  });
}

module.exports = {
  listarDisponiveis, listarLotes, listarValidade, listarOperacoes, registrarEntrada, registrarBaixa,
};
