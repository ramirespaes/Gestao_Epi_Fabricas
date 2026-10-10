'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const {
  criarFuncionario, criarMaterial, criarLote, criarFicha, registrarEntrega,
} = require('./helpers/entrega-epi');
const { criarEntregaEpiController } = require('../../src/controllers/entrega-epi.controller');
const { criarEntregaEpiRoutes } = require('../../src/routes/entrega-epi.routes');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * EPIs Entregues: histórico de itens entregues da empresa (GET /api/entregas-epi/itens), contra PostgreSQL real e a
 * rota real de produção (autorização epiFicha.visualizar antes de validar e consultar).
 */
const HOJE = dataOperacional();
const ha = (dias) => {
  const d = new Date(`${HOJE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};
const BASE = '/api/entregas-epi/itens';

describe('EPIs Entregues — histórico real de itens entregues (PostgreSQL real)', () => {
  let g;
  let master;
  let leitor;
  const ids = {};
  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarEntregaEpiRoutes({ controller: criarEntregaEpiController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    master = await g.contaDaEmpresa(g.empresas.A);
    const A = g.empresas.A;
    const B = g.empresas.B;
    const masterB = await g.contaDaEmpresa(B);
    ids.ana = await criarFuncionario(g.pool, A, { matricula: 'M-001', cpf: '52998224725', setor: 'Produção' });
    ids.joao = await criarFuncionario(g.pool, A, { matricula: 'M-002', cpf: '11144477735', setor: 'Manutenção' });
    await g.pool.query("UPDATE funcionarios SET nome = 'Ana Sapateira' WHERE id = $1", [ids.ana]);
    await g.pool.query("UPDATE funcionarios SET nome = 'João Álvares' WHERE id = $1", [ids.joao]);
    ids.fichaAna = (await criarFicha(g.pool, A, ids.ana)).id;
    ids.fichaJoao = (await criarFicha(g.pool, A, ids.joao)).id;
    const sapato = await criarMaterial(g.pool, A, 'Sapatão de segurança', { tipo: 'Sapato de Segurança', prazo: 180 });
    const luva = await criarMaterial(g.pool, A, 'Luva nitrílica', { tipo: 'Luva', prazo: 30 });
    const oculos = await criarMaterial(g.pool, A, 'Óculos de proteção', { tipo: 'Óculos de Proteção Incolor', prazo: 365 });
    const lote = (materialId) => criarLote(g.pool, { empresaId: A, materialId, quantidade: 1000 });
    const lotes = { sapato: await lote(sapato), luva: await lote(luva), oculos: await lote(oculos) };
    const mats = { sapato, luva, oculos };
    const nomes = { sapato: ['Sapatão de segurança', 'Sapato de Segurança'], luva: ['Luva nitrílica', 'Luva'], oculos: ['Óculos de proteção', 'Óculos de Proteção Incolor'] };
    // [chave, ficha, trabalhador, matrícula, setor, material, prazo, dias atrás]
    const entregas = [
      ['vencida', ids.fichaAna, 'Ana Sapateira', 'M-001', 'Produção', 'sapato', 180, 200],
      ['proximaLuva', ids.fichaAna, 'Ana Sapateira', 'M-001', 'Produção', 'luva', 30, 10],
      ['validaOculos', ids.fichaJoao, 'João Álvares', 'M-002', 'Manutenção', 'oculos', 365, 0],
      ['novoSapato', ids.fichaAna, 'Ana Sapateira', 'M-001', 'Produção', 'sapato', 180, 0],
      ['limite30', ids.fichaJoao, 'João Álvares', 'M-002', 'Manutenção', 'sapato', 180, 150],
      ['limite31', ids.fichaJoao, 'João Álvares', 'M-002', 'Manutenção', 'sapato', 180, 149],
      ['limite0', ids.fichaJoao, 'João Álvares', 'M-002', 'Manutenção', 'sapato', 180, 180],
      ['limiteNeg1', ids.fichaJoao, 'João Álvares', 'M-002', 'Manutenção', 'sapato', 180, 181],
    ];
    for (const [chave, ficha, nome, matricula, setor, mat, prazo, dias] of entregas) {
      const dia = ha(dias);
      const r = await registrarEntrega(g.pool, {
        usuarioId: master.usuarioId,
        entrega: {
          empresa_id: A, ficha_id: ficha, responsavel_id: master.usuarioId, responsavel_nome: 'Responsável Real', data_operacional: dia,
          entregue_em: `${dia}T12:00:00-03:00`, trabalhador_nome: nome, trabalhador_matricula: matricula, trabalhador_setor: setor,
        },
        itens: [{
          material_id: mats[mat], lote_id: lotes[mat], material_nome: nomes[mat][0], material_tipo: nomes[mat][1], material_prazo_uso_dias: prazo,
        }],
      });
      ids[chave] = r.itens[0].id;
    }
    // Empresa B: entrega de sapato que A nunca pode ver.
    const funcB = await criarFuncionario(g.pool, B, { matricula: 'B-001', cpf: '98765432100' });
    const fichaB = (await criarFicha(g.pool, B, funcB)).id;
    const matB = await criarMaterial(g.pool, B, 'Sapatão da B', { tipo: 'Sapato de Segurança', prazo: 180 });
    const loteB = await criarLote(g.pool, { empresaId: B, materialId: matB, quantidade: 100 });
    await registrarEntrega(g.pool, {
      usuarioId: masterB.usuarioId,
      entrega: {
        empresa_id: B, ficha_id: fichaB, responsavel_id: masterB.usuarioId, data_operacional: HOJE, trabalhador_nome: 'Fulano da B', trabalhador_matricula: 'B-001',
      },
      itens: [{ material_id: matB, lote_id: loteB, material_nome: 'Sapatão da B', material_tipo: 'Sapato de Segurança' }],
    });
    leitor = await g.usuarioPronto(master);
    await g.request(g.app).put(`/api/administracao/usuarios/${leitor.id}/acessos/fichaEpi`).set('Cookie', g.cookie(master)).send({ ligado: true });
  });
  after(async () => { if (g) await g.encerrar(); });

  const como = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const consultar = async (q = '') => g.request(g.app).get(`${BASE}${q}`).set('Cookie', await como(leitor));
  const itensDe = (r) => r.body.itens.map((i) => i.itemId);

  test('lista TODAS as entregas da empresa (cada uma com a própria validade), da mais recente para a mais antiga, sem a de outra empresa', async () => {
    const r = await consultar('?limite=100');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.total, 8, 'as duas entregas de sapatão da mesma pessoa continuam, e a da empresa B não aparece');
    assert.ok(itensDe(r).includes(ids.vencida) && itensDe(r).includes(ids.novoSapato), 'a entrega anterior não some quando há outra depois');
    const datas = r.body.itens.map((i) => i.dataEntrega);
    assert.deepEqual(datas, [...datas].sort().reverse(), 'mais recente primeiro');
    assert.ok(r.body.itens.every((i) => i.trabalhador.nome !== 'Fulano da B'));
  });

  test('validade = data da entrega + prazo congelado; dias restantes e status pelos limites 0, 30 e 31', async () => {
    const r = await consultar('?limite=100');
    const por = (id) => r.body.itens.find((i) => i.itemId === id);
    assert.deepEqual([por(ids.vencida).validadeUso, por(ids.vencida).diasRestantes, por(ids.vencida).status], [ha(200 - 180), -20, 'VENCIDO']);
    assert.deepEqual([por(ids.proximaLuva).diasRestantes, por(ids.proximaLuva).status], [20, 'PROXIMO']);
    assert.deepEqual([por(ids.validaOculos).diasRestantes, por(ids.validaOculos).status], [365, 'VALIDO']);
    assert.deepEqual([por(ids.limite0).diasRestantes, por(ids.limite0).status], [0, 'PROXIMO'], '0 dias ainda é próximo do vencimento');
    assert.deepEqual([por(ids.limite30).diasRestantes, por(ids.limite30).status], [30, 'PROXIMO'], '30 dias é o último dia de "próximo"');
    assert.deepEqual([por(ids.limite31).diasRestantes, por(ids.limite31).status], [31, 'VALIDO']);
    assert.deepEqual([por(ids.limiteNeg1).diasRestantes, por(ids.limiteNeg1).status], [-1, 'VENCIDO']);
    assert.equal(r.body.diasProximoVencimento, 30);
  });

  test('contrato dos filtros: sem filtro, cada filtro isolado, combinados e o pedido exato que a tela envia — todos 200; zero resultado é consulta válida', async () => {
    const casos = [
      ['sem nenhum parâmetro', '', 8],
      ['pedido exato da tela, todos os filtros vazios', '?pagina=1&limite=20', 8],
      ['só tipo', '?item=sapat&pagina=1&limite=20', 6],
      ['só funcionário', '?funcionario=ana&pagina=1&limite=20', 3],
      ['só data inicial', `?de=${ha(10)}&pagina=1&limite=20`, 3],
      ['só data final', `?ate=${ha(150)}&pagina=1&limite=20`, 4],
      ['intervalo completo (início e fim de uma semana)', `?de=${ha(6)}&ate=${HOJE}&pagina=1&limite=20`, 2],
      ['só status', '?status=VENCIDO&pagina=1&limite=20', 2],
      ['combinados', `?item=sapat&funcionario=ana&de=${ha(300)}&ate=${HOJE}&status=VENCIDO&pagina=1&limite=20`, 1],
      ['consulta válida sem resultados', '?item=capacete&pagina=1&limite=20', 0],
      ['período válido sem entregas', `?de=${ha(1)}&ate=${ha(1)}&pagina=1&limite=20`, 0],
    ];
    for (const [nome, q, total] of casos) {
      const r = await consultar(q);
      assert.equal(r.status, 200, `${nome}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.total, total, nome);
      assert.equal(r.body.itens.length, Math.min(total, 20), nome);
    }
  });

  test('erro de validação só para parâmetro realmente inválido, apontando o campo da consulta (query.*); servidor sem a rota nova recusa params.id', async () => {
    const campos = async (q) => (await consultar(q)).body.detalhes?.map((d) => d.campo);
    assert.deepEqual(await campos('?status=OUTRO'), ['query.status']);
    assert.deepEqual(await campos('?de=2026-02-30'), ['query.de']);
    assert.deepEqual(await campos('?de=31/12/2026'), ['query.de']);
    assert.deepEqual(await campos('?limite=0'), ['query.limite']);
    assert.deepEqual(await campos('?pagina=abc'), ['query.pagina']);
    assert.equal((await consultar(`?de=${HOJE}&ate=${ha(30)}`)).status, 400, 'início posterior ao fim');
    // O que um servidor ANTIGO (sem /entregas-epi/itens) responderia: a rota /entregas-epi/:id recusa "itens" como id.
    const antigo = await g.request(g.app).get('/api/entregas-epi/itens-x').set('Cookie', await como(leitor));
    assert.equal(antigo.status, 400);
    assert.deepEqual(antigo.body.detalhes.map((d) => d.campo), ['params.id']);
  });

  test('filtro de status: Válido, Próximo do vencimento e Vencido', async () => {
    const venc = await consultar('?status=VENCIDO&limite=100');
    assert.deepEqual(itensDe(venc).sort(), [ids.vencida, ids.limiteNeg1].sort());
    const prox = await consultar('?status=PROXIMO&limite=100');
    assert.deepEqual(itensDe(prox).sort(), [ids.proximaLuva, ids.limite0, ids.limite30].sort());
    const valido = await consultar('?status=VALIDO&limite=100');
    assert.deepEqual(itensDe(valido).sort(), [ids.validaOculos, ids.novoSapato, ids.limite31].sort());
  });

  test('pesquisa do item/tipo por texto: parcial, sem maiúsculas e sem acentos, no tipo e no nome', async () => {
    for (const termo of ['sapat', 'SAPATAO', 'sapatão', 'Sapato de Seg']) {
      const r = await consultar(`?item=${encodeURIComponent(termo)}&limite=100`);
      assert.equal(r.body.total, 6, `"${termo}": os seis sapatões (tipo "Sapato de Segurança" e nome "Sapatão de segurança")`);
    }
    assert.equal((await consultar('?item=LUVA')).body.total, 1);
    assert.deepEqual(itensDe(await consultar('?item=oculos')), [ids.validaOculos], 'sem acento acha "Óculos"');
    assert.deepEqual(itensDe(await consultar('?item=%C3%B3culos')), [ids.validaOculos], 'com acento também');
    assert.equal((await consultar('?item=capacete')).body.total, 0);
    assert.equal((await consultar('?item=%25')).body.total, 0, 'o curinga digitado é texto, não "tudo"');
    assert.equal((await consultar('?item=_')).body.total, 0);
  });

  test('pesquisa do funcionário por nome ou matrícula (parcial, sem acento); CPF nunca é aceito nem devolvido', async () => {
    assert.equal((await consultar('?funcionario=ana')).body.total, 3);
    assert.equal((await consultar('?funcionario=joao')).body.total, 5, 'sem acento acha "João"');
    assert.equal((await consultar('?funcionario=m-002&limite=100')).body.total, 5);
    assert.equal((await consultar('?funcionario=529.982.247-25')).body.total, 0, 'CPF não localiza ninguém');
    assert.equal((await consultar('?funcionario=52998224725')).body.total, 0);
    const todos = await consultar('?limite=100');
    assert.equal(/52998224725|11144477735|cpf/i.test(JSON.stringify(todos.body)), false);
    assert.equal(/requisicao|chaveIdempotencia|hash|"ip"|dispositivo/i.test(JSON.stringify(todos.body)), false);
  });

  test('período pela data da entrega; combinação de filtros; paginação com total', async () => {
    const r = await consultar(`?de=${ha(10)}&ate=${HOJE}&limite=100`);
    assert.deepEqual(itensDe(r).sort(), [ids.proximaLuva, ids.validaOculos, ids.novoSapato].sort());
    assert.equal((await consultar(`?de=${ha(10)}&ate=${ha(10)}`)).body.total, 1);
    assert.equal((await consultar(`?de=${HOJE}&ate=${ha(5)}`)).status, 400, 'período invertido');
    const comb = await consultar(`?item=sapat&funcionario=ana&status=VENCIDO`);
    assert.deepEqual(itensDe(comb), [ids.vencida]);
    const p1 = await consultar('?limite=3&pagina=1');
    const p3 = await consultar('?limite=3&pagina=3');
    assert.deepEqual([p1.body.itens.length, p1.body.total, p1.body.pagina, p3.body.itens.length], [3, 8, 1, 2]);
  });

  test('histórico: Setor, Entregue por e dados do trabalhador vêm do snapshot da entrega, não do cadastro atual', async () => {
    await g.pool.query("UPDATE funcionarios SET nome = 'Nome Novo', setor = 'Setor Novo', matricula = 'M-999' WHERE id = $1", [ids.ana]);
    const r = await consultar('?item=luva');
    const [i] = r.body.itens;
    assert.deepEqual([i.trabalhador.nome, i.trabalhador.matricula, i.trabalhador.setor, i.responsavel.nome], ['Ana Sapateira', 'M-001', 'Produção', 'Responsável Real']);
    assert.deepEqual([i.material.nome, i.material.tipo, i.tamanho, i.quantidade, i.origem], ['Luva nitrílica', 'Luva', '40', 1, 'DIRETA']);
    assert.equal((await consultar('?funcionario=nome%20novo')).body.total, 0, 'a busca também usa o histórico');
  });

  test('autorização e validação: sem sessão 401, sem epiFicha.visualizar 403 (antes de qualquer consulta), parâmetros inválidos 400 e a rota não cai em /:id', async () => {
    assert.equal((await g.request(g.app).get(BASE)).status, 401);
    const semAcesso = await g.usuarioPronto(master);
    const negado = await g.request(g.app).get(BASE).set('Cookie', await como(semAcesso));
    assert.deepEqual([negado.status, negado.body.codigo], [403, 'PERMISSAO_NEGADA']);
    for (const q of ['?status=OUTRO', '?de=31-12-2026', '?item=', '?limite=1000', '?empresaId=2', '?cpf=52998224725']) {
      assert.equal((await consultar(q)).status, 400, q);
    }
    assert.notEqual((await consultar()).body.codigo, 'ENTREGA_NAO_ENCONTRADA');
  });

  test('empresa B enxerga só o histórico dela', async () => {
    const masterB = await g.contaDaEmpresa(g.empresas.B);
    const leitorB = await g.usuarioPronto(masterB);
    await g.request(g.app).put(`/api/administracao/usuarios/${leitorB.id}/acessos/fichaEpi`).set('Cookie', g.cookie(masterB)).send({ ligado: true });
    const r = await g.request(g.app).get(`${BASE}?limite=100`).set('Cookie', await como(leitorB));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.itens.map((i) => i.trabalhador.nome), ['Fulano da B'], 'só o histórico da empresa B');
    assert.equal(r.body.total, 1);
  });
});
