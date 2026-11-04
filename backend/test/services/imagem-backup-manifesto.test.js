'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-MANIFESTO-INTEGRIDADE-1): MANIFESTO DE INTEGRIDADE do conjunto. Só construção e integridade LÓGICA: dados fictícios
 * determinísticos e, em UM teste de cadeia real, diretórios temporários descartáveis do próprio teste (prefixo `gepi-manifesto-test-`). Não escreve manifesto em disco, não publica, não
 * faz backup nem restauração, e nada aqui prova recuperabilidade.
 *
 * CONTRATO REAL CONFIRMADO (lido no código, sem inventar campos):
 *   - `avaliarConjunto` só inspeciona `manifesto` como OBJETO com `arquivos`: lista de { chave, sha256 } (chave sem barra inicial, sem `.`/`..`/vazio/controle, sem repetição; sha256 de 64 hex
 *     minúsculos); compara cada item da `listaDoSnapshot` com o manifesto (ausente = ARQUIVO_EXIGIDO_AUSENTE, hash diferente = SHA256_DIVERGENTE) e IGNORA arquivos a mais no manifesto (lacuna: um
 *     manifesto com sobras passa), então a EXATIDÃO do conjunto é responsabilidade de quem constrói o manifesto;
 *   - `identidade` = { conjuntoId (texto não vazio, até 200, sem controle), sha256Manifesto (64 hex) }; o avaliador NÃO prova que `sha256Manifesto` é o hash do manifesto: só compara com a
 *     `provaDeRestauracao` (conjuntoId, sha256Dump = dump.sha256Recalculado, sha256Manifesto). Portanto o hash do manifesto vive FORA do manifesto, em `identidade` (e depois na prova): NÃO circular;
 *   - `dump` = { concluido, bytes > 0, sha256Declarado, sha256Recalculado (iguais) }; o `contexto` do snapshot traz `banco: { nome, oid }`, `plano` e um `snapshotId` que só vale enquanto a transação
 *     vive; o resultado da cópia é { ok, completo, arquivos: [{ chave, sha256, bytes }], copiados, falha } (planejador e cópia já aprovados); `avaliar` do coordenador não recebe o resultado da cópia:
 *     quem monta o manifesto usa fechamento.
 *
 * INTERFACE MÍNIMA PROPOSTA (provisória; nomes ainda NÃO aprovados; nada de produção foi alterado): src/services/imagem-backup-manifesto.service.js exporta
 *   `construirManifesto({ contexto, copia, dump, conjuntoId })` -> congelado { manifesto, bytes, sha256, identidade } (síncrona, pura, sem relógio, disco ou rede):
 *     - `manifesto` = { versao: 1, conjuntoId, banco: { nome, oid }, dump: { sha256, bytes }, arquivos: [{ chave, sha256, bytes }] } (só estes campos; `dump.sha256` = `dump.sha256Recalculado`);
 *       NUNCA o `snapshotId`, credenciais, caminhos absolutos ou o próprio hash;
 *     - `bytes` = a serialização CANÔNICA em UTF-8 (Buffer novo a cada chamada): chaves em ordem lexicográfica em todos os níveis, JSON compacto (sem espaços, sem BOM, sem quebra de linha final),
 *       `arquivos` em ordem crescente de `chave`; `sha256` = SHA-256 desses bytes; `identidade` = { conjuntoId, sha256Manifesto: sha256 } (exatamente o que o avaliador espera);
 *     - EXATIDÃO: só constrói se `copia` for completa (`ok`, `completo`, `falha` nula, `copiados` = tamanho) e seus `arquivos` forem EXATAMENTE o `contexto.plano` (mesmas chaves, nenhuma a mais, a
 *       menos ou repetida, mesmos hashes, `bytes` inteiro positivo); `dump` concluído com hashes declarado e recalculado iguais; qualquer outra coisa LANÇA Error com `code: 'MANIFESTO_INVALIDO'` e
 *       mensagem fixa, sem eco de valores, sem resultado parcial;
 *   `lerManifesto({ bytes, sha256 })` -> congelado { manifesto, sha256, identidade } (para a futura restauração): recusa bytes cujo SHA-256 não confira com o informado E bytes que não estejam na forma
 *       canônica (reserializar o conteúdo deve devolver exatamente os mesmos bytes), com o mesmo código MANIFESTO_INVALIDO.
 *   Nada devolve `recuperavel`, `provaDeRestauracao` ou equivalente.
 *
 * LIMITES (honestidade): um SHA-256 do manifesto protege contra corrupção acidental, NÃO contra quem consegue regravar manifesto e hash juntos (autenticidade exige assinatura ou um canal confiável
 * para o hash: TODO MAN-09). O manifesto e o hash não comprovam restauração. A escrita em disco, a publicação atômica e o descarte da preparação ficam para incrementos próprios.
 *
 * COMO LER: o módulo NÃO existe; as falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje e fixam as peças reais.
 */

