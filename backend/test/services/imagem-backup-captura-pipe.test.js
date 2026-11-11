'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { criarCapturaDoDump } = require('../../src/services/imagem-backup-captura-dump.service');
const { criarLancadorComSpawn } = require('../../src/services/imagem-backup-pgdump-lancador.service');
const { criarControleDeProcesso } = require('../../src/services/imagem-backup-pgdump-controle-processo.service');
const { criarProcessoDoDump } = require('../../src/services/imagem-backup-pgdump.service');
const { criarJanelaDeBackup, ehJanelaDeBackup } = require('../../src/services/imagem-backup.service');
const { adquirirJanela, ehPosseDeJanela, lerJanela, ErroDeJanela } = require('../../src/utils/janela-escrita-imagens');

/**
 * CAPTURA ÍNTEGRA DO DUMP (stdout -> SHA-256 incremental -> arquivo exclusivo -> fsync), lançador em modo PIPE, serviço do dump, controle de processo e JANELA DE BACKUP RECONHECIDA. Arquivos temporários fictícios do próprio teste,
 * `spawn` falso, nenhum processo e nenhum PostgreSQL.
 */

const PREFIXO = 'gepi-cap-test-';
const raizes = [];
const teste = (nome, fn) => test(nome, { timeout: 20000 }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const r of raizes) if (path.dirname(r) === tmp && path.basename(r).startsWith(PREFIXO)) fs.rmSync(r, { recursive: true, force: true });
});
function novaRaiz() {
  const r = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(r, 0o700);
  raizes.push(r);
  return r;
}
function arquivoExclusivo() {
  const caminho = path.join(novaRaiz(), 'dump.custom');
  const descritor = fs.openSync(caminho, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  return { caminho, descritor, fechar: () => { try { fs.closeSync(descritor); } catch { /* já fechado */ } } };
}
const dados = (n, semente = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + semente) & 255));
const fluxo = (...pedacos) => { const s = new PassThrough(); setImmediate(() => { for (const p of pedacos) s.write(p); s.end(); }); return s; };

