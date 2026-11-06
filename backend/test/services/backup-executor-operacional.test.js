'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const O = require('../../src/services/backup-executor-operacional.service');
const Pol = require('../../src/services/backup-executor-politica.service');
const Ev = require('../../src/services/backup-executor-evidencia.service');
const { prepararAmbiente, chavesOffline, SEG_MAC, SEG_KEK } = require('../helpers/ambiente-executor');
const { limparRaizes } = require('../helpers/pacote-l2-sintetico');

/**
 * D-ORF-6, executor operacional [OPE]: o COMPOSITOR. Portões (modo, ação, ambiente, confirmação, processo, SDK, chaves, destino local DEDICADO, áreas protegidas e papéis das portas),
 * coordenação exclusiva, estágios de publicação/recuperação/verificação com os módulos reais sobre S3 e chaves falsos, evidência SEMPRE registrada (inclusive nos bloqueios) e
 * liberação garantida. A operação real continua bloqueada pela constante do código.
 */

after(limparRaizes);
const INICIO = Date.UTC(2026, 10, 5, 12, 0, 0);
const relogioDe = (passo = 10) => { let t = INICIO - passo; return () => { t += passo; return t; }; };
const PROTEGIDOS = Object.freeze({ imagens: '/srv/safework/imagens', fiscalizacao: '/srv/safework/fiscalizacao', preparacoes: '/srv/safework/backup/preparacoes', dumps: '/srv/safework/backup/dumps', publicados: '/srv/safework/backup/publicados' });
const ALVOS = { rpoMs: 3600000, rtoMs: 600000 };

function coordenacaoFalsa({ ok = true, motivo = 'EM_USO', lanca = false } = {}) {
  const eventos = [];
  return {
    eventos,
    async adquirir({ operacao }) {
      eventos.push(['adquirir', operacao]);
      if (lanca) throw new Error('BANCO-INDISPONIVEL');
      if (!ok) return { ok: false, motivo };
      return { ok: true, operacao, liberar: async () => { eventos.push(['liberar', operacao]); } };
    },
  };
}
function produtorFalso(x, { ok = true, lanca = false } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async produzir(pedido) {
      chamadas.push(pedido);
      if (lanca) throw new Error('SEGREDO-DO-PRODUTOR');
      return ok ? { ok: true, pacote: { dir: x.pacote.dir, lido: x.pacote.lido } } : { ok: false };
    },
  };
}
function restauradorFalso(relogio, { classe = 'INTEGRO' } = {}) {
  const chamadas = [];
  const iso = (ms) => new Date(ms).toISOString();
  return {
    chamadas,
    async restaurar(pedido) {
      chamadas.push(pedido.pacote);
      const passos = ['BANCO', 'ESQUEMA', 'ARQUIVOS_POR_FONTE', 'CONCILIACAO', 'VEREDITO'].map((id) => ({ id, ok: true, inicioEm: iso(relogio()), fimEm: iso(relogio()) }));
      return { ok: true, passos, restauracao: { ok: true, veredito: { classe }, recuperavelEmProducao: false } };
    },
  };
}
/** Executor com sumidouros em memória (evidência e recibos consolidados). */
function criar(x, { modo = 'ENSAIO', ambiente = 'HOMOLOGACAO', destinoDuravelId, acao = 'BACKUP', confirmacao, fatos = {}, coordenacao = coordenacaoFalsa(), evidencia, recibos } = {}) {
  const linhas = [];
  const consolidados = [];
  const relogio = relogioDe();
  const ex = O.criarExecutorOperacional({
    modo, ambiente, destinoDuravelId: destinoDuravelId ?? x.a.ficha.id, confirmacao: confirmacao === undefined ? Pol.FRASES[modo]?.[acao] ?? null : confirmacao,
    fatos: { sdk: 'SIMULADO', chavesOrigem: 'TESTE_CONTROLADO', uid: 501, umask: 0o077, ...fatos }, relogio, coordenacao,
    evidencia: evidencia ?? { registrar: async (linha) => { linhas.push(linha); } }, recibos: recibos ?? { registrar: async (registro) => { consolidados.push(registro); } }, registro: x.a.reg,
  });
  return { ex, linhas, consolidados, coordenacao, relogio };
}
const pedidoDeBackup = (x, produtor, extra = {}) => ({
  conjuntoId: x.conjuntoId,
  destinoLocal: { validador: x.dlContainers.validador, destinoLocalId: x.dlContainers.id, raiz: x.dlContainers.raiz, nomeContainer: 'container-1' },
  portas: { producao: produtor, publicador: x.a.s3.clientes.publicador, verificador: x.a.s3.clientes.verificador, chaves: x.chaves },
  protegidos: { ...PROTEGIDOS }, limites: { arquivosMaximo: 1000, totalBytesMaximo: 2 ** 30 }, prazoMs: 1000, ...extra,
});
const pedidoDeRestauracao = (x, consolidado, restaurador, extra = {}) => ({
  consolidado,
  destinoLocal: { validador: x.dlRestauracao.validador, destinoLocalId: x.dlRestauracao.id, raiz: x.dlRestauracao.raiz, nomeContainer: 'baixado-1', nomeDecifrado: 'restaurado-1' },
  portas: { restauracao: x.a.s3.clientes.restauracao, restaurador, chaves: chavesOffline().chaves },
  protegidos: { ...PROTEGIDOS }, limites: { totalBytesMaximo: 2 ** 30 }, prazoMs: 1000, alvos: ALVOS, ultimoBackupEm: new Date(INICIO - 30 * 60000).toISOString(), ...extra,
});
const codigo = async (promessa) => { try { await promessa; } catch (e) { return e.code; } return null; };
const lida = (linha) => { const r = Ev.lerLinhaDeEvidencia(linha); assert.equal(r.ok, true, JSON.stringify(r)); return r.evidencia; };
const semEfeitos = (x, produtor, coord) => {
  assert.deepEqual(coord.eventos, []);
  assert.equal(produtor.chamadas.length, 0);
  assert.equal(x.a.s3.chamadas.length, 0);
  assert.deepEqual(fs.readdirSync(x.dlContainers.raiz), []);
};

