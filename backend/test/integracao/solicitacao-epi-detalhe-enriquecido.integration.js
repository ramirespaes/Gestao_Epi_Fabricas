'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { chaveNova } = require('./helpers/solicitacao-epi-servico');
const { criarSolicitacao: criarSolicitacaoSql } = require('./helpers/solicitacao-epi');
const { inserir, criarMaterial } = require('./helpers/entrega-epi');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const consultaRepo = require('../../src/repositories/solicitacao-epi-consulta.repository');

/**
 * Detalhe da solicitação de EPI enriquecido para a tela (12G-0, L3 e D7),
 * contra PostgreSQL real: o trabalhador (nome, matrícula, setor, função e
 * situação), o material de cada item (nome e unidade) e os nomes de quem
 * solicitou, decidiu e encerrou. Sem CPF e sem e-mail. As regras do detalhe
 * (12F-1) não mudam: quem trabalha a solicitação vê qualquer uma da empresa,
 * com cobertura e posição; quem só pede vê só as próprias, sem os números de
 * estoque; a de outro solicitante, a de outra empresa e a inexistente são o
 * mesmo 404.
 */

const detalhe = (id) => `/api/solicitacoes-epi/${id}`;
const ID_INEXISTENTE = 2147483000;

describe('detalhe enriquecido da solicitação de EPI — HTTP (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};
  const S = {};
  let trabalhador;
  let material;

  const q = (sql, params) => pool.query(sql, params);
  const resposta = (r) => ({ status: r.status, corpo: r.body });
  const renomear = (id, nome) => q('UPDATE usuarios SET nome = $2 WHERE id = $1', [id, nome]);
  const proibidosNoTexto = async () => {
    const { rows: funcionarios } = await q('SELECT cpf FROM funcionarios');
    const { rows: usuarios } = await q('SELECT email FROM usuarios WHERE email IS NOT NULL');
    return [...funcionarios.map((x) => x.cpf), ...usuarios.map((x) => x.email)];
  };

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    const A = d.empresaA;
    u.solicitante = await env.usuarioCom(A, { recursos: { request: ['visualizar', 'criar'] } });
    u.outro = await env.usuarioCom(A, { recursos: { request: ['visualizar'] } });
    u.sst = await env.usuarioCom(A, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO'], sst: true });
    u.semNada = await env.usuarioCom(A);
    u.sstB = await env.usuarioCom(d.empresaB, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO'], sst: true });
    // Nomes sem o e-mail (o helper usa o e-mail no nome), para a prova de que o e-mail nunca sai.
    await renomear(u.solicitante, 'Carla Solicitante');
    await renomear(u.sst, 'Diego Seguranca');
    await renomear(d.sst1, 'Elisa Decisora');

    trabalhador = (await inserir(pool, 'funcionarios', {
      empresa_id: A, nome: 'Fabio Trabalhador', matricula: 'DET-001', cpf: '52998224725', grupo_homogeneo_id: d.gheA, setor: 'Laminação', funcao: 'Operador de ponte', situacao: 'ATIVO',
    })).id;
    material = await criarMaterial(pool, A, 'Protetor facial Detalhe', { exigeTamanho: false, unidade: 'unidade' });

    const criar = (funcionarioId = trabalhador, itens = [{ materialId: material, tamanho: null, quantidade: 2, motivo: 'ADMISSAO' }]) => solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: A, atorId: u.solicitante, funcionarioId, itens, chaveIdempotencia: chaveNova(),
    });
    S.pendente = await criar();
    S.encerrada = await criar(trabalhador, [
      { materialId: material, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }, { materialId: d.botina, tamanho: '40', quantidade: 1, motivo: 'DESGASTE_DANO' },
    ]);
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: A, atorId: d.sst1, solicitacaoId: S.encerrada.solicitacao.id, hoje: f.HOJE,
      decisoes: S.encerrada.itens.map((i) => ({ itemId: i.id, decisao: 'APROVADO', justificativa: 'Fora do GHE, risco de respingo' })),
    });
    await solicitacaoSvc.encerrarSolicitacao(pool, {
      empresaId: A, atorId: u.sst, solicitacaoId: S.encerrada.solicitacao.id, justificativa: 'Trabalhador transferido', hoje: f.HOJE,
    });
    S.deOutro = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: A, atorId: u.outro, funcionarioId: trabalhador, itens: [{ materialId: material, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    S.autoatendimento = (await criarSolicitacaoSql(pool, { empresaA: A, trabalhadorA: trabalhador, solicitante: u.solicitante }, {
      empresaId: A, funcionarioId: trabalhador, origem: 'AUTOATENDIMENTO', itens: [{ material_id: material, tamanho: null }],
    })).solicitacao;
  });

  after(async () => { if (env) await env.encerrar(); });

  test('quem trabalha a solicitação: trabalhador, material de cada item e os nomes de quem solicitou, decidiu e encerrou; sem CPF nem e-mail', async () => {
    const r = await como(u.sst).get(detalhe(S.encerrada.solicitacao.id));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.solicitacao;
    assert.deepEqual(s.funcionario, {
      id: trabalhador, nome: 'Fabio Trabalhador', matricula: 'DET-001', setor: 'Laminação', funcao: 'Operador de ponte', ativo: true,
    });
    assert.deepEqual(s.solicitante, { id: u.solicitante, nome: 'Carla Solicitante' });
    assert.deepEqual(s.decisao.decisor, { id: d.sst1, nome: 'Elisa Decisora' });
    assert.deepEqual(s.encerramento.encerrador, { id: u.sst, nome: 'Diego Seguranca' });
    const porMaterial = new Map(r.body.itens.map((i) => [i.materialId, i.material]));
    assert.deepEqual(porMaterial.get(material), { nome: 'Protetor facial Detalhe', unidade: 'unidade' });
    assert.deepEqual(porMaterial.get(d.botina), { nome: 'Botina de segurança', unidade: 'unidade' });
    const texto = JSON.stringify(r.body);
    assert.equal(/"(cpf|email|e-mail|senha)/i.test(texto), false);
    for (const proibido of await proibidosNoTexto()) assert.equal(texto.includes(proibido), false, 'CPF ou e-mail na resposta');
  });

  test('PENDENTE: solicitante e trabalhador presentes; ainda sem decisão nem encerramento (blocos nulos)', async () => {
    const r = await como(u.sst).get(detalhe(S.pendente.solicitacao.id));
    assert.deepEqual([r.body.solicitacao.solicitante, r.body.solicitacao.decisao, r.body.solicitacao.encerramento], [{ id: u.solicitante, nome: 'Carla Solicitante' }, null, null]);
    assert.equal(r.body.solicitacao.funcionario.nome, 'Fabio Trabalhador');
  });

  test('autoatendimento: sem solicitante interno, o bloco do solicitante é nulo', async () => {
    const r = await como(u.sst).get(detalhe(S.autoatendimento.id));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.solicitacao.solicitante, null);
  });

  test('quem só pede vê a própria com os mesmos nomes e materiais, e continua sem cobertura e posição', async () => {
    const r = await como(u.solicitante).get(detalhe(S.encerrada.solicitacao.id));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.solicitacao.solicitante.nome, r.body.solicitacao.decisao.decisor.nome, r.body.solicitacao.encerramento.encerrador.nome], ['Carla Solicitante', 'Elisa Decisora', 'Diego Seguranca']);
    assert.ok(r.body.itens.every((i) => i.material && !('cobertura' in i) && !('posicao' in i)));
    const texto = JSON.stringify(r.body);
    for (const proibido of await proibidosNoTexto()) assert.equal(texto.includes(proibido), false);
  });

  test('anti-enumeração preservada: a de outro solicitante, a de outra empresa e a inexistente são o mesmo 404; sem autoridade, o 403 genérico', async () => {
    const inexistente = resposta(await como(u.solicitante).get(detalhe(ID_INEXISTENTE)));
    const deOutro = resposta(await como(u.solicitante).get(detalhe(S.deOutro.solicitacao.id)));
    const daOutraEmpresa = resposta(await como(u.sstB).get(detalhe(S.pendente.solicitacao.id)));
    const inexistenteB = resposta(await como(u.sstB).get(detalhe(ID_INEXISTENTE)));
    assert.deepEqual([inexistente.status, inexistente.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
    assert.deepEqual(deOutro, inexistente);
    assert.deepEqual(daOutraEmpresa, inexistenteB);
    assert.equal(JSON.stringify(deOutro).includes('Fabio'), false, 'nada do enriquecimento vaza no 404');
    const semAutoridade = resposta(await como(u.semNada).get(detalhe(S.pendente.solicitacao.id)));
    assert.deepEqual([semAutoridade.status, semAutoridade.corpo.codigo], [403, 'PERMISSAO_NEGADA']);
  });

  test('defesa em profundidade: as leituras de apresentação filtram pela empresa, mesmo com ids de outra (pela solicitação, as FKs compostas já impedem)', async () => {
    const ids = { funcionarioId: trabalhador, materialIds: [material], usuarioIds: [u.solicitante] };
    const daPropria = await consultaRepo.dadosDeApresentacao(pool, d.empresaA, ids);
    assert.deepEqual([daPropria.funcionario?.id, daPropria.materiais.map((x) => x.id), daPropria.usuarios.map((x) => x.id)], [trabalhador, [material], [u.solicitante]]);
    assert.deepEqual(await consultaRepo.dadosDeApresentacao(pool, d.empresaB, ids), { funcionario: null, materiais: [], usuarios: [] });
  });

  test('os dados de apresentação são os do cadastro atual: trabalhador inativado aparece como inativo, material renomeado com o nome novo', async () => {
    const outroTrabalhador = (await inserir(pool, 'funcionarios', {
      empresa_id: d.empresaA, nome: 'Gilda Inativada', matricula: 'DET-002', cpf: '11144477735', setor: null, funcao: null, situacao: 'ATIVO',
    })).id;
    const s = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: u.solicitante, funcionarioId: outroTrabalhador, itens: [{ materialId: material, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    await q("UPDATE funcionarios SET situacao = 'INATIVO' WHERE id = $1", [outroTrabalhador]);
    await q("UPDATE materiais SET nome = 'Protetor facial Renomeado' WHERE id = $1", [material]);
    try {
      const r = await como(u.sst).get(detalhe(s.solicitacao.id));
      assert.deepEqual(r.body.solicitacao.funcionario, {
        id: outroTrabalhador, nome: 'Gilda Inativada', matricula: 'DET-002', setor: null, funcao: null, ativo: false,
      });
      assert.equal(r.body.itens[0].material.nome, 'Protetor facial Renomeado');
    } finally {
      await q("UPDATE materiais SET nome = 'Protetor facial Detalhe' WHERE id = $1", [material]);
    }
  });
});
