'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const job = require('../../scripts/verificar-comunicacao-token');
const { criarSondaPublica, validarOrigem, CAMINHO_SAUDE } = require('../../src/utils/sonda-publica');
const { lerConfiguracaoDoJob, exigirIdentidadeDoJob, ErroDoJob, OBJETOS_PERMITIDOS } = require('../../src/security/autoridade-job-interno');
const { bancoIndisponivel } = require('../../src/services/token-monitoramento.service');

/**
 * Atendimento Token — Etapa J, J2a (Fases 4A e 4A-R2): autoridade do job interno, sonda pública e executor de passagem única. SEM
 * banco, SEM rede, SEM servidor: pool, cliente HTTP e saída são falsos. O "banco simulado" é um MODELO de privilégios em memória
 * (papel, banco, schema, grants por tabela e por coluna, herança, caminho de busca): prova a lógica de verificação, a orquestração e
 * os códigos de saída; NÃO prova privilégios reais do PostgreSQL, a sonda contra a rede nem a execução operacional do job.
 */

const RAIZ = path.join(__dirname, '..', '..');
const ENV_VALIDO = Object.freeze({
  DB_HOST: 'banco.interno.exemplo', DB_NAME: 'gestao', DB_USER: 'app_api', DB_PORT: '5432',
  TOKEN_JOB_DB_USER: 'job_token', TOKEN_JOB_DB_PASSWORD: 'segredo-do-job-xyz', TOKEN_SONDA_URL_PUBLICA: 'https://app.exemplo.com.br',
});
const AGORA = new Date('2026-10-14T12:00:00.000Z');
const atras = (segundos) => new Date(AGORA.getTime() - segundos * 1000);

// ───────── colunas reais, lidas das migrations (o teste acompanha o schema)
function colunasDe(arquivo, tabela) {
  const texto = fs.readFileSync(path.join(RAIZ, 'migrations', arquivo), 'utf8');
  const inicio = texto.indexOf(`CREATE TABLE ${tabela} (`);
  assert.notEqual(inicio, -1, `${tabela} não encontrada em ${arquivo}`);
  const bloco = texto.slice(inicio, texto.indexOf('\n);', inicio));
  return [...bloco.matchAll(/^ {2}([a-z_]+)\s+[A-Z]/gm)].map((m) => m[1]);
}
const COLUNAS = Object.freeze({
  empresas: colunasDe('001_create_empresas.sql', 'empresas'),
  token_dispositivos: [...colunasDe('086_create_atendimento_token.sql', 'token_dispositivos'), 'queda_suspeita_desde'],
  token_dispositivo_eventos: colunasDe('086_create_atendimento_token.sql', 'token_dispositivo_eventos'),
});

// ───────── banco simulado: modelo de privilégios efetivos
const SEM_PRIVILEGIO_TABELA = () => ({ select: false, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false });
const SEM_PRIVILEGIO_COLUNA = () => ({ select: false, insert: false, update: false, references: false });
const OUTRAS_TABELAS = ['usuarios', 'identidades', 'sessoes', 'sessoes_globais', 'funcionarios', 'materiais', 'logs_auditoria', 'token_ativacoes'];

function modeloIdeal() {
  const colunas = {};
  const relacoes = {};
  for (const [tabela, permitido] of Object.entries(OBJETOS_PERMITIDOS)) {
    colunas[tabela] = Object.fromEntries(COLUNAS[tabela].map((c) => [c, {
      select: permitido.select.includes(c), insert: permitido.insert.includes(c), update: permitido.update.includes(c), references: false,
    }]));
    relacoes[tabela] = { tipo: 'r', t: SEM_PRIVILEGIO_TABELA(), c: SEM_PRIVILEGIO_COLUNA() };
  }
  for (const tabela of OUTRAS_TABELAS) relacoes[tabela] = { tipo: 'r', t: SEM_PRIVILEGIO_TABELA(), c: SEM_PRIVILEGIO_COLUNA() };
  return {
    identidade: {
      papel: 'job_token', sessao: 'job_token', banco: 'gestao', schema: 'public',
      rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
      caminho_configurado: 'public, pg_temp', // o que o pool do job fixa em toda sessão
      banco_connect: true, banco_create: false, banco_temp: true, schema_usage: true, // TEMP via PUBLIC é o padrão do PostgreSQL
    },
    temporarios: 0,
    persistencia: 'p',
    membros: [],
    caminho: [{ schema: 'public', cria: false }],
    resolucao: { empresas: 'public', token_dispositivos: 'public', token_dispositivo_eventos: 'public' },
    relacoes,
    colunas,
    sequencias: { token_dispositivo_eventos_id_seq: { usage: false, select: false, update: false }, empresas_id_seq: { usage: false, select: false, update: false } },
    sequenciaDoEvento: 'public.token_dispositivo_eventos_id_seq',
  };
}

/** Pool falso sobre o modelo. `ajustar(modelo)` cria a condição do cenário; `extra` controla falhas e a listagem de tablets. */
function bancoSimulado(ajustar = () => {}, extra = {}) {
  const m = modeloIdeal();
  ajustar(m);
  const { listagem = [], falhaTrivial = null, falhaIdentidade = null, falhaListagem = null, confirma = true } = extra;
  const chamadas = [];
  const estado = { encerrado: 0, ouvintes: [] };
  const responder = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    chamadas.push({ sql: s, params });
    if (s === 'SELECT 1') { if (falhaTrivial) throw falhaTrivial; return { rows: [{ '?column?': 1 }] }; }
    if (s.includes('FROM pg_roles r WHERE r.rolname = current_user')) { if (falhaIdentidade) throw falhaIdentidade; return { rows: m.identidade ? [{ ...m.identidade }] : [] }; }
    if (s.includes('FROM pg_roles m')) return { rows: m.membros.map((papel) => ({ papel })) };
    if (s.includes('current_schemas(false)')) return { rows: m.caminho };
    if (s.includes('AS existe')) { if (m.falhaExiste) throw m.falhaExiste; return { rows: [{ existe: m.resolucao[params[0]] != null }] }; }
    if (s.includes('pg_my_temp_schema')) return { rows: [{ relacoes: m.temporarios }] };
    if (s.includes('to_regclass')) return { rows: params[0].map((nome) => ({ nome, schema: m.resolucao[nome] ?? null, persistencia: m.resolucao[nome] ? (m.persistenciaDe?.[nome] ?? m.persistencia) : null })) };
    if (s.includes('has_sequence_privilege')) {
      const rel = Object.entries(m.relacoes).map(([objeto, r]) => ({
        objeto, tipo: r.tipo, ...Object.fromEntries(Object.entries(r.t).map(([k, v]) => [`t_${k}`, v])), ...Object.fromEntries(Object.entries(r.c).map(([k, v]) => [`c_${k}`, v])), s_usage: false, s_select: false, s_update: false,
      }));
      const seq = Object.entries(m.sequencias).map(([objeto, q]) => ({
        objeto, tipo: 'S', ...Object.fromEntries(Object.keys(SEM_PRIVILEGIO_TABELA()).map((k) => [`t_${k}`, false])), ...Object.fromEntries(Object.keys(SEM_PRIVILEGIO_COLUNA()).map((k) => [`c_${k}`, false])),
        s_usage: q.usage, s_select: q.select, s_update: q.update,
      }));
      return { rows: [...rel, ...seq] };
    }
    if (s.includes('FROM pg_attribute a')) {
      return { rows: params[0].flatMap((objeto) => Object.entries(m.colunas[objeto] ?? {}).map(([coluna, p]) => ({ objeto, coluna, p_select: p.select, p_insert: p.insert, p_update: p.update, p_references: p.references }))) };
    }
    if (s.includes('pg_get_serial_sequence')) {
      // como o PostgreSQL real: tabela ausente ⇒ 42P01; coluna ausente ⇒ 42703; sem permissão no schema ⇒ 42501
      if (m.falhaSequencia) throw m.falhaSequencia;
      if (m.resolucao[params[0]] == null) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
      if (m.colunaIdAusente) throw Object.assign(new Error('column does not exist'), { code: '42703' });
      return { rows: [{ sequencia: m.sequenciaDoEvento }] };
    }
    if (s.includes('FROM token_dispositivos d JOIN empresas')) { if (falhaListagem) throw falhaListagem; return { rows: listagem }; }
    if (s.includes('SET queda_suspeita_desde = NULL WHERE queda_suspeita_desde IS NOT NULL')) return { rows: [{ id: 1 }, { id: 2 }] };
    if (s.includes("SET comunicacao_registrada = 'OFFLINE'")) return { rows: confirma ? [{ id: 1 }] : [] };
    if (s.startsWith('INSERT INTO token_dispositivo_eventos')) return { rows: [{ id: 1 }] };
    return { rows: [] };
  };
  const cliente = { query: responder, release() {} };
  return { chamadas, estado, modelo: m, query: responder, connect: async () => cliente, on: (nome, f) => estado.ouvintes.push([nome, f]), end: async () => { estado.encerrado += 1; } };
}

