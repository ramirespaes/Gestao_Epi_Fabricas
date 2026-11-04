'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-PLANO-IMAGENS-1): CONTRATO DO PLANO DE ARQUIVOS do backup. Só unitário e em memória: registros fictícios
 * determinísticos, nenhum disco, PostgreSQL, imagem real ou processo. O planejador é uma função PURA; a cópia verificada e o manifesto têm RED próprio, depois.
 *
 * CONTRATO REAL CONFIRMADO (lido no código, com evidências):
 *   A. REGISTROS: o snapshot entrega ao `planejar` `Object.freeze({ padrao, empresa })`, listas de linhas COMO O REPOSITÓRIO as mapeia (camelCase):
 *        padrao  = { id, sha256, sha256Miniatura, sha256Exibicao | null, formato, bytesMestre, bytesMiniatura, bytesExibicao | null }
 *        empresa = { id, empresaId, sha256, sha256Mestre, sha256Exibicao, sha256Miniatura, formato, bytesMestre, bytesExibicao, bytesMiniatura }
 *      O `planejar` é síncrono; se lançar, a abertura do snapshot falha com PLANO_INVALIDO (falha fechada). Variantes e chaves: `chaveDe({ escopo, empresaId, sha256, variante,
 *      formato })` -> "<empresaId|padrao>/<sha256 do registro>/<mestre.(png|jpg|webp)|exibicao.webp|miniatura.webp>". A MESTRE sempre existe (extensão pelo `formato`);
 *      na biblioteca PADRÃO a EXIBIÇÃO é opcional (hash e bytes nulos juntos = não gerada) e a MINIATURA é obrigatória; na biblioteca da EMPRESA as três variantes são obrigatórias
 *      (colunas NOT NULL). É exatamente o cruzamento que `imagem-armazenamento-verificacao.service` já faz em `planejarPadrao`/`planejarEmpresa` (hoje internos, não exportados).
 *   B. HASHES: existem e são declarados pelo banco, em colunas CHAR(64) com CHECK de hexadecimal minúsculo. O SHA-256 do CONTEÚDO de cada variante é: PADRÃO, mestre = `sha256`
 *      (também o diretório), exibição = `sha256Exibicao`, miniatura = `sha256Miniatura`; EMPRESA, mestre = `sha256Mestre`, exibição = `sha256Exibicao`, miniatura = `sha256Miniatura`.
 *      Na empresa o `sha256` NÃO é o hash do conteúdo da mestre: é o hash que compõe o diretório da chave (deduplicação por empresa + sha256). Os hashes são DECLARAÇÕES do banco: a
 *      cópia futura precisa recalculá-los dos bytes (este plano não prova conteúdo algum).
 *   C. TRAVA: ver os TODO PLN-11 (resumo: só a LIMPEZA de órfãos e o BACKUP usam a trava; envio, importação do padrão e `completar-exibicao` NÃO a usam; a escrita é só aditiva e
 *      nunca sobrescreve; a exclusão remove só a linha; o snapshot do PostgreSQL NÃO protege o filesystem).
 *   D. AVALIAÇÃO: o snapshot guarda `plano` = lista congelada de `{ chave, sha256 }` (só esses dois campos, `chave` não vazia sem controle, `sha256` com 64 hex minúsculos);
 *      `avaliarConjunto` recebe `listaDoSnapshot` com o MESMO formato, confere contra `manifesto.arquivos` e RECUSA a lista com chave repetida (LISTA_DO_SNAPSHOT_INVALIDA).
 *
 * INTERFACE PROPOSTA (provisória; nomes ainda NÃO aprovados; nada de produção foi alterado): src/services/imagem-backup-plano.service.js exporta
 * `planejarArquivos({ padrao, empresa })` -> [{ chave, sha256 }] (e mais nada nos itens), PURA, síncrona, determinística:
 *   - um item por arquivo esperado de cada registro, na ORDEM CRESCENTE de `chave` (comparação de texto simples), independente da ordem de entrada;
 *   - registro inconsistente, chave repetida (mesmo com hash idêntico) ou entrada fora do formato LANÇA um Error de código fixo PLANO_INVALIDO, sem eco de valores e
 *     sem resultado parcial (falha fechada, como o snapshot espera); nunca "pula" um registro;
 *   - compatível com `criarSnapshot({ planejar: planejarArquivos })` e com `avaliarConjunto` sem formato alternativo.
 * MUDANÇA MÍNIMA DE PRODUÇÃO NO GREEN FUTURO: um módulo novo; o ideal é reaproveitar os dois planejadores do verificador (extraí-los/exportá-los) em vez de duplicar a regra.
 *
 * COMO LER: o módulo NÃO existe; as falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje e fixam as peças reais.
 */

