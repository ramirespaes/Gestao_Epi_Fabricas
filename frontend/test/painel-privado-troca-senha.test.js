'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPagina, ler, semComentariosHtml } = require('./helpers/dom-pagina');
const {
  SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, TOTP, ok, erro, SENHA_ALTERADA, SENHA_CURTA, MENSAGEM_SENHA_CURTA, ATAQUE, semSegredos, tagDe, inspecionarScripts,
  rotasDoBackend, camposDoCorpo,
} = require('./helpers/ciclo-senha');

/**
 * Troca de senha autenticada no Painel Privado (Bloco 11F), dentro de "Segurança
 * da conta" (painel-privado/seguranca.html): senha atual, nova, confirmação (só
 * da tela) e o código atual do autenticador. Só TOTP: recovery code não
 * substitui. Depois da troca a sessão atual continua e o menu volta, sem login.
 * Os scripts da página continuam sendo os mesmos quatro.
 */

const PAGINA = 'painel-privado/seguranca.html';
const TROCAR = 'POST /auth/senha';
const SEGREDOS = [SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, TOTP];
const CODIGO_INVALIDO = /código inválido/i;

const rotas = (extra = {}) => ({
  'GET /auth/me': ok({ administrador: { id: 1, email: 'admin@safework.test' } }),
  'POST /auth/logout': ok(),
  [TROCAR]: SENHA_ALTERADA,
  ...extra,
});
async function abrir(extra) {
  const pg = abrirPagina(PAGINA, { rotas: rotas(extra) });
  await pg.esperar();
  return pg;
}
async function abrirTroca(extra) {
  const pg = await abrir(extra);
  await pg.clicar('botao-trocar-senha');
  return pg;
}
async function preencher(pg, { atual = SENHA_ATUAL, nova = SENHA_NOVA, confirmacao = nova, codigo = TOTP } = {}) {
  await pg.digitar('troca-senha-atual', atual);
  await pg.digitar('troca-senha-nova', nova);
  await pg.digitar('troca-senha-confirmacao', confirmacao);
  await pg.digitar('troca-codigo', codigo);
}
async function trocar(pg, campos) {
  await preencher(pg, campos);
  await pg.enviar('etapa-senha');
}
const trocasDe = (pg) => pg.chamadas.filter((c) => c.chave === TROCAR);
const campos = (pg) => ['troca-senha-atual', 'troca-senha-nova', 'troca-senha-confirmacao', 'troca-codigo'].map((id) => pg.el(id).value);

