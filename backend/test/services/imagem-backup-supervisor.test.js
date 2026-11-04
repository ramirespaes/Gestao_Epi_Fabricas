'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, SUP-1, fase RED): SUPERVISÃO do ciclo de vida de um processo externo (no futuro, o pg_dump).
 * Só unitário e determinístico: o processo, o grupo de processos, o envio de sinais e o relógio são objetos em memória; NENHUM subprocesso real é criado.
 * As esperas são barreiras controladas pelo teste (promessas resolvidas na hora certa), nunca `sleep`.
 *
 * Princípio: o fim do processo principal NÃO prova que acabou. Conclusão segura exige, juntos: saída 0 sem sinal, fluxos de saída fechados e a
 * ausência CONFIRMADA de processos no grupo. Enviar um sinal não prova a morte de ninguém. Sem a confirmação, a trava NÃO pode ser solta.
 *
 * CONTRATO PROVISÓRIO (nomes, campos, prazos e códigos ainda NÃO aprovados):
 *   src/services/imagem-backup-supervisor.service.js exporta `supervisionar(opcoes)` -> Promise<resultado>
 *   opcoes = {
 *     iniciar: async () => processo,          processo = { pgid: inteiro > 0, saida: Promise<{ codigo: inteiro|null, sinal: string|null }>,
 *                                                         fluxosFechados: Promise<void> }  (stdout/stderr encerrados)
 *     grupo:   { vivos: async (pgid) => true | false | null }   (true: há processo no grupo; false: confirmado vazio; null ou exceção: não confirmado)
 *     sinais:  { enviar: async (pgid, sinal) => boolean }       (sinal ao GRUPO inteiro; true = o envio foi aceito, o que NÃO prova a morte)
 *     temporizador: { prazo: (ms) => { promessa: Promise<void>, cancelar(): void }, intervalo: (ms) => Promise<void> }
 *       (RED-SUP-1A: todo prazo criado tem de estar CANCELADO quando a supervisão termina; um prazo que dispare depois do fim não provoca nada)
 *     prazos: { totalMs, cortesiaMs, intervaloGrupoMs, tentativasGrupo, consultaGrupoMs }
 *       (RED-SUP-1A: cada consulta ao grupo é limitada por `prazo(consultaGrupoMs)`; consulta que não responde no prazo vale como NÃO confirmada)
 *     parada (opcional): { aoPedir(funcao) },  repassarParada (opcional, padrão false)
 *   }
 *   - pedido de parada: anotado; o supervisor NÃO devolve o controle antes do fim do processo; por padrão não envia sinal (decisão Q2 da C2 pendente);
 *     com repassarParada: true envia o MESMO sinal ao grupo, uma vez só;
 *   - prazo total esgotado com o processo vivo: SIGTERM ao grupo, prazo de cortesia, SIGKILL ao grupo e ENTÃO a conferência do grupo; depois do
 *     SIGKILL o supervisor NÃO espera indefinidamente o fim do processo: decide pela conferência do grupo; (RED-SUP-1A) se o processo terminar e os
 *     fluxos fecharem DURANTE a cortesia, o SIGKILL NÃO é enviado, a cortesia é cancelada e o grupo é conferido; o resultado continua falha (9),
 *     porque houve prazo esgotado; `encerramentoForcado` = o supervisor enviou algum sinal de término; (RED-SUP-1C) a decisão do SIGKILL depende
 *     do TÉRMINO do processo principal, observado separadamente dos fluxos: término confirmado durante a cortesia cancela a cortesia e impede o
 *     SIGKILL mesmo com os fluxos ainda abertos (que então mantêm a trava: saída 11); processo ainda vivo ao fim da cortesia recebe SIGKILL mesmo
 *     com os fluxos já fechados;
 *   - depois do fim do processo: o grupo é consultado até `tentativasGrupo` vezes, separadas por `intervalo(intervaloGrupoMs)`; descendente vivo
 *     NUNCA é morto automaticamente (fica para a pessoa: C2);
 *   resultado = { saida, concluido, liberarTravaPermitido, encerramentoForcado, parada, codigoDoProcesso, sinalDoProcesso, motivos }
 *   - saída: 0 concluído; 1 o processo não pôde ser iniciado; 2 argumentos; 9 falha com o grupo CONFIRMADO vazio; 11 estado desconhecido
 *     (grupo vivo, não confirmado ou fluxos pendentes: trava mantida); 128 + número do sinal (parada) com o grupo confirmado vazio.
 *     Precedência: 11, depois 9, depois a parada.
 *   - `liberarTravaPermitido` só é true com o grupo confirmado vazio E os fluxos fechados; `concluido` só é true quando a saída é 0.
 *     (RED-SUP-1B) E com a confirmação POSITIVA e válida do término do processo principal (código inteiro, ou sinal): término pendente, promessa de
 *     término rejeitada ou término em formato inválido NÃO permitem a liberação, mesmo com o grupo vazio e os fluxos fechados (saída 11); o grupo
 *     vazio não substitui a confirmação do processo principal.
 *   - motivos: PROCESSO_FALHOU, TERMINADO_POR_SINAL, SAIDA_INDEFINIDA, FLUXOS_PENDENTES, DESCENDENTES_ATIVOS, GRUPO_NAO_CONFIRMADO, PRAZO_ESGOTADO,
 *     ENCERRAMENTO_FORCADO, PARADA_SOLICITADA, SINAL_NAO_ENVIADO, INICIO_FALHOU.
 *
 * CONDIÇÃO OBRIGATÓRIA DA INTEGRAÇÃO FUTURA (não testada aqui, onde o grupo é simulado): o processo tem de nascer em grupo próprio e isolado, e a
 * identidade desse grupo tem de ser protegida contra a reutilização do PGID pelo sistema (um PGID reaproveitado faria o supervisor consultar ou
 * sinalizar processos alheios). Sinal e consulta só valem para o grupo cuja identidade continua comprovada.
 */

