'use strict';
// Etapa 2B: o agente do backend é um módulo separado e inerte. Sem coordenação homologada o instalador recusa, e o agente
// só registra a recusa. Nenhuma falha dispara restauração ou reversão automática. S3 e âncora são falsos: nada toca a AWS.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../../..');
const AG = path.join(RAIZ, 'deploy/hml/cd/agente-backend.js');
const A = require(AG);
const P = require(path.join(RAIZ, 'deploy/hml/cd/protocolo'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const COMMIT = 'a'.repeat(40);
const ROTULO = `hml-20261119T120000-${COMMIT.slice(0, 7)}`;
const ID = '123-1';
const SISTEMA_DO_CLUSTER = '7412345678901234567';
let tmp;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hml-agb-')); });
// O instalador real deixa as releases somente leitura: devolve a escrita antes de apagar o diretório do teste.
function liberarEscrita(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { fs.chmodSync(abs, 0o700); liberarEscrita(abs); }
  }
}
afterEach(() => { liberarEscrita(tmp); fs.rmSync(tmp, { recursive: true, force: true }); });

const blobDe = () => Buffer.from(JSON.stringify([['release.json', Buffer.from('{}').toString('base64')]]));
function pedidoDe(extra = {}) {
  const agora = Date.now();
  return {
    versao: 2, escopo: 'backend', id: ID, repositorio: P.REPO, commit: COMMIT, rotulo: ROTULO, releaseSha256: 'b'.repeat(64),
    blobSha256: sha(blobDe()), permitirAnterior: false, criadoEm: new Date(agora - 1000).toISOString(), expiraEm: new Date(agora + 5 * 60000).toISOString(), ...extra,
  };
}
function s3Falso(chaves = {}) {
  const dados = new Map(Object.entries(chaves));
  const uso = [];
  const s3 = {
    dados, uso, falharPut: false,
    get: async (k) => { uso.push(['get', k]); return dados.has(k) ? dados.get(k) : null; },
    put: async (k, b) => { uso.push(['put', k]); if (s3.falharPut || dados.has(k)) throw new Error('S3_PUT_FALHOU'); dados.set(k, b); },
  };
  return s3;
}
function ancoraFalsa(armazem) {
  return () => ({
    abrirBase: (d) => ({ d }),
    criarExclusivo: (b, nome) => { if (armazem.has(`@${nome}`)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); armazem.set(`@${nome}`, true); return { nome }; },
    lerTexto: (b, nome) => (armazem.has(nome) ? armazem.get(nome) : null),
    escreverAtomico: (b, nome, texto) => { armazem.set(nome, texto); },
    identidade: (h) => h.nome, fechar: () => {}, removerArvore: (b, nome) => { armazem.delete(`@${nome}`); }, fecharTudo: () => {},
  });
}
const saudavel = (rotulo, commit) => ({ instalado: true, integro: true, consistente: true, garantiaContraCorrida: true, rotulo, commit });
const BASE = saudavel(`hml-20261118T090000-${'c'.repeat(7)}`, 'c'.repeat(40));
const ALVO = saudavel(ROTULO, COMMIT);
function depsDe({ instalar, antes = BASE, depois = ALVO } = {}) {
  const armazem = new Map();
  const chamadas = { instalar: 0, reverter: 0, identificar: 0 };
  return {
    armazem, chamadas,
    criarAncora: ancoraFalsa(armazem),
    vincular: () => ({ dir: '/baseline-do-teste', comando: ['/bin/false'] }),
    observar: async () => { chamadas.observar = (chamadas.observar || 0) + 1; return { banco: 'hml', origem: 'teste', coletadoEm: new Date().toISOString(), migrations: ['000_a'], contratos: {} }; },
    conferirRelease: () => ({ release: { commit: COMMIT, rotulo: ROTULO, atual: true } }),
    identificar: async () => { chamadas.identificar += 1; return chamadas.instalar > 0 ? depois : antes; },
    instalar: async (opcoes) => { chamadas.instalar += 1; return instalar(opcoes); },
    reverter: async () => { chamadas.reverter += 1; },
  };
}
const cfg = () => ({ estadoDir: tmp });
const erroCom = (codigo, extra = {}) => Object.assign(new Error(codigo), { codigo }, extra);
const INSTALADA = { resultado: 'INSTALADA', avisos: [] };
const reciboPublicado = (s3) => JSON.parse(s3.dados.get(`hml-backend/recibos/${ID}.json`).toString());
const registroLocal = (deps) => JSON.parse(deps.armazem.get(`${ID}.json`));
const comTrava = (deps) => deps.armazem.has('@.trava-cd-backend');
const preparar = (extraPedido) => { const p = pedidoDe(extraPedido); return { pedido: p, s3: s3Falso({ [`hml-backend/pedidos/${ID}.json`]: Buffer.from(JSON.stringify(p)), [`hml-backend/blobs/${ID}.json`]: blobDe() }) }; };

describe('configuração do agente do backend', () => {
  test('o modelo de configuração nasce desabilitado e o agente o recusa', () => {
    const modelo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd/agente.config.backend.exemplo.json'), 'utf8'));
    assert.equal(modelo.habilitado, false);
    assert.equal(modelo.isolamentoRevisado, 'PENDENTE');
    assert.equal(modelo.s3.prefixo, 'hml-backend');
    assert.deepEqual(Object.keys(modelo.instalador.componentes), ['backend']);
    assert.equal(modelo.instalador.componentes.backend.tipo, 'backend');
    assert.throws(() => A.validarConfiguracao(modelo), (e) => e.codigo === 'AGENTE_DESABILITADO');
  });

  test('recusa isolamento sem a revisão específica do backend, escopo errado, prefixo errado e falta de prova de versão', () => {
    const modelo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd/agente.config.backend.exemplo.json'), 'utf8'));
    const habilitada = { ...modelo, habilitado: true };
    assert.throws(() => A.validarConfiguracao({ ...habilitada, isolamentoRevisado: 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_SEM_INSTITUCIONAL' }), (e) => e.codigo === 'AGENTE_DESABILITADO');
    assert.throws(() => A.validarConfiguracao({ ...habilitada, isolamentoRevisado: 'PENDENTE' }), (e) => e.codigo === 'AGENTE_DESABILITADO');
  });
});

describe('processar: recusa sem coordenação homologada', () => {
  test('COORDENACAO_NAO_HOMOLOGADA vira recibo RECUSADO sem mutação, no prefixo hml-backend/ e com escopo backend', async () => {
    const { pedido, s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); } });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'RECUSADO');
    assert.equal(r.mutacao, 'NENHUMA');
    assert.equal(r.motivo, 'COORDENACAO_NAO_HOMOLOGADA');
    assert.equal(deps.chamadas.instalar, 1);
    assert.equal(deps.chamadas.reverter, 0);
    const recibo = JSON.parse(s3.dados.get(`hml-backend/recibos/${ID}.json`).toString());
    assert.equal(recibo.escopo, 'backend');
    assert.equal(recibo.commit, pedido.commit);
    assert.equal(recibo.releaseSha256, pedido.releaseSha256);
    assert.equal(recibo.estado, 'RECUSADO');
    assert.throws(() => P.validarRecibo(recibo, pedido), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
    assert.equal(deps.armazem.has('@.trava-cd-backend'), false, 'recusa comprovada libera a trava');
  });

  test('todas as chaves de S3 tocadas ficam em hml-backend/ e nada em hml/', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); } });
    await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.ok(s3.uso.length >= 3);
    for (const [, chave] of s3.uso) assert.match(chave, /^hml-backend\/(blobs|pedidos|recibos)\//, chave);
  });

  test('pedido do frontend (v1) ou de outro escopo é recusado antes de qualquer instalação', async () => {
    const v1 = pedidoDe();
    delete v1.escopo; v1.versao = 1;
    const s3 = s3Falso({ [`hml-backend/pedidos/${ID}.json`]: Buffer.from(JSON.stringify(v1)), [`hml-backend/blobs/${ID}.json`]: blobDe() });
    const deps = depsDe({ instalar: async () => ({}) });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'RECUSADO');
    assert.equal(r.mutacao, 'NENHUMA');
    assert.equal(r.motivo, 'ESCOPO_DIVERGENTE');
    assert.equal(deps.chamadas.instalar, 0);
    const front = preparar({ escopo: 'frontend' });
    const d2 = depsDe({ instalar: async () => ({}) });
    const r2 = await A.processar({ cfg: cfg(), id: ID, s3: front.s3, deps: d2 });
    assert.equal(r2.motivo, 'ESCOPO_DIVERGENTE');
    assert.equal(d2.chamadas.instalar, 0);
  });

  test('pedido expirado, blob divergente e pedido ausente são recusados sem instalar', async () => {
    const velho = pedidoDe({ criadoEm: new Date(Date.now() - 20 * 60000).toISOString(), expiraEm: new Date(Date.now() - 10 * 60000).toISOString() });
    const casos = [
      [s3Falso({ [`hml-backend/pedidos/${ID}.json`]: Buffer.from(JSON.stringify(velho)), [`hml-backend/blobs/${ID}.json`]: blobDe() }), 'PEDIDO_EXPIRADO'],
      [s3Falso({ [`hml-backend/pedidos/${ID}.json`]: Buffer.from(JSON.stringify(pedidoDe())), [`hml-backend/blobs/${ID}.json`]: Buffer.from('[]') }), 'BLOB_DIVERGENTE'],
      [s3Falso(), 'PEDIDO_AUSENTE'],
    ];
    for (const [s3, motivo] of casos) {
      const deps = depsDe({ instalar: async () => ({}) });
      const r = await A.processar({ cfg: { estadoDir: fs.mkdtempSync(path.join(tmp, 'e-')) }, id: ID, s3, deps });
      assert.equal(r.estado, 'RECUSADO', motivo);
      assert.equal(r.motivo, motivo);
      assert.equal(deps.chamadas.instalar, 0, motivo);
    }
  });
});

