'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { abrirPagina, RAIZ, SVG_NS } = require('./helpers/dom-painel');

/**
 * Login do Painel Privado com MFA TOTP: a senha abre uma etapa, nunca o
 * painel. Os testes abrem index.html como o navegador (HTML real e os
 * scripts que ele referencia) e conferem o que a página mostra, envia,
 * guarda e apaga.
 */

const PAGINA = 'painel-privado/index.html';
const EMAIL = 'admin@safework.test';
const SENHA = 'frase-longa-de-teste-42';
const SEGREDO = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const CHAVE = 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP';
const URI = `otpauth://totp/SafeWork:admin%40safework.test?issuer=SafeWork&secret=${SEGREDO}&algorithm=SHA1&digits=6&period=30`;
const SEGREDO_2 = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const CHAVE_2 = 'KRSX G5CT MVRX EZLU KRSX G5CT MVRX EZLU';
const URI_2 = `otpauth://totp/SafeWork:admin%40safework.test?issuer=SafeWork&secret=${SEGREDO_2}&algorithm=SHA1&digits=6&period=30`;
const CODIGOS = ['0A1B-2C3D-4E5F-6G7H', '1B2C-3D4E-5F6G-7H8J', '2C3D-4E5F-6G7H-8J9K', '3D4E-5F6G-7H8J-9KAM', '4E5F-6G7H-8J9K-AMBN',
  '5F6G-7H8J-9KAM-BNCP', '6G7H-8J9K-AMBN-CPDQ', '7H8J-9KAM-BNCP-DQER', '8J9K-AMBN-CPDQ-ERFS', '9KAM-BNCP-DQER-FSGT'];
const LIBERACAO = 'ZZ9Y-8X7W-6V5T-4S3R';
const RECUPERACAO = 'HH7G-6F5E-4D3C-2B1A';
const TOTP = '012345';
const EXPIRA = '2026-09-28T12:15:00.000Z';
const VENDOR_QR = path.join(RAIZ, 'vendor/qrcode-generator-2.0.4.js');
const SHA256_QR = '79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c';

const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
const erro = (status, codigo, message) => ({ status, corpo: { status: 'error', codigo, message } });
const SEM_DESAFIO = erro(401, 'DESAFIO_INVALIDO', 'Etapa de verificação inválida ou expirada');
const CODIGO_INVALIDO = erro(401, 'MFA_CODIGO_INVALIDO', 'Código inválido');
const cadastro = (uri = URI, chaveManual = CHAVE) => ({ uri, chaveManual });

const base = (extra = {}) => ({ 'GET /auth/mfa/estado': SEM_DESAFIO, 'POST /auth/logout': ok(), ...extra });
const chaves = (pg) => pg.chamadas.map((c) => c.chave);
const ultima = (pg) => pg.chamadas[pg.chamadas.length - 1];
const SEGREDOS = [SENHA, SEGREDO, CHAVE, CHAVE.replace(/ /g, ''), URI, 'otpauth://', SEGREDO_2, CHAVE_2, URI_2, LIBERACAO, RECUPERACAO, TOTP, ...CODIGOS];

function semSegredos(texto, onde, lista = SEGREDOS) {
  for (const valor of lista) assert.equal(texto.includes(valor), false, `${onde} contém dado sensível`);
}

async function abrir(rotas) {
  const pg = abrirPagina(PAGINA, { rotas: base(rotas) });
  await pg.esperar();
  return pg;
}

async function comSenha(etapa, rotas = {}) {
  const pg = await abrir({ 'POST /auth/login': ok({ etapa, expiraEm: EXPIRA }), ...rotas });
  await pg.digitar('email', EMAIL);
  await pg.digitar('senha', SENHA);
  await pg.enviar('form-login');
  return pg;
}

async function emCadastro(rotas = {}) {
  const pg = await comSenha('LIBERACAO', { 'POST /auth/mfa/liberacao': ok({ etapa: 'CADASTRO', expiraEm: EXPIRA, cadastro: cadastro() }), ...rotas });
  await pg.digitar('codigo-liberacao', LIBERACAO);
  await pg.enviar('etapa-liberacao');
  return pg;
}

async function comCodigos(rotas = {}) {
  const pg = await emCadastro({ 'POST /auth/mfa/cadastro/confirmar': ok({ codigosRecuperacao: CODIGOS }), ...rotas });
  await pg.digitar('codigo-cadastro', TOTP);
  await pg.enviar('etapa-cadastro');
  return pg;
}

/** Módulos escuros desenhados no SVG, como "linha,coluna". */
function modulosDoSvg(svg) {
  const [, , largura] = svg.getAttribute('viewBox').split(' ').map(Number);
  const caminhos = svg.children.filter((f) => f.tagName === 'path');
  assert.equal(caminhos.length, 1);
  const d = caminhos[0].getAttribute('d');
  assert.match(d, /^(?:M\d+ \d+h\d+v1h-\d+z)+$/, 'o caminho só tem números e comandos de desenho');
  const escuros = new Set();
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(m[3]); i += 1) escuros.add(`${m[2]},${Number(m[1]) + i}`);
  }
  return { largura, escuros };
}

