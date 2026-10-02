'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const recuperacao = require('../../src/services/recuperacao-senha.service');
const entregaRecuperacao = require('../../src/services/entrega-recuperacao-senha.service');
const { criarServicoEmail } = require('../../src/email/servico-email');
const { criarSmtp } = require('../../src/email/transporte/smtp');
const { carregarConfigEmail } = require('../../src/config/email');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const redefinicaoRepo = require('../../src/repositories/redefinicao-senha.repository');
const solicitacaoRepo = require('../../src/repositories/recuperacao-senha-solicitacao.repository');
const auditoriaIdentidadeRepo = require('../../src/repositories/auditoria-identidade.repository');
const token = require('../../src/security/token');

/**
 * A recuperação de senha ligada à fila REAL de e-mail (Bloco 11H), com o
 * transporte falhando de formas diferentes. A resposta pública é a mesma de
 * quando o e-mail sai, o contador persistente de solicitações não devolve
 * nada por falha de entrega, e nem destinatário, token, link ou texto do
 * provedor chegam ao log. O banco, os repositórios e o nodemailer são
 * substituídos; a fila, o limite de tempo, o transporte SMTP e a tradução do
 * erro do provedor são os verdadeiros.
 */

const SENHA_SMTP = 'senhaSmtpFicticiaParaTeste42';
const USUARIO_SMTP = 'usuarioSmtpFicticio';
const EMAIL = 'pessoa.destinataria@example.invalid';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const RESPOSTA = { status: 'SOLICITACAO_RECEBIDA' };
const EXPIRA = new Date('2026-10-02T13:00:00.000Z');
const TEXTO_DO_PROVEDOR = '550 5.1.1 pessoa.destinataria@example.invalid: Recipient address rejected (smtp-relay-interno.example.net)';
const SUPORTE = 'suporte@safeworkengenharia.com.br';

const FRAGMENTOS_SENSIVEIS = [
  TOKEN, EMAIL, 'pessoa.destinataria', '#token=', 'redefinir-senha', 'smtp-relay-interno', 'Recipient address rejected', SENHA_SMTP, USUARIO_SMTP,
];

const aceita = async (mensagem) => ({ accepted: [mensagem.envelope.to[0]], rejected: [] });

function mundo(t, { enviar, opcoesDoServico = {} }) {
  const registrosDaFila = [];
  const consoleCapturado = [];
  for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, metodo, (...argumentos) => { consoleCapturado.push(JSON.stringify(argumentos)); });
  }

  const sendMail = t.mock.fn(enviar);
  const configEmail = carregarConfigEmail({
    EMAIL_MODO: 'smtp', SMTP_HOST: 'smtp.exemplo-provedor.test', SMTP_USUARIO: USUARIO_SMTP, SMTP_SENHA: SENHA_SMTP,
  });
  const transporte = criarSmtp(configEmail, { criarTransporteNodemailer: () => ({ sendMail, close() {} }) });
  const servico = criarServicoEmail({
    transporte, registrar: (etiqueta, campos) => { registrosDaFila.push(JSON.stringify([etiqueta, campos])); }, ...opcoesDoServico,
  });
  const instancia = entregaRecuperacao.criarEntrega({ config: { modo: 'smtp', suporte: SUPORTE }, servico });
  t.mock.method(entregaRecuperacao, 'enfileirarRedefinicao', instancia.enfileirarRedefinicao);

  let registradas = 0;
  const contarRecentes = t.mock.method(solicitacaoRepo, 'contarRecentes', async () => registradas);
  const registrar = t.mock.method(solicitacaoRepo, 'registrar', async () => { registradas += 1; return '901'; });
  t.mock.method(identidadeRepo, 'buscarPorEmail', async () => ({ id: 7, email: EMAIL, ativo: true }));
  t.mock.method(identidadeRepo, 'buscarPorIdParaAtualizacao', async () => ({ id: 7, email: EMAIL, ativo: true }));
  t.mock.method(redefinicaoRepo, 'criar', async () => ({ id: '501', expiraEm: EXPIRA, substituidos: 0 }));
  t.mock.method(auditoriaIdentidadeRepo, 'registrarEventoSistema', async () => ({ id: '1' }));
  t.mock.method(token, 'gerarTokenSessao', () => TOKEN);

  const cliente = { query: async () => ({ rows: [], rowCount: 0 }), release: () => {} };
  const pool = { connect: async () => cliente };
  const solicitar = () => recuperacao.solicitar(pool, {
    escopo: 'PORTAL', email: EMAIL, ip: '203.0.113.7', dispositivo: 'Agente de Teste',
  });

  const semSensiveis = () => {
    const texto = [...registrosDaFila, ...consoleCapturado].join('\n');
    for (const fragmento of FRAGMENTOS_SENSIVEIS) {
      assert.equal(texto.includes(fragmento), false, `o registro contém "${fragmento}"`);
    }
  };

  return {
    servico, sendMail, registrosDaFila, consoleCapturado, contarRecentes, registrar, solicitar, semSensiveis,
  };
}

