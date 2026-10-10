'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EpiHttp = require('../js/api-http');
const T = require('../js/tema');
const P = require('../js/permissoes-efetivas');
const { lerAllowlist } = require('../publicacao/empacotar');

/**
 * Configurações (pages/config.html + js/configuracoes.js): tela pessoal da
 * conta autenticada — Minha Conta (nome, e-mail de acesso, telefone, perfil,
 * situação e último acesso), e-mail e telefone editáveis, senha pelo fluxo
 * real existente, e Aparência por identidade, auto-salva no servidor.
 */

const BASE = 'http://localhost:3000/api';
const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const modulo = () => require('../js/configuracoes');

const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });
let chamadas;
function servidor(...respostas) {
  chamadas = [];
  let i = 0;
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      chamadas.push({ metodo: opcoes.method, caminho: new URL(url).pathname, corpo: opcoes && opcoes.body ? JSON.parse(opcoes.body) : undefined });
      const r = typeof respostas[0] === 'function' ? respostas[0](chamadas[chamadas.length - 1]) : respostas[Math.min(i, respostas.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
  });
}
beforeEach(() => servidor(resposta(200, { status: 'ok' })));

const ME = {
  status: 'ok',
  identidade: { id: 9, email: 'ana@example.invalid', telefone: null, tema: 'sistema', modoVisual: 'padrao', ultimoAcessoEm: '2026-10-04T11:41:00.000Z' },
  empresas: [{ id: 3, nome: 'Empresa Demonstração' }],
  contexto: {
    empresa: { id: 3, nome: 'Empresa Demonstração', cnpj: '11222333000181' },
    usuario: { id: 7, nome: 'Ana <b>Souza</b>', perfil: 'SUPERVISOR', ativo: true, funcionario: { vinculado: false, matricula: null, cpfMascarado: null } },
  },
};
const SEM_VINCULO = { vinculado: false, matricula: null, cpfMascarado: null };
const COM_VINCULO = { vinculado: true, matricula: 'MAT-0077', cpfMascarado: '***.***.***-25' };
const comVinculo = (me = ME) => ({ ...me, contexto: { ...me.contexto, usuario: { ...me.contexto.usuario, funcionario: COM_VINCULO } } });

