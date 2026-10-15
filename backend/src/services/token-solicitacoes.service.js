'use strict';

const { HttpError } = require('../errors/HttpError');
const { hashTokenSessao, tokenSessaoTemFormatoValido } = require('../security/token');
const { dataOperacional } = require('../utils/data-operacional');
const atendimentoRepo = require('../repositories/token-atendimento.repository');
const solicitacoesRepo = require('../repositories/token-solicitacoes.repository');
const coberturaRepo = require('../repositories/solicitacao-epi-cobertura.repository');
const { situacaoDoItem } = require('./solicitacao-epi-situacao');

/**
 * Atendimento Token — o que o funcionário do atendimento atual já tem em aberto (Etapa G).
 *
 * NÃO é a recuperação da resposta HTTP original da Etapa F (`GET …/pedidos/:chave`, vinculada ao atendimento que enviou o pedido): é uma
 * consulta feita DEPOIS de uma identificação válida, sobre o funcionário do atendimento vigente, sem chave e sem número de pedido.
 *
 * CONSULTA PURA: uma leitura em instantâneo único (READ ONLY, REPEATABLE READ). Não escreve, não renova os 60 s, não reemite cookie e não
 * fecha o atendimento vencido. A validade do atendimento é a da Etapa D, lida pelo MESMO repositório (`buscarAbertoPorToken`). Qualquer
 * falha é a resposta única 401 ATENDIMENTO_INVALIDO. Empresa, tablet e funcionário vêm SEMPRE do servidor.
 *
 * Tudo o que aparece é DERIVADO das regras reais da 12G-6, nada é gravado nem inventado:
 *   - solicitação PENDENTE                          → AGUARDANDO_APROVACAO (quantidade solicitada);
 *   - aprovada, parte COBERTA pela fila FIFO do par  → DISPONIVEL_PARA_RETIRADA (aprovar NÃO é disponibilidade; só `coberta` > 0);
 *   - aprovada, parte sem cobertura                  → AGUARDANDO_ESTOQUE;
 *   - aprovada suspensa (trabalhador/material inativo) → INDISPONIVEL.
 * `retiradaParcial` marca o item que já teve entrega parcial (a quantidade mostrada é só o que ainda falta). Entregue, cancelada, reprovada e
 * encerrada não aparecem. A resposta não traz número de pedido, CPF, matrícula, saldo nem dado administrativo.
 */

const SITUACOES = Object.freeze(['DISPONIVEL_PARA_RETIRADA', 'AGUARDANDO_ESTOQUE', 'AGUARDANDO_APROVACAO', 'INDISPONIVEL']);
const atendimentoInvalido = () => HttpError.unauthorized('ATENDIMENTO_INVALIDO', 'Atendimento inválido ou expirado');

async function emLeitura(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Agrupa por material, tamanho e situação (somando as solicitações) e ordena: disponível primeiro, depois nome e tamanho (sem tamanho antes). */
function montarLinhas(itens, { cobertura, nomes }) {
  const coberturaPorItem = new Map(cobertura.map((c) => [c.itemId, c]));
  const grupos = new Map();
  const somar = (item, situacao, quantidade, retiradaParcial) => {
    if (quantidade <= 0) return;
    const chave = `${item.materialId}\n${item.tamanho ?? ''}\n${situacao}`;
    const grupo = grupos.get(chave) ?? {
      materialId: item.materialId, nome: nomes.get(item.materialId) ?? '', tamanho: item.tamanho, situacao, quantidade: 0, retiradaParcial: false,
    };
    grupo.quantidade += quantidade;
    grupo.retiradaParcial = grupo.retiradaParcial || retiradaParcial;
    grupos.set(chave, grupo);
  };

  for (const item of itens) {
    if (item.status === 'PENDENTE') {
      somar(item, 'AGUARDANDO_APROVACAO', item.quantidadeSolicitada, false);
      continue;
    }
    const pendente = item.quantidadeAprovada - item.quantidadeEntregue;
    const c = coberturaPorItem.get(item.itemId) ?? null;
    const situacao = situacaoDoItem({
      decisao: item.decisao, quantidadeAprovada: item.quantidadeAprovada, quantidadeEntregue: item.quantidadeEntregue, coberta: c === null ? null : c.coberta,
    });
    const parcial = item.quantidadeEntregue > 0;
    if (situacao === 'SUSPENSA') {
      somar(item, 'INDISPONIVEL', pendente, parcial);
      continue;
    }
    somar(item, 'DISPONIVEL_PARA_RETIRADA', c.coberta, parcial);
    somar(item, 'AGUARDANDO_ESTOQUE', c.semCobertura, parcial);
  }

  return [...grupos.values()].sort((x, y) => SITUACOES.indexOf(x.situacao) - SITUACOES.indexOf(y.situacao)
    || comparar(x.nome, y.nome) || comparar(x.tamanho ?? '', y.tamanho ?? ''));
}

/**
 * @param {{ dispositivo: { id: number, empresaId: number }, token: string|null }} entrada token = cookie do atendimento (já separado do tablet)
 * @returns {Promise<{ temDisponiveis: boolean, itens: object[] }>}
 * @throws {HttpError} 401 ATENDIMENTO_INVALIDO
 */
async function obter(pool, { dispositivo, token }) {
  if (!tokenSessaoTemFormatoValido(token)) throw atendimentoInvalido();
  const tokenHash = hashTokenSessao(token);
  const resultado = await emLeitura(pool, async (client) => {
    const atendimento = await atendimentoRepo.buscarAbertoPorToken(client, { empresaId: dispositivo.empresaId, dispositivoId: dispositivo.id, tokenHash });
    if (atendimento === null || atendimento.vencido || !atendimento.funcionario_ativo || atendimento.anterior_a_reativacao) return null;

    const empresaId = atendimento.empresa_id;
    const abertos = await solicitacoesRepo.listarItensEmAberto(client, { empresaId, funcionarioId: atendimento.funcionario_id });
    const aprovadas = [...new Set(abertos.filter((i) => i.status !== 'PENDENTE').map((i) => i.solicitacaoId))];
    const cobertura = aprovadas.length === 0
      ? []
      : await coberturaRepo.listarCoberturaDasSolicitacoes(client, empresaId, { hoje: dataOperacional(), solicitacaoIds: aprovadas });
    const nomes = await solicitacoesRepo.nomesDosMateriais(client, { empresaId, materialIds: [...new Set(abertos.map((i) => i.materialId))] });
    const itens = montarLinhas(abertos, { cobertura, nomes });
    return { temDisponiveis: itens.some((i) => i.situacao === 'DISPONIVEL_PARA_RETIRADA'), itens };
  });
  if (resultado === null) throw atendimentoInvalido();
  return resultado;
}

module.exports = { SITUACOES, obter };
