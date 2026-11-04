'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { criarLancadorEstruturalComSpawn, criarLancadorEstruturalReal, LIMITE_DA_CAPTURA } = require('../../src/services/imagem-backup-estrutura-lancador.service');

/**
 * Lançador do `pg_restore --list` (CONS-03): contrato do módulo com um `spawn` SIMULADO (nenhum processo real; `pg_restore` nunca é executado). Só dados fictícios; o único arquivo é um descritor temporário
 * de teste para a "entrada padrão". A integração com o verificador e com o supervisor reais usa o mesmo `spawn` simulado.
 */

const PREFIXO = 'gepi-lanc-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});
const novaRaiz = () => { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO))); raizes.push(p); return p; };
function descritorDeTeste() {
  const arquivo = path.join(novaRaiz(), 'entrada.bin');
  fs.writeFileSync(arquivo, 'dump-ficticio');
  const fd = fs.openSync(arquivo, 'r');
  return { fd, fechar: () => { try { fs.closeSync(fd); } catch { /* já fechado */ } } };
}
const specValido = (fd, extras = {}) => ({
  executavel: '/usr/bin/pg_restore',
  argumentos: ['--list'],
  ambiente: {},
  opcoes: { shell: false, detached: true, stdio: [fd, 'pipe', 'ignore'] },
  ...extras,
});
const CABECALHO = ';\n; Archive created at 2026-10-23 10:00:00 -03\n;     dbname: gestao_secreta\n;     TOC Entries: 17\n;     Compression: -1\n;     Dump Version: 1.14-0\n;     Format: CUSTOM\n;     Integer: 4 bytes\n;\n';

/** Filho SIMULADO: emite os eventos no turno seguinte (os ouvintes são registrados de forma síncrona pelo lançador). */
function filhoFalso({ pid = 6001, termino = [0, null], texto = CABECALHO, aoSpawn = true, semStdout = false, erroAntes = false } = {}) {
  const filho = new EventEmitter();
  filho.pid = erroAntes ? undefined : pid;
  if (!semStdout) filho.stdout = new EventEmitter();
  setImmediate(() => {
    if (erroAntes) { filho.emit('error', Object.assign(new Error(SEGREDO), { code: 'ENOENT' })); return; }
    if (aoSpawn) filho.emit('spawn');
    setImmediate(() => {
      if (filho.stdout && texto) filho.stdout.emit('data', Buffer.from(texto, 'latin1'));
      filho.emit('exit', termino[0], termino[1]);
      setImmediate(() => filho.emit('close', termino[0], termino[1]));
    });
  });
  return filho;
}
function espiao(fabrica) {
  const chamadas = [];
  const spawn = (...a) => { chamadas.push(a); return fabrica(...a); };
  return { spawn, chamadas };
}
const teste = (nome, fn) => test(nome, { timeout: 15000 }, fn);

describe('[LE] spec estrito: nada é lançado com spec fora do contrato', () => {
  const invalidos = [
    ['executável que não é pg_restore', (fd) => specValido(fd, { executavel: '/usr/bin/pg_dump' })],
    ['executável relativo', (fd) => specValido(fd, { executavel: 'pg_restore' })],
    ['executável não canônico', (fd) => specValido(fd, { executavel: '/usr/bin/../bin/pg_restore' })],
    ['argumentos extras (--dbname)', (fd) => specValido(fd, { argumentos: ['--list', '--dbname=gestao_epi'] })],
    ['argumentos extras (arquivo)', (fd) => specValido(fd, { argumentos: ['--list', '/tmp/dump.custom'] })],
    ['sem --list', (fd) => specValido(fd, { argumentos: ['--help'] })],
    ['conexão por -d', (fd) => specValido(fd, { argumentos: ['-d'] })],
    ['ambiente com variável de conexão', (fd) => specValido(fd, { ambiente: { PGHOST: 'db.interno' } })],
    ['ambiente com senha', (fd) => specValido(fd, { ambiente: { PGPASSWORD: SEGREDO } })],
    ['ambiente com qualquer chave', (fd) => specValido(fd, { ambiente: { PATH: '/usr/bin' } })],
    ['shell true', (fd) => specValido(fd, { opcoes: { shell: true, detached: true, stdio: [fd, 'pipe', 'ignore'] } })],
    ['sem grupo próprio', (fd) => specValido(fd, { opcoes: { shell: false, detached: false, stdio: [fd, 'pipe', 'ignore'] } })],
    ['stdio com descritor pequeno', (fd) => specValido(fd, { opcoes: { shell: false, detached: true, stdio: [1, 'pipe', 'ignore'] } })],
    ['stdout ignorado', (fd) => specValido(fd, { opcoes: { shell: false, detached: true, stdio: [fd, 'ignore', 'ignore'] } })],
    ['stderr em pipe', (fd) => specValido(fd, { opcoes: { shell: false, detached: true, stdio: [fd, 'pipe', 'pipe'] } })],
    ['opção extra', (fd) => specValido(fd, { opcoes: { shell: false, detached: true, stdio: [fd, 'pipe', 'ignore'], env: {} } })],
    ['chave extra no spec', (fd) => specValido(fd, { extra: 1 })],
    ['spec nulo', () => null],
  ];
  for (const [rotulo, montar] of invalidos) {
    teste(`LE-01 (${rotulo}) — SPEC_INVALIDO, sem spawn`, async () => {
      const d = descritorDeTeste();
      try {
        const e = espiao(() => filhoFalso());
        const l = criarLancadorEstruturalComSpawn({ spawn: e.spawn });
        await assert.rejects(l.lancar(montar(d.fd)), (falha) => { assert.equal(falha.code, 'SPEC_INVALIDO'); assert.equal(String(falha.message).includes(SEGREDO), false); return true; });
        assert.equal(e.chamadas.length, 0);
        assert.equal(l.situacao().length, 0);
      } finally { d.fechar(); }
    });
  }
});

