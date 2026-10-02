'use strict';

const crypto = require('node:crypto');
const {
  HASH, transacao, inserir, criarEmpresa, criarUsuario, criarGhe, criarFuncionario, criarMaterial, criarLote, criarFicha,
  registrarEntrega,
} = require('./entrega-epi');

/**
 * Fixtures da solicitação de EPI direto no banco, para os testes da migration
 * 065 e dos repositórios da 12A. Cada função recebe um executor (Client ou
 * Pool do pg). Só dados fictícios. O SQL do contador é o mesmo que o
 * repositório usa: o ROLLBACK desfaz o incremento, então não sobra lacuna.
 */

const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';

const SQL_PROXIMO_NUMERO_DA_SOLICITACAO = `
  INSERT INTO solicitacoes_epi_numeracao (empresa_id, ultimo_numero) VALUES ($1, 1)
  ON CONFLICT (empresa_id) DO UPDATE SET ultimo_numero = solicitacoes_epi_numeracao.ultimo_numero + 1
  RETURNING ultimo_numero`;

async function proximoNumeroDaSolicitacao(executor, empresaId) {
  return (await executor.query(SQL_PROXIMO_NUMERO_DA_SOLICITACAO, [empresaId])).rows[0].ultimo_numero;
}

function inserirSolicitacao(executor, valores) {
  return inserir(executor, 'solicitacoes_epi', {
    origem_solicitacao: 'USUARIO_INTERNO',
    quantidade_itens: 1,
    chave_idempotencia: crypto.randomUUID(),
    requisicao_hash: HASH,
    ...valores,
  });
}

function inserirItemDaSolicitacao(executor, valores) {
  return inserir(executor, 'solicitacoes_epi_itens', {
    tamanho: '40',
    quantidade: 2,
    motivo: 'ADMISSAO',
    previsto_no_ghe: true,
    ...valores,
  });
}

/**
 * Empresas A e B, com usuários, GHE, trabalhadores e materiais. O solicitante
 * e o aprovador são usuários diferentes da empresa A, porque quem pede não
 * decide o próprio pedido.
 */
async function montarCenario(executor) {
  const d = {};
  d.empresaA = await criarEmpresa(executor, CNPJ_A, 'Empresa A Fictícia');
  d.empresaB = await criarEmpresa(executor, CNPJ_B, 'Empresa B Fictícia');
  d.solicitante = await criarUsuario(executor, d.empresaA, 'solicitante-a@example.invalid');
  d.aprovador = await criarUsuario(executor, d.empresaA, 'aprovador-a@example.invalid');
  d.usuarioB = await criarUsuario(executor, d.empresaB, 'usuario-b@example.invalid');
  d.gheA = await criarGhe(executor, d.empresaA, 'GHE A');
  d.gheB = await criarGhe(executor, d.empresaB, 'GHE B');
  d.trabalhadorA = await criarFuncionario(executor, d.empresaA, { matricula: 'A-1', cpf: '11111111111', gheId: d.gheA });
  d.trabalhadorA2 = await criarFuncionario(executor, d.empresaA, { matricula: 'A-2', cpf: '22222222222' });
  d.trabalhadorB = await criarFuncionario(executor, d.empresaB, { matricula: 'B-1', cpf: '33333333333', gheId: d.gheB });
  d.botina = await criarMaterial(executor, d.empresaA, 'Botina de segurança');
  d.capacete = await criarMaterial(executor, d.empresaA, 'Capacete', { exigeTamanho: false });
  d.luva = await criarMaterial(executor, d.empresaA, 'Luva de raspa');
  d.botinaB = await criarMaterial(executor, d.empresaB, 'Botina B');
  return d;
}

/**
 * Solicitação PENDENTE com os itens, numa transação: contador, cabeçalho e
 * itens, na ordem que o serviço da 12B vai seguir. `itens` usa os nomes das
 * colunas; material_id é obrigatório.
 */
async function criarSolicitacao(executor, d, {
  empresaId = d.empresaA, funcionarioId = d.trabalhadorA, solicitanteId = d.solicitante, gheId = null,
  origem = 'USUARIO_INTERNO', itens, cabecalho = {},
}) {
  return transacao(executor, async (c) => {
    const numero = await proximoNumeroDaSolicitacao(c, empresaId);
    const solicitacao = await inserirSolicitacao(c, {
      empresa_id: empresaId,
      numero,
      funcionario_id: funcionarioId,
      ghe_id: gheId,
      origem_solicitacao: origem,
      solicitante_usuario_id: origem === 'USUARIO_INTERNO' ? solicitanteId : null,
      quantidade_itens: itens.length,
      ...cabecalho,
    });
    const criados = [];
    for (const item of itens) {
      criados.push(await inserirItemDaSolicitacao(c, { empresa_id: empresaId, solicitacao_id: solicitacao.id, ...item }));
    }
    return { solicitacao, itens: criados };
  });
}

