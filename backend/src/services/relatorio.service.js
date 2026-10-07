'use strict';

const estoqueRepo = require('../repositories/relatorio-estoque.repository');
const entregasRepo = require('../repositories/relatorio-entregas.repository');
const consulta = require('./entrega-epi-consulta.service');
const { DIAS_ALERTA_VALIDADE_CA } = require('../schemas/itens-disponiveis.schema');
const { dataOperacional } = require('../utils/data-operacional');

/**
 * Relatórios (12K-D, etapa 1). Só leitura; empresa sempre da sessão (quem chama garante). Estoque reutiliza a regra
 * oficial de saldo utilizável e de CA; as três abas de entregas reutilizam os snapshots e a validade de uso da 12K-C.
 */

const FAIXAS = Object.freeze({ '0-10': [0, 10], '11-20': [11, 20], '21-30': [21, 30] });

const statusProximo = (dias) => {
  if (dias <= 10) return 'TROCAR_URGENTE';
  return dias <= 20 ? 'ATENCAO' : 'PROXIMO';
};

async function estoque(pool, {
  empresaId, busca = null, status = null, ordem = 'material', direcao = 'asc', pagina, limite,
}, agora = new Date()) {
  const referencia = { hoje: dataOperacional(agora), diasAlerta: DIAS_ALERTA_VALIDADE_CA };
  const filtro = { padraoBusca: consulta.padraoParcial(busca), status };
  const [indicadores, alertas, linhas, total] = await Promise.all([
    estoqueRepo.indicadores(pool, empresaId, referencia),
    estoqueRepo.alertas(pool, empresaId, referencia),
    estoqueRepo.listarLotes(pool, empresaId, referencia, { ...filtro, ordem, direcao, pagina, limite }),
    estoqueRepo.contarLotes(pool, empresaId, referencia, filtro),
  ]);
  return {
    indicadores, alertas, linhas, total, pagina, limite, diasAlertaCa: DIAS_ALERTA_VALIDADE_CA,
  };
}

function filtrosDeEntregas(f, faixa) {
  return {
    padraoItem: consulta.padraoParcial(f.item ?? null),
    padraoFuncionario: consulta.padraoParcial(f.funcionario ?? null),
    padraoSetor: consulta.padraoParcial(f.setor ?? null),
    de: f.de ?? null,
    ate: f.ate ?? null,
    diasMin: faixa.min,
    diasMax: faixa.max,
  };
}

async function listarEntregas(pool, empresaId, f, faixa, padrao, mapear) {
  const filtros = filtrosDeEntregas(f, faixa);
  const pagina = { ordem: f.ordem ?? padrao.ordem, direcao: f.direcao ?? padrao.direcao, pagina: f.pagina, limite: f.limite };
  const [itens, total] = await Promise.all([
    entregasRepo.listar(pool, empresaId, filtros, pagina),
    entregasRepo.contar(pool, empresaId, filtros),
  ]);
  return { itens: itens.map(mapear), total, pagina: f.pagina, limite: f.limite };
}

const proximoVencimento = (pool, { empresaId, faixa = null, ...f }) => {
  const [min, max] = faixa ? FAIXAS[faixa] : [0, consulta.DIAS_PROXIMO_VENCIMENTO];
  return listarEntregas(pool, empresaId, f, { min, max }, { ordem: 'dias', direcao: 'asc' },
    (i) => ({ ...i, status: statusProximo(i.diasRestantes) }));
};

// Itens já substituídos não são excluídos: o modelo não tem vínculo autoritativo de substituição.
const vencidos = (pool, { empresaId, ...f }) => listarEntregas(pool, empresaId, f, { min: null, max: -1 },
  { ordem: 'dias', direcao: 'asc' },
  (i) => ({ ...i, diasVencidos: -i.diasRestantes, status: 'TROCA_URGENTE' }));

const entregues = (pool, { empresaId, ...f }) => listarEntregas(pool, empresaId, f, { min: null, max: null },
  { ordem: 'dataEntrega', direcao: 'desc' }, (i) => i);

module.exports = { estoque, proximoVencimento, vencidos, entregues, statusProximo };
