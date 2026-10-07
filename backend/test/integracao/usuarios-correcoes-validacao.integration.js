'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarConviteUsuarioRoutes } = require('../../src/routes/convite-usuario.routes');
const { criarConviteUsuarioController } = require('../../src/controllers/convite-usuario.controller');

/** Correções pós-validação manual: Alterar usuário por usuarios.id (≠ identidade_id) e MASTER único por empresa. */
const BASE = '/api/administracao/usuarios';

describe('Gestão de Usuários — correções pós-validação (PostgreSQL real)', () => {
  let g;
  let master;
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial, semLimite }) => [criarConviteUsuarioRoutes({ controller: criarConviteUsuarioController({ pool }), exigirSessao: exigirEmpresarial, limitador: semLimite(), limitadorEnvio: semLimite() })] });
    master = await g.contaDaEmpresa(g.empresas.A);
  });
  after(async () => { if (g) await g.encerrar(); });

  test('Alterar usuário: usuarios.id DIFERENTE de identidade_id; a listagem expõe usuarios.id, o GET /edicao e o PATCH usam o mesmo id e os dados são do usuário selecionado', async () => {
    for (let i = 0; i < 7; i += 1) await g.portal.novaIdentidade();
    const a = await g.usuarioPronto(master, { setor: 'Compras' });
    const b = await g.usuarioPronto(master, { setor: 'Logística' });
    assert.notEqual(a.id, a.identidadeId);
    assert.notEqual(b.id, b.identidadeId);
    const lista = await g.request(g.app).get(`${BASE}?limite=100`).set('Cookie', g.cookie(master));
    const item = lista.body.usuarios.find((x) => x.email === b.email);
    assert.equal(item.id, b.id, 'a listagem usa usuarios.id');
    assert.equal(lista.body.usuarios.some((x) => x.id === b.identidadeId && x.email === b.email), false);
    const r = await g.request(g.app).get(`${BASE}/${item.id}/edicao`).set('Cookie', g.cookie(master));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.usuario.id, r.body.usuario.email, r.body.usuario.setor, r.body.usuario.cpf, r.body.usuario.matricula], [b.id, b.email, 'Logística', b.corpo.cpf, b.corpo.matricula]);
    const errado = await g.request(g.app).get(`${BASE}/${b.identidadeId}/edicao`).set('Cookie', g.cookie(master));
    assert.ok(errado.status === 404 || errado.body.usuario.id !== b.id, 'o identidade_id não é identificador empresarial');
    const p = await g.request(g.app).patch(`${BASE}/${item.id}`).set('Cookie', g.cookie(master)).send({ setor: 'Manutenção' });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.deepEqual([(await g.um('SELECT setor FROM usuarios WHERE id = $1', [b.id])).setor, (await g.um('SELECT setor FROM usuarios WHERE id = $1', [a.id])).setor], ['Manutenção', 'Compras']);
    const rota = await g.request(g.app).get(`${BASE}/${item.id}/inexistente`).set('Cookie', g.cookie(master));
    assert.equal(rota.body.codigo, 'ROTA_NAO_ENCONTRADA', 'rota inexistente tem código próprio, distinto de USUARIO_NAO_ENCONTRADO');
    assert.equal((await g.request(g.app).get(`${BASE}/999999/edicao`).set('Cookie', g.cookie(master))).body.codigo, 'USUARIO_NAO_ENCONTRADO');
  });

  test('MASTER único: a listagem só oferece perfis cadastráveis sem MASTER; POST, PATCH, duplicação e convite não criam nem promovem MASTER; o existente segue ativo e sem grupo; nenhuma empresa ganha segundo MASTER', async () => {
    const lista = await g.request(g.app).get(`${BASE}?limite=100`).set('Cookie', g.cookie(master));
    assert.deepEqual(lista.body.perfisCadastraveis, ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']);
    assert.deepEqual(lista.body.perfisGerenciaveis, ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']);
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    assert.deepEqual((await g.request(g.app).get(`${BASE}?limite=100`).set('Cookie', g.cookie(adm))).body.perfisCadastraveis, ['SUPERVISOR', 'USUARIO']);
    const alvo = await g.usuarioPronto(master);
    const modelo = await g.usuarioPronto(master);
    const respostas = [
      await g.criar(master, g.corpoBase({ tipoConta: 'MASTER' })),
      await g.criar(master, g.corpoBase({ tipoConta: 'MASTER', usuarioModeloId: modelo.id })),
      await g.request(g.app).patch(`${BASE}/${alvo.id}`).set('Cookie', g.cookie(master)).send({ tipoConta: 'MASTER' }),
      await g.request(g.app).post('/api/administracao/convites-usuario').set('Cookie', g.cookie(master)).send({ email: 'novo.master@example.invalid', nome: 'Novo Master', tipoConta: 'MASTER' }),
    ];
    assert.deepEqual(respostas.map((r) => [r.status, r.body.codigo]), Array(4).fill([409, 'MASTER_SOMENTE_PELO_PAINEL_PRIVADO']));
    const doMaster = await g.criar(master, g.corpoBase({ usuarioModeloId: master.usuarioId }));
    assert.equal(doMaster.body.codigo, 'USUARIO_MODELO_MASTER');
    const m = await g.um("SELECT count(*)::int AS n, count(grupo_acesso_id)::int AS grupos, bool_and(ativo) AS ativos FROM usuarios WHERE empresa_id = $1 AND perfil = 'MASTER'", [g.empresas.A]);
    assert.deepEqual([m.n, m.grupos, m.ativos], [1, 0, true], 'um só MASTER, ativo e sem grupo');
    assert.equal((await g.um('SELECT perfil FROM usuarios WHERE id = $1', [alvo.id])).perfil, 'USUARIO');
  });
});
