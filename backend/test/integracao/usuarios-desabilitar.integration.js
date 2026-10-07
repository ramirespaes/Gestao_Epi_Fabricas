'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');

/**
 * ETAPA A — Desabilitar / Reativar usuário (PostgreSQL real). Desabilitar não
 * exclui: retira o acesso (ativo = false, sessões revogadas, login recusado com
 * mensagem própria) e preserva tudo. Reativar volta ao mesmo vínculo.
 */
const BASE = '/api/administracao/usuarios';
const MENSAGEM = 'Usuário desativado. Procure o administrador da empresa.';

describe('Gestão de Usuários — desabilitar e reativar (PostgreSQL real)', () => {
  let g;
  let master;
  let grupoId;
  before(async () => {
    g = await montar();
    master = await g.contaDaEmpresa(g.empresas.A);
    grupoId = (await g.um("INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, 'RH', $2) RETURNING id", [g.empresas.A, master.usuarioId])).id;
  });
  after(async () => { if (g) await g.encerrar(); });

  const acao = (c, id, nome) => g.request(g.app).post(`${BASE}/${id}/${nome}`).set('Cookie', g.cookie(c)).send({});
  const snapshot = async (id) => g.um(
    `SELECT u.nome, u.perfil, u.matricula, u.setor, u.horario_trabalho_inicio::text AS ini, u.grupo_acesso_id, i.cpf, i.email, i.senha_hash,
            (SELECT count(*)::int FROM usuario_ips_permitidos p WHERE p.usuario_id = u.id) AS ips
       FROM usuarios u JOIN identidades i ON i.id = u.identidade_id WHERE u.id = $1`, [id]);

  test('desabilita sem excluir: ativo=false, tudo preservado, sessão aberta cai, login recusado com mensagem própria, senha errada continua genérica', async () => {
    const u = await g.usuarioPronto(master, { horarioTrabalho: { inicio: '08:00', fim: '17:00' }, ipsPermitidos: ['127.0.0.1'], grupoAcessoId: grupoId });
    const entrada = await g.login(u.email, g.SENHA_PROVISORIA).set('X-Forwarded-For', '127.0.0.1');
    assert.equal(entrada.status, 200, JSON.stringify(entrada.body));
    const jar = g.cookiesDe(entrada);
    assert.equal((await g.request(g.app).get('/api/auth/me').set('Cookie', g.deCookies(jar)).set('X-Forwarded-For', '127.0.0.1')).status, 200);
    const antes = await snapshot(u.id);

    const r = await acao(master, u.id, 'inativar');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usuario.ativo, false);
    assert.deepEqual(await snapshot(u.id), antes, 'identidade, CPF, matrícula, setor, horário, IP, grupo e senha intactos');
    assert.equal((await g.um('SELECT ativo FROM usuarios WHERE id = $1', [u.id])).ativo, false);
    assert.equal((await g.request(g.app).get('/api/auth/me').set('Cookie', g.deCookies(jar)).set('X-Forwarded-For', '127.0.0.1')).status, 401, 'sessão aberta não opera mais');

    const vivas = async () => (await g.um('SELECT count(*)::int AS n FROM sessoes_globais WHERE identidade_id = $1 AND revogada_em IS NULL', [u.identidadeId])).n;
    const vivasAntes = await vivas();
    const negado = await g.login(u.email, g.SENHA_PROVISORIA).set('X-Forwarded-For', '127.0.0.1');
    assert.deepEqual([negado.status, negado.body.codigo, negado.body.message], [401, 'USUARIO_DESATIVADO', MENSAGEM]);
    assert.equal('set-cookie' in negado.headers, false);
    assert.equal(await vivas(), vivasAntes, 'login compensado: nenhuma sessão global nova');
    const errada = await g.login(u.email, 'senha-errada-qualquer-77');
    assert.deepEqual([errada.status, errada.body.codigo], [401, 'CREDENCIAIS_INVALIDAS'], 'sem a senha certa nada é revelado');
  });

  test('lista com situação Desabilitado e reativa o MESMO vínculo: nada recriado, grupo/CPF/senha intactos, volta a autenticar', async () => {
    const u = await g.usuarioPronto(master, { grupoAcessoId: grupoId });
    await acao(master, u.id, 'inativar');
    const lista = await g.request(g.app).get(`${BASE}?limite=100&situacao=INATIVO`).set('Cookie', g.cookie(master));
    assert.ok(lista.body.usuarios.some((x) => x.id === u.id && x.ativo === false));
    const antes = await snapshot(u.id);
    const total = (await g.um('SELECT count(*)::int AS n FROM usuarios')).n;
    const r = await acao(master, u.id, 'reativar');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usuario.ativo, true);
    assert.deepEqual(await snapshot(u.id), antes);
    assert.equal((await g.um('SELECT count(*)::int AS n FROM usuarios')).n, total);
    assert.equal((await g.login(u.email, g.SENHA_PROVISORIA)).status, 200);
    assert.equal((await acao(master, u.id, 'reativar')).status, 409, 'já ativo');
  });

  test('autoridade e multitenancy: sem autorização 403; outra empresa 404; último MASTER protegido; auditoria sem segredo', async () => {
    const alvo = await g.usuarioPronto(master);
    const comum = await g.contaDaEmpresa(g.empresas.A, 'SUPERVISOR');
    assert.equal((await acao(comum, alvo.id, 'inativar')).status, 403);
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    assert.equal((await acao(masterB, alvo.id, 'inativar')).status, 404);
    assert.equal((await g.um('SELECT ativo FROM usuarios WHERE id = $1', [alvo.id])).ativo, true);
    const unico = await g.contaDaEmpresa(g.empresas.B);
    await g.pool.query("UPDATE usuarios SET ativo = false WHERE empresa_id = $1 AND perfil = 'MASTER' AND id <> $2", [g.empresas.B, unico.usuarioId]);
    const proprio = await acao(unico, unico.usuarioId, 'inativar');
    assert.deepEqual([proprio.status, proprio.body.codigo], [409, 'USUARIO_ULTIMO_MASTER']);

    await acao(master, alvo.id, 'inativar');
    await acao(master, alvo.id, 'reativar');
    const logs = await g.todos("SELECT acao, usuario_id, referencia, empresa_id, criado_em, dados_novos FROM logs_auditoria WHERE referencia = $1 AND acao IN ('USUARIO_INATIVADO','USUARIO_REATIVADO') ORDER BY id", [String(alvo.id)]);
    assert.deepEqual(logs.map((l) => l.acao), ['USUARIO_INATIVADO', 'USUARIO_REATIVADO']);
    assert.ok(logs.every((l) => l.usuario_id === master.usuarioId && l.empresa_id === g.empresas.A && l.criado_em));
    assert.equal(/senha|hash|token|argon/i.test(JSON.stringify(logs)), false);
  });
});
