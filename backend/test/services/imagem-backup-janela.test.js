'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { ErroDeJanela, TIPOS } = require('../../src/utils/janela-escrita-imagens');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-1): POSSE DA TRAVA DE JANELA. Só unitário, determinístico, sem disco, sem banco e sem processo:
 * a trava é um objeto em memória que imita o protocolo do módulo real (criação exclusiva, posse pelo token, liberação só pelo dono) e as etapas são funções falsas.
 *
 * CONTRATO PROVISÓRIO (nomes, retornos e códigos ainda NÃO aprovados; ver o relatório RED-1):
 *   src/services/imagem-backup.service.js exporta `executarBackup({ janela, etapas, avaliar, parada })` -> Promise<{ saida, valido, recuperavel, janela, etapasExecutadas }>
 *   - janela.adquirir({ tipo }) -> manipulador { tipo, confirmarPosse(), liberar() } (o mesmo do módulo real) ou lança ErroDeJanela (JANELA_OCUPADA);
 *   - etapas: lista ordenada de { nome, executar() }; nenhuma roda antes da aquisição e da posse confirmada; a posse é reconferida depois de cada etapa;
 *     (RED-1A) as etapas OBRIGATÓRIAS são exatamente 'snapshot', 'dump' e 'copia', nesta ordem, sem repetição nem etapa desconhecida: lista diferente é
 *     recusada ANTES da trava (saída 2); cada `executar()` precisa resolver `{ ok: true }` (exatamente true): `{ ok: false }`, resultado ausente ou
 *     incompleto é falha da etapa, nenhuma etapa seguinte começa e o resultado nunca é válido;
 *   - avaliar(resultados) -> { valido, motivos }: o veredito do conjunto (testado em imagem-backup-veredito.test.js); só `valido === true` conta;
 *   - parada (opcional): { aoPedir(funcao) }: o pedido de parada (sinal) só é registrado; NUNCA libera a trava por conta própria; (RED-1A) a etapa em
 *     andamento termina sob supervisão, nenhuma outra começa e o backup interrompido NUNCA é válido nem sai com 0, mesmo que a etapa termine bem;
 *   - saída: 0 válido; 1 erro inesperado; 2 lista de etapas inválida; 6 janela ocupada; 9 backup inválido; 10 posse perdida (0, 1, 2 e 6 como na limpeza;
 *     9 e 10 propostos na C2); a saída da parada por sinal não é fixada aqui (só nunca 0);
 *   - `janela` do resultado: 'LIBERADA' | 'PERDIDA' | 'OCUPADA' | 'NAO_ADQUIRIDA'.
 * A liberação acontece num ponto só, uma única vez, e só pelo manipulador da própria aquisição; a trava de outro dono nunca é tocada nem recriada.
 */

const MODULO = 'src/services/imagem-backup.service';
const servico = () => exigirModulo(MODULO);
const SAIDA = Object.freeze({ VALIDO: 0, ERRO: 1, ARGUMENTOS: 2, JANELA_OCUPADA: 6, JANELA_PERDIDA: 10 });
const VALIDO = () => ({ valido: true, motivos: [] });

