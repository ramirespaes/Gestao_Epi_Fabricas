'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { RAIZ, abrirAmbienteCentral } = require('./helpers/token-central');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * K7 — Consulta real da prévia do Totem (RED): POST /atendimento-token/previa/identificar. PostgreSQL real, schema temporário com todas as
 * migrations, nunca o banco real. Os CPFs e matrículas são os que o próprio helper gera (fictícios).
 *
 * Provas: autorização pelas DUAS permissões; empresa só da sessão; 404 uniforme; GHE e catálogo iguais aos reais; a ÚNICA escrita é UMA linha
 * de auditoria por consulta, sem identificador; nenhuma outra tabela muda; limite de 20 por minuto por empresa + usuário.
 */

const URL = `${RAIZ}/previa/identificar`;
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const ACAO = 'TOKEN_PREVIA_CATALOGO_REAL';

describe('K7 — previa/identificar (PostgreSQL real)', () => {
  let a;
  let app;

  before(async () => {
    a = await abrirAmbienteCentral();
    app = a.criarApp();
    await provisionamento.provisionar(a.ctx.pool, { empresaId: a.d.empresaA, dryRun: false });
    await provisionamento.provisionar(a.ctx.pool, { empresaId: a.d.empresaB, dryRun: false });
  });
  after(async () => { if (a) await a.encerrar(); });

  const A = () => a.d.empresaA;
  const B = () => a.d.empresaB;
  const como = (usuarioId) => a.admin(app, usuarioId);

  /** Usuário comum com as permissões pedidas: a ação da prévia e/ou employeeHistory.visualizar (concessões individuais). */
  async function usuarioCom(empresaId, { previa = true, historico = true } = {}) {
    const id = await a.usuario(empresaId, { acoes: previa ? [ACAO] : [] });
    if (historico) {
      await a.q(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, 'employeeHistory', true, false, false, false, $3)`,
        [empresaId, id, a.masterDe(empresaId)],
      );
    }
    return id;
  }

  async function cenario(empresaId = A()) {
    const ghe = await a.ghe(empresaId);
    const botina = await a.material(empresaId, { nome: 'K7 Botina', exigeTamanho: true, grade: ['38', '40'] });
    const protetor = await a.material(empresaId, { nome: 'K7 Protetor', exigeTamanho: false });
    await a.vincularMaterial(empresaId, ghe, botina);
    await a.vincularMaterial(empresaId, ghe, protetor);
    const f = await a.funcionarioNoGhe(empresaId, ghe);
    return { ghe, botina, protetor, f };
  }

  async function contagensDeTodasAsTabelas() {
    const tabelas = (await a.q("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map((r) => r.table_name);
    const mapa = {};
    for (const t of tabelas) mapa[t] = (await a.q(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0].n;
    return mapa;
  }
  const diferencas = (antes, depois) => Object.keys(depois).filter((t) => antes[t] !== depois[t]).map((t) => `${t}: ${antes[t]} → ${depois[t]}`);

  test('K7-I1 — sem sessão administrativa é 401; sem a ação, ou sem employeeHistory.visualizar, ou sem ambas, é 403; com as duas é 200', async () => {
    const c = await cenario();
    const corpo = { tipo: 'MATRICULA', valor: c.f.matricula };
    const sem = await request(app).post(URL).set('Origin', 'http://localhost:5500').send(corpo);
    assert.equal(sem.status, 401, aviso(sem));
    for (const [rotulo, opcoes] of [['nenhuma', { previa: false, historico: false }], ['só a prévia', { previa: true, historico: false }], ['só employeeHistory', { previa: false, historico: true }]]) {
      const u = await usuarioCom(A(), opcoes);
      const r = await como(u).post(URL, corpo);
      assert.equal(r.status, 403, `${rotulo}: ${aviso(r)}`);
      assert.equal(r.body.codigo, 'PERMISSAO_NEGADA', rotulo);
      assert.equal(JSON.stringify(r.body).includes(c.f.matricula), false, 'a negação não ecoa o identificador');
    }
    const ok = await como(await usuarioCom(A())).post(URL, corpo);
    assert.equal(ok.status, 200, aviso(ok));
  });

  test('K7-I2 — por matrícula e por CPF: só primeiro nome, GHE e catálogo; o catálogo é IGUAL ao da prévia real e ao que o tablet mostraria', async () => {
    const c = await cenario();
    const u = await usuarioCom(A());
    const real = await como(u).get(`${RAIZ}/previa/catalogo?funcionarioId=${c.f.id}`);
    assert.equal(real.status, 200, aviso(real));
    const ghe = (await a.q('SELECT codigo, nome, ativo FROM grupos_homogeneos_exposicao WHERE id = $1', [c.ghe])).rows[0];
    for (const corpo of [{ tipo: 'MATRICULA', valor: c.f.matricula }, { tipo: 'CPF', valor: c.f.cpf }]) {
      const r = await como(u).post(URL, corpo);
      assert.equal(r.status, 200, aviso(r));
      assert.equal(r.body.status, 'ok');
      assert.deepEqual(Object.keys(r.body.previa).sort(), ['catalogo', 'funcionario', 'ghe']);
      assert.deepEqual(r.body.previa.funcionario, { primeiroNome: c.f.nome.trim().split(/\s+/)[0] });
      assert.deepEqual(r.body.previa.ghe, { codigo: ghe.codigo, descricao: ghe.nome, ativo: ghe.ativo });
      assert.deepEqual(r.body.previa.catalogo, real.body.previa.catalogo, 'exatamente as regras reais, sem fixture');
      assert.deepEqual(r.body.previa.catalogo.materiais.map((m) => m.id).sort((x, y) => x - y), [c.botina, c.protetor].sort((x, y) => x - y));
      const texto = JSON.stringify(r.body);
      for (const proibido of [c.f.cpf, c.f.matricula, c.f.nome, c.f.nome.split(/\s+/).slice(1).join(' ')]) assert.equal(texto.includes(proibido), false, `a resposta não traz ${proibido}`);
      assert.equal(r.headers['cache-control'], 'no-store');
    }
  });

  test('K7-I3 — GHE antigo sem código vem com codigo null; sem GHE o GHE é null; GHE inativo e sem materiais seguem as regras reais', async () => {
    const c = await cenario();
    const u = await usuarioCom(A());
    await a.q('UPDATE grupos_homogeneos_exposicao SET codigo = NULL WHERE id = $1', [c.ghe]);
    const antigo = await como(u).post(URL, { tipo: 'MATRICULA', valor: c.f.matricula });
    assert.equal(antigo.body.previa.ghe.codigo, null);
    await a.q('UPDATE grupos_homogeneos_exposicao SET ativo = false WHERE id = $1', [c.ghe]);
    const inativo = await como(u).post(URL, { tipo: 'MATRICULA', valor: c.f.matricula });
    assert.equal(inativo.body.previa.ghe.ativo, false);
    assert.equal(inativo.body.previa.catalogo.estado, 'GHE_INATIVO');
    const semGhe = await a.funcionarioNoGhe(A(), null);
    const r = await como(u).post(URL, { tipo: 'MATRICULA', valor: semGhe.matricula });
    assert.equal(r.status, 200, aviso(r));
    assert.equal(r.body.previa.ghe, null);
    assert.equal(r.body.previa.catalogo.estado, 'SEM_GHE');
  });

  test('K7-I4 — 404 uniforme: inexistente, inativo, afastado e de outra empresa são indistinguíveis, e a mensagem não ecoa o identificador', async () => {
    const c = await cenario();
    const u = await usuarioCom(A());
    const deB = await cenario(B());
    const casos = [];
    casos.push({ tipo: 'MATRICULA', valor: 'MX-NAO-EXISTE-1' });
    casos.push({ tipo: 'CPF', valor: '11122233344' });
    casos.push({ tipo: 'CPF', valor: deB.f.cpf });
    casos.push({ tipo: 'MATRICULA', valor: deB.f.matricula });
    for (const situacao of ['INATIVO', 'AFASTADO']) {
      const f = await a.funcionarioNoGhe(A(), c.ghe, { situacao });
      casos.push({ tipo: 'MATRICULA', valor: f.matricula });
      casos.push({ tipo: 'CPF', valor: f.cpf });
    }
    const corpos = [];
    for (const corpo of casos) {
      const r = await como(u).post(URL, corpo);
      assert.equal(r.status, 404, `${corpo.tipo}: ${aviso(r)}`);
      assert.equal(r.body.codigo, 'FUNCIONARIO_NAO_IDENTIFICADO');
      assert.equal(JSON.stringify(r.body).includes(corpo.valor), false, 'sem eco do identificador');
      assert.equal(r.headers['cache-control'], 'no-store');
      corpos.push(JSON.stringify(r.body));
    }
    assert.equal(new Set(corpos).size, 1, 'todos os 404 têm exatamente o mesmo corpo');
  });

  test('K7-I5 — empresa só da sessão: o corpo estrito recusa empresa, funcionário, GHE e ator; a recusa não ecoa o valor', async () => {
    const c = await cenario();
    const u = await usuarioCom(A());
    for (const extra of [{ empresaId: B() }, { funcionarioId: c.f.id }, { gheId: c.ghe }, { usuarioId: 1 }, { cpf: c.f.cpf }]) {
      const r = await como(u).post(URL, { tipo: 'MATRICULA', valor: c.f.matricula, ...extra });
      assert.equal(r.status, 400, aviso(r));
      assert.equal(r.body.codigo, 'VALIDACAO');
      assert.equal(JSON.stringify(r.body).includes(c.f.matricula), false);
    }
    const query = await como(u).post(`${URL}?empresaId=${B()}`, { tipo: 'MATRICULA', valor: c.f.matricula });
    assert.equal(query.status, 400);
  });

  test('K7-I6 — usuário da empresa B não identifica colaborador da A (404) e a consulta é auditada na B, nunca na A', async () => {
    const c = await cenario(A());
    const uB = await usuarioCom(B());
    const antesA = (await a.q("SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'TOKEN_PREVIA_CONSULTADA'", [A()])).rows[0].n;
    const r = await como(uB).post(URL, { tipo: 'CPF', valor: c.f.cpf });
    assert.equal(r.status, 404, aviso(r));
    const depoisA = (await a.q("SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'TOKEN_PREVIA_CONSULTADA'", [A()])).rows[0].n;
    assert.equal(depoisA, antesA);
    const emB = await a.q("SELECT usuario_id, referencia FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'TOKEN_PREVIA_CONSULTADA' AND usuario_id = $2", [B(), uB]);
    assert.equal(emB.rows.length, 1);
    assert.equal(emB.rows[0].referencia, null);
  });

  test('K7-I7 — a ÚNICA escrita é UMA linha de auditoria por consulta (também na não identificada); nenhuma outra tabela muda; o funcionário não é alterado', async () => {
    const c = await cenario();
    const u = await usuarioCom(A());
    const antes = await contagensDeTodasAsTabelas();
    const foto = await a.fotografiaOperacional();
    const funcionarioAntes = (await a.q('SELECT * FROM funcionarios WHERE id = $1', [c.f.id])).rows[0];
    for (const corpo of [{ tipo: 'MATRICULA', valor: c.f.matricula }, { tipo: 'CPF', valor: c.f.cpf }, { tipo: 'MATRICULA', valor: 'MX-NAO-EXISTE-2' }]) await como(u).post(URL, corpo);
    const depois = await contagensDeTodasAsTabelas();
    assert.deepEqual(diferencas(antes, depois), ['logs_auditoria: ' + antes.logs_auditoria + ' → ' + (antes.logs_auditoria + 3)], 'três consultas, três linhas de auditoria, nada mais');
    assert.deepEqual(await a.fotografiaOperacional(), foto, 'solicitações, atendimentos, estoque, entregas, fichas, dispositivos e ativações idênticos');
    assert.deepEqual((await a.q('SELECT * FROM funcionarios WHERE id = $1', [c.f.id])).rows[0], funcionarioAntes, 'o colaborador consultado não foi alterado');
    const linhas = (await a.q("SELECT usuario_id, referencia, contexto FROM logs_auditoria WHERE acao = 'TOKEN_PREVIA_CONSULTADA' AND usuario_id = $1 ORDER BY id", [u])).rows;
    assert.equal(linhas.length, 3);
    assert.deepEqual(linhas.map((l) => l.referencia), [String(c.f.id), String(c.f.id), null]);
    assert.deepEqual(linhas.map((l) => Object.keys(l.contexto).sort()), [['encontrado', 'estado', 'tipoIdentificador', 'total'], ['encontrado', 'estado', 'tipoIdentificador', 'total'], ['encontrado', 'tipoIdentificador']]);
    const texto = JSON.stringify(linhas);
    for (const proibido of [c.f.cpf, c.f.matricula, 'MX-NAO-EXISTE-2', c.f.nome]) assert.equal(texto.includes(proibido), false, `a auditoria não traz ${proibido}`);
  });

  test('K7-I8 — limite: a 21ª consulta do mesmo usuário e empresa em um minuto é 429 genérico; quem não tem permissão não gasta o limite; outro usuário tem o seu', async () => {
    const c = await cenario();
    const u = await usuarioCom(A());
    const semPermissao = await usuarioCom(A(), { previa: false, historico: false });
    for (let i = 0; i < 25; i += 1) assert.equal((await como(semPermissao).post(URL, { tipo: 'MATRICULA', valor: c.f.matricula })).status, 403, 'a negação vem antes do limite');
    for (let i = 0; i < 20; i += 1) assert.equal((await como(u).post(URL, { tipo: 'MATRICULA', valor: i % 2 === 0 ? c.f.matricula : 'MX-NAO-EXISTE-3' })).status, i % 2 === 0 ? 200 : 404, `tentativa ${i + 1}`);
    const excesso = await como(u).post(URL, { tipo: 'MATRICULA', valor: c.f.matricula });
    assert.equal(excesso.status, 429, aviso(excesso));
    assert.equal(excesso.body.codigo, 'LIMITE_REQUISICOES_EXCEDIDO');
    assert.equal(JSON.stringify(excesso.body).includes(c.f.matricula), false);
    assert.equal((await como(await usuarioCom(A())).post(URL, { tipo: 'MATRICULA', valor: c.f.matricula })).status, 200);
  });

  test('K7-I9 — o MASTER provisionado tem as duas permissões; o catálogo da prévia por id continua respondendo como antes (controle)', async () => {
    const c = await cenario();
    const r = await como(a.d.master).post(URL, { tipo: 'MATRICULA', valor: c.f.matricula });
    assert.equal(r.status, 200, aviso(r));
    const antiga = await como(a.d.master).get(`${RAIZ}/previa/catalogo?funcionarioId=${c.f.id}`);
    assert.equal(antiga.status, 200, aviso(antiga));
    assert.deepEqual(Object.keys(antiga.body.previa), ['catalogo']);
  });
});
