'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const P = require('../../src/services/backup-aws-portas.service');
const S3 = require('../../src/services/backup-armazenamento-s3.service');
const V = require('../../src/services/backup-verificador-duravel.service');
const D = require('../../src/services/backup-baixador-duravel.service');
const Rb = require('../../src/services/backup-recibo-duravel.service');
const Kms = require('../../src/services/backup-fontes-kms-pre-resolvido.service');
const X = require('../../src/services/backup-custodia-xor.service');
const { criarSdkFalso } = require('../helpers/sdk-aws-falso');
const { fichaDeTeste, registro } = require('../helpers/fichas-duraveis');
const { ambienteS3, sha } = require('../helpers/ambiente-s3-falso');
const { novaRaiz, limparRaizes } = require('../helpers/pacote-l2-sintetico');

/**
 * DEP-2 (preparação) [AWS]: adaptadores das portas S3/KMS/STS sobre o SDK da AWS INJETADO. Aqui o SDK é o falso (comandos em memória): prova-se o pedido exato montado por cada
 * porta, a tradução das respostas e dos erros e o mínimo de operações por papel, e liga-se cada porta aos módulos reais (enviador, verificador, baixador, provedor KMS).
 * Nada contata a AWS; o comportamento da AWS real continua sendo T2.
 */

after(limparRaizes);
const ficha = fichaDeTeste('HOMOLOGACAO');
const AGORA = 1_800_000_000_000;
const montar = (opcoes = {}) => {
  const f = criarSdkFalso({ ficha, relogio: () => AGORA, pagina: opcoes.pagina });
  const base = (papel) => ({ sdk: f.sdk, regiao: ficha.regiao, credenciais: f.credenciais(papel) });
  return {
    f, base,
    publicador: P.criarPortaDoPublicador(base('publicador')),
    verificador: P.criarPortaDoVerificador(base('verificador')),
    restauracao: P.criarPortaDaRestauracao(base('restauracao')),
  };
};
const DONO = { bucket: ficha.bucket, donoEsperado: ficha.contaId };
const b64 = (hex) => Buffer.from(hex, 'hex').toString('base64');
const falha = async (promessa) => { try { await promessa; } catch (e) { return e; } return assert.fail('deveria falhar'); };
const grava = (m, chave, conteudo, extra = {}) => m.publicador.gravarObjeto({ ...DONO, chave, bytes: conteudo.length, sha256: sha(conteudo), abrirFluxo: () => Readable.from([conteudo]), naoSobrescrever: true, ...extra });
const ultimaChamada = (m, operacao) => m.f.estado.chamadas.filter((c) => c.operacao === operacao).at(-1);

describe('[AWS] fábricas: configuração estrita e clientes por papel', () => {
  test('AWS-01 — opções desconhecidas (inclusive `endpoint`), região fora do formato, credencial que não é função e SDK sem símbolo: recusados sem criar cliente', () => {
    const f = criarSdkFalso({ ficha });
    const ok = { sdk: f.sdk, regiao: 'us-east-1', credenciais: f.credenciais('publicador') };
    const c = (o, fabrica = P.criarPortaDoPublicador) => { try { fabrica(o); } catch (e) { return e.code; } return null; };
    assert.equal(c(undefined), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, endpoint: 'http://localhost:4566' }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, regiao: 'US_EAST_1' }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, regiao: 'us-east-1/../x' }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, credenciais: { accessKeyId: 'AKIA', secretAccessKey: 'x' } }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, credenciais: undefined }), 'CONFIGURACAO_INVALIDA');
    const { PutObjectCommand: _omitido, ...semPut } = f.sdk;
    assert.equal(c({ ...ok, sdk: semPut }), 'SDK_INCOMPATIVEL');
    assert.equal(c({ ...ok, sdk: null }), 'CONFIGURACAO_INVALIDA');
    assert.equal(f.estado.clientes.length, 0, 'nenhum cliente é criado antes de a configuração ser aceita');
    for (const fabrica of [P.criarPortaDoVerificador, P.criarPortaDaRestauracao, P.criarPortaKms]) assert.equal(c({ ...ok, endpoint: 'x' }, fabrica), 'CONFIGURACAO_INVALIDA');
  });

  test('AWS-02 — configuração dos clientes: região da ficha, credencial repassada sem leitura, sem redirecionamento de região; publicador S3 SEM retentativa automática; leituras com retentativa', () => {
    const m = montar();
    const [pubS3, pubSts, pubKms, verS3, verSts, resS3, resSts] = m.f.estado.clientes;
    assert.deepEqual([pubS3.servico, pubSts.servico, pubKms.servico, verS3.servico, verSts.servico, resS3.servico, resSts.servico], ['s3', 'sts', 'kms', 's3', 'sts', 's3', 'sts']);
    assert.deepEqual({ ...pubS3.config, credentials: typeof pubS3.config.credentials }, { region: 'us-east-1', credentials: 'function', maxAttempts: 1, followRegionRedirects: false, requestChecksumCalculation: 'WHEN_REQUIRED' });
    assert.deepEqual({ ...verS3.config, credentials: typeof verS3.config.credentials }, { region: 'us-east-1', credentials: 'function', maxAttempts: 3, followRegionRedirects: false });
    assert.deepEqual({ ...resS3.config, credentials: typeof resS3.config.credentials }, { region: 'us-east-1', credentials: 'function', maxAttempts: 3, followRegionRedirects: false });
    for (const k of [pubSts, pubKms, verSts, resSts]) assert.deepEqual({ ...k.config, credentials: typeof k.config.credentials }, { region: 'us-east-1', credentials: 'function', maxAttempts: 3 });
    assert.equal(pubS3.config.credentials, m.f.estado.clientes[0].config.credentials);
    assert.deepEqual(Object.keys(m.publicador).sort(), [...S3.METODOS_DA_PORTA].sort());
    assert.deepEqual(Object.keys(m.verificador).sort(), [...V.METODOS_DA_PORTA].sort());
    assert.deepEqual(Object.keys(m.restauracao).sort(), [...D.METODOS_DA_PORTA].sort());
  });
});