const MODULO = 'src/services/imagem-backup-supervisor.service';
const supervisor = () => exigirModulo(MODULO);
const SAIDA = Object.freeze({ CONCLUIDO: 0, INICIO: 1, ARGUMENTOS: 2, FALHA: 9, DESCONHECIDO: 11, SIGINT: 130, SIGTERM: 143 });
const PGID = 4321;
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
/** Resposta do grupo que NUNCA chega (consulta bloqueada). */
const BLOQUEADA = Symbol('consulta bloqueada');

function adiado() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

/** Deixa a fila de microtarefas e de `setImmediate` andar até a condição valer (barreira determinística, sem relógio). */
async function ate(condicao, rotulo) {
  for (let i = 0; i < 200; i += 1) {
    if (condicao()) return;
    await new Promise((resolver) => setImmediate(resolver));
  }
  assert.fail(`a condição esperada não ocorreu: ${rotulo}`);
}

/**
 * Um processo, um grupo, sinais e um relógio, todos em memória. `vivos` é a fila de respostas do grupo (a última se repete; um Error é lançado;
 * BLOQUEADA nunca responde). `aoSigkill` permite simular o processo morrendo (ou não) quando recebe SIGKILL. O relógio é falso: cada prazo registra
 * se foi cancelado; `imediatos` lista durações (ms) cujos prazos vencem na hora, simulando o disparo do relógio sem tempo real.
 */
function criarMundo({ vivos = [false], enviarAceito = true, aoSigkill = null, iniciarFalha = null, processo = undefined, imediatos = [] } = {}) {
  const linha = [];
  const saida = adiado();
  const fluxos = adiado();
  const prazos = [];
  const fila = [...vivos];
  const ouvintes = [];
  const proc = processo !== undefined ? processo : { pgid: PGID, saida: saida.promessa, fluxosFechados: fluxos.promessa };
  const opcoes = {
    async iniciar() {
      linha.push('iniciar');
      if (iniciarFalha) throw iniciarFalha;
      return proc;
    },
    grupo: {
      async vivos(pgid) {
        linha.push(`vivos:${pgid}`);
        const resposta = fila.length > 1 ? fila.shift() : fila[0];
        if (resposta === BLOQUEADA) return new Promise(() => {});
        if (resposta instanceof Error) throw resposta;
        return resposta;
      },
    },
    sinais: {
      async enviar(pgid, sinal) {
        linha.push(`sinal:${pgid}:${sinal}`);
        if (sinal === 'SIGKILL' && aoSigkill) aoSigkill({ saida, fluxos });
        return enviarAceito;
      },
    },
    temporizador: {
      prazo(ms) {
        linha.push(`prazo:${ms}`);
        const d = { ...adiado(), ms, cancelado: false };
        prazos.push(d);
        if (imediatos.includes(ms)) d.resolver();
        return { promessa: d.promessa, cancelar() { d.cancelado = true; linha.push(`cancelar:${ms}`); } };
      },
      intervalo(ms) {
        linha.push(`intervalo:${ms}`);
        return Promise.resolve();
      },
    },
    prazos: { ...PRAZOS },
    parada: { aoPedir(funcao) { ouvintes.push(funcao); } },
  };
  return {
    opcoes,
    linha,
    prazos,
    terminar: (codigo = 0, sinal = null) => saida.resolver({ codigo, sinal }),
    fecharFluxos: () => fluxos.resolver(),
    pedir: (sinal) => { for (const ouvinte of ouvintes) ouvinte(sinal); },
    sinaisEnviados: () => linha.filter((evento) => evento.startsWith('sinal:')),
  };
}

