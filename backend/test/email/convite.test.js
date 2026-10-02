'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Entrega de convite pelo serviço único de e-mail (Bloco 11H): o link nunca
 * volta na resposta em production nem com provedor real; só nos modos de
 * desenvolvimento a resposta o carrega. Falha de entrega vira estado FALHA,
 * sem exceção. Os links vêm das URLs públicas configuradas.
 */

const modulo = () => exigirModulo('src/email/convite');
const linksModulo = () => exigirModulo('src/email/links');

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const EMAIL = 'pessoa.convidada@exemplo-cliente.com.br';
const EXPIRA = new Date('2026-10-05T15:00:00.000Z');
const URLS = Object.freeze({ portal: 'https://app.exemplo-cliente.test', painel: 'https://admin.exemplo-cliente.test' });
const SUPORTE = 'suporte@safeworkengenharia.com.br';

const smtp = { modo: 'smtp', suporte: SUPORTE };
const desativado = { modo: 'desativado', suporte: SUPORTE };
const arquivo = { modo: 'arquivo', suporte: SUPORTE };

function servicoFalso(estado = 'ENVIADO') {
  const s = { mensagens: [], enviarAguardando: async (m) => { s.mensagens.push(m); return { estado }; } };
  return s;
}

const usuario = (extra = {}) => ({
  tipo: 'USUARIO', token: TOKEN, expiraEm: EXPIRA, email: EMAIL, empresa: 'Empresa Convidante Ltda', nome: 'Ana Souza', perfil: 'SUPERVISOR', ...extra,
});
const master = (extra = {}) => ({
  tipo: 'MASTER', token: TOKEN, expiraEm: EXPIRA, email: EMAIL, empresa: 'Empresa Convidante Ltda', ...extra,
});

const entregar = (dados, { ambiente, config, servico = servicoFalso() }) => modulo().entregarConvite(dados, { servico, ambiente, config, urls: URLS });

describe('links dos e-mails', () => {
  test('usam as URLs públicas informadas, o caminho fixo de cada página e o token só no fragmento', () => {
    const { linkConvite, linkRedefinicao } = linksModulo();
    const casos = [
      [linkConvite('USUARIO', TOKEN, URLS), `${URLS.portal}/portal/aceitar-convite.html`],
      [linkConvite('MASTER', TOKEN, URLS), `${URLS.painel}/painel-privado/aceitar-convite.html`],
      [linkRedefinicao('PORTAL', TOKEN, URLS), `${URLS.portal}/portal/redefinir-senha.html`],
      [linkRedefinicao('PLATAFORMA', TOKEN, URLS), `${URLS.painel}/painel-privado/redefinir-senha.html`],
    ];
    for (const [link, esperado] of casos) {
      assert.equal(link, `${esperado}#token=${TOKEN}`);
      assert.equal(new URL(link).search, '');
    }
  });

  test('o token é codificado e escopo ou token inválidos são erro de programação', () => {
    const { linkConvite } = linksModulo();
    assert.equal(linkConvite('USUARIO', 'a b/c', URLS).endsWith('#token=a%20b%2Fc'), true);
    for (const ruim of ['OUTRO', '', null, 42]) assert.throws(() => linkConvite(ruim, TOKEN, URLS), TypeError, String(ruim));
    for (const ruim of ['', null, 42]) assert.throws(() => linkConvite('USUARIO', ruim, URLS), TypeError, String(ruim));
  });

  test('sem URLs injetadas usam a configuração carregada (padrão local nos testes)', () => {
    const { httpConfig } = require('../../src/config/http');
    assert.equal(linksModulo().linkConvite('USUARIO', TOKEN).startsWith(`${httpConfig.urlsPublicas.portal}/portal/aceitar-convite.html#token=`), true);
    assert.equal(linksModulo().linkConvite('MASTER', TOKEN).startsWith(`${httpConfig.urlsPublicas.painel}/painel-privado/aceitar-convite.html#token=`), true);
  });
});