describe('módulo: contrato com o servidor', () => {
  test('caminhos, domínios iguais aos do tema, e a senha vai pelo fluxo real existente', () => {
    const C = modulo();
    assert.deepEqual(C.CAMINHOS, { me: '/auth/global/me', conta: '/auth/global/conta', email: '/auth/global/email' });
    assert.equal(C.TROCAR_SENHA, '../portal/trocar-senha.html');
    assert.deepEqual(C.TEMAS, T.TEMAS);
    assert.deepEqual(C.MODOS_VISUAIS, T.MODOS_VISUAIS);
  });

  test('consultar: lê /auth/global/me e monta a conta sem dado inventado; CPF (mascarado) e matrícula só pelo vínculo explícito declarado pelo servidor; falha devolve código e mensagem', async () => {
    servidor(resposta(200, ME));
    const r = await modulo().acoes.consultar();
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho]), [['GET', '/api/auth/global/me']]);
    assert.deepEqual(r, {
      ok: true,
      conta: {
        nome: 'Ana <b>Souza</b>', perfil: 'SUPERVISOR', ativo: true, email: 'ana@example.invalid', telefone: null,
        tema: 'sistema', modoVisual: 'padrao', ultimoAcessoEm: '2026-10-04T11:41:00.000Z', empresa: 'Empresa Demonstração',
        funcionario: SEM_VINCULO,
      },
    });
    assert.equal('cpf' in r.conta || 'matricula' in r.conta, false, 'CPF e matrícula só dentro do vínculo');
    servidor(resposta(200, comVinculo()));
    assert.deepEqual((await modulo().acoes.consultar()).conta.funcionario, COM_VINCULO);
    // Sem a declaração explícita do servidor, nada é deduzido: nem vinculado sem valores, nem valores sem vinculado.
    for (const f of [undefined, null, {}, { matricula: 'MAT-1', cpfMascarado: '***.***.***-25' }, { vinculado: 'sim', matricula: 'MAT-1' }]) {
      servidor(resposta(200, { ...ME, contexto: { ...ME.contexto, usuario: { ...ME.contexto.usuario, funcionario: f } } }));
      assert.deepEqual((await modulo().acoes.consultar()).conta.funcionario, SEM_VINCULO, JSON.stringify(f));
    }
    servidor(resposta(200, { ...ME, contexto: { ...ME.contexto, usuario: { ...ME.contexto.usuario, funcionario: { vinculado: true, matricula: '', cpfMascarado: 7 } } } }));
    assert.deepEqual((await modulo().acoes.consultar()).conta.funcionario, { vinculado: true, matricula: null, cpfMascarado: null });
    servidor(resposta(200, { status: 'ok', identidade: { id: 9, email: 'ana@example.invalid' }, empresas: [], contexto: null }));
    const semContexto = await modulo().acoes.consultar();
    assert.deepEqual([semContexto.ok, semContexto.conta.nome, semContexto.conta.perfil, semContexto.conta.tema, semContexto.conta.ultimoAcessoEm], [true, '', null, 'sistema', null]);
    assert.deepEqual(semContexto.conta.funcionario, SEM_VINCULO);
    servidor(resposta(500, { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' }));
    const falha = await modulo().acoes.consultar();
    assert.deepEqual([falha.ok, falha.status, falha.codigo], [false, 500, 'ERRO_INTERNO']);
    assert.match(falha.mensagem, /Não foi possível carregar/);
  });

  test('atualizarConta e trocarEmail: PATCH só com o que foi pedido, nunca identidade ou usuário; erros viram textos próprios, sem ecoar senha', async () => {
    servidor(resposta(200, { status: 'ok', conta: { telefone: '(47) 99999-0001', tema: 'claro', modoVisual: 'padrao' } }));
    const r = await modulo().acoes.atualizarConta({ telefone: '(47) 99999-0001' });
    assert.deepEqual(chamadas[0], { metodo: 'PATCH', caminho: '/api/auth/global/conta', corpo: { telefone: '(47) 99999-0001' } });
    assert.deepEqual(r, { ok: true, conta: { telefone: '(47) 99999-0001', tema: 'claro', modoVisual: 'padrao' } });
    await modulo().acoes.atualizarConta({ tema: 'escuro', modoVisual: 'baixa_visao' });
    assert.deepEqual(chamadas[1].corpo, { tema: 'escuro', modoVisual: 'baixa_visao' });
    await modulo().acoes.atualizarConta({ telefone: null, identidadeId: 1, usuarioId: 2 });
    assert.deepEqual(chamadas[2].corpo, { telefone: null }, 'campos de autoridade nunca saem do navegador');

    servidor(resposta(200, { status: 'EMAIL_ALTERADO', email: 'nova@example.invalid' }));
    const e = await modulo().acoes.trocarEmail({ senhaAtual: 'Senha Atual 123', novoEmail: 'nova@example.invalid' });
    assert.deepEqual(chamadas[0], { metodo: 'PATCH', caminho: '/api/auth/global/email', corpo: { senhaAtual: 'Senha Atual 123', novoEmail: 'nova@example.invalid' } });
    assert.deepEqual(e, { ok: true, email: 'nova@example.invalid' });

    const casos = [
      [409, 'EMAIL_INDISPONIVEL', /não pode ser usado/i],
      [401, 'SENHA_ATUAL_INVALIDA', /senha atual/i],
      [429, 'LOGIN_EM_COOLDOWN', /tente novamente mais tarde/i],
      [400, 'EMAIL_IGUAL_AO_ATUAL', /igual ao atual/i],
      [400, 'VALIDACAO', /inválido/i],
      [503, 'INDISPONIVEL', /Não foi possível/],
    ];
    for (const [status, codigo, texto] of casos) {
      servidor(resposta(status, { status: 'error', codigo, message: 'Senha Atual 123 vazou?' }));
      const f = await modulo().acoes.trocarEmail({ senhaAtual: 'Senha Atual 123', novoEmail: 'nova@example.invalid' });
      assert.deepEqual([f.ok, f.status, f.codigo], [false, status, codigo], codigo);
      assert.match(f.mensagem, texto, codigo);
      assert.doesNotMatch(f.mensagem, /Senha Atual 123/, 'a mensagem nunca ecoa o que foi digitado nem o texto do servidor');
    }
    servidor(new TypeError('Failed to fetch'));
    const rede = await modulo().acoes.atualizarConta({ tema: 'claro' });
    assert.deepEqual([rede.ok, rede.codigo], [false, 'FALHA_DE_REDE']);
  });
});

describe('módulo: validação local (mesmas regras do servidor)', () => {
  test('e-mail: aparado e em minúsculas, ASCII visível, formato; vazio, acento, espaço interno e acima de 150 são recusados', () => {
    const v = modulo().validar.email;
    assert.deepEqual(v('  Nova.Pessoa@Example.INVALID '), { ok: true, valor: 'nova.pessoa@example.invalid' });
    for (const ruim of ['', '   ', 'sem-arroba', 'acento@exémplo.com', 'a b@c.co', 'a@b', `${'x'.repeat(146)}@a.co`]) {
      assert.equal(v(ruim).ok, false, JSON.stringify(ruim));
      assert.match(v(ruim).mensagem, /e-mail/i);
    }
  });

  test('telefone: opcional (vazio vira null), aparado, até 20 caracteres, sem caractere de controle', () => {
    const v = modulo().validar.telefone;
    assert.deepEqual(v(''), { ok: true, valor: null });
    assert.deepEqual(v('   '), { ok: true, valor: null });
    assert.deepEqual(v(' (47) 99999-0001 '), { ok: true, valor: '(47) 99999-0001' });
    assert.equal(v('1'.repeat(21)).ok, false);
    assert.equal(v('abc\u0007').ok, false);
  });
});

