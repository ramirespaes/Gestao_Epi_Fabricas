'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Serviço único de e-mail (Bloco 11H): envio aguardado (convites), fila em
 * memória limitada (recuperação e aviso), falha sempre sem exceção, registro
 * técnico sem dado sensível e com amostragem, e encerramento ordenado. O
 * transporte é sempre um duplo controlado pelo teste.
 */

const modulo = () => exigirModulo('src/email/servico-email');
const erros = () => exigirModulo('src/email/erros');

const EMAIL = 'pessoa.destinataria@example.invalid';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const LINK = `https://app.exemplo.test/portal/redefinir-senha.html#token=${TOKEN}`;
const HOST = 'smtp.exemplo-provedor.test';

const mensagem = (extra = {}) => ({
  tipo: 'RECUPERACAO_SENHA',
  escopo: 'PORTAL',
  para: EMAIL,
  conteudo: { assunto: 'Redefinição de senha — Portal do Cliente', texto: `Abra: ${LINK}`, html: `<a href="${LINK}">${LINK}</a>` },
  ...extra,
});

const esperar = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const volta = () => new Promise((resolve) => { setImmediate(resolve); });

function registroEspiao() {
  const linhas = [];
  return { linhas, registrar: (etiqueta, campos) => { linhas.push({ etiqueta, campos }); } };
}

/** Transporte que só termina quando o teste manda; conta quantos estão em andamento ao mesmo tempo. */
function transporteControlado() {
  const t = { chamadas: [], simultaneos: 0, maximo: 0, liberar: [] };
  t.enviar = (m) => {
    t.chamadas.push(m);
    t.simultaneos += 1;
    t.maximo = Math.max(t.maximo, t.simultaneos);
    return new Promise((resolve, reject) => {
      t.liberar.push({ ok: (r = { estado: 'ENVIADO' }) => { t.simultaneos -= 1; resolve(r); }, falhar: (e) => { t.simultaneos -= 1; reject(e); } });
    });
  };
  t.fechar = () => {};
  return t;
}

const transporteQueResolve = (estado = 'ENVIADO') => ({ enviar: async (m) => { transporteQueResolve.vistas.push(m); return { estado }; }, fechar() {} });
transporteQueResolve.vistas = [];

const transporteQueFalha = (erro) => ({ enviar: async () => { throw erro; }, fechar() {} });

const criar = (transporte, extra = {}) => {
  const { linhas, registrar } = registroEspiao();
  const servico = modulo().criarServicoEmail({ transporte, registrar, ...extra });
  return { servico, linhas };
};

describe('enviarAguardando', () => {
  test('entrega ao transporte o destinatário normalizado e o conteúdo, e devolve o estado do transporte', async () => {
    transporteQueResolve.vistas.length = 0;
    const { servico } = criar(transporteQueResolve('ENVIADO'));
    const r = await servico.enviarAguardando(mensagem({ para: '  Pessoa.Destinataria@Example.Invalid ' }));
    assert.deepEqual(r, { estado: 'ENVIADO' });
    assert.deepEqual(transporteQueResolve.vistas, [{
      tipo: 'RECUPERACAO_SENHA', escopo: 'PORTAL', para: EMAIL, assunto: mensagem().conteudo.assunto, texto: mensagem().conteudo.texto, html: mensagem().conteudo.html,
    }]);
    for (const estado of ['GRAVADO', 'NAO_ENVIADO']) {
      assert.deepEqual(await criar(transporteQueResolve(estado)).servico.enviarAguardando(mensagem()), { estado });
    }
  });

  test('falha do transporte vira FALHA com código seguro, nunca exceção', async () => {
    const erro = new (erros().ErroEntrega)('EAUTH');
    const { servico, linhas } = criar(transporteQueFalha(erro));
    assert.deepEqual(await servico.enviarAguardando(mensagem()), { estado: 'FALHA', codigo: 'EAUTH' });
    assert.equal(linhas.length, 1);
    assert.deepEqual(linhas[0].campos, { evento: 'entrega_falhou', tipo: 'RECUPERACAO_SENHA', escopo: 'PORTAL', codigo: 'EAUTH' });
  });

  test('erro qualquer, mesmo com dado sensível na mensagem, vira ERRO_DESCONHECIDO e o registro não o repete', async () => {
    const hostil = Object.assign(new Error(`falhou para ${EMAIL} em ${HOST} com ${TOKEN} ${LINK}`), { code: 'ESTRANHO', response: EMAIL });
    const { servico, linhas } = criar(transporteQueFalha(hostil));
    assert.deepEqual(await servico.enviarAguardando(mensagem()), { estado: 'FALHA', codigo: 'ERRO_DESCONHECIDO' });
    const texto = JSON.stringify(linhas);
    for (const sensivel of [EMAIL, 'pessoa.destinataria', HOST, TOKEN, '#token=', 'redefinir-senha', 'ESTRANHO']) assert.equal(texto.includes(sensivel), false, sensivel);
  });

  test('destinatário inválido ou entrada incompleta não chegam ao transporte', async () => {
    const t = transporteControlado();
    const { servico } = criar(t);
    for (const ruim of [{ para: 'sem-arroba' }, { para: 'a@b.test\r\nBcc: x@y.test' }, { para: null }]) {
      assert.deepEqual(await servico.enviarAguardando(mensagem(ruim)), { estado: 'FALHA', codigo: 'DESTINATARIO_INVALIDO' }, JSON.stringify(ruim));
    }
    for (const ruim of [{ tipo: 'minusculo' }, { escopo: 42 }, { conteudo: { assunto: 'a', texto: 'b' } }, { conteudo: null }]) {
      assert.deepEqual(await servico.enviarAguardando(mensagem(ruim)), { estado: 'FALHA', codigo: 'ENTRADA_INVALIDA' }, JSON.stringify(ruim));
    }
    assert.equal(t.chamadas.length, 0);
  });

  test('transporte que trava: o limite de envio devolve FALHA por tempo e não prende quem chamou', async () => {
    const t = transporteControlado();
    const { servico } = criar(t, { limiteEnvioMs: 60 });
    const inicio = Date.now();
    assert.deepEqual(await servico.enviarAguardando(mensagem()), { estado: 'FALHA', codigo: 'ETIMEDOUT' });
    assert.ok(Date.now() - inicio < 1000);
  });
});

