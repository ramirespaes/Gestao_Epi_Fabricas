'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { assertSemSensiveis } = require('../helpers/sensiveis');

/**
 * Transporte SMTP contra um servidor SMTP falso em loopback, com o nodemailer
 * de verdade (Bloco 11H): a entrega completa, a recusa de STARTTLS ausente
 * sem nenhum downgrade (nem credencial nem mensagem saem em claro), o timeout
 * e a recusa do destinatário pelo servidor.
 */

const smtp = () => exigirModulo('src/email/transporte/smtp');
const carregarConfig = (env) => exigirModulo('src/config/email').carregarConfigEmail(env);

const EMAIL = 'pessoa.destinataria@example.invalid';
const SENHA = 'senhaSmtpFicticiaParaTeste42';
const USUARIO = 'usuarioSmtpFicticio';

function servidorSmtp({ mudo = false, recusarDestinatario = false } = {}) {
  const comandos = [];
  const dados = [];
  const sockets = new Set();
  const servidor = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    if (!mudo) socket.write('220 fake.test ESMTP\r\n');
    let buffer = '';
    let emDados = false;
    socket.on('data', (pedaco) => {
      buffer += pedaco.toString('latin1');
      let i = buffer.indexOf('\r\n');
      while (i !== -1) {
        const linha = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        i = buffer.indexOf('\r\n');
        if (emDados) {
          if (linha === '.') {
            emDados = false;
            socket.write('250 2.0.0 OK queued\r\n');
          } else {
            dados.push(linha);
          }
          continue;
        }
        comandos.push(linha);
        const verbo = linha.slice(0, 4).toUpperCase();
        if (verbo === 'EHLO' || verbo === 'HELO') socket.write('250-fake.test\r\n250 8BITMIME\r\n');
        else if (verbo === 'RCPT') socket.write(recusarDestinatario ? `550 5.1.1 <${EMAIL}> user unknown\r\n` : '250 OK\r\n');
        else if (verbo === 'DATA') { emDados = true; socket.write('354 go ahead\r\n'); }
        else if (verbo === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    servidor.listen(0, '127.0.0.1', () => {
      resolve({
        porta: servidor.address().port,
        comandos,
        dados,
        encerrar: () => new Promise((fim) => { for (const s of sockets) s.destroy(); servidor.close(() => fim()); }),
      });
    });
  });
}

const mensagem = () => ({
  tipo: 'CONVITE_USUARIO',
  escopo: 'PORTAL',
  para: EMAIL,
  assunto: 'Convite para acessar o Portal do Cliente — SafeWork Engenharia',
  texto: 'Olá, texto do convite',
  html: '<html><body><img src="cid:marca-safework" alt="SafeWork Engenharia"><p>Olá</p></body></html>',
});

const configLocal = (porta, extra = {}) => carregarConfig({
  EMAIL_MODO: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORTA: String(porta), SMTP_SEGURANCA: 'nenhuma', ...extra,
});

async function comServidor(opcoes, corpo) {
  const servidor = await servidorSmtp(opcoes);
  try {
    await corpo(servidor);
  } finally {
    await servidor.encerrar();
  }
}

describe('entrega completa (captador local, sem TLS, só fora de production)', () => {
  test('o servidor recebe um envelope de um destinatário e uma mensagem multipart com a marca inline', async () => {
    await comServidor({}, async (servidor) => {
      const transporte = smtp().criarSmtp(configLocal(servidor.porta));
      try {
        assert.deepEqual(await transporte.enviar(mensagem()), { estado: 'ENVIADO' });
      } finally {
        transporte.fechar();
      }
      const comandos = servidor.comandos.join('\n');
      assert.match(comandos, /MAIL FROM:<no-reply@safeworkengenharia\.com\.br>/);
      assert.equal(servidor.comandos.filter((c) => /^RCPT TO:/i.test(c)).length, 1);
      assert.match(comandos, new RegExp(`RCPT TO:<${EMAIL}>`));
      const cabecalhos = servidor.dados.join('\n');
      assert.match(cabecalhos, /^From: SafeWork Engenharia <no-reply@safeworkengenharia\.com\.br>$/m);
      assert.match(cabecalhos, new RegExp(`^To: ${EMAIL.replace(/\./g, '\\.')}$`, 'm'));
      assert.doesNotMatch(cabecalhos, /^(Reply-To|Cc|Bcc):/mi);
      assert.match(cabecalhos, /^Subject: =\?UTF-8\?[QB]\?/m);
      assert.match(cabecalhos, /multipart\/related/);
      assert.match(cabecalhos, /^Content-ID: <marca-safework>$/m);
      assert.match(cabecalhos, /^Content-Disposition: inline/m);
    });
  });
});

describe('STARTTLS exigido de verdade', () => {
  test('servidor sem STARTTLS: a entrega falha e nem credencial nem mensagem saem em claro', async () => {
    await comServidor({}, async (servidor) => {
      const config = configLocal(servidor.porta, { SMTP_SEGURANCA: 'starttls', SMTP_USUARIO: USUARIO, SMTP_SENHA: SENHA });
      const transporte = smtp().criarSmtp(config);
      try {
        await assert.rejects(() => transporte.enviar(mensagem()), (erro) => {
          assert.equal(erro.name, 'ErroEntrega');
          assert.match(erro.codigo, /^E[A-Z]+$/);
          return true;
        });
      } finally {
        transporte.fechar();
      }
      const visto = servidor.comandos.join('\n');
      for (const proibido of [/^AUTH/im, /^MAIL FROM/im, /^RCPT TO/im, /^DATA/im]) assert.doesNotMatch(visto, proibido, String(proibido));
      assertSemSensiveis(visto + servidor.dados.join('\n'), [SENHA, USUARIO, EMAIL, Buffer.from(SENHA).toString('base64'), Buffer.from(USUARIO).toString('base64')], 'tráfego em claro');
    });
  });
});

describe('timeout e recusa do servidor', () => {
  test('servidor que nunca cumprimenta: a entrega falha por tempo, dentro do limite configurado', async () => {
    await comServidor({ mudo: true }, async (servidor) => {
      const transporte = smtp().criarSmtp(configLocal(servidor.porta, { SMTP_TIMEOUT_MS: '1000' }));
      const inicio = Date.now();
      try {
        await assert.rejects(() => transporte.enviar(mensagem()), (erro) => erro.codigo === 'ETIMEDOUT' || erro.codigo === 'ECONNECTION');
      } finally {
        transporte.fechar();
      }
      assert.ok(Date.now() - inicio < 5000, `levou ${Date.now() - inicio} ms`);
    });
  });

  test('porta fechada: falha de conexão com código seguro', async () => {
    const servidor = await servidorSmtp();
    const { porta } = servidor;
    await servidor.encerrar();
    const transporte = smtp().criarSmtp(configLocal(porta, { SMTP_TIMEOUT_MS: '1000' }));
    try {
      await assert.rejects(() => transporte.enviar(mensagem()), (erro) => /^E[A-Z]+$/.test(erro.codigo));
    } finally {
      transporte.fechar();
    }
  });

  test('destinatário recusado pelo servidor: erro de envelope sem o endereço nem a resposta', async () => {
    await comServidor({ recusarDestinatario: true }, async (servidor) => {
      const transporte = smtp().criarSmtp(configLocal(servidor.porta));
      try {
        await assert.rejects(() => transporte.enviar(mensagem()), (erro) => {
          assert.equal(erro.codigo, 'EENVELOPE');
          assertSemSensiveis(`${erro.message} ${JSON.stringify(erro)} ${erro.stack}`, [EMAIL, 'user unknown', '550'], 'erro de envelope');
          return true;
        });
      } finally {
        transporte.fechar();
      }
    });
  });
});
