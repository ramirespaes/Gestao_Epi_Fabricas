'use strict';
// Guardião da exclusão do CD. Sem driver pg e sem banco real: um servidor falso modela advisory locks de SESSÃO (somem
// quando a sessão encerra) e o adquirirExclusao usado é o real do D-ORF-6, com a matriz dele, sem cópia.
const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const ARQ = path.join(__dirname, '..', '..', 'scripts', 'guardiao-de-coordenacao.js');
const G = require(ARQ);
const D = require('../../src/services/backup-fontes-coordenacao-operacoes.service');

const CONF = { host: '127.0.0.1', porta: 5432, banco: 'safework_hml', usuario: 'guardiao', senha: 'segredo-do-guardiao', schema: 'public', tls: {} };
const SISTEMA = '7412345678901234567';
const LIMITES = { conexaoMs: 200, consultaMs: 200, aquisicaoMs: 400, encerramentoMs: 150, vidaMaximaMs: 60000 };
// Espera limitada: uma promessa que nunca resolve vira falha do teste, não travamento.
const noPrazo = (promessa, ms = 2000) => {
  let relogio;
  const prazo = new Promise((_, rejeitar) => { relogio = setTimeout(() => rejeitar(new Error(`sem resposta em ${ms} ms`)), ms); });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
};

// Servidor falso: uma tabela de locks compartilhada entre sessões, como num banco de verdade.
function servidorFalso({ banco = 'safework_hml', sistema = SISTEMA, emRecuperacao = false } = {}) {
  const locks = new Map(); // chave (texto) -> sessão
  let proxima = 1;
  const srv = { locks, configs: [], consultas: [], destruicoes: 0, falharConexao: false, travarConexao: false, travarConsulta: false, falharConsulta: false, sessoes: new Set() };
  srv.Client = class {
    constructor(config) {
      srv.configs.push(config); this.id = proxima++; this.aberta = false; this.ouvintes = {};
      // Como no driver: o soquete da conexão pode ser destruído à força; a sessão cai no servidor.
      if (!srv.semSoquete) this.connection = { stream: { destroy: () => { srv.destruicoes += 1; if (srv.falharDestruicao) throw new Error('falha ao destruir'); this.derrubar(false); } } };
    }
    on(evento, cb) { (this.ouvintes[evento] = this.ouvintes[evento] || []).push(cb); return this; }
    emitir(evento, valor) { for (const cb of this.ouvintes[evento] || []) cb(valor); }
    async connect() {
      if (srv.travarConexao) await new Promise(() => {});
      if (srv.falharConexao) throw new Error('password authentication failed segredo-do-guardiao');
      this.aberta = true; srv.sessoes.add(this);
    }
    async query(sql) {
      srv.consultas.push(sql);
      if (!this.aberta) throw new Error('Connection terminated');
      if (srv.travarConsulta) await new Promise(() => {});
      if (srv.falharConsulta) throw new Error('falha de consulta segredo-do-guardiao');
      if (/current_database\(\)/.test(sql) && /pg_control_system/.test(sql)) return { rows: [{ banco, em_recuperacao: emRecuperacao, sistema }] };
      let m = /^SELECT pg_try_advisory_lock\((\d+)\) AS tomado$/.exec(sql);
      if (m) { const dono = locks.get(m[1]); if (dono !== undefined && dono !== this.id) return { rows: [{ tomado: false }] }; locks.set(m[1], this.id); return { rows: [{ tomado: true }] }; }
      m = /^SELECT pg_advisory_unlock\((\d+)\) AS liberado$/.exec(sql);
      if (m) { const meu = locks.get(m[1]) === this.id; if (meu) locks.delete(m[1]); return { rows: [{ liberado: meu }] }; }
      if (/FROM pg_locks/.test(sql)) return { rows: [...locks].filter(([, dono]) => dono === this.id).map(([chave]) => ({ chave })) };
      throw new Error(`consulta inesperada: ${sql}`);
    }
    async end() { if (srv.travarEncerramento) await new Promise(() => {}); this.derrubar(false); }
    // Encerramento da sessão: o PostgreSQL solta todos os advisory locks dela.
    derrubar(avisar = true) { if (!this.aberta) return; this.aberta = false; srv.sessoes.delete(this); for (const [k, dono] of [...locks]) if (dono === this.id) locks.delete(k); if (avisar) this.emitir('end'); }
  };
  // Outra operação do D-ORF-6 em outra sessão, pelo mesmo adquirirExclusao real.
  srv.outraOperacao = async (operacao) => { const c = new srv.Client({}); await c.connect(); const r = await D.adquirirExclusao({ query: (sql) => c.query(sql) }, { operacao }); return { r, sessao: c }; };
  return srv;
}
const guardiao = (srv, extra = {}) => G.criarGuardiao({ conf: CONF, sistema: SISTEMA, Client: srv.Client, adquirirExclusao: D.adquirirExclusao, cadeadosDe: D.cadeadosDe, limites: LIMITES, ...extra });
const ID1 = '0123456789abcdef0123456789abcdef';
const ID2 = 'fedcba9876543210fedcba9876543210';
const TODAS = [...new Set(Object.values(D.CHAVE_DORF6).map(String))].sort();

