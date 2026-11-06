'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { arnDe } = require('./s3-falso');
const { criarKmsFalso } = require('./kms-falso');

/**
 * DEP-2 (preparação): SDK AWS FALSO em memória, no nível dos COMANDOS (`client.send(new XCommand(input))`). Sem rede, sem AWS e sem o pacote real: serve para provar que os
 * adaptadores montam exatamente os pedidos esperados e traduzem as respostas e os erros. O papel que chama é decidido pela credencial do cliente (`credenciais(papel)`); cada papel
 * só tem as operações do seu mínimo (as demais respondem AccessDenied). Não prova o comportamento da AWS real: isso é T2.
 */

const OPERACOES = Object.freeze({
  s3: ['HeadBucket', 'GetBucketVersioning', 'GetObjectLockConfiguration', 'GetBucketEncryption', 'GetBucketOwnershipControls', 'PutObject', 'HeadObject', 'GetObject', 'ListObjectVersions'],
  kms: ['DescribeKey', 'Decrypt'],
  sts: ['GetCallerIdentity'],
});
const PERMISSOES = Object.freeze({
  publicador: new Set(['sts:GetCallerIdentity', 's3:HeadBucket', 's3:GetBucketVersioning', 's3:GetObjectLockConfiguration', 's3:GetBucketEncryption', 's3:GetBucketOwnershipControls', 's3:PutObject', 'kms:DescribeKey', 'kms:Decrypt']),
  verificador: new Set(['sts:GetCallerIdentity', 's3:ListObjectVersions', 's3:HeadObject']),
  restauracao: new Set(['sts:GetCallerIdentity', 's3:GetObject', 'kms:Decrypt']),
});

const base64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const hexDe = (b) => crypto.createHash('sha256').update(b).digest('hex');
const erroAws = (name, status, extra = {}) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status, attempts: 1 }, ...extra });
const semCodigo = (code) => Object.assign(new Error(code), { code });
async function lerTudo(corpo) {
  if (Buffer.isBuffer(corpo)) return corpo;
  const partes = [];
  for await (const b of corpo) partes.push(Buffer.from(b));
  return Buffer.concat(partes);
}

