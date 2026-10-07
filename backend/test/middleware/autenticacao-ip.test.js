'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const usuarioIpRepo = require('../../src/repositories/usuario-ip.repository');
const { gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Restrição por IP no middleware de sessão (077), sem PostgreSQL: o
 * repositório de sessão diz se o vínculo tem lista (`restricaoIp`) e o de IPs
 * diz se o endereço está nela. O endereço comparado é SEMPRE `req.ip`, que o
 * Express resolve conforme `trust proxy`: sem proxy confiado, X-Forwarded-For
 * é ignorado; com um salto confiado, é o endereço do cliente.
 */

const TOKEN = gerarTokenSessao();
const contexto = (restricaoIp) => ({
  sessao: { id: '555', criadoEm: new Date('2026-10-05T10:00:00Z'), expiraEm: new Date('2026-10-05T22:00:00Z'), ultimoUsoEm: new Date('2026-10-05T10:30:00Z') },
  usuario: { id: 7, nome: 'Ana Souza', email: 'ana.souza@demo.safeworkengenharia.com.br', perfil: 'USUARIO', identidadeId: 3 },
  empresa: { id: 42, nome: 'Empresa Teste', cnpj: '12345678000195' },
  senhaProvisoria: false,
  restricaoIp,
});
const POOL = { marcador: 'pool' };

function montarApp(middleware, { saltosDeProxy = 0 } = {}) {
  return criarAppTeste((app) => {
    app.set('trust proxy', saltosDeProxy);
    app.get('/protegida', middleware, (req, res) => { res.json({ usuario: req.usuario.id, empresa: req.empresa.id }); });
  });
}
const cookie = `${authConfig.sessao.cookieNome}=${TOKEN}`;

describe('criarExigirSessao — restrição por IP (077)', () => {
  test('sem restrição no vínculo: a lista nunca é consultada e a requisição passa', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => contexto(false));
    t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const permitido = t.mock.method(usuarioIpRepo, 'acessoPermitido', async () => false);

    const r = await request(montarApp(criarExigirSessao({ pool: POOL }))).get('/protegida').set('Cookie', cookie).set('X-Forwarded-For', '203.0.113.10');

    assert.equal(r.status, 200);
    assert.equal(permitido.mock.calls.length, 0);
  });

  test('com restrição e endereço na lista: passa, e a consulta recebe o pool, a empresa e o usuário da SESSÃO e o IP canônico do socket (loopback IPv4, mesmo chegando mapeado em IPv6)', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => contexto(true));
    const uso = t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const permitido = t.mock.method(usuarioIpRepo, 'acessoPermitido', async () => true);

    const r = await request(montarApp(criarExigirSessao({ pool: POOL }))).get('/protegida').set('Cookie', cookie).set('X-Forwarded-For', '203.0.113.10');

    assert.equal(r.status, 200);
    assert.equal(permitido.mock.calls.length, 1);
    const [pool, empresaId, usuarioId, ip] = permitido.mock.calls[0].arguments;
    assert.equal(pool, POOL);
    assert.deepEqual([empresaId, usuarioId], [42, 7]);
    assert.equal(ip, '127.0.0.1', 'sem proxy confiado, X-Forwarded-For é ignorado: o endereço é o do socket');
    assert.equal(uso.mock.calls.length, 1);
  });

  test('com restrição e endereço fora da lista: 403 ACESSO_IP_NAO_PERMITIDO, sem renovar a sessão e sem dados da sessão na resposta', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => contexto(true));
    const uso = t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    t.mock.method(usuarioIpRepo, 'acessoPermitido', async () => false);

    const r = await request(montarApp(criarExigirSessao({ pool: POOL }))).get('/protegida').set('Cookie', cookie);

    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { status: 'error', codigo: 'ACESSO_IP_NAO_PERMITIDO', message: 'Acesso não permitido a partir deste endereço' });
    assert.equal(uso.mock.calls.length, 0, 'a recusa não conta como uso');
  });

  test('com um salto de proxy confiado (TRUST_PROXY_HOPS = 1), o endereço comparado é o do cliente em X-Forwarded-For, canônico', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => contexto(true));
    t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    const permitido = t.mock.method(usuarioIpRepo, 'acessoPermitido', async () => true);
    const app = montarApp(criarExigirSessao({ pool: POOL }), { saltosDeProxy: 1 });

    await request(app).get('/protegida').set('Cookie', cookie).set('X-Forwarded-For', '2001:0DB8:0000:0000:0000:0000:0000:0010');
    await request(app).get('/protegida').set('Cookie', cookie).set('X-Forwarded-For', '198.51.100.7, 203.0.113.10');

    assert.deepEqual(permitido.mock.calls.map((c) => c.arguments[3]), ['2001:db8::10', '203.0.113.10'], 'só o último salto (o que o proxy confiado acrescentou) conta');
  });

  test('a senha provisória continua decidida DEPOIS do IP: de endereço fora da lista a resposta é a do IP', async (t) => {
    t.mock.method(sessaoRepo, 'buscarValidaPorHash', async () => ({ ...contexto(true), senhaProvisoria: true }));
    t.mock.method(sessaoRepo, 'registrarUso', async () => true);
    t.mock.method(usuarioIpRepo, 'acessoPermitido', async () => false);

    const r = await request(montarApp(criarExigirSessao({ pool: POOL }))).get('/protegida').set('Cookie', cookie);

    assert.deepEqual([r.status, r.body.codigo], [403, 'ACESSO_IP_NAO_PERMITIDO']);
  });
});
