'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');
const {
  EMAIL, SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, ok, erro, SENHA_ALTERADA, SENHA_CURTA, MENSAGEM_SENHA_CURTA, ATAQUE, semSegredos, tagDe, inspecionarScripts,
  externosDe, rotasDoBackend, camposDoCorpo,
} = require('./helpers/ciclo-senha');

/**
 * Troca de senha autenticada no Portal do Cliente (Bloco 11F): página própria
 * (portal/trocar-senha.html), que exige a sessão global, pede a senha atual, a
 * nova e a confirmação (só da tela) e mantém a sessão depois da troca.
 */

const PAGINA = 'portal/trocar-senha.html';
const ME = 'GET /auth/global/me';
const TROCAR = 'POST /auth/global/senha';
const EMPRESA = { id: 1, nome: 'Empresa Alfa', cnpj: '11222333000181', perfil: 'USUARIO' };
const COM_EMPRESA = ok({ identidade: { id: 7, email: EMAIL }, empresas: [EMPRESA], contexto: { usuario: { id: 3, nome: 'Pessoa Teste', email: EMAIL, perfil: 'USUARIO' }, empresa: EMPRESA } });
const SO_GLOBAL = ok({ identidade: { id: 7, email: EMAIL }, empresas: [EMPRESA], contexto: null });

const abrir = (rotas = {}, opcoes = {}) => abrirPagina(PAGINA, { rotas: { [ME]: COM_EMPRESA, [TROCAR]: SENHA_ALTERADA, ...rotas }, ...opcoes });
async function abrirComSessao(rotas, opcoes) {
  const pg = abrir(rotas, opcoes);
  await pg.esperar();
  return pg;
}
const trocasDe = (pg) => pg.chamadas.filter((c) => c.chave === TROCAR);
async function preencher(pg, atual = SENHA_ATUAL, nova = SENHA_NOVA, confirmacao = nova) {
  await pg.digitar('senha-atual', atual);
  await pg.digitar('senha-nova', nova);
  await pg.digitar('senha-confirmacao', confirmacao);
}
async function trocar(pg, ...campos) {
  await preencher(pg, ...campos);
  await pg.clicar('botao-trocar');
}
const campos = (pg) => ['senha-atual', 'senha-nova', 'senha-confirmacao'].map((id) => pg.el(id).value);

describe('Portal — entrada pela página inicial', () => {
  test('a página inicial leva à troca de senha por um link, dentro da área que só aparece com a sessão confirmada', () => {
    const html = semComentariosHtml(ler('portal/inicio.html'));
    const link = html.match(/<a\b[^>]*\bhref="trocar-senha\.html"[^>]*>\s*Trocar senha\s*<\/a>/i);
    assert.ok(link, 'portal/inicio.html não tem o link "Trocar senha" para trocar-senha.html');
    const area = html.slice(html.indexOf('<nav id="acoes"'), html.indexOf('</nav>'));
    assert.ok(area.includes(link[0]), 'o link fica em #acoes, oculto até a sessão ser confirmada');
    assert.equal(/trocar-senha\.html/.test(semComentariosHtml(ler('portal/index.html'))), false, 'o login não leva à troca autenticada');
  });
});

