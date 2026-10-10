'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarGrupoHomogeneoExposicaoController } = require('../../src/controllers/grupo-homogeneo-exposicao.controller');
const { criarGrupoHomogeneoExposicaoRoutes } = require('../../src/routes/grupo-homogeneo-exposicao.routes');
const { criarGheImportacaoRoutes } = require('../../src/routes/ghe-importacao.routes');
const { criarGheImportacaoController } = require('../../src/controllers/ghe-importacao.controller');

/**
 * Incremento 5C (RED): CONFIRMAÇÃO da importação GHE / EPI.
 *
 *   POST /api/grupos-homogeneos/importacao/confirmar        body { linhas: [...] }  (o mesmo contrato do preview)
 *   200 { status:'ok', importacaoId, resumo, ghes, linhas }
 *
 * O servidor NÃO confia no preview: recebe de novo as linhas originais, refaz a análise do núcleo (5A) contra o banco
 * ATUAL, dentro da transação, e grava só o que ainda faz sentido. Nada que o cliente calculou (situação, ids, contadores,
 * empresa) é aceito. Operações possíveis: criar GHE, atribuir código a GHE legado, criar vínculo GHE × tipo, alterar a
 * classificação de um vínculo. NUNCA: excluir, inativar, reativar, renumerar, criar tipo/material/ghe_materiais, mexer em
 * funcionários. A ausência de um GHE ou vínculo no arquivo não remove nada.
 *
 * Lote: linhas bloqueadas ou inválidas são reportadas e não escrevem; as demais são aplicadas na MESMA transação. Erro
 * inesperado = ROLLBACK de tudo (GHEs, códigos, vínculos e TODAS as auditorias, inclusive a do lote). Conflito de negócio
 * numa linha não derruba as outras.
 *
 * Resposta: o preview, agora com o RESULTADO real.
 *   linhas[].resultado: APLICADA | SEM_ALTERACAO (vínculo já igual, duplicata) | BLOQUEADA (conflito, inválida, inativo, EPI);
 *     a `situacao` continua sendo a do núcleo, medida contra o estado travado da transação (com os ids reais dos GHEs criados).
 *   ghes[].resultado: CRIADO | CODIGO_ATRIBUIDO | SEM_ALTERACAO | BLOQUEADO
 *   resumo: tudo do preview + aplicadas, ghesCriados, ghesComCodigoAtribuido, vinculosCriados, classificacoesAlteradas,
 *     semAlteracao, bloqueadas.
 *   importacaoId: UUID gerado pelo servidor; null quando nada foi persistido.
 *
 * Auditoria (mesma transação; só quando há ao menos uma alteração persistida):
 *   GHE_CRIADO e GHE_ALTERADO (atribuição de código; o CRUD de GHE já usa estes eventos), GHE_TIPO_MATERIAL_VINCULADO e
 *   GHE_TIPO_MATERIAL_ALTERADO (Incremento 3) — cada um com `contexto.importacaoId` — e UM evento GHE_IMPORTACAO_LOTE:
 *   referencia = importacaoId; contexto = só contadores (o contexto da auditoria tem teto de 16 KiB, então NUNCA a lista de
 *   linhas nem texto da planilha; o detalhe por linha está nos eventos individuais). Segunda confirmação sem mudança:
 *   nenhuma auditoria. DESVINCULADO nunca existe aqui.
 *
 * A rota de confirmação ainda não existe no RED: o teste a chama e recebe 404 (funcionalidade ausente).
 */

const URL_PREVIA = '/api/grupos-homogeneos/importacao/preview';
const URL_CONFIRMAR = '/api/grupos-homogeneos/importacao/confirmar';
const KIB = 1024;
const TABELAS_INTOCAVEIS = ['ghe_materiais', 'tipos_material', 'materiais', 'funcionarios'];
const TABELAS_DO_DOMINIO = ['grupos_homogeneos_exposicao', 'ghe_tipos_material', ...TABELAS_INTOCAVEIS, 'logs_auditoria'];
const ACOES_DA_IMPORTACAO = ['GHE_CRIADO', 'GHE_ALTERADO', 'GHE_TIPO_MATERIAL_VINCULADO', 'GHE_TIPO_MATERIAL_ALTERADO', 'GHE_TIPO_MATERIAL_DESVINCULADO', 'GHE_IMPORTACAO_LOTE'];

const l = (ghe, descricao, epi, classificacao, extra = {}) => ({ ghe, descricao, epi, classificacao, ...extra });