function saidaFalsa() {
  const eventos = [];
  return { eventos, log: (...a) => eventos.push(['log', ...a]), error: (...a) => eventos.push(['error', ...a]) };
}

async function rodar({ env = ENV_VALIDO, pool = bancoSimulado(), sonda = async () => true } = {}) {
  const saida = saidaFalsa();
  let criados = 0;
  const codigo = await job.executarJob({ env, criarPool: () => { criados += 1; return pool; }, criarSonda: () => sonda, relogio: () => AGORA, saida });
  return { codigo, pool, saida, criados };
}
const sqls = (pool) => pool.chamadas.map((c) => c.sql);
const escritas = (pool) => sqls(pool).filter((s) => /^(UPDATE|INSERT|DELETE)/.test(s));
const verificar = (pool, schemaEsperado = 'public') => exigirIdentidadeDoJob(pool, { papelEsperado: 'job_token', bancoEsperado: 'gestao', schemaEsperado });
const recusa = async (ajustar, codigo, campos) => {
  await assert.rejects(verificar(bancoSimulado(ajustar)), (erro) => erro instanceof ErroDoJob && erro.codigo === codigo && (campos === undefined || campos(erro.campos)), codigo);
};

describe('J2a Fase 4A — configuração do job', () => {
  test('sem a configuração o job não opera: recusa listando só os NOMES das variáveis, nada de valores', () => {
    assert.throws(() => lerConfiguracaoDoJob({ DB_HOST: 'x' }), (erro) => erro instanceof ErroDoJob && erro.codigo === 'CONFIGURACAO_AUSENTE'
      && erro.campos.includes('TOKEN_JOB_DB_USER') && erro.campos.includes('TOKEN_JOB_DB_PASSWORD') && erro.campos.includes('TOKEN_SONDA_URL_PUBLICA') && !JSON.stringify(erro.campos).includes('x"'));
    assert.throws(() => lerConfiguracaoDoJob({ ...ENV_VALIDO, TOKEN_SONDA_URL_PUBLICA: '   ' }), (erro) => erro.codigo === 'CONFIGURACAO_AUSENTE' && erro.campos.length === 1);
  });

  test('a credencial da aplicação não pode ser a do job', () => {
    assert.throws(() => lerConfiguracaoDoJob({ ...ENV_VALIDO, TOKEN_JOB_DB_USER: 'app_api' }), (erro) => erro.codigo === 'CREDENCIAL_DA_APLICACAO');
  });

  test('o destino da sonda só aceita origem https canônica: http, caminho, consulta, credencial, barra final e lixo são recusados', () => {
    for (const ruim of ['http://app.exemplo.com.br', 'https://app.exemplo.com.br/', 'https://app.exemplo.com.br/api', 'https://u:s@app.exemplo.com.br', 'https://app.exemplo.com.br?x=1', 'app.exemplo.com.br', 'ftp://app.exemplo.com.br', 'https://']) {
      assert.throws(() => lerConfiguracaoDoJob({ ...ENV_VALIDO, TOKEN_SONDA_URL_PUBLICA: ruim }), (erro) => erro.codigo === 'CONFIGURACAO_INVALIDA' && erro.campos[0] === 'TOKEN_SONDA_URL_PUBLICA', ruim);
    }
    assert.throws(() => lerConfiguracaoDoJob({ ...ENV_VALIDO, DB_PORT: 'abc' }), (erro) => erro.campos[0] === 'DB_PORT');
    const c = lerConfiguracaoDoJob({ ...ENV_VALIDO, TOKEN_SONDA_URL_PUBLICA: 'https://app.exemplo.com.br:8443' });
    assert.equal(c.sondaOrigem, 'https://app.exemplo.com.br:8443');
    assert.equal(c.banco.user, 'job_token');
    assert.equal(Object.isFrozen(c) && Object.isFrozen(c.banco), true);
  });
});

