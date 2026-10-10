'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { inserir, criarMaterial } = require('./helpers/entrega-epi');
const { criarLoteDeEntrada } = require('./helpers/solicitacao-epi');
const { vincularMaterialAoGhe } = require('./helpers/solicitacao-epi-servico');

/**
 * Contexto da nova solicitação de EPI (12G-0, L2), contra PostgreSQL real, com
 * as rotas, a autorização central, os schemas e os serviços de produção:
 *   GET /api/solicitacoes-epi/contexto/funcionarios?busca     recurso `request`, criar;
 *   GET /api/solicitacoes-epi/contexto/:funcionarioId/materiais   idem.
 * Quem pede escolhe o trabalhador (nome, matrícula, setor e função, nunca o CPF)
 * e o material (ativo; o não classificado vem com exigeTamanho nulo; com a previsão no GHE do trabalhador e as
 * sugestões de tamanho dos lotes já existentes); nenhum número de estoque sai
 * para quem só pede. Só a empresa da sessão.
 */

const URL_FUNCIONARIOS = '/api/solicitacoes-epi/contexto/funcionarios';
const materiaisDe = (funcionarioId) => `/api/solicitacoes-epi/contexto/${funcionarioId}/materiais`;
const ID_INEXISTENTE = 2147483000;
const CAMPOS_TRABALHADOR = ['funcao', 'id', 'matricula', 'nome', 'setor'];
const CAMPOS_MATERIAL = ['exigeTamanho', 'id', 'nome', 'previstoNoGhe', 'tamanhosSugeridos', 'unidade'];
const PALAVRAS_DE_ESTOQUE = /saldo|lote|fisico|comprometid|cobertura|posicao|quantidade|disponivel|minimo|deficit|necessidade|ca(Numero|Validade)/i;

