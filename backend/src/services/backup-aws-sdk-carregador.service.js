'use strict';

const { ambienteDeTeste } = require('./imagem-backup-durabilidade.service');

/**
 * D-ORF-6, DEP-2: CARREGADOR DO SDK DA AWS. O SDK é carregado por um `requerer` injetado e SÓ depois que `VERSOES_APROVADAS` (hoje VAZIA: DEP-2 fechado) listar a versão EXATA
 * de cada um dos três clientes. Sem aprovação nada é carregado, mesmo que os pacotes sejam instalados por engano. Devolve apenas os símbolos de que os adaptadores precisam
 * (construtores de cliente e comandos), congelados; nunca o módulo inteiro. Fora de NODE_ENV=test a lista de versões não pode ser injetada: aprovar o SDK é alterar este código.
 * Erros: só código e pacote fixos (SDK_NAO_APROVADO, SDK_NAO_INSTALADO, SDK_VERSAO_DIVERGENTE, SDK_INCOMPATIVEL, CONFIGURACAO_INVALIDA).
 */

const PACOTES_DO_SDK = Object.freeze(['@aws-sdk/client-s3', '@aws-sdk/client-kms', '@aws-sdk/client-sts']);
const SIMBOLOS_POR_PACOTE = Object.freeze({
  '@aws-sdk/client-s3': Object.freeze(['S3Client', 'HeadBucketCommand', 'GetBucketVersioningCommand', 'GetObjectLockConfigurationCommand', 'GetBucketEncryptionCommand', 'GetBucketOwnershipControlsCommand', 'PutObjectCommand', 'HeadObjectCommand', 'GetObjectCommand', 'ListObjectVersionsCommand']),
  '@aws-sdk/client-kms': Object.freeze(['KMSClient', 'DescribeKeyCommand', 'DecryptCommand']),
  '@aws-sdk/client-sts': Object.freeze(['STSClient', 'GetCallerIdentityCommand']),
});
const SIMBOLOS_EXIGIDOS = Object.freeze(PACOTES_DO_SDK.flatMap((p) => SIMBOLOS_POR_PACOTE[p]));
/** `[{ pacote, versao }]` com os três pacotes e a versão exata aprovada no gate DEP-2. Vazia = SDK não aprovado. */
const VERSOES_APROVADAS = Object.freeze([]);
const VERSAO_EXATA = /^\d+\.\d+\.\d+$/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração do carregador do SDK inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const falha = (code, pacote) => Object.assign(new Error('SDK da AWS indisponível'), { code, ...(pacote === undefined ? {} : { pacote }) });

function listaValida(lista) {
  if (!Array.isArray(lista) || lista.length !== PACOTES_DO_SDK.length) return false;
  const vistos = new Set();
  for (const item of lista) {
    if (!ehObjeto(item) || !chavesExatas(item, ['pacote', 'versao']) || !PACOTES_DO_SDK.includes(item.pacote) || vistos.has(item.pacote)) return false;
    if (typeof item.versao !== 'string' || !VERSAO_EXATA.test(item.versao)) return false;
    vistos.add(item.pacote);
  }
  return true;
}

function carregarSdkAws(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => k === 'requerer' || k === 'versoesAprovadas') || typeof opcoes.requerer !== 'function') throw configuracaoInvalida();
  const injetada = Object.hasOwn(opcoes, 'versoesAprovadas');
  if (injetada && !ambienteDeTeste()) throw configuracaoInvalida();
  const aprovadas = injetada ? opcoes.versoesAprovadas : VERSOES_APROVADAS;
  if (Array.isArray(aprovadas) && aprovadas.length === 0) throw falha('SDK_NAO_APROVADO');
  if (!listaValida(aprovadas)) throw configuracaoInvalida();
  const { requerer } = opcoes;
  const carregar = (nome, pacote) => {
    try { return requerer(nome); } catch (e) { throw falha(e !== null && typeof e === 'object' && e.code === 'MODULE_NOT_FOUND' ? 'SDK_NAO_INSTALADO' : 'SDK_INCOMPATIVEL', pacote); }
  };
  const simbolos = {};
  for (const { pacote, versao } of aprovadas) {
    const manifesto = carregar(`${pacote}/package.json`, pacote);
    if (!ehObjeto(manifesto) || manifesto.version !== versao) throw falha('SDK_VERSAO_DIVERGENTE', pacote);
    const modulo = carregar(pacote, pacote);
    if (modulo === null || typeof modulo !== 'object') throw falha('SDK_INCOMPATIVEL', pacote);
    for (const simbolo of SIMBOLOS_POR_PACOTE[pacote]) {
      if (typeof modulo[simbolo] !== 'function') throw falha('SDK_INCOMPATIVEL', pacote);
      simbolos[simbolo] = modulo[simbolo];
    }
  }
  return Object.freeze(simbolos);
}

module.exports = { carregarSdkAws, VERSOES_APROVADAS, PACOTES_DO_SDK, SIMBOLOS_EXIGIDOS, SIMBOLOS_POR_PACOTE };
