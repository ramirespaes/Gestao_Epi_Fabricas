'use strict';

const permissaoRepo = require('../repositories/permissao.repository');
const autoridade = require('./autoridade-administrativa');

/**
 * Serviço de leitura do catálogo de ações (Bloco 8, Incremento 8, Etapa
 * 5A, Subetapa 3T).
 *
 * POR QUE EXISTE: a tela de permissões de grupo (3T) precisa apresentar
 * QUAIS ações podem ser configuradas. Até aqui nenhuma rota expunha o
 * catálogo `acoes`, e a alternativa seria manter uma cópia manual dos
 * códigos dentro do frontend — que sairia de sincronia na primeira
 * migration a acrescentar ou desativar uma ação (a 024 acrescentou três).
 * O princípio que o bloco inteiro seguiu, "o catálogo real manda",
 * exigia expor o catálogo real.
 *
 * SÓ LEITURA, E SÓ DO CATÁLOGO: uma única operação, sem transação, sem
 * escrita e sem regra de negócio nova. Não decide autorização de
 * nada — apenas descreve o que existe. A decisão de autorização continua
 * inteiramente no middleware (3D/3G) e nos serviços administrativos.
 *
 * AUTORIDADE: exige a MESMA autoridade administrativa da configuração de
 * permissões de grupo (ADMINISTRAR_PERMISSOES_GRUPO, pela variante de
 * leitura do ponto único da 3Q). O catálogo é informação administrativa
 * e existe aqui para servir aquela tela; quem não pode configurar
 * permissões não precisa da lista. Isso mantém a disciplina já adotada
 * na 3M/3N/3O, onde também as CONSULTAS passaram a exigir autoridade.
 *
 * NÃO É POR EMPRESA, de propósito: `acoes` é catálogo compartilhado por
 * todas as empresas (migration 003). O que é por empresa é a PERMISSÃO
 * sobre a ação, que continua em permissoes_acao e grupo_permissoes_acao.
 * Ainda assim empresaId e atorId são obrigatórios e vêm da sessão: é
 * contra eles que a autoridade é verificada.
 */

const MSG_NAO_AUTORIZADO = 'Sem autoridade para consultar o catálogo de ações';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/**
 * Lista o catálogo de ações inteiro — inclusive as inativas, que a tela
 * precisa distinguir para não oferecer configuração de algo que o
 * backend recusaria.
 *
 * @param {{query: Function}} pool
 * @param {{empresaId: number, atorId: number}} dados vindos da sessão autenticada
 * @returns {Promise<Array<object>>}
 * @throws {HttpError} 403 sem autoridade administrativa
 */
async function listarAcoes(pool, { empresaId, atorId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  await autoridade.exigirAutoridadeAdministrativaLeitura(
    pool, empresaId, atorId,
    'CATALOGO_NAO_AUTORIZADO', MSG_NAO_AUTORIZADO,
    autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO,
  );

  return permissaoRepo.listarAcoes(pool);
}

module.exports = { listarAcoes };
