'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const {
  criarFuncionario, criarMaterial, criarLote, criarFicha, registrarEntrega,
} = require('./helpers/entrega-epi');
const {
  criarSolicitacao, decidirSolicitacao, aprovar, reprovar, entregarPorSolicitacao, cancelarSolicitacao, baixarLote,
} = require('./helpers/solicitacao-epi');
const { criarRelatorioController } = require('../../src/controllers/relatorio.controller');
const { criarRelatorioRoutes } = require('../../src/routes/relatorio.routes');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const loteRepo = require('../../src/repositories/estoque-lote.repository');
const { DIAS_ALERTA_VALIDADE_CA } = require('../../src/schemas/itens-disponiveis.schema');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Relatório — Auditoria (12K-D5): indicadores, solicitações aprovadas com entrega pendente, itens reprovados, CAs vencidos e
 * trilha de ações, contra PostgreSQL real e as rotas reais. Autoridade própria: reportsAudit.visualizar.
 */
const HOJE = dataOperacional();
const deslocar = (dias) => {
  const d = new Date(`${HOJE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
const BASE = '/api/relatorios/auditoria';
const UA_CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

describe('Relatório — Auditoria 12K-D5 (PostgreSQL real)', () => {
  let g;
  let master;
  let auditor;
  let semAcesso;
  let supervisorAlvo;
  let outroUsuario;
  const e = {};

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarRelatorioRoutes({ controller: criarRelatorioController({ pool }), exigirSessao: exigirEmpresarial, pool }),
    ] });
    master = await g.contaDaEmpresa(g.empresas.A);
    // O MASTER recebe as permissões pelo provisionamento oficial (escopo do Painel Privado e do db:provisionar:master).
    await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, atorId: master.usuarioId, dryRun: false });
    const A = g.empresas.A;
    const B = g.empresas.B;
    const masterB = await g.contaDaEmpresa(B);
    outroUsuario = await g.usuarioPronto(master);
    supervisorAlvo = await g.usuarioPronto(master, { tipoConta: 'SUPERVISOR' });

    const ana = await criarFuncionario(g.pool, A, { matricula: 'M-001', cpf: '52998224725', setor: 'Produção' });
    const joao = await criarFuncionario(g.pool, A, { matricula: 'M-002', cpf: '11144477735', setor: 'Manutenção' });
    await g.pool.query("UPDATE funcionarios SET nome = 'Ana Sapateira' WHERE id = $1", [ana]);
    await g.pool.query("UPDATE funcionarios SET nome = 'João Álvares' WHERE id = $1", [joao]);
    e.ana = ana;
    e.joao = joao;
    const fichaAna = (await criarFicha(g.pool, A, ana)).id;
    const fichaJoao = (await criarFicha(g.pool, A, joao)).id;
    e.fichaAnaNumero = (await g.um('SELECT numero FROM fichas_epi WHERE id = $1', [fichaAna])).numero;

    const luva = await criarMaterial(g.pool, A, 'Luva de raspa', { tipo: 'Luva' });
    const botina = await criarMaterial(g.pool, A, 'Botina de segurança', { tipo: 'Botina de Segurança' });
    const capacete = await criarMaterial(g.pool, A, 'Capacete Classe B', { tipo: 'Capacete', exigeTamanho: false });
    e.luva = luva;
    const loteLuva = await criarLote(g.pool, { empresaId: A, materialId: luva, quantidade: 100, caNumero: '1111' });
    const loteBotina = await criarLote(g.pool, { empresaId: A, materialId: botina, quantidade: 100, caNumero: '2222' });
    e.loteLuva = loteLuva;
    // Lote com CA vencido num material que exige CA: conta como "CA vencido em estoque" (a regra do Dashboard).
    await criarLote(g.pool, { empresaId: A, materialId: capacete, quantidade: 5, tamanho: null, caNumero: '3333', caValidade: '2020-01-01' });
    // Modal de CA vencido: entra o lote vencido COM saldo, e a quantidade é o saldo ATUAL (50 entraram, 38 saíram → 12).
    const oculosCa = await criarMaterial(g.pool, A, 'Óculos Ampla Visão', { tipo: 'Óculos de Proteção Ampla Visão' });
    e.loteVencidoComSaldo = await criarLote(g.pool, { empresaId: A, materialId: oculosCa, quantidade: 50, caNumero: '4444', caValidade: '2020-02-02' });
    await baixarLote(g.pool, { empresaId: A, loteId: e.loteVencidoComSaldo, quantidade: 38, usuarioId: master.usuarioId });
    e.loteVencidoZerado = await criarLote(g.pool, { empresaId: A, materialId: oculosCa, quantidade: 5, caNumero: '4445', caValidade: '2020-03-03' });
    await baixarLote(g.pool, { empresaId: A, loteId: e.loteVencidoZerado, quantidade: 5, usuarioId: master.usuarioId });
    e.loteCaValido = await criarLote(g.pool, { empresaId: A, materialId: oculosCa, quantidade: 9, caNumero: '4446', caValidade: '2099-01-01' });
    const semCa = await criarMaterial(g.pool, A, 'Creme sem CA', { exigeCa: false });
    e.loteSemCa = await criarLote(g.pool, { empresaId: A, materialId: semCa, quantidade: 4, tamanho: null, caNumero: '4447', caValidade: '2020-04-04' });

    const entrega = (ficha, nome, matricula, setor, material, lote, confirmacao, dia) => registrarEntrega(g.pool, {
      usuarioId: master.usuarioId,
      entrega: {
        empresa_id: A, ficha_id: ficha, responsavel_id: master.usuarioId, responsavel_nome: 'Responsável Real', data_operacional: dia,
        entregue_em: `${dia}T12:00:00-03:00`, trabalhador_nome: nome, trabalhador_matricula: matricula, trabalhador_setor: setor,
      },
      itens: [{ material_id: material, lote_id: lote, material_nome: material === luva ? 'Luva de raspa' : 'Botina de segurança', quantidade: 2 }],
      confirmacao,
    });
    // ACEITE_PRESENCIAL e DESENHO são confirmações válidas e alternativas: as entregas só servem aos demais cenários (ex.: FIC- na trilha).
    e.aceiteAna = (await entrega(fichaAna, 'Ana Sapateira', 'M-001', 'Produção', luva, loteLuva, { modo: 'ACEITE_PRESENCIAL' }, deslocar(-3))).entrega.id;
    e.desenhoJoao = (await entrega(fichaJoao, 'João Álvares', 'M-002', 'Manutenção', botina, loteBotina, { modo: 'DESENHO', tracos: JSON.stringify([[{ x: 1, y: 2 }]]) }, deslocar(-2))).entrega.id;
    e.aceiteJoao = (await entrega(fichaJoao, 'João Álvares', 'M-002', 'Manutenção', botina, loteBotina, { modo: 'ACEITE_PRESENCIAL' }, deslocar(-20))).entrega.id;

    // Empresa B: entrega, solicitação aprovada e item reprovado que A nunca pode ver.
    const funcB = await criarFuncionario(g.pool, B, { matricula: 'B-001', cpf: '98765432100', setor: 'Produção' });
    const fichaB = (await criarFicha(g.pool, B, funcB)).id;
    const matB = await criarMaterial(g.pool, B, 'Luva da B', { tipo: 'Luva' });
    const loteB = await criarLote(g.pool, { empresaId: B, materialId: matB, quantidade: 50 });
    await registrarEntrega(g.pool, {
      usuarioId: masterB.usuarioId,
      entrega: { empresa_id: B, ficha_id: fichaB, responsavel_id: masterB.usuarioId, data_operacional: HOJE, trabalhador_nome: 'Fulano da B', trabalhador_matricula: 'B-001' },
      itens: [{ material_id: matB, lote_id: loteB, material_nome: 'Luva da B' }],
    });
    const solB = await criarSolicitacao(g.pool, {}, { empresaId: B, funcionarioId: funcB, solicitanteId: masterB.usuarioId, itens: [{ material_id: matB, quantidade: 3 }] });
    const usuarioB2 = await g.usuarioPronto(masterB);
    await decidirSolicitacao(g.pool, solB.solicitacao, { status: 'APROVADA', decididaPor: usuarioB2.id, decisoes: solB.itens.map((i) => aprovar(i)) });
    const solB2 = await criarSolicitacao(g.pool, {}, { empresaId: B, funcionarioId: funcB, solicitanteId: masterB.usuarioId, itens: [{ material_id: matB, quantidade: 1 }] });
    await decidirSolicitacao(g.pool, solB2.solicitacao, { status: 'REPROVADA', decididaPor: usuarioB2.id, decisoes: [reprovar(solB2.itens[0], 'Motivo da outra empresa')] });
    const matBCa = await criarMaterial(g.pool, B, 'Óculos da B');
    await criarLote(g.pool, { empresaId: B, materialId: matBCa, quantidade: 7, caNumero: '9001', caValidade: '2020-05-05' });

    // Solicitações da empresa A (solicitante: outroUsuario; decisor: master).
    // criada_em fica um dia antes da decisão (a decisão não pode ser anterior à criação).
    const nova = (itens, funcionarioId = ana, diasAtras = 0) => criarSolicitacao(g.pool, {}, {
      empresaId: A, funcionarioId, solicitanteId: outroUsuario.id, itens, cabecalho: diasAtras ? { criada_em: `${deslocar(-diasAtras - 1)}T09:00:00-03:00` } : {},
    });
    const decidir = (s, status, decisoes, quando) => decidirSolicitacao(g.pool, s.solicitacao, { status, decididaPor: master.usuarioId, decisoes, decididaEm: quando });
    // 1) aprovada integral, nada entregue → aguardando entrega, 10 dias na fila
    e.s1 = await nova([{ material_id: luva, quantidade: 4 }], ana, 10);
    await decidir(e.s1, 'APROVADA', e.s1.itens.map((i) => aprovar(i)), `${deslocar(-10)}T12:00:00-03:00`);
    // 2) aprovada parcial (um item reduzido, outro reprovado), nada entregue
    e.s2 = await nova([{ material_id: botina, quantidade: 5 }, { material_id: luva, quantidade: 1 }], joao, 4);
    await decidir(e.s2, 'APROVADA_PARCIAL', [aprovar(e.s2.itens[0], 3, 'Quantidade reduzida pela SST'), reprovar(e.s2.itens[1])], `${deslocar(-4)}T12:00:00-03:00`);
    // 3) aprovada e entregue em parte (1 de 3) → parcialmente atendida, falta 2
    e.s3 = await nova([{ material_id: luva, quantidade: 3 }], ana, 7);
    await decidir(e.s3, 'APROVADA', e.s3.itens.map((i) => aprovar(i)), `${deslocar(-7)}T12:00:00-03:00`);
    await entregarPorSolicitacao(g.pool, { solicitacao: e.s3.solicitacao, itens: [{ item: e.s3.itens[0], loteId: loteLuva, quantidade: 1 }], usuarioId: master.usuarioId });
    // 4) entregue por inteiro, 5) pendente, 6) cancelada: nenhuma entra
    // s4 tem um item aprovado (entregue por inteiro) e um reprovado: fecha como ENTREGUE e o item reprovado permanece no histórico.
    e.s4 = await nova([{ material_id: luva, quantidade: 1 }, { material_id: botina, quantidade: 2 }], ana, 6);
    await decidir(e.s4, 'APROVADA_PARCIAL', [aprovar(e.s4.itens[0]), reprovar(e.s4.itens[1], 'Já possui o par em uso')], `${deslocar(-6)}T12:00:00-03:00`);
    await entregarPorSolicitacao(g.pool, { solicitacao: e.s4.solicitacao, itens: [{ item: e.s4.itens[0], loteId: loteLuva, quantidade: 1 }], usuarioId: master.usuarioId });
    e.s5 = await nova([{ material_id: luva, quantidade: 1 }]);
    e.s6 = await nova([{ material_id: luva, quantidade: 1 }]);
    await cancelarSolicitacao(g.pool, e.s6.solicitacao, { canceladaPor: outroUsuario.id, justificativa: 'Desistência' });
    // 7) aprovada com TRÊS itens diferentes, nada entregue: o card conta 3 itens (não 1 pedido, não as 9 unidades)
    e.s7 = await nova([{ material_id: luva, quantidade: 2 }, { material_id: botina, quantidade: 3 }, { material_id: capacete, quantidade: 4, tamanho: null }], ana, 2);
    await decidir(e.s7, 'APROVADA', e.s7.itens.map((i) => aprovar(i)), `${deslocar(-2)}T12:00:00-03:00`);
    // 8) reprovada por inteiro (dois itens, motivos próprios), 15 dias atrás
    e.s8 = await nova([{ material_id: luva, quantidade: 6 }, { material_id: botina, quantidade: 1 }], joao, 15);
    await decidir(e.s8, 'REPROVADA', [reprovar(e.s8.itens[0], 'Sem necessidade comprovada para a função'), reprovar(e.s8.itens[1], 'Item fora da matriz do GHE')], `${deslocar(-15)}T12:00:00-03:00`);

    // Perfis de acesso: auditor tem só reportsAudit; semAcesso tem materials + epiFicha (as permissões de D1–D4 não abrem a auditoria).
    const liga = (u, toggle) => g.request(g.app).put(`/api/administracao/usuarios/${u.id}/acessos/${toggle}`).set('Cookie', g.cookie(master)).send({ ligado: true });
    auditor = await g.usuarioPronto(master);
    const ligou = await liga(auditor, 'reportsAudit');
    assert.equal(ligou.status, 200, JSON.stringify(ligou.body));
    semAcesso = await g.usuarioPronto(master);
    await liga(semAcesso, 'fichaEpi');
    await liga(semAcesso, 'cadastrarProduto');
  });
  after(async () => { if (g) await g.encerrar(); });

  // Um login por usuário: cada login grava eventos na trilha, e a paginação precisa de uma trilha estável.
  const cookies = new Map();
  const como = async (u) => {
    if (u === master) return g.cookie(master);
    if (!cookies.has(u.id)) cookies.set(u.id, g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA))));
    return cookies.get(u.id);
  };
  const ler = async (rota, u = auditor, q = '') => g.request(g.app).get(`${BASE}/${rota}${q}`).set('Cookie', await como(u));
  const ids = (r, chave) => r.body.itens.map((i) => i[chave]);
  const registrar = (dados) => auditoriaRepo.registrar(g.pool, { empresaId: g.empresas.A, ...dados });
  const logsDe = async (q = '') => (await ler('log', auditor, q)).body;

  describe('autorização: reportsAudit.visualizar, no servidor', () => {
    test('sem sessão 401; sem a permissão 403 em todas as rotas, mesmo com as permissões de ficha e materiais', async () => {
      for (const rota of ['indicadores', 'solicitacoes-nao-atendidas', 'solicitacoes-reprovadas', 'ca-vencidos', 'log']) {
        assert.equal((await g.request(g.app).get(`${BASE}/${rota}`)).status, 401, rota);
        assert.equal((await ler(rota, semAcesso)).status, 403, `${rota}: ficha e materiais não abrem a auditoria`);
        assert.equal((await ler(rota, outroUsuario)).status, 403, rota);
      }
    });

    test('com reportsAudit.visualizar (toggle) e o MASTER provisionado: todas as rotas abrem', async () => {
      for (const rota of ['indicadores', 'solicitacoes-nao-atendidas', 'solicitacoes-reprovadas', 'ca-vencidos', 'log']) {
        assert.equal((await ler(rota, auditor)).status, 200, rota);
        assert.equal((await ler(rota, master)).status, 200, `${rota} (MASTER)`);
      }
    });

    test('o toggle aparece no catálogo como "Relatório — Auditoria" e vale para o menu efetivo', async () => {
      const r = await g.request(g.app).get(`/api/administracao/usuarios/${auditor.id}/acessos`).set('Cookie', g.cookie(master));
      const t = r.body.acessos.toggles.find((x) => x.id === 'reportsAudit');
      assert.deepEqual([t.rotulo, t.ligado], ['Relatório — Auditoria', true]);
      const permissoes = (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(auditor))).body;
      assert.equal(permissoes.recursos.reportsAudit.visualizar, true);
      const sem = (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(semAcesso))).body;
      assert.equal(sem.recursos.reportsAudit?.visualizar ?? false, false);
    });

    test('consulta estrita: parâmetro desconhecido, ordenação fora da lista e período inválido são 400', async () => {
      assert.equal((await ler('log', auditor, '?empresaId=2')).status, 400);
      assert.equal((await ler('log', auditor, '?ordem=senha_hash')).status, 400);
      assert.equal((await ler('log', auditor, '?de=2026-02-30')).status, 400);
      assert.equal((await ler('log', auditor, `?de=${deslocar(-5)}&ate=${deslocar(-6)}`)).status, 400);
      assert.equal((await ler('log', auditor, `?de=${deslocar(-200)}&ate=${HOJE}`)).status, 400, 'período máximo');
      assert.equal((await ler('solicitacoes-nao-atendidas', auditor, '?status=ATRASADO')).status, 400, 'não existe "Atrasado"');
    });
  });

  describe('solicitações aprovadas não atendidas', () => {
    test('APROVADA e APROVADA_PARCIAL com pendente entram; entregue, pendente, cancelada e outra empresa não', async () => {
      const r = await ler('solicitacoes-nao-atendidas', auditor, '?limite=100');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const numeros = ids(r, 'numero').sort((a, b) => a - b);
      assert.deepEqual(numeros, [e.s1.solicitacao.numero, e.s2.solicitacao.numero, e.s3.solicitacao.numero, e.s7.solicitacao.numero].sort((a, b) => a - b));
      assert.equal(r.body.total, 4);
    });

    test('status só "Aguardando entrega" ou "Parcialmente atendida"; nunca "Atrasado"; pendente e dias em fila derivados', async () => {
      const r = await ler('solicitacoes-nao-atendidas', auditor, '?limite=100');
      const por = (s) => r.body.itens.find((i) => i.numero === s.solicitacao.numero);
      assert.deepEqual([por(e.s1).status, por(e.s1).diasEmFila], ['AGUARDANDO_ENTREGA', 10]);
      assert.deepEqual([por(e.s2).status, por(e.s2).diasEmFila], ['AGUARDANDO_ENTREGA', 4]);
      assert.deepEqual([por(e.s3).status, por(e.s3).diasEmFila], ['PARCIALMENTE_ATENDIDA', 7]);
      assert.deepEqual(por(e.s3).itens.map((i) => [i.material, i.pendente]), [['Luva de raspa', 2]], 'aprovada 3, entregue 1, falta 2');
      assert.deepEqual(por(e.s2).itens.map((i) => [i.material, i.pendente]), [['Botina de segurança', 3]], 'o item reprovado não conta');
      assert.ok(r.body.itens.every((i) => ['AGUARDANDO_ENTREGA', 'PARCIALMENTE_ATENDIDA'].includes(i.status)));
      assert.equal(/ATRASADO|Atrasado/.test(JSON.stringify(r.body)), false);
    });

    test('"Aprovado por" é o decisor (Segurança do Trabalho), com data da aprovação; sem "Supervisor"', async () => {
      const l = (await ler('solicitacoes-nao-atendidas', auditor, '?limite=100')).body.itens.find((i) => i.numero === e.s1.solicitacao.numero);
      const nomeMaster = (await g.um('SELECT nome FROM usuarios WHERE id = $1', [master.usuarioId])).nome;
      assert.equal(l.aprovadoPor.nome, nomeMaster);
      assert.equal(l.aprovadoEm, deslocar(-10));
      assert.equal(l.trabalhador.nome, 'Ana Sapateira');
      assert.equal(/Supervisor/i.test(JSON.stringify(l)), false);
    });

    test('filtros e ordenação; a solicitação da outra empresa não vaza', async () => {
      assert.deepEqual(ids(await ler('solicitacoes-nao-atendidas', auditor, '?status=PARCIALMENTE_ATENDIDA'), 'numero'), [e.s3.solicitacao.numero]);
      assert.equal((await ler('solicitacoes-nao-atendidas', auditor, '?funcionario=alvares')).body.total, 1);
      assert.equal((await ler('solicitacoes-nao-atendidas', auditor, '?item=botina')).body.total, 2, 'a de João e a de três itens');
      const dias = (await ler('solicitacoes-nao-atendidas', auditor, '?ordem=diasEmFila&direcao=desc&limite=100')).body.itens.map((i) => i.diasEmFila);
      assert.deepEqual(dias, [...dias].sort((a, b) => b - a));
      assert.equal((await ler('solicitacoes-nao-atendidas', auditor, '?limite=100')).body.itens.some((i) => i.trabalhador.nome === 'Fulano da B'), false);
    });
  });

  describe('indicadores superiores', () => {
    test('quatro números reais: ITENS com entrega pendente, itens reprovados, CA vencido e logs dos últimos 30 dias', async () => {
      const r = await ler('indicadores');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const solicitacoes = (await ler('solicitacoes-nao-atendidas', auditor, '?limite=1')).body.total;
      const logs = (await g.um("SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND criado_em >= now() - interval '30 days'", [g.empresas.A])).n;
      assert.deepEqual(Object.keys(r.body.indicadores).sort(), ['caVencidosEmEstoque', 'entregasPendentes', 'itensReprovados', 'logs30Dias'], 'não existe indicador de fichas sem assinatura');
      // Itens (uma linha = 1): s1 1 + s2 1 (o reprovado não conta) + s3 1 (entregue em parte) + s7 3 = 6; as 4 solicitações da tabela
      // NÃO são o número do card, e as unidades (4 + 3 + 2 + 9) também não.
      assert.equal(solicitacoes, 4);
      assert.equal(r.body.indicadores.entregasPendentes, 6);
      // Reprovados (histórico, em qualquer status): s2 1 + s4 1 (a solicitação já é ENTREGUE) + s8 2 = 4; a outra empresa, a pendente e a cancelada não.
      assert.equal(r.body.indicadores.itensReprovados, 4);
      assert.equal(r.body.indicadores.caVencidosEmEstoque, 2, 'o lote do capacete (5) e o dos óculos (12 de 50); zerado, válido, sem CA e de outra empresa ficam fora');
      assert.ok(Math.abs(r.body.indicadores.logs30Dias - logs) <= 3, 'só a própria consulta pode somar linhas entre as duas leituras');
    });
  });

  describe('"Fichas sem assinatura" foi removido (ACEITE_PRESENCIAL e DESENHO são confirmações válidas)', () => {
    test('a rota não existe mais, para quem tem a permissão e para quem não tem', async () => {
      assert.equal((await ler('fichas-sem-assinatura', auditor)).status, 404);
      assert.equal((await ler('fichas-sem-assinatura', master)).status, 404);
      assert.equal((await g.request(g.app).get(`${BASE}/fichas-sem-assinatura`)).status, 404);
    });
  });

  describe('card "Entregas pendentes": itens, não unidades nem pedidos', () => {
    test('item parcialmente entregue conta 1 e totalmente entregue sai; o pedido de vários itens conta cada item', async () => {
      const antes = (await ler('indicadores')).body.indicadores.entregasPendentes;
      assert.equal(antes, 6);
      // entrega o que falta do item de luva da s3 (aprovada 3, entregue 1): o item sai do card
      await entregarPorSolicitacao(g.pool, { solicitacao: e.s3.solicitacao, itens: [{ item: e.s3.itens[0], loteId: e.loteLuva, quantidade: 2 }], usuarioId: master.usuarioId });
      const depois = (await ler('indicadores')).body.indicadores.entregasPendentes;
      assert.equal(depois, 5, 'saiu exatamente 1 item (eram 2 unidades), e o pedido saiu da tabela');
      assert.equal((await ler('solicitacoes-nao-atendidas', auditor, '?limite=100')).body.total, 3);
    });
  });

  describe('itens reprovados pela SST', () => {
    test('uma linha por item reprovado, em qualquer status da solicitação; aprovado, pendente, cancelado e outra empresa ficam fora', async () => {
      const r = await ler('solicitacoes-reprovadas', auditor, '?limite=100');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.total, 4);
      assert.deepEqual(r.body.itens.map((i) => i.numero).sort((a, b) => a - b), [e.s2, e.s4, e.s8, e.s8].map((x) => x.solicitacao.numero).sort((a, b) => a - b));
      assert.ok(r.body.itens.every((i) => i.status === 'REPROVADO'));
      const textos = JSON.stringify(r.body);
      assert.equal(textos.includes('Motivo da outra empresa'), false);
      assert.equal(r.body.itens.some((i) => i.trabalhador.nome === 'Fulano da B'), false);
    });

    test('colunas: pedido, funcionário, item solicitado, quantidade solicitada, data da reprovação, reprovado por e motivo do item', async () => {
      const r = await ler('solicitacoes-reprovadas', auditor, '?limite=100');
      const nomeMaster = (await g.um('SELECT nome FROM usuarios WHERE id = $1', [master.usuarioId])).nome;
      const luvaS8 = r.body.itens.find((i) => i.numero === e.s8.solicitacao.numero && i.item.material === 'Luva de raspa');
      assert.deepEqual([luvaS8.trabalhador.nome, luvaS8.quantidade, luvaS8.reprovadoEm, luvaS8.reprovadoPor.nome, luvaS8.motivo],
        ['João Álvares', 6, deslocar(-15), nomeMaster, 'Sem necessidade comprovada para a função']);
      const botinaS8 = r.body.itens.find((i) => i.numero === e.s8.solicitacao.numero && i.item.material === 'Botina de segurança');
      assert.equal(botinaS8.motivo, 'Item fora da matriz do GHE', 'o motivo é por item, não por solicitação');
      const s4 = r.body.itens.find((i) => i.numero === e.s4.solicitacao.numero);
      assert.deepEqual([s4.item.material, s4.quantidade, s4.motivo], ['Botina de segurança', 2, 'Já possui o par em uso']);
      assert.equal((await g.um('SELECT status FROM solicitacoes_epi WHERE id = $1', [e.s4.solicitacao.id])).status, 'ENTREGUE', 'o histórico permanece mesmo com a solicitação já entregue');
    });

    test('a decisão mista conta só o item reprovado (pedido com 2 itens e 1 reprovado soma 1)', async () => {
      const r = await ler('solicitacoes-reprovadas', auditor, '?limite=100');
      assert.equal(r.body.itens.filter((i) => i.numero === e.s2.solicitacao.numero).length, 1);
      assert.equal(r.body.itens.filter((i) => i.numero === e.s4.solicitacao.numero).length, 1);
    });

    test('filtros de período da reprovação, funcionário e item; ordenação e paginação alcançam todas as linhas', async () => {
      assert.deepEqual(ids(await ler('solicitacoes-reprovadas', auditor, `?de=${deslocar(-20)}&ate=${deslocar(-10)}`), 'numero'), [e.s8.solicitacao.numero, e.s8.solicitacao.numero]);
      assert.equal((await ler('solicitacoes-reprovadas', auditor, `?de=${deslocar(-5)}`)).body.total, 1, 'só a de 4 dias');
      assert.equal((await ler('solicitacoes-reprovadas', auditor, '?funcionario=ana')).body.total, 1);
      assert.equal((await ler('solicitacoes-reprovadas', auditor, '?item=luva')).body.total, 2);
      const datas = (await ler('solicitacoes-reprovadas', auditor, '?ordem=dataReprovacao&direcao=desc&limite=100')).body.itens.map((i) => i.reprovadoEm);
      assert.deepEqual(datas, [...datas].sort().reverse(), 'mais recente primeiro por padrão');
      const todos = [];
      for (let p = 1; p <= 4; p += 1) todos.push(...(await ler('solicitacoes-reprovadas', auditor, `?limite=1&pagina=${p}`)).body.itens.map((i) => i.itemId));
      assert.equal(new Set(todos).size, 4);
    });

    test('permissão e consulta estrita: 403 sem reportsAudit; filtros desconhecidos, ordenação fora da lista e período invertido são 400', async () => {
      assert.equal((await ler('solicitacoes-reprovadas', semAcesso)).status, 403);
      assert.equal((await g.request(g.app).get(`${BASE}/solicitacoes-reprovadas`)).status, 401);
      for (const q of ['?empresaId=2', '?ordem=senha_hash', '?setor=producao', `?de=${deslocar(-1)}&ate=${deslocar(-2)}`]) assert.equal((await ler('solicitacoes-reprovadas', auditor, q)).status, 400, q);
    });
  });

  describe('modal-resumo de CAs vencidos em estoque (somente informativo; a tratativa é da Validade de Estoque)', () => {
    test('só lote com CA vencido e saldo; quantidade disponível é o saldo ATUAL, nunca a de entrada', async () => {
      const r = await ler('ca-vencidos', auditor, '?limite=100');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const lotes = r.body.itens.map((i) => i.loteId).sort((a, b) => a - b);
      assert.equal(r.body.total, 2);
      assert.equal(lotes.includes(e.loteVencidoZerado), false, 'sem saldo não aparece');
      assert.equal(lotes.includes(e.loteCaValido), false, 'CA válido não aparece');
      assert.equal(lotes.includes(e.loteSemCa), false, 'material que dispensa CA não aparece');
      const oculos = r.body.itens.find((i) => i.loteId === e.loteVencidoComSaldo);
      assert.deepEqual([oculos.material, oculos.caNumero, oculos.caValidade, oculos.quantidadeDisponivel],
        ['Óculos Ampla Visão', '4444', '2020-02-02', 12]);
      assert.equal('dataEntrada' in oculos, false, 'a prévia não leva data de entrada');
      assert.equal((await g.um('SELECT quantidade_entrada FROM estoque_lotes WHERE id = $1', [e.loteVencidoComSaldo])).quantidade_entrada, 50);
      const capacete = r.body.itens.find((i) => i.caNumero === '3333');
      assert.deepEqual([capacete.material, capacete.quantidadeDisponivel], ['Capacete Classe B', 5]);
    });

    test('prévia: o modal pede só as primeiras linhas e o total diz quantas existem ("Exibindo 1 de 2")', async () => {
      const r = await ler('ca-vencidos', auditor, '?pagina=1&limite=1');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.itens.length, 1);
      assert.equal(r.body.total, 2);
      assert.equal(r.body.total, (await ler('indicadores')).body.indicadores.caVencidosEmEstoque, 'o total é o do card');
    });

    test('é o mesmo conjunto do card e da tela Validade de Estoque (situação VENCIDO), sem a outra empresa; nada é baixado por consultar', async () => {
      const card = (await ler('indicadores')).body.indicadores.caVencidosEmEstoque;
      const modal = await ler('ca-vencidos', auditor, '?limite=100');
      assert.equal(modal.body.total, card);
      // A tela Validade de Estoque lista por esta mesma consulta (situacao = VENCIDO); a prévia não tem segunda regra.
      const validade = await loteRepo.contarValidade(g.pool, g.empresas.A, { hoje: HOJE, diasAlerta: DIAS_ALERTA_VALIDADE_CA, situacao: 'VENCIDO' });
      assert.equal(validade, card, 'a mesma regra da tela Validade de Estoque');
      assert.equal(JSON.stringify(modal.body).includes('Óculos da B'), false);
      const antes = (await g.um('SELECT count(*)::int AS n, sum(saldo)::int AS saldo FROM estoque_lotes WHERE empresa_id = $1', [g.empresas.A]));
      const operacoes = (await g.um('SELECT count(*)::int AS n FROM estoque_operacoes WHERE empresa_id = $1', [g.empresas.A])).n;
      await ler('ca-vencidos', auditor, '?limite=100');
      assert.deepEqual(await g.um('SELECT count(*)::int AS n, sum(saldo)::int AS saldo FROM estoque_lotes WHERE empresa_id = $1', [g.empresas.A]), antes);
      assert.equal((await g.um('SELECT count(*)::int AS n FROM estoque_operacoes WHERE empresa_id = $1', [g.empresas.A])).n, operacoes, 'nenhuma baixa automática');
    });

    test('permissão reportsAudit e consulta estrita', async () => {
      assert.equal((await ler('ca-vencidos', semAcesso)).status, 403);
      assert.equal((await g.request(g.app).get(`${BASE}/ca-vencidos`)).status, 401);
      assert.equal((await ler('ca-vencidos', auditor, '?ordem=nome')).status, 400);
      assert.equal((await ler('ca-vencidos', auditor, '?empresaId=2')).status, 400);
    });
  });

  describe('log de ações — trilha de auditoria', () => {
    test('isolamento por empresa e janela: só a empresa da sessão; eventos de 40 e 100 dias ficam fora do padrão de 30', async () => {
      await g.pool.query(
        `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, criado_em)
         VALUES ($1, $2, 'LOG_ANTIGO_40D', 'a40', now() - interval '40 days'), ($1, $2, 'LOG_ANTIGO_100D', 'a100', now() - interval '100 days'), ($3, NULL, 'LOG_DA_OUTRA_EMPRESA', 'b1', now())`,
        [g.empresas.A, master.usuarioId, g.empresas.B],
      );
      const padrao = await logsDe('?limite=100');
      const acoes = padrao.itens.map((i) => i.acao);
      assert.equal(acoes.includes('LOG_DA_OUTRA_EMPRESA'), false);
      assert.equal(acoes.includes('LOG_ANTIGO_40D'), false, 'o padrão é 30 dias; 40 dias exige pedir o período');
    });

    test('período padrão de 30 dias e período explícito', async () => {
      const padrao = await logsDe('?limite=100');
      assert.deepEqual(padrao.periodo, { de: deslocar(-29), ate: HOJE });
      assert.equal(padrao.itens.some((i) => i.acao === 'LOG_ANTIGO_40D'), false);
      const ampliado = await logsDe(`?de=${deslocar(-90)}&ate=${HOJE}&limite=100`);
      assert.equal(ampliado.itens.some((i) => i.acao === 'LOG_ANTIGO_40D'), true);
      assert.equal(ampliado.itens.some((i) => i.acao === 'LOG_ANTIGO_100D'), false);
    });

    test('mais recente primeiro; filtros de usuário, ação e referência', async () => {
      await registrar({ usuarioId: master.usuarioId, acao: 'ACAO_FILTRO_TESTE', referencia: 'ref-unica-777', ip: '198.51.100.9', dispositivo: UA_CHROME_WINDOWS });
      const todos = await logsDe('?limite=100');
      const datas = todos.itens.map((i) => i.criadoEm);
      assert.deepEqual(datas, [...datas].sort().reverse());
      assert.deepEqual((await logsDe('?acao=ACAO_FILTRO_TESTE')).itens.map((i) => i.referencia), ['ref-unica-777']);
      assert.deepEqual((await logsDe('?busca=ref-unica')).itens.map((i) => i.acao), ['ACAO_FILTRO_TESTE']);
      const nomeMaster = (await g.um('SELECT nome FROM usuarios WHERE id = $1', [master.usuarioId])).nome;
      const doUsuario = await logsDe(`?usuario=${encodeURIComponent(nomeMaster.slice(0, 6))}&limite=100`);
      assert.ok(doUsuario.itens.length > 0 && doUsuario.itens.every((i) => i.usuario && i.usuario.nome.toLowerCase().includes(nomeMaster.slice(0, 6).toLowerCase())));
    });

    test('perfil histórico: o snapshot do momento do evento, não o perfil atual; evento anterior sem snapshot mostra nulo', async () => {
      await registrar({ usuarioId: supervisorAlvo.id, acao: 'EVENTO_COM_SNAPSHOT', referencia: 'snap-1' });
      await g.pool.query("UPDATE usuarios SET perfil = 'USUARIO' WHERE id = $1", [supervisorAlvo.id]);
      await g.pool.query("INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia) VALUES ($1, $2, 'EVENTO_LEGADO_SEM_SNAPSHOT', 'snap-0')", [g.empresas.A, supervisorAlvo.id]);
      const com = (await logsDe('?acao=EVENTO_COM_SNAPSHOT')).itens[0];
      const legado = (await logsDe('?acao=EVENTO_LEGADO_SEM_SNAPSHOT')).itens[0];
      assert.equal(com.perfil, 'SUPERVISOR', 'o perfil de então, embora hoje seja USUARIO');
      assert.equal(legado.perfil, null, 'sem snapshot não se inventa perfil');
      assert.equal((await g.um('SELECT perfil FROM usuarios WHERE id = $1', [supervisorAlvo.id])).perfil, 'USUARIO');
    });

    test('IP e dispositivo são os gravados; navegador e sistema só derivados do User-Agent; nada de modelo físico', async () => {
      await registrar({ usuarioId: master.usuarioId, acao: 'EVENTO_COM_ORIGEM', referencia: 'orig-1', ip: '198.51.100.7', dispositivo: UA_CHROME_WINDOWS });
      await registrar({ usuarioId: master.usuarioId, acao: 'EVENTO_SEM_ORIGEM', referencia: 'orig-2' });
      await registrar({ usuarioId: master.usuarioId, acao: 'EVENTO_UA_DESCONHECIDO', referencia: 'orig-3', ip: '198.51.100.8', dispositivo: 'curl/8.0' });
      const com = (await logsDe('?acao=EVENTO_COM_ORIGEM')).itens[0];
      assert.deepEqual([com.ip, com.dispositivo], ['198.51.100.7', UA_CHROME_WINDOWS]);
      assert.deepEqual(com.origem, { navegador: 'Chrome', sistema: 'Windows' });
      const sem = (await logsDe('?acao=EVENTO_SEM_ORIGEM')).itens[0];
      assert.deepEqual([sem.ip, sem.dispositivo, sem.origem], [null, null, null]);
      const curl = (await logsDe('?acao=EVENTO_UA_DESCONHECIDO')).itens[0];
      assert.deepEqual([curl.ip, curl.dispositivo, curl.origem], ['198.51.100.8', 'curl/8.0', null], 'sem navegador reconhecível não se adivinha');
    });

    test('evento automático (sem usuário) aparece como sistema automático, sem fingir pessoa', async () => {
      await registrar({ usuarioId: null, acao: 'EVENTO_AUTOMATICO_TESTE', referencia: 'auto-1' });
      const l = (await logsDe('?acao=EVENTO_AUTOMATICO_TESTE')).itens[0];
      assert.deepEqual([l.usuario, l.automatico, l.perfil], [null, true, null]);
      const humano = (await logsDe('?acao=ACAO_FILTRO_TESTE')).itens[0];
      assert.equal(humano.automatico, false);
    });

    test('referência amigável só com mapeamento confiável; fora dele, a referência original', async () => {
      const entregaAna = e.aceiteAna;
      await registrar({ usuarioId: master.usuarioId, acao: 'SOLICITACAO_EPI_DECIDIDA', referencia: String(e.s1.solicitacao.id) });
      await registrar({ usuarioId: master.usuarioId, acao: 'ENTREGA_REGISTRADA', referencia: String(entregaAna) });
      await registrar({ usuarioId: master.usuarioId, acao: 'ESTOQUE_ENTRADA', referencia: String(e.loteLuva) });
      await registrar({ usuarioId: master.usuarioId, acao: 'VINCULO_SST_ADICIONADO', referencia: String(outroUsuario.id) });
      await registrar({ usuarioId: master.usuarioId, acao: 'MATERIAL_ALTERADO', referencia: String(e.luva) });
      await registrar({ usuarioId: master.usuarioId, acao: 'FUNCIONARIO_ALTERADO', referencia: String(e.joao) });
      await registrar({ usuarioId: master.usuarioId, acao: 'SOLICITACAO_EPI_CRIADA', referencia: 'nao-e-um-id' });
      await registrar({ usuarioId: master.usuarioId, acao: 'SOLICITACAO_EPI_CANCELADA', referencia: '999999999' });
      await registrar({ usuarioId: master.usuarioId, acao: 'ACAO_SEM_MAPA', referencia: String(e.s1.solicitacao.id) });
      const um = async (acao) => (await logsDe(`?acao=${acao}`)).itens[0];
      assert.equal((await um('SOLICITACAO_EPI_DECIDIDA')).referenciaAmigavel, `PED-${String(e.s1.solicitacao.numero).padStart(4, '0')} · Ana Sapateira`);
      assert.equal((await um('ENTREGA_REGISTRADA')).referenciaAmigavel, `FIC-${String(e.fichaAnaNumero).padStart(4, '0')} · Ana Sapateira`);
      assert.equal((await um('ESTOQUE_ENTRADA')).referenciaAmigavel, `EST-${String(e.loteLuva).padStart(4, '0')} · Luva de raspa`);
      assert.match((await um('VINCULO_SST_ADICIONADO')).referenciaAmigavel, new RegExp(`^USR-${String(outroUsuario.id).padStart(4, '0')} · `));
      assert.equal((await um('MATERIAL_ALTERADO')).referenciaAmigavel, `MAT-${String(e.luva).padStart(4, '0')} · Luva de raspa`);
      assert.equal((await um('FUNCIONARIO_ALTERADO')).referenciaAmigavel, `FUN-${String(e.joao).padStart(4, '0')} · João Álvares`);
      for (const [acao, ref] of [['SOLICITACAO_EPI_CRIADA', 'nao-e-um-id'], ['SOLICITACAO_EPI_CANCELADA', '999999999'], ['ACAO_SEM_MAPA', String(e.s1.solicitacao.id)]]) {
        const l = await um(acao);
        assert.deepEqual([l.referencia, l.referenciaAmigavel], [ref, null], acao);
      }
    });

    test('referência que aponta para entidade de OUTRA empresa não é resolvida', async () => {
      const outra = await g.um('SELECT id FROM solicitacoes_epi WHERE empresa_id = $1 LIMIT 1', [g.empresas.B]);
      await registrar({ usuarioId: master.usuarioId, acao: 'SOLICITACAO_EPI_ENCERRADA', referencia: String(outra.id) });
      const l = (await logsDe('?acao=SOLICITACAO_EPI_ENCERRADA')).itens[0];
      assert.deepEqual([l.referencia, l.referenciaAmigavel], [String(outra.id), null]);
    });

    test('nada sensível sai da trilha: sem contexto, sem dados, sem CPF, token, senha ou hash', async () => {
      await registrar({ usuarioId: master.usuarioId, acao: 'EVENTO_COM_CONTEXTO', referencia: 'ctx-1', contexto: { rota: 'x', observacao: 'texto de contexto' }, dadosNovos: { campo: 'valor' }, descricao: 'descrição interna' });
      const texto = JSON.stringify(await logsDe('?limite=100'));
      for (const proibido of ['texto de contexto', 'descrição interna', '52998224725', 'senha_hash', 'token_hash', 'hash_conteudo']) assert.equal(texto.includes(proibido), false, proibido);
      for (const l of (await logsDe('?limite=100')).itens) assert.deepEqual(Object.keys(l).sort(), ['acao', 'automatico', 'criadoEm', 'dispositivo', 'id', 'ip', 'origem', 'perfil', 'referencia', 'referenciaAmigavel', 'usuario']);
    });

    test('paginação alcança todas as linhas do filtro (base da exportação completa)', async () => {
      const total = (await logsDe('?limite=100')).total;
      const vistos = [];
      for (let p = 1; p <= Math.ceil(total / 7); p += 1) vistos.push(...(await logsDe(`?limite=7&pagina=${p}`)).itens.map((i) => i.id));
      assert.equal(vistos.length, total);
      assert.equal(new Set(vistos).size, total);
    });

    test('a consulta ao log é auditada sem recursão: uma linha por usuário na janela, sem valores de filtro', async () => {
      await logsDe('?busca=algo-sigiloso&limite=5');
      await logsDe('?limite=5');
      await logsDe('?acao=OUTRA');
      const linhas = await g.todos("SELECT usuario_id, contexto FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'AUDITORIA_LOG_CONSULTADA' AND usuario_id = $2", [g.empresas.A, auditor.id]);
      assert.equal(linhas.length, 1, 'todas as consultas do suíte cabem na janela de supressão: uma linha só');
      assert.equal(JSON.stringify(linhas).includes('algo-sigiloso'), false, 'o valor do filtro nunca é gravado');
      assert.equal((await ler('indicadores')).status, 200);
      const depois = (await g.todos("SELECT 1 FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'AUDITORIA_LOG_CONSULTADA' AND usuario_id = $2", [g.empresas.A, auditor.id])).length;
      assert.equal(depois, 1, 'as demais rotas não auditam e o log não cresce por requisição');
    });
  });
});
