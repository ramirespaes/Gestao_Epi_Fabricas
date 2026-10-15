'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Atendimento Token, Etapa J, J2a: regressão da consulta SQL_CAMINHO da autoridade do job (rodada 957fad794d3a5b36, FAIL em "testar sombreamento").
 * O schema temporário da própria sessão (pg_temp_N) não pode contar como "schema do caminho com CREATE": TEMP de PUBLIC é aceito e o controle
 * compensatório é OBJETO_TEMPORARIO. Destino: backend/test/token-j/. Variáveis opcionais (só para validar uma proposta antes da aplicação):
 * BACKEND_RAIZ (raiz do backend) e AUTORIDADE_FONTE (texto-fonte lido pelos testes estáticos; o require é redirecionado pelo preload).
 *
 * O QUE ESTE ARQUIVO PROVA (SIMULAÇÃO, sem banco, sem rede): (1) o TEXTO do SQL enviado ao banco e a matriz de privilégios; (2) a lógica de
 * avaliação nos cenários C1 a C4 e nos controles de privilégio, com um banco falso que emula UM contrato: "se o SQL traz a exclusão do schema
 * temporário da sessão, a lista de schemas não o inclui".
 * O QUE NÃO PROVA: a semântica real do PostgreSQL (current_schemas(false), has_schema_privilege no schema temporário, pg_my_temp_schema). Isso só
 * se prova em PostgreSQL real: contraprova do SQL_CAMINHO (runner e script da Fase A, evidência 12/12) e o passo "testar sombreamento" da homologação.
 */

const RAIZ = process.env.BACKEND_RAIZ || path.join(__dirname, '..', '..');
const AUTORIDADE = path.join(RAIZ, 'src', 'security', 'autoridade-job-interno.js');
const { exigirIdentidadeDoJob, OBJETOS_PERMITIDOS } = require(AUTORIDADE);
const FONTE = fs.readFileSync(process.env.AUTORIDADE_FONTE || AUTORIDADE, 'utf8');

const SQL_APROVADO = "SELECT s::text AS schema, has_schema_privilege(current_user, s, 'CREATE') AS cria FROM unnest(current_schemas(false)) AS s WHERE to_regnamespace(quote_ident(s))::oid IS DISTINCT FROM pg_my_temp_schema()";
const MATRIZ_APROVADA = {
  empresas: { select: ['id', 'ativo'], insert: [], update: [] },
  token_dispositivos: {
    select: ['id', 'empresa_id', 'ativado_em', 'revogado_em', 'ultimo_contato_em', 'comunicacao_registrada', 'queda_suspeita_desde'],
    insert: [],
    update: ['comunicacao_registrada', 'queda_suspeita_desde'],
  },
  token_dispositivo_eventos: { select: ['id'], insert: ['empresa_id', 'dispositivo_id', 'tipo', 'usuario_id', 'duracao_segundos'], update: [] },
};
const normalizar = (t) => String(t).replace(/\s+/g, ' ').trim();

describe('autoridade do job: SQL_CAMINHO (estático)', () => {
  test('o texto enviado ao banco é exatamente o aprovado na contraprova e há uma única definição', () => {
    const definicoes = [...FONTE.matchAll(/const SQL_CAMINHO = `([^`]*)`;/g)];
    assert.equal(definicoes.length, 1);
    assert.equal(normalizar(definicoes[0][1]), SQL_APROVADO);
  });

  test('continua lendo current_schemas(false) (sem os implícitos) e o privilégio CREATE do papel por schema; só o schema temporário da sessão sai', () => {
    const sql = normalizar([...FONTE.matchAll(/const SQL_CAMINHO = `([^`]*)`;/g)][0][1]);
    assert.ok(sql.includes('unnest(current_schemas(false))'));
    assert.ok(!sql.includes('current_schemas(true)'));
    assert.ok(sql.includes("has_schema_privilege(current_user, s, 'CREATE')"));
    assert.ok(sql.includes('pg_my_temp_schema()'));
    assert.ok(sql.includes('IS DISTINCT FROM'));
    assert.ok(!/\bWHERE\b.*\bpg_temp\b/i.test(sql), 'a exclusão é pelo identificador real do schema temporário da sessão, nunca por nome');
  });

  test('a matriz positiva de privilégios do job não mudou', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(OBJETOS_PERMITIDOS)), MATRIZ_APROVADA);
  });
});

