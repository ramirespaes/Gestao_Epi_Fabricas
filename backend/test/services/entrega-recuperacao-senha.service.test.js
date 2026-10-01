'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { httpConfig } = require('../../src/config/http');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Entrega dos e-mails do ciclo de senha (Bloco 11C). Sem provedor real: a
 * mensagem é descartada (modo desativado) ou gravada em arquivo num diretório
 * fora do repositório (modo arquivo, só desenvolvimento). O link e o token
 * nunca vão para o console, e quem enfileira não espera a entrega.
 */

const entrega = () => exigirModulo('src/services/entrega-recuperacao-senha.service');

const EMAIL = 'pessoa.destinataria@example.invalid';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const EXPIRA = new Date('2026-10-02T15:00:00.000Z');
const SUPORTE = 'suporte@safeworkengenharia.com.br';

let diretorio;
let saidas;

function espiarConsole(t) {
  saidas = [];
  for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, metodo, (...argumentos) => { saidas.push(JSON.stringify(argumentos)); });
  }
}

const semSensiveisNoConsole = () => {
  const texto = saidas.join('\n');
  for (const sensivel of [TOKEN, EMAIL, 'pessoa.destinataria', '#token=', 'redefinir-senha.html']) {
    assert.equal(texto.includes(sensivel), false, `console contém ${sensivel}`);
  }
};

const arquivos = () => (fs.existsSync(diretorio) ? fs.readdirSync(diretorio) : []);
const emArquivo = () => entrega().criarEntrega({ config: { modo: 'arquivo', arquivo: { diretorio } } });

beforeEach(() => {
  diretorio = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-entrega-')), 'emails');
});

afterEach(() => {
  fs.rmSync(path.dirname(diretorio), { recursive: true, force: true });
});

describe('link de redefinição', () => {
  test('aponta para a página pública de cada portal, na origem configurada, com o token só no fragmento', () => {
    const casos = [
      ['PORTAL', httpConfig.cors.origens[0], '/portal/redefinir-senha.html'],
      ['PLATAFORMA', httpConfig.plataforma.corsOrigens[0], '/painel-privado/redefinir-senha.html'],
    ];
    for (const [escopo, origem, caminho] of casos) {
      const link = new URL(entrega().montarLinkRedefinicao(escopo, TOKEN));
      assert.equal(link.origin, origem, escopo);
      assert.equal(link.pathname, caminho, escopo);
      assert.equal(link.search, '', 'o token nunca vai na query');
      assert.equal(link.hash, `#token=${TOKEN}`);
    }
    assert.throws(() => entrega().montarLinkRedefinicao('OUTRO', TOKEN), TypeError);
    assert.throws(() => entrega().montarLinkRedefinicao('PORTAL', ''), TypeError);
  });
});

