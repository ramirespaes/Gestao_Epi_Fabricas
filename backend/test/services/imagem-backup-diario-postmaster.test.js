'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6): registro durável e RECONCILIAÇÃO com o POSTMASTER SUPERVISIONADO. Eventos novos (ordem dos clientes, emergência do SIGQUIT, identidade não comprovada) e regras novas da reconciliação, sempre com a distinção que o responsável exigiu:
 * ENCERRAMENTO DE PROCESSOS ≠ CONCLUSÃO DA TENTATIVA ≠ SUCESSO DO BACKUP. A reconciliação só fala de processos e recursos: `comprovaBackupIntegro` é sempre false. Observação de processo simulada; nenhum processo real.
 */

const diario = () => exigirModulo('src/services/imagem-backup-diario-execucao.service');
const L_PG = '1'.repeat(32);
const L_DUMP = '2'.repeat(32);
const RUNNER = 9001;
const SENT_PG = 9002;
const SENT_DUMP = 9003;
const AREA = '/private/tmp/gepi-hom-aaaaaaaa';
const PGDATA = `${AREA}/pgdata`;

let base;
before(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-dpm-'))); fs.chmodSync(base, 0o700); });
after(() => { fs.rmSync(base, { recursive: true, force: true }); });
let n = 0;

const vivos = (...pids) => async (pid) => (pids.includes(pid) ? 'VIVO' : 'AUSENTE');

/** Monta uma tentativa. `postmaster` e `dump` descrevem o que cada sentinela chegou a registrar. */
function montar({ postmaster = 'confirmado', dump = null, fim = 'FINALIZADA', runnerEvento = true, legado = false } = {}) {
  n += 1;
  const raiz = path.join(base, `r-${n}`);
  fs.mkdirSync(raiz, { mode: 0o700 });
  const T = 't-0001';
  const r = diario().iniciarTentativa({ raiz, tentativaId: T, runnerPid: RUNNER, area: AREA, pgdata: PGDATA });
  const sentinela = (id, pid, papel, passos) => {
    r.registrar('INTENCAO_LANCAMENTO', { lancamentoId: id, papel, executavel: papel, nArgs: 3, argsSha256: 'a'.repeat(64) });
    if (passos.length === 0) return;
    r.registrar('SENTINELA_LANCADA', { lancamentoId: id, sentinelaPid: pid });
    const w = diario().abrirEscritor({ raiz, tentativaId: T, escritor: `sentinela-${id}` });
    for (const [tipo, dados] of passos) w.registrar(tipo, { lancamentoId: id, ...dados });
    w.fechar();
  };
  if (legado) {
    r.registrar('POSTGRES_INTENCAO', {});
    r.registrar('POSTGRES_IDENTIDADE', { pid: 9500, area: AREA });
  } else if (postmaster !== null) {
    r.registrar('POSTGRES_INTENCAO', {});
    const ativa = ['SENTINELA_ATIVA', { sentinelaPid: SENT_PG }];
    const lancado = ['CLIENTE_LANCADO', { clientePid: 9500 }];
    const saiu = [['CLIENTE_ENCERRADO', { codigo: 0, sinal: null }], ['GRUPO_VERIFICADO', { vazio: true }]];
    const passos = {
      confirmado: [ativa, lancado, ['POSTMASTER_ORDEM', { clientes: 'NENHUM' }], ['PARADA_SOLICITADA', { origem: 'RUNNER', sinal: 'SIGINT' }], ['SINAL_ENVIADO', { sinal: 'SIGINT', aceito: true }], ...saiu, ['SENTINELA_FIM', { resultado: 'CONCLUIDO' }]],
      emergencia: [ativa, lancado, ['POSTMASTER_ORDEM', { clientes: 'NENHUM' }], ['SINAL_ENVIADO', { sinal: 'SIGINT', aceito: true }], ['POSTMASTER_EMERGENCIA', { sinal: 'SIGQUIT' }], ['SINAL_ENVIADO', { sinal: 'SIGQUIT', aceito: true }], ['CLIENTE_ENCERRADO', { codigo: 2, sinal: null }], ['GRUPO_VERIFICADO', { vazio: true }], ['SENTINELA_FIM', { resultado: 'ENCERRADO_ANORMAL' }]],
      'sem-saida': [ativa, lancado, ['SINAL_ENVIADO', { sinal: 'SIGINT', aceito: true }]],
      'identidade-incerta': [ativa, lancado, ['IDENTIDADE_NAO_COMPROVADA', { fase: 'SIGINT', motivo: 'PS_AUSENTE' }], ['SENTINELA_FIM', { resultado: 'IDENTIDADE_INCERTA' }]],
      'nao-comprovado': [ativa, lancado, ['SINAL_ENVIADO', { sinal: 'SIGINT', aceito: true }], ['SINAL_ENVIADO', { sinal: 'SIGQUIT', aceito: true }], ['SENTINELA_FIM', { resultado: 'ENCERRAMENTO_NAO_COMPROVADO' }]],
      'sem-identidade': [],
      'sem-cliente': [ativa],
    }[postmaster];
    sentinela(L_PG, SENT_PG, 'postgres', passos);
  }
  if (dump === 'interrompido') {
    sentinela(L_DUMP, SENT_DUMP, 'pg_dump', [['SENTINELA_ATIVA', { sentinelaPid: SENT_DUMP }], ['CLIENTE_LANCADO', { clientePid: 9600 }], ['ORFANDADE_DETECTADA', {}], ['CLIENTE_ENCERRADO', { codigo: null, sinal: 'SIGTERM' }], ['GRUPO_VERIFICADO', { vazio: true }], ['SENTINELA_FIM', { resultado: 'ENCERRADO_COM_FALHA' }]]);
  } else if (dump === 'pendente') {
    sentinela(L_DUMP, SENT_DUMP, 'pg_dump', [['SENTINELA_ATIVA', { sentinelaPid: SENT_DUMP }], ['CLIENTE_LANCADO', { clientePid: 9600 }]]);
  }
  if (fim !== null) r.registrar('TENTATIVA_FIM', { resultado: fim });
  void runnerEvento;
  r.fechar();
  return { raiz, tentativaId: T };
}
const reconciliar = (t, observarProcesso) => diario().reconciliar({ ...t, observarProcesso });

describe('[DPM] esquema dos eventos novos', () => {
  test('DPM-01 — POSTMASTER_ORDEM, POSTMASTER_EMERGENCIA e IDENTIDADE_NAO_COMPROVADA existem com campos exatos e valores restritos', () => {
    n += 1;
    const raiz = path.join(base, `e-${n}`);
    fs.mkdirSync(raiz, { mode: 0o700 });
    const r = diario().iniciarTentativa({ raiz, tentativaId: 't-0001', runnerPid: RUNNER });
    assert.ok(diario().EVENTOS.includes('POSTMASTER_ORDEM') && diario().EVENTOS.includes('POSTMASTER_EMERGENCIA') && diario().EVENTOS.includes('IDENTIDADE_NAO_COMPROVADA'));
    r.registrar('POSTMASTER_ORDEM', { lancamentoId: L_PG, clientes: 'NENHUM' });
    r.registrar('POSTMASTER_EMERGENCIA', { lancamentoId: L_PG, sinal: 'SIGQUIT' });
    r.registrar('IDENTIDADE_NAO_COMPROVADA', { lancamentoId: L_PG, fase: 'SIGINT', motivo: 'PS_AUSENTE' });
    for (const [tipo, dados] of [
      ['POSTMASTER_ORDEM', { lancamentoId: L_PG, clientes: 'nenhum' }],
      ['POSTMASTER_ORDEM', { lancamentoId: L_PG }],
      ['POSTMASTER_ORDEM', { lancamentoId: L_PG, clientes: 'NENHUM', extra: 1 }],
      ['POSTMASTER_EMERGENCIA', { lancamentoId: L_PG, sinal: 'sigquit' }],
      ['POSTMASTER_EMERGENCIA', { lancamentoId: 'x', sinal: 'SIGQUIT' }],
      ['IDENTIDADE_NAO_COMPROVADA', { lancamentoId: L_PG, fase: 'SIGINT', motivo: 'ps ausente' }],
      ['IDENTIDADE_NAO_COMPROVADA', { lancamentoId: L_PG, fase: 'SIGINT', motivo: 'PS_AUSENTE', senha: 'x' }],
    ]) assert.throws(() => r.registrar(tipo, dados), (f) => f.code === 'EVENTO_INVALIDO', `${tipo} ${JSON.stringify(dados)}`);
    r.fechar();
  });
});

describe('[DPM] reconciliação com o postmaster supervisionado', () => {
  test('DPM-02 — runner MORTO, postmaster encerrado pela sentinela (SIGINT, saída 0, grupo vazio): CONCLUIDA — sem POSTGRES_SEM_AUTORIDADE, porque a autoridade era da sentinela', async () => {
    const t = montar({ postmaster: 'confirmado' });
    const r = await reconciliar(t, vivos());
    assert.equal(r.estado, 'CONCLUIDA', JSON.stringify(r.motivos));
    assert.ok(!r.motivos.includes('POSTGRES_SEM_AUTORIDADE'));
    assert.equal(r.liberaNovaTentativa, true);
  });

  test('DPM-03 — SIGQUIT usado (encerramento ANORMAL): a saída está comprovada, mas a tentativa NÃO é CONCLUIDA (POSTGRES_ENCERRAMENTO_ANORMAL) e não libera nova tentativa', async () => {
    const r = await reconciliar(montar({ postmaster: 'emergencia' }), vivos());
    assert.equal(r.estado, 'INCONCLUSIVA');
    assert.ok(r.motivos.includes('POSTGRES_ENCERRAMENTO_ANORMAL'));
    assert.equal(r.liberaNovaTentativa, false);
  });

  test('DPM-04 — a sentinela do postmaster MORREU antes da confirmação do término: INCONCLUSIVA (AUTORIDADE_PERDIDA); nenhuma recuperação por PID', async () => {
    const r = await reconciliar(montar({ postmaster: 'sem-saida' }), vivos());
    assert.equal(r.estado, 'INCONCLUSIVA');
    assert.ok(r.motivos.includes('AUTORIDADE_PERDIDA'));
    assert.equal(r.liberaNovaTentativa, false);
  });

  test('DPM-05 — a sentinela está VIVA, mas ainda sem término: EM_ANDAMENTO (aguardar), nunca CONCLUIDA', async () => {
    const r = await reconciliar(montar({ postmaster: 'sem-saida' }), vivos(SENT_PG));
    assert.equal(r.estado, 'EM_ANDAMENTO');
    assert.equal(r.liberaNovaTentativa, false);
  });

  test('DPM-06 — identidade incerta (SENTINELA_FIM IDENTIDADE_INCERTA, sem sinal): POSTGRES_ENCERRAMENTO_NAO_COMPROVADO; encerramento não comprovado idem', async () => {
    for (const p of ['identidade-incerta', 'nao-comprovado']) {
      const r = await reconciliar(montar({ postmaster: p }), vivos());
      assert.equal(r.estado, 'INCONCLUSIVA', p);
      assert.ok(r.motivos.includes('POSTGRES_ENCERRAMENTO_NAO_COMPROVADO'), `${p} ${JSON.stringify(r.motivos)}`);
      assert.equal(r.liberaNovaTentativa, false);
    }
  });

  test('DPM-07 — registro incompleto entre a intenção e a identidade (sem SENTINELA_LANCADA, ou sem CLIENTE_LANCADO): INCONCLUSIVA e bloqueia', async () => {
    for (const p of ['sem-identidade', 'sem-cliente']) {
      const r = await reconciliar(montar({ postmaster: p }), vivos());
      assert.equal(r.estado, 'INCONCLUSIVA', p);
      assert.equal(r.liberaNovaTentativa, false);
    }
  });

  test('DPM-08 — cliente (pg_dump) ainda pendente com o postmaster já encerrado: a tentativa NÃO é CONCLUIDA', async () => {
    const r = await reconciliar(montar({ postmaster: 'confirmado', dump: 'pendente' }), vivos());
    assert.notEqual(r.estado, 'CONCLUIDA');
    assert.equal(r.liberaNovaTentativa, false);
  });

  test('DPM-09 — uma tentativa inconclusiva bloqueia QUALQUER nova tentativa (avaliarNovaTentativa), com a mesma raiz de estado', async () => {
    const t = montar({ postmaster: 'sem-saida' });
    const a = await diario().avaliarNovaTentativa({ raiz: t.raiz, observarProcesso: vivos() });
    assert.equal(a.liberada, false);
    assert.deepEqual(a.tentativas.map((x) => x.estado), ['INCONCLUSIVA']);
    const ok = montar({ postmaster: 'confirmado' });
    const b = await diario().avaliarNovaTentativa({ raiz: ok.raiz, observarProcesso: vivos() });
    assert.equal(b.liberada, true);
  });

  test('DPM-10 — compatibilidade: sem lançamento do postmaster pela sentinela (modo antigo, runner dono), runner morto continua sendo POSTGRES_SEM_AUTORIDADE', async () => {
    const r = await reconciliar(montar({ legado: true, fim: null }), vivos());
    assert.equal(r.estado, 'INCONCLUSIVA');
    assert.ok(r.motivos.includes('POSTGRES_SEM_AUTORIDADE'));
  });
});

describe('[DPM] recuperação de processos ≠ backup concluído', () => {
  test('DPM-11 — dump INTERROMPIDO (cliente encerrado por SIGTERM da sentinela órfã) + postmaster confirmado: a reconciliação é CONCLUIDA para PROCESSOS e RECURSOS, e diz explicitamente que NÃO comprova backup íntegro', async () => {
    const r = await reconciliar(montar({ postmaster: 'confirmado', dump: 'interrompido', fim: 'FINALIZADA_COM_PENDENCIAS' }), vivos());
    assert.equal(r.estado, 'CONCLUIDA');
    assert.equal(r.comprovaBackupIntegro, false);
    assert.equal(r.escopo, 'PROCESSOS_E_RECURSOS');
    assert.equal(r.lancamentos.find((l) => l.papel === 'pg_dump').estado, 'CONFIRMADO');
  });

  test('DPM-12 — o resultado da reconciliação nunca traz campo que sugira backup válido, selado, verificado ou publicável', async () => {
    for (const p of ['confirmado', 'emergencia', 'sem-saida']) {
      const r = await reconciliar(montar({ postmaster: p }), vivos());
      assert.equal(r.comprovaBackupIntegro, false);
      assert.equal(/valido|selad|verific|public|integro(?!$)/i.test(Object.keys(r).filter((k) => k !== 'comprovaBackupIntegro').join(',')), false, Object.keys(r).join(','));
    }
  });

  test('DPM-13 — o diário e a recuperação não conhecem selagem, verificação nem publicação (fonte dos três módulos novos e do diário)', () => {
    for (const arq of ['imagem-backup-diario-execucao.service.js', 'imagem-backup-postmaster-sentinela.service.js', 'imagem-backup-postmaster-lancador.service.js', 'imagem-backup-postmaster-identidade.service.js']) {
      const fonte = fs.readFileSync(path.join(__dirname, '../../src/services', arq), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      assert.equal(/require\([^)]*(selagem|publicacao|registro-publicacao|operacional|copia|manifesto|restauracao|pgdump)/.test(fonte), false, arq);
    }
  });
});