describe('guardião: aquisição', () => {
  test('adquire como MIGRACAO pelo adquirirExclusao do D-ORF-6 e segura as quatro chaves numa única sessão dedicada', async () => {
    const srv = servidorFalso();
    const g = guardiao(srv);
    const r = await g.adquirir();
    assert.equal(r.ok, true);
    assert.deepEqual([...r.cadeados].sort(), TODAS);
    assert.deepEqual([...r.cadeados].sort(), D.cadeadosDe('MIGRACAO').map(String).sort());
    assert.deepEqual([...srv.locks.keys()].sort(), TODAS);
    assert.equal(srv.configs.length, 1, 'uma única conexão');
    assert.equal(await g.confirmar(), true);
    await g.liberar();
    assert.equal(srv.locks.size, 0);
    assert.equal(srv.sessoes.size, 0);
  });

  test('identidade do banco e do cluster é conferida ANTES de qualquer lock', async () => {
    const srv = servidorFalso();
    await guardiao(srv).adquirir();
    assert.match(srv.consultas[0], /pg_control_system/);
    assert.match(srv.consultas[1], /pg_try_advisory_lock/);
  });

  test('usa só a credencial recebida, com limites e conexão dedicada', async () => {
    const srv = servidorFalso();
    const g = guardiao(srv);
    await g.adquirir();
    const c = srv.configs[0];
    assert.equal(c.user, 'guardiao');
    assert.equal(c.password, 'segredo-do-guardiao');
    assert.equal(c.database, 'safework_hml');
    assert.equal(c.connectionTimeoutMillis, LIMITES.conexaoMs);
    assert.equal(c.query_timeout, LIMITES.consultaMs);
    assert.equal(c.keepAlive, true);
    await g.liberar();
  });

  for (const [nome, opcoes, motivo] of [
    ['outro banco', { banco: 'homolog_local' }, 'GUARDIAO_IDENTIDADE_DIVERGENTE'],
    ['outro cluster', { sistema: '7499999999999999999' }, 'GUARDIAO_IDENTIDADE_DIVERGENTE'],
    ['cluster ausente', { sistema: null }, 'GUARDIAO_IDENTIDADE_DIVERGENTE'],
    ['réplica em recuperação', { emRecuperacao: true }, 'GUARDIAO_IDENTIDADE_DIVERGENTE'],
  ]) {
    test(`identidade divergente (${nome}): recusa sem tomar lock e encerra a sessão`, async () => {
      const srv = servidorFalso(opcoes);
      const r = await guardiao(srv).adquirir();
      assert.deepEqual(r, { ok: false, motivo });
      assert.equal(srv.consultas.some((q) => /advisory/.test(q)), false);
      assert.equal(srv.locks.size, 0);
      assert.equal(srv.sessoes.size, 0);
    });
  }

  test('identificador esperado fora do formato é recusado antes de conectar', async () => {
    for (const sistema of [undefined, '', 'abc', 123, '0']) {
      const srv = servidorFalso();
      assert.deepEqual(await guardiao(srv, { sistema }).adquirir(), { ok: false, motivo: 'GUARDIAO_CONFIG' });
      assert.equal(srv.configs.length, 0);
    }
  });
});

