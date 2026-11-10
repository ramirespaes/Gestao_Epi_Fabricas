'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const H = require('../integracao/helpers/backup-ensaio-instancia-local');

/**
 * Helper da C-1 (B-1 → pacote L2 → cifra P11 → recuperação P12) [C1-AMB]: guarda de ambiente, nomes controlados, modelo SQL do papel e configurações da composição.
 * Tudo PURO: nenhum PostgreSQL, nenhuma conexão, nenhum processo e nenhuma leitura do ambiente global (o `env` chega por parâmetro).
 */

const PGDATA = '/private/tmp/swb-20261110120000-1/pgdata';
const ambiente = (alteracoes = {}) => {
  const env = {
    SWB_C1: '1', SWB_PGDATA: PGDATA, SWB_PORT: '55471', DB_PORT: '55471', DB_HOST: '/private/tmp/swb-20261110120000-1/sock', DB_USER: 'swb_teste', DB_NAME: 'gestao_epi_teste_local', NODE_ENV: 'test',
  };
  for (const [k, v] of Object.entries(alteracoes)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
};
const MODELO = path.join(__dirname, '..', '..', 'ops', 'sql', 'papel-executor-backup.sql.modelo');
const semComentarios = (texto) => texto.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('[C1-AMB] guarda de ambiente da C-1', () => {
  test('C1-AMB-01 — o ambiente completo e correto é aceito (nenhum motivo de recusa)', () => {
    assert.equal(H.motivoDeRecusaDoAmbiente(ambiente()), null);
  });

  test('C1-AMB-02 — cada desvio é recusado com o seu próprio motivo e na ordem das regras', () => {
    const casos = [
      [{ SWB_C1: undefined }, /SWB_C1/], [{ SWB_C1: '0' }, /SWB_C1/], [{ SWB_C1: 'true' }, /SWB_C1/],
      [{ SWB_PGDATA: undefined }, /SWB_PGDATA/], [{ SWB_PGDATA: '/tmp/swb-20261110120000-1/pgdata' }, /SWB_PGDATA/], [{ SWB_PGDATA: `${PGDATA}/../x` }, /SWB_PGDATA/],
      [{ SWB_PORT: undefined }, /SWB_PORT/], [{ SWB_PORT: '55x71' }, /SWB_PORT/], [{ SWB_PORT: '123' }, /SWB_PORT/],
      [{ SWB_PORT: '5432', DB_PORT: '5432' }, /porta protegida/], [{ SWB_PORT: '55460', DB_PORT: '55460' }, /porta protegida/], [{ SWB_PORT: '1023', DB_PORT: '1023' }, /porta protegida|SWB_PORT/],
      [{ DB_PORT: '55472' }, /DB_PORT/], [{ DB_HOST: 'localhost' }, /DB_HOST/], [{ DB_HOST: '/private/tmp/swb-20261110120000-2/sock' }, /DB_HOST/],
      [{ DB_USER: 'postgres' }, /DB_USER/], [{ DB_NAME: 'gestao_epi' }, /DB_NAME/], [{ NODE_ENV: 'production' }, /NODE_ENV/], [{ NODE_ENV: undefined }, /NODE_ENV/],
    ];
    for (const [alteracao, esperado] of casos) assert.match(H.motivoDeRecusaDoAmbiente(ambiente(alteracao)), esperado, JSON.stringify(alteracao));
  });

  test('C1-AMB-03 — as variáveis do cliente PostgreSQL que redirecionariam a conexão são recusadas, todas', () => {
    for (const v of ['PGHOST', 'PGPORT', 'PGSERVICE', 'PGSERVICEFILE', 'PGDATABASE', 'PGSSLMODE']) assert.equal(H.motivoDeRecusaDoAmbiente(ambiente({ [v]: 'x' })), `${v} definida`);
  });

  test('C1-AMB-04 — a decisão depende só do parâmetro: sem opt-in no `env` recebido, a recusa vale ainda que o processo tenha SWB_C1=1', () => {
    const antes = process.env.SWB_C1;
    process.env.SWB_C1 = '1';
    try { assert.match(H.motivoDeRecusaDoAmbiente({}), /SWB_C1/); } finally { if (antes === undefined) delete process.env.SWB_C1; else process.env.SWB_C1 = antes; }
  });
});

describe('[C1-NOM] nomes de banco controlados', () => {
  test('C1-NOM-01 — só nomes gepi_c1_{origem,rest}_<12 hex>, nunca os protegidos nem os dos outros ensaios', () => {
    assert.equal(H.nomeDeBancoValido('gepi_c1_origem_0123456789ab'), true);
    assert.equal(H.nomeDeBancoValido('gepi_c1_rest_0123456789ab'), true);
    for (const n of [undefined, null, 42, '', 'postgres', 'template0', 'template1', 'gestao_epi', 'gestao_epi_teste_local', 'homolog_local', 'gepi_b3_origem_0123456789ab', 'gepi_h9h_origem_0123456789ab',
      'gepi_c1_origem_0123456789AB', 'gepi_c1_origem_0123456789a', 'gepi_c1_origem_0123456789abc', 'gepi_c1_outro_0123456789ab', 'x gepi_c1_origem_0123456789ab', 'gepi_c1_origem_0123456789ab; DROP DATABASE x']) {
      assert.equal(H.nomeDeBancoValido(n), false, String(n));
    }
  });

  test('C1-NOM-02 — novoNomeDeBanco gera nomes válidos e distintos e recusa tipo desconhecido', () => {
    const nomes = new Set();
    for (let i = 0; i < 20; i += 1) { const n = H.novoNomeDeBanco(i % 2 === 0 ? 'origem' : 'restaurado'); assert.equal(H.nomeDeBancoValido(n), true, n); nomes.add(n); }
    assert.equal(nomes.size, 20);
    assert.match(H.novoNomeDeBanco('origem'), /^gepi_c1_origem_[0-9a-f]{12}$/);
    assert.match(H.novoNomeDeBanco('restaurado'), /^gepi_c1_rest_[0-9a-f]{12}$/);
    for (const t of ['outro', '', undefined, 'constructor', '__proto__']) assert.throws(() => H.novoNomeDeBanco(t), /tipo de banco/);
  });

  test('C1-NOM-03 — as listas de bancos base e protegidos são congeladas e o banco de teste e o de produção estão protegidos', () => {
    assert.deepEqual([...H.BANCOS_BASE], ['gestao_epi_teste_local', 'postgres', 'template0', 'template1']);
    for (const n of ['gestao_epi_teste_local', 'postgres', 'template0', 'template1', 'gestao_epi', 'homolog_local']) assert.ok(H.PROTEGIDOS.includes(n), n);
    assert.ok(Object.isFrozen(H.BANCOS_BASE) && Object.isFrozen(H.PROTEGIDOS) && Object.isFrozen(H.GRANTS_B1) && Object.isFrozen(H.PORTAS_PROTEGIDAS));
    assert.deepEqual([...H.PORTAS_PROTEGIDAS], [5432, 55460]);
  });
});

describe('[C1-SQL] papel mínimo B-1 pelo modelo do repositório', () => {
  test('C1-SQL-01 — o modelo vira comandos sem comentários, com o banco trocado, e a transação inteira preservada', () => {
    const comandos = H.comandosDoModelo(fs.readFileSync(MODELO, 'utf8'), 'gepi_c1_origem_0123456789ab');
    assert.equal(comandos[0], 'BEGIN');
    assert.equal(comandos.at(-1), 'COMMIT');
    assert.ok(comandos.some((c) => /^CREATE ROLE safework_backup_executor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/.test(c)));
    assert.ok(comandos.includes('GRANT CONNECT ON DATABASE gepi_c1_origem_0123456789ab TO safework_backup_executor'));
    for (const c of comandos) { assert.ok(!c.includes('A_PREENCHER'), c); assert.ok(!c.startsWith('--'), c); assert.ok(!c.includes(';'), c); }
  });

  test('C1-SQL-02 — nome de banco fora do padrão é recusado ANTES de qualquer substituição (nada de SQL montado com nome livre)', () => {
    const texto = fs.readFileSync(MODELO, 'utf8');
    for (const n of ['postgres', 'gestao_epi_teste_local', 'x; DROP DATABASE y', undefined, '']) assert.throws(() => H.comandosDoModelo(texto, n), /nome de banco/, String(n));
  });

  test('C1-SQL-03 — o texto sem o marcador substituível não passa: o modelo só funciona com o banco declarado', () => {
    assert.throws(() => H.comandosDoModelo('BEGIN;\nCREATE ROLE safework_backup_executor LOGIN;\nCOMMIT;\n', 'gepi_c1_origem_0123456789ab'), /marcador/);
  });

  test('C1-SQL-04 — as concessões B-1 são exatamente as três de leitura, só para o papel, e a verificação não lista o que o papel já lê', () => {
    assert.deepEqual([...H.GRANTS_B1], [
      'GRANT USAGE ON SCHEMA public TO safework_backup_executor',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO safework_backup_executor',
      'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO safework_backup_executor',
    ]);
    assert.equal(H.PAPEL_B1, 'safework_backup_executor');
    assert.match(H.VERIFICACAO_B1, /NOT has_table_privilege\('safework_backup_executor', c\.oid, 'SELECT'\)/);
    assert.match(H.VERIFICACAO_B1, /c\.relkind IN \('r', 'p', 'm', 'S'\)/);
  });
});

describe('[C1-CFG] configurações da composição de produção', () => {
  const contexto = () => ({
    binarios: { dump: '/x/pg_dump', restore: '/x/pg_restore' }, host: '/private/tmp/swb-20261110120000-1/sock', porta: 55471, usuario: 'swb_teste', arquivoDeSenha: '/a/seg/pgpass',
    nomeOrigem: 'gepi_c1_origem_0123456789ab', oidOrigem: '16400', criarConexao: () => null, criarConexaoDoBanco: () => null,
    area: '/a', dirs: { imagens: '/a/imagens', preparacoes: '/a/preparacoes', dumps: '/a/dumps', publicados: '/a/publicados' }, fonteDeChaves: { origem: 'TESTE_CONTROLADO' }, chaveId: 'chave-c1',
  });

  test('C1-CFG-01 — o backup usa o PAPEL B-1 no pg_dump, layout 2, só a fonte imagens, chaves e relatório de TESTE_CONTROLADO e limites finitos', () => {
    const c = H.montarConfigDoBackup(contexto());
    assert.equal(c.postgres.usuario, 'safework_backup_executor');
    assert.deepEqual({ ...c.postgres.banco }, { nome: 'gepi_c1_origem_0123456789ab', oid: '16400' });
    assert.equal(c.layoutDoManifesto, 2);
    assert.deepEqual(c.fontes, ['imagens']);
    assert.deepEqual(c.chaves, { fonteDeChaves: { origem: 'TESTE_CONTROLADO' }, chaveId: 'chave-c1' });
    assert.deepEqual(c.relatorio.origensAceitas, ['TESTE_CONTROLADO']);
    assert.deepEqual({ ...c.armazenamento }, { imagens: '/a/imagens', preparacoes: '/a/preparacoes', dumps: '/a/dumps', publicados: '/a/publicados' });
    assert.ok(c.limites.totalBytes > 0 && c.limites.totalBytes <= 512 * 1024 * 1024 && c.limites.maxBytesDoDump <= c.limites.totalBytes);
    assert.equal(typeof c.conexao.criarConexao, 'function');
    assert.equal(typeof c.janela.adquirir, 'function');
  });

  test('C1-CFG-02 — a restauração usa o usuário administrador de teste (decisão D2), prefixo e host da política e a mesma fonte de chaves', () => {
    const c = H.montarConfigDaRestauracao(contexto());
    assert.deepEqual({ ...c.postgres }, { pgRestore: '/x/pg_restore' });
    assert.equal(c.politicaDeDestino.prefixoDoBanco, 'gepi_c1_rest_');
    assert.deepEqual(c.politicaDeDestino.hostsAutorizados, ['/private/tmp/swb-20261110120000-1/sock']);
    assert.deepEqual([...c.politicaDeDestino.bancosProtegidos].sort((a, b) => a.localeCompare(b)), [...H.PROTEGIDOS].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(c.fonteDeChaves, { origem: 'TESTE_CONTROLADO' });
    assert.equal(typeof c.criarConexaoDoBanco, 'function');
  });

  test('C1-CFG-03 — o pedido de restauração aponta a raiz da decifra e o nome do pacote; destino novo, layout mínimo 2 e limite por arquivo', () => {
    const p = H.pedidoDeRestauracao({ ...contexto(), raizDecifrada: '/a/decifrado', nomeDoPacote: 'prep-c1-aaaa', nomeRestaurado: 'gepi_c1_rest_0123456789ab', dirs: { ...contexto().dirs, restauradoImagens: '/a/rest-img' } }, 'img-1234abcd');
    assert.equal(p.raizAutorizada, '/a/decifrado');
    assert.equal(p.nome, 'prep-c1-aaaa');
    assert.deepEqual({ ...p.imagens }, { raiz: '/a/rest-img', nome: 'img-1234abcd' });
    assert.deepEqual({ ...p.destino }, { banco: 'gepi_c1_rest_0123456789ab', host: '/private/tmp/swb-20261110120000-1/sock', porta: 55471, usuario: 'swb_teste', arquivoDeSenha: '/a/seg/pgpass' });
    assert.equal(p.layoutMinimo, 2);
    assert.ok(Number.isSafeInteger(p.maxBytesPorArquivo) && p.maxBytesPorArquivo > 0);
  });
});

describe('[C1-EST] propriedades estáticas do helper', () => {
  const codigo = semComentarios(fs.readFileSync(path.join(__dirname, '..', 'integracao', 'helpers', 'backup-ensaio-instancia-local.js'), 'utf8'));

  test('C1-EST-01 — o helper não lê o ambiente global, não abre conexão e não cria processo nem escreve em disco', () => {
    assert.ok(!/process\.env/.test(codigo), 'process.env');
    assert.ok(!/require\('pg'\)|new Client|new Pool/.test(codigo), 'conexão PostgreSQL');
    assert.ok(!/child_process|execFile|spawn|\bexec\(/.test(codigo), 'processo');
    assert.ok(!/node:fs|writeFile|mkdir|rmSync|unlink|rename/.test(codigo), 'sistema de arquivos');
    assert.ok(!/aws-sdk|fetch\(|https?:\/\//.test(codigo), 'rede');
  });

  test('C1-EST-02 — nenhuma lista de provedores de produção é tocada: o helper só usa fontes e chaves recebidas por parâmetro', () => {
    assert.ok(!/PROVEDORES_(DE_CIFRA|OPERACIONAIS|DE_MAC)_APROVADOS/.test(codigo));
    assert.ok(!/criarFonteOperacionalDeCifra|criarFonteDeChavesDeCifra|criarFonteDeChaves\(/.test(codigo));
  });
});