function modulosEsperados(uri, margem) {
  assert.ok(fs.existsSync(VENDOR_QR), 'vendor/qrcode-generator-2.0.4.js ainda não foi incorporado');
  // eslint-disable-next-line global-require
  const qrcode = require(VENDOR_QR);
  const qr = qrcode(0, 'M');
  qr.addData(uri, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const escuros = new Set();
  for (let l = 0; l < n; l += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(l, c)) escuros.add(`${l + margem},${c + margem}`);
  return { largura: n + 2 * margem, escuros };
}

function conferirQr(pg, uri) {
  const filhos = pg.el('cadastro-qr').children;
  assert.deepEqual(filhos.map((f) => [f.tagName, f.namespaceURI]), [['svg', SVG_NS]], 'um SVG, criado pela API do DOM');
  const desenhado = modulosDoSvg(filhos[0]);
  const esperado = modulosEsperados(uri, 4);
  assert.equal(desenhado.largura, esperado.largura);
  assert.deepEqual([...desenhado.escuros].sort(), [...esperado.escuros].sort(), 'o QR desenhado é o da URI recebida');
  assert.equal(filhos[0].getAttribute('role'), 'img');
  assert.ok(filhos[0].getAttribute('aria-label'));
}

describe('login: a senha abre a etapa de MFA, não o painel', () => {
  test('sem desafio em andamento: só o formulário de login aparece', async () => {
    const pg = await abrir();
    assert.deepEqual(pg.etapasVisiveis(), ['LOGIN']);
    assert.deepEqual(chaves(pg), ['GET /auth/mfa/estado']);
    assert.deepEqual(pg.navegacoes, []);
  });

  test('VERIFICACAO: senha aceita mostra só a verificação; não navega; a senha sai do campo; foco no código', async () => {
    const pg = await comSenha('VERIFICACAO');

    assert.deepEqual(ultima(pg).corpo, { email: EMAIL, senha: SENHA });
    assert.deepEqual(pg.etapasVisiveis(), ['VERIFICACAO']);
    assert.deepEqual(pg.navegacoes, [], 'a senha sozinha não entra no painel');
    assert.equal(pg.el('senha').value, '');
    assert.equal(pg.foco(), 'codigo-verificacao');
    assert.match(pg.el('titulo-etapa').textContent, /duas etapas/i);
  });

  test('VERIFICACAO: código aceito limpa o campo e entra no painel', async () => {
    const pg = await comSenha('VERIFICACAO', { 'POST /auth/mfa/verificar': ok() });
    await pg.digitar('codigo-verificacao', TOTP);
    await pg.enviar('etapa-verificacao');

    assert.deepEqual(ultima(pg).corpo, { codigo: TOTP });
    assert.equal(pg.el('codigo-verificacao').value, '');
    assert.deepEqual(pg.navegacoes, ['painel.html']);
  });

  test('senha recusada: mensagem genérica, continua no login, sem etapa de MFA', async () => {
    const pg = await abrir({ 'POST /auth/login': erro(401, 'CREDENCIAIS_INVALIDAS', 'E-mail ou senha inválidos') });
    await pg.digitar('email', EMAIL);
    await pg.digitar('senha', SENHA);
    await pg.enviar('form-login');

    assert.deepEqual(pg.etapasVisiveis(), ['LOGIN']);
    assert.notEqual(pg.el('mensagem').textContent, '');
    semSegredos(pg.el('mensagem').textContent, 'a mensagem');
    assert.equal(pg.el('botao-entrar').disabled, false);
  });

  test('etapa desconhecida na resposta do login: resposta inesperada, sem avançar', async () => {
    const pg = await comSenha('OUTRA_COISA');
    assert.deepEqual(pg.etapasVisiveis(), ['LOGIN']);
    assert.match(pg.el('mensagem').textContent, /inesperada/i);
    assert.deepEqual(pg.navegacoes, []);
  });
});

describe('primeiro cadastro: LIBERACAO → CADASTRO → códigos de recuperação', () => {
  test('LIBERACAO pede o código de liberação; aceito, vai ao CADASTRO sem criar sessão nem navegar', async () => {
    const pg = await comSenha('LIBERACAO');
    assert.deepEqual(pg.etapasVisiveis(), ['LIBERACAO']);
    assert.equal(pg.foco(), 'codigo-liberacao');

    const emAndamento = await emCadastro();

    assert.deepEqual(chaves(emAndamento).slice(-1), ['POST /auth/mfa/liberacao']);
    assert.deepEqual(ultima(emAndamento).corpo, { codigoLiberacao: LIBERACAO });
    assert.deepEqual(emAndamento.etapasVisiveis(), ['CADASTRO']);
    assert.equal(emAndamento.el('codigo-liberacao').value, '');
    assert.deepEqual(emAndamento.navegacoes, []);
    assert.equal(emAndamento.foco(), 'codigo-cadastro');
  });

  test('CADASTRO mostra o QR da URI e a chave manual; a URI não aparece em nenhum texto ou atributo', async () => {
    const pg = await emCadastro();

    conferirQr(pg, URI);
    assert.equal(pg.el('cadastro-chave').textContent, CHAVE);
    assert.equal(pg.el('cadastro-material').hidden, false);
    const dom = pg.textoDoDom();
    semSegredos(dom, 'o DOM', [URI, 'otpauth://', SEGREDO, LIBERACAO, SENHA]);
    assert.equal(dom.split(CHAVE).length - 1, 1, 'a chave manual aparece uma vez só');
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
  });

  test('Copiar chave: copia a chave manual e avisa, sem mostrar a chave na mensagem', async () => {
    const pg = await emCadastro();
    await pg.clicar('botao-copiar-chave');

    assert.deepEqual(pg.copiados, [CHAVE]);
    assert.match(pg.el('mensagem').textContent, /copiada/i);
    semSegredos(pg.el('mensagem').textContent, 'a mensagem');
  });

  test('Gerar novo QR Code: pede o reinício e troca QR e chave pelos novos', async () => {
    const pg = await emCadastro({ 'POST /auth/mfa/cadastro/reiniciar': ok({ etapa: 'CADASTRO', expiraEm: EXPIRA, cadastro: cadastro(URI_2, CHAVE_2) }) });
    await pg.digitar('codigo-cadastro', '99');
    await pg.clicar('botao-novo-qr');

    assert.deepEqual(ultima(pg).corpo, {});
    conferirQr(pg, URI_2);
    assert.equal(pg.el('cadastro-chave').textContent, CHAVE_2);
    assert.equal(pg.el('codigo-cadastro').value, '');
    semSegredos(pg.textoDoDom(), 'o DOM', [CHAVE, SEGREDO]);
  });

  test('confirmação: mostra os 10 códigos, some com QR e chave, e só entra no painel depois de o usuário confirmar que salvou', async () => {
    const pg = await comCodigos();

    assert.deepEqual(ultima(pg).corpo, { codigo: TOTP });
    assert.deepEqual(pg.etapasVisiveis(), ['CODIGOS']);
    assert.deepEqual(pg.el('lista-codigos').children.map((li) => li.textContent), CODIGOS);
    assert.deepEqual(pg.navegacoes, [], 'não navega antes de o usuário ver os códigos');
    assert.deepEqual(pg.el('cadastro-qr').children, []);
    assert.equal(pg.el('cadastro-chave').textContent, '');
    assert.equal(pg.el('codigo-cadastro').value, '');
    assert.equal(pg.el('botao-codigos-salvos').disabled, true, 'exige a confirmação antes');

    await pg.clicar('botao-copiar-codigos');
    assert.deepEqual(pg.copiados, [CODIGOS.join('\n')]);

    await pg.marcar('confirmo-codigos');
    assert.equal(pg.el('botao-codigos-salvos').disabled, false);
    await pg.clicar('botao-codigos-salvos');

    assert.deepEqual(pg.el('lista-codigos').children, []);
    semSegredos(pg.textoDoDom(), 'o DOM depois de sair dos códigos');
    assert.deepEqual(pg.navegacoes, ['painel.html']);
  });

  test('clique em Já salvei sem a confirmação marcada não faz nada: os códigos continuam na tela', async () => {
    const pg = await comCodigos();
    await pg.el('botao-codigos-salvos').disparar('click');
    await pg.esperar();

    assert.deepEqual(pg.el('lista-codigos').children.map((li) => li.textContent), CODIGOS);
    assert.deepEqual([pg.etapasVisiveis(), pg.navegacoes], [['CODIGOS'], []]);

    await pg.marcar('confirmo-codigos');
    await pg.marcar('confirmo-codigos', false);
    assert.equal(pg.el('botao-codigos-salvos').disabled, true, 'desmarcar volta a bloquear');
  });

  test('com os códigos na tela, fechar ou recarregar pede confirmação; depois de salvos, não pede mais', async () => {
    const pg = await comCodigos();
    const eventos = await pg.eventoDaJanela('beforeunload');
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 1);
    assert.equal(eventos.length, 1);

    await pg.marcar('confirmo-codigos');
    await pg.clicar('botao-codigos-salvos');
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 0);
  });

  test('resposta de confirmação sem os 10 códigos: resposta inesperada, nada é mostrado como código', async () => {
    const pg = await emCadastro({ 'POST /auth/mfa/cadastro/confirmar': ok({ codigosRecuperacao: ['só-um'] }) });
    await pg.digitar('codigo-cadastro', TOTP);
    await pg.enviar('etapa-cadastro');

    assert.match(pg.el('mensagem').textContent, /inesperada/i);
    assert.deepEqual(pg.el('lista-codigos').children, []);
    assert.deepEqual(pg.navegacoes, []);
  });
});

