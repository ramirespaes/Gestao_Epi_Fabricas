'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { abrirPagina, RAIZ, SVG_NS } = require('./helpers/dom-painel');

/**
 * Segurança da conta no Painel Privado: trocar o autenticador e gerar novos
 * códigos de recuperação. As duas operações pedem senha e TOTP atual e
 * terminam sem sessão: os códigos novos aparecem e depois só resta o login.
 */

const PAGINA = 'painel-privado/seguranca.html';
const EMAIL = 'admin@safework.test';
const SENHA = 'frase-longa-de-teste-42';
const SEGREDO = 'KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU';
const CHAVE = 'KRSX G5CT MVRX EZLU KRSX G5CT MVRX EZLU';
const URI = `otpauth://totp/SafeWork:admin%40safework.test?issuer=SafeWork&secret=${SEGREDO}&algorithm=SHA1&digits=6&period=30`;
const CODIGOS = ['0A1B-2C3D-4E5F-6G7H', '1B2C-3D4E-5F6G-7H8J', '2C3D-4E5F-6G7H-8J9K', '3D4E-5F6G-7H8J-9KAM', '4E5F-6G7H-8J9K-AMBN',
  '5F6G-7H8J-9KAM-BNCP', '6G7H-8J9K-AMBN-CPDQ', '7H8J-9KAM-BNCP-DQER', '8J9K-AMBN-CPDQ-ERFS', '9KAM-BNCP-DQER-FSGT'];
const TOTP_ATUAL = '004711';
const TOTP_NOVO = '090807';
const EXPIRA = '2026-09-28T12:15:00.000Z';
const SEGREDOS = [SENHA, SEGREDO, CHAVE, CHAVE.replace(/ /g, ''), URI, 'otpauth://', TOTP_ATUAL, TOTP_NOVO, ...CODIGOS];

const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
const erro = (status, codigo, message) => ({ status, corpo: { status: 'error', codigo, message } });
const SESSAO_INVALIDA = erro(401, 'SESSAO_INVALIDA', 'Sessão inválida ou expirada');
const chaves = (pg) => pg.chamadas.map((c) => c.chave);
const ultima = (pg) => pg.chamadas[pg.chamadas.length - 1];

function semSegredos(texto, onde, lista = SEGREDOS) {
  for (const valor of lista) assert.equal(texto.includes(valor), false, `${onde} contém dado sensível`);
}

const base = (extra = {}) => ({
  'GET /auth/me': ok({ administrador: { id: 1, email: EMAIL } }),
  'POST /auth/logout': ok(),
  'POST /auth/mfa/substituicao/iniciar': ok({ etapa: 'SUBSTITUICAO', expiraEm: EXPIRA, cadastro: { uri: URI, chaveManual: CHAVE } }),
  'POST /auth/mfa/substituicao/confirmar': ok({ codigosRecuperacao: CODIGOS }),
  'POST /auth/mfa/recuperacao/regenerar': ok({ codigosRecuperacao: CODIGOS }),
  ...extra,
});

async function abrir(rotas) {
  const pg = abrirPagina(PAGINA, { rotas: base(rotas) });
  await pg.esperar();
  return pg;
}

async function reautenticar(pg, botao) {
  await pg.clicar(botao);
  await pg.digitar('senha-atual', SENHA);
  await pg.digitar('codigo-atual', TOTP_ATUAL);
  await pg.enviar('etapa-reautenticacao');
}

async function comNovoQr(rotas) {
  const pg = await abrir(rotas);
  await reautenticar(pg, 'botao-trocar-autenticador');
  return pg;
}

async function salvarCodigos(pg) {
  await pg.marcar('confirmo-codigos');
  await pg.clicar('botao-codigos-salvos');
}

