'use strict';

/**
 * Leitura dos metadados dos pacotes de fiscalização para o VERIFICADOR da fonte `fiscalizacao-pacotes` (D-ORF-6, P3). Nenhuma regra de negócio e
 * nenhuma escrita: só SELECT, pensado para rodar dentro de uma transação READ ONLY. As linhas saem como o banco as guarda, sem validar: quem lê decide
 * o que é inconsistente. Paginação por id crescente, para a fotografia ser completa sem carregar tudo de uma vez.
 */

const LIMITE_MAXIMO = 5000;

function exigirPagina({ depoisDe, limite }) {
  if (typeof depoisDe !== 'string' || !/^\d{1,18}$/.test(depoisDe)) throw new TypeError('cursor de paginação inválido');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite de paginação inválido');
}

/** Todas as tentativas (qualquer status): o verificador precisa saber o que é CONCLUIDO (arquivo esperado), GERANDO (temporário tolerado) e FALHA (nada esperado). */
async function listarPacotes(executor, { depoisDe = '0', limite = 500 } = {}) {
  exigirPagina({ depoisDe, limite });
  const { rows } = await executor.query(
    `SELECT id, empresa_id, status, tamanho_bytes, sha256, chave_armazenamento, heartbeat_em
       FROM fiscalizacao_pacotes
      WHERE id > $1::bigint
      ORDER BY id
      LIMIT $2`,
    [depoisDe, limite],
  );
  return rows.map((r) => ({
    id: String(r.id),
    empresaId: String(r.empresa_id),
    status: r.status,
    tamanhoBytes: r.tamanho_bytes === null || r.tamanho_bytes === undefined ? null : Number(r.tamanho_bytes),
    sha256: r.sha256 ?? null,
    chaveArmazenamento: r.chave_armazenamento ?? null,
    heartbeatEm: r.heartbeat_em instanceof Date ? r.heartbeat_em.getTime() : (r.heartbeat_em === null || r.heartbeat_em === undefined ? null : Number(new Date(r.heartbeat_em))),
  }));
}

async function listarIdsDeEmpresas(executor) {
  const { rows } = await executor.query('SELECT id FROM empresas ORDER BY id');
  return rows.map((r) => String(r.id));
}

module.exports = { listarPacotes, listarIdsDeEmpresas, LIMITE_MAXIMO };
