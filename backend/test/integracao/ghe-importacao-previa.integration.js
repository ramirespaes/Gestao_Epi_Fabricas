'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarGrupoHomogeneoExposicaoController } = require('../../src/controllers/grupo-homogeneo-exposicao.controller');
const { criarGrupoHomogeneoExposicaoRoutes } = require('../../src/routes/grupo-homogeneo-exposicao.routes');

/**
 * Incremento 5B (RED): PREVIEW read-only da importação GHE / EPI.
 *
 *   POST /api/grupos-homogeneos/importacao/preview
 *   body  { linhas: [ { ghe, descricao, epi, classificacao, linha? } ] }   1 a 1000 linhas, cada campo texto (até 500) ou nulo
 *   200   { status:'ok', resumo, ghes, linhas }                            o mesmo contrato do núcleo (utils/ghe-importacao)
 *
 * O servidor é a autoridade: recebe as linhas como vieram da planilha (o navegador só leu o XLSX), normaliza, resolve GHE e
 * tipo contra o banco da EMPRESA DA SESSÃO e devolve a fotografia. Nada é gravado, nem auditoria; nenhuma transação de escrita.
 * Permissão: `employeeGroups` criar E editar (visualizar não basta). Carregamento em lote: três leituras por empresa
 * (GHEs, tipos, vínculos), resolvidas em memória — o número de consultas não cresce com o número de linhas.
 *
 * LIMITE HTTP: o parser global (conteudo.js, usado por app.js e por criarAppTeste) segue em 32 KiB e isenta APENAS esta rota;
 * a rota aplica o parser de 512 KiB DEPOIS da sessão e da permissão. Acima de 512 KiB: 413 PAYLOAD_MUITO_GRANDE (o mesmo
 * tratamento de sempre). Acima de 1000 linhas: 400 VALIDACAO em body.linhas, mesmo que o JSON caiba em 512 KiB.
 *
 * Os módulos novos (rotas e controller) ainda não existem no RED: o teste os monta se existirem; sem eles a rota não existe.
 */

const URL_PREVIA = '/api/grupos-homogeneos/importacao/preview';
const KIB = 1024;
const TABELAS_DO_DOMINIO = ['grupos_homogeneos_exposicao', 'ghe_tipos_material', 'ghe_materiais', 'tipos_material', 'materiais', 'funcionarios', 'logs_auditoria'];

function carregarModulosDaImportacao() {
  try {
    return {
      rotas: require('../../src/routes/ghe-importacao.routes'),
      controller: require('../../src/controllers/ghe-importacao.controller'),
    };
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && /ghe-importacao/.test(erro.message)) return null;
    throw erro;
  }
}

const l = (ghe, descricao, epi, classificacao, extra = {}) => ({ ghe, descricao, epi, classificacao, ...extra });