describe('recuperação: o código de recuperação obriga o recadastro', () => {
  const rotas = (extra = {}) => ({
    'POST /auth/mfa/recuperacao': ok({ etapa: 'RECUPERACAO', expiraEm: EXPIRA, cadastro: cadastro(URI_2, CHAVE_2) }),
    'POST /auth/mfa/cadastro/confirmar': ok({ codigosRecuperacao: CODIGOS }),
    ...extra,
  });

  test('Usar código de recuperação abre a etapa própria; Voltar retorna à verificação sem chamar o servidor', async () => {
    const pg = await comSenha('VERIFICACAO', rotas());
    await pg.digitar('codigo-verificacao', '12');
    await pg.clicar('botao-usar-recuperacao');

    assert.deepEqual(pg.etapasVisiveis(), ['RECUPERACAO']);
    assert.equal(pg.el('codigo-verificacao').value, '');
    assert.equal(pg.foco(), 'codigo-recuperacao');
    const antes = pg.chamadas.length;
    await pg.digitar('codigo-recuperacao', 'HH7G');
    await pg.clicar('botao-voltar-recuperacao');
    assert.deepEqual([pg.etapasVisiveis(), pg.el('codigo-recuperacao').value, pg.chamadas.length], [['VERIFICACAO'], '', antes]);
  });

  test('código aceito não autentica: leva ao cadastro de um novo autenticador; a sessão só vem depois do TOTP novo', async () => {
    const pg = await comSenha('VERIFICACAO', rotas());
    await pg.clicar('botao-usar-recuperacao');
    await pg.digitar('codigo-recuperacao', RECUPERACAO);
    await pg.enviar('etapa-recuperacao');

    assert.deepEqual(ultima(pg).corpo, { codigoRecuperacao: RECUPERACAO });
    assert.deepEqual(pg.etapasVisiveis(), ['CADASTRO']);
    assert.match(pg.el('titulo-etapa').textContent, /novo autenticador/i);
    assert.equal(pg.el('codigo-recuperacao').value, '');
    assert.deepEqual(pg.navegacoes, [], 'o código de recuperação não entra no painel');
    conferirQr(pg, URI_2);
    assert.equal(pg.el('cadastro-chave').textContent, CHAVE_2);

    await pg.digitar('codigo-cadastro', TOTP);
    await pg.enviar('etapa-cadastro');
    assert.deepEqual(pg.etapasVisiveis(), ['CODIGOS']);
    assert.deepEqual(pg.el('lista-codigos').children.map((li) => li.textContent), CODIGOS);
    await pg.marcar('confirmo-codigos');
    await pg.clicar('botao-codigos-salvos');
    assert.deepEqual(pg.navegacoes, ['painel.html']);
  });

  test('código de recuperação recusado: mesma etapa, campo limpo, foco no campo', async () => {
    const pg = await comSenha('VERIFICACAO', rotas({ 'POST /auth/mfa/recuperacao': CODIGO_INVALIDO }));
    await pg.clicar('botao-usar-recuperacao');
    await pg.digitar('codigo-recuperacao', RECUPERACAO);
    await pg.enviar('etapa-recuperacao');

    assert.deepEqual(pg.etapasVisiveis(), ['RECUPERACAO']);
    assert.deepEqual([pg.el('codigo-recuperacao').value, pg.foco()], ['', 'codigo-recuperacao']);
    semSegredos(pg.el('mensagem').textContent, 'a mensagem');
  });
});

