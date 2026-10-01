'use strict';

const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');

/**
 * Base dos dois repositórios de pedidos de redefinição de senha:
 * redefinicoes_senha (061, identidades) e redefinicoes_senha_plataforma
 * (062, administradores). As tabelas têm o mesmo desenho; cada repositório
 * informa a própria tabela e a coluna da conta, sempre por constante do
 * módulo, nunca por entrada externa.
 *
 * Só o SHA-256 do token chega aqui. A validade e a situação do pedido são
 * decididas no SQL, pelo relógio do banco, e criado_em é sempre o do banco.
 * O executor chega por parâmetro; o pool nunca é importado.
 */

const FORMATO_HASH = /^[0-9a-f]{64}$/;
const FORMATO_MOTIVO = /^[A-Z_]{1,30}$/;
// BIGINT IDENTITY: o driver devolve string decimal, nunca convertida para Number.
const FORMATO_ID_PEDIDO = /^[1-9][0-9]*$/;
// Defesa em profundidade: o banco recusa de qualquer forma validade acima de 4 horas.
const VALIDADE_MAXIMA_MINUTOS = 240;
const MOTIVO_SUBSTITUIDA = 'SUBSTITUIDA';

const SITUACAO = Object.freeze({ PENDENTE: 'PENDENTE', USADA: 'USADA', CANCELADA: 'CANCELADA', EXPIRADA: 'EXPIRADA' });

function exigirHash(tokenHash) {
  if (typeof tokenHash !== 'string' || !FORMATO_HASH.test(tokenHash)) {
    throw new TypeError('token deve chegar como hash SHA-256 hexadecimal minúsculo');
  }
}

function exigirMotivo(motivo) {
  if (typeof motivo !== 'string' || !FORMATO_MOTIVO.test(motivo)) {
    throw new TypeError('motivo de cancelamento inválido');
  }
}

function exigirPedido(id) {
  if (typeof id !== 'string' || !FORMATO_ID_PEDIDO.test(id)) {
    throw new TypeError('identificador de pedido de redefinição inválido');
  }
}

function exigirValidade(minutos) {
  if (!Number.isInteger(minutos) || minutos < 1 || minutos > VALIDADE_MAXIMA_MINUTOS) {
    throw new TypeError('validade do pedido de redefinição inválida');
  }
}

function situacaoDe(linha) {
  if (linha.usado_em !== null) return SITUACAO.USADA;
  if (linha.cancelado_em !== null) return SITUACAO.CANCELADA;
  if (linha.vigente !== true) return SITUACAO.EXPIRADA;
  return SITUACAO.PENDENTE;
}

function criarRepositorioDeRedefinicao({ tabela, colunaConta, campoConta, rotuloConta }) {
  function exigirConta(contaId) {
    if (!Number.isInteger(contaId) || contaId <= 0) {
      throw new TypeError(`identificador de ${rotuloConta} inválido`);
    }
  }

  const mapear = (linha) => (linha === undefined ? null : {
    id: linha.id,
    [campoConta]: linha[colunaConta],
    criadoEm: linha.criado_em,
    expiraEm: linha.expira_em,
    usadoEm: linha.usado_em,
    canceladoEm: linha.cancelado_em,
    motivoCancelamento: linha.motivo_cancelamento,
    situacao: situacaoDe(linha),
  });

  const SELECAO = `SELECT id, ${colunaConta}, criado_em, expira_em, usado_em, cancelado_em, motivo_cancelamento,
            (expira_em > clock_timestamp()) AS vigente
       FROM ${tabela}
      WHERE token_hash = $1`;

  async function cancelarPendentes(executor, contaId, motivo) {
    exigirConta(contaId);
    exigirMotivo(motivo);

    // clock_timestamp(): o pedido pode ter sido criado por outra transação
    // depois do início desta, e cancelado_em nunca pode ficar antes de criado_em.
    const { rowCount } = await executor.query(
      `UPDATE ${tabela}
          SET cancelado_em = clock_timestamp(), motivo_cancelamento = $2
        WHERE ${colunaConta} = $1 AND usado_em IS NULL AND cancelado_em IS NULL`,
      [contaId, motivo],
    );
    return rowCount;
  }

  /**
   * Cancela o pedido pendente da conta e grava o novo, que passa a ser o
   * único pendente. Quem chama garante a transação e a serialização das
   * solicitações simultâneas da mesma conta.
   *
   * @returns {Promise<{id: string, criadoEm: Date, expiraEm: Date, substituidos: number}>}
   */
  async function criar(executor, dados) {
    const { tokenHash, validadeMinutos, ip = null, dispositivo = null } = dados;
    const contaId = dados[campoConta];
    exigirConta(contaId);
    exigirHash(tokenHash);
    exigirValidade(validadeMinutos);
    const ipGravado = ipParaGravar(ip);
    const dispositivoGravado = dispositivoParaGravar(dispositivo);

    const substituidos = await cancelarPendentes(executor, contaId, MOTIVO_SUBSTITUIDA);
    const { rows } = await executor.query(
      `INSERT INTO ${tabela} (${colunaConta}, token_hash, expira_em, ip, dispositivo)
       VALUES ($1, $2, now() + ($3 * INTERVAL '1 minute'), $4, $5)
       RETURNING id, criado_em, expira_em`,
      [contaId, tokenHash, validadeMinutos, ipGravado, dispositivoGravado],
    );
    return { id: rows[0].id, criadoEm: rows[0].criado_em, expiraEm: rows[0].expira_em, substituidos };
  }

  async function buscarPorHash(executor, tokenHash) {
    exigirHash(tokenHash);
    const { rows } = await executor.query(SELECAO, [tokenHash]);
    return mapear(rows[0]);
  }

  /** Mesma leitura, travando a linha do pedido até o fim da transação. */
  async function buscarPorHashParaAtualizacao(executor, tokenHash) {
    exigirHash(tokenHash);
    const { rows } = await executor.query(`${SELECAO}\n        FOR UPDATE`, [tokenHash]);
    return mapear(rows[0]);
  }

  /**
   * Consome o pedido, só se ainda estiver pendente e dentro da validade.
   * Devolve true quando este consumo venceu; false para pedido usado,
   * cancelado, expirado ou inexistente.
   */
  async function marcarUsada(executor, id) {
    exigirPedido(id);
    const { rowCount } = await executor.query(
      `UPDATE ${tabela}
          SET usado_em = clock_timestamp()
        WHERE id = $1 AND usado_em IS NULL AND cancelado_em IS NULL AND expira_em > clock_timestamp()`,
      [id],
    );
    return rowCount === 1;
  }

  return { SITUACAO, criar, buscarPorHash, buscarPorHashParaAtualizacao, marcarUsada, cancelarPendentes };
}

module.exports = { criarRepositorioDeRedefinicao };
