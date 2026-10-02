'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { criarConviteUsuarioController } = require('../../src/controllers/convite-usuario.controller');
const { criarConviteMasterController } = require('../../src/controllers/convite-master.controller');
const conviteUsuarioService = require('../../src/services/convite-usuario.service');
const conviteMasterService = require('../../src/services/convite-master.service');

/**
 * Controllers do reenvio de convite (Bloco 11H), sem Express e sem banco: o
 * serviço e a entrega são substituídos. O controller só traduz: empresa e
 * ator vêm da sessão, nunca do corpo; o token em claro só passa pela
 * entrega; um convite persistido responde 201 mesmo que o envio tenha
 * falhado, porque ele segue pendente e pode ser reenviado.
 */

const POOL = Object.freeze({ nome: 'pool-de-teste' });
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const EMAIL = 'pessoa.convidada@exemplo-cliente.com.br';
const EXPIRA = new Date('2026-10-02T14:00:00.000Z');
const IP = '203.0.113.7';
const AGENTE = 'Agente de Teste';

function resposta() {
  const r = {
    statusCode: null,
    corpo: undefined,
    cabecalhos: [],
    status(codigo) { r.statusCode = codigo; return r; },
    json(corpo) { r.corpo = corpo; return r; },
  };
  for (const metodo of ['append', 'setHeader', 'set', 'cookie', 'clearCookie', 'header']) {
    r[metodo] = (...argumentos) => { r.cabecalhos.push([metodo, ...argumentos]); return r; };
  }
  return r;
}

describe('convite de usuário — reenviar', () => {
  const conviteNovo = {
    id: '41', emailConvite: EMAIL, nome: 'Ana Souza', perfil: 'SUPERVISOR', situacao: 'PENDENTE', criadoEm: EXPIRA, expiraEm: EXPIRA, canceladoEm: null,
  };
  const requisicao = (extra = {}) => ({
    validado: { params: { conviteId: '40' }, body: {} },
    empresa: { id: 3, nome: 'Empresa Convidante Ltda', cnpj: '11222333000181' },
    usuario: { id: 5 },
    ip: IP,
    headers: { 'user-agent': AGENTE },
    ...extra,
  });

  function preparar(t, { entrega = { modo: 'DESENVOLVIMENTO_SEM_EMAIL', estado: 'NAO_ENVIADO', expiraEm: EXPIRA, linkAceite: `https://app.test/portal/aceitar-convite.html#token=${TOKEN}` } } = {}) {
    const servico = t.mock.method(conviteUsuarioService, 'reenviar', async () => ({ convite: conviteNovo, conviteAnteriorId: '40', token: TOKEN }));
    const entregar = t.mock.fn(async () => entrega);
    return { servico, entregar, controller: criarConviteUsuarioController({ pool: POOL, entregar }) };
  }

  test('chama o serviço com a empresa e o ator da SESSÃO, o convite da rota e o contexto do dispositivo', async (t) => {
    const { servico, controller } = preparar(t);
    const req = requisicao({ body: { empresaId: 99, atorId: 98 } });
    await controller.reenviar(req, resposta());

    assert.equal(servico.mock.calls.length, 1);
    const [pool, dados] = servico.mock.calls[0].arguments;
    assert.equal(pool, POOL);
    assert.deepEqual(dados, {
      empresaId: 3, atorId: 5, conviteId: '40', ip: IP, dispositivo: AGENTE,
    });
  });

  test('entrega o convite NOVO como reenvio, com o token em claro só para a entrega', async (t) => {
    const { entregar, controller } = preparar(t);
    await controller.reenviar(requisicao(), resposta());

    assert.equal(entregar.mock.calls.length, 1);
    assert.deepEqual(entregar.mock.calls[0].arguments[0], {
      conviteId: '41',
      empresaId: 3,
      token: TOKEN,
      expiraEm: EXPIRA,
      email: EMAIL,
      empresa: 'Empresa Convidante Ltda',
      nome: 'Ana Souza',
      perfil: 'SUPERVISOR',
      reenvio: true,
    });
  });

  test('responde 201 com o convite novo, o anterior e a entrega; sem cookie e sem token fora da entrega', async (t) => {
    const { controller } = preparar(t, { entrega: { modo: 'EMAIL', estado: 'ENVIADO', expiraEm: EXPIRA } });
    const res = resposta();
    await controller.reenviar(requisicao(), res);

    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.corpo, {
      status: 'ok', convite: conviteNovo, conviteAnteriorId: '40', entrega: { modo: 'EMAIL', estado: 'ENVIADO', expiraEm: EXPIRA },
    });
    assert.equal(JSON.stringify(res.corpo).includes(TOKEN), false);
    assert.equal('linkAceite' in res.corpo.entrega, false);
    assert.deepEqual(res.cabecalhos, []);
  });

  test('falha de entrega: o convite está gravado, então responde 201 com o estado FALHA', async (t) => {
    const { controller } = preparar(t, { entrega: { modo: 'EMAIL', estado: 'FALHA', expiraEm: EXPIRA } });
    const res = resposta();
    await controller.reenviar(requisicao(), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.corpo.entrega.estado, 'FALHA');
    assert.equal(res.corpo.convite.id, '41');
  });

  test('erro do serviço (409, 429...) chega ao tratador sem entregar nada', async (t) => {
    const falha = Object.assign(new Error('recusado'), { status: 429 });
    t.mock.method(conviteUsuarioService, 'reenviar', async () => { throw falha; });
    const entregar = t.mock.fn(async () => ({}));
    const controller = criarConviteUsuarioController({ pool: POOL, entregar });
    await assert.rejects(() => controller.reenviar(requisicao(), resposta()), (e) => e === falha);
    assert.equal(entregar.mock.calls.length, 0);
  });
});

