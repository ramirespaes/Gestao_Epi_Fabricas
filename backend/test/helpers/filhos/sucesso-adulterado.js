'use strict';

// Base dos filhos de teste que devolvem um quadro de SUCESSO bem formado — válido ou com uma saída que o contrato proíbe. Cada arquivo sucesso-*.js chama executar(modo).
// O filho real nunca faz isso; aqui serve para provar que o processador NÃO confia na resposta do filho: ele reconfere formato, medidas, metadados e carga de cada variante.
const sharp = require('sharp');
const { serializarSucesso } = require('../../../src/utils/imagem-quadro');

const transparente = { r: 0, g: 0, b: 0, alpha: 0 };
const tela = (lado) => sharp({ create: { width: lado, height: lado, channels: 4, background: transparente } });

/** As três variantes do modo válido: o teste que calcula os tetos exatos usa a mesma função que o filho, então os tamanhos coincidem. */
async function gerarVariantes() {
  return { mestre: await tela(1024).png().toBuffer(), exibicao: await tela(640).webp().toBuffer(), miniatura: await tela(320).webp().toBuffer() };
}

/** Modo 'stderr-grande': escreve 400 KiB na saída de erro ESPERANDO cada escrita sair; um leitor que não drena o stderr deixa o filho preso aqui. */
async function encherStderr() {
  for (let i = 0; i < 400; i += 1) await new Promise((resolver) => { process.stderr.write(Buffer.alloc(1024, 0x45), resolver); });
}

function executar(modo) {
  process.stdin.on('data', () => {});
  process.stdin.on('end', async () => {
    let mestre = await tela(modo === 'mestre-pequeno' ? 900 : 1024).png().toBuffer();
    let exibicao = await tela(640).webp().toBuffer();
    const miniatura = await tela(320).webp().toBuffer();
    if (modo === 'exibicao-em-png') exibicao = await tela(640).png().toBuffer();
    if (modo === 'mestre-com-metadados') mestre = await tela(1024).withExif({ IFD0: { Copyright: 'x' } }).png().toBuffer();
    if (modo === 'carga-depois-do-fim') mestre = Buffer.concat([mestre, Buffer.from('lixo depois do IEND')]);
    if (modo === 'stderr-grande') await encherStderr();
    const quadro = serializarSucesso({ formato: 'PNG', largura: modo === 'largura-errada' ? 999 : 1024, altura: modo === 'altura-errada' ? 999 : 1024, mestre, exibicao, miniatura });
    process.stdout.write(quadro, () => process.exit(0));
  });
}

module.exports = { executar, gerarVariantes };
