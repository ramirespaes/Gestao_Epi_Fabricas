'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarObservadorDoDump } = require('../../src/services/imagem-backup-evidencia-dump.service');
const { criarProcessoDoDump } = require('../../src/services/imagem-backup-pgdump.service');

/**
 * CONTRAPROVA-CONCORRENCIA-EVIDENCIA-DUMP-1: contraprovas focais do CONSUMO ÚNICO e da FALHA TERMINAL `SAIDA_NAO_ZERO` do observador de evidência física. O módulo de produção JÁ EXISTE: estes testes
 * avaliam o comportamento efetivo dele, sem alterá-lo, sem patch global de `fs` e sem interface nova. Só `fs` e `crypto` reais sobre arquivos fictícios em diretórios temporários exclusivos
 * (prefixo `gepi-concorrencia-test-`); o `pg_dump` é um double cujos eventos (saída e fluxos) são promessas controladas. Nenhum processo real, PostgreSQL ou imagem real.
 *
 * CONTRATO CONFIRMADO NO CÓDIGO: `evidencia()` é uma função assíncrona cuja parte SÍNCRONA (antes do primeiro `await`) confere `consumo !== 'LIVRE'` (-> JA_CONSUMIDA), avalia as recusas PREMATURAS
 * (NAO_OBSERVADO, PROCESSO_EM_ANDAMENTO, SAIDA_NAO_ZERO, FLUXOS_ABERTOS) SEM mudar o estado e, só então, reserva `consumo = 'EM_ANDAMENTO'`; o `finally` grava `CONSUMIDA` (nunca volta a LIVRE).
 * Logo: SAIDA_NAO_ZERO é uma recusa terminal classificada ANTES do consumo (não consome, não vira JA_CONSUMIDA), e repetida continua SAIDA_NAO_ZERO porque o término observado nunca muda.
 *
 * O QUE ESTES TESTES PODEM E NÃO PODEM OBSERVAR (sem inventar prova mais forte):
 *   - SOBREPOSIÇÃO REAL: a segunda chamada é feita enquanto a primeira ainda espera I/O de verdade (a promessa da primeira não liquidou quando a da segunda já resolveu: a continuação de uma `await`
 *     de promessa já resolvida roda em microtarefa, antes de qualquer callback de I/O). Isso NÃO é uma barreira controlada dentro da leitura: a interface não oferece ponto de controle, e criar um exigiria
 *     alterar produção ou o `fs` global;
 *   - NÚMERO de leituras físicas: não é observável diretamente. As provas são INDIRETAS: (a) um conjunto de chamadas simultâneas só produz um sucesso; (b) depois de uma falha de abertura causada por
 *     permissão de DIRETÓRIO (revertida em seguida, o arquivo intacto), uma nova leitura teria SUCESSO: receber JA_CONSUMIDA prova que não houve nova leitura; (c) depois de um sucesso, o arquivo é
 *     ALTERADO: uma nova leitura daria ARQUIVO_INSTAVEL, receber JA_CONSUMIDA prova que não houve; (d) com o diretório sem permissão, uma tentativa de abertura apareceria como LEITURA_FALHOU;
 *   - fechamento de descritores: contagem de `/dev/fd` antes e depois (observação, não prova absoluta); falha ao fechar o descritor próprio não pode ser injetada sem alterar `fs`: GARANTIA NÃO DEMONSTRADA.
 */

const PRAZO = 20000;
const PREFIXO = 'gepi-concorrencia-test-';
const NOME_DO_DUMP = 'dump-ficticio.custom';
const teste = (nome, fn, opcoes = {}) => test(nome, { timeout: PRAZO, ...opcoes }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const BYTES = Buffer.from('conteudo-ficticio-do-dump-0123456789'.repeat(300));
const SEM_PERMISSAO_DE_DIRETORIO = typeof process.getuid === 'function' && process.getuid() === 0 ? 'executando como root: chmod não restringe' : false;

// ------------------------------------------------------------------------------------------------------------------------------- infraestrutura
const pastas = [];
const operacoes = [];
function deferido() {
  let resolver;
  let rejeitar;
  const promessa = new Promise((res, rej) => { resolver = res; rejeitar = rej; });
  promessa.catch(() => {});
  return { promessa, resolver, rejeitar };
}
after(() => {
  for (const op of operacoes) {
    op.dSaida.resolver({ codigo: 0, sinal: null });
    op.dFluxos.resolver();
    try { if (op.criado) op.criado.fechar(); } catch { /* já fechado */ }
  }
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of pastas) {
    try { fs.chmodSync(p, 0o700); } catch { /* removido */ }
    if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
  }
});