// ----------------------------------------------------------------------------------------------------------------------- captura
describe('[CAP-A] captura do stdout: integridade, escritas parciais, backpressure e fsync', () => {
  teste('CAP-A01 — vários pedaços binários: o hash incremental e a contagem são dos bytes RECEBIDOS, o arquivo é idêntico, o fsync roda e a evidência diz que NÃO atesta o conteúdo lógico', async () => {
    const f = arquivoExclusivo();
    const pedacos = [dados(70000, 1), dados(3, 2), Buffer.from([0, 255, 0, 10, 13]), dados(100000, 3)];
    const todo = Buffer.concat(pedacos);
    let fsyncs = 0;
    const sa = { escrever: fs.write, sincronizar: (fd, cb) => { fsyncs += 1; fs.fsync(fd, cb); } };
    const ev = await criarCapturaDoDump({ descritor: f.descritor, sistemaDeArquivos: sa }).consumir({ stdout: fluxo(...pedacos), stderr: new PassThrough() });
    f.fechar();
    assert.equal(ev.ok, true);
    assert.deepEqual([ev.bytesRecebidos, ev.bytesGravados], [todo.length, todo.length]);
    assert.equal(ev.sha256FluxoRecebido, sha(todo));
    assert.equal(sha(fs.readFileSync(f.caminho)), sha(todo));
    assert.equal(fsyncs, 1);
    assert.deepEqual([ev.fimDoFluxo, ev.fsyncConcluido, ev.atestaConteudoLogico, ev.origem], ['STDOUT_ENCERRADO_NORMALMENTE', true, false, 'STDOUT_DO_PG_DUMP']);
    assert.equal(Object.isFrozen(ev), true);
  });

  teste('CAP-A02 — ESCRITAS PARCIAIS: o sistema aceita só poucos bytes por chamada e nenhum byte é perdido nem duplicado', async () => {
    const f = arquivoExclusivo();
    const todo = dados(5000, 7);
    let chamadas = 0;
    const sa = { escrever: (fd, buf, off, len, pos, cb) => { chamadas += 1; fs.write(fd, buf, off, Math.min(len, 7), pos, cb); }, sincronizar: fs.fsync };
    const ev = await criarCapturaDoDump({ descritor: f.descritor, sistemaDeArquivos: sa }).consumir({ stdout: fluxo(todo), stderr: new PassThrough() });
    f.fechar();
    assert.equal(ev.ok, true);
    assert.ok(chamadas >= Math.ceil(todo.length / 7));
    assert.equal(sha(fs.readFileSync(f.caminho)), sha(todo));
    assert.equal(ev.sha256FluxoRecebido, sha(todo));
  });

  teste('CAP-A03 — BACKPRESSURE: com destino lento nunca há mais de uma escrita em curso e a origem é pausada; no fim, tudo foi gravado', async () => {
    const f = arquivoExclusivo();
    const todo = dados(400000, 5);
    let emCurso = 0;
    let maximo = 0;
    const sa = { escrever: (fd, buf, off, len, pos, cb) => { emCurso += 1; maximo = Math.max(maximo, emCurso); setTimeout(() => fs.write(fd, buf, off, len, pos, (...r) => { emCurso -= 1; cb(...r); }), 1); }, sincronizar: fs.fsync };
    const origem = new PassThrough({ highWaterMark: 1024 });
    let pausou = false;
    origem.on('pause', () => { pausou = true; });
    setImmediate(async () => { for (let i = 0; i < todo.length; i += 8192) { if (!origem.write(todo.subarray(i, i + 8192))) await new Promise((r) => origem.once('drain', r)); } origem.end(); });
    const ev = await criarCapturaDoDump({ descritor: f.descritor, sistemaDeArquivos: sa }).consumir({ stdout: origem, stderr: new PassThrough() });
    f.fechar();
    assert.equal(ev.ok, true);
    assert.equal(maximo, 1);
    assert.equal(pausou, true);
    assert.equal(sha(fs.readFileSync(f.caminho)), sha(todo));
  });

  const falhasDeEscrita = [
    ['erro de escrita', (fd, buf, off, len, pos, cb) => cb(new Error('disco')), 'ERRO_DE_ESCRITA'],
    ['exceção síncrona da escrita', () => { throw new Error('x'); }, 'ERRO_DE_ESCRITA'],
    ['escrita que devolve zero bytes', (fd, buf, off, len, pos, cb) => cb(null, 0), 'ESCRITA_INCOMPLETA'],
    ['escrita que devolve mais do que o pedido', (fd, buf, off, len, pos, cb) => cb(null, len + 1), 'ESCRITA_INCOMPLETA'],
    ['escrita que devolve valor inválido', (fd, buf, off, len, pos, cb) => cb(null, 'x'), 'ESCRITA_INCOMPLETA'],
  ];
  for (const [rotulo, escrever, motivo] of falhasDeEscrita) {
    teste(`CAP-A04 (${rotulo}) — falha fechada com ${motivo}; sem fsync e sem sucesso`, async () => {
      const f = arquivoExclusivo();
      let fsyncs = 0;
      const ev = await criarCapturaDoDump({ descritor: f.descritor, sistemaDeArquivos: { escrever, sincronizar: (fd, cb) => { fsyncs += 1; cb(); } } }).consumir({ stdout: fluxo(dados(100)), stderr: new PassThrough() });
      f.fechar();
      assert.deepEqual([ev.ok, ev.motivo, fsyncs], [false, motivo, 0]);
      assert.equal(Object.hasOwn(ev, 'sha256FluxoRecebido'), false, 'nenhum hash é entregue numa falha');
    });
  }

  teste('CAP-A05 — FALHA DE FSYNC (erro e exceção): FSYNC_FALHOU, mesmo com todos os bytes gravados', async () => {
    for (const sincronizar of [(fd, cb) => cb(new Error('fsync')), () => { throw new Error('x'); }]) {
      const f = arquivoExclusivo();
      const ev = await criarCapturaDoDump({ descritor: f.descritor, sistemaDeArquivos: { escrever: fs.write, sincronizar } }).consumir({ stdout: fluxo(dados(500)), stderr: new PassThrough() });
      f.fechar();
      assert.deepEqual([ev.ok, ev.motivo], [false, 'FSYNC_FALHOU']);
      assert.equal(ev.bytesRecebidos, ev.bytesGravados);
    }
  });

  teste('CAP-A06 — FLUXO: erro do stdout (ERRO_NO_FLUXO), fechamento prematuro (FECHAMENTO_PREMATURO), fluxo vazio (DUMP_VAZIO), fluxo em modo texto (FLUXO_NAO_BINARIO) e fluxo ausente (FLUXO_AUSENTE)', async () => {
    const casos = [];
    const comErro = new PassThrough();
    setImmediate(() => { comErro.write(dados(10)); comErro.destroy(new Error('quebrou')); });
    casos.push([comErro, 'ERRO_NO_FLUXO']);
    const prematuro = new PassThrough();
    setImmediate(() => { prematuro.write(dados(10)); prematuro.destroy(); });
    casos.push([prematuro, 'FECHAMENTO_PREMATURO']);
    casos.push([fluxo(), 'DUMP_VAZIO']);
    const texto = new PassThrough();
    texto.setEncoding('utf8');
    casos.push([texto, 'FLUXO_NAO_BINARIO']);
    casos.push([undefined, 'FLUXO_AUSENTE']);
    casos.push([{ on() {} }, 'FLUXO_AUSENTE']);
    for (const [stdout, motivo] of casos) {
      const f = arquivoExclusivo();
      const ev = await criarCapturaDoDump({ descritor: f.descritor }).consumir({ stdout, stderr: new PassThrough() });
      f.fechar();
      assert.deepEqual([ev.ok, ev.motivo], [false, motivo]);
    }
  });

  teste('CAP-A07 — o stderr é só consumido e contado: nada do conteúdo é retido nem exportado', async () => {
    const f = arquivoExclusivo();
    const stderr = new PassThrough();
    setImmediate(() => { stderr.write(Buffer.from('SEGREDO-NO-STDERR /Users/privado')); stderr.end(); });
    const ev = await criarCapturaDoDump({ descritor: f.descritor }).consumir({ stdout: fluxo(dados(64)), stderr });
    f.fechar();
    assert.equal(ev.ok, true);
    assert.equal(ev.stderrBytes, Buffer.byteLength('SEGREDO-NO-STDERR /Users/privado'));
    assert.equal(JSON.stringify(ev).includes('SEGREDO'), false);
  });

  teste('CAP-A08 — contrato estrito: descritor inválido, chaves extras, sistema de arquivos incompleto e segunda utilização são recusados', () => {
    for (const ruim of [undefined, {}, { descritor: 2 }, { descritor: '5' }, { descritor: 5, extra: 1 }, { descritor: 5, sistemaDeArquivos: {} }, { descritor: 5, sistemaDeArquivos: { escrever() {} } }]) assert.throws(() => criarCapturaDoDump(ruim), TypeError);
    const c = criarCapturaDoDump({ descritor: 9 });
    c.consumir({ stdout: undefined });
    assert.throws(() => c.consumir({ stdout: undefined }), TypeError);
  });
});

