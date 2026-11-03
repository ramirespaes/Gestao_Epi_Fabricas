'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarSnapshot } = require('../../src/services/imagem-backup-snapshot.service');
const { criarLancadorEstruturalComSpawn } = require('../../src/services/imagem-backup-estrutura-lancador.service');
const { criarLeitorDeSumario } = require('../../src/services/backup-fontes-postgres-sumario.service');

/** D-ORF-6, P6 — os dois ganchos ADITIVOS nos módulos históricos: `lerAdicionais` no snapshot (mesma conexão/transação) e `aoDado` no lançador estrutural (fluxo bruto do stdout). Sem PostgreSQL nem processo real. */

function clienteFalso({ aoConsultar } = {}) {
  const ouvintes = {};
  const consultas = [];
  return {
    consultas,
    on(evento, fn) { ouvintes[evento] = fn; },
    async connect() {},
    async end() {},
    async query(sql) {
      consultas.push(sql);
      if (aoConsultar) aoConsultar(sql, consultas.length);
      if (/pg_export_snapshot/.test(sql)) return { rows: [{ snapshot_id: '00000003-00000002-1' }] };
      if (/current_database\(\) AS nome/.test(sql)) return { rows: [{ nome: 'gepi_sint', oid: '16384' }] };
      return { rows: [] };
    },
  };
}
const temporizador = { prazo: (ms) => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => ({ cancelar() {} }) };

