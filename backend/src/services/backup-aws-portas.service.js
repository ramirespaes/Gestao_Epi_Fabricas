'use strict';

const { LIMITE_OBJETO_BYTES } = require('./backup-recibo-duravel.service');

/**
 * D-ORF-6, DEP-2 (preparação): ADAPTADORES das portas S3/KMS/STS sobre o SDK da AWS INJETADO (o objeto devolvido por `backup-aws-sdk-carregador`). Este módulo NÃO importa o SDK, não lê
 * ambiente, arquivo nem rede por conta própria e não escolhe credenciais: cada porta recebe `{ sdk, regiao, credenciais }`, onde `credenciais` é um PROVEDOR (função) do papel. Os papéis
 * são separados (publicador, verificador, restauração, KMS) e cada porta oferece SÓ as operações do contrato do módulo que a consome: ver `backup-armazenamento-s3` (publicador),
 * `backup-verificador-duravel` (verificador), `backup-baixador-duravel` (restauração) e `backup-fontes-kms-pre-resolvido` (KMS).
 *
 * Regras: todo pedido de bucket leva o dono esperado; o endpoint não é configurável; o cliente S3 do PUBLICADOR não faz retentativa automática (uma gravação, um pedido); a gravação usa a
 * condição de objeto novo e o SHA-256 informado; leituras são sempre pela VERSÃO. Erros do SDK nunca saem como vieram: viram erro com mensagem fixa e só o nome do erro do serviço (sem
 * mensagem, requisição ou segredo). Falhas de gravação: NEGADO e CHECKSUM_REJEITADO provam que nada foi gravado; qualquer outra é AMBIGUO (o enviador marca INCERTO).
 * NÃO prova o comportamento da AWS: o pedido montado aqui é conferido contra o SDK falso e, depois do gate DEP-2, contra o SDK real sem rede e em T2.
 */

const REGIAO = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const CONTA = /^\d{12}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const CHAVE_S3 = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const PREFIXO = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*$/;
const VERSAO_ID = /^[A-Za-z0-9._+-]{1,1024}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARN_CHAVE = /^arn:aws:kms:[a-z]{2}(?:-[a-z]+)+-\d{1,2}:\d{12}:key\/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|mrk-[0-9a-f]{32})$/;
const NOME_DO_ERRO = /^[A-Za-z][A-Za-z0-9]{2,63}$/;
const PAGINA = 1000;
const MAXIMO_DE_PAGINAS = 20000;
const LIMITE_VERSOES = 1000000;
const BLOB_MAXIMO = 4096;
const NEGADOS = new Set(['AccessDenied', 'AllAccessDisabled', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken', 'NoSuchBucket', 'AccountProblem', 'NotSignedUp', 'CredentialsProviderError']);
const CHECKSUM_REJEITADO = new Set(['BadDigest', 'InvalidDigest', 'XAmzContentSHA256Mismatch', 'InvalidChecksum']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração da porta AWS inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const sdkIncompativel = () => Object.assign(new TypeError('SDK da AWS incompatível com a porta'), { code: 'SDK_INCOMPATIVEL' });
const entradaInvalida = () => Object.assign(new TypeError('entrada da porta AWS inválida'), { code: 'ENTRADA_INVALIDA' });
const respostaInvalida = () => Object.assign(new Error('resposta do serviço fora do contrato'), { code: 'RESPOSTA_INVALIDA' });
const ambiguo = () => Object.assign(new Error('falha ao gravar o objeto no S3'), { code: 'AMBIGUO' });
const nomeSeguro = (e) => (e !== null && typeof e === 'object' && typeof e.name === 'string' && NOME_DO_ERRO.test(e.name) ? e.name : 'ErroDoServico');
const statusDe = (e) => (e !== null && typeof e === 'object' && e.$metadata !== null && typeof e.$metadata === 'object' ? e.$metadata.httpStatusCode : undefined);
const tentativasDe = (o) => {
  const t = o !== null && typeof o === 'object' && o.$metadata !== null && typeof o.$metadata === 'object' ? o.$metadata.attempts : undefined;
  return Number.isInteger(t) && t >= 1 && t <= 100 ? t : 1;
};
function erroDoServico(e) {
  const erro = Object.assign(new Error('falha na chamada ao serviço da AWS'), { code: 'AWS_ERRO' });
  erro.name = nomeSeguro(e);
  return erro;
}

const configEscrita = (regiao, credenciais) => ({ region: regiao, credentials: credenciais, maxAttempts: 1, followRegionRedirects: false, requestChecksumCalculation: 'WHEN_REQUIRED' });
const configLeituraS3 = (regiao, credenciais) => ({ region: regiao, credentials: credenciais, maxAttempts: 3, followRegionRedirects: false });
const configServico = (regiao, credenciais) => ({ region: regiao, credentials: credenciais, maxAttempts: 3 });

function validarOpcoes(opcoes, simbolos) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['sdk', 'regiao', 'credenciais'])) throw configuracaoInvalida();
  const { sdk, regiao, credenciais } = opcoes;
  if (!ehObjeto(sdk) || typeof regiao !== 'string' || !REGIAO.test(regiao) || typeof credenciais !== 'function') throw configuracaoInvalida();
  if (!simbolos.every((s) => typeof sdk[s] === 'function')) throw sdkIncompativel();
  return { sdk, regiao, credenciais };
}
function validarBucket(pedido, extras = []) {
  if (!ehObjeto(pedido) || !chavesExatas(pedido, ['bucket', 'donoEsperado', ...extras]) || typeof pedido.bucket !== 'string' || !BUCKET.test(pedido.bucket) || typeof pedido.donoEsperado !== 'string' || !CONTA.test(pedido.donoEsperado)) throw entradaInvalida();
}
const chaveValida = (c) => typeof c === 'string' && c.length <= 1024 && CHAVE_S3.test(c);
const versaoValida = (v) => typeof v === 'string' && VERSAO_ID.test(v) && v !== 'null';

