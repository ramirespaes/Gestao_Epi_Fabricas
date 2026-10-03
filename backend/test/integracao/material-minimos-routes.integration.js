'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { montarAmbiente } = require('./helpers/ambiente-http-12d2');

/**
 * Mínimo por tamanho por HTTP (12D-2), contra PostgreSQL real: GET, PUT e
 * DELETE em /api/materiais/:id/minimos[/:tamanho]. O mínimo PADRÃO é
 * materiais.estoque_minimo; a sobrescrita por tamanho (estoque_minimos, 067) só
 * existe para material que exige tamanho. Empresa e ator só da sessão;
 * materials.visualizar lê, materials.editar altera; a auditoria entra na
 * mesma transação, só com ids e números.
 */

describe('mínimos por tamanho — HTTP (PostgreSQL real)', () => {
  let amb;
  let master;
  let masterB;
  let sequencia = 0;
  const q = (sql, params) => amb.pool.query(sql, params);

  before(async () => {
    amb = await montarAmbiente();
    master = amb.como(amb.d.master);
    masterB = amb.como(amb.d.masterB);
  });
  after(async () => { if (amb) await amb.encerrar(); });

  const novoMaterial = (opcoes = {}) => {
    sequencia += 1;
    return amb.material(amb.d.empresaA, `Material de mínimo ${sequencia}`, { estoqueMinimo: 20, ...opcoes });
  };
  const url = (id, tamanho) => (tamanho === undefined ? `/api/materiais/${id}/minimos` : `/api/materiais/${id}/minimos/${encodeURIComponent(tamanho)}`);
  const linhas = async (id) => (await q('SELECT tamanho, minimo, atualizado_em FROM estoque_minimos WHERE material_id = $1 ORDER BY tamanho', [id])).rows;
  const auditorias = async (acao, id) => (await q(
    'SELECT id, empresa_id, usuario_id, acao, referencia, ip, dispositivo, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id',
    [acao, String(id)],
  )).rows;

  describe('GET /api/materiais/:id/minimos', () => {
    test('devolve o mínimo padrão, se o material exige tamanho e as sobrescritas ordenadas por tamanho', async () => {
      const id = await novoMaterial();
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, 'P', 10), ($1, $2, 'G', 0), ($1, $2, 'M', 30)", [amb.d.empresaA, id]);
      const r = await master.get(url(id));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, {
        status: 'ok',
        materialId: id,
        estoqueMinimoPadrao: 20,
        exigeTamanho: true,
        overrides: [{ tamanho: 'G', minimo: 0 }, { tamanho: 'M', minimo: 30 }, { tamanho: 'P', minimo: 10 }],
      });
    });

    test('material sem sobrescrita: lista vazia; sem tamanho ou não classificado: o exigeTamanho do cadastro (false e null)', async () => {
      const comTamanho = await novoMaterial();
      assert.deepEqual((await master.get(url(comTamanho))).body.overrides, []);
      const semTamanho = await novoMaterial({ exigeTamanho: false });
      const semClasse = await novoMaterial({ exigeTamanho: null });
      assert.deepEqual((await master.get(url(semTamanho))).body, { status: 'ok', materialId: semTamanho, estoqueMinimoPadrao: 20, exigeTamanho: false, overrides: [] });
      assert.equal((await master.get(url(semClasse))).body.exigeTamanho, null);
    });

    test('material inexistente: 404 MATERIAL_NAO_ENCONTRADO; id fora do formato: 400', async () => {
      const r = await master.get(url(999999));
      assert.deepEqual([r.status, r.body.codigo], [404, 'MATERIAL_NAO_ENCONTRADO']);
      for (const id of ['0', '007', 'abc', '-1', '2147483648']) assert.equal((await master.get(`/api/materiais/${id}/minimos`)).status, 400, id);
    });

    test('MULTIEMPRESA: o material de outra empresa responde 404 igual ao inexistente, e as sobrescritas dele nunca vazam', async () => {
      const deB = await amb.material(amb.d.empresaB, 'Material da B', { estoqueMinimo: 7 });
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, 'P', 99)", [amb.d.empresaB, deB]);
      const daA = await master.get(url(deB));
      const inexistente = await master.get(url(999998));
      assert.deepEqual([daA.status, daA.body], [inexistente.status, inexistente.body]);
      assert.ok(!JSON.stringify(daA.body).includes('99'));
      const daB = await masterB.get(url(deB));
      assert.deepEqual(daB.body.overrides, [{ tamanho: 'P', minimo: 99 }]);
    });
  });

  describe('PUT /api/materiais/:id/minimos/:tamanho', () => {
    test('cria: 201, criado e alterado, a linha gravada e o estado completo; auditoria ESTOQUE_MINIMO_DEFINIDO na mesma transação', async () => {
      const id = await novoMaterial();
      const r = await master.put(url(id, 'M')).send({ minimo: 20 });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual(r.body, {
        status: 'ok', criado: true, alterado: true, materialId: id, estoqueMinimoPadrao: 20, exigeTamanho: true, overrides: [{ tamanho: 'M', minimo: 20 }],
      });
      assert.deepEqual((await linhas(id)).map((l) => [l.tamanho, l.minimo]), [['M', 20]]);
      const [auditoria, ...resto] = await auditorias('ESTOQUE_MINIMO_DEFINIDO', id);
      assert.equal(resto.length, 0);
      assert.deepEqual(
        [auditoria.empresa_id, auditoria.usuario_id, auditoria.referencia, auditoria.dados_anteriores, auditoria.dados_novos],
        [amb.d.empresaA, amb.d.master, String(id), null, null],
      );
      assert.deepEqual(auditoria.contexto, { materialId: id, tamanho: 'M', minimoAnterior: null, minimoNovo: 20 });
      assert.deepEqual(Object.keys(auditoria.contexto).sort(), ['materialId', 'minimoAnterior', 'minimoNovo', 'tamanho']);
    });

    test('altera: 200, criado falso e alterado verdadeiro; a auditoria leva o anterior e o novo; atualizado_em avança', async () => {
      const id = await novoMaterial();
      await master.put(url(id, 'M')).send({ minimo: 20 });
      const antes = (await linhas(id))[0].atualizado_em;
      await q('SELECT pg_sleep(0.05)');
      const r = await master.put(url(id, 'M')).send({ minimo: 30 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.criado, r.body.alterado, r.body.overrides], [false, true, [{ tamanho: 'M', minimo: 30 }]]);
      const depois = (await linhas(id))[0];
      assert.equal(depois.minimo, 30);
      assert.ok(depois.atualizado_em > antes);
      const registros = await auditorias('ESTOQUE_MINIMO_DEFINIDO', id);
      assert.deepEqual(registros.map((a) => a.contexto), [
        { materialId: id, tamanho: 'M', minimoAnterior: null, minimoNovo: 20 },
        { materialId: id, tamanho: 'M', minimoAnterior: 20, minimoNovo: 30 },
      ]);
    });

    test('PUT SEM MUDANÇA (M = 20 quando já é 20): 200, alterado falso, a linha não é tocada e NENHUMA auditoria nova', async () => {
      const id = await novoMaterial();
      await master.put(url(id, 'M')).send({ minimo: 20 });
      const antes = (await linhas(id))[0];
      await q('SELECT pg_sleep(0.05)');
      const r = await master.put(url(id, 'M')).send({ minimo: 20 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.criado, r.body.alterado], [false, false]);
      assert.deepEqual((await linhas(id))[0], antes, 'nem o atualizado_em muda');
      assert.equal((await auditorias('ESTOQUE_MINIMO_DEFINIDO', id)).length, 1);
    });

    test('o mínimo zero é um valor próprio: fica gravado como 0 (não remove, não herda), é auditado e muda para outro valor normalmente', async () => {
      const id = await novoMaterial({ estoqueMinimo: 20 });
      const zero = await master.put(url(id, 'G')).send({ minimo: 0 });
      assert.deepEqual([zero.status, zero.body.criado, zero.body.overrides], [201, true, [{ tamanho: 'G', minimo: 0 }]]);
      assert.deepEqual((await linhas(id)).map((l) => [l.tamanho, l.minimo]), [['G', 0]]);
      assert.equal((await auditorias('ESTOQUE_MINIMO_DEFINIDO', id))[0].contexto.minimoNovo, 0);
      const igual = await master.put(url(id, 'G')).send({ minimo: 0 });
      assert.deepEqual([igual.status, igual.body.alterado], [200, false]);
      const muda = await master.put(url(id, 'G')).send({ minimo: 5 });
      assert.deepEqual([muda.body.alterado, (await auditorias('ESTOQUE_MINIMO_DEFINIDO', id))[1].contexto.minimoAnterior], [true, 0]);
    });

    test('o tamanho do caminho é normalizado como o dos lotes (espaços nas pontas) e aceita barra codificada', async () => {
      const id = await novoMaterial();
      const aparado = await master.put(`/api/materiais/${id}/minimos/%20M%20`).send({ minimo: 3 });
      assert.deepEqual([aparado.status, aparado.body.overrides], [201, [{ tamanho: 'M', minimo: 3 }]]);
      const barra = await master.put(url(id, '38/39')).send({ minimo: 4 });
      assert.deepEqual([barra.status, barra.body.overrides.map((o) => o.tamanho)], [201, ['38/39', 'M']]);
    });

    test('material que NÃO exige tamanho: 409 MATERIAL_NAO_EXIGE_TAMANHO; nada gravado, nada auditado', async () => {
      const id = await novoMaterial({ exigeTamanho: false });
      const r = await master.put(url(id, 'M')).send({ minimo: 5 });
      assert.deepEqual([r.status, r.body.codigo], [409, 'MATERIAL_NAO_EXIGE_TAMANHO']);
      assert.deepEqual(await linhas(id), []);
      assert.deepEqual(await auditorias('ESTOQUE_MINIMO_DEFINIDO', id), []);
    });

    test('material ainda não classificado (exige_tamanho nulo): 409 MATERIAL_TAMANHO_NAO_CLASSIFICADO', async () => {
      const id = await novoMaterial({ exigeTamanho: null });
      const r = await master.put(url(id, 'M')).send({ minimo: 5 });
      assert.deepEqual([r.status, r.body.codigo], [409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO']);
      assert.deepEqual(await linhas(id), []);
    });

    test('material inexistente: 404; MULTIEMPRESA: o material de outra empresa também é 404 e nada é criado nela', async () => {
      const deB = await amb.material(amb.d.empresaB, 'Material da B para PUT', { estoqueMinimo: 7 });
      const inexistente = await master.put(url(999997, 'M')).send({ minimo: 5 });
      assert.deepEqual([inexistente.status, inexistente.body.codigo], [404, 'MATERIAL_NAO_ENCONTRADO']);
      const cruzado = await master.put(url(deB, 'M')).send({ minimo: 5 });
      assert.deepEqual([cruzado.status, cruzado.body], [404, inexistente.body]);
      assert.deepEqual(await linhas(deB), []);
      assert.deepEqual(await auditorias('ESTOQUE_MINIMO_DEFINIDO', deB), []);
    });

    test('validação: mínimo negativo, decimal, texto, nulo, ausente, acima do INTEGER e campos que o cliente não manda (empresaId, materialId, tamanho) são 400', async () => {
      const id = await novoMaterial();
      for (const corpo of [{ minimo: -1 }, { minimo: 1.5 }, { minimo: '5' }, { minimo: null }, {}, { minimo: 2147483648 }, { minimo: 5, empresaId: amb.d.empresaB }, { minimo: 5, materialId: 1 }, { minimo: 5, tamanho: 'G' }]) {
        const r = await master.put(url(id, 'M')).send(corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo));
        assert.equal(r.body.codigo, 'VALIDACAO');
        assert.ok(!JSON.stringify(r.body).includes('2147483648') || corpo.minimo !== 2147483648, 'o valor recebido não volta no erro');
      }
      assert.deepEqual(await linhas(id), []);
    });

    test('validação do caminho: tamanho acima de 20 caracteres, só espaços, com quebra de linha; id inválido', async () => {
      const id = await novoMaterial();
      for (const tamanho of ['X'.repeat(21), '%20%20', 'M%0AG']) {
        const r = await master.put(`/api/materiais/${id}/minimos/${tamanho}`).send({ minimo: 1 });
        assert.equal(r.status, 400, tamanho);
      }
      assert.equal((await master.put('/api/materiais/0/minimos/M').send({ minimo: 1 })).status, 400);
      assert.deepEqual(await linhas(id), []);
    });

    test('a empresa do corpo, da query ou do caminho não existe: o ator é sempre o da sessão (a auditoria grava a empresa dele)', async () => {
      const id = await novoMaterial();
      await master.put(`${url(id, 'M')}?empresaId=${amb.d.empresaB}`).send({ minimo: 5 }).then((r) => assert.equal(r.status, 201));
      const [auditoria] = await auditorias('ESTOQUE_MINIMO_DEFINIDO', id);
      assert.equal(auditoria.empresa_id, amb.d.empresaA);
      assert.equal((await q('SELECT empresa_id FROM estoque_minimos WHERE material_id = $1', [id])).rows[0].empresa_id, amb.d.empresaA);
    });
  });

  describe('DELETE /api/materiais/:id/minimos/:tamanho', () => {
    test('remove a LINHA (nunca grava zero): 200, alterado, o tamanho volta ao padrão; auditoria ESTOQUE_MINIMO_REMOVIDO com o anterior e o efetivo depois', async () => {
      const id = await novoMaterial({ estoqueMinimo: 20 });
      await master.put(url(id, 'M')).send({ minimo: 30 });
      const r = await master.delete(url(id, 'M'));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: 'ok', alterado: true, materialId: id, estoqueMinimoPadrao: 20, exigeTamanho: true, overrides: [] });
      assert.deepEqual(await linhas(id), [], 'a linha foi apagada; não ficou nenhuma linha com zero');
      const [auditoria, ...resto] = await auditorias('ESTOQUE_MINIMO_REMOVIDO', id);
      assert.equal(resto.length, 0);
      assert.deepEqual(auditoria.contexto, { materialId: id, tamanho: 'M', minimoAnterior: 30, minimoEfetivoDepois: 20 });
      assert.equal(auditoria.usuario_id, amb.d.master);
    });

    test('remover um zero próprio é remoção: o anterior 0 vai na auditoria e o tamanho volta a herdar o padrão', async () => {
      const id = await novoMaterial({ estoqueMinimo: 20 });
      await master.put(url(id, 'G')).send({ minimo: 0 });
      const r = await master.delete(url(id, 'G'));
      assert.deepEqual([r.status, r.body.alterado, r.body.overrides], [200, true, []]);
      assert.equal((await auditorias('ESTOQUE_MINIMO_REMOVIDO', id))[0].contexto.minimoAnterior, 0);
    });

    test('tamanho sem sobrescrita: 200 com alterado falso, nenhuma auditoria (idempotente)', async () => {
      const id = await novoMaterial();
      const r = await master.delete(url(id, 'M'));
      assert.deepEqual([r.status, r.body.alterado], [200, false]);
      assert.deepEqual(await auditorias('ESTOQUE_MINIMO_REMOVIDO', id), []);
    });

    test('só remove o tamanho pedido; as outras sobrescritas ficam', async () => {
      const id = await novoMaterial();
      await master.put(url(id, 'P')).send({ minimo: 1 });
      await master.put(url(id, 'M')).send({ minimo: 2 });
      await master.delete(url(id, 'P'));
      assert.deepEqual((await linhas(id)).map((l) => [l.tamanho, l.minimo]), [['M', 2]]);
    });

    test('DELETE não tem corpo: qualquer campo é 400, e a sobrescrita continua', async () => {
      const id = await novoMaterial();
      await master.put(url(id, 'M')).send({ minimo: 2 });
      const r = await master.delete(url(id, 'M')).send({ minimo: 0 });
      assert.equal(r.status, 400);
      assert.equal((await linhas(id)).length, 1);
    });

    test('material inexistente e MULTIEMPRESA: 404, e a sobrescrita da outra empresa não é apagada', async () => {
      const deB = await amb.material(amb.d.empresaB, 'Material da B para DELETE', { estoqueMinimo: 7 });
      await q("INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, 'M', 55)", [amb.d.empresaB, deB]);
      assert.equal((await master.delete(url(999996, 'M'))).status, 404);
      const cruzado = await master.delete(url(deB, 'M'));
      assert.deepEqual([cruzado.status, cruzado.body.codigo], [404, 'MATERIAL_NAO_ENCONTRADO']);
      assert.deepEqual((await linhas(deB)).map((l) => l.minimo), [55]);
      assert.deepEqual(await auditorias('ESTOQUE_MINIMO_REMOVIDO', deB), []);
    });
  });

  describe('o mínimo configurado vale na posição (Itens Disponíveis)', () => {
    test('sobrescrita vale no tamanho; os outros herdam o padrão; ao remover, volta ao padrão (PADRAO)', async () => {
      const id = await novoMaterial({ estoqueMinimo: 20 });
      for (const tamanho of ['P', 'M']) await amb.f.estoque(id, 3, { tamanho });
      const minimos = async () => {
        const r = await master.get(`/api/estoque/itens-disponiveis?busca=${encodeURIComponent(`Material de mínimo ${sequencia}`)}&limite=100`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        return Object.fromEntries(r.body.itens.filter((i) => i.materialId === id).map((i) => [i.tamanho, [i.estoqueMinimo, i.minimoOrigem]]));
      };
      assert.deepEqual(await minimos(), { M: [20, 'PADRAO'], P: [20, 'PADRAO'] });
      await master.put(url(id, 'M')).send({ minimo: 5 });
      assert.deepEqual(await minimos(), { M: [5, 'PROPRIO'], P: [20, 'PADRAO'] });
      await master.put(url(id, 'M')).send({ minimo: 0 });
      assert.deepEqual(await minimos(), { M: [0, 'PROPRIO'], P: [20, 'PADRAO'] });
      await master.delete(url(id, 'M'));
      assert.deepEqual(await minimos(), { M: [20, 'PADRAO'], P: [20, 'PADRAO'] });
    });
  });

  describe('RBAC: materials.visualizar lê, materials.editar altera; sem sessão, 401', () => {
    test('sem permissão nenhuma: 403 PERMISSAO_NEGADA nas três rotas, e nada é gravado', async () => {
      const id = await novoMaterial();
      const sem = amb.como(await amb.usuarioCom(amb.d.empresaA, {}));
      for (const [metodo, caminho, corpo] of [['get', url(id)], ['put', url(id, 'M'), { minimo: 5 }], ['delete', url(id, 'M')]]) {
        const r = corpo === undefined ? await sem[metodo](caminho) : await sem[metodo](caminho).send(corpo);
        assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], `${metodo} ${caminho}`);
      }
      assert.deepEqual(await linhas(id), []);
    });

    test('só materials.visualizar: lê (200) mas não define nem remove (403)', async () => {
      const id = await novoMaterial();
      await master.put(url(id, 'M')).send({ minimo: 5 });
      const leitor = amb.como(await amb.usuarioCom(amb.d.empresaA, { materials: ['visualizar'] }));
      assert.equal((await leitor.get(url(id))).status, 200);
      assert.equal((await leitor.put(url(id, 'M')).send({ minimo: 9 })).status, 403);
      assert.equal((await leitor.delete(url(id, 'M'))).status, 403);
      assert.deepEqual((await linhas(id)).map((l) => l.minimo), [5]);
    });

    test('só materials.editar: altera, mas não lê (as permissões de recurso são independentes)', async () => {
      const id = await novoMaterial();
      const editor = amb.como(await amb.usuarioCom(amb.d.empresaA, { materials: ['editar'] }));
      assert.equal((await editor.put(url(id, 'M')).send({ minimo: 6 })).status, 201);
      assert.equal((await editor.get(url(id))).status, 403);
      assert.equal((await editor.delete(url(id, 'M'))).status, 200);
    });

    test('outro recurso não vale: availableItems, operations, epiFicha e dashboard não dão acesso aos mínimos', async () => {
      const id = await novoMaterial();
      const outro = amb.como(await amb.usuarioCom(amb.d.empresaA, {
        availableItems: ['visualizar'], operations: ['visualizar'], epiFicha: ['visualizar'], dashboard: ['visualizar'], stockValidity: ['visualizar'],
      }));
      assert.equal((await outro.get(url(id))).status, 403);
      assert.equal((await outro.put(url(id, 'M')).send({ minimo: 1 })).status, 403);
    });

    test('a ADMINISTRADOR sem exceção individual não herda nada: sem permissão de perfil, 403', async () => {
      const id = await novoMaterial();
      const r = await amb.como(amb.d.sst1).put(url(id, 'M')).send({ minimo: 1 });
      assert.equal(r.status, 403);
    });

    test('sem identificação: 401 nas três rotas (sessão de teste e também o middleware de sessão real, sem cookie)', async () => {
      const id = await novoMaterial();
      assert.equal((await amb.anonimo.get(url(id))).status, 401);
      assert.equal((await amb.anonimo.put(url(id, 'M')).send({ minimo: 1 })).status, 401);
      assert.equal((await amb.anonimo.delete(url(id, 'M'))).status, 401);
      const real = amb.appComSessaoReal();
      assert.equal((await request(real).get(url(id))).status, 401);
      assert.equal((await request(real).put(url(id, 'M')).send({ minimo: 1 })).status, 401);
      assert.equal((await request(real).delete(url(id, 'M'))).status, 401);
    });

    test('usuário inativo não tem sessão: 401', async () => {
      const id = await novoMaterial();
      assert.equal((await amb.como(amb.d.masterInativo).get(url(id))).status, 401);
    });
  });

  describe('verificação de origem: PUT e DELETE são métodos inseguros (a mesma proteção CSRF de app.js)', () => {
    test('sem Origin nem Referer ou com origem de fora: 403; com a origem da lista: passa; GET não exige origem', async () => {
      const id = await novoMaterial();
      const app = amb.appComVerificacaoDeOrigem(['https://app.exemplo.test']);
      const comoMaster = (metodo, caminho) => request(app)[metodo](caminho).set('x-teste-usuario', String(amb.d.master));
      const semOrigem = await comoMaster('put', url(id, 'M')).send({ minimo: 1 });
      assert.deepEqual([semOrigem.status, semOrigem.body.codigo], [403, 'ORIGEM_AUSENTE']);
      const foraDaLista = await comoMaster('put', url(id, 'M')).set('Origin', 'https://invasor.exemplo.test').send({ minimo: 1 });
      assert.deepEqual([foraDaLista.status, foraDaLista.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA']);
      const deleteForaDaLista = await comoMaster('delete', url(id, 'M')).set('Origin', 'https://invasor.exemplo.test');
      assert.equal(deleteForaDaLista.status, 403);
      assert.deepEqual(await linhas(id), []);
      const valida = await comoMaster('put', url(id, 'M')).set('Origin', 'https://app.exemplo.test').send({ minimo: 1 });
      assert.equal(valida.status, 201);
      assert.equal((await comoMaster('get', url(id))).status, 200);
    });
  });

  describe('concorrência', () => {
    test('vários PUTs do mesmo par ao mesmo tempo: um só estado, exatamente uma criação, sem deadlock, e a cadeia de auditoria é consistente', async () => {
      for (let rodada = 1; rodada <= 3; rodada += 1) {
        const id = await novoMaterial();
        const valores = [11, 12, 13, 14, 15, 16];
        const respostas = await Promise.all(valores.map((minimo) => master.put(url(id, 'M')).send({ minimo })));
        for (const r of respostas) assert.ok([200, 201].includes(r.status), `rodada ${rodada}: ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(respostas.filter((r) => r.status === 201).length, 1, `rodada ${rodada}: uma só criação`);
        const final = await linhas(id);
        assert.equal(final.length, 1);
        const registros = await auditorias('ESTOQUE_MINIMO_DEFINIDO', id);
        assert.equal(registros[0].contexto.minimoAnterior, null);
        for (let i = 1; i < registros.length; i += 1) {
          assert.equal(registros[i].contexto.minimoAnterior, registros[i - 1].contexto.minimoNovo, `rodada ${rodada}: a cadeia de auditoria não quebra`);
        }
        assert.equal(registros.at(-1).contexto.minimoNovo, final[0].minimo, 'o último registro é o estado final');
        assert.ok(registros.length >= 1 && registros.length <= valores.length);
      }
    });

    test('PUTs iguais ao mesmo tempo: uma criação, uma única auditoria', async () => {
      const id = await novoMaterial();
      const respostas = await Promise.all([1, 2, 3, 4].map(() => master.put(url(id, 'M')).send({ minimo: 9 })));
      assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 200, 200, 201]);
      assert.equal((await auditorias('ESTOQUE_MINIMO_DEFINIDO', id)).length, 1);
    });

    test('PUT contra a troca de exige_tamanho do cadastro: nunca os dois dão certo, nunca sobra sobrescrita em material sem tamanho, sem 500', async () => {
      for (let rodada = 1; rodada <= 6; rodada += 1) {
        const id = await novoMaterial();
        const [put, patch] = await Promise.all([
          master.put(url(id, 'M')).send({ minimo: 5 }),
          master.patch(`/api/materiais/${id}`).send({ exigeTamanho: false }),
        ]);
        const sucessos = [[201, put.status], [200, patch.status]].filter(([esperado, obtido]) => esperado === obtido).length;
        assert.equal(sucessos, 1, `rodada ${rodada}: PUT ${put.status} ${JSON.stringify(put.body)} / PATCH ${patch.status} ${JSON.stringify(patch.body)}`);
        if (put.status !== 201) assert.deepEqual([put.status, put.body.codigo], [409, 'MATERIAL_NAO_EXIGE_TAMANHO']);
        if (patch.status !== 200) assert.deepEqual([patch.status, patch.body.codigo], [409, 'MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS']);
        const exige = (await q('SELECT exige_tamanho FROM materiais WHERE id = $1', [id])).rows[0].exige_tamanho;
        const quantas = (await linhas(id)).length;
        assert.ok(exige === true || quantas === 0, `rodada ${rodada}: material sem tamanho com sobrescrita`);
      }
    });
  });
});
