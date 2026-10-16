'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * K5-A (D-C9) — o cookie da credencial do tablet (`gepi_tablet`) usa SameSite=Strict FIXO, na emissão e na remoção,
 * independentemente de SESSAO_COOKIE_SAMESITE. Os demais cookies seguem como antes: os de sessão acompanham a configuração
 * global; o de atendimento já era Strict fixo.
 *
 * O módulo security/cookie.js lê authConfig quando é carregado, então cada configuração roda em um processo filho com o
 * ambiente próprio (sem banco, sem rede). O supertest não simula navegador cross-site: estes testes provam os atributos
 * emitidos, não o comportamento do navegador (que fica para a homologação com as origens reais).
 */

const RAIZ = path.join(__dirname, '..', '..');
const PROGRAMA = `
const c = require('./src/security/cookie');
const { gerarTokenSessao } = require('./src/security/token');
const t = gerarTokenSessao();
console.log(JSON.stringify({
  dispositivo: c.serializarCookieDispositivo(t),
  dispositivoRemocao: c.serializarRemocaoCookieDispositivo(),
  atendimento: c.serializarCookieAtendimento(t),
  atendimentoRemocao: c.serializarRemocaoCookieAtendimento(),
  sessao: c.serializarCookieSessao(t),
  sessaoGlobal: c.serializarCookieSessaoGlobal(t),
  sessaoPlataforma: c.serializarCookieSessaoPlataforma(t),
}));
`;

