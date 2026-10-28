'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, semComentariosHtml, arquivosLocaisDe } = require('./helpers/dom-pagina');
const { lerAllowlist } = require('../publicacao/empacotar');

/**
 * Privacidade e LGPD — a página pages/lgpd.html no harness de DOM, com API simulada (Etapa LGPD de Consulta, Versão 2).
 *
 * (1) Condições para deixar de ser protótipo: sessão empresarial real, permissão lgpd.visualizar decidida pelo servidor, nada de
 * login simulado, quiosque, main.js/db-api.js/inspecao-visual.js, script externo ou manipulador inline; publicável pela allowlist.
 * (2) Comportamento real: só GET /lgpd/resumo, depois das permissões; estados de acesso negado, sessão encerrada, falha; nenhuma
 * resposta antiga reaparece depois de a página ser encerrada; ?inspecao=1 não muda nada. (3) O visual aprovado (css/lgpd.css e a
 * estrutura dos cards) é preservado; os textos demonstrativos (15 dias, zero fictício, DPO inventado) saem.
 */

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = 'pages/lgpd.html';
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ lgpd = true, perfil = 'ADMINISTRADOR', empresaId = 3, usuarioId = 7 } = {}) => ({
  status: 'ok', empresaId, usuarioId, perfil,
  recursos: { lgpd: { ...NENHUMA, visualizar: lgpd }, emailsGestao: { ...NENHUMA }, companyData: { ...NENHUMA } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false },
  },
});
const contexto = ({ perfil = 'ADMINISTRADOR', empresaId = 3, usuarioId = 7, nomeEmpresa = 'Empresa Alfa Ltda' } = {}) => ({
  status: 'ok',
  usuario: { id: usuarioId, nome: 'Eva Teste', email: 'eva@example.invalid', perfil },
  empresa: { id: empresaId, nome: nomeEmpresa, cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const resumo = (extra = {}) => ({
  status: 'ok',
  resumo: {
    controladora: { razaoSocial: 'Empresa Alfa Ltda', cnpj: '11222333000181' },
    titulares: { funcionarios: { total: 12, ativos: 9, afastados: 1, inativos: 2 }, usuarios: { total: 4, ativos: 3 } },
    ...extra,
  },
});

function mundo({ lgpd = true, perfil = 'ADMINISTRADOR', rotas = {} } = {}) {
  return {
    'GET /auth/me': { status: 200, corpo: contexto({ perfil }) },
    'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
    'GET /auth/permissoes': { status: 200, corpo: permissoes({ lgpd, perfil }) },
    'GET /lgpd/resumo': { status: 200, corpo: resumo() },
    ...rotas,
  };
}
async function pronta(opcoes = {}, abertura = {}) {
  const pg = abrirPagina(ARQUIVO, { rotas: mundo(opcoes), ...abertura });
  await pg.esperar();
  await pg.esperar();
  await pg.esperar();
  return pg;
}
const resumos = (pg) => pg.chamadas.filter((c) => c.chave === 'GET /lgpd/resumo');
const itemLgpd = (pg) => pg.consulta('.nav a').find((a) => a.getAttribute('data-pagina') === 'lgpd');

describe('condições para deixar de ser protótipo', () => {
  const codigo = () => semComentariosHtml(ler(ARQUIVO));

  test('não carrega main.js, db-api.js nem inspecao-visual.js, não tem script externo além das fontes e não tem manipulador inline', () => {
    const html = codigo();
    assert.doesNotMatch(html, /js\/main\.js|js\/db-api\.js|js\/inspecao-visual\.js/);
    assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i, 'nenhum script externo (critério de publicação)');
    assert.doesNotMatch(html, /\son(click|keydown|change|submit|load|input)\s*=/i, 'sem manipuladores inline');
    assert.doesNotMatch(html, /javascript:void\(0\)[^"]*"[^>]*onclick/);
  });

  test('sem login demonstrativo, recuperação, biometria, quiosque, empresa fixa ou modal de solicitação simulada', () => {
    const html = codigo().toLowerCase();
    for (const proibido of ['loginScreen', 'loginEmail', 'doLogin', 'Esqueci minha senha', 'biometri', 'Quiosque', 'kioskPassword', 'kioskLockOverlay', 'Cobresul', 'Simulação:',
      'titularModal', 'saveTitularRequest', 'saveDpo', 'toggleDpoEdit', 'dpoEditForm', 'example.invalid', 'xlsx']) {
      assert.equal(html.includes(proibido.toLowerCase()), false, `"${proibido}" não pode estar na página`);
    }
    assert.match(html, /id="telasessao"/);
    assert.match(html, /id="conteudoprotegido"/);
    assert.match(html, /id="estadopagina"/);
  });

  test('carrega a infraestrutura das páginas integradas (tema no head, sessão, permissões, estado, módulo próprio) e preserva o CSS aprovado', () => {
    const html = ler(ARQUIVO);
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<script src="\.\.\/js\/tema\.js"><\/script>/);
    assert.match(head, /<link rel="stylesheet" href="\.\.\/css\/lgpd\.css">/, 'o CSS aprovado continua sendo o da página');
    for (const s of ['js/api-http.js', 'portal/config.js', 'js/sessao-empresarial.js', 'js/permissoes-efetivas.js', 'js/pagina-base.js', 'js/estado-pagina.js', 'js/lgpd.js']) {
      assert.ok(html.includes(`<script src="../${s}"></script>`), `faltou ${s}`);
    }
    assert.match(html, /<body class="[^"]*lgpd-visual[^"]*"/, 'a classe que ancora o CSS aprovado fica');
    assert.match(html, /<section id="lgpdView" class="view active">/, 'o contêiner que o CSS aprovado seleciona fica');
    for (const classe of ['lgpd-kpis', 'lgpd-layout', 'lgpd-policy', 'lgpd-retention', 'lgpd-dpo', 'lgpd-rights', 'lgpd-rights-grid', 'lgpd-requests', 'lgpd-empty']) {
      assert.ok(html.includes(classe), `a estrutura aprovada perdeu "${classe}"`);
    }
    assert.equal((html.match(/<div class="stat">/g) || []).length, 4, 'quatro indicadores, como na referência');
    assert.equal((html.match(/<details class="lgpd-right">/g) || []).length, 5, 'cinco direitos do titular, como na referência');
  });

  test('publicável: página, módulo e folhas que carrega estão na allowlist', () => {
    const allowlist = lerAllowlist();
    for (const arquivo of ['pages/lgpd.html', 'js/lgpd.js', 'css/lgpd.css']) assert.ok(allowlist.includes(arquivo), `${arquivo} precisa estar na allowlist`);
    for (const recurso of arquivosLocaisDe(ARQUIVO)) assert.ok(allowlist.includes(recurso), `lgpd.html carrega ${recurso}, que não está na allowlist`);
  });

  test('o módulo e a página não usam innerHTML, armazenamento do navegador nem cookie legível', () => {
    const js = ler('js/lgpd.js');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|document\.cookie|EpiAPI|db-api/.test(js), false);
    assert.equal(/localStorage|sessionStorage/.test(codigo()), false);
  });

  test('nenhum número, prazo ou registro demonstrativo fica como se fosse operacional', () => {
    const html = codigo();
    for (const proibido of ['15 dias', 'Nenhuma solicitação registrada', 'id="dpoNome">A definir', 'id="dpoEmail">A definir', '20 anos', '5 anos', '10 anos', 'Prazo informado na política atual', 'notificação automática']) {
      assert.equal(html.includes(proibido), false, `"${proibido}" apresenta simulação como operação`);
    }
  });
});

describe('sessão, permissão e dados reais', () => {
  test('com sessão e lgpd.visualizar: consulta GET /lgpd/resumo UMA vez, depois das permissões, e mostra os números reais com os rótulos certos', async () => {
    const pg = await pronta();
    assert.equal(resumos(pg).length, 1);
    const ordem = pg.chamadas.map((c) => c.chave);
    assert.ok(ordem.indexOf('GET /auth/permissoes') < ordem.indexOf('GET /lgpd/resumo'), 'permissões antes dos dados');
    assert.equal(resumos(pg)[0].temQuery, false, 'nenhum parâmetro de empresa vai na consulta');
    assert.equal(pg.visivel('conteudoProtegido'), true);
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '12');
    assert.match(pg.texto('lgpdKpiFuncionariosDetalhe'), /9 ativos.*1 afastado.*2 inativos/);
    assert.equal(pg.texto('lgpdKpiUsuarios'), '4');
    assert.match(pg.texto('lgpdKpiUsuariosDetalhe'), /3 ativos/);
    const dom = pg.textoDoDom();
    assert.match(dom, /Funcionários cadastrados/);
    assert.match(dom, /Usuários com conta/);
    assert.doesNotMatch(dom, /Titulares cadastrados/, 'funcionários não são apresentados como o total de titulares');
    assert.doesNotMatch(dom, /\b16\b/, 'funcionários e usuários nunca são somados');
  });

  test('a empresa exibida é a da sessão (razão social e CNPJ formatado), sem rotulá-la como controladora universal', async () => {
    const pg = await pronta();
    assert.match(pg.texto('lgpdEmpresa'), /Empresa Alfa Ltda/);
    assert.match(pg.texto('lgpdEmpresa'), /11\.222\.333\/0001-81/);
    assert.equal(pg.texto('dpoEmpresa'), 'Empresa Alfa Ltda');
    assert.doesNotMatch(pg.textoDoDom(), /Empresa controladora/);
  });

  test('zero real é mostrado como 0; fonte indisponível é "—" com explicação; solicitações e conformidade nunca mostram zero fictício', async () => {
    const pg = await pronta({ rotas: { 'GET /lgpd/resumo': { status: 200, corpo: resumo({ titulares: { funcionarios: { total: 0, ativos: 0, afastados: 0, inativos: 0 }, usuarios: { total: 1, ativos: 1 } } }) } } });
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '0');
    assert.equal(pg.texto('lgpdKpiSolicitacoes'), '—');
    assert.match(pg.texto('lgpdKpiSolicitacoesDetalhe'), /não disponível|ainda não/i);
    assert.equal(pg.texto('lgpdKpiConformidade'), '—');
    assert.match(pg.texto('titularRequestList'), /ainda não (está )?disponível/i);
    assert.doesNotMatch(pg.texto('titularRequestList'), /Nenhuma solicitação/i);
  });

  test('resposta fora do contrato (contagem negativa, campo ausente, corpo vazio): nada é exibido como real', async () => {
    for (const corpo of [{ status: 'ok', resumo: { controladora: { razaoSocial: 'X', cnpj: '1' } } }, { status: 'ok', resumo: resumo().resumo.titulares }, null,
      resumo({ titulares: { funcionarios: { total: -1, ativos: 0, afastados: 0, inativos: 0 }, usuarios: { total: 1, ativos: 1 } } })]) {
      const pg = await pronta({ rotas: { 'GET /lgpd/resumo': { status: 200, corpo } } });
      assert.equal(pg.texto('lgpdKpiFuncionarios'), '—', JSON.stringify(corpo));
      assert.match(pg.texto('lgpdAviso'), /Não foi possível carregar/);
    }
  });

  test('texto do servidor entra só como texto: marcação na razão social não vira elemento', async () => {
    const pg = await pronta({ rotas: { 'GET /lgpd/resumo': { status: 200, corpo: resumo({ controladora: { razaoSocial: '<b id="injetado">X</b>', cnpj: '11222333000181' } }) } } });
    assert.equal(pg.existe('injetado'), false);
    assert.match(pg.texto('lgpdEmpresa'), /<b id="injetado">X<\/b>/);
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
  });

  test('sem lgpd.visualizar: acesso negado, conteúdo protegido oculto, nenhum dado pedido, item LGPD do menu ausente', async () => {
    const pg = await pronta({ lgpd: false });
    assert.equal(resumos(pg).length, 0);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.match(pg.texto('estadoPagina'), /não tem permissão/i);
    assert.equal(pg.el('lgpdKpiFuncionarios').textContent, '—');
    const item = itemLgpd(pg);
    assert.ok(item);
    assert.equal(pg.visivelNo(item), false);
  });

  test('MASTER sem a permissão provisionada: a mesma recusa, sem exceção pelo nome do perfil', async () => {
    const pg = await pronta({ lgpd: false, perfil: 'MASTER' });
    assert.equal(resumos(pg).length, 0);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.match(pg.texto('estadoPagina'), /não tem permissão/i);
  });

  test('sem sessão (401 em /auth/me): vai ao Portal sem pedir nada e sem mostrar nada', async () => {
    const pg = await pronta({ rotas: { 'GET /auth/me': { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } } } });
    assert.equal(resumos(pg).length, 0);
    assert.equal(pg.chamadas.some((c) => c.chave === 'GET /auth/permissoes'), false);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.ok(pg.navegacoes.some((n) => /portal\/index\.html/.test(n)), 'Portal do Cliente');
  });

  test('403 em /lgpd/resumo (permissão retirada depois do menu): acesso negado, conteúdo oculto, nada do resumo na tela', async () => {
    const pg = await pronta({ rotas: { 'GET /lgpd/resumo': { status: 403, corpo: { status: 'error', codigo: 'PERMISSAO_NEGADA', message: 'x' } } } });
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.match(pg.texto('estadoPagina'), /não tem permissão/i);
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '—');
  });

  test('401 em /lgpd/resumo (sessão encerrada durante o uso): conteúdo some e a pessoa vai ao Portal', async () => {
    const pg = await pronta({ rotas: { 'GET /lgpd/resumo': { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } } } });
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.ok(pg.navegacoes.some((n) => /portal\/index\.html/.test(n)));
  });

  test('falha temporária (500 ou rede): aviso, indicadores em "—" e o restante da página continua acessível', async () => {
    for (const rota of [{ status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } }, new Error('rede')]) {
      const pg = await pronta({ rotas: { 'GET /lgpd/resumo': rota } });
      assert.equal(pg.visivel('conteudoProtegido'), true);
      assert.match(pg.texto('lgpdAviso'), /Não foi possível carregar/);
      assert.equal(pg.texto('lgpdKpiFuncionarios'), '—');
      assert.match(pg.texto('lgpdKpiFuncionariosDetalhe'), /indisponível/i);
      assert.equal(pg.texto('lgpdEmpresa').trim(), '');
    }
  });

  test('enquanto carrega: indicadores em "—" com "Carregando…", nunca um número provisório', async () => {
    let liberar;
    const espera = new Promise((r) => { liberar = r; });
    const pg = abrirPagina(ARQUIVO, { rotas: mundo({ rotas: { 'GET /lgpd/resumo': async () => { await espera; return { status: 200, corpo: resumo() }; } } }) });
    await pg.esperar(); await pg.esperar(); await pg.esperar();
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '—');
    assert.match(pg.texto('lgpdKpiFuncionariosDetalhe'), /Carregando/);
    liberar();
    await pg.esperar(); await pg.esperar();
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '12');
  });
});