// ───────── banco falso mínimo (modelo de privilégios efetivos + o contrato do SQL_CAMINHO)
const SEM_T = () => ({ t_select: false, t_insert: false, t_update: false, t_delete: false, t_truncate: false, t_references: false, t_trigger: false });
const SEM_C = () => ({ c_select: false, c_insert: false, c_update: false, c_references: false });
const COLUNAS = {
  empresas: ['id', 'nome', 'ativo'],
  token_dispositivos: ['id', 'empresa_id', 'nome', 'credencial_hash', 'ativado_em', 'revogado_em', 'ultimo_contato_em', 'comunicacao_registrada', 'queda_suspeita_desde', 'atualizado_em'],
  token_dispositivo_eventos: ['id', 'empresa_id', 'dispositivo_id', 'tipo', 'usuario_id', 'duracao_segundos', 'criado_em'],
};
const OPCOES = { papelEsperado: 'job_fict', bancoEsperado: 'ctp_teste', schemaEsperado: 'teste_job' };

/**
 * Sessão do job simulada. `legitimoCria`: CREATE no schema legítimo. `temporario`: { nome, relacoes } quando a sessão já criou o schema temporário
 * (com TEMP de PUBLIC, o papel tem CREATE nele). `resolucaoTemporaria`: nome de objeto do job que resolve para o schema temporário.
 * `ajustarColunas(colunas)`: altera os privilégios por coluna. `caminhoEnviado` registra o SQL de caminho recebido.
 */
function sessaoSimulada({ legitimoCria = false, temporario = null, resolucaoTemporaria = null, ajustarColunas = () => {} } = {}) {
  const colunas = {};
  for (const [tabela, nomes] of Object.entries(COLUNAS)) {
    colunas[tabela] = Object.fromEntries(nomes.map((c) => [c, {
      select: OBJETOS_PERMITIDOS[tabela].select.includes(c), insert: OBJETOS_PERMITIDOS[tabela].insert.includes(c), update: OBJETOS_PERMITIDOS[tabela].update.includes(c), references: false,
    }]));
  }
  ajustarColunas(colunas);
  const caminhoEnviado = [];
  const identidade = {
    papel: 'job_fict', sessao: 'job_fict', banco: 'ctp_teste', schema: 'teste_job',
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false,
    caminho_configurado: 'teste_job, pg_temp', banco_connect: true, banco_create: false, schema_usage: true,
  };
  const responder = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM pg_roles r WHERE r.rolname = current_user')) return { rows: [{ ...identidade }] };
    if (s.includes('FROM pg_roles m')) return { rows: [] };
    if (s.includes('current_schemas(false)')) {
      caminhoEnviado.push(s);
      const linhas = [{ schema: 'teste_job', cria: legitimoCria }];
      if (temporario) linhas.push({ schema: temporario.nome, cria: true });
      // CONTRATO emulado: com a exclusão do schema temporário da sessão no SQL, ele não é devolvido
      const exclui = /WHERE to_regnamespace\(quote_ident\(s\)\)::oid IS DISTINCT FROM pg_my_temp_schema\(\)/.test(s);
      return { rows: exclui && temporario ? linhas.filter((l) => l.schema !== temporario.nome) : linhas };
    }
    if (s.includes('AS existe')) return { rows: [{ existe: true }] };
    if (s.includes('AS relacoes')) return { rows: [{ relacoes: temporario ? temporario.relacoes : 0 }] };
    if (s.includes('to_regclass')) {
      return { rows: params[0].map((nome) => (nome === resolucaoTemporaria
        ? { nome, schema: temporario ? temporario.nome : 'pg_temp_9', persistencia: 't' }
        : { nome, schema: 'teste_job', persistencia: 'p' })) };
    }
    if (s.includes('has_sequence_privilege')) {
      const tabelas = [...Object.keys(COLUNAS), 'usuarios', 'token_ativacoes'].map((objeto) => ({ objeto, tipo: 'r', ...SEM_T(), ...SEM_C(), s_usage: false, s_select: false, s_update: false }));
      return { rows: [...tabelas, { objeto: 'token_dispositivo_eventos_id_seq', tipo: 'S', ...SEM_T(), ...SEM_C(), s_usage: false, s_select: false, s_update: false }] };
    }
    if (s.includes('FROM pg_attribute a')) {
      return { rows: params[0].flatMap((objeto) => Object.entries(colunas[objeto] ?? {}).map(([coluna, p]) => ({ objeto, coluna, p_select: p.select, p_insert: p.insert, p_update: p.update, p_references: p.references }))) };
    }
    if (s.includes('pg_get_serial_sequence')) return { rows: [{ sequencia: 'teste_job.token_dispositivo_eventos_id_seq' }] };
    throw new Error(`consulta inesperada no banco falso: ${s.slice(0, 80)}`);
  };
  return { query: responder, caminhoEnviado };
}
const verificar = (sessao) => exigirIdentidadeDoJob(sessao, OPCOES);
const recusa = async (sessao, codigo, campos) => {
  await assert.rejects(verificar(sessao), (erro) => {
    assert.equal(erro.name, 'ErroDoJob');
    assert.equal(erro.codigo, codigo);
    assert.deepEqual([...erro.campos], campos);
    return true;
  });
};