const MODULO = 'src/services/imagem-backup-manifesto.service';
const manifesto = () => exigirModulo(MODULO);
const construir = (entrada) => manifesto().construirManifesto(entrada);
const ler = (entrada) => manifesto().lerManifesto(entrada);
const PRAZO_DO_TESTE = 15000;
const PREFIXO = 'gepi-manifesto-test-';
const ID_SNAPSHOT = '0000000A-0000002B-7';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);
const H = (c) => c.repeat(64);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
// Congela recursivamente SEM acionar getters: só propriedades de dados (por descritor) são percorridas; os getters hostis chegam intactos ao módulo.
const congelar = (v) => {
  if (v !== null && typeof v === 'object') {
    for (const chave of Reflect.ownKeys(v)) {
      const descritor = Object.getOwnPropertyDescriptor(v, chave);
      if (descritor && 'value' in descritor) congelar(descritor.value);
    }
  }
  return Object.freeze(v);
};
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------------------------------------------------------------------- fixtures
const P1 = Object.freeze({ chave: `7/${H('d')}/mestre.png`, sha256: H('e') });
const P2 = Object.freeze({ chave: `padrao/${H('a')}/mestre.png`, sha256: H('a') });
const PLANO = [P1, P2];
const COPIADOS = [{ ...P1, bytes: 3 }, { ...P2, bytes: 5 }];
const DUMP = { concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') };
const CONJUNTO = 'conjunto-20261023-0001';

const copiaCompleta = (arquivos = COPIADOS) => ({ ok: true, completo: true, arquivos, copiados: arquivos.length, falha: null });
const contexto = (plano = PLANO, sobrescrever = {}) => congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano: clone(plano), ...sobrescrever });
const entrada = (sobrescrever = {}) => ({ contexto: contexto(), copia: copiaCompleta(clone(COPIADOS)), dump: { ...DUMP }, conjuntoId: CONJUNTO, ...sobrescrever });

/** Serialização canônica esperada, escrita À MÃO (chaves em ordem lexicográfica, compacta, sem quebra de linha final). */
const CANONICO = [
  '{"arquivos":[',
  `{"bytes":3,"chave":"7/${H('d')}/mestre.png","sha256":"${H('e')}"},`,
  `{"bytes":5,"chave":"padrao/${H('a')}/mestre.png","sha256":"${H('a')}"}`,
  '],"banco":{"nome":"gestao_epi","oid":"16384"},',
  `"conjuntoId":"${CONJUNTO}",`,
  `"dump":{"bytes":1234,"sha256":"${H('7')}"},`,
  '"versao":1}',
].join('');

function rejeita(fn, valoresProibidos = []) {
  assert.throws(fn, (erro) => {
    assert.equal(erro.code, 'MANIFESTO_INVALIDO');
    const texto = `${erro.message} ${String(erro)} ${JSON.stringify(erro)}`;
    for (const v of valoresProibidos) assert.equal(texto.includes(String(v)), false, `a rejeição não pode ecoar "${String(v)}"`);
    return true;
  });
}