/** Trava em memória com o protocolo do módulo real: um documento só, criação exclusiva, posse e liberação pelo token. Tokens determinísticos. */
function criarJanelaFalsa({ ocupadaPor = null, liberarDemora = null } = {}) {
  const linha = [];
  const estado = { documento: ocupadaPor === null ? null : { ...ocupadaPor }, aquisicoes: 0, liberacoes: 0 };
  let proximo = 0;
  const janela = {
    async adquirir(argumentos) {
      estado.aquisicoes += 1;
      linha.push(`adquirir:${argumentos?.tipo}`);
      if (estado.documento !== null) {
        const dono = typeof estado.documento.tipo === 'string' ? { tipo: estado.documento.tipo, pid: 4242, iniciadoEm: '2026-10-20T03:00:00.000Z' } : null;
        throw new ErroDeJanela('JANELA_OCUPADA', dono);
      }
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
          linha.push('liberar:inicio');
          if (liberarDemora !== null) await liberarDemora();
          linha.push('liberar:fim');
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
    /** O que uma outra parte (um backup antigo, uma limpeza, uma pessoa) faria com o arquivo: trocar por outro dono ou apagá-lo. */
    trocarPorOutroDono: () => { estado.documento = { tipo: TIPOS.LIMPEZA, token: 'token-alheio' }; },
    apagarPorFora: () => { estado.documento = null; },
  };
}

const etapa = (linha, nome, corpo = async () => ({ ok: true })) => ({
  nome,
  async executar(...argumentos) {
    linha.push(`etapa:${nome}:inicio`);
    const resultado = await corpo(...argumentos);
    linha.push(`etapa:${nome}:fim`);
    return resultado;
  },
});
const tresEtapas = (linha, corpos = {}) => ['snapshot', 'dump', 'copia'].map((nome) => etapa(linha, nome, corpos[nome]));
const executouAlgumaEtapa = (linha) => linha.some((evento) => evento.startsWith('etapa:'));

describe('[JBK] o backup só trabalha com a trava BACKUP em mãos', () => {
  test('JBK-01 — caminho feliz: adquire a trava com o tipo BACKUP ANTES de qualquer etapa, confirma a posse antes da primeira e depois de cada uma, libera UMA vez no fim; saída 0', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const resultado = await executarBackup({ janela: t.janela, etapas: tresEtapas(t.linha), avaliar: VALIDO });
    assert.equal(t.linha[0], `adquirir:${TIPOS.BACKUP}`);
    const primeiraEtapa = t.linha.findIndex((evento) => evento.startsWith('etapa:'));
    assert.ok(primeiraEtapa > 0 && t.linha.slice(0, primeiraEtapa).includes('confirmarPosse'), 'a posse é confirmada antes da primeira etapa');
    for (const nome of ['snapshot', 'dump', 'copia']) {
      const fim = t.linha.indexOf(`etapa:${nome}:fim`);
      assert.equal(t.linha[fim + 1], 'confirmarPosse', `a posse é reconferida logo depois de ${nome}`);
    }
    assert.deepEqual(t.linha.slice(-2), ['liberar:inicio', 'liberar:fim']);
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(t.estado.documento, null, 'a trava do próprio backup foi solta');
    assert.equal(resultado.saida, SAIDA.VALIDO);
    assert.equal(resultado.valido, true);
    assert.equal(resultado.janela, 'LIBERADA');
    assert.deepEqual(resultado.etapasExecutadas, ['snapshot', 'dump', 'copia']);
  });

  test('JBK-02 — falha inesperada ao adquirir (E/S): nenhuma etapa roda, nada é liberado, saída 1 e nunca válido', async () => {
    const { executarBackup } = servico();
    const linha = [];
    const falha = Object.assign(new Error('falha de E/S'), { code: 'EIO' });
    const janela = { async adquirir() { linha.push('adquirir'); throw falha; } };
    const resultado = await executarBackup({ janela, etapas: tresEtapas(linha), avaliar: VALIDO });
    assert.equal(executouAlgumaEtapa(linha), false);
    assert.equal(resultado.saida, SAIDA.ERRO);
    assert.equal(resultado.valido, false);
    assert.equal(resultado.janela, 'NAO_ADQUIRIDA');
    assert.deepEqual(resultado.etapasExecutadas, []);
  });
});

describe('[JBK] trava ocupada: o backup não começa e não toca na trava alheia', () => {
  for (const [rotulo, documento] of [
    ['ocupada por uma LIMPEZA', { tipo: TIPOS.LIMPEZA, token: 'token-da-limpeza' }],
    ['ocupada por outro BACKUP', { tipo: TIPOS.BACKUP, token: 'token-de-outro-backup' }],
    ['com documento ilegível (dono desconhecido)', { lixo: true }],
  ]) {
    test(`JBK-03 (${rotulo}) — saída 6, uma única tentativa de aquisição, nenhuma etapa, nenhuma conferência, nenhuma liberação e a trava alheia intacta`, async () => {
      const { executarBackup } = servico();
      const t = criarJanelaFalsa({ ocupadaPor: documento });
      const antes = structuredClone(t.estado.documento);
      const resultado = await executarBackup({ janela: t.janela, etapas: tresEtapas(t.linha), avaliar: VALIDO });
      assert.equal(resultado.saida, SAIDA.JANELA_OCUPADA);
      assert.equal(resultado.valido, false);
      assert.equal(resultado.janela, 'OCUPADA');
      assert.equal(t.estado.aquisicoes, 1, 'nada de insistir nem de forçar a trava');
      assert.equal(executouAlgumaEtapa(t.linha), false);
      assert.equal(t.linha.includes('confirmarPosse'), false);
      assert.equal(t.estado.liberacoes, 0);
      assert.deepEqual(t.estado.documento, antes, 'a trava alheia continua exatamente como estava');
    });
  }
});