describe('guardião: a posse tem de ser exatamente a que o D-ORF-6 declara para a operação', () => {
  // adquirirExclusao adulterado: toma os cadeados de verdade e devolve outra lista.
  const adulterado = (trocar) => async (executor, opcoes) => { const r = await D.adquirirExclusao(executor, opcoes); return { ...r, cadeados: trocar([...r.cadeados]) }; };
  for (const [nome, trocar] of [
    ['lista vazia', () => []],
    ['um cadeado a menos', (c) => c.slice(1)],
    ['um cadeado a mais', (c) => [...c, '1']],
    ['mesma quantidade com uma chave diferente', (c) => [...c.slice(1), '1']],
    ['chave repetida no lugar de outra', (c) => [...c.slice(1), c[1]]],
    ['chaves que não são texto', (c) => c.map(Number)],
    ['lista ausente', () => undefined],
    ['algo que não é lista', () => 'x'],
  ]) {
    test(`${nome}: aquisição recusada, sessão encerrada, nenhum cadeado fica e nada é confirmado`, async () => {
      const srv = servidorFalso();
      const g = guardiao(srv, { adquirirExclusao: adulterado(trocar) });
      assert.deepEqual(await g.adquirir(), { ok: false, motivo: 'GUARDIAO_CADEADOS' });
      assert.equal(srv.locks.size, 0);
      assert.equal(srv.sessoes.size, 0);
      assert.equal(await g.confirmar(), false);
    });
  }

  test('contrato do D-ORF-6 vazio, ilegível ou ausente: recusa, sem deduzir a lista por conta própria', async () => {
    for (const cadeadosDe of [() => [], () => { throw new Error('x'); }, () => null]) {
      const srv = servidorFalso();
      const g = guardiao(srv, { cadeadosDe });
      assert.deepEqual(await g.adquirir(), { ok: false, motivo: 'GUARDIAO_CADEADOS' });
      assert.equal(srv.locks.size, 0);
      assert.equal(await g.confirmar(), false);
    }
    const srv = servidorFalso();
    assert.deepEqual(await guardiao(srv, { cadeadosDe: undefined }).adquirir(), { ok: false, motivo: 'GUARDIAO_CONFIG' });
    assert.equal(srv.configs.length, 0, 'nem conecta');
  });

  test('o contrato é consultado para a operação MIGRACAO', async () => {
    const srv = servidorFalso();
    const pedidos = [];
    const g = guardiao(srv, { cadeadosDe: (op) => { pedidos.push(op); return D.cadeadosDe(op); } });
    assert.equal((await g.adquirir()).ok, true);
    assert.deepEqual(pedidos, ['MIGRACAO']);
    await g.liberar();
  });
});

describe('guardião: conflito com as operações do D-ORF-6 (sem fila e sem espera)', () => {
  for (const [operacao, motivo] of [['BACKUP', 'MIGRACAO_EM_CURSO'], ['RESTAURACAO', 'MIGRACAO_EM_CURSO'], ['MIGRACAO', 'MIGRACAO_EM_CURSO'], ['LIMPEZA', 'MIGRACAO_EM_CURSO']]) {
    test(`${operacao} em curso: o guardião é recusado na hora e não deixa lock nem sessão`, async () => {
      const srv = servidorFalso();
      const outra = await srv.outraOperacao(operacao);
      assert.equal(outra.r.ok, true);
      const antes = new Map(srv.locks);
      const inicio = Date.now();
      const r = await guardiao(srv).adquirir();
      assert.equal(r.ok, false);
      assert.equal(r.motivo, motivo);
      assert.ok(Date.now() - inicio < 150, 'sem espera');
      assert.deepEqual(new Map(srv.locks), antes, 'só ficam os locks da outra operação');
      assert.equal(srv.sessoes.size, 1);
      await outra.r.liberar();
      outra.sessao.derrubar(false);
      assert.equal(srv.locks.size, 0);
    });
  }

  test('só a chave própria de outra operação ocupada (sem a de migração): recusa com EM_USO', async () => {
    const srv = servidorFalso();
    const c = new srv.Client({}); await c.connect();
    await c.query(`SELECT pg_try_advisory_lock(${D.CHAVE_DORF6.BACKUP}) AS tomado`);
    const r = await guardiao(srv).adquirir();
    assert.deepEqual({ ok: r.ok, motivo: r.motivo }, { ok: false, motivo: 'EM_USO' });
    assert.equal(srv.locks.size, 1);
    c.derrubar(false);
  });

  for (const operacao of ['BACKUP', 'RESTAURACAO', 'MIGRACAO', 'LIMPEZA']) {
    test(`com o guardião de posse, ${operacao} é recusada; depois da liberação, é aceita`, async () => {
      const srv = servidorFalso();
      const g = guardiao(srv);
      assert.equal((await g.adquirir()).ok, true);
      const durante = await srv.outraOperacao(operacao);
      assert.equal(durante.r.ok, false);
      durante.sessao.derrubar(false);
      await g.liberar();
      const depois = await srv.outraOperacao(operacao);
      assert.equal(depois.r.ok, true);
      await depois.r.liberar(); depois.sessao.derrubar(false);
      assert.equal(srv.locks.size, 0);
    });
  }
});