// ----------------------------------------------------------------------------------------------------------------------- lançador em modo PIPE
const ARGUMENTOS = ['--format=custom', '--no-password', '--snapshot=00000003-0000001B-1', '--dbname=gepi_cap'];
const AMBIENTE = { PGPASSFILE: '/tmp/senha-ficticia', PGHOST: '127.0.0.1', PGPORT: '5432', PGUSER: 'gepi_cap' };
const specPipe = (descritor, extra = {}) => ({ executavel: '/usr/bin/pg_dump', argumentos: ARGUMENTOS, ambiente: AMBIENTE, opcoes: { shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }, saida: { descritor }, ...extra });

function spawnDeDump({ pedacos = [dados(300)], fim = 'normal', codigo = 0, comStdout = true } = {}) {
  const chamadas = [];
  const spawn = (exe, args, opcoes) => {
    chamadas.push({ exe, args, opcoes });
    const filho = new EventEmitter();
    filho.pid = 8801;
    if (comStdout) { filho.stdout = new PassThrough(); filho.stderr = new PassThrough(); }
    setImmediate(() => {
      filho.emit('spawn');
      if (fim === 'pendente') { if (comStdout) filho.stdout.write(dados(10)); return; }
      if (comStdout) {
        for (const p of pedacos) filho.stdout.write(p);
        if (fim === 'prematuro') filho.stdout.destroy(); else if (fim === 'erro') filho.stdout.destroy(new Error('x')); else filho.stdout.end();
        filho.stderr.end();
      }
      filho.emit('exit', codigo, null);
      filho.emit('close', codigo, null);
    });
    return filho;
  };
  return { chamadas, spawn };
}