describe('?inspecao=1 não é caminho alternativo', () => {
  test('com sessão e permissão: exatamente o mesmo comportamento da URL normal, sem faixa de inspeção e sem privilégio extra', async () => {
    const pg = await pronta({}, { search: '?inspecao=1' });
    assert.equal(resumos(pg).length, 1);
    assert.equal(pg.visivel('conteudoProtegido'), true);
    assert.equal(pg.consulta('[data-inspecao-visual]').length, 0);
    assert.equal(pg.existe('loginScreen'), false);
    assert.doesNotMatch(pg.textoDoDom(), /inspeção visual/i);
  });

  test('sem permissão: acesso negado, nada pedido (inclusive para o MASTER)', async () => {
    for (const perfil of ['ADMINISTRADOR', 'MASTER']) {
      const pg = await pronta({ lgpd: false, perfil }, { search: '?inspecao=1' });
      assert.equal(resumos(pg).length, 0, perfil);
      assert.equal(pg.visivel('conteudoProtegido'), false, perfil);
      assert.match(pg.texto('estadoPagina'), /não tem permissão/i);
    }
  });

  test('sem sessão: bloqueado e levado ao Portal', async () => {
    const pg = await pronta({ rotas: { 'GET /auth/me': { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } } } }, { search: '?inspecao=1' });
    assert.equal(resumos(pg).length, 0);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.ok(pg.navegacoes.some((n) => /portal\/index\.html/.test(n)));
  });

  test('a lista de protótipos em inspeção não contém mais a LGPD, e o marcador nunca é acrescentado a lgpd.html', () => {
    const I = require('../js/inspecao-visual'); // eslint-disable-line global-require
    assert.equal(I.PROTOTIPOS.includes('lgpd.html'), false);
    assert.equal(I.comMarcador('lgpd.html'), 'lgpd.html');
    assert.equal(I.comMarcador('lgpd.html?_s=abc'), 'lgpd.html?_s=abc');
    assert.ok(I.PROTOTIPOS.includes('emails-gestao.html') && I.PROTOTIPOS.includes('self-service.html'), 'os demais protótipos continuam');
  });
});

