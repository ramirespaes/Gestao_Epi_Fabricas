'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const h = require('../helpers/pacote-padrao-ficticio');
const { poolProibido, armazenamentoProibido } = require('../helpers/instrumentacao-importacao');
const { lerConfiguracao } = require('../../src/config/imagens');
const {
  MIB, pacote, ZIP_INTEGRO, item, outroPng, ADULTERACOES, MANIFESTOS_INVALIDOS, HOSTIS, FORMATOS,
} = require('../helpers/cenarios-importacao-padrao');

/**
 * Importação da biblioteca padrão (Biblioteca de Imagens, Unidade 5A-2, RED): contratos SEM banco. Integridade física do pacote (PAD-02),
 * ZIP hostil (PAD-06), formato das imagens importadas (PAD-01, VAL-09) e a regra "integridade não comprovada = nenhuma escrita".
 * Os contratos de banco e de armazenamento reais (PAD-01, PAD-03, PAD-04, PAD-05, idempotência) estão em imagens-importar-padrao.integration.js.
 *
 * Módulo previsto: src/services/imagem-padrao-importacao.service.js
 *   verificarPacotePadrao({ pacote, pacoteSha256Esperado, limites? }) -> Promise<{ ok: true, pacote: { nome, bytes, sha256 }, manifesto: { linhas },
 *     verificados, arquivos: [{ entrada, papel: ORIGINAL|PADRONIZADO|MINIATURA, bytes, sha256Esperado, sha256Calculado, confere }] }>
 *   importarPacotePadrao(pool, { pacote, pacoteSha256Esperado, armazenamento, mapeamento = null, executar, destinoAutorizado?, limites? }) -> Promise<relatório>
 *     (com `executar: true` o destinoAutorizado { banco, oid } é obrigatório e conferido na conexão que grava; o contrato está em imagens-importar-padrao-destino.*)
 *   LIMITES_PADRAO = { maxBytesPorArquivo (= arquivoPadraoMaxBytes da configuração), maxBytesTotal, maxEntradas }
 *   - `pacote`: caminho ABSOLUTO do ZIP, só lido (nada é extraído nem criado ao lado dele). `pacoteSha256Esperado`: SHA-256 do ZIP aprovado, de FORA do
 *     pacote (64 hexadecimais minúsculos), conferido antes de abrir qualquer entrada: é a âncora que o CSV do próprio pacote não pode ser.
 *   - Os hashes dos 90 arquivos (30 originais, 30 PNG padronizados, 30 miniaturas) são CALCULADOS dos bytes e comparados ao manifesto e aos tamanhos
 *     dele; os originais são só conferidos (nunca interpretados como imagem, nunca importados).
 *   - Ordem das recusas: argumentos -> ZIP legível -> SHA-256 do ZIP -> estrutura e limites do ZIP -> manifesto -> presença -> SHA-256 e tamanho dos 90
 *     (relatório COMPLETO, todas as divergências) -> formato das imagens importadas. Tudo em memória, SEM tocar banco nem armazenamento.
 *   - Entrada de ZIP sem bits de tipo no modo Unix vale como arquivo comum (é o caso das 92 entradas do pacote real, modo 0o600); só link simbólico e
 *     outros tipos especiais explícitos são recusados.
 *   - Erro: Error com `codigo` e `detalhes` ([{ entrada, motivo, ... }]); a mensagem nunca leva caminho, nome cru de entrada nem hash.
 *     PACOTE_ARGUMENTOS_INVALIDOS | PACOTE_INDISPONIVEL | PACOTE_SHA256_DIVERGENTE | PACOTE_INVALIDO (CAMINHO_PERIGOSO, LINK_SIMBOLICO, TAMANHO_EXCEDIDO,
 *     ENTRADAS_DEMAIS, NOME_DUPLICADO, ENTRADA_NAO_PREVISTA, ZIP_CORROMPIDO) | PACOTE_MANIFESTO_INVALIDO | PACOTE_ARQUIVO_AUSENTE |
 *     PACOTE_HASH_DIVERGENTE (SHA256, TAMANHO) | IMAGEM_PADRAO_INVALIDA (ASSINATURA, ESTRUTURA, DIMENSOES, METADADOS, ANIMADA).
 *   - PACOTE_HASH_DIVERGENTE: relatório COMPLETO (todos os arquivos divergentes de uma vez), um detalhe por arquivo, com `esperado` (do manifesto) e
 *     `calculado` (dos bytes). O SHA-256 prevalece: TAMANHO só aparece quando o hash confere e o tamanho do manifesto não.
 */