describe('[OPE] construção', () => {
  test('OPE-01 — opções fora do contrato são erro de programação (CONFIGURACAO_INVALIDA); o executor devolvido é congelado e só tem as três ações', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope1' });
    const { ex } = criar(x);
    assert.deepEqual(Object.keys(ex).sort(), ['executarBackup', 'executarRestauracao', 'verificarDestino']);
    assert.ok(Object.isFrozen(ex));
    const base = { modo: 'ENSAIO', ambiente: 'HOMOLOGACAO', destinoDuravelId: x.a.ficha.id, confirmacao: null, fatos: { sdk: 'SIMULADO', chavesOrigem: 'TESTE_CONTROLADO', uid: 501, umask: 0o077 }, relogio: relogioDe(), coordenacao: coordenacaoFalsa(),
      evidencia: { registrar: async () => {} }, recibos: { registrar: async () => {} }, registro: x.a.reg };
    for (const ruim of [undefined, { ...base, extra: 1 }, { ...base, relogio: 5 }, { ...base, coordenacao: {} }, { ...base, evidencia: {} }, { ...base, recibos: {} }, { ...base, fatos: null }, { ...base, destinoDuravelId: 5 }, { ...base, confirmacao: 5 }, { ...base, modo: 7 }]) {
      assert.equal(await codigo(Promise.resolve().then(() => O.criarExecutorOperacional(ruim))), 'CONFIGURACAO_INVALIDA', JSON.stringify(ruim)?.slice(0, 50));
    }
  });
});

