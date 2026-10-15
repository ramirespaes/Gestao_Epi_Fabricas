'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  abrirAmbienteJ, motivoDeRecusaCi, marcadorEsperadoCi, marcadorDoBancoConfere,
} = require('../integracao/helpers/token-j');

/**
 * Prova alternativa à guarda D1 no PostgreSQL efêmero do GitHub Actions. Só funções puras e leitura estática: nenhuma conexão
 * com PostgreSQL. A guarda D1 (cluster dedicado do Mac) não muda e continua obrigatória fora da CI.
 */

const RAIZ = path.join(__dirname, '..', '..');
const ler = (relativo) => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');
const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const MENSAGEM_ORIGINAL = 'guarda D1 ausente: use o comando oficial do RED integrado (--require ./test/integracao/exigir-instancia-dedicada.js)';
const NONCE = '0123456789abcdef0123456789abcdef';
const MARCADOR = `GEPI_CI_EFEMERO:9876543210:1:${NONCE}`;

const ambienteCi = () => ({
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'gestao_epi_teste_local', DB_USER: 'postgres',
  DB_PASSWORD: 'postgres', GITHUB_RUN_ID: '9876543210', GITHUB_RUN_ATTEMPT: '1', GEPI_CI_NONCE: NONCE, PATH: '/usr/bin', TZ: 'America/Sao_Paulo',
});

describe('Prova de instância efêmera de CI — ambiente', () => {
  test('C01 — ambiente completo e correto é aceito e gera o marcador desta execução', () => {
    assert.equal(motivoDeRecusaCi(ambienteCi()), null);
    assert.equal(marcadorEsperadoCi(ambienteCi()), MARCADOR);
  });

  test('C02 — cada variável exigida, ausente ou com outro valor, recusa (inclusive runner self-hosted e a variável CI sozinha)', () => {
    const exigidas = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'gestao_epi_teste_local', DB_USER: 'postgres' };
    for (const nome of Object.keys(exigidas)) {
      const ausente = ambienteCi(); delete ausente[nome];
      assert.equal(motivoDeRecusaCi(ausente), `${nome} divergente`, `${nome} ausente`);
      for (const outro of ['', 'TRUE', 'self-hosted', 'localhost', '55432', 'gestao_epi', 'gepi_teste_j2a', ' ']) {
        if (outro === exigidas[nome]) continue;
        const e = { ...ambienteCi(), [nome]: outro };
        assert.equal(motivoDeRecusaCi(e), `${nome} divergente`, `${nome}=${JSON.stringify(outro)}`);
      }
    }
    const soCi = { ...ambienteCi(), CI: 'true' }; delete soCi.GITHUB_ACTIONS;
    assert.notEqual(motivoDeRecusaCi(soCi), null, 'CI=true sozinha não prova nada (o workflow pode sobrescrevê-la)');
    assert.equal(motivoDeRecusaCi({}), 'GITHUB_ACTIONS divergente');
  });

  test('C03 — qualquer variável de conexão alternativa ou conflitante recusa, sem mostrar o valor', () => {
    for (const nome of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'pghost', 'PGSSLMODE', 'PGOPTIONS', 'DATABASE_URL', 'NODE_OPTIONS', 'NODE_PG_FORCE_NATIVE', 'DOTENV_CONFIG_PATH', 'DOTENV_KEY', 'DOTENV_CONFIG_OVERRIDE']) {
      const motivo = motivoDeRecusaCi({ ...ambienteCi(), [nome]: 'valor-secreto-xyz' });
      assert.equal(motivo, `variável proibida presente: ${nome}`, nome);
      assert.equal(motivo.includes('valor-secreto-xyz'), false);
    }
  });

  test('C04 — identificadores da execução ausentes ou malformados recusam (run, tentativa e nonce)', () => {
    const casos = {
      GITHUB_RUN_ID: ['', 'abc', '12 3', '1'.repeat(21), '-1'],
      GITHUB_RUN_ATTEMPT: ['', 'x', '1234567', '1.5'],
      GEPI_CI_NONCE: ['', 'abc', NONCE.toUpperCase(), NONCE.slice(1), `${NONCE}0`, 'g'.repeat(32)],
    };
    for (const [nome, valores] of Object.entries(casos)) {
      const ausente = ambienteCi(); delete ausente[nome];
      assert.equal(motivoDeRecusaCi(ausente), 'identificadores da execução ausentes ou inválidos', `${nome} ausente`);
      for (const valor of valores) {
        const e = { ...ambienteCi(), [nome]: valor };
        assert.equal(motivoDeRecusaCi(e), 'identificadores da execução ausentes ou inválidos', `${nome}=${JSON.stringify(valor)}`);
        assert.equal(marcadorEsperadoCi(e), null);
      }
    }
  });
});

describe('Prova de instância efêmera de CI — marcador do banco', () => {
  test('C05 — só a igualdade exata com o marcador desta execução é aceita', () => {
    assert.equal(marcadorDoBancoConfere(MARCADOR, MARCADOR), true);
    const recusados = [
      null, undefined, '', 42, {}, [MARCADOR],
      'GEPI_CI_EFEMERO:9876543210:1:ffffffffffffffffffffffffffffffff',  // nonce de outra execução
      'GEPI_CI_EFEMERO:9876543211:1:' + NONCE,                          // outra run
      'GEPI_CI_EFEMERO:9876543210:2:' + NONCE,                          // outra tentativa da mesma run
      `${MARCADOR} `, ` ${MARCADOR}`, `${MARCADOR}:extra`, MARCADOR.toLowerCase().replace('gepi', 'GEPI'), 'GEPI_J2A_ISOLADO:x:1',
    ];
    for (const lido of recusados) assert.equal(marcadorDoBancoConfere(lido, MARCADOR), false, JSON.stringify(lido));
    assert.equal(marcadorDoBancoConfere(MARCADOR, null), false, 'sem marcador esperado nada é aceito');
    assert.equal(marcadorDoBancoConfere(MARCADOR, ''), false);
    assert.equal(marcadorDoBancoConfere('', ''), false);
  });
});

