'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../src/services/backup-executor-ligacao-cli.service');
const Pol = require('../../src/services/backup-executor-politica.service');
const Ev = require('../../src/services/backup-executor-evidencia.service');
const { prepararAmbiente } = require('../helpers/ambiente-executor');
const { limparRaizes } = require('../helpers/pacote-l2-sintetico');
const { criarSdkFalso } = require('../helpers/sdk-aws-falso');
const { removerTemporarioSeguro, criarRaizTemporaria } = require('../storage/helpers/tmp-seguro');

/**
 * D-ORF-6, Rodada B (B1) [LIG-CLI]: montagem da ligação para o CLI, só para ensaio isolado. Configuração e credenciais SINTÉTICAS em arquivos 0600 temporários, SDK e S3 falsos, chaves de teste;
 * nada contata a AWS, nenhum PostgreSQL é aberto e a operação real continua desligada.
 */

const UID = process.getuid();
const AGORA = 1_800_000_000_000;
const SEGREDO = 'SWBTESTE-segredo-falso-0123';
const IDS = Object.freeze({ PUBLICADOR: 'SWBTESTEPUB12345', VERIFICADOR: 'SWBTESTEVER12345', RESTAURACAO: 'SWBTESTERES12345' });
const PROTEGIDOS = Object.freeze({ imagens: '/srv/safework/imagens', fiscalizacao: '/srv/safework/fiscalizacao', preparacoes: '/srv/safework/backup/preparacoes', dumps: '/srv/safework/backup/dumps', publicados: '/srv/safework/backup/publicados' });
const FATOS = Object.freeze({ sdk: 'SIMULADO', chavesOrigem: 'TESTE_CONTROLADO', uid: 501, umask: 0o077 });
const raizes = [];
after(() => { for (const r of raizes) removerTemporarioSeguro(r); limparRaizes(); });
const novaRaiz = () => { const r = criarRaizTemporaria(); raizes.push(r); return r; };
const gravar = (caminho, texto, modo = 0o600) => { fs.writeFileSync(caminho, texto, { mode: modo }); fs.chmodSync(caminho, modo); return caminho; };
const relogioDe = () => { let t = AGORA - 10; return () => { t += 10; return t; }; };
const cred = (papel, extra = {}) => ({ papel, accessKeyId: IDS[papel], secretAccessKey: SEGREDO, ...extra });
const lida = (linha) => { const r = Ev.lerLinhaDeEvidencia(linha); assert.equal(r.ok, true, JSON.stringify(r)); return r.evidencia; };
const codigoDe = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

/** Cria configuração e arquivos de credencial 0600. `ajustar(papel, objeto)` altera o conteúdo de um papel; `configExtra` troca campos da configuração. */
function preparar({ papeis = ['PUBLICADOR', 'VERIFICADOR'], ajustar = (_p, o) => o, configExtra = {}, modoConfig = 0o600, regiao = 'us-east-1' } = {}) {
  const raiz = novaRaiz();
  const caminhos = {};
  for (const p of papeis) caminhos[p] = gravar(path.join(raiz, `${p}.json`), JSON.stringify(ajustar(p, cred(p))));
  const config = gravar(path.join(raiz, 'config.json'), JSON.stringify({ versao: 1, finalidade: 'ENSAIO_ISOLADO', ambiente: 'HOMOLOGACAO', regiao, papeis: caminhos, ...configExtra }), modoConfig);
  return { raiz, caminhos, config, ambiente: { BACKUP_EXECUTOR_CONFIG: config } };
}

/** O SDK falso decide o papel por `FAKE-<PAPEL>`; este envoltório traduz a credencial sintética de cada papel para o que ele reconhece, sem relaxar nada do lado de produção. */
function sdkQueTraduz(sdk) {
  const papelDe = Object.fromEntries(Object.entries(IDS).map(([papel, id]) => [id, papel]));
  const envolver = (Classe) => class extends Classe {
    constructor(config) {
      const original = config.credentials;
      super({ ...config, credentials: async () => { const c = await original(); return { accessKeyId: `FAKE-${papelDe[c.accessKeyId].toLowerCase()}`, secretAccessKey: c.secretAccessKey }; } });
    }
  };
  return Object.freeze({ ...sdk, S3Client: envolver(sdk.S3Client), KMSClient: envolver(sdk.KMSClient), STSClient: envolver(sdk.STSClient) });
}

