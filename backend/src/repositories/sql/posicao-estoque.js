'use strict';

/**
 * Fragmentos de SQL da definição única de "físico utilizável" e de "demanda
 * pendente" (12D-1). Funções puras e sem dependência: nenhum require, então
 * nenhum repository depende de outro por causa delas.
 *
 * Cada fragmento recebe os ALIASES das tabelas e a REFERÊNCIA ($n) dos
 * parâmetros que a consulta que o usa declarou. Nada aqui assume `$1`, `$2` ou
 * `$3`: cada consulta tem o seu contrato de parâmetros, e a reutilização não
 * pode deslocar nem colidir placeholders. Aliases e referências vão direto
 * para o texto do SQL, então são validados e qualquer coisa fora do formato é
 * erro de programação.
 *
 *   físico utilizável = saldo do lote, menos o que o CA ausente ou vencido
 *   bloqueia (material que dispensa CA nunca bloqueia), na data operacional
 *   recebida; nunca CURRENT_DATE, porque o fuso do banco não é o de São Paulo.
 *   demanda pendente = aprovada menos entregue dos itens APROVADOS de
 *   solicitação APROVADA ou APROVADA_PARCIAL, de trabalhador e material
 *   ativos; a entregue é derivada dos itens da entrega, nunca de coluna.
 */

const ALIAS = /^[a-z][a-z0-9_]{0,30}$/;
const PARAMETRO = /^\$[1-9][0-9]{0,2}$/;

function alias(valor, nome) {
  if (typeof valor !== 'string' || !ALIAS.test(valor)) {
    throw new TypeError(`alias de ${nome} inválido`);
  }
  return valor;
}

function parametro(valor, nome) {
  if (typeof valor !== 'string' || !PARAMETRO.test(valor)) {
    throw new TypeError(`referência de parâmetro de ${nome} inválida`);
  }
  return valor;
}

function contrato(dados, nome) {
  if (dados === null || typeof dados !== 'object') {
    throw new TypeError(`contrato de ${nome} ausente`);
  }
  return dados;
}

/** CA ausente ou vencido num material que exige CA. Para usar depois de WHEN ou AND. */
function bloqueadoPorCa(dados) {
  const { lote, material, hoje } = contrato(dados, 'bloqueadoPorCa');
  const l = alias(lote, 'lote');
  const m = alias(material, 'material');
  const h = parametro(hoje, 'data');
  return `${m}.exige_ca AND (${l}.ca_validade IS NULL OR ${l}.ca_validade < ${h}::date)`;
}

/** O saldo do lote que pode gerar entrega: zero se o lote está bloqueado. */
function fisicoUtilizavel(dados) {
  const { lote } = contrato(dados, 'fisicoUtilizavel');
  return `CASE WHEN ${bloqueadoPorCa(dados)} THEN 0 ELSE ${alias(lote, 'lote')}.saldo END`;
}

/** O saldo do lote que está bloqueado por CA: zero se o lote não está bloqueado. */
function saldoBloqueado(dados) {
  const { lote } = contrato(dados, 'saldoBloqueado');
  return `CASE WHEN ${bloqueadoPorCa(dados)} THEN ${alias(lote, 'lote')}.saldo ELSE 0 END`;
}

/**
 * Situação do CA do lote na data operacional. Com `diasAlerta` (outro
 * parâmetro, nunca o da data) inclui A_VENCER; sem ele, não.
 */
function situacaoCa(dados) {
  const { lote, material, hoje, diasAlerta = null } = contrato(dados, 'situacaoCa');
  const l = alias(lote, 'lote');
  const m = alias(material, 'material');
  const h = parametro(hoje, 'data');
  let aVencer = '';
  if (diasAlerta !== null) {
    const d = parametro(diasAlerta, 'dias de alerta');
    if (d === h) throw new TypeError('a data e os dias de alerta não podem ser o mesmo parâmetro');
    aVencer = ` WHEN ${l}.ca_validade <= ${h}::date + ${d}::int THEN 'A_VENCER'`;
  }
  return `CASE
         WHEN NOT ${m}.exige_ca THEN 'NAO_EXIGE_CA'
         WHEN ${l}.ca_validade IS NULL THEN 'SEM_CA'
         WHEN ${l}.ca_validade < ${h}::date THEN 'VENCIDO'
         WHEN ${l}.ca_validade = ${h}::date THEN 'VENCE_HOJE'${aVencer}
         ELSE 'VALIDO'
       END`;
}