describe('guardião: falhas, perda e liberação', () => {
  test('erro de conexão, conexão presa e consulta presa: recusa com código, sem lock e sem vazar a mensagem do driver', async () => {
    for (const [ajuste, motivo] of [[{ falharConexao: true }, 'GUARDIAO_CONEXAO'], [{ travarConexao: true }, 'GUARDIAO_TIMEOUT'], [{ travarConsulta: true }, 'GUARDIAO_TIMEOUT'], [{ falharConsulta: true }, 'GUARDIAO_CONSULTA']]) {
      const srv = Object.assign(servidorFalso(), ajuste);
      const r = await guardiao(srv).adquirir();
      assert.deepEqual(r, { ok: false, motivo }, JSON.stringify(ajuste));
      assert.equal(srv.locks.size, 0);
      assert.doesNotMatch(JSON.stringify(r), /segredo/);
    }
  });

  test('perda da conexão: confirmar passa a negar, o aviso de perda dispara e os locks somem com a sessão', async () => {
    const srv = servidorFalso();
    const g = guardiao(srv);
    let perdas = 0;
    g.aoPerder(() => { perdas += 1; });
    await g.adquirir();
    assert.equal(await g.confirmar(), true);
    [...srv.sessoes][0].derrubar();
    assert.equal(perdas, 1);
    assert.equal(await g.confirmar(), false);
    assert.equal(srv.locks.size, 0);
    assert.deepEqual(await g.liberar(), { liberados: 0, sessaoEncerrada: true });
  });

  test('confirmar exige a posse comprovada das quatro chaves, não só a sessão viva', async () => {
    const srv = servidorFalso();
    const g = guardiao(srv);
    await g.adquirir();
    srv.locks.delete(String(D.CHAVE_DORF6.BACKUP));
    assert.equal(await g.confirmar(), false);
    await g.liberar();
    const outro = guardiao(servidorFalso());
    assert.equal(await outro.confirmar(), false, 'sem aquisição não há confirmação');
  });

  test('confirmar com consulta que falha ou não responde: nega', async () => {
    const srv = servidorFalso();
    const g = guardiao(srv);
    await g.adquirir();
    srv.falharConsulta = true;
    assert.equal(await g.confirmar(), false);
    srv.falharConsulta = false; srv.travarConsulta = true;
    assert.equal(await g.confirmar(), false);
  });

  test('liberação idempotente: solta as quatro chaves uma vez e encerra a sessão', async () => {
    const srv = servidorFalso();
    const g = guardiao(srv);
    await g.adquirir();
    assert.deepEqual(await g.liberar(), { liberados: 4, sessaoEncerrada: true });
    assert.deepEqual(await g.liberar(), { liberados: 0, sessaoEncerrada: true });
    assert.equal(await g.confirmar(), false);
    assert.equal(srv.locks.size, 0);
    assert.equal(srv.sessoes.size, 0);
    assert.equal(srv.destruicoes, 0, 'encerramento normal não destrói o soquete');
  });

  test('encerramento do cliente que nunca responde: prazo limitado, soquete destruído e sessão dada como NÃO confirmada', async () => {
    const srv = Object.assign(servidorFalso(), { travarEncerramento: true });
    const g = guardiao(srv);
    await g.adquirir();
    const inicio = Date.now();
    const r = await noPrazo(g.liberar());
    assert.deepEqual(r, { liberados: 4, sessaoEncerrada: false });
    assert.ok(Date.now() - inicio < 1500, 'não espera indefinidamente');
    assert.equal(srv.destruicoes, 1);
    assert.deepEqual(await noPrazo(g.liberar()), { liberados: 0, sessaoEncerrada: false }, 'a repetição não passa a afirmar o encerramento');
    assert.equal(await g.confirmar(), false);
  });

  test('encerramento preso sem soquete para destruir, ou com destruição que falha: termina no prazo, sem exceção e sem confirmar', async () => {
    for (const ajuste of [{ semSoquete: true }, { falharDestruicao: true }]) {
      const srv = Object.assign(servidorFalso(), { travarEncerramento: true }, ajuste);
      const g = guardiao(srv);
      await g.adquirir();
      assert.equal((await noPrazo(g.liberar())).sessaoEncerrada, false, JSON.stringify(ajuste));
    }
  });

  test('recusa na aquisição com encerramento preso: responde no prazo', async () => {
    const srv = Object.assign(servidorFalso({ sistema: '7499999999999999999' }), { travarEncerramento: true });
    assert.deepEqual(await noPrazo(guardiao(srv).adquirir()), { ok: false, motivo: 'GUARDIAO_IDENTIDADE_DIVERGENTE' });
    assert.equal(srv.destruicoes, 1);
  });

  test('segunda aquisição no mesmo guardião é recusada', async () => {
    const srv = servidorFalso();
    const g = guardiao(srv);
    await g.adquirir();
    assert.deepEqual(await g.adquirir(), { ok: false, motivo: 'GUARDIAO_JA_INICIADO' });
    await g.liberar();
  });
});

