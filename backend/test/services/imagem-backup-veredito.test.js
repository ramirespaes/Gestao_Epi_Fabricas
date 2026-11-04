'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-1): VALIDADE DO RESULTADO. Só unitário: uma função pura avalia o conjunto a partir de dados
 * em memória (nenhum disco, banco, processo nem ferramenta externa). Princípio (pareceres C2, C3 e C3-B): código de saída zero NUNCA basta, e validade não é
 * recuperabilidade (só a prova de restauração aprovada torna um conjunto recuperável).
 *
 * CONTRATO PROVISÓRIO (nomes, campos e códigos de motivo ainda NÃO aprovados; ver o relatório RED-1):
 *   src/services/imagem-backup.service.js exporta `avaliarConjunto(entrada)` -> { valido, recuperavel, saida, motivos }
 *   entrada = {
 *     saidaDoProcedimento: inteiro (código de saída da etapa externa),
 *     relatorio: { veredito: 'VALIDO' | ... } | null,
 *     manifesto: { arquivos: [{ chave, sha256 }] } | null      (hashes RECALCULADOS da cópia pelo próprio backup),
 *     listaDoSnapshot: [{ chave, sha256 }] | null              (as variantes exigidas, lidas no MESMO snapshot do pg_dump),
 *     verificacao: { concluida: boolean, ok: boolean } | null  (verificação independente posterior às etapas),
 *     dump: { concluido: boolean, bytes: inteiro > 0, sha256Declarado, sha256Recalculado } | null   (RED-1A: evidência do pg_dump; o manifesto
 *           de imagens sozinho não prova o backup completo),
 *     identidade: { conjuntoId: texto não vazio, sha256Manifesto: hex de 64 } | null           (RED-1A: identidade inequívoca do conjunto verificado),
 *     provaDeRestauracao: { aprovada: true, conjuntoId, sha256Dump, sha256Manifesto } | undefined  (RED-1A: só vale a prova DESTE conjunto: os três
 *           identificadores têm de ser iguais a identidade.conjuntoId, dump.sha256Recalculado e identidade.sha256Manifesto; prova genérica ou de outro
 *           conjunto é recusada: o conjunto pode continuar válido, mas não recuperável)
 *   }
 *   saída: 0 válido; 9 inválido. Motivos provisórios: SAIDA_NAO_ZERO, RELATORIO_AUSENTE, VEREDITO_NAO_VALIDO, MANIFESTO_AUSENTE, MANIFESTO_INVALIDO,
 *   LISTA_DO_SNAPSHOT_AUSENTE, SHA256_DIVERGENTE, ARQUIVO_EXIGIDO_AUSENTE, VERIFICACAO_FALHOU, VERIFICACAO_NAO_CONCLUIDA; (RED-1A) DUMP_AUSENTE,
 *   DUMP_NAO_CONCLUIDO, DUMP_VAZIO, DUMP_INVALIDO, DUMP_SHA256_DIVERGENTE, IDENTIDADE_INVALIDA.
 *   Arquivo copiado que não está na lista (órfão, temporário já filtrado) é tolerado (C3-B). Todos os motivos aparecem juntos: nenhum esconde outro.
 */

const MODULO = 'src/services/imagem-backup.service';
const avaliar = (entrada) => exigirModulo(MODULO).avaliarConjunto(entrada);
const SAIDA = Object.freeze({ VALIDO: 0, INVALIDO: 9 });

const sha = (caractere) => caractere.repeat(64);
const IMAGEM_A = `7/${sha('a')}`;
const IMAGEM_B = `7/${sha('b')}`;
const SHA_DO_DUMP = sha('7');
const SHA_DO_MANIFESTO = sha('8');
const CONJUNTO_ID = 'backup-20261020T030000Z-0001';

function congelarFundo(valor) {
  if (valor !== null && typeof valor === 'object') {
    for (const interno of Object.values(valor)) congelarFundo(interno);
    Object.freeze(valor);
  }
  return valor;
}