describe('importação GHE/EPI — preview read-only (PostgreSQL real)', () => {
  let ctx;
  let d;
  let app;
  let gestor;
  let gestorB;
  let soCriar;
  let soEditar;
  let soVer;
  let semNada;
  let seq = 0;
  const A = {};
  const B = {};

  const como = (id) => ({
    post: (url, corpo) => request(app).post(url).set(CABECALHO, String(id)).send(corpo),
  });
  const q = (sql, params) => ctx.pool.query(sql, params);
  const previa = (corpo, quem = gestor) => como(quem).post(URL_PREVIA, corpo);

  async function usuarioCom(empresaId, operacoes) {
    seq += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `ghe-importacao-${seq}@example.invalid`, 'USUARIO');
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    await q(
      `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
       VALUES ($1, $2, 'employeeGroups', $3, $4, $5, false, $6)`,
      [empresaId, id, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), mestre],
    );
    return id;
  }
  const semearTipo = async (empresaId, nome, ativo = true) => (await q(
    'INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, ativo, origem) VALUES ($1, \'EPI\', \'Proteção da cabeça\', $2, $3, \'MANUAL\') RETURNING id', [empresaId, nome, ativo],
  )).rows[0].id;
  const semearGhe = async (empresaId, nome, codigo, ativo = true) => (await q(
    'INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, codigo, ativo) VALUES ($1, $2, $3, $4) RETURNING id', [empresaId, nome, codigo, ativo],
  )).rows[0].id;
  const ligar = (empresaId, gheId, tipoId, classificacao) => q(
    'INSERT INTO ghe_tipos_material (empresa_id, grupo_homogeneo_id, tipo_material_id, classificacao) VALUES ($1, $2, $3, $4)', [empresaId, gheId, tipoId, classificacao],
  );

  /** Fotografia do domínio: contagem e hash do conteúdo de cada tabela que o preview jamais pode tocar. */
  async function foto() {
    const resultado = {};
    for (const tabela of TABELAS_DO_DOMINIO) {
      resultado[tabela] = (await q(
        `SELECT count(*)::int AS n, md5(COALESCE(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS h FROM ${tabela} x`,
      )).rows[0];
    }
    return resultado;
  }

  /** Corpo JSON com exatamente `alvo` bytes (ASCII), com até 1000 linhas e campos longos (a validade das linhas não importa aqui). */
  function corpoComBytes(alvo) {
    const linhaBase = () => l('GHE-001', 'a'.repeat(400), 'b'.repeat(400), 'OBRIGATORIO');
    const bytesDaLinha = Buffer.byteLength(JSON.stringify(linhaBase())) + 1;
    const n = Math.floor(alvo / bytesDaLinha);
    const linhas = Array.from({ length: n }, linhaBase);
    let falta = alvo - Buffer.byteLength(JSON.stringify({ linhas }));
    for (let i = 0; falta > 0 && i < linhas.length; i += 1) {
      const extra = Math.min(100, falta);
      linhas[i].descricao += 'a'.repeat(extra);
      falta -= extra;
    }
    const texto = JSON.stringify({ linhas });
    assert.ok(linhas.length <= 1000 && falta === 0 && Buffer.byteLength(texto) === alvo, `montagem do corpo de teste: ${Buffer.byteLength(texto)} de ${alvo}`);
    return texto;
  }
  const enviarTexto = (quem, texto) => (quem === null
    ? request(app).post(URL_PREVIA)
    : request(app).post(URL_PREVIA).set(CABECALHO, String(quem))).set('Content-Type', 'application/json').send(texto);

  /**
   * Consultas que tocam o domínio de GHE/tipos durante `fn` (as do preview, não as de sessão e permissão). O pool do pg
   * chama `this.connect(callback)` por dentro de pool.query: essa forma é só repassada (já foi contada em pool.query).
   * A forma com promise instrumenta cada cliente uma vez e o restaura no fim.
   */
  async function consultasDeDominio(t, fn) {
    const sqls = [];
    const texto = (arg) => (typeof arg === 'string' ? arg : (arg && arg.text) || '');
    const consultar = ctx.pool.query.bind(ctx.pool);
    const conectar = ctx.pool.connect.bind(ctx.pool);
    const instrumentados = new Set();
    t.mock.method(ctx.pool, 'query', (...args) => { sqls.push(texto(args[0])); return consultar(...args); });
    t.mock.method(ctx.pool, 'connect', (...args) => {
      if (typeof args[0] === 'function') return conectar(...args);
      return conectar(...args).then((cliente) => {
        if (!instrumentados.has(cliente)) {
          instrumentados.add(cliente);
          const original = cliente.query;
          cliente.query = function consultaContada(...a) { sqls.push(texto(a[0])); return original.apply(this, a); };
        }
        return cliente;
      });
    });
    try {
      await fn();
    } finally {
      for (const cliente of instrumentados) delete cliente.query;
    }
    return sqls.filter((s) => /grupos_homogeneos_exposicao|tipos_material|ghe_tipos_material|ghe_materiais/i.test(s));
  }

  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    const modulos = carregarModulosDaImportacao();
    app = criarAppTeste((a) => {
      a.use('/api', criarGrupoHomogeneoExposicaoRoutes({ controller: criarGrupoHomogeneoExposicaoController({ pool }), exigirSessao, pool }));
      if (modulos) {
        a.use('/api', modulos.rotas.criarGheImportacaoRoutes({ controller: modulos.controller.criarGheImportacaoController({ pool }), exigirSessao, pool }));
      }
    });
    gestor = await usuarioCom(d.empresaA, ['visualizar', 'criar', 'editar']);
    gestorB = await usuarioCom(d.empresaB, ['visualizar', 'criar', 'editar']);
    soCriar = await usuarioCom(d.empresaA, ['criar']);
    soEditar = await usuarioCom(d.empresaA, ['editar']);
    soVer = await usuarioCom(d.empresaA, ['visualizar']);
    semNada = await usuarioCom(d.empresaA, []);

    // Empresa A: catálogo, GHEs (ativo, legado sem código, inativo, outro) e vínculos.
    A.capacete = await semearTipo(d.empresaA, 'Capacete');
    A.luva = await semearTipo(d.empresaA, 'Luva de Raspa');
    A.protetor = await semearTipo(d.empresaA, 'Protetor Auricular');
    A.botaVelha = await semearTipo(d.empresaA, 'Bota Antiga', false);
    for (let i = 1; i <= 25; i += 1) await semearTipo(d.empresaA, `EPI ${String(i).padStart(2, '0')}`);
    A.soldagem = await semearGhe(d.empresaA, 'Soldagem', 'GHE-001');
    A.pintura = await semearGhe(d.empresaA, 'Pintura', null);
    A.almoxarifado = await semearGhe(d.empresaA, 'Almoxarifado', 'GHE-003', false);
    A.caldeiraria = await semearGhe(d.empresaA, 'Caldeiraria', 'GHE-004');
    A.fora = await semearGhe(d.empresaA, 'Fora da planilha', 'GHE-005');
    await ligar(d.empresaA, A.soldagem, A.capacete, 'OBRIGATORIO');
    await ligar(d.empresaA, A.soldagem, A.protetor, 'OBRIGATORIO');
    await ligar(d.empresaA, A.fora, A.luva, 'OBRIGATORIO');
    // Empresa B: o mesmo código com outra descrição, um tipo só dela e um GHE só dela.
    B.capacete = await semearTipo(d.empresaB, 'Capacete');
    B.soDaB = await semearTipo(d.empresaB, 'Tipo só da B');
    B.montagem = await semearGhe(d.empresaB, 'Montagem B', 'GHE-001');
    B.soDaBGhe = await semearGhe(d.empresaB, 'Só da B', 'GHE-777');
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  const mista = () => [
    l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'),
    l('GHE-001', 'Soldagem', 'Luva de Raspa', 'Não obrigatório'),
    l('GHE-001', 'Soldagem', 'Protetor Auricular', 'Não obrigatório'),
    l('GHE-010', 'Pintura', 'Capacete', 'Obrigatório'),
    l('GHE-020', 'Montagem Nova', 'Luva de Raspa', 'Obrigatório'),
    l('GHE-003', 'Almoxarifado', 'Capacete', 'Obrigatório'),
    l('GHE-004', 'Outra coisa', 'Capacete', 'Obrigatório'),
    l('GHE-021', 'Nova 2', 'Inexistente', 'Obrigatório'),
    l('GHE-021', 'Nova 2', 'Bota Antiga', 'Obrigatório'),
    l('GHE-X', '', '', 'talvez'),
    l('', '', '', ''),
    l('GHE-020', 'Montagem Nova', 'Luva de Raspa', 'OBRIGATÓRIO'),
  ];

  describe('módulos e montagem', () => {
    test('as rotas e o controller existem e a aplicação monta a importação GHE/EPI', () => {
      assert.ok(carregarModulosDaImportacao(), 'src/routes/ghe-importacao.routes.js e src/controllers/ghe-importacao.controller.js');
      const app_ = fs.readFileSync(path.join(__dirname, '../../src/app.js'), 'utf8');
      assert.match(app_, /ghe-importacao\.routes/);
      assert.match(app_, /gheImportacaoRoutes/);
    });
  });

  describe('autorização', () => {
    test('exige criar E editar GHE: quem só cria, só edita, só vê ou não tem permissão recebe 403; sem sessão é 401; quem tem as duas passa', async () => {
      const corpo = { linhas: [l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório')] };
      for (const quem of [soCriar, soEditar, soVer, semNada]) {
        const r = await previa(corpo, quem);
        assert.equal(r.status, 403, `${quem} → ${JSON.stringify(r.body)}`);
      }
      assert.equal((await request(app).post(URL_PREVIA).send(corpo)).status, 401);
      const ok = await previa(corpo);
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.status, 'ok');
      assert.deepEqual(Object.keys(ok.body).sort(), ['ghes', 'linhas', 'resumo', 'status']);
    });
  });

  describe('contrato do corpo', () => {
    test('corpo inválido: 400 VALIDACAO (sem linhas, lista vazia, não-lista, campo extra, valor que não é texto)', async () => {
      const casos = [
        {}, { linhas: [] }, { linhas: 'x' }, { linhas: [l('GHE-001', 'A', 'Capacete', 'Obrigatório')], empresaId: 1 },
        { linhas: [{ ...l('GHE-001', 'A', 'Capacete', 'Obrigatório'), empresaId: 1 }] },
        { linhas: [{ ...l('GHE-001', 'A', 'Capacete', 'Obrigatório'), ativo: true }] },
        { linhas: [l(1, 'A', 'Capacete', 'Obrigatório')] }, { linhas: [l('GHE-001', {}, 'Capacete', 'Obrigatório')] },
        { linhas: [l('GHE-001', 'A', 'Capacete', 'Obrigatório', { linha: 'dois' })] }, { linhas: [l('GHE-001', 'x'.repeat(501), 'Capacete', 'Obrigatório')] },
      ];
      for (const corpo of casos) {
        const r = await previa(corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo).slice(0, 120));
        assert.equal(r.body.codigo, 'VALIDACAO');
      }
    });

    test('linha inválida ou vazia dentro do lote NÃO derruba o preview: 200 com a linha reportada', async () => {
      const r = await previa({ linhas: [l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'), l('GHE-X', '', '', 'talvez'), l('', '', '', '')] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.linhas.map((x) => x.situacao), ['VINCULO_EXISTENTE', 'LINHA_INVALIDA']);
      assert.equal(r.body.resumo.linhasIgnoradas, 1);
    });
  });

  describe('resultado por linha e resumo (lote misto)', () => {
    test('cada linha traz a situação do GHE e do vínculo; o resumo bate; a empresa vem só da sessão', async () => {
      const r = await previa({ linhas: mista() });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const { linhas, ghes, resumo } = r.body;
      assert.deepEqual(linhas.map((x) => [x.linha, x.situacao]), [
        [2, 'VINCULO_EXISTENTE'], [3, 'NOVO_VINCULO'], [4, 'CLASSIFICACAO_ALTERADA'], [5, 'NOVO_VINCULO'], [6, 'NOVO_VINCULO'], [7, 'GHE_INATIVO'],
        [8, 'CONFLITO_GHE'], [9, 'EPI_NAO_ENCONTRADO'], [10, 'EPI_INATIVO'], [11, 'LINHA_INVALIDA'], [13, 'DUPLICADA_NO_ARQUIVO'],
      ]);
      assert.deepEqual(linhas.map((x) => x.situacaoGhe), [
        'GHE_EXISTENTE', 'GHE_EXISTENTE', 'GHE_EXISTENTE', 'LEGADO_RECEBERA_CODIGO', 'GHE_NOVO', 'GHE_EXISTENTE', 'CONFLITO_GHE', 'GHE_NOVO', 'GHE_NOVO', null, 'GHE_NOVO',
      ]);
      assert.deepEqual([linhas[0].gheId, linhas[3].gheId, linhas[4].gheId, linhas[5].gheId], [A.soldagem, A.pintura, null, A.almoxarifado]);
      assert.deepEqual([linhas[0].tipoMaterialId, linhas[1].tipoMaterialId], [A.capacete, A.luva]);
      assert.equal(linhas[5].gheInativo, true);
      assert.equal(linhas[8].tipoInativo, true);
      assert.deepEqual(linhas.filter((x) => x.aplicavel).map((x) => x.linha), [3, 4, 5, 6]);
      assert.equal(resumo.linhasRecebidas, 12);
      assert.equal(resumo.linhasIgnoradas, 1);
      assert.equal(resumo.aplicaveis, 4);
      assert.deepEqual(resumo.porSituacao, {
        VINCULO_EXISTENTE: 1, NOVO_VINCULO: 3, CLASSIFICACAO_ALTERADA: 1, GHE_INATIVO: 1, CONFLITO_GHE: 1, EPI_NAO_ENCONTRADO: 1, EPI_INATIVO: 1, LINHA_INVALIDA: 1, DUPLICADA_NO_ARQUIVO: 1,
      });
      assert.deepEqual(resumo.ghes, { GHE_EXISTENTE: 2, LEGADO_RECEBERA_CODIGO: 1, GHE_NOVO: 2, CONFLITO_GHE: 1 });
      assert.deepEqual(ghes.map((x) => [x.codigo, x.situacao, x.operacao]), [
        ['GHE-001', 'GHE_EXISTENTE', null], ['GHE-010', 'LEGADO_RECEBERA_CODIGO', 'ATRIBUIR_CODIGO'], ['GHE-020', 'GHE_NOVO', 'CRIAR'],
        ['GHE-003', 'GHE_EXISTENTE', null], ['GHE-004', 'CONFLITO_GHE', null], ['GHE-021', 'GHE_NOVO', null],
      ]);
      assert.equal(ghes.some((x) => x.codigo === 'GHE-005'), false, 'o GHE que a planilha não cita não é tocado nem listado');
    });

    test('conflito de classificação no próprio arquivo: as duas linhas são reportadas e nenhuma é aplicável', async () => {
      const r = await previa({ linhas: [l('GHE-030', 'Novo', 'Capacete', 'Obrigatório'), l('GHE-030', 'Novo', 'Capacete', 'Não obrigatório')] });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.linhas.map((x) => [x.situacao, x.aplicavel]), [['CONFLITO_NO_ARQUIVO', false], ['CONFLITO_NO_ARQUIVO', false]]);
    });
  });

  describe('zero escrita e idempotência', () => {
    test('o preview não altera GHEs, vínculos, tipos, materiais, funcionários nem auditoria — nem com 1000 linhas', async () => {
      const antes = await foto();
      for (const linhas of [mista(), volume()]) {
        const r = await previa({ linhas });
        assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      }
      assert.deepEqual(await foto(), antes);
      assert.equal((await q("SELECT count(*)::int AS n FROM logs_auditoria WHERE acao ILIKE '%IMPORT%' OR acao LIKE 'GHE_%'")).rows[0].n, 0, 'nenhuma auditoria de preview');
    });

    test('a mesma entrada duas vezes dá o mesmo preview lógico e continua sem escrever', async () => {
      const antes = await foto();
      const primeira = await previa({ linhas: mista() });
      const segunda = await previa({ linhas: mista() });
      assert.equal(primeira.status, 200);
      assert.deepEqual(segunda.body, primeira.body);
      assert.deepEqual(await foto(), antes);
    });
  });

  describe('isolamento por empresa', () => {
    test('cada empresa resolve contra o próprio banco: o mesmo código, o tipo e o GHE da outra empresa não existem para ela', async () => {
      const linhas = [l('GHE-001', 'Montagem B', 'Capacete', 'Obrigatório'), l('GHE-001', 'Montagem B', 'Tipo só da B', 'Obrigatório'), l('GHE-777', 'Só da B', 'Capacete', 'Obrigatório')];
      const daB = await previa({ linhas }, gestorB);
      assert.equal(daB.status, 200, JSON.stringify(daB.body));
      assert.deepEqual(daB.body.linhas.map((x) => [x.situacaoGhe, x.gheId, x.tipoMaterialId, x.situacao]), [
        ['GHE_EXISTENTE', B.montagem, B.capacete, 'NOVO_VINCULO'], ['GHE_EXISTENTE', B.montagem, B.soDaB, 'NOVO_VINCULO'], ['GHE_EXISTENTE', B.soDaBGhe, B.capacete, 'NOVO_VINCULO'],
      ]);

      const daA = await previa({ linhas }, gestor);
      assert.equal(daA.status, 200);
      assert.deepEqual(daA.body.linhas.map((x) => [x.situacao, x.motivo ?? null]), [['CONFLITO_GHE', 'CODIGO_COM_DESCRICAO_DIFERENTE'], ['CONFLITO_GHE', 'CODIGO_COM_DESCRICAO_DIFERENTE'], ['NOVO_VINCULO', null]]);
      const ids = daA.body.linhas.flatMap((x) => [x.gheId, x.tipoMaterialId]).filter((x) => x !== null);
      assert.ok(ids.every((id) => ![B.montagem, B.soDaBGhe, B.capacete, B.soDaB].includes(id)), 'nenhum id da outra empresa vaza');

      const soDaB = await previa({ linhas: [l('GHE-040', 'Novo A', 'Tipo só da B', 'Obrigatório')] }, gestor);
      assert.equal(soDaB.status, 200, JSON.stringify(soDaB.body));
      assert.equal(soDaB.body.linhas[0].situacao, 'EPI_NAO_ENCONTRADO');
    });
  });

  describe('sem N+1', () => {
    test('o número de consultas ao domínio é constante: 10 linhas e 1000 linhas fazem as mesmas leituras em lote', async (t) => {
      const pequeno = await consultasDeDominio(t, async () => { assert.equal((await previa({ linhas: mista().slice(0, 10) })).status, 200); });
      t.mock.restoreAll();
      const grande = await consultasDeDominio(t, async () => { assert.equal((await previa({ linhas: volume() })).status, 200); });
      assert.ok(pequeno.length >= 1, 'o preview lê o domínio');
      assert.equal(grande.length, pequeno.length, `consultas ao domínio: ${pequeno.length} (10 linhas) × ${grande.length} (1000 linhas)`);
      assert.ok(grande.length <= 6, `leitura em lote por empresa, não por linha: ${grande.length} consultas`);
    });
  });

  describe('limite HTTP: 32 KiB global, 512 KiB só nesta rota, depois da sessão e da permissão', () => {
    test('uma rota comum continua limitada a 32 KiB (413), com ou sem sessão', async () => {
      const grande = JSON.stringify({ nome: 'x', descricao: 'y'.repeat(40 * KIB) });
      for (const quem of [gestor, null]) {
        const r = await (quem === null ? request(app).post('/api/grupos-homogeneos') : request(app).post('/api/grupos-homogeneos').set(CABECALHO, String(quem)))
          .set('Content-Type', 'application/json').send(grande);
        assert.equal(r.status, 413);
        assert.equal(r.body.codigo, 'PAYLOAD_MUITO_GRANDE');
      }
    });

    test('o preview autenticado e autorizado aceita 1000 linhas válidas (bem acima de 32 KiB) e um corpo de ~508 KiB', async () => {
      const corpo = JSON.stringify({ linhas: volume() });
      assert.ok(Buffer.byteLength(corpo) > 32 * KIB && Buffer.byteLength(corpo) < 512 * KIB, `${Buffer.byteLength(corpo)} bytes`);
      const r = await enviarTexto(gestor, corpo);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.linhas.length, 1000);
      assert.equal(r.body.resumo.aplicaveis, 1000);

      const quaseNoLimite = await enviarTexto(gestor, corpoComBytes(520000));
      assert.equal(quaseNoLimite.status, 200, JSON.stringify(quaseNoLimite.body).slice(0, 200));
    });

    test('acima de 512 KiB: 413 PAYLOAD_MUITO_GRANDE, o tratamento de sempre', async () => {
      const r = await enviarTexto(gestor, corpoComBytes(530000));
      assert.equal(r.status, 413);
      assert.equal(r.body.codigo, 'PAYLOAD_MUITO_GRANDE');
    });

    test('mais de 1000 linhas é recusado (400 VALIDACAO em body.linhas) mesmo que o JSON caiba em 512 KiB; exatamente 1000 passa', async () => {
      const compactas = (n) => Array.from({ length: n }, () => l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório'));
      const corpo = JSON.stringify({ linhas: compactas(1001) });
      assert.ok(Buffer.byteLength(corpo) > 32 * KIB && Buffer.byteLength(corpo) < 512 * KIB);
      const r = await enviarTexto(gestor, corpo);
      assert.equal(r.status, 400, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.codigo, 'VALIDACAO');
      assert.ok(r.body.detalhes.some((x) => x.campo === 'body.linhas' && x.codigo === 'TAMANHO_MAXIMO'), JSON.stringify(r.body.detalhes));
      assert.equal((await enviarTexto(gestor, JSON.stringify({ linhas: compactas(1000) }))).status, 200);
    });

    test('sem sessão, o corpo grande não chega ao parser ampliado: 401 (nunca 413 nem 400)', async () => {
      const r = await enviarTexto(null, JSON.stringify({ linhas: volume() }));
      assert.equal(r.status, 401, JSON.stringify(r.body).slice(0, 200));
    });

    test('com sessão mas sem a permissão (só criar, só editar, só ver, nenhuma): 403 antes de qualquer leitura do corpo grande', async () => {
      const corpo = JSON.stringify({ linhas: volume() });
      for (const quem of [soCriar, soEditar, soVer, semNada]) {
        const r = await enviarTexto(quem, corpo);
        assert.equal(r.status, 403, `${quem} → ${JSON.stringify(r.body).slice(0, 120)}`);
      }
    });

    test('o corpo grande continua zero-write', async () => {
      const antes = await foto();
      assert.equal((await enviarTexto(gestor, corpoComBytes(520000))).status, 200);
      assert.equal((await enviarTexto(gestor, JSON.stringify({ linhas: volume() }))).status, 200);
      assert.deepEqual(await foto(), antes);
    });
  });

  /** 1000 linhas válidas: 40 GHEs novos × 25 EPIs do catálogo da empresa A. */
  function volume() {
    return Array.from({ length: 1000 }, (_, i) => l(`GHE-${String(101 + Math.floor(i / 25)).padStart(3, '0')}`, `Setor ${String(Math.floor(i / 25) + 1).padStart(2, '0')}`, `EPI ${String((i % 25) + 1).padStart(2, '0')}`, 'Obrigatório'));
  }
});