const contexto = () => Object.freeze({ snapshotId: '00000003-0000001B-1', banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros: Object.freeze({}), plano: Object.freeze([]) });

async function operacao() {
  const diretorio = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(diretorio, 0o700);
  pastas.push(diretorio);
  const op = { diretorio, caminho: path.join(diretorio, NOME_DO_DUMP), dSaida: deferido(), dFluxos: deferido(), criado: null, descritorDoDump: null };
  const arquivos = {
    criarExclusivo(spec) {
      const descritor = fs.openSync(path.join(spec.diretorio, spec.nome), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo);
      let fechado = false;
      op.criado = { descritor, fechar() { if (!fechado) { fechado = true; fs.closeSync(descritor); } } };
      return op.criado;
    },
  };
  const lancador = { lancar(spec) { op.descritorDoDump = spec.opcoes.stdio[1]; return { pid: 4242, saida: op.dSaida.promessa, fluxosFechados: op.dFluxos.promessa }; } };
  operacoes.push(op);
  op.observador = criarObservadorDoDump({ arquivos, lancador });
  const dump = {
    alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    destino: { diretorio, nome: NOME_DO_DUMP },
    lancador: op.observador.lancador,
    sistema: { grupoVivo: async () => true, enviarSinal: async () => false },
    arquivos: op.observador.arquivos,
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) },
    prazos: { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 },
  };
  op.iniciado = await criarProcessoDoDump({ contexto: contexto(), dump }).iniciar();
  op.escrever = (bytes) => fs.writeSync(op.descritorDoDump, bytes);
  op.encerrar = async ({ codigo = 0, sinal = null } = {}) => {
    op.dSaida.resolver({ codigo, sinal });
    await op.iniciado.saida;
    op.dFluxos.resolver();
    await op.iniciado.fluxosFechados;
  };
  return op;
}

function contarDescritores() {
  for (const pasta of ['/dev/fd', '/proc/self/fd']) {
    try { return fs.readdirSync(pasta).length; } catch { /* tenta o próximo */ }
  }
  return null;
}
const semDescritoresAbertosA_Mais = (antes, depois) => { if (antes !== null && depois !== null) assert.equal(depois, antes, 'o observador não deixa descritor próprio aberto'); };
const motivo = (r) => ({ ok: r.ok, motivo: r.motivo });

