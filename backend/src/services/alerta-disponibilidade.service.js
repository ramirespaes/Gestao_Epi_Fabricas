'use strict';

const coberturaRepo = require('../repositories/solicitacao-epi-cobertura.repository');
const alertaRepo = require('../repositories/alerta-estoque.repository');
const templates = require('../email/templates');
const links = require('../email/links');
const { contasComAcao } = require('./alerta-destinatarios');
const { alertasEstoqueConfig } = require('../config/alertas-estoque');
const { exigirDataOperacional } = require('../utils/data-operacional');

/**
 * Aviso automático de disponibilidade para entrega (12G-6): um RESUMO
 * OPERACIONAL da situação atual, não um histórico de transições.
 *
 * Disponibilidade continua derivada, e nada é gravado item a item. O que se
 * grava é só o PROCESSAMENTO do aviso (069):
 *
 *   na ENTRADA de estoque, na mesma transação e por último, a entrada é
 *   relevante quando faz algum item de solicitação passar de cobertura zero
 *   para positiva no par da entrada; aí abre ou estende o agendamento PENDENTE
 *   da empresa, que espera a janela depois da última entrada relevante. Antes
 *   e depois saem da MESMA leitura (antes = U menos a quantidade da entrada),
 *   sem trava de par: entradas do mesmo material já se enfileiram na trava do
 *   material;
 *
 *   o processador (script para cron externo, nunca timer no processo
 *   principal) reivindica os vencidos sem esperar por quem já os tem, mede de
 *   novo o que a empresa tem disponível para entrega agora e manda o resumo
 *   agregado por EPI + tamanho, sem trabalhador nem pedido (o detalhe é da
 *   tela Entregas por solicitação). O que segue disponível pode voltar a
 *   aparecer no resumo de uma janela seguinte: é aceito. Entrega pelo menos
 *   uma vez: só fica ENVIADO quando todos os destinatários da tentativa
 *   receberam; qualquer falha leva a nova tentativa, com os destinatários
 *   resolvidos de novo, e quem já recebeu pode receber outra vez.
 */

const TIPO_DISPONIBILIDADE = 'DISPONIBILIDADE_ESTOQUE_ENTREGA';
const ACAO_ENTREGA = 'REALIZAR_ENTREGA';
const ESCOPO_EMAIL = 'PORTAL';
// Espera antes da tentativa seguinte, em minutos; esgotadas, FALHA.
const ESPERAS_MINUTOS = Object.freeze([2, 5, 15, 30]);
const MAX_TENTATIVAS = ESPERAS_MINUTOS.length + 1;
const CONCESSAO_SEGUNDOS = 15 * 60;
const LIMITE_POR_EXECUCAO = 50;
const LIMITE_LINHAS_NO_EMAIL = 100;
const FORMATO_CODIGO = /^[A-Z][A-Z0-9_]{0,39}$/;

const CODIGOS = Object.freeze({
  SEM_DISPONIBILIDADE: 'SEM_DISPONIBILIDADE',
  SEM_DESTINATARIO: 'SEM_DESTINATARIO',
  EMAIL_DESATIVADO: 'EMAIL_DESATIVADO',
  ENVIO_INTERROMPIDO: 'ENVIO_INTERROMPIDO',
  FALHA_ENVIO: 'FALHA_ENVIO',
  ERRO_INTERNO: 'ERRO_INTERNO',
});

const registroPadrao = (etiqueta, campos) => { console.error(etiqueta, campos); };

const codigoSeguro = (codigo) => (typeof codigo === 'string' && FORMATO_CODIGO.test(codigo) ? codigo : CODIGOS.FALHA_ENVIO);

/**
 * Chamado pela entrada de estoque, dentro da transação dela, depois do lote e
 * da auditoria. Não grava nada do item; só trava a linha do agendamento
 * PENDENTE, por último.
 *
 * @returns {Promise<string|null>} id do agendamento, ou null se a entrada não é relevante
 */
