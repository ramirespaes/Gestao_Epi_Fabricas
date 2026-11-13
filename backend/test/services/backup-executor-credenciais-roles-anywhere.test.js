'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Duplex } = require('node:stream');
const fs = require('node:fs');
const net = require('node:net');
const nodeHttp = require('node:http');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarProvedorDeCredenciais, criarConjuntoDeCredenciais, PAPEIS } = require('../../src/services/backup-executor-credenciais.service');

/**
 * D-ORF-6, D5 [RA]: fornecedor de credenciais temporárias do IAM Roles Anywhere, entregue ao provedor de credenciais existente. Todos os valores são inventados e o endpoint local do
 * helper é simulado em memória: nenhum socket, porta, AWS, certificado ou credencial real. O contrato simulado é o do serve 1.8.6 (rotas, cabeçalhos, corpo e códigos), lido no código da tag;
 * o cliente node:http real só aparece em conexão em memória (sem servidor, socket nem porta).
 */

const CAMINHO_DO_MODULO = 'src/services/backup-executor-credenciais-roles-anywhere.service';
const ARQUIVO_DO_MODULO = path.join(__dirname, '..', '..', `${CAMINHO_DO_MODULO}.js`);
const carregar = () => exigirModulo(CAMINHO_DO_MODULO);

const AGORA = 1_800_000_000_000;
const HORA_MS = 3_600_000;
const LIMITE_DA_EXPIRACAO_MS = 43_500_000;
const relogio = () => AGORA;
const PAPEL_IAM = 'swb-hml-backup-publicador';
const PORTA = 9911;
const ROTA_DA_SESSAO = '/latest/api/token';
const ROTA_DO_PAPEL = '/latest/meta-data/iam/security-credentials';
const CABECALHO_DA_VALIDADE = 'x-aws-ec2-metadata-token-ttl-seconds';
const CABECALHO_DA_SESSAO = 'x-aws-ec2-metadata-token';
const ID_TEMPORARIO = `${['ASI', 'A'].join('')}EXEMPLOIDCHAVE01`;
const SEGREDO = 'segredo-falso-0123456789';
const SESSAO = 'sessao-falsa-0123456789';
const CODIGO_DA_SESSAO = 'SESSAOLOCAL'.repeat(8);
const SEM_CREDENCIAL = 'failed to refresh credentials';
const PRAZO_PADRAO_MS = 15000;
const LIMITE_DE_BYTES = 8192;
const NOMES_DE_PAPEL_IAM = ['a', 'a'.repeat(64), 'Backup01', 'a+=,.@_-b', '+a', '=a', ',a', '@a', '_a', '-a', 'Aa', '0a', 'aB'];
const ALFABETO_REAL = { segredo: 'falso-aB3dE5gH7jK9/mN1pQ3+sT5vW7yZ9=cD_eF', sessao: 'falso-Xk9/+=_.-AbC0123456789xYzQw', codigo: 'falso-aB3+/=_-0123456789xY' };
const CODIGOS_DO_MODULO = ['CONFIGURACAO_INVALIDA', 'PEDIDO_INCOERENTE', 'ENDPOINT_INDISPONIVEL', 'RESPOSTA_INVALIDA', 'HELPER_SEM_CREDENCIAL', 'PAPEL_IAM_DIVERGENTE', 'CREDENCIAL_NAO_TEMPORARIA', 'CREDENCIAL_EXPIRADA', 'EXPIRACAO_FORA_DA_FAIXA'];
const CODIGOS_QUE_O_TRANSPORTE_NAO_FIXA = CODIGOS_DO_MODULO.filter((codigo) => !['CONFIGURACAO_INVALIDA', 'RESPOSTA_INVALIDA', 'ENDPOINT_INDISPONIVEL'].includes(codigo));

const ordenar = (lista) => [...lista].sort((a, b) => a.localeCompare(b));
const omitir = (objeto, chave) => Object.fromEntries(Object.entries(objeto).filter(([k]) => k !== chave));
const instante = (ms) => new Date(ms).toISOString();
const ok = (corpo) => ({ status: 200, corpo });
const corpoDasCredenciais = (extra = {}) => ({
  AccessKeyId: ID_TEMPORARIO, SecretAccessKey: SEGREDO, Token: SESSAO, Code: 'Success', Type: 'AWS-HMAC', Expiration: instante(AGORA + HORA_MS), LastUpdated: instante(AGORA), ...extra,
});
const credenciais = (extra) => ok(JSON.stringify(corpoDasCredenciais(extra)));
const codigoDe = async (promessa) => { try { await promessa; } catch (e) { return e.code; } return null; };
const codigoSincrono = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const textoDoErro = (e) => [e.message, e.code, JSON.stringify(e), String(e.stack).split('\n')[0]].join(' ');
const erroDe = (promessa) => promessa.then(() => null, (e) => e);
/** Erro de código fixo: sem causa, só `code`, `message` e `stack`, e sem eco de nenhum valor sentinela ou secreto. */
function confirmarErroFixo(erro, esperado) {
  assert.ok(erro, `${esperado}: deveria recusar`);
  assert.equal(erro.code, esperado);
  assert.equal(erro.cause, undefined);
  const proprias = Object.getOwnPropertyNames(erro);
  assert.ok(proprias.includes('code') && proprias.every((nome) => ['code', 'message', 'stack'].includes(nome)), `${esperado}: propriedades próprias ${proprias}`);
  const texto = textoDoErro(erro);
  for (const proibido of ['SENTINELA', SEGREDO, SESSAO, ID_TEMPORARIO, CODIGO_DA_SESSAO]) assert.ok(!texto.includes(proibido), `${esperado} ecoou ${proibido.slice(0, 12)}`);
}
const proximoCiclo = () => new Promise((resolver) => { setImmediate(resolver); });
const temporizadoresAtivos = () => process.getActiveResourcesInfo().filter((recurso) => recurso === 'Timeout').length;
const comSymbol = (objeto) => Object.assign(objeto, { [Symbol('extra')]: 1 });
const comOculta = (objeto) => Object.defineProperty(objeto, 'oculta', { value: 1, enumerable: false });
const papelHerdado = () => Object.create({ papel: 'PUBLICADOR' });

/** Transporte falso por etapa: cada etapa devolve uma resposta, um Error (lançado) ou uma função. */
function helperFalso(sobrescritas = {}) {
  const chamadas = [];
  const padrao = { sessao: ok(CODIGO_DA_SESSAO), papel: ok(PAPEL_IAM), credenciais: credenciais() };
  const etapaDe = (pedido) => {
    if (pedido.metodo === 'PUT') return 'sessao';
    return pedido.caminho === ROTA_DO_PAPEL ? 'papel' : 'credenciais';
  };
  const transporte = async (pedido) => {
    chamadas.push(structuredClone(pedido));
    const resposta = sobrescritas[etapaDe(pedido)] ?? padrao[etapaDe(pedido)];
    if (resposta instanceof Error) throw resposta;
    return typeof resposta === 'function' ? resposta(pedido) : resposta;
  };
  return { transporte, chamadas };
}
const criar = (opcoes = {}) => carregar().criarFornecedorRolesAnywhere({ papel: 'PUBLICADOR', papelIam: PAPEL_IAM, relogio, ...opcoes });
const pedir = (fornecedor) => fornecedor.obter({ papel: 'PUBLICADOR' });
const resultadoDaFalha = async (sobrescritas, opcoes) => {
  const helper = helperFalso(sobrescritas);
  const codigo = await codigoDe(pedir(criar({ transporte: helper.transporte, ...opcoes })));
  return { codigo, chamadas: helper.chamadas };
};

/** HTTP falso: registra as opções de `request` e entrega a resposta pelo roteiro, sem socket. */
function httpFalso(responder) {
  const registro = { pedidos: [], brutos: [], destruicoes: 0 };
  const request = (opcoes) => {
    registro.pedidos.push(structuredClone(opcoes));
    registro.brutos.push(opcoes);
    const requisicao = new EventEmitter();
    requisicao.destroy = () => { registro.destruicoes += 1; };
    requisicao.end = () => setImmediate(() => responder(requisicao, opcoes));
    return requisicao;
  };
  return { http: { request }, registro };
}
function emitirResposta(requisicao, { status = 200, cabecalhos = {}, partes = [], fim = true } = {}) {
  const resposta = new EventEmitter();
  resposta.statusCode = status;
  resposta.headers = cabecalhos;
  requisicao.emit('response', resposta);
  for (const parte of partes) resposta.emit('data', parte);
  if (fim) resposta.emit('end');
  return resposta;
}
const CABECALHOS_PERMITIDOS = ['content-length', CABECALHO_DA_SESSAO, CABECALHO_DA_VALIDADE];
/** Regras do serve 1.8.6 no que o cliente exercita: Host efetivo com a porta, só os cabeçalhos do contrato, sessão obrigatória e nome do papel exato; o JSON leva a quebra de linha final do encoder do Go. */
function decidirComoHelper({ metodo, caminho, host, cabecalhos }, porta = PORTA, papelIam = PAPEL_IAM) {
  const resposta = (status, corpo) => ({ status, corpo });
  if (host !== `127.0.0.1:${porta}` || Object.keys(cabecalhos).some((k) => !CABECALHOS_PERMITIDOS.includes(k))) return resposta(403, 'invalid Host header');
  if (metodo === 'PUT' && caminho === ROTA_DA_SESSAO) return resposta(200, CODIGO_DA_SESSAO);
  if (cabecalhos[CABECALHO_DA_SESSAO] !== CODIGO_DA_SESSAO) return resposta(401, 'invalid token provided');
  if (caminho === ROTA_DO_PAPEL) return resposta(200, papelIam);
  if (caminho === `${ROTA_DO_PAPEL}/${papelIam}`) return resposta(200, `${JSON.stringify(corpoDasCredenciais())}\n`);
  return resposta(404, '404 page not found');
}
const responderComoHelperDe = (papelIam) => (requisicao, opcoes) => {
  const { status, corpo } = decidirComoHelper({ metodo: opcoes.method, caminho: opcoes.path, host: `${opcoes.host}:${opcoes.port}`, cabecalhos: opcoes.headers }, PORTA, papelIam);
  return emitirResposta(requisicao, { status, partes: [Buffer.from(corpo)] });
};
const responderComoHelper = responderComoHelperDe(PAPEL_IAM);

