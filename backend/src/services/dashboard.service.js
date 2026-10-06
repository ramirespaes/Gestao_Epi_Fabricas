'use strict';

const autorizacao = require('../middleware/autorizacao');
const loteRepo = require('../repositories/estoque-lote.repository');
const posicaoRepo = require('../repositories/posicao-estoque.repository');
const funcionarioRepo = require('../repositories/funcionario.repository');
const consultaRepo = require('../repositories/solicitacao-epi-consulta.repository');
const coberturaRepo = require('../repositories/solicitacao-epi-cobertura.repository');
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
 *
 * 12G-6: três contagens de solicitações distintas, pela AÇÃO efetiva
 * (autorizacao.avaliarPermissaoAcao), como as páginas que as trabalham:
 *   solicitacoesAguardandoSst      -> APROVAR_SOLICITACAO (a fila da Aprovação);
 *   solicitacoesAguardandoEstoque  -> REALIZAR_ENTREGA ou ENCERRAR_SOLICITACAO
 *     (aprovadas com pendente na fila FIFO e nenhum item coberto agora);
 *   disponiveisParaEntrega         -> REALIZAR_ENTREGA (aprovadas com algum
 *     item coberto agora).
 * As duas últimas são exclusivas e saem de uma contagem só; as três, do mesmo
 * instantâneo. Nada é gravado.
 */

const FONTES = Object.freeze({ estoque: 'availableItems', validade: 'stockValidity', funcionarios: 'employeeHistory' });
const ACOES = Object.freeze({
  aguardandoSst: Object.freeze(['APROVAR_SOLICITACAO']),
  aguardandoEstoque: Object.freeze(['REALIZAR_ENTREGA', 'ENCERRAR_SOLICITACAO']),
  disponiveis: Object.freeze(['REALIZAR_ENTREGA']),
});
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

async function temAlguma(pool, contexto, acoes) {
  for (const acao of acoes) {
    if (await autorizacao.avaliarPermissaoAcao(pool, contexto, acao)) return true;
  }
  return false;
}

async function emLeitura(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroLeitura) {
      await client.query('ROLLBACK');
      throw erroLeitura;
    }
  } finally {
    client.release();
  }
}

async function contarSolicitacoes(pool, contexto, hoje) {
  const [sst, estoque, disponiveis] = await Promise.all([
    temAlguma(pool, contexto, ACOES.aguardandoSst),
    temAlguma(pool, contexto, ACOES.aguardandoEstoque),
    temAlguma(pool, contexto, ACOES.disponiveis),
  ]);
  if (!sst && !estoque && !disponiveis) return { sst: null, estoque: null, disponiveis: null };
  const { empresaId } = contexto;
  return emLeitura(pool, async (client) => {
    const fila = sst ? await consultaRepo.contarFila(client, empresaId) : null;
    const porCobertura = estoque || disponiveis ? await coberturaRepo.contarSolicitacoesPorCobertura(client, empresaId, { hoje }) : null;
    return {
      sst: fila,
      estoque: estoque ? porCobertura.semCobertura : null,
      disponiveis: disponiveis ? porCobertura.comCobertura : null,
    };
  });
}

const numeroOuNegado = (valor) => (valor === null ? { ...NEGADO } : { permitido: true, valor });

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
  const [posicao, ca, ativos, solicitacoes] = await Promise.all([
    estoque ? posicaoRepo.resumirPosicoes(pool, empresaId, { hoje }) : null,
    validade ? loteRepo.resumirIndicadores(pool, empresaId, { hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA }) : null,
    funcionarios ? funcionarioRepo.contarPorEmpresa(pool, empresaId, { ativo: true }) : null,
    contarSolicitacoes(pool, contexto, hoje),
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
    solicitacoesAguardandoSst: numeroOuNegado(solicitacoes.sst),
    solicitacoesAguardandoEstoque: numeroOuNegado(solicitacoes.estoque),
    disponiveisParaEntrega: numeroOuNegado(solicitacoes.disponiveis),
  };
}

module.exports = { consultar, FONTES, ACOES };
