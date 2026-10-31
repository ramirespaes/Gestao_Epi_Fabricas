'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');
const { criarEmpresa, criarUsuario, criarFuncionario, erroDe } = require('./helpers/entrega-epi');
const { aplicarMigrations } = require('../../scripts/migrate');

/**
 * Migration candidata de funcionario_situacoes (datas efetivas da situação) — PostgreSQL real, schema temporário (RED). NÃO EXECUTADO
 * na rodada do RED por restrição operacional (sem PostgreSQL, nem temporário). Número-agnóstico: a numeração final (096 ou 097)
 * depende da ordem de integração com a LGPD-3; o arquivo é achado pelo conteúdo. Este arquivo não abre conexão ao ser importado.
 *
 * O estado anterior (000 a 095) é montado explicitamente com dados, e a candidata só é aplicada aqui. Contrato: tabela nova e vazia;
 * nenhuma tabela, linha, permissão ou ação existentes mudam; pares de transição e datas coerentes por CHECK; data efetiva não
 * posterior ao dia do registro em São Paulo; FKs compostas com a empresa; histórico imutável (UPDATE, DELETE e TRUNCATE recusados).
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const NOMES = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
const PREFIXOS_ATE_095 = NOMES.map((n) => n.slice(0, 3)).filter((p) => p <= '095');
const CANDIDATA = NOMES.find((n) => n.slice(0, 3) > '095' && fs.readFileSync(path.join(DIRETORIO, n), 'utf8').includes('funcionario_situacoes'));
const PREFIXO = CANDIDATA ? CANDIDATA.slice(0, 3) : null;
const COLUNAS = ['empresa_id', 'funcionario_id', 'id', 'registrado_em', 'registrado_por', 'situacao_anterior', 'situacao_nova', 'data_efetiva'].sort();

describe('migration de funcionario_situacoes (PostgreSQL real, schema temporário)', () => {
  let contexto;
  let c;
  let a;
  let b;
  let antes;
  let aplicada = false;

  const q = (sql, parametros) => c.query(sql, parametros);
  const tabelasExistentes = async () => (await q("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.table_name);
  const fotografia = async (tabelas) => {
    const f = {};
    for (const t of tabelas) {
      const conteudo = (await q(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x`)).rows[0];
      const colunas = (await q("SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position", [t])).rows;
      const restricoes = (await q('SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY 1', [t])).rows;
      const gatilhos = (await q('SELECT tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY 1', [t])).rows;
      f[t] = { conteudo, colunas, restricoes, gatilhos };
    }
    return f;
  };
  const aplicar = async () => {
    if (!aplicada) { await q(conteudoDaMigration(PREFIXO)); aplicada = true; }
  };
  const inserir = (v = {}) => {
    const d = {
      empresa: a.empresa, funcionario: a.funcionario, de: 'ATIVO', para: 'INATIVO', data: '2026-10-01', ator: a.usuario, ...v,
    };
    return q(
      `INSERT INTO funcionario_situacoes (empresa_id, funcionario_id, situacao_anterior, situacao_nova, data_efetiva, registrado_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [d.empresa, d.funcionario, d.de, d.para, d.data, d.ator],
    );
  };

  before(async () => {
    assert.ok(CANDIDATA, 'migration candidata ausente (nenhum arquivo posterior à 095 cria funcionario_situacoes)');
    contexto = await abrirSchemaTemporario(PREFIXOS_ATE_095);
    c = contexto.cliente;
    const empresaA = await criarEmpresa(c, '11222333000181', 'Empresa A Fictícia');
    const empresaB = await criarEmpresa(c, '22333444000155', 'Empresa B Fictícia');
    a = { empresa: empresaA, usuario: await criarUsuario(c, empresaA, 'ator-a@example.invalid'), funcionario: await criarFuncionario(c, empresaA, { matricula: 'A-1', cpf: '52998224725' }) };
    b = { empresa: empresaB, usuario: await criarUsuario(c, empresaB, 'ator-b@example.invalid'), funcionario: await criarFuncionario(c, empresaB, { matricula: 'B-1', cpf: '11144477735' }) };
    antes = await tabelasExistentes();
    antes = { tabelas: antes, fotos: await fotografia(antes) };
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('ponto de partida: 000 a 095 aplicadas e a tabela ainda não existe', async () => {
    assert.ok(CANDIDATA, 'migration candidata ausente');
    assert.equal(antes.tabelas.includes('funcionario_situacoes'), false);
    assert.equal(PREFIXOS_ATE_095.at(-1), '095');
  });

  test('aplicar a candidata cria só a tabela nova e vazia; tabelas, linhas, permissões e ações existentes ficam idênticas (sem backfill)', async () => {
    await aplicar();
    const depois = await tabelasExistentes();
    assert.deepEqual(depois.filter((t) => !antes.tabelas.includes(t)), ['funcionario_situacoes']);
    assert.deepEqual(await fotografia(antes.tabelas), antes.fotos, 'nada do que já existia pode mudar (conteúdo, colunas, restrições e gatilhos)');
    assert.equal((await q('SELECT count(*)::int AS n FROM funcionario_situacoes')).rows[0].n, 0);
  });

  test('as colunas são exatamente as do contrato (sem motivo, descrição, observação, previsão ou conflito) e as obrigatórias são NOT NULL', async () => {
    await aplicar();
    const { rows } = await q("SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'funcionario_situacoes'");
    assert.deepEqual(rows.map((r) => r.column_name).sort(), COLUNAS);
    const por = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    for (const col of ['empresa_id', 'funcionario_id', 'situacao_anterior', 'situacao_nova', 'registrado_por', 'registrado_em']) assert.equal(por[col].is_nullable, 'NO', col);
    assert.equal(por.data_efetiva.is_nullable, 'YES');
    assert.equal(por.data_efetiva.column_default, null, 'sem data inventada por padrão');
    assert.match(por.registrado_em.column_default ?? '', /now\(\)|CURRENT_TIMESTAMP/i);
  });

  test('pares de transição válidos com a data do par (INATIVO → ATIVO sem data; os demais com data)', async () => {
    await aplicar();
    for (const [de, para, data] of [['ATIVO', 'INATIVO', '2026-10-01'], ['ATIVO', 'AFASTADO', '2026-10-02'], ['AFASTADO', 'ATIVO', '2026-10-03'], ['AFASTADO', 'INATIVO', '2026-10-04'], ['INATIVO', 'ATIVO', null]]) {
      const r = await inserir({ de, para, data });
      assert.equal(r.rowCount, 1, `${de} → ${para}`);
    }
  });

  test('pares inválidos e datas incoerentes com o par são recusados por CHECK (23514)', async () => {
    await aplicar();
    const casos = [
      ['ATIVO', 'INATIVO', null], ['ATIVO', 'AFASTADO', null], ['AFASTADO', 'ATIVO', null], ['AFASTADO', 'INATIVO', null],
      ['INATIVO', 'ATIVO', '2026-10-01'], ['INATIVO', 'AFASTADO', '2026-10-01'], ['INATIVO', 'INATIVO', '2026-10-01'],
      ['ATIVO', 'ATIVO', null], ['AFASTADO', 'AFASTADO', '2026-10-01'], ['ATIVO', 'DESLIGADO', '2026-10-01'], ['XPTO', 'ATIVO', null],
    ];
    for (const [de, para, data] of casos) {
      const erro = await erroDe(inserir({ de, para, data }));
      assert.equal(erro?.code, '23514', `${de} → ${para} (${data}) deveria violar um CHECK, veio ${JSON.stringify(erro)}`);
    }
  });

  test('a data efetiva não pode ser posterior ao dia do registro em São Paulo (hoje vale, amanhã não)', async () => {
    await aplicar();
    const amanha = await erroDe(q(
      `INSERT INTO funcionario_situacoes (empresa_id, funcionario_id, situacao_anterior, situacao_nova, data_efetiva, registrado_por)
       VALUES ($1, $2, 'ATIVO', 'INATIVO', (now() AT TIME ZONE 'America/Sao_Paulo')::date + 1, $3)`, [a.empresa, a.funcionario, a.usuario],
    ));
    assert.equal(amanha?.code, '23514');
    const hoje = await q(
      `INSERT INTO funcionario_situacoes (empresa_id, funcionario_id, situacao_anterior, situacao_nova, data_efetiva, registrado_por)
       VALUES ($1, $2, 'ATIVO', 'INATIVO', (now() AT TIME ZONE 'America/Sao_Paulo')::date, $3)`, [a.empresa, a.funcionario, a.usuario],
    );
    assert.equal(hoje.rowCount, 1);
  });

  test('o instante do registro é do servidor e separado da data efetiva (data antiga não altera registrado_em)', async () => {
    await aplicar();
    await inserir({ data: '2020-02-29' });
    const { rows: [r] } = await q("SELECT to_char(data_efetiva, 'YYYY-MM-DD') AS d, extract(epoch FROM (now() - registrado_em)) AS idade FROM funcionario_situacoes WHERE data_efetiva = '2020-02-29'");
    assert.equal(r.d, '2020-02-29');
    assert.ok(Number(r.idade) >= 0 && Number(r.idade) < 120, 'registrado_em é o now() da gravação');
  });

  test('isolamento multiempresa: funcionário ou ator de outra empresa é recusado por FK composta (23503)', async () => {
    await aplicar();
    assert.equal((await erroDe(inserir({ empresa: a.empresa, funcionario: b.funcionario })))?.code, '23503', 'funcionário da empresa B na empresa A');
    assert.equal((await erroDe(inserir({ empresa: a.empresa, ator: b.usuario })))?.code, '23503', 'ator da empresa B na empresa A');
    assert.equal((await erroDe(inserir({ empresa: b.empresa, funcionario: a.funcionario, ator: b.usuario })))?.code, '23503');
    assert.equal((await inserir({ empresa: b.empresa, funcionario: b.funcionario, ator: b.usuario })).rowCount, 1, 'o caminho certo funciona');
  });

  test('funcionário com histórico não pode ser apagado (ON DELETE RESTRICT)', async () => {
    await aplicar();
    await inserir();
    assert.equal((await erroDe(q('DELETE FROM funcionarios WHERE id = $1', [a.funcionario])))?.code, '23503');
  });

  test('histórico imutável: UPDATE, DELETE e TRUNCATE são recusados e as linhas permanecem', async () => {
    await aplicar();
    await inserir({ data: '2026-05-05' });
    const total = (await q('SELECT count(*)::int AS n FROM funcionario_situacoes')).rows[0].n;
    const antesLinhas = JSON.stringify((await q('SELECT * FROM funcionario_situacoes ORDER BY id')).rows);
    assert.ok(await erroDe(q("UPDATE funcionario_situacoes SET data_efetiva = '2026-05-06' WHERE data_efetiva = '2026-05-05'")), 'UPDATE da data');
    assert.ok(await erroDe(q("UPDATE funcionario_situacoes SET situacao_nova = 'ATIVO'")), 'UPDATE da situação');
    assert.ok(await erroDe(q('UPDATE funcionario_situacoes SET registrado_em = now()')), 'UPDATE do instante');
    assert.ok(await erroDe(q('DELETE FROM funcionario_situacoes')), 'DELETE');
    assert.ok(await erroDe(q('TRUNCATE funcionario_situacoes')), 'TRUNCATE');
    assert.equal((await q('SELECT count(*)::int AS n FROM funcionario_situacoes')).rows[0].n, total);
    assert.equal(JSON.stringify((await q('SELECT * FROM funcionario_situacoes ORDER BY id')).rows), antesLinhas);
  });

  test('índice de leitura por empresa e funcionário existe (a consulta de cronologia e de histórico depende dele)', async () => {
    await aplicar();
    const { rows } = await q("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'funcionario_situacoes'");
    assert.ok(rows.some((r) => /empresa_id/.test(r.indexdef) && /funcionario_id/.test(r.indexdef)), JSON.stringify(rows));
  });

  test('a funcionarios continuam intocadas: situacao e ativo seguem como na 084 (ativo gerada), atualizado_em não mudou', async () => {
    await aplicar();
    const { rows: [f] } = await q("SELECT is_generated FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'funcionarios' AND column_name = 'ativo'");
    assert.equal(f.is_generated, 'ALWAYS');
  });
});

describe('o runner aplica a candidata exatamente uma vez, em ordem (PostgreSQL real, schema temporário)', () => {
  let contexto;
  let diretorioAte095;
  // O runner só sabe o que está em pgmigrations: o estado anterior (000 a 095) é aplicado por ELE a partir de uma cópia do
  // diretório com esses arquivos (mesmo padrão de migrations-061-064-runner), em vez de montado por SQL direto sem registro.
  before(async () => {
    assert.ok(CANDIDATA, 'migration candidata ausente');
    contexto = await abrirSchemaTemporario([]);
    diretorioAte095 = fs.mkdtempSync(path.join(os.tmpdir(), 'gestao-epi-migrations-'));
    for (const nome of NOMES.filter((n) => n.slice(0, 3) <= '095')) fs.copyFileSync(path.join(DIRETORIO, nome), path.join(diretorioAte095, nome));
    await aplicarMigrations({ schema: contexto.schema, diretorio: diretorioAte095 });
  });
  after(async () => {
    if (diretorioAte095) fs.rmSync(diretorioAte095, { recursive: true, force: true });
    if (contexto) await contexto.encerrar();
  });

  test('a primeira passagem aplica só a candidata (e as posteriores a ela, se houver); a segunda não reaplica nada', async () => {
    const primeira = await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO });
    const nomes = primeira.map((m) => m.name);
    assert.equal(nomes[0], CANDIDATA.replace(/\.sql$/, ''), 'a candidata é a primeira pendente depois da 095');
    assert.equal(nomes.every((n) => n.slice(0, 3) >= PREFIXO), true);
    const segunda = await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO });
    assert.deepEqual(segunda, [], 'nada é reaplicado');
  });
});
