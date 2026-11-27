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
// Coordenação falsa no formato do provedor do guardião: { adquirir, consultar, confirmar, liberar, garantiaVigente,
// descrever }. Registra a ordem das chamadas numa linha do tempo compartilhada com o restante das dependências.
// O padrão da consulta continua DESCONHECIDO; perder() simula a perda (aviso do guardião): a garantia local cai na hora.
const VIDA_DO_GUARDIAO_MS = 45 * 60 * 1000;
const LIBERACAO_CONFERIDA = Object.freeze({ situacao: 'LIBERACAO_INFORMADA', processoEncerrado: true, forcada: false, comprovadaNoBanco: false, cadeadosLiberados: { confirmada: true, liberados: 4, restantes: 0 }, sessaoEncerradaDeclarada: true });
function coordenacaoFalsa({ aquisicao = { ok: true, vidaMaximaMs: VIDA_DO_GUARDIAO_MS }, consultar = async () => ({ situacao: 'DESCONHECIDO', origem: 'falsa', consultadoEm: new Date().toISOString() }), liberacao = LIBERACAO_CONFERIDA, tempo = [], estado = { vigente: true, perda: null } } = {}) {
  const chamadas = { adquirir: 0, liberar: 0, criada: 0, confirmar: 0 };
  const provedor = {
    adquirir: async () => { chamadas.adquirir += 1; tempo.push('adquirir'); if (aquisicao instanceof Error) throw aquisicao; return aquisicao; },
    consultar,
    confirmar: async () => { chamadas.confirmar += 1; return (await consultar()).situacao === 'LIVRE'; },
    liberar: async () => { chamadas.liberar += 1; tempo.push('liberar'); if (liberacao instanceof Error) throw liberacao; return liberacao; },
    garantiaVigente: () => estado.vigente,
    descrever: () => ({ instanciaReal: false, perda: estado.perda }),
  };
  const perder = (motivo = 'PERDIDA') => { estado.vigente = false; if (!estado.perda) estado.perda = { motivo, em: new Date().toISOString() }; };
  return { chamadas, provedor, tempo, estado, perder };
}
// Simulador de sucesso: guardião que mantém a posse (LIVRE) até perder(). Cada consulta entra na linha do tempo.
function coordenacaoLivre(opcoes = {}) {
  const tempo = opcoes.tempo || [];
  const estado = { vigente: true, perda: null };
  const consultar = async () => {
    tempo.push('consultar');
    return estado.vigente ? { situacao: 'LIVRE', origem: 'falsa', consultadoEm: new Date().toISOString() } : { situacao: 'DESCONHECIDO', origem: 'falsa: perdida', consultadoEm: new Date().toISOString() };
  };
  return coordenacaoFalsa({ ...opcoes, tempo, estado, consultar });
}
function depsDe({ instalar, antes = BASE, depois = ALVO, coordenacao = coordenacaoLivre() } = {}) {
  const armazem = new Map();
  const chamadas = { instalar: 0, reverter: 0, identificar: 0 };
  const tempo = coordenacao.tempo;
  return {
    armazem, chamadas, coordenacao, tempo,
    criarAncora: ancoraFalsa(armazem),
    vincular: () => ({ dir: '/baseline-do-teste', comando: ['/bin/false'] }),
    vincularGuardiao: (baseline) => { tempo.push('vincularGuardiao'); chamadas.baselineDoGuardiao = baseline; return { dir: '/baseline-do-teste', comando: ['/bin/false', '/baseline-do-teste/scripts/guardiao-de-coordenacao.js'] }; },
    criarCoordenacao: (vinculo) => { coordenacao.chamadas.criada += 1; chamadas.vinculoDoGuardiao = vinculo; return coordenacao.provedor; },
    observar: async () => { chamadas.observar = (chamadas.observar || 0) + 1; tempo.push('observar'); return { banco: 'hml', origem: 'teste', coletadoEm: new Date().toISOString(), migrations: ['000_a'], contratos: {} }; },
    conferirRelease: () => ({ release: { commit: COMMIT, rotulo: ROTULO, atual: true } }),
    identificar: async () => { chamadas.identificar += 1; return chamadas.instalar > 0 ? depois : antes; },
    instalar: async (opcoes, release, vinculo, coordenacaoRecebida, operacao) => { chamadas.instalar += 1; chamadas.coordenacaoRecebida = coordenacaoRecebida; chamadas.operacao = operacao; tempo.push('instalar'); return instalar(opcoes, operacao); },
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

  // Correção B (B3b): o recibo já publicado sem registro local é visto antes de qualquer registro ou mudança: nada é
  // instalado nem publicado, o recibo existente não é sobrescrito e nenhum CRITICO novo prende a trava.
  test('RECIBO_PREEXISTENTE: recibo já publicado sem registro local recusa antes de registrar, sem instalar nem sobrescrever o recibo', async () => {
    const { s3 } = preparar();
    s3.dados.set(`hml-backend/recibos/${ID}.json`, Buffer.from(JSON.stringify({ id: ID, estado: 'SUCESSO' })));
    const deps = depsDe({ instalar: async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); } });
    await assert.rejects(A.processar({ cfg: cfg(), id: ID, s3, deps }), (e) => e.codigo === 'RECIBO_PREEXISTENTE');
    assert.equal(deps.chamadas.instalar, 0);
    assert.equal(deps.armazem.has(`${ID}.json`), false, 'nenhum registro é gravado');
    assert.equal(comTrava(deps), false, 'nada mudou: a trava é solta');
    assert.equal(s3.uso.some(([op]) => op === 'put'), false);
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

describe('Etapa 3B-2B-1: o guardião de coordenação no ciclo do agente', () => {
  // Fases do registro local na mesma linha do tempo das dependências.
  const comFases = (deps) => {
    const set0 = deps.armazem.set.bind(deps.armazem);
    deps.armazem.set = (k, v) => { if (k === `${ID}.json`) deps.tempo.push(`registro:${JSON.parse(v).fase}`); return set0(k, v); };
    return deps;
  };

  test('ordem: vínculo à baseline na pré-checagem; aquisição depois do pacote extraído e antes de INSTALACAO_INICIADA; liberação antes do registro final', async () => {
    const { s3 } = preparar();
    const deps = comFases(depsDe({ instalar: async () => INSTALADA }));
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
    // 3B-2B-3A: a confirmação final (consultar) fica entre a instalação e a liberação.
    assert.deepEqual(deps.tempo, ['registro:INICIO', 'vincularGuardiao', 'observar', 'registro:PREPARADO', 'adquirir', 'registro:INSTALACAO_INICIADA', 'instalar', 'consultar', 'liberar', 'registro:TERMINAL']);
    assert.equal(deps.chamadas.baselineDoGuardiao.rotulo, BASE.rotulo, 'o guardião é vinculado à mesma baseline conferida no início');
    assert.equal(deps.chamadas.coordenacaoRecebida, deps.coordenacao.provedor, 'o instalador recebe o provedor adquirido');
    assert.deepEqual([deps.coordenacao.chamadas.criada, deps.coordenacao.chamadas.adquirir, deps.coordenacao.chamadas.liberar], [1, 1, 1]);
    assert.equal(registroLocal(deps).liberacaoDaCoordenacao.situacao, 'LIBERACAO_INFORMADA');
    assert.equal('liberacaoDaCoordenacao' in reciboPublicado(s3), false, 'o recibo publicado não muda de formato');
    assert.equal(comTrava(deps), false);
  });

  for (const motivo of ['EM_USO', 'MIGRACAO_EM_CURSO']) {
    test(`operação do D-ORF-6 em curso (${motivo}): RECUSADO sem mutação, motivo COORDENACAO_OCUPADA, instalador não chamado`, async () => {
      const { s3 } = preparar();
      const deps = comFases(depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoFalsa({ aquisicao: { ok: false, motivo } }) }));
      const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
      assert.deepEqual([r.estado, r.mutacao, r.motivo], ['RECUSADO', 'NENHUMA', 'COORDENACAO_OCUPADA']);
      assert.equal(deps.chamadas.instalar, 0);
      assert.equal(deps.tempo.includes('registro:INSTALACAO_INICIADA'), false);
      assert.equal(deps.coordenacao.chamadas.liberar, 1, 'liberado mesmo sem aquisição');
      assert.equal(reciboPublicado(s3).motivo, 'COORDENACAO_OCUPADA');
      assert.equal(comTrava(deps), false);
    });
  }

  test('aquisição sem garantia (indisponível, identidade divergente, resposta fora do formato ou exceção): RECUSADO COORDENACAO_NAO_ADQUIRIDA', async () => {
    for (const aquisicao of [{ ok: false, motivo: 'GUARDIAO_INDISPONIVEL' }, { ok: false, motivo: 'GUARDIAO_IDENTIDADE_DIVERGENTE' }, { ok: false }, null, { ok: 'true' }, {}, new Error('falhou')]) {
      const { s3 } = preparar();
      const deps = depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoFalsa({ aquisicao }) });
      const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
      assert.deepEqual([r.estado, r.mutacao, r.motivo], ['RECUSADO', 'NENHUMA', 'COORDENACAO_NAO_ADQUIRIDA'], String(JSON.stringify(aquisicao)));
      assert.equal(deps.chamadas.instalar, 0);
      assert.equal(deps.coordenacao.chamadas.liberar, 1);
      fs.rmSync(path.join(tmp, `entrada-${ID}`), { recursive: true, force: true });
    }
  });

  test('guardião que não pode ser vinculado à baseline: RECUSADO antes de baixar o pacote, nada é adquirido', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA });
    deps.vincularGuardiao = () => { throw erroCom('GUARDIAO_NAO_VINCULADO'); };
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.mutacao, r.motivo], ['RECUSADO', 'NENHUMA', 'GUARDIAO_NAO_VINCULADO']);
    assert.equal(s3.uso.some(([op, k]) => op === 'get' && k.includes('/blobs/')), false);
    assert.deepEqual([deps.coordenacao.chamadas.criada, deps.coordenacao.chamadas.adquirir], [0, 0]);
  });

  test('recusa do instalador sem mutação (COORDENACAO_NAO_HOMOLOGADA) depois da aquisição: RECUSADO e guardião liberado', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); } });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.mutacao, r.motivo], ['RECUSADO', 'NENHUMA', 'COORDENACAO_NAO_HOMOLOGADA']);
    assert.deepEqual([deps.coordenacao.chamadas.adquirir, deps.coordenacao.chamadas.liberar], [1, 1]);
  });

  test('falha depois de iniciada a instalação: CRITICO com a trava preservada, e o guardião é liberado mesmo assim', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('FALHA_POS_TROCA'); } });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'CRITICO');
    assert.equal(comTrava(deps), true);
    assert.equal(deps.coordenacao.chamadas.liberar, 1);
    assert.equal(registroLocal(deps).liberacaoDaCoordenacao.situacao, 'LIBERACAO_INFORMADA');
  });

  // Correção P1: sem encerramento comprovado do processo do guardião, nenhuma operação termina como SUCESSO.
  const LIBERACOES_INCERTAS = [
    ['indeterminada (processo não encerrou nem depois do sinal)', { situacao: 'INDETERMINADA', processoEncerrado: false, forcada: true, comprovadaNoBanco: false }, 'INDETERMINADA'],
    ['exceção em liberar()', new Error('sem canal'), 'FALHA_NA_LIBERACAO'],
    ['resposta nula', null, 'RESPOSTA_INVALIDA'],
    ['resposta sem situação', {}, 'RESPOSTA_INVALIDA'],
    ['situação desconhecida', { situacao: 'TALVEZ', processoEncerrado: true }, 'RESPOSTA_INVALIDA'],
    ['situação de encerramento sem processoEncerrado', { situacao: 'LIBERACAO_INFORMADA', processoEncerrado: false }, 'RESPOSTA_INVALIDA'],
    ['processoEncerrado que não é booleano', { situacao: 'PROCESSO_ENCERRADO', processoEncerrado: 'true' }, 'RESPOSTA_INVALIDA'],
    ['texto em vez de objeto', 'LIBERACAO_INFORMADA', 'RESPOSTA_INVALIDA'],
  ];

  for (const [nome, liberacao, causa] of LIBERACOES_INCERTAS) {
    test(`P1: instalação concluída com liberação incerta (${nome}): CRITICO, sem recibo de sucesso, trava preservada`, async () => {
      const { pedido, s3 } = preparar();
      const deps = depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoLivre({ liberacao }) });
      const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
      assert.deepEqual([r.estado, r.verificado, r.motivo, r.diagnostico], ['CRITICO', false, 'LIBERACAO_DA_COORDENACAO_INCERTA', causa]);
      assert.equal(comTrava(deps), true, 'a trava do agente fica para diagnóstico');
      assert.equal(reciboPublicado(s3).estado, 'CRITICO');
      assert.throws(() => P.validarRecibo(reciboPublicado(s3), pedido), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
      const reg = registroLocal(deps);
      assert.deepEqual(reg.resultadoAntesDaLiberacao, { estado: 'SUCESSO', verificado: true }, 'o resultado da instalação fica registrado');
      assert.equal(reg.liberacaoDaCoordenacao.situacao, causa);
      assert.equal(reg.liberacaoDaCoordenacao.encerramentoComprovado, false);
      assert.equal(reg.liberacaoDaCoordenacao.comprovadaNoBanco, false);
      assert.doesNotMatch(JSON.stringify(reg), /credencial|senha|password/i, 'nenhum dado de credencial no registro');
    });
  }

  // 3B-2B-3A (CA-20): o SUCESSO passou a exigir a soltura conferida dos quatro cadeados. Encerramento do processo sem
  // esse aviso (PROCESSO_ENCERRADO, SEM_PROCESSO) comprova que nada ficou preso, mas não a continuidade até o fim: antes
  // mantinha o SUCESSO, agora é CRITICO com CONTINUIDADE_NAO_DEMONSTRADA (endurecimento deliberado).
  test('P1: liberação com encerramento comprovado e soltura conferida dos cadeados: o resultado original é mantido', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoLivre({ liberacao: LIBERACAO_CONFERIDA }) });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'SUCESSO');
    assert.equal(comTrava(deps), false);
    const lib = registroLocal(deps).liberacaoDaCoordenacao;
    assert.deepEqual(lib, {
      situacao: 'LIBERACAO_INFORMADA', processoEncerrado: true, forcada: false, encerramentoComprovado: true, comprovadaNoBanco: false,
      cadeadosLiberadosConfirmados: true, sessaoEncerradaDeclarada: true, continuidadeDemonstrada: true,
    });
    assert.equal('resultadoAntesDaLiberacao' in registroLocal(deps), false);
  });

  test('CA-20: encerramento comprovado sem soltura conferida (encerrado forçado, sem processo, aviso incompleto): CRITICO CONTINUIDADE_NAO_DEMONSTRADA', async () => {
    for (const liberacao of [
      { situacao: 'PROCESSO_ENCERRADO', processoEncerrado: true, forcada: true, comprovadaNoBanco: false },
      { situacao: 'SEM_PROCESSO', processoEncerrado: true, forcada: false, comprovadaNoBanco: false },
      { situacao: 'LIBERACAO_INFORMADA', processoEncerrado: true, forcada: false, comprovadaNoBanco: false },
      { ...LIBERACAO_CONFERIDA, cadeadosLiberados: { confirmada: false, liberados: 3, restantes: 0 } },
    ]) {
      const { pedido, s3 } = preparar();
      const deps = depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoLivre({ liberacao }) });
      const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
      assert.deepEqual([r.estado, r.verificado, r.motivo, r.diagnostico], ['CRITICO', false, 'CONTINUIDADE_NAO_DEMONSTRADA', liberacao.situacao], JSON.stringify(liberacao));
      assert.equal(comTrava(deps), true, 'a trava do agente fica para diagnóstico');
      assert.equal(reciboPublicado(s3).estado, 'CRITICO');
      assert.throws(() => P.validarRecibo(reciboPublicado(s3), pedido), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
      const reg = registroLocal(deps);
      assert.deepEqual(reg.resultadoAntesDaLiberacao, { estado: 'SUCESSO', verificado: true });
      assert.equal(reg.liberacaoDaCoordenacao.encerramentoComprovado, true, 'nada ficou preso: o problema é a continuidade');
      assert.equal(reg.liberacaoDaCoordenacao.continuidadeDemonstrada, false);
      deps.armazem.delete('@.trava-cd-backend');
      fs.rmSync(path.join(tmp, `entrada-${ID}`), { recursive: true, force: true });
    }
  });

  test('P1: o agente nunca afirma liberação comprovada no banco, mesmo que o provedor diga que sim', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoLivre({ liberacao: { ...LIBERACAO_CONFERIDA, comprovadaNoBanco: true } }) });
    await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(registroLocal(deps).liberacaoDaCoordenacao.comprovadaNoBanco, false);
  });

  test('P1: recusa antes da mutação com liberação incerta: CRITICO, trava preservada, resultado original registrado', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoFalsa({ aquisicao: { ok: false, motivo: 'EM_USO' }, liberacao: { situacao: 'INDETERMINADA', processoEncerrado: false, forcada: true } }) });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.motivo, r.diagnostico], ['CRITICO', 'LIBERACAO_DA_COORDENACAO_INCERTA', 'INDETERMINADA']);
    assert.equal(deps.chamadas.instalar, 0);
    assert.equal(comTrava(deps), true);
    assert.deepEqual(registroLocal(deps).resultadoAntesDaLiberacao, { estado: 'RECUSADO', verificado: false, mutacao: 'NENHUMA', motivo: 'COORDENACAO_OCUPADA' });
  });

  test('P1: falha depois da mutação com liberação incerta: continua CRITICO com o motivo original e a liberação registrada', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => { throw erroCom('FALHA_POS_TROCA'); }, coordenacao: coordenacaoFalsa({ liberacao: new Error('sem canal') }) });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.motivo, r.diagnostico], ['CRITICO', 'FALHA_CRITICA_APOS_ALTERACAO', 'FALHA_POS_TROCA']);
    assert.equal(comTrava(deps), true);
    const reg = registroLocal(deps);
    assert.equal(reg.liberacaoDaCoordenacao.situacao, 'FALHA_NA_LIBERACAO');
    assert.equal(reg.liberacaoDaCoordenacao.encerramentoComprovado, false);
  });

  test('P1: liberação pedida uma única vez por operação; a operação incerta não é reprocessada nem cria outro guardião', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoLivre({ liberacao: { situacao: 'INDETERMINADA', processoEncerrado: false, forcada: true } }) });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'CRITICO');
    assert.equal(r.motivo, 'LIBERACAO_DA_COORDENACAO_INCERTA');
    assert.equal(deps.coordenacao.chamadas.liberar, 1, 'um único pedido de liberação, apesar dos dois pontos de chamada');
    deps.armazem.delete('@.trava-cd-backend');
    await assert.rejects(A.processar({ cfg: cfg(), id: ID, s3, deps }), (e) => e.codigo === 'OPERACAO_PENDENTE_OU_CRITICA');
    assert.deepEqual([deps.coordenacao.chamadas.criada, deps.coordenacao.chamadas.liberar], [1, 1]);
  });

  test('P1: na fila, uma liberação incerta interrompe o processamento como operação crítica', async () => {
    const s3 = s3Com('1-1', '2-1');
    const deps = depsDe({ instalar: async () => INSTALADA, coordenacao: coordenacaoLivre({ liberacao: { situacao: 'INDETERMINADA', processoEncerrado: false, forcada: true } }) });
    await assert.rejects(A.processarFila({ cfg: cfg(), ids: ['1-1', '2-1'], s3, deps }), (e) => e.codigo === 'OPERACAO_CRITICA');
    assert.equal(deps.coordenacao.chamadas.criada, 1, 'o segundo pedido não começa');
  });

  test('pedido já concluído (registro TERMINAL anterior): nenhum guardião é criado', async () => {
    const { s3 } = preparar();
    const deps = depsDe({ instalar: async () => INSTALADA });
    await A.processar({ cfg: cfg(), id: ID, s3, deps });
    const antes = deps.coordenacao.chamadas.criada;
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'SUCESSO');
    assert.equal(deps.coordenacao.chamadas.criada, antes);
  });
});

