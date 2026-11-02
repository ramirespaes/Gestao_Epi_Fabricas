'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { ErroDeJanela, TIPOS } = require('../../src/utils/janela-escrita-imagens');
const { executarBackup } = require('../../src/services/imagem-backup.service');
const { supervisionar } = require('../../src/services/imagem-backup-supervisor.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-INT-1): INTEGRAÇÃO entre o SUPERVISOR de processos e a TRAVA de janela do serviço de backup.
 * Só unitário e em memória: a trava é um objeto que imita o protocolo do módulo real; o supervisor é o REAL (GREEN-SUP-1C), alimentado por processo,
 * grupo, sinais e relógio falsos. Nenhum processo, disco, banco ou rede.
 *
 * Situação atual (lida, sem alterar): `executarBackup` aproveita só o `ok` de cada etapa e solta a trava sempre que a posse não está sabidamente
 * perdida; não há como o veredito do supervisor chegar até a decisão de liberar.
 *
 * CONTRATO PROVISÓRIO DE INTEGRAÇÃO (menor interface; nomes e códigos ainda NÃO aprovados; nenhuma API nova de produção foi criada):
 *   - a etapa que roda um processo supervisionado se declara com `supervisionada: true` (as demais continuam como hoje, sem nenhuma mudança);
 *   - o que essa etapa devolve leva `supervisao`: o próprio resultado de `supervisionar()`;
 *   - para uma etapa supervisionada, a trava SÓ pode ser solta se `supervisao.liberarTravaPermitido === true` (exatamente true); em qualquer outro caso
 *     (false, ausente, valor estranho, `supervisao` ausente, etapa que lança ou devolve resultado incompleto) a trava fica RETIDA: `liberar()` não é
 *     chamado, nenhuma etapa seguinte começa, `avaliar` não roda e o backup não é válido;
 *   - o avanço depois de uma etapa supervisionada exige `ok === true` E `supervisao.concluido === true`; `ok` verdadeiro com supervisão não concluída é
 *     falha da etapa (nunca sucesso), e a trava então só é solta se a supervisão a permitir;
 *   - resultado da trava retida: `janela: 'RETIDA'` (diferente de LIBERADA, PERDIDA e NAO_LIBERADA), saída 11 (a mesma do supervisor para estado
 *     desconhecido), `valido: false`, `recuperavel: false`, motivo `TRAVA_RETIDA_POR_SEGURANCA`; posse perdida continua prevalecendo (10, PERDIDA);
 *   - a retenção é intencional e definitiva para esta execução: nada a solta depois (nem pedido de parada, nem nova execução, nem prazo), e o resultado
 *     não expõe nenhuma função capaz de soltá-la; a recuperação é só pela pessoa, pelo procedimento controlado.
 */

const SAIDA = Object.freeze({ VALIDO: 0, JANELA_OCUPADA: 6, FALHA: 9, JANELA_PERDIDA: 10, RETIDA: 11, SIGTERM: 143 });
const VALIDO = () => ({ valido: true, motivos: [] });
const PGID = 9876;
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
const andar = async (vezes = 20) => { for (let i = 0; i < vezes; i += 1) await new Promise((resolver) => setImmediate(resolver)); };

/** Trava em memória com o protocolo do módulo real: um documento só, criação exclusiva, posse e liberação pelo token. */
function criarJanelaFalsa() {
  const linha = [];
  const estado = { documento: null, aquisicoes: 0, liberacoes: 0 };
  let proximo = 0;
  const janela = {
    async adquirir(argumentos) {
      estado.aquisicoes += 1;
      linha.push(`adquirir:${argumentos?.tipo}`);
      if (estado.documento !== null) throw new ErroDeJanela('JANELA_OCUPADA', { tipo: estado.documento.tipo, pid: 4242, iniciadoEm: '2026-10-21T03:00:00.000Z' });
      proximo += 1;
      const token = `token-${proximo}`;
      estado.documento = { tipo: argumentos.tipo, token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() {
          linha.push('confirmarPosse');
          return { confirmada: estado.documento !== null && estado.documento.token === token };
        },
        async liberar() {
          estado.liberacoes += 1;
          linha.push('liberar');
          if (estado.documento === null || estado.documento.token !== token) return { liberada: false };
          estado.documento = null;
          return { liberada: true };
        },
      });
    },
  };
  return {
    janela,
    estado,
    linha,
    trocarPorOutroDono: () => { estado.documento = { tipo: TIPOS.LIMPEZA, token: 'token-alheio' }; },
  };
}