describe('código TOTP é texto', () => {
  test('zeros à esquerda chegam ao servidor como texto de 6 dígitos', async () => {
    const pg = await comSenha('VERIFICACAO', { 'POST /auth/mfa/verificar': ok() });
    await pg.digitar('codigo-verificacao', '000123');
    await pg.enviar('etapa-verificacao');

    assert.equal(ultima(pg).corpo.codigo, '000123');
    assert.equal(typeof ultima(pg).corpo.codigo, 'string');
    assert.match(ultima(pg).corpoBruto, /"codigo":"000123"/);
  });

  test('colagem com espaços ou hífens vira os 6 dígitos; letras e excesso são descartados', async () => {
    const pg = await comSenha('VERIFICACAO');
    for (const [colado, esperado] of [['012 345', '012345'], ['01-23-45', '012345'], [' 007 008 ', '007008'], ['0123456789', '012345'], ['a0b1c2', '012']]) {
      pg.el('codigo-verificacao').value = '';
      await pg.colar('codigo-verificacao', colado);
      assert.equal(pg.el('codigo-verificacao').value, esperado, colado);
    }
    await pg.digitar('codigo-verificacao', '12x4');
    assert.equal(pg.el('codigo-verificacao').value, '124');
  });

  test('código incompleto não vai ao servidor: aviso e foco no campo', async () => {
    const pg = await comSenha('VERIFICACAO', { 'POST /auth/mfa/verificar': ok() });
    const antes = pg.chamadas.length;
    await pg.digitar('codigo-verificacao', '01234');
    await pg.enviar('etapa-verificacao');

    assert.equal(pg.chamadas.length, antes);
    assert.match(pg.el('mensagem').textContent, /6 dígitos/);
    assert.equal(pg.foco(), 'codigo-verificacao');
    assert.deepEqual(pg.navegacoes, []);
  });
});

