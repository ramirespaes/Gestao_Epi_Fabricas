'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6): SUPERVISÃO INTEGRADA com PROCESSOS SINTÉTICOS REAIS. Sentinela real (`src/workers/imagem-backup-sentinela.worker.js`), canal IPC real, diário durável real e um "runner" sintético descartável
 * (`test/helpers/runner-sintetico-supervisao.js`) que se comporta como o runner de homologação diante da supervisão e, em alguns modos, MORRE de forma abrupta (SIGKILL de si mesmo). Os "clientes" são processos Node triviais criados aqui; NÃO há PostgreSQL, pg_dump ou pg_restore reais.
 *
 * SINAIS REAIS: só atingem processos criados por esta suíte (o runner sintético, as sentinelas e os clientes sintéticos que ele lança, e os chamarizes), identificados por esta própria execução. Nenhum processo externo é sinalizado: a suíte confere, depois de cada cenário, que
 * os chamarizes (mesmo executável, mesma linha de comando e mesmo dono que o cliente) continuam vivos. Tudo o que esta suíte cria é encerrado em `after` (SIGKILL só aos pids que ELA registrou), com evidência do encerramento.
 */

const RAIZ_BACKEND = path.join(__dirname, '..', '..');
const HELPER = path.join(RAIZ_BACKEND, 'test/helpers/runner-sintetico-supervisao.js');
const diario = require(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-diario-execucao.service'));

const CLIENTE_LONGO = 'setInterval(() => {}, 1000);';
/** Cliente sintético que IGNORA o SIGTERM e avisa por arquivo quando o tratador já está instalado (o runner sintético espera o aviso antes de pedir a parada). */
let prontos = 0;
function ignoraSigterm() {
  prontos += 1;
  const pronto = path.join(os.tmpdir(), `gs-pronto-${process.pid}-${prontos}`);
  criadosArquivos.add(pronto);
  return { script: `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pronto)}, 'ok'); setInterval(() => {}, 1000);`, prontoArquivo: pronto };
}
const criadosArquivos = new Set();

let base;
const criados = new Set(); // pids de processos criados POR ESTA SUÍTE (únicos alvos de qualquer sinal real)
const registrar = (pid) => { if (Number.isSafeInteger(pid) && pid > 1) criados.add(pid); return pid; };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const vivo = async (pid) => (await diario.observarProcessoReal(pid)) === 'VIVO';
let contador = 0;

before(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gs-'))); fs.chmodSync(base, 0o700); });
after(async () => {
  for (const pid of criados) { try { process.kill(pid, 'SIGKILL'); } catch { /* já encerrado */ } }
  await esperar(200);
  for (const pid of criados) assert.equal(await vivo(pid), false, `sobrou processo criado pela suíte: ${pid}`);
  for (const arquivo of criadosArquivos) fs.rmSync(arquivo, { force: true });
  fs.rmSync(base, { recursive: true, force: true });
});

function novaRaiz() {
  contador += 1;
  const raiz = path.join(base, `estado-${contador}`);
  fs.mkdirSync(raiz, { mode: 0o700 });
  return raiz;
}

/** Roda o runner sintético; devolve as linhas JSON que ele escreve e a promessa do seu término. */
function rodarRunner(cfg) {
  const filho = spawn(process.execPath, [HELPER, JSON.stringify(cfg)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  registrar(filho.pid);
  const eventos = [];
  let resto = '';
  filho.stdout.on('data', (b) => {
    resto += b.toString('utf8');
    let i;
    while ((i = resto.indexOf('\n')) >= 0) { const linha = resto.slice(0, i); resto = resto.slice(i + 1); if (linha.trim() !== '') eventos.push(JSON.parse(linha)); }
  });
  let erro = '';
  filho.stderr.on('data', (b) => { erro += b.toString('utf8'); });
  const termino = new Promise((resolver) => { filho.on('exit', (codigo, sinal) => resolver({ codigo, sinal })); });
  const aguardarEvento = async (nome, prazoMs = 20000) => {
    const limite = Date.now() + prazoMs;
    while (Date.now() < limite) { const e = eventos.find((x) => x.e === nome); if (e !== undefined) return e; await esperar(20); }
    throw new Error(`evento não chegou: ${nome} (stderr=${erro.slice(0, 200)})`);
  };
  return { filho, eventos, termino, aguardarEvento, stderr: () => erro };
}

function lerEscritores(raiz, tentativaId) {
  return diario.lerTentativa({ raiz, tentativaId }).escritores;
}
const sentinelaDe = (escritores) => Object.entries(escritores).find(([n]) => n.startsWith('sentinela-'));
const tiposDe = (escritor) => escritor.eventos.map((e) => e.k);

async function aguardarJournal(raiz, tentativaId, predicado, prazoMs = 20000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) {
    try { const e = lerEscritores(raiz, tentativaId); if (predicado(e)) return e; } catch { /* ainda sem arquivo */ }
    await esperar(25);
  }
  throw new Error('condição do diário não ocorreu a tempo');
}
async function aguardarMorte(pid, prazoMs = 10000) {
  const limite = Date.now() + prazoMs;
  while (Date.now() < limite) { if (!(await vivo(pid))) return true; await esperar(25); }
  return false;
}
function chamariz() {
  const f = spawn(process.execPath, ['-e', CLIENTE_LONGO], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
  registrar(f.pid);
  return f.pid;
}
const reconciliar = (raiz, tentativaId) => diario.reconciliar({ raiz, tentativaId, observarProcesso: diario.observarProcessoReal });

describe('SI — ciclo normal com sentinela real: fluxos intactos, saída espelhada, grupo comprovado', () => {
  test('SI-01 — (cenário 1/27/31) a saída do cliente atravessa a sentinela byte a byte (nada a mais no stdout nem no stderr), o código é espelhado, o grupo é comprovado vazio e a tentativa reconcilia CONCLUIDA', async () => {
    const raiz = novaRaiz();
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'normal', script: "process.stdout.write('dados-sinteticos-do-dump')" });
    const t = await r.termino;
    const fim = r.eventos.find((e) => e.e === 'FIM');
    assert.deepEqual(t, { codigo: 0, sinal: null }, r.stderr());
    assert.deepEqual(fim.termino, { codigo: 0, sinal: null });
    assert.equal(fim.stdout, 'dados-sinteticos-do-dump');
    assert.equal(fim.stderrBytes, 0);
    assert.equal(fim.grupoOcupado, false);
    const e = lerEscritores(raiz, 't-0001');
    const [, sent] = sentinelaDe(e);
    assert.deepEqual(tiposDe(sent), ['SENTINELA_ATIVA', 'CLIENTE_LANCADO', 'CLIENTE_ENCERRADO', 'GRUPO_VERIFICADO', 'SENTINELA_FIM']);
    registrar(sent.eventos[0].d.sentinelaPid);
    const rec = await reconciliar(raiz, 't-0001');
    assert.equal(rec.estado, 'CONCLUIDA', JSON.stringify(rec));
    assert.deepEqual(rec.lancamentos.map((l) => l.estado), ['CONFIRMADO']);
  });

  test('SI-02 — (cenário 31) código de saída e término por sinal do cliente são espelhados pela sentinela (o runner observa o MESMO código / o MESMO sinal)', async () => {
    let raiz = novaRaiz();
    let r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'normal', script: 'process.exit(3)' });
    await r.termino;
    assert.deepEqual(r.eventos.find((e) => e.e === 'FIM').termino, { codigo: 3, sinal: null });
    raiz = novaRaiz();
    r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'normal', script: "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000);" });
    await r.termino;
    assert.deepEqual(r.eventos.find((e) => e.e === 'FIM').termino, { codigo: null, sinal: 'SIGTERM' });
    const [, sent] = sentinelaDe(lerEscritores(raiz, 't-0001'));
    assert.equal(sent.eventos.find((e) => e.k === 'CLIENTE_ENCERRADO').d.sinal, 'SIGTERM');
  });

  test('SI-03 — o kill do handle chega ao cliente pelo canal restrito: SIGTERM encerra, e SIGKILL (ESCALAR) encerra o cliente que ignora o SIGTERM; o runner nunca sinaliza a sentinela', async () => {
    let raiz = novaRaiz();
    let r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'kill-do-handle', sinal: 'SIGTERM', script: CLIENTE_LONGO });
    await r.termino;
    let fim = r.eventos.find((e) => e.e === 'FIM');
    assert.equal(fim.aceito, true);
    assert.deepEqual(fim.termino, { codigo: null, sinal: 'SIGTERM' });
    let [, sent] = sentinelaDe(lerEscritores(raiz, 't-0001'));
    assert.ok(tiposDe(sent).includes('PARADA_SOLICITADA') && tiposDe(sent).includes('SINAL_ENVIADO'));
    raiz = novaRaiz();
    r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'kill-do-handle', sinal: 'SIGKILL', ...ignoraSigterm() });
    await r.termino;
    fim = r.eventos.find((e) => e.e === 'FIM');
    assert.equal(fim.aceito, true);
    assert.deepEqual(fim.termino, { codigo: null, sinal: 'SIGKILL' });
    [, sent] = sentinelaDe(lerEscritores(raiz, 't-0001'));
    assert.equal(sent.eventos.find((e) => e.k === 'PARADA_SOLICITADA').d.origem, 'RUNNER_ESCALADA');
  });

  test('SI-04 — (cenário 5/8/24) finalização coordenada: encerrarClientes() pede a parada, o cliente que ignora o SIGTERM é escalado, e ENCERRADOS só sai com a saída observada e o grupo vazio', async () => {
    const raiz = novaRaiz();
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'encerrar-clientes', ...ignoraSigterm(), cortesiaMs: 400 });
    const cli = await r.aguardarEvento('CLIENTE');
    registrar(cli.clientePid);
    const enc = await r.aguardarEvento('ENCERRADOS', 25000);
    await r.termino;
    assert.equal(enc.resultado, 'ENCERRADOS');
    assert.deepEqual(enc.clientes.map((c) => [c.encerrado, c.grupoVazio]), [[true, true]]);
    assert.equal(await vivo(cli.clientePid), false);
    const [, sent] = sentinelaDe(lerEscritores(raiz, 't-0001'));
    assert.equal(sent.eventos.find((e) => e.k === 'CLIENTE_ENCERRADO').d.sinal, 'SIGKILL');
    assert.equal((await reconciliar(raiz, 't-0001')).estado, 'CONCLUIDA');
  });

  test('SI-05 — (cenários 17/28) DESCENDENTE REAL: o cliente sai com código 0 mas deixa um processo no seu grupo; o fim do processo principal NÃO conclui — GRUPO_VERIFICADO vazio:false, o runner vê o grupo povoado, a tentativa reconcilia INCONCLUSIVA (DESCENDENTES_ATIVOS), nova tentativa bloqueada; só a resolução humana, depois de o descendente ser encerrado, fecha', async () => {
    const raiz = novaRaiz();
    const script = "const f = require('child_process').spawn('/bin/sleep', ['60'], { stdio: 'ignore' }); process.stdout.write(String(f.pid)); process.exit(0);";
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'normal', script });
    await r.termino;
    const fim = r.eventos.find((e) => e.e === 'FIM');
    assert.ok(fim, r.stderr());
    const descendente = registrar(Number(fim.stdout));
    assert.ok(Number.isSafeInteger(descendente) && descendente > 1);
    assert.deepEqual(fim.termino, { codigo: 0, sinal: null });
    assert.equal(fim.grupoOcupado, true, 'o grupo do cliente ainda tem o descendente');
    const [, sent] = sentinelaDe(lerEscritores(raiz, 't-0001'));
    registrar(sent.eventos[0].d.sentinelaPid);
    assert.equal(sent.eventos.find((x) => x.k === 'GRUPO_VERIFICADO').d.vazio, false);
    assert.equal(sent.eventos.find((x) => x.k === 'SENTINELA_FIM').d.resultado, 'DESCENDENTES_ATIVOS');
    const rec = await reconciliar(raiz, 't-0001');
    assert.equal(rec.estado, 'INCONCLUSIVA', JSON.stringify(rec));
    assert.ok(rec.motivos.includes('DESCENDENTES_ATIVOS'));
    assert.equal((await diario.avaliarNovaTentativa({ raiz, observarProcesso: diario.observarProcessoReal })).liberada, false);
    assert.equal(await vivo(descendente), true, 'nada sinalizou o descendente (sem autoridade comprovada sobre ele)');
    process.kill(descendente, 'SIGKILL'); // intervenção humana ESPECÍFICA (aqui, da suíte sobre o processo sintético que ela mesma criou)
    assert.equal(await aguardarMorte(descendente), true);
    await diario.registrarResolucaoHumana({ raiz, tentativaId: 't-0001', responsavel: 'ramires', observacao: 'descendente sintetico encerrado', observarProcesso: diario.observarProcessoReal });
    assert.equal((await reconciliar(raiz, 't-0001')).estado, 'CONCLUIDA');
  });
});