describe('processar: sucesso e falha', () => {
  test('sucesso exige a identidade instalada igual à release aprovada e gera recibo válido', async () => {
    const { pedido, s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'SUCESSO');
    assert.equal(r.verificado, true);
    const recibo = JSON.parse(s3.dados.get(`hml-backend/recibos/${ID}.json`).toString());
    assert.equal(P.validarRecibo(recibo, pedido).estado, 'SUCESSO');
  });

  test('instalação que "termina" com outra release instalada é crítica e não é revertida automaticamente', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA, depois: BASE });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'CRITICO');
    assert.equal(deps.chamadas.reverter, 0);
  });

  test('falha depois de iniciada a instalação: CRITICO, trava preservada, sem reversão nem restauração automáticas', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('REINICIO'); } });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'CRITICO');
    assert.equal(r.verificado, false);
    assert.equal(deps.chamadas.reverter, 0);
    assert.equal(deps.armazem.has('@.trava-cd-backend'), true, 'estado crítico preserva a trava');
    await assert.rejects(A.processar({ cfg: cfg(), id: ID, s3, deps }), (e) => e.codigo === 'TRAVA_OU_ESTADO_PENDENTE' || e.code === 'EEXIST');
  });

  test('um novo disparo do mesmo id depois de recusa devolve o mesmo resultado e não reinstala', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); } });
    await A.processar({ cfg: cfg(), id: ID, s3, deps });
    const r2 = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r2.estado, 'RECUSADO');
    assert.equal(deps.chamadas.instalar, 1);
  });
});

const ANTERIORES_A_MUTACAO = ['COORDENACAO_NAO_HOMOLOGADA', 'SAUDE_NAO_CONFIGURADA', 'REINICIO_NAO_CONFIGURADO', 'VERSAO_NAO_COMPROVAVEL'];
const rodar = async (instalar, opcoes = {}) => {
  const { s3 } = preparar();
  const deps = depsDe({ instalar, ...opcoes });
  const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
  return { r, s3, deps };
};

describe('M1: classificação conservadora das recusas', () => {
  for (const codigo of ANTERIORES_A_MUTACAO) {
    test(`${codigo}: recusa comprovadamente anterior à mutação (RECUSADO, trava liberada)`, async () => {
      const { r, deps } = await rodar(async () => { throw erroCom(codigo); });
      assert.equal(r.estado, 'RECUSADO');
      assert.equal(r.mutacao, 'NENHUMA');
      assert.equal(r.motivo, codigo);
      assert.equal(comTrava(deps), false);
      assert.equal(deps.chamadas.reverter, 0);
    });
  }

  for (const codigo of ['OPERACAO_EM_CURSO', 'COORDENACAO_NAO_CONFIRMADA', 'INCOMPATIVEL']) {
    test(`${codigo} depois de iniciada a instalação é estado incerto (CRITICO, trava preservada)`, async () => {
      const { r, s3, deps } = await rodar(async () => { throw erroCom(codigo); });
      assert.equal(r.estado, 'CRITICO');
      assert.equal(r.verificado, false);
      assert.equal(r.motivo, 'RESULTADO_INCERTO');
      assert.equal(r.diagnostico, codigo);
      assert.equal(r.mutacao, undefined);
      assert.equal(comTrava(deps), true);
      assert.equal(deps.chamadas.reverter, 0);
      assert.equal(reciboPublicado(s3).estado, 'CRITICO');
      assert.equal(registroLocal(deps).fase, 'TERMINAL');
    });
  }

  test('erro tratado de coordenação (link já trocado e desfeito) continua incerto, nunca recusa', async () => {
    const { r, deps } = await rodar(async () => { throw erroCom('OPERACAO_EM_CURSO', { tratado: true }); });
    assert.equal(r.estado, 'CRITICO');
    assert.equal(r.motivo, 'RESULTADO_INCERTO');
    assert.equal(comTrava(deps), true);
  });

  for (const codigo of ['FALHA_POS_REINICIO', 'FALHA_POS_TROCA', 'ESTADO_CRITICO']) {
    test(`${codigo}: falha crítica depois de alteração de release (CRITICO, trava preservada, sem reversão)`, async () => {
      const { r, deps } = await rodar(async () => { throw erroCom(codigo, { tratado: true, detalhes: { critico: true } }); });
      assert.equal(r.estado, 'CRITICO');
      assert.equal(r.motivo, 'FALHA_CRITICA_APOS_ALTERACAO');
      assert.equal(r.diagnostico, codigo);
      assert.equal(comTrava(deps), true);
      assert.equal(deps.chamadas.reverter, 0);
    });
  }

  test('detalhes.critico=true com código desconhecido também é falha crítica', async () => {
    const { r } = await rodar(async () => { throw erroCom('CODIGO_NOVO', { detalhes: { critico: true } }); });
    assert.equal(r.motivo, 'FALHA_CRITICA_APOS_ALTERACAO');
    assert.equal(r.diagnostico, 'CODIGO_NOVO');
  });

  test('erro sem código depois de iniciada a instalação é incerto, com diagnóstico genérico', async () => {
    const { r, deps } = await rodar(async () => { throw new Error('qualquer'); });
    assert.equal(r.estado, 'CRITICO');
    assert.equal(r.motivo, 'RESULTADO_INCERTO');
    assert.equal(r.diagnostico, 'ERRO');
    assert.equal(comTrava(deps), true);
  });

  test('o diagnóstico leva só o código: nunca a mensagem do erro', async () => {
    const { r, s3 } = await rodar(async () => { throw erroCom('REINICIO', { message: 'caminho /segredo/interno' }); });
    assert.doesNotMatch(JSON.stringify(r), /segredo/);
    assert.doesNotMatch(s3.dados.get(`hml-backend/recibos/${ID}.json`).toString(), /segredo/);
  });

  test('RECUSAS_SEM_MUTACAO contém exatamente os quatro códigos de ponto único', () => {
    const m = /RECUSAS_SEM_MUTACAO = new Set\(\[([^\]]*)\]\)/.exec(fs.readFileSync(AG, 'utf8'));
    assert.ok(m, 'declaração de RECUSAS_SEM_MUTACAO não encontrada');
    assert.deepEqual([...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort(), [...ANTERIORES_A_MUTACAO].sort());
  });
});

describe('N1: o resultado do instalador decide o sucesso', () => {
  for (const resultado of ['INSTALADA', 'JA_INSTALADA', 'CONFIRMADA']) {
    test(`${resultado} com a identidade da release aprovada é SUCESSO`, async () => {
      const { r, s3, deps } = await rodar(async () => ({ resultado, avisos: [] }), resultado === 'JA_INSTALADA' ? { antes: ALVO } : {});
      assert.equal(r.estado, 'SUCESSO');
      assert.equal(r.verificado, true);
      assert.equal(reciboPublicado(s3).estado, 'SUCESSO');
      assert.equal(comTrava(deps), false);
    });
  }

  for (const codigo of ['ESTADO_NAO_ATUALIZADO', 'DURABILIDADE_NAO_GARANTIDA']) {
    test(`aviso ${codigo}: não declara SUCESSO e preserva a trava`, async () => {
      const { r, s3, deps } = await rodar(async () => ({ resultado: 'INSTALADA', avisos: [{ codigo, mensagem: 'x' }] }));
      assert.equal(r.estado, 'CRITICO');
      assert.equal(r.verificado, false);
      assert.equal(r.motivo, 'SUCESSO_SEM_REGISTRO_DURAVEL');
      assert.equal(comTrava(deps), true);
      assert.equal(deps.chamadas.reverter, 0);
      assert.equal(reciboPublicado(s3).estado, 'CRITICO');
    });
  }

  test('RETENCAO_FALHOU é só aviso: a release foi comprovada e o resultado segue SUCESSO', async () => {
    const { r } = await rodar(async () => ({ resultado: 'INSTALADA', avisos: [{ codigo: 'RETENCAO_FALHOU', mensagem: 'x' }] }));
    assert.equal(r.estado, 'SUCESSO');
  });

  for (const [nome, valor] of [['REVERTIDA', { resultado: 'REVERTIDA' }], ['objeto vazio', {}], ['nulo', null], ['texto', 'ok'], ['resultado desconhecido', { resultado: 'TALVEZ' }]]) {
    test(`resultado não reconhecido (${nome}) é CRITICO com trava preservada`, async () => {
      const { r, deps } = await rodar(async () => valor);
      assert.equal(r.estado, 'CRITICO');
      assert.equal(r.motivo, 'RESULTADO_NAO_RECONHECIDO');
      assert.equal(comTrava(deps), true);
      assert.equal(deps.chamadas.reverter, 0);
    });
  }

  test('avisos ausentes ou malformados no retorno não quebram o reconhecimento', async () => {
    const { r } = await rodar(async () => ({ resultado: 'INSTALADA' }));
    assert.equal(r.estado, 'SUCESSO');
  });
});

