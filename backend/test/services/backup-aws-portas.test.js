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

describe('[AWS] porta KMS Encrypt (cerimônia de custódia, D3/H9-d F2b)', () => {
  const CTX = Object.freeze({ 'safework:ambiente': 'HOMOLOGACAO', 'safework:finalidade': 'MAC', 'safework:chave-id': 'mac-hml-v1' });
  const pedidoDe = (extra = {}) => ({ chaveArn: ficha.chaveMac, contexto: { ...CTX }, segredo: Buffer.alloc(32, 9), ...extra });
  const porta = (m, extra = {}, papel = 'cerimonia') => P.criarPortaKmsEncrypt({ ...m.base(papel), ...extra });
  const encrypts = (m) => m.f.estado.chamadas.filter((c) => c.operacao === 'kms:Encrypt');
  const zerado = (b) => b.length > 0 && b.every((x) => x === 0);
  const copiasZeradas = (m) => m.f.estado.enviados.every((x) => zerado(x.referencia));
  const temporizadores = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const pausa = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const FALHA = { code: 'KMS_FALHOU', message: 'falha ao cifrar com o KMS', name: 'Error' };
  /** O erro da porta só tem código e mensagem fixos: sem causa, sem campo extra e sem nada do pedido ou do fornecedor. */
  function falhaFixa(e, proibidos = []) {
    assert.deepEqual({ code: e.code, message: e.message, name: e.name }, FALHA);
    assert.deepEqual(Reflect.ownKeys(e).sort(), ['code', 'message', 'stack']);
    assert.equal(e.cause, undefined);
    for (const p of [...proibidos, ficha.chaveMac, 'safework:', 'AccessDenied', 'Throttling', 'ECONNRESET', 'eco ']) assert.equal(`${e.message}\n${e.stack}`.includes(p), false, p);
  }

  test('AWS-23 — fábrica estrita: só `cifrar`, cliente próprio com UMA tentativa; a porta de decifragem não muda', () => {
    const m = montar();
    const ok = m.base('cerimonia');
    const c = (o) => { try { P.criarPortaKmsEncrypt(o); } catch (e) { return e.code; } return null; };
    const clientesAntes = m.f.estado.clientes.length;
    assert.equal(c(undefined), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, endpoint: 'http://localhost:4566' }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, maxAttempts: 3 }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, regiao: 'US_EAST_1' }), 'CONFIGURACAO_INVALIDA');
    assert.equal(c({ ...ok, credenciais: { accessKeyId: 'AKIA' } }), 'CONFIGURACAO_INVALIDA');
    for (const prazoMs of [0, -1, 1.5, 60001, '1000', null]) assert.equal(c({ ...ok, prazoMs }), 'CONFIGURACAO_INVALIDA', String(prazoMs));
    for (const observador of ['x', {}, null]) assert.equal(c({ ...ok, observador }), 'CONFIGURACAO_INVALIDA');
    const { EncryptCommand: _semEncrypt, ...semEncrypt } = m.f.sdk;
    assert.equal(c({ ...ok, sdk: semEncrypt }), 'SDK_INCOMPATIVEL');
    const { KMSClient: _semCliente, ...semCliente } = m.f.sdk;
    assert.equal(c({ ...ok, sdk: semCliente }), 'SDK_INCOMPATIVEL');
    assert.equal(m.f.estado.clientes.length, clientesAntes, 'nenhuma recusa cria cliente');

    const p = P.criarPortaKmsEncrypt({ ...ok, prazoMs: 1, observador: () => {} });
    assert.deepEqual(Object.keys(p), ['cifrar']);
    assert.ok(Object.isFrozen(p));
    const config = m.f.estado.clientes.at(-1).config;
    assert.deepEqual(Object.keys(config).sort(), ['credentials', 'maxAttempts', 'region']);
    assert.deepEqual([config.maxAttempts, config.region, config.credentials], [1, ficha.regiao, ok.credenciais]);
    assert.deepEqual(Object.keys(P.criarPortaKms(m.base('publicador'))), ['decifrar']);
    assert.equal(m.f.estado.clientes.at(-1).config.maxAttempts, 3, 'a porta de decifragem continua com as tentativas de antes');
    assert.deepEqual([P.PRAZO_PADRAO_DO_ENCRYPT_MS, P.PRAZO_MAXIMO_DO_ENCRYPT_MS], [8000, 60000]);
    assert.ok(Object.isFrozen(P.CATEGORIAS_DE_FALHA_DO_ENCRYPT));
    assert.deepEqual([...P.CATEGORIAS_DE_FALHA_DO_ENCRYPT], ['ACESSO_NEGADO', 'CHAVE_INDISPONIVEL', 'LIMITE_DE_TAXA', 'PRAZO', 'RESPOSTA_INVALIDA', 'FALHA_NAO_CLASSIFICADA']);
  });

  test('AWS-24 — Encrypt com a chave pedida, o contexto copiado e o algoritmo simétrico; devolve SÓ `{ chaveArn, blob }`, com o blob em cópia própria', async () => {
    const m = montar();
    const ped = pedidoDe();
    const r = await porta(m).cifrar(ped);
    assert.deepEqual(Reflect.ownKeys(r), ['chaveArn', 'blob']);
    assert.ok(Object.isFrozen(r));
    assert.equal(r.chaveArn, ficha.chaveMac);
    assert.ok(Buffer.isBuffer(r.blob) && r.blob.length >= 1 && r.blob.byteOffset === 0 && r.blob.buffer.byteLength === r.blob.length);
    assert.equal(encrypts(m).length, 1);
    assert.equal(encrypts(m)[0].papel, 'cerimonia');
    assert.deepEqual(encrypts(m)[0].input, { KeyId: ficha.chaveMac, EncryptionContext: CTX, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' });
    assert.notEqual(encrypts(m)[0].input.EncryptionContext, ped.contexto, 'o contexto vai em cópia');
    const host = P.criarPortaKms(m.base('publicador'));
    assert.ok((await host.decifrar({ chaveArn: ficha.chaveMac, contexto: CTX, blob: r.blob })).segredo.equals(Buffer.alloc(32, 9)));
    assert.equal((await falha(host.decifrar({ chaveArn: ficha.chaveMac, contexto: { ...CTX, 'safework:finalidade': 'CIFRA' }, blob: r.blob }))).code, 'KMS_FALHOU');
    for (const n of [32, 128]) {
      const s = Buffer.alloc(n, 4);
      const g = await porta(m).cifrar(Object.freeze(pedidoDe({ segredo: s })));
      assert.ok((await host.decifrar({ chaveArn: ficha.chaveMac, contexto: CTX, blob: g.blob })).segredo.equals(s), String(n));
    }
  });

  test('AWS-25 — entrada fora do contrato é recusada ANTES do SDK: nenhum comando, nenhum segredo entregue', async () => {
    const m = montar();
    const p = porta(m);
    const longo = 'x'.repeat(129);
    const mentiroso = Buffer.alloc(16, 1);
    Object.defineProperty(mentiroso, 'length', { get: () => 32 });
    const transferido = new Uint8Array(32).fill(1);
    transferido.buffer.transfer();
    const ruins = [
      undefined, null, [], 'texto',
      { ...pedidoDe(), extra: 1 },
      { chaveArn: ficha.chaveMac, contexto: { ...CTX } },
      pedidoDe({ chaveArn: 'alias/safework' }),
      pedidoDe({ chaveArn: ficha.chaveMac.split('/')[1] }),
      pedidoDe({ chaveArn: ficha.chaveMac.replace(/key\/.*$/, 'alias/safework') }),
      pedidoDe({ chaveArn: `${ficha.chaveMac}x` }),
      pedidoDe({ chaveArn: ficha.chaveMac.replace(ficha.regiao, ficha.regiao === 'eu-west-1' ? 'us-east-1' : 'eu-west-1') }),
      pedidoDe({ chaveArn: 7 }),
      pedidoDe({ contexto: [] }), pedidoDe({ contexto: {} }), pedidoDe({ contexto: null }),
      pedidoDe({ contexto: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])) }),
      pedidoDe({ contexto: { ...CTX, numero: 7 } }), pedidoDe({ contexto: { ...CTX, longo } }), pedidoDe({ contexto: { [longo]: 'v' } }),
      pedidoDe({ segredo: 'texto' }), pedidoDe({ segredo: Buffer.alloc(31, 1) }), pedidoDe({ segredo: Buffer.alloc(129, 1) }), pedidoDe({ segredo: Buffer.alloc(0) }),
      pedidoDe({ segredo: new Uint16Array(32).fill(1) }), pedidoDe({ segredo: Object.create(Uint8Array.prototype) }), pedidoDe({ segredo: new Proxy(Buffer.alloc(32, 1), {}) }),
      pedidoDe({ segredo: mentiroso }), pedidoDe({ segredo: transferido }),
    ];
    for (const [i, ruim] of ruins.entries()) assert.equal((await falha(p.cifrar(ruim))).code, 'ENTRADA_INVALIDA', `caso ${i}`);
    assert.equal(encrypts(m).length, 0);
    assert.equal(m.f.estado.enviados.length, 0);
  });

  test('AWS-26 — consumo imediato e propriedade: o segredo é copiado de forma síncrona, o buffer recebido não é alterado nem entregue ao SDK, e a cópia termina zerada', async () => {
    const m = montar();
    const p = porta(m);
    const host = P.criarPortaKms(m.base('publicador'));
    const segredo = Buffer.alloc(32, 9);
    const promessa = p.cifrar(pedidoDe({ segredo }));
    segredo.fill(0xee);
    const r = await promessa;
    assert.equal(m.f.estado.enviados.length, 1);
    assert.notEqual(m.f.estado.enviados[0].referencia, segredo);
    assert.equal(m.f.estado.enviados[0].hex, Buffer.alloc(32, 9).toString('hex'));
    assert.ok((await host.decifrar({ chaveArn: ficha.chaveMac, contexto: CTX, blob: r.blob })).segredo.equals(Buffer.alloc(32, 9)), 'o que foi cifrado é o segredo do instante da chamada');
    assert.ok(segredo.equals(Buffer.alloc(32, 0xee)), 'a porta não escreve no buffer recebido');
    const intacto = Buffer.alloc(64, 5);
    await p.cifrar(pedidoDe({ segredo: intacto }));
    assert.ok(intacto.equals(Buffer.alloc(64, 5)));
    const copia = m.f.estado.enviados[1].referencia;
    assert.ok(copia.byteOffset === 0 && copia.buffer.byteLength === 64, 'a cópia tem memória própria, fora do pool');
    assert.ok(copiasZeradas(m));
    let leituras = 0;
    const contado = { chaveArn: ficha.chaveMac, contexto: { ...CTX }, get segredo() { leituras += 1; return Buffer.alloc(32, 6); } };
    await p.cifrar(contado);
    assert.equal(leituras, 1);
  });

  test('AWS-27 — falha do serviço vira erro fixo, sem causa nem eco; o observador recebe SÓ a categoria; uma única tentativa; cópia zerada', async () => {
    const casos = [
      ['NEGAR', 'ACESSO_NEGADO'], ['LIMITE', 'LIMITE_DE_TAXA'], ['CHAVE_DESATIVADA', 'CHAVE_INDISPONIVEL'], ['REDE', 'FALHA_NAO_CLASSIFICADA'], ['ERRO_COM_SEGREDO', 'FALHA_NAO_CLASSIFICADA'],
    ];
    for (const [modo, categoria] of casos) {
      const m = montar();
      const vistos = [];
      m.f.programar('Encrypt', modo);
      const e = await falha(porta(m, { observador: (...args) => { vistos.push(args); } }).cifrar(pedidoDe()));
      falhaFixa(e, [Buffer.alloc(32, 9).toString('hex')]);
      assert.deepEqual(vistos, [[categoria]], modo);
      assert.equal(encrypts(m).length, 1, modo);
      assert.ok(copiasZeradas(m), modo);
    }
    const m = montar();
    const vistos = [];
    const obs = { observador: (c) => { vistos.push(c); } };
    falhaFixa(await falha(porta(m, obs, 'publicador').cifrar(pedidoDe())));
    const desconhecida = ficha.chaveMac.replace(/[0-9a-f]{12}$/, '0123456789ab');
    falhaFixa(await falha(porta(m, obs).cifrar(pedidoDe({ chaveArn: desconhecida }))), [desconhecida]);
    const semCredencial = P.criarPortaKmsEncrypt({ sdk: m.f.sdk, regiao: ficha.regiao, credenciais: async () => { throw Object.assign(new Error('token-secreto'), { name: 'CredentialsProviderError' }); }, ...obs });
    falhaFixa(await falha(semCredencial.cifrar(pedidoDe())), ['token-secreto']);
    assert.deepEqual(vistos, ['ACESSO_NEGADO', 'CHAVE_INDISPONIVEL', 'ACESSO_NEGADO']);
    assert.ok(vistos.every((c) => P.CATEGORIAS_DE_FALHA_DO_ENCRYPT.includes(c)));
    m.f.programar('Encrypt', 'NEGAR');
    falhaFixa(await falha(porta(m, { observador: () => { throw new Error('observador quebrado'); } }).cifrar(pedidoDe())), ['observador quebrado']);
    m.f.programar('Encrypt', 'NEGAR');
    falhaFixa(await falha(porta(m).cifrar(pedidoDe())));
    assert.ok(copiasZeradas(m));
    const calado = [];
    await porta(m, { observador: (c) => { calado.push(c); } }).cifrar(pedidoDe());
    assert.deepEqual(calado, [], 'no sucesso o observador não é chamado');
  });

  test('AWS-28 — resposta fora do contrato (sem KeyId, sem blob, blob que não é binário, vazio ou acima de 4096 bytes, resposta nula) é falha fixa', async () => {
    for (const modo of ['SEM_KEYID', 'KEYID_NUMERO', 'SEM_BLOB', 'BLOB_TEXTO', 'BLOB_VAZIO', 'BLOB_GRANDE', 'RESPOSTA_NULA']) {
      const m = montar();
      const vistos = [];
      m.f.programar('Encrypt', modo);
      falhaFixa(await falha(porta(m, { observador: (c) => { vistos.push(c); } }).cifrar(pedidoDe())));
      assert.deepEqual(vistos, ['RESPOSTA_INVALIDA'], modo);
      assert.equal(encrypts(m).length, 1, modo);
      assert.ok(copiasZeradas(m), modo);
    }
  });

  test('AWS-29 — prazo próprio: aborta localmente, falha no prazo mesmo se o SDK ignorar o aborto, zera a cópia e ignora a resposta tardia; não repete o pedido', async () => {
    const naoTratadas = [];
    const ouvinte = (e) => naoTratadas.push(e);
    process.on('unhandledRejection', ouvinte);
    try {
      for (const modo of ['PENDENTE', 'SURDA', 'SURDA_COM_ERRO']) {
        const m = montar();
        const vistos = [];
        m.f.programar('Encrypt', modo);
        const antes = temporizadores();
        const inicio = process.hrtime.bigint();
        const e = await falha(porta(m, { prazoMs: 30, observador: (c) => { vistos.push(c); } }).cifrar(pedidoDe()));
        const duracaoMs = Number(process.hrtime.bigint() - inicio) / 1e6;
        falhaFixa(e);
        assert.ok(duracaoMs >= 25 && duracaoMs < 900, `${modo}: ${duracaoMs}`);
        assert.deepEqual(vistos, ['PRAZO'], modo);
        assert.equal(m.f.estado.sinais.length, 1, modo);
        assert.equal(m.f.estado.sinais[0].aborted, true, modo);
        assert.ok(copiasZeradas(m), modo);
        assert.equal(temporizadores(), antes, modo);
        for (const responder of m.f.estado.tardias) responder();
        await pausa(15);
        assert.deepEqual(vistos, ['PRAZO'], modo);
        assert.equal(encrypts(m).length, 1, modo);
        assert.ok(copiasZeradas(m), modo);
      }
      assert.deepEqual(naoTratadas, []);
    } finally {
      process.off('unhandledRejection', ouvinte);
    }
    const m = montar();
    const antes = temporizadores();
    await porta(m).cifrar(pedidoDe());
    assert.equal(m.f.estado.sinais[0] instanceof AbortSignal, true);
    assert.equal(m.f.estado.sinais[0].aborted, false);
    assert.equal(temporizadores(), antes, 'no sucesso o temporizador do prazo é desarmado');
  });

  test('AWS-30 — mínimo por papel: os papéis do host não cifram e o papel da cerimônia não decifra', async () => {
    const m = montar();
    for (const papel of ['publicador', 'restauracao', 'verificador']) falhaFixa(await falha(porta(m, {}, papel).cifrar(pedidoDe())));
    const r = await porta(m).cifrar(pedidoDe());
    const e = await falha(P.criarPortaKms(m.base('cerimonia')).decifrar({ chaveArn: ficha.chaveMac, contexto: CTX, blob: r.blob }));
    assert.deepEqual({ code: e.code, message: e.message }, { code: 'KMS_FALHOU', message: 'falha ao decifrar com o KMS' });
    assert.deepEqual(m.f.comandosUsados('cerimonia'), ['kms:Decrypt', 'kms:Encrypt']);
    assert.ok(copiasZeradas(m));
  });

  test('AWS-31 — erro hostil do SDK (`name` com getter que lança ou que muda a cada leitura, Proxy, rejeição que não é objeto): continua KMS_FALHOU, com categoria fixa e sem eco', async () => {
    const segredoHex = Buffer.alloc(32, 9).toString('hex');
    const comGetter = (get) => Object.defineProperty(new Error('mensagem-do-fornecedor'), 'name', { get, configurable: true });
    let leituras = 0;
    const nomes = ['AccessDeniedException', 'ThrottlingException', 'NotFoundException'];
    const casos = [
      ['getter que lança', () => comGetter(() => { throw new Error(`getter-hostil ${segredoHex}`); }), 'FALHA_NAO_CLASSIFICADA'],
      ['getter que muda a cada leitura', () => { leituras = 0; return comGetter(() => nomes[Math.min(leituras++, 2)]); }, 'ACESSO_NEGADO'],
      ['Proxy que lança em toda leitura', () => new Proxy({}, { get() { throw new Error(`proxy-hostil ${segredoHex}`); } }), 'FALHA_NAO_CLASSIFICADA'],
      ['nome que não é texto', () => Object.assign(new Error('x'), { name: { toString() { throw new Error('toString-hostil'); } } }), 'FALHA_NAO_CLASSIFICADA'],
      ['null', () => null, 'FALHA_NAO_CLASSIFICADA'],
      ['undefined', () => undefined, 'FALHA_NAO_CLASSIFICADA'],
      ['texto', () => 'AccessDeniedException', 'FALHA_NAO_CLASSIFICADA'],
    ];
    for (const [nome, criar, categoria] of casos) {
      for (const sincrono of [false, true]) {
        const enviados = [];
        const vistos = [];
        const sdk = {
          KMSClient: class { send(comando) { enviados.push(comando.input.Plaintext); const motivo = criar(); if (sincrono) throw motivo; return Promise.reject(motivo); } },
          EncryptCommand: class { constructor(input) { this.input = input; } },
        };
        const p = P.criarPortaKmsEncrypt({ sdk, regiao: ficha.regiao, credenciais: async () => ({}), observador: (...args) => { vistos.push(args); } });
        const onde = `${nome}, ${sincrono ? 'lançado' : 'rejeitado'}`;
        falhaFixa(await falha(p.cifrar(pedidoDe())), [segredoHex, 'hostil', 'mensagem-do-fornecedor']);
        assert.deepEqual(vistos, [[categoria]], onde);
        assert.equal(enviados.length, 1, onde);
        assert.ok(zerado(enviados[0]), onde);
      }
    }
    assert.equal(leituras, 1, 'o nome do erro é lido uma única vez');
  });
});
