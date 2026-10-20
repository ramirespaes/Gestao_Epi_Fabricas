'use strict';

const { escaparCoringasLike } = require('../utils/like');
const { exigirIdGrande } = require('../utils/identificador-grande');
const { lockDaBiblioteca } = require('../utils/lock-biblioteca-imagens');

/**
 * Biblioteca PRIVADA de imagens de produto de cada empresa (imagens_empresa, migration 090). Executor por parâmetro (nunca o pool global),
 * nenhuma regra de negócio e nenhuma decisão de autorização. Toda função filtra pela empresa recebida: nenhuma alcança imagem de outra empresa,
 * nem por id. Os ids são BIGINT: saem e entram como string decimal (utils/identificador-grande.js). A ÚNICA remoção do sistema de imagens é
 * `excluir`: a própria linha da biblioteca da empresa, por empresa e id; nunca a biblioteca padrão, nunca o vínculo (que mora em `materiais`),
 * nunca o arquivo físico (a limpeza do armazenamento é rotina própria, futura).
 */

const PROJECAO = `id, empresa_id, nome, sha256, sha256_mestre, sha256_exibicao, sha256_miniatura, formato, largura, altura,
  bytes_mestre, bytes_exibicao, bytes_miniatura, versao, estado, criado_por, criado_em, atualizado_em, inativada_em`;
const LIMITE_MAXIMO = 100;
const FORMATOS = Object.freeze(['PNG', 'JPEG', 'WEBP']);
const ESTADOS = Object.freeze(['ATIVA', 'INATIVA']);
const HEX64 = /^[0-9a-f]{64}$/;
const NOME_MAXIMO = 100;
const INT_MAXIMO = 2147483647;
// Mesma regra de busca sem acento dos relatórios: o termo e a coluna passam pela mesma tradução.
const ACENTUADAS = 'áàâãäéèêëíìîïóòôõöúùûüç';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuuc';
const SEM = (coluna) => `translate(lower(${coluna}), '${ACENTUADAS}', '${SEM_ACENTO}')`;

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new TypeError('identificador de empresa inválido');
}
function exigirInteiroPositivo(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0 || valor > INT_MAXIMO) throw new TypeError(`${nome} inválido`);
}
function exigirHex(valor, nome) {
  if (typeof valor !== 'string' || !HEX64.test(valor)) throw new TypeError(`${nome} inválido`);
}
function exigirNome(nome) {
  if (typeof nome !== 'string' || nome.length === 0 || Array.from(nome).length > NOME_MAXIMO) throw new TypeError('nome inválido');
}

const mapear = (l) => (l === undefined ? null : {
  id: String(l.id),
  empresaId: l.empresa_id,
  nome: l.nome,
  sha256: l.sha256,
  sha256Mestre: l.sha256_mestre,
  sha256Exibicao: l.sha256_exibicao,
  sha256Miniatura: l.sha256_miniatura,
  formato: l.formato,
  largura: l.largura,
  altura: l.altura,
  bytesMestre: l.bytes_mestre,
  bytesExibicao: l.bytes_exibicao,
  bytesMiniatura: l.bytes_miniatura,
  versao: l.versao,
  estado: l.estado,
  criadoPor: l.criado_por,
  criadoEm: l.criado_em,
  atualizadoEm: l.atualizado_em,
  inativadaEm: l.inativada_em,
});

function filtros({ busca = null, estado = null } = {}) {
  if (busca !== null && (typeof busca !== 'string' || busca.length === 0)) throw new TypeError('filtro de busca inválido');
  if (estado !== null && !ESTADOS.includes(estado)) throw new TypeError('filtro de estado inválido');
  const termo = busca === null ? null : escaparCoringasLike(busca.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
  return [estado, termo];
}

const CONDICAO = `WHERE empresa_id = $1
    AND ($2::text IS NULL OR estado = $2::text)
    AND ($3::text IS NULL OR ${SEM('nome')} LIKE '%' || $3::text || '%')`;

/** Serializa quem confere deduplicação e cota desta empresa (advisory lock transacional de 64 bits; solta no COMMIT/ROLLBACK). */
async function travarBiblioteca(executor, empresaId) {
  exigirEmpresa(empresaId);
  await executor.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDaBiblioteca(empresaId)]);
}

