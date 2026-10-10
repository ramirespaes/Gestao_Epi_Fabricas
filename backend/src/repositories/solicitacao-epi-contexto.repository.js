'use strict';

const { escaparCoringasLike } = require('../utils/like');
const sqlPrevisto = require('./sql/previsto-ghe');

/**
 * Materiais para quem pede escolher na nova solicitação de EPI (12G-0, L2):
 * os ativos, com a marca "previsto no GHE" do trabalhador e as sugestões de
 * tamanho: a grade do material (12G-8) ou, no legado sem grade, os tamanhos
 * dos lotes que já existiram para o material. O ainda não
 * classificado quanto ao tamanho (exige_tamanho nulo, como a 044 deixou os
 * antigos) também vem, para a tela explicar por que não pode ser pedido: a
 * criação continua recusando. Nenhum número de estoque: a sugestão não depende
 * de saldo (lote zerado continua sugerindo o tamanho) e nunca leva quantidade.
 * Só leitura, sempre por empresa.
 */

const LIMITE_MAXIMO = 100;

// Regra única de "previsto no GHE" (vínculo direto OU por tipo): sql/previsto-ghe.js. $2 = GHE do trabalhador.
const PREVISTO = sqlPrevisto.previstoNoGhe({ material: 'm', ghe: '$2' });

const FILTRO = `FROM materiais m
  WHERE m.empresa_id = $1 AND m.ativo
    AND ($3::text IS NULL OR m.nome ILIKE '%' || $3::text || '%' OR m.codigo_interno ILIKE '%' || $3::text || '%')
    AND ($4::boolean IS NULL OR ${PREVISTO} = $4::boolean)`;

// 12G-8: material com grade sugere a grade, na ordem dela (inclusive tamanho sem
// estoque); o legado sem grade continua sugerindo os tamanhos dos lotes.
const TAMANHOS = `CASE WHEN EXISTS (SELECT 1 FROM material_tamanhos mt WHERE mt.empresa_id = m.empresa_id AND mt.material_id = m.id)
    THEN ARRAY(SELECT mt.tamanho FROM material_tamanhos mt WHERE mt.empresa_id = m.empresa_id AND mt.material_id = m.id ORDER BY mt.ordem)
    ELSE ARRAY(SELECT DISTINCT l.tamanho FROM estoque_lotes l
      WHERE l.empresa_id = m.empresa_id AND l.material_id = m.id AND l.tamanho IS NOT NULL ORDER BY l.tamanho)
  END`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function filtros(empresaId, { gheId = null, busca = null, previstoNoGhe = null } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  if (gheId !== null) exigirId(gheId, 'identificador de GHE');
  if (busca !== null && (typeof busca !== 'string' || busca.length === 0)) throw new TypeError('busca inválida');
  if (previstoNoGhe !== null && typeof previstoNoGhe !== 'boolean') throw new TypeError('previstoNoGhe inválido');
  return [empresaId, gheId, busca === null ? null : escaparCoringasLike(busca), previstoNoGhe];
}

/** Os previstos no GHE primeiro, depois o nome; o id desempata. */
async function listarMateriais(executor, empresaId, { pagina, limite, ...resto }) {
  const parametros = filtros(empresaId, resto);
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT m.id, m.nome, m.unidade, m.exige_tamanho, ${PREVISTO} AS previsto_no_ghe, ${TAMANHOS} AS tamanhos
       ${FILTRO}
      ORDER BY previsto_no_ghe DESC, lower(m.nome), m.id
      LIMIT $5 OFFSET $6`,
    [...parametros, limite, (pagina - 1) * limite],
  );
  return rows.map((m) => ({
    id: m.id, nome: m.nome, unidade: m.unidade, exigeTamanho: m.exige_tamanho, previstoNoGhe: m.previsto_no_ghe, tamanhosSugeridos: m.tamanhos,
  }));
}

async function contarMateriais(executor, empresaId, resto) {
  const { rows } = await executor.query(`SELECT count(*)::int AS total ${FILTRO}`, filtros(empresaId, resto));
  return rows[0].total;
}

module.exports = { LIMITE_MAXIMO, listarMateriais, contarMateriais };
