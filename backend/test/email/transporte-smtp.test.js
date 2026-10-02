'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { assertSemSensiveis } = require('../helpers/sensiveis');

/**
 * Transporte SMTP (Bloco 11H) sobre o nodemailer. Aqui o nodemailer é
 * substituído por uma fábrica falsa para provar as opções endurecidas e a
 * mensagem montada; o comportamento em rede (STARTTLS sem downgrade, timeout,
 * entrega) está em transporte-smtp-rede.test.js.
 */

const smtp = () => exigirModulo('src/email/transporte/smtp');
const carregarConfig = (env) => exigirModulo('src/config/email').carregarConfigEmail(env);

const SENHA = 'senhaSmtpFicticiaParaTeste42';
const USUARIO = 'usuarioSmtpFicticio';
const HOST = 'smtp.exemplo-provedor.test';
const EMAIL = 'pessoa.destinataria@example.invalid';
const BASE = { EMAIL_MODO: 'smtp', SMTP_HOST: HOST, SMTP_USUARIO: USUARIO, SMTP_SENHA: SENHA };

function fabricaFalsa(resposta = async (m) => ({ accepted: [m.envelope.to[0]], rejected: [] })) {
  const registro = { opcoes: null, mensagens: [], fechados: 0 };
  const fabrica = (opcoes) => {
    registro.opcoes = opcoes;
    return {
      sendMail: async (m) => { registro.mensagens.push(m); return resposta(m); },
      close() { registro.fechados += 1; },
    };
  };
  return { fabrica, registro };
}

const montar = (env = BASE, resposta) => {
  const { fabrica, registro } = fabricaFalsa(resposta);
  const config = carregarConfig(env);
  const transporte = smtp().criarSmtp(config, { criarTransporteNodemailer: fabrica });
  return { transporte, registro, config };
};

const mensagem = (extra = {}) => ({
  tipo: 'CONVITE_USUARIO',
  escopo: 'PORTAL',
  para: EMAIL,
  assunto: 'Convite para acessar o Portal do Cliente — SafeWork Engenharia',
  texto: 'texto',
  html: '<html><body><img src="cid:marca-safework"></body></html>',
  ...extra,
});

describe('opções do nodemailer', () => {
  test('STARTTLS exige TLS de verdade, valida o certificado e não tem como afrouxar', () => {
    const { registro } = montar();
    const o = registro.opcoes;
    assert.equal(o.host, HOST);
    assert.equal(o.port, 587);
    assert.equal(o.secure, false);
    assert.equal(o.requireTLS, true);
    assert.notEqual(o.ignoreTLS, true);
    assert.equal(o.tls.rejectUnauthorized, true);
    assert.equal(o.tls.minVersion, 'TLSv1.2');
    assert.deepEqual(o.auth, { user: USUARIO, pass: SENHA });
  });

  test('TLS implícito: secure verdadeiro, certificado validado', () => {
    const { registro } = montar({ ...BASE, SMTP_PORTA: '465', SMTP_SEGURANCA: 'tls' });
    const o = registro.opcoes;
    assert.equal(o.port, 465);
    assert.equal(o.secure, true);
    assert.equal(o.tls.rejectUnauthorized, true);
    assert.notEqual(o.ignoreTLS, true);
  });

  test('sem TLS só existe fora de production (captador local), sem autenticação e sem opção de certificado', () => {
    const { registro } = montar({ EMAIL_MODO: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORTA: '1025', SMTP_SEGURANCA: 'nenhuma' });
    const o = registro.opcoes;
    assert.equal(o.ignoreTLS, true);
    assert.equal(o.secure, false);
    assert.equal(o.requireTLS, undefined);
    assert.equal(o.auth, undefined);
    assert.equal(o.tls, undefined);
  });

  test('nenhuma configuração de TLS aceita rejectUnauthorized falso, em nenhum modo', () => {
    for (const extra of [{}, { SMTP_PORTA: '465', SMTP_SEGURANCA: 'tls' }]) {
      const { registro } = montar({ ...BASE, ...extra });
      assert.equal(registro.opcoes.tls.rejectUnauthorized, true);
      assert.doesNotMatch(JSON.stringify(registro.opcoes), /"rejectUnauthorized":false/);
    }
  });

  test('timeouts da configuração, pool pequeno e acesso a arquivo e a URL desligados, sem logger nem debug', () => {
    const { registro } = montar({ ...BASE, SMTP_TIMEOUT_MS: '7000' });
    const o = registro.opcoes;
    assert.equal(o.connectionTimeout, 7000);
    assert.equal(o.greetingTimeout, 7000);
    assert.equal(o.socketTimeout, 7000);
    assert.equal(o.pool, true);
    assert.equal(o.maxConnections, 2);
    assert.equal(o.disableFileAccess, true);
    assert.equal(o.disableUrlAccess, true);
    assert.equal(o.logger, false);
    assert.equal(o.debug, false);
    assert.notEqual(o.attachDataUrls, true);
  });

  test('a fábrica real do nodemailer não é chamada quando se injeta outra, e fechar fecha o pool', () => {
    const { transporte, registro } = montar();
    transporte.fechar();
    assert.equal(registro.fechados, 1);
  });
});