const NOME_ZIP = 'Pacote_Ficticio_30_EPIs.zip';
const SERVICO = () => exigirModulo('src/services/imagem-padrao-importacao.service');
// Gravar exige destino autorizado (guarda de destino); estes testes param antes de abrir qualquer conexão, então só o formato importa.
const DESTINO_DE_TESTE = Object.freeze({ banco: 'banco_de_teste_ficticio', oid: '4242424' });

let raiz = null;
let contador = 0;
after(() => { if (raiz !== null) removerTemporarioSeguro(raiz); });

/** Grava o ZIP numa pasta própria do caso (dentro da raiz temporária exclusiva) e devolve caminho e SHA-256. */
function caso(zip) {
  if (raiz === null) raiz = criarRaizTemporaria();
  contador += 1;
  const dir = path.join(raiz, `caso-${contador}`);
  fs.mkdirSync(dir);
  return { dir, zip: h.gravarArquivo(dir, NOME_ZIP, zip), sha: h.sha256(zip) };
}

const verificar = (c, extra = {}) => SERVICO().verificarPacotePadrao({ pacote: c.zip, pacoteSha256Esperado: c.sha, ...extra });

/** Importação real com banco e armazenamento PROIBIDOS: se o importador tocar em qualquer um, a tentativa fica registrada. */
function importarSemPoderEscrever(c, extra = {}) {
  const banco = poolProibido();
  const disco = armazenamentoProibido();
  const chamada = SERVICO().importarPacotePadrao(banco.pool, { pacote: c.zip, pacoteSha256Esperado: c.sha, armazenamento: disco.armazenamento, mapeamento: null, executar: true, destinoAutorizado: DESTINO_DE_TESTE, ...extra });
  return { chamada, sql: banco.registros, armazenamento: disco.registros };
}

async function recusa(promessa, codigo) {
  let erro = null;
  try { await promessa; } catch (e) { erro = e; }
  assert.notEqual(erro, null, 'a operação deveria ser recusada');
  assert.equal(erro.codigo, codigo, `${erro.codigo}: ${erro.message}`);
  return erro;
}

const entradasDe = (erro) => (erro.detalhes ?? []).map((d) => d.entrada).sort();
const mensagemLimpa = (erro, c) => {
  assert.equal(erro.message.includes(c.dir) || /[0-9a-f]{64}/.test(erro.message) || erro.message.includes('\0'), false, `a mensagem vaza caminho, hash ou byte nulo: ${erro.message}`);
};

// ----------------------------------------------------------------------------------------------------------------------------------- cenários
/** Os lugares onde um arquivo hostil apareceria se alguém extraísse o ZIP: nenhum pode ter o arquivo. */
function lugaresDeEscape(c, alvo) {
  return [path.join(c.dir, alvo), path.join(c.dir, '02_PNG_PADRONIZADOS', alvo), path.join(raiz, alvo), path.join(path.dirname(raiz), alvo), path.join(os.tmpdir(), alvo), path.join(process.cwd(), alvo)];
}

const num = (k) => String(k + 1).padStart(2, '0');
const pick = (objeto, chaves) => Object.fromEntries(chaves.map((chave) => [chave, objeto[chave]]));
const semAcessoAoBanco = (t) => assert.deepEqual([t.sql, t.armazenamento], [[], []], 'nem o banco nem o armazenamento foram tocados');

