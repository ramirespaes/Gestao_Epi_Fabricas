'use strict';

const path = require('node:path');
const { lerArquivoRestrito } = require('./backup-executor-configuracao.service');
const { PAPEIS } = require('./backup-executor-credenciais.service');

/**
 * D-ORF-6, Rodada B (B1), H9-a: FORNECEDOR DE CREDENCIAIS SINTÉTICAS POR ARQUIVO, exclusivamente para ensaio isolado. Um arquivo JSON 0600 por papel, lido a cada `obter` (sem cache), entregue ao
 * `criarConjuntoDeCredenciais`. Credencial real é recusada por prova positiva: a chave de acesso só vale com o marcador SWBTESTE (nenhum identificador emitido pela AWS o tem) e o segredo só com
 * SWBTESTE-; token de sessão é proibido; os prefixos de identificadores da AWS são recusados como defesa adicional. O marcador prova que a chave de acesso não foi emitida pela AWS; não prova que
 * o segredo é fictício, por isso a revisão humana dos arquivos antes de cada ensaio continua obrigatória. Erros levam só código fixo: nunca valor, caminho ou conteúdo.
 *
 * `criarFornecedoresPorArquivo({ caminhos, lerArquivo?, uid? })` -> `{ [papel]: { obter({ papel }) } }`; `obter` devolve `{ papel, accessKeyId, secretAccessKey, expiration? }`.
 */

const LIMITE_ARQUIVO_BYTES = 8 * 1024;
const ID_SINTETICO = /^SWBTESTE[A-Z0-9]{8,32}$/;
const SEGREDO_SINTETICO = /^SWBTESTE-[A-Za-z0-9/+=_-]{8,200}$/;
const PREFIXOS_AWS = /^(?:ABIA|ACCA|AGPA|AIDA|AIPA|AKIA|ANPA|ANVA|APKA|AROA|ASCA|ASIA)/;
const INSTANTE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CHAVES_PERMITIDAS = Object.freeze(['papel', 'accessKeyId', 'secretAccessKey', 'expiration']);
const MENSAGENS = Object.freeze({
  FORNECEDOR_CONFIGURACAO_INVALIDA: 'configuração do fornecedor de credenciais inválida',
  CREDENCIAL_PAPEL_INCOERENTE: 'pedido de credencial incoerente com o papel',
  CREDENCIAL_ARQUIVO_INDISPONIVEL: 'arquivo de credencial indisponível ou inseguro',
  CREDENCIAL_FORMA_INVALIDA: 'arquivo de credencial com forma inválida',
  CREDENCIAL_TOKEN_DE_SESSAO_PROIBIDO: 'token de sessão não é aceito em ensaio isolado',
  CREDENCIAL_REAL_NAO_AUTORIZADA: 'credencial com formato de identificador AWS real não é autorizada',
  CREDENCIAL_SEM_MARCADOR_SINTETICO: 'credencial sem o marcador sintético',
});

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const erro = (code) => Object.assign(new Error(MENSAGENS[code]), { code });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/') && !c.split('/').includes('..');

function validarConteudo(texto) {
  let bruto;
  try { bruto = JSON.parse(texto); } catch { throw erro('CREDENCIAL_FORMA_INVALIDA'); }
  if (!ehObjeto(bruto)) throw erro('CREDENCIAL_FORMA_INVALIDA');
  const proprias = Reflect.ownKeys(bruto);
  if (proprias.includes('sessionToken')) throw erro('CREDENCIAL_TOKEN_DE_SESSAO_PROIBIDO');
  if (!proprias.every((k) => typeof k === 'string' && CHAVES_PERMITIDAS.includes(k)) || !['papel', 'accessKeyId', 'secretAccessKey'].every((k) => proprias.includes(k))) throw erro('CREDENCIAL_FORMA_INVALIDA');
  const { papel, accessKeyId, secretAccessKey, expiration } = bruto;
  if (typeof papel !== 'string' || typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string') throw erro('CREDENCIAL_FORMA_INVALIDA');
  if (PREFIXOS_AWS.test(accessKeyId)) throw erro('CREDENCIAL_REAL_NAO_AUTORIZADA');
  if (!ID_SINTETICO.test(accessKeyId) || !SEGREDO_SINTETICO.test(secretAccessKey)) throw erro('CREDENCIAL_SEM_MARCADOR_SINTETICO');
  const credencial = { papel, accessKeyId, secretAccessKey };
  if (expiration !== undefined) {
    if (typeof expiration !== 'string' || !INSTANTE_ISO.test(expiration)) throw erro('CREDENCIAL_FORMA_INVALIDA');
    const data = new Date(expiration);
    if (Number.isNaN(data.getTime())) throw erro('CREDENCIAL_FORMA_INVALIDA');
    credencial.expiration = data;
  }
  return credencial;
}

function criarFornecedoresPorArquivo(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['caminhos', 'lerArquivo', 'uid'].includes(k)) || !ehObjeto(opcoes.caminhos)) throw erro('FORNECEDOR_CONFIGURACAO_INVALIDA');
  const { caminhos, lerArquivo = lerArquivoRestrito, uid = typeof process.getuid === 'function' ? process.getuid() : -1 } = opcoes;
  const nomes = Reflect.ownKeys(caminhos);
  if (typeof lerArquivo !== 'function' || !Number.isInteger(uid) || uid < 0 || nomes.length < 1 || !nomes.every((n) => typeof n === 'string' && PAPEIS.includes(n))) throw erro('FORNECEDOR_CONFIGURACAO_INVALIDA');
  const valores = nomes.map((n) => caminhos[n]);
  if (!valores.every(caminhoCanonico) || new Set(valores.map((c) => c.toLowerCase())).size !== valores.length) throw erro('FORNECEDOR_CONFIGURACAO_INVALIDA');
  const fornecedores = {};
  for (const papel of nomes) {
    const caminho = caminhos[papel];
    fornecedores[papel] = Object.freeze({
      obter(pedido) {
        if (!ehObjeto(pedido) || pedido.papel !== papel || Reflect.ownKeys(pedido).length !== 1) throw erro('CREDENCIAL_PAPEL_INCOERENTE');
        const lido = lerArquivo(caminho, { uid, limiteBytes: LIMITE_ARQUIVO_BYTES });
        if (!ehObjeto(lido) || lido.ok !== true || typeof lido.texto !== 'string') throw erro('CREDENCIAL_ARQUIVO_INDISPONIVEL');
        return validarConteudo(lido.texto);
      },
    });
  }
  return Object.freeze(fornecedores);
}

module.exports = { criarFornecedoresPorArquivo, LIMITE_ARQUIVO_BYTES };