function emitir(env) {
  const r = spawnSync(process.execPath, ['--require', './test/setup.js', '-e', PROGRAMA], {
    cwd: RAIZ,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  assert.equal(r.status, 0, `processo filho falhou: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

const CONFIGURACOES = [
  { nome: 'padrão (variável ausente → lax)', env: {}, esperadoSessao: 'Lax' },
  { nome: 'SESSAO_COOKIE_SAMESITE=lax', env: { SESSAO_COOKIE_SAMESITE: 'lax' }, esperadoSessao: 'Lax' },
  { nome: 'SESSAO_COOKIE_SAMESITE=strict', env: { SESSAO_COOKIE_SAMESITE: 'strict' }, esperadoSessao: 'Strict' },
  { nome: 'SESSAO_COOKIE_SAMESITE=none com Secure', env: { SESSAO_COOKIE_SAMESITE: 'none', SESSAO_COOKIE_SECURE: 'true' }, esperadoSessao: 'None' },
];

const atributo = (texto, nome) => new RegExp(`; ${nome}(=([^;]*))?(;|$)`, 'i').exec(texto);

describe('K5-A — SameSite=Strict fixo no cookie gepi_tablet', () => {
  for (const cfg of CONFIGURACOES) {
    describe(cfg.nome, () => {
      const saida = emitir(cfg.env);

      test('R1 — a emissão do cookie do tablet é SameSite=Strict, com os demais atributos de antes', () => {
        const texto = saida.dispositivo;
        assert.match(texto, /^gepi_tablet=[A-Za-z0-9_-]{43};/);
        assert.match(texto, /; SameSite=Strict(;|$)/);
        assert.equal(/SameSite=(Lax|None)/i.test(texto), false, 'nenhum outro valor de SameSite');
        assert.match(texto, /; HttpOnly/);
        assert.match(texto, /; Path=\/api\/atendimento-token\/tablet(;|$)/);
        assert.ok(Number(/Max-Age=(\d+)/.exec(texto)?.[1]) >= 30 * 24 * 3600, 'continua persistente (180 dias por padrão)');
        assert.equal(/; Domain=/i.test(texto), false);
        assert.equal(/; Expires=/i.test(texto), false);
        assert.equal(Boolean(atributo(texto, 'Secure')), cfg.env.SESSAO_COOKIE_SECURE === 'true', 'Secure segue SESSAO_COOKIE_SECURE como antes');
      });

      test('R2 — a remoção repete exatamente os atributos estruturais, inclusive SameSite=Strict, para substituir e não duplicar', () => {
        const texto = saida.dispositivoRemocao;
        assert.match(texto, /^gepi_tablet=;/);
        assert.match(texto, /; SameSite=Strict(;|$)/);
        assert.match(texto, /; HttpOnly/);
        assert.match(texto, /; Path=\/api\/atendimento-token\/tablet(;|$)/);
        assert.match(texto, /; Max-Age=0/);
        assert.equal(Boolean(atributo(texto, 'Secure')), Boolean(atributo(saida.dispositivo, 'Secure')), 'Secure igual ao da emissão');
        const estrutural = (t) => ['SameSite', 'HttpOnly', 'Path', 'Secure'].map((n) => (atributo(t, n) ? atributo(t, n)[0] : null));
        assert.deepEqual(estrutural(texto), estrutural(saida.dispositivo));
      });

      test('R3 — controle: os cookies de sessão continuam seguindo SESSAO_COOKIE_SAMESITE (nada mudou para eles)', () => {
        for (const chave of ['sessao', 'sessaoGlobal', 'sessaoPlataforma']) {
          assert.match(saida[chave], new RegExp(`; SameSite=${cfg.esperadoSessao}(;|$)`), `${chave}: ${saida[chave]}`);
          assert.match(saida[chave], /; Path=\/(;|$)/, `${chave} segue em Path=/`);
        }
      });

      test('R4 — controle: o cookie de atendimento continua Strict fixo, com Path e Max-Age próprios', () => {
        for (const texto of [saida.atendimento, saida.atendimentoRemocao]) {
          assert.match(texto, /^gepi_atendimento=/);
          assert.match(texto, /; SameSite=Strict(;|$)/);
          assert.match(texto, /; Path=\/api\/atendimento-token\/tablet\/atendimento(;|$)/);
        }
        assert.match(saida.atendimento, /; Max-Age=60(;|$)/);
      });
    });
  }

  test('R5 — o cookie gepi_tablet só é montado por security/cookie.js, e os pontos de emissão usam a política (nenhum Set-Cookie manual)', () => {
    const arquivos = [];
    const varrer = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) varrer(abs);
        else if (e.name.endsWith('.js') && !/ 2\./.test(e.name)) arquivos.push(abs);
      }
    };
    varrer(path.join(RAIZ, 'src'));
    const rel = (f) => path.relative(RAIZ, f).split(path.sep).join('/');
    const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const emissores = arquivos.filter((f) => rel(f) !== 'src/security/cookie.js' && /serializar(Remocao)?CookieDispositivo\(/.test(semComentarios(fs.readFileSync(f, 'utf8')))).map(rel).sort();
    assert.deepEqual(emissores, ['src/controllers/token-tablet.controller.js', 'src/middleware/autenticacao-dispositivo.js']);
    for (const f of emissores) {
      const codigo = semComentarios(fs.readFileSync(path.join(RAIZ, f), 'utf8'));
      assert.match(codigo, /res\.append\('Set-Cookie', serializarCookieDispositivo\(/, `${f} emite pela política central`);
      assert.equal(/gepi_tablet=|SameSite|cookie\.serialize\(/i.test(codigo), false, `${f} não monta atributos de cookie à mão`);
    }
    const politica = fs.readFileSync(path.join(RAIZ, 'src', 'security', 'cookie.js'), 'utf8');
    const bloco = /const politicaDispositivo = criarPoliticaCookie\(\{[\s\S]*?\}\);/.exec(politica);
    assert.ok(bloco, 'a política do dispositivo existe em security/cookie.js');
    assert.match(bloco[0], /sameSite:\s*'strict'/, 'a política do dispositivo fixa strict');
    assert.equal(/authConfig\.sessao\.cookieSameSite/.test(bloco[0]), false, 'e não herda a configuração global');
  });
});
