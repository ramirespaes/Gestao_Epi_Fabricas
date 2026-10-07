'use strict';

const { SEM, DIAS, DE, SELECIONAR, mapear } = require('./entrega-epi-historico.repository');

// $1 empresa, $2 item/tipo, $3 funcionário, $4 de, $5 até, $6 setor, $7 dias mínimos, $8 dias máximos.
const FILTRO = `
  WHERE e.empresa_id = $1
    AND ($2::text IS NULL OR ${SEM('i.material_nome')} LIKE $2 ESCAPE '\\' OR ${SEM("coalesce(i.material_tipo, '')")} LIKE $2 ESCAPE '\\')
    AND ($3::text IS NULL OR ${SEM('e.trabalhador_nome')} LIKE $3 ESCAPE '\\' OR lower(e.trabalhador_matricula) LIKE $3 ESCAPE '\\')
    AND ($4::date IS NULL OR e.data_operacional >= $4::date)
    AND ($5::date IS NULL OR e.data_operacional <= $5::date)
    AND ($6::text IS NULL OR ${SEM("coalesce(e.trabalhador_setor, '')")} LIKE $6 ESCAPE '\\')
    AND ($7::int IS NULL OR ${DIAS} >= $7::int)
    AND ($8::int IS NULL OR ${DIAS} <= $8::int)`;

const COLUNAS_ORDEM = Object.freeze({
  funcionario: 'lower(e.trabalhador_nome)',
  setor: "lower(coalesce(e.trabalhador_setor, ''))",
  epi: 'lower(i.material_nome)',
  ca: "coalesce(l.ca_numero, '')",
  dataEntrega: 'e.data_operacional',
  validade: '(e.data_operacional + i.material_prazo_uso_dias)',
  dias: DIAS,
  quantidade: 'i.quantidade',
  responsavel: "lower(coalesce(e.responsavel_nome, ''))",
});

function ordenar(ordem, direcao) {
  const coluna = COLUNAS_ORDEM[ordem];
  if (!coluna) throw new TypeError('ordenação do relatório inválida');
  return `ORDER BY ${coluna} ${direcao === 'desc' ? 'DESC' : 'ASC'}, e.entregue_em DESC, i.id DESC`;
}

const parametros = (empresaId, f) => [empresaId, f.padraoItem, f.padraoFuncionario, f.de, f.ate, f.padraoSetor, f.diasMin, f.diasMax];

async function listar(executor, empresaId, filtros, { ordem, direcao, pagina, limite }) {
  const { rows } = await executor.query(
    `${SELECIONAR} ${DE} ${FILTRO} ${ordenar(ordem, direcao)} LIMIT $9 OFFSET $10`,
    [...parametros(empresaId, filtros), limite, (pagina - 1) * limite],
  );
  return rows.map(mapear);
}

async function contar(executor, empresaId, filtros) {
  const { rows } = await executor.query(`SELECT count(*)::int AS total ${DE} ${FILTRO}`, parametros(empresaId, filtros));
  return rows[0].total;
}

module.exports = { listar, contar, ORDENS: Object.freeze(Object.keys(COLUNAS_ORDEM)) };
