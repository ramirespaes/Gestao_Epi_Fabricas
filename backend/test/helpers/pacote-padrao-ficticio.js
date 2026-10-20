'use strict';

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Pacote FICTÍCIO das 30 imagens padrão (Biblioteca de Imagens, Unidade 5A-2, RED). Reproduz a ESTRUTURA do pacote aprovado
 * (SafeWork_Biblioteca_30_EPIs_Padronizada.zip) sem nenhuma das 30 imagens reais:
 *   01_ORIGINAIS_PRESERVADOS/<nome>.png   PNG com bloco caBX (como o C2PA dos originais reais); nunca é importado, só conferido por hash;
 *   02_PNG_PADRONIZADOS/<nome>.png        PNG RGBA 1024x1024 de verdade (zlib), só IHDR, IDAT e IEND;
 *   03_MINIATURAS_WEBP/<nome>.webp        RIFF/WEBP com VP8X (alfa), ALPH e "VP8 ", canvas 320x320;
 *   MANIFESTO_SHA256.csv                  formato real: vírgula, CRLF, bbox_original entre aspas;  LEIA-ME.txt.
 * As miniaturas têm cabeçalhos coerentes e carga sintética: NÃO são decodificáveis. Tudo é determinístico (mesma semente, mesmos bytes).
 */

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

const TABELA_CRC = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = TABELA_CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const le16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const be32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

/** Bytes determinísticos (contador sobre SHA-256). */
function enchimento(semente, tamanho) {
  const saida = Buffer.alloc(tamanho);
  for (let posicao = 0, bloco = 0; posicao < tamanho; bloco += 1, posicao += 32) {
    crypto.createHash('sha256').update(`${semente}#${bloco}`).digest().copy(saida, posicao, 0, Math.min(32, tamanho - posicao));
  }
  return saida;
}

const corDe = (semente) => {
  const h = crypto.createHash('sha256').update(`cor-${semente}`).digest();
  return [h[0], h[1], h[2], 255];
};

// ---------------------------------------------------------------------------------------------------------------------------------- PNG
const ASSINATURA_PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function blocoPng(tipo, dados) {
  const nome = Buffer.from(tipo, 'latin1');
  return Buffer.concat([be32(dados.length), nome, dados, be32(crc32(Buffer.concat([nome, dados])))]);
}

function ihdr(largura, altura, profundidade = 8, tipoDeCor = 6, entrelacamento = 0) {
  const dados = Buffer.alloc(13);
  dados.writeUInt32BE(largura, 0);
  dados.writeUInt32BE(altura, 4);
  dados[8] = profundidade;
  dados[9] = tipoDeCor;
  dados[12] = entrelacamento;
  return dados;
}

/**
 * PNG RGBA válido: fundo transparente e um retângulo opaco de cor derivada da semente. `extras`: blocos a inserir, cada um
 * { tipo, dados, antesDoIdat = true }. `aposFim`: bytes depois do IEND.
 */
function pngFicticio({ largura = 1024, altura = 1024, semente = 'x', extras = [], aposFim = null } = {}) {
  const [r, g, b, a] = corDe(semente);
  const margem = Math.floor(largura * 0.07);
  const vazia = Buffer.alloc(1 + 4 * largura);
  const produto = Buffer.alloc(1 + 4 * largura);
  for (let x = margem; x < largura - margem; x += 1) produto.set([r, g, b, a], 1 + 4 * x);
  const linhas = [];
  for (let y = 0; y < altura; y += 1) linhas.push(y >= margem && y < altura - margem ? produto : vazia);
  const idat = zlib.deflateSync(Buffer.concat(linhas), { level: 1 });
  const antes = extras.filter((e) => e.antesDoIdat !== false).map((e) => blocoPng(e.tipo, e.dados));
  const depois = extras.filter((e) => e.antesDoIdat === false).map((e) => blocoPng(e.tipo, e.dados));
  return Buffer.concat([ASSINATURA_PNG, blocoPng('IHDR', ihdr(largura, altura)), ...antes, blocoPng('IDAT', idat), ...depois, blocoPng('IEND', Buffer.alloc(0)), aposFim ?? Buffer.alloc(0)]);
}

