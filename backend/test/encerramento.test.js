'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { exigirModulo } = require('./helpers/exigir-modulo');
const { criarServicoEmail } = require('../src/email/servico-email');

/**
 * Encerramento gracioso (Bloco 11H). A fila de e-mail vive na memória do
 * processo: ao receber SIGTERM ou SIGINT o servidor para de aceitar conexões
 * e mensagens novas, espera as que já foram aceitas terminarem (até um
 * limite) e só então sai. Sem isso, um deploy descartaria e-mails de
 * recuperação já aceitos.
 */

const modulo = () => exigirModulo('src/encerramento');

function mundo({ pendentes = 0, falhaAoFechar = false } = {}) {
  const eventos = [];
  const registros = [];
  const servidor = { close: () => { eventos.push('servidor.close'); } };
  const servico = {
    parar: () => { eventos.push('servico.parar'); },
    aguardarOciosidade: async (limite) => { eventos.push(`servico.aguardarOciosidade(${limite})`); return { pendentes }; },
    fechar: async () => {
      eventos.push('servico.fechar');
      if (falhaAoFechar) throw new Error('falha ao fechar simulada');
    },
  };
  const sair = (codigo) => { eventos.push(`sair(${codigo})`); };
  const registrar = (etiqueta, campos) => { registros.push({ etiqueta, campos }); };
  return { eventos, registros, servidor, servico, sair, registrar };
}

const criar = (m, extra = {}) => modulo().criarEncerramento({
  servidor: m.servidor, servico: m.servico, sair: m.sair, registrar: m.registrar, ...extra,
});

describe('criarEncerramento', () => {
  test('ordem: para de aceitar, para a fila, espera drenar com o limite, fecha o transporte e sai com 0', async () => {
    const m = mundo();
    await criar(m, { limiteMs: 7000 }).encerrar('SIGTERM');
    assert.deepEqual(m.eventos, ['servidor.close', 'servico.parar', 'servico.aguardarOciosidade(7000)', 'servico.fechar', 'sair(0)']);
  });

  test('o limite padrão de espera é de 10 segundos', async () => {
    const m = mundo();
    await criar(m).encerrar('SIGINT');
    assert.ok(m.eventos.includes('servico.aguardarOciosidade(10000)'));
  });

  test('um segundo sinal durante o encerramento é ignorado: sai uma única vez', async () => {
    const m = mundo();
    const encerramento = criar(m);
    await Promise.all([encerramento.encerrar('SIGTERM'), encerramento.encerrar('SIGINT'), encerramento.encerrar('SIGTERM')]);
    assert.equal(m.eventos.filter((e) => e.startsWith('sair(')).length, 1);
    assert.equal(m.eventos.filter((e) => e === 'servico.parar').length, 1);
  });

  test('mensagens ainda pendentes depois do limite: sai com 1 e registra só a quantidade, sem destinatário nem conteúdo', async () => {
    const m = mundo({ pendentes: 3 });
    await criar(m).encerrar('SIGTERM');
    assert.deepEqual(m.eventos.at(-1), 'sair(1)');
    const registro = m.registros.find((r) => r.campos.evento === 'encerramento_com_pendentes');
    assert.ok(registro, 'registro do que ficou para trás');
    assert.deepEqual(registro.campos, { evento: 'encerramento_com_pendentes', pendentes: 3 });
  });

  test('falha ao fechar o transporte não impede a saída: sai com 1 e o registro não leva a mensagem do erro', async () => {
    const m = mundo({ falhaAoFechar: true });
    await criar(m).encerrar('SIGTERM');
    assert.equal(m.eventos.at(-1), 'sair(1)');
    assert.equal(JSON.stringify(m.registros).includes('falha ao fechar simulada'), false);
  });

  test('os registros levam só evento e sinal conhecido', async () => {
    const m = mundo();
    await criar(m).encerrar('SIGTERM');
    assert.deepEqual(m.registros[0], { etiqueta: '[server]', campos: { evento: 'encerrando', sinal: 'SIGTERM' } });
    const outro = mundo();
    await criar(outro).encerrar('QUALQUER');
    assert.deepEqual(outro.registros[0].campos, { evento: 'encerrando', sinal: 'DESCONHECIDO' });
  });

  test('instalar registra o tratamento de SIGTERM e SIGINT no processo informado', () => {
    const m = mundo();
    const ouvintes = new Map();
    const processoFalso = { on: (sinal, fn) => { ouvintes.set(sinal, fn); return processoFalso; } };
    criar(m).instalar(processoFalso);
    assert.deepEqual([...ouvintes.keys()].sort(), ['SIGINT', 'SIGTERM']);
  });
});

