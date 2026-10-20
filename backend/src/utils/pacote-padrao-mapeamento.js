'use strict';

const { analisarCsv } = require('./csv-simples');
const { ErroImportacaoPadrao } = require('./pacote-padrao-erros');

/**
 * Mapeamento imagem x tipo da biblioteca padrão (CSV da proposta: ponto e vírgula, aspas, cabeçalho exato). SÓ as linhas com decisão APROVAR,
 * aprovador e data real viram sugestão de tipo; o nível sai da confiança (ALTA = PRINCIPAL, MÉDIA = ALTERNATIVA) e a linha sem correspondência nunca
 * é aprovável. Qualquer defeito recusa o arquivo inteiro. Os detalhes de erro levam linha, campo e motivo, nunca o valor lido.
 */

const CABECALHO = Object.freeze([
  'n', 'nome_base', 'arquivo_padronizado', 'tipo_sugerido', 'confianca', 'observacao', 'decisao_humana (APROVAR/AJUSTAR/REJEITAR)', 'aprovado_por', 'data_aprovacao',
]);
const DECISOES = new Set(['', 'APROVAR', 'AJUSTAR', 'REJEITAR']);
const NIVEL_POR_CONFIANCA = Object.freeze({ ALTA: 'PRINCIPAL', 'MÉDIA': 'ALTERNATIVA' });
const APROVADO_POR_MAXIMO = 100;
const PASTA_DOS_PNG = '02_PNG_PADRONIZADOS/';
const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;

const invalido = (detalhes) => new ErroImportacaoPadrao('MAPEAMENTO_INVALIDO', detalhes);

function dataReal(texto) {
  const partes = DATA.exec(texto);
  if (partes === null) return false;
  const [ano, mes, dia] = [Number(partes[1]), Number(partes[2]), Number(partes[3])];
  if (ano < 1900 || ano > 2100) return false;
  const data = new Date(0);
  data.setUTCFullYear(ano, mes - 1, dia);
  return data.getUTCFullYear() === ano && data.getUTCMonth() === mes - 1 && data.getUTCDate() === dia;
}

/**
 * @param {Buffer} bytes conteúdo do CSV
 * @param {{ nomes: Set<string>, tiposBase: Set<string> }} referencia nomes-base do pacote e nomes dos tipos do catálogo BASE
 * @returns {Map<string, { tipoNome: string, nivel: string, aprovadoPor: string, aprovadoEm: string }>} só as linhas aprovadas, por nome-base
 */
function lerMapeamento(bytes, { nomes, tiposBase }) {
  let texto;
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalido([{ campo: 'arquivo', motivo: 'CODIFICACAO_INVALIDA' }]);
  }
  if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1);
  let linhas;
  try {
    linhas = analisarCsv(texto, ';');
  } catch {
    throw invalido([{ campo: 'arquivo', motivo: 'CSV_MALFORMADO' }]);
  }
  if (linhas.length === 0 || linhas[0].length !== CABECALHO.length || linhas[0].some((coluna, k) => coluna.normalize('NFC') !== CABECALHO[k])) {
    throw invalido([{ campo: 'cabecalho', motivo: 'DIFERENTE_DO_APROVADO' }]);
  }

  const problemas = [];
  const vistos = new Set();
  const aprovadas = new Map();
  linhas.slice(1).forEach((campos, indice) => {
    const linha = indice + 2;
    const ruim = (campo, motivo) => problemas.push({ linha, campo, motivo });
    if (campos.length !== CABECALHO.length) { ruim('linha', 'COLUNAS_DIFERENTES'); return; }
    const [, nomeBruto, arquivoBruto, tipoBruto, confiancaBruta, , decisaoBruta, porBruto, dataBruta] = campos;
    const nome = nomeBruto.normalize('NFC');
    const tipo = tipoBruto.normalize('NFC');
    const confianca = confiancaBruta.normalize('NFC');
    if (!nomes.has(nome)) ruim('nome_base', 'FORA_DO_PACOTE');
    else if (vistos.has(nome)) ruim('nome_base', 'REPETIDO');
    vistos.add(nome);
    if (arquivoBruto.normalize('NFC') !== `${PASTA_DOS_PNG}${nome}.png`) ruim('arquivo_padronizado', 'INCONSISTENTE_COM_O_NOME');
    if (!DECISOES.has(decisaoBruta)) { ruim('decisao_humana', 'DECISAO_DESCONHECIDA'); return; }
    if (decisaoBruta !== 'APROVAR') return;

    const aprovadoPor = porBruto.normalize('NFC').trim();
    if (aprovadoPor === '') ruim('aprovado_por', 'OBRIGATORIO');
    else if (Array.from(aprovadoPor).length > APROVADO_POR_MAXIMO || /\p{Cc}/u.test(aprovadoPor)) ruim('aprovado_por', 'INVALIDO');
    if (dataBruta === '') ruim('data_aprovacao', 'OBRIGATORIA');
    else if (!dataReal(dataBruta)) ruim('data_aprovacao', 'DATA_INVALIDA');
    const nivel = Object.hasOwn(NIVEL_POR_CONFIANCA, confianca) ? NIVEL_POR_CONFIANCA[confianca] : undefined;
    if (nivel === undefined) ruim('confianca', 'NAO_APROVAVEL');
    if (!tiposBase.has(tipo)) ruim('tipo_sugerido', 'FORA_DO_CATALOGO');
    if (nomes.has(nome) && !problemas.some((p) => p.linha === linha)) aprovadas.set(nome, { tipoNome: tipo, nivel, aprovadoPor, aprovadoEm: dataBruta });
  });
  if (problemas.length > 0) throw invalido(problemas);
  return aprovadas;
}

module.exports = { CABECALHO, lerMapeamento };
