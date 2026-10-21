'use strict';

const { HttpError } = require('../errors/HttpError');
const { hashTokenSessao, tokenSessaoTemFormatoValido } = require('../security/token');
const { normalizarIdGrande } = require('../utils/identificador-grande');
const atendimentoRepo = require('../repositories/token-atendimento.repository');
const catalogoRepo = require('../repositories/token-catalogo.repository');
const { criarEntregaDeImagens } = require('./imagem-material-entrega.service');

/**
 * Atendimento Token — entrega da imagem de um material ao tablet.
 *
 * Duas etapas, nesta ordem: (1) AUTORIZAR e (2) ENTREGAR. A entrega (existência, escopo da empresa, SHA-256, assinatura WebP, teto de leitura
 * e a semântica 404/503/500) é a do serviço da Biblioteca de Imagens, reutilizada sem cópia. O arquivo mestre nunca sai.
 *
 * AUTORIZAÇÃO (`autorizarPeloCatalogo`, o padrão): o atendimento vigente é o do catálogo (mesmo repositório e mesmas condições: aberto, do mesmo
 * tablet e empresa, não vencido, funcionário ATIVO, não anterior à reativação do tablet) e a imagem só sai se estiver ATUALMENTE ligada a ao menos um
 * material selecionável pelo funcionário (`imagemAutorizada`: a elegibilidade do catálogo, grade inclusive). Atendimento inválido é 401
 * ATENDIMENTO_INVALIDO; qualquer outra negativa (GHE ausente ou inativo, imagem de outro escopo, inativa ou não ligada) é o 404 uniforme. Só leitura:
 * não renova os 60 s, não escreve e não fecha o atendimento vencido. `autorizar` e `entrega` continuam injetáveis.
 *
 * CONSISTÊNCIA: as leituras da autorização (atendimento, GHE e vínculo da imagem) correm numa única transação READ ONLY REPEATABLE READ, isto é, num
 * único instantâneo coerente entre si. A garantia termina no COMMIT: a entrega roda depois, em outra operação, e relê a imagem ATIVA e o arquivo.
 * Janela residual (não eliminada): se entre a autorização e a entrega mudarem o vínculo do material, o GHE do funcionário, a situação do material ou
 * a validade do atendimento, essa imagem ainda pode sair numa resposta; a inativação da própria imagem é percebida pela entrega. O impacto é uma imagem
 * de catálogo, sem dado pessoal. Eliminar a janela exige uma transação única que também cubra a entrega.
 *
 * `versao` (o `?v=`) é só informativa: não autoriza nem nega nada. Empresa e tablet vêm do servidor (req.dispositivo), nunca do cliente.
 */

const atendimentoInvalido = () => HttpError.unauthorized('ATENDIMENTO_INVALIDO', 'Atendimento inválido ou expirado');
const naoEncontrada = () => HttpError.notFound('IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada');
const ORIGEM_DO_CATALOGO = Object.freeze({ empresa: 'EMPRESA', padrao: 'PADRAO' });

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

/** Lança 401 (atendimento inválido) ou 404 (imagem não autorizada); sem retorno quando autoriza. */
async function autorizarPeloCatalogo(pool, { empresaId, dispositivoId, tokenAtendimento, origem, id }) {
  if (!tokenSessaoTemFormatoValido(tokenAtendimento)) throw atendimentoInvalido();
  const origemDoCatalogo = ORIGEM_DO_CATALOGO[origem];
  if (origemDoCatalogo === undefined || typeof id !== 'string' || normalizarIdGrande(id) !== id) throw naoEncontrada();
  const tokenHash = hashTokenSessao(tokenAtendimento);

  const resultado = await emLeitura(pool, async (client) => {
    const atendimento = await atendimentoRepo.buscarAbertoPorToken(client, { empresaId, dispositivoId, tokenHash });
    if (atendimento === null || atendimento.vencido || !atendimento.funcionario_ativo || atendimento.anterior_a_reativacao) return 'ATENDIMENTO';
    const ghe = await catalogoRepo.buscarGheDoFuncionario(client, { empresaId: atendimento.empresa_id, funcionarioId: atendimento.funcionario_id });
    if (ghe === null || ghe.ghe_id === null || ghe.ghe_ativo !== true) return 'NEGADA';
    const autorizada = await catalogoRepo.imagemAutorizada(client, { empresaId: atendimento.empresa_id, gheId: ghe.ghe_id, origem: origemDoCatalogo, imagemId: id });
    return autorizada ? 'AUTORIZADA' : 'NEGADA';
  });
  if (resultado === 'ATENDIMENTO') throw atendimentoInvalido();
  if (resultado !== 'AUTORIZADA') throw naoEncontrada();
}

/**
 * @param {object} pool
 * @param {{ empresaId: number, dispositivoId: number, tokenAtendimento: string|null, origem: 'empresa'|'padrao', id: string, variante: 'miniatura'|'exibicao', versao?: number|null }} dados
 * @param {{ autorizar?: Function, entrega?: { obter: Function }|null }} dependencias
 *   `entrega` ausente ou nula deixa a entrega indisponível (503 pelo próprio serviço de entrega).
 * @returns {Promise<{ corpo: Buffer, tipo: string }>}
 */
async function obter(pool, dados, { autorizar = autorizarPeloCatalogo, entrega = null } = {}) {
  const { empresaId, dispositivoId, tokenAtendimento = null, origem, id, variante } = dados;
  await autorizar(pool, { empresaId, dispositivoId, tokenAtendimento, origem, id, variante });
  const servico = entrega ?? criarEntregaDeImagens();
  const { corpo, tipo } = await servico.obter(pool, { empresaId, origem, id, variante });
  return { corpo, tipo };
}

module.exports = { obter, autorizarPeloCatalogo };