/** Um conjunto íntegro em todos os pontos; cada teste estraga UM aspecto. Congelado: a avaliação não pode alterar o que recebe. */
function conjuntoIntegro(alterar = {}) {
  const lista = [
    { chave: `${IMAGEM_A}/mestre.png`, sha256: sha('1') },
    { chave: `${IMAGEM_A}/exibicao.webp`, sha256: sha('2') },
    { chave: `${IMAGEM_A}/miniatura.webp`, sha256: sha('3') },
    { chave: `${IMAGEM_B}/mestre.jpg`, sha256: sha('4') },
    { chave: `${IMAGEM_B}/exibicao.webp`, sha256: sha('5') },
    { chave: `${IMAGEM_B}/miniatura.webp`, sha256: sha('6') },
  ];
  return congelarFundo({
    saidaDoProcedimento: 0,
    relatorio: { veredito: 'VALIDO' },
    manifesto: { arquivos: lista.map((item) => ({ ...item })) },
    listaDoSnapshot: lista.map((item) => ({ ...item })),
    verificacao: { concluida: true, ok: true },
    dump: { concluido: true, bytes: 4096, sha256Declarado: SHA_DO_DUMP, sha256Recalculado: SHA_DO_DUMP },
    identidade: { conjuntoId: CONJUNTO_ID, sha256Manifesto: SHA_DO_MANIFESTO },
    ...alterar,
  });
}

/** A prova de restauração DESTE conjunto (os três identificadores conferem); cada teste troca um deles para simular a prova de outro conjunto. */
const provaDesteConjunto = (alterar = {}) => ({ aprovada: true, conjuntoId: CONJUNTO_ID, sha256Dump: SHA_DO_DUMP, sha256Manifesto: SHA_DO_MANIFESTO, ...alterar });

function exigirInvalido(resultado, motivo, rotulo = motivo) {
  assert.equal(resultado.valido, false, `${rotulo}: não pode ser válido`);
  assert.equal(resultado.saida, SAIDA.INVALIDO, `${rotulo}: saída 9`);
  assert.equal(resultado.recuperavel, false, `${rotulo}: nunca recuperável`);
  assert.ok(Array.isArray(resultado.motivos) && resultado.motivos.includes(motivo), `${rotulo}: motivo ${motivo} em ${JSON.stringify(resultado.motivos)}`);
}

describe('[VBK] o conjunto íntegro (controle do contrato)', () => {
  test('VBK-01 — tudo confere: válido, saída 0, sem motivos; mas NÃO recuperável sem a prova de restauração', () => {
    const resultado = avaliar(conjuntoIntegro());
    assert.equal(resultado.valido, true);
    assert.equal(resultado.saida, SAIDA.VALIDO);
    assert.deepEqual(resultado.motivos, []);
    assert.equal(resultado.recuperavel, false, 'validade não é recuperabilidade');
  });
});

describe('[VBK] código de saída zero não basta', () => {
  test('VBK-02 — saída 0 SEM relatório, SEM manifesto, ou sem os dois: inválido', () => {
    exigirInvalido(avaliar(conjuntoIntegro({ relatorio: null })), 'RELATORIO_AUSENTE');
    exigirInvalido(avaliar(conjuntoIntegro({ manifesto: null })), 'MANIFESTO_AUSENTE');
    const semNada = avaliar(conjuntoIntegro({ relatorio: null, manifesto: null }));
    exigirInvalido(semNada, 'RELATORIO_AUSENTE', 'sem os dois');
    assert.ok(semNada.motivos.includes('MANIFESTO_AUSENTE'));
    exigirInvalido(avaliar(conjuntoIntegro({ relatorio: undefined })), 'RELATORIO_AUSENTE', 'relatório indefinido');
  });

  test('VBK-03 — relatório que não diz exatamente VALIDO nunca vira sucesso (INVALIDO, minúsculas, booleano, outro texto, sem o campo)', () => {
    for (const relatorio of [{ veredito: 'INVALIDO' }, { veredito: 'valido' }, { veredito: true }, { veredito: 'OK' }, { veredito: 'VALIDO ' }, {}, { veredito: { valor: 'VALIDO' } }]) {
      exigirInvalido(avaliar(conjuntoIntegro({ relatorio })), 'VEREDITO_NAO_VALIDO', JSON.stringify(relatorio));
    }
  });

  test('VBK-04 — relatório VALIDO com saída diferente de zero, ou saída ausente ou não inteira: inválido', () => {
    for (const saidaDoProcedimento of [1, 2, 130, -1, undefined, null, '0', 0.5]) {
      exigirInvalido(avaliar(conjuntoIntegro({ saidaDoProcedimento })), 'SAIDA_NAO_ZERO', String(saidaDoProcedimento));
    }
  });
});

