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
 * Em production o e-mail transacional depende de um provedor SMTP real, e os
 * links dos e-mails dependem das URLs públicas do Portal e do Painel. Sem
 * elas, o processo não pode subir: a falha tem de acontecer na inicialização,
 * antes de escutar a porta, citando só o nome da variável e a regra.
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
const SENHA_SMTP = `senha-smtp-${crypto.randomBytes(12).toString('hex')}`;

// Tudo o que production exige, menos o e-mail.
const BASE_PRODUCAO = Object.freeze({
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  PORT: '0',
  LOGIN_COOLDOWN_HMAC_SECRET: SEGREDO_HMAC,
  MFA_TOTP_KEY_CURRENT_VERSION: '1',
  MFA_TOTP_KEY_V1: CHAVE_MFA,
  CORS_ORIGIN: 'https://epi.example.com',
  PLATAFORMA_CORS_ORIGIN: 'https://admin.example.com',
  PLATAFORMA_HOST: 'admin.example.com',
  PORTAL_URL_PUBLICA: 'https://epi.example.com',
  PAINEL_URL_PUBLICA: 'https://admin.example.com',
  TURNSTILE_PORTAL_SITE_KEY: '0x4AAAAAAAsiteFicticiaParaTeste',
  TURNSTILE_PORTAL_SECRET_KEY: SECRET_TURNSTILE,
});

const SMTP_VALIDO = Object.freeze({
  EMAIL_MODO: 'smtp',
  SMTP_HOST: 'smtp.example.test',
  SMTP_SEGURANCA: 'starttls',
  SMTP_USUARIO: 'conta-ficticia',
  SMTP_SENHA: SENHA_SMTP,
});

const PRODUCAO = Object.freeze({ ...BASE_PRODUCAO, ...SMTP_VALIDO });

const DESENVOLVIMENTO = Object.freeze({
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  PORT: '0',
  LOGIN_COOLDOWN_HMAC_SECRET: SEGREDO_HMAC,
  MFA_TOTP_KEY_CURRENT_VERSION: '1',
  MFA_TOTP_KEY_V1: CHAVE_MFA,
});

const SEGREDOS = [SEGREDO_HMAC, CHAVE_MFA, SECRET_TURNSTILE, SENHA_SMTP];

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
  test('a fixture de production é aceita pelos módulos de configuração (HTTP, autenticação, Turnstile, MFA e e-mail)', () => {
    const carregar = "for (const m of ['http', 'auth', 'turnstile', 'mfa', 'email']) require('./src/config/' + m); process.exit(0)";
    const r = spawnSync(process.execPath, ['-e', carregar], { cwd: RAIZ, env: { ...PRODUCAO }, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assertSemSensiveis(r.stdout + r.stderr, SEGREDOS, 'saída do processo');
  });

  test('production com SMTP válido e URLs públicas sobe e chega a escutar a porta, sem imprimir segredo', async () => {
    const r = await subirServidor({ ...PRODUCAO });
    assert.equal(r.escutou, true, r.stderr);
    assert.equal(r.encerradoPeloTeste, true);
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
      const r = await subirServidor({ ...BASE_PRODUCAO, ...extra });
      assert.equal(r.escutou, false, 'o servidor chegou a escutar a porta');
      assert.equal(r.encerradoPeloTeste, false, 'o processo deveria ter terminado sozinho');
      assert.equal(typeof r.status, 'number');
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /Configuração de e-mail inválida/);
      assert.match(r.stderr, /EMAIL_MODO: em production só o modo smtp é aceito/);
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
    const r = await subirServidor({ ...BASE_PRODUCAO, ...extra });
    assert.equal(r.escutou, false, 'o servidor chegou a escutar a porta');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Configuração de e-mail inválida/);
    assert.match(r.stderr, /EMAIL_MODO: /);
    assertSemSensiveis(r.stdout + r.stderr, [...SEGREDOS, ...Object.values(extra), 'segredo-xyz-987'], 'saída do processo');
  });
});

describe('production com SMTP incompleto ou inseguro não sobe', () => {
  const sem = (...nomes) => Object.fromEntries(Object.entries(PRODUCAO).filter(([nome]) => !nomes.includes(nome)));
  const casos = [
    ['sem SMTP_HOST', sem('SMTP_HOST'), /Configuração de e-mail inválida[\s\S]*SMTP_HOST: /],
    ['sem SMTP_USUARIO', sem('SMTP_USUARIO'), /Configuração de e-mail inválida[\s\S]*SMTP_USUARIO: /],
    ['sem SMTP_SENHA', sem('SMTP_SENHA'), /Configuração de e-mail inválida[\s\S]*SMTP_SENHA: /],
    ['SMTP_SEGURANCA=nenhuma (sem TLS)', { ...PRODUCAO, SMTP_SEGURANCA: 'nenhuma' }, /Configuração de e-mail inválida[\s\S]*SMTP_SEGURANCA: /],
    ['sem PORTAL_URL_PUBLICA', sem('PORTAL_URL_PUBLICA'), /Configuração HTTP inválida[\s\S]*PORTAL_URL_PUBLICA: /],
    ['sem PAINEL_URL_PUBLICA', sem('PAINEL_URL_PUBLICA'), /Configuração HTTP inválida[\s\S]*PAINEL_URL_PUBLICA: /],
    ['PORTAL_URL_PUBLICA em http', { ...PRODUCAO, PORTAL_URL_PUBLICA: 'http://epi.example.com' }, /Configuração HTTP inválida[\s\S]*PORTAL_URL_PUBLICA: /],
    ['PAINEL_URL_PUBLICA fora das origens permitidas', { ...PRODUCAO, PAINEL_URL_PUBLICA: 'https://outro.example.com' }, /Configuração HTTP inválida[\s\S]*PAINEL_URL_PUBLICA: /],
  ];

  for (const [nome, env, esperado] of casos) {
    test(`${nome}: falha antes de escutar a porta, citando só a variável, sem ecoar valores nem segredos`, async () => {
      const r = await subirServidor(env);
      assert.equal(r.escutou, false, 'o servidor chegou a escutar a porta');
      assert.equal(r.encerradoPeloTeste, false, 'o processo deveria ter terminado sozinho');
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, esperado);
      assertSemSensiveis(r.stdout + r.stderr, [...SEGREDOS, 'outro.example.com'], 'saída do processo');
    });
  }
});