describe('acesso à página de segurança', () => {
  test('painel.html leva à página de segurança e continua com 3 scripts versionados', () => {
    const html = fs.readFileSync(path.join(RAIZ, 'painel-privado/painel.html'), 'utf8');
    assert.match(html, /<a\b[^>]*href="seguranca\.html"/);
    assert.equal([...html.matchAll(/<script src="([^"]+)"><\/script>/g)].length, 3);
  });

  test('com sessão: conteúdo aparece só depois da confirmação, no menu; sem sessão: nada aparece e vai ao login', async () => {
    const pg = abrirPagina(PAGINA, { rotas: base() });
    assert.equal(pg.el('conteudo').hidden, true, 'oculto antes de confirmar a sessão');
    await pg.esperar();
    assert.equal(pg.el('conteudo').hidden, false);
    assert.deepEqual([chaves(pg), pg.etapasVisiveis(), pg.navegacoes], [['GET /auth/me'], ['MENU'], []]);

    const semSessao = await abrir({ 'GET /auth/me': SESSAO_INVALIDA });
    assert.deepEqual([semSessao.el('conteudo').hidden, semSessao.navegacoes], [true, ['index.html']]);
  });

  test('Sair: limpa a tela antes do logout e vai ao login', async () => {
    const pg = await comNovoQr();
    await pg.clicar('sair');
    assert.equal(ultima(pg).chave, 'POST /auth/logout');
    assert.equal(pg.el('conteudo').hidden, true);
    semSegredos(pg.textoDoDom(), 'o DOM depois de sair');
    assert.deepEqual(pg.navegacoes, ['index.html']);
  });

  test('página restaurada pelo navegador: esconde, limpa e confirma a sessão de novo', async () => {
    const pg = await comNovoQr();
    const antes = pg.chamadas.length;
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.equal(pg.chamadas[antes].chave, 'GET /auth/me');
    assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    semSegredos(pg.textoDoDom(), 'o DOM restaurado');
  });
});

describe('troca do autenticador (SUBSTITUICAO)', () => {
  test('pede senha e TOTP atual; aceitos, mostra o QR novo e a chave; a senha sai do campo', async () => {
    const pg = await abrir();
    await pg.clicar('botao-trocar-autenticador');
    assert.deepEqual(pg.etapasVisiveis(), ['REAUTENTICACAO']);
    assert.equal(pg.foco(), 'senha-atual');
    assert.match(pg.el('titulo-etapa').textContent, /trocar/i);

    await pg.digitar('senha-atual', SENHA);
    await pg.digitar('codigo-atual', TOTP_ATUAL);
    await pg.enviar('etapa-reautenticacao');

    assert.equal(ultima(pg).chave, 'POST /auth/mfa/substituicao/iniciar');
    assert.deepEqual(ultima(pg).corpo, { senha: SENHA, codigo: TOTP_ATUAL });
    assert.deepEqual(pg.etapasVisiveis(), ['CADASTRO']);
    assert.deepEqual([pg.el('senha-atual').value, pg.el('codigo-atual').value], ['', '']);
    assert.deepEqual(pg.el('cadastro-qr').children.map((f) => [f.tagName, f.namespaceURI]), [['svg', SVG_NS]]);
    assert.equal(pg.el('cadastro-chave').textContent, CHAVE);
    assert.equal(pg.foco(), 'codigo-cadastro');
    semSegredos(pg.textoDoDom(), 'o DOM', [URI, 'otpauth://', SEGREDO, SENHA, TOTP_ATUAL]);
  });

  test('TOTP novo confirmado: mostra os códigos; não há sessão nova, não vai ao painel; depois de salvos, só o login', async () => {
    const pg = await comNovoQr();
    await pg.digitar('codigo-cadastro', TOTP_NOVO);
    await pg.enviar('etapa-cadastro');

    assert.equal(ultima(pg).chave, 'POST /auth/mfa/substituicao/confirmar');
    assert.deepEqual(ultima(pg).corpo, { codigo: TOTP_NOVO });
    assert.deepEqual(pg.etapasVisiveis(), ['CODIGOS']);
    assert.deepEqual(pg.el('lista-codigos').children.map((li) => li.textContent), CODIGOS);
    assert.deepEqual([pg.el('cadastro-qr').children, pg.el('cadastro-chave').textContent], [[], '']);
    assert.deepEqual(pg.navegacoes, [], 'não navega antes de o usuário ver os códigos');
    assert.match(pg.el('mensagem').textContent, /entrar novamente|novo login|entre novamente/i);
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 1);
    const antes = pg.chamadas.length;

    await pg.clicar('botao-copiar-codigos');
    assert.deepEqual(pg.copiados, [CODIGOS.join('\n')]);
    assert.equal(pg.el('botao-codigos-salvos').disabled, true);
    await salvarCodigos(pg);

    assert.deepEqual(pg.el('lista-codigos').children, []);
    semSegredos(pg.textoDoDom(), 'o DOM depois de sair dos códigos');
    assert.deepEqual(pg.navegacoes, ['index.html']);
    assert.equal(pg.chamadas.length, antes, 'nenhuma chamada tenta reaproveitar a sessão');
    assert.equal(pg.ouvintesDaJanela('beforeunload'), 0);
  });

  test('Voltar com o QR novo na tela: some com QR e chave e retorna ao menu sem encerrar a sessão', async () => {
    const pg = await comNovoQr();
    const antes = pg.chamadas.length;
    await pg.digitar('codigo-cadastro', '09');
    await pg.clicar('botao-voltar-cadastro');

    assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    assert.equal(pg.chamadas.length, antes, 'Voltar não chama o logout');
    assert.deepEqual([pg.el('cadastro-qr').children, pg.el('cadastro-chave').textContent, pg.el('codigo-cadastro').value], [[], '', '']);
  });

  test('desafio expirado, cadastro expirado ou TOTP novo errado na confirmação', async () => {
    const casos = [
      [erro(401, 'DESAFIO_INVALIDO', 'Etapa de verificação inválida ou expirada'), ['MENU'], /expirou/i],
      [erro(409, 'MFA_CADASTRO_EXPIRADO', 'O cadastro expirou'), ['MENU'], /expirou/i],
      [erro(401, 'MFA_CODIGO_INVALIDO', 'Código inválido'), ['CADASTRO'], /inválido/i],
    ];
    for (const [resposta, etapas, mensagem] of casos) {
      const pg = await comNovoQr({ 'POST /auth/mfa/substituicao/confirmar': resposta });
      await pg.digitar('codigo-cadastro', TOTP_NOVO);
      await pg.enviar('etapa-cadastro');
      assert.deepEqual(pg.etapasVisiveis(), etapas);
      assert.match(pg.el('mensagem').textContent, mensagem);
      assert.equal(pg.el('codigo-cadastro').value, '');
      assert.deepEqual(pg.navegacoes, []);
      if (etapas[0] === 'MENU') assert.deepEqual([pg.el('cadastro-qr').children, pg.el('cadastro-chave').textContent], [[], '']);
    }
  });
});