describe('[VBK] o conteúdo copiado tem de conferir com a lista do snapshot', () => {
  test('VBK-05 — UM arquivo com SHA-256 diferente do exigido invalida o conjunto inteiro', () => {
    const base = conjuntoIntegro();
    const arquivos = base.manifesto.arquivos.map((item, i) => (i === 4 ? { ...item, sha256: sha('f') } : { ...item }));
    exigirInvalido(avaliar(conjuntoIntegro({ manifesto: { arquivos } })), 'SHA256_DIVERGENTE');
  });

  test('VBK-06 — falta na cópia UMA variante exigida pela lista: inválido; já um arquivo a MAIS (órfão) na cópia é tolerado', () => {
    const base = conjuntoIntegro();
    const semUma = base.manifesto.arquivos.filter((item) => item.chave !== `${IMAGEM_B}/miniatura.webp`).map((item) => ({ ...item }));
    exigirInvalido(avaliar(conjuntoIntegro({ manifesto: { arquivos: semUma } })), 'ARQUIVO_EXIGIDO_AUSENTE');

    const comOrfao = [...base.manifesto.arquivos.map((item) => ({ ...item })), { chave: `7/${sha('c')}/mestre.png`, sha256: sha('9') }];
    const resultado = avaliar(conjuntoIntegro({ manifesto: { arquivos: comOrfao } }));
    assert.equal(resultado.valido, true, 'órfão na cópia não invalida (C3-B)');
    assert.equal(resultado.saida, SAIDA.VALIDO);
  });

  test('VBK-07 — sem a lista do snapshot não há como provar nada: inválido; lista VAZIA (biblioteca sem imagens) com o resto íntegro é válida', () => {
    exigirInvalido(avaliar(conjuntoIntegro({ listaDoSnapshot: null })), 'LISTA_DO_SNAPSHOT_AUSENTE');
    exigirInvalido(avaliar(conjuntoIntegro({ listaDoSnapshot: undefined })), 'LISTA_DO_SNAPSHOT_AUSENTE', 'lista indefinida');
    const vazia = avaliar(conjuntoIntegro({ listaDoSnapshot: [], manifesto: { arquivos: [] } }));
    assert.equal(vazia.valido, true);
    assert.equal(vazia.saida, SAIDA.VALIDO);
  });

  test('VBK-08 — manifesto fora do formato (sem lista de arquivos, SHA-256 que não é hexadecimal de 64, sem chave, a mesma chave com dois hashes): inválido', () => {
    const base = conjuntoIntegro();
    const copia = () => base.manifesto.arquivos.map((item) => ({ ...item }));
    const casos = {
      'sem arquivos': {},
      'arquivos não é lista': { arquivos: 'tudo certo' },
      'SHA-256 maiúsculo': { arquivos: copia().map((item, i) => (i === 0 ? { ...item, sha256: item.sha256.toUpperCase().replace(/1/g, 'A') } : item)) },
      'SHA-256 curto': { arquivos: copia().map((item, i) => (i === 0 ? { ...item, sha256: 'abc' } : item)) },
      'sem chave': { arquivos: copia().map((item, i) => (i === 0 ? { sha256: item.sha256 } : item)) },
      'chave repetida com outro hash': { arquivos: [...copia(), { chave: `${IMAGEM_A}/mestre.png`, sha256: sha('e') }] },
    };
    for (const [rotulo, manifesto] of Object.entries(casos)) exigirInvalido(avaliar(conjuntoIntegro({ manifesto })), 'MANIFESTO_INVALIDO', rotulo);
  });
});