async function ambienteDeEnsaio(conjuntoId) {
  const x = await prepararAmbiente({ conjuntoId });
  const falso = criarSdkFalso({ ficha: x.a.ficha, relogio: x.a.relogio });
  const recibos = [];
  const colaboradores = {
    auditoria: { registrar: async () => ({ gravado: true, id: '1' }) },
    coordenacao: { adquirir: async ({ operacao }) => ({ ok: true, operacao, liberar: async () => {} }) },
    fatos: { ...FATOS },
    trabalho: { conjuntoId, nomeContainer: 'container-1' },
    producao: { produzir: async () => ({ ok: true, pacote: { dir: x.pacote.dir, lido: x.pacote.lido } }) },
    chaves: x.chaves,
    destinoLocal: { validador: x.dlContainers.validador, destinoLocalId: x.dlContainers.id, raiz: x.dlContainers.raiz },
    protegidos: { ...PROTEGIDOS },
    limites: { arquivosMaximo: 1000, totalBytesMaximo: 2 ** 30 },
    prazoMs: 1000,
    registro: x.a.reg,
  };
  return { x, falso, recibos, colaboradores, sdk: sdkQueTraduz(falso.sdk), pedidoCompor: { modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destino: x.a.ficha.id, confirmacao: Pol.FRASES.ENSAIO.BACKUP } };
}
const opcoesDe = (e, f, extra = {}) => ({
  pedido: { modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO' }, ambiente: f.ambiente, relogio: relogioDe(), carregarSdk: () => e.sdk, escreverRecibo: (t) => { e.recibos.push(t); }, colaboradores: e.colaboradores, ...extra,
});
const montar = (opcoes) => M.montarPortasDoCli(opcoes);

describe('[LIG-CLI] montagem da ligação para o CLI', () => {
  test('LIG-CLI-01 — sem BACKUP_EXECUTOR_CONFIG (ausente ou vazia) devolve undefined: o CLI segue sem ligação', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig01');
    assert.equal(await montar(opcoesDe(e, { ambiente: {} })), undefined);
    assert.equal(await montar(opcoesDe(e, { ambiente: { BACKUP_EXECUTOR_CONFIG: '' } })), undefined);
  });

  test('LIG-CLI-02 — ensaio de backup completo com adaptadores falsos chega a CONCLUIDO; o recibo sai numa única linha RECIBO_CONSOLIDADO e nada vaza', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig02');
    const f = preparar();
    const portas = await montar(opcoesDe(e, f));
    assert.ok(Object.isFrozen(portas) && typeof portas.compor === 'function');
    const execucao = await portas.compor(e.pedidoCompor);
    const r = await execucao.executar();
    assert.equal(r.evidenciaRegistrada, true);
    const ev = lida(r.linha);
    assert.deepEqual({ estado: ev.estado, modo: ev.modo, conjuntoId: ev.conjuntoId, operacional: ev.operacional, duravel: ev.duravelmenteArmazenado }, { estado: 'CONCLUIDO', modo: 'ENSAIO', conjuntoId: 'conjunto-lig02', operacional: false, duravel: false });
    assert.equal(e.recibos.length, 1);
    const linha = e.recibos[0];
    assert.match(linha, /^RECIBO_CONSOLIDADO \{.*\}\n$/s);
    assert.equal(linha.indexOf('\n'), linha.length - 1);
    const corpo = JSON.parse(linha.slice('RECIBO_CONSOLIDADO '.length));
    assert.deepEqual(Object.keys(corpo).sort(), ['bytes', 'conjuntoId', 'sha256']);
    assert.equal(corpo.conjuntoId, 'conjunto-lig02');
    assert.equal(crypto.createHash('sha256').update(Buffer.from(corpo.bytes, 'base64')).digest('hex'), corpo.sha256);
    for (const texto of [r.linha, linha, JSON.stringify(r.auditoria)]) assert.ok(!texto.includes(SEGREDO) && !texto.includes(f.raiz), 'segredo ou caminho vazou');
    const papeis = new Set(e.falso.estado.chamadas.map((c) => c.papel));
    assert.ok(papeis.size > 0 && [...papeis].every((p) => ['publicador', 'verificador'].includes(p)), [...papeis].join(','));
    assert.ok(papeis.has('publicador') && papeis.has('verificador'), 'o ensaio deveria usar publicador e verificador');
  });

  test('LIG-CLI-03 — recibo que não pode ser escrito derruba a execução em FALHOU/RECIBOS_NAO_REGISTRADOS, nunca em sucesso', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig03');
    const f = preparar();
    const portas = await montar(opcoesDe(e, f, { escreverRecibo: () => { throw new Error('STDERR-QUEBRADO'); } }));
    const r = await (await portas.compor(e.pedidoCompor)).executar();
    const ev = lida(r.linha);
    assert.deepEqual({ estado: ev.estado, codigo: ev.codigo }, { estado: 'FALHOU', codigo: 'RECIBOS_NAO_REGISTRADOS' });
  });

  test('LIG-CLI-04 — NODE_ENV=test sozinho não basta: sem colaboradores injetados a montagem para; com eles fora de test a política bloqueia sem tocar no destino', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig04');
    const f = preparar();
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(await codigoDe(montar(opcoesDe(e, f, { colaboradores: undefined }))), 'LIGACAO_COLABORADORES_AUSENTES');
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const comRegistro = await montar(opcoesDe(e, f));
      assert.equal(await codigoDe(Promise.resolve().then(() => comRegistro.compor(e.pedidoCompor))), 'COMPOSITOR_PEDIDO_INVALIDO');
      const { registro, ...semRegistro } = e.colaboradores;
      const portas = await montar(opcoesDe(e, f, { colaboradores: semRegistro }));
      const r = await (await portas.compor(e.pedidoCompor)).executar();
      const ev = lida(r.linha);
      assert.equal(ev.estado, 'BLOQUEADO');
      for (const esperado of ['PORTAS_SIMULADAS_FORA_DE_TESTE', 'FONTE_DE_CHAVES_NAO_APROVADA', 'DESTINO_DURAVEL_NAO_APROVADO']) assert.ok(ev.bloqueios.includes(esperado), `${esperado} em ${ev.bloqueios.join(',')}`);
      assert.equal(e.falso.estado.chamadas.length, 0);
    } finally { process.env.NODE_ENV = original; }
  });

  test('LIG-CLI-05 — OPERACAO e PRODUCAO nunca montam (finalidade não autorizada), mesmo com tudo o mais válido e colaboradores', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig05');
    const f = preparar();
    for (const pedido of [{ modo: 'OPERACAO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO' }, { modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'PRODUCAO' }, { modo: 'OPERACAO', acao: 'BACKUP', ambiente: 'PRODUCAO' }, { modo: 'ensaio', acao: 'BACKUP', ambiente: 'HOMOLOGACAO' }]) {
      assert.equal(await codigoDe(montar(opcoesDe(e, f, { pedido }))), 'LIGACAO_FINALIDADE_NAO_AUTORIZADA', JSON.stringify(pedido));
    }
    assert.equal(await codigoDe(montar(opcoesDe(e, f, { pedido: { modo: 'ENSAIO', acao: 'FORMATAR', ambiente: 'HOMOLOGACAO' } }))), 'LIGACAO_ACAO_INVALIDA');
  });

  test('LIG-CLI-06 — papel obrigatório da ação ausente na configuração é recusado', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig06');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar({ papeis: ['VERIFICADOR'] })))), 'LIGACAO_PAPEL_OBRIGATORIO_AUSENTE');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar({ papeis: ['PUBLICADOR'] }), { pedido: { modo: 'ENSAIO', acao: 'RESTAURACAO', ambiente: 'HOMOLOGACAO' } }))), 'LIGACAO_PAPEL_OBRIGATORIO_AUSENTE');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar({ papeis: ['PUBLICADOR'] }), { pedido: { modo: 'ENSAIO', acao: 'VERIFICACAO_DESTINO', ambiente: 'HOMOLOGACAO' } }))), 'LIGACAO_PAPEL_OBRIGATORIO_AUSENTE');
  });

  test('LIG-CLI-07 — credenciais inválidas: repetidas, de outro papel, expiradas, reais, sem marcador, com token e com permissão aberta', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig07');
    const com = (ajustar) => montar(opcoesDe(e, preparar({ ajustar })));
    assert.equal(await codigoDe(com((p, o) => (p === 'VERIFICADOR' ? { ...o, accessKeyId: IDS.PUBLICADOR } : o))), 'LIGACAO_CREDENCIAIS_REPETIDAS_ENTRE_PAPEIS');
    assert.equal(await codigoDe(com((p, o) => (p === 'PUBLICADOR' ? { ...o, papel: 'VERIFICADOR' } : o))), 'LIGACAO_CREDENCIAL_DE_OUTRO_PAPEL');
    assert.equal(await codigoDe(com((p, o) => (p === 'PUBLICADOR' ? { ...o, expiration: '2020-01-01T00:00:00Z' } : o))), 'LIGACAO_CREDENCIAL_EXPIRADA');
    assert.equal(await codigoDe(com((p, o) => (p === 'PUBLICADOR' ? { ...o, accessKeyId: 'AKIAIOSFODNN7EXAMPLE' } : o))), 'LIGACAO_CREDENCIAL_INDISPONIVEL');
    assert.equal(await codigoDe(com((p, o) => (p === 'PUBLICADOR' ? { ...o, accessKeyId: 'EXEMPLOIDCHAVEPUB01' } : o))), 'LIGACAO_CREDENCIAL_INDISPONIVEL');
    assert.equal(await codigoDe(com((p, o) => (p === 'PUBLICADOR' ? { ...o, sessionToken: 'sessao-falsa-0123456789' } : o))), 'LIGACAO_CREDENCIAL_INDISPONIVEL');
    const aberta = preparar();
    fs.chmodSync(aberta.caminhos.PUBLICADOR, 0o644);
    assert.equal(await codigoDe(montar(opcoesDe(e, aberta))), 'LIGACAO_CREDENCIAL_INDISPONIVEL');
    const link = preparar();
    fs.rmSync(link.caminhos.PUBLICADOR);
    fs.symlinkSync(link.caminhos.VERIFICADOR, link.caminhos.PUBLICADOR);
    assert.equal(await codigoDe(montar(opcoesDe(e, link))), 'LIGACAO_CREDENCIAL_INDISPONIVEL');
  });

  test('LIG-CLI-08 — SDK não aprovado (lança ou não é objeto) é recusado', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig08');
    const f = preparar();
    assert.equal(await codigoDe(montar(opcoesDe(e, f, { carregarSdk: () => { throw new Error('SDK-NAO-INSTALADO'); } }))), 'LIGACAO_SDK_NAO_APROVADO');
    for (const ruim of [undefined, null, 'sdk', [], 42]) assert.equal(await codigoDe(montar(opcoesDe(e, f, { carregarSdk: () => ruim }))), 'LIGACAO_SDK_NAO_APROVADO');
  });

  test('LIG-CLI-09 — colaboradores fora da forma: ausentes, sem auditoria, ou tentando trazer ligação, evidência, recibos ou relógio', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig09');
    const f = preparar();
    const sem = (...chaves) => Object.fromEntries(Object.entries(e.colaboradores).filter(([k]) => !chaves.includes(k)));
    assert.equal(await codigoDe(montar(opcoesDe(e, f, { colaboradores: undefined }))), 'LIGACAO_COLABORADORES_AUSENTES');
    for (const ruim of [null, [], 'x', {}, sem('auditoria'), { ...e.colaboradores, auditoria: {} }, { ...e.colaboradores, auditoria: { registrar: 1 } },
      { ...e.colaboradores, ligacao: {} }, { ...e.colaboradores, evidencia: { registrar: async () => {} } }, { ...e.colaboradores, recibos: { registrar: async () => {} } }, { ...e.colaboradores, relogio: () => 0 }]) {
      assert.equal(await codigoDe(montar(opcoesDe(e, f, { colaboradores: ruim }))), 'LIGACAO_COLABORADORES_INVALIDOS');
    }
  });

  test('LIG-CLI-10 — compositor recusa colaboradores incompletos ou com chave desconhecida', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig10');
    const f = preparar();
    const { producao, ...semProducao } = e.colaboradores;
    assert.equal(await codigoDe(montar(opcoesDe(e, f, { colaboradores: semProducao }))), 'LIGACAO_COMPOSITOR_INVALIDO');
    assert.equal(await codigoDe(montar(opcoesDe(e, f, { colaboradores: { ...e.colaboradores, intruso: 1 } }))), 'LIGACAO_COMPOSITOR_INVALIDO');
  });

  test('LIG-CLI-11 — configuração insegura, inválida ou com finalidade errada vira código LIGACAO_CONFIGURACAO_*', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig11');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar({ modoConfig: 0o644 })))), 'LIGACAO_CONFIGURACAO_ARQUIVO_INSEGURO');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar({ modoConfig: 0o400 })))), 'LIGACAO_CONFIGURACAO_ARQUIVO_INSEGURO');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar({ configExtra: { finalidade: 'OPERACAO' } })))), 'LIGACAO_CONFIGURACAO_FINALIDADE_NAO_AUTORIZADA');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar({ configExtra: { ambiente: 'PRODUCAO' } })))), 'LIGACAO_CONFIGURACAO_FINALIDADE_NAO_AUTORIZADA');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar({ configExtra: { extra: 1 } })))), 'LIGACAO_CONFIGURACAO_FORMA_INVALIDA');
    assert.equal(await codigoDe(montar(opcoesDe(e, { ambiente: { BACKUP_EXECUTOR_CONFIG: 'relativo.json' } }))), 'LIGACAO_CONFIGURACAO_CAMINHO_INVALIDO');
    assert.equal(await codigoDe(montar(opcoesDe(e, { ambiente: { BACKUP_EXECUTOR_CONFIG: path.join(novaRaiz(), 'nao-existe.json') } }))), 'LIGACAO_CONFIGURACAO_ARQUIVO_INDISPONIVEL');
    assert.equal(await codigoDe(montar(opcoesDe(e, preparar(), { uid: UID + 1 }))), 'LIGACAO_CONFIGURACAO_ARQUIVO_INSEGURO');
  });

  test('LIG-CLI-12 — todo erro da montagem leva só código fixo LIGACAO_*, mensagem fixa e nenhum valor, caminho ou segredo', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig12');
    const segredo = 'SWBTESTE-NAO-PODE-APARECER-NUNCA';
    const f = preparar({ ajustar: (p, o) => (p === 'PUBLICADOR' ? { ...o, secretAccessKey: segredo, accessKeyId: 'AKIAIOSFODNN7EXAMPLE' } : o) });
    const casos = [
      montar(opcoesDe(e, f)), montar(opcoesDe(e, preparar({ modoConfig: 0o644 }))), montar(opcoesDe(e, preparar(), { carregarSdk: () => { throw new Error(segredo); } })),
      montar(opcoesDe(e, preparar(), { colaboradores: undefined })), montar(opcoesDe(e, preparar(), { pedido: { modo: 'OPERACAO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO' } })),
    ];
    for (const caso of casos) {
      let erro;
      try { await caso; } catch (x) { erro = x; }
      assert.ok(erro, 'deveria recusar');
      assert.match(erro.code, /^LIGACAO_[A-Z0-9_]{3,80}$/);
      assert.equal(erro.message, 'ligação do CLI inválida');
      const texto = `${erro.message} ${erro.code} ${JSON.stringify(erro)}`;
      for (const proibido of [segredo, SEGREDO, 'AKIAIOSFODNN7EXAMPLE', f.raiz]) assert.ok(!texto.includes(proibido), `${erro.code} ecoou algo`);
    }
  });

  test('LIG-CLI-13 — opções fora da forma lançam TypeError (erro de programação)', async () => {
    const e = await ambienteDeEnsaio('conjunto-lig13');
    const f = preparar();
    const ok = opcoesDe(e, f);
    const ruins = [undefined, null, [], { ...ok, extra: 1 }, { ...ok, pedido: undefined }, { ...ok, pedido: { modo: 'ENSAIO', acao: 'BACKUP' } }, { ...ok, ambiente: null },
      { ...ok, relogio: 'x' }, { ...ok, carregarSdk: 'x' }, { ...ok, escreverRecibo: 'x' }];
    for (const ruim of ruins) await assert.rejects(montar(ruim), TypeError);
  });
});
