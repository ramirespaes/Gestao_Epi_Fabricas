'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const h = require('../helpers/pacote-padrao-ficticio');
const { lerConfiguracao } = require('../../src/config/imagens');

/**
 * CONTROLES dos fixtures da importação da biblioteca padrão (Unidade 5A-2, RED). Passam hoje: provam que o pacote fictício tem a estrutura do
 * aprovado e que cada cenário de adulteração ou de ZIP hostil é REAL (medido por um oráculo daqui, independente do importador). Assim, no RED,
 * um teste de contrato só pode falhar por ausência do importador, nunca por defeito de fixture.
 */

const pacote = h.montarPacote();

/** Oráculo: lê o ZIP, calcula SHA-256 e tamanho de cada arquivo dos 90 e compara com o manifesto DENTRO do ZIP. */
function divergencias(zip) {
  const porNome = new Map(h.lerZip(zip).entradas.map((e) => [e.nome, e.dados]));
  const linhas = porNome.get('MANIFESTO_SHA256.csv').toString('utf8').split('\r\n').slice(1).filter(Boolean).map((l) => l.split(','));
  const ruins = [];
  for (const [nome, sOriginal, sPadronizado, sMiniatura, bOriginal, bPadronizado, bMiniatura] of linhas) {
    const base = nome.replace(/\.png$/, '');
    const conferencias = [
      [`01_ORIGINAIS_PRESERVADOS/${nome}`, sOriginal, bOriginal], [`02_PNG_PADRONIZADOS/${nome}`, sPadronizado, bPadronizado], [`03_MINIATURAS_WEBP/${base}.webp`, sMiniatura, bMiniatura],
    ];
    for (const [entrada, hash, bytes] of conferencias) {
      const dados = porNome.get(entrada);
      if (dados === undefined) ruins.push({ entrada, motivo: 'AUSENTE' });
      else if (h.sha256(dados) !== hash || dados.length !== Number(bytes)) ruins.push({ entrada, motivo: 'DIVERGE' });
    }
  }
  return ruins;
}

