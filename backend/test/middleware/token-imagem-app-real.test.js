'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const tabletService = require('../../src/services/token-tablet.service');
const monitoramentoService = require('../../src/services/token-monitoramento.service');
const cookie = require('../../src/security/cookie');
const { authConfig } = require('../../src/config/auth');
const { httpConfig } = require('../../src/config/http');
const { gerarTokenSessao } = require('../../src/security/token');
const { HttpError } = require('../../src/errors/HttpError');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarAppTeste } = require('../helpers/app-teste');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Atendimento Token — imagens do material no tablet (RED-1, app real). Sem banco: o app REAL (Origin, JSON, rota, validação, limitadores, controller e
 * cabeçalhos seguem reais); as fronteiras de serviço são substituídas, como no K3 do heartbeat. Contrato proposto, módulos AINDA NÃO implementados:
 *   GET|HEAD /api/atendimento-token/tablet/atendimento/imagens/:origem/:id/:variante?v=<versao>
 *   src/routes/token-imagem.routes.js     criarTokenImagemRoutes({ controller, pool, limitador, limitadorDispositivo })  (rota `obter`)
 *   src/controllers/token-imagem.controller.js   criarTokenImagemController({ pool, armazenamento })
 *   src/services/token-imagem.service.js  obter(pool, { empresaId, dispositivoId, tokenAtendimento, origem, id, variante, versao }) → { corpo: Buffer, tipo }
 *   tabletService.autenticar(pool, { credencial, rotacionar: false }): autentica SEM rotacionar (a rotação continua nas demais rotas do tablet).
 * Empresa e tablet vêm só de `req.dispositivo`; nada do navegador (cabeçalho, query, corpo) os escolhe e nenhum identificador recebido autoriza nada: a
 * autorização é do serviço (provada com PostgreSQL em token-imagem-autorizacao.integration.js).
 */