const aprovar = (item, quantidadeAprovada = item.quantidade, justificativa = null) => ({
  id: item.id, decisao: 'APROVADO', quantidade_aprovada: quantidadeAprovada, justificativa_decisao: justificativa,
});
const reprovar = (item, justificativa = 'Sem necessidade comprovada') => ({
  id: item.id, decisao: 'REPROVADO', quantidade_aprovada: 0, justificativa_decisao: justificativa,
});

/**
 * Decide numa transação: itens primeiro, depois o cabeçalho. A hora da
 * decisão é a do relógio do banco, como no repositório; `decididaEm`
 * (timestamp ISO) fixa a hora para provar o desempate da fila.
 */
async function decidirSolicitacao(executor, solicitacao, { status, decididaPor, decisoes, decididaEm = null }) {
  return transacao(executor, async (c) => {
    for (const decisao of decisoes) {
      await c.query(
        `UPDATE solicitacoes_epi_itens
            SET decisao = $1, quantidade_aprovada = $2, justificativa_decisao = $3
          WHERE empresa_id = $4 AND id = $5`,
        [decisao.decisao, decisao.quantidade_aprovada, decisao.justificativa_decisao, solicitacao.empresa_id, decisao.id],
      );
    }
    const { rows } = await c.query(
      `UPDATE solicitacoes_epi
          SET status = $1, decidida_por = $2, decidida_em = COALESCE($5::timestamptz, clock_timestamp())
        WHERE empresa_id = $3 AND id = $4
        RETURNING *`,
      [status, decididaPor, solicitacao.empresa_id, solicitacao.id, decididaEm],
    );
    return rows[0];
  });
}

async function cancelarSolicitacao(executor, solicitacao, { canceladaPor, justificativa = null }) {
  const { rows } = await executor.query(
    `UPDATE solicitacoes_epi
        SET status = 'CANCELADA', cancelada_por = $1, cancelada_em = clock_timestamp(), justificativa_cancelamento = $2
      WHERE empresa_id = $3 AND id = $4
      RETURNING *`,
    [canceladaPor, justificativa, solicitacao.empresa_id, solicitacao.id],
  );
  return rows[0];
}

/** Solicitação já APROVADA (todos os itens integrais), pronta para os testes de ciclo de vida. */
async function criarSolicitacaoAprovada(executor, d, parametros) {
  const { solicitacao, itens } = await criarSolicitacao(executor, d, parametros);
  const decidida = await decidirSolicitacao(executor, solicitacao, {
    status: 'APROVADA', decididaPor: d.aprovador, decisoes: itens.map((i) => aprovar(i)),
  });
  return { solicitacao: decidida, itens };
}

/**
 * Lote de ENTRADA com a sua operação, como o serviço do estoque grava. O
 * tamanho segue a classificação do material (null quando ele não usa).
 */
async function criarLoteDeEntrada(executor, {
  empresaId, materialId, quantidade, usuarioId, tamanho = '40', caNumero = '12345', caValidade = '2099-12-31',
}) {
  return transacao(executor, async (c) => {
    const lote = await inserir(c, 'estoque_lotes', {
      empresa_id: empresaId, material_id: materialId, tamanho, ca_numero: caNumero, ca_validade: caValidade,
      origem: 'ENTRADA', quantidade_entrada: quantidade,
    });
    await inserir(c, 'estoque_operacoes', {
      empresa_id: empresaId, lote_id: lote.id, tipo: 'ENTRADA', quantidade, usuario_id: usuarioId,
      chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
    });
    return lote.id;
  });
}

/** Baixa física (avaria, perda, ajuste...) com a sua operação; o gatilho do lote soma a quantidade baixada. */
function baixarLote(executor, { empresaId, loteId, quantidade, usuarioId, motivo = 'AVARIA' }) {
  return inserir(executor, 'estoque_operacoes', {
    empresa_id: empresaId, lote_id: loteId, tipo: 'BAIXA', quantidade, motivo, usuario_id: usuarioId,
    chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
  });
}

/** Entrega DIRETA completa (ficha, entrega, item, operação e confirmação) que consome o lote. */
async function entregarDireta(executor, { empresaId, funcionarioId, usuarioId, materialId, loteId, quantidade, cnpj }) {
  const { rows } = await executor.query('SELECT id FROM fichas_epi WHERE empresa_id = $1 AND funcionario_id = $2', [empresaId, funcionarioId]);
  const ficha = rows[0] ?? await criarFicha(executor, empresaId, funcionarioId);
  return registrarEntrega(executor, {
    entrega: { empresa_id: empresaId, ficha_id: ficha.id, responsavel_id: usuarioId, empresa_cnpj: cnpj },
    itens: [{ material_id: materialId, lote_id: loteId, quantidade }],
    usuarioId,
  });
}

module.exports = {
  CNPJ_A,
  CNPJ_B,
  criarLoteDeEntrada,
  baixarLote,
  entregarDireta,
  SQL_PROXIMO_NUMERO_DA_SOLICITACAO,
  proximoNumeroDaSolicitacao,
  inserirSolicitacao,
  inserirItemDaSolicitacao,
  montarCenario,
  criarSolicitacao,
  decidirSolicitacao,
  cancelarSolicitacao,
  criarSolicitacaoAprovada,
  aprovar,
  reprovar,
  criarLote,
};