describe('uma requisição por vez', () => {
  test('envio repetido com a requisição pendente: uma chamada só; botão desabilitado até a resposta', async () => {
    let liberar;
    const pg = await comSenha('VERIFICACAO', { 'POST /auth/mfa/verificar': () => new Promise((r) => { liberar = () => r(CODIGO_INVALIDO); }) });
    await pg.digitar('codigo-verificacao', TOTP);
    const antes = pg.chamadas.length;

    const primeiro = pg.enviarSemEsperar('etapa-verificacao');
    await new Promise((r) => { setImmediate(r); });
    assert.equal(pg.el('botao-verificar').disabled, true);
    assert.equal(pg.el('botao-usar-recuperacao').disabled, true);
    const segundo = pg.enviarSemEsperar('etapa-verificacao');
    await new Promise((r) => { setImmediate(r); });
    assert.equal(pg.chamadas.length, antes + 1);

    liberar();
    await Promise.all([primeiro, segundo]);
    await pg.esperar();
    assert.equal(pg.chamadas.length, antes + 1);
    assert.equal(pg.el('botao-verificar').disabled, false);
    assert.equal(pg.el('botao-usar-recuperacao').disabled, false);
  });

  test('login: segundo envio com o primeiro pendente é ignorado', async () => {
    let liberar;
    const pg = await abrir({ 'POST /auth/login': () => new Promise((r) => { liberar = () => r(ok({ etapa: 'VERIFICACAO', expiraEm: EXPIRA })); }) });
    await pg.digitar('email', EMAIL);
    await pg.digitar('senha', SENHA);
    const a = pg.enviarSemEsperar('form-login');
    const b = pg.enviarSemEsperar('form-login');
    await new Promise((r) => { setImmediate(r); });
    assert.equal(pg.el('botao-entrar').disabled, true);
    liberar();
    await Promise.all([a, b]);
    await pg.esperar();
    assert.deepEqual(chaves(pg).filter((c) => c === 'POST /auth/login').length, 1);
  });
});

describe('erros', () => {
  const tentar = async (resposta) => {
    const pg = await comSenha('VERIFICACAO', { 'POST /auth/mfa/verificar': resposta });
    await pg.digitar('codigo-verificacao', TOTP);
    await pg.enviar('etapa-verificacao');
    return pg;
  };

  test('código inválido: mesma etapa, campo limpo, foco no campo, mensagem sem o código', async () => {
    const pg = await tentar(CODIGO_INVALIDO);
    assert.deepEqual(pg.etapasVisiveis(), ['VERIFICACAO']);
    assert.deepEqual([pg.el('codigo-verificacao').value, pg.foco()], ['', 'codigo-verificacao']);
    assert.match(pg.el('mensagem').textContent, /inválido/i);
    semSegredos(pg.el('mensagem').textContent, 'a mensagem');
    assert.deepEqual(pg.navegacoes, []);
  });

  test('cooldown e limite de requisições (429): aviso para aguardar, sem sair da etapa', async () => {
    for (const codigo of ['MFA_EM_COOLDOWN', 'LIMITE_REQUISICOES_EXCEDIDO']) {
      const pg = await tentar(erro(429, codigo, 'Muitas tentativas. Tente novamente mais tarde'));
      assert.deepEqual(pg.etapasVisiveis(), ['VERIFICACAO'], codigo);
      assert.match(pg.el('mensagem').textContent, /aguarde/i, codigo);
      assert.equal(pg.el('codigo-verificacao').value, '');
    }
  });

  test('desafio inválido ou expirado: etapa encerrada, com a ação Entrar novamente, que limpa o desafio e volta ao login', async () => {
    const pg = await tentar(SEM_DESAFIO);
    assert.deepEqual(pg.etapasVisiveis(), ['ENCERRADA']);
    assert.match(pg.el('mensagem').textContent, /expirou/i);
    assert.equal(pg.foco(), 'botao-entrar-novamente');

    await pg.clicar('botao-entrar-novamente');
    assert.equal(ultima(pg).chave, 'POST /auth/logout');
    assert.deepEqual(pg.etapasVisiveis(), ['LOGIN']);
    assert.equal(pg.foco(), 'email');
    assert.deepEqual(pg.navegacoes, []);
  });

  test('MFA indisponível (503), erro interno (500), rede e corpo que não é JSON: mensagem própria, mesma etapa, botão liberado', async () => {
    const casos = [
      [erro(503, 'MFA_INDISPONIVEL', 'Verificação em duas etapas indisponível no momento'), /indisponível/i],
      [erro(500, 'ERRO_INTERNO', 'Erro interno'), /não foi possível/i],
      [new Error('falha de rede'), /conexão/i],
      [{ status: 200, texto: '<html>proxy</html>' }, /inesperada/i],
    ];
    for (const [resposta, mensagem] of casos) {
      const pg = await tentar(resposta);
      assert.deepEqual(pg.etapasVisiveis(), ['VERIFICACAO']);
      assert.match(pg.el('mensagem').textContent, mensagem);
      assert.equal(pg.el('botao-verificar').disabled, false);
      assert.deepEqual(pg.navegacoes, []);
    }
  });

  test('cadastro expirado (409): QR e chave saem da tela; dá para gerar outro QR', async () => {
    const pg = await emCadastro({
      'POST /auth/mfa/cadastro/confirmar': erro(409, 'MFA_CADASTRO_EXPIRADO', 'O cadastro expirou. Gere um novo código ou entre de novo com a senha'),
      'POST /auth/mfa/cadastro/reiniciar': ok({ etapa: 'CADASTRO', expiraEm: EXPIRA, cadastro: cadastro(URI_2, CHAVE_2) }),
    });
    await pg.digitar('codigo-cadastro', TOTP);
    await pg.enviar('etapa-cadastro');

    assert.deepEqual(pg.etapasVisiveis(), ['CADASTRO']);
    assert.equal(pg.el('cadastro-material').hidden, true);
    assert.deepEqual([pg.el('cadastro-qr').children, pg.el('cadastro-chave').textContent], [[], '']);
    assert.match(pg.el('mensagem').textContent, /expirou/i);

    await pg.clicar('botao-novo-qr');
    assert.equal(pg.el('cadastro-material').hidden, false);
    conferirQr(pg, URI_2);
  });

  test('reinícios esgotados e fator já ativo (409): etapa encerrada', async () => {
    for (const codigo of ['MFA_CADASTRO_REINICIOS_ESGOTADOS', 'MFA_JA_ATIVO']) {
      const pg = await emCadastro({ 'POST /auth/mfa/cadastro/reiniciar': erro(409, codigo, 'mensagem do servidor') });
      await pg.clicar('botao-novo-qr');
      assert.deepEqual(pg.etapasVisiveis(), ['ENCERRADA'], codigo);
      assert.deepEqual([pg.el('cadastro-qr').children, pg.el('cadastro-chave').textContent], [[], '']);
    }
  });
});

