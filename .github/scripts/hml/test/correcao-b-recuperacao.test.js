'use strict';

process.env.NODE_ENV = 'test';

// Correção B (pedido 45240585273-1): saída auditável do estado crítico depois de uma reversão automática cujo reinício
// de recuperação falhou. B1 confirma no instalador a release em uso, sem reinício; B2 encerra o CRITICO do agente com
// uma resolução presa ao pedido, à reversão, ao recibo, ao registro e à liberação do guardião, publicada com gravação
// única; B3 só pula na fila o CRITICO com essa resolução íntegra; B3b impede que um pedido com recibo já publicado seja
// processado de novo. S3 é falso: nada toca a AWS. A âncora do agente é em memória, salvo no teste de integração, que
// usa a âncora real por caminho.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const MODULO = path.join(REPO, 'deploy', 'hml', 'instalador', 'instalar-release.js');
const AG = require(path.join(REPO, 'deploy', 'hml', 'cd', 'agente-backend.js'));
const P = require(path.join(REPO, 'deploy', 'hml', 'cd', 'protocolo.js'));
const inst = () => require(MODULO);
const sha = (c) => crypto.createHash('sha256').update(c).digest('hex');
const temporarios = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-corb-'));
  temporarios.push(dir);
  return dir;
};
afterEach(() => {
  while (temporarios.length) {
    const d = temporarios.pop();
    const liberar = (p) => { try { fs.chmodSync(p, 0o755); } catch { return; } let e; try { e = fs.readdirSync(p, { withFileTypes: true }); } catch { return; } for (const x of e) if (x.isDirectory()) liberar(path.join(p, x.name)); };
    liberar(d);
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const falha = (promessa) => promessa.then(() => assert.fail('esperava recusa'), (e) => e);
const lerJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// ------------------------------------------------------------ instalador real em diretório temporário (B1)

const AGORA0 = Date.parse('2026-11-23T18:39:23.000Z');
const NPM = '/usr/bin/npm';
const R = (n) => `hml-20261123T1${n}0000-${String(n).repeat(7)}`;
const COMMIT = (n) => String(n).repeat(40);
const criarAncoraPorCaminho = (op) => require(path.join(REPO, 'deploy', 'hml', 'instalador', 'ancora.js')).criarAncora({ ...op, modo: 'caminho', semGarantiaDeCorrida: true });
const aprovado = (dir) => sha(fs.readFileSync(path.join(dir, 'release.json')));

function criarBackend(n) {
  const dir = tmp();
  const lock = '{"lockfileVersion":3}';
  const sql = '-- 000_a.sql\n';
  const arquivos = {
    'package.json': JSON.stringify({ engines: { node: '>=22' } }), 'package-lock.json': lock, 'src/server.js': `// v${n}\n`,
    'migrations/000_a.sql': sql, 'migrations/checksums.json': JSON.stringify({ algoritmo: 'sha256', migrations: { '000_a.sql': sha(sql) } }),
  };
  const manifesto = {};
  for (const [rel, c] of Object.entries(arquivos)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'backend', rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backend', rel), c);
    manifesto[rel] = sha(c);
  }
  const texto = `${Object.keys(manifesto).sort().map((rel) => `${manifesto[rel]}  ${rel}`).join('\n')}\n`;
  fs.writeFileSync(path.join(dir, 'manifesto-backend.sha256'), texto);
  const release = {
    commit: COMMIT(n), rotulo: R(n), atual: true, geradoEm: '2026-11-23T10:00:00.000Z',
    backend: { arquivos: Object.keys(manifesto).length, manifestoSha256: sha(texto), lockfileSha256: sha(lock), node: '>=22', migrations: [{ nome: '000_a.sql', sha256: sha(sql) }], contratos: {} },
  };
  fs.writeFileSync(path.join(dir, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);
  return dir;
}
function criarAmbiente() {
  const raiz = tmp();
  const dirs = { app: path.join(raiz, 'app'), data: path.join(raiz, 'data'), secrets: path.join(raiz, 'secrets') };
  for (const d of [dirs.app, path.join(dirs.data, 'imagens'), dirs.secrets]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(dirs.secrets, 'backend.env'), 'SEGREDO=nao-mexer\n');
  const config = {
    raizesPersistentes: [dirs.data, dirs.secrets], retencao: 3,
    componentes: {
      backend: {
        tipo: 'backend', base: dirs.app, nome: 'backend',
        linksPersistentes: [{ nome: '.env', destino: path.join(dirs.secrets, 'backend.env') }],
        dependencias: { comando: [NPM, 'ci', '--omit=dev', '--ignore-scripts'] },
      },
    },
  };
  const releases = path.join(dirs.app, '.releases', 'backend');
  return { raiz, ...dirs, config, releases, link: path.join(dirs.app, 'backend'), estado: path.join(releases, 'estado.json') };
}
function depsDaInstalacao(amb, extra = {}) {
  let tick = 0; let pid = 100;
  const deps = {
    criarAncora: criarAncoraPorCaminho,
    agora: () => AGORA0 + (tick++) * 100,
    esperar: async () => {},
    usuario: () => 'operador-teste',
    executar: async (cmd, args, opc) => { fs.mkdirSync(path.join(opc.cwd, 'node_modules', 'dotenv'), { recursive: true }); fs.writeFileSync(path.join(opc.cwd, 'node_modules', 'dotenv', 'config.js'), '1'); },
    reiniciar: async () => {},
    verificarSaude: async () => ({ ok: true }),
    identificarProcesso: async () => { pid += 1; return { pid, cwd: fs.realpathSync(amb.link) }; },
    ...extra,
  };
  // Coordenação e observação com a data do próprio relógio da instalação (fixo ou real, no teste de integração).
  if (!deps.consultarCoordenacao) deps.consultarCoordenacao = async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date(deps.agora()).toISOString() });
  require(path.join(REPO, 'deploy', 'hml', 'instalador', 'coordenacao.js')).homologarProvedorParaTeste(deps.consultarCoordenacao);
  return deps;
}
const observado = (em) => ({ banco: 'hml', origem: 'sonda-teste', coletadoEm: new Date(em).toISOString(), migrations: ['000_a.sql'], contratos: {} });
async function instalarBackend(amb, n, deps) {
  const dir = criarBackend(n);
  return inst().instalar({ config: amb.config, componente: 'backend', release: dir, opcoes: { releaseSha256Esperado: aprovado(dir), observado: observado(deps.agora()) }, deps });
}
// Reproduz o pedido 45240585273-1: a release nova não sobe, a reversão volta para a anterior e o reinício de
// recuperação também falha (recuperacao=REINICIO). antesDaFalha roda entre a primeira instalação e a que falha.
async function ambienteComRecuperacaoNaoConfirmada({ agora, antesDaFalha } = {}) {
  const amb = criarAmbiente();
  const relogio = agora ? { agora } : {};
  await instalarBackend(amb, 1, depsDaInstalacao(amb, relogio));
  if (antesDaFalha) await antesDaFalha(amb);
  const e = await falha(instalarBackend(amb, 2, depsDaInstalacao(amb, { ...relogio, reiniciar: async () => { throw new Error('systemctl saiu com erro'); } })));
  assert.equal(e.codigo, 'REINICIO_FALHOU');
  return amb;
}
function depsDaConfirmacao(amb, extra = {}) {
  const chamadas = { proibidas: [], saude: 0, identificar: 0 };
  const proibida = (nome) => async () => { chamadas.proibidas.push(nome); throw new Error(`${nome} não pode ser chamado`); };
  const deps = {
    criarAncora: criarAncoraPorCaminho, agora: () => AGORA0 + 3600000, esperar: async () => {}, usuario: () => 'operador-teste',
    identificarProcesso: async () => { chamadas.identificar += 1; return { pid: 4019226, cwd: fs.realpathSync(amb.link) }; },
    verificarSaude: async () => { chamadas.saude += 1; return { ok: true }; },
    reiniciar: proibida('reiniciar'), executar: proibida('executar'), consultarCoordenacao: proibida('consultarCoordenacao'), lerObservado: proibida('lerObservado'),
    ...extra,
  };
  return { deps, chamadas };
}
const confirmarRecuperacao = (amb, deps) => inst().confirmarRecuperacaoDoBackend({ config: amb.config, componente: 'backend', deps });
const identificarReal = (amb) => inst().identificar({ config: amb.config, componente: 'backend', deps: { criarAncora: criarAncoraPorCaminho } });
const leituraDaConfirmacao = (amb) => inst().confirmacaoDaRecuperacao({ config: amb.config, componente: 'backend', deps: { criarAncora: criarAncoraPorCaminho } });
function regravarEstado(amb, mudar) {
  const e = lerJson(amb.estado);
  mudar(e);
  fs.chmodSync(amb.estado, 0o644);
  fs.writeFileSync(amb.estado, `${JSON.stringify(e, null, 2)}\n`);
}

// ------------------------------------------------------------ agente com S3 falso (B2, B3, B3b)

const ID = '45240585273-1';
const ID2 = '45240585999-1';
const COMMIT_DO_PEDIDO = 'd'.repeat(40);
const ROTULO_DO_PEDIDO = `hml-20261123T183923-${COMMIT_DO_PEDIDO.slice(0, 7)}`;
const ROTULO_DO_PEDIDO2 = `hml-20261124T080000-${COMMIT_DO_PEDIDO.slice(0, 7)}`;
const SISTEMA = '7412345678901234567';
const blobDe = () => Buffer.from(JSON.stringify([['release.json', Buffer.from('{}').toString('base64')]]));
function pedidoDe(id = ID, extra = {}) {
  const agora = Date.now();
  return {
    versao: 2, escopo: 'backend', id, repositorio: P.REPO, commit: COMMIT_DO_PEDIDO, rotulo: ROTULO_DO_PEDIDO, releaseSha256: 'b'.repeat(64),
    blobSha256: sha(blobDe()), permitirAnterior: false, criadoEm: new Date(agora - 1000).toISOString(), expiraEm: new Date(agora + 5 * 60000).toISOString(), ...extra,
  };
}
const saudavel = (rotulo, commit) => ({ instalado: true, integro: true, consistente: true, garantiaContraCorrida: true, rotulo, commit });
const BASE = saudavel(`hml-20261123T114422-${'4'.repeat(7)}`, '4'.repeat(40));
const chaveDe = (tipo, id = ID) => `hml-backend/${tipo}/${id}.json`;
const chaveDaResolucao = (id = ID) => `hml-backend/recibos/${id}.resolucao.json`;
const CHAVE_DA_RESOLUCAO = chaveDaResolucao();
const TRAVA = '@.trava-cd-backend';
const DONO_DA_TRAVA = `${TRAVA}/pedido.json`;
const TRAVA_DA_RESOLUCAO = '@.trava-resolucao-cd-backend';
const erroS3 = () => Object.assign(new Error('S3_OPERACAO_FALHOU'), { codigo: 'S3_OPERACAO_FALHOU' });
const pedidoNoS3 = (s3, id = ID) => JSON.parse(s3.dados.get(chaveDe('pedidos', id)).toString());
// O que o instalador devolve depois do B1 para a reversão deste pedido: a reversão logo depois de o pedido ser criado
// e a confirmação logo depois da reversão. `extra` desvia campos para os testes de vínculo.
function confirmacaoPara(s3, id = ID, extra = {}) {
  const pedido = pedidoNoS3(s3, id);
  const criado = Date.parse(pedido.criadoEm);
  return {
    evento: 'CONFIRMACAO_RECUPERACAO', em: new Date(criado + 2000).toISOString(), rotulo: BASE.rotulo,
    reversao: { rotulo: pedido.rotulo, em: new Date(criado + 1000).toISOString(), recuperacao: 'REINICIO' },
    criticoResolvido: { motivo: 'RECUPERACAO_NAO_CONFIRMADA', release: BASE.rotulo },
    ...extra,
  };
}

// S3 com gravação única (como a política do bucket): put em chave existente falha. falhas.put devolve 'antes' (falha
// sem gravar) ou 'depois' (grava e responde erro); falhas.get lança na leitura daquela chave.
function s3Memoria(inicial = new Map()) {
  const dados = new Map([...inicial].map(([k, v]) => [k, Buffer.from(v)]));
  const s3 = {
    dados, uso: [], falhas: {}, falharPut: false,
    get: async (k) => { s3.uso.push(['get', k]); if (s3.falhas.get && s3.falhas.get(k)) throw erroS3(); return dados.has(k) ? Buffer.from(dados.get(k)) : null; },
    put: async (k, b) => {
      s3.uso.push(['put', k]);
      const fase = s3.falhas.put ? s3.falhas.put(k) : null;
      if (s3.falharPut || fase === 'antes' || dados.has(k)) throw erroS3();
      dados.set(k, Buffer.from(b));
      if (fase === 'depois') throw erroS3();
    },
  };
  return s3;
}
const puts = (s3) => s3.uso.filter(([op]) => op === 'put').length;
// Âncora em memória: arquivos da base pelo nome, diretórios como '@nome' e arquivos dentro deles como '@nome/arquivo'.
// falhas.escrever(nome) e falhas.remover(nome) devolvem 'antes' ou 'depois' para simular a queda imediatamente antes ou
// depois da gravação ou da remoção.
function ancoraMemoria(armazem, falhas = {}, contagem = { escritas: 0, remocoes: 0, fechamentos: 0 }) {
  const quebra = (o) => Object.assign(new Error(o), { code: 'EIO' });
  const chave = (dir, nome) => (dir && dir.nome ? `@${dir.nome}/${nome}` : nome);
  return () => ({
    abrirBase: (d) => ({ d }),
    criarExclusivo: (b, nome) => { if (armazem.has(`@${nome}`)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); armazem.set(`@${nome}`, true); return { nome }; },
    lerTexto: (b, nome) => (armazem.has(chave(b, nome)) ? armazem.get(chave(b, nome)) : null),
    escreverAtomico: (b, nome, texto) => {
      const fase = falhas.escrever ? falhas.escrever(nome) : null;
      if (fase === 'antes') throw quebra('escrita');
      armazem.set(chave(b, nome), texto); contagem.escritas += 1;
      if (fase === 'depois') throw quebra('escrita');
    },
    tipo: (b, nome) => {
      if (armazem.has(`@${nome}`)) return { isDirectory: () => true, isFile: () => false };
      return armazem.has(nome) ? { isDirectory: () => false, isFile: () => true } : null;
    },
    listar: (b) => {
      if (b && b.nome) return [...armazem.keys()].filter((k) => k.startsWith(`@${b.nome}/`)).map((k) => ({ nome: k.slice(b.nome.length + 2), ehDiretorio: false, ehArquivo: true, ehLink: false }));
      return [...armazem.keys()].filter((k) => !k.includes('/')).map((k) => (k.startsWith('@') ? { nome: k.slice(1), ehDiretorio: true, ehArquivo: false, ehLink: false } : { nome: k, ehDiretorio: false, ehArquivo: true, ehLink: false }));
    },
    abrirFilho: (b, nome) => { if (!armazem.has(`@${nome}`)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { nome }; },
    identidade: (h) => h.nome, fechar: () => {},
    removerArvore: (b, nome) => {
      const fase = falhas.remover ? falhas.remover(nome) : null;
      if (fase === 'antes') throw quebra('remoção');
      for (const k of [...armazem.keys()]) if (k === `@${nome}` || k.startsWith(`@${nome}/`)) armazem.delete(k);
      contagem.remocoes += 1;
      if (fase === 'depois') throw quebra('remoção');
    },
    fecharTudo: () => { contagem.fechamentos = (contagem.fechamentos || 0) + 1; if (falhas.fechar) throw quebra('fechamento'); },
  });
}
const LIBERACAO = Object.freeze({ situacao: 'LIBERACAO_INFORMADA', processoEncerrado: true, forcada: false, comprovadaNoBanco: false, cadeadosLiberados: { confirmada: true, liberados: 4, restantes: 0 }, sessaoEncerradaDeclarada: true });
function coordenacaoLivre(liberacao = LIBERACAO) {
  return {
    adquirir: async () => ({ ok: true, vidaMaximaMs: 45 * 60 * 1000 }),
    consultar: async () => ({ situacao: 'LIVRE', origem: 'falsa', consultadoEm: new Date().toISOString() }),
    confirmar: async () => true,
    liberar: async () => { if (liberacao instanceof Error) throw liberacao; return liberacao; },
    garantiaVigente: () => true,
    descrever: () => ({ instanciaReal: false, perda: null }),
  };
}
// Dependências do agente: instalar é a falsa do cenário; identificar devolve a baseline (a reversão voltou para ela).
function depsDoAgente(armazem, { instalar, identificar = async () => BASE, contagem, falhas, liberacao, criarAncora } = {}) {
  const chamadas = { instalar: 0 };
  return {
    chamadas,
    criarAncora: criarAncora || ancoraMemoria(armazem, falhas, contagem),
    vincular: () => ({ dir: '/baseline-do-teste', comando: ['/bin/false'] }),
    vincularGuardiao: () => ({ dir: '/baseline-do-teste', comando: ['/bin/false', '/baseline-do-teste/scripts/guardiao-de-coordenacao.js'] }),
    criarCoordenacao: () => coordenacaoLivre(liberacao),
    observar: async () => ({ banco: 'hml', origem: 'teste', coletadoEm: new Date().toISOString(), migrations: ['000_a'], contratos: {} }),
    conferirRelease: (r) => ({ release: { commit: r.commit, rotulo: r.rotulo, atual: true } }),
    identificar,
    instalar: async (...args) => { chamadas.instalar += 1; return instalar(...args); },
  };
}
const erroCom = (codigo, extra = {}) => Object.assign(new Error(codigo), { codigo }, extra);
const FALHA_DA_REVERSAO = async () => { throw erroCom('REINICIO_FALHOU', { detalhes: { reverteu: true, recuperado: false } }); };
const RECUSA_SEM_MUTACAO = async () => { throw erroCom('COORDENACAO_NAO_HOMOLOGADA'); };
// O estado do agente fica na âncora em memória; o diretório real só recebe a entrada extraída do pacote.
let ESTADO;
beforeEach(() => { ESTADO = tmp(); });
const cfg = () => ({ estadoDir: ESTADO, sonda: { sistema: SISTEMA } });
const preparoS3 = (s3, id = ID, extra = {}) => {
  s3.dados.set(chaveDe('pedidos', id), Buffer.from(JSON.stringify(pedidoDe(id, extra))));
  s3.dados.set(chaveDe('blobs', id), blobDe());
};

// Estado do pedido 45240585273-1 na HML: registro TERMINAL CRITICO (RESULTADO_INCERTO / REINICIO_FALHOU), trava
// preservada (com o id do pedido) e recibo CRITICO publicado (ou pendente, com publicado=false).
async function cenarioCritico({ publicado = true, liberacao } = {}) {
  ESTADO = tmp();
  const armazem = new Map();
  const s3 = s3Memoria();
  preparoS3(s3);
  const deps = depsDoAgente(armazem, { instalar: FALHA_DA_REVERSAO, liberacao });
  s3.falharPut = !publicado;
  const r = await AG.processar({ cfg: cfg(), id: ID, s3, deps });
  s3.falharPut = false;
  assert.deepEqual([r.estado, r.motivo, r.diagnostico], ['CRITICO', 'RESULTADO_INCERTO', 'REINICIO_FALHOU']);
  assert.equal(armazem.has(TRAVA), true);
  s3.uso.length = 0;
  return { armazem, s3, registroOriginal: armazem.get(`${ID}.json`) };
}
// Outro CRITICO (id2) no mesmo estado, depois de liberada a trava do primeiro.
async function outroCritico(c, { instalar = FALHA_DA_REVERSAO, liberacao } = {}) {
  preparoS3(c.s3, ID2, { rotulo: ROTULO_DO_PEDIDO2 });
  const r = await AG.processar({ cfg: cfg(), id: ID2, s3: c.s3, deps: depsDoAgente(c.armazem, { instalar, liberacao }) });
  assert.equal(r.estado, 'CRITICO');
  return r;
}
const reciboEsperadoDe = (registroTexto) => Buffer.from(JSON.stringify(JSON.parse(registroTexto).recibo));
function depsDaResolucao(c, extra = {}, id = ID) {
  const contagem = { escritas: 0, remocoes: 0, fechamentos: 0 };
  const falhas = {};
  const deps = {
    criarAncora: ancoraMemoria(c.armazem, falhas, contagem),
    identificar: async () => BASE,
    confirmacaoDaRecuperacao: async () => confirmacaoPara(c.s3, id),
    agora: () => Date.parse('2026-11-23T21:00:00.000Z'),
    uid: 998,
    ...extra,
  };
  return { deps, contagem, falhas };
}
const resolver = (c, deps, id = ID) => AG.resolverCritico({ cfg: cfg(), id, s3: c.s3, deps });
function invariantes({ armazem, s3, registroOriginal }) {
  assert.equal(armazem.get(`${ID}.json`), registroOriginal, 'o registro original não muda');
  const recibo = s3.dados.get(chaveDe('recibos'));
  if (recibo) assert.equal(recibo.toString(), reciboEsperadoDe(registroOriginal).toString(), 'o recibo original não muda');
  assert.ok([...s3.dados.keys()].filter((k) => k === CHAVE_DA_RESOLUCAO).length <= 1);
  assert.equal(armazem.has(TRAVA_DA_RESOLUCAO), false, 'a trava da resolução nunca fica para trás');
}
async function resolvido() {
  const c = await cenarioCritico();
  const r = await resolver(c, depsDaResolucao(c).deps);
  assert.equal(r.estado, 'RESOLVIDA');
  return c;
}
const soTrava = (fase) => (n) => (n === '.trava-cd-backend' ? fase : null);

// ------------------------------------------------------------ T1 e B1

describe('T1 — reprodução: recuperação não confirmada bloqueia o agente', () => {
  test('falha do reinício e do reinício de recuperação deixa RECUPERACAO_NAO_CONFIRMADA (REINICIO) e o agente recusa a baseline', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    const estado = lerJson(amb.estado);
    assert.equal(estado.critico.motivo, 'RECUPERACAO_NAO_CONFIRMADA');
    assert.equal(estado.critico.recuperacao, 'REINICIO');
    assert.equal(estado.critico.release, R(1));
    assert.deepEqual([estado.atual.rotulo, estado.atual.comprovada], [R(1), false]);
    assert.deepEqual([estado.historico.at(-1).evento, estado.historico.at(-1).recuperacao], ['REVERSAO_AUTOMATICA', 'REINICIO']);
    const id = await identificarReal(amb);
    assert.equal(id.integro, false);
    const armazem = new Map();
    const s3 = s3Memoria();
    preparoS3(s3);
    const deps = depsDoAgente(armazem, { instalar: async () => ({ resultado: 'INSTALADA', avisos: [] }), identificar: async () => ({ ...id, garantiaContraCorrida: true }) });
    const r = await AG.processar({ cfg: cfg(), id: ID, s3, deps });
    assert.deepEqual([r.estado, r.motivo, r.mutacao], ['RECUSADO', 'BASELINE_NAO_COMPROVADA', 'NENHUMA']);
    assert.equal(deps.chamadas.instalar, 0);
  });
});

describe('T2 — B1: confirmação da recuperação sem reinício', () => {
  test('prova processo e saúde da release em uso, zera o crítico, preserva o histórico e não reinicia, instala nem consulta coordenação', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    const antes = lerJson(amb.estado);
    const linkAntes = fs.readlinkSync(amb.link);
    const { deps, chamadas } = depsDaConfirmacao(amb);
    const r = await confirmarRecuperacao(amb, deps);
    assert.deepEqual([r.resultado, r.rotulo, r.commit, r.comprovada, r.pid], ['RECUPERACAO_CONFIRMADA', R(1), COMMIT(1), true, 4019226]);
    const depois = lerJson(amb.estado);
    assert.equal(depois.critico, null);
    assert.deepEqual([depois.atual.rotulo, depois.atual.comprovada], [R(1), true]);
    assert.deepEqual(depois.historico.slice(0, -1), antes.historico, 'o histórico anterior fica idêntico');
    const evento = depois.historico.at(-1);
    assert.deepEqual([evento.evento, evento.rotulo, evento.commit, evento.pid, evento.reiniciou], ['CONFIRMACAO_RECUPERACAO', R(1), COMMIT(1), 4019226, false]);
    assert.deepEqual(evento.criticoResolvido, antes.critico, 'o crítico resolvido fica copiado no evento');
    assert.deepEqual(evento.reversao, { rotulo: R(2), em: antes.historico.at(-1).em, recuperacao: 'REINICIO' });
    assert.deepEqual(chamadas.proibidas, []);
    assert.equal(chamadas.identificar, 1);
    assert.ok(chamadas.saude >= 1);
    assert.equal(fs.readlinkSync(amb.link), linkAntes, 'o link não muda');
    const id = await identificarReal(amb);
    assert.deepEqual([id.integro, id.consistente, id.rotulo], [true, true, R(1)], JSON.stringify(id.problemas));
    assert.deepEqual(await leituraDaConfirmacao(amb), {
      evento: 'CONFIRMACAO_RECUPERACAO', em: evento.em, rotulo: R(1),
      reversao: { rotulo: R(2), em: antes.historico.at(-1).em, recuperacao: 'REINICIO' },
      criticoResolvido: { motivo: 'RECUPERACAO_NAO_CONFIRMADA', release: R(1) },
    });
  });

  test('o código da confirmação não reinicia, não troca link, não instala nem consulta coordenação ou migrations; grava o estado uma vez', () => {
    const fonte = fs.readFileSync(MODULO, 'utf8');
    const inicio = fonte.indexOf('async function confirmarRecuperacaoDoBackend(');
    assert.ok(inicio > 0);
    const trecho = fonte.slice(inicio, fonte.indexOf('// ------------------------------------------------------------', inicio));
    assert.doesNotMatch(trecho, /reiniciarEComprovar|\.reiniciar\(|preparar\(|trocarAtual|trocarAnterior|removerAtual|garantirAtual|avaliarPreCondicoes|lerObservado|consultarCoordenacao|\.executar\(|naoHomologada|migrat/);
    assert.match(trecho, /comprovarExecucao\(\{ ctx, deps, alvoRotulo: rotulo, procAntes: null/);
    assert.equal((trecho.match(/gravarEstado\(/g) || []).length, 1);
    const cli = fs.readFileSync(path.join(REPO, 'deploy', 'hml', 'instalador', 'adotar-backend.js'), 'utf8');
    assert.match(cli, /I\.confirmarRecuperacaoDoBackend\(/);
    assert.match(cli, /'confirmar-recuperacao'/);
  });

  test('a leitura da confirmação é só leitura: sem a confirmação registrada devolve null', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    const antes = sha(fs.readFileSync(amb.estado));
    assert.equal(await leituraDaConfirmacao(amb), null);
    assert.equal(sha(fs.readFileSync(amb.estado)), antes);
  });

  test('a linha de comando da confirmação recusa argumentos fora do formato antes de ler qualquer coisa', async () => {
    const { principal } = require(path.join(REPO, 'deploy', 'hml', 'instalador', 'adotar-backend.js'));
    for (const argv of [['confirmar-recuperacao'], ['confirmar-recuperacao', '--config'], ['confirmar-recuperacao', '--release', 'x'], ['confirmar-recuperacao', '--config', '--x']]) {
      const e = await falha(principal(argv));
      assert.equal(e.codigo, 'USO', JSON.stringify(argv));
    }
  });
});

describe('T3 — B1: recusas sem gravar nada', () => {
  const CASOS = [
    ['motivo do crítico diferente', (amb) => regravarEstado(amb, (e) => { e.critico.motivo = 'ROLLBACK_BLOQUEADO'; })],
    ['crítico de outra release', (amb) => regravarEstado(amb, (e) => { e.critico.release = R(2); })],
    ['último evento não é a reversão automática', (amb) => regravarEstado(amb, (e) => { e.historico.push({ evento: 'RECUPERACAO', rotulo: R(1), em: '2026-11-23T19:00:00.000Z' }); })],
    ['reversão registrada como recuperada', (amb) => regravarEstado(amb, (e) => { e.historico.at(-1).recuperacao = 'OK'; })],
    ['recuperação barrada pela coordenação (COORDENACAO)', (amb) => regravarEstado(amb, (e) => { e.historico.at(-1).recuperacao = 'COORDENACAO'; e.critico.recuperacao = 'COORDENACAO'; })],
    ['release em uso já comprovada', (amb) => regravarEstado(amb, (e) => { e.atual.comprovada = true; })],
    ['diário com operação aberta', (amb) => fs.appendFileSync(path.join(amb.releases, 'diario.jsonl'), `${JSON.stringify({ em: '2026-11-23T19:00:00.000Z', id: 'aberta', passo: 'INICIO', operacao: 'instalar' })}\n`)],
    ['release em uso adulterada', (amb) => { const d = path.join(amb.releases, R(1), 'src'); fs.chmodSync(path.join(amb.releases, R(1)), 0o755); fs.chmodSync(d, 0o755); fs.chmodSync(path.join(d, 'server.js'), 0o644); fs.writeFileSync(path.join(d, 'server.js'), '// adulterado\n'); }],
  ];
  for (const [nome, preparar] of CASOS) {
    test(`recusa: ${nome}`, async () => {
      const amb = await ambienteComRecuperacaoNaoConfirmada();
      preparar(amb);
      const antes = sha(fs.readFileSync(amb.estado));
      const { deps, chamadas } = depsDaConfirmacao(amb);
      const e = await falha(confirmarRecuperacao(amb, deps));
      assert.equal(e.codigo, 'CONFIRMACAO_RECUPERACAO_RECUSADA');
      assert.equal(sha(fs.readFileSync(amb.estado)), antes);
      assert.deepEqual(chamadas.proibidas, []);
      assert.equal(chamadas.identificar, 0, 'a recusa vem antes de qualquer prova');
    });
  }
  test('o diário com operação aberta é recusado por ser operação aberta, não por ser ilegível', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    fs.appendFileSync(path.join(amb.releases, 'diario.jsonl'), `${JSON.stringify({ em: '2026-11-23T19:00:00.000Z', id: 'aberta', passo: 'INICIO', operacao: 'instalar' })}\n`);
    const e = await falha(confirmarRecuperacao(amb, depsDaConfirmacao(amb).deps));
    assert.match(e.message, /operação interrompida/);
  });
  test('recusa: o processo em execução é de outra release', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    const antes = sha(fs.readFileSync(amb.estado));
    const { deps } = depsDaConfirmacao(amb, { identificarProcesso: async () => ({ pid: 4019226, cwd: fs.realpathSync(path.join(amb.releases, R(2))) }) });
    const e = await falha(confirmarRecuperacao(amb, deps));
    assert.equal(e.codigo, 'VERSAO_NAO_COMPROVADA');
    assert.equal(sha(fs.readFileSync(amb.estado)), antes);
  });
  test('recusa: a identidade do serviço não pode ser lida', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    const antes = sha(fs.readFileSync(amb.estado));
    const { deps } = depsDaConfirmacao(amb, { identificarProcesso: async () => { throw new Error('IDENTIDADE_DO_SERVICO_INVALIDA'); } });
    const e = await falha(confirmarRecuperacao(amb, deps));
    assert.equal(e.codigo, 'VERSAO_NAO_COMPROVADA');
    assert.equal(sha(fs.readFileSync(amb.estado)), antes);
  });
  test('recusa: a saúde falha', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    const antes = sha(fs.readFileSync(amb.estado));
    const { deps } = depsDaConfirmacao(amb, { verificarSaude: async () => ({ ok: false, detalhe: 'HTTP 503' }) });
    const e = await falha(confirmarRecuperacao(amb, deps));
    assert.equal(e.codigo, 'SAUDE_FALHOU');
    assert.equal(sha(fs.readFileSync(amb.estado)), antes);
  });
  test('recusa: sem estado crítico (segunda execução depois de confirmar)', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    await confirmarRecuperacao(amb, depsDaConfirmacao(amb).deps);
    const antes = sha(fs.readFileSync(amb.estado));
    const e = await falha(confirmarRecuperacao(amb, depsDaConfirmacao(amb).deps));
    assert.equal(e.codigo, 'CONFIRMACAO_RECUPERACAO_RECUSADA');
    assert.equal(sha(fs.readFileSync(amb.estado)), antes);
  });
  test('recusa: sem identificação do processo ou sem verificação de saúde', async () => {
    const amb = await ambienteComRecuperacaoNaoConfirmada();
    const antes = sha(fs.readFileSync(amb.estado));
    for (const tirar of ['identificarProcesso', 'verificarSaude']) {
      const { deps } = depsDaConfirmacao(amb);
      delete deps[tirar];
      const e = await falha(confirmarRecuperacao(amb, deps));
      assert.equal(e.codigo, 'CONFIRMACAO_RECUPERACAO_RECUSADA');
    }
    assert.equal(sha(fs.readFileSync(amb.estado)), antes);
  });
});

// ------------------------------------------------------------ B2

describe('T4 — B2: encerramento auditável do CRITICO', () => {
  test('a trava criada pelo agente diz de qual pedido ela é', async () => {
    const c = await cenarioCritico();
    assert.deepEqual(JSON.parse(c.armazem.get(DONO_DA_TRAVA)), { versao: 1, id: ID });
  });
  for (const publicado of [true, false]) {
    test(`resolve com o recibo ${publicado ? 'já publicado' : 'pendente (publica o original)'}: resolução presa ao pedido, reversão, recibo, registro e guardião; trava removida só no fim`, async () => {
      const c = await cenarioCritico({ publicado });
      const { deps, contagem } = depsDaResolucao(c);
      const r = await resolver(c, deps);
      assert.deepEqual([r.id, r.estado], [ID, 'RESOLVIDA']);
      assert.equal(c.armazem.has(TRAVA), false);
      assert.equal(c.armazem.has(DONO_DA_TRAVA), false);
      assert.ok(contagem.remocoes >= 1);
      const recibo = c.s3.dados.get(chaveDe('recibos'));
      assert.equal(recibo.toString(), reciboEsperadoDe(c.registroOriginal).toString());
      const remota = c.s3.dados.get(CHAVE_DA_RESOLUCAO);
      assert.equal(remota.toString(), c.armazem.get(`resolucao-${ID}.json`), 'a cópia local é idêntica à do S3');
      const res = JSON.parse(remota.toString());
      const pedidoBytes = c.s3.dados.get(chaveDe('pedidos'));
      const pedido = JSON.parse(pedidoBytes.toString());
      assert.deepEqual(res, {
        versao: 1, tipo: 'RESOLUCAO_CRITICO', id: ID, escopo: 'backend',
        pedido: { sha256: sha(pedidoBytes), commit: pedido.commit, rotulo: pedido.rotulo, releaseSha256: pedido.releaseSha256, blobSha256: pedido.blobSha256, criadoEm: pedido.criadoEm, expiraEm: pedido.expiraEm },
        recibo: { sha256: sha(recibo), estado: 'CRITICO', motivo: 'RESULTADO_INCERTO', diagnostico: 'REINICIO_FALHOU' },
        registro: { sha256: sha(c.registroOriginal), fase: 'TERMINAL', antes: { rotulo: BASE.rotulo, commit: BASE.commit } },
        guardiao: { liberacao: 'LIBERACAO_INFORMADA', encerramentoComprovado: true, cadeadosLiberadosConfirmados: true, forcada: false },
        baseline: { rotulo: BASE.rotulo, commit: BASE.commit },
        instalador: confirmacaoPara(c.s3),
        resolvidoEm: '2026-11-23T21:00:00.000Z', uid: 998,
      });
      invariantes(c);
      const ordem = c.s3.uso.filter(([op]) => op === 'put').map(([, k]) => k);
      assert.deepEqual(ordem, publicado ? [CHAVE_DA_RESOLUCAO] : [chaveDe('recibos'), CHAVE_DA_RESOLUCAO], 'recibo antes da resolução');
    });
  }
  test('trava sem identidade (criada antes da Correção B): resolve o recibo e a resolução, mas preserva a trava, cuja propriedade não se prova', async () => {
    const c = await cenarioCritico();
    c.armazem.delete(DONO_DA_TRAVA);
    const primeira = depsDaResolucao(c);
    const r = await resolver(c, primeira.deps);
    assert.equal(r.estado, 'RESOLVIDA_COM_TRAVA_PRESERVADA');
    assert.equal(c.armazem.has(TRAVA), true, 'a trava legada não é removida');
    assert.equal(primeira.contagem.remocoes, 1, 'só a trava da própria resolução sai');
    assert.equal(c.s3.dados.get(CHAVE_DA_RESOLUCAO).toString(), c.armazem.get(`resolucao-${ID}.json`));
    invariantes(c);
    c.s3.uso.length = 0;
    const segunda = depsDaResolucao(c);
    assert.equal((await resolver(c, segunda.deps)).estado, 'RESOLVIDA_COM_TRAVA_PRESERVADA', 'repetir é idempotente');
    assert.deepEqual([puts(c.s3), segunda.contagem.escritas], [0, 0]);
    assert.equal(c.armazem.has(TRAVA), true);
    assert.deepEqual(await AG.processarFila({ cfg: cfg(), ids: [ID], s3: c.s3, deps: depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') }) }), { ok: true }, 'a fila reconhece a resolução');
    const novo = depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') });
    preparoS3(c.s3, ID2, { rotulo: ROTULO_DO_PEDIDO2 });
    await falha(AG.processar({ cfg: cfg(), id: ID2, s3: c.s3, deps: novo }));
    assert.equal(novo.chamadas.instalar, 0, 'a trava preservada continua bloqueando o agente');
    assert.equal(c.armazem.has(TRAVA), true);
  });
  test('o modo --resolver-critico sinaliza a trava legada preservada como falha da linha de comando', () => {
    const fonte = fs.readFileSync(path.join(REPO, 'deploy', 'hml', 'cd', 'agente-backend.js'), 'utf8');
    assert.match(fonte, /RESOLVIDA_COM_TRAVA_PRESERVADA[\s\S]*TRAVA_LEGADA_PRESERVADA/);
  });
});

describe('T5 — B2: idempotência diante de falha em cada etapa de persistência', () => {
  const ETAPAS = [
    ['E1: leitura do recibo indisponível', { publicado: true }, (f, s3) => { s3.falhas.get = (k) => k === chaveDe('recibos'); }],
    ['E1: publicação do recibo falha sem gravar', { publicado: false }, (f, s3) => { s3.falhas.put = (k) => (k === chaveDe('recibos') ? 'antes' : null); }],
    ['E2: gravação local da resolução falha sem gravar', { publicado: true }, (f) => { f.escrever = (n) => (n === `resolucao-${ID}.json` ? 'antes' : null); }],
    ['E2: gravação local da resolução grava e responde erro', { publicado: true }, (f) => { f.escrever = (n) => (n === `resolucao-${ID}.json` ? 'depois' : null); }],
    ['E3: publicação da resolução falha sem gravar', { publicado: true }, (f, s3) => { s3.falhas.put = (k) => (k === CHAVE_DA_RESOLUCAO ? 'antes' : null); }],
    // Leituras da chave da resolução sem cópia local: 1) antes da cópia local, 2) antes de gravar no S3, 3) a releitura
    // depois de gravar. A conferência de resolução completa não lê o S3 enquanto não houver cópia local.
    ['E3: releitura da resolução indisponível', { publicado: true }, (f, s3) => { let n = 0; s3.falhas.get = (k) => k === CHAVE_DA_RESOLUCAO && (n += 1) === 3; }],
  ];
  for (const [nome, cenario, injetar] of ETAPAS) {
    test(`${nome}: a trava fica, nada original muda e a nova execução conclui com a mesma resolução`, async () => {
      const c = await cenarioCritico(cenario);
      const primeira = depsDaResolucao(c);
      injetar(primeira.falhas, c.s3);
      await falha(resolver(c, primeira.deps));
      assert.equal(c.armazem.has(TRAVA), true, 'a trava não é liberada antes da hora');
      invariantes(c);
      const localDaPrimeira = c.armazem.get(`resolucao-${ID}.json`);
      c.s3.falhas = {};
      const segunda = depsDaResolucao(c, { agora: () => Date.parse('2026-11-23T22:00:00.000Z') });
      const r = await resolver(c, segunda.deps);
      assert.equal(r.estado, 'RESOLVIDA');
      assert.equal(c.armazem.has(TRAVA), false);
      invariantes(c);
      const remota = c.s3.dados.get(CHAVE_DA_RESOLUCAO).toString();
      assert.equal(remota, c.armazem.get(`resolucao-${ID}.json`));
      if (localDaPrimeira) assert.equal(remota, localDaPrimeira, 'a resolução já gravada é reaproveitada, nunca gerada de novo');
    });
  }
  for (const [nome, chave] of [['E1: recibo gravado com erro na resposta', () => chaveDe('recibos')], ['E3: resolução gravada com erro na resposta', () => CHAVE_DA_RESOLUCAO]]) {
    test(`${nome}: a releitura confirma o objeto e a execução conclui`, async () => {
      const c = await cenarioCritico({ publicado: chave() === CHAVE_DA_RESOLUCAO });
      const { deps } = depsDaResolucao(c);
      c.s3.falhas.put = (k) => (k === chave() ? 'depois' : null);
      const r = await resolver(c, deps);
      assert.equal(r.estado, 'RESOLVIDA');
      assert.equal(c.armazem.has(TRAVA), false);
      invariantes(c);
    });
  }

  test('T5-E4a: queda imediatamente antes da remoção da trava: tudo publicado, trava presente; a retomada só remove a trava', async () => {
    const c = await cenarioCritico();
    const primeira = depsDaResolucao(c);
    primeira.falhas.remover = soTrava('antes');
    await falha(resolver(c, primeira.deps));
    assert.equal(c.armazem.has(TRAVA), true);
    assert.equal(c.s3.dados.get(CHAVE_DA_RESOLUCAO).toString(), c.armazem.get(`resolucao-${ID}.json`));
    invariantes(c);
    c.s3.uso.length = 0;
    const segunda = depsDaResolucao(c, { confirmacaoDaRecuperacao: async () => null });
    const r = await resolver(c, segunda.deps);
    assert.equal(r.estado, 'RESOLVIDA');
    assert.equal(puts(c.s3), 0, 'nada é publicado de novo');
    assert.equal(segunda.contagem.escritas, 0, 'nada é gravado de novo');
    assert.equal(c.armazem.has(TRAVA), false);
    invariantes(c);
  });

  test('T5-E4b: queda imediatamente depois da remoção da trava: a retomada reconhece JA_RESOLVIDA sem gravar nada nem recriar a trava', async () => {
    const c = await cenarioCritico();
    const primeira = depsDaResolucao(c);
    primeira.falhas.remover = soTrava('depois');
    await falha(resolver(c, primeira.deps));
    assert.equal(c.armazem.has(TRAVA), false);
    c.s3.uso.length = 0;
    const segunda = depsDaResolucao(c);
    const r = await resolver(c, segunda.deps);
    assert.equal(r.estado, 'JA_RESOLVIDA');
    assert.equal(puts(c.s3), 0);
    assert.equal(segunda.contagem.escritas, 0);
    assert.equal(c.armazem.has(TRAVA), false, 'a trava não é recriada');
    invariantes(c);
    const fila = await AG.processarFila({ cfg: cfg(), ids: [ID], s3: c.s3, deps: depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') }) });
    assert.deepEqual(fila, { ok: true });
  });

  test('T5-E4c: trava ausente sem resolução completa é estado anômalo: recusa sem gravar e sem criar trava', async () => {
    for (const preparar of [
      (c) => { c.armazem.delete(TRAVA); c.armazem.delete(DONO_DA_TRAVA); },
      (c) => { c.armazem.delete(TRAVA); c.armazem.delete(DONO_DA_TRAVA); c.armazem.set(`resolucao-${ID}.json`, '{"versao":1}'); },
    ]) {
      const c = await cenarioCritico();
      preparar(c);
      const { deps, contagem } = depsDaResolucao(c);
      const e = await falha(resolver(c, deps));
      assert.equal(e.codigo, 'TRAVA_AUSENTE');
      assert.equal(puts(c.s3), 0);
      assert.equal(contagem.escritas, 0);
      assert.equal(c.armazem.has(TRAVA), false);
      invariantes(c);
    }
  });

  test('T5-E4c: trava ausente com resolução local diferente da publicada recusa', async () => {
    const c = await resolvido();
    const local = JSON.parse(c.armazem.get(`resolucao-${ID}.json`));
    c.armazem.set(`resolucao-${ID}.json`, JSON.stringify({ ...local, uid: 0 }));
    const { deps, contagem } = depsDaResolucao(c);
    const e = await falha(resolver(c, deps));
    assert.equal(e.codigo, 'TRAVA_AUSENTE');
    assert.equal(contagem.escritas, 0);
  });
});

describe('T6 — B2: recusas mantêm a trava e não gravam resolução', () => {
  const CASOS = [
    ['recibo publicado diferente do original', 'RECIBO_DIVERGENTE', (c) => { c.s3.dados.set(chaveDe('recibos'), Buffer.from(JSON.stringify({ ...JSON.parse(reciboEsperadoDe(c.registroOriginal)), motivo: 'OUTRO' }))); }],
    ['resolução publicada diferente', 'RESOLUCAO_DIVERGENTE', (c) => { c.s3.dados.set(CHAVE_DA_RESOLUCAO, Buffer.from('{"versao":1,"tipo":"RESOLUCAO_CRITICO"}')); }],
    ['instalador ainda sem confirmação da recuperação', 'RECUPERACAO_NAO_CONFIRMADA', (c, d) => { d.confirmacaoDaRecuperacao = async () => null; }],
    ['confirmação de outra release em uso', 'RECUPERACAO_NAO_CONFIRMADA', (c, d) => { d.confirmacaoDaRecuperacao = async () => confirmacaoPara(c.s3, ID, { rotulo: ROTULO_DO_PEDIDO }); }],
    ['confirmação da reversão de outro pedido', 'RECUPERACAO_NAO_CONFIRMADA', (c, d) => { d.confirmacaoDaRecuperacao = async () => { const x = confirmacaoPara(c.s3); return { ...x, reversao: { ...x.reversao, rotulo: ROTULO_DO_PEDIDO2 } }; }; }],
    ['reversão anterior à criação do pedido', 'RECUPERACAO_NAO_CONFIRMADA', (c, d) => { d.confirmacaoDaRecuperacao = async () => { const x = confirmacaoPara(c.s3); return { ...x, reversao: { ...x.reversao, em: new Date(Date.parse(pedidoNoS3(c.s3).criadoEm) - 60000).toISOString() } }; }; }],
    ['confirmação anterior à reversão', 'RECUPERACAO_NAO_CONFIRMADA', (c, d) => { d.confirmacaoDaRecuperacao = async () => { const x = confirmacaoPara(c.s3); return { ...x, em: new Date(Date.parse(x.reversao.em) - 1).toISOString() }; }; }],
    ['crítico resolvido com outro motivo', 'RECUPERACAO_NAO_CONFIRMADA', (c, d) => { d.confirmacaoDaRecuperacao = async () => confirmacaoPara(c.s3, ID, { criticoResolvido: { motivo: 'ROLLBACK_BLOQUEADO', release: BASE.rotulo } }); }],
    ['recuperação fora de REINICIO, VERSAO e SAUDE', 'RECUPERACAO_NAO_CONFIRMADA', (c, d) => { d.confirmacaoDaRecuperacao = async () => { const x = confirmacaoPara(c.s3); return { ...x, reversao: { ...x.reversao, recuperacao: 'COORDENACAO' } }; }; }],
    ['baseline não comprovada', 'BASELINE_NAO_COMPROVADA', (c, d) => { d.identificar = async () => ({ ...BASE, integro: false }); }],
    ['baseline diferente da registrada antes da operação', 'BASELINE_DIVERGENTE', (c, d) => { d.identificar = async () => saudavel(`hml-20261123T090000-${'5'.repeat(7)}`, '5'.repeat(40)); }],
    ['outro registro pendente', 'OUTRA_OPERACAO_PENDENTE', (c) => { c.armazem.set('45240000000-1.json', JSON.stringify({ versao: 2, id: '45240000000-1', fase: 'INSTALACAO_INICIADA' })); }],
    ['outro registro CRITICO sem resolução', 'OUTRA_OPERACAO_PENDENTE', (c) => { c.armazem.set('45240000000-1.json', JSON.stringify({ versao: 2, id: '45240000000-1', fase: 'TERMINAL', resultado: { estado: 'CRITICO' } })); }],
    ['outro registro CRITICO com arquivo de resolução inválido', 'OUTRA_OPERACAO_PENDENTE', (c) => { c.armazem.set('45240000000-1.json', JSON.stringify({ versao: 2, id: '45240000000-1', fase: 'TERMINAL', resultado: { estado: 'CRITICO' } })); c.armazem.set('resolucao-45240000000-1.json', '{}'); }],
    ['pedido ausente no S3', 'PEDIDO_AUSENTE', (c) => { c.s3.dados.delete(chaveDe('pedidos')); }],
    ['pedido do S3 diferente do registrado', 'REGISTRO_DIVERGENTE', (c) => { c.s3.dados.set(chaveDe('pedidos'), Buffer.from(JSON.stringify(pedidoDe(ID, { releaseSha256: 'e'.repeat(64) })))); }],
    ['trava de outro pedido', 'TRAVA_DE_OUTRO_PEDIDO', (c) => { c.armazem.set(DONO_DA_TRAVA, JSON.stringify({ versao: 1, id: ID2 })); }],
    ['trava com conteúdo inesperado', 'TRAVA_DE_OUTRO_PEDIDO', (c) => { c.armazem.set(`${TRAVA}/outro`, 'x'); }],
    ['trava com identidade ilegível', 'TRAVA_DE_OUTRO_PEDIDO', (c) => { c.armazem.set(DONO_DA_TRAVA, '{'); }],
  ];
  for (const [nome, codigo, preparar] of CASOS) {
    test(`recusa: ${nome}`, async () => {
      const c = await cenarioCritico();
      const { deps, contagem } = depsDaResolucao(c);
      preparar(c, deps);
      const reciboAntes = c.s3.dados.get(chaveDe('recibos')).toString();
      const e = await falha(resolver(c, deps));
      assert.equal(e.codigo, codigo);
      assert.equal(c.armazem.has(TRAVA), true);
      assert.equal(c.armazem.has(`resolucao-${ID}.json`), false);
      assert.equal(c.armazem.get(`${ID}.json`), c.registroOriginal);
      assert.equal(c.s3.dados.get(chaveDe('recibos')).toString(), reciboAntes);
      assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), false);
      assert.equal(contagem.escritas, 0);
      if (codigo !== 'RESOLUCAO_DIVERGENTE') assert.equal(c.s3.dados.has(CHAVE_DA_RESOLUCAO), false);
    });
  }
  test('recusa: registro que não é CRITICO, ausente ou de outro pedido', async () => {
    for (const mudar of [
      (r) => ({ ...r, resultado: { ...r.resultado, estado: 'SUCESSO', verificado: true } }),
      (r) => ({ ...r, fase: 'INSTALACAO_INICIADA' }),
      (r) => ({ ...r, id: ID2 }),
      (r) => { const { antes, ...resto } = r; return resto; },
      (r) => ({ ...r, recibo: { ...r.recibo, motivo: 'OUTRO' } }),
    ]) {
      const c = await cenarioCritico();
      c.armazem.set(`${ID}.json`, JSON.stringify(mudar(JSON.parse(c.registroOriginal))));
      const e = await falha(resolver(c, depsDaResolucao(c).deps));
      assert.equal(e.codigo, 'REGISTRO_NAO_CRITICO');
      assert.equal(c.armazem.has(TRAVA), true);
      assert.equal(c.s3.dados.has(CHAVE_DA_RESOLUCAO), false);
    }
    const c = await cenarioCritico();
    c.armazem.delete(`${ID}.json`);
    const e = await falha(resolver(c, depsDaResolucao(c).deps));
    assert.equal(e.codigo, 'REGISTRO_AUSENTE');
  });
  test('id fora do formato é recusado antes de qualquer leitura', async () => {
    const c = { armazem: new Map(), s3: s3Memoria() };
    const e = await falha(AG.resolverCritico({ cfg: cfg(), id: '../x', s3: c.s3, deps: depsDaResolucao(c).deps }));
    assert.equal(e.codigo, 'ID_INVALIDO');
    assert.equal(c.s3.uso.length, 0);
    assert.equal(c.armazem.size, 0);
  });
});

describe('T6b — B2 só resolve o CRITICO da reversão, com o guardião liberado', () => {
  const LIBERACOES_INSUFICIENTES = [
    ['liberação que falhou', new Error('guardião não respondeu')],
    ['encerramento sem a soltura dos cadeados conferida', { situacao: 'PROCESSO_ENCERRADO', processoEncerrado: true, forcada: false }],
    ['liberação forçada', { ...LIBERACAO, forcada: true }],
  ];
  for (const [nome, liberacao] of LIBERACOES_INSUFICIENTES) {
    test(`recusa GUARDIAO_NAO_LIBERADO: ${nome}`, async () => {
      const c = await cenarioCritico({ liberacao });
      const { deps, contagem } = depsDaResolucao(c);
      const e = await falha(resolver(c, deps));
      assert.equal(e.codigo, 'GUARDIAO_NAO_LIBERADO');
      assert.equal(c.armazem.has(TRAVA), true);
      assert.equal(contagem.escritas, 0);
      assert.equal(c.s3.dados.has(CHAVE_DA_RESOLUCAO), false);
    });
  }
  test('outro CRITICO (liberação incerta após recusa) não é resolvido com a confirmação do incidente anterior', async () => {
    const c = await resolvido();
    const r = await outroCritico(c, { instalar: RECUSA_SEM_MUTACAO, liberacao: new Error('guardião não respondeu') });
    assert.equal(r.motivo, 'LIBERACAO_DA_COORDENACAO_INCERTA');
    assert.equal(c.armazem.has(TRAVA), true);
    const e = await falha(resolver(c, depsDaResolucao(c, {}, ID).deps, ID2));
    assert.equal(e.codigo, 'CRITICO_FORA_DO_ESCOPO');
    assert.equal(c.armazem.has(TRAVA), true, 'a trava do outro incidente fica');
    assert.equal(c.s3.dados.has(chaveDaResolucao(ID2)), false);
  });
  test('outro CRITICO de reversão não é resolvido com a confirmação do incidente anterior', async () => {
    const c = await resolvido();
    await outroCritico(c);
    const e = await falha(resolver(c, depsDaResolucao(c, {}, ID).deps, ID2));
    assert.equal(e.codigo, 'RECUPERACAO_NAO_CONFIRMADA');
    assert.equal(c.armazem.has(TRAVA), true);
    assert.equal(c.s3.dados.has(chaveDaResolucao(ID2)), false);
  });
  // P1 (revisão do Codex): ID1 já tem resolução completa; ID2 terminou CRITICO com uma trava legada vazia. Rodar o B2
  // para ID1 não pode remover a trava de ID2.
  test('P1: a resolução completa de ID1 não remove a trava legada vazia do CRITICO de ID2', async () => {
    const c = await resolvido();
    await outroCritico(c);
    c.armazem.delete(DONO_DA_TRAVA);
    const registroDeId2 = c.armazem.get(`${ID2}.json`);
    c.s3.uso.length = 0;
    const d = depsDaResolucao(c);
    const e = await falha(resolver(c, d.deps));
    assert.equal(e.codigo, 'OUTRA_OPERACAO_PENDENTE');
    assert.equal(c.armazem.has(TRAVA), true, 'a trava de ID2 permanece');
    assert.equal(d.contagem.escritas, 0);
    assert.equal(d.contagem.remocoes, 1, 'só a trava da própria resolução sai');
    assert.equal(puts(c.s3), 0);
    assert.equal(c.armazem.get(`${ID2}.json`), registroDeId2);
    invariantes(c);
  });
  test('P1: trava legada vazia sem registro de dono não é removida, mesmo com a resolução completa e sem pendências', async () => {
    const c = await resolvido();
    c.armazem.set(TRAVA, true);
    const d = depsDaResolucao(c);
    const r = await resolver(c, d.deps);
    assert.equal(r.estado, 'RESOLVIDA_COM_TRAVA_PRESERVADA');
    assert.equal(c.armazem.has(TRAVA), true);
    assert.deepEqual([d.contagem.escritas, d.contagem.remocoes], [0, 1]);
  });
  test('P1: trava com o id de ID1 também não sai se houver outro CRITICO sem resolução', async () => {
    const c = await cenarioCritico();
    const primeira = depsDaResolucao(c);
    primeira.falhas.remover = soTrava('antes');
    await falha(resolver(c, primeira.deps));
    c.armazem.set(`${ID2}.json`, JSON.stringify({ versao: 2, id: ID2, fase: 'TERMINAL', resultado: { estado: 'CRITICO' } }));
    const d = depsDaResolucao(c);
    const e = await falha(resolver(c, d.deps));
    assert.equal(e.codigo, 'OUTRA_OPERACAO_PENDENTE');
    assert.equal(c.armazem.has(TRAVA), true);
    assert.equal(d.contagem.escritas, 0);
  });
  test('com a confirmação do próprio incidente, o segundo CRITICO é resolvido e o primeiro, íntegro, não é pendência', async () => {
    const c = await resolvido();
    await outroCritico(c);
    const r = await resolver(c, depsDaResolucao(c, {}, ID2).deps, ID2);
    assert.equal(r.estado, 'RESOLVIDA');
    assert.equal(c.armazem.has(TRAVA), false);
  });
});

describe('T5b — B2: execuções concorrentes e trava da resolução', () => {
  test('duas execuções simultâneas: uma resolve, a outra recusa RESOLUCAO_EM_CURSO; cópia local igual à publicada', async () => {
    const c = await cenarioCritico();
    const a = depsDaResolucao(c, { agora: () => Date.parse('2026-11-23T21:00:00.000Z') });
    const b = depsDaResolucao(c, { agora: () => Date.parse('2026-11-23T21:00:01.000Z') });
    const [ra, rb] = await Promise.allSettled([resolver(c, a.deps), resolver(c, b.deps)]);
    const resultados = [ra, rb].map((x) => (x.status === 'fulfilled' ? x.value.estado : x.reason.codigo)).sort();
    assert.deepEqual(resultados, ['RESOLUCAO_EM_CURSO', 'RESOLVIDA']);
    assert.equal(c.s3.dados.get(CHAVE_DA_RESOLUCAO).toString(), c.armazem.get(`resolucao-${ID}.json`));
    assert.equal(c.armazem.has(TRAVA), false);
    invariantes(c);
  });
  test('trava da resolução deixada por uma queda: recusa sem gravar e sem removê-la', async () => {
    const c = await cenarioCritico();
    c.armazem.set(TRAVA_DA_RESOLUCAO, true);
    const { deps, contagem } = depsDaResolucao(c);
    const e = await falha(resolver(c, deps));
    assert.equal(e.codigo, 'RESOLUCAO_EM_CURSO');
    assert.deepEqual([contagem.escritas, contagem.remocoes], [0, 0]);
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), true);
    assert.equal(c.armazem.has(TRAVA), true);
    assert.equal(contagem.fechamentos, 1);
  });
});

// ------------------------------------------------------------ S1143: liberação da trava da resolução sem salto em finally

// Analisa a árvore sintática (acorn embutido no Node, sem dependência instalada), não o texto: lista os throw, return,
// break e continue dentro de um bloco finally da função pedida, sem entrar em funções aninhadas.
function saltosEmFinally(fonte, nomeDaFuncao) {
  const roteiro = `
    const { parse } = require('internal/deps/acorn/acorn/dist/acorn');
    const fonte = require('node:fs').readFileSync(0, 'utf8');
    const arvore = parse(fonte, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowHashBang: true });
    const FUNCOES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
    const SALTOS = new Set(['ThrowStatement', 'ReturnStatement', 'BreakStatement', 'ContinueStatement']);
    const achados = [];
    let encontrada = false;
    const visitar = (no, emFinally, dentroDaAlvo) => {
      if (!no || typeof no.type !== 'string') return;
      if (FUNCOES.has(no.type)) {
        if (dentroDaAlvo) return;
        if (no.type === 'FunctionDeclaration' && no.id && no.id.name === ${JSON.stringify(nomeDaFuncao)}) { encontrada = true; visitar(no.body, false, true); }
        else for (const v of Object.values(no)) filhos(v, false, false);
        return;
      }
      if (dentroDaAlvo && emFinally && SALTOS.has(no.type)) achados.push(no.type + ':' + no.loc.start.line);
      if (no.type === 'TryStatement') {
        visitar(no.block, emFinally, dentroDaAlvo);
        visitar(no.handler, emFinally, dentroDaAlvo);
        visitar(no.finalizer, true, dentroDaAlvo);
        return;
      }
      for (const [k, v] of Object.entries(no)) if (k !== 'loc') filhos(v, emFinally, dentroDaAlvo);
    };
    const filhos = (v, emFinally, dentroDaAlvo) => { if (Array.isArray(v)) v.forEach((x) => visitar(x, emFinally, dentroDaAlvo)); else if (v && typeof v === 'object') visitar(v, emFinally, dentroDaAlvo); };
    visitar(arvore, false, false);
    process.stdout.write(JSON.stringify({ encontrada, achados }));
  `;
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['--expose-internals', '-e', roteiro], { input: fonte, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

describe('T5c — S1143: resolverCritico sem salto em finally, com a falha original prevalecendo', () => {
  test('controle: o analisador acusa throw e return em finally e ignora funções aninhadas', () => {
    const exemplo = 'function alvo() { try { a(); } finally { try { b(); } catch (e) { if (x) throw e; } finally { c(); } } }\n'
      + 'function outra() { try {} finally { return 1; } }\nfunction alvo2() { try {} finally { const f = () => { throw 1; }; } }';
    assert.deepEqual(saltosEmFinally(exemplo, 'alvo'), { encontrada: true, achados: ['ThrowStatement:1'] });
    assert.deepEqual(saltosEmFinally(exemplo, 'alvo2'), { encontrada: true, achados: [] });
    assert.deepEqual(saltosEmFinally(exemplo, 'nenhuma'), { encontrada: false, achados: [] });
  });
  test('resolverCritico não tem throw, return, break nem continue dentro de finally', () => {
    const fonte = fs.readFileSync(path.join(REPO, 'deploy', 'hml', 'cd', 'agente-backend.js'), 'utf8');
    assert.deepEqual(saltosEmFinally(fonte, 'resolverCritico'), { encontrada: true, achados: [] });
  });

  const remocaoDaTravaDaResolucao = (fase) => (n) => (n === '.trava-resolucao-cd-backend' ? fase : null);
  test('resolução e liberação bem-sucedidas: RESOLVIDA, trava da resolução removida, âncora fechada uma vez', async () => {
    const c = await cenarioCritico();
    const d = depsDaResolucao(c);
    assert.equal((await resolver(c, d.deps)).estado, 'RESOLVIDA');
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), false);
    assert.equal(d.contagem.fechamentos, 1);
  });
  test('resolução bem-sucedida e liberação que falha: a falha da liberação é relatada, nunca sucesso; a trava da resolução fica e a próxima execução recusa', async () => {
    const c = await cenarioCritico();
    const d = depsDaResolucao(c);
    d.falhas.remover = remocaoDaTravaDaResolucao('antes');
    const e = await falha(resolver(c, d.deps));
    assert.equal(e.message, 'remoção');
    assert.equal(c.s3.dados.get(CHAVE_DA_RESOLUCAO).toString(), c.armazem.get(`resolucao-${ID}.json`), 'a resolução ficou publicada');
    assert.equal(c.armazem.has(TRAVA), false, 'a trava do pedido saiu antes');
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), true);
    assert.equal(d.contagem.fechamentos, 1);
    const seguinte = depsDaResolucao(c);
    assert.equal((await falha(resolver(c, seguinte.deps))).codigo, 'RESOLUCAO_EM_CURSO');
    assert.equal(seguinte.contagem.escritas, 0);
  });
  test('resolução que falha e liberação bem-sucedida: a falha original, trava da resolução removida, trava do pedido preservada', async () => {
    const c = await cenarioCritico();
    const d = depsDaResolucao(c, { confirmacaoDaRecuperacao: async () => null });
    assert.equal((await falha(resolver(c, d.deps))).codigo, 'RECUPERACAO_NAO_CONFIRMADA');
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), false);
    assert.equal(c.armazem.has(TRAVA), true);
    assert.equal(d.contagem.fechamentos, 1);
  });
  test('resolução que falha e liberação que falha: a falha original prevalece', async () => {
    const c = await cenarioCritico();
    const d = depsDaResolucao(c, { confirmacaoDaRecuperacao: async () => null });
    d.falhas.remover = remocaoDaTravaDaResolucao('antes');
    assert.equal((await falha(resolver(c, d.deps))).codigo, 'RECUPERACAO_NAO_CONFIRMADA');
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), true);
    assert.equal(c.armazem.has(TRAVA), true);
    assert.equal(d.contagem.fechamentos, 1);
  });
  test('fechamento da âncora que falha depois de uma resolução bem-sucedida é relatado, nunca sucesso', async () => {
    const c = await cenarioCritico();
    const d = depsDaResolucao(c);
    d.falhas.fechar = true;
    assert.equal((await falha(resolver(c, d.deps))).message, 'fechamento');
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), false, 'a liberação acontece antes do fechamento');
    assert.equal(d.contagem.fechamentos, 1);
  });
  test('fechamento que falha não esconde a falha original', async () => {
    const c = await cenarioCritico();
    const d = depsDaResolucao(c, { confirmacaoDaRecuperacao: async () => null });
    d.falhas.fechar = true;
    assert.equal((await falha(resolver(c, d.deps))).codigo, 'RECUPERACAO_NAO_CONFIRMADA');
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), false);
  });
  test('fechamento que falha não esconde a falha da liberação', async () => {
    const c = await cenarioCritico();
    const d = depsDaResolucao(c);
    d.falhas.remover = remocaoDaTravaDaResolucao('antes');
    d.falhas.fechar = true;
    assert.equal((await falha(resolver(c, d.deps))).message, 'remoção');
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), true);
  });
  test('trava da resolução já existente: RESOLUCAO_EM_CURSO, nada é removido e a âncora é fechada', async () => {
    const c = await cenarioCritico();
    c.armazem.set(TRAVA_DA_RESOLUCAO, true);
    const d = depsDaResolucao(c);
    d.falhas.fechar = true;
    assert.equal((await falha(resolver(c, d.deps))).codigo, 'RESOLUCAO_EM_CURSO');
    assert.equal(d.contagem.remocoes, 0);
    assert.equal(c.armazem.has(TRAVA_DA_RESOLUCAO), true);
    assert.equal(d.contagem.fechamentos, 1);
  });
});

