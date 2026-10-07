'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { RECURSOS_COM_EFEITO } = require('../../src/rbac/recursos');

/**
 * "Configurar permissões" só pode mostrar o que tem efeito real. O catálogo (RECURSOS_COM_EFEITO) tem de ser EXATAMENTE
 * o conjunto (recurso, operação) que as rotas de produção exigem com criarExigirPermissaoRecurso: nem uma operação
 * exigida fica de fora, nem uma operação sem rota aparece como se tivesse efeito.
 */
const RAIZ = path.join(__dirname, '..', '..', 'src');
const arquivos = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? arquivos(path.join(dir, e.name)) : (e.name.endsWith('.js') ? [path.join(dir, e.name)] : [])));

function exigidoPelasRotas() {
  const achados = new Set();
  const nao = [];
  for (const arquivo of arquivos(RAIZ)) {
    if (arquivo.endsWith(path.join('middleware', 'autorizacao.js'))) continue; // a definição da fábrica, não um uso
    const fonte = fs.readFileSync(arquivo, 'utf8');
    const constantes = Object.fromEntries([...fonte.matchAll(/const\s+([A-Z_]+)\s*=\s*'([^']+)'/g)].map((m) => [m[1], m[2]]));
    for (const m of fonte.matchAll(/const\s+([A-Z_]+)\s*=\s*([A-Z_]+)\s*;/g)) if (constantes[m[2]] !== undefined) constantes[m[1]] = constantes[m[2]];
    for (const m of fonte.matchAll(/criarExigirPermissaoRecurso\(\s*[^,()]*(?:\([^)]*\))?[^,()]*,\s*([A-Za-z_']+[A-Za-z_']*)\s*,\s*([A-Za-z_']+[A-Za-z_']*)\s*\)/g)) {
      const valor = (x) => (x.startsWith("'") ? x.slice(1, -1) : constantes[x]);
      const recurso = valor(m[1]);
      const operacao = valor(m[2]);
      if (recurso === undefined || operacao === undefined) nao.push(`${path.relative(RAIZ, arquivo)}: ${m[0]}`);
      else achados.add(`${recurso}.${operacao}`);
    }
  }
  return { achados, nao };
}

describe('catálogo de permissões do usuário = o que as rotas exigem', () => {
  test('cada recurso.operação exigido por alguma rota está no catálogo, e cada um do catálogo é exigido por alguma rota', () => {
    const { achados, nao } = exigidoPelasRotas();
    assert.deepEqual(nao, [], 'nenhuma exigência ficou sem resolver');
    const catalogo = new Set(RECURSOS_COM_EFEITO.flatMap((r) => r.operacoes.map((o) => `${r.recurso}.${o}`)));
    assert.deepEqual([...achados].filter((x) => !catalogo.has(x)).sort(), [], 'exigido por rota mas ausente do catálogo');
    assert.deepEqual([...catalogo].filter((x) => !achados.has(x)).sort(), [], 'no catálogo mas nenhuma rota exige (controle sem efeito)');
  });
});

const { ACOES_COM_EFEITO } = require('../../src/rbac/recursos');

describe('ações do catálogo de permissões = ações realmente aplicadas', () => {
  const MIGRATIONS = path.join(__dirname, '..', '..', 'migrations');
  const doCatalogo = new Set(fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).flatMap((f) => [...fs.readFileSync(path.join(MIGRATIONS, f), 'utf8').matchAll(/INSERT INTO acoes[\s\S]*?;/g)].flatMap((m) => [...m[0].matchAll(/'([A-Z][A-Z_]{5,})'/g)].map((x) => x[1]).filter((c) => !['OBRIGATORIA', 'ALTERNATIVA'].includes(c)))));
  const usadoNoCodigo = (codigo) => arquivos(RAIZ).filter((a) => !/rbac[\\/]recursos\.js$|permissao-usuario\.service\.js$/.test(a)).some((a) => fs.readFileSync(a, 'utf8').includes(codigo));

  test('cada ação exibida é usada no backend; nenhuma ação do catálogo usada no backend ficou de fora da lista; as sem uso não são oferecidas', () => {
    assert.ok(doCatalogo.size >= 9, 'leu o catálogo das migrations');
    for (const codigo of ACOES_COM_EFEITO) assert.ok(doCatalogo.has(codigo) && usadoNoCodigo(codigo), `${codigo}: sem uso real`);
    const faltando = [...doCatalogo].filter((c) => usadoNoCodigo(c) && !ACOES_COM_EFEITO.includes(c));
    assert.deepEqual(faltando, [], 'ação aplicada pelo backend mas fora da lista da tela');
    const semUso = [...doCatalogo].filter((c) => !usadoNoCodigo(c));
    assert.ok(semUso.length > 0 && semUso.every((c) => !ACOES_COM_EFEITO.includes(c)), `sem uso, fora da tela: ${semUso}`);
  });
});
