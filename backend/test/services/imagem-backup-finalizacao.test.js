'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { ErroDeJanela, TIPOS } = require('../../src/utils/janela-escrita-imagens');
const { executarBackup } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-FIN-1, corrigido no RED-FIN-1B): FINALIZAÇÃO SEGURA dos recursos, SEPARADA da decisão de
 * liberar a trava. Só unitário e em memória: a trava, as etapas, a supervisão e os recursos (por exemplo, a futura transação do snapshot) são falsos.
 *
 * CONTRATO PROVISÓRIO (menor interface; nomes e códigos ainda NÃO aprovados; nada de produção foi alterado):
 *   o coordenador `executarBackup({ janela, etapas, avaliar, parada, finalizar })` ganha a opção `finalizar` (função assíncrona, opcional; sem ela
 *   nada muda e `resultado.finalizacao === 'NAO_APLICAVEL'`; não sendo função, saída 2 antes da trava);
 *   - QUANDO: no máximo UMA vez, só se a trava foi ADQUIRIDA (trava ocupada, aquisição com erro, argumentos inválidos: nunca), DEPOIS de a última
 *     etapa iniciada e a avaliação (se houve) terminarem, e ANTES de qualquer decisão de liberar; nunca de dentro do pedido de parada e nunca com uma
 *     etapa em andamento (a transação do snapshot só pode ser fechada depois de o dump ter terminado e, portanto, adotado o snapshot);
 *   - EXCEÇÃO DE SEGURANÇA (decisão da V9, RED-FIN-1B): quando a supervisão determinar RETENÇÃO (liberação negada, supervisão ausente ou estranha,
 *     ou exceção da etapa supervisionada: não há prova de que os processos terminaram), o coordenador NÃO chama `finalizar`. A finalização fica
 *     ADIADA POR SEGURANÇA (`resultado.finalizacao === 'ADIADA'`): nenhum recurso de que um processo ainda ativo possa depender (a transação do
 *     snapshot, os temporários) é encerrado; a trava fica RETIDA (saída 11), sem `liberar()`. O encerramento desses recursos passa a ser do
 *     procedimento controlado de recuperação, não deste coordenador. Esta exceção prevalece sobre todas as demais regras abaixo;
 *   - CONTEXTO recebido: `{ posse, etapasExecutadas, interrompido }`, com `posse` em 'CONFIRMADA' | 'PERDIDA' | 'DESCONHECIDA';
 *   - RESPOSTA: só `{ concluida: true }` (exatamente true) significa "todos os recursos foram encerrados com segurança"; qualquer outra resposta, ou
 *     exceção, é finalização NÃO concluída (há recurso cujo encerramento ainda não é seguro ou não foi comprovado);
 *   - EFEITO na trava (a finalização nunca decide liberar): finalização não concluída mantém a trava RETIDA (saída 11, motivo
 *     FINALIZACAO_NAO_CONCLUIDA), nunca a solta; posse perdida continua prevalecendo (10, PERDIDA, sem tocar na trava alheia); a posse é conferida de
 *     novo DEPOIS da finalização e antes de liberar; um pedido de parada durante a finalização é só anotado: não a interrompe nem antecipa a liberação;
 *   - `resultado.finalizacao`: 'CONCLUIDA' | 'NAO_CONCLUIDA' | 'ADIADA' | 'NAO_APLICAVEL'; finalização concluída nunca torna válida uma execução falha.
 *   O executor (GREEN-EXE-1) ainda não repassa `finalizar`; ele a fornecerá em etapa posterior (SNAP-1), com os recursos das próprias etapas.
 */

const SAIDA = Object.freeze({ VALIDO: 0, ARGUMENTOS: 2, JANELA_OCUPADA: 6, JANELA_PERDIDA: 10, RETIDA: 11 });
const VALIDO = () => ({ valido: true, motivos: [] });
const andar = async (vezes = 20) => { for (let i = 0; i < vezes; i += 1) await new Promise((resolver) => setImmediate(resolver)); };

function adiado() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