describe('SI — runner morto: a sentinela sobrevive e recupera (positivo), sem tocar em processos externos', () => {
  test('SI-10 — (cenários 6/7/8/25) o runner MORRE (SIGKILL) com o cliente ativo: a sentinela detecta a órfã, encerra o cliente, registra tudo e a tentativa reconcilia CONCLUIDA — e os chamarizes externos continuam vivos', async () => {
    const raiz = novaRaiz();
    const chamarizes = [chamariz(), chamariz()];
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'morrer-com-cliente', script: CLIENTE_LONGO });
    const cli = await r.aguardarEvento('CLIENTE');
    registrar(cli.clientePid);
    const t = await r.termino;
    assert.equal(t.sinal, 'SIGKILL');
    const e = await aguardarJournal(raiz, 't-0001', (x) => { const s = sentinelaDe(x); return s !== undefined && tiposDe(s[1]).includes('SENTINELA_FIM'); });
    const [, sent] = sentinelaDe(e);
    registrar(sent.eventos[0].d.sentinelaPid);
    assert.deepEqual(tiposDe(sent).filter((k) => ['ORFANDADE_DETECTADA', 'CLIENTE_ENCERRADO', 'GRUPO_VERIFICADO'].includes(k)), ['ORFANDADE_DETECTADA', 'CLIENTE_ENCERRADO', 'GRUPO_VERIFICADO']);
    assert.equal(sent.eventos.find((x) => x.k === 'GRUPO_VERIFICADO').d.vazio, true);
    assert.equal(await aguardarMorte(cli.clientePid), true, 'cliente não foi encerrado');
    assert.equal(await aguardarMorte(sent.eventos[0].d.sentinelaPid), true, 'sentinela não saiu');
    const rec = await reconciliar(raiz, 't-0001');
    assert.equal(rec.estado, 'CONCLUIDA', JSON.stringify(rec));
    assert.ok(rec.motivos.includes('RUNNER_MORTO_SEM_FIM'));
    assert.equal((await diario.avaliarNovaTentativa({ raiz, observarProcesso: diario.observarProcessoReal })).liberada, true);
    for (const c of chamarizes) assert.equal(await vivo(c), true, 'um processo externo (chamariz) foi atingido');
  });

  test('SI-11 — (cenário 3) runner morto e cliente que IGNORA o SIGTERM: a sentinela escala para SIGKILL depois da cortesia; SIGTERM e SIGKILL ficam registrados; o encerramento só é afirmado com a saída observada', async () => {
    const raiz = novaRaiz();
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'morrer-com-cliente', ...ignoraSigterm(), cortesiaMs: 400 });
    const cli = await r.aguardarEvento('CLIENTE');
    registrar(cli.clientePid);
    await r.termino;
    const e = await aguardarJournal(raiz, 't-0001', (x) => { const s = sentinelaDe(x); return s !== undefined && tiposDe(s[1]).includes('SENTINELA_FIM'); });
    const [, sent] = sentinelaDe(e);
    registrar(sent.eventos[0].d.sentinelaPid);
    assert.deepEqual(sent.eventos.filter((x) => x.k === 'SINAL_ENVIADO').map((x) => x.d.sinal), ['SIGTERM', 'SIGKILL']);
    assert.equal(sent.eventos.find((x) => x.k === 'CLIENTE_ENCERRADO').d.sinal, 'SIGKILL');
    assert.equal(await aguardarMorte(cli.clientePid), true);
    assert.equal((await reconciliar(raiz, 't-0001')).estado, 'CONCLUIDA');
  });

  test('SI-12 — (cenário 7 da janela) o runner morre IMEDIATAMENTE depois de lançar a sentinela, antes de registrar SENTINELA_LANCADA: a sentinela registra a PRÓPRIA identidade e a do cliente, trata a órfã e a tentativa fecha CONCLUIDA — a janela não deixa processo sem registro', async () => {
    const raiz = novaRaiz();
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'morrer-apos-spawn-da-sentinela', script: CLIENTE_LONGO });
    await r.termino;
    const e = await aguardarJournal(raiz, 't-0001', (x) => { const s = sentinelaDe(x); return s !== undefined && tiposDe(s[1]).includes('SENTINELA_FIM'); }, 25000);
    const [, sent] = sentinelaDe(e);
    registrar(sent.eventos[0].d.sentinelaPid);
    registrar(sent.eventos.find((x) => x.k === 'CLIENTE_LANCADO').d.clientePid);
    assert.equal(tiposDe(e.runner).includes('SENTINELA_LANCADA'), false);
    assert.ok(tiposDe(sent).includes('ORFANDADE_DETECTADA'));
    assert.equal(await aguardarMorte(sent.eventos.find((x) => x.k === 'CLIENTE_LANCADO').d.clientePid), true);
    assert.equal((await reconciliar(raiz, 't-0001')).estado, 'CONCLUIDA');
  });

  test('SI-13 — (cenário 11) o runner morre ENTRE a intenção e o lançamento: sobra só a intenção — INCONCLUSIVA, LANCAMENTO_SEM_IDENTIDADE, nenhuma sentinela, e a nova tentativa fica bloqueada (nada é presumido, nada é sinalizado)', async () => {
    const raiz = novaRaiz();
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'morrer-apos-intencao', script: CLIENTE_LONGO });
    const t = await r.termino;
    assert.equal(t.sinal, 'SIGKILL');
    const e = lerEscritores(raiz, 't-0001');
    assert.deepEqual(Object.keys(e), ['runner']);
    assert.deepEqual(tiposDe(e.runner), ['TENTATIVA_INICIADA', 'INTENCAO_LANCAMENTO']);
    const rec = await reconciliar(raiz, 't-0001');
    assert.equal(rec.estado, 'INCONCLUSIVA');
    assert.ok(rec.motivos.includes('LANCAMENTO_SEM_IDENTIDADE'));
    const nova = await diario.avaliarNovaTentativa({ raiz, observarProcesso: diario.observarProcessoReal });
    assert.equal(nova.liberada, false);
    assert.deepEqual(nova.tentativas.map((x) => x.estado), ['INCONCLUSIVA']);
  });
});

