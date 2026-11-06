'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const Pub = require('../../src/services/backup-executor-publicacao.service');
const R = require('../../src/services/backup-executor-recuperacao.service');
const { prepararAmbiente, chavesOffline } = require('../helpers/ambiente-executor');
const { limparRaizes, arvore } = require('../helpers/pacote-l2-sintetico');

/**
 * D-ORF-6, executor operacional [REC]: ESTÁGIO DE RECUPERAÇÃO — consolidado de recibos -> destino local AUTORIZADO (novo) -> baixar por versão e decifrar (orquestrador existente,
 * B1) -> verificar o pacote L2 -> restaurar as fontes (porta do restaurador do banco e das fontes, com a conciliação P7) -> avaliar o ensaio de DR. Com os módulos REAIS sobre S3 e
 * chaves falsos e dados sintéticos. Produção continua proibida (destino sempre novo) e o resultado nunca promove `recuperavelEmProducao`.
 */

after(limparRaizes);
const iso = (ms) => new Date(ms).toISOString();
const INICIO = Date.UTC(2026, 10, 5, 12, 0, 0);
const relogioDe = (passo = 100) => { let t = INICIO - passo; return () => { t += passo; return t; }; };
const ETAPAS_OK = ['DESTINO_LOCAL', 'RESTAURAR_CONTAINER', 'VERIFICAR_PACOTE', 'RESTAURAR_FONTES', 'AVALIAR_DR'];
const ALVOS = { rpoMs: 3600000, rtoMs: 600000 };
const ULTIMO_BACKUP = iso(INICIO - 30 * 60000);

/** Restaurador falso: cinco passos medidos pelo MESMO relógio (começam depois dos passos do estágio). */
function restauradorFalso(relogio, { passoQueFalha = null, classe = 'INTEGRO', ok = true, lanca = false } = {}) {
  const chamadas = [];
  return {
    chamadas,
    async restaurar(pedido) {
      chamadas.push({ pacote: pedido.pacote, lido: pedido.lido });
      if (lanca) throw new Error('SEGREDO-DO-RESTAURADOR');
      const passos = [];
      for (const id of ['BANCO', 'ESQUEMA', 'ARQUIVOS_POR_FONTE', 'CONCILIACAO', 'VEREDITO']) {
        if (passos.some((p) => !p.ok)) break;
        const inicioEm = iso(relogio());
        passos.push({ id, ok: id !== passoQueFalha, inicioEm, fimEm: iso(relogio()) });
      }
      return { ok, passos, restauracao: { ok: true, veredito: { classe }, recuperavelEmProducao: false } };
    },
  };
}

async function publicado(conjuntoId) {
  const x = await prepararAmbiente({ conjuntoId });
  const pub = await Pub.publicarPacoteDuravel({
    pacote: { dir: x.pacote.dir, lido: x.pacote.lido }, conjuntoId, validadorDeDestinos: x.dlContainers.validador, destinoLocalId: x.dlContainers.id, raiz: x.dlContainers.raiz,
    nomeContainer: 'container-1', cifra: x.chaves.cifra, mac: x.chaves.mac, enviador: x.a.enviador(), limites: { arquivosMaximo: 1000, totalBytesMaximo: 2 ** 30 }, prazoMs: 1000,
  });
  assert.equal(pub.ok, true, JSON.stringify(pub.falha));
  return { x, pub };
}
const entrada = ({ x, pub }, relogio, restaurador, extra = {}) => ({
  baixador: x.a.baixador(x.dlRestauracao), validadorDeDestinos: x.dlRestauracao.validador, consolidado: pub.consolidado, destinoLocalId: x.dlRestauracao.id, raiz: x.dlRestauracao.raiz,
  nomeContainer: 'baixado-1', nomeDecifrado: 'restaurado-1', cifra: chavesOffline().chaves.cifra, mac: chavesOffline().chaves.mac, restaurador, relogio, alvos: ALVOS, ultimoBackupEm: ULTIMO_BACKUP, ...extra,
});
const codigo = async (promessa) => { try { await promessa; } catch (e) { return e.code; } return null; };

