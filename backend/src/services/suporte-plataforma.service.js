'use strict';

const { HttpError } = require('../errors/HttpError');
const repo = require('../repositories/suporte.repository');
const auditoriaPlataformaRepo = require('../repositories/auditoria-plataforma.repository');

/**
 * Atendimento dos chamados de suporte pelo Painel Privado. Autoridade da PLATAFORMA (sessão administrativa, nunca a empresarial):
 * quem chama só chega aqui atrás de exigirSessaoPlataforma e o administrador vem sempre dela, nunca do corpo.
 *
 * Conversa (093): resposta do suporte e mensagem do solicitante vivem na mesma tabela; uma mensagem do solicitante devolve o
 * chamado a ABERTO (ver suporte.service). ENCERRADO só sai para ABERTO, por reabertura explícita do administrador (auditada).
 *
 * Situações: ABERTO | EM_ATENDIMENTO | RESPONDIDO | ENCERRADO. ENCERRADO é final para mensagens: um chamado encerrado não recebe resposta nem
 * muda de situação. Responder grava a resposta e leva o chamado a RESPONDIDO; qualquer outra mudança é explícita. Cada ato trava a
 * linha do chamado (FOR UPDATE), então resposta e mudança de situação concorrentes se serializam e o histórico nunca fica
 * incoerente. Respostas e histórico são append-only (gatilhos da 092).
 *
 * Auditoria da plataforma: ids, protocolo e situações; nunca o texto da descrição ou da resposta.
 */

const ACAO = Object.freeze({ RESPOSTA: 'SUPORTE_CHAMADO_RESPONDIDO', SITUACAO: 'SUPORTE_CHAMADO_SITUACAO_ALTERADA' });
const MSG = Object.freeze({
  NAO_ENCONTRADO: 'Chamado não encontrado',
  ENCERRADO: 'O chamado está encerrado e não pode mais ser alterado',
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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

async function listar(pool, {
  situacao = null, empresaId = null, busca = null, naoLidas = false, pagina, limite,
}) {
  const { itens, total } = await repo.listarPlataforma(pool, {
    situacao, empresaId, busca, naoLidas, limite, deslocamento: (pagina - 1) * limite,
  });
  return { itens, total, pagina, limite };
}

/** Abrir o chamado é lê-lo: o lado do suporte passa a "visto". */
async function detalhar(pool, { id }) {
  exigirId(id, 'identificador de chamado');
  const chamado = await repo.buscarPlataforma(pool, id);
  if (chamado === null) throw HttpError.notFound('CHAMADO_NAO_ENCONTRADO', MSG.NAO_ENCONTRADO);
  const [mensagens, historico] = await Promise.all([repo.listarMensagens(pool, id), repo.listarSituacoes(pool, id)]);
  await repo.marcarVisto(pool, { id, lado: 'SUPORTE' });
  return {
    chamado: { ...chamado, naoLidas: 0 }, mensagens, historico, respostas: mensagens.filter((m) => m.autor === 'SAFEWORK'),
  };
}

/** Conversa aberta: só as mensagens mais novas que `aposId` e a situação atual. */
async function novasMensagens(pool, { id, aposId = 0 }) {
  exigirId(id, 'identificador de chamado');
  const chamado = await repo.buscarPlataforma(pool, id);
  if (chamado === null) throw HttpError.notFound('CHAMADO_NAO_ENCONTRADO', MSG.NAO_ENCONTRADO);
  const mensagens = await repo.listarMensagens(pool, id, { aposId });
  if (mensagens.length > 0) await repo.marcarVisto(pool, { id, lado: 'SUPORTE' });
  return { situacao: chamado.situacao, encerradoEm: chamado.encerradoEm, mensagens };
}

async function travar(client, id, { permitirEncerrado = false } = {}) {
  const chamado = await repo.buscarPlataforma(client, id, { paraAtualizacao: true });
  if (chamado === null) throw HttpError.notFound('CHAMADO_NAO_ENCONTRADO', MSG.NAO_ENCONTRADO);
  if (chamado.situacao === 'ENCERRADO' && !permitirEncerrado) throw HttpError.conflict('CHAMADO_ENCERRADO', MSG.ENCERRADO);
  return chamado;
}

/** Mensagem do SUPORTE na conversa; o chamado passa a RESPONDIDO. Idempotente pela chave (opcional). */
async function responder(pool, {
  administradorId, id, texto, chave = null, ip = null, dispositivo = null,
}) {
  exigirId(administradorId, 'identificador de administrador');
  exigirId(id, 'identificador de chamado');
  return emTransacao(pool, async (client) => {
    const chamado = await travar(client, id);
    if (chave !== null) {
      const repetida = await repo.buscarMensagemPorChave(client, { chamadoId: id, chave });
      if (repetida !== null) return { resposta: repetida, mensagem: repetida, situacao: chamado.situacao, repetido: true };
    }
    const resposta = await repo.inserirMensagem(client, {
      chamadoId: id, autorTipo: 'SAFEWORK', administradorId, texto, chave,
    });
    await repo.registrarMensagemEnviada(client, { id, lado: 'SUPORTE' });
    if (chamado.situacao !== 'RESPONDIDO') {
      await repo.atualizarSituacao(client, { id, situacao: 'RESPONDIDO' });
      await repo.inserirSituacao(client, { chamadoId: id, anterior: chamado.situacao, nova: 'RESPONDIDO', administradorId });
    }
    await auditoriaPlataformaRepo.registrar(client, {
      administradorId,
      empresaAfetadaId: chamado.empresa.id,
      acao: ACAO.RESPOSTA,
      referencia: chamado.protocolo,
      ip,
      dispositivo,
      contexto: { chamadoId: id, respostaId: resposta.id, situacaoAnterior: chamado.situacao },
    });
    return { resposta, mensagem: resposta, situacao: 'RESPONDIDO', repetido: false };
  });
}

async function alterarSituacao(pool, {
  administradorId, id, situacao, ip = null, dispositivo = null,
}) {
  exigirId(administradorId, 'identificador de administrador');
  exigirId(id, 'identificador de chamado');
  return emTransacao(pool, async (client) => {
    // ENCERRADO só sai para ABERTO (reabertura autorizada pelo administrador); qualquer outra mudança continua 409.
    const chamado = await travar(client, id, { permitirEncerrado: situacao === 'ABERTO' });
    if (chamado.situacao === situacao) return { situacao, alterado: false };
    await repo.atualizarSituacao(client, { id, situacao });
    await repo.inserirSituacao(client, { chamadoId: id, anterior: chamado.situacao, nova: situacao, administradorId });
    await auditoriaPlataformaRepo.registrar(client, {
      administradorId,
      empresaAfetadaId: chamado.empresa.id,
      acao: ACAO.SITUACAO,
      referencia: chamado.protocolo,
      ip,
      dispositivo,
      contexto: { chamadoId: id, ...(chamado.situacao === 'ENCERRADO' ? { reabertura: true } : {}) },
      dadosAnteriores: { situacao: chamado.situacao },
      dadosNovos: { situacao },
    });
    return { situacao, alterado: true };
  });
}

module.exports = {
  listar, detalhar, novasMensagens, responder, alterarSituacao, ACAO,
};
