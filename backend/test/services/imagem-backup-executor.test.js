'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { ErroDeJanela, TIPOS } = require('../../src/utils/janela-escrita-imagens');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-EXE-1): EXECUTOR com SUPERVISÃO OBRIGATÓRIA do dump. Só unitário e em memória: a trava, o
 * processo do dump, o grupo, os sinais e o relógio são objetos falsos; nenhum processo, banco, disco, rede ou relógio real.
 *
 * CONTRATO PROVISÓRIO (nomes, campos e códigos ainda NÃO aprovados; o módulo NÃO existe nesta fase):
 *   src/services/imagem-backup-executor.service.js exporta `executarBackupSupervisionado(dependencias)` -> Promise<resultado>
 *   dependencias = {            (objeto ESTRITO: qualquer outra chave é recusada ANTES da trava, com saída 2)
 *     janela:          { adquirir({ tipo }) }                       a trava (o mesmo contrato do coordenador)
 *     snapshot:        async () => ({ ok: true, ... })              etapa EM PROCESSO (sem processo externo)
 *     processoDoDump:  () => opcoes do supervisor                   { iniciar, grupo, sinais, temporizador, prazos }: descreve o processo;
 *                                                                   NÃO roda nada e NÃO decide nada; chaves extras que ele devolva são ignoradas
 *     copia:           async () => ({ ok: true, ... })              etapa EM PROCESSO (sem processo externo)
 *     avaliar:         (resultados) => ({ valido, motivos })        o veredito do conjunto (o do coordenador)
 *     parada (opcional): { aoPedir(funcao) }                        entregue ao coordenador E ao supervisor do dump
 *   }
 *   - o executor monta SEMPRE as três etapas obrigatórias (snapshot, dump, copia) e chama `executarBackup` (GREEN-INT-1); o chamador não fornece
 *     `etapas`, `supervisionada`, `supervisionar`, `dump` nem veredito: essas chaves são recusadas (saída 2) sem adquirir a trava nem rodar nada;
 *   - a etapa dump é SEMPRE `supervisionada: true` e roda o `supervisionar` REAL (GREEN-SUP-1C), que o executor importa e o chamador não substitui;
 *     o resultado da etapa é montado SÓ com o retorno desse supervisor: `{ ok: supervisao.concluido === true, supervisao }`;
 *   - a trava é adquirida e a posse confirmada pelo coordenador antes de qualquer etapa (contrato GREEN-1B e GREEN-INT-1, sem mudança);
 *   - resultado = o resultado do coordenador (saida, valido, recuperavel, janela, etapasExecutadas, motivos, sinal) MAIS `supervisao`: o retorno do
 *     supervisor efetivamente chamado (ou null, se o dump não chegou a rodar); `recuperavel` é SEMPRE false aqui: nada deste executor é prova de
 *     restauração independente nem de backup real recuperável.
 *   Etapas além do dump: neste desenho snapshot e cópia são EM PROCESSO. Se no futuro qualquer uma delas (ou a verificação dentro de `avaliar`, por
 *   exemplo um `pg_restore --list`) iniciar processo externo, precisará da MESMA supervisão obrigatória.
 */

const MODULO = 'src/services/imagem-backup-executor.service';
const executor = () => exigirModulo(MODULO);
const SAIDA = Object.freeze({ VALIDO: 0, ARGUMENTOS: 2, JANELA_OCUPADA: 6, RETIDA: 11 });
const PGID = 5150;
const PRAZOS = Object.freeze({ totalMs: 60000, cortesiaMs: 5000, intervaloGrupoMs: 200, tentativasGrupo: 3, consultaGrupoMs: 1000 });
const VALIDO = () => ({ valido: true, motivos: [] });
const andar = async (vezes = 20) => { for (let i = 0; i < vezes; i += 1) await new Promise((resolver) => setImmediate(resolver)); };

function adiado() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

