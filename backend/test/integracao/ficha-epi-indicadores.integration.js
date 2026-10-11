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
 * Histórico de Funcionários — pacote D (RED): indicadores no RESUMO da ficha de EPI (PostgreSQL real, rotas reais).
 *
 * O resumo que GET /fichas-epi e GET /fichas-epi/:id já devolvem (totalEntregas, totalItens, ultimaEntregaEm) ganha:
 *   - episDistintos      = materiais distintos entregues (material_id do item; não conta tipo, tamanho, quantidade
 *                          nem número de entregas; o mesmo id renomeado ou inativo continua o mesmo material);
 *   - episDentroPrazoUso = materiais cuja ENTREGA MAIS RECENTE (entregue_em DESC, entrega DESC, item DESC) tem
 *                          data_operacional + prazo de uso congelado >= hoje; o dia do vencimento ainda conta.
 * "Hoje" é o dia operacional de São Paulo do banco, o mesmo de EPIs Entregues (entrega-epi-historico.repository).
 * Histórico total da ficha, sem período. As datas das fixtures são relativas ao dia operacional da execução.
 */
const HOJE = dataOperacional();
const ha = (dias) => {
  const d = new Date(`${HOJE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
};
const instante = (dia, hora = '12:00:00') => `${dia}T${hora}-03:00`;
const iso = (dia, hora = '12:00:00') => new Date(instante(dia, hora)).toISOString();

describe('Histórico de Funcionários — D: indicadores no resumo da ficha (PostgreSQL real)', () => {
  let g;
  let master;
  let leitor;
  const fichas = {};
  const funcionarios = {};

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarEntregaEpiRoutes({ controller: criarEntregaEpiController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    const A = g.empresas.A;
    master = await g.contaDaEmpresa(A);

    let seq = 0;
    const novoFuncionario = async (chave) => {
      seq += 1;
      funcionarios[chave] = await criarFuncionario(g.pool, A, { matricula: `D-${seq}`, cpf: g.cpfFicticio(9100 + seq) });
      fichas[chave] = (await criarFicha(g.pool, A, funcionarios[chave])).id;
    };
    const material = (nome, prazo, extra = {}) => criarMaterial(g.pool, A, nome, { prazo, ...extra });
    const lote = (materialId, tamanho = '40') => criarLote(g.pool, { empresaId: A, materialId, quantidade: 10000, tamanho });
    /** Uma entrega (um ato) com os itens dados; cada item: { m: {id, lote, nome}, prazo, quantidade?, nome? }. */
    const entregar = (chave, dia, itens, hora) => registrarEntrega(g.pool, {
      usuarioId: master.usuarioId,
      entrega: {
        empresa_id: A, ficha_id: fichas[chave], responsavel_id: master.usuarioId, data_operacional: dia, entregue_em: instante(dia, hora),
      },
      itens: itens.map((i) => ({
        material_id: i.m.id, lote_id: i.lote ?? i.m.lote, material_nome: i.nome ?? i.m.nome, material_prazo_uso_dias: i.prazo, quantidade: i.quantidade ?? 1,
      })),
    });
    const mat = async (nome, prazo, extra) => { const id = await material(nome, prazo, extra); return { id, nome, lote: await lote(id) }; };

    const luvaA = await mat('Luva A', 90);
    const oculosB = await mat('Óculos B', 365);
    const sapatao = await mat('Sapatão de segurança', 180);
    const creme = await mat('Creme de proteção', 30);
    const capacete = await mat('Capacete', 365);

    // CASO A — uma entrega: Luva A × 3, prazo 90, entregue há 10 dias (dentro do prazo).
    await novoFuncionario('casoA');
    await entregar('casoA', ha(10), [{ m: luvaA, prazo: 90, quantidade: 3 }]);

    // CASO B — Luva A antiga (180 dias, ainda válida) e Luva A mais recente (20 dias, já vencida).
    await novoFuncionario('casoB');
    await entregar('casoB', ha(30), [{ m: luvaA, prazo: 180 }]);
    await entregar('casoB', ha(25), [{ m: luvaA, prazo: 20 }]);

    // CASO C — uma entrega com Luva A e Óculos B.
    await novoFuncionario('casoC');
    await entregar('casoC', ha(5), [{ m: luvaA, prazo: 90 }, { m: oculosB, prazo: 365 }]);

    // CASO D — Sapatão × 10 na mesma entrega, hoje.
    await novoFuncionario('casoD');
    await entregar('casoD', HOJE, [{ m: sapatao, prazo: 180, quantidade: 10 }]);

    // CASO E — validade de uso termina HOJE (conta) e outra que terminou ONTEM (não conta).
    await novoFuncionario('casoE');
    await entregar('casoE', ha(30), [{ m: creme, prazo: 30 }]);
    await entregar('casoE', ha(31), [{ m: capacete, prazo: 30 }]);

    // CASO F — ficha sem nenhuma entrega.
    await novoFuncionario('casoF');

    // Reentrega inversa ao CASO B: a antiga venceu, a mais recente está válida → conta.
    await novoFuncionario('reentregaValida');
    await entregar('reentregaValida', ha(200), [{ m: luvaA, prazo: 30 }]);
    await entregar('reentregaValida', ha(3), [{ m: luvaA, prazo: 90 }]);

    // Desempate no mesmo instante: a entrega de id maior é a mais recente (válida antes, vencida depois → não conta).
    await novoFuncionario('mesmoInstante');
    await entregar('mesmoInstante', ha(40), [{ m: luvaA, prazo: 365 }], '09:00:00');
    await entregar('mesmoInstante', ha(40), [{ m: luvaA, prazo: 10 }], '09:00:00');

    // Desempate defensivo no mesmo ato: dois itens do mesmo material (lotes diferentes); vale o item de id maior.
    await novoFuncionario('mesmoAto');
    const luvaA42 = await lote(luvaA.id, '42');
    await entregar('mesmoAto', ha(15), [{ m: luvaA, prazo: 365 }, { m: luvaA, lote: luvaA42, prazo: 10 }]);

    // Identidade = material_id: tamanhos diferentes, nome congelado diferente (renomeado) e material hoje inativo.
    await novoFuncionario('identidade');
    const sapatao44 = await lote(sapatao.id, '44');
    await entregar('identidade', ha(60), [{ m: sapatao, prazo: 180, nome: 'Sapatão antigo' }]);
    await entregar('identidade', ha(20), [{ m: sapatao, lote: sapatao44, prazo: 180 }]);
    const homonimo = await mat('Sapatão de segurança', 180); // outro material com o MESMO nome: é outro EPI
    await entregar('identidade', ha(2), [{ m: homonimo, prazo: 180 }]);
    await g.pool.query('UPDATE materiais SET ativo = false, nome = $2 WHERE id = $1', [sapatao.id, 'Sapatão (renomeado)']);

    leitor = await g.usuarioPronto(master);
    const r = await g.request(g.app).put(`/api/administracao/usuarios/${leitor.id}/acessos/fichaEpi`).set('Cookie', g.cookie(master)).send({ ligado: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  after(async () => { if (g) await g.encerrar(); });

  let cookieLeitor = null;
  const como = async () => {
    if (!cookieLeitor) cookieLeitor = g.deCookies(g.cookiesDe(await g.login(leitor.email, g.SENHA_PROVISORIA)));
    return cookieLeitor;
  };
  /** Resumo pela MESMA consulta que a tela usa (GET /fichas-epi?funcionarioId=). */
  async function resumoDaLista(chave) {
    const r = await g.request(g.app).get(`/api/fichas-epi?funcionarioId=${funcionarios[chave]}&pagina=1&limite=1`).set('Cookie', await como());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.fichas.length, 1, chave);
    assert.equal(r.body.fichas[0].id, fichas[chave]);
    return r.body.fichas[0].resumo;
  }
  const indicadores = (r) => ({
    totalEntregas: r.totalEntregas, ultimaEntregaEm: r.ultimaEntregaEm, episDistintos: r.episDistintos, episDentroPrazoUso: r.episDentroPrazoUso,
  });

  test('D-B1 CASO A: uma entrega com Luva A × 3 → 1 retirada, 1 EPI distinto, 1 dentro do prazo', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('casoA')), { totalEntregas: 1, ultimaEntregaEm: iso(ha(10)), episDistintos: 1, episDentroPrazoUso: 1 });
  });

  test('D-B2 CASO B: duas entregas do mesmo material, a mais recente vencida → 2 retiradas, 1 distinto, 0 dentro do prazo', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('casoB')), { totalEntregas: 2, ultimaEntregaEm: iso(ha(25)), episDistintos: 1, episDentroPrazoUso: 0 });
  });

  test('D-B3 CASO C: uma entrega com dois materiais → 1 retirada, 2 distintos', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('casoC')), { totalEntregas: 1, ultimaEntregaEm: iso(ha(5)), episDistintos: 2, episDentroPrazoUso: 2 });
  });

  test('D-B4 CASO D: Sapatão × 10 na mesma entrega → 1 retirada, 1 distinto, 1 dentro do prazo (quantidade não soma)', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('casoD')), { totalEntregas: 1, ultimaEntregaEm: iso(HOJE), episDistintos: 1, episDentroPrazoUso: 1 });
  });

  test('D-B5 CASO E: validade de uso terminando hoje ainda conta; terminada ontem não conta', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('casoE')), { totalEntregas: 2, ultimaEntregaEm: iso(ha(30)), episDistintos: 2, episDentroPrazoUso: 1 });
  });

  test('D-B6 CASO F: ficha sem entregas → 0 retiradas, 0 distintos, sem última retirada, 0 dentro do prazo', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('casoF')), { totalEntregas: 0, ultimaEntregaEm: null, episDistintos: 0, episDentroPrazoUso: 0 });
  });

  test('D-B7 reentrega: a antiga vencida não impede; a mais recente válida conta uma vez', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('reentregaValida')), { totalEntregas: 2, ultimaEntregaEm: iso(ha(3)), episDistintos: 1, episDentroPrazoUso: 1 });
  });

  test('D-B8 desempate no mesmo instante: vale a entrega de id maior (vencida) → 0 dentro do prazo', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('mesmoInstante')), { totalEntregas: 2, ultimaEntregaEm: iso(ha(40), '09:00:00'), episDistintos: 1, episDentroPrazoUso: 0 });
  });

  test('D-B9 desempate no mesmo ato: dois itens do mesmo material, vale o item de id maior (vencido) → 0; ainda 1 distinto', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('mesmoAto')), { totalEntregas: 1, ultimaEntregaEm: iso(ha(15)), episDistintos: 1, episDentroPrazoUso: 0 });
  });

  test('D-B10 identidade pelo material_id: tamanho e nome congelado diferentes e material hoje inativo e renomeado são o mesmo EPI; homônimo é outro', async () => {
    assert.deepEqual(indicadores(await resumoDaLista('identidade')), { totalEntregas: 3, ultimaEntregaEm: iso(ha(2)), episDistintos: 2, episDentroPrazoUso: 2 });
  });

  test('D-B11 o detalhe GET /fichas-epi/:id devolve o MESMO resumo da lista', async () => {
    const lista = await resumoDaLista('casoB');
    const r = await g.request(g.app).get(`/api/fichas-epi/${fichas.casoB}`).set('Cookie', await como());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.resumo, lista);
    assert.equal(typeof r.body.resumo.episDistintos, 'number');
    assert.equal(typeof r.body.resumo.episDentroPrazoUso, 'number');
  });

  test('D-B12 os indicadores são inteiros não negativos em todas as fichas da empresa (sem nulo, sem texto)', async () => {
    const r = await g.request(g.app).get('/api/fichas-epi?pagina=1&limite=100').set('Cookie', await como());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.fichas.length >= 10);
    for (const f of r.body.fichas) {
      for (const campo of ['totalEntregas', 'episDistintos', 'episDentroPrazoUso']) {
        assert.ok(Number.isInteger(f.resumo[campo]) && f.resumo[campo] >= 0, `ficha ${f.id}: ${campo}=${f.resumo[campo]}`);
      }
      assert.ok(f.resumo.episDentroPrazoUso <= f.resumo.episDistintos, `ficha ${f.id}: dentro do prazo <= distintos`);
    }
  });
});