describe('contexto da nova solicitação de EPI — HTTP (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};
  const t = {};
  const m = {};
  let cpf = 70000000000;

  const resposta = (r) => ({ status: r.status, corpo: r.body });
  const trabalhador = async (empresaId, nome, extra = {}) => {
    cpf += 1;
    return (await inserir(pool, 'funcionarios', {
      empresa_id: empresaId, nome, matricula: extra.matricula ?? `CTX-${cpf}`, cpf: String(cpf), grupo_homogeneo_id: extra.gheId ?? null, situacao: (extra.ativo ?? true) ? 'ATIVO' : 'INATIVO', setor: extra.setor ?? null, funcao: extra.funcao ?? null,
    })).id;
  };
  const cpfsDoBanco = async () => (await pool.query('SELECT cpf FROM funcionarios')).rows.map((l) => l.cpf);

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    const A = d.empresaA;
    const B = d.empresaB;
    u.criador = await env.usuarioCom(A, { recursos: { request: ['criar'] } });
    u.soVe = await env.usuarioCom(A, { recursos: { request: ['visualizar'] } });
    u.soEdita = await env.usuarioCom(A, { recursos: { request: ['editar'] } });
    u.sst = await env.usuarioCom(A, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO'], sst: true });
    u.entregador = await env.usuarioCom(A, { acoes: ['REALIZAR_ENTREGA'] });
    u.semNada = await env.usuarioCom(A);
    u.criadorB = await env.usuarioCom(B, { recursos: { request: ['criar'] } });

    t.ana = await trabalhador(A, 'Zelia Contexto Ana', { matricula: 'ZCX-001', setor: 'Fundição', funcao: 'Operadora de forno', gheId: d.gheA });
    t.beto = await trabalhador(A, 'Zelia Contexto Beto', { matricula: 'ZCX-002', setor: 'Manutenção', funcao: 'Mecânico' });
    t.caio = await trabalhador(A, 'zelia contexto caio', { matricula: 'ZCX-003', gheId: d.gheA2 });
    t.inativo = await trabalhador(A, 'Zelia Contexto Inativa', { matricula: 'ZCX-004', ativo: false });
    t.porcento = await trabalhador(A, 'Zelia 100% Contexto', { matricula: 'ZCX-005' });
    t.daB = await trabalhador(B, 'Zelia Contexto da Outra', { matricula: 'ZCX-001' });

    // Materiais do contexto: previsto no GHE A (com lotes de dois tamanhos), fora do GHE, sem tamanho, não classificado e inativo.
    // O previsto vem por último no nome: só a ordem "previstos primeiro" o põe à frente.
    m.previsto = await criarMaterial(pool, A, 'Ytrium Sapato Contexto', { exigeTamanho: true, unidade: 'par', codigoInterno: 'YT-01' });
    await vincularMaterialAoGhe(pool, A, d.gheA, m.previsto);
    for (const [tamanho, quantidade] of [['41', 5], ['39', 1], ['41', 100]]) {
      await criarLoteDeEntrada(pool, { empresaId: A, materialId: m.previsto, quantidade, usuarioId: d.master, tamanho });
    }
    m.fora = await criarMaterial(pool, A, 'Ytrium Luva Contexto', { exigeTamanho: true, unidade: 'par' });
    m.semTamanho = await criarMaterial(pool, A, 'Ytrium Capacete Contexto', { exigeTamanho: false, unidade: 'unidade' });
    await criarLoteDeEntrada(pool, { empresaId: A, materialId: m.semTamanho, quantidade: 3, usuarioId: d.master, tamanho: null });
    m.naoClassificado = await criarMaterial(pool, A, 'Ytrium Sem Classificacao Contexto', { exigeTamanho: null });
    m.inativo = await criarMaterial(pool, A, 'Ytrium Inativo Contexto', { exigeTamanho: true, ativo: false });
    m.daB = await criarMaterial(pool, B, 'Ytrium Bota da Outra', { exigeTamanho: true });
    await criarLoteDeEntrada(pool, { empresaId: B, materialId: m.daB, quantidade: 4, usuarioId: d.masterB, tamanho: '44' });
  });

  after(async () => { if (env) await env.encerrar(); });

  describe('GET /solicitacoes-epi/contexto/funcionarios', () => {
    test('exige request.criar: só visualizar, só editar, a SST, quem entrega e sem nada recebem o mesmo 403; o MASTER provisionado passa (request no escopo desde 05/10/2026); sem sessão, 401', async () => {
      const respostas = [];
      for (const usuario of [u.soVe, u.soEdita, u.sst, u.entregador, u.semNada]) respostas.push(resposta(await como(usuario).get(`${URL_FUNCIONARIOS}?busca=Zelia`)));
      assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'PERMISSAO_NEGADA']);
      for (const r of respostas) assert.deepEqual(r, respostas[0]);
      assert.equal((await como(d.master).get(`${URL_FUNCIONARIOS}?busca=Zelia`)).status, 200, 'MASTER provisionado: request.criar vem do provisionamento, não do nome do perfil');
      assert.equal((await env.anonimo.get(URL_FUNCIONARIOS)).status, 401);
    });

    test('200: busca por nome ou matrícula, sem diferenciar maiúsculas; só ativos; só id, nome, matrícula, setor e função; nenhum CPF', async () => {
      const r = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=${encodeURIComponent('ZELIA CONTEXTO')}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.funcionarios.map((x) => x.id).sort((a, b) => a - b), [t.ana, t.beto, t.caio].sort((a, b) => a - b));
      assert.equal(r.body.total, 3);
      for (const x of r.body.funcionarios) assert.deepEqual(Object.keys(x).sort(), CAMPOS_TRABALHADOR);
      const ana = r.body.funcionarios.find((x) => x.id === t.ana);
      assert.deepEqual(ana, {
        id: t.ana, nome: 'Zelia Contexto Ana', matricula: 'ZCX-001', setor: 'Fundição', funcao: 'Operadora de forno',
      });
      const porMatricula = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=zcx-002`);
      assert.deepEqual(porMatricula.body.funcionarios.map((x) => x.id), [t.beto]);
      const texto = JSON.stringify(r.body) + JSON.stringify(porMatricula.body);
      assert.equal(/cpf/i.test(texto), false);
      for (const cpfDoBanco of await cpfsDoBanco()) assert.equal(texto.includes(cpfDoBanco), false, 'CPF na resposta');
    });

    test('a busca é literal: os coringas do LIKE (% e _) não ampliam o resultado', async () => {
      const r = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=${encodeURIComponent('100%')}`);
      assert.deepEqual(r.body.funcionarios.map((x) => x.id), [t.porcento]);
      const sublinhado = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=${encodeURIComponent('Z_lia')}`);
      assert.deepEqual(sublinhado.body.funcionarios, []);
    });

    test('isolamento: o trabalhador da outra empresa nunca aparece, nem pela matrícula repetida; a outra empresa vê só os dela', async () => {
      const r = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=ZCX-001`);
      assert.deepEqual(r.body.funcionarios.map((x) => x.id), [t.ana]);
      const daOutra = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=${encodeURIComponent('da Outra')}`);
      assert.deepEqual([daOutra.body.funcionarios, daOutra.body.total], [[], 0]);
      const b = await como(u.criadorB).get(`${URL_FUNCIONARIOS}?busca=ZCX-001`);
      assert.deepEqual(b.body.funcionarios.map((x) => x.id), [t.daB]);
    });

    test('paginação: em ordem de nome, as páginas reconstroem a lista com o total; além da última vem vazia; limite fora de 1 a 100 é 400', async () => {
      const inteira = (await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=${encodeURIComponent('Zelia Contexto')}&limite=100`)).body.funcionarios.map((x) => x.id);
      const p1 = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=${encodeURIComponent('Zelia Contexto')}&pagina=1&limite=2`);
      const p2 = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=${encodeURIComponent('Zelia Contexto')}&pagina=2&limite=2`);
      const p9 = await como(u.criador).get(`${URL_FUNCIONARIOS}?busca=${encodeURIComponent('Zelia Contexto')}&pagina=9&limite=2`);
      assert.deepEqual([...p1.body.funcionarios, ...p2.body.funcionarios].map((x) => x.id), inteira);
      assert.deepEqual([p1.body.total, p1.body.pagina, p1.body.limite], [3, 1, 2]);
      assert.deepEqual([p9.body.funcionarios, p9.body.total], [[], 3]);
      assert.deepEqual(inteira, [t.ana, t.beto, t.caio], 'ordem pelo nome, sem diferenciar maiúsculas');
      for (const consulta of ['limite=0', 'limite=101', 'pagina=0', `busca=${'x'.repeat(101)}`, 'cpf=12345678909']) {
        const r = await como(u.criador).get(`${URL_FUNCIONARIOS}?${consulta}`);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], consulta);
      }
    });
  });

  describe('GET /solicitacoes-epi/contexto/:funcionarioId/materiais', () => {
    const doContexto = async (funcionarioId, consulta = 'busca=Ytrium&limite=100') => como(u.criador).get(`${materiaisDe(funcionarioId)}?${consulta}`);

    test('exige request.criar: os mesmos 403 de quem não cria; o MASTER provisionado passa (05/10/2026); sem sessão, 401', async () => {
      const respostas = [];
      for (const usuario of [u.soVe, u.soEdita, u.sst, u.entregador, u.semNada]) respostas.push(resposta(await como(usuario).get(materiaisDe(t.ana))));
      assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'PERMISSAO_NEGADA']);
      for (const r of respostas) assert.deepEqual(r, respostas[0]);
      assert.equal((await como(d.master).get(materiaisDe(t.ana))).status, 200, 'MASTER provisionado: request.criar vem do provisionamento');
      assert.equal((await env.anonimo.get(materiaisDe(t.ana))).status, 401);
    });

    test('200: só materiais ativos da empresa (o não classificado vem com exigeTamanho nulo); campos exatos; previsto pelo GHE do trabalhador; sugestões de tamanho dos lotes, únicas e em ordem', async () => {
      const r = await doContexto(t.ana);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const porId = new Map(r.body.materiais.map((x) => [x.id, x]));
      assert.deepEqual([...porId.keys()].sort((a, b) => a - b), [m.previsto, m.fora, m.semTamanho, m.naoClassificado].sort((a, b) => a - b), 'sem o inativo e o da outra empresa');
      assert.deepEqual(porId.get(m.naoClassificado), {
        id: m.naoClassificado, nome: 'Ytrium Sem Classificacao Contexto', unidade: 'unidade', exigeTamanho: null, previstoNoGhe: false, tamanhosSugeridos: [],
      });
      for (const x of r.body.materiais) assert.deepEqual(Object.keys(x).sort(), CAMPOS_MATERIAL);
      assert.deepEqual(porId.get(m.previsto), {
        id: m.previsto, nome: 'Ytrium Sapato Contexto', unidade: 'par', exigeTamanho: true, previstoNoGhe: true, tamanhosSugeridos: ['39', '41'],
      });
      assert.deepEqual([porId.get(m.fora).previstoNoGhe, porId.get(m.fora).tamanhosSugeridos], [false, []]);
      assert.deepEqual([porId.get(m.semTamanho).exigeTamanho, porId.get(m.semTamanho).tamanhosSugeridos], [false, []]);
      assert.deepEqual([r.body.funcionarioId, r.body.total, r.body.pagina, r.body.limite], [t.ana, 4, 1, 100]);
    });

    test('nenhum número de estoque: nem chave de saldo, lote, posição ou CA, nem as quantidades dos lotes nos valores', async () => {
      const r = await doContexto(t.ana);
      for (const x of r.body.materiais) for (const chave of Object.keys(x)) assert.equal(PALAVRAS_DE_ESTOQUE.test(chave), false, chave);
      const texto = JSON.stringify(r.body.materiais.map(({ id, ...resto }) => resto));
      for (const quantidade of ['105', '106', '"5"', '"100"', '"3"', ':5,', ':100,', ':3,']) assert.equal(texto.includes(quantidade), false, quantidade);
    });

    test('as sugestões de tamanho não dependem do saldo: zerar o lote ou somar unidades não muda nada', async () => {
      const antes = (await doContexto(t.ana)).body.materiais.find((x) => x.id === m.previsto).tamanhosSugeridos;
      const { rows: [lote39] } = await pool.query("SELECT id FROM estoque_lotes WHERE material_id = $1 AND tamanho = '39'", [m.previsto]);
      await f.baixa(lote39.id, 1, 'AVARIA');
      await criarLoteDeEntrada(pool, { empresaId: d.empresaA, materialId: m.previsto, quantidade: 7, usuarioId: d.master, tamanho: '41' });
      const depois = (await doContexto(t.ana)).body.materiais.find((x) => x.id === m.previsto).tamanhosSugeridos;
      assert.deepEqual([antes, depois], [['39', '41'], ['39', '41']]);
    });

    test('previsto no GHE é o do trabalhador do caminho: outro GHE ou sem GHE, nada previsto', async () => {
      const deOutroGhe = await doContexto(t.caio);
      assert.equal(deOutroGhe.body.materiais.find((x) => x.id === m.previsto).previstoNoGhe, false);
      const semGhe = await doContexto(t.beto);
      assert.ok(semGhe.body.materiais.every((x) => x.previstoNoGhe === false));
    });

    test('filtros e ordem: previstos primeiro, depois o nome; busca por nome ou código; previstoNoGhe true/false; paginação com total', async () => {
      const todos = await doContexto(t.ana);
      assert.deepEqual(todos.body.materiais.map((x) => x.id), [m.previsto, m.semTamanho, m.fora, m.naoClassificado]);
      assert.deepEqual((await doContexto(t.ana, 'busca=YT-01')).body.materiais.map((x) => x.id), [m.previsto]);
      assert.deepEqual((await doContexto(t.ana, 'busca=Ytrium&previstoNoGhe=true')).body.materiais.map((x) => x.id), [m.previsto]);
      assert.deepEqual((await doContexto(t.ana, 'busca=Ytrium&previstoNoGhe=false')).body.materiais.map((x) => x.id), [m.semTamanho, m.fora, m.naoClassificado]);
      const p1 = await doContexto(t.ana, 'busca=Ytrium&pagina=1&limite=2');
      const p2 = await doContexto(t.ana, 'busca=Ytrium&pagina=2&limite=2');
      assert.deepEqual([...p1.body.materiais, ...p2.body.materiais].map((x) => x.id), [m.previsto, m.semTamanho, m.fora, m.naoClassificado]);
      assert.deepEqual([p1.body.total, p2.body.total], [4, 4]);
    });

    test('isolamento: trabalhador da outra empresa ou inexistente é o mesmo 404 FUNCIONARIO_NAO_ENCONTRADO; o inativo é 409 FUNCIONARIO_INATIVO', async () => {
      const inexistente = resposta(await doContexto(ID_INEXISTENTE));
      const daOutra = resposta(await doContexto(t.daB));
      assert.deepEqual([inexistente.status, inexistente.corpo.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      assert.deepEqual(daOutra, inexistente);
      const inativo = await doContexto(t.inativo);
      assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'FUNCIONARIO_INATIVO']);
      const b = await como(u.criadorB).get(`${materiaisDe(t.daB)}?busca=Ytrium`);
      assert.deepEqual(b.body.materiais.map((x) => [x.id, x.tamanhosSugeridos]), [[m.daB, ['44']]], 'a outra empresa vê só os dela');
    });

    test('caminho e consulta inválidos: 400', async () => {
      for (const caminho of [materiaisDe('abc'), materiaisDe('0'), `${materiaisDe(t.ana)}?saldo=1`, `${materiaisDe(t.ana)}?previstoNoGhe=sim`]) {
        const r = await como(u.criador).get(caminho);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], caminho);
      }
    });
  });
});