/** Original com manifesto C2PA fictício (bloco caBX): pequeno, porque nunca é lido como imagem, só por hash. */
function originalFicticio(semente) {
  return pngFicticio({
    largura: 64, altura: 64, semente: `original-${semente}`,
    extras: [{ tipo: 'caBX', dados: Buffer.concat([Buffer.from('c2pa-ficticio:'), enchimento(`c2pa-${semente}`, 160)]) }],
  });
}

// --------------------------------------------------------------------------------------------------------------------------------- WebP
const DONO_DA_FLAG = { EXIF: 0x08, 'XMP ': 0x04, ICCP: 0x20, ANIM: 0x02, ANMF: 0x02 };

function blocoRiff(tipo, dados) {
  return Buffer.concat([Buffer.from(tipo, 'latin1'), le32(dados.length), dados, dados.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/**
 * RIFF/WEBP no layout do pacote real: VP8X (alfa) + ALPH + "VP8 ". `extras`: blocos { tipo, dados } que a validação deve recusar
 * (EXIF, XMP , ICCP, ANIM); a flag do VP8X acompanha. O cabeçalho do quadro VP8 declara as mesmas dimensões da tela.
 */
function webpFicticio({ largura = 320, altura = 320, semente = 'x', extras = [] } = {}) {
  let flags = 0x10;
  for (const e of extras) flags |= DONO_DA_FLAG[e.tipo] ?? 0;
  const vp8x = Buffer.alloc(10);
  vp8x[0] = flags;
  vp8x.writeUIntLE(largura - 1, 4, 3);
  vp8x.writeUIntLE(altura - 1, 7, 3);
  const alph = Buffer.concat([Buffer.from([0x01]), enchimento(`alph-${semente}`, 24)]);
  const etiqueta = (32 << 5) | (1 << 4);
  const cabecalhoVp8 = Buffer.concat([Buffer.from([etiqueta & 0xff, (etiqueta >> 8) & 0xff, (etiqueta >> 16) & 0xff]), Buffer.from([0x9d, 0x01, 0x2a]), le16(largura), le16(altura)]);
  const variacao = crypto.createHash('sha256').update(`tamanho-${semente}`).digest()[0];
  const vp8 = Buffer.concat([cabecalhoVp8, enchimento(`vp8-${semente}`, 240 + variacao)]);
  const iccp = extras.filter((e) => e.tipo === 'ICCP').map((e) => blocoRiff('ICCP', e.dados));
  const outros = extras.filter((e) => e.tipo !== 'ICCP').map((e) => blocoRiff(e.tipo, e.dados));
  const corpo = Buffer.concat([Buffer.from('WEBP', 'latin1'), blocoRiff('VP8X', vp8x), ...iccp, blocoRiff('ALPH', alph), blocoRiff('VP8 ', vp8), ...outros]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), le32(corpo.length), corpo]);
}

// -------------------------------------------------------------------------------------------------------------------------- pacote e manifesto
const NOMES_BASE = Object.freeze([
  'Avental de Segurança', 'Botina de Segurança - Couro', 'Calça de Segurança - Eletricista', 'Calça de Segurança', 'Camiseta Azul', 'Capacete de Segurança',
  'Capuz de Segurança', 'Cinturão de Segurança com Talabarte - Trava-Quedas', 'Creme Protetor de Segurança', 'Luva Isolante de Borracha', 'Luva de Segurança Nitrila',
  'Luva de Segurança', 'Luva para Proteção contra Agentes Térmicos', 'Manga de Segurança para Corte', 'Manga de Segurança', 'Mangote de Segurança',
  'Perneira de Proteção Aluminizada', 'Protetor Auricular Concha', 'Protetor Auricular Plug', 'Protetor Facial', 'Respirador PFF2', 'Sapato de Segurança',
  'Vestimenta para Proteção do Tronco - Agente Térmico', 'Vestimenta para Proteção do Tronco - Camisa de Eletricista', 'Vestimenta para Proteção do Tronco - Camisa',
  'Vestimenta para Proteção do Tronco - Raspa', 'Vestimenta para Proteção do Tronco Aluminizada', 'Óculos de Proteção Fumê', 'Óculos de Proteção Incolor', 'Óculos de Proteção Sobrepor',
]);

const CABECALHO_MANIFESTO = 'nome,sha256_original,sha256_png_padronizado,sha256_miniatura_webp,bytes_original,bytes_padronizado,bytes_miniatura,bbox_original';
const LEIA_ME = 'SAFEWORK — BIBLIOTECA INICIAL DE 30 IMAGENS DE EPIs (FICTÍCIA, PARA TESTES)\r\nMANIFESTO_SHA256.csv: hashes SHA-256 dos três formatos e tamanho em bytes.\r\n';

const linhaDoManifesto = (i) => `${i.nome}.png,${i.sha256Original},${i.sha256Padronizado},${i.sha256Miniatura},${i.bytesOriginal},${i.bytesPadronizado},${i.bytesMiniatura},"(0, 13, 1232, 1254)"`;
const manifestoCsv = (itens) => `${[CABECALHO_MANIFESTO, ...itens.map(linhaDoManifesto)].join('\r\n')}\r\n`;

/** Item do pacote com os hashes e tamanhos CALCULADOS dos bytes. */
function recomporItem(nome, { original, padronizado, miniatura }) {
  return Object.freeze({
    nome,
    arquivoOrigem: `${nome}.png`,
    original,
    padronizado,
    miniatura,
    sha256Original: sha256(original),
    sha256Padronizado: sha256(padronizado),
    sha256Miniatura: sha256(miniatura),
    bytesOriginal: original.length,
    bytesPadronizado: padronizado.length,
    bytesMiniatura: miniatura.length,
    entradaOriginal: `01_ORIGINAIS_PRESERVADOS/${nome}.png`,
    entradaPadronizado: `02_PNG_PADRONIZADOS/${nome}.png`,
    entradaMiniatura: `03_MINIATURAS_WEBP/${nome}.webp`,
  });
}

let pacoteMemorizado = null;

/** O pacote base (30 itens). Memorizado por processo e congelado: quem precisa de variação usa `pacoteComItem`. */
function montarPacote() {
  if (pacoteMemorizado === null) {
    const itens = NOMES_BASE.map((nome) => recomporItem(nome, {
      original: originalFicticio(nome), padronizado: pngFicticio({ semente: nome }), miniatura: webpFicticio({ semente: nome }),
    }));
    pacoteMemorizado = Object.freeze({ itens: Object.freeze(itens), manifesto: manifestoCsv(itens), leiaMe: LEIA_ME });
  }
  return pacoteMemorizado;
}

/** Pacote igual ao base, com o item `indice` trocado por `substitutos` (bytes novos): manifesto REGERADO, ou seja, coerente com os arquivos. */
function pacoteComItem(pacote, indice, substitutos) {
  const itens = pacote.itens.map((item, i) => (i === indice ? recomporItem(item.nome, { original: item.original, padronizado: item.padronizado, miniatura: item.miniatura, ...substitutos }) : item));
  return Object.freeze({ ...pacote, itens: Object.freeze(itens), manifesto: manifestoCsv(itens) });
}

/** Manifesto do pacote com UMA célula trocada (a linha do item `indice`, a coluna pelo nome do cabeçalho). Os arquivos não mudam. */
function manifestoComCelula(pacote, indice, coluna, valor) {
  const cabecalho = CABECALHO_MANIFESTO.split(',');
  const posicao = cabecalho.indexOf(coluna);
  if (posicao < 0 || posicao > 6) throw new Error(`coluna inválida: ${coluna}`);
  const linhas = pacote.manifesto.split('\r\n');
  const partes = linhas[1 + indice].split(',');
  partes[posicao] = String(valor);
  linhas[1 + indice] = partes.join(',');
  return linhas.join('\r\n');
}

// -------------------------------------------------------------------------------------------------------------------------------------- ZIP
const DATA_DOS = ((2026 - 1980) << 9) | (10 << 5) | 17;

function entradasDoPacote(pacote) {
  const entradas = [];
  for (const i of pacote.itens) entradas.push({ nome: i.entradaOriginal, dados: i.original });
  for (const i of pacote.itens) entradas.push({ nome: i.entradaPadronizado, dados: i.padronizado });
  for (const i of pacote.itens) entradas.push({ nome: i.entradaMiniatura, dados: i.miniatura });
  entradas.push({ nome: 'MANIFESTO_SHA256.csv', dados: Buffer.from(pacote.manifesto, 'utf8') });
  entradas.push({ nome: 'LEIA-ME.txt', dados: Buffer.from(pacote.leiaMe, 'utf8') });
  return entradas;
}

/**
 * ZIP em memória. Cada entrada: { nome (texto ou Buffer cru), dados, compressao ('stored'|'deflate'), modoUnix, tamanhoDeclarado, crc }.
 * Os campos opcionais existem para fabricar ZIPs hostis (nome cru, link simbólico, tamanho que mente, CRC errado).
 */
function escreverZip(entradas) {
  const locais = [];
  const centrais = [];
  let deslocamento = 0;
  for (const e of entradas) {
    const nome = Buffer.isBuffer(e.nome) ? e.nome : Buffer.from(String(e.nome).normalize('NFC'), 'utf8');
    const metodo = (e.compressao ?? 'deflate') === 'stored' ? 0 : 8;
    const gravados = metodo === 8 ? zlib.deflateRawSync(e.dados, { level: 6 }) : e.dados;
    const crc = e.crc ?? crc32(e.dados);
    const declarado = e.tamanhoDeclarado ?? e.dados.length;
    const flags = nome.some((byte) => byte >= 0x80) ? 0x0800 : 0;
    const local = Buffer.concat([le32(0x04034b50), le16(20), le16(flags), le16(metodo), le16(0), le16(DATA_DOS), le32(crc), le32(gravados.length), le32(declarado), le16(nome.length), le16(0), nome]);
    locais.push(local, gravados);
    centrais.push(Buffer.concat([
      le32(0x02014b50), le16((3 << 8) | 20), le16(20), le16(flags), le16(metodo), le16(0), le16(DATA_DOS), le32(crc), le32(gravados.length), le32(declarado),
      le16(nome.length), le16(0), le16(0), le16(0), le16(0), le32((e.modoUnix ?? 0o600) << 16), le32(deslocamento), nome,
    ]));
    deslocamento += local.length + gravados.length;
  }
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.concat([le32(0x06054b50), le16(0), le16(0), le16(entradas.length), le16(entradas.length), le32(diretorio.length), le32(deslocamento), le16(0)]);
  return Buffer.concat([...locais, diretorio, fim]);
}

/**
 * Leitor INDEPENDENTE (oráculo dos testes; não é o importador): lê o diretório central, descomprime e confere o CRC de cada entrada.
 * Devolve { nome, nomeBytes, dados, metodo, modoUnix, inicioDosDados }.
 */
function lerZip(zip) {
  let fim = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  }
  if (fim < 0) throw new Error('ZIP sem registro de fim');
  const total = zip.readUInt16LE(fim + 10);
  let o = zip.readUInt32LE(fim + 16);
  const entradas = [];
  for (let n = 0; n < total; n += 1) {
    if (zip.readUInt32LE(o) !== 0x02014b50) throw new Error('diretório central corrompido');
    const metodo = zip.readUInt16LE(o + 10);
    const crcDeclarado = zip.readUInt32LE(o + 16);
    const tamanhoGravado = zip.readUInt32LE(o + 20);
    const tamanhoNome = zip.readUInt16LE(o + 28);
    const tamanhoExtra = zip.readUInt16LE(o + 30);
    const tamanhoComentario = zip.readUInt16LE(o + 32);
    const atributos = zip.readUInt32LE(o + 38);
    const local = zip.readUInt32LE(o + 42);
    const nomeBytes = zip.subarray(o + 46, o + 46 + tamanhoNome);
    const inicioDosDados = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const gravados = zip.subarray(inicioDosDados, inicioDosDados + tamanhoGravado);
    if (metodo !== 0 && metodo !== 8) throw new Error('método de compressão não suportado');
    const dados = metodo === 8 ? zlib.inflateRawSync(gravados) : Buffer.from(gravados);
    if (crc32(dados) !== crcDeclarado) throw new Error('CRC divergente');
    entradas.push({ nome: nomeBytes.toString('utf8'), nomeBytes: Buffer.from(nomeBytes), dados, metodo, modoUnix: atributos >>> 16, inicioDosDados });
    o += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }
  return { entradas };
}

