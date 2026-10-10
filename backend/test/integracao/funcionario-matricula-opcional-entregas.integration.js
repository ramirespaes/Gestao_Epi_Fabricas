'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, criarEmpresa, criarUsuario, criarGhe, criarFuncionario, criarMaterial, criarLote, inserir,
} = require('./helpers/entrega-epi');
const { criarLoteDeEntrada } = require('./helpers/solicitacao-epi');
const { montarMundoDoServico, vincularMaterialAoGhe, chaveNova } = require('./helpers/solicitacao-epi-servico');
const direta = require('../../src/services/entrega-epi.service');
const porSolicitacao = require('../../src/services/entrega-solicitacao.service');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const funcionarioRepo = require('../../src/repositories/funcionario.repository');
const fichaRepo = require('../../src/repositories/ficha-epi.repository');
const entregaRepo = require('../../src/repositories/entrega-epi.repository');
const itemRepo = require('../../src/repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../../src/repositories/entrega-epi-confirmacao.repository');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * 12K-E — GREEN DEPENDENTE DA MIGRATION 081: entrega DIRETA e por solicitação de trabalhador sem matrícula,
 * snapshot NULL, snapshot histórico, hash recalculável, buscas e ficha com matrícula NULL.
 *
 * Exigem a migration 081 (matrícula NULL persistível) e executam sempre; sem ela falham no preparo, e o RED estrutural
 * está em funcionario-matricula-opcional-banco.integration.js.
 */

const HOJE = dataOperacional();
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: 'Declaro que recebi os EPIs relacionados (texto fictício).' };
let cpfSeq = 80000000000;
const proximoCpf = () => String(cpfSeq++);

