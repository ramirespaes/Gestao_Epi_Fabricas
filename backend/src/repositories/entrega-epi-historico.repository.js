'use strict';

/**
 * Histórico de EPIs entregues da empresa: uma linha por ITEM entregue, de todas as entregas (DIRETA e SOLICITACAO),
 * lida só dos snapshots congelados da entrega (trabalhador, material, prazo, responsável) e do lote (tamanho e CA,
 * imutáveis). Nada aqui usa o cadastro atual do trabalhador. Nenhuma entrega some quando o trabalhador recebe outro EPI.
 *
 * Validade de uso = dia operacional da entrega + prazo de uso congelado do item. Dias restantes = validade - hoje, com
 * "hoje" no dia operacional de São Paulo (o mesmo fuso da entrega). A faixa "próximo do vencimento" vem como parâmetro.
 *
 * Busca de texto sem diferenciar maiúsculas nem acentos (translate, sem extensão nova) e com correspondência parcial; os
 * curingas do usuário são escapados no serviço. O índice de (empresa, entregue_em DESC, id DESC) da 058 atende a ordem.
 */

const ACENTUADAS = 'áàâãäéèêëíìîïóòôõöúùûüç';
const SEM_ACENTO = 'aaaaaeeeeiiiiooooouuuuc';
const SEM = (coluna) => `translate(lower(${coluna}), '${ACENTUADAS}', '${SEM_ACENTO}')`;
const HOJE = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";
const DIAS = `((e.data_operacional + i.material_prazo_uso_dias) - ${HOJE})`;

const DE = `
  FROM entregas_epi_itens i
  JOIN entregas_epi e ON e.empresa_id = i.empresa_id AND e.id = i.entrega_id
  JOIN fichas_epi f ON f.empresa_id = e.empresa_id AND f.id = e.ficha_id
  JOIN estoque_lotes l ON l.empresa_id = i.empresa_id AND l.id = i.lote_id`;

// $1 empresa, $2 padrão do item/tipo, $3 padrão do funcionário, $4 de, $5 até, $6 status, $7 dias do "próximo".
const FILTRO = `
  WHERE e.empresa_id = $1
    AND ($2::text IS NULL OR ${SEM('i.material_nome')} LIKE $2 ESCAPE '\\' OR ${SEM("coalesce(i.material_tipo, '')")} LIKE $2 ESCAPE '\\')
    AND ($3::text IS NULL OR ${SEM('e.trabalhador_nome')} LIKE $3 ESCAPE '\\' OR lower(e.trabalhador_matricula) LIKE $3 ESCAPE '\\')
    AND ($4::date IS NULL OR e.data_operacional >= $4::date)
    AND ($5::date IS NULL OR e.data_operacional <= $5::date)
    AND ($6::text IS NULL
      OR ($6 = 'VENCIDO' AND ${DIAS} < 0)
      OR ($6 = 'PROXIMO' AND ${DIAS} BETWEEN 0 AND $7::int)
      OR ($6 = 'VALIDO' AND ${DIAS} > $7::int))`;

const SELECIONAR = `
  SELECT i.id AS item_id, e.id AS entrega_id, f.id AS ficha_id, f.numero AS ficha_numero,
         e.trabalhador_nome, e.trabalhador_matricula, e.trabalhador_setor, e.origem, e.responsavel_nome,
         i.material_id, i.material_nome, i.material_tipo, i.material_grupo_protecao, l.tamanho, i.quantidade, i.motivo, i.previsto_no_ghe,
         l.ca_numero, to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade,
         to_char(e.data_operacional, 'YYYY-MM-DD') AS data_entrega, e.entregue_em,
         i.material_prazo_uso_dias,
         to_char(e.data_operacional + i.material_prazo_uso_dias, 'YYYY-MM-DD') AS validade_uso,
         ${DIAS}::int AS dias_restantes`;

const mapear = (r) => ({
  itemId: r.item_id,
  entregaId: r.entrega_id,
  fichaId: r.ficha_id,
  fichaNumero: r.ficha_numero,
  origem: r.origem,
  trabalhador: { nome: r.trabalhador_nome, matricula: r.trabalhador_matricula, setor: r.trabalhador_setor },
  material: { id: r.material_id, nome: r.material_nome, tipo: r.material_tipo, grupoProtecao: r.material_grupo_protecao ?? null },
  tamanho: r.tamanho,
  quantidade: r.quantidade,
  motivo: r.motivo,
  previstoNoGhe: r.previsto_no_ghe,
  ca: { numero: r.ca_numero, validade: r.ca_validade },
  dataEntrega: r.data_entrega,
  entregueEm: r.entregue_em,
  prazoUsoDias: r.material_prazo_uso_dias,
  validadeUso: r.validade_uso,
  diasRestantes: r.dias_restantes,
  responsavel: { nome: r.responsavel_nome },
});

function parametros(empresaId, f) {
  return [empresaId, f.padraoItem, f.padraoFuncionario, f.de, f.ate, f.status, f.diasProximo];
}

async function listar(executor, empresaId, filtros, { pagina, limite }) {
  const { rows } = await executor.query(
    `${SELECIONAR} ${DE} ${FILTRO} ORDER BY e.entregue_em DESC, i.id DESC LIMIT $8 OFFSET $9`,
    [...parametros(empresaId, filtros), limite, (pagina - 1) * limite],
  );
  return rows.map(mapear);
}

async function contar(executor, empresaId, filtros) {
  const { rows } = await executor.query(`SELECT count(*)::int AS total ${DE} ${FILTRO}`, parametros(empresaId, filtros));
  return rows[0].total;
}

module.exports = { listar, contar, SEM, DIAS, DE, SELECIONAR, mapear };