describe('[CAP-B] lançador do pg_dump em modo PIPE', () => {
  teste('CAP-B01 — spec PIPE válido: stdio pipe/pipe, o descritor do arquivo NÃO vai ao processo, os fluxos só fecham depois da captura (bytes, hash e fsync) e a evidência fica disponível', async () => {
    const f = arquivoExclusivo();
    const falso = spawnDeDump({ pedacos: [dados(40000), dados(50)] });
    const l = criarLancadorComSpawn({ spawn: falso.spawn });
    const proc = await l.lancar(specPipe(f.descritor));
    assert.deepEqual(falso.chamadas[0].opcoes.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(falso.chamadas[0].opcoes.shell, false);
    assert.equal(Object.values(falso.chamadas[0].opcoes).flat().includes(f.descritor), false);
    await proc.fluxosFechados;
    assert.deepEqual({ ...(await proc.saida) }, { codigo: 0, sinal: null });
    const ev = await l.capturaDaSaida();
    f.fechar();
    assert.equal(ev.ok, true);
    assert.equal(ev.sha256FluxoRecebido, sha(fs.readFileSync(f.caminho)));
    assert.equal(l.situacao()[0].fluxosFechados, true);
  });

  teste('CAP-B02 — saída 0 NÃO basta: com o stdout fechado prematuramente (ou com erro) os fluxos REJEITAM (CAPTURA_FALHOU) e o hash não é entregue', async () => {
    for (const fim of ['prematuro', 'erro']) {
      const f = arquivoExclusivo();
      const l = criarLancadorComSpawn({ spawn: spawnDeDump({ fim }).spawn });
      const proc = await l.lancar(specPipe(f.descritor));
      assert.deepEqual({ ...(await proc.saida) }, { codigo: 0, sinal: null }, 'o processo terminou com código 0');
      await assert.rejects(() => proc.fluxosFechados, (e) => e.code === 'CAPTURA_FALHOU');
      const ev = await l.capturaDaSaida();
      f.fechar();
      assert.equal(ev.ok, false);
      assert.equal(Object.hasOwn(ev, 'sha256FluxoRecebido'), false);
    }
  });

  teste('CAP-B03 — escrita/sincronização incompleta com saída 0: fluxos rejeitam; saída não zero: o código é preservado e a captura continua registrada', async () => {
    const f = arquivoExclusivo();
    const l = criarLancadorComSpawn({ spawn: spawnDeDump().spawn, sistemaDeArquivos: { escrever: fs.write, sincronizar: (fd, cb) => cb(new Error('fsync')) } });
    const proc = await l.lancar(specPipe(f.descritor));
    await assert.rejects(() => proc.fluxosFechados, (e) => e.code === 'CAPTURA_FALHOU');
    assert.equal((await l.capturaDaSaida()).motivo, 'FSYNC_FALHOU');
    f.fechar();
    const g = arquivoExclusivo();
    const l2 = criarLancadorComSpawn({ spawn: spawnDeDump({ codigo: 1 }).spawn });
    const proc2 = await l2.lancar(specPipe(g.descritor));
    await proc2.fluxosFechados;
    assert.deepEqual({ ...(await proc2.saida) }, { codigo: 1, sinal: null });
    g.fechar();
  });

  teste('CAP-B04 — processo sem stdout (FLUXO_AUSENTE) e processo que não fecha os fluxos (fluxos pendentes, nunca "fechados")', async () => {
    const f = arquivoExclusivo();
    const l = criarLancadorComSpawn({ spawn: spawnDeDump({ comStdout: false }).spawn });
    const proc = await l.lancar(specPipe(f.descritor));
    await assert.rejects(() => proc.fluxosFechados, (e) => e.code === 'CAPTURA_FALHOU');
    assert.equal((await l.capturaDaSaida()).motivo, 'FLUXO_AUSENTE');
    f.fechar();

    const g = arquivoExclusivo();
    const l2 = criarLancadorComSpawn({ spawn: spawnDeDump({ fim: 'pendente' }).spawn });
    const proc2 = await l2.lancar(specPipe(g.descritor));
    let resolvido = false;
    proc2.fluxosFechados.then(() => { resolvido = true; }, () => { resolvido = true; });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(resolvido, false);
    assert.equal(l2.situacao()[0].fluxosFechados, false);
    g.fechar();
  });

  const invalidos = [
    ['saida com stdio de arquivo', (fd) => specPipe(fd, { opcoes: { shell: false, detached: true, stdio: ['ignore', fd, 'ignore'] } })],
    ['stdio pipe sem saida', (fd) => { const s = specPipe(fd); delete s.saida; return s; }],
    ['stdout pipe e stderr ignorado', (fd) => specPipe(fd, { opcoes: { shell: false, detached: true, stdio: ['ignore', 'pipe', 'ignore'] } })],
    ['stdin pipe', (fd) => specPipe(fd, { opcoes: { shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] } })],
    ['stdio inherit', (fd) => specPipe(fd, { opcoes: { shell: false, detached: true, stdio: ['ignore', 'inherit', 'pipe'] } })],
    ['saida com chave extra', (fd) => specPipe(fd, { saida: { descritor: fd, caminho: '/tmp/x' } })],
    ['saida com descritor < 3', () => specPipe(2)],
    ['saida com descritor textual', () => specPipe('9')],
    ['chave livre no spec', (fd) => specPipe(fd, { env: { PATH: '/bin' } })],
    ['executável diferente', (fd) => specPipe(fd, { executavel: '/usr/bin/psql' })],
    ['argumento extra', (fd) => specPipe(fd, { argumentos: [...ARGUMENTOS, '--file=/tmp/x'] })],
    ['shell true', (fd) => specPipe(fd, { opcoes: { shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] } })],
  ];
  for (const [rotulo, montar] of invalidos) {
    teste(`CAP-B05 (${rotulo}) — SPEC_INVALIDO sem spawn: nenhum parâmetro livre substitui executável, ambiente, destino ou modo de saída`, async () => {
      const f = arquivoExclusivo();
      const falso = spawnDeDump();
      await assert.rejects(() => criarLancadorComSpawn({ spawn: falso.spawn }).lancar(montar(f.descritor)), (e) => e.code === 'SPEC_INVALIDO');
      assert.equal(falso.chamadas.length, 0);
      f.fechar();
    });
  }

  teste('CAP-B06 — o contrato legado (descritor direto) continua aceito e sem captura; sistema de arquivos inválido é recusado na construção', async () => {
    const f = arquivoExclusivo();
    const falso = spawnDeDump();
    const l = criarLancadorComSpawn({ spawn: falso.spawn });
    await l.lancar({ executavel: '/usr/bin/pg_dump', argumentos: ARGUMENTOS, ambiente: AMBIENTE, opcoes: { shell: false, detached: true, stdio: ['ignore', f.descritor, 'ignore'] } });
    assert.deepEqual(falso.chamadas[0].opcoes.stdio, ['ignore', f.descritor, 'ignore']);
    assert.equal(l.capturaDaSaida(), null);
    f.fechar();
    assert.throws(() => criarLancadorComSpawn({ spawn: falso.spawn, sistemaDeArquivos: { escrever() {} } }), TypeError);
  });
});