describe('modo arquivo (desenvolvimento)', () => {
  test('grava a mensagem com o link num arquivo do diretório configurado, restrito ao dono, sem nada sensível no nome', async (t) => {
    espiarConsole(t);
    const instancia = emArquivo();
    const retorno = instancia.enfileirarRedefinicao({ escopo: 'PORTAL', email: EMAIL, token: TOKEN, expiraEm: EXPIRA });
    assert.equal(retorno, undefined, 'quem enfileira não recebe promessa para esperar');
    await instancia.aguardarOciosidade();

    const nomes = arquivos();
    assert.equal(nomes.length, 1);
    assert.match(nomes[0], /\.txt$/);
    for (const sensivel of [TOKEN, EMAIL, 'pessoa.destinataria']) assert.equal(nomes[0].includes(sensivel), false);
    const caminho = path.join(diretorio, nomes[0]);
    assert.equal(fs.statSync(caminho).mode & 0o777, 0o600);
    assert.equal(fs.statSync(diretorio).mode & 0o777, 0o700);

    const conteudo = fs.readFileSync(caminho, 'utf8');
    assert.ok(conteudo.includes(EMAIL), 'destinatário');
    assert.ok(conteudo.includes(instancia.montarLinkRedefinicao('PORTAL', TOKEN)), 'link completo');
    assert.ok(conteudo.includes(EXPIRA.toISOString()), 'validade');
    assert.ok(conteudo.includes(SUPORTE), 'contato de suporte');
    semSensiveisNoConsole();
  });

  test('cada mensagem vai para um arquivo próprio e o link do Painel Privado usa a origem da plataforma', async (t) => {
    espiarConsole(t);
    const instancia = emArquivo();
    instancia.enfileirarRedefinicao({ escopo: 'PORTAL', email: EMAIL, token: TOKEN, expiraEm: EXPIRA });
    instancia.enfileirarRedefinicao({ escopo: 'PLATAFORMA', email: EMAIL, token: TOKEN, expiraEm: EXPIRA });
    await instancia.aguardarOciosidade();

    const conteudos = arquivos().map((nome) => fs.readFileSync(path.join(diretorio, nome), 'utf8'));
    assert.equal(conteudos.length, 2);
    assert.equal(conteudos.filter((c) => c.includes(`${httpConfig.plataforma.corsOrigens[0]}/painel-privado/redefinir-senha.html#token=`)).length, 1);
    assert.equal(conteudos.filter((c) => c.includes(`${httpConfig.cors.origens[0]}/portal/redefinir-senha.html#token=`)).length, 1);
    semSensiveisNoConsole();
  });

  test('o remetente automático ainda não está definido: a mensagem não declara remetente e o suporte só aparece como contato', async () => {
    const instancia = emArquivo();
    instancia.enfileirarRedefinicao({ escopo: 'PORTAL', email: EMAIL, token: TOKEN, expiraEm: EXPIRA });
    await instancia.aguardarOciosidade();
    const conteudo = fs.readFileSync(path.join(diretorio, arquivos()[0]), 'utf8');
    assert.doesNotMatch(conteudo, /^(De|From|Remetente):/mi);
  });

  test('aviso de senha alterada: sem token, sem link de redefinição e sem a senha', async (t) => {
    espiarConsole(t);
    const instancia = emArquivo();
    assert.equal(instancia.enfileirarAvisoSenhaAlterada({ escopo: 'PORTAL', email: EMAIL }), undefined);
    await instancia.aguardarOciosidade();

    const conteudo = fs.readFileSync(path.join(diretorio, arquivos()[0]), 'utf8');
    assert.ok(conteudo.includes(EMAIL));
    assert.ok(conteudo.includes(SUPORTE));
    for (const proibido of ['#token=', 'redefinir-senha.html', TOKEN]) assert.equal(conteudo.includes(proibido), false, proibido);
    semSensiveisNoConsole();
  });

  test('falha ao gravar não lança para quem enfileirou e o registro técnico não leva dado sensível', async (t) => {
    espiarConsole(t);
    // O "diretório" é um arquivo comum: a gravação falha de verdade.
    fs.mkdirSync(path.dirname(diretorio), { recursive: true });
    fs.writeFileSync(diretorio, 'não é diretório');
    const instancia = emArquivo();
    assert.doesNotThrow(() => instancia.enfileirarRedefinicao({ escopo: 'PORTAL', email: EMAIL, token: TOKEN, expiraEm: EXPIRA }));
    await instancia.aguardarOciosidade();

    assert.equal(saidas.length, 1, 'uma linha de registro técnico da falha');
    assert.match(saidas[0], /entrega_falhou/);
    semSensiveisNoConsole();
  });

  test('falha de entrega não deixa promessa rejeitada sem tratamento', async (t) => {
    espiarConsole(t);
    const rejeicoes = [];
    const ouvinte = (motivo) => { rejeicoes.push(motivo); };
    process.on('unhandledRejection', ouvinte);
    try {
      fs.mkdirSync(path.dirname(diretorio), { recursive: true });
      fs.writeFileSync(diretorio, 'não é diretório');
      const instancia = emArquivo();
      instancia.enfileirarRedefinicao({ escopo: 'PORTAL', email: EMAIL, token: TOKEN, expiraEm: EXPIRA });
      instancia.enfileirarAvisoSenhaAlterada({ escopo: 'PLATAFORMA', email: EMAIL });
      await instancia.aguardarOciosidade();
      // Duas voltas do laço de eventos: tempo para uma rejeição solta ser notada.
      await new Promise((resolve) => { setImmediate(resolve); });
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.deepEqual(rejeicoes, []);
      assert.equal(saidas.length, 2, 'uma linha de registro técnico por mensagem que falhou');
      semSensiveisNoConsole();
    } finally {
      process.off('unhandledRejection', ouvinte);
    }
  });
});

describe('modo desativado', () => {
  test('descarta a mensagem: nenhum arquivo, nenhuma exceção e nada sensível no console', async (t) => {
    espiarConsole(t);
    const instancia = entrega().criarEntrega({ config: { modo: 'desativado', arquivo: null } });
    assert.equal(instancia.enfileirarRedefinicao({ escopo: 'PORTAL', email: EMAIL, token: TOKEN, expiraEm: EXPIRA }), undefined);
    assert.equal(instancia.enfileirarAvisoSenhaAlterada({ escopo: 'PLATAFORMA', email: EMAIL }), undefined);
    await instancia.aguardarOciosidade();
    assert.deepEqual(arquivos(), []);
    semSensiveisNoConsole();
  });

  test('a instância padrão do módulo segue a configuração carregada (desativada nos testes) e expõe as mesmas funções', async (t) => {
    espiarConsole(t);
    const modulo = entrega();
    for (const funcao of ['enfileirarRedefinicao', 'enfileirarAvisoSenhaAlterada', 'aguardarOciosidade', 'montarLinkRedefinicao', 'criarEntrega']) {
      assert.equal(typeof modulo[funcao], 'function', funcao);
    }
    modulo.enfileirarRedefinicao({ escopo: 'PORTAL', email: EMAIL, token: TOKEN, expiraEm: EXPIRA });
    await modulo.aguardarOciosidade();
    semSensiveisNoConsole();
  });
});

describe('entrada inválida é erro de programação', () => {
  test('escopo desconhecido, e-mail ou token ausentes e validade que não é data são recusados na hora', () => {
    const instancia = emArquivo();
    const base = { escopo: 'PORTAL', email: EMAIL, token: TOKEN, expiraEm: EXPIRA };
    for (const ruim of [{ escopo: 'OUTRO' }, { email: '' }, { email: 42 }, { token: '' }, { token: null }, { expiraEm: 'amanhã' }, { expiraEm: new Date('x') }]) {
      assert.throws(() => instancia.enfileirarRedefinicao({ ...base, ...ruim }), TypeError, JSON.stringify(ruim));
    }
    for (const ruim of [{ escopo: 'OUTRO' }, { email: '' }]) {
      assert.throws(() => instancia.enfileirarAvisoSenhaAlterada({ escopo: 'PORTAL', email: EMAIL, ...ruim }), TypeError, JSON.stringify(ruim));
    }
    assert.deepEqual(arquivos(), []);
  });
});
