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

// Projeção da listagem de vínculos (Subetapa 3U): menor que a pública, de
// propósito — sem biometria_cadastrada, que não ajuda a decidir vínculo.
const CAMPOS_VINCULO = Object.freeze([
  'id', 'nome', 'email', 'perfil', 'ativo', 'grupo_acesso_id',
]);
const PROJECAO_VINCULO = CAMPOS_VINCULO.join(', ');

const MODOS_VINCULO = Object.freeze(['todos', 'sem_grupo', 'com_grupo']);

/** Neutraliza os curingas de LIKE digitados por quem pesquisa. */
function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}

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
 * Igual a buscarPorId, mas com FOR UPDATE: usada dentro de uma transação
 * para impedir que outra transação concorrente inative o usuário (ou altere
 * qualquer campo dele) enquanto esta decide algo com base no que leu —
 * necessária à camada de serviço de concessão/revogação de autorizações
 * individuais (Subetapa 3I), que precisa da garantia de que concedente e
 * beneficiário continuam ativos e na mesma empresa até o COMMIT. Nunca
 * usada pela autenticação nem pela leitura comum: fora de transação, FOR
 * UPDATE só adiciona um lock inútil.
 */
async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirIdentificador(id);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_PUBLICA} FROM usuarios WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
    [empresaId, id],
  );

  return mapearPublico(rows[0]);
}

/**
 * Lê, travando a linha, exatamente o que a administração de grupos precisa
 * decidir sobre um usuário: se ele existe NESTA empresa, se está ativo,
 * qual o seu perfil e a qual grupo está vinculado hoje.
 *
 * `grupo_acesso_id` (migration 020) fica deliberadamente FORA de
 * CAMPOS_PUBLICOS e das demais consultas: a projeção pública alimenta o
 * contexto de sessão e a camada de apresentação, e o vínculo de grupo não
 * tem por que viajar junto — quem decide autorização já o lê por
 * permissao.repository.buscarGrupoAcessoDoUsuario. Esta função é o único
 * lugar que o expõe, para uso administrativo (Subetapa 3L), e sempre sob
 * FOR UPDATE, dentro de transação.
 */
async function buscarVinculoGrupoParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirIdentificador(id);

  const { rows } = await executor.query(
    `SELECT id, empresa_id, perfil, ativo, grupo_acesso_id
       FROM usuarios
      WHERE empresa_id = $1 AND id = $2
      FOR UPDATE`,
    [empresaId, id],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return {
    id: linha.id,
    empresaId: linha.empresa_id,
    perfil: linha.perfil,
    ativo: linha.ativo,
    grupoAcessoId: linha.grupo_acesso_id,
  };
}

/**
 * Altera SOMENTE o vínculo de grupo de um usuário da empresa informada.
 * `grupoAcessoId` null retira o usuário do grupo (volta ao piso do
 * perfil). Nenhuma outra coluna aparece no SET — nome, e-mail, perfil,
 * senha e, principalmente, `ativo` ficam fora do alcance desta função.
 *
 * A FK composta fk_usuarios_grupo_mesma_empresa (migration 020) garante,
 * no próprio banco, que o grupo pertence à mesma empresa do usuário.
 *
 * @returns {Promise<{id: number, grupoAcessoId: number|null}|null>} null se
 *   o usuário não existir nesta empresa.
 */