/**
 * ZIP do pacote com ajustes: { substituir: { [entrada]: Buffer }, remover: [entrada], adicionar: [entradaCrua], manifesto: texto, semLeiaMe, modoUnix, compressao }.
 * Sem opções o ZIP imita o pacote real: método deflate, modo 0o600 (sem bits de tipo) e flag UTF-8 só nos nomes acentuados.
 * `adicionar` aceita entradas hostis (nome cru, modoUnix, tamanhoDeclarado, compressao).
 */
function zipDoPacote(pacote, {
  substituir = {}, remover = [], adicionar = [], manifesto = null, semLeiaMe = false, modoUnix = undefined, compressao = undefined,
} = {}) {
  let entradas = entradasDoPacote(pacote)
    .filter((e) => !remover.includes(e.nome) && !(semLeiaMe && e.nome === 'LEIA-ME.txt'))
    .map((e) => ({ ...e, modoUnix, compressao }));
  entradas = entradas.map((e) => {
    if (e.nome === 'MANIFESTO_SHA256.csv' && manifesto !== null) return { ...e, dados: Buffer.from(manifesto, 'utf8') };
    return Object.hasOwn(substituir, e.nome) ? { ...e, dados: substituir[e.nome] } : e;
  });
  return escreverZip([...entradas, ...adicionar]);
}