describe('a tela reflete o estado do servidor ao abrir', () => {
  test('VERIFICACAO e LIBERACAO em andamento: a etapa aparece sem pedir a senha de novo', async () => {
    for (const etapa of ['VERIFICACAO', 'LIBERACAO']) {
      const pg = await abrir({ 'GET /auth/mfa/estado': ok({ etapa, expiraEm: EXPIRA }) });
      assert.deepEqual(pg.etapasVisiveis(), [etapa]);
    }
  });

  test('CADASTRO e RECUPERACAO em andamento: sem QR guardado, a tela oferece gerar um novo', async () => {
    for (const etapa of ['CADASTRO', 'RECUPERACAO']) {
      const pg = await abrir({
        'GET /auth/mfa/estado': ok({ etapa, expiraEm: EXPIRA }),
        'POST /auth/mfa/cadastro/reiniciar': ok({ etapa, expiraEm: EXPIRA, cadastro: cadastro() }),
      });
      assert.deepEqual(pg.etapasVisiveis(), ['CADASTRO'], etapa);
      assert.equal(pg.el('cadastro-material').hidden, true);
      assert.equal(pg.foco(), 'botao-novo-qr');

      await pg.clicar('botao-novo-qr');
      assert.equal(pg.el('cadastro-material').hidden, false);
      conferirQr(pg, URI);
    }
  });

  test('SUBSTITUICAO pertence à página de segurança: aqui vale o login', async () => {
    const pg = await abrir({ 'GET /auth/mfa/estado': ok({ etapa: 'SUBSTITUICAO', expiraEm: EXPIRA }) });
    assert.deepEqual(pg.etapasVisiveis(), ['LOGIN']);
  });

  test('página restaurada pelo navegador: volta ao começo, limpa os campos e consulta o estado de novo', async () => {
    const pg = await emCadastro();
    await pg.digitar('codigo-cadastro', TOTP);
    const antes = pg.chamadas.length;

    await pg.eventoDaJanela('pageshow', { persisted: true });

    assert.equal(pg.chamadas[antes].chave, 'GET /auth/mfa/estado');
    assert.deepEqual(pg.etapasVisiveis(), ['LOGIN']);
    semSegredos(pg.textoDoDom(), 'o DOM restaurado');
    await pg.eventoDaJanela('pageshow', { persisted: false });
    assert.equal(pg.chamadas.length, antes + 1);
  });
});

