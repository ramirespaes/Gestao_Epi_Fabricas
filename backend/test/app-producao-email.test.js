'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { assertSemSensiveis } = require('./helpers/sensiveis');

/**
 * Em production a recuperação de senha depende de entrega real de e-mail.
 * Sem um modo de provedor aceitável, o processo não pode subir: a falha tem
 * de acontecer na inicialização, antes de escutar a porta, citando só o nome
 * da variável e a regra.
 *
 * O servidor real (src/server.js) roda em processo filho, com ambiente só o
 * daqui e diretório de trabalho vazio, para nenhum .env entrar. As outras
 * exigências de production não são afrouxadas: a fixture é válida para os
 * demais módulos de configuração, e um teste de controle prova isso.
 */

const RAIZ = path.join(__dirname, '..');
const SERVIDOR = path.join(RAIZ, 'src', 'server.js');

const SEGREDO_HMAC = crypto.randomBytes(32).toString('hex');
const CHAVE_MFA = crypto.randomBytes(32).toString('hex');
const SECRET_TURNSTILE = '0x4AAAAAAAsegredoFicticioParaTeste000';

const PRODUCAO = Object.freeze({
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  PORT: '0',
  LOGIN_COOLDOWN_HMAC_SECRET: SEGREDO_HMAC,
  MFA_TOTP_KEY_CURRENT_VERSION: '1',
  MFA_TOTP_KEY_V1: CHAVE_MFA,
  CORS_ORIGIN: 'https://epi.example.com',
  PLATAFORMA_CORS_ORIGIN: 'https://admin.example.com',
  PLATAFORMA_HOST: 'admin.example.com',
  TURNSTILE_PORTAL_SITE_KEY: '0x4AAAAAAAsiteFicticiaParaTeste',
  TURNSTILE_PORTAL_SECRET_KEY: SECRET_TURNSTILE,
});

const DESENVOLVIMENTO = Object.freeze({
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  PORT: '0',
  LOGIN_COOLDOWN_HMAC_SECRET: SEGREDO_HMAC,
  MFA_TOTP_KEY_CURRENT_VERSION: '1',
  MFA_TOTP_KEY_V1: CHAVE_MFA,
});

const SEGREDOS = [SEGREDO_HMAC, CHAVE_MFA, SECRET_TURNSTILE];

let diretorioVazio;

/**
 * Sobe o servidor real e devolve como ele terminou. Se ele chegar a escutar
 * a porta, o teste o encerra na hora e registra `escutou: true`.
 */
function subirServidor(env, limiteMs = 15000) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [SERVIDOR], { cwd: diretorioVazio, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let escutou = false;
    let encerradoPeloTeste = false;
    const encerrar = () => { encerradoPeloTeste = true; filho.kill('SIGKILL'); };
    const relogio = setTimeout(encerrar, limiteMs);
    filho.stdout.on('data', (dados) => {
      stdout += dados;
      if (!escutou && /rodando na porta/.test(stdout)) {
        escutou = true;
        encerrar();
      }
    });
    filho.stderr.on('data', (dados) => { stderr += dados; });
    filho.on('close', (status, sinal) => {
      clearTimeout(relogio);
      resolve({ status, sinal, stdout, stderr, escutou, encerradoPeloTeste });
    });
  });
}

before(() => { diretorioVazio = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-subida-')); });
after(() => { fs.rmSync(diretorioVazio, { recursive: true, force: true }); });

describe('controles do harness de subida', () => {
  test('a fixture de production é aceita pelos demais módulos de configuração (HTTP, autenticação, Turnstile e MFA)', () => {
    const carregar = "for (const m of ['http', 'auth', 'turnstile', 'mfa']) require('./src/config/' + m); process.exit(0)";
    const r = spawnSync(process.execPath, ['-e', carregar], { cwd: RAIZ, env: { ...PRODUCAO }, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assertSemSensiveis(r.stdout + r.stderr, SEGREDOS, 'saída do processo');
  });

  test('fora de production o servidor real sobe e chega a escutar a porta: o harness enxerga a subida', async () => {
    const r = await subirServidor({ ...DESENVOLVIMENTO });
    assert.equal(r.escutou, true, r.stderr);
    assert.equal(r.encerradoPeloTeste, true);
  });
});

describe('production sem entrega de e-mail válida', () => {
  const casos = [
    ['sem EMAIL_MODO', {}],
    ['EMAIL_MODO=desativado', { EMAIL_MODO: 'desativado' }],
    ['EMAIL_MODO=arquivo', { EMAIL_MODO: 'arquivo', EMAIL_ARQUIVO_DIRETORIO: path.join(os.tmpdir(), 'gepi-emails-producao') }],
  ];

  for (const [nome, extra] of casos) {
    test(`${nome}: o processo falha na inicialização, antes de escutar a porta, citando só a variável e a regra`, async () => {
      const r = await subirServidor({ ...PRODUCAO, ...extra });
      assert.equal(r.escutou, false, 'o servidor chegou a escutar a porta');
      assert.equal(r.encerradoPeloTeste, false, 'o processo deveria ter terminado sozinho');
      assert.equal(typeof r.status, 'number');
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Configuração de e-mail inválida/);
      assert.match(r.stderr, /EMAIL_MODO: nenhum provedor de e-mail disponível para production/);
      assert.equal(r.stdout.includes('rodando na porta'), false);
      for (const outro of ['Configuração HTTP inválida', 'Configuração de autenticação inválida', 'Configuração do Turnstile inválida']) {
        assert.equal(r.stderr.includes(outro), false, `a falha deveria ser só da entrega de e-mail (${outro})`);
      }
      // O modo é um literal conhecido do projeto; o que não pode aparecer é segredo ou o caminho recebido.
      assertSemSensiveis(r.stdout + r.stderr, [...SEGREDOS, extra.EMAIL_ARQUIVO_DIRETORIO], 'saída do processo');
    });
  }

  test('o erro de configuração não ecoa os valores recebidos nem segredos', async () => {
    const extra = { EMAIL_MODO: 'modoEstranho123', EMAIL_ARQUIVO_DIRETORIO: '/caminho/segredo-xyz-987' };
    const r = await subirServidor({ ...PRODUCAO, ...extra });
    assert.equal(r.escutou, false, 'o servidor chegou a escutar a porta');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Configuração de e-mail inválida/);
    assert.match(r.stderr, /EMAIL_MODO: /);
    assertSemSensiveis(r.stdout + r.stderr, [...SEGREDOS, ...Object.values(extra), 'segredo-xyz-987'], 'saída do processo');
  });
});
