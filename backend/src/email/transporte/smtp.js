'use strict';

const nodemailer = require('nodemailer');
const { normalizarEmail } = require('../../utils/normalizacao');
const { ErroEntrega, erroDeRede } = require('../erros');
const { marca, CID_MARCA } = require('../marca');

/**
 * Transporte SMTP sobre o nodemailer, endurecido:
 *   - STARTTLS exige TLS de verdade (requireTLS), sem downgrade; TLS implícito
 *     usa secure. O certificado é sempre validado: não há como afrouxar.
 *     Sem TLS só existe no modo `nenhuma`, que a configuração recusa em production;
 *   - o nodemailer nunca lê arquivo nem busca URL (disableFileAccess e
 *     disableUrlAccess na conexão e na mensagem), nunca recebe `path` e não
 *     liga logger nem debug (o transcrito SMTP traz credencial e destinatário);
 *   - destinatário e assunto são validados aqui, antes do transporte; o
 *     destinatário vai também num envelope explícito;
 *   - o erro do provedor nunca sai: só um código de uma lista conhecida.
 */

const MAX_CONEXOES = 2;
const MAX_MENSAGENS_POR_CONEXAO = 50;
const TAMANHO_MAXIMO_ASSUNTO = 200;

function opcoesDeConexao(smtp) {
  const opcoes = {
    host: smtp.host,
    port: smtp.porta,
    secure: smtp.seguranca === 'tls',
    connectionTimeout: smtp.timeoutMs,
    greetingTimeout: smtp.timeoutMs,
    socketTimeout: smtp.timeoutMs,
    dnsTimeout: smtp.timeoutMs,
    pool: true,
    maxConnections: MAX_CONEXOES,
    maxMessages: MAX_MENSAGENS_POR_CONEXAO,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
  if (smtp.seguranca === 'nenhuma') {
    opcoes.ignoreTLS = true;
  } else {
    opcoes.requireTLS = smtp.seguranca === 'starttls';
    opcoes.tls = { rejectUnauthorized: true, minVersion: 'TLSv1.2' };
  }
  if (smtp.usuario !== null) {
    opcoes.auth = { user: smtp.usuario, pass: smtp.senha };
  }
  return opcoes;
}

function assuntoValido(assunto) {
  return typeof assunto === 'string' && assunto !== '' && assunto.length <= TAMANHO_MAXIMO_ASSUNTO && !/[\r\n]/.test(assunto);
}

function criarSmtp(config, { criarTransporteNodemailer = nodemailer.createTransport } = {}) {
  if (!config || config.modo !== 'smtp' || !config.smtp) {
    throw new TypeError('configuração SMTP ausente');
  }
  const { remetente } = config;
  const transportador = criarTransporteNodemailer(opcoesDeConexao(config.smtp));

  return {
    modo: 'smtp',
    async enviar({ para, assunto, texto, html }) {
      const destinatario = normalizarEmail(para);
      if (destinatario === null) throw new ErroEntrega('DESTINATARIO_INVALIDO');
      if (!assuntoValido(assunto)) throw new ErroEntrega('ASSUNTO_INVALIDO');
      if (typeof texto !== 'string' || typeof html !== 'string') throw new ErroEntrega('ENTRADA_INVALIDA');

      const m = marca();
      const mensagem = {
        from: { name: remetente.nome, address: remetente.endereco },
        to: destinatario,
        envelope: { from: remetente.endereco, to: [destinatario] },
        subject: assunto,
        text: texto,
        html,
        attachments: html.includes(`cid:${CID_MARCA}`)
          ? [{ filename: m.filename, content: m.content, cid: m.cid, contentType: m.contentType, contentDisposition: 'inline' }]
          : [],
        disableFileAccess: true,
        disableUrlAccess: true,
      };

      let resposta;
      try {
        resposta = await transportador.sendMail(mensagem);
      } catch (erro) {
        throw erroDeRede(erro);
      }
      if (resposta && Array.isArray(resposta.rejected) && resposta.rejected.length > 0) {
        throw new ErroEntrega('EENVELOPE');
      }
      return { estado: 'ENVIADO' };
    },
    fechar() {
      transportador.close();
    },
  };
}

module.exports = { criarSmtp };
