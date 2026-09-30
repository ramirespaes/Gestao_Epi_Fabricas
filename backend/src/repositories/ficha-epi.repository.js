'use strict';

const { escaparCoringasLike } = require('../utils/like');

/**
 * Fichas de EPI (fichas_epi, migration 058): uma por trabalhador na empresa,
 * criada na primeira entrega. Só INSERT e leitura; a ficha não muda nem
 * some. Toda consulta filtra pela empresa.
 *
 * As leituras da ficha (10F) juntam o cadastro ATUAL do trabalhador e um
 * resumo das entregas; os filtros por material, código e período olham o
 * histórico (snapshots dos itens e data operacional das entregas) com
 * EXISTS, para nunca multiplicar a ficha.
 */

const PROJECAO = 'id, empresa_id, numero, funcionario_id, criada_em';
const DATA_FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const LIMITE_MAXIMO = 100;

const RESUMO = `LATERAL (
    SELECT count(DISTINCT e.id)::int AS total_entregas, count(i.id)::int AS total_itens, max(e.entregue_em) AS ultima_entrega_em
      FROM entregas_epi e
      LEFT JOIN entregas_epi_itens i ON i.empresa_id = e.empresa_id AND i.entrega_id = e.id
     WHERE e.empresa_id = f.empresa_id AND e.ficha_id = f.id
  ) r`;

const ORIGEM_LISTA = `FROM fichas_epi f
  JOIN funcionarios fu ON fu.empresa_id = f.empresa_id AND fu.id = f.funcionario_id`;

// busca: nome e matrícula atuais, nome e matrícula históricos da entrega,
// nome e código interno históricos do material. ativo: situação ATUAL do
// trabalhador, não snapshot. de/ate: data operacional das entregas.
const FILTRO_LISTA = `WHERE f.empresa_id = $1
    AND ($2::text IS NULL
         OR fu.nome ILIKE '%' || $2::text || '%' OR fu.matricula ILIKE '%' || $2::text || '%'
         OR EXISTS (SELECT 1 FROM entregas_epi e
                     WHERE e.empresa_id = f.empresa_id AND e.ficha_id = f.id
                       AND (e.trabalhador_nome ILIKE '%' || $2::text || '%' OR e.trabalhador_matricula ILIKE '%' || $2::text || '%'))
         OR EXISTS (SELECT 1 FROM entregas_epi e JOIN entregas_epi_itens i ON i.empresa_id = e.empresa_id AND i.entrega_id = e.id
                     WHERE e.empresa_id = f.empresa_id AND e.ficha_id = f.id
                       AND (i.material_nome ILIKE '%' || $2::text || '%' OR i.material_codigo_interno ILIKE '%' || $2::text || '%')))
    AND ($3::int IS NULL OR f.numero = $3::int)
    AND ($4::int IS NULL OR f.funcionario_id = $4::int)
    AND ($5::int IS NULL OR EXISTS (SELECT 1 FROM entregas_epi e JOIN entregas_epi_itens i ON i.empresa_id = e.empresa_id AND i.entrega_id = e.id
                                     WHERE e.empresa_id = f.empresa_id AND e.ficha_id = f.id AND i.material_id = $5::int))
    AND ($6::boolean IS NULL OR fu.ativo = $6::boolean)
    AND (($7::date IS NULL AND $8::date IS NULL)
         OR EXISTS (SELECT 1 FROM entregas_epi e
                     WHERE e.empresa_id = f.empresa_id AND e.ficha_id = f.id
                       AND ($7::date IS NULL OR e.data_operacional >= $7::date)
                       AND ($8::date IS NULL OR e.data_operacional <= $8::date)))`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirIdOpcional(valor, nome) {
  if (valor !== null) exigirId(valor, nome);
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  numero: linha.numero,
  funcionarioId: linha.funcionario_id,
  criadaEm: linha.criada_em,
});

const mapearResumo = (l) => ({
  totalEntregas: l.total_entregas,
  totalItens: l.total_itens,
  ultimaEntregaEm: l.ultima_entrega_em,
});

