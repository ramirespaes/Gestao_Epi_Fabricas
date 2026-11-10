'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Cmp = require('../../src/services/backup-executor-compositor.service');
const L = require('../../src/services/backup-executor-ligacao.service');
const C = require('../../src/services/backup-executor-credenciais.service');
const Pol = require('../../src/services/backup-executor-politica.service');
const Ev = require('../../src/services/backup-executor-evidencia.service');
const { criarLeitorDePacote } = require('../../src/services/backup-executor-leitor-pacote.service');
const { ehResultadoDoLeitor } = require('../../src/services/backup-fontes-manifesto-l2.service');
const { prepararAmbiente, chavesOffline } = require('../helpers/ambiente-executor');
const { limparRaizes } = require('../helpers/pacote-l2-sintetico');
const { criarSdkFalso } = require('../helpers/sdk-aws-falso');
const B1 = require('../../src/services/backup-privilegios-b1.service');

/**
 * D-ORF-6, L2 (Bloco C) [CMP]: compositor local do executor. Ligação (forma do Bloco A; e a REAL sobre o SDK falso), leitor de pacote REAL, executor operacional real sobre S3 e chaves
 * falsos; portões, coordenação, evidência, recibos e auditoria; nada contata a AWS e a operação real continua desligada.
 */

after(limparRaizes);
const INICIO = Date.UTC(2026, 10, 7, 12, 0, 0);
const relogioDe = (passo = 10) => { let t = INICIO - passo; return () => { t += passo; return t; }; };
const PROTEGIDOS = Object.freeze({ imagens: '/srv/safework/imagens', fiscalizacao: '/srv/safework/fiscalizacao', preparacoes: '/srv/safework/backup/preparacoes', dumps: '/srv/safework/backup/dumps', publicados: '/srv/safework/backup/publicados' });
const ALVOS = { rpoMs: 3600000, rtoMs: 600000 };
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
const lida = (linha) => { const r = Ev.lerLinhaDeEvidencia(linha); assert.equal(r.ok, true, JSON.stringify(r)); return r.evidencia; };
const dl = (d) => ({ validador: d.validador, destinoLocalId: d.id, raiz: d.raiz });

function coordenacaoFalsa({ ok = true, motivo = 'EM_USO', lanca = false } = {}) {
  const eventos = [];
  return { eventos, async adquirir({ operacao }) { eventos.push(['adquirir', operacao]); if (lanca) throw new Error('BANCO-INDISPONIVEL'); if (!ok) return { ok: false, motivo }; return { ok: true, operacao, liberar: async () => { eventos.push(['liberar', operacao]); } }; } };
}
/** Ligação na FORMA do Bloco A, com as portas do S3 falso (o SDK falso só reconhece a sua própria credencial, por isso o ciclo completo usa as portas prontas do ambiente). */
function ligacaoDeTeste(acao, modo, x, finalizar) {
  const portas = acao === 'BACKUP' ? { publicador: x.a.s3.clientes.publicador, ...(modo === 'ENSAIO' ? { verificador: x.a.s3.clientes.verificador } : {}) }
    : acao === 'RESTAURACAO' ? { restauracao: x.a.s3.clientes.restauracao } : { verificador: x.a.s3.clientes.verificador };
  const recebidas = [];
  const auditoria = finalizar ?? (async (e) => { recebidas.push(e); return { gravado: true, id: String(recebidas.length) }; });
  return { recebidas, lig: Object.freeze({ acao, modo, portas: Object.freeze(portas), kms: acao === 'VERIFICACAO_DESTINO' ? null : Object.freeze({ decifrar: async () => { throw new Error('não usado'); } }), finalizar: auditoria }) };
}
/** Porta `producao` que entrega o pacote sintético LIDO PELO LEITOR REAL (é o contrato L7 ponta a ponta: o `lido` que a produção entrega é o que a publicação cifra). */
function producaoComLeitorReal(x, { ok = true } = {}) {
  const leitor = criarLeitorDePacote({ fonteDeChaves: x.fonteMac, raizPublicados: x.raiz });
  const chamadas = [];
  const lidos = [];
  return { chamadas, lidos, async produzir(pedido) { chamadas.push(pedido); if (!ok) return { ok: false, codigo: 'PRODUCAO_COMPOSICAO_FALHOU' }; const lido = await leitor.lerPacote({ dir: x.pacote.dir, nome: 'pacote' }); lidos.push(lido); return { ok: true, pacote: { dir: x.pacote.dir, lido } }; } };
}
function restauradorFalso(relogio) {
  const chamadas = [];
  const iso = (ms) => new Date(ms).toISOString();
  return { chamadas, async restaurar(pedido) { chamadas.push(pedido); const passos = ['BANCO', 'ESQUEMA', 'ARQUIVOS_POR_FONTE', 'CONCILIACAO', 'VEREDITO'].map((id) => ({ id, ok: true, inicioEm: iso(relogio()), fimEm: iso(relogio()) })); return { ok: true, passos, restauracao: { ok: true, veredito: { classe: 'INTEGRO' }, recuperavelEmProducao: false } }; } };
}
function opcoes(x, { acao = 'BACKUP', modo = 'ENSAIO', lig, producao, restaurador, trabalho, coordenacao = coordenacaoFalsa(), evidencia, recibos, fatos = {}, chaves, relogio = relogioDe() } = {}) {
  const linhas = [];
  const consolidados = [];
  const base = {
    ligacao: lig, coordenacao, evidencia: evidencia ?? { registrar: async (l) => { linhas.push(l); } }, recibos: recibos ?? { registrar: async (r) => { consolidados.push(r); } },
    trabalho, fatos: { sdk: 'SIMULADO', chavesOrigem: 'TESTE_CONTROLADO', uid: 501, umask: 0o077, ...fatos }, relogio, registro: x.a.reg,
  };
  const porAcao = acao === 'BACKUP' ? { producao, chaves: chaves ?? x.chaves, destinoLocal: dl(x.dlContainers), protegidos: { ...PROTEGIDOS }, limites: { arquivosMaximo: 1000, totalBytesMaximo: 2 ** 30 }, prazoMs: 1000 }
    : acao === 'RESTAURACAO' ? { restaurador, chaves: chaves ?? chavesOffline().chaves, destinoLocal: dl(x.dlRestauracao), protegidos: { ...PROTEGIDOS }, limites: { totalBytesMaximo: 2 ** 30 }, prazoMs: 1000 } : {};
  return { o: { ...base, ...porAcao }, linhas, consolidados, coordenacao, relogio };
}
const pedido = (x, acao, modo, extra = {}) => ({ modo, acao, ambiente: 'HOMOLOGACAO', destino: x.a.ficha.id, confirmacao: Pol.FRASES[modo][acao], ...extra });

