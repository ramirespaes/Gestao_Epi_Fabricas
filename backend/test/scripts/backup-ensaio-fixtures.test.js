'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { criarRaizTemporaria, removerTemporarioSeguro, pendentes } = require('../storage/helpers/tmp-seguro');
const F = require('../integracao/helpers/backup-ensaio-fixtures');

/**
 * Helper compartilhado dos ensaios PostgreSQL (B3 e H9H-B1) [FIX]: localização dos binários 16 e semeadura de imagens sintéticas. Nenhum PostgreSQL, nenhuma migration, nenhum processo real
 * além de binários FALSOS (scripts de shell sintéticos) criados em diretório temporário exclusivo e removidos ao fim.
 */

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const raizes = [];
const novaRaiz = () => { const r = criarRaizTemporaria(); raizes.push(r); return r; };
after(() => { for (const r of raizes) removerTemporarioSeguro(r); assert.deepEqual(pendentes(), []); });

function binariosFalsos({ versao = '16.15', dump = true, restore = true, executavelRestore = true, falhaNoDump = false, vigiaAmbiente = false } = {}) {
  const dir = novaRaiz();
  if (dump) {
    const corpo = falhaNoDump ? 'exit 1' : `${vigiaAmbiente ? 'if [ -n "$SWB_TESTE_CONTAMINACAO" ]; then echo contaminado; exit 3; fi\n' : ''}echo "pg_dump (PostgreSQL) ${versao} (Falso)"`;
    fs.writeFileSync(path.join(dir, 'pg_dump'), `#!/bin/sh\n${corpo}\n`, { mode: 0o700 });
  }
  if (restore) fs.writeFileSync(path.join(dir, 'pg_restore'), '#!/bin/sh\nexit 0\n', { mode: executavelRestore ? 0o700 : 0o600 });
  return dir;
}
const codigoOuMensagem = (fn) => { try { fn(); } catch (e) { return e.code === 'ERR_ASSERTION' ? e.message : (e.code ?? e.message); } return null; };

describe('[FIX] localizarBinarios', () => {
  test('POSITIVO: diretório canônico com pg_dump e pg_restore executáveis e versão 16 devolve os dois caminhos', () => {
    const dir = binariosFalsos();
    assert.deepEqual(F.localizarBinarios({ BACKUP_PG_BINARIOS: dir }), { dump: path.join(dir, 'pg_dump'), restore: path.join(dir, 'pg_restore') });
  });

  test('NEGATIVO: variável ausente, vazia, não string, relativa ou inexistente é recusada (nada é executado)', () => {
    for (const env of [{}, { BACKUP_PG_BINARIOS: '' }, { BACKUP_PG_BINARIOS: 42 }, { BACKUP_PG_BINARIOS: 'bin/relativo' }]) {
      assert.ok(codigoOuMensagem(() => F.localizarBinarios(env)) !== null, JSON.stringify(env));
    }
    assert.equal(codigoOuMensagem(() => F.localizarBinarios({ BACKUP_PG_BINARIOS: path.join(novaRaiz(), 'nao-existe') })), 'ENOENT');
  });

  test('NEGATIVO: caminho não canônico (link simbólico para um diretório válido) é recusado', () => {
    const dir = binariosFalsos();
    const link = path.join(novaRaiz(), 'atalho');
    fs.symlinkSync(dir, link);
    assert.match(codigoOuMensagem(() => F.localizarBinarios({ BACKUP_PG_BINARIOS: link })), /não canônico/);
  });

  test('NEGATIVO: falta pg_restore, falta pg_dump ou binário sem permissão de execução é recusado', () => {
    assert.equal(codigoOuMensagem(() => F.localizarBinarios({ BACKUP_PG_BINARIOS: binariosFalsos({ restore: false }) })), 'ENOENT');
    assert.equal(codigoOuMensagem(() => F.localizarBinarios({ BACKUP_PG_BINARIOS: binariosFalsos({ dump: false }) })), 'ENOENT');
    assert.equal(codigoOuMensagem(() => F.localizarBinarios({ BACKUP_PG_BINARIOS: binariosFalsos({ executavelRestore: false }) })), 'EACCES');
  });

  test('NEGATIVO: versão diferente de 16 e pg_dump que falha são recusados', () => {
    assert.match(codigoOuMensagem(() => F.localizarBinarios({ BACKUP_PG_BINARIOS: binariosFalsos({ versao: '15.9' }) })), /did not match[\s\S]*15\.9/);
    assert.ok(codigoOuMensagem(() => F.localizarBinarios({ BACKUP_PG_BINARIOS: binariosFalsos({ falhaNoDump: true }) })) !== null);
  });

  test('o pg_dump --version roda com AMBIENTE VAZIO: variável do processo de teste não vaza para o binário', () => {
    const dir = binariosFalsos({ vigiaAmbiente: true });
    process.env.SWB_TESTE_CONTAMINACAO = '1';
    try { assert.deepEqual(F.localizarBinarios({ BACKUP_PG_BINARIOS: dir }).dump, path.join(dir, 'pg_dump')); } finally { delete process.env.SWB_TESTE_CONTAMINACAO; }
  });
});

