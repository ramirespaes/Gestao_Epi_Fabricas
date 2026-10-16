'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const T = require('../js/atendimento-token');
const centralSchemas = require('../../backend/src/schemas/token-central.schema');

/**
 * K7 — Consulta real da prévia do Totem (RED), módulo da Central: o caminho e o corpo exatamente como o servidor aceita (o identificador
 * SÓ no corpo do POST, nunca na URL), validação local igual à do servidor antes de qualquer rede, e um modelo que recusa resposta fora do
 * formato e deixa passar SÓ os campos da lista (primeiro nome, GHE e catálogo). Valores fictícios.
 */

const BASE = 'http://localhost:3000/api';
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

let chamadas;
beforeEach(() => {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      chamadas.push({ url, metodo: opcoes.method, credentials: opcoes.credentials, corpo: opcoes.body === undefined ? undefined : JSON.parse(opcoes.body) });
      return resposta(200, { status: 'ok' });
    },
  });
});

const exigirAcao = () => assert.equal(typeof T.acoes.previaIdentificar, 'function', 'RED K7: acoes.previaIdentificar ainda não existe (comportamento ausente)');
const exigirModelo = () => assert.equal(typeof T.modelo.previaIdentificar, 'function', 'RED K7: modelo.previaIdentificar ainda não existe (comportamento ausente)');

const MATERIAL = Object.freeze({
  id: 11, nome: 'Botina de Segurança', unidade: 'PAR', categoria: 'EPI', grupoProtecao: 'Proteção dos pés', tipo: { id: 1, nome: 'Botina de Segurança' }, exigeTamanho: true, tamanhos: ['40', '41'], imagem: { disponivel: false },
});
const RESPOSTA = () => ({
  status: 'ok',
  previa: {
    funcionario: { primeiroNome: 'Ana' },
    ghe: { codigo: 'GHE-102', descricao: 'Soldagem', ativo: true },
    catalogo: { estado: 'OK', total: 1, materiais: [{ ...MATERIAL }] },
  },
});

describe('K7 — acoes.previaIdentificar', () => {
  test('POST /atendimento-token/previa/identificar com a sessão do cookie e o corpo { tipo, valor }; o identificador nunca vai na URL', async () => {
    exigirAcao();
    for (const [tipo, valor] of [['MATRICULA', 'MX-4242'], ['CPF', '12345678901']]) {
      await T.acoes.previaIdentificar(tipo, valor);
      const c = chamadas[chamadas.length - 1];
      assert.deepEqual([c.metodo, c.url, c.credentials, c.corpo], ['POST', `${BASE}/atendimento-token/previa/identificar`, 'include', { tipo, valor }]);
      assert.equal(c.url.includes(valor), false);
    }
  });

  test('o corpo é aceito pelo schema real do servidor, e campos de autoridade nunca são enviados', async () => {
    exigirAcao();
    await T.acoes.previaIdentificar('MATRICULA', 'MX-4242');
    await T.acoes.previaIdentificar('CPF', '12345678901');
    for (const c of chamadas) {
      assert.equal(centralSchemas.previaIdentificar.body.safeParse(c.corpo).success, true);
      assert.deepEqual(Object.keys(c.corpo).sort(), ['tipo', 'valor']);
    }
  });

  test('entrada inválida é recusada ANTES da rede (TypeError), sem repetir o valor na mensagem', () => {
    exigirAcao();
    const ruins = [['NOME', 'x'], ['CPF', ''], ['MATRICULA', ''], ['MATRICULA', 'x'.repeat(31)], ['MATRICULA', 'ab\ncd'], ['CPF', 12345678901], [undefined, 'x'], ['MATRICULA', undefined]];
    for (const [tipo, valor] of ruins) {
      assert.throws(() => T.acoes.previaIdentificar(tipo, valor), (e) => e instanceof TypeError && (typeof valor !== 'string' || valor.length < 3 || String(e.message).includes(valor) === false), JSON.stringify([tipo, valor]));
    }
    assert.deepEqual(chamadas, []);
  });
});

