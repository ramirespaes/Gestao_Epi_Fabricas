'use strict';

const autorizacaoRepo = require('../repositories/autorizacao-individual.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const { HttpError } = require('../errors/HttpError');

/**
 * Consulta de autorizações individuais (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3V).
 *
 * POR QUE EXISTE, E POR QUE É UM MÓDULO SEPARADO: a Subetapa 3P não
 * criou rota de consulta porque o serviço da 3I não tinha função de
 * leitura — e continua sem ter. A tela administrativa da 3V precisa
 * listar o que existe (para revogar) e precisa saber quais autorizações
 * do PRÓPRIO ator têm pode_delegar = true (para oferecer origens
 * legítimas de delegação). Sem isso, a tela pediria um `origemId`
 * digitado, que é exatamente o que a autorização desta subetapa proíbe.
 *
 * O serviço da 3I não foi tocado: ele segue exportando apenas
 * concederDireta, delegar e revogar. Mesmo precedente da 3T
 * (catalogo.service.js) e da 3U (usuario-consulta.service.js) — leitura
 * nova entra em módulo próprio, em vez de engordar um serviço aprovado.
 *
 * A AUTORIDADE DE LEITURA ESPELHA A DE ESCRITA, e essa é a decisão
 * central deste módulo:
 *
 *   MASTER — concede direto a qualquer pessoa e revoga qualquer linha
 *   (3I). Logo, lê as autorizações de qualquer pessoa da empresa.
 *
 *   NÃO-MASTER — delega a partir de linha PRÓPRIA com pode_delegar, e
 *   revoga o que ELE concedeu (3I). Logo, lê integralmente as próprias
 *   autorizações e, sobre outras pessoas, apenas as linhas que ele mesmo
 *   concedeu. Nem uma linha a mais.
 *
 * Não se inventou ação administrativa para governar esta leitura: seria
 * preciso migration, o que esta subetapa não autoriza — e emprestar
 * ADMINISTRAR_VINCULOS_GRUPO ou ADMINISTRAR_PERMISSOES_GRUPO daria a
 * leitura a quem não pode agir, e a negaria ao delegador que pode. Por
 * isso a autoridade aqui não passa por autoridade-administrativa.js: a
 * regra da 3I é outra, e é ela que este módulo espelha.
 *
 * NÃO-MASTER CONSULTANDO OUTRA PESSOA NÃO RECEBE 403, e sim a lista
 * filtrada — possivelmente vazia. Devolver 403 informaria "existe algo
 * aqui que você não pode ver"; devolver o que ele concedeu (nada, se
 * nada concedeu) não revela existência alheia nenhuma.
 *
 * SÓ LEITURA: uma operação, sem transação, sem escrita, sem auditoria.
 * Consultar não é evento auditável — mesma decisão já tomada na 3T e na
 * 3U. Conceder, delegar e revogar continuam auditados pela 3I.
 *
 * ISOLAMENTO MULTIEMPRESA: `empresaId` vem da sessão e é o primeiro
 * parâmetro obrigatório do repositório. O ator é relido do banco a cada
 * chamada — perfil e `ativo` nunca chegam do cliente.
 */

const PERFIL_MASTER = 'MASTER';
const MSG_NAO_AUTORIZADO = 'Sem autoridade para consultar autorizações individuais';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/**
 * Lista as autorizações individuais de um usuário, conforme o que o ator
 * tem autoridade para enxergar.
 *
 * @param {{query: Function}} pool
 * @param {{empresaId: number, atorId: number, usuarioId: number}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @returns {Promise<{autorizacoes: Array<object>, escopo: 'TOTAL'|'PROPRIAS'|'CONCEDIDAS_POR_MIM'}>}
 * @throws {HttpError} 403 quando o ator não existe mais ou está inativo
 */
async function listarPorUsuario(pool, { empresaId, atorId, usuarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');

  // Perfil e `ativo` relidos agora: uma sessão aberta antes da
  // inativação não vale como autoridade.
  const ator = await usuarioRepo.buscarPorId(pool, empresaId, atorId);
  if (ator === null || ator.ativo !== true) {
    throw HttpError.forbidden('AUTORIZACAO_CONSULTA_NAO_AUTORIZADA', MSG_NAO_AUTORIZADO);
  }

  const ehMaster = ator.perfil === PERFIL_MASTER;
  const consultaAPropriaConta = usuarioId === atorId;

  // O filtro é o que materializa a autoridade: null = sem restrição.
  const concedidasPor = (ehMaster || consultaAPropriaConta) ? null : atorId;

  const autorizacoes = await autorizacaoRepo.listarPorUsuario(pool, empresaId, usuarioId, { concedidasPor });

  let escopo;
  if (ehMaster) escopo = 'TOTAL';
  else if (consultaAPropriaConta) escopo = 'PROPRIAS';
  else escopo = 'CONCEDIDAS_POR_MIM';

  return { autorizacoes, escopo };
}

module.exports = { listarPorUsuario };