describe('[AWS] porta do PUBLICADOR', () => {
  test('AWS-03 — identidade: STS GetCallerIdentity traduzido para { contaId, arn }; resposta fora do formato falha', async () => {
    const m = montar();
    assert.deepEqual(await m.publicador.identidade(), { contaId: ficha.contaId, arn: `arn:aws:iam::${ficha.contaId}:user/safework-hml-publicador` });
    assert.deepEqual(ultimaChamada(m, 'sts:GetCallerIdentity').input, {});
    const ruim = montar();
    const original = ruim.f.sdk.GetCallerIdentityCommand;
    const sts = ruim.f.estado.clientes.find((c) => c.servico === 'sts');
    assert.ok(original && sts);
    const quebrado = P.criarPortaDoPublicador({ sdk: { ...ruim.f.sdk, STSClient: class { async send() { return { Account: 'abc', Arn: 5 }; } } }, regiao: 'us-east-1', credenciais: ruim.f.credenciais('publicador') });
    assert.equal((await falha(quebrado.identidade())).code, 'RESPOSTA_INVALIDA');
  });

  test('AWS-04 — configuração do bucket: um pedido por item, sempre com o dono esperado; forma exata; nada além de leitura de configuração', async () => {
    const m = montar();
    const cfg = await m.publicador.lerConfiguracaoDoBucket(DONO);
    assert.deepEqual(cfg, { regiao: 'us-east-1', versionamento: 'Enabled', objectLock: { habilitado: true, modo: 'GOVERNANCE', dias: 7 }, criptografiaPadrao: 'AES256', propriedade: 'BucketOwnerEnforced', donoConfirmado: true });
    const usadas = m.f.comandosUsados('publicador');
    assert.deepEqual(usadas, ['s3:GetBucketEncryption', 's3:GetBucketOwnershipControls', 's3:GetBucketVersioning', 's3:GetObjectLockConfiguration', 's3:HeadBucket']);
    for (const c of m.f.estado.chamadas) assert.deepEqual({ Bucket: c.input.Bucket, ExpectedBucketOwner: c.input.ExpectedBucketOwner }, { Bucket: ficha.bucket, ExpectedBucketOwner: ficha.contaId });
  });

  test('AWS-05 — variações da configuração: retenção em anos vira dias (365 por ano, nunca mais), Object Lock/criptografia/propriedade não configurados viram nulos, versionamento suspenso/ausente, região vinda do redirecionamento 301', async () => {
    const m = montar();
    m.f.bucket.objectLock.anos = 2; m.f.bucket.objectLock.dias = null;
    assert.deepEqual((await m.publicador.lerConfiguracaoDoBucket(DONO)).objectLock, { habilitado: true, modo: 'GOVERNANCE', dias: 730 });
    m.f.bucket.objectLock.habilitado = false;
    assert.deepEqual((await m.publicador.lerConfiguracaoDoBucket(DONO)).objectLock, { habilitado: false, modo: null, dias: null });
    m.f.bucket.sse = null; m.f.bucket.ownership = null; m.f.bucket.versionamento = 'Suspended';
    const c2 = await m.publicador.lerConfiguracaoDoBucket(DONO);
    assert.deepEqual({ v: c2.versionamento, s: c2.criptografiaPadrao, p: c2.propriedade }, { v: 'Suspended', s: null, p: null });
    m.f.bucket.versionamento = 'Disabled';
    assert.equal((await m.publicador.lerConfiguracaoDoBucket(DONO)).versionamento, 'Disabled');
    m.f.bucket.regiaoDoHead = 'sa-east-1';
    assert.equal((await m.publicador.lerConfiguracaoDoBucket(DONO)).regiao, 'sa-east-1');
  });

  test('AWS-06 — dono errado, bucket inexistente e entradas fora do formato falham (nunca viram configuração); erros de outra natureza propagam', async () => {
    const m = montar();
    assert.equal((await falha(m.publicador.lerConfiguracaoDoBucket({ bucket: ficha.bucket, donoEsperado: '999999999999' }))).name, 'AccessDenied');
    assert.equal((await falha(m.publicador.lerConfiguracaoDoBucket({ bucket: 'outro-bucket-qualquer', donoEsperado: ficha.contaId }))).name, 'NoSuchBucket');
    for (const ruim of [{ bucket: 'A', donoEsperado: ficha.contaId }, { bucket: ficha.bucket, donoEsperado: 'abc' }, { bucket: ficha.bucket }, { ...DONO, extra: 1 }]) {
      assert.equal((await falha(m.publicador.lerConfiguracaoDoBucket(ruim))).code, 'ENTRADA_INVALIDA');
    }
  });

  test('AWS-07 — chave KMS: ARN exato com estado e especificação; alias/ARN diferente na resposta, uso que não é cifrar/decifrar, chave gerenciada pela AWS e chave inexistente NÃO passam por simétrica habilitada', async () => {
    const m = montar();
    assert.deepEqual(await m.publicador.descreverChave({ chaveArn: ficha.chaveMac }), { estado: 'Enabled', especificacao: 'SYMMETRIC_DEFAULT' });
    assert.deepEqual(ultimaChamada(m, 'kms:DescribeKey').input, { KeyId: ficha.chaveMac });
    m.f.chaves.definir(ficha.chaveCifra, { KeyState: 'Disabled' });
    assert.deepEqual(await m.publicador.descreverChave({ chaveArn: ficha.chaveCifra }), { estado: 'Disabled', especificacao: 'SYMMETRIC_DEFAULT' });
    m.f.chaves.definir(ficha.chaveCifra, { KeyUsage: 'SIGN_VERIFY' });
    assert.equal((await m.publicador.descreverChave({ chaveArn: ficha.chaveCifra })).especificacao, 'USO_INVALIDO');
    m.f.chaves.definir(ficha.chaveCifra, { KeyManager: 'AWS' });
    assert.equal((await m.publicador.descreverChave({ chaveArn: ficha.chaveCifra })).especificacao, 'GERENCIADA_PELA_AWS');
    m.f.chaves.definir(ficha.chaveCifra, { Arn: `arn:aws:kms:us-east-1:${ficha.contaId}:key/00000000-0000-4000-8000-000000000000` });
    assert.equal((await falha(m.publicador.descreverChave({ chaveArn: ficha.chaveCifra }))).code, 'RESPOSTA_INVALIDA');
    assert.equal((await falha(m.publicador.descreverChave({ chaveArn: `arn:aws:kms:us-east-1:${ficha.contaId}:key/11111111-9999-4999-8999-111111111111` }))).name, 'NotFoundException');
    for (const ruim of ['alias/safework', 'arn:aws:kms:us-east-1:111111111111:alias/x', '', 5]) assert.equal((await falha(m.publicador.descreverChave({ chaveArn: ruim }))).code, 'ENTRADA_INVALIDA', String(ruim));
  });

  test('AWS-08 — gravarObjeto: UM PutObject com exatamente os campos esperados (condição de objeto novo, SHA-256 em base64, tamanho, dono); GRAVADO traz a versão, o SHA-256 e a contagem de tentativas do SDK', async () => {
    const m = montar();
    const conteudo = Buffer.from('conteudo-cifrado-aws');
    const r = await grava(m, 'hml/c1/dados/a.enc', conteudo);
    assert.deepEqual({ ...r, versaoId: typeof r.versaoId }, { resultado: 'GRAVADO', versaoId: 'string', sha256: sha(conteudo), bytes: conteudo.length, tentativas: 1 });
    assert.equal(r.versaoId, m.f.versoes('hml/c1/dados/a.enc')[0].versaoId);
    const pedido = ultimaChamada(m, 's3:PutObject').input;
    assert.deepEqual(Object.keys(pedido).sort(), ['Body', 'Bucket', 'ChecksumSHA256', 'ContentLength', 'ExpectedBucketOwner', 'IfNoneMatch', 'Key']);
    assert.deepEqual({ ...pedido, Body: undefined }, { Body: undefined, Bucket: ficha.bucket, Key: 'hml/c1/dados/a.enc', ContentLength: conteudo.length, ChecksumSHA256: b64(sha(conteudo)), IfNoneMatch: '*', ExpectedBucketOwner: ficha.contaId });
    assert.deepEqual(m.f.comandosUsados('publicador').filter((o) => o.startsWith('s3:Put')), ['s3:PutObject']);
  });

  test('AWS-09 — objeto já existente (412): JA_EXISTE sem escrever outra versão; vazio (0 byte) também grava; dois envios do mesmo nome nunca criam segunda versão', async () => {
    const m = montar();
    const a = Buffer.from('primeiro');
    assert.equal((await grava(m, 'hml/c2/x', a)).resultado, 'GRAVADO');
    assert.deepEqual(await grava(m, 'hml/c2/x', a), { resultado: 'JA_EXISTE', tentativas: 1 });
    assert.deepEqual(await grava(m, 'hml/c2/x', Buffer.from('outro conteudo')), { resultado: 'JA_EXISTE', tentativas: 1 });
    assert.equal(m.f.versoes('hml/c2/x').length, 1);
    const vazio = Buffer.alloc(0);
    assert.equal((await grava(m, 'hml/c2/vazio', vazio)).resultado, 'GRAVADO');
  });

  test('AWS-10 — erros definitivos viram NEGADO / CHECKSUM_REJEITADO (nada foi gravado); falhas ambíguas viram AMBIGUO (a verificação independente decide) e nenhuma delas é repetida', async () => {
    const m = montar();
    const c = Buffer.from('conteudo');
    m.f.programar('PutObject', 'NEGAR');
    assert.equal((await falha(grava(m, 'hml/c3/a', c))).code, 'NEGADO');
    assert.equal(m.f.versoes('hml/c3/a').length, 0);
    assert.equal((await falha(grava(m, 'hml/c3/b', c, { sha256: sha(Buffer.from('outro')) }))).code, 'CHECKSUM_REJEITADO');
    for (const [modo, chave] of [['REDE_ANTES', 'hml/c3/d'], ['REDE_DEPOIS', 'hml/c3/e'], ['ERRO_500', 'hml/c3/f'], ['CONFLITO_409', 'hml/c3/g']]) {
      m.f.programar('PutObject', modo);
      const e = await falha(grava(m, chave, c));
      assert.equal(e.code, 'AMBIGUO', modo);
      assert.doesNotMatch(String(e.message), /ECONNRESET|InternalError|Conflict/);
    }
    assert.equal(m.f.versoes('hml/c3/d').length, 0);
    assert.equal(m.f.versoes('hml/c3/e').length, 1, 'REDE_DEPOIS: gravou e perdeu a resposta — por isso é ambíguo');
    assert.equal(m.f.estado.chamadas.filter((x) => x.operacao === 's3:PutObject').length, 6, 'um pedido por tentativa de envio, sem repetição interna');
  });

  test('AWS-11 — resposta incompleta ou diferente do enviado nunca vira prova: sem versão, sem SHA-256 ou com SHA-256 de outro conteúdo não retorna os campos do recibo', async () => {
    const m = montar();
    const c = Buffer.from('conteudo-x');
    m.f.programar('PutObject', 'SEM_VERSAO');
    assert.equal((await falha(grava(m, 'hml/c4/a', c))).code, 'AMBIGUO');
    m.f.programar('PutObject', 'SEM_CHECKSUM');
    assert.equal((await falha(grava(m, 'hml/c4/b', c))).code, 'AMBIGUO');
    m.f.programar('PutObject', 'CHECKSUM_OUTRO');
    assert.equal((await falha(grava(m, 'hml/c4/c', c))).code, 'AMBIGUO');
    m.f.programar('PutObject', 'TENTATIVAS_2');
    assert.equal((await grava(m, 'hml/c4/d', c)).tentativas, 2);
  });

  test('AWS-12 — entradas da gravação fora do contrato (sem condição de objeto novo, bytes/SHA-256/chave inválidos, fluxo que não é função): recusadas ANTES de qualquer chamada', async () => {
    const m = montar();
    const antes = m.f.estado.chamadas.length;
    const c = Buffer.from('x');
    for (const ruim of [{ naoSobrescrever: false }, { naoSobrescrever: undefined }, { bytes: -1 }, { bytes: 1.5 }, { sha256: 'ZZ' }, { chave: '../x' }, { chave: '/x' }, { chave: '' }, { abrirFluxo: 'x' }, { bucket: 'Maiusculas' }, { donoEsperado: '1' }]) {
      assert.equal((await falha(grava(m, 'hml/c5/a', c, ruim))).code, 'ENTRADA_INVALIDA', JSON.stringify(ruim));
    }
    assert.equal(m.f.estado.chamadas.length, antes);
  });

  test('AWS-13 — o fluxo de origem é encerrado quando o envio falha (nenhum descritor preso)', async () => {
    const m = montar();
    const fluxo = Readable.from([Buffer.from('conteudo')]);
    m.f.programar('PutObject', 'REDE_ANTES');
    await falha(m.publicador.gravarObjeto({ ...DONO, chave: 'hml/c6/a', bytes: 8, sha256: sha(Buffer.from('conteudo')), abrirFluxo: () => fluxo, naoSobrescrever: true }));
    assert.equal(fluxo.destroyed, true);
  });
});