describe('[VBK] nenhuma etapa bem-sucedida esconde uma falha posterior', () => {
  test('VBK-09 — verificação independente que FALHOU, ou que não foi concluída (ou nem existe), invalida mesmo com tudo o mais íntegro', () => {
    exigirInvalido(avaliar(conjuntoIntegro({ verificacao: { concluida: true, ok: false } })), 'VERIFICACAO_FALHOU');
    exigirInvalido(avaliar(conjuntoIntegro({ verificacao: { concluida: false, ok: true } })), 'VERIFICACAO_NAO_CONCLUIDA');
    exigirInvalido(avaliar(conjuntoIntegro({ verificacao: null })), 'VERIFICACAO_NAO_CONCLUIDA', 'verificação ausente');
    exigirInvalido(avaliar(conjuntoIntegro({ verificacao: { concluida: true, ok: 'sim' } })), 'VERIFICACAO_FALHOU', 'ok não booleano');
  });

  test('VBK-10 — várias falhas juntas aparecem TODAS nos motivos (saída 0 e relatório VALIDO não mascaram hash divergente, arquivo ausente e verificação falha)', () => {
    const base = conjuntoIntegro();
    const arquivos = base.manifesto.arquivos
      .filter((item) => item.chave !== `${IMAGEM_A}/miniatura.webp`)
      .map((item) => (item.chave === `${IMAGEM_B}/mestre.jpg` ? { ...item, sha256: sha('d') } : { ...item }));
    const resultado = avaliar(conjuntoIntegro({ manifesto: { arquivos }, verificacao: { concluida: true, ok: false } }));
    for (const motivo of ['SHA256_DIVERGENTE', 'ARQUIVO_EXIGIDO_AUSENTE', 'VERIFICACAO_FALHOU']) exigirInvalido(resultado, motivo);
  });
});

describe('[VBK] o manifesto de imagens sozinho não prova o backup: o dump do PostgreSQL também tem de estar comprovado', () => {
  test('VBK-13 — imagens perfeitas, mas SEM evidência do dump (ausente ou indefinida): inválido', () => {
    exigirInvalido(avaliar(conjuntoIntegro({ dump: null })), 'DUMP_AUSENTE');
    exigirInvalido(avaliar(conjuntoIntegro({ dump: undefined })), 'DUMP_AUSENTE', 'dump indefinido');
  });

  test('VBK-14 — dump não concluído (falso, ausente ou não booleano) ou vazio (zero, negativo, não inteiro, ausente): inválido', () => {
    const dump = (alterar) => ({ concluido: true, bytes: 4096, sha256Declarado: SHA_DO_DUMP, sha256Recalculado: SHA_DO_DUMP, ...alterar });
    for (const concluido of [false, undefined, 'true', 1]) {
      exigirInvalido(avaliar(conjuntoIntegro({ dump: dump({ concluido }) })), 'DUMP_NAO_CONCLUIDO', `concluido=${String(concluido)}`);
    }
    for (const bytes of [0, -1, 1.5, undefined, '4096']) {
      exigirInvalido(avaliar(conjuntoIntegro({ dump: dump({ bytes }) })), 'DUMP_VAZIO', `bytes=${String(bytes)}`);
    }
  });

  test('VBK-15 — integridade do dump: SHA-256 recalculado diferente do declarado é DUMP_SHA256_DIVERGENTE; hash ausente ou fora do formato é DUMP_INVALIDO', () => {
    const dump = (alterar) => ({ concluido: true, bytes: 4096, sha256Declarado: SHA_DO_DUMP, sha256Recalculado: SHA_DO_DUMP, ...alterar });
    exigirInvalido(avaliar(conjuntoIntegro({ dump: dump({ sha256Recalculado: sha('e') }) })), 'DUMP_SHA256_DIVERGENTE');
    for (const [rotulo, alterar] of [
      ['sem declarado', { sha256Declarado: undefined }],
      ['sem recalculado', { sha256Recalculado: undefined }],
      ['declarado curto', { sha256Declarado: 'abc' }],
      ['recalculado com maiúsculas', { sha256Recalculado: 'A'.repeat(64), sha256Declarado: 'A'.repeat(64) }],
    ]) {
      exigirInvalido(avaliar(conjuntoIntegro({ dump: dump(alterar) })), 'DUMP_INVALIDO', rotulo);
    }
  });

  test('VBK-18 — identidade do conjunto ausente ou fora do formato (sem conjuntoId, conjuntoId vazio, SHA-256 do manifesto inválido): inválido', () => {
    for (const [rotulo, identidade] of [
      ['ausente', null],
      ['sem conjuntoId', { sha256Manifesto: SHA_DO_MANIFESTO }],
      ['conjuntoId vazio', { conjuntoId: '', sha256Manifesto: SHA_DO_MANIFESTO }],
      ['SHA-256 do manifesto curto', { conjuntoId: CONJUNTO_ID, sha256Manifesto: 'abc' }],
    ]) {
      exigirInvalido(avaliar(conjuntoIntegro({ identidade })), 'IDENTIDADE_INVALIDA', rotulo);
    }
  });
});