describe('novos códigos de recuperação (REGENERACAO)', () => {
  test('senha e TOTP aceitos: os 10 códigos aparecem antes de qualquer navegação; depois de salvos, login', async () => {
    const pg = await abrir();
    await pg.clicar('botao-gerar-codigos');
    assert.deepEqual(pg.etapasVisiveis(), ['REAUTENTICACAO']);
    assert.match(pg.el('titulo-etapa').textContent, /códigos de recuperação/i);
    await pg.digitar('senha-atual', SENHA);
    await pg.digitar('codigo-atual', TOTP_ATUAL);
    await pg.enviar('etapa-reautenticacao');

    assert.equal(ultima(pg).chave, 'POST /auth/mfa/recuperacao/regenerar');
    assert.deepEqual(ultima(pg).corpo, { senha: SENHA, codigo: TOTP_ATUAL });
    assert.deepEqual(pg.etapasVisiveis(), ['CODIGOS']);
    assert.deepEqual(pg.el('lista-codigos').children.map((li) => li.textContent), CODIGOS);
    assert.deepEqual([pg.el('senha-atual').value, pg.el('codigo-atual').value], ['', '']);
    assert.deepEqual(pg.navegacoes, []);

    await salvarCodigos(pg);
    assert.deepEqual(pg.navegacoes, ['index.html']);
    semSegredos(pg.textoDoDom(), 'o DOM depois de sair dos códigos');
  });

  test('resposta sem os 10 códigos: resposta inesperada, nada é listado', async () => {
    const pg = await abrir({ 'POST /auth/mfa/recuperacao/regenerar': ok({}) });
    await reautenticar(pg, 'botao-gerar-codigos');
    assert.match(pg.el('mensagem').textContent, /inesperada/i);
    assert.deepEqual(pg.el('lista-codigos').children, []);
  });
});

