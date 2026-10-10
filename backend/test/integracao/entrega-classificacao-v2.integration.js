'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations, criarEmpresa, criarUsuario, criarGhe, criarFuncionario, criarMaterial, criarLote, inserir } = require('./helpers/entrega-epi');
const { dependeDaMigration } = require('./helpers/classificacao-v2');
const direta = require('../../src/services/entrega-epi.service');
const entregaRepo = require('../../src/repositories/entrega-epi.repository');
const itemRepo = require('../../src/repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../../src/repositories/entrega-epi-confirmacao.repository');
const fichaRepo = require('../../src/repositories/ficha-epi.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * RED — entrega de EPI com a classificação V2 (07/10/2026), PostgreSQL real em schema temporário:
 *   - o item da entrega copia material_grupo_protecao (snapshot); o legado grava NULL;
 *   - o hash de conteúdo inclui o grupo de proteção SÓ quando existe: entregas antigas continuam byte a byte iguais;
 *   - "óculos com grau" é exigido pela classificação (EPI + Proteção ocular), nunca pelo nome do tipo; o legado continua
 *     pelos três nomes históricos.
 * Os materiais V2 entram por SQL (a tabela e as colunas são da migration 082, ainda inexistente: os testes falham por isso).
 */

const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: 'Declaro que recebi os EPIs relacionados (texto fictício).' };