const ORIGEM_PERMITIDA = httpConfig.cors.origens[0];
const BASE = '/api/atendimento-token/tablet/atendimento';
const COOKIE_TABLET = authConfig.dispositivo.cookieNome;
const COOKIE_ATENDIMENTO = authConfig.atendimento.cookieNome;
const url = (origem = 'empresa', id = '5', variante = 'miniatura', consulta = '') => `${BASE}/imagens/${origem}/${id}/${variante}${consulta}`;
const DISPOSITIVO = Object.freeze({ id: 7, empresaId: 3, nome: 'Tablet A', unidade: null, setor: null, localInstalacao: null });
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([8, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const tokens = (valor) => String(valor ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const setCookieDoTablet = (r) => (r.headers['set-cookie'] ?? []).filter((c) => c.startsWith(`${COOKIE_TABLET}=`));

/** Substitui as fronteiras e devolve o que foi chamado. `novaCredencial` simula um serviço que (indevidamente) devolveria rotação. */
function preparar(t, { novaCredencial = null, imagem = { corpo: WEBP, tipo: 'image/webp' }, erro = null } = {}) {
  const autenticacoes = [];
  const entregas = [];
  const servico = exigirModulo('src/services/token-imagem.service');
  t.mock.method(tabletService, 'autenticar', async (_pool, dados) => { autenticacoes.push(dados); return { dispositivo: DISPOSITIVO, novaCredencial }; });
  t.mock.method(servico, 'obter', async (_pool, dados) => { entregas.push(dados); if (erro) throw erro; return imagem; });
  return { autenticacoes, entregas };
}
const cookies = (tablet, atendimento) => [tablet ? `${COOKIE_TABLET}=${tablet}` : null, atendimento ? `${COOKIE_ATENDIMENTO}=${atendimento}` : null].filter(Boolean).join('; ');
const pedir = (metodo, caminho, { tablet, atendimento, cabecalhos = {} } = {}) => {
  let r = request(app)[metodo](caminho);
  if (metodo !== 'get' && metodo !== 'head') r = r.set('Origin', ORIGEM_PERMITIDA);
  const c = cookies(tablet, atendimento);
  if (c) r = r.set('Cookie', c);
  for (const [nome, valor] of Object.entries(cabecalhos)) r = r.set(nome, valor);
  return r;
};

describe('[TIAR] imagens no tablet — app real', () => {
  test('TIAR-01 — GET devolve 200 com o corpo, image/webp e a política de cache SEGURA: private, no-store, Vary: Cookie, sem ETag (o 304 não pode sobreviver ao atendimento)', async (t) => {
    const { entregas } = preparar(t);
    const r = await pedir('get', url('padrao', '9223372036854775807', 'exibicao', '?v=3'), { tablet: gerarTokenSessao(), atendimento: gerarTokenSessao() }).buffer(true).parse((res, cb) => { const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => cb(null, Buffer.concat(p))); });
    assert.equal(r.status, 200, aviso(r));
    assert.deepEqual(r.body, WEBP);
    assert.match(r.headers['content-type'], /^image\/webp/);
    const cache = tokens(r.headers['cache-control']);
    assert.ok(cache.includes('private') && cache.includes('no-store'), r.headers['cache-control']);
    assert.equal(cache.some((d) => d === 'immutable' || d.startsWith('max-age=') || d === 'public'), false, 'sem immutable, max-age nem public');
    assert.ok(tokens(r.headers.vary).includes('cookie'), 'Vary: Cookie');
    assert.equal(r.headers.etag, undefined, 'sem ETag');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(entregas.length, 1);
    assert.deepEqual([entregas[0].origem, entregas[0].id, entregas[0].variante, entregas[0].versao], ['padrao', '9223372036854775807', 'exibicao', 3]);
  });

  test('TIAR-02 — HEAD tem o mesmo status e os mesmos cabeçalhos do GET, sem corpo, e passa pela MESMA autorização', async (t) => {
    const { entregas } = preparar(t);
    const credenciais = { tablet: gerarTokenSessao(), atendimento: gerarTokenSessao() };
    const get = await pedir('get', url(), credenciais);
    const head = await pedir('head', url(), credenciais);
    assert.equal(head.status, 200, aviso(head));
    assert.deepEqual(head.text ?? '', '');
    for (const nome of ['content-type', 'cache-control', 'vary', 'content-length', 'x-content-type-options']) assert.equal(head.headers[nome], get.headers[nome], nome);
    assert.equal(entregas.length, 2, 'o HEAD também consulta o serviço (nenhum atalho sem autorização)');
  });

  test('TIAR-03 — métodos que não são GET/HEAD seguem o comportamento EXISTENTE do app (igual ao do catálogo vizinho, que também é só leitura) e nunca viram 200 nem chegam ao serviço', async (t) => {
    const { entregas } = preparar(t);
    const credenciais = { tablet: gerarTokenSessao(), atendimento: gerarTokenSessao() };
    for (const metodo of ['post', 'put', 'patch', 'delete']) {
      const imagem = await pedir(metodo, url(), credenciais).send({});
      const vizinho = await pedir(metodo, `${BASE}/catalogo`, credenciais).send({});
      assert.notEqual(imagem.status, 200, metodo);
      assert.deepEqual([imagem.status, imagem.body.codigo], [vizinho.status, vizinho.body.codigo], `${metodo}: mesmo tratamento do catálogo (sem impor 405)`);
    }
    assert.equal(entregas.length, 0);
  });

  test('TIAR-04 — sem a credencial do tablet é 401 DISPOSITIVO_NAO_AUTORIZADO antes do serviço; a sessão ADMINISTRATIVA sozinha não autentica (nenhum privilégio administrativo)', async (t) => {
    const { entregas } = preparar(t);
    const semNada = await pedir('get', url(), { atendimento: gerarTokenSessao() });
    assert.deepEqual([semNada.status, semNada.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(semNada));
    const admin = await pedir('get', url(), { cabecalhos: { Cookie: `${authConfig.sessao.cookieNome}=${gerarTokenSessao()}; ${COOKIE_ATENDIMENTO}=${gerarTokenSessao()}` } });
    assert.deepEqual([admin.status, admin.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(admin));
    const duplicada = await pedir('get', url(), { cabecalhos: { Cookie: `${COOKIE_TABLET}=${gerarTokenSessao()}; ${COOKIE_TABLET}=${gerarTokenSessao()}; ${COOKIE_ATENDIMENTO}=${gerarTokenSessao()}` } });
    assert.deepEqual([duplicada.status, duplicada.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(duplicada));
    assert.equal(entregas.length, 0);
  });

  test('TIAR-05 — a autenticação da imagem é pedida SEM rotação (`rotacionar: false`) e nenhum Set-Cookie do tablet sai, mesmo que o serviço devolvesse uma nova credencial', async (t) => {
    const { autenticacoes, entregas } = preparar(t, { novaCredencial: gerarTokenSessao() });
    const r = await pedir('get', url(), { tablet: gerarTokenSessao(), atendimento: gerarTokenSessao() });
    assert.equal(r.status, 200, aviso(r));
    assert.equal(autenticacoes.length, 1);
    assert.equal(autenticacoes[0].rotacionar, false);
    assert.deepEqual(setCookieDoTablet(r), [], 'a imagem nunca emite o cookie do tablet');
    assert.equal(r.headers['set-cookie']?.some((c) => c.startsWith(`${COOKIE_ATENDIMENTO}=`)) ?? false, false, 'nem renova o cookie do atendimento');
    assert.equal(entregas.length, 1);
  });

  test('TIAR-06 — a rotação LEGÍTIMA continua nas rotas existentes: o heartbeat, com serviço que rotaciona, emite o Set-Cookie pela política atual e NÃO pede `rotacionar: false`', async (t) => {
    exigirModulo('src/services/token-imagem.service');
    const nova = gerarTokenSessao();
    const chamadas = [];
    t.mock.method(tabletService, 'autenticar', async (_pool, dados) => { chamadas.push(dados); return { dispositivo: DISPOSITIVO, novaCredencial: nova }; });
    t.mock.method(monitoramentoService, 'registrarContato', async () => {});
    const r = await request(app).post('/api/atendimento-token/tablet/heartbeat').set('Origin', ORIGEM_PERMITIDA).set('Cookie', cookies(gerarTokenSessao())).send({});
    assert.equal(r.status, 200, aviso(r));
    assert.deepEqual(r.headers['set-cookie'], [cookie.serializarCookieDispositivo(nova)]);
    assert.notEqual(chamadas[0].rotacionar, false);
  });

  test('TIAR-07 — o cookie do atendimento chega ao serviço como veio; ausente ou duplicado chega como ausente; empresa e tablet vêm SÓ de req.dispositivo (cabeçalhos e query não os escolhem)', async (t) => {
    const { entregas } = preparar(t);
    const atendimento = gerarTokenSessao();
    const ok = await pedir('get', url(), { tablet: gerarTokenSessao(), atendimento, cabecalhos: { 'X-Empresa-Id': '99', 'X-Dispositivo-Id': '99' } });
    assert.equal(ok.status, 200, aviso(ok));
    assert.deepEqual([entregas[0].empresaId, entregas[0].dispositivoId, entregas[0].tokenAtendimento], [3, 7, atendimento]);
    await pedir('get', url(), { tablet: gerarTokenSessao() });
    assert.ok(entregas[1].tokenAtendimento === null || entregas[1].tokenAtendimento === undefined, 'ausente');
    await pedir('get', url(), { cabecalhos: { Cookie: `${COOKIE_TABLET}=${gerarTokenSessao()}; ${COOKIE_ATENDIMENTO}=${atendimento}; ${COOKIE_ATENDIMENTO}=${gerarTokenSessao()}` } });
    assert.ok(entregas[2].tokenAtendimento === null || entregas[2].tokenAtendimento === undefined, 'duplicado conta como ausente');
  });

  test('TIAR-08 — validação estrita ANTES da autenticação e do serviço: id, origem, variante, versão e chaves extras da query malformados são 400 VALIDACAO (o mestre e a forma EMPRESA do catálogo incluídos)', async (t) => {
    const { autenticacoes, entregas } = preparar(t);
    const credenciais = { tablet: gerarTokenSessao(), atendimento: gerarTokenSessao() };
    const ruins = [url('empresa', '0'), url('empresa', '007'), url('empresa', '9223372036854775808'), url('empresa', 'abc'), url('EMPRESA'), url('global'),
      url('empresa', '5', 'mestre'), url('empresa', '5', 'original'), url('empresa', '5', 'miniatura', '?v=0'), url('empresa', '5', 'miniatura', '?v=1.5'),
      url('empresa', '5', 'miniatura', '?empresaId=9'), url('empresa', '5', 'miniatura', '?materialId=1'), url('empresa', '5', 'miniatura', '?v=1&x=1')];
    for (const caminho of ruins) {
      const r = await pedir('get', caminho, credenciais);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${caminho} → ${aviso(r)}`);
    }
    assert.equal(autenticacoes.length, 0, 'validação antes de qualquer autenticação');
    assert.equal(entregas.length, 0);
  });

  test('TIAR-09 — erros do serviço saem com o status e o código do serviço (404 IMAGEM_NAO_ENCONTRADA, 401 ATENDIMENTO_INVALIDO), sem Set-Cookie e sem permitir cache', async (t) => {
    for (const [erro, esperado] of [
      [HttpError.notFound('IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada'), [404, 'IMAGEM_NAO_ENCONTRADA']],
      [HttpError.unauthorized('ATENDIMENTO_INVALIDO', 'Atendimento inválido ou expirado'), [401, 'ATENDIMENTO_INVALIDO']],
    ]) {
      await t.test(esperado[1], async (sub) => {
        preparar(sub, { erro });
        const r = await pedir('get', url(), { tablet: gerarTokenSessao(), atendimento: gerarTokenSessao() });
        assert.deepEqual([r.status, r.body.codigo], esperado, aviso(r));
        assert.deepEqual(setCookieDoTablet(r), []);
        assert.ok(tokens(r.headers['cache-control']).includes('no-store'), `erro sem cache: ${r.headers['cache-control']}`);
        assert.equal(r.headers.etag, undefined);
      });
    }
  });

  test('TIAR-10 — concorrência: 24 pedidos simultâneos (20 com a credencial vigente, 4 com uma credencial antiga recusada) não se misturam; nenhum emite Set-Cookie e todos autenticam sem rotação', async (t) => {
    exigirModulo('src/services/token-imagem.service');
    const servico = require('../../src/services/token-imagem.service');
    const vigente = gerarTokenSessao();
    const antiga = gerarTokenSessao();
    const pedidos = [];
    t.mock.method(tabletService, 'autenticar', async (_pool, dados) => {
      pedidos.push(dados);
      if (dados.credencial === antiga) throw HttpError.unauthorized('DISPOSITIVO_NAO_AUTORIZADO', 'Dispositivo não autorizado');
      return { dispositivo: DISPOSITIVO, novaCredencial: null };
    });
    t.mock.method(servico, 'obter', async () => ({ corpo: WEBP, tipo: 'image/webp' }));
    const respostas = await Promise.all(Array.from({ length: 24 }, (_, i) => pedir('get', url('empresa', String(i + 1)), { tablet: i % 6 === 5 ? antiga : vigente, atendimento: gerarTokenSessao() })));
    assert.deepEqual(respostas.map((r) => r.status).sort(), [...Array(20).fill(200), ...Array(4).fill(401)]);
    for (const r of respostas) assert.deepEqual(setCookieDoTablet(r), [], 'nenhuma resposta sobrescreve o cookie do tablet');
    assert.equal(pedidos.length, 24);
    assert.equal(pedidos.every((p) => p.rotacionar === false), true);
  });

  test('TIAR-11 — limitadores próprios: por IP e POR TABLET (chave do servidor), independentes; o excesso é 429 LIMITE_REQUISICOES_EXCEDIDO e não afeta outro tablet', async (t) => {
    const rotas = exigirModulo('src/routes/token-imagem.routes');
    const { chavePorDispositivo } = require('../../src/routes/token-tablet.routes');
    const credA = gerarTokenSessao();
    const credB = gerarTokenSessao();
    t.mock.method(tabletService, 'autenticar', async (_pool, { credencial }) => ({ dispositivo: { ...DISPOSITIVO, id: credencial === credA ? 7 : 8 }, novaCredencial: null }));
    const controller = { obter: (_req, res) => { res.status(200).type('image/webp').end(WEBP); } };
    const montar = (opcoes) => criarAppTeste((ap) => { ap.use('/api', rotas.criarTokenImagemRoutes({ controller, pool: {}, ...opcoes })); });
    const porTablet = montar({ limitador: criarLimitador({ limite: 1000, janelaSegundos: 60 }), limitadorDispositivo: criarLimitador({ limite: 2, janelaSegundos: 60, chave: chavePorDispositivo }) });
    const get = (ap, cred) => request(ap).get(url()).set('Cookie', cookies(cred, gerarTokenSessao()));
    assert.deepEqual([(await get(porTablet, credA)).status, (await get(porTablet, credA)).status], [200, 200]);
    const excesso = await get(porTablet, credA);
    assert.deepEqual([excesso.status, excesso.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], aviso(excesso));
    assert.equal((await get(porTablet, credB)).status, 200, 'o outro tablet não é afetado');
    const porIp = montar({ limitador: criarLimitador({ limite: 2, janelaSegundos: 60 }) });
    assert.deepEqual([(await get(porIp, credA)).status, (await get(porIp, credB)).status], [200, 200]);
    assert.equal((await get(porIp, credA)).status, 429, 'o limite por IP vale para todos os tablets atrás do mesmo endereço');
  });
});
