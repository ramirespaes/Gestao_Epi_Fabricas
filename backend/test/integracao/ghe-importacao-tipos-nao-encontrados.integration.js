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
const { criarGheImportacaoRoutes } = require('../../src/routes/ghe-importacao.routes');
const { criarGheImportacaoController } = require('../../src/controllers/ghe-importacao.controller');
const { criarTipoMaterialRoutes } = require('../../src/routes/tipo-material.routes');
const { criarTipoMaterialController } = require('../../src/controllers/tipo-material.controller');

/**
 * Etapa A1 (RED): tipos de EPI que a planilha GHE/EPI cita e o catálogo da empresa ainda não tem.
 *
 * Contrato (D1 + opção A): o núcleo devolve `resumo.tiposNaoEncontrados` e a prévia e a confirmação o repassam DENTRO de
 * `resumo`; o nível principal das respostas não muda (status, resumo, ghes, linhas [+ importacaoId na confirmação]).
 * O cadastro do tipo continua sendo a rota existente POST /api/tipos-material (materials.criar, auditoria
 * TIPO_MATERIAL_CRIADO, 409 TIPO_MATERIAL_JA_EXISTE, "Outros" reservado, nome até 100): ato separado e explícito, fora da
 * importação. Depois dele, a mesma planilha é analisada de novo e a linha passa a NOVO_VINCULO pelo id criado.
 * Preservado: EPI_NAO_ENCONTRADO, confirmação parcial, idempotência, auditoria do lote só com contadores, isolamento por
 * empresa, nenhum tipo ou material criado pela importação.
 *
 * Banco: PostgreSQL real, schema temporário exclusivo (gestao_epi_teste_local), DROP SCHEMA no fim.
 */

const URL_PREVIA = '/api/grupos-homogeneos/importacao/preview';
const URL_CONFIRMAR = '/api/grupos-homogeneos/importacao/confirmar';
const URL_TIPOS = '/api/tipos-material';
const TABELAS_DO_DOMINIO = ['grupos_homogeneos_exposicao', 'ghe_tipos_material', 'ghe_materiais', 'tipos_material', 'materiais', 'logs_auditoria'];

const l = (ghe, descricao, epi, classificacao = 'Obrigatório') => ({ ghe, descricao, epi, classificacao });

