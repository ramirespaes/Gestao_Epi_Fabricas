'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const EpiUsuarios = require('../js/usuarios');
const P = require('../js/permissoes-efetivas');

/**
 * Parte F — páginas: Administração de usuários (pages/user-admin.html),
 * Novo usuário (pages/new-user.html) e o aceite público do convite
 * (portal/aceitar-convite.html). Scripts embutidos em DOM simulado,
 * inspeção estática, menus, Portal, Permissões do Grupo e publicação.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
const ATAQUE = '<img src=x onerror=alert(1)>';
const TOKEN = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFy'.slice(0, 43);
const LINK = `http://localhost:5500/portal/aceitar-convite.html#token=${TOKEN}`;

let chamadas;
function servidor(responder) {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      const u = new URL(url);
      const corpo = opcoes.body === undefined ? undefined : JSON.parse(opcoes.body);
      chamadas.push({ metodo: opcoes.method, caminho: u.pathname + u.search, corpo });
      const r = responder(opcoes.method, u, corpo);
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
const ultima = () => chamadas.at(-1);

function criarElemento(id) {
  const classes = new Set();
  return {
    id, value: '', textContent: '', innerHTML: '', className: '', disabled: false, readOnly: false, style: {}, atributos: {}, listeners: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, getAttribute(k) { return this.atributos[k] ?? null; },
    focus() {}, select() { this.selecionado = true; },
  };
}

function montarDom() {
  const mapa = {};
  const el = (id) => (mapa[id] = mapa[id] || criarElemento(id));
  const esperar = async () => { for (let i = 0; i < 40; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click', evento = {}) => {
    for (const fn of (el(id).listeners[ev] || [])) await fn({ preventDefault() {}, ...evento });
    await esperar();
  };
  // Clique numa linha: o alvo tem closest('[data-acao]') que devolve o botão.
  const clicarAcao = (corpoId, acao, id, desabilitado = false) => disparar(corpoId, 'click', {
    target: { closest: () => ({ disabled: desabilitado, getAttribute: (k) => ({ 'data-acao': acao, 'data-id': String(id) })[k] ?? null }) },
  });
  return { el, mapa, esperar, disparar, clicarAcao };
}

function scriptEmbutido(arquivo) {
  const html = ler(arquivo);
  return html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
}

const CONTEXTO = { empresa: { id: 3, nome: 'Empresa' }, usuario: { id: 7, nome: 'Marta', perfil: 'MASTER' } };

function rodarPagina(arquivo, { pagina, acesso = { permissoes: {}, podeAlterar: true }, clipboard } = {}) {
  const dom = montarDom();
  const sandbox = {
    document: { getElementById: dom.el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE, location: { search: '' } },
    navigator: clipboard ? { clipboard } : {},
    EpiHttp, EpiUsuarios,
    EpiPermissoes: { prepararPagina: async (o) => { sandbox.opcoesPagina = o; return acesso; }, somenteLeitura: P.somenteLeitura },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesSessao = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, Promise, String, Number, Array, Object, JSON,
  };
  vm.runInNewContext(scriptEmbutido(arquivo), sandbox);
  assert.ok(pagina);
  return { ...dom, sandbox };
}

// ═══════════════════════════════════════════════════════════════════
// Administração de usuários
// ═══════════════════════════════════════════════════════════════════
const usuario = (extra = {}) => ({
  id: 12, nome: 'Fulana de Tal', email: 'fulana@exemplo-cliente.com.br', perfil: 'USUARIO', ativo: true,
  criadoEm: '2026-09-27T13:05:00.000Z', grupo: null, podeGerenciar: true, proprio: false, ...extra,
});
const USUARIOS = [
  usuario({ id: 7, nome: 'Marta Master', perfil: 'MASTER', proprio: true }),
  usuario(),
  usuario({ id: 13, nome: 'Ivo Inativo', ativo: false }),
];
const listagem = (extra = {}) => ({ status: 'ok', usuarios: USUARIOS, total: 3, pagina: 1, limite: 20, paginas: 1, mastersAtivos: 1, perfisGerenciaveis: ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO'], ...extra });

function paginaAdmin({ responder, acesso } = {}) {
  servidor(responder || ((m) => resposta(200, m === 'GET' ? listagem() : { status: 'ok', usuario: usuario(), alterado: true })));
  return rodarPagina('pages/user-admin.html', { pagina: 'userAdmin', acesso });
}

describe('Administração de usuários (DOM simulado)', () => {
  test('abre pela área usuarios e lista a empresa da sessão; único MASTER ativo avisado', async () => {
    const pg = paginaAdmin();
    await pg.esperar();
    assert.equal(pg.sandbox.opcoesPagina.pagina, 'userAdmin');
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho]), [['GET', '/api/administracao/usuarios?ordem=nome&pagina=1&limite=20']]);
    assert.match(pg.el('usuariosCorpo').innerHTML, /Fulana de Tal/);
    assert.match(pg.el('usuariosCorpo').innerHTML, /data-acao="inativar" data-id="7" disabled/);
    assert.equal(pg.el('paginacaoTexto').textContent, 'Usuários 1–3 de 3 · página 1 de 1');
    assert.match(pg.el('avisoMaster').textContent, /único MASTER ativo/);
    assert.equal(pg.el('botaoNovoUsuario').style.display, '');
  });

  test('sem acesso à página: nenhuma consulta', async () => {
    const pg = paginaAdmin({ acesso: null });
    await pg.esperar();
    assert.deepEqual(chamadas, []);
  });

  test('filtros vão para o servidor; limpar volta ao padrão', async () => {
    const pg = paginaAdmin();
    await pg.esperar();
    Object.assign(pg.el('filtroBusca'), { value: '  fulana ' });
    Object.assign(pg.el('filtroSituacao'), { value: 'ATIVO' });
    Object.assign(pg.el('filtroPerfil'), { value: 'USUARIO' });
    Object.assign(pg.el('filtroOrdem'), { value: 'recentes' });
    await pg.disparar('botaoFiltrar');
    assert.equal(ultima().caminho, '/api/administracao/usuarios?busca=fulana&situacao=ATIVO&perfil=USUARIO&ordem=recentes&pagina=1&limite=20');
    await pg.disparar('botaoLimparFiltros');
    assert.equal(ultima().caminho, '/api/administracao/usuarios?ordem=nome&pagina=1&limite=20');
  });

  test('editar: modal com nome, e-mail só leitura e tipos liberados; salva só o que mudou', async () => {
    const pg = paginaAdmin();
    await pg.esperar();
    await pg.clicarAcao('usuariosCorpo', 'editar', 12);
    assert.equal(pg.el('modalUsuario').classList.contains('open'), true);
    assert.deepEqual([pg.el('campoNome').value, pg.el('campoEmail').value, pg.el('campoTipoConta').disabled], ['Fulana de Tal', 'fulana@exemplo-cliente.com.br', false]);
    assert.match(pg.el('campoTipoConta').innerHTML, /<option value="USUARIO" selected>Usuário<\/option>/);
    pg.el('campoNome').value = 'Fulana Souza';
    pg.el('campoTipoConta').value = 'SUPERVISOR';
    await pg.disparar('formUsuario', 'submit');
    const patch = chamadas.find((c) => c.metodo === 'PATCH');
    assert.deepEqual([patch.caminho, patch.corpo], ['/api/administracao/usuarios/12', { nome: 'Fulana Souza', tipoConta: 'SUPERVISOR' }]);
    assert.equal(pg.el('modalUsuario').classList.contains('open'), false);
    assert.equal(ultima().metodo, 'GET', 'a lista é recarregada');
  });

  test('último MASTER: tipo de conta travado no modal; só o nome segue', async () => {
    const pg = paginaAdmin();
    await pg.esperar();
    await pg.clicarAcao('usuariosCorpo', 'editar', 7);
    assert.equal(pg.el('campoTipoConta').disabled, true);
    assert.match(pg.el('notaTipoConta').textContent, /Único MASTER ativo/);
    pg.el('campoNome').value = 'Marta Souza';
    pg.el('campoTipoConta').value = 'USUARIO';
    await pg.disparar('formUsuario', 'submit');
    assert.deepEqual(chamadas.find((c) => c.metodo === 'PATCH').corpo, { nome: 'Marta Souza' });
  });

  test('desativar e reativar pedem confirmação; o botão desabilitado não faz nada', async () => {
    const pg = paginaAdmin();
    await pg.esperar();
    await pg.clicarAcao('usuariosCorpo', 'inativar', 7, true);
    assert.equal(pg.el('modalConfirmar').classList.contains('open'), false);
    await pg.clicarAcao('usuariosCorpo', 'inativar', 12);
    assert.equal(pg.el('modalConfirmar').classList.contains('open'), true);
    assert.match(pg.el('confirmarTexto').textContent, /perde o acesso a esta empresa/);
    assert.equal(chamadas.some((c) => c.metodo === 'POST'), false, 'nada antes de confirmar');
    await pg.disparar('botaoConfirmar');
    assert.ok(chamadas.some((c) => c.metodo === 'POST' && c.caminho === '/api/administracao/usuarios/12/inativar'));
    await pg.clicarAcao('usuariosCorpo', 'reativar', 13);
    await pg.disparar('botaoConfirmar');
    assert.ok(chamadas.some((c) => c.metodo === 'POST' && c.caminho === '/api/administracao/usuarios/13/reativar'));
  });

  test('recusa do servidor vira texto próprio; 401 volta ao Portal', async () => {
    const pg = paginaAdmin({ responder: (m) => (m === 'GET' ? resposta(200, listagem()) : resposta(409, { status: 'error', codigo: 'USUARIO_ULTIMO_MASTER', message: 'SEGREDO-INTERNO' })) });
    await pg.esperar();
    await pg.clicarAcao('usuariosCorpo', 'inativar', 12);
    await pg.disparar('botaoConfirmar');
    assert.match(pg.el('aviso').innerHTML, /pelo menos um MASTER ativo/);
    assert.equal(/SEGREDO/.test(pg.el('aviso').innerHTML), false);

    const outra = paginaAdmin({ responder: () => resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA' }) });
    await outra.esperar();
    assert.equal(outra.sandbox.encerrada, true);
  });

  test('sem poder alterar: sem botões, sem "Novo usuário", e clique forjado não chama nada', async () => {
    const pg = paginaAdmin({ acesso: { permissoes: {}, podeAlterar: false } });
    await pg.esperar();
    assert.equal(/<button/.test(pg.el('usuariosCorpo').innerHTML), false);
    assert.equal(pg.el('botaoNovoUsuario').style.display, 'none');
    await pg.clicarAcao('usuariosCorpo', 'editar', 12);
    assert.equal(pg.el('modalUsuario').classList.contains('open'), false);
  });

  test('XSS: nome e e-mail do servidor na confirmação e no modal só como texto/valor', async () => {
    const pg = paginaAdmin({ responder: (m) => resposta(200, m === 'GET' ? listagem({ usuarios: [usuario({ nome: ATAQUE, email: ATAQUE })] }) : { status: 'ok' }) });
    await pg.esperar();
    assert.equal(/<img/.test(pg.el('usuariosCorpo').innerHTML), false);
    await pg.clicarAcao('usuariosCorpo', 'inativar', 12);
    assert.ok(pg.el('confirmarTexto').textContent.includes(ATAQUE), 'textContent, nunca HTML');
    await pg.clicarAcao('usuariosCorpo', 'editar', 12);
    assert.equal(pg.el('campoEmail').value, ATAQUE);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Novo usuário (convites)
// ═══════════════════════════════════════════════════════════════════
const convite = (extra = {}) => ({
  id: '31', emailConvite: 'nova@exemplo-cliente.com.br', nome: 'Nova Pessoa', perfil: 'SUPERVISOR', situacao: 'PENDENTE',
  criadoEm: '2026-09-27T13:05:00.000Z', expiraEm: '2026-09-30T13:05:00.000Z', criadoPor: { nome: 'Marta' }, podeCancelar: true, ...extra,
});
const convites = (extra = {}) => ({ status: 'ok', convites: [convite()], total: 1, pagina: 1, limite: 20, paginas: 1, perfisGerenciaveis: ['SUPERVISOR', 'USUARIO'], ...extra });
const criado = { status: 'ok', convite: convite({ id: '32', emailConvite: 'outra@exemplo-cliente.com.br' }), entrega: { modo: 'DESENVOLVIMENTO_SEM_EMAIL', linkAceite: LINK, expiraEm: '2026-09-30T13:05:00.000Z' } };

const criadoComEmail = (estado) => ({
  status: 'ok',
  convite: convite({ id: '32', emailConvite: 'outra@exemplo-cliente.com.br' }),
  entrega: { modo: 'EMAIL', estado, expiraEm: '2026-09-30T13:05:00.000Z' },
});

async function preencherEEnviar(pg) {
  Object.assign(pg.el('novoNome'), { value: 'Outra Pessoa' });
  Object.assign(pg.el('novoEmail'), { value: 'outra@exemplo-cliente.com.br' });
  Object.assign(pg.el('novoTipo'), { value: 'SUPERVISOR' });
  await pg.disparar('formConvite', 'submit');
}

function paginaNovo({ responder, acesso, clipboard } = {}) {
  servidor(responder || ((m, u) => {
    if (m === 'GET') return resposta(200, convites());
    if (u.pathname.endsWith('/cancelar')) return resposta(200, { status: 'ok', convite: convite({ situacao: 'CANCELADO' }) });
    return resposta(201, criado);
  }));
  return rodarPagina('pages/new-user.html', { pagina: 'newUser', acesso, clipboard });
}

describe('Novo usuário (DOM simulado)', () => {
  test('abre pela área usuarios; tipos de conta vêm do servidor; convites em aberto listados', async () => {
    const pg = paginaNovo();
    await pg.esperar();
    assert.equal(pg.sandbox.opcoesPagina.pagina, 'newUser');
    assert.deepEqual(chamadas.map((c) => c.caminho), ['/api/administracao/convites-usuario?pagina=1&limite=20']);
    assert.equal(pg.el('novoTipo').innerHTML, '<option value="USUARIO" selected>Usuário</option><option value="SUPERVISOR">Supervisor</option>');
    assert.match(pg.el('convitesCorpo').innerHTML, /nova@exemplo-cliente\.com\.br/);
    assert.equal(pg.el('convitesTexto').textContent, 'Convites 1–1 de 1 · página 1 de 1');
  });

  test('criar convite: manda só nome, e-mail e tipo de conta; o link aparece só no campo de cópia', async () => {
    const pg = paginaNovo();
    await pg.esperar();
    Object.assign(pg.el('novoNome'), { value: '  Outra Pessoa ' });
    Object.assign(pg.el('novoEmail'), { value: ' outra@exemplo-cliente.com.br ' });
    Object.assign(pg.el('novoTipo'), { value: 'SUPERVISOR' });
    await pg.disparar('formConvite', 'submit');
    const post = chamadas.find((c) => c.metodo === 'POST');
    assert.deepEqual([post.caminho, post.corpo], ['/api/administracao/convites-usuario', { email: 'outra@exemplo-cliente.com.br', nome: 'Outra Pessoa', tipoConta: 'SUPERVISOR' }]);
    assert.equal(pg.el('linkConvite').value, LINK);
    assert.equal(pg.el('resultadoEmail').textContent, 'outra@exemplo-cliente.com.br');
    assert.equal(pg.el('resultadoValidade').textContent, '30/09/2026');
    assert.equal(pg.el('resultadoConvite').style.display, '');
    for (const e of Object.values(pg.mapa)) assert.equal(String(e.innerHTML).includes(TOKEN), false, `token no innerHTML de ${e.id}`);
    assert.deepEqual([pg.el('novoNome').value, pg.el('novoEmail').value], ['', '']);
    assert.equal(ultima().metodo, 'GET', 'a lista é recarregada');
  });

  test('criar convite com o e-mail enviado (production): sem link na tela e com a confirmação do envio', async () => {
    const pg = paginaNovo({ responder: (m) => (m === 'GET' ? resposta(200, convites()) : resposta(201, criadoComEmail('ENVIADO'))) });
    await pg.esperar();
    await preencherEEnviar(pg);
    assert.equal(pg.el('linkConvite').value, '');
    assert.equal(pg.el('blocoLinkConvite').style.display, 'none');
    assert.match(pg.el('resultadoEstado').textContent, /enviado por e-mail/);
    assert.equal(pg.el('resultadoTitulo').textContent, 'Convite criado');
    assert.equal(pg.el('resultadoEmail').textContent, 'outra@exemplo-cliente.com.br');
    assert.equal(pg.el('resultadoConvite').style.display, '');
    for (const e of Object.values(pg.mapa)) assert.equal(/undefined|null/.test(`${e.textContent}${e.value}`), false, `texto quebrado em ${e.id}`);
  });

  test('criar convite com falha no envio: o convite existe, a tela diz isso, aponta o Reenviar e não mostra link', async () => {
    const pg = paginaNovo({ responder: (m) => (m === 'GET' ? resposta(200, convites()) : resposta(201, criadoComEmail('FALHA'))) });
    await pg.esperar();
    await preencherEEnviar(pg);
    assert.match(pg.el('resultadoEstado').textContent, /não pôde ser enviado/);
    assert.match(pg.el('resultadoEstado').textContent, /Reenviar/);
    assert.equal(pg.el('linkConvite').value, '');
    assert.equal(pg.el('blocoLinkConvite').style.display, 'none');
    assert.equal(ultima().metodo, 'GET', 'a lista é recarregada e mostra o convite pendente');
  });

  test('em desenvolvimento o link continua aparecendo no bloco de cópia', async () => {
    const pg = paginaNovo();
    await pg.esperar();
    await preencherEEnviar(pg);
    assert.equal(pg.el('blocoLinkConvite').style.display, '');
    assert.match(pg.el('resultadoEstado').textContent, /copie o link/);
  });

  test('copiar o link usa a área de transferência; fechar apaga o link da tela', async () => {
    const copiados = [];
    const pg = paginaNovo({ clipboard: { writeText: async (t) => { copiados.push(t); } } });
    await pg.esperar();
    Object.assign(pg.el('novoNome'), { value: 'Outra' });
    Object.assign(pg.el('novoEmail'), { value: 'outra@exemplo-cliente.com.br' });
    Object.assign(pg.el('novoTipo'), { value: 'USUARIO' });
    await pg.disparar('formConvite', 'submit');
    await pg.disparar('botaoCopiarLink');
    assert.deepEqual(copiados, [LINK]);
    await pg.disparar('botaoFecharResultado');
    assert.deepEqual([pg.el('linkConvite').value, pg.el('resultadoConvite').style.display], ['', 'none']);
  });

  test('campos vazios ou tipo fora da lista: nada é enviado', async () => {
    const pg = paginaNovo();
    await pg.esperar();
    Object.assign(pg.el('novoNome'), { value: '   ' });
    Object.assign(pg.el('novoEmail'), { value: 'x@y.com' });
    Object.assign(pg.el('novoTipo'), { value: 'MASTER_FORJADO' });
    await pg.disparar('formConvite', 'submit');
    assert.equal(chamadas.some((c) => c.metodo === 'POST'), false);
    assert.match(pg.el('erroConvite').textContent, /Preencha/);
  });

  test('recusa do servidor: texto próprio, sem ecoar a mensagem', async () => {
    const pg = paginaNovo({ responder: (m) => (m === 'GET' ? resposta(200, convites()) : resposta(409, { status: 'error', codigo: 'USUARIO_VINCULO_EXISTENTE', message: 'SEGREDO-INTERNO' })) });
    await pg.esperar();
    Object.assign(pg.el('novoNome'), { value: 'Outra' });
    Object.assign(pg.el('novoEmail'), { value: 'outra@exemplo-cliente.com.br' });
    Object.assign(pg.el('novoTipo'), { value: 'USUARIO' });
    await pg.disparar('formConvite', 'submit');
    assert.match(pg.el('erroConvite').textContent, /já tem um usuário nesta empresa/);
    assert.equal(/SEGREDO/.test(pg.el('erroConvite').textContent), false);
    assert.equal(pg.el('linkConvite').value, '');
  });

  test('cancelar convite pede confirmação e recarrega a lista', async () => {
    const pg = paginaNovo();
    await pg.esperar();
    await pg.clicarAcao('convitesCorpo', 'cancelar-convite', '31');
    assert.equal(pg.el('modalConfirmar').classList.contains('open'), true);
    assert.equal(chamadas.some((c) => c.metodo === 'POST'), false);
    await pg.disparar('botaoConfirmar');
    assert.ok(chamadas.some((c) => c.metodo === 'POST' && c.caminho === '/api/administracao/convites-usuario/31/cancelar'));
    assert.equal(ultima().metodo, 'GET');
  });

  test('reenviar convite: pede ao servidor, mostra o novo envio sem link em production e recarrega a lista', async () => {
    const pg = paginaNovo({
      responder: (m, u) => {
        if (m === 'GET') return resposta(200, convites());
        assert.ok(u.pathname.endsWith('/31/reenviar'), u.pathname);
        return resposta(201, { status: 'ok', convite: convite({ id: '33' }), conviteAnteriorId: '31', entrega: { modo: 'EMAIL', estado: 'ENVIADO', expiraEm: '2026-10-03T13:05:00.000Z' } });
      },
    });
    await pg.esperar();
    await pg.clicarAcao('convitesCorpo', 'reenviar-convite', '31');
    const posts = chamadas.filter((c) => c.metodo === 'POST');
    assert.deepEqual(posts.map((c) => [c.caminho, c.corpo]), [['/api/administracao/convites-usuario/31/reenviar', {}]]);
    assert.equal(pg.el('modalConfirmar').classList.contains('open'), false, 'reenviar não abre a confirmação do cancelamento');
    assert.equal(pg.el('resultadoTitulo').textContent, 'Convite reenviado');
    assert.equal(pg.el('resultadoEmail').textContent, 'nova@exemplo-cliente.com.br');
    assert.match(pg.el('resultadoEstado').textContent, /enviado por e-mail/);
    assert.match(pg.el('resultadoEstado').textContent, /link anterior deixou de valer/);
    assert.equal(pg.el('linkConvite').value, '');
    assert.equal(pg.el('blocoLinkConvite').style.display, 'none');
    assert.equal(ultima().metodo, 'GET', 'a lista é recarregada');
  });

  test('reenviar em desenvolvimento mostra o link novo, e o link nunca vai para o HTML', async () => {
    const pg = paginaNovo({
      responder: (m) => (m === 'GET' ? resposta(200, convites()) : resposta(201, { status: 'ok', convite: convite({ id: '33' }), conviteAnteriorId: '31', entrega: { modo: 'DESENVOLVIMENTO_SEM_EMAIL', estado: 'NAO_ENVIADO', linkAceite: LINK, expiraEm: '2026-10-03T13:05:00.000Z' } })),
    });
    await pg.esperar();
    await pg.clicarAcao('convitesCorpo', 'reenviar-convite', '31');
    assert.equal(pg.el('linkConvite').value, LINK);
    assert.equal(pg.el('blocoLinkConvite').style.display, '');
    for (const e of Object.values(pg.mapa)) assert.equal(String(e.innerHTML).includes(TOKEN), false, `token no innerHTML de ${e.id}`);
  });

  test('reenvio recusado (convite que já foi aceito, limite): aviso com texto próprio, sem ecoar o servidor e sem resultado', async () => {
    for (const [status, codigo, esperado] of [[409, 'CONVITE_NAO_REENVIAVEL', /já foi aceito ou cancelado/], [429, 'CONVITE_ENVIO_MUITO_RECENTE', /há poucos instantes/], [429, 'CONVITE_ENVIO_LIMITE_DIARIO', /Limite de convites/]]) {
      const pg = paginaNovo({ responder: (m) => (m === 'GET' ? resposta(200, convites()) : resposta(status, { status: 'error', codigo, message: 'SEGREDO-INTERNO' })) });
      await pg.esperar();
      await pg.clicarAcao('convitesCorpo', 'reenviar-convite', '31');
      assert.match(pg.el('aviso').innerHTML, esperado, codigo);
      assert.equal(/SEGREDO/.test(pg.el('aviso').innerHTML), false, codigo);
      assert.equal(pg.el('resultadoConvite').style.display === '', false, 'sem bloco de resultado');
    }
  });

  test('dois cliques seguidos em Reenviar enviam uma única solicitação', async () => {
    let liberar;
    const trava = new Promise((resolver) => { liberar = resolver; });
    const pg = paginaNovo({
      responder: (m) => (m === 'GET' ? resposta(200, convites()) : trava.then(() => resposta(201, criadoComEmail('ENVIADO')))),
    });
    await pg.esperar();
    const primeiro = pg.clicarAcao('convitesCorpo', 'reenviar-convite', '31');
    const segundo = pg.clicarAcao('convitesCorpo', 'reenviar-convite', '31');
    await new Promise((resolver) => { setImmediate(resolver); });
    liberar();
    await Promise.all([primeiro, segundo]);
    assert.equal(chamadas.filter((c) => c.metodo === 'POST').length, 1);
  });

  test('sem poder alterar, um clique forjado em Reenviar não chama nada', async () => {
    const pg = paginaNovo({ acesso: { permissoes: {}, podeAlterar: false } });
    await pg.esperar();
    await pg.clicarAcao('convitesCorpo', 'reenviar-convite', '31');
    assert.equal(chamadas.some((c) => c.metodo === 'POST'), false);
  });

  test('sessão que terminou durante o reenvio leva à tela de sessão encerrada', async () => {
    const pg = paginaNovo({ responder: (m) => (m === 'GET' ? resposta(200, convites()) : resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA' })) });
    await pg.esperar();
    await pg.clicarAcao('convitesCorpo', 'reenviar-convite', '31');
    assert.equal(pg.sandbox.encerrada, true);
  });

  test('o HTML tem os pontos de ancoragem do resultado e não afirma, de forma fixa, que o e-mail não está configurado', () => {
    const html = semComentarios(ler('pages/new-user.html'));
    for (const id of ['resultadoTitulo', 'resultadoEstado', 'blocoLinkConvite', 'linkConvite', 'botaoCopiarLink', 'botaoFecharResultado']) {
      assert.match(html, new RegExp(`id="${id}"`), id);
    }
    const corpo = html.slice(0, html.lastIndexOf('<script>'));
    assert.equal(/ainda não está configurado/.test(corpo), false);
    assert.equal(/precisa ser cancelado antes de convidar/.test(corpo), false);
  });

  test('sem acesso: nenhuma consulta; sem poder alterar: formulário oculto', async () => {
    const semAcesso = paginaNovo({ acesso: null });
    await semAcesso.esperar();
    assert.deepEqual(chamadas, []);
    const soLeitura = paginaNovo({ acesso: { permissoes: {}, podeAlterar: false } });
    await soLeitura.esperar();
    assert.equal(soLeitura.el('cartaoConvite').style.display, 'none');
    await soLeitura.disparar('formConvite', 'submit');
    assert.equal(chamadas.some((c) => c.metodo === 'POST'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Aceite público do convite (portal/aceitar-convite.js)
// ═══════════════════════════════════════════════════════════════════
function paginaAceite({ hash = `#token=${TOKEN}`, responder } = {}) {
  servidor(responder || ((m, u) => (u.pathname.endsWith('/consultar')
    ? resposta(200, { status: 'ok', situacao: 'PENDENTE', empresa: { razaoSocial: 'Empresa Alfa' }, emailConvite: 'nova@exemplo-cliente.com.br', nome: 'Nova Pessoa', perfil: 'SUPERVISOR', expiraEm: '2026-09-30T13:05:00.000Z', identidadeExistente: false })
    : resposta(201, { status: 'ok', empresa: { razaoSocial: 'Empresa Alfa' }, usuario: { nome: 'Nova Pessoa', perfil: 'SUPERVISOR' }, identidadeCriada: true }))));
  const dom = montarDom();
  const historico = [];
  const janela = {
    location: { hash, pathname: '/portal/aceitar-convite.html', search: '' },
    history: { replaceState: (...a) => historico.push(a) },
    SAFEWORK_PORTAL_API_BASE_URL: BASE, EpiHttp, EpiUsuarios,
  };
  delete require.cache[require.resolve('../portal/aceitar-convite')];
  const A = require('../portal/aceitar-convite'); // eslint-disable-line global-require
  const pronto = A.iniciar(janela, { getElementById: dom.el, title: 'Aceitar convite' });
  return { ...dom, historico, pronto };
}

describe('aceite público do convite', () => {
  test('token só do fragmento, apagado da barra; consulta mostra empresa, e-mail, nome e tipo como texto', async () => {
    const pg = paginaAceite();
    await pg.pronto;
    await pg.esperar();
    assert.deepEqual(pg.historico, [[null, 'Aceitar convite', '/portal/aceitar-convite.html']]);
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho, c.corpo]), [['POST', '/api/convite-usuario/consultar', { token: TOKEN }]]);
    assert.deepEqual(['empresa', 'email', 'nomeConvite', 'tipoConta'].map((id) => pg.el(id).textContent), ['Empresa Alfa', 'nova@exemplo-cliente.com.br', 'Nova Pessoa', 'Supervisor']);
    assert.equal(pg.el('blocoConfirmacao').style.display, '', 'conta nova confirma a senha');
    assert.equal(pg.el('formAceite').style.display, 'block');
  });

  test('conta nova: confirmação diferente não envia; senha aceita cria o acesso e os campos são limpos', async () => {
    const pg = paginaAceite();
    await pg.pronto;
    Object.assign(pg.el('senha'), { value: 'Correnteza-Azul-Pedra-7319' });
    Object.assign(pg.el('senhaConfirmacao'), { value: 'outra' });
    await pg.disparar('formAceite', 'submit');
    assert.equal(chamadas.some((c) => c.caminho.endsWith('/aceitar')), false);
    assert.match(pg.el('mensagem').textContent, /confirmação/);
    Object.assign(pg.el('senha'), { value: 'Correnteza-Azul-Pedra-7319' });
    Object.assign(pg.el('senhaConfirmacao'), { value: 'Correnteza-Azul-Pedra-7319' });
    await pg.disparar('formAceite', 'submit');
    assert.deepEqual(ultima().corpo, { token: TOKEN, senha: 'Correnteza-Azul-Pedra-7319' });
    assert.deepEqual([pg.el('senha').value, pg.el('senhaConfirmacao').value], ['', '']);
    assert.equal(pg.el('sucesso').style.display, 'block');
    assert.equal(pg.el('empresaOk').textContent, 'Empresa Alfa');
  });

  test('conta existente: pede a senha atual, sem confirmação', async () => {
    const pg = paginaAceite({ responder: () => resposta(200, { status: 'ok', situacao: 'PENDENTE', empresa: { razaoSocial: 'E' }, emailConvite: 'a@b.com', nome: 'A', perfil: 'USUARIO', identidadeExistente: true }) });
    await pg.pronto;
    assert.equal(pg.el('rotuloSenha').textContent, 'Senha atual');
    assert.equal(pg.el('blocoConfirmacao').style.display, 'none');
  });

  test('sem token, token malformado ou convite expirado: mensagem própria e nenhum formulário', async () => {
    for (const hash of ['', '#token=curto', '#outra=1']) {
      const pg = paginaAceite({ hash });
      await pg.pronto;
      assert.deepEqual(chamadas, [], hash);
      assert.match(pg.el('mensagem').textContent, /Link de convite/);
    }
    const expirado = paginaAceite({ responder: () => resposta(409, { status: 'error', codigo: 'CONVITE_EXPIRADO', message: 'SEGREDO-INTERNO' }) });
    await expirado.pronto;
    assert.match(expirado.el('mensagem').textContent, /expirou/);
    assert.notEqual(expirado.el('formAceite').style.display, 'block');
  });

  test('XSS: dados do convite só por textContent', async () => {
    const pg = paginaAceite({ responder: () => resposta(200, { status: 'ok', situacao: 'PENDENTE', empresa: { razaoSocial: ATAQUE }, emailConvite: ATAQUE, nome: ATAQUE, perfil: ATAQUE, identidadeExistente: false }) });
    await pg.pronto;
    assert.equal(pg.el('empresa').textContent, ATAQUE);
    for (const e of Object.values(pg.mapa)) assert.equal(String(e.innerHTML).includes('<img'), false, e.id);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Inspeção estática
// ═══════════════════════════════════════════════════════════════════
const SCRIPTS_INTEGRADOS = ['../js/tema.js', '../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/usuarios.js'];
const PROIBIDOS = [/db-api\.js/, /main\.js/, /xlsx/i, /localStorage/, /sessionStorage/, /document\.cookie/, /showView\(/, /setActiveNav/, /data-page=/, /localhost:3000/, /Cobresul/, /doLogin/, /loginScreen/, /kiosk/i, /toggleRolePermission|toggleActionPerm|saveActionPerms/];

describe('inspeção estática das duas páginas', () => {
  for (const [arquivo, pagina, titulo, ativo] of [
    ['pages/user-admin.html', 'userAdmin', 'Administração de Usuários', 'Administração de Usuários'],
    ['pages/new-user.html', 'newUser', 'Novo Usuário', 'Novo Usuário'],
  ]) {
    test(`${arquivo}: página integrada, sem protótipo, tema no <head>, item ativo no menu`, () => {
      const html = ler(arquivo);
      const codigo = semComentarios(html).replace(/onclick="(closeMobileMenu|toggleSidebar)\(\)"/g, '');
      const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
      assert.deepEqual(scripts, SCRIPTS_INTEGRADOS);
      for (const proibido of PROIBIDOS) assert.equal(proibido.test(codigo), false, `contém ${proibido}`);
      assert.match(html.split('</head>')[0], /<link rel="stylesheet" href="\.\.\/css\/main\.css">\s*<script src="\.\.\/js\/tema\.js"><\/script>/);
      assert.match(html, new RegExp(`<title>${titulo} — Gestão de EPIs</title>`));
      assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
      assert.match(codigo, new RegExp(`EpiPermissoes\\.prepararPagina\\(\\{\\s*pagina: '${pagina}'`));
      assert.match(html, new RegExp(`<a class="active" href="javascript:void\\(0\\)" data-pagina="${pagina}" style="display:none"><div class="nav-icon [a-z]+">[a-z_]+</div>${ativo}</a>`));
      for (const id of ['identidade', 'botaoSair', 'botaoTrocarEmpresa']) assert.equal(html.includes(`id="${id}"`), false, id);
    });

    test(`${arquivo}: innerHTML só com o render do módulo ou o aviso escapado`, () => {
      const script = ler(arquivo).slice(ler(arquivo).lastIndexOf('<script>'));
      const origens = [...script.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
      assert.ok(origens.length > 0);
      for (const origem of origens) {
        assert.match(origem, /^(''|U\.render\.[a-zA-Z]+\([^;]*\)|'<div class="notice" style="' \+ cor \+ '">' \+ U\.render\.escaparHtml\(texto\) \+ '<\/div>')$/, origem);
      }
    });
  }

  test('Administração de usuários preserva o cabeçalho e a tabela do HTML original; sem os painéis decorativos', () => {
    const html = ler('pages/user-admin.html');
    assert.match(html, />Administração de Usuários<\/h2>/);
    assert.match(html, /<h2>Acesso por perfil<\/h2>/);
    assert.match(html, /<h2>Gerenciamento de contas<\/h2>/);
    const colunas = [...html.slice(html.indexOf('<thead>'), html.indexOf('</thead>')).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(colunas, ['Usuário', 'E-mail', 'Tipo de conta', 'Status', 'Ações']);
    assert.equal(/Permissões de ação por perfil|access-page-item|class="switch/.test(html), false, 'chaves falsas saíram');
    for (const [href, pagina] of [['grupos-acesso.html', 'grupos-acesso'], ['grupo-permissoes.html', 'grupo-permissoes'], ['grupo-usuarios.html', 'grupo-usuarios'], ['autorizacoes-individuais.html', 'autorizacoes-individuais']]) {
      assert.match(html.slice(html.indexOf('class="atalhos-acesso"')), new RegExp(`<a href="${href}" data-pagina="${pagina}" style="display:none"`));
    }
    assert.match(html, /<input id="campoEmail" class="input" type="email" readonly/);
    assert.match(semComentarios(html), /querySelectorAll\('\.nav a\[data-pagina\], \.atalhos-acesso a\[data-pagina\]'\)/);
  });

  test('Novo usuário preserva o cartão de cadastro com nome, e-mail e tipo de conta; sem campos sem dado real', () => {
    const html = ler('pages/new-user.html');
    assert.match(html, /<h2>Cadastrar Novo Usuário<\/h2>/);
    for (const [id, rotulo] of [['novoNome', 'Nome completo'], ['novoEmail', 'E-mail'], ['novoTipo', 'Tipo de conta']]) {
      assert.match(html, new RegExp(`<label for="${id}">${rotulo}</label>`), id);
    }
    for (const fora of ['novoTelefone', 'novoCpf', 'novaMatricula', 'novoStatus']) assert.equal(html.includes(`id="${fora}"`), false, fora);
    assert.match(html, /<h2>Convites em aberto<\/h2>/);
    assert.match(html, /<input id="linkConvite" class="input" type="text" readonly/);
    const colunas = [...html.slice(html.indexOf('<thead>'), html.indexOf('</thead>')).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    assert.deepEqual(colunas, ['E-mail', 'Nome', 'Tipo de conta', 'Situação', 'Validade', 'Convidado por', 'Ações']);
    assert.match(html, /<a href="user-admin\.html"[^>]*>[\s\S]*?Voltar para administração de usuários<\/a>/);
  });

  test('aceite público: sem referrer, token nunca na query, scripts do Portal, tema pelas variáveis', () => {
    const html = ler('portal/aceitar-convite.html');
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.deepEqual(scripts, ['../js/api-http.js', 'config.js', '../js/usuarios.js', 'aceitar-convite.js']);
    assert.match(html, /color-scheme: light dark/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    const js = semComentarios(ler('portal/aceitar-convite.js'));
    assert.match(js, /location\.hash/);
    assert.equal(/location\.search\)\.get\('token'\)|searchParams\.get\('token'\)|localStorage|sessionStorage|console\.log|innerHTML/.test(js), false);
    assert.match(html, /<a href="index\.html"[^>]*>Entrar no Portal<\/a>/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Menus, Portal, Permissões do Grupo e publicação
// ═══════════════════════════════════════════════════════════════════
const INTEGRADAS_COM_MENU = ['available-items.html', 'dashboard.html', 'employee-groups.html', 'employee-history.html', 'import-employees.html', 'materials.html', 'operations.html', 'stock-validity.html'];
const ADMINISTRATIVAS = ['autorizacoes-individuais.html', 'grupo-permissoes.html', 'grupo-usuarios.html', 'grupos-acesso.html'];
const LINK_NOVO = '<a href="new-user.html" data-pagina="newUser" style="display:none"><div class="nav-icon green">person_add</div>Novo Usuário</a>';
const LINK_ADMIN = '<a href="user-admin.html" data-pagina="userAdmin" style="display:none"><div class="nav-icon indigo">group</div>Administração de Usuários</a>';

describe('menus, Portal, Permissões do Grupo e publicação', () => {
  test('as páginas integradas levam às duas páginas reais (ocultas até a permissão); o item "em integração" saiu', () => {
    for (const arquivo of [...INTEGRADAS_COM_MENU, ...ADMINISTRATIVAS]) {
      const html = ler(`pages/${arquivo}`);
      assert.ok(html.includes(LINK_NOVO), `${arquivo}: Novo Usuário`);
      assert.ok(html.includes(LINK_ADMIN), `${arquivo}: Administração de Usuários`);
      assert.equal(/person_add<\/div>Novo Usuário<span|group<\/div>Administração de Usuários<span/.test(html), false, arquivo);
    }
    assert.ok(ler('pages/user-admin.html').includes(LINK_NOVO));
    assert.ok(ler('pages/new-user.html').includes(LINK_ADMIN));
  });

  test('Portal: os dois módulos depois de Importar funcionários, pela área usuarios', () => {
    const inicio = ler('portal/inicio.html');
    const paginas = [...inicio.matchAll(/<a href="\.\.\/pages\/[^"]+" data-pagina="([^"]+)" style="display:none">/g)].map((m) => m[1]);
    assert.deepEqual(paginas.slice(-3), ['importEmployees', 'newUser', 'userAdmin']);
    assert.match(inicio, /<a href="\.\.\/pages\/new-user\.html" data-pagina="newUser" style="display:none">Novo usuário<\/a>/);
    assert.match(inicio, /<a href="\.\.\/pages\/user-admin\.html" data-pagina="userAdmin" style="display:none">Administração de usuários<\/a>/);
  });

  test('Permissões do Grupo: Novo Usuário e Administração de Usuários explicam que o grupo não decide', () => {
    const G = require('../js/grupo-permissoes'); // eslint-disable-line global-require
    for (const id of ['newUser', 'userAdmin']) {
      const r = G.RECURSOS.find((x) => x.id === id);
      assert.deepEqual(r.operacoes, [], id);
      assert.equal(r.nota, 'Controlado pela autorização individual Gerenciar usuários (MASTER ou ADMINISTRADOR autorizado), não pelo grupo.');
    }
  });

  test('publicação: módulo, páginas e aceite na allowlist', () => {
    const arquivos = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    for (const f of ['js/usuarios.js', 'pages/new-user.html', 'pages/user-admin.html', 'portal/aceitar-convite.html', 'portal/aceitar-convite.js']) {
      assert.ok(arquivos.includes(f), f);
    }
  });
});
