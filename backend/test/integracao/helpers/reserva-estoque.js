'use strict';

const { criarMaterial } = require('./entrega-epi');
const { criarLoteDeEntrada } = require('./solicitacao-epi');
const { vincularMaterialAoGhe, chaveNova } = require('./solicitacao-epi-servico');
const solicitacaoSvc = require('../../../src/services/solicitacao-epi.service');
const diretaSvc = require('../../../src/services/entrega-epi.service');
const estoqueSvc = require('../../../src/services/estoque.service');
const coberturaRepo = require('../../../src/repositories/solicitacao-epi-cobertura.repository');
const { dataOperacional } = require('../../../src/utils/data-operacional');

/**
 * Ferramentas dos testes de reserva lógica e saldo livre (12C-3) contra
 * PostgreSQL real. Tudo passa pelos serviços de verdade: a solicitação é
 * criada e aprovada pelos serviços da 12B, a entrega DIRETA e a baixa pelos
 * serviços do Bloco 10 e do estoque. Cada cenário usa um material próprio,
 * porque a posição é por empresa, material e tamanho.
 */

const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };

function criarFerramentas(pool, d) {
  const HOJE = dataOperacional();
  let sequencia = 0;

  async function material({ previsto = true, ...opcoes } = {}) {
    sequencia += 1;
    const id = await criarMaterial(pool, d.empresaA, `Material de reserva ${sequencia}`, { exigeTamanho: true, ...opcoes });
    if (previsto) await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, id);
    return id;
  }

  const estoque = (materialId, quantidade, extra = {}) => criarLoteDeEntrada(pool, {
    empresaId: d.empresaA, materialId, quantidade, usuarioId: d.master, ...extra,
  });

  // Solicitação criada e aprovada pelos serviços da 12B (item inteiro; `aprovada` menor reduz).
  async function aprovada({ materialId, quantidade, funcionarioId = d.trabalhador, tamanho = '40' }) {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId, itens: [{ materialId, tamanho, quantidade, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.sst1, solicitacaoId: criada.solicitacao.id, decisoes: [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }], hoje: HOJE,
    });
    return { id: criada.solicitacao.id, item: criada.itens[0].id };
  }

  // Entrega DIRETA: itens = [[materialId, loteId, quantidade]], para um trabalhador que não é o da solicitação.
  const direta = (itens, extra = {}) => diretaSvc.registrarEntrega(pool, {
    empresaId: d.empresaA,
    atorId: d.master,
    funcionarioId: d.trabalhador2,
    itens: itens.map(([materialId, loteId, quantidade]) => ({ materialId, loteId, quantidade, motivo: 'ADMISSAO' })),
    confirmacao: ACEITE,
    chaveIdempotencia: chaveNova(),
    ip: '203.0.113.10',
    dispositivo: 'Navegador de teste',
    ...extra,
  });

  const baixa = (loteId, quantidade, motivo = 'AVARIA', extra = {}) => estoqueSvc.registrarBaixa(pool, {
    empresaId: d.empresaA,
    atorId: d.master,
    loteId,
    quantidade,
    motivo,
    ...(motivo === 'OUTRO' ? { justificativa: 'Doação autorizada pela diretoria' } : {}),
    chaveIdempotencia: chaveNova(),
    ip: '203.0.113.10',
    dispositivo: 'Navegador de teste',
    ...extra,
  });

  const posicao = async (materialId, tamanho = '40') => (
    await coberturaRepo.lerPosicoes(pool, d.empresaA, [{ materialId, tamanho }], { hoje: HOJE })
  )[0];
  // U, D, C, L, G.
  const numeros = (p) => [p.fisicoUtilizavel, p.demandaPendente, p.comprometido, p.saldoLivre, p.semCobertura];

  const lote = async (id) => (await pool.query(
    'SELECT quantidade_entrada AS entrada, quantidade_baixada AS baixada, quantidade_entregue AS entregue, saldo FROM estoque_lotes WHERE id = $1', [id],
  )).rows[0];
  const saldoDoMaterial = async (materialId) => (await pool.query(
    'SELECT COALESCE(sum(saldo), 0)::int AS n FROM estoque_lotes WHERE material_id = $1', [materialId],
  )).rows[0].n;

  // Auditorias de recusa do material (a ação é SALDO_LIVRE_INSUFICIENTE; o contexto leva só números e ids).
  const recusas = async (materialId, filtro = {}) => (await pool.query(
    `SELECT id, usuario_id, referencia, ip, dispositivo, descricao, contexto FROM logs_auditoria
      WHERE acao = 'SALDO_LIVRE_INSUFICIENTE' AND empresa_id = $1 AND (contexto->>'materialId')::int = $2
        AND ($3::text IS NULL OR contexto->>'operacao' = $3) AND ($4::int IS NULL OR usuario_id = $4) ORDER BY id`,
    [d.empresaA, materialId, filtro.operacao ?? null, filtro.usuarioId ?? null],
  )).rows;

  const baixasAuditadas = async (loteId) => (await pool.query(
    "SELECT contexto FROM logs_auditoria WHERE acao = 'ESTOQUE_BAIXA' AND referencia = $1 ORDER BY id", [String(loteId)],
  )).rows.map((r) => r.contexto);

  return {
    HOJE, material, estoque, aprovada, direta, baixa, posicao, numeros, lote, saldoDoMaterial, recusas, baixasAuditadas,
  };
}

module.exports = { criarFerramentas, ACEITE };