/** O mundo falso de UM processo supervisionado: término, fluxos e grupo escolhidos pelo teste; o relógio nunca vence sozinho. */
function opcoesDoSupervisor({ termino = { codigo: 0, sinal: null }, vivos = false, parada } = {}) {
  return {
    async iniciar() { return { pgid: PGID, saida: Promise.resolve(termino), fluxosFechados: Promise.resolve() }; },
    grupo: { async vivos() { return vivos; } },
    sinais: { async enviar() { return true; } },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
    ...(parada ? { parada } : {}),
  };
}

const etapaComum = (linha, nome) => ({
  nome,
  async executar() { linha.push(`etapa:${nome}:inicio`); linha.push(`etapa:${nome}:fim`); return { ok: true }; },
});

/** O dump como etapa SUPERVISIONADA: roda o supervisor real e devolve o resultado dele em `supervisao`. */
function dumpSupervisionado(linha, mundo) {
  return {
    nome: 'dump',
    supervisionada: true,
    async executar() {
      linha.push('etapa:dump:inicio');
      const supervisao = await supervisionar(opcoesDoSupervisor(mundo));
      linha.push('etapa:dump:fim');
      return { ok: supervisao.concluido === true, supervisao };
    },
  };
}

/** O dump supervisionado com um resultado escolhido à mão (para informação incompleta ou estranha). */
function dumpComResultado(linha, devolver) {
  return {
    nome: 'dump',
    supervisionada: true,
    async executar() {
      linha.push('etapa:dump:inicio');
      const resultado = await devolver();
      linha.push('etapa:dump:fim');
      return resultado;
    },
  };
}

const etapas = (linha, dump) => [etapaComum(linha, 'snapshot'), dump, etapaComum(linha, 'copia')];
const comecou = (linha, nome) => linha.includes(`etapa:${nome}:inicio`);

function exigirRetida(resultado, t, rotulo) {
  assert.equal(t.estado.liberacoes, 0, `${rotulo}: liberar() NÃO pode ser chamado`);
  assert.notEqual(t.estado.documento, null, `${rotulo}: a trava continua no lugar`);
  assert.equal(resultado.janela, 'RETIDA', `${rotulo}: estado explícito de trava retida`);
  assert.equal(resultado.saida, SAIDA.RETIDA, `${rotulo}: saída 11`);
  assert.equal(resultado.valido, false, `${rotulo}: nunca válido`);
  assert.equal(resultado.recuperavel, false, `${rotulo}: nunca recuperável`);
  assert.ok(resultado.motivos.includes('TRAVA_RETIDA_POR_SEGURANCA'), `${rotulo}: motivo da retenção`);
}

describe('[INT] supervisor confirma o encerramento seguro: a execução segue e a trava é solta uma vez', () => {
  test('INT-01 — o dump supervisionado termina com tudo confirmado: a cópia roda, a avaliação roda, liberar() é chamado UMA vez e o backup é válido (saída 0)', async () => {
    const t = criarJanelaFalsa();
    let avaliado = false;
    const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dumpSupervisionado(t.linha, {})), avaliar: () => { avaliado = true; return VALIDO(); } });
    assert.ok(comecou(t.linha, 'copia'));
    assert.equal(avaliado, true);
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(t.estado.documento, null);
    assert.equal(r.saida, SAIDA.VALIDO);
    assert.equal(r.janela, 'LIBERADA');
  });

  test('INT-02 — o supervisor devolve falha COM o encerramento confirmado (código 1, grupo vazio, fluxos fechados: liberação permitida): a sequência para, a trava é solta UMA vez e o backup não é válido', async () => {
    const t = criarJanelaFalsa();
    const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dumpSupervisionado(t.linha, { termino: { codigo: 1, sinal: null } })), avaliar: VALIDO });
    assert.equal(comecou(t.linha, 'copia'), false);
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(r.valido, false);
    assert.equal(r.janela, 'LIBERADA');
    assert.notEqual(r.saida, SAIDA.VALIDO);
  });
});

