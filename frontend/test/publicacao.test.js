'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { empacotar, verificarPacote, lerAllowlist } = require('../publicacao/empacotar');

/**
 * Publicação do frontend do cliente por allowlist explícita (segurança S1
 * da auditoria do Bloco 9). O pacote publicável contém SOMENTE os arquivos
 * listados em publicacao/allowlist.json; as páginas legadas continuam no
 * repositório, mas nunca entram no pacote. Tudo é fail-closed: qualquer
 * dúvida recusa o pacote inteiro, antes de escrever qualquer arquivo.
 */

const RAIZ = path.resolve(__dirname, '..');
const CLI = path.join(RAIZ, 'publicacao', 'empacotar.js');
const temporarios = [];

function diretorioTemporario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epi-publicacao-'));
  temporarios.push(dir);
  return dir;
}
function listar(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? listar(abs, base) : [path.relative(base, abs).split(path.sep).join('/')];
  }).sort();
}
function recusa(fn, codigo) {
  assert.throws(fn, (erro) => {
    assert.equal(erro.codigo, codigo, `esperado ${codigo}, veio ${erro.codigo}: ${erro.message}`);
    return true;
  });
}

afterEach(() => {
  while (temporarios.length) fs.rmSync(temporarios.pop(), { recursive: true, force: true });
});