describe('K7 — modelo.previaIdentificar', () => {
  test('resposta válida: só primeiro nome, GHE e catálogo, com os campos que o Totem usa', () => {
    exigirModelo();
    const m = T.modelo.previaIdentificar(RESPOSTA());
    assert.deepEqual(Object.keys(m).sort(), ['catalogo', 'ghe', 'primeiroNome']);
    assert.equal(m.primeiroNome, 'Ana');
    assert.deepEqual(m.ghe, { codigo: 'GHE-102', descricao: 'Soldagem', ativo: true });
    assert.equal(m.catalogo.estado, 'OK');
    assert.equal(m.catalogo.total, 1);
    assert.deepEqual(m.catalogo.materiais[0], { ...MATERIAL });
  });

  test('GHE nulo (sem GHE) e código nulo (cadastro anterior) são aceitos', () => {
    exigirModelo();
    const semGhe = RESPOSTA(); semGhe.previa.ghe = null; semGhe.previa.catalogo = { estado: 'SEM_GHE', total: 0, materiais: [] };
    assert.equal(T.modelo.previaIdentificar(semGhe).ghe, null);
    const antigo = RESPOSTA(); antigo.previa.ghe.codigo = null;
    assert.equal(T.modelo.previaIdentificar(antigo).ghe.codigo, null);
  });

  test('campo fora da lista nunca passa adiante (cpf, matrícula, nome completo, ids), nem dentro do GHE ou do material', () => {
    exigirModelo();
    const r = RESPOSTA();
    r.previa.funcionario = { primeiroNome: 'Ana', nome: 'Ana Souza Fictícia', cpf: '12345678901', matricula: 'MX-1', id: 9 };
    r.previa.ghe.setor = 'Soldagem'; r.previa.ghe.id = 3;
    r.previa.catalogo.materiais[0].cpf = '123'; r.previa.catalogo.materiais[0].saldo = 40;
    r.cpf = '12345678901';
    const texto = JSON.stringify(T.modelo.previaIdentificar(r));
    for (const proibido of ['Souza', '12345678901', 'MX-1', 'setor', '"saldo"', '"cpf"']) assert.equal(texto.includes(proibido), false, proibido);
  });

  test('formato inesperado vira null (nunca um resultado parcial)', () => {
    exigirModelo();
    const casos = [];
    const base = () => RESPOSTA();
    let r = base(); r.previa.funcionario.primeiroNome = ''; casos.push(r);
    r = base(); r.previa.funcionario = null; casos.push(r);
    r = base(); r.previa.ghe = { codigo: 'G', descricao: '', ativo: true }; casos.push(r);
    r = base(); r.previa.ghe.ativo = 'sim'; casos.push(r);
    r = base(); r.previa.catalogo.estado = 'OUTRO'; casos.push(r);
    r = base(); r.previa.catalogo.materiais = 'x'; casos.push(r);
    r = base(); r.previa.catalogo.materiais[0].id = 0; casos.push(r);
    r = base(); r.previa.catalogo.materiais[0].tamanhos = [1]; casos.push(r);
    r = base(); r.previa.catalogo.materiais = Array.from({ length: 201 }, (_, i) => ({ ...MATERIAL, id: i + 1 })); r.previa.catalogo.total = 201; casos.push(r);
    casos.push(null, undefined, {}, { previa: null }, 'texto');
    for (const c of casos) assert.equal(T.modelo.previaIdentificar(c), null, JSON.stringify(c)?.slice(0, 60));
  });

  test('o modelo da prévia por id e as demais ações continuam como antes (controle)', async () => {
    await T.acoes.previa(31);
    assert.equal(chamadas[0].url, `${BASE}/atendimento-token/previa/catalogo?funcionarioId=31`);
    assert.equal(typeof T.modelo.previa, 'function');
  });
});
