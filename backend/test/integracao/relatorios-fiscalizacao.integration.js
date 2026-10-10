'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarFuncionario, criarMaterial, criarLote, criarFicha, registrarEntrega, criarGhe, inserir } = require('./helpers/entrega-epi');
const { baixarLote } = require('./helpers/solicitacao-epi');
const { lerZip } = require('../helpers/zip-leitor');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRelatorioController } = require('../../src/controllers/relatorio.controller');
const { criarRelatorioRoutes } = require('../../src/routes/relatorio.routes');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Relatório — Fiscalização (12K-D6): prévia, geração, histórico e download de pacotes imutáveis, contra PostgreSQL real, as
 * rotas reais e arquivos reais em um diretório temporário. Autoridade própria: reportsFiscal.visualizar (ver, pré-visualizar,
 * gerar e baixar). Estados GERANDO / CONCLUIDO / FALHA; nunca se reconstrói um pacote com dados atuais.
 */
const HOJE = dataOperacional();
const deslocar = (dias) => {
  const d = new Date(`${HOJE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};
const BASE = '/api/relatorios/fiscalizacao';
const CPF_ANA = '52998224725';
const ESC = {
  fichas: 'FICHAS_ENTREGAS_CONFIRMADAS', trilha: 'TRILHA_AUDITORIA', estoque: 'HISTORICO_ESTOQUE_CA', ghe: 'REGRAS_GHE',
};
const TODOS = [ESC.fichas, ESC.trilha, ESC.estoque, ESC.ghe];
const ARQUIVOS = {
  [ESC.fichas]: 'fichas-entregas-confirmadas', [ESC.trilha]: 'trilha-auditoria', [ESC.estoque]: 'historico-estoque-ca', [ESC.ghe]: 'regras-ghe',
};
/**
 * Enquanto um módulo do D6 não existe, o harness não pode cancelar a suíte inteira: o objeto que o representa lança a falha
 * (módulo ainda não implementado) no momento em que um teste o USA, e só esse teste falha.
 */
const ausente = (caminho) => new Proxy({}, {
  get(_alvo, propriedade) {
    if (typeof propriedade === 'symbol' || propriedade === 'then') return undefined;
    return assert.fail(`módulo ainda não implementado: ${caminho}.js (usado como ${String(propriedade)})`);
  },
});
const criarOuAusente = (caminho, fabrica, ...argumentos) => {
  let modulo;

  try {
    modulo = exigirModulo(caminho);
  } catch (erro) {
    if (erro && erro.name === 'AssertionError' && /módulo ainda não implementado/.test(erro.message)) return ausente(caminho);
    throw erro;
  }

  return modulo[fabrica](...argumentos);
};
const ARQUIVO_POSICAO_LOTES = 'posicao-lotes-na-geracao';
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const chave = () => `k-${crypto.randomUUID()}`;

describe('Relatório — Fiscalização 12K-D6 (PostgreSQL real, arquivos reais)', () => {
  let g;
  let master;
  let masterB;
  let fiscal;
  let auditor;
  let semAcesso;
  let diretorio;
  let armazenamento;
  let servico;
  let config;
  const e = {};

  const entrega = (A, ficha, nome, matricula, setor, material, lote, confirmacao, dia, extra = {}) => registrarEntrega(g.pool, {
    usuarioId: master.usuarioId,
    entrega: {
      empresa_id: A, ficha_id: ficha, responsavel_id: master.usuarioId, responsavel_nome: 'Responsável Real', data_operacional: dia,
      entregue_em: `${dia}T12:00:00-03:00`, trabalhador_nome: nome, trabalhador_matricula: matricula, trabalhador_setor: setor, ...extra,
    },
    itens: [{ material_id: material, lote_id: lote, material_nome: material === e.luva ? 'Luva de raspa' : 'Botina de segurança', quantidade: 2 }],
    confirmacao,
  });

  before(async () => {
    diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'fisc-int-'));
    armazenamento = criarOuAusente('src/storage/armazenamento-local', 'criarArmazenamentoLocal', { diretorio });
    config = {
      diretorio, limiteLinhasPorModulo: 100000, limiteBytesZip: 100 * 1024 * 1024, periodoMaximoDias: 366,
      heartbeatMs: 15000, abandonoMs: 120000, geracoesSimultaneasPorEmpresa: 1,
    };
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      servico = criarOuAusente('src/services/fiscalizacao-pacote.service', 'criarFiscalizacaoPacoteService', { pool, armazenamento, config });
      return [criarRelatorioRoutes({ controller: criarRelatorioController({ pool, fiscalizacao: servico }), exigirSessao: exigirEmpresarial, pool })];
    } });
    master = await g.contaDaEmpresa(g.empresas.A);
    await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, atorId: master.usuarioId, dryRun: false });
    const A = g.empresas.A;
    const B = g.empresas.B;
    masterB = await g.contaDaEmpresa(B);
    await provisionamento.provisionar(g.pool, { empresaId: B, atorId: masterB.usuarioId, dryRun: false });

    const ana = await criarFuncionario(g.pool, A, { matricula: 'M-001', cpf: CPF_ANA, setor: 'Produção' });
    const joao = await criarFuncionario(g.pool, A, { matricula: 'M-002', cpf: '11144477735', setor: 'Manutenção' });
    const fichaAna = (await criarFicha(g.pool, A, ana)).id;
    const fichaJoao = (await criarFicha(g.pool, A, joao)).id;
    e.fichaAna = fichaAna;
    e.luva = await criarMaterial(g.pool, A, 'Luva de raspa', { tipo: 'Luva' });
    e.botina = await criarMaterial(g.pool, A, 'Botina de segurança', { tipo: 'Botina de Segurança' });
    e.loteLuva = await criarLote(g.pool, { empresaId: A, materialId: e.luva, quantidade: 100, caNumero: '1111' });
    e.loteBotina = await criarLote(g.pool, { empresaId: A, materialId: e.botina, quantidade: 100, caNumero: '2222' });
    await baixarLote(g.pool, { empresaId: A, loteId: e.loteLuva, quantidade: 7, usuarioId: master.usuarioId });
    e.aceiteAna = (await entrega(A, fichaAna, 'Ana Sapateira', 'M-001', 'Produção', e.luva, e.loteLuva, { modo: 'ACEITE_PRESENCIAL' }, deslocar(-3))).entrega.id;
    e.desenhoJoao = (await entrega(A, fichaJoao, 'João Álvares', 'M-002', 'Manutenção', e.botina, e.loteBotina,
      { modo: 'DESENHO', tracos: JSON.stringify([[{ x: 1, y: 2 }]]) }, deslocar(-2))).entrega.id;
    // fora do período padrão dos testes (40 dias atrás)
    await entrega(A, fichaJoao, '=HYPERLINK("http://x")', 'M-002', 'Manutenção', e.botina, e.loteBotina, { modo: 'ACEITE_PRESENCIAL' }, deslocar(-40));

    // Trilha: contexto, dados e descrição NUNCA saem no pacote.
    await auditoriaRepo.registrar(g.pool, {
      empresaId: A, usuarioId: master.usuarioId, acao: 'FISCAL_TESTE', referencia: '1', ip: '198.51.100.7', dispositivo: 'Mozilla/5.0 (X11; Linux x86_64)',
      descricao: 'DESCRICAO_PROIBIDA', contexto: { marcador: 'SEGREDO_NO_CONTEXTO' }, dadosAnteriores: { marcador: 'DADO_ANTERIOR_PROIBIDO' }, dadosNovos: { marcador: 'DADO_NOVO_PROIBIDO' },
    });

    // GHE: duas linhas de saída (um GHE com material e outro sem).
    e.ghe = await criarGhe(g.pool, A, 'GHE Solda');
    await inserir(g.pool, 'ghe_materiais', { empresa_id: A, grupo_homogeneo_id: e.ghe, material_id: e.luva });
    e.ghe2 = await criarGhe(g.pool, A, 'GHE Pintura');

    // Empresa B: dados que A nunca pode ver.
    const funcB = await criarFuncionario(g.pool, B, { matricula: 'B-001', cpf: '98765432100', setor: 'Produção' });
    const fichaB = (await criarFicha(g.pool, B, funcB)).id;
    const matB = await criarMaterial(g.pool, B, 'Luva da B', { tipo: 'Luva' });
    const loteB = await criarLote(g.pool, { empresaId: B, materialId: matB, quantidade: 50 });
    await registrarEntrega(g.pool, {
      usuarioId: masterB.usuarioId,
      entrega: { empresa_id: B, ficha_id: fichaB, responsavel_id: masterB.usuarioId, data_operacional: deslocar(-1), entregue_em: `${deslocar(-1)}T12:00:00-03:00`, trabalhador_nome: 'Fulano da B', trabalhador_matricula: 'B-001' },
      itens: [{ material_id: matB, lote_id: loteB, material_nome: 'Luva da B' }],
    });
    await criarGhe(g.pool, B, 'GHE da B');

    const liga = (u, toggle) => g.request(g.app).put(`/api/administracao/usuarios/${u.id}/acessos/${toggle}`).set('Cookie', g.cookie(master)).send({ ligado: true });
    fiscal = await g.usuarioPronto(master);
    e.ligouFiscal = await liga(fiscal, 'reportsFiscal');
    auditor = await g.usuarioPronto(master);
    await liga(auditor, 'reportsAudit');
    semAcesso = await g.usuarioPronto(master);
    await liga(semAcesso, 'fichaEpi');
    await liga(semAcesso, 'cadastrarProduto');
  });
  after(async () => {
    if (g) await g.encerrar();
    if (diretorio) fs.rmSync(diretorio, { recursive: true, force: true });
  });

  const cookies = new Map();
  const como = async (u) => {
    if (u === master || u === masterB) return g.cookie(u);
    if (!cookies.has(u.id)) cookies.set(u.id, g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA))));
    return cookies.get(u.id);
  };
  const post = async (rota, corpo, u = fiscal) => g.request(g.app).post(`${BASE}/${rota}`).set('Cookie', await como(u)).send(corpo);
  const get = async (rota, u = fiscal) => g.request(g.app).get(`${BASE}/${rota}`).set('Cookie', await como(u));
  const entradaBase = (extra = {}) => ({
    periodoInicio: deslocar(-30), periodoFim: HOJE, finalidade: 'AUDITORIA_INTERNA', observacao: 'Conferência interna', escopos: TODOS, ...extra,
  });
  const previa = (extra, u) => post('previa', entradaBase(extra), u);
  const gerar = (extra, u) => post('pacotes', { ...entradaBase(), chaveIdempotencia: chave(), ...extra }, u);
  const pacotes = () => g.todos('SELECT * FROM fiscalizacao_pacotes ORDER BY id');
  const arquivosNoDisco = () => fs.readdirSync(diretorio, { recursive: true }).filter((n) => fs.statSync(path.join(diretorio, String(n))).isFile());
  const baixar = async (id, u = fiscal) => g.request(g.app).get(`${BASE}/pacotes/${id}/download`).set('Cookie', await como(u)).buffer(true).parse((res, cb) => {
    const partes = [];
    res.on('data', (c) => partes.push(c));
    res.on('end', () => cb(null, Buffer.concat(partes)));
  });
  const linhasCsv = (buf) => buf.toString('utf8').replace(/^﻿/, '').split('\r\n').filter(Boolean);


  describe('autorização: reportsFiscal.visualizar, no servidor', () => {
    test('sem sessão 401 e sem a permissão 403 em todas as rotas (inclusive para quem tem auditoria, ficha e materiais)', async () => {
      const rotas = [['get', 'pacotes'], ['get', 'pacotes/1'], ['get', 'pacotes/1/download'], ['post', 'previa'], ['post', 'pacotes']];
      for (const [metodo, rota] of rotas) {
        const anonimo = await g.request(g.app)[metodo](`${BASE}/${rota}`).send(metodo === 'post' ? entradaBase() : undefined);
        assert.equal(anonimo.status, 401, `${metodo} ${rota}`);
        for (const u of [auditor, semAcesso]) {
          const r = await g.request(g.app)[metodo](`${BASE}/${rota}`).set('Cookie', await como(u)).send(metodo === 'post' ? { ...entradaBase(), chaveIdempotencia: chave() } : undefined);
          assert.equal(r.status, 403, `${metodo} ${rota}`);
        }
      }
      assert.equal(arquivosNoDisco().length, 0, 'recusado não grava nada');
      assert.equal((await pacotes()).length, 0);
    });

    test('com reportsFiscal (toggle) e o MASTER provisionado, as rotas abrem; o toggle tem o rótulo e vale no menu efetivo', async () => {
      assert.equal(e.ligouFiscal.status, 200, JSON.stringify(e.ligouFiscal.body));
      assert.equal((await get('pacotes', fiscal)).status, 200);
      assert.equal((await get('pacotes', master)).status, 200);
      const r = await g.request(g.app).get(`/api/administracao/usuarios/${fiscal.id}/acessos`).set('Cookie', g.cookie(master));
      const t = r.body.acessos.toggles.find((x) => x.id === 'reportsFiscal');
      assert.deepEqual([t.rotulo, t.ligado], ['Relatório — Fiscalização', true]);
      const p = (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(fiscal))).body;
      assert.equal(p.recursos.reportsFiscal.visualizar, true);
      const sem = (await g.request(g.app).get('/api/auth/permissoes').set('Cookie', await como(auditor))).body;
      assert.equal(sem.recursos.reportsFiscal?.visualizar ?? false, false);
    });

    test('o cliente não escolhe empresa, usuário, status, hash, caminho nem versão: corpo estrito (400)', async () => {
      for (const extra of [{ empresaId: 2 }, { usuarioId: 1 }, { status: 'CONCLUIDO' }, { sha256: 'a'.repeat(64) }, { chaveArmazenamento: '../x' }, { versaoFormato: 9 }, { perfilAtor: 'MASTER' }, { requisicaoHash: 'a'.repeat(64) }]) {
        assert.equal((await previa(extra)).status, 400, JSON.stringify(extra));
        assert.equal((await gerar(extra)).status, 400, JSON.stringify(extra));
      }
      assert.equal((await pacotes()).length, 0);
    });
  });

  describe('validação do pedido', () => {
    test('finalidade obrigatória e só as cinco definidas; "Outra" exige observação; as demais não', async () => {
      assert.equal((await previa({ finalidade: undefined })).status, 400);
      assert.equal((await previa({ finalidade: 'CURIOSIDADE' })).status, 400);
      assert.equal((await previa({ finalidade: 'OUTRA', observacao: undefined })).status, 400);
      assert.equal((await previa({ finalidade: 'OUTRA', observacao: '   ' })).status, 400);
      assert.equal((await previa({ finalidade: 'OUTRA', observacao: 'Pedido do sindicato' })).status, 200);
      for (const f of ['FISCALIZACAO_TRABALHO', 'AUDITORIA_CLIENTE', 'AUDITORIA_INTERNA', 'SOLICITACAO_JURIDICA_DOCUMENTAL']) {
        assert.equal((await previa({ finalidade: f, observacao: undefined })).status, 200, f);
      }
    });

    test('escopos: pelo menos um, só os quatro conhecidos, sem repetição', async () => {
      assert.equal((await previa({ escopos: [] })).status, 400);
      assert.equal((await previa({ escopos: ['PGR'] })).status, 400);
      assert.equal((await previa({ escopos: [ESC.fichas, ESC.fichas] })).status, 400);
      assert.equal((await previa({ escopos: undefined })).status, 400);
    });

    test('período: 366 dias inclusivos passam, 367 são recusados com código controlado; inválido e invertido 400', async () => {
      assert.equal((await previa({ periodoInicio: HOJE, periodoFim: HOJE })).status, 200, 'mesmo dia');
      assert.equal((await previa({ periodoInicio: deslocar(-365), periodoFim: HOJE })).status, 200, '366 dias inclusivos');
      const longo = await previa({ periodoInicio: deslocar(-366), periodoFim: HOJE });
      assert.equal(longo.status, 400);
      assert.equal(longo.body.codigo, 'PERIODO_MAXIMO_EXCEDIDO');
      assert.equal((await previa({ periodoInicio: '2026-02-30', periodoFim: HOJE })).status, 400);
      assert.equal((await previa({ periodoInicio: HOJE, periodoFim: deslocar(-1) })).status, 400);
      assert.equal((await gerar({ periodoInicio: deslocar(-366), periodoFim: HOJE })).status, 400);
    });

    test('observação limitada e sem texto de controle; nome do arquivo nunca vem do cliente', async () => {
      assert.equal((await previa({ observacao: 'x'.repeat(501) })).status, 400);
      assert.equal((await previa({ observacao: 'ok\u0000ruim' })).status, 400);
      assert.equal((await previa({ nomeArquivo: '../../x.zip' })).status, 400);
    });
  });

  describe('pré-visualização', () => {
    test('não gera ZIP nem cria pacote: nenhum registro e nenhum arquivo', async () => {
      const antes = (await pacotes()).length;
      const r = await previa();
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await pacotes()).length, antes);
      assert.equal(arquivosNoDisco().length, 0);
    });

    test('contagens corretas por módulo, na empresa e no período; só os escopos selecionados', async () => {
      const r = await previa();
      assert.equal(r.status, 200, JSON.stringify(r.body ?? null));
      const por = Object.fromEntries(r.body.previa.escopos.map((x) => [x.escopo, x]));
      assert.equal(por[ESC.fichas].linhas, 2, 'duas entregas confirmadas no período (a de 40 dias e a de B ficam fora)');
      assert.equal(por[ESC.ghe].linhas, 2, 'um GHE com material e um sem');
      assert.ok(por[ESC.trilha].linhas >= 1);
      assert.ok(por[ESC.estoque].linhas >= 3, 'duas entradas e uma baixa');
      assert.deepEqual(r.body.previa.periodo, { inicio: deslocar(-30), fim: HOJE, dias: 31 });
      const so = await previa({ escopos: [ESC.fichas] });
      assert.equal(so.status, 200, JSON.stringify(so.body ?? null));
      assert.deepEqual(so.body.previa.escopos.map((x) => x.escopo), [ESC.fichas]);
    });

    test('o período é respeitado (inclusivo nas duas pontas)', async () => {
      const um = await previa({ escopos: [ESC.fichas], periodoInicio: deslocar(-2), periodoFim: deslocar(-2) });
      assert.equal(um.status, 200, JSON.stringify(um.body ?? null));
      assert.equal(um.body.previa.escopos[0].linhas, 1);
      const dois = await previa({ escopos: [ESC.fichas], periodoInicio: deslocar(-3), periodoFim: deslocar(-2) });
      assert.equal(dois.status, 200, JSON.stringify(dois.body ?? null));
      assert.equal(dois.body.previa.escopos[0].linhas, 2);
      const fora = await previa({ escopos: [ESC.fichas], periodoInicio: deslocar(-60), periodoFim: deslocar(-41) });
      assert.equal(fora.status, 200, JSON.stringify(fora.body ?? null));
      assert.equal(fora.body.previa.escopos[0].linhas, 0);
    });

    test('módulo selecionado sem registros no período aparece como vazio (e a prévia segue válida)', async () => {
      const r = await previa({ periodoInicio: '2020-01-01', periodoFim: '2020-01-10' });
      assert.equal(r.status, 200, JSON.stringify(r.body ?? null));
      const por = Object.fromEntries(r.body.previa.escopos.map((x) => [x.escopo, x]));
      for (const esc of [ESC.fichas, ESC.trilha]) assert.deepEqual([por[esc].linhas, por[esc].vazio], [0, true], esc);
      assert.equal(por[ESC.estoque].vazio, false, 'a posição atual dos lotes não depende do período: sem movimentos no período, o módulo ainda tem a posição');
      assert.equal(por[ESC.ghe].vazio, false, 'regras de GHE são a posição atual, não dependem do período');
      assert.equal(r.body.previa.podeGerar, true);
    });

    test('isolamento: a prévia de B só enxerga os dados de B', async () => {
      const r = await post('previa', entradaBase({ escopos: [ESC.fichas, ESC.ghe] }), masterB);
      assert.equal(r.status, 200, JSON.stringify(r.body ?? null));
      const por = Object.fromEntries(r.body.previa.escopos.map((x) => [x.escopo, x]));
      assert.deepEqual([por[ESC.fichas].linhas, por[ESC.ghe].linhas], [1, 1]);
    });
  });

  describe('limite de 100.000 linhas POR módulo', () => {
    const comLimite = async (limite, fn) => {
      const anterior = config.limiteLinhasPorModulo;
      config.limiteLinhasPorModulo = limite;
      try { return await fn(); } finally { config.limiteLinhasPorModulo = anterior; }
    };

    test('o padrão aprovado é 100.000 por módulo', () => {
      assert.equal(config.limiteLinhasPorModulo, 100000);
    });

    test('a contagem é a efetivamente exportável (empresa, período, escopo), nunca o bruto da tabela', async () => {
      await comLimite(2, async () => {
        const r = await previa({ escopos: [ESC.fichas] });
        assert.equal(r.status, 200, JSON.stringify(r.body ?? null));
        assert.equal(r.body.previa.escopos[0].linhas, 2, 'o bruto do banco tem 4 itens entregues (outra empresa e fora do período)');
        assert.equal(r.body.previa.escopos[0].excedeLimite, false);
        assert.equal(r.body.previa.podeGerar, true);
      });
    });

    test('o limite é por módulo, não somado: vários módulos no limite cada um passam e a geração conclui', async () => {
      await comLimite(2, async () => {
        const r = await previa({ escopos: [ESC.fichas, ESC.ghe] });
        assert.equal(r.status, 200, JSON.stringify(r.body ?? null));
        assert.equal(r.body.previa.podeGerar, true);
        assert.ok(r.body.previa.escopos.every((x) => x.linhas === 2 && !x.excedeLimite), 'somam 4 > 2, mas cada módulo está no limite');
        const ger = await gerar({ escopos: [ESC.fichas, ESC.ghe] });
        assert.equal(ger.status, 201, JSON.stringify(ger.body));
        assert.equal(ger.body.pacote.status, 'CONCLUIDO');
      });
    });

    test('módulo acima do limite: a prévia indica qual, a quantidade e impede gerar; nada é montado', async () => {
      await comLimite(1, async () => {
        const antes = (await pacotes()).length;
        const arquivosAntes = arquivosNoDisco().slice().sort();
        const r = await previa({ escopos: [ESC.fichas, ESC.ghe] });
        assert.equal(r.status, 200);
        assert.equal(r.body.previa.podeGerar, false);
        const por = Object.fromEntries(r.body.previa.escopos.map((x) => [x.escopo, x]));
        assert.deepEqual([por[ESC.fichas].excedeLimite, por[ESC.fichas].linhas], [true, 2]);
        assert.match(JSON.stringify(r.body.previa), /reduz|período/i, 'orienta reduzir o período');
        const ger = await gerar({ escopos: [ESC.fichas] });
        assert.equal(ger.status, 400);
        assert.equal(ger.body.codigo, 'LIMITE_LINHAS_EXCEDIDO');
        assert.equal(ger.body.detalhes.modulo, ESC.fichas);
        assert.equal((await pacotes()).length, antes, 'nenhum registro');
        assert.deepEqual(
          arquivosNoDisco().slice().sort(),
          arquivosAntes,
          'nenhum arquivo foi criado, removido ou substituído pela geração recusada',
        );
      });
    });

  });

  describe('geração do pacote', () => {
    let primeiro;
    let chavePrimeiro;
    let corpoPrimeiro;

    test('gera o pacote: CONCLUIDO, SHA-256 do arquivo registrado, metadados persistidos e ator da sessão', async () => {
      chavePrimeiro = chave();
      corpoPrimeiro = { ...entradaBase(), chaveIdempotencia: chavePrimeiro };
      const r = await post('pacotes', corpoPrimeiro);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      primeiro = r.body.pacote;
      assert.equal(primeiro.status, 'CONCLUIDO');
      assert.match(primeiro.sha256, /^[0-9a-f]{64}$/);
      const [linha] = await g.todos('SELECT * FROM fiscalizacao_pacotes WHERE id = $1', [primeiro.id]);
      assert.equal(linha.empresa_id, g.empresas.A);
      assert.equal(linha.usuario_id, fiscal.id, 'o ator vem da sessão');
      assert.equal(linha.perfil_ator, 'USUARIO');
      assert.equal(linha.status, 'CONCLUIDO');
      assert.equal(linha.finalidade, 'AUDITORIA_INTERNA');
      assert.equal(linha.observacao, 'Conferência interna');
      assert.equal(linha.periodo_inicio.toISOString?.().slice(0, 10) ?? String(linha.periodo_inicio), deslocar(-30));
      assert.deepEqual(linha.escopos, TODOS);
      assert.equal(linha.versao_formato, 1);
      assert.equal(linha.sha256, primeiro.sha256);
      assert.ok(linha.tamanho_bytes > 0 && linha.concluido_em && linha.heartbeat_em && linha.nome_logico);
      assert.match(linha.requisicao_hash, /^[0-9a-f]{64}$/);
      assert.equal(linha.chave_idempotencia, chavePrimeiro);
      assert.equal(linha.erro_codigo, null);
      assert.deepEqual(Object.keys(linha.contagens).sort(), [...TODOS].sort());
    });

    test('o arquivo em disco corresponde ao registro: tamanho, SHA-256 e a chave de armazenamento gerada pelo servidor', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const [linha] = await g.todos('SELECT * FROM fiscalizacao_pacotes WHERE id = $1', [primeiro.id]);
      assert.match(linha.chave_armazenamento, new RegExp(`^${g.empresas.A}/pacote-${primeiro.id}\\.zip$`));
      const bytes = fs.readFileSync(path.join(diretorio, linha.chave_armazenamento));
      assert.equal(bytes.length, Number(linha.tamanho_bytes));
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), linha.sha256);
      assert.equal(arquivosNoDisco().filter((n) => String(n).endsWith('.tmp')).length, 0, 'nenhum temporário residual');
    });

    test('a resposta nunca expõe caminho de armazenamento, hash da requisição nem a chave interna', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const texto = JSON.stringify((await get(`pacotes/${primeiro.id}`)).body);
      assert.equal(/chaveArmazenamento|chave_armazenamento|requisicaoHash|requisicao_hash|\/pacote-/.test(texto), false);
    });

    test('conteúdo do ZIP: manifesto, LEIAME e um CSV e um JSON por módulo selecionado, com contagens iguais às do registro', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const r = await baixar(primeiro.id);
      assert.equal(r.status, 200);
      const z = lerZip(r.body);
      const esperados = ['manifesto.json', 'LEIAME.txt', ...TODOS.flatMap((s) => [`${ARQUIVOS[s]}.csv`, `${ARQUIVOS[s]}.json`]),
        `${ARQUIVO_POSICAO_LOTES}.csv`, `${ARQUIVO_POSICAO_LOTES}.json`].sort();
      assert.deepEqual(Object.keys(z).sort(), esperados);
      const manifesto = JSON.parse(z['manifesto.json'].toString('utf8'));
      const [linha] = await g.todos('SELECT * FROM fiscalizacao_pacotes WHERE id = $1', [primeiro.id]);
      for (const esc of TODOS) {
        // o limite e a contagem são do MÓDULO inteiro: no estoque, movimentos históricos + posição atual dos lotes
        const nomes = esc === ESC.estoque ? [ARQUIVOS[esc], ARQUIVO_POSICAO_LOTES] : [ARQUIVOS[esc]];
        const totalJson = nomes.reduce((soma, n) => soma + JSON.parse(z[`${n}.json`].toString('utf8')).length, 0);
        const totalCsv = nomes.reduce((soma, n) => soma + linhasCsv(z[`${n}.csv`]).length - 1, 0);
        assert.equal(totalJson, manifesto.contagens[esc]);
        assert.equal(totalCsv, manifesto.contagens[esc]);
        assert.equal(linha.contagens[esc], manifesto.contagens[esc]);
      }
      assert.equal(manifesto.contagens[ESC.fichas], 2);
      assert.equal(manifesto.versaoFormato, 1);
      assert.deepEqual(manifesto.periodo, { inicio: deslocar(-30), fim: HOJE });
      assert.equal(manifesto.finalidade, 'AUDITORIA_INTERNA');
      assert.equal(manifesto.observacao, 'Conferência interna');
      assert.deepEqual(manifesto.escopos, TODOS);
      for (const a of manifesto.arquivos) assert.equal(crypto.createHash('sha256').update(z[a.nome]).digest('hex'), a.sha256, a.nome);
    });

    test('fichas/entregas confirmadas: uma linha por item, DESENHO e ACEITE_PRESENCIAL, snapshots congelados, hash_conteudo, sem traços', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const z = lerZip((await baixar(primeiro.id)).body);
      const dados = JSON.parse(z[`${ARQUIVOS[ESC.fichas]}.json`].toString('utf8'));
      assert.deepEqual(dados.map((d) => d.modo_confirmacao).sort(), ['ACEITE_PRESENCIAL', 'DESENHO']);
      const ana = dados.find((d) => d.trabalhador_matricula === 'M-001');
      assert.equal(ana.trabalhador_nome, 'Ana Sapateira');
      assert.equal(ana.material_nome, 'Luva de raspa');
      assert.equal(ana.quantidade, 2);
      assert.match(ana.hash_conteudo, /^[0-9a-f]{64}$/);
      assert.ok(ana.ficha_numero >= 1);
      const cabecalho = linhasCsv(z[`${ARQUIVOS[ESC.fichas]}.csv`])[0];
      for (const c of ['modo_confirmacao', 'hash_conteudo', 'ficha_numero', 'trabalhador_nome', 'trabalhador_matricula', 'material_nome', 'quantidade', 'data_operacional']) assert.ok(cabecalho.includes(c), c);
      assert.equal(JSON.stringify(dados).includes('tracos'), false, 'os traços brutos ficam fora do pacote');
    });

    test('trilha de auditoria: só os campos permitidos (sem contexto, dados anteriores/novos e descrição) e com o perfil de então', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const z = lerZip((await baixar(primeiro.id)).body);
      const dados = JSON.parse(z[`${ARQUIVOS[ESC.trilha]}.json`].toString('utf8'));
      const linha = dados.find((d) => d.acao === 'FISCAL_TESTE');
      assert.ok(linha);
      assert.deepEqual(Object.keys(linha).sort(), ['acao', 'data_hora', 'dispositivo', 'ip', 'perfil', 'referencia', 'referencia_amigavel', 'usuario'].sort());
      assert.equal(linha.ip, '198.51.100.7');
      assert.equal(linha.perfil, 'MASTER');
    });

    test('estoque e CA: movimentos reais do período com CA e validade; saldo do lote rotulado como posição na geração', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const z = lerZip((await baixar(primeiro.id)).body);
      const dados = JSON.parse(z[`${ARQUIVOS[ESC.estoque]}.json`].toString('utf8'));
      const baixa = dados.find((d) => d.tipo === 'BAIXA');
      assert.equal(baixa.quantidade, 7);
      assert.equal(baixa.ca_numero, '1111');
      assert.equal(baixa.material_nome, 'Luva de raspa');
      assert.equal('lote_saldo_posicao_na_geracao' in baixa, false, 'o saldo atual não é parte do evento histórico');
      assert.equal(Object.keys(baixa).some((k) => /saldo/.test(k)), false);
      const posicao = JSON.parse(z[`${ARQUIVO_POSICAO_LOTES}.json`].toString('utf8'));
      const loteLuva = posicao.find((p) => p.lote_id === e.loteLuva);
      assert.ok(loteLuva, 'a posição atual traz o lote da luva');
      assert.equal(loteLuva.saldo_posicao_na_geracao, 100 - 7 - 2, 'saldo na data da geração (100 - 7 baixados - 2 entregues)');
    });

    test('regras de GHE: o retrato atual dos grupos e dos materiais vinculados, sem inventar histórico nem elegibilidade', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const z = lerZip((await baixar(primeiro.id)).body);
      const dados = JSON.parse(z[`${ARQUIVOS[ESC.ghe]}.json`].toString('utf8'));
      assert.deepEqual(dados.map((d) => [d.ghe_nome, d.material_nome]).sort((a, b) => a[0].localeCompare(b[0])), [['GHE Pintura', null], ['GHE Solda', 'Luva de raspa']]);
      const manifesto = JSON.parse(z['manifesto.json'].toString('utf8'));
      const limitacoes = manifesto.limitacoes.join(' ');
      assert.match(limitacoes, /posição na data da geração/i);
      assert.match(limitacoes, /elegibilidade/i);
    });

    test('nomenclatura e declarações: confirmadas (não "assinadas"), DESENHO ≠ ACEITE_PRESENCIAL, hash_conteudo só integridade', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const z = lerZip((await baixar(primeiro.id)).body);
      const m = JSON.parse(z['manifesto.json'].toString('utf8'));
      const tudo = Object.values(z).map((b) => b.toString('utf8')).join('\n') + JSON.stringify((await get(`pacotes/${primeiro.id}`)).body);
      assert.equal(/fichas?(\/entregas)? de epi assinadas?/i.test(tudo), false);
      assert.match(tudo, /Fichas\/entregas de EPI confirmadas/);
      assert.match(m.definicoes.DESENHO, /desenho/i);
      assert.match(m.definicoes.ACEITE_PRESENCIAL, /presencial/i);
      assert.equal(/assinatura desenhada/i.test(m.definicoes.ACEITE_PRESENCIAL), false, 'ACEITE_PRESENCIAL não é assinatura desenhada');
      assert.match(m.definicoes.hash_conteudo, /integridade/i);
      assert.match(m.definicoes.hash_conteudo, /não é assinatura digital/i);
      assert.match(m.definicoes.hash_conteudo, /não é assinatura criptográfica/i);
      assert.match(z['LEIAME.txt'].toString('utf8'), /não é assinatura digital/i);
      assert.equal(/PGR/.test(tudo), false, 'o conteúdo não é chamado de PGR');
    });

    test('nada proibido no pacote: CPF, traços, contexto, dados da auditoria, descrição, hash de senha, token; fórmula neutralizada', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      const z = lerZip((await baixar(primeiro.id)).body);
      const tudo = Object.values(z).map((b) => b.toString('utf8')).join('\n');
      for (const proibido of [CPF_ANA, '529.982.247-25', 'SEGREDO_NO_CONTEXTO', 'DADO_ANTERIOR_PROIBIDO', 'DADO_NOVO_PROIBIDO', 'DESCRICAO_PROIBIDA', 'senha_hash', 'hash-de-teste', 'tracos', '"x":1', 'Fulano da B', 'GHE da B']) {
        assert.equal(tudo.includes(proibido), false, proibido);
      }
      assert.equal(/^\s*"?=HYPERLINK/m.test(tudo), false);
    });

    test('CSV seguro: UTF-8 com BOM, ponto e vírgula, CRLF, todas as células entre aspas e fórmula neutralizada com apóstrofo', async () => {
      const nova = await gerar({ periodoInicio: deslocar(-45), periodoFim: HOJE, escopos: [ESC.fichas] });
      assert.equal(nova.status, 201, JSON.stringify(nova.body));
      const z = lerZip((await baixar(nova.body.pacote.id)).body);
      const bruto = z[`${ARQUIVOS[ESC.fichas]}.csv`];
      assert.deepEqual([...bruto.subarray(0, 3)], [0xEF, 0xBB, 0xBF]);
      const linhas = linhasCsv(bruto);
      assert.ok(linhas.every((l) => l.split(';').every((c) => c.startsWith('"') && c.endsWith('"'))));
      assert.ok(linhas.some((l) => l.includes("\"'=HYPERLINK")), 'a fórmula é neutralizada');
      assert.equal(linhas.some((l) => l.includes('"=HYPERLINK')), false);
    });

    test('só os escopos selecionados entram no ZIP e no registro, na ordem canônica', async () => {
      const r = await gerar({ escopos: [ESC.trilha, ESC.fichas] });
      assert.equal(r.status, 201);
      const z = lerZip((await baixar(r.body.pacote.id)).body);
      assert.deepEqual(Object.keys(z).sort(), ['LEIAME.txt', 'fichas-entregas-confirmadas.csv', 'fichas-entregas-confirmadas.json', 'manifesto.json', 'trilha-auditoria.csv', 'trilha-auditoria.json']);
      const [linha] = await g.todos('SELECT escopos FROM fiscalizacao_pacotes WHERE id = $1', [r.body.pacote.id]);
      assert.deepEqual(linha.escopos, [ESC.fichas, ESC.trilha]);
    });

    test('módulo selecionado sem registros gera arquivos vazios (só cabeçalho) e é declarado no manifesto', async () => {
      const r = await gerar({ periodoInicio: '2020-01-01', periodoFim: '2020-01-10', escopos: [ESC.fichas] });
      assert.equal(r.status, 201);
      const z = lerZip((await baixar(r.body.pacote.id)).body);
      assert.deepEqual(JSON.parse(z[`${ARQUIVOS[ESC.fichas]}.json`].toString('utf8')), []);
      assert.equal(linhasCsv(z[`${ARQUIVOS[ESC.fichas]}.csv`]).length, 1);
      assert.equal(JSON.parse(z['manifesto.json'].toString('utf8')).contagens[ESC.fichas], 0);
    });

    test('auditoria da geração e do download: só ids, escopos, contagens e hash — nunca conteúdo, CPF ou caminho', async () => {
      assert.ok(primeiro, 'pré-requisito: o teste "gera o pacote…" deveria ter obtido 201 e o pacote; sem ele não há o que verificar aqui');
      await baixar(primeiro.id);
      const gerado = await g.todos("SELECT * FROM logs_auditoria WHERE acao = 'FISCALIZACAO_PACOTE_GERADO' AND referencia = $1", [String(primeiro.id)]);
      const baixado = await g.todos("SELECT * FROM logs_auditoria WHERE acao = 'FISCALIZACAO_PACOTE_BAIXADO' AND referencia = $1", [String(primeiro.id)]);
      assert.equal(gerado.length, 1);
      assert.ok(baixado.length >= 1);
      assert.equal(gerado[0].usuario_id, fiscal.id);
      const texto = JSON.stringify([gerado, baixado]);
      for (const proibido of [CPF_ANA, 'SEGREDO', 'Ana Sapateira', 'pacote-', '.zip']) assert.equal(texto.includes(proibido), false, proibido);
    });

    test('o histórico lista os pacotes da própria empresa, do mais recente ao mais antigo, paginado', async () => {
      const r = await get('pacotes?limite=2&pagina=1');
      assert.equal(r.status, 200);
      assert.equal(r.body.itens.length, 2);
      assert.ok(r.body.total >= 3);
      assert.ok(Number(r.body.itens[0].id) > Number(r.body.itens[1].id));
      assert.equal(r.body.itens.every((p) => p.status), true);
    });
  });

  describe('idempotência: uma chave por tentativa e por empresa', () => {
    test('MESMA chave e MESMO pedido com o pacote CONCLUIDO: devolve o existente, sem novo registro nem novo ZIP', async () => {
      const k = chave();
      const primeiro = await post('pacotes', { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: k });
      assert.equal(primeiro.status, 201);
      const registros = (await pacotes()).length;
      const arquivos = arquivosNoDisco().length;
      const repetido = await post('pacotes', { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: k });
      assert.equal(repetido.status, 200);
      assert.equal(repetido.body.pacote.id, primeiro.body.pacote.id);
      assert.equal(repetido.body.pacote.sha256, primeiro.body.pacote.sha256);
      assert.equal((await pacotes()).length, registros);
      assert.equal(arquivosNoDisco().length, arquivos);
    });

    test('MESMA chave com pedido DIFERENTE: 409, a tentativa existente não muda e nada é gerado', async () => {
      const k = chave();
      const primeiro = await post('pacotes', { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: k });
      assert.equal(primeiro.status, 201, JSON.stringify(primeiro.body ?? null));
      const antes = await g.um('SELECT * FROM fiscalizacao_pacotes WHERE id = $1', [primeiro.body.pacote.id]);
      const registros = (await pacotes()).length;
      for (const mudanca of [{ finalidade: 'AUDITORIA_CLIENTE' }, { observacao: 'outra' }, { escopos: [ESC.fichas] }, { periodoFim: deslocar(-1) }]) {
        const r = await post('pacotes', { ...entradaBase({ escopos: [ESC.ghe] }), ...mudanca, chaveIdempotencia: k });
        assert.equal(r.status, 409, JSON.stringify(mudanca));
        assert.equal(r.body.codigo, 'IDEMPOTENCIA_CONFLITO');
      }
      assert.deepEqual(await g.um('SELECT * FROM fiscalizacao_pacotes WHERE id = $1', [primeiro.body.pacote.id]), antes);
      assert.equal((await pacotes()).length, registros);
    });

    test('a ordem dos escopos não muda o pedido: o hash é canônico (mesma chave, mesmos escopos em outra ordem = mesma tentativa)', async () => {
      const k = chave();
      const a = await post('pacotes', { ...entradaBase({ escopos: [ESC.ghe, ESC.fichas] }), chaveIdempotencia: k });
      const b = await post('pacotes', { ...entradaBase({ escopos: [ESC.fichas, ESC.ghe] }), chaveIdempotencia: k });
      assert.equal(a.status, 201);
      assert.equal(b.status, 200);
      assert.equal(b.body.pacote.id, a.body.pacote.id);
    });

    test('a chave é por empresa: a mesma chave em outra empresa é outra tentativa', async () => {
      const k = chave();
      const a = await post('pacotes', { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: k });
      const b = await post('pacotes', { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: k }, masterB);
      assert.equal(a.status, 201);
      assert.equal(b.status, 201);
      assert.notEqual(a.body.pacote.id, b.body.pacote.id);
    });

    test('a chave é obrigatória e limitada (formato seguro)', async () => {
      for (const ruim of [undefined, '', 'curta', 'x'.repeat(129), 'com espaço e / barra', '../x']) {
        assert.equal((await post('pacotes', { ...entradaBase(), chaveIdempotencia: ruim })).status, 400, String(ruim));
      }
    });

    test('duas requisições idênticas ao mesmo tempo: um único registro e um único arquivo', async () => {
      const k = chave();
      const antes = (await pacotes()).length;
      const arquivos = arquivosNoDisco().length;
      const [r1, r2] = await Promise.all([1, 2].map(() => post('pacotes', { ...entradaBase({ escopos: [ESC.ghe, ESC.fichas] }), chaveIdempotencia: k })));
      assert.ok([200, 201].includes(r1.status) && [200, 201].includes(r2.status), `${r1.status}/${r2.status}`);
      assert.equal(r1.body.pacote.id, r2.body.pacote.id);
      assert.equal((await pacotes()).length, antes + 1);
      assert.equal(arquivosNoDisco().length, arquivos + 1);
    });

    test('MESMA chave e MESMO pedido com a tentativa GERANDO: devolve a existente, sem segunda geração', async () => {
      const k = chave();
      const corpo = { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: k };
      const feito = await post('pacotes', corpo);
      const devolverAEstadoFinal = async (id) => {
        if (!id) return;
        await g.pool.query('ALTER TABLE fiscalizacao_pacotes DISABLE TRIGGER USER');
        try {
          await g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'FALHA', erro_codigo = 'TESTE', concluido_em = now() WHERE id = $1 AND status = 'GERANDO'", [id]);
        } finally {
          await g.pool.query('ALTER TABLE fiscalizacao_pacotes ENABLE TRIGGER USER');
        }
      };
      try {
        // volta o estado para GERANDO apenas no banco de teste, desligando o gatilho de imutabilidade
        await g.pool.query('ALTER TABLE fiscalizacao_pacotes DISABLE TRIGGER USER');
        try {
          await g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'GERANDO', concluido_em = NULL, sha256 = NULL, tamanho_bytes = NULL, chave_armazenamento = NULL, nome_logico = NULL, contagens = NULL, heartbeat_em = now() WHERE id = $1", [feito.body.pacote.id]);
        } finally {
          await g.pool.query('ALTER TABLE fiscalizacao_pacotes ENABLE TRIGGER USER');
        }
        const registros = (await pacotes()).length;
        const repetido = await post('pacotes', corpo);
        assert.equal(repetido.status, 200);
        assert.equal(repetido.body.pacote.id, feito.body.pacote.id);
        assert.equal(repetido.body.pacote.status, 'GERANDO');
        assert.equal((await pacotes()).length, registros);
      } finally {
        // sempre devolve a tentativa a um estado final, mesmo se uma asserção falhar: não contamina os testes seguintes
        await devolverAEstadoFinal(feito.body?.pacote?.id);
      }
    });
  });

  describe('concorrência: uma geração por empresa', () => {
    test('com uma geração GERANDO (heartbeat válido) da mesma empresa, outra chave recebe 409 e nada é criado; outra empresa gera normalmente', async () => {
      const [existente] = (await g.todos("SELECT 1 FROM fiscalizacao_pacotes WHERE status = 'GERANDO' AND empresa_id = $1", [g.empresas.A]));
      assert.equal(existente, undefined, 'pré-condição: nenhuma geração em andamento');
      const id = await semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: 'now()' });
      const antes = (await pacotes()).length;
      const r = await gerar({ escopos: [ESC.ghe] });
      assert.equal(r.status, 409);
      assert.equal(r.body.codigo, 'GERACAO_EM_ANDAMENTO');
      assert.equal((await pacotes()).length, antes);
      const outra = await post('pacotes', { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: chave() }, masterB);
      assert.equal(outra.status, 201, 'empresas diferentes geram em paralelo');
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes DISABLE TRIGGER USER');
      await g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'FALHA', erro_codigo = 'TESTE', concluido_em = now() WHERE id = $1", [id]);
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes ENABLE TRIGGER USER');
    });

    test('o banco só admite uma linha GERANDO por empresa (índice único parcial), mas várias de empresas diferentes', async () => {
      const a = await semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: 'now()' });
      await assert.rejects(() => semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: 'now()' }), (err) => err.code === '23505');
      const b = await semear({ empresaId: g.empresas.B, status: 'GERANDO', heartbeat: 'now()' });
      assert.ok(a && b);
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes DISABLE TRIGGER USER');
      await g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'FALHA', erro_codigo = 'TESTE', concluido_em = now() WHERE id = ANY($1)", [[a, b]]);
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes ENABLE TRIGGER USER');
    });
  });

  describe('falha por limite de 100 MiB: aborta no streaming e nunca entrega ZIP truncado', () => {
    test('estourou o tamanho: tentativa FALHA com código técnico, erro orientando reduzir o período, sem arquivo final nem temporário', async () => {
      const anterior = config.limiteBytesZip;
      config.limiteBytesZip = 400;
      const k = chave();
      try {
        const r = await post('pacotes', { ...entradaBase(), chaveIdempotencia: k });
        assert.equal(r.status, 400, JSON.stringify(r.body));
        assert.equal(r.body.codigo, 'PACOTE_EXCEDE_TAMANHO');
        assert.match(r.body.message, /reduz/i);
        const [linha] = await g.todos('SELECT * FROM fiscalizacao_pacotes WHERE chave_idempotencia = $1', [k]);
        assert.equal(linha.status, 'FALHA');
        assert.equal(linha.erro_codigo, 'ZIP_EXCEDE_LIMITE');
        assert.deepEqual([linha.sha256, linha.chave_armazenamento, linha.tamanho_bytes], [null, null, null]);
        assert.equal(arquivosNoDisco().filter((n) => String(n).includes(`pacote-${linha.id}`)).length, 0, 'nada do pacote falhado no disco');
        const dl = await baixar(linha.id);
        assert.equal(dl.status, 409, 'FALHA não baixa');
        // FALHA + mesma chave + mesmo pedido: devolve a tentativa falhada, sem reiniciar
        const registros = (await pacotes()).length;
        config.limiteBytesZip = anterior;
        const repetido = await post('pacotes', { ...entradaBase(), chaveIdempotencia: k });
        assert.equal(repetido.status, 200);
        assert.equal(repetido.body.pacote.id, linha.id);
        assert.equal(repetido.body.pacote.status, 'FALHA');
        assert.equal((await pacotes()).length, registros);
        assert.deepEqual(await g.um('SELECT status, erro_codigo FROM fiscalizacao_pacotes WHERE id = $1', [linha.id]), { status: 'FALHA', erro_codigo: 'ZIP_EXCEDE_LIMITE' });
        // nova tentativa exige NOVA chave
        const nova = await post('pacotes', { ...entradaBase(), chaveIdempotencia: chave() });
        assert.equal(nova.status, 201);
        assert.notEqual(nova.body.pacote.id, linha.id);
        assert.equal((await g.um('SELECT status FROM fiscalizacao_pacotes WHERE id = $1', [linha.id])).status, 'FALHA', 'o histórico da falha é preservado');
      } finally {
        config.limiteBytesZip = anterior;
      }
    });
  });

  describe('heartbeat da geração ativa', () => {
    test('enquanto gera, o heartbeat avança sem tocar nenhum campo de identidade; ao concluir, o pacote é CONCLUIDO', async () => {
      const { criarFiscalizacaoPacoteService } = exigirModulo('src/services/fiscalizacao-pacote.service');
      const lento = { ...armazenamento, iniciar: async (...a) => { const gv = await armazenamento.iniciar(...a); const publicar = gv.publicar; return { ...gv, publicar: async () => { await dormir(400); return publicar(); } }; } };
      const configRapida = { ...config, heartbeatMs: 40, abandonoMs: 5000 };
      const svc = criarFiscalizacaoPacoteService({ pool: g.pool, armazenamento: lento, config: configRapida });
      const k = chave();
      const rodando = svc.gerar({ empresaId: g.empresas.A, usuarioId: fiscal.id, perfil: 'USUARIO' }, { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: k });
      await dormir(120);
      const colunasIdentidade = 'empresa_id, periodo_inicio, periodo_fim, finalidade, observacao, escopos, versao_formato, usuario_id, perfil_ator, chave_idempotencia, requisicao_hash';
      const amostras = [];
      for (let i = 0; i < 4; i += 1) {
        amostras.push(await g.um(`SELECT heartbeat_em, status, ${colunasIdentidade} FROM fiscalizacao_pacotes WHERE chave_idempotencia = $1`, [k]));
        await dormir(70);
      }
      const resultado = await rodando;
      assert.equal(amostras[0].status, 'GERANDO');
      assert.ok(new Set(amostras.map((a) => a.heartbeat_em.getTime())).size >= 2, 'o heartbeat foi atualizado durante a geração');
      const { heartbeat_em: _h0, status: _s0, ...id0 } = amostras[0];
      for (const a of amostras) { const { heartbeat_em: _h, status: _s, ...idN } = a; assert.deepEqual(idN, id0); }
      assert.equal((resultado.pacote ?? resultado).status, 'CONCLUIDO');
    });
  });

  describe('recuperação de GERANDO abandonado', () => {
    const rodar = (opcoes) => servico.recuperarAbandonados(opcoes);
    const falhar = async (id) => {
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes DISABLE TRIGGER USER');
      await g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'FALHA', erro_codigo = 'TESTE', concluido_em = now() WHERE id = $1 AND status = 'GERANDO'", [id]);
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes ENABLE TRIGGER USER');
    };

    test('heartbeat válido não é recuperado; expirado vira FALHA com código técnico, preservando chave e hash da tentativa', async () => {
      const vivo = await semear({ empresaId: g.empresas.B, status: 'GERANDO', heartbeat: 'now()' });
      const morto = await semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: "now() - interval '10 minutes'" });
      const antes = await g.um('SELECT chave_idempotencia, requisicao_hash, periodo_inicio, finalidade, escopos, usuario_id FROM fiscalizacao_pacotes WHERE id = $1', [morto]);
      const r = await rodar();
      assert.equal(r.recuperados, 1);
      assert.equal((await g.um('SELECT status FROM fiscalizacao_pacotes WHERE id = $1', [vivo])).status, 'GERANDO');
      const depois = await g.um('SELECT * FROM fiscalizacao_pacotes WHERE id = $1', [morto]);
      assert.equal(depois.status, 'FALHA');
      assert.equal(depois.erro_codigo, 'GERACAO_ABANDONADA');
      assert.ok(depois.concluido_em);
      for (const k of Object.keys(antes)) assert.deepEqual(depois[k], antes[k], k);
      await falhar(vivo);
    });

    test('não usa só criado_em: geração antiga com heartbeat recente continua viva', async () => {
      const id = await semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: 'now()', criadoEm: "now() - interval '3 hours'" });
      assert.equal((await rodar()).recuperados, 0);
      assert.equal((await g.um('SELECT status FROM fiscalizacao_pacotes WHERE id = $1', [id])).status, 'GERANDO');
      await falhar(id);
    });

    test('libera a empresa: depois da recuperação uma nova geração (nova chave) é aceita; a mesma chave devolve a FALHA', async () => {
      const k = chave();
      const corpo = { ...entradaBase({ escopos: [ESC.ghe] }), chaveIdempotencia: k };
      const feito = await post('pacotes', corpo);
      assert.equal(feito.status, 201, JSON.stringify(feito.body ?? null));
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes DISABLE TRIGGER USER');
      await g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'GERANDO', concluido_em = NULL, sha256 = NULL, tamanho_bytes = NULL, chave_armazenamento = NULL, nome_logico = NULL, contagens = NULL, heartbeat_em = now() - interval '10 minutes' WHERE id = $1", [feito.body.pacote.id]);
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes ENABLE TRIGGER USER');
      assert.equal((await gerar({ escopos: [ESC.ghe] })).status, 409, 'enquanto GERANDO, bloqueia');
      await rodar();
      const mesma = await post('pacotes', corpo);
      assert.equal(mesma.status, 200);
      assert.equal(mesma.body.pacote.status, 'FALHA');
      assert.equal((await gerar({ escopos: [ESC.ghe] })).status, 201, 'empresa liberada com nova chave');
    });

    test('remove o temporário órfão e o arquivo final órfão (rename feito, registro nunca concluído); nunca vira CONCLUIDO', async () => {
      const id = await semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: "now() - interval '10 minutes'" });
      const empresaId = g.empresas.A;
      const temp = await armazenamento.iniciar({ empresaId, pacoteId: id });
      temp.escrita.write(Buffer.from('parcial'));
      await rodar();
      assert.equal(arquivosNoDisco().filter((n) => String(n).includes(`pacote-${id}`)).length, 0, 'temporário removido');
      const id2 = await semear({ empresaId, status: 'GERANDO', heartbeat: "now() - interval '10 minutes'" });
      const final = await armazenamento.iniciar({ empresaId, pacoteId: id2 });
      await new Promise((resolve) => final.escrita.end(Buffer.from('zip completo e válido'), resolve));
      await final.publicar();
      assert.equal(await armazenamento.existe(final.chave), true);
      await rodar();
      assert.equal(await armazenamento.existe(final.chave), false, 'o arquivo final órfão é removido');
      assert.equal((await g.um('SELECT status FROM fiscalizacao_pacotes WHERE id = $1', [id2])).status, 'FALHA', 'nunca promovido a CONCLUIDO');
    });

    test('duas rotinas concorrentes: só uma assume o registro; a recuperação é auditada uma vez, sem conteúdo', async () => {
      const id = await semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: "now() - interval '10 minutes'" });
      const [r1, r2] = await Promise.all([rodar(), rodar()]);
      assert.equal(r1.recuperados + r2.recuperados, 1);
      const logs = await g.todos("SELECT * FROM logs_auditoria WHERE acao = 'FISCALIZACAO_PACOTE_ABANDONADO' AND referencia = $1", [String(id)]);
      assert.equal(logs.length, 1);
      assert.equal(/pacote-|\.zip|SEGREDO/.test(JSON.stringify(logs)), false);
    });

    test('o abandono é configurável: com 120 s padrão, 60 s de silêncio ainda é válido; com 30 s, já é abandono', async () => {
      const id = await semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: "now() - interval '60 seconds'" });
      assert.equal((await rodar()).recuperados, 0);
      const anterior = config.abandonoMs;
      config.abandonoMs = 30000;
      try { assert.equal((await rodar()).recuperados, 1); } finally { config.abandonoMs = anterior; }
      assert.equal((await g.um('SELECT status FROM fiscalizacao_pacotes WHERE id = $1', [id])).status, 'FALHA');
    });
  });

  describe('download autorizado, isolado por empresa e íntegro', () => {
    let alvoGerado;
    const preparar = async () => {
      if (!alvoGerado) {
        const r = await gerar({ escopos: [ESC.fichas, ESC.estoque] });
        assert.equal(r.status, 201, JSON.stringify(r.body));
        alvoGerado = r.body.pacote;
      }
      return alvoGerado;
    };

    test('a mesma empresa baixa: application/zip, nome seguro do servidor, conteúdo igual ao hash registrado', async () => {
      const alvo = await preparar();
      const r = await baixar(alvo.id);
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /application\/zip/);
      assert.match(r.headers['content-disposition'], /^attachment; filename="[A-Za-z0-9._-]+\.zip"/);
      assert.equal(/Conferência|AUDITORIA/i.test(r.headers['content-disposition']), false, 'nome sem texto do usuário');
      assert.equal(crypto.createHash('sha256').update(r.body).digest('hex'), alvo.sha256);
    });

    test('outra empresa recebe o MESMO 404 do inexistente (detalhe, download e histórico não vazam)', async () => {
      const alvo = await preparar();
      const outra = await baixar(alvo.id, masterB);
      const inexistente = await baixar(999999, masterB);
      assert.equal(outra.status, 404);
      assert.equal(inexistente.status, 404);
      assert.deepEqual(outra.body.toString(), inexistente.body.toString());
      assert.equal((await get(`pacotes/${alvo.id}`, masterB)).status, 404);
      const lista = await get('pacotes?limite=100', masterB);
      assert.equal(lista.body.itens.some((p) => String(p.id) === String(alvo.id)), false);
    });

    test('sem a permissão, 403; ids inválidos, 400', async () => {
      const alvo = await preparar();
      assert.equal((await baixar(alvo.id, auditor)).status, 403);
      for (const ruim of ['abc', '0', '-1', '1.5', '9999999999999999999']) {
        assert.equal((await g.request(g.app).get(`${BASE}/pacotes/${ruim}/download`).set('Cookie', await como(fiscal))).status, 400, ruim);
      }
    });

    test('arquivo adulterado no disco: o hash é reconferido, o download falha (500) e nenhum byte do ZIP é entregue', async () => {
      const alvo = await preparar();
      const [linha] = await g.todos('SELECT chave_armazenamento FROM fiscalizacao_pacotes WHERE id = $1', [alvo.id]);
      const caminho = path.join(diretorio, linha.chave_armazenamento);
      const original = fs.readFileSync(caminho);
      fs.writeFileSync(caminho, Buffer.concat([original, Buffer.from('X')]));
      try {
        const r = await baixar(alvo.id);
        assert.equal(r.status, 500);
        assert.equal(/application\/zip/.test(r.headers['content-type'] ?? ''), false);
        assert.equal(r.body.length < original.length, true, 'nada do arquivo adulterado foi entregue');
      } finally { fs.writeFileSync(caminho, original); }
      assert.equal((await baixar(alvo.id)).status, 200);
    });

    test('pacote GERANDO ou FALHA não é baixável (409); arquivo ausente do disco dá erro controlado, sem caminho na resposta', async () => {
      const alvo = await preparar();
      const id = await semear({ empresaId: g.empresas.A, status: 'GERANDO', heartbeat: 'now()' });
      assert.equal((await baixar(id)).status, 409);
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes DISABLE TRIGGER USER');
      await g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'FALHA', erro_codigo = 'TESTE', concluido_em = now() WHERE id = $1", [id]);
      await g.pool.query('ALTER TABLE fiscalizacao_pacotes ENABLE TRIGGER USER');
      assert.equal((await baixar(id)).status, 409);
      const [linha] = await g.todos('SELECT chave_armazenamento FROM fiscalizacao_pacotes WHERE id = $1', [alvo.id]);
      const caminho = path.join(diretorio, linha.chave_armazenamento);
      const original = fs.readFileSync(caminho);
      fs.rmSync(caminho);
      try {
        const r = await baixar(alvo.id);
        assert.ok([404, 500].includes(r.status));
        assert.equal(r.body.toString().includes(diretorio), false, 'sem caminho local na resposta');
      } finally { fs.writeFileSync(caminho, original); }
    });
  });

  describe('revalidação do limite na geração (dados mudam entre a prévia e a geração)', () => {
    test('a geração revalida no backend mesmo depois de uma prévia válida', async () => {
      const anterior = config.limiteLinhasPorModulo;
      config.limiteLinhasPorModulo = 1;
      const dia = deslocar(-10);
      try {
        const A = g.empresas.A;
        const corpo = { periodoInicio: dia, periodoFim: dia, escopos: [ESC.fichas] };
        const p = await previa(corpo);
        assert.equal(p.status, 200, JSON.stringify(p.body ?? null));
        assert.deepEqual([p.body.previa.escopos[0].linhas, p.body.previa.podeGerar], [0, true]);
        for (let i = 0; i < 2; i += 1) {
          await entrega(A, e.fichaAna, 'Ana Sapateira', 'M-001', 'Produção', e.luva, e.loteLuva, { modo: 'ACEITE_PRESENCIAL' }, dia);
        }
        const antes = (await pacotes()).length;
        const ger = await gerar(corpo);
        assert.equal(ger.status, 400, 'duas entregas novas estouraram o limite depois da prévia');
        assert.equal(ger.body.codigo, 'LIMITE_LINHAS_EXCEDIDO');
        assert.equal(ger.body.detalhes.modulo, ESC.fichas);
        assert.equal((await pacotes()).length, antes, 'nenhum registro criado');
      } finally { config.limiteLinhasPorModulo = anterior; }
    });
  });

  describe('imutabilidade: pacote concluído nunca muda nem é reconstruído com dados atuais', () => {
    test('depois de novos dados no sistema, o download devolve exatamente os mesmos bytes e o mesmo hash', async () => {
      const r = await gerar({ escopos: [ESC.fichas, ESC.estoque, ESC.ghe] });
      assert.equal(r.status, 201, JSON.stringify(r.body ?? null));
      const antes = await baixar(r.body.pacote.id);
      assert.equal(antes.status, 200, JSON.stringify(antes.body ?? null));
      const A = g.empresas.A;
      await entrega(A, e.fichaAna, 'Ana Sapateira', 'M-001', 'Produção', e.luva, e.loteLuva, { modo: 'ACEITE_PRESENCIAL' }, deslocar(-1));
      await baixarLote(g.pool, { empresaId: A, loteId: e.loteBotina, quantidade: 3, usuarioId: master.usuarioId });
      await criarGhe(g.pool, A, 'GHE criado depois');
      const depois = await baixar(r.body.pacote.id);
      assert.equal(depois.status, 200);
      assert.equal(Buffer.compare(antes.body, depois.body), 0);
      assert.equal((await g.um('SELECT sha256 FROM fiscalizacao_pacotes WHERE id = $1', [r.body.pacote.id])).sha256, r.body.pacote.sha256);
      const novo = await gerar({ escopos: [ESC.ghe] });
      assert.equal(novo.status, 201, JSON.stringify(novo.body ?? null));
      assert.match(lerZip((await baixar(novo.body.pacote.id)).body)[`${ARQUIVOS[ESC.ghe]}.json`].toString(), /GHE criado depois/);
    });

    test('no banco: UPDATE, DELETE e TRUNCATE de pacote concluído falham, inclusive pelo hash e pelo heartbeat', async () => {
      const r = await gerar({ escopos: [ESC.ghe] });
      assert.equal(r.status, 201, JSON.stringify(r.body ?? null));
      const id = r.body.pacote.id;
      for (const sql of [
        "UPDATE fiscalizacao_pacotes SET sha256 = repeat('a', 64) WHERE id = $1",
        'UPDATE fiscalizacao_pacotes SET heartbeat_em = now() WHERE id = $1',
        "UPDATE fiscalizacao_pacotes SET status = 'FALHA' WHERE id = $1",
        "UPDATE fiscalizacao_pacotes SET finalidade = 'OUTRA' WHERE id = $1",
        'UPDATE fiscalizacao_pacotes SET observacao = NULL WHERE id = $1',
        'DELETE FROM fiscalizacao_pacotes WHERE id = $1',
      ]) await assert.rejects(() => g.pool.query(sql, [id]), /imut|prote|permit/i, sql);
      await assert.rejects(() => g.pool.query('TRUNCATE fiscalizacao_pacotes'), /imut|prote|permit|TRUNCATE/i);
    });
  });

  describe('migration 080 — fiscalizacao_pacotes (schema temporário)', () => {
    test('colunas, tipos e constraints de coerência', async () => {
      const cols = (await g.todos("SELECT column_name FROM information_schema.columns WHERE table_name = 'fiscalizacao_pacotes' AND table_schema = current_schema()")).map((c) => c.column_name);
      for (const c of ['id', 'empresa_id', 'periodo_inicio', 'periodo_fim', 'finalidade', 'observacao', 'escopos', 'versao_formato', 'usuario_id', 'perfil_ator', 'criado_em',
        'status', 'heartbeat_em', 'concluido_em', 'erro_codigo', 'contagens', 'nome_logico', 'tamanho_bytes', 'sha256', 'chave_armazenamento', 'chave_idempotencia', 'requisicao_hash']) {
        assert.ok(cols.includes(c), `coluna ${c}`);
      }
      const ruins = [
        { finalidade: 'CURIOSIDADE' }, { escopos: "'[]'::jsonb" }, { escopos: `'["PGR"]'::jsonb` }, { status: 'PRONTO' }, { requisicao_hash: "'xyz'" },
        { periodo_fim: "(now() - interval '400 days')::date" }, { versao_formato: '0' }, { observacao: "repeat('x', 501)" },
      ];
      for (const ruim of ruins) await assert.rejects(() => semear({ empresaId: g.empresas.B, status: 'FALHA', ...ruim }), (err) => ['23514', '22001', '23502'].includes(err.code), JSON.stringify(ruim));
    });

    test('CONCLUIDO exige hash, tamanho, chave e data; GERANDO e FALHA não podem carregá-los; a nova linha nasce GERANDO com heartbeat', async () => {
      await assert.rejects(() => semear({ empresaId: g.empresas.B, status: 'CONCLUIDO' }), (err) => err.code === '23514');
      await assert.rejects(() => semear({ empresaId: g.empresas.B, status: 'GERANDO', heartbeat: 'NULL' }), (err) => ['23514', '23502'].includes(err.code));
      await assert.rejects(() => semear({ empresaId: g.empresas.B, status: 'GERANDO', sha256: "repeat('a', 64)" }), (err) => err.code === '23514');
    });

    test('UNIQUE (empresa_id, chave_idempotencia)', async () => {
      const k = chave();
      const a = await semear({ empresaId: g.empresas.B, status: 'FALHA', chave: k });
      assert.ok(a);
      await assert.rejects(() => semear({ empresaId: g.empresas.B, status: 'FALHA', chave: k }), (err) => err.code === '23505');
      assert.ok(await semear({ empresaId: g.empresas.A, status: 'FALHA', chave: k }), 'a chave é por empresa');
    });

    test('transições: GERANDO só vai a CONCLUIDO ou FALHA; final nunca muda; identidade nunca muda; heartbeat só em GERANDO', async () => {
      const id = await semear({ empresaId: g.empresas.B, status: 'GERANDO', heartbeat: 'now()' });
      await g.pool.query('UPDATE fiscalizacao_pacotes SET heartbeat_em = now() WHERE id = $1', [id]);
      for (const coluna of ['empresa_id = empresa_id + 1000000', "periodo_inicio = periodo_inicio - 1", "periodo_fim = periodo_fim + 1",
        "finalidade = 'OUTRA'", "observacao = 'alterada'", "escopos = '[\"TRILHA_AUDITORIA\"]'::jsonb", "versao_formato = 2", "usuario_id = usuario_id + 1", "perfil_ator = 'ADMIN'",
        "chave_idempotencia = 'k-outra-chave-1'", `requisicao_hash = repeat('b', 64)`, "criado_em = criado_em - interval '1 day'"]) {
        await assert.rejects(() => g.pool.query(`UPDATE fiscalizacao_pacotes SET ${coluna} WHERE id = $1`, [id]), (err) => ['P0001', '23503', '23514', '23505'].includes(err.code) || /imut|prote|permit/i.test(err.message), coluna);
      }
      await assert.rejects(() => g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'CONCLUIDO' WHERE id = $1", [id]), (err) => err.code === '23514' || /permit|imut/i.test(err.message));
      await g.pool.query(`UPDATE fiscalizacao_pacotes SET status = 'CONCLUIDO', concluido_em = now(), sha256 = repeat('c', 64), tamanho_bytes = 10, nome_logico = 'x.zip',
        chave_armazenamento = '1/pacote-1.zip', contagens = '{}'::jsonb WHERE id = $1`, [id]);
      await assert.rejects(() => g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'FALHA', erro_codigo = 'X' WHERE id = $1", [id]), /permit|imut|prote/i);
      await assert.rejects(() => g.pool.query('UPDATE fiscalizacao_pacotes SET heartbeat_em = now() WHERE id = $1', [id]), /permit|imut|prote/i);
      const f = await semear({ empresaId: g.empresas.B, status: 'GERANDO', heartbeat: 'now()' });
      await g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'FALHA', erro_codigo = 'X', concluido_em = now() WHERE id = $1", [f]);
      await assert.rejects(() => g.pool.query("UPDATE fiscalizacao_pacotes SET status = 'GERANDO', erro_codigo = NULL, concluido_em = NULL WHERE id = $1", [f]), /permit|imut|prote/i);
      await assert.rejects(() => g.pool.query('DELETE FROM fiscalizacao_pacotes WHERE id = $1', [f]), /permit|imut|prote/i);
    });

    test('a FK composta isola o usuário por empresa: usuário de outra empresa não pode gerar pacote', async () => {
      await assert.rejects(() => semear({ empresaId: g.empresas.A, status: 'FALHA', usuarioId: masterB.usuarioId }), (err) => err.code === '23503');
    });
  });

  let sequencia = 0;
  /** Insere uma linha de pacote direto no banco (cenários de estado). Valores em SQL só aqui, no teste, nunca do cliente. */
  async function semear({
    empresaId, status, heartbeat = 'now()', criadoEm = 'now()', chave: k = null, usuarioId = null, finalidade = 'AUDITORIA_INTERNA', escopos = `'["REGRAS_GHE"]'::jsonb`,
    requisicao_hash: hash = "repeat('a', 64)", periodo_fim: fim = 'current_date', versao_formato: versao = '1', observacao = 'NULL', sha256 = 'NULL',
  }) {
    sequencia += 1;
    const usuario = usuarioId ?? (empresaId === g.empresas.A ? master.usuarioId : masterB.usuarioId);
    const final = status === 'CONCLUIDO'
      ? { concluido: 'now()', sha: "repeat('d', 64)", tam: '10', chave: "'x/pacote-1.zip'", nome: "'x.zip'", cont: "'{}'::jsonb" }
      : { concluido: status === 'FALHA' ? 'now()' : 'NULL', sha: sha256, tam: 'NULL', chave: 'NULL', nome: 'NULL', cont: 'NULL' };
    const sql = `INSERT INTO fiscalizacao_pacotes (empresa_id, periodo_inicio, periodo_fim, finalidade, observacao, escopos, versao_formato, usuario_id, perfil_ator,
      criado_em, status, heartbeat_em, concluido_em, erro_codigo, contagens, nome_logico, tamanho_bytes, sha256, chave_armazenamento, chave_idempotencia, requisicao_hash)
      VALUES ($1, current_date - 5, ${fim}, '${finalidade}', ${observacao}, ${escopos}, ${versao}, $2, 'MASTER', ${criadoEm}, '${status}', ${heartbeat}, ${final.concluido},
      ${status === 'FALHA' ? "'SEMEADO'" : 'NULL'}, ${final.cont}, ${final.nome}, ${final.tam}, ${final.sha}, ${final.chave}, $3, ${hash}) RETURNING id`;
    return (await g.pool.query(sql, [empresaId, usuario, k ?? `semente-${sequencia}-${crypto.randomUUID()}`])).rows[0].id;
  }
});
