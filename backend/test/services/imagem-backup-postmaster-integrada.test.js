'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6): CICLO DE VIDA SUPERVISIONADO DO POSTGRESQL EFÊMERO com PROCESSOS SINTÉTICOS REAIS. Sentinela real do postmaster (`src/workers/imagem-backup-postmaster.worker.js`), canal IPC real, diário durável real, `ps` e `postmaster.pid` reais lidos pela identidade, e um
 * "runner" sintético descartável (`test/helpers/runner-sintetico-postmaster.js`) que em alguns modos MORRE de forma abrupta (SIGKILL de si mesmo). O "PostgreSQL" é um processo Node trivial (`test/helpers/postgres-sintetico.js`): NÃO há PostgreSQL, pg_dump, pg_restore, socket nem porta reais.
 *
 * SINAIS REAIS: só atingem processos criados por esta suíte (o runner sintético, as sentinelas, os postmasters e clientes sintéticos e os chamarizes), identificados por esta própria execução. A suíte confere que os CHAMARIZES (mesmo executável, mesma linha de comando com o MESMO -D e mesmo dono que o
 * postmaster) continuam vivos depois de cada cenário. Tudo o que esta suíte cria é encerrado em `after` (SIGKILL só aos pids que ELA registrou), com evidência do encerramento. Os prazos do desligamento são encurtados (milissegundos) só aqui; os de produção são 30 s e 15 s.
 */

const RAIZ_BACKEND = path.join(__dirname, '..', '..');
const HELPER = path.join(RAIZ_BACKEND, 'test/helpers/runner-sintetico-postmaster.js');
const PG_SINTETICO = path.join(RAIZ_BACKEND, 'test/helpers/postgres-sintetico.js');
const diario = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-diario-execucao.service'));
const { supervisionar } = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-supervisor.service'));

const PRAZOS = Object.freeze({ sigintMs: 800, sigquitMs: 800, esperaClientesMs: 4000, passoClientesMs: 100 });
const CLIENTE_RESISTENTE = (pronto) => `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pronto)}, 'ok'); setInterval(() => {}, 1000);`;

let base;
const criados = new Set(); // pids de processos criados POR ESTA SUÍTE (únicos alvos de qualquer sinal real)
const registrar = (pid) => { if (Number.isSafeInteger(pid) && pid > 1) criados.add(pid); return pid; };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const vivo = async (pid) => (await diario.observarProcessoReal(pid)) === 'VIVO';
let contador = 0;

async function esperarAte(condicao, rotulo, prazoMs = 20000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) { if (await condicao()) return; await esperar(25); }
  throw new Error(`condição não atendida: ${rotulo}`);
}

