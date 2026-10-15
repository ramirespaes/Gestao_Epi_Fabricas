'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const {
  abrirAmbiente, sha256, varrer, cookieDoTabletNaResposta, CAMINHO_TABLET, IP_TESTE, criarLimitador, modulos,
} = require('./helpers/token-tablet');
const { hashTokenSessao, gerarTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa C (GREEN): testes das DECISÕES D-C2, D-C3, D-C4, D-C5 e D-C8 e da neutralidade de plataforma. Somam-se
 * aos 98 testes do RED; nenhum deles os substitui. PostgreSQL real em schema temporário; o "relógio controlável" é o instante de
 * emissão gravado no banco (credencial_emitida_em), que é a única fonte de tempo das decisões de rotação, carência e expiração.
 */

const ESTADO = `${CAMINHO_TABLET}/estado`;
const AT = '/api/atendimento-token/dispositivos';
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const NAO_AUTORIZADO = [401, 'DISPOSITIVO_NAO_AUTORIZADO'];

describe('Atendimento Token — C: decisões D-C2, D-C4, D-C5, D-C8 e neutralidade de plataforma (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;

  before(async () => {
    a = await abrirAmbiente();
    app = a.criarApp({ hops: 0 });
    gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO', 'TOKEN_REVOGAR_DISPOSITIVO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const estado = (credencial, cabecalhos = {}, aplicacao = app) => a.comoTablet(aplicacao, credencial, cabecalhos).get(ESTADO);
  const emitidaHa = (id, intervalo) => a.q(`UPDATE token_dispositivos SET credencial_emitida_em = now() - interval '${intervalo}' WHERE id = $1`, [id]);
  const gerar = (id) => a.comoAdmin(app, gestor).post(`${AT}/${id}/ativacao`);
  const revogar = (id) => a.comoAdmin(app, gestor).post(`${AT}/${id}/revogar`);

  // ───────────────────────── D-C2: recuperação de tablet ATIVO ─────────────────────────
  describe('D-C2 — recuperação de tablet ativo por nova ativação', () => {
    test('R1 — gerar o código para um tablet ATIVO é permitido e NÃO invalida a credencial em uso: ela segue valendo enquanto o novo código não for consumido (nem expirado)', async () => {
      const t = await a.ativado(a.d.empresaA);
      const antes = (await a.linha(t.id)).credencial_hash;
      const r = await gerar(t.id);
      assert.equal(r.status, 201, aviso(r));
      const depois = await a.linha(t.id);
      assert.deepEqual([depois.credencial_hash, depois.revogado_em], [antes, null], 'gerar não toca na credencial');
      assert.equal((await estado(t.credencial)).status, 200, 'a autorização anterior continua válida enquanto o QR não foi consumido');
      await a.q("UPDATE token_ativacoes SET criado_em = now() - interval '30 minutes', expira_em = now() - interval '20 minutes' WHERE dispositivo_id = $1", [t.id]);
      assert.equal((await estado(t.credencial)).status, 200, 'o código expirado também não derruba a credencial legítima');
    });

    test('R2 — o consumo válido substitui a credencial ATOMICAMENTE: a antiga vira 401 na hora (sem carência, sem anterior), a nova vale, ativado_em é preservado, uma só credencial existe', async () => {
      const t = await a.ativado(a.d.empresaA);
      const ativadoEm = (await a.linha(t.id)).ativado_em;
      const codigo = (await gerar(t.id)).body.ativacao.codigo;
      const r = await a.ativar(a.criarApp({ hops: 0 }), codigo);
      assert.equal(r.status, 200, aviso(r));
      const nova = cookieDoTabletNaResposta(r).valor;
      assert.notEqual(nova, t.credencial);
      const l = await a.linha(t.id);
      assert.deepEqual([l.credencial_hash, l.credencial_anterior_hash], [hashTokenSessao(nova), null], 'a substituída não permanece como autorização paralela');
      assert.deepEqual(l.ativado_em, ativadoEm);
      const velha = await estado(t.credencial);
      assert.deepEqual([velha.status, velha.body.codigo], NAO_AUTORIZADO, aviso(velha));
      assert.equal((await estado(nova)).status, 200);
      assert.equal((await a.q('SELECT count(*)::int AS n FROM token_dispositivos WHERE credencial_hash = $1 OR credencial_anterior_hash = $1', [hashTokenSessao(t.credencial)])).rows[0].n, 0);
    });

    test('R3 — a recuperação invalida também a credencial ANTERIOR que estava na carência (rotação recente + recuperação)', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const rotacao = await estado(t.credencial);
      assert.equal(rotacao.status, 200, aviso(rotacao));
      const atual = cookieDoTabletNaResposta(rotacao).valor;
      assert.equal((await estado(t.credencial)).status, 200, 'premissa: a anterior vale na carência');
      const codigo = (await gerar(t.id)).body.ativacao.codigo;
      const r = await a.ativar(app, codigo);
      assert.equal(r.status, 200, aviso(r));
      for (const cred of [t.credencial, atual]) assert.equal((await estado(cred)).status, 401, 'nenhuma credencial anterior sobrevive à recuperação');
      assert.equal((await estado(cookieDoTabletNaResposta(r).valor)).status, 200);
    });

    test('R4 — recuperação pedida de rede NÃO autorizada: 403, o código não é consumido e a credencial em uso segue valendo', async () => {
      const t = await a.ativado(a.d.empresaA);
      const codigo = (await gerar(t.id)).body.ativacao.codigo;
      await a.redes({ A: [], B: [] });
      const r = await a.ativar(app, codigo);
      assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
      await a.redes(a.redeDeTeste);
      assert.equal((await estado(t.credencial)).status, 200);
      assert.equal((await a.ativacoesDe(t.id)).find((l) => l.cancelado_em === null).usado_em, null);
      assert.equal((await a.ativar(app, codigo)).status, 200, 'da rede certa o mesmo código recupera');
    });

    test('R5 — gerar de novo substitui o código de recuperação anterior (que deixa de funcionar) e a credencial em uso continua válida; o tablet revogado não recupera (409)', async () => {
      const t = await a.ativado(a.d.empresaA);
      const primeiro = (await gerar(t.id)).body.ativacao.codigo;
      const segundo = (await gerar(t.id)).body.ativacao.codigo;
      const recusado = await a.ativar(app, primeiro);
      assert.deepEqual([recusado.status, recusado.body.codigo], [401, 'ATIVACAO_INVALIDA']);
      assert.equal((await estado(t.credencial)).status, 200);
      assert.equal((await a.ativar(app, segundo)).status, 200);
      const rev = await revogar(t.id);
      assert.equal(rev.status, 200);
      const naoRecupera = await gerar(t.id);
      assert.deepEqual([naoRecupera.status, naoRecupera.body.codigo], [409, 'DISPOSITIVO_REVOGADO']);
    });

    test('R6 — a recuperação é auditada sem segredos: TOKEN_ATIVACAO_GERADA e TOKEN_DISPOSITIVO_REATIVADO com reativacao:true, empresa, tablet e (na geração) o usuário', async () => {
      const t = await a.ativado(a.d.empresaA);
      const antesGeradas = (await a.auditorias('TOKEN_ATIVACAO_GERADA')).length;
      const antesReativadas = (await a.auditorias('TOKEN_DISPOSITIVO_REATIVADO')).length;
      const codigo = (await gerar(t.id)).body.ativacao.codigo;
      const r = await a.ativar(app, codigo);
      assert.equal(r.status, 200, aviso(r));
      const credencial = cookieDoTabletNaResposta(r).valor;
      const gerada = (await a.auditorias('TOKEN_ATIVACAO_GERADA')).slice(antesGeradas);
      const reativada = (await a.auditorias('TOKEN_DISPOSITIVO_REATIVADO')).slice(antesReativadas);
      assert.deepEqual(gerada.map((l) => [l.usuario_id, l.referencia, l.contexto]), [[gestor, String(t.id), { reativacao: true }]]);
      assert.deepEqual(reativada.map((l) => [l.usuario_id, l.empresa_id, l.referencia, l.contexto]), [[null, a.d.empresaA, String(t.id), { reativacao: true }]]);
      const segredos = [codigo, credencial, t.credencial, sha256(codigo), hashTokenSessao(credencial), hashTokenSessao(t.credencial)];
      assert.deepEqual(varrer(await a.todaAuditoria(a.d.empresaA), segredos), []);
      assert.deepEqual(varrer(await a.todosEventos(a.d.empresaA), segredos), []);
    });

    test('R7 — 6 consumos simultâneos do código de recuperação junto com requisições da credencial antiga: um só vencedor, nenhum 5xx, e a antiga termina inválida', async () => {
      const t = await a.ativado(a.d.empresaA);
      const codigo = (await gerar(t.id)).body.ativacao.codigo;
      const lote = await Promise.all([
        ...Array.from({ length: 6 }, () => a.ativar(a.criarApp({ hops: 0 }), codigo)),
        ...Array.from({ length: 4 }, () => estado(t.credencial)),
      ]);
      assert.equal(lote.some((r) => r.status >= 500), false, lote.map(aviso).join(' | '));
      const vencedoras = lote.filter((r) => r.status === 200 && cookieDoTabletNaResposta(r) !== null);
      assert.equal(vencedoras.length, 1);
      assert.equal((await estado(t.credencial)).status, 401);
      assert.equal((await estado(cookieDoTabletNaResposta(vencedoras[0]).valor)).status, 200);
    });
  });

  // ───────────────────────── D-C4: validade e rotação (relógio controlável, fronteiras) ─────────────────────────
  describe('D-C4 — rotação de 24 h, carência de 2 min, cookie de 180 dias e expiração no servidor', () => {
    test('T1 — fronteira da rotação: 10 s antes das 24 h não rotaciona; 10 s depois rotaciona', async () => {
      const antes = await a.ativado(a.d.empresaA);
      await emitidaHa(antes.id, '23 hours 59 minutes 50 seconds');
      const r1 = await estado(antes.credencial);
      assert.equal(r1.status, 200, aviso(r1));
      assert.equal(cookieDoTabletNaResposta(r1), null, 'ainda não devida');
      const depois = await a.ativado(a.d.empresaA);
      await emitidaHa(depois.id, '24 hours 10 seconds');
      const r2 = await estado(depois.credencial);
      assert.equal(r2.status, 200, aviso(r2));
      assert.ok(cookieDoTabletNaResposta(r2), 'devida');
    });

    test('T2 — fronteira da carência de 2 minutos: a anterior vale a 110 s da rotação e é recusada (com REUSO_CREDENCIAL, sem revogar) a 130 s', async () => {
      const dentro = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      assert.equal((await estado(dentro.credencial)).status, 200);
      await emitidaHa(dentro.id, '110 seconds');
      assert.equal((await estado(dentro.credencial)).status, 200, 'a 110 s ainda vale');
      const fora = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      assert.equal((await estado(fora.credencial)).status, 200);
      await emitidaHa(fora.id, '130 seconds');
      const r = await estado(fora.credencial);
      assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, aviso(r));
      assert.equal((await a.eventos(fora.id, 'REUSO_CREDENCIAL')).length, 1);
      assert.equal((await a.linha(fora.id)).revogado_em, null);
    });

    test('T3 — a credencial anterior NUNCA renova nem obtém credencial: dentro da carência ela autentica sem Set-Cookie e sem alterar o banco, em qualquer número de vezes', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      assert.equal((await estado(t.credencial)).status, 200);
      const estadoDoBanco = JSON.stringify(await a.linha(t.id));
      for (let i = 0; i < 5; i += 1) {
        const r = await estado(t.credencial);
        assert.equal(r.status, 200, aviso(r));
        assert.equal(cookieDoTabletNaResposta(r), null);
      }
      assert.equal(JSON.stringify(await a.linha(t.id)), estadoDoBanco);
    });

    test('T4 — o cookie dura exatamente 180 dias (Max-Age) na ativação e na rotação', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const codigo = await a.codigoPendente(x);
      const ativacao = await a.ativar(app, codigo);
      assert.equal(ativacao.status, 200, aviso(ativacao));
      const c1 = cookieDoTabletNaResposta(ativacao);
      assert.equal(Number(c1.atributos['max-age']), 180 * 24 * 3600);
      await emitidaHa(x.id, '25 hours');
      const rotacao = await estado(c1.valor);
      assert.equal(Number(cookieDoTabletNaResposta(rotacao).atributos['max-age']), 180 * 24 * 3600);
    });

    test('T5 — o cookie de 180 dias NÃO é autorização: credencial emitida há 181 dias é 401 no servidor (sem rotação nem Set-Cookie), e a de 179 dias ainda é aceita e rotacionada', async () => {
      const velha = await a.ativado(a.d.empresaA);
      await emitidaHa(velha.id, '181 days');
      const r = await estado(velha.credencial);
      assert.deepEqual([r.status, r.body.codigo], NAO_AUTORIZADO, aviso(r));
      assert.equal(cookieDoTabletNaResposta(r), null);
      const quaseVelha = await a.ativado(a.d.empresaA);
      await emitidaHa(quaseVelha.id, '179 days');
      const ok = await estado(quaseVelha.credencial);
      assert.equal(ok.status, 200, aviso(ok));
      assert.ok(cookieDoTabletNaResposta(ok), 'rotaciona e volta a ter 24 h de vida útil');
    });

    test('T6 — credencial REVOGADA ou SUBSTITUÍDA com cookie ainda "novo" (menos de 180 dias) é 401: a validade do cookie não autoriza nada sozinha', async () => {
      const revogada = await a.ativado(a.d.empresaA);
      await revogar(revogada.id);
      assert.equal((await estado(revogada.credencial)).status, 401);
      const substituida = await a.ativado(a.d.empresaA);
      const codigo = (await gerar(substituida.id)).body.ativacao.codigo;
      assert.equal((await a.ativar(app, codigo)).status, 200);
      assert.equal((await estado(substituida.credencial)).status, 401);
    });
  });

  // ───────────────────────── D-C5: resposta de rotação perdida ─────────────────────────
  describe('D-C5 — resposta de rotação perdida e recuperação administrativa', () => {
    test('L1 — o tablet que perdeu a resposta da rotação (segue com a credencial antiga): vale na carência, depois é recusado com REUSO_CREDENCIAL e NUNCA é revogado; não há rotação automática pela anterior', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const perdida = await estado(t.credencial); // a rotação aconteceu no servidor; o tablet nunca recebeu o novo cookie
      assert.equal(perdida.status, 200, aviso(perdida));
      for (let i = 0; i < 3; i += 1) assert.equal((await estado(t.credencial)).status, 200, `tentativa ${i + 1} na carência`);
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 1, 'a anterior não provoca nova rotação');
      await emitidaHa(t.id, '15 minutes');
      const apos = await estado(t.credencial);
      assert.deepEqual([apos.status, apos.body.codigo], NAO_AUTORIZADO, aviso(apos));
      assert.equal(cookieDoTabletNaResposta(apos), null, 'nenhuma credencial é entregue a quem só tem a anterior');
      const l = await a.linha(t.id);
      assert.deepEqual([l.revogado_em, l.revogado_por], [null, null], 'a perda da resposta não revoga o tablet');
      assert.equal((await a.eventos(t.id, 'REUSO_CREDENCIAL')).length, 1);
    });

    test('L2 — a saída é a nova ativação autorizada pela SST: depois de perder a credencial, gerar e consumir o código restaura o tablet (e a credencial que o tablet nunca recebeu também é invalidada)', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const perdida = await estado(t.credencial);
      const naoRecebida = cookieDoTabletNaResposta(perdida).valor;
      await emitidaHa(t.id, '15 minutes');
      assert.equal((await estado(t.credencial)).status, 401);
      const codigo = (await gerar(t.id)).body.ativacao.codigo;
      const r = await a.ativar(app, codigo);
      assert.equal(r.status, 200, aviso(r));
      assert.equal((await estado(cookieDoTabletNaResposta(r).valor)).status, 200);
      for (const velha of [t.credencial, naoRecebida]) assert.equal((await estado(velha)).status, 401);
      assert.equal((await a.linha(t.id)).revogado_em, null);
    });

    test('L3 — requisições concorrentes durante a rotação nunca causam revogação: 12 simultâneas com a credencial vencida e depois 12 com a anterior deixam o tablet ATIVO', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const primeiro = await Promise.all(Array.from({ length: 12 }, () => estado(t.credencial)));
      assert.equal(primeiro.every((r) => r.status === 200), true, primeiro.map(aviso).join(' | '));
      const segundo = await Promise.all(Array.from({ length: 12 }, () => estado(t.credencial)));
      assert.equal(segundo.every((r) => r.status === 200), true);
      const l = await a.linha(t.id);
      assert.equal(l.revogado_em, null);
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 1);
    });
  });

  // ───────────────────────── D-C8: limites proporcionais e NAT ─────────────────────────
  describe('D-C8 — limites específicos, proporcionais e sem bloqueio coletivo por NAT', () => {
    test('N1 — o limite fino é POR TABLET: com o mesmo IP de saída, o tablet que estoura o seu limite recebe 429 e o outro continua 200; cabeçalhos do cliente não trocam a cota', async () => {
      const A1 = await a.ativado(a.d.empresaA);
      const A2 = await a.ativado(a.d.empresaA);
      const { chavePorDispositivo } = modulos().tabletRotas;
      const limitado = a.criarApp({ hops: 0, limitador: criarLimitador({ limite: 1000, janelaSegundos: 60 }), limitadorDispositivo: criarLimitador({ limite: 2, janelaSegundos: 60, chave: chavePorDispositivo }) });
      assert.equal((await estado(A1.credencial, {}, limitado)).status, 200);
      assert.equal((await estado(A1.credencial, {}, limitado)).status, 200);
      const barrado = await estado(A1.credencial, { 'X-Dispositivo-Id': '999', 'X-Empresa-Id': '999', 'X-Forwarded-For': '203.0.113.77' }, limitado);
      assert.deepEqual([barrado.status, barrado.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], aviso(barrado));
      assert.equal((await estado(A2.credencial, {}, limitado)).status, 200, 'o outro tablet do mesmo NAT não é bloqueado');
    });

    test('N2 — com os limitadores PADRÃO, dois tablets do mesmo IP fazem dezenas de requisições sem 429 (o NAT não soma uma cota apertada)', async () => {
      const padrao = a.criarApp({ hops: 0, limitador: null });
      const A1 = await a.ativado(a.d.empresaA);
      const A2 = await a.ativado(a.d.empresaA);
      for (let i = 0; i < 40; i += 1) {
        const r = await estado(i % 2 === 0 ? A1.credencial : A2.credencial, {}, padrao);
        assert.equal(r.status, 200, `requisição ${i + 1}: ${aviso(r)}`);
      }
    });

    test('N3 — a ativação tem o limite por IP mais apertado (padrão 30/min): a 31ª tentativa é 429, inclusive com código válido, que não é consumido', async () => {
      const padrao = a.criarApp({ hops: 0, limitador: null });
      const x = await a.dispositivo(a.d.empresaA);
      const valido = await a.codigoPendente(x);
      for (let i = 0; i < 30; i += 1) assert.equal((await a.ativar(padrao, gerarTokenSessao())).status, 401, `tentativa ${i + 1}`);
      const barrada = await a.ativar(padrao, valido);
      assert.deepEqual([barrada.status, barrada.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], aviso(barrada));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
    });

    test('N4 — no app REAL, o limitador GERAL por IP não se aplica às rotas do tablet (o NAT não as soma numa cota só) mas continua valendo para o resto de /api', () => {
      // O setup da suíte (--require) fixa o limite geral em 100000; o filho o reduz ANTES de carregar o app.
      const script = `
        process.env.RATE_LIMIT_GERAL_LIMITE = '3';
        const request = require('supertest');
        const app = require('./src/app');
        (async () => {
          const geral = []; const tablet = [];
          for (let i = 0; i < 6; i += 1) geral.push((await request(app).get('/api/rota-inexistente-do-teste')).status);
          for (let i = 0; i < 6; i += 1) tablet.push((await request(app).get('/api/atendimento-token/tablet/estado')).status);
          console.log(JSON.stringify({ geral, tablet }));
          process.exit(0);
        })();`;
      const r = spawnSync(process.execPath, ['--require', './test/setup.js', '-e', script], {
        cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', env: process.env,
      });
      assert.equal(r.status, 0, r.stderr);
      const { geral, tablet } = JSON.parse(r.stdout.trim().split('\n').pop());
      assert.deepEqual(geral, [404, 404, 404, 429, 429, 429], 'o resto de /api segue limitado a 3 por janela');
      assert.deepEqual(tablet, [401, 401, 401, 401, 401, 401], 'o tablet não consome a cota geral (cada rota tem os seus limitadores)');
    });
  });

  // ───────────────────────── travas do consumo: provas determinísticas (sem depender da sorte do paralelismo) ─────────────────────────
  describe('consumo do código sob trava (determinístico)', () => {
    /** Segura uma transação que já travou `sql`, dispara a ativação (que precisa BLOQUEAR) e só então deixa a transação consumir o código. */
    async function consumoPorOutraTransacao(sqlDaTrava, x, codigo) {
      const concorrente = await a.ctx.pool.connect();
      try {
        await concorrente.query('BEGIN');
        await concorrente.query(sqlDaTrava, [x.id]);
        const ativacao = a.ativar(app, codigo);
        const desfecho = await Promise.race([ativacao.then(() => 'terminou'), new Promise((r) => setTimeout(() => r('bloqueada'), 400))]);
        assert.equal(desfecho, 'bloqueada', 'a ativação deveria esperar a trava, não prosseguir com uma leitura velha');
        await concorrente.query('UPDATE token_ativacoes SET usado_em = clock_timestamp() WHERE dispositivo_id = $1 AND usado_em IS NULL', [x.id]);
        await concorrente.query('COMMIT');
        return await ativacao;
      } finally {
        concorrente.release();
      }
    }

    test('D3 — com a linha do TABLET travada por outra transação, a ativação espera e, quando o código já foi consumido, é 401 genérica (relê sob trava; nada é emitido)', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const codigo = await a.codigoPendente(x);
      const r = await consumoPorOutraTransacao('SELECT id FROM token_dispositivos WHERE id = $1 FOR UPDATE', x, codigo);
      assert.deepEqual([r.status, r.body.codigo], [401, 'ATIVACAO_INVALIDA'], aviso(r));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
    });

    test('D4 — com a linha da ATIVAÇÃO travada por outra transação, a ativação espera e, quando o código já foi consumido, é 401 genérica (uso único também sob a trava da própria ativação)', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const codigo = await a.codigoPendente(x);
      const r = await consumoPorOutraTransacao('SELECT id FROM token_ativacoes WHERE dispositivo_id = $1 FOR UPDATE', x, codigo);
      assert.deepEqual([r.status, r.body.codigo], [401, 'ATIVACAO_INVALIDA'], aviso(r));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
    });
  });

  // ───────────────────────── origem de rede indeterminada e privilégios ─────────────────────────
  describe('origem indeterminada e ausência de privilégio administrativo', () => {
    test('O1 — endereço de origem que o servidor não consegue resolver (cabeçalho do proxy ilegível, zona de interface, faixa) NUNCA autoriza: 403 na ativação e no estado, mesmo com a rede do IP de teste cadastrada', async () => {
      const umSalto = a.criarApp({ hops: 1 });
      const t = await a.ativado(a.d.empresaA);
      const x = await a.dispositivo(a.d.empresaA);
      const codigo = await a.codigoPendente(x);
      for (const ilegivel of ['garbage', 'fe80::1%eth0', '203.0.113.0/24', '999.1.1.1']) {
        const r = await estado(t.credencial, { 'X-Forwarded-For': ilegivel }, umSalto);
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], `estado com "${ilegivel}" → ${aviso(r)}`);
      }
      const a1 = await a.ativar(umSalto, codigo, { 'X-Forwarded-For': 'garbage' });
      assert.deepEqual([a1.status, a1.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(a1));
      assert.equal((await a.linha(x.id)).credencial_hash, null);
    });

    test('O2 — o mesmo endereço escrito de formas equivalentes vale como UM: IPv4 mapeado em IPv6 casa com o IP_FIXO IPv4, e IPv6 exato casa com o IP_FIXO /128 (comparação canônica)', async () => {
      const umSalto = a.criarApp({ hops: 1 });
      const t = await a.ativado(a.d.empresaA);
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '203.0.113.9/32' }, { tipo: 'IP_FIXO', rede: '2001:db8::7/128' }], B: [] });
      for (const origem of ['203.0.113.9', '::ffff:203.0.113.9', '2001:db8::7', '2001:0db8:0000:0000:0000:0000:0000:0007']) {
        const r = await estado(t.credencial, { 'X-Forwarded-For': origem }, umSalto);
        assert.equal(r.status, 200, `${origem} → ${aviso(r)}`);
      }
      const vizinho = await estado(t.credencial, { 'X-Forwarded-For': '203.0.113.10' }, umSalto);
      assert.equal(vizinho.status, 403, 'IP vizinho da mesma faixa NÃO é autorizado');
    });

    test('O3 — a credencial do tablet NÃO concede privilégio administrativo ao código que vem depois: req.usuario, req.empresa e req.sessao seguem indefinidos e só req.dispositivo existe', async () => {
      const express = require('express');
      const { criarAppTeste } = require('../helpers/app-teste');
      const { criarExigirDispositivo } = require('../../src/middleware/autenticacao-dispositivo');
      const t = await a.ativado(a.d.empresaA);
      const sonda = criarAppTeste((ap) => {
        ap.use('/sonda', express.Router().get('/', criarExigirDispositivo({ pool: a.ctx.pool }), (req, res) => res.json({
          usuario: req.usuario === undefined, empresa: req.empresa === undefined, sessao: req.sessao === undefined, validado: req.validado === undefined,
          dispositivo: Object.keys(req.dispositivo).sort(),
        })));
      });
      const r = await require('supertest')(sonda).get('/sonda').set('Cookie', `gepi_tablet=${t.credencial}`);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(r.body, { usuario: true, empresa: true, sessao: true, validado: true, dispositivo: ['empresaId', 'id', 'localInstalacao', 'nome', 'setor', 'unidade'] });
    });

    test('O4 — rotação sem NENHUMA guarda (nem credencial atual, nem prazo devido) seria detectada: 8 simultâneas rotacionam uma única vez e o tablet termina com a credencial do vencedor', async () => {
      const t = await a.ativado(a.d.empresaA, { horasDesdeEmissao: 25 });
      const respostas = await Promise.all(Array.from({ length: 8 }, () => estado(t.credencial)));
      assert.equal(respostas.filter((r) => cookieDoTabletNaResposta(r) !== null).length, 1);
      assert.equal((await a.eventos(t.id, 'CREDENCIAL_RENOVADA')).length, 1);
      const vencedora = respostas.map((r) => cookieDoTabletNaResposta(r)).find((c) => c !== null).valor;
      assert.equal((await a.linha(t.id)).credencial_hash, hashTokenSessao(vencedora));
    });
  });

  // ───────────────────────── Plataforma: nada de User-Agent como prova ─────────────────────────
  describe('plataforma — o tipo de equipamento não é decidido por User-Agent', () => {
    const AGENTES = {
      iPad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      androidTablet: 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      celular: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    };

    test('P1 — o resultado depende só de credencial, tablet, empresa e rede: iPad (homologação), tablet Android, celular e desktop recebem a MESMA resposta (nenhum bloqueio nem liberação por User-Agent)', async () => {
      const t = await a.ativado(a.d.empresaA);
      for (const [nome, agente] of Object.entries(AGENTES)) {
        const r = await estado(t.credencial, { 'User-Agent': agente });
        assert.equal(r.status, 200, `${nome}: ${aviso(r)}`);
      }
      await a.redes({ A: [], B: [] });
      for (const [nome, agente] of Object.entries(AGENTES)) {
        const r = await estado(t.credencial, { 'User-Agent': agente });
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], `${nome} não contorna a rede: ${aviso(r)}`);
      }
    });

    test('P2 — a ativação também não olha o User-Agent: um iPad ativa com o código válido e um "tablet" que não tem o código não ativa por parecer tablet', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const codigo = await a.codigoPendente(x);
      const sem = await a.ativar(app, gerarTokenSessao(), { 'User-Agent': AGENTES.androidTablet });
      assert.deepEqual([sem.status, sem.body.codigo], [401, 'ATIVACAO_INVALIDA']);
      const ok = await a.ativar(app, codigo, { 'User-Agent': AGENTES.iPad });
      assert.equal(ok.status, 200, aviso(ok));
    });
  });
});