describe('Voltar e limpeza ao sair de etapa sensível', () => {
  test('Voltar no cadastro: encerra o desafio no servidor, tira QR, chave e campos, e mostra o login', async () => {
    const pg = await emCadastro();
    await pg.digitar('codigo-cadastro', TOTP);
    await pg.clicar('botao-voltar-cadastro');

    assert.equal(ultima(pg).chave, 'POST /auth/logout');
    assert.deepEqual(pg.etapasVisiveis(), ['LOGIN']);
    assert.deepEqual([pg.el('cadastro-qr').children, pg.el('cadastro-chave').textContent, pg.el('codigo-cadastro').value], [[], '', '']);
    semSegredos(pg.textoDoDom(), 'o DOM depois de voltar');
    assert.deepEqual(pg.navegacoes, []);
  });

  test('Voltar na verificação e na liberação: mesmo caminho, campos limpos', async () => {
    for (const [etapa, campo, botao] of [['VERIFICACAO', 'codigo-verificacao', 'botao-voltar-verificacao'], ['LIBERACAO', 'codigo-liberacao', 'botao-voltar-liberacao']]) {
      const pg = await comSenha(etapa);
      await pg.digitar(campo, '123');
      await pg.clicar(botao);
      assert.equal(ultima(pg).chave, 'POST /auth/logout');
      assert.deepEqual([pg.etapasVisiveis(), pg.el(campo).value], [['LOGIN'], '']);
    }
  });

  test('uma etapa por vez em todo o percurso', async () => {
    const pg = await comCodigos();
    assert.equal(pg.etapasVisiveis().length, 1);
    const etapas = [...pg.documento.porId.values()].filter((e) => e.hasAttribute('data-etapa')).map((e) => e.getAttribute('data-etapa')).sort();
    assert.deepEqual(etapas, ['CADASTRO', 'CODIGOS', 'ENCERRADA', 'LIBERACAO', 'LOGIN', 'RECUPERACAO', 'VERIFICACAO']);
  });
});

describe('nada sensível fora do lugar', () => {
  async function percursoCompleto() {
    const pg = await comSenha('VERIFICACAO', {
      'POST /auth/mfa/verificar': CODIGO_INVALIDO,
      'POST /auth/mfa/recuperacao': ok({ etapa: 'RECUPERACAO', expiraEm: EXPIRA, cadastro: cadastro() }),
      'POST /auth/mfa/cadastro/reiniciar': ok({ etapa: 'RECUPERACAO', expiraEm: EXPIRA, cadastro: cadastro(URI_2, CHAVE_2) }),
      'POST /auth/mfa/cadastro/confirmar': ok({ codigosRecuperacao: CODIGOS }),
    });
    await pg.digitar('codigo-verificacao', TOTP);
    await pg.enviar('etapa-verificacao');
    await pg.clicar('botao-usar-recuperacao');
    await pg.digitar('codigo-recuperacao', RECUPERACAO);
    await pg.enviar('etapa-recuperacao');
    await pg.clicar('botao-copiar-chave');
    await pg.clicar('botao-novo-qr');
    await pg.digitar('codigo-cadastro', TOTP);
    await pg.enviar('etapa-cadastro');
    await pg.clicar('botao-copiar-codigos');
    await pg.marcar('confirmo-codigos');
    await pg.clicar('botao-codigos-salvos');
    return pg;
  }

  test('nenhum uso de localStorage ou sessionStorage, nem mudança de URL ou histórico com dado sensível', async () => {
    const pg = await percursoCompleto();
    assert.deepEqual(pg.navegacoes, ['painel.html']);
    assert.deepEqual(pg.storage, []);
    assert.deepEqual(pg.historico, []);
    assert.deepEqual(pg.chamadas.filter((c) => c.temQuery), [], 'nada vai por query string');
    assert.deepEqual([...new Set(pg.chamadas.map((c) => c.credentials))], ['include']);
  });

  test('console: só método, caminho e status; nenhuma senha, código, chave, URI ou recovery code', async () => {
    const pg = await percursoCompleto();
    assert.ok(pg.consoleChamadas.length > 0);
    semSegredos(pg.consoleChamadas.map((c) => c.texto).join('\n'), 'o console');
  });

  test('mensagens ao usuário nunca repetem o que ele digitou nem o que o servidor entregou em segredo', async () => {
    const pg = await comCodigos();
    await pg.clicar('botao-copiar-codigos');
    semSegredos(pg.el('mensagem').textContent, 'a mensagem');
  });

  test('os scripts da página não usam storage, innerHTML, document.write, eval nem escrevem no console', () => {
    const pg = abrirPagina(PAGINA, { rotas: base() });
    const proprios = pg.scripts.map((s) => s.split('?')[0]).filter((s) => !s.includes('vendor/') && !s.endsWith('js/api-http.js'));
    assert.ok(proprios.some((s) => s.endsWith('mfa.js')), 'a página carrega o módulo do MFA');
    for (const src of proprios) {
      const codigo = fs.readFileSync(path.join(RAIZ, 'painel-privado', src), 'utf8');
      for (const proibido of [/localStorage/, /sessionStorage/, /\.innerHTML/, /\.outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /console\./, /createSvgTag|createImgTag|createTableTag|createDataURL/]) {
        assert.equal(proibido.test(codigo), false, `${src} usa ${proibido}`);
      }
    }
  });
});

