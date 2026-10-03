'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente } = require('./helpers/ambiente-http-12d2');
const { criarLote } = require('./helpers/entrega-epi');

/**
 * Contexto da entrega DIRETA com a posição agregada do par (12D-2), contra
 * PostgreSQL real: GET /api/entregas-epi/contexto/:funcionarioId/materiais/
 * :materialId/lotes devolve, ao lado dos lotes de sempre, a posição por tamanho
 * (físico utilizável, comprometido, saldo livre, demanda sem cobertura e
 * mínimo). Só números agregados: nunca quais solicitações compõem a demanda
 * nem quem as pediu. O erro público da recusa por saldo livre continua 409
 * SALDO_LIVRE_INSUFICIENTE, sem expor a posição de ninguém.
 */

const CHAVES_DA_POSICAO = ['abaixoDoMinimo', 'comprometido', 'estoqueMinimo', 'fisicoUtilizavel', 'minimoOrigem', 'saldoLivre', 'semCobertura', 'tamanho'];

describe('contexto da entrega direta com a posição — HTTP (PostgreSQL real)', () => {
  let amb;
  let master;
  let masterB;
  const q = (sql, params) => amb.pool.query(sql, params);

  before(async () => {
    amb = await montarAmbiente();
    master = amb.como(amb.d.master);
    masterB = amb.como(amb.d.masterB);
  });
  after(async () => { if (amb) await amb.encerrar(); });

  const rotaDeLotes = (funcionarioId, materialId) => `/api/entregas-epi/contexto/${funcionarioId}/materiais/${materialId}/lotes`;
  const contexto = async (quem, materialId, funcionarioId = amb.d.trabalhador2) => {
    const r = await quem.get(rotaDeLotes(funcionarioId, materialId));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const porTamanho = (corpo) => Object.fromEntries(corpo.posicoes.map((p) => [p.tamanho ?? '-', [p.fisicoUtilizavel, p.comprometido, p.saldoLivre, p.semCobertura, p.estoqueMinimo, p.minimoOrigem, p.abaixoDoMinimo]]));

  describe('a posição por tamanho', () => {
    test('o contrato antigo (material, hoje, lotes) continua, e a posição vem ao lado, por tamanho', async () => {
      const id = await amb.f.material();
      await q('UPDATE materiais SET estoque_minimo = 5 WHERE id = $1', [id]);
      await amb.f.estoque(id, 8, { tamanho: '40' });
      await amb.f.estoque(id, 4, { tamanho: '41' });
      const corpo = await contexto(master, id);
      assert.deepEqual(Object.keys(corpo).sort(), ['hoje', 'lotes', 'material', 'posicoes', 'status']);
      assert.deepEqual(Object.keys(corpo.material).sort(), ['ativo', 'exigeTamanho', 'id', 'nome', 'oculosComGrau', 'prazoUsoDias']);
      assert.equal(corpo.lotes.length, 2);
      assert.deepEqual(Object.keys(corpo.lotes[0]).sort(), ['caNumero', 'caValidade', 'loteId', 'saldo', 'situacaoCa', 'tamanho']);
      assert.deepEqual(porTamanho(corpo), { 40: [8, 0, 8, 0, 5, 'PADRAO', false], 41: [4, 0, 4, 0, 5, 'PADRAO', true] });
      for (const p of corpo.posicoes) assert.deepEqual(Object.keys(p).sort(), CHAVES_DA_POSICAO);
    });

    test('com demanda aprovada de outras pessoas: o comprometido e o livre aparecem, e a demanda sem lote também (tamanho sem estoque)', async () => {
      const id = await amb.f.material();
      await amb.f.estoque(id, 8, { tamanho: '40' });
      await amb.f.aprovada({ materialId: id, quantidade: 2, tamanho: '40' });
      await amb.f.aprovada({ materialId: id, quantidade: 3, tamanho: '42', funcionarioId: amb.d.trabalhador3 });
      const posicoes = porTamanho(await contexto(master, id));
      assert.deepEqual(posicoes['40'], [8, 2, 6, 0, 0, 'PADRAO', false]);
      assert.deepEqual(posicoes['42'], [0, 0, 0, 3, 0, 'PADRAO', false], 'sem lote no 42: toda a demanda fica sem cobertura');
    });

    test('só números agregados: nenhuma solicitação, número, solicitante, trabalhador ou justificativa na resposta', async () => {
      const id = await amb.f.material();
      await amb.f.estoque(id, 8);
      const pedida = await amb.f.aprovada({ materialId: id, quantidade: 2 });
      const numero = (await q('SELECT numero FROM solicitacoes_epi WHERE id = $1', [pedida.id])).rows[0].numero;
      const corpo = await contexto(master, id);
      const texto = JSON.stringify(corpo);
      assert.doesNotMatch(texto, /solicit|justific|demanda|aprova|decid/i);
      const quem = (await q('SELECT nome FROM funcionarios WHERE id = $1', [amb.d.trabalhador])).rows[0].nome;
      assert.ok(!texto.includes(quem), 'o trabalhador da solicitação não aparece no contexto de outro trabalhador');
      assert.ok(!texto.includes('master-a@example.invalid') && !texto.includes('solicitante-a@example.invalid'));
      assert.ok(!new RegExp(`"(id|numero)":${numero}[,}]`).test(JSON.stringify(corpo.posicoes)));
      assert.deepEqual(Object.keys(corpo.posicoes[0]).sort(), CHAVES_DA_POSICAO);
    });

    test('o mínimo próprio do tamanho aparece como PROPRIO (inclusive zero) e os outros tamanhos herdam o padrão', async () => {
      const id = await amb.f.material();
      await q('UPDATE materiais SET estoque_minimo = 20 WHERE id = $1', [id]);
      for (const tamanho of ['P', 'M', 'G']) await amb.f.estoque(id, 3, { tamanho });
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, 'M', 2), ($1, $2, 'G', 0)", [amb.d.empresaA, id]);
      assert.deepEqual(porTamanho(await contexto(master, id)), {
        P: [3, 0, 3, 0, 20, 'PADRAO', true], M: [3, 0, 3, 0, 2, 'PROPRIO', false], G: [3, 0, 3, 0, 0, 'PROPRIO', false],
      });
    });

    test('material que não usa tamanho: a posição é do par sem tamanho (tamanho nulo)', async () => {
      const id = await amb.f.material({ exigeTamanho: false });
      await q('UPDATE materiais SET estoque_minimo = 4 WHERE id = $1', [id]);
      await amb.f.estoque(id, 6, { tamanho: null });
      assert.deepEqual((await contexto(master, id)).posicoes, [{
        tamanho: null, fisicoUtilizavel: 6, comprometido: 0, saldoLivre: 6, semCobertura: 0, estoqueMinimo: 4, minimoOrigem: 'PADRAO', abaixoDoMinimo: false,
      }]);
    });

    test('lote com CA vencido não é utilizável: o físico utilizável não o conta, mas o lote continua na lista com a situação do CA', async () => {
      const id = await amb.f.material();
      await amb.f.estoque(id, 5);
      await amb.f.estoque(id, 7, { caValidade: '2020-01-01' });
      const corpo = await contexto(master, id);
      assert.deepEqual(porTamanho(corpo)['40'].slice(0, 3), [5, 0, 5]);
      assert.deepEqual(corpo.lotes.map((l) => l.situacaoCa).sort(), ['VALIDO', 'VENCIDO']);
    });

    test('a posição acompanha o estoque: entrada, baixa e entrega direta mudam o livre', async () => {
      const id = await amb.f.material();
      const lote = await amb.f.estoque(id, 5);
      await amb.f.aprovada({ materialId: id, quantidade: 2 });
      assert.deepEqual(porTamanho(await contexto(master, id))['40'].slice(0, 4), [5, 2, 3, 0]);
      await amb.f.estoque(id, 4);
      assert.deepEqual(porTamanho(await contexto(master, id))['40'].slice(0, 4), [9, 2, 7, 0]);
      await amb.f.baixa(lote, 1, 'AVARIA');
      assert.deepEqual(porTamanho(await contexto(master, id))['40'].slice(0, 4), [8, 2, 6, 0]);
      await amb.f.direta([[id, lote, 3]]);
      assert.deepEqual(porTamanho(await contexto(master, id))['40'].slice(0, 4), [5, 2, 3, 0]);
    });

    test('material inativo: o contexto responde como antes (ativo falso) e a posição vem vazia, porque o inativo não entra na posição', async () => {
      const id = await amb.f.material();
      await amb.f.estoque(id, 5);
      await q('UPDATE materiais SET ativo = false WHERE id = $1', [id]);
      const corpo = await contexto(master, id);
      assert.deepEqual([corpo.material.ativo, corpo.posicoes, corpo.lotes.length], [false, [], 1]);
    });

    test('material sem estoque nem demanda nem mínimo: posições vazias, lotes vazios', async () => {
      const id = await amb.f.material();
      const corpo = await contexto(master, id);
      assert.deepEqual([corpo.posicoes, corpo.lotes], [[], []]);
    });
  });

  describe('MULTIEMPRESA, RBAC e erros', () => {
    test('material ou trabalhador de outra empresa: 404, igual ao inexistente; a posição da outra empresa nunca aparece', async () => {
      const daB = await amb.material(amb.d.empresaB, 'Material da B no contexto', { estoqueMinimo: 50 });
      await criarLote(amb.pool, { empresaId: amb.d.empresaB, materialId: daB, quantidade: 33, tamanho: '40' });
      const cruzado = await master.get(rotaDeLotes(amb.d.trabalhador2, daB));
      const inexistente = await master.get(rotaDeLotes(amb.d.trabalhador2, 999999));
      assert.deepEqual([cruzado.status, cruzado.body], [404, inexistente.body]);
      assert.equal(cruzado.body.codigo, 'MATERIAL_NAO_ENCONTRADO');
      const trabalhadorDeOutraEmpresa = await master.get(rotaDeLotes(amb.d.trabalhadorB, await amb.f.material()));
      assert.deepEqual([trabalhadorDeOutraEmpresa.status, trabalhadorDeOutraEmpresa.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      const daPropriaB = await contexto(masterB, daB, amb.d.trabalhadorB);
      assert.deepEqual(porTamanho(daPropriaB), { 40: [33, 0, 33, 0, 50, 'PADRAO', true] });
    });

    test('REALIZAR_ENTREGA é a única autoridade: sem ela 403, mesmo com materials, availableItems, operations e epiFicha; sem identificação 401', async () => {
      const id = await amb.f.material();
      const sem = amb.como(await amb.usuarioCom(amb.d.empresaA, { materials: ['visualizar'], availableItems: ['visualizar'], operations: ['visualizar'], epiFicha: ['visualizar'] }));
      const r = await sem.get(rotaDeLotes(amb.d.trabalhador2, id));
      assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
      assert.equal((await amb.anonimo.get(rotaDeLotes(amb.d.trabalhador2, id))).status, 401);
    });

    test('identificadores fora do formato: 400', async () => {
      for (const [f, m] of [['0', '1'], ['1', '0'], ['abc', '1'], ['1', 'x']]) {
        assert.equal((await master.get(`/api/entregas-epi/contexto/${f}/materiais/${m}/lotes`)).status, 400, `${f}/${m}`);
      }
    });
  });

  describe('entrega direta: o saldo livre limita, e o erro público não vaza a posição', () => {
    const corpoDaEntrega = (materialId, loteId, quantidade) => ({
      funcionarioId: amb.d.trabalhador2,
      itens: [{ materialId, loteId, quantidade, motivo: 'ADMISSAO' }],
      confirmacao: amb.ACEITE,
      chaveIdempotencia: amb.chaveNova(),
    });

    test('quantidade acima do saldo livre: 409 SALDO_LIVRE_INSUFICIENTE, corpo mínimo, nada gravado, recusa auditada depois do ROLLBACK', async () => {
      const id = await amb.f.material();
      const lote = await amb.f.estoque(id, 5);
      const pedida = await amb.f.aprovada({ materialId: id, quantidade: 4 });
      const r = await master.post('/api/entregas-epi').send(corpoDaEntrega(id, lote, 3));
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['codigo', 'message', 'status']);
      assert.deepEqual([r.body.status, r.body.codigo], ['error', 'SALDO_LIVRE_INSUFICIENTE']);
      const texto = JSON.stringify(r.body);
      assert.doesNotMatch(texto, /recusa|solicit|demanda|comprometido|SELECT|stack|pg_/i);
      assert.ok(!texto.includes(String(pedida.id)) && !texto.includes(String(lote)));
      assert.equal((await q('SELECT saldo FROM estoque_lotes WHERE id = $1', [lote])).rows[0].saldo, 5);
      const auditoria = (await q("SELECT contexto FROM logs_auditoria WHERE acao = 'SALDO_LIVRE_INSUFICIENTE' AND (contexto->>'materialId')::int = $1", [id])).rows;
      assert.equal(auditoria.length, 1);
      assert.deepEqual(Object.keys(auditoria[0].contexto).sort(), ['comprometido', 'demandaPendente', 'fisicoUtilizavel', 'materialId', 'operacao', 'quantidadeSolicitada', 'saldoLivre', 'tamanho']);
    });

    test('dentro do saldo livre a entrega sai (201) e o contexto mostra o livre menor; no limite exato também sai', async () => {
      const id = await amb.f.material();
      const lote = await amb.f.estoque(id, 5);
      await amb.f.aprovada({ materialId: id, quantidade: 2 });
      assert.deepEqual(porTamanho(await contexto(master, id))['40'].slice(0, 4), [5, 2, 3, 0]);
      const r = await master.post('/api/entregas-epi').send(corpoDaEntrega(id, lote, 3));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(porTamanho(await contexto(master, id))['40'].slice(0, 4), [2, 2, 0, 0]);
      const acima = await master.post('/api/entregas-epi').send(corpoDaEntrega(id, lote, 1));
      assert.deepEqual([acima.status, acima.body.codigo], [409, 'SALDO_LIVRE_INSUFICIENTE']);
    });
  });
});
