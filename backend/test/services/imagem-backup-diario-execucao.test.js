'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6): REGISTRO DURÁVEL DE EXECUÇÃO (diário), TRAVAS DE TENTATIVA E DE RECURSO e RECONCILIAÇÃO. Só área privada de teste (diretório temporário 0700 criado por esta suíte),
 * dados fictícios, nenhum processo real, nenhum sinal, nenhum PostgreSQL. O sistema de arquivos é injetável para simular falha de gravação e de sincronização.
 *
 * Contrato exercitado (nomes do módulo `src/services/imagem-backup-diario-execucao.service`):
 *   iniciarTentativa({ raiz, tentativaId, runnerPid, sistema? })        -> diário do escritor `runner` (evento TENTATIVA_INICIADA gravado e sincronizado)
 *   abrirEscritor({ raiz, tentativaId, escritor, sistema? })            -> diário de outro escritor da MESMA tentativa (um arquivo por escritor; criação exclusiva)
 *   diario.registrar(tipo, dados)                                       -> síncrono e DURÁVEL (escrita completa + fsync); falha => diário envenenado e exceção (nada parcial é aceito)
 *   lerTentativa({ raiz, tentativaId })                                 -> leitura que REJEITA linha truncada, hash/sequência contraditórios e arquivo inseguro
 *   reconciliar({ raiz, tentativaId, observarProcesso })                -> { estado, liberaNovaTentativa, motivos, lancamentos } (estados: CONCLUIDA | EM_ANDAMENTO | PARCIAL | INCONCLUSIVA | BLOQUEADA)
 *   adquirirTentativa / adquirirRecursos / avaliarNovaTentativa / registrarResolucaoHumana
 * A observação de processo é uma PORTA: `observarProcesso(pid)` -> 'VIVO' | 'AUSENTE' | 'INCONCLUSIVO'. Resposta diferente disso, exceção ou ausência valem INCONCLUSIVO (nunca "morto").
 */

const MODULO = 'src/services/imagem-backup-diario-execucao.service';
const modulo = () => exigirModulo(MODULO);
const LANCAMENTO = 'a'.repeat(32);
const OUTRO_LANCAMENTO = 'b'.repeat(32);
const sempre = (valor) => async () => valor;