/** Trava em memória com o protocolo do módulo real, e uma linha do tempo comum a trava, etapas, recursos e finalização. */
function criarMundo({ ocupada = false } = {}) {
  const linha = [];
  const estado = { documento: ocupada ? { tipo: TIPOS.LIMPEZA, token: 'token-alheio' } : null, aquisicoes: 0, liberacoes: 0 };
  const recursos = { abertos: new Set() };
  let proximo = 0;
  const janela = {
    async adquirir(argumentos) {
      estado.aquisicoes += 1;
      linha.push('adquirir');
      if (estado.documento !== null) throw new ErroDeJanela('JANELA_OCUPADA', { tipo: estado.documento.tipo, pid: 4242, iniciadoEm: '2026-10-21T03:00:00.000Z' });
      proximo += 1;
      const token = `token-${proximo}`;
      estado.documento = { tipo: argumentos.tipo, token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() {
          linha.push('confirmarPosse');
          if (estado.posseIndisponivel) throw Object.assign(new Error('E/S ao conferir a posse'), { code: 'EIO' });
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
  const finalizacoes = [];
  const finalizarComum = (resposta = { concluida: true }) => async (contexto) => {
    finalizacoes.push(contexto);
    linha.push('finalizar');
    for (const recurso of recursos.abertos) linha.push(`fechar:${recurso}`);
    recursos.abertos.clear();
    return resposta;
  };
  return { linha, estado, recursos, janela, finalizacoes, finalizarComum, trocarPorOutroDono: () => { estado.documento = { tipo: TIPOS.LIMPEZA, token: 'outro' }; } };
}

const SEGURA = Object.freeze({ concluido: true, liberarTravaPermitido: true, saida: 0, motivos: [] });
const etapa = (m, nome, corpo = async () => ({ ok: true })) => ({
  nome,
  async executar() { m.linha.push(`${nome}:inicio`); const r = await corpo(); m.linha.push(`${nome}:fim`); return r; },
});
/** O snapshot abre um recurso (a futura transação exportada) que só a finalização fecha. */
const snapshotQueAbre = (m, corpo = async () => ({ ok: true })) => etapa(m, 'snapshot', async () => { m.recursos.abertos.add('transacao'); return corpo(); });
const dumpSupervisionado = (m, supervisao = SEGURA, corpo) => ({
  ...etapa(m, 'dump', corpo ?? (async () => ({ ok: supervisao.concluido === true, supervisao }))),
  supervisionada: true,
});
const etapasPadrao = (m, { snapshot, dump, copia } = {}) => [snapshot ?? snapshotQueAbre(m), dump ?? dumpSupervisionado(m), copia ?? etapa(m, 'copia')];
const pos = (m, evento) => m.linha.indexOf(evento);

describe('[FIN] finalização única, depois do trabalho e antes da liberação', () => {
  test('FIN-01 — caminho completo: finalizar() roda UMA vez, depois do fim do dump, da cópia e da avaliação, ANTES de liberar(); fecha a transação; resultado válido e finalização CONCLUIDA', async () => {
    const m = criarMundo();
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: () => { m.linha.push('avaliar'); return VALIDO(); }, finalizar: m.finalizarComum() });
    assert.equal(m.finalizacoes.length, 1);
    assert.ok(pos(m, 'finalizar') > pos(m, 'dump:fim'), 'só depois de o dump terminar (snapshot já adotado)');
    assert.ok(pos(m, 'finalizar') > pos(m, 'avaliar'));
    assert.ok(pos(m, 'finalizar') < pos(m, 'liberar'), 'antes da liberação');
    assert.ok(m.linha.includes('fechar:transacao'));
    assert.equal(m.estado.liberacoes, 1);
    assert.equal(r.saida, SAIDA.VALIDO);
    assert.equal(r.finalizacao, 'CONCLUIDA');
    assert.deepEqual(m.finalizacoes[0].etapasExecutadas, ['snapshot', 'dump', 'copia']);
    assert.equal(m.finalizacoes[0].posse, 'CONFIRMADA');
  });

  test('FIN-02 — sem `finalizar` nada muda (NAO_APLICAVEL); `finalizar` que não é função é recusado antes da trava (saída 2)', async () => {
    const m = criarMundo();
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: VALIDO });
    assert.equal(r.saida, SAIDA.VALIDO);
    assert.equal(r.finalizacao, 'NAO_APLICAVEL');
    const m2 = criarMundo();
    const r2 = await executarBackup({ janela: m2.janela, etapas: etapasPadrao(m2), avaliar: VALIDO, finalizar: 'sim' });
    assert.equal(r2.saida, SAIDA.ARGUMENTOS);
    assert.equal(m2.estado.aquisicoes, 0);
  });
});

