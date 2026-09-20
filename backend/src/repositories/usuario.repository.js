'use strict';

const { normalizarEmail } = require('../utils/normalizacao');

/**
 * Repositório de usuários.
 *
 * Primeiro repositório com filtro de empresa, e por isso o que fixa o padrão
 * de isolamento dos demais: nenhuma busca é global. O identificador da
 * empresa é sempre o primeiro parâmetro e nunca é opcional, porque tornar o
 * filtro opcional é o caminho mais curto para um dia esquecê-lo.
 *
 * O executor chega por parâmetro e o pool nunca é importado, pelo mesmo
 * motivo do repositório de empresas: um dia a conexão será escolhida por
 * contratante.
 *
 * O hash da senha sai por uma única função, cujo nome anuncia isso. As demais
 * projetam somente os campos públicos, e nem sequer pedem a coluna ao banco.
 * Assim um objeto de usuário entregue ao contexto de sessão ou à camada de
 * apresentação não tem como carregar credencial, mesmo que alguém o espalhe
 * inteiro numa resposta.
 *
 * O repositório não decide se o usuário pode entrar. Usuário inativo é
 * devolvido normalmente, porque quem precisa responder de forma
 * indistinguível para usuário inexistente, inativo e senha errada é o serviço
 * de autenticação.
 *
 * As consultas por e-mail usam lower(email) para casar com o índice único
 * uq_usuarios_empresa_email_lower, criado pela migration 005 sobre
 * (empresa_id, lower(email)).
 */

const CAMPOS_PUBLICOS = Object.freeze([
  'id', 'empresa_id', 'nome', 'email', 'perfil', 'ativo', 'biometria_cadastrada',
]);
const PROJECAO_PUBLICA = CAMPOS_PUBLICOS.join(', ');
const PROJECAO_CREDENCIAL = `${PROJECAO_PUBLICA}, senha_hash`;

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirIdentificador(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('identificador de usuário inválido');
  }
}

/**
 * O e-mail precisa chegar já normalizado, pela mesma razão do CNPJ no
 * repositório de empresas: a forma canônica é responsabilidade da camada
 * acima, e aceitar variações abriria caminho para o mesmo usuário ser
 * consultado de duas maneiras.
 */
function exigirEmailNormalizado(email) {
  if (typeof email !== 'string' || normalizarEmail(email) !== email) {
    throw new TypeError('e-mail deve chegar normalizado');
  }
}

const mapearPublico = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresa_id: linha.empresa_id,
  nome: linha.nome,
  email: linha.email,
  perfil: linha.perfil,
  ativo: linha.ativo,
  biometria_cadastrada: linha.biometria_cadastrada,
});

/**
 * Busca um usuário da empresa pelo e-mail, sem credencial.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {string} email já normalizado
 */
async function buscarPorEmail(executor, empresaId, email) {
  exigirEmpresa(empresaId);
  exigirEmailNormalizado(email);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_PUBLICA} FROM usuarios WHERE empresa_id = $1 AND lower(email) = $2`,
    [empresaId, email],
  );

  return mapearPublico(rows[0]);
}

/**
 * Busca um usuário da empresa pelo identificador, sem credencial. Usada para
 * recarregar o contexto a partir de uma sessão existente.
 */
async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirIdentificador(id);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_PUBLICA} FROM usuarios WHERE empresa_id = $1 AND id = $2`,
    [empresaId, id],
  );

  return mapearPublico(rows[0]);
}

/**
 * Única função que traz o hash da senha. O nome é explícito para que o uso
 * indevido fique visível em revisão de código.
 *
 * O resultado destina-se exclusivamente à verificação da senha no serviço de
 * autenticação e não deve ser repassado adiante nem serializado.
 */
async function buscarCredencialPorEmail(executor, empresaId, email) {
  exigirEmpresa(empresaId);
  exigirEmailNormalizado(email);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_CREDENCIAL} FROM usuarios WHERE empresa_id = $1 AND lower(email) = $2`,
    [empresaId, email],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return { ...mapearPublico(linha), senha_hash: linha.senha_hash };
}

module.exports = {
  buscarPorEmail,
  buscarPorId,
  buscarCredencialPorEmail,
  CAMPOS_PUBLICOS,
};
