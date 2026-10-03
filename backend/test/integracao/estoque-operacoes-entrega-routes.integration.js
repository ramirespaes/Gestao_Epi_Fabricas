'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente } = require('./helpers/ambiente-http-12d2');
const { criarLoteDeEntrada, entregarDireta } = require('./helpers/solicitacao-epi');
const entregaSolicitacaoSvc = require('../../src/services/entrega-solicitacao.service');

/**
 * GET /api/estoque/operacoes com a ENTREGA (12D-2), contra PostgreSQL real. O
 * histórico passa a aceitar o tipo ENTREGA e o filtro `origem` (DIRETA ou
 * SOLICITACAO, que só existe nas linhas de ENTREGA). Quem tem só
 * operations.visualizar vê a linha e a origem; o trabalhador, a ficha e a
 * solicitação exigem também epiFicha.visualizar, e o CPF nunca sai. A contagem
 * é de operações, não de linhas de junção.
 */

const ROTA = '/api/estoque/operacoes';

describe('histórico de operações com ENTREGA — HTTP (PostgreSQL real)', () => {
  let amb;
  let master;
  let masterB;
  let soOperacoes;
  let operacoesEFicha;
  let soFicha;
  const f = {};
  const q = (sql, params) => amb.pool.query(sql, params);

  before(async () => {
    amb = await montarAmbiente();
    const { d } = amb;
    master = amb.como(d.master);
    masterB = amb.como(d.masterB);
    soOperacoes = amb.como(await amb.usuarioCom(d.empresaA, { operations: ['visualizar'] }));
    operacoesEFicha = amb.como(await amb.usuarioCom(d.empresaA, { operations: ['visualizar'], epiFicha: ['visualizar'] }));
    soFicha = amb.como(await amb.usuarioCom(d.empresaA, { epiFicha: ['visualizar'] }));

    const porSolicitacao = (alvo, loteId, quantidade) => entregaSolicitacaoSvc.registrarEntregaPorSolicitacao(amb.pool, {
      empresaId: d.empresaA,
      atorId: d.master,
      solicitacaoId: alvo.id,
      itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade }],
      confirmacao: amb.ACEITE,
      chaveIdempotencia: amb.chaveNova(),
    });

    // Material X1 com um lote; X2 com dois lotes (uma entrega com dois itens).
    f.x1 = await amb.f.material();
    f.x2 = await amb.f.material();
    f.loteX1 = await amb.f.estoque(f.x1, 30);
    f.loteX2a = await amb.f.estoque(f.x2, 5);
    f.loteX2b = await amb.f.estoque(f.x2, 5);
    await amb.f.baixa(f.loteX1, 1, 'AVARIA');
    // DIRETA com dois itens (duas operações ENTREGA na mesma entrega) para o trabalhador 2; outra, do mesmo trabalhador (mesma ficha).
    await amb.f.direta([[f.x2, f.loteX2a, 1], [f.x2, f.loteX2b, 2]]);
    await amb.f.direta([[f.x1, f.loteX1, 1]]);
    // DIRETA para o trabalhador 3 (outra ficha).
    await amb.f.direta([[f.x1, f.loteX1, 2]], { funcionarioId: d.trabalhador3 });
    // Solicitação aprovada de 3 para o trabalhador 1, entregue em duas vezes (duas entregas, uma solicitação).
    f.solicitacao = await amb.f.aprovada({ materialId: f.x1, quantidade: 3 });
    await porSolicitacao(f.solicitacao, f.loteX1, 1);
    await porSolicitacao(f.solicitacao, f.loteX1, 2);
    f.numeroSolicitacao = (await q('SELECT numero FROM solicitacoes_epi WHERE id = $1', [f.solicitacao.id])).rows[0].numero;

    // Empresa B: uma entrega direta de verdade, com o trabalhador e a ficha dela.
    f.loteB = await criarLoteDeEntrada(amb.pool, { empresaId: d.empresaB, materialId: d.botinaB, quantidade: 10, usuarioId: d.masterB });
    await entregarDireta(amb.pool, {
      empresaId: d.empresaB, funcionarioId: d.trabalhadorB, usuarioId: d.masterB, materialId: d.botinaB, loteId: f.loteB, quantidade: 2, cnpj: d.CNPJ_B,
    });
  });
  after(async () => { if (amb) await amb.encerrar(); });

  const listar = async (quem, consulta = '') => {
    const r = await quem.get(`${ROTA}${consulta === '' ? '' : `?${consulta}`}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const entregasNoBanco = async (empresaId) => (await q("SELECT count(*)::int AS n FROM estoque_operacoes WHERE empresa_id = $1 AND tipo = 'ENTREGA'", [empresaId])).rows[0].n;
  const dadosDoTrabalhador = async (id) => (await q('SELECT id, nome, matricula, cpf FROM funcionarios WHERE id = $1', [id])).rows[0];

  describe('a ENTREGA no histórico', () => {
    test('sem filtro, as linhas de ENTREGA aparecem junto com entrada e baixa', async () => {
      const corpo = await listar(master, 'limite=100');
      const tipos = new Set(corpo.operacoes.map((o) => o.tipo));
      assert.ok(['ENTRADA', 'BAIXA', 'ENTREGA'].every((t) => tipos.has(t)), [...tipos].join(','));
      assert.equal(corpo.operacoes.filter((o) => o.tipo === 'ENTREGA').length, await entregasNoBanco(amb.d.empresaA));
    });

    test('tipo=ENTREGA: só as ENTREGAS; cada operação uma única vez, mesmo com várias relações (entrega com 2 itens, ficha com várias entregas, solicitação com 2 entregas)', async () => {
      const corpo = await listar(master, 'tipo=ENTREGA&limite=100');
      const esperadas = await entregasNoBanco(amb.d.empresaA);
      assert.equal(esperadas, 6, 'os 2 itens da primeira DIRETA, a segunda, a do trabalhador 3 e as 2 da solicitação');
      assert.equal(corpo.total, esperadas);
      assert.equal(corpo.operacoes.length, esperadas);
      assert.ok(corpo.operacoes.every((o) => o.tipo === 'ENTREGA'));
      assert.equal(new Set(corpo.operacoes.map((o) => o.operacaoId)).size, esperadas, 'nenhuma operação repetida pelas junções');
      assert.deepEqual(corpo.operacoes.map((o) => o.operacaoId), [...corpo.operacoes.map((o) => o.operacaoId)].sort((a, b) => (BigInt(b) > BigInt(a) ? 1 : -1)), 'mais recente primeiro');
      assert.equal(corpo.paginas, 1);
    });

    test('quem vê a ficha recebe a ficha, o trabalhador (id, nome, matrícula) e a solicitação (só nas entregas por solicitação)', async () => {
      for (const quem of [master, operacoesEFicha]) {
        const corpo = await listar(quem, 'tipo=ENTREGA&limite=100');
        const diretas = corpo.operacoes.filter((o) => o.entrega.origem === 'DIRETA');
        const porSolic = corpo.operacoes.filter((o) => o.entrega.origem === 'SOLICITACAO');
        assert.deepEqual([diretas.length, porSolic.length], [4, 2]);
        for (const o of diretas) assert.equal(o.entrega.solicitacao, null);
        for (const o of porSolic) assert.deepEqual(o.entrega.solicitacao, { id: f.solicitacao.id, numero: f.numeroSolicitacao });
        const dele = await dadosDoTrabalhador(amb.d.trabalhador);
        const ficha = (await q('SELECT id, numero FROM fichas_epi WHERE funcionario_id = $1', [amb.d.trabalhador])).rows[0];
        for (const o of porSolic) {
          assert.deepEqual(o.entrega, {
            origem: 'SOLICITACAO',
            fichaId: ficha.id,
            fichaNumero: ficha.numero,
            trabalhador: { id: dele.id, nome: dele.nome, matricula: dele.matricula },
            solicitacao: { id: f.solicitacao.id, numero: f.numeroSolicitacao },
          });
        }
        const tres = await dadosDoTrabalhador(amb.d.trabalhador3);
        assert.ok(diretas.some((o) => o.entrega.trabalhador.id === tres.id), 'a entrega do trabalhador 3 aparece com a ficha dele');
        assert.equal(new Set(corpo.operacoes.map((o) => o.entrega.fichaId)).size, 3, 'três fichas, três trabalhadores');
      }
    });

    test('NUNCA o CPF: nem a chave nem o número, em nenhuma resposta do histórico, com ou sem a ficha', async () => {
      const cpfs = (await q('SELECT cpf FROM funcionarios WHERE empresa_id = $1', [amb.d.empresaA])).rows.map((r) => r.cpf).filter(Boolean);
      assert.ok(cpfs.length >= 3);
      for (const quem of [master, operacoesEFicha, soOperacoes]) {
        const texto = JSON.stringify((await listar(quem, 'limite=100')).operacoes);
        for (const cpf of cpfs) assert.ok(!texto.includes(cpf), `o CPF ${cpf.slice(0, 3)}... vazou`);
        assert.ok(!/cpf/i.test(texto));
      }
    });

    test('só operations.visualizar: vê a linha de ENTREGA e a origem, e NADA do trabalhador, da ficha ou da solicitação', async () => {
      const corpo = await listar(soOperacoes, 'tipo=ENTREGA&limite=100');
      assert.equal(corpo.total, 6);
      for (const o of corpo.operacoes) assert.deepEqual(Object.keys(o.entrega), ['origem']);
      const texto = JSON.stringify(corpo);
      assert.doesNotMatch(texto, /"(trabalhador|fichaId|fichaNumero|solicitacao)":/, 'nenhuma chave do detalhe sensível (o valor SOLICITACAO da origem é público)');
      for (const id of [amb.d.trabalhador, amb.d.trabalhador2, amb.d.trabalhador3]) {
        const t = await dadosDoTrabalhador(id);
        assert.ok(!texto.includes(t.nome) && !texto.includes(t.matricula), 'nome e matrícula do trabalhador não saem sem epiFicha');
      }
      const semFiltro = await listar(soOperacoes, 'limite=100');
      for (const o of semFiltro.operacoes.filter((x) => x.tipo === 'ENTREGA')) assert.deepEqual(Object.keys(o.entrega), ['origem']);
    });

    test('as linhas que não são ENTREGA não levam bloco de entrega (entrega nula), para todos', async () => {
      for (const quem of [master, soOperacoes]) {
        const corpo = await listar(quem, 'limite=100');
        for (const o of corpo.operacoes.filter((x) => x.tipo !== 'ENTREGA')) assert.equal(o.entrega, null, o.tipo);
      }
    });

    test('o contrato antigo das linhas continua: operação, lote, material, quantidade, responsável', async () => {
      const [linha] = (await listar(master, 'tipo=BAIXA')).operacoes;
      assert.deepEqual(Object.keys(linha).sort(), [
        'caNumero', 'caValidade', 'codigoInterno', 'criadoEm', 'entrega', 'justificativa', 'loteId', 'material', 'materialId', 'motivo', 'operacaoId', 'quantidade', 'responsavel', 'tamanho', 'tipo',
      ]);
      assert.equal(linha.motivo, 'AVARIA');
    });
  });

  describe('filtro origem e tipos', () => {
    test('origem=DIRETA e origem=SOLICITACAO sem tipo: só linhas de ENTREGA daquela origem (as outras operações não têm origem)', async () => {
      const diretas = await listar(master, 'origem=DIRETA&limite=100');
      assert.equal(diretas.total, 4);
      assert.ok(diretas.operacoes.every((o) => o.tipo === 'ENTREGA' && o.entrega.origem === 'DIRETA'));
      const porSolic = await listar(master, 'origem=SOLICITACAO&limite=100');
      assert.equal(porSolic.total, 2);
      assert.ok(porSolic.operacoes.every((o) => o.tipo === 'ENTREGA' && o.entrega.origem === 'SOLICITACAO'));
    });

    test('tipo=ENTREGA com origem: a interseção; o total e a página usam o mesmo filtro', async () => {
      const corpo = await listar(master, 'tipo=ENTREGA&origem=SOLICITACAO&limite=1&pagina=2');
      assert.deepEqual([corpo.total, corpo.paginas, corpo.operacoes.length], [2, 2, 1]);
    });

    test('tipo=BAIXA com origem=DIRETA é válido e devolve conjunto VAZIO (200), não erro; idem ENTRADA e SALDO_INICIAL', async () => {
      for (const tipo of ['BAIXA', 'ENTRADA', 'SALDO_INICIAL']) {
        const corpo = await listar(master, `tipo=${tipo}&origem=DIRETA`);
        assert.deepEqual([corpo.operacoes, corpo.total, corpo.paginas], [[], 0, 0], tipo);
      }
    });

    test('origem e tipo inválidos: 400 VALIDACAO sem devolver o valor', async () => {
      for (const consulta of ['origem=AUTOATENDIMENTO', 'origem=direta', 'origem=', 'tipo=DEVOLUCAO', 'tipo=entrega', 'origem=DIRETA&origem=SOLICITACAO']) {
        const r = await master.get(`${ROTA}?${consulta}`);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], consulta);
        assert.doesNotMatch(JSON.stringify(r.body), /AUTOATENDIMENTO|DEVOLUCAO/);
      }
      for (const consulta of ['pagina=0', 'limite=101', 'limite=0', 'empresaId=2', 'ficha=1']) {
        assert.equal((await master.get(`${ROTA}?${consulta}`)).status, 400, consulta);
      }
    });
  });

  describe('paginação e filtros que já existiam', () => {
    test('página além da última: lista vazia, total correto', async () => {
      const corpo = await listar(master, 'tipo=ENTREGA&limite=4&pagina=9');
      assert.deepEqual([corpo.operacoes, corpo.total, corpo.pagina, corpo.paginas], [[], 6, 9, 2]);
    });

    test('páginas de 4: 4 e 2 linhas, sem repetir nem perder nenhuma', async () => {
      const p1 = await listar(master, 'tipo=ENTREGA&limite=4&pagina=1');
      const p2 = await listar(master, 'tipo=ENTREGA&limite=4&pagina=2');
      assert.deepEqual([p1.operacoes.length, p2.operacoes.length, p1.total, p2.total], [4, 2, 6, 6]);
      assert.equal(new Set([...p1.operacoes, ...p2.operacoes].map((o) => o.operacaoId)).size, 6);
    });

    test('busca pelo nome do material acha as ENTREGAS dele; período futuro não acha nada', async () => {
      const nome = (await q('SELECT nome FROM materiais WHERE id = $1', [f.x2])).rows[0].nome;
      const achou = await listar(master, `tipo=ENTREGA&busca=${encodeURIComponent(nome)}`);
      assert.equal(achou.total, 2);
      assert.ok(achou.operacoes.every((o) => o.materialId === f.x2));
      const futuro = await listar(master, 'tipo=ENTREGA&de=2099-01-01');
      assert.deepEqual([futuro.operacoes, futuro.total], [[], 0]);
    });

    test('o período em dias de São Paulo continua valendo para a ENTREGA', async () => {
      const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
      const corpo = await listar(master, `tipo=ENTREGA&de=${hoje}&ate=${hoje}`);
      assert.equal(corpo.total, 6);
    });
  });

  describe('MULTIEMPRESA', () => {
    test('a empresa A nunca vê a ENTREGA, a ficha nem o trabalhador da B, e a B só vê os dela', async () => {
      const daA = await listar(master, 'tipo=ENTREGA&limite=100');
      const daB = await listar(masterB, 'tipo=ENTREGA&limite=100');
      assert.equal(daB.total, await entregasNoBanco(amb.d.empresaB));
      assert.equal(daB.total, 1);
      const idsA = new Set(daA.operacoes.map((o) => o.operacaoId));
      assert.ok(daB.operacoes.every((o) => !idsA.has(o.operacaoId)));
      // O histórico lê o snapshot da entrega (nome e matrícula como eram no ato), não o cadastro atual.
      const snapshotB = (await q('SELECT trabalhador_nome, trabalhador_matricula FROM entregas_epi WHERE empresa_id = $1', [amb.d.empresaB])).rows[0];
      const trabalhadorB = await dadosDoTrabalhador(amb.d.trabalhadorB);
      assert.deepEqual(daB.operacoes[0].entrega.trabalhador, { id: trabalhadorB.id, nome: snapshotB.trabalhador_nome, matricula: snapshotB.trabalhador_matricula });
      assert.ok(!JSON.stringify(daA).includes(snapshotB.trabalhador_nome), 'o trabalhador da B não vaza para a A');
      for (const o of daA.operacoes) assert.notEqual(o.entrega.trabalhador.id, trabalhadorB.id);
      assert.ok(!JSON.stringify(daB).includes((await dadosDoTrabalhador(amb.d.trabalhador)).nome));
    });

    test('o filtro de origem, de tipo e de busca não atravessa a empresa', async () => {
      const nomeB = (await q('SELECT nome FROM materiais WHERE id = $1', [amb.d.botinaB])).rows[0].nome;
      assert.equal((await listar(master, `busca=${encodeURIComponent(nomeB)}`)).total, 0);
      assert.equal((await listar(masterB, 'origem=SOLICITACAO')).total, 0);
      assert.equal((await listar(masterB, 'origem=DIRETA')).total, 1);
    });
  });

  describe('RBAC', () => {
    test('sem operations.visualizar: 403, mesmo com epiFicha; sem identificação: 401', async () => {
      const r = await soFicha.get(ROTA);
      assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
      const sem = amb.como(await amb.usuarioCom(amb.d.empresaA, {}));
      assert.equal((await sem.get(ROTA)).status, 403);
      assert.equal((await amb.anonimo.get(ROTA)).status, 401);
    });

    test('a permissão de ficha é avaliada a cada requisição: revogada a exceção, o detalhe some', async () => {
      const id = await amb.usuarioCom(amb.d.empresaA, { operations: ['visualizar'], epiFicha: ['visualizar'] });
      const quem = amb.como(id);
      assert.ok((await listar(quem, 'tipo=ENTREGA&limite=1')).operacoes[0].entrega.trabalhador);
      await q("UPDATE usuario_permissoes_recurso SET pode_visualizar = false WHERE usuario_id = $1 AND recurso = 'epiFicha'", [id]);
      assert.deepEqual(Object.keys((await listar(quem, 'tipo=ENTREGA&limite=1')).operacoes[0].entrega), ['origem']);
    });
  });
});