describe('[JBK] posse perdida: nada avança e o resultado nunca é válido', () => {
  test('JBK-04 — a trava é trocada por outro dono depois da primeira etapa: as seguintes NÃO rodam, saída 10, inválido, não recuperável, e a trava alheia não é removida', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const etapas = tresEtapas(t.linha, { snapshot: async () => { t.trocarPorOutroDono(); return { ok: true }; } });
    const resultado = await executarBackup({ janela: t.janela, etapas, avaliar: VALIDO });
    assert.deepEqual(resultado.etapasExecutadas, ['snapshot']);
    assert.equal(t.linha.includes('etapa:dump:inicio'), false);
    assert.equal(t.linha.includes('etapa:copia:inicio'), false);
    assert.equal(resultado.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(resultado.valido, false);
    assert.equal(resultado.recuperavel, false);
    assert.equal(resultado.janela, 'PERDIDA');
    assert.ok(t.estado.liberacoes <= 1);
    assert.deepEqual(t.estado.documento, { tipo: TIPOS.LIMPEZA, token: 'token-alheio' }, 'a trava do outro dono continua lá');
  });

  test('JBK-05 — a posse já não confere logo depois da aquisição: nenhuma etapa roda e a saída é 10', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const original = t.janela.adquirir;
    t.janela.adquirir = async (argumentos) => { const manipulador = await original(argumentos); t.trocarPorOutroDono(); return manipulador; };
    const resultado = await executarBackup({ janela: t.janela, etapas: tresEtapas(t.linha), avaliar: VALIDO });
    assert.equal(executouAlgumaEtapa(t.linha), false);
    assert.equal(resultado.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(resultado.valido, false);
  });

  test('JBK-06 — a perda só aparece na liberação (todas as etapas e o veredito estavam bons): nunca saída 0, saída 10, inválido', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const etapas = tresEtapas(t.linha);
    const avaliar = () => { t.trocarPorOutroDono(); return { valido: true, motivos: [] }; };
    const resultado = await executarBackup({ janela: t.janela, etapas, avaliar });
    assert.notEqual(resultado.saida, SAIDA.VALIDO);
    assert.equal(resultado.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(resultado.valido, false);
    assert.equal(resultado.janela, 'PERDIDA');
    assert.deepEqual(t.estado.documento, { tipo: TIPOS.LIMPEZA, token: 'token-alheio' });
  });

  test('JBK-07 — a trava é APAGADA por fora no meio: nada mais avança, saída 10, e o backup NÃO recria a trava (uma aquisição só)', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const etapas = tresEtapas(t.linha, { dump: async () => { t.apagarPorFora(); return { ok: true }; } });
    const resultado = await executarBackup({ janela: t.janela, etapas, avaliar: VALIDO });
    assert.deepEqual(resultado.etapasExecutadas, ['snapshot', 'dump']);
    assert.equal(resultado.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(t.estado.aquisicoes, 1);
    assert.equal(t.estado.documento, null, 'ninguém recriou a trava');
  });
});

