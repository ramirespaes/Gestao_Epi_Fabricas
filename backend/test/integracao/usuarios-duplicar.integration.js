'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const copiaAcesso = require('../../src/services/copia-acesso.service');

/** ETAPA D — Duplicar usuário: nova pessoa criada com outro usuário como MODELO DE ACESSO, tudo numa transação. */
describe('Gestão de Usuários — Duplicar usuário (PostgreSQL real)', () => {
  let g;
  let master;
  let grupo;
  let modelo;
  let acoes;
  before(async () => {
    g = await montar();
    master = await g.contaDaEmpresa(g.empresas.A);
    grupo = (await g.um("INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, 'Almoxarifado', $2) RETURNING id", [g.empresas.A, master.usuarioId])).id;
    acoes = (await g.todos("SELECT codigo FROM acoes WHERE ativo AND modo_autorizacao_individual IN ('ALTERNATIVA','OBRIGATORIA') ORDER BY codigo LIMIT 2")).map((a) => a.codigo);
    assert.equal(acoes.length, 2);
    modelo = await g.usuarioPronto(master, { tipoConta: 'SUPERVISOR', grupoAcessoId: grupo, ipsPermitidos: ['203.0.113.10'], horarioTrabalho: { inicio: '08:00', fim: '17:00' } });
    await g.pool.query("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, concedido_por) VALUES ($1, $2, 'materials', true, false, $3)", [g.empresas.A, modelo.id, master.usuarioId]);
    await g.pool.query('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, $2, $3)', [modelo.id, acoes[1], master.usuarioId]);
    await g.pool.query('INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)', [g.empresas.A, modelo.id, acoes[0], master.usuarioId]);
  });
  after(async () => { if (g) await g.encerrar(); });

  const camadas = async (id) => ({
    recursos: await g.todos('SELECT recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir FROM usuario_permissoes_recurso WHERE usuario_id = $1 ORDER BY recurso', [id]),
    bloqueios: (await g.todos('SELECT acao_codigo FROM usuario_bloqueios WHERE usuario_id = $1 ORDER BY 1', [id])).map((l) => l.acao_codigo),
    autorizacoes: (await g.todos('SELECT acao_codigo, origem_id FROM usuario_autorizacoes WHERE usuario_id = $1 ORDER BY 1', [id])).map((l) => [l.acao_codigo, l.origem_id]),
  });
  const contagens = async () => [(await g.um('SELECT count(*)::int AS n FROM identidades')).n, (await g.um('SELECT count(*)::int AS n FROM usuarios')).n];

  test('MASTER duplica: nova identidade e usuário com dados pessoais próprios e senha provisória; perfil, grupo e camadas individuais do modelo; modelo intocado; auditoria', async () => {
    const antesModelo = await camadas(modelo.id);
    const corpo = g.corpoBase({ tipoConta: 'SUPERVISOR', grupoAcessoId: grupo, usuarioModeloId: modelo.id });
    const r = await g.criar(master, corpo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.copiaDeAcesso, { individual: true, motivo: null, recursos: 1, bloqueios: 1, autorizacoes: 1, ignoradas: 0 });
    const novo = r.body.usuario.id;
    assert.deepEqual(await camadas(novo), { ...antesModelo, autorizacoes: antesModelo.autorizacoes });
    assert.deepEqual(await camadas(modelo.id), antesModelo, 'o modelo não foi alterado');
    const u = await g.um(`SELECT u.perfil, u.grupo_acesso_id, u.matricula, u.setor, u.horario_trabalho_inicio, i.id AS ident, i.cpf, i.email, i.senha_provisoria FROM usuarios u JOIN identidades i ON i.id = u.identidade_id WHERE u.id = $1`, [novo]);
    assert.deepEqual([u.perfil, u.grupo_acesso_id, u.matricula, u.cpf, u.email, u.senha_provisoria, u.horario_trabalho_inicio], ['SUPERVISOR', grupo, corpo.matricula, corpo.cpf, corpo.email, true, null], 'dados pessoais são os do formulário, não os do modelo');
    assert.equal((await g.todos('SELECT 1 FROM usuario_ips_permitidos WHERE usuario_id = $1', [novo])).length, 0, 'IP não é copiado');
    const aud = await g.um("SELECT dados_novos FROM logs_auditoria WHERE acao = 'USUARIO_CRIADO' AND referencia = $1", [String(novo)]);
    assert.deepEqual([aud.dados_novos.usuarioModeloId, aud.dados_novos.copiaRecursos, aud.dados_novos.copiaBloqueios, aud.dados_novos.copiaAutorizacoes], [modelo.id, 1, 1, 1]);
    assert.equal(JSON.stringify(aud).includes(corpo.cpf) || /senha/i.test(JSON.stringify(aud)), false);
    assert.ok((await g.login(corpo.email, g.SENHA_PROVISORIA)).status === 200);
  });

  test('ator que não é MASTER cria o usuário mas as camadas individuais NÃO são copiadas (sem escalada); destino MASTER também não recebe', async () => {
    const adm = await g.administradorAutorizado(g.empresas.A, master);
    const r = await g.criar(adm, g.corpoBase({ tipoConta: 'USUARIO', usuarioModeloId: modelo.id }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.copiaDeAcesso.individual, r.body.copiaDeAcesso.motivo], [false, 'SOMENTE_MASTER']);
    assert.deepEqual(await camadas(r.body.usuario.id), { recursos: [], bloqueios: [], autorizacoes: [] });
    // Duplicar nunca produz MASTER, venha o perfil do corpo ou do modelo; e o MASTER não é modelo de acesso.
    const antes = await contagens();
    const m = await g.criar(master, g.corpoBase({ tipoConta: 'MASTER', usuarioModeloId: modelo.id }));
    assert.deepEqual([m.status, m.body.codigo], [409, 'MASTER_SOMENTE_PELO_PAINEL_PRIVADO']);
    const doMaster = await g.criar(master, g.corpoBase({ tipoConta: 'USUARIO', usuarioModeloId: master.usuarioId }));
    assert.deepEqual([doMaster.status, doMaster.body.codigo], [409, 'USUARIO_MODELO_MASTER']);
    assert.deepEqual(await contagens(), antes, 'nada criado');
  });

  test('modelo de outra empresa ou inexistente: 404 idêntico e nada é criado; falha na cópia desfaz identidade e usuário (atomicidade)', async (t) => {
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    const deB = await g.usuarioPronto(masterB);
    const antes = await contagens();
    const a = await g.criar(master, g.corpoBase({ usuarioModeloId: deB.id }));
    const b = await g.criar(master, g.corpoBase({ usuarioModeloId: 999999 }));
    assert.deepEqual([a.status, b.status, a.body.codigo, a.body], [404, 404, 'USUARIO_MODELO_NAO_ENCONTRADO', b.body]);
    assert.deepEqual(await contagens(), antes);
    t.mock.method(copiaAcesso, 'copiarAcessoIndividual', async () => { throw new Error('falha simulada na cópia'); });
    const falha = await g.criar(master, g.corpoBase({ usuarioModeloId: modelo.id }));
    assert.equal(falha.status, 500);
    assert.deepEqual(await contagens(), antes, 'nenhum cadastro pela metade');
  });
});