async function cicloDeBackup(conjuntoId) {
  const x = await prepararAmbiente({ conjuntoId });
  const { lig, recebidas } = ligacaoDeTeste('BACKUP', 'ENSAIO', x);
  const producao = producaoComLeitorReal(x);
  const c = opcoes(x, { lig, producao, trabalho: { conjuntoId, nomeContainer: 'container-1' } });
  const cmp = Cmp.criarCompositor(c.o);
  const r = await cmp.compor(pedido(x, 'BACKUP', 'ENSAIO')).executar();
  return { x, lig, recebidas, producao, c, cmp, r };
}

describe('[CMP] construção e pedido', () => {
  test('CMP-01 — configuração estrita por ação: chaves exatas, ligação na forma do Bloco A coerente com a ação/modo, trabalho exato, portas por papel; o compositor é congelado', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-cmp1' });
    const { lig } = ligacaoDeTeste('BACKUP', 'ENSAIO', x);
    const { o } = opcoes(x, { lig, producao: producaoComLeitorReal(x), trabalho: { conjuntoId: 'conjunto-cmp1', nomeContainer: 'c' } });
    const cmp = Cmp.criarCompositor(o);
    assert.ok(Object.isFrozen(cmp));
    assert.deepEqual({ acao: cmp.acao, modo: cmp.modo, chaves: Object.keys(cmp).sort() }, { acao: 'BACKUP', modo: 'ENSAIO', chaves: ['acao', 'compor', 'modo'] });
    const { producao: _p, ...semProducao } = o;
    const { chaves: _c, ...semChaves } = o;
    const { trabalho: _t, ...semTrabalho } = o;
    const ruins = {
      indefinido: undefined, extra: { ...o, extra: 1 }, semProducao, semChaves, semTrabalho, restauradorEmBackup: { ...o, restaurador: { restaurar: async () => ({}) } },
      trabalhoIncompleto: { ...o, trabalho: { conjuntoId: 'c' } }, trabalhoComExtra: { ...o, trabalho: { conjuntoId: 'c', nomeContainer: 'c', consolidado: {} } },
      producaoSemFuncao: { ...o, producao: {} }, coordenacaoSemFuncao: { ...o, coordenacao: {} }, evidenciaSemFuncao: { ...o, evidencia: {} }, recibosSemFuncao: { ...o, recibos: {} },
      relogio: { ...o, relogio: 5 }, gerarId: { ...o, gerarId: 'x' }, destinoLocalIncompleto: { ...o, destinoLocal: { validador: o.destinoLocal.validador, raiz: o.destinoLocal.raiz } },
      ligacaoNula: { ...o, ligacao: null }, ligacaoSemFinalizar: { ...o, ligacao: { ...lig, finalizar: 1 } }, ligacaoModoInvalido: { ...o, ligacao: { ...lig, modo: 'PRODUCAO' } },
      ligacaoSemKms: { ...o, ligacao: { ...lig, kms: null } }, ligacaoPortaErrada: { ...o, ligacao: { ...lig, portas: { restauracao: lig.portas.publicador } } },
      ligacaoSemPublicador: { ...o, ligacao: { ...lig, portas: { verificador: lig.portas.verificador } } },
      verificadorNaOperacao: { ...o, ligacao: { ...lig, modo: 'OPERACAO' } },
      ligacaoDeOutraAcao: { ...o, ligacao: ligacaoDeTeste('RESTAURACAO', 'ENSAIO', x).lig },
    };
    for (const [nome, ruim] of Object.entries(ruins)) assert.equal(codigo(() => Cmp.criarCompositor(ruim)), 'COMPOSITOR_CONFIGURACAO_INVALIDA', nome);
    // VERIFICACAO_DESTINO não aceita portas/chaves locais; KMS tem de ser nulo
    const v = ligacaoDeTeste('VERIFICACAO_DESTINO', 'ENSAIO', x).lig;
    const { o: ov } = opcoes(x, { acao: 'VERIFICACAO_DESTINO', lig: v, trabalho: { consolidado: { conjuntoId: 'c', recibos: [] } } });
    assert.equal(codigo(() => Cmp.criarCompositor(ov)), null);
    assert.equal(codigo(() => Cmp.criarCompositor({ ...ov, chaves: x.chaves })), 'COMPOSITOR_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => Cmp.criarCompositor({ ...ov, ligacao: { ...v, kms: {} } })), 'COMPOSITOR_CONFIGURACAO_INVALIDA');
  });

  test('CMP-02 — compor: forma exata do pedido do CLI, modo e ação IGUAIS aos da ligação, ambiente conhecido, destino no formato; devolve a execução congelada', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-cmp2' });
    const { lig } = ligacaoDeTeste('BACKUP', 'ENSAIO', x);
    const cmp = Cmp.criarCompositor(opcoes(x, { lig, producao: producaoComLeitorReal(x), trabalho: { conjuntoId: 'conjunto-cmp2', nomeContainer: 'c' } }).o);
    const p = pedido(x, 'BACKUP', 'ENSAIO');
    for (const ruim of [undefined, {}, { ...p, extra: 1 }, (({ confirmacao: _c, ...r }) => r)(p), { ...p, ambiente: 'TESTE' }, { ...p, destino: 7 }, { ...p, destino: 'Destino Inválido' }, { ...p, confirmacao: 5 }]) {
      assert.equal(codigo(() => cmp.compor(ruim)), 'COMPOSITOR_PEDIDO_INVALIDO', JSON.stringify(ruim));
    }
    assert.equal(codigo(() => cmp.compor({ ...p, acao: 'RESTAURACAO' })), 'COMPOSITOR_PEDIDO_INCOERENTE');
    assert.equal(codigo(() => cmp.compor({ ...p, modo: 'OPERACAO', confirmacao: Pol.FRASES.OPERACAO.BACKUP })), 'COMPOSITOR_PEDIDO_INCOERENTE');
    const ex = cmp.compor(p);
    assert.ok(Object.isFrozen(ex));
    assert.deepEqual({ ...ex, executar: typeof ex.executar }, { acao: 'BACKUP', modo: 'ENSAIO', ambiente: 'HOMOLOGACAO', destino: x.a.ficha.id, executar: 'function' });
  });
});