async function consultarIdentidade(sts, sdk) {
  let r;
  try { r = await sts.send(new sdk.GetCallerIdentityCommand({})); } catch (e) { throw erroDoServico(e); }
  if (!ehObjeto(r) || typeof r.Account !== 'string' || !CONTA.test(r.Account) || typeof r.Arn !== 'string' || r.Arn.length > 2048 || !r.Arn.startsWith('arn:aws:')) throw respostaInvalida();
  return Object.freeze({ contaId: r.Account, arn: r.Arn });
}
/** Chama o serviço; erros do SDK viram erro sanitizado. */
async function chamar(cliente, comando) {
  try { return await cliente.send(comando); } catch (e) { throw erroDoServico(e); }
}
/** Como `chamar`, mas devolve `null` quando o serviço diz que o recurso não está configurado. */
async function chamarOuNulo(cliente, comando, nomeDeNaoConfigurado) {
  try { return await cliente.send(comando); } catch (e) {
    if (e !== null && typeof e === 'object' && e.name === nomeDeNaoConfigurado) return null;
    throw erroDoServico(e);
  }
}
const encerrar = (fluxo) => { try { if (fluxo !== null && typeof fluxo === 'object' && typeof fluxo.destroy === 'function') fluxo.destroy(); } catch { /* o fluxo já falhou */ } };