async function atualizarGrupoAcesso(executor, empresaId, id, grupoAcessoId) {
  exigirEmpresa(empresaId);
  exigirIdentificador(id);
  if (grupoAcessoId !== null && (!Number.isInteger(grupoAcessoId) || grupoAcessoId <= 0)) {
    throw new TypeError('identificador de grupo de acesso inválido');
  }

  const { rows } = await executor.query(
    `UPDATE usuarios SET grupo_acesso_id = $3
      WHERE empresa_id = $1 AND id = $2
      RETURNING id, grupo_acesso_id`,
    [empresaId, id, grupoAcessoId],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return { id: linha.id, grupoAcessoId: linha.grupo_acesso_id };
}

/**
 * Usuários vinculados a um grupo da empresa informada, na projeção
 * pública (sem credencial). Inclui usuários inativos: o vínculo deles
 * continua existindo e precisa ser visível para a administração.
 */
async function listarPorGrupoAcesso(executor, empresaId, grupoAcessoId) {
  exigirEmpresa(empresaId);
  if (!Number.isInteger(grupoAcessoId) || grupoAcessoId <= 0) {
    throw new TypeError('identificador de grupo de acesso inválido');
  }

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_PUBLICA} FROM usuarios
      WHERE empresa_id = $1 AND grupo_acesso_id = $2
      ORDER BY lower(nome), id`,
    [empresaId, grupoAcessoId],
  );

  return rows.map((linha) => mapearPublico(linha));
}

/**
 * Usuários da empresa, para a tela que administra os vínculos com grupos
 * (Subetapa 3U).
 *
 * PROJEÇÃO PRÓPRIA, MENOR QUE A PÚBLICA: id, nome, email, perfil, ativo e
 * o grupo atual. Fica de fora `biometria_cadastrada`, que é dado pessoal
 * sem nenhuma utilidade para decidir vínculo — quem escolhe um usuário
 * para pôr num grupo não precisa saber se ele cadastrou biometria. Menos
 * campo trafegando é menos campo vazando.
 *
 * `grupo_acesso_id` entra porque é exatamente o que a tela precisa para
 * separar "já está neste grupo", "está em outro grupo" (vincular aqui
 * seria transferência) e "não está em nenhum".
 *
 * BUSCA: casa por nome OU e-mail, sem diferenciar maiúsculas, em qualquer
 * posição. Os curingas de LIKE vindos do usuário são escapados antes —
 * quem digita "100%" está procurando esse texto, não um curinga. Isso não
 * é proteção contra injeção (a query é parametrizada de ponta a ponta), e
 * sim contra resultado errado.
 *
 * FILTRO DE VÍNCULO sem SQL dinâmico: o modo viaja como parâmetro e é
 * comparado dentro do próprio WHERE. Concatenar o filtro na string seria
 * mais curto e abriria a porta que a seção 52 do CLAUDE.md manda manter
 * fechada.
 *
 * Devolve também o total SEM paginação, para que a tela possa dizer
 * quantos existem além da página exibida em vez de dar a impressão de que
 * a lista acabou.
 *
 * @returns {Promise<{usuarios: Array<object>, total: number}>}
 */
async function listarDaEmpresa(executor, empresaId, {
  busca = null, vinculo = 'todos', pagina = 1, limite = 20,
} = {}) {
  exigirEmpresa(empresaId);
  if (!MODOS_VINCULO.includes(vinculo)) {
    throw new TypeError('filtro de vínculo inválido');
  }
  if (!Number.isInteger(pagina) || pagina <= 0) {
    throw new TypeError('página inválida');
  }
  if (!Number.isInteger(limite) || limite <= 0) {
    throw new TypeError('limite inválido');
  }
  if (busca !== null && typeof busca !== 'string') {
    throw new TypeError('busca inválida');
  }

  const padrao = busca === null ? null : `%${escaparLike(busca.trim().toLowerCase())}%`;
  const filtros = `
      WHERE empresa_id = $1
        AND ($2::text IS NULL OR lower(nome) LIKE $2 ESCAPE '\\' OR lower(email) LIKE $2 ESCAPE '\\')
        AND ($3::text = 'todos'
             OR ($3::text = 'sem_grupo' AND grupo_acesso_id IS NULL)
             OR ($3::text = 'com_grupo' AND grupo_acesso_id IS NOT NULL))`;

  const { rows: contagem } = await executor.query(
    `SELECT count(*)::int AS total FROM usuarios${filtros}`,
    [empresaId, padrao, vinculo],
  );

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_VINCULO} FROM usuarios${filtros}
      ORDER BY lower(nome), id
      LIMIT $4 OFFSET $5`,
    [empresaId, padrao, vinculo, limite, (pagina - 1) * limite],
  );

  return {
    usuarios: rows.map((linha) => ({
      id: linha.id,
      nome: linha.nome,
      email: linha.email,
      perfil: linha.perfil,
      ativo: linha.ativo,
      grupoAcessoId: linha.grupo_acesso_id,
    })),
    total: contagem[0].total,
  };
}

/**
 * Destinatários possíveis de uma delegação (Subetapa 3V — complemento):
 * usuários ATIVOS da empresa, exceto o próprio ator, na projeção MÍNIMA
 * de identificação — id, nome, e-mail. Nada de perfil, grupo, biometria
 * ou situação: quem delega precisa só reconhecer a pessoa.
 *
 * É deliberadamente uma função separada de listarDaEmpresa (3U), e não
 * um parâmetro a mais nela: aquela é a consulta ADMINISTRATIVA, com
 * projeção maior e sem filtro de ativo, governada por
 * ADMINISTRAR_VINCULOS_GRUPO. Esta serve a uma autoridade diferente (a
 * de delegar, decidida em outro serviço) e não deve ganhar campo nenhum
 * "porque a outra já tem".
 *
 * `excluirId` é o ator: a 3I recusa autoconcessão, então oferecê-lo
 * como destinatário seria propor um erro. O filtro de ativo espelha
 * carregarBeneficiarioAtivo da 3I. Busca e escape de LIKE, os mesmos de
 * listarDaEmpresa. Limite fixo, com o total para a tela dizer o que
 * ficou de fora.
 *
 * @returns {Promise<{destinatarios: Array<{id, nome, email}>, total: number}>}
 */
async function listarDestinatariosAtivos(executor, empresaId, { busca = null, excluirId, limite = 50 } = {}) {
  exigirEmpresa(empresaId);
  exigirIdentificador(excluirId);
  if (!Number.isInteger(limite) || limite <= 0) {
    throw new TypeError('limite inválido');
  }
  if (busca !== null && typeof busca !== 'string') {
    throw new TypeError('busca inválida');
  }

  const padrao = busca === null ? null : `%${escaparLike(busca.trim().toLowerCase())}%`;
  const filtros = `
      WHERE empresa_id = $1
        AND ativo = true
        AND id <> $2
        AND ($3::text IS NULL OR lower(nome) LIKE $3 ESCAPE '\\' OR lower(email) LIKE $3 ESCAPE '\\')`;

  const { rows: contagem } = await executor.query(
    `SELECT count(*)::int AS total FROM usuarios${filtros}`,
    [empresaId, excluirId, padrao],
  );

  const { rows } = await executor.query(
    `SELECT id, nome, email FROM usuarios${filtros}
      ORDER BY lower(nome), id
      LIMIT $4`,
    [empresaId, excluirId, padrao, limite],
  );

  return {
    destinatarios: rows.map((linha) => ({ id: linha.id, nome: linha.nome, email: linha.email })),
    total: contagem[0].total,
  };
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
  buscarPorIdParaAtualizacao,
  buscarVinculoGrupoParaAtualizacao,
  atualizarGrupoAcesso,
  listarPorGrupoAcesso,
  listarDaEmpresa,
  listarDestinatariosAtivos,
  buscarCredencialPorEmail,
  CAMPOS_PUBLICOS,
  CAMPOS_VINCULO,
  MODOS_VINCULO,
};