// ------------------------------------------------------------ B3

describe('T7 — B3: a fila pula o CRITICO resolvido e continua', () => {
  test('pula o pedido resolvido sem processar e processa o seguinte', async () => {
    const c = await resolvido();
    preparoS3(c.s3, ID2, { rotulo: ROTULO_DO_PEDIDO2 });
    const deps = depsDoAgente(c.armazem, { instalar: RECUSA_SEM_MUTACAO });
    const r = await AG.processarFila({ cfg: cfg(), ids: [ID, ID2], s3: c.s3, deps });
    assert.deepEqual(r, { ok: false });
    assert.equal(deps.chamadas.instalar, 1, 'só o pedido seguinte chega ao instalador');
    assert.equal(JSON.parse(c.s3.dados.get(chaveDe('recibos', ID2))).estado, 'RECUSADO');
    invariantes(c);
  });
  test('com o estadoDir perdido, a resolução do S3 continua valendo', async () => {
    const c = await resolvido();
    const vazio = new Map();
    const deps = depsDoAgente(vazio, { instalar: async () => assert.fail('não instala') });
    assert.deepEqual(await AG.processarFila({ cfg: cfg(), ids: [ID], s3: c.s3, deps }), { ok: true });
    assert.equal(deps.chamadas.instalar, 0);
    assert.equal(vazio.size, 0, 'nada é gravado no estado local');
  });
  test('sem resolução o CRITICO continua bloqueando', async () => {
    const c = await cenarioCritico();
    c.armazem.delete(TRAVA);
    const deps = depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') });
    const e = await falha(AG.processarFila({ cfg: cfg(), ids: [ID], s3: c.s3, deps }));
    assert.equal(e.codigo, 'RECIBO_INVALIDO_OU_CRITICO');
  });
});