/** Tudo o que o executor toca, em memória, numa linha do tempo comum. */
function criarMundo({ ocupada = false, termino = { codigo: 0, sinal: null }, vivos = false, iniciarFalha = null, terminoControlado = false } = {}) {
  const linha = [];
  const estado = { documento: ocupada ? { tipo: TIPOS.LIMPEZA, token: 'token-da-limpeza' } : null, aquisicoes: 0, liberacoes: 0 };
  const saida = adiado();
  if (!terminoControlado) saida.resolver(termino);
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
        async confirmarPosse() { linha.push('confirmarPosse'); return { confirmada: estado.documento !== null && estado.documento.token === token }; },
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

  const opcoesDoProcesso = () => ({
    async iniciar() {
      linha.push('dump:iniciar');
      if (iniciarFalha) throw iniciarFalha;
      return { pgid: PGID, saida: saida.promessa, fluxosFechados: saida.promessa.then(() => undefined) };
    },
    grupo: { async vivos() { linha.push('dump:grupo.vivos'); return vivos; } },
    sinais: { async enviar(pgid, sinal) { linha.push(`dump:sinal:${sinal}`); return true; } },
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
  });

  const contagem = { snapshot: 0, copia: 0, avaliar: 0, processoDoDump: 0 };
  const dependencias = {
    janela,
    async snapshot() { contagem.snapshot += 1; linha.push('snapshot'); return { ok: true }; },
    processoDoDump() { contagem.processoDoDump += 1; linha.push('processoDoDump'); return opcoesDoProcesso(); },
    async copia() { contagem.copia += 1; linha.push('copia'); return { ok: true }; },
    avaliar(resultados) { contagem.avaliar += 1; linha.push('avaliar'); return VALIDO(resultados); },
  };
  return { linha, estado, contagem, dependencias, opcoesDoProcesso, terminar: (t) => saida.resolver(t) };
}

const indice = (linha, evento) => linha.indexOf(evento);
const supervisorRodou = (linha) => linha.includes('dump:iniciar') && linha.includes('dump:grupo.vivos');

describe('[EXE] caminho seguro: trava, snapshot, dump SUPERVISIONADO, cópia, avaliação', () => {
  test('EXE-01 — backup simulado seguro: adquire a trava (BACKUP) e confirma a posse antes de tudo; snapshot; o dump roda pelo supervisor (início e conferência do grupo); cópia; avaliação; trava solta uma vez; saída 0', async () => {
    const m = criarMundo();
    const r = await executor().executarBackupSupervisionado(m.dependencias);
    assert.equal(m.linha[0], `adquirir:${TIPOS.BACKUP}`);
    assert.ok(indice(m.linha, 'confirmarPosse') < indice(m.linha, 'snapshot'), 'posse confirmada antes da primeira etapa');
    assert.ok(indice(m.linha, 'snapshot') < indice(m.linha, 'dump:iniciar'));
    assert.ok(supervisorRodou(m.linha), 'o dump passou pelo supervisor');
    assert.ok(indice(m.linha, 'dump:grupo.vivos') < indice(m.linha, 'copia'), 'a cópia só depois da confirmação do supervisor');
    assert.ok(indice(m.linha, 'copia') < indice(m.linha, 'avaliar'));
    assert.ok(indice(m.linha, 'avaliar') < indice(m.linha, 'liberar'));
    assert.equal(m.estado.liberacoes, 1);
    assert.equal(r.saida, SAIDA.VALIDO);
    assert.equal(r.janela, 'LIBERADA');
    assert.deepEqual(r.etapasExecutadas, ['snapshot', 'dump', 'copia']);
    assert.equal(r.supervisao.concluido, true, 'o resultado traz a supervisão efetivamente feita');
    assert.equal(r.supervisao.liberarTravaPermitido, true);
  });
});

describe('[EXE] não há caminho para o dump sem supervisor', () => {
  for (const [rotulo, extra] of [
    ['lista de etapas própria', { etapas: [] }],
    ['marca supervisionada falsa', { supervisionada: false }],
    ['supervisor substituto', { supervisionar: async () => ({ concluido: true, liberarTravaPermitido: true, saida: 0, motivos: [] }) }],
    ['dump direto', { dump: async () => ({ ok: true }) }],
    ['veredito pronto', { supervisao: { concluido: true, liberarTravaPermitido: true, saida: 0, motivos: [] } }],
  ]) {
    test(`EXE-02 (${rotulo}) — chave que tentaria contornar a supervisão é recusada ANTES da trava: saída 2, nenhuma etapa, nenhum processo`, async () => {
      const m = criarMundo();
      const r = await executor().executarBackupSupervisionado({ ...m.dependencias, ...extra });
      assert.equal(r.saida, SAIDA.ARGUMENTOS);
      assert.equal(r.valido, false);
      assert.equal(m.estado.aquisicoes, 0, 'nem tenta a trava');
      assert.equal(m.contagem.snapshot + m.contagem.copia + m.contagem.processoDoDump, 0);
      assert.equal(m.linha.includes('dump:iniciar'), false);
    });
  }

  test('EXE-03 — a descrição do processo traz um veredito FALSO, `supervisionada: false` e um `executar` próprio: tudo é ignorado; o supervisor real roda, vê o grupo VIVO e a trava fica RETIDA', async () => {
    const m = criarMundo({ vivos: true });
    let executarProprio = 0;
    m.dependencias.processoDoDump = () => ({
      ...m.opcoesDoProcesso(),
      supervisionada: false,
      supervisao: { concluido: true, liberarTravaPermitido: true, saida: 0, motivos: [] },
      async executar() { executarProprio += 1; return { ok: true }; },
    });
    const r = await executor().executarBackupSupervisionado(m.dependencias);
    assert.equal(executarProprio, 0, 'o executar do chamador nunca roda');
    assert.ok(supervisorRodou(m.linha), 'quem decidiu foi o supervisor real');
    assert.equal(r.saida, SAIDA.RETIDA);
    assert.equal(r.janela, 'RETIDA');
    assert.equal(m.estado.liberacoes, 0);
    assert.equal(r.supervisao.liberarTravaPermitido, false, 'o resultado é o do supervisor, não o veredito falso');
    assert.equal(m.contagem.copia, 0);
  });
});

