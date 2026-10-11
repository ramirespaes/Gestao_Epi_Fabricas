'use strict';

const PDFDocument = require('pdfkit');
const { estruturar } = require('./formatacao');

/**
 * PDF do Histórico de Funcionários (pdfkit, fontes padrão Helvetica, sem imagem nem fonte embutida). A4 paisagem, uma
 * seção por título, tabelas com o cabeçalho repetido em cada página e "Página X de Y". As fontes padrão só têm o
 * conjunto WinAnsi (português completo): o que estiver fora vira "?" em vez de bytes trocados.
 */

const MARGEM = 36;
const COR_CABECALHO = '#E8EDF3';
const COR_LINHA = '#B8C2CC';
const FONTE = 'Helvetica';
const FONTE_NEGRITO = 'Helvetica-Bold';
const FONTE_ITALICO = 'Helvetica-Oblique';
const PADDING = 3;

// WinAnsi = Latin-1 imprimível + extras do cp1252.
const EXTRAS_CP1252 = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
function winAnsi(valor) {
  const t = valor === null || valor === undefined ? '' : String(valor);
  let saida = '';
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c === 10) saida += '\n';
    else if (c < 32 || c === 127) saida += ' ';
    else if (c < 127 || (c >= 160 && c <= 255) || EXTRAS_CP1252.has(ch)) saida += ch;
    else saida += '?';
  }
  return saida;
}

// Largura relativa de cada coluna, por quantidade de colunas da seção.
const PESOS = {
  13: [6, 4, 6, 12, 8, 5, 3.5, 5, 6, 5, 8, 9, 9],
  6: [8, 5, 7, 22, 22, 14],
  7: [7, 5, 7, 10, 18, 18, 13],
};

function criarDesenho(doc) {
  const largura = doc.page.width - MARGEM * 2;
  const limite = () => doc.page.height - MARGEM - 14;

  function garantir(altura) {
    if (doc.y + altura > limite()) {
      doc.addPage();
      return true;
    }
    return false;
  }

  function linhaTabela(celulas, larguras, { negrito = false, fundo = null, tamanho = 7.5 } = {}) {
    doc.font(negrito ? FONTE_NEGRITO : FONTE).fontSize(tamanho);
    const textos = celulas.map((c) => winAnsi(c));
    const altura = Math.max(...textos.map((t, i) => doc.heightOfString(t, { width: larguras[i] - PADDING * 2 }))) + PADDING * 2;
    const y = doc.y;
    let x = MARGEM;
    textos.forEach((t, i) => {
      if (fundo) doc.save().rect(x, y, larguras[i], altura).fill(fundo).restore();
      doc.save().lineWidth(0.5).strokeColor(COR_LINHA).rect(x, y, larguras[i], altura).stroke().restore();
      doc.fillColor('#000000').text(t, x + PADDING, y + PADDING, { width: larguras[i] - PADDING * 2, lineBreak: true });
      x += larguras[i];
    });
    doc.x = MARGEM;
    doc.y = y + altura;
    return altura;
  }

  function alturaLinha(celulas, larguras, negrito) {
    doc.font(negrito ? FONTE_NEGRITO : FONTE).fontSize(7.5);
    return Math.max(...celulas.map((c, i) => doc.heightOfString(winAnsi(c), { width: larguras[i] - PADDING * 2 }))) + PADDING * 2;
  }

  function titulo(t) {
    garantir(40);
    doc.moveDown(0.6);
    doc.font(FONTE_NEGRITO).fontSize(11).fillColor('#000000').text(winAnsi(t), MARGEM, doc.y, { width: largura });
    doc.moveDown(0.3);
  }

  function aviso(t) {
    garantir(20);
    doc.font(FONTE_ITALICO).fontSize(8.5).fillColor('#333333').text(winAnsi(t), MARGEM, doc.y, { width: largura });
    doc.fillColor('#000000');
  }

  function pares(linhas) {
    const larguras = [largura * 0.28, largura * 0.72];
    for (const [rotulo, valor] of linhas) {
      garantir(alturaLinha([rotulo, valor], larguras, false));
      linhaTabela([rotulo, valor], larguras, { tamanho: 8.5 });
    }
  }

  function tabela(colunas, linhas) {
    const pesos = PESOS[colunas.length] ?? colunas.map(() => 1);
    const soma = pesos.reduce((a, b) => a + b, 0);
    const larguras = pesos.map((p) => (largura * p) / soma);
    const cabecalho = () => linhaTabela(colunas, larguras, { negrito: true, fundo: COR_CABECALHO });
    garantir(alturaLinha(colunas, larguras, true) + 14);
    cabecalho();
    for (const linha of linhas) {
      if (garantir(alturaLinha(linha, larguras, false))) cabecalho();
      linhaTabela(linha, larguras);
    }
  }

  return { titulo, aviso, pares, tabela, largura };
}

function renderizarPdf(modelo) {
  const documento = estruturar(modelo);
  return new Promise((resolve, reject) => {
    let doc;
    try {
      doc = new PDFDocument({
        size: 'A4', layout: 'landscape', margin: MARGEM, bufferPages: true,
        info: { Title: winAnsi(`${documento.titulo} — ${documento.subtitulo}`), Author: 'SafeWork', Subject: 'Exportação do histórico do colaborador' },
      });
    } catch (erro) {
      reject(erro);
      return;
    }
    const partes = [];
    doc.on('data', (p) => partes.push(p));
    doc.on('end', () => resolve(Buffer.concat(partes)));
    doc.on('error', reject);
    try {
      const d = criarDesenho(doc);
      doc.font(FONTE_NEGRITO).fontSize(15).text(winAnsi(documento.titulo), { width: d.largura });
      doc.font(FONTE).fontSize(11).text(winAnsi(documento.subtitulo), { width: d.largura });
      doc.moveDown(0.4);
      for (const [rotulo, valor] of documento.cabecalho) {
        doc.font(FONTE_NEGRITO).fontSize(8.5).text(winAnsi(`${rotulo}: `), { continued: true }).font(FONTE).text(winAnsi(valor));
      }
      for (const s of documento.secoes) {
        d.titulo(s.titulo);
        if (s.omitida || s.mensagem) {
          d.aviso(s.mensagem);
        } else if (s.tipo === 'pares') {
          d.pares(s.linhas);
        } else {
          d.tabela(s.colunas, s.linhas);
        }
      }
      const paginas = doc.bufferedPageRange();
      for (let i = 0; i < paginas.count; i += 1) {
        doc.switchToPage(paginas.start + i);
        const margemInferior = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font(FONTE).fontSize(7.5).fillColor('#555555')
          .text(winAnsi(`Página ${i + 1} de ${paginas.count}`), MARGEM, doc.page.height - MARGEM + 8, { width: d.largura, align: 'right', lineBreak: false });
        doc.page.margins.bottom = margemInferior;
      }
      doc.end();
    } catch (erro) {
      reject(erro);
    }
  });
}

module.exports = { renderizarPdf, winAnsi };