describe('QR Code gerado no navegador', () => {
  test('biblioteca incorporada: arquivo idêntico ao publicado (SHA-256), procedência e licença registradas', () => {
    assert.ok(fs.existsSync(VENDOR_QR), 'vendor/qrcode-generator-2.0.4.js ainda não foi incorporado');
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(VENDOR_QR)).digest('hex'), SHA256_QR);
    const registro = fs.readFileSync(path.join(RAIZ, 'vendor/README.md'), 'utf8');
    assert.match(registro, /qrcode-generator 2\.0\.4/);
    assert.ok(registro.includes(SHA256_QR));
    assert.match(fs.readFileSync(path.join(RAIZ, 'vendor/LICENSE-qrcode-generator.txt'), 'utf8'), /MIT License[\s\S]*Kazuhiko Arase/);
  });

  test('nenhuma requisição além da API; a URI não sai do navegador', async () => {
    const pg = await emCadastro();
    assert.deepEqual(pg.externas, []);
    assert.deepEqual(chaves(pg), ['GET /auth/mfa/estado', 'POST /auth/login', 'POST /auth/mfa/liberacao']);
    for (const c of pg.chamadas) semSegredos(c.corpoBruto ?? '', 'o corpo enviado', [URI, 'otpauth://', SEGREDO, CHAVE]);
  });

  test('a página só carrega scripts, estilos e imagens locais', () => {
    const html = fs.readFileSync(path.join(RAIZ, PAGINA), 'utf8');
    const recursos = [...html.matchAll(/<(?:script|link|img|iframe|object|embed)\b[^>]*\b(?:src|href|data)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(recursos.some((r) => r.includes('vendor/qrcode-generator-2.0.4.js')), 'a biblioteca local é carregada pela página');
    for (const r of recursos) assert.equal(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(r), false, `recurso externo: ${r}`);
    assert.equal(/googleapis|chart\.apis|qrserver|cdn\./i.test(html), false);
  });
});

describe('acessibilidade da marcação', () => {
  const html = fs.readFileSync(path.join(RAIZ, PAGINA), 'utf8');
  const tag = (id) => {
    const m = html.match(new RegExp(`<[a-zA-Z0-9]+\\b[^<>]*\\bid="${id}"[^<>]*>`));
    assert.ok(m, `index.html não tem #${id}`);
    return m[0];
  };

  test('mensagens em região aria-live; título da etapa focalizável', () => {
    assert.match(tag('mensagem'), /aria-live="(?:polite|assertive)"/);
    assert.match(tag('titulo-etapa'), /<h1\b[^>]*tabindex="-1"/);
  });

  test('todo campo tem label própria', () => {
    for (const id of ['email', 'senha', 'codigo-verificacao', 'codigo-recuperacao', 'codigo-liberacao', 'codigo-cadastro', 'confirmo-codigos']) {
      tag(id);
      assert.match(html, new RegExp(`<label\\b[^>]*\\bfor="${id}"`), `#${id} sem label`);
    }
  });

  test('códigos TOTP: texto com teclado numérico, one-time-code, 6 posições; nunca type=number', () => {
    for (const id of ['codigo-verificacao', 'codigo-cadastro']) {
      const t = tag(id);
      for (const atributo of [/type="text"/, /inputmode="numeric"/, /autocomplete="one-time-code"/, /maxlength="6"/]) assert.match(t, atributo, `${id}: ${atributo}`);
    }
    assert.equal(/type="number"/.test(html), false);
  });

  test('senha, códigos de liberação e de recuperação com autocomplete adequado', () => {
    assert.match(tag('senha'), /type="password"[^>]*autocomplete="current-password"/);
    for (const id of ['codigo-recuperacao', 'codigo-liberacao']) {
      const t = tag(id);
      for (const atributo of [/type="text"/, /autocomplete="off"/, /spellcheck="false"/, /maxlength="64"/]) assert.match(t, atributo, `${id}: ${atributo}`);
    }
  });

  test('só o login nasce visível; botões declaram o tipo; ações esperadas presentes', () => {
    for (const id of ['etapa-verificacao', 'etapa-recuperacao', 'etapa-liberacao', 'etapa-cadastro', 'etapa-codigos', 'etapa-encerrada']) assert.match(tag(id), /\bhidden\b/, id);
    assert.equal(/\bhidden\b/.test(tag('form-login')), false);
    for (const b of html.match(/<button\b[^>]*>/g)) assert.match(b, /type="(?:submit|button)"/, b);
    for (const [id, rotulo] of [['botao-verificar', 'Verificar código'], ['botao-usar-recuperacao', 'Usar código de recuperação'], ['botao-copiar-chave', 'Copiar chave'],
      ['botao-copiar-codigos', 'Copiar códigos'], ['botao-codigos-salvos', 'Já salvei meus códigos'], ['botao-entrar-novamente', 'Entrar novamente'], ['botao-voltar-cadastro', 'Voltar']]) {
      assert.match(html, new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>${rotulo}</button>`), id);
    }
    assert.equal(/desativar/i.test(html), false, 'não existe desativação de MFA');
  });
});
