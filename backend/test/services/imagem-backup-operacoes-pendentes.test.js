'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarRegistroDeOperacoes, ehRegistroDeOperacoes } = require('../../src/utils/registro-operacoes-pendentes');
const { criarSnapshot } = require('../../src/services/imagem-backup-snapshot.service');
const { executarBackup } = require('../../src/services/imagem-backup.service');
const { criarCopiaDeImagens } = require('../../src/services/imagem-backup-copia.service');
const { criarVerificadorDeImagensCopiadas } = require('../../src/services/imagem-backup-verificacao-imagens-copiadas.service');
const { criarEtapaDeCopiaVerificada } = require('../../src/services/imagem-backup-copia-verificada.service');
const { criarComposicaoDoConjunto } = require('../../src/services/imagem-backup-composicao.service');
const { criarSelagem, operacoesDoSistema } = require('../../src/services/imagem-backup-selagem.service');
const { construirManifesto } = require('../../src/services/imagem-backup-manifesto.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { criarBackupDeProducao } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');
const { ambiente, clienteFalso, DUMP_BYTES } = require('../helpers/ambiente-backup-operacao');

/**
 * P2 (prazo de abertura do snapshot) e P3 (cancelamento seguro) com o REGISTRO DE OPERAÇÕES PENDENTES. Só relógio manual, fixtures descartáveis e dependências falsas: nenhum PostgreSQL, nenhum processo real.
 * O que se mede são EFEITOS (consultas enviadas, `end()` chamado, arquivos no disco, trava, quem foi chamado), não só mensagens. Os números de prazo aqui são VALORES DE TESTE; nenhum prazo operacional existe nem foi inventado.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-ropt-test-' });
after(() => { fix.remover(); });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const H = (c) => c.repeat(64);

const adiado = () => { let resolver; let rejeitar; const promessa = new Promise((r, j) => { resolver = r; rejeitar = j; }); return { promessa, resolver, rejeitar }; };
const andar = async (vezes = 10) => { for (let i = 0; i < vezes; i += 1) await new Promise((r) => setImmediate(r)); };
/** Espera uma condição por TEMPO (a E/S real de disco pode demorar sob carga); o teto só evita travar o teste e nunca é o que se mede. */
const ate = async (condicao, rotulo = 'condição') => { const limite = Date.now() + 10000; while (Date.now() < limite) { if (condicao()) return; await new Promise((r) => setTimeout(r, 2)); } assert.fail(`não ocorreu: ${rotulo}`); };
/** true se a promessa AINDA não assentou depois de algumas voltas do laço de eventos. */
async function aindaPendente(promessa) {
  let assentou = false;
  promessa.then(() => { assentou = true; }, () => { assentou = true; });
  await andar(15);
  return !assentou;
}

/** Relógio manual: `prazo(ms)` só assenta quando o teste dispara aquele valor; `cancelar` retira o prazo (como clearTimeout). */
function relogioManual() {
  const ativos = new Set();
  return {
    prazo(ms) {
      const p = { ms };
      p.promessa = new Promise((r) => { p.resolver = r; });
      ativos.add(p);
      return { promessa: p.promessa, cancelar() { ativos.delete(p); } };
    },
    intervalo: () => Promise.resolve(),
    disparar(ms) { for (const p of [...ativos]) if (p.ms === ms) { ativos.delete(p); p.resolver(); } },
    ativos: () => [...ativos].map((p) => p.ms),
    registrado: (ms) => [...ativos].some((p) => p.ms === ms),
  };
}

/** Falha o teste se alguma rejeição ficar sem tratamento enquanto `fn` roda (inclui as tardias). */
async function semRejeicaoNaoObservada(fn) {
  const vistas = [];
  const ouvinte = (motivo) => { vistas.push(motivo); };
  process.on('unhandledRejection', ouvinte);
  try { await fn(); await andar(20); } finally { process.off('unhandledRejection', ouvinte); }
  assert.deepEqual(vistas, [], 'nenhuma rejeição pode ficar sem observador');
}