/** Inicia a supervisão sem aguardar: o teste controla o mundo e acompanha se a promessa já terminou. */
function iniciarSupervisao(mundo, extra = {}) {
  const estado = { terminou: false, resultado: undefined };
  const promessa = supervisor().supervisionar({ ...mundo.opcoes, ...extra }).then((r) => { estado.terminou = true; estado.resultado = r; return r; });
  return { promessa, estado };
}

function exigirNaoSeguro(resultado, rotulo) {
  assert.equal(resultado.concluido, false, `${rotulo}: não pode ser concluído`);
  assert.notEqual(resultado.saida, SAIDA.CONCLUIDO, `${rotulo}: saída não pode ser 0`);
}

describe('[SUP] término normal: conclusão só com tudo comprovado', () => {
  test('SUP-01 — saída 0, fluxos fechados e grupo CONFIRMADO vazio: concluído, saída 0, trava pode ser solta, nenhum sinal enviado; o grupo é consultado DEPOIS do fim do processo e dos fluxos', async () => {
    const m = criarMundo({ vivos: [false] });
    const s = iniciarSupervisao(m);
    await ate(() => m.linha.includes('iniciar'), 'iniciar');
    assert.equal(m.linha.some((e) => e.startsWith('vivos:')), false, 'o grupo não é declarado vazio antes do fim do processo');
    m.terminar(0);
    m.fecharFluxos();
    const r = await s.promessa;
    assert.equal(r.saida, SAIDA.CONCLUIDO);
    assert.equal(r.concluido, true);
    assert.equal(r.liberarTravaPermitido, true);
    assert.equal(r.encerramentoForcado, false);
    assert.equal(r.codigoDoProcesso, 0);
    assert.deepEqual(r.motivos, []);
    assert.deepEqual(m.sinaisEnviados(), []);
    assert.ok(m.linha.includes(`vivos:${PGID}`), 'a ausência de processos no grupo foi consultada');
  });

  test('SUP-02 — o grupo ainda tem processo na primeira consulta e fica vazio na segunda: espera o intervalo, confirma e conclui', async () => {
    const m = criarMundo({ vivos: [true, false] });
    const s = iniciarSupervisao(m);
    m.terminar(0);
    m.fecharFluxos();
    const r = await s.promessa;
    assert.equal(r.concluido, true);
    assert.equal(r.liberarTravaPermitido, true);
    assert.equal(m.linha.filter((e) => e === `vivos:${PGID}`).length, 2);
    assert.ok(m.linha.includes(`intervalo:${PRAZOS.intervaloGrupoMs}`));
  });
});

describe('[SUP] o fim do processo principal NÃO basta', () => {
  test('SUP-03 — saída 0, mas DESCENDENTE vivo em todas as consultas: não concluído, saída 11, trava mantida, e o descendente NÃO é morto automaticamente', async () => {
    const m = criarMundo({ vivos: [true] });
    const s = iniciarSupervisao(m);
    m.terminar(0);
    m.fecharFluxos();
    const r = await s.promessa;
    exigirNaoSeguro(r, 'descendente vivo');
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('DESCENDENTES_ATIVOS'));
    assert.equal(m.linha.filter((e) => e === `vivos:${PGID}`).length, PRAZOS.tentativasGrupo);
    assert.deepEqual(m.sinaisEnviados(), [], 'nenhum sinal automático para os descendentes');
  });

  test('SUP-04 — saída 0, grupo vazio, mas os FLUXOS continuam abertos até o prazo: não concluído, saída 11, trava mantida (alguém ainda segura a saída)', async () => {
    const m = criarMundo({ vivos: [false] });
    const s = iniciarSupervisao(m);
    m.terminar(0);
    await ate(() => m.prazos.length >= 1, 'prazo total pedido');
    assert.equal(s.estado.terminou, false, 'sem os fluxos fechados não há conclusão');
    m.prazos[0].resolver();
    const r = await s.promessa;
    exigirNaoSeguro(r, 'fluxos pendentes');
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('FLUXOS_PENDENTES'));
  });
});

describe('[SUP] falha do processo', () => {
  for (const [rotulo, codigo, sinal, motivo] of [
    ['código 1', 1, null, 'PROCESSO_FALHOU'],
    ['código 2', 2, null, 'PROCESSO_FALHOU'],
    ['morto por SIGKILL', null, 'SIGKILL', 'TERMINADO_POR_SINAL'],
    ['morto por SIGSEGV', null, 'SIGSEGV', 'TERMINADO_POR_SINAL'],
  ]) {
    test(`SUP-05 (${rotulo}) — falha com o grupo CONFIRMADO vazio: não concluído, saída 9, e só então a trava pode ser solta`, async () => {
      const m = criarMundo({ vivos: [false] });
      const s = iniciarSupervisao(m);
      m.terminar(codigo, sinal);
      m.fecharFluxos();
      const r = await s.promessa;
      exigirNaoSeguro(r, rotulo);
      assert.equal(r.saida, SAIDA.FALHA);
      assert.equal(r.liberarTravaPermitido, true, 'o grupo foi confirmado vazio');
      assert.ok(r.motivos.includes(motivo));
    });
  }
});

