'use strict';

const escreverXlsx = require('write-excel-file/node');
const { estruturar } = require('./formatacao');

/**
 * XLSX do Histórico de Funcionários (write-excel-file): uma aba por seção, cabeçalho em negrito e fixo, larguras
 * ajustadas, sem célula mesclada, sem macro e sem fórmula. Todo texto é gravado como TEXTO (formato "@"); além disso, o
 * que começa com caractere de fórmula (= + - @ tabulação ou retorno) recebe o apóstrofo, a mesma regra do CSV da
 * Fiscalização, para não virar fórmula se a planilha for convertida. Números (quantidade, prazo, indicadores) são números.
 */

const CELULA_PERIGOSA = /^[=+\-@\t\r]/;
const textoSeguro = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  return CELULA_PERIGOSA.test(t) ? `'${t}` : t;
};
const celula = (v, extra = {}) => (typeof v === 'number' && Number.isFinite(v)
  ? { value: v, type: Number, ...extra }
  : { value: textoSeguro(v), type: String, format: '@', ...extra });
const negrito = (v) => celula(v, { fontWeight: 'bold' });

const NOMES_ABAS = {
  identificacao: 'Identificação', indicadores: 'Indicadores', entregas: 'Entregas de EPIs', ghe: 'Histórico de GHE', situacao: 'Histórico de Situação', cadastral: 'Histórico Cadastral',
};

function larguras(linhas, minimo = 8, maximo = 60) {
  const colunas = Math.max(0, ...linhas.map((l) => l.length));
  return Array.from({ length: colunas }, (_, i) => ({
    width: Math.min(maximo, Math.max(minimo, ...linhas.map((l) => String(l[i]?.value ?? '').length + 2))),
  }));
}

function aba(nome, linhas, fixas) {
  return { data: linhas, sheet: nome, columns: larguras(linhas), ...(fixas > 0 ? { stickyRowsCount: fixas } : {}) };
}

async function renderizarXlsx(modelo) {
  const documento = estruturar(modelo);
  const abas = [];
  for (const s of documento.secoes) {
    const nome = NOMES_ABAS[s.id];
    if (s.id === 'identificacao') {
      const linhas = [
        [negrito(documento.titulo), celula('')],
        ...documento.cabecalho.map(([r, v]) => [negrito(r), celula(v)]),
        [celula(''), celula('')],
        [negrito('Campo'), negrito('Valor')],
        ...s.linhas.map(([r, v]) => [celula(r), celula(v)]),
      ];
      abas.push(aba(nome, linhas, 0));
    } else if (s.omitida || (s.tipo === 'pares' && s.mensagem)) {
      abas.push(aba(nome, [[negrito(s.titulo)], [celula(s.mensagem)]], 0));
    } else if (s.tipo === 'pares') {
      const valores = s.linhas.map(([r, v]) => [celula(r), celula(/^\d+$/.test(v) ? Number(v) : v)]);
      abas.push(aba(nome, [[negrito('Indicador'), negrito('Valor')], ...valores], 1));
    } else {
      const corpo = s.linhas.length === 0 ? [[celula(s.mensagem)]] : s.linhas.map((l) => l.map((v) => celula(v)));
      abas.push(aba(nome, [s.colunas.map(negrito), ...corpo], 1));
    }
  }
  return escreverXlsx(abas).toBuffer();
}

module.exports = { renderizarXlsx, textoSeguro };
