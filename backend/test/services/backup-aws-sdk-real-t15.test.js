'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const dns = require('node:dns');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { Readable } = require('node:stream');
const L = require('../../src/services/backup-aws-sdk-carregador.service');
const P = require('../../src/services/backup-aws-portas.service');

/**
 * D-ORF-6, DEP-2 [T1.5]: as portas S3/KMS/STS sobre o SDK REAL (3.1152.0), com credenciais sintéticas e transporte inteiramente simulado. Cada cliente real recebe um `requestHandler`
 * falso que registra o pedido SERIALIZADO e devolve uma resposta escrita no teste; nada sai do processo. Além disso, durante o teste qualquer tentativa de abrir conexão (socket, TLS, HTTP,
 * HTTP/2, DNS ou fetch) é interceptada, contada e recusada, e o ambiente AWS_* é isolado (sem perfil, sem arquivo de configuração, sem metadados de instância).
 * Prova o pedido montado e o tratamento da resposta pelas portas contra o SDK real; NÃO prova o comportamento da AWS (isso é T2/T3).
 * Sem o SDK instalado este arquivo FALHA de forma explícita (SDK_NAO_INSTALADO): a ausência do pacote nunca conta como verde.
 */

const REGIAO = 'sa-east-1';
const CONTA = '123456789012';
const BUCKET = 'bucket-sintetico-t15';
const CHAVE = 'c1/envelope.json';
const VERSAO_ID = 'v1sintetica';
const ID_SINTETICO = 'AKIDSINTETICOT15';
const SEGREDO_SINTETICO = 'segredo-sintetico-t15-sem-valor';
const CHAVE_ARN = `arn:aws:kms:${REGIAO}:${CONTA}:key/00000000-0000-4000-8000-000000000000`;
const CONTEUDO = Buffer.from('dados');
const SHA256 = crypto.createHash('sha256').update(CONTEUDO).digest('hex');
const SHA256_B64 = Buffer.from(SHA256, 'hex').toString('base64');
const NS_S3 = 'http://s3.amazonaws.com/doc/2006-03-01/';
const credenciais = async () => ({ accessKeyId: ID_SINTETICO, secretAccessKey: SEGREDO_SINTETICO });

/* ---------- isolamento: rede proibida e ambiente AWS limpo ---------- */