describe('[SUP] pedido de parada: o supervisor mantém o controle', () => {
  test('SUP-06 — SIGTERM pedido durante a execução (sem repasse): nenhum sinal é enviado, o supervisor NÃO devolve o controle antes de o processo terminar, e o resultado não é concluído (143)', async () => {
    const m = criarMundo({ vivos: [false] });
    const s = iniciarSupervisao(m);
    await ate(() => m.linha.includes('iniciar'), 'iniciar');
    m.pedir('SIGTERM');
    for (let i = 0; i < 20; i += 1) await new Promise((resolver) => setImmediate(resolver));
    assert.equal(s.estado.terminou, false, 'não abandona o processo vivo');
    assert.deepEqual(m.sinaisEnviados(), [], 'sem repasse: nenhum sinal');
    m.terminar(0);
    m.fecharFluxos();
    const r = await s.promessa;
    exigirNaoSeguro(r, 'parada');
    assert.equal(r.saida, SAIDA.SIGTERM);
    assert.equal(r.parada, 'SIGTERM');
    assert.equal(r.liberarTravaPermitido, true);
    assert.ok(r.motivos.includes('PARADA_SOLICITADA'));
  });

  test('SUP-07 — SIGINT com repassarParada: o MESMO sinal vai ao GRUPO uma única vez (mesmo com dois pedidos), o supervisor espera o fim e a confirmação do grupo, saída 130', async () => {
    const m = criarMundo({ vivos: [false] });
    const s = iniciarSupervisao(m, { repassarParada: true });
    await ate(() => m.linha.includes('iniciar'), 'iniciar');
    m.pedir('SIGINT');
    m.pedir('SIGINT');
    await ate(() => m.sinaisEnviados().length >= 1, 'repasse');
    for (let i = 0; i < 20; i += 1) await new Promise((resolver) => setImmediate(resolver));
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGINT`]);
    assert.equal(s.estado.terminou, false);
    m.terminar(null, 'SIGINT');
    m.fecharFluxos();
    const r = await s.promessa;
    exigirNaoSeguro(r, 'parada repassada');
    assert.equal(r.saida, SAIDA.SIGINT);
    assert.equal(r.liberarTravaPermitido, true);
    assert.ok(m.linha.indexOf(`vivos:${PGID}`) > m.linha.indexOf(`sinal:${PGID}:SIGINT`));
  });
});

describe('[SUP] prazo esgotado: sinal enviado não prova a morte', () => {
  test('SUP-08 — o processo não termina no prazo: SIGTERM ao grupo, prazo de cortesia, SIGKILL ao grupo, e SÓ DEPOIS a confirmação de grupo vazio; não concluído, saída 9, encerramento forçado', async () => {
    const m = criarMundo({ vivos: [false], aoSigkill: ({ saida, fluxos }) => { saida.resolver({ codigo: null, sinal: 'SIGKILL' }); fluxos.resolver(); } });
    const s = iniciarSupervisao(m);
    await ate(() => m.prazos.length >= 1, 'prazo total');
    assert.ok(m.linha.includes(`prazo:${PRAZOS.totalMs}`));
    m.prazos[0].resolver();
    await ate(() => m.sinaisEnviados().length >= 1, 'SIGTERM');
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`]);
    await ate(() => m.prazos.length >= 2, 'prazo de cortesia');
    assert.ok(m.linha.includes(`prazo:${PRAZOS.cortesiaMs}`));
    assert.equal(m.sinaisEnviados().length, 1, 'o SIGKILL espera a cortesia');
    m.prazos[1].resolver();
    const r = await s.promessa;
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`, `sinal:${PGID}:SIGKILL`]);
    assert.ok(m.linha.lastIndexOf(`vivos:${PGID}`) > m.linha.indexOf(`sinal:${PGID}:SIGKILL`), 'a confirmação vem depois do SIGKILL');
    exigirNaoSeguro(r, 'prazo esgotado');
    assert.equal(r.saida, SAIDA.FALHA);
    assert.equal(r.encerramentoForcado, true);
    assert.equal(r.liberarTravaPermitido, true);
    for (const motivo of ['PRAZO_ESGOTADO', 'ENCERRAMENTO_FORCADO']) assert.ok(r.motivos.includes(motivo), motivo);
  });

  test('SUP-09 — SIGKILL aceito, mas o grupo CONTINUA com processo: saída 11 e trava mantida (o envio do sinal não provou nada)', async () => {
    const m = criarMundo({ vivos: [true], aoSigkill: ({ saida, fluxos }) => { saida.resolver({ codigo: null, sinal: 'SIGKILL' }); fluxos.resolver(); } });
    const s = iniciarSupervisao(m);
    await ate(() => m.prazos.length >= 1, 'prazo total');
    m.prazos[0].resolver();
    await ate(() => m.prazos.length >= 2, 'cortesia');
    m.prazos[1].resolver();
    const r = await s.promessa;
    exigirNaoSeguro(r, 'grupo vivo depois do SIGKILL');
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('DESCENDENTES_ATIVOS'));
  });

  test('SUP-10 — prazo esgotado, os sinais são RECUSADOS, o processo nunca informa o fim e o grupo não pode ser confirmado: o supervisor não espera para sempre, saída 11, trava mantida, SINAL_NAO_ENVIADO', async () => {
    const m = criarMundo({ vivos: [null], enviarAceito: false });
    const s = iniciarSupervisao(m);
    await ate(() => m.prazos.length >= 1, 'prazo total');
    m.prazos[0].resolver();
    await ate(() => m.prazos.length >= 2, 'cortesia');
    m.prazos[1].resolver();
    const r = await s.promessa;
    exigirNaoSeguro(r, 'sinal recusado');
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('SINAL_NAO_ENVIADO'));
  });
});

describe('[SUP] sem confirmação do grupo não há liberação', () => {
  for (const [rotulo, resposta] of [['null (não confirmado)', null], ['exceção ao consultar', new Error('ps indisponível')], ['valor estranho', 'talvez']]) {
    test(`SUP-11 (${rotulo}) — saída 0 e fluxos fechados, mas o grupo não pode ser confirmado vazio: saída 11, trava mantida, GRUPO_NAO_CONFIRMADO`, async () => {
      const m = criarMundo({ vivos: [resposta] });
      const s = iniciarSupervisao(m);
      m.terminar(0);
      m.fecharFluxos();
      const r = await s.promessa;
      exigirNaoSeguro(r, rotulo);
      assert.equal(r.saida, SAIDA.DESCONHECIDO);
      assert.equal(r.liberarTravaPermitido, false);
      assert.ok(r.motivos.includes('GRUPO_NAO_CONFIRMADO'));
    });
  }
});

describe('[SUP] erros simultâneos e informação incompleta nunca viram sucesso', () => {
  test('SUP-12 — parada + código 1 + grupo não confirmado ao mesmo tempo: vale o mais grave (11), todos os motivos aparecem e a trava fica', async () => {
    const m = criarMundo({ vivos: [null] });
    const s = iniciarSupervisao(m);
    await ate(() => m.linha.includes('iniciar'), 'iniciar');
    m.pedir('SIGTERM');
    m.terminar(1);
    m.fecharFluxos();
    const r = await s.promessa;
    exigirNaoSeguro(r, 'erros simultâneos');
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    for (const motivo of ['PARADA_SOLICITADA', 'PROCESSO_FALHOU', 'GRUPO_NAO_CONFIRMADO']) assert.ok(r.motivos.includes(motivo), motivo);
  });

  test('SUP-13 — parada + código 1 com o grupo confirmado vazio: a falha (9) prevalece sobre a parada', async () => {
    const m = criarMundo({ vivos: [false] });
    const s = iniciarSupervisao(m);
    await ate(() => m.linha.includes('iniciar'), 'iniciar');
    m.pedir('SIGINT');
    m.terminar(1);
    m.fecharFluxos();
    const r = await s.promessa;
    assert.equal(r.saida, SAIDA.FALHA);
    assert.equal(r.concluido, false);
  });

  for (const [rotulo, saidaDoProcesso] of [['undefined', undefined], ['objeto vazio', {}], ['código como texto', { codigo: '0', sinal: null }], ['código e sinal nulos', { codigo: null, sinal: null }]]) {
    test(`SUP-14 (saída ${rotulo}) — informação de término incompleta nunca é sucesso: SAIDA_INDEFINIDA, não concluído`, async () => {
      const saida = adiado();
      const fluxos = adiado();
      const m = criarMundo({ vivos: [false], processo: { pgid: PGID, saida: saida.promessa, fluxosFechados: fluxos.promessa } });
      const s = iniciarSupervisao(m);
      saida.resolver(saidaDoProcesso);
      fluxos.resolver();
      const r = await s.promessa;
      exigirNaoSeguro(r, rotulo);
      assert.ok(r.motivos.includes('SAIDA_INDEFINIDA'));
    });
  }

  test('SUP-15 — o processo não pôde ser iniciado (exceção, ou manipulador sem pgid): saída 1, sem consulta ao grupo nem sinal, e a trava NÃO é declarada livre', async () => {
    for (const [rotulo, extra] of [
      ['iniciar lança', { iniciarFalha: Object.assign(new Error('spawn falhou'), { code: 'ENOENT' }) }],
      ['sem pgid', { processo: { saida: Promise.resolve({ codigo: 0, sinal: null }), fluxosFechados: Promise.resolve() } }],
    ]) {
      const m = criarMundo(extra);
      const r = await supervisor().supervisionar(m.opcoes);
      assert.equal(r.saida, SAIDA.INICIO, rotulo);
      assert.equal(r.concluido, false, rotulo);
      assert.equal(r.liberarTravaPermitido, false, `${rotulo}: sem pgid não se confirma nada`);
      assert.ok(r.motivos.includes('INICIO_FALHOU'), rotulo);
      assert.deepEqual(m.sinaisEnviados(), [], rotulo);
    }
  });

  test('SUP-16 — dependências ausentes ou prazos inválidos: recusa ANTES de iniciar (saída 2), nada é iniciado', async () => {
    const casos = {
      'sem grupo': (o) => ({ ...o, grupo: undefined }),
      'sem sinais': (o) => ({ ...o, sinais: undefined }),
      'sem temporizador': (o) => ({ ...o, temporizador: undefined }),
      'prazo total zero': (o) => ({ ...o, prazos: { ...PRAZOS, totalMs: 0 } }),
      'tentativas zero': (o) => ({ ...o, prazos: { ...PRAZOS, tentativasGrupo: 0 } }),
      'parada sem aoPedir': (o) => ({ ...o, parada: {} }),
    };
    for (const [rotulo, alterar] of Object.entries(casos)) {
      const m = criarMundo();
      const r = await supervisor().supervisionar(alterar(m.opcoes));
      assert.equal(r.saida, SAIDA.ARGUMENTOS, rotulo);
      assert.equal(r.liberarTravaPermitido, false, rotulo);
      assert.equal(m.linha.includes('iniciar'), false, `${rotulo}: nada é iniciado`);
    }
  });
});

/**
 * RED-SUP-1A. O limite de tempo de cada teste abaixo é só uma rede de segurança do executor (um supervisor que trave faz o teste FALHAR em vez de
 * prender a suíte); o comportamento testado usa apenas o relógio falso.
 */
const LIMITE_DO_TESTE = { timeout: 10000 };
const andar = async (vezes = 20) => { for (let i = 0; i < vezes; i += 1) await new Promise((resolver) => setImmediate(resolver)); };

describe('[SUP] reforço: cortesia, cancelamento dos prazos e consulta bloqueada (RED-SUP-1A)', () => {
  test('SUP-17 — término normal: TODO prazo criado (o total e os das consultas) fica cancelado, e um prazo que dispare depois do fim não provoca sinal nem nova consulta', LIMITE_DO_TESTE, async () => {
    const m = criarMundo({ vivos: [false] });
    const s = iniciarSupervisao(m);
    await ate(() => m.prazos.length >= 1, 'prazo total pedido');
    m.terminar(0);
    m.fecharFluxos();
    const r = await s.promessa;
    assert.equal(r.concluido, true);
    assert.equal(r.saida, SAIDA.CONCLUIDO);
    assert.ok(m.prazos.some((p) => p.ms === PRAZOS.totalMs), 'o prazo total existiu');
    for (const p of m.prazos) assert.equal(p.cancelado, true, `o prazo de ${p.ms} ms foi cancelado`);
    const consultasNoFim = m.linha.filter((e) => e.startsWith('vivos:')).length;
    for (const p of m.prazos) p.resolver();
    await andar();
    assert.deepEqual(m.sinaisEnviados(), [], 'disparo tardio não envia sinal');
    assert.equal(m.linha.filter((e) => e.startsWith('vivos:')).length, consultasNoFim, 'disparo tardio não consulta o grupo');
  });

  test('SUP-18 — o processo termina DURANTE a cortesia (depois do SIGTERM): o SIGKILL NÃO é enviado, a cortesia é cancelada, o grupo é conferido só depois do fim; resultado falha (9) por prazo esgotado, e a trava só é liberável com a confirmação', LIMITE_DO_TESTE, async () => {
    const m = criarMundo({ vivos: [false] });
    const s = iniciarSupervisao(m);
    await ate(() => m.prazos.length >= 1, 'prazo total');
    m.prazos[0].resolver();
    await ate(() => m.sinaisEnviados().length >= 1, 'SIGTERM');
    await ate(() => m.prazos.some((p) => p.ms === PRAZOS.cortesiaMs), 'cortesia');
    await andar();
    assert.equal(s.estado.terminou, false, 'não decide antes de o processo terminar ou a cortesia vencer');
    assert.equal(m.linha.some((e) => e.startsWith('vivos:')), false, 'nenhuma confirmação de grupo antes do fim do processo');
    m.terminar(null, 'SIGTERM');
    m.fecharFluxos();
    const r = await s.promessa;
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`], 'sem SIGKILL desnecessário');
    const cortesia = m.prazos.find((p) => p.ms === PRAZOS.cortesiaMs);
    assert.equal(cortesia.cancelado, true, 'a cortesia foi cancelada');
    cortesia.resolver();
    await andar();
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`], 'a cortesia vencendo depois do fim não envia SIGKILL');
    assert.ok(m.linha.indexOf(`vivos:${PGID}`) > m.linha.indexOf(`sinal:${PGID}:SIGTERM`), 'a confirmação vem depois');
    exigirNaoSeguro(r, 'fim durante a cortesia');
    assert.equal(r.saida, SAIDA.FALHA);
    assert.equal(r.encerramentoForcado, true, 'o supervisor enviou SIGTERM');
    assert.equal(r.liberarTravaPermitido, true, 'grupo confirmado vazio e fluxos fechados');
    assert.ok(r.motivos.includes('PRAZO_ESGOTADO'));
  });

  test('SUP-19 — depois do SIGKILL a consulta grupo.vivos() NUNCA responde: a supervisão termina de forma limitada (cada consulta tem prazo), saída 11, trava mantida, GRUPO_NAO_CONFIRMADO; o SIGKILL enviado não prova a ausência de processos', LIMITE_DO_TESTE, async () => {
    const m = criarMundo({
      vivos: [BLOQUEADA],
      imediatos: [PRAZOS.consultaGrupoMs],
      aoSigkill: ({ saida, fluxos }) => { saida.resolver({ codigo: null, sinal: 'SIGKILL' }); fluxos.resolver(); },
    });
    const s = iniciarSupervisao(m);
    await ate(() => m.prazos.length >= 1, 'prazo total');
    m.prazos[0].resolver();
    await ate(() => m.prazos.some((p) => p.ms === PRAZOS.cortesiaMs), 'cortesia');
    m.prazos.find((p) => p.ms === PRAZOS.cortesiaMs).resolver();
    const r = await s.promessa;
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`, `sinal:${PGID}:SIGKILL`]);
    exigirNaoSeguro(r, 'consulta bloqueada');
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false);
    assert.ok(r.motivos.includes('GRUPO_NAO_CONFIRMADO'));
    const consultas = m.linha.filter((e) => e === `vivos:${PGID}`).length;
    assert.ok(consultas >= 1 && consultas <= PRAZOS.tentativasGrupo, `consultas limitadas (${consultas})`);
    assert.ok(m.linha.includes(`prazo:${PRAZOS.consultaGrupoMs}`), 'cada consulta é limitada por um prazo');
  });
});

