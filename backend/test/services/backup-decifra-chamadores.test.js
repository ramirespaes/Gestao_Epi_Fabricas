'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * R-D45 [B2]: BLOQUEIO ESTÁTICO DOS CHAMADORES DA DECIFRAGEM (condição B2 da aprovação das entradas 47/F1 e 48/G). `decifrarContainer` mantém a contenção OPCIONAL no módulo (compatibilidade
 * com os testes e com o ensaio de DR); este teste impede que um chamador FUTURO de restauração a use sem a contenção:
 *  1. em código de PRODUÇÃO (tudo no backend fora de `test/` e de `node_modules`), só o orquestrador pode citar `decifrarContainer`, com UMA importação e UMA chamada;
 *  2. a chamada do orquestrador tem de levar `contencao` (variável construída por `criarContencaoDeDestino`, sem espalhamento nem valor vazio);
 *  3. nenhum arquivo de `scripts/` pode importar o módulo da cifra (o ponto de entrada operacional usa só o orquestrador);
 *  4. os usos de TESTE são enumerados (`TESTES_AUTORIZADOS`): continuam permitidos sem contenção, mas um teste novo que cite a decifra precisa ser incluído de propósito na lista.
 * É validação LÉXICA (comentários removidos; texto de strings e identificadores preservados). Não detecta nome montado dinamicamente nem regex que esconda `//`; revisão de código continua necessária.
 * A análise é uma função pura: o teste a aplica à árvore real e a árvores sintéticas (controles negativos e mutações do orquestrador real, em memória).
 */

const BACKEND = path.join(__dirname, '..', '..');
const MODULO_DA_CIFRA = 'src/services/backup-fontes-cifra-envelope.service.js';
const ORQUESTRADOR = 'src/services/backup-restauracao-duravel.service.js';
const TESTES_AUTORIZADOS = Object.freeze([
  'test/services/backup-fontes-cifra-envelope.test.js',
  'test/services/backup-fontes-kms-pre-resolvido.test.js',
  'test/services/backup-fontes-recuperacao-offline.test.js',
  'test/services/backup-contencao-destino.test.js',
  'test/services/backup-decifra-chamadores.test.js',
  'test/integracao/d-orf-6-p12-ensaio-dr.integration.js',
]);
const IGNORADOS = new Set(['node_modules', 'coverage', '.git']);
const EXTENSOES = /\.(?:js|cjs|mjs)$/;
const NOME = 'decifrarContainer';
const IDENTIFICADOR = new RegExp(`\\b${NOME}\\b`, 'g');