describe('módulo: apresentação', () => {
  test('escape, iniciais, último acesso em horário de Brasília ou travessão, perfil por extenso, contato e situação pelo dado real', () => {
    const R = modulo().render;
    assert.equal(R.escaparHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
    assert.equal(R.contato({ email: 'ana@example.invalid', telefone: null }), 'ana@example.invalid');
    assert.equal(R.contato({ email: 'ana@example.invalid', telefone: '(47) 9' }), 'ana@example.invalid · (47) 9');
    assert.deepEqual(R.situacao(true), { texto: 'Ativo', classe: 'status-active' });
    assert.deepEqual(R.situacao(false), { texto: 'Inativo', classe: 'status-inactive' });
    assert.deepEqual(R.situacao(null), { texto: '—', classe: '' });
    assert.equal(R.iniciais('Ana <b>Souza</b>'), 'AS');
    assert.equal(R.iniciais(''), '?');
    assert.equal(R.ultimoAcesso(null), '—');
    assert.match(R.ultimoAcesso('2026-10-04T11:41:00.000Z'), /04\/10\/2026 às 08:41/);
    assert.equal(R.ultimoAcesso('lixo'), '—');
    assert.deepEqual(R.rotuloPerfil('ADMINISTRADOR'), 'Administrador');
    assert.deepEqual(R.rotuloPerfil('X'), 'X');
    assert.deepEqual(R.vinculo(COM_VINCULO), { cpf: '***.***.***-25', matricula: 'MAT-0077' });
    assert.deepEqual(R.vinculo({ vinculado: true, matricula: '<b>M</b>', cpfMascarado: '***.***.***-25' }), { cpf: '***.***.***-25', matricula: '<b>M</b>' }, 'texto puro: a página usa textContent');
    for (const f of [SEM_VINCULO, null, undefined, { vinculado: true, matricula: null, cpfMascarado: null }]) {
      assert.deepEqual(R.vinculo(f), { cpf: 'Não vinculado', matricula: 'Não vinculado' }, JSON.stringify(f));
    }
  });

  test('controles da aparência ↔ tema persistido: seguir sistema / dark mode e chips mapeiam para os valores do servidor, sem valor de interface guardado', () => {
    const C = modulo().controles;
    assert.equal(C.temaDosControles({ seguirSistema: true, escuro: true }), 'sistema');
    assert.equal(C.temaDosControles({ seguirSistema: false, escuro: true }), 'escuro');
    assert.equal(C.temaDosControles({ seguirSistema: false, escuro: false }), 'claro');
    assert.deepEqual(C.estadoDoTema('sistema'), { seguirSistema: true, escuro: false });
    assert.deepEqual(C.estadoDoTema('escuro'), { seguirSistema: false, escuro: true });
    assert.deepEqual(C.estadoDoTema('claro'), { seguirSistema: false, escuro: false });
    assert.deepEqual(C.MODO_DO_CONTROLE, {
      chipDefault: 'padrao', chipContrast: 'alto_contraste', 'a11y-padrao': 'padrao', 'a11y-deuteranopia': 'deuteranopia', 'a11y-protanopia': 'protanopia',
      'a11y-tritanopia': 'tritanopia', 'a11y-baixa_visao': 'baixa_visao', 'a11y-monocromatico': 'monocromatico',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página: inspeção estática
// ═══════════════════════════════════════════════════════════════════
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('página Configurações (inspeção estática)', () => {
  const html = ler('pages/config.html');
  const codigo = semComentarios(html);

  test('é página integrada: tema no <head>, scripts reais, sem db-api, main.js legado, CDN, login simulado nem seed', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<script src="\.\.\/js\/tema\.js"><\/script>/);
    for (const script of ['../js/api-http.js', '../portal/config.js', '../js/sessao-empresarial.js', '../js/permissoes-efetivas.js', '../js/pagina-base.js', '../js/configuracoes.js']) {
      assert.match(html, new RegExp(`<script src="${script.replace(/[./]/g, '\\$&')}"></script>`), script);
    }
    assert.doesNotMatch(codigo, /db-api\.js|js\/main\.js|inspecao-visual\.js|https?:\/\/cdn|xlsx|loginScreen|loginPanel|recoverPanel|biometric/i);
    assert.doesNotMatch(codigo, /Fulano|example\.invalid|MAT-000128|\*\*\*\.\*\*\*|12345678945|Hoje às 08:41/);
    assert.doesNotMatch(codigo, /onclick=/, 'eventos só por addEventListener');
    assert.doesNotMatch(codigo, /localStorage|sessionStorage/, 'o cache de aparência mora em tema.js, nunca na página');
    assert.match(codigo, /EpiPermissoes\.prepararPagina\(\{\s*pagina: 'config'/);
    assert.match(codigo, /EpiSessaoEmpresarial\.montar\(/);
  });

  test('Minha Conta: nome, e-mail, telefone, perfil · situação, CPF e matrícula somente leitura, último acesso; e-mail e telefone editáveis; senha pelo fluxo real', () => {
    for (const id of ['contaIniciais', 'contaNome', 'contaContato', 'contaPerfil', 'contaSituacao', 'contaUltimoAcesso', 'contaEmailAtual', 'contaCpf', 'contaMatricula']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, /<span class="badge" id="contaPerfil"><\/span>\s*<span class="account-sep" aria-hidden="true">·<\/span>\s*<span class="badge" id="contaSituacao"><\/span>/, 'perfil · situação');
    assert.match(html, /<span>CPF<\/span>\s*<strong id="contaCpf">—<\/strong>/);
    assert.match(html, /<span>Matrícula<\/span>\s*<strong id="contaMatricula">—<\/strong>/);
    assert.match(html, /<input id="telefone" class="input" type="text"[^>]*maxlength="20"/);
    assert.match(html, /<input id="novoEmail" class="input" type="email"/);
    assert.match(html, /<input id="senhaAtualEmail" class="input" type="password"[^>]*autocomplete="current-password"/);
    for (const id of ['botaoSalvarContato', 'botaoSalvarEmail', 'statusContato', 'statusEmail']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(html, /<a [^>]*id="linkTrocarSenha"[^>]*href="\.\.\/portal\/trocar-senha\.html"/);
    assert.doesNotMatch(codigo, /<input[^>]*id="(cpf|matricula|contaCpf|contaMatricula|nome|perfil|situacao)"/i, 'nome, perfil, situação, CPF e matrícula não são campos editáveis');
    assert.doesNotMatch(codigo, /revelar|mostrarCpf|cpfCompleto/i, 'sem revelação do CPF: não existe regra de autorização para isso');
  });

  test('Aparência: seguir sistema, dark mode, Padrão, Alto contraste e painel de acessibilidade com as sete opções; sem botão "Salvar aparência"', () => {
    for (const id of ['followSystem', 'globalDark', 'chipDefault', 'chipContrast', 'chipA11y', 'a11yPanel', 'botaoFecharA11y', 'statusAparencia']) assert.match(html, new RegExp(`id="${id}"`), id);
    for (const modo of ['padrao', 'deuteranopia', 'protanopia', 'tritanopia', 'baixa_visao', 'monocromatico']) assert.match(html, new RegExp(`id="a11y-${modo}"`), modo);
    assert.doesNotMatch(codigo, /Salvar aparência/i);
    assert.doesNotMatch(codigo, /a11y-lowvision|a11y-monochrome|a11y-default|setDisplayMode|setA11y\(/);
  });

  test('sem Modo Quiosque e sem Resumo de Permissões (mock)', () => {
    assert.doesNotMatch(codigo, /quiosque|kiosk/i);
    assert.doesNotMatch(codigo, /Resumo de Permissões|Usuários ativos|Perfis Master|Desativados/);
  });

  test('menu: Configurações ativa aqui e link real por data-pagina nas demais páginas integradas e no Portal; saiu dos protótipos em inspeção; publicada', () => {
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="config" style="display:none"><div class="nav-icon gray">settings<\/div>Configurações<\/a>/);
    const integradas = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html') && /data-pagina="importEmployees"/.test(ler(`pages/${f}`)) && f !== 'config.html');
    assert.ok(integradas.length >= 12,`${integradas.length} páginas integradas com menu completo`);
    for (const arquivo of integradas) {
      const h = ler(`pages/${arquivo}`);
      assert.match(h, /<a href="config\.html" data-pagina="config" style="display:none"><div class="nav-icon gray">settings<\/div>Configurações<\/a>/, arquivo);
      assert.doesNotMatch(h, /settings<\/div>Configurações<span class="nav-etiqueta">/, arquivo);
    }
    assert.match(ler('portal/inicio.html'), /<a href="\.\.\/pages\/config\.html" data-pagina="config" style="display:none">Configurações<\/a>/);
    assert.equal('Configurações' in P.INSPECAO_PROTOTIPOS, false);
    const allowlist = lerAllowlist();
    for (const entrada of ['pages/config.html', 'js/configuracoes.js']) assert.ok(allowlist.includes(entrada), entrada);
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i, 'nenhum script externo (critério de publicação)');
  });

  test('segurança: innerHTML só com HTML escapado pelo módulo ou texto fixo', () => {
    const script = codigo.slice(codigo.lastIndexOf('<script>'));
    const escritas = [...script.matchAll(/\.innerHTML\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const e of escritas) {
      assert.ok(/^''$/.test(e) || /^C\.render\.[a-zA-Z]+\(/.test(e) || /escaparHtml\(/.test(e), e);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página: DOM simulado
// ═══════════════════════════════════════════════════════════════════
const CONTEXTO = { empresa: { id: 3, nome: 'Empresa Demonstração' }, usuario: { id: 7, nome: 'Ana Souza', email: null, perfil: 'SUPERVISOR' } };
const ACESSO = { permissoes: { perfil: 'SUPERVISOR', recursos: {}, acoes: {}, administracao: {} }, podeAlterar: false };

function elemento(id) {
  return {
    id, value: '', checked: false, innerHTML: '', textContent: '', disabled: false, style: {}, listeners: {}, atributos: {}, classes: new Set(),
    classList: { add(c) { this.owner.classes.add(c); }, remove(c) { this.owner.classes.delete(c); }, toggle(c, on) { if (on) this.owner.classes.add(c); else this.owner.classes.delete(c); }, contains(c) { return this.owner.classes.has(c); } },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    setAttribute(k, v) { this.atributos[k] = String(v); }, removeAttribute(k) { delete this.atributos[k]; }, focus() { this.focado = true; },
    scrollIntoView() {},
  };
}

function montarPagina({ acesso = ACESSO, me = ME } = {}) {
  const html = ler('pages/config.html');
  const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  const mapa = {};
  const el = (id) => { if (!mapa[id]) { mapa[id] = elemento(id); mapa[id].classList.owner = mapa[id]; } return mapa[id]; };
  const aplicadas = [];
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [] },
    window: { SAFEWORK_PORTAL_API_BASE_URL: BASE },
    EpiHttp, EpiConfiguracoes: modulo(),
    EpiTema: { aplicarPreferencias: (p) => aplicadas.push({ ...p }), normalizar: T.normalizar, preferenciasAtuais: () => (aplicadas.length ? aplicadas[aplicadas.length - 1] : { tema: 'sistema', modoVisual: 'padrao' }) },
    EpiPermissoes: { prepararPagina: async () => acesso },
    EpiSessaoEmpresarial: { montar: async (o) => { sandbox.opcoesMontar = o; return CONTEXTO; }, sessaoEncerrada() { sandbox.encerrada = true; } },
    console, setTimeout, Promise, String, Number, Array, Object, JSON,
  };
  sandbox.window.EpiTema = sandbox.EpiTema;
  vm.runInNewContext(script, sandbox);
  const esperar = async () => { for (let i = 0; i < 60; i += 1) await new Promise((r) => setImmediate(r)); };
  const disparar = async (id, ev = 'click', evento = { preventDefault() {} }) => { for (const fn of (el(id).listeners[ev] || [])) await fn(evento); await esperar(); };
  return { el, sandbox, esperar, disparar, aplicadas, me };
}

describe('página Configurações (DOM simulado)', () => {
  test('carrega a conta real da sessão: resumo, campos editáveis preenchidos, controles da aparência no estado persistido; nada de seed', async () => {
    servidor((c) => (c.caminho === '/api/auth/global/me' ? resposta(200, { ...ME, identidade: { ...ME.identidade, telefone: '(47) 99999-0001', tema: 'escuro', modoVisual: 'tritanopia' } }) : resposta(200, { status: 'ok' })));
    const pg = montarPagina();
    await pg.esperar();
    assert.deepEqual(chamadas.map((c) => [c.metodo, c.caminho]), [['GET', '/api/auth/global/me']]);
    assert.equal(pg.el('contaNome').textContent, 'Ana <b>Souza</b>');
    assert.equal(pg.el('contaIniciais').textContent, 'AS');
    assert.match(pg.el('contaContato').textContent, /ana@example\.invalid · \(47\) 99999-0001/);
    assert.equal(pg.el('contaPerfil').textContent, 'Supervisor');
    assert.equal(pg.el('contaSituacao').textContent, 'Ativo');
    assert.equal(pg.el('contaSituacao').classes.has('status-active'), true);
    assert.equal(pg.el('contaCpf').textContent, 'Não vinculado');
    assert.equal(pg.el('contaMatricula').textContent, 'Não vinculado');
    assert.match(pg.el('contaUltimoAcesso').textContent, /04\/10\/2026 às 08:41/);
    assert.equal(pg.el('contaEmailAtual').textContent, 'ana@example.invalid');
    assert.equal(pg.el('telefone').value, '(47) 99999-0001');
    assert.equal(pg.el('novoEmail').value, 'ana@example.invalid');
    assert.equal(pg.el('senhaAtualEmail').value, '');
    assert.equal(pg.el('followSystem').classes.has('active'), false);
    assert.equal(pg.el('globalDark').classes.has('active'), true);
    assert.equal(pg.el('a11y-tritanopia').classes.has('active'), true);
    assert.equal(pg.el('chipA11y').classes.has('active'), true);
    assert.equal(pg.el('chipDefault').classes.has('active'), false);
    assert.equal(pg.el('linkTrocarSenha').atributos.href, undefined, 'o link é estático no HTML');
    assert.equal(pg.el('conteudoProtegido').style.display, 'block');
  });

  test('vínculo explícito: CPF mascarado e matrícula do funcionário vinculado; MASTER · Ativo e Inativo pelo estado real; sem vínculo, "Não vinculado"', async () => {
    const master = { ...comVinculo(), contexto: { ...comVinculo().contexto, usuario: { ...comVinculo().contexto.usuario, perfil: 'MASTER' } } };
    servidor((c) => (c.caminho === '/api/auth/global/me' ? resposta(200, master) : resposta(200, { status: 'ok' })));
    const pg = montarPagina();
    await pg.esperar();
    assert.equal(pg.el('contaPerfil').textContent, 'Master');
    assert.equal(pg.el('contaSituacao').textContent, 'Ativo');
    assert.equal(pg.el('contaCpf').textContent, '***.***.***-25');
    assert.equal(pg.el('contaMatricula').textContent, 'MAT-0077');
    assert.equal(pg.el('contaCpf').innerHTML, '', 'textContent, nunca innerHTML');

    const inativo = { ...ME, contexto: { ...ME.contexto, usuario: { ...ME.contexto.usuario, ativo: false } } };
    servidor((c) => (c.caminho === '/api/auth/global/me' ? resposta(200, inativo) : resposta(200, { status: 'ok' })));
    const pg2 = montarPagina();
    await pg2.esperar();
    assert.equal(pg2.el('contaSituacao').textContent, 'Inativo');
    assert.equal(pg2.el('contaSituacao').classes.has('status-inactive'), true);
    assert.equal(pg2.el('contaCpf').textContent, 'Não vinculado');
    assert.equal(pg2.el('contaMatricula').textContent, 'Não vinculado');
  });

  test('telefone: validação local, PATCH só do telefone, estado preservado no erro; vazio limpa', async () => {
    servidor((c) => {
      if (c.caminho === '/api/auth/global/me') return resposta(200, ME);
      if (c.corpo && c.corpo.telefone === '(11) 90000-0000') return resposta(503, { status: 'error', codigo: 'INDISPONIVEL' });
      return resposta(200, { status: 'ok', conta: { telefone: c.corpo.telefone, tema: 'sistema', modoVisual: 'padrao' } });
    });
    const pg = montarPagina();
    await pg.esperar();
    pg.el('telefone').value = '1'.repeat(21);
    await pg.disparar('botaoSalvarContato');
    assert.equal(chamadas.length, 1, 'inválido não é enviado');
    assert.match(pg.el('statusContato').textContent, /20 caracteres/);
    pg.el('telefone').value = ' (47) 98888-0002 ';
    await pg.disparar('botaoSalvarContato');
    assert.deepEqual(chamadas[1], { metodo: 'PATCH', caminho: '/api/auth/global/conta', corpo: { telefone: '(47) 98888-0002' } });
    assert.match(pg.el('statusContato').textContent, /salv/i);
    assert.match(pg.el('contaContato').textContent, /\(47\) 98888-0002/);
    pg.el('telefone').value = '(11) 90000-0000';
    await pg.disparar('botaoSalvarContato');
    assert.match(pg.el('statusContato').textContent, /Não foi possível/);
    assert.equal(pg.el('telefone').value, '(11) 90000-0000', 'o que foi digitado fica para corrigir');
    assert.match(pg.el('contaContato').textContent, /\(47\) 98888-0002/, 'o resumo continua com o valor confirmado');
    pg.el('telefone').value = '';
    await pg.disparar('botaoSalvarContato');
    assert.deepEqual(chamadas[chamadas.length - 1].corpo, { telefone: null });
  });

  test('e-mail: exige a senha atual e e-mail válido antes de enviar; sucesso atualiza o resumo e limpa a senha; conflito e senha errada mostram texto próprio sem perder o digitado; 401 encerra a sessão', async () => {
    servidor((c) => {
      if (c.caminho === '/api/auth/global/me') return resposta(200, ME);
      if (c.corpo.novoEmail === 'ocupado@example.invalid') return resposta(409, { status: 'error', codigo: 'EMAIL_INDISPONIVEL', message: 'x' });
      if (c.corpo.senhaAtual === 'errada-errada') return resposta(401, { status: 'error', codigo: 'SENHA_ATUAL_INVALIDA', message: 'x' });
      if (c.corpo.senhaAtual === 'sessao-caiu') return resposta(401, { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' });
      return resposta(200, { status: 'EMAIL_ALTERADO', email: c.corpo.novoEmail });
    });
    const pg = montarPagina();
    await pg.esperar();
    pg.el('novoEmail').value = 'Nova@Example.INVALID';
    await pg.disparar('botaoSalvarEmail');
    assert.equal(chamadas.length, 1, 'sem a senha atual nada é enviado');
    assert.match(pg.el('statusEmail').textContent, /senha atual/i);
    pg.el('senhaAtualEmail').value = 'Senha Atual 123';
    pg.el('novoEmail').value = 'invalido';
    await pg.disparar('botaoSalvarEmail');
    assert.equal(chamadas.length, 1);
    assert.match(pg.el('statusEmail').textContent, /e-mail/i);

    pg.el('novoEmail').value = 'Nova@Example.INVALID';
    await pg.disparar('botaoSalvarEmail');
    assert.deepEqual(chamadas[1], { metodo: 'PATCH', caminho: '/api/auth/global/email', corpo: { senhaAtual: 'Senha Atual 123', novoEmail: 'nova@example.invalid' } });
    assert.equal(pg.el('contaEmailAtual').textContent, 'nova@example.invalid');
    assert.match(pg.el('contaContato').textContent, /nova@example\.invalid/);
    assert.equal(pg.el('senhaAtualEmail').value, '', 'a senha nunca fica no campo depois do envio');
    assert.match(pg.el('statusEmail').textContent, /outros acessos foram encerrados/i);

    pg.el('senhaAtualEmail').value = 'Senha Atual 123';
    pg.el('novoEmail').value = 'ocupado@example.invalid';
    await pg.disparar('botaoSalvarEmail');
    assert.match(pg.el('statusEmail').textContent, /não pode ser usado/i);
    assert.equal(pg.el('novoEmail').value, 'ocupado@example.invalid');
    assert.equal(pg.el('contaEmailAtual').textContent, 'nova@example.invalid');

    pg.el('novoEmail').value = 'outra@example.invalid';
    pg.el('senhaAtualEmail').value = 'errada-errada';
    await pg.disparar('botaoSalvarEmail');
    assert.match(pg.el('statusEmail').textContent, /senha atual/i);
    assert.equal(pg.sandbox.encerrada, undefined, 'senha errada não encerra a sessão');

    pg.el('senhaAtualEmail').value = 'sessao-caiu';
    await pg.disparar('botaoSalvarEmail');
    assert.equal(pg.sandbox.encerrada, true);
  });

  test('aparência: selecionar aplica na hora, persiste no servidor e confirma; falha avisa e volta ao persistido; os controles refletem o estado', async () => {
    let falhar = false;
    servidor((c) => {
      if (c.caminho === '/api/auth/global/me') return resposta(200, ME);
      if (falhar) return resposta(503, { status: 'error', codigo: 'INDISPONIVEL' });
      return resposta(200, { status: 'ok', conta: { telefone: null, ...c.corpo } });
    });
    const pg = montarPagina();
    await pg.esperar();
    assert.deepEqual(pg.aplicadas, [{ tema: 'sistema', modoVisual: 'padrao' }], 'a preferência do servidor é aplicada ao carregar');

    await pg.disparar('globalDark');
    assert.deepEqual(chamadas[1], { metodo: 'PATCH', caminho: '/api/auth/global/conta', corpo: { tema: 'escuro', modoVisual: 'padrao' } });
    assert.deepEqual(pg.aplicadas[1], { tema: 'escuro', modoVisual: 'padrao' });
    assert.equal(pg.el('globalDark').classes.has('active'), true);
    assert.equal(pg.el('followSystem').classes.has('active'), false);
    assert.match(pg.el('statusAparencia').textContent, /salva/i);

    await pg.disparar('followSystem');
    assert.deepEqual(chamadas[2].corpo, { tema: 'sistema', modoVisual: 'padrao' });
    await pg.disparar('chipContrast');
    assert.deepEqual(chamadas[3].corpo, { tema: 'sistema', modoVisual: 'alto_contraste' });
    assert.equal(pg.el('chipContrast').classes.has('active'), true);
    await pg.disparar('chipA11y');
    assert.equal(pg.el('a11yPanel').style.display, 'block');
    await pg.disparar('a11y-baixa_visao');
    assert.deepEqual(chamadas[4].corpo, { tema: 'sistema', modoVisual: 'baixa_visao' });
    assert.equal(pg.el('a11y-baixa_visao').classes.has('active'), true);
    assert.equal(pg.el('chipContrast').classes.has('active'), false);
    await pg.disparar('a11y-padrao');
    assert.deepEqual(chamadas[5].corpo, { tema: 'sistema', modoVisual: 'padrao' });
    assert.equal(pg.el('chipDefault').classes.has('active'), true);

    falhar = true;
    await pg.disparar('globalDark');
    assert.match(pg.el('statusAparencia').textContent, /Não foi possível/);
    assert.deepEqual(pg.aplicadas[pg.aplicadas.length - 1], { tema: 'sistema', modoVisual: 'padrao' }, 'volta ao persistido');
    assert.equal(pg.el('globalDark').classes.has('active'), false);
  });

  test('sem permissão de abrir ou sessão encerrada: nada é carregado nem enviado; o conteúdo fica oculto', async () => {
    servidor(resposta(200, ME));
    const pg = montarPagina({ acesso: null });
    await pg.esperar();
    assert.equal(chamadas.length, 0);
    assert.notEqual(pg.el('conteudoProtegido').style.display, 'block');
    const pg2 = montarPagina();
    await pg2.esperar();
    pg2.sandbox.opcoesMontar.aoEncerrar();
    assert.equal(pg2.el('conteudoProtegido').style.display, 'none');
    pg2.el('telefone').value = '(47) 1';
    await pg2.disparar('botaoSalvarContato');
    assert.equal(chamadas.length, 1, 'depois de encerrada, nada é enviado');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Página aberta como no navegador: menu de inspeção (liberação visual)
// ═══════════════════════════════════════════════════════════════════
describe('página Configurações como no navegador: itens "Em integração" e a liberação de inspeção do MASTER', () => {
  const { abrirPagina } = require('./helpers/dom-pagina'); // eslint-disable-line global-require
  const area = (v) => ({ consultar: v, alterar: v });
  const permissoes = (perfil) => ({
    status: 'ok', empresaId: 3, usuarioId: 7, perfil, recursos: {}, acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false }, vinculosSst: area(perfil === 'MASTER'),
    },
  });
  const rotas = (perfil) => ({
    'GET /auth/me': { status: 200, corpo: { status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: null, perfil, ativo: true }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' }, preferencias: { tema: 'sistema', modoVisual: 'padrao' } } },
    'GET /auth/global/me': { status: 200, corpo: { ...ME, contexto: { ...ME.contexto, usuario: { ...ME.contexto.usuario, perfil } } } },
    'GET /auth/permissoes': { status: 200, corpo: permissoes(perfil) },
  });
  const etiqueta = (a) => a.querySelectorAll('.nav-etiqueta').map((e) => e.textContent.trim());

  test('MASTER em Configurações: os quatro itens "Em integração" abrem o protótipo com ?inspecao=1, sem aria-disabled e com a etiqueta; os dois adiados ficam sem link; Configurações segue integrada, sem marcador', async () => {
    const pg = abrirPagina('pages/config.html', { rotas: rotas('MASTER') });
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), true);
    const todosPendentes = pg.consulta('.nav a.nav-pendente');
    assert.equal(todosPendentes.length, 6);
    // 05/10/2026: Compras / Entradas e Regras Função / Setor são módulos adiados — seguem sem link, mesmo para o MASTER.
    const adiados = todosPendentes.filter((a) => /Compras \/ Entradas|Regras Função \/ Setor/.test(a.textContent));
    assert.equal(adiados.length, 2);
    for (const a of adiados) {
      assert.equal(a.getAttribute('href'), null, a.textContent.trim());
      assert.equal(a.getAttribute('aria-disabled'), 'true', a.textContent.trim());
    }
    const pendentes = todosPendentes.filter((a) => !adiados.includes(a));
    assert.equal(pendentes.length, 4);
    assert.deepEqual(pendentes.map((a) => a.getAttribute('href')).sort(), Object.values(P.INSPECAO_PROTOTIPOS).map((f) => `${f}?inspecao=1`).sort());
    for (const a of pendentes) {
      assert.equal(a.getAttribute('aria-disabled'), null, a.textContent.trim());
      assert.equal((a.getAttribute('href').match(/inspecao=1/g) || []).length, 1, 'marcador uma vez só');
      assert.deepEqual(etiqueta(a), ['Em integração'], a.textContent.trim());
      assert.match(a.getAttribute('class'), /nav-pendente/);
    }
    const config = pg.consulta('.nav a[data-pagina="config"]')[0];
    assert.equal(pg.visivelNo(config), true, 'o próprio item aparece no menu');
    assert.doesNotMatch(String(config.getAttribute('href')), /inspecao/, 'Configurações é página integrada: nunca abre em inspeção');
    assert.doesNotMatch(ler('pages/config.html').replace(/<!--[\s\S]*?-->/g, ''), /inspecao-visual|db-api\.js|\.\.\/js\/main\.js|loginScreen|Cobresul/);
    assert.equal(pg.chamadas.map((c) => c.chave).includes('GET /auth/permissoes'), true, 'a liberação vem do perfil confirmado pelo servidor');
  });

  test('ADMINISTRADOR, SUPERVISOR e USUARIO em Configurações: nenhum item "Em integração" ganha link (a liberação temporária é só do MASTER; a matriz é da 12J)', async () => {
    for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
      const pg = abrirPagina('pages/config.html', { rotas: rotas(perfil) });
      await pg.esperar();
      assert.equal(pg.visivel('conteudoProtegido'), true, perfil);
      const pendentes = pg.consulta('.nav a.nav-pendente');
      assert.equal(pendentes.length, 6, perfil);
      for (const a of pendentes) {
        assert.equal(a.getAttribute('href'), null, `${perfil}: ${a.textContent.trim()}`);
        assert.equal(a.getAttribute('aria-disabled'), 'true', perfil);
      }
    }
  });
});
