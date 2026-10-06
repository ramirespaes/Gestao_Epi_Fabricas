'use strict';

const { mascararCpf } = require('../utils/normalizacao');

/**
 * Leituras e escritas da administração de usuários da empresa (Bloco 9,
 * parte F). Executor por parâmetro, validação de formato e nenhuma regra
 * de negócio: quem pode o quê (D3) e o último MASTER são do serviço.
 *
 * E-MAIL: nos vínculos do modelo global, usuarios.email é NULL e o e-mail
 * mora em identidades (025). A projeção lê COALESCE(i.email, u.email) para
 * mostrar o e-mail da conta de qualquer vínculo. identidade_id, senha_hash
 * e o id do grupo nunca saem daqui; do grupo só saem o nome e a situação.
 *
 * DADOS ADMINISTRATIVOS (05/10/2026; 075–077): CPF da identidade só
 * MASCARADO (`***.***.***-XX`, o padrão da aplicação; o CPF em claro não
 * sai do mapeamento), matrícula, setor, horário de trabalho e
 * `acessoQualquerIp` (derivado: sem IP permitido cadastrado = true). A
 * lista de IPs nunca sai pela listagem.
 *
 * ORDENAÇÃO: o nome público da ordem escolhe um fragmento FIXO deste
 * módulo. Nada que venha da requisição é concatenado no SQL.
 */

const ORDENACOES = Object.freeze({
  nome: 'lower(u.nome) ASC, u.id ASC',
  nome_desc: 'lower(u.nome) DESC, u.id DESC',
  perfil: "array_position(ARRAY['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']::varchar[], u.perfil::varchar), lower(u.nome), u.id",
  situacao: 'u.ativo DESC, lower(u.nome), u.id',
  recentes: 'u.criado_em DESC, u.id DESC',
});
const SITUACOES = Object.freeze(['ATIVO', 'INATIVO']);
const PERFIL_MASTER = 'MASTER';

const PROJECAO = `u.id, u.nome, COALESCE(i.email, u.email) AS email, u.perfil, u.ativo, u.criado_em,
  g.nome AS grupo_nome, g.ativo AS grupo_ativo,
  i.cpf, u.matricula, u.setor,
  to_char(u.horario_trabalho_inicio, 'HH24:MI') AS horario_inicio, to_char(u.horario_trabalho_fim, 'HH24:MI') AS horario_fim,
  EXISTS (SELECT 1 FROM usuario_ips_permitidos p WHERE p.empresa_id = u.empresa_id AND p.usuario_id = u.id) AS restricao_ip`;
// O grupo é lido na MESMA empresa, além da FK composta da 020: só o nome e
// se está ativo, para a tela mostrar o acesso real sem expor o id.
const ORIGEM = `FROM usuarios u
  LEFT JOIN identidades i ON i.id = u.identidade_id
  LEFT JOIN grupos_acesso g ON g.empresa_id = u.empresa_id AND g.id = u.grupo_acesso_id`;

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirUsuario(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('identificador de usuário inválido');
  }
}

/** Neutraliza os curingas de LIKE digitados por quem pesquisa. */
function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  nome: linha.nome,
  email: linha.email,
  perfil: linha.perfil,
  ativo: linha.ativo,
  criadoEm: linha.criado_em,
  grupo: linha.grupo_nome === null ? null : { nome: linha.grupo_nome, ativo: linha.grupo_ativo },
  cpfMascarado: mascararCpf(linha.cpf ?? null),
  matricula: linha.matricula ?? null,
  setor: linha.setor ?? null,
  horarioTrabalho: linha.horario_inicio && linha.horario_fim ? { inicio: linha.horario_inicio, fim: linha.horario_fim } : null,
  acessoQualquerIp: linha.restricao_ip !== true,
});

/**
 * Página de usuários da empresa, com o total sem paginação.
 * @returns {Promise<{usuarios: Array<object>, total: number}>}
 */