describe('[INT] supervisor nega a liberação: a trava fica RETIDA', () => {
  test('INT-03 — descendente vivo (supervisor: saída 11, liberarTravaPermitido false): liberar() NÃO é chamado, a cópia não começa, a avaliação não roda e o backup não é declarado válido', async () => {
    const t = criarJanelaFalsa();
    let avaliado = false;
    const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dumpSupervisionado(t.linha, { vivos: true })), avaliar: () => { avaliado = true; return VALIDO(); } });
    exigirRetida(r, t, 'descendente vivo');
    assert.equal(comecou(t.linha, 'copia'), false, 'nenhuma etapa posterior');
    assert.equal(avaliado, false, 'nada é avaliado');
    assert.deepEqual(r.etapasExecutadas, ['snapshot', 'dump']);
  });

  test('INT-04 — a trava retida continua impedindo o que concorre com ela: a LIMPEZA é recusada (JANELA_OCUPADA) e um novo backup também (saída 6), sem tocar na trava retida', async () => {
    const t = criarJanelaFalsa();
    const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dumpSupervisionado(t.linha, { vivos: true })), avaliar: VALIDO });
    exigirRetida(r, t, 'retida');
    const retida = structuredClone(t.estado.documento);
    const limpeza = await t.janela.adquirir({ tipo: TIPOS.LIMPEZA }).then(() => null, (e) => e);
    assert.ok(limpeza instanceof ErroDeJanela && limpeza.codigo === 'JANELA_OCUPADA', 'a limpeza é recusada');
    const novaLinha = [];
    const novo = await executarBackup({ janela: t.janela, etapas: etapas(novaLinha, dumpSupervisionado(novaLinha, {})), avaliar: VALIDO });
    assert.equal(novo.saida, SAIDA.JANELA_OCUPADA, 'o novo backup é recusado');
    assert.equal(novaLinha.length, 0, 'nenhuma etapa do novo backup roda');
    assert.deepEqual(t.estado.documento, retida, 'a trava retida não mudou');
    assert.equal(t.estado.liberacoes, 0);
  });
});

describe('[INT] falha, interrupção ou informação incompleta do supervisor nunca libera por omissão', () => {
  for (const [rotulo, devolver] of [
    ['a etapa supervisionada lança', async () => { throw new Error('supervisão quebrou'); }],
    ['sem resultado', async () => undefined],
    ['ok sem supervisão', async () => ({ ok: true })],
    ['falha sem supervisão', async () => ({ ok: false })],
    ['supervisão nula', async () => ({ ok: false, supervisao: null })],
    ['liberação como texto', async () => ({ ok: false, supervisao: { concluido: false, liberarTravaPermitido: 'true', saida: 11, motivos: [] } })],
    ['liberação ausente', async () => ({ ok: false, supervisao: { concluido: false, saida: 11, motivos: [] } })],
    ['liberação falsa com ok verdadeiro', async () => ({ ok: true, supervisao: { concluido: true, liberarTravaPermitido: false, saida: 0, motivos: [] } })],
  ]) {
    test(`INT-05 (${rotulo}) — etapa supervisionada sem a liberação expressamente permitida: trava RETIDA, nenhuma etapa posterior`, async () => {
      const t = criarJanelaFalsa();
      const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dumpComResultado(t.linha, devolver)), avaliar: VALIDO });
      exigirRetida(r, t, rotulo);
      assert.equal(comecou(t.linha, 'copia'), false, `${rotulo}: a cópia não começa`);
    });
  }

  test('INT-06 — pedido de parada DURANTE a etapa supervisionada: se o supervisor nega a liberação (grupo vivo), a trava fica retida mesmo com a parada; se ele a permite, a trava é solta uma vez e o backup não é válido', async () => {
    const t1 = criarJanelaFalsa();
    const ouvintes = [];
    const paradaDoBackup = { aoPedir(f) { ouvintes.push(f); } };
    const pedir = (sinal) => { for (const f of ouvintes) f(sinal); };
    const dumpQuePara = (linha, mundo) => ({
      nome: 'dump',
      supervisionada: true,
      async executar() {
        linha.push('etapa:dump:inicio');
        const supervisao = await supervisionar(opcoesDoSupervisor({ ...mundo, parada: { aoPedir: (f) => { f('SIGTERM'); } } }));
        pedir('SIGTERM');
        linha.push('etapa:dump:fim');
        return { ok: supervisao.concluido === true, supervisao };
      },
    });
    const r1 = await executarBackup({ janela: t1.janela, etapas: etapas(t1.linha, dumpQuePara(t1.linha, { vivos: true })), avaliar: VALIDO, parada: paradaDoBackup });
    exigirRetida(r1, t1, 'parada com grupo vivo');

    const t2 = criarJanelaFalsa();
    ouvintes.length = 0;
    const r2 = await executarBackup({ janela: t2.janela, etapas: etapas(t2.linha, dumpQuePara(t2.linha, {})), avaliar: VALIDO, parada: paradaDoBackup });
    assert.equal(t2.estado.liberacoes, 1, 'parada com o encerramento confirmado: a trava é solta');
    assert.equal(r2.valido, false);
    assert.notEqual(r2.saida, SAIDA.VALIDO);
    assert.equal(r2.janela, 'LIBERADA');
  });

  test('INT-07 — ok verdadeiro com a supervisão NÃO concluída (mas liberação permitida): é falha da etapa, nunca sucesso; a cópia não começa e a trava é solta uma vez', async () => {
    const t = criarJanelaFalsa();
    const devolver = async () => ({ ok: true, supervisao: { concluido: false, liberarTravaPermitido: true, saida: 9, motivos: ['PROCESSO_FALHOU'] } });
    const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dumpComResultado(t.linha, devolver)), avaliar: VALIDO });
    assert.equal(comecou(t.linha, 'copia'), false);
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(r.valido, false);
    assert.notEqual(r.saida, SAIDA.VALIDO);
  });
});