describe('[INT-PAD] integridade física do pacote: o importador lê os bytes e calcula', () => {
  test('INT-PAD-01 — pacote íntegro: LÊ os 90 arquivos, calcula o SHA-256 dos bytes de cada um e confere com o manifesto; o ZIP e a pasta dele ficam intactos', async () => {
    const c = caso(ZIP_INTEGRO);
    const antes = { estado: fs.statSync(c.zip), pasta: fs.readdirSync(c.dir) };
    const r = await verificar(c);
    assert.equal(r.ok, true);
    assert.equal(r.verificados, 90);
    assert.deepEqual(pick(r.pacote, ['nome', 'bytes', 'sha256']), { nome: NOME_ZIP, bytes: ZIP_INTEGRO.length, sha256: c.sha });
    assert.equal(r.manifesto.linhas, 30);
    assert.equal(r.arquivos.length, 90);
    const porEntrada = new Map(r.arquivos.map((a) => [a.entrada, a]));
    for (const i of pacote.itens) {
      const arquivos = [[i.entradaOriginal, 'ORIGINAL', i.original], [i.entradaPadronizado, 'PADRONIZADO', i.padronizado], [i.entradaMiniatura, 'MINIATURA', i.miniatura]];
      for (const [entrada, papel, bytes] of arquivos) {
        assert.deepEqual(pick(porEntrada.get(entrada), ['papel', 'bytes', 'sha256Esperado', 'sha256Calculado', 'confere']), {
          papel, bytes: bytes.length, sha256Esperado: h.sha256(bytes), sha256Calculado: h.sha256(bytes), confere: true,
        }, entrada);
      }
    }
    assert.equal(JSON.stringify(r).includes(c.dir), false, 'o relatório não leva o caminho do ZIP');
    const depois = fs.statSync(c.zip);
    assert.deepEqual([depois.size, depois.mtimeMs, depois.ino], [antes.estado.size, antes.estado.mtimeMs, antes.estado.ino], 'o ZIP não foi tocado');
    assert.deepEqual(fs.readdirSync(c.dir), antes.pasta, 'nada foi criado ao lado do ZIP');
    assert.equal(h.sha256(fs.readFileSync(c.zip)), c.sha);
  });

  test('INT-PAD-02 — o mesmo pacote aprovado em outras formas de ZIP (modo com bits de tipo e sem compressão; sem LEIA-ME; manifesto só com LF) também é íntegro', async () => {
    const variantes = [
      ['modo 0o100644 e sem compressão', h.zipDoPacote(pacote, { modoUnix: 0o100644, compressao: 'stored' })],
      ['sem LEIA-ME.txt', h.zipDoPacote(pacote, { semLeiaMe: true })],
      ['manifesto só com LF', h.zipDoPacote(pacote, { manifesto: pacote.manifesto.replace(/\r\n/g, '\n') })],
    ];
    for (const [descricao, zip] of variantes) {
      const r = await verificar(caso(zip));
      assert.deepEqual([r.ok, r.verificados], [true, 90], descricao);
    }
  });

  test('INT-PAD-03 — o original só é CONFERIDO por hash: bytes que nem são imagem (com hash coerente no manifesto) não impedem a verificação', async () => {
    let alterado = pacote;
    for (const k of [0, 5, 29]) alterado = h.pacoteComItem(alterado, k, { original: Buffer.from(`isto não é uma imagem ${k}`) });
    const r = await verificar(caso(h.zipDoPacote(alterado)));
    assert.deepEqual([r.ok, r.verificados], [true, 90]);
  });

  ADULTERACOES.forEach(([descricao, ajuste, entrada, motivo, esperado, calculado], k) => {
    test(`INT-PAD-04.${num(k)} — ${descricao}: recusa pelo SHA-256 dos BYTES, com a entrada certa e os valores esperado e calculado`, async () => {
      const c = caso(h.zipDoPacote(pacote, ajuste));
      const erro = await recusa(verificar(c), 'PACOTE_HASH_DIVERGENTE');
      assert.deepEqual(entradasDe(erro), [entrada], 'exatamente a entrada adulterada, sem falso positivo');
      assert.deepEqual([erro.detalhes[0].motivo, erro.detalhes[0].esperado, erro.detalhes[0].calculado], [motivo, esperado, calculado], 'os valores vêm dos bytes do ZIP e do manifesto');
      mensagemLimpa(erro, c);
    });
  });

  test('INT-PAD-05 — várias adulterações de uma vez (PNG, miniatura e original, em itens diferentes): o relatório é COMPLETO e não acusa arquivo íntegro', async () => {
    const [a, b, d] = [pacote.itens[1], pacote.itens[14], pacote.itens[22]];
    const zip = h.zipDoPacote(pacote, { substituir: {
      [a.entradaPadronizado]: h.comByteInvertido(a.padronizado), [b.entradaMiniatura]: h.comByteInvertido(b.miniatura), [d.entradaOriginal]: h.comByteInvertido(d.original),
    } });
    const erro = await recusa(verificar(caso(zip)), 'PACOTE_HASH_DIVERGENTE');
    assert.deepEqual(entradasDe(erro), [a.entradaPadronizado, b.entradaMiniatura, d.entradaOriginal].sort());
  });

  [['original', 'entradaOriginal'], ['PNG padronizado', 'entradaPadronizado'], ['miniatura', 'entradaMiniatura']].forEach(([papel, campo], k) => {
    test(`INT-PAD-06.${num(k)} — ${papel} ausente do ZIP (listado no manifesto): PACOTE_ARQUIVO_AUSENTE com a entrada`, async () => {
      const c = caso(h.zipDoPacote(pacote, { remover: [pacote.itens[17][campo]] }));
      const erro = await recusa(verificar(c), 'PACOTE_ARQUIVO_AUSENTE');
      assert.deepEqual(entradasDe(erro), [pacote.itens[17][campo]]);
      mensagemLimpa(erro, c);
    });
  });

  test('INT-PAD-07 — adulteração COORDENADA (arquivo e manifesto trocados juntos): o manifesto não denuncia, mas o SHA-256 aprovado do ZIP, que vem de fora, recusa antes de abrir qualquer entrada', async () => {
    const aprovado = h.sha256(ZIP_INTEGRO);
    const c = caso(h.zipDoPacote(h.pacoteComItem(pacote, 9, { padronizado: outroPng })));
    const contraAprovado = { ...c, sha: aprovado };
    const erro = await recusa(verificar(contraAprovado), 'PACOTE_SHA256_DIVERGENTE');
    assert.deepEqual([erro.detalhes[0].esperado, erro.detalhes[0].calculado], [aprovado, c.sha]);
    mensagemLimpa(erro, c);
    const tentativa = importarSemPoderEscrever(contraAprovado);
    await recusa(tentativa.chamada, 'PACOTE_SHA256_DIVERGENTE');
    semAcessoAoBanco(tentativa);
    const r = await verificar(c);
    assert.equal(r.ok, true, 'o limite da proteção, dito em teste: a âncora é o hash aprovado de fora; sem ele, o manifesto coerente passa');
  });

  MANIFESTOS_INVALIDOS.forEach(([descricao, manifesto], k) => {
    test(`INT-PAD-08.${num(k)} — manifesto inválido (${descricao}): PACOTE_MANIFESTO_INVALIDO, antes de conferir qualquer arquivo`, async () => {
      const c = caso(h.zipDoPacote(pacote, { manifesto }));
      mensagemLimpa(await recusa(verificar(c), 'PACOTE_MANIFESTO_INVALIDO'), c);
      const tentativa = importarSemPoderEscrever(c);
      await recusa(tentativa.chamada, 'PACOTE_MANIFESTO_INVALIDO');
      semAcessoAoBanco(tentativa);
    });
  });

  test('INT-PAD-09 — ZIP sem o MANIFESTO_SHA256.csv: PACOTE_MANIFESTO_INVALIDO', async () => {
    await recusa(verificar(caso(h.zipDoPacote(pacote, { remover: ['MANIFESTO_SHA256.csv'] }))), 'PACOTE_MANIFESTO_INVALIDO');
  });

  test('INT-PAD-10 — ZIP inexistente, ou um caminho que é uma pasta: PACOTE_INDISPONIVEL, sem tocar banco nem armazenamento', async () => {
    const c = caso(ZIP_INTEGRO);
    for (const alvo of [path.join(c.dir, 'nao-existe.zip'), c.dir]) {
      await recusa(verificar({ ...c, zip: alvo }), 'PACOTE_INDISPONIVEL');
      const tentativa = importarSemPoderEscrever({ ...c, zip: alvo });
      await recusa(tentativa.chamada, 'PACOTE_INDISPONIVEL');
      semAcessoAoBanco(tentativa);
    }
  });

  test('INT-PAD-11 — argumentos inválidos: PACOTE_ARGUMENTOS_INVALIDOS, sem tocar banco nem armazenamento e sem eco do valor', async () => {
    const c = caso(ZIP_INTEGRO);
    const invalidos = [
      ['sem pacote', { pacote: undefined }], ['pacote relativo', { pacote: 'relativo/pacote.zip' }], ['pacote vazio', { pacote: '' }], ['pacote com byte nulo', { pacote: `${c.zip}\0.zip` }], ['pacote que não é texto', { pacote: 42 }],
      ['hash ausente', { pacoteSha256Esperado: undefined }], ['hash em maiúsculas', { pacoteSha256Esperado: c.sha.toUpperCase() }], ['hash curto', { pacoteSha256Esperado: c.sha.slice(0, 63) }],
      ['hash com espaço', { pacoteSha256Esperado: ` ${c.sha}` }], ['hash que não é texto', { pacoteSha256Esperado: 12345 }],
      ['executar não booleano', { executar: 'sim' }], ['executar ausente', { executar: undefined }], ['armazenamento ausente', { armazenamento: undefined }], ['mapeamento relativo', { mapeamento: 'mapeamento.csv' }],
      ['limite por arquivo zero', { limites: { maxBytesPorArquivo: 0 } }], ['limite total negativo', { limites: { maxBytesTotal: -1 } }], ['limite de entradas em texto', { limites: { maxEntradas: '10' } }], ['limite desconhecido', { limites: { maxCoisa: 1 } }],
    ];
    for (const [descricao, extra] of invalidos) {
      const tentativa = importarSemPoderEscrever(c, extra);
      const erro = await recusa(tentativa.chamada, 'PACOTE_ARGUMENTOS_INVALIDOS');
      semAcessoAoBanco(tentativa);
      mensagemLimpa(erro, c);
      for (const eco of ['relativo/pacote.zip', 'mapeamento.csv']) assert.equal(erro.message.includes(eco), false, `${descricao}: a mensagem ecoa o valor recebido`);
    }
    const semBanco = armazenamentoProibido();
    await recusa(SERVICO().importarPacotePadrao(null, { pacote: c.zip, pacoteSha256Esperado: c.sha, armazenamento: semBanco.armazenamento, mapeamento: null, executar: true }), 'PACOTE_ARGUMENTOS_INVALIDOS');
    for (const extra of [{ pacote: 'relativo.zip' }, { pacoteSha256Esperado: c.sha.toUpperCase() }, { limites: { maxEntradas: 0 } }]) await recusa(verificar(c, extra), 'PACOTE_ARGUMENTOS_INVALIDOS');
  });

  test('INT-PAD-12 — limites padrão: o do arquivo é o da configuração existente (5 MiB); os demais admitem o pacote real (92 entradas, cerca de 70 MiB) sem serem ilimitados', () => {
    const { LIMITES_PADRAO } = SERVICO();
    assert.equal(LIMITES_PADRAO.maxBytesPorArquivo, lerConfiguracao({}).arquivoPadraoMaxBytes);
    assert.ok(Number.isSafeInteger(LIMITES_PADRAO.maxBytesTotal) && LIMITES_PADRAO.maxBytesTotal >= 75 * MIB && LIMITES_PADRAO.maxBytesTotal <= 1024 * MIB);
    assert.ok(Number.isSafeInteger(LIMITES_PADRAO.maxEntradas) && LIMITES_PADRAO.maxEntradas >= 92 && LIMITES_PADRAO.maxEntradas <= 1000);
    assert.equal(Object.isFrozen(LIMITES_PADRAO), true);
  });
});