// ------------------------------------------------------------------------------------------------------------------------------- A. registro
describe('[ROP] registro de operações pendentes: só o assentamento da própria promessa encerra uma operação', () => {
  const novo = (opcoes) => { const relogio = relogioManual(); return { relogio, registro: criarRegistroDeOperacoes({ temporizador: relogio, ...opcoes }) }; };

  teste('ROP-01 — o início é real e síncrono: `executar` roda na hora com um sinal próprio; a operação nasce EM_EXECUCAO e consta como pendente; só objetos da fábrica são registros', () => {
    const { registro } = novo();
    let chamadas = 0;
    let sinal = null;
    const d = adiado();
    const r = registro.rastrear({ etapa: 'copia', recursos: ['ARMAZENAMENTO'] }, (s) => { chamadas += 1; sinal = s; return d.promessa; });
    assert.equal(chamadas, 1);
    assert.equal(sinal.aborted, false);
    assert.deepEqual(registro.pendentes().map((p) => [p.etapa, p.estado]), [['copia', 'EM_EXECUCAO']]);
    assert.equal(ehRegistroDeOperacoes(registro), true);
    for (const falso of [{ ...registro }, Object.create(registro), {}, null]) assert.equal(ehRegistroDeOperacoes(falso), false);
    assert.equal(typeof r.id, 'string');
  });

  teste('ROP-02 — identidade não reutilizável: a mesma etapa não é registrada duas vezes no mesmo registro; especificações inválidas são recusadas sem iniciar nada', () => {
    const { registro } = novo();
    let chamadas = 0;
    const executar = () => { chamadas += 1; return Promise.resolve(); };
    registro.rastrear({ etapa: 'dump', recursos: ['PROCESSO'] }, executar);
    assert.throws(() => registro.rastrear({ etapa: 'dump', recursos: ['PROCESSO'] }, executar), TypeError);
    for (const ruim of [null, {}, { etapa: 'inexistente', recursos: [] }, { etapa: 'copia', recursos: ['SEGREDO'] }, { etapa: 'copia', recursos: ['ARMAZENAMENTO', 'ARMAZENAMENTO'] }, { etapa: 'copia', recursos: [], extra: 1 }, { etapa: 'copia', recursos: [], aoCancelar: 1 }]) {
      assert.throws(() => registro.rastrear(ruim, executar), TypeError);
    }
    assert.throws(() => registro.rastrear({ etapa: 'copia', recursos: [] }, 'x'), TypeError);
    assert.equal(chamadas, 1, 'nenhuma recusa chegou a iniciar a operação');
    for (const ruim of [{ cortesiaMs: 5 }, { temporizador: {} }, { temporizador: relogioManual(), cortesiaMs: 0 }, { extra: 1 }, null]) assert.throws(() => criarRegistroDeOperacoes(ruim), TypeError);
  });

  teste('ROP-03 — cancelamento é só um PEDIDO: aborta o sinal, chama o contrato interno uma vez, marca CANCELAMENTO_SOLICITADO e a operação CONTINUA pendente; repetir o pedido não repete o efeito', () => {
    const { registro } = novo();
    let interno = 0;
    let sinal = null;
    const d = adiado();
    const r = registro.rastrear({ etapa: 'copia', recursos: ['ARMAZENAMENTO'], aoCancelar: () => { interno += 1; } }, (s) => { sinal = s; return d.promessa; });
    assert.equal(registro.solicitarCancelamento('PARADA'), 1);
    assert.equal(registro.solicitarCancelamento('PARADA'), 0);
    assert.equal(sinal.aborted, true);
    assert.equal(interno, 1);
    assert.deepEqual(registro.pendentes().map((p) => p.estado), ['CANCELAMENTO_SOLICITADO']);
    assert.throws(() => registro.solicitarCancelamento('QUALQUER'), TypeError);
    d.resolver();
    return r.assentada.then((a) => assert.equal(a.desfecho, 'RESOLVIDA'));
  });

  teste('ROP-04 — o assentamento (e só ele) tira a operação da lista: resolvida ou rejeitada; a rejeição é observada (nenhuma rejeição sem tratamento)', async () => {
    await semRejeicaoNaoObservada(async () => {
      const { registro } = novo();
      const a = adiado();
      const b = adiado();
      const ra = registro.rastrear({ etapa: 'snapshot', recursos: ['SNAPSHOT'] }, () => a.promessa);
      const rb = registro.rastrear({ etapa: 'copia', recursos: ['ARMAZENAMENTO'] }, () => b.promessa);
      assert.equal(registro.pendentes().length, 2);
      a.resolver({ ok: true });
      b.rejeitar(new Error('SEGREDO-NUNCA-EXPOR'));
      const [x, y] = await Promise.all([ra.assentada, rb.assentada]);
      assert.deepEqual([x.desfecho, y.desfecho], ['RESOLVIDA', 'REJEITADA']);
      assert.equal(JSON.stringify(registro.resumo()).includes('SEGREDO'), false);
      assert.equal(registro.pendentes().length, 0);
    });
  });

  teste('ROP-05 — `executar` que LANÇA de forma síncrona vira operação rejeitada e observada (nada fica pendente nem sem tratamento)', async () => {
    await semRejeicaoNaoObservada(async () => {
      const { registro } = novo();
      const r = registro.rastrear({ etapa: 'copia', recursos: [] }, () => { throw new Error('x'); });
      assert.equal((await r.assentada).desfecho, 'REJEITADA');
      assert.equal(registro.pendentes().length, 0);
    });
  });

  teste('ROP-06 — prazo da etapa vencido SÓ pede cancelamento: o sinal aborta, mas `aguardar` não resolve enquanto a promessa não assentar; quando assenta, informa `expirou`', async () => {
    const { registro, relogio } = novo();
    const d = adiado();
    let sinal;
    const r = registro.rastrear({ etapa: 'copia', recursos: ['ARMAZENAMENTO'] }, (s) => { sinal = s; return d.promessa; });
    const espera = registro.aguardar(r.id, { limiteMs: 700 });
    assert.equal(relogio.registrado(700), true);
    relogio.disparar(700);
    await andar();
    assert.equal(sinal.aborted, true, 'o vencimento pediu o cancelamento');
    assert.equal(await aindaPendente(espera), true, 'prazo vencido NÃO é término');
    assert.deepEqual(registro.pendentes().map((p) => p.estado), ['CANCELAMENTO_SOLICITADO']);
    d.resolver({ ok: false });
    const fim = await espera;
    assert.deepEqual([fim.estado, fim.expirou, fim.desfecho], ['ASSENTADA', true, 'RESOLVIDA']);
  });

  teste('ROP-07 — cortesia vencida sem assentar: CANCELAMENTO_NAO_CONFIRMADO; a operação CONTINUA na lista; o assentamento TARDIO atualiza o registro (tardia) e a rejeição tardia é observada', async () => {
    await semRejeicaoNaoObservada(async () => {
      const { registro, relogio } = novo({ cortesiaMs: 300 });
      const d = adiado();
      const r = registro.rastrear({ etapa: 'copia', recursos: ['ARMAZENAMENTO', 'ARQUIVO_PARCIAL'] }, () => d.promessa);
      const espera = registro.aguardar(r.id, { limiteMs: 700 });
      relogio.disparar(700);
      await ate(() => relogio.registrado(300), 'cortesia iniciada');
      relogio.disparar(300);
      const fim = await espera;
      assert.deepEqual([fim.estado, fim.expirou], ['CANCELAMENTO_NAO_CONFIRMADO', true]);
      assert.deepEqual(registro.pendentes().map((p) => [p.etapa, p.estado]), [['copia', 'CANCELAMENTO_NAO_CONFIRMADO']], 'segue pendente: nada foi encerrado');
      assert.deepEqual([...registro.pendentes()[0].recursos], ['ARMAZENAMENTO', 'ARQUIVO_PARCIAL']);
      d.rejeitar(new Error('x'));
      await r.assentada;
      assert.equal(registro.pendentes().length, 0);
      const item = registro.resumo().operacoes[0];
      assert.deepEqual([item.estado, item.desfecho, item.tardia, item.cancelamentoSolicitado, item.motivoDoCancelamento], ['ASSENTADA', 'REJEITADA', true, true, 'ETAPA_EXPIRADA']);
    });
  });

  teste('ROP-08 — sem cortesia configurada a espera depois do pedido NÃO é limitada (falha fechada); com assentamento dentro da cortesia o relógio da cortesia é retirado', async () => {
    const { registro, relogio } = novo();
    const d = adiado();
    const r = registro.rastrear({ etapa: 'copia', recursos: [] }, () => d.promessa);
    const espera = registro.aguardar(r.id);
    registro.solicitarCancelamento('PARADA');
    await andar();
    assert.deepEqual(relogio.ativos(), []);
    assert.equal(await aindaPendente(espera), true);
    d.resolver();
    assert.equal((await espera).estado, 'ASSENTADA');

    const c = novo({ cortesiaMs: 300 });
    const d2 = adiado();
    const r2 = c.registro.rastrear({ etapa: 'copia', recursos: [] }, () => d2.promessa);
    const espera2 = c.registro.aguardar(r2.id, { limiteMs: 700 });
    c.relogio.disparar(700);
    await ate(() => c.relogio.registrado(300));
    d2.resolver();
    const fim = await espera2;
    assert.equal(fim.estado, 'ASSENTADA');
    assert.deepEqual(c.relogio.ativos(), [], 'nenhum prazo sobra depois do assentamento');
    assert.equal(c.registro.resumo().operacoes[0].cancelamentoConfirmado, true);
  });

  teste('ROP-09 — operação iniciada DEPOIS de um pedido geral já nasce cancelada; `reivindicar` vale uma vez por chave fechada', () => {
    const { registro } = novo();
    registro.solicitarCancelamento('POSSE_PERDIDA');
    let sinal;
    registro.rastrear({ etapa: 'avaliacao', recursos: [] }, (s) => { sinal = s; return new Promise(() => {}); });
    assert.equal(sinal.aborted, true);
    assert.deepEqual(registro.pendentes().map((p) => p.estado), ['CANCELAMENTO_SOLICITADO']);
    assert.equal(registro.reivindicar('FINALIZACAO_SNAPSHOT'), true);
    assert.equal(registro.reivindicar('FINALIZACAO_SNAPSHOT'), false);
    assert.throws(() => registro.reivindicar('OUTRA'), TypeError);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- B. P2
describe('[P2] prazo de abertura do snapshot: vencimento informa e pede cancelamento; nada presume encerramento', () => {
  const ID = '00000003-0000001B-1';
  const tipoDe = (sql) => {
    const t = String(sql).replace(/\s+/g, ' ').trim();
    if (/^BEGIN\b/i.test(t)) return 'BEGIN';
    if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
    if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
    if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
    if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
    if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
    return `OUTRO:${t}`;
  };
  function clienteSnap({ conectar } = {}) {
    const c = {
      log: [],
      ouvintes: { error: [], end: [] },
      async connect() { c.log.push('connect'); return conectar ? conectar() : undefined; },
      async query(sql) {
        const tipo = tipoDe(sql);
        c.log.push(tipo);
        if (tipo === 'EXPORTAR') return { rows: [{ snapshot_id: ID }] };
        if (tipo === 'IDENTIDADE') return { rows: [{ nome: 'gestao_epi', oid: '16384' }] };
        return { rows: [] };
      },
      async end() { c.log.push('end'); },
      on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
    };
    return c;
  }
  const montar = ({ aberturaMs = 1000, conectar, comRegistro = true, criar } = {}) => {
    const relogio = relogioManual();
    const registro = criarRegistroDeOperacoes({ temporizador: relogio });
    const cliente = clienteSnap({ conectar });
    const snap = criarSnapshot({ criarConexao: criar ?? (() => cliente), temporizador: relogio, prazos: { finalizacaoMs: 5000, ...(aberturaMs === null ? {} : { aberturaMs }) }, ...(comRegistro ? { operacoes: registro } : {}) });
    return { relogio, registro, cliente, snap };
  };

  teste('P2-01 — abertura concluída ANTES do prazo: ok, o relógio da abertura é retirado, nada pendente e nenhuma expiração', async () => {
    const m = montar();
    const r = await m.snap.abrir();
    assert.equal(r.ok, true);
    assert.deepEqual(m.relogio.ativos(), []);
    assert.deepEqual([m.snap.situacao().fase, m.snap.situacao().aberturaPendente, m.snap.situacao().aberturaExpirada], ['ABERTO', false, false]);
    assert.equal(m.registro.pendentes().length, 0);
    assert.deepEqual(m.cliente.log.slice(0, 3), ['connect', 'BEGIN', 'EXPORTAR']);
  });

  teste('P2-02 — a abertura EXPIRA e continua pendente: abrir() informa ABERTURA_EXPIRADA, mas a operação segue pendente, nenhuma consulta é enviada e NADA presume conexão encerrada nem transação finalizada (`end()` não é chamado)', async () => {
    const conexao = adiado();
    const m = montar({ conectar: () => conexao.promessa });
    const aberta = m.snap.abrir();
    await ate(() => m.cliente.log.includes('connect'));
    m.relogio.disparar(1000);
    const r = await aberta;
    assert.deepEqual({ ...r }, { ok: false, motivo: 'ABERTURA_EXPIRADA' });
    const s = m.snap.situacao();
    assert.deepEqual([s.fase, s.aberturaPendente, s.aberturaExpirada], ['ABRINDO_EXPIRADA', true, true]);
    assert.deepEqual(m.cliente.log, ['connect'], 'nenhuma consulta, nenhum BEGIN, nenhum end()');
    assert.deepEqual(m.registro.pendentes().map((p) => [p.etapa, p.estado]), [['ABERTURA_SNAPSHOT', 'CANCELAMENTO_SOLICITADO']]);
    conexao.resolver();
    await andar();
  });

  teste('P2-03 — a abertura conclui TARDIAMENTE: não começa nada novo (nenhum BEGIN, nenhuma consulta), nunca publica ok, o registro assenta com cancelamento confirmado e a finalização encerra o cliente tardio sem ROLLBACK (a transação nunca começou)', async () => {
    const conexao = adiado();
    const m = montar({ conectar: () => conexao.promessa });
    const aberta = m.snap.abrir();
    await ate(() => m.cliente.log.includes('connect'));
    m.relogio.disparar(1000);
    await aberta;
    conexao.resolver();
    await ate(() => m.snap.situacao().aberturaPendente === false, 'abertura real assentou');
    assert.deepEqual(m.cliente.log, ['connect']);
    assert.equal(m.snap.situacao().fase, 'FALHOU');
    assert.equal(m.registro.pendentes().length, 0);
    const item = m.registro.resumo().operacoes[0];
    assert.deepEqual([item.estado, item.cancelamentoConfirmado, item.motivoDoCancelamento], ['ASSENTADA', true, 'ABERTURA_EXPIRADA']);
    assert.deepEqual({ ...(await m.snap.finalizar()) }, { concluida: true });
    assert.deepEqual(m.cliente.log, ['connect', 'end'], 'sem ROLLBACK: o BEGIN nunca foi enviado');
  });

  teste('P2-04 — o cliente chega TARDE (a fábrica ainda não devolveu nada quando o prazo vence): connect e BEGIN nunca acontecem; o cliente guardado só é encerrado pela finalização', async () => {
    const fabrica = adiado();
    const cliente = clienteSnap();
    const m = montar({ criar: () => fabrica.promessa, conectar: undefined });
    const aberta = m.snap.abrir();
    await andar();
    m.relogio.disparar(1000);
    assert.equal((await aberta).motivo, 'ABERTURA_EXPIRADA');
    fabrica.resolver(cliente);
    await ate(() => m.snap.situacao().aberturaPendente === false);
    assert.deepEqual(cliente.log, [], 'nenhuma operação no cliente tardio');
    assert.deepEqual({ ...(await m.snap.finalizar()) }, { concluida: true });
    assert.deepEqual(cliente.log, ['end']);
  });

  teste('P2-05 — finalizar com a abertura AINDA pendente respeita a pendência: se ela não assenta dentro do prazo de finalização, `concluida:false` e NADA é executado (nem end()); a operação continua rastreada', async () => {
    const conexao = adiado();
    const m = montar({ conectar: () => conexao.promessa });
    const aberta = m.snap.abrir();
    await ate(() => m.cliente.log.includes('connect'));
    m.relogio.disparar(1000);
    await aberta;
    const fim = m.snap.finalizar();
    await ate(() => m.relogio.registrado(5000), 'prazo de finalização');
    m.relogio.disparar(5000);
    assert.deepEqual({ ...(await fim) }, { concluida: false });
    assert.deepEqual(m.cliente.log, ['connect']);
    assert.equal(m.snap.situacao().aberturaPendente, true);
    assert.equal(m.registro.pendentes().length, 1);
    conexao.resolver();
    await andar();
  });

  teste('P2-06 — `aberturaMs` é opcional e estrito: ausente = comportamento histórico (nenhum prazo de abertura registrado); inválido ou registro que não é da fábrica = TypeError', async () => {
    const m = montar({ aberturaMs: null });
    const aberta = await m.snap.abrir();
    assert.equal(aberta.ok, true);
    assert.equal(m.relogio.ativos().length, 0);
    const relogio = relogioManual();
    for (const ruim of [0, -1, 1.5, '1000']) assert.throws(() => criarSnapshot({ criarConexao: () => clienteSnap(), temporizador: relogio, prazos: { finalizacaoMs: 5000, aberturaMs: ruim } }), TypeError);
    assert.throws(() => criarSnapshot({ criarConexao: () => clienteSnap(), temporizador: relogio, prazos: { finalizacaoMs: 5000 }, operacoes: { rastrear: () => {} } }), TypeError);
  });

  teste('P2-07 — sem registro de operações o prazo de abertura funciona do mesmo jeito (cancelamento pelo contrato interno), sem pendência rastreada', async () => {
    const conexao = adiado();
    const m = montar({ conectar: () => conexao.promessa, comRegistro: false });
    const aberta = m.snap.abrir();
    await ate(() => m.cliente.log.includes('connect'));
    m.relogio.disparar(1000);
    assert.equal((await aberta).motivo, 'ABERTURA_EXPIRADA');
    conexao.resolver();
    await ate(() => m.snap.situacao().aberturaPendente === false);
    assert.deepEqual(m.cliente.log, ['connect']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- C. coordenador
describe('[P3-COORD] coordenador com controle: prazo, cancelamento, retenção e liberação', () => {
  function janelaFalsa() {
    const e = { posse: true, liberacoes: 0 };
    const janela = { async adquirir() { return { async confirmarPosse() { return { confirmada: e.posse }; }, async liberar() { e.liberacoes += 1; return { liberada: true }; } }; } };
    return { janela, e };
  }
  const OK_SUPERVISAO = { ok: true, supervisao: { concluido: true, liberarTravaPermitido: true } };
  const ETAPA = 1111;
  const CORTESIA = 333;
  const POSSE = 2222;

  function cenario({ copia, avaliar, dump, finalizar = true, parada = false, cortesia = true, posseMs = false } = {}) {
    const relogio = relogioManual();
    const registro = criarRegistroDeOperacoes({ temporizador: relogio, ...(cortesia ? { cortesiaMs: CORTESIA } : {}) });
    const { janela, e } = janelaFalsa();
    const chamadas = { avaliar: 0, finalizar: 0, sinalDaCopia: null, entradaDoAvaliar: null };
    const gancho = { cb: null, aoPedir(cb) { gancho.cb = cb; } };
    const dependencias = {
      janela,
      etapas: [
        { nome: 'snapshot', executar: async () => ({ ok: true }) },
        { nome: 'dump', supervisionada: true, executar: dump ?? (async () => OK_SUPERVISAO) },
        { nome: 'copia', executar: async (op) => { chamadas.sinalDaCopia = op === undefined ? null : op.sinal; return copia ? copia(op) : { ok: true }; } },
      ],
      avaliar: async (entrada) => { chamadas.avaliar += 1; chamadas.entradaDoAvaliar = entrada; return avaliar ? avaliar(entrada) : { valido: true }; },
      controle: { registro, etapaMs: ETAPA, ...(posseMs ? { posseMs: POSSE } : {}) },
      ...(finalizar ? { finalizar: async () => { chamadas.finalizar += 1; return { concluida: true }; } } : {}),
      ...(parada ? { parada: gancho } : {}),
    };
    return { relogio, registro, e, chamadas, dependencias, gancho, rodar: () => executarBackup(dependencias) };
  }
  const aguardarSinal = (op) => new Promise((resolver) => op.sinal.addEventListener('abort', () => resolver({ ok: false }), { once: true }));

  teste('P3-C01 — fluxo normal COM controle é equivalente ao histórico: mesma saída, janela e finalização; todas as operações assentam; sem controle a chave `operacoes` nem existe', async () => {
    const com = cenario();
    const r = await com.rodar();
    const { janela, e } = janelaFalsa();
    const sem = await executarBackup({ janela, etapas: com.dependencias.etapas, avaliar: async () => ({ valido: true }), finalizar: async () => ({ concluida: true }) });
    for (const k of ['saida', 'valido', 'janela', 'finalizacao']) assert.deepEqual(r[k], sem[k], k);
    assert.deepEqual([r.saida, r.janela, r.finalizacao], [0, 'LIBERADA', 'CONCLUIDA']);
    assert.equal(com.e.liberacoes, 1);
    assert.equal(e.liberacoes, 1);
    assert.equal('operacoes' in sem, false);
    assert.equal(r.operacoes.total, 4);
    assert.equal(r.operacoes.pendentes, 0);
    assert.deepEqual(com.relogio.ativos(), [], 'nenhum prazo sobra');
    assert.equal(com.chamadas.entradaDoAvaliar.sinal.aborted, false);
  });

  teste('P3-C02 — `controle` inválido é recusado ANTES da trava (saída 2): registro que não é da fábrica, chave extra, prazo sem temporizador, prazo não inteiro', async () => {
    const { janela } = janelaFalsa();
    let adquiriu = 0;
    const j = { async adquirir() { adquiriu += 1; return janela.adquirir(); } };
    const etapas = [{ nome: 'snapshot', executar: async () => ({ ok: true }) }, { nome: 'dump', executar: async () => ({ ok: true }) }, { nome: 'copia', executar: async () => ({ ok: true }) }];
    const semTemporizador = criarRegistroDeOperacoes();
    const bom = criarRegistroDeOperacoes({ temporizador: relogioManual() });
    for (const controle of [{ registro: {} }, { registro: { ...bom } }, { registro: bom, extra: 1 }, { registro: semTemporizador, etapaMs: 5 }, { registro: bom, etapaMs: 1.5 }, { registro: bom, posseMs: 0 }, null, 7]) {
      const r = await executarBackup({ janela: j, etapas, avaliar: async () => ({ valido: true }), controle });
      assert.equal(r.saida, 2);
    }
    assert.equal(adquiriu, 0);
  });

  teste('P3-C03 — etapa que EXPIRA e RESPEITA o sinal: cancelamento solicitado e CONFIRMADO (assenta na cortesia); resultado inválido (ETAPA_EXPIRADA), nada pendente, trava liberada pelo fluxo normal e a avaliação não roda', async () => {
    const m = cenario({ copia: aguardarSinal });
    const rodando = m.rodar();
    await ate(() => m.relogio.registrado(ETAPA), 'prazo da cópia');
    m.relogio.disparar(ETAPA);
    const r = await rodando;
    assert.deepEqual([r.saida, r.janela, r.valido], [9, 'LIBERADA', false]);
    assert.ok(r.motivos.includes('ETAPA_EXPIRADA') && r.motivos.includes('ETAPA_FALHOU'));
    assert.equal(m.chamadas.avaliar, 0);
    assert.equal(m.chamadas.sinalDaCopia.aborted, true);
    assert.equal(m.e.liberacoes, 1);
    const copia = r.operacoes.operacoes.find((o) => o.etapa === 'copia');
    assert.deepEqual([copia.estado, copia.cancelamentoSolicitado, copia.cancelamentoConfirmado, copia.motivoDoCancelamento], ['ASSENTADA', true, true, 'ETAPA_EXPIRADA']);
    assert.equal(r.operacoes.pendentes, 0);
  });

  teste('P3-C04 — etapa que IGNORA o sinal: cortesia sem assentar => CANCELAMENTO_NAO_CONFIRMADO; trava RETIDA (saída 11), finalização ADIADA, avaliação e liberação NÃO acontecem e a operação segue na lista de pendentes', async () => {
    const d = adiado();
    const m = cenario({ copia: () => d.promessa });
    const rodando = m.rodar();
    await ate(() => m.relogio.registrado(ETAPA));
    m.relogio.disparar(ETAPA);
    await ate(() => m.relogio.registrado(CORTESIA), 'cortesia');
    m.relogio.disparar(CORTESIA);
    const r = await rodando;
    assert.deepEqual([r.saida, r.janela, r.finalizacao], [11, 'RETIDA', 'ADIADA']);
    for (const motivo of ['CANCELAMENTO_NAO_CONFIRMADO', 'ETAPA_EXPIRADA', 'TRAVA_RETIDA_POR_SEGURANCA']) assert.ok(r.motivos.includes(motivo), motivo);
    assert.deepEqual([m.e.liberacoes, m.chamadas.avaliar, m.chamadas.finalizar], [0, 0, 0]);
    assert.deepEqual(m.registro.pendentes().map((p) => [p.etapa, p.estado]), [['copia', 'CANCELAMENTO_NAO_CONFIRMADO']]);
    assert.equal(r.operacoes.pendentes, 1);
    assert.equal(Object.isFrozen(r), true);
    d.resolver();
    await andar();
  });

  teste('P3-C05 — resultado TARDIO nunca reverte a retenção: a etapa que ignorou o sinal conclui depois (ok:true); o registro marca `tardia`, mas a trava segue não liberada e nada foi finalizado', async () => {
    const d = adiado();
    const m = cenario({ copia: () => d.promessa });
    const rodando = m.rodar();
    await ate(() => m.relogio.registrado(ETAPA));
    m.relogio.disparar(ETAPA);
    await ate(() => m.relogio.registrado(CORTESIA));
    m.relogio.disparar(CORTESIA);
    const r = await rodando;
    d.resolver({ ok: true });
    await ate(() => m.registro.pendentes().length === 0, 'assentamento tardio');
    assert.deepEqual([r.janela, m.e.liberacoes, m.chamadas.finalizar, m.chamadas.avaliar], ['RETIDA', 0, 0, 0]);
    const copia = m.registro.resumo().operacoes.find((o) => o.etapa === 'copia');
    assert.deepEqual([copia.estado, copia.desfecho, copia.tardia], ['ASSENTADA', 'RESOLVIDA', true]);
  });

  teste('P3-C06 — operação que REJEITA depois do tempo limite: a rejeição tardia é observada (nenhuma rejeição sem tratamento) e não muda o resultado já devolvido', async () => {
    await semRejeicaoNaoObservada(async () => {
      const d = adiado();
      const m = cenario({ copia: () => d.promessa });
      const rodando = m.rodar();
      await ate(() => m.relogio.registrado(ETAPA));
      m.relogio.disparar(ETAPA);
      await ate(() => m.relogio.registrado(CORTESIA));
      m.relogio.disparar(CORTESIA);
      const r = await rodando;
      d.rejeitar(Object.assign(new Error('SEGREDO-NUNCA-EXPOR'), { code: 'EIO' }));
      await andar();
      assert.equal(r.janela, 'RETIDA');
      assert.equal(JSON.stringify(r).includes('SEGREDO'), false);
      assert.equal(m.registro.resumo().operacoes.find((o) => o.etapa === 'copia').desfecho, 'REJEITADA');
    });
  });

  teste('P3-C07 — etapa que devolve ok:true DEPOIS de o prazo vencer (mas dentro da cortesia) NÃO é sucesso: prazo excedido é falha (ETAPA_EXPIRADA) e a avaliação não roda', async () => {
    const m = cenario({ copia: async (op) => { await aguardarSinal(op); return { ok: true }; } });
    const rodando = m.rodar();
    await ate(() => m.relogio.registrado(ETAPA));
    m.relogio.disparar(ETAPA);
    const r = await rodando;
    assert.equal(r.saida, 9);
    assert.ok(r.motivos.includes('ETAPA_EXPIRADA'));
    assert.equal(m.chamadas.avaliar, 0);
  });

  teste('P3-C08 — PARADA durante a etapa: o pedido vira cancelamento (sinal abortado, motivo PARADA); a etapa para no ponto seguro, a parada é registrada e a trava é liberada pelo fluxo normal', async () => {
    const m = cenario({ copia: aguardarSinal, parada: true });
    const rodando = m.rodar();
    await ate(() => m.chamadas.sinalDaCopia !== null && m.gancho.cb !== null, 'cópia em execução');
    m.gancho.cb('SIGTERM');
    const r = await rodando;
    assert.equal(r.sinal, 'SIGTERM');
    assert.ok(r.motivos.includes('INTERROMPIDO'));
    assert.equal(r.valido, false);
    assert.equal(m.chamadas.sinalDaCopia.aborted, true);
    assert.equal(r.operacoes.operacoes.find((o) => o.etapa === 'copia').motivoDoCancelamento, 'PARADA');
    assert.deepEqual([r.janela, m.e.liberacoes], ['LIBERADA', 1]);
  });

  teste('P3-C09 — PARADA com etapa que ignora o sinal: cancelamento NÃO confirmado => trava RETIDA (saída 11); a parada nunca solta a trava', async () => {
    const d = adiado();
    const m = cenario({ copia: () => d.promessa, parada: true });
    const rodando = m.rodar();
    await ate(() => m.chamadas.sinalDaCopia !== null && m.gancho.cb !== null);
    m.gancho.cb('SIGINT');
    await ate(() => m.relogio.registrado(CORTESIA), 'cortesia');
    m.relogio.disparar(CORTESIA);
    const r = await rodando;
    assert.deepEqual([r.saida, r.janela, m.e.liberacoes, m.chamadas.finalizar], [11, 'RETIDA', 0, 0]);
    assert.ok(r.motivos.includes('CANCELAMENTO_NAO_CONFIRMADO'));
    d.resolver();
    await andar();
  });

  teste('P3-C10 — PERDA DE POSSE durante a execução (`posseMs`): a perda comprovada pede o cancelamento (POSSE_PERDIDA); a etapa para; a trava ALHEIA nunca é solta (saída 10, nenhuma liberação)', async () => {
    const m = cenario({ copia: aguardarSinal, posseMs: true });
    const rodando = m.rodar();
    await ate(() => m.relogio.registrado(POSSE), 'vigia de posse');
    m.e.posse = false;
    m.relogio.disparar(POSSE);
    const r = await rodando;
    assert.deepEqual([r.saida, r.janela, r.valido], [10, 'PERDIDA', false]);
    assert.equal(m.e.liberacoes, 0, 'a trava de outro dono nunca é tocada');
    assert.equal(r.operacoes.operacoes.find((o) => o.etapa === 'copia').motivoDoCancelamento, 'POSSE_PERDIDA');
    assert.equal(m.chamadas.avaliar, 0);
  });

  teste('P3-C11 — perda de posse com etapa que IGNORA o sinal: a espera é limitada pela cortesia, nada é finalizado nem liberado e a saída continua 10 (posse perdida)', async () => {
    const d = adiado();
    const m = cenario({ copia: () => d.promessa, posseMs: true });
    const rodando = m.rodar();
    await ate(() => m.relogio.registrado(POSSE));
    m.e.posse = false;
    m.relogio.disparar(POSSE);
    await ate(() => m.relogio.registrado(CORTESIA));
    m.relogio.disparar(CORTESIA);
    const r = await rodando;
    assert.deepEqual([r.saida, r.janela, m.e.liberacoes, m.chamadas.finalizar], [10, 'PERDIDA', 0, 0]);
    assert.ok(r.motivos.includes('CANCELAMENTO_NAO_CONFIRMADO'));
    d.resolver();
    await andar();
  });

  teste('P3-C12 — trava RETIDA enquanto há atividade: sem prazo configurado a etapa em andamento prende a coordenação; nada é avaliado nem liberado até ela assentar de verdade', async () => {
    const d = adiado();
    const m = cenario({ copia: () => d.promessa });
    const rodando = m.rodar();
    await ate(() => m.chamadas.sinalDaCopia !== null);
    assert.equal(await aindaPendente(rodando), true);
    assert.deepEqual([m.e.liberacoes, m.chamadas.avaliar, m.chamadas.finalizar], [0, 0, 0]);
    d.resolver({ ok: true });
    const r = await rodando;
    assert.deepEqual([r.saida, r.janela, m.chamadas.avaliar, m.e.liberacoes], [0, 'LIBERADA', 1, 1]);
  });

  teste('P3-C13 — operação PENDENTE (a abertura do snapshot) com finalização "concluída": a finalização NÃO conta (NAO_CONCLUIDA) e a trava fica RETIDA; sem `finalizar`, a última barreira também retém (OPERACAO_PENDENTE)', async () => {
    const d = adiado();
    const m = cenario();
    m.registro.rastrear({ etapa: 'ABERTURA_SNAPSHOT', recursos: ['SNAPSHOT', 'CONEXAO'] }, () => d.promessa);
    const r = await m.rodar();
    assert.deepEqual([r.saida, r.janela, r.finalizacao], [11, 'RETIDA', 'NAO_CONCLUIDA']);
    assert.ok(r.motivos.includes('FINALIZACAO_NAO_CONCLUIDA'));
    assert.equal(m.e.liberacoes, 0);

    const e2 = cenario({ finalizar: false });
    e2.registro.rastrear({ etapa: 'ABERTURA_SNAPSHOT', recursos: ['SNAPSHOT'] }, () => d.promessa);
    const r2 = await e2.rodar();
    assert.deepEqual([r2.saida, r2.janela, e2.e.liberacoes], [11, 'RETIDA', 0]);
    assert.ok(r2.motivos.includes('OPERACAO_PENDENTE'));
    d.resolver();
    await andar();
  });

  teste('P3-C14 — liberação SÓ quando autorizada: a regra do supervisor continua valendo com controle (liberarTravaPermitido:false => RETIDA, finalização ADIADA, nenhuma liberação)', async () => {
    const m = cenario({ dump: async () => ({ ok: true, supervisao: { concluido: true, liberarTravaPermitido: false } }) });
    const r = await m.rodar();
    assert.deepEqual([r.saida, r.janela, r.finalizacao, m.e.liberacoes, m.chamadas.finalizar], [11, 'RETIDA', 'ADIADA', 0, 0]);
  });

  teste('P3-C15 — a AVALIAÇÃO é rastreada: recebe o sinal; expirada e respeitando => ETAPA_EXPIRADA (inválida, trava liberada); expirada e ignorando => CANCELAMENTO_NAO_CONFIRMADO (RETIDA)', async () => {
    const a = cenario({ avaliar: (entrada) => new Promise((res) => entrada.sinal.addEventListener('abort', () => res({ valido: true }), { once: true })) });
    const ra = a.rodar();
    await ate(() => a.relogio.registrado(ETAPA) && a.chamadas.avaliar === 1, 'avaliação em curso');
    a.relogio.disparar(ETAPA);
    const resA = await ra;
    assert.equal(resA.saida, 9);
    assert.ok(resA.motivos.includes('ETAPA_EXPIRADA'));
    assert.equal(a.chamadas.entradaDoAvaliar.sinal.aborted, true);
    assert.equal(a.e.liberacoes, 1);

    const d = adiado();
    const b = cenario({ avaliar: () => d.promessa });
    const rb = b.rodar();
    await ate(() => b.relogio.registrado(ETAPA) && b.chamadas.avaliar === 1);
    b.relogio.disparar(ETAPA);
    await ate(() => b.relogio.registrado(CORTESIA));
    b.relogio.disparar(CORTESIA);
    const resB = await rb;
    assert.deepEqual([resB.saida, resB.janela, b.e.liberacoes, b.chamadas.finalizar], [11, 'RETIDA', 0, 0]);
    d.resolver({ valido: false });
    await andar();
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- D. etapas
describe('[P3-ETAPAS] cancelamento cooperativo nas etapas: pontos seguros, parciais preservados, nada publicado', () => {
  const pedaco = (n, v) => Buffer.alloc(n, v);
  async function cenario(n = 3) {
    const origem = criarArmazenamentoImagens({ diretorio: fix.criar() });
    const destino = criarArmazenamentoImagens({ diretorio: fix.criar() });
    const plano = [];
    for (let i = 0; i < n; i += 1) {
      const c = pedaco(40 + i, i + 1);
      const chave = `padrao/${sha(c)}/mestre.png`;
      await origem.gravar(chave, c, { maxBytes: 1000, sha256Esperado: sha(c) });
      plano.push({ chave, sha256: sha(c), bytes: c.length });
    }
    return { origem, destino, plano };
  }
  const arvore = (dir) => fs.readdirSync(dir, { recursive: true }).map(String);

  teste('P3-E01 — cópia com sinal JÁ abortado: CANCELADO antes de abrir qualquer origem; nada gravado no destino', async () => {
    const c = await cenario();
    const abertas = [];
    const controlador = new AbortController();
    controlador.abort();
    const origem = { abrir: (k) => { abertas.push(k); return c.origem.abrir(k); } };
    const r = await criarCopiaDeImagens({ origem, destino: c.destino, maxBytesPorArquivo: 1000 })({ plano: c.plano.map(({ chave, sha256 }) => ({ chave, sha256 })) }, { sinal: controlador.signal });
    assert.deepEqual([r.ok, r.falha.codigo, r.copiados], [false, 'CANCELADO', 0]);
    assert.deepEqual(abertas, []);
    for (const p of c.plano) assert.equal(await c.destino.existe(p.chave), false);
  });

  teste('P3-E02 — sinal abortado DEPOIS do primeiro item: o item já copiado e verificado é PRESERVADO, o seguinte nem é aberto; o conjunto não é completo', async () => {
    const c = await cenario();
    const controlador = new AbortController();
    const abertas = [];
    let gravacoes = 0;
    const destino = { existe: (k) => c.destino.existe(k), gravar: async (...a) => { const r = await c.destino.gravar(...a); gravacoes += 1; if (gravacoes === 1) controlador.abort(); return r; } };
    const origem = { abrir: (k) => { abertas.push(k); return c.origem.abrir(k); } };
    const r = await criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo: 1000 })({ plano: c.plano.map(({ chave, sha256 }) => ({ chave, sha256 })) }, { sinal: controlador.signal });
    assert.deepEqual([r.ok, r.completo, r.falha.codigo, r.copiados, r.falha.chave], [false, false, 'CANCELADO', 1, c.plano[1].chave]);
    assert.equal(await c.destino.existe(c.plano[0].chave), true, 'o item já copiado foi preservado');
    assert.equal(await c.destino.existe(c.plano[1].chave), false);
    assert.deepEqual(abertas, [c.plano[0].chave], 'o segundo item nunca foi aberto');
    assert.equal(await c.destino.existe(c.plano[2].chave), false);
  });

  teste('P3-E03 — sinal abortado DURANTE a gravação (no meio do fluxo): o armazenamento interrompe, o resultado é CANCELADO, nenhum arquivo parcial nem temporário sobra e os itens anteriores seguem intactos', async () => {
    const diretorioDestino = fix.criar();
    const c = await cenario();
    const destino = criarArmazenamentoImagens({ diretorio: diretorioDestino });
    const controlador = new AbortController();
    const origem = {
      abrir: async (k) => {
        if (k !== c.plano[1].chave) return c.origem.abrir(k);
        const real = await c.origem.abrir(k);
        return (async function* fonte() { let n = 0; for await (const bloco of real) { yield bloco; n += 1; if (n === 1) { controlador.abort(); await new Promise((r) => setTimeout(r, 20)); } } }());
      },
    };
    const r = await criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo: 1000 })({ plano: c.plano.map(({ chave, sha256 }) => ({ chave, sha256 })) }, { sinal: controlador.signal });
    assert.deepEqual([r.ok, r.falha.codigo, r.copiados], [false, 'CANCELADO', 1]);
    assert.equal(await destino.existe(c.plano[0].chave), true);
    assert.equal(await destino.existe(c.plano[1].chave), false);
    assert.equal(arvore(diretorioDestino).some((p) => p.endsWith('.tmp') || p.includes('.tmp')), false, 'nenhum temporário sobra');
    assert.equal(await destino.existe(c.plano[2].chave), false);
  });

  teste('P3-E04 — sem sinal (ou com a falha de leitura do armazenamento, que também usa GRAVACAO_ABORTADA) o código NÃO vira CANCELADO: o comportamento histórico é preservado', async () => {
    const c = await cenario(1);
    const origem = { abrir: async () => (async function* quebra() { yield pedaco(5, 9); throw new Error('falha de leitura'); }()) };
    const r = await criarCopiaDeImagens({ origem, destino: c.destino, maxBytesPorArquivo: 1000 })({ plano: c.plano.map(({ chave, sha256 }) => ({ chave, sha256 })) });
    assert.equal(r.falha.codigo, 'COPIA_FALHOU');
    const livre = await criarCopiaDeImagens({ origem: c.origem, destino: c.destino, maxBytesPorArquivo: 1000 })({ plano: c.plano.map(({ chave, sha256 }) => ({ chave, sha256 })) });
    assert.equal(livre.ok, true);
  });

  teste('P3-E05 — verificação: sinal abortado é INCONCLUSIVO (CANCELADO) antes de ler o primeiro arquivo; sinal malformado ou chave extra é ENTRADA_INVALIDA; a verificação é somente leitura', async () => {
    const c = await cenario(2);
    const copiado = await criarCopiaDeImagens({ origem: c.origem, destino: c.destino, maxBytesPorArquivo: 1000 })({ plano: c.plano.map(({ chave, sha256 }) => ({ chave, sha256 })) });
    const copia = { ok: true, completo: true, falha: null, copiados: copiado.copiados, arquivos: copiado.arquivos.map((a) => ({ ...a })) };
    const plano = c.plano.map(({ chave, sha256 }) => ({ chave, sha256 }));
    const lidas = [];
    const verificador = criarVerificadorDeImagensCopiadas({ destino: { abrir: (k) => { lidas.push(k); return c.destino.abrir(k); } } });
    const controlador = new AbortController();
    controlador.abort();
    const r = await verificador.verificar({ plano, copia, sinal: controlador.signal });
    assert.deepEqual({ ...r }, { concluida: false, ok: false, motivo: 'CANCELADO' });
    assert.deepEqual(lidas, []);
    for (const ruim of [{ plano, copia, sinal: 7 }, { plano, copia, sinal: {} }, { plano, copia, sinal: controlador.signal, extra: 1 }]) assert.equal((await verificador.verificar(ruim)).motivo, 'ENTRADA_INVALIDA');
    assert.equal((await verificador.verificar({ plano, copia })).ok, true, 'sem sinal o comportamento é o histórico');
  });

  teste('P3-E06 — cópia verificada: o sinal segue à cópia e à verificação SÓ quando existe; verificação cancelada = código CANCELADO e classe INCONCLUSIVA (nunca integridade comprovada); sem sinal as chamadas têm exatamente a forma histórica', async () => {
    const entradas = { copiar: [], verificar: [] };
    const copia = { ok: true, completo: true, falha: null, copiados: 1, arquivos: [{ chave: `padrao/${H('a')}/mestre.png`, sha256: H('a'), bytes: 3 }] };
    const contexto = { plano: [{ chave: `padrao/${H('a')}/mestre.png`, sha256: H('a') }] };
    const montar = (retornoDaVerificacao) => criarEtapaDeCopiaVerificada({
      copiar: async (...a) => { entradas.copiar.push(a); return copia; },
      verificador: { verificar: async (e) => { entradas.verificar.push(e); return retornoDaVerificacao; } },
    });
    const controlador = new AbortController();
    const comSinal = montar({ concluida: false, ok: false, motivo: 'CANCELADO' });
    const r = await comSinal.copiarVerificado(contexto, { sinal: controlador.signal });
    assert.equal(r.falha.codigo, 'CANCELADO');
    assert.equal(comSinal.obterVerificacao().classe, 'INCONCLUSIVA');
    assert.equal(entradas.copiar[0][1].sinal, controlador.signal);
    assert.equal(entradas.verificar[0].sinal, controlador.signal);
    const semSinal = montar({ concluida: true, ok: true, examinados: 1, bytes: 3 });
    assert.equal((await semSinal.copiarVerificado(contexto)).ok, true);
    assert.equal(entradas.copiar[1].length, 1);
    assert.deepEqual(Object.keys(entradas.verificar[1]).sort(), ['copia', 'plano']);
  });

  const manifestoDeTeste = () => {
    const PLANO = [{ chave: `7/${H('d')}/mestre.png`, sha256: H('e') }, { chave: `padrao/${H('a')}/mestre.png`, sha256: H('a') }];
    return construirManifesto({
      contexto: { snapshotId: '0-0-0', banco: { nome: 'gestao_epi', oid: '16384' }, registros: {}, plano: PLANO.map((p) => ({ ...p })) },
      copia: { ok: true, completo: true, copiados: 2, falha: null, arquivos: PLANO.map((p, i) => ({ ...p, bytes: 3 + i })) },
      dump: { concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') },
      conjuntoId: 'conjunto-p3-sel',
    });
  };

  teste('P3-E07 — selagem: sinal abortado ANTES de criar qualquer arquivo => CANCELADO sem tocar o disco; abortado ENTRE o manifesto e a marca => CANCELADO e o que ESTA operação criou é removido pela regra de propriedade, sem tocar o preexistente', async () => {
    const area = fix.criar();
    fs.writeFileSync(path.join(area, 'preexistente.txt'), 'x');
    const manifesto = manifestoDeTeste();
    const antes = new AbortController();
    antes.abort();
    const r1 = await criarSelagem().selar({ area, resultado: manifesto, sinal: antes.signal });
    assert.deepEqual([r1.ok, r1.falha.codigo], [false, 'CANCELADO']);
    assert.deepEqual(fs.readdirSync(area), ['preexistente.txt']);

    const durante = new AbortController();
    let ligacoes = 0;
    const ops = { ...operacoesDoSistema(), ligar: async (a, b) => { await operacoesDoSistema().ligar(a, b); ligacoes += 1; if (ligacoes === 1) durante.abort(); } };
    const r2 = await criarSelagem({ operacoes: ops }).selar({ area, resultado: manifesto, sinal: durante.signal });
    assert.deepEqual([r2.ok, r2.falha.codigo], [false, 'CANCELADO']);
    assert.equal(r2.falha.limpeza, undefined, 'a limpeza do que a operação criou foi completa');
    assert.deepEqual(fs.readdirSync(area), ['preexistente.txt'], 'nada que a operação criou sobrou; o preexistente foi preservado');
    const livre = await criarSelagem().selar({ area, resultado: manifesto });
    assert.equal(livre.ok, true, 'sem sinal o comportamento é o histórico');
  });

  teste('P3-E08 — composição: sinal abortado antes da cópia, entre a cópia e a selagem, e antes da releitura => CANCELADO no estágio certo; selar NÃO é chamado depois do pedido e nada é publicado', async () => {
    const area = fix.criar();
    const manifesto = manifestoDeTeste();
    const chamadas = { selar: 0, verificar: 0, copiar: 0 };
    const copiaOk = { ok: true, completo: true, falha: null, copiados: 2, arquivos: manifesto.manifesto.arquivos.map((a) => ({ chave: a.chave, sha256: a.sha256, bytes: a.bytes })) };
    const base = (controlador) => criarComposicaoDoConjunto({
      copiar: async (...a) => { chamadas.copiar += 1; if (controlador) controlador.abort(); return copiaOk; },
      selagem: { selar: async () => { chamadas.selar += 1; return { ok: true, selado: true }; }, verificar: async () => { chamadas.verificar += 1; return { ok: false }; } },
      area, conjuntoId: 'conjunto-p3-comp',
    });
    const dump = { concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') };
    const contexto = { snapshotId: '0-0-0', banco: { nome: 'gestao_epi', oid: '16384' }, registros: {}, plano: manifesto.manifesto.arquivos.map((a) => ({ chave: a.chave, sha256: a.sha256 })) };
    const pre = new AbortController();
    pre.abort();
    const r0 = await base(null).compor({ contexto, dump, sinal: pre.signal });
    assert.deepEqual([r0.ok, r0.falha.estagio, r0.falha.codigo, chamadas.copiar], [false, 'COPIA', 'CANCELADO', 0]);

    const meio = new AbortController();
    const r1 = await base(meio).compor({ contexto, dump, sinal: meio.signal });
    assert.deepEqual([r1.ok, r1.falha.estagio, r1.falha.codigo], [false, 'SELAGEM', 'CANCELADO']);
    assert.deepEqual([chamadas.selar, chamadas.verificar], [0, 0], 'nada foi selado nem lido depois do pedido');

    const invalido = await base(null).compor({ contexto, dump, sinal: { aborted: 'sim' } });
    assert.deepEqual([invalido.ok, invalido.falha.codigo], [false, 'ENTRADA_INVALIDA']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- E. produção integrada
describe('[P3-PRODUCAO] composição de produção com `operacoes`: efeitos no disco, na trava e na publicação', () => {
  const ETAPA = 7001;
  const CORTESIA = 7002;
  const ABERTURA = 7003;
  const executar = (a, nome = 'prep-1') => criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: nome, conjuntoId: 'conjunto-p3-0001' });
  /** Relógio que expira IMEDIATAMENTE a N-ésima chamada de um valor (as demais ficam inertes até serem disparadas à mão). */
  function relogioEnesimo(ms, enesima) {
    const relogio = relogioManual();
    const original = relogio.prazo.bind(relogio);
    let chamadas = 0;
    relogio.prazo = (valor) => {
      if (valor === ms) { chamadas += 1; if (chamadas === enesima) return { promessa: Promise.resolve(), cancelar() {} }; }
      return original(valor);
    };
    return relogio;
  }
  const comOperacoes = (operacoes, extras = {}) => ambiente({ ...extras, alterarConfig: (c) => { c.operacoes = operacoes; return c; } });
  const publicados = (a) => fs.readdirSync(a.dirs.publicados);

  teste('P3-P01 — configuração: `operacoes` é opcional, estrito (chaves conhecidas, inteiros seguros positivos, ao menos uma) e DESLIGADO por omissão; sem ele o resultado não traz resumo de operações', async () => {
    for (const ruim of [{}, { aberturaMs: 0 }, { etapaMs: 1.5 }, { extra: 1 }, { posseMs: '5' }, null]) {
      const a = await comOperacoes(ruim);
      assert.throws(() => criarBackupDeProducao(a.config), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    }
    const normal = await ambiente();
    const composto = await executar(normal);
    assert.equal(composto.proveniencia.operacoes, null);
    assert.equal('operacoes' in composto.resultado.coordenador, false);
  });

  teste('P3-P02 — cópia cancelada por prazo de etapa em fluxo completo: a cópia para no ponto seguro, imagens já copiadas ficam, NADA é selado nem publicado, a trava é liberada (a operação assentou) e o resumo mostra cancelamento confirmado', async () => {
    const relogio = relogioEnesimo(ETAPA, 1);
    const a = await comOperacoes({ etapaMs: ETAPA, cortesiaMs: CORTESIA }, { portasExtras: { temporizador: relogio } });
    const composto = await executar(a);
    const c = composto.resultado.coordenador;
    assert.deepEqual([c.saida, c.janela, c.valido], [9, 'LIBERADA', false]);
    assert.ok(c.motivos.includes('ETAPA_EXPIRADA'));
    assert.equal(composto.resultado.composicao.ok, false);
    assert.equal(composto.resultado.composicao.falha.codigo, 'CANCELADO');
    assert.deepEqual(publicados(a), []);
    assert.equal(fs.existsSync(path.join(a.dirs.preparacoes, 'prep-1', 'manifesto.json')), false);
    assert.equal(composto.resultado.publicacao === null || composto.resultado.publicacao.publicada !== true, true);
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), false);
    const copia = composto.proveniencia.operacoes.operacoes.find((o) => o.etapa === 'copia');
    assert.deepEqual([copia.estado, copia.cancelamentoConfirmado], ['ASSENTADA', true]);
    assert.equal(composto.proveniencia.operacoes.pendentes, 0);
  });

  teste('P3-P03 — AVALIAÇÃO cancelada antes de incorporar o dump e de publicar: o pacote fica CANCELADO, o dump NÃO é incorporado, nada é publicado e a operação da avaliação assenta (contraprova: sem cancelamento o dump é incorporado)', async () => {
    const controle = await ambiente();
    const normal = await executar(controle);
    assert.equal(fs.existsSync(path.join(controle.dirs.publicados, 'prep-1', 'dump', 'postgres.dump')), true, 'contraprova: sem cancelamento o dump é incorporado e o pacote é publicado');
    assert.equal(normal.resultado.publicacao.publicada, true);

    const relogio = relogioEnesimo(ETAPA, 2);
    const a = await comOperacoes({ etapaMs: ETAPA, cortesiaMs: CORTESIA }, { portasExtras: { temporizador: relogio } });
    const composto = await executar(a);
    assert.equal(composto.resultado.pacote.motivo, 'CANCELADO');
    assert.equal(fs.existsSync(path.join(a.dirs.preparacoes, 'prep-1', 'dump')), false, 'o dump não foi incorporado');
    assert.deepEqual(publicados(a), []);
    assert.equal(composto.resultado.publicacao, null);
    assert.ok(composto.resultado.coordenador.motivos.includes('ETAPA_EXPIRADA'));
    const avaliacao = composto.proveniencia.operacoes.operacoes.find((o) => o.etapa === 'avaliacao');
    assert.deepEqual([avaliacao.estado, avaliacao.motivoDoCancelamento], ['ASSENTADA', 'ETAPA_EXPIRADA']);
  });

  teste('P3-P04 — abertura do snapshot EXPIRADA em fluxo completo: nenhum pg_dump é lançado, a trava fica RETIDA no disco enquanto a abertura real não assentar, nenhuma consulta é enviada depois do prazo, e a conexão tardia não produz efeito', async () => {
    const conexao = adiado();
    const log = [];
    const cliente = clienteFalso('gepi_cp_origem');
    cliente.connect = () => { log.push('connect'); return conexao.promessa; };
    const consultar = cliente.query;
    cliente.query = (...a) => { log.push('query'); return consultar.apply(cliente, a); };
    const falso = require('../helpers/ambiente-backup-operacao').spawnFalso();
    const relogio = relogioManual();
    const a = await comOperacoes({ aberturaMs: ABERTURA }, { portasExtras: { temporizador: relogio, spawn: falso.spawn } });
    a.config.conexao = { ...a.config.conexao, criarConexao: () => cliente };
    const rodando = executar(a);
    await ate(() => relogio.registrado(ABERTURA), 'prazo de abertura');
    relogio.disparar(ABERTURA);
    await ate(() => relogio.registrado(a.config.conexao.finalizacaoMs), 'prazo de finalização');
    relogio.disparar(a.config.conexao.finalizacaoMs);
    const composto = await rodando;
    const c = composto.resultado.coordenador;
    assert.deepEqual([c.saida, c.janela], [11, 'RETIDA']);
    assert.ok(c.motivos.includes('FINALIZACAO_NAO_CONCLUIDA'));
    assert.deepEqual(falso.chamadas, [], 'nenhum pg_dump nem pg_restore foi lançado');
    assert.deepEqual(log, ['connect'], 'nenhuma consulta depois do prazo');
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), true, 'a trava segue retida no disco');
    assert.deepEqual(publicados(a), []);
    assert.equal(composto.proveniencia.operacoes.pendentes, 1);
    conexao.resolver();
    await andar();
    assert.deepEqual(log, ['connect'], 'a conexão tardia não produziu efeito');
    assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), true);
  });

  teste('P3-P05 — compatibilidade com P4 e P5: o orçamento e o diagnóstico continuam presentes com `operacoes`; a proveniência declara que o orçamento NÃO cobre a segunda cópia do dump e o resumo não traz texto de dependência', async () => {
    const a = await ambiente({ alterarConfig: (c) => { c.limites = { totalBytes: 10_000_000 }; c.operacoes = { etapaMs: ETAPA, cortesiaMs: CORTESIA }; return c; } });
    const composto = await executar(a);
    assert.equal(composto.proveniencia.limites.totalBytes, 10_000_000);
    assert.deepEqual([composto.proveniencia.limites.cobreSegundaCopiaDoDump, composto.proveniencia.limites.ocupacaoFisicaTotal], [true, false]);
    assert.equal(composto.proveniencia.limites.usadoDoOrcamento > DUMP_BYTES.length, true);
    assert.ok(composto.proveniencia.captura.diagnosticoDoStderr);
    assert.equal(composto.proveniencia.operacoes.pendentes, 0);
    const texto = JSON.stringify(composto.proveniencia.operacoes);
    for (const proibido of [a.raiz, a.dirs.imagens, 'pgpass', 'SEGREDO']) assert.equal(texto.includes(proibido), false, proibido);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- F. compatibilidade P1 x P2 x registro
describe('[P3-P1] compatibilidade com P1: nada que uma operação pendente ainda usa é finalizado; finalização única', () => {
  const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
  const executorPath = require.resolve('../../src/services/imagem-backup-executor.service');
  const operacionalPath = require.resolve('../../src/services/imagem-backup-operacional.service');

  async function comExecutor(executor, fn) {
    require(executorPath);
    const original = require.cache[executorPath].exports;
    const anterior = require.cache[operacionalPath];
    require.cache[executorPath].exports = { ...original, executarBackupSupervisionado: executor };
    delete require.cache[operacionalPath];
    try { return await fn(require(operacionalPath).executarBackupOperacional); } finally {
      require.cache[executorPath].exports = original;
      if (anterior === undefined) delete require.cache[operacionalPath]; else require.cache[operacionalPath] = anterior;
    }
  }
  function mundo({ connectPendente = null, aberturaMs } = {}) {
    const relogio = relogioManual();
    const registro = criarRegistroDeOperacoes({ temporizador: relogio });
    const cliente = clienteFalso('gepi_p3_origem');
    const efeitos = { fim: 0, janela: 0 };
    const original = cliente.end;
    cliente.end = async () => { efeitos.fim += 1; return original.call(cliente); };
    if (connectPendente !== null) cliente.connect = () => connectPendente.promessa;
    const dependencias = {
      janela: { adquirir: async () => { efeitos.janela += 1; throw new Error('nunca'); } },
      conexao: { criarConexao: () => cliente, temporizador: relogio, prazos: { finalizacaoMs: 1000, ...(aberturaMs === undefined ? {} : { aberturaMs }) }, planejar: planejarArquivos },
      processoDoDump: () => ({}),
      copia: async () => ({ ok: true }),
      avaliar: () => ({ valido: true, motivos: [] }),
      controle: { registro },
    };
    return { relogio, registro, cliente, efeitos, dependencias, rollbacks: () => cliente.sqls.filter((s) => s === 'ROLLBACK').length };
  }
  const lanca = () => { throw new Error('SEGREDO-NUNCA-EXPOR'); };

  teste('P3-I01 — com registro e nada pendente, P1 continua finalizando (ROLLBACK + end() uma vez); a trava segue não liberada', async () => {
    const m = mundo();
    const r = await comExecutor(async (deps) => { await deps.snapshot(); throw new Error('x'); }, (op) => op(m.dependencias));
    assert.deepEqual([r.saida, r.janela, r.finalizacao], [1, 'NAO_LIBERADA', 'CONCLUIDA']);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim, m.efeitos.janela], [1, 1, 0]);
  });

  teste('P3-I02 — P1 x P2: a abertura EXPIROU (a promessa de abrir() já resolveu) mas a operação real segue pendente: a exceção do executor NÃO finaliza — nem ROLLBACK, nem end() — e a finalização fica NAO_CONCLUIDA', async () => {
    const conexao = adiado();
    const m = mundo({ connectPendente: conexao, aberturaMs: 500 });
    const r = await comExecutor(async (deps) => {
      const aberta = deps.snapshot();
      await andar();
      m.relogio.disparar(500);
      assert.deepEqual(await aberta, { ok: false });
      throw new Error('SEGREDO-NUNCA-EXPOR');
    }, (op) => op(m.dependencias));
    assert.deepEqual([r.saida, r.janela, r.finalizacao], [1, 'NAO_LIBERADA', 'NAO_CONCLUIDA']);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim], [0, 0], 'a conexão pendente não foi tocada');
    assert.equal(JSON.stringify(r).includes('SEGREDO'), false);
    conexao.resolver();
    await andar();
  });

  teste('P3-I03 — P1 x registro: operação rastreada ainda pendente (a cópia) => a exceção do executor não finaliza o snapshot, mesmo com as flags de P1 em branco', async () => {
    const m = mundo();
    const pendente = adiado();
    const r = await comExecutor(async (deps) => {
      await deps.snapshot();
      m.dependencias.controle.registro.rastrear({ etapa: 'avaliacao', recursos: ['ARMAZENAMENTO'] }, () => pendente.promessa);
      throw new Error('x');
    }, (op) => op(m.dependencias));
    assert.equal(r.finalizacao, 'NAO_CONCLUIDA');
    assert.deepEqual([m.rollbacks(), m.efeitos.fim], [0, 0]);
    pendente.resolver();
  });

  teste('P3-I04 — tentativa DUPLICADA de finalização: o executor pede a finalização duas vezes (mais a de P1 ao lançar); o snapshot é finalizado UMA vez só (um ROLLBACK, um end())', async () => {
    const m = mundo();
    const respostas = [];
    const r = await comExecutor(async (deps) => {
      await deps.snapshot();
      respostas.push(await deps.finalizar(), await deps.finalizar());
      throw new Error('x');
    }, (op) => op(m.dependencias));
    assert.deepEqual(respostas.map((x) => x.concluida), [true, false]);
    assert.deepEqual([m.rollbacks(), m.efeitos.fim], [1, 1]);
    assert.equal(r.finalizacao, 'NAO_CONCLUIDA', 'P1 não finaliza de novo');
  });

  teste('P3-I05 — o `controle` da entrada operacional é validado antes de qualquer efeito: registro que não é da fábrica => recusa (saída 2) sem criar conexão; `aberturaMs` inválido idem', async () => {
    const m = mundo();
    let criadas = 0;
    const base = { ...m.dependencias, conexao: { ...m.dependencias.conexao, criarConexao: () => { criadas += 1; return m.cliente; } } };
    for (const dep of [{ ...base, controle: { registro: {} } }, { ...base, controle: 7 }, { ...base, conexao: { ...base.conexao, prazos: { finalizacaoMs: 1000, aberturaMs: 0 } } }]) {
      const r = await comExecutor(async () => { throw new Error('nunca'); }, (op) => op(dep));
      assert.equal(r.saida, 2);
    }
    assert.equal(criadas, 0);
  });
});