describe('T8 — B3: identidade completa; qualquer divergência bloqueia a fila', () => {
  const MUTACOES = [
    ['commit do pedido na resolução', (r) => { r.pedido.commit = 'e'.repeat(40); }],
    ['rótulo do pedido na resolução', (r) => { r.pedido.rotulo = BASE.rotulo; }],
    ['release do pedido na resolução', (r) => { r.pedido.releaseSha256 = 'e'.repeat(64); }],
    ['blob do pedido na resolução', (r) => { r.pedido.blobSha256 = 'e'.repeat(64); }],
    ['criação do pedido na resolução', (r) => { r.pedido.criadoEm = '2026-01-01T00:00:00.000Z'; }],
    ['vencimento do pedido na resolução', (r) => { r.pedido.expiraEm = '2030-01-01T00:00:00.000Z'; }],
    ['hash do pedido na resolução', (r) => { r.pedido.sha256 = 'e'.repeat(64); }],
    ['hash do recibo na resolução', (r) => { r.recibo.sha256 = 'e'.repeat(64); }],
    ['motivo do recibo na resolução', (r) => { r.recibo.motivo = 'OUTRO'; }],
    ['diagnóstico do recibo na resolução', (r) => { r.recibo.diagnostico = null; }],
    ['estado do recibo na resolução', (r) => { r.recibo.estado = 'SUCESSO'; }],
    ['baseline igual à release do pedido', (r) => { r.baseline.rotulo = ROTULO_DO_PEDIDO; r.registro.antes.rotulo = ROTULO_DO_PEDIDO; r.instalador.rotulo = ROTULO_DO_PEDIDO; r.instalador.criticoResolvido.release = ROTULO_DO_PEDIDO; }],
    ['baseline diferente do registro', (r) => { r.baseline.commit = '5'.repeat(40); }],
    ['confirmação do instalador de outra release', (r) => { r.instalador.rotulo = ROTULO_DO_PEDIDO; }],
    ['evento do instalador diferente', (r) => { r.instalador.evento = 'CONFIRMACAO_DA_ADOCAO'; }],
    ['reversão de outro pedido', (r) => { r.instalador.reversao.rotulo = ROTULO_DO_PEDIDO2; }],
    ['reversão anterior ao pedido', (r) => { r.instalador.reversao.em = '2026-01-01T00:00:00.000Z'; }],
    ['recuperação fora do escopo', (r) => { r.instalador.reversao.recuperacao = 'COORDENACAO'; }],
    ['crítico resolvido com outro motivo', (r) => { r.instalador.criticoResolvido.motivo = 'ROLLBACK_BLOQUEADO'; }],
    ['guardião sem encerramento comprovado', (r) => { r.guardiao.encerramentoComprovado = false; }],
    ['guardião sem soltura dos cadeados', (r) => { r.guardiao.cadeadosLiberadosConfirmados = false; }],
    ['guardião forçado', (r) => { r.guardiao.forcada = true; }],
    ['id da resolução', (r) => { r.id = ID2; }],
    ['escopo da resolução', (r) => { r.escopo = 'frontend'; }],
    ['versão da resolução', (r) => { r.versao = 2; }],
    ['tipo da resolução', (r) => { r.tipo = 'OUTRO'; }],
    ['campo a mais', (r) => { r.extra = true; }],
    ['campo a mais no pedido', (r) => { r.pedido.extra = true; }],
    ['campo a mais na reversão', (r) => { r.instalador.reversao.extra = true; }],
    ['campo faltando', (r) => { delete r.uid; }],
    ['uid inválido', (r) => { r.uid = -1; }],
    ['data inválida', (r) => { r.resolvidoEm = 'ontem'; }],
  ];
  async function filaCom(c, s3) {
    const deps = depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') });
    const e = await falha(AG.processarFila({ cfg: cfg(), ids: [ID], s3, deps }));
    assert.equal(e.codigo, 'RECIBO_INVALIDO_OU_CRITICO');
    assert.equal(deps.chamadas.instalar, 0);
  }
  for (const [nome, mudar] of MUTACOES) {
    test(`resolução adulterada: ${nome}`, async () => {
      const c = await resolvido();
      const r = JSON.parse(c.s3.dados.get(CHAVE_DA_RESOLUCAO).toString());
      mudar(r);
      const s3 = s3Memoria(c.s3.dados);
      s3.dados.set(CHAVE_DA_RESOLUCAO, Buffer.from(JSON.stringify(r)));
      c.armazem.delete(`resolucao-${ID}.json`);
      c.armazem.delete(`${ID}.json`);
      await filaCom(c, s3);
    });
  }
  test('recibo do S3 diferente do que a resolução prende (mesmo id, outro conteúdo)', async () => {
    const c = await resolvido();
    const s3 = s3Memoria(c.s3.dados);
    const recibo = JSON.parse(s3.dados.get(chaveDe('recibos')).toString());
    s3.dados.set(chaveDe('recibos'), Buffer.from(JSON.stringify({ ...recibo, verificado: false, diagnostico: 'OUTRO' })));
    await filaCom(c, s3);
  });
  test('recibo de outro commit ou de outra release', async () => {
    for (const campo of [{ commit: 'e'.repeat(40) }, { releaseSha256: 'e'.repeat(64) }]) {
      const c = await resolvido();
      const s3 = s3Memoria(c.s3.dados);
      const recibo = JSON.parse(s3.dados.get(chaveDe('recibos')).toString());
      s3.dados.set(chaveDe('recibos'), Buffer.from(JSON.stringify({ ...recibo, ...campo })));
      await filaCom(c, s3);
    }
  });
  test('pedido do S3 diferente do que a resolução prende', async () => {
    const c = await resolvido();
    const s3 = s3Memoria(c.s3.dados);
    s3.dados.set(chaveDe('pedidos'), Buffer.from(JSON.stringify(pedidoDe(ID, { expiraEm: '2030-01-01T00:00:00.000Z' }))));
    await filaCom(c, s3);
  });
  test('pedido ausente do S3', async () => {
    const c = await resolvido();
    const s3 = s3Memoria(c.s3.dados);
    s3.dados.delete(chaveDe('pedidos'));
    await filaCom(c, s3);
  });
  test('cópia local da resolução diferente da publicada', async () => {
    const c = await resolvido();
    c.armazem.set(`resolucao-${ID}.json`, `${c.armazem.get(`resolucao-${ID}.json`)} `);
    await filaCom(c, c.s3);
  });
  test('registro local diferente do que a resolução prende', async () => {
    const c = await resolvido();
    const reg = JSON.parse(c.armazem.get(`${ID}.json`));
    c.armazem.set(`${ID}.json`, JSON.stringify({ ...reg, nota: 'alterado' }));
    await filaCom(c, c.s3);
  });
});