const MODULO = 'src/services/imagem-backup-plano.service';
const plano = () => exigirModulo(MODULO);
const planejar = (registros) => plano().planejarArquivos(registros);
const H = (c) => c.repeat(64);
const PRAZO_DO_TESTE = 10000;
const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);
const congelar = (v) => { if (v !== null && typeof v === 'object') for (const x of Object.values(v)) congelar(x); return Object.freeze(v); };

const padrao = (sobrescrever = {}) => ({
  id: '1', sha256: H('a'), sha256Miniatura: H('b'), sha256Exibicao: H('c'), formato: 'PNG', bytesMestre: 100, bytesMiniatura: 10, bytesExibicao: 50, ...sobrescrever,
});
const empresa = (sobrescrever = {}) => ({
  id: '5', empresaId: 7, sha256: H('d'), sha256Mestre: H('e'), sha256Exibicao: H('f'), sha256Miniatura: H('1'), formato: 'PNG', bytesMestre: 100, bytesExibicao: 50, bytesMiniatura: 10, ...sobrescrever,
});
const registros = (p = [], e = []) => ({ padrao: p, empresa: e });

const ESPERADO_PADRAO = (sha = H('a')) => [
  { chave: `padrao/${sha}/exibicao.webp`, sha256: H('c') },
  { chave: `padrao/${sha}/mestre.png`, sha256: sha },
  { chave: `padrao/${sha}/miniatura.webp`, sha256: H('b') },
];
const ESPERADO_EMPRESA = [
  { chave: `7/${H('d')}/exibicao.webp`, sha256: H('f') },
  { chave: `7/${H('d')}/mestre.png`, sha256: H('e') },
  { chave: `7/${H('d')}/miniatura.webp`, sha256: H('1') },
];
const emOrdem = (itens) => [...itens].sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0));

