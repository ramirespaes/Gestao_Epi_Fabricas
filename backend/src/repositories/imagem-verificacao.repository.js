'use strict';

/**
 * Consultas SOMENTE LEITURA do verificador de integridade das imagens (Biblioteca de Imagens, Unidade 5C-5). Executor por parâmetro (nunca o pool global), nenhuma
 * regra de negócio e nenhuma escrita: só SELECT, pensado para rodar dentro de uma transação READ ONLY. Os registros saem como o banco os guarda, sem validar: quem
 * julga um registro inconsistente é o serviço. Os ids BIGINT saem como string decimal. A leitura das tabelas é paginada por chave (`id > depoisDe`), sem OFFSET.
 */

const LIMITE_MAXIMO = 1000;
const ID_DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/;

function exigirPagina({ depoisDe, limite }) {
  if (typeof depoisDe !== 'string' || !ID_DECIMAL.test(depoisDe)) throw new TypeError('cursor de página inválido');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite de página inválido');
}

const orNull = (valor) => valor ?? null;

/** Biblioteca padrão (global). `exibicao` é opcional: hash e tamanho nulos significam "não gerada". */
async function listarPadrao(executor, { depoisDe = '0', limite = 500 } = {}) {
  exigirPagina({ depoisDe, limite });
  const { rows } = await executor.query(
    `SELECT id, sha256, sha256_miniatura, sha256_exibicao, formato, bytes_mestre, bytes_miniatura, bytes_exibicao
       FROM imagens_padrao
      WHERE id > $1::bigint
      ORDER BY id
      LIMIT $2`,
    [depoisDe, limite],
  );
  return rows.map((l) => ({
    id: String(l.id),
    sha256: l.sha256,
    sha256Miniatura: l.sha256_miniatura,
    sha256Exibicao: orNull(l.sha256_exibicao),
    formato: l.formato,
    bytesMestre: l.bytes_mestre,
    bytesMiniatura: l.bytes_miniatura,
    bytesExibicao: orNull(l.bytes_exibicao),
  }));
}

/** Bibliotecas privadas de TODAS as empresas (ativas e inativas: a imagem inativa continua precisando dos arquivos). */
async function listarEmpresa(executor, { depoisDe = '0', limite = 500 } = {}) {
  exigirPagina({ depoisDe, limite });
  const { rows } = await executor.query(
    `SELECT id, empresa_id, sha256, sha256_mestre, sha256_exibicao, sha256_miniatura, formato, bytes_mestre, bytes_exibicao, bytes_miniatura
       FROM imagens_empresa
      WHERE id > $1::bigint
      ORDER BY id
      LIMIT $2`,
    [depoisDe, limite],
  );
  return rows.map((l) => ({
    id: String(l.id),
    empresaId: l.empresa_id,
    sha256: l.sha256,
    sha256Mestre: l.sha256_mestre,
    sha256Exibicao: l.sha256_exibicao,
    sha256Miniatura: l.sha256_miniatura,
    formato: l.formato,
    bytesMestre: l.bytes_mestre,
    bytesExibicao: l.bytes_exibicao,
    bytesMiniatura: l.bytes_miniatura,
  }));
}

/** Identificadores das empresas existentes: uma pasta de empresa que não está aqui não é sobra comum. */
async function listarIdsDeEmpresas(executor) {
  const { rows } = await executor.query('SELECT id FROM empresas ORDER BY id');
  return rows.map((l) => l.id);
}

/** Quantos materiais usam cada imagem padrão (qualquer material, ativo ou não). */
async function contarUsoPadrao(executor) {
  const { rows } = await executor.query(
    `SELECT imagem_padrao_id AS imagem_id, count(*)::int AS materiais
       FROM materiais
      WHERE imagem_padrao_id IS NOT NULL
      GROUP BY imagem_padrao_id`,
  );
  return rows.map((l) => ({ imagemId: String(l.imagem_id), materiais: l.materiais }));
}

/** Quantos materiais usam cada imagem de empresa (a chave é o par empresa + imagem). */
async function contarUsoEmpresa(executor) {
  const { rows } = await executor.query(
    `SELECT empresa_id, imagem_empresa_id AS imagem_id, count(*)::int AS materiais
       FROM materiais
      WHERE imagem_empresa_id IS NOT NULL
      GROUP BY empresa_id, imagem_empresa_id`,
  );
  return rows.map((l) => ({ empresaId: l.empresa_id, imagemId: String(l.imagem_id), materiais: l.materiais }));
}

/** Banco e OID que o PRÓPRIO PostgreSQL informa para a conexão (o ambiente não comprova o destino). */
async function identificarBanco(executor) {
  const { rows } = await executor.query(
    'SELECT current_database() AS nome, (SELECT oid::text FROM pg_database WHERE datname = current_database()) AS oid',
  );
  return { nome: rows[0].nome, oid: rows[0].oid };
}

module.exports = {
  listarPadrao, listarEmpresa, listarIdsDeEmpresas, contarUsoPadrao, contarUsoEmpresa, identificarBanco,
};
