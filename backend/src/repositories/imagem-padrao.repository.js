'use strict';

const { escaparCoringasLike } = require('../utils/like');
const { exigirIdGrande } = require('../utils/identificador-grande');

/**
 * Biblioteca PADRÃO SafeWork (imagens_padrao, migration 090): global, compartilhada por todas as empresas e SOMENTE LEITURA para a aplicação.
 * Por desenho este módulo não tem nenhuma função de escrita: quem administra a biblioteca padrão é o operador da plataforma, por rotina
 * própria, nunca por API de empresa. As sugestões de tipo (imagens_padrao_tipos) só DESTACAM a imagem: ligam-se por NOME de tipo, nunca por
 * id, e nunca criam vínculo com material. Ids BIGINT saem como string decimal.
 */

const LIMITE_MAXIMO = 100;
const ACENTUADAS = 'áàâãäéèêëíìîïóòôõöúùûüç';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuuc';
const SEM = (coluna) => `translate(lower(${coluna}), '${ACENTUADAS}', '${SEM_ACENTO}')`;

const mapear = (l) => (l === undefined ? null : {
  id: String(l.id),
  nome: l.nome,
  sha256: l.sha256,
  sha256Miniatura: l.sha256_miniatura,
  sha256Exibicao: l.sha256_exibicao ?? null,
  formato: l.formato,
  largura: l.largura,
  altura: l.altura,
  versao: l.versao,
  ativo: l.ativo,
  ilustrativa: l.ilustrativa,
  sugerida: l.sugerida ?? null,
});

function termoDeBusca(busca) {
  if (busca === null || busca === undefined) return null;
  if (typeof busca !== 'string' || busca.length === 0) throw new TypeError('filtro de busca inválido');
  return escaparCoringasLike(busca.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

const PROJECAO = `p.id, p.nome, p.sha256, p.sha256_miniatura, p.sha256_exibicao, p.formato, p.largura, p.altura, p.versao, p.ativo, p.ilustrativa`;

/**
 * Só as ATIVAS. Com `tipoNome`, a sugestão aprovada (PRINCIPAL ou ALTERNATIVA) vem em `sugerida` e as sugeridas saem primeiro; sem ele
 * nada é destacado. Ordem estável por nome e id. `deslocamento` (opcional) substitui `pagina`.
 */
async function listar(executor, { busca = null, tipoNome = null, pagina = 1, limite = 20, deslocamento = null } = {}) {
  if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('página inválida');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  if (deslocamento !== null && (!Number.isInteger(deslocamento) || deslocamento < 0)) throw new TypeError('deslocamento inválido');
  if (tipoNome !== null && (typeof tipoNome !== 'string' || tipoNome.length === 0)) throw new TypeError('tipo inválido');
  const { rows } = await executor.query(
    `SELECT ${PROJECAO}, t.nivel AS sugerida
       FROM imagens_padrao p
       LEFT JOIN imagens_padrao_tipos t ON t.imagem_padrao_id = p.id AND t.tipo_nome = $2::text
      WHERE p.ativo AND ($1::text IS NULL OR ${SEM('p.nome')} LIKE '%' || $1::text || '%')
      ORDER BY CASE t.nivel WHEN 'PRINCIPAL' THEN 0 WHEN 'ALTERNATIVA' THEN 1 ELSE 2 END, lower(p.nome), p.id
      LIMIT $3 OFFSET $4`,
    [termoDeBusca(busca), tipoNome, limite, deslocamento === null ? (pagina - 1) * limite : deslocamento],
  );
  return rows.map(mapear);
}

async function contar(executor, { busca = null } = {}) {
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total FROM imagens_padrao p WHERE p.ativo AND ($1::text IS NULL OR ${SEM('p.nome')} LIKE '%' || $1::text || '%')`,
    [termoDeBusca(busca)],
  );
  return rows[0].total;
}

async function buscarPorId(executor, id) {
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM imagens_padrao p WHERE p.id = $1`, [exigirIdGrande(id, 'identificador de imagem')]);
  return mapear(rows[0]);
}

/** FOR SHARE (dentro de transação): a imagem padrão precisa continuar ATIVA até o COMMIT de quem a associa a um material. */
async function buscarPorIdParaAssociacao(executor, id) {
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM imagens_padrao p WHERE p.id = $1 FOR SHARE`, [exigirIdGrande(id, 'identificador de imagem')]);
  return mapear(rows[0]);
}

module.exports = { LIMITE_MAXIMO, listar, contar, buscarPorId, buscarPorIdParaAssociacao };