describe('idempotência, recibos e preservação da trava', () => {
  test('reenvio depois de SUCESSO devolve SUCESSO sem reinstalar e sem trava', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA });
    await A.processar({ cfg: cfg(), id: ID, s3, deps });
    const r2 = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r2.estado, 'SUCESSO');
    assert.equal(deps.chamadas.instalar, 1);
    assert.equal(comTrava(deps), false);
  });

  test('RECIBO_DIVERGENTE: recibo diferente já publicado vira CRITICO local e preserva a trava', async () => {
    const { s3 } = preparar();
    s3.dados.set(`hml-backend/recibos/${ID}.json`, Buffer.from(JSON.stringify({ id: ID, estado: 'SUCESSO' })));
    const deps = depsDe({ instalar: async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); } });
    await assert.rejects(A.processar({ cfg: cfg(), id: ID, s3, deps }), (e) => e.codigo === 'RECIBO_DIVERGENTE');
    assert.equal(comTrava(deps), true);
    const reg = registroLocal(deps);
    assert.equal(reg.fase, 'TERMINAL');
    assert.equal(reg.resultado.estado, 'CRITICO');
    assert.equal(reg.resultado.motivo, 'RECIBO_DIVERGENTE');
    assert.equal(s3.dados.get(`hml-backend/recibos/${ID}.json`).toString().includes('SUCESSO'), true, 'o recibo existente não é sobrescrito');
  });

  test('ENTRADA_PREEXISTENTE: sobra de execução anterior é estado incerto, sem chamar o instalador', async () => {
    const { s3 } = preparar();
    fs.mkdirSync(path.join(tmp, `entrada-${ID}`));
    const deps = depsDe({ instalar: async () => INSTALADA });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'CRITICO');
    assert.equal(r.motivo, 'RESULTADO_INCERTO');
    assert.equal(r.diagnostico, 'ENTRADA_PREEXISTENTE');
    assert.equal(deps.chamadas.instalar, 0);
    assert.equal(comTrava(deps), true);
  });

  test('registro local não terminal (queda no meio da operação) bloqueia novo processamento e preserva a trava', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA });
    deps.armazem.set(`${ID}.json`, JSON.stringify({ versao: 2, id: ID, fase: 'INSTALACAO_INICIADA', pedido: null }));
    await assert.rejects(A.processar({ cfg: cfg(), id: ID, s3, deps }), (e) => e.codigo === 'OPERACAO_PENDENTE_OU_CRITICA');
    assert.equal(deps.chamadas.instalar, 0);
    assert.equal(comTrava(deps), true);
  });

  test('registro terminal CRITICO bloqueia novo processamento e preserva a trava', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('REINICIO'); } });
    await A.processar({ cfg: cfg(), id: ID, s3, deps });
    deps.armazem.delete('@.trava-cd-backend');
    await assert.rejects(A.processar({ cfg: cfg(), id: ID, s3, deps }), (e) => e.codigo === 'OPERACAO_PENDENTE_OU_CRITICA');
    assert.equal(deps.chamadas.instalar, 1);
    assert.equal(comTrava(deps), true);
  });

  test('recibo pendente (S3 indisponível): a trava é liberada e o novo disparo republica o recibo sem reinstalar', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); } });
    s3.falharPut = true;
    const r1 = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r1.estado, 'RECUSADO');
    assert.equal(r1.reciboPendente, true);
    assert.equal(s3.dados.has(`hml-backend/recibos/${ID}.json`), false);
    assert.equal(comTrava(deps), false);
    s3.falharPut = false;
    const r2 = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r2.estado, 'RECUSADO');
    assert.equal(r2.reciboPendente, undefined);
    assert.equal(reciboPublicado(s3).estado, 'RECUSADO');
    assert.equal(deps.chamadas.instalar, 1);
  });

  test('trava ocupada por outra operação: nada é lido nem instalado', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA });
    deps.armazem.set('@.trava-cd-backend', true);
    await assert.rejects(A.processar({ cfg: cfg(), id: ID, s3, deps }), (e) => e.code === 'EEXIST');
    assert.equal(deps.chamadas.instalar, 0);
    assert.equal(s3.uso.length, 0);
  });
});

function configValida() {
  const raiz = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  const mk = (n) => { const p = path.join(raiz, n); fs.mkdirSync(p); return p; };
  const estadoDir = mk('estado'), base = mk('base'), protegida = mk('protegida');
  return {
    habilitado: true, isolamentoRevisado: 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND', estadoDir, raizesProtegidas: [protegida],
    s3: { bucket: 'hml-exemplo-teste', conta: '111111111111', regiao: 'us-east-1', executavel: '/usr/local/bin/aws', prefixo: 'hml-backend' },
    sonda: { comando: [process.execPath, 'scripts/sonda-estado-observado.js'], credencial: path.join(raiz, 'credencial-da-sonda.json'), banco: 'hml', sistema: SISTEMA_DO_CLUSTER },
    instalador: {
      retencao: 5, raizesPersistentes: [],
      componentes: {
        backend: {
          tipo: 'backend', base, nome: 'backend',
          dependencias: { comando: ['/usr/bin/npm', 'ci', '--omit=dev', '--ignore-scripts'] },
          saude: { url: 'http://127.0.0.1:3330/api/health' },
          reinicio: { comando: ['/bin/systemctl', '--user', 'restart', 'servico'] },
          processo: { pidComando: ['/bin/systemctl', '--user', 'show', '--property=MainPID', '--value', 'servico'] },
        },
      },
    },
  };
}
const clonarJson = (o) => JSON.parse(JSON.stringify(o));
const recusaConfig = (c, codigo) => assert.throws(() => A.validarConfiguracao(c), (e) => e.codigo === codigo, codigo);

describe('validarConfiguracao: configuração habilitada', () => {
  test('uma configuração habilitada, com isolamento revisado e raízes separadas, é aceita', () => {
    const c = configValida();
    assert.equal(A.validarConfiguracao(c), c);
  });
  test('base sobre raiz protegida, ou estado sobre a base, é recusado', () => {
    const c = configValida();
    c.raizesProtegidas = [c.instalador.componentes.backend.base];
    recusaConfig(c, 'RAIZ_PROTEGIDA');
    const d = configValida();
    d.estadoDir = d.instalador.componentes.backend.base;
    recusaConfig(d, 'RAIZ_PROTEGIDA');
  });
  test('componente extra, prefixo do frontend e falta de prova de versão são recusados', () => {
    const extra = configValida();
    const base2 = fs.mkdtempSync(path.join(tmp, 'base2-'));
    extra.instalador.componentes.outro = { ...clonarJson(extra.instalador.componentes.backend), base: base2, nome: 'outro' };
    recusaConfig(extra, 'ESCOPO_INVALIDO');
    const prefixo = configValida();
    prefixo.s3.prefixo = 'hml';
    recusaConfig(prefixo, 'S3_PREFIXO_INVALIDO');
    for (const campo of ['saude', 'reinicio', 'processo']) {
      const c = configValida();
      delete c.instalador.componentes.backend[campo];
      recusaConfig(c, 'VERSAO_NAO_COMPROVAVEL');
    }
  });
  test('raízes protegidas ausentes, vazias ou relativas são recusadas', () => {
    for (const valor of [undefined, [], ['relativo/caminho']]) {
      const c = configValida();
      c.raizesProtegidas = valor;
      recusaConfig(c, 'RAIZES_PROTEGIDAS_OBRIGATORIAS');
    }
  });
});

const s3Com = (...ids) => s3Falso(Object.fromEntries(ids.flatMap((id) => [
  [`hml-backend/pedidos/${id}.json`, Buffer.from(JSON.stringify(pedidoDe({ id })))],
  [`hml-backend/blobs/${id}.json`, blobDe()],
])));
const reciboDe = (id, extra) => Buffer.from(JSON.stringify({ id, escopo: 'backend', ...extra }));

describe('processarFila', () => {
  test('pula pedidos que já têm recibo SUCESSO ou RECUSADO do backend, sem instalar', async () => {
    const s3 = s3Falso({ 'hml-backend/recibos/123-1.json': reciboDe('123-1', { estado: 'SUCESSO' }), 'hml-backend/recibos/124-1.json': reciboDe('124-1', { estado: 'RECUSADO' }) });
    const deps = depsDe({ instalar: async () => INSTALADA });
    assert.deepEqual(await A.processarFila({ cfg: cfg(), ids: ['123-1', '124-1'], s3, deps }), { ok: true });
    assert.equal(deps.chamadas.instalar, 0);
  });
  test('recibo CRITICO, de outro escopo ou de outro id para a mesma chave bloqueia a fila', async () => {
    for (const recibo of [reciboDe('123-1', { estado: 'CRITICO' }), Buffer.from(JSON.stringify({ id: '123-1', escopo: 'frontend', estado: 'SUCESSO' })), reciboDe('999-9', { estado: 'SUCESSO' })]) {
      const deps = depsDe({ instalar: async () => INSTALADA });
      await assert.rejects(A.processarFila({ cfg: cfg(), ids: ['123-1'], s3: s3Falso({ 'hml-backend/recibos/123-1.json': recibo }), deps }), (e) => e.codigo === 'RECIBO_INVALIDO_OU_CRITICO');
      assert.equal(deps.chamadas.instalar, 0);
    }
  });
  test('id fora do formato é recusado antes de qualquer leitura', async () => {
    const s3 = s3Falso();
    await assert.rejects(A.processarFila({ cfg: cfg(), ids: ['../x'], s3, deps: depsDe({ instalar: async () => INSTALADA }) }), (e) => e.codigo === 'ID_INVALIDO');
    assert.equal(s3.uso.length, 0);
  });
  test('um pedido que termina CRITICO interrompe a fila: os seguintes não são processados', async () => {
    const s3 = s3Com('123-1', '124-1');
    const deps = depsDe({ instalar: async () => { throw erroCom('REINICIO'); } });
    await assert.rejects(A.processarFila({ cfg: cfg(), ids: ['123-1', '124-1'], s3, deps }), (e) => e.codigo === 'OPERACAO_CRITICA');
    assert.equal(deps.chamadas.instalar, 1);
    assert.equal(s3.dados.has('hml-backend/recibos/124-1.json'), false);
  });
  test('recusas comprovadas não interrompem a fila, mas ela termina com ok=false', async () => {
    const s3 = s3Com('123-1', '124-1');
    const deps = depsDe({ instalar: async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); } });
    assert.deepEqual(await A.processarFila({ cfg: cfg(), ids: ['123-1', '124-1'], s3, deps }), { ok: false });
    assert.equal(deps.chamadas.instalar, 2);
    assert.equal(JSON.parse(s3.dados.get('hml-backend/recibos/124-1.json').toString()).estado, 'RECUSADO');
  });
});

