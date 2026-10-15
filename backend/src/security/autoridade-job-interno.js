'use strict';

const { validarOrigem } = require('../utils/sonda-publica');

/**
 * Autoridade do job interno de monitoramento dos tablets (Etapa J, J2a). O job atravessa empresas (a listagem e a invalidação em
 * massa do repositório de monitoramento), e nada em JavaScript prova quem o executa: o limite real é a CREDENCIAL DO BANCO. Por isso o
 * job usa uma credencial própria (TOKEN_JOB_DB_USER e TOKEN_JOB_DB_PASSWORD), nunca a da API, e só opera depois de o PRÓPRIO BANCO
 * confirmar quem está conectado e o que esse papel pode fazer, em PRIVILÉGIOS EFETIVOS (grants, herança e PUBLIC): a lista POSITIVA
 * OBJETOS_PERMITIDOS, por coluna, e NADA além dela. A matriz vem só do SQL que o executor alcança (verificarComunicacao e o que ela
 * chama); o heartbeat da API (registrarContato, travarParaContato, gravarContato) NÃO faz parte do job: o job nunca escreve
 * ultimo_contato_em, então não recebe esse privilégio.
 *
 * O que o código garante: entrada só pelo script de passagem única; recusa sem a configuração; recusa da credencial da API; recusa se o
 * papel, a sessão ou o banco divergirem, se houver atributo elevado, pertencimento a outros papéis, falta de CONNECT ou USAGE, CREATE
 * no banco, CREATE em schema do caminho de busca, objeto fora do schema corrente, privilégio faltando ou QUALQUER privilégio além
 * da lista positiva (tabela, coluna, sequência). TEMP (que o PostgreSQL concede a PUBLIC por padrão) não é recusado por existir: as
 * consultas do job usam nomes sem schema e pg_temp é pesquisado primeiro para relações, então a autoridade recusa se a sessão verificada
 * tiver QUALQUER relação temporária ou se um objeto do job resolver para tabela temporária; o job nunca executa DDL nem cria objeto
 * temporário (teste estático). O que depende da configuração operacional (ainda não feita): criar o papel com
 * exatamente esses privilégios, guardar a senha em gestão de segredos, restringir quem agenda o script e de onde ele acessa o banco, e
 * decidir se o schema esperado deve ser fixado em configuração (hoje é o schema corrente, que tem de conter os três objetos).
 * Mensagens e logs levam só nomes de variáveis, de objetos e de privilégios, nunca valores. A verificação só LÊ: nunca concede nada.
 */

const VARIAVEIS_OBRIGATORIAS = Object.freeze(['DB_HOST', 'DB_NAME', 'TOKEN_JOB_DB_USER', 'TOKEN_JOB_DB_PASSWORD', 'TOKEN_SONDA_URL_PUBLICA']);

const congelar = (objeto) => Object.freeze(Object.fromEntries(Object.entries(objeto).map(([k, v]) => [k, Object.freeze(v)])));

/**
 * Lista POSITIVA, por tabela e coluna, do SQL alcançável pelo job (leitura inclui WHERE, JOIN e RETURNING; escrita, SET e INSERT).
 * ultimo_contato_em é só lido; comunicacao_registrada e queda_suspeita_desde são as únicas colunas atualizadas; o evento é inserido
 * com cinco colunas (só QUEDA: sem usuário e sem duração) e devolve id. atualizado_em é atribuída pelo gatilho, sem privilégio de
 * coluna do job.
 */
const OBJETOS_PERMITIDOS = Object.freeze({
  empresas: congelar({ select: ['id', 'ativo'], insert: [], update: [] }),
  token_dispositivos: congelar({
    select: ['id', 'empresa_id', 'ativado_em', 'revogado_em', 'ultimo_contato_em', 'comunicacao_registrada', 'queda_suspeita_desde'],
    insert: [],
    update: ['comunicacao_registrada', 'queda_suspeita_desde'],
  }),
  token_dispositivo_eventos: congelar({
    select: ['id'],
    insert: ['empresa_id', 'dispositivo_id', 'tipo', 'usuario_id', 'duracao_segundos'],
    update: [],
  }),
});
const OBJETOS_DO_JOB = Object.freeze(Object.keys(OBJETOS_PERMITIDOS));
const SEQUENCIA_DO_EVENTO = Object.freeze({ tabela: 'token_dispositivo_eventos', coluna: 'id' });
const LIMITE_DE_CAMPOS = 40;

class ErroDoJob extends Error {
  constructor(codigo, campos = []) {
    super(codigo);
    this.name = 'ErroDoJob';
    this.codigo = codigo;
    this.campos = Object.freeze([...campos].slice(0, LIMITE_DE_CAMPOS));
  }
}