let base;
before(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-diario-'))); fs.chmodSync(base, 0o700); });
after(() => { fs.rmSync(base, { recursive: true, force: true }); });

let contador = 0;
function novaRaiz() {
  contador += 1;
  const raiz = path.join(base, `estado-${contador}`);
  fs.mkdirSync(raiz, { mode: 0o700 });
  return raiz;
}
const tentativa = (n) => `t-${String(n).padStart(4, '0')}`;

function iniciar(raiz, id = tentativa(1), extra = {}) {
  return modulo().iniciarTentativa({ raiz, tentativaId: id, runnerPid: process.pid, ...extra });
}

/** Percorre um lançamento sintético completo e bem-sucedido (nenhum processo real): intenção -> sentinela -> cliente -> encerrado -> grupo vazio -> fim. */
function lancamentoCompleto(runner, sentinela, id = LANCAMENTO, { grupoVazio = true, comEncerramento = true } = {}) {
  runner.registrar('INTENCAO_LANCAMENTO', { lancamentoId: id, papel: 'pg_dump', executavel: 'pg_dump', nArgs: 4, argsSha256: 'c'.repeat(64) });
  runner.registrar('SENTINELA_LANCADA', { lancamentoId: id, sentinelaPid: 4101 });
  sentinela.registrar('SENTINELA_ATIVA', { lancamentoId: id, sentinelaPid: 4101 });
  sentinela.registrar('CLIENTE_LANCADO', { lancamentoId: id, clientePid: 4102 });
  if (comEncerramento) {
    sentinela.registrar('CLIENTE_ENCERRADO', { lancamentoId: id, codigo: 0, sinal: null });
    sentinela.registrar('GRUPO_VERIFICADO', { lancamentoId: id, vazio: grupoVazio });
    sentinela.registrar('SENTINELA_FIM', { lancamentoId: id, resultado: 'CONCLUIDO' });
  }
}

describe('DJ — registro durável: formato, durabilidade e leitura', () => {
  test('DJ-01 — cada evento é uma linha completa com sequência, encadeamento por hash e instante; o arquivo é 0600 e o diretório da tentativa 0700', () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    runner.registrar('INTENCAO_LANCAMENTO', { lancamentoId: LANCAMENTO, papel: 'pg_dump', executavel: 'pg_dump', nArgs: 4, argsSha256: 'c'.repeat(64) });
    const arquivo = path.join(raiz, 'tentativas', tentativa(1), 'runner.ndjson');
    assert.equal((fs.lstatSync(arquivo).mode & 0o777), 0o600);
    assert.equal((fs.lstatSync(path.dirname(arquivo)).mode & 0o777), 0o700);
    const texto = fs.readFileSync(arquivo, 'utf8');
    assert.ok(texto.endsWith('\n'));
    const linhas = texto.trimEnd().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(linhas.map((l) => l.n), [1, 2]);
    assert.deepEqual(linhas.map((l) => l.k), ['TENTATIVA_INICIADA', 'INTENCAO_LANCAMENTO']);
    assert.match(linhas[0].p, /^0{64}$/);
    assert.equal(linhas[1].p, linhas[0].h);
    for (const l of linhas) assert.match(l.h, /^[0-9a-f]{64}$/);
    const lido = modulo().lerTentativa({ raiz, tentativaId: tentativa(1) });
    assert.equal(lido.escritores.runner.estado, 'INTEGRO');
    assert.equal(lido.escritores.runner.eventos.length, 2);
  });

  test('DJ-02 — a intenção é sincronizada em disco ANTES de registrar() retornar (escrita completa + fsync do arquivo; fsync do diretório na criação)', () => {
    const raiz = novaRaiz();
    const passos = [];
    const sistema = {
      ...fs,
      writeSync: (fd, ...resto) => { passos.push('write'); return fs.writeSync(fd, ...resto); },
      fsyncSync: (fd) => { passos.push('fsync'); return fs.fsyncSync(fd); },
    };
    const runner = iniciar(raiz, tentativa(1), { sistema });
    passos.length = 0;
    runner.registrar('INTENCAO_LANCAMENTO', { lancamentoId: LANCAMENTO, papel: 'pg_dump', executavel: 'pg_dump', nArgs: 4, argsSha256: 'c'.repeat(64) });
    assert.deepEqual(passos, ['write', 'fsync']);
  });

  test('DJ-03 — escrita parcial do sistema operacional é completada; falha de escrita ou de fsync ENVENENA o diário: exceção, nenhum evento posterior é aceito e a leitura não toma o parcial por íntegro', () => {
    const raiz = novaRaiz();
    let falharFsync = false;
    const sistema = { ...fs, fsyncSync: (fd) => { if (falharFsync) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return fs.fsyncSync(fd); } };
    const runner = iniciar(raiz, tentativa(1), { sistema });
    falharFsync = true;
    assert.throws(() => runner.registrar('POSTGRES_INTENCAO', {}), (e) => e.code === 'DIARIO_NAO_DURAVEL');
    falharFsync = false;
    assert.throws(() => runner.registrar('POSTGRES_INTENCAO', {}), (e) => e.code === 'DIARIO_ENVENENADO');
    const parcial = novaRaiz();
    const r2 = iniciar(parcial, tentativa(1), { sistema: { ...fs, writeSync: (fd, buffer, deslocamento, tamanho) => fs.writeSync(fd, buffer, deslocamento, Math.min(tamanho, Math.max(1, Math.floor(tamanho / 3)))) } });
    r2.registrar('POSTGRES_INTENCAO', {});
    const lido = modulo().lerTentativa({ raiz: parcial, tentativaId: tentativa(1) });
    assert.equal(lido.escritores.runner.estado, 'INTEGRO');
    assert.deepEqual(lido.escritores.runner.eventos.map((e) => e.k), ['TENTATIVA_INICIADA', 'POSTGRES_INTENCAO']);
  });

  test('DJ-04 — (cenário 12) registro TRUNCADO: a última linha sem quebra de linha é marcada TRUNCADO e NUNCA aceita como evento íntegro', () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    runner.registrar('POSTGRES_INTENCAO', {});
    const arquivo = path.join(raiz, 'tentativas', tentativa(1), 'runner.ndjson');
    const inteiro = fs.readFileSync(arquivo);
    fs.writeFileSync(arquivo, inteiro.subarray(0, inteiro.length - 20));
    const lido = modulo().lerTentativa({ raiz, tentativaId: tentativa(1) });
    assert.equal(lido.escritores.runner.estado, 'TRUNCADO');
    assert.deepEqual(lido.escritores.runner.eventos.map((e) => e.k), ['TENTATIVA_INICIADA']);
  });

  test('DJ-05 — hash, sequência e encadeamento contraditórios são CONTRADITORIO (linha adulterada, linha removida do meio, linha duplicada, JSON inválido)', () => {
    const casos = {
      adulterada: (linhas) => { const o = JSON.parse(linhas[1]); o.d = { x: 1 }; linhas[1] = JSON.stringify(o); return linhas; },
      removida: (linhas) => { linhas.splice(1, 1); return linhas; },
      duplicada: (linhas) => { linhas.splice(2, 0, linhas[1]); return linhas; },
      invalida: (linhas) => { linhas[1] = '{nao-e-json'; return linhas; },
    };
    for (const [nome, mutar] of Object.entries(casos)) {
      const raiz = novaRaiz();
      const runner = iniciar(raiz);
      runner.registrar('POSTGRES_INTENCAO', {});
      runner.registrar('POSTGRES_IDENTIDADE', { pid: 4000, area: '/private/tmp/gepi-hom-0a0b0c0d' });
      const arquivo = path.join(raiz, 'tentativas', tentativa(1), 'runner.ndjson');
      const linhas = fs.readFileSync(arquivo, 'utf8').trimEnd().split('\n');
      fs.writeFileSync(arquivo, `${mutar(linhas).join('\n')}\n`);
      const lido = modulo().lerTentativa({ raiz, tentativaId: tentativa(1) });
      assert.equal(lido.escritores.runner.estado, 'CONTRADITORIO', nome);
    }
  });

  test('DJ-06 — arquivo inseguro (dono diferente do processo é simulado; permissão aberta; link simbólico) é recusado na leitura, nunca lido como íntegro', () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    runner.registrar('POSTGRES_INTENCAO', {});
    const arquivo = path.join(raiz, 'tentativas', tentativa(1), 'runner.ndjson');
    fs.chmodSync(arquivo, 0o644);
    assert.equal(modulo().lerTentativa({ raiz, tentativaId: tentativa(1) }).escritores.runner.estado, 'INSEGURO');
    fs.chmodSync(arquivo, 0o600);
    const alvo = path.join(path.dirname(arquivo), 'real.ndjson');
    fs.renameSync(arquivo, alvo);
    fs.symlinkSync(alvo, arquivo);
    assert.equal(modulo().lerTentativa({ raiz, tentativaId: tentativa(1) }).escritores.runner.estado, 'INSEGURO');
  });

  test('DJ-07 — dados proibidos não entram no registro: chave com senha, segredo, token, URL ou DSN, valor fora do formato, objeto aninhado e tipo de evento desconhecido são recusados', () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    const base = { lancamentoId: LANCAMENTO, papel: 'pg_dump', executavel: 'pg_dump', nArgs: 4, argsSha256: 'c'.repeat(64) };
    for (const ruim of [{ ...base, senha: 'x' }, { ...base, password: 'x' }, { ...base, token: 'x' }, { ...base, dsn: 'postgres://u:p@h/db' }, { ...base, argumentos: ['--dbname=x'] }, { ...base, executavel: '/Applications/Postgres.app/bin/pg_dump' }, { ...base, argsSha256: 'zz' }, { ...base, nArgs: -1 }, { ...base, extra: { a: 1 } }]) {
      assert.throws(() => runner.registrar('INTENCAO_LANCAMENTO', ruim), (e) => e.code === 'EVENTO_INVALIDO', JSON.stringify(Object.keys(ruim)));
    }
    assert.throws(() => runner.registrar('EVENTO_QUE_NAO_EXISTE', {}), (e) => e.code === 'EVENTO_INVALIDO');
    const lido = modulo().lerTentativa({ raiz, tentativaId: tentativa(1) });
    assert.equal(lido.escritores.runner.eventos.length, 1);
    assert.equal(lido.escritores.runner.estado, 'INTEGRO');
  });

  test('DJ-08 — um arquivo por escritor, criação exclusiva: o mesmo escritor não é aberto duas vezes (dois escritores concorrentes não intercalam linhas) e escritor de tentativa inexistente é recusado', () => {
    const raiz = novaRaiz();
    iniciar(raiz);
    const s1 = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
    assert.throws(() => modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` }), (e) => e.code === 'ESCRITOR_JA_EXISTE');
    assert.throws(() => modulo().abrirEscritor({ raiz, tentativaId: tentativa(9), escritor: 'sentinela-x' }), (e) => e.code === 'TENTATIVA_INEXISTENTE');
    assert.throws(() => modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: '../fora' }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    s1.registrar('SENTINELA_ATIVA', { lancamentoId: LANCAMENTO, sentinelaPid: 4101 });
    const lido = modulo().lerTentativa({ raiz, tentativaId: tentativa(1) });
    assert.deepEqual(Object.keys(lido.escritores).sort(), ['runner', `sentinela-${LANCAMENTO}`].sort());
  });
});

describe('DJ — reconciliação: nunca declara recuperação sem prova', () => {
  const ausente = async () => 'AUSENTE';

  test('DJ-10 — lançamento completo e confirmado (cliente encerrado, grupo confirmado vazio) com o fim da tentativa: CONCLUIDA e libera nova tentativa', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    const sentinela = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
    lancamentoCompleto(runner, sentinela);
    runner.registrar('TENTATIVA_FIM', { resultado: 'SUCESSO' });
    const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'CONCLUIDA');
    assert.equal(r.liberaNovaTentativa, true);
    assert.deepEqual(r.lancamentos.map((l) => l.estado), ['CONFIRMADO']);
  });

  test('DJ-11 — (cenário 11) o runner morre ENTRE a intenção e a identidade: "lançamento sem identidade comprovada" — INCONCLUSIVA, nenhum PID inventado, nova tentativa NÃO liberada', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    runner.registrar('INTENCAO_LANCAMENTO', { lancamentoId: LANCAMENTO, papel: 'pg_dump', executavel: 'pg_dump', nArgs: 4, argsSha256: 'c'.repeat(64) });
    const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'INCONCLUSIVA');
    assert.equal(r.liberaNovaTentativa, false);
    assert.ok(r.motivos.includes('LANCAMENTO_SEM_IDENTIDADE'));
    assert.equal(JSON.stringify(r).includes('"pid"'), false);
  });

  test('DJ-12 — falha de início COMPROVADA pelo runner (spawn lançou) resolve o lançamento; sem essa prova a intenção sozinha nunca vale "não iniciado"', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    runner.registrar('INTENCAO_LANCAMENTO', { lancamentoId: LANCAMENTO, papel: 'pg_dump', executavel: 'pg_dump', nArgs: 4, argsSha256: 'c'.repeat(64) });
    runner.registrar('LANCAMENTO_NAO_INICIADO', { lancamentoId: LANCAMENTO, codigo: 'SPAWN_LANCOU' });
    runner.registrar('TENTATIVA_FIM', { resultado: 'FALHA' });
    const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'CONCLUIDA');
    assert.deepEqual(r.lancamentos.map((l) => l.estado), ['NAO_INICIADO']);
  });

  test('DJ-13 — (cenário 9/10) supervisor (sentinela) morto com o cliente identificado e sem encerramento confirmado: AUTORIDADE_PERDIDA, INCONCLUSIVA, nada é sinalizado e a nova tentativa fica bloqueada', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    const sentinela = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
    lancamentoCompleto(runner, sentinela, LANCAMENTO, { comEncerramento: false });
    const consultas = [];
    const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: async (pid) => { consultas.push(pid); return pid === 4101 ? 'AUSENTE' : 'VIVO'; } });
    assert.equal(r.estado, 'INCONCLUSIVA');
    assert.ok(r.motivos.includes('AUTORIDADE_PERDIDA'));
    assert.equal(r.liberaNovaTentativa, false);
    assert.ok(consultas.includes(4101));
  });

  test('DJ-14 — sentinela ainda VIVA com o cliente em andamento: EM_ANDAMENTO (aguardar), nunca CONCLUIDA; a observação "viva" não é autoridade e não libera nada', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    const sentinela = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
    lancamentoCompleto(runner, sentinela, LANCAMENTO, { comEncerramento: false });
    const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: sempre('VIVO') });
    assert.equal(r.estado, 'EM_ANDAMENTO');
    assert.equal(r.liberaNovaTentativa, false);
  });

  test('DJ-15 — (cenário 4/32) falha, exceção ou resposta estranha da observação de processo é INCONCLUSIVO: nunca AUSENTE, nunca CONCLUIDA', async () => {
    for (const observar of [async () => { throw new Error('ps indisponivel'); }, async () => undefined, async () => 'MORTO', async () => null, async () => 0]) {
      const raiz = novaRaiz();
      const runner = iniciar(raiz);
      const sentinela = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
      lancamentoCompleto(runner, sentinela, LANCAMENTO, { comEncerramento: false });
      const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: observar });
      assert.equal(r.estado, 'INCONCLUSIVA');
      assert.equal(r.liberaNovaTentativa, false);
      assert.ok(r.motivos.includes('OBSERVACAO_INCONCLUSIVA'), 'a falha da observação é "inconclusiva", nunca "autoridade perdida" (que exige AUSENTE comprovado)');
      assert.equal(r.motivos.includes('AUTORIDADE_PERDIDA'), false);
      assert.equal(r.motivos.includes('RUNNER_MORTO_SEM_FIM'), false, 'o runner também não foi observado como morto');
    }
    const raiz = novaRaiz();
    iniciar(raiz);
    const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1) });
    assert.notEqual(r.estado, 'CONCLUIDA');
  });

  test('DJ-16 — (cenário 28) cliente encerrado MAS grupo com descendente (ou não confirmado): INCONCLUSIVA com motivo próprio; o encerramento do processo principal não conclui a operação', async () => {
    for (const [vazio, motivo] of [[false, 'DESCENDENTES_ATIVOS'], [null, 'GRUPO_NAO_CONFIRMADO']]) {
      const raiz = novaRaiz();
      const runner = iniciar(raiz);
      const sentinela = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
      lancamentoCompleto(runner, sentinela, LANCAMENTO, { grupoVazio: vazio });
      runner.registrar('TENTATIVA_FIM', { resultado: 'FALHA' });
      const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
      assert.equal(r.estado, 'INCONCLUSIVA');
      assert.ok(r.motivos.includes(motivo), motivo);
      assert.equal(r.liberaNovaTentativa, false);
    }
  });

  test('DJ-17 — (cenário 13/32) registro truncado ou contraditório na reconciliação mantém o estado bloqueante (INCONCLUSIVA / BLOQUEADA) e jamais conclui', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    runner.registrar('TENTATIVA_FIM', { resultado: 'SUCESSO' });
    const arquivo = path.join(raiz, 'tentativas', tentativa(1), 'runner.ndjson');
    const bruto = fs.readFileSync(arquivo);
    fs.writeFileSync(arquivo, bruto.subarray(0, bruto.length - 7));
    let r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'INCONCLUSIVA');
    assert.ok(r.motivos.includes('REGISTRO_TRUNCADO'));
    fs.writeFileSync(arquivo, bruto.toString('utf8').replace('SUCESSO', 'FALHA'));
    r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'BLOQUEADA');
    assert.ok(r.motivos.includes('REGISTRO_CONTRADITORIO'));
    assert.equal(r.liberaNovaTentativa, false);
  });

  test('DJ-18 — a reconciliação é idempotente e somente-leitura: duas execuções dão o mesmo resultado e o diretório não muda um byte', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    const sentinela = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
    lancamentoCompleto(runner, sentinela, LANCAMENTO, { comEncerramento: false });
    const retrato = () => JSON.stringify(fs.readdirSync(path.join(raiz, 'tentativas', tentativa(1))).sort().map((n) => [n, fs.readFileSync(path.join(raiz, 'tentativas', tentativa(1), n), 'utf8')]));
    const antes = retrato();
    const a = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: sempre('AUSENTE') });
    const b = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: sempre('AUSENTE') });
    assert.deepEqual(a, b);
    assert.equal(retrato(), antes);
  });

  test('DJ-19 — o PostgreSQL efêmero é do runner: runner morto sem encerramento comprovado da instância é INCONCLUSIVA (POSTGRES_SEM_AUTORIDADE); com POSTGRES_ENCERRADO comprovado, resolve', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    runner.registrar('POSTGRES_INTENCAO', {});
    runner.registrar('POSTGRES_IDENTIDADE', { pid: 4200, area: '/private/tmp/gepi-hom-0a0b0c0d' });
    let r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: async (pid) => (pid === process.pid ? 'AUSENTE' : 'VIVO') });
    assert.equal(r.estado, 'INCONCLUSIVA');
    assert.ok(r.motivos.includes('POSTGRES_SEM_AUTORIDADE'));
    runner.registrar('POSTGRES_ENCERRADO', { resultado: 'ENCERRADA' });
    runner.registrar('TENTATIVA_FIM', { resultado: 'SUCESSO' });
    r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'CONCLUIDA');
    const incerto = novaRaiz();
    const r2 = iniciar(incerto);
    r2.registrar('POSTGRES_INTENCAO', {});
    r2.registrar('POSTGRES_IDENTIDADE', { pid: 4200, area: '/private/tmp/gepi-hom-0a0b0c0d' });
    r2.registrar('POSTGRES_ENCERRADO', { resultado: 'ENCERRAMENTO_INCERTO' });
    r2.registrar('TENTATIVA_FIM', { resultado: 'FALHA' });
    assert.equal((await modulo().reconciliar({ raiz: incerto, tentativaId: tentativa(1), observarProcesso: ausente })).estado, 'INCONCLUSIVA');
  });

  test('DJ-20 — runner morto sem TENTATIVA_FIM com tudo resolvido é CONCLUIDA (recuperação concluída) com o motivo informativo RUNNER_MORTO_SEM_FIM; com o runner ainda vivo é EM_ANDAMENTO', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    const sentinela = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
    lancamentoCompleto(runner, sentinela);
    let r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'CONCLUIDA');
    assert.ok(r.motivos.includes('RUNNER_MORTO_SEM_FIM'));
    r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: async (pid) => (pid === process.pid ? 'VIVO' : 'AUSENTE') });
    assert.equal(r.estado, 'EM_ANDAMENTO');
  });
});

describe('DJ — concorrência, recursos exclusivos e liberação de novas tentativas', () => {
  const ausente = async () => 'AUSENTE';

  test('DJ-30 — (cenário 18) dois supervisores NÃO assumem a mesma tentativa: o segundo recebe TENTATIVA_EM_USO e nada é gravado por ele; a trava persiste ao processo que a criou', () => {
    const raiz = novaRaiz();
    const a = modulo().adquirirTentativa({ raiz, tentativaId: tentativa(1) });
    assert.throws(() => modulo().adquirirTentativa({ raiz, tentativaId: tentativa(1) }), (e) => e.code === 'TENTATIVA_EM_USO');
    assert.equal(fs.existsSync(path.join(raiz, 'travas', `tentativa-${tentativa(1)}.lock`)), true);
    a.liberar();
    assert.equal(fs.existsSync(path.join(raiz, 'travas', `tentativa-${tentativa(1)}.lock`)), false);
    assert.doesNotThrow(() => modulo().adquirirTentativa({ raiz, tentativaId: tentativa(1) }));
  });

  test('DJ-31 — (cenário 19) duas tentativas DIFERENTES não usam o mesmo recurso exclusivo (área, PGDATA, porta, destino): RECURSO_EM_USO, e o que a segunda já havia obtido é devolvido (tudo ou nada)', () => {
    const raiz = novaRaiz();
    const um = modulo().adquirirRecursos({ raiz, tentativaId: tentativa(1), recursos: [{ tipo: 'area', id: '/private/tmp/gepi-hom-0a0b0c0d' }, { tipo: 'porta', id: '55433' }] });
    assert.throws(() => modulo().adquirirRecursos({ raiz, tentativaId: tentativa(2), recursos: [{ tipo: 'pgdata', id: '/private/tmp/gepi-hom-1111aaaa/pgdata' }, { tipo: 'porta', id: '55433' }] }), (e) => e.code === 'RECURSO_EM_USO' && e.recurso === 'porta');
    assert.equal(fs.readdirSync(path.join(raiz, 'travas')).filter((n) => n.startsWith('recurso-')).length, 2);
    um.liberar();
    assert.doesNotThrow(() => modulo().adquirirRecursos({ raiz, tentativaId: tentativa(2), recursos: [{ tipo: 'pgdata', id: '/private/tmp/gepi-hom-1111aaaa/pgdata' }, { tipo: 'porta', id: '55433' }] }));
  });

  test('DJ-32 — recurso malformado (tipo desconhecido, id relativo ou com NUL, lista vazia ou repetida) é recusado antes de qualquer trava', () => {
    const raiz = novaRaiz();
    for (const recursos of [[], [{ tipo: 'qualquer', id: 'x' }], [{ tipo: 'area', id: 'relativo' }], [{ tipo: 'area', id: '/a\0b' }], [{ tipo: 'porta', id: '55433' }, { tipo: 'porta', id: '55433' }]]) {
      assert.throws(() => modulo().adquirirRecursos({ raiz, tentativaId: tentativa(1), recursos }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    }
    assert.equal(fs.existsSync(path.join(raiz, 'travas')) && fs.readdirSync(path.join(raiz, 'travas')).length, false);
  });

  test('DJ-33 — (cenário 20) trava remanescente de tentativa NÃO concluída impede a nova tentativa e NÃO é removida só porque o dono desapareceu; de tentativa CONCLUIDA pode ser liberada pelo recuperador, com registro', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz, tentativa(1));
    runner.registrar('POSTGRES_INTENCAO', {});
    modulo().adquirirRecursos({ raiz, tentativaId: tentativa(1), recursos: [{ tipo: 'porta', id: '55433' }] });
    await assert.rejects(modulo().liberarRecursosDeTentativaConcluida({ raiz, tentativaId: tentativa(1), observarProcesso: ausente }), (e) => e.code === 'TENTATIVA_NAO_CONCLUIDA');
    assert.throws(() => modulo().adquirirRecursos({ raiz, tentativaId: tentativa(2), recursos: [{ tipo: 'porta', id: '55433' }] }), (e) => e.code === 'RECURSO_EM_USO');
    runner.registrar('POSTGRES_IDENTIDADE', { pid: 4200, area: '/private/tmp/gepi-hom-0a0b0c0d' });
    runner.registrar('POSTGRES_ENCERRADO', { resultado: 'ENCERRADA' });
    runner.registrar('TENTATIVA_FIM', { resultado: 'SUCESSO' });
    const liberado = await modulo().liberarRecursosDeTentativaConcluida({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(liberado.liberados, 1);
    assert.doesNotThrow(() => modulo().adquirirRecursos({ raiz, tentativaId: tentativa(2), recursos: [{ tipo: 'porta', id: '55433' }] }));
    const lido = modulo().lerTentativa({ raiz, tentativaId: tentativa(1) });
    assert.ok(Object.values(lido.escritores).some((e) => e.eventos.some((ev) => ev.k === 'RECURSOS_LIBERADOS')));
  });

  test('DJ-34 — (cenário 22) tentativa anterior INCONCLUSIVA/BLOQUEADA/EM_ANDAMENTO impede nova tentativa; só CONCLUIDA (ou resolvida) libera; lista as pendentes com o estado', async () => {
    const raiz = novaRaiz();
    let r = await modulo().avaliarNovaTentativa({ raiz, observarProcesso: ausente });
    assert.deepEqual([r.liberada, r.tentativas.length], [true, 0]);
    const runner = iniciar(raiz, tentativa(1));
    runner.registrar('INTENCAO_LANCAMENTO', { lancamentoId: LANCAMENTO, papel: 'pg_dump', executavel: 'pg_dump', nArgs: 4, argsSha256: 'c'.repeat(64) });
    r = await modulo().avaliarNovaTentativa({ raiz, observarProcesso: ausente });
    assert.equal(r.liberada, false);
    assert.deepEqual(r.tentativas.map((t) => [t.tentativaId, t.estado]), [[tentativa(1), 'INCONCLUSIVA']]);
    assert.ok(r.motivos.includes('TENTATIVA_ANTERIOR_NAO_RESOLVIDA'));
    const limpa = novaRaiz();
    const ok = iniciar(limpa, tentativa(5));
    ok.registrar('TENTATIVA_FIM', { resultado: 'SUCESSO' });
    assert.equal((await modulo().avaliarNovaTentativa({ raiz: limpa, observarProcesso: ausente })).liberada, true);
    const ilegivel = novaRaiz();
    fs.mkdirSync(path.join(ilegivel, 'tentativas', 't-lixo'), { recursive: true, mode: 0o700 });
    assert.equal((await modulo().avaliarNovaTentativa({ raiz: ilegivel, observarProcesso: ausente })).liberada, false);
  });

  test('DJ-35 — resolução humana: só registra e só vale quando NENHUMA identidade registrada ainda é observada como viva ou inconclusiva; com processo vivo é recusada; o histórico permanece', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    const sentinela = modulo().abrirEscritor({ raiz, tentativaId: tentativa(1), escritor: `sentinela-${LANCAMENTO}` });
    lancamentoCompleto(runner, sentinela, LANCAMENTO, { comEncerramento: false });
    await assert.rejects(modulo().registrarResolucaoHumana({ raiz, tentativaId: tentativa(1), responsavel: 'ramires', observacao: 'conferido manualmente', observarProcesso: async () => 'VIVO' }), (e) => e.code === 'PROCESSO_REGISTRADO_AINDA_PRESENTE');
    await assert.rejects(modulo().registrarResolucaoHumana({ raiz, tentativaId: tentativa(1), responsavel: 'ramires', observacao: 'x', observarProcesso: async () => 'INCONCLUSIVO' }), (e) => e.code === 'PROCESSO_REGISTRADO_AINDA_PRESENTE');
    await assert.rejects(modulo().registrarResolucaoHumana({ raiz, tentativaId: tentativa(1), responsavel: '', observacao: 'x', observarProcesso: ausente }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    const registrado = await modulo().registrarResolucaoHumana({ raiz, tentativaId: tentativa(1), responsavel: 'ramires', observacao: 'processos conferidos fora do sistema', observarProcesso: ausente });
    assert.equal(registrado.registrado, true);
    const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'CONCLUIDA');
    assert.ok(r.motivos.includes('RESOLVIDA_POR_HUMANO'));
    const lido = modulo().lerTentativa({ raiz, tentativaId: tentativa(1) });
    assert.equal(lido.escritores.runner.eventos.filter((e) => e.k === 'INTENCAO_LANCAMENTO').length, 1);
  });

  test('DJ-36 — a resolução humana NÃO contorna adulteração: registro contraditório continua BLOQUEADA mesmo com resolução registrada', async () => {
    const raiz = novaRaiz();
    const runner = iniciar(raiz);
    runner.registrar('POSTGRES_INTENCAO', {});
    await modulo().registrarResolucaoHumana({ raiz, tentativaId: tentativa(1), responsavel: 'ramires', observacao: 'ok', observarProcesso: ausente });
    const arquivo = path.join(raiz, 'tentativas', tentativa(1), 'runner.ndjson');
    fs.writeFileSync(arquivo, fs.readFileSync(arquivo, 'utf8').replace('POSTGRES_INTENCAO', 'POSTGRES_IDENTIDADE'));
    const r = await modulo().reconciliar({ raiz, tentativaId: tentativa(1), observarProcesso: ausente });
    assert.equal(r.estado, 'BLOQUEADA');
  });
});
