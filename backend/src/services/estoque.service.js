'use strict';

const { HttpError } = require('../errors/HttpError');
const materialRepo = require('../repositories/material.repository');
const estoqueRepo = require('../repositories/estoque-tamanho.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

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

module.exports = { consultar, movimentar };