describe('[FIN] finalização depois de qualquer falha', () => {
  test('FIN-03 — o snapshot FALHA depois de abrir a transação (recurso parcialmente adquirido): a finalização roda uma vez e fecha o que foi aberto; dump e cópia não começam; nunca válido', async () => {
    const m = criarMundo();
    const snapshot = snapshotQueAbre(m, async () => { throw new Error('exportação falhou'); });
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { snapshot }), avaliar: VALIDO, finalizar: m.finalizarComum() });
    assert.equal(m.finalizacoes.length, 1);
    assert.ok(m.linha.includes('fechar:transacao'));
    assert.equal(m.linha.includes('dump:inicio'), false);
    assert.equal(r.valido, false);
    assert.ok(pos(m, 'finalizar') < pos(m, 'liberar'));
  });

  test('FIN-04 — o dump FALHA com encerramento seguro confirmado: a finalização roda uma vez (depois do fim do dump), a cópia não começa, nunca válido', async () => {
    const m = criarMundo();
    const falha = { concluido: false, liberarTravaPermitido: true, saida: 9, motivos: ['PROCESSO_FALHOU'] };
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { dump: dumpSupervisionado(m, falha) }), avaliar: VALIDO, finalizar: m.finalizarComum() });
    assert.equal(m.finalizacoes.length, 1);
    assert.ok(pos(m, 'finalizar') > pos(m, 'dump:fim'));
    assert.equal(m.linha.includes('copia:inicio'), false);
    assert.equal(r.valido, false);
    assert.equal(m.estado.liberacoes, 1);
  });

  test('FIN-05 — a cópia FALHA: a finalização roda uma vez, depois do fim da cópia; nunca válido', async () => {
    const m = criarMundo();
    const copia = etapa(m, 'copia', async () => ({ ok: false }));
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { copia }), avaliar: VALIDO, finalizar: m.finalizarComum() });
    assert.equal(m.finalizacoes.length, 1);
    assert.ok(pos(m, 'finalizar') > pos(m, 'copia:fim'));
    assert.equal(r.valido, false);
  });

  for (const [rotulo, avaliar] of [['avaliação inválida', () => ({ valido: false, motivos: ['X'] })], ['avaliação que lança', () => { throw new Error('avaliação quebrou'); }]]) {
    test(`FIN-06 (${rotulo}) — a finalização roda uma vez, depois da avaliação, e a execução continua inválida`, async () => {
      const m = criarMundo();
      const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: (...a) => { m.linha.push('avaliar'); return avaliar(...a); }, finalizar: m.finalizarComum() });
      assert.equal(m.finalizacoes.length, 1);
      assert.ok(pos(m, 'finalizar') > pos(m, 'avaliar'));
      assert.equal(r.valido, false);
      assert.notEqual(r.saida, SAIDA.VALIDO);
    });
  }
});