/** Lê e valida a configuração do job; só nomes de variáveis vão para o erro. */
function lerConfiguracaoDoJob(env = process.env) {
  const ausentes = VARIAVEIS_OBRIGATORIAS.filter((nome) => typeof env[nome] !== 'string' || env[nome].trim() === '');
  if (ausentes.length > 0) throw new ErroDoJob('CONFIGURACAO_AUSENTE', ausentes);
  const usuario = env.TOKEN_JOB_DB_USER.trim();
  if (typeof env.DB_USER === 'string' && env.DB_USER.trim() === usuario) throw new ErroDoJob('CREDENCIAL_DA_APLICACAO', ['TOKEN_JOB_DB_USER']);
  const porta = env.DB_PORT === undefined || env.DB_PORT.trim() === '' ? 5432 : Number(env.DB_PORT);
  if (!Number.isInteger(porta) || porta < 1 || porta > 65535) throw new ErroDoJob('CONFIGURACAO_INVALIDA', ['DB_PORT']);
  let sondaOrigem;
  try {
    sondaOrigem = validarOrigem(env.TOKEN_SONDA_URL_PUBLICA.trim());
  } catch {
    throw new ErroDoJob('CONFIGURACAO_INVALIDA', ['TOKEN_SONDA_URL_PUBLICA']);
  }
  return Object.freeze({
    banco: Object.freeze({ host: env.DB_HOST.trim(), port: porta, database: env.DB_NAME.trim(), user: usuario, password: env.TOKEN_JOB_DB_PASSWORD }),
    papelEsperado: usuario,
    sondaOrigem,
  });
}

const PRIVILEGIOS_DE_TABELA = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const PRIVILEGIOS_DE_COLUNA = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

const SQL_IDENTIDADE = `SELECT current_user::text AS papel, session_user::text AS sessao, current_database()::text AS banco, current_schema()::text AS schema,
       r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
       current_setting('search_path') AS caminho_configurado,
       has_database_privilege(current_user, current_database(), 'CONNECT') AS banco_connect,
       has_database_privilege(current_user, current_database(), 'CREATE') AS banco_create,
       CASE WHEN current_schema() IS NULL THEN NULL ELSE has_schema_privilege(current_user, current_schema(), 'USAGE') END AS schema_usage
  FROM pg_roles r WHERE r.rolname = current_user`;
const SQL_MEMBROS = `SELECT m.rolname::text AS papel FROM pg_roles m WHERE m.rolname <> current_user AND pg_has_role(current_user, m.oid, 'MEMBER')`;
const SQL_CAMINHO = `SELECT
  s::text AS schema,
  has_schema_privilege(current_user, s, 'CREATE') AS cria
FROM unnest(current_schemas(false)) AS s
WHERE to_regnamespace(quote_ident(s))::oid
      IS DISTINCT FROM pg_my_temp_schema()`;
const SQL_RESOLUCAO = `SELECT t.nome::text AS nome, n.nspname::text AS schema, c.relpersistence::text AS persistencia
  FROM unnest($1::text[]) AS t(nome) LEFT JOIN pg_class c ON c.oid = to_regclass(t.nome) LEFT JOIN pg_namespace n ON n.oid = c.relnamespace`;
// Relações temporárias existentes NESTA sessão (pg_my_temp_schema() é 0 quando a sessão nunca criou objeto temporário).
const SQL_TEMPORARIOS = 'SELECT count(*)::int AS relacoes FROM pg_class WHERE relnamespace = pg_my_temp_schema()';
const SQL_RELACOES = `SELECT c.relname::text AS objeto, c.relkind::text AS tipo,
  ${PRIVILEGIOS_DE_TABELA.map((p) => `CASE WHEN c.relkind = 'S' THEN false ELSE has_table_privilege(current_user, c.oid, '${p}') END AS t_${p.toLowerCase()}`).join(', ')},
  ${PRIVILEGIOS_DE_COLUNA.map((p) => `CASE WHEN c.relkind = 'S' THEN false ELSE has_any_column_privilege(current_user, c.oid, '${p}') END AS c_${p.toLowerCase()}`).join(', ')},
  CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(current_user, c.oid, 'USAGE') ELSE false END AS s_usage,
  CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(current_user, c.oid, 'SELECT') ELSE false END AS s_select,
  CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(current_user, c.oid, 'UPDATE') ELSE false END AS s_update
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`;
const SQL_COLUNAS = `SELECT c.relname::text AS objeto, a.attname::text AS coluna,
  ${PRIVILEGIOS_DE_COLUNA.map((p) => `has_column_privilege(current_user, c.oid, a.attnum, '${p}') AS p_${p.toLowerCase()}`).join(', ')}
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[]) AND a.attnum > 0 AND NOT a.attisdropped`;
// pg_get_serial_sequence lança 42P01 se a tabela não existe: ela só é chamada depois de confirmar a existência (consulta separada,
// sem depender da ordem de avaliação de um CASE). Com a tabela ausente a sequência é nula e a avaliação classifica OBJETO_AUSENTE.
const SQL_EXISTE = 'SELECT to_regclass($1) IS NOT NULL AS existe';
const SQL_SEQUENCIA = 'SELECT pg_get_serial_sequence($1, $2)::text AS sequencia';