describe('[FIX] semearImagensSinteticas', () => {
  const fakes = ({ falharGravacaoEm = null, falharInsercaoEm = null } = {}) => {
    const gravacoes = [];
    const consultas = [];
    return {
      gravacoes, consultas,
      armazenamento: { async gravar(caminho, conteudo, opcoes) { if (falharGravacaoEm !== null && gravacoes.length + 1 === falharGravacaoEm) throw new Error('GRAVACAO-SINTETICA'); gravacoes.push({ caminho, conteudo, opcoes }); } },
      cliente: { async query(sql, parametros) { if (falharInsercaoEm !== null && consultas.length + 1 === falharInsercaoEm) throw new Error('INSERCAO-SINTETICA'); consultas.push({ sql, parametros }); return { rows: [] }; } },
    };
  };

  test('POSITIVO: duas imagens com arquivos na ordem, caminhos pelo hash do mestre, limite de 1024 bytes, SQL parametrizado e retorno coerente', async () => {
    const f = fakes();
    const r = await F.semearImagensSinteticas({ armazenamento: f.armazenamento, cliente: f.cliente, nomeOrigem: 'gepi_origem_teste' });
    assert.equal(r.length, 2);
    assert.equal(f.gravacoes.length, 4);
    assert.equal(f.consultas.length, 2);
    r.forEach(({ h, mestre, mini }, i) => {
      const n = i + 1;
      assert.equal(mestre.toString(), `png-ficticio-${n}-gepi_origem_teste`);
      assert.equal(mini.toString(), `webp-mini-${n}-gepi_origem_teste`);
      assert.equal(h, sha(mestre));
      assert.deepEqual(f.gravacoes.slice(i * 2, i * 2 + 2).map((g) => [g.caminho, g.opcoes]), [[`padrao/${h}/mestre.png`, { maxBytes: 1024 }], [`padrao/${h}/miniatura.webp`, { maxBytes: 1024 }]]);
      assert.deepEqual(f.consultas[i].parametros, [`Imagem ${n}`, `imagem-${n}.png`, h, sha(mini), 'PNG', mestre.length, mini.length]);
      assert.ok(mestre.length <= 1024 && mini.length <= 1024);
    });
    assert.equal(f.consultas[0].sql, F.SQL_IMAGEM_PADRAO);
    assert.match(F.SQL_IMAGEM_PADRAO, /VALUES \(\$1, \$2, \$3, \$4, \$5, 256, 256, \$6, \$7\)$/);
    assert.notEqual(r[0].h, r[1].h);
  });

  test('o conteúdo depende do banco de origem (dois bancos, hashes diferentes) e a quantidade é configurável de 1 a 10', async () => {
    const a = await F.semearImagensSinteticas({ ...fakes(), nomeOrigem: 'origem_a', quantidade: 3 });
    const b = await F.semearImagensSinteticas({ ...fakes(), nomeOrigem: 'origem_b', quantidade: 3 });
    assert.equal(a.length, 3);
    assert.notEqual(a[0].h, b[0].h);
  });

  test('NEGATIVO: dependências ou parâmetros inválidos são recusados ANTES de gravar ou inserir qualquer coisa', async () => {
    const f = fakes();
    const base = { armazenamento: f.armazenamento, cliente: f.cliente, nomeOrigem: 'origem' };
    for (const ruim of [{ armazenamento: null }, { armazenamento: {} }, { cliente: null }, { cliente: { query: 1 } }, { nomeOrigem: '' }, { nomeOrigem: 7 }, { quantidade: 0 }, { quantidade: 11 }, { quantidade: 1.5 }, { quantidade: '2' }]) {
      await assert.rejects(() => F.semearImagensSinteticas({ ...base, ...ruim }), assert.AssertionError, JSON.stringify(ruim));
    }
    assert.deepEqual([f.gravacoes.length, f.consultas.length], [0, 0]);
  });

  test('PROPAGAÇÃO: falha ao gravar o mestre, a miniatura ou inserir interrompe a semeadura e o erro chega ao chamador, sem inserir a linha da imagem que falhou', async () => {
    for (const [falha, gravacoesEsperadas, consultasEsperadas, marca] of [[{ falharGravacaoEm: 1 }, 0, 0, 'GRAVACAO-SINTETICA'], [{ falharGravacaoEm: 2 }, 1, 0, 'GRAVACAO-SINTETICA'], [{ falharGravacaoEm: 3 }, 2, 1, 'GRAVACAO-SINTETICA'], [{ falharInsercaoEm: 1 }, 2, 0, 'INSERCAO-SINTETICA'], [{ falharInsercaoEm: 2 }, 4, 1, 'INSERCAO-SINTETICA']]) {
      const f = fakes(falha);
      await assert.rejects(() => F.semearImagensSinteticas({ armazenamento: f.armazenamento, cliente: f.cliente, nomeOrigem: 'origem' }), { message: marca }, JSON.stringify(falha));
      assert.deepEqual([f.gravacoes.length, f.consultas.length], [gravacoesEsperadas, consultasEsperadas], JSON.stringify(falha));
    }
  });
});