describe('Segurança da conta — marcação da troca de senha', () => {
  const html = () => ler(PAGINA);

  test('o menu oferece a troca de senha e o texto do menu não afirma mais que são duas operações que encerram todas as sessões', () => {
    assert.match(html(), /<button\b[^>]*\bid="botao-trocar-senha"[^>]*>\s*Trocar senha\s*<\/button>/);
    assert.match(tagDe(html(), 'botao-trocar-senha'), /type="button"/);
    const menu = html().slice(html().indexOf('id="etapa-menu"'), html().indexOf('id="etapa-reautenticacao"'));
    assert.ok(menu.includes('botao-trocar-senha'), 'o botão está no menu');
    assert.doesNotMatch(menu, /As duas operações/, 'o texto do menu ficou desatualizado com a terceira operação');
  });

  test('a etapa SENHA é um formulário oculto ao nascer, com os quatro campos, rótulos, tipos e autocomplete certos, e só o código do autenticador (sem recovery code)', () => {
    const h = html();
    const limpo = semComentariosHtml(h);
    assert.match(tagDe(h, 'etapa-senha'), /data-etapa="SENHA"/);
    assert.match(tagDe(h, 'etapa-senha'), /\bhidden\b/);
    assert.match(tagDe(h, 'etapa-senha'), /\bnovalidate\b/);
    assert.match(tagDe(h, 'troca-senha-atual'), /type="password"[^>]*autocomplete="current-password"/);
    for (const id of ['troca-senha-nova', 'troca-senha-confirmacao']) assert.match(tagDe(h, id), /type="password"[^>]*autocomplete="new-password"/, id);
    for (const atributo of [/type="text"/, /inputmode="numeric"/, /autocomplete="one-time-code"/, /maxlength="6"/]) assert.match(tagDe(h, 'troca-codigo'), atributo, String(atributo));
    for (const id of ['troca-senha-atual', 'troca-senha-nova', 'troca-senha-confirmacao', 'troca-codigo']) assert.match(limpo, new RegExp(`<label\\b[^>]*\\bfor="${id}"`), `#${id} sem label`);
    assert.match(tagDe(h, 'botao-confirmar-troca-senha'), /type="submit"/);
    assert.match(limpo, /<button\b[^>]*\bid="botao-voltar-troca-senha"[^>]*>Voltar<\/button>/);
    const etapa = limpo.slice(limpo.indexOf('id="etapa-senha"'), limpo.indexOf('</form>', limpo.indexOf('id="etapa-senha"')));
    assert.doesNotMatch(etapa, /recupera|codigoRecuperacao/i, 'recovery code não substitui o TOTP nesta etapa');
    assert.equal(/type="number"/.test(limpo), false);
  });

  test('os scripts da página continuam sendo os quatro de antes, todos versionados: a troca de senha mora no seguranca.js', () => {
    const pg = abrirPagina(PAGINA, { rotas: rotas() });
    const proprios = pg.scripts.map((s) => s.split('?')[0]).filter((s) => !s.includes('vendor/') && !s.endsWith('js/api-http.js'));
    assert.deepEqual(proprios, ['config.js', 'mfa.js', 'sair.js', 'seguranca.js']);
    for (const s of pg.scripts) assert.match(s, /\?v=\d{8,}/, `${s} sem versão`);
    assert.deepEqual(pg.externas, []);
  });
});