describe('[EXE] o veredito do supervisor governa a sequência e a trava', () => {
  test('EXE-04 — supervisor NÃO concluído (processo morto por SIGSEGV, encerramento confirmado): a cópia NÃO começa e a avaliação não roda', async () => {
    const m = criarMundo({ termino: { codigo: null, sinal: 'SIGSEGV' } });
    const r = await executor().executarBackupSupervisionado(m.dependencias);
    assert.equal(r.supervisao.concluido, false);
    assert.equal(m.contagem.copia, 0);
    assert.equal(m.contagem.avaliar, 0);
    assert.equal(r.valido, false);
    assert.notEqual(r.saida, SAIDA.VALIDO);
  });

  test('EXE-05 — supervisor PROÍBE soltar a trava (descendente vivo): trava RETIDA (saída 11), liberar() não é chamado, sem cópia, sem avaliação, nunca sucesso', async () => {
    const m = criarMundo({ vivos: true });
    const r = await executor().executarBackupSupervisionado(m.dependencias);
    assert.equal(r.saida, SAIDA.RETIDA);
    assert.equal(r.janela, 'RETIDA');
    assert.equal(m.estado.liberacoes, 0);
    assert.notEqual(m.estado.documento, null, 'a trava continua no lugar');
    assert.equal(m.contagem.copia, 0);
    assert.equal(m.contagem.avaliar, 0);
    assert.equal(r.valido, false);
  });

  test('EXE-06 — processo terminou com FALHA (código 1) mas a liberação é comprovadamente segura: a trava é solta uma vez, e o backup continua inválido', async () => {
    const m = criarMundo({ termino: { codigo: 1, sinal: null } });
    const r = await executor().executarBackupSupervisionado(m.dependencias);
    assert.equal(r.supervisao.liberarTravaPermitido, true);
    assert.equal(m.estado.liberacoes, 1);
    assert.equal(r.janela, 'LIBERADA');
    assert.equal(r.valido, false);
    assert.notEqual(r.saida, SAIDA.VALIDO);
    assert.equal(m.contagem.copia, 0);
  });

  test('EXE-07 — falha no INÍCIO da supervisão (o processo não pôde ser iniciado, ou a descrição do processo lança): nunca conclusão segura; a trava não é solta por omissão', async () => {
    const m1 = criarMundo({ iniciarFalha: Object.assign(new Error('spawn falhou'), { code: 'ENOENT' }) });
    const r1 = await executor().executarBackupSupervisionado(m1.dependencias);
    assert.equal(r1.valido, false);
    assert.equal(m1.estado.liberacoes, 0, 'supervisor não confirmou: a trava fica');
    assert.equal(r1.janela, 'RETIDA');
    assert.equal(m1.contagem.copia, 0);

    const m2 = criarMundo();
    m2.dependencias.processoDoDump = () => { throw new Error('descrição do processo quebrou'); };
    const r2 = await executor().executarBackupSupervisionado(m2.dependencias);
    assert.equal(r2.valido, false);
    assert.equal(m2.estado.liberacoes, 0);
    assert.equal(r2.janela, 'RETIDA');
    assert.equal(m2.linha.includes('dump:iniciar'), false);
  });
});