describe('[SUP] o grupo vazio não substitui a confirmação do término do processo principal (RED-SUP-1B)', () => {
  test('SUP-20 — prazo esgotado, SIGTERM e SIGKILL aceitos, fluxos fechados e grupo respondendo vazio, mas o TÉRMINO do processo nunca é informado: não concluído, saída 11, trava mantida', LIMITE_DO_TESTE, async () => {
    const m = criarMundo({ vivos: [false], aoSigkill: ({ fluxos }) => { fluxos.resolver(); } });
    const s = iniciarSupervisao(m);
    await ate(() => m.prazos.length >= 1, 'prazo total');
    m.prazos[0].resolver();
    await ate(() => m.prazos.some((p) => p.ms === PRAZOS.cortesiaMs), 'cortesia');
    m.prazos.find((p) => p.ms === PRAZOS.cortesiaMs).resolver();
    const r = await s.promessa;
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`, `sinal:${PGID}:SIGKILL`]);
    assert.ok(m.linha.includes(`vivos:${PGID}`), 'o grupo foi consultado e respondeu vazio');
    exigirNaoSeguro(r, 'término não confirmado');
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false, 'sem a confirmação do processo principal não há liberação');
    assert.ok(r.motivos.includes('SAIDA_INDEFINIDA'));
  });

  const rejeitada = () => {
    const promessa = Promise.reject(Object.assign(new Error('término ilegível'), { code: 'EPIPE' }));
    promessa.catch(() => {});
    return promessa;
  };
  for (const [rotulo, fazerSaida] of [
    ['promessa de término rejeitada', rejeitada],
    ['término undefined', () => Promise.resolve(undefined)],
    ['término objeto vazio', () => Promise.resolve({})],
    ['código como texto', () => Promise.resolve({ codigo: '0', sinal: null })],
    ['código e sinal nulos', () => Promise.resolve({ codigo: null, sinal: null })],
    ['código e sinal ao mesmo tempo', () => Promise.resolve({ codigo: 0, sinal: 'SIGTERM' })],
  ]) {
    test(`SUP-21 (${rotulo}) — término impossível de comprovar com o grupo vazio e os fluxos fechados: não concluído, saída 11, trava mantida`, LIMITE_DO_TESTE, async () => {
      const m = criarMundo({ vivos: [false], processo: { pgid: PGID, saida: fazerSaida(), fluxosFechados: Promise.resolve() } });
      const r = await supervisor().supervisionar(m.opcoes);
      exigirNaoSeguro(r, rotulo);
      assert.equal(r.saida, SAIDA.DESCONHECIDO, rotulo);
      assert.equal(r.liberarTravaPermitido, false, `${rotulo}: término não comprovado`);
      assert.ok(r.motivos.includes('SAIDA_INDEFINIDA'), rotulo);
    });
  }

  test('SUP-22 — controle: término COMPROVADO com falha (código 1, ou SIGKILL do próprio prazo), fluxos fechados e grupo confirmado vazio continuam permitindo a liberação segura (saída 9)', LIMITE_DO_TESTE, async () => {
    const falha = criarMundo({ vivos: [false] });
    const s1 = iniciarSupervisao(falha);
    falha.terminar(1);
    falha.fecharFluxos();
    const r1 = await s1.promessa;
    assert.equal(r1.saida, SAIDA.FALHA);
    assert.equal(r1.liberarTravaPermitido, true);
    assert.equal(r1.codigoDoProcesso, 1);

    const morto = criarMundo({ vivos: [false], aoSigkill: ({ saida, fluxos }) => { saida.resolver({ codigo: null, sinal: 'SIGKILL' }); fluxos.resolver(); } });
    const s2 = iniciarSupervisao(morto);
    await ate(() => morto.prazos.length >= 1, 'prazo total');
    morto.prazos[0].resolver();
    await ate(() => morto.prazos.some((p) => p.ms === PRAZOS.cortesiaMs), 'cortesia');
    morto.prazos.find((p) => p.ms === PRAZOS.cortesiaMs).resolver();
    const r2 = await s2.promessa;
    assert.equal(r2.saida, SAIDA.FALHA);
    assert.equal(r2.liberarTravaPermitido, true);
    assert.equal(r2.sinalDoProcesso, 'SIGKILL');
  });
});

describe('[SUP] a cortesia observa o término do processo principal separado dos fluxos (RED-SUP-1C)', () => {
  test('SUP-23 — o processo confirma o término DURANTE a cortesia, mas os fluxos continuam abertos: a cortesia é cancelada na hora, nenhum SIGKILL (nem se a cortesia cancelada disparar depois), e sem conclusão nem liberação enquanto os fluxos estiverem pendentes', LIMITE_DO_TESTE, async () => {
    const m = criarMundo({ vivos: [false] });
    const s = iniciarSupervisao(m);
    await ate(() => m.prazos.length >= 1, 'prazo total');
    m.prazos[0].resolver();
    await ate(() => m.sinaisEnviados().length >= 1, 'SIGTERM');
    await ate(() => m.prazos.some((p) => p.ms === PRAZOS.cortesiaMs), 'cortesia');
    const cortesia = m.prazos.find((p) => p.ms === PRAZOS.cortesiaMs);
    m.terminar(null, 'SIGTERM');
    await andar();
    assert.equal(cortesia.cancelado, true, 'o término confirmado do processo principal cancela a cortesia, mesmo com os fluxos abertos');
    cortesia.resolver();
    await andar();
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`], 'nenhum SIGKILL depois do término confirmado');
    const r = await s.promessa;
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`], 'nem ao concluir a supervisão');
    exigirNaoSeguro(r, 'fluxos pendentes depois da cortesia');
    assert.equal(r.saida, SAIDA.DESCONHECIDO);
    assert.equal(r.liberarTravaPermitido, false, 'fluxos abertos mantêm a trava');
    assert.ok(r.motivos.includes('FLUXOS_PENDENTES'));
    assert.equal(r.sinalDoProcesso, 'SIGTERM', 'o término do processo principal foi registrado');
    assert.ok(!r.motivos.includes('ENCERRAMENTO_FORCADO'), 'não houve SIGKILL');
  });

  test('SUP-24 — controle: o processo continua VIVO ao fim da cortesia, ainda que os fluxos já tenham fechado: o SIGKILL continua sendo enviado ao grupo', LIMITE_DO_TESTE, async () => {
    const m = criarMundo({ vivos: [false], aoSigkill: ({ saida }) => { saida.resolver({ codigo: null, sinal: 'SIGKILL' }); } });
    const s = iniciarSupervisao(m);
    m.fecharFluxos();
    await ate(() => m.prazos.length >= 1, 'prazo total');
    m.prazos[0].resolver();
    await ate(() => m.prazos.some((p) => p.ms === PRAZOS.cortesiaMs), 'cortesia');
    m.prazos.find((p) => p.ms === PRAZOS.cortesiaMs).resolver();
    const r = await s.promessa;
    assert.deepEqual(m.sinaisEnviados(), [`sinal:${PGID}:SIGTERM`, `sinal:${PGID}:SIGKILL`]);
    assert.ok(r.motivos.includes('ENCERRAMENTO_FORCADO'));
    assert.equal(r.saida, SAIDA.FALHA);
    assert.equal(r.liberarTravaPermitido, true, 'término confirmado, fluxos fechados e grupo vazio');
  });
});
