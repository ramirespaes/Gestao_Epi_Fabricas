'use strict';

const { normalizarCnpj } = require('../utils/normalizacao');

/**
 * Repositório de empresas.
 *
 * A empresa é a raiz do isolamento multiempresa: toda consulta de negócio
 * parte dela. Por isso este é o primeiro repositório e o que fixa o padrão
 * dos demais.
 *
 * O executor de consultas chega por parâmetro e nunca é importado. Ele pode
 * ser o pool, um cliente dentro de transação ou, no futuro, a conexão
 * escolhida para a empresa autenticada. Importar o pool aqui obrigaria a
 * reescrever todos os repositórios quando cada contratante tiver seu próprio
 * banco.
 *
 * O repositório consulta e devolve, sem decidir regra de negócio. Ausência é
 * null, não exceção, porque quem precisa responder de forma indistinguível
 * para empresa inexistente e senha errada é o serviço de autenticação.
 *
 * As consultas são sempre parametrizadas e projetam apenas os campos
 * necessários. Dados cadastrais que não participam da autenticação, como os
 * do encarregado de proteção de dados, não são trazidos.
 */

const CAMPOS_PUBLICOS = Object.freeze(['id', 'nome', 'cnpj', 'ativo']);
const PROJECAO = CAMPOS_PUBLICOS.join(', ');

/**
 * O CNPJ precisa chegar já normalizado. Normalizar aqui dentro esconderia de
 * quem chama o fato de que a forma canônica é responsabilidade da camada
 * acima, e abriria espaço para o mesmo valor ser consultado de duas formas.
 */
function exigirCnpjNormalizado(cnpj) {
  if (typeof cnpj !== 'string' || normalizarCnpj(cnpj) !== cnpj) {
    throw new TypeError('cnpj deve chegar normalizado');
  }
}

function exigirIdentificador(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  nome: linha.nome,
  cnpj: linha.cnpj,
  ativo: linha.ativo,
});

/**
 * Busca a empresa pelo CNPJ canônico. É o primeiro passo do login: sem
 * empresa não há usuário a procurar.
 *
 * @param {{query: Function}} executor
 * @param {string} cnpj já normalizado
 * @returns {Promise<{id: number, nome: string, cnpj: string, ativo: boolean}|null>}
 */
async function buscarPorCnpj(executor, cnpj) {
  exigirCnpjNormalizado(cnpj);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM empresas WHERE cnpj = $1`,
    [cnpj],
  );

  return mapear(rows[0]);
}

/**
 * Busca a empresa pelo identificador, usado para recarregar o contexto a
 * partir de uma sessão já existente.
 */
async function buscarPorId(executor, id) {
  exigirIdentificador(id);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM empresas WHERE id = $1`,
    [id],
  );

  return mapear(rows[0]);
}

/**
 * Função própria, e não uma condição embutida na consulta de sessão, porque
 * o que torna uma empresa apta a usar o sistema tende a crescer: hoje é a
 * coluna ativo, adiante pode incluir situação de assinatura e liberação
 * provisória. Quem chama continua perguntando a mesma coisa.
 */
async function existeAtiva(executor, id) {
  exigirIdentificador(id);

  const { rows } = await executor.query(
    'SELECT EXISTS (SELECT 1 FROM empresas WHERE id = $1 AND ativo) AS existe',
    [id],
  );

  return rows[0] !== undefined && rows[0].existe === true;
}

module.exports = { buscarPorCnpj, buscarPorId, existeAtiva, CAMPOS_PUBLICOS };