function aliasesDaDemanda(dados) {
  const d = contrato(dados, 'demanda');
  return {
    i: alias(d.item, 'item'),
    s: alias(d.solicitacao, 'solicitação'),
    f: alias(d.funcionario, 'funcionário'),
    m: alias(d.material, 'material'),
    e: alias(d.entregue, 'entregue'),
  };
}

/** A solicitação ainda é atendível: APROVADA ou APROVADA_PARCIAL (ENTREGUE, CANCELADA, REPROVADA e PENDENTE ficam fora). */
function statusAtendiveis(dados) {
  const { solicitacao } = contrato(dados, 'statusAtendiveis');
  return `${alias(solicitacao, 'solicitação')}.status IN ('APROVADA', 'APROVADA_PARCIAL')`;
}

/** A quantidade já entregue do item: a soma dos itens da entrega ligados a ele, de qualquer lote e de qualquer ato. */
function entregueDoItem(dados) {
  const { item, entregue } = contrato(dados, 'entregueDoItem');
  const i = alias(item, 'item');
  return `LEFT JOIN LATERAL (
           SELECT sum(ei.quantidade)::bigint AS entregue
             FROM entregas_epi_itens ei
            WHERE ei.empresa_id = ${i}.empresa_id AND ei.solicitacao_item_id = ${i}.id
         ) ${alias(entregue, 'entregue')} ON true`;
}

/**
 * Os JOINs que ligam o item da solicitação à demanda atendível: solicitação
 * APROVADA ou APROVADA_PARCIAL, trabalhador ativo, material ativo e a entregue
 * derivada dos itens da entrega. A consulta que usa começa em
 * `solicitacoes_epi_itens <item>` e põe a empresa e `decisao = 'APROVADO'` no
 * seu próprio WHERE ou JOIN (o índice parcial da demanda por par depende disso).
 * A fila FIFO, que parte da solicitação, monta os seus JOINs com as mesmas peças
 * (statusAtendiveis, entregueDoItem, pendenteDoItem e itemComPendente).
 */
function fonteDaDemanda(dados) {
  const { i, s, f, m } = aliasesDaDemanda(dados);
  return `JOIN solicitacoes_epi ${s} ON ${s}.empresa_id = ${i}.empresa_id AND ${s}.id = ${i}.solicitacao_id AND ${statusAtendiveis({ solicitacao: s })}
         JOIN funcionarios ${f} ON ${f}.empresa_id = ${s}.empresa_id AND ${f}.id = ${s}.funcionario_id AND ${f}.ativo
         JOIN materiais ${m} ON ${m}.empresa_id = ${i}.empresa_id AND ${m}.id = ${i}.material_id AND ${m}.ativo
         ${entregueDoItem(dados)}`;
}

/** O que ainda falta entregar do item: a aprovada menos a entregue. */
function pendenteDoItem(dados) {
  const { i, e } = aliasesDaDemanda({ solicitacao: 's', funcionario: 'f', material: 'm', ...contrato(dados, 'pendenteDoItem') });
  return `${i}.quantidade_aprovada - COALESCE(${e}.entregue, 0)`;
}

/** Só o item que ainda falta entregar entra: o inteiramente entregue sai, e a pendente nunca é negativa. */
function itemComPendente(dados) {
  const { i, e } = aliasesDaDemanda({ solicitacao: 's', funcionario: 'f', material: 'm', ...contrato(dados, 'itemComPendente') });
  return `${i}.quantidade_aprovada > COALESCE(${e}.entregue, 0)`;
}

module.exports = {
  bloqueadoPorCa,
  fisicoUtilizavel,
  saldoBloqueado,
  situacaoCa,
  statusAtendiveis,
  entregueDoItem,
  fonteDaDemanda,
  pendenteDoItem,
  itemComPendente,
};
