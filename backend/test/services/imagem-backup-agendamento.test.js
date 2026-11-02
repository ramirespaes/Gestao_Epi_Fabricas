'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarControladorDeExecucao, planejarRetencao, POLITICA_PADRAO, CONFIRMACAO_DE_ATIVACAO } = require('../../src/services/imagem-backup-agendamento.service');

/** Política de execução com RELÓGIO, PRAZO, EXECUTOR e ALERTA simulados. Nenhum timer, cron, processo, backup ou rede. */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const H = 3600 * 1000;
const POLITICA = { ...POLITICA_PADRAO, ativa: true, intervaloMs: 24 * H, timeoutMs: H, maxTentativas: 3, esperaEntreTentativasMs: 15 * 60000, retencao: { ...POLITICA_PADRAO.retencao } };
const VALIDO = { executado: true, estados: { backupOperacionalValido: true, restauracaoComprovada: true } };

function montar({ politica = POLITICA, executar } = {}) {
  let agora = 1_000_000;
  const prazos = [];
  const alertas = [];
  const chamadas = [];
  const ctl = criarControladorDeExecucao({
    politica,
    relogio: () => agora,
    executar: executar ?? (async (p) => { chamadas.push(p); return VALIDO; }),
    prazo: (ms) => { let disparar; const promessa = new Promise((r) => { disparar = r; }); const p = { ms, disparar, cancelado: false }; prazos.push(p); return { promessa, cancelar() { p.cancelado = true; } }; },
    alertar: async (a) => { alertas.push(a); },
  });
  return { ctl, avancar: (ms) => { agora += ms; }, prazos, alertas, chamadas };
}
const assentar = () => new Promise((r) => setImmediate(r));

