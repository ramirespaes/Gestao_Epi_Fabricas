'use strict';
// Sonda somente leitura do estado das migrations. Estes testes não usam o driver pg nem banco real: o cliente é um
// dublê. O último bloco usa o inspecionarMigrations real e só roda onde as dependências do backend estão instaladas.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ARQ = path.join(__dirname, '..', '..', 'scripts', 'sonda-estado-observado.js');
const S = require(ARQ);

const CREDENCIAL = { host: '127.0.0.1', porta: 5432, banco: 'safework_hml', usuario: 'sonda_leitura', senha: 'segredo-da-sonda' };
const CONF = S.validarCredencial(CREDENCIAL);
const SISTEMA = '7412345678901234567';
const LIMITES = { conexaoMs: 200, consultaMs: 200, execucaoMs: 400 };

// Cliente falso com o mesmo uso do pg.Client: connect, query(texto, valores) e end.
function clienteFalso({ banco = 'safework_hml', somenteLeitura = 'on', emRecuperacao = false, sistema = SISTEMA, controle = true, nomes = ['000_a', '001_b'], falhaAoConectar, falhaNaConsulta, falhaNaIdentidade, travarConexao, travarConsulta } = {}) {
  const uso = { configs: [], consultas: [], encerrou: 0 };
  class Client {
    constructor(config) { uso.configs.push(config); }
    async connect() {
      if (travarConexao) await new Promise(() => {});
      if (falhaAoConectar) throw new Error('password authentication failed for user "sonda_leitura" segredo-da-sonda');
    }
    async query(texto, valores) {
      uso.consultas.push(texto);
      if (travarConsulta) await new Promise(() => {});
      if (/current_database\(\)/.test(texto)) {
        if (falhaNaIdentidade) throw new Error('permission denied for function pg_control_system');
        return { rows: [{ banco, papel: 'sonda_leitura', somente_leitura: somenteLeitura, em_recuperacao: emRecuperacao, sistema }] };
      }
      if (falhaNaConsulta) throw new Error('relation does not exist segredo-da-sonda');
      if (/to_regclass/.test(texto)) { assert.deepEqual(valores, ['public.pgmigrations']); return { rows: [{ existe: controle }] }; }
      if (/pg_tables/.test(texto)) return { rows: [{ total: 3 }] };
      if (/FROM "public"\."pgmigrations"/.test(texto)) return { rows: nomes.map((name) => ({ name })) };
      throw new Error(`consulta inesperada: ${texto}`);
    }
    async end() { uso.encerrou += 1; }
  }
  return { Client, uso };
}
// Dublê com o mesmo protocolo de inspecionarMigrations (scripts/migrate.js): usa a fábrica recebida e encerra a conexão.
async function inspecionarDuble({ schema, diretorio, criarCliente }) {
  assert.equal(typeof diretorio, 'string');
  const arquivos = ['000_a', '001_b', '002_c'];
  const cliente = criarCliente();
  await cliente.connect();
  try {
    const controleExiste = (await cliente.query('SELECT to_regclass($1) IS NOT NULL AS existe', [`${schema}.pgmigrations`])).rows[0].existe;
    await cliente.query('SELECT count(*)::int AS total FROM pg_tables WHERE schemaname = $1 AND tablename <> $2', [schema, 'pgmigrations']);
    const registradas = controleExiste ? (await cliente.query(`SELECT name FROM "${schema}"."pgmigrations" ORDER BY id`)).rows.map((l) => l.name) : [];
    return { controleExiste, schemaTemObjetos: true, aplicadas: registradas.filter((n) => arquivos.includes(n)), semArquivo: registradas.filter((n) => !arquivos.includes(n)), pendentes: arquivos.filter((n) => !registradas.includes(n)) };
  } finally { await cliente.end(); }
}
const observar = (falso, extra = {}) => S.observar({ conf: CONF, Client: falso.Client, inspecionar: inspecionarDuble, diretorio: '/release/migrations', limites: LIMITES, ...extra });
const codigoDe = async (promessa) => { try { await promessa; return 'SEM_ERRO'; } catch (e) { return e.codigo || `sem código: ${e.message}`; } };

