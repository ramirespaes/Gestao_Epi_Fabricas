'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const repo = require('../repositories/suporte.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const templates = require('../email/templates');
const { servicoPadrao } = require('../email/servico-email');
const { normalizarEmail } = require('../utils/normalizacao');

/**
 * Suporte no Portal Empresarial. Empresa, usuário, nome e e-mail do solicitante vêm SEMPRE da sessão (o schema estrito recusa
 * qualquer um deles no corpo); o destinatário dos contatos vem SEMPRE do cadastro da empresa da sessão (`emailAlmoxarifado` ou
 * `emailSst`), na hora do envio, e nunca é gravado nem devolvido ao cliente.
 *
 * CHAMADOS (suporte do sistema): gravados numa transação, com protocolo gerado pelo banco. A chave de idempotência do cliente
 * (UUID) com o hash do pedido impede o duplicado: repetir o mesmo pedido devolve o chamado já criado (`repetido: true`); a mesma
 * chave com outro conteúdo é 409. Só o próprio solicitante lê o chamado e as respostas; o de outro usuário, de outra empresa ou
 * inexistente é o mesmo 404.
 *
 * CONTATOS (Almoxarifado e SST): primeiro o registro (REGISTRADA, transacional e idempotente), depois UMA tentativa de envio
 * pelo serviço único de e-mail (nunca antes do COMMIT, nunca em duplicidade: só quem criou o registro envia). O resultado
 * persistido distingue o que aconteceu de fato: ENVIO_CONFIRMADO (o transporte confirmou), GRAVADO_EM_ARQUIVO (transporte de
 * desenvolvimento, não é entrega), NAO_ENVIADO (sem provedor configurado) e FALHA (só um código técnico). Sem fila durável: se o
 * processo cair entre o COMMIT e o envio, o registro fica REGISTRADA, que é exatamente o que a tela mostra; nada é afirmado sem
 * confirmação do transporte. Auditoria só com ids, protocolo, canal e situação: nunca assunto, mensagem, descrição ou e-mail.
 */

const ACAO = Object.freeze({
  CHAMADO: 'SUPORTE_CHAMADO_ABERTO',
  MENSAGEM: 'SUPORTE_CHAMADO_MENSAGEM',
  CONTATO: 'SUPORTE_CONTATO_REGISTRADO',
  ENVIO: 'SUPORTE_CONTATO_ENVIO',
});

const MSG = Object.freeze({
  CHAMADO_NAO_ENCONTRADO: 'Chamado não encontrado',
  CHAMADO_ENCERRADO: 'O chamado está encerrado. Abra um novo chamado ou aguarde a reabertura pelo suporte.',
  CHAVE_CONFLITO: 'Esta chave já foi usada com outro conteúdo. Recarregue a página e envie novamente.',
  SEM_DESTINATARIO: {
    ALMOXARIFADO: 'O e-mail do Almoxarifado ainda não foi cadastrado. Quem tem acesso a Dados da Empresa pode cadastrá-lo em Dados da Empresa.',
    SST: 'O e-mail da SST ainda não foi cadastrado. Quem tem acesso a Dados da Empresa pode cadastrá-lo em Dados da Empresa.',
  },
});

const SITUACAO_DO_TRANSPORTE = Object.freeze({ ENVIADO: 'ENVIO_CONFIRMADO', GRAVADO: 'GRAVADO_EM_ARQUIVO', NAO_ENVIADO: 'NAO_ENVIADO' });

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const hashDe = (...partes) => crypto.createHash('sha256').update(JSON.stringify(partes)).digest('hex');

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

function paginar({ pagina, limite }) {
  return { limite, deslocamento: (pagina - 1) * limite };
}

// ---------- Chamados ----------

async function abrirChamado(pool, {
  empresaId, usuarioId, solicitanteNome, solicitanteEmail, assunto, categoria, descricao, chave, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const requisicaoHash = hashDe(assunto, categoria, descricao);

  return emTransacao(pool, async (client) => {
    const criado = await repo.inserirChamado(client, {
      empresaId, usuarioId, assunto, categoria, descricao, solicitanteNome, solicitanteEmail, chave, requisicaoHash,
    });
    if (criado === null) {
      const existente = await repo.buscarChamadoPorChave(client, { empresaId, usuarioId, chave });
      if (existente === null || existente.requisicaoHash !== requisicaoHash) throw HttpError.conflict('CHAVE_IDEMPOTENCIA_CONFLITO', MSG.CHAVE_CONFLITO);
      const { requisicaoHash: _descartado, ...chamado } = existente;
      return { chamado, repetido: true };
    }
    await repo.inserirSituacao(client, { chamadoId: criado.id, anterior: null, nova: 'ABERTO', administradorId: null });
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId, acao: ACAO.CHAMADO, referencia: criado.protocolo, ip, dispositivo, contexto: { categoria, chamadoId: criado.id },
    });
    return { chamado: criado, repetido: false };
  });
}