describe('[AWS] porta do VERIFICADOR e da RESTAURAÇÃO', () => {
  test('AWS-14 — listarVersoes: pagina até acabar, marca versão atual e marcador de exclusão, filtra por prefixo e sempre envia o dono esperado', async () => {
    const m = montar({ pagina: 2 });
    for (const n of ['a', 'b', 'c']) await grava(m, `hml/c7/${n}`, Buffer.from(`conteudo-${n}`));
    await grava(m, 'hml/outro/z', Buffer.from('fora'));
    m.f.injetarVersaoExtra('hml/c7/b', 'forjado');
    m.f.adicionarMarcadorDeExclusao('hml/c7/c');
    const lista = await m.verificador.listarVersoes({ ...DONO, prefixo: 'hml/c7/' });
    assert.equal(lista.length, 5);
    assert.equal(m.f.estado.chamadas.filter((c) => c.operacao === 's3:ListObjectVersions').length, 3, 'três páginas');
    assert.deepEqual(lista.map((v) => v.chave).sort(), ['hml/c7/a', 'hml/c7/b', 'hml/c7/b', 'hml/c7/c', 'hml/c7/c']);
    assert.equal(lista.filter((v) => v.marcadorDeExclusao).length, 1);
    assert.equal(lista.filter((v) => v.ehAtual).length, 3);
    for (const v of lista) assert.deepEqual(Object.keys(v).sort(), ['chave', 'ehAtual', 'marcadorDeExclusao', 'versaoId']);
    const paginas = m.f.estado.chamadas.filter((c) => c.operacao === 's3:ListObjectVersions').map((c) => c.input);
    assert.deepEqual(paginas.map((p) => ({ Bucket: p.Bucket, Prefix: p.Prefix, ExpectedBucketOwner: p.ExpectedBucketOwner })), Array(3).fill({ Bucket: ficha.bucket, Prefix: 'hml/c7/', ExpectedBucketOwner: ficha.contaId }));
    assert.equal(paginas[0].KeyMarker, undefined);
    assert.ok(paginas[1].KeyMarker !== undefined && paginas[1].VersionIdMarker !== undefined);
  });

  test('AWS-15 — lerMetadadosDaVersao: HeadObject da VERSÃO pedida, com checksum habilitado; SHA-256 em hexadecimal, tamanho e retenção; sem retenção = nulo; sem checksum = falha', async () => {
    const m = montar();
    const c = Buffer.from('conteudo-meta');
    const g = await grava(m, 'hml/c8/a', c);
    const meta = await m.verificador.lerMetadadosDaVersao({ ...DONO, chave: 'hml/c8/a', versaoId: g.versaoId });
    assert.deepEqual(meta, { bytes: c.length, sha256: sha(c), retencao: { modo: 'GOVERNANCE', ate: new Date(AGORA + 7 * 86400000).toISOString() } });
    assert.deepEqual(ultimaChamada(m, 's3:HeadObject').input, { Bucket: ficha.bucket, Key: 'hml/c8/a', VersionId: g.versaoId, ExpectedBucketOwner: ficha.contaId, ChecksumMode: 'ENABLED' });
    m.f.objetos.get('hml/c8/a')[0].retencao = null;
    assert.equal((await m.verificador.lerMetadadosDaVersao({ ...DONO, chave: 'hml/c8/a', versaoId: g.versaoId })).retencao, null);
    m.f.bucket.semChecksumNoHead = true;
    assert.equal((await falha(m.verificador.lerMetadadosDaVersao({ ...DONO, chave: 'hml/c8/a', versaoId: g.versaoId }))).code, 'RESPOSTA_INVALIDA');
    assert.equal((await falha(m.verificador.lerMetadadosDaVersao({ ...DONO, chave: 'hml/c8/a', versaoId: 'inexistente' }))).name, 'NoSuchVersion');
  });

  test('AWS-16 — lerVersao: GetObject da VERSÃO explícita com o dono esperado; devolve tamanho e fluxo; ausente = NAO_ENCONTRADO; versão vazia/"null"/inválida é recusada antes da chamada', async () => {
    const m = montar();
    const c = Buffer.alloc(10000, 7);
    const g = await grava(m, 'hml/c9/a', c);
    const r = await m.restauracao.lerVersao({ ...DONO, chave: 'hml/c9/a', versaoId: g.versaoId });
    assert.equal(r.bytes, c.length);
    const partes = [];
    for await (const b of r.fluxo) partes.push(Buffer.from(b));
    assert.ok(Buffer.concat(partes).equals(c));
    assert.deepEqual(ultimaChamada(m, 's3:GetObject').input, { Bucket: ficha.bucket, Key: 'hml/c9/a', VersionId: g.versaoId, ExpectedBucketOwner: ficha.contaId, ChecksumMode: 'ENABLED' });
    assert.equal((await falha(m.restauracao.lerVersao({ ...DONO, chave: 'hml/c9/nao-existe', versaoId: g.versaoId }))).code, 'NAO_ENCONTRADO');
    assert.equal((await falha(m.restauracao.lerVersao({ ...DONO, chave: 'hml/c9/a', versaoId: 'nao-e-desta-chave' }))).code, 'NAO_ENCONTRADO');
    const n = m.f.estado.chamadas.length;
    for (const v of ['', 'null', 'a b', 5]) assert.equal((await falha(m.restauracao.lerVersao({ ...DONO, chave: 'hml/c9/a', versaoId: v }))).code, 'ENTRADA_INVALIDA', String(v));
    assert.equal(m.f.estado.chamadas.length, n);
  });
});