describe('sonda: sucesso', () => {
  test('devolve banco, papel, identificador do cluster e as migrations registradas, inclusive as que o código instalado não tem', async () => {
    const falso = clienteFalso({ nomes: ['000_a', '001_b', '099_do_futuro'] });
    const r = await observar(falso);
    assert.deepEqual(r, { banco: 'safework_hml', papel: 'sonda_leitura', schema: 'public', sistema: SISTEMA, migrations: ['000_a', '001_b', '099_do_futuro'] });
    assert.equal(falso.uso.encerrou, 1);
  });

  test('a identidade (banco, cluster, primário, somente leitura) é consultada na MESMA sessão das migrations: uma única conexão', async () => {
    const falso = clienteFalso();
    await observar(falso);
    assert.equal(falso.uso.configs.length, 1);
    assert.match(falso.uso.consultas[0], /current_database\(\)/);
    assert.match(falso.uso.consultas[0], /pg_control_system\(\)/);
    assert.match(falso.uso.consultas[0], /pg_is_in_recovery\(\)/);
    assert.equal(falso.uso.consultas.length, 4);
  });

  test('usa só a credencial recebida, com limites e sessão somente leitura, e ignora as variáveis de ambiente', async () => {
    const antes = { ...process.env };
    Object.assign(process.env, { DB_USER: 'app', DB_PASSWORD: 'senha-da-aplicacao', DB_NAME: 'outro', SONDA_DB_PASSWORD: 'senha-no-ambiente', PGPASSWORD: 'senha-pg' });
    try {
      const falso = clienteFalso();
      await observar(falso);
      const c = falso.uso.configs[0];
      assert.equal(c.user, 'sonda_leitura');
      assert.equal(c.password, 'segredo-da-sonda');
      assert.equal(c.database, 'safework_hml');
      assert.equal(c.connectionTimeoutMillis, LIMITES.conexaoMs);
      assert.equal(c.query_timeout, LIMITES.consultaMs);
      assert.equal(c.statement_timeout, LIMITES.consultaMs);
      assert.match(c.options, /default_transaction_read_only=on/);
      assert.doesNotMatch(JSON.stringify(c), /senha-da-aplicacao|senha-no-ambiente|senha-pg/);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in antes)) delete process.env[k];
      Object.assign(process.env, antes);
    }
  });
});

describe('sonda: falha fechada', () => {
  test('erro de conexão', async () => assert.equal(await codigoDe(observar(clienteFalso({ falhaAoConectar: true }))), 'SONDA_CONEXAO'));
  test('erro de consulta', async () => assert.equal(await codigoDe(observar(clienteFalso({ falhaNaConsulta: true }))), 'SONDA_CONSULTA'));
  test('conexão que não responde: timeout de execução', async () => assert.equal(await codigoDe(observar(clienteFalso({ travarConexao: true }))), 'SONDA_TIMEOUT'));
  test('consulta que não responde: timeout de execução', async () => assert.equal(await codigoDe(observar(clienteFalso({ travarConsulta: true }))), 'SONDA_TIMEOUT'));
  test('banco diferente do da credencial', async () => assert.equal(await codigoDe(observar(clienteFalso({ banco: 'homolog_local' }))), 'SONDA_BANCO_DIVERGENTE'));
  test('sessão que não é somente leitura', async () => assert.equal(await codigoDe(observar(clienteFalso({ somenteLeitura: 'off' }))), 'SONDA_SESSAO_COM_ESCRITA'));
  test('servidor em recuperação (réplica) não serve de fonte do estado', async () => assert.equal(await codigoDe(observar(clienteFalso({ emRecuperacao: true }))), 'SONDA_SERVIDOR_EM_RECUPERACAO'));
  test('identificador do cluster ausente, vazio ou fora do formato: identidade não comprovada', async () => {
    for (const sistema of [null, '', 'abc', '12 34', 123, '0']) {
      const falso = clienteFalso({ sistema });
      assert.equal(await codigoDe(observar(falso)), 'SONDA_IDENTIDADE_NAO_COMPROVADA', String(sistema));
      assert.equal(falso.uso.encerrou, 1, 'a conexão é encerrada');
    }
  });
  test('sem permissão para a consulta de identidade: recusa, sem tentar outra forma', async () => {
    const falso = clienteFalso({ falhaNaIdentidade: true });
    assert.equal(await codigoDe(observar(falso)), 'SONDA_CONSULTA');
    assert.equal(falso.uso.consultas.length, 1);
    assert.equal(falso.uso.encerrou, 1);
  });
  test('tabela pgmigrations ausente nunca vira "sem migrations"', async () => assert.equal(await codigoDe(observar(clienteFalso({ controle: false }))), 'SONDA_TABELA_DE_CONTROLE_AUSENTE'));
  test('tabela de controle vazia é recusada', async () => assert.equal(await codigoDe(observar(clienteFalso({ nomes: [] }))), 'SONDA_RESULTADO_INVALIDO'));
  test('nomes inválidos ou repetidos', async () => {
    for (const nomes of [['000_a', '000_a'], ['000_a', ''], ['000_a', 7], ['000_a', 'com espaço']]) assert.equal(await codigoDe(observar(clienteFalso({ nomes }))), 'SONDA_RESULTADO_INVALIDO', JSON.stringify(nomes));
  });
  test('resultado do inspetor fora do contrato', async () => {
    for (const ruim of [null, {}, { controleExiste: true, aplicadas: 'x', semArquivo: [] }]) {
      const inspecionar = async ({ criarCliente }) => { const c = criarCliente(); await c.connect(); await c.end(); return ruim; };
      assert.equal(await codigoDe(observar(clienteFalso(), { inspecionar })), 'SONDA_RESULTADO_INVALIDO');
    }
  });
  test('inspetor que não usa a fábrica da sonda não comprova identidade', async () => {
    const inspecionar = async () => ({ controleExiste: true, aplicadas: ['000_a'], semArquivo: [] });
    assert.equal(await codigoDe(observar(clienteFalso(), { inspecionar })), 'SONDA_IDENTIDADE_NAO_COMPROVADA');
  });
});

