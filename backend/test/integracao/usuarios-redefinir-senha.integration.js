'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const password = require('../../src/security/password');
const senhaProvisoriaUtil = require('../../src/utils/senha-provisoria');

/** ETAPA E — Alterar senha: contingência administrativa que define uma NOVA SENHA PROVISÓRIA (ciclo da migration 074). */
const NOVA = 'girassol-quartzo-bussola-58';
const DEFINITIVA = 'lanterna-oceano-madrigal-93';

describe('Gestão de Usuários — Alterar senha (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => { g = await montar(); master = await g.contaDaEmpresa(g.empresas.A); });
  after(async () => { if (g) await g.encerrar(); });
  const rota = (id) => `/api/administracao/usuarios/${id}/senha-provisoria`;
  const redefinir = (c, id, corpo) => g.request(g.app).post(rota(id)).set('Cookie', g.cookie(c)).send(corpo);
  const identidade = (id) => g.um('SELECT i.senha_hash, i.senha_provisoria, i.senha_provisoria_definida_em, i.senha_provisoria_expira_em, i.cpf FROM usuarios u JOIN identidades i ON i.id = u.identidade_id WHERE u.id = $1', [id]);

  test('redefine: nova provisória (Argon2id, 48h/72h), sessões revogadas, senha anterior morre, nova autentica com troca obrigatória, depois a definitiva funciona; dados preservados; auditoria sem segredo', async () => {
    const u = await g.usuarioPronto(master);
    const sessao = g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
    assert.equal((await g.request(g.app).get('/api/auth/me').set('Cookie', sessao)).status, 200);
    const antes = await identidade(u.id);
    const r = await redefinir(master, u.id, { senhaProvisoria: NOVA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.senhaProvisoriaExpiraEm, /^\d{4}-/);
    assert.equal(JSON.stringify(r.body).includes(NOVA), false);

    const depois = await identidade(u.id);
    assert.equal(depois.senha_provisoria, true);
    assert.equal(await password.verificarSenha(depois.senha_hash, NOVA), true);
    assert.equal(depois.cpf, antes.cpf);
    const horas = senhaProvisoriaUtil.horasDeValidade(depois.senha_provisoria_definida_em);
    assert.equal(depois.senha_provisoria_expira_em.getTime() - depois.senha_provisoria_definida_em.getTime(), horas * 3_600_000);
    assert.equal((await g.request(g.app).get('/api/auth/me').set('Cookie', sessao)).status, 401, 'sessão anterior revogada');
    assert.equal((await g.login(u.email, g.SENHA_PROVISORIA)).status, 401, 'senha anterior morreu');
    const entrada = await g.login(u.email, NOVA);
    assert.deepEqual([entrada.status, entrada.body.identidade.trocaSenhaObrigatoria], [200, true]);
    const jar = g.deCookies(g.cookiesDe(entrada));
    assert.equal((await g.request(g.app).get('/api/auth/me').set('Cookie', jar)).body.codigo, 'TROCA_SENHA_OBRIGATORIA');
    const troca = await g.request(g.app).post('/api/auth/global/senha').set('Cookie', jar).send({ senhaAtual: NOVA, novaSenha: DEFINITIVA });
    assert.equal(troca.status, 200, JSON.stringify(troca.body));
    assert.equal((await g.login(u.email, DEFINITIVA)).body.identidade.trocaSenhaObrigatoria, false);

    const aud = await g.todos("SELECT usuario_id, empresa_id, acao, referencia, dados_novos, criado_em FROM logs_auditoria WHERE acao = 'REDEFINICAO_ADMINISTRATIVA_SENHA' AND referencia = $1", [String(u.id)]);
    assert.equal(aud.length, 1);
    assert.deepEqual([aud[0].usuario_id, aud[0].empresa_id], [master.usuarioId, g.empresas.A]);
    assert.equal(new RegExp(`${NOVA}|argon2|hash`, 'i').test(JSON.stringify(aud)), false);
  });

  test('política de senha real (400 por campo), perfis (ADMIN não redefine ADMIN/MASTER), sem autoridade 403, outra empresa 404, a própria conta recusada, identidade de várias empresas recusada; nada muda nesses casos', async () => {
    const u = await g.usuarioPronto(master);
    const hash = (await identidade(u.id)).senha_hash;
    const curta = await redefinir(master, u.id, { senhaProvisoria: 'curta' });
    assert.ok(curta.status === 400 && curta.body.detalhes.some((d) => d.campo === 'body.senhaProvisoria'), JSON.stringify(curta.body));
    assert.equal((await redefinir(master, u.id, { senhaProvisoria: NOVA, confirmacao: NOVA })).status, 400, 'a confirmação é da tela');
    assert.equal((await redefinir(master, u.id, {})).status, 400);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const comum = await g.contaDaEmpresa(g.empresas.A, 'SUPERVISOR');
    assert.equal((await redefinir(comum, u.id, { senhaProvisoria: NOVA })).status, 403);
    assert.equal((await redefinir(adm, master.usuarioId, { senhaProvisoria: NOVA })).body.codigo, 'USUARIO_PERFIL_NAO_PERMITIDO');
    assert.equal((await redefinir(adm, u.id, { senhaProvisoria: NOVA })).status, 200, 'ADMINISTRADOR autorizado redefine USUARIO');
    await g.pool.query('UPDATE identidades SET senha_hash = $2, senha_provisoria = false, senha_provisoria_definida_em = NULL, senha_provisoria_expira_em = NULL WHERE id = $1', [u.identidadeId, hash]);
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    assert.equal((await redefinir(masterB, u.id, { senhaProvisoria: NOVA })).status, 404);
    const propria = await redefinir(master, master.usuarioId, { senhaProvisoria: NOVA });
    assert.deepEqual([propria.status, propria.body.codigo], [409, 'USUARIO_SENHA_PROPRIA']);
    const dois = await g.usuarioPronto(master);
    await g.pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Em B', NULL, NULL, 'USUARIO', $2)", [g.empresas.B, dois.identidadeId]);
    const comp = await redefinir(master, dois.id, { senhaProvisoria: NOVA });
    assert.deepEqual([comp.status, comp.body.codigo], [409, 'SENHA_IDENTIDADE_COMPARTILHADA']);
    assert.equal((await identidade(dois.id)).senha_provisoria, false);
    assert.equal((await identidade(u.id)).senha_hash, hash);
  });
});