describe('[CMP] backup (ensaio) com o leitor real — contrato L7 ponta a ponta', () => {
  test('CMP-03 — ciclo completo: coordenação tomada e liberada, produção chamada uma vez, o `lido` do leitor REAL é o que a publicação cifra (mesmo hash na evidência), evidência registrada, recibos entregues, auditoria recebe a MESMA linha', async () => {
    const { x, recebidas, producao, c, r } = await cicloDeBackup('conjunto-cmp3');
    assert.equal(r.ok, true, JSON.stringify(r.diagnostico));
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.auditoria));
    assert.deepEqual(c.coordenacao.eventos, [['adquirir', 'BACKUP'], ['liberar', 'BACKUP']]);
    assert.equal(producao.chamadas.length, 1);
    assert.deepEqual(Object.keys(producao.chamadas[0]).sort(), ['conjuntoId', 'operacaoId']);
    assert.ok(ehResultadoDoLeitor(producao.lidos[0]), 'o lido entregue é do leitor L2');
    const e = r.evidencia;
    assert.deepEqual({ estado: e.estado, tipo: e.tipo, modo: e.modo, acao: e.acao, ambiente: e.ambiente, destino: e.destinoId, codigo: e.codigo, falhouEm: e.falhouEm },
      { estado: 'CONCLUIDO', tipo: 'EXECUCAO_BACKUP', modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destino: x.a.ficha.id, codigo: null, falhouEm: null });
    assert.equal(producao.chamadas[0].operacaoId, e.operacaoId);
    assert.deepEqual(e.etapas.map((s) => s.id), ['COORDENACAO', 'PRODUCAO', 'DESTINO_LOCAL', 'CIFRA', 'INVENTARIO', 'PRE_VOO', 'ENVIO', 'CONSOLIDACAO', 'CONFIRMACAO', 'VERIFICACAO', 'REGISTRO_DOS_RECIBOS']);
    assert.equal(e.sha256Manifesto, x.pacote.lido.sha256, 'o hash do manifesto na evidência é o do pacote escrito pelo escritor L2 e lido pelo leitor real');
    assert.equal(e.sha256Manifesto, producao.lidos[0].identidade.sha256Manifesto);
    assert.deepEqual({ op: e.operacional, dur: e.duravelmenteArmazenado, rec: e.recuperavelEmProducao, ch: e.origemDeChaves, dest: e.origemDoDestino, ver: e.verificacaoIndependente }, { op: false, dur: false, rec: false, ch: 'TESTE_CONTROLADO', dest: 'TESTE_CONTROLADO', ver: 'CONFORME' });
    assert.deepEqual([c.linhas.length, c.linhas[0] === r.linha, r.evidenciaRegistrada, c.consolidados.length, c.consolidados[0].sha256 === e.sha256Consolidado], [1, true, true, 1, true]);
    assert.deepEqual(lida(r.linha), e);
    assert.deepEqual(r.auditoria, { gravado: true });
    assert.deepEqual(recebidas, [{ linha: r.linha }]);
    assert.ok(r.consolidado !== null && r.consolidado.conjuntoId === 'conjunto-cmp3');
  });

  test('CMP-04 — OPERACAO: BLOQUEADO pelos portões (OPERACAO_NAO_HABILITADA, portas simuladas, chaves de teste e destino de teste fora da operação); nada é produzido, nada vai ao S3, nada no destino local; a auditoria recebe a linha de bloqueio', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-cmp4' });
    const { lig, recebidas } = ligacaoDeTeste('BACKUP', 'OPERACAO', x);
    const producao = producaoComLeitorReal(x);
    const c = opcoes(x, { lig, producao, trabalho: { conjuntoId: 'conjunto-cmp4', nomeContainer: 'c' } });
    const cmp = Cmp.criarCompositor(c.o);
    const r = await cmp.compor(pedido(x, 'BACKUP', 'OPERACAO')).executar();
    assert.deepEqual({ ok: r.ok, estado: r.estado, falhouEm: r.evidencia.falhouEm, etapas: r.evidencia.etapas.length }, { ok: false, estado: 'BLOQUEADO', falhouEm: 'GATE', etapas: 0 });
    for (const b of ['OPERACAO_NAO_HABILITADA', 'PORTAS_SIMULADAS_FORA_DE_TESTE', 'FONTE_DE_CHAVES_NAO_APROVADA', 'DESTINO_DURAVEL_NAO_APROVADO']) assert.ok(r.evidencia.bloqueios.includes(b), b);
    assert.equal(r.evidencia.codigo, r.evidencia.bloqueios[0]);
    assert.deepEqual([c.coordenacao.eventos, producao.chamadas.length, x.a.s3.chamadas.length, fs.readdirSync(x.dlContainers.raiz)], [[], 0, 0, []]);
    assert.deepEqual([c.linhas.length, r.evidenciaRegistrada, recebidas.length, recebidas[0].linha === r.linha, r.auditoria.gravado], [1, true, 1, true, true]);
    assert.equal(Pol.OPERACAO_HABILITADA, false);
  });

  test('CMP-05 — coordenação: EM_USO vira RECUSADO sem produzir; MIGRACAO_EM_CURSO idem; coordenação que lança vira FALHOU/COORDENACAO_INDISPONIVEL; em todos a evidência e a auditoria existem', async () => {
    const casos = [[{ ok: false }, 'RECUSADO', 'COORDENACAO_EM_USO'], [{ ok: false, motivo: 'MIGRACAO_EM_CURSO' }, 'RECUSADO', 'MIGRACAO_EM_CURSO'], [{ lanca: true }, 'FALHOU', 'COORDENACAO_INDISPONIVEL'],
      [{ ok: false, motivo: 'PRIVILEGIOS_B1_PENDENTES' }, 'RECUSADO', 'PRIVILEGIOS_B1_PENDENTES'], [{ ok: false, motivo: 'PRIVILEGIOS_B1_NAO_VERIFICADOS' }, 'FALHOU', 'PRIVILEGIOS_B1_NAO_VERIFICADOS']];
    for (const [cfg, estado, cod] of casos) {
      const x = await prepararAmbiente({ conjuntoId: 'conjunto-cmp5' });
      const { lig, recebidas } = ligacaoDeTeste('BACKUP', 'ENSAIO', x);
      const producao = producaoComLeitorReal(x);
      const c = opcoes(x, { lig, producao, coordenacao: coordenacaoFalsa(cfg), trabalho: { conjuntoId: 'conjunto-cmp5', nomeContainer: 'c' } });
      const r = await Cmp.criarCompositor(c.o).compor(pedido(x, 'BACKUP', 'ENSAIO')).executar();
      assert.deepEqual({ estado: r.estado, codigo: r.evidencia.codigo, producao: producao.chamadas.length, s3: x.a.s3.chamadas.length, linhas: c.linhas.length, aud: recebidas.length, gravado: r.auditoria.gravado }, { estado, codigo: cod, producao: 0, s3: 0, linhas: 1, aud: 1, gravado: true }, JSON.stringify(cfg));
    }
  });

  test('CMP-06 — produção que falha vira FALHOU/PRODUCAO_FALHOU; recibos que não podem ser registrados viram FALHOU/RECIBOS_NAO_REGISTRADOS (o consolidado existe, mas a execução não é sucesso)', async () => {
    const x1 = await prepararAmbiente({ conjuntoId: 'conjunto-cmp6a' });
    const l1 = ligacaoDeTeste('BACKUP', 'ENSAIO', x1);
    const r1 = await Cmp.criarCompositor(opcoes(x1, { lig: l1.lig, producao: producaoComLeitorReal(x1, { ok: false }), trabalho: { conjuntoId: 'conjunto-cmp6a', nomeContainer: 'c' } }).o).compor(pedido(x1, 'BACKUP', 'ENSAIO')).executar();
    assert.deepEqual({ estado: r1.estado, codigo: r1.evidencia.codigo, falhouEm: r1.evidencia.falhouEm, s3: x1.a.s3.chamadas.length }, { estado: 'FALHOU', codigo: 'PRODUCAO_FALHOU', falhouEm: 'PRODUCAO', s3: 0 });
    const x2 = await prepararAmbiente({ conjuntoId: 'conjunto-cmp6b' });
    const l2 = ligacaoDeTeste('BACKUP', 'ENSAIO', x2);
    const c2 = opcoes(x2, { lig: l2.lig, producao: producaoComLeitorReal(x2), recibos: { registrar: async () => { throw new Error('CUSTODIA-INDISPONIVEL'); } }, trabalho: { conjuntoId: 'conjunto-cmp6b', nomeContainer: 'c' } });
    const r2 = await Cmp.criarCompositor(c2.o).compor(pedido(x2, 'BACKUP', 'ENSAIO')).executar();
    assert.deepEqual({ ok: r2.ok, estado: r2.estado, codigo: r2.evidencia.codigo, falhouEm: r2.evidencia.falhouEm, consolidado: r2.consolidado !== null, aud: l2.recebidas.length }, { ok: false, estado: 'FALHOU', codigo: 'RECIBOS_NAO_REGISTRADOS', falhouEm: 'REGISTRO_DOS_RECIBOS', consolidado: true, aud: 1 });
    assert.ok(!JSON.stringify(r2).includes('CUSTODIA'));
  });

  test('CMP-07 — a auditoria nunca altera o desfecho: finalizar que lança, que devolve gravado=false com código, ou que devolve lixo, só muda `auditoria`; a evidência, a linha e os recibos ficam iguais', async () => {
    const casos = [
      [async () => { throw new Error('SEGREDO-DA-AUDITORIA'); }, { gravado: false, codigo: 'AUDITORIA_FALHOU' }],
      [async () => ({ gravado: false, codigo: 'AUDITORIA_NAO_GRAVADA' }), { gravado: false, codigo: 'AUDITORIA_NAO_GRAVADA' }],
      [async () => ({ gravado: false, codigo: 'texto livre com segredo' }), { gravado: false, codigo: 'INDETERMINADO' }],
      [async () => 'lixo', { gravado: false, codigo: 'INDETERMINADO' }],
      [async () => ({ gravado: true, id: '77', extra: 'ignorado' }), { gravado: true }],
    ];
    for (const [finalizar, esperado] of casos) {
      const x = await prepararAmbiente({ conjuntoId: 'conjunto-cmp7' });
      const { lig } = ligacaoDeTeste('BACKUP', 'ENSAIO', x, finalizar);
      const c = opcoes(x, { lig, producao: producaoComLeitorReal(x), trabalho: { conjuntoId: 'conjunto-cmp7', nomeContainer: 'c' } });
      const r = await Cmp.criarCompositor(c.o).compor(pedido(x, 'BACKUP', 'ENSAIO')).executar();
      assert.deepEqual({ ok: r.ok, estado: r.estado, aud: r.auditoria, linhas: c.linhas.length, cons: c.consolidados.length }, { ok: true, estado: 'CONCLUIDO', aud: esperado, linhas: 1, cons: 1 });
      assert.ok(!JSON.stringify(r).includes('SEGREDO') && !JSON.stringify(r).includes('segredo'));
    }
  });
});