describe('[PAD-02] integridade não comprovada: nenhuma consulta ao banco e nenhuma operação no armazenamento', () => {
  const sempre = [
    ['miniatura ausente', () => h.zipDoPacote(pacote, { remover: [item.entradaMiniatura] }), 'PACOTE_ARQUIVO_AUSENTE'],
    ['PNG padronizado ausente', () => h.zipDoPacote(pacote, { remover: [item.entradaPadronizado] }), 'PACOTE_ARQUIVO_AUSENTE'],
    ['original ausente', () => h.zipDoPacote(pacote, { remover: [item.entradaOriginal] }), 'PACOTE_ARQUIVO_AUSENTE'],
    ['manifesto com 29 linhas', () => h.zipDoPacote(pacote, { manifesto: MANIFESTOS_INVALIDOS[1][1] }), 'PACOTE_MANIFESTO_INVALIDO'],
  ];
  const cenarios = [...ADULTERACOES.map(([descricao, ajuste]) => [descricao, () => h.zipDoPacote(pacote, ajuste), 'PACOTE_HASH_DIVERGENTE']), ...sempre];
  cenarios.forEach(([descricao, construir, codigo], k) => {
    test(`PAD-02.${num(k)} — ${descricao}: recusa ${codigo} com o banco e o armazenamento PROIBIDOS (a verificação de TODO o pacote vem antes de qualquer escrita)`, async () => {
      const tentativa = importarSemPoderEscrever(caso(construir()));
      await recusa(tentativa.chamada, codigo);
      semAcessoAoBanco(tentativa);
    });
  });
});