describe('entrega × classificação V2 (RED)', () => {
  let ctx;
  let pool;
  const d = {};
  let seq = 0;
  const q = (sql, params) => pool.query(sql, params);

  const entregar = (materialId, loteId) => direta.registrarEntrega(pool, {
    empresaId: d.empresa, atorId: d.master, funcionarioId: d.trabalhador, itens: [{ materialId, loteId, quantidade: 1, motivo: 'ADMISSAO', justificativaForaGhe: 'Teste' }],
    confirmacao: ACEITE, chaveIdempotencia: crypto.randomUUID(), ip: '203.0.113.10', dispositivo: 'Navegador de teste',
  });
  const lote = (materialId) => criarLote(pool, { empresaId: d.empresa, materialId, quantidade: 20, tamanho: null });
  const materialV2 = (c) => dependeDaMigration((async () => {
    seq += 1;
    let tipoId = null;
    let tipo = 'Outros';
    if (c.tipoCatalogo) {
      tipoId = (await q('INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome) VALUES ($1, $2, $3, $4) RETURNING id', [d.empresa, c.categoria, c.grupoProtecao, `${c.tipoCatalogo} ${seq}`])).rows[0].id;
      tipo = `${c.tipoCatalogo} ${seq}`;
    }
    return (await q(
      `INSERT INTO materiais (empresa_id, nome, categoria, grupo_protecao, tipo_material_id, tipo, tipo_descricao, oculos_com_grau, modelo_classificacao, prazo_uso_dias, exige_tamanho, exige_ca, unidade)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'V2', 180, false, false, 'unidade') RETURNING id`,
      [d.empresa, `Material V2 ${seq}`, c.categoria, c.grupoProtecao, tipoId, tipo, tipoId ? null : 'Descrição do item', c.oculosComGrau ?? null],
    )).rows[0].id;
  })(), 'classificação V2 em materiais/tipos_material');
  const snapshot = async (entregaId) => dependeDaMigration((async () => (await q('SELECT material_tipo, material_grupo_protecao FROM entregas_epi_itens WHERE entrega_id = $1', [entregaId])).rows[0])(), 'coluna material_grupo_protecao');
  const lidos = async (r) => ({
    entrega: await entregaRepo.buscarPorId(pool, d.empresa, r.entrega.id),
    ficha: await fichaRepo.buscarPorId(pool, d.empresa, r.entrega.fichaId),
    itens: await itemRepo.listarPorEntrega(pool, d.empresa, r.entrega.id),
    confirmacao: await confirmacaoRepo.buscarPorEntrega(pool, d.empresa, r.entrega.id),
  });
  const esperarConflito = (promessa, codigo) => assert.rejects(promessa, (e) => HttpError.ehHttpError(e) && e.status === 409 && e.codigo === codigo);

  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    pool = ctx.pool;
    d.empresa = await criarEmpresa(pool, '11222333000181', 'Empresa Entrega V2');
    d.master = await criarUsuario(pool, d.empresa, 'master.v2@example.invalid');
    d.ghe = await criarGhe(pool, d.empresa, 'GHE V2');
    d.trabalhador = await criarFuncionario(pool, d.empresa, { matricula: 'M-1', cpf: '52998224725', gheId: d.ghe });
    d.legadoCapacete = await criarMaterial(pool, d.empresa, 'Capacete legado', { exigeTamanho: false, exigeCa: false, tipo: 'Capacete' });
    d.legadoOculos = await criarMaterial(pool, d.empresa, 'Óculos legado sem classificação', { exigeTamanho: false, exigeCa: false, tipo: 'Óculos de proteção', oculosComGrau: null });
    d.loteCapacete = await lote(d.legadoCapacete);
    d.loteOculosLegado = await lote(d.legadoOculos);
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('LEGADO: a entrega grava material_grupo_protecao NULL e o hash gravado continua recalculável e idêntico ao de hoje (campo ausente não entra)', async () => {
    const r = await entregar(d.legadoCapacete, d.loteCapacete);
    assert.deepEqual(await snapshot(r.entrega.id), { material_tipo: 'Capacete', material_grupo_protecao: null });
    const l = await lidos(r);
    assert.equal(l.itens[0].material.grupoProtecao ?? null, null);
    assert.equal(direta.calcularHashConteudo(l), r.confirmacao.hashConteudo);
    const semChave = { ...l, itens: l.itens.map((i) => { const m = { ...i.material }; delete m.grupoProtecao; return { ...i, material: m }; }) };
    assert.equal(direta.calcularHashConteudo(semChave), r.confirmacao.hashConteudo, 'com ou sem a chave nula, o hash é o mesmo: entregas antigas não mudam');
  });

  test('V2 + Proteção ocular (tipo Outros, grau definido): o snapshot copia o grupo de proteção; o hash passa a incluí-lo', async () => {
    const m = await materialV2({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', oculosComGrau: false });
    const r = await entregar(m, await lote(m));
    assert.deepEqual(await snapshot(r.entrega.id), { material_tipo: 'Outros', material_grupo_protecao: 'Proteção ocular' });
    const l = await lidos(r);
    assert.equal(l.itens[0].material.grupoProtecao, 'Proteção ocular');
    assert.equal(direta.calcularHashConteudo(l), r.confirmacao.hashConteudo);
    const semGrupo = { ...l, itens: l.itens.map((i) => ({ ...i, material: { ...i.material, grupoProtecao: null } })) };
    assert.notEqual(direta.calcularHashConteudo(semGrupo), r.confirmacao.hashConteudo, 'o grupo de proteção faz parte do conteúdo histórico quando existe');
  });

  test('V2 + Proteção ocular com grau NULL é recusada (MATERIAL_OCULOS_NAO_CLASSIFICADO) mesmo com tipo "Outros" sem "óculos" no nome', async () => {
    const m = await materialV2({ categoria: 'EPI', grupoProtecao: 'Proteção ocular', oculosComGrau: null });
    await esperarConflito(entregar(m, await lote(m)), 'MATERIAL_OCULOS_NAO_CLASSIFICADO');
  });

  test('V2 fora de Proteção ocular NÃO exige grau, mesmo com "Óculos" no nome do tipo (a regra é pela classificação)', async () => {
    const m = await materialV2({ categoria: 'EPI', grupoProtecao: 'Proteção facial', tipoCatalogo: 'Óculos de Proteção Falso', oculosComGrau: null });
    const r = await entregar(m, await lote(m));
    assert.deepEqual(await snapshot(r.entrega.id), { material_tipo: (await q('SELECT tipo FROM materiais WHERE id = $1', [m])).rows[0].tipo, material_grupo_protecao: 'Proteção facial' });
  });

  test('V2 + Vestimenta: snapshot com o grupo de proteção e sem exigência de grau', async () => {
    const m = await materialV2({ categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipoCatalogo: 'Avental', oculosComGrau: null });
    const r = await entregar(m, await lote(m));
    assert.equal((await snapshot(r.entrega.id)).material_grupo_protecao, 'Proteção do tronco');
  });

  test('LEGADO: o nome histórico "Óculos de proteção" sem grau continua recusado (comportamento preservado)', async () => {
    await esperarConflito(entregar(d.legadoOculos, d.loteOculosLegado), 'MATERIAL_OCULOS_NAO_CLASSIFICADO');
  });

  test('o histórico de entregas devolve o grupo de proteção do item (NULL no legado) sem mudar o restante do contrato', async () => {
    const historicoRepo = require('../../src/repositories/entrega-epi-historico.repository'); // eslint-disable-line global-require
    const itens = await historicoRepo.listar(pool, d.empresa, { padraoItem: null, padraoFuncionario: null, de: null, ate: null, status: null, diasProximo: null }, { pagina: 1, limite: 50 });
    assert.ok(itens.length >= 3);
    for (const i of itens) assert.ok(Object.hasOwn(i.material, 'grupoProtecao'), 'material.grupoProtecao presente');
    assert.ok(itens.some((i) => i.material.grupoProtecao === 'Proteção ocular'));
    assert.ok(itens.some((i) => i.material.tipo === 'Capacete' && i.material.grupoProtecao === null));
  });
});
