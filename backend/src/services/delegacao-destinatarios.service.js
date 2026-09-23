'use strict';

const usuarioRepo = require('../repositories/usuario.repository');
const autorizacaoRepo = require('../repositories/autorizacao-individual.repository');
const permissaoRepo = require('../repositories/permissao.repository');
const { HttpError } = require('../errors/HttpError');

/**
 * Destinatários para delegação de autorização individual (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3V — complemento aprovado por
 * decisão expressa do usuário).
 *
 * O PROBLEMA QUE RESOLVE: um não-MASTER pode ter uma autorização
 * legítima e repassável — a 3I deixa que ele delegue — e ainda assim
 * não ter ADMINISTRAR_VINCULOS_GRUPO, que é o que a consulta de pessoas
 * da 3U exige. Sem esta rota, ele saberia que pode delegar e não teria
 * a quem. A alternativa de emprestar ADMINISTRAR_VINCULOS_GRUPO foi
 * expressamente vetada: seria dar autoridade administrativa de grupos
 * a quem só precisa reconhecer uma pessoa.
 *
 * A AUTORIDADE DESTA CONSULTA É "PODER DELEGAR AO MENOS UMA". Não é
 * "ter uma linha com pode_delegar" — é a MESMA verificação que a 3I faz
 * na hora de delegar, recalculada aqui em modo de leitura, na mesma
 * ordem e com as mesmas funções de leitura de permissao.repository.js
 * que o middleware usa:
 *
 *   1. o ator existe, está ativo e NÃO é MASTER (MASTER não delega —
 *      o caminho dele é a concessão direta, e a lista da 3U);
 *   2. ele tem ao menos uma autorização PRÓPRIA com pode_delegar = true
 *      cuja ação está ativa, tem modo ALTERNATIVA ou OBRIGATORIA e
 *      configuração reconhecível (espelha carregarAcaoConcedivel);
 *   3. para essa ação ele tem autorização EFETIVA: a concessão existe,
 *      integra a SST se a ação exige, e não está bloqueado (espelha
 *      delegadorTemAutorizacaoEfetiva).
 *
 * Basta UMA origem passar para a consulta abrir. Se nenhuma passa, 403
 * — inclusive para quem tem a linha mas está fora da SST, ou bloqueado:
 * "poder executar não é poder delegar", e "ter a linha não é poder
 * delegar agora".
 *
 * O QUE ESTA CONSULTA NÃO FAZ: não concede nada. Não permite executar,
 * não permite delegar, não permite administrar grupos. O POST de
 * delegação continua sendo revalidado por inteiro pela 3I, que relê
 * origem, pode_delegar, beneficiário, ação e autorização efetiva sob
 * FOR UPDATE. Esta consulta só responde "a quem você poderia repassar".
 *
 * SÓ LEITURA: sem transação, sem escrita, sem auditoria. As funções da
 * 3I não são importadas — são privadas daquele módulo, e o módulo não
 * foi tocado. O espelho aqui é explícito e documentado, teste a teste.
 *
 * ISOLAMENTO: empresaId vem da sessão e é o primeiro parâmetro
 * obrigatório de todas as leituras. O ator é relido do banco.
 */

const PERFIL_MASTER = 'MASTER';
const MODOS_DELEGAVEIS = new Set(['ALTERNATIVA', 'OBRIGATORIA']);
const LIMITE = 50;
const MSG_NAO_AUTORIZADO = 'Sem autorização repassável valendo agora; não há a quem repassar';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/** Uma origem serve para delegar? A mesma pergunta da 3I, sem travar nada. */
async function origemEfetiva(pool, empresaId, atorId, origem) {
  if (origem.podeDelegar !== true) return false;
  if (origem.acaoAtiva !== true) return false;
  if (!MODOS_DELEGAVEIS.has(origem.acaoModo)) return false;
  if (typeof origem.acaoExigeSst !== 'boolean') return false;

  const concedido = await permissaoRepo.usuarioTemAutorizacaoIndividual(pool, empresaId, atorId, origem.acaoCodigo);
  if (!concedido) return false;

  if (origem.acaoExigeSst === true) {
    const integraSst = await permissaoRepo.usuarioIntegraSst(pool, empresaId, atorId);
    if (!integraSst) return false;
  }

  const bloqueado = await permissaoRepo.usuarioTemBloqueio(pool, empresaId, atorId, origem.acaoCodigo);
  return !bloqueado;
}

/**
 * @param {{query: Function}} pool
 * @param {{empresaId: number, atorId: number, busca?: string|null}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @returns {Promise<{destinatarios: Array<{id: number, nome: string, email: string}>, total: number}>}
 * @throws {HttpError} 403 quando o ator não pode delegar nenhuma autorização agora
 */
async function listarDestinatarios(pool, { empresaId, atorId, busca = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  const ator = await usuarioRepo.buscarPorId(pool, empresaId, atorId);
  if (ator === null || ator.ativo !== true || ator.perfil === PERFIL_MASTER) {
    throw HttpError.forbidden('CONSULTA_DESTINATARIOS_NAO_AUTORIZADA', MSG_NAO_AUTORIZADO);
  }

  const minhas = await autorizacaoRepo.listarPorUsuario(pool, empresaId, atorId);

  let podeDelegarAlguma = false;
  for (const origem of minhas) {
    // Verificação em série, e para na primeira que serve: não há razão
    // para consultar SST e bloqueio de todas as origens.
    // eslint-disable-next-line no-await-in-loop
    if (await origemEfetiva(pool, empresaId, atorId, origem)) {
      podeDelegarAlguma = true;
      break;
    }
  }

  if (!podeDelegarAlguma) {
    throw HttpError.forbidden('CONSULTA_DESTINATARIOS_NAO_AUTORIZADA', MSG_NAO_AUTORIZADO);
  }

  return usuarioRepo.listarDestinatariosAtivos(pool, empresaId, { busca, excluirId: atorId, limite: LIMITE });
}

module.exports = { listarDestinatarios };