const MOTIVOS = { 200: 'OK', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found' };
/** Conexão em memória: lê o que o ClientRequest real escreve e devolve a resposta HTTP/1.1 do helper simulado, inteira ou em blocos (chunked). */
class ConexaoEmMemoria extends Duplex {
  constructor(responder, registro, fragmentado) {
    super();
    Object.assign(this, { responder, registro, fragmentado, recebido: '', respondeu: false });
  }

  _read() { /* os bytes saem por push() em entregar() */ }

  _write(parte, codificacao, pronto) {
    this.recebido += (Buffer.isBuffer(parte) ? parte : Buffer.from(parte, codificacao)).toString('latin1');
    if (!this.respondeu && this.recebido.includes('\r\n\r\n')) {
      this.respondeu = true;
      this.registro.push(this.recebido);
      setImmediate(() => this.entregar(this.responder(this.recebido)));
    }
    pronto();
  }

  entregar({ status, corpo }) {
    const bytes = Buffer.from(corpo);
    const topo = (enquadramento) => Buffer.from(`HTTP/1.1 ${status} ${MOTIVOS[status] ?? 'X'}\r\n${enquadramento}\r\nconnection: close\r\n\r\n`, 'latin1');
    if (this.fragmentado && bytes.length > 1) {
      const metade = Math.ceil(bytes.length / 2);
      const bloco = (parte) => Buffer.concat([Buffer.from(`${parte.length.toString(16)}\r\n`), parte, Buffer.from('\r\n')]);
      this.push(Buffer.concat([topo('transfer-encoding: chunked'), bloco(bytes.subarray(0, metade)), bloco(bytes.subarray(metade)), Buffer.from('0\r\n\r\n')]));
    } else {
      this.push(Buffer.concat([topo(`content-length: ${bytes.length}`), bytes]));
    }
    this.push(null);
  }

  setTimeout() { return this; }

  setNoDelay() { return this; }

  setKeepAlive() { return this; }

  ref() { return this; }

  unref() { return this; }
}
const httpEmMemoria = (responder, registro, fragmentado = false) => ({
  request: (opcoes) => {
    const agente = new nodeHttp.Agent();
    agente.createConnection = () => new ConexaoEmMemoria(responder, registro, fragmentado);
    return nodeHttp.request({ ...opcoes, agent: agente });
  },
});
const lerCabeca = (texto) => {
  const [linha, ...campos] = texto.split('\r\n\r\n')[0].split('\r\n');
  const cab = Object.fromEntries(campos.map((campo) => [campo.slice(0, campo.indexOf(':')).toLowerCase(), campo.slice(campo.indexOf(':') + 1).trim()]));
  return { linha, cab };
};
const responderPelaCabeca = (porta) => (texto) => {
  const { linha, cab } = lerCabeca(texto);
  const [metodo, caminho] = linha.split(' ');
  const cabecalhos = Object.fromEntries(Object.entries(cab).filter(([nome]) => nome !== 'host' && nome !== 'connection'));
  return decidirComoHelper({ metodo, caminho, host: cab.host, cabecalhos }, porta);
};

const tentativasDeRede = [];
const restauracoes = [];
const ALVOS_DE_SOCKET = () => [[net.Socket.prototype, 'connect'], [net, 'connect'], [net, 'createConnection']];
const ALVOS_DE_HTTP = () => [[nodeHttp, 'request'], [nodeHttp, 'get']];
const armarSentinela = (alvos) => {
  tentativasDeRede.length = 0;
  for (const [objeto, nome] of alvos) {
    const original = objeto[nome];
    restauracoes.push(() => { objeto[nome] = original; });
    objeto[nome] = function redeProibida() { tentativasDeRede.push(nome); throw new Error('REDE_PROIBIDA_NO_D5'); };
  }
};
const desarmarSentinela = () => { while (restauracoes.length > 0) restauracoes.pop()(); };
after(desarmarSentinela);

const PEDIDO_DE_TRANSPORTE = { metodo: 'GET', caminho: ROTA_DO_PAPEL, cabecalhos: { [CABECALHO_DA_SESSAO]: CODIGO_DA_SESSAO }, prazoMs: 1000, limiteBytes: LIMITE_DE_BYTES };
const transportar = (http, pedido) => carregar().criarTransporteLoopback({ porta: PORTA, http })(pedido);
const transportarPadrao = (http) => transportar(http, PEDIDO_DE_TRANSPORTE);

describe('[RA] fornecedor de credenciais temporárias do IAM Roles Anywhere', () => {
  test('RA-01 — fluxo feliz: os cinco campos do contrato, resultado congelado, segredo e sessão não enumeráveis', async () => {
    const resultado = await pedir(criar({ transporte: helperFalso().transporte }));
    assert.deepEqual(ordenar(Reflect.ownKeys(resultado)), ['accessKeyId', 'expiration', 'papel', 'secretAccessKey', 'sessionToken']);
    assert.deepEqual(Object.keys(resultado), ['papel', 'accessKeyId', 'expiration']);
    assert.equal(resultado.papel, 'PUBLICADOR');
    assert.equal(resultado.accessKeyId, ID_TEMPORARIO);
    assert.equal(resultado.secretAccessKey, SEGREDO);
    assert.equal(resultado.sessionToken, SESSAO);
    assert.ok(resultado.expiration instanceof Date);
    assert.equal(resultado.expiration.getTime(), AGORA + HORA_MS);
    assert.ok(Object.isFrozen(resultado));
    assert.ok(!JSON.stringify(resultado).includes(SEGREDO) && !JSON.stringify({ ...resultado }).includes(SESSAO));
  });

  test('RA-02 — três pedidos, nesta ordem, com métodos, rotas e cabeçalhos exatos (nada além do contrato)', async () => {
    const { transporte, chamadas } = helperFalso();
    await pedir(criar({ transporte }));
    const comum = { prazoMs: PRAZO_PADRAO_MS, limiteBytes: LIMITE_DE_BYTES };
    assert.deepEqual(chamadas, [
      { metodo: 'PUT', caminho: ROTA_DA_SESSAO, cabecalhos: { [CABECALHO_DA_VALIDADE]: '60', 'content-length': '0' }, ...comum },
      { metodo: 'GET', caminho: ROTA_DO_PAPEL, cabecalhos: { [CABECALHO_DA_SESSAO]: CODIGO_DA_SESSAO }, ...comum },
      { metodo: 'GET', caminho: `${ROTA_DO_PAPEL}/${PAPEL_IAM}`, cabecalhos: { [CABECALHO_DA_SESSAO]: CODIGO_DA_SESSAO }, ...comum },
    ]);
  });

  test('RA-03 — alimenta o provedor e o conjunto de credenciais existentes sem alterá-los; credencial a menos de 60 s de expirar é recusada pelo provedor', async () => {
    const idDe = (sufixo) => `${ID_TEMPORARIO.slice(0, -2)}${sufixo}`;
    const fornecedorDe = (papel, papelIam, id) => criar({ papel, papelIam, transporte: helperFalso({ papel: ok(papelIam), credenciais: credenciais({ AccessKeyId: id }) }).transporte });
    const conjuntoDe = (idPublicador, idVerificador) => criarConjuntoDeCredenciais({
      acao: 'BACKUP', modo: 'ENSAIO', relogio,
      fornecedores: { PUBLICADOR: fornecedorDe('PUBLICADOR', PAPEL_IAM, idPublicador), VERIFICADOR: fornecedorDe('VERIFICADOR', 'swb-hml-backup-verificador', idVerificador) },
    });
    const conjunto = conjuntoDe(idDe('P1'), idDe('V1'));
    assert.deepEqual((await conjunto.verificarSeparacao()).papeis, ['PUBLICADOR', 'VERIFICADOR']);
    const c = await conjunto.credenciais('PUBLICADOR')();
    assert.equal(c.accessKeyId, idDe('P1'));
    assert.equal(c.secretAccessKey, SEGREDO);
    assert.equal(c.sessionToken, SESSAO);
    assert.ok(Object.isFrozen(c));
    assert.equal(await codigoDe(conjuntoDe(idDe('X1'), idDe('X1')).verificarSeparacao()), 'CREDENCIAIS_REPETIDAS_ENTRE_PAPEIS');
    const quaseExpirada = criar({ transporte: helperFalso({ credenciais: credenciais({ Expiration: instante(AGORA + 30_000) }) }).transporte });
    assert.equal(await codigoDe(criarProvedorDeCredenciais({ papel: 'PUBLICADOR', fornecedor: quaseExpirada, relogio })()), 'CREDENCIAL_EXPIRADA');
  });

  test('RA-04 — pedido incoerente com o papel configurado é recusado antes de qualquer chamada', async () => {
    const { transporte, chamadas } = helperFalso();
    const fornecedor = criar({ transporte });
    const ruins = [
      { papel: 'VERIFICADOR' }, { papel: 'PUBLICADOR', extra: 1 }, {}, undefined, null, [], 'PUBLICADOR',
      comSymbol({ papel: 'PUBLICADOR' }), comOculta({ papel: 'PUBLICADOR' }), comSymbol(papelHerdado()), comOculta(papelHerdado()),
    ];
    for (const ruim of ruins) {
      assert.equal(await codigoDe(fornecedor.obter(ruim)), 'PEDIDO_INCOERENTE', JSON.stringify(ruim));
    }
    assert.equal(chamadas.length, 0);
  });

  test('RA-05 — nome do papel IAM devolvido pelo helper diferente do configurado: recusa sem pedir as credenciais; uma quebra de linha final é aceita', async () => {
    for (const nome of ['outro-papel', 'SWB-HML-BACKUP-PUBLICADOR', '', ` ${PAPEL_IAM}`, `caminho/${PAPEL_IAM}`, `${PAPEL_IAM}x`, `${PAPEL_IAM}\n\n`, `${PAPEL_IAM}\r`]) {
      const { codigo, chamadas } = await resultadoDaFalha({ papel: ok(nome) });
      assert.equal(codigo, 'PAPEL_IAM_DIVERGENTE', JSON.stringify(nome));
      assert.equal(chamadas.length, 2);
    }
    for (const nome of [`${PAPEL_IAM}\n`, `${PAPEL_IAM}\r\n`]) {
      assert.equal((await pedir(criar({ transporte: helperFalso({ papel: ok(nome) }).transporte }))).accessKeyId, ID_TEMPORARIO);
    }
  });

  test('RA-06 — status diferente de 200 em qualquer etapa é RESPOSTA_INVALIDA e para ali; só o 500 com o texto do helper, na etapa das credenciais, é HELPER_SEM_CREDENCIAL', async () => {
    for (const [indice, etapa] of ['sessao', 'papel', 'credenciais'].entries()) {
      for (const status of [301, 302, 400, 401, 403, 404, 405, 500, 503]) {
        const { codigo, chamadas } = await resultadoDaFalha({ [etapa]: { status, corpo: 'texto qualquer' } });
        assert.equal(codigo, 'RESPOSTA_INVALIDA', `${etapa} ${status}`);
        assert.equal(chamadas.length, indice + 1, `${etapa} ${status}`);
      }
    }
    assert.equal((await resultadoDaFalha({ credenciais: { status: 500, corpo: SEM_CREDENCIAL } })).codigo, 'HELPER_SEM_CREDENCIAL');
    assert.equal((await resultadoDaFalha({ credenciais: { status: 500, corpo: `${SEM_CREDENCIAL}\n` } })).codigo, 'HELPER_SEM_CREDENCIAL');
    assert.equal((await resultadoDaFalha({ credenciais: { status: 200, corpo: SEM_CREDENCIAL } })).codigo, 'RESPOSTA_INVALIDA');
    for (const corpo of [`${SEM_CREDENCIAL}!`, `${SEM_CREDENCIAL}\r`, `${SEM_CREDENCIAL}\n\n`]) {
      assert.equal((await resultadoDaFalha({ credenciais: { status: 500, corpo } })).codigo, 'RESPOSTA_INVALIDA', JSON.stringify(corpo));
    }
    for (const status of ['500', [500], Object(500)]) assert.equal((await resultadoDaFalha({ credenciais: { status, corpo: SEM_CREDENCIAL } })).codigo, 'RESPOSTA_INVALIDA', Object.prototype.toString.call(status));
    for (const etapa of ['sessao', 'papel']) assert.equal((await resultadoDaFalha({ [etapa]: { status: 500, corpo: SEM_CREDENCIAL } })).codigo, 'RESPOSTA_INVALIDA', etapa);
  });

  test('RA-07 — código da sessão fora do formato é recusado e nenhuma outra chamada é feita; uma quebra de linha final é aceita', async () => {
    for (const ruim of ['', ' ', 'curto', 'x'.repeat(513), 'tem espaco no meio 0123456789', 'com\nquebra-no-meio-0123456789', 'ç'.repeat(20), `${'a'.repeat(16)}!`, `${CODIGO_DA_SESSAO}\n\n`, `${CODIGO_DA_SESSAO}\r`]) {
      const { codigo, chamadas } = await resultadoDaFalha({ sessao: ok(ruim) });
      assert.equal(codigo, 'RESPOSTA_INVALIDA', JSON.stringify(ruim));
      assert.equal(chamadas.length, 1);
    }
    const comQuebra = helperFalso({ sessao: ok(`${CODIGO_DA_SESSAO}\n`) });
    await pedir(criar({ transporte: comQuebra.transporte }));
    assert.equal(comQuebra.chamadas[1].cabecalhos[CABECALHO_DA_SESSAO], CODIGO_DA_SESSAO);
  });

  test('RA-08 — corpo das credenciais fora do contrato é RESPOSTA_INVALIDA: JSON ruim, forma, chaves, tipos, Code, Type, formatos e LastUpdated', async () => {
    const base = corpoDasCredenciais();
    const ruins = [
      ok(''), ok('{'), ok('null'), ok('[]'), ok('"texto"'), ok('{"AccessKeyId":'), ok(`{"__proto__":{},${JSON.stringify(base).slice(1)}`),
      ...Object.keys(base).map((chave) => ok(JSON.stringify(omitir(base, chave)))),
      credenciais({ Extra: 'x' }), credenciais({ Code: 'Failure' }), credenciais({ Code: 'success' }), credenciais({ Type: 'OUTRO' }), credenciais({ Type: '' }),
      credenciais({ Token: '' }), credenciais({ Token: 'curto' }), credenciais({ Token: 'x'.repeat(4097) }), credenciais({ Token: 'com espaco no meio 0123456789' }), credenciais({ Token: 123 }),
      credenciais({ SecretAccessKey: 'curto' }), credenciais({ SecretAccessKey: 'com espaco no meio 0123456789' }), credenciais({ SecretAccessKey: null }),
      credenciais({ AccessKeyId: ID_TEMPORARIO.toLowerCase() }), credenciais({ AccessKeyId: 'ASIA' }), credenciais({ AccessKeyId: 123 }),
      credenciais({ LastUpdated: 123 }), credenciais({ LastUpdated: '' }), credenciais({ LastUpdated: 'x'.repeat(65) }), credenciais({ Expiration: 1893456000000 }),
      ok(`${JSON.stringify(base)}${' '.repeat(LIMITE_DE_BYTES)}`),
    ];
    for (const resposta of ruins) {
      const { codigo, chamadas } = await resultadoDaFalha({ credenciais: resposta });
      assert.equal(codigo, 'RESPOSTA_INVALIDA', resposta.corpo.slice(0, 80));
      assert.equal(chamadas.length, 3);
    }
  });

  test('RA-09 — identificador que não é de credencial temporária (prefixo diferente de ASIA) é CREDENCIAL_NAO_TEMPORARIA', async () => {
    for (const prefixo of ['AKI', 'AGP', 'AID', 'ARO', 'ABI', 'ASC']) {
      assert.equal((await resultadoDaFalha({ credenciais: credenciais({ AccessKeyId: `${prefixo}AEXEMPLOIDCHAVE01` }) })).codigo, 'CREDENCIAL_NAO_TEMPORARIA', prefixo);
    }
    assert.equal((await resultadoDaFalha({ credenciais: credenciais({ AccessKeyId: `SWBTESTEPUB12345678` }) })).codigo, 'CREDENCIAL_NAO_TEMPORARIA');
  });

  test('RA-10 — expiração: RFC 3339 estrita (calendário, fuso e fração), vencida, tempo zero e fora da faixa de 12 h', async () => {
    const aceita = (valor, esperado, hora = relogio) => pedir(criar({ relogio: hora, transporte: helperFalso({ credenciais: credenciais({ Expiration: valor }) }).transporte })).then((r) => r.expiration.getTime() - esperado);
    for (const [valor, esperado] of [
      ['2027-01-15T09:00:00Z', AGORA + HORA_MS], ['2027-01-15T09:00:00.5Z', AGORA + HORA_MS + 500], ['2027-01-15T09:00:00.123456789Z', AGORA + HORA_MS + 123],
      ['2027-01-15T06:00:00-03:00', AGORA + HORA_MS], ['2027-01-15T14:30:00+05:30', AGORA + HORA_MS],
    ]) assert.equal(await aceita(valor, esperado), 0, valor);
    for (const [ano, mes] of [[2028, 1], [2000, 1]]) {
      const hora = (h) => () => Date.UTC(ano, mes, 29, h);
      assert.equal(await aceita(`${ano}-02-29T09:00:00Z`, Date.UTC(ano, mes, 29, 9), hora(8)), 0, `${ano}-02-29`);
    }
    for (const valor of [
      '2027-01-15', '2027-01-15T09:00:00', '2027-01-15 09:00:00Z', '2027-13-45T00:00:00Z', '2027-00-15T09:00:00Z', '2027-01-00T09:00:00Z', '2027-02-29T09:00:00Z', '2100-02-29T09:00:00Z',
      '2027-04-31T09:00:00Z', '2027-01-15T24:00:00Z', '2027-01-15T09:60:00Z', '2027-01-15T09:00:60Z', '2027-01-15T09:00:00+24:00', '2027-01-15T09:00:00+05:60', '2027-01-15T09:00:00.Z',
      '2027-01-15T09:00:00z', ' 2027-01-15T09:00:00Z', '2027-01-15T09:00:00Z ', `2027-01-15T09:00:00.${'1'.repeat(10)}Z`,
      '2027-01-15T14:30:00+0530', '2027-01-15T14:30:00+05', '2027-01-15T09:00Z', '2027-01-15T09:00:00,5Z', '2027-01-15t09:00:00Z', '12027-01-15T09:00:00Z',
      '2027-01-15T09:00:00Z (x)', '2027-01-15T09:00:00Zjunk', 'x2027-01-15T09:00:00Z', '(x) 2027-01-15T09:00:00Z', '2027-01-15T09:00:00Z\n',
      '2027-01-15T09:00:00Z\u0000', '2027-01-15T09:00:00Z\u0000junk', '+002027-01-15T09:00:00Z', '-002027-01-15T09:00:00Z',
    ]) assert.equal((await resultadoDaFalha({ credenciais: credenciais({ Expiration: valor }) })).codigo, 'RESPOSTA_INVALIDA', valor);
    for (const [valor, codigo] of [
      ['0001-01-01T00:00:00Z', 'CREDENCIAL_EXPIRADA'], [instante(AGORA - 1000), 'CREDENCIAL_EXPIRADA'], [instante(AGORA), 'CREDENCIAL_EXPIRADA'],
      [instante(AGORA + LIMITE_DA_EXPIRACAO_MS + 1), 'EXPIRACAO_FORA_DA_FAIXA'], ['9999-12-31T23:59:59Z', 'EXPIRACAO_FORA_DA_FAIXA'],
    ]) assert.equal((await resultadoDaFalha({ credenciais: credenciais({ Expiration: valor }) })).codigo, codigo, valor);
    assert.equal(await aceita(instante(AGORA + 1), AGORA + 1), 0);
    assert.equal(await aceita(instante(AGORA + LIMITE_DA_EXPIRACAO_MS), AGORA + LIMITE_DA_EXPIRACAO_MS), 0);
    assert.equal(await aceita('2027-01-15T23:30:00Z', Date.UTC(2027, 0, 15, 23, 30), () => Date.UTC(2027, 0, 15, 22)), 0, 'hora 23');
  });

  test('RA-11 — nos nove códigos, nenhum erro ecoa valor da resposta, do transporte, do relógio, do pedido ou da credencial (código fixo, sem causa, só code, message e stack) e cada código tem mensagem própria', async () => {
    const falha = (sobrescritas, opcoes) => pedir(criar({ transporte: helperFalso(sobrescritas).transporte, ...opcoes }));
    const semHelper = (roteiro) => transportarPadrao(httpFalso(roteiro).http);
    const casos = [
      ['RESPOSTA_INVALIDA', () => falha({ sessao: ok('SENTINELA-SESSAO-NAO-PODE-APARECER!') })],
      ['PAPEL_IAM_DIVERGENTE', () => falha({ papel: ok('SENTINELA-PAPEL-NAO-PODE-APARECER') })],
      ['RESPOSTA_INVALIDA', () => falha({ credenciais: ok('{SENTINELA-CORPO-NAO-PODE-APARECER') })],
      ['CREDENCIAL_NAO_TEMPORARIA', () => falha({ credenciais: credenciais({ AccessKeyId: 'AKIASENTINELAXXXXXXXX', SecretAccessKey: 'SENTINELA-SEGREDO-NAO-PODE-APARECER' }) })],
      ['RESPOSTA_INVALIDA', () => falha({ credenciais: credenciais({ Token: 'SENTINELA TOKEN COM ESPACO' }) })],
      ['ENDPOINT_INDISPONIVEL', () => falha({ sessao: new Error('SENTINELA-ERRO-NAO-PODE-APARECER') })],
      ['RESPOSTA_INVALIDA', () => falha({ credenciais: { status: 500, corpo: 'SENTINELA-CORPO-500' } })],
      ['HELPER_SEM_CREDENCIAL', () => falha({ credenciais: { status: 500, corpo: SEM_CREDENCIAL } })],
      ['CREDENCIAL_EXPIRADA', () => falha({ credenciais: credenciais({ Expiration: instante(AGORA - 1000) }) })],
      ['EXPIRACAO_FORA_DA_FAIXA', () => falha({ credenciais: credenciais({ Expiration: instante(AGORA + LIMITE_DA_EXPIRACAO_MS + 1) }) })],
      ['CONFIGURACAO_INVALIDA', () => falha({}, { relogio: () => { throw new Error('SENTINELA-DO-RELOGIO'); } })],
      ['CONFIGURACAO_INVALIDA', () => falha({}, { relogio: () => 1.5 })],
      ['CONFIGURACAO_INVALIDA', async () => criar({ transporte: helperFalso().transporte, papelIam: 'SENTINELA com espaco' })],
      ['PEDIDO_INCOERENTE', () => criar({ transporte: helperFalso().transporte }).obter({ papel: 'SENTINELA' })],
      ['ENDPOINT_INDISPONIVEL', () => semHelper((req) => req.emit('error', new Error('SENTINELA-ERRO-DO-HTTP')))],
      ['RESPOSTA_INVALIDA', () => semHelper((req) => emitirResposta(req, { cabecalhos: { 'content-length': '99999' } }))],
      ['CONFIGURACAO_INVALIDA', () => transportar(httpFalso(() => undefined).http, { ...PEDIDO_DE_TRANSPORTE, metodo: 'SENTINELA' })],
    ];
    const mensagens = new Map();
    for (const [esperado, provocar] of casos) {
      const erro = await erroDe(provocar());
      confirmarErroFixo(erro, esperado);
      mensagens.set(erro.code, erro.message);
    }
    assert.deepEqual(ordenar(mensagens.keys()), ordenar(CODIGOS_DO_MODULO));
    for (const [codigo, mensagem] of mensagens) assert.ok(typeof mensagem === 'string' && mensagem.length >= 8 && mensagem !== codigo, `mensagem de ${codigo}`);
    assert.equal(new Set(mensagens.values()).size, CODIGOS_DO_MODULO.length);
    assert.match(mensagens.get('ENDPOINT_INDISPONIVEL'), /indispon/);
  });

  test('RA-12 — chamadas concorrentes dividem UMA aquisição e cada uma recebe o seu resultado (Date próprio); concluída, não há cache (a próxima chamada refaz o fluxo)', async () => {
    const { transporte, chamadas } = helperFalso();
    const fornecedor = criar({ transporte });
    const [a, b] = await Promise.all([pedir(fornecedor), pedir(fornecedor)]);
    assert.equal(chamadas.length, 3);
    assert.notEqual(a, b);
    assert.deepEqual([a.accessKeyId, a.secretAccessKey, a.sessionToken, a.expiration.getTime()], [b.accessKeyId, b.secretAccessKey, b.sessionToken, b.expiration.getTime()]);
    a.expiration.setTime(0);
    assert.equal(b.expiration.getTime(), AGORA + HORA_MS);
    await pedir(fornecedor);
    assert.equal(chamadas.length, 6);
  });

  test('RA-13 — falha na aquisição chega a todos os que esperam e não trava o fornecedor: a próxima chamada tenta de novo', async () => {
    let quebrado = true;
    const { transporte } = helperFalso({ sessao: () => { if (quebrado) throw new Error('indisponível'); return ok(CODIGO_DA_SESSAO); } });
    const fornecedor = criar({ transporte });
    const codigos = await Promise.all([codigoDe(pedir(fornecedor)), codigoDe(pedir(fornecedor))]);
    assert.deepEqual(codigos, ['ENDPOINT_INDISPONIVEL', 'ENDPOINT_INDISPONIVEL']);
    quebrado = false;
    assert.equal((await pedir(fornecedor)).accessKeyId, ID_TEMPORARIO);
  });

  test('RA-14 — falha do transporte vira ENDPOINT_INDISPONIVEL; resposta fora da forma ou grande demais vira RESPOSTA_INVALIDA; erro já classificado passa só com o código', async () => {
    const comCodigo = (codigo) => Object.assign(new Error('x'), { code: codigo });
    for (const [sobrescrita, esperado] of [
      [new Error('qualquer'), 'ENDPOINT_INDISPONIVEL'], [comCodigo('ECONNREFUSED'), 'ENDPOINT_INDISPONIVEL'], [() => { throw 'texto solto'; }, 'ENDPOINT_INDISPONIVEL'],
      [() => { throw null; }, 'ENDPOINT_INDISPONIVEL'], [() => Promise.reject(undefined), 'ENDPOINT_INDISPONIVEL'], [comCodigo('RESPOSTA_INVALIDA'), 'RESPOSTA_INVALIDA'],
      [comCodigo('CONFIGURACAO_INVALIDA'), 'CONFIGURACAO_INVALIDA'], [() => undefined, 'RESPOSTA_INVALIDA'], [() => null, 'RESPOSTA_INVALIDA'], [() => ({ status: '200', corpo: CODIGO_DA_SESSAO }), 'RESPOSTA_INVALIDA'], [() => ({ status: [200], corpo: CODIGO_DA_SESSAO }), 'RESPOSTA_INVALIDA'], [() => ({ status: Object(200), corpo: CODIGO_DA_SESSAO }), 'RESPOSTA_INVALIDA'],
      [() => ({ status: 200, corpo: 1 }), 'RESPOSTA_INVALIDA'], [() => ({ status: 200 }), 'RESPOSTA_INVALIDA'], [ok('x'.repeat(LIMITE_DE_BYTES + 1)), 'RESPOSTA_INVALIDA'],
      [() => Object.assign([], ok(CODIGO_DA_SESSAO)), 'RESPOSTA_INVALIDA'],
      ...CODIGOS_QUE_O_TRANSPORTE_NAO_FIXA.map((codigo) => [comCodigo(codigo), 'ENDPOINT_INDISPONIVEL']),
    ]) assert.equal((await resultadoDaFalha({ sessao: sobrescrita })).codigo, esperado, String(sobrescrita));
    const erro = await erroDe(pedir(criar({ transporte: helperFalso({ sessao: comCodigo('RESPOSTA_INVALIDA') }).transporte })));
    assert.notEqual(erro.message, 'x');
    assert.equal(await codigoDe(pedir(criar({ transporte: () => { throw new Error('síncrono'); } }))), 'ENDPOINT_INDISPONIVEL');
    const semPromessa = (pedido) => {
      if (pedido.metodo === 'PUT') return ok(CODIGO_DA_SESSAO);
      return pedido.caminho === ROTA_DO_PAPEL ? ok(PAPEL_IAM) : credenciais();
    };
    assert.equal((await pedir(criar({ transporte: semPromessa }))).accessKeyId, ID_TEMPORARIO);
  });

  test('RA-15 — o prazo configurado vale para cada chamada; relógio fora do formato ou que lança é recusado ao pedir', async () => {
    const { transporte, chamadas } = helperFalso();
    await pedir(criar({ transporte, prazoMs: 2500 }));
    assert.deepEqual(chamadas.map((c) => c.prazoMs), [2500, 2500, 2500]);
    for (const [prazoMs, validade] of [[1, '60'], [18000, '60'], [19000, '62'], [19100, '63'], [60000, '185']]) {
      const comPrazo = helperFalso();
      await pedir(criar({ transporte: comPrazo.transporte, prazoMs }));
      assert.equal(comPrazo.chamadas[0].cabecalhos[CABECALHO_DA_VALIDADE], validade, `validade da sessão com prazo de ${prazoMs} ms`);
    }
    for (const hora of [() => 'x', () => 1.5, () => undefined, () => { throw new Error('relógio quebrado'); }]) {
      assert.equal(await codigoDe(pedir(criar({ transporte: helperFalso().transporte, relogio: hora }))), 'CONFIGURACAO_INVALIDA');
    }
  });

  test('RA-16 — construção fora da forma é CONFIGURACAO_INVALIDA; só os papéis do provedor existente são aceitos; o fornecedor é congelado', () => {
    const modulo = carregar();
    const transporte = helperFalso().transporte;
    const base = { papel: 'PUBLICADOR', papelIam: PAPEL_IAM, transporte };
    const sem = (chave) => omitir(base, chave);
    const ruins = [
      undefined, null, [], 'x', {}, sem('papel'), sem('papelIam'), sem('transporte'), { ...base, papel: 'publicador' }, { ...base, papel: 'PUBLICADOR1' }, { ...base, papel: '' }, { ...base, papel: 7 },
      { ...base, papel: 'PUBLICADO' }, { ...base, papel: 'ADMIN' }, { ...base, papel: `${PAPEIS[0]}_` },
      { ...base, papelIam: '' }, { ...base, papelIam: 'a'.repeat(65) }, { ...base, papelIam: 'com/barra' }, { ...base, papelIam: '.oculto' }, { ...base, papelIam: '..' }, { ...base, papelIam: 'com espaco' },
      { ...base, papelIam: 7 }, { ...base, porta: PORTA }, { ...sem('transporte'), porta: 80 }, { ...sem('transporte'), porta: 1023 }, { ...sem('transporte'), porta: 65536 },
      { ...sem('transporte'), porta: 9911.5 }, { ...sem('transporte'), porta: '9911' }, { ...base, transporte: 'x' }, { ...base, http: nodeHttp }, { ...base, relogio: 'x' }, { ...base, prazoMs: 0 },
      { ...base, prazoMs: -1 }, { ...base, prazoMs: 1.5 }, { ...base, prazoMs: '1000' }, { ...base, prazoMs: 60001 }, { ...base, extra: 1 },
      comSymbol({ ...base }), comOculta({ ...base }),
    ];
    for (const ruim of ruins) assert.equal(codigoSincrono(() => modulo.criarFornecedorRolesAnywhere(ruim)), 'CONFIGURACAO_INVALIDA', JSON.stringify(ruim));
    for (const papel of PAPEIS) assert.equal(typeof modulo.criarFornecedorRolesAnywhere({ ...base, papel }).obter, 'function', papel);
    const fornecedor = criar({ transporte });
    assert.ok(Object.isFrozen(fornecedor));
    assert.equal(typeof criar({ papelIam: 'swb-hml-backup-restauracao', papel: 'RESTAURACAO', porta: PORTA, http: httpFalso(responderComoHelper).http }).obter, 'function');
  });

  test('RA-17 — fluxo completo pelo transporte padrão contra um endpoint simulado com as regras do serve 1.8.6: só 127.0.0.1, só os cabeçalhos do contrato, sem socket', async () => {
    const { http, registro } = httpFalso(responderComoHelper);
    const resultado = await pedir(criar({ porta: PORTA, http }));
    assert.equal(resultado.accessKeyId, ID_TEMPORARIO);
    assert.equal(resultado.sessionToken, SESSAO);
    const opcoesDe = (metodo, caminho, cabecalhos) => ({ host: '127.0.0.1', port: PORTA, method: metodo, path: caminho, headers: cabecalhos, agent: false });
    assert.deepEqual(registro.pedidos, [
      opcoesDe('PUT', ROTA_DA_SESSAO, { [CABECALHO_DA_VALIDADE]: '60', 'content-length': '0' }),
      opcoesDe('GET', ROTA_DO_PAPEL, { [CABECALHO_DA_SESSAO]: CODIGO_DA_SESSAO }),
      opcoesDe('GET', `${ROTA_DO_PAPEL}/${PAPEL_IAM}`, { [CABECALHO_DA_SESSAO]: CODIGO_DA_SESSAO }),
    ]);
    assert.equal(registro.destruicoes, 0);
  });

  test('RA-35 — alfabeto real das credenciais temporárias (base64 com / + = _ . -, maiúsculas e dígitos) é aceito no segredo, no token e no código da sessão e chega inteiro ao resultado e ao cabeçalho', async () => {
    const { transporte, chamadas } = helperFalso({ sessao: ok(ALFABETO_REAL.codigo), credenciais: credenciais({ SecretAccessKey: ALFABETO_REAL.segredo, Token: ALFABETO_REAL.sessao }) });
    const resultado = await pedir(criar({ transporte }));
    assert.deepEqual([resultado.secretAccessKey, resultado.sessionToken], [ALFABETO_REAL.segredo, ALFABETO_REAL.sessao]);
    assert.deepEqual(chamadas.slice(1).map((c) => c.cabecalhos[CABECALHO_DA_SESSAO]), [ALFABETO_REAL.codigo, ALFABETO_REAL.codigo]);
  });

  test('RA-36 — transporte injetado que lança valor hostil (Proxy ou acessor que lança, Proxy revogado) é ENDPOINT_INDISPONIVEL sem vazar texto; o código do erro é lido uma só vez', async () => {
    const revogavel = Proxy.revocable({}, {});
    revogavel.revoke();
    const hostis = [new Proxy({}, { get() { throw new Error('SENTINELA-DO-PROXY'); } }), { get code() { throw new TypeError('SENTINELA-DO-ACESSOR'); } }, revogavel.proxy];
    for (const hostil of hostis) {
      for (const falhar of [() => { throw hostil; }, () => Promise.reject(hostil)]) {
        confirmarErroFixo(await erroDe(pedir(criar({ transporte: helperFalso({ sessao: falhar }).transporte }))), 'ENDPOINT_INDISPONIVEL');
      }
    }
    let leituras = 0;
    const mutavel = { get code() { leituras += 1; return leituras === 1 ? 'RESPOSTA_INVALIDA' : 'CODIGO-LIVRE-DO-TRANSPORTE'; } };
    const erro = await erroDe(pedir(criar({ transporte: helperFalso({ sessao: () => { throw mutavel; } }).transporte })));
    assert.deepEqual([erro.code, leituras], ['RESPOSTA_INVALIDA', 1]);
  });

  test('RA-37 — a resposta de um transporte injetado é lida uma só vez e copiada antes de validar: o que foi conferido é o que é usado; acessor que lança ou resposta que não é objeto simples é RESPOSTA_INVALIDA', async () => {
    let leituras = 0;
    const mutante = { status: 200, get corpo() { leituras += 1; return leituras === 1 ? CODIGO_DA_SESSAO : 12345; } };
    const { transporte, chamadas } = helperFalso({ sessao: () => mutante });
    assert.equal((await pedir(criar({ transporte }))).accessKeyId, ID_TEMPORARIO);
    assert.equal(leituras, 1);
    assert.equal(chamadas[1].cabecalhos[CABECALHO_DA_SESSAO], CODIGO_DA_SESSAO);
    const hostis = [{ get status() { throw new Error('SENTINELA'); }, corpo: CODIGO_DA_SESSAO }, { status: 200, get corpo() { throw new Error('SENTINELA'); } }, Object.assign([], ok(CODIGO_DA_SESSAO))];
    for (const hostil of hostis) confirmarErroFixo(await erroDe(pedir(criar({ transporte: helperFalso({ sessao: () => hostil }).transporte }))), 'RESPOSTA_INVALIDA');
  });

  describe('[RA] transporte padrão (127.0.0.1, sem socket nos testes)', () => {
    test('RA-18 — corpo em vários blocos (inclusive um caractere UTF-8 partido entre blocos) vira texto; resposta sem objeto de cabeçalhos também é lida', async () => {
      const bytes = Buffer.from('ação');
      const { http } = httpFalso((req) => emitirResposta(req, { status: 200, partes: [bytes.subarray(0, 2), bytes.subarray(2, 4), bytes.subarray(4), ''] }));
      assert.deepEqual(await transportarPadrao(http), { status: 200, corpo: 'ação' });
      const { http: texto } = httpFalso((req) => emitirResposta(req, { status: 404, partes: ['nada', ' aqui'] }));
      assert.deepEqual(await transportarPadrao(texto), { status: 404, corpo: 'nada aqui' });
      const { http: semCabecalhos } = httpFalso((req) => {
        const resposta = new EventEmitter();
        resposta.statusCode = 200;
        req.emit('response', resposta);
        resposta.emit('data', Buffer.from('ok'));
        resposta.emit('end');
      });
      assert.deepEqual(await transportarPadrao(semCabecalhos), { status: 200, corpo: 'ok' });
    });

    test('RA-19 — corpo acima do limite (Content-Length declarado ou fluxo) é RESPOSTA_INVALIDA e a requisição é destruída; eventos da resposta depois do aborto não escapam', async () => {
      const pedido = { ...PEDIDO_DE_TRANSPORTE, limiteBytes: 10 };
      const declarado = httpFalso((req) => emitirResposta(req, { cabecalhos: { 'content-length': '11' }, partes: [Buffer.from('x')] }).emit('error', new Error('abortada')));
      assert.equal(await codigoDe(transportar(declarado.http, pedido)), 'RESPOSTA_INVALIDA');
      assert.equal(declarado.registro.destruicoes, 1);
      const fluxo = httpFalso((req) => emitirResposta(req, { partes: [Buffer.from('123456'), Buffer.from('78901')] }));
      assert.equal(await codigoDe(transportar(fluxo.http, pedido)), 'RESPOSTA_INVALIDA');
      assert.equal(fluxo.registro.destruicoes, 1);
      const noLimite = httpFalso((req) => emitirResposta(req, { partes: [Buffer.from('1234567890')] }));
      assert.equal((await transportar(noLimite.http, pedido)).corpo, '1234567890');
    });

    test('RA-20 — sem resposta no prazo, erro da requisição, erro da resposta, conexão fechada antes do fim, lançamento síncrono e destruição que falha são ENDPOINT_INDISPONIVEL (os eventos concluem sem depender do prazo)', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const mudo = httpFalso(() => undefined);
      const semResposta = codigoDe(transportar(mudo.http, { ...PEDIDO_DE_TRANSPORTE, prazoMs: 20 }));
      t.mock.timers.tick(19);
      assert.equal(mudo.registro.destruicoes, 0);
      t.mock.timers.tick(1);
      assert.equal(await semResposta, 'ENDPOINT_INDISPONIVEL');
      assert.equal(mudo.registro.destruicoes, 1);
      const roteiros = [
        (req) => req.emit('error', new Error('ECONNREFUSED')),
        (req) => emitirResposta(req, { partes: [Buffer.from('x')], fim: false }).emit('error', new Error('reset')),
        (req) => emitirResposta(req, { partes: [Buffer.from('x')], fim: false }).emit('close'),
      ];
      for (const roteiro of roteiros) assert.equal(await codigoDe(transportarPadrao(httpFalso(roteiro).http)), 'ENDPOINT_INDISPONIVEL');
      const lanca = { request: () => { throw new Error('ERR_INVALID_CHAR'); } };
      assert.equal(await codigoDe(transportarPadrao(lanca)), 'ENDPOINT_INDISPONIVEL');
      const { http: base } = httpFalso(() => undefined);
      const destruirFalhando = () => { throw new Error('destroy falhou'); };
      const destruicaoQueFalha = { request: (opcoes) => Object.assign(base.request(opcoes), { destroy: destruirFalhando }) };
      const semDestruir = codigoDe(transportar(destruicaoQueFalha, { ...PEDIDO_DE_TRANSPORTE, prazoMs: 20 }));
      t.mock.timers.tick(20);
      assert.equal(await semDestruir, 'ENDPOINT_INDISPONIVEL');
    });

    test('RA-21 — a promessa conclui uma só vez: eventos repetidos depois do fim não mudam o resultado nem destroem a requisição', async () => {
      const { http, registro } = httpFalso((req) => {
        const resposta = emitirResposta(req, { partes: [Buffer.from('ok')] });
        resposta.emit('close');
        resposta.emit('error', new Error('tardio'));
        req.emit('error', new Error('tardio'));
      });
      assert.deepEqual(await transportarPadrao(http), { status: 200, corpo: 'ok' });
      assert.equal(registro.destruicoes, 0);
    });

    test('RA-22 — pedido de transporte fora da forma ou fora do contrato é CONFIGURACAO_INVALIDA e nenhuma requisição é criada', async () => {
      const { http, registro } = httpFalso(() => undefined);
      const com = (extra) => ({ ...PEDIDO_DE_TRANSPORTE, ...extra });
      const ruins = [
        undefined, null, [], 'x', {}, Object.create({ ...PEDIDO_DE_TRANSPORTE }), omitir(PEDIDO_DE_TRANSPORTE, 'prazoMs'), { ...omitir(PEDIDO_DE_TRANSPORTE, 'prazoMs'), extra: 1 },
        Object.assign(Object.create({ prazoMs: 1000 }), { ...omitir(PEDIDO_DE_TRANSPORTE, 'prazoMs'), extra: 1 }), com({ extra: 1 }), com({ metodo: 'POST' }), com({ metodo: 'get' }),
        com({ caminho: '/outra/rota' }), com({ caminho: '/latest/../x' }), com({ caminho: '/latest/./x' }), com({ caminho: '/latest/.' }), com({ caminho: '/latest/a b' }), com({ caminho: '/latest/a\nb' }),
        com({ caminho: '/latest//x' }), com({ caminho: 'latest/x' }), com({ caminho: `${ROTA_DO_PAPEL}/?x=1` }), com({ cabecalhos: null }), com({ cabecalhos: [] }), com({ cabecalhos: { a: 1 } }),
        com({ cabecalhos: { 'x-a': 'quebra\r\nlinha' } }), com({ cabecalhos: { 'x-a': 'com espaco' } }), com({ cabecalhos: { 'x-a': '' } }), com({ cabecalhos: { 'X-Foo': 'v' } }),
        com({ cabecalhos: { '': 'v' } }), com({ cabecalhos: { 'x a': 'v' } }), com({ prazoMs: 0 }), com({ prazoMs: 1.5 }), com({ prazoMs: 60001 }),
        com({ limiteBytes: 0 }), com({ limiteBytes: 1.5 }), com({ limiteBytes: 1_000_001 }), comSymbol({ ...PEDIDO_DE_TRANSPORTE }), comOculta({ ...PEDIDO_DE_TRANSPORTE }),
      ];
      for (const ruim of ruins) assert.equal(await codigoDe(transportar(http, ruim)), 'CONFIGURACAO_INVALIDA', JSON.stringify(ruim));
      assert.equal(registro.pedidos.length, 0);
    });

    test('RA-23 — construção do transporte fora da forma é CONFIGURACAO_INVALIDA; o transporte é uma função', () => {
      const modulo = carregar();
      const { http } = httpFalso(() => undefined);
      const construir = (opcoes) => codigoSincrono(() => modulo.criarTransporteLoopback(opcoes));
      for (const ruim of [undefined, null, [], {}, { porta: 80 }, { porta: 1023 }, { porta: 65536 }, { porta: 9911.5 }, { porta: '9911' }, { porta: PORTA, extra: 1 }, { porta: PORTA, http: 'x' }, { porta: PORTA, http: null }, { porta: PORTA, http: {} }, comSymbol({ porta: PORTA }), comOculta({ porta: PORTA })]) {
        assert.equal(construir(ruim), 'CONFIGURACAO_INVALIDA', JSON.stringify(ruim));
      }
      assert.equal(typeof modulo.criarTransporteLoopback({ porta: PORTA, http }), 'function');
      assert.equal(typeof modulo.criarTransporteLoopback({ porta: PORTA }), 'function');
    });

    test('RA-26 — o http recebe uma cópia dos cabeçalhos do pedido, nunca a mesma referência', async () => {
      const { http, registro } = httpFalso((req) => emitirResposta(req, { partes: ['ok'] }));
      await transportarPadrao(http);
      assert.deepEqual(registro.brutos[0].headers, PEDIDO_DE_TRANSPORTE.cabecalhos);
      assert.notEqual(registro.brutos[0].headers, PEDIDO_DE_TRANSPORTE.cabecalhos);
    });

    test('RA-33 — o pedido de transporte é lido uma só vez: acessor, Symbol e valor de cabeçalho que muda não alteram o que é validado e enviado', async () => {
      const { http, registro } = httpFalso((req) => emitirResposta(req, { partes: ['ok'] }));
      let leituras = 0;
      const comAcessor = { ...PEDIDO_DE_TRANSPORTE };
      Object.defineProperty(comAcessor, 'caminho', { enumerable: true, get() { leituras += 1; return leituras === 1 ? ROTA_DO_PAPEL : '/qualquer/outra/rota?x=1'; } });
      await transportar(http, comAcessor);
      assert.equal(registro.pedidos[0].path, ROTA_DO_PAPEL);
      assert.equal(leituras, 1);
      let leiturasDoValor = 0;
      const cabecalhos = {};
      Object.defineProperty(cabecalhos, CABECALHO_DA_SESSAO, { enumerable: true, get() { leiturasDoValor += 1; return leiturasDoValor === 1 ? CODIGO_DA_SESSAO : 'valor\r\ninjetado'; } });
      await transportar(http, { ...PEDIDO_DE_TRANSPORTE, cabecalhos });
      assert.equal(registro.pedidos[1].headers[CABECALHO_DA_SESSAO], CODIGO_DA_SESSAO);
      assert.equal(leiturasDoValor, 1);
      const cabecalhosComSymbol = { [CABECALHO_DA_SESSAO]: CODIGO_DA_SESSAO, [Symbol('extra')]: 'v' };
      assert.equal(await codigoDe(transportar(http, { ...PEDIDO_DE_TRANSPORTE, cabecalhos: cabecalhosComSymbol })), 'CONFIGURACAO_INVALIDA');
    });

    test('RA-38 — as opções do transporte são lidas uma só vez: acessor da porta que muda não contorna a faixa nem altera a porta enviada', async () => {
      const { http, registro } = httpFalso((req) => emitirResposta(req, { partes: ['ok'] }));
      let leituras = 0;
      const opcoes = { http };
      Object.defineProperty(opcoes, 'porta', { enumerable: true, get() { leituras += 1; return leituras === 1 ? PORTA : 80; } });
      await carregar().criarTransporteLoopback(opcoes)(PEDIDO_DE_TRANSPORTE);
      assert.deepEqual([leituras, registro.pedidos[0].port], [1, PORTA]);
    });
  });

  describe('[RA] cliente node:http real em conexão em memória (sem servidor, socket nem porta)', () => {
    const CABECALHOS_DO_PUT = ['connection', 'content-length', 'host', CABECALHO_DA_VALIDADE];
    const CABECALHOS_DO_GET = ['connection', 'host', CABECALHO_DA_SESSAO];

    test('RA-30 — o ClientRequest real envia Host 127.0.0.1:<porta> (inclusive nos extremos), Connection: close e só os cabeçalhos do contrato', async () => {
      armarSentinela(ALVOS_DE_SOCKET());
      try {
        for (const porta of [1024, PORTA, 65535]) {
          const registro = [];
          const resultado = await pedir(criar({ porta, http: httpEmMemoria(responderPelaCabeca(porta), registro) }));
          assert.equal(resultado.accessKeyId, ID_TEMPORARIO, String(porta));
          const cabecas = registro.map(lerCabeca);
          assert.deepEqual(cabecas.map((c) => c.linha), [`PUT ${ROTA_DA_SESSAO} HTTP/1.1`, `GET ${ROTA_DO_PAPEL} HTTP/1.1`, `GET ${ROTA_DO_PAPEL}/${PAPEL_IAM} HTTP/1.1`]);
          assert.deepEqual(cabecas.map((c) => ordenar(Object.keys(c.cab))), [CABECALHOS_DO_PUT, CABECALHOS_DO_GET, CABECALHOS_DO_GET]);
          for (const c of cabecas) assert.deepEqual([c.cab.host, c.cab.connection], [`127.0.0.1:${porta}`, 'close']);
          assert.deepEqual([cabecas[0].cab['content-length'], cabecas[0].cab[CABECALHO_DA_VALIDADE]], ['0', '60']);
        }
        assert.deepEqual(tentativasDeRede, []);
      } finally {
        desarmarSentinela();
      }
    });

    test('RA-34 — com o cliente real em memória: resposta em blocos (chunked) é lida; porta diferente da do helper é RESPOSTA_INVALIDA já no primeiro pedido (403 da guarda)', async () => {
      armarSentinela(ALVOS_DE_SOCKET());
      try {
        const registro = [];
        const resultado = await pedir(criar({ porta: PORTA, http: httpEmMemoria(responderPelaCabeca(PORTA), registro, true) }));
        assert.deepEqual([resultado.sessionToken, resultado.secretAccessKey, registro.length], [SESSAO, SEGREDO, 3]);
        const divergente = [];
        assert.equal(await codigoDe(pedir(criar({ porta: PORTA + 1, http: httpEmMemoria(responderPelaCabeca(PORTA), divergente) }))), 'RESPOSTA_INVALIDA');
        assert.equal(divergente.length, 1);
        assert.deepEqual(tentativasDeRede, []);
      } finally {
        desarmarSentinela();
      }
    });
  });

  describe('[RA] relógio, temporizadores, prazo e fronteiras', () => {
    test('RA-27 — sem `relogio` o fornecedor usa o relógio real: expiração daqui a 1 h é aceita; vencida há 1 s e daqui a 13 h são recusadas', async () => {
      const comRelogioReal = (expiracao) => carregar().criarFornecedorRolesAnywhere({
        papel: 'PUBLICADOR', papelIam: PAPEL_IAM, transporte: helperFalso({ credenciais: credenciais({ Expiration: instante(expiracao) }) }).transporte,
      });
      const agora = Date.now();
      assert.equal((await pedir(comRelogioReal(agora + HORA_MS))).expiration.getTime(), agora + HORA_MS);
      assert.equal(await codigoDe(pedir(comRelogioReal(agora - 1000))), 'CREDENCIAL_EXPIRADA');
      assert.equal(await codigoDe(pedir(comRelogioReal(agora + 13 * HORA_MS))), 'EXPIRACAO_FORA_DA_FAIXA');
    });

    test('RA-28 — nenhum caminho (sucesso, erro, fechamento, limite, lançamento, falha do fornecedor) deixa temporizador pendente', async () => {
      carregar();
      await proximoCiclo();
      const antes = temporizadoresAtivos();
      const aguardaPrazo = async (iniciar) => {
        const concluida = codigoDe(iniciar());
        assert.ok(temporizadoresAtivos() > antes, 'o prazo precisa manter um temporizador com referência enquanto a chamada está pendente');
        assert.equal(await concluida, 'ENDPOINT_INDISPONIVEL');
      };
      await aguardaPrazo(() => pedir(criar({ transporte: () => new Promise(() => { /* nunca conclui */ }), prazoMs: 20 })));
      await aguardaPrazo(() => transportar(httpFalso(() => undefined).http, { ...PEDIDO_DE_TRANSPORTE, prazoMs: 20 }));
      await proximoCiclo();
      assert.equal(temporizadoresAtivos(), antes);
      const roteiros = [
        (req) => emitirResposta(req, { partes: ['ok'] }),
        (req) => req.emit('error', new Error('x')),
        (req) => emitirResposta(req, { partes: ['x'], fim: false }).emit('close'),
        (req) => emitirResposta(req, { cabecalhos: { 'content-length': '99999' } }),
        (req) => emitirResposta(req, { partes: [Buffer.alloc(LIMITE_DE_BYTES + 1)] }),
      ];
      for (const roteiro of roteiros) {
        await codigoDe(transportarPadrao(httpFalso(roteiro).http));
        await proximoCiclo();
        assert.equal(temporizadoresAtivos(), antes);
      }
      await codigoDe(transportarPadrao({ request: () => { throw new Error('x'); } }));
      await pedir(criar({ transporte: helperFalso().transporte }));
      await resultadoDaFalha({ sessao: new Error('x') });
      await resultadoDaFalha({ credenciais: { status: 500, corpo: SEM_CREDENCIAL } });
      await proximoCiclo();
      assert.equal(temporizadoresAtivos(), antes);
    });

    test('RA-29 — fronteiras: cada limite aceita o valor exato e recusa o vizinho (campos das credenciais, corpo, sessão, papelIam, porta, prazo e pedido de transporte)', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const idDe = (tamanho) => `${ID_TEMPORARIO.slice(0, 4)}${'A'.repeat(tamanho - 4)}`;
      for (const [campo, aceito, recusado] of [
        ['AccessKeyId', idDe(16), idDe(15)], ['AccessKeyId', idDe(128), idDe(129)], ['SecretAccessKey', 'a'.repeat(16), 'a'.repeat(15)], ['SecretAccessKey', 'a'.repeat(256), 'a'.repeat(257)],
        ['Token', 'a'.repeat(16), 'a'.repeat(15)], ['Token', 'a'.repeat(4096), 'a'.repeat(4097)], ['LastUpdated', 'x', ''], ['LastUpdated', 'x'.repeat(64), 'x'.repeat(65)],
      ]) {
        assert.equal((await resultadoDaFalha({ credenciais: credenciais({ [campo]: aceito }) })).codigo, null, `${campo} no limite`);
        assert.equal((await resultadoDaFalha({ credenciais: credenciais({ [campo]: recusado }) })).codigo, 'RESPOSTA_INVALIDA', `${campo} fora do limite`);
      }
      const comTamanho = (bytes) => { const base = JSON.stringify(corpoDasCredenciais()); return `${base}${' '.repeat(bytes - Buffer.byteLength(base))}`; };
      assert.equal((await resultadoDaFalha({ credenciais: ok(comTamanho(LIMITE_DE_BYTES)) })).codigo, null);
      assert.equal((await resultadoDaFalha({ credenciais: ok(comTamanho(LIMITE_DE_BYTES + 1)) })).codigo, 'RESPOSTA_INVALIDA');
      const multibyte = JSON.stringify(corpoDasCredenciais({ LastUpdated: 'ç'.repeat(64) }));
      const comAcentos = `${multibyte}${' '.repeat(LIMITE_DE_BYTES - multibyte.length)}`;
      assert.ok(comAcentos.length === LIMITE_DE_BYTES && Buffer.byteLength(comAcentos) > LIMITE_DE_BYTES, 'o corpo tem 8192 caracteres e mais de 8192 bytes');
      assert.equal((await resultadoDaFalha({ credenciais: ok(comAcentos) })).codigo, 'RESPOSTA_INVALIDA');
      for (const [codigo, esperado] of [['a'.repeat(16), null], ['a'.repeat(512), null], ['a'.repeat(15), 'RESPOSTA_INVALIDA'], ['a'.repeat(513), 'RESPOSTA_INVALIDA']]) {
        assert.equal((await resultadoDaFalha({ sessao: ok(codigo) })).codigo, esperado, `sessão de ${codigo.length}`);
      }
      for (const nome of NOMES_DE_PAPEL_IAM) {
        assert.equal((await pedir(criar({ papelIam: nome, transporte: helperFalso({ papel: ok(nome) }).transporte }))).accessKeyId, ID_TEMPORARIO, nome);
        const pelaPorta = criar({ papelIam: nome, porta: PORTA, http: httpFalso(responderComoHelperDe(nome)).http });
        assert.equal((await pedir(pelaPorta)).accessKeyId, ID_TEMPORARIO, `${nome} pelo transporte padrão`);
      }
      const { http } = httpFalso(() => undefined);
      for (const porta of [1024, 65535]) {
        assert.equal(typeof carregar().criarTransporteLoopback({ porta, http }), 'function');
        assert.equal(typeof criar({ porta, http }).obter, 'function');
      }
      for (const prazoMs of [1, 60000]) assert.equal(typeof criar({ transporte: helperFalso().transporte, prazoMs }).obter, 'function');
      const responde = httpFalso((req) => emitirResposta(req, { partes: ['x'] })).http;
      const com = (extra) => ({ ...PEDIDO_DE_TRANSPORTE, ...extra });
      for (const extra of [{ prazoMs: 1 }, { prazoMs: 60000 }, { limiteBytes: 1 }, { limiteBytes: 1_000_000 }, { cabecalhos: { [`x${'a'.repeat(63)}`]: 'v'.repeat(600) } }, { cabecalhos: { x: '!~' } }]) {
        assert.equal((await transportar(responde, com(extra))).status, 200, JSON.stringify(extra).slice(0, 60));
      }
      for (const extra of [{ cabecalhos: { [`x${'a'.repeat(64)}`]: 'v' } }, { cabecalhos: { x: 'v'.repeat(601) } }, { cabecalhos: { x: 'a\x7f' } }]) {
        assert.equal(await codigoDe(transportar(responde, com(extra))), 'CONFIGURACAO_INVALIDA', JSON.stringify(extra).slice(0, 60));
      }
      const noLimite = httpFalso((req) => emitirResposta(req, { cabecalhos: { 'content-length': '10' }, partes: [Buffer.from('1234567890')] })).http;
      assert.equal((await transportar(noLimite, com({ limiteBytes: 10 }))).corpo, '1234567890');
    });

    test('RA-31 — transporte injetado que nunca conclui não trava o fornecedor: o prazo vale no próprio fornecedor e a aquisição é liberada', async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      let chamadasAoTransporte = 0;
      const pendente = () => { chamadasAoTransporte += 1; return new Promise(() => { /* nunca conclui */ }); };
      const fornecedor = criar({ transporte: pendente, prazoMs: 100 });
      const primeira = codigoDe(pedir(fornecedor));
      t.mock.timers.tick(99);
      assert.equal(chamadasAoTransporte, 1);
      t.mock.timers.tick(1);
      assert.equal(await primeira, 'ENDPOINT_INDISPONIVEL');
      const segunda = codigoDe(pedir(fornecedor));
      t.mock.timers.tick(100);
      assert.equal(await segunda, 'ENDPOINT_INDISPONIVEL');
      assert.equal(chamadasAoTransporte, 2);
    });

    test('RA-32 — calendário: o último dia de cada mês é aceito e o dia seguinte é recusado (2027 e 2028, bissexto incluso)', async () => {
      const dois = (n) => String(n).padStart(2, '0');
      const instanteDe = (ano, mes, dia) => `${ano}-${dois(mes)}-${dois(dia)}T09:00:00Z`;
      const opcoesDoDia = (ano, mes, dia) => ({ relogio: () => Date.UTC(ano, mes - 1, Math.min(dia, 28), 8) });
      for (const ano of [2027, 2028]) {
        for (let mes = 1; mes <= 12; mes += 1) {
          const ultimo = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
          const aceito = await resultadoDaFalha({ credenciais: credenciais({ Expiration: instanteDe(ano, mes, ultimo) }) }, { relogio: () => Date.UTC(ano, mes - 1, ultimo, 8) });
          assert.equal(aceito.codigo, null, instanteDe(ano, mes, ultimo));
          const recusado = await resultadoDaFalha({ credenciais: credenciais({ Expiration: instanteDe(ano, mes, ultimo + 1) }) }, opcoesDoDia(ano, mes, ultimo));
          assert.equal(recusado.codigo, 'RESPOSTA_INVALIDA', instanteDe(ano, mes, ultimo + 1));
        }
      }
    });
  });

  describe('[RA] isolamento: carga sem efeito, nenhuma rede e invariantes do texto', () => {
    test('RA-24 — carregar o módulo e montar fornecedores não abre rede; o transporte padrão só usa node:http.request no momento do pedido', async () => {
      carregar();
      armarSentinela([...ALVOS_DE_SOCKET(), ...ALVOS_DE_HTTP()]);
      try {
        delete require.cache[require.resolve(ARQUIVO_DO_MODULO)];
        const modulo = carregar();
        modulo.criarTransporteLoopback({ porta: PORTA });
        modulo.criarFornecedorRolesAnywhere({ papel: 'PUBLICADOR', papelIam: PAPEL_IAM, porta: PORTA });
        assert.deepEqual(tentativasDeRede, []);
        const { http } = httpFalso(responderComoHelper);
        await pedir(criar({ porta: PORTA, http }));
        assert.deepEqual(tentativasDeRede, []);
        assert.equal(await codigoDe(modulo.criarTransporteLoopback({ porta: PORTA })(PEDIDO_DE_TRANSPORTE)), 'ENDPOINT_INDISPONIVEL');
        assert.deepEqual(tentativasDeRede, ['request']);
      } finally {
        desarmarSentinela();
      }
    });

    test('RA-25 — exports exatos e texto do módulo: único require é node:http; sem arquivo, process, ambiente, log, fetch, SDK, constante de raiz nem marcador de comentário em literal', () => {
      const modulo = carregar();
      assert.deepEqual(ordenar(Object.keys(modulo)), ['criarFornecedorRolesAnywhere', 'criarTransporteLoopback']);
      const texto = fs.readFileSync(ARQUIVO_DO_MODULO, 'utf8');
      assert.deepEqual([...texto.matchAll(/require\(\s*(['"`])([^'"`]+)\1\s*\)/g)].map((m) => m[2]), ['node:http']);
      assert.equal((texto.match(/\brequire\b/g) ?? []).length, 1);
      for (const [nome, regra] of [
        ['import', /^\s*import\s/m], ['process', /\bprocess\b/], ['globalThis', /\bglobalThis\b/], ['console', /console\./], ['fetch', /\bfetch\s*\(/], ['eval/Function', /\beval\s*\(|new Function/],
        ['SDK e dotenv', /@aws-sdk|aws-sdk|dotenv/], ['import dinâmico', /import\s*\(/], ['raiz de armazenamento', /\b[A-Z][A-Z0-9_]*(?:_DIRETORIO|_ARQUIVO|_ARMAZENAMENTO[A-Z0-9_]*|_BUCKET|_STORAGE|_UPLOAD[A-Z0-9_]*)\b/],
      ]) assert.ok(!regra.test(texto), `o módulo contém ${nome}`);
      const literais = [...texto.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((trecho) => trecho[2]);
      assert.ok(literais.includes(ROTA_DA_SESSAO), 'o extrator de literais encontra os literais do módulo');
      assert.deepEqual(literais.filter((literal) => /\/\*|\*\//.test(literal)), [], 'o módulo contém marcador de comentário em literal');
    });
  });
});