describe('[INT] o estado de trava retida é explícito e não autoriza remoção nem recuperação automática', () => {
  test('INT-08 — RETIDA é distinguível: não é LIBERADA, PERDIDA nem NAO_LIBERADA; a saída (11) não é a da posse perdida (10); e a posse continua comprovável pelo token', async () => {
    const t = criarJanelaFalsa();
    const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dumpSupervisionado(t.linha, { vivos: true })), avaliar: VALIDO });
    exigirRetida(r, t, 'distinguível');
    for (const outro of ['LIBERADA', 'PERDIDA', 'NAO_LIBERADA']) assert.notEqual(r.janela, outro);
    assert.notEqual(r.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(t.estado.documento.tipo, TIPOS.BACKUP, 'a trava retida é a do próprio backup');
  });

  test('INT-09 — a retenção não se desfaz sozinha: depois do resultado, nem o tempo, nem um pedido de parada tardio, nem novas execuções chamam liberar(); o resultado não expõe nenhuma função capaz de soltar a trava', async () => {
    const t = criarJanelaFalsa();
    const ouvintes = [];
    const r = await executarBackup({
      janela: t.janela,
      etapas: etapas(t.linha, dumpSupervisionado(t.linha, { vivos: true })),
      avaliar: VALIDO,
      parada: { aoPedir(f) { ouvintes.push(f); } },
    });
    exigirRetida(r, t, 'retida');
    for (const f of ouvintes) f('SIGTERM');
    await andar();
    for (let i = 0; i < 3; i += 1) await executarBackup({ janela: t.janela, etapas: etapas([], etapaComum([], 'dump')), avaliar: VALIDO });
    await andar();
    assert.equal(t.estado.liberacoes, 0, 'ninguém soltou a trava retida');
    assert.notEqual(t.estado.documento, null);
    const funcoes = Object.entries(r).filter(([, valor]) => typeof valor === 'function').map(([chave]) => chave);
    assert.deepEqual(funcoes, [], 'o resultado não carrega meio de soltar a trava');
  });

  test('INT-10 — precedência: a retenção pedida pelo supervisor não esconde a posse PERDIDA durante a etapa: saída 10, estado PERDIDA, e a trava alheia não é tocada', async () => {
    const t = criarJanelaFalsa();
    const dump = dumpComResultado(t.linha, async () => {
      t.trocarPorOutroDono();
      return { ok: false, supervisao: { concluido: false, liberarTravaPermitido: false, saida: 11, motivos: ['DESCENDENTES_ATIVOS'] } };
    });
    const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dump), avaliar: VALIDO });
    assert.equal(r.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(r.janela, 'PERDIDA');
    assert.equal(t.estado.liberacoes, 0);
    assert.deepEqual(t.estado.documento, { tipo: TIPOS.LIMPEZA, token: 'token-alheio' });
  });

  test('INT-11 — controle: etapas SEM a marca `supervisionada` continuam como hoje (falha de etapa comum ainda solta a trava uma vez)', async () => {
    const t = criarJanelaFalsa();
    const dump = { nome: 'dump', async executar() { t.linha.push('etapa:dump:inicio'); return { ok: false }; } };
    const r = await executarBackup({ janela: t.janela, etapas: etapas(t.linha, dump), avaliar: VALIDO });
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(r.valido, false);
  });
});