describe('[OPE] backup (ensaio)', () => {
  test('OPE-02 — ciclo completo: coordenação tomada e liberada, produção chamada uma vez com o id da operação, publicação, evidência registrada e legível, recibos consolidados entregues ao sumidouro; nada "durável" nem "operacional"', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope2' });
    const { ex, linhas, consolidados, coordenacao } = criar(x);
    const produtor = produtorFalso(x);
    const r = await ex.executarBackup(pedidoDeBackup(x, produtor));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostico));
    assert.deepEqual(coordenacao.eventos, [['adquirir', 'BACKUP'], ['liberar', 'BACKUP']]);
    assert.equal(produtor.chamadas.length, 1);
    assert.deepEqual(Object.keys(produtor.chamadas[0]).sort(), ['conjuntoId', 'operacaoId']);
    const e = r.evidencia;
    assert.equal(produtor.chamadas[0].operacaoId, e.operacaoId);
    assert.deepEqual({ estado: e.estado, modo: e.modo, acao: e.acao, ambiente: e.ambiente, tipo: e.tipo, destinoId: e.destinoId, codigo: e.codigo, falhouEm: e.falhouEm },
      { estado: 'CONCLUIDO', modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', tipo: 'EXECUCAO_BACKUP', destinoId: x.a.ficha.id, codigo: null, falhouEm: null });
    assert.deepEqual(e.etapas.map((s) => s.id), ['COORDENACAO', 'PRODUCAO', 'DESTINO_LOCAL', 'CIFRA', 'INVENTARIO', 'PRE_VOO', 'ENVIO', 'CONSOLIDACAO', 'CONFIRMACAO', 'VERIFICACAO', 'REGISTRO_DOS_RECIBOS']);
    assert.deepEqual({ op: e.operacional, dur: e.duravelmenteArmazenado, rec: e.recuperavelEmProducao, ch: e.origemDeChaves, dest: e.origemDoDestino, ver: e.verificacaoIndependente, c: e.conjuntoId },
      { op: false, dur: false, rec: false, ch: 'TESTE_CONTROLADO', dest: 'TESTE_CONTROLADO', ver: 'CONFORME', c: 'conjunto-ope2' });
    assert.equal(e.sha256Manifesto, x.pacote.lido.identidade.sha256Manifesto);
    assert.ok(e.arquivos > 0 && e.bytes > 0);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0], r.linha);
    assert.deepEqual(lida(linhas[0]), e);
    assert.equal(r.evidenciaRegistrada, true);
    assert.equal(consolidados.length, 1);
    assert.equal(consolidados[0].sha256, e.sha256Consolidado);
    assert.equal(r.consolidado.recibos.length, e.arquivos);
    assert.ok(Object.isFrozen(r));
  });

  test('OPE-03 — cada portão bloqueia SOZINHO e deixa tudo como estava: evidência BLOQUEADO registrada, nenhuma coordenação, produção, chamada ao S3 ou pasta criada', async () => {
    const casos = [
      ['CONFIRMACAO_AUSENTE_OU_INVALIDA', { confirmacao: 'EXECUTAR_ENSAIO_DE_RESTAURACAO' }],
      ['OPERACAO_NAO_HABILITADA', { modo: 'OPERACAO', confirmacao: Pol.FRASES.OPERACAO.BACKUP }],
      ['ENSAIO_EM_PRODUCAO_PROIBIDO', { ambiente: 'PRODUCAO', destinoDuravelId: 'prod-s3-principal' }],
      ['USUARIO_ROOT', { fatos: { uid: 0 } }],
      ['UMASK_PERMISSIVA', { fatos: { umask: 0o022 } }],
      ['SDK_NAO_APROVADO', { fatos: { sdk: 'NAO_APROVADO' } }],
      ['FONTE_DE_CHAVES_NAO_APROVADA', { fatos: { chavesOrigem: 'AUSENTE' } }],
      ['DESTINO_DURAVEL_NAO_APROVADO', { destinoDuravelId: 'nao-existe' }],
    ];
    for (const [esperado, opcoes] of casos) {
      const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope3' });
      const { ex, linhas, coordenacao } = criar(x, opcoes);
      const produtor = produtorFalso(x);
      const r = await ex.executarBackup(pedidoDeBackup(x, produtor));
      assert.equal(r.ok, false, esperado);
      assert.equal(r.estado, 'BLOQUEADO', esperado);
      assert.ok(r.evidencia.bloqueios.includes(esperado), `${esperado}: ${r.evidencia.bloqueios}`);
      assert.equal(r.evidencia.codigo, r.evidencia.bloqueios[0]);
      assert.deepEqual({ falhouEm: r.evidencia.falhouEm, etapas: r.evidencia.etapas.length }, { falhouEm: 'GATE', etapas: 0 });
      assert.equal(linhas.length, 1);
      assert.deepEqual(lida(linhas[0]), r.evidencia);
      semEfeitos(x, produtor, coordenacao);
    }
  });

  test('OPE-04 — destino local: fora do registro, sem ser o dedicado a contêineres, de outro ambiente ou sobrepondo uma área protegida; e portas fora do papel — bloqueados sem tocar em nada', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope4' });
    const generico = x.a.destinoLocal(x.raiz, { id: 'qualquer-coisa', nome: 'generico' });
    const casos = [
      ['DESTINO_LOCAL_NAO_AUTORIZADO', (p) => { p.destinoLocal.destinoLocalId = 'outro-destino'; }],
      ['DESTINO_LOCAL_NAO_AUTORIZADO', (p) => { p.destinoLocal = { validador: generico.validador, destinoLocalId: generico.id, raiz: generico.raiz, nomeContainer: 'container-1' }; }],
      ['DESTINO_LOCAL_NAO_AUTORIZADO', (p) => { p.destinoLocal.raiz = x.dlRestauracao.raiz; }],
      ['DESTINO_LOCAL_SOBREPOE_AREA_PROTEGIDA', (p) => { p.protegidos = { ...PROTEGIDOS, preparacoes: x.dlContainers.raiz }; }],
      ['DESTINO_LOCAL_SOBREPOE_AREA_PROTEGIDA', (p) => { p.protegidos = { ...PROTEGIDOS, dumps: `${x.dlContainers.raiz}/sub` }; }],
      ['DESTINO_LOCAL_SOBREPOE_AREA_PROTEGIDA', (p) => { p.protegidos = { ...PROTEGIDOS, imagens: x.raiz }; }],
      ['PORTAS_FORA_DO_PAPEL', (p) => { p.portas.restauracao = x.a.s3.clientes.restauracao; }],
      ['PORTAS_FORA_DO_PAPEL', (p) => { p.portas.credenciais = 'x'; }],
    ];
    for (const [esperado, mudar] of casos) {
      const { ex, linhas, coordenacao } = criar(x);
      const produtor = produtorFalso(x);
      const pedido = pedidoDeBackup(x, produtor);
      mudar(pedido);
      const r = await ex.executarBackup(pedido);
      assert.equal(r.estado, 'BLOQUEADO', esperado);
      assert.ok(r.evidencia.bloqueios.includes(esperado), `${esperado}: ${r.evidencia.bloqueios}`);
      assert.equal(linhas.length, 1);
      semEfeitos(x, produtor, coordenacao);
    }
  });

  test('OPE-05 — coordenação recusada (outra operação ou migração em curso) ou indisponível: RECUSADO/FALHOU com código fixo, nada produzido nem enviado, nada a liberar', async () => {
    const quadros = [
      [{ ok: false, motivo: 'EM_USO' }, 'RECUSADO', 'COORDENACAO_EM_USO'],
      [{ ok: false, motivo: 'MIGRACAO_EM_CURSO' }, 'RECUSADO', 'MIGRACAO_EM_CURSO'],
      [{ ok: false, motivo: 'CONSULTA_FALHOU' }, 'FALHOU', 'COORDENACAO_INDISPONIVEL'],
      [{ lanca: true }, 'FALHOU', 'COORDENACAO_INDISPONIVEL'],
    ];
    for (const [opcoes, estado, cod] of quadros) {
      const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope5' });
      const coordenacao = coordenacaoFalsa(opcoes);
      const { ex, linhas } = criar(x, { coordenacao });
      const produtor = produtorFalso(x);
      const r = await ex.executarBackup(pedidoDeBackup(x, produtor));
      assert.deepEqual({ estado: r.estado, codigo: r.evidencia.codigo, falhouEm: r.evidencia.falhouEm }, { estado, codigo: cod, falhouEm: 'COORDENACAO' }, cod);
      assert.deepEqual(coordenacao.eventos, [['adquirir', 'BACKUP']]);
      assert.equal(produtor.chamadas.length, 0);
      assert.equal(x.a.s3.chamadas.length, 0);
      assert.equal(linhas.length, 1);
      assert.doesNotMatch(JSON.stringify(r), /BANCO-INDISPONIVEL/);
    }
  });

  test('OPE-06 — a coordenação é SEMPRE liberada: produção que falha ou lança, envio negado, e sumidouro de evidência que falha; a falha do sumidouro é sinalizada, não escondida', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope6' });
    const c1 = criar(x);
    const p1 = produtorFalso(x, { ok: false });
    const r1 = await c1.ex.executarBackup(pedidoDeBackup(x, p1));
    assert.deepEqual({ estado: r1.estado, codigo: r1.evidencia.codigo, falhouEm: r1.evidencia.falhouEm }, { estado: 'FALHOU', codigo: 'PRODUCAO_FALHOU', falhouEm: 'PRODUCAO' });
    assert.deepEqual(c1.coordenacao.eventos.at(-1), ['liberar', 'BACKUP']);
    const c2 = criar(x);
    const r2 = await c2.ex.executarBackup(pedidoDeBackup(x, produtorFalso(x, { lanca: true })));
    assert.deepEqual({ estado: r2.estado, codigo: r2.evidencia.codigo, falhouEm: r2.evidencia.falhouEm }, { estado: 'FALHOU', codigo: 'ERRO_INESPERADO', falhouEm: 'PRODUCAO' });
    assert.doesNotMatch(JSON.stringify(r2), /SEGREDO/);
    assert.deepEqual(c2.coordenacao.eventos.at(-1), ['liberar', 'BACKUP']);
    assert.equal(x.a.s3.chamadas.length, 0);
    const y = await prepararAmbiente({ conjuntoId: 'conjunto-ope6b' });
    y.a.s3.programarGravacao('NEGAR');
    const c3 = criar(y);
    const r3 = await c3.ex.executarBackup(pedidoDeBackup(y, produtorFalso(y)));
    assert.deepEqual({ estado: r3.estado, codigo: r3.evidencia.codigo, falhouEm: r3.evidencia.falhouEm }, { estado: 'FALHOU', codigo: 'ENVIO_FALHOU', falhouEm: 'ENVIO' });
    assert.deepEqual(c3.coordenacao.eventos.at(-1), ['liberar', 'BACKUP']);
    const z = await prepararAmbiente({ conjuntoId: 'conjunto-ope6c' });
    const c4 = criar(z, { evidencia: { registrar: async () => { throw new Error('DISCO-CHEIO-SEGREDO'); } } });
    const r4 = await c4.ex.executarBackup(pedidoDeBackup(z, produtorFalso(z)));
    assert.deepEqual({ ok: r4.ok, estado: r4.estado, registrada: r4.evidenciaRegistrada }, { ok: true, estado: 'CONCLUIDO', registrada: false });
    assert.doesNotMatch(JSON.stringify(r4), /DISCO-CHEIO/);
    assert.deepEqual(c4.coordenacao.eventos.at(-1), ['liberar', 'BACKUP']);
  });

  test('OPE-07 — resposta perdida no envio vira INCERTO na evidência (com as etapas até o envio e os recibos preservados); o sumidouro de recibos NÃO é chamado sem conjunto consolidado', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope7' });
    x.a.s3.programarGravacao(null, 'PERDER_RESPOSTA');
    const { ex, consolidados } = criar(x);
    const r = await ex.executarBackup(pedidoDeBackup(x, produtorFalso(x)));
    assert.deepEqual({ estado: r.estado, codigo: r.evidencia.codigo, falhouEm: r.evidencia.falhouEm, ok: r.ok }, { estado: 'INCERTO', codigo: 'ENVIO_INCERTO', falhouEm: 'ENVIO', ok: false });
    assert.deepEqual(r.evidencia.etapas.map((s) => [s.id, s.ok]), [['COORDENACAO', true], ['PRODUCAO', true], ['DESTINO_LOCAL', true], ['CIFRA', true], ['INVENTARIO', true], ['PRE_VOO', true], ['ENVIO', false]]);
    assert.equal(r.consolidado, null);
    assert.equal(consolidados.length, 0);
    assert.equal(r.evidencia.sha256Consolidado, null);
  });

  test('OPE-08 — a evidência não carrega caminho, segredo nem texto de erro (nem o caminho do contêiner, nem material de chave, nem mensagens das portas)', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope8' });
    const { ex, linhas } = criar(x);
    await ex.executarBackup(pedidoDeBackup(x, produtorFalso(x)));
    const bruto = linhas.join('');
    assert.doesNotMatch(bruto, new RegExp(x.raiz.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const segredo of [SEG_MAC, SEG_KEK]) assert.equal(bruto.includes(segredo.toString('hex')) || bruto.includes(segredo.toString('base64')), false);
    assert.doesNotMatch(bruto, /\/Users\/|\/private\/|\/tmp\//);
  });
});