function semEco(erro, valores) {
  const texto = `${erro.message} ${String(erro)} ${JSON.stringify(erro)}`;
  for (const v of valores) {
    if (String(v) === '') continue; // `includes('')` é sempre verdadeiro: o texto vazio não tem o que ecoar; todo valor NÃO vazio continua verificado
    assert.equal(texto.includes(String(v)), false, `a rejeição não pode ecoar "${String(v)}"`);
  }
}

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: as peças reais com as quais o plano precisa ser compatível', () => {
  teste('CTL-01 — as chaves esperadas dos testes são EXATAMENTE as de `chaveDe` real (padrão e empresa, mestre PNG/JPEG/WEBP, exibição e miniatura)', () => {
    const { chaveDe } = exigirModulo('src/storage/armazenamento-imagens');
    assert.equal(chaveDe({ escopo: 'PADRAO', sha256: H('a'), variante: 'mestre', formato: 'PNG' }), `padrao/${H('a')}/mestre.png`);
    assert.equal(chaveDe({ escopo: 'PADRAO', sha256: H('a'), variante: 'exibicao', formato: 'WEBP' }), `padrao/${H('a')}/exibicao.webp`);
    assert.equal(chaveDe({ escopo: 'PADRAO', sha256: H('a'), variante: 'miniatura', formato: 'WEBP' }), `padrao/${H('a')}/miniatura.webp`);
    assert.equal(chaveDe({ escopo: 'EMPRESA', empresaId: 7, sha256: H('d'), variante: 'mestre', formato: 'JPEG' }), `7/${H('d')}/mestre.jpg`);
    assert.equal(chaveDe({ escopo: 'EMPRESA', empresaId: 7, sha256: H('d'), variante: 'mestre', formato: 'WEBP' }), `7/${H('d')}/mestre.webp`);
  });

  teste('CTL-02 — `avaliarConjunto` real aceita uma lista no formato {chave, sha256} e RECUSA chave repetida (LISTA_DO_SNAPSHOT_INVALIDA): por isso o plano nunca pode repetir chave', () => {
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const lista = ESPERADO_PADRAO();
    const entrada = (listaDoSnapshot, manifestoArquivos) => ({
      saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: { arquivos: manifestoArquivos }, listaDoSnapshot, verificacao: { concluida: true, ok: true },
      dump: { concluido: true, bytes: 10, sha256Declarado: H('7'), sha256Recalculado: H('7') }, identidade: { conjuntoId: 'conjunto-1', sha256Manifesto: H('9') },
    });
    assert.equal(avaliarConjunto(entrada(lista, lista)).valido, true);
    const repetida = avaliarConjunto(entrada([...lista, lista[0]], lista));
    assert.equal(repetida.valido, false);
    assert.ok(repetida.motivos.includes('LISTA_DO_SNAPSHOT_INVALIDA'));
  });

  teste('CTL-03 — o snapshot real guarda o `plano` do `planejar` como lista congelada de {chave, sha256} e descarta qualquer outro campo do item', async () => {
    const { criarSnapshot } = exigirModulo('src/services/imagem-backup-snapshot.service');
    const cliente = clienteFalso({ padrao: [], empresa: [] });
    const instancia = criarSnapshot({
      criarConexao: () => cliente, temporizador: temporizadorFalso(), prazos: { finalizacaoMs: 5000 },
      planejar: () => [{ chave: `padrao/${H('a')}/mestre.png`, sha256: H('a'), extra: 'descartado' }],
    });
    const r = await instancia.abrir();
    assert.equal(r.ok, true);
    assert.deepEqual(r.contexto.plano, [{ chave: `padrao/${H('a')}/mestre.png`, sha256: H('a') }]);
    assert.equal(Object.isFrozen(r.contexto.plano), true);
    assert.equal((await instancia.finalizar()).concluida, true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-01
describe('[PLN-01] plano determinístico a partir dos registros reais do snapshot', () => {
  teste('PLN-01 — padrão com exibição: três itens {chave, sha256}, só esses dois campos, na ordem das chaves', () => {
    const r = planejar(registros([padrao()]));
    assert.deepEqual(r, ESPERADO_PADRAO());
    for (const item of r) assert.deepEqual(Object.keys(item).sort(), ['chave', 'sha256']);
  });

  teste('PLN-01b — empresa: três itens, a mestre com o hash do CONTEÚDO (`sha256Mestre`), não com o `sha256` do diretório', () => {
    assert.deepEqual(planejar(registros([], [empresa()])), ESPERADO_EMPRESA);
  });

  teste('PLN-01c — DETERMINÍSTICO e PURO: duas chamadas dão o mesmo resultado, a entrada (inclusive congelada em profundidade, como o snapshot entrega) nunca é alterada, e o resultado é uma lista nova de objetos simples', () => {
    const entrada = congelar(registros([padrao(), padrao({ id: '2', sha256: H('9'), sha256Exibicao: null, bytesExibicao: null })], [empresa()]));
    const copia = JSON.parse(JSON.stringify(entrada));
    const a = planejar(entrada);
    const b = planejar(entrada);
    assert.deepEqual(a, b);
    assert.notEqual(a, b);
    assert.deepEqual(JSON.parse(JSON.stringify(entrada)), copia);
    assert.equal(Array.isArray(a), true);
    for (const item of a) assert.equal(Object.getPrototypeOf(item), Object.prototype);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-02
describe('[PLN-02] ordenação estável', () => {
  teste('PLN-02 — o resultado é independente da ordem de entrada (registros e listas embaralhados) e fica em ordem crescente de `chave`', () => {
    const p1 = padrao({ id: '1', sha256: H('a') });
    const p2 = padrao({ id: '2', sha256: H('3'), sha256Miniatura: H('4'), sha256Exibicao: H('5') });
    const e1 = empresa({ id: '5', empresaId: 7 });
    const e2 = empresa({ id: '6', empresaId: 12, sha256: H('2') });
    const a = planejar(registros([p1, p2], [e1, e2]));
    const b = planejar(registros([p2, p1], [e2, e1]));
    assert.deepEqual(a, b);
    assert.deepEqual(a, emOrdem(a));
    assert.equal(a.length, 12);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-03
describe('[PLN-03] variantes existentes e opcionais, sem presumir que todas existem', () => {
  teste('PLN-03 — padrão SEM exibição (hash e bytes nulos): só mestre e miniatura; nenhum item de exibição é inventado', () => {
    const r = planejar(registros([padrao({ sha256Exibicao: null, bytesExibicao: null })]));
    assert.deepEqual(r, ESPERADO_PADRAO().filter((i) => !i.chave.endsWith('exibicao.webp')));
    assert.equal(r.length, 2);
  });

  teste('PLN-03b — a extensão da mestre segue o `formato` (PNG, JPEG, WEBP) e a exibição e a miniatura são sempre `.webp`', () => {
    for (const [formato, extensao] of [['PNG', 'png'], ['JPEG', 'jpg'], ['WEBP', 'webp']]) {
      const r = planejar(registros([padrao({ formato })], [empresa({ formato })]));
      assert.ok(r.some((i) => i.chave === `padrao/${H('a')}/mestre.${extensao}`), `padrão ${formato}`);
      assert.ok(r.some((i) => i.chave === `7/${H('d')}/mestre.${extensao}`), `empresa ${formato}`);
      assert.equal(r.filter((i) => /\/(exibicao|miniatura)\.webp$/.test(i.chave)).length, 4, 'padrão com exibição (2) + empresa (2)');
    }
  });

  teste('PLN-03c — na empresa as TRÊS variantes são obrigatórias: nenhuma é opcional', () => {
    assert.equal(planejar(registros([], [empresa()])).length, 3);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-04
describe('[PLN-04] associação correta entre chave e hash disponível', () => {
  teste('PLN-04 — cada variante usa o seu próprio hash: nenhum hash é trocado entre variantes, nem entre `sha256` (diretório) e `sha256Mestre` (conteúdo) da empresa', () => {
    const r = planejar(registros([padrao({ sha256: H('a'), sha256Miniatura: H('b'), sha256Exibicao: H('c') })], [empresa({ sha256: H('d'), sha256Mestre: H('e'), sha256Exibicao: H('f'), sha256Miniatura: H('1') })]));
    const por = Object.fromEntries(r.map((i) => [i.chave, i.sha256]));
    assert.equal(por[`padrao/${H('a')}/mestre.png`], H('a'));
    assert.equal(por[`padrao/${H('a')}/exibicao.webp`], H('c'));
    assert.equal(por[`padrao/${H('a')}/miniatura.webp`], H('b'));
    assert.equal(por[`7/${H('d')}/mestre.png`], H('e'));
    assert.equal(por[`7/${H('d')}/exibicao.webp`], H('f'));
    assert.equal(por[`7/${H('d')}/miniatura.webp`], H('1'));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-05 / 06
describe('[PLN-05/06] isolamento entre empresas, repetidos e colisões de chave', () => {
  teste('PLN-05 — duas empresas com o MESMO `sha256` (deduplicação é por empresa) geram chaves DISTINTAS pelo prefixo da empresa; padrão e empresa com o mesmo hash também; nada colide', () => {
    const r = planejar(registros([padrao({ sha256: H('d') })], [empresa({ id: '5', empresaId: 7 }), empresa({ id: '6', empresaId: 8 })]));
    const chaves = r.map((i) => i.chave);
    assert.equal(new Set(chaves).size, chaves.length);
    assert.ok(chaves.some((c) => c.startsWith(`7/${H('d')}/`)));
    assert.ok(chaves.some((c) => c.startsWith(`8/${H('d')}/`)));
    assert.ok(chaves.some((c) => c.startsWith(`padrao/${H('d')}/`)));
    assert.equal(r.length, 9);
  });

  teste('PLN-05b — nenhuma chave de uma empresa é produzida a partir do registro de outra: o prefixo é sempre o `empresaId` do próprio registro', () => {
    const r = planejar(registros([], [empresa({ empresaId: 7, sha256: H('d') }), empresa({ id: '6', empresaId: 12, sha256: H('2') })]));
    for (const item of r) {
      const [prefixo, hash] = item.chave.split('/');
      assert.ok((prefixo === '7' && hash === H('d')) || (prefixo === '12' && hash === H('2')), item.chave);
    }
  });

  const colisoes = [
    ['o MESMO registro repetido (padrão)', () => registros([padrao(), padrao()])],
    ['o MESMO registro repetido (empresa)', () => registros([], [empresa(), empresa()])],
    ['dois registros padrão com o mesmo `sha256` (viola a unicidade do banco)', () => registros([padrao({ id: '1' }), padrao({ id: '2' })])],
    ['duas imagens da MESMA empresa com o mesmo `sha256` (viola a deduplicação)', () => registros([], [empresa({ id: '5' }), empresa({ id: '6' })])],
    ['mesma chave com hash de conteúdo DIFERENTE', () => registros([padrao({ id: '1' }), padrao({ id: '2', sha256Exibicao: H('9') })])],
  ];
  for (const [rotulo, montar] of colisoes) {
    teste(`PLN-06 (${rotulo}) — chave repetida REJEITA o plano inteiro (PLANO_INVALIDO), mesmo com hashes idênticos, porque o avaliador recusaria a lista`, () => {
      assert.throws(() => planejar(montar()), (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); return true; });
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-07
describe('[PLN-07] chaves inválidas e travessia de diretórios: nada fora do formato vira chave', () => {
  const hashesRuins = [
    ['maiúsculas', 'A'.repeat(64)], ['curto', 'a'.repeat(63)], ['longo', 'a'.repeat(65)], ['com travessia', `../${'a'.repeat(61)}`], ['com barra', `${'a'.repeat(30)}/${'a'.repeat(33)}`],
    ['com quebra de linha', `${'a'.repeat(63)}\n`], ['com NUL', `${'a'.repeat(63)}\0`], ['não hexadecimal', 'g'.repeat(64)], ['vazio', ''], ['número', 12345], ['nulo', null],
  ];
  for (const [rotulo, valor] of hashesRuins) {
    teste(`PLN-07 (sha256 do registro ${rotulo}) — PLANO_INVALIDO, sem eco do valor e sem resultado parcial`, () => {
      assert.throws(() => planejar(registros([padrao({ id: '3' }), padrao({ id: '4', sha256: valor })])), (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); semEco(erro, [String(valor)]); return true; });
    });
  }

  for (const [rotulo, formato] of [['GIF', 'GIF'], ['minúsculas', 'png'], ['vazio', ''], ['com travessia', '../png'], ['nulo', null], ['número', 1]]) {
    teste(`PLN-07b (formato ${rotulo}) — PLANO_INVALIDO (a extensão nunca vem de texto livre)`, () => {
      assert.throws(() => planejar(registros([padrao({ formato })])), (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); return true; });
      assert.throws(() => planejar(registros([], [empresa({ formato })])), (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); return true; });
    });
  }

  for (const [rotulo, empresaId] of [['zero', 0], ['negativo', -1], ['fracionário', 1.5], ['texto', '7'], ['com travessia', '7/../8'], ['nulo', null], ['undefined', undefined], ['acima do máximo', 1000000000000000], ['NaN', Number.NaN]]) {
    teste(`PLN-07c (empresaId ${rotulo}) — PLANO_INVALIDO: o prefixo da empresa só vem de um inteiro seguro positivo`, () => {
      assert.throws(() => planejar(registros([], [empresa({ empresaId })])), (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); semEco(erro, [String(empresaId)]); return true; });
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-08
describe('[PLN-08] SHA-256 e bytes ausentes ou inválidos quando obrigatórios: a validação de integridade não é enfraquecida', () => {
  const padraoRuim = [
    ['miniatura nula', { sha256Miniatura: null }], ['miniatura ausente', { sha256Miniatura: undefined }], ['miniatura em maiúsculas', { sha256Miniatura: 'B'.repeat(64) }],
    ['exibição presente e inválida', { sha256Exibicao: 'zz' }], ['exibição com hash e SEM bytes', { bytesExibicao: null }], ['exibição SEM hash e com bytes', { sha256Exibicao: null }],
    ['bytes da mestre zero', { bytesMestre: 0 }], ['bytes da mestre nulos', { bytesMestre: null }], ['bytes da miniatura negativos', { bytesMiniatura: -1 }],
    ['bytes da mestre acima do inteiro de 32 bits', { bytesMestre: 2147483648 }], ['bytes da mestre fracionários', { bytesMestre: 1.5 }],
  ];
  for (const [rotulo, sobrescrever] of padraoRuim) {
    teste(`PLN-08 (padrão: ${rotulo}) — PLANO_INVALIDO`, () => {
      assert.throws(() => planejar(registros([padrao(sobrescrever)])), (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); return true; });
    });
  }

  const empresaRuim = [
    ['mestre nula', { sha256Mestre: null }], ['exibição nula', { sha256Exibicao: null }], ['miniatura nula', { sha256Miniatura: null }], ['mestre inválida', { sha256Mestre: 'e'.repeat(63) }],
    ['bytes da exibição nulos', { bytesExibicao: null }], ['bytes da miniatura zero', { bytesMiniatura: 0 }],
  ];
  for (const [rotulo, sobrescrever] of empresaRuim) {
    teste(`PLN-08b (empresa: ${rotulo}) — PLANO_INVALIDO (as três variantes e seus bytes são obrigatórios)`, () => {
      assert.throws(() => planejar(registros([], [empresa(sobrescrever)])), (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); return true; });
    });
  }

  teste('PLN-08c — um único registro inválido derruba o plano INTEIRO: nenhum resultado parcial dos registros bons (falha fechada)', () => {
    let resultado;
    assert.throws(() => { resultado = planejar(registros([padrao({ id: '1' }), padrao({ id: '2', sha256: H('9'), sha256Miniatura: null })], [empresa()])); }, (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); return true; });
    assert.equal(resultado, undefined);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-09
describe('[PLN-09] registros vazios, ausência legítima de imagens e entradas fora do formato', () => {
  teste('PLN-09 — sem nenhuma imagem: lista vazia (ausência legítima, não é erro); aceita as listas congeladas que o snapshot entrega', () => {
    assert.deepEqual(planejar(congelar(registros([], []))), []);
    assert.deepEqual(planejar(registros([padrao()], [])), ESPERADO_PADRAO());
    assert.deepEqual(planejar(registros([], [empresa()])), ESPERADO_EMPRESA);
  });

  const entradasRuins = [
    ['undefined', undefined], ['null', null], ['lista', []], ['texto', 'x'], ['sem `padrao`', { empresa: [] }], ['sem `empresa`', { padrao: [] }],
    ['`padrao` não é lista', { padrao: {}, empresa: [] }], ['`empresa` não é lista', { padrao: [], empresa: 'x' }], ['chave extra', { padrao: [], empresa: [], outra: [] }],
    ['linha que não é objeto', { padrao: [null], empresa: [] }], ['linha lista', { padrao: [[]], empresa: [] }],
  ];
  for (const [rotulo, entrada] of entradasRuins) {
    teste(`PLN-09b (entrada ${rotulo}) — PLANO_INVALIDO: nada é adivinhado nem tratado como "sem imagens"`, () => {
      assert.throws(() => planejar(entrada), (erro) => { assert.equal(erro.code, 'PLANO_INVALIDO'); return true; });
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-10
function temporizadorFalso() {
  return { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) };
}

function clienteFalso({ padrao: linhasPadrao, empresa: linhasEmpresa }) {
  const tipoDe = (sql) => {
    const t = String(sql).replace(/\s+/g, ' ').trim();
    if (/^BEGIN\b/i.test(t)) return 'BEGIN';
    if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
    if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
    if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
    if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
    if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
    return 'OUTRO';
  };
  const pagina = (linhas, [depoisDe, limite]) => linhas.filter((l) => BigInt(l.id) > BigInt(depoisDe)).slice(0, limite);
  const c = {
    log: [],
    async connect() { c.log.push('connect'); },
    async query(sql, parametros) {
      const tipo = tipoDe(sql);
      c.log.push(tipo);
      switch (tipo) {
        case 'EXPORTAR': return { rows: [{ snapshot_id: '00000003-0000001B-1' }] };
        case 'IDENTIDADE': return { rows: [{ nome: 'gestao_epi', oid: '16384' }] };
        case 'PADRAO': return { rows: pagina(linhasPadrao, parametros) };
        case 'EMPRESA': return { rows: pagina(linhasEmpresa, parametros) };
        default: return { rows: [] };
      }
    },
    async end() { c.log.push('end'); },
    on() { return c; },
  };
  return c;
}

const linhaBancoPadrao = (sobrescrever = {}) => ({
  id: '1', sha256: H('a'), sha256_miniatura: H('b'), sha256_exibicao: H('c'), formato: 'PNG', bytes_mestre: 100, bytes_miniatura: 10, bytes_exibicao: 50, ...sobrescrever,
});
const linhaBancoEmpresa = (sobrescrever = {}) => ({
  id: '5', empresa_id: 7, sha256: H('d'), sha256_mestre: H('e'), sha256_exibicao: H('f'), sha256_miniatura: H('1'), formato: 'PNG', bytes_mestre: 100, bytes_exibicao: 50, bytes_miniatura: 10, ...sobrescrever,
});

describe('[PLN-10] compatibilidade com o snapshot real e com o avaliador real, sem formato alternativo', () => {
  teste('PLN-10 — `criarSnapshot({ planejar: planejarArquivos })` com linhas no formato do BANCO: `contexto.plano` é o plano esperado, congelado, {chave, sha256}', async () => {
    const { criarSnapshot } = exigirModulo('src/services/imagem-backup-snapshot.service');
    const cliente = clienteFalso({ padrao: [linhaBancoPadrao()], empresa: [linhaBancoEmpresa()] });
    const instancia = criarSnapshot({ criarConexao: () => cliente, temporizador: temporizadorFalso(), prazos: { finalizacaoMs: 5000 }, planejar: plano().planejarArquivos });
    const r = await instancia.abrir();
    assert.equal(r.ok, true);
    assert.deepEqual(r.contexto.plano, emOrdem([...ESPERADO_PADRAO(), ...ESPERADO_EMPRESA]));
    assert.equal(Object.isFrozen(r.contexto.plano), true);
    assert.equal((await instancia.finalizar()).concluida, true);
  });

  teste('PLN-10b — registro inconsistente no banco: a abertura do snapshot falha FECHADA (PLANO_INVALIDO), sem contexto; a transação continua exigindo `finalizar()` e este a encerra', async () => {
    const { criarSnapshot } = exigirModulo('src/services/imagem-backup-snapshot.service');
    const cliente = clienteFalso({ padrao: [linhaBancoPadrao({ sha256_miniatura: null })], empresa: [] });
    const instancia = criarSnapshot({ criarConexao: () => cliente, temporizador: temporizadorFalso(), prazos: { finalizacaoMs: 5000 }, planejar: plano().planejarArquivos });
    const r = await instancia.abrir();
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'PLANO_INVALIDO');
    assert.equal(Object.hasOwn(r, 'contexto'), false);
    assert.equal((await instancia.finalizar()).concluida, true);
    assert.ok(cliente.log.includes('ROLLBACK') && cliente.log.includes('end'));
  });

  teste('PLN-10c — o plano é aceito pelo `avaliarConjunto` real como `listaDoSnapshot`: um manifesto com os mesmos {chave, sha256} é válido; arquivo faltando e hash diferente são apontados', () => {
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const lista = planejar(registros([padrao()], [empresa()]));
    const entrada = (manifestoArquivos) => ({
      saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: { arquivos: manifestoArquivos }, listaDoSnapshot: lista, verificacao: { concluida: true, ok: true },
      dump: { concluido: true, bytes: 10, sha256Declarado: H('7'), sha256Recalculado: H('7') }, identidade: { conjuntoId: 'conjunto-1', sha256Manifesto: H('9') },
    });
    const completo = avaliarConjunto(entrada(lista.map((i) => ({ ...i }))));
    assert.equal(completo.valido, true);
    assert.equal(completo.recuperavel, false, 'sem prova de restauração, nunca recuperável');
    assert.ok(avaliarConjunto(entrada(lista.slice(1))).motivos.includes('ARQUIVO_EXIGIDO_AUSENTE'));
    assert.ok(avaliarConjunto(entrada(lista.map((i, n) => (n === 0 ? { ...i, sha256: H('0') } : { ...i })))).motivos.includes('SHA256_DIVERGENTE'));
  });

  teste('PLN-10d — o plano nunca contém chave que o avaliador recusaria: todas as chaves são válidas (sem barra inicial, sem `.` nem `..`, sem controle) e o hash é de 64 hex minúsculos', () => {
    const lista = planejar(registros([padrao(), padrao({ id: '2', sha256: H('9'), sha256Exibicao: null, bytesExibicao: null })], [empresa(), empresa({ id: '6', empresaId: 12 })]));
    for (const item of lista) {
      assert.match(item.sha256, /^[0-9a-f]{64}$/);
      assert.equal(item.chave.startsWith('/'), false);
      assert.equal(item.chave.split('/').some((parte) => parte === '' || parte === '.' || parte === '..'), false);
      assert.equal(/[\p{Cc}]/u.test(item.chave), false);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- PLN-11
describe('[PLN-11] consistência e trava: BLOQUEIOS registrados para a homologação operacional (não executam)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('PLN-11a — COBERTURA REAL DA TRAVA: só a LIMPEZA de órfãos (`imagem-armazenamento-limpeza.service`, `scripts/imagens-limpar-orfaos.js`) e o BACKUP adquirem a trava; o envio de imagens (`imagem-material-upload.service`), a importação do padrão (`imagem-padrao-importacao.service`, `scripts/imagens-importar-padrao.js`) e `scripts/imagens-completar-exibicao.js` gravam SEM trava. Hoje a exclusão mútua com esses escritores é só convenção operacional', 'bloqueio de homologação');
  todo('PLN-11b — a escrita no armazenamento é ADITIVA e por chave endereçada por conteúdo (nunca sobrescreve; mesma chave com outros bytes é recusada); a exclusão de imagem remove só a linha; `completar-exibicao` remove apenas o arquivo que ela mesma criou e só se nenhuma linha o referencia. Isso limita, mas NÃO elimina, a corrida entre snapshot e cópia: o plano precisa de verificação na cópia', 'a ser comprovado na cópia verificada');
  todo('PLN-11c — o snapshot do PostgreSQL NÃO protege o filesystem: um arquivo do plano pode sumir entre o snapshot e a cópia (limpeza ou intervenção manual), e arquivos novos (por exemplo, exibições completadas depois) existem fora do plano; a cópia verificada precisa tratar ausente como falha classificada, nunca como sucesso', 'RED próprio da cópia');
  todo('PLN-11d — o procedimento manual de trava em shell citado em `janela-escrita-imagens.js` não está no repositório; a variável `IMAGENS_JANELA_ESCRITA_ARQUIVO` precisa apontar para o MESMO arquivo em todos os processos que a usam', 'documentação operacional');
  todo('PLN-11e — os hashes do plano são DECLARAÇÕES do banco: a cópia futura recalcula o SHA-256 dos bytes lidos (sem seguir link) e compara; este plano não prova conteúdo algum', 'RED próprio da cópia');
  todo('PLN-11f — reutilizar os planejadores do verificador (`planejarPadrao`/`planejarEmpresa`), hoje internos, em vez de duplicar a regra: exige extrair/exportar no GREEN', 'decisão de implementação');
});
