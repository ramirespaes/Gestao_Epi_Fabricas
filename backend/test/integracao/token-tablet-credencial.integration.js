'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const {
  abrirAmbiente, sha256, varrer, cookieDoTabletNaResposta, COOKIE_TABLET, CAMINHO_TABLET, ORIGEM, IP_TESTE, criarLimitador,
} = require('./helpers/token-tablet');
const { tokenSessaoTemFormatoValido, hashTokenSessao, gerarTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Atendimento Token — Etapa C (RED), autenticação do tablet pela credencial persistente. PostgreSQL real, schema temporário.
 *
 * Contrato proposto:
 *   GET /api/atendimento-token/tablet/estado   só o cookie do tablet; sem corpo; query estrita (nenhum parâmetro)
 *   200 { status:'ok', dispositivo: { nome, unidade, setor, localInstalacao } }
 *   401 DISPOSITIVO_NAO_AUTORIZADO   credencial ausente, malformada, desconhecida, anterior fora da carência, tablet revogado
 *                                    ou empresa inativa: a MESMA resposta
 *   403 REDE_NAO_AUTORIZADA          credencial válida, origem de rede não autorizada (decidido DEPOIS da credencial); nunca rotaciona
 *   Rotação: com a credencial emitida há 24 h ou mais, a primeira requisição autorizada emite outra (Set-Cookie), guarda a
 *   atual como "anterior" e registra CREDENCIAL_RENOVADA. A anterior segue aceita por uma carência curta (requisições
 *   simultâneas do navegador) e depois é recusada com evento REUSO_CREDENCIAL, SEM revogar o tablet (decisão proposta).
 *   A carência não é fixada aqui: os testes usam 20 s (dentro) e 15 min (fora).
 */

const ESTADO = `${CAMINHO_TABLET}/estado`;
const NAO_AUTORIZADO = { status: 401, codigo: 'DISPOSITIVO_NAO_AUTORIZADO' };
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;

describe('Atendimento Token — C: credencial persistente do tablet (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;

  before(async () => {
    a = await abrirAmbiente();
    app = a.criarApp({ hops: 0 });
    gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const estado = (credencial, cabecalhos = {}, aplicacao = app) => a.comoTablet(aplicacao, credencial, cabecalhos).get(ESTADO);
  const envelhecer = (id, intervalo) => a.q(`UPDATE token_dispositivos SET credencial_emitida_em = now() - interval '${intervalo}' WHERE id = $1`, [id]);

  // ───────────── controles do ambiente (usam só o que JÁ existe; passam já no RED) ─────────────
  describe('controles do ambiente (devem passar já no RED)', () => {
    test('K1 — fixture: tablet ATIVO com credencial real canônica; o hash guardado é o SHA-256 dela e a emissão pode ser envelhecida', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      assert.equal(tokenSessaoTemFormatoValido(t.credencial), true);
      const l = await a.linha(t.id);
      assert.equal(l.credencial_hash, hashTokenSessao(t.credencial));
      assert.ok(Date.now() - l.credencial_emitida_em.getTime() > 24 * 3600 * 1000);
      assert.equal(l.revogado_em, null);
    });

    test('K2 — a revogação administrativa da Etapa B (congelada) zera a credencial: é a base da revogação efetiva', async () => {
      const t = await a.ativado(a.d.empresaA);
      const r = await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${t.id}/revogar`);
      assert.equal(r.status, 200, aviso(r));
      const l = await a.linha(t.id);
      assert.deepEqual([l.credencial_hash, l.credencial_anterior_hash], [null, null]);
      assert.ok(l.revogado_em instanceof Date);
    });
  });

  // ───────────────────────── E. autenticação pela credencial ─────────────────────────
  describe('autenticação pela credencial', () => {
    test('E1 — credencial válida na rede autorizada: 200 com os dados de localização do PRÓPRIO tablet, sem rotação (<24 h) e sem alterar o banco', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 1 });
      const antes = JSON.stringify(await a.linha(t.id));
      const r = await estado(t.credencial);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(Object.keys(r.body).sort(), ['dispositivo', 'status']);
      assert.deepEqual(r.body.dispositivo, { nome: (await a.linha(t.id)).nome, unidade: 'Fábrica 1', setor: 'Expedição', localInstalacao: 'Portaria' });
      assert.equal(cookieDoTabletNaResposta(r), null, 'sem rotação, sem novo cookie');
      assert.equal(JSON.stringify(await a.linha(t.id)), antes);
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 0);
      assert.deepEqual(varrer([{ corpo: r.body }], [t.credencial]), []);
    });

    test('E2 — credencial ausente, malformada, desconhecida, em cabeçalho Authorization/X-*, ou com o cookie duplicado: a MESMA 401, sem 5xx e sem Set-Cookie', async () => {
      const t = await a.ativado(a.d.empresaA);
      const variantes = [
        ['sem cookie', () => request(app).get(ESTADO)],
        ['cookie lixo', () => request(app).get(ESTADO).set('Cookie', `${COOKIE_TABLET}=abc`)],
        ['canônica desconhecida', () => request(app).get(ESTADO).set('Cookie', `${COOKIE_TABLET}=${gerarTokenSessao()}`)],
        ['cookie duplicado', () => request(app).get(ESTADO).set('Cookie', `${COOKIE_TABLET}=${t.credencial}; ${COOKIE_TABLET}=${gerarTokenSessao()}`)],
        ['só Authorization Bearer', () => request(app).get(ESTADO).set('Authorization', `Bearer ${t.credencial}`)],
        ['só cabeçalho X-Credencial', () => request(app).get(ESTADO).set('X-Credencial', t.credencial)],
        ['cookie com outro nome', () => request(app).get(ESTADO).set('Cookie', `outro=${t.credencial}`)],
      ];
      const respostas = [];
      for (const [rotulo, montar] of variantes) {
        const r = await montar();
        assert.deepEqual([r.status, r.body.codigo], [NAO_AUTORIZADO.status, NAO_AUTORIZADO.codigo], `${rotulo} → ${aviso(r)}`);
        assert.equal(cookieDoTabletNaResposta(r), null, rotulo);
        respostas.push(JSON.stringify(r.body));
      }
      assert.equal(new Set(respostas).size, 1, 'corpos idênticos');
      assert.equal(/stack|sql|constraint|token_dispositivos/i.test(respostas[0]), false);
    });

    test('E3 — a credencial NÃO vale em query: ?credencial= é 400 (query estrita) e nunca autentica; o corpo de erro não devolve o valor', async () => {
      const t = await a.ativado(a.d.empresaA);
      const r = await request(app).get(`${ESTADO}?credencial=${t.credencial}`);
      assert.equal(r.status, 400, aviso(r));
      assert.equal(r.body.codigo, 'VALIDACAO');
      assert.equal(JSON.stringify(r.body).includes(t.credencial), false);
    });

    test('E4 — "reinicialização": instâncias NOVAS do app (sem memória) aceitam o mesmo cookie; a autorização vive no banco, não no processo', async () => {
      const t = await a.ativado(a.d.empresaA);
      for (let i = 0; i < 3; i += 1) {
        const novoProcesso = a.criarApp({ hops: 0 });
        const r = await estado(t.credencial, {}, novoProcesso);
        assert.equal(r.status, 200, `instância ${i + 1}: ${aviso(r)}`);
      }
    });

    test('E5 — fluxo completo: código gerado pela SST → ativação → cookie do Set-Cookie → rota protegida (nova instância) responde 200 com o mesmo tablet', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const gerar = await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${x.id}/ativacao`);
      assert.equal(gerar.status, 201, aviso(gerar));
      const ativacao = await a.ativar(a.criarApp({ hops: 0 }), gerar.body.ativacao?.codigo);
      assert.equal(ativacao.status, 200, aviso(ativacao));
      const cookie = cookieDoTabletNaResposta(ativacao);
      assert.ok(cookie, 'cookie emitido');
      const r = await estado(cookie.valor, {}, a.criarApp({ hops: 0 }));
      assert.equal(r.status, 200, aviso(r));
      assert.equal(r.body.dispositivo.nome, x.nome);
    });

    test('E6 — a identidade vem SÓ da credencial: x-empresa-id/x-dispositivo-id no cabeçalho são ignorados e a resposta é a do tablet da credencial; dois tablets, duas respostas', async () => {
      const daA = await a.ativado(a.d.empresaA, { extra: { setor: 'Setor do A' } });
      const daB = await a.ativado(a.d.empresaB, { extra: { setor: 'Setor do B' } });
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      const comoA = await estado(daA.credencial, { 'x-empresa-id': String(a.d.empresaB), 'x-dispositivo-id': String(daB.id) });
      const comoB = await estado(daB.credencial);
      assert.equal(comoA.status, 200, aviso(comoA));
      assert.equal(comoB.status, 200, aviso(comoB));
      assert.equal(comoA.body.dispositivo.setor, 'Setor do A');
      assert.equal(comoB.body.dispositivo.setor, 'Setor do B');
    });

    test('E7 — limite de tentativas por origem: depois de 3 requisições a 4ª é 429, inclusive com credencial válida', async () => {
      const t = await a.ativado(a.d.empresaA);
      const limitado = a.criarApp({ hops: 0, limitador: criarLimitador({ limite: 3, janelaSegundos: 60 }) });
      for (let i = 0; i < 3; i += 1) assert.equal((await estado(i === 0 ? gerarTokenSessao() : t.credencial, {}, limitado)).status === 429, false, `tentativa ${i + 1}`);
      const barrada = await estado(t.credencial, {}, limitado);
      assert.deepEqual([barrada.status, barrada.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], aviso(barrada));
    });
  });

  // ───────────────────────── I. revogação efetiva e situação do tablet/empresa ─────────────────────────
  describe('revogação e situação', () => {
    test('I1 — revogar pela rota administrativa invalida a credencial IMEDIATAMENTE: a requisição seguinte é 401, e o cookie anterior também', async () => {
      const t = await a.ativado(a.d.empresaA);
      assert.equal((await estado(t.credencial)).status, 200);
      const rev = await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${t.id}/revogar`);
      assert.equal(rev.status, 200, aviso(rev));
      const r = await estado(t.credencial);
      assert.deepEqual([r.status, r.body.codigo], [NAO_AUTORIZADO.status, NAO_AUTORIZADO.codigo], aviso(r));
      assert.equal(cookieDoTabletNaResposta(r), null);
    });

    test('I2 — depois de uma rotação, revogar invalida a credencial atual E a anterior (carência não sobrevive à revogação)', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const rotacao = await estado(t.credencial);
      assert.equal(rotacao.status, 200, aviso(rotacao));
      const nova = cookieDoTabletNaResposta(rotacao);
      assert.ok(nova, 'rotação esperada');
      const rev = await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${t.id}/revogar`);
      assert.equal(rev.status, 200, aviso(rev));
      for (const cred of [t.credencial, nova.valor]) assert.equal((await estado(cred)).status, 401);
    });

    test('I3 — empresa INATIVA: 401 genérica com credencial válida; ao reativar a empresa a credencial volta a valer (nada foi apagado)', async () => {
      const t = await a.ativado(a.d.empresaB);
      await a.redes({ A: [], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      assert.equal((await estado(t.credencial)).status, 200, 'premissa');
      await a.q('UPDATE empresas SET ativo = false WHERE id = $1', [a.d.empresaB]);
      try {
        const r = await estado(t.credencial);
        assert.deepEqual([r.status, r.body.codigo], [NAO_AUTORIZADO.status, NAO_AUTORIZADO.codigo], aviso(r));
      } finally {
        await a.q('UPDATE empresas SET ativo = true WHERE id = $1', [a.d.empresaB]);
      }
      assert.equal((await estado(t.credencial)).status, 200);
    });

    test('I4 — tablet REVOGADO direto no banco (sem credencial, como a constraint exige) nunca autentica, e uma credencial antiga guardada fora não o reativa', async () => {
      const t = await a.ativado(a.d.empresaA);
      await a.q('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $2, credencial_hash = NULL, credencial_anterior_hash = NULL WHERE id = $1', [t.id, a.d.master]);
      const r = await estado(t.credencial);
      assert.deepEqual([r.status, r.body.codigo], [NAO_AUTORIZADO.status, NAO_AUTORIZADO.codigo], aviso(r));
    });
  });

  // ───────────────────────── H. rotação, concorrência e replay ─────────────────────────
  describe('rotação, concorrência e replay', () => {
    test('H1 — credencial com 24 h ou mais: a primeira requisição rotaciona (200 + novo cookie com os mesmos atributos); a atual vira "anterior"; um evento CREDENCIAL_RENOVADA', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const r = await estado(t.credencial);
      assert.equal(r.status, 200, aviso(r));
      const novo = cookieDoTabletNaResposta(r);
      assert.ok(novo, 'novo cookie na rotação');
      assert.equal(tokenSessaoTemFormatoValido(novo.valor), true);
      assert.notEqual(novo.valor, t.credencial);
      assert.equal(novo.atributos.httponly, true);
      assert.equal(novo.atributos.path, CAMINHO_TABLET);
      assert.ok(Number(novo.atributos['max-age']) >= 30 * 24 * 3600);
      const l = await a.linha(t.id);
      assert.deepEqual([l.credencial_hash, l.credencial_anterior_hash], [hashTokenSessao(novo.valor), hashTokenSessao(t.credencial)]);
      assert.ok(Date.now() - l.credencial_emitida_em.getTime() < 60 * 1000, 'o instante da emissão foi renovado');
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 1);
      assert.equal(JSON.stringify(r.body).includes(novo.valor), false, 'a nova credencial só vai no cookie');
      assert.equal((await estado(novo.valor)).status, 200, 'a nova credencial vale');
    });

    test('H2 — antes das 24 h NÃO há rotação (23 h): sem Set-Cookie, sem mudança no banco, sem evento', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 23 });
      const antes = JSON.stringify(await a.linha(t.id));
      const r = await estado(t.credencial);
      assert.equal(r.status, 200, aviso(r));
      assert.equal(cookieDoTabletNaResposta(r), null);
      assert.equal(JSON.stringify(await a.linha(t.id)), antes);
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 0);
    });

    test('H3 — dentro da carência a credencial ANTERIOR ainda autentica (requisição em voo no navegador), sem nova rotação, sem novo cookie, sem revogar e sem evento extra', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const rot = await estado(t.credencial);
      assert.equal(rot.status, 200, aviso(rot));
      const antes = JSON.stringify(await a.linha(t.id));
      const r = await estado(t.credencial);
      assert.equal(r.status, 200, `a anterior dentro da carência: ${aviso(r)}`);
      assert.equal(cookieDoTabletNaResposta(r), null);
      assert.equal(JSON.stringify(await a.linha(t.id)), antes);
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 1);
      assert.equal((await a.eventos(t.id, 'REUSO_CREDENCIAL')).length, 0);
    });

    test('H4 — 8 requisições SIMULTÂNEAS com a mesma credencial vencida: todas 200 (nenhuma revogação indevida, nenhum 5xx), exatamente UMA rotação, um cookie novo, um evento', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const respostas = await Promise.all(Array.from({ length: 8 }, () => estado(t.credencial)));
      assert.deepEqual(respostas.map((r) => r.status), Array(8).fill(200), respostas.map(aviso).join(' | '));
      const comCookie = respostas.filter((r) => cookieDoTabletNaResposta(r) !== null);
      assert.equal(comCookie.length, 1, 'uma única rotação');
      const novo = cookieDoTabletNaResposta(comCookie[0]).valor;
      const l = await a.linha(t.id);
      assert.deepEqual([l.credencial_hash, l.credencial_anterior_hash, l.revogado_em], [hashTokenSessao(novo), hashTokenSessao(t.credencial), null]);
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 1);
      assert.equal((await a.eventos(t.id, 'REUSO_CREDENCIAL')).length, 0, 'concorrência legítima não é reuso');
      assert.equal((await estado(novo)).status, 200);
    });

    test('H5 — replay FORA da carência: a credencial anterior é 401 e gera evento REUSO_CREDENCIAL; o tablet NÃO é revogado e a credencial atual segue valendo (decisão proposta: sem revogação automática)', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const rot = await estado(t.credencial);
      assert.equal(rot.status, 200, aviso(rot));
      const nova = cookieDoTabletNaResposta(rot);
      assert.ok(nova, 'rotação esperada');
      await envelhecer(t.id, '15 minutes');
      const replay = await estado(t.credencial);
      assert.deepEqual([replay.status, replay.body.codigo], [NAO_AUTORIZADO.status, NAO_AUTORIZADO.codigo], aviso(replay));
      assert.equal(cookieDoTabletNaResposta(replay), null);
      assert.equal((await a.eventos(t.id, 'REUSO_CREDENCIAL')).length, 1);
      assert.equal((await a.linha(t.id)).revogado_em, null, 'não revoga o tablet legítimo');
      assert.equal((await estado(nova.valor)).status, 200, 'a credencial atual segue valendo');
    });

    test('H6 — replays repetidos geram UM evento (volume controlável pelo atacante com supressão), não um por tentativa', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      assert.equal((await estado(t.credencial)).status, 200);
      await envelhecer(t.id, '15 minutes');
      for (let i = 0; i < 5; i += 1) assert.equal((await estado(t.credencial)).status, 401);
      assert.equal((await a.eventos(t.id, 'REUSO_CREDENCIAL')).length, 1);
    });

    test('H7 — credencial de duas rotações atrás (já fora do banco) é 401 desconhecida e NÃO gera evento de reuso (não há como atribuí-la); a atual segue valendo', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const r1 = await estado(t.credencial);
      assert.equal(r1.status, 200, aviso(r1));
      const c1 = cookieDoTabletNaResposta(r1);
      assert.ok(c1);
      await envelhecer(t.id, '25 hours');
      const r2 = await estado(c1.valor);
      assert.equal(r2.status, 200, aviso(r2));
      const c2 = cookieDoTabletNaResposta(r2);
      assert.ok(c2, 'segunda rotação');
      const velha = await estado(t.credencial);
      assert.deepEqual([velha.status, velha.body.codigo], [NAO_AUTORIZADO.status, NAO_AUTORIZADO.codigo], aviso(velha));
      assert.equal((await a.eventos(t.id, 'REUSO_CREDENCIAL')).length, 0);
      assert.equal((await estado(c2.valor)).status, 200);
    });

    test('H8 — rotação vencida de tablet REVOGADO ou fora da rede não emite credencial: revogado é 401 sem Set-Cookie; rede não autorizada é 403 sem Set-Cookie e sem mudar o banco', async () => {
      const revogado = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${revogado.id}/revogar`);
      const r1 = await estado(revogado.credencial);
      assert.deepEqual([r1.status, cookieDoTabletNaResposta(r1)], [401, null], aviso(r1));
      const fora = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '203.0.113.9/32' }], B: [] });
      const antes = JSON.stringify(await a.linha(fora.id));
      const r2 = await estado(fora.credencial);
      assert.deepEqual([r2.status, r2.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r2));
      assert.equal(cookieDoTabletNaResposta(r2), null, 'nunca emite credencial para uma origem não autorizada');
      assert.equal(JSON.stringify(await a.linha(fora.id)), antes);
      assert.equal((await a.eventos(fora.id, 'CREDENCIAL_RENOVADA')).length, 0);
    });
  });

  // ───────────────────────── J/K. rede corporativa obrigatória e falsificação de cabeçalhos ─────────────────────────
  describe('rede corporativa obrigatória', () => {
    test('J1 — empresa SEM rede: 403 REDE_NAO_AUTORIZADA com credencial válida (não funciona só com credencial); a recusa é a mesma resposta, sem segredo, e gera UM evento REDE_RECUSADA em 5 tentativas', async () => {
      const t = await a.ativado(a.d.empresaA);
      await a.redes({ A: [], B: [] });
      for (let i = 0; i < 5; i += 1) {
        const r = await estado(t.credencial);
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
        assert.deepEqual(varrer([{ corpo: r.body }], [t.credencial]), []);
      }
      assert.equal((await a.eventos(t.id, 'REDE_RECUSADA')).length, 1, 'supressão do volume controlável pelo atacante');
    });

    test('J2 — rede de OUTRA empresa não autoriza, e a rede da própria empresa (IP exato) autoriza', async () => {
      const t = await a.ativado(a.d.empresaA);
      await a.redes({ A: [], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      assert.equal((await estado(t.credencial)).status, 403);
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }], B: [] });
      assert.equal((await estado(t.credencial)).status, 200);
    });

    test('J3 — rede DESATIVADA não vale; só as ativas contam', async () => {
      const t = await a.ativado(a.d.empresaA);
      await a.q('UPDATE token_redes_autorizadas SET desativada_em = now(), desativada_por = $2 WHERE empresa_id = $1', [a.d.empresaA, a.d.master]);
      const r = await estado(t.credencial);
      assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
    });

    test('K1 — sem proxy confiável, cabeçalhos de encaminhamento forjados (X-Forwarded-For, Forwarded, X-Real-IP, CF-Connecting-IP, True-Client-IP, X-Client-IP) NÃO autorizam', async () => {
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '203.0.113.9/32' }], B: [] });
      for (const [cab, valor] of [['X-Forwarded-For', '203.0.113.9'], ['Forwarded', 'for=203.0.113.9'], ['X-Real-IP', '203.0.113.9'], ['CF-Connecting-IP', '203.0.113.9'], ['True-Client-IP', '203.0.113.9'], ['X-Client-IP', '203.0.113.9']]) {
        const t = await a.ativado(a.d.empresaA);
        const r = await estado(t.credencial, { [cab]: valor }, a.criarApp({ hops: 0 }));
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], `${cab} → ${aviso(r)}`);
      }
    });

    test('K2 — com UM proxy confiável vale só a última entrada do X-Forwarded-For: a autorizada forjada à esquerda não passa; a acrescentada pelo proxy passa', async () => {
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '203.0.113.9/32' }], B: [] });
      const umSalto = a.criarApp({ hops: 1 });
      const t = await a.ativado(a.d.empresaA);
      const forjado = await estado(t.credencial, { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' }, umSalto);
      assert.deepEqual([forjado.status, forjado.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(forjado));
      const legitimo = await estado(t.credencial, { 'X-Forwarded-For': '198.51.100.7, 203.0.113.9' }, umSalto);
      assert.equal(legitimo.status, 200, aviso(legitimo));
    });

    test('K3 — IP_FIXO só vale como endereço exato: uma faixa larga cadastrada como IP_FIXO (127.0.0.0/8) NÃO autoriza (decisão proposta; IP dinâmico/CGNAT não vira rede da empresa)', async () => {
      const t = await a.ativado(a.d.empresaA);
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '127.0.0.0/8' }], B: [] });
      const r = await estado(t.credencial);
      assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
    });

    test('K4 — TUNEL sem atestação confiável é NEGADO: endereço da sub-rede do túnel no X-Forwarded-For ou endereço privado não prova o WireGuard (decisão proposta, depende da topologia)', async () => {
      await a.redes({ A: [{ tipo: 'TUNEL', rede: '10.8.0.0/24' }], B: [] });
      const t = await a.ativado(a.d.empresaA);
      for (const hops of [0, 1]) {
        const r = await estado(t.credencial, { 'X-Forwarded-For': '10.8.0.5' }, a.criarApp({ hops }));
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], `hops=${hops} → ${aviso(r)}`);
      }
    });
  });

  // ───────────────────────── L. separação entre credencial do tablet e sessão administrativa ─────────────────────────
  describe('separação entre tablet e administração', () => {
    test('L1 — a credencial do tablet NUNCA autoriza rotas administrativas: com sessão administrativa REAL, o cookie do tablet em /dispositivos e na geração de ativação dá 401 SESSAO_INVALIDA', async () => {
      const real = a.criarApp({ admin: 'cookie' });
      const t = await a.ativado(a.d.empresaA);
      const alvo = await a.dispositivo(a.d.empresaA);
      const lista = await request(real).get('/api/atendimento-token/dispositivos').set('Cookie', `${COOKIE_TABLET}=${t.credencial}`);
      assert.deepEqual([lista.status, lista.body.codigo], [401, 'SESSAO_INVALIDA'], aviso(lista));
      const gerar = await request(real).post(`/api/atendimento-token/dispositivos/${alvo.id}/ativacao`).set('Origin', ORIGEM).set('Cookie', `${COOKIE_TABLET}=${t.credencial}`).send({});
      assert.deepEqual([gerar.status, gerar.body.codigo], [401, 'SESSAO_INVALIDA'], aviso(gerar));
    });

    test('L2 — a sessão administrativa NUNCA autentica o tablet: o cookie de sessão empresarial, com a permissão que for, em /tablet/estado é 401 DISPOSITIVO_NAO_AUTORIZADO', async () => {
      const real = a.criarApp({ admin: 'cookie' });
      const cookieAdmin = await a.cookieAdministrativo(gestor, a.d.empresaA);
      const lista = await request(real).get('/api/atendimento-token/dispositivos').set('Cookie', cookieAdmin);
      assert.equal(lista.status, 200, 'premissa: a sessão administrativa funciona nas rotas administrativas');
      const r = await request(real).get(ESTADO).set('Cookie', cookieAdmin);
      assert.deepEqual([r.status, r.body.codigo], [NAO_AUTORIZADO.status, NAO_AUTORIZADO.codigo], aviso(r));
    });

    test('L3 — o nome do cookie do tablet é próprio e a política de cookie o expõe com Path restrito ao tablet (nenhum cookie de sessão compartilha nome nem caminho)', async () => {
      const ativado = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const r = await estado(ativado.credencial);
      assert.equal(r.status, 200, aviso(r));
      const c = cookieDoTabletNaResposta(r);
      assert.ok(c, 'rotação emite o cookie');
      assert.notEqual(c.atributos.path, '/', 'o cookie do tablet não é enviado às demais rotas da API');
      assert.deepEqual([authConfig.sessao.cookieNome, authConfig.sessao.cookieNomeAdmin, authConfig.sessao.cookieNomeGlobal].includes(c.nome), false);
    });
  });

  // ───────────────────────── M. segredos ─────────────────────────
  describe('segredos', () => {
    test('M1 — ciclo completo (ativação, rotação, replay, revogação): nenhuma credencial em claro em tabela alguma e nenhum hash em auditoria ou eventos', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const gerar = await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${x.id}/ativacao`);
      assert.equal(gerar.status, 201, aviso(gerar));
      const codigo = gerar.body.ativacao?.codigo;
      const ativ = await a.ativar(app, codigo);
      assert.equal(ativ.status, 200, aviso(ativ));
      const c0 = cookieDoTabletNaResposta(ativ).valor;
      await envelhecer(x.id, '25 hours');
      const r1 = await estado(c0);
      assert.equal(r1.status, 200, aviso(r1));
      const c1 = cookieDoTabletNaResposta(r1).valor;
      await envelhecer(x.id, '15 minutes');
      assert.equal((await estado(c0)).status, 401);
      await a.comoAdmin(a.criarApp(), gestor).post(`/api/atendimento-token/dispositivos/${x.id}/revogar`);
      const plenos = [codigo, c0, c1];
      const hashes = plenos.map((s) => hashTokenSessao(s));
      for (const tabela of ['logs_auditoria', 'token_dispositivo_eventos', 'token_ativacoes', 'token_dispositivos', 'token_atendimentos', 'token_redes_autorizadas']) {
        const { rows } = await a.q(`SELECT * FROM ${tabela}`);
        assert.deepEqual(varrer(rows, plenos, { hex64: false }), [], `${tabela}: segredo em claro`);
      }
      for (const tabela of ['logs_auditoria', 'token_dispositivo_eventos']) {
        const { rows } = await a.q(`SELECT * FROM ${tabela}`);
        assert.deepEqual(varrer(rows, hashes, { hex64: false }), [], `${tabela}: hash de segredo`);
      }
      assert.equal(sha256(codigo), hashes[0]);
    });

    test('M2 — não regressão da Etapa B: as rotas administrativas congeladas seguem funcionando na mesma composição (lista e consulta com a sessão administrativa)', async () => {
      const t = await a.ativado(a.d.empresaA);
      const comoGestor = a.comoAdmin(a.criarApp(), gestor);
      const lista = await comoGestor.get('/api/atendimento-token/dispositivos?limite=100');
      assert.equal(lista.status, 200, aviso(lista));
      assert.ok(lista.body.dispositivos.some((d) => d.id === t.id));
      const detalhe = await comoGestor.get(`/api/atendimento-token/dispositivos/${t.id}`);
      assert.equal(detalhe.status, 200, aviso(detalhe));
      assert.equal(detalhe.body.dispositivo.situacao, 'ATIVO');
      assert.equal(JSON.stringify(detalhe.body).includes(t.credencial), false);
    });
  });
});