describe('mensagem entregue ao nodemailer', () => {
  test('remetente com nome, destinatário normalizado, envelope explícito e nenhum cabeçalho extra', async () => {
    const { transporte, registro } = montar();
    const r = await transporte.enviar(mensagem());
    assert.deepEqual(r, { estado: 'ENVIADO' });
    const [m] = registro.mensagens;
    assert.deepEqual(m.from, { name: 'SafeWork Engenharia', address: 'no-reply@safeworkengenharia.com.br' });
    assert.equal(m.to, EMAIL);
    assert.deepEqual(m.envelope, { from: 'no-reply@safeworkengenharia.com.br', to: [EMAIL] });
    assert.equal(m.subject, mensagem().assunto);
    assert.equal(m.text, 'texto');
    for (const proibida of ['replyTo', 'cc', 'bcc', 'headers', 'list', 'sender', 'inReplyTo', 'references', 'attachDataUrls', 'icalEvent', 'alternatives', 'watchHtml', 'amp']) {
      assert.equal(proibida in m, false, proibida);
    }
    assert.equal(m.disableFileAccess, true);
    assert.equal(m.disableUrlAccess, true);
  });

  test('a marca vai como Buffer inline com CID: nunca um caminho nem uma URL', async () => {
    const { transporte, registro } = montar();
    await transporte.enviar(mensagem());
    const [m] = registro.mensagens;
    assert.equal(m.attachments.length, 1);
    const [anexo] = m.attachments;
    assert.equal(Buffer.isBuffer(anexo.content), true);
    assert.equal(anexo.cid, 'marca-safework');
    assert.equal(anexo.contentDisposition, 'inline');
    assert.equal(anexo.contentType, 'image/png');
    for (const campo of ['path', 'href', 'raw', 'encoding']) assert.equal(campo in anexo, false, campo);
    assert.equal(typeof m.html, 'string');
  });

  test('sem referência à marca no HTML, nenhum anexo é enviado', async () => {
    const { transporte, registro } = montar();
    await transporte.enviar(mensagem({ html: '<html><body>sem imagem</body></html>' }));
    assert.deepEqual(registro.mensagens[0].attachments, []);
  });

  test('destinatário e assunto são validados antes de tocar o transporte', async () => {
    const { transporte, registro } = montar();
    for (const para of ['sem-arroba', 'a@b.test\r\nBcc: x@y.test', 'dois@a.test,tres@b.test', 'Nome <a@b.test>', '', null, 42]) {
      await assert.rejects(() => transporte.enviar(mensagem({ para })), (e) => e.codigo === 'DESTINATARIO_INVALIDO', JSON.stringify(para));
    }
    for (const assunto of ['com\nquebra', 'com\rquebra', '', null]) {
      await assert.rejects(() => transporte.enviar(mensagem({ assunto })), (e) => e.codigo === 'ASSUNTO_INVALIDO', JSON.stringify(assunto));
    }
    assert.deepEqual(registro.mensagens, []);
  });

  test('o destinatário é normalizado (caixa e espaços) antes de seguir', async () => {
    const { transporte, registro } = montar();
    await transporte.enviar(mensagem({ para: '  Pessoa.Destinataria@Example.Invalid ' }));
    assert.equal(registro.mensagens[0].to, EMAIL);
  });
});

describe('erros do provedor', () => {
  const falhar = (props) => async () => { throw Object.assign(new Error(`535 5.7.8 ${EMAIL} recusado por ${HOST} ${SENHA}`), props); };

  test('viram um erro seguro: só o código, sem resposta do servidor, destinatário, host nem credencial', async () => {
    const { transporte } = montar(BASE, falhar({ code: 'EAUTH', response: `535 ${EMAIL} ${HOST}`, command: 'AUTH PLAIN', responseCode: 535 }));
    await assert.rejects(() => transporte.enviar(mensagem()), (erro) => {
      assert.equal(erro.name, 'ErroEntrega');
      assert.equal(erro.codigo, 'EAUTH');
      const texto = `${erro.message} ${JSON.stringify(erro)} ${util.inspect(erro, { depth: 5 })} ${erro.stack}`;
      assertSemSensiveis(texto, [EMAIL, HOST, SENHA, USUARIO, '535'], 'erro de entrega');
      assert.equal('cause' in erro, false);
      return true;
    });
  });

  test('código desconhecido ou fora do formato vira ERRO_DESCONHECIDO', async () => {
    for (const code of [undefined, 'E<script>', 'minusculo', 'X'.repeat(60), 42]) {
      const { transporte } = montar(BASE, falhar({ code }));
      await assert.rejects(() => transporte.enviar(mensagem()), (e) => e.codigo === 'ERRO_DESCONHECIDO', String(code));
    }
  });

  test('códigos conhecidos do nodemailer passam como vieram', async () => {
    for (const code of ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EENVELOPE', 'EMESSAGE', 'ETLS', 'EDNS']) {
      const { transporte } = montar(BASE, falhar({ code }));
      await assert.rejects(() => transporte.enviar(mensagem()), (e) => e.codigo === code, code);
    }
  });
});