describe('principal', () => {
  test('qualquer forma de uso fora de --config <arq> (--pedido <id> | --pendentes) é recusada com USO', async () => {
    for (const argv of [[], ['--config'], ['--config', '/x'], ['--config', '/x', '--pedido'], ['--config', '/x', '--pendentes', 'extra'], ['--config', '/x', '--pedido', '1-1', 'extra'], ['--pedido', '1-1'], ['--config', '/x', '--outro']]) {
      await assert.rejects(A.principal(argv), (e) => e.codigo === 'USO', JSON.stringify(argv));
    }
  });
  test('fora do Linux recusa com LINUX_OBRIGATORIO; no Linux um arquivo de configuração inexistente também é recusado', async () => {
    await assert.rejects(A.principal(['--config', path.join(tmp, 'nao-existe.json'), '--pendentes']), (e) => (process.platform === 'linux' ? true : e.codigo === 'LINUX_OBRIGATORIO'));
  });
});

describe('instalador real: as recusas de ponto único acontecem antes de qualquer efeito em disco', () => {
  const RAIZ_I = path.join(RAIZ, 'deploy/hml/instalador');
  const fonte = fs.readFileSync(path.join(RAIZ_I, 'instalar-release.js'), 'utf8');

  test('cada um dos quatro códigos é lançado em um único ponto, antes da âncora em instalar()', () => {
    for (const codigo of ANTERIORES_A_MUTACAO) {
      assert.equal((fonte.match(new RegExp(`erro\\('${codigo}'`, 'g')) || []).length, 1, `${codigo}: ponto único`);
    }
    const ini = fonte.indexOf('async function instalar({');
    const iCoord = fonte.indexOf("exigirCoordenacaoHomologada(comp, deps, 'instalar')", ini);
    const iDeps = fonte.indexOf('exigirDeps(comp, deps, opcoes)', ini);
    const iAncora = fonte.indexOf('criarAncoraDaOperacao(deps, opcoes)', ini);
    assert.ok(ini > 0 && iCoord > ini && iCoord < iDeps && iDeps < iAncora, 'ordem das guardas em instalar()');
  });

  test('sem coordenação homologada o instalador real recusa o backend sem criar nada, mesmo com atestado', async () => {
    const I = require(path.join(RAIZ_I, 'instalar-release'));
    const config = configValida().instalador;
    const base = config.componentes.backend.base;
    for (const opcoes of [{}, { atestarSemOperacao: true, semComprovacaoDeVersao: true }]) {
      await assert.rejects(I.instalar({ config, componente: 'backend', release: tmp, opcoes }), (e) => e.codigo === 'COORDENACAO_NAO_HOMOLOGADA');
    }
    assert.deepEqual(fs.readdirSync(base), []);
  });

  test('com um provedor de teste, SAUDE, REINICIO e VERSAO recusam sem criar nada', async () => {
    const C = require(path.join(RAIZ_I, 'coordenacao'));
    const I = require(path.join(RAIZ_I, 'instalar-release'));
    const antes = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const consultarCoordenacao = C.homologarProvedorParaTeste(async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date().toISOString() }));
      const config = configValida().instalador;
      const base = config.componentes.backend.base;
      const casos = [
        [{ consultarCoordenacao }, 'SAUDE_NAO_CONFIGURADA'],
        [{ consultarCoordenacao, verificarSaude: async () => ({ ok: true }) }, 'REINICIO_NAO_CONFIGURADO'],
        [{ consultarCoordenacao, verificarSaude: async () => ({ ok: true }), reiniciar: async () => {} }, 'VERSAO_NAO_COMPROVAVEL'],
      ];
      for (const [deps, codigo] of casos) {
        await assert.rejects(I.instalar({ config, componente: 'backend', release: tmp, opcoes: {}, deps }), (e) => e.codigo === codigo, codigo);
        assert.deepEqual(fs.readdirSync(base), [], `${codigo}: nada criado`);
      }
    } finally {
      if (antes === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = antes;
    }
  });
});