describe('[CTRL-PAD] fixtures do pacote fictício', () => {
  test('CTRL-PAD-01 — 30 itens com os nomes reais, 90 hashes distintos e manifesto no formato do aprovado (cabeçalho, CRLF, bbox entre aspas), coerente com os bytes', () => {
    assert.deepEqual(pacote.itens.map((i) => i.nome), h.NOMES_BASE);
    assert.equal(new Set(pacote.itens.flatMap((i) => [i.sha256Original, i.sha256Padronizado, i.sha256Miniatura])).size, 90);
    const linhas = pacote.manifesto.split('\r\n');
    assert.equal(linhas.length, 32, 'cabeçalho, 30 linhas e a quebra final');
    assert.equal(linhas[0], h.CABECALHO_MANIFESTO);
    assert.equal(linhas[31], '');
    pacote.itens.forEach((item, i) => {
      assert.match(linhas[1 + i], /,"\(0, 13, 1232, 1254\)"$/);
      const [nome, sO, sP, sM, bO, bP, bM] = linhas[1 + i].split(',');
      assert.deepEqual([nome, sO, sP, sM, Number(bO), Number(bP), Number(bM)], [
        `${item.nome}.png`, h.sha256(item.original), h.sha256(item.padronizado), h.sha256(item.miniatura), item.original.length, item.padronizado.length, item.miniatura.length,
      ], item.nome);
    });
  });

  test('CTRL-PAD-02 — os 30 PNG padronizados são PNG de verdade: 1024x1024 RGBA de 8 bits, sem entrelaçamento, só IHDR/IDAT/IEND, CRCs íntegros, nada depois do IEND e IDAT que descomprime ao tamanho exato', () => {
    for (const item of pacote.itens) {
      const a = h.analisarPng(item.padronizado);
      assert.deepEqual([a.assinaturaOk, a.largura, a.altura, a.profundidade, a.tipoDeCor, a.entrelacamento, a.crcsOk, a.bytesAposFim], [true, 1024, 1024, 8, 6, 0, true, 0], item.nome);
      assert.deepEqual(a.blocos, ['IHDR', 'IDAT', 'IEND'], item.nome);
      assert.equal(zlib.inflateSync(a.idat).length, 1024 * (1 + 4 * 1024), item.nome);
    }
  });

  test('CTRL-PAD-03 — as 30 miniaturas têm o layout do aprovado: RIFF/WEBP de tamanho coerente, blocos VP8X, ALPH e "VP8 ", alfa ligado, tela 320x320 e quadro VP8 chave com as mesmas dimensões', () => {
    for (const item of pacote.itens) {
      const a = h.analisarWebp(item.miniatura);
      assert.deepEqual([a.riff, a.formato, a.tamanhoRiffConfere], ['RIFF', 'WEBP', true], item.nome);
      assert.deepEqual(a.blocos, ['VP8X', 'ALPH', 'VP8 '], item.nome);
      assert.deepEqual(a.vp8x, { flags: 0x10, largura: 320, altura: 320 }, item.nome);
      assert.deepEqual(a.vp8, { quadroChave: true, codigoInicial: true, largura: 320, altura: 320 }, item.nome);
    }
  });

  test('CTRL-PAD-04 — só os originais carregam o bloco caBX (C2PA fictício); o padronizado e a miniatura não o têm', () => {
    const marca = Buffer.from('caBX');
    for (const item of pacote.itens) {
      assert.deepEqual(h.analisarPng(item.original).blocos, ['IHDR', 'caBX', 'IDAT', 'IEND'], item.nome);
      assert.equal(item.original.includes(marca), true, item.nome);
      assert.equal(item.padronizado.includes(marca), false, item.nome);
      assert.equal(item.miniatura.includes(marca), false, item.nome);
    }
  });

  test('CTRL-PAD-05 — o ZIP imita o pacote real: 92 entradas, nomes NFC, modo 0o600 sem bits de tipo, deflate; o leitor independente devolve os mesmos bytes (e a variante com bits de tipo e sem compressão também lê)', () => {
    const esperado = new Map(h.entradasDoPacote(pacote).map((e) => [e.nome, e.dados]));
    const { entradas } = h.lerZip(h.zipDoPacote(pacote));
    assert.equal(entradas.length, 92);
    assert.deepEqual(entradas.map((e) => e.nome).sort(), [...esperado.keys()].sort());
    assert.ok(entradas.every((e) => e.nome === e.nome.normalize('NFC') && e.modoUnix === 0o600 && e.metodo === 8));
    assert.ok(entradas.every((e) => e.dados.equals(esperado.get(e.nome))));
    const pastas = new Map();
    for (const e of entradas) { const pasta = e.nome.includes('/') ? e.nome.split('/')[0] : '(raiz)'; pastas.set(pasta, (pastas.get(pasta) ?? 0) + 1); }
    assert.deepEqual(Object.fromEntries(pastas), { '01_ORIGINAIS_PRESERVADOS': 30, '02_PNG_PADRONIZADOS': 30, '03_MINIATURAS_WEBP': 30, '(raiz)': 2 });
    const variante = h.lerZip(h.zipDoPacote(pacote, { modoUnix: 0o100644, compressao: 'stored' })).entradas;
    assert.ok(variante.every((e) => e.modoUnix === 0o100644 && e.metodo === 0 && e.dados.equals(esperado.get(e.nome))));
  });

  test('CTRL-PAD-06 — os construtores de cenário fazem exatamente o que dizem (troca coerente, célula única, um byte, corrupção de transporte)', () => {
    const outro = h.pngFicticio({ semente: 'outro-png' });
    const trocado = h.pacoteComItem(pacote, 4, { padronizado: outro });
    assert.equal(trocado.itens[4].sha256Padronizado, h.sha256(outro));
    assert.deepEqual(trocado.itens.map((i, k) => (k === 4 ? null : i.sha256Padronizado)), pacote.itens.map((i, k) => (k === 4 ? null : i.sha256Padronizado)));
    const antes = pacote.manifesto.split('\r\n');
    const depois = trocado.manifesto.split('\r\n');
    assert.deepEqual(depois.map((l, k) => k).filter((k) => depois[k] !== antes[k]), [5], 'só a linha do item trocado muda');

    const celula = h.manifestoComCelula(pacote, 2, 'sha256_png_padronizado', 'a'.repeat(64)).split('\r\n');
    assert.deepEqual(celula.map((l, k) => k).filter((k) => celula[k] !== antes[k]), [3]);
    assert.equal(celula[3].split(',')[2], 'a'.repeat(64));

    const bytes = pacote.itens[0].padronizado;
    const invertido = h.comByteInvertido(bytes);
    assert.equal(invertido.length, bytes.length);
    assert.equal([...bytes].filter((b, k) => b !== invertido[k]).length, 1);

    const corrompido = h.zipComDadosCorrompidos(h.zipDoPacote(pacote), pacote.itens[0].entradaMiniatura);
    assert.throws(() => h.lerZip(corrompido), 'byte invertido dentro do ZIP: o leitor recusa (fluxo deflate ou CRC)');
    const crcErrado = h.escreverZip([{ nome: 'x.bin', dados: Buffer.from('abc'), compressao: 'stored', crc: 123 }]);
    assert.throws(() => h.lerZip(crcErrado), /CRC divergente/);
  });

  test('CTRL-PAD-07 — cada adulteração dos testes é REAL: o oráculo acha exatamente a entrada adulterada, e a coordenada passa pelo manifesto mas muda o hash do ZIP', () => {
    const base = h.zipDoPacote(pacote);
    assert.deepEqual(divergencias(base), [], 'o pacote íntegro não tem divergência');
    const i = pacote.itens[9];
    const casos = [
      ['PNG trocado por outro PNG válido', { substituir: { [i.entradaPadronizado]: h.pngFicticio({ semente: 'troca' }) } }, i.entradaPadronizado],
      ['PNG com um byte invertido', { substituir: { [i.entradaPadronizado]: h.comByteInvertido(i.padronizado) } }, i.entradaPadronizado],
      ['WebP trocado por outro', { substituir: { [i.entradaMiniatura]: h.webpFicticio({ semente: 'troca' }) } }, i.entradaMiniatura],
      ['WebP com um byte invertido', { substituir: { [i.entradaMiniatura]: h.comByteInvertido(i.miniatura) } }, i.entradaMiniatura],
      ['original com um byte invertido', { substituir: { [i.entradaOriginal]: h.comByteInvertido(i.original) } }, i.entradaOriginal],
      ['hash do manifesto alterado', { manifesto: h.manifestoComCelula(pacote, 9, 'sha256_png_padronizado', '0'.repeat(64)) }, i.entradaPadronizado],
      ['tamanho do manifesto alterado', { manifesto: h.manifestoComCelula(pacote, 9, 'bytes_miniatura', i.miniatura.length + 1) }, i.entradaMiniatura],
    ];
    for (const [descricao, ajuste, entrada] of casos) {
      assert.deepEqual(divergencias(h.zipDoPacote(pacote, ajuste)), [{ entrada, motivo: 'DIVERGE' }], descricao);
    }
    for (const entrada of [i.entradaOriginal, i.entradaPadronizado, i.entradaMiniatura]) {
      assert.deepEqual(divergencias(h.zipDoPacote(pacote, { remover: [entrada] })), [{ entrada, motivo: 'AUSENTE' }], `ausente: ${entrada}`);
    }
    const coordenado = h.zipDoPacote(h.pacoteComItem(pacote, 9, { padronizado: h.pngFicticio({ semente: 'troca' }) }));
    assert.deepEqual(divergencias(coordenado), [], 'arquivo e manifesto coerentes entre si: só o hash do ZIP inteiro denuncia');
    assert.notEqual(h.sha256(coordenado), h.sha256(base));
  });

  test('CTRL-PAD-08 — as entradas hostis chegam ao ZIP com o nome cru e o tipo pretendidos', () => {
    const hostis = h.entradasHostis('marca-controle');
    assert.ok(hostis.length >= 8);
    for (const { id, entrada, motivo } of hostis) {
      const lidas = h.lerZip(h.zipDoPacote(pacote, { adicionar: [entrada] })).entradas;
      assert.equal(lidas.length, 93, id);
      const lida = lidas[92];
      const esperado = Buffer.isBuffer(entrada.nome) ? entrada.nome : Buffer.from(entrada.nome, 'utf8');
      assert.ok(lida.nomeBytes.equals(esperado), id);
      if (motivo === 'LINK_SIMBOLICO') assert.equal(lida.modoUnix & 0o170000, 0o120000, id);
    }
    assert.ok(hostis.some((x) => x.entrada.nome.includes('..')));
    assert.ok(hostis.some((x) => Buffer.isBuffer(x.entrada.nome) && x.entrada.nome.includes(0)));
  });

  test('CTRL-PAD-09 — o pacote fictício respeita os limites vigentes da configuração (PNG e original até 5 MiB, miniatura até 64 KiB)', () => {
    const c = lerConfiguracao({});
    for (const item of pacote.itens) {
      assert.ok(item.padronizado.length <= c.arquivoPadraoMaxBytes && item.original.length <= c.arquivoPadraoMaxBytes, item.nome);
      assert.ok(item.miniatura.length <= c.miniatura.bytesMax, item.nome);
    }
  });

  test('CTRL-PAD-10 — o CSV de mapeamento tem o formato da proposta (BOM, ponto e vírgula, aspas, LF), 30 linhas, nenhuma decisão, e as exceções reais (3 MÉDIA, 1 SEM, Cinturão com "/")', () => {
    const csv = h.mapeamentoCsv(h.linhasDeMapeamento(pacote));
    assert.ok(csv.startsWith('﻿"n";"nome_base";"arquivo_padronizado";"tipo_sugerido";"confianca";"observacao";"decisao_humana (APROVAR/AJUSTAR/REJEITAR)";"aprovado_por";"data_aprovacao"\n'));
    assert.equal(csv.includes('\r'), false);
    const linhas = csv.replace(/^﻿/, '').split('\n');
    assert.equal(linhas.length, 32);
    assert.ok(linhas.slice(1, 31).every((l) => l.endsWith(';"";"";""')), 'nenhuma decisão preenchida');
    assert.equal(linhas.filter((l) => l.includes(';"MÉDIA";')).length, 3);
    assert.equal(linhas.filter((l) => l.includes(';"SEM";')).length, 1);
    assert.ok(linhas.some((l) => l.includes('"(sem correspondência)";"SEM"')));
    assert.ok(linhas.some((l) => l.includes('"Cinturão de Segurança com Talabarte/Trava-Quedas";"ALTA"')));
    const aprovada = h.mapeamentoCsv(h.linhasDeMapeamento(pacote, { 'Avental de Segurança': { decisao: 'APROVAR', por: 'Ramires', data: '2026-10-17' } }));
    assert.ok(aprovada.includes(';"APROVAR";"Ramires";"2026-10-17"\n'));
  });
});