describe('reautenticação: erros e envio único', () => {
  test('senha ou código recusados: mesma etapa, os dois campos limpos, foco na senha, mensagem genérica', async () => {
    const pg = await abrir({ 'POST /auth/mfa/substituicao/iniciar': erro(401, 'REAUTENTICACAO_INVALIDA', 'Senha ou código inválidos') });
    await reautenticar(pg, 'botao-trocar-autenticador');

    assert.deepEqual(pg.etapasVisiveis(), ['REAUTENTICACAO']);
    assert.deepEqual([pg.el('senha-atual').value, pg.el('codigo-atual').value, pg.foco()], ['', '', 'senha-atual']);
    assert.match(pg.el('mensagem').textContent, /senha ou código/i);
    semSegredos(pg.el('mensagem').textContent, 'a mensagem');
  });

  test('sessão inválida: limpa a tela e vai ao login', async () => {
    const pg = await abrir({ 'POST /auth/mfa/recuperacao/regenerar': SESSAO_INVALIDA });
    await reautenticar(pg, 'botao-gerar-codigos');
    assert.deepEqual(pg.navegacoes, ['index.html']);
    assert.equal(pg.el('conteudo').hidden, true);
    semSegredos(pg.textoDoDom(), 'o DOM');
  });

  test('cooldown, MFA indisponível e rede: mensagem própria, mesma etapa, senha limpa', async () => {
    const casos = [
      [erro(429, 'MFA_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde'), /aguarde/i],
      [erro(503, 'MFA_INDISPONIVEL', 'Verificação em duas etapas indisponível no momento'), /indisponível/i],
      [new Error('falha de rede'), /conexão/i],
    ];
    for (const [resposta, mensagem] of casos) {
      const pg = await abrir({ 'POST /auth/mfa/substituicao/iniciar': resposta });
      await reautenticar(pg, 'botao-trocar-autenticador');
      assert.deepEqual(pg.etapasVisiveis(), ['REAUTENTICACAO']);
      assert.match(pg.el('mensagem').textContent, mensagem);
      assert.equal(pg.el('senha-atual').value, '');
      assert.equal(pg.el('botao-reautenticar').disabled, false);
    }
  });

  test('senha vazia ou código incompleto não vão ao servidor', async () => {
    const pg = await abrir();
    await pg.clicar('botao-trocar-autenticador');
    const antes = pg.chamadas.length;
    await pg.digitar('senha-atual', SENHA);
    await pg.digitar('codigo-atual', '0047');
    await pg.enviar('etapa-reautenticacao');
    assert.equal(pg.chamadas.length, antes);
    assert.match(pg.el('mensagem').textContent, /6 dígitos/);

    await pg.digitar('senha-atual', '');
    await pg.digitar('codigo-atual', TOTP_ATUAL);
    await pg.enviar('etapa-reautenticacao');
    assert.equal(pg.chamadas.length, antes);
    assert.equal(pg.foco(), 'senha-atual');
  });

  test('zeros à esquerda preservados; envio repetido com a requisição pendente faz uma chamada só', async () => {
    let liberar;
    const pg = await abrir({ 'POST /auth/mfa/recuperacao/regenerar': () => new Promise((r) => { liberar = () => r(ok({ codigosRecuperacao: CODIGOS })); }) });
    await pg.clicar('botao-gerar-codigos');
    await pg.digitar('senha-atual', SENHA);
    await pg.digitar('codigo-atual', '000042');
    const antes = pg.chamadas.length;

    const a = pg.enviarSemEsperar('etapa-reautenticacao');
    await new Promise((r) => { setImmediate(r); });
    assert.equal(pg.el('botao-reautenticar').disabled, true);
    const b = pg.enviarSemEsperar('etapa-reautenticacao');
    liberar();
    await Promise.all([a, b]);
    await pg.esperar();

    assert.equal(pg.chamadas.length, antes + 1);
    assert.equal(ultima(pg).corpo.codigo, '000042');
    assert.match(ultima(pg).corpoBruto, /"codigo":"000042"/);
  });

  test('Voltar na reautenticação: campos limpos, menu de volta, sem chamada', async () => {
    const pg = await abrir();
    await pg.clicar('botao-gerar-codigos');
    await pg.digitar('senha-atual', SENHA);
    const antes = pg.chamadas.length;
    await pg.clicar('botao-voltar-reautenticacao');
    assert.deepEqual([pg.etapasVisiveis(), pg.el('senha-atual').value, pg.chamadas.length], [['MENU'], '', antes]);
  });
});

