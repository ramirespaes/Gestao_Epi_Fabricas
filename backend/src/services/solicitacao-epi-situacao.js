'use strict';

/**
 * Situação operacional derivada da solicitação de EPI. Nada daqui é gravado:
 * o item aprovado é lido pela quantidade aprovada, pela entregue e pela parte
 * coberta do estoque (posição por empresa, material e tamanho); o cabeçalho,
 * pelas situações dos itens.
 *
 * `coberta` nulo quer dizer que o item não está na fila de cobertura
 * (trabalhador ou material inativo): a demanda fica SUSPENSA, sem mudar o
 * status gravado. `quantidadeEntregue` é derivada das entregas ligadas ao item
 * (entregas_epi_itens.solicitacao_item_id, migration 066), de qualquer lote e
 * de qualquer ato; o pendente é a aprovada menos essa soma.
 */

const SITUACOES = Object.freeze([
  'AGUARDANDO_ESTOQUE', 'PARCIALMENTE_COBERTA', 'PRONTA_PARA_ENTREGA', 'PARCIALMENTE_ENTREGUE', 'ENTREGUE', 'SUSPENSA',
]);
const STATUS = Object.freeze(['PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE']);
const SEM_SITUACAO = Object.freeze(['PENDENTE', 'REPROVADA', 'CANCELADA']);

const inteiroNaoNegativo = (valor) => Number.isInteger(valor) && valor >= 0;

function situacaoDoItem({
  decisao, quantidadeAprovada, quantidadeEntregue = 0, coberta = null,
}) {
  if (decisao !== 'APROVADO') return null;
  if (!Number.isInteger(quantidadeAprovada) || quantidadeAprovada < 1) throw new TypeError('quantidade aprovada inválida');
  if (!inteiroNaoNegativo(quantidadeEntregue) || quantidadeEntregue > quantidadeAprovada) throw new TypeError('quantidade entregue inválida');

  const pendente = quantidadeAprovada - quantidadeEntregue;
  if (pendente === 0) return 'ENTREGUE';
  if (coberta === null) return 'SUSPENSA';
  if (!inteiroNaoNegativo(coberta) || coberta > pendente) throw new TypeError('quantidade coberta inválida');
  if (quantidadeEntregue > 0) return 'PARCIALMENTE_ENTREGUE';
  if (coberta === 0) return 'AGUARDANDO_ESTOQUE';
  return coberta < pendente ? 'PARCIALMENTE_COBERTA' : 'PRONTA_PARA_ENTREGA';
}

/**
 * Situação do cabeçalho a partir das situações dos itens (null para o item
 * não aprovado). Só existe para solicitação com aprovação ativa; PENDENTE,
 * REPROVADA e CANCELADA devolvem null.
 */
function situacaoDaSolicitacao(status, situacoesDosItens) {
  if (!STATUS.includes(status)) throw new TypeError('status da solicitação inválido');
  if (!Array.isArray(situacoesDosItens)) throw new TypeError('situações dos itens inválidas');
  for (const situacao of situacoesDosItens) {
    if (situacao !== null && !SITUACOES.includes(situacao)) throw new TypeError('situação de item inválida');
  }
  if (SEM_SITUACAO.includes(status)) return null;
  if (status === 'ENTREGUE') return 'ENTREGUE';

  const ativas = situacoesDosItens.filter((s) => s !== null);
  if (ativas.length === 0) throw new TypeError('solicitação aprovada sem item aprovado');
  if (ativas.every((s) => s === 'ENTREGUE')) return 'ENTREGUE';
  // Precedência: se tudo o que falta entregar está suspenso, a impossibilidade atual prevalece sobre o progresso já feito
  // (as quantidades entregues continuam visíveis em cada item). Com algo ainda entregável, vale o progresso.
  if (ativas.filter((s) => s !== 'ENTREGUE').every((s) => s === 'SUSPENSA')) return 'SUSPENSA';
  if (ativas.some((s) => s === 'ENTREGUE' || s === 'PARCIALMENTE_ENTREGUE')) return 'PARCIALMENTE_ENTREGUE';
  for (const uniforme of ['PRONTA_PARA_ENTREGA', 'AGUARDANDO_ESTOQUE', 'SUSPENSA']) {
    if (ativas.every((s) => s === uniforme)) return uniforme;
  }
  return 'PARCIALMENTE_COBERTA';
}

module.exports = { SITUACOES, situacaoDoItem, situacaoDaSolicitacao };
