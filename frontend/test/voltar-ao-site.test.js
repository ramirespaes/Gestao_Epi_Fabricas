'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Logo SafeWork clicável e link "Voltar ao site" nas duas telas de login
 * (Portal do Cliente e Painel Privado), levando à página institucional.
 *
 * Em ambiente local (localhost, 127.0.0.1, [::1]) o destino é a página
 * institucional servida na porta 5500, inclusive a partir do Painel
 * Privado em 5501. Fora do ambiente local vale só o destino de produção,
 * a configurar na implantação; enquanto vazio, os links ficam ocultos —
 * nunca um visitante de produção é levado a localhost. Sem history.back().
 */

const RAIZ = path.join(__dirname, '..');
const PAGINAS = {
  'portal/index.html': { pasta: 'portal' },
  'painel-privado/index.html': { pasta: 'painel-privado' },
};
const INSTITUCIONAL = '/institucional/safework_engenharia_pagina_inicial.html';

const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

/** Executa o script embutido da página sobre um DOM mínimo e devolve o estado dos links. */
function simular(html, { hostname, pathname }) {
  const inicio = html.lastIndexOf('<script>');
  const fim = html.lastIndexOf('</script>');
  assert.ok(inicio !== -1 && fim > inicio, 'há um script embutido');
  const script = html.slice(inicio + '<script>'.length, fim);
  const links = {};
  const el = (id) => (links[id] = links[id] || { id, href: '#', hidden: true, atributos: {}, setAttribute(k, v) { this.atributos[k] = v; }, removeAttribute(k) { delete this.atributos[k]; } });
  el('link-logo-site'); el('link-voltar-site'); // existem na marcação antes do script rodar
  const sandbox = { location: { hostname, pathname }, document: { getElementById: el }, window: {} };
  // eslint-disable-next-line no-new-func
  new Function('location', 'document', 'window', script)(sandbox.location, sandbox.document, sandbox.window);
  return links;
}

for (const [pagina, { pasta }] of Object.entries(PAGINAS)) {
  describe(`${pagina}: logo e "Voltar ao site"`, () => {
    const html = ler(pagina);

    test('marcação: logo clicável (link) e link "Voltar ao site", ambos ocultos até o destino ser conhecido; sem history.back()', () => {
      assert.match(html, /<a id="link-logo-site"[^>]*aria-label="[^"]*SafeWork[^"]*"[^>]*hidden/);
      assert.match(html, /<a id="link-voltar-site"[^>]*hidden[^>]*>Voltar ao site<\/a>/);
      assert.equal(/history\.back|history\.go\(/.test(html), false);
      assert.equal(/db-api\.js|main\.js/.test(html), false);
    });

    test('ambiente local: destino é a institucional na origem 5500, com o mesmo caminho até frontend/ (raiz do repositório ou raiz em frontend/)', () => {
      const raizRepo = simular(html, { hostname: 'localhost', pathname: `/frontend/${pasta}/index.html` });
      assert.equal(raizRepo['link-logo-site'].href, `http://localhost:5500/frontend${INSTITUCIONAL}`);
      assert.equal(raizRepo['link-voltar-site'].href, `http://localhost:5500/frontend${INSTITUCIONAL}`);
      assert.deepEqual([raizRepo['link-logo-site'].hidden, raizRepo['link-voltar-site'].hidden], [false, false]);

      const raizFrontend = simular(html, { hostname: '127.0.0.1', pathname: `/${pasta}/index.html` });
      assert.equal(raizFrontend['link-voltar-site'].href, `http://localhost:5500${INSTITUCIONAL}`);
    });

    test('produção sem domínio configurado: nenhum destino local; os dois links continuam ocultos', () => {
      for (const hostname of ['app.exemplo.com.br', 'epi.safeworkengenharia.com.br', '']) {
        const links = simular(html, { hostname, pathname: `/${pasta}/index.html` });
        assert.equal(links['link-logo-site'].hidden, true, hostname);
        assert.equal(links['link-voltar-site'].hidden, true, hostname);
        assert.equal(/localhost/.test(links['link-voltar-site'].href), false, hostname);
      }
    });

    test('o destino de produção é um único ponto de configuração, vazio até a implantação', () => {
      assert.match(html, /const SITE_INSTITUCIONAL_PRODUCAO = '';/);
    });
  });
}

test('Painel Privado aberto pela porta 5501 também volta para a institucional em 5500', () => {
  const links = simular(ler('painel-privado/index.html'), { hostname: 'localhost', pathname: '/frontend/painel-privado/index.html' });
  assert.equal(links['link-voltar-site'].href, `http://localhost:5500/frontend${INSTITUCIONAL}`);
});