describe('[JBK] a liberação é do dono, num ponto só, uma única vez', () => {
  test('JBK-08 — etapa que falha: a trava ainda é solta pelo próprio manipulador, UMA vez, depois do fim da etapa; o resultado nunca é válido', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const etapas = tresEtapas(t.linha, { dump: async () => { throw Object.assign(new Error('dump falhou'), { codigo: 'DUMP_FALHOU' }); } });
    const resultado = await executarBackup({ janela: t.janela, etapas, avaliar: VALIDO });
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(t.estado.documento, null);
    assert.equal(t.linha.includes('etapa:copia:inicio'), false);
    assert.notEqual(resultado.saida, SAIDA.VALIDO);
    assert.equal(resultado.valido, false);
  });

  test('JBK-09 — pedido de parada (dois sinais) DURANTE uma etapa lenta que depois falha: o pedido não solta a trava; liberar é chamado UMA vez, só depois de a etapa terminar', async () => {
    const { executarBackup } = servico();
    let liberarDaDemora;
    const t = criarJanelaFalsa({ liberarDemora: () => new Promise((resolver) => { liberarDaDemora = resolver; setImmediate(resolver); }) });
    const ouvintes = [];
    const parada = { aoPedir(funcao) { ouvintes.push(funcao); } };
    const pedir = () => { for (const ouvinte of ouvintes) ouvinte('SIGTERM'); };
    const etapas = tresEtapas(t.linha, {
      dump: async () => {
        pedir();
        const logoDepoisDoPedido = t.linha.includes('liberar:inicio');
        pedir();
        await new Promise((resolver) => setImmediate(resolver));
        assert.equal(logoDepoisDoPedido, false, 'o pedido de parada não pode soltar a trava');
        assert.equal(t.linha.includes('liberar:inicio'), false, 'nem enquanto a etapa ainda corre');
        throw new Error('interrompido');
      },
    });
    const resultado = await executarBackup({ janela: t.janela, etapas, avaliar: VALIDO, parada });
    assert.equal(typeof liberarDaDemora, 'function');
    assert.equal(t.estado.liberacoes, 1, 'liberar foi chamado exatamente uma vez');
    assert.ok(t.linha.indexOf('liberar:inicio') > t.linha.indexOf('etapa:dump:inicio'));
    assert.equal(resultado.valido, false);
    assert.notEqual(resultado.saida, SAIDA.VALIDO);
  });

  test('JBK-10 — pedido de parada durante a ÚLTIMA etapa, que termina BEM: o backup interrompido NÃO é válido nem sai com 0 (mesmo com o veredito bom); uma única liberação, só depois de a etapa terminar, nunca a partir do pedido', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa({ liberarDemora: () => new Promise((resolver) => setImmediate(resolver)) });
    const ouvintes = [];
    const parada = { aoPedir(funcao) { ouvintes.push(funcao); } };
    const etapas = tresEtapas(t.linha, { copia: async () => { for (const ouvinte of ouvintes) ouvinte('SIGINT'); return { ok: true }; } });
    const resultado = await executarBackup({ janela: t.janela, etapas, avaliar: VALIDO, parada });
    assert.ok(ouvintes.length >= 1, 'o backup registra o pedido de parada');
    assert.equal(t.estado.liberacoes, 1);
    assert.ok(t.linha.indexOf('liberar:inicio') > t.linha.indexOf('etapa:copia:fim'));
    assert.equal(resultado.valido, false, 'interrompido nunca é válido');
    assert.notEqual(resultado.saida, SAIDA.VALIDO, 'interrompido nunca sai com 0');
    assert.equal(resultado.recuperavel, false);
  });

  test('JBK-11 — pedido de parada no MEIO (durante o dump, que termina bem): a etapa corrente conclui sob supervisão, a cópia NÃO começa, a trava é solta uma vez depois do fim do dump e o resultado não é válido', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const ouvintes = [];
    const parada = { aoPedir(funcao) { ouvintes.push(funcao); } };
    const etapas = tresEtapas(t.linha, { dump: async () => { for (const ouvinte of ouvintes) ouvinte('SIGTERM'); return { ok: true }; } });
    const resultado = await executarBackup({ janela: t.janela, etapas, avaliar: VALIDO, parada });
    assert.deepEqual(resultado.etapasExecutadas, ['snapshot', 'dump']);
    assert.equal(t.linha.includes('etapa:copia:inicio'), false, 'nenhuma etapa nova depois do pedido');
    assert.equal(t.estado.liberacoes, 1);
    assert.ok(t.linha.indexOf('liberar:inicio') > t.linha.indexOf('etapa:dump:fim'));
    assert.equal(resultado.valido, false);
    assert.notEqual(resultado.saida, SAIDA.VALIDO);
  });
});