// ------------------------------------------------------------ T9 e T10

describe('T9 — o pedido crítico nunca é reprocessado e não deixa trava permanente', () => {
  test('pela fila e por --pedido com o registro local: nenhuma instalação; o CRITICO resolvido solta a trava que acabou de criar', async () => {
    const c = await resolvido();
    const pela = depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') });
    assert.deepEqual(await AG.processarFila({ cfg: cfg(), ids: [ID], s3: c.s3, deps: pela }), { ok: true });
    assert.equal(pela.chamadas.instalar, 0);
    const comRegistro = depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') });
    const e1 = await falha(AG.processar({ cfg: cfg(), id: ID, s3: c.s3, deps: comRegistro }));
    assert.equal(e1.codigo, 'CRITICO_JA_RESOLVIDO');
    assert.equal(comRegistro.chamadas.instalar, 0);
    assert.equal(c.armazem.has(TRAVA), false, 'nenhuma trava permanente');
    invariantes(c);
  });
  test('CRITICO sem resolução continua bloqueando e mantém a trava', async () => {
    const c = await cenarioCritico();
    c.armazem.delete(TRAVA); c.armazem.delete(DONO_DA_TRAVA);
    const e = await falha(AG.processar({ cfg: cfg(), id: ID, s3: c.s3, deps: depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') }) }));
    assert.equal(e.codigo, 'OPERACAO_PENDENTE_OU_CRITICA');
    assert.equal(c.armazem.has(TRAVA), true);
  });
  test('se o S3 falhar nessa conferência a trava fica, e o B2 a remove pela resolução completa, mesmo sem a confirmação ser o último evento', async () => {
    const c = await resolvido();
    c.s3.falhas.get = (k) => k === CHAVE_DA_RESOLUCAO;
    const e = await falha(AG.processar({ cfg: cfg(), id: ID, s3: c.s3, deps: depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') }) }));
    assert.equal(e.codigo, 'OPERACAO_PENDENTE_OU_CRITICA');
    assert.equal(c.armazem.has(TRAVA), true);
    c.s3.falhas = {};
    c.s3.uso.length = 0;
    const d = depsDaResolucao(c, { confirmacaoDaRecuperacao: async () => null, identificar: async () => saudavel(ROTULO_DO_PEDIDO2, COMMIT_DO_PEDIDO) });
    const r = await resolver(c, d.deps);
    assert.equal(r.estado, 'RESOLVIDA');
    assert.equal(puts(c.s3), 0);
    assert.equal(d.contagem.escritas, 0);
    assert.equal(c.armazem.has(TRAVA), false);
  });
  test('B3b: sem registro local, o recibo já publicado recusa antes de qualquer registro; nada é baixado, instalado ou publicado e a trava é solta', async () => {
    const c = await resolvido();
    const vazio = new Map();
    c.s3.uso.length = 0;
    const deps = depsDoAgente(vazio, { instalar: async () => assert.fail('não instala') });
    const e = await falha(AG.processar({ cfg: cfg(), id: ID, s3: c.s3, deps }));
    assert.equal(e.codigo, 'RECIBO_PREEXISTENTE');
    assert.equal(deps.chamadas.instalar, 0);
    assert.equal(c.s3.uso.some(([op, k]) => op === 'get' && (k.includes('/blobs/') || k.includes('/pedidos/'))), false, 'nem o pedido nem o pacote são lidos');
    assert.equal(puts(c.s3), 0, 'nada é publicado');
    assert.equal(vazio.has(`${ID}.json`), false, 'nenhum registro novo');
    assert.equal(vazio.has(TRAVA), false, 'nenhuma trava permanente');
    invariantes(c);
  });
  test('B3b: S3 indisponível na consulta do recibo recusa sem registro e sem trava', async () => {
    const vazio = new Map();
    const s3 = s3Memoria();
    preparoS3(s3);
    s3.falhas.get = (k) => k === chaveDe('recibos');
    const deps = depsDoAgente(vazio, { instalar: async () => assert.fail('não instala') });
    const e = await falha(AG.processar({ cfg: cfg(), id: ID, s3, deps }));
    assert.equal(e.codigo, 'S3_OPERACAO_FALHOU');
    assert.equal(vazio.has(`${ID}.json`), false);
    assert.equal(vazio.has(TRAVA), false);
  });
  test('a identidade da trava que não pode ser gravada solta a trava sem nenhum registro', async () => {
    const armazem = new Map();
    const s3 = s3Memoria();
    preparoS3(s3);
    const falhas = { escrever: (n) => (n === 'pedido.json' ? 'antes' : null) };
    const deps = depsDoAgente(armazem, { instalar: async () => assert.fail('não instala'), falhas });
    await falha(AG.processar({ cfg: cfg(), id: ID, s3, deps }));
    assert.equal(armazem.has(TRAVA), false);
    assert.equal(armazem.has(`${ID}.json`), false);
  });
});

describe('T10 — integridade dos originais em todo o ciclo', () => {
  test('pedido, recibo e registro com o mesmo SHA-256 depois de B2, da fila, das recusas e da retomada; nenhuma trava sobra', async () => {
    const c = await cenarioCritico();
    const hashes = () => [sha(c.s3.dados.get(chaveDe('pedidos'))), sha(c.s3.dados.get(chaveDe('recibos'))), sha(c.armazem.get(`${ID}.json`))];
    const antes = hashes();
    await falha(resolver(c, { ...depsDaResolucao(c).deps, confirmacaoDaRecuperacao: async () => null }));
    assert.deepEqual(hashes(), antes);
    await resolver(c, depsDaResolucao(c).deps);
    assert.deepEqual(hashes(), antes);
    assert.equal((await resolver(c, depsDaResolucao(c).deps)).estado, 'JA_RESOLVIDA');
    await AG.processarFila({ cfg: cfg(), ids: [ID], s3: c.s3, deps: depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') }) });
    await falha(AG.processar({ cfg: cfg(), id: ID, s3: c.s3, deps: depsDoAgente(c.armazem, { instalar: async () => assert.fail('não instala') }) }));
    assert.deepEqual(hashes(), antes);
    assert.equal(c.armazem.has(TRAVA), false);
    assert.equal(sha(c.s3.dados.get(CHAVE_DA_RESOLUCAO)), sha(Buffer.from(c.armazem.get(`resolucao-${ID}.json`))));
  });
});

// ------------------------------------------------------------ integração B1 → B2 com estado real

describe('T11 — integração: B1 real e B2 com a âncora real (modo por caminho)', () => {
  test('a reversão real deste pedido, confirmada pelo B1, é resolvida pelo B2 sobre arquivos reais; a fila passa a pular o pedido', async () => {
    const s3 = s3Memoria();
    const relogio = () => Date.now();
    const amb = await ambienteComRecuperacaoNaoConfirmada({ agora: relogio, antesDaFalha: () => preparoS3(s3, ID, { rotulo: R(2), commit: COMMIT(2) }) });
    ESTADO = tmp();
    const ancoraReal = criarAncoraPorCaminho;
    const baselineReal = async () => ({ ...(await identificarReal(amb)), garantiaContraCorrida: true });
    const r = await AG.processar({ cfg: cfg(), id: ID, s3, deps: depsDoAgente(null, { instalar: FALHA_DA_REVERSAO, criarAncora: ancoraReal, identificar: async () => saudavel(R(1), COMMIT(1)) }) });
    assert.deepEqual([r.estado, r.diagnostico], ['CRITICO', 'REINICIO_FALHOU']);
    assert.ok(fs.statSync(path.join(ESTADO, '.trava-cd-backend')).isDirectory());
    assert.deepEqual(lerJson(path.join(ESTADO, '.trava-cd-backend', 'pedido.json')), { versao: 1, id: ID });
    const registroOriginal = fs.readFileSync(path.join(ESTADO, `${ID}.json`), 'utf8');
    const depsDoB2 = { criarAncora: ancoraReal, identificar: baselineReal, confirmacaoDaRecuperacao: () => leituraDaConfirmacao(amb), agora: relogio, uid: 998 };
    const antes = await falha(AG.resolverCritico({ cfg: cfg(), id: ID, s3, deps: depsDoB2 }));
    assert.equal(antes.code || antes.codigo, 'BASELINE_NAO_COMPROVADA', 'sem o B1 a baseline não está comprovada');
    await confirmarRecuperacao(amb, depsDaConfirmacao(amb, { agora: relogio }).deps);
    const resolucao = await AG.resolverCritico({ cfg: cfg(), id: ID, s3, deps: depsDoB2 });
    assert.equal(resolucao.estado, 'RESOLVIDA');
    assert.equal(fs.existsSync(path.join(ESTADO, '.trava-cd-backend')), false);
    assert.equal(fs.existsSync(path.join(ESTADO, '.trava-resolucao-cd-backend')), false);
    assert.equal(fs.readFileSync(path.join(ESTADO, `${ID}.json`), 'utf8'), registroOriginal);
    const local = fs.readFileSync(path.join(ESTADO, `resolucao-${ID}.json`), 'utf8');
    assert.equal(s3.dados.get(CHAVE_DA_RESOLUCAO).toString(), local);
    const res = JSON.parse(local);
    assert.deepEqual([res.instalador.reversao.rotulo, res.instalador.reversao.recuperacao, res.baseline.rotulo], [R(2), 'REINICIO', R(1)]);
    const fila = depsDoAgente(null, { instalar: async () => assert.fail('não instala'), criarAncora: ancoraReal });
    assert.deepEqual(await AG.processarFila({ cfg: cfg(), ids: [ID], s3, deps: fila }), { ok: true });
    const outra = await falha(AG.processar({ cfg: cfg(), id: ID, s3, deps: fila }));
    assert.equal(outra.codigo, 'CRITICO_JA_RESOLVIDO');
    assert.equal(fs.existsSync(path.join(ESTADO, '.trava-cd-backend')), false);
  });
});