const tentativasDeRede = [];
const restauracoes = [];
function proibirRede() {
  const alvos = [[net.Socket.prototype, 'connect'], [net, 'connect'], [net, 'createConnection'], [tls, 'connect'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'], [http2, 'connect'], [dns, 'lookup'], [dns, 'resolve'], [globalThis, 'fetch']];
  for (const [objeto, nome] of alvos) {
    if (typeof objeto[nome] !== 'function') continue;
    const original = objeto[nome];
    restauracoes.push(() => { objeto[nome] = original; });
    objeto[nome] = function redeProibida() { tentativasDeRede.push(nome); throw new Error('REDE_PROIBIDA_NO_T15'); };
  }
}
function isolarAmbiente() {
  const salvas = Object.entries(process.env).filter(([nome]) => nome.startsWith('AWS_'));
  for (const [nome] of salvas) delete process.env[nome];
  process.env.AWS_EC2_METADATA_DISABLED = 'true';
  process.env.AWS_CONFIG_FILE = '/inexistente-t15/config';
  process.env.AWS_SHARED_CREDENTIALS_FILE = '/inexistente-t15/credenciais';
  restauracoes.push(() => {
    for (const nome of Object.keys(process.env)) if (nome.startsWith('AWS_')) delete process.env[nome];
    for (const [nome, valor] of salvas) process.env[nome] = valor;
  });
}

/* ---------- transporte simulado ---------- */

const xml = (corpo) => `<?xml version="1.0" encoding="UTF-8"?>${corpo}`;
function resposta(status, { headers = {}, corpo = '', tipo = null } = {}) {
  return { statusCode: status, headers: { ...(tipo === null ? {} : { 'content-type': tipo }), ...headers }, body: Readable.from(corpo === '' ? [] : [Buffer.from(corpo)]) };
}
const respostaXml = (corpo) => resposta(200, { tipo: 'application/xml', corpo: xml(corpo) });
const respostaJson = (objeto) => resposta(200, { tipo: 'application/x-amz-json-1.1', corpo: JSON.stringify(objeto) });

function resumir(pedido) {
  const cabecalhos = Object.fromEntries(Object.entries(pedido.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  let corpoTexto = null;
  if (typeof pedido.body === 'string') corpoTexto = pedido.body;
  else if (pedido.body instanceof Uint8Array) corpoTexto = Buffer.from(pedido.body).toString('utf8');
  return { metodo: pedido.method, protocolo: pedido.protocol, host: pedido.hostname, caminho: pedido.path, consulta: { ...(pedido.query ?? {}) }, cabecalhos, corpoTexto, corpoEhFluxo: pedido.body !== null && typeof pedido.body === 'object' && typeof pedido.body.pipe === 'function' };
}
const temConsulta = (r, chave) => Object.hasOwn(r.consulta, chave) || r.caminho.includes(`?${chave}`);

function responderPadrao(r) {
  if (r.host.startsWith('sts.')) {
    return respostaXml(`<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::${CONTA}:assumed-role/papel-sintetico/sessao</Arn><UserId>AROASINTETICOT15:sessao</UserId><Account>${CONTA}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>t15</RequestId></ResponseMetadata></GetCallerIdentityResponse>`);
  }
  if (r.host.startsWith('kms.')) {
    if (r.cabecalhos['x-amz-target'] === 'TrentService.DescribeKey') return respostaJson({ KeyMetadata: { Arn: CHAVE_ARN, KeyId: '00000000-0000-4000-8000-000000000000', KeyState: 'Enabled', KeyManager: 'CUSTOMER', KeyUsage: 'ENCRYPT_DECRYPT', KeySpec: 'SYMMETRIC_DEFAULT' } });
    return respostaJson({ KeyId: CHAVE_ARN, Plaintext: Buffer.alloc(32, 7).toString('base64'), EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' });
  }
  if (r.metodo === 'PUT') return resposta(200, { headers: { 'x-amz-version-id': VERSAO_ID, 'x-amz-checksum-sha256': r.cabecalhos['x-amz-checksum-sha256'] ?? '' } });
  if (temConsulta(r, 'versioning')) return respostaXml(`<VersioningConfiguration xmlns="${NS_S3}"><Status>Enabled</Status></VersioningConfiguration>`);
  if (temConsulta(r, 'object-lock')) return respostaXml(`<ObjectLockConfiguration xmlns="${NS_S3}"><ObjectLockEnabled>Enabled</ObjectLockEnabled><Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>30</Days></DefaultRetention></Rule></ObjectLockConfiguration>`);
  if (temConsulta(r, 'encryption')) return respostaXml(`<ServerSideEncryptionConfiguration xmlns="${NS_S3}"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>aws:kms</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`);
  if (temConsulta(r, 'ownershipControls')) return respostaXml(`<OwnershipControls xmlns="${NS_S3}"><Rule><ObjectOwnership>BucketOwnerEnforced</ObjectOwnership></Rule></OwnershipControls>`);
  if (temConsulta(r, 'versions')) return respostaXml(`<ListVersionsResult xmlns="${NS_S3}"><Name>${BUCKET}</Name><Prefix>c1/</Prefix><IsTruncated>false</IsTruncated><Version><Key>${CHAVE}</Key><VersionId>${VERSAO_ID}</VersionId><IsLatest>true</IsLatest></Version></ListVersionsResult>`);
  if (r.metodo === 'HEAD' && temConsulta(r, 'versionId')) return resposta(200, { headers: { 'content-length': String(CONTEUDO.length), 'x-amz-checksum-sha256': SHA256_B64 } });
  if (r.metodo === 'HEAD') return resposta(200, { headers: { 'x-amz-bucket-region': REGIAO } });
  if (r.metodo === 'GET' && temConsulta(r, 'versionId')) return resposta(200, { headers: { 'content-length': String(CONTEUDO.length) }, corpo: CONTEUDO.toString('utf8') });
  throw new Error('PEDIDO_NAO_PREVISTO_NO_T15');
}

/** `modo.falha = true` simula uma falha de transporte retentável (TimeoutError); o contador mostra quantas tentativas o cliente fez. */
function criarTransporte(modo = { falha: false }) {
  const capturados = [];
  const handler = {
    metadata: { handlerProtocol: 'http/1.1' },
    async handle(pedido) {
      const r = resumir(pedido);
      capturados.push(r);
      if (pedido.body !== null && typeof pedido.body === 'object' && typeof pedido.body.destroy === 'function') pedido.body.destroy();
      if (modo.falha) throw Object.assign(new Error('transporte simulado'), { name: 'TimeoutError' });
      return { response: responderPadrao(r) };
    },
    destroy() {},
    httpHandlerConfigs() { return {}; },
    updateHttpClientConfig() {},
  };
  return { handler, capturados };
}

let sdkReal = null;
/** O SDK real, com cada cliente criado pelas portas recebendo o transporte simulado. */
function opcoesDaPorta(handler) {
  const comTransporte = (Base) => class extends Base { constructor(config) { super({ ...config, requestHandler: handler }); } };
  const sdk = Object.freeze({ ...sdkReal, S3Client: comTransporte(sdkReal.S3Client), STSClient: comTransporte(sdkReal.STSClient), KMSClient: comTransporte(sdkReal.KMSClient) });
  return { sdk, regiao: REGIAO, credenciais };
}
const codigoDe = async (promessa) => { try { await promessa; } catch (e) { return e.code; } return null; };
const assinatura = (servico) => new RegExp(`^AWS4-HMAC-SHA256 Credential=${ID_SINTETICO}/\\d{8}/${REGIAO}/${servico}/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$`);
const todosOsPedidos = [];

before(() => { isolarAmbiente(); proibirRede(); });
after(() => { while (restauracoes.length > 0) restauracoes.pop()(); });

describe('[T1.5] SDK real carregado pelo carregador, sem rede', () => {
  test('T15-01 — o carregador entrega os símbolos exigidos do SDK REAL nas versões aprovadas, em Node >= 22', () => {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22, process.versions.node);
    sdkReal = L.carregarSdkAws({ requerer: require });
    assert.ok(Object.isFrozen(sdkReal));
    assert.deepEqual(Object.keys(sdkReal).sort(), [...L.SIMBOLOS_EXIGIDOS].sort());
    for (const s of L.SIMBOLOS_EXIGIDOS) assert.equal(typeof sdkReal[s], 'function', s);
    for (const { pacote, versao } of L.VERSOES_APROVADAS) assert.equal(require(`${pacote}/package.json`).version, versao, pacote);
  });
});

describe('[T1.5] pedidos serializados e respostas tratadas pelas portas (transporte simulado)', () => {
  test('T15-02 — identidade (STS): POST regional assinado com as credenciais sintéticas; resposta vira conta e ARN', async () => {
    const { handler, capturados } = criarTransporte();
    const porta = P.criarPortaDoPublicador(opcoesDaPorta(handler));
    const id = await porta.identidade();
    assert.deepEqual({ ...id }, { contaId: CONTA, arn: `arn:aws:sts::${CONTA}:assumed-role/papel-sintetico/sessao` });
    assert.equal(capturados.length, 1);
    const [r] = capturados;
    assert.deepEqual([r.metodo, r.protocolo, r.host, r.caminho], ['POST', 'https:', `sts.${REGIAO}.amazonaws.com`, '/']);
    assert.match(r.corpoTexto, /(?:^|&)Action=GetCallerIdentity(?:&|$)/);
    assert.match(r.cabecalhos.authorization, assinatura('sts'));
    todosOsPedidos.push(...capturados);
  });

  test('T15-03 — configuração do bucket (publicador): HEAD e quatro leituras de sub-recurso, todos com o dono esperado; resposta mapeada', async () => {
    const { handler, capturados } = criarTransporte();
    const porta = P.criarPortaDoPublicador(opcoesDaPorta(handler));
    const cfg = await porta.lerConfiguracaoDoBucket({ bucket: BUCKET, donoEsperado: CONTA });
    assert.deepEqual({ regiao: cfg.regiao, versionamento: cfg.versionamento, objectLock: { ...cfg.objectLock }, criptografiaPadrao: cfg.criptografiaPadrao, propriedade: cfg.propriedade, donoConfirmado: cfg.donoConfirmado }, {
      regiao: REGIAO, versionamento: 'Enabled', objectLock: { habilitado: true, modo: 'COMPLIANCE', dias: 30 }, criptografiaPadrao: 'aws:kms', propriedade: 'BucketOwnerEnforced', donoConfirmado: true,
    });
    assert.equal(capturados.length, 5);
    const [cabeca, versionamento, trava, cripto, dono] = capturados;
    assert.deepEqual([cabeca.metodo, cabeca.caminho], ['HEAD', '/']);
    assert.deepEqual([versionamento.metodo, temConsulta(versionamento, 'versioning')], ['GET', true]);
    assert.deepEqual([trava.metodo, temConsulta(trava, 'object-lock')], ['GET', true]);
    assert.deepEqual([cripto.metodo, temConsulta(cripto, 'encryption')], ['GET', true]);
    assert.deepEqual([dono.metodo, temConsulta(dono, 'ownershipControls')], ['GET', true]);
    for (const r of capturados) {
      assert.deepEqual([r.protocolo, r.host, r.cabecalhos['x-amz-expected-bucket-owner']], ['https:', `${BUCKET}.s3.${REGIAO}.amazonaws.com`, CONTA]);
      assert.match(r.cabecalhos.authorization, assinatura('s3'));
    }
    todosOsPedidos.push(...capturados);
  });

  test('T15-04 — descrição da chave (KMS pelo publicador): POST com o alvo DescribeKey e a chave fixada', async () => {
    const { handler, capturados } = criarTransporte();
    const porta = P.criarPortaDoPublicador(opcoesDaPorta(handler));
    assert.deepEqual({ ...(await porta.descreverChave({ chaveArn: CHAVE_ARN })) }, { estado: 'Enabled', especificacao: 'SYMMETRIC_DEFAULT' });
    assert.equal(capturados.length, 1);
    const [r] = capturados;
    assert.deepEqual([r.metodo, r.host, r.cabecalhos['x-amz-target'], r.cabecalhos['content-type']], ['POST', `kms.${REGIAO}.amazonaws.com`, 'TrentService.DescribeKey', 'application/x-amz-json-1.1']);
    assert.deepEqual(JSON.parse(r.corpoTexto), { KeyId: CHAVE_ARN });
    assert.match(r.cabecalhos.authorization, assinatura('kms'));
    todosOsPedidos.push(...capturados);
  });

  test('T15-05 — gravação (publicador): UM PutObject condicional (If-None-Match: *), com SHA-256, dono esperado e tamanho; versão devolvida; falha retentável não gera nova tentativa', async () => {
    const abrirFluxo = () => Readable.from([CONTEUDO]);
    const pedido = { bucket: BUCKET, donoEsperado: CONTA, chave: CHAVE, bytes: CONTEUDO.length, sha256: SHA256, abrirFluxo, naoSobrescrever: true };
    const { handler, capturados } = criarTransporte();
    const gravado = await P.criarPortaDoPublicador(opcoesDaPorta(handler)).gravarObjeto(pedido);
    assert.deepEqual({ ...gravado }, { resultado: 'GRAVADO', versaoId: VERSAO_ID, sha256: SHA256, bytes: CONTEUDO.length, tentativas: 1 });
    assert.equal(capturados.length, 1);
    const [r] = capturados;
    assert.deepEqual([r.metodo, r.host, r.caminho], ['PUT', `${BUCKET}.s3.${REGIAO}.amazonaws.com`, `/${CHAVE}`]);
    assert.deepEqual([r.cabecalhos['if-none-match'], r.cabecalhos['x-amz-checksum-sha256'], r.cabecalhos['x-amz-expected-bucket-owner'], r.cabecalhos['content-length']], ['*', SHA256_B64, CONTA, String(CONTEUDO.length)]);
    assert.match(r.cabecalhos.authorization, assinatura('s3'));
    todosOsPedidos.push(...capturados);

    const falha = criarTransporte({ falha: true });
    assert.equal(await codigoDe(P.criarPortaDoPublicador(opcoesDaPorta(falha.handler)).gravarObjeto(pedido)), 'AMBIGUO');
    assert.equal(falha.capturados.length, 1, 'o cliente de gravação não faz retentativa');
  });

  test('T15-06 — verificador: listagem de versões por prefixo e metadados da VERSÃO pedida (HEAD com checksum); leitura com até 3 tentativas', async () => {
    const { handler, capturados } = criarTransporte();
    const porta = P.criarPortaDoVerificador(opcoesDaPorta(handler));
    const versoes = await porta.listarVersoes({ bucket: BUCKET, donoEsperado: CONTA, prefixo: 'c1/' });
    assert.deepEqual(versoes.map((v) => ({ ...v })), [{ chave: CHAVE, versaoId: VERSAO_ID, ehAtual: true, marcadorDeExclusao: false }]);
    const meta = await porta.lerMetadadosDaVersao({ bucket: BUCKET, donoEsperado: CONTA, chave: CHAVE, versaoId: VERSAO_ID });
    assert.deepEqual({ ...meta }, { bytes: CONTEUDO.length, sha256: SHA256, retencao: null });
    assert.equal(capturados.length, 2);
    const [lista, cabeca] = capturados;
    assert.deepEqual([lista.metodo, temConsulta(lista, 'versions'), lista.consulta.prefix, lista.consulta['max-keys'], lista.cabecalhos['x-amz-expected-bucket-owner']], ['GET', true, 'c1/', '1000', CONTA]);
    assert.deepEqual([cabeca.metodo, cabeca.caminho, cabeca.consulta.versionId, cabeca.cabecalhos['x-amz-checksum-mode'], cabeca.cabecalhos['x-amz-expected-bucket-owner']], ['HEAD', `/${CHAVE}`, VERSAO_ID, 'ENABLED', CONTA]);
    todosOsPedidos.push(...capturados);

    const falha = criarTransporte({ falha: true });
    const pedido = { bucket: BUCKET, donoEsperado: CONTA, chave: CHAVE, versaoId: VERSAO_ID };
    assert.equal(await codigoDe(P.criarPortaDoVerificador(opcoesDaPorta(falha.handler)).lerMetadadosDaVersao(pedido)), 'AWS_ERRO');
    assert.equal(falha.capturados.length, 3, 'o cliente de leitura faz até 3 tentativas');
  });

  test('T15-07 — restauração: GET de UMA versão explícita, com checksum e dono esperado; o corpo chega como fluxo', async () => {
    const { handler, capturados } = criarTransporte();
    const porta = P.criarPortaDaRestauracao(opcoesDaPorta(handler));
    const lida = await porta.lerVersao({ bucket: BUCKET, donoEsperado: CONTA, chave: CHAVE, versaoId: VERSAO_ID });
    assert.equal(lida.bytes, CONTEUDO.length);
    const pedacos = [];
    for await (const pedaco of lida.fluxo) pedacos.push(Buffer.from(pedaco));
    assert.equal(Buffer.concat(pedacos).toString('utf8'), CONTEUDO.toString('utf8'));
    assert.equal(capturados.length, 1);
    const [r] = capturados;
    assert.deepEqual([r.metodo, r.caminho, r.consulta.versionId, r.cabecalhos['x-amz-checksum-mode'], r.cabecalhos['x-amz-expected-bucket-owner']], ['GET', `/${CHAVE}`, VERSAO_ID, 'ENABLED', CONTA]);
    todosOsPedidos.push(...capturados);
  });

  test('T15-08 — KMS pré-resolvido: Decrypt com a chave fixada, o contexto e SYMMETRIC_DEFAULT; o segredo volta como cópia', async () => {
    const { handler, capturados } = criarTransporte();
    const porta = P.criarPortaKms(opcoesDaPorta(handler));
    const blob = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = await porta.decifrar({ chaveArn: CHAVE_ARN, contexto: { finalidade: 'backup-t15' }, blob });
    assert.equal(r.chaveArn, CHAVE_ARN);
    assert.deepEqual([...r.segredo], [...Buffer.alloc(32, 7)]);
    assert.equal(capturados.length, 1);
    const [p] = capturados;
    assert.deepEqual([p.metodo, p.host, p.cabecalhos['x-amz-target']], ['POST', `kms.${REGIAO}.amazonaws.com`, 'TrentService.Decrypt']);
    assert.deepEqual(JSON.parse(p.corpoTexto), { KeyId: CHAVE_ARN, CiphertextBlob: Buffer.from(blob).toString('base64'), EncryptionContext: { finalidade: 'backup-t15' }, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' });
    todosOsPedidos.push(...capturados);
  });
});

describe('[T1.5] nada saiu do processo', () => {
  test('T15-09 — nenhuma tentativa de rede, todos os pedidos HTTPS regionais, e o segredo sintético nunca aparece em cabeçalho nem corpo', () => {
    assert.deepEqual(tentativasDeRede, []);
    assert.ok(todosOsPedidos.length >= 10, `pedidos registrados: ${todosOsPedidos.length}`);
    for (const r of todosOsPedidos) {
      assert.equal(r.protocolo, 'https:');
      assert.match(r.host, new RegExp(`^(?:${BUCKET}\\.s3|sts|kms)\\.${REGIAO}\\.amazonaws\\.com$`));
      assert.equal(JSON.stringify(r).includes(SEGREDO_SINTETICO), false);
    }
  });
});