/** Cópia do buffer com UM byte invertido (padrão: no meio). O hash muda; o resto do arquivo é igual. */
function comByteInvertido(bytes, posicao = Math.floor(bytes.length / 2)) {
  const copia = Buffer.from(bytes);
  copia[posicao] ^= 0xff;
  return copia;
}

/** ZIP com UM byte do conteúdo de uma entrada invertido DENTRO do arquivo ZIP, sem corrigir o CRC (corrupção de transporte). */
function zipComDadosCorrompidos(zip, nomeEntrada) {
  const alvo = lerZip(zip).entradas.find((e) => e.nome === nomeEntrada);
  if (alvo === undefined) throw new Error('entrada inexistente');
  return comByteInvertido(zip, alvo.inicioDosDados + 3);
}

function gravarArquivo(diretorio, nome, bytes) {
  const caminho = path.join(diretorio, nome);
  fs.writeFileSync(caminho, bytes, { flag: 'wx', mode: 0o600 });
  return caminho;
}

// ------------------------------------------------------------------------------------------------------------------ analisadores (oráculos)
/** Estrutura de um PNG: assinatura, IHDR, blocos na ordem, CRCs e bytes depois do IEND. Só para os controles dos fixtures. */
function analisarPng(bytes) {
  const r = { assinaturaOk: bytes.length >= 8 && bytes.subarray(0, 8).equals(ASSINATURA_PNG), largura: null, altura: null, profundidade: null, tipoDeCor: null, entrelacamento: null, blocos: [], crcsOk: true, bytesAposFim: 0, idat: Buffer.alloc(0) };
  if (!r.assinaturaOk) return r;
  const idats = [];
  let o = 8;
  while (o + 12 <= bytes.length) {
    const tamanho = bytes.readUInt32BE(o);
    const tipo = bytes.toString('latin1', o + 4, o + 8);
    if (bytes.readUInt32BE(o + 8 + tamanho) !== crc32(bytes.subarray(o + 4, o + 8 + tamanho))) r.crcsOk = false;
    r.blocos.push(tipo);
    if (tipo === 'IHDR') {
      r.largura = bytes.readUInt32BE(o + 8);
      r.altura = bytes.readUInt32BE(o + 12);
      [r.profundidade, r.tipoDeCor, , , r.entrelacamento] = bytes.subarray(o + 16, o + 21);
    }
    if (tipo === 'IDAT') idats.push(bytes.subarray(o + 8, o + 8 + tamanho));
    o += 12 + tamanho;
    if (tipo === 'IEND') break;
  }
  r.bytesAposFim = bytes.length - o;
  r.idat = Buffer.concat(idats);
  return r;
}