describe('encerramento com o serviço de e-mail real', () => {
  test('a mensagem já aceita termina de ser enviada antes da saída; a que chega depois é descartada', async () => {
    const ordem = [];
    let liberar;
    const trava = new Promise((resolver) => { liberar = resolver; });
    const transporte = {
      enviar: async () => { await trava; ordem.push('enviado'); return { estado: 'ENVIADO' }; },
      fechar: () => { ordem.push('transporte.fechado'); },
    };
    const servico = criarServicoEmail({ transporte, registrar: () => {} });
    const mensagem = {
      tipo: 'RECUPERACAO_SENHA', escopo: 'PORTAL', para: 'pessoa@exemplo-cliente.com.br', conteudo: { assunto: 'a', texto: 't', html: '<p>h</p>' },
    };
    servico.enfileirar(mensagem);
    await new Promise((resolver) => { setImmediate(resolver); });

    const encerramento = modulo().criarEncerramento({
      servidor: { close: () => {} }, servico, sair: (c) => ordem.push(`sair(${c})`), registrar: () => {}, limiteMs: 5000,
    });
    const terminou = encerramento.encerrar('SIGTERM');
    servico.enfileirar(mensagem);
    assert.equal(servico.estado().descartadas, 1, 'mensagem nova depois do sinal é descartada');
    liberar();
    await terminou;
    assert.deepEqual(ordem, ['enviado', 'transporte.fechado', 'sair(0)']);
  });
});

describe('server.js real recebendo sinal', () => {
  let diretorioVazio;
  before(() => { diretorioVazio = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-sinal-')); });
  after(() => { fs.rmSync(diretorioVazio, { recursive: true, force: true }); });

  const SERVIDOR = path.join(__dirname, '..', 'src', 'server.js');
  const env = () => ({
    PATH: process.env.PATH,
    NODE_ENV: 'development',
    PORT: '0',
    LOGIN_COOLDOWN_HMAC_SECRET: crypto.randomBytes(32).toString('hex'),
    MFA_TOTP_KEY_CURRENT_VERSION: '1',
    MFA_TOTP_KEY_V1: crypto.randomBytes(32).toString('hex'),
  });

  for (const sinal of ['SIGTERM', 'SIGINT']) {
    test(`${sinal}: o processo encerra sozinho, com status 0, depois de registrar o encerramento`, async () => {
      const r = await new Promise((resolve) => {
        const filho = spawn(process.execPath, [SERVIDOR], { cwd: diretorioVazio, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let enviado = false;
        const limite = setTimeout(() => filho.kill('SIGKILL'), 20000);
        filho.stdout.on('data', (d) => {
          stdout += d;
          if (!enviado && /rodando na porta/.test(stdout)) { enviado = true; filho.kill(sinal); }
        });
        filho.stderr.on('data', (d) => { stderr += d; });
        filho.on('close', (status, sinalRecebido) => { clearTimeout(limite); resolve({ status, sinalRecebido, stdout, stderr }); });
      });
      assert.equal(r.sinalRecebido, null, `morto pelo sinal em vez de encerrar sozinho: ${r.stderr}`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\[server\] \{ evento: 'encerrando', sinal: '(SIGTERM|SIGINT)' \}/);
    });
  }
});
