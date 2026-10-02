'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  abrirPagina, ler, semComentarios, semComentariosHtml, scriptsDe, arquivosLocaisDe, COM_ESQUEMA,
} = require('./dom-pagina');

/**
 * Apoio dos testes do frontend do ciclo de senha (Bloco 11F): fixtures
 * sintéticas, varredura estática dos scripts de uma página, leitura do contrato
 * do backend por texto e a suíte de redefinição pelo link, que vale igual para
 * o Portal e para o Painel Privado.
 */

const TOKEN = 'dGVzdGUtdG9rZW4tZGUtcmVkZWZpbmljYW8tc2ludGV0aWNv'.padEnd(43, 'x').slice(0, 43);
const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const OUTRA_SENHA = 'lanterna-cometa-ardosia-91';
const EMAIL = 'pessoa.teste@exemplo-cliente.com.br';
const OUTRO_EMAIL = 'outra.pessoa@exemplo-cliente.com.br';
const TOTP = '004711';

const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
const erro = (status, codigo, message, detalhes) => ({ status, corpo: { status: 'error', codigo, message, ...(detalhes ? { detalhes } : {}) } });
const SENHA_REDEFINIDA = { status: 200, corpo: { status: 'SENHA_REDEFINIDA' } };
const SENHA_ALTERADA = { status: 200, corpo: { status: 'SENHA_ALTERADA' } };
const SOLICITACAO_RECEBIDA = { status: 202, corpo: { status: 'SOLICITACAO_RECEBIDA' } };
const SENHA_CURTA = erro(400, 'VALIDACAO', 'Dados inválidos', [{ campo: 'body.novaSenha', codigo: 'SENHA_CURTA', mensagem: 'A senha deve ter pelo menos 12 caracteres' }]);
const MENSAGEM_SENHA_CURTA = 'A senha deve ter pelo menos 12 caracteres';
const ATAQUE = '<img src=x onerror=alert(1)>';

function semSegredos(texto, onde, lista) {
  for (const valor of lista) assert.equal(texto.includes(valor), false, `${onde} contém ${String(valor).slice(0, 12)}…`);
}

// ───────────────────────── marcação e scripts ─────────────────────────

const tagDe = (html, id) => {
  const m = semComentariosHtml(html).match(new RegExp(`<[a-zA-Z0-9]+\\b[^<>]*\\bid="${id}"[^<>]*>`));
  assert.ok(m, `a página não tem #${id}`);
  return m[0];
};