describe('entregarConvite com provedor real (smtp)', () => {
  test('em production a resposta não leva link nem token; o e-mail leva', async () => {
    const servico = servicoFalso('ENVIADO');
    const r = await entregar(usuario(), { ambiente: 'production', config: smtp, servico });
    assert.deepEqual(r, { modo: 'EMAIL', estado: 'ENVIADO', expiraEm: EXPIRA });
    assert.equal(JSON.stringify(r).includes(TOKEN), false);
    assert.equal(servico.mensagens.length, 1);
    const [m] = servico.mensagens;
    assert.equal(m.tipo, 'CONVITE_USUARIO');
    assert.equal(m.escopo, 'PORTAL');
    assert.equal(m.para, EMAIL);
    assert.ok(m.conteudo.texto.includes(`${URLS.portal}/portal/aceitar-convite.html#token=${TOKEN}`));
    assert.ok(m.conteudo.html.includes(`${URLS.portal}/portal/aceitar-convite.html#token=${TOKEN}`));
    assert.equal(m.conteudo.assunto, 'Convite para acessar o Portal do Cliente — SafeWork Engenharia');
  });

  test('também fora de production, com smtp, a resposta não leva o link', async () => {
    for (const ambiente of ['development', 'test']) {
      const r = await entregar(master(), { ambiente, config: smtp });
      assert.equal('linkAceite' in r, false, ambiente);
      assert.equal(r.modo, 'EMAIL');
    }
  });

  test('o convite do MASTER vai ao Painel Privado, com o escopo PLATAFORMA e o assunto próprio', async () => {
    const servico = servicoFalso();
    await entregar(master(), { ambiente: 'production', config: smtp, servico });
    const [m] = servico.mensagens;
    assert.equal(m.tipo, 'CONVITE_MASTER');
    assert.equal(m.escopo, 'PLATAFORMA');
    assert.ok(m.conteudo.texto.includes(`${URLS.painel}/painel-privado/aceitar-convite.html#token=${TOKEN}`));
    assert.equal(m.conteudo.assunto, 'Convite para administrar sua empresa no SafeWork Engenharia');
  });

  test('falha de entrega vira estado FALHA, sem exceção e sem link; o convite segue pendente para o reenvio', async () => {
    const r = await entregar(usuario(), { ambiente: 'production', config: smtp, servico: servicoFalso('FALHA') });
    assert.deepEqual(r, { modo: 'EMAIL', estado: 'FALHA', expiraEm: EXPIRA });
  });

  test('o reenvio usa a variante de reenvio dos dois convites', async () => {
    const servico = servicoFalso();
    await entregar(usuario({ reenvio: true }), { ambiente: 'production', config: smtp, servico });
    await entregar(master({ reenvio: true }), { ambiente: 'production', config: smtp, servico });
    assert.deepEqual(servico.mensagens.map((m) => m.conteudo.assunto), [
      'Novo convite para acessar o Portal do Cliente — SafeWork Engenharia',
      'Novo convite para administrar sua empresa no SafeWork Engenharia',
    ]);
    for (const m of servico.mensagens) assert.match(m.conteudo.texto, /o convite anterior deixou de valer/);
  });
});

describe('entregarConvite nos modos de desenvolvimento', () => {
  test('desativado e arquivo fora de production mantêm o mecanismo manual: a resposta leva o link', async () => {
    for (const config of [desativado, arquivo]) {
      for (const ambiente of ['development', 'test']) {
        const r = await entregar(usuario(), { ambiente, config, servico: servicoFalso('NAO_ENVIADO') });
        assert.equal(r.modo, 'DESENVOLVIMENTO_SEM_EMAIL');
        assert.equal(r.estado, 'NAO_ENVIADO');
        assert.equal(r.linkAceite, `${URLS.portal}/portal/aceitar-convite.html#token=${TOKEN}`);
        assert.equal(r.expiraEm, EXPIRA);
      }
    }
  });

  test('em production, sem smtp, a entrega é recusada com 503 antes de tocar o serviço, e o link nunca é montado', async () => {
    for (const config of [desativado, arquivo]) {
      const servico = servicoFalso();
      await assert.rejects(
        () => entregar(usuario(), { ambiente: 'production', config, servico }),
        (e) => e.status === 503 && e.codigo === 'CONVITE_ENTREGA_INDISPONIVEL',
      );
      assert.deepEqual(servico.mensagens, []);
    }
  });

  test('exigirDisponivel: recusa só em production sem smtp', () => {
    const { exigirDisponivel } = modulo();
    assert.throws(() => exigirDisponivel('production', 'desativado'), (e) => e.status === 503 && e.codigo === 'CONVITE_ENTREGA_INDISPONIVEL');
    assert.throws(() => exigirDisponivel('production', 'arquivo'), (e) => e.status === 503);
    for (const [ambiente, modo] of [['production', 'smtp'], ['development', 'desativado'], ['test', 'arquivo'], ['development', 'smtp']]) {
      assert.doesNotThrow(() => exigirDisponivel(ambiente, modo), `${ambiente}/${modo}`);
    }
  });
});

describe('entrada inválida e silêncio do console', () => {
  test('tipo e token inválidos são erro de programação', async () => {
    for (const ruim of [{ tipo: 'OUTRO' }, { token: '' }, { token: null }]) {
      await assert.rejects(() => entregar(usuario(ruim), { ambiente: 'test', config: desativado }), TypeError, JSON.stringify(ruim));
    }
  });

  test('a entrega não escreve nada no console: nem token, nem link, nem e-mail', async (t) => {
    const saidas = [];
    for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });
    await entregar(usuario(), { ambiente: 'test', config: desativado });
    await entregar(usuario(), { ambiente: 'production', config: smtp, servico: servicoFalso('FALHA') });
    assert.deepEqual(saidas, []);
  });
});