describe('SI — sentinela morta: autoridade perdida, sem recuperação por aproximação', () => {
  test('SI-20 — (cenários 9/10/14/15/22) a SENTINELA é morta com o cliente vivo: AUTORIDADE_PERDIDA, INCONCLUSIVA, nova tentativa bloqueada; a reconciliação não sinaliza ninguém (cliente continua vivo); a resolução humana é RECUSADA enquanto o cliente existe e só vale depois', async () => {
    const raiz = novaRaiz();
    const chamarizes = [chamariz()];
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'normal', script: CLIENTE_LONGO });
    const lancado = await r.aguardarEvento('LANCADO');
    registrar(lancado.sentinelaPid);
    const e0 = await aguardarJournal(raiz, 't-0001', (x) => { const s = sentinelaDe(x); return s !== undefined && tiposDe(s[1]).includes('CLIENTE_LANCADO'); });
    const clientePid = registrar(sentinelaDe(e0)[1].eventos.find((x) => x.k === 'CLIENTE_LANCADO').d.clientePid);
    process.kill(lancado.sentinelaPid, 'SIGKILL'); // a suíte mata a PRÓPRIA sentinela sintética (única autoridade sobre o cliente)
    assert.equal(await aguardarMorte(lancado.sentinelaPid), true);
    assert.equal(await vivo(clientePid), true, 'o cliente deveria continuar vivo (órfão sem autoridade)');

    const rec = await reconciliar(raiz, 't-0001');
    assert.equal(rec.estado, 'INCONCLUSIVA', JSON.stringify(rec));
    assert.ok(rec.motivos.includes('AUTORIDADE_PERDIDA'));
    assert.equal(rec.liberaNovaTentativa, false);
    assert.equal((await diario.avaliarNovaTentativa({ raiz, observarProcesso: diario.observarProcessoReal })).liberada, false);
    assert.equal(await vivo(clientePid), true, 'a reconciliação não pode ter encerrado o cliente');
    await assert.rejects(diario.registrarResolucaoHumana({ raiz, tentativaId: 't-0001', responsavel: 'ramires', observacao: 'tentativa de contornar', observarProcesso: diario.observarProcessoReal }), (x) => x.code === 'PROCESSO_REGISTRADO_AINDA_PRESENTE');
    assert.equal(await vivo(chamarizes[0]), true);

    // intervenção humana ESPECÍFICA (aqui feita pela suíte sobre os próprios processos sintéticos) e, só então, a resolução formal
    process.kill(clientePid, 'SIGKILL');
    process.kill(r.filho.pid, 'SIGKILL');
    assert.equal(await aguardarMorte(clientePid), true);
    await r.termino;
    const registrado = await diario.registrarResolucaoHumana({ raiz, tentativaId: 't-0001', responsavel: 'ramires', observacao: 'processos sinteticos encerrados', observarProcesso: diario.observarProcessoReal });
    assert.equal(registrado.registrado, true);
    const depois = await reconciliar(raiz, 't-0001');
    assert.equal(depois.estado, 'CONCLUIDA');
    assert.ok(depois.motivos.includes('RESOLVIDA_POR_HUMANO'));
  });

  test('SI-21 — o módulo de recuperação não tem NENHUM caminho de sinalização: não exporta função de kill/sinal e a reconciliação repetida não altera o diretório', async () => {
    for (const nome of Object.keys(diario)) assert.equal(/kill|sinal|signal|encerrar|matar/i.test(nome), false, nome);
    const fonte = fs.readFileSync(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-diario-execucao.service.js'), 'utf8');
    assert.equal(/process\.kill\([^)]*,\s*['"]SIG/.test(fonte), false);
    assert.equal(/\.kill\(/.test(fonte.replace(/process\.kill\(alvo, 0\)/, '')), false);
  });
});

describe('SI — o processo da sentinela só age como processo principal', () => {
  test('SI-25 — carregar o worker por `require` (como uma varredura de src/) não executa nada, não encerra o processo e só exporta a leitura de configuração; sem argumento, como principal, ele sai com 2 sem escrever na saída padrão nem na de erro', async () => {
    const worker = path.join(RAIZ_BACKEND, 'src/workers/imagem-backup-sentinela.worker.js');
    const rodar = (args) => new Promise((resolver) => {
      const f = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
      registrar(f.pid);
      let out = ''; let err = '';
      f.stdout.on('data', (b) => { out += b; });
      f.stderr.on('data', (b) => { err += b; });
      f.on('exit', (codigo) => resolver({ codigo, out, err }));
    });
    const carregado = await rodar(['-e', `const m = require(${JSON.stringify(worker)}); process.stdout.write(Object.keys(m).join(','));`]);
    assert.deepEqual([carregado.codigo, carregado.out, carregado.err], [0, 'lerConfiguracao', '']);
    const semArgumento = await rodar([worker]);
    assert.deepEqual([semArgumento.codigo, semArgumento.out, semArgumento.err], [2, '', '']);
  });
});

describe('SI — captura do dump através da sentinela e concorrência entre processos', () => {
  test('SI-30 — (cenário 27) o lançador REAL do pg_dump sobre o spawn da sentinela captura o stdout íntegro (tamanho e SHA-256 iguais ao esperado), com `exit` e `close` distintos e o grupo comprovado', async () => {
    const raiz = novaRaiz();
    const dir = path.join(base, `pgdump-${contador}`);
    fs.mkdirSync(dir, { mode: 0o700 });
    const socketDir = path.join(dir, 's');
    fs.mkdirSync(socketDir, { mode: 0o700 });
    const pgDump = path.join(dir, 'pg_dump');
    fs.writeFileSync(pgDump, "#!/bin/sh\nhead -c 262144 /dev/zero | tr '\\000' 'A'\n", { mode: 0o700 });
    const pgpass = path.join(dir, 'pgpass');
    fs.writeFileSync(pgpass, 'x\n', { mode: 0o600 });
    const arquivoDoDump = path.join(dir, 'dump.bin');
    const esperado = crypto.createHash('sha256').update(Buffer.alloc(262144, 0x41)).digest('hex');
    const r = rodarRunner({ raiz, tentativaId: 't-0001', modo: 'dump-capturado', pgDumpSintetico: pgDump, pgpass, socketDir, arquivoDoDump });
    await r.termino;
    const fim = r.eventos.find((e) => e.e === 'FIM');
    assert.ok(fim, `sem FIM: ${r.stderr().slice(0, 300)} ${JSON.stringify(r.eventos)}`);
    assert.deepEqual(fim.termino, { codigo: 0, sinal: null });
    assert.equal(fim.bytes, 262144);
    assert.equal(fim.sha256, esperado);
    assert.equal(fim.grupoOcupado, false);
    const [, sent] = sentinelaDe(lerEscritores(raiz, 't-0001'));
    assert.deepEqual(tiposDe(sent), ['SENTINELA_ATIVA', 'CLIENTE_LANCADO', 'CLIENTE_ENCERRADO', 'GRUPO_VERIFICADO', 'SENTINELA_FIM']);
    const bruto = fs.readFileSync(path.join(raiz, 'tentativas', 't-0001', 'runner.ndjson'), 'utf8');
    for (const proibido of ['gepi_hom_origem', 'pgpass', '--snapshot', socketDir]) assert.equal(bruto.includes(proibido), false, proibido);
  });

  test('SI-31 — (cenário 18) quatro PROCESSOS disputam a mesma tentativa: exatamente um a adquire e os outros recebem TENTATIVA_EM_USO', async () => {
    const raiz = novaRaiz();
    const programa = `const d = require(${JSON.stringify(path.join(RAIZ_BACKEND, 'src/services/imagem-backup-diario-execucao.service'))}); try { d.adquirirTentativa({ raiz: ${JSON.stringify(raiz)}, tentativaId: 't-9999' }); process.stdout.write('OK'); setTimeout(() => {}, 1500); } catch (e) { process.stdout.write(e.code); }`;
    const resultados = await Promise.all([1, 2, 3, 4].map(() => new Promise((resolver) => {
      const f = spawn(process.execPath, ['-e', programa], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
      registrar(f.pid);
      let saida = '';
      f.stdout.on('data', (b) => { saida += b.toString('utf8'); });
      f.on('exit', () => resolver(saida));
    })));
    assert.equal(resultados.filter((x) => x === 'OK').length, 1, JSON.stringify(resultados));
    assert.equal(resultados.filter((x) => x === 'TENTATIVA_EM_USO').length, 3);
  });
});
