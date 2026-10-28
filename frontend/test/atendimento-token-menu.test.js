'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');
const P = require('../js/permissoes-efetivas');

/**
 * Etapa H (frontend) — integração com o menu: "Solicitações → Atendimento Token". O item "Autoatendimento (Totem)" é um
 * texto repetido em 23 páginas homologadas; nenhuma delas foi editada. O ponto central é js/permissoes-efetivas.js: para
 * quem pode abrir a Central (permissões efetivas), o item das páginas integradas passa a se chamar "Atendimento Token" e a
 * apontar para atendimento-token.html; para os demais continua exatamente como estava ("Em integração").
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const PAGINAS = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html')).sort();
const CENTRAL = 'atendimento-token.html';
// As páginas integradas com o menu completo (as mesmas da Gestão de Usuários), sem a própria Central.
const INTEGRADAS = PAGINAS.filter((f) => f !== CENTRAL && /data-pagina="userAdmin"/.test(ler(`pages/${f}`)));

// A Ficha de EPI fica fora só da abertura por DOM: o harness não tem canvas (assinatura). O menu dela é o mesmo texto
// estático conferido acima, e o ajuste usa a mesma função das demais.
const ABRIVEIS = INTEGRADAS.filter((f) => f !== 'epi-ficha.html');

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ recurso = {}, acoes = {}, perfil = 'ADMINISTRADOR' } = {}) => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil,
  recursos: { atendimentoToken: { ...NENHUMA, ...recurso } },
  acoes,
  administracao: { gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false), autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false } },
});

async function abrir(arquivo, perm) {
  const corpo = (status, c) => ({ status, corpo: c });
  const rotas = {
    'GET /auth/me': () => corpo(200, { status: 'ok', usuario: { id: 7, nome: 'Eva', email: 'eva@example.invalid', perfil: perm.perfil }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } }),
    'GET /auth/global/me': () => corpo(200, { status: 'ok', empresas: [{ id: 3 }] }),
    'GET /auth/permissoes': () => corpo(200, perm),
  };
  const pg = abrirPagina(`pages/${arquivo}`, { rotas });
  await pg.esperar();
  return pg;
}
// O item do menu que, nas páginas integradas, é o do Totem (ou o que o substituiu).
const itemDoToken = (pg) => pg.consulta('.nav a').find((a) => /Autoatendimento \(Totem\)|Atendimento Token/.test(a.textContent));
const rotulo = (a) => a.childNodes.filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();

describe('o item "Solicitações → Atendimento Token" nas páginas integradas', () => {
  test('há 20 páginas integradas com o menu completo (a 18ª é company-data.html, F2; a 19ª, support.html, Suporte; a 20ª, lgpd.html, LGPD), e cada uma traz o item do Totem como "Em integração"', () => {
    assert.equal(INTEGRADAS.length, 20);
    assert.ok(INTEGRADAS.includes('support.html'));
    for (const f of INTEGRADAS) {
      const html = ler(`pages/${f}`);
      assert.match(html, /<a class="nav-pendente" aria-disabled="true" title="Em integração"><div class="nav-icon blue">badge<\/div>Autoatendimento \(Totem\)<span class="nav-etiqueta">Em integração<\/span><\/a>/, f);
    }
  });

  test('com permissão de abrir a Central: o item vira "Atendimento Token", aponta para atendimento-token.html e perde o "Em integração" (nas 19 páginas abertas por DOM)', async () => {
    assert.equal(ABRIVEIS.length, 19);
    for (const arquivo of ABRIVEIS) {
      const pg = await abrir(arquivo, permissoes({ recurso: { visualizar: true } }));
      const a = itemDoToken(pg);
      assert.ok(a, arquivo);
      assert.equal(rotulo(a), 'Atendimento Token', arquivo);
      assert.equal(a.getAttribute('href'), 'atendimento-token.html', arquivo);
      assert.equal(a.getAttribute('aria-disabled'), null, arquivo);
      assert.equal(a.classList.contains('nav-pendente'), false, arquivo);
      assert.equal(a.querySelectorAll('.nav-etiqueta').length, 0, arquivo);
      assert.equal(pg.visivelNo(a), true, arquivo);
      assert.equal(a.textContent.includes('Em integração'), false, arquivo);
    }
  });

  test('sem a permissão: o item continua exatamente como era (nome antigo, "Em integração", sem link) nas 16 páginas abertas por DOM', async () => {
    for (const arquivo of ABRIVEIS) {
      const pg = await abrir(arquivo, permissoes());
      const a = itemDoToken(pg);
      assert.equal(rotulo(a), 'Autoatendimento (Totem)', arquivo);
      assert.equal(a.getAttribute('href'), null, arquivo);
      assert.equal(a.getAttribute('aria-disabled'), 'true', arquivo);
      assert.equal(a.classList.contains('nav-pendente'), true, arquivo);
      assert.equal(a.querySelectorAll('.nav-etiqueta').length, 1, arquivo);
    }
  });

  test('qualquer uma das três ações da Central abre o item (ativação, redes ou prévia); revogar sozinha não', async () => {
    for (const [acao, abre] of [['TOKEN_GERAR_ATIVACAO', true], ['TOKEN_GERENCIAR_REDES', true], ['TOKEN_PREVIA_CATALOGO_REAL', true], ['TOKEN_REVOGAR_DISPOSITIVO', false]]) {
      const pg = await abrir('dashboard.html', permissoes({ acoes: { [acao]: true } }));
      assert.equal(rotulo(itemDoToken(pg)), abre ? 'Atendimento Token' : 'Autoatendimento (Totem)', acao);
    }
  });

  test('o perfil MASTER não decide nada por si: sem as linhas de permissão mantém a liberação visual antiga; com elas, abre a Central', async () => {
    const semLinhas = await abrir('dashboard.html', permissoes({ perfil: 'MASTER' }));
    const antigo = itemDoToken(semLinhas);
    assert.equal(rotulo(antigo), 'Autoatendimento (Totem)');
    assert.equal(antigo.getAttribute('href'), 'self-service.html?inspecao=1', 'a liberação visual provisória do MASTER não mudou');
    const comLinhas = await abrir('dashboard.html', permissoes({ perfil: 'MASTER', recurso: { visualizar: true } }));
    const novo = itemDoToken(comLinhas);
    assert.equal(rotulo(novo), 'Atendimento Token');
    assert.equal(novo.getAttribute('href'), 'atendimento-token.html');
    assert.equal(novo.getAttribute('title'), null);
  });

  test('permissão que some depois (revalidação): o item já ajustado é escondido e perde o link; nunca fica um atalho antigo', async () => {
    const pg = await abrir('stock-requests.html', permissoes({ recurso: { visualizar: true } }));
    const a = itemDoToken(pg);
    assert.equal(pg.visivelNo(a), true);
    pg.janela.EpiPermissoes.ajustarMenuAtendimentoToken(null, pg.documento);
    assert.equal(pg.visivelNo(a), false);
    assert.equal(a.getAttribute('href'), null);
    pg.janela.EpiPermissoes.ajustarMenuAtendimentoToken(permissoes({ recurso: { visualizar: true } }), pg.documento);
    assert.equal(pg.visivelNo(a), true);
    assert.equal(a.getAttribute('href'), 'atendimento-token.html');
  });

  test('o ajuste acompanha TODOS os pontos em que o menu é calculado (carga, falha, revalidação)', () => {
    const codigo = ler('js/permissoes-efetivas.js');
    assert.equal((codigo.match(/ajustarMenuAtendimentoToken\(/g) || []).length, 1 + 4, 'a definição e os quatro pontos de uso');
    assert.equal((codigo.match(/liberarInspecao\(/g) || []).length, 1 + 4);
    assert.equal(typeof P.ajustarMenuAtendimentoToken, 'function');
  });
});

describe('páginas homologadas e protótipos: nenhuma alteração em massa', () => {
  test('nenhuma das páginas existentes cita a Central; só a própria página cita', () => {
    for (const f of PAGINAS.filter((p) => p !== CENTRAL)) {
      assert.equal(/atendimento-token/.test(ler(`pages/${f}`)), false, f);
    }
    assert.equal(/atendimento-token/.test(ler('portal/inicio.html')), false);
    assert.equal(/atendimento-token/.test(ler('pages/self-service.html')), false);
  });

  test('os protótipos mantêm o item "Autoatendimento (Totem)" e o self-service.html segue intacto e sem link novo', () => {
    const prototipos = PAGINAS.filter((f) => f !== CENTRAL && !INTEGRADAS.includes(f) && /Autoatendimento \(Totem\)/.test(ler(`pages/${f}`)));
    // Suporte e, depois, Privacidade e LGPD deixaram de ser protótipos (páginas integradas): restam exatamente estes.
    assert.deepEqual(prototipos, ['eligibility-rules.html', 'emails-gestao.html', 'purchases.html', 'self-service.html']);
    for (const f of prototipos) assert.equal(/Atendimento Token/.test(ler(`pages/${f}`)), false, f);
    assert.match(ler('pages/self-service.html'), /<title>Gestão de EPI<\/title>/);
  });

  test('o menu da Central é igual ao das páginas integradas, exceto o item de Solicitações que é a própria Central', () => {
    const menu = (f) => ler(`pages/${f}`).match(/<nav class="nav">([\s\S]*?)<\/nav>/)[1];
    const normalizar = (html) => html
      .replace(/<a class="nav-pendente" aria-disabled="true" title="Em integração"><div class="nav-icon blue">badge<\/div>Autoatendimento \(Totem\)<span class="nav-etiqueta">Em integração<\/span><\/a>/, '[TOKEN]')
      .replace(/<a class="active" href="javascript:void\(0\)" data-pagina="atendimentoToken" style="display:none"><div class="nav-icon blue">badge<\/div>Atendimento Token<\/a>/, '[TOKEN]')
      .replace(/<a class="active" href="javascript:void\(0\)" data-pagina="(\w+)"/, '<a href="[PAGINA]" data-pagina="$1"')
      .replace(/<a href="[^"]+" data-pagina="(\w+)"/g, '<a href="[PAGINA]" data-pagina="$1"');
    const referencia = normalizar(menu('stock-requests.html'));
    assert.ok(referencia.includes('[TOKEN]'));
    assert.equal(normalizar(menu(CENTRAL)), referencia);
  });

  test('a Central marca a si mesma como página atual e é a única com data-pagina="atendimentoToken"', () => {
    const html = ler(`pages/${CENTRAL}`);
    assert.equal((html.match(/data-pagina="atendimentoToken"/g) || []).length, 1);
    assert.match(html, /<a class="active" href="javascript:void\(0\)" data-pagina="atendimentoToken"/);
    assert.match(html, /pagina: 'atendimentoToken'/);
  });
});

describe('permissões da página e publicação', () => {
  test('PAGINAS.atendimentoToken: abre com a visualização do recurso OU uma ação da Central; sem "alterar" geral', () => {
    assert.deepEqual(P.PAGINAS.atendimentoToken, {
      abrir: [
        { recurso: 'atendimentoToken', operacao: 'visualizar' },
        { acao: 'TOKEN_GERAR_ATIVACAO' },
        { acao: 'TOKEN_GERENCIAR_REDES' },
        { acao: 'TOKEN_PREVIA_CATALOGO_REAL' },
      ],
      abrirComQualquer: true,
      alterar: [],
    });
    assert.equal(P.podeAbrir(permissoes(), 'atendimentoToken'), false);
    assert.equal(P.podeAbrir(permissoes({ perfil: 'MASTER' }), 'atendimentoToken'), false, 'o nome do perfil não abre nada');
  });

  test('a Central e o que ela carrega estão na allowlist de publicação (inclusive a biblioteca local de QR e a licença), sem recurso externo', () => {
    const arquivos = JSON.parse(ler('publicacao/allowlist.json')).arquivos;
    for (const f of ['pages/atendimento-token.html', 'js/atendimento-token.js', 'js/atendimento-token-tela.js', 'vendor/qrcode-generator-2.0.4.js', 'vendor/LICENSE-qrcode-generator.txt']) {
      assert.ok(arquivos.includes(f), f);
      assert.ok(fs.existsSync(path.join(RAIZ, f)), f);
    }
    assert.deepEqual(arquivos, [...arquivos].sort());
    assert.equal(new Set(arquivos).size, arquivos.length);
    const html = ler(`pages/${CENTRAL}`);
    const recursos = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(recursos.includes('../vendor/qrcode-generator-2.0.4.js'));
    for (const r of recursos.filter((x) => !/^https:\/\/fonts\.googleapis\.com\//.test(x))) assert.equal(/^[a-z][a-z0-9+.-]*:|^\/\//i.test(r), false, `recurso externo: ${r}`);
    assert.equal(/qrserver|chart\.apis|cdn\./i.test(html), false);
  });

  test('o registro da biblioteca de QR no vendor/README.md reflete o novo uso e o novo pacote', () => {
    const registro = ler('vendor/README.md');
    assert.match(registro, /QR de ativação do tablet na Central do Atendimento Token/);
    assert.match(registro, /No pacote do cliente \| desde a Etapa H/);
    assert.equal(/Fora do pacote do cliente/.test(registro), false);
  });
});