describe('A1 — importação GHE/EPI: tipos não encontrados e cadastro explícito (PostgreSQL real)', () => {
  let ctx;
  let d;
  let app;
  let gestor;
  let gestorB;
  let soImporta;
  let seq = 0;
  let codigo = 400;

  const como = (id) => ({ post: (url, corpo) => request(app).post(url).set(CABECALHO, String(id)).send(corpo) });
  const q = (sql, params) => ctx.pool.query(sql, params);
  const previa = (linhas, quem = gestor) => como(quem).post(URL_PREVIA, { linhas });
  const confirmar = (linhas, quem = gestor) => como(quem).post(URL_CONFIRMAR, { linhas });
  const cadastrarTipo = (nome, quem = gestor, grupoProtecao = 'Proteção das mãos') => como(quem).post(URL_TIPOS, { grupo: 'EPI', grupoProtecao, nome });

  async function usuarioCom(empresaId, permissoes) {
    seq += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `a1-tipos-${seq}@example.invalid`, 'USUARIO');
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    for (const [recurso, ops] of Object.entries(permissoes)) {
      await q(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, $3, $4, $5, $6, false, $7)`,
        [empresaId, id, recurso, ops.includes('visualizar'), ops.includes('criar'), ops.includes('editar'), mestre],
      );
    }
    return id;
  }
  const semearTipo = async (empresaId, nome) => (await q(
    'INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, ativo, origem) VALUES ($1, \'EPI\', \'Proteção da cabeça\', $2, true, \'MANUAL\') RETURNING id', [empresaId, nome],
  )).rows[0].id;
  const semearGhe = async (empresaId, nome, cod) => (await q(
    'INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, codigo, ativo) VALUES ($1, $2, $3, true) RETURNING id', [empresaId, nome, cod],
  )).rows[0].id;
  const tiposComChave = async (empresaId, nome) => (await q(
    'SELECT id, nome FROM tipos_material WHERE empresa_id = $1 AND lower(nome) = lower($2) ORDER BY id', [empresaId, nome],
  )).rows;
  const contar = async (tabela, empresaId) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE empresa_id = $1`, [empresaId])).rows[0].n;
  const ghePorCodigo = async (empresaId, cod) => (await q('SELECT id FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND codigo = $2', [empresaId, cod])).rows;

  async function foto() {
    const r = {};
    for (const tabela of TABELAS_DO_DOMINIO) {
      r[tabela] = (await q(`SELECT count(*)::int AS n, md5(COALESCE(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text), '')) AS h FROM ${tabela} x`)).rows[0];
    }
    return r;
  }

  /** Lista nova exigida dentro de `resumo` (ausência = falha funcional, nunca TypeError). */
  function naoEncontrados(r) {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const lista = r.body.resumo && r.body.resumo.tiposNaoEncontrados;
    assert.ok(Array.isArray(lista), `resumo.tiposNaoEncontrados deveria ser uma lista; veio ${JSON.stringify(lista)}`);
    return lista;
  }

  /**
   * Cenário próprio de cada teste (nomes e códigos únicos): um GHE existente com Capacete, um GHE novo com tipos
   * inexistentes, um GHE novo SÓ com tipo inexistente e uma linha "Outros".
   */
  async function cenario(empresaId = d.empresaA) {
    const s = crypto.randomUUID().slice(0, 6);
    codigo += 4;
    const c = {
      s,
      capacete: `Capacete ${s}`,
      luva: `Luva Nitrila ${s}`,
      cinto: `Cinturão Paraquedista ${s}`,
      existente: `GHE-${codigo}`, novo: `GHE-${codigo + 1}`, soInexistente: `GHE-${codigo + 2}`,
      dExistente: `Soldagem ${s}`, dNovo: `Expedição ${s}`, dSo: `Sucata ${s}`,
    };
    c.capaceteId = await semearTipo(empresaId, c.capacete);
    c.gheExistenteId = await semearGhe(empresaId, c.dExistente, c.existente);
    c.linhas = [
      l(c.existente, c.dExistente, c.capacete),
      l(c.existente, c.dExistente, c.luva),
      l(c.novo, c.dNovo, `  luva   nitrila ${s} `, 'Não obrigatório'),
      l(c.novo, c.dNovo, c.cinto),
      l(c.soInexistente, c.dSo, c.cinto),
      l(c.novo, c.dNovo, 'Outros'),
    ];
    return c;
  }

  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    app = criarAppTeste((a) => {
      a.use('/api', criarGheImportacaoRoutes({ controller: criarGheImportacaoController({ pool }), exigirSessao, pool }));
      a.use('/api', criarTipoMaterialRoutes({ controller: criarTipoMaterialController({ pool }), exigirSessao, pool }));
    });
    const tudo = { employeeGroups: ['visualizar', 'criar', 'editar'], materials: ['visualizar', 'criar'] };
    gestor = await usuarioCom(d.empresaA, tudo);
    gestorB = await usuarioCom(d.empresaB, tudo);
    soImporta = await usuarioCom(d.empresaA, { employeeGroups: ['visualizar', 'criar', 'editar'] });
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('prévia: resumo.tiposNaoEncontrados agrupado pela chave da importação, com linhas e GHEs; nível principal igual; nada gravado', async () => {
    const c = await cenario();
    const antes = await foto();
    const r = await previa(c.linhas);
    assert.deepEqual(naoEncontrados(r), [
      { nome: c.luva, variantes: [c.luva, `luva nitrila ${c.s}`], linhas: [3, 4], ghes: [c.existente, c.novo], reservado: false, nomeExcedeLimite: false },
      { nome: c.cinto, variantes: [c.cinto], linhas: [5, 6], ghes: [c.novo, c.soInexistente], reservado: false, nomeExcedeLimite: false },
      { nome: 'Outros', variantes: ['Outros'], linhas: [7], ghes: [c.novo], reservado: true, nomeExcedeLimite: false },
    ]);
    assert.deepEqual(Object.keys(r.body).sort(), ['ghes', 'linhas', 'resumo', 'status']);
    assert.deepEqual(r.body.linhas.map((x) => x.situacao), ['NOVO_VINCULO', 'EPI_NAO_ENCONTRADO', 'EPI_NAO_ENCONTRADO', 'EPI_NAO_ENCONTRADO', 'EPI_NAO_ENCONTRADO', 'EPI_NAO_ENCONTRADO']);
    assert.deepEqual(await foto(), antes, 'a prévia não grava nada, nem tipo, nem auditoria');
  });

  test('cadastro explícito pela rota existente e nova prévia com as MESMAS linhas: o tipo é reconhecido pelo id criado e sai da lista', async () => {
    const c = await cenario();
    assert.deepEqual(naoEncontrados(await previa(c.linhas)).map((x) => x.nome), [c.luva, c.cinto, 'Outros'], 'antes do cadastro');

    const criado = await cadastrarTipo(c.luva);
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    const tipoId = criado.body.tipo.id;

    const depois = await previa(c.linhas);
    assert.deepEqual(naoEncontrados(depois).map((x) => x.nome), [c.cinto, 'Outros']);
    assert.deepEqual(depois.body.linhas.slice(1, 3).map((x) => [x.situacao, x.tipoMaterialId]), [['NOVO_VINCULO', tipoId], ['NOVO_VINCULO', tipoId]],
      'as duas grafias da planilha (caixa e espaços) resolvem pelo único tipo criado');
    assert.deepEqual(await tiposComChave(d.empresaA, c.luva), [{ id: tipoId, nome: c.luva }], 'o nome gravado é o da planilha, uma vez só');
  });

  test('confirmação parcial: aplica o que foi resolvido, bloqueia o que segue inexistente e traz a lista no resumo; a importação não cria tipo', async () => {
    const c = await cenario();
    const tipoId = (await cadastrarTipo(c.luva)).body.tipo.id;
    const tiposAntes = await contar('tipos_material', d.empresaA);
    const materiaisAntes = await contar('materiais', d.empresaA);

    const r = await confirmar(c.linhas);
    assert.deepEqual(naoEncontrados(r).map((x) => [x.nome, x.linhas]), [[c.cinto, [5, 6]], ['Outros', [7]]]);
    assert.deepEqual(Object.keys(r.body).sort(), ['ghes', 'importacaoId', 'linhas', 'resumo', 'status']);
    assert.deepEqual(r.body.linhas.map((x) => [x.situacao, x.resultado]), [
      ['NOVO_VINCULO', 'APLICADA'], ['NOVO_VINCULO', 'APLICADA'], ['NOVO_VINCULO', 'APLICADA'],
      ['EPI_NAO_ENCONTRADO', 'BLOQUEADA'], ['EPI_NAO_ENCONTRADO', 'BLOQUEADA'], ['EPI_NAO_ENCONTRADO', 'BLOQUEADA'],
    ]);
    const [novo] = await ghePorCodigo(d.empresaA, c.novo);
    assert.ok(novo, 'o GHE novo com linha aplicável é criado');
    const vinculos = (await q('SELECT tipo_material_id, classificacao FROM ghe_tipos_material WHERE grupo_homogeneo_id = $1', [novo.id])).rows;
    assert.deepEqual(vinculos, [{ tipo_material_id: tipoId, classificacao: 'NAO_OBRIGATORIO' }]);
    assert.deepEqual(await ghePorCodigo(d.empresaA, c.soInexistente), [], 'GHE só com tipo inexistente continua não sendo criado (regra atual)');
    assert.equal(await contar('tipos_material', d.empresaA), tiposAntes, 'a confirmação nunca cria tipo');
    assert.equal(await contar('materiais', d.empresaA), materiaisAntes, 'a confirmação nunca cria material');
  });

  test('idempotência: a segunda confirmação da mesma planilha não grava nem audita e continua listando o pendente', async () => {
    const c = await cenario();
    await cadastrarTipo(c.luva);
    const primeira = await confirmar(c.linhas);
    assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
    const antes = await foto();

    const segunda = await confirmar(c.linhas);
    assert.deepEqual(naoEncontrados(segunda).map((x) => x.nome), [c.cinto, 'Outros']);
    assert.equal(segunda.body.importacaoId, null);
    assert.equal(segunda.body.resumo.aplicadas, 0);
    assert.deepEqual(await foto(), antes);
  });

  test('auditoria: o cadastro explícito audita TIPO_MATERIAL_CRIADO; o evento do lote não carrega a lista nem texto da planilha', async () => {
    const c = await cenario();
    const tipoId = (await cadastrarTipo(c.luva)).body.tipo.id;
    const r = await confirmar(c.linhas);
    assert.equal(naoEncontrados(r).length, 2);

    const criadoAudit = (await q("SELECT usuario_id FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'TIPO_MATERIAL_CRIADO' AND referencia = $2", [d.empresaA, String(tipoId)])).rows;
    assert.deepEqual(criadoAudit, [{ usuario_id: gestor }]);
    const lote = (await q("SELECT contexto FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'GHE_IMPORTACAO_LOTE' AND referencia = $2", [d.empresaA, r.body.importacaoId])).rows;
    assert.equal(lote.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(lote[0].contexto, 'tiposNaoEncontrados'), false);
    assert.equal(JSON.stringify(lote[0].contexto).includes(c.cinto), false, 'nenhum texto da planilha no contexto do lote');
  });

  test('duplicidade: o segundo cadastro do mesmo nome (inclusive com outra caixa) é 409 TIPO_MATERIAL_JA_EXISTE e o catálogo fica com um só', async () => {
    const c = await cenario();
    assert.deepEqual(naoEncontrados(await previa(c.linhas)).map((x) => x.nome), [c.luva, c.cinto, 'Outros']);
    assert.equal((await cadastrarTipo(c.luva)).status, 201);
    for (const nome of [c.luva, c.luva.toUpperCase()]) {
      const r = await cadastrarTipo(nome);
      assert.equal(r.status, 409, JSON.stringify(r.body));
      assert.equal(r.body.codigo, 'TIPO_MATERIAL_JA_EXISTE');
    }
    assert.equal((await tiposComChave(d.empresaA, c.luva)).length, 1);
    assert.deepEqual(naoEncontrados(await previa(c.linhas)).map((x) => x.nome), [c.cinto, 'Outros']);
  });

  test('isolamento: o tipo cadastrado na empresa B não resolve a prévia da A; a B resolve a dela', async () => {
    const c = await cenario();
    const daB = await cadastrarTipo(c.luva, gestorB);
    assert.equal(daB.status, 201, JSON.stringify(daB.body));

    assert.deepEqual(naoEncontrados(await previa(c.linhas)).map((x) => x.nome), [c.luva, c.cinto, 'Outros'], 'empresa A não enxerga o tipo da B');
    const linhasB = [l(`GHE-${codigo + 3}`, `Montagem ${c.s}`, c.luva)];
    const rB = await previa(linhasB, gestorB);
    assert.deepEqual(naoEncontrados(rB), []);
    assert.equal(rB.body.linhas[0].tipoMaterialId, daB.body.tipo.id);
  });

  test('permissão: quem importa sem materials.criar vê a lista; o cadastro do tipo é 403 e nada é criado', async () => {
    const c = await cenario();
    assert.deepEqual(naoEncontrados(await previa(c.linhas, soImporta)).map((x) => x.nome), [c.luva, c.cinto, 'Outros']);
    const r = await cadastrarTipo(c.luva, soImporta);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.deepEqual(await tiposComChave(d.empresaA, c.luva), []);
  });

  test('"Outros" e nome acima de 100: aparecem marcados na lista e a rota de cadastro continua recusando os dois', async () => {
    const c = await cenario();
    const longo = `Luva ${'x'.repeat(96)}`;
    assert.equal(Array.from(longo).length, 101);
    const r = await previa([...c.linhas, l(c.novo, c.dNovo, longo)]);
    const lista = naoEncontrados(r);
    assert.deepEqual(lista.filter((x) => x.reservado).map((x) => x.nome), ['Outros']);
    assert.deepEqual(lista.filter((x) => x.nomeExcedeLimite).map((x) => x.nome), [longo]);

    const outros = await cadastrarTipo('Outros');
    assert.equal(outros.status, 400, JSON.stringify(outros.body));
    assert.ok((outros.body.detalhes || []).some((x) => x.codigo === 'TIPO_MATERIAL_OUTROS_RESERVADO') || outros.body.codigo === 'TIPO_MATERIAL_OUTROS_RESERVADO', JSON.stringify(outros.body));
    const grande = await cadastrarTipo(longo);
    assert.equal(grande.status, 400, JSON.stringify(grande.body));
    assert.ok((grande.body.detalhes || []).some((x) => x.codigo === 'NOME_INVALIDO') || grande.body.codigo === 'NOME_INVALIDO', JSON.stringify(grande.body));
  });
});