describe('Etapa 3B-1: o agente entrega ao instalador real as dependências da configuração', () => {
  const INST = path.join(RAIZ, 'deploy/hml/instalador');
  const I = require(path.join(INST, 'instalar-release'));
  const C = require(path.join(INST, 'coordenacao'));
  // Âncora por caminho, a mesma dos testes do instalador: roda fora do Linux, sem a garantia contra corrida.
  const ancoraPorCaminho = (op) => require(path.join(INST, 'ancora')).criarAncora({ ...op, modo: 'caminho', semGarantiaDeCorrida: true });
  const rot = (n) => `hml-20261104T1${n}0000-${String(n).repeat(7)}`;
  const commitDe = (n) => String(n).repeat(40);
  let nodeEnvAntes;
  beforeEach(() => { nodeEnvAntes = process.env.NODE_ENV; process.env.NODE_ENV = 'test'; });
  afterEach(() => { if (nodeEnvAntes === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnvAntes; });

  function criarReleaseBackend(n, sondaDaRelease = `// sonda da release ${n}\n`) {
    const dir = fs.mkdtempSync(path.join(tmp, `rel${n}-`));
    const lock = '{"lockfileVersion":3}';
    const migration = '-- 000_a.sql\n';
    const arquivos = {
      'package.json': '{"engines":{"node":">=22"}}', 'package-lock.json': lock, 'src/server.js': `// v${n}\n`, 'scripts/sonda-estado-observado.js': sondaDaRelease, 'migrations/000_a.sql': migration,
      'migrations/checksums.json': JSON.stringify({ algoritmo: 'sha256', migrations: { '000_a.sql': sha(migration) } }),
    };
    const manifesto = {};
    for (const [rel, c] of Object.entries(arquivos)) {
      fs.mkdirSync(path.dirname(path.join(dir, 'backend', rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, 'backend', rel), c);
      manifesto[rel] = sha(c);
    }
    const texto = `${Object.keys(manifesto).sort().map((rel) => `${manifesto[rel]}  ${rel}`).join('\n')}\n`;
    fs.writeFileSync(path.join(dir, 'manifesto-backend.sha256'), texto);
    const release = { commit: commitDe(n), rotulo: rot(n), atual: true, geradoEm: '2026-11-04T10:00:00.000Z', backend: { arquivos: Object.keys(manifesto).length, manifestoSha256: sha(texto), lockfileSha256: sha(lock), node: '>=22', migrations: [{ nome: '000_a.sql', sha256: sha(migration) }], contratos: {} } };
    fs.writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
    return dir;
  }
  const arquivosDe = (dir, prefixo = '') => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en')).flatMap((e) => (e.isDirectory() ? arquivosDe(path.join(dir, e.name), `${prefixo}${e.name}/`) : [`${prefixo}${e.name}`]));
  const blobDoDiretorio = (dir) => Buffer.from(JSON.stringify(arquivosDe(dir).map((nome) => [nome, fs.readFileSync(path.join(dir, nome)).toString('base64')])));

  // Ambiente com a release 1 já instalada pelo instalador real e um pedido aprovado para a release 2.
  // Com sondaReal, cada release leva um roteiro de sonda de verdade (sem banco): ele registra num diário qual release
  // o executou e devolve o "estado" lido de um arquivo. Nada intercepta a chamada: quem executa é o executor real do
  // instalador (depsDoConfig), e a configuração não declara instalação de dependências para não haver npm no teste.
  async function ambiente({ reinicioSai = 0, sondaReal = false } = {}) {
    const raiz = fs.mkdtempSync(path.join(fs.realpathSync(tmp), 'amb-'));
    const diarioDaSonda = path.join(raiz, 'execucoes-da-sonda.ndjson');
    const estadoDoBanco = path.join(raiz, 'estado-do-banco.json');
    fs.writeFileSync(estadoDoBanco, JSON.stringify({ banco: 'hml', sistema: SISTEMA_DO_CLUSTER, migrations: ['000_a'] }));
    const roteiroReal = (n) => (sondaReal ? [
      "'use strict';",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(diarioDaSonda)}, JSON.stringify({ marcador: 'release-${n}', pid: process.pid, roteiro: __filename, cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');`,
      `process.stdout.write(fs.readFileSync(${JSON.stringify(estadoDoBanco)}, 'utf8'));`,
      '',
    ].join('\n') : undefined);
    const execucoesReais = () => (fs.existsSync(diarioDaSonda) ? fs.readFileSync(diarioDaSonda, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    const mk = (n) => { const p = path.join(raiz, n); fs.mkdirSync(p); return p; };
    const app = mk('app'), estadoDir = mk('estado'), protegida = mk('protegida');
    const registro = path.join(raiz, 'reinicios.log');
    const roteiro = path.join(raiz, 'reiniciar.js');
    const ambienteDoReinicio = path.join(raiz, 'ambiente-do-reinicio.json');
    fs.writeFileSync(roteiro, `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(registro)}, 'reinicio\\n'); fs.writeFileSync(${JSON.stringify(ambienteDoReinicio)}, JSON.stringify({ env: process.env, argv: process.argv })); process.exit(${reinicioSai});\n`);
    const cfgAgente = {
      habilitado: true, isolamentoRevisado: 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND', estadoDir, raizesProtegidas: [protegida],
      s3: { bucket: 'hml-exemplo-teste', conta: '111111111111', regiao: 'us-east-1', executavel: '/usr/local/bin/aws', prefixo: 'hml-backend' },
      sonda: { comando: [process.execPath, 'scripts/sonda-estado-observado.js'], credencial: path.join(raiz, 'credencial-da-sonda.json'), banco: 'hml', sistema: SISTEMA_DO_CLUSTER, timeoutMs: sondaReal ? 30000 : 1000 },
      instalador: {
        retencao: 3, raizesPersistentes: [],
        componentes: { backend: {
          tipo: 'backend', base: app, nome: 'backend',
          ...(sondaReal ? {} : { dependencias: { comando: ['/usr/bin/npm', 'ci', '--omit=dev', '--ignore-scripts'] } }),
          saude: { url: 'http://127.0.0.1:3330/api/health' },
          reinicio: { comando: [process.execPath, roteiro] },
          processo: { pidComando: [process.execPath, '-e', 'console.log(process.pid)'] },
        } },
      },
    };
    A.validarConfiguracao(cfgAgente);
    const link = path.join(app, 'backend');
    const provedor = C.homologarProvedorParaTeste(async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date().toISOString() }));
    let pid = 100;
    const chamadas = { saude: 0, processo: 0, dependencias: 0 };
    // Controlado pelo teste: âncora por caminho, npm ci simulado, estado do banco, health e PID. O reinício NÃO é
    // controlado: vem da configuração, por depsDoConfig, e deixa rastro no arquivo de registro.
    // A sonda é um comando da configuração: o teste responde por ele (sem banco) e conta as coletas.
    const sonda = { chamadas: 0, cwds: [], argumentos: [], responder: () => JSON.stringify({ banco: 'hml', papel: 'sonda_leitura', schema: 'public', sistema: SISTEMA_DO_CLUSTER, migrations: ['000_a'] }) };
    const controladas = {
      criarAncora: ancoraPorCaminho,
      executar: async (cmd, args, opc) => {
        if (args.some((a) => a.endsWith('scripts/sonda-estado-observado.js'))) { sonda.chamadas += 1; sonda.cwds.push(opc.cwd); sonda.argumentos.push([cmd, ...args]); return sonda.responder(sonda.chamadas); }
        chamadas.dependencias += 1; fs.mkdirSync(path.join(opc.cwd, 'node_modules', 'zod'), { recursive: true }); fs.writeFileSync(path.join(opc.cwd, 'node_modules', 'zod', 'index.js'), '1');
        return '';
      },
      verificarSaude: async () => { chamadas.saude += 1; return { ok: true, detalhe: 'ok' }; },
      identificarProcesso: async () => { chamadas.processo += 1; pid += 1; return { pid, cwd: fs.realpathSync(link) }; },
    };
    if (sondaReal) delete controladas.executar;
    const r1 = criarReleaseBackend(1, roteiroReal(1));
    await I.instalar({ config: cfgAgente.instalador, componente: 'backend', release: r1, opcoes: { releaseSha256Esperado: sha(fs.readFileSync(path.join(r1, 'release.json'))) }, deps: { ...controladas, lerObservado: async () => ({ banco: 'hml', origem: 'preparo-do-teste', coletadoEm: new Date().toISOString(), migrations: ['000_a'], contratos: {} }), reiniciar: async () => {}, consultarCoordenacao: provedor } });
    sonda.chamadas = 0; sonda.cwds.length = 0;
    Object.assign(chamadas, { saude: 0, processo: 0, dependencias: 0 });
    const r2 = criarReleaseBackend(2, roteiroReal(2));
    const blob = blobDoDiretorio(r2);
    const agora = Date.now();
    const pedido = { versao: 2, escopo: 'backend', id: ID, repositorio: P.REPO, commit: commitDe(2), rotulo: rot(2), releaseSha256: sha(fs.readFileSync(path.join(r2, 'release.json'))), blobSha256: sha(blob), permitirAnterior: false, criadoEm: new Date(agora - 1000).toISOString(), expiraEm: new Date(agora + 5 * 60000).toISOString() };
    const s3 = s3Falso({ [`hml-backend/pedidos/${ID}.json`]: Buffer.from(JSON.stringify(pedido)), [`hml-backend/blobs/${ID}.json`]: blob });
    const armazem = new Map();
    const identificar = async () => ({ ...(await I.identificar({ config: cfgAgente.instalador, componente: 'backend', deps: { criarAncora: ancoraPorCaminho } })), garantiaContraCorrida: true });
    const depsDoAgente = (extras) => ({ criarAncora: ancoraFalsa(armazem), conferirRelease: () => ({ release: { commit: commitDe(2), rotulo: rot(2), atual: true } }), identificar, depsExtrasDoInstalador: extras });
    const instalada = async () => (await identificar()).rotulo;
    const reinicios = () => (fs.existsSync(registro) ? fs.readFileSync(registro, 'utf8').split('\n').filter(Boolean).length : 0);
    return { cfgAgente, s3, armazem, controladas, provedor, depsDoAgente, instalada, reinicios, chamadas, pedido, sonda, link, ambienteDoReinicio, raiz, app, fisica: (n) => path.join(app, '.releases', 'backend', rot(n)), execucoesReais, estadoDoBanco, diarioDaSonda };
  }
  const reciboDoBackend = (s3) => JSON.parse(s3.dados.get(`hml-backend/recibos/${ID}.json`).toString());

  test('com coordenação de teste, o instalador real troca a release usando reinício, health e prova de processo', async () => {
    const amb = await ambiente();
    assert.equal(await amb.instalada(), rot(1));
    const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: amb.provedor }) });
    assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
    assert.equal(r.verificado, true);
    assert.equal(await amb.instalada(), rot(2));
    assert.equal(amb.reinicios(), 1, 'o comando de reinício da configuração foi executado uma vez');
    assert.ok(amb.chamadas.saude >= 1 && amb.chamadas.processo >= 1 && amb.chamadas.dependencias === 1);
    assert.equal(P.validarRecibo(reciboDoBackend(amb.s3), amb.pedido).estado, 'SUCESSO');
    assert.equal(amb.armazem.has('@.trava-cd-backend'), false);
  });

  test('sem provedor homologado, a mesma operação continua recusada com COORDENACAO_NAO_HOMOLOGADA e nada muda', async () => {
    const amb = await ambiente();
    for (const extras of [amb.controladas, { ...amb.controladas, consultarCoordenacao: async () => ({ situacao: 'LIVRE', origem: 'não homologado', consultadoEm: new Date().toISOString() }) }]) {
      const s3 = s3Falso(Object.fromEntries([...amb.s3.dados].filter(([k]) => !k.includes('/recibos/'))));
      const armazem = new Map();
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3, deps: { ...amb.depsDoAgente(extras), criarAncora: ancoraFalsa(armazem) } });
      assert.equal(r.estado, 'RECUSADO');
      assert.equal(r.mutacao, 'NENHUMA');
      assert.equal(r.motivo, 'COORDENACAO_NAO_HOMOLOGADA');
      assert.equal(armazem.has('@.trava-cd-backend'), false);
      fs.rmSync(path.join(amb.cfgAgente.estadoDir, `entrada-${ID}`), { recursive: true, force: true });
    }
    assert.equal(await amb.instalada(), rot(1));
    assert.equal(amb.reinicios(), 0);
  });

  const falhas = [
    ['o comando de reinício da configuração falha', async () => ({ amb: await ambiente({ reinicioSai: 1 }), extras: {} })],
    ['o health reprova', async () => ({ amb: await ambiente(), extras: { verificarSaude: async () => ({ ok: false, detalhe: 'HTTP 503' }) } })],
    ['o processo em execução não usa a release nova', async () => ({ amb: await ambiente(), extras: { identificarProcesso: async () => ({ pid: 999, cwd: os.tmpdir() }) } })],
    ['a identificação do processo falha', async () => ({ amb: await ambiente(), extras: { identificarProcesso: async () => { throw new Error('sem PID'); } } })],
  ];
  for (const [nome, preparar] of falhas) {
    test(`recusa segura quando ${nome}: nunca SUCESSO, trava preservada, sem recibo de sucesso`, async () => {
      const { amb, extras } = await preparar();
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: amb.provedor, ...extras }) });
      assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
      assert.equal(r.verificado, false);
      assert.ok(['FALHA_CRITICA_APOS_ALTERACAO', 'RESULTADO_INCERTO'].includes(r.motivo), r.motivo);
      assert.equal(amb.armazem.has('@.trava-cd-backend'), true, 'a trava do agente fica preservada');
      assert.equal(reciboDoBackend(amb.s3).estado, 'CRITICO');
      assert.throws(() => P.validarRecibo(reciboDoBackend(amb.s3), amb.pedido), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
    });
  }

  test('o agente não fabrica coordenação: só repassa o que depsDoConfig monta, mais a leitura da sonda', () => {
    const fonte = fs.readFileSync(AG, 'utf8');
    assert.match(fonte, /I\.depsDoConfig\(/);
    assert.match(fonte, /lerObservado/);
    assert.doesNotMatch(fonte, /situacao|LIVRE/);
  });

  describe('estado observado pela sonda', () => {
    const comCoordenacao = (amb) => amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: amb.provedor });

    test('o estado chega ao instalador pela sonda: coletado antes da instalação e de novo a cada pré-condição, na release instalada', async () => {
      const amb = await ambiente();
      const instaladaAntes = fs.realpathSync(amb.link);
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
      assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
      assert.ok(amb.sonda.chamadas >= 3, `coletas: ${amb.sonda.chamadas}`);
      assert.equal(amb.sonda.cwds[0], instaladaAntes, 'a pré-checagem roda a sonda da release já instalada');
      assert.equal(await amb.instalada(), rot(2));
    });

    const falhasIniciais = [
      ['o comando da sonda falha', () => { throw new Error('sonda recusou: SONDA_CONEXAO'); }, 'ESTADO_OBSERVADO_INDISPONIVEL'],
      ['a saída não é JSON', () => 'não é json', 'ESTADO_OBSERVADO_INDISPONIVEL'],
      ['a saída é JSON fora do contrato', () => JSON.stringify({ banco: 'hml', sistema: SISTEMA_DO_CLUSTER, migrations: 'x' }), 'ESTADO_OBSERVADO_INDISPONIVEL'],
      ['a lista de migrations vem vazia', () => JSON.stringify({ banco: 'hml', sistema: SISTEMA_DO_CLUSTER, migrations: [] }), 'ESTADO_OBSERVADO_INDISPONIVEL'],
      ['há nome repetido ou inválido', () => JSON.stringify({ banco: 'hml', sistema: SISTEMA_DO_CLUSTER, migrations: ['000_a', '000_a'] }), 'ESTADO_OBSERVADO_INDISPONIVEL'],
      ['o banco não é o da configuração', () => JSON.stringify({ banco: 'homolog_local', sistema: SISTEMA_DO_CLUSTER, migrations: ['000_a'] }), 'ESTADO_OBSERVADO_DIVERGENTE'],
      ['a sonda não responde no prazo', () => new Promise(() => {}), 'ESTADO_OBSERVADO_INDISPONIVEL'],
    ];
    for (const [nome, responder, motivo] of falhasIniciais) {
      test(`falha inicial (${nome}): recusa sem mutação, sem trava, sem baixar o pacote`, async () => {
        const amb = await ambiente();
        amb.sonda.responder = responder;
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
        assert.equal(r.estado, 'RECUSADO', JSON.stringify(r));
        assert.equal(r.mutacao, 'NENHUMA');
        assert.equal(r.motivo, motivo);
        assert.equal(amb.armazem.has('@.trava-cd-backend'), false, 'sem trava residual');
        assert.equal(fs.existsSync(path.join(amb.cfgAgente.estadoDir, `entrada-${ID}`)), false, 'sem diretório de entrada residual');
        assert.equal(amb.s3.uso.some(([op, k]) => op === 'get' && k.includes('/blobs/')), false, 'o pacote nem foi baixado');
        assert.equal(await amb.instalada(), rot(1));
        assert.equal(amb.reinicios(), 0);
        assert.equal(amb.chamadas.dependencias, 0);
        assert.doesNotMatch(JSON.stringify(r) + amb.s3.dados.get(`hml-backend/recibos/${ID}.json`).toString(), /SONDA_CONEXAO|sonda recusou/);
      });
    }

    test('se a sonda falha depois de iniciada a instalação, o resultado é incerto e a trava fica preservada', async () => {
      const amb = await ambiente();
      const ok = amb.sonda.responder;
      amb.sonda.responder = (n) => { if (n >= 2) throw new Error('sonda recusou: SONDA_TIMEOUT'); return ok(); };
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
      assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
      assert.equal(r.diagnostico, 'ESTADO_OBSERVADO_INDISPONIVEL');
      assert.equal(amb.armazem.has('@.trava-cd-backend'), true);
      assert.equal(await amb.instalada(), rot(1));
      assert.equal(amb.reinicios(), 0);
    });

    test('banco à frente da release ou migration pendente: o instalador bloqueia com o estado da sonda', async () => {
      for (const migrations of [['000_a', '999_do_futuro'], ['outra']]) {
        const amb = await ambiente();
        amb.sonda.responder = () => JSON.stringify({ banco: 'hml', sistema: SISTEMA_DO_CLUSTER, migrations });
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
        assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
        assert.equal(r.diagnostico, 'INCOMPATIVEL');
        assert.equal(await amb.instalada(), rot(1));
        assert.equal(amb.reinicios(), 0);
      }
    });

    test('o estado nunca vem do pedido: um pedido com campo de estado é inválido e a sonda é quem responde', async () => {
      const amb = await ambiente();
      amb.s3.dados.set(`hml-backend/pedidos/${ID}.json`, Buffer.from(JSON.stringify({ ...amb.pedido, observado: { banco: 'hml', migrations: ['000_a'] } })));
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
      assert.equal(r.estado, 'RECUSADO');
      assert.equal(r.motivo, 'PEDIDO_INVALIDO');
      assert.equal(amb.sonda.chamadas, 0);
    });

    test('a origem e o horário da coleta são do agente, não da saída da sonda', async () => {
      const amb = await ambiente();
      amb.sonda.responder = () => JSON.stringify({ banco: 'hml', sistema: SISTEMA_DO_CLUSTER, migrations: ['000_a'], coletadoEm: '1999-01-01T00:00:00.000Z', origem: 'forjada', contratos: { x: 9 } });
      const antes = Date.now();
      const entregue = await A.coletarObservado(amb.cfgAgente, amb.controladas.executar, A.vincularSonda(amb.cfgAgente, { rotulo: rot(1) }));
      assert.equal(entregue.origem, 'sonda-postgresql');
      assert.ok(Date.parse(entregue.coletadoEm) >= antes - 1000);
      assert.deepEqual(entregue.contratos, {});
      assert.deepEqual(Object.keys(entregue).sort(), ['banco', 'coletadoEm', 'contratos', 'migrations', 'origem']);
    });

    describe('P1-A: a sonda fica vinculada à baseline física conferida no início', () => {
      const roteirosUsados = (amb) => amb.sonda.argumentos.map((a) => a[1]);
      const sondaDa = (amb, n) => path.join(amb.fisica(n), 'scripts/sonda-estado-observado.js');

      test('todas as coletas usam a baseline física inicial, mesmo depois da troca do link; a sonda da candidata nunca roda', async () => {
        const amb = await ambiente();
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
        assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
        assert.equal(await amb.instalada(), rot(2), 'o link foi trocado para a candidata');
        assert.ok(amb.sonda.chamadas >= 3, `coletas: ${amb.sonda.chamadas}`);
        assert.deepEqual([...new Set(roteirosUsados(amb))], [sondaDa(amb, 1)]);
        assert.deepEqual([...new Set(amb.sonda.cwds)], [amb.fisica(1)]);
        assert.equal(roteirosUsados(amb).some((p) => p.includes(rot(2))), false);
      });

      test('cada coleta é uma consulta nova: mudança real no estado do banco entre coletas é detectada', async () => {
        const amb = await ambiente();
        amb.sonda.responder = (n) => JSON.stringify({ banco: 'hml', sistema: SISTEMA_DO_CLUSTER, migrations: n >= 3 ? ['000_a', '999_aplicada_no_meio'] : ['000_a'] });
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
        assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
        assert.equal(r.diagnostico, 'INCOMPATIVEL');
        assert.ok(amb.sonda.chamadas >= 3);
        assert.equal(amb.armazem.has('@.trava-cd-backend'), true);
        assert.deepEqual([...new Set(roteirosUsados(amb))], [sondaDa(amb, 1)]);
      });

      test('falha depois da troca e recuperação interna do instalador não mudam a origem da sonda', async () => {
        const amb = await ambiente();
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: amb.provedor, verificarSaude: async () => ({ ok: false, detalhe: 'HTTP 503' }) }) });
        assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
        assert.ok(amb.reinicios() >= 1, 'houve reinício, então a troca aconteceu');
        assert.ok(amb.sonda.chamadas >= 3);
        assert.deepEqual([...new Set(roteirosUsados(amb))], [sondaDa(amb, 1)]);
      });

      test('baseline que some no meio da operação não tem substituta: a coleta falha, sem recorrer à candidata', async () => {
        const amb = await ambiente();
        const ok = amb.sonda.responder;
        const executar = amb.controladas.executar;
        amb.controladas.executar = async (cmd, args, opc) => {
          if (args.some((a) => a.endsWith('scripts/sonda-estado-observado.js')) && amb.sonda.chamadas >= 1 && !fs.existsSync(args[0])) throw new Error('ENOENT');
          return executar(cmd, args, opc);
        };
        amb.sonda.responder = (n) => { if (n === 1) fs.renameSync(sondaDa(amb, 1), `${sondaDa(amb, 1)}.sumiu`); return ok(); };
        fs.chmodSync(path.dirname(sondaDa(amb, 1)), 0o700);
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
        assert.notEqual(r.estado, 'SUCESSO', JSON.stringify(r));
        assert.equal(roteirosUsados(amb).some((p) => p.includes(rot(2))), false);
      });

      test('operações independentes capturam cada uma a sua baseline (sem cache entre operações)', async () => {
        const amb = await ambiente();
        const r1 = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
        assert.equal(r1.estado, 'SUCESSO', JSON.stringify(r1));
        const antes = amb.sonda.argumentos.length;
        const r3 = criarReleaseBackend(3);
        const blob = blobDoDiretorio(r3);
        const agora = Date.now();
        const id2 = '124-1';
        const pedido = { versao: 2, escopo: 'backend', id: id2, repositorio: P.REPO, commit: commitDe(3), rotulo: rot(3), releaseSha256: sha(fs.readFileSync(path.join(r3, 'release.json'))), blobSha256: sha(blob), permitirAnterior: false, criadoEm: new Date(agora - 1000).toISOString(), expiraEm: new Date(agora + 5 * 60000).toISOString() };
        amb.s3.dados.set(`hml-backend/pedidos/${id2}.json`, Buffer.from(JSON.stringify(pedido)));
        amb.s3.dados.set(`hml-backend/blobs/${id2}.json`, blob);
        const deps = { ...comCoordenacao(amb), conferirRelease: () => ({ release: { commit: commitDe(3), rotulo: rot(3), atual: true } }) };
        const r2 = await A.processar({ cfg: amb.cfgAgente, id: id2, s3: amb.s3, deps });
        assert.equal(r2.estado, 'SUCESSO', JSON.stringify(r2));
        assert.equal(await amb.instalada(), rot(3));
        assert.deepEqual([...new Set(amb.sonda.argumentos.slice(antes).map((a) => a[1]))], [sondaDa(amb, 2)], 'a segunda operação usa a baseline dela (release 2)');
      });

      test('o comando é resolvido dentro da baseline física: recusa caminho pelo link corrente, fuga por .., executável vindo de release e argumento que seja caminho', async () => {
        const amb = await ambiente();
        const baseline = { rotulo: rot(1) };
        const com = (sonda) => ({ ...amb.cfgAgente, sonda: { ...amb.cfgAgente.sonda, ...sonda } });
        const v = A.vincularSonda(amb.cfgAgente, baseline);
        assert.deepEqual(v, { dir: amb.fisica(1), comando: [process.execPath, sondaDa(amb, 1)] });
        assert.deepEqual(A.vincularSonda(com({ comando: [process.execPath, sondaDa(amb, 1), '--detalhado'] }), baseline).comando, [process.execPath, sondaDa(amb, 1), '--detalhado'], 'absoluto dentro da baseline física é aceito');
        const recusados = [
          [process.execPath, path.join(amb.link, 'scripts/sonda-estado-observado.js')],
          [process.execPath, '../' + rot(1) + '/../../../fora.js'],
          [process.execPath, '../outra/scripts/sonda-estado-observado.js'],
          [process.execPath, 'scripts/nao-existe.js'],
          [process.execPath, 'scripts'],
          [path.join(amb.fisica(1), 'src/server.js'), 'scripts/sonda-estado-observado.js'],
          [path.join(amb.link, 'src/server.js'), 'scripts/sonda-estado-observado.js'],
          [process.execPath, 'scripts/sonda-estado-observado.js', path.join(amb.link, 'src/server.js')],
          [process.execPath, 'scripts/sonda-estado-observado.js', '../x'],
        ];
        for (const comando of recusados) assert.throws(() => A.vincularSonda(com({ comando }), baseline), (e) => e.codigo === 'ESTADO_OBSERVADO_INDISPONIVEL', JSON.stringify(comando));
        for (const b of [null, {}, { rotulo: 'hml-20990101T000000-abcdefa' }, { rotulo: '../x' }]) assert.throws(() => A.vincularSonda(amb.cfgAgente, b), (e) => e.codigo === 'ESTADO_OBSERVADO_INDISPONIVEL', JSON.stringify(b));
      });

      test('link dentro da baseline que aponta para fora dela é recusado', async () => {
        const amb = await ambiente();
        const dirScripts = path.join(amb.fisica(1), 'scripts');
        fs.chmodSync(dirScripts, 0o700);
        fs.symlinkSync(path.join(amb.raiz, 'reiniciar.js'), path.join(dirScripts, 'atalho.js'));
        assert.throws(() => A.vincularSonda({ ...amb.cfgAgente, sonda: { ...amb.cfgAgente.sonda, comando: [process.execPath, 'scripts/atalho.js'] } }, { rotulo: rot(1) }), (e) => e.codigo === 'ESTADO_OBSERVADO_INDISPONIVEL');
      });

      describe('prova por execução real (executor do instalador, sem interceptar a sonda)', () => {
        const esperadoNaBaseline = (amb) => ({ marcador: 'release-1', roteiro: path.join(amb.fisica(1), 'scripts/sonda-estado-observado.js'), cwd: amb.fisica(1), argv: ['--credencial', amb.cfgAgente.sonda.credencial] });
        const semPid = ({ pid, ...resto }) => resto;

        test('o ambiente não intercepta a sonda e as duas releases têm roteiros executáveis diferentes', async () => {
          const amb = await ambiente({ sondaReal: true });
          assert.equal(amb.controladas.executar, undefined, 'nenhum executor injetado: vale o do instalador');
          assert.equal(amb.cfgAgente.instalador.componentes.backend.dependencias, undefined);
          assert.match(fs.readFileSync(path.join(amb.fisica(1), 'scripts/sonda-estado-observado.js'), 'utf8'), /marcador: 'release-1'/);
          assert.deepEqual(amb.execucoesReais(), [], 'a preparação do ambiente não executa a sonda');
        });

        test('todas as coletas executam de verdade o roteiro da baseline, inclusive depois da troca do link; o da candidata nunca roda', async () => {
          const amb = await ambiente({ sondaReal: true });
          const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
          assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
          assert.equal(await amb.instalada(), rot(2), 'o instalador real trocou o link para a candidata');
          assert.match(fs.readFileSync(path.join(amb.fisica(2), 'scripts/sonda-estado-observado.js'), 'utf8'), /marcador: 'release-2'/, 'a candidata tem a própria sonda em disco');
          const execucoes = amb.execucoesReais();
          assert.ok(execucoes.length >= 3, `execuções reais: ${execucoes.length}`);
          for (const e of execucoes) assert.deepEqual(semPid(e), esperadoNaBaseline(amb));
          assert.equal(new Set(execucoes.map((e) => e.pid)).size, execucoes.length, 'cada coleta é um processo novo, não um resultado reaproveitado');
          assert.equal(execucoes.some((e) => e.marcador === 'release-2'), false);
          assert.equal(amb.reinicios(), 1);
        });

        test('cada coleta lê o estado de novo: uma mudança feita entre coletas chega ao instalador', async () => {
          const amb = await ambiente({ sondaReal: true });
          // Gancho para mudar o "banco" no meio: a identificação da baseline roda de novo depois da primeira coleta.
          let mudou = false;
          const deps = amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: amb.provedor });
          const identificar = deps.identificar;
          deps.identificar = async () => {
            const antes = amb.execucoesReais().length;
            if (!mudou && antes >= 1) { mudou = true; fs.writeFileSync(amb.estadoDoBanco, JSON.stringify({ banco: 'hml', sistema: SISTEMA_DO_CLUSTER, migrations: ['000_a', '999_aplicada_no_meio'] })); }
            return identificar();
          };
          const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps });
          assert.equal(mudou, true);
          assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
          assert.equal(r.diagnostico, 'INCOMPATIVEL');
          const execucoes = amb.execucoesReais();
          assert.ok(execucoes.length >= 2, `execuções reais: ${execucoes.length}`);
          for (const e of execucoes) assert.deepEqual(semPid(e), esperadoNaBaseline(amb));
          assert.equal(await amb.instalada(), rot(1));
        });

        test('falha depois da troca do link e recuperação interna: a sonda executada continua sendo a da baseline', async () => {
          const amb = await ambiente({ sondaReal: true });
          const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: amb.provedor, verificarSaude: async () => ({ ok: false, detalhe: 'HTTP 503' }) }) });
          assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
          assert.ok(amb.reinicios() >= 1, 'houve reinício, então a troca do link aconteceu');
          const execucoes = amb.execucoesReais();
          assert.ok(execucoes.length >= 3, `execuções reais: ${execucoes.length}`);
          for (const e of execucoes) assert.deepEqual(semPid(e), esperadoNaBaseline(amb));
          assert.equal(new Set(execucoes.map((e) => e.pid)).size, execucoes.length);
        });

        test('a segunda operação executa a sonda da baseline dela (a release instalada pela primeira)', async () => {
          const amb = await ambiente({ sondaReal: true });
          const r1 = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
          assert.equal(r1.estado, 'SUCESSO', JSON.stringify(r1));
          const antes = amb.execucoesReais().length;
          const r3 = criarReleaseBackend(3, '// a release 3 não precisa de sonda executável neste teste\n');
          const blob = blobDoDiretorio(r3);
          const agora = Date.now();
          const id2 = '124-1';
          const pedido = { versao: 2, escopo: 'backend', id: id2, repositorio: P.REPO, commit: commitDe(3), rotulo: rot(3), releaseSha256: sha(fs.readFileSync(path.join(r3, 'release.json'))), blobSha256: sha(blob), permitirAnterior: false, criadoEm: new Date(agora - 1000).toISOString(), expiraEm: new Date(agora + 5 * 60000).toISOString() };
          amb.s3.dados.set(`hml-backend/pedidos/${id2}.json`, Buffer.from(JSON.stringify(pedido)));
          amb.s3.dados.set(`hml-backend/blobs/${id2}.json`, blob);
          const r2 = await A.processar({ cfg: amb.cfgAgente, id: id2, s3: amb.s3, deps: { ...comCoordenacao(amb), conferirRelease: () => ({ release: { commit: commitDe(3), rotulo: rot(3), atual: true } }) } });
          assert.equal(r2.estado, 'SUCESSO', JSON.stringify(r2));
          const novas = amb.execucoesReais().slice(antes);
          assert.ok(novas.length >= 3);
          assert.deepEqual([...new Set(novas.map((e) => e.marcador))], ['release-2']);
          assert.deepEqual([...new Set(novas.map((e) => e.cwd))], [amb.fisica(2)]);
        });
      });

      test('sem vínculo não há coleta: coletarObservado exige a baseline vinculada', async () => {
        const amb = await ambiente();
        for (const vinculo of [undefined, null, {}, { dir: amb.fisica(1) }]) {
          await assert.rejects(A.coletarObservado(amb.cfgAgente, amb.controladas.executar, vinculo), (e) => e.codigo === 'ESTADO_OBSERVADO_INDISPONIVEL');
        }
        assert.equal(amb.sonda.chamadas, 0);
      });
    });

    test('P1-1: release instalada adulterada impede a execução da sonda e recusa sem mutação', async () => {
      const amb = await ambiente();
      const alvo = path.join(fs.realpathSync(amb.link), 'src', 'server.js');
      fs.chmodSync(path.dirname(alvo), 0o700);
      fs.chmodSync(alvo, 0o600);
      fs.writeFileSync(alvo, '// adulterado\n');
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
      assert.equal(r.estado, 'RECUSADO', JSON.stringify(r));
      assert.equal(r.mutacao, 'NENHUMA');
      assert.equal(r.motivo, 'BASELINE_NAO_COMPROVADA');
      assert.equal(amb.sonda.chamadas, 0, 'nenhum código da release adulterada foi executado');
      assert.equal(amb.armazem.has('@.trava-cd-backend'), false);
      assert.equal(fs.existsSync(path.join(amb.cfgAgente.estadoDir, `entrada-${ID}`)), false);
      assert.equal(amb.s3.uso.some(([op, k]) => op === 'get' && k.includes('/blobs/')), false);
      assert.equal(amb.reinicios(), 0);
    });

    test('P1-1: sem release instalada não há sonda para executar', async () => {
      const amb = await ambiente();
      const deps = comCoordenacao(amb);
      deps.identificar = async () => ({ instalado: false, componente: 'backend', rotulo: null, integro: false, consistente: true, problemas: [] });
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps });
      assert.equal(r.motivo, 'BASELINE_NAO_COMPROVADA');
      assert.equal(amb.sonda.chamadas, 0);
    });

    test('P1-2: a sonda recebe só o caminho da credencial; a senha não passa pelo agente nem pelo ambiente dos comandos filhos', async () => {
      const amb = await ambiente();
      fs.writeFileSync(amb.cfgAgente.sonda.credencial, JSON.stringify({ host: '127.0.0.1', porta: 5432, banco: 'hml', usuario: 'sonda_leitura', senha: 'segredo-da-sonda' }), { mode: 0o600 });
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
      assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
      for (const argumentos of amb.sonda.argumentos) assert.deepEqual(argumentos, [process.execPath, path.join(amb.fisica(1), 'scripts/sonda-estado-observado.js'), '--credencial', amb.cfgAgente.sonda.credencial]);
      const filho = JSON.parse(fs.readFileSync(amb.ambienteDoReinicio, 'utf8'));
      assert.equal(Object.keys(filho.env).some((k) => /^SONDA_|^PGPASSWORD$|^DB_PASSWORD$/.test(k)), false, 'o comando de reinício não herda credencial');
      assert.doesNotMatch(JSON.stringify(filho), /segredo-da-sonda/);
      assert.doesNotMatch(JSON.stringify([r, [...amb.armazem.values()], [...amb.s3.dados.values()].map(String)]), /segredo-da-sonda/, 'nem no resultado, no registro local ou nos recibos');
      const fonte = fs.readFileSync(AG, 'utf8');
      assert.doesNotMatch(fonte, /process\.env|senha|PASSWORD/, 'o agente não lê ambiente nem conhece a senha');
      assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd/agente.config.backend.exemplo.json'), 'utf8'), /senha|password/i);
    });

    test('P1-3: servidor PostgreSQL diferente do esperado (outro cluster) é recusado, mesmo com o mesmo nome de banco', async () => {
      for (const sistema of ['7499999999999999999', undefined, '', 7412345678901234567, 'abc']) {
        const amb = await ambiente();
        amb.sonda.responder = () => JSON.stringify({ banco: 'hml', sistema, migrations: ['000_a'] });
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
        assert.equal(r.estado, 'RECUSADO', JSON.stringify(r));
        assert.equal(r.mutacao, 'NENHUMA');
        assert.equal(r.motivo, typeof sistema === 'string' && /^[1-9][0-9]*$/.test(sistema) ? 'ESTADO_OBSERVADO_DIVERGENTE' : 'ESTADO_OBSERVADO_INDISPONIVEL', String(sistema));
        assert.equal(await amb.instalada(), rot(1));
        assert.equal(amb.reinicios(), 0);
      }
    });

    test('P1-3: se o cluster muda no meio da instalação, a recoleta recusa e o resultado é incerto', async () => {
      const amb = await ambiente();
      amb.sonda.responder = (n) => JSON.stringify({ banco: 'hml', sistema: n >= 2 ? '7499999999999999999' : SISTEMA_DO_CLUSTER, migrations: ['000_a'] });
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
      assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
      assert.equal(r.diagnostico, 'ESTADO_OBSERVADO_DIVERGENTE');
      assert.equal(amb.armazem.has('@.trava-cd-backend'), true);
      assert.equal(await amb.instalada(), rot(1));
    });

    test('a configuração precisa declarar a sonda: comando e credencial com caminho absoluto, banco e cluster esperados, prazo dentro da faixa', () => {
      const base = configValida();
      assert.equal(A.validarConfiguracao(base), base);
      const ok = base.sonda;
      for (const sonda of [undefined, {}, { ...ok, comando: ['node', 'x'] }, { ...ok, banco: '' }, { ...ok, comando: 'x' }, { ...ok, comando: [process.execPath] }, { ...ok, timeoutMs: 5 }, { ...ok, timeoutMs: 600000 },
        { ...ok, credencial: undefined }, { ...ok, credencial: 'relativo/credencial.json' }, { ...ok, sistema: undefined }, { ...ok, sistema: 7412345678901234567 }, { ...ok, sistema: 'abc' }, { ...ok, sistema: '0' }]) {
        const c = configValida();
        c.sonda = sonda;
        recusaConfig(c, 'SONDA_NAO_CONFIGURADA');
      }
    });

    test('o modelo de configuração declara a sonda com marcadores', () => {
      const modelo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd/agente.config.backend.exemplo.json'), 'utf8'));
      assert.equal(modelo.sonda.comando[1], 'scripts/sonda-estado-observado.js');
      assert.equal(modelo.sonda.banco, 'SUBSTITUIR');
      assert.equal(modelo.sonda.sistema, 'SUBSTITUIR');
      assert.ok(path.isAbsolute(modelo.sonda.credencial));
      assert.ok(fs.existsSync(path.join(RAIZ, 'backend', modelo.sonda.comando[1])));
    });
  });
});