before(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'))); fs.chmodSync(base, 0o700); });
after(async () => {
  // netos sintéticos deixados por cenários (pid em <pgdata>/neto.pid) e todos os pids registrados: SIGKILL só ao que a suíte criou
  for (const dir of fs.readdirSync(base)) {
    try { registrar(Number(fs.readFileSync(path.join(base, dir, 'pgdata', 'neto.pid'), 'utf8'))); } catch { /* sem neto */ }
  }
  for (const pid of criados) { try { process.kill(pid, 'SIGKILL'); } catch { /* já encerrado */ } }
  await esperar(300);
  for (const pid of criados) assert.equal(await vivo(pid), false, `sobrou processo criado pela suíte: ${pid}`);
  fs.rmSync(base, { recursive: true, force: true });
});

/** Um cenário = uma pasta privada (estado do diário, área, pgdata, log). */
function novoCenario() {
  contador += 1;
  const dir = path.join(base, `c${contador}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const raiz = path.join(dir, 'estado');
  const area = path.join(dir, 'area');
  const pgdata = path.join(dir, 'pgdata');
  const socket = path.join(dir, 's');
  for (const d of [raiz, area, pgdata, socket]) fs.mkdirSync(d, { mode: 0o700 });
  return { dir, raiz, area, pgdata, socket, porta: 55000 + contador, tentativaId: `t-${String(contador).padStart(4, '0')}`, logArquivo: path.join(dir, 'postgres.log') };
}

function rodarRunner(cfg) {
  const filho = spawn(process.execPath, [HELPER, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  registrar(filho.pid);
  const eventos = [];
  let resto = '';
  filho.stdout.on('data', (b) => {
    resto += b.toString('utf8');
    let i;
    while ((i = resto.indexOf('\n')) >= 0) { const linha = resto.slice(0, i); resto = resto.slice(i + 1); if (linha.trim() !== '') { const e = JSON.parse(linha); eventos.push(e); registrar(e.sentinelaPid); registrar(e.postmasterPid); registrar(e.clientePid); } }
  });
  let erro = '';
  filho.stderr.on('data', (b) => { erro += b.toString('utf8'); });
  const termino = new Promise((resolver) => { filho.on('exit', (codigo, sinal) => resolver({ codigo, sinal })); });
  const aguardarEvento = async (nome, prazoMs = 20000) => {
    const limite = Date.now() + prazoMs;
    while (Date.now() < limite) { const e = eventos.find((x) => x.e === nome); if (e !== undefined) return e; await esperar(20); }
    throw new Error(`evento não chegou: ${nome} (stderr=${erro.slice(0, 300)})`);
  };
  return { filho, eventos, termino, aguardarEvento, stderr: () => erro };
}

const configBase = (c, extra = {}) => ({ raiz: c.raiz, tentativaId: c.tentativaId, area: c.area, pgdata: c.pgdata, socket: c.socket, porta: c.porta, logArquivo: c.logArquivo, prazos: PRAZOS, pg: {}, ...extra });
const lerEscritores = (c) => diario.lerTentativa({ raiz: c.raiz, tentativaId: c.tentativaId }).escritores;
const eventosDe = (c) => Object.entries(lerEscritores(c)).flatMap(([nome, e]) => e.eventos.map((ev) => ({ ...ev, escritor: nome })));
const doPostmaster = (c) => {
  const todos = eventosDe(c);
  const id = todos.find((e) => e.k === 'INTENCAO_LANCAMENTO' && e.d.papel === 'postgres').d.lancamentoId;
  return todos.filter((e) => e.d.lancamentoId === id);
};
const reconciliar = (c) => diario.reconciliar({ raiz: c.raiz, tentativaId: c.tentativaId, observarProcesso: diario.observarProcessoReal });
const quando = (e) => Date.parse(e.t);
function registrarPidsDoDiario(c) {
  for (const e of eventosDe(c)) for (const campo of ['runnerPid', 'sentinelaPid', 'clientePid', 'pid']) registrar(e.d[campo]);
}

/** Chamariz: OUTRO "postgres" semelhante (mesmo executável, mesmo -D, mesmo dono), criado pela suíte e nunca lançado pela sentinela. */
function criarChamariz(c) {
  const pronto = path.join(c.dir, 'chamariz-pronto');
  const f = spawn(process.execPath, [PG_SINTETICO, '-D', c.pgdata, '-c', `port=${c.porta}`], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin', PG_SINTETICO: JSON.stringify({ chamariz: true, prontoArquivo: pronto }) } });
  registrar(f.pid);
  return { pid: f.pid, pronto: async () => esperarAte(() => fs.existsSync(pronto), 'chamariz pronto') };
}

async function todosMortos(pids, rotulo) {
  await esperarAte(async () => { for (const pid of pids) if (await vivo(pid)) return false; return true; }, rotulo);
}

describe('[PMI-INT] ciclo de vida normal e chamariz externo', () => {
  test('INT-01 — (cenário 1) o postmaster sintético nasce pela sentinela, é identificado, atende e é ENCERRADO por SIGINT: ENCERRADA, sinais [SIGINT], saída 0, grupo vazio, neto morto; reconciliação CONCLUIDA; o chamariz com o MESMO -D segue vivo', async () => {
    const c = novoCenario();
    const chamariz = criarChamariz(c);
    await chamariz.pronto();
    const r = rodarRunner(configBase(c, { modo: 'encerrar', travas: true, pg: { neto: true } }));
    const pg = await r.aguardarEvento('PG');
    await esperarAte(() => fs.existsSync(path.join(c.pgdata, 'postmaster.pid')), 'o postmaster sintético escreveu a própria identidade');
    const fim = await r.aguardarEvento('ENCERRADO');
    assert.deepEqual({ resultado: fim.resultado, sinais: fim.sinais, falhas: fim.falhas }, { resultado: 'ENCERRADA', sinais: ['SIGINT'], falhas: [] });
    assert.deepEqual(await r.termino, { codigo: 0, sinal: null });
    assert.equal(await vivo(pg.postmasterPid), false);
    assert.equal(await vivo(Number(fs.readFileSync(path.join(c.pgdata, 'neto.pid'), 'utf8'))), false, 'o descendente do mesmo grupo morreu com o postmaster');
    const ev = doPostmaster(c);
    assert.deepEqual(ev.filter((e) => e.k === 'SINAL_ENVIADO').map((e) => [e.d.sinal, e.d.aceito]), [['SIGINT', true]]);
    const encerrado = ev.find((e) => e.k === 'CLIENTE_ENCERRADO');
    assert.deepEqual({ codigo: encerrado.d.codigo, sinal: encerrado.d.sinal }, { codigo: 0, sinal: null });
    assert.equal(ev.find((e) => e.k === 'GRUPO_VERIFICADO').d.vazio, true);
    assert.equal(ev.at(-1).d.resultado, 'CONCLUIDO');
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'CONCLUIDA', JSON.stringify(rec.motivos));
    assert.equal(await vivo(chamariz.pid), true, 'o chamariz com o mesmo -D e o mesmo dono NÃO foi tocado');
    assert.equal(fs.existsSync(c.logArquivo), true, 'o log do servidor é o descritor que o runner entregou');
  });

  test('INT-02 — (cenário 9) postmaster.pid apontando para um chamariz (PostgreSQL externo semelhante): a identidade NÃO se comprova, NENHUM sinal sai e AMBOS os processos continuam vivos', async () => {
    const c = novoCenario();
    const chamariz = criarChamariz(c);
    await chamariz.pronto();
    const r = rodarRunner(configBase(c, { modo: 'encerrar', travas: true, pg: { pidArquivo: chamariz.pid } }));
    const pg = await r.aguardarEvento('PG');
    const fim = await r.aguardarEvento('ENCERRADO');
    assert.equal(fim.resultado, 'IDENTIDADE_INCERTA');
    assert.deepEqual(fim.sinais, []);
    await esperar(1500); // mais que SIGINT + SIGQUIT juntos: nada pode ter chegado a ninguém
    assert.equal(await vivo(pg.postmasterPid), true, 'o postmaster legítimo não foi sinalizado sem identidade comprovada');
    assert.equal(await vivo(chamariz.pid), true, 'o processo externo semelhante foi preservado');
    const ev = doPostmaster(c);
    assert.equal(ev.filter((e) => e.k === 'SINAL_ENVIADO').length, 0);
    const naoComprovada = ev.find((e) => e.k === 'IDENTIDADE_NAO_COMPROVADA');
    assert.deepEqual({ fase: naoComprovada.d.fase, motivo: naoComprovada.d.motivo }, { fase: 'SIGINT', motivo: 'POSTMASTER_PID_DIVERGENTE' });
    assert.equal(ev.at(-1).d.resultado, 'IDENTIDADE_INCERTA');
  });

  test('INT-03 — (cenário 8) identidade do postmaster diverge da tentativa (postmaster.pid com outro PGDATA): nenhum sinal, IDENTIDADE_INCERTA, reconciliação INCONCLUSIVA e a tentativa fica bloqueada', async () => {
    const c = novoCenario();
    const r = rodarRunner(configBase(c, { modo: 'encerrar', travas: true, pg: { pidArquivo: 'pgdata-errado' } }));
    const pg = await r.aguardarEvento('PG');
    const fim = await r.aguardarEvento('ENCERRADO');
    assert.equal(fim.resultado, 'IDENTIDADE_INCERTA');
    assert.deepEqual(fim.sinais, []);
    assert.equal(await vivo(pg.postmasterPid), true, 'sem identidade o postmaster é PRESERVADO (a decisão passa a ser humana)');
    const motivo = doPostmaster(c).find((e) => e.k === 'IDENTIDADE_NAO_COMPROVADA').d.motivo;
    assert.equal(motivo, 'POSTMASTER_PGDATA_DIVERGENTE');
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'INCONCLUSIVA');
    assert.ok(rec.motivos.includes('POSTGRES_ENCERRAMENTO_NAO_COMPROVADO'));
    assert.equal(rec.liberaNovaTentativa, false);
    const a = await diario.avaliarNovaTentativa({ raiz: c.raiz, observarProcesso: diario.observarProcessoReal });
    assert.equal(a.liberada, false);
  });
});

describe('[PMI-INT] morte do runner', () => {
  let resultado = null;
  async function cenarioRunnerMorto() {
    if (resultado !== null) return resultado;
    const c = novoCenario();
    const chamariz = criarChamariz(c);
    await chamariz.pronto();
    const pronto = path.join(c.dir, 'cliente-pronto');
    const r = rodarRunner(configBase(c, { modo: 'morrer-apos-identidade', travas: true, comCliente: true, clientePronto: pronto, clienteScript: CLIENTE_RESISTENTE(pronto), pg: { neto: true } }));
    const pg = await r.aguardarEvento('PG');
    const cliente = await r.aguardarEvento('CLIENTE');
    const fimRunner = await r.termino;
    registrarPidsDoDiario(c);
    resultado = { c, pg, cliente, fimRunner, chamariz, r };
    await todosMortos([pg.postmasterPid, cliente.clientePid, pg.sentinelaPid], 'postmaster, cliente e sentinela do postmaster encerrados sem o runner');
    return resultado;
  }

  test('INT-04 — (cenário 2) o runner MORRE (SIGKILL) com cliente e postmaster ativos: a sentinela do cliente encerra o cliente e a do postmaster encerra o postmaster POR SIGINT; os dois somem; nenhum SIGKILL/SIGTERM no postmaster', async () => {
    const { c, pg, cliente, fimRunner, chamariz } = await cenarioRunnerMorto();
    assert.equal(fimRunner.sinal, 'SIGKILL');
    assert.equal(await vivo(pg.postmasterPid), false);
    assert.equal(await vivo(cliente.clientePid), false);
    const ev = doPostmaster(c);
    assert.ok(ev.some((e) => e.k === 'ORFANDADE_DETECTADA'));
    assert.deepEqual(ev.filter((e) => e.k === 'SINAL_ENVIADO').map((e) => e.d.sinal), ['SIGINT']);
    assert.equal(ev.at(-1).d.resultado, 'CONCLUIDO');
    assert.equal(await vivo(chamariz.pid), true, 'processo externo semelhante preservado');
  });

  test('INT-05 — (cenários 2 e 3) ORDEM: o postmaster espera o cliente; o cliente (que ignora SIGTERM) só termina por SIGKILL da sentinela dele e SÓ DEPOIS o postmaster recebe SIGINT', async () => {
    const { c } = await cenarioRunnerMorto();
    const todos = eventosDe(c);
    const idPg = todos.find((e) => e.k === 'INTENCAO_LANCAMENTO' && e.d.papel === 'postgres').d.lancamentoId;
    const idCliente = todos.find((e) => e.k === 'INTENCAO_LANCAMENTO' && e.d.papel !== 'postgres').d.lancamentoId;
    const clienteFim = todos.find((e) => e.k === 'SENTINELA_FIM' && e.d.lancamentoId === idCliente);
    const ordem = todos.find((e) => e.k === 'POSTMASTER_ORDEM' && e.d.lancamentoId === idPg);
    const sigint = todos.find((e) => e.k === 'SINAL_ENVIADO' && e.d.lancamentoId === idPg && e.d.sinal === 'SIGINT');
    const orfa = todos.find((e) => e.k === 'ORFANDADE_DETECTADA' && e.d.lancamentoId === idPg);
    assert.equal(ordem.d.clientes, 'NENHUM');
    assert.ok(quando(clienteFim) <= quando(ordem), 'o fim da sentinela do cliente precede a ordem do postmaster');
    assert.ok(quando(ordem) <= quando(sigint), 'a ordem precede o SIGINT');
    assert.ok(quando(ordem) - quando(orfa) >= 200, `o postmaster esperou o cliente (esperou ${quando(ordem) - quando(orfa)} ms)`);
    const sinaisDoCliente = todos.filter((e) => e.k === 'SINAL_ENVIADO' && e.d.lancamentoId === idCliente).map((e) => e.d.sinal);
    assert.deepEqual(sinaisDoCliente, ['SIGTERM', 'SIGKILL'], 'o cliente mantém a escalada própria; o postmaster NÃO herdou SIGTERM/SIGKILL');
  });

  test('INT-06 — a reconciliação depois da morte do runner e do desfecho limpo da supervisão: CONCLUIDA (processos e recursos), sem POSTGRES_SEM_AUTORIDADE', async () => {
    const { c } = await cenarioRunnerMorto();
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'CONCLUIDA', JSON.stringify([rec.motivos, rec.lancamentos]));
    assert.ok(!rec.motivos.includes('POSTGRES_SEM_AUTORIDADE'));
    assert.equal(rec.escopo, 'PROCESSOS_E_RECURSOS');
    assert.equal(rec.comprovaBackupIntegro, false);
  });

  test('INT-07 — (cenário 11) recuperação concluída NÃO é backup concluído: o cliente (dump) foi derrubado por SIGKILL da sentinela; a reconciliação é CONCLUIDA para processos, mas a supervisão de produção, alimentada com o MESMO término, NÃO conclui (concluido=false) e portanto nada é selado nem publicado', async () => {
    const { c } = await cenarioRunnerMorto();
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'CONCLUIDA');
    const encerrado = eventosDe(c).find((e) => e.k === 'CLIENTE_ENCERRADO' && e.d.sinal === 'SIGKILL');
    assert.ok(encerrado !== undefined, 'o dump sintético terminou por sinal');
    const termino = { codigo: encerrado.d.codigo, sinal: encerrado.d.sinal };
    const supervisao = await supervisionar({
      iniciar: async () => ({ pgid: 4242, saida: Promise.resolve(termino), fluxosFechados: Promise.resolve() }),
      grupo: { vivos: async () => false },
      sinais: { enviar: async () => true },
      temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: async () => {} },
      prazos: { totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 10, tentativasGrupo: 2, consultaGrupoMs: 1000 },
    });
    assert.equal(supervisao.concluido, false);
    assert.notEqual(supervisao.saida, 0);
    assert.ok(supervisao.motivos.includes('TERMINADO_POR_SINAL'));
    assert.equal(supervisao.sinalDoProcesso, 'SIGKILL');
  });
});

describe('[PMI-INT] runner morre cedo', () => {
  test('INT-08 — (cenário 4) o runner morre ANTES da confirmação de prontidão (e o postmaster ainda nem escreveu o postmaster.pid): a sentinela repete a identidade, comprova, desliga por SIGINT e a tentativa fecha CONCLUIDA', async () => {
    const c = novoCenario();
    const r = rodarRunner(configBase(c, { modo: 'morrer-apos-identidade', antesDeMorrerMs: 0, identificacao: { tentativas: 12, intervaloMs: 100 }, pg: { pidArquivo: 'tarde', atrasoPidMs: 300 } }));
    const pg = await r.aguardarEvento('PG');
    assert.equal((await r.termino).sinal, 'SIGKILL');
    registrarPidsDoDiario(c);
    await todosMortos([pg.postmasterPid, pg.sentinelaPid], 'encerramento sem o runner');
    const ev = doPostmaster(c);
    assert.deepEqual(ev.filter((e) => e.k === 'SINAL_ENVIADO').map((e) => e.d.sinal), ['SIGINT']);
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'CONCLUIDA', JSON.stringify(rec.motivos));
  });

  test('INT-09 — (cenário 7) runner morto entre a INTENÇÃO e o lançamento da sentinela: nada nasceu, o registro fica incompleto, a reconciliação é INCONCLUSIVA (LANCAMENTO_SEM_IDENTIDADE) e BLOQUEIA nova tentativa', async () => {
    const c = novoCenario();
    const r = rodarRunner(configBase(c, { modo: 'morrer-apos-intencao', travas: true }));
    assert.equal((await r.termino).sinal, 'SIGKILL');
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'INCONCLUSIVA');
    assert.ok(rec.motivos.includes('LANCAMENTO_SEM_IDENTIDADE'));
    assert.equal(rec.liberaNovaTentativa, false);
    assert.equal((await diario.avaliarNovaTentativa({ raiz: c.raiz, observarProcesso: diario.observarProcessoReal })).liberada, false);
  });

  test('INT-10 — (cenário 7) runner morto logo depois de lançar a sentinela, ANTES de registrar SENTINELA_LANCADA: a sentinela é órfã desde o início, comprova a própria identidade e conclui sozinha; o postmaster é encerrado por SIGINT', async () => {
    const c = novoCenario();
    const r = rodarRunner(configBase(c, { modo: 'morrer-apos-spawn-da-sentinela' }));
    assert.equal((await r.termino).sinal, 'SIGKILL');
    await esperarAte(() => { try { registrarPidsDoDiario(c); return eventosDe(c).some((e) => e.k === 'SENTINELA_FIM'); } catch { return false; } }, 'sentinela concluiu sozinha');
    registrarPidsDoDiario(c);
    const ev = doPostmaster(c);
    const pidDoPostmaster = ev.find((e) => e.k === 'CLIENTE_LANCADO').d.clientePid;
    await todosMortos([pidDoPostmaster], 'postmaster encerrado pela sentinela órfã');
    assert.deepEqual(ev.filter((e) => e.k === 'SINAL_ENVIADO').map((e) => e.d.sinal), ['SIGINT']);
  });
});

describe('[PMI-INT] processo que não cede: SIGQUIT de emergência, resistente e descendente', () => {
  test('INT-11 — (cenário 5) o postmaster IGNORA a primeira solicitação (SIGINT): depois do prazo, SIGQUIT de emergência com o evento durável ANTES; sai (código 2); resultado ENCERRADA_ANORMAL — nunca ENCERRADA — e a tentativa NÃO fica CONCLUIDA', async () => {
    const c = novoCenario();
    const r = rodarRunner(configBase(c, { modo: 'encerrar', travas: true, pg: { sigint: 'ignorar' } }));
    const pg = await r.aguardarEvento('PG');
    const fim = await r.aguardarEvento('ENCERRADO');
    assert.deepEqual({ resultado: fim.resultado, sinais: fim.sinais }, { resultado: 'ENCERRADA_ANORMAL', sinais: ['SIGINT', 'SIGQUIT'] });
    assert.equal(await vivo(pg.postmasterPid), false);
    const ev = doPostmaster(c);
    assert.ok(ev.findIndex((e) => e.k === 'POSTMASTER_EMERGENCIA') < ev.map((e) => e.k).lastIndexOf('SINAL_ENVIADO'));
    assert.ok(!ev.some((e) => e.k === 'SINAL_ENVIADO' && !['SIGINT', 'SIGQUIT'].includes(e.d.sinal)));
    assert.equal(ev.at(-1).d.resultado, 'ENCERRADO_ANORMAL');
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'INCONCLUSIVA');
    assert.ok(rec.motivos.includes('POSTGRES_ENCERRAMENTO_ANORMAL'));
    assert.equal(rec.liberaNovaTentativa, false);
  });

  test('INT-12 — processo RESISTENTE (ignora SIGINT e SIGQUIT): exatamente [SIGINT, SIGQUIT], sem SIGKILL; ENCERRAMENTO_INCERTO; o postmaster segue VIVO e a tentativa fica INCONCLUSIVA', async () => {
    const c = novoCenario();
    const r = rodarRunner(configBase(c, { modo: 'encerrar', travas: true, pg: { sigint: 'ignorar', sigquit: 'ignorar' } }));
    const pg = await r.aguardarEvento('PG');
    const fim = await r.aguardarEvento('ENCERRADO');
    assert.deepEqual({ resultado: fim.resultado, sinais: fim.sinais }, { resultado: 'ENCERRAMENTO_INCERTO', sinais: ['SIGINT', 'SIGQUIT'] });
    assert.equal(await vivo(pg.postmasterPid), true, 'sinal aceito não é encerramento: o processo resistente continua');
    const ev = doPostmaster(c);
    assert.ok(!ev.some((e) => e.k === 'CLIENTE_ENCERRADO'));
    assert.ok(!ev.some((e) => e.k === 'SINAL_ENVIADO' && ['SIGKILL', 'SIGTERM'].includes(e.d.sinal)));
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'INCONCLUSIVA');
    assert.equal(rec.liberaNovaTentativa, false);
  });

  test('INT-13 — descendente que sobrevive ao postmaster (mesmo grupo): o término do postmaster não conclui; DESCENDENTES_ATIVOS, resultado ENCERRAMENTO_INCERTO e nenhum sinal ao descendente', async () => {
    const c = novoCenario();
    const r = rodarRunner(configBase(c, { modo: 'encerrar', travas: true, pg: { neto: 'sobrevive' } }));
    const pg = await r.aguardarEvento('PG');
    const fim = await r.aguardarEvento('ENCERRADO');
    assert.equal(fim.resultado, 'ENCERRAMENTO_INCERTO');
    assert.deepEqual(fim.falhas, ['DESCENDENTES_ATIVOS']);
    assert.equal(await vivo(pg.postmasterPid), false);
    const neto = Number(fs.readFileSync(path.join(c.pgdata, 'neto.pid'), 'utf8'));
    registrar(neto);
    assert.equal(await vivo(neto), true, 'o descendente é só observado');
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'INCONCLUSIVA');
    assert.equal(rec.liberaNovaTentativa, false);
  });
});

describe('[PMI-INT] morte da sentinela do postmaster e bloqueio da tentativa', () => {
  let ctx = null;
  async function cenarioSentinelaMorta() {
    if (ctx !== null) return ctx;
    const c = novoCenario();
    const r = rodarRunner(configBase(c, { modo: 'encerrar', travas: true, pg: { sigint: 'ignorar' }, antesDeEncerrarMs: 100 }));
    const pg = await r.aguardarEvento('PG');
    await r.aguardarEvento('ENCERRANDO');
    await esperarAte(() => doPostmaster(c).some((e) => e.k === 'SINAL_ENVIADO' && e.d.sinal === 'SIGINT'), 'SIGINT enviado e ignorado');
    process.kill(pg.sentinelaPid, 'SIGKILL'); // a sentinela é um processo CRIADO por esta suíte (via runner sintético)
    const fim = await r.aguardarEvento('ENCERRADO');
    await r.termino;
    ctx = { c, pg, fim, r };
    return ctx;
  }

  test('INT-14 — (cenário 6) a SENTINELA MORRE antes da confirmação do término: o runner recebe ENCERRAMENTO_INCERTO (AUTORIDADE_PERDIDA); o postmaster continua vivo e NINGUÉM o sinaliza por PID recuperado do diário', async () => {
    const { c, pg, fim } = await cenarioSentinelaMorta();
    assert.equal(fim.resultado, 'ENCERRAMENTO_INCERTO');
    assert.ok(fim.falhas.includes('AUTORIDADE_PERDIDA'));
    await esperar(1500);
    assert.equal(await vivo(pg.postmasterPid), true, 'sem a sentinela, o postmaster não é sinalizado por ninguém');
    const sinais = doPostmaster(c).filter((e) => e.k === 'SINAL_ENVIADO').map((e) => e.d.sinal);
    assert.deepEqual(sinais, ['SIGINT'], 'nenhum SIGQUIT, nenhum outro sinal depois da morte da sentinela');
    assert.ok(!doPostmaster(c).some((e) => e.k === 'SENTINELA_FIM'));
  });

  test('INT-15 — a tentativa fica INCONCLUSIVA (AUTORIDADE_PERDIDA) e a resolução humana é RECUSADA enquanto o postmaster registrado existir', async () => {
    const { c } = await cenarioSentinelaMorta();
    const rec = await reconciliar(c);
    assert.equal(rec.estado, 'INCONCLUSIVA');
    assert.ok(rec.motivos.includes('AUTORIDADE_PERDIDA'));
    await assert.rejects(() => diario.registrarResolucaoHumana({ raiz: c.raiz, tentativaId: c.tentativaId, responsavel: 'revisor', observacao: 'tentativa de resolver com o postmaster vivo', observarProcesso: diario.observarProcessoReal }), (f) => f.code === 'PROCESSO_REGISTRADO_AINDA_PRESENTE');
  });

  test('INT-16 — (cenário 10) uma tentativa inconclusiva IMPEDE o lançamento incompatível: nova tentativa bloqueada, recursos (área, PGDATA, socket, porta) ainda travados e a liberação das travas recusada', async () => {
    const { c } = await cenarioSentinelaMorta();
    const a = await diario.avaliarNovaTentativa({ raiz: c.raiz, observarProcesso: diario.observarProcessoReal });
    assert.equal(a.liberada, false);
    assert.deepEqual(a.motivos, ['TENTATIVA_ANTERIOR_NAO_RESOLVIDA']);
    assert.throws(() => diario.adquirirRecursos({ raiz: c.raiz, tentativaId: 't-9999', recursos: [{ tipo: 'pgdata', id: c.pgdata }] }), (f) => f.code === 'RECURSO_EM_USO');
    assert.throws(() => diario.adquirirRecursos({ raiz: c.raiz, tentativaId: 't-9998', recursos: [{ tipo: 'porta', id: String(c.porta) }] }), (f) => f.code === 'RECURSO_EM_USO');
    assert.throws(() => diario.adquirirTentativa({ raiz: c.raiz, tentativaId: c.tentativaId }), (f) => f.code === 'TENTATIVA_EM_USO');
    await assert.rejects(() => diario.liberarRecursosDeTentativaConcluida({ raiz: c.raiz, tentativaId: c.tentativaId, observarProcesso: diario.observarProcessoReal }), (f) => f.code === 'TENTATIVA_NAO_CONCLUIDA');
    assert.equal(fs.readdirSync(path.join(c.raiz, 'travas')).filter((n) => n.startsWith('recurso-')).length, 4, 'as quatro travas de recurso permanecem');
  });

  test('INT-17 — (cenário 12) uma tentativa INCONCLUSIVA não é reutilizável como válida e a reconciliação, mesmo depois, não traz nenhum sinal de backup íntegro', async () => {
    const { c } = await cenarioSentinelaMorta();
    const rec = await reconciliar(c);
    assert.equal(rec.liberaNovaTentativa, false);
    assert.equal(rec.comprovaBackupIntegro, false);
    assert.equal(rec.escopo, 'PROCESSOS_E_RECURSOS');
  });
});

describe('[PMI-INT] a sentinela do postmaster é o único processo que sinaliza o postmaster', () => {
  test('INT-18 — o runner sintético (e o lançador) só conseguem PEDIR a parada: kill do handle recusa tudo que não for SIGINT e nenhum caminho do lançador usa process.kill', () => {
    const fonte = fs.readFileSync(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-postmaster-lancador.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/process\.kill|\.kill\(-/.test(fonte), false);
    assert.equal(/SIGKILL|SIGTERM|SIGQUIT/.test(fonte), false);
  });
});