const falhaSmtp = () => Object.assign(new Error(TEXTO_DO_PROVEDOR), { code: 'EENVELOPE', response: TEXTO_DO_PROVEDOR, command: `RCPT TO:<${EMAIL}>` });

async function semRejeicaoSolta(operacao) {
  const rejeicoes = [];
  const ouvinte = (motivo) => { rejeicoes.push(motivo); };
  process.on('unhandledRejection', ouvinte);
  try {
    await operacao();
    await new Promise((resolver) => { setImmediate(resolver); });
    await new Promise((resolver) => { setImmediate(resolver); });
    assert.deepEqual(rejeicoes, []);
  } finally {
    process.off('unhandledRejection', ouvinte);
  }
}

describe('falha do provedor SMTP', () => {
  test('a resposta pública é a mesma, o pedido fica gravado e o registro técnico só leva evento, tipo, escopo e código', async (t) => {
    const m = mundo(t, { enviar: async () => { throw falhaSmtp(); } });
    await semRejeicaoSolta(async () => {
      assert.deepEqual(await m.solicitar(), RESPOSTA);
      const { pendentes } = await m.servico.aguardarOciosidade(2000);
      assert.equal(pendentes, 0);
    });
    assert.equal(m.sendMail.mock.calls.length, 1);
    assert.equal(m.registrar.mock.calls.length, 1, 'a solicitação continua registrada');
    assert.equal(m.registrosDaFila.length, 1);
    assert.deepEqual(JSON.parse(m.registrosDaFila[0])[1], {
      evento: 'entrega_falhou', tipo: 'RECUPERACAO_SENHA', escopo: 'PORTAL', codigo: 'EENVELOPE',
    });
    m.semSensiveis();
  });

  test('o corpo da resposta é byte a byte o do caso em que o e-mail sai', async (t) => {
    const bom = mundo(t, { enviar: aceita });
    const referencia = JSON.stringify(await bom.solicitar());
    await bom.servico.aguardarOciosidade(2000);
    t.mock.restoreAll();

    const ruim = mundo(t, { enviar: async () => { throw falhaSmtp(); } });
    assert.equal(JSON.stringify(await ruim.solicitar()), referencia);
    await ruim.servico.aguardarOciosidade(2000);
  });

  test('erro desconhecido do provedor vira código genérico, sem a mensagem original', async (t) => {
    const m = mundo(t, { enviar: async () => { throw new Error(`falha estranha com ${EMAIL} e ${TOKEN}`); } });
    assert.deepEqual(await m.solicitar(), RESPOSTA);
    await m.servico.aguardarOciosidade(2000);
    assert.equal(m.registrosDaFila.length, 1);
    assert.match(JSON.parse(m.registrosDaFila[0])[1].codigo, /^[A-Z][A-Z0-9_]{0,39}$/);
    m.semSensiveis();
  });
});