describe('guardião: linha de comando e canal de controle', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'guardiao-')); });
  const abertos = [];
  // Um teste que falha no meio não pode deixar guardião vivo: fecha o canal e espera o fim, com prazo.
  afterEach(async () => {
    for (const { entrada, fim } of abertos.splice(0)) {
      entrada.end();
      let relogio;
      await Promise.race([fim.catch(() => {}), new Promise((r) => { relogio = setTimeout(r, 2000); })]);
      clearTimeout(relogio);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const credencial = (modo = 0o600) => { const p = path.join(dir, 'credencial.json'); fs.writeFileSync(p, JSON.stringify({ host: CONF.host, porta: CONF.porta, banco: CONF.banco, usuario: CONF.usuario, senha: CONF.senha }), { mode: modo }); fs.chmodSync(p, modo); return p; };
  function iniciar(srv, { argv, limites = LIMITES, adquirirExclusao = D.adquirirExclusao } = {}) {
    const entrada = new PassThrough();
    const eventos = [];
    const esperas = [];
    const saida = (t) => { for (const l of t.split('\n').filter(Boolean)) { eventos.push(JSON.parse(l)); for (const e of esperas.splice(0)) e(); } };
    const fim = G.executar({ argv: argv || ['--credencial', credencial(), '--sistema', SISTEMA], entrada, saida, Client: srv.Client, adquirirExclusao, cadeadosDe: D.cadeadosDe, limites });
    abertos.push({ entrada, fim });
    // Espera limitada: se o evento não chegar no prazo, falha; o temporizador e a espera registrada são sempre desfeitos.
    const proximo = async (n, prazoMs = 3000) => {
      const limite = Date.now() + prazoMs;
      while (eventos.length < n) {
        if (Date.now() >= limite) throw new Error(`evento ${n} não chegou em ${prazoMs} ms (recebidos: ${eventos.length})`);
        let relogio;
        let acordar;
        await new Promise((r) => { acordar = r; esperas.push(r); relogio = setTimeout(r, 20); });
        clearTimeout(relogio);
        const i = esperas.indexOf(acordar);
        if (i !== -1) esperas.splice(i, 1);
      }
      return eventos[n - 1];
    };
    return { entrada, eventos, fim, proximo };
  }

  test('adquire, confirma quantas vezes for pedido e libera por comando: código 0 e nenhum lock', async () => {
    const srv = servidorFalso();
    const p = iniciar(srv);
    assert.deepEqual(await p.proximo(1), { evento: 'ADQUIRIDA', cadeados: TODAS.length });
    p.entrada.write(`confirmar ${ID1}\n`);
    assert.deepEqual(await p.proximo(2), { evento: 'CONFIRMADA', id: ID1 });
    p.entrada.write(`confirmar ${ID2}\n`);
    assert.deepEqual(await p.proximo(3), { evento: 'CONFIRMADA', id: ID2 });
    assert.equal(srv.locks.size, 4);
    p.entrada.write('liberar\n');
    assert.equal(await p.fim, 0);
    assert.deepEqual(p.eventos.at(-1), { evento: 'LIBERADA' });
    assert.equal(srv.locks.size, 0);
    assert.equal(srv.sessoes.size, 0);
  });

  test('canal de controle fechado (agente morreu): libera e encerra', async () => {
    const srv = servidorFalso();
    const p = iniciar(srv);
    await p.proximo(1);
    p.entrada.end();
    assert.equal(await p.fim, 0);
    assert.deepEqual(p.eventos.at(-1), { evento: 'CANAL_FECHADO' });
    assert.equal(srv.locks.size, 0);
    assert.equal(srv.sessoes.size, 0);
  });

  test('prazo máximo atingido: libera e encerra com código próprio', async () => {
    const srv = servidorFalso();
    const p = iniciar(srv, { limites: { ...LIMITES, vidaMaximaMs: 60 } });
    await p.proximo(1);
    assert.equal(await p.fim, 6);
    assert.deepEqual(p.eventos.at(-1), { evento: 'EXPIRADA' });
    assert.equal(srv.locks.size, 0);
  });

  test('conexão perdida: avisa PERDIDA sem esperar pergunta e encerra', async () => {
    const srv = servidorFalso();
    const p = iniciar(srv);
    await p.proximo(1);
    [...srv.sessoes][0].derrubar();
    assert.equal(await p.fim, 5);
    assert.deepEqual(p.eventos.at(-1), { evento: 'PERDIDA' });
    assert.equal(srv.locks.size, 0);
  });

  test('posse perdida descoberta na confirmação: responde PERDIDA, nunca CONFIRMADA', async () => {
    const srv = servidorFalso();
    const p = iniciar(srv);
    await p.proximo(1);
    srv.locks.delete(String(D.CHAVE_DORF6.RESTAURACAO));
    p.entrada.write(`confirmar ${ID1}\n`);
    assert.equal(await p.fim, 5);
    assert.equal(p.eventos.some((e) => e.evento === 'CONFIRMADA'), false);
    assert.equal(srv.locks.size, 0);
  });

  test('várias perguntas seguidas: cada resposta devolve o identificador da própria pergunta, na ordem', async () => {
    const srv = servidorFalso();
    const p = iniciar(srv);
    await p.proximo(1);
    p.entrada.write(`confirmar ${ID1}\nconfirmar ${ID2}\nconfirmar ${ID1}\n`);
    await p.proximo(4);
    assert.deepEqual(p.eventos.slice(1), [{ evento: 'CONFIRMADA', id: ID1 }, { evento: 'CONFIRMADA', id: ID2 }, { evento: 'CONFIRMADA', id: ID1 }]);
    p.entrada.write('liberar\n');
    assert.equal(await p.fim, 0);
  });

  for (const linha of ['confirmar', 'confirmar ', 'confirmar abc', `confirmar ${ID1.toUpperCase()}`, `confirmar ${ID1}0`, `confirmar ${ID1} ${ID2}`, ` confirmar ${ID1}`, `confirmar  ${ID1}`]) {
    test(`pergunta sem identificador válido (${JSON.stringify(linha)}): encerra por protocolo, sem confirmar`, async () => {
      const srv = servidorFalso();
      const p = iniciar(srv);
      await p.proximo(1);
      p.entrada.write(`${linha}\n`);
      assert.equal(await p.fim, 7);
      assert.equal(p.eventos.some((e) => e.evento === 'CONFIRMADA'), false);
      assert.deepEqual(p.eventos.at(-1), { evento: 'PROTOCOLO' });
      assert.equal(srv.locks.size, 0);
    });
  }

  for (const [nome, encerrar, proibido] of [
    ['pedido de liberação', (p) => p.entrada.write('liberar\n'), 'LIBERADA'],
    ['canal de controle fechado', (p) => p.entrada.end(), 'CANAL_FECHADO'],
    ['comando desconhecido', (p) => p.entrada.write('x\n'), 'PROTOCOLO'],
  ]) {
    test(`${nome} com encerramento do cliente preso: o processo termina no prazo com SESSAO_INCERTA, sem afirmar ${proibido}`, async () => {
      const srv = Object.assign(servidorFalso(), { travarEncerramento: true });
      const p = iniciar(srv);
      await p.proximo(1);
      encerrar(p);
      assert.equal(await noPrazo(p.fim), 8);
      assert.deepEqual(p.eventos.at(-1), { evento: 'SESSAO_INCERTA' });
      assert.equal(p.eventos.some((e) => e.evento === proibido), false);
      assert.equal(srv.destruicoes, 1);
    });
  }

  test('prazo máximo com encerramento do cliente preso: também termina, com SESSAO_INCERTA', async () => {
    const srv = Object.assign(servidorFalso(), { travarEncerramento: true });
    const p = iniciar(srv, { limites: { ...LIMITES, vidaMaximaMs: 60 } });
    await p.proximo(1);
    assert.equal(await noPrazo(p.fim), 8);
    assert.deepEqual(p.eventos.at(-1), { evento: 'SESSAO_INCERTA' });
  });

  test('aquisição sem cadeados sai como recusa com código próprio, sem lock e sem sessão', async () => {
    const srv = servidorFalso();
    const vazio = async (executor, opcoes) => ({ ...(await D.adquirirExclusao(executor, opcoes)), cadeados: [] });
    const p = iniciar(srv, { adquirirExclusao: vazio });
    assert.equal(await p.fim, 4);
    assert.deepEqual(p.eventos, [{ evento: 'RECUSADA', motivo: 'GUARDIAO_CADEADOS' }]);
    assert.equal(srv.locks.size, 0);
    assert.equal(srv.sessoes.size, 0);
  });

  test('comando desconhecido no canal: encerra liberando', async () => {
    const srv = servidorFalso();
    const p = iniciar(srv);
    await p.proximo(1);
    p.entrada.write('qualquer coisa\n');
    assert.equal(await p.fim, 7);
    assert.equal(srv.locks.size, 0);
  });

  test('recusas: operação concorrente, uso incorreto, credencial insegura e identidade divergente saem com código, sem senha', async () => {
    const ocupado = servidorFalso();
    const outra = await ocupado.outraOperacao('BACKUP');
    const casos = [
      [ocupado, undefined, { evento: 'RECUSADA', motivo: 'MIGRACAO_EM_CURSO' }],
      [servidorFalso(), [], { evento: 'RECUSADA', motivo: 'GUARDIAO_USO' }],
      [servidorFalso(), ['--credencial', credencial(), '--sistema', 'abc'], { evento: 'RECUSADA', motivo: 'GUARDIAO_USO' }],
      [servidorFalso(), ['--credencial', path.join(dir, 'nao-existe.json'), '--sistema', SISTEMA], { evento: 'RECUSADA', motivo: 'GUARDIAO_CREDENCIAL' }],
      [servidorFalso({ sistema: '7499999999999999999' }), undefined, { evento: 'RECUSADA', motivo: 'GUARDIAO_IDENTIDADE_DIVERGENTE' }],
    ];
    for (const [srv, argv, esperado] of casos) {
      const p = iniciar(srv, { argv });
      assert.equal(await p.fim, 4);
      assert.deepEqual(p.eventos, [esperado]);
      assert.doesNotMatch(JSON.stringify(p.eventos), /segredo|guardiao"|127\.0\.0\.1/);
    }
    const inseguro = iniciar(servidorFalso(), { argv: ['--credencial', credencial(0o644), '--sistema', SISTEMA] });
    assert.equal(await inseguro.fim, 4);
    assert.deepEqual(inseguro.eventos, [{ evento: 'RECUSADA', motivo: 'GUARDIAO_CREDENCIAL' }]);
    await outra.r.liberar(); outra.sessao.derrubar(false);
  });
});

describe('guardião: invariantes do código', () => {
  const fonte = fs.readFileSync(ARQ, 'utf8');
  test('não redefine a matriz nem as chaves do D-ORF-6 e só pede a operação MIGRACAO', () => {
    assert.doesNotMatch(fonte, /7241865325823|INCOMPATIBILIDADES|pg_try_advisory_lock|pg_advisory_unlock|pg_advisory_lock/);
    assert.match(fonte, /backup-fontes-coordenacao-operacoes\.service/);
    assert.deepEqual([...fonte.matchAll(/operacao: ([A-Z_']+)/g)].map((m) => m[1]), ['OPERACAO']);
    assert.match(fonte, /const OPERACAO = 'MIGRACAO';/);
  });
  test('não lê variáveis de ambiente, não escreve em tabelas e não aplica migrations', () => {
    assert.doesNotMatch(fonte, /process\.env|dotenv|aplicarMigrations|node-pg-migrate/);
    assert.doesNotMatch(fonte, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY)\b\s+(?:INTO|TABLE|FROM|ON|[a-z_"]+\s+SET)/i);
  });
});