/** Estrutura de um RIFF/WEBP: tamanho do RIFF, blocos, VP8X e cabeçalho do quadro "VP8 ". Só para os controles dos fixtures. */
function analisarWebp(bytes) {
  const r = { riff: bytes.toString('latin1', 0, 4), formato: bytes.toString('latin1', 8, 12), tamanhoRiffConfere: bytes.readUInt32LE(4) + 8 === bytes.length, blocos: [], vp8x: null, vp8: null };
  let o = 12;
  while (o + 8 <= bytes.length) {
    const tipo = bytes.toString('latin1', o, o + 4);
    const tamanho = bytes.readUInt32LE(o + 4);
    r.blocos.push(tipo);
    if (tipo === 'VP8X') r.vp8x = { flags: bytes[o + 8], largura: 1 + bytes.readUIntLE(o + 12, 3), altura: 1 + bytes.readUIntLE(o + 15, 3) };
    if (tipo === 'VP8 ') r.vp8 = { quadroChave: (bytes[o + 8] & 1) === 0, codigoInicial: bytes.subarray(o + 11, o + 14).equals(Buffer.from([0x9d, 0x01, 0x2a])), largura: bytes.readUInt16LE(o + 14) & 0x3fff, altura: bytes.readUInt16LE(o + 16) & 0x3fff };
    o += 8 + tamanho + (tamanho % 2);
  }
  return r;
}