describe('[VBK] incompleto nunca é recuperável', () => {
  test('VBK-11 — recuperável SÓ quando válido E com a prova de restauração DESTE conjunto aprovada (exatamente true); prova genérica { aprovada: true } não serve; inválido com prova continua não recuperável', () => {
    const comProva = avaliar(conjuntoIntegro({ provaDeRestauracao: provaDesteConjunto() }));
    assert.equal(comProva.valido, true);
    assert.equal(comProva.recuperavel, true);

    const generica = avaliar(conjuntoIntegro({ provaDeRestauracao: { aprovada: true } }));
    assert.equal(generica.valido, true, 'a prova não muda a validade');
    assert.equal(generica.recuperavel, false, 'prova sem identidade não comprova a restauração deste conjunto');

    for (const provaDeRestauracao of [provaDesteConjunto({ aprovada: false }), provaDesteConjunto({ aprovada: 'true' }), provaDesteConjunto({ aprovada: 1 }), {}, null]) {
      assert.equal(avaliar(conjuntoIntegro({ provaDeRestauracao })).recuperavel, false, JSON.stringify(provaDeRestauracao));
    }

    const base = conjuntoIntegro();
    const incompleto = base.manifesto.arquivos.slice(0, 2).map((item) => ({ ...item }));
    const resultado = avaliar(conjuntoIntegro({ manifesto: { arquivos: incompleto }, provaDeRestauracao: provaDesteConjunto() }));
    exigirInvalido(resultado, 'ARQUIVO_EXIGIDO_AUSENTE', 'incompleto com prova');
  });

  test('VBK-16 — prova aprovada de OUTRO conjunto (outro id, outro dump ou outro manifesto, um de cada vez) é recusada: o conjunto segue válido, mas NÃO recuperável', () => {
    for (const [rotulo, alterar] of [
      ['outro conjuntoId', { conjuntoId: 'backup-20261019T030000Z-0001' }],
      ['outro SHA-256 do dump', { sha256Dump: sha('e') }],
      ['outro SHA-256 do manifesto', { sha256Manifesto: sha('e') }],
      ['sem o conjuntoId', { conjuntoId: undefined }],
      ['sem o SHA-256 do dump', { sha256Dump: undefined }],
      ['sem o SHA-256 do manifesto', { sha256Manifesto: undefined }],
    ]) {
      const resultado = avaliar(conjuntoIntegro({ provaDeRestauracao: provaDesteConjunto(alterar) }));
      assert.equal(resultado.valido, true, `${rotulo}: a validade não depende da prova`);
      assert.equal(resultado.recuperavel, false, `${rotulo}: a prova é de outro conjunto`);
    }
  });

  test('VBK-17 — a prova é comparada com o dump RECALCULADO, não com o declarado: dump cujo hash declarado bate com a prova, mas o recalculado não, é inválido e não recuperável', () => {
    const resultado = avaliar(conjuntoIntegro({
      dump: { concluido: true, bytes: 4096, sha256Declarado: SHA_DO_DUMP, sha256Recalculado: sha('e') },
      provaDeRestauracao: provaDesteConjunto(),
    }));
    exigirInvalido(resultado, 'DUMP_SHA256_DIVERGENTE');
  });

  test('VBK-12 — a avaliação é pura: não altera a entrada (congelada) e a mesma entrada dá sempre o mesmo resultado', () => {
    const entrada = conjuntoIntegro({ verificacao: { concluida: true, ok: false } });
    const primeiro = avaliar(entrada);
    const segundo = avaliar(entrada);
    assert.deepEqual(primeiro, segundo);
    assert.equal(Object.isFrozen(entrada.manifesto.arquivos[0]), true);
  });
});