describe('[EXE] parada, trava ocupada e dependências', () => {
  test('EXE-08 — SIGTERM durante o SNAPSHOT: o dump nunca começa (nem o supervisor), a cópia também não; sem processo para supervisionar, a trava é solta uma vez; resultado não válido', async () => {
    const m = criarMundo();
    const ouvintes = [];
    m.dependencias.parada = { aoPedir(f) { ouvintes.push(f); } };
    m.dependencias.snapshot = async () => { m.contagem.snapshot += 1; m.linha.push('snapshot'); for (const f of ouvintes) f('SIGTERM'); return { ok: true }; };
    const r = await executor().executarBackupSupervisionado(m.dependencias);
    assert.equal(m.linha.includes('dump:iniciar'), false);
    assert.equal(m.contagem.processoDoDump, 0);
    assert.equal(m.contagem.copia, 0);
    assert.equal(m.estado.liberacoes, 1);
    assert.equal(r.valido, false);
    assert.notEqual(r.saida, SAIDA.VALIDO);
    assert.equal(r.supervisao, null, 'o supervisor não chegou a rodar');
  });

  test('EXE-09 — SIGINT DURANTE o dump: o supervisor recebe a parada; com o grupo VIVO a trava fica RETIDA, com o encerramento confirmado ela é solta; em nenhum caso a cópia começa', async () => {
    for (const [rotulo, vivos, retida] of [['grupo vivo', true, true], ['encerramento confirmado', false, false]]) {
      const m = criarMundo({ vivos, terminoControlado: true });
      const ouvintes = [];
      m.dependencias.parada = { aoPedir(f) { ouvintes.push(f); } };
      const promessa = executor().executarBackupSupervisionado(m.dependencias);
      for (let i = 0; i < 200 && !m.linha.includes('dump:iniciar'); i += 1) await new Promise((resolver) => setImmediate(resolver));
      assert.ok(m.linha.includes('dump:iniciar'), `${rotulo}: o dump começou`);
      for (const f of ouvintes) f('SIGINT');
      await andar();
      m.terminar({ codigo: null, sinal: 'SIGINT' });
      const r = await promessa;
      assert.equal(m.contagem.copia, 0, `${rotulo}: nenhuma etapa nova depois da parada`);
      assert.equal(r.valido, false, rotulo);
      assert.notEqual(r.saida, SAIDA.VALIDO, rotulo);
      assert.equal(r.supervisao.parada, 'SIGINT', `${rotulo}: o supervisor recebeu a parada`);
      if (retida) {
        assert.equal(r.janela, 'RETIDA', rotulo);
        assert.equal(m.estado.liberacoes, 0, rotulo);
      } else {
        assert.equal(r.janela, 'LIBERADA', rotulo);
        assert.equal(m.estado.liberacoes, 1, rotulo);
      }
    }
  });

  test('EXE-10 — trava inicialmente OCUPADA: saída 6; snapshot, dump (descrição e processo) e cópia nunca começam; a trava alheia fica como estava', async () => {
    const m = criarMundo({ ocupada: true });
    const antes = structuredClone(m.estado.documento);
    const r = await executor().executarBackupSupervisionado(m.dependencias);
    assert.equal(r.saida, SAIDA.JANELA_OCUPADA);
    assert.equal(m.contagem.snapshot + m.contagem.processoDoDump + m.contagem.copia + m.contagem.avaliar, 0);
    assert.equal(m.linha.includes('dump:iniciar'), false);
    assert.deepEqual(m.estado.documento, antes);
  });

  for (const ausente of ['janela', 'snapshot', 'processoDoDump', 'copia', 'avaliar']) {
    test(`EXE-11 (sem ${ausente}) — dependência obrigatória ausente: recusa ANTES da trava (saída 2), nada roda`, async () => {
      const m = criarMundo();
      const dependencias = { ...m.dependencias };
      delete dependencias[ausente];
      const r = await executor().executarBackupSupervisionado(dependencias);
      assert.equal(r.saida, SAIDA.ARGUMENTOS);
      assert.equal(m.estado.aquisicoes, 0);
      assert.equal(m.contagem.snapshot + m.contagem.processoDoDump + m.contagem.copia + m.contagem.avaliar, 0);
    });
  }

  test('EXE-12 — a avaliação final só roda depois das três etapas concluídas: cópia que falha impede a avaliação; caminho completo avalia exatamente uma vez, depois da cópia', async () => {
    const falha = criarMundo();
    falha.dependencias.copia = async () => { falha.contagem.copia += 1; falha.linha.push('copia'); return { ok: false }; };
    const r1 = await executor().executarBackupSupervisionado(falha.dependencias);
    assert.equal(falha.contagem.avaliar, 0);
    assert.equal(r1.valido, false);
    assert.equal(falha.estado.liberacoes, 1);

    const ok = criarMundo();
    await executor().executarBackupSupervisionado(ok.dependencias);
    assert.equal(ok.contagem.avaliar, 1);
    assert.ok(indice(ok.linha, 'copia') < indice(ok.linha, 'avaliar'));
  });

  test('EXE-13 — nada deste executor é prova de restauração nem de backup real recuperável: recuperavel é false mesmo com tudo válido e uma avaliação que alegue o contrário', async () => {
    const m = criarMundo();
    m.dependencias.avaliar = () => ({ valido: true, recuperavel: true, motivos: [], provaDeRestauracao: { aprovada: true } });
    const r = await executor().executarBackupSupervisionado(m.dependencias);
    assert.equal(r.saida, SAIDA.VALIDO);
    assert.equal(r.recuperavel, false);
    assert.equal(Object.hasOwn(r, 'provaDeRestauracao'), false);
  });
});