// ----------------------------------------------------------------------------------------------------------------------- controle de processo e serviço do dump
describe('[CAP-C] controle de processo e serviço do dump', () => {
  teste('CAP-C01 — o controle expõe a evidência da captura (nula antes do lançamento), aceita outro lançador supervisionado e recusa fábrica ou lançador inválidos', async () => {
    const f = arquivoExclusivo();
    const controle = criarControleDeProcesso({ spawn: spawnDeDump().spawn, observarGrupo: async () => false });
    assert.equal(controle.capturaDoDump(), null);
    const proc = await controle.lancador.lancar(specPipe(f.descritor));
    await proc.fluxosFechados;
    assert.equal((await controle.capturaDoDump()).ok, true);
    f.fechar();
    assert.throws(() => criarControleDeProcesso({ spawn: () => {}, observarGrupo: async () => false, criarLancador: 'x' }), TypeError);
    assert.throws(() => criarControleDeProcesso({ spawn: () => {}, observarGrupo: async () => false, criarLancador: () => ({}) }), TypeError);
  });

  const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
  const contexto = () => Object.freeze({ snapshotId: '00000003-0000001B-1', banco: Object.freeze({ nome: 'gepi_cap', oid: '16384' }), registros: Object.freeze({ padrao: Object.freeze([]), empresa: Object.freeze([]) }), plano: null });
  function dumpConfig(extra = {}) {
    const vistos = [];
    return {
      vistos,
      dump: {
        alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi_cap', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gepi_cap', oid: '16384' } },
        destino: { diretorio: '/var/backups/safework/imagens', nome: 'dump.pgdump' },
        lancador: { async lancar(spec) { vistos.push(spec); return { pid: 8901, saida: new Promise(() => {}), fluxosFechados: new Promise(() => {}) }; } },
        sistema: { async grupoVivo() { return false; }, async enviarSinal() { return true; } },
        arquivos: { async criarExclusivo() { return { descritor: 9, fechar() {} }; } },
        temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
        prazos: { ...PRAZOS },
        ...extra,
      },
    };
  }

  teste('CAP-C02 — modo PIPE_COM_HASH: o serviço pede stdio pipe/pipe e entrega o descritor do arquivo só como DESTINO da captura (campo `saida`); o modo padrão continua passando o descritor ao processo', async () => {
    const pipe = dumpConfig({ saida: 'PIPE_COM_HASH' });
    await criarProcessoDoDump({ contexto: contexto(), dump: pipe.dump }).iniciar();
    assert.deepEqual([...pipe.vistos[0].opcoes.stdio], ['ignore', 'pipe', 'pipe']);
    assert.deepEqual({ ...pipe.vistos[0].saida }, { descritor: 9 });
    const antigo = dumpConfig();
    await criarProcessoDoDump({ contexto: contexto(), dump: antigo.dump }).iniciar();
    assert.deepEqual([...antigo.vistos[0].opcoes.stdio], ['ignore', 9, 'ignore']);
    assert.equal(Object.hasOwn(antigo.vistos[0], 'saida'), false);
    const explicito = dumpConfig({ saida: 'DESCRITOR' });
    await criarProcessoDoDump({ contexto: contexto(), dump: explicito.dump }).iniciar();
    assert.deepEqual([...explicito.vistos[0].opcoes.stdio], ['ignore', 9, 'ignore']);
  });

  teste('CAP-C03 — modo de saída desconhecido ou não textual é recusado na construção, sem efeito', () => {
    for (const ruim of ['pipe', 'PIPE', 'ARQUIVO', 1, null, {}]) {
      const c = dumpConfig({ saida: ruim });
      assert.throws(() => criarProcessoDoDump({ contexto: contexto(), dump: c.dump }), TypeError, String(ruim));
      assert.equal(c.vistos.length, 0);
    }
  });
});