// ------------------------------------------------------------------------------------------------------------------ mapeamento de tipos
// Mesmo formato do CSV de proposta da Etapa 0: BOM, ponto e vírgula, todos os campos entre aspas, terminação LF.
const CABECALHO_MAPEAMENTO = ['n', 'nome_base', 'arquivo_padronizado', 'tipo_sugerido', 'confianca', 'observacao', 'decisao_humana (APROVAR/AJUSTAR/REJEITAR)', 'aprovado_por', 'data_aprovacao'];
const TIPO_E_CONFIANCA_ESPECIAIS = Object.freeze({
  'Botina de Segurança - Couro': ['Sapato de Segurança', 'MÉDIA'],
  'Calça de Segurança - Eletricista': ['Calça de Segurança', 'MÉDIA'],
  'Vestimenta para Proteção do Tronco - Camisa de Eletricista': ['Vestimenta para Proteção do Tronco - Camisa', 'MÉDIA'],
  'Cinturão de Segurança com Talabarte - Trava-Quedas': ['Cinturão de Segurança com Talabarte/Trava-Quedas', 'ALTA'],
  'Camiseta Azul': ['(sem correspondência)', 'SEM'],
});

/** Linhas da proposta (nenhuma decisão) para o pacote; `decisoes[nome] = { decisao, por, data }` preenche a aprovação de linhas escolhidas. */
function linhasDeMapeamento(pacote, decisoes = {}) {
  return pacote.itens.map((item, indice) => {
    const [tipo, confianca] = TIPO_E_CONFIANCA_ESPECIAIS[item.nome] ?? [item.nome, 'ALTA'];
    const d = decisoes[item.nome] ?? {};
    return { n: indice + 1, nome_base: item.nome, arquivo_padronizado: item.entradaPadronizado, tipo_sugerido: tipo, confianca, observacao: 'Observação fictícia da proposta.', decisao: d.decisao ?? '', por: d.por ?? '', data: d.data ?? '' };
  });
}