describe('[AWS] porta do KMS (provedor pré-resolvido)', () => {
  test('AWS-17 — Decrypt com a chave FIXADA, o contexto e o algoritmo simétrico; entrega uma CÓPIA do segredo e zera o buffer devolvido pelo SDK; erro vira código fixo sem eco', async () => {
    const m = montar();
    const kms = P.criarPortaKms(m.base('publicador'));
    assert.deepEqual(Object.keys(kms), ['decifrar']);
    const segredo = Buffer.alloc(32, 9);
    const contexto = { 'safework:ambiente': 'HOMOLOGACAO', 'safework:finalidade': 'MAC', 'safework:chave-id': 'mac-hml-v1' };
    const blob = m.f.kms.cifrar({ chaveArn: ficha.chaveMac, contexto, segredo });
    const r = await kms.decifrar({ chaveArn: ficha.chaveMac, contexto, blob });
    assert.equal(r.chaveArn, ficha.chaveMac);
    assert.ok(Buffer.isBuffer(r.segredo) && r.segredo.equals(segredo));
    assert.ok(m.f.estado.plaintexts[0].every((x) => x === 0), 'o buffer do SDK foi zerado');
    assert.ok(r.segredo.equals(segredo), 'a cópia entregue não foi afetada pelo zeramento');
    assert.deepEqual(ultimaChamada(m, 'kms:Decrypt').input, { KeyId: ficha.chaveMac, EncryptionContext: contexto, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' });
    const e = await falha(kms.decifrar({ chaveArn: ficha.chaveMac, contexto: { ...contexto, 'safework:finalidade': 'CIFRA' }, blob }));
    assert.deepEqual({ code: e.code, message: e.message }, { code: 'KMS_FALHOU', message: 'falha ao decifrar com o KMS' });
    for (const ruim of [{ chaveArn: 'alias/x', contexto, blob }, { chaveArn: ficha.chaveMac, contexto: [], blob }, { chaveArn: ficha.chaveMac, contexto, blob: 'texto' }, { chaveArn: ficha.chaveMac, contexto, blob: Buffer.alloc(0) }]) {
      assert.equal((await falha(kms.decifrar(ruim))).code, 'ENTRADA_INVALIDA');
    }
  });

  test('AWS-18 — a porta KMS alimenta o provedor pré-resolvido REAL (MAC e KEK obtidos pelo adaptador, com valor de verificação conferido)', async () => {
    const m = montar();
    const kms = P.criarPortaKms(m.base('publicador'));
    const segMac = Buffer.alloc(32, 3);
    const segKek = Buffer.alloc(32, 4);
    const ctx = (finalidade, chaveId) => Kms.contextoDeCriptografia({ ambiente: 'HOMOLOGACAO', finalidade, chaveId });
    const provedor = Kms.criarProvedoresKmsPreResolvidos({
      ficha: registro(ficha)[0], cliente: kms, prazoMs: 1000,
      chaves: {
        mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', blob: m.f.kms.cifrar({ chaveArn: ficha.chaveMac, contexto: ctx('MAC', 'mac-hml-v1'), segredo: segMac }), vc: X.valorDeVerificacao('mac-hml-v1', segMac) }],
        cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', blob: m.f.kms.cifrar({ chaveArn: ficha.chaveCifra, contexto: ctx('CIFRA', 'kek-hml-v1'), segredo: segKek }), vc: X.valorDeVerificacao('kek-hml-v1', segKek) }],
      },
    });
    await provedor.resolver();
    assert.ok(Buffer.from(provedor.mac.obter('mac-hml-v1').segredo).equals(segMac));
    assert.ok(Buffer.from(provedor.cifra.obter('kek-hml-v1').segredo).equals(segKek));
    assert.deepEqual(m.f.comandosUsados('publicador'), ['kms:Decrypt']);
  });
});

describe('[AWS] ligação com os módulos reais e mínimo por papel', () => {
  async function ciclo() {
    const m = montar();
    const a = ambienteS3();
    const raiz = novaRaiz();
    const base = { destinoId: ficha.id, ambiente: 'HOMOLOGACAO', relogio: () => AGORA, prazoMs: 1000, registro: a.reg };
    const enviador = S3.criarEnviadorS3({ ...base, cliente: m.publicador });
    const verificador = V.criarVerificadorIndependente({ ...base, cliente: m.verificador });
    const dl = a.destinoLocal(raiz);
    const { relogio: _semRelogio, ...paraBaixador } = base;
    const baixador = D.criarBaixadorDuravel({ ...paraBaixador, cliente: m.restauracao, validadorDeDestinos: dl.validador, limites: { totalBytesMaximo: 2 ** 30 } });
    return { m, a, raiz, enviador, verificador, baixador, dl };
  }
  const arquivo = (raiz, nome, conteudo) => { const caminho = path.join(raiz, nome); fs.writeFileSync(caminho, conteudo, { mode: 0o600 }); return caminho; };

  test('AWS-19 — ciclo com o enviador, o verificador e o baixador REAIS sobre os adaptadores: pré-voo aprovado, recibos com versão real, verificação independente conforme, download idêntico por versão', async () => {
    const x = await ciclo();
    const pre = await x.enviador.executarPreVoo();
    assert.equal(pre.ok, true, JSON.stringify(pre.itens.filter((i) => !i.ok)));
    const arquivos = [['dados/a.enc', Buffer.from('conteudo-a'.repeat(50))], ['envelope.json', Buffer.from('{"envelope":true}')]];
    for (const [rel, c] of arquivos) {
      const r = await x.enviador.enviarArquivo({ caminho: arquivo(x.raiz, rel.replace('/', '-'), c), chave: `c10/${rel}`, sha256: sha(c), bytes: c.length });
      assert.equal(r.estado, 'GRAVADO', JSON.stringify(r));
    }
    const cons = Rb.consolidarRecibos({ destinoId: ficha.id, ambiente: 'HOMOLOGACAO', conjuntoId: 'c10', recibos: [...x.enviador.recibos()] });
    assert.equal(cons.ok, true);
    const ver = await x.verificador.verificar(cons.consolidado);
    assert.equal(ver.conforme, true, JSON.stringify(ver));
    const baixado = await x.baixador.baixar({ consolidado: cons.consolidado, destinoLocalId: x.dl.id, raiz: x.dl.raiz, nome: 'baixado-aws' });
    assert.equal(baixado.ok, true, JSON.stringify(baixado.falha));
    assert.ok(fs.readFileSync(path.join(baixado.destino, 'dados', 'a.enc')).equals(arquivos[0][1]));
    assert.ok(fs.readFileSync(path.join(baixado.destino, 'envelope.json')).equals(arquivos[1][1]));
  });

  test('AWS-20 — o envio que não pode ser comprovado vira o estado certo no enviador real: nome repetido = RECUSADO; negado = FALHOU; resposta perdida = INCERTO (a versão existe no bucket, sem recibo)', async () => {
    const x = await ciclo();
    await x.enviador.executarPreVoo();
    const c = Buffer.from('conteudo-estados');
    const enviar = (chave, extra = {}) => x.enviador.enviarArquivo({ caminho: arquivo(x.raiz, `e-${chave.replace(/\W/g, '')}`, c), chave, sha256: sha(c), bytes: c.length, ...extra });
    assert.equal((await enviar('c11/a')).estado, 'GRAVADO');
    x.enviador.recibos();
    const outroEnviador = S3.criarEnviadorS3({ destinoId: ficha.id, ambiente: 'HOMOLOGACAO', relogio: () => AGORA, prazoMs: 1000, registro: x.a.reg, cliente: x.m.publicador });
    await outroEnviador.executarPreVoo();
    const repetido = await outroEnviador.enviarArquivo({ caminho: arquivo(x.raiz, 'rep', c), chave: 'c11/a', sha256: sha(c), bytes: c.length });
    assert.deepEqual({ estado: repetido.estado, motivo: repetido.motivo }, { estado: 'RECUSADO', motivo: 'OBJETO_JA_EXISTE' });
    x.m.f.programar('PutObject', 'NEGAR');
    const negado = await enviar('c11/b');
    assert.deepEqual({ estado: negado.estado, motivo: negado.motivo }, { estado: 'FALHOU', motivo: 'NEGADO' });
    x.m.f.programar('PutObject', 'REDE_DEPOIS');
    const perdido = await enviar('c11/c');
    assert.equal(perdido.estado, 'INCERTO');
    assert.equal(x.m.f.versoes('hml/c11/c').length, 1);
    assert.equal(x.enviador.recibos().length, 1, 'só o envio comprovado tem recibo');
  });

  test('AWS-21 — mínimo por papel: o publicador só usa leitura de configuração, DescribeKey/Decrypt e PutObject; o verificador só lista e lê metadados; a restauração só lê a versão', async () => {
    const x = await ciclo();
    await x.enviador.executarPreVoo();
    const c = Buffer.from('conteudo-minimo');
    await x.enviador.enviarArquivo({ caminho: arquivo(x.raiz, 'min', c), chave: 'c12/a', sha256: sha(c), bytes: c.length });
    await x.enviador.enviarArquivo({ caminho: arquivo(x.raiz, 'min-env', c), chave: 'c12/envelope.json', sha256: sha(c), bytes: c.length });
    const cons = Rb.consolidarRecibos({ destinoId: ficha.id, ambiente: 'HOMOLOGACAO', conjuntoId: 'c12', recibos: [...x.enviador.recibos()] });
    assert.equal(cons.ok, true);
    await x.verificador.verificar(cons.consolidado);
    await x.baixador.baixar({ consolidado: cons.consolidado, destinoLocalId: x.dl.id, raiz: x.dl.raiz, nome: 'baixado-min' });
    assert.deepEqual(x.m.f.comandosUsados('publicador'), ['kms:DescribeKey', 's3:GetBucketEncryption', 's3:GetBucketOwnershipControls', 's3:GetBucketVersioning', 's3:GetObjectLockConfiguration', 's3:HeadBucket', 's3:PutObject', 'sts:GetCallerIdentity']);
    assert.deepEqual(x.m.f.comandosUsados('verificador'), ['s3:HeadObject', 's3:ListObjectVersions', 'sts:GetCallerIdentity']);
    assert.deepEqual(x.m.f.comandosUsados('restauracao'), ['s3:GetObject', 'sts:GetCallerIdentity']);
  });

  test('AWS-22 — papéis trocados são barrados pelo próprio módulo: o verificador com a credencial do publicador (e vice-versa) falha na identidade, antes de qualquer leitura de objeto', async () => {
    const x = await ciclo();
    const trocado = V.criarVerificadorIndependente({ destinoId: ficha.id, ambiente: 'HOMOLOGACAO', relogio: () => AGORA, prazoMs: 1000, registro: x.a.reg, cliente: P.criarPortaDoVerificador(x.m.base('publicador')) });
    const c = Buffer.from('x');
    await x.enviador.executarPreVoo();
    await x.enviador.enviarArquivo({ caminho: arquivo(x.raiz, 'tr', c), chave: 'c13/a', sha256: sha(c), bytes: c.length });
    await x.enviador.enviarArquivo({ caminho: arquivo(x.raiz, 'tr-env', c), chave: 'c13/envelope.json', sha256: sha(c), bytes: c.length });
    const cons = Rb.consolidarRecibos({ destinoId: ficha.id, ambiente: 'HOMOLOGACAO', conjuntoId: 'c13', recibos: [...x.enviador.recibos()] });
    assert.equal(cons.ok, true, 'o conjunto tem de ser válido para o teste ser significativo');
    const r = await trocado.verificar(cons.consolidado);
    assert.equal(r.conforme, false);
    assert.equal(x.m.f.estado.chamadas.some((k) => k.papel === 'publicador' && (k.operacao === 's3:ListObjectVersions' || k.operacao === 's3:HeadObject')), false, 'a credencial do publicador não consegue listar nem ler metadados');
  });
});