/** Remove comentários preservando quebras de linha e o conteúdo de strings (aspas simples, duplas e crase). */
function semComentarios(codigo) {
  let saida = '';
  let i = 0;
  let aspa = null;
  while (i < codigo.length) {
    const c = codigo[i];
    const d = codigo[i + 1];
    if (aspa !== null) {
      saida += c;
      if (c === '\\' && i + 1 < codigo.length) { saida += d; i += 2; continue; }
      if (c === aspa) aspa = null;
      i += 1;
      continue;
    }
    if (c === '/' && d === '/') { while (i < codigo.length && codigo[i] !== '\n') { saida += ' '; i += 1; } continue; }
    if (c === '/' && d === '*') {
      saida += '  ';
      i += 2;
      while (i < codigo.length && !(codigo[i] === '*' && codigo[i + 1] === '/')) { saida += codigo[i] === '\n' ? '\n' : ' '; i += 1; }
      if (i < codigo.length) { saida += '  '; i += 2; }
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') aspa = c;
    saida += c;
    i += 1;
  }
  return saida;
}

const linhaDe = (texto, indice) => texto.slice(0, indice).split('\n').length;

/** Texto entre o parêntese que abre em `abre` e o que o fecha (aspas respeitadas), ou `null`. */
function argumentosDaChamada(texto, abre) {
  let nivel = 0;
  let aspa = null;
  for (let i = abre; i < texto.length; i += 1) {
    const c = texto[i];
    if (aspa !== null) { if (c === '\\') i += 1; else if (c === aspa) aspa = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { aspa = c; continue; }
    if (c === '(') nivel += 1;
    else if (c === ')') { nivel -= 1; if (nivel === 0) return texto.slice(abre + 1, i); }
  }
  return null;
}

/** `arquivos`: Map de caminho relativo ao backend (POSIX) para o texto. Devolve a lista de violações `{ codigo, arquivo, linha }`. */
function analisarChamadores(arquivos, autorizados = TESTES_AUTORIZADOS) {
  const violacoes = [];
  const relatar = (codigo, arquivo, linha = null) => violacoes.push({ codigo, arquivo, linha });
  for (const [arquivo, conteudo] of arquivos) {
    if (arquivo === MODULO_DA_CIFRA) continue;
    const texto = semComentarios(conteudo);
    const achados = [...texto.matchAll(IDENTIFICADOR)].map((m) => ({ indice: m.index, linha: linhaDe(texto, m.index) }));
    if (arquivo.startsWith('scripts/') && /backup-fontes-cifra-envelope/.test(texto)) relatar('SCRIPT_IMPORTA_A_CIFRA', arquivo);
    if (achados.length === 0) continue;
    if (arquivo.startsWith('test/')) {
      if (!autorizados.includes(arquivo)) for (const a of achados) relatar('TESTE_NAO_AUTORIZADO_USA_A_DECIFRA', arquivo, a.linha);
      continue;
    }
    if (arquivo !== ORQUESTRADOR) { for (const a of achados) relatar('CHAMADOR_DE_PRODUCAO_NAO_AUTORIZADO', arquivo, a.linha); continue; }
    const chamadas = achados.filter((a) => /^\s*\(/.test(texto.slice(a.indice + NOME.length)));
    const referencias = achados.filter((a) => !chamadas.includes(a));
    if (chamadas.length !== 1) relatar('NUMERO_DE_CHAMADAS_DIFERENTE_DE_UMA', arquivo);
    if (referencias.length !== 1 || !/const\s*\{[^}]*\bdecifrarContainer\b[^}]*\}\s*=\s*require\(\s*'\.\/backup-fontes-cifra-envelope\.service'\s*\)/.test(texto)) relatar('REFERENCIA_FORA_DA_IMPORTACAO_E_DA_CHAMADA', arquivo);
    for (const chamada of chamadas) {
      const abre = texto.indexOf('(', chamada.indice + NOME.length);
      const args = argumentosDaChamada(texto, abre);
      const semContencao = args === null || !/\bcontencao\b/.test(args) || /\.\.\./.test(args) || /\bcontencao\s*:\s*(?:undefined|null|false|0|''|"")/.test(args);
      if (semContencao) relatar('CHAMADA_SEM_CONTENCAO', arquivo, chamada.linha);
    }
    if (!/\bcontencao\s*=\s*criarContencaoDeDestino\(/.test(texto) || !/require\(\s*'\.\/backup-contencao-destino\.service'\s*\)/.test(texto)) relatar('CONTENCAO_NAO_CONSTRUIDA_PELO_VALIDADOR_OFICIAL', arquivo);
  }
  for (const t of autorizados) {
    const conteudo = arquivos.get(t);
    if (conteudo === undefined || !new RegExp(`\\b${NOME}\\b`).test(semComentarios(conteudo))) relatar('AUTORIZACAO_DE_TESTE_OBSOLETA', t);
  }
  return violacoes;
}

function lerArvore() {
  const mapa = new Map();
  const andar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (IGNORADOS.has(e.name) || e.isSymbolicLink()) continue;
      const completo = path.join(dir, e.name);
      if (e.isDirectory()) andar(completo);
      else if (EXTENSOES.test(e.name)) mapa.set(path.relative(BACKEND, completo).split(path.sep).join('/'), fs.readFileSync(completo, 'utf8'));
    }
  };
  andar(BACKEND);
  return mapa;
}
const codigos = (v) => v.map((x) => x.codigo);
const so = (arquivos) => new Map(Object.entries(arquivos));
const REQUIRE_CIFRA = "const { decifrarContainer } = require('./backup-fontes-cifra-envelope.service');";