describe('mudança de contexto e respostas antigas', () => {
  const persistida = (pg) => pg.eventoDaJanela('pageshow', { persisted: true });

  test('revogação com a sessão aberta: na volta pelo histórico as permissões são relidas, o conteúdo some e a página recarrega', async () => {
    const rotas = mundo();
    const pg = abrirPagina(ARQUIVO, { rotas });
    await pg.esperar(); await pg.esperar(); await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), true);
    rotas['GET /auth/permissoes'] = { status: 200, corpo: permissoes({ lgpd: false }) };
    await persistida(pg);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.ok(pg.navegacoes.some((n) => /lgpd\.html/.test(n)), 'recarrega para refazer o fluxo com as permissões atuais');
    assert.equal(resumos(pg).length, 1, 'nenhuma nova consulta de dados com a permissão retirada');
  });

  test('troca de empresa ou de pessoa em outra aba: os dados exibidos são limpos e a página recarrega', async () => {
    for (const outro of [contexto({ empresaId: 9, nomeEmpresa: 'Empresa Beta' }), contexto({ usuarioId: 8 })]) {
      const rotas = mundo();
      const pg = abrirPagina(ARQUIVO, { rotas });
      await pg.esperar(); await pg.esperar(); await pg.esperar();
      assert.equal(pg.texto('lgpdKpiFuncionarios'), '12');
      rotas['GET /auth/me'] = { status: 200, corpo: outro };
      await persistida(pg);
      assert.equal(pg.visivel('conteudoProtegido'), false);
      assert.equal(pg.texto('lgpdKpiFuncionarios'), '—', 'nada da empresa anterior fica na tela');
      assert.equal(pg.texto('lgpdEmpresa').trim(), '');
      assert.ok(pg.navegacoes.some((n) => /lgpd\.html/.test(n)));
    }
  });

  test('sessão encerrada na volta pelo histórico: conteúdo limpo e Portal', async () => {
    const rotas = mundo();
    const pg = abrirPagina(ARQUIVO, { rotas });
    await pg.esperar(); await pg.esperar(); await pg.esperar();
    rotas['GET /auth/me'] = { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } };
    await persistida(pg);
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '—');
    assert.ok(pg.navegacoes.some((n) => /portal\/index\.html/.test(n)));
  });

  test('resposta antiga chegando depois da mudança de contexto é descartada: nunca pinta os dados', async () => {
    let liberar;
    const espera = new Promise((r) => { liberar = r; });
    const rotas = mundo({ rotas: { 'GET /lgpd/resumo': async () => { await espera; return { status: 200, corpo: resumo() }; } } });
    const pg = abrirPagina(ARQUIVO, { rotas });
    await pg.esperar(); await pg.esperar(); await pg.esperar();
    assert.equal(resumos(pg).length, 1, 'a consulta está em voo');
    rotas['GET /auth/me'] = { status: 200, corpo: contexto({ empresaId: 9, nomeEmpresa: 'Empresa Beta' }) };
    await persistida(pg);
    liberar();
    await pg.esperar(); await pg.esperar();
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '—');
    assert.equal(pg.texto('lgpdEmpresa').trim(), '');
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('mesma sessão e mesmas permissões: a página reaparece como estava, sem nova consulta', async () => {
    const pg = await pronta();
    await persistida(pg);
    assert.equal(pg.visivel('conteudoProtegido'), true);
    assert.equal(pg.texto('lgpdKpiFuncionarios'), '12');
    assert.equal(resumos(pg).length, 1);
  });

  test('nenhum dado empresarial vai para localStorage, sessionStorage ou cookie legível (só o cache de pintura do tema, por identidade, já decidido nas Configurações)', async () => {
    const pg = await pronta();
    const escritas = pg.storage.filter((s) => s.operacao === 'setItem');
    assert.deepEqual(escritas.map((s) => s.chave), ['safework-aparencia']);
    assert.doesNotMatch(escritas[0].valor, /Alfa|11222333|funcion|usuario/i);
    assert.deepEqual(pg.cookiesEscritos.filter((c) => !/^epi-session-user=;/.test(c)), [], 'o único cookie tocado é a limpeza do rastro do protótipo');
  });
});