describe('[REC] caminho completo', () => {
  test('REC-01 — restauração completa com as chaves OFF-LINE: etapas na ordem, pacote reconstruído idêntico ao original, restaurador chamado com o pacote e o manifesto lido, ensaio de DR RECUPERADO, nunca recuperável em produção', async () => {
    const c = await publicado('conjunto-rec1');
    const relogio = relogioDe();
    const restaurador = restauradorFalso(relogio);
    const marcas = [];
    const r = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restaurador, { marcar: (id, ok, cod) => marcas.push([id, ok, cod]) }));
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    assert.deepEqual(r.etapas.map((e) => e.id), ETAPAS_OK);
    assert.deepEqual(marcas, ETAPAS_OK.map((id) => [id, true, null]));
    const destino = path.join(c.x.dlRestauracao.raiz, 'restaurado-1');
    assert.deepEqual(arvore(destino), arvore(c.x.pacote.dir));
    for (const f of arvore(c.x.pacote.dir)) assert.ok(fs.readFileSync(path.join(destino, f)).equals(fs.readFileSync(path.join(c.x.pacote.dir, f))), f);
    assert.equal(restaurador.chamadas.length, 1);
    assert.equal(restaurador.chamadas[0].pacote, destino);
    assert.equal(typeof restaurador.chamadas[0].lido.identidade.sha256Manifesto, 'string');
    assert.deepEqual({ classe: r.dr.classe, rpo: r.dr.rpoAtendido, rto: r.dr.rtoAtendido }, { classe: 'RECUPERADO', rpo: true, rto: true });
    assert.equal(r.restauracao.arquivosBaixados, c.pub.container.arquivos);
    assert.deepEqual({ estado: r.estado, falha: r.falha, recuperavelEmProducao: r.recuperavelEmProducao }, { estado: 'CONCLUIDO', falha: null, recuperavelEmProducao: false });
    assert.deepEqual(fs.readdirSync(c.x.dlRestauracao.raiz).sort(), ['baixado-1', 'restaurado-1']);
    assert.ok(Object.isFrozen(r));
  });

  test('REC-02 — sem alvos de RPO/RTO (decisão pendente) a restauração conclui, mas o ensaio de DR fica NAO_AVALIADO e a pendência é registrada; o RPO medido não é inventado', async () => {
    const c = await publicado('conjunto-rec2');
    const relogio = relogioDe();
    const r = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restauradorFalso(relogio), { alvos: undefined, ultimoBackupEm: undefined, nomeContainer: 'baixado-2', nomeDecifrado: 'restaurado-2' }));
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    assert.deepEqual({ classe: r.dr.classe, rpo: r.dr.rpoAtendido, rto: r.dr.rtoAtendido }, { classe: 'NAO_AVALIADO', rpo: null, rto: null });
    assert.ok(r.comprovacoesPendentes.includes('RPO_E_RTO_NAO_FIXADOS'));
  });
});

describe('[REC] classes do ensaio de DR', () => {
  test('REC-03 — fora do alvo, parcial ou falho: a execução é FALHOU com o código da classe; RECUPERADO_FORA_DO_ALVO (RPO ou RTO) e PARCIAL (conciliação falha, veredito não íntegro) nunca contam como recuperado', async () => {
    const quadros = [
      ['DR_FORA_DO_ALVO', { ultimoBackupEm: iso(INICIO - 2 * 3600000) }, {}],
      ['DR_FORA_DO_ALVO', { alvos: { rpoMs: 3600000, rtoMs: 1 } }, {}],
      ['DR_PARCIAL', {}, { passoQueFalha: 'CONCILIACAO' }],
      ['DR_PARCIAL', {}, { classe: 'INCONSISTENTE' }],
    ];
    let n = 0;
    for (const [esperado, extra, falso] of quadros) {
      n += 1;
      const c = await publicado(`conjunto-rec3-${n}`);
      const relogio = relogioDe();
      const r = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restauradorFalso(relogio, falso), extra));
      assert.deepEqual({ ok: r.ok, estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { ok: false, estado: 'FALHOU', etapa: 'AVALIAR_DR', codigo: esperado }, esperado);
      assert.equal(r.dr.classe === 'RECUPERADO', false);
      assert.equal(r.recuperavelEmProducao, false);
    }
  });
});