describe('[FIN] parada e finalização pendente', () => {
  test('FIN-07 — SIGINT/SIGTERM DURANTE a etapa supervisionada: nenhum recurso é finalizado enquanto ela corre; a finalização só vem depois de ela terminar, uma vez, e o resultado é inválido', async () => {
    for (const sinal of ['SIGINT', 'SIGTERM']) {
      const m = criarMundo();
      const ouvintes = [];
      const fimDoDump = adiado();
      const dump = dumpSupervisionado(m, SEGURA, async () => { await fimDoDump.promessa; return { ok: true, supervisao: SEGURA }; });
      const promessa = executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { dump }), avaliar: VALIDO, parada: { aoPedir(f) { ouvintes.push(f); } }, finalizar: m.finalizarComum() });
      for (let i = 0; i < 200 && !m.linha.includes('dump:inicio'); i += 1) await new Promise((resolver) => setImmediate(resolver));
      assert.ok(m.linha.includes('dump:inicio'), `${sinal}: o dump supervisionado já começou antes do sinal`);
      assert.equal(m.linha.includes('dump:fim'), false, `${sinal}: e ainda não terminou`);
      for (const f of ouvintes) f(sinal);
      await andar();
      assert.equal(m.finalizacoes.length, 0, `${sinal}: nada é finalizado com a etapa supervisionada em andamento`);
      assert.ok(m.recursos.abertos.has('transacao'), `${sinal}: a transação continua aberta enquanto o dump corre`);
      fimDoDump.resolver();
      const r = await promessa;
      assert.equal(m.finalizacoes.length, 1, sinal);
      assert.ok(pos(m, 'finalizar') > pos(m, 'dump:fim'), sinal);
      assert.equal(m.linha.includes('copia:inicio'), false, sinal);
      assert.equal(r.valido, false, sinal);
      assert.equal(m.finalizacoes[0].interrompido, true, sinal);
    }
  });

  test('FIN-08 — finalização assíncrona AINDA PENDENTE: liberar() não é chamado antes de ela terminar; só depois, e uma vez', async () => {
    const m = criarMundo();
    const fim = adiado();
    const finalizar = async (contexto) => { m.finalizacoes.push(contexto); m.linha.push('finalizar:inicio'); await fim.promessa; m.linha.push('finalizar:fim'); return { concluida: true }; };
    const promessa = executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: VALIDO, finalizar });
    for (let i = 0; i < 200 && !m.linha.includes('finalizar:inicio'); i += 1) await new Promise((resolver) => setImmediate(resolver));
    await andar();
    assert.equal(m.estado.liberacoes, 0, 'nada é liberado com a finalização pendente');
    fim.resolver();
    const r = await promessa;
    assert.equal(m.estado.liberacoes, 1);
    assert.ok(pos(m, 'liberar') > pos(m, 'finalizar:fim'));
    assert.equal(r.saida, SAIDA.VALIDO);
  });

  test('FIN-14 — SIGTERM chega DURANTE uma finalização assíncrona: ela não é interrompida, a trava não é liberada antes de ela terminar, e o resultado não é válido', async () => {
    const m = criarMundo();
    const ouvintes = [];
    const fim = adiado();
    const finalizar = async (contexto) => {
      m.finalizacoes.push(contexto);
      m.linha.push('finalizar:inicio');
      await fim.promessa;
      for (const recurso of m.recursos.abertos) m.linha.push(`fechar:${recurso}`);
      m.recursos.abertos.clear();
      m.linha.push('finalizar:fim');
      return { concluida: true };
    };
    const promessa = executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: VALIDO, parada: { aoPedir(f) { ouvintes.push(f); } }, finalizar });
    for (let i = 0; i < 200 && !m.linha.includes('finalizar:inicio'); i += 1) await new Promise((resolver) => setImmediate(resolver));
    assert.ok(m.linha.includes('finalizar:inicio'), 'a finalização já começou antes do sinal');
    for (const f of ouvintes) f('SIGTERM');
    await andar();
    assert.equal(m.estado.liberacoes, 0, 'nada é liberado com a finalização em andamento, mesmo depois do SIGTERM');
    assert.ok(m.recursos.abertos.has('transacao'), 'o sinal não encerrou nada prematuramente');
    fim.resolver();
    const r = await promessa;
    assert.equal(m.finalizacoes.length, 1, 'uma finalização só');
    assert.ok(m.linha.includes('finalizar:fim'), 'a finalização terminou, não foi interrompida');
    assert.ok(m.linha.includes('fechar:transacao'));
    assert.ok(pos(m, 'liberar') > pos(m, 'finalizar:fim'), 'a liberação só depois do fim da finalização');
    assert.equal(r.valido, false);
    assert.notEqual(r.saida, SAIDA.VALIDO);
    assert.equal(r.sinal, 'SIGTERM');
    assert.equal(r.finalizacao, 'CONCLUIDA');
  });
});