describe('[B2] chamadores da decifragem na ÁRVORE REAL', () => {
  test('B2-01 — árvore real sem violação: só o orquestrador chama a decifra em produção, uma vez, com a contenção; nenhum script importa a cifra; os usos de teste estão todos enumerados', () => {
    const arvore = lerArvore();
    assert.ok(arvore.size >= 500, `arquivos varridos=${arvore.size}`);
    assert.ok(arvore.has(MODULO_DA_CIFRA) && arvore.has(ORQUESTRADOR), 'módulo da cifra e orquestrador encontrados');
    assert.deepEqual(analisarChamadores(arvore), []);
  });

  test('B2-02 — a varredura é de verdade: o orquestrador real tem exatamente uma importação e uma chamada com `contencao` construída pelo validador oficial; o módulo da cifra continua definindo a opção', () => {
    const orq = semComentarios(fs.readFileSync(path.join(BACKEND, ORQUESTRADOR), 'utf8'));
    assert.equal([...orq.matchAll(IDENTIFICADOR)].length, 2);
    assert.match(orq, /decifrarContainer\(\{[^}]*\bcontencao\b[^}]*\}\)/);
    assert.match(orq, /contencao = criarContencaoDeDestino\(/);
    const cifra = fs.readFileSync(path.join(BACKEND, MODULO_DA_CIFRA), 'utf8');
    assert.match(cifra, /const contencaoValida = /);
    assert.match(cifra, /await conter\(contencao, path\.dirname\(caminhoFinal\)\)/);
  });
});

describe('[B2] controles negativos sintéticos (a regra reprova o que deve reprovar)', () => {
  const base = () => new Map([[MODULO_DA_CIFRA, 'async function decifrarContainer() {}\nmodule.exports = { decifrarContainer };'], ...TESTES_AUTORIZADOS.map((t) => [t, `// ${NOME}\nconst x = decifrarContainer({});`])]);
  const com = (extra) => { const m = base(); for (const [k, v] of Object.entries(extra)) m.set(k, v); return m; };

  test('B2-03 — chamador de produção novo é reprovado MESMO levando `contencao`; propriedade, colchetes e alias também', () => {
    const casos = {
      'src/services/novo-restaurador.service.js': `${REQUIRE_CIFRA}\nawait decifrarContainer({ container, destino, cifra, mac, contencao });`,
      'src/services/outro.service.js': "const E = require('./backup-fontes-cifra-envelope.service');\nawait E.decifrarContainer({ contencao });",
      'src/services/colchetes.service.js': "const f = E['decifrarContainer'];",
      'src/routes/rota.js': 'const alias = decifrarContainer;',
    };
    for (const [arquivo, codigo] of Object.entries(casos)) assert.ok(codigos(analisarChamadores(com({ [arquivo]: codigo }))).includes('CHAMADOR_DE_PRODUCAO_NAO_AUTORIZADO'), arquivo);
  });

  test('B2-04 — script que importa o módulo da cifra é reprovado, com ou sem chamada; o que o script usa é o orquestrador', () => {
    assert.deepEqual(codigos(analisarChamadores(com({ 'scripts/restaurar.js': "const cifra = require('../src/services/backup-fontes-cifra-envelope.service');" }))), ['SCRIPT_IMPORTA_A_CIFRA']);
    const dois = codigos(analisarChamadores(com({ 'scripts/restaurar.js': `${REQUIRE_CIFRA.replace("'./", "'../src/services/")}\nawait decifrarContainer({});` })));
    assert.deepEqual([...dois].sort(), ['CHAMADOR_DE_PRODUCAO_NAO_AUTORIZADO', 'CHAMADOR_DE_PRODUCAO_NAO_AUTORIZADO', 'SCRIPT_IMPORTA_A_CIFRA'], 'uma violação por ocorrência do identificador (importação e chamada) mais a do import da cifra');
    assert.deepEqual(analisarChamadores(com({ 'scripts/restaurar.js': "const { restaurarContainerDoDestinoDuravel } = require('../src/services/backup-restauracao-duravel.service');" })).filter((v) => v.arquivo === 'scripts/restaurar.js'), []);
  });

  test('B2-05 — usos de teste: os enumerados continuam permitidos SEM contenção; um teste novo que cite a decifra é reprovado até entrar na lista; autorização de teste que perdeu o uso é obsoleta', () => {
    assert.deepEqual(analisarChamadores(base()), [], 'os seis usos de teste autorizados, sem contenção, não geram violação');
    const novo = analisarChamadores(com({ 'test/services/novo.test.js': 'await E.decifrarContainer({ container, destino });' }));
    assert.deepEqual(novo.map((v) => [v.codigo, v.arquivo]), [['TESTE_NAO_AUTORIZADO_USA_A_DECIFRA', 'test/services/novo.test.js']]);
    assert.deepEqual(codigos(analisarChamadores(com({ 'test/services/novo.test.js': 'await E.decifrarContainer({});' }), [...TESTES_AUTORIZADOS, 'test/services/novo.test.js'])), []);
    const obsoleta = base();
    obsoleta.set('test/services/backup-contencao-destino.test.js', 'sem uso algum');
    assert.deepEqual(analisarChamadores(obsoleta).map((v) => [v.codigo, v.arquivo]), [['AUTORIZACAO_DE_TESTE_OBSOLETA', 'test/services/backup-contencao-destino.test.js']]);
    const ausente = base();
    ausente.delete('test/integracao/d-orf-6-p12-ensaio-dr.integration.js');
    assert.deepEqual(analisarChamadores(ausente).map((v) => v.codigo), ['AUTORIZACAO_DE_TESTE_OBSOLETA']);
  });

  test('B2-06 — comentário não conta; texto de string antes da chamada não a esconde; `//` dentro de string não apaga o resto da linha; número de linha é preservado', () => {
    assert.deepEqual(analisarChamadores(com({ 'src/services/doc.service.js': `// ${NOME}\n/* ${NOME}\n */\nconst ok = 1;` })), []);
    const escondida = analisarChamadores(com({ 'src/services/esc.service.js': `const u = 'http://x'; await ${NOME}({});` }));
    assert.deepEqual(escondida.map((v) => [v.codigo, v.linha]), [['CHAMADOR_DE_PRODUCAO_NAO_AUTORIZADO', 1]]);
    const linha3 = analisarChamadores(com({ 'src/services/l.service.js': `/* a\n b */\nawait ${NOME}({});` }));
    assert.equal(linha3[0].linha, 3);
    assert.equal(semComentarios('a // b\nc /* d\ne */ f').split('\n').length, 3);
  });
});

