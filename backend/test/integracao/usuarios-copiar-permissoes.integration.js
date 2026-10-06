'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const copiaAcesso = require('../../src/services/copia-acesso.service');
const autorizacao = require('../../src/middleware/autorizacao');

/** ETAPA G — Copiar permissões: a configuração de acesso de um usuário vira a de OUTRO usuário já existente. */
describe('Gestão de Usuários — Copiar permissões (PostgreSQL real)', () => {
  let g;
  let master;
  let grupoA;
  let grupoB;
  let grupoInativo;
  let acoes;
  before(async () => {
    g = await montar();
    master = await g.contaDaEmpresa(g.empresas.A);
    const novo = async (nome, ativo) => (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, $2, $3, $4) RETURNING id', [g.empresas.A, nome, ativo, master.usuarioId])).id;
    grupoA = await novo('Almoxarifado', true);
    grupoB = await novo('Compras', true);
    grupoInativo = await novo('Antigo', false);
    acoes = (await g.todos("SELECT codigo FROM acoes WHERE ativo AND NOT exige_sst AND modo_autorizacao_individual IN ('ALTERNATIVA','OBRIGATORIA') ORDER BY codigo LIMIT 2")).map((a) => a.codigo);
  });
  after(async () => { if (g) await g.encerrar(); });

  const copiar = (c, destinoId, origemId) => g.request(g.app).post(`/api/administracao/usuarios/${destinoId}/permissoes/copiar`).set('Cookie', g.cookie(c)).send({ origemId });
  const estado = async (id) => ({
    grupo: (await g.um('SELECT grupo_acesso_id FROM usuarios WHERE id = $1', [id])).grupo_acesso_id,
    recursos: (await g.todos('SELECT recurso, pode_visualizar, pode_criar FROM usuario_permissoes_recurso WHERE usuario_id = $1 ORDER BY 1', [id])),
    bloqueios: (await g.todos('SELECT acao_codigo FROM usuario_bloqueios WHERE usuario_id = $1 ORDER BY 1', [id])).map((l) => l.acao_codigo),
    autorizacoes: (await g.todos('SELECT acao_codigo FROM usuario_autorizacoes WHERE usuario_id = $1 AND origem_id IS NULL ORDER BY 1', [id])).map((l) => l.acao_codigo),
  });
  const pessoais = (id) => g.um('SELECT u.nome, u.perfil, u.matricula, u.setor, i.email, i.cpf, i.senha_hash FROM usuarios u JOIN identidades i ON i.id = u.identidade_id WHERE u.id = $1', [id]);
  async function origemComConfig() {
    const o = await g.usuarioPronto(master, { tipoConta: 'SUPERVISOR', grupoAcessoId: grupoA });
    await g.pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, concedido_por) VALUES ($1, $2, 'dashboard', true, false, $3)", [g.empresas.A, o.id, master.usuarioId]);
    await g.pool.query('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, $2, $3)', [o.id, acoes[1], master.usuarioId]);
    await g.pool.query('INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)', [g.empresas.A, o.id, acoes[0], master.usuarioId]);
    return o;
  }

  test('MASTER copia: grupo e camadas individuais do destino passam a ser os da origem (substituídos, não somados); perfil e dados pessoais do destino intocados; origem intocada; efetivo igual; auditoria', async () => {
    const origem = await origemComConfig();
    const destino = await g.usuarioPronto(master, { tipoConta: 'USUARIO', grupoAcessoId: grupoB });
    await g.pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_editar, concedido_por) VALUES ($1, $2, 'materials', true, $3)", [g.empresas.A, destino.id, master.usuarioId]);
    await g.pool.query('INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)', [g.empresas.A, destino.id, acoes[1], master.usuarioId]);
    const origemAntes = await estado(origem.id);
    const pessoaisAntes = await pessoais(destino.id);

    const r = await copiar(master, destino.id, origem.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.copia, { origemId: origem.id, destinoId: destino.id, grupo: { copiado: true, motivo: null }, individual: { executado: true, motivo: null, recursos: 1, bloqueios: 1, autorizacoes: 1, ignoradas: 0 } });
    assert.deepEqual(await estado(destino.id), origemAntes, 'destino = origem (a exceção e a concessão anteriores do destino saíram)');
    assert.deepEqual(await estado(origem.id), origemAntes);
    const pessoaisDepois = await pessoais(destino.id);
    assert.deepEqual(pessoaisDepois, pessoaisAntes, 'perfil, nome, matrícula, setor, e-mail, CPF e senha do destino não mudam');
    assert.equal(pessoaisDepois.perfil, 'USUARIO', 'o perfil do destino NÃO vira o da origem');
    for (const rec of ['dashboard', 'materials']) {
      assert.deepEqual(await autorizacao.avaliarPermissaoRecurso(g.pool, { empresaId: g.empresas.A, usuarioId: destino.id, perfil: 'USUARIO' }, rec),
        await autorizacao.avaliarPermissaoRecurso(g.pool, { empresaId: g.empresas.A, usuarioId: origem.id, perfil: 'USUARIO' }, rec), rec);
    }
    const aud = await g.um("SELECT usuario_id, empresa_id, dados_novos FROM logs_auditoria WHERE acao = 'USUARIO_PERMISSOES_COPIADAS' AND referencia = $1", [String(destino.id)]);
    assert.deepEqual([aud.usuario_id, aud.empresa_id, aud.dados_novos.origemId, aud.dados_novos.recursos, aud.dados_novos.bloqueios, aud.dados_novos.autorizacoes], [master.usuarioId, g.empresas.A, origem.id, 1, 1, 1]);
    assert.equal(/cpf|senha|hash|@/i.test(JSON.stringify(aud)), false);
  });

  test('ator que não é MASTER copia só o GRUPO (sem escalada); ADMINISTRADOR não copia para ADMINISTRADOR/MASTER; sem autoridade 403', async () => {
    const origem = await origemComConfig();
    const destino = await g.usuarioPronto(master, { tipoConta: 'USUARIO' });
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const r = await copiar(adm, destino.id, origem.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.copia.grupo.copiado, r.body.copia.individual.executado, r.body.copia.individual.motivo], [true, false, 'SOMENTE_MASTER']);
    assert.deepEqual(await estado(destino.id), { grupo: grupoA, recursos: [], bloqueios: [], autorizacoes: [] });
    const outroAdm = await g.administradorAutorizado(g.empresas.A, master);
    assert.equal((await copiar(adm, outroAdm.usuarioId, origem.id)).body.codigo, 'USUARIO_PERFIL_NAO_PERMITIDO');
    assert.equal((await copiar(adm, master.usuarioId, origem.id)).body.codigo, 'USUARIO_PERFIL_NAO_PERMITIDO');
    assert.equal((await copiar(await g.contaDaEmpresa(g.empresas.A, 'SUPERVISOR'), destino.id, origem.id)).status, 403);
  });

  test('validações: mesma pessoa 400, outra empresa 404 (origem e destino), destino ou origem MASTER 409, grupo inativo da origem não é copiado (e é informado)', async () => {
    const origem = await origemComConfig();
    const destino = await g.usuarioPronto(master);
    assert.equal((await copiar(master, destino.id, destino.id)).status, 400);
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    const deB = await g.usuarioPronto(masterB);
    assert.equal((await copiar(master, destino.id, deB.id)).status, 404, 'origem de outra empresa');
    assert.equal((await copiar(master, deB.id, origem.id)).status, 404, 'destino de outra empresa');
    assert.equal((await copiar(master, destino.id, 999999)).body.codigo, 'USUARIO_ORIGEM_NAO_ENCONTRADO');
    assert.equal((await copiar(master, master.usuarioId, origem.id)).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
    assert.equal((await copiar(master, destino.id, master.usuarioId)).body.codigo, 'USUARIO_MASTER_PERMISSOES_FIXAS');
    const inativa = await g.usuarioPronto(master, { tipoConta: 'USUARIO', grupoAcessoId: grupoA });
    await g.pool.query('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = $1', [inativa.id, grupoInativo]);
    const r = await copiar(master, destino.id, inativa.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.copia.grupo, { copiado: false, motivo: 'GRUPO_INATIVO' });
    assert.equal((await estado(destino.id)).grupo, null, 'grupo inativo nunca é vinculado');
  });

  test('atomicidade: se a cópia individual falhar, o grupo também não muda e nada fica pela metade', async (t) => {
    const origem = await origemComConfig();
    const destino = await g.usuarioPronto(master, { tipoConta: 'USUARIO', grupoAcessoId: grupoB });
    const antes = await estado(destino.id);
    t.mock.method(copiaAcesso, 'copiarAcessoIndividual', async () => { throw new Error('falha simulada'); });
    const r = await copiar(master, destino.id, origem.id);
    assert.equal(r.status, 500);
    assert.deepEqual(await estado(destino.id), antes);
    assert.equal((await g.todos("SELECT 1 FROM logs_auditoria WHERE acao = 'USUARIO_PERMISSOES_COPIADAS' AND referencia = $1", [String(destino.id)])).length, 0);
  });
});