// ------------------------------------------------------------------------------------------------------------------------------- áreas descartáveis
const areas = [];
function criarArea() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  areas.push(raiz);
  const origem = path.join(raiz, 'origem');
  const destino = path.join(raiz, 'destino');
  fs.mkdirSync(origem, { mode: 0o700 });
  fs.mkdirSync(destino, { mode: 0o700 });
  return { raiz, origem: criarArmazenamentoImagens({ diretorio: origem }), destino: criarArmazenamentoImagens({ diretorio: destino }) };
}
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const raiz of areas) {
    if (path.dirname(raiz) === tmp && path.basename(raiz).startsWith(PREFIXO)) fs.rmSync(raiz, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: o contrato real do avaliador que o manifesto precisa respeitar', () => {
  const entradaDoAvaliador = (arquivosDoManifesto, extras = {}) => ({
    saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: { arquivos: arquivosDoManifesto }, listaDoSnapshot: PLANO.map((p) => ({ ...p })), verificacao: { concluida: true, ok: true },
    dump: { ...DUMP }, identidade: { conjuntoId: CONJUNTO, sha256Manifesto: H('9') }, ...extras,
  });

  teste('CTL-01 — o avaliador real só exige `manifesto.arquivos` em {chave, sha256}; campos a mais nos itens (como `bytes`) e hash do manifesto qualquer são aceitos: ele NÃO prova que `sha256Manifesto` seja o hash do manifesto', () => {
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const r = avaliarConjunto(entradaDoAvaliador(COPIADOS.map((c) => ({ ...c }))));
    assert.equal(r.valido, true);
    assert.equal(r.recuperavel, false);
  });

  teste('CTL-02 — LACUNA do avaliador: arquivos A MAIS no manifesto passam (só os exigidos pela lista são conferidos); por isso a exatidão do conjunto é do construtor do manifesto', () => {
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const comSobra = [...COPIADOS.map((c) => ({ ...c })), { chave: `7/${H('1')}/miniatura.webp`, sha256: H('2') }];
    assert.equal(avaliarConjunto(entradaDoAvaliador(comSobra)).valido, true);
  });

  teste('CTL-03 — o avaliador real aponta arquivo ausente, hash divergente e chave repetida; recusa identidade sem `sha256Manifesto` válido ou com `conjuntoId` vazio, grande ou com controle', () => {
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    assert.ok(avaliarConjunto(entradaDoAvaliador([COPIADOS[0]])).motivos.includes('ARQUIVO_EXIGIDO_AUSENTE'));
    assert.ok(avaliarConjunto(entradaDoAvaliador([{ ...COPIADOS[0], sha256: H('0') }, COPIADOS[1]])).motivos.includes('SHA256_DIVERGENTE'));
    assert.ok(avaliarConjunto(entradaDoAvaliador([COPIADOS[0], COPIADOS[0], COPIADOS[1]])).motivos.includes('MANIFESTO_INVALIDO'));
    for (const identidade of [{ conjuntoId: CONJUNTO, sha256Manifesto: 'x' }, { conjuntoId: '   ', sha256Manifesto: H('9') }, { conjuntoId: 'a'.repeat(201), sha256Manifesto: H('9') }, { conjuntoId: 'a\nb', sha256Manifesto: H('9') }]) {
      assert.ok(avaliarConjunto(entradaDoAvaliador(COPIADOS, { identidade })).motivos.includes('IDENTIDADE_INVALIDA'));
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-01
describe('[MAN-01] conjunto completo', () => {
  teste('MAN-01 — plano e cópia completos: o manifesto tem EXATAMENTE os campos e arquivos esperados; os bytes canônicos são os do exemplo escrito à mão; o hash é o SHA-256 desses bytes; a identidade é {conjuntoId, sha256Manifesto}', () => {
    const r = construir(entrada());
    assert.deepEqual(Object.keys(r).sort(), ['bytes', 'identidade', 'manifesto', 'sha256']);
    assert.equal(r.bytes.toString('utf8'), CANONICO);
    assert.equal(r.sha256, sha(Buffer.from(CANONICO, 'utf8')));
    assert.deepEqual(r.manifesto, JSON.parse(CANONICO));
    assert.deepEqual(Object.keys(r.manifesto).sort(), ['arquivos', 'banco', 'conjuntoId', 'dump', 'versao']);
    assert.deepEqual({ ...r.identidade }, { conjuntoId: CONJUNTO, sha256Manifesto: r.sha256 });
    assert.equal(Object.isFrozen(r), true);
    assert.equal(Object.isFrozen(r.manifesto), true);
    assert.equal(Object.isFrozen(r.manifesto.arquivos), true);
  });

  teste('MAN-01b — o resultado é PURO: a entrada (contexto congelado, plano, cópia, dump) nunca é alterada, e cada chamada devolve um Buffer NOVO (alterar o devolvido não afeta a próxima chamada)', () => {
    const e = entrada();
    const antes = JSON.stringify(e);
    const a = construir(e);
    a.bytes[0] = 0;
    const b = construir(e);
    assert.equal(b.bytes.toString('utf8'), CANONICO);
    assert.equal(JSON.stringify(e), antes);
  });

  teste('MAN-01c — CADEIA REAL: planejador real, cópia real (diretórios temporários descartáveis) e construtor: o manifesto é aceito pelo `avaliarConjunto` real com a `listaDoSnapshot` igual ao plano', async () => {
    const { planejarArquivos } = exigirModulo('src/services/imagem-backup-plano.service');
    const { criarCopiaDeImagens } = exigirModulo('src/services/imagem-backup-copia.service');
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const area = criarArea();
    const mestre = Buffer.from('mestre-fictício');
    const miniatura = Buffer.from('miniatura-fictícia');
    const registros = congelar({ padrao: [{ id: '1', sha256: sha(mestre), sha256Miniatura: sha(miniatura), sha256Exibicao: null, formato: 'PNG', bytesMestre: mestre.length, bytesMiniatura: miniatura.length, bytesExibicao: null }], empresa: [] });
    const plano = planejarArquivos(registros);
    assert.equal(plano.length, 2);
    for (const item of plano) await area.origem.gravar(item.chave, item.chave.endsWith('mestre.png') ? mestre : miniatura, { maxBytes: 4096, sha256Esperado: item.sha256 });
    const ctx = congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros, plano });
    const copia = await criarCopiaDeImagens({ origem: area.origem, destino: area.destino, maxBytesPorArquivo: 4096 })(ctx);
    assert.equal(copia.ok, true);
    const r = construir({ contexto: ctx, copia, dump: { ...DUMP }, conjuntoId: CONJUNTO });
    const avaliacao = avaliarConjunto({
      saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: r.manifesto, listaDoSnapshot: plano, verificacao: { concluida: true, ok: true }, dump: { ...DUMP }, identidade: { ...r.identidade },
    });
    assert.equal(avaliacao.valido, true);
    assert.equal(avaliacao.recuperavel, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-02
describe('[MAN-02] cópia incompleta ou inconsistente: nenhum manifesto, nenhum resultado parcial', () => {
  const casos = [
    ['`ok` falso', (e) => { e.copia = { ...e.copia, ok: false }; }],
    ['`completo` falso', (e) => { e.copia = { ...e.copia, completo: false }; }],
    ['`falha` presente', (e) => { e.copia = { ...e.copia, falha: { codigo: 'COPIA_FALHOU', chave: P1.chave } }; }],
    ['cópia de uma falha real (arquivos vazios)', (e) => { e.copia = { ok: false, completo: false, arquivos: [], copiados: 0, falha: { codigo: 'ORIGEM_AUSENTE', chave: P1.chave } }; }],
    ['arquivo FALTANDO', (e) => { e.copia = copiaCompleta([COPIADOS[0]]); }],
    ['arquivo A MAIS (fora do plano)', (e) => { e.copia = copiaCompleta([...clone(COPIADOS), { chave: `7/${H('1')}/miniatura.webp`, sha256: H('2'), bytes: 4 }]); }],
    ['arquivo REPETIDO', (e) => { e.copia = copiaCompleta([...clone(COPIADOS), clone(COPIADOS[0])]); }],
    ['hash DIVERGENTE do plano', (e) => { e.copia = copiaCompleta(clone(COPIADOS).map((c, i) => (i === 0 ? { ...c, sha256: H('0') } : c))); }],
    ['chave trocada por outra com o mesmo hash', (e) => { e.copia = copiaCompleta(clone(COPIADOS).map((c, i) => (i === 0 ? { ...c, chave: `8/${H('d')}/mestre.png` } : c))); }],
    ['`copiados` diferente do tamanho', (e) => { e.copia = { ...copiaCompleta(clone(COPIADOS)), copiados: 1 }; }],
    ['`bytes` ausente', (e) => { e.copia = copiaCompleta(clone(COPIADOS).map((c, i) => (i === 0 ? { chave: c.chave, sha256: c.sha256 } : c))); }],
    ['`bytes` zero', (e) => { e.copia = copiaCompleta(clone(COPIADOS).map((c, i) => (i === 0 ? { ...c, bytes: 0 } : c))); }],
    ['`bytes` fracionário', (e) => { e.copia = copiaCompleta(clone(COPIADOS).map((c, i) => (i === 0 ? { ...c, bytes: 1.5 } : c))); }],
    ['item com campo extra', (e) => { e.copia = copiaCompleta(clone(COPIADOS).map((c, i) => (i === 0 ? { ...c, caminho: '/tmp/x' } : c))); }],
    ['`arquivos` não é lista', (e) => { e.copia = { ...e.copia, arquivos: {} }; }],
    ['resultado da cópia com chaves desconhecidas', (e) => { e.copia = { ...e.copia, recuperavel: true }; }],
    ['plano VAZIO mas a cópia trouxe arquivos', (e) => { e.contexto = contexto([]); }],
    ['plano nulo (snapshot sem planejador)', (e) => { e.contexto = contexto(PLANO, { plano: null }); }],
    ['plano com chave repetida', (e) => { e.contexto = contexto([P1, P1]); }],
  ];
  for (const [rotulo, ajustar] of casos) {
    teste(`MAN-02 (${rotulo}) — MANIFESTO_INVALIDO`, () => {
      const e = entrada();
      ajustar(e);
      rejeita(() => construir(e));
    });
  }

  teste('MAN-02b — plano e cópia VAZIOS (ausência legítima de imagens): manifesto válido com `arquivos` vazio; o dump continua obrigatório', () => {
    const r = construir(entrada({ contexto: contexto([]), copia: copiaCompleta([]) }));
    assert.deepEqual(r.manifesto.arquivos, []);
    assert.equal(r.bytes.toString('utf8').includes('"arquivos":[]'), true);
    rejeita(() => construir(entrada({ contexto: contexto([]), copia: copiaCompleta([]), dump: { ...DUMP, concluido: false } })));
  });

  const dumpsRuins = [
    ['não concluído', { concluido: false }], ['bytes zero', { bytes: 0 }], ['bytes negativos', { bytes: -1 }], ['bytes fracionários', { bytes: 1.5 }], ['hash declarado ≠ recalculado', { sha256Recalculado: H('8') }],
    ['hash recalculado inválido', { sha256Declarado: 'x', sha256Recalculado: 'x' }], ['hash em maiúsculas', { sha256Declarado: 'A'.repeat(64), sha256Recalculado: 'A'.repeat(64) }],
    ['hash ausente', { sha256Recalculado: undefined }],
  ];
  for (const [rotulo, sobrescrever] of dumpsRuins) {
    teste(`MAN-02c (dump ${rotulo}) — MANIFESTO_INVALIDO: só um dump concluído e verificado entra no manifesto`, () => {
      rejeita(() => construir(entrada({ dump: { ...DUMP, ...sobrescrever } })));
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-03
describe('[MAN-03] determinismo: mesmo conjunto lógico, mesmos bytes e mesmo SHA-256', () => {
  teste('MAN-03 — independente da ordem de entrada (plano e arquivos da cópia embaralhados) e da ordem das propriedades dos objetos: os mesmos bytes canônicos e o mesmo hash', () => {
    const a = construir(entrada());
    const invertida = { ...entrada(), contexto: contexto([P2, P1]), copia: copiaCompleta([{ bytes: 5, sha256: P2.sha256, chave: P2.chave }, { bytes: 3, sha256: P1.sha256, chave: P1.chave }]) };
    const b = construir(invertida);
    assert.equal(b.bytes.toString('utf8'), a.bytes.toString('utf8'));
    assert.equal(b.sha256, a.sha256);
    const dumpEmOutraOrdem = { sha256Recalculado: H('7'), bytes: 1234, sha256Declarado: H('7'), concluido: true };
    assert.equal(construir(entrada({ dump: dumpEmOutraOrdem })).sha256, a.sha256);
  });

  teste('MAN-03b — a serialização é a canônica definida (não a de `JSON.stringify` do objeto de entrada): chaves em ordem lexicográfica em todos os níveis, sem espaços, sem BOM, sem quebra de linha final', () => {
    const { bytes } = construir(entrada());
    assert.equal(bytes[0], 0x7b);
    assert.equal(bytes[bytes.length - 1], 0x7d);
    assert.equal(bytes.includes(0x0a), false);
    assert.equal(bytes.toString('utf8').includes(' '), false);
    const texto = bytes.toString('utf8');
    assert.ok(texto.indexOf('"arquivos"') < texto.indexOf('"banco"') && texto.indexOf('"banco"') < texto.indexOf('"conjuntoId"') && texto.indexOf('"conjuntoId"') < texto.indexOf('"dump"') && texto.indexOf('"dump"') < texto.indexOf('"versao"'));
  });

  teste('MAN-03c — QUALQUER mudança lógica muda o hash: outro `conjuntoId`, outro banco (nome ou oid), outro dump (hash ou bytes), outro conteúdo de arquivo, arquivo a mais no plano e na cópia', () => {
    const base = construir(entrada()).sha256;
    const variantes = [
      entrada({ conjuntoId: 'conjunto-20261023-0002' }),
      entrada({ contexto: contexto(PLANO, { banco: { nome: 'outro_banco', oid: '16384' } }) }),
      entrada({ contexto: contexto(PLANO, { banco: { nome: 'gestao_epi', oid: '99999' } }) }),
      entrada({ dump: { ...DUMP, sha256Declarado: H('6'), sha256Recalculado: H('6') } }),
      entrada({ dump: { ...DUMP, bytes: 1235 } }),
      entrada({ copia: copiaCompleta(clone(COPIADOS).map((c, i) => (i === 0 ? { ...c, bytes: 4 } : c))) }),
    ];
    const hashes = variantes.map((v) => construir(v).sha256);
    for (const h of hashes) assert.notEqual(h, base);
    assert.equal(new Set(hashes).size, hashes.length);
    const P3 = { chave: `padrao/${H('b')}/mestre.png`, sha256: H('b') };
    const maior = construir(entrada({ contexto: contexto([...PLANO, P3]), copia: copiaCompleta([...clone(COPIADOS), { ...P3, bytes: 7 }]) }));
    assert.notEqual(maior.sha256, base);
  });

  teste('MAN-03d — não depende de relógio, aleatoriedade nem ambiente: duas chamadas (inclusive com `Date` e `Math.random` alterados) dão os mesmos bytes', () => {
    const a = construir(entrada());
    const dateOriginal = Date.now;
    const randomOriginal = Math.random;
    try {
      Date.now = () => 1;
      Math.random = () => 0.123;
      assert.equal(construir(entrada()).sha256, a.sha256);
    } finally {
      Date.now = dateOriginal;
      Math.random = randomOriginal;
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-04
describe('[MAN-04] hash do manifesto: sobre os bytes canônicos, FORA dos dados que ele resume (sem circularidade)', () => {
  teste('MAN-04 — o hash é o SHA-256 dos bytes canônicos (conferido de forma independente); o manifesto NÃO contém o próprio hash nem campo para ele; o vínculo manifesto↔hash é só `identidade.sha256Manifesto`', () => {
    const r = construir(entrada());
    assert.equal(r.sha256, crypto.createHash('sha256').update(r.bytes).digest('hex'));
    assert.equal(r.bytes.toString('utf8').includes(r.sha256), false);
    for (const chave of Object.keys(r.manifesto)) assert.equal(/sha256Manifesto|hashDoManifesto|manifestoSha/i.test(chave), false, chave);
    assert.equal(r.identidade.sha256Manifesto, r.sha256);
  });

  teste('MAN-04b — `lerManifesto` com bytes e hash corretos devolve o manifesto e a identidade; é o par que a futura restauração consome', () => {
    const r = construir(entrada());
    const lido = ler({ bytes: r.bytes, sha256: r.sha256 });
    assert.deepEqual(lido.manifesto, r.manifesto);
    assert.equal(lido.sha256, r.sha256);
    assert.deepEqual({ ...lido.identidade }, { ...r.identidade });
    assert.equal(Object.isFrozen(lido), true);
    assert.equal(ler({ bytes: new Uint8Array(r.bytes), sha256: r.sha256 }).sha256, r.sha256);
  });

  teste('MAN-04c — bytes ALTERADOS (um caractere) ou hash ERRADO, em maiúsculas, curto ou de outro manifesto: recusados (MANIFESTO_INVALIDO); a integridade é conferida de verdade, não presumida', () => {
    const r = construir(entrada());
    const adulterado = Buffer.from(r.bytes);
    adulterado[adulterado.length - 8] ^= 0x01;
    rejeita(() => ler({ bytes: adulterado, sha256: r.sha256 }));
    for (const hash of [H('0'), r.sha256.toUpperCase(), r.sha256.slice(1), '', null, 123, `${r.sha256}\n`]) rejeita(() => ler({ bytes: r.bytes, sha256: hash }));
    const outro = construir(entrada({ conjuntoId: 'conjunto-outro' }));
    rejeita(() => ler({ bytes: r.bytes, sha256: outro.sha256 }));
  });

  teste('MAN-04d — bytes com o hash CERTO mas FORA da forma canônica (JSON formatado, chaves em outra ordem, quebra de linha final, BOM, arquivos fora de ordem) são recusados: não existem dois manifestos válidos para o mesmo conjunto', () => {
    const r = construir(entrada());
    const objeto = JSON.parse(r.bytes.toString('utf8'));
    const naoCanonicos = [
      Buffer.from(JSON.stringify(objeto, null, 2), 'utf8'),
      Buffer.from(`${r.bytes.toString('utf8')}\n`, 'utf8'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), r.bytes]),
      Buffer.from(JSON.stringify({ versao: objeto.versao, dump: objeto.dump, conjuntoId: objeto.conjuntoId, banco: objeto.banco, arquivos: objeto.arquivos }), 'utf8'),
      Buffer.from(JSON.stringify({ ...objeto, arquivos: [...objeto.arquivos].reverse() }), 'utf8'),
    ];
    for (const bytes of naoCanonicos) rejeita(() => ler({ bytes, sha256: sha(bytes) }));
  });

  const bytesRuins = [['texto', 'não é Buffer'], ['nulo', null], ['vazio', Buffer.alloc(0)], ['JSON inválido', Buffer.from('{"a":')], ['lista', Buffer.from('[]')], ['número', 12345]];
  for (const [rotulo, bytes] of bytesRuins) {
    teste(`MAN-04e (bytes ${rotulo}) — MANIFESTO_INVALIDO`, () => {
      rejeita(() => ler({ bytes, sha256: H('0') }));
    });
  }

  teste('MAN-04f — `lerManifesto` revalida o CONTEÚDO canônico: bytes canônicos de um manifesto com `snapshotId`, campo extra, `versao` desconhecida, hash fora do formato ou chave repetida são recusados mesmo com o hash correto', () => {
    const r = construir(entrada());
    const base = JSON.parse(r.bytes.toString('utf8'));
    const canonico = (o) => Buffer.from(JSON.stringify(ordenado(o)), 'utf8');
    function ordenado(v) {
      if (Array.isArray(v)) return v.map(ordenado);
      if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenado(v[k])]));
      return v;
    }
    const ruins = [
      { ...base, snapshotId: ID_SNAPSHOT }, { ...base, extra: 1 }, { ...base, versao: 2 }, { ...base, dump: { ...base.dump, sha256: 'x' } },
      { ...base, arquivos: [base.arquivos[0], base.arquivos[0]] }, { ...base, arquivos: [{ ...base.arquivos[0], chave: '../x' }, base.arquivos[1]] }, { ...base, conjuntoId: '' },
    ];
    for (const ruim of ruins) {
      const bytes = canonico(ruim);
      rejeita(() => ler({ bytes, sha256: sha(bytes) }));
    }
    assert.equal(ler({ bytes: canonico(base), sha256: sha(canonico(base)) }).sha256, r.sha256, 'controle: o canônico válido continua aceito');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-05
describe('[MAN-05] identidade e isolamento: nada de outra operação ou empresa, nada temporário ou sensível', () => {
  teste('MAN-05 — o `snapshotId` (válido só enquanto a transação vive), credenciais, caminhos absolutos e o diretório de preparação NUNCA entram no manifesto, nos bytes nem na identidade', () => {
    const e = entrada({ conjuntoId: CONJUNTO });
    e.contexto = congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano: clone(PLANO), senha: SEGREDO });
    const r = construir(e);
    const texto = `${r.bytes.toString('utf8')} ${JSON.stringify(r.manifesto)} ${JSON.stringify(r.identidade)}`;
    for (const proibido of [ID_SNAPSHOT, SEGREDO, os.tmpdir(), '/Users/', '/var/', 'snapshot', 'password', 'senha']) assert.equal(texto.includes(proibido), false, proibido);
  });

  teste('MAN-05b — ISOLAMENTO entre empresas: duas empresas com o MESMO diretório de hash mantêm linhas separadas; a cópia de uma não pode ocupar o lugar da outra (mesmo hash de conteúdo, chave de outra empresa = arquivo a mais e a menos)', () => {
    const a = { chave: `7/${H('d')}/mestre.png`, sha256: H('e') };
    const b = { chave: `8/${H('d')}/mestre.png`, sha256: H('f') };
    const r = construir(entrada({ contexto: contexto([a, b]), copia: copiaCompleta([{ ...a, bytes: 3 }, { ...b, bytes: 4 }]) }));
    assert.deepEqual(r.manifesto.arquivos.map((x) => x.chave), [a.chave, b.chave]);
    rejeita(() => construir(entrada({ contexto: contexto([a, b]), copia: copiaCompleta([{ ...a, bytes: 3 }, { chave: `7/${H('d')}/mestre.png`, sha256: H('f'), bytes: 4 }]) })));
  });

  teste('MAN-05c — operações diferentes não se misturam: o mesmo conjunto de arquivos com `conjuntoId` diferente gera manifestos, hashes e identidades diferentes', () => {
    const a = construir(entrada({ conjuntoId: 'operacao-A' }));
    const b = construir(entrada({ conjuntoId: 'operacao-B' }));
    assert.notEqual(a.sha256, b.sha256);
    assert.equal(a.identidade.conjuntoId, 'operacao-A');
    assert.equal(b.identidade.conjuntoId, 'operacao-B');
    assert.equal(a.manifesto.conjuntoId, a.identidade.conjuntoId);
  });

  const conjuntosRuins = [['vazio', ''], ['só espaços', '   '], ['maior que 200', 'a'.repeat(201)], ['com quebra de linha', 'a\nb'], ['com NUL', 'a\0b'], ['número', 123], ['nulo', null], ['ausente', undefined]];
  for (const [rotulo, conjuntoId] of conjuntosRuins) {
    teste(`MAN-05d (conjuntoId ${rotulo}) — MANIFESTO_INVALIDO: a mesma regra de identidade do avaliador`, () => {
      rejeita(() => construir(entrada({ conjuntoId })));
    });
  }

  const bancosRuins = [['nome vazio', { nome: '', oid: '16384' }], ['oid não numérico', { nome: 'gestao_epi', oid: 'abc' }], ['oid ausente', { nome: 'gestao_epi' }], ['nome com controle', { nome: 'gestao\nepi', oid: '16384' }], ['banco ausente', undefined]];
  for (const [rotulo, banco] of bancosRuins) {
    teste(`MAN-05e (banco ${rotulo}) — MANIFESTO_INVALIDO (a identidade do banco de origem é obrigatória e validada)`, () => {
      rejeita(() => construir(entrada({ contexto: contexto(PLANO, { banco }) })));
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-06
describe('[MAN-06] compatibilidade com o `avaliarConjunto` real, sem alterá-lo', () => {
  const entradaDoAvaliador = (r, sobrescrever = {}) => ({
    saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: r.manifesto, listaDoSnapshot: PLANO.map((p) => ({ ...p })), verificacao: { concluida: true, ok: true }, dump: { ...DUMP }, identidade: { ...r.identidade },
    ...sobrescrever,
  });

  teste('MAN-06 — o manifesto e a identidade construídos são aceitos pelo avaliador real (válido) e o avaliador NUNCA os declara recuperáveis sem prova de restauração', () => {
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const r = construir(entrada());
    const avaliacao = avaliarConjunto(entradaDoAvaliador(r));
    assert.equal(avaliacao.valido, true);
    assert.equal(avaliacao.recuperavel, false);
    assert.deepEqual([...avaliacao.motivos], []);
  });

  teste('MAN-06b — a ÚNICA ligação que o avaliador faz com o hash é a da prova de restauração futura: com uma prova DESTE conjunto (mesmos conjuntoId, hash do dump e hash do manifesto) o avaliador a reconhece, e com o hash do manifesto de OUTRO conjunto não', () => {
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const r = construir(entrada());
    const outro = construir(entrada({ conjuntoId: 'conjunto-outro' }));
    const prova = (hash) => ({ aprovada: true, conjuntoId: CONJUNTO, sha256Dump: DUMP.sha256Recalculado, sha256Manifesto: hash });
    assert.equal(avaliarConjunto(entradaDoAvaliador(r, { provaDeRestauracao: prova(r.sha256) })).recuperavel, true, 'controle da própria regra do avaliador: só com prova');
    assert.equal(avaliarConjunto(entradaDoAvaliador(r, { provaDeRestauracao: prova(outro.sha256) })).recuperavel, false);
  });

  teste('MAN-06c — o resultado do construtor é exatamente o que o avaliador consome: `manifesto.arquivos` com chaves válidas para o avaliador (sem barra inicial, sem `.`/`..`, sem repetição) e `identidade` com os dois campos', () => {
    const r = construir(entrada());
    assert.deepEqual(Object.keys(r.identidade).sort(), ['conjuntoId', 'sha256Manifesto']);
    for (const item of r.manifesto.arquivos) {
      assert.equal(item.chave.startsWith('/'), false);
      assert.equal(item.chave.split('/').some((p) => p === '' || p === '.' || p === '..'), false);
      assert.match(item.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(new Set(r.manifesto.arquivos.map((i) => i.chave)).size, r.manifesto.arquivos.length);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-07
describe('[MAN-07] falhas seguras: entrada hostil nunca vira manifesto aparentemente íntegro nem vaza mensagem', () => {
  const erroHostil = () => new TypeError(`${SEGREDO} /Users/privado inválido`);
  const comGetter = (objeto, chave, get) => Object.defineProperty(objeto, chave, { enumerable: true, configurable: true, get });

  const hostis = [
    ['getter na `chave` do plano', () => { const plano = [{ ...P1 }, { ...P2 }]; comGetter(plano[0], 'chave', () => { throw erroHostil(); }); return entrada({ contexto: congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: {}, plano }) }); }],
    ['getter em `copia.arquivos`', () => { const copia = copiaCompleta(clone(COPIADOS)); comGetter(copia, 'arquivos', () => { throw erroHostil(); }); return entrada({ copia }); }],
    ['getter em `dump.sha256Recalculado`', () => { const dump = { ...DUMP }; comGetter(dump, 'sha256Recalculado', () => { throw erroHostil(); }); return entrada({ dump }); }],
    ['getter em `conjuntoId` (entrada)', () => { const e = entrada(); comGetter(e, 'conjuntoId', () => { throw erroHostil(); }); return e; }],
    ['getter em `contexto.banco`', () => entrada({ contexto: congelar(comGetter({ plano: clone(PLANO), registros: {} }, 'banco', () => { throw erroHostil(); })) })],
    ['Proxy cujo `get` lança (cópia)', () => entrada({ copia: new Proxy(copiaCompleta(clone(COPIADOS)), { get() { throw erroHostil(); } }) })],
  ];
  for (const [rotulo, montar] of hostis) {
    teste(`MAN-07 (${rotulo}) — MANIFESTO_INVALIDO sem a mensagem hostil; nenhum manifesto`, () => {
      let resultado;
      rejeita(() => { resultado = construir(montar()); }, [SEGREDO, '/Users/privado']);
      assert.equal(resultado, undefined);
    });
  }

  teste('MAN-07a — getter instável no hash de um item da cópia: captura ÚNICA. O primeiro valor é validado contra o plano e é o que entra no manifesto; o módulo não relê; mudar o getter depois não altera bytes nem SHA-256; um primeiro valor inválido continua recusado', () => {
    let leituras = 0;
    const arquivos = clone(COPIADOS);
    comGetter(arquivos[0], 'sha256', () => { leituras += 1; return leituras === 1 ? P1.sha256 : H('0'); });
    const r = construir(entrada({ copia: copiaCompleta(arquivos) }));
    assert.equal(leituras, 1, 'uma única leitura');
    assert.equal(r.manifesto.arquivos[0].sha256, P1.sha256, 'o valor capturado é o que entra');
    const referencia = construir(entrada());
    assert.equal(r.bytes.toString('utf8'), CANONICO);
    assert.equal(r.sha256, referencia.sha256);
    assert.equal(arquivos[0].sha256, H('0'), 'o getter mudou depois da construção');
    assert.equal(r.bytes.toString('utf8'), CANONICO, 'bytes inalterados');
    assert.equal(r.sha256, sha(r.bytes), 'hash inalterado e coerente com os bytes');
    assert.equal(r.manifesto.arquivos[0].sha256, P1.sha256);

    let invalidas = 0;
    const ruins = clone(COPIADOS);
    comGetter(ruins[0], 'sha256', () => { invalidas += 1; return invalidas === 1 ? H('0') : P1.sha256; });
    rejeita(() => construir(entrada({ copia: copiaCompleta(ruins) })));
    assert.equal(invalidas, 1, 'o valor inválido capturado não é "corrigido" por uma releitura');
  });

  const naoObjetos = [['undefined', undefined], ['null', null], ['texto', 'x'], ['lista', []], ['sem `contexto`', { copia: copiaCompleta(), dump: { ...DUMP }, conjuntoId: CONJUNTO }], ['sem `copia`', { contexto: contexto(), dump: { ...DUMP }, conjuntoId: CONJUNTO }],
    ['sem `dump`', { contexto: contexto(), copia: copiaCompleta(), conjuntoId: CONJUNTO }], ['chave extra na entrada', { ...entrada(), extra: 1 }]];
  for (const [rotulo, e] of naoObjetos) {
    teste(`MAN-07b (entrada ${rotulo}) — MANIFESTO_INVALIDO`, () => {
      rejeita(() => construir(e));
    });
  }

  teste('MAN-07c — a entrada é capturada UMA vez: uma leitura inconsistente entre validação e uso não produz manifesto com valores que não foram validados', () => {
    let leituras = 0;
    const dump = { concluido: true, bytes: 1234, sha256Declarado: H('7') };
    comGetter(dump, 'sha256Recalculado', () => { leituras += 1; return leituras === 1 ? H('7') : H('8'); });
    const r = construir(entrada({ dump }));
    assert.equal(r.manifesto.dump.sha256, H('7'), 'vale a leitura validada');
    assert.ok(leituras <= 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-08
describe('[MAN-08] recuperabilidade: nenhum manifesto ou hash comprova restauração', () => {
  teste('MAN-08 — o resultado e o manifesto NÃO têm `recuperavel`, `provaDeRestauracao`, `restaurado` nem equivalente; os valores são só dados do conjunto', () => {
    const r = construir(entrada());
    for (const objeto of [r, r.manifesto, r.identidade]) {
      for (const chave of Object.keys(objeto)) assert.equal(/recuper|prova|restaur/i.test(chave), false, chave);
    }
    assert.equal(r.bytes.toString('utf8').toLowerCase().includes('recuper'), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MAN-09
describe('[MAN-09] limites e pendências (registradas, NÃO executadas)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('MAN-09a — AUTENTICIDADE: o SHA-256 do manifesto detecta corrupção acidental, mas quem consegue regravar o manifesto e o hash juntos o forja; autenticidade exige assinatura/HMAC ou um canal confiável para o hash', 'decisão de segurança');
  todo('MAN-09b — escrita DEFINITIVA do manifesto e do hash (arquivo de bytes canônicos e hash em separado), criação exclusiva, permissões, `fsync` e publicação ATÔMICA do conjunto completo', 'incremento próprio');
  todo('MAN-09c — descarte seguro da área de preparação e destino dos arquivos já verificados em caso de falha', 'decisão operacional');
  todo('MAN-09d — o `oid` do banco não é estável entre restaurações; o `banco` do manifesto identifica a ORIGEM, não o destino; ligação com a restauração independente e a `provaDeRestauracao`', 'RED da restauração');
  todo('MAN-09e — tamanho máximo do manifesto, versionamento do formato (`versao`) e política de migração', 'decisão de contrato');
  todo('MAN-09f — identidade do `conjuntoId` (quem gera e como não se repete) e sua relação com a trava e o snapshot', 'composição operacional');
});