async function inserir(executor, {
  empresaId, nome, sha256, sha256Mestre, sha256Exibicao, sha256Miniatura, formato, largura, altura, bytesMestre, bytesExibicao, bytesMiniatura, criadoPor,
}) {
  exigirEmpresa(empresaId);
  exigirNome(nome);
  for (const [v, n] of [[sha256, 'sha256'], [sha256Mestre, 'sha256 do mestre'], [sha256Exibicao, 'sha256 da exibição'], [sha256Miniatura, 'sha256 da miniatura']]) exigirHex(v, n);
  if (!FORMATOS.includes(formato)) throw new TypeError('formato inválido');
  for (const [v, n] of [[largura, 'largura'], [altura, 'altura'], [bytesMestre, 'bytes do mestre'], [bytesExibicao, 'bytes da exibição'], [bytesMiniatura, 'bytes da miniatura'], [criadoPor, 'criador']]) exigirInteiroPositivo(v, n);
  const { rows } = await executor.query(
    `INSERT INTO imagens_empresa
       (empresa_id, nome, sha256, sha256_mestre, sha256_exibicao, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_exibicao, bytes_miniatura, criado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${PROJECAO}`,
    [empresaId, nome, sha256, sha256Mestre, sha256Exibicao, sha256Miniatura, formato, largura, altura, bytesMestre, bytesExibicao, bytesMiniatura, criadoPor],
  );
  return mapear(rows[0]);
}

/** Por conteúdo: acha também a imagem INATIVA (a unicidade da empresa inclui as inativas). */
async function buscarPorSha256(executor, empresaId, sha256) {
  exigirEmpresa(empresaId);
  exigirHex(sha256, 'sha256');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM imagens_empresa WHERE empresa_id = $1 AND sha256 = $2`, [empresaId, sha256]);
  return mapear(rows[0]);
}

async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM imagens_empresa WHERE empresa_id = $1 AND id = $2`, [empresaId, exigirIdGrande(id, 'identificador de imagem')]);
  return mapear(rows[0]);
}

/**
 * FOR SHARE (dentro de transação): quem vai ASSOCIAR a imagem a um material precisa que ela continue ATIVA até o COMMIT. Associações
 * concorrentes coexistem (share com share); a inativação concorrente (FOR UPDATE) espera.
 */
async function buscarPorIdParaAssociacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM imagens_empresa WHERE empresa_id = $1 AND id = $2 FOR SHARE`, [empresaId, exigirIdGrande(id, 'identificador de imagem')]);
  return mapear(rows[0]);
}

/** FOR UPDATE: quem vai mudar o estado ou o nome. Espera as associações em andamento; a associação que chega depois espera esta. */
async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM imagens_empresa WHERE empresa_id = $1 AND id = $2 FOR UPDATE`, [empresaId, exigirIdGrande(id, 'identificador de imagem')]);
  return mapear(rows[0]);
}