describe('fila em memória (enfileirar)', () => {
  test('quem enfileira não recebe promessa nem exceção, mesmo com entrada inválida; a entrega acontece depois', async () => {
    transporteQueResolve.vistas.length = 0;
    const { servico } = criar(transporteQueResolve());
    assert.equal(servico.enfileirar(mensagem()), undefined);
    assert.doesNotThrow(() => servico.enfileirar(mensagem({ para: 'inválido' })));
    assert.deepEqual(transporteQueResolve.vistas, [], 'nada foi entregue de forma síncrona');
    await servico.aguardarOciosidade();
    assert.equal(transporteQueResolve.vistas.length, 1);
  });

  test('respeita o teto de envios simultâneos e entrega todas, na ordem', async () => {
    const t = transporteControlado();
    const { servico } = criar(t, { concorrencia: 2 });
    for (let i = 0; i < 5; i += 1) servico.enfileirar(mensagem({ para: `pessoa${i}@example.invalid` }));
    await volta();
    assert.equal(t.chamadas.length, 2);
    for (let volta_ = 0; volta_ < 20 && t.chamadas.length < 5; volta_ += 1) {
      t.liberar.splice(0).forEach((l) => l.ok());
      await volta();
    }
    t.liberar.splice(0).forEach((l) => l.ok());
    assert.deepEqual(await servico.aguardarOciosidade(1000), { pendentes: 0 });
    assert.equal(t.maximo, 2);
    assert.deepEqual(t.chamadas.map((m) => m.para), [0, 1, 2, 3, 4].map((i) => `pessoa${i}@example.invalid`));
  });

  test('fila cheia: o excedente é descartado, contado e registrado uma vez por janela, sem dado sensível', async () => {
    const t = transporteControlado();
    let agora = 1_000_000;
    const { servico, linhas } = criar(t, { concorrencia: 1, filaMaxima: 3, agora: () => agora });
    for (let i = 0; i < 7; i += 1) servico.enfileirar(mensagem({ para: `pessoa${i}@example.invalid` }));
    await volta();
    assert.deepEqual(servico.estado(), { executando: 1, pendentes: 2, descartadas: 4, parado: false });
    const cheias = linhas.filter((l) => l.campos.evento === 'fila_cheia');
    assert.equal(cheias.length, 1, 'uma linha por janela');
    assert.deepEqual(Object.keys(cheias[0].campos).sort(), ['evento', 'filaMaxima']);
    agora += 61_000;
    servico.enfileirar(mensagem());
    const resumo = linhas.filter((l) => l.campos.evento === 'fila_cheia');
    assert.equal(resumo.length, 2);
    assert.equal(resumo[1].campos.descartadasNaJanela, 4);
    const texto = JSON.stringify(linhas);
    for (const sensivel of [EMAIL, 'pessoa0', TOKEN, '#token=']) assert.equal(texto.includes(sensivel), false, sensivel);
    for (let rodada = 0; rodada < 10 && servico.estado().executando + servico.estado().pendentes > 0; rodada += 1) {
      t.liberar.splice(0).forEach((l) => l.ok());
      await volta();
    }
    assert.deepEqual(await servico.aguardarOciosidade(1000), { pendentes: 0 });
  });

  test('falha SMTP na fila: não lança, não deixa promessa rejeitada e registra só evento, tipo, escopo e código', async () => {
    const rejeicoes = [];
    const ouvinte = (motivo) => { rejeicoes.push(motivo); };
    process.on('unhandledRejection', ouvinte);
    try {
      const hostil = Object.assign(new Error(`${EMAIL} ${HOST} ${LINK}`), { code: 'ECONNECTION' });
      const { servico, linhas } = criar(transporteQueFalha(hostil));
      servico.enfileirar(mensagem());
      servico.enfileirar(mensagem({ tipo: 'SENHA_ALTERADA', escopo: 'PLATAFORMA' }));
      await servico.aguardarOciosidade(1000);
      await volta();
      await volta();
      assert.deepEqual(rejeicoes, []);
      assert.equal(linhas.length, 2);
      assert.deepEqual(linhas[1].campos, { evento: 'entrega_falhou', tipo: 'SENHA_ALTERADA', escopo: 'PLATAFORMA', codigo: 'ERRO_DESCONHECIDO' });
      const texto = JSON.stringify(linhas);
      for (const sensivel of [EMAIL, HOST, TOKEN, '#token=']) assert.equal(texto.includes(sensivel), false, sensivel);
    } finally {
      process.off('unhandledRejection', ouvinte);
    }
  });

  test('falhas em rajada: no máximo 20 linhas por janela, com a contagem do resto na janela seguinte', async () => {
    let agora = 5_000_000;
    const { servico, linhas } = criar(transporteQueFalha(new (erros().ErroEntrega)('ECONNECTION')), { agora: () => agora, filaMaxima: 100 });
    for (let i = 0; i < 25; i += 1) servico.enfileirar(mensagem());
    await servico.aguardarOciosidade(2000);
    assert.equal(linhas.filter((l) => l.campos.evento === 'entrega_falhou').length, 20);
    agora += 61_000;
    servico.enfileirar(mensagem());
    await servico.aguardarOciosidade(1000);
    const resumo = linhas.find((l) => l.campos.evento === 'entrega_falhou_suprimidas');
    assert.ok(resumo, 'linha de resumo');
    assert.equal(resumo.campos.suprimidas, 5);
  });

  test('transporte que trava: o limite de envio libera a vaga e a fila continua andando', async () => {
    const t = transporteControlado();
    const { servico, linhas } = criar(t, { concorrencia: 1, limiteEnvioMs: 40 });
    servico.enfileirar(mensagem({ para: 'a@example.invalid' }));
    servico.enfileirar(mensagem({ para: 'b@example.invalid' }));
    await esperar(150);
    assert.equal(t.chamadas.length, 2, 'a segunda mensagem foi tentada depois do tempo da primeira');
    assert.equal(linhas.filter((l) => l.campos.codigo === 'ETIMEDOUT').length >= 1, true);
    t.liberar.forEach((l) => l.ok());
  });
});

