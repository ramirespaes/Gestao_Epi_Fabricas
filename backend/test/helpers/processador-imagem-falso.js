'use strict';

const { webpFicticio, pngFicticio, sha256Hex } = require('./imagens-ficticias');
const { jpegMinimo } = require('./imagens-validas');
const { lerConfiguracao } = require('../../src/config/imagens');

/**
 * PROCESSADOR DE IMAGEM FALSO (Biblioteca de Imagens, Unidade 5C-1) — instrumento de teste, NÃO o processador de produção.
 *
 * Representa a PORTA que o serviço de envio usa para decodificar, validar e derivar a imagem, sem depender de biblioteca de imagem (que só
 * entra na 5C-3). Contrato previsto da porta (a confirmar no GREEN da 5C-2; os testes fixam só o mínimo):
 *
 *   processar(bytes: Buffer) -> Promise<{ formato: 'PNG'|'JPEG'|'WEBP', largura, altura, mestre: Buffer, exibicao: Buffer, miniatura: Buffer }>
 *   ou rejeita com Error{ codigo }, `codigo` em: IMAGEM_FORMATO_NAO_SUPORTADO · IMAGEM_ANIMADA_NAO_SUPORTADA · IMAGEM_INVALIDA · IMAGEM_DIMENSOES_INVALIDAS
 *   (qualquer outra falha é inesperada e o serviço a trata como erro interno).
 *
 * O que este falso faz (um pouco, de propósito, para os contratos HTTP de recusa terem o que recusar): lê a ASSINATURA (PNG, JPEG, WebP), o
 * fim do arquivo (truncado = IMAGEM_INVALIDA), o cabeçalho IHDR do PNG (medidas), sinais de animação (APNG `acTL`, WebP `ANIM`) e confere lado
 * 320–4096 e 8 Mpx com a MESMA configuração de produção. As derivadas são contêineres RIFF/WEBP bem formados e determinísticos pelo conteúdo, o
 * mestre é diferente dos bytes enviados (é o "saneado") e tudo é igual para a mesma entrada. A decodificação REAL, os metadados e as fixtures
 * hostis são da 5C-4 (VAL-01 a VAL-11).
 */

const erro = (codigo, mensagem) => Object.assign(new Error(mensagem ?? `falha simulada do processador: ${codigo}`), { codigo });

function inspecionarPng(b) {
  if (b.length < 8 + 25) throw erro('IMAGEM_INVALIDA');
  let pos = 8;
  let medidas = null;
  let fim = false;
  while (pos + 12 <= b.length) {
    const tamanho = b.readUInt32BE(pos);
    const tipo = b.toString('latin1', pos + 4, pos + 8);
    if (pos + 12 + tamanho > b.length) break;
    if (tipo === 'IHDR' && tamanho === 13 && medidas === null) medidas = { largura: b.readUInt32BE(pos + 8), altura: b.readUInt32BE(pos + 12) };
    if (tipo === 'acTL') throw erro('IMAGEM_ANIMADA_NAO_SUPORTADA');
    if (tipo === 'IEND') { fim = true; break; }
    pos += 12 + tamanho;
  }
  if (medidas === null || !fim) throw erro('IMAGEM_INVALIDA');
  return medidas;
}

function inspecionarJpeg(b, medidasPadrao) {
  if (b.length < 6 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) throw erro('IMAGEM_INVALIDA');
  return medidasPadrao;
}

function inspecionarWebp(b, medidasPadrao) {
  if (b.length < 20 || b.readUInt32LE(4) + 8 !== b.length) throw erro('IMAGEM_INVALIDA');
  if (b.includes(Buffer.from('ANIM', 'ascii')) || b.includes(Buffer.from('ANMF', 'ascii'))) throw erro('IMAGEM_ANIMADA_NAO_SUPORTADA');
  return medidasPadrao;
}

const ehPng = (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const ehJpeg = (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const ehWebp = (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';

function criarProcessadorFalso({ eventos = null, aguardar = null, medidas = { largura: 320, altura: 320 }, extraDoMestre = 160 } = {}) {
  const config = lerConfiguracao({});
  const chamadas = [];
  let falha = null;
  let emAndamento = 0;
  let maximoSimultaneo = 0;

  /** A derivação pura (sem registrar nada): é também o que os testes usam para saber o que o processador deve devolver. */
  function derivar(bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw erro('IMAGEM_FORMATO_NAO_SUPORTADO');
    let formato;
    let lidas;
    if (ehPng(bytes)) { formato = 'PNG'; lidas = inspecionarPng(bytes); } else if (ehJpeg(bytes)) { formato = 'JPEG'; lidas = inspecionarJpeg(bytes, medidas); } else if (ehWebp(bytes)) {
      formato = 'WEBP'; lidas = inspecionarWebp(bytes, medidas);
    } else throw erro('IMAGEM_FORMATO_NAO_SUPORTADO');
    const { largura, altura } = lidas;
    const ladoValido = (n) => Number.isInteger(n) && n >= config.ladoMin && n <= config.ladoMax;
    if (!ladoValido(largura) || !ladoValido(altura) || largura * altura > config.pixelsMax) throw erro('IMAGEM_DIMENSOES_INVALIDAS');
    const semente = sha256Hex(bytes).slice(0, 24);
    let mestre;
    if (formato === 'PNG') mestre = pngFicticio(`mestre-${semente}`, extraDoMestre);
    else if (formato === 'JPEG') mestre = jpegMinimo(`mestre-${semente}`, extraDoMestre);
    else mestre = webpFicticio(`mestre-${semente}`, extraDoMestre);
    return {
      formato, largura, altura, mestre, exibicao: webpFicticio(`exibicao-${semente}`, 96), miniatura: webpFicticio(`miniatura-${semente}`, 48),
    };
  }

  async function processar(bytes) {
    chamadas.push({ tamanho: Buffer.isBuffer(bytes) ? bytes.length : null });
    emAndamento += 1;
    maximoSimultaneo = Math.max(maximoSimultaneo, emAndamento);
    if (eventos !== null) eventos.push('processar:inicio');
    try {
      if (aguardar !== null) await aguardar();
      if (falha !== null) throw erro(falha.codigo, falha.mensagem);
      return derivar(bytes);
    } finally {
      emAndamento -= 1;
      if (eventos !== null) eventos.push('processar:fim');
    }
  }

  return {
    processar,
    resultadoEsperado: derivar,
    chamadas,
    /** A partir daqui TODA chamada falha com o código (e a mensagem, que o teste usa como isca de vazamento). */
    falharCom(codigo, mensagem) { falha = { codigo, mensagem }; },
    get emAndamento() { return emAndamento; },
    get maximoSimultaneo() { return maximoSimultaneo; },
  };
}

module.exports = { criarProcessadorFalso };
