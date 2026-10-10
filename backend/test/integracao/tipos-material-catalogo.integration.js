'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { GRUPOS_PROTECAO, CATALOGO_BASE, exigir, dependeDaMigration } = require('./helpers/classificacao-v2');
const { criarAppTeste } = require('../helpers/app-teste');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * RED — catálogo de tipos por empresa (tabela tipos_material): consulta, criação, inativação e catálogo base das empresas
 * CRIADAS depois da implantação (importação CSV/XLSX ficou FORA do escopo por decisão de 08/10/2026). Reusa o recurso RBAC `materials` (visualizar / criar / editar).
 * Os módulos de produção ainda não existem: as rotas respondem 404 e os testes falham por isso (nunca no preparo).
 *
 * Contratos:
 *   GET  /api/tipos-material?grupo&grupoProtecao&ativo&busca&pagina&limite → { tipos[], total, pagina, limite, vocabulario }
 *   POST /api/tipos-material { grupo, grupoProtecao, nome } → 201 { tipo }
 *   POST /api/tipos-material/:id/inativar | /reativar → 200 { tipo }
 */

const RAIZ = '/api/tipos-material';

/** CNPJ numérico fictício com os dígitos verificadores corretos, a partir das 12 posições da base. */
const cnpjValido = (base12) => {
  const valor = (c) => c.charCodeAt(0) - 48;
  const dv = (texto, pesos) => { const soma = [...texto].reduce((acc, c, i) => acc + valor(c) * pesos[i], 0); const resto = soma % 11; return resto < 2 ? 0 : 11 - resto; };
  const dv1 = dv(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const dv2 = dv(`${base12}${dv1}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base12}${dv1}${dv2}`;
};

function carregarRotas(pool, exigirSessao) {
  try {
    // eslint-disable-next-line global-require
    const { criarTipoMaterialRoutes } = require('../../src/routes/tipo-material.routes');
    // eslint-disable-next-line global-require
    const { criarTipoMaterialController } = require('../../src/controllers/tipo-material.controller');
    return criarTipoMaterialRoutes({ controller: criarTipoMaterialController({ pool }), exigirSessao, pool });
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND') return null;
    throw erro;
  }
}

describe('catálogo de tipos de material (RED)', () => {
  let ctx;
  let d;
  let app;
  let gestor;
  let gestorB;
  let soVer;
  let soCriar;
  let seq = 0;

  const como = (id) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(id)),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(id)).send(corpo),
  });
  async function usuarioCom(empresaId, operacoes) {
    seq += 1;
    const id = await inserirUsuario(ctx.pool, empresaId, `catalogo-${seq}@example.invalid`, 'USUARIO');
    const mestre = empresaId === d.empresaA ? d.master : d.masterB;
    await ctx.pool.query(
      `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
       VALUES ($1, $2, 'materials', $3, $4, $5, false, $6)`,
      [empresaId, id, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), mestre],
    );
    return id;
  }
  const nome = (p) => `${p} ${crypto.randomUUID().slice(0, 8)}`;
  const criar = (corpo, quem = gestor) => como(quem).post(RAIZ, { grupo: 'EPI', grupoProtecao: 'Proteção das mãos', nome: nome('Luva'), ...corpo });
  const criado = async (corpo, quem) => {
    const r = await criar(corpo, quem);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.tipo;
  };
  const detalhes = (r) => (r.body.detalhes || []).map((x) => [x.campo, x.codigo]);
  const recusa = (r, campo, codigo, status = 400) => {
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.ok(detalhes(r).some(([c, k]) => c === campo && k === codigo) || r.body.codigo === codigo, `esperado ${campo}/${codigo}; veio ${JSON.stringify(r.body)}`);
  };
  const tabela = (empresaId, filtro = '') => dependeDaMigration((async () => (await ctx.pool.query(
    `SELECT id, grupo, grupo_protecao, nome, ativo, origem FROM tipos_material WHERE empresa_id = $1 ${filtro} ORDER BY id`, [empresaId],
  )).rows)(), 'tabela tipos_material');
  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    for (const empresaId of [d.empresaA, d.empresaB]) await provisionamento.provisionar(ctx.pool, { empresaId, dryRun: false });
    const exigirSessao = sessaoDeTeste(ctx.pool);
    const { pool } = ctx;
    app = criarAppTeste((a) => {
      const rotas = carregarRotas(pool, exigirSessao);
      if (rotas) a.use('/api', rotas);
    });
    gestor = await usuarioCom(d.empresaA, ['visualizar', 'criar', 'editar']);
    gestorB = await usuarioCom(d.empresaB, ['visualizar', 'criar', 'editar']);
    soVer = await usuarioCom(d.empresaA, ['visualizar']);
    soCriar = await usuarioCom(d.empresaA, ['visualizar', 'criar']);
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  describe('consulta', () => {
    test('lista os tipos da empresa com o vocabulário fechado (2 grupos e 12 grupos de proteção, sem "Outros")', async () => {
      const t = await criado({ nome: nome('Listado') });
      const r = await como(soVer).get(`${RAIZ}?busca=${encodeURIComponent(t.nome)}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.tipos.map((x) => x.id), [t.id]);
      assert.deepEqual(Object.keys(r.body.tipos[0]).sort(), ['ativo', 'grupo', 'grupoProtecao', 'id', 'nome', 'origem']);
      assert.deepEqual(r.body.vocabulario.grupos, ['EPI', 'Vestimenta']);
      assert.deepEqual(r.body.vocabulario.gruposProtecao, [...GRUPOS_PROTECAO]);
    });

    test('filtros por grupo, grupo de proteção e ativo; a empresa vem só da sessão', async () => {
      const a = await criado({ grupo: 'Vestimenta', grupoProtecao: 'Proteção do tronco', nome: nome('FiltroV') });
      const b = await criado({ grupo: 'EPI', grupoProtecao: 'Proteção facial', nome: nome('FiltroE') });
      await como(gestor).post(`${RAIZ}/${b.id}/inativar`);
      const porGrupo = await como(gestor).get(`${RAIZ}?grupo=Vestimenta&limite=100`);
      assert.ok(porGrupo.body.tipos.every((x) => x.grupo === 'Vestimenta') && porGrupo.body.tipos.some((x) => x.id === a.id));
      const inativos = await como(gestor).get(`${RAIZ}?ativo=false&limite=100`);
      assert.ok(inativos.body.tipos.some((x) => x.id === b.id) && inativos.body.tipos.every((x) => x.ativo === false));
      const outraEmpresa = await como(gestorB).get(`${RAIZ}?limite=100`);
      assert.equal(outraEmpresa.body.tipos.some((x) => x.id === a.id), false);
      assert.equal((await como(gestor).get(`${RAIZ}?empresaId=${d.empresaB}`)).status, 400);
    });

    test('filtro inválido é recusado (grupo, proteção e ativo)', async () => {
      assert.equal((await como(gestor).get(`${RAIZ}?grupo=Outros`)).status, 400);
      assert.equal((await como(gestor).get(`${RAIZ}?grupoProtecao=Outros`)).status, 400);
      assert.equal((await como(gestor).get(`${RAIZ}?ativo=talvez`)).status, 400);
    });
  });

  describe('criação', () => {
    test('cria com o texto normalizado, origem MANUAL, ativo, e audita sem dado pessoal', async () => {
      const r = await criar({ grupo: 'EPI', grupoProtecao: 'Proteção das mãos', nome: `  Luva   Normalizada\n${crypto.randomUUID().slice(0, 4)}  ` });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.match(r.body.tipo.nome, /^Luva Normalizada [0-9a-f]{4}$/);
      assert.deepEqual([r.body.tipo.grupo, r.body.tipo.grupoProtecao, r.body.tipo.ativo, r.body.tipo.origem], ['EPI', 'Proteção das mãos', true, 'MANUAL']);
      const aud = (await ctx.pool.query("SELECT usuario_id, referencia, contexto FROM logs_auditoria WHERE acao = 'TIPO_MATERIAL_CRIADO' AND referencia = $1", [String(r.body.tipo.id)])).rows;
      assert.equal(aud.length, 1);
      assert.equal(aud[0].usuario_id, gestor);
    });

    test('duplicado lógico (caixa, espaços repetidos, outra proteção do mesmo grupo) é 409; outro grupo e outra empresa podem repetir', async () => {
      const t = await criado({ nome: nome('Unico') });
      const dup = await criar({ nome: t.nome.toUpperCase() });
      recusa(dup, 'body.nome', 'TIPO_MATERIAL_JA_EXISTE', 409);
      recusa(await criar({ grupoProtecao: 'Proteção dos braços', nome: t.nome.replace(' ', '   ') }), 'body.nome', 'TIPO_MATERIAL_JA_EXISTE', 409);
      assert.equal((await criar({ grupo: 'Vestimenta', grupoProtecao: 'Proteção do tronco', nome: t.nome })).status, 201);
      assert.equal((await criar({ nome: t.nome }, gestorB)).status, 201);
    });

    test('"Outros" nunca vira linha física; grupo e proteção fora do vocabulário; nome vazio, com controle ou acima de 100; campos extras', async () => {
      recusa(await criar({ nome: 'Outros' }), 'body.nome', 'TIPO_MATERIAL_OUTROS_RESERVADO');
      recusa(await criar({ nome: ' outros ' }), 'body.nome', 'TIPO_MATERIAL_OUTROS_RESERVADO');
      recusa(await criar({ grupo: 'Outros' }), 'body.grupo', 'GRUPO_INVALIDO');
      recusa(await criar({ grupo: 'Ferramenta' }), 'body.grupo', 'GRUPO_INVALIDO');
      recusa(await criar({ grupoProtecao: 'Outros' }), 'body.grupoProtecao', 'GRUPO_PROTECAO_INVALIDO');
      recusa(await criar({ grupoProtecao: 'Proteção inventada' }), 'body.grupoProtecao', 'GRUPO_PROTECAO_INVALIDO');
      recusa(await criar({ nome: '   ' }), 'body.nome', 'NOME_INVALIDO');
      recusa(await criar({ nome: 'A\u0007B' }), 'body.nome', 'NOME_INVALIDO');
      recusa(await criar({ nome: 'x'.repeat(101) }), 'body.nome', 'NOME_INVALIDO');
      for (const extra of [{ empresaId: d.empresaB }, { ativo: false }, { origem: 'BASE' }, { id: 5 }]) {
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await criar(extra)).status, 400, JSON.stringify(extra));
      }
      assert.equal((await tabela(d.empresaA, "AND lower(nome) = 'outros'")).length, 0);
    });

    test('permissões: criar exige materials.criar; só visualizar não cria; sem sessão válida não entra', async () => {
      assert.equal((await criar({}, soVer)).status, 403);
      assert.equal((await criar({}, soCriar)).status, 201);
      assert.equal((await request(app).post(RAIZ).send({})).status, 401);
    });
  });

  describe('inativação e reativação', () => {
    test('inativar exige materials.editar, preserva o registro e o material já vinculado; reativar devolve; repetir é idempotente', async () => {
      const t = await criado({ nome: nome('Ciclo') });
      assert.equal((await como(soCriar).post(`${RAIZ}/${t.id}/inativar`)).status, 403, 'criar não basta');
      const inativado = await como(gestor).post(`${RAIZ}/${t.id}/inativar`);
      assert.equal(inativado.status, 200, JSON.stringify(inativado.body));
      assert.equal(inativado.body.tipo.ativo, false);
      assert.equal((await como(gestor).post(`${RAIZ}/${t.id}/inativar`)).status, 200);
      const reativado = await como(gestor).post(`${RAIZ}/${t.id}/reativar`);
      assert.equal(reativado.body.tipo.ativo, true);
      assert.equal((await tabela(d.empresaA, `AND id = ${Number(t.id)}`)).length, 1, 'nada é apagado');
      const aud = (await ctx.pool.query("SELECT acao FROM logs_auditoria WHERE referencia = $1 AND acao LIKE 'TIPO_MATERIAL_%' ORDER BY id", [String(t.id)])).rows.map((x) => x.acao);
      assert.deepEqual(aud, ['TIPO_MATERIAL_CRIADO', 'TIPO_MATERIAL_INATIVADO', 'TIPO_MATERIAL_REATIVADO']);
    });

    test('outra empresa ou id inexistente respondem o mesmo 404', async () => {
      const t = await criado({ nome: nome('Alheio') });
      const alheio = await como(gestorB).post(`${RAIZ}/${t.id}/inativar`);
      const inexistente = await como(gestorB).post(`${RAIZ}/2147483000/inativar`);
      assert.equal(alheio.status, 404, JSON.stringify(alheio.body));
      assert.deepEqual([inexistente.status, inexistente.body], [alheio.status, alheio.body]);
    });
  });

  describe('empresa criada DEPOIS da implantação', () => {
    test('recebe o catálogo base de 26 tipos exatamente uma vez, sem duplicação, só dela', async () => {
      const empresaCadastro = exigir('../../src/services/empresa-cadastro.service', 'serviço de cadastro de empresa');
      const admin = (await ctx.pool.query("INSERT INTO administradores_plataforma (email, senha_hash) VALUES ('admin.catalogo@example.invalid', 'h') RETURNING id")).rows[0].id;
      const antes = await dependeDaMigration(ctx.pool.query('SELECT count(*)::int n FROM tipos_material'), 'tabela tipos_material');
      const criada = await empresaCadastro.criar(ctx.pool, { administradorId: admin, razaoSocial: 'Empresa Nova Catalogo Ltda', cnpj: cnpjValido('555666770001') });
      const empresaId = criada.empresa?.id ?? criada.id;
      assert.ok(Number.isInteger(empresaId), `empresa criada sem id: ${JSON.stringify(criada)}`);
      const linhas = await tabela(empresaId);
      assert.equal(linhas.length, 26);
      assert.deepEqual(linhas.map((l) => [l.grupo, l.grupo_protecao, l.nome].join('|')).sort(), CATALOGO_BASE.map((t) => t.join('|')).sort());
      assert.ok(linhas.every((l) => l.origem === 'BASE' && l.ativo === true));
      assert.equal(linhas.some((l) => /^outros$/i.test(l.nome) || l.grupo === 'Outros' || l.grupo_protecao === 'Outros'), false);
      const total = await ctx.pool.query('SELECT count(*)::int n FROM tipos_material');
      assert.equal(total.rows[0].n, antes.rows[0].n + 26, 'nenhuma outra empresa foi tocada');
    });
  });
});