describe('importação GHE/EPI — confirmação transacional (PostgreSQL real)', () => {
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
  const T = {};
  const TB = {};

  const como = (id) => ({ post: (url, corpo) => request(app).post(url).set(CABECALHO, String(id)).send(corpo) });
  const q = (sql, params) => ctx.pool.query(sql, params);
  const confirmar = (corpo, quem = gestor) => como(quem).post(URL_CONFIRMAR, corpo);
  const previa = (corpo, quem = gestor) => como(quem).post(URL_PREVIA, corpo);

  async function usuarioCom(empresaId, operacoes) {
    seq += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `ghe-confirmacao-${seq}@example.invalid`, 'USUARIO');
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
  const ghePorCodigo = async (empresaId, codigo) => (await q('SELECT * FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND codigo = $2', [empresaId, codigo])).rows;
  const vinculosDe = async (gheId) => (await q('SELECT tipo_material_id, classificacao FROM ghe_tipos_material WHERE grupo_homogeneo_id = $1 ORDER BY tipo_material_id', [gheId])).rows;
  const auditorias = async (acao, empresaId = d.empresaA) => (await q(
    'SELECT id, acao, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 ORDER BY id', [empresaId, acao],
  )).rows;
  const totalAuditoriasDaImportacao = async () => (await q('SELECT count(*)::int AS n FROM logs_auditoria WHERE acao = ANY($1)', [ACOES_DA_IMPORTACAO])).rows[0].n;

  async function foto(tabelas = TABELAS_DO_DOMINIO) {
    const resultado = {};
    for (const tabela of tabelas) {
      resultado[tabela] = (await q(
        `SELECT count(*)::int AS n, md5(COALESCE(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS h FROM ${tabela} x`,
      )).rows[0];
    }
    return resultado;
  }

  function corpoComBytes(alvo) {
    const base = () => l('GHE-001', 'a'.repeat(400), 'b'.repeat(400), 'OBRIGATORIO');
    const n = Math.floor(alvo / (Buffer.byteLength(JSON.stringify(base())) + 1));
    const linhas = Array.from({ length: n }, base);
    let falta = alvo - Buffer.byteLength(JSON.stringify({ linhas }));
    for (let i = 0; falta > 0 && i < linhas.length; i += 1) { const extra = Math.min(100, falta); linhas[i].descricao += 'a'.repeat(extra); falta -= extra; }
    const texto = JSON.stringify({ linhas });
    assert.ok(linhas.length <= 1000 && Buffer.byteLength(texto) === alvo, `corpo de teste: ${Buffer.byteLength(texto)} de ${alvo}`);
    return texto;
  }
  const enviarTexto = (quem, texto) => (quem === null ? request(app).post(URL_CONFIRMAR) : request(app).post(URL_CONFIRMAR).set(CABECALHO, String(quem)))
    .set('Content-Type', 'application/json').send(texto);

  /** 1000 linhas válidas: 40 GHEs novos × 25 EPIs do catálogo da empresa A (códigos GHE-301 a GHE-340). */
  const volume = () => Array.from({ length: 1000 }, (_, i) => l(
    `GHE-${String(301 + Math.floor(i / 25)).padStart(3, '0')}`, `Volume ${String(Math.floor(i / 25) + 1).padStart(2, '0')}`, `EPI ${String((i % 25) + 1).padStart(2, '0')}`, 'Obrigatório',
  ));

  /** Falha injetada pelo banco numa inserção de auditoria: simula erro inesperado no meio ou no fim do lote. */
  async function comFalhaNaAuditoria(condicaoSql, fn) {
    await q(`CREATE OR REPLACE FUNCTION teste_falha_auditoria() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha injetada pelo teste'; END $$`);
    await q(`CREATE TRIGGER trg_teste_falha_auditoria BEFORE INSERT ON logs_auditoria FOR EACH ROW WHEN (${condicaoSql}) EXECUTE FUNCTION teste_falha_auditoria()`);
    try { return await fn(); } finally { await q('DROP TRIGGER IF EXISTS trg_teste_falha_auditoria ON logs_auditoria'); }
  }

  /** Cadeia de auditoria de um vínculo: ALTERADOs encadeados a partir do estado inicial, terminando no valor persistido. */
  async function conferirCadeia(gheId, tipoId, inicial) {
    const eventos = (await auditorias('GHE_TIPO_MATERIAL_ALTERADO')).filter((e) => e.referencia === String(gheId) && e.dados_novos.tipoMaterialId === tipoId);
    let atual = inicial;
    for (const e of eventos) {
      assert.equal(e.dados_anteriores.classificacao, atual, 'cada alteração parte do estado realmente anterior');
      assert.notEqual(e.dados_novos.classificacao, atual);
      atual = e.dados_novos.classificacao;
    }
    const linhas = await vinculosDe(gheId);
    assert.equal(linhas.filter((v) => v.tipo_material_id === tipoId).length, 1, 'uma linha só');
    assert.equal(linhas.find((v) => v.tipo_material_id === tipoId).classificacao, atual, 'a auditoria termina no valor persistido');
  }

  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    app = criarAppTeste((a) => {
      a.use('/api', criarGrupoHomogeneoExposicaoRoutes({ controller: criarGrupoHomogeneoExposicaoController({ pool }), exigirSessao, pool }));
      a.use('/api', criarGheImportacaoRoutes({ controller: criarGheImportacaoController({ pool }), exigirSessao, pool }));
    });
    gestor = await usuarioCom(d.empresaA, ['visualizar', 'criar', 'editar']);
    gestorB = await usuarioCom(d.empresaB, ['visualizar', 'criar', 'editar']);
    soCriar = await usuarioCom(d.empresaA, ['criar']);
    soEditar = await usuarioCom(d.empresaA, ['editar']);
    soVer = await usuarioCom(d.empresaA, ['visualizar']);
    semNada = await usuarioCom(d.empresaA, []);
    T.capacete = await semearTipo(d.empresaA, 'Capacete');
    T.luva = await semearTipo(d.empresaA, 'Luva de Raspa');
    T.protetor = await semearTipo(d.empresaA, 'Protetor Auricular');
    T.botaVelha = await semearTipo(d.empresaA, 'Bota Antiga', false);
    for (let i = 1; i <= 25; i += 1) await semearTipo(d.empresaA, `EPI ${String(i).padStart(2, '0')}`);
    TB.capacete = await semearTipo(d.empresaB, 'Capacete');
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  describe('autorização e contrato do corpo', () => {
    test('exige criar E editar GHE (403 para quem só cria, só edita, só vê ou nada); sem sessão é 401; nada é gravado nas recusas', async () => {
      const corpo = { linhas: [l('GHE-390', 'Nunca', 'Capacete', 'Obrigatório')] };
      const antes = await foto();
      for (const quem of [soCriar, soEditar, soVer, semNada]) {
        const r = await confirmar(corpo, quem);
        assert.equal(r.status, 403, `${quem} → ${JSON.stringify(r.body)}`);
      }
      assert.equal((await request(app).post(URL_CONFIRMAR).send(corpo)).status, 401);
      assert.deepEqual(await foto(), antes);
    });

    test('o cliente não manda autoridade: empresa, preview, resumo, ids, situação e decisões são campos proibidos (400 VALIDACAO)', async () => {
      const linha = l('GHE-390', 'Nunca', 'Capacete', 'Obrigatório');
      const casos = [
        { linhas: [linha], empresaId: 1 }, { linhas: [linha], previa: {} }, { linhas: [linha], resumo: {} }, { linhas: [linha], confirmado: true }, { linhas: [linha], importacaoId: crypto.randomUUID() },
        { linhas: [{ ...linha, situacao: 'NOVO_VINCULO' }] }, { linhas: [{ ...linha, aplicavel: true }] }, { linhas: [{ ...linha, gheId: 1 }] }, { linhas: [{ ...linha, tipoMaterialId: 1 }] },
        { linhas: [{ ...linha, empresaId: 1 }] }, {}, { linhas: [] },
      ];
      const antes = await foto();
      for (const corpo of casos) {
        const r = await confirmar(corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo).slice(0, 100));
        assert.equal(r.body.codigo, 'VALIDACAO');
      }
      assert.deepEqual(await foto(), antes);
    });
  });

  describe('o que a confirmação grava (lote misto)', () => {
    test('aplica só o que é válido, na mesma transação, e reporta o resto; a ausência no arquivo nunca remove nada', async () => {
      const g801 = await semearGhe(d.empresaA, 'Soldagem 801', 'GHE-801');
      await ligar(d.empresaA, g801, T.capacete, 'OBRIGATORIO');
      await ligar(d.empresaA, g801, T.protetor, 'OBRIGATORIO');
      const g802 = await semearGhe(d.empresaA, 'Pintura 802', null);
      const g803 = await semearGhe(d.empresaA, 'Almoxarifado 803', 'GHE-803', false);
      const g804 = await semearGhe(d.empresaA, 'Caldeiraria 804', 'GHE-804');
      const g805 = await semearGhe(d.empresaA, 'Fora do arquivo 805', 'GHE-805');
      await ligar(d.empresaA, g805, T.luva, 'OBRIGATORIO');
      const antesG801 = (await q('SELECT atualizado_em FROM grupos_homogeneos_exposicao WHERE id = $1', [g801])).rows[0].atualizado_em;
      const intocaveisAntes = await foto(TABELAS_INTOCAVEIS);
      const gheAntes = (await q('SELECT count(*)::int AS n FROM grupos_homogeneos_exposicao')).rows[0].n;

      const linhas = [
        l('GHE-801', 'Soldagem 801', 'Capacete', 'Obrigatório'), l('GHE-801', 'Soldagem 801', 'Luva de Raspa', 'Não obrigatório'), l('GHE-801', 'Soldagem 801', 'Protetor Auricular', 'Não obrigatório'),
        l('GHE-802', 'Pintura 802', 'Capacete', 'Obrigatório'),
        l('GHE-820', 'Montagem Nova 820', 'Luva de Raspa', 'Obrigatório'), l('GHE-820', 'Montagem Nova 820', 'Protetor Auricular', 'Não obrigatório'),
        l('GHE-803', 'Almoxarifado 803', 'Capacete', 'Obrigatório'), l('GHE-804', 'Outra coisa 804', 'Capacete', 'Obrigatório'),
        l('GHE-821', 'Nova 821', 'Inexistente', 'Obrigatório'), l('GHE-821', 'Nova 821', 'Bota Antiga', 'Obrigatório'),
        l('GHE-X', '', '', 'talvez'), l('', '', '', ''), l('GHE-820', 'Montagem Nova 820', 'Luva de Raspa', 'OBRIGATÓRIO'),
        l('GHE-830', 'Dupla 830', 'Capacete', 'Obrigatório'), l('GHE-830', 'Dupla 830', 'Capacete', 'Não obrigatório'),
      ];
      const r = await confirmar({ linhas });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.deepEqual(Object.keys(r.body).sort(), ['ghes', 'importacaoId', 'linhas', 'resumo', 'status']);

      // Banco: GHE novo só o que tem linha aplicável; legado recebe o código sem mudar id nem descrição; vínculos certos.
      const novo = await ghePorCodigo(d.empresaA, 'GHE-820');
      assert.equal(novo.length, 1);
      assert.deepEqual([novo[0].nome, novo[0].ativo, novo[0].empresa_id], ['Montagem Nova 820', true, d.empresaA]);
      assert.equal((await q('SELECT count(*)::int AS n FROM grupos_homogeneos_exposicao')).rows[0].n, gheAntes + 1, 'só o GHE-820 foi criado');
      assert.equal((await ghePorCodigo(d.empresaA, 'GHE-821')).length + (await ghePorCodigo(d.empresaA, 'GHE-830')).length, 0, 'GHE com todas as linhas bloqueadas não é criado (nem vazio)');
      const legado = (await q('SELECT codigo, nome FROM grupos_homogeneos_exposicao WHERE id = $1', [g802])).rows[0];
      assert.deepEqual([legado.codigo, legado.nome], ['GHE-802', 'Pintura 802']);
      assert.deepEqual(await vinculosDe(g801), [
        { tipo_material_id: T.capacete, classificacao: 'OBRIGATORIO' }, { tipo_material_id: T.luva, classificacao: 'NAO_OBRIGATORIO' }, { tipo_material_id: T.protetor, classificacao: 'NAO_OBRIGATORIO' },
      ].sort((a, b) => a.tipo_material_id - b.tipo_material_id));
      assert.deepEqual(await vinculosDe(g802), [{ tipo_material_id: T.capacete, classificacao: 'OBRIGATORIO' }]);
      assert.deepEqual(await vinculosDe(novo[0].id), [{ tipo_material_id: T.luva, classificacao: 'OBRIGATORIO' }, { tipo_material_id: T.protetor, classificacao: 'NAO_OBRIGATORIO' }].sort((a, b) => a.tipo_material_id - b.tipo_material_id));
      assert.deepEqual(await vinculosDe(g803), [], 'GHE inativo: nada novo, e continua inativo');
      assert.equal((await q('SELECT ativo FROM grupos_homogeneos_exposicao WHERE id = $1', [g803])).rows[0].ativo, false);
      assert.deepEqual(await vinculosDe(g804), [], 'GHE em conflito não é tocado');
      assert.deepEqual(await vinculosDe(g805), [{ tipo_material_id: T.luva, classificacao: 'OBRIGATORIO' }], 'o que o arquivo não cita fica como está');
      assert.equal((await q('SELECT atualizado_em FROM grupos_homogeneos_exposicao WHERE id = $1', [g801])).rows[0].atualizado_em.getTime(), antesG801.getTime(), 'GHE existente sem mudança não recebe UPDATE');
      assert.deepEqual(await foto(TABELAS_INTOCAVEIS), intocaveisAntes, 'tipos, materiais, ghe_materiais e funcionários intocados');

      // Resposta: o resultado real, por linha, por GHE e no resumo.
      assert.deepEqual(r.body.linhas.map((x) => [x.linha, x.resultado]), [
        [2, 'SEM_ALTERACAO'], [3, 'APLICADA'], [4, 'APLICADA'], [5, 'APLICADA'], [6, 'APLICADA'], [7, 'APLICADA'], [8, 'BLOQUEADA'], [9, 'BLOQUEADA'],
        [10, 'BLOQUEADA'], [11, 'BLOQUEADA'], [12, 'BLOQUEADA'], [14, 'SEM_ALTERACAO'], [15, 'BLOQUEADA'], [16, 'BLOQUEADA'],
      ]);
      assert.deepEqual(r.body.ghes.map((x) => [x.codigo, x.resultado]), [
        ['GHE-801', 'SEM_ALTERACAO'], ['GHE-802', 'CODIGO_ATRIBUIDO'], ['GHE-820', 'CRIADO'], ['GHE-803', 'SEM_ALTERACAO'], ['GHE-804', 'BLOQUEADO'], ['GHE-821', 'BLOQUEADO'], ['GHE-830', 'BLOQUEADO'],
      ]);
      assert.equal(r.body.ghes.find((x) => x.codigo === 'GHE-820').gheId, novo[0].id, 'o id real do GHE criado volta na resposta');
      assert.equal(r.body.linhas.find((x) => x.linha === 6).gheId, novo[0].id);
      const resumo = r.body.resumo;
      assert.deepEqual(
        [resumo.linhasRecebidas, resumo.linhasIgnoradas, resumo.aplicadas, resumo.ghesCriados, resumo.ghesComCodigoAtribuido, resumo.vinculosCriados, resumo.classificacoesAlteradas, resumo.semAlteracao, resumo.bloqueadas],
        [15, 1, 5, 1, 1, 4, 1, 2, 7],
      );
      assert.match(r.body.importacaoId, /^[0-9a-f-]{36}$/);

      // Auditoria: eventos individuais ligados ao lote e UM evento do lote, só com contadores.
      const lote = await auditorias('GHE_IMPORTACAO_LOTE');
      assert.equal(lote.length, 1);
      assert.equal(lote[0].referencia, r.body.importacaoId);
      assert.deepEqual(Object.keys(lote[0].contexto).sort(), [
        'aplicadas', 'bloqueadas', 'classificacoesAlteradas', 'ghesComCodigoAtribuido', 'ghesCriados', 'linhasIgnoradas', 'linhasRecebidas', 'porSituacao', 'semAlteracao', 'vinculosCriados',
      ]);
      assert.deepEqual([lote[0].contexto.aplicadas, lote[0].contexto.ghesCriados, lote[0].contexto.vinculosCriados], [5, 1, 4]);
      const textoDoLote = JSON.stringify(lote[0].contexto);
      assert.ok(textoDoLote.length < 4 * KIB && !/Montagem Nova|Soldagem|Capacete|talvez/.test(textoDoLote), 'sem lista de linhas e sem texto da planilha');
      const criados = await auditorias('GHE_CRIADO');
      const criadoDoLote = criados.filter((e) => e.referencia === String(novo[0].id));
      assert.equal(criadoDoLote.length, 1);
      assert.deepEqual([criadoDoLote[0].dados_novos.codigo, criadoDoLote[0].dados_novos.nome, criadoDoLote[0].contexto.importacaoId], ['GHE-820', 'Montagem Nova 820', r.body.importacaoId]);
      const atribuicao = (await auditorias('GHE_ALTERADO')).filter((e) => e.referencia === String(g802));
      assert.equal(atribuicao.length, 1);
      assert.deepEqual([atribuicao[0].dados_anteriores.codigo, atribuicao[0].dados_novos.codigo, atribuicao[0].dados_novos.nome, atribuicao[0].contexto.importacaoId], [null, 'GHE-802', 'Pintura 802', r.body.importacaoId]);
      const vinculados = (await auditorias('GHE_TIPO_MATERIAL_VINCULADO')).filter((e) => e.contexto && e.contexto.importacaoId === r.body.importacaoId);
      const alterados = (await auditorias('GHE_TIPO_MATERIAL_ALTERADO')).filter((e) => e.contexto && e.contexto.importacaoId === r.body.importacaoId);
      assert.deepEqual([vinculados.length, alterados.length], [4, 1]);
      assert.deepEqual([alterados[0].dados_anteriores.classificacao, alterados[0].dados_novos.classificacao, alterados[0].referencia], ['OBRIGATORIO', 'NAO_OBRIGATORIO', String(g801)]);
      assert.equal((await auditorias('GHE_TIPO_MATERIAL_DESVINCULADO')).length, 0, 'a importação nunca remove vínculo');
    });

    test('conflitos de GHE (código com outra descrição, descrição de outro código, legado ambíguo, conflito interno) não escrevem nada', async () => {
      await semearGhe(d.empresaA, 'Existente 851', 'GHE-851');
      await semearGhe(d.empresaA, 'Mesmo Nome 852', null);
      await semearGhe(d.empresaA, 'mesmo nome 852', null);
      const antes = await foto();
      const r = await confirmar({ linhas: [
        l('GHE-851', 'Descrição outra', 'Capacete', 'Obrigatório'),
        l('GHE-899', 'Existente 851', 'Capacete', 'Obrigatório'),
        l('GHE-853', 'Mesmo Nome 852', 'Capacete', 'Obrigatório'),
        l('GHE-854', 'Interno A', 'Capacete', 'Obrigatório'), l('GHE-854', 'Interno B', 'Luva de Raspa', 'Obrigatório'),
      ] });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.ok(r.body.linhas.every((x) => x.resultado === 'BLOQUEADA'));
      assert.equal(r.body.resumo.aplicadas, 0);
      assert.equal(r.body.importacaoId, null);
      assert.deepEqual(await foto(), antes);
    });

    test('duplicata idêntica gera um só vínculo; classificações diferentes no arquivo não aplicam nenhuma das duas, sem ordem vencedora', async () => {
      const g = await semearGhe(d.empresaA, 'Duplicatas 860', 'GHE-860');
      const r = await confirmar({ linhas: [
        l('GHE-860', 'Duplicatas 860', 'Capacete', 'Obrigatório'), l('ghe-860', 'DUPLICATAS 860', 'capacete', 'OBRIGATORIO'),
        l('GHE-860', 'Duplicatas 860', 'Luva de Raspa', 'Obrigatório'), l('GHE-860', 'Duplicatas 860', 'Luva de Raspa', 'Não obrigatório'),
      ] });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.deepEqual(await vinculosDe(g), [{ tipo_material_id: T.capacete, classificacao: 'OBRIGATORIO' }]);
      assert.deepEqual(r.body.linhas.map((x) => x.resultado), ['APLICADA', 'SEM_ALTERACAO', 'BLOQUEADA', 'BLOQUEADA']);
      assert.equal((await auditorias('GHE_TIPO_MATERIAL_VINCULADO')).filter((e) => e.referencia === String(g)).length, 1);
    });

    test('isolamento: a confirmação da empresa B grava só em B; o mesmo código e a mesma descrição na A não conflitam nem são tocados', async () => {
      const deA = await semearGhe(d.empresaA, 'Descrição da A 870', 'GHE-870');
      const lotesDaAAntes = (await auditorias('GHE_IMPORTACAO_LOTE', d.empresaA)).length;
      const r = await confirmar({ linhas: [l('GHE-870', 'Descrição própria da B 870', 'Capacete', 'Obrigatório')] }, gestorB);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.linhas[0].resultado, 'APLICADA');
      const daB = await ghePorCodigo(d.empresaB, 'GHE-870');
      assert.equal(daB.length, 1);
      assert.deepEqual((await vinculosDe(daB[0].id)), [{ tipo_material_id: TB.capacete, classificacao: 'OBRIGATORIO' }]);
      assert.deepEqual((await vinculosDe(deA)), []);
      assert.equal((await auditorias('GHE_IMPORTACAO_LOTE', d.empresaA)).length, lotesDaAAntes, 'nenhuma auditoria de lote nova na A');
      assert.equal((await auditorias('GHE_IMPORTACAO_LOTE', d.empresaB)).length, 1);
    });
  });

  describe('revalidação: o preview é só informativo', () => {
    test('GHE criado por outra operação depois do preview: a confirmação usa o existente, não duplica e não conta como criado', async () => {
      const linhas = [l('GHE-840', 'Concorrente 840', 'Capacete', 'Obrigatório')];
      const p = await previa({ linhas });
      assert.equal(p.status, 200, JSON.stringify(p.body));
      assert.equal(p.body.linhas[0].situacaoGhe, 'GHE_NOVO');
      const outro = await semearGhe(d.empresaA, 'Concorrente 840', 'GHE-840');
      const r = await confirmar({ linhas });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.linhas[0].situacaoGhe, 'GHE_EXISTENTE');
      assert.equal((await ghePorCodigo(d.empresaA, 'GHE-840')).length, 1);
      assert.deepEqual(await vinculosDe(outro), [{ tipo_material_id: T.capacete, classificacao: 'OBRIGATORIO' }]);
      assert.equal(r.body.resumo.ghesCriados, 0);
      assert.equal((await auditorias('GHE_CRIADO')).filter((e) => e.referencia === String(outro)).length, 0);
    });

    test('vínculo criado depois do preview: vira SEM_ALTERACAO, sem escrita nem auditoria', async () => {
      const g = await semearGhe(d.empresaA, 'Revalidar 841', 'GHE-841');
      const linhas = [l('GHE-841', 'Revalidar 841', 'Luva de Raspa', 'Obrigatório')];
      assert.equal((await previa({ linhas })).body.linhas[0].situacao, 'NOVO_VINCULO');
      await ligar(d.empresaA, g, T.luva, 'OBRIGATORIO');
      const antes = await foto();
      const r = await confirmar({ linhas });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.deepEqual([r.body.linhas[0].situacao, r.body.linhas[0].resultado, r.body.importacaoId], ['VINCULO_EXISTENTE', 'SEM_ALTERACAO', null]);
      assert.deepEqual(await foto(), antes);
    });

    test('GHE ou tipo inativado depois do preview: a confirmação bloqueia a linha e não grava', async () => {
      const gA = await semearGhe(d.empresaA, 'Inativar GHE 842', 'GHE-842');
      const efemero = await semearTipo(d.empresaA, 'Tipo Efêmero 843');
      const gB = await semearGhe(d.empresaA, 'Inativar tipo 843', 'GHE-843');
      const linhas = [l('GHE-842', 'Inativar GHE 842', 'Capacete', 'Obrigatório'), l('GHE-843', 'Inativar tipo 843', 'Tipo Efêmero 843', 'Obrigatório')];
      assert.deepEqual((await previa({ linhas })).body.linhas.map((x) => x.situacao), ['NOVO_VINCULO', 'NOVO_VINCULO']);
      await q('UPDATE grupos_homogeneos_exposicao SET ativo = false WHERE id = $1', [gA]);
      await q('UPDATE tipos_material SET ativo = false WHERE id = $1', [efemero]);
      const r = await confirmar({ linhas });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.deepEqual(r.body.linhas.map((x) => [x.situacao, x.resultado]), [['GHE_INATIVO', 'BLOQUEADA'], ['EPI_INATIVO', 'BLOQUEADA']]);
      assert.deepEqual([(await vinculosDe(gA)).length, (await vinculosDe(gB)).length], [0, 0]);
      assert.equal((await q('SELECT ativo FROM grupos_homogeneos_exposicao WHERE id = $1', [gA])).rows[0].ativo, false, 'não reativa');
    });

    test('classificação alterada depois do preview: se já está como o arquivo pede, não há alteração', async () => {
      const g = await semearGhe(d.empresaA, 'Classificação 844', 'GHE-844');
      await ligar(d.empresaA, g, T.capacete, 'OBRIGATORIO');
      const linhas = [l('GHE-844', 'Classificação 844', 'Capacete', 'Não obrigatório')];
      assert.equal((await previa({ linhas })).body.linhas[0].situacao, 'CLASSIFICACAO_ALTERADA');
      await q("UPDATE ghe_tipos_material SET classificacao = 'NAO_OBRIGATORIO' WHERE grupo_homogeneo_id = $1", [g]);
      const antes = await foto();
      const r = await confirmar({ linhas });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.deepEqual([r.body.linhas[0].situacao, r.body.resumo.classificacoesAlteradas, r.body.importacaoId], ['VINCULO_EXISTENTE', 0, null]);
      assert.deepEqual(await foto(), antes);
    });
  });

  describe('idempotência', () => {
    test('o mesmo arquivo confirmado duas vezes: a segunda não altera o domínio nem cria auditoria', async () => {
      const linhas = [l('GHE-880', 'Idempotente 880', 'Capacete', 'Obrigatório'), l('GHE-880', 'Idempotente 880', 'Luva de Raspa', 'Não obrigatório'), l('GHE-881', 'Idempotente 881', 'Protetor Auricular', 'Obrigatório')];
      const primeira = await confirmar({ linhas });
      assert.equal(primeira.status, 200, JSON.stringify(primeira.body).slice(0, 200));
      assert.deepEqual([primeira.body.resumo.ghesCriados, primeira.body.resumo.vinculosCriados], [2, 3]);
      const aposPrimeira = await foto();
      const auditoriasAntes = await totalAuditoriasDaImportacao();

      const segunda = await confirmar({ linhas });
      assert.equal(segunda.status, 200, JSON.stringify(segunda.body).slice(0, 200));
      assert.deepEqual([segunda.body.resumo.aplicadas, segunda.body.resumo.ghesCriados, segunda.body.resumo.vinculosCriados, segunda.body.resumo.classificacoesAlteradas, segunda.body.importacaoId], [0, 0, 0, 0, null]);
      assert.ok(segunda.body.linhas.every((x) => x.resultado === 'SEM_ALTERACAO'));
      assert.deepEqual(await foto(), aposPrimeira);
      assert.equal(await totalAuditoriasDaImportacao(), auditoriasAntes, 'nenhuma auditoria enganosa de mudança');
      assert.equal((await ghePorCodigo(d.empresaA, 'GHE-880')).length, 1);
    });
  });

  describe('atomicidade: erro inesperado desfaz o lote inteiro', () => {
    const lote = () => [
      l('GHE-890', 'Atômico 890', 'Capacete', 'Obrigatório'), l('GHE-890', 'Atômico 890', 'Luva de Raspa', 'Obrigatório'),
      l('GHE-891', 'Atômico 891', 'Protetor Auricular', 'Não obrigatório'),
    ];

    test('falha ao gravar a auditoria do lote (o último passo): nenhum GHE, código, vínculo ou auditoria sobrevive', async () => {
      const legado = await semearGhe(d.empresaA, 'Atômico 892', null);
      const linhas = [...lote(), l('GHE-892', 'Atômico 892', 'Capacete', 'Obrigatório')];
      const antes = await foto();
      const auditoriasAntes = await totalAuditoriasDaImportacao();
      const r = await comFalhaNaAuditoria("NEW.acao = 'GHE_IMPORTACAO_LOTE'", () => confirmar({ linhas }));
      assert.equal(r.status, 500, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.codigo, 'ERRO_INTERNO');
      assert.deepEqual(await foto(), antes, 'rollback total');
      assert.equal((await ghePorCodigo(d.empresaA, 'GHE-890')).length + (await ghePorCodigo(d.empresaA, 'GHE-891')).length, 0);
      assert.equal((await q('SELECT codigo FROM grupos_homogeneos_exposicao WHERE id = $1', [legado])).rows[0].codigo, null);
      assert.equal(await totalAuditoriasDaImportacao(), auditoriasAntes, 'nenhuma auditoria sobreviveu');
    });

    test('falha no meio (auditoria de um vínculo depois de GHEs e outros vínculos já gravados): tudo desfeito', async () => {
      const antes = await foto();
      const r = await comFalhaNaAuditoria(
        `NEW.acao = 'GHE_TIPO_MATERIAL_VINCULADO' AND (NEW.dados_novos->>'tipoMaterialId')::int = ${T.protetor}`,
        () => confirmar({ linhas: lote() }),
      );
      assert.equal(r.status, 500, JSON.stringify(r.body).slice(0, 200));
      assert.equal(r.body.codigo, 'ERRO_INTERNO');
      assert.deepEqual(await foto(), antes, 'nada parcial: nem GHE criado, nem vínculo anterior ao ponto da falha, nem auditoria');
    });

    test('depois da falha, a mesma confirmação sem a falha injetada funciona do zero (nada ficou preso)', async () => {
      const r = await confirmar({ linhas: lote() });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.deepEqual([r.body.resumo.ghesCriados, r.body.resumo.vinculosCriados], [2, 3]);
    });
  });

  describe('concorrência', () => {
    test('confirmações simultâneas do mesmo GHE novo e do mesmo vínculo: um GHE, um vínculo, todas 200, uma só auditoria de criação e uma só do lote', async () => {
      const linhas = [l('GHE-910', 'Corrida 910', 'Capacete', 'Obrigatório'), l('GHE-910', 'Corrida 910', 'Luva de Raspa', 'Não obrigatório')];
      const respostas = await Promise.all(Array.from({ length: 5 }, () => confirmar({ linhas })));
      for (const r of respostas) assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      const ghes = await ghePorCodigo(d.empresaA, 'GHE-910');
      assert.equal(ghes.length, 1);
      assert.equal((await vinculosDe(ghes[0].id)).length, 2);
      assert.equal((await auditorias('GHE_CRIADO')).filter((e) => e.referencia === String(ghes[0].id)).length, 1);
      assert.equal((await auditorias('GHE_TIPO_MATERIAL_VINCULADO')).filter((e) => e.referencia === String(ghes[0].id)).length, 2);
      assert.equal(respostas.filter((r) => r.body.importacaoId !== null).length, 1, 'só quem gravou gera o evento do lote');
      assert.equal((await auditorias('GHE_IMPORTACAO_LOTE')).filter((e) => respostas.some((r) => r.body.importacaoId === e.referencia)).length, 1);
    });

    test('confirmações simultâneas do mesmo vínculo em GHE existente: uma linha só e uma só auditoria de criação', async () => {
      const g = await semearGhe(d.empresaA, 'Corrida 911', 'GHE-911');
      const linhas = [l('GHE-911', 'Corrida 911', 'Protetor Auricular', 'Obrigatório')];
      const respostas = await Promise.all(Array.from({ length: 5 }, () => confirmar({ linhas })));
      for (const r of respostas) assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      assert.equal((await vinculosDe(g)).length, 1);
      assert.equal((await auditorias('GHE_TIPO_MATERIAL_VINCULADO')).filter((e) => e.referencia === String(g)).length, 1);
    });

    test('classificações diferentes ao mesmo tempo no mesmo vínculo: uma linha, todas 200 e uma cadeia de auditoria coerente, sem vencedor predeterminado', async () => {
      const g = await semearGhe(d.empresaA, 'Corrida 912', 'GHE-912');
      await ligar(d.empresaA, g, T.capacete, 'OBRIGATORIO');
      const pedidos = ['Não obrigatório', 'Obrigatório', 'Não obrigatório', 'Obrigatório', 'Não obrigatório'];
      const respostas = await Promise.all(pedidos.map((c) => confirmar({ linhas: [l('GHE-912', 'Corrida 912', 'Capacete', c)] })));
      for (const r of respostas) assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      await conferirCadeia(g, T.capacete, 'OBRIGATORIO');
    });
  });

  describe('limite HTTP da confirmação: 512 KiB depois da sessão e da permissão; 1000 linhas', () => {
    test('1000 linhas válidas (bem acima de 32 KiB) são confirmadas e gravam tudo; não há 500', async () => {
      const corpo = JSON.stringify({ linhas: volume() });
      assert.ok(Buffer.byteLength(corpo) > 32 * KIB && Buffer.byteLength(corpo) < 512 * KIB);
      const r = await enviarTexto(gestor, corpo);
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.deepEqual([r.body.resumo.aplicadas, r.body.resumo.ghesCriados, r.body.resumo.vinculosCriados], [1000, 40, 1000]);
      assert.equal((await q("SELECT count(*)::int AS n FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND codigo ~ '^GHE-3(0[1-9]|[1-3][0-9]|40)$'", [d.empresaA])).rows[0].n, 40);
    });

    test('um corpo de ~508 KiB ainda passa; acima de 512 KiB é 413; mais de 1000 linhas é 400 mesmo se couber; a rota comum segue em 32 KiB', async () => {
      const quase = await enviarTexto(gestor, corpoComBytes(520000));
      assert.equal(quase.status, 200, JSON.stringify(quase.body).slice(0, 200));
      const acima = await enviarTexto(gestor, corpoComBytes(530000));
      assert.equal(acima.status, 413);
      assert.equal(acima.body.codigo, 'PAYLOAD_MUITO_GRANDE');
      const compactas = (n) => JSON.stringify({ linhas: Array.from({ length: n }, () => l('GHE-001', 'Soldagem', 'Capacete', 'Obrigatório')) });
      const demais = await enviarTexto(gestor, compactas(1001));
      assert.equal(demais.status, 400, JSON.stringify(demais.body).slice(0, 200));
      assert.ok(demais.body.detalhes.some((x) => x.campo === 'body.linhas' && x.codigo === 'TAMANHO_MAXIMO'));
      const comum = await request(app).post('/api/grupos-homogeneos').set(CABECALHO, String(gestor)).set('Content-Type', 'application/json').send(JSON.stringify({ nome: 'x', descricao: 'y'.repeat(40 * KIB) }));
      assert.equal(comum.status, 413);
    });

    test('sem sessão ou sem permissão, o corpo grande não é lido: 401 e 403, nunca 413 nem 400, e nada é gravado', async () => {
      const corpo = JSON.stringify({ linhas: volume() });
      const antes = await foto();
      assert.equal((await enviarTexto(null, corpo)).status, 401);
      for (const quem of [soCriar, soEditar, soVer, semNada]) assert.equal((await enviarTexto(quem, corpo)).status, 403, String(quem));
      assert.deepEqual(await foto(), antes);
    });
  });

  describe('sem N+1', () => {
    test('reconfirmar 10 ou 1000 linhas já aplicadas faz as mesmas poucas leituras ao domínio (escritas são só as alterações reais, e aqui não há)', async (t) => {
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
      const leituras = async (linhas) => {
        sqls.length = 0;
        const r = await confirmar({ linhas });
        assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
        assert.equal(r.body.resumo.aplicadas, 0);
        return sqls.filter((s) => /^\s*SELECT/i.test(s) && /grupos_homogeneos_exposicao|tipos_material|ghe_tipos_material|ghe_materiais/i.test(s)).length;
      };
      try {
        const pequeno = await leituras(volume().slice(0, 10));
        const grande = await leituras(volume());
        assert.ok(pequeno >= 1, 'a confirmação lê o domínio');
        assert.equal(grande, pequeno, `leituras ao domínio: ${pequeno} (10 linhas) × ${grande} (1000 linhas)`);
        assert.ok(grande <= 8, `leitura em lote por empresa, não por linha: ${grande} consultas`);
      } finally {
        for (const cliente of instrumentados) delete cliente.query;
      }
    });
  });
});