describe('[AG-A] ativação e desativação', () => {
  teste('AG-A01 — o PADRÃO é desativado: tick não executa nem registra; o objeto padrão é congelado', async () => {
    assert.equal(POLITICA_PADRAO.ativa, false);
    assert.ok(Object.isFrozen(POLITICA_PADRAO) && Object.isFrozen(POLITICA_PADRAO.retencao));
    const m = montar({ politica: { ...POLITICA_PADRAO } });
    let chamou = 0;
    const m2 = montar({ politica: { ...POLITICA_PADRAO }, executar: async () => { chamou += 1; return VALIDO; } });
    assert.deepEqual({ ...(await m2.ctl.tick()) }, { acao: 'NAO_EXECUTADA', motivo: 'AGENDAMENTO_DESATIVADO' });
    assert.equal(chamou, 0);
    assert.equal(m.ctl.historico().length, 0);
  });

  teste('AG-A02 — ativar exige a confirmação exata; depois executa; desativar impede novas execuções SEM interromper a em andamento', async () => {
    let liberar;
    const m = montar({ politica: { ...POLITICA, ativa: false }, executar: () => new Promise((r) => { liberar = () => r(VALIDO); }) });
    for (const ruim of [undefined, {}, { confirmacao: 'sim' }, { confirmacao: CONFIRMACAO_DE_ATIVACAO, extra: 1 }]) assert.throws(() => m.ctl.ativar(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.equal(m.ctl.estado().ativa, false);
    m.ctl.ativar({ confirmacao: CONFIRMACAO_DE_ATIVACAO });
    const t = m.ctl.tick();
    await assentar();
    assert.deepEqual({ ...m.ctl.desativar() }, { desativada: true, execucaoEmAndamento: true });
    liberar();
    assert.equal((await t).acao, 'EXECUTADA', 'a execução em andamento terminou normalmente');
    assert.equal((await m.ctl.tick()).motivo, 'AGENDAMENTO_DESATIVADO');
  });

  teste('AG-A03 — política inválida, relógio/executor ausentes e chaves extras são recusados; a fonte não usa timer, cron, ambiente nem processo', () => {
    const base = { politica: POLITICA, relogio: () => 1, executar: async () => VALIDO, prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), alertar: async () => {} };
    for (const ruim of [{ ...base, politica: { ...POLITICA, ativa: 'sim' } }, { ...base, politica: { ...POLITICA, intervaloMs: 0 } }, { ...base, politica: { ...POLITICA, maxTentativas: 0 } }, { ...base, politica: { ...POLITICA, extra: 1 } }, { ...base, politica: { ...POLITICA, retencao: { manterUltimos: 0, idadeMinimaMs: 1 } } }, { ...base, relogio: null }, { ...base, executar: 'x' }, { ...base, extra: 1 }, null]) assert.throws(() => criarControladorDeExecucao(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'imagem-backup-agendamento.service.js'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//')).join('\n');
    assert.equal(/setInterval|setTimeout|process\.env|child_process|node-cron|require\('(fs|net|http|pg)'\)/.test(codigo), false);
  });
});

describe('[AG-B] frequência, simultaneidade e timeout', () => {
  teste('AG-B01 — frequência: só executa quando devida; sucesso reinicia o intervalo; cada execução tem identidade própria de 128 bits', async () => {
    const m = montar();
    const r1 = await m.ctl.tick();
    assert.equal(r1.acao, 'EXECUTADA');
    assert.match(r1.execucaoId, /^[0-9a-f]{32}$/);
    assert.equal(m.chamadas[0].execucaoId, r1.execucaoId);
    m.avancar(24 * H - 1);
    assert.equal((await m.ctl.tick()).motivo, 'NAO_DEVIDA');
    m.avancar(1);
    const r2 = await m.ctl.tick();
    assert.equal(r2.acao, 'EXECUTADA');
    assert.notEqual(r2.execucaoId, r1.execucaoId);
  });

  teste('AG-B02 — SIMULTÂNEAS: enquanto uma execução roda, outra tick não executa nada (o executor é chamado uma vez)', async () => {
    let n = 0;
    let liberar;
    const m = montar({ executar: () => { n += 1; return new Promise((r) => { liberar = () => r(VALIDO); }); } });
    const t1 = m.ctl.tick();
    await assentar();
    assert.equal((await m.ctl.tick()).motivo, 'EM_ANDAMENTO');
    assert.equal(n, 1);
    liberar();
    assert.equal((await t1).acao, 'EXECUTADA');
  });

  teste('AG-B03 — TIMEOUT: conta como falha, alerta, e a exclusão só cai quando a chamada original TERMINA (sem execução sobreposta)', async () => {
    let liberar;
    let n = 0;
    const m = montar({ executar: () => { n += 1; if (n > 1) return Promise.resolve(VALIDO); return new Promise((r) => { liberar = () => r(VALIDO); }); } });
    const t = m.ctl.tick();
    await assentar();
    assert.equal(m.prazos[0].ms, POLITICA.timeoutMs);
    m.prazos[0].disparar();
    const r = await t;
    assert.deepEqual([r.acao, r.motivo], ['FALHOU', 'TIMEOUT']);
    assert.deepEqual(m.alertas.map((a) => [a.tipo, a.motivo]), [['FALHA_DE_BACKUP', 'TIMEOUT']]);
    m.avancar(H);
    assert.equal((await m.ctl.tick()).motivo, 'EM_ANDAMENTO', 'a chamada original ainda não terminou');
    assert.equal(n, 1);
    liberar();
    await assentar();
    await assentar();
    assert.ok(m.ctl.historico().some((h) => h.evento === 'ENCERRADA_APOS_TIMEOUT'));
    assert.equal(m.ctl.estado().falhasSeguidas, 1, 'um resultado tardio não vira sucesso');
    assert.equal((await m.ctl.tick()).acao, 'EXECUTADA');
  });
});

describe('[AG-C] falha fechada, tentativas e bloqueio', () => {
  teste('AG-C01 — cada resposta que não é um backup válido É falha (exceção, não executado, forma inválida, backup inválido, sem restauração comprovada)', async () => {
    const casos = [
      [async () => { throw new Error('x'); }, 'EXCECAO'],
      [async () => ({ executado: false, motivo: 'PRE_REQUISITOS_AUSENTES' }), 'NAO_EXECUTADO'],
      [async () => 'ok', 'RESPOSTA_INVALIDA'],
      [async () => null, 'RESPOSTA_INVALIDA'],
      [async () => ({ executado: true }), 'RESPOSTA_INVALIDA'],
      [async () => ({ executado: true, estados: { backupOperacionalValido: false, restauracaoComprovada: true } }), 'BACKUP_NAO_VALIDO'],
      [async () => ({ executado: true, estados: { backupOperacionalValido: true, restauracaoComprovada: false } }), 'SEM_VERIFICACAO_DE_RESTAURACAO'],
      [async () => ({ executado: true, estados: { backupOperacionalValido: 'true', restauracaoComprovada: true } }), 'BACKUP_NAO_VALIDO'],
    ];
    for (const [executar, motivo] of casos) {
      const m = montar({ executar });
      const r = await m.ctl.tick();
      assert.deepEqual([r.acao, r.motivo], ['FALHOU', motivo]);
      assert.deepEqual(m.alertas.map((a) => a.motivo), [motivo]);
    }
    const semExigir = montar({ politica: { ...POLITICA, exigirVerificacaoDeRestauracao: false }, executar: async () => ({ executado: true, estados: { backupOperacionalValido: true, restauracaoComprovada: false } }) });
    assert.equal((await semExigir.ctl.tick()).acao, 'EXECUTADA');
  });

  teste('AG-C02 — tentativas repetidas respeitam a espera; ao atingir o limite: BLOQUEADO + alerta; só o reconhecimento humano libera', async () => {
    const m = montar({ executar: async () => { throw new Error('x'); } });
    assert.equal((await m.ctl.tick()).acao, 'FALHOU');
    assert.equal((await m.ctl.tick()).motivo, 'AGUARDANDO_NOVA_TENTATIVA');
    m.avancar(15 * 60000);
    assert.equal((await m.ctl.tick()).acao, 'FALHOU');
    m.avancar(15 * 60000);
    assert.equal((await m.ctl.tick()).acao, 'FALHOU');
    assert.equal(m.ctl.estado().bloqueado, true);
    assert.deepEqual(m.alertas.map((a) => a.tipo), ['FALHA_DE_BACKUP', 'FALHA_DE_BACKUP', 'FALHA_DE_BACKUP', 'AGENDAMENTO_BLOQUEADO']);
    m.avancar(10 * 24 * H);
    assert.equal((await m.ctl.tick()).motivo, 'BLOQUEADO_POR_FALHAS', 'o tempo não desbloqueia');
    assert.equal(m.ctl.reconhecerFalhas(), true);
    assert.equal(m.ctl.estado().bloqueado, false);
  });

  teste('AG-C03 — falha ANTES e DEPOIS da preparação: o controlador só enxerga o resultado da entrada; em ambos os casos conta como falha e nunca como sucesso', async () => {
    const antes = montar({ executar: async () => ({ executado: false, motivo: 'PRE_REQUISITOS_AUSENTES', efeitos: 'NENHUM', estados: {} }) });
    assert.equal((await antes.ctl.tick()).motivo, 'NAO_EXECUTADO');
    const depois = montar({ executar: async () => ({ executado: false, motivo: 'FALHA_NA_EXECUCAO', efeitos: 'PODEM_EXISTIR_PRESERVADOS', estados: {} }) });
    assert.equal((await depois.ctl.tick()).motivo, 'NAO_EXECUTADO');
    assert.equal(depois.ctl.estado().ultimoSucessoEm, null);
  });

  teste('AG-C04 — falha ao ALERTAR não derruba a política: vira evento ALERTA_FALHOU', async () => {
    const ctl = criarControladorDeExecucao({ politica: POLITICA, relogio: () => 5, executar: async () => { throw new Error('x'); }, prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), alertar: async () => { throw new Error('canal fora'); } });
    assert.equal((await ctl.tick()).acao, 'FALHOU');
    assert.ok(ctl.historico().some((h) => h.evento === 'ALERTA_FALHOU'));
  });
});

describe('[AG-D] histórico verificável', () => {
  teste('AG-D01 — o histórico é encadeado por SHA-256, imutável e verificável; o conteúdo dos alertas e eventos só tem códigos', async () => {
    const m = montar();
    m.ctl.ativar({ confirmacao: CONFIRMACAO_DE_ATIVACAO });
    await m.ctl.tick();
    m.ctl.desativar();
    const h = m.ctl.historico();
    assert.deepEqual(h.map((e) => e.evento), ['ATIVADO', 'INICIADA', 'SUCESSO', 'DESATIVADO']);
    let anterior = '0'.repeat(64);
    for (const e of h) {
      const { hashAnterior, hash, ...corpo } = e;
      assert.equal(hashAnterior, anterior);
      assert.equal(hash, crypto.createHash('sha256').update(`${anterior}\n${JSON.stringify(corpo)}`).digest('hex'));
      anterior = hash;
    }
    assert.deepEqual({ ...m.ctl.verificarHistorico() }, { integro: true, primeiraFalha: null });
    assert.throws(() => { h[0].evento = 'X'; }, TypeError);
    assert.throws(() => h.push({}), TypeError);
  });
});

describe('[AG-E] retenção (somente planejamento)', () => {
  const agora = 1_000_000_000_000;
  const pacote = (nome, dias, comprovada = false) => ({ nome, criadoEm: agora - dias * 86400000, restauracaoComprovada: comprovada });

  teste('AG-E01 — nunca expõe como candidato os últimos N, os mais novos que a idade mínima nem a última restauração comprovada', () => {
    const pacotes = [pacote('p1', 1), pacote('p2', 2), pacote('p3', 10, true), pacote('p4', 20), pacote('p5', 30), pacote('p6', 40, true)];
    const plano = planejarRetencao({ pacotes, agora, retencao: { manterUltimos: 2, idadeMinimaMs: 15 * 86400000 } });
    assert.deepEqual([...plano.candidatosAExpurgo], ['p5', 'p4', 'p6'].sort((a, b) => pacotes.find((p) => p.nome === b).criadoEm - pacotes.find((p) => p.nome === a).criadoEm));
    const motivos = Object.fromEntries(plano.manter.map((m) => [m.nome, m.motivo]));
    assert.deepEqual(motivos, { p1: 'ULTIMOS_N', p2: 'ULTIMOS_N', p3: 'IDADE_MINIMA' });
    assert.equal(plano.modo, 'PLANO');
  });

  teste('AG-E02 — a última restauração comprovada é preservada mesmo antiga; relógio inconsistente protege; entradas inválidas recusadas', () => {
    const plano = planejarRetencao({ pacotes: [pacote('novo', 1), pacote('antigo-ok', 90, true), pacote('antigo', 95), { nome: 'futuro', criadoEm: agora + 86400000, restauracaoComprovada: false }], agora, retencao: { manterUltimos: 1, idadeMinimaMs: 7 * 86400000 } });
    assert.deepEqual([...plano.candidatosAExpurgo], ['antigo']);
    assert.ok(plano.manter.some((m) => m.nome === 'antigo-ok' && m.motivo === 'ULTIMA_RESTAURACAO_COMPROVADA'));
    assert.ok(plano.manter.some((m) => m.nome === 'futuro'));
    for (const ruim of [{}, { pacotes: 'x', agora, retencao: POLITICA.retencao }, { pacotes: [pacote('a', 1), pacote('a', 2)], agora, retencao: POLITICA.retencao }, { pacotes: [{ nome: '../x', criadoEm: 1, restauracaoComprovada: false }], agora, retencao: POLITICA.retencao }, { pacotes: [], agora, retencao: { manterUltimos: 0, idadeMinimaMs: 0 } }]) assert.throws(() => planejarRetencao(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.deepEqual([...planejarRetencao({ pacotes: [], agora, retencao: POLITICA.retencao }).candidatosAExpurgo], []);
  });
});
