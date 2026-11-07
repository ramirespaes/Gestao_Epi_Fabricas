'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Modelos Nginx de Portal e Painel Privado (deploy/hml/nginx). São modelos: não
 * são aplicados em nenhum servidor. O renderizador recusa valor inválido ou
 * placeholder desconhecido, e as asserções abaixo travam as decisões de segurança
 * (CSP em todo location que define cabeçalho, isolamento de /api/plataforma,
 * dotfiles, versao.json, proxy só para 127.0.0.1).
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const DIR = path.join(REPO, 'deploy', 'hml', 'nginx');
const CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'sha256-AAAA'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
const MODELOS = ['seguranca-portal.conf.modelo', 'seguranca-painel.conf.modelo', 'portal.conf.modelo', 'painel.conf.modelo'];

function carregar() {
  try {
    return require(path.join(DIR, 'renderizar-modelo.js'));
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && erro.message.includes('renderizar-modelo')) assert.fail('deploy/hml/nginx/renderizar-modelo.js ainda não existe (RED esperado)');
    throw erro;
  }
}
const ler = (nome) => fs.readFileSync(path.join(DIR, nome), 'utf8');
const VALORES = {
  DOMINIO_PORTAL: 'app.hml.exemplo.test', DOMINIO_PAINEL: 'admin.hml.exemplo.test',
  RAIZ_PORTAL: '/var/www/safework/hml/app', RAIZ_PAINEL: '/var/www/safework/hml/admin',
  ARQUIVO_VERSAO_PORTAL: '/var/www/safework/hml/.releases/app/versao.json', ARQUIVO_VERSAO_PAINEL: '/var/www/safework/hml/.releases/admin/versao.json',
  ARQUIVO_SEGURANCA_PORTAL: '/etc/nginx/safework/seguranca-portal.conf', ARQUIVO_SEGURANCA_PAINEL: '/etc/nginx/safework/seguranca-painel.conf',
  PORTA_BACKEND: '3000', LIMITE_CORPO: '10m', HSTS_MAX_AGE: '300',
  CERTIFICADO_PORTAL: '/etc/ssl/exemplo/portal.pem', CHAVE_PORTAL: '/etc/ssl/exemplo/portal.key',
  CERTIFICADO_PAINEL: '/etc/ssl/exemplo/painel.pem', CHAVE_PAINEL: '/etc/ssl/exemplo/painel.key',
  DESTINO_RAIZ_PORTAL: '/portal/index.html', DESTINO_RAIZ_PAINEL: '/painel-privado/index.html',
  CSP_PORTAL: CSP, CSP_PAINEL: CSP,
  RAIZ_ACME: '/var/www/acme', REDE_VERIFICACAO: '203.0.113.0/24',
};

// Extrai blocos "location ... { ... }" e "server { ... }" por contagem de chaves.
function blocos(texto, inicio) {
  const achados = [];
  const re = new RegExp(`^\\s*(${inicio}[^{\\n]*)\\{`, 'gm');
  let m;
  while ((m = re.exec(texto))) {
    let profundidade = 1; let i = re.lastIndex;
    while (profundidade > 0 && i < texto.length) { if (texto[i] === '{') profundidade += 1; else if (texto[i] === '}') profundidade -= 1; i += 1; }
    achados.push({ cabecalho: m[1].trim(), corpo: texto.slice(re.lastIndex, i - 1) });
  }
  return achados;
}
const render = (modelo, valores = VALORES) => carregar().renderizarModelo(ler(modelo), valores);