async function listar(executor, empresaId, {
  busca = null, situacao = null, perfil = null, ordem = 'nome', pagina = 1, limite = 20,
} = {}) {
  exigirEmpresa(empresaId);
  if (!Object.hasOwn(ORDENACOES, ordem)) {
    throw new TypeError('ordem inválida');
  }
  if (situacao !== null && !SITUACOES.includes(situacao)) {
    throw new TypeError('situação inválida');
  }
  if (perfil !== null && typeof perfil !== 'string') {
    throw new TypeError('perfil inválido');
  }
  if (busca !== null && typeof busca !== 'string') {
    throw new TypeError('busca inválida');
  }
  if (!Number.isInteger(pagina) || pagina <= 0 || !Number.isInteger(limite) || limite <= 0) {
    throw new TypeError('paginação inválida');
  }

  const padrao = busca === null ? null : `%${escaparLike(busca.toLowerCase())}%`;
  const filtros = `
     WHERE u.empresa_id = $1
       AND ($2::text IS NULL OR lower(u.nome) LIKE $2 ESCAPE '\\' OR lower(COALESCE(i.email, u.email)) LIKE $2 ESCAPE '\\')
       AND ($3::text IS NULL OR u.ativo = ($3::text = 'ATIVO'))
       AND ($4::text IS NULL OR u.perfil = $4::text)`;
  const parametros = [empresaId, padrao, situacao, perfil];

  const { rows: contagem } = await executor.query(`SELECT count(*)::int AS total ${ORIGEM}${filtros}`, parametros);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} ${ORIGEM}${filtros}
      ORDER BY ${ORDENACOES[ordem]}
      LIMIT $5 OFFSET $6`,
    [...parametros, limite, (pagina - 1) * limite],
  );

  return { usuarios: rows.map(mapear), total: contagem[0].total };
}

async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirUsuario(id);
  const { rows } = await executor.query(`SELECT ${PROJECAO} ${ORIGEM} WHERE u.empresa_id = $1 AND u.id = $2`, [empresaId, id]);
  return mapear(rows[0]);
}

/** Mesma leitura, travando só a linha do vínculo (FOR UPDATE OF u), dentro de transação. */
async function buscarParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirUsuario(id);
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} ${ORIGEM} WHERE u.empresa_id = $1 AND u.id = $2 FOR UPDATE OF u`,
    [empresaId, id],
  );
  return mapear(rows[0]);
}

/**
 * Existe vínculo (ativo ou não) NESTA empresa para o e-mail? Olha a
 * identidade global e a coluna legada usuarios.email. Nunca responde sobre
 * outras empresas.
 * @param {string} email já normalizado
 * @returns {Promise<{id: number, ativo: boolean}|null>}
 */
async function buscarVinculoPorEmail(executor, empresaId, email) {
  exigirEmpresa(empresaId);
  if (typeof email !== 'string' || email.length === 0 || email !== email.trim().toLowerCase()) {
    throw new TypeError('e-mail deve chegar normalizado');
  }
  const { rows } = await executor.query(
    `SELECT u.id, u.ativo
       FROM usuarios u
      WHERE u.empresa_id = $1
        AND (lower(u.email) = $2 OR u.identidade_id = (SELECT i.id FROM identidades i WHERE lower(i.email) = $2))
      ORDER BY u.id
      LIMIT 1`,
    [empresaId, email],
  );
  return rows[0] === undefined ? null : { id: rows[0].id, ativo: rows[0].ativo };
}

/**
 * Dados COMPLETOS para o modal de edição (CPF canônico em claro: só chega aqui
 * quem administra). Com `travar`, FOR UPDATE OF u. Nunca senha nem hash.
 */
async function buscarDadosParaEdicao(executor, empresaId, id, { travar = false } = {}) {
  exigirEmpresa(empresaId);
  exigirUsuario(id);
  const { rows } = await executor.query(
    `SELECT u.id, u.nome, COALESCE(i.email, u.email) AS email, u.perfil, u.ativo, u.identidade_id, i.cpf, u.matricula, u.setor,
            to_char(u.horario_trabalho_inicio, 'HH24:MI') AS horario_inicio, to_char(u.horario_trabalho_fim, 'HH24:MI') AS horario_fim,
            u.grupo_acesso_id
       FROM usuarios u LEFT JOIN identidades i ON i.id = u.identidade_id
      WHERE u.empresa_id = $1 AND u.id = $2${travar ? ' FOR UPDATE OF u' : ''}`,
    [empresaId, id],
  );
  const l = rows[0];
  return l === undefined ? null : {
    id: l.id,
    nome: l.nome,
    email: l.email,
    perfil: l.perfil,
    ativo: l.ativo,
    identidadeId: l.identidade_id ?? null,
    cpf: l.cpf ?? null,
    matricula: l.matricula ?? null,
    setor: l.setor ?? null,
    horarioTrabalho: l.horario_inicio && l.horario_fim ? { inicio: l.horario_inicio, fim: l.horario_fim } : null,
    grupoAcessoId: l.grupo_acesso_id ?? null,
  };
}

