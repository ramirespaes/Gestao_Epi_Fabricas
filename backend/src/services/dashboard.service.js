'use strict';

const autorizacao = require('../middleware/autorizacao');
const loteRepo = require('../repositories/estoque-lote.repository');
const posicaoRepo = require('../repositories/posicao-estoque.repository');
const funcionarioRepo = require('../repositories/funcionario.repository');
const { DIAS_ALERTA_VALIDADE_CA } = require('../schemas/itens-disponiveis.schema');
const { exigirDataOperacional } = require('../utils/data-operacional');

/**
 * Indicadores do dashboard (Bloco 9, Etapa C, Parte C6) — somente leitura.
 *
 * A rota já exigiu `dashboard.visualizar`. Aqui, cada indicador só é
 * calculado e devolvido se o usuário também puder VISUALIZAR a fonte dos
 * dados, decidida pela MESMA função que autoriza as rotas
 * (autorizacao.avaliarPermissaoRecurso — nenhuma interpretação nova do RBAC):
 *   itensDisponiveis, estoqueAbaixoMinimo, saldoLivre, comprometido,
 *   semCobertura, necessidadeReposicao -> availableItems (os dados de Itens
 *     Disponíveis, somados da MESMA posição por par: o físico utilizável, o
 *     saldo livre L, o comprometido C, a demanda sem cobertura G e a necessidade
 *     G + déficit; o abaixo do mínimo mede o mínimo efetivo contra o livre);
 *   caVencido (+ aVencer)               -> stockValidity (E9: os lotes com
 *     saldo e CA vencido ou a vencer, na data operacional, contados como na
 *     Validade de estoque, inclusive de material inativo);
 *   funcionariosAtivos                  -> employeeHistory.
 * Sem a permissão da fonte: { permitido: false } — nenhum número sai do
 * servidor. Empresa, usuário e perfil vêm só da sessão.
 */

const FONTES = Object.freeze({ estoque: 'availableItems', validade: 'stockValidity', funcionarios: 'employeeHistory' });
const NEGADO = Object.freeze({ permitido: false });

function exigirInteiroPositivo(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

async function podeVer(pool, contexto, recurso) {
  const decisao = await autorizacao.avaliarPermissaoRecurso(pool, contexto, recurso);
  return decisao.visualizar === true;
}

async function consultar(pool, { empresaId, usuarioId, perfil, hoje }) {
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
  exigirDataOperacional(hoje);
  exigirInteiroPositivo(usuarioId, 'identificador de usuário');
  if (typeof perfil !== 'string' || perfil.length === 0) {
    throw new TypeError('perfil inválido');
  }
  const contexto = { empresaId, usuarioId, perfil };

  const [estoque, validade, funcionarios] = await Promise.all([
    podeVer(pool, contexto, FONTES.estoque),
    podeVer(pool, contexto, FONTES.validade),
    podeVer(pool, contexto, FONTES.funcionarios),
  ]);

  // Cada agregação só roda se o usuário vê a sua fonte; o estoque sai da posição, a validade dos lotes.
  const [posicao, ca, ativos] = await Promise.all([
    estoque ? posicaoRepo.resumirPosicoes(pool, empresaId, { hoje }) : null,
    validade ? loteRepo.resumirIndicadores(pool, empresaId, { hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA }) : null,
    funcionarios ? funcionarioRepo.contarPorEmpresa(pool, empresaId, { ativo: true }) : null,
  ]);
  const deEstoque = (valor) => (estoque ? { permitido: true, valor } : { ...NEGADO });

  return {
    itensDisponiveis: deEstoque(estoque ? posicao.fisicoUtilizavel : null),
    estoqueAbaixoMinimo: deEstoque(estoque ? posicao.paresAbaixoDoMinimo : null),
    saldoLivre: deEstoque(estoque ? posicao.saldoLivre : null),
    comprometido: deEstoque(estoque ? posicao.comprometido : null),
    semCobertura: deEstoque(estoque ? posicao.semCobertura : null),
    necessidadeReposicao: deEstoque(estoque ? posicao.necessidade : null),
    caVencido: validade
      ? { permitido: true, valor: ca.caVencido, aVencer: ca.caAVencer, diasAlerta: DIAS_ALERTA_VALIDADE_CA }
      : { ...NEGADO },
    funcionariosAtivos: funcionarios ? { permitido: true, valor: ativos } : { ...NEGADO },
  };
}

module.exports = { consultar, FONTES };
