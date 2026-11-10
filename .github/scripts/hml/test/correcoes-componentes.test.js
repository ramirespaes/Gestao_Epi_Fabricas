'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Correções da auditoria nos componentes que não são o instalador: scanner de segredos
 * (A-3, A-4), avaliador de CSP (A-6), modelos Nginx (M-6, M-7) e a asserção inoperante
 * (M-8). Escritos ANTES das correções (RED), a partir das sondas S5, S7 e do custo de regex.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const sha256 = (c) => crypto.createHash('sha256').update(c).digest('hex');
const temporarios = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-corr2-'));
  temporarios.push(dir);
  return dir;
};
afterEach(() => { while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true }); });

const PUBLICA = "SECRET_KEY_TESTE_SUCESSO: '1x0000000000000000000000000000000AA'";
const REAL = "apiKey: 'Zx9kLm2PqRt7VbN4cD8fGh1J'";

function raizBackend(arquivosExtras = {}) {
  const raiz = tmp();
  const base = {
    'package.json': JSON.stringify({ engines: { node: '>=22' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': {} } }),
    'src/server.js': "'use strict';\n", 'scripts/guarda-inicializacao.js': "'use strict';\n", 'migrations/000_a.sql': 'a',
    ...arquivosExtras,
  };
  for (const [rel, c] of Object.entries(base)) { fs.mkdirSync(path.dirname(path.join(raiz, rel)), { recursive: true }); fs.writeFileSync(path.join(raiz, rel), c); }
  fs.writeFileSync(path.join(raiz, 'migrations/checksums.json'), JSON.stringify({ algoritmo: 'sha256', migrations: { '000_a.sql': sha256('a') } }));
  return raiz;
}
const empacotar = (arquivos) => require(path.join(REPO, 'deploy/hml/empacotar-backend.js')).empacotarBackend({ saida: path.join(tmp(), 'p'), raiz: raizBackend(arquivos) });
const recusaCom = (fn, codigo) => assert.throws(fn, (e) => { assert.equal(e.codigo, codigo, e.message); return true; });

describe('A-3 — todas as atribuições de uma linha são examinadas (sonda S5)', () => {
  test('chave pública de teste antes de um segredo real na mesma linha não esconde o segredo', () => {
    for (const linha of [`const o = { ${PUBLICA}, ${REAL} };\n`, `const o = { ${REAL}, ${PUBLICA} };\n`, `const o = { ${PUBLICA}, ${PUBLICA}, senha: 'Zx9kLm2PqRt7VbN4cD8fGh1J' };\n`]) {
      recusaCom(() => empacotar({ 'src/c.js': linha }), 'SEGREDO_NO_CONTEUDO');
    }
  });

  test('duas chaves públicas de teste na mesma linha continuam aceitas, e a mensagem não repete o valor', () => {
    assert.doesNotThrow(() => empacotar({ 'src/c.js': `const o = { ${PUBLICA}, SECRET_KEY_TESTE_FALHA: '2x0000000000000000000000000000000AA' };\n` }));
    try { empacotar({ 'src/c.js': `const o = { ${PUBLICA}, ${REAL} };\n` }); } catch (e) { assert.ok(!e.message.includes('Zx9kLm2PqRt7VbN4cD8fGh1J')); assert.match(e.message, /src\/c\.js:1/); }
  });

  test('variações da chave pública continuam recusadas', () => {
    for (const v of ['1x0000000000000000000000000000000AB', '1x0000000000000000000000000000000AAA', '4x0000000000000000000000000000000AA']) {
      recusaCom(() => empacotar({ 'src/c.js': `const o = { SECRET_KEY_TESTE_SUCESSO: '${v}' };\n` }), 'SEGREDO_NO_CONTEUDO');
    }
  });
});

describe('A-4 — limite contra regex de custo excessivo (medição de S5/regex)', () => {
  test('linha acima do limite é recusada rapidamente com código próprio, sem varrer a regex', () => {
    const t0 = process.hrtime.bigint();
    recusaCom(() => empacotar({ 'src/min.js': `${'a'.repeat(100000)}\n` }), 'LINHA_MUITO_LONGA');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2500, `levou ${ms.toFixed(0)} ms`);
  });

  test('linhas longas abaixo do limite são varridas em tempo curto, inclusive os piores casos conhecidos', () => {
    for (const linha of ['a'.repeat(9000), 'deadbeef'.repeat(1100), 'token'.repeat(1800), 'senha = '.repeat(1100), `${'x'.repeat(4000)} token: "${'k'.repeat(4000)}`]) {
      const t0 = process.hrtime.bigint();
      try { empacotar({ 'src/l.js': `${linha}\n` }); } catch (e) { assert.ok(['SEGREDO_NO_CONTEUDO'].includes(e.codigo), e.codigo); }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 1500, `${linha.slice(0, 12)}…: ${ms.toFixed(0)} ms`);
    }
  });

  test('o limite vale para js, sql e json do pacote, e a linha mais longa do backend real cabe com folga', () => {
    recusaCom(() => empacotar({ 'migrations/001_b.sql': `${'-'.repeat(20000)}\n` }), 'LINHA_MUITO_LONGA');
    const real = require(path.join(REPO, 'deploy/hml/empacotar-backend.js'));
    assert.ok(real.LIMITE_LINHA >= 2000 && real.LIMITE_LINHA <= 20000);
    const maior = Math.max(...fs.readFileSync(path.join(REPO, 'backend/src/app.js'), 'utf8').split('\n').map((l) => l.length));
    assert.ok(maior * 3 < real.LIMITE_LINHA, `app.js tem linha de ${maior}`);
  });
});

describe('A-6 — avaliador de CSP restritivo (sonda S7)', () => {
  const base = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'sha256-AAAA'; style-src 'self'";
  const avaliar = (p) => require(path.join(REPO, 'deploy/hml/verificacao/verificar-publicacao.js')).avaliarCsp(p);

  test('a política base é aceita; sem form-action é recusada', () => {
    assert.deepEqual(avaliar(base), []);
    assert.ok(avaliar(base.replace("form-action 'self'; ", '')).length > 0);
    assert.ok(avaliar(base.replace("form-action 'self'", "form-action *")).length > 0);
  });

  test('esquemas amplos, curingas e palavras-chave inseguras são recusados em toda diretiva de busca de recursos', () => {
    const ruins = [
      `${base}; script-src-elem 'self' https:`, base.replace("script-src 'self'", "script-src 'self' https:"), base.replace("script-src 'self'", "script-src 'self' http://x.test"),
      `${base}; connect-src *`, `${base}; connect-src https:`, `${base}; connect-src ws:`, `${base}; connect-src wss:`,
      `${base}; img-src *`, `${base}; img-src http:`, `${base}; img-src https:`, `${base}; font-src *`, `${base}; font-src data:`,
      `${base}; frame-src *`, `${base}; frame-src https:`, `${base}; child-src *`, `${base}; worker-src blob:`, `${base}; media-src *`, `${base}; manifest-src *`,
      `${base}; style-src-elem 'unsafe-inline'`, `${base}; style-src-elem https:`, `${base}; script-src-attr 'unsafe-inline'`,
      base.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'"), base.replace("script-src 'self'", "script-src 'self' 'unsafe-hashes'"),
      base.replace("script-src 'self'", "script-src 'self' blob:"), base.replace("style-src 'self'", "style-src 'self' data:"),
      base.replace("script-src 'self'", "script-src 'self' https://*.exemplo.test"), `${base}; img-src 'self' https://exemplo.test/*`,
    ];
    for (const p of ruins) assert.ok(avaliar(p).length > 0, p);
  });

  test('o que a política gerada precisa continua aceito: data em img-src, hosts https explícitos, unsafe-hashes só em script-src-attr, unsafe-inline só em style-src-attr', () => {
    const aceitas = [
      `${base}; img-src 'self' data:`, `${base}; img-src 'self' data: https://img.exemplo.test`, `${base}; connect-src 'self' https://challenges.cloudflare.com`,
      `${base}; frame-src https://challenges.cloudflare.com`, `${base}; font-src 'self' https://fonts.gstatic.com`, `${base}; frame-src 'none'`,
      `${base}; script-src-attr 'unsafe-hashes' 'sha256-BBBB'`, `${base}; style-src-attr 'unsafe-inline'`, `${base}; style-src-attr 'unsafe-hashes' 'sha256-CCCC'`,
      `${base}; upgrade-insecure-requests`, `${base}; connect-src 'self' https://api.exemplo.test:8443`,
    ];
    for (const p of aceitas) assert.deepEqual(avaliar(p), [], p);
  });

  test('o renderizador Nginx herda o rigor: nenhuma política recusada pelo avaliador chega ao arquivo', () => {
    const { renderizarModelo } = require(path.join(REPO, 'deploy/hml/nginx/renderizar-modelo.js'));
    for (const ruim of [`${base}; connect-src *`, `${base}; img-src *`, base.replace("script-src 'self'", "script-src 'self' https:"), `${base}; frame-src *`]) {
      assert.throws(() => renderizarModelo('{{CSP_PORTAL}}', { CSP_PORTAL: ruim }), (e) => e.codigo === 'NGINX_VALOR_INVALIDO', ruim);
    }
  });

  test('a política que o gerador produz para o Painel real passa no avaliador mais rígido', () => {
    const { gerarCsp } = require(path.join(REPO, 'deploy/hml/csp/gerar-csp.js'));
    const saida = path.join(tmp(), 'painel');
    require(path.join(REPO, 'frontend/publicacao/empacotar-painel.js')).empacotar({ saida });
    assert.deepEqual(avaliar(gerarCsp({ raiz: saida, perfil: 'painel' }).politica), []);
  });
});

describe('M-6 e M-7 — modelos Nginx: ACME, HTTP/2, redirecionamento e exposição de versao.json', () => {
  const DIR = path.join(REPO, 'deploy/hml/nginx');
  const CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'sha256-AAAA'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; connect-src 'self'";
  const VALORES = {
    DOMINIO_PORTAL: 'app.hml.exemplo.test', DOMINIO_PAINEL: 'admin.hml.exemplo.test', RAIZ_PORTAL: '/var/www/safework/hml/app', RAIZ_PAINEL: '/var/www/safework/hml/admin',
    ARQUIVO_VERSAO_PORTAL: '/var/www/safework/hml/.releases/app/versao.json', ARQUIVO_VERSAO_PAINEL: '/var/www/safework/hml/.releases/admin/versao.json',
    ARQUIVO_SEGURANCA_PORTAL: '/etc/nginx/safework/seguranca-portal.conf', ARQUIVO_SEGURANCA_PAINEL: '/etc/nginx/safework/seguranca-painel.conf',
    PORTA_BACKEND: '3000', LIMITE_CORPO: '10m', HSTS_MAX_AGE: '300', CERTIFICADO_PORTAL: '/etc/ssl/exemplo/portal.pem', CHAVE_PORTAL: '/etc/ssl/exemplo/portal.key',
    CERTIFICADO_PAINEL: '/etc/ssl/exemplo/painel.pem', CHAVE_PAINEL: '/etc/ssl/exemplo/painel.key', DESTINO_RAIZ_PORTAL: '/portal/index.html', DESTINO_RAIZ_PAINEL: '/painel-privado/index.html',
    CSP_PORTAL: CSP, CSP_PAINEL: CSP, RAIZ_ACME: '/var/www/acme', REDE_VERIFICACAO: '203.0.113.0/24',
    ARQUIVO_SEGURANCA_PORTAL_ATENDIMENTO: '/etc/nginx/safework/seguranca-portal-atendimento.conf',
    ARQUIVO_SEGURANCA_PORTAL_PREVIA: '/etc/nginx/safework/seguranca-portal-previa.conf',
    ...(({ atendimento, previa }) => ({ CSP_PORTAL_ATENDIMENTO: atendimento, CSP_PORTAL_PREVIA: previa }))(require(path.join(REPO, 'deploy/hml/csp/gerar-csp.js')).derivarCspTotem(CSP)),
  };
  const { renderizarModelo, PLACEHOLDERS } = require(path.join(DIR, 'renderizar-modelo.js'));
  const render = (n, v = VALORES) => renderizarModelo(fs.readFileSync(path.join(DIR, n), 'utf8'), v);
  const blocos = (texto, inicio) => {
    const achados = []; const re = new RegExp(`^\\s*(${inicio}[^{\\n]*)\\{`, 'gm'); let m;
    while ((m = re.exec(texto))) { let p = 1; let i = re.lastIndex; while (p > 0 && i < texto.length) { if (texto[i] === '{') p += 1; else if (texto[i] === '}') p -= 1; i += 1; } achados.push({ cabecalho: m[1].trim(), corpo: texto.slice(re.lastIndex, i - 1) }); }
    return achados;
  };

  test('os placeholders novos existem e os valores de exemplo cobrem exatamente o conjunto dos validadores', () => {
    assert.equal(Object.keys(VALORES).sort().join(), Object.keys(PLACEHOLDERS).sort().join());
  });

  test('sem http2 on (incompatível com nginx anterior a 1.25.1) e sem http2 em listen', () => {
    for (const m of ['portal.conf.modelo', 'painel.conf.modelo']) assert.doesNotMatch(render(m), /http2/i, m);
  });

  test('a porta 80 atende a validação ACME num caminho fixo e redireciona o resto para o domínio fixo, nunca por $host', () => {
    for (const [m, dominio] of [['portal.conf.modelo', 'app.hml.exemplo.test'], ['painel.conf.modelo', 'admin.hml.exemplo.test']]) {
      const texto = render(m);
      const http80 = blocos(texto, 'server').find((s) => /listen 80;/.test(s.corpo));
      const acme = blocos(http80.corpo, 'location \\^~ /.well-known/acme-challenge/')[0];
      assert.ok(acme, `${m}: location ACME`);
      assert.match(acme.corpo, /root \/var\/www\/acme;/);
      assert.match(acme.corpo, /try_files \$uri =404;/);
      assert.doesNotMatch(acme.corpo, /proxy_pass|return 30/);
      const resto = blocos(http80.corpo, 'location /')[0];
      assert.ok(resto.corpo.includes(`return 301 https://${dominio}$request_uri;`), `${m}: redirecionamento fixo`);
      assert.doesNotMatch(texto, /return 301 [^;]*\$host/);
      assert.doesNotMatch(http80.corpo, /proxy_pass/);
    }
  });

  test('versao.json só responde a localhost e à rede de verificação declarada; o resto recebe 403', () => {
    for (const [m, versao] of [['portal.conf.modelo', VALORES.ARQUIVO_VERSAO_PORTAL], ['painel.conf.modelo', VALORES.ARQUIVO_VERSAO_PAINEL]]) {
      const v = blocos(render(m), 'location = /versao.json')[0];
      assert.ok(v.corpo.includes(`alias ${versao};`));
      const ordem = [...v.corpo.matchAll(/^\s*(allow|deny)\s+([^;]+);/gm)].map((x) => `${x[1]} ${x[2]}`);
      assert.deepEqual(ordem, ['allow 127.0.0.1', 'allow ::1', 'allow 203.0.113.0/24', 'deny all'], m);
      assert.match(v.corpo, /Cache-Control "no-store" always;/);
    }
  });

  test('REDE_VERIFICACAO aceita IP único ou rede específica e recusa redes amplas, injeção e formas inválidas', () => {
    const ok = (v) => assert.doesNotThrow(() => render('portal.conf.modelo', { ...VALORES, REDE_VERIFICACAO: v }), v);
    const ruim = (v) => assert.throws(() => render('portal.conf.modelo', { ...VALORES, REDE_VERIFICACAO: v }), (e) => e.codigo === 'NGINX_VALOR_INVALIDO', v);
    // Codex R04: o contrato diz "nunca faixa ampla". IPv4 a partir de /24 e IPv6 a partir de /64 (antes aceitavam /16 e /32).
    for (const v of ['203.0.113.7', '203.0.113.0/24', '2001:db8:0:1::/64', '2001:db8:1::5']) ok(v);
    for (const v of ['0.0.0.0/0', '0.0.0.0', '::/0', '10.0.0.0/7', '10.0.0.0/33', '10.0.0.0/8', '10.20.0.0/16', '2001:db8::/32', '2001:db8::/16', 'all', 'any', '10.0.0.1; deny all', '10.0.0.1\nallow all', '300.1.1.1', '10.0.0', '', '*', '10.0.0.1/']) ruim(v);
  });

  test('RAIZ_ACME precisa ser caminho absoluto sem traversal', () => {
    for (const v of ['relativo', '/var/www/../etc', '/var/www/a;b', '/']) assert.throws(() => render('portal.conf.modelo', { ...VALORES, RAIZ_ACME: v }), (e) => e.codigo === 'NGINX_VALOR_INVALIDO', v);
  });

  test('as decisões anteriores continuam: TLS 1.2+, include de segurança em todo location com add_header, /api/plataforma isolado, dotfiles negados', () => {
    for (const [m, incl] of [['portal.conf.modelo', VALORES.ARQUIVO_SEGURANCA_PORTAL], ['painel.conf.modelo', VALORES.ARQUIVO_SEGURANCA_PAINEL]]) {
      const texto = render(m);
      assert.match(texto, /ssl_protocols TLSv1\.2 TLSv1\.3;/);
      const variantes = m === 'portal.conf.modelo' ? [VALORES.ARQUIVO_SEGURANCA_PORTAL_ATENDIMENTO, VALORES.ARQUIVO_SEGURANCA_PORTAL_PREVIA] : [];
      for (const l of blocos(texto, 'location').filter((x) => /\badd_header\b/.test(x.corpo))) assert.ok([incl, ...variantes].some((i) => l.corpo.includes(`include ${i};`)), `${m}: ${l.cabecalho}`);
      assert.ok(blocos(texto, 'location ~ /\\\\\\.')[0]);
      assert.doesNotMatch(texto, /location \^~ \/ /, 'um prefixo ^~ / desligaria a regra de dotfiles');
    }
  });
});

describe('M-8 — asserções inoperantes nos testes da Fase 2', () => {
  test('nenhum teste usa "|| true" ou assert.ok(true) para passar sem verificar', () => {
    const dir = path.join(REPO, '.github/scripts/hml/test');
    const achados = [];
    for (const arq of fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && f !== 'correcoes-componentes.test.js')) {
      fs.readFileSync(path.join(dir, arq), 'utf8').split('\n').forEach((linha, i) => {
        if (/assert[.\w]*\(.*\|\|\s*true\s*\)/.test(linha) || /assert\.ok\(\s*true\s*[,)]/.test(linha) || /assert\.equal\(\s*true\s*,\s*true/.test(linha)) achados.push(`${arq}:${i + 1}`);
      });
    }
    assert.deepEqual(achados, []);
  });
});