describe('modelos Nginx — renderizador', () => {
  test('os quatro modelos existem e só usam placeholders conhecidos, todos validados', () => {
    const { PLACEHOLDERS } = carregar();
    for (const nome of MODELOS) {
      assert.ok(fs.existsSync(path.join(DIR, nome)), nome);
      for (const m of ler(nome).matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) assert.ok(PLACEHOLDERS[m[1]], `${nome}: placeholder sem validador ${m[1]}`);
    }
    assert.equal(Object.keys(VALORES).sort().join(), Object.keys(PLACEHOLDERS).sort().join(), 'o conjunto de valores de exemplo cobre todos os validadores');
  });

  test('renderiza sem restar placeholder e recusa valor faltante ou sobrando', () => {
    const { renderizarModelo } = carregar();
    for (const nome of MODELOS) assert.doesNotMatch(render(nome), /\{\{|\}\}/, nome);
    const { DOMINIO_PORTAL, ...sem } = VALORES;
    assert.throws(() => renderizarModelo(ler('portal.conf.modelo'), sem), (e) => e.codigo === 'NGINX_VALOR_AUSENTE');
    assert.throws(() => renderizarModelo(ler('portal.conf.modelo'), { ...VALORES, EXTRA: 'x' }), (e) => e.codigo === 'NGINX_VALOR_DESCONHECIDO');
    assert.throws(() => renderizarModelo('server { {{OUTRO_QUALQUER}} }', {}), (e) => e.codigo === 'NGINX_PLACEHOLDER_DESCONHECIDO');
  });

  test('valores com injeção de diretiva, aspas, quebra de linha ou caminho relativo são recusados', () => {
    const { renderizarModelo } = carregar();
    const ruins = {
      DOMINIO_PORTAL: ['a.test; return 200', 'a.test\nlisten 81', '*.exemplo.test', '_', 'localhost', 'A.TEST', 'a_b.test'],
      RAIZ_PORTAL: ['relativo/www', '/var/www/../etc', '/var/www; autoindex on', '/var/www/a b', '/var/www/$x', '/'],
      ARQUIVO_VERSAO_PORTAL: ['/var/www/outro.json', '/var/www/../versao.json'],
      ARQUIVO_SEGURANCA_PORTAL: ['/etc/nginx/x.txt', '/etc/nginx/x.conf; deny all'],
      PORTA_BACKEND: ['0', '80', '70000', 'abc', '3000; x', ' 3000'],
      LIMITE_CORPO: ['10', '10gb', '1m; x', '-1m', ''],
      HSTS_MAX_AGE: ['-1', '99999999999', 'x', '300; includeSubDomains'],
      DESTINO_RAIZ_PORTAL: ['http://externo.test/', '//externo.test', '/a;b', 'sem-barra', '/a b'],
      CSP_PORTAL: ['', `${CSP}"; add_header X-Teste "1`, `${CSP}\nadd_header X "1"`, `${CSP} } server {`, CSP.replace("script-src 'self'", "script-src 'unsafe-inline'"), 'default-src *', `${CSP} $host`, `${CSP} \\`],
      CERTIFICADO_PORTAL: ['relativo.pem', '/etc/ssl/a.pem;'],
    };
    for (const [nome, valores] of Object.entries(ruins)) {
      for (const v of valores) {
        assert.throws(() => renderizarModelo(ler('portal.conf.modelo'), { ...VALORES, [nome]: v }), (e) => e.codigo === 'NGINX_VALOR_INVALIDO', `${nome}=${JSON.stringify(v)}`);
      }
    }
  });
});