const PADROES_INSEGUROS = [
  [/localStorage/, 'localStorage'], [/sessionStorage/, 'sessionStorage'], [/indexedDB/, 'indexedDB'], [/document\.cookie/, 'document.cookie'],
  [/\.innerHTML/, 'innerHTML'], [/\.outerHTML/, 'outerHTML'], [/insertAdjacentHTML/, 'insertAdjacentHTML'], [/document\.write/, 'document.write'],
  [/\beval\(/, 'eval'], [/new Function/, 'new Function'], [/history\.(back|forward|go|pushState)\b/, 'history.back/forward/go/pushState'],
];

/** Todo script que a página carrega (locais e embutidos, menos vendor/): sem storage, HTML inseguro, eval, console ou navegação pelo histórico. */
function inspecionarScripts(pagina) {
  const arquivos = arquivosLocaisDe(pagina).filter((f) => f.endsWith('.js') && !f.startsWith('vendor/'));
  assert.ok(arquivos.length > 0, `${pagina} não carrega nenhum script local`);
  const corpos = arquivos.map((arquivo) => [arquivo, semComentarios(ler(arquivo))]);
  for (const s of scriptsDe(ler(pagina))) if (s.inline !== undefined) corpos.push([`${pagina} (embutido)`, semComentarios(s.inline)]);
  for (const [nome, codigo] of corpos) {
    for (const [padrao, rotulo] of PADROES_INSEGUROS) assert.equal(padrao.test(codigo), false, `${nome} usa ${rotulo}`);
    if (nome !== 'js/api-http.js') assert.equal(/\bconsole\./.test(codigo), false, `${nome} escreve no console`);
  }
  return arquivos;
}

/** Scripts externos da página, na ordem em que aparecem. */
const externosDe = (pagina) => scriptsDe(ler(pagina)).filter((s) => s.src && COM_ESQUEMA.test(s.src.trim()));

// ───────────────────────── contrato do backend, lido como texto ─────────────────────────

function rotasDoBackend(arquivo) {
  return new Set([...ler(`../backend/src/routes/${arquivo}`).matchAll(/router\.(get|post)\(\s*'([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
}

/** Nomes dos campos do corpo (z.strictObject) de `const <nome> = { body: ... }` num schema do backend. */
function camposDoCorpo(arquivo, nome) {
  const fonte = ler(`../backend/src/schemas/${arquivo}`);
  const inicio = fonte.search(new RegExp(`const ${nome} = \\{`));
  assert.notEqual(inicio, -1, `${arquivo} não define ${nome}`);
  const abre = fonte.indexOf('z.strictObject({', inicio);
  assert.notEqual(abre, -1, `${arquivo}: ${nome}.body não é z.strictObject`);
  let profundidade = 0;
  let i = fonte.indexOf('{', abre);
  const comeco = i + 1;
  for (; i < fonte.length; i += 1) {
    if (fonte[i] === '{') profundidade += 1;
    if (fonte[i] === '}') profundidade -= 1;
    if (profundidade === 0) break;
  }
  const interior = fonte.slice(comeco, i);
  const campos = [];
  let nivel = 0;
  let atual = '';
  for (const ch of interior) {
    if ('({['.includes(ch)) nivel += 1;
    if (')}]'.includes(ch)) nivel -= 1;
    if (ch === ',' && nivel === 0) { campos.push(atual); atual = ''; } else atual += ch;
  }
  campos.push(atual);
  return campos.map((c) => c.split(':')[0].trim()).filter(Boolean).sort();
}

// ───────────────────────── mensagens públicas ─────────────────────────

/**
 * A confirmação depois de pedir o link não diz se a conta existe, está
 * inativa, atingiu o limite por e-mail nem que algo foi enviado, e não repete
 * o e-mail digitado.
 */
function exigirConfirmacaoGenerica(texto, email) {
  assert.match(texto, /\b(se|caso)\b/i, 'a confirmação é condicional');
  assert.match(texto, /e-?mail/i);
  assert.equal(texto.includes(email), false, 'a confirmação repete o e-mail digitado');
  assert.doesNotMatch(texto, /enviamos|foi enviad|foram enviad|enviado com sucesso|e-?mail enviado/i, 'não afirma que algo foi enviado');
  assert.doesNotMatch(texto, /n[ãa]o (foi )?encontr|n[ãa]o existe|inexistente|inativ|bloquead|desativad|limite/i, 'não diz nada sobre a conta');
}

// ───────────────────────── redefinição pelo link ─────────────────────────

/**
 * Suíte única da página de redefinição (Portal e Painel Privado). O token chega
 * no fragmento (#token=), sai da barra de endereço antes de qualquer rede, fica
 * só em memória e só vai no corpo JSON do POST.
 *
 * @param {object} cfg
 * @param {string} cfg.rotulo 'Portal' | 'Painel Privado'
 * @param {string} cfg.pagina ex.: 'portal/redefinir-senha.html'
 * @param {string} cfg.rota ex.: 'POST /auth/global/recuperacao-senha/redefinir' (relativa à base da API)
 * @param {string} cfg.arquivoRotas arquivo de rotas do backend que declara a rota
 * @param {string} cfg.caminhoNoBackend caminho declarado no backend (sem o prefixo da cadeia)
 */
function descreverRedefinicao({ rotulo, pagina, rota, arquivoRotas, caminhoNoBackend }) {
  const LOGIN = 'index.html';
  const SOLICITAR = 'recuperar-senha.html';
  const SEGREDOS = [TOKEN, SENHA_NOVA, OUTRA_SENHA];

  const abrir = ({ hash = `#token=${TOKEN}`, rotas = {}, ...resto } = {}) => abrirPagina(pagina, { hash, rotas: { [rota]: SENHA_REDEFINIDA, ...rotas }, ...resto });
  const preencher = async (pg, nova = SENHA_NOVA, confirmacao = nova) => {
    await pg.digitar('senha', nova);
    await pg.digitar('senha-confirmacao', confirmacao);
  };
  const enviar = async (pg, nova = SENHA_NOVA, confirmacao = nova) => {
    await preencher(pg, nova, confirmacao);
    await pg.clicar('botao-redefinir');
  };
  const linkVisivel = (pg, escopo, destino) => pg.consulta(`${escopo} a[href="${destino}"]`).filter((a) => pg.visivelNo(a)).length === 1;

  describe(`${rotulo} — redefinição pelo link (${pagina})`, () => {
    test('marcação: sem referrer, sem script externo, campos de senha nova com o autocomplete certo, rótulos, envio e estados', () => {
      const html = ler(pagina);
      const limpo = semComentariosHtml(html);
      assert.match(limpo, /<meta name="referrer" content="no-referrer">/);
      assert.match(limpo, /<html lang="pt-BR">/);
      assert.match(limpo, /<title>[^<]*SafeWork[^<]*<\/title>/);
      assert.deepEqual(externosDe(pagina), [], 'a redefinição não carrega script de fora');
      assert.match(tagDe(html, 'form-redefinicao'), /\bnovalidate\b/);
      for (const id of ['senha', 'senha-confirmacao']) {
        assert.match(tagDe(html, id), /type="password"/, id);
        assert.match(tagDe(html, id), /autocomplete="new-password"/, id);
        assert.match(limpo, new RegExp(`<label\\b[^>]*\\bfor="${id}"`), `#${id} sem label`);
      }
      assert.match(tagDe(html, 'botao-redefinir'), /type="submit"/);
      assert.match(tagDe(html, 'mensagem'), /aria-live="(?:polite|assertive)"/);
      for (const id of ['sucesso', 'link-invalido']) tagDe(html, id);
      assert.doesNotMatch(limpo, /<form\b[^>]*\b(action|method)=/i, 'o formulário nunca é enviado pelo navegador');
      for (const b of limpo.match(/<button\b[^>]*>/g)) assert.match(b, /type="(?:submit|button)"/, b);
    });

    test('o token vem só do fragmento: a barra de endereço é limpa antes de qualquer rede e nada é chamado ao abrir', async () => {
      const pg = abrir();
      assert.equal(pg.location.hash, '');
      assert.deepEqual(pg.historico.map((h) => [h.metodo, h.estado]), [['replaceState', null]]);
      assert.doesNotMatch(String(pg.historico[0].url), /#|token/i);
      assert.equal(pg.eventos[0].tipo, 'replaceState');
      await pg.esperar();
      assert.deepEqual(pg.chamadas, []);
      assert.equal(pg.visivel('form-redefinicao'), true);
      assert.equal(pg.visivel('link-invalido'), false);
      assert.equal(pg.visivel('sucesso'), false);
      semSegredos(pg.textoDoDom(), 'o DOM', [TOKEN]);
      assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.externas, pg.alertas], [[], [], [], []]);
    });

    for (const [caso, opcoes] of [
      ['sem fragmento', { hash: '' }],
      ['fragmento sem valor', { hash: '#token=' }],
      ['rótulo sem valor', { hash: '#token' }],
      ['outro parâmetro', { hash: `#codigo=${TOKEN}` }],
      ['o token na query e nenhum fragmento', { hash: '', search: `?token=${TOKEN}` }],
    ]) {
      test(`${caso}: nenhuma chamada e o mesmo estado de link inválido, com o caminho para pedir outro`, async () => {
        const pg = abrir(opcoes);
        await pg.esperar();
        if (opcoes.hash !== '') assert.equal(pg.location.hash, '', 'qualquer fragmento é retirado da barra');
        assert.deepEqual(pg.chamadas, []);
        assert.equal(pg.visivel('link-invalido'), true);
        assert.equal(pg.visivel('form-redefinicao'), false);
        assert.match(pg.texto('link-invalido'), /inválid|expir|incompleto/i);
        assert.equal(linkVisivel(pg, '#link-invalido', SOLICITAR), true);
        semSegredos(pg.textoDoDom(), 'o DOM', [TOKEN]);
      });

      test(`${caso}: um envio forçado do formulário escondido também não chama a API`, async () => {
        const pg = abrir(opcoes);
        await pg.esperar();
        await preencher(pg);
        await pg.el('form-redefinicao').disparar('submit');
        await pg.esperar();
        assert.deepEqual(pg.chamadas, []);
        assert.equal(pg.visivel('link-invalido'), true);
        assert.equal(pg.visivel('form-redefinicao'), false);
      });
    }

    test('o envio sai uma vez, com o token e a nova senha só no corpo JSON, sem token na URL, e a confirmação nunca vai', async () => {
      const pg = abrir();
      await pg.esperar();
      await enviar(pg);
      assert.equal(pg.chamadas.length, 1);
      const [c] = pg.chamadas;
      assert.deepEqual([c.chave, c.corpo, c.temQuery, c.credentials], [rota, { token: TOKEN, novaSenha: SENHA_NOVA }, false, 'include']);
      assert.equal(c.cabecalhos['Content-Type'], 'application/json');
      semSegredos(c.url, 'a URL', SEGREDOS);
    });

    test('enquanto a requisição está pendente o botão fica desabilitado e um segundo envio não gera outra chamada', async () => {
      let liberar;
      const presa = new Promise((resolve) => { liberar = resolve; });
      const pg = abrir({ rotas: { [rota]: () => presa } });
      await pg.esperar();
      await preencher(pg);
      const primeiro = pg.enviarSemEsperar('form-redefinicao');
      await pg.esperar();
      assert.equal(pg.el('botao-redefinir').disabled, true);
      await preencher(pg);
      await pg.enviarSemEsperar('form-redefinicao');
      await pg.esperar();
      assert.equal(pg.chamadas.length, 1);
      liberar(SENHA_REDEFINIDA);
      await primeiro;
      await pg.esperar();
      assert.equal(pg.visivel('sucesso'), true);
      assert.equal(pg.chamadas.length, 1);
    });

    test('sucesso: campos limpos, formulário fora, confirmação à vista, caminho para o login, e o token não pode ser reutilizado', async () => {
      const pg = abrir();
      await pg.esperar();
      await enviar(pg);
      await pg.avancar();
      assert.equal(pg.visivel('sucesso'), true);
      assert.equal(pg.visivel('form-redefinicao'), false);
      assert.equal(pg.visivel('link-invalido'), false);
      assert.deepEqual([pg.el('senha').value, pg.el('senha-confirmacao').value], ['', '']);
      assert.match(pg.texto('sucesso'), /senha/i);
      assert.equal(pg.navegacoes.includes(LOGIN) || linkVisivel(pg, '#sucesso', LOGIN), true, 'a pessoa é encaminhada ao login');
      semSegredos(pg.textoDoDom(), 'o DOM', SEGREDOS);

      await preencher(pg, OUTRA_SENHA);
      await pg.el('form-redefinicao').disparar('submit');
      await pg.esperar();
      assert.equal(pg.chamadas.length, 1, 'depois do sucesso o token foi descartado');
    });

    for (const [caso, nova, confirmacao, esperado] of [
      ['confirmação diferente da senha', SENHA_NOVA, OUTRA_SENHA, /confirma/i],
      ['senha vazia', '', '', /senha/i],
    ]) {
      test(`${caso}: nada vai ao servidor, a mensagem aparece e o formulário continua`, async () => {
        const pg = abrir();
        await pg.esperar();
        await enviar(pg, nova, confirmacao);
        assert.deepEqual(pg.chamadas, []);
        assert.match(pg.texto('mensagem'), esperado);
        assert.equal(pg.visivel('form-redefinicao'), true);
        assert.equal(pg.visivel('sucesso'), false);
      });
    }

    test('link inválido, expirado, usado ou cancelado: o mesmo estado genérico de quando não há token, com o formulário fora e os campos limpos', async () => {
      const semToken = abrir({ hash: '' });
      await semToken.esperar();
      const pg = abrir({ rotas: { [rota]: erro(400, 'REDEFINICAO_INVALIDA', 'Link de redefinição inválido ou expirado') } });
      await pg.esperar();
      await enviar(pg);
      assert.equal(pg.chamadas.length, 1);
      assert.equal(pg.visivel('link-invalido'), true);
      assert.equal(pg.visivel('form-redefinicao'), false);
      assert.equal(pg.visivel('sucesso'), false);
      assert.equal(pg.texto('link-invalido'), semToken.texto('link-invalido'), 'o cliente não distingue as causas');
      assert.equal(linkVisivel(pg, '#link-invalido', SOLICITAR), true);
      assert.deepEqual([pg.el('senha').value, pg.el('senha-confirmacao').value], ['', '']);
    });

    test('depois de o servidor recusar o link, um novo envio forçado do formulário escondido não chama a API de novo', async () => {
      const pg = abrir({ rotas: { [rota]: erro(400, 'REDEFINICAO_INVALIDA', 'Link de redefinição inválido ou expirado') } });
      await pg.esperar();
      await enviar(pg);
      assert.equal(pg.chamadas.length, 1);
      await preencher(pg, OUTRA_SENHA);
      await pg.el('form-redefinicao').disparar('submit');
      await pg.esperar();
      assert.equal(pg.chamadas.length, 1, 'o token recusado foi descartado');
      assert.equal(pg.visivel('link-invalido'), true);
    });

    for (const [caso, falha, esperado] of [
      ['senha fora da política', SENHA_CURTA, new RegExp(MENSAGEM_SENHA_CURTA)],
      ['senha igual à atual', erro(400, 'SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual'), /diferente/i],
      ['limite de requisições', erro(429, 'LIMITE_REQUISICOES_EXCEDIDO', 'Muitas requisições. Tente novamente mais tarde'), /muitas|aguard|tente novamente/i],
      ['erro interno', erro(500, 'ERRO_INTERNO', 'Erro interno do servidor'), /erro|não foi possível|tente/i],
      ['falha de rede', new Error('sem rede'), /conex|servidor/i],
    ]) {
      test(`${caso}: mensagem própria, formulário e token mantidos, campos limpos, e uma nova tentativa funciona`, async () => {
        let tentativas = 0;
        const pg = abrir({ rotas: { [rota]: () => { tentativas += 1; return tentativas === 1 ? falha : SENHA_REDEFINIDA; } } });
        await pg.esperar();
        await enviar(pg);
        assert.match(pg.texto('mensagem'), esperado);
        assert.equal(pg.visivel('form-redefinicao'), true);
        assert.equal(pg.visivel('link-invalido'), false);
        assert.equal(pg.visivel('sucesso'), false);
        assert.deepEqual([pg.el('senha').value, pg.el('senha-confirmacao').value], ['', '']);
        assert.equal(pg.el('botao-redefinir').disabled, false);

        await enviar(pg, OUTRA_SENHA);
        assert.deepEqual(pg.chamadas.map((c) => c.corpo), [{ token: TOKEN, novaSenha: SENHA_NOVA }, { token: TOKEN, novaSenha: OUTRA_SENHA }]);
        assert.equal(pg.visivel('sucesso'), true);
      });
    }

    test('tudo o que vem do servidor entra na tela como texto, nunca como HTML', async () => {
      const pg = abrir({ rotas: { [rota]: erro(400, 'OUTRO_CODIGO', ATAQUE, [{ campo: 'body.novaSenha', codigo: 'X', mensagem: ATAQUE }]) } });
      await pg.esperar();
      await enviar(pg);
      assert.deepEqual(pg.documento.usosDeInnerHTML, []);
      assert.equal(pg.consulta('img').length, 0);
      assert.equal(pg.alertas.length, 0);
    });

    test('nada sensível fora do lugar: sem storage, cookie, rede externa, innerHTML nem console com token ou senha', async () => {
      let tentativas = 0;
      const pg = abrir({ rotas: { [rota]: () => { tentativas += 1; return tentativas === 1 ? SENHA_CURTA : SENHA_REDEFINIDA; } } });
      await pg.esperar();
      await enviar(pg);
      await enviar(pg, OUTRA_SENHA);
      assert.equal(pg.visivel('sucesso'), true);
      assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.externas, pg.documento.usosDeInnerHTML, pg.alertas], [[], [], [], [], []]);
      assert.ok(pg.consoleChamadas.length > 0, 'o cliente HTTP registra método, caminho e status');
      semSegredos(pg.consoleChamadas.map((c) => c.texto).join('\n'), 'o console', SEGREDOS);
      semSegredos(pg.textoDoDom(), 'o DOM', SEGREDOS);
      for (const c of pg.chamadas) semSegredos(c.url, 'a URL', SEGREDOS);
    });

    test('os scripts da página não usam storage, cookie, HTML inseguro, eval, console nem o histórico além do replaceState', () => {
      const arquivos = inspecionarScripts(pagina);
      assert.ok(arquivos.includes('js/api-http.js'));
      const proprios = arquivos.filter((f) => !['js/api-http.js', 'js/portal-cliente.js'].includes(f) && !/config\.js$/.test(f));
      assert.ok(proprios.some((f) => /replaceState/.test(semComentarios(ler(f)))), 'algum script próprio retira o fragmento com history.replaceState');
    });

    test('contrato com o backend: a rota e os campos do corpo existem no código do backend', () => {
      assert.ok(rotasDoBackend(arquivoRotas).has(`POST ${caminhoNoBackend}`), `${arquivoRotas} não declara POST ${caminhoNoBackend}`);
      assert.deepEqual(camposDoCorpo('recuperacao-senha.schema.js', 'redefinir'), ['novaSenha', 'token']);
      assert.ok(rota.endsWith(caminhoNoBackend));
    });
  });
}

module.exports = {
  TOKEN,
  SENHA_ATUAL,
  SENHA_NOVA,
  OUTRA_SENHA,
  EMAIL,
  OUTRO_EMAIL,
  TOTP,
  ok,
  erro,
  SENHA_REDEFINIDA,
  SENHA_ALTERADA,
  SOLICITACAO_RECEBIDA,
  SENHA_CURTA,
  MENSAGEM_SENHA_CURTA,
  ATAQUE,
  semSegredos,
  tagDe,
  inspecionarScripts,
  externosDe,
  rotasDoBackend,
  camposDoCorpo,
  exigirConfirmacaoGenerica,
  descreverRedefinicao,
};