describe('funções sem backend ficam explicitamente indisponíveis', () => {
  test('"Editar" o encarregado e "Nova solicitação" ficam desabilitados, com explicação acessível, e um clique não chama a API', async () => {
    const pg = await pronta();
    for (const id of ['dpoEditar', 'lgpdNovaSolicitacao']) {
      const b = pg.el(id);
      assert.equal(b.hasAttribute('disabled'), true, id);
      const descricao = b.getAttribute('aria-describedby');
      assert.ok(descricao && pg.existe(descricao), `${id} precisa apontar para a explicação`);
      assert.match(pg.texto(descricao), /ainda não (está )?disponível|não disponível/i);
    }
    const antes = pg.chamadas.length;
    await pg.el('dpoEditar').disparar('click');
    await pg.el('lgpdNovaSolicitacao').disparar('click');
    assert.equal(pg.chamadas.length, antes);
    assert.equal(pg.consulta('form').length, 0, 'nenhum formulário na página');
    // LGPD-1: os únicos campos são os do modal do encarregado, fechado e fora do conteúdo protegido; sem lgpdEncarregado.editar o botão fica desabilitado.
    assert.equal(pg.consulta('#conteudoProtegido input').length, 0, 'nenhum campo editável sem backend dentro do conteúdo');
    assert.equal(pg.el('dpoModal').classList.contains('open'), false);
  });

  test('encarregado: nenhum nome, e-mail ou telefone inventado; sem canal de SST, Almoxarifado ou Suporte como canal LGPD', async () => {
    const pg = await pronta();
    for (const id of ['dpoNome', 'dpoEmail', 'dpoTel']) assert.match(pg.texto(id), /Não cadastrado/);
    const card = pg.consulta('.lgpd-dpo')[0];
    assert.doesNotMatch(card.textContent, /sst@|almoxarifado@|suporte@|SST|Almoxarifado/i);
  });

  test('direitos do titular: explicativos, sem "Disponível" e com a distinção entre a permissão administrativa e o direito do titular', async () => {
    const pg = await pronta();
    const direitos = pg.consulta('.lgpd-right');
    assert.equal(direitos.length, 5);
    for (const d of direitos) assert.doesNotMatch(d.textContent, /\bDisponível\b/);
    assert.match(pg.consulta('.lgpd-rights')[0].textContent, /não é o exercício|não substitui|não depende/i);
  });

  test('política, retenção e bases legais ficam identificadas como pendentes de validação jurídica', async () => {
    const pg = await pronta();
    assert.match(pg.consulta('.lgpd-policy')[0].textContent, /validação jurídica/i);
    assert.match(pg.consulta('.lgpd-retention')[0].textContent, /validação jurídica|a definir/i);
    assert.doesNotMatch(pg.consulta('.lgpd-retention')[0].textContent, /\d+ anos/);
    assert.doesNotMatch(pg.textoDoDom(), /Art\. 7º, inciso II da LGPD — execução de contrato/);
  });
});

describe('menu da própria página', () => {
  test('o item LGPD é estático (data-pagina="lgpd", ativo) e aparece só com a permissão; o restante do menu é o das páginas integradas', async () => {
    const html = ler(ARQUIVO);
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="lgpd" style="display:none">/);
    assert.match(html, /<a href="\.\.\/portal\/inicio\.html"/);
    assert.match(html, /<a href="config\.html" data-pagina="config" style="display:none">/);
    assert.match(html, /<a href="company-data\.html" data-pagina="companyData" style="display:none">/);
    assert.match(html, /Gestão de E-mails<span class="nav-etiqueta">Em integração<\/span>/, 'Gestão de E-mails continua em integração');
    const pg = await pronta();
    assert.equal(pg.visivelNo(itemLgpd(pg)), true);
    const menuMobile = pg.el('menuCelular');
    await menuMobile.disparar('click');
    assert.equal(pg.documento.body.classList.contains('mobile-menu-open'), true, 'menu do celular abre');
    await pg.el('menuFundo').disparar('click');
    assert.equal(pg.documento.body.classList.contains('mobile-menu-open'), false);
  });
});