describe('nada sensível fora do lugar', () => {
  async function percurso() {
    const pg = await comNovoQr();
    await pg.clicar('botao-copiar-chave');
    await pg.digitar('codigo-cadastro', TOTP_NOVO);
    await pg.enviar('etapa-cadastro');
    await pg.clicar('botao-copiar-codigos');
    await salvarCodigos(pg);
    return pg;
  }

  test('sem storage, sem histórico, sem query string, sem rede externa, sem innerHTML', async () => {
    const pg = await percurso();
    assert.deepEqual([pg.storage, pg.historico, pg.externas, pg.documento.usosDeInnerHTML], [[], [], [], []]);
    assert.deepEqual(pg.chamadas.filter((c) => c.temQuery), []);
    assert.deepEqual(pg.navegacoes, ['index.html']);
  });

  test('console sem senha, códigos, chave, URI ou recovery codes', async () => {
    const pg = await percurso();
    assert.ok(pg.consoleChamadas.length > 0);
    semSegredos(pg.consoleChamadas.map((c) => c.texto).join('\n'), 'o console');
  });

  test('os scripts da página não usam storage, innerHTML, eval nem escrevem no console; recursos só locais', () => {
    const pg = abrirPagina(PAGINA, { rotas: base() });
    const proprios = pg.scripts.map((s) => s.split('?')[0]).filter((s) => !s.includes('vendor/') && !s.endsWith('js/api-http.js'));
    assert.deepEqual(proprios, ['config.js', 'mfa.js', 'seguranca.js']);
    for (const s of pg.scripts) assert.match(s, /\?v=\d{8,}/, `${s} sem versão`);
    for (const src of proprios) {
      const codigo = fs.readFileSync(path.join(RAIZ, 'painel-privado', src), 'utf8');
      for (const proibido of [/localStorage/, /sessionStorage/, /\.innerHTML/, /\.outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function/, /console\./, /history\.(back|forward|go)\b/]) {
        assert.equal(proibido.test(codigo), false, `${src} usa ${proibido}`);
      }
    }
    const recursos = [...pg.html.matchAll(/<(?:script|link|img|iframe|object|embed)\b[^>]*\b(?:src|href|data)="([^"]+)"/g)].map((m) => m[1]);
    for (const r of recursos) assert.equal(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(r), false, `recurso externo: ${r}`);
  });
});

describe('acessibilidade da marcação', () => {
  const html = () => {
    const arquivo = path.join(RAIZ, PAGINA);
    assert.ok(fs.existsSync(arquivo), `a página ${PAGINA} ainda não existe`);
    return fs.readFileSync(arquivo, 'utf8');
  };
  const tag = (id) => {
    const m = html().match(new RegExp(`<[a-zA-Z0-9]+\\b[^<>]*\\bid="${id}"[^<>]*>`));
    assert.ok(m, `seguranca.html não tem #${id}`);
    return m[0];
  };

  test('aria-live, labels, tipos e autocomplete dos campos', () => {
    assert.match(tag('mensagem'), /aria-live="(?:polite|assertive)"/);
    assert.match(tag('titulo-etapa'), /tabindex="-1"/);
    for (const id of ['senha-atual', 'codigo-atual', 'codigo-cadastro', 'confirmo-codigos']) {
      tag(id);
      assert.match(html(), new RegExp(`<label\\b[^>]*\\bfor="${id}"`), `#${id} sem label`);
    }
    assert.match(tag('senha-atual'), /type="password"[^>]*autocomplete="current-password"/);
    for (const id of ['codigo-atual', 'codigo-cadastro']) {
      for (const atributo of [/type="text"/, /inputmode="numeric"/, /autocomplete="one-time-code"/, /maxlength="6"/]) assert.match(tag(id), atributo, `${id}: ${atributo}`);
    }
    assert.equal(/type="number"/.test(html()), false);
  });

  test('conteúdo e etapas nascem ocultos, menos o menu; botões declaram o tipo; sem ação de desativar MFA', () => {
    assert.match(tag('conteudo'), /\bhidden\b/);
    for (const id of ['etapa-reautenticacao', 'etapa-cadastro', 'etapa-codigos']) assert.match(tag(id), /\bhidden\b/, id);
    assert.equal(/\bhidden\b/.test(tag('etapa-menu')), false);
    for (const b of html().match(/<button\b[^>]*>/g)) assert.match(b, /type="(?:submit|button)"/, b);
    for (const [id, rotulo] of [['botao-copiar-chave', 'Copiar chave'], ['botao-copiar-codigos', 'Copiar códigos'], ['botao-codigos-salvos', 'Já salvei meus códigos'],
      ['botao-voltar-cadastro', 'Voltar'], ['botao-voltar-reautenticacao', 'Voltar']]) {
      assert.match(html(), new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>${rotulo}</button>`), id);
    }
    assert.equal(/desativar/i.test(html()), false);
  });
});