describe('transporte que trava (timeout)', () => {
  test('a resposta não espera o envio; ao estourar o limite o código é ETIMEDOUT e nada sensível é registrado', async (t) => {
    let liberar;
    const trava = new Promise((resolver) => { liberar = resolver; });
    let terminou = false;
    const m = mundo(t, { enviar: async (mensagem) => { await trava; terminou = true; return aceita(mensagem); }, opcoesDoServico: { limiteEnvioMs: 40 } });

    assert.deepEqual(await m.solicitar(), RESPOSTA);
    assert.equal(terminou, false, 'a resposta voltou com o envio ainda pendente');

    const { pendentes } = await m.servico.aguardarOciosidade(3000);
    assert.equal(pendentes, 0, 'o limite de tempo libera a fila mesmo com o transporte preso');
    assert.equal(JSON.parse(m.registrosDaFila[0])[1].codigo, 'ETIMEDOUT');
    m.semSensiveis();
    liberar();
  });
});

describe('fila cheia', () => {
  test('o excedente é descartado e contado, a resposta pública segue idêntica e o registro de fila cheia sai uma vez, sem dado sensível', async (t) => {
    let liberar;
    const trava = new Promise((resolver) => { liberar = resolver; });
    const m = mundo(t, { enviar: async (mensagem) => { await trava; return aceita(mensagem); }, opcoesDoServico: { filaMaxima: 1, concorrencia: 1 } });

    const respostas = [await m.solicitar(), await m.solicitar(), await m.solicitar()];
    assert.deepEqual(respostas, [RESPOSTA, RESPOSTA, RESPOSTA]);
    assert.equal(m.servico.estado().descartadas, 2);
    assert.equal(m.registrar.mock.calls.length, 3, 'as três solicitações foram registradas no limite persistente');

    const filaCheia = m.registrosDaFila.filter((linha) => linha.includes('fila_cheia'));
    assert.equal(filaCheia.length, 1, 'uma linha por janela, não uma por requisição');
    m.semSensiveis();

    liberar();
    await m.servico.aguardarOciosidade(2000);
  });
});

describe('serviço em encerramento', () => {
  test('depois de parar, a solicitação responde igual, é descartada e não deixa rejeição solta', async (t) => {
    const m = mundo(t, { enviar: aceita });
    m.servico.parar();
    await semRejeicaoSolta(async () => {
      assert.deepEqual(await m.solicitar(), RESPOSTA);
    });
    assert.equal(m.sendMail.mock.calls.length, 0);
    assert.equal(m.servico.estado().descartadas, 1);
    m.semSensiveis();
  });
});

describe('teto persistente de solicitações com entrega falhando', () => {
  test('falha de entrega não devolve o que foi contado: depois de 3 solicitações a quarta não registra nem envia, e todas respondem igual', async (t) => {
    const m = mundo(t, { enviar: async () => { throw falhaSmtp(); } });

    const respostas = [];
    for (let i = 0; i < 4; i += 1) {
      respostas.push(await m.solicitar());
      await m.servico.aguardarOciosidade(2000);
    }
    assert.deepEqual(respostas, [RESPOSTA, RESPOSTA, RESPOSTA, RESPOSTA]);
    assert.equal(m.registrar.mock.calls.length, 3, 'a quarta encontrou o limite atingido');
    assert.equal(m.sendMail.mock.calls.length, 3, 'nenhum envio para a solicitação barrada');
    assert.equal(m.contarRecentes.mock.calls.length, 4);
    m.semSensiveis();
  });

  test('uma falha de entrega não abre exceção no limite: duas falhas seguidas e a terceira ainda é aceita e enviada', async (t) => {
    let chamadas = 0;
    const m = mundo(t, { enviar: async (mensagem) => { chamadas += 1; if (chamadas < 3) throw falhaSmtp(); return aceita(mensagem); } });
    for (let i = 0; i < 3; i += 1) {
      assert.deepEqual(await m.solicitar(), RESPOSTA);
      await m.servico.aguardarOciosidade(2000);
    }
    assert.equal(m.registrar.mock.calls.length, 3);
    assert.equal(chamadas, 3);
  });
});