describe('[CMP] restauração e verificação do destino', () => {
  test('CMP-08 — RESTAURACAO a partir do consolidado do backup: coordenação RESTAURACAO, destino dedicado, o restaurador recebe o pacote decifrado sob o destino e um `lido` RECONHECIDO com o mesmo hash do manifesto publicado; DR RECUPERADO; auditoria', async () => {
    const { x, r: backup } = await cicloDeBackup('conjunto-cmp8');
    const { lig, recebidas } = ligacaoDeTeste('RESTAURACAO', 'ENSAIO', x);
    const relogio = relogioDe();
    const restaurador = restauradorFalso(relogio);
    const c = opcoes(x, { acao: 'RESTAURACAO', lig, restaurador, relogio, trabalho: { consolidado: backup.consolidado, nomeContainer: 'baixado-1', nomeDecifrado: 'restaurado-1', alvos: ALVOS, ultimoBackupEm: new Date(INICIO - 30 * 60000).toISOString() } });
    const cmp = Cmp.criarCompositor(c.o);
    assert.equal(cmp.acao, 'RESTAURACAO');
    const r = await cmp.compor(pedido(x, 'RESTAURACAO', 'ENSAIO')).executar();
    assert.equal(r.ok, true, JSON.stringify(r.diagnostico));
    assert.deepEqual(c.coordenacao.eventos, [['adquirir', 'RESTAURACAO'], ['liberar', 'RESTAURACAO']]);
    const e = r.evidencia;
    assert.deepEqual({ tipo: e.tipo, estado: e.estado, conjunto: e.conjuntoId, rec: e.recuperavelEmProducao, op: e.operacional, etapas: e.etapas.map((s) => s.id) },
      { tipo: 'EXECUCAO_RESTAURACAO', estado: 'CONCLUIDO', conjunto: 'conjunto-cmp8', rec: false, op: false, etapas: ['COORDENACAO', 'DESTINO_LOCAL', 'RESTAURAR_CONTAINER', 'VERIFICAR_PACOTE', 'RESTAURAR_FONTES', 'AVALIAR_DR'] });
    assert.equal(r.dr.classe, 'RECUPERADO');
    assert.equal(restaurador.chamadas.length, 1);
    assert.equal(restaurador.chamadas[0].pacote, path.join(x.dlRestauracao.raiz, 'restaurado-1'));
    assert.ok(ehResultadoDoLeitor(restaurador.chamadas[0].lido));
    assert.equal(restaurador.chamadas[0].lido.identidade.sha256Manifesto, backup.evidencia.sha256Manifesto);
    assert.deepEqual([c.linhas.length, recebidas.length, recebidas[0].linha === r.linha, r.auditoria.gravado, c.consolidados.length], [1, 1, true, true, 0]);
    // sem alvos: DR fica NAO_AVALIADO (pendência), nunca RECUPERADO
    const { lig: lig2 } = ligacaoDeTeste('RESTAURACAO', 'ENSAIO', x);
    const r2 = await Cmp.criarCompositor(opcoes(x, { acao: 'RESTAURACAO', lig: lig2, restaurador: restauradorFalso(relogioDe()), trabalho: { consolidado: backup.consolidado, nomeContainer: 'baixado-2', nomeDecifrado: 'restaurado-2' } }).o).compor(pedido(x, 'RESTAURACAO', 'ENSAIO')).executar();
    assert.equal(r2.ok, true, JSON.stringify(r2.diagnostico));
    assert.equal(r2.dr.classe, 'NAO_AVALIADO');
  });

  test('CMP-09 — VERIFICACAO_DESTINO: só o verificador, sem destino local, sem KMS, sem coordenação; CONFORME com o consolidado do backup; consolidado adulterado vira FALHOU/VERIFICACAO_DIVERGENTE', async () => {
    const { x, r: backup } = await cicloDeBackup('conjunto-cmp9');
    const { lig, recebidas } = ligacaoDeTeste('VERIFICACAO_DESTINO', 'ENSAIO', x);
    const c = opcoes(x, { acao: 'VERIFICACAO_DESTINO', lig, trabalho: { consolidado: backup.consolidado } });
    const r = await Cmp.criarCompositor(c.o).compor(pedido(x, 'VERIFICACAO_DESTINO', 'ENSAIO')).executar();
    assert.equal(r.ok, true, JSON.stringify(r.diagnostico));
    assert.deepEqual({ tipo: r.evidencia.tipo, ver: r.evidencia.verificacaoIndependente, coord: c.coordenacao.eventos, aud: recebidas.length, gravado: r.auditoria.gravado }, { tipo: 'EXECUCAO_VERIFICACAO_DESTINO', ver: 'CONFORME', coord: [], aud: 1, gravado: true });
    const adulterado = { ...backup.consolidado, recibos: backup.consolidado.recibos.map((rb, i) => (i === 0 ? { ...rb, sha256: '0'.repeat(64) } : rb)) };
    const { lig: lig2 } = ligacaoDeTeste('VERIFICACAO_DESTINO', 'ENSAIO', x);
    const d = await Cmp.criarCompositor(opcoes(x, { acao: 'VERIFICACAO_DESTINO', lig: lig2, trabalho: { consolidado: adulterado } }).o).compor(pedido(x, 'VERIFICACAO_DESTINO', 'ENSAIO')).executar();
    assert.deepEqual({ estado: d.estado, codigo: d.evidencia.codigo, ver: d.evidencia.verificacaoIndependente }, { estado: 'FALHOU', codigo: 'VERIFICACAO_DIVERGENTE', ver: 'DIVERGENTE' });
  });
});