const nomeDaSequencia = (qualificado) => (typeof qualificado === 'string' ? qualificado.split('.').pop().replace(/^"|"$/g, '') : null);

/**
 * Avaliação PURA do que o banco informou. Ordem: identidade, banco, atributos, pertencimentos, CONNECT/CREATE/TEMP, schema e caminho de
 * busca, resolução dos objetos, privilégios faltando e privilégios sobrando (lista positiva). Lança ErroDoJob na primeira recusa.
 */
function avaliarAutoridade(fatos, { papelEsperado, bancoEsperado, schemaEsperado }) {
  const { identidade, membros, caminho, resolucao, temporarios, relacoes, colunas, sequenciaDoEvento } = fatos;
  if (!identidade || identidade.papel !== papelEsperado || identidade.sessao !== papelEsperado) throw new ErroDoJob('PAPEL_DIVERGENTE');
  if (identidade.banco !== bancoEsperado) throw new ErroDoJob('BANCO_DIVERGENTE');
  const elevados = ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'].filter((atributo) => identidade[atributo] === true);
  if (elevados.length > 0) throw new ErroDoJob('PAPEL_PRIVILEGIADO', elevados);
  if (membros.length > 0) throw new ErroDoJob('PAPEL_COM_MEMBROS', membros.map((m) => m.papel));
  if (identidade.banco_connect !== true) throw new ErroDoJob('SEM_CONNECT');
  if (identidade.banco_create !== false) throw new ErroDoJob('BANCO_PRIVILEGIO_EXCEDENTE', ['CREATE']);
  // TEMP (concedido a PUBLIC por padrão) NÃO é recusado em si; o risco, o sombreamento por pg_temp, é tratado abaixo.

  const schema = identidade.schema;
  if (typeof schema !== 'string' || schema === '' || /^pg_/.test(schema) || schema === 'information_schema') throw new ErroDoJob('SCHEMA_INVALIDO');
  // Coerência com a configuração do pool: a sessão verificada deve ter o caminho de busca que o pool fixa em TODA sessão
  // (schema autorizado e pg_temp explícito depois). Sem schemaEsperado (uso puro/legado) a conferência não se aplica.
  if (schemaEsperado !== undefined) {
    const normalizado = String(identidade.caminho_configurado ?? '').toLowerCase().replace(/["\s]/g, '');
    if (schema !== schemaEsperado || normalizado !== `${schemaEsperado},pg_temp`) throw new ErroDoJob('SEARCH_PATH_DIVERGENTE');
  }
  if (identidade.schema_usage !== true) throw new ErroDoJob('SEM_USAGE', [schema]);
  const comCreate = caminho.filter((s) => s.cria !== false).map((s) => s.schema);
  if (comCreate.length > 0) throw new ErroDoJob('SCHEMA_COM_CREATE', comCreate);
  const ausentes = OBJETOS_DO_JOB.filter((nome) => !resolucao.some((r) => r.nome === nome && typeof r.schema === 'string'));
  if (ausentes.length > 0) throw new ErroDoJob('OBJETO_AUSENTE', ausentes);
  // Controle compensatório de TEMP: nenhuma relação temporária na sessão e nenhum objeto do job resolvido para o schema temporário
  // (as consultas do job usam nomes sem schema, e pg_temp é pesquisado primeiro para relações). Resultado ausente = recusa.
  if (!Number.isInteger(temporarios) || temporarios !== 0) throw new ErroDoJob('OBJETO_TEMPORARIO', ['sessao']);
  const resolvidosTemporarios = resolucao.filter((r) => r.persistencia !== 'p' || /^pg_temp/.test(String(r.schema))).map((r) => r.nome);
  if (resolvidosTemporarios.length > 0) throw new ErroDoJob('OBJETO_TEMPORARIO', resolvidosTemporarios);
  const foraDoSchema = resolucao.filter((r) => r.schema !== schema).map((r) => `${r.nome}@${r.schema}`);
  if (foraDoSchema.length > 0) throw new ErroDoJob('SCHEMA_INVALIDO', foraDoSchema);

  const faltando = [];
  const sobrando = [];
  const colunaPor = (objeto, coluna) => colunas.find((c) => c.objeto === objeto && c.coluna === coluna);
  for (const [objeto, permitido] of Object.entries(OBJETOS_PERMITIDOS)) {
    for (const [verbo, lista] of [['select', permitido.select], ['insert', permitido.insert], ['update', permitido.update]]) {
      for (const coluna of lista) {
        const linha = colunaPor(objeto, coluna);
        if (!linha || linha[`p_${verbo}`] !== true) faltando.push(`${objeto}.${coluna}:${verbo.toUpperCase()}`);
      }
    }
    for (const linha of colunas.filter((c) => c.objeto === objeto)) {
      for (const verbo of ['select', 'insert', 'update', 'references']) {
        const permitida = verbo !== 'references' && permitido[verbo].includes(linha.coluna);
        if (linha[`p_${verbo}`] !== false && !permitida) sobrando.push(`${objeto}.${linha.coluna}:${verbo.toUpperCase()}`);
      }
    }
  }
  const sequenciaPermitida = nomeDaSequencia(sequenciaDoEvento);
  for (const r of relacoes) {
    if (r.tipo === 'S') {
      const dela = r.objeto === sequenciaPermitida;
      if (r.s_update !== false) sobrando.push(`${r.objeto}:UPDATE`);
      if (!dela && r.s_usage !== false) sobrando.push(`${r.objeto}:USAGE`);
      if (!dela && r.s_select !== false) sobrando.push(`${r.objeto}:SELECT`);
      continue;
    }
    const doJob = OBJETOS_DO_JOB.includes(r.objeto);
    for (const p of PRIVILEGIOS_DE_TABELA) if (r[`t_${p.toLowerCase()}`] !== false) sobrando.push(`${r.objeto}:${p}`);
    if (!doJob) for (const p of PRIVILEGIOS_DE_COLUNA) if (r[`c_${p.toLowerCase()}`] !== false) sobrando.push(`${r.objeto}:${p}(coluna)`);
  }
  if (faltando.length > 0) throw new ErroDoJob('PRIVILEGIO_FALTANDO', faltando);
  if (sobrando.length > 0) throw new ErroDoJob('PRIVILEGIO_EXCEDENTE', [...new Set(sobrando)]);
  return Object.freeze({ papel: identidade.papel, schema });
}

/**
 * Pergunta ao banco quem está conectado, em que banco e schema, o que esse papel pode fazer e como os objetos se resolvem; só lê.
 * Recusa (ErroDoJob) conforme avaliarAutoridade. Erros de banco que não sejam ErroDoJob são propagados (o executor os classifica).
 */
async function exigirIdentidadeDoJob(executor, { papelEsperado, bancoEsperado, schemaEsperado }) {
  // Todas as consultas na MESMA conexão, para que a resolução dos objetos e a checagem de temporários descrevam a mesma sessão.
  const cliente = typeof executor.connect === 'function' ? await executor.connect() : null;
  const banco = cliente ?? executor;
  try {
    const identidade = (await banco.query(SQL_IDENTIDADE)).rows[0];
    const membros = (await banco.query(SQL_MEMBROS)).rows;
    const caminho = (await banco.query(SQL_CAMINHO)).rows;
    const resolucao = (await banco.query(SQL_RESOLUCAO, [OBJETOS_DO_JOB])).rows;
    const temporarios = (await banco.query(SQL_TEMPORARIOS)).rows[0]?.relacoes;
    const relacoes = (await banco.query(SQL_RELACOES)).rows;
    const colunas = (await banco.query(SQL_COLUNAS, [OBJETOS_DO_JOB])).rows;
    const existe = (await banco.query(SQL_EXISTE, [SEQUENCIA_DO_EVENTO.tabela])).rows[0]?.existe === true;
    const sequenciaDoEvento = existe
      ? ((await banco.query(SQL_SEQUENCIA, [SEQUENCIA_DO_EVENTO.tabela, SEQUENCIA_DO_EVENTO.coluna])).rows[0]?.sequencia ?? null)
      : null;
    return avaliarAutoridade({ identidade, membros, caminho, resolucao, temporarios, relacoes, colunas, sequenciaDoEvento }, { papelEsperado, bancoEsperado, schemaEsperado });
  } finally {
    if (cliente) cliente.release();
  }
}

module.exports = {
  VARIAVEIS_OBRIGATORIAS, OBJETOS_PERMITIDOS, SEQUENCIA_DO_EVENTO, ErroDoJob, lerConfiguracaoDoJob, avaliarAutoridade, exigirIdentidadeDoJob,
};
