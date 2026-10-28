'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');

const P = require('../js/permissoes-efetivas');

/**
 * Privacidade e LGPD no ponto central da navegação (permissoes-efetivas.js): PAGINAS.lgpd exige lgpd.visualizar; o item
 * "Privacidade / LGPD" que as páginas integradas trazem como "Em integração" passa a abrir lgpd.html SÓ para quem tem a permissão
 * (ajustarMenuLgpd), sem editar as páginas homologadas; a LGPD sai da liberação visual do MASTER (?inspecao=1). Gestão de E-mails
 * e o Totem continuam exatamente como estavam.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const corpo = ({ lgpd = false, perfil = 'ADMINISTRADOR' } = {}) => ({
  empresaId: 3, usuarioId: 7, perfil,
  recursos: { lgpd: { ...NENHUMA, visualizar: lgpd }, companyData: { ...NENHUMA, visualizar: true } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false },
  },
});

// <a class="nav-pendente" aria-disabled="true" title="Em integração"><div class="nav-icon">ícone</div>Rótulo<span class="nav-etiqueta">Em integração</span></a>
function pendente(rotulo) {
  const atributos = { class: 'nav-pendente', 'aria-disabled': 'true', title: 'Em integração' };
  const etiqueta = { nodeType: 1, textContent: 'Em integração', parentNode: null };
  const a = {
    atributos,
    style: {},
    childNodes: [{ nodeType: 1, textContent: 'privacy_tip' }, { nodeType: 3, textContent: rotulo }, etiqueta],
    classList: {
      contains: (c) => atributos.class.split(' ').includes(c),
      remove: (c) => { atributos.class = atributos.class.split(' ').filter((x) => x !== c).join(' '); },
    },
    getAttribute: (n) => (Object.hasOwn(atributos, n) ? atributos[n] : null),
    setAttribute: (n, v) => { atributos[n] = String(v); },
    removeAttribute: (n) => { delete atributos[n]; },
    querySelectorAll: (sel) => (sel === '.nav-etiqueta' ? a.childNodes.filter((n) => n === etiqueta && n.parentNode === a) : []),
  };
  etiqueta.parentNode = a;
  a.removeChild = (n) => { a.childNodes = a.childNodes.filter((x) => x !== n); n.parentNode = null; };
  return a;
}
const raizCom = (itens) => ({ querySelectorAll: (sel) => (sel === '.nav a' || sel === 'a.nav-pendente' ? itens.filter((i) => sel === '.nav a' || i.classList.contains('nav-pendente')) : []) });
const rotuloDe = (a) => a.childNodes.filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();

describe('PAGINAS.lgpd e a saída da inspeção', () => {
  test('a página lgpd abre só com lgpd.visualizar e não tem "alterar"', () => {
    assert.deepEqual(P.PAGINAS.lgpd, { abrir: [{ recurso: 'lgpd', operacao: 'visualizar' }], alterar: [] });
    assert.equal(P.podeAbrir(corpo({ lgpd: true }), 'lgpd'), true);
    assert.equal(P.podeAbrir(corpo({ lgpd: false }), 'lgpd'), false);
    assert.equal(P.podeAbrir(corpo({ lgpd: false, perfil: 'MASTER' }), 'lgpd'), false, 'o nome do perfil não decide');
    assert.equal(P.podeAlterar(corpo({ lgpd: true }), 'lgpd'), false);
  });

  test('INSPECAO_PROTOTIPOS fica só com o Totem e a Gestão de E-mails; o MASTER não recebe mais link de inspeção para a LGPD', () => {
    assert.deepEqual(P.INSPECAO_PROTOTIPOS, { 'Autoatendimento (Totem)': 'self-service.html', 'Gestão de E-mails': 'emails-gestao.html' });
    const lgpd = pendente('Privacidade / LGPD');
    const emails = pendente('Gestão de E-mails');
    P.liberarInspecao({ perfil: 'MASTER' }, raizCom([lgpd, emails]));
    assert.equal(lgpd.atributos.href, undefined, 'LGPD: sem link de inspeção');
    assert.equal(lgpd.atributos['aria-disabled'], 'true');
    assert.equal(emails.atributos.href, 'emails-gestao.html?inspecao=1', 'Gestão de E-mails continua em inspeção para o MASTER');
  });
});

describe('ajustarMenuLgpd', () => {
  test('com lgpd.visualizar: o item pendente vira link operacional (href lgpd.html, sem aria-disabled, sem classe pendente, sem etiqueta, com data-pagina)', () => {
    const item = pendente('Privacidade / LGPD');
    const outro = pendente('Gestão de E-mails');
    P.ajustarMenuLgpd(corpo({ lgpd: true }), raizCom([item, outro]));
    assert.equal(item.atributos.href, 'lgpd.html');
    assert.equal(item.atributos['aria-disabled'], undefined);
    assert.equal(item.atributos.title, undefined);
    assert.equal(item.classList.contains('nav-pendente'), false);
    assert.equal(item.atributos['data-pagina'], 'lgpd');
    assert.equal(item.querySelectorAll('.nav-etiqueta').length, 0, 'etiqueta "Em integração" removida');
    assert.equal(rotuloDe(item), 'Privacidade / LGPD');
    assert.equal(item.style.display, '');
    assert.equal(outro.atributos.href, undefined, 'Gestão de E-mails não é tocada');
    assert.equal(outro.classList.contains('nav-pendente'), true);
  });

  test('sem a permissão (ou sem permissões confirmadas): o item não é oferecido — some do menu, com ou sem ajuste anterior', () => {
    const nunca = pendente('Privacidade / LGPD');
    P.ajustarMenuLgpd(corpo({ lgpd: false }), raizCom([nunca]));
    assert.equal(nunca.atributos.href, undefined);
    assert.equal(nunca.style.display, 'none');

    const antes = pendente('Privacidade / LGPD');
    P.ajustarMenuLgpd(corpo({ lgpd: true }), raizCom([antes]));
    assert.equal(antes.atributos.href, 'lgpd.html');
    P.ajustarMenuLgpd(corpo({ lgpd: false }), raizCom([antes]));
    assert.equal(antes.atributos.href, undefined, 'revalidação sem a permissão retira o link');
    assert.equal(antes.style.display, 'none');
    P.ajustarMenuLgpd(null, raizCom([antes]));
    assert.equal(antes.style.display, 'none');
    P.ajustarMenuLgpd(corpo({ lgpd: true }), raizCom([antes]));
    assert.equal(antes.atributos.href, 'lgpd.html');
    assert.equal(antes.style.display, '');
    assert.doesNotThrow(() => P.ajustarMenuLgpd(corpo({ lgpd: true }), null));
  });

  test('rótulo diferente ou item já estático (data-pagina="lgpd" sem nav-pendente) não é tocado por esta função', () => {
    const outro = pendente('Privacidade');
    P.ajustarMenuLgpd(corpo({ lgpd: true }), raizCom([outro]));
    assert.equal(outro.atributos.href, undefined);
  });
});

describe('páginas integradas reais', () => {
  const contexto = (perfil = 'ADMINISTRADOR') => ({
    status: 'ok',
    usuario: { id: 7, nome: 'Eva Teste', email: 'eva@example.invalid', perfil },
    empresa: { id: 3, nome: 'Empresa Alfa Ltda', cnpj: '11222333000181' },
    preferencias: { tema: 'claro', modoVisual: 'padrao' },
  });
  const dadosEmpresa = { razaoSocial: 'Empresa Alfa Ltda', cnpj: '11222333000181', nomeFantasia: null, inscricaoEstadual: null, situacaoInscricaoEstadual: null, endereco: null, numero: null, complemento: null, bairro: null, cidade: null, uf: null, cep: null, telefone: null, email: null, emailSst: null, emailAlmoxarifado: null, representante: { nome: null, cargo: null, email: null, telefone: null }, financeiro: { nome: null, email: null, telefone: null }, versao: 1, camposBloqueados: ['razaoSocial', 'cnpj'] };
  async function abrir({ lgpd, perfil = 'ADMINISTRADOR' }) {
    const pg = abrirPagina('pages/company-data.html', { rotas: {
      'GET /auth/me': { status: 200, corpo: contexto(perfil) },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: { status: 'ok', ...corpo({ lgpd, perfil }) } },
      'GET /empresa/dados': { status: 200, corpo: { status: 'ok', dados: dadosEmpresa } },
    } });
    await pg.esperar(); await pg.esperar(); await pg.esperar();
    return pg;
  }
  const itemLgpd = (pg) => pg.consulta('.nav a').find((a) => /Privacidade \/ LGPD/.test(a.textContent));
  const itemEmails = (pg) => pg.consulta('.nav a').find((a) => /Gestão de E-mails/.test(a.textContent));

  test('Dados da Empresa com lgpd.visualizar: o item LGPD vira link para lgpd.html, sem etiqueta; sem a permissão, some', async () => {
    const com = await abrir({ lgpd: true });
    const item = itemLgpd(com);
    assert.equal(item.getAttribute('href'), 'lgpd.html');
    assert.equal(item.getAttribute('aria-disabled'), null);
    assert.equal(item.classList.contains('nav-pendente'), false);
    assert.equal(item.querySelectorAll('.nav-etiqueta').length, 0);
    assert.equal(com.visivelNo(item), true);

    const sem = await abrir({ lgpd: false });
    assert.equal(sem.visivelNo(itemLgpd(sem)), false);
    assert.equal(itemLgpd(sem).getAttribute('href'), null);
  });

  test('MASTER sem a permissão: nenhum link para a LGPD (nem de inspeção); Gestão de E-mails segue em inspeção para ele', async () => {
    const pg = await abrir({ lgpd: false, perfil: 'MASTER' });
    assert.equal(pg.visivelNo(itemLgpd(pg)), false);
    assert.equal(itemLgpd(pg).getAttribute('href'), null);
    assert.equal(itemEmails(pg).getAttribute('href'), 'emails-gestao.html?inspecao=1');
    assert.equal(itemEmails(pg).classList.contains('nav-pendente'), true);
  });

  test('todas as páginas integradas continuam com o item estático "Em integração" da LGPD (nenhuma foi editada): o ajuste é central', () => {
    const paginas = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html') && !/ 2\./.test(f) && f !== 'lgpd.html');
    const integradas = paginas.filter((f) => /data-pagina="userAdmin"/.test(ler(`pages/${f}`)));
    assert.ok(integradas.length >= 20);
    for (const f of integradas) {
      assert.match(ler(`pages/${f}`), /<a class="nav-pendente" aria-disabled="true" title="Em integração"><div class="nav-icon indigo">privacy_tip<\/div>Privacidade \/ LGPD<span class="nav-etiqueta">Em integração<\/span><\/a>/, f);
    }
  });
});