describe('[CMP] ligação REAL e coordenação REAL (adaptadores)', () => {
  test('CMP-10 — a ligação REAL (Bloco A, SDK falso, credenciais por papel) é aceita pelo compositor e suas portas chegam ao executor; como o SDK falso não reconhece essa credencial, a execução FALHA FECHADA no pré-voo, sem lançar, com evidência e auditoria', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-cmp10' });
    const AGORA = INICIO;
    const forn = (papel) => ({ obter: async () => ({ papel, accessKeyId: `EXEMPLOIDCHAVE${papel.slice(0, 3)}01`, secretAccessKey: 'segredo-falso-0123456789' }) });
    const credenciais = C.criarConjuntoDeCredenciais({ acao: 'BACKUP', modo: 'ENSAIO', fornecedores: { PUBLICADOR: forn('PUBLICADOR'), VERIFICADOR: forn('VERIFICADOR') }, relogio: () => AGORA });
    const f = criarSdkFalso({ ficha: x.a.ficha, relogio: () => AGORA });
    const recebidas = [];
    const lig = L.criarLigacaoDoExecutor({ acao: 'BACKUP', modo: 'ENSAIO', sdk: f.sdk, regiao: x.a.ficha.regiao, credenciais, auditoria: { registrar: async (e) => { recebidas.push(e); return { gravado: true, id: '1' }; } } });
    const producao = producaoComLeitorReal(x);
    const c = opcoes(x, { lig, producao, trabalho: { conjuntoId: 'conjunto-cmp10', nomeContainer: 'c' } });
    const r = await Cmp.criarCompositor(c.o).compor(pedido(x, 'BACKUP', 'ENSAIO')).executar();
    // pré-voo reprovado = RECUSADO (nada foi enviado): o bucket falso continua vazio
    assert.deepEqual({ ok: r.ok, estado: r.estado, falhouEm: r.evidencia.falhouEm, producao: producao.chamadas.length, clientes: f.estado.clientes.length >= 2, chamadasAoSdk: f.estado.chamadas.length >= 1, objetos: f.objetos.size },
      { ok: false, estado: 'RECUSADO', falhouEm: 'PRE_VOO', producao: 1, clientes: true, chamadasAoSdk: true, objetos: 0 });
    assert.deepEqual([c.linhas.length, r.evidenciaRegistrada, recebidas.length, recebidas[0].linha === r.linha, r.auditoria], [1, true, 1, true, { gravado: true }]);
    assert.ok(!JSON.stringify(r).includes('segredo-falso'));
  });

  test('CMP-11 — criarCoordenacaoDoExecutor adapta os advisory locks do P10 à porta do executor: só SQL permitido, cadeados tomados e liberados, EM_USO/MIGRACAO_EM_CURSO, consulta que falha e operação fora da matriz viram recusa sem lançar', async () => {
    assert.equal(codigo(() => Cmp.criarCoordenacaoDoExecutor({})), 'COMPOSITOR_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => Cmp.criarCoordenacaoDoExecutor({ executorDeBanco: {} })), 'COMPOSITOR_CONFIGURACAO_INVALIDA');
    assert.equal(codigo(() => Cmp.criarCoordenacaoDoExecutor({ executorDeBanco: { query: async () => ({}) }, extra: 1 })), 'COMPOSITOR_CONFIGURACAO_INVALIDA');
    const bancoFalso = ({ tomado = () => true, lanca = false } = {}) => {
      const sqls = [];
      return { sqls, async query(sql) { sqls.push(sql); if (lanca) throw new Error('SEM-BANCO'); if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ tomado: tomado(sql) }] }; return { rows: [{ liberado: true }] }; } };
    };
    const ok = bancoFalso();
    const coord = Cmp.criarCoordenacaoDoExecutor({ executorDeBanco: ok });
    const t = await coord.adquirir({ operacao: 'BACKUP' });
    assert.deepEqual({ ok: t.ok, operacao: t.operacao, n: t.cadeados.length >= 2 }, { ok: true, operacao: 'BACKUP', n: true });
    assert.ok(ok.sqls.every((s) => /^SELECT pg_try_advisory_lock\(\d+\) AS tomado$/.test(s)));
    const lib = await t.liberar();
    assert.equal(lib.liberados, t.cadeados.length);
    assert.equal(ok.sqls.filter((s) => /pg_advisory_unlock/.test(s)).length, t.cadeados.length);
    const emUso = await Cmp.criarCoordenacaoDoExecutor({ executorDeBanco: bancoFalso({ tomado: () => false }) }).adquirir({ operacao: 'RESTAURACAO' });
    assert.equal(emUso.ok, false);
    assert.ok(['EM_USO', 'MIGRACAO_EM_CURSO'].includes(emUso.motivo), emUso.motivo);
    const caiu = await Cmp.criarCoordenacaoDoExecutor({ executorDeBanco: bancoFalso({ lanca: true }) }).adquirir({ operacao: 'BACKUP' });
    assert.deepEqual({ ...caiu }, { ok: false, motivo: 'CONSULTA_FALHOU', operacao: 'BACKUP' });
    const semConsulta = bancoFalso();
    for (const ruim of [undefined, {}, { operacao: 'LIMPEZA' }, { operacao: 'MIGRACAO' }, { operacao: 'BACKUP', extra: 1 }]) {
      assert.deepEqual({ ...(await Cmp.criarCoordenacaoDoExecutor({ executorDeBanco: semConsulta }).adquirir(ruim)) }, { ok: false, motivo: 'CONSULTA_FALHOU' }, JSON.stringify(ruim));
    }
    assert.deepEqual(semConsulta.sqls, []);
  });

  test('CMP-12 — invariantes: o compositor não usa fs, processo, ambiente, rede nem o SDK; é o ÚNICO chamador de criarExecutorOperacional fora do próprio módulo; o CLI não importa diretamente o compositor, o leitor de pacote nem a ligação operacional original (a ligação CLI é permitida); a trava da política continua falsa e única', () => {
    const BACKEND = path.join(__dirname, '..', '..');
    const semComentarios = (arquivo) => fs.readFileSync(path.join(BACKEND, arquivo), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const fonte = semComentarios('src/services/backup-executor-compositor.service.js');
    for (const padrao of [/\bfs\b/, /node:fs/, /child_process/, /\bspawn|\bexec(?:File)?\b/, /process\.(?:env|argv|umask|exit)/, /\bfetch\(/, /node:(?:http|https|net|dns)/, /@aws-sdk/, /OPERACAO_HABILITADA/, /\bwriteFile/, /\bmkdir/, /\bunlink/]) assert.doesNotMatch(fonte, padrao, String(padrao));
    const chamadores = [];
    const andar = (dir) => { for (const e of fs.readdirSync(path.join(BACKEND, dir), { withFileTypes: true })) { const rel = path.join(dir, e.name); if (e.isDirectory()) andar(rel); else if (e.name.endsWith('.js') && /criarExecutorOperacional\s*\(/.test(semComentarios(rel))) chamadores.push(rel); } };
    andar('src');
    andar('scripts');
    assert.deepEqual(chamadores.sort(), ['src/services/backup-executor-compositor.service.js', 'src/services/backup-executor-operacional.service.js']);
    const cli = semComentarios('scripts/backup-operar.js');
    assert.doesNotMatch(cli, /backup-executor-compositor|backup-executor-leitor-pacote|backup-executor-ligacao(?!-cli\.service(?:\.js)?['"])/);
    assert.match(cli, /LIGACAO_OPERACIONAL_AUSENTE/);
    assert.equal(Pol.OPERACAO_HABILITADA, false);
  });
});

describe('[CMP-B1] recusa por privilégios B-1 pendentes: wrapper + coordenação REAL (advisory locks) + compositor real', () => {
  const PAPEL_B1 = 'safework_backup_executor';
  /** Sessão falsa do papel: responde às consultas do verificador B-1 e aos advisory locks; guarda todo SQL recebido. */
  function sessaoDoPapel({ pendentes = [], lancaNasPendencias = false, tomado = true } = {}) {
    const sqls = [];
    return {
      sqls,
      async query(sql) {
        sqls.push(sql);
        switch (sql) {
          case B1.CONSULTAS.IDENTIDADE: return { rows: [{ usuario: PAPEL_B1, sessao: PAPEL_B1, banco: 'banco_sintetico' }] };
          case B1.CONSULTAS.PAPEL: return { rows: [{ limite: 5 }] };
          case B1.CONSULTAS.TOTAL: return { rows: [{ n: 75 }] };
          case B1.CONSULTAS.PENDENTES: if (lancaNasPendencias) throw new Error('BANCO-INDISPONIVEL'); return { rows: pendentes.map((nome) => ({ nome, tipo: 'r', total: pendentes.length })) };
          case B1.CONSULTAS.ESQUEMAS: return { rows: [] };
          case B1.CONSULTAS.ACESSO: return { rows: [{ usage_public: true, connect: true }] };
          default: return /pg_try_advisory_lock/.test(sql) ? { rows: [{ tomado }] } : { rows: [{ liberado: true }] };
        }
      },
    };
  }
  function coordenacaoB1(sessao) {
    const eventos = [];
    const auditoria = B1.criarRegistradorDeAuditoria({ executorDeAuditoria: { query: async () => ({ rows: [] }) }, registrarEventoSistema: async (_ex, dados) => { eventos.push(dados); return { id: eventos.length }; }, gerarId: () => 'b'.repeat(32) });
    const coordenacao = B1.criarPreVerificacaoDaCoordenacao({
      coordenacao: Cmp.criarCoordenacaoDoExecutor({ executorDeBanco: sessao }),
      verificador: B1.criarVerificadorDePrivilegios({ executorDeBanco: sessao, papel: PAPEL_B1 }),
      auditoria,
    });
    return { coordenacao, eventos };
  }
  const advisory = (sessao) => sessao.sqls.filter((s) => /advisory/.test(s));
  const arquivosDe = (raiz) => fs.readdirSync(raiz, { recursive: true }).sort((a, b) => a.localeCompare(b));
  async function backupComB1(conjuntoId, sessao, extra = {}) {
    const x = await prepararAmbiente({ conjuntoId });
    const { lig, recebidas } = ligacaoDeTeste('BACKUP', 'ENSAIO', x);
    const producao = producaoComLeitorReal(x);
    const b1 = coordenacaoB1(sessao);
    const antes = arquivosDe(x.raiz);
    const c = opcoes(x, { lig, producao, coordenacao: b1.coordenacao, trabalho: { conjuntoId, nomeContainer: 'container-1' }, ...extra });
    const r = await Cmp.criarCompositor(c.o).compor(pedido(x, 'BACKUP', 'ENSAIO')).executar();
    return { x, recebidas, producao, b1, c, r, antes, depois: arquivosDe(x.raiz) };
  }

  test('CMP-13 — privilégios B-1 pendentes: RECUSADO/PRIVILEGIOS_B1_PENDENTES na etapa COORDENACAO, ANTES de qualquer trava advisory; produção zero (logo pg_dump zero), nenhum pacote novo, S3 zero; recusa distinta de indisponibilidade; evidência válida e auditoria dos dois lados', async () => {
    const sessao = sessaoDoPapel({ pendentes: ['tabela_nova'] });
    const { x, recebidas, producao, b1, c, r, antes, depois } = await backupComB1('conjunto-cmp13', sessao);
    assert.deepEqual({ estado: r.estado, codigo: r.evidencia.codigo, falhouEm: r.evidencia.falhouEm }, { estado: 'RECUSADO', codigo: 'PRIVILEGIOS_B1_PENDENTES', falhouEm: 'COORDENACAO' });
    assert.notEqual(r.evidencia.codigo, 'COORDENACAO_INDISPONIVEL');
    assert.deepEqual(advisory(sessao), [], 'nenhuma trava advisory foi tomada (nem liberada)');
    assert.ok(sessao.sqls.every((s) => /^SELECT\b/.test(s)), 'a sessão só recebeu leituras');
    assert.equal(producao.chamadas.length, 0, 'produção zero: pg_dump só é lançado pela produção');
    assert.deepEqual(depois, antes, 'nenhum arquivo novo (nenhum pacote) onde a produção publicaria');
    assert.equal(x.a.s3.chamadas.length, 0);
    assert.deepEqual(r.evidencia.etapas.map((e) => [e.id, e.ok, e.codigo]), [['COORDENACAO', false, 'PRIVILEGIOS_B1_PENDENTES']]);
    assert.deepEqual(lida(r.linha), r.evidencia);
    assert.doesNotMatch(r.linha, /tabela_nova|safework_backup_executor/, 'a evidência não leva nomes de objetos nem de papel');
    // auditoria: um evento do executor (RECUSADO) e um do wrapper (detalhe), ambos gravados
    assert.deepEqual([c.linhas.length, recebidas.length, r.auditoria.gravado], [1, 1, true]);
    assert.equal(b1.eventos.length, 1);
    assert.equal(b1.eventos[0].acao, B1.ACOES.VERIFICACAO_BLOQUEADA);
    assert.deepEqual(b1.eventos[0].contexto.pendentes, ['tabela_nova']);
  });

  test('CMP-14 — verificação B-1 que não pôde ser feita (consulta falha): FALHOU/PRIVILEGIOS_B1_NAO_VERIFICADOS, também antes de qualquer trava, sem produção', async () => {
    const sessao = sessaoDoPapel({ lancaNasPendencias: true });
    const { producao, b1, r, antes, depois } = await backupComB1('conjunto-cmp14', sessao);
    assert.deepEqual({ estado: r.estado, codigo: r.evidencia.codigo, falhouEm: r.evidencia.falhouEm }, { estado: 'FALHOU', codigo: 'PRIVILEGIOS_B1_NAO_VERIFICADOS', falhouEm: 'COORDENACAO' });
    assert.deepEqual(advisory(sessao), []);
    assert.equal(producao.chamadas.length, 0);
    assert.deepEqual(depois, antes);
    assert.equal(b1.eventos[0].acao, B1.ACOES.VERIFICACAO_BLOQUEADA);
    assert.deepEqual(b1.eventos[0].contexto.motivos, ['VERIFICACAO_FALHOU']);
  });

  test('CMP-15 — POSITIVO: sem pendência o ciclo completo segue como hoje; a verificação precede a primeira trava e a trava é liberada', async () => {
    const sessao = sessaoDoPapel({ pendentes: [] });
    const { producao, b1, r } = await backupComB1('conjunto-cmp15', sessao);
    assert.equal(r.ok, true, JSON.stringify(r.diagnostico));
    assert.equal(r.evidencia.estado, 'CONCLUIDO');
    assert.equal(producao.chamadas.length, 1);
    const primeiraTrava = sessao.sqls.findIndex((s) => /pg_try_advisory_lock/.test(s));
    assert.ok(primeiraTrava > sessao.sqls.lastIndexOf(B1.CONSULTAS.ACESSO), 'toda a verificação vem antes da primeira trava');
    assert.ok(sessao.sqls.some((s) => /pg_advisory_unlock/.test(s)), 'a trava foi liberada');
    assert.equal(b1.eventos[0].acao, B1.ACOES.VERIFICACAO_OK);
  });

  test('CMP-16 — EM_USO e MIGRACAO_EM_CURSO continuam RECUSADO com os códigos de sempre quando a coordenação real os devolve por baixo do wrapper (a verificação B-1 passou)', async () => {
    const sessao = sessaoDoPapel({ pendentes: [], tomado: false });
    const { producao, r } = await backupComB1('conjunto-cmp16', sessao);
    assert.equal(r.estado, 'RECUSADO');
    assert.ok(['COORDENACAO_EM_USO', 'MIGRACAO_EM_CURSO'].includes(r.evidencia.codigo), r.evidencia.codigo);
    assert.equal(producao.chamadas.length, 0);
    assert.ok(sessao.sqls.includes(B1.CONSULTAS.PENDENTES), 'a verificação B-1 rodou antes');
  });

  test('CMP-17 — RESTAURACAO fica intacta: o wrapper não verifica (nenhuma consulta de privilégio), a trava de restauração é tomada e o restaurador roda mesmo com objeto sem concessão', async () => {
    const { x, r: backup } = await cicloDeBackup('conjunto-cmp17');
    const { lig } = ligacaoDeTeste('RESTAURACAO', 'ENSAIO', x);
    const sessao = sessaoDoPapel({ pendentes: ['tabela_nova'] });
    const b1 = coordenacaoB1(sessao);
    const relogio = relogioDe();
    const restaurador = restauradorFalso(relogio);
    const c = opcoes(x, { acao: 'RESTAURACAO', lig, restaurador, relogio, coordenacao: b1.coordenacao, trabalho: { consolidado: backup.consolidado, nomeContainer: 'baixado-b1', nomeDecifrado: 'restaurado-b1', alvos: ALVOS, ultimoBackupEm: new Date(INICIO - 30 * 60000).toISOString() } });
    const r = await Cmp.criarCompositor(c.o).compor(pedido(x, 'RESTAURACAO', 'ENSAIO')).executar();
    assert.equal(r.ok, true, JSON.stringify(r.diagnostico));
    assert.equal(r.evidencia.estado, 'CONCLUIDO');
    assert.equal(restaurador.chamadas.length, 1);
    assert.ok(advisory(sessao).length >= 2, 'a trava de RESTAURACAO foi tomada e liberada');
    assert.ok(!sessao.sqls.some((s) => Object.values(B1.CONSULTAS).includes(s)), 'nenhuma consulta do verificador B-1 na restauração');
    assert.equal(b1.eventos.length, 0);
  });
});