describe('Segurança da conta — troca de senha (fluxo)', () => {
  test('o botão do menu abre só a etapa SENHA, com foco na senha atual e título da operação; Voltar limpa os campos e volta ao menu sem chamar a API', async () => {
    const pg = await abrir();
    assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    await pg.clicar('botao-trocar-senha');
    assert.deepEqual(pg.etapasVisiveis(), ['SENHA']);
    assert.equal(pg.foco(), 'troca-senha-atual');
    assert.match(pg.texto('titulo-etapa'), /senha/i);

    await preencher(pg);
    await pg.clicar('botao-voltar-troca-senha');
    assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    assert.deepEqual(campos(pg), ['', '', '', '']);
    assert.deepEqual(trocasDe(pg), []);
    semSegredos(pg.textoDoDom(), 'o DOM', SEGREDOS);
  });

  test('o campo do autenticador é tratado como os outros: dígitos apenas, colagem com espaços e hífens aceita, no máximo seis', async () => {
    const pg = await abrirTroca();
    await pg.digitar('troca-codigo', '12a 3-4 56');
    assert.equal(pg.el('troca-codigo').value, '123456');
    await pg.digitar('troca-codigo', '0047119999');
    assert.equal(pg.el('troca-codigo').value, '004711');
  });

  for (const [caso, opcoes, esperado] of [
    ['senha atual vazia', { atual: '' }, /preencha|senha atual|informe/i],
    ['nova senha vazia', { nova: '', confirmacao: '' }, /preencha|nova senha|informe/i],
    ['confirmação diferente da nova senha', { confirmacao: OUTRA_SENHA }, /confirma/i],
    ['código incompleto', { codigo: '4711' }, /6 dígitos/i],
    ['código vazio', { codigo: '' }, /6 dígitos/i],
  ]) {
    test(`${caso}: nada vai ao servidor, a mensagem aparece e a etapa continua`, async () => {
      const pg = await abrirTroca();
      await trocar(pg, opcoes);
      assert.deepEqual(trocasDe(pg), []);
      assert.match(pg.texto('mensagem'), esperado);
      assert.deepEqual(pg.etapasVisiveis(), ['SENHA']);
    });
  }

  test('com tudo preenchido sai um POST com senhaAtual, novaSenha e codigo só no corpo; a confirmação nunca vai; os quatro campos são limpos', async () => {
    const pg = await abrirTroca();
    await trocar(pg);
    assert.deepEqual(trocasDe(pg).map((c) => [c.corpo, c.temQuery, c.credentials]), [[{ senhaAtual: SENHA_ATUAL, novaSenha: SENHA_NOVA, codigo: TOTP }, false, 'include']]);
    semSegredos(trocasDe(pg)[0].url, 'a URL', SEGREDOS);
    assert.deepEqual(campos(pg), ['', '', '', '']);
  });

  test('o código vai como texto, com os zeros à esquerda', async () => {
    const pg = await abrirTroca();
    await trocar(pg, { codigo: '000123' });
    assert.equal(trocasDe(pg)[0].corpo.codigo, '000123');
  });

  test('enquanto a requisição está pendente os botões ficam desabilitados e um segundo envio não gera outra chamada', async () => {
    let liberar;
    const presa = new Promise((resolve) => { liberar = resolve; });
    const pg = await abrirTroca({ [TROCAR]: () => presa });
    await preencher(pg);
    const primeiro = pg.enviarSemEsperar('etapa-senha');
    await pg.esperar();
    for (const id of ['botao-confirmar-troca-senha', 'botao-voltar-troca-senha', 'sair']) assert.equal(pg.el(id).disabled, true, id);
    await preencher(pg);
    await pg.enviarSemEsperar('etapa-senha');
    await pg.esperar();
    assert.equal(trocasDe(pg).length, 1);
    liberar(SENHA_ALTERADA);
    await primeiro;
    await pg.esperar();
    assert.equal(trocasDe(pg).length, 1);
    assert.equal(pg.el('sair').disabled, false);
  });

  test('sucesso: volta ao menu com o aviso, sem sair, sem ir ao login e sem pedir sessão nova; os campos seguem limpos', async () => {
    const pg = await abrirTroca();
    await trocar(pg);
    assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    assert.equal(pg.visivel('conteudo'), true);
    assert.match(pg.texto('mensagem'), /senha/i);
    assert.match(pg.texto('mensagem'), /alterad/i);
    assert.match(pg.texto('mensagem'), /outras|demais/i, 'avisa que só as outras sessões foram encerradas');
    assert.doesNotMatch(pg.el('mensagem').className, /erro/);
    assert.deepEqual(pg.navegacoes, [], 'a sessão atual continua: ninguém vai ao login');
    assert.deepEqual(pg.chamadas.map((c) => c.chave).filter((k) => /logout|login/.test(k)), []);
    assert.deepEqual(campos(pg), ['', '', '', '']);
    semSegredos(pg.textoDoDom(), 'o DOM', SEGREDOS);

    await pg.clicar('botao-trocar-senha');
    assert.deepEqual(pg.etapasVisiveis(), ['SENHA'], 'dá para trocar de novo na mesma sessão');
    assert.deepEqual(campos(pg), ['', '', '', '']);
  });

  for (const [caso, falha, esperado, naoDeve] of [
    ['senha nova fora da política (400 VALIDACAO)', SENHA_CURTA, new RegExp(MENSAGEM_SENHA_CURTA), CODIGO_INVALIDO],
    ['senha nova igual à atual (400 SENHA_IGUAL_A_ATUAL)', erro(400, 'SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual'), /diferente/i, CODIGO_INVALIDO],
    ['senha ou código recusados (401 REAUTENTICACAO_INVALIDA)', erro(401, 'REAUTENTICACAO_INVALIDA', 'Senha ou código inválidos'), /^Senha ou código inválidos\.?$/, /sess[ãa]o/i],
    ['cooldown do MFA (429)', erro(429, 'MFA_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde'), /muitas tentativas|aguarde/i, CODIGO_INVALIDO],
    ['MFA indisponível (503)', erro(503, 'MFA_INDISPONIVEL', 'Erro interno do servidor'), /indispon/i, CODIGO_INVALIDO],
    ['falha de rede', new Error('sem rede'), /conex|servidor/i, CODIGO_INVALIDO],
  ]) {
    test(`${caso}: mensagem própria, mesma etapa, campos limpos e nova tentativa possível`, async () => {
      let tentativas = 0;
      const pg = await abrirTroca({ [TROCAR]: () => { tentativas += 1; return tentativas === 1 ? falha : SENHA_ALTERADA; } });
      await trocar(pg);
      assert.match(pg.texto('mensagem'), esperado);
      assert.doesNotMatch(pg.texto('mensagem'), naoDeve);
      assert.deepEqual(pg.etapasVisiveis(), ['SENHA']);
      assert.deepEqual(pg.navegacoes, []);
      assert.deepEqual(campos(pg), ['', '', '', '']);
      assert.equal(pg.el('botao-confirmar-troca-senha').disabled, false);

      await trocar(pg, { nova: OUTRA_SENHA });
      assert.deepEqual(trocasDe(pg).map((c) => c.corpo.novaSenha), [SENHA_NOVA, OUTRA_SENHA]);
      assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    });
  }

  test('sessão inválida (401 SESSAO_INVALIDA): limpa a tela, esconde o conteúdo e vai ao login', async () => {
    const pg = await abrirTroca({ [TROCAR]: erro(401, 'SESSAO_INVALIDA', 'Sessão inválida ou expirada') });
    await trocar(pg);
    assert.deepEqual(pg.navegacoes, ['index.html']);
    assert.equal(pg.visivel('conteudo'), false);
    assert.deepEqual(campos(pg), ['', '', '', '']);
    semSegredos(pg.textoDoDom(), 'o DOM', SEGREDOS);
  });

  test('página restaurada pelo navegador: os campos da troca de senha são limpos, o menu volta e a sessão é confirmada de novo', async () => {
    const pg = await abrirTroca();
    await preencher(pg);
    const antes = pg.chamadas.length;
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.equal(pg.chamadas[antes].chave, 'GET /auth/me');
    assert.deepEqual(campos(pg), ['', '', '', '']);
    assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    semSegredos(pg.textoDoDom(), 'o DOM restaurado', SEGREDOS);
  });

  test('o que vem do servidor entra na tela como texto, nunca como HTML', async () => {
    const pg = await abrirTroca({ [TROCAR]: erro(400, 'VALIDACAO', ATAQUE, [{ campo: 'body.novaSenha', codigo: 'X', mensagem: ATAQUE }]) });
    await trocar(pg);
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
    assert.equal(pg.consulta('img').length, 0);
  });

  test('nada sensível fora do lugar: sem storage, cookie, rede externa, innerHTML nem console com senha ou código', async () => {
    let tentativas = 0;
    const pg = await abrirTroca({ [TROCAR]: () => { tentativas += 1; return tentativas === 1 ? SENHA_CURTA : SENHA_ALTERADA; } });
    await trocar(pg);
    await trocar(pg, { nova: OUTRA_SENHA });
    assert.deepEqual(pg.etapasVisiveis(), ['MENU']);
    assert.deepEqual([pg.storage, pg.cookiesEscritos, pg.externas, pg.documento.usosDeInnerHTML, pg.alertas], [[], [], [], [], []]);
    assert.ok(pg.consoleChamadas.length > 0, 'o cliente HTTP registra método, caminho e status');
    semSegredos(pg.consoleChamadas.map((c) => c.texto).join('\n'), 'o console', SEGREDOS);
    semSegredos(pg.textoDoDom(), 'o DOM', SEGREDOS);
    for (const c of pg.chamadas) semSegredos(c.url, 'a URL', SEGREDOS);
  });

  test('os scripts da página não usam storage, cookie, HTML inseguro, eval, console nem navegação pelo histórico', () => {
    assert.ok(inspecionarScripts(PAGINA).length > 0);
  });

  test('contrato com o backend: a chamada da página é rota do backend e o corpo tem exatamente os campos do schema', async () => {
    const pg = await abrirTroca();
    await trocar(pg);
    assert.equal(trocasDe(pg).length, 1);
    assert.ok(rotasDoBackend('troca-senha.routes.js').has('POST /auth/senha'));
    assert.deepEqual(Object.keys(trocasDe(pg)[0].corpo).sort(), camposDoCorpo('troca-senha.schema.js', 'trocarPlataforma'));
  });
});