/** Porta do PUBLICADOR: identidade, configuração do bucket, descrição de chave e UMA gravação de objeto novo. */
function criarPortaDoPublicador(opcoes) {
  const { sdk, regiao, credenciais } = validarOpcoes(opcoes, ['S3Client', 'STSClient', 'KMSClient', 'GetCallerIdentityCommand', 'HeadBucketCommand', 'GetBucketVersioningCommand', 'GetObjectLockConfigurationCommand', 'GetBucketEncryptionCommand', 'GetBucketOwnershipControlsCommand', 'DescribeKeyCommand', 'PutObjectCommand']);
  const s3 = new sdk.S3Client(configEscrita(regiao, credenciais));
  const sts = new sdk.STSClient(configServico(regiao, credenciais));
  const kms = new sdk.KMSClient(configServico(regiao, credenciais));

  async function lerConfiguracaoDoBucket(pedido) {
    validarBucket(pedido);
    const base = { Bucket: pedido.bucket, ExpectedBucketOwner: pedido.donoEsperado };
    let regiaoReal;
    try { regiaoReal = (await s3.send(new sdk.HeadBucketCommand(base))).BucketRegion; } catch (e) {
      const cabecalho = e !== null && typeof e === 'object' && e.$response !== null && typeof e.$response === 'object' && e.$response.headers !== null && typeof e.$response.headers === 'object' ? e.$response.headers['x-amz-bucket-region'] : undefined;
      if (statusDe(e) === 301 && typeof cabecalho === 'string' && REGIAO.test(cabecalho)) {
        return Object.freeze({ regiao: cabecalho, versionamento: null, objectLock: Object.freeze({ habilitado: false, modo: null, dias: null }), criptografiaPadrao: null, propriedade: null, donoConfirmado: false });
      }
      throw erroDoServico(e);
    }
    if (typeof regiaoReal !== 'string' || !REGIAO.test(regiaoReal)) throw respostaInvalida();
    const versionamentoBruto = (await chamar(s3, new sdk.GetBucketVersioningCommand(base))).Status;
    const versionamento = versionamentoBruto === undefined ? 'Disabled' : versionamentoBruto;
    if (typeof versionamento !== 'string') throw respostaInvalida();
    let objectLock = { habilitado: false, modo: null, dias: null };
    const lock = await chamarOuNulo(s3, new sdk.GetObjectLockConfigurationCommand(base), 'ObjectLockConfigurationNotFoundError');
    if (lock !== null) {
      const c = ehObjeto(lock.ObjectLockConfiguration) ? lock.ObjectLockConfiguration : {};
      const retencao = ehObjeto(c.Rule) && ehObjeto(c.Rule.DefaultRetention) ? c.Rule.DefaultRetention : {};
      let dias = null;
      if (Number.isInteger(retencao.Days)) dias = retencao.Days;
      else if (Number.isInteger(retencao.Years)) dias = retencao.Years * 365;
      objectLock = { habilitado: c.ObjectLockEnabled === 'Enabled', modo: typeof retencao.Mode === 'string' ? retencao.Mode : null, dias };
    }
    let criptografiaPadrao = null;
    const sse = await chamarOuNulo(s3, new sdk.GetBucketEncryptionCommand(base), 'ServerSideEncryptionConfigurationNotFoundError');
    if (sse !== null) {
      const regras = ehObjeto(sse.ServerSideEncryptionConfiguration) ? sse.ServerSideEncryptionConfiguration.Rules : undefined;
      if (!Array.isArray(regras) || regras.length !== 1) criptografiaPadrao = 'REGRAS_MULTIPLAS_OU_AUSENTES';
      else criptografiaPadrao = ehObjeto(regras[0]) && ehObjeto(regras[0].ApplyServerSideEncryptionByDefault) && typeof regras[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm === 'string' ? regras[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm : null;
    }
    let propriedade = null;
    const dono = await chamarOuNulo(s3, new sdk.GetBucketOwnershipControlsCommand(base), 'OwnershipControlsNotFoundError');
    if (dono !== null) {
      const regras = ehObjeto(dono.OwnershipControls) ? dono.OwnershipControls.Rules : undefined;
      propriedade = Array.isArray(regras) && regras.length === 1 && ehObjeto(regras[0]) && typeof regras[0].ObjectOwnership === 'string' ? regras[0].ObjectOwnership : null;
    }
    return Object.freeze({ regiao: regiaoReal, versionamento, objectLock: Object.freeze(objectLock), criptografiaPadrao, propriedade, donoConfirmado: true });
  }

  async function descreverChave(pedido) {
    if (!ehObjeto(pedido) || !chavesExatas(pedido, ['chaveArn']) || typeof pedido.chaveArn !== 'string' || !ARN_CHAVE.test(pedido.chaveArn)) throw entradaInvalida();
    const r = await chamar(kms, new sdk.DescribeKeyCommand({ KeyId: pedido.chaveArn }));
    const m = ehObjeto(r) ? r.KeyMetadata : undefined;
    if (!ehObjeto(m) || m.Arn !== pedido.chaveArn || typeof m.KeyState !== 'string') throw respostaInvalida();
    let especificacao;
    if (m.KeyManager !== 'CUSTOMER') especificacao = 'GERENCIADA_PELA_AWS';
    else if (m.KeyUsage !== 'ENCRYPT_DECRYPT') especificacao = 'USO_INVALIDO';
    else especificacao = m.KeySpec ?? m.CustomerMasterKeySpec;
    if (typeof especificacao !== 'string') throw respostaInvalida();
    return Object.freeze({ estado: m.KeyState, especificacao });
  }

  async function gravarObjeto(pedido) {
    const campos = ['bucket', 'donoEsperado', 'chave', 'bytes', 'sha256', 'abrirFluxo', 'naoSobrescrever'];
    if (!ehObjeto(pedido) || !chavesExatas(pedido, campos) || pedido.naoSobrescrever !== true || typeof pedido.abrirFluxo !== 'function') throw entradaInvalida();
    validarBucket({ bucket: pedido.bucket, donoEsperado: pedido.donoEsperado });
    if (!chaveValida(pedido.chave) || !Number.isSafeInteger(pedido.bytes) || pedido.bytes < 0 || pedido.bytes > LIMITE_OBJETO_BYTES || typeof pedido.sha256 !== 'string' || !SHA256.test(pedido.sha256)) throw entradaInvalida();
    const corpo = pedido.abrirFluxo();
    const esperado = Buffer.from(pedido.sha256, 'hex').toString('base64');
    let saida;
    try {
      saida = await s3.send(new sdk.PutObjectCommand({ Bucket: pedido.bucket, Key: pedido.chave, Body: corpo, ContentLength: pedido.bytes, ChecksumSHA256: esperado, IfNoneMatch: '*', ExpectedBucketOwner: pedido.donoEsperado }));
    } catch (e) {
      encerrar(corpo);
      const nome = nomeSeguro(e);
      const status = statusDe(e);
      if (nome === 'PreconditionFailed' || status === 412) return Object.freeze({ resultado: 'JA_EXISTE', tentativas: tentativasDe(e) });
      if (NEGADOS.has(nome) || status === 403) throw Object.assign(new Error('gravação negada pelo S3'), { code: 'NEGADO' });
      if (CHECKSUM_REJEITADO.has(nome)) throw Object.assign(new Error('checksum rejeitado pelo S3'), { code: 'CHECKSUM_REJEITADO' });
      throw ambiguo();
    }
    if (!ehObjeto(saida) || !versaoValida(saida.VersionId) || saida.ChecksumSHA256 !== esperado) throw ambiguo();
    return Object.freeze({ resultado: 'GRAVADO', versaoId: saida.VersionId, sha256: pedido.sha256, bytes: pedido.bytes, tentativas: tentativasDe(saida) });
  }

  return Object.freeze({ identidade: () => consultarIdentidade(sts, sdk), lerConfiguracaoDoBucket, descreverChave, gravarObjeto });
}

/** Porta do VERIFICADOR (fora do host): identidade, listagem de versões e metadados da versão. Nunca grava nem lê o conteúdo. */
function criarPortaDoVerificador(opcoes) {
  const { sdk, regiao, credenciais } = validarOpcoes(opcoes, ['S3Client', 'STSClient', 'GetCallerIdentityCommand', 'ListObjectVersionsCommand', 'HeadObjectCommand']);
  const s3 = new sdk.S3Client(configLeituraS3(regiao, credenciais));
  const sts = new sdk.STSClient(configServico(regiao, credenciais));

  async function listarVersoes(pedido) {
    validarBucket(pedido, ['prefixo']);
    if (typeof pedido.prefixo !== 'string' || pedido.prefixo.length > 1024 || !PREFIXO.test(pedido.prefixo)) throw entradaInvalida();
    const saida = [];
    let marcadores = {};
    for (let pagina = 0; pagina < MAXIMO_DE_PAGINAS; pagina += 1) {
      const r = await chamar(s3, new sdk.ListObjectVersionsCommand({ Bucket: pedido.bucket, Prefix: pedido.prefixo, ExpectedBucketOwner: pedido.donoEsperado, MaxKeys: PAGINA, ...marcadores }));
      if (!ehObjeto(r)) throw respostaInvalida();
      for (const [lista, marcador] of [[r.Versions, false], [r.DeleteMarkers, true]]) {
        if (lista !== undefined && !Array.isArray(lista)) throw respostaInvalida();
        for (const v of lista ?? []) {
          if (!ehObjeto(v) || typeof v.Key !== 'string' || typeof v.VersionId !== 'string') throw respostaInvalida();
          saida.push(Object.freeze({ chave: v.Key, versaoId: v.VersionId, ehAtual: v.IsLatest === true, marcadorDeExclusao: marcador }));
        }
      }
      if (saida.length > LIMITE_VERSOES) throw respostaInvalida();
      if (r.IsTruncated !== true) return Object.freeze(saida);
      if (typeof r.NextKeyMarker !== 'string' || typeof r.NextVersionIdMarker !== 'string') throw respostaInvalida();
      marcadores = { KeyMarker: r.NextKeyMarker, VersionIdMarker: r.NextVersionIdMarker };
    }
    throw respostaInvalida();
  }

  async function lerMetadadosDaVersao(pedido) {
    validarBucket(pedido, ['chave', 'versaoId']);
    if (!chaveValida(pedido.chave) || !versaoValida(pedido.versaoId)) throw entradaInvalida();
    const h = await chamar(s3, new sdk.HeadObjectCommand({ Bucket: pedido.bucket, Key: pedido.chave, VersionId: pedido.versaoId, ExpectedBucketOwner: pedido.donoEsperado, ChecksumMode: 'ENABLED' }));
    const sha256 = ehObjeto(h) && typeof h.ChecksumSHA256 === 'string' ? Buffer.from(h.ChecksumSHA256, 'base64').toString('hex') : '';
    if (!ehObjeto(h) || !Number.isSafeInteger(h.ContentLength) || h.ContentLength < 0 || !SHA256.test(sha256)) throw respostaInvalida();
    let retencao = null;
    if (typeof h.ObjectLockMode === 'string' && h.ObjectLockRetainUntilDate !== undefined) {
      const ate = new Date(h.ObjectLockRetainUntilDate);
      if (Number.isNaN(ate.getTime())) throw respostaInvalida();
      retencao = Object.freeze({ modo: h.ObjectLockMode, ate: ate.toISOString() });
    }
    return Object.freeze({ bytes: h.ContentLength, sha256, retencao });
  }

  return Object.freeze({ identidade: () => consultarIdentidade(sts, sdk), listarVersoes, lerMetadadosDaVersao });
}

/** Porta da RESTAURAÇÃO: identidade e leitura de UMA versão explícita. Nunca grava nem lista. */
function criarPortaDaRestauracao(opcoes) {
  const { sdk, regiao, credenciais } = validarOpcoes(opcoes, ['S3Client', 'STSClient', 'GetCallerIdentityCommand', 'GetObjectCommand']);
  const s3 = new sdk.S3Client(configLeituraS3(regiao, credenciais));
  const sts = new sdk.STSClient(configServico(regiao, credenciais));

  async function lerVersao(pedido) {
    validarBucket(pedido, ['chave', 'versaoId']);
    if (!chaveValida(pedido.chave) || !versaoValida(pedido.versaoId)) throw entradaInvalida();
    let g;
    try {
      g = await s3.send(new sdk.GetObjectCommand({ Bucket: pedido.bucket, Key: pedido.chave, VersionId: pedido.versaoId, ExpectedBucketOwner: pedido.donoEsperado, ChecksumMode: 'ENABLED' }));
    } catch (e) {
      const nome = nomeSeguro(e);
      if (nome === 'NoSuchKey' || nome === 'NoSuchVersion') throw Object.assign(new Error('objeto não encontrado'), { code: 'NAO_ENCONTRADO' });
      throw erroDoServico(e);
    }
    if (!ehObjeto(g) || !Number.isSafeInteger(g.ContentLength) || g.ContentLength < 0 || g.Body === null || typeof g.Body !== 'object' || typeof g.Body[Symbol.asyncIterator] !== 'function') {
      encerrar(ehObjeto(g) ? g.Body : null);
      throw respostaInvalida();
    }
    return Object.freeze({ bytes: g.ContentLength, fluxo: g.Body });
  }

  return Object.freeze({ identidade: () => consultarIdentidade(sts, sdk), lerVersao });
}

/** Porta do KMS para o provedor pré-resolvido: `decifrar` com a chave fixada, o contexto e o algoritmo simétrico. Entrega uma cópia do segredo e zera o buffer do SDK. */
function criarPortaKms(opcoes) {
  const { sdk, regiao, credenciais } = validarOpcoes(opcoes, ['KMSClient', 'DecryptCommand']);
  const kms = new sdk.KMSClient(configServico(regiao, credenciais));
  const contextoValido = (c) => ehObjeto(c) && Object.keys(c).length >= 1 && Object.keys(c).length <= 8 && Object.entries(c).every(([k, v]) => k.length <= 128 && typeof v === 'string' && v.length <= 128);

  async function decifrar(pedido) {
    if (!ehObjeto(pedido) || !chavesExatas(pedido, ['chaveArn', 'contexto', 'blob']) || typeof pedido.chaveArn !== 'string' || !ARN_CHAVE.test(pedido.chaveArn) || !contextoValido(pedido.contexto)
      || !(pedido.blob instanceof Uint8Array) || pedido.blob.length < 1 || pedido.blob.length > BLOB_MAXIMO) throw entradaInvalida();
    const falhou = () => Object.assign(new Error('falha ao decifrar com o KMS'), { code: 'KMS_FALHOU' });
    let r;
    try {
      r = await kms.send(new sdk.DecryptCommand({ KeyId: pedido.chaveArn, CiphertextBlob: pedido.blob, EncryptionContext: { ...pedido.contexto }, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' }));
    } catch { throw falhou(); }
    const claro = ehObjeto(r) ? r.Plaintext : undefined;
    if (!(claro instanceof Uint8Array)) throw falhou();
    const segredo = Buffer.from(claro);
    claro.fill(0);
    if (typeof r.KeyId !== 'string') { segredo.fill(0); throw falhou(); }
    return Object.freeze({ chaveArn: r.KeyId, segredo });
  }

  return Object.freeze({ decifrar });
}

module.exports = { criarPortaDoPublicador, criarPortaDoVerificador, criarPortaDaRestauracao, criarPortaKms };