describe('[FIN] a finalização nunca decide liberar', () => {
  for (const [rotulo, finalizar] of [
    ['exceção', async () => { throw new Error('não fechou'); }],
    ['sem resposta', async () => undefined],
    ['concluida falsa', async () => ({ concluida: false })],
    ['concluida como texto', async () => ({ concluida: 'true' })],
  ]) {
    test(`FIN-09 (${rotulo}) — finalização não concluída: nunca sucesso; a trava NÃO é solta (RETIDA, saída 11, FINALIZACAO_NAO_CONCLUIDA)`, async () => {
      const m = criarMundo();
      const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: VALIDO, finalizar });
      assert.equal(r.valido, false, rotulo);
      assert.equal(r.saida, SAIDA.RETIDA, rotulo);
      assert.equal(r.janela, 'RETIDA', rotulo);
      assert.equal(m.estado.liberacoes, 0, rotulo);
      assert.equal(r.finalizacao, 'NAO_CONCLUIDA', rotulo);
      assert.ok(r.motivos.includes('FINALIZACAO_NAO_CONCLUIDA'), rotulo);
    });
  }

  /** Exceção de segurança: com RETENÇÃO determinada pela supervisão, nada é finalizado (ADIADA), a transação continua aberta e a trava fica RETIDA. */
  function exigirFinalizacaoAdiada(m, r, rotulo) {
    assert.equal(m.finalizacoes.length, 0, `${rotulo}: finalizar() não é chamado com processos possivelmente ativos`);
    assert.ok(m.recursos.abertos.has('transacao'), `${rotulo}: a transação do snapshot continua aberta`);
    assert.equal(m.linha.includes('fechar:transacao'), false, `${rotulo}: nada fechou a transação`);
    assert.equal(r.finalizacao, 'ADIADA', rotulo);
    assert.equal(r.janela, 'RETIDA', rotulo);
    assert.equal(r.saida, SAIDA.RETIDA, rotulo);
    assert.equal(m.estado.liberacoes, 0, `${rotulo}: liberar() nunca é chamado`);
    assert.equal(m.estado.documento?.token, 'token-1', `${rotulo}: a trava continua com o backup`);
    assert.equal(r.valido, false, rotulo);
    assert.equal(m.linha.includes('copia:inicio'), false, rotulo);
  }

  test('FIN-10 — a supervisão determina RETENÇÃO (liberação negada): a finalização fica ADIADA por segurança, a transação simulada não é fechada e a trava fica RETIDA (11), sem liberar()', async () => {
    const m = criarMundo();
    const naoSegura = { concluido: false, liberarTravaPermitido: false, saida: 11, motivos: ['DESCENDENTES_ATIVOS'] };
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { dump: dumpSupervisionado(m, naoSegura) }), avaliar: VALIDO, finalizar: m.finalizarComum({ concluida: true, liberar: true }) });
    exigirFinalizacaoAdiada(m, r, 'liberação negada');
  });

  test('FIN-10B — a etapa supervisionada LANÇA, sem comprovar o encerramento dos processos: mesma exceção de segurança (ADIADA, transação aberta, RETIDA, sem liberar())', async () => {
    const m = criarMundo();
    const dump = dumpSupervisionado(m, SEGURA, async () => { throw new Error('supervisor quebrou'); });
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { dump }), avaliar: VALIDO, finalizar: m.finalizarComum() });
    exigirFinalizacaoAdiada(m, r, 'etapa supervisionada lançou');
  });

  for (const [rotulo, devolvido] of [
    ['supervisão ausente', { ok: true }],
    ['supervisão sem liberarTravaPermitido', { ok: true, supervisao: { concluido: true, saida: 0, motivos: [] } }],
    ['liberarTravaPermitido como texto', { ok: true, supervisao: { ...SEGURA, liberarTravaPermitido: 'true' } }],
    ['supervisão que não é objeto', { ok: true, supervisao: 'SEGURA' }],
    ['etapa supervisionada sem resposta', undefined],
  ]) {
    test(`FIN-15 (${rotulo}) — etapa supervisionada SEM comprovação confiável de que a trava pode ser solta: finalização ADIADA, recursos abertos, nenhuma liberação`, async () => {
      const m = criarMundo();
      const dump = dumpSupervisionado(m, SEGURA, async () => devolvido);
      const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { dump }), avaliar: VALIDO, finalizar: m.finalizarComum() });
      exigirFinalizacaoAdiada(m, r, rotulo);
    });
  }

  test('FIN-16 — RETENÇÃO da supervisão JUNTO com posse PERDIDA: finalizar() não é chamado, recursos abertos, sem liberar(), ADIADA, saída 10 e a trava do novo dono intacta', async () => {
    const m = criarMundo();
    const naoSegura = { concluido: false, liberarTravaPermitido: false, saida: 11, motivos: ['DESCENDENTES_ATIVOS'] };
    const dump = dumpSupervisionado(m, naoSegura, async () => { m.trocarPorOutroDono(); return { ok: false, supervisao: naoSegura }; });
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { dump }), avaliar: VALIDO, finalizar: m.finalizarComum({ concluida: true }) });
    assert.equal(m.finalizacoes.length, 0, 'finalizar() não é chamado');
    assert.ok(m.recursos.abertos.has('transacao'), 'a transação continua aberta');
    assert.equal(m.linha.includes('fechar:transacao'), false);
    assert.equal(m.estado.liberacoes, 0, 'liberar() não é chamado');
    assert.equal(r.finalizacao, 'ADIADA');
    assert.equal(r.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(r.janela, 'PERDIDA');
    assert.equal(r.valido, false);
    assert.deepEqual(m.estado.documento, { tipo: TIPOS.LIMPEZA, token: 'outro' }, 'a trava do novo dono continua intacta');
  });

  for (const [rotulo, finalizarDe] of [
    ['concluida falsa', (m) => async (contexto) => { m.finalizacoes.push(contexto); m.estado.posseIndisponivel = true; return { concluida: false }; }],
    ['exceção', (m) => async (contexto) => { m.finalizacoes.push(contexto); m.estado.posseIndisponivel = true; throw new Error('não fechou'); }],
  ]) {
    test(`FIN-17 (${rotulo}) — posse INCONCLUSIVA depois de finalização NÃO concluída: sem liberar(), sem declarar retenção comprovada; NAO_LIBERADA, saída 1, POSSE_NAO_CONFERIDA`, async () => {
      const m = criarMundo();
      const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: VALIDO, finalizar: finalizarDe(m) });
      assert.equal(m.finalizacoes.length, 1, rotulo);
      assert.equal(m.estado.liberacoes, 0, `${rotulo}: liberar() não é chamado`);
      assert.equal(r.finalizacao, 'NAO_CONCLUIDA', rotulo);
      assert.notEqual(r.janela, 'RETIDA', `${rotulo}: posse inconclusiva nunca é retenção comprovada`);
      assert.equal(r.janela, 'NAO_LIBERADA', rotulo);
      assert.equal(r.saida, 1, rotulo);
      assert.equal(r.valido, false, rotulo);
      assert.ok(r.motivos.includes('POSSE_NAO_CONFERIDA'), rotulo);
      assert.ok(r.motivos.includes('FINALIZACAO_NAO_CONCLUIDA'), rotulo);
      assert.equal(m.estado.documento?.token, 'token-1', `${rotulo}: a trava não foi removida`);
    });
  }

  /** GREEN-FIN-1A: finalização CONCLUÍDA não substitui a prova de posse; com a posse inconclusiva a trava não é solta (NAO_LIBERADA, saída 1). */
  function exigirSemLiberarPorPosseInconclusiva(m, r, rotulo) {
    assert.equal(m.finalizacoes.length, 1, rotulo);
    assert.ok(m.linha.includes('fechar:transacao'), `${rotulo}: os recursos foram realmente encerrados`);
    assert.equal(r.finalizacao, 'CONCLUIDA', rotulo);
    assert.equal(m.estado.liberacoes, 0, `${rotulo}: liberar() não é chamado`);
    assert.equal(r.janela, 'NAO_LIBERADA', rotulo);
    assert.equal(r.saida, 1, rotulo);
    assert.ok(r.motivos.includes('POSSE_NAO_CONFERIDA'), rotulo);
    assert.equal(r.valido, false, rotulo);
    assert.equal(m.estado.documento?.token, 'token-1', `${rotulo}: a trava não foi removida`);
  }

  test('FIN-18 — finalização CONCLUÍDA, mas confirmarPosse() lança erro de E/S DEPOIS dela: sem liberar(), NAO_LIBERADA, saída 1, POSSE_NAO_CONFERIDA', async () => {
    const m = criarMundo();
    const comum = m.finalizarComum({ concluida: true });
    const finalizar = async (contexto) => { const resposta = await comum(contexto); m.estado.posseIndisponivel = true; return resposta; };
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: VALIDO, finalizar });
    assert.equal(m.finalizacoes[0].posse, 'CONFIRMADA', 'a posse estava confirmada antes da finalização');
    exigirSemLiberarPorPosseInconclusiva(m, r, 'E/S depois da finalização');
  });

  test('FIN-19 — finalização CONCLUÍDA com a posse JÁ inconclusiva antes e ainda inconclusiva depois: sem liberar(), NAO_LIBERADA, saída 1, POSSE_NAO_CONFERIDA', async () => {
    const m = criarMundo();
    const avaliar = () => { m.estado.posseIndisponivel = true; return VALIDO(); };
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar, finalizar: m.finalizarComum({ concluida: true }) });
    assert.equal(m.finalizacoes[0].posse, 'DESCONHECIDA', 'a posse já era inconclusiva antes da finalização');
    exigirSemLiberarPorPosseInconclusiva(m, r, 'posse inconclusiva antes e depois');
  });

  test('FIN-11 — posse PERDIDA (inclusive durante a finalização): os recursos próprios ainda são finalizados, mas a trava alheia nunca é tocada; saída 10', async () => {
    const m = criarMundo();
    const finalizar = async (contexto) => { m.finalizacoes.push(contexto); m.trocarPorOutroDono(); return { concluida: true }; };
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m), avaliar: VALIDO, finalizar });
    assert.equal(m.finalizacoes.length, 1);
    assert.equal(r.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(r.janela, 'PERDIDA');
    assert.equal(m.estado.liberacoes, 0);
    assert.deepEqual(m.estado.documento, { tipo: TIPOS.LIMPEZA, token: 'outro' });
  });

  test('FIN-12 — aquisição recusada ou com erro, ou argumentos inválidos: nenhum trabalho começou, então nenhuma finalização de recursos inexistentes', async () => {
    const ocupada = criarMundo({ ocupada: true });
    const r1 = await executarBackup({ janela: ocupada.janela, etapas: etapasPadrao(ocupada), avaliar: VALIDO, finalizar: ocupada.finalizarComum() });
    assert.equal(r1.saida, SAIDA.JANELA_OCUPADA);
    assert.equal(ocupada.finalizacoes.length, 0);

    const comErro = criarMundo();
    comErro.janela.adquirir = async () => { throw Object.assign(new Error('E/S'), { code: 'EIO' }); };
    await executarBackup({ janela: comErro.janela, etapas: etapasPadrao(comErro), avaliar: VALIDO, finalizar: comErro.finalizarComum() });
    assert.equal(comErro.finalizacoes.length, 0);

    const invalidos = criarMundo();
    await executarBackup({ janela: invalidos.janela, etapas: [], avaliar: VALIDO, finalizar: invalidos.finalizarComum() });
    assert.equal(invalidos.finalizacoes.length, 0);
  });

  test('FIN-13 — nada tardio converte falha em válida: depois do resultado, um pedido de parada ou o tempo não chamam a finalização de novo nem alteram o resultado; finalização concluída não torna válida uma execução falha', async () => {
    const m = criarMundo();
    const ouvintes = [];
    const copia = etapa(m, 'copia', async () => ({ ok: false }));
    const r = await executarBackup({ janela: m.janela, etapas: etapasPadrao(m, { copia }), avaliar: VALIDO, parada: { aoPedir(f) { ouvintes.push(f); } }, finalizar: m.finalizarComum() });
    const antes = JSON.stringify(r);
    for (const f of ouvintes) f('SIGTERM');
    await andar();
    assert.equal(m.finalizacoes.length, 1, 'uma finalização só');
    assert.equal(JSON.stringify(r), antes, 'o resultado não muda');
    assert.equal(r.valido, false);
    assert.equal(r.finalizacao, 'CONCLUIDA', 'finalizar bem não torna a execução válida');
    assert.equal(Object.isFrozen(r), true);
  });
});