describe('[JBK] etapa que não confirma sucesso nunca vira sucesso', () => {
  test('JBK-12 — etapa que devolve { ok: false } (falha explícita): as seguintes não rodam, a trava é solta uma vez, o resultado não é válido e a saída não é 0', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const etapas = tresEtapas(t.linha, { dump: async () => ({ ok: false }) });
    const resultado = await executarBackup({ janela: t.janela, etapas, avaliar: VALIDO });
    assert.equal(t.linha.includes('etapa:copia:inicio'), false);
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(t.estado.documento, null);
    assert.equal(resultado.valido, false);
    assert.notEqual(resultado.saida, SAIDA.VALIDO);
    assert.equal(resultado.recuperavel, false);
  });

  for (const [rotulo, devolvido] of [
    ['undefined (sem resultado)', undefined],
    ['null', null],
    ['objeto vazio', {}],
    ['ok como texto', { ok: 'true' }],
    ['ok como número', { ok: 1 }],
    ['texto solto', 'ok'],
  ]) {
    test(`JBK-13 (${rotulo}) — resultado ausente ou incompleto de uma etapa é falha: as seguintes não rodam e o resultado nunca é válido`, async () => {
      const { executarBackup } = servico();
      const t = criarJanelaFalsa();
      const etapas = tresEtapas(t.linha, { snapshot: async () => devolvido });
      const resultado = await executarBackup({ janela: t.janela, etapas, avaliar: VALIDO });
      assert.equal(t.linha.includes('etapa:dump:inicio'), false);
      assert.equal(t.estado.liberacoes, 1);
      assert.equal(resultado.valido, false);
      assert.notEqual(resultado.saida, SAIDA.VALIDO);
    });
  }

  for (const [rotulo, montar] of [
    ['sem o dump', (linha) => tresEtapas(linha).filter((e) => e.nome !== 'dump')],
    ['sem a cópia', (linha) => tresEtapas(linha).filter((e) => e.nome !== 'copia')],
    ['lista vazia', () => []],
    ['fora de ordem', (linha) => { const [s, d, c] = tresEtapas(linha); return [s, c, d]; }],
    ['etapa repetida', (linha) => { const [s, d, c] = tresEtapas(linha); return [s, d, d, c]; }],
    ['etapa desconhecida', (linha) => [...tresEtapas(linha), etapa(linha, 'extra')]],
    ['etapa sem executar', (linha) => { const [s, , c] = tresEtapas(linha); return [s, { nome: 'dump' }, c]; }],
  ]) {
    test(`JBK-14 (${rotulo}) — lista de etapas obrigatórias inválida: recusada ANTES da trava (saída 2), nenhuma etapa roda e nada é avaliado`, async () => {
      const { executarBackup } = servico();
      const t = criarJanelaFalsa();
      let avaliado = false;
      const resultado = await executarBackup({ janela: t.janela, etapas: montar(t.linha), avaliar: () => { avaliado = true; return { valido: true, motivos: [] }; } });
      assert.equal(resultado.saida, SAIDA.ARGUMENTOS);
      assert.equal(resultado.valido, false);
      assert.equal(t.estado.aquisicoes, 0, 'nem tenta a trava');
      assert.equal(executouAlgumaEtapa(t.linha), false);
      assert.equal(avaliado, false);
    });
  }

  for (const [rotulo, avaliacao] of [
    ['ausente', undefined],
    ['null', null],
    ['sem o campo valido', { motivos: [] }],
    ['valido como texto', { valido: 'true', motivos: [] }],
  ]) {
    test(`JBK-15 (avaliação ${rotulo}) — todas as etapas bem, mas o veredito não diz valido === true: o resultado não é válido e a saída não é 0`, async () => {
      const { executarBackup } = servico();
      const t = criarJanelaFalsa();
      const resultado = await executarBackup({ janela: t.janela, etapas: tresEtapas(t.linha), avaliar: () => avaliacao });
      assert.equal(t.estado.liberacoes, 1);
      assert.equal(resultado.valido, false);
      assert.notEqual(resultado.saida, SAIDA.VALIDO);
    });
  }
});

/**
 * RED-1B: o pedido de parada vale até o FIM da operação, não só entre as etapas. Barreiras determinísticas: o sinal é disparado de dentro da própria
 * avaliação assíncrona ou da própria liberação assíncrona (antes de elas resolverem), sem `sleep`, disco, banco nem processo.
 */
function paradaControlada() {
  const ouvintes = [];
  return {
    parada: { aoPedir(funcao) { ouvintes.push(funcao); } },
    pedir: (sinal) => { for (const ouvinte of ouvintes) ouvinte(sinal); },
  };
}