describe('encerramento ordenado', () => {
  test('aguardarOciosidade devolve o que ainda falta quando o limite passa e zero quando tudo termina', async () => {
    const t = transporteControlado();
    const { servico } = criar(t, { limiteEnvioMs: 10_000 });
    servico.enfileirar(mensagem());
    servico.enfileirar(mensagem());
    await volta();
    const inicio = Date.now();
    assert.deepEqual(await servico.aguardarOciosidade(50), { pendentes: 2 });
    assert.ok(Date.now() - inicio < 1000);
    t.liberar.forEach((l) => l.ok());
    assert.deepEqual(await servico.aguardarOciosidade(1000), { pendentes: 0 });
  });

  test('conta também o envio aguardado que ainda está em andamento', async () => {
    const t = transporteControlado();
    const { servico } = criar(t, { limiteEnvioMs: 10_000 });
    const envio = servico.enviarAguardando(mensagem());
    await volta();
    assert.deepEqual(await servico.aguardarOciosidade(30), { pendentes: 1 });
    t.liberar[0].ok();
    assert.deepEqual(await envio, { estado: 'ENVIADO' });
    assert.deepEqual(await servico.aguardarOciosidade(100), { pendentes: 0 });
  });

  test('depois de parar, a fila não aceita mais nada e o envio aguardado devolve FALHA sem tocar o transporte', async () => {
    const t = transporteControlado();
    const { servico } = criar(t);
    servico.parar();
    servico.enfileirar(mensagem());
    assert.deepEqual(await servico.enviarAguardando(mensagem()), { estado: 'FALHA', codigo: 'SERVICO_ENCERRANDO' });
    assert.equal(t.chamadas.length, 0);
    assert.deepEqual(servico.estado(), { executando: 0, pendentes: 0, descartadas: 1, parado: true });
  });

  test('fechar fecha o transporte', async () => {
    let fechado = 0;
    const { servico } = criar({ enviar: async () => ({ estado: 'ENVIADO' }), fechar() { fechado += 1; } });
    await servico.fechar();
    assert.equal(fechado, 1);
  });
});

describe('registro padrão', () => {
  test('sem registrador injetado, a linha vai ao console.error com a etiqueta do módulo e só os campos permitidos', async (t) => {
    const saidas = [];
    t.mock.method(console, 'error', (...args) => { saidas.push(args); });
    const servico = modulo().criarServicoEmail({ transporte: transporteQueFalha(new (erros().ErroEntrega)('ETIMEDOUT')) });
    await servico.enviarAguardando(mensagem());
    assert.equal(saidas.length, 1);
    assert.equal(saidas[0][0], '[entrega-email]');
    assert.deepEqual(saidas[0][1], { evento: 'entrega_falhou', tipo: 'RECUPERACAO_SENHA', escopo: 'PORTAL', codigo: 'ETIMEDOUT' });
  });
});
