'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { assertSemSensiveis } = require('../helpers/sensiveis');

/**
 * Auditoria da ativação de contexto empresarial (seleção e troca de
 * empresa) pelo login global, ponta a ponta, com PostgreSQL real em schema
 * temporário com todas as migrations.
 *
 * Cada empresa só enxerga o que aconteceu nela: no destino,
 * EMPRESA_SELECIONADA com o tipo (SELECAO_INICIAL, TROCA ou RESELECAO); na
 * origem, só numa troca real, EMPRESA_CONTEXTO_ENCERRADO com o motivo
 * TROCA_EMPRESA. Nenhum registro cita a outra empresa, o usuário dela ou a
 * sessão global. A auditoria anda na mesma transação da troca.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 46 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-da-troca-2026';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const ACOES = ['EMPRESA_SELECIONADA', 'EMPRESA_CONTEXTO_ENCERRADO'];

const ANA = 'ana.troca@exemplo-cliente.com.br';     // A (MASTER) + B (USUARIO)
const BRUNO = 'bruno.troca@exemplo-cliente.com.br'; // só C

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par, ...atributos] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = { valor: par.slice(i + 1), removido: atributos.some((a) => /^\s*max-age=0\s*$/i.test(a)) };
  }
  return saida;
}

describe('auditoria da seleção e da troca de empresa (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  const empresa = {};
  const usuario = {};
  const identidade = {};
  const sensiveis = [SENHA, 'senha_hash', 'token_hash'];

  const q = (sql, params) => pool.query(sql, params);
  const ultimoId = async () => (await q('SELECT coalesce(max(id), 0)::text AS id FROM logs_auditoria')).rows[0].id;
  const eventosDesde = async (id) => (await q(
    `SELECT empresa_id, usuario_id, acao, referencia, descricao, dispositivo, contexto, dados_anteriores, dados_novos
       FROM logs_auditoria WHERE id > $1 AND acao = ANY($2) ORDER BY id`,
    [id, ACOES],
  )).rows;
  const resumo = (eventos) => eventos.map((e) => [e.empresa_id, e.usuario_id, e.acao, e.contexto]);

  async function entrar(email, userAgent) {
    const req = request(app).post('/api/auth/global/login');
    if (userAgent) req.set('User-Agent', userAgent);
    const r = await req.send({ email, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const c = cookiesDe(r);
    sensiveis.push(c[C_GLOBAL].valor);
    if (c[C_EMPRESA] && !c[C_EMPRESA].removido) sensiveis.push(c[C_EMPRESA].valor);
    return { global: c[C_GLOBAL].valor, empresarial: c[C_EMPRESA] && !c[C_EMPRESA].removido ? c[C_EMPRESA].valor : null };
  }

  /** POST .../selecionar com os cookies informados; devolve a resposta e o novo cookie empresarial. */
  async function selecionar(sessao, empresaId) {
    const cookies = [sessao.global && `${C_GLOBAL}=${sessao.global}`, sessao.empresarial && `${C_EMPRESA}=${sessao.empresarial}`].filter(Boolean).join('; ');
    const req = request(app).post(`/api/auth/global/empresas/${empresaId}/selecionar`);
    if (cookies) req.set('Cookie', cookies);
    const r = await req.send();
    const c = cookiesDe(r);
    if (r.status === 200) {
      sensiveis.push(c[C_EMPRESA].valor);
      return { r, sessao: { ...sessao, empresarial: c[C_EMPRESA].valor } };
    }
    return { r, sessao };
  }

  const contextoValido = async (empresarial) => (await request(app).get('/api/auth/me').set('Cookie', `${C_EMPRESA}=${empresarial}`));

  before(async () => {
    const hash = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao: criarExigirSessao({ pool }) }),
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
      );
    });
    for (const [chave, nome, cnpj] of [['A', 'Empresa Alfa Troca', '11222333000181'], ['B', 'Empresa Beta Troca', '22333444000100'], ['C', 'Empresa Gama Troca', '33444555000119']]) {
      empresa[chave] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[chave], dryRun: false });
    }
    for (const [chave, email] of [['ana', ANA], ['bruno', BRUNO]]) {
      identidade[chave] = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
    }
    const vinculo = async (chave, empresaId, identidadeId, perfil) => {
      usuario[chave] = (await q('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id',
        [empresaId, `Pessoa ${chave}`, perfil, identidadeId])).rows[0].id;
    };
    await vinculo('anaA', empresa.A, identidade.ana, 'MASTER');
    await vinculo('anaB', empresa.B, identidade.ana, 'USUARIO');
    await vinculo('brunoC', empresa.C, identidade.bruno, 'ADMINISTRADOR');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('1. seleção inicial automática (uma empresa): um único evento, no destino, SELECAO_INICIAL, com o usuário de lá e o User-Agent cortado em 150', async () => {
    const antes = await ultimoId();
    await entrar(BRUNO, 'U'.repeat(300));
    const eventos = await eventosDesde(antes);
    assert.deepEqual(resumo(eventos), [[empresa.C, usuario.brunoC, 'EMPRESA_SELECIONADA', { tipo: 'SELECAO_INICIAL' }]]);
    assert.equal(eventos[0].dispositivo, 'U'.repeat(150));
  });

  test('1. seleção inicial escolhida na tela (várias empresas): um único evento, no destino', async () => {
    const sessao = await entrar(ANA);
    assert.equal(sessao.empresarial, null, 'com duas empresas nada é selecionado sozinho');
    const antes = await ultimoId();
    const { r } = await selecionar(sessao, empresa.A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(resumo(await eventosDesde(antes)), [[empresa.A, usuario.anaA, 'EMPRESA_SELECIONADA', { tipo: 'SELECAO_INICIAL' }]]);
  });

  test('2, 3 e 4. troca A → B: exatamente um encerramento em A e uma ativação em B, e nenhum dos dois cita a outra empresa', async () => {
    const inicial = await selecionar(await entrar(ANA), empresa.A);
    const antes = await ultimoId();
    const { r } = await selecionar(inicial.sessao, empresa.B);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const eventos = await eventosDesde(antes);
    assert.deepEqual(resumo(eventos), [
      [empresa.A, usuario.anaA, 'EMPRESA_CONTEXTO_ENCERRADO', { motivo: 'TROCA_EMPRESA' }],
      [empresa.B, usuario.anaB, 'EMPRESA_SELECIONADA', { tipo: 'TROCA' }],
    ]);
    // Empresa, usuário e contexto exatos, e nenhum outro campo preenchido:
    // não sobra lugar para citar a outra empresa, o usuário dela ou a sessão global.
    for (const e of eventos) {
      assert.deepEqual([e.referencia, e.descricao, e.dados_anteriores, e.dados_novos], [null, null, null, null]);
    }
    const [emA, emB] = eventos.map((e) => JSON.stringify(e));
    for (const outraEmB of ['Empresa Beta Troca', '22333444000100']) assert.equal(emA.includes(outraEmB), false, `A cita ${outraEmB}`);
    for (const outraEmA of ['Empresa Alfa Troca', '11222333000181']) assert.equal(emB.includes(outraEmA), false, `B cita ${outraEmA}`);
    assert.equal((await contextoValido(inicial.sessao.empresarial)).status, 401, 'o contexto de A foi encerrado');
  });

  test('5. sessões antigas (revogadas, expiradas ou inativas) do mesmo login não geram evento; só o contexto que valia gera', async () => {
    const sessao = await entrar(ANA);
    const global = (await q('SELECT id::text FROM sessoes_globais WHERE identidade_id = $1 ORDER BY id DESC LIMIT 1', [identidade.ana])).rows[0].id;
    const antiga = (extra) => q(
      `INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, autenticado_via, sessao_global_id, criado_em, ultimo_uso_em, revogada_em, motivo_revogacao)
       VALUES ($1, $2, $3, $4, 'SESSAO_GLOBAL', $5, now() - interval '2 days', $6, $7, $8)`,
      [empresa.A, usuario.anaA, crypto.randomBytes(32).toString('hex'), extra.expira, global, extra.uso, extra.revogada ?? null, extra.revogada ? 'TROCA_EMPRESA' : null],
    );
    await antiga({ expira: new Date(Date.now() + 3600e3), uso: new Date(), revogada: new Date(Date.now() - 60e3) });
    await antiga({ expira: new Date(Date.now() - 60e3), uso: new Date(Date.now() - 120e3) });
    await antiga({ expira: new Date(Date.now() + 3600e3), uso: new Date(Date.now() - (authConfig.sessao.inatividadeMinutos + 5) * 60e3) });

    let antes = await ultimoId();
    const emA = await selecionar(sessao, empresa.A);
    assert.equal(emA.r.status, 200);
    assert.deepEqual(resumo(await eventosDesde(antes)), [[empresa.A, usuario.anaA, 'EMPRESA_SELECIONADA', { tipo: 'SELECAO_INICIAL' }]], 'nenhum contexto válido antes: é seleção inicial');

    antes = await ultimoId();
    const emB = await selecionar(emA.sessao, empresa.B);
    assert.equal(emB.r.status, 200);
    assert.deepEqual(resumo(await eventosDesde(antes)), [
      [empresa.A, usuario.anaA, 'EMPRESA_CONTEXTO_ENCERRADO', { motivo: 'TROCA_EMPRESA' }],
      [empresa.B, usuario.anaB, 'EMPRESA_SELECIONADA', { tipo: 'TROCA' }],
    ]);
  });

  test('6. selecionar de novo a mesma empresa: um único evento RESELECAO no destino, sem encerramento nem falsa troca', async () => {
    const emB = await selecionar(await entrar(ANA), empresa.B);
    const antes = await ultimoId();
    const denovo = await selecionar(emB.sessao, empresa.B);
    assert.equal(denovo.r.status, 200);
    assert.deepEqual(resumo(await eventosDesde(antes)), [[empresa.B, usuario.anaB, 'EMPRESA_SELECIONADA', { tipo: 'RESELECAO' }]]);
    assert.equal((await contextoValido(denovo.sessao.empresarial)).status, 200);
  });

  for (const [rotulo, acaoQueFalha] of [['a ativação no destino', 'EMPRESA_SELECIONADA'], ['o encerramento na origem', 'EMPRESA_CONTEXTO_ENCERRADO']]) {
    test(`7. falha ao gravar ${rotulo}: a troca não acontece — nenhuma sessão nova, a anterior continua válida, nenhum evento`, async () => {
      const emA = await selecionar(await entrar(ANA), empresa.A);
      const sessoesAntes = (await q('SELECT count(*)::int AS n FROM sessoes')).rows[0].n;
      await q(`CREATE FUNCTION falhar_auditoria_teste() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'auditoria indisponível no teste'; END $$ LANGUAGE plpgsql`);
      await q(`CREATE TRIGGER trg_falhar_auditoria_teste BEFORE INSERT ON logs_auditoria FOR EACH ROW
               WHEN (NEW.acao = '${acaoQueFalha}') EXECUTE FUNCTION falhar_auditoria_teste()`);
      try {
        const antes = await ultimoId();
        const troca = await selecionar(emA.sessao, empresa.B);
        assert.equal(troca.r.status, 500);
        assert.equal(C_EMPRESA in cookiesDe(troca.r), false, 'nenhum cookie novo');
        assert.deepEqual(await eventosDesde(antes), []);
        assert.equal((await q('SELECT count(*)::int AS n FROM sessoes')).rows[0].n, sessoesAntes, 'nenhuma sessão criada');
        const me = await contextoValido(emA.sessao.empresarial);
        assert.deepEqual([me.status, me.body.empresa && me.body.empresa.id], [200, empresa.A], 'o contexto de A não foi encerrado');
      } finally {
        await q('DROP TRIGGER trg_falhar_auditoria_teste ON logs_auditoria');
        await q('DROP FUNCTION falhar_auditoria_teste()');
      }
    });
  }

  test('8. empresa sem vínculo: 403, nenhum evento, e o contexto atual continua', async () => {
    const emA = await selecionar(await entrar(ANA), empresa.A);
    const antes = await ultimoId();
    const recusa = await selecionar(emA.sessao, empresa.C);
    assert.deepEqual([recusa.r.status, recusa.r.body.codigo], [403, 'EMPRESA_NAO_AUTORIZADA']);
    assert.deepEqual(await eventosDesde(antes), []);
    assert.equal((await contextoValido(emA.sessao.empresarial)).status, 200);
  });

  test('9. sem sessão global, só com o cookie empresarial, ou com a sessão global de outra pessoa: recusado, nenhum evento', async () => {
    const emA = await selecionar(await entrar(ANA), empresa.A);
    const bruno = await entrar(BRUNO);
    const antes = await ultimoId();
    const soEmpresarial = await selecionar({ global: null, empresarial: emA.sessao.empresarial }, empresa.B);
    assert.equal(soEmpresarial.r.status, 401);
    const outraPessoa = await selecionar({ global: bruno.global, empresarial: emA.sessao.empresarial }, empresa.A);
    assert.deepEqual([outraPessoa.r.status, outraPessoa.r.body.codigo], [403, 'EMPRESA_NAO_AUTORIZADA']);
    assert.deepEqual(await eventosDesde(antes), []);
    assert.equal((await contextoValido(emA.sessao.empresarial)).status, 200, 'a recusa não encerra o contexto de ninguém');
  });

  test('10. nenhum registro de seleção ou troca guarda senha, hash, token, cookie, e-mail ou sessão global', async () => {
    const eventos = (await q('SELECT row_to_json(l)::text AS linha FROM logs_auditoria l WHERE acao = ANY($1)', [ACOES])).rows.map((r) => r.linha);
    assert.ok(eventos.length >= 8, `eventos: ${eventos.length}`);
    const hashes = (await q('SELECT token_hash FROM sessoes')).rows.map((r) => r.token_hash);
    const globais = (await q('SELECT id::text, token_hash FROM sessoes_globais')).rows;
    const proibidos = [...sensiveis, ...hashes, ...globais.map((g) => g.token_hash), ANA, BRUNO];
    for (const linha of eventos) {
      assertSemSensiveis(linha, proibidos, 'registro de auditoria');
      assert.equal(/token|senha|password|cookie|authorization|secret|sessao_?global/i.test(JSON.stringify(JSON.parse(linha).contexto)), false, linha);
    }
  });
});