function mapeamentoCsv(linhas) {
  const campo = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const corpo = linhas.map((l) => [l.n, l.nome_base, l.arquivo_padronizado, l.tipo_sugerido, l.confianca, l.observacao, l.decisao, l.por, l.data].map(campo).join(';'));
  return `\uFEFF${[CABECALHO_MAPEAMENTO.map(campo).join(';'), ...corpo].join('\n')}\n`;
}

// ------------------------------------------------------------------------------------------------------------------------ entradas hostis
/**
 * Entradas de ZIP perigosas, prontas para `adicionar` em zipDoPacote. `marca` torna o nome único: se alguma for extraída para fora de onde
 * deveria, o teste a encontra. Cada uma diz o motivo que a recusa deve registrar.
 */
function entradasHostis(marca) {
  const alvo = `${marca}.png`;
  const dados = Buffer.from('conteudo-hostil');
  const bruto = (...partes) => Buffer.concat(partes.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))));
  return [
    { id: 'dois pontos no início', alvo, entrada: { nome: `../${alvo}`, dados }, motivo: 'CAMINHO_PERIGOSO' },
    { id: 'dois pontos no meio do caminho', alvo, entrada: { nome: `02_PNG_PADRONIZADOS/../../${alvo}`, dados }, motivo: 'CAMINHO_PERIGOSO' },
    { id: 'caminho absoluto', alvo, entrada: { nome: `/${alvo}`, dados }, motivo: 'CAMINHO_PERIGOSO' },
    { id: 'unidade de disco', alvo, entrada: { nome: `C:/${alvo}`, dados }, motivo: 'CAMINHO_PERIGOSO' },
    { id: 'barra invertida', alvo, entrada: { nome: `02_PNG_PADRONIZADOS\\${alvo}`, dados }, motivo: 'CAMINHO_PERIGOSO' },
    { id: 'byte nulo no nome', alvo, entrada: { nome: bruto('02_PNG_PADRONIZADOS/', Buffer.from([0]), alvo), dados }, motivo: 'CAMINHO_PERIGOSO' },
    { id: 'caractere de controle no nome', alvo, entrada: { nome: `02_PNG_PADRONIZADOS/${marca}\n.png`, dados }, motivo: 'CAMINHO_PERIGOSO' },
    { id: 'link simbólico', alvo, entrada: { nome: `02_PNG_PADRONIZADOS/${alvo}`, dados: Buffer.from('/etc/passwd'), modoUnix: 0o120777 }, motivo: 'LINK_SIMBOLICO' },
  ];
}

module.exports = {
  sha256, crc32, enchimento, NOMES_BASE, CABECALHO_MANIFESTO, ASSINATURA_PNG,
  pngFicticio, originalFicticio, webpFicticio, blocoPng, blocoRiff,
  montarPacote, recomporItem, pacoteComItem, manifestoCsv, manifestoComCelula,
  entradasDoPacote, escreverZip, lerZip, zipDoPacote, comByteInvertido, zipComDadosCorrompidos, gravarArquivo,
  analisarPng, analisarWebp, CABECALHO_MAPEAMENTO, linhasDeMapeamento, mapeamentoCsv, entradasHostis,
};