describe('autoridade do job: cenários C1 a C4 e controles de privilégio (SIMULAÇÃO do contrato; a semântica real é a contraprova em PostgreSQL)', () => {
  test('C4: schema legítimo sem CREATE e sem schema temporário: aceita', async () => {
    assert.deepEqual(await verificar(sessaoSimulada()), { papel: 'job_fict', schema: 'teste_job' });
  });

  test('C1: tabela temporária presente: recusa por OBJETO_TEMPORARIO (campo sessao), nunca por SCHEMA_COM_CREATE', async () => {
    await recusa(sessaoSimulada({ temporario: { nome: 'pg_temp_4', relacoes: 1 } }), 'OBJETO_TEMPORARIO', ['sessao']);
  });

  test('C2: schema temporário existente sem relação restante: o schema, isoladamente, não provoca recusa', async () => {
    assert.deepEqual(await verificar(sessaoSimulada({ temporario: { nome: 'pg_temp_4', relacoes: 0 } })), { papel: 'job_fict', schema: 'teste_job' });
  });

  test('C3: CREATE concedido no schema legítimo: continua recusando por SCHEMA_COM_CREATE, com ou sem schema temporário na sessão', async () => {
    await recusa(sessaoSimulada({ legitimoCria: true }), 'SCHEMA_COM_CREATE', ['teste_job']);
    await recusa(sessaoSimulada({ legitimoCria: true, temporario: { nome: 'pg_temp_4', relacoes: 0 } }), 'SCHEMA_COM_CREATE', ['teste_job']);
  });

  test('objeto do job resolvido para o schema temporário continua recusado por OBJETO_TEMPORARIO (nome do objeto)', async () => {
    await recusa(sessaoSimulada({ resolucaoTemporaria: 'token_dispositivos' }), 'OBJETO_TEMPORARIO', ['token_dispositivos']);
  });

  test('o SQL de caminho é enviado ao banco com a exclusão do schema temporário e é consultado uma única vez por verificação', async () => {
    const sessao = sessaoSimulada({ temporario: { nome: 'pg_temp_4', relacoes: 0 } });
    await verificar(sessao);
    assert.equal(sessao.caminhoEnviado.length, 1);
    assert.equal(sessao.caminhoEnviado[0], SQL_APROVADO);
  });

  test('controles de privilégio preservados: excedente, faltando e restaurado', async () => {
    await recusa(sessaoSimulada({ ajustarColunas: (c) => { c.empresas.ativo.update = true; } }), 'PRIVILEGIO_EXCEDENTE', ['empresas.ativo:UPDATE']);
    await recusa(sessaoSimulada({ ajustarColunas: (c) => { c.token_dispositivo_eventos.id.select = false; } }), 'PRIVILEGIO_FALTANDO', ['token_dispositivo_eventos.id:SELECT']);
    assert.deepEqual(await verificar(sessaoSimulada()), { papel: 'job_fict', schema: 'teste_job' });
  });
});