describe('[B2] mutações em memória do orquestrador real (a chamada sem contenção é reprovada)', () => {
  const real = () => fs.readFileSync(path.join(BACKEND, ORQUESTRADOR), 'utf8');
  const com = (texto) => { const m = lerArvore(); m.set(ORQUESTRADOR, texto); return m; };
  const mutar = (de, para) => { const t = real(); assert.ok(t.includes(de), `trecho a mutar presente: ${de}`); return t.replace(de, para); };

  test('B2-07 — controle: o orquestrador real passa; cada mutação que enfraquece a contenção da chamada é reprovada com o código certo', () => {
    assert.deepEqual(analisarChamadores(com(real())), []);
    const casos = [
      ['sem a chave na chamada', mutar('cifra, mac, contencao });', 'cifra, mac });'), 'CHAMADA_SEM_CONTENCAO'],
      ['contencao: undefined', mutar('cifra, mac, contencao });', 'cifra, mac, contencao: undefined });'), 'CHAMADA_SEM_CONTENCAO'],
      ['contencao: null', mutar('cifra, mac, contencao });', 'cifra, mac, contencao: null });'), 'CHAMADA_SEM_CONTENCAO'],
      ['espalhamento na chamada', mutar('cifra, mac, contencao });', 'cifra, mac, contencao, ...entrada });'), 'CHAMADA_SEM_CONTENCAO'],
      ['segunda chamada sem contenção', `${real()}\nasync function outra(x) { return decifrarContainer({ container: x }); }`, 'NUMERO_DE_CHAMADAS_DIFERENTE_DE_UMA'],
      ['alias da função', `${real()}\nconst atalho = decifrarContainer;`, 'REFERENCIA_FORA_DA_IMPORTACAO_E_DA_CHAMADA'],
      ['contenção não construída pelo validador oficial', mutar('contencao = criarContencaoDeDestino(', 'contencao = fabricar('), 'CONTENCAO_NAO_CONSTRUIDA_PELO_VALIDADOR_OFICIAL'],
      ['sem importar a guarda oficial', mutar("require('./backup-contencao-destino.service')", "require('./outra-guarda.service')"), 'CONTENCAO_NAO_CONSTRUIDA_PELO_VALIDADOR_OFICIAL'],
    ];
    for (const [nome, texto, esperado] of casos) assert.ok(codigos(analisarChamadores(com(texto))).includes(esperado), `${nome}: ${esperado}`);
  });
});