describe('12K-E — fluxos de entrega com matrícula opcional (GREEN dependente da 081)', () => {
  let contexto;
  let pool;
  const q = (sql, params) => pool.query(sql, params);

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('entrega DIRETA de trabalhador sem matrícula', () => {
    const d = {};
    before(async () => {
      d.empresa = await criarEmpresa(pool, '55666777000143', 'Empresa Direta');
      d.master = await criarUsuario(pool, d.empresa, 'master.direta@example.invalid');
      d.ghe = await criarGhe(pool, d.empresa, 'GHE Direta');
      d.material = await criarMaterial(pool, d.empresa, 'Botina direta', { tipo: 'Calçado', unidade: 'par' });
      await inserir(pool, 'ghe_materiais', { empresa_id: d.empresa, grupo_homogeneo_id: d.ghe, material_id: d.material });
      d.lote = await criarLote(pool, { empresaId: d.empresa, materialId: d.material, quantidade: 50 });
      d.semMatricula = await criarFuncionario(pool, d.empresa, { matricula: null, cpf: proximoCpf(), gheId: d.ghe, setor: 'Produção', funcao: 'Operador' });
      d.comMatricula = await criarFuncionario(pool, d.empresa, { matricula: 'COM-1', cpf: proximoCpf(), gheId: d.ghe });
    });
    const entregar = (funcionarioId) => direta.registrarEntrega(pool, {
      empresaId: d.empresa, atorId: d.master, funcionarioId, itens: [{ materialId: d.material, loteId: d.lote, quantidade: 1, motivo: 'ADMISSAO' }],
      confirmacao: ACEITE, chaveIdempotencia: crypto.randomUUID(), ip: '203.0.113.10', dispositivo: 'Navegador de teste',
    });

    test('grava trabalhador_matricula NULL no snapshot, sem "null" textual nem matrícula inventada', async () => {
      const r = await entregar(d.semMatricula);
      assert.equal(r.entrega.trabalhador.matricula, null);
      const { rows: [e] } = await q('SELECT trabalhador_matricula FROM entregas_epi WHERE id = $1', [r.entrega.id]);
      assert.equal(e.trabalhador_matricula, null);
    });

    test('o hash de conteúdo é recalculável a partir do que foi gravado (matrícula NULL)', async () => {
      const r = await entregar(d.semMatricula);
      const entrega = await entregaRepo.buscarPorId(pool, d.empresa, r.entrega.id);
      const itens = await itemRepo.listarPorEntrega(pool, d.empresa, r.entrega.id);
      const confirmacao = await confirmacaoRepo.buscarPorEntrega(pool, d.empresa, r.entrega.id);
      const ficha = await fichaRepo.buscarPorId(pool, d.empresa, r.entrega.fichaId);
      assert.equal(direta.calcularHashConteudo({ entrega, ficha, itens, confirmacao }), r.confirmacao.hashConteudo);
    });

    test('quem tem matrícula continua copiando a matrícula no snapshot', async () => {
      const r = await entregar(d.comMatricula);
      assert.equal(r.entrega.trabalhador.matricula, 'COM-1');
      const { rows: [e] } = await q('SELECT trabalhador_matricula FROM entregas_epi WHERE id = $1', [r.entrega.id]);
      assert.equal(e.trabalhador_matricula, 'COM-1');
    });

    test('o snapshot é histórico: preencher a matrícula depois não reescreve a entrega antiga', async () => {
      const r = await entregar(d.semMatricula);
      await q("UPDATE funcionarios SET matricula = 'NOVA-1' WHERE id = $1", [d.semMatricula]);
      const { rows: [e] } = await q('SELECT trabalhador_matricula FROM entregas_epi WHERE id = $1', [r.entrega.id]);
      assert.equal(e.trabalhador_matricula, null);
      await q('UPDATE funcionarios SET matricula = NULL WHERE id = $1', [d.semMatricula]);
    });

    test('buscas e listagens toleram matrícula NULL: por nome acha; por matrícula não acha quem não tem; a ficha lista', async () => {
      await entregar(d.semMatricula);
      const lista = await funcionarioRepo.listarPorEmpresa(pool, d.empresa, { busca: 'Trabalhador', pagina: 1, limite: 50 });
      assert.ok(lista.some((f) => f.id === d.semMatricula && f.matricula === null));
      const porMatricula = await funcionarioRepo.listarPorEmpresa(pool, d.empresa, { busca: 'COM-1', pagina: 1, limite: 50 });
      assert.deepEqual(porMatricula.map((f) => f.id), [d.comMatricula]);
      const fichas = await fichaRepo.listar(pool, d.empresa, { pagina: 1, limite: 50, busca: 'Trabalhador' });
      const dela = fichas.find((f) => f.ficha.funcionarioId === d.semMatricula);
      assert.ok(dela, 'a ficha do trabalhador sem matrícula aparece');
      assert.equal(dela.funcionarioAtual.matricula, null);
    });
  });

  describe('entrega por solicitação de trabalhador sem matrícula', () => {
    test('solicitação aprovada → entrega: snapshot NULL e solicitação ENTREGUE', async () => {
      const d = await montarMundoDoServico(pool);
      const trabalhador = await criarFuncionario(pool, d.empresaA, { matricula: null, cpf: proximoCpf(), gheId: d.gheA });
      const material = await criarMaterial(pool, d.empresaA, 'Material sem matrícula', { exigeTamanho: true });
      await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, material);
      const criada = await solicitacaoSvc.criarSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: trabalhador,
        itens: [{ materialId: material, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
      });
      await solicitacaoSvc.decidirSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: criada.solicitacao.id,
        decisoes: [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }], hoje: HOJE,
      });
      const loteId = await criarLoteDeEntrada(pool, { empresaId: d.empresaA, materialId: material, quantidade: 3, usuarioId: d.master });
      const r = await porSolicitacao.registrarEntregaPorSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.master, solicitacaoId: criada.solicitacao.id,
        itens: [{ solicitacaoItemId: criada.itens[0].id, loteId, quantidade: 1 }],
        confirmacao: ACEITE, chaveIdempotencia: chaveNova(), ip: '203.0.113.10', dispositivo: 'Navegador de teste',
      });
      assert.equal(r.solicitacao.status, 'ENTREGUE');
      const { rows: [e] } = await q('SELECT trabalhador_matricula, origem FROM entregas_epi WHERE id = $1', [r.entrega.id]);
      assert.deepEqual([e.trabalhador_matricula, e.origem], [null, 'SOLICITACAO']);
    });
  });
});