/** Ordem estável por nome e id. `deslocamento` (opcional) substitui `pagina` e serve à paginação conjunta com a biblioteca padrão. */
async function listar(executor, empresaId, { pagina = 1, limite = 20, deslocamento = null, ...f } = {}) {
  exigirEmpresa(empresaId);
  if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('página inválida');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  if (deslocamento !== null && (!Number.isInteger(deslocamento) || deslocamento < 0)) throw new TypeError('deslocamento inválido');
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM imagens_empresa ${CONDICAO} ORDER BY lower(nome), id LIMIT $4 OFFSET $5`,
    [empresaId, ...filtros(f), limite, deslocamento === null ? (pagina - 1) * limite : deslocamento],
  );
  return rows.map(mapear);
}

async function contar(executor, empresaId, f = {}) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(`SELECT count(*)::int AS total FROM imagens_empresa ${CONDICAO}`, [empresaId, ...filtros(f)]);
  return rows[0].total;
}

async function atualizarNome(executor, empresaId, id, nome) {
  exigirEmpresa(empresaId);
  exigirNome(nome);
  const { rows } = await executor.query(
    `UPDATE imagens_empresa SET nome = $3 WHERE empresa_id = $1 AND id = $2 RETURNING ${PROJECAO}`,
    [empresaId, exigirIdGrande(id, 'identificador de imagem'), nome],
  );
  return mapear(rows[0]);
}

/** ATIVA ou INATIVA; `inativada_em` acompanha o estado. A regra "em uso" é do serviço (o banco permite inativar imagem referenciada). */
async function atualizarEstado(executor, empresaId, id, estado) {
  exigirEmpresa(empresaId);
  if (!ESTADOS.includes(estado)) throw new TypeError('estado inválido');
  const { rows } = await executor.query(
    `UPDATE imagens_empresa
        SET estado = $3::varchar, inativada_em = CASE WHEN $3::varchar = 'INATIVA' THEN now() ELSE NULL END
      WHERE empresa_id = $1 AND id = $2
      RETURNING ${PROJECAO}`,
    [empresaId, exigirIdGrande(id, 'identificador de imagem'), estado],
  );
  return mapear(rows[0]);
}

/**
 * Apaga a linha da imagem da empresa (por empresa E id) e devolve o que foi apagado, ou null se não existia nesta empresa. É para ser chamada
 * dentro da transação que já travou a linha (buscarPorIdParaAtualizacao) e conferiu o uso: entre a conferência e este comando nenhuma
 * associação nova pode entrar, porque associar toma FOR SHARE na mesma linha. A FK RESTRICT de `materiais` (090) é a última barreira.
 */
async function excluir(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `DELETE FROM imagens_empresa WHERE empresa_id = $1 AND id = $2 RETURNING ${PROJECAO}`,
    [empresaId, exigirIdGrande(id, 'identificador de imagem')],
  );
  return mapear(rows[0]);
}

/** Quantos materiais (de qualquer situação) referenciam a imagem. */
async function contarUso(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    'SELECT count(*)::int AS n FROM materiais WHERE empresa_id = $1 AND imagem_empresa_id = $2',
    [empresaId, exigirIdGrande(id, 'identificador de imagem')],
  );
  return rows[0].n;
}

/**
 * Consumo da cota: imagens (ativas e inativas) e bytes. `bytes` é a soma dos MESTRES (o contrato documentado da cota, docs. 04 e 13);
 * `bytesArmazenados` soma também as derivadas, só para transparência. Cada conteúdo é uma linha (UNIQUE por empresa e SHA-256): a
 * deduplicação nunca conta duas vezes.
 */
async function somarConsumo(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `SELECT count(*)::int AS imagens,
            COALESCE(sum(bytes_mestre), 0)::bigint AS bytes,
            COALESCE(sum(bytes_mestre + bytes_exibicao + bytes_miniatura), 0)::bigint AS bytes_armazenados
       FROM imagens_empresa WHERE empresa_id = $1`,
    [empresaId],
  );
  const r = rows[0];
  return { imagens: Number(r.imagens), bytes: Number(r.bytes), bytesArmazenados: Number(r.bytes_armazenados ?? r.bytes) };
}

module.exports = {
  LIMITE_MAXIMO, FORMATOS, ESTADOS, travarBiblioteca, inserir, buscarPorSha256, buscarPorId, buscarPorIdParaAssociacao,
  buscarPorIdParaAtualizacao, listar, contar, atualizarNome, atualizarEstado, contarUso, somarConsumo, excluir,
};
