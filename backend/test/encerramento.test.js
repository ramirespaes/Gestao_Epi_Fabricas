'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { exigirModulo } = require('./helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('./storage/helpers/tmp-seguro');
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

/**
 * Processos filhos do processador de imagens (Biblioteca de Imagens, Unidade 5C-6): ao receber o sinal, o que ainda estiver rodando é encerrado por
 * `encerrarTodos()` depois do e-mail e antes da saída, mesmo que o e-mail tenha falhado. Sem `processos` (padrão), nada muda.
 */
describe('criarEncerramento — processos filhos (Unidade 5C-6)', () => {
  const comProcessos = (m, { falha = false } = {}) => ({
    encerrarTodos: async () => {
      m.eventos.push('processos.encerrarTodos');
      if (falha) throw new Error('falha simulada ao encerrar os filhos');
    },
  });

  test('PRC-01 — a ordem é: para de aceitar, para a fila, espera, fecha o transporte, ENCERRA OS FILHOS e só então sai', async () => {
    const m = mundo();
    await criar(m, { limiteMs: 7000, processos: comProcessos(m) }).encerrar('SIGTERM');
    assert.deepEqual(m.eventos, ['servidor.close', 'servico.parar', 'servico.aguardarOciosidade(7000)', 'servico.fechar', 'processos.encerrarTodos', 'sair(0)']);
  });

  test('PRC-02 — sem `processos` (omitido ou nulo) nada muda: os mesmos cinco eventos de antes', async () => {
    for (const extra of [{}, { processos: null }]) {
      const m = mundo();
      await criar(m, { limiteMs: 7000, ...extra }).encerrar('SIGTERM');
      assert.deepEqual(m.eventos, ['servidor.close', 'servico.parar', 'servico.aguardarOciosidade(7000)', 'servico.fechar', 'sair(0)']);
    }
  });

  test('PRC-03 — falha ao encerrar os filhos não impede a saída: sai com 1 e o registro não leva a mensagem do erro', async () => {
    const m = mundo();
    await criar(m, { processos: comProcessos(m, { falha: true }) }).encerrar('SIGTERM');
    assert.equal(m.eventos.at(-1), 'sair(1)');
    assert.ok(m.registros.some((r) => r.campos.evento === 'encerramento_processos_falhou'));
    assert.equal(JSON.stringify(m.registros).includes('falha simulada ao encerrar os filhos'), false);
  });

  test('PRC-04 — falha ao fechar o transporte de e-mail NÃO impede encerrar os filhos: ambos acontecem e a saída é 1', async () => {
    const m = mundo({ falhaAoFechar: true });
    await criar(m, { processos: comProcessos(m) }).encerrar('SIGTERM');
    assert.ok(m.eventos.includes('processos.encerrarTodos'));
    assert.equal(m.eventos.at(-1), 'sair(1)');
  });

  test('PRC-05 — mensagens de e-mail ainda pendentes depois do limite também não impedem encerrar os filhos', async () => {
    const m = mundo({ pendentes: 2 });
    await criar(m, { processos: comProcessos(m) }).encerrar('SIGTERM');
    assert.ok(m.eventos.includes('processos.encerrarTodos'));
    assert.equal(m.eventos.at(-1), 'sair(1)');
  });

  test('PRC-06 — sinais repetidos encerram os filhos uma única vez e saem uma única vez', async () => {
    const m = mundo();
    const encerramento = criar(m, { processos: comProcessos(m) });
    await Promise.all([encerramento.encerrar('SIGTERM'), encerramento.encerrar('SIGINT'), encerramento.encerrar('SIGTERM')]);
    assert.equal(m.eventos.filter((e) => e === 'processos.encerrarTodos').length, 1);
    assert.equal(m.eventos.filter((e) => e.startsWith('sair(')).length, 1);
  });

  test('PRC-07 — `processos` sem encerrarTodos é recusado ao criar o encerramento, antes de qualquer sinal', () => {
    const m = mundo();
    for (const invalido of [{}, { encerrarTodos: 'nao' }, 'processos', 7, []]) {
      assert.throws(() => criar(m, { processos: invalido }), TypeError, JSON.stringify(invalido));
    }
  });

  test('PRC-08 — com o processador REAL e um filho vivo: o filho é morto e o processador termina ANTES da saída', async () => {
    const { criarProcessadorDeImagens } = require('../src/services/imagem-processador.service');
    const { png } = require('./helpers/imagens-validas');
    const travado = path.join(__dirname, 'helpers', 'filhos', 'travado.js');
    const vistos = [];
    const spawnar = (...argumentos) => { const filho = spawn(...argumentos); vistos.push(filho); return filho; };
    const processador = criarProcessadorDeImagens({ caminhoDoFilho: travado, spawnar, prazoExternoMs: 30000, esperaPelaMorteMs: 1000 });
    const m = mundo();
    let emAndamento;
    try {
      emAndamento = processador.processar(png(320, 320)).catch((erro) => erro);
      await new Promise((resolver) => { setTimeout(resolver, 150); });
      assert.equal(processador.ativos().length, 1, 'o teste só vale com um filho vivo');
      const encerramento = criar(m, { processos: processador, sair: (c) => { m.eventos.push(`sair(${c}) com ${processador.ativos().length} filhos`); } });
      await encerramento.encerrar('SIGTERM');
      assert.equal(m.eventos.at(-1), 'sair(0) com 0 filhos');
      const erro = await emAndamento;
      assert.equal(erro.codigo, 'IMAGEM_FILHO_ENCERRADO');
    } finally {
      for (const filho of vistos) { if (filho.exitCode === null && filho.signalCode === null) filho.kill('SIGKILL'); }
    }
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

  test('com o processador de imagens LIGADO pelo ambiente (Unidade 5C-6) o servidor sobe e encerra sozinho com status 0, sem registrar falha de filhos', async () => {
    const raiz = criarRaizTemporaria();
    try {
      const r = await new Promise((resolve) => {
        const ambiente = { ...env(), IMAGENS_PROCESSADOR_REAL: 'ativo', IMAGENS_ARMAZENAMENTO_DIRETORIO: raiz };
        const filho = spawn(process.execPath, [SERVIDOR], { cwd: diretorioVazio, env: ambiente, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let enviado = false;
        const limite = setTimeout(() => filho.kill('SIGKILL'), 20000);
        filho.stdout.on('data', (d) => {
          stdout += d;
          if (!enviado && /rodando na porta/.test(stdout)) { enviado = true; filho.kill('SIGTERM'); }
        });
        filho.stderr.on('data', (d) => { stderr += d; });
        filho.on('close', (status, sinalRecebido) => { clearTimeout(limite); resolve({ status, sinalRecebido, stdout, stderr }); });
      });
      assert.equal(r.sinalRecebido, null, `morto pelo sinal em vez de encerrar sozinho: ${r.stderr}`);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\[server\] \{ evento: 'encerrando', sinal: 'SIGTERM' \}/);
      assert.doesNotMatch(r.stdout, /encerramento_processos_falhou/);
    } finally {
      removerTemporarioSeguro(raiz);
    }
  });
});
