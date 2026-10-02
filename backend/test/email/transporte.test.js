'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Transportes do e-mail transacional (Bloco 11H): desativado e arquivo. O
 * modo arquivo grava o TXT (cabeçalhos mais texto) e o HTML irmão para revisão
 * visual em desenvolvimento, restritos ao dono e fora do repositório.
 */

const transporte = () => exigirModulo('src/email/transporte');
const EMAIL = 'pessoa.destinataria@example.invalid';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const REMETENTE = { nome: 'SafeWork Engenharia', endereco: 'no-reply@safeworkengenharia.com.br' };

let raiz;
let diretorio;

const mensagem = (extra = {}) => ({
  tipo: 'RECUPERACAO_SENHA',
  escopo: 'PORTAL',
  para: EMAIL,
  assunto: 'Redefinição de senha — Portal do Cliente',
  texto: `Linha 1\nhttps://app.exemplo.test/portal/redefinir-senha.html#token=${TOKEN}\n`,
  html: '<html><body><img src="cid:marca-safework" alt="SafeWork Engenharia"><p>Olá</p></body></html>',
  ...extra,
});
const emArquivo = () => transporte().criarTransporte({ modo: 'arquivo', arquivo: { diretorio }, smtp: null, remetente: REMETENTE, suporte: 'suporte@safeworkengenharia.com.br' });
const arquivos = () => (fs.existsSync(diretorio) ? fs.readdirSync(diretorio).sort() : []);

beforeEach(() => {
  raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-transporte-'));
  diretorio = path.join(raiz, 'emails');
});

afterEach(() => {
  fs.rmSync(raiz, { recursive: true, force: true });
});

describe('criarTransporte', () => {
  test('escolhe a implementação pelo modo e recusa modo desconhecido ou smtp sem configuração', () => {
    assert.equal(transporte().criarTransporte({ modo: 'desativado', arquivo: null, smtp: null, remetente: REMETENTE }).modo, 'desativado');
    assert.equal(emArquivo().modo, 'arquivo');
    assert.throws(() => transporte().criarTransporte({ modo: 'outro', remetente: REMETENTE }), TypeError);
    assert.throws(() => transporte().criarTransporte({ modo: 'smtp', smtp: null, remetente: REMETENTE }), TypeError);
    assert.throws(() => transporte().criarTransporte({ modo: 'arquivo', arquivo: null, remetente: REMETENTE }), TypeError);
  });

  test('toda implementação expõe enviar e fechar', () => {
    for (const t of [transporte().criarTransporte({ modo: 'desativado', smtp: null, arquivo: null, remetente: REMETENTE }), emArquivo()]) {
      assert.equal(typeof t.enviar, 'function');
      assert.equal(typeof t.fechar, 'function');
    }
  });
});

describe('transporte desativado', () => {
  test('descarta a mensagem sem escrever nada e informa que não houve envio', async () => {
    const t = transporte().criarTransporte({ modo: 'desativado', arquivo: null, smtp: null, remetente: REMETENTE });
    assert.deepEqual(await t.enviar(mensagem()), { estado: 'NAO_ENVIADO' });
    assert.deepEqual(arquivos(), []);
  });
});

describe('transporte arquivo', () => {
  test('grava o TXT e o HTML irmão, restritos ao dono, sem dado sensível no nome', async () => {
    const r = await emArquivo().enviar(mensagem());
    assert.deepEqual(r, { estado: 'GRAVADO' });

    const nomes = arquivos();
    assert.equal(nomes.length, 2);
    const [html, txt] = nomes;
    assert.match(txt, /^\d{8}T\d{9}Z-recuperacao_senha-portal-[0-9a-f]{12}\.txt$/);
    assert.equal(html, txt.replace(/\.txt$/, '.html'));
    for (const nome of nomes) {
      for (const sensivel of [TOKEN, EMAIL, 'pessoa.destinataria']) assert.equal(nome.includes(sensivel), false);
      assert.equal(fs.statSync(path.join(diretorio, nome)).mode & 0o777, 0o600);
    }
    assert.equal(fs.statSync(diretorio).mode & 0o777, 0o700);
  });

  test('o TXT leva Para, Assunto e o texto; o HTML leva a marca embutida só para a revisão visual', async () => {
    await emArquivo().enviar(mensagem());
    const [html, txt] = arquivos().map((n) => fs.readFileSync(path.join(diretorio, n), 'utf8'));
    assert.ok(txt.startsWith(`Para: ${EMAIL}\nAssunto: Redefinição de senha — Portal do Cliente\n\n`));
    assert.ok(txt.includes(`#token=${TOKEN}`));
    assert.match(html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
    assert.doesNotMatch(html, /cid:/);
  });

  test('cada mensagem vai para um par de arquivos próprio; o escopo e o tipo aparecem no nome', async () => {
    const t = emArquivo();
    await t.enviar(mensagem());
    await t.enviar(mensagem({ tipo: 'CONVITE_MASTER', escopo: 'PLATAFORMA' }));
    const nomes = arquivos();
    assert.equal(nomes.length, 4);
    assert.equal(nomes.filter((n) => /-convite_master-plataforma-/.test(n)).length, 2);
  });

  test('falha ao gravar rejeita com código seguro, sem caminho, destinatário nem conteúdo', async () => {
    fs.mkdirSync(raiz, { recursive: true });
    fs.writeFileSync(diretorio, 'não é diretório');
    await assert.rejects(() => emArquivo().enviar(mensagem()), (erro) => {
      assert.match(erro.codigo, /^[A-Z0-9_]{1,40}$/);
      const texto = `${erro.message} ${JSON.stringify(erro)}`;
      for (const sensivel of [raiz, EMAIL, TOKEN, 'pessoa.destinataria']) assert.equal(texto.includes(sensivel), false);
      return true;
    });
  });
});