describe('[REC] recusas e falhas fechadas', () => {
  test('REC-04 — destino local fora do registro oficial: RECUSADO antes de baixar; nada é criado e o S3 não é lido', async () => {
    const c = await publicado('conjunto-rec4');
    const relogio = relogioDe();
    const antes = c.x.a.s3.chamadas.length;
    for (const extra of [{ destinoLocalId: 'outro' }, { raiz: c.x.dlContainers.raiz }, { raiz: `${c.x.dlRestauracao.raiz}/filho` }]) {
      const r = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restauradorFalso(relogio), extra));
      assert.deepEqual({ estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { estado: 'RECUSADO', etapa: 'DESTINO_LOCAL', codigo: 'DESTINO_LOCAL_NAO_AUTORIZADO' });
    }
    assert.deepEqual(fs.readdirSync(c.x.dlRestauracao.raiz), []);
    assert.equal(c.x.a.s3.chamadas.length, antes);
  });

  test('REC-05 — objeto adulterado no destino durável: o baixador recusa por integridade (FALHOU em RESTAURAR_CONTAINER, com o código do componente) e o restaurador do banco NÃO é chamado', async () => {
    const c = await publicado('conjunto-rec5');
    const alvo = c.pub.consolidado.recibos.find((rb) => rb.chave.includes('/dados/'));
    c.x.a.s3.corromper(alvo.chave, alvo.versaoId, Buffer.from('conteudo adulterado no bucket'));
    const relogio = relogioDe();
    const restaurador = restauradorFalso(relogio);
    const r = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restaurador));
    assert.deepEqual({ ok: r.ok, estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { ok: false, estado: 'FALHOU', etapa: 'RESTAURAR_CONTAINER', codigo: 'RESTAURAR_CONTAINER_FALHOU' });
    assert.deepEqual(r.falha.componente, { passo: r.falha.componente.passo, codigo: 'INTEGRIDADE_DIVERGENTE' });
    assert.equal(restaurador.chamadas.length, 0);
    assert.deepEqual(r.etapas.map((e) => [e.id, e.ok]), [['DESTINO_LOCAL', true], ['RESTAURAR_CONTAINER', false]]);
  });

  test('REC-06 — KEK errada: a decifra recusa (FALHOU) e o restaurador não é chamado; limite de bytes do baixador excedido: RECUSADO sem baixar nada', async () => {
    const c = await publicado('conjunto-rec6');
    const relogio = relogioDe();
    const restaurador = restauradorFalso(relogio);
    const kekErrada = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-hml-v1', segredo: crypto.randomBytes(32) }] });
    const r = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restaurador, { cifra: { fonte: kekErrada, chaveId: 'kek-hml-v1' }, nomeContainer: 'baixado-6', nomeDecifrado: 'restaurado-6' }));
    assert.deepEqual({ ok: r.ok, estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo }, { ok: false, estado: 'FALHOU', etapa: 'RESTAURAR_CONTAINER', codigo: 'RESTAURAR_CONTAINER_FALHOU' });
    assert.equal(typeof r.falha.componente.passo, 'string');
    assert.equal(restaurador.chamadas.length, 0);
    const sem = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restaurador, { baixador: c.x.a.baixador(c.x.dlRestauracao, { limites: { totalBytesMaximo: 10 } }), nomeContainer: 'baixado-6b', nomeDecifrado: 'restaurado-6b' }));
    assert.deepEqual({ estado: sem.estado, etapa: sem.falha.etapa, codigo: sem.falha.codigo, componente: sem.falha.componente.codigo }, { estado: 'RECUSADO', etapa: 'RESTAURAR_CONTAINER', codigo: 'RESTAURAR_CONTAINER_RECUSADO', componente: 'LIMITE_TOTAL_EXCEDIDO' });
    assert.equal(fs.existsSync(path.join(c.x.dlRestauracao.raiz, 'baixado-6b')), false);
  });

  test('REC-07 — pacote que não passa na verificação L2 depois de decifrado (função de verificação injetada só em teste): FALHOU em VERIFICAR_PACOTE com o motivo fixo, restaurador não chamado', async () => {
    const c = await publicado('conjunto-rec7');
    const relogio = relogioDe();
    const restaurador = restauradorFalso(relogio);
    const r = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restaurador, { verificarPacote: async () => ({ ok: false, motivo: 'ARQUIVO_EXTRA' }) }));
    assert.deepEqual({ estado: r.estado, etapa: r.falha.etapa, codigo: r.falha.codigo, detalhe: r.falha.detalhe }, { estado: 'FALHOU', etapa: 'VERIFICAR_PACOTE', codigo: 'PACOTE_NAO_VERIFICADO', detalhe: 'ARQUIVO_EXTRA' });
    assert.equal(restaurador.chamadas.length, 0);
  });

  test('REC-08 — o restaurador das fontes falha ou lança: FALHOU em RESTAURAR_FONTES (código fixo, sem eco da mensagem); o pacote já decifrado permanece para análise (nada apagado)', async () => {
    const c = await publicado('conjunto-rec8');
    const relogio = relogioDe();
    const falhou = await R.restaurarDoDestinoDuravel(entrada(c, relogio, restauradorFalso(relogio, { ok: false, passoQueFalha: 'BANCO' })));
    assert.deepEqual({ estado: falhou.estado, etapa: falhou.falha.etapa, codigo: falhou.falha.codigo }, { estado: 'FALHOU', etapa: 'RESTAURAR_FONTES', codigo: 'RESTAURACAO_DE_FONTES_FALHOU' });
    const d = await publicado('conjunto-rec8b');
    const relogio2 = relogioDe();
    const lancou = await R.restaurarDoDestinoDuravel(entrada(d, relogio2, restauradorFalso(relogio2, { lanca: true })));
    assert.deepEqual({ estado: lancou.estado, etapa: lancou.falha.etapa, codigo: lancou.falha.codigo }, { estado: 'FALHOU', etapa: 'RESTAURAR_FONTES', codigo: 'ERRO_INESPERADO' });
    assert.doesNotMatch(JSON.stringify(lancou), /SEGREDO/);
    assert.ok(fs.existsSync(path.join(d.x.dlRestauracao.raiz, 'restaurado-1', 'manifesto.json')));
  });

  test('REC-09 — entrada fora do contrato é erro de programação (ENTRADA_INVALIDA): alvos incompletos, último backup sem alvos, restaurador sem função, nomes iguais ou inválidos, chaves ausentes', async () => {
    const c = await publicado('conjunto-rec9');
    const relogio = relogioDe();
    const base = entrada(c, relogio, restauradorFalso(relogio));
    const ruins = [undefined, { ...base, extra: 1 }, { ...base, alvos: { rpoMs: 1 } }, { ...base, alvos: { rpoMs: 0, rtoMs: 1 } }, { ...base, ultimoBackupEm: 'ontem' }, { ...base, alvos: undefined }, { ...base, ultimoBackupEm: undefined },
      { ...base, restaurador: {} }, { ...base, nomeContainer: 'igual', nomeDecifrado: 'igual' }, { ...base, nomeContainer: '../x' }, { ...base, cifra: null }, { ...base, mac: undefined }, { ...base, relogio: 5 }, { ...base, baixador: {} },
      { ...base, verificarPacote: 'x', }];
    for (const ruim of ruins) assert.equal(await codigo(R.restaurarDoDestinoDuravel(ruim)), 'ENTRADA_INVALIDA', JSON.stringify(ruim)?.slice(0, 60));
    assert.deepEqual(fs.readdirSync(c.x.dlRestauracao.raiz), []);
  });
});