function criarSdkFalso({ ficha, relogio = () => Date.now(), identidades = {}, pagina = 1000 }) {
  const estado = { clientes: [], chamadas: [], plaintexts: [] };
  const kms = criarKmsFalso();
  const objetos = new Map();
  const fila = [];
  const chaves = new Map([[ficha.chaveMac, {}], [ficha.chaveCifra, {}]]);
  let seq = 0;
  const bucket = {
    regiao: ficha.regiao, versionamento: 'Enabled', objectLock: { habilitado: true, modo: ficha.retencao.modo, dias: ficha.retencao.dias, anos: null },
    sse: 'AES256', ownership: 'BucketOwnerEnforced', regiaoDoHead: null,
  };

  const credenciais = (papel) => async () => ({ accessKeyId: `FAKE-${papel}`, secretAccessKey: 'segredo-falso', sessionToken: 'token-falso' });
  const identidadeDe = (papel) => { const p = identidades[papel] ?? ficha.identidades[papel]; return { Account: p.contaId, Arn: arnDe(p), UserId: `ID-${papel}` }; };
  const programar = (operacao, modo) => fila.push({ operacao, modo });
  const proximoModo = (operacao) => { const i = fila.findIndex((f) => f.operacao === operacao); return i < 0 ? null : fila.splice(i, 1)[0].modo; };

  function exigirBucket(input) {
    if (input.Bucket !== ficha.bucket) throw erroAws('NoSuchBucket', 404);
    if (input.ExpectedBucketOwner !== ficha.contaId) throw erroAws('AccessDenied', 403);
  }
  function acrescentar(chave, conteudo) {
    seq += 1;
    const lista = objetos.get(chave) ?? [];
    const ol = bucket.objectLock;
    const dias = ol.anos !== null ? ol.anos * 365 : ol.dias;
    const retencao = ol.habilitado && ol.modo ? { modo: ol.modo, ate: new Date(relogio() + (dias ?? 0) * 86400000) } : null;
    const versao = { versaoId: `v${seq}.${crypto.randomBytes(4).toString('hex')}`, conteudo: Buffer.from(conteudo), sha256: hexDe(conteudo), retencao, marcador: false };
    lista.push(versao);
    objetos.set(chave, lista);
    return versao;
  }
  function achar(input) {
    exigirBucket(input);
    const lista = objetos.get(input.Key);
    if (lista === undefined) throw erroAws('NoSuchKey', 404);
    const v = lista.find((x) => x.versaoId === input.VersionId);
    if (v === undefined) throw erroAws('NoSuchVersion', 404);
    return v;
  }

  const manipuladores = {
    's3:HeadBucket': (input, cliente) => {
      exigirBucket(input);
      const real = bucket.regiaoDoHead ?? bucket.regiao;
      if (cliente.config.region !== real && cliente.config.followRegionRedirects === false) throw erroAws('PermanentRedirect', 301, { $response: { headers: { 'x-amz-bucket-region': real } } });
      return { BucketRegion: real };
    },
    's3:GetBucketVersioning': (input) => { exigirBucket(input); return bucket.versionamento === 'Disabled' ? {} : { Status: bucket.versionamento }; },
    's3:GetObjectLockConfiguration': (input) => {
      exigirBucket(input);
      const ol = bucket.objectLock;
      if (!ol.habilitado) throw erroAws('ObjectLockConfigurationNotFoundError', 404);
      return { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', ...(ol.modo ? { Rule: { DefaultRetention: { Mode: ol.modo, ...(ol.anos !== null ? { Years: ol.anos } : { Days: ol.dias }) } } } : {}) } };
    },
    's3:GetBucketEncryption': (input) => {
      exigirBucket(input);
      if (bucket.sse === null) throw erroAws('ServerSideEncryptionConfigurationNotFoundError', 404);
      return { ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: bucket.sse } }] } };
    },
    's3:GetBucketOwnershipControls': (input) => {
      exigirBucket(input);
      if (bucket.ownership === null) throw erroAws('OwnershipControlsNotFoundError', 404);
      return { OwnershipControls: { Rules: [{ ObjectOwnership: bucket.ownership }] } };
    },
    's3:PutObject': async (input) => {
      exigirBucket(input);
      const modo = proximoModo('PutObject');
      if (modo === 'NEGAR') throw erroAws('AccessDenied', 403);
      if (modo === 'REDE_ANTES') throw semCodigo('ECONNRESET');
      if (modo === 'ERRO_500') throw erroAws('InternalError', 500);
      if (modo === 'CONFLITO_409') throw erroAws('ConditionalRequestConflict', 409);
      const corpo = await lerTudo(input.Body);
      if (input.ContentLength !== corpo.length) throw erroAws('IncompleteBody', 400);
      if (input.ChecksumSHA256 !== base64(hexDe(corpo))) throw erroAws('BadDigest', 400);
      if (input.IfNoneMatch === '*' && (objetos.get(input.Key) ?? []).some((v) => !v.marcador)) throw erroAws('PreconditionFailed', 412);
      const versao = acrescentar(input.Key, corpo);
      if (modo === 'REDE_DEPOIS') throw semCodigo('ECONNRESET');
      const saida = { VersionId: versao.versaoId, ChecksumSHA256: base64(versao.sha256), ETag: '"etag"', $metadata: { httpStatusCode: 200, attempts: modo === 'TENTATIVAS_2' ? 2 : 1 } };
      if (modo === 'SEM_VERSAO') delete saida.VersionId;
      if (modo === 'SEM_CHECKSUM') delete saida.ChecksumSHA256;
      if (modo === 'CHECKSUM_OUTRO') saida.ChecksumSHA256 = base64('b'.repeat(64));
      return saida;
    },
    's3:HeadObject': (input) => {
      const v = achar(input);
      return {
        ContentLength: v.conteudo.length, ...(input.ChecksumMode === 'ENABLED' && !bucket.semChecksumNoHead ? { ChecksumSHA256: base64(v.sha256) } : {}),
        ...(v.retencao ? { ObjectLockMode: v.retencao.modo, ObjectLockRetainUntilDate: v.retencao.ate } : {}),
      };
    },
    's3:GetObject': (input) => {
      const v = achar(input);
      const bloco = 4096;
      const partes = [];
      for (let i = 0; i < v.conteudo.length; i += bloco) partes.push(Buffer.from(v.conteudo.subarray(i, i + bloco)));
      return { ContentLength: v.conteudo.length, Body: Readable.from(partes), ...(input.ChecksumMode === 'ENABLED' ? { ChecksumSHA256: base64(v.sha256) } : {}) };
    },
    's3:ListObjectVersions': (input) => {
      exigirBucket(input);
      const todos = [];
      for (const [chave, lista] of objetos) {
        if (typeof input.Prefix === 'string' && !chave.startsWith(input.Prefix)) continue;
        lista.forEach((v, i) => todos.push({ Key: chave, VersionId: v.versaoId, IsLatest: i === lista.length - 1, marcador: v.marcador }));
      }
      let inicio = 0;
      if (input.KeyMarker !== undefined) inicio = todos.findIndex((t) => t.Key === input.KeyMarker && t.VersionId === input.VersionIdMarker) + 1;
      const fatia = todos.slice(inicio, inicio + Math.min(input.MaxKeys ?? pagina, pagina));
      const truncado = inicio + fatia.length < todos.length;
      const ultimo = fatia.at(-1);
      return {
        IsTruncated: truncado, ...(truncado ? { NextKeyMarker: ultimo.Key, NextVersionIdMarker: ultimo.VersionId } : {}),
        Versions: fatia.filter((t) => !t.marcador).map(({ Key, VersionId, IsLatest }) => ({ Key, VersionId, IsLatest })),
        DeleteMarkers: fatia.filter((t) => t.marcador).map(({ Key, VersionId, IsLatest }) => ({ Key, VersionId, IsLatest })),
      };
    },
    'kms:DescribeKey': (input) => {
      if (!chaves.has(input.KeyId)) throw erroAws('NotFoundException', 400);
      return { KeyMetadata: { Arn: input.KeyId, KeyState: 'Enabled', KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', KeyManager: 'CUSTOMER', ...chaves.get(input.KeyId) } };
    },
    'kms:Decrypt': async (input) => {
      let r;
      try { r = await kms.cliente.decifrar({ chaveArn: input.KeyId, contexto: input.EncryptionContext, blob: input.CiphertextBlob }); } catch { throw erroAws('InvalidCiphertextException', 400); }
      const plaintext = new Uint8Array(r.segredo);
      estado.plaintexts.push(plaintext);
      return { KeyId: r.chaveArn, Plaintext: plaintext, EncryptionAlgorithm: input.EncryptionAlgorithm };
    },
    'sts:GetCallerIdentity': (_input, _cliente, papel) => identidadeDe(papel),
  };

  const comandos = {};
  const clientes = {};
  for (const [servico, ops] of Object.entries(OPERACOES)) {
    for (const op of ops) {
      comandos[`${op}Command`] = class { constructor(input) { this.input = input; } static get operacao() { return `${servico}:${op}`; } };
    }
    const nomeDoCliente = { s3: 'S3Client', kms: 'KMSClient', sts: 'STSClient' }[servico];
    clientes[nomeDoCliente] = class {
      constructor(config) { this.config = config; this.servico = servico; estado.clientes.push({ servico, config }); }
      async send(comando) {
        const operacao = comando.constructor.operacao;
        const cred = await this.config.credentials();
        const papel = String(cred.accessKeyId).replace(/^FAKE-/, '');
        const { Body: _corpo, CiphertextBlob: _blob, ...visivel } = comando.input;
        estado.chamadas.push({ papel, operacao, input: { ...visivel, ...(comando.input.Body !== undefined ? { Body: '[corpo]' } : {}) } });
        if (!PERMISSOES[papel]?.has(operacao)) throw erroAws('AccessDenied', 403);
        const resposta = await manipuladores[operacao](comando.input, this, papel);
        return { ...resposta, $metadata: resposta.$metadata ?? { httpStatusCode: 200, attempts: 1 } };
      }
    };
  }

  return {
    sdk: Object.freeze({ ...clientes, ...comandos }),
    estado, kms, credenciais, programar, bucket, objetos,
    chaves: { definir: (arn, meta) => chaves.set(arn, meta), esquecer: (arn) => chaves.delete(arn) },
    versoes: (chave) => (objetos.get(chave) ?? []).map((v) => ({ versaoId: v.versaoId, sha256: v.sha256, bytes: v.conteudo.length, retencao: v.retencao })),
    injetarVersaoExtra: (chave, conteudo) => acrescentar(chave, Buffer.from(conteudo)).versaoId,
    adicionarMarcadorDeExclusao: (chave) => { const l = objetos.get(chave); seq += 1; l.push({ versaoId: `m${seq}`, conteudo: Buffer.alloc(0), sha256: '', retencao: null, marcador: true }); },
    comandosUsados: (papel) => [...new Set(estado.chamadas.filter((c) => c.papel === papel).map((c) => c.operacao))].sort(),
  };
}

module.exports = { criarSdkFalso, OPERACOES, PERMISSOES };
