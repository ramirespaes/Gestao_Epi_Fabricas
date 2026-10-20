'use strict';

const { inspecionarContainer, ErroDeImagem, CODIGOS, PEDACOS_DE_METADADOS } = require('../utils/imagem-container');
const { serializarSucesso, serializarRecusa } = require('../utils/imagem-quadro');
const { lerParametros, validarParametros } = require('../utils/imagem-parametros');

/**
 * Decodificador de imagens (Biblioteca de Imagens, Unidade 5C-4). Roda em PROCESSO FILHO (ver imagem-processador.service.js): recebe os bytes do envio pela entrada padrão e os
 * parâmetros numéricos como único argumento, devolve um quadro pela saída padrão. Não lê ambiente, arquivo, banco nem rede: só importa o sharp e utilitários puros.
 * Saída: mestre PNG 1024x1024, exibição WebP 640x640 e miniatura WebP 320x320 — proporção preservada, SEM ampliar, centralizadas em tela transparente, sRGB, sem metadados,
 * orientação EXIF aplicada.
 */

const TRANSPARENTE = Object.freeze({ r: 0, g: 0, b: 0, alpha: 0 });
const QUALIDADES_EXIBICAO = Object.freeze([85, 75, 65, 50]);
const QUALIDADES_MINIATURA = Object.freeze([82, 70, 55, 40]);
const FORMATO_DO_SHARP = Object.freeze({ png: 'PNG', jpeg: 'JPEG', webp: 'WEBP' });
const FORMATO_DE_SAIDA = Object.freeze({ png: 'PNG', webp: 'WEBP' });
const GRACA_DO_RELOGIO_MS = 3000;
const SAIDA_FALHA = 1;
const SAIDA_PARAMETROS = 2;
const SAIDA_SHARP_INDISPONIVEL = 3;
const SAIDA_RELOGIO = 124;

let sharpCarregado = null;
const sharpsConfigurados = new WeakSet();

function obterSharp() {
  if (sharpCarregado === null) sharpCarregado = require('sharp');
  return sharpCarregado;
}

/** Um fio por vez, sem cache e só os carregadores PNG, JPEG e WebP por buffer: SVG, GIF, TIFF, AVIF e os demais são recusados pelo próprio libvips. */
function configurarSharp(sharp = obterSharp()) {
  sharp.concurrency(1);
  sharp.cache(false);
  sharp.block({ operation: ['VipsForeignLoad'] });
  sharp.unblock({ operation: ['VipsForeignLoadPngBuffer', 'VipsForeignLoadJpegBuffer', 'VipsForeignLoadWebpBuffer'] });
  sharpsConfigurados.add(sharp);
  return sharp;
}

function sharpPronto() {
  const sharp = obterSharp();
  return sharpsConfigurados.has(sharp) ? sharp : configurarSharp(sharp);
}

/** Entrada não confiável: leitura estrita (failOn warning), limites de pixels e canais, uma página, orientação aplicada e tempo máximo. */
function abrirEntrada(sharp, bytes, p) {
  return sharp(bytes, {
    failOn: 'warning', limitInputPixels: p.pixelsMax, limitInputChannels: 4, unlimited: false, sequentialRead: true, pages: 1, autoOrient: true,
  }).timeout({ seconds: p.timeoutSegundos });
}

/** Só chamada em volta da LEITURA do envio: o que o libvips recusa ali é culpa da imagem; a mensagem dele nunca sai daqui. */
function classificarFalhaDoSharp(erro) {
  if (erro instanceof ErroDeImagem) return erro;
  const mensagem = String(erro && erro.message);
  if (/^timeout\b|timeout:/i.test(mensagem)) return new ErroDeImagem(CODIGOS.TEMPO);
  if (/pixel limit/i.test(mensagem)) return new ErroDeImagem(CODIGOS.DIMENSOES);
  return new ErroDeImagem(CODIGOS.INVALIDA);
}

function defeitoDaSaida() {
  return Object.assign(new Error('saída do processamento fora do contrato'), { codigo: 'IMAGEM_FILHO_SAIDA_INVALIDA' });
}

/** Confere cada variante contra o contrato antes de devolvê-la: teto, formato, medidas exatas, nada depois do fim e nenhum metadado. */
async function verificarSaida(arquivo, esperado) {
  if (!Buffer.isBuffer(arquivo) || arquivo.length === 0 || esperado === null || typeof esperado !== 'object') throw defeitoDaSaida();
  if (arquivo.length > esperado.bytesMax) throw new ErroDeImagem(CODIGOS.SAIDA);
  let info;
  try {
    info = inspecionarContainer(arquivo, { ladoMin: esperado.lado, ladoMax: esperado.lado, pixelsMax: esperado.lado * esperado.lado });
  } catch { throw defeitoDaSaida(); }
  if (info.formato !== FORMATO_DE_SAIDA[esperado.formato] || info.largura !== esperado.lado || info.altura !== esperado.lado || info.bytesExtras !== 0
    || info.pedacos.some((pedaco) => PEDACOS_DE_METADADOS.has(pedaco))) throw defeitoDaSaida();
  let meta;
  try { meta = await sharpPronto()(arquivo).metadata(); } catch { throw defeitoDaSaida(); }
  if (meta.format !== esperado.formato || meta.width !== esperado.lado || meta.height !== esperado.lado) throw defeitoDaSaida();
  if (meta.exif || meta.icc || meta.xmp || meta.iptc || meta.tifftagPhotoshop || (meta.comments && meta.comments.length > 0)) throw defeitoDaSaida();
}

