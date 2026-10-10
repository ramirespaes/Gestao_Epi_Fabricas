'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const {
  criarFuncionario, criarMaterial, criarLote, criarFicha, registrarEntrega,
} = require('./helpers/entrega-epi');
const { criarRelatorioController } = require('../../src/controllers/relatorio.controller');
const { criarRelatorioRoutes } = require('../../src/routes/relatorio.routes');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Relatórios da 12K-D (Estoque, Próximo do vencimento, Itens vencidos e EPIs entregues), contra PostgreSQL real e as
 * rotas reais de produção (autorização por recurso antes de validar e consultar).
 */
const HOJE = dataOperacional();
const deslocar = (dias) => {
  const d = new Date(`${HOJE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
const BASE = '/api/relatorios';

describe('Relatórios 12K-D (PostgreSQL real)', () => {
  let g;
  let master;
  let comFicha;
  let comMaterial;
  let semNada;
  const e = {};
  const m = {};

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarRelatorioRoutes({ controller: criarRelatorioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    master = await g.contaDaEmpresa(g.empresas.A);
    const A = g.empresas.A;
    const B = g.empresas.B;
    const masterB = await g.contaDaEmpresa(B);

    // ── Estoque ─────────────────────────────────────────────────────────────────────────────────
    const material = async (nome, minimo, opcoes = {}) => {
      const id = await criarMaterial(g.pool, A, nome, { tipo: 'Luva', ...opcoes });
      await g.pool.query('UPDATE materiais SET estoque_minimo = $1 WHERE id = $2', [minimo, id]);
      return id;
    };
    m.botina = await material('Botina Técnica', 10, { tipo: 'Botina de Segurança' });
    await criarLote(g.pool, { empresaId: A, materialId: m.botina, quantidade: 8, caNumero: '111', caValidade: '2099-01-01' });
    await criarLote(g.pool, { empresaId: A, materialId: m.botina, quantidade: 5, caNumero: '111', caValidade: '2099-01-01' });
    m.luva = await material('Luva Nitrílica', 20);
    await criarLote(g.pool, { empresaId: A, materialId: m.luva, quantidade: 12, caNumero: '222', caValidade: '2099-01-01' });
    m.capacete = await material('Capacete Classe B', 0, { tipo: 'Capacete' });
    m.oculos = await material('Óculos Visão', 5, { tipo: 'Óculos de Proteção Incolor' });
    await criarLote(g.pool, { empresaId: A, materialId: m.oculos, quantidade: 50, caNumero: '333', caValidade: '2020-01-01' });
    m.protetor = await material('Protetor Auricular', 1, { tipo: 'Proteção Auricular Concha' });
    await criarLote(g.pool, { empresaId: A, materialId: m.protetor, quantidade: 9, caNumero: null, caValidade: null });
    m.creme = await material('Creme de Proteção', 0, { exigeCa: false, tipo: 'Creme de Proteção' });
    await criarLote(g.pool, { empresaId: A, materialId: m.creme, quantidade: 3, caNumero: null, caValidade: null });
    m.respirador = await material('Respirador PFF2', 0, { tipo: 'Respirador PFF2' });
    await criarLote(g.pool, { empresaId: A, materialId: m.respirador, quantidade: 7, caNumero: '444', caValidade: deslocar(10) });
    m.inativo = await material('Material Inativo', 0, { ativo: false });
    await criarLote(g.pool, { empresaId: A, materialId: m.inativo, quantidade: 99, caNumero: '555', caValidade: '2099-01-01' });
    const matB = await criarMaterial(g.pool, B, 'Material da Outra Empresa');
    await criarLote(g.pool, { empresaId: B, materialId: matB, quantidade: 77 });

    // ── Entregas ────────────────────────────────────────────────────────────────────────────────
    const ana = await criarFuncionario(g.pool, A, { matricula: 'M-001', cpf: '52998224725', setor: 'Produção' });
    const joao = await criarFuncionario(g.pool, A, { matricula: 'M-002', cpf: '11144477735', setor: 'Manutenção' });
    await g.pool.query("UPDATE funcionarios SET nome = 'Ana Sapateira' WHERE id = $1", [ana]);
    await g.pool.query("UPDATE funcionarios SET nome = 'João Álvares' WHERE id = $1", [joao]);
    const fichaAna = (await criarFicha(g.pool, A, ana)).id;
    const fichaJoao = (await criarFicha(g.pool, A, joao)).id;
    const sapato = await criarMaterial(g.pool, A, 'Sapatão de segurança', { tipo: 'Sapato de Segurança', prazo: 180 });
    const luvaE = await criarMaterial(g.pool, A, 'Luva de raspa', { tipo: 'Luva', prazo: 30 });
    const oculosE = await criarMaterial(g.pool, A, 'Óculos de proteção', { tipo: 'Óculos de Proteção Incolor', prazo: 365 });
    const lote = (id) => criarLote(g.pool, { empresaId: A, materialId: id, quantidade: 1000, caNumero: '9999' });
    const lotes = { sapato: await lote(sapato), luva: await lote(luvaE), oculos: await lote(oculosE) };
    const mats = { sapato, luva: luvaE, oculos: oculosE };
    const nomes = { sapato: ['Sapatão de segurança', 'Sapato de Segurança'], luva: ['Luva de raspa', 'Luva'], oculos: ['Óculos de proteção', 'Óculos de Proteção Incolor'] };
    const pessoas = {
      ana: [fichaAna, 'Ana Sapateira', 'M-001', 'Produção'],
      joao: [fichaJoao, 'João Álvares', 'M-002', 'Manutenção'],
    };
    // [chave, pessoa, material, prazo, dias atrás] → dias restantes = prazo - dias atrás
    const entregas = [
      ['d30', 'ana', 'sapato', 180, 150],
      ['d21', 'ana', 'luva', 30, 9],
      ['d20', 'ana', 'luva', 30, 10],
      ['d11', 'joao', 'luva', 30, 19],
      ['d10', 'joao', 'luva', 30, 20],
      ['d0', 'joao', 'luva', 30, 30],
      ['dNeg1', 'ana', 'luva', 30, 31],
      ['dNeg20', 'ana', 'sapato', 180, 200],
      ['d31', 'joao', 'sapato', 180, 149],
      ['d365', 'joao', 'oculos', 365, 0],
    ];
    for (const [chave, pessoa, mat, prazo, atras] of entregas) {
      const [ficha, nome, matricula, setor] = pessoas[pessoa];
      const dia = deslocar(-atras);
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
      e[chave] = r.itens[0].id;
    }
    const funcB = await criarFuncionario(g.pool, B, { matricula: 'B-001', cpf: '98765432100', setor: 'Produção' });
    const fichaB = (await criarFicha(g.pool, B, funcB)).id;
    const matEntB = await criarMaterial(g.pool, B, 'Luva da B', { tipo: 'Luva', prazo: 30 });
    const loteB = await criarLote(g.pool, { empresaId: B, materialId: matEntB, quantidade: 100 });
    const diaB = deslocar(-20);
    await registrarEntrega(g.pool, {
      usuarioId: masterB.usuarioId,
      entrega: {
        empresa_id: B, ficha_id: fichaB, responsavel_id: masterB.usuarioId, data_operacional: diaB, entregue_em: `${diaB}T12:00:00-03:00`,
        trabalhador_nome: 'Fulano da B', trabalhador_matricula: 'B-001', trabalhador_setor: 'Produção',
      },
      itens: [{ material_id: matEntB, lote_id: loteB, material_nome: 'Luva da B', material_tipo: 'Luva', material_prazo_uso_dias: 30 }],
    });

    const liga = async (u, toggle) => g.request(g.app).put(`/api/administracao/usuarios/${u.id}/acessos/${toggle}`).set('Cookie', g.cookie(master)).send({ ligado: true });
    comFicha = await g.usuarioPronto(master);
    await liga(comFicha, 'fichaEpi');
    comMaterial = await g.usuarioPronto(master);
    await liga(comMaterial, 'cadastrarProduto');
    semNada = await g.usuarioPronto(master);
  });
  after(async () => { if (g) await g.encerrar(); });

  const como = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const ler = async (rota, u, q = '') => g.request(g.app).get(`${BASE}/${rota}${q}`).set('Cookie', await como(u));
  const estoque = (q = '') => ler('estoque', comMaterial, q);
  const proximo = (q = '') => ler('proximo-vencimento', comFicha, q);
  const vencidos = (q = '') => ler('vencidos', comFicha, q);
  const entregues = (q = '') => ler('epis-entregues', comFicha, q);
  const ids = (r) => r.body.itens.map((i) => i.itemId);

  describe('D1 — Estoque', () => {
    test('indicadores por MATERIAL ativo, com saldo utilizável (CA ausente ou vencido não conta como disponível)', async () => {
      const r = await estoque('?limite=100');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      // ativos: os sete do estoque + os três das entregas (lotes de 1000, CA válido) = 10; o inativo e o da outra empresa ficam fora.
      assert.deepEqual(r.body.indicadores, { itensCadastrados: 10, comEstoqueDisponivel: 7, emAlerta: 4 });
    });

    test('cada entrada/lote é uma linha independente; o mesmo material e CA não se consolidam; quantidade original e saldo do lote', async () => {
      const r = await estoque('?limite=100&busca=botina');
      assert.equal(r.body.total, 2);
      assert.deepEqual(r.body.linhas.map((l) => l.quantidadeEntrada).sort(), [5, 8]);
      assert.ok(r.body.linhas.every((l) => l.ca.numero === '111' && l.disponivelNoLote === l.quantidadeEntrada));
      assert.ok(r.body.linhas.every((l) => l.saldoTotalMaterial === 13 && l.estoqueMinimo === 10 && l.status === 'DISPONIVEL'), 'status pelo saldo TOTAL do material');
    });

    test('reposição pelo saldo total do material: no mínimo ou abaixo é EM_ALERTA; saldo zero é SEM_ESTOQUE', async () => {
      const luva = (await estoque('?busca=nitrilica')).body.linhas[0];
      assert.deepEqual([luva.status, luva.saldoTotalMaterial, luva.estoqueMinimo], ['EM_ALERTA', 12, 20]);
    });

    test('CA vencido ou ausente (material que exige CA): saldo físico existe, disponível é zero e o status é SEM_ESTOQUE', async () => {
      const oculos = (await estoque('?busca=visao')).body.linhas[0];
      assert.deepEqual([oculos.quantidadeEntrada, oculos.saldoFisicoNoLote, oculos.disponivelNoLote, oculos.status], [50, 50, 0, 'SEM_ESTOQUE']);
      const protetor = (await estoque('?busca=protetor')).body.linhas[0];
      assert.deepEqual([protetor.saldoFisicoNoLote, protetor.disponivelNoLote, protetor.status], [9, 0, 'SEM_ESTOQUE']);
    });

    test('material que dispensa CA nunca é bloqueado por CA', async () => {
      const creme = (await estoque('?busca=creme')).body.linhas[0];
      assert.deepEqual([creme.disponivelNoLote, creme.status], [3, 'DISPONIVEL']);
    });

    test('alertas: sem estoque, abaixo do mínimo, CA vencido, CA ausente e CA próximo do vencimento (regra oficial de 60 dias)', async () => {
      const r = await estoque('?limite=1');
      const por = (tipo) => r.body.alertas.filter((a) => a.tipo === tipo).map((a) => a.material).sort();
      assert.deepEqual(por('SEM_ESTOQUE'), ['Capacete Classe B', 'Protetor Auricular', 'Óculos Visão']);
      assert.deepEqual(por('ABAIXO_MINIMO'), ['Luva Nitrílica']);
      assert.deepEqual(por('CA_VENCIDO'), ['Óculos Visão']);
      assert.deepEqual(por('CA_AUSENTE'), ['Protetor Auricular']);
      assert.deepEqual(por('CA_PROXIMO'), ['Respirador PFF2']);
      assert.equal(r.body.diasAlertaCa, 60);
    });

    test('isolamento: nada da outra empresa nem de material inativo', async () => {
      const r = await estoque('?limite=100');
      const nomes = r.body.linhas.map((l) => l.material);
      assert.equal(nomes.includes('Material da Outra Empresa'), false);
      assert.equal(nomes.includes('Material Inativo'), false);
      assert.equal(r.body.total, 10, 'botina 2 + luva + óculos + protetor + creme + respirador + 3 das entregas');
    });

    test('filtro de status, busca sem acento, ordenação e paginação cobrindo todas as linhas', async () => {
      assert.equal((await estoque('?status=SEM_ESTOQUE&limite=100')).body.total, 2);
      assert.equal((await estoque('?busca=OCULOS')).body.total, 2, 'sem diferenciar maiúsculas nem acentos');
      const desc = (await estoque('?ordem=quantidadeEntrada&direcao=desc&limite=100')).body.linhas.map((l) => l.quantidadeEntrada);
      assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
      const paginas = [];
      for (let p = 1; p <= 5; p += 1) paginas.push(...(await estoque(`?limite=2&pagina=${p}`)).body.linhas.map((l) => l.loteId));
      assert.equal(new Set(paginas).size, 10, 'a exportação paginada alcança todas as linhas, sem repetir');
    });
  });

  describe('D2 — Próximo do vencimento', () => {
    test('0 a 30 dias, mais crítico primeiro; -1 e 31 não pertencem; faixas e status', async () => {
      const r = await proximo('?limite=100');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(ids(r), [e.d0, e.d10, e.d11, e.d20, e.d21, e.d30]);
      assert.deepEqual(r.body.itens.map((i) => i.diasRestantes), [0, 10, 11, 20, 21, 30]);
      assert.deepEqual(r.body.itens.map((i) => i.status), ['TROCAR_URGENTE', 'TROCAR_URGENTE', 'ATENCAO', 'ATENCAO', 'PROXIMO', 'PROXIMO']);
      for (const fora of [e.dNeg1, e.dNeg20, e.d31, e.d365]) assert.equal(ids(r).includes(fora), false);
    });

    test('filtro de faixa', async () => {
      assert.deepEqual(ids(await proximo('?faixa=0-10')), [e.d0, e.d10]);
      assert.deepEqual(ids(await proximo('?faixa=11-20')), [e.d11, e.d20]);
      assert.deepEqual(ids(await proximo('?faixa=21-30')), [e.d21, e.d30]);
    });

    test('filtros de funcionário (nome ou matrícula), setor e EPI; ordenação pelos cabeçalhos', async () => {
      assert.deepEqual(ids(await proximo('?funcionario=M-002')), [e.d0, e.d10, e.d11]);
      assert.deepEqual(ids(await proximo('?funcionario=alvares')), [e.d0, e.d10, e.d11]);
      assert.deepEqual(ids(await proximo('?setor=producao')), [e.d20, e.d21, e.d30]);
      assert.deepEqual(ids(await proximo('?item=sapato')), [e.d30]);
      assert.deepEqual(ids(await proximo('?ordem=dias&direcao=desc')), [e.d30, e.d21, e.d20, e.d11, e.d10, e.d0]);
      const porNome = (await proximo('?ordem=funcionario&direcao=asc')).body.itens.map((i) => i.trabalhador.nome);
      assert.deepEqual(porNome, [...porNome].sort((a, b) => a.localeCompare(b, 'pt-BR')));
    });

    test('multiempresa: a entrega da outra empresa nunca aparece', async () => {
      assert.equal((await proximo('?limite=100')).body.itens.some((i) => i.trabalhador.nome === 'Fulano da B'), false);
    });
  });

  describe('D3 — Itens vencidos', () => {
    test('só dias < 0, mais vencido primeiro, com dias vencidos e status', async () => {
      const r = await vencidos('?limite=100');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(ids(r), [e.dNeg20, e.dNeg1]);
      assert.deepEqual(r.body.itens.map((i) => i.diasVencidos), [20, 1]);
      assert.ok(r.body.itens.every((i) => i.status === 'TROCA_URGENTE'));
      assert.equal(ids(r).includes(e.d0), false, 'vence hoje ainda não é vencido');
    });

    test('filtros e ordenação; sem vínculo de substituição, nenhum item é excluído por heurística', async () => {
      assert.deepEqual(ids(await vencidos('?item=luva')), [e.dNeg1]);
      assert.deepEqual(ids(await vencidos('?setor=manutencao')), []);
      assert.deepEqual(ids(await vencidos('?funcionario=ana&ordem=dias&direcao=desc')), [e.dNeg1, e.dNeg20]);
    });

    test('multiempresa', async () => {
      assert.equal((await vencidos('?limite=100')).body.total, 2);
    });
  });

  describe('D4 — EPIs entregues', () => {
    test('histórico real, cada entrega uma linha, com funcionário, setor, CA, quantidade, data e responsável', async () => {
      const r = await entregues('?limite=100');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.total, 10, 'sem filtro de validade; a da outra empresa não entra');
      const linha = r.body.itens.find((i) => i.itemId === e.d30);
      assert.equal(linha.trabalhador.nome, 'Ana Sapateira');
      assert.equal(linha.trabalhador.setor, 'Produção');
      assert.equal(linha.ca.numero, '9999');
      assert.equal(linha.quantidade, 1);
      assert.equal(linha.dataEntrega, deslocar(-150));
      assert.equal(linha.responsavel.nome, 'Responsável Real');
      const datas = r.body.itens.map((i) => i.dataEntrega);
      assert.deepEqual(datas, [...datas].sort().reverse(), 'mais recente primeiro por padrão');
    });

    test('filtros de período, funcionário, setor e EPI', async () => {
      assert.deepEqual(ids(await entregues(`?de=${deslocar(-10)}&ate=${deslocar(-9)}`)).sort(), [e.d20, e.d21].sort());
      assert.equal((await entregues('?funcionario=M-001&limite=100')).body.total, 5);
      assert.equal((await entregues('?setor=manutencao&limite=100')).body.total, 5);
      assert.equal((await entregues('?item=oculos')).body.total, 1);
      assert.equal((await entregues(`?de=${deslocar(1)}`)).body.total, 0);
    });

    test('ordenação por cabeçalho e paginação alcançando todas as linhas (base da exportação completa)', async () => {
      const asc = (await entregues('?ordem=dataEntrega&direcao=asc&limite=100')).body.itens.map((i) => i.dataEntrega);
      assert.deepEqual(asc, [...asc].sort());
      const todos = [];
      for (let p = 1; p <= 5; p += 1) todos.push(...ids(await entregues(`?limite=2&pagina=${p}`)));
      assert.equal(new Set(todos).size, 10);
    });

    test('nenhum dado sensível: sem CPF, hash ou campos técnicos', async () => {
      const texto = JSON.stringify((await entregues('?limite=100')).body);
      for (const proibido of ['52998224725', '11144477735', 'hash', 'cpf']) assert.equal(texto.toLowerCase().includes(proibido), false, proibido);
    });
  });

  describe('autorização e validação', () => {
    test('sem sessão 401; sem a permissão da fonte 403, cada relatório com a sua autoridade', async () => {
      assert.equal((await g.request(g.app).get(`${BASE}/estoque`)).status, 401);
      assert.equal((await ler('estoque', semNada)).status, 403);
      assert.equal((await ler('proximo-vencimento', semNada)).status, 403);
      assert.equal((await ler('estoque', comFicha)).status, 403, 'a ficha não abre o estoque');
      for (const rota of ['proximo-vencimento', 'vencidos', 'epis-entregues']) assert.equal((await ler(rota, comMaterial)).status, 403, 'o estoque não abre as entregas');
    });

    test('consulta estrita: filtro desconhecido, ordenação fora da lista, faixa e período inválidos são 400', async () => {
      for (const q of ['?empresaId=2', '?ordem=senha_hash', '?direcao=sideways', '?limite=101']) {
        assert.equal((await entregues(q)).status, 400, q);
      }
      assert.equal((await proximo('?faixa=31-40')).status, 400);
      assert.equal((await entregues('?de=2026-02-30')).status, 400);
      assert.equal((await entregues('?de=2026-03-02&ate=2026-03-01')).status, 400);
      assert.equal((await estoque('?status=QUALQUER')).status, 400);
    });
  });
});