describe('[GS] snapshot: leitura adicional no mesmo snapshot', () => {
  test('GS-01 — lerAdicionais roda DEPOIS das leituras de imagens, no MESMO cliente, dentro da transação, e seu resultado congelado vai em contexto.adicionais; sem a opção, adicionais é null', async () => {
    let clienteUsado = null;
    let ordemDaChamada = null;
    const cliente = clienteFalso();
    const snapshot = criarSnapshot({
      criarConexao: async () => cliente, temporizador, prazos: { finalizacaoMs: 1000 },
      lerAdicionais: async (executor) => { clienteUsado = executor; ordemDaChamada = cliente.consultas.length; await executor.query('SELECT 1 AS adicional'); return { planos: { imagens: { plano: [] } }, inventario: { relacoes: [] } }; },
    });
    const r = await snapshot.abrir();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(clienteUsado, cliente, 'o executor entregue é o próprio cliente dedicado da transação');
    assert.ok(ordemDaChamada >= 4, 'BEGIN, export, identidade e leituras de imagens vieram antes');
    assert.equal(cliente.consultas[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.ok(cliente.consultas.includes('SELECT 1 AS adicional'));
    assert.ok(!cliente.consultas.some((s) => /ROLLBACK|COMMIT/.test(s)), 'nenhum encerramento antes de finalizar');
    assert.deepEqual(r.contexto.adicionais, { planos: { imagens: { plano: [] } }, inventario: { relacoes: [] } });
    assert.ok(Object.isFrozen(r.contexto.adicionais));
    assert.equal((await snapshot.finalizar()).concluida, true);
    const sem = criarSnapshot({ criarConexao: async () => clienteFalso(), temporizador, prazos: { finalizacaoMs: 1000 } });
    const r2 = await sem.abrir();
    assert.equal(r2.contexto.adicionais, undefined, 'sem a opção o contexto histórico não muda de forma');
    assert.deepEqual(Object.keys(r2.contexto), ['snapshotId', 'banco', 'registros', 'plano']);
    await sem.finalizar();
  });

  test('GS-02 — falha fechada: exceção na leitura adicional = CONSULTA_FALHOU (sem ok publicado); resultado não-objeto = CONSULTA_INVALIDA; opção inválida = TypeError', async () => {
    const falha = criarSnapshot({ criarConexao: async () => clienteFalso(), temporizador, prazos: { finalizacaoMs: 1000 }, lerAdicionais: async () => { throw Object.assign(new Error('segredo'), { code: '42P01' }); } });
    const r = await falha.abrir();
    assert.deepEqual(r, { ok: false, motivo: 'CONSULTA_FALHOU', codigo: '42P01' });
    assert.equal((await falha.finalizar()).concluida, true);
    const invalido = criarSnapshot({ criarConexao: async () => clienteFalso(), temporizador, prazos: { finalizacaoMs: 1000 }, lerAdicionais: async () => 'texto' });
    assert.deepEqual(await invalido.abrir(), { ok: false, motivo: 'CONSULTA_INVALIDA' });
    await invalido.finalizar();
    assert.throws(() => criarSnapshot({ criarConexao: async () => clienteFalso(), temporizador, prazos: { finalizacaoMs: 1000 }, lerAdicionais: 'x' }), TypeError);
  });
});

describe('[GL] lançador estrutural: observador do stdout', () => {
  const SUMARIO = ';     TOC Entries: 2\n;     Format: CUSTOM\n;     dbname: banco_secreto\n1; 1259 1 TABLE public empresas d\n2; 0 1 TABLE DATA public empresas d\n';
  function spawnFalso(texto) {
    return () => {
      const filho = new EventEmitter();
      filho.pid = 4242;
      filho.stdout = new EventEmitter();
      setImmediate(() => {
        filho.emit('spawn');
        setImmediate(() => {
          for (let i = 0; i < texto.length; i += 7) filho.stdout.emit('data', Buffer.from(texto.slice(i, i + 7), 'latin1'));
          filho.emit('exit', 0, null);
          setImmediate(() => filho.emit('close', 0, null));
        });
      });
      return filho;
    };
  }
  const spec = (fd) => ({ executavel: '/usr/bin/pg_restore', argumentos: ['--list'], ambiente: {}, opcoes: { shell: false, detached: true, stdio: [fd, 'pipe', 'ignore'] } });

  test('GL-01 — aoDado recebe TODOS os blocos (cópias) e alimenta o leitor do P4 em fluxo; a captura restrita de 64 KiB e o `resultado` continuam iguais; sem aoDado nada muda', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-gl-'));
    const fd = fs.openSync(path.join(dir, 'entrada'), 'w+');
    try {
      const leitor = criarLeitorDeSumario();
      const blocos = [];
      const lancador = criarLancadorEstruturalComSpawn({ spawn: spawnFalso(SUMARIO), aoDado: (b) => { blocos.push(b); leitor.alimentar(b); } });
      const p = await lancador.lancar(spec(fd));
      await p.fluxosFechados;
      assert.deepEqual(await p.resultado, { formato: 'CUSTOM', entradas: 2, truncado: false });
      assert.equal(Buffer.concat(blocos).toString('latin1'), SUMARIO);
      const sumario = leitor.concluir();
      assert.equal(sumario.ok, true, JSON.stringify(sumario.motivos));
      assert.deepEqual(sumario.contagem.porTipo, { TABLE: 1, 'TABLE DATA': 1 });
      assert.ok(!JSON.stringify(sumario).includes('banco_secreto'));
      const sem = criarLancadorEstruturalComSpawn({ spawn: spawnFalso(SUMARIO) });
      const q = await sem.lancar(spec(fd));
      await q.fluxosFechados;
      assert.deepEqual(await q.resultado, { formato: 'CUSTOM', entradas: 2, truncado: false });
    } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('GL-02 — observador que lança não afeta captura nem término; observador inválido é TypeError', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-gl-'));
    const fd = fs.openSync(path.join(dir, 'entrada'), 'w+');
    try {
      const lancador = criarLancadorEstruturalComSpawn({ spawn: spawnFalso(SUMARIO), aoDado: () => { throw new Error('observador quebrado'); } });
      const p = await lancador.lancar(spec(fd));
      assert.deepEqual(await p.saida, { codigo: 0, sinal: null });
      await p.fluxosFechados;
      assert.deepEqual(await p.resultado, { formato: 'CUSTOM', entradas: 2, truncado: false });
      assert.throws(() => criarLancadorEstruturalComSpawn({ spawn: spawnFalso(SUMARIO), aoDado: 'x' }), TypeError);
    } finally { fs.closeSync(fd); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