async function codificarWebp(criarTela, lado, qualidades, bytesMax) {
  for (const quality of qualidades) {
    const saida = await criarTela(lado).webp({ quality, alphaQuality: 100, effort: 4, smartSubsample: true }).toBuffer();
    if (saida.length <= bytesMax) return saida;
  }
  throw new ErroDeImagem(CODIGOS.SAIDA);
}

async function processarImagem(bytes, parametros) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError('os bytes da imagem devem ser um Buffer');
  const p = validarParametros(parametros);
  if (bytes.length > p.entradaMaxBytes) throw new ErroDeImagem(CODIGOS.INVALIDA);
  const info = inspecionarContainer(bytes, { ladoMin: p.ladoMin, ladoMax: p.ladoMax, pixelsMax: p.pixelsMax });
  const sharp = sharpPronto();

  let decodificada;
  try {
    const meta = await abrirEntrada(sharp, bytes, p).metadata();
    if (FORMATO_DO_SHARP[meta.format] !== info.formato) throw new ErroDeImagem(CODIGOS.FORMATO_NAO_SUPORTADO);
    if ((meta.pages ?? 1) > 1) throw new ErroDeImagem(CODIGOS.ANIMADA);
    decodificada = await abrirEntrada(sharp, bytes, p).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (erro) {
    throw classificarFalhaDoSharp(erro);
  }
  const { data, info: bruto } = decodificada;
  if (bruto.width * bruto.height > p.pixelsMax) throw new ErroDeImagem(CODIGOS.DIMENSOES);

  const criarTela = (lado) => sharp(data, { raw: { width: bruto.width, height: bruto.height, channels: 4 }, limitInputPixels: p.pixelsMax })
    .timeout({ seconds: p.timeoutSegundos })
    .resize({ width: lado, height: lado, fit: 'contain', background: TRANSPARENTE, withoutEnlargement: true });
  let mestre;
  let exibicao;
  let miniatura;
  try {
    mestre = await criarTela(p.mestre.lado).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    if (mestre.length > p.mestre.bytesMax) throw new ErroDeImagem(CODIGOS.SAIDA);
    exibicao = await codificarWebp(criarTela, p.exibicao.lado, QUALIDADES_EXIBICAO, p.exibicao.bytesMax);
    miniatura = await codificarWebp(criarTela, p.miniatura.lado, QUALIDADES_MINIATURA, p.miniatura.bytesMax);
  } catch (erro) {
    if (erro instanceof ErroDeImagem) throw erro;
    const classificada = classificarFalhaDoSharp(erro);
    if (classificada.codigo === CODIGOS.TEMPO) throw classificada;
    throw erro;
  }
  await verificarSaida(mestre, { formato: 'png', lado: p.mestre.lado, bytesMax: p.mestre.bytesMax });
  await verificarSaida(exibicao, { formato: 'webp', lado: p.exibicao.lado, bytesMax: p.exibicao.bytesMax });
  await verificarSaida(miniatura, { formato: 'webp', lado: p.miniatura.lado, bytesMax: p.miniatura.bytesMax });
  return { formato: 'PNG', largura: p.mestre.lado, altura: p.mestre.lado, mestre, exibicao, miniatura };
}

function lerEntrada(maximo) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    process.stdin.on('data', (bloco) => {
      total += bloco.length;
      if (total > maximo) { process.stdin.destroy(); reject(new ErroDeImagem(CODIGOS.INVALIDA)); return; }
      partes.push(bloco);
    });
    process.stdin.on('end', () => resolve(Buffer.concat(partes)));
    process.stdin.on('error', reject);
  });
}

function encerrar(codigo, quadro) {
  if (quadro === undefined) process.exit(codigo);
  process.stdout.write(quadro, () => process.exit(codigo));
}

async function principal() {
  let parametros;
  try { parametros = lerParametros(process.argv[process.argv.length - 1]); } catch { process.stderr.write('PARAMETROS_INVALIDOS'); process.exit(SAIDA_PARAMETROS); }
  setTimeout(() => process.exit(SAIDA_RELOGIO), parametros.timeoutSegundos * 1000 + GRACA_DO_RELOGIO_MS);
  try { obterSharp(); } catch { process.stderr.write('SHARP_INDISPONIVEL'); process.exit(SAIDA_SHARP_INDISPONIVEL); }
  process.stdout.on('error', () => process.exit(SAIDA_FALHA));
  process.on('uncaughtException', () => process.exit(SAIDA_FALHA));
  process.on('unhandledRejection', () => process.exit(SAIDA_FALHA));
  try {
    const entrada = await lerEntrada(parametros.entradaMaxBytes + 1);
    encerrar(0, serializarSucesso(await processarImagem(entrada, parametros)));
  } catch (erro) {
    if (erro instanceof ErroDeImagem) encerrar(0, serializarRecusa(erro.codigo));
    else { process.stderr.write(`FALHA_${typeof erro?.codigo === 'string' ? erro.codigo.slice(0, 60) : 'INESPERADA'}`); encerrar(SAIDA_FALHA); }
  }
}

if (require.main === module) principal();

module.exports = { processarImagem, configurarSharp, abrirEntrada, classificarFalhaDoSharp, verificarSaida, lerParametros };