describe('J2a Fase 4A-R2 — F1: matriz mínima por coluna, baseada no SQL efetivo do job', () => {
  test('a matriz positiva: ultimo_contato_em só é LIDO; as únicas colunas atualizadas são comunicacao_registrada e queda_suspeita_desde', () => {
    const d = OBJETOS_PERMITIDOS.token_dispositivos;
    assert.deepEqual([...d.update], ['comunicacao_registrada', 'queda_suspeita_desde']);
    assert.ok(d.select.includes('ultimo_contato_em') && !d.update.includes('ultimo_contato_em'));
    for (const sensivel of ['credencial_hash', 'credencial_anterior_hash', 'revogado_em', 'revogado_por', 'ativado_em', 'identificador', 'atualizado_em']) assert.equal(d.update.includes(sensivel), false, sensivel);
    for (const sensivel of ['credencial_hash', 'credencial_anterior_hash', 'identificador', 'nome', 'numero_serie']) assert.equal(d.select.includes(sensivel), false, sensivel);
    assert.deepEqual([...OBJETOS_PERMITIDOS.token_dispositivo_eventos.insert], ['empresa_id', 'dispositivo_id', 'tipo', 'usuario_id', 'duracao_segundos']);
    assert.deepEqual([...OBJETOS_PERMITIDOS.token_dispositivo_eventos.select], ['id'], 'só o id, por causa do RETURNING');
    assert.deepEqual([...OBJETOS_PERMITIDOS.empresas.select], ['id', 'ativo']);
    assert.equal(Object.isFrozen(OBJETOS_PERMITIDOS) && Object.isFrozen(d) && Object.isFrozen(d.update), true);
    for (const [tabela, p] of Object.entries(OBJETOS_PERMITIDOS)) for (const c of [...p.select, ...p.insert, ...p.update]) assert.ok(COLUNAS[tabela].includes(c), `${tabela}.${c} existe nas migrations`);
  });

  test('papel mínimo correto é aceito: privilégios só por coluna (nenhum de tabela), sem ultimo_contato_em para UPDATE', async () => {
    const banco = bancoSimulado();
    assert.deepEqual(await verificar(banco), { papel: 'job_token', schema: 'public' });
    assert.equal(banco.modelo.relacoes.token_dispositivos.t.update, false);
    assert.equal(banco.modelo.colunas.token_dispositivos.ultimo_contato_em.update, false);
    assert.equal(banco.modelo.colunas.token_dispositivos.queda_suspeita_desde.update, true);
    assert.deepEqual(escritas(banco), []);
    assert.equal(banco.chamadas.length, 9, 'só leitura de catálogo: 9 consultas');
  });

  test('UPDATE irrestrito (de tabela, ou em qualquer coluna além das duas) é recusado', async () => {
    await recusa((m) => { m.relacoes.token_dispositivos.t.update = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.includes('token_dispositivos:UPDATE'));
    for (const coluna of ['ultimo_contato_em', 'credencial_hash', 'revogado_em', 'ativado_em']) {
      await recusa((m) => { m.colunas.token_dispositivos[coluna].update = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.includes(`token_dispositivos.${coluna}:UPDATE`));
    }
  });

  test('privilégio necessário ausente é recusado, inclusive o do RETURNING (SELECT em id) e o de leitura do WHERE', async () => {
    await recusa((m) => { m.colunas.token_dispositivos.comunicacao_registrada.update = false; }, 'PRIVILEGIO_FALTANDO', (c) => c.join() === 'token_dispositivos.comunicacao_registrada:UPDATE');
    await recusa((m) => { m.colunas.token_dispositivos.queda_suspeita_desde.update = false; }, 'PRIVILEGIO_FALTANDO');
    await recusa((m) => { m.colunas.token_dispositivos.id.select = false; }, 'PRIVILEGIO_FALTANDO', (c) => c.join() === 'token_dispositivos.id:SELECT');
    await recusa((m) => { m.colunas.token_dispositivos.ultimo_contato_em.select = false; }, 'PRIVILEGIO_FALTANDO');
    await recusa((m) => { m.colunas.empresas.ativo.select = false; }, 'PRIVILEGIO_FALTANDO');
    await recusa((m) => { m.colunas.token_dispositivo_eventos.id.select = false; }, 'PRIVILEGIO_FALTANDO', (c) => c.join() === 'token_dispositivo_eventos.id:SELECT');
    await recusa((m) => { m.colunas.token_dispositivo_eventos.tipo.insert = false; }, 'PRIVILEGIO_FALTANDO', (c) => c.join() === 'token_dispositivo_eventos.tipo:INSERT');
    await recusa((m) => { delete m.colunas.token_dispositivos.queda_suspeita_desde; }, 'PRIVILEGIO_FALTANDO');
  });

  test('privilégio excessivo é recusado: tabela, coluna, REFERENCES, DELETE, TRUNCATE, tabelas de pessoas e sessões, colunas de credencial', async () => {
    await recusa((m) => { m.relacoes.usuarios.t.select = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'usuarios:SELECT');
    await recusa((m) => { m.relacoes.sessoes.c.select = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'sessoes:SELECT(coluna)');
    await recusa((m) => { m.relacoes.logs_auditoria.t.insert = true; }, 'PRIVILEGIO_EXCEDENTE');
    await recusa((m) => { m.relacoes.token_dispositivos.t.select = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.includes('token_dispositivos:SELECT'));
    await recusa((m) => { m.relacoes.token_dispositivos.t.delete = true; }, 'PRIVILEGIO_EXCEDENTE');
    await recusa((m) => { m.relacoes.token_dispositivos.t.insert = true; }, 'PRIVILEGIO_EXCEDENTE');
    await recusa((m) => { m.relacoes.token_dispositivo_eventos.t.truncate = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.includes('token_dispositivo_eventos:TRUNCATE'));
    await recusa((m) => { m.relacoes.token_dispositivo_eventos.t.update = true; }, 'PRIVILEGIO_EXCEDENTE');
    await recusa((m) => { m.relacoes.empresas.t.update = true; }, 'PRIVILEGIO_EXCEDENTE');
    await recusa((m) => { m.colunas.token_dispositivos.credencial_hash.select = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'token_dispositivos.credencial_hash:SELECT');
    await recusa((m) => { m.colunas.token_dispositivos.id.references = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'token_dispositivos.id:REFERENCES');
    await recusa((m) => { m.colunas.empresas.nome.select = true; }, 'PRIVILEGIO_EXCEDENTE');
    await recusa((m) => { m.colunas.token_dispositivo_eventos.ocorrido_em.insert = true; }, 'PRIVILEGIO_EXCEDENTE');
    await recusa((m) => { m.relacoes.objeto_novo = { tipo: 'r', t: { ...SEM_PRIVILEGIO_TABELA(), select: true }, c: SEM_PRIVILEGIO_COLUNA() }; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'objeto_novo:SELECT');
  });

  test('lista POSITIVA: um objeto novo do schema com qualquer privilégio de coluna também é recusado (não depende de uma lista de nomes proibidos)', async () => {
    await recusa((m) => { m.relacoes.tabela_futura = { tipo: 'r', t: SEM_PRIVILEGIO_TABELA(), c: { ...SEM_PRIVILEGIO_COLUNA(), update: true } }; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'tabela_futura:UPDATE(coluna)');
  });

  test('sequências: a do identificador do evento não é exigida (identidade) e USAGE/SELECT nela é tolerado, mas UPDATE não; qualquer outra sequência é recusada', async () => {
    assert.deepEqual(await verificar(bancoSimulado((m) => { m.sequencias.token_dispositivo_eventos_id_seq.usage = true; m.sequencias.token_dispositivo_eventos_id_seq.select = true; })), { papel: 'job_token', schema: 'public' });
    await recusa((m) => { m.sequencias.token_dispositivo_eventos_id_seq.update = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'token_dispositivo_eventos_id_seq:UPDATE');
    await recusa((m) => { m.sequencias.empresas_id_seq.usage = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'empresas_id_seq:USAGE');
    await recusa((m) => { m.sequencias.empresas_id_seq.select = true; }, 'PRIVILEGIO_EXCEDENTE');
  });
});

describe('J2a Fase 4A-R2 — F2: identidade, banco, schema e privilégios efetivos', () => {
  test('credencial da API, sessão diferente do papel ou papel ausente: recusados', async () => {
    await recusa((m) => { m.identidade.papel = 'app_api'; }, 'PAPEL_DIVERGENTE');
    await recusa((m) => { m.identidade.sessao = 'postgres'; }, 'PAPEL_DIVERGENTE');
    await recusa((m) => { m.identidade = null; }, 'PAPEL_DIVERGENTE');
  });

  test('papel elevado (SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS) é recusado', async () => {
    for (const atributo of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls']) {
      await recusa((m) => { m.identidade[atributo] = true; }, 'PAPEL_PRIVILEGIADO', (c) => c.join() === atributo);
    }
  });

  test('banco incorreto é recusado', async () => {
    await recusa((m) => { m.identidade.banco = 'outro_banco'; }, 'BANCO_DIVERGENTE');
  });

  test('herança: pertencimento a qualquer outro papel é recusado (os privilégios efetivos poderiam vir dele)', async () => {
    await recusa((m) => { m.membros = ['app_api']; }, 'PAPEL_COM_MEMBROS', (c) => c.join() === 'app_api');
  });

  test('sem CONNECT ou sem USAGE no schema: recusados; CREATE no banco: recusado', async () => {
    await recusa((m) => { m.identidade.banco_connect = false; }, 'SEM_CONNECT');
    await recusa((m) => { m.identidade.schema_usage = false; }, 'SEM_USAGE');
    await recusa((m) => { m.identidade.banco_create = true; }, 'BANCO_PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'CREATE');
    await recusa((m) => { m.identidade.banco_create = undefined; }, 'BANCO_PRIVILEGIO_EXCEDENTE');
  });

  test('TEMP herdado de PUBLIC NÃO é motivo de recusa (papel mínimo aceito, TEMP efetivo no modelo), e a consulta de identidade nem o pergunta mais', async () => {
    const banco = bancoSimulado();
    assert.equal(banco.modelo.identidade.banco_temp, true);
    assert.deepEqual(await verificar(banco), { papel: 'job_token', schema: 'public' });
    assert.equal(sqls(banco).some((s) => /'TEMP'/.test(s)), false);
  });

  test('controle compensatório: relação temporária na sessão, ou objeto do job resolvido para tabela temporária, é recusado', async () => {
    await recusa((m) => { m.temporarios = 1; }, 'OBJETO_TEMPORARIO', (c) => c.join() === 'sessao');
    for (const ruim of [undefined, null, -1, 0.5, '0', NaN]) await recusa((m) => { m.temporarios = ruim; }, 'OBJETO_TEMPORARIO');
    await recusa((m) => { m.resolucao.token_dispositivos = 'pg_temp_3'; m.persistenciaDe = { token_dispositivos: 't' }; }, 'OBJETO_TEMPORARIO', (c) => c.join() === 'token_dispositivos');
    await recusa((m) => { m.persistenciaDe = { empresas: 't' }; }, 'OBJETO_TEMPORARIO', (c) => c.join() === 'empresas');
    await recusa((m) => { m.resolucao.token_dispositivo_eventos = 'pg_temp_7'; }, 'OBJETO_TEMPORARIO', (c) => c.join() === 'token_dispositivo_eventos');
    await recusa((m) => { m.persistenciaDe = { empresas: 'u' }; }, 'OBJETO_TEMPORARIO');
  });

  test('a verificação usa UMA conexão para todas as consultas e a devolve ao pool, também quando recusa ou falha', async () => {
    for (const ajustar of [() => {}, (m) => { m.temporarios = 2; }]) {
      const banco = bancoSimulado(ajustar);
      let conexoes = 0;
      let liberadas = 0;
      const original = banco.connect;
      banco.connect = async () => { conexoes += 1; const c = await original(); return { query: c.query, release: () => { liberadas += 1; } }; };
      banco.query = async () => { throw new Error('a verificação não deve usar o pool diretamente'); };
      await verificar(banco).catch(() => {});
      assert.equal(conexoes, 1);
      assert.equal(liberadas, 1);
    }
    let liberada = 0;
    const falha = { connect: async () => ({ query: async () => { throw Object.assign(new Error('x'), { code: '42501' }); }, release: () => { liberada += 1; } }) };
    await assert.rejects(verificar(falha), (erro) => erro.code === '42501');
    assert.equal(liberada, 1);
  });

  test('o SQL do job não cria nem usa objeto temporário e nenhuma consulta o qualifica por pg_temp (o job nunca emite DDL)', () => {
    const comentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const arquivo of ['src/repositories/token-monitoramento.repository.js', 'src/repositories/token-dispositivo-evento.repository.js', 'src/services/token-monitoramento.service.js']) {
      const texto = comentarios(fs.readFileSync(path.join(RAIZ, arquivo), 'utf8'));
      assert.equal(/\bTEMP(ORARY)?\b|pg_temp|\bCREATE\s|\bALTER\s|\bDROP\s|\bSET\s+(LOCAL\s+)?search_path/i.test(texto), false, arquivo);
    }
    const executor = comentarios(fs.readFileSync(path.join(RAIZ, 'scripts/verificar-comunicacao-token.js'), 'utf8'));
    assert.equal(/\bTEMP(ORARY)?\b|\bCREATE\s|\bALTER\s|\bDROP\s|\bSET\s+(LOCAL\s+)?search_path/i.test(executor), false);
    assert.equal(executor.match(/pg_temp/g).length, 1, 'pg_temp só na opção de partida do pool');
  });

  test('schema incorreto: sem schema corrente, schema de sistema, objeto em outro schema, objeto ausente, CREATE em schema do caminho de busca', async () => {
    await recusa((m) => { m.identidade.schema = null; m.identidade.schema_usage = null; }, 'SCHEMA_INVALIDO');
    await recusa((m) => { m.identidade.schema = 'pg_temp_3'; }, 'SCHEMA_INVALIDO');
    await recusa((m) => { m.identidade.schema = 'information_schema'; }, 'SCHEMA_INVALIDO');
    await recusa((m) => { m.resolucao.token_dispositivos = 'outro'; }, 'SCHEMA_INVALIDO', (c) => c.join() === 'token_dispositivos@outro');
    await recusa((m) => { m.resolucao.empresas = null; }, 'OBJETO_AUSENTE', (c) => c.join() === 'empresas');
    await recusa((m) => { m.caminho = [{ schema: 'publico_aberto', cria: true }, { schema: 'public', cria: false }]; }, 'SCHEMA_COM_CREATE', (c) => c.join() === 'publico_aberto');
  });

  test('a verificação só lê: nenhuma escrita e erro de banco que não é recusa é propagado ao executor', async () => {
    const banco = bancoSimulado();
    await verificar(banco);
    assert.deepEqual(escritas(banco), []);
    await assert.rejects(verificar(bancoSimulado(() => {}, { falhaIdentidade: Object.assign(new Error('permission denied'), { code: '42501' }) })), (erro) => erro.code === '42501' && !(erro instanceof ErroDoJob));
  });
});

describe('J2a Fase 4A-R2 — F3: classificação única de indisponibilidade do banco', () => {
  test('indisponibilidade: conexão, desligamento, limite de conexões e erros de rede', () => {
    for (const codigo of ['08000', '08001', '08006', '57P01', '57P02', '57P03', '53300', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']) {
      assert.equal(bancoIndisponivel(Object.assign(new Error('x'), { code: codigo })), true, codigo);
    }
    assert.equal(bancoIndisponivel(new Error('Connection terminated unexpectedly')), true);
    assert.equal(bancoIndisponivel(new Error('timeout exceeded when trying to connect')), true);
  });

  test('NÃO é indisponibilidade: falta de privilégio, SQL inválido, objeto inexistente, autenticação, banco inexistente, restrição, erro de aplicação, defeito', () => {
    for (const codigo of ['42501', '42601', '42P01', '42703', '28000', '28P01', '3D000', '23505', '23503', 'P0001', 'XX000', '57014', '22P02']) {
      assert.equal(bancoIndisponivel(Object.assign(new Error('x'), { code: codigo })), false, codigo);
    }
    assert.equal(bancoIndisponivel(Object.assign(new Error('Connection terminated'), { code: '42501' })), false, 'com SQLSTATE, decide só o código');
    assert.equal(bancoIndisponivel(new TypeError('defeito')), false);
    assert.equal(bancoIndisponivel(new ErroDoJob('PAPEL_DIVERGENTE')), false, 'autoridade recusada');
    for (const nada of [null, undefined, 'ECONNREFUSED', 42]) assert.equal(bancoIndisponivel(nada), false);
  });

  test('a definição é única: o executor importa a do serviço e não mantém cópia', () => {
    const script = fs.readFileSync(path.join(RAIZ, 'scripts/verificar-comunicacao-token.js'), 'utf8');
    assert.ok(/const \{[^}]*bancoIndisponivel[^}]*\} = require\('\.\.\/src\/services\/token-monitoramento\.service'\)/.test(script));
    assert.equal(/function bancoIndisponivel|CODIGOS_DE_REDE/.test(script), false);
    assert.equal(Object.hasOwn(job, 'bancoIndisponivel'), false);
  });

  test('o executor traduz: erro de privilégio, SQL, objeto ausente, autoridade ou defeito saem com 1; indisponibilidade sai com 3', async () => {
    for (const codigo of ['42501', '42P01', '42601', '28P01', '3D000']) {
      const r = await rodar({ pool: bancoSimulado(() => {}, { falhaIdentidade: Object.assign(new Error('x'), { code: codigo }) }) });
      assert.equal(r.codigo, job.SAIDAS.ERRO, `identidade ${codigo}`);
      const l = await rodar({ pool: bancoSimulado(() => {}, { falhaListagem: Object.assign(new Error('x'), { code: codigo }) }) });
      assert.equal(l.codigo, job.SAIDAS.ERRO, `listagem ${codigo}`);
    }
    for (const codigo of ['08006', '57P01', 'ECONNRESET']) {
      assert.equal((await rodar({ pool: bancoSimulado(() => {}, { falhaIdentidade: Object.assign(new Error('x'), { code: codigo }) }) })).codigo, job.SAIDAS.BANCO, `identidade ${codigo}`);
      assert.equal((await rodar({ pool: bancoSimulado(() => {}, { falhaListagem: Object.assign(new Error('x'), { code: codigo }) }) })).codigo, job.SAIDAS.BANCO, `listagem ${codigo}`);
      assert.equal((await rodar({ pool: bancoSimulado(() => {}, { falhaTrivial: Object.assign(new Error('x'), { code: codigo }) }) })).codigo, job.SAIDAS.BANCO, `trivial ${codigo}`);
    }
  });
});

describe('J2a Fase 4B — diagnóstico de objeto ausente (o 42P01 do pg_get_serial_sequence não escapa)', () => {
  const sqlDaSequencia = (banco) => sqls(banco).filter((s) => s.includes('pg_get_serial_sequence'));

  test('tabela de eventos ausente: OBJETO_AUSENTE controlado; a função dependente da tabela NÃO é chamada', async () => {
    const banco = bancoSimulado((m) => { m.resolucao.token_dispositivo_eventos = null; });
    await assert.rejects(verificar(banco), (erro) => erro instanceof ErroDoJob && erro.codigo === 'OBJETO_AUSENTE' && erro.campos.join() === 'token_dispositivo_eventos');
    assert.deepEqual(sqlDaSequencia(banco), []);
    assert.equal(sqls(banco).filter((s) => s.includes('AS existe')).length, 1);
    for (const ausente of ['empresas', 'token_dispositivos']) {
      await recusa((m) => { m.resolucao[ausente] = null; }, 'OBJETO_AUSENTE', (c) => c.join() === ausente);
    }
    await recusa((m) => { m.resolucao = { empresas: null, token_dispositivos: null, token_dispositivo_eventos: null }; }, 'OBJETO_AUSENTE', (c) => c.length === 3);
  });

  test('no executor, a tabela ausente é autoridade_invalida/OBJETO_AUSENTE com código 1 (e não falha_inesperada com 42P01), sem passagem', async () => {
    const pool = bancoSimulado((m) => { m.resolucao.token_dispositivo_eventos = null; });
    const r = await rodar({ pool });
    assert.equal(r.codigo, job.SAIDAS.ERRO);
    assert.deepEqual(r.saida.eventos[0][2], { evento: 'autoridade_invalida', codigo: 'OBJETO_AUSENTE', campos: ['token_dispositivo_eventos'] });
    assert.equal(sqls(pool).some((s) => s.includes('JOIN empresas')), false);
    assert.deepEqual(escritas(pool), []);
  });

  test('tabela existente e sequência válida: a sequência é consultada uma vez e a avaliação segue normal', async () => {
    const banco = bancoSimulado();
    assert.deepEqual(await verificar(banco), { papel: 'job_token', schema: 'public' });
    assert.equal(sqlDaSequencia(banco).length, 1);
    assert.deepEqual(banco.chamadas.find((c) => c.sql.includes('pg_get_serial_sequence')).params, ['token_dispositivo_eventos', 'id']);
    assert.deepEqual(await verificar(bancoSimulado((m) => { m.sequencias.token_dispositivo_eventos_id_seq.usage = true; m.sequencias.token_dispositivo_eventos_id_seq.select = true; })), { papel: 'job_token', schema: 'public' });
  });

  test('tabela existente e sequência ausente ou inadequada: a exceção da sequência some e o privilégio nela é excedente; UPDATE continua recusado', async () => {
    assert.deepEqual(await verificar(bancoSimulado((m) => { m.sequenciaDoEvento = null; })), { papel: 'job_token', schema: 'public' });
    await recusa((m) => { m.sequenciaDoEvento = null; m.sequencias.token_dispositivo_eventos_id_seq.usage = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'token_dispositivo_eventos_id_seq:USAGE');
    await recusa((m) => { m.sequenciaDoEvento = 'public.outra_seq'; m.sequencias.token_dispositivo_eventos_id_seq.usage = true; }, 'PRIVILEGIO_EXCEDENTE');
    await recusa((m) => { m.sequencias.token_dispositivo_eventos_id_seq.update = true; }, 'PRIVILEGIO_EXCEDENTE', (c) => c.join() === 'token_dispositivo_eventos_id_seq:UPDATE');
  });

  test('erro de permissão, na existência ou na sequência, NÃO vira OBJETO_AUSENTE: propaga com o SQLSTATE e o executor sai com 1 como falha inesperada', async () => {
    for (const campo of ['falhaExiste', 'falhaSequencia']) {
      const erroPermissao = Object.assign(new Error('permission denied for schema'), { code: '42501' });
      await assert.rejects(verificar(bancoSimulado((m) => { m[campo] = erroPermissao; })), (erro) => !(erro instanceof ErroDoJob) && erro.code === '42501', campo);
      const r = await rodar({ pool: bancoSimulado((m) => { m[campo] = erroPermissao; }) });
      assert.equal(r.codigo, job.SAIDAS.ERRO);
      assert.deepEqual(r.saida.eventos[0][2], { evento: 'falha_inesperada', nome: 'Error', codigo: '42501' }, campo);
    }
  });

  test('outros erros de SQL não são mascarados: coluna ausente (42703), 42P01 de fora do caso previsto e erro de conexão', async () => {
    await assert.rejects(verificar(bancoSimulado((m) => { m.colunaIdAusente = true; })), (erro) => !(erro instanceof ErroDoJob) && erro.code === '42703');
    await assert.rejects(verificar(bancoSimulado((m) => { m.falhaSequencia = Object.assign(new Error('x'), { code: '42P01' }); })), (erro) => !(erro instanceof ErroDoJob) && erro.code === '42P01', 'com a tabela existente o 42P01 seria anômalo e deve aparecer');
    await assert.rejects(verificar(bancoSimulado((m) => { m.falhaExiste = Object.assign(new Error('x'), { code: '08006' }); })), (erro) => !(erro instanceof ErroDoJob) && erro.code === '08006');
    const queda = await rodar({ pool: bancoSimulado((m) => { m.falhaSequencia = Object.assign(new Error('x'), { code: '57P01' }); }) });
    assert.equal(queda.codigo, job.SAIDAS.BANCO);
    const outro = await rodar({ pool: bancoSimulado((m) => { m.colunaIdAusente = true; }) });
    assert.equal(outro.codigo, job.SAIDAS.ERRO);
    assert.equal(outro.saida.eventos[0][2].codigo, '42703');
  });

  test('a conversão em OBJETO_AUSENTE só acontece pela resolução: o texto do módulo não captura erro SQL (nenhum catch/42P01)', () => {
    const texto = fs.readFileSync(path.join(RAIZ, 'src/security/autoridade-job-interno.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const coleta = texto.slice(texto.indexOf('function avaliarAutoridade'));
    assert.ok(coleta.includes('exigirIdentidadeDoJob'));
    assert.equal(/\bcatch\b|42P01|42501|\.code\b/.test(coleta), false, 'avaliação e coleta não inspecionam nem capturam erros SQL');
  });
});

describe('J2a Fase 4B — resolução de objetos em TODAS as conexões do pool do job (mocks; não é homologação PostgreSQL)', () => {
  const CONFIG_BANCO = { host: 'h', port: 5432, database: 'gestao', user: 'job_token', password: 'segredo-do-job-xyz' };
  class PoolFalso {
    constructor(opcoes) { this.opcoes = opcoes; this.clientes = []; this.ociosos = []; }
    async connect() {
      const cliente = this.ociosos.pop() ?? { opcoesDeSessao: this.opcoes.options, query: async () => ({ rows: [] }) };
      if (!this.clientes.includes(cliente)) this.clientes.push(cliente);
      cliente.release = () => this.ociosos.push(cliente);
      return cliente;
    }
    async novaConexaoForcada() { const c = { opcoesDeSessao: this.opcoes.options, query: async () => ({ rows: [] }) }; this.clientes.push(c); return c; }
  }

  test('o pool nasce com o schema autorizado e pg_temp EXPLICITAMENTE depois dele; o resto da configuração do pool é preservado', () => {
    let visto;
    class Captura { constructor(o) { visto = o; } }
    job.criarPoolDoJob({ ...CONFIG_BANCO, schema: 'public' }, { Pool: Captura });
    assert.equal(visto.options, '-c search_path=public,pg_temp');
    assert.deepEqual({ host: visto.host, port: visto.port, database: visto.database, user: visto.user }, { host: 'h', port: 5432, database: 'gestao', user: 'job_token' });
    assert.equal(visto.max, 4);
    assert.equal(visto.application_name, 'safework-job-token');
    assert.equal(job.searchPathDoJob('teste_ab12'), '-c search_path=teste_ab12,pg_temp');
  });

  test('toda conexão, inclusive a criada depois de uma liberação, nasce com o mesmo caminho de busca (a configuração é da criação da sessão)', async () => {
    const pool = job.criarPoolDoJob({ ...CONFIG_BANCO, schema: 'public' }, { Pool: PoolFalso });
    const a = await pool.connect();
    const b = await pool.connect();
    a.release();
    const reaproveitada = await pool.connect();
    const nova = await pool.novaConexaoForcada();
    assert.equal(reaproveitada, a);
    assert.equal(pool.clientes.length, 3);
    for (const c of [a, b, nova]) assert.equal(c.opcoesDeSessao, '-c search_path=public,pg_temp');
  });

  test('o schema vem só da configuração do operador: padrão public; identificador simples e validado; nada de pg_*, information_schema, aspas, ponto, vírgula ou espaço', () => {
    assert.equal(job.schemaDoJob({}), 'public');
    assert.equal(job.schemaDoJob({ TOKEN_JOB_DB_SCHEMA: 'teste_migration_ab12cd' }), 'teste_migration_ab12cd');
    for (const ruim of ['', ' ', 'Public', 'a-b', 'a.b', 'a,b', 'public,pg_temp', 'public;drop', '"public"', 'pg_temp', 'pg_catalog', 'pg_temp_3', 'information_schema', '1abc', 'a'.repeat(64), null, 5]) {
      assert.throws(() => job.schemaDoJob({ TOKEN_JOB_DB_SCHEMA: ruim }), (erro) => erro instanceof ErroDoJob && erro.codigo === 'CONFIGURACAO_INVALIDA' && erro.campos[0] === 'TOKEN_JOB_DB_SCHEMA', String(ruim));
    }
    assert.equal(job.schemaDoJob({ TOKEN_JOB_DB_SCHEMA: 'a'.repeat(63) }).length, 63);
  });

  test('o executor entrega o schema validado ao pool e à verificação; configuração inválida: código 1, sem pool, sem consulta, só o NOME da variável na saída', async () => {
    let recebido;
    const pool = bancoSimulado((m) => { m.identidade.schema = 'teste_x'; m.identidade.caminho_configurado = 'teste_x,pg_temp'; m.resolucao = { empresas: 'teste_x', token_dispositivos: 'teste_x', token_dispositivo_eventos: 'teste_x' }; });
    const saida = saidaFalsa();
    const codigo = await job.executarJob({ env: { ...ENV_VALIDO, TOKEN_JOB_DB_SCHEMA: 'teste_x' }, criarPool: (c) => { recebido = c; return pool; }, criarSonda: () => async () => true, relogio: () => AGORA, saida });
    assert.equal(codigo, job.SAIDAS.OK);
    assert.equal(recebido.schema, 'teste_x');
    const padrao = await rodar();
    assert.equal(padrao.codigo, job.SAIDAS.OK);
    const ruim = await rodar({ env: { ...ENV_VALIDO, TOKEN_JOB_DB_SCHEMA: 'public,pg_temp' } });
    assert.equal(ruim.codigo, job.SAIDAS.ERRO);
    assert.equal(ruim.criados, 0);
    assert.equal(ruim.pool.chamadas.length, 0);
    assert.deepEqual(ruim.saida.eventos[0][2], { evento: 'configuracao_invalida', codigo: 'CONFIGURACAO_INVALIDA', campos: ['TOKEN_JOB_DB_SCHEMA'] });
    assert.equal(JSON.stringify(ruim.saida.eventos).includes('pg_temp'), false);
  });

  test('coerência: a sessão verificada precisa ter exatamente o caminho que o pool fixa; divergência é recusada (a verificação não depende de uma conexão "boa")', async () => {
    for (const ruim of ['pg_temp, public', 'public', '"$user", public', 'public, pg_temp, outro', 'outro, public, pg_temp', '', null, undefined]) {
      await recusa((m) => { m.identidade.caminho_configurado = ruim; }, 'SEARCH_PATH_DIVERGENTE');
    }
    await recusa((m) => { m.identidade.schema = 'outro'; m.identidade.caminho_configurado = 'outro, pg_temp'; m.resolucao = { empresas: 'outro', token_dispositivos: 'outro', token_dispositivo_eventos: 'outro' }; }, 'SEARCH_PATH_DIVERGENTE');
    for (const ok of ['public,pg_temp', 'public, pg_temp', 'PUBLIC, pg_temp', '"public", pg_temp']) {
      assert.deepEqual(await verificar(bancoSimulado((m) => { m.identidade.caminho_configurado = ok; })), { papel: 'job_token', schema: 'public' }, ok);
    }
    const r = await rodar({ pool: bancoSimulado((m) => { m.identidade.caminho_configurado = 'pg_temp, public'; }) });
    assert.equal(r.codigo, job.SAIDAS.ERRO);
    assert.equal(r.saida.eventos[0][2].codigo, 'SEARCH_PATH_DIVERGENTE');
    assert.equal(sqls(r.pool).some((s) => s.includes('JOIN empresas')), false);
  });

  test('sem schemaEsperado (uso puro) a conferência de caminho não se aplica, mas todas as demais recusas continuam (F2 preservada)', async () => {
    assert.deepEqual(await exigirIdentidadeDoJob(bancoSimulado((m) => { m.identidade.caminho_configurado = 'qualquer'; }), { papelEsperado: 'job_token', bancoEsperado: 'gestao' }), { papel: 'job_token', schema: 'public' });
    await assert.rejects(exigirIdentidadeDoJob(bancoSimulado((m) => { m.temporarios = 1; }), { papelEsperado: 'job_token', bancoEsperado: 'gestao' }), (erro) => erro.codigo === 'OBJETO_TEMPORARIO');
  });

  test('o job não troca de schema durante a vida da conexão: nenhum SET, nenhum schema vindo do tablet, da rota ou do banco', () => {
    const comentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const executor = comentarios(fs.readFileSync(path.join(RAIZ, 'scripts/verificar-comunicacao-token.js'), 'utf8'));
    assert.equal(/search_path/.test(executor.replace(/-c search_path=\$\{schema\},pg_temp/, '')), false);
    assert.equal((executor.match(/TOKEN_JOB_DB_SCHEMA/g) ?? []).length, 3, 'só em schemaDoJob: duas leituras do valor e o nome no erro');
    for (const arquivo of ['src/repositories/token-monitoramento.repository.js', 'src/repositories/token-dispositivo-evento.repository.js', 'src/services/token-monitoramento.service.js']) {
      assert.equal(/search_path|TOKEN_JOB_DB_SCHEMA/.test(comentarios(fs.readFileSync(path.join(RAIZ, arquivo), 'utf8'))), false, arquivo);
    }
    const criacao = executor.slice(executor.indexOf('function criarPoolDoJob'), executor.indexOf('async function executar('));
    assert.equal(/options:\s*searchPathDoJob\(schema\)/.test(criacao), true);
    assert.equal(/new Pool\(/.test(executor), true);
    assert.equal((executor.match(/new Pool\(/g) ?? []).length, 1, 'um único pool para o job inteiro');
  });
});

describe('J2a Fase 4A — sonda pública (cliente HTTP falso)', () => {
  const resposta = (status, corpo, cabecalhos = {}) => ({
    status, headers: { get: (n) => cabecalhos[n.toLowerCase()] ?? null }, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)), body: { cancel: async () => {} },
  });
  const OK = { status: 'ok', service: 'gestao-epi-api' };
  const sondaCom = (requisitar, extra = {}) => criarSondaPublica({ origem: 'https://app.exemplo.com.br', requisitar, ...extra });

  test('saudável: 200 com o corpo da rota de saúde; falha comprovada: timeout, rede, TLS e 5xx; inconclusiva: o resto', async () => {
    assert.equal(await sondaCom(async () => resposta(200, OK))(), true);
    for (const status of [500, 502, 503, 599]) assert.equal(await sondaCom(async () => resposta(status, ''))(), false, String(status));
    for (const nome of ['TimeoutError', 'AbortError', 'TypeError']) assert.equal(await sondaCom(async () => { throw Object.assign(new Error('x'), { name: nome }); })(), false, nome);
    for (const status of [204, 301, 302, 400, 401, 403, 404, 429]) assert.equal(await sondaCom(async () => resposta(status, ''))(), undefined, String(status));
    assert.equal(await sondaCom(async () => resposta(200, { status: 'ok', service: 'outro' }))(), undefined, 'um 200 qualquer não prova a nossa API');
    assert.equal(await sondaCom(async () => resposta(200, { status: 'erro', service: 'gestao-epi-api' }))(), undefined);
    assert.equal(await sondaCom(async () => resposta(200, 'não é json'))(), undefined);
    assert.equal(await sondaCom(async () => resposta(200, '[]'))(), undefined);
    assert.equal(await sondaCom(async () => resposta(200, OK, { 'content-length': '999999' }))(), undefined, 'corpo grande demais');
    assert.equal(await sondaCom(async () => resposta(200, `${' '.repeat(5000)}${JSON.stringify(OK)}`))(), undefined, 'corpo grande demais sem content-length');
  });

  test('a requisição: GET no caminho fixo da origem configurada, sem seguir redirecionamento, com timeout, sem cookie nem credencial', async () => {
    let visto;
    await sondaCom(async (url, opcoes) => { visto = { url, opcoes }; return resposta(200, OK); })();
    assert.equal(visto.url, `https://app.exemplo.com.br${CAMINHO_SAUDE}`);
    assert.equal(visto.url, 'https://app.exemplo.com.br/api/health');
    assert.equal(visto.opcoes.method, 'GET');
    assert.equal(visto.opcoes.redirect, 'manual');
    assert.ok(visto.opcoes.signal instanceof AbortSignal);
    assert.deepEqual(Object.keys(visto.opcoes.headers), ['accept']);
    assert.equal('body' in visto.opcoes || 'credentials' in visto.opcoes, false);
  });

  test('o timeout é de 5 s por padrão, validado e limitado; origem inválida e cliente ausente lançam TypeError', async () => {
    let sinal;
    await sondaCom(async (_u, o) => { sinal = o.signal; return resposta(200, OK); })();
    assert.equal(sinal.aborted, false);
    for (const ruim of [0, 999, 15001, 5.5, '5000', null]) assert.throws(() => sondaCom(async () => resposta(200, OK), { timeoutMs: ruim }), TypeError, String(ruim));
    assert.throws(() => criarSondaPublica({ origem: 'http://x.exemplo.com', requisitar: async () => resposta(200, OK) }), TypeError);
    assert.throws(() => criarSondaPublica({ origem: 'https://x.exemplo.com', requisitar: null }), TypeError);
    assert.throws(() => validarOrigem(undefined), TypeError);
  });

  test('a sonda não vaza o destino: o resultado é só true, false ou undefined', async () => {
    for (const r of [await sondaCom(async () => resposta(200, OK))(), await sondaCom(async () => { throw new Error('https://app.exemplo.com.br/segredo'); })(), await sondaCom(async () => resposta(404, ''))()]) {
      assert.ok(r === true || r === false || r === undefined);
    }
  });
});

describe('J2a Fase 4A — executor de passagem única (banco e sonda simulados)', () => {
  test('passagem saudável sem tablets: código 0, log só com contagens, o pool é criado e encerrado, nenhuma escrita', async () => {
    const r = await rodar();
    assert.equal(r.codigo, job.SAIDAS.OK);
    assert.equal(r.criados, 1);
    assert.equal(r.pool.estado.encerrado, 1);
    assert.deepEqual(escritas(r.pool), []);
    assert.deepEqual(r.saida.eventos, [['log', '[token-monitoramento]', { evento: 'passagem_concluida', quedas: 0, suspeitasFuturas: 0 }]]);
    assert.ok(r.pool.estado.ouvintes.some(([n]) => n === 'error'), 'o erro de cliente ocioso do pool é tratado, não derruba o processo');
  });

  test('a ordem: consulta trivial, verificação de autoridade completa e só então a passagem (a listagem multiempresa vem por último)', async () => {
    const r = await rodar();
    const ordem = sqls(r.pool).map((s) => (s === 'SELECT 1' ? 'trivial' : s.includes('FROM pg_roles r') ? 'identidade' : s.includes('FROM pg_roles m') ? 'membros' : s.includes('current_schemas') ? 'caminho'
      : s.includes('AS existe') ? 'existe' : s.includes('pg_my_temp_schema') ? 'temporarios' : s.includes('to_regclass') ? 'resolucao' : s.includes('has_sequence_privilege') ? 'relacoes' : s.includes('FROM pg_attribute') ? 'colunas' : s.includes('pg_get_serial_sequence') ? 'sequencia' : s.includes('JOIN empresas') ? 'listagem' : 'outro'));
    assert.deepEqual(ordem, ['trivial', 'identidade', 'membros', 'caminho', 'resolucao', 'temporarios', 'relacoes', 'colunas', 'existe', 'sequencia', 'listagem']);
  });

  test('o banco esperado vem da configuração (DB_NAME): banco diferente é recusado antes da passagem', async () => {
    const pool = bancoSimulado((m) => { m.identidade.banco = 'outro_banco'; });
    const r = await rodar({ pool });
    assert.equal(r.codigo, job.SAIDAS.ERRO);
    assert.equal(r.saida.eventos[0][2].codigo, 'BANCO_DIVERGENTE');
    assert.equal(sqls(pool).some((s) => s.includes('JOIN empresas')), false);
  });

  test('sem configuração (ou com a credencial da aplicação): código 1, nenhum pool, nenhuma sonda, nenhuma consulta', async () => {
    for (const env of [{}, { ...ENV_VALIDO, TOKEN_JOB_DB_PASSWORD: '' }, { ...ENV_VALIDO, TOKEN_JOB_DB_USER: 'app_api' }]) {
      const r = await rodar({ env });
      assert.equal(r.codigo, job.SAIDAS.ERRO);
      assert.equal(r.criados, 0);
      assert.equal(r.pool.chamadas.length, 0);
      assert.equal(r.saida.eventos[0][2].evento, 'configuracao_invalida');
    }
  });

  test('autoridade inválida (papel, elevado, privilégio sobrando ou faltando, schema): código 1, a listagem multiempresa não roda e nada é escrito', async () => {
    const cenarios = [(m) => { m.identidade.papel = 'app_api'; }, (m) => { m.identidade.rolsuper = true; }, (m) => { m.relacoes.usuarios.t.update = true; },
      (m) => { m.colunas.token_dispositivos.queda_suspeita_desde.update = false; }, (m) => { m.resolucao.token_dispositivos = 'outro'; }, (m) => { m.membros = ['outro']; }];
    for (const ajustar of cenarios) {
      const pool = bancoSimulado(ajustar);
      const r = await rodar({ pool });
      assert.equal(r.codigo, job.SAIDAS.ERRO);
      assert.equal(r.saida.eventos[0][2].evento, 'autoridade_invalida');
      assert.equal(sqls(pool).some((s) => s.includes('JOIN empresas')), false);
      assert.deepEqual(escritas(pool), []);
      assert.equal(pool.estado.encerrado, 1);
    }
  });

  test('banco indisponível na consulta trivial: código 3, sem verificação de autoridade, sem passagem, pool encerrado; erro de autenticação é falha (1)', async () => {
    const pool = bancoSimulado(() => {}, { falhaTrivial: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    const r = await rodar({ pool });
    assert.equal(r.codigo, job.SAIDAS.BANCO);
    assert.deepEqual(sqls(pool), ['SELECT 1']);
    assert.equal(pool.estado.encerrado, 1);
    const credencial = await rodar({ pool: bancoSimulado(() => {}, { falhaTrivial: Object.assign(new Error('x'), { code: '28P01' }) }) });
    assert.equal(credencial.codigo, job.SAIDAS.ERRO);
    assert.equal(credencial.saida.eventos[0][2].evento, 'falha_inesperada');
  });

  test('sonda reprovada: código 2, suspeitas invalidadas, NENHUMA outra escrita (sem contato, estado nem evento) e nenhuma listagem', async () => {
    const pool = bancoSimulado(() => {}, { listagem: [{ id: 7, empresa_id: 3 }] });
    const r = await rodar({ pool, sonda: async () => false });
    assert.equal(r.codigo, job.SAIDAS.SONDA);
    assert.deepEqual(escritas(pool), ['UPDATE token_dispositivos SET queda_suspeita_desde = NULL WHERE queda_suspeita_desde IS NOT NULL RETURNING id']);
    assert.equal(sqls(pool).some((s) => s.includes('JOIN empresas')), false);
    assert.deepEqual(r.saida.eventos[0].slice(0, 3), ['error', '[token-monitoramento]', { evento: 'passagem_abortada', motivo: 'SONDA_FALHOU', suspeitasInvalidadas: 2 }]);
  });

  test('sonda inconclusiva (resposta sem prova, erro ou nada): código 2, NENHUMA escrita e nenhuma listagem', async () => {
    for (const sonda of [async () => undefined, async () => null, async () => { throw new Error('x'); }]) {
      const pool = bancoSimulado(() => {}, { listagem: [{ id: 7 }] });
      const r = await rodar({ pool, sonda });
      assert.equal(r.codigo, job.SAIDAS.SONDA);
      assert.deepEqual(escritas(pool), []);
      assert.equal(sqls(pool).some((s) => s.includes('JOIN empresas')), false);
      assert.equal(r.saida.eventos[0][2].motivo, 'SONDA_INCONCLUSIVA');
    }
  });

  test('banco indisponível durante a passagem: código 3 (não 2); defeito inesperado: código 1 e o pool é encerrado', async () => {
    const queda = await rodar({ pool: bancoSimulado(() => {}, { falhaListagem: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }) });
    assert.equal(queda.codigo, job.SAIDAS.BANCO);
    assert.equal(queda.saida.eventos[0][2].motivo, 'BANCO_INDISPONIVEL');
    const defeito = bancoSimulado(() => {}, { falhaListagem: new TypeError('defeito') });
    const r = await rodar({ pool: defeito });
    assert.equal(r.codigo, job.SAIDAS.ERRO);
    assert.equal(r.saida.eventos[0][2].evento, 'falha_inesperada');
    assert.equal(defeito.estado.encerrado, 1);
  });

  test('o pool é encerrado mesmo se o encerramento falhar (a falha é registrada e não muda o código)', async () => {
    const pool = bancoSimulado();
    pool.end = async () => { throw Object.assign(new Error('x'), { code: 'EPIPE' }); };
    const r = await rodar({ pool });
    assert.equal(r.codigo, job.SAIDAS.OK);
    assert.ok(r.saida.eventos.some((e) => e[2]?.evento === 'falha_ao_encerrar_pool'));
  });

  test('nenhum segredo, destino, papel, banco ou identificador vai para a saída, em nenhum desfecho', async () => {
    const desfechos = [await rodar(), await rodar({ sonda: async () => false }), await rodar({ sonda: async () => undefined }), await rodar({ env: { ...ENV_VALIDO, TOKEN_JOB_DB_USER: 'app_api' } }),
      await rodar({ pool: bancoSimulado((m) => { m.identidade.papel = 'app_api'; }) }), await rodar({ pool: bancoSimulado((m) => { m.relacoes.usuarios.t.select = true; }) }),
      await rodar({ pool: bancoSimulado((m) => { m.identidade.banco = 'outro'; }) }),
      await rodar({ pool: bancoSimulado(() => {}, { falhaTrivial: Object.assign(new Error('postgres://u:segredo-do-job-xyz@h'), { code: 'ECONNREFUSED' }) }) })];
    const texto = JSON.stringify(desfechos.map((d) => d.saida.eventos));
    for (const proibido of ['segredo-do-job-xyz', 'app.exemplo.com.br', 'banco.interno.exemplo', 'job_token', 'postgres://', '"gestao"']) assert.equal(texto.includes(proibido), false, proibido);
  });

  test('os códigos de saída são distintos e estáveis: 0 concluída, 1 erro, 2 sonda, 3 banco', () => {
    assert.deepEqual({ ...job.SAIDAS }, { OK: 0, ERRO: 1, SONDA: 2, BANCO: 3 });
    assert.equal(Object.isFrozen(job.SAIDAS), true);
  });
});

describe('J2a Fase 4A-R2 — SQL alcançável pelo job, extraído da execução real das passagens', () => {
  const tablet = (id, contatoAtras, suspeitaAtras) => ({
    id, empresa_id: 3, ativado_em: atras(86400), revogado_em: null, ultimo_contato_em: atras(contatoAtras), comunicacao_registrada: 'ONLINE', queda_suspeita_desde: suspeitaAtras === null ? null : atras(suspeitaAtras),
  });
  const ehDoCatalogo = (s) => /pg_|to_regclass|current_user|^SELECT 1$/.test(s);

  async function sqlsDoJob() {
    const pool = bancoSimulado(() => {}, { listagem: [tablet(1, 10, 5), tablet(2, 300, null), tablet(3, 2000, 1000), tablet(4, 500, 120)] });
    assert.equal((await rodar({ pool })).codigo, job.SAIDAS.OK);
    const reprovada = bancoSimulado();
    assert.equal((await rodar({ pool: reprovada, sonda: async () => false })).codigo, job.SAIDAS.SONDA);
    return [...pool.chamadas, ...reprovada.chamadas].filter((c) => !ehDoCatalogo(c.sql) && !/^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql));
  }

  test('as seis operações do repositório e o evento QUEDA são exercitados, e nada além delas (nenhum SQL do heartbeat)', async () => {
    const chamadas = await sqlsDoJob();
    const tipos = new Set(chamadas.map(({ sql }) => (sql.startsWith('SELECT') ? 'listar' : sql.startsWith('INSERT') ? 'evento'
      : sql.includes("SET comunicacao_registrada = 'OFFLINE'") ? 'confirmar' : sql.includes('SET queda_suspeita_desde = NULL WHERE queda_suspeita_desde IS NOT NULL') ? 'descartarTodas'
        : sql.includes('SET queda_suspeita_desde = NULL') ? 'descartar' : sql.includes('CASE WHEN NOT isfinite') ? 'reiniciar' : sql.includes('SET queda_suspeita_desde = $3') ? 'iniciar' : `OUTRO: ${sql}`)));
    assert.deepEqual([...tipos].sort(), ['confirmar', 'descartar', 'descartarTodas', 'evento', 'iniciar', 'listar', 'reiniciar']);
    for (const { sql } of chamadas) {
      assert.equal(/ultimo_contato_em\s*=\s*(now|\$)|SET ultimo_contato_em|FOR UPDATE|credencial|RESTABELECIMENTO/i.test(sql.replace(/ultimo_contato_em\s*(<=|<|>=|>)/g, '')), false, sql);
    }
  });

  test('só as tabelas da matriz; colunas referenciadas ⊆ SELECT da matriz; alvos do SET ⊆ UPDATE da matriz; INSERT exatamente nas cinco colunas com RETURNING id', async () => {
    const chamadas = await sqlsDoJob();
    const tabelasPermitidas = Object.keys(OBJETOS_PERMITIDOS);
    for (const { sql } of chamadas) {
      const tabelas = [...sql.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_]+)/g)].map((m) => m[1]);
      for (const t of tabelas) assert.ok(tabelasPermitidas.includes(t), `${t} em ${sql}`);
      const alvo = sql.match(/^UPDATE ([a-z_]+)/)?.[1];
      if (alvo) {
        const atribuicoes = [...sql.match(/ SET (.+?) WHERE /)[1].matchAll(/(?:^|, )([a-z_]+) =/g)].map((m) => m[1]);
        assert.ok(atribuicoes.length > 0);
        for (const c of atribuicoes) assert.ok(OBJETOS_PERMITIDOS[alvo].update.includes(c), `SET ${c} fora da matriz em ${sql}`);
      }
      for (const tabela of ['token_dispositivos', 'empresas']) {
        const lidas = COLUNAS[tabela].filter((c) => new RegExp(`\\b${c}\\b`).test(tabela === 'empresas' ? sql.replace(/token_dispositivos|token_dispositivo_eventos|empresa_id|\bempresas\b/g, '') : sql.replace(/token_dispositivo_eventos|\bempresas\b/g, '')));
        for (const c of lidas) if (tabelas.includes(tabela) || tabela === 'token_dispositivos') assert.ok(OBJETOS_PERMITIDOS[tabela].select.includes(c) || (tabela === 'empresas' && !tabelas.includes('empresas')), `${tabela}.${c} fora da matriz em ${sql}`);
      }
      if (sql.startsWith('INSERT')) {
        const colunas = sql.match(/INTO token_dispositivo_eventos \((.+?)\) VALUES/)[1].split(', ');
        assert.deepEqual(colunas, [...OBJETOS_PERMITIDOS.token_dispositivo_eventos.insert]);
        assert.ok(/RETURNING id$/.test(sql));
      }
    }
  });

  test('o evento inserido pelo job é só QUEDA, sem usuário e sem duração (o RESTABELECIMENTO é da API)', async () => {
    const chamadas = await sqlsDoJob();
    const insercoes = chamadas.filter(({ sql }) => sql.startsWith('INSERT'));
    assert.equal(insercoes.length, 1);
    assert.deepEqual(insercoes[0].params, [3, 4, 'QUEDA', null, null]);
  });
});

describe('J2a Fase 4A-R2 — separação entre o job e o heartbeat da API', () => {
  const lerTudo = (dir, achados = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) lerTudo(p, achados); else if (e.name.endsWith('.js')) achados.push([path.relative(RAIZ, p), fs.readFileSync(p, 'utf8')]);
    }
    return achados;
  };
  const semComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const referencias = (regex, dir) => lerTudo(path.join(RAIZ, dir)).filter(([, texto]) => regex.test(semComentarios(texto))).map(([nome]) => nome).sort();

  test('as funções do heartbeat (registrarContato, travarParaContato, gravarContato) não são referenciadas pelo executor nem por nenhum script', () => {
    assert.deepEqual(referencias(/registrarContato|travarParaContato|gravarContato/, 'scripts'), []);
    assert.deepEqual(referencias(/travarParaContato|gravarContato/, 'src'), ['src/repositories/token-monitoramento.repository.js', 'src/services/token-monitoramento.service.js']);
    assert.deepEqual(referencias(/registrarContato/, 'src'), ['src/controllers/token-heartbeat.controller.js', 'src/services/token-monitoramento.service.js']);
  });

  test('o executor importa do serviço só verificarComunicacao e bancoIndisponivel', () => {
    const script = fs.readFileSync(path.join(RAIZ, 'scripts/verificar-comunicacao-token.js'), 'utf8');
    const importa = script.match(/const \{([^}]*)\} = require\('\.\.\/src\/services\/token-monitoramento\.service'\)/)[1].split(',').map((s) => s.trim()).sort();
    assert.deepEqual(importa, ['bancoIndisponivel', 'verificarComunicacao']);
  });

  test('listarParaVerificacao, descartarTodasAsSuspeitas e reiniciarSuspeitaExpirada: só repositório e serviço (nenhuma rota, controller, middleware, schema ou app)', () => {
    assert.deepEqual(referencias(/listarParaVerificacao|descartarTodasAsSuspeitas|reiniciarSuspeitaExpirada/, 'src'), ['src/repositories/token-monitoramento.repository.js', 'src/services/token-monitoramento.service.js']);
  });

  test('verificarComunicacao: definida no serviço e usada só pelo executor de scripts (nenhum arquivo de src a chama)', () => {
    assert.deepEqual(referencias(/verificarComunicacao/, 'src'), ['src/services/token-monitoramento.service.js']);
    assert.deepEqual(referencias(/verificarComunicacao/, 'scripts'), ['scripts/verificar-comunicacao-token.js']);
  });

  test('o executor não abre porta, não usa o pool da API nem temporizador; só roda como entrada principal; o módulo da API não o carrega', () => {
    const script = fs.readFileSync(path.join(RAIZ, 'scripts/verificar-comunicacao-token.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.equal(/\.listen\(|require\('express'\)|setInterval|setTimeout|config\/database|node-cron/.test(script), false);
    assert.ok(script.includes('require.main === module'));
    for (const arquivo of ['src/app.js', 'src/server.js']) assert.equal(/verificar-comunicacao-token|autoridade-job-interno|sonda-publica/.test(fs.readFileSync(path.join(RAIZ, arquivo), 'utf8')), false, arquivo);
  });

  test('o script npm aponta só para o executor, e o arquivo existe', () => {
    const pacote = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
    assert.equal(pacote.scripts['token:verificar-comunicacao'], 'node --require dotenv/config scripts/verificar-comunicacao-token.js');
    assert.equal(fs.existsSync(path.join(RAIZ, 'scripts/verificar-comunicacao-token.js')), true);
  });

  test('os módulos novos não carregam o pool global nem o pg ao serem importados', () => {
    for (const arquivo of ['src/security/autoridade-job-interno.js', 'src/utils/sonda-publica.js']) {
      assert.equal(/config\/database|require\('pg'\)/.test(fs.readFileSync(path.join(RAIZ, arquivo), 'utf8')), false, arquivo);
    }
    const script = fs.readFileSync(path.join(RAIZ, 'scripts/verificar-comunicacao-token.js'), 'utf8');
    assert.equal(/^const .*require\('pg'\)/m.test(script), false, 'pg só é carregado dentro da fábrica do pool');
  });
});