/** Quantos vínculos (em qualquer empresa) a identidade tem: e-mail só muda se for 1. */
async function contarVinculosDaIdentidade(executor, identidadeId) {
  if (!Number.isInteger(identidadeId) || identidadeId <= 0) {
    throw new TypeError('identificador de identidade inválido');
  }
  const { rows } = await executor.query('SELECT count(*)::int AS total FROM usuarios WHERE identidade_id = $1', [identidadeId]);
  return rows[0].total;
}

/**
 * Atualiza só os dados administrativos do vínculo informados (campo ausente
 * não muda; horário/grupo `null` limpam). Matrícula/setor já chegam aparados.
 */
async function atualizarAdministrativo(executor, empresaId, id, campos) {
  exigirEmpresa(empresaId);
  exigirUsuario(id);
  const tem = (c) => Object.hasOwn(campos, c);
  const h = tem('horarioTrabalho') ? campos.horarioTrabalho : null;
  const { rowCount } = await executor.query(
    `UPDATE usuarios
        SET matricula = CASE WHEN $3::boolean THEN $4 ELSE matricula END,
            setor = CASE WHEN $5::boolean THEN $6 ELSE setor END,
            horario_trabalho_inicio = CASE WHEN $7::boolean THEN $8::time ELSE horario_trabalho_inicio END,
            horario_trabalho_fim = CASE WHEN $7::boolean THEN $9::time ELSE horario_trabalho_fim END,
            grupo_acesso_id = CASE WHEN $10::boolean THEN $11::int ELSE grupo_acesso_id END
      WHERE empresa_id = $1 AND id = $2`,
    [empresaId, id, tem('matricula'), campos.matricula ?? null, tem('setor'), campos.setor ?? null,
      tem('horarioTrabalho'), h === null ? null : h.inicio, h === null ? null : h.fim, tem('grupoAcessoId'), campos.grupoAcessoId ?? null],
  );
  return rowCount === 1;
}

async function contarMastersAtivos(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    'SELECT count(*)::int AS total FROM usuarios WHERE empresa_id = $1 AND perfil = $2 AND ativo',
    [empresaId, PERFIL_MASTER],
  );
  return rows[0].total;
}

/**
 * Trava todos os MASTERs ativos da empresa, sempre na mesma ordem (id), e
 * devolve os ids. Usada antes de tirar a condição de MASTER de alguém: uma
 * transação concorrente que queira fazer o mesmo espera o COMMIT desta e,
 * ao reler, já não conta quem deixou de ser MASTER ativo.
 */
async function travarMastersAtivos(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    'SELECT id FROM usuarios WHERE empresa_id = $1 AND perfil = $2 AND ativo ORDER BY id FOR UPDATE',
    [empresaId, PERFIL_MASTER],
  );
  return rows.map((linha) => linha.id);
}

async function atualizarNome(executor, empresaId, id, nome) {
  exigirEmpresa(empresaId);
  exigirUsuario(id);
  if (typeof nome !== 'string' || nome.length === 0) {
    throw new TypeError('nome inválido');
  }
  const { rowCount } = await executor.query('UPDATE usuarios SET nome = $3 WHERE empresa_id = $1 AND id = $2', [empresaId, id, nome]);
  return rowCount === 1;
}

async function atualizarPerfil(executor, empresaId, id, perfil) {
  exigirEmpresa(empresaId);
  exigirUsuario(id);
  if (typeof perfil !== 'string' || perfil.length === 0) {
    throw new TypeError('perfil inválido');
  }
  const { rowCount } = await executor.query('UPDATE usuarios SET perfil = $3 WHERE empresa_id = $1 AND id = $2', [empresaId, id, perfil]);
  return rowCount === 1;
}

/**
 * Muda a situação só se ela ainda for a oposta (condição no WHERE). A
 * inativação dispara o trigger da 038, que revoga as sessões deste vínculo.
 * @returns {Promise<boolean>} true se mudou
 */
async function definirAtivo(executor, empresaId, id, ativo) {
  exigirEmpresa(empresaId);
  exigirUsuario(id);
  if (typeof ativo !== 'boolean') {
    throw new TypeError('situação inválida');
  }
  const { rowCount } = await executor.query(
    'UPDATE usuarios SET ativo = $3 WHERE empresa_id = $1 AND id = $2 AND ativo = NOT $3',
    [empresaId, id, ativo],
  );
  return rowCount === 1;
}

module.exports = {
  ORDENACOES,
  listar,
  buscarPorId,
  buscarParaAtualizacao,
  buscarDadosParaEdicao,
  contarVinculosDaIdentidade,
  atualizarAdministrativo,
  buscarVinculoPorEmail,
  contarMastersAtivos,
  travarMastersAtivos,
  atualizarNome,
  atualizarPerfil,
  definirAtivo,
};
