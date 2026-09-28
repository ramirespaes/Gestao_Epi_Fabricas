'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { inserirLote, baixarLote, somarDias } = require('./helpers/estoque-lotes');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarEstoqueController } = require('../../src/controllers/estoque.controller');
const { criarEstoqueRoutes } = require('../../src/routes/estoque.routes');
const { criarDashboardController } = require('../../src/controllers/dashboard.controller');
const { criarDashboardRoutes } = require('../../src/routes/dashboard.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * E7 — Validade de estoque: GET /api/estoque/validade, lote a lote, com
 * PostgreSQL real e data operacional controlada. Às 23h30 de 30/09 em São
 * Paulo o UTC já está em 01/10; o CURRENT_DATE do banco é outro dia.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 46 }, (_, i) => String(i).padStart(3, '0'));
const HOJE = '2026-09-30';
const NOITE_DE_30_09 = () => new Date('2026-10-01T02:30:00Z');
const MADRUGADA_DE_01_10 = () => new Date('2026-10-01T03:30:00Z');
const SENHA = 'senha-forte-da-validade-2026';
const EMAILS = {
  masterA: 'master.a.validade@exemplo-cliente.com.br',
  usuarioA: 'usuario.a.validade@exemplo-cliente.com.br', // sem stockValidity
  masterB: 'master.b.validade@exemplo-cliente.com.br',
};
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('E7 — validade de estoque por lote (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let appMadrugada;
  const empresa = {};
  const u = {};
  const m = {};
  const lote = {};
  const cookie = {};

  const get = (quem, rota, alvo = app) => request(alvo).get(rota).set('Cookie', cookie[quem]);
  const validade = (quem, query = '', alvo = app) => get(quem, `/api/estoque/validade${query}`, alvo);
  const porId = (lotes) => Object.fromEntries(lotes.map((l) => [l.loteId, l]));
  const saldoDe = async (loteId) => (await pool.query('SELECT saldo FROM estoque_lotes WHERE id = $1', [loteId])).rows[0].saldo;
  const baixa = (quem, loteId, quantidade, motivo = 'CA_VENCIDO') => request(app).post(`/api/estoque/lotes/${loteId}/baixas`).set('Cookie', cookie[quem])
    .send({ quantidade, motivo, chaveIdempotencia: crypto.randomUUID() });

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const q = (sql, params) => pool.query(sql, params);
    const hash = await gerarHashSenha(SENHA);

    for (const [k, nome, cnpj] of [['A', 'Empresa Alfa Validade', '11222333000181'], ['B', 'Empresa Beta Validade', '22333444000100']]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
      await provisionamento.provisionar(pool, { empresaId: empresa[k], dryRun: false });
    }
    const vinculo = async (chave, empresaId, email, perfil) => {
      const id = (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      u[chave] = (await q('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4) RETURNING id',
        [empresaId, chave, perfil, id])).rows[0].id;
    };
    await vinculo('masterA', empresa.A, EMAILS.masterA, 'MASTER');
    await vinculo('usuarioA', empresa.A, EMAILS.usuarioA, 'USUARIO');
    await vinculo('masterB', empresa.B, EMAILS.masterB, 'MASTER');

    const material = async (chave, empresaId, nome, { tipo, categoria = 'EPI', exigeCa = true, ativo = true } = {}) => {
      m[chave] = (await q(
        'INSERT INTO materiais (empresa_id, nome, tipo, categoria, exige_ca, ativo, codigo_interno) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [empresaId, nome, tipo, categoria, exigeCa, ativo, `COD-${chave}`],
      )).rows[0].id;
    };
    const novoLote = (chave, empresaId, materialChave, tamanho, quantidade, validadeCa, ca = validadeCa ? `CA-${chave}` : null) =>
      inserirLote(pool, { empresaId, materialId: m[materialChave], tamanho, quantidade, ca, validade: validadeCa }).then((id) => { lote[chave] = id; });

    await material('botina', empresa.A, 'Botina de segurança', { tipo: 'Sapatão / Botina' });
    await material('luva', empresa.A, 'Luva nitrílica', { tipo: 'Luva' });
    await material('uniforme', empresa.A, 'Uniforme', { tipo: 'Roupa / Uniforme', categoria: 'Uniforme', exigeCa: false });
    await material('oculos', empresa.A, 'Óculos incolor', { tipo: 'Óculos de proteção' });
    await material('inativo', empresa.A, 'Luva antiga', { tipo: 'Luva', ativo: false });
    await material('botinaB', empresa.B, 'Botina B', { tipo: 'Sapatão / Botina' });

    await novoLote('vencida', empresa.A, 'botina', '40', 5, somarDias(HOJE, -1));
    await novoLote('valida', empresa.A, 'botina', '40', 10, '2026-12-31');
    await novoLote('hoje', empresa.A, 'botina', '41', 4, HOJE);
    await novoLote('aVencer30', empresa.A, 'botina', '42', 3, somarDias(HOJE, 30));
    await novoLote('limite60', empresa.A, 'botina', '43', 2, somarDias(HOJE, 60));
    await novoLote('alem61', empresa.A, 'botina', '44', 1, somarDias(HOJE, 61));
    await novoLote('zerada', empresa.A, 'botina', '40', 3, '2026-09-01');
    await baixarLote(pool, { empresaId: empresa.A, loteId: lote.zerada, quantidade: 3, usuarioId: u.masterA });
    await novoLote('semCa', empresa.A, 'luva', 'M', 8, null);
    await novoLote('naoExige', empresa.A, 'uniforme', 'G', 6, null);
    await novoLote('oculosVencido', empresa.A, 'oculos', null, 7, '2026-09-01');
    await novoLote('inativo', empresa.A, 'inativo', 'P', 9, '2026-08-01');
    await novoLote('bVencida', empresa.B, 'botinaB', '40', 50, '2026-09-01');
    await novoLote('bValida', empresa.B, 'botinaB', '40', 7, '2027-03-31');

    const montar = (relogio) => {
      const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
      const exigirSessao = criarExigirSessao({ pool });
      return criarAppTeste((a) => {
        a.use(
          '/api',
          criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
          criarEstoqueRoutes({ controller: criarEstoqueController({ pool, relogio }), exigirSessao, pool }),
          criarDashboardRoutes({ controller: criarDashboardController({ pool, relogio }), exigirSessao, pool }),
        );
      });
    };
    app = montar(NOITE_DE_30_09);
    appMadrugada = montar(MADRUGADA_DE_01_10);
    for (const k of Object.keys(EMAILS)) {
      const login = await request(app).post('/api/auth/global/login').send({ email: EMAILS[k], senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
      assert.equal(login.status, 200, JSON.stringify(login.body));
      const c = cookiesDe(login);
      cookie[k] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${c[C_EMPRESA]}`;
    }
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('1 a 8. cada lote com saldo traz a situação do CA, o saldo físico, o bloqueado e o disponível; vencido e sem CA bloqueados; vence hoje, a vencer, válido e não exige CA disponíveis', async () => {
    const r = await validade('masterA', '?limite=100');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.hoje, r.body.diasAlerta], [HOJE, 60]);
    const l = porId(r.body.lotes);
    const resumo = (id) => [l[id].situacaoCa, l[id].fisico, l[id].bloqueado, l[id].disponivel];
    assert.deepEqual(resumo(lote.vencida), ['VENCIDO', 5, 5, 0]);
    assert.deepEqual(resumo(lote.oculosVencido), ['VENCIDO', 7, 7, 0]);
    assert.deepEqual(resumo(lote.hoje), ['VENCE_HOJE', 4, 0, 4]);
    assert.deepEqual(resumo(lote.aVencer30), ['A_VENCER', 3, 0, 3]);
    assert.deepEqual(resumo(lote.limite60), ['A_VENCER', 2, 0, 2], '60 dias ainda é a vencer');
    assert.deepEqual(resumo(lote.alem61), ['VALIDO', 1, 0, 1], '61 dias já é válido');
    assert.deepEqual(resumo(lote.valida), ['VALIDO', 10, 0, 10]);
    assert.deepEqual(resumo(lote.semCa), ['SEM_CA', 8, 8, 0]);
    assert.deepEqual(resumo(lote.naoExige), ['NAO_EXIGE_CA', 6, 0, 6]);
    assert.deepEqual(l[lote.vencida], {
      loteId: lote.vencida, materialId: m.botina, material: 'Botina de segurança', codigoInterno: 'COD-botina', categoria: 'EPI', tipo: 'Sapatão / Botina',
      materialAtivo: true, tamanho: '40', caNumero: 'CA-vencida', caValidade: somarDias(HOJE, -1), fisico: 5, bloqueado: 5, disponivel: 0, situacaoCa: 'VENCIDO',
    });
    assert.deepEqual([l[lote.naoExige].caNumero, l[lote.naoExige].caValidade], [null, null], 'nada de CA inventado');
    assert.equal(l[lote.oculosVencido].tamanho, null, 'tamanho único vem null; a tela mostra "Único"');
    assert.deepEqual(r.body.lotes.slice(0, 2).map((x) => x.situacaoCa), ['VENCIDO', 'VENCIDO'], 'os vencidos vêm primeiro');
  });

  // E9: inativar o cadastro não faz o estoque físico desaparecer; o lote de material inativo com saldo aparece, marcado.
  test('9. lote zerado fica fora; lote de material inativo com saldo aparece marcado e conta nos indicadores', async () => {
    const r = await validade('masterA', '?limite=100');
    const ids = r.body.lotes.map((x) => x.loteId);
    assert.equal(ids.includes(lote.zerada), false);
    const inativo = porId(r.body.lotes)[lote.inativo];
    assert.deepEqual([inativo.materialAtivo, inativo.situacaoCa, inativo.fisico, inativo.bloqueado], [false, 'VENCIDO', 9, 9]);
    assert.equal(r.body.total, 10);
    assert.deepEqual(r.body.indicadores, { lotes: 10, vencido: 3, venceHoje: 1, aVencer: 2, valido: 2, semCa: 1, naoExigeCa: 1, bloqueados: 4 });
  });

  test('10. empresa A não vê lote da B, e B não vê lote da A', async () => {
    const a = await validade('masterA', '?limite=100');
    const b = await validade('masterB', '?limite=100');
    assert.deepEqual(b.body.lotes.map((x) => x.loteId).sort(), [lote.bVencida, lote.bValida].sort());
    assert.equal(a.body.lotes.some((x) => [lote.bVencida, lote.bValida].includes(x.loteId)), false);
    assert.deepEqual([b.body.indicadores.vencido, b.body.indicadores.valido, b.body.indicadores.lotes], [1, 1, 2]);
  });

  test('11. cada filtro devolve só a situação pedida; VENCIMENTO_PROXIMO junta vence hoje e a vencer; os indicadores não mudam com o filtro', async () => {
    const todos = await validade('masterA', '?limite=100');
    for (const [filtro, aceitas] of [['VENCIDO', ['VENCIDO']], ['VENCE_HOJE', ['VENCE_HOJE']], ['A_VENCER', ['A_VENCER']], ['VALIDO', ['VALIDO']],
      ['SEM_CA', ['SEM_CA']], ['NAO_EXIGE_CA', ['NAO_EXIGE_CA']], ['VENCIMENTO_PROXIMO', ['VENCE_HOJE', 'A_VENCER']]]) {
      const r = await validade('masterA', `?situacao=${filtro}&limite=100`);
      assert.equal(r.status, 200, filtro);
      const esperados = todos.body.lotes.filter((x) => aceitas.includes(x.situacaoCa)).map((x) => x.loteId).sort();
      assert.deepEqual(r.body.lotes.map((x) => x.loteId).sort(), esperados, filtro);
      assert.equal(r.body.total, esperados.length, filtro);
      assert.deepEqual(r.body.indicadores, todos.body.indicadores, `${filtro}: indicadores são do conjunto inteiro`);
    }
  });

  test('12. filtro adulterado, parâmetro desconhecido ou limite acima do teto: 400 VALIDACAO, sem consultar lote nenhum', async () => {
    for (const query of ['?situacao=vencido', '?situacao=EXPIRED', "?situacao=VENCIDO'%20OR%201=1", '?situacao=', '?empresaId=2', '?limite=1000', '?busca=' + 'x'.repeat(101)]) {
      const r = await validade('masterA', query);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], query);
      assert.equal('lotes' in r.body, false, query);
    }
  });

  test('busca por material ou CA, sem diferenciar maiúsculas; % e _ são texto', async () => {
    const porNome = await validade('masterA', '?busca=BOTINA&limite=100');
    assert.ok(porNome.body.lotes.length > 0 && porNome.body.lotes.every((x) => x.materialId === m.botina));
    const porCa = await validade('masterA', '?busca=ca-valida');
    assert.deepEqual(porCa.body.lotes.map((x) => x.loteId), [lote.valida]);
    for (const coringa of ['%25', '_']) {
      assert.equal((await validade('masterA', `?busca=${coringa}`)).body.total, 0, coringa);
    }
  });

  test('paginação: limite e página sobre a ordem da lista; total do conjunto filtrado', async () => {
    const todos = (await validade('masterA', '?limite=100')).body.lotes.map((x) => x.loteId);
    const pagina2 = await validade('masterA', '?limite=2&pagina=2');
    assert.deepEqual([pagina2.body.pagina, pagina2.body.limite, pagina2.body.total], [2, 2, 10]);
    assert.deepEqual(pagina2.body.lotes.map((x) => x.loteId), todos.slice(2, 4));
  });

  test('autenticação e RBAC: sem sessão 401; sem stockValidity.visualizar 403', async () => {
    assert.equal((await request(app).get('/api/estoque/validade')).status, 401);
    const r = await validade('usuarioA');
    assert.equal(r.status, 403);
    assert.equal('lotes' in r.body, false);
  });

  test('15. saldo físico e disponível diferem pelo bloqueado, no lote e no conjunto', async () => {
    const r = await validade('masterA', '?limite=100');
    const soma = (campo) => r.body.lotes.reduce((t, x) => t + x[campo], 0);
    assert.equal(soma('fisico'), soma('disponivel') + soma('bloqueado'));
    assert.ok(soma('bloqueado') > 0 && soma('fisico') !== soma('disponivel'));
    for (const x of r.body.lotes) assert.equal(x.fisico, x.disponivel + x.bloqueado);
  });

  test('16. o Dashboard conta os mesmos lotes vencidos, sem tratar vence hoje como vencido', async () => {
    const v = await validade('masterA');
    const d = await get('masterA', '/api/dashboard/indicadores');
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.indicadores.caVencido.valor, v.body.indicadores.vencido);
    assert.equal(d.body.indicadores.caVencido.aVencer, v.body.indicadores.venceHoje + v.body.indicadores.aVencer);
  });

  test('18. a data vem de São Paulo: às 23h30 de 30/09 (UTC já em 01/10) o lote de 30/09 vence hoje; à 00h30 de 01/10 está vencido', async () => {
    const noite = await validade('masterA', '?limite=100');
    const madrugada = await validade('masterA', '?limite=100', appMadrugada);
    assert.deepEqual([noite.body.hoje, madrugada.body.hoje], [HOJE, '2026-10-01']);
    assert.equal(porId(noite.body.lotes)[lote.hoje].situacaoCa, 'VENCE_HOJE', 'não é o UTC nem o CURRENT_DATE do banco');
    assert.equal(porId(madrugada.body.lotes)[lote.hoje].situacaoCa, 'VENCIDO');
  });

  test('IDOR: a empresa B não dá baixa em lote da A; o lote não muda', async () => {
    const antes = await saldoDe(lote.vencida);
    const r = await baixa('masterB', lote.vencida, 1);
    assert.equal(r.status, 404);
    assert.equal(await saldoDe(lote.vencida), antes);
  });

  test('13. baixa manual reduz só o lote escolhido; a lista mostra o saldo novo', async () => {
    const outrosAntes = (await pool.query('SELECT id, saldo FROM estoque_lotes WHERE id <> $1 ORDER BY id', [lote.vencida])).rows;
    const r = await baixa('masterA', lote.vencida, 2);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(await saldoDe(lote.vencida), 3);
    assert.deepEqual((await pool.query('SELECT id, saldo FROM estoque_lotes WHERE id <> $1 ORDER BY id', [lote.vencida])).rows, outrosAntes);
    const l = porId((await validade('masterA', '?situacao=VENCIDO')).body.lotes);
    assert.deepEqual([l[lote.vencida].fisico, l[lote.vencida].bloqueado], [3, 3]);
  });

  test('14. baixa até zerar: o lote sai da lista e dos indicadores de validade', async () => {
    const antes = (await validade('masterA')).body.indicadores;
    assert.equal((await baixa('masterA', lote.vencida, 3)).status, 201);
    const depois = await validade('masterA', '?limite=100');
    assert.equal(depois.body.lotes.some((x) => x.loteId === lote.vencida), false);
    assert.deepEqual([depois.body.indicadores.vencido, depois.body.indicadores.bloqueados, depois.body.indicadores.lotes],
      [antes.vencido - 1, antes.bloqueados - 1, antes.lotes - 1]);
  });
});