describe('[LE] lançamento, supervisão de eventos e captura restrita', () => {
  teste('LE-02 — caminho positivo: spawn UMA vez com --list, ambiente vazio, sem shell, grupo próprio e stdio [fd, pipe, ignore]; término e fluxos em promessas separadas; sumário restrito (formato e entradas), sem o nome do banco', async () => {
    const d = descritorDeTeste();
    try {
      const e = espiao(() => filhoFalso());
      const l = criarLancadorEstruturalComSpawn({ spawn: e.spawn });
      const processo = await l.lancar(specValido(d.fd));
      assert.equal(e.chamadas.length, 1);
      const [executavel, argumentos, opcoes] = e.chamadas[0];
      assert.equal(executavel, '/usr/bin/pg_restore');
      assert.deepEqual(argumentos, ['--list']);
      assert.deepEqual({ ...opcoes.env }, {});
      assert.deepEqual([opcoes.shell, opcoes.detached], [false, true]);
      assert.deepEqual(opcoes.stdio, [d.fd, 'pipe', 'ignore']);
      assert.equal(processo.pid, 6001);
      assert.deepEqual({ ...(await processo.saida) }, { codigo: 0, sinal: null });
      await processo.fluxosFechados;
      const resultado = await processo.resultado;
      assert.deepEqual({ ...resultado }, { formato: 'CUSTOM', entradas: 17, truncado: false });
      assert.equal(JSON.stringify(resultado).includes('gestao_secreta'), false, 'o nome do banco nunca é retido');
      assert.equal(Object.isFrozen(processo), true);
      assert.deepEqual(l.situacao().map((s) => [s.estado, s.terminou, s.fluxosFechados, s.grupoComprovado]), [['INICIADO', true, true, false]]);
    } finally { d.fechar(); }
  });

  teste('LE-03 — captura LIMITADA: a saída volumosa é lida e descartada além do limite (sem crescer a memória retida), o cabeçalho continua reconhecido e `truncado` é verdadeiro', async () => {
    const d = descritorDeTeste();
    try {
      const enorme = `${CABECALHO}${'; linha de sumário ficticia\n'.repeat(20000)}`;
      assert.ok(enorme.length > LIMITE_DA_CAPTURA * 4);
      const l = criarLancadorEstruturalComSpawn({ spawn: () => filhoFalso({ texto: enorme }) });
      const processo = await l.lancar(specValido(d.fd));
      const resultado = await processo.resultado;
      assert.equal(resultado.truncado, true);
      assert.deepEqual([resultado.formato, resultado.entradas], ['CUSTOM', 17]);
    } finally { d.fechar(); }
  });

  teste('LE-04 — formato diferente de CUSTOM, saída sem sumário ou lixo viram campos nulos (o verificador recusa); filho sem stdout observável não quebra o término', async () => {
    const d = descritorDeTeste();
    try {
      for (const [texto, formato, entradas] of [[';     Format: TAR\n;     TOC Entries: 3\n', 'TAR', 3], ['qualquer coisa sem sumário', null, null], ['', null, null]]) {
        const l = criarLancadorEstruturalComSpawn({ spawn: () => filhoFalso({ texto }) });
        const r = await (await l.lancar(specValido(d.fd))).resultado;
        assert.deepEqual([r.formato, r.entradas], [formato, entradas]);
      }
      const semStdout = criarLancadorEstruturalComSpawn({ spawn: () => filhoFalso({ semStdout: true }) });
      const processo = await semStdout.lancar(specValido(d.fd));
      assert.deepEqual({ ...(await processo.saida) }, { codigo: 0, sinal: null });
      assert.deepEqual({ ...(await processo.resultado) }, { formato: null, entradas: null, truncado: false });
    } finally { d.fechar(); }
  });

  teste('LE-05 — término por código diferente de zero e por sinal são entregues como são (a decisão é do supervisor), sem inventar sucesso', async () => {
    const d = descritorDeTeste();
    try {
      const a = await criarLancadorEstruturalComSpawn({ spawn: () => filhoFalso({ termino: [1, null], texto: '' }) }).lancar(specValido(d.fd));
      assert.deepEqual({ ...(await a.saida) }, { codigo: 1, sinal: null });
      const b = await criarLancadorEstruturalComSpawn({ spawn: () => filhoFalso({ termino: [null, 'SIGKILL'], texto: '' }) }).lancar(specValido(d.fd));
      assert.deepEqual({ ...(await b.saida) }, { codigo: null, sinal: 'SIGKILL' });
    } finally { d.fechar(); }
  });

  teste('LE-06 — falhas de início: spawn que lança e `error` sem pid = NAO_INICIADO; `spawn` com pid inválido = INICIO_INCONCLUSIVO; nada vaza a mensagem original', async () => {
    const d = descritorDeTeste();
    try {
      const lanca = criarLancadorEstruturalComSpawn({ spawn: () => { throw Object.assign(new Error(`${SEGREDO} /Users/privado`), { code: 'EACCES' }); } });
      await assert.rejects(lanca.lancar(specValido(d.fd)), (f) => { assert.equal(f.code, 'NAO_INICIADO'); assert.equal(`${f.message}${f.stack}`.includes(SEGREDO), false); return true; });
      assert.equal(lanca.situacao()[0].estado, 'NAO_INICIADO');
      assert.equal(lanca.situacao()[0].causa, 'EACCES');

      const semPid = criarLancadorEstruturalComSpawn({ spawn: () => filhoFalso({ erroAntes: true }) });
      await assert.rejects(semPid.lancar(specValido(d.fd)), (f) => f.code === 'NAO_INICIADO' && !String(f.message).includes(SEGREDO));

      const pidRuim = criarLancadorEstruturalComSpawn({ spawn: () => filhoFalso({ pid: 1 }) });
      await assert.rejects(pidRuim.lancar(specValido(d.fd)), (f) => f.code === 'INICIO_INCONCLUSIVO');
      assert.equal(pidRuim.situacao()[0].pid, null, 'nenhum pid inventado');

      const naoObservavel = criarLancadorEstruturalComSpawn({ spawn: () => ({ pid: 7000 }) });
      await assert.rejects(naoObservavel.lancar(specValido(d.fd)), (f) => f.code === 'INICIO_INCONCLUSIVO');
    } finally { d.fechar(); }
  });

  teste('LE-07 — nenhuma execução na construção nem no carregamento: construir o lançador não chama `spawn`; o módulo só importa `child_process` DENTRO de `criarLancadorEstruturalReal`', async () => {
    const e = espiao(() => filhoFalso());
    criarLancadorEstruturalComSpawn({ spawn: e.spawn });
    assert.equal(e.chamadas.length, 0);
    assert.throws(() => criarLancadorEstruturalComSpawn({}), TypeError);
    assert.throws(() => criarLancadorEstruturalComSpawn({ spawn: 1 }), TypeError);
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'imagem-backup-estrutura-lancador.service.js'), 'utf8');
    const topo = fonte.split('\n').filter((l) => /^\S/.test(l) && !l.startsWith('/*') && !l.startsWith(' *') && !l.startsWith('//'));
    assert.equal(topo.some((l) => l.includes('child_process')), false, 'nenhum import de child_process no nível de módulo');
    assert.equal((fonte.match(/require\('node:child_process'\)/g) ?? []).length - (fonte.match(/\* .*require\('node:child_process'\)/g) ?? []).length, 1, 'um único require, dentro da função real');
    // Construir o lançador REAL não lança processo nenhum (só escolhe o `spawn`); nenhum teste o usa para lançar.
    const real = criarLancadorEstruturalReal();
    assert.equal(typeof real.lancar, 'function');
    assert.deepEqual([...real.situacao()], []);
  });
});