describe('sonda: somente leitura', () => {
  test('a conexão entregue ao inspetor recusa qualquer comando que não seja um SELECT único', async () => {
    for (const sql of ['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1', 'DELETE FROM t', 'CREATE TABLE t (a int)', 'SELECT 1; DROP TABLE t', 'SET statement_timeout = 0', 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 42]) {
      const falso = clienteFalso();
      const inspecionar = async ({ criarCliente }) => { const c = criarCliente(); await c.connect(); try { await c.query(sql); } finally { await c.end(); } return { controleExiste: true, aplicadas: ['000_a'], semArquivo: [] }; };
      assert.equal(await codigoDe(observar(falso, { inspecionar })), 'SONDA_ESCRITA_RECUSADA', String(sql));
      assert.equal(falso.uso.consultas.length, 1, 'só a consulta de identidade chegou ao banco');
      assert.equal(falso.uso.encerrou, 1);
    }
  });
  test('o código da sonda não contém comando SQL de escrita, não lê variáveis de ambiente e não carrega o .env da aplicação', () => {
    const fonte = fs.readFileSync(ARQ, 'utf8');
    assert.doesNotMatch(fonte, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY)\b\s+(?:INTO|TABLE|FROM|ON|[a-z_"]+\s+SET)/i);
    assert.doesNotMatch(fonte, /dotenv|process\.env|aplicarMigrations/);
    assert.equal((fonte.match(/'SELECT /g) || []).length, 1, 'a única consulta própria é a de identidade');
  });
});

describe('sonda: arquivo de credencial', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sonda-cred-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const gravar = (conteudo, modo = 0o600, nome = 'credencial.json') => { const p = path.join(dir, nome); fs.writeFileSync(p, typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo), { mode: modo }); fs.chmodSync(p, modo); return p; };
  const recusada = (caminho, portas) => assert.throws(() => S.lerCredencial(caminho, portas), (e) => e.codigo === 'SONDA_CREDENCIAL' && !/segredo/.test(e.message), String(caminho));

  test('arquivo regular, do próprio usuário e sem acesso de grupo ou outros é aceito', () => {
    assert.deepEqual(S.lerCredencial(gravar(CREDENCIAL)), CONF);
    assert.deepEqual(S.lerCredencial(gravar({ ...CREDENCIAL, schema: 'app', sslModo: 'verify-full', raizCa: '/etc/ssl/ca.pem' }, 0o400, 'b.json')).schema, 'app');
  });
  test('ausente, relativo, diretório ou vazio', () => {
    recusada(path.join(dir, 'nao-existe.json'));
    recusada('credencial.json');
    recusada(dir);
    recusada(gravar('', 0o600, 'vazio.json'));
    recusada(undefined);
  });
  test('permissão de leitura ou escrita para grupo ou outros', () => {
    for (const modo of [0o640, 0o604, 0o620, 0o602, 0o644, 0o666]) recusada(gravar(CREDENCIAL, modo, `m${modo}.json`));
  });
  test('link simbólico no arquivo ou no caminho, e arquivo com mais de um nome', () => {
    const real = gravar(CREDENCIAL);
    const link = path.join(dir, 'link.json'); fs.symlinkSync(real, link);
    recusada(link);
    const dirLink = path.join(dir, 'atalho'); fs.symlinkSync(dir, dirLink);
    recusada(path.join(dirLink, 'credencial.json'));
    const duro = path.join(dir, 'duro.json'); fs.linkSync(real, duro);
    recusada(real);
  });
  test('proprietário diferente do usuário que executa a sonda', () => {
    recusada(gravar(CREDENCIAL), { uid: 4242424 });
    recusada(gravar(CREDENCIAL, 0o600, 'c.json'), { uid: null });
  });
  test('conteúdo inválido: não JSON, campos faltando, tipos errados, campo desconhecido, grande demais', () => {
    recusada(gravar('não é json', 0o600, 'a.json'));
    for (const [i, ruim] of [[1, []], [2, { ...CREDENCIAL, senha: '' }], [3, { ...CREDENCIAL, porta: '5432' }], [4, { ...CREDENCIAL, porta: 0 }], [5, { ...CREDENCIAL, schema: 'Public; DROP' }], [6, { ...CREDENCIAL, extra: 1 }], [7, { ...CREDENCIAL, banco: ' ' }], [8, (({ usuario, ...r }) => r)(CREDENCIAL)]]) {
      recusada(gravar(ruim, 0o600, `r${i}.json`));
    }
    recusada(gravar({ ...CREDENCIAL, senha: 'x'.repeat(70000) }, 0o600, 'grande.json'));
  });
});

describe('sonda: linha de comando', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sonda-cli-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const credencial = (modo = 0o600) => { const p = path.join(dir, 'credencial.json'); fs.writeFileSync(p, JSON.stringify(CREDENCIAL), { mode: modo }); fs.chmodSync(p, modo); return p; };
  const rodar = async (falso, argv) => {
    const s = { out: '', err: '' };
    const codigo = await S.principal({ argv, Client: falso.Client, inspecionar: inspecionarDuble, diretorio: '/x', limites: LIMITES, saida: (t) => { s.out += t; }, erro: (t) => { s.err += t; } });
    return { codigo, ...s };
  };
  test('sucesso: código 0 e uma única linha JSON, sem a senha', async () => {
    const r = await rodar(clienteFalso(), ['--credencial', credencial()]);
    assert.equal(r.codigo, 0);
    assert.deepEqual(JSON.parse(r.out), { banco: 'safework_hml', papel: 'sonda_leitura', schema: 'public', sistema: SISTEMA, migrations: ['000_a', '001_b'] });
    assert.equal(r.err, '');
    assert.doesNotMatch(r.out, /segredo/);
  });
  test('falha: código diferente de 0, nada na saída e só o código do erro, sem credencial nem mensagem do driver', async () => {
    const casos = [
      [clienteFalso({ falhaAoConectar: true }), ['--credencial', credencial()]], [clienteFalso({ falhaNaConsulta: true }), ['--credencial', credencial()]],
      [clienteFalso({ banco: 'outro' }), ['--credencial', credencial()]], [clienteFalso(), ['--credencial', credencial(0o644)]],
      [clienteFalso(), []], [clienteFalso(), ['--credencial']], [clienteFalso(), ['--senha', 'segredo-da-sonda']], [clienteFalso(), ['--credencial', path.join(dir, 'nao-existe')]],
    ];
    for (const [falso, argv] of casos) {
      const r = await rodar(falso, argv);
      assert.notEqual(r.codigo, 0);
      assert.equal(r.out, '');
      assert.match(r.err, /^sonda recusou: SONDA_[A-Z_]+\n$/);
      assert.doesNotMatch(r.err, /segredo|sonda_leitura|password|127\.0\.0\.1/);
    }
  });
});

describe('sonda: encerramento da linha de comando (S9383)', () => {
  const { spawnSync } = require('node:child_process');
  const encerramento = (opcoes) => new Promise((resolver) => { S.comoComando({ ...opcoes, encerrar: resolver }); });

  test('causa: principal rejeita quando a própria escrita do erro falha', async () => {
    await assert.rejects(S.principal({ argv: [], erro: () => { throw new Error('EPIPE segredo-da-sonda'); } }), /EPIPE/);
  });

  test('encerramento normal: usa o código devolvido por principal', async () => {
    assert.equal(await encerramento({ rodar: async () => 0 }), 0);
    assert.equal(await encerramento({ rodar: async () => 3 }), 3);
  });

  test('rejeição de principal: encerra com 3 e escreve só a mensagem fixa, sem a original nem credencial', async () => {
    let err = '';
    const codigo = await encerramento({ rodar: async () => { throw new Error('EPIPE segredo-da-sonda sonda_leitura 127.0.0.1'); }, erro: (t) => { err += t; } });
    assert.equal(codigo, 3);
    assert.equal(err, 'sonda recusou: SONDA_ERRO\n');
  });

  test('rejeição com a saída de erro também indisponível: ainda encerra com 3', async () => {
    assert.equal(await encerramento({ rodar: async () => { throw new Error('x'); }, erro: () => { throw new Error('EPIPE'); } }), 3);
  });

  test('não sobra rejeição sem tratamento e a função não devolve Promise solta', async () => {
    const soltas = [];
    const ouvir = (motivo) => soltas.push(motivo);
    process.on('unhandledRejection', ouvir);
    try {
      let retorno;
      const codigo = await new Promise((resolver) => { retorno = S.comoComando({ rodar: async () => { throw new Error('x'); }, erro: () => {}, encerrar: resolver }); });
      await new Promise((r) => setImmediate(r));
      assert.equal(codigo, 3);
      assert.equal(retorno, undefined);
      assert.deepEqual(soltas, []);
    } finally { process.off('unhandledRejection', ouvir); }
  });

  test('linha de comando real, sem credencial: código 3, saída vazia e só o código do erro', () => {
    for (const [args, codigo] of [[[], 'SONDA_USO'], [['--credencial', '/caminho/que/nao/existe.json'], 'SONDA_CREDENCIAL'], [['--senha', 'segredo-da-sonda'], 'SONDA_USO']]) {
      const r = spawnSync(process.execPath, [ARQ, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30000 });
      assert.equal(r.status, 3, JSON.stringify(args));
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, `sonda recusou: ${codigo}\n`);
    }
  });

  test('linha de comando real com a saída de erro fechada: ainda encerra com 3, sem rastro de exceção na saída', () => {
    const r = spawnSync('/bin/sh', ['-c', '"$0" "$1" 2>&-', process.execPath, ARQ], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30000 });
    assert.equal(r.status, 3);
    assert.equal(r.stdout, '');
  });
});

const temPg = (() => { try { require.resolve('pg'); return true; } catch { return false; } })();
describe('sonda com o inspecionarMigrations real (exige as dependências do backend; roda no CI)', { skip: temPg ? false : 'driver pg não instalado nesta árvore' }, () => {
  test('a fábrica injetada é usada, os chamadores sem fábrica continuam com a conexão padrão, e só há SELECT', async () => {
    const { inspecionarMigrations } = require('../../scripts/migrate');
    const diretorio = path.join(__dirname, '..', '..', 'migrations');
    const nomes = fs.readdirSync(diretorio).filter((f) => f.endsWith('.sql')).sort().slice(0, 3).map((f) => f.replace(/\.sql$/, ''));
    const falso = clienteFalso({ nomes });
    const r = await S.observar({ conf: CONF, Client: falso.Client, inspecionar: inspecionarMigrations, diretorio, limites: LIMITES });
    assert.deepEqual(r.migrations, nomes);
    assert.equal(falso.uso.configs.length, 1);
    assert.ok(falso.uso.consultas.every((q) => /^\s*SELECT\b/i.test(q)));
    await assert.rejects(inspecionarMigrations({ schema: 'public', diretorio, criarCliente: 'não é função' }), TypeError);
  });
});
