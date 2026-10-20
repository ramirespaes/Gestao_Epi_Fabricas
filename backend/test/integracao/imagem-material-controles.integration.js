'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirAmbienteImagens, CLASSIFICACAO_OUTROS } = require('./helpers/imagem-material');
const { BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const materialService = require('../../src/services/material.service');
const catalogoService = require('../../src/services/token-catalogo.service');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — CONTROLES do ambiente (devem PASSAR já no RED e continuar passando no GREEN). Provam que o harness das
 * suítes imagem-material-*.integration.js é confiável, para que cada falha do RED seja por ausência de implementação e nunca por defeito do próprio teste:
 * banco e schema isolados, construtores de dados, payload válido do serviço de materiais, catálogo atual do Totem, auxiliar de espera por bloqueio e as
 * chaves de auditoria aceitas pela barreira JSON da migration 014. Não afirmam nada do comportamento novo.
 */

const CHAVES_DO_MATERIAL = ['categoria', 'exigeTamanho', 'grupoProtecao', 'id', 'imagem', 'nome', 'tamanhos', 'tipo', 'unidade'];

describe('controles do ambiente da Biblioteca de Imagens (passam já no RED)', () => {
  let a;
  before(async () => { a = await abrirAmbienteImagens(); });
  after(async () => { if (a) await a.encerrar(); });

  test('CTL-01: banco de teste exclusivo, schema temporário próprio (nunca public), search_path só nele, com a 090 aplicada e as três tabelas de imagem', async () => {
    const { rows } = await a.q("SELECT current_database() AS banco, current_schema() AS schema, current_setting('search_path') AS caminho");
    assert.equal(rows[0].banco, BANCO_DE_TESTE);
    assert.match(rows[0].schema, /^test_migration_[0-9a-f]{12}$/);
    assert.equal(rows[0].caminho, rows[0].schema);
    assert.equal(todasAsMigrations().includes('090'), true);
    const tabelas = (await a.q("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'imagens\\_%' ORDER BY 1")).rows.map((r) => r.table_name);
    assert.deepEqual(tabelas, ['imagens_empresa', 'imagens_padrao', 'imagens_padrao_tipos']);
  });

  test('CTL-02: os construtores criam dados reais e isolados: duas empresas, padrão sintética (sem as 30 imagens reais), imagem da empresa, material e funcionário no GHE', async () => {
    const p = await a.padrao({ nome: 'Padrão CTL02' });
    const e = await a.daEmpresa(a.d.empresaA, a.d.atorA);
    const m = await a.material(a.d.empresaA, 'Material CTL02');
    const f = await a.funcionarioComMaterial(a.d.empresaA, [m]);
    assert.ok(p.id > 0 && e.id > 0 && m > 0 && f.funcionarioId > 0);
    assert.equal(e.estado, 'ATIVA');
    assert.equal(await a.contagem('imagens_padrao', "arquivo_origem NOT LIKE 'padrao-%'"), 0, 'só linhas sintéticas');
    await assert.rejects(a.daEmpresa(a.d.empresaA, a.d.atorB), (erro) => erro.code === '23503', 'o criador precisa ser da mesma empresa');
  });

  test('CTL-03: o payload de teste do serviço de materiais é válido HOJE (classificação "Outros"): criar, alterar o nome e a regra MATERIAL_SEM_ALTERACAO para corpo vazio', async () => {
    const m = await materialService.criar(a.pool, { empresaId: a.d.empresaA, atorId: a.d.atorA, nome: 'Material CTL03', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS });
    assert.ok(m.id > 0);
    assert.equal((await a.linhaDoMaterial(m.id)).modelo_classificacao, 'V2');
    const alterado = await materialService.alterar(a.pool, { empresaId: a.d.empresaA, atorId: a.d.atorA, materialId: m.id, nome: 'Material CTL03 b' });
    assert.equal(alterado.nome, 'Material CTL03 b');
    await assert.rejects(materialService.alterar(a.pool, { empresaId: a.d.empresaA, atorId: a.d.atorA, materialId: m.id }), (e) => e.codigo === 'MATERIAL_SEM_ALTERACAO');
  });

  test('CTL-04: o catálogo atual do Totem enxerga o material do funcionário com as chaves da Etapa E e, sem imagem, o fallback { disponivel:false } (vale antes e depois da Unidade 3)', async () => {
    const m = await a.material(a.d.empresaA, 'Material CTL04');
    const f = await a.funcionarioComMaterial(a.d.empresaA, [m]);
    const cliente = await a.pool.connect();
    try {
      await cliente.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
      const cat = await catalogoService.montarCatalogoDoFuncionario(cliente, { empresaId: a.d.empresaA, funcionarioId: f.funcionarioId });
      await cliente.query('COMMIT');
      assert.deepEqual([cat.estado, cat.total], ['OK', 1]);
      assert.deepEqual(Object.keys(cat.materiais[0]).sort(), CHAVES_DO_MATERIAL);
      assert.deepEqual(cat.materiais[0].imagem, { disponivel: false });
    } finally { cliente.release(); }
  });

  test('CTL-05: o auxiliar de espera por bloqueio é determinístico — uma sessão bloqueada por uma transação segurada é encontrada pelo pid, sem pausa arbitrária', async () => {
    const m = await a.material(a.d.empresaA, 'Material CTL05');
    const c = await a.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [{ pid }] } = await c.query('SELECT pg_backend_pid() AS pid');
      await c.query('SELECT id FROM materiais WHERE id = $1 FOR UPDATE', [m]);
      const bloqueada = a.pool.query('UPDATE materiais SET nome = nome || $2 WHERE id = $1', [m, '!']);
      const pidBloqueado = await a.esperarBloqueio(pid);
      assert.notEqual(pidBloqueado, pid);
      await c.query('COMMIT');
      await bloqueada;
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });

  test('CTL-06: o pool aceita a concorrência dos testes (oito envios simultâneos mais uma transação segurada)', () => {
    assert.ok(a.pool.options.max >= 10);
  });

  test('CTL-07: as chaves de auditoria planejadas passam pela barreira JSON da migration 014 (imagemId, formato, bytes, imagem{origem,id}, estado) — e uma chave sensível é recusada (controle positivo)', async () => {
    const ref = String(Date.now());
    await auditoriaRepo.registrar(a.pool, {
      empresaId: a.d.empresaA, usuarioId: a.d.atorA, acao: 'IMAGEM_MATERIAL_IMPORTADA', referencia: ref,
      contexto: { imagemId: 1, formato: 'PNG', bytes: 139000 }, dadosAnteriores: { imagem: null }, dadosNovos: { imagem: { origem: 'EMPRESA', id: 1 }, estado: 'ATIVA' },
    });
    assert.equal((await a.auditoria('IMAGEM_MATERIAL_IMPORTADA', a.d.empresaA)).some((l) => l.referencia === ref), true);
    await assert.rejects(auditoriaRepo.registrar(a.pool, { empresaId: a.d.empresaA, usuarioId: a.d.atorA, acao: 'IMAGEM_MATERIAL_IMPORTADA', contexto: { token: 'x' } }), (e) => e.code === 'P0001');
  });
});