// ------------------------------------------------------------------------------------------------------------------------------- CON-01
describe('[CON-01] chamadas simultâneas na mesma instância: no máximo uma tentativa efetiva', () => {
  teste('CON-01a — a segunda chamada é feita enquanto a primeira ainda espera I/O real (a promessa da primeira NÃO liquidou): recebe JA_CONSUMIDA; a primeira conclui com a evidência correta; um único sucesso', async () => {
    const op = await operacao();
    op.escrever(BYTES);
    await op.encerrar();
    let primeiraLiquidou = false;
    const primeira = op.observador.evidencia().then((r) => { primeiraLiquidou = true; return r; });
    const segunda = await op.observador.evidencia();
    assert.equal(primeiraLiquidou, false, 'sobreposição real: a primeira leitura ainda não terminou quando a segunda foi recusada');
    assert.deepEqual(motivo(segunda), { ok: false, motivo: 'JA_CONSUMIDA' });
    const r1 = await primeira;
    assert.equal(r1.ok, true);
    assert.equal(r1.bytes, BYTES.length);
    assert.equal(r1.sha256Calculado, sha(BYTES));
  });

  teste('CON-01b — várias chamadas no mesmo instante (Promise.all): exatamente UM sucesso, o da primeira; todas as outras JA_CONSUMIDA; nenhum resultado positivo duplicado; nenhuma exceção', async () => {
    const op = await operacao();
    op.escrever(BYTES);
    await op.encerrar();
    const resultados = await Promise.all([1, 2, 3, 4, 5].map(() => op.observador.evidencia()));
    assert.equal(resultados.filter((r) => r.ok === true).length, 1);
    assert.equal(resultados[0].ok, true);
    for (const r of resultados.slice(1)) assert.deepEqual(motivo(r), { ok: false, motivo: 'JA_CONSUMIDA' });
    assert.equal(resultados[0].sha256Calculado, sha(BYTES));
  });

  teste('CON-01c — a primeira tentativa FALHA (arquivo vazio) enquanto a segunda chamada é recusada: a segunda é JA_CONSUMIDA, a primeira devolve seu motivo, e depois que a primeira liquida o estado continua consumido', async () => {
    const op = await operacao();
    await op.encerrar();
    const [r1, r2] = await Promise.all([op.observador.evidencia(), op.observador.evidencia()]);
    assert.deepEqual(motivo(r1), { ok: false, motivo: 'ARQUIVO_VAZIO' });
    assert.deepEqual(motivo(r2), { ok: false, motivo: 'JA_CONSUMIDA' });
    assert.deepEqual(motivo(await op.observador.evidencia()), { ok: false, motivo: 'JA_CONSUMIDA' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CON-02
describe('[CON-02] falha DEPOIS da reserva não reabre o consumo', () => {
  teste('CON-02a — falha de abertura real (diretório sem permissão) na primeira tentativa: LEITURA_FALHOU; o diretório volta ao normal e o arquivo está íntegro, mas a nova chamada é JA_CONSUMIDA (uma releitura teria SUCESSO: não houve repetição); sem descritor próprio aberto', { skip: SEM_PERMISSAO_DE_DIRETORIO }, async () => {
    const op = await operacao();
    op.escrever(BYTES);
    await op.encerrar();
    const antes = contarDescritores();
    fs.chmodSync(op.diretorio, 0o000);
    let r1;
    try { r1 = await op.observador.evidencia(); } finally { fs.chmodSync(op.diretorio, 0o700); }
    assert.deepEqual(motivo(r1), { ok: false, motivo: 'LEITURA_FALHOU' });
    assert.equal(JSON.stringify(r1).includes(op.diretorio), false);
    semDescritoresAbertosA_Mais(antes, contarDescritores());
    // controle da condição: o arquivo está legível e uma leitura nova seria possível
    assert.deepEqual(fs.readFileSync(op.caminho), BYTES);
    assert.deepEqual(motivo(await op.observador.evidencia()), { ok: false, motivo: 'JA_CONSUMIDA' });
    assert.deepEqual(motivo(await op.observador.evidencia()), { ok: false, motivo: 'JA_CONSUMIDA' });
  });

  teste('CON-02b — falha por IDENTIDADE (arquivo substituído) na primeira tentativa: a segunda é JA_CONSUMIDA mesmo que o original reapareça no caminho; nunca sucesso', async () => {
    const op = await operacao();
    op.escrever(BYTES);
    const reserva = path.join(op.diretorio, 'reserva-do-original');
    fs.linkSync(op.caminho, reserva);
    await op.encerrar();
    const substituto = path.join(op.diretorio, 'substituto');
    fs.writeFileSync(substituto, BYTES);
    fs.renameSync(substituto, op.caminho);
    assert.deepEqual(motivo(await op.observador.evidencia()), { ok: false, motivo: 'IDENTIDADE_DIVERGENTE' });
    fs.renameSync(reserva, op.caminho); // o inode original volta ao caminho
    const r2 = await op.observador.evidencia();
    assert.equal(r2.ok, false);
    assert.equal(r2.motivo, 'JA_CONSUMIDA');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CON-03
describe('[CON-03] consulta prematura não consome', () => {
  teste('CON-03 — com a saída pendente e depois com os fluxos abertos, consultas repetidas (inclusive simultâneas) são recusadas com o motivo correspondente e NÃO consomem; concluídos os eventos, a primeira tentativa efetiva ainda tem sucesso', async () => {
    const op = await operacao();
    op.escrever(BYTES);
    const duas = await Promise.all([op.observador.evidencia(), op.observador.evidencia()]);
    for (const r of duas) assert.deepEqual(motivo(r), { ok: false, motivo: 'PROCESSO_EM_ANDAMENTO' });
    op.dSaida.resolver({ codigo: 0, sinal: null });
    await op.iniciado.saida;
    for (const r of await Promise.all([op.observador.evidencia(), op.observador.evidencia()])) assert.deepEqual(motivo(r), { ok: false, motivo: 'FLUXOS_ABERTOS' });
    op.dFluxos.resolver();
    await op.iniciado.fluxosFechados;
    const r = await op.observador.evidencia();
    assert.equal(r.ok, true);
    assert.equal(r.sha256Calculado, sha(BYTES));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CON-04
describe('[CON-04] repetição após sucesso', () => {
  teste('CON-04 — depois do sucesso: JA_CONSUMIDA; a evidência anterior não muda; e mesmo ALTERANDO o arquivo depois, a nova chamada continua JA_CONSUMIDA (uma releitura daria ARQUIVO_INSTAVEL): não houve nova leitura; sem descritor próprio aberto', async () => {
    const op = await operacao();
    op.escrever(BYTES);
    await op.encerrar();
    const antes = contarDescritores();
    const primeira = await op.observador.evidencia();
    semDescritoresAbertosA_Mais(antes, contarDescritores());
    const copia = JSON.stringify(primeira);
    assert.equal(primeira.ok, true);
    assert.deepEqual(motivo(await op.observador.evidencia()), { ok: false, motivo: 'JA_CONSUMIDA' });
    fs.appendFileSync(op.caminho, Buffer.from('alteracao-posterior'));
    assert.deepEqual(motivo(await op.observador.evidencia()), { ok: false, motivo: 'JA_CONSUMIDA' });
    assert.equal(JSON.stringify(primeira), copia);
    assert.equal(Object.isFrozen(primeira), true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CON-05
describe('[CON-05] isolamento entre instâncias (em memória; NÃO é autenticidade)', () => {
  teste('CON-05 — o consumo de A não afeta B: consumos simultâneos de duas instâncias dão duas evidências diferentes e corretas; A consumida continua JA_CONSUMIDA sem impedir a primeira obtenção de B; a falha de B não altera A', async () => {
    const a = await operacao();
    const b = await operacao();
    const bytesA = Buffer.from('operacao-A'.repeat(70));
    const bytesB = Buffer.from('operacao-B'.repeat(90));
    a.escrever(bytesA);
    b.escrever(bytesB);
    await a.encerrar();
    await b.encerrar();
    const [ra, rb] = await Promise.all([a.observador.evidencia(), b.observador.evidencia()]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.equal(ra.sha256Calculado, sha(bytesA));
    assert.equal(rb.sha256Calculado, sha(bytesB));
    assert.notEqual(ra.sha256Calculado, rb.sha256Calculado);
    assert.equal(ra.bytes, bytesA.length);
    assert.equal(rb.bytes, bytesB.length);

    const c = await operacao();
    const d = await operacao();
    c.escrever(BYTES);
    d.escrever(BYTES);
    await c.encerrar();
    await d.encerrar();
    assert.equal((await c.observador.evidencia()).ok, true);
    assert.deepEqual(motivo(await c.observador.evidencia()), { ok: false, motivo: 'JA_CONSUMIDA' });
    fs.appendFileSync(d.caminho, Buffer.from('x')); // só D é alterado
    assert.deepEqual(motivo(await d.observador.evidencia()), { ok: false, motivo: 'ARQUIVO_INSTAVEL' });
    assert.deepEqual(motivo(await c.observador.evidencia()), { ok: false, motivo: 'JA_CONSUMIDA' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- CON-06
describe('[CON-06] SAIDA_NAO_ZERO: falha terminal observada ANTES do consumo; repetição nunca vira sucesso', () => {
  const terminais = [
    ['código de saída diferente de zero', { codigo: 1, sinal: null }],
    ['encerramento por sinal', { codigo: null, sinal: 'SIGKILL' }],
  ];
  for (const [rotulo, termino] of terminais) {
    teste(`CON-06 (${rotulo}) — primeira e segunda chamadas: SAIDA_NAO_ZERO (não JA_CONSUMIDA: nunca houve consumo); nenhuma abertura do arquivo (com o diretório sem permissão não surge LEITURA_FALHOU); nunca ok:true; restaurado o ambiente, uma terceira chamada continua SAIDA_NAO_ZERO`, { skip: SEM_PERMISSAO_DE_DIRETORIO }, async () => {
      const op = await operacao();
      op.escrever(BYTES);
      await op.encerrar(termino); // saída terminal de erro + fluxos fechados; o arquivo está completo e íntegro
      const antes = contarDescritores();
      fs.chmodSync(op.diretorio, 0o000);
      let r1;
      let r2;
      try {
        r1 = await op.observador.evidencia();
        r2 = await op.observador.evidencia();
      } finally { fs.chmodSync(op.diretorio, 0o700); }
      for (const r of [r1, r2]) {
        assert.deepEqual(Object.keys(r).sort(), ['motivo', 'ok']);
        assert.equal(r.ok, false);
        assert.equal(r.motivo, 'SAIDA_NAO_ZERO');
        assert.equal(Object.isFrozen(r), true);
        assert.equal(JSON.stringify(r).toLowerCase().includes('concluido'), false);
      }
      semDescritoresAbertosA_Mais(antes, contarDescritores());
      // com tudo restaurado e o arquivo legível, a falha terminal não vira sucesso por repetição
      assert.deepEqual(fs.readFileSync(op.caminho), BYTES);
      const r3 = await op.observador.evidencia();
      assert.deepEqual(motivo(r3), { ok: false, motivo: 'SAIDA_NAO_ZERO' });
      for (const r of await Promise.all([op.observador.evidencia(), op.observador.evidencia()])) assert.deepEqual(motivo(r), { ok: false, motivo: 'SAIDA_NAO_ZERO' });
    });
  }

  teste('CON-06b — DIFERENÇA: consulta PREMATURA (saída/fluxos pendentes) é recuperável quando as condições se satisfazem; FALHA TERMINAL (saída com erro) nunca é: mesmo com os fluxos fechados depois, o resultado permanece SAIDA_NAO_ZERO', async () => {
    const prematura = await operacao();
    prematura.escrever(BYTES);
    assert.deepEqual(motivo(await prematura.observador.evidencia()), { ok: false, motivo: 'PROCESSO_EM_ANDAMENTO' });
    await prematura.encerrar();
    assert.equal((await prematura.observador.evidencia()).ok, true);

    const terminal = await operacao();
    terminal.escrever(BYTES);
    terminal.dSaida.resolver({ codigo: 2, sinal: null });
    await terminal.iniciado.saida;
    assert.deepEqual(motivo(await terminal.observador.evidencia()), { ok: false, motivo: 'SAIDA_NAO_ZERO' });
    terminal.dFluxos.resolver();
    await terminal.iniciado.fluxosFechados;
    assert.deepEqual(motivo(await terminal.observador.evidencia()), { ok: false, motivo: 'SAIDA_NAO_ZERO' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- lacunas
describe('[LACUNAS] garantias NÃO demonstradas por estes testes', () => {
  const todo = (nome, motivoDoTodo) => test(nome, { todo: motivoDoTodo }, () => {});
  todo('CON-07 — leitura física mantida PENDENTE por barreira determinística dentro do módulo: a interface não oferece ponto de controle; a sobreposição provada é a de I/O real em andamento (CON-01a), sem barreira', 'sem seam de produção');
  todo('CON-08 — NÚMERO de leituras físicas efetuadas: não observável sem patch global do `fs`; só provas indiretas (CON-01b, CON-02a, CON-04, CON-06)', 'não observável');
  todo('CON-09 — falha ao FECHAR o descritor próprio e exceção síncrona durante a reserva: exigem injeção em `fs`/produção; o código trata o fechamento (LEITURA_FALHOU) e a reserva é síncrona sem chamadas que possam lançar, mas NÃO foi demonstrado por execução', 'não injetável sem alterar produção');
});