describe('invariantes do código do agente do backend', () => {
  const fonte = fs.readFileSync(AG, 'utf8');
  test('não contorna a coordenação nem a prova de versão e não importa a coordenação', () => {
    for (const proibido of ['homologarProvedorParaTeste', 'provedorHomologado', 'consultarCoordenacao', 'atestarSemOperacao', 'semComprovacaoDeVersao', 'permitirRoot', 'coordenacao']) {
      assert.ok(!fonte.includes(proibido), `não deve citar ${proibido}`);
    }
  });
  test('não executa processos, rede, banco, migrations, backup nem restauração', () => {
    assert.doesNotMatch(fonte, /child_process|node:(net|http|https|tls|dgram)|require\(['"](pg|node-pg-migrate)['"]\)/);
    assert.doesNotMatch(fonte, /pg_dump|pg_restore|psql|db:migrate|migrate-cli|restaur/i);
    assert.doesNotMatch(fonte, /deps\.reverter|\.reverter\(|I\.reverter/);
  });
  test('usa somente o prefixo hml-backend e o escopo backend', () => {
    assert.doesNotMatch(fonte, /['"`]hml\//);
    assert.match(fonte, /hml-backend/);
  });
  test('o uso exige --config com --pedido ou --pendentes', async () => {
    await assert.rejects(A.principal([]), (e) => e.codigo === 'USO');
    await assert.rejects(A.principal(['--config', '/x']), (e) => e.codigo === 'USO');
  });
});