describe('publicação do frontend do cliente por allowlist explícita', () => {
  test('o pacote contém exatamente a allowlist: nenhuma página legada, protótipo, Painel Privado ou arquivo de desenvolvimento', () => {
    const saida = path.join(diretorioTemporario(), 'pacote');
    const resultado = empacotar({ saida });

    const publicados = listar(saida);
    assert.deepEqual(publicados, [...lerAllowlist()].sort());
    assert.deepEqual(resultado.arquivos, publicados);

    // Toda página que carrega script externo (as legadas, com SheetJS por CDN) fica fora.
    const legadas = fs.readdirSync(path.join(RAIZ, 'pages'))
      .filter((f) => f.endsWith('.html'))
      .filter((f) => /<script[^>]+src=["']https?:/i.test(fs.readFileSync(path.join(RAIZ, 'pages', f), 'utf8')));
    assert.equal(legadas.length, 13, 'as 13 páginas legadas continuam no repositório (a E7 integrou a Validade de estoque, a E8 as Operações de estoque e a parte F as duas páginas de usuários)');
    for (const pagina of legadas) assert.ok(!publicados.includes(`pages/${pagina}`), `${pagina} não pode ser publicada`);

    for (const fora of ['index.html', 'js/main.js', 'js/db-api.js', 'js/auth-session.js', 'package.json', 'vendor/README.md']) {
      assert.ok(!publicados.includes(fora), `${fora} não pode ser publicado`);
    }
    for (const prefixo of ['painel-privado/', 'test/', 'publicacao/', 'IMAGEN/', 'node_modules/']) {
      assert.ok(!publicados.some((f) => f.startsWith(prefixo)), `nada de ${prefixo} no pacote`);
    }
  });

  test('fail-closed: página legada, protótipo ou Painel Privado acrescentados à allowlist recusam o pacote sem escrever nada', () => {
    const base = diretorioTemporario();
    const saida = path.join(base, 'pacote');
    const allowlist = lerAllowlist();

    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'pages/delivered-items.html'] }), 'SCRIPT_EXTERNO');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'js/main.js'] }), 'NUNCA_PUBLICAR');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'js/db-api.js'] }), 'NUNCA_PUBLICAR');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'painel-privado/index.html'] }), 'NUNCA_PUBLICAR');
    assert.equal(fs.existsSync(saida), false, 'nenhum arquivo escrito quando o pacote é recusado');
  });

  test('fail-closed: entradas fora do frontend, absolutas, diretórios, ausentes ou duplicadas', () => {
    const saida = path.join(diretorioTemporario(), 'pacote');
    const allowlist = lerAllowlist();

    recusa(() => empacotar({ saida, arquivos: [...allowlist, '../backend/package.json'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, '/etc/hosts'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'pages/./dashboard.html'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'pages'] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, 'pages/nao-existe.html'] }), 'ARQUIVO_AUSENTE');
    recusa(() => empacotar({ saida, arquivos: [...allowlist, allowlist[0]] }), 'ENTRADA_INVALIDA');
    recusa(() => empacotar({ saida, arquivos: [] }), 'ENTRADA_INVALIDA');
    assert.equal(fs.existsSync(saida), false);
  });

  test('fail-closed: recurso carregado por página publicada precisa estar na allowlist', () => {
    const saida = path.join(diretorioTemporario(), 'pacote');
    const semScript = lerAllowlist().filter((f) => f !== 'js/dashboard.js');
    recusa(() => empacotar({ saida, arquivos: semScript }), 'RECURSO_FORA_DA_ALLOWLIST');
    assert.equal(fs.existsSync(saida), false);
  });

  test('fail-closed: saída com conteúdo ou dentro do código-fonte do frontend é recusada', () => {
    const ocupada = diretorioTemporario();
    fs.writeFileSync(path.join(ocupada, 'sobra.html'), '<p>resto de outra publicação</p>');
    recusa(() => empacotar({ saida: ocupada }), 'SAIDA_INVALIDA');
    assert.deepEqual(listar(ocupada), ['sobra.html']);

    recusa(() => empacotar({ saida: path.join(RAIZ, 'dist-publico') }), 'SAIDA_INVALIDA');
    assert.equal(fs.existsSync(path.join(RAIZ, 'dist-publico')), false);
  });

  test('verificação do pacote: arquivo a mais ou a menos é detectado', () => {
    const saida = path.join(diretorioTemporario(), 'pacote');
    empacotar({ saida });
    assert.doesNotThrow(() => verificarPacote(saida));

    fs.writeFileSync(path.join(saida, 'pages', 'delivered-items.html'), '<p>legada</p>');
    recusa(() => verificarPacote(saida), 'PACOTE_DIVERGENTE');
    fs.rmSync(path.join(saida, 'pages', 'delivered-items.html'));

    fs.rmSync(path.join(saida, 'js', 'dashboard.js'));
    recusa(() => verificarPacote(saida), 'PACOTE_DIVERGENTE');
  });

  describe('script externo: só o Turnstile oficial, e só no login do Portal', () => {
    const TURNSTILE = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

    function frontendSintetico(paginas) {
      const raiz = diretorioTemporario();
      for (const [relativo, conteudo] of Object.entries(paginas)) {
        fs.mkdirSync(path.dirname(path.join(raiz, relativo)), { recursive: true });
        fs.writeFileSync(path.join(raiz, relativo), conteudo);
      }
      return { raiz, arquivos: Object.keys(paginas), saida: path.join(diretorioTemporario(), 'pacote') };
    }
    const pagina = (...srcs) => `<!DOCTYPE html><html><body>${srcs.map((s) => `<script src="${s}"></script>`).join('')}<script src="login.js"></script></body></html>`;

    test('a URL exata do Turnstile em portal/index.html é aceita', () => {
      const f = frontendSintetico({ 'portal/index.html': pagina(TURNSTILE), 'portal/login.js': '' });
      assert.deepEqual(empacotar(f).arquivos, ['portal/index.html', 'portal/login.js']);
    });

    test('qualquer variação da URL continua recusada', () => {
      for (const src of [
        'https://challenges.cloudflare.com/turnstile/v0/api.js',
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=iniciar',
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit#x',
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit ',
        'https://challenges.cloudflare.com/turnstile/v1/api.js?render=explicit',
        'https://challenges.cloudflare.com/turnstile/v0/outro.js?render=explicit',
        'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/scripts/jsd/main.js',
        'https://static.cloudflareinsights.com/beacon.min.js',
        'https://challenges.cloudflare.com.mal.test/turnstile/v0/api.js?render=explicit',
        'https://mal.challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        'http://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        '//challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
        'HTTPS://CHALLENGES.CLOUDFLARE.COM/turnstile/v0/api.js?render=explicit',
        'https://cdn.jsdelivr.net/npm/qualquer@1/index.js',
        'https://mal.test/turnstile/v0/api.js?render=explicit',
      ]) {
        const f = frontendSintetico({ 'portal/index.html': pagina(src), 'portal/login.js': '' });
        recusa(() => empacotar(f), 'SCRIPT_EXTERNO');
        assert.equal(fs.existsSync(f.saida), false, src);
      }
    });

    test('o Turnstile em outra página é recusado, e um segundo script externo no login também', () => {
      for (const outra of ['portal/empresas.html', 'portal/aceitar-convite.html', 'pages/dashboard.html', 'index.html']) {
        const f = frontendSintetico({ [outra]: pagina(TURNSTILE), 'portal/index.html': pagina(), 'portal/login.js': '', [path.posix.join(path.posix.dirname(outra), 'login.js')]: '' });
        recusa(() => empacotar(f), 'SCRIPT_EXTERNO');
      }
      const f = frontendSintetico({ 'portal/index.html': pagina(TURNSTILE, 'https://mal.test/x.js'), 'portal/login.js': '' });
      recusa(() => empacotar(f), 'SCRIPT_EXTERNO');
    });
  });

  test('linha de comando: sai com 0 ao gerar o pacote e com 1 quando recusa', () => {
    const saida = path.join(diretorioTemporario(), 'pacote');
    const ok = spawnSync(process.execPath, [CLI, '--saida', saida], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(listar(saida), [...lerAllowlist()].sort());

    const repetida = spawnSync(process.execPath, [CLI, '--saida', saida], { encoding: 'utf8' });
    assert.equal(repetida.status, 1);
    const semSaida = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
    assert.equal(semSaida.status, 1);
  });
});