describe('[JBK] sinal recebido depois da última etapa ainda impede o sucesso (RED-1B)', () => {
  test('JBK-16 — SIGTERM chega DURANTE a avaliação assíncrona (que diz válido): nunca valido, nunca recuperável, nunca saída 0; a trava é solta uma vez, depois da avaliação', async () => {
    const { executarBackup } = servico();
    const t = criarJanelaFalsa();
    const p = paradaControlada();
    const avaliar = async () => {
      t.linha.push('avaliar:inicio');
      p.pedir('SIGTERM');
      await Promise.resolve();
      t.linha.push('avaliar:fim');
      return { valido: true, motivos: [] };
    };
    const resultado = await executarBackup({ janela: t.janela, etapas: tresEtapas(t.linha), avaliar, parada: p.parada });
    assert.equal(resultado.valido, false, 'interrompido durante a avaliação nunca é válido');
    assert.equal(resultado.recuperavel, false);
    assert.notEqual(resultado.saida, SAIDA.VALIDO);
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(t.estado.documento, null, 'a própria trava foi solta');
    assert.ok(t.linha.indexOf('liberar:inicio') > t.linha.indexOf('avaliar:fim'));
  });

  test('JBK-17 — SIGINT chega DURANTE a liberação assíncrona da trava: nunca valido, nunca saída 0; a liberação continua única e a trava é solta', async () => {
    const { executarBackup } = servico();
    const p = paradaControlada();
    const t = criarJanelaFalsa({ liberarDemora: async () => { p.pedir('SIGINT'); await Promise.resolve(); } });
    const resultado = await executarBackup({ janela: t.janela, etapas: tresEtapas(t.linha), avaliar: VALIDO, parada: p.parada });
    assert.equal(resultado.valido, false, 'interrompido durante a liberação nunca é válido');
    assert.equal(resultado.recuperavel, false);
    assert.notEqual(resultado.saida, SAIDA.VALIDO);
    assert.equal(t.estado.liberacoes, 1);
    assert.equal(t.estado.documento, null);
  });

  test('JBK-18 — a precedência das falhas mais graves continua: sinal na avaliação + posse perdida = 10; sinal na liberação + liberação não confirmada = 10; sinal na avaliação + avaliação que lança = 1; sinal na avaliação + veredito não válido = 9', async () => {
    const { executarBackup } = servico();

    const perdaNaAvaliacao = criarJanelaFalsa();
    const p1 = paradaControlada();
    const r1 = await executarBackup({
      janela: perdaNaAvaliacao.janela,
      etapas: tresEtapas(perdaNaAvaliacao.linha),
      avaliar: async () => { p1.pedir('SIGTERM'); perdaNaAvaliacao.trocarPorOutroDono(); return { valido: true, motivos: [] }; },
      parada: p1.parada,
    });
    assert.equal(r1.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(r1.valido, false);
    assert.deepEqual(perdaNaAvaliacao.estado.documento, { tipo: TIPOS.LIMPEZA, token: 'token-alheio' }, 'a trava alheia continua lá');

    const p2 = paradaControlada();
    let perdaNaLiberacao;
    perdaNaLiberacao = criarJanelaFalsa({ liberarDemora: async () => { p2.pedir('SIGINT'); perdaNaLiberacao.trocarPorOutroDono(); } });
    const r2 = await executarBackup({ janela: perdaNaLiberacao.janela, etapas: tresEtapas(perdaNaLiberacao.linha), avaliar: VALIDO, parada: p2.parada });
    assert.equal(r2.saida, SAIDA.JANELA_PERDIDA);
    assert.equal(r2.valido, false);

    const lanca = criarJanelaFalsa();
    const p3 = paradaControlada();
    const r3 = await executarBackup({
      janela: lanca.janela,
      etapas: tresEtapas(lanca.linha),
      avaliar: async () => { p3.pedir('SIGTERM'); throw new Error('avaliação quebrou'); },
      parada: p3.parada,
    });
    assert.equal(r3.saida, SAIDA.ERRO);
    assert.equal(r3.valido, false);
    assert.equal(lanca.estado.liberacoes, 1);

    const invalido = criarJanelaFalsa();
    const p4 = paradaControlada();
    const r4 = await executarBackup({
      janela: invalido.janela,
      etapas: tresEtapas(invalido.linha),
      avaliar: async () => { p4.pedir('SIGINT'); return { valido: false, motivos: ['X'] }; },
      parada: p4.parada,
    });
    assert.equal(r4.saida, 9);
    assert.equal(r4.valido, false);
  });
});