async function agendarSeRelevante(client, {
  empresaId, materialId, tamanho, quantidade, hoje, janelaMinutos = alertasEstoqueConfig.janelaMinutos,
}) {
  const fila = await coberturaRepo.listarCoberturaDoPar(client, empresaId, { hoje, materialId, tamanho });
  if (fila.length === 0) return null;
  const fisicoAntes = Math.max(0, fila[0].fisicoUtilizavel - quantidade);
  const relevante = fila.some((f) => f.coberta > 0 && Math.min(f.quantidadePendente, Math.max(0, fisicoAntes - f.acumuladoAnterior)) === 0);
  if (!relevante) return null;
  return alertaRepo.agendar(client, { empresaId, tipo: TIPO_DISPONIBILIDADE, janelaSegundos: janelaMinutos * 60 });
}

/** Ativo, da empresa, com e-mail, vínculo SST e REALIZAR_ENTREGA efetiva. */
const resolverDestinatarios = (executor, empresaId) => contasComAcao(executor, empresaId, { acao: ACAO_ENTREGA, exigirSst: true });

const porTexto = (a, b) => (a ?? '').localeCompare(b ?? '', 'pt-BR');

// O que a empresa tem disponível para entrega agora, por EPI + tamanho, em ordem de EPI e tamanho.
async function resumoAtual(pool, empresaId, hoje) {
  const pares = await coberturaRepo.resumirCoberturaPorPar(pool, empresaId, { hoje });
  if (pares.length === 0) return [];
  const nomes = await alertaRepo.nomesDosMateriais(pool, { empresaId, materialIds: [...new Set(pares.map((p) => p.materialId))] });
  return pares
    .map((p) => ({
      material: nomes.get(p.materialId) ?? '', tamanho: p.tamanho, quantidade: p.coberta, pedidos: p.solicitacoes,
    }))
    .sort((a, b) => porTexto(a.material, b.material) || porTexto(a.tamanho, b.tamanho));
}

async function enviarATodos(servicoEmail, destinatarios, conteudo) {
  const resumo = { sucessos: 0, desativados: 0, codigoFalha: null };
  for (const { email } of destinatarios) {
    const r = await servicoEmail.enviarAguardando({
      tipo: TIPO_DISPONIBILIDADE, escopo: ESCOPO_EMAIL, para: email, conteudo,
    });
    if (r && (r.estado === 'ENVIADO' || r.estado === 'GRAVADO')) resumo.sucessos += 1;
    else if (r && r.estado === 'NAO_ENVIADO') resumo.desativados += 1;
    else if (resumo.codigoFalha === null) resumo.codigoFalha = codigoSeguro(r && r.codigo);
  }
  return resumo;
}

function desfechoDaFalha(agendamento, agora, codigo) {
  if (agendamento.tentativas >= MAX_TENTATIVAS) return { estado: 'FALHA', codigo };
  const espera = ESPERAS_MINUTOS[agendamento.tentativas - 1];
  return { estado: 'AGUARDANDO_RETRY', codigo, proximaTentativaEm: new Date(agora.getTime() + espera * 60_000) };
}