describe(`Portal — troca de senha autenticada (${PAGINA})`, () => {
  test('marcação: página própria, sem referrer vazado, sem script externo, três campos de senha com rótulo e autocomplete certos, envio e retorno', () => {
    const html = ler(PAGINA);
    const limpo = semComentariosHtml(html);
    assert.match(limpo, /<meta name="referrer" content="no-referrer">/);
    assert.match(limpo, /<html lang="pt-BR">/);
    assert.deepEqual(externosDe(PAGINA), []);
    assert.match(tagDe(html, 'form-troca'), /\bnovalidate\b/);
    assert.match(tagDe(html, 'senha-atual'), /autocomplete="current-password"/);
    for (const id of ['senha-nova', 'senha-confirmacao']) assert.match(tagDe(html, id), /autocomplete="new-password"/, id);
    for (const id of ['senha-atual', 'senha-nova', 'senha-confirmacao']) {
      assert.match(tagDe(html, id), /type="password"/, id);
      assert.match(limpo, new RegExp(`<label\\b[^>]*\\bfor="${id}"`), `#${id} sem label`);
    }
    assert.match(tagDe(html, 'botao-trocar'), /type="submit"/);
    assert.match(tagDe(html, 'mensagem'), /aria-live="(?:polite|assertive)"/);
    tagDe(html, 'sucesso');
    assert.match(limpo, /<a\b[^>]*\bhref="inicio\.html"/, 'há caminho de volta ao início');
    assert.doesNotMatch(limpo, /<form\b[^>]*\b(action|method)=/i);
  });

  describe('sessão global exigida', () => {
    test('o formulário só aparece depois de a sessão global ser confirmada pelo servidor', async () => {
      let liberar;
      const presa = new Promise((resolve) => { liberar = resolve; });
      const pg = abrir({ [ME]: () => presa });
      await pg.esperar();
      assert.equal(pg.visivel('form-troca'), false);
      liberar(COM_EMPRESA);
      await pg.esperar();
      assert.equal(pg.visivel('form-troca'), true);
      assert.deepEqual(pg.chamadas.map((c) => c.chave), [ME]);
    });

    test('só com a sessão global, sem empresa selecionada, a troca continua disponível', async () => {
      const pg = await abrirComSessao({ [ME]: SO_GLOBAL });
      assert.equal(pg.visivel('form-troca'), true);
      assert.deepEqual(pg.navegacoes, []);
    });

    test('sem sessão (401): vai ao login, o formulário não aparece e nada é enviado', async () => {
      const pg = await abrirComSessao({ [ME]: erro(401, 'SESSAO_INVALIDA', 'Sessão inválida ou expirada') });
      assert.deepEqual(pg.navegacoes, ['index.html']);
      assert.equal(pg.visivel('form-troca'), false);
      assert.deepEqual(trocasDe(pg), []);
    });

    test('falha ao confirmar a sessão (500 ou rede): mensagem, formulário fora e sem ir ao login', async () => {
      for (const falha of [erro(500, 'ERRO_INTERNO', 'Erro interno do servidor'), new Error('sem rede')]) {
        const pg = await abrirComSessao({ [ME]: falha });
        assert.equal(pg.visivel('form-troca'), false);
        assert.notEqual(pg.texto('mensagem').trim(), '');
        assert.deepEqual(pg.navegacoes, []);
      }
    });
  });

  test('com os três campos: POST com senhaAtual e novaSenha só no corpo, a confirmação nunca vai, campos limpos, sucesso à vista e a sessão mantida', async () => {
    const pg = await abrirComSessao();
    await trocar(pg);
    assert.deepEqual(trocasDe(pg).map((c) => [c.corpo, c.temQuery, c.credentials]), [[{ senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA }, false, 'include']]);
    semSegredos(trocasDe(pg)[0].url, 'a URL', [SENHA_ATUAL, SENHA_NOVA]);
    assert.equal(pg.visivel('sucesso'), true);
    assert.match(pg.texto('sucesso'), /alterad/i);
    assert.deepEqual(campos(pg), ['', '', '']);
    assert.deepEqual(pg.navegacoes, [], 'a sessão continua válida: ninguém vai ao login');
    assert.deepEqual(pg.chamadas.map((c) => c.chave).filter((k) => /login|logout/.test(k)), []);
    assert.equal(pg.consulta('a[href="inicio.html"]').filter((a) => pg.visivelNo(a)).length >= 1, true, 'dá para voltar ao início sem entrar de novo');
    semSegredos(pg.textoDoDom(), 'o DOM', [SENHA_ATUAL, SENHA_NOVA]);
  });

  test('enquanto a requisição está pendente o botão fica desabilitado e um segundo envio não gera outra chamada', async () => {
    let liberar;
    const presa = new Promise((resolve) => { liberar = resolve; });
    const pg = await abrirComSessao({ [TROCAR]: () => presa });
    await preencher(pg);
    const primeiro = pg.enviarSemEsperar('form-troca');
    await pg.esperar();
    assert.equal(pg.el('botao-trocar').disabled, true);
    await preencher(pg);
    await pg.enviarSemEsperar('form-troca');
    await pg.esperar();
    assert.equal(trocasDe(pg).length, 1);
    liberar(SENHA_ALTERADA);
    await primeiro;
    await pg.esperar();
    assert.equal(pg.visivel('sucesso'), true);
    assert.equal(trocasDe(pg).length, 1);
  });

  for (const [caso, atual, nova, confirmacao, esperado] of [
    ['senha atual vazia', '', SENHA_NOVA, SENHA_NOVA, /senha atual|preench|informe/i],
    ['nova senha vazia', SENHA_ATUAL, '', '', /nova senha|preench|informe/i],
    ['confirmação diferente da nova senha', SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, /confirma/i],
  ]) {
    test(`${caso}: nada vai ao servidor, a mensagem aparece e o formulário continua`, async () => {
      const pg = await abrirComSessao();
      await trocar(pg, atual, nova, confirmacao);
      assert.deepEqual(trocasDe(pg), []);
      assert.match(pg.texto('mensagem'), esperado);
      assert.equal(pg.visivel('form-troca'), true);
      assert.equal(pg.visivel('sucesso'), false);
    });
  }

  test('401 de sessão (SESSAO_INVALIDA): limpa os campos, esconde o formulário e vai ao login', async () => {
    const pg = await abrirComSessao({ [TROCAR]: erro(401, 'SESSAO_INVALIDA', 'Sessão inválida ou expirada') });
    await trocar(pg);
    assert.deepEqual(pg.navegacoes, ['index.html']);
    assert.equal(pg.visivel('form-troca'), false);
    assert.deepEqual(campos(pg), ['', '', '']);
    semSegredos(pg.textoDoDom(), 'o DOM', [SENHA_ATUAL, SENHA_NOVA]);
  });

  for (const [caso, falha, esperado] of [
    ['senha atual incorreta (401 próprio, não é sessão expirada)', erro(401, 'SENHA_ATUAL_INVALIDA', 'Senha atual incorreta'), /senha atual/i],
    ['cooldown do login', erro(429, 'LOGIN_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde'), /muitas|aguard|tente novamente/i],
    ['limite de requisições', erro(429, 'LIMITE_REQUISICOES_EXCEDIDO', 'Muitas requisições. Tente novamente mais tarde'), /muitas|aguard|tente novamente/i],
    ['nova senha igual à atual', erro(400, 'SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual'), /diferente/i],
    ['nova senha fora da política', SENHA_CURTA, new RegExp(MENSAGEM_SENHA_CURTA)],
    ['erro interno', erro(500, 'ERRO_INTERNO', 'Erro interno do servidor'), /erro|não foi possível|tente/i],
    ['falha de rede', new Error('sem rede'), /conex|servidor/i],
  ]) {
    test(`${caso}: mensagem própria, sem ir ao login, campos limpos, formulário mantido e nova tentativa possível`, async () => {
      let tentativas = 0;
      const pg = await abrirComSessao({ [TROCAR]: () => { tentativas += 1; return tentativas === 1 ? falha : SENHA_ALTERADA; } });
      await trocar(pg);
      assert.match(pg.texto('mensagem'), esperado);
      assert.doesNotMatch(pg.texto('mensagem'), /sess[ãa]o/i, 'não é tratado como sessão expirada');
      assert.deepEqual(pg.navegacoes, []);
      assert.equal(pg.visivel('form-troca'), true);
      assert.equal(pg.visivel('sucesso'), false);
      assert.deepEqual(campos(pg), ['', '', '']);
      assert.equal(pg.el('botao-trocar').disabled, false);

      await trocar(pg, SENHA_ATUAL, OUTRA_SENHA);
      assert.deepEqual(trocasDe(pg).map((c) => c.corpo.novaSenha), [SENHA_NOVA, OUTRA_SENHA]);
      assert.equal(pg.visivel('sucesso'), true);
    });
  }

  test('o que vem do servidor entra na tela como texto, nunca como HTML', async () => {
    const pg = await abrirComSessao({ [TROCAR]: erro(400, 'OUTRO_CODIGO', ATAQUE, [{ campo: 'body.novaSenha', codigo: 'X', mensagem: ATAQUE }]) });
    await trocar(pg);
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    assert.equal(pg.consulta('img').length, 0);
  });

  test('nada sensível fora do lugar: sem storage, cookie, rede externa, innerHTML nem console com senha', async () => {
    let tentativas = 0;
    const pg = await abrirComSessao({ [TROCAR]: () => { tentativas += 1; return tentativas === 1 ? SENHA_CURTA : SENHA_ALTERADA; } });
    await trocar(pg);
    await trocar(pg, SENHA_ATUAL, OUTRA_SENHA);
    assert.equal(pg.visivel('sucesso'), true);
    assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.externas, pg.documento.usosDeInnerHTML, pg.alertas], [[], [], [], [], []]);
    assert.ok(pg.consoleChamadas.length > 0, 'o cliente HTTP registra método, caminho e status');
    const segredos = [SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA];
    semSegredos(pg.consoleChamadas.map((c) => c.texto).join('\n'), 'o console', segredos);
    semSegredos(pg.textoDoDom(), 'o DOM', segredos);
    for (const c of pg.chamadas) semSegredos(c.url, 'a URL', segredos);
  });

  test('os scripts da página não usam storage, cookie, HTML inseguro, eval, console nem navegação pelo histórico', () => {
    assert.ok(inspecionarScripts(PAGINA).length > 0);
  });

  test('contrato com o backend: as chamadas da página são rotas do backend e o corpo tem exatamente os campos do schema', async () => {
    const pg = await abrirComSessao();
    await trocar(pg);
    const declaradas = new Set([...rotasDoBackend('auth-global.routes.js'), ...rotasDoBackend('troca-senha.routes.js')]);
    assert.ok(trocasDe(pg).length === 1);
    for (const c of pg.chamadas) assert.ok(declaradas.has(`${c.metodo} ${c.caminho}`), `${c.chave} não é rota do backend`);
    assert.deepEqual(Object.keys(trocasDe(pg)[0].corpo).sort(), camposDoCorpo('troca-senha.schema.js', 'trocarPortal'));
  });
});