// ----------------------------------------------------------------------------------------------------------------------- janela de backup reconhecida
describe('[JAN] janela de escrita: capacidade reconhecida do ponto de integração autorizado', () => {
  const nova = () => {
    const raiz = novaRaiz();
    const imagens = path.join(raiz, 'imagens');
    fs.mkdirSync(imagens, { mode: 0o700 });
    const arquivo = path.join(raiz, 'janela.lock');
    return { raiz, imagens, arquivo, janela: criarJanelaDeBackup({ arquivo, raizArmazenamento: imagens }) };
  };

  teste('JAN-01 — a janela é RECONHECIDA; literal, clone e função não são; a posse devolvida é a GENUÍNA da trava, do tipo BACKUP', async () => {
    const j = nova();
    assert.equal(ehJanelaDeBackup(j.janela), true);
    for (const falso of [{ adquirir: async () => ({}) }, { ...j.janela }, async () => ({}), null, undefined, Object.create(j.janela)]) assert.equal(ehJanelaDeBackup(falso), false);
    const posse = await j.janela.adquirir({ tipo: 'BACKUP' });
    assert.equal(ehPosseDeJanela(posse), true);
    assert.equal(posse.tipo, 'BACKUP');
    assert.deepEqual(await posse.confirmarPosse(), { confirmada: true });
    assert.deepEqual(await posse.liberar(), { liberada: true });
  });

  teste('JAN-02 — só BACKUP, sem chaves extras: LIMPEZA, tipo inventado e entrada inválida são recusados antes de tocar a trava', async () => {
    const j = nova();
    for (const entrada of [{ tipo: 'LIMPEZA' }, { tipo: 'OUTRO' }, { tipo: 'BACKUP', extra: 1 }, {}, null, undefined, 'BACKUP']) {
      await assert.rejects(() => j.janela.adquirir(entrada), (e) => e instanceof ErroDeJanela && e.codigo === 'JANELA_TIPO_INVALIDO');
      assert.equal(fs.existsSync(j.arquivo), false, 'a trava não foi criada');
    }
    assert.throws(() => criarJanelaDeBackup({ arquivo: j.arquivo }), TypeError);
    assert.throws(() => criarJanelaDeBackup({ arquivo: j.arquivo, raizArmazenamento: j.imagens, extra: 1 }), TypeError);
  });

  teste('JAN-03 — EXCLUSÃO MÚTUA: aquisição duplicada do backup, backup depois da limpeza e limpeza depois do backup são recusados (JANELA_OCUPADA); a liberação reabre', async () => {
    const j = nova();
    const posse = await j.janela.adquirir({ tipo: 'BACKUP' });
    await assert.rejects(() => j.janela.adquirir({ tipo: 'BACKUP' }), (e) => e.codigo === 'JANELA_OCUPADA');
    await assert.rejects(() => adquirirJanela({ arquivo: j.arquivo, tipo: 'LIMPEZA', raizArmazenamento: j.imagens }), (e) => e.codigo === 'JANELA_OCUPADA');
    assert.deepEqual(await posse.liberar(), { liberada: true });
    const limpeza = await adquirirJanela({ arquivo: j.arquivo, tipo: 'LIMPEZA', raizArmazenamento: j.imagens });
    await assert.rejects(() => j.janela.adquirir({ tipo: 'BACKUP' }), (e) => e.codigo === 'JANELA_OCUPADA');
    await limpeza.liberar();
    const outra = await j.janela.adquirir({ tipo: 'BACKUP' });
    await outra.liberar();
  });

  teste('JAN-04 — POSSE REVOGADA: trava removida, substituída por outro dono (mesmo tipo, PID e instante) ou adulterada deixa de ser confirmada; a posse revogada não libera a trava de outro', async () => {
    const j = nova();
    const posse = await j.janela.adquirir({ tipo: 'BACKUP' });
    const original = fs.readFileSync(j.arquivo, 'utf8');
    fs.unlinkSync(j.arquivo);
    assert.deepEqual(await posse.confirmarPosse(), { confirmada: false });
    const alheio = JSON.parse(original);
    alheio.token = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(j.arquivo, `${JSON.stringify(alheio)}\n`, { mode: 0o600 });
    assert.deepEqual(await posse.confirmarPosse(), { confirmada: false }, 'mesmo tipo/PID/instante, outro token');
    await posse.liberar().catch(() => {});
    assert.equal(fs.existsSync(j.arquivo), true, 'a trava do outro dono continua');
    assert.equal((await lerJanela({ arquivo: j.arquivo })).tipo, 'BACKUP');
    fs.writeFileSync(j.arquivo, 'lixo');
    assert.deepEqual(await posse.confirmarPosse(), { confirmada: false });
    fs.unlinkSync(j.arquivo);
  });

  teste('JAN-05 — posse sem janela recusada: sem trava no disco nenhuma posse existe; o dono antigo (processo morto) não é removido por ninguém', async () => {
    const j = nova();
    const posse = await j.janela.adquirir({ tipo: 'BACKUP' });
    await posse.liberar();
    assert.deepEqual(await posse.confirmarPosse(), { confirmada: false }, 'depois de liberada, a posse não confirma');
    fs.writeFileSync(j.arquivo, `${JSON.stringify({ versao: 1, tipo: 'BACKUP', pid: 999999, hospedeiro: 'x', iniciadoEm: '2020-01-01T00:00:00.000Z', token: 'a'.repeat(32) })}\n`, { mode: 0o600 });
    await assert.rejects(() => j.janela.adquirir({ tipo: 'BACKUP' }), (e) => e.codigo === 'JANELA_OCUPADA');
    assert.equal(fs.existsSync(j.arquivo), true);
    fs.unlinkSync(j.arquivo);
  });
});