describe('[OPE] restauração e verificação do destino (ensaio)', () => {
  async function cicloDeBackup(conjuntoId) {
    const x = await prepararAmbiente({ conjuntoId });
    const b = criar(x);
    const r = await b.ex.executarBackup(pedidoDeBackup(x, produtorFalso(x)));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostico));
    return { x, consolidado: r.consolidado };
  }

  test('OPE-09 — restauração a partir do consolidado: coordenação RESTAURACAO, destino dedicado à restauração, áreas protegidas e teto de bytes repassados ao baixador, DR avaliado, evidência de restauração', async () => {
    const { x, consolidado } = await cicloDeBackup('conjunto-ope9');
    const { ex, linhas, coordenacao, relogio } = criar(x, { acao: 'RESTAURACAO' });
    const restaurador = restauradorFalso(relogio);
    const r = await ex.executarRestauracao(pedidoDeRestauracao(x, consolidado, restaurador));
    assert.equal(r.ok, true, JSON.stringify(r.diagnostico));
    assert.deepEqual(coordenacao.eventos, [['adquirir', 'RESTAURACAO'], ['liberar', 'RESTAURACAO']]);
    const e = r.evidencia;
    assert.deepEqual({ tipo: e.tipo, estado: e.estado, conjuntoId: e.conjuntoId, rec: e.recuperavelEmProducao, op: e.operacional }, { tipo: 'EXECUCAO_RESTAURACAO', estado: 'CONCLUIDO', conjuntoId: 'conjunto-ope9', rec: false, op: false });
    assert.deepEqual(e.etapas.map((s) => s.id), ['COORDENACAO', 'DESTINO_LOCAL', 'RESTAURAR_CONTAINER', 'VERIFICAR_PACOTE', 'RESTAURAR_FONTES', 'AVALIAR_DR']);
    assert.equal(r.dr.classe, 'RECUPERADO');
    assert.equal(restaurador.chamadas.length, 1);
    assert.ok(e.arquivos > 0 && e.bytes > 0);
    assert.deepEqual(fs.readdirSync(x.dlRestauracao.raiz).sort(), ['baixado-1', 'restaurado-1']);
    assert.deepEqual(lida(linhas[0]), e);
  });

  test('OPE-10 — B3: restauração em destino que não é o dedicado, com área protegida sobreposta ou com portas fora do papel (publicador) é BLOQUEADA; protegidas incompletas ou sem teto de bytes são erro de programação', async () => {
    const { x, consolidado } = await cicloDeBackup('conjunto-ope10');
    const restaurador = restauradorFalso(relogioDe());
    const generico = x.a.destinoLocal(x.raiz, { id: 'qualquer-coisa', nome: 'generico2' });
    const bloqueios = [
      ['DESTINO_LOCAL_NAO_AUTORIZADO', (p) => { p.destinoLocal = { validador: generico.validador, destinoLocalId: generico.id, raiz: generico.raiz, nomeContainer: 'baixado-1', nomeDecifrado: 'restaurado-1' }; }],
      ['DESTINO_LOCAL_NAO_AUTORIZADO', (p) => { p.destinoLocal = { validador: x.dlContainers.validador, destinoLocalId: x.dlContainers.id, raiz: x.dlContainers.raiz, nomeContainer: 'baixado-1', nomeDecifrado: 'restaurado-1' }; }],
      ['DESTINO_LOCAL_SOBREPOE_AREA_PROTEGIDA', (p) => { p.protegidos = { ...PROTEGIDOS, publicados: x.dlRestauracao.raiz }; }],
      ['PORTAS_FORA_DO_PAPEL', (p) => { p.portas.publicador = x.a.s3.clientes.publicador; }],
    ];
    for (const [esperado, mudar] of bloqueios) {
      const { ex, coordenacao } = criar(x, { acao: 'RESTAURACAO' });
      const pedido = pedidoDeRestauracao(x, consolidado, restaurador);
      mudar(pedido);
      const r = await ex.executarRestauracao(pedido);
      assert.equal(r.estado, 'BLOQUEADO', esperado);
      assert.ok(r.evidencia.bloqueios.includes(esperado), `${esperado}: ${r.evidencia.bloqueios}`);
      assert.deepEqual(coordenacao.eventos, []);
    }
    assert.equal(restaurador.chamadas.length, 0);
    const { ex } = criar(x, { acao: 'RESTAURACAO' });
    const ruins = [(p) => { delete p.protegidos.dumps; }, (p) => { p.protegidos.extra = '/srv/outra'; }, (p) => { p.protegidos.dumps = 'relativo'; }, (p) => { p.limites = {}; }, (p) => { p.limites = { totalBytesMaximo: 0 }; },
      (p) => { p.protegidos = undefined; }, (p) => { p.protegidos = { ...PROTEGIDOS, dumps: PROTEGIDOS.imagens }; }];
    for (const mudar of ruins) {
      const pedido = pedidoDeRestauracao(x, consolidado, restaurador);
      mudar(pedido);
      assert.equal(await codigo(ex.executarRestauracao(pedido)), 'ENTRADA_INVALIDA');
    }
    assert.deepEqual(fs.readdirSync(x.dlRestauracao.raiz), []);
  });

  test('OPE-11 — verificação do destino (papel do verificador, fora do host): conforme; versão extra forjada vira FALHOU com VERIFICACAO_DIVERGENTE; credencial de outro papel nunca conforma; não toma coordenação', async () => {
    const { x, consolidado } = await cicloDeBackup('conjunto-ope11');
    const ok = criar(x, { acao: 'VERIFICACAO_DESTINO' });
    const r = await ok.ex.verificarDestino({ consolidado, portas: { verificador: x.a.s3.clientes.verificador } });
    assert.deepEqual({ ok: r.ok, estado: r.estado, tipo: r.evidencia.tipo, ver: r.evidencia.verificacaoIndependente, etapas: r.evidencia.etapas.map((s) => s.id) }, { ok: true, estado: 'CONCLUIDO', tipo: 'EXECUCAO_VERIFICACAO_DESTINO', ver: 'CONFORME', etapas: ['VERIFICAR_DESTINO'] });
    assert.deepEqual(ok.coordenacao.eventos, []);
    x.a.s3.injetarVersaoExtra(consolidado.recibos[0].chave, 'forjado');
    const div = criar(x, { acao: 'VERIFICACAO_DESTINO' });
    const d = await div.ex.verificarDestino({ consolidado, portas: { verificador: x.a.s3.clientes.verificador } });
    assert.deepEqual({ ok: d.ok, estado: d.estado, codigo: d.evidencia.codigo, ver: d.evidencia.verificacaoIndependente }, { ok: false, estado: 'FALHOU', codigo: 'VERIFICACAO_DIVERGENTE', ver: 'DIVERGENTE' });
    const trocado = criar(x, { acao: 'VERIFICACAO_DESTINO' });
    const comIdentidadeTrocada = { ...x.a.s3.clientes.verificador, identidade: x.a.s3.clientes.publicador.identidade };
    const t = await trocado.ex.verificarDestino({ consolidado, portas: { verificador: comIdentidadeTrocada } });
    assert.equal(t.ok, false);
    const foraDoPapel = await criar(x, { acao: 'VERIFICACAO_DESTINO' }).ex.verificarDestino({ consolidado, portas: { verificador: x.a.s3.clientes.verificador, publicador: x.a.s3.clientes.publicador } });
    assert.deepEqual({ estado: foraDoPapel.estado, bloqueado: foraDoPapel.evidencia.bloqueios.includes('PORTAS_FORA_DO_PAPEL') }, { estado: 'BLOQUEADO', bloqueado: true });
  });

  test('OPE-12 — consolidado inválido ou pedido fora do contrato nunca chega a produzir efeito: ENTRADA_INVALIDA (erro de programação) antes de qualquer porta', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-ope12' });
    const { ex, coordenacao } = criar(x, { acao: 'RESTAURACAO' });
    for (const ruim of [undefined, {}, { consolidado: null, portas: {} }, { consolidado: {}, portas: null }]) {
      assert.equal(await codigo(ex.executarRestauracao(ruim)), 'ENTRADA_INVALIDA');
      assert.equal(await codigo(ex.verificarDestino(ruim)), 'ENTRADA_INVALIDA');
    }
    assert.equal(await codigo(ex.executarBackup(undefined)), 'ENTRADA_INVALIDA');
    assert.equal(await codigo(ex.executarBackup({ ...pedidoDeBackup(x, produtorFalso(x)), conjuntoId: '../x' })), 'ENTRADA_INVALIDA');
    assert.deepEqual(coordenacao.eventos, []);
    assert.equal(x.a.s3.chamadas.length, 0);
  });
});
