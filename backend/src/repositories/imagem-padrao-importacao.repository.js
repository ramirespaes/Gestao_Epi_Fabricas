'use strict';

const { lockDaImportacaoPadrao } = require('../utils/lock-importacao-padrao');

/**
 * Caminho de ESCRITA da biblioteca padrão (imagens_padrao e imagens_padrao_tipos), usado só pela importação offline. O repositório de leitura
 * (imagem-padrao.repository.js) continua sem nenhuma escrita por desenho. Todo método recebe o executor (cliente da transação da importação);
 * ids BIGINT saem como texto decimal.
 */

const COLUNAS = 'id::text AS id, nome, sha256, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_miniatura';

const mapear = (l) => ({
  id: l.id,
  nome: l.nome,
  sha256: l.sha256,
  sha256Miniatura: l.sha256_miniatura,
  formato: l.formato,
  largura: l.largura,
  altura: l.altura,
  bytesMestre: l.bytes_mestre,
  bytesMiniatura: l.bytes_miniatura,
});

/** Serializa as importações: advisory lock de transação, liberado no COMMIT ou no ROLLBACK. */
async function travarImportacao(executor) {
  await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaImportacaoPadrao()]);
}

/** Identidade da sessão que vai escrever: nome do banco e OID em pg_database (catálogo legível por qualquer papel; pg_catalog explícito, fora do caminho de busca). */
async function lerIdentidade(executor) {
  const { rows } = await executor.query(
    'SELECT pg_catalog.current_database() AS banco, d.oid::text AS oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()',
  );
  return rows.length === 1 ? { banco: rows[0].banco, oid: rows[0].oid } : null;
}

async function buscarPorHashes(executor, hashes) {
  const { rows } = await executor.query(`SELECT ${COLUNAS} FROM imagens_padrao WHERE sha256 = ANY($1::text[])`, [hashes]);
  return rows.map(mapear);
}

async function buscarPorNomes(executor, nomes) {
  if (nomes.length === 0) return [];
  const { rows } = await executor.query(`SELECT ${COLUNAS} FROM imagens_padrao WHERE nome = ANY($1::text[])`, [nomes]);
  return rows.map(mapear);
}

/** Uma imagem NOVA: PNG padronizado 1024x1024 como mestre, miniatura e referência (só o hash) do original. A exibição de 640 px fica nula. */
async function inserirImagem(executor, dados) {
  const { rows } = await executor.query(
    `INSERT INTO imagens_padrao
       (nome, arquivo_origem, sha256, sha256_miniatura, sha256_original_ref, pacote_origem, pacote_sha256, formato, largura, altura, bytes_mestre, bytes_miniatura)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PNG', 1024, 1024, $8, $9)
     RETURNING id::text AS id`,
    [dados.nome, dados.arquivoOrigem, dados.sha256, dados.sha256Miniatura, dados.sha256OriginalRef, dados.pacoteOrigem, dados.pacoteSha256, dados.bytesMestre, dados.bytesMiniatura],
  );
  return rows[0].id;
}

/** Uma sugestão APROVADA de tipo (por nome) para uma imagem recém-criada; só destaca, nunca vincula. */
async function inserirSugestao(executor, dados) {
  await executor.query(
    'INSERT INTO imagens_padrao_tipos (imagem_padrao_id, tipo_nome, nivel, aprovado_por, aprovado_em) VALUES ($1::bigint, $2, $3, $4, $5::date)',
    [dados.imagemId, dados.tipoNome, dados.nivel, dados.aprovadoPor, dados.aprovadoEm],
  );
}

module.exports = { travarImportacao, lerIdentidade, buscarPorHashes, buscarPorNomes, inserirImagem, inserirSugestao };