// 3B-2B-3A: a garantia vale do começo ao fim. Cada ação protegida exige, antes de começar, a garantia local do provedor,
// uma confirmação nova e tempo suficiente; depois da última ação vem a confirmação final, e só então a liberação.
describe('3B-2B-3A: garantia contínua, prazos e janela final (instalador simulado)', () => {
  const comFases = (deps) => {
    const set0 = deps.armazem.set.bind(deps.armazem);
    deps.armazem.set = (k, v) => { if (k === `${ID}.json`) deps.tempo.push(`registro:${JSON.parse(v).fase}`); return set0(k, v); };
    return deps;
  };
  const MIN = 60 * 1000;

  test('CA-06: perda na conclusão, depois da última ação: CRITICO, recibo CRITICO, trava preservada e uma liberação', async () => {
    const { pedido, s3 } = preparar();
    const coordenacao = coordenacaoLivre();
    const deps = depsDe({ instalar: async () => { coordenacao.perder('PERDIDA'); return INSTALADA; }, coordenacao });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.verificado, r.motivo], ['CRITICO', false, 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO'], JSON.stringify(r));
    assert.equal(comTrava(deps), true);
    assert.equal(reciboPublicado(s3).estado, 'CRITICO');
    assert.throws(() => P.validarRecibo(reciboPublicado(s3), pedido), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
    assert.equal(coordenacao.chamadas.liberar, 1);
    const reg = registroLocal(deps);
    assert.equal(reg.coordenacao.confirmacaoFinal, false);
    assert.equal(reg.coordenacao.guardiao.perda.motivo, 'PERDIDA');
  });

  test('CA-10: confirmação final DESCONHECIDO com a garantia local intacta (perda silenciosa): CRITICO', async () => {
    const { s3 } = preparar();
    const coordenacao = coordenacaoFalsa();
    const deps = depsDe({ instalar: async () => INSTALADA, coordenacao });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.motivo], ['CRITICO', 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO']);
    assert.equal(coordenacao.chamadas.confirmar, 1, 'a confirmação final perguntou ao guardião');
  });

  test('CA-08: JA_INSTALADA com posse contínua: SUCESSO, com a confirmação final feita', async () => {
    const { s3 } = preparar();
    const coordenacao = coordenacaoLivre();
    const deps = depsDe({ instalar: async () => ({ resultado: 'JA_INSTALADA', avisos: [] }), antes: ALVO, coordenacao });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
    assert.equal(coordenacao.chamadas.confirmar, 1);
    assert.equal(registroLocal(deps).coordenacao.confirmacaoFinal, true);
  });

  test('CA-08: JA_INSTALADA com perda: CRITICO, sem recibo de sucesso, e a fila para como operação crítica', async () => {
    const { pedido, s3 } = preparar();
    const coordenacao = coordenacaoLivre();
    const deps = depsDe({ instalar: async () => { coordenacao.perder('EXPIRADA'); return { resultado: 'JA_INSTALADA', avisos: [] }; }, antes: ALVO, coordenacao });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.motivo], ['CRITICO', 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO']);
    assert.equal(reciboPublicado(s3).estado, 'CRITICO');
    assert.throws(() => P.validarRecibo(reciboPublicado(s3), pedido), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
    assert.equal(comTrava(deps), true);
    const fila = s3Com('1-1', '2-1');
    const c2 = coordenacaoLivre();
    const d2 = depsDe({ instalar: async () => { c2.perder('EXPIRADA'); return { resultado: 'JA_INSTALADA', avisos: [] }; }, antes: ALVO, coordenacao: c2 });
    await assert.rejects(A.processarFila({ cfg: cfg(), ids: ['1-1', '2-1'], s3: fila, deps: d2 }), (e) => e.codigo === 'OPERACAO_CRITICA');
    assert.equal(c2.chamadas.criada, 1, 'o segundo pedido não começa');
  });

  test('CA-16: vida máxima do guardião menor que 45 min, ausente ou inválida: RECUSADO sem mutação, guardião liberado, nada instalado', async () => {
    for (const aquisicao of [{ ok: true, vidaMaximaMs: 44 * MIN }, { ok: true }, { ok: true, vidaMaximaMs: '2700000' }, { ok: true, vidaMaximaMs: 45 * MIN + 0.5 }]) {
      const { s3 } = preparar();
      const coordenacao = coordenacaoLivre({ aquisicao });
      const deps = depsDe({ instalar: async () => INSTALADA, coordenacao });
      const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
      assert.deepEqual([r.estado, r.mutacao, r.motivo], ['RECUSADO', 'NENHUMA', 'PRAZO_DA_COORDENACAO_INSUFICIENTE'], JSON.stringify(aquisicao));
      assert.equal(deps.chamadas.instalar, 0);
      assert.equal(coordenacao.chamadas.liberar, 1);
      assert.equal(comTrava(deps), false);
      fs.rmSync(path.join(tmp, `entrada-${ID}`), { recursive: true, force: true });
    }
  });

  test('CA-09: janela final: última ação, confirmação final, liberação e registro, nesta ordem; nada do instalador depois da confirmação final', async () => {
    const { s3 } = preparar();
    const deps = comFases(depsDe({ instalar: async () => INSTALADA }));
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
    assert.deepEqual(deps.tempo.slice(-4), ['instalar', 'consultar', 'liberar', 'registro:TERMINAL']);
    let executou = false;
    await assert.rejects(deps.chamadas.operacao.proteger('reiniciar', 1000, async () => { executou = true; })(), (e) => e.codigo === 'OPERACAO_ENCERRADA');
    assert.equal(executou, false);
    const reg = registroLocal(deps);
    assert.equal(reg.coordenacao.confirmacaoFinal, true);
    assert.ok(Number.isInteger(reg.coordenacao.janelaFinalMs) && reg.coordenacao.janelaFinalMs >= 0, 'tempo entre a confirmação final e o pedido de liberação registrado');
    assert.equal(reg.coordenacao.perda, null);
  });

  test('CA-02 no agente: garantia local caída antes de uma ação: a ação não começa e o guardião nem é consultado', async () => {
    const { s3 } = preparar();
    const coordenacao = coordenacaoLivre();
    let executou = false;
    let confirmacoesAntes = null;
    const deps = depsDe({
      coordenacao,
      instalar: async (_opcoes, operacao) => {
        coordenacao.perder('PERDIDA');
        confirmacoesAntes = coordenacao.chamadas.confirmar;
        await assert.rejects(operacao.proteger('reiniciar', 1000, async () => { executou = true; })(), (e) => e.codigo === 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO');
        assert.equal(coordenacao.chamadas.confirmar, confirmacoesAntes);
        return INSTALADA;
      },
    });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(executou, false);
    assert.deepEqual([r.estado, r.motivo], ['CRITICO', 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO']);
  });

  test('CA-17: ação que não cabe no tempo restante não começa, e nada começa depois disso', async () => {
    const { s3 } = preparar();
    let agora = 1000;
    let executou = 0;
    const deps = depsDe({
      instalar: async (_opcoes, operacao) => {
        await operacao.proteger('identificarProcesso', 30 * 1000, async () => { executou += 1; })();
        agora += 16 * MIN;
        await assert.rejects(operacao.proteger('executar', 15 * MIN, async () => { executou += 1; })(), (e) => e.codigo === 'PRAZO_DA_INSTALACAO_EXCEDIDO');
        await assert.rejects(operacao.proteger('identificarProcesso', 1000, async () => { executou += 1; })(), (e) => e.codigo === 'PRAZO_DA_INSTALACAO_EXCEDIDO');
        return INSTALADA;
      },
    });
    deps.relogio = () => agora;
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(executou, 1, 'só a ação que cabia');
    assert.deepEqual([r.estado, r.motivo], ['CRITICO', 'PRAZO_DA_INSTALACAO_EXCEDIDO']);
    assert.equal(registroLocal(deps).coordenacao.perda.codigo, 'PRAZO_DA_INSTALACAO_EXCEDIDO');
  });

  test('CA-18: limite de 30 min ultrapassado até a conclusão: CRITICO PRAZO_DA_INSTALACAO_EXCEDIDO', async () => {
    const { s3 } = preparar();
    let agora = 1000;
    const coordenacao = coordenacaoLivre();
    const deps = depsDe({ coordenacao, instalar: async () => { agora += 31 * MIN; return INSTALADA; } });
    deps.relogio = () => agora;
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.motivo], ['CRITICO', 'PRAZO_DA_INSTALACAO_EXCEDIDO']);
    assert.equal(coordenacao.chamadas.confirmar, 0, 'nem a confirmação final é tentada fora do prazo');
    assert.equal(coordenacao.chamadas.liberar, 1);
  });

  test('CA-19: ajuste do relógio do sistema no meio da instalação não muda o resultado (prazos por relógio monotônico)', async () => {
    const { s3 } = preparar();
    const original = Date.now;
    const deps = depsDe({ instalar: async () => { Date.now = () => original() + 2 * 60 * MIN; return INSTALADA; } });
    try {
      const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
      assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
    } finally {
      Date.now = original;
    }
  });

  for (const codigo of ['ENCERRAMENTO_DA_ACAO_INCERTO', 'PRAZO_DA_ACAO_EXCEDIDO', 'ACAO_DEIXOU_DESCENDENTES']) {
    test(`ação que termina com ${codigo} bloqueia as seguintes e o resultado é CRITICO com esse motivo`, async () => {
      const { s3 } = preparar();
      let seguinte = false;
      const deps = depsDe({
        instalar: async (_opcoes, operacao) => {
          await assert.rejects(operacao.proteger('reiniciar', 1000, async () => { throw erroCom(codigo); })(), (e) => e.codigo === codigo);
          await assert.rejects(operacao.proteger('verificarSaude', 1000, async () => { seguinte = true; })(), (e) => e.codigo === codigo);
          return INSTALADA;
        },
      });
      const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
      assert.equal(seguinte, false);
      assert.deepEqual([r.estado, r.motivo], ['CRITICO', codigo]);
      assert.equal(comTrava(deps), true);
    });
  }

  test('prazos declarados: instalação 30 min, margem 5 min, reserva 10 min, guardião com pelo menos 45 min, e toda ação cabe na instalação', () => {
    const p = A.PRAZOS_DA_OPERACAO;
    assert.deepEqual([p.instalacaoMs, p.margemDeEncerramentoMs, p.reservaMs, p.vidaMinimaDoGuardiaoMs], [30 * MIN, 5 * MIN, 10 * MIN, 45 * MIN]);
    assert.equal(p.instalacaoMs + p.margemDeEncerramentoMs + p.reservaMs, p.vidaMinimaDoGuardiaoMs);
    for (const [nome, ms] of Object.entries(p.acoes)) assert.ok(Number.isInteger(ms) && ms > 0 && ms < p.instalacaoMs, nome);
  });
});

// 3B-2B-3B (C3): fora do fluxo oficial (S3 injetado), processar nunca emite autorização para o instalador.
describe('3B-2B-3B: processar sem o cliente S3 oficial não emite autorização', () => {
  test('C3-01: com S3 injetado, o instalador não recebe autorização, mesmo com o guardião adquirido', async () => {
    const { s3 } = preparar();
    let recebidas;
    const deps = depsDe({ instalar: async (opcoes) => { recebidas = opcoes; return INSTALADA; } });
    const r = await A.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
    assert.ok(recebidas);
    assert.equal('autorizacao' in recebidas, false);
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
    guardiao: { comando: [process.execPath, 'scripts/guardiao-de-coordenacao.js'], credencial: path.join(raiz, 'credencial-do-guardiao.json') },
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
    // 3B-2B-3B: a verificação do guardião de produção também lança só pelo ponto único, e também antes da âncora.
    const iGuardiao = fonte.indexOf('exigirGuardiaoHomologado({', ini);
    assert.ok(iGuardiao > iDeps && iGuardiao < iAncora, 'verificação do guardião antes da âncora');
    assert.equal((fonte.match(/naoHomologada\(/g) || []).length, 2, 'só as duas guardas usam o ponto único');
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

  function criarReleaseBackend(n, sondaDaRelease = `// sonda da release ${n}\n`, guardiaoDaRelease = `// guardião da release ${n}\n`) {
    const dir = fs.mkdtempSync(path.join(tmp, `rel${n}-`));
    const lock = '{"lockfileVersion":3}';
    const migration = '-- 000_a.sql\n';
    const arquivos = {
      'package.json': '{"engines":{"node":">=22"}}', 'package-lock.json': lock, 'src/server.js': `// v${n}\n`, 'scripts/sonda-estado-observado.js': sondaDaRelease, 'migrations/000_a.sql': migration,
      'scripts/guardiao-de-coordenacao.js': guardiaoDaRelease,
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
  // Guardião simulado de verdade: um processo Node na release, que fala o protocolo do canal de controle (sem banco) e
  // registra num diário com que argumentos, ambiente e diretório foi iniciado e o que recebeu.
  const roteiroDoGuardiao = (n, diario) => [
    "'use strict';",
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    `const anotar = (o) => fs.appendFileSync(${JSON.stringify(diario)}, JSON.stringify({ marcador: 'release-${n}', ...o }) + '\\n');`,
    "anotar({ inicio: true, argv: process.argv.slice(2), ambiente: Object.keys(process.env), cwd: process.cwd(), roteiro: __filename });",
    `const IMPRESSAO = '${'c3'.repeat(32)}';`,
    'let comandos = 0;',
    `process.stdout.write(JSON.stringify({ evento: 'ADQUIRIDA', cadeados: 4, impressao: IMPRESSAO, vidaMaximaMs: ${45 * 60 * 1000} }) + '\\n');`,
    'const linhas = readline.createInterface({ input: process.stdin });',
    "linhas.on('line', (t) => { anotar({ recebido: t }); const m = /^confirmar ([0-9a-f]{32})$/.exec(t); if (m) { comandos += 1; process.stdout.write(JSON.stringify({ evento: 'CONFIRMADA', id: m[1], impressao: IMPRESSAO, cadeados: 4, comandos }) + '\\n'); } else if (t === 'liberar') { process.stdout.write(JSON.stringify({ evento: 'LIBERADA', impressao: IMPRESSAO, liberados: 4, restantes: 0, sessaoEncerrada: true }) + '\\n'); process.exit(0); } });",
    "linhas.on('close', () => { anotar({ canalFechado: true }); process.exit(0); });",
    '',
  ].join('\n');

  async function ambiente({ reinicioSai = 0, sondaReal = false, adotar = false } = {}) {
    const raiz = fs.mkdtempSync(path.join(fs.realpathSync(tmp), 'amb-'));
    const diarioDoGuardiao = path.join(raiz, 'execucoes-do-guardiao.ndjson');
    const execucoesDoGuardiao = () => (fs.existsSync(diarioDoGuardiao) ? fs.readFileSync(diarioDoGuardiao, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
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
      guardiao: { comando: [process.execPath, 'scripts/guardiao-de-coordenacao.js'], credencial: path.join(raiz, 'credencial-do-guardiao.json') },
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
    const r1 = criarReleaseBackend(1, roteiroReal(1), roteiroDoGuardiao(1, diarioDoGuardiao));
    // 4C (D-H1): com `adotar`, a release 1 entra pela adoção (comprovada:false), não por uma instalação comprovada.
    if (adotar) await I.adotarBaselineDoBackend({ config: cfgAgente.instalador, componente: 'backend', release: r1, opcoes: { releaseSha256Esperado: sha(fs.readFileSync(path.join(r1, 'release.json'))) }, deps: { criarAncora: ancoraPorCaminho, executar: controladas.executar } });
    else await I.instalar({ config: cfgAgente.instalador, componente: 'backend', release: r1, opcoes: { releaseSha256Esperado: sha(fs.readFileSync(path.join(r1, 'release.json'))) }, deps: { ...controladas, lerObservado: async () => ({ banco: 'hml', origem: 'preparo-do-teste', coletadoEm: new Date().toISOString(), migrations: ['000_a'], contratos: {} }), reiniciar: async () => {}, consultarCoordenacao: provedor } });
    sonda.chamadas = 0; sonda.cwds.length = 0;
    Object.assign(chamadas, { saude: 0, processo: 0, dependencias: 0 });
    const r2 = criarReleaseBackend(2, roteiroReal(2), roteiroDoGuardiao(2, diarioDoGuardiao));
    const blob = blobDoDiretorio(r2);
    const agora = Date.now();
    const pedido = { versao: 2, escopo: 'backend', id: ID, repositorio: P.REPO, commit: commitDe(2), rotulo: rot(2), releaseSha256: sha(fs.readFileSync(path.join(r2, 'release.json'))), blobSha256: sha(blob), permitirAnterior: false, criadoEm: new Date(agora - 1000).toISOString(), expiraEm: new Date(agora + 5 * 60000).toISOString() };
    const s3 = s3Falso({ [`hml-backend/pedidos/${ID}.json`]: Buffer.from(JSON.stringify(pedido)), [`hml-backend/blobs/${ID}.json`]: blob });
    const armazem = new Map();
    const identificar = async () => ({ ...(await I.identificar({ config: cfgAgente.instalador, componente: 'backend', deps: { criarAncora: ancoraPorCaminho } })), garantiaContraCorrida: true });
    // A coordenação chega ao instalador SÓ pelo provedor do guardião. Nos testes, um consultarCoordenacao informado nos
    // extras vira o consultar de um guardião falso, e sai dos extras: o agente não aceita coordenação por outro caminho.
    const guardioes = [];
    const depsDoAgente = (extras) => {
      const { consultarCoordenacao, ...resto } = extras;
      return {
        criarAncora: ancoraFalsa(armazem), conferirRelease: () => ({ release: { commit: commitDe(2), rotulo: rot(2), atual: true } }), identificar, depsExtrasDoInstalador: resto,
        criarCoordenacao: () => { const g = coordenacaoFalsa(consultarCoordenacao ? { consultar: consultarCoordenacao } : {}); guardioes.push(g); return g.provedor; },
      };
    };
    const instalada = async () => (await identificar()).rotulo;
    const reinicios = () => (fs.existsSync(registro) ? fs.readFileSync(registro, 'utf8').split('\n').filter(Boolean).length : 0);
    return { cfgAgente, s3, armazem, controladas, provedor, depsDoAgente, guardioes, identificar, instalada, reinicios, chamadas, pedido, sonda, link, ambienteDoReinicio, raiz, app, fisica: (n) => path.join(app, '.releases', 'backend', rot(n)), execucoesReais, estadoDoBanco, diarioDaSonda, execucoesDoGuardiao };
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

  test('4C (D-H1): depois da adoção (comprovada:false), o agente recusa com BASELINE_NAO_COMPROVADA, sem guardião e sem mutação', async () => {
    const amb = await ambiente({ adotar: true });
    const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: amb.provedor }) });
    assert.equal(r.estado, 'RECUSADO', JSON.stringify(r));
    assert.equal(r.motivo, 'BASELINE_NAO_COMPROVADA');
    assert.equal(r.mutacao, 'NENHUMA');
    assert.equal(amb.guardioes.length, 0, 'nenhum guardião foi criado');
    assert.equal(amb.reinicios(), 0);
    assert.equal(amb.chamadas.dependencias, 0);
    const id = await amb.identificar();
    assert.equal(id.rotulo, rot(1));
    assert.equal(id.integro, false);
  });

  test('4C (D-H1): depois da adoção confirmada por processo e saúde, o agente segue normalmente e instala a release seguinte', async () => {
    const amb = await ambiente({ adotar: true });
    const confirmacao = await I.confirmarBaselineAdotada({
      config: amb.cfgAgente.instalador, componente: 'backend',
      deps: { criarAncora: ancoraPorCaminho, esperar: async () => {}, identificarProcesso: async () => ({ pid: 4242, cwd: fs.realpathSync(amb.link) }), verificarSaude: async () => ({ ok: true }) },
    });
    assert.equal(confirmacao.resultado, 'ADOCAO_CONFIRMADA');
    assert.equal(amb.reinicios(), 0, 'a confirmação não reinicia');
    const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: amb.provedor }) });
    assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
    assert.equal(await amb.instalada(), rot(2));
    assert.equal(amb.reinicios(), 1);
    assert.equal(P.validarRecibo(reciboDoBackend(amb.s3), amb.pedido).estado, 'SUCESSO');
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

  describe('3B-2B-1: o instalador real recebe a coordenação só pelo provedor do guardião', () => {
    const livre = () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date().toISOString() });

    test('cada revalidação do instalador pergunta ao guardião adquirido (antes do preparo, da troca e do reinício), e ao fim ele é liberado', async () => {
      const amb = await ambiente();
      let consultas = 0;
      const contador = C.homologarProvedorParaTeste(async () => { consultas += 1; return livre(); });
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: contador }) });
      assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
      assert.ok(consultas >= 3, `consultas: ${consultas}`);
      assert.equal(amb.guardioes.length, 1);
      assert.deepEqual([amb.guardioes[0].chamadas.adquirir, amb.guardioes[0].chamadas.liberar], [1, 1]);
      assert.deepEqual(amb.guardioes[0].tempo, ['adquirir', 'liberar']);
    });

    test('um consultarCoordenacao homologado nos extras do instalador não substitui o guardião: continua COORDENACAO_NAO_HOMOLOGADA', async () => {
      const amb = await ambiente();
      const deps = { ...amb.depsDoAgente(amb.controladas), depsExtrasDoInstalador: { ...amb.controladas, consultarCoordenacao: amb.provedor } };
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps });
      assert.deepEqual([r.estado, r.mutacao, r.motivo], ['RECUSADO', 'NENHUMA', 'COORDENACAO_NAO_HOMOLOGADA']);
      assert.equal(await amb.instalada(), rot(1));
      assert.equal(amb.reinicios(), 0);
    });

    test('perda da coordenação depois da troca e antes do reinício: nada é reiniciado, o link volta, nunca SUCESSO, guardião liberado', async () => {
      const amb = await ambiente();
      // 3B-2B-3A: o agente também confirma antes de cada ação; a perda passa a ser disparada pela própria troca do link.
      const perdeNoReinicio = C.homologarProvedorParaTeste(async () => (fs.realpathSync(amb.link) === amb.fisica(2) ? { situacao: 'DESCONHECIDO', origem: 'guardião: sessão perdida' } : livre()));
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: perdeNoReinicio }) });
      assert.equal(r.estado, 'CRITICO', JSON.stringify(r));
      assert.equal(r.diagnostico, 'COORDENACAO_NAO_CONFIRMADA');
      assert.equal(amb.reinicios(), 0, 'nada reiniciado');
      assert.equal(await amb.instalada(), rot(1), 'o link voltou para a release em uso');
      assert.equal(amb.guardioes[0].chamadas.liberar, 1);
      assert.equal(amb.armazem.has('@.trava-cd-backend'), true, 'a trava do agente fica para diagnóstico');
    });

    test('operação concorrente: o guardião recusa e nada do instalador roda (nem preparo, nem consulta)', async () => {
      const amb = await ambiente();
      let consultas = 0;
      const contador = C.homologarProvedorParaTeste(async () => { consultas += 1; return livre(); });
      const deps = amb.depsDoAgente({ ...amb.controladas, consultarCoordenacao: contador });
      deps.criarCoordenacao = () => { const g = coordenacaoFalsa({ aquisicao: { ok: false, motivo: 'MIGRACAO_EM_CURSO' }, consultar: contador }); amb.guardioes.push(g); return g.provedor; };
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps });
      assert.deepEqual([r.estado, r.mutacao, r.motivo], ['RECUSADO', 'NENHUMA', 'COORDENACAO_OCUPADA']);
      assert.equal(consultas, 0);
      assert.equal(amb.chamadas.dependencias, 0, 'nenhum preparo');
      assert.equal(await amb.instalada(), rot(1));
    });

    test('produção (sem dependência injetada): o agente inicia o guardião real na baseline física, sem segredo nem ambiente herdado, e o instalador continua recusando', async () => {
      const amb = await ambiente();
      const { criarCoordenacao, ...semGuardiaoFalso } = amb.depsDoAgente(amb.controladas);
      assert.equal(typeof criarCoordenacao, 'function');
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: semGuardiaoFalso });
      assert.deepEqual([r.estado, r.mutacao, r.motivo], ['RECUSADO', 'NENHUMA', 'COORDENACAO_NAO_HOMOLOGADA']);
      assert.equal(await amb.instalada(), rot(1));
      const execucoes = amb.execucoesDoGuardiao();
      const inicio = execucoes.find((e) => e.inicio);
      assert.ok(inicio, 'o guardião foi iniciado');
      assert.equal(inicio.marcador, 'release-1', 'é o roteiro da baseline, não o da candidata');
      assert.equal(inicio.roteiro, path.join(amb.fisica(1), 'scripts', 'guardiao-de-coordenacao.js'));
      assert.equal(fs.realpathSync(inicio.cwd), amb.fisica(1));
      assert.deepEqual(inicio.argv, ['--credencial', amb.cfgAgente.guardiao.credencial, '--sistema', SISTEMA_DO_CLUSTER]);
      // O macOS acrescenta por conta própria uma variável de codificação a todo processo; nada além dela é admitido.
      assert.deepEqual(inicio.ambiente.filter((k) => k !== '__CF_USER_TEXT_ENCODING'), []);
      assert.ok(execucoes.some((e) => e.recebido === 'liberar'), 'o agente pediu a liberação');
      assert.equal(amb.armazem.has('@.trava-cd-backend'), false);
    });

    test('vincularGuardiao: prende o roteiro à baseline física e recusa roteiro fora dela, executável na árvore de releases e argumento a mais', async () => {
      const amb = await ambiente();
      const v = A.vincularGuardiao(amb.cfgAgente, { rotulo: rot(1) });
      assert.equal(v.dir, amb.fisica(1));
      assert.deepEqual(v.comando, [process.execPath, path.join(amb.fisica(1), 'scripts', 'guardiao-de-coordenacao.js')]);
      assert.ok(Object.isFrozen(v) && Object.isFrozen(v.comando));
      const recusa = (guardiao, baseline = { rotulo: rot(1) }) => assert.throws(() => A.vincularGuardiao({ ...amb.cfgAgente, guardiao }, baseline), (e) => e.codigo === 'GUARDIAO_NAO_VINCULADO', JSON.stringify(guardiao));
      const ok = amb.cfgAgente.guardiao;
      recusa({ ...ok, comando: [process.execPath, '../../../../fora.js'] });
      recusa({ ...ok, comando: [process.execPath, 'scripts/nao-existe.js'] });
      recusa({ ...ok, comando: [path.join(amb.fisica(1), 'scripts', 'guardiao-de-coordenacao.js'), 'scripts/guardiao-de-coordenacao.js'] });
      recusa({ ...ok, comando: [process.execPath, 'scripts/guardiao-de-coordenacao.js', '--extra'] });
      recusa(ok, { rotulo: 'hml-qualquer' });
      recusa(ok, null);
    });
  });

  // 3B-2B-3A: com o instalador real, a garantia é conferida antes de cada ação dele; a perda no meio de uma ação já
  // iniciada deixa essa ação terminar, impede qualquer outra (inclusive o reinício de recuperação) e termina em CRITICO.
  describe('3B-2B-3A: perda da coordenação durante a instalação, com o instalador real', () => {
    const livre = () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date().toISOString() });
    // Consulta homologada só para o teste cuja posse cai quando o teste mandar; perder() derruba também a garantia local.
    function guardiaoQuePerde(amb, linha = []) {
      const sinal = { perdida: false };
      const consultar = C.homologarProvedorParaTeste(async () => { linha.push('consultar'); return sinal.perdida ? { situacao: 'DESCONHECIDO', origem: 'guardião: sessão perdida', consultadoEm: new Date().toISOString() } : livre(); });
      const perder = (motivo = 'PERDIDA') => { sinal.perdida = true; amb.guardioes.at(-1).perder(motivo); };
      return { consultar, perder, linha };
    }
    const registro = (amb) => JSON.parse(amb.armazem.get(`${ID}.json`));
    const semEspera = { esperar: async () => {} };

    test('CA-03: com posse contínua, cada ação do instalador vem logo depois de uma confirmação, e a confirmação final vem depois da última', async () => {
      const amb = await ambiente();
      const linha = [];
      const g = guardiaoQuePerde(amb, linha);
      const c = amb.controladas;
      const extras = {
        ...c, ...semEspera, consultarCoordenacao: g.consultar,
        executar: async (cmd, args, opc) => { if (!args.some((a) => a.endsWith('scripts/sonda-estado-observado.js'))) linha.push('dependencias'); return c.executar(cmd, args, opc); },
        identificarProcesso: async () => { linha.push('processo'); return c.identificarProcesso(); },
        verificarSaude: async () => { linha.push('saude'); return c.verificarSaude(); },
        reiniciar: async () => { linha.push('reiniciar'); },
      };
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente(extras) });
      assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
      const acoes = linha.map((e, i) => [e, i]).filter(([e]) => e !== 'consultar');
      assert.ok(acoes.length >= 4, linha.join(','));
      for (const [nome, i] of acoes) assert.equal(linha[i - 1], 'consultar', `${nome} sem confirmação imediatamente antes: ${linha.join(',')}`);
      assert.equal(linha.at(-1), 'consultar', 'a confirmação final vem depois da última ação');
      assert.equal(amb.guardioes[0].chamadas.confirmar, acoes.length + 1, 'uma confirmação do agente por ação, mais a final');
      assert.equal(registro(amb).coordenacao.confirmacaoFinal, true);
    });

    test('CA-04: perda durante o reinício: o reinício em curso termina, nenhuma ação nova começa, nada é revertido sem coordenação e o resultado é CRITICO', async () => {
      const amb = await ambiente();
      const g = guardiaoQuePerde(amb);
      let reinicios = 0;
      const extras = { ...amb.controladas, ...semEspera, consultarCoordenacao: g.consultar, reiniciar: async () => { reinicios += 1; g.perder('PERDIDA'); } };
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente(extras) });
      assert.deepEqual([r.estado, r.verificado, r.motivo], ['CRITICO', false, 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO'], JSON.stringify(r));
      assert.equal(reinicios, 1, 'nenhum reinício além do que já estava em curso (nem o de recuperação)');
      assert.equal(amb.chamadas.processo, 1, 'só a identificação anterior à troca');
      assert.equal(amb.chamadas.saude, 0, 'nenhuma verificação de saúde depois da perda');
      assert.equal(await amb.instalada(), rot(2), 'sem coordenação, nada é revertido');
      assert.equal(amb.armazem.has('@.trava-cd-backend'), true);
      assert.equal(reciboDoBackend(amb.s3).estado, 'CRITICO');
      const reg = registro(amb);
      assert.equal(reg.coordenacao.perda.codigo, 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO');
      assert.deepEqual([reg.coordenacao.ultimaAcao.nome, reg.coordenacao.ultimaAcao.terminou], ['reiniciar', true]);
      assert.equal(reg.coordenacao.guardiao.perda.motivo, 'PERDIDA');
      assert.equal(amb.guardioes[0].chamadas.liberar, 1);
    });

    test('CA-05: perda durante a verificação de saúde: nenhuma tentativa nova depois da perda e o resultado é CRITICO', async () => {
      const amb = await ambiente();
      const g = guardiaoQuePerde(amb);
      let saude = 0;
      const extras = { ...amb.controladas, ...semEspera, consultarCoordenacao: g.consultar, verificarSaude: async () => { saude += 1; g.perder('PERDIDA'); return { ok: false, detalhe: 'HTTP 503' }; } };
      const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente(extras) });
      assert.deepEqual([r.estado, r.motivo], ['CRITICO', 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO'], JSON.stringify(r));
      assert.equal(saude, 1, 'o instalador tenta 3 vezes; só a primeira chegou a acontecer');
      assert.equal(amb.reinicios(), 1, 'só o reinício da instalação, nenhum de recuperação');
      assert.equal(amb.armazem.has('@.trava-cd-backend'), true);
      assert.equal(registro(amb).coordenacao.ultimaAcao.nome, 'verificarSaude');
    });

    for (const motivo of ['PERDIDA', 'EXPIRADA']) {
      test(`CA-06/CA-07: ${motivo} depois da última consulta do instalador (saúde aprovada): a confirmação final reprova e o resultado é CRITICO`, async () => {
        const amb = await ambiente();
        const g = guardiaoQuePerde(amb);
        const extras = { ...amb.controladas, ...semEspera, consultarCoordenacao: g.consultar, verificarSaude: async () => { g.perder(motivo); return { ok: true, detalhe: 'ok' }; } };
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: amb.depsDoAgente(extras) });
        assert.deepEqual([r.estado, r.verificado, r.motivo], ['CRITICO', false, 'COORDENACAO_PERDIDA_DURANTE_INSTALACAO'], JSON.stringify(r));
        assert.equal(reciboDoBackend(amb.s3).estado, 'CRITICO');
        assert.throws(() => P.validarRecibo(reciboDoBackend(amb.s3), amb.pedido), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
        const reg = registro(amb);
        assert.deepEqual(reg.resultadoAntesDaLiberacao, undefined);
        assert.equal(reg.coordenacao.confirmacaoFinal, false);
        assert.equal(reg.coordenacao.guardiao.perda.motivo, motivo);
        assert.equal(amb.armazem.has('@.trava-cd-backend'), true);
      });
    }
  });

  // 3B-2B-3B (D8-B): ponta a ponta pelo principal, sem dependência injetada e sem homologarProvedorParaTeste na
  // operação: configuração oficial (caminho de teste, mesmas conferências), cliente S3 real (criarS3) diante de um
  // executável aws simulado, guardião real da baseline, instalador real com reinício, PID e saúde da configuração
  // (um serviço HTTP simulado). Exige Linux (LINUX_OBRIGATORIO e /proc): executa na CI.
  // Etapa 4C (D-H2): com `identidade`, o reinício simulado faz o papel do ExecStartPost do modelo e grava a identidade
  // do serviço (pid e caminho real do diretório; 0644, trocada por rename) num diretório próprio. `identidade` escolhe
  // o que é declarado: 'valida', 'ausente', 'antiga' (outro pid) ou 'outraRelease' (o diretório da release 1).
  // O reinício encerra o serviço anterior antes de subir o novo, como um restart; todos os pids são encerrados no fim.
  async function executarD8B({ identidade } = {}) {
    const I2 = require(path.join(RAIZ, 'deploy/hml/instalador/instalar-release'));
    const amb = await ambiente({ sondaReal: true });
    const raiz = amb.raiz;
    const porta = await new Promise((ok) => { const s = require('node:net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
    const pidDoServico = path.join(raiz, 'servico.pid');
    const todosOsPids = path.join(raiz, 'servicos.pids');
    const servico = path.join(raiz, 'servico.js');
    fs.writeFileSync(servico, `require('node:http').createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ status: 'ok', service: 'gestao-epi-api' })); }).listen(${porta}, '127.0.0.1');\n`);
    const dirIdentidade = path.join(raiz, 'run-safework-hml');
    const arquivoIdentidade = path.join(dirIdentidade, 'identidade');
    if (identidade) { fs.mkdirSync(dirIdentidade); fs.chmodSync(dirIdentidade, 0o755); }
    const gravarIdentidade = !identidade || identidade === 'ausente' ? [] : [
      `const declarado = ${identidade === 'antiga' ? 'filho.pid + 100000' : 'filho.pid'};`,
      `const cwd = fs.realpathSync(${JSON.stringify(identidade === 'outraRelease' ? amb.fisica(1) : amb.link)});`,
      `const t = ${JSON.stringify(path.join(dirIdentidade, '.identidade.tmp'))};`,
      'fs.writeFileSync(t, `${declarado} ${cwd}\\n`, { mode: 0o644 });',
      `fs.renameSync(t, ${JSON.stringify(arquivoIdentidade)});`,
    ];
    const reiniciar = path.join(raiz, 'reiniciar-servico.js');
    fs.writeFileSync(reiniciar, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      `try { process.kill(Number(fs.readFileSync(${JSON.stringify(pidDoServico)}, 'utf8')), 'SIGKILL'); } catch { /* primeiro início */ }`,
      'setTimeout(() => {',
      `  const filho = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(servico)}], { cwd: fs.realpathSync(${JSON.stringify(amb.link)}), detached: true, stdio: 'ignore' });`,
      `  fs.writeFileSync(${JSON.stringify(pidDoServico)}, String(filho.pid));`,
      `  fs.appendFileSync(${JSON.stringify(todosOsPids)}, \`\${filho.pid}\\n\`);`,
      ...gravarIdentidade.map((l) => `  ${l}`),
      '  filho.unref();',
      '  setTimeout(() => process.exit(0), 300);',
      '}, 200);',
      '',
    ].join('\n'));
    const bucket = path.join(raiz, 'bucket');
    for (const [k, v] of amb.s3.dados) { fs.mkdirSync(path.dirname(path.join(bucket, k)), { recursive: true }); fs.writeFileSync(path.join(bucket, k), v); }
    const aws = path.join(raiz, 'aws-simulado');
    fs.writeFileSync(aws, [
      `#!${process.execPath}`,
      "'use strict';",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const a = process.argv.slice(2);',
      'const valor = (n) => a[a.indexOf(n) + 1];',
      `const BUCKET = ${JSON.stringify(bucket)};`,
      "if (a[0] === 'sts') { process.stdout.write(JSON.stringify({ Account: '111111111111' })); process.exit(0); }",
      "const op = a[1]; const chave = valor('--key');",
      "if (op === 'get-object') { const f = path.join(BUCKET, chave); if (!fs.existsSync(f)) { process.stderr.write('An error occurred (NoSuchKey)'); process.exit(255); } fs.copyFileSync(f, a[a.indexOf('--expected-bucket-owner') + 2]); process.stdout.write('{}'); process.exit(0); }",
      "if (op === 'put-object') { const f = path.join(BUCKET, chave); if (fs.existsSync(f)) { process.stderr.write('(PreconditionFailed)'); process.exit(255); } fs.mkdirSync(path.dirname(f), { recursive: true }); fs.copyFileSync(valor('--body'), f); process.stdout.write('{}'); process.exit(0); }",
      "if (op === 'list-objects-v2') { const p = valor('--prefix'); const d = path.join(BUCKET, path.dirname(p)); const itens = fs.existsSync(d) ? fs.readdirSync(d).map((n) => path.posix.join(path.posix.dirname(p), n)).filter((k) => k.startsWith(p)) : []; process.stdout.write(JSON.stringify({ Contents: itens.map((Key) => ({ Key, LastModified: new Date().toISOString() })), IsTruncated: false })); process.exit(0); }",
      'process.exit(2);',
      '',
    ].join('\n'), { mode: 0o755 });
    const cfgOficial = JSON.parse(JSON.stringify(amb.cfgAgente));
    Object.assign(cfgOficial.instalador.componentes.backend, {
      reinicio: { comando: [process.execPath, reiniciar] },
      processo: { pidComando: [process.execPath, '-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(pidDoServico)}, 'utf8'))`] },
      saude: { url: `http://127.0.0.1:${porta}/api/health` },
    });
    cfgOficial.s3 = { ...cfgOficial.s3, executavel: aws };
    if (identidade) cfgOficial.identidadeDoServico = { arquivo: arquivoIdentidade, uid: process.getuid() };
    const caminho = path.join(fs.mkdtempSync(path.join(fs.realpathSync(tmp), 'oficial-')), 'agente-backend.json');
    fs.writeFileSync(caminho, JSON.stringify(cfgOficial), { mode: 0o640 });
    assert.equal(I2.lerConfiguracaoOficial(I2.origemDaConfiguracaoOficial(caminho)).habilitado, true, 'a configuração passa pelas conferências do leitor oficial');
    const credenciais = { AWS_ACCESS_KEY_ID: 'AKIASIMULADA00000000', AWS_SECRET_ACCESS_KEY: 'simulada', AWS_SESSION_TOKEN: 'simulada' };
    const antes = {};
    for (const [k, v] of Object.entries(credenciais)) { antes[k] = process.env[k]; process.env[k] = v; }
    // Toda leitura de /proc/<pid>/cwd feita neste processo durante a operação fica registrada.
    const leiturasDeCwd = [];
    const readlinkOriginal = fs.readlinkSync;
    fs.readlinkSync = function espiao(alvo, ...resto) { if (/^\/proc\/\d+\/cwd$/.test(String(alvo))) leiturasDeCwd.push(String(alvo)); return readlinkOriginal.call(this, alvo, ...resto); };
    try {
      await A.principal(['--config', caminho, '--pedido', ID]).catch((e) => { if (!identidade || identidade === 'valida') throw e; });
      const recibo = JSON.parse(fs.readFileSync(path.join(bucket, `hml-backend/recibos/${ID}.json`), 'utf8'));
      return { amb, recibo, leiturasDeCwd: [...leiturasDeCwd], caminho, bucket };
    } finally {
      fs.readlinkSync = readlinkOriginal;
      for (const k of Object.keys(credenciais)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
      const pids = fs.existsSync(todosOsPids) ? fs.readFileSync(todosOsPids, 'utf8').split('\n').filter(Boolean).map(Number) : [];
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* já encerrado */ } }
    }
  }
  const SO_LINUX = { skip: process.platform !== 'linux' ? 'exige Linux (LINUX_OBRIGATORIO e /proc): executa na CI' : false, timeout: 120000 };

  test('D8-B: fluxo de produção completo pelo principal, com C1, C2 e C3 de verdade, termina em SUCESSO', SO_LINUX, async () => {
    const { amb, recibo, caminho } = await executarD8B();
    assert.equal(P.validarRecibo(recibo, amb.pedido).estado, 'SUCESSO');
    assert.equal(await amb.instalada(), rot(2));
    const execucoes = amb.execucoesDoGuardiao();
    assert.equal(execucoes.find((e) => e.inicio).marcador, 'release-1', 'o guardião real da baseline');
    assert.ok(execucoes.some((e) => e.recebido === 'liberar'));
    // A mesma autorização não serve para outra execução: o pedido já tem recibo e a operação não se repete.
    const credenciais = { AWS_ACCESS_KEY_ID: 'AKIASIMULADA00000000', AWS_SECRET_ACCESS_KEY: 'simulada', AWS_SESSION_TOKEN: 'simulada' };
    const antes = {};
    for (const [k, v] of Object.entries(credenciais)) { antes[k] = process.env[k]; process.env[k] = v; }
    try {
      await A.principal(['--config', caminho, '--pedido', ID]);
    } finally {
      for (const k of Object.keys(credenciais)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
    }
    assert.equal(execucoes.filter((e) => e.inicio).length, amb.execucoesDoGuardiao().filter((e) => e.inicio).length, 'nenhum guardião novo');
  });

  test('4C (D-H2): D8-B com a identidade do serviço em /run termina em SUCESSO sem ler /proc/<pid>/cwd', SO_LINUX, async () => {
    const { amb, recibo, leiturasDeCwd } = await executarD8B({ identidade: 'valida' });
    assert.equal(P.validarRecibo(recibo, amb.pedido).estado, 'SUCESSO');
    assert.equal(await amb.instalada(), rot(2));
    assert.deepEqual(leiturasDeCwd, [], 'com a identidade configurada, o agente não lê o cwd do processo do serviço');
  });

  for (const [identidade, descricao] of [['ausente', 'ausente'], ['antiga', 'antiga (outro pid)'], ['outraRelease', 'que declara outra release']]) {
    test(`4C (D-H2): identidade ${descricao} impede a prova de versão: nunca SUCESSO, recibo CRITICO`, SO_LINUX, async () => {
      const { amb, recibo, leiturasDeCwd } = await executarD8B({ identidade });
      assert.equal(recibo.estado, 'CRITICO');
      assert.throws(() => P.validarRecibo(recibo, amb.pedido), (e) => e.codigo === 'DEPLOY_NAO_APROVADO');
      assert.deepEqual(leiturasDeCwd, []);
    });
  }

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

  // 3B-2B-1: o agente passa a ler a "situacao" do resultado da LIBERAÇÃO do guardião; nunca declara estado de coordenação.
  test('o agente não fabrica coordenação: só repassa o que depsDoConfig monta, a leitura da sonda e o consultar do guardião', () => {
    const fonte = fs.readFileSync(AG, 'utf8');
    assert.match(fonte, /I\.depsDoConfig\(/);
    assert.match(fonte, /lerObservado/);
    assert.doesNotMatch(fonte, /LIVRE|OCUPADO|DESCONHECIDO/);
    // Bloco da liberação: do conjunto ENCERRAMENTO_COMPROVADO até o fim de liberarGuardiao. Fora dele, só a leitura do
    // resultado já classificado (liberacaoDaCoordenacao.situacao).
    const ini = fonte.indexOf('const ENCERRAMENTO_COMPROVADO');
    const liberacao = fonte.slice(ini, fonte.indexOf('\n}\n', fonte.indexOf('async function liberarGuardiao(')));
    assert.ok(ini > 0 && liberacao.includes('async function liberarGuardiao('));
    const fora = fonte.slice(0, ini) + fonte.slice(ini + liberacao.length);
    assert.equal((fora.match(/situacao/g) || []).length, (fora.match(/liberacaoDaCoordenacao\.situacao/g) || []).length, 'situacao fora do bloco da liberação só como leitura do resultado da liberação');
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

    // 4C (D-H3): as credenciais temporárias da AWS chegam ao processo do agente só pelo contrato do s3.js. As ações do
    // agente (npm ci, sonda, reinício, PID) recebem um ambiente fixo e mínimo, sem nenhuma variável AWS_.
    test('4C (D-H3): as ações do agente recebem ambiente fixo e mínimo, sem as credenciais AWS do processo do agente', async () => {
      const amb = await ambiente();
      const credenciais = { AWS_ACCESS_KEY_ID: 'ASIASIMULADA00000000', AWS_SECRET_ACCESS_KEY: 'segredo-aws-simulado', AWS_SESSION_TOKEN: 'token-aws-simulado' };
      const antes = {};
      for (const [k, v] of Object.entries(credenciais)) { antes[k] = process.env[k]; process.env[k] = v; }
      try {
        const r = await A.processar({ cfg: amb.cfgAgente, id: ID, s3: amb.s3, deps: comCoordenacao(amb) });
        assert.equal(r.estado, 'SUCESSO', JSON.stringify(r));
      } finally {
        for (const k of Object.keys(credenciais)) { if (antes[k] === undefined) delete process.env[k]; else process.env[k] = antes[k]; }
      }
      const filho = JSON.parse(fs.readFileSync(amb.ambienteDoReinicio, 'utf8'));
      assert.deepEqual(Object.keys(filho.env).filter((k) => !/^(__CF_USER_TEXT_ENCODING|LC_CTYPE)$/.test(k)).sort(), ['HOME', 'PATH'], 'só PATH e HOME');
      assert.equal(filho.env.PATH, '/usr/local/bin:/usr/bin:/bin');
      assert.doesNotMatch(JSON.stringify(filho), /AWS_|segredo-aws-simulado|token-aws-simulado/);
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

    test('3B-2B-1: a configuração precisa declarar o guardião: executável absoluto e roteiro (só os dois), credencial absoluta e própria', () => {
      const ok = configValida().guardiao;
      for (const guardiao of [undefined, null, {}, { ...ok, comando: 'x' }, { ...ok, comando: [process.execPath] }, { ...ok, comando: ['node', 'scripts/guardiao-de-coordenacao.js'] },
        { ...ok, comando: [process.execPath, 'scripts/guardiao-de-coordenacao.js', '--extra'] }, { ...ok, comando: [process.execPath, ''] },
        // 3B-2B-3B (H-08): o roteiro é o caminho fixo que o instalador confere na baseline.
        { ...ok, comando: [process.execPath, 'scripts/outro-guardiao.js'] }, { ...ok, comando: [process.execPath, './scripts/guardiao-de-coordenacao.js'] },
        { ...ok, credencial: undefined }, { ...ok, credencial: 'relativo/credencial.json' }, { ...ok, credencial: '' }]) {
        const c = configValida();
        c.guardiao = guardiao;
        recusaConfig(c, 'GUARDIAO_NAO_CONFIGURADO');
      }
      const mesma = configValida();
      mesma.guardiao.credencial = mesma.sonda.credencial;
      recusaConfig(mesma, 'GUARDIAO_NAO_CONFIGURADO');
    });

    test('3B-2B-1: o modelo de configuração declara o guardião com marcadores, nasce desabilitado e o roteiro existe no backend', () => {
      const modelo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd/agente.config.backend.exemplo.json'), 'utf8'));
      assert.equal(modelo.habilitado, false);
      assert.deepEqual(Object.keys(modelo.guardiao).sort(), ['comando', 'credencial']);
      assert.equal(modelo.guardiao.comando.length, 2);
      assert.ok(path.isAbsolute(modelo.guardiao.comando[0]));
      assert.equal(modelo.guardiao.comando[1], 'scripts/guardiao-de-coordenacao.js');
      assert.ok(fs.existsSync(path.join(RAIZ, 'backend', modelo.guardiao.comando[1])));
      assert.ok(path.isAbsolute(modelo.guardiao.credencial));
      assert.notEqual(modelo.guardiao.credencial, modelo.sonda.credencial);
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
  // 3B-2B-1: a coordenação passa a existir no agente, mas só por um caminho: o provedor do guardião. O agente não homologa,
  // não consulta o registro de homologados, não importa a coordenação do instalador e não declara estado.
  test('não contorna a coordenação nem a prova de versão: a coordenação vem só do provedor do guardião', () => {
    for (const proibido of ['homologarProvedorParaTeste', 'provedorHomologado', 'PROVEDORES_HOMOLOGADOS', 'atestarSemOperacao', 'semComprovacaoDeVersao', 'permitirRoot', 'consultaPadrao']) {
      assert.ok(!fonte.includes(proibido), `não deve citar ${proibido}`);
    }
    assert.doesNotMatch(fonte, /require\([^)]*instalador\/coordenacao['"]\)/);
    assert.match(fonte, /require\('\.\/coordenacao-por-guardiao'\)/);
    assert.deepEqual([...fonte.matchAll(/consultarCoordenacao\s*=\s*([^;\n]+);/g)].map((m) => m[1].trim()), ['coordenacao ? coordenacao.consultar : undefined'], 'a única origem é o consultar do provedor adquirido');
    assert.equal((fonte.match(/consultarCoordenacao/g) || []).length, 1, 'nenhum outro uso');
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

  // 3B-2B-3B: C1 e C3 no agente. A configuração só vem do caminho oficial; o cliente S3 oficial só nasce em principal;
  // a autorização da operação só é emitida para esse cliente, e o emissor (de uso único) é pego ao carregar o módulo.
  // Fora do Linux, LINUX_OBRIGATORIO continua vindo antes (comportamento protegido); no Linux, fora de testes, um
  // caminho que não seja o oficial é recusado antes de qualquer leitura.
  test('3B-2B-3B: principal só aceita a configuração do caminho oficial', async () => {
    const I = require(path.join(RAIZ, 'deploy/hml/instalador/instalar-release'));
    const esperado = process.platform === 'linux' ? 'CONFIG_NAO_OFICIAL' : 'LINUX_OBRIGATORIO';
    const antes = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      await assert.rejects(A.principal(['--config', '/tmp/qualquer.json', '--pedido', '1-1']), (e) => e.codigo === esperado);
      await assert.rejects(A.principal(['--config', path.join(tmp, 'x.json'), '--pendentes']), (e) => e.codigo === esperado);
      assert.throws(() => I.origemDaConfiguracaoOficial('/tmp/qualquer.json'), (e) => e.codigo === 'CONFIG_NAO_OFICIAL');
    } finally {
      if (antes !== undefined) process.env.NODE_ENV = antes;
    }
    const fonte = fs.readFileSync(AG, 'utf8');
    const principal = fonte.slice(fonte.indexOf('async function principal('));
    assert.ok(principal.indexOf("'LINUX_OBRIGATORIO'") < principal.indexOf('I.origemDaConfiguracaoOficial(argv[1])'));
    assert.ok(principal.indexOf('I.origemDaConfiguracaoOficial(argv[1])') < principal.indexOf('criarS3('), 'a origem é conferida antes de criar o cliente S3');
  });

  test('3B-2B-3B: só principal registra cliente S3 oficial, a emissão exige esse cliente e o emissor é pego uma vez, no carregamento', () => {
    assert.equal((fonte.match(/CLIENTES_S3_OFICIAIS\.add\(/g) || []).length, 1);
    const principal = fonte.slice(fonte.indexOf('async function principal('));
    assert.match(principal, /CLIENTES_S3_OFICIAIS\.add\(s3\)/);
    assert.match(fonte, /CLIENTES_S3_OFICIAIS\.has\(s3\)[\s\S]{0,200}EMISSOR\.emitir\(/);
    assert.equal((fonte.match(/EMISSOR\.emitir\(/g) || []).length, 1);
    assert.match(fonte, /^const EMISSOR = obterEmissorDeAutorizacoes\(\);$/m);
    assert.throws(() => require(path.join(RAIZ, 'deploy/hml/cd/coordenacao-por-guardiao')).obterEmissorDeAutorizacoes(), (e) => e.codigo === 'AUTORIZACAO_EMISSOR_INDISPONIVEL', 'o agente já pegou o emissor');
    assert.doesNotMatch(fonte, /lerConfigSegura\(argv/);
  });

  test('3B-2B-3A: os processos das ações do agente só são executados pelo executor com prazo', () => {
    assert.match(fonte, /require\('\.\/executor-com-prazo'\)/);
    const executor = fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd/executor-com-prazo.js'), 'utf8');
    assert.doesNotMatch(executor, /shell:\s*true|exec\(|execSync|spawnSync/);
    assert.doesNotMatch(executor, /process\.kill\(\s*-?1\s*[,)]/, 'nunca sinaliza todos os processos');
  });
});

// Etapa 4C (D-H2): o agente roda com usuário próprio e não lê o /proc/<pid>/cwd de um serviço de outro usuário. O
// systemd grava a identidade do serviço em /run (ExecStartPost, modelo inerte) e o agente a confere: arquivo, dono,
// permissões, formato, pid igual ao MainPID e uid do processo. É evidência condicionada ao modelo de confiança (só o
// usuário do serviço e root escrevem), não atestação independente.
describe('Etapa 4C (D-H2): identidade do serviço em /run', () => {
  const uidDoTeste = typeof process.getuid === 'function' ? process.getuid() : 0;
  const mesmoUid = () => uidDoTeste;
  function cenario({ texto, modo = 0o644, modoDoDir = 0o755 } = {}) {
    const dir = path.join(fs.realpathSync(tmp), 'run-safework-hml');
    fs.mkdirSync(dir);
    fs.chmodSync(dir, modoDoDir);
    const release = fs.mkdtempSync(path.join(fs.realpathSync(tmp), 'release-'));
    const arquivo = path.join(dir, 'identidade');
    if (texto !== null) {
      fs.writeFileSync(arquivo, texto === undefined ? `4242 ${release}\n` : texto);
      fs.chmodSync(arquivo, modo);
    }
    return { dir, arquivo, release, identidade: { arquivo, uid: uidDoTeste } };
  }
  const recusa = (e) => e.codigo === 'IDENTIDADE_DO_SERVICO_INVALIDA';

  test('identidade válida: devolve o pid e o caminho declarados para a prova de versão do instalador', () => {
    const c = cenario();
    assert.deepEqual(A.lerIdentidadeDoServico(c.identidade, 4242, { uidDoProcesso: mesmoUid }), { pid: 4242, cwd: c.release });
  });

  test('recusa o arquivo ausente, vazio, grande demais, com link simbólico, de outro dono, gravável por grupo ou outros e com dois links físicos', () => {
    assert.throws(() => A.lerIdentidadeDoServico(cenario({ texto: null }).identidade, 4242, { uidDoProcesso: mesmoUid }), recusa, 'ausente');
    fs.rmSync(path.join(tmp, 'run-safework-hml'), { recursive: true, force: true });
    assert.throws(() => A.lerIdentidadeDoServico(cenario({ texto: '' }).identidade, 4242, { uidDoProcesso: mesmoUid }), recusa, 'vazio');
    fs.rmSync(path.join(tmp, 'run-safework-hml'), { recursive: true, force: true });
    assert.throws(() => A.lerIdentidadeDoServico(cenario({ texto: `4242 /${'a'.repeat(5000)}\n` }).identidade, 4242, { uidDoProcesso: mesmoUid }), recusa, 'grande demais');
    for (const modo of [0o664, 0o646, 0o666]) {
      fs.rmSync(path.join(tmp, 'run-safework-hml'), { recursive: true, force: true });
      assert.throws(() => A.lerIdentidadeDoServico(cenario({ modo }).identidade, 4242, { uidDoProcesso: mesmoUid }), recusa, `modo ${modo.toString(8)}`);
    }
    fs.rmSync(path.join(tmp, 'run-safework-hml'), { recursive: true, force: true });
    const c = cenario();
    assert.throws(() => A.lerIdentidadeDoServico({ ...c.identidade, uid: uidDoTeste + 1 }, 4242, { uidDoProcesso: () => uidDoTeste + 1 }), recusa, 'outro dono');
    const real = path.join(c.dir, 'real');
    fs.renameSync(c.arquivo, real);
    fs.symlinkSync(real, c.arquivo);
    assert.throws(() => A.lerIdentidadeDoServico(c.identidade, 4242, { uidDoProcesso: mesmoUid }), recusa, 'link simbólico');
    fs.rmSync(c.arquivo);
    fs.linkSync(real, c.arquivo);
    assert.throws(() => A.lerIdentidadeDoServico(c.identidade, 4242, { uidDoProcesso: mesmoUid }), recusa, 'dois links físicos');
  });

  test('recusa formato fora do contrato: sem quebra final, caminho relativo ou não normalizado, pid inválido, campos a mais e NUL', () => {
    const casos = ['4242 /x', '4242 x/y\n', '4242 /x/../y\n', '4242 /x/\n', '0 /x\n', '-1 /x\n', '04242 /x\n', '4242 /x extra\n', '4242  /x\n', '4242 /x\n\n', '4242 /x\u0000\n', ' 4242 /x\n', '4242\t/x\n'];
    for (const texto of casos) {
      fs.rmSync(path.join(tmp, 'run-safework-hml'), { recursive: true, force: true });
      assert.throws(() => A.lerIdentidadeDoServico(cenario({ texto }).identidade, 4242, { uidDoProcesso: mesmoUid }), recusa, JSON.stringify(texto));
    }
  });

  test('recusa identidade antiga: o pid declarado não é o MainPID informado pelo systemd', () => {
    const c = cenario();
    assert.throws(() => A.lerIdentidadeDoServico(c.identidade, 4243, { uidDoProcesso: mesmoUid }), recusa);
  });

  test('recusa diretório da identidade gravável por grupo ou outros, de outro dono ou alcançado por link simbólico', () => {
    assert.throws(() => A.lerIdentidadeDoServico(cenario({ modoDoDir: 0o777 }).identidade, 4242, { uidDoProcesso: mesmoUid }), recusa, 'gravável');
    fs.rmSync(path.join(tmp, 'run-safework-hml'), { recursive: true, force: true });
    const c = cenario();
    const atalho = path.join(fs.realpathSync(tmp), 'atalho');
    fs.symlinkSync(c.dir, atalho);
    assert.throws(() => A.lerIdentidadeDoServico({ ...c.identidade, arquivo: path.join(atalho, 'identidade') }, 4242, { uidDoProcesso: mesmoUid }), recusa, 'link no caminho');
  });

  test('recusa quando o processo do MainPID não pertence ao usuário do serviço', () => {
    const c = cenario();
    assert.throws(() => A.lerIdentidadeDoServico(c.identidade, 4242, { uidDoProcesso: () => uidDoTeste + 7 }), recusa);
    assert.throws(() => A.lerIdentidadeDoServico(c.identidade, 4242, { uidDoProcesso: () => { throw new Error('sem /proc'); } }), recusa);
  });

  test('configuração: identidadeDoServico é opcional; presente, precisa de caminho absoluto normalizado fora das releases e uid numérico', () => {
    const base = path.join(fs.realpathSync(tmp), 'base');
    const estadoDir = path.join(fs.realpathSync(tmp), 'estado');
    const protegida = path.join(fs.realpathSync(tmp), 'protegida');
    for (const d of [base, estadoDir, protegida]) fs.mkdirSync(d);
    const cfgValida = {
      habilitado: true, isolamentoRevisado: 'RAIZES_EXCLUSIVAS_HOMOLOGACAO_BACKEND', estadoDir, raizesProtegidas: [protegida],
      s3: { bucket: 'hml-exemplo-teste', conta: '111111111111', regiao: 'us-east-1', executavel: '/usr/local/bin/aws', prefixo: 'hml-backend' },
      sonda: { comando: ['/usr/bin/node', 'scripts/sonda-estado-observado.js'], credencial: '/c/sonda.json', banco: 'hml', sistema: SISTEMA_DO_CLUSTER },
      guardiao: { comando: ['/usr/bin/node', 'scripts/guardiao-de-coordenacao.js'], credencial: '/c/guardiao.json' },
      instalador: { retencao: 3, raizesPersistentes: [], componentes: { backend: { tipo: 'backend', base, nome: 'backend', saude: { url: 'http://127.0.0.1:3000/api/health' }, reinicio: { comando: ['/bin/true'] }, processo: { pidComando: ['/bin/true'] } } } },
    };
    assert.equal(A.validarConfiguracao(cfgValida), cfgValida, 'sem a seção: comportamento anterior');
    assert.doesNotThrow(() => A.validarConfiguracao({ ...cfgValida, identidadeDoServico: { arquivo: '/run/safework-hml/identidade', uid: 1000 } }));
    const invalidas = [null, 'x', {}, { arquivo: 'run/identidade', uid: 1000 }, { arquivo: '/run/x/../identidade', uid: 1000 }, { arquivo: '/run/identidade/', uid: 1000 },
      { arquivo: '/run/identidade', uid: '1000' }, { arquivo: '/run/identidade', uid: -1 }, { arquivo: '/run/identidade', uid: 1.5 }, { arquivo: '/run/identidade', uid: 1000, extra: true },
      { arquivo: path.join(base, '.releases', 'identidade'), uid: 1000 }, { arquivo: path.join(estadoDir, 'identidade'), uid: 1000 }, { arquivo: path.join(protegida, 'identidade'), uid: 1000 }];
    for (const identidadeDoServico of invalidas) {
      assert.throws(() => A.validarConfiguracao({ ...cfgValida, identidadeDoServico }), (e) => e.codigo === 'IDENTIDADE_DO_SERVICO_INVALIDA', JSON.stringify(identidadeDoServico));
    }
  });

  test('o código nunca lê o environ de outro processo; o /proc/<pid>/cwd só é lido sem a identidade configurada', () => {
    const fonte = fs.readFileSync(AG, 'utf8');
    assert.doesNotMatch(fonte, /environ/);
    assert.doesNotMatch(fonte, /CAP_SYS_PTRACE|ptrace/i);
    const ocorrencias = [...fonte.matchAll(/\/proc\/\$\{pid\}\/cwd/g)];
    assert.equal(ocorrencias.length, 1, 'um único ponto de leitura do cwd');
    // 4C (D-H1, opção 1): o leitor da identidade fica no instalador, usado pelo agente e pela confirmação da adoção.
    const instalador = fs.readFileSync(path.join(RAIZ, 'deploy/hml/instalador/instalar-release.js'), 'utf8');
    assert.doesNotMatch(instalador, /environ|CAP_SYS_PTRACE/);
    const inicio = instalador.indexOf('function lerIdentidadeDoServico(');
    assert.ok(inicio > 0, 'o leitor existe no instalador');
    const funcao = instalador.slice(inicio, instalador.indexOf('\n}\n', inicio));
    assert.doesNotMatch(funcao, /readlink|\/cwd/);
    assert.equal(fonte.includes('function lerIdentidadeDoServico('), false, 'uma única implementação');
    const identificacao = fonte.slice(fonte.indexOf('function criarIdentificacaoDoProcesso('), fonte.indexOf('\n}\n', fonte.indexOf('function criarIdentificacaoDoProcesso(')));
    assert.match(identificacao, /if \(identidade\) return I\.lerIdentidadeDoServico\(identidade, pid\);\s*return \{ pid, cwd: fs\.readlinkSync\(`\/proc\/\$\{pid\}\/cwd`\) \};/);
  });

  // Opção A da 4C: UIDs distintos de verdade, só no runner efêmero do GitHub Actions (sudo sem senha). O usuário é
  // temporário, criado e removido aqui; fora do Linux ou fora do Actions o teste não roda, e no Actions a falta de sudo
  // reprova em vez de pular. Nada disso roda no Mac nem na HML.
  const NO_ACTIONS = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true';
  test('4C (D-H2): com UIDs distintos, o cwd e o environ do serviço são inacessíveis e só a identidade do dono do serviço é aceita', {
    skip: NO_ACTIONS ? false : 'só no runner efêmero do GitHub Actions (Linux, usuário temporário)', timeout: 60000,
  }, async () => {
    const { execFileSync, spawn } = require('node:child_process');
    assert.notEqual(process.getuid(), 0, 'o agente do teste não é root');
    execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
    const nome = `swcd4c${crypto.randomBytes(4).toString('hex')}`;
    const base = fs.mkdtempSync('/tmp/cd4c-');
    fs.chmodSync(base, 0o755);
    const release = path.join(base, 'release');
    fs.mkdirSync(release, { mode: 0o755 });
    fs.chmodSync(release, 0o755);
    const dirIdentidade = `/tmp/cd4c-run-${nome}`;
    const roteiro = path.join(base, 'servico.js');
    fs.writeFileSync(roteiro, [
      "'use strict';",
      "const fs = require('node:fs');",
      'const [dir, release] = process.argv.slice(2);',
      'process.chdir(release);',
      'process.umask(0o022);',
      'fs.mkdirSync(dir, { mode: 0o755 });',
      "fs.writeFileSync(dir + '/.t', `${process.pid} ${fs.realpathSync(process.cwd())}\\n`, { mode: 0o644 });",
      "fs.renameSync(dir + '/.t', dir + '/identidade');",
      'process.stdout.write(`PRONTO ${process.pid}\\n`);',
      "process.stdin.on('data', () => {});",
      "process.stdin.on('end', () => { try { fs.rmSync(dir + '/identidade'); fs.rmdirSync(dir); } finally { process.exit(0); } });",
      '',
    ].join('\n'), { mode: 0o644 });
    let filho;
    let pid;
    let criado = false;
    try {
      execFileSync('sudo', ['-n', 'useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', nome], { stdio: 'ignore' });
      criado = true;
      const uidDoServico = Number(execFileSync('id', ['-u', nome], { encoding: 'utf8' }).trim());
      assert.notEqual(uidDoServico, process.getuid());
      filho = spawn('sudo', ['-n', '-u', nome, '--', process.execPath, roteiro, dirIdentidade, release], { stdio: ['pipe', 'pipe', 'inherit'] });
      pid = await new Promise((ok, falhou) => {
        let saida = '';
        filho.stdout.on('data', (b) => { saida += b; const m = /PRONTO (\d+)\n/.exec(saida); if (m) ok(Number(m[1])); });
        filho.on('exit', (c) => falhou(new Error(`serviço encerrou antes de ficar pronto (${c})`)));
      });
      // O método anterior não funciona entre usuários: o agente não lê o cwd nem o environ do serviço.
      assert.throws(() => fs.readlinkSync(`/proc/${pid}/cwd`), (e) => e.code === 'EACCES' || e.code === 'EPERM');
      assert.throws(() => fs.readFileSync(`/proc/${pid}/environ`), (e) => e.code === 'EACCES' || e.code === 'EPERM');
      const identidade = { arquivo: path.join(dirIdentidade, 'identidade'), uid: uidDoServico };
      // Pela identidade, com o uid real do processo lido de /proc/<pid>/status (sem privilégio).
      assert.deepEqual(A.lerIdentidadeDoServico(identidade, pid), { pid, cwd: fs.realpathSync(release) });
      const identificar = A.criarIdentificacaoDoProcesso({ pidComando: [process.execPath, '-e', `process.stdout.write('${pid}')`] }, identidade);
      assert.deepEqual(await identificar(), { pid, cwd: fs.realpathSync(release) });
      assert.throws(() => A.lerIdentidadeDoServico(identidade, pid + 1), (e) => e.codigo === 'IDENTIDADE_DO_SERVICO_INVALIDA', 'identidade antiga');
      assert.throws(() => A.lerIdentidadeDoServico({ ...identidade, uid: process.getuid() }, pid), (e) => e.codigo === 'IDENTIDADE_DO_SERVICO_INVALIDA', 'dono do arquivo diferente do configurado');
      // O usuário do agente não consegue escrever no diretório do serviço, e uma identidade forjada por ele é recusada.
      assert.throws(() => fs.writeFileSync(path.join(dirIdentidade, 'identidade'), `${pid} /\n`), (e) => e.code === 'EACCES');
      const forjada = fs.mkdtempSync('/tmp/cd4c-forjada-');
      fs.chmodSync(forjada, 0o755);
      fs.writeFileSync(path.join(forjada, 'identidade'), `${pid} ${fs.realpathSync(release)}\n`, { mode: 0o644 });
      assert.throws(() => A.lerIdentidadeDoServico({ arquivo: path.join(forjada, 'identidade'), uid: uidDoServico }, pid), (e) => e.codigo === 'IDENTIDADE_DO_SERVICO_INVALIDA', 'forjada pelo agente');
      fs.rmSync(forjada, { recursive: true, force: true });
    } finally {
      if (filho && filho.exitCode === null) {
        const fim = new Promise((ok) => filho.on('exit', ok));
        filho.stdin.end();
        await Promise.race([fim, new Promise((ok) => setTimeout(ok, 5000))]);
        if (filho.exitCode === null && pid) { try { execFileSync('sudo', ['-n', 'kill', '-9', String(pid)], { stdio: 'ignore' }); } catch { /* já encerrado */ } }
      }
      if (criado) execFileSync('sudo', ['-n', 'userdel', nome], { stdio: 'ignore' });
      fs.rmSync(base, { recursive: true, force: true });
    }
    assert.equal(fs.existsSync(dirIdentidade), false, 'o serviço removeu o próprio diretório');
  });

  describe('modelos inertes do systemd e do polkit', () => {
    const ler = (rel) => fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd', rel), 'utf8');
    test('regra polkit: só o usuário do agente, só restart, só safework-hml.service; o resto segue a política padrão', () => {
      const vm = require('node:vm');
      const texto = ler('polkit-safework-cd-backend.rules.modelo');
      assert.match(texto, /INERTE/);
      const regras = [];
      const Result = { YES: 'yes', NOT_HANDLED: 'nh' };
      vm.runInNewContext(texto.replace(/USUARIO_DO_AGENTE_BACKEND/g, 'safework-cd-backend'), { polkit: { addRule: (f) => regras.push(f), Result } });
      assert.equal(regras.length, 1);
      const decidir = (id, unit, verb, user) => regras[0]({ id, lookup: (k) => ({ unit, verb })[k] }, { user });
      const ID = 'org.freedesktop.systemd1.manage-units';
      assert.equal(decidir(ID, 'safework-hml.service', 'restart', 'safework-cd-backend'), 'yes');
      for (const verb of ['start', 'stop', 'reload', 'reload-or-restart', 'try-restart', 'kill', undefined]) assert.notEqual(decidir(ID, 'safework-hml.service', verb, 'safework-cd-backend'), 'yes', `verbo ${verb}`);
      for (const unit of ['nginx.service', 'postgresql@16-main.service', 'safework-cd-agente.service', 'safework-hml.service.d', undefined]) assert.notEqual(decidir(ID, unit, 'restart', 'safework-cd-backend'), 'yes', `unidade ${unit}`);
      for (const user of ['ubuntu', 'safework-deploy', 'root', undefined]) assert.notEqual(decidir(ID, 'safework-hml.service', 'restart', user), 'yes', `usuário ${user}`);
      for (const id of ['org.freedesktop.systemd1.manage-unit-files', 'org.freedesktop.systemd1.reload-daemon', 'org.freedesktop.systemd1.set-environment']) assert.notEqual(decidir(id, 'safework-hml.service', 'restart', 'safework-cd-backend'), 'yes', id);
    });
    test('drop-in 91 e o gravador da identidade: identidade em /run, removida no stop, sem ler environ nem .env', () => {
      const dropin = ler('safework-hml-91-cd-backend.conf.modelo');
      assert.match(dropin, /INERTE/);
      assert.match(dropin, /^\[Service\]$/m);
      assert.match(dropin, /^WorkingDirectory=BASE_DO_CD_BACKEND\/backend$/m);
      assert.match(dropin, /^RuntimeDirectory=safework-hml$/m);
      assert.match(dropin, /^RuntimeDirectoryMode=0755$/m);
      assert.match(dropin, /^ExecStartPost=-\/usr\/local\/lib\/safework-cd\/gravar-identidade-do-servico$/m);
      assert.doesNotMatch(dropin, /^(User|Group|EnvironmentFile|Environment|ExecStart)=/m, 'não muda usuário, ambiente nem o comando do serviço');
      const gravador = ler('gravar-identidade-do-servico.modelo');
      assert.match(gravador, /^#!\/bin\/sh$/m);
      assert.match(gravador, /INERTE/);
      assert.match(gravador, /^set -eu$/m);
      assert.match(gravador, /^umask 022$/m);
      assert.match(gravador, /"\$\{MAINPID:\?\}"/);
      assert.match(gravador, /readlink -f "\/proc\/\$pid\/cwd"/);
      assert.match(gravador, /mktemp \/run\/safework-hml\/\.identidade\.XXXXXX/);
      assert.match(gravador, /chmod 0644 "\$t"/);
      assert.match(gravador, /mv -f "\$t" \/run\/safework-hml\/identidade/);
      assert.doesNotMatch(gravador, /environ|\.env\b|sudo|curl|wget/);
    });
  });
});

// 3B-2B-3A: executor das ações do agente (dependências, reinício, identificação do processo) com prazo efetivo. Cada
// comando roda num grupo de processos próprio; no prazo, o grupo inteiro é encerrado (SIGTERM, depois SIGKILL) e o fim é
// CONFERIDO, não presumido pelo envio do sinal. Os testes usam processos Node reais e conferem que nada sobrevive.
describe('3B-2B-3A: executor com prazo efetivo', () => {
  const E = () => require(path.join(RAIZ, 'deploy/hml/cd/executor-com-prazo.js'));
  const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
  const lerPids = (arquivo) => { try { return fs.readFileSync(arquivo, 'utf8').split('\n').filter(Boolean).map(Number); } catch { return []; } };
  const esperarAte = async (cond, ms = 3000) => { const fim = Date.now() + ms; while (!cond() && Date.now() < fim) await new Promise((r) => { setTimeout(r, 20); }); return cond(); };
  // Pai que registra o próprio pid e o de um neto (no mesmo grupo) e fica preso; opcionalmente ignora SIGTERM.
  function roteiroPreso(arquivo, { ignorarTerm = false, paiSai = false } = {}) {
    const roteiro = path.join(tmp, 'preso.js');
    fs.writeFileSync(roteiro, `'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
${ignorarTerm ? "process.on('SIGTERM', () => {});" : ''}
const neto = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(arquivo)}, process.pid + '\\n' + neto.pid + '\\n');
${paiSai ? 'neto.unref(); setTimeout(() => process.exit(0), 100);' : 'setInterval(() => {}, 1000);'}
`);
    return roteiro;
  }

  test('comando que termina bem: devolve a saída padrão', async () => {
    assert.equal(await E().executarComPrazo(process.execPath, ['-e', "process.stdout.write('ok')"], { prazoMs: 5000 }), 'ok');
  });

  test('comando que falha: ACAO_FALHOU com o começo do erro, sem prazo envolvido', async () => {
    await assert.rejects(E().executarComPrazo(process.execPath, ['-e', "process.stderr.write('quebrou'); process.exit(3)"], { prazoMs: 5000 }), (e) => e.codigo === 'ACAO_FALHOU' && /quebrou/.test(e.message));
  });

  test('prazo vencido: o grupo inteiro (pai e neto que ignoram SIGTERM) é encerrado e o fim é conferido', async () => {
    const arquivo = path.join(tmp, 'pids');
    const roteiro = roteiroPreso(arquivo, { ignorarTerm: true });
    const inicio = Date.now();
    await assert.rejects(E().executarComPrazo(process.execPath, [roteiro], { prazoMs: 400, gracaMs: 300 }), (e) => e.codigo === 'PRAZO_DA_ACAO_EXCEDIDO');
    assert.ok(Date.now() - inicio < 4000, 'termina dentro do prazo somado à graça');
    const pids = lerPids(arquivo);
    assert.equal(pids.length, 2, 'pai e neto chegaram a existir');
    for (const pid of pids) assert.equal(vivo(pid), false, `processo ${pid} sobreviveu`);
  });

  test('comando que sai deixando um descendente no grupo: o descendente é encerrado e a ação não vale', async () => {
    const arquivo = path.join(tmp, 'pids');
    const roteiro = roteiroPreso(arquivo, { paiSai: true });
    await assert.rejects(E().executarComPrazo(process.execPath, [roteiro], { prazoMs: 5000, gracaMs: 300 }), (e) => e.codigo === 'ACAO_DEIXOU_DESCENDENTES');
    const pids = lerPids(arquivo);
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.equal(vivo(pid), false, `processo ${pid} sobreviveu`);
  });

  test('o envio do sinal não prova o fim: grupo que continua aparecendo vira ENCERRAMENTO_DA_ACAO_INCERTO, no prazo', async () => {
    const arquivo = path.join(tmp, 'pids');
    const roteiro = roteiroPreso(arquivo);
    // Os sinais chegam de verdade ao grupo; só a conferência (sinal 0) mente que ainda há alguém vivo.
    const sinalizar = (alvo, sinal) => { if (sinal === 0) return true; return process.kill(alvo, sinal); };
    const inicio = Date.now();
    await assert.rejects(E().executarComPrazo(process.execPath, [roteiro], { prazoMs: 300, gracaMs: 200, sinalizar }), (e) => e.codigo === 'ENCERRAMENTO_DA_ACAO_INCERTO');
    assert.ok(Date.now() - inicio < 4000, 'não espera indefinidamente');
    for (const pid of lerPids(arquivo)) assert.equal(await esperarAte(() => !vivo(pid)), true, `processo ${pid} sobreviveu`);
  });

  test('só o grupo do próprio filho é sinalizado; falha ao iniciar não sinaliza nada', async () => {
    const alvos = [];
    const sinalizar = (alvo, sinal) => { alvos.push(alvo); return process.kill(alvo, sinal); };
    const arquivo = path.join(tmp, 'pids');
    await assert.rejects(E().executarComPrazo(process.execPath, [roteiroPreso(arquivo)], { prazoMs: 300, gracaMs: 300, sinalizar }), (e) => e.codigo === 'PRAZO_DA_ACAO_EXCEDIDO');
    const [pai] = lerPids(arquivo);
    assert.ok(alvos.length > 0);
    assert.deepEqual([...new Set(alvos)], [-pai], 'todo sinal vai ao grupo do filho, e a nada além dele');
    alvos.length = 0;
    await assert.rejects(E().executarComPrazo('/nao/existe/comando', [], { prazoMs: 300, sinalizar }), (e) => e.codigo === 'ACAO_NAO_INICIOU');
    assert.deepEqual(alvos, []);
  });

  test('prazo inválido: nada é iniciado', async () => {
    for (const prazoMs of [undefined, 0, -1, 1.5, '1000']) {
      await assert.rejects(E().executarComPrazo(process.execPath, ['-e', ''], { prazoMs }), (e) => e.codigo === 'PRAZO_INVALIDO', String(prazoMs));
    }
  });
});