describe('[FIX] escopo restrito do helper', () => {
  test('o helper não lê o ambiente global, não importa banco, migrations nem as suítes, e só lança o processo `pg_dump --version`', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', 'integracao', 'helpers', 'backup-ensaio-fixtures.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(fonte, /process\.env|require\('pg'\)|migra|aplicarMigrations|SWB_|PORTAS_PROTEGIDAS|CREATE DATABASE|DROP DATABASE/);
    assert.deepEqual([...fonte.matchAll(/cp\.(\w+)\(/g)].map((m) => m[1]), ['execFileSync']);
    assert.equal([...fonte.matchAll(/'--version'/g)].length, 1);
  });

  test('as duas suítes consomem o helper e continuam com as proteções próprias (opt-in, porta protegida, socket, padrão de PGDATA, filho com ambiente restrito, cleanup)', () => {
    for (const [arquivo, optin] of [['d-orf-6-b3-ponta-a-ponta.integration.js', 'SWB_B3_PONTA_A_PONTA'], ['d-orf-6-h9h-b1-papel-minimo.integration.js', 'SWB_H9H_B1']]) {
      const fonte = fs.readFileSync(path.join(__dirname, '..', 'integracao', arquivo), 'utf8');
      assert.match(fonte, /require\('\.\/helpers\/backup-ensaio-fixtures'\)/, arquivo);
      assert.match(fonte, /localizarBinarios\(process\.env\)/, arquivo);
      assert.match(fonte, /semearImagensSinteticas\(/, arquivo);
      assert.doesNotMatch(fonte, /function localizarBinarios/, arquivo);
      assert.doesNotMatch(fonte, /png-ficticio-/, arquivo);
      for (const protecao of [optin, 'PORTAS_PROTEGIDAS', 'PADRAO_PGDATA', 'VARIAVEIS_PG_PROIBIDAS', 'confirmarBancoDeTeste', 'BANCOS_BASE', 'listen_addresses', 'unix_socket_directories', 'execFileSync(process.execPath', 'DROP DATABASE IF EXISTS', 'SO_NA_INSTANCIA_EFEMERA_LOCAL', 'fs.rmSync(ctx.area']) assert.ok(fonte.includes(protecao), `${arquivo}: perdeu ${protecao}`);
    }
  });
});
