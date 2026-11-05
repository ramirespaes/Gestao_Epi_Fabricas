'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/**
 * G-B (D-ORF-6): o server.js REAL com BIND_ADDRESS. Mesmo padrão do teste de subida existente: processo filho, diretório de trabalho
 * vazio (nenhum .env), porta efêmera, encerramento imediato. Valor válido sobe e declara o endereço; valor inválido impede a subida
 * antes de escutar e não ecoa o valor.
 */

const SERVIDOR = path.join(__dirname, '..', '..', 'src', 'server.js');
const BASE = Object.freeze({
  PATH: process.env.PATH,
  NODE_ENV: 'development',
  PORT: '0',
  LOGIN_COOLDOWN_HMAC_SECRET: crypto.randomBytes(32).toString('hex'),
  MFA_TOTP_KEY_CURRENT_VERSION: '1',
  MFA_TOTP_KEY_V1: crypto.randomBytes(32).toString('hex'),
});

let diretorioVazio;
before(() => { diretorioVazio = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-bind-')); });
after(() => { fs.rmSync(diretorioVazio, { recursive: true, force: true }); });

function subir(env, limiteMs = 15000) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [SERVIDOR], { cwd: diretorioVazio, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let escutou = false;
    const encerrar = () => filho.kill('SIGKILL');
    const relogio = setTimeout(encerrar, limiteMs);
    filho.stdout.on('data', (dados) => {
      stdout += dados;
      if (!escutou && /rodando na porta/.test(stdout)) { escutou = true; encerrar(); }
    });
    filho.stderr.on('data', (dados) => { stderr += dados; });
    filho.on('close', (status, sinal) => { clearTimeout(relogio); resolve({ status, sinal, stdout, stderr, escutou }); });
  });
}

describe('[BIND-SRV] server.js real com BIND_ADDRESS', () => {
  test('BIND-20 — 127.0.0.1: sobe, escuta e declara o endereço no log', async () => {
    const r = await subir({ ...BASE, BIND_ADDRESS: '127.0.0.1' });
    assert.equal(r.escutou, true, r.stderr);
    assert.match(r.stdout, /rodando na porta 0 \(endereço 127\.0\.0\.1\)/);
  });

  test('BIND-21 — ::1: sobe e declara o endereço IPv6 (pulado se o ambiente não tem IPv6 loopback)', async (t) => {
    const r = await subir({ ...BASE, BIND_ADDRESS: '::1' });
    if (!r.escutou && /EADDRNOTAVAIL|EAFNOSUPPORT/.test(r.stderr)) { t.skip('sem IPv6 loopback neste ambiente'); return; }
    assert.equal(r.escutou, true, r.stderr);
    assert.match(r.stdout, /\(endereço ::1\)/);
  });

  test('BIND-22 — sem BIND_ADDRESS: sobe como antes e o log não cita endereço', async () => {
    const r = await subir({ ...BASE });
    assert.equal(r.escutou, true, r.stderr);
    assert.match(r.stdout, /rodando na porta 0\s*$/m);
    assert.equal(/endereço/.test(r.stdout), false);
  });

  test('BIND-23 — valor inválido: o processo termina com erro ANTES de escutar e nada ecoa o valor', async () => {
    const valor = 'nao-e-um-ip-xyz';
    const r = await subir({ ...BASE, BIND_ADDRESS: valor });
    assert.equal(r.escutou, false);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /BIND_ADDRESS/);
    assert.equal((r.stdout + r.stderr).includes(valor), false, 'o valor não pode aparecer na saída');
  });
});

/** Ocupa uma porta efêmera NO MESMO endereço que o servidor tentará usar (único jeito portátil de provocar EADDRINUSE entre macOS e Linux). */
function ocupar(endereco) {
  return new Promise((resolve, reject) => {
    const ocupante = net.createServer();
    ocupante.once('error', reject);
    const aoOuvir = () => resolve({ porta: ocupante.address().port, fechar: () => new Promise((fim) => ocupante.close(fim)) });
    if (endereco === undefined) ocupante.listen(0, aoOuvir); else ocupante.listen(0, endereco, aoOuvir);
  });
}

describe('[BIND-ERR] erro de escuta nunca é declarado como sucesso', () => {
  test('BIND-24 — IP válido que não pertence à máquina (EADDRNOTAVAIL): sai com código 1, diz o motivo no stderr e não afirma que está rodando', async (t) => {
    const r = await subir({ ...BASE, BIND_ADDRESS: '198.51.100.7' });
    if (r.escutou) { t.skip('este sistema aceita bind em IP não local (ip_nonlocal_bind)'); return; }
    assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /não conseguiu escutar na porta 0 \(endereço 198\.51\.100\.7\): EADDRNOTAVAIL/);
    assert.equal(/rodando na porta/.test(r.stdout + r.stderr), false, 'não pode declarar sucesso');
  });

  test('BIND-25 — porta ocupada com BIND_ADDRESS (EADDRINUSE): sai com código 1 e não afirma que está rodando', async () => {
    const ocupante = await ocupar('127.0.0.1');
    try {
      const r = await subir({ ...BASE, PORT: String(ocupante.porta), BIND_ADDRESS: '127.0.0.1' });
      assert.equal(r.escutou, false, r.stdout);
      assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`não conseguiu escutar na porta ${ocupante.porta} \\(endereço 127\\.0\\.0\\.1\\): EADDRINUSE`));
      assert.equal(/rodando na porta/.test(r.stdout + r.stderr), false);
    } finally { await ocupante.fechar(); }
  });

  test('BIND-26 — porta ocupada SEM BIND_ADDRESS (comportamento anterior, agora com erro correto): sai com código 1 e o log não cita endereço', async () => {
    const ocupante = await ocupar(undefined);
    try {
      const r = await subir({ ...BASE, PORT: String(ocupante.porta) });
      assert.equal(r.escutou, false, r.stdout);
      assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, new RegExp(`não conseguiu escutar na porta ${ocupante.porta}: EADDRINUSE`));
      assert.equal(/endereço|rodando na porta/.test(r.stdout + r.stderr), false);
    } finally { await ocupante.fechar(); }
  });

  test('BIND-27 — o código do erro é saneado: só maiúsculas, dígitos e sublinhado aparecem na mensagem', () => {
    const origem = fs.readFileSync(SERVIDOR, 'utf8');
    assert.match(origem, /replace\(\/\[\^A-Z0-9_\]\/g, '\?'\)/);
    assert.equal(/erro\.message/.test(origem), false, 'a mensagem original do erro não é repassada ao log');
  });
});