describe('Prova de instância efêmera de CI — recusa antes de qualquer conexão e D1 preservada', () => {
  test('C06 — sem a D1 e sem ambiente de CI validado, abrirAmbienteJ recusa com a mensagem ORIGINAL, antes de abrir conexão', async (t) => {
    if (globalThis.__GEPI_GUARDA_J2A__) { t.skip('guarda D1 presente neste processo: o ramo sem D1 não se aplica'); return; }
    const locais = [{}, { DB_HOST: '127.0.0.1', DB_PORT: '55432', DB_NAME: 'gestao_epi_teste_local', DB_USER: 'gepi_teste_j2a', NODE_ENV: 'test' }, { ...ambienteCi(), GITHUB_ACTIONS: undefined }, { ...ambienteCi(), PGHOST: 'x' }];
    for (const env of locais) {
      // Se chegasse a abrir o ambiente, o erro seria outro (banco recusado ou conexão): a mensagem exata prova que parou antes.
      await assert.rejects(abrirAmbienteJ({ env }), (erro) => erro.message === MENSAGEM_ORIGINAL);
    }
  });

  test('C07 — estática do helper: mantém o sentinela e a mensagem original, não usa CI, psql nem abre conexão própria, e confere o marcador antes das operações do J2a', () => {
    const bruto = ler('test/integracao/helpers/token-j.js');
    const codigo = semComentarios(bruto);
    assert.ok(codigo.includes('globalThis.__GEPI_GUARDA_J2A__'));
    assert.ok(codigo.includes(MENSAGEM_ORIGINAL));
    assert.equal(/new\s+(Pool|Client)\s*\(/.test(codigo), false);
    assert.equal(/process\.env\.CI\b|env\.CI\b|psql/.test(codigo), false);
    const corpo = codigo.slice(codigo.indexOf('async function abrirAmbienteJ'));
    const iRecusa = corpo.indexOf('motivoDeRecusaCi(env) === null');
    const iAbrir = corpo.indexOf('await abrirAmbientePedido()');
    const iMarcador = corpo.indexOf('SQL_MARCADOR_DO_BANCO');
    const iSchema = corpo.indexOf('current_schema()');
    const iApp = corpo.indexOf('function criarApp');
    assert.ok(iRecusa >= 0 && iRecusa < iAbrir, 'a conferência do ambiente vem antes de abrir qualquer conexão');
    assert.ok(iAbrir < iMarcador && iMarcador < iSchema && iSchema < iApp, 'o marcador do banco é conferido logo depois de abrir e antes das demais operações');
    const bloco = corpo.slice(iMarcador, iSchema);
    assert.ok(bloco.includes('marcadorDoBancoConfere(') && bloco.includes('await a.encerrar()') && bloco.includes('throw erro'), 'divergência encerra o ambiente e propaga o erro');
  });

  test('C08 — estática do workflow: o passo de marcação roda antes dos testes, usa nonce aleatório, node e pg (sem psql), recusa comentário anterior e o comando de teste não mudou', () => {
    const ci = ler('../.github/workflows/ci.yml');
    const iPasso = ci.indexOf('Backend - marcar a instância efêmera do banco desta execução');
    const iTeste = ci.indexOf('npm run test:integracao');
    assert.ok(iPasso > 0 && iPasso < iTeste, 'a marcação vem antes dos testes de integração');
    const passo = ci.slice(iPasso, iTeste);
    for (const trecho of ['openssl rand -hex 16', '$GITHUB_ENV', "require('pg')", 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'github-hosted', 'process.exit(1)', 'COMMENT ON DATABASE', 'antes.marcador !== null', 'depois.marcador !== marcador']) {
      assert.ok(passo.includes(trecho), `passo de marcação sem: ${trecho}`);
    }
    assert.equal(/psql/.test(passo), false);
    assert.equal(ci.split('npm run test:integracao').length - 1, 1);
    assert.ok(ci.includes('working-directory: backend\n        run: npm run test:integracao'));
  });

  test('C09 — a guarda D1 segue como está: carregador com o sentinela e o alvo dedicado, sem relação com a prova de CI', () => {
    const carregador = ler('test/integracao/exigir-instancia-dedicada.js');
    assert.ok(carregador.includes('globalThis.__GEPI_GUARDA_J2A__ = Object.freeze({ versao: 1 });'));
    assert.ok(carregador.includes("const RAIZ = '/Users/ramirespaes/PostgresTeste/j2a';"));
    const modulo = ler('test/integracao/helpers/guarda-instancia-dedicada.js');
    assert.ok(modulo.includes("PORTA_COMPARTILHADA = 5432") && modulo.includes("'porta 5432 proibida'"));
    assert.equal(/GITHUB_|GEPI_CI/.test(carregador + modulo), false, 'a D1 não conhece a prova de CI');
    assert.equal(/GITHUB_|GEPI_CI/.test(ler('package.json')), false);
  });
});