describe('[PAD-06] ZIP hostil: caminho perigoso, link simbólico, tamanho acima do limite, corrupção', () => {
  HOSTIS.forEach((cenario, k) => {
    test(`PAD-06.${num(k)} — ${cenario.descricao}: PACOTE_INVALIDO, nada extraído, nada escrito, nada fora do lugar`, async () => {
      const c = caso(cenario.construir());
      const extra = cenario.limites ? { limites: cenario.limites } : {};
      const erro = await recusa(verificar(c, extra), 'PACOTE_INVALIDO');
      if (cenario.motivo === null) assert.ok(erro.detalhes.length > 0, 'a recusa traz ao menos um detalhe');
      else assert.ok(erro.detalhes.some((d) => d.motivo === cenario.motivo), `motivos: ${JSON.stringify(erro.detalhes.map((d) => d.motivo))}`);
      mensagemLimpa(erro, c);
      const tentativa = importarSemPoderEscrever(c, extra);
      await recusa(tentativa.chamada, 'PACOTE_INVALIDO');
      semAcessoAoBanco(tentativa);
      assert.deepEqual(fs.readdirSync(c.dir), [NOME_ZIP], 'nada foi criado ao lado do ZIP');
      if (cenario.alvo) for (const lugar of lugaresDeEscape(c, cenario.alvo)) assert.equal(fs.existsSync(lugar), false, `o arquivo hostil apareceu em ${lugar}`);
    });
  });
});

describe('[FMT-PAD] formato das imagens importadas: PNG padronizado 1024x1024 e miniatura WebP 320x320, sem metadados, sem animação', () => {
  FORMATOS.forEach(([descricao, substitutos, entrada, motivo], k) => {
    test(`FMT-PAD.${num(k)} — ${descricao} (hash coerente com o manifesto): IMAGEM_PADRAO_INVALIDA/${motivo}, nada escrito`, async () => {
      const c = caso(h.zipDoPacote(h.pacoteComItem(pacote, 9, substitutos)));
      const erro = await recusa(verificar(c), 'IMAGEM_PADRAO_INVALIDA');
      assert.deepEqual(entradasDe(erro), [entrada]);
      assert.equal(erro.detalhes[0].motivo, motivo);
      mensagemLimpa(erro, c);
      const tentativa = importarSemPoderEscrever(c);
      await recusa(tentativa.chamada, 'IMAGEM_PADRAO_INVALIDA');
      semAcessoAoBanco(tentativa);
    });
  });
});