async function decidir(pool, agendamento, { agora, hoje, servicoEmail, urls }) {
  const { empresaId } = agendamento;
  const pares = await resumoAtual(pool, empresaId, hoje);
  if (pares.length === 0) return { estado: 'DESCARTADO', codigo: CODIGOS.SEM_DISPONIBILIDADE };
  const destinatarios = await resolverDestinatarios(pool, empresaId);
  if (destinatarios.length === 0) return { estado: 'DESCARTADO', codigo: CODIGOS.SEM_DESTINATARIO };

  const mostrados = pares.slice(0, LIMITE_LINHAS_NO_EMAIL);
  const conteudo = templates.renderizar(TIPO_DISPONIBILIDADE, {
    empresa: (await alertaRepo.nomeDaEmpresa(pool, empresaId)) ?? '',
    pares: mostrados,
    restantes: pares.length - mostrados.length,
    link: links.linkEntregasPorSolicitacao(urls),
  });
  const envio = await enviarATodos(servicoEmail, destinatarios, conteudo);
  if (envio.sucessos === destinatarios.length) {
    return { estado: 'ENVIADO', destinatariosAlcancados: envio.sucessos, linhasResumo: pares.length };
  }
  if (envio.desativados === destinatarios.length) return { estado: 'DESCARTADO', codigo: CODIGOS.EMAIL_DESATIVADO };
  return desfechoDaFalha(agendamento, agora, envio.codigoFalha ?? CODIGOS.FALHA_ENVIO);
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultado = await operacao(client);
    await client.query('COMMIT');
    return resultado;
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    client.release();
  }
}

const concluirEmTransacao = (pool, agendamento, agora, desfecho) => emTransacao(pool, (client) => alertaRepo.concluir(client, {
  empresaId: agendamento.empresaId,
  agendamentoId: agendamento.id,
  reivindicadoEm: agendamento.reivindicadoEm,
  agora,
  estado: desfecho.estado,
  codigo: desfecho.codigo ?? null,
  proximaTentativaEm: desfecho.proximaTentativaEm ?? null,
  destinatariosAlcancados: desfecho.destinatariosAlcancados ?? null,
  linhasResumo: desfecho.linhasResumo ?? null,
}));

async function processarUm(pool, agendamento, contexto) {
  let desfecho;
  try {
    desfecho = await decidir(pool, agendamento, contexto);
  } catch (erro) {
    contexto.registrar('[alertas-estoque]', { evento: 'processamento_falhou', agendamentoId: agendamento.id, motivo: erro && erro.name });
    desfecho = desfechoDaFalha(agendamento, contexto.agora, CODIGOS.ERRO_INTERNO);
  }
  const concluido = await concluirEmTransacao(pool, agendamento, contexto.agora, desfecho);
  return {
    agendamentoId: agendamento.id, empresaId: agendamento.empresaId, estado: concluido ? desfecho.estado : 'REIVINDICACAO_PERDIDA', codigo: desfecho.codigo ?? null,
  };
}

/**
 * Processa os agendamentos vencidos. Cada um é concluído na sua própria
 * transação; o erro de um não para os outros.
 *
 * @param {{agora?: Date, hoje: string, servicoEmail: {enviarAguardando: Function}, limite?: number, urls?: object, registrar?: Function}} opcoes
 */
async function processarVencidos(pool, {
  agora = new Date(), hoje, servicoEmail, limite = LIMITE_POR_EXECUCAO, urls = undefined, registrar = registroPadrao,
}) {
  exigirDataOperacional(hoje);
  if (!servicoEmail || typeof servicoEmail.enviarAguardando !== 'function') throw new TypeError('serviço de e-mail inválido');
  const parametros = { agora, concessaoSegundos: CONCESSAO_SEGUNDOS, maxTentativas: MAX_TENTATIVAS };
  const abandonados = await alertaRepo.encerrarAbandonados(pool, { ...parametros, codigo: CODIGOS.ENVIO_INTERROMPIDO });
  const reivindicados = await emTransacao(pool, (client) => alertaRepo.reivindicarVencidos(client, { ...parametros, limite }));
  const processados = [];
  for (const agendamento of reivindicados) {
    processados.push(await processarUm(pool, agendamento, {
      agora, hoje, servicoEmail, urls, registrar,
    }));
  }
  return { processados, abandonados };
}

module.exports = {
  TIPO_DISPONIBILIDADE,
  MAX_TENTATIVAS,
  ESPERAS_MINUTOS,
  CODIGOS,
  agendarSeRelevante,
  resolverDestinatarios,
  processarVencidos,
};