describe('modelos Nginx — decisões de segurança', () => {
  test('cabeçalhos de segurança: todos com always, CSP do perfil, nosniff, HSTS, COOP, sem X-Powered-By vazando', () => {
    for (const [modelo, referrer] of [['seguranca-portal.conf.modelo', 'strict-origin-when-cross-origin'], ['seguranca-painel.conf.modelo', 'no-referrer']]) {
      const texto = render(modelo);
      const linhas = texto.split('\n').filter((l) => /^\s*add_header\b/.test(l));
      assert.ok(linhas.length >= 6, modelo);
      for (const l of linhas) assert.match(l, /\balways;\s*$/, l);
      assert.ok(texto.includes(`Content-Security-Policy "${CSP}"`), modelo);
      assert.match(texto, /X-Content-Type-Options "nosniff"/);
      assert.match(texto, /X-Frame-Options "DENY"/);
      assert.match(texto, /Cross-Origin-Opener-Policy "same-origin"/);
      assert.match(texto, /Strict-Transport-Security "max-age=300"/);
      assert.ok(texto.includes(`Referrer-Policy "${referrer}"`), modelo);
    }
  });

  test('todo location que define add_header inclui o arquivo de segurança (add_header em location apaga os do servidor)', () => {
    for (const [modelo, incl] of [['portal.conf.modelo', VALORES.ARQUIVO_SEGURANCA_PORTAL], ['painel.conf.modelo', VALORES.ARQUIVO_SEGURANCA_PAINEL]]) {
      const texto = render(modelo);
      const locs = blocos(texto, 'location');
      assert.ok(locs.length >= 4, modelo);
      for (const l of locs.filter((x) => /\badd_header\b/.test(x.corpo))) assert.ok(l.corpo.includes(`include ${incl};`), `${modelo}: ${l.cabecalho}`);
      for (const l of blocos(texto, 'server').filter((s) => /listen 443/.test(s.corpo))) assert.ok(l.corpo.includes(`include ${incl};`), `${modelo}: server`);
      for (const linha of texto.split('\n').filter((x) => /^\s*add_header\b/.test(x))) assert.match(linha, /\balways;\s*$/, linha);
    }
  });

  test('porta 80 só redireciona para HTTPS; o servidor TLS exige TLS 1.2+ e não revela a versão', () => {
    for (const modelo of ['portal.conf.modelo', 'painel.conf.modelo']) {
      const servidores = blocos(render(modelo), 'server');
      assert.equal(servidores.length, 2, modelo);
      const http80 = servidores.find((s) => /listen 80;/.test(s.corpo));
      const tls = servidores.find((s) => /listen 443 ssl;/.test(s.corpo));
      assert.match(http80.corpo, /return 301 https:\/\/[a-z.]+\$request_uri;/);
      assert.doesNotMatch(http80.corpo, /return 301[^;]*\$host/);
      assert.doesNotMatch(http80.corpo, /proxy_pass|alias/);
      assert.equal(blocos(http80.corpo, 'location').length, 2, 'só o desafio ACME e o redirecionamento');
      assert.match(tls.corpo, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
      assert.doesNotMatch(tls.corpo, /TLSv1(\.0|\.1)?[ ;]|SSLv/);
      assert.match(tls.corpo, /server_tokens off;/);
      assert.match(tls.corpo, /autoindex off;/);
      assert.doesNotMatch(render(modelo), /autoindex on|server_name\s+(_|\*)|server_name\s+[^;]*\*/);
    }
  });

  test('versao.json é servido por alias exato do arquivo do instalador, sem cache, e dotfiles e .releases são negados', () => {
    for (const [modelo, versao] of [['portal.conf.modelo', VALORES.ARQUIVO_VERSAO_PORTAL], ['painel.conf.modelo', VALORES.ARQUIVO_VERSAO_PAINEL]]) {
      const texto = render(modelo);
      const v = blocos(texto, 'location = /versao.json')[0];
      assert.ok(v, modelo);
      assert.ok(v.corpo.includes(`alias ${versao};`));
      assert.match(v.corpo, /Cache-Control "no-store" always;/);
      assert.match(v.corpo, /default_type application\/json;/);
      const ponto = blocos(texto, 'location ~ /\\\\\\.')[0];
      assert.ok(ponto, `${modelo}: dotfiles`);
      assert.match(ponto.corpo, /return 404;/);
      assert.doesNotMatch(texto, /location \^~ \/ /, 'um prefixo ^~ / desligaria a regra de dotfiles');
    }
  });

  test('Portal: /api/plataforma/ responde 404 antes do proxy de /api/; proxy só para 127.0.0.1 na porta do backend', () => {
    const texto = render('portal.conf.modelo');
    const plataforma = blocos(texto, 'location \\^~ /api/plataforma/')[0];
    assert.match(plataforma.corpo, /return 404;/);
    const api = blocos(texto, 'location \\^~ /api/ ')[0];
    assert.match(api.corpo, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    assert.doesNotMatch(api.corpo, /proxy_pass http:\/\/127\.0\.0\.1:3000\//, 'sem URI no proxy_pass para preservar o caminho');
    assert.ok(texto.indexOf('/api/plataforma/') < texto.indexOf('location ^~ /api/ '));
    assert.match(api.corpo, /proxy_set_header Host \$host;/);
    assert.match(api.corpo, /proxy_set_header X-Forwarded-For \$remote_addr;/);
    assert.match(api.corpo, /proxy_set_header X-Forwarded-Proto \$scheme;/);
    assert.match(api.corpo, /proxy_hide_header X-Powered-By;/);
    for (const m of texto.matchAll(/proxy_pass\s+([^;]+);/g)) assert.match(m[1], /^http:\/\/127\.0\.0\.1:3000$/);
  });

  test('Painel: só /api/plataforma/ vai ao backend, preservando o Host (PLATAFORMA_HOST); o resto de /api/ é 404', () => {
    const texto = render('painel.conf.modelo');
    const plataforma = blocos(texto, 'location \\^~ /api/plataforma/')[0];
    assert.match(plataforma.corpo, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    assert.match(plataforma.corpo, /proxy_set_header Host \$host;/);
    const resto = blocos(texto, 'location \\^~ /api/ ')[0];
    assert.match(resto.corpo, /return 404;/);
    assert.equal(texto.match(/proxy_pass/g).length, 1);
  });

  test('raiz de cada origem leva à página inicial própria; o conteúdo vem do link do instalador e sem try_files perigoso', () => {
    const portal = render('portal.conf.modelo');
    const painel = render('painel.conf.modelo');
    assert.match(portal, /location = \/ \{[^}]*return 302 \/portal\/index\.html;/);
    assert.match(painel, /location = \/ \{[^}]*return 302 \/painel-privado\/index\.html;/);
    assert.ok(portal.includes(`root ${VALORES.RAIZ_PORTAL};`) && painel.includes(`root ${VALORES.RAIZ_PAINEL};`));
    for (const t of [portal, painel]) {
      const tls = blocos(t, 'server').find((s) => /listen 443 ssl;/.test(s.corpo));
      const estatico = blocos(tls.corpo, 'location /')[0];
      assert.match(estatico.corpo, /try_files \$uri \$uri\/index\.html =404;/);
      assert.match(estatico.corpo, /Cache-Control "no-cache" always;/);
    }
    assert.ok(portal.includes('server_name app.hml.exemplo.test;') && painel.includes('server_name admin.hml.exemplo.test;'));
    assert.doesNotMatch(portal, /painel-privado|admin\.hml/);
  });

  test('o README dos modelos declara que nada foi aplicado e lista o que a operação ainda precisa fazer', () => {
    const readme = ler('LEIA-ME.md');
    assert.match(readme, /não são aplicados|nenhum servidor/i);
    assert.match(readme, /nginx -t/);
    assert.match(readme, /TLS/);
    assert.match(readme, /TRUST_PROXY_HOPS/);
    assert.match(readme, /PLATAFORMA_HOST/);
  });
});