const mapearLinhaDaLista = (l) => ({
  ficha: { id: l.id, empresaId: l.empresa_id, numero: l.numero, funcionarioId: l.funcionario_id, criadaEm: l.criada_em },
  funcionarioAtual: {
    id: l.funcionario_id, nome: l.nome, matricula: l.matricula, cpf: l.cpf, setor: l.setor, funcao: l.funcao, ativo: l.ativo,
  },
  resumo: mapearResumo(l),
});

function filtrosDaLista({
  busca = null, numero = null, funcionarioId = null, materialId = null, ativo = null, de = null, ate = null,
} = {}) {
  if (busca !== null && (typeof busca !== 'string' || busca.length === 0)) throw new TypeError('busca inválida');
  exigirIdOpcional(numero, 'número da ficha');
  exigirIdOpcional(funcionarioId, 'identificador de funcionário');
  exigirIdOpcional(materialId, 'identificador de material');
  if (ativo !== null && typeof ativo !== 'boolean') throw new TypeError('ativo inválido');
  for (const data of [de, ate]) {
    if (data !== null && (typeof data !== 'string' || !DATA_FORMATO.test(data))) throw new TypeError('período inválido');
  }
  return [busca === null ? null : escaparCoringasLike(busca), numero, funcionarioId, materialId, ativo, de, ate];
}

async function buscarPorId(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de ficha');
  const { rows } = await executor.query(`SELECT ${PROJECAO} FROM fichas_epi WHERE empresa_id = $1 AND id = $2`, [empresaId, id]);
  return mapear(rows[0]);
}

async function buscarPorFuncionario(executor, empresaId, funcionarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM fichas_epi WHERE empresa_id = $1 AND funcionario_id = $2`,
    [empresaId, funcionarioId],
  );
  return mapear(rows[0]);
}

/** Cria a ficha com o número já reservado em fichas_epi_numeracao, na mesma transação. */
async function criar(executor, { empresaId, funcionarioId, numero }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  exigirId(numero, 'número da ficha');
  const { rows } = await executor.query(
    `INSERT INTO fichas_epi (empresa_id, numero, funcionario_id) VALUES ($1, $2, $3) RETURNING ${PROJECAO}`,
    [empresaId, numero, funcionarioId],
  );
  return mapear(rows[0]);
}

/** Total de entregas, total de itens e instante da última entrega da ficha. */
async function resumo(executor, empresaId, fichaId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(fichaId, 'identificador de ficha');
  const { rows } = await executor.query(
    `SELECT r.total_entregas, r.total_itens, r.ultima_entrega_em FROM fichas_epi f, ${RESUMO} WHERE f.empresa_id = $1 AND f.id = $2`,
    [empresaId, fichaId],
  );
  return rows[0] ? mapearResumo(rows[0]) : null;
}

/** Uma página de fichas da empresa com o trabalhador atual e o resumo; última entrega primeiro, número como desempate. */
async function listar(executor, empresaId, { pagina, limite, ...filtros }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT f.id, f.empresa_id, f.numero, f.funcionario_id, f.criada_em,
            fu.nome, fu.matricula, fu.cpf, fu.setor, fu.funcao, fu.ativo,
            r.total_entregas, r.total_itens, r.ultima_entrega_em
       ${ORIGEM_LISTA}
       JOIN ${RESUMO} ON true
       ${FILTRO_LISTA}
      ORDER BY r.ultima_entrega_em DESC NULLS LAST, f.numero ASC
      LIMIT $9 OFFSET $10`,
    [empresaId, ...filtrosDaLista(filtros), limite, (pagina - 1) * limite],
  );
  return rows.map(mapearLinhaDaLista);
}

async function contar(executor, empresaId, filtros) {
  exigirId(empresaId, 'identificador de empresa');
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total ${ORIGEM_LISTA} ${FILTRO_LISTA}`,
    [empresaId, ...filtrosDaLista(filtros)],
  );
  return rows[0].total;
}

module.exports = { buscarPorId, buscarPorFuncionario, criar, resumo, listar, contar };
