'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const materialRepo = require('../repositories/material.repository');
const estoqueRepo = require('../repositories/estoque-tamanho.repository');
const loteRepo = require('../repositories/estoque-lote.repository');
const operacaoRepo = require('../repositories/estoque-operacao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { DIAS_ALERTA_VALIDADE_CA } = require('../schemas/itens-disponiveis.schema');
const {
  MOTIVOS_BAIXA, TAMANHO_MAXIMO, CA_NUMERO_MAXIMO, JUSTIFICATIVA_MAXIMA,
} = require('../schemas/estoque.schema');
const { exigirDataOperacional } = require('../utils/data-operacional');

/**
 * Serviço de estoque por tamanho (Bloco 9, Etapa A).
 *
 * Duas operações: consultar (leitura, sem transação) e movimentar
 * (escrita transacional e auditada). Diferente de material.service.js,
 * cujas escritas são protegidas por PERMISSÃO DE RECURSO (`'materials'`),
 * movimentar() é protegida por PERMISSÃO DE AÇÃO (`MOVIMENTAR_ESTOQUE`) —
 * dimensão separada, decidida pelo middleware
 * `criarExigirPermissaoAcao('MOVIMENTAR_ESTOQUE')` (Bloco 8) montado na
 * rota, nunca reproduzida aqui. Ver o comentário equivalente em
 * material.service.js para a razão de nenhum service deste Bloco decidir
 * autorização internamente.
 *
 * MOVIMENTAR_ESTOQUE já nasce, desde a migration 017 (Bloco 8), com
 * `exige_sst = false` e `modo_autorizacao_individual = 'ALTERNATIVA'`:
 * não é exclusiva da SST, e o MASTER está sempre autorizado por perfil,
 * sem depender de grupo nem de autorização individual — o middleware que
 * decide isso já existe e não é alterado nesta etapa.
 *
 * ISOLAMENTO: estoque_tamanhos não tem empresa_id próprio (migration 008);
 * todo acesso passa por material.repository.js/estoque-tamanho.repository.js,
 * que filtram por empresa via o material dono. Um material de outra
 * empresa nunca é encontrado, e portanto seu estoque nunca é alcançado.
 *
 * MATERIAL INATIVO NÃO MOVIMENTA ESTOQUE: restrição estrutural, não de
 * permissão — vale para qualquer perfil, MASTER incluído (mesmo princípio
 * já documentado na seção 10/matriz MASTER do planejamento do Bloco 9).
 */

const ACAO_AUDITORIA_MOVIMENTACAO = 'ESTOQUE_MOVIMENTADO';

// estoque_tamanhos.quantidade é INTEGER (int4, migration 008) — o schema
// Zod já recusa uma quantidade movimentada acima deste teto, mas a SOMA
// resultante (saldo atual + entrada) também precisa ser verificada aqui:
// duas entradas legítimas, cada uma dentro do teto, podem ultrapassá-lo
// juntas (correção pós-auditoria de 23/09/2026).
const LIMITE_INTEGER_POSTGRES = 2147483647;

const MSG_MATERIAL_NAO_ENCONTRADO = 'Material não encontrado';
const MSG_MATERIAL_INATIVO = 'Material inativo não pode ter estoque movimentado';
const MSG_ESTOQUE_INSUFICIENTE = 'Saldo insuficiente para esta saída';
const MSG_ESTOQUE_LIMITE_EXCEDIDO = 'A soma resultante excede o limite máximo de estoque suportado';
const MSG_TAMANHO_INVALIDO = 'Tamanho inválido';
const MSG_QUANTIDADE_INVALIDA = 'Quantidade inválida';
const MSG_TIPO_INVALIDO = 'Tipo de movimentação inválido';

const TIPOS_VALIDOS = new Set(['ENTRADA', 'SAIDA']);

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function normalizarTamanho(tamanho) {
  if (typeof tamanho !== 'string') {
    return null;
  }
  const aparado = tamanho.trim();
  if (aparado.length === 0 || aparado.length > estoqueRepo.TAMANHO_MAXIMO_TAMANHO) {
    return null;
  }
  return aparado;
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
 * Consulta os saldos de estoque de um material, por tamanho.
 *
 * Leitura: não abre transação e não audita.
 *
 * @throws {HttpError} 404 quando o material não existe nesta empresa
 * @returns {Promise<{material: object, saldos: Array<object>}>}
 */
async function consultar(pool, { empresaId, materialId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(materialId, 'identificador de material');

  const material = await materialRepo.buscarPorId(pool, empresaId, materialId);
  if (material === null) {
    throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
  }

  const saldos = await estoqueRepo.listarPorMaterial(pool, empresaId, materialId);
  return { material, saldos };
}

/**
 * Movimenta o saldo de um material+tamanho: ENTRADA soma, SAIDA subtrai.
 * Quando o tamanho ainda não tem linha de saldo, uma ENTRADA cria a linha
 * (a partir de zero); uma SAIDA sobre um tamanho inexistente é recusada
 * como saldo insuficiente (zero disponível).
 *
 * Transação: trava o material (impede movimentar um material que esteja
 * sendo inativado na mesma janela) e a linha de saldo, na mesma ordem já
 * usada em todo o Bloco 8 (ator/recurso pai primeiro, dependente depois),
 * evitando deadlock com outras operações que travem as duas.
 *
 * @param {{empresaId: number, atorId: number, materialId: number, tamanho: string,
 *   tipo: 'ENTRADA'|'SAIDA', quantidade: number, motivo?: string|null,
 *   ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @throws {HttpError} 404 material inexistente nesta empresa; 409 material
 *   inativo ou saldo insuficiente para a saída
 */
async function movimentar(pool, {
  empresaId, atorId, materialId, tamanho, tipo, quantidade, motivo = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(materialId, 'identificador de material');

  const tamanhoNormalizado = normalizarTamanho(tamanho);
  if (tamanhoNormalizado === null) {
    throw HttpError.badRequest('ESTOQUE_TAMANHO_INVALIDO', MSG_TAMANHO_INVALIDO);
  }
  if (typeof tipo !== 'string' || !TIPOS_VALIDOS.has(tipo)) {
    throw HttpError.badRequest('ESTOQUE_TIPO_INVALIDO', MSG_TIPO_INVALIDO);
  }
  if (!Number.isInteger(quantidade) || quantidade <= 0 || quantidade > LIMITE_INTEGER_POSTGRES) {
    throw HttpError.badRequest('ESTOQUE_QUANTIDADE_INVALIDA', MSG_QUANTIDADE_INVALIDA);
  }

  return emTransacao(pool, async (client) => {
    const material = await materialRepo.buscarPorIdParaAtualizacao(client, empresaId, materialId);
    if (material === null) {
      throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
    }
    if (material.ativo !== true) {
      throw HttpError.conflict('MATERIAL_INATIVO', MSG_MATERIAL_INATIVO);
    }

    const saldoAtual = await estoqueRepo.buscarPorMaterialTamanhoParaAtualizacao(client, empresaId, materialId, tamanhoNormalizado);
    const quantidadeAnterior = saldoAtual === null ? 0 : saldoAtual.quantidade;
    const novaQuantidade = tipo === 'ENTRADA' ? quantidadeAnterior + quantidade : quantidadeAnterior - quantidade;

    // Barreira de domínio ANTES do banco: uma saída maior que o saldo
    // disponível é regra operacional, não erro interno — mesmo quando
    // chk_estoque_tamanhos_quantidade (migration 008) acabaria recusando
    // de qualquer forma, este é o ponto que produz um 409 claro.
    if (novaQuantidade < 0) {
      throw HttpError.conflict('ESTOQUE_INSUFICIENTE', MSG_ESTOQUE_INSUFICIENTE);
    }
    // A quantidade movimentada já é validada contra o teto do INTEGER
    // acima, mas a SOMA (quantidadeAnterior + quantidade) pode ultrapassá-lo
    // mesmo quando as duas parcelas, isoladas, estão dentro do limite.
    if (novaQuantidade > LIMITE_INTEGER_POSTGRES) {
      throw HttpError.conflict('ESTOQUE_LIMITE_EXCEDIDO', MSG_ESTOQUE_LIMITE_EXCEDIDO);
    }

    // empresaId viaja também para a escrita (não só para a leitura acima):
    // reforça o isolamento multiempresa na própria operação SQL, defesa em
    // profundidade além da leitura travada já ter confirmado o dono do
    // material (correção pós-auditoria de 23/09/2026, ver
    // estoque-tamanho.repository.js).
    const saldoAtualizado = saldoAtual === null
      ? await estoqueRepo.criar(client, { empresaId, materialId, tamanho: tamanhoNormalizado, quantidade: novaQuantidade })
      : await estoqueRepo.atualizarQuantidade(client, empresaId, saldoAtual.id, novaQuantidade);
    if (saldoAtualizado === null) {
      // Só alcançável se o material deixou de pertencer a esta empresa
      // entre o lock acima e esta escrita — não deveria acontecer dado o
      // desenho transacional, mas a barreira SQL (seção 5 da auditoria)
      // não confia apenas nisso.
      throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_MOVIMENTACAO,
      referencia: `${materialId}:${tamanhoNormalizado}`,
      ip,
      dispositivo,
      contexto: { tipo, quantidadeMovimentada: quantidade, motivo },
      dadosAnteriores: { quantidade: quantidadeAnterior },
      dadosNovos: { quantidade: novaQuantidade },
    });

    return saldoAtualizado;
  });
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
  consultar, movimentar, listarDisponiveis, listarLotes, registrarEntrada, registrarBaixa,
};
