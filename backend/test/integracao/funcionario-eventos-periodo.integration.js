'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteGhe } = require('./helpers/ambiente-funcionario-ghe');

/**
 * Histórico de Funcionários — pacote H (RED): filtro por PERÍODO nos eventos (GHE, SITUACAO, CADASTRAL).
 *
 * Contrato proposto, igual ao que o sistema já usa nas entregas da ficha (GET /fichas-epi/:id/entregas), em EPIs
 * Entregues e nos relatórios: `de` e `ate` em YYYY-MM-DD (dataCalendario), inclusivos, cada um opcional; inválido →
 * 400 DATA_INVALIDA no campo; de > ate → 400 PERIODO_INVERTIDO em query.ate. Sem os dois, o comportamento atual.
 * O dia de um evento é o dia de criado_em em America/Sao_Paulo (o mesmo de relatorio-auditoria e do data_operacional
 * das entregas): de 00:00:00 do primeiro dia até 23:59:59.999 do último, no fuso real (com o horário de verão antigo).
 * O filtro vale ANTES de contar e paginar: o total é o do período.
 */

describe('H — período nos eventos do funcionário (PostgreSQL real)', () => {
  let amb;
  const ids = {};

  const url = (id, q) => `/api/funcionarios/${id}/eventos?${q}`;
  const get = (usuarioId, id, q) => amb.como(usuarioId).get(url(id, q));
  async function ler(id, q) {
    const r = await get(amb.usuarios.soVisualizar, id, q);
    assert.equal(r.status, 200, `${q}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.eventos), JSON.stringify(r.body));
    return r.body;
  }
  // Nomes gravados em cada evento cadastral, na ordem devolvida (identifica o evento sem depender do id).
  const nomes = (corpo) => corpo.eventos.map((e) => e.alteracoes.find((a) => a.campo === 'nome')?.novo ?? null);
  const auditar = (v) => amb.pool.query(
    `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, contexto, dados_anteriores, dados_novos, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [v.empresaId ?? amb.d.empresaA, v.usuarioId ?? amb.usuarios.master, v.acao, String(v.referencia), v.contexto ?? null, v.anteriores ?? null, v.novos ?? null, v.em],
  );
  const inst = (extra = {}) => ({ matricula: 'P-1', nome: 'Pessoa', grupoHomogeneoId: null, setor: 'S', funcao: 'F', cracha: null, ativo: true, ...extra });
  // Troca de nome: só cadastral (não muda GHE nem situação).
  const trocaDeNome = (referencia, em, nome) => auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia, em, anteriores: inst({ nome: `antes ${nome}` }), novos: inst({ nome }) });

  // Instantes (UTC) e o dia em São Paulo:
  const T = {
    a: '2025-12-31T02:59:59Z', // 30/12/2025 23:59:59
    b: '2025-12-31T03:00:00Z', // 31/12/2025 00:00:00 — primeiro instante do dia
    c: '2026-01-01T02:59:59Z', // 31/12/2025 23:59:59 — último segundo do dia
    d: '2026-01-01T03:00:00Z', // 01/01/2026 00:00:00
    e: '2026-01-02T02:59:59Z', // 01/01/2026 23:59:59
    f: '2026-01-02T03:00:00Z', // 02/01/2026 00:00:00
    g: '2019-01-15T02:30:00Z', // 15/01/2019 00:30 (horário de verão, UTC-2); com -03:00 fixo seria 14/01 23:30
    h: '2026-02-28T12:00:00Z', // 28/02/2026 09:00
    i: '2026-03-01T12:00:00Z', // 01/03/2026 09:00
  };

  before(async () => {
    amb = await montarAmbienteGhe();

    ids.cad = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    for (const k of Object.keys(T)) await trocaDeNome(ids.cad, T[k], k);

    // GHE: três trocas (fora, dentro, fora do período 31/12/2025–01/01/2026) e, dentro, o par do S3 (ALTERADO + GHE_ALTERADO
    // do mesmo instante), que conta UMA vez.
    ids.ghe = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    const G1 = amb.ghes.soldagem;
    const G2 = amb.ghes.caldeiraria;
    const gheAlterado = (em, de, para) => auditar({ acao: 'FUNCIONARIO_GHE_ALTERADO', referencia: ids.ghe, em,
      anteriores: { grupoHomogeneo: { id: de, codigo: 'X', descricao: 'X' } }, novos: { grupoHomogeneo: { id: para, codigo: 'Y', descricao: 'Y' } } });
    await gheAlterado(T.a, G1, G2);
    await gheAlterado(T.f, G1, G2);
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: ids.ghe, em: T.d, anteriores: inst({ grupoHomogeneoId: G2 }), novos: inst({ grupoHomogeneoId: G1 }) });
    await gheAlterado(T.d, G2, G1);

    // Situação: fora, dentro, fora; dentro também o par do S2 (SITUACAO_ALTERADA + INATIVADO legado), que conta UMA vez.
    ids.sit = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    const situacao = (em, de, para) => auditar({ acao: 'FUNCIONARIO_SITUACAO_ALTERADA', referencia: ids.sit, em, anteriores: { situacao: de }, novos: { situacao: para } });
    await situacao(T.a, 'ATIVO', 'AFASTADO');
    await situacao(T.f, 'AFASTADO', 'ATIVO');
    await situacao(T.c, 'ATIVO', 'INATIVO');
    await auditar({ acao: 'FUNCIONARIO_INATIVADO', referencia: ids.sit, em: T.c, anteriores: { ativo: true }, novos: { ativo: false } });

    // Outro funcionário com evento no mesmo período: nunca aparece no do primeiro.
    ids.outro = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    await trocaDeNome(ids.outro, T.d, 'do outro');
  });
  after(async () => { if (amb) await amb.encerrar(); });

  describe('H1 — sem período: comportamento atual preservado', () => {
    test('H1.1 sem de/ate: todos os eventos, total completo, mais recente primeiro', async () => {
      const corpo = await ler(ids.cad, 'tipo=CADASTRAL&pagina=1&limite=20');
      assert.equal(corpo.total, 9);
      assert.deepEqual(nomes(corpo), ['i', 'h', 'f', 'e', 'd', 'c', 'b', 'a', 'g']);
    });
  });

  describe('H2 — intervalo inclusivo por dia em America/Sao_Paulo', () => {
    test('H2.1 virada de ano: 31/12/2025 a 01/01/2026 inclui o primeiro e o último instante dos dois dias e exclui os vizinhos', async () => {
      const corpo = await ler(ids.cad, 'tipo=CADASTRAL&de=2025-12-31&ate=2026-01-01&pagina=1&limite=20');
      assert.deepEqual([corpo.total, nomes(corpo)], [4, ['e', 'd', 'c', 'b']]);
    });

    test('H2.2 um único dia (de = ate)', async () => {
      const corpo = await ler(ids.cad, 'tipo=CADASTRAL&de=2025-12-31&ate=2025-12-31&pagina=1&limite=20');
      assert.deepEqual([corpo.total, nomes(corpo)], [2, ['c', 'b']]);
      const outro = await ler(ids.cad, 'tipo=CADASTRAL&de=2026-01-01&ate=2026-01-01&pagina=1&limite=20');
      assert.deepEqual([outro.total, nomes(outro)], [2, ['e', 'd']]);
    });

    test('H2.3 virada de mês (28/02 a 01/03)', async () => {
      const corpo = await ler(ids.cad, 'tipo=CADASTRAL&de=2026-02-28&ate=2026-03-01&pagina=1&limite=20');
      assert.deepEqual([corpo.total, nomes(corpo)], [2, ['i', 'h']]);
    });

    test('H2.4 fuso real de São Paulo (horário de verão de 2019), nunca um deslocamento fixo', async () => {
      assert.deepEqual(nomes(await ler(ids.cad, 'tipo=CADASTRAL&de=2019-01-15&ate=2019-01-15&pagina=1&limite=20')), ['g']);
      assert.equal((await ler(ids.cad, 'tipo=CADASTRAL&de=2019-01-14&ate=2019-01-14&pagina=1&limite=20')).total, 0);
    });

    test('H2.5 período sem registros: lista vazia e total 0 (resposta válida)', async () => {
      const corpo = await ler(ids.cad, 'tipo=CADASTRAL&de=2024-06-01&ate=2024-06-30&pagina=1&limite=20');
      assert.deepEqual([corpo.eventos, corpo.total, corpo.pagina, corpo.limite], [[], 0, 1, 20]);
    });
  });

  describe('H3 — paginação e total do período', () => {
    test('H3.1 limite 3 no período de 4: páginas 3 + 1 + 0, total 4 em todas, sem repetir nem perder', async () => {
      const p = [];
      for (const pagina of [1, 2, 3]) p.push(await ler(ids.cad, `tipo=CADASTRAL&de=2025-12-31&ate=2026-01-01&pagina=${pagina}&limite=3`));
      assert.deepEqual(p.map((x) => [x.eventos.length, x.total, x.pagina]), [[3, 4, 1], [1, 4, 2], [0, 4, 3]]);
      assert.deepEqual(p.flatMap(nomes), ['e', 'd', 'c', 'b']);
    });
  });

  describe('H4 — os três tipos de evento', () => {
    test('H4.1 GHE: só a troca do período, e o par ALTERADO + GHE_ALTERADO conta uma vez', async () => {
      const todos = await ler(ids.ghe, 'tipo=GHE&pagina=1&limite=20');
      assert.equal(todos.total, 3);
      const corpo = await ler(ids.ghe, 'tipo=GHE&de=2025-12-31&ate=2026-01-01&pagina=1&limite=20');
      assert.equal(corpo.total, 1);
      assert.deepEqual(corpo.eventos.map((e) => [e.tipo, e.anterior?.id, e.novo?.id]), [['ALTERACAO', amb.ghes.caldeiraria, amb.ghes.soldagem]]);
    });

    test('H4.2 SITUAÇÃO: só a mudança do período, e o par SITUACAO_ALTERADA + INATIVADO conta uma vez', async () => {
      const todos = await ler(ids.sit, 'tipo=SITUACAO&pagina=1&limite=20');
      assert.equal(todos.total, 3);
      const corpo = await ler(ids.sit, 'tipo=SITUACAO&de=2025-12-31&ate=2026-01-01&pagina=1&limite=20');
      assert.deepEqual([corpo.total, corpo.eventos.map((e) => [e.anterior, e.novo])], [1, [['ATIVO', 'INATIVO']]]);
    });

    test('H4.3 CADASTRAL: o evento do outro funcionário no mesmo período nunca entra', async () => {
      const corpo = await ler(ids.cad, 'tipo=CADASTRAL&de=2026-01-01&ate=2026-01-01&pagina=1&limite=20');
      assert.equal(nomes(corpo).includes('do outro'), false);
      assert.deepEqual(nomes(await ler(ids.outro, 'tipo=CADASTRAL&de=2026-01-01&ate=2026-01-01&pagina=1&limite=20')), ['do outro']);
    });
  });

  describe('H5 — limites parciais (mesma regra de de/ate das entregas da ficha)', () => {
    test('H5.1 só de: a partir do primeiro instante do dia; só ate: até o último instante do dia', async () => {
      assert.deepEqual(nomes(await ler(ids.cad, 'tipo=CADASTRAL&de=2026-01-02&pagina=1&limite=20')), ['i', 'h', 'f']);
      assert.deepEqual(nomes(await ler(ids.cad, 'tipo=CADASTRAL&ate=2025-12-30&pagina=1&limite=20')), ['a', 'g']);
    });
  });

  describe('H6 — validação estrita', () => {
    const detalhe = async (q) => {
      const r = await get(amb.usuarios.soVisualizar, ids.cad, q);
      assert.equal(r.status, 400, `${q}: ${JSON.stringify(r.body)}`);
      return (r.body.detalhes ?? []).map((x) => [x.campo, x.codigo]);
    };

    test('H6.1 data inexistente, formato errado ou vazio → 400 DATA_INVALIDA no campo', async () => {
      assert.deepEqual(await detalhe('tipo=CADASTRAL&de=2026-02-30&ate=2026-03-01'), [['query.de', 'DATA_INVALIDA']]);
      assert.deepEqual(await detalhe('tipo=CADASTRAL&de=2026-01-01&ate=2026-13-01'), [['query.ate', 'DATA_INVALIDA']]);
      assert.deepEqual(await detalhe('tipo=GHE&de=31/12/2025&ate=2026-01-01'), [['query.de', 'DATA_INVALIDA']]);
      assert.deepEqual(await detalhe('tipo=SITUACAO&de=&ate=2026-01-01'), [['query.de', 'DATA_INVALIDA']]);
      assert.deepEqual(await detalhe('tipo=CADASTRAL&de=2026-01-01T00:00:00Z&ate=2026-01-01'), [['query.de', 'DATA_INVALIDA']]);
    });

    test('H6.2 de posterior a ate → 400 PERIODO_INVERTIDO em query.ate, nos três tipos', async () => {
      for (const tipo of ['GHE', 'SITUACAO', 'CADASTRAL']) {
        assert.deepEqual(await detalhe(`tipo=${tipo}&de=2026-01-02&ate=2026-01-01`), [['query.ate', 'PERIODO_INVERTIDO']], tipo);
      }
    });

    test('H6.3 parâmetros de período com outro nome continuam recusados (consulta estrita)', async () => {
      for (const q of ['tipo=CADASTRAL&dataInicial=2026-01-01', 'tipo=CADASTRAL&dataFinal=2026-01-01', 'tipo=CADASTRAL&inicio=2026-01-01']) {
        assert.equal((await get(amb.usuarios.soVisualizar, ids.cad, q)).status, 400, q);
      }
    });
  });

  describe('H7 — segurança com período', () => {
    const Q = 'tipo=CADASTRAL&de=2025-12-31&ate=2026-01-01&pagina=1&limite=20';

    test('H7.1 o período não amplia a autorização: sem employeeHistory.visualizar 403; sem sessão 401', async () => {
      assert.equal((await get(amb.usuarios.soVisualizar, ids.cad, Q)).status, 200);
      for (const tipo of ['GHE', 'SITUACAO', 'CADASTRAL']) {
        assert.equal((await get(amb.usuarios.semPermissao, ids.cad, `tipo=${tipo}&de=2025-12-31&ate=2026-01-01`)).status, 403, tipo);
      }
      const anonimo = await require('supertest')(amb.app).get(url(ids.cad, Q));
      assert.equal(anonimo.status, 401);
    });

    test('H7.2 inexistente e de outra empresa: o mesmo 404, também com período', async () => {
      const inexistente = await get(amb.usuarios.soVisualizar, 999999, Q);
      const outraEmpresa = await get(amb.usuarios.masterB, ids.cad, Q);
      assert.deepEqual([inexistente.status, inexistente.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      assert.deepEqual([outraEmpresa.status, outraEmpresa.body], [inexistente.status, inexistente.body]);
    });
  });
});