async function listarMeusChamados(pool, { empresaId, usuarioId, pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const { itens, total } = await repo.listarDoUsuario(pool, { empresaId, usuarioId, ...paginar({ pagina, limite }) });
  return { itens, total, pagina, limite };
}

/** Indicador do menu: quantos chamados do usuário da sessão têm resposta do suporte não lida. Só lê; nunca marca como visto. */
async function contarNotificacoes(pool, { empresaId, usuarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const chamadosNaoLidos = await repo.contarChamadosComRespostaNaoLida(pool, { empresaId, usuarioId });
  return { chamadosNaoLidos };
}

/** Abrir o chamado é lê-lo: o lado do solicitante passa a "visto" e as mensagens do suporte deixam de contar como não lidas. */
async function detalharMeuChamado(pool, { empresaId, usuarioId, id }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const chamado = await repo.buscarDoUsuario(pool, { empresaId, usuarioId, id });
  if (chamado === null) throw HttpError.notFound('CHAMADO_NAO_ENCONTRADO', MSG.CHAMADO_NAO_ENCONTRADO);
  const [mensagens, historico] = await Promise.all([repo.listarMensagens(pool, chamado.id), repo.listarSituacoes(pool, chamado.id)]);
  await repo.marcarVisto(pool, { id: chamado.id, lado: 'SOLICITANTE' });
  return {
    chamado: { ...chamado, naoLidas: 0 }, mensagens, historico, respostas: mensagens.filter((m) => m.autor === 'SAFEWORK'),
  };
}

/** Conversa aberta: só as mensagens mais novas que `aposId` e a situação atual (o solicitante está lendo: visto). */
async function novasMensagensDoMeuChamado(pool, {
  empresaId, usuarioId, id, aposId = 0,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  const chamado = await repo.buscarDoUsuario(pool, { empresaId, usuarioId, id });
  if (chamado === null) throw HttpError.notFound('CHAMADO_NAO_ENCONTRADO', MSG.CHAMADO_NAO_ENCONTRADO);
  const mensagens = await repo.listarMensagens(pool, chamado.id, { aposId });
  if (mensagens.length > 0) await repo.marcarVisto(pool, { id: chamado.id, lado: 'SOLICITANTE' });
  return { situacao: chamado.situacao, encerradoEm: chamado.encerradoEm, mensagens };
}

/**
 * Mensagem do SOLICITANTE na conversa do próprio chamado. ENCERRADO não recebe mensagem (409; a reabertura é do
 * administrador). RESPONDIDO ou EM_ATENDIMENTO voltam a ABERTO (exige atendimento), com histórico. Idempotente pela
 * chave (a repetição devolve a mensagem já gravada, sem reabrir de novo). Auditoria só com ids e protocolo.
 */
async function enviarMensagem(pool, {
  empresaId, usuarioId, id, texto, chave, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirId(id, 'identificador de chamado');
  return emTransacao(pool, async (client) => {
    const chamado = await repo.buscarDoUsuario(client, { empresaId, usuarioId, id }, { paraAtualizacao: true });
    if (chamado === null) throw HttpError.notFound('CHAMADO_NAO_ENCONTRADO', MSG.CHAMADO_NAO_ENCONTRADO);
    const repetida = await repo.buscarMensagemPorChave(client, { chamadoId: id, chave });
    if (repetida !== null) return { mensagem: repetida, situacao: chamado.situacao, repetido: true };
    if (chamado.situacao === 'ENCERRADO') throw HttpError.conflict('CHAMADO_ENCERRADO', MSG.CHAMADO_ENCERRADO);
    const mensagem = await repo.inserirMensagem(client, {
      chamadoId: id, autorTipo: 'SOLICITANTE', usuarioEmpresaId: empresaId, usuarioId, texto, chave,
    });
    await repo.registrarMensagemEnviada(client, { id, lado: 'SOLICITANTE' });
    let situacao = chamado.situacao;
    if (situacao === 'RESPONDIDO' || situacao === 'EM_ATENDIMENTO') {
      situacao = 'ABERTO';
      await repo.atualizarSituacao(client, { id, situacao });
      await repo.inserirSituacao(client, { chamadoId: id, anterior: chamado.situacao, nova: situacao, administradorId: null });
    }
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId, acao: ACAO.MENSAGEM, referencia: chamado.protocolo, ip, dispositivo, contexto: { chamadoId: id, mensagemId: mensagem.id, situacao },
    });
    return { mensagem, situacao, repetido: false };
  });
}

// ---------- Contatos ----------

/** Estado dos canais para a tela: só se o e-mail está cadastrado, nunca o endereço. */
async function consultarCanais(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  const e = await repo.buscarEmailsDaEmpresa(pool, empresaId);
  if (e === null) throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');
  return { almoxarifado: { configurado: e.emailAlmoxarifado !== null }, sst: { configurado: e.emailSst !== null } };
}

const paraResposta = ({ requisicaoHash: _h, ...contato }) => ({ ...contato, entregaConfirmada: contato.situacaoEnvio === 'ENVIO_CONFIRMADO' });

/**
 * @param {{canal: 'ALMOXARIFADO'|'SST'}} dados
 * @returns {Promise<{contato: object, repetido: boolean}>}
 */
async function enviarContato(pool, {
  empresaId, usuarioId, solicitanteNome, solicitanteEmail, empresaNome, canal, assunto, mensagem, chave, ip = null, dispositivo = null,
}, { servicoEmail = servicoPadrao() } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  if (canal !== 'ALMOXARIFADO' && canal !== 'SST') throw new TypeError('canal inválido');
  const requisicaoHash = hashDe(canal, assunto, mensagem);

  // Repetição do mesmo pedido: devolve o registro existente sem enviar de novo e sem consultar o cadastro.
  const anterior = await repo.buscarContatoPorChave(pool, { empresaId, usuarioId, chave });
  if (anterior !== null) {
    if (anterior.requisicaoHash !== requisicaoHash) throw HttpError.conflict('CHAVE_IDEMPOTENCIA_CONFLITO', MSG.CHAVE_CONFLITO);
    return { contato: paraResposta(anterior), repetido: true };
  }

  const emails = await repo.buscarEmailsDaEmpresa(pool, empresaId);
  if (emails === null) throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');
  const bruto = canal === 'SST' ? emails.emailSst : emails.emailAlmoxarifado;
  const destinatario = bruto === null ? null : normalizarEmail(bruto);
  if (destinatario === null) throw HttpError.conflict('DESTINATARIO_NAO_CONFIGURADO', MSG.SEM_DESTINATARIO[canal]);

  const registro = await emTransacao(pool, async (client) => {
    const criado = await repo.inserirContato(client, {
      empresaId, usuarioId, canal, assunto, mensagem, chave, requisicaoHash,
    });
    if (criado !== null) {
      await auditoriaRepo.registrar(client, {
        empresaId, usuarioId, acao: ACAO.CONTATO, referencia: `${canal}:${criado.id}`, ip, dispositivo, contexto: { canal, contatoId: criado.id },
      });
    }
    return criado;
  });
  if (registro === null) {
    // Corrida: outro pedido idêntico gravou primeiro e é quem envia.
    const existente = await repo.buscarContatoPorChave(pool, { empresaId, usuarioId, chave });
    if (existente === null || existente.requisicaoHash !== requisicaoHash) throw HttpError.conflict('CHAVE_IDEMPOTENCIA_CONFLITO', MSG.CHAVE_CONFLITO);
    return { contato: paraResposta(existente), repetido: true };
  }

  const resultado = await tentarEnviar(servicoEmail, {
    canal, destinatario, empresaNome, solicitanteNome, solicitanteEmail, assunto, mensagem,
  });
  const situacaoEnvio = resultado.estado === 'FALHA' ? 'FALHA' : (SITUACAO_DO_TRANSPORTE[resultado.estado] ?? 'FALHA');
  const codigoFalha = situacaoEnvio === 'FALHA' ? (resultado.codigo ?? 'ERRO_DESCONHECIDO') : null;

  await emTransacao(pool, async (client) => {
    const atualizado = await repo.registrarResultadoEnvio(client, { id: registro.id, situacaoEnvio, codigoFalha });
    if (atualizado) {
      await auditoriaRepo.registrar(client, {
        empresaId, usuarioId, acao: ACAO.ENVIO, referencia: `${canal}:${registro.id}`, ip, dispositivo, contexto: { canal, contatoId: registro.id, situacaoEnvio },
      });
    }
  });
  return {
    contato: paraResposta({
      ...registro, situacaoEnvio, codigoFalha, tentativas: 1,
    }),
    repetido: false,
  };
}

/** Uma tentativa, sem lançar: qualquer erro do template ou do transporte vira FALHA com código técnico fixo. */
async function tentarEnviar(servicoEmail, {
  canal, destinatario, empresaNome, solicitanteNome, solicitanteEmail, assunto, mensagem,
}) {
  try {
    const conteudo = templates.renderizar(templates.TIPOS.CONTATO_SUPORTE, {
      canal, empresa: empresaNome, remetenteNome: solicitanteNome, remetenteEmail: solicitanteEmail, assunto, mensagem,
    });
    return await servicoEmail.enviarAguardando({
      tipo: templates.TIPOS.CONTATO_SUPORTE, escopo: 'PORTAL', para: destinatario, conteudo,
    });
  } catch {
    return { estado: 'FALHA', codigo: 'ENTRADA_INVALIDA' };
  }
}

module.exports = {
  abrirChamado, listarMeusChamados, contarNotificacoes, detalharMeuChamado, novasMensagensDoMeuChamado, enviarMensagem, consultarCanais, enviarContato, ACAO,
};
