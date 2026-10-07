'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const coberturaRepo = require('../repositories/solicitacao-epi-cobertura.repository');
const alertaRepo = require('../repositories/alerta-estoque.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const templates = require('../email/templates');
const links = require('../email/links');
const { servicoPadrao } = require('../email/servico-email');
const { contasComAcao } = require('./alerta-destinatarios');
const { exigirDataOperacional } = require('../utils/data-operacional');

/**
 * "Gerar alerta" (12G-6): alerta MANUAL de falta de estoque de um pedido,
 * para quem atua na reposição. Não passa pela fila automática da 069 e não
 * grava nada de estoque.
 *
 * Quem dispara tem REALIZAR_ENTREGA (a rota decide). Quem recebe: ativo, da
 * empresa ativa, com e-mail utilizável e ENTRADA_ESTOQUE efetiva, sem
 * vínculo SST, resolvido agora. O conteúdo é só o que a reposição precisa:
 * pedido, EPI, tamanho, pendente e sem cobertura; nenhum dado do trabalhador.
 *
 * Supressão do clique repetido (o padrão da 12C-3): no máximo um alerta por
 * ator e pedido na janela, conferido pela auditoria sob advisory lock de
 * espaço próprio, que segura o segundo clique simultâneo até o primeiro
 * terminar. A auditoria só é gravada se alguém recebeu: a falha de envio não
 * suprime a nova tentativa. Nada disso toca a entrega.
 */

const ACAO_ESTOQUE = 'ENTRADA_ESTOQUE';
const ACAO_AUDITORIA = 'ALERTA_FALTA_ESTOQUE';
const TIPO_EMAIL = 'FALTA_ESTOQUE_ENTREGA';
const ESCOPO_EMAIL = 'PORTAL';
const JANELA_SUPRESSAO_SEGUNDOS = 30 * 60;
const ESPACO_LOCK = 'alerta_falta_estoque';
const STATUS_ENTREGAVEIS = Object.freeze(['APROVADA', 'APROVADA_PARCIAL']);

const MSG = Object.freeze({
  NAO_ENCONTRADA: 'Solicitação não encontrada',
  NAO_ENTREGAVEL: 'A solicitação não está aprovada para entrega',
  SEM_FALTA: 'Esta solicitação não tem item aguardando estoque',
  RECENTE: 'Você já enviou um alerta deste pedido há pouco. Aguarde antes de enviar outro.',
  SEM_DESTINATARIO: 'Nenhum usuário com permissão para movimentar o estoque tem e-mail para receber o alerta',
  NAO_ENVIADO: 'Não foi possível enviar o alerta agora',
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

function lockDoAlerta(empresaId, atorId, solicitacaoId) {
  return crypto.createHash('sha256')
    .update(`${ESPACO_LOCK}\n${empresaId}\n${atorId}\n${solicitacaoId}`)
    .digest().readBigInt64BE(0).toString();
}

async function itensComFalta(client, { empresaId, solicitacaoId, hoje }) {
  const fila = await coberturaRepo.listarCobertura(client, empresaId, { hoje, solicitacaoId });
  const comFalta = fila.filter((i) => i.semCobertura > 0);
  if (comFalta.length === 0) return [];
  const nomes = await alertaRepo.nomesDosMateriais(client, { empresaId, materialIds: [...new Set(comFalta.map((i) => i.materialId))] });
  return comFalta.map((i) => ({
    material: nomes.get(i.materialId) ?? '', tamanho: i.tamanho, pendente: i.quantidadePendente, semCobertura: i.semCobertura,
  }));
}

async function enviar(servicoEmail, destinatarios, conteudo) {
  let alcancados = 0;
  for (const { email } of destinatarios) {
    const r = await servicoEmail.enviarAguardando({
      tipo: TIPO_EMAIL, escopo: ESCOPO_EMAIL, para: email, conteudo,
    });
    if (r && (r.estado === 'ENVIADO' || r.estado === 'GRAVADO')) alcancados += 1;
  }
  return alcancados;
}

/**
 * @returns {Promise<{destinatarios: number}>} quantos receberam
 * @throws {HttpError} 404 pedido fora da empresa; 409 não entregável, sem
 *   falta ou sem destinatário; 429 alerta recente do mesmo ator e pedido;
 *   503 nenhum envio saiu
 */
async function gerarAlertaFalta(pool, {
  empresaId, atorId, solicitacaoId, hoje, ip = null,
}, { servicoEmail = servicoPadrao(), urls = undefined, janelaSegundos = JANELA_SUPRESSAO_SEGUNDOS } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(solicitacaoId, 'identificador de solicitação');
  exigirDataOperacional(hoje);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDoAlerta(empresaId, atorId, solicitacaoId)]);

    const pedido = await alertaRepo.buscarPedido(client, { empresaId, solicitacaoId });
    if (pedido === null) throw HttpError.notFound('SOLICITACAO_NAO_ENCONTRADA', MSG.NAO_ENCONTRADA);
    if (!STATUS_ENTREGAVEIS.includes(pedido.status)) throw HttpError.conflict('SOLICITACAO_NAO_ENTREGAVEL', MSG.NAO_ENTREGAVEL);
    const itens = await itensComFalta(client, { empresaId, solicitacaoId, hoje });
    if (itens.length === 0) throw HttpError.conflict('SEM_FALTA_DE_ESTOQUE', MSG.SEM_FALTA);
    const referencia = String(solicitacaoId);
    if (await auditoriaRepo.existeRecente(client, {
      empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA, referencia, janelaSegundos,
    })) {
      throw HttpError.tooManyRequests('ALERTA_FALTA_RECENTE', MSG.RECENTE);
    }
    const destinatarios = await contasComAcao(client, empresaId, { acao: ACAO_ESTOQUE, exigirSst: false });
    if (destinatarios.length === 0) throw HttpError.conflict('ALERTA_SEM_DESTINATARIO', MSG.SEM_DESTINATARIO);

    const conteudo = templates.renderizar(TIPO_EMAIL, {
      empresa: (await alertaRepo.nomeDaEmpresa(client, empresaId)) ?? '',
      numero: pedido.numero,
      itens,
      link: links.linkMateriais(urls),
    });
    const alcancados = await enviar(servicoEmail, destinatarios, conteudo);
    if (alcancados === 0) throw new HttpError(503, 'ALERTA_NAO_ENVIADO', MSG.NAO_ENVIADO);

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA,
      referencia,
      ip,
      contexto: { solicitacaoId, itensSemCobertura: itens.length, destinatarios: alcancados },
    });
    await client.query('COMMIT');
    return { destinatarios: alcancados };
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    client.release();
  }
}

module.exports = { gerarAlertaFalta, JANELA_SUPRESSAO_SEGUNDOS };