describe('convite do MASTER — reenviar', () => {
  const conviteNovo = {
    id: '41', empresaId: 3, emailConvite: EMAIL, situacao: 'PENDENTE', criadoPor: 1, criadoEm: EXPIRA, expiraEm: EXPIRA, canceladoEm: null,
  };
  const empresa = { id: 3, razaoSocial: 'Empresa Convidante Ltda' };
  const requisicao = () => ({
    validado: { params: { id: 3, conviteId: '40' }, body: {} },
    administradorPlataforma: { id: 1 },
    ip: IP,
    headers: { 'user-agent': AGENTE },
  });

  function preparar(t, { entrega = { modo: 'DESENVOLVIMENTO_SEM_EMAIL', estado: 'NAO_ENVIADO', expiraEm: EXPIRA, linkAceite: `https://admin.test/painel-privado/aceitar-convite.html#token=${TOKEN}` } } = {}) {
    const servico = t.mock.method(conviteMasterService, 'reenviar', async () => ({
      convite: conviteNovo, conviteAnteriorId: '40', token: TOKEN, empresa,
    }));
    const entregar = t.mock.fn(async () => entrega);
    return { servico, entregar, controller: criarConviteMasterController({ pool: POOL, entregar }) };
  }

  test('chama o serviço com o administrador da SESSÃO da plataforma, a empresa e o convite da rota', async (t) => {
    const { servico, controller } = preparar(t);
    await controller.reenviar(requisicao(), resposta());
    const [pool, dados] = servico.mock.calls[0].arguments;
    assert.equal(pool, POOL);
    assert.deepEqual(dados, {
      administradorId: 1, empresaId: 3, conviteId: '40', ip: IP, dispositivo: AGENTE,
    });
  });

  test('entrega o convite NOVO como reenvio, com o token em claro só para a entrega', async (t) => {
    const { entregar, controller } = preparar(t);
    await controller.reenviar(requisicao(), resposta());
    assert.deepEqual(entregar.mock.calls[0].arguments[0], {
      conviteId: '41', token: TOKEN, expiraEm: EXPIRA, email: EMAIL, empresa, reenvio: true,
    });
  });

  test('responde 201 com o convite novo, o anterior, a empresa e a entrega; sem token fora da entrega', async (t) => {
    const { controller } = preparar(t, { entrega: { modo: 'EMAIL', estado: 'ENVIADO', expiraEm: EXPIRA } });
    const res = resposta();
    await controller.reenviar(requisicao(), res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.corpo, {
      status: 'ok', convite: conviteNovo, conviteAnteriorId: '40', empresa, entrega: { modo: 'EMAIL', estado: 'ENVIADO', expiraEm: EXPIRA },
    });
    assert.equal(JSON.stringify(res.corpo).includes(TOKEN), false);
    assert.deepEqual(res.cabecalhos, []);
  });

  test('falha de entrega: responde 201 com o estado FALHA', async (t) => {
    const { controller } = preparar(t, { entrega: { modo: 'EMAIL', estado: 'FALHA', expiraEm: EXPIRA } });
    const res = resposta();
    await controller.reenviar(requisicao(), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.corpo.entrega.estado, 'FALHA');
  });
});