describe('[LE] integração com o verificador estrutural e o supervisor reais (spawn simulado)', () => {
  const { criarVerificadorEstrutural } = require('../../src/services/imagem-backup-estrutura.service');
  const { criarObservadorDoDump } = require('../../src/services/imagem-backup-evidencia-dump.service');
  const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
  const BYTES = Buffer.from('dump-ficticio-0123456789-'.repeat(40));

  /** Observador REAL com um dump criado de verdade (arquivo temporário), pronto para T1. */
  async function observadorComDump() {
    const raiz = novaRaiz();
    let descritor;
    const observador = criarObservadorDoDump({
      arquivos: { criarExclusivo(spec) { descritor = fs.openSync(path.join(spec.diretorio, spec.nome), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo); return { descritor, fechar() { try { fs.closeSync(descritor); } catch { /* ok */ } } }; } },
      lancador: { lancar() { fs.writeSync(descritor, BYTES); return { pid: 4242, saida: Promise.resolve({ codigo: 0, sinal: null }), fluxosFechados: Promise.resolve() }; } },
      operacaoId: 'op-lanc-1',
    });
    const criado = await observador.arquivos.criarExclusivo({ diretorio: raiz, nome: 'dump.custom', modo: 0o600 });
    const processo = await observador.lancador.lancar({});
    await processo.saida; await processo.fluxosFechados;
    await new Promise((r) => setImmediate(r));
    criado.fechar();
    const t1 = await observador.observar();
    assert.equal(t1.ok, true);
    return observador;
  }
  const verificadorCom = (spawn, extras = {}) => criarVerificadorEstrutural({
    alvo: { executavel: '/usr/bin/pg_restore' },
    lancador: criarLancadorEstruturalComSpawn({ spawn }),
    sistema: { async grupoVivo() { return false; }, async enviarSinal() { return true; } },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
    ...extras,
  });

  teste('LE-08 — verificador + supervisor + lançador: sumário CUSTOM e saída 0 = estrutura ok, com entradas, vinculada ao artefato de T1; o `spawn` recebe a entrada padrão do MESMO arquivo e nenhum caminho', async () => {
    const observador = await observadorComDump();
    let spec = null;
    const spawn = (executavel, argumentos, opcoes) => { spec = { executavel, argumentos, opcoes, mesmo: fs.fstatSync(opcoes.stdio[0]).size === BYTES.length }; return filhoFalso(); };
    const e = await verificadorCom(spawn).verificar({ operacaoId: 'op-lanc-1', observador });
    assert.equal(e.ok, true);
    assert.deepEqual([e.formato, e.entradas, e.origem], ['CUSTOM', 17, 'PG_RESTORE_LIST_SUPERVISIONADO']);
    assert.equal(spec.mesmo, true);
    assert.deepEqual(spec.argumentos, ['--list']);
    assert.equal(JSON.stringify(spec.argumentos).includes(os.tmpdir()), false);
    assert.equal(JSON.stringify(e).includes('gestao_secreta'), false);
  });

  teste('LE-09 — falha fechada de ponta a ponta: saída 1, sinal, formato TAR, sumário sem entradas, spawn que lança e artefato sem T1 nunca produzem estrutura ok', async () => {
    const casos = [
      ['saída 1', () => filhoFalso({ termino: [1, null], texto: '' }), 'SAIDA_NAO_ZERO'],
      ['sinal', () => filhoFalso({ termino: [null, 'SIGKILL'], texto: '' }), 'SINAL'],
      ['formato TAR', () => filhoFalso({ texto: ';     Format: TAR\n;     TOC Entries: 3\n' }), 'SUMARIO_INVALIDO'],
      ['sem entradas', () => filhoFalso({ texto: ';     Format: CUSTOM\n;     TOC Entries: 0\n' }), 'SUMARIO_INVALIDO'],
      ['sem sumário', () => filhoFalso({ texto: '' }), 'SUMARIO_INVALIDO'],
      ['spawn lança', () => { throw new Error(SEGREDO); }, 'NAO_INICIADA'],
    ];
    for (const [rotulo, spawn, motivo] of casos) {
      const observador = await observadorComDump();
      const e = await verificadorCom(spawn).verificar({ operacaoId: 'op-lanc-1', observador });
      assert.equal(e.ok, false, rotulo);
      assert.equal(e.motivo, motivo, rotulo);
      assert.equal(JSON.stringify(e).includes(SEGREDO), false, rotulo);
    }
    const semT1 = criarObservadorDoDump({ arquivos: { criarExclusivo() {} }, lancador: { lancar() {} } });
    const e = await verificadorCom(() => filhoFalso()).verificar({ operacaoId: 'op-lanc-1', observador: semT1 });
    assert.equal(e.ok, false);
  });
});
