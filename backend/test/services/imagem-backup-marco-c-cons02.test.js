'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarArmazenamentoImagens, executarComRemocaoProtegida, chaveDe } = require('../../src/storage/armazenamento-imagens');
const { adquirirJanela, ehPosseDeJanela, TIPOS, ErroDeJanela } = require('../../src/utils/janela-escrita-imagens');

/**
 * CONS-02 (exclusão mútua entre o backup e a remoção física de imagens): janela REAL (arquivo de trava exclusivo de teste, fora do armazenamento, protocolo real de `adquirirJanela`), armazenamento REAL em diretório temporário e
 * concorrência REAL (promessas simultâneas). Só dados fictícios. A proteção cobre as remoções feitas PELO armazenamento de imagens e pelo consumidor adaptado; NÃO cobre escritor externo à aplicação (contraprova explícita CS-12).
 */

const PREFIXO = 'gepi-cons02-test-';
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});
const novaRaiz = () => { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO))); fs.chmodSync(p, 0o700); raizes.push(p); return p; };
const teste = (nome, fn) => test(nome, { timeout: 20000 }, fn);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Mundo: armazenamento REAL com três variantes de uma imagem de empresa, e um arquivo de trava FORA da árvore de imagens. */
async function mundo() {
  const diretorio = novaRaiz();
  const arquivoDaJanela = path.join(novaRaiz(), 'janela.lock');
  const base = crypto.randomBytes(24);
  const hash = sha(base);
  const chaves = {
    mestre: chaveDe({ escopo: 'EMPRESA', empresaId: 7, sha256: hash, variante: 'mestre', formato: 'PNG' }),
    exibicao: chaveDe({ escopo: 'EMPRESA', empresaId: 7, sha256: hash, variante: 'exibicao', formato: 'WEBP' }),
    miniatura: chaveDe({ escopo: 'EMPRESA', empresaId: 7, sha256: hash, variante: 'miniatura', formato: 'WEBP' }),
  };
  const escrita = criarArmazenamentoImagens({ diretorio });
  for (const chave of Object.values(chaves)) await escrita.gravar(chave, Buffer.concat([base, Buffer.from(chave)]), { maxBytes: 4096 });
  const fisico = (chave) => path.join(diretorio, ...chave.split('/'));
  const hashes = () => Object.fromEntries(Object.entries(chaves).map(([k, c]) => [k, fs.existsSync(fisico(c)) ? sha(fs.readFileSync(fisico(c))) : null]));
  const adquirir = (tipo) => adquirirJanela({ arquivo: arquivoDaJanela, tipo, raizArmazenamento: diretorio });
  const com = (posse) => criarArmazenamentoImagens({ diretorio, janelaDeRemocao: posse });
  return { diretorio, arquivoDaJanela, chaves, fisico, hashes, adquirir, com, escrita, hash };
}
const recusaPorJanela = (promessa) => assert.rejects(promessa, (e) => { assert.equal(e.codigo, 'REMOCAO_SEM_JANELA'); assert.equal(String(e.message).includes(os.tmpdir()), false); return true; });

describe('[CS] remoção física do armazenamento: só com a POSSE de LIMPEZA verdadeira e confirmada', () => {
  teste('CS-01 — posse LEGÍTIMA de LIMPEZA: `remover` apaga só o arquivo pedido e `removerVariantes` apaga as variantes da imagem; a janela segue minha até liberar', async () => {
    const m = await mundo();
    const posse = await m.adquirir(TIPOS.LIMPEZA);
    try {
      const a = m.com(posse);
      const antes = m.hashes();
      await a.remover(m.chaves.mestre);
      assert.equal(fs.existsSync(m.fisico(m.chaves.mestre)), false);
      assert.deepEqual([m.hashes().exibicao, m.hashes().miniatura], [antes.exibicao, antes.miniatura]);
      await a.removerVariantes({ escopo: 'EMPRESA', empresaId: 7, sha256: m.hash });
      assert.deepEqual(Object.values(m.hashes()), [null, null, null]);
      assert.equal((await posse.confirmarPosse()).confirmada, true);
    } finally { await posse.liberar(); }
  });

  teste('CS-02 — SEM posse (nenhuma `janelaDeRemocao`): `remover` e `removerVariantes` recusam com REMOCAO_SEM_JANELA e as imagens ficam byte a byte iguais', async () => {
    const m = await mundo();
    const antes = m.hashes();
    const semJanela = criarArmazenamentoImagens({ diretorio: m.diretorio });
    await recusaPorJanela(semJanela.remover(m.chaves.mestre));
    await recusaPorJanela(semJanela.removerVariantes({ escopo: 'EMPRESA', empresaId: 7, sha256: m.hash }));
    assert.deepEqual(m.hashes(), antes);
  });

  teste('CS-03 — posse FALSA: objeto literal que imita a interface, clone da posse verdadeira e posse de outro tipo de objeto são recusados', async () => {
    const m = await mundo();
    const verdadeira = await m.adquirir(TIPOS.LIMPEZA);
    try {
      const antes = m.hashes();
      const falsas = [
        { tipo: 'LIMPEZA', confirmarPosse: async () => ({ confirmada: true }), liberar: async () => ({ liberada: true }) },
        { ...verdadeira },
        Object.freeze({ tipo: verdadeira.tipo, confirmarPosse: verdadeira.confirmarPosse, liberar: verdadeira.liberar }),
        'LIMPEZA', 42, null,
      ];
      assert.equal(ehPosseDeJanela(verdadeira), true);
      for (const falsa of falsas) {
        if (falsa !== null && falsa !== undefined) assert.equal(ehPosseDeJanela(falsa), false);
        const a = criarArmazenamentoImagens({ diretorio: m.diretorio, janelaDeRemocao: falsa ?? undefined });
        await recusaPorJanela(a.remover(m.chaves.mestre));
        await recusaPorJanela(a.removerVariantes({ escopo: 'EMPRESA', empresaId: 7, sha256: m.hash }));
      }
      assert.deepEqual(m.hashes(), antes);
    } finally { await verdadeira.liberar(); }
  });

  teste('CS-04 — posse do tipo BACKUP (verdadeira, mas do tipo errado) NÃO autoriza remoção', async () => {
    const m = await mundo();
    const backup = await m.adquirir(TIPOS.BACKUP);
    try {
      const antes = m.hashes();
      const a = m.com(backup);
      await recusaPorJanela(a.remover(m.chaves.mestre));
      await recusaPorJanela(a.removerVariantes({ escopo: 'EMPRESA', empresaId: 7, sha256: m.hash }));
      assert.deepEqual(m.hashes(), antes);
      assert.equal((await backup.confirmarPosse()).confirmada, true, 'a posse do backup não foi tocada');
    } finally { await backup.liberar(); }
  });

  teste('CS-05 — posse LIBERADA (depois do `liberar`) é recusada: liberação antecipada da janela desarma a remoção', async () => {
    const m = await mundo();
    const posse = await m.adquirir(TIPOS.LIMPEZA);
    const a = m.com(posse);
    assert.equal((await posse.liberar()).liberada, true);
    const antes = m.hashes();
    await recusaPorJanela(a.remover(m.chaves.mestre));
    await recusaPorJanela(a.removerVariantes({ escopo: 'EMPRESA', empresaId: 7, sha256: m.hash }));
    assert.deepEqual(m.hashes(), antes);
  });

  teste('CS-06 — posse PERDIDA (arquivo de trava removido ou trocado por outro dono): `confirmarPosse` falha e a remoção é recusada; nada é apagado', async () => {
    const m = await mundo();
    const posse = await m.adquirir(TIPOS.LIMPEZA);
    const a = m.com(posse);
    const antes = m.hashes();
    fs.unlinkSync(m.arquivoDaJanela); // alguém removeu a trava por fora
    await recusaPorJanela(a.remover(m.chaves.mestre));
    assert.deepEqual(m.hashes(), antes);
    const outro = await m.adquirir(TIPOS.BACKUP); // e agora o backup a toma: a posse antiga continua inválida
    try {
      await recusaPorJanela(a.removerVariantes({ escopo: 'EMPRESA', empresaId: 7, sha256: m.hash }));
      assert.deepEqual(m.hashes(), antes);
    } finally { await outro.liberar(); }
  });

  teste('CS-07 — a chave inválida continua CHAVE_INVALIDA (a validação precede a janela) e uma posse válida não relaxa nenhuma validação', async () => {
    const m = await mundo();
    const posse = await m.adquirir(TIPOS.LIMPEZA);
    try {
      const a = m.com(posse);
      for (const ruim of ['', '../x', 'padrao/zz/mestre.png', `7/${m.hash}/outro.bin`, 42, null]) {
        await assert.rejects(a.remover(ruim), (e) => e.codigo === 'CHAVE_INVALIDA');
      }
      await assert.rejects(a.removerVariantes({ escopo: 'EMPRESA', empresaId: 0, sha256: m.hash }), (e) => e.codigo === 'CHAVE_INVALIDA');
    } finally { await posse.liberar(); }
  });
});

describe('[CS] exclusão mútua REAL entre backup e limpeza (concorrência, liberação e ausência de deadlock)', () => {
  teste('CS-08 — BACKUP e LIMPEZA disputam a janela ao mesmo tempo: exatamente UM vence, o outro recebe JANELA_OCUPADA sem esperar; depois de liberar, o perdedor consegue (nada fica preso)', async () => {
    for (let rodada = 0; rodada < 8; rodada += 1) {
      const m = await mundo();
      const resultados = await Promise.allSettled([m.adquirir(TIPOS.BACKUP), m.adquirir(TIPOS.LIMPEZA)]);
      const ganhou = resultados.filter((r) => r.status === 'fulfilled');
      const perdeu = resultados.filter((r) => r.status === 'rejected');
      assert.equal(ganhou.length, 1, `rodada ${rodada}`);
      assert.equal(perdeu.length, 1);
      assert.ok(perdeu[0].reason instanceof ErroDeJanela);
      assert.equal(perdeu[0].reason.codigo, 'JANELA_OCUPADA');
      assert.equal((await ganhou[0].value.liberar()).liberada, true);
      assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'janela livre');
      const proximo = await m.adquirir(perdeu[0].reason ? (ganhou[0].value.tipo === TIPOS.BACKUP ? TIPOS.LIMPEZA : TIPOS.BACKUP) : TIPOS.LIMPEZA);
      assert.equal((await proximo.liberar()).liberada, true);
    }
  });

  teste('CS-09 — com o BACKUP em andamento, a remoção protegida FALHA com segurança (JANELA_OCUPADA, sem esperar nem remover), as imagens protegidas ficam byte a byte iguais e a posse do backup permanece intacta', async () => {
    const m = await mundo();
    const backup = await m.adquirir(TIPOS.BACKUP);
    try {
      const antes = m.hashes();
      let chamou = false;
      await assert.rejects(
        executarComRemocaoProtegida({ diretorio: m.diretorio, arquivoDaJanela: m.arquivoDaJanela, operacao: async (a) => { chamou = true; await a.remover(m.chaves.mestre); } }),
        (e) => e instanceof ErroDeJanela && e.codigo === 'JANELA_OCUPADA',
      );
      assert.equal(chamou, false, 'a operação nem começou');
      assert.deepEqual(m.hashes(), antes);
      assert.equal((await backup.confirmarPosse()).confirmada, true);
    } finally { await backup.liberar(); }
    // com o backup liberado, a mesma remoção protegida passa
    await executarComRemocaoProtegida({ diretorio: m.diretorio, arquivoDaJanela: m.arquivoDaJanela, operacao: (a) => a.remover(m.chaves.mestre) });
    assert.equal(fs.existsSync(m.fisico(m.chaves.mestre)), false);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'a janela foi liberada');
  });

  teste('CS-10 — várias remoções protegidas SIMULTÂNEAS: nunca duas ao mesmo tempo (máximo 1 em execução), as demais falham com JANELA_OCUPADA sem bloquear, e ao final nenhuma trava sobra', async () => {
    const m = await mundo();
    let emExecucao = 0;
    let maximo = 0;
    const operacao = async (a) => {
      emExecucao += 1; maximo = Math.max(maximo, emExecucao);
      await new Promise((r) => setTimeout(r, 30));
      await a.remover(m.chaves.exibicao);
      emExecucao -= 1;
    };
    const resultados = await Promise.allSettled(Array.from({ length: 8 }, () => executarComRemocaoProtegida({ diretorio: m.diretorio, arquivoDaJanela: m.arquivoDaJanela, operacao })));
    const ok = resultados.filter((r) => r.status === 'fulfilled').length;
    assert.ok(ok >= 1);
    assert.equal(maximo, 1, 'exclusão mútua: nunca duas ao mesmo tempo');
    for (const r of resultados.filter((x) => x.status === 'rejected')) assert.equal(r.reason.codigo, 'JANELA_OCUPADA');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'sem trava remanescente');
    assert.equal(fs.existsSync(m.fisico(m.chaves.mestre)), true, 'o que ninguém pediu para remover ficou');
  });

  teste('CS-11 — FALHA dentro da operação libera a janela (finally) e propaga o erro original; a posse não é liberada duas vezes; uma nova aquisição funciona em seguida', async () => {
    const m = await mundo();
    await assert.rejects(
      executarComRemocaoProtegida({ diretorio: m.diretorio, arquivoDaJanela: m.arquivoDaJanela, operacao: async () => { throw Object.assign(new Error('falha da operação'), { codigo: 'FALHA_DA_OPERACAO' }); } }),
      (e) => e.codigo === 'FALHA_DA_OPERACAO',
    );
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'a janela foi liberada apesar da falha');
    // operação que libera a posse sozinha antes de terminar: o finally não quebra nem mascara o resultado
    const resultado = await executarComRemocaoProtegida({ diretorio: m.diretorio, arquivoDaJanela: m.arquivoDaJanela, operacao: async () => 'concluida' });
    assert.equal(resultado, 'concluida');
    const nova = await m.adquirir(TIPOS.BACKUP);
    assert.equal((await nova.liberar()).liberada, true);
    await assert.rejects(executarComRemocaoProtegida({ diretorio: m.diretorio, arquivoDaJanela: m.arquivoDaJanela, operacao: 'nao-e-funcao' }), TypeError);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'argumento inválido não adquire a janela');
  });

  teste('CS-12 — LIMITE declarado (contraprova): um escritor EXTERNO à aplicação (aqui, `fs.unlink` direto) apaga o arquivo mesmo com o backup em andamento; esta proteção NÃO cobre isso', async () => {
    const m = await mundo();
    const backup = await m.adquirir(TIPOS.BACKUP);
    try {
      fs.unlinkSync(m.fisico(m.chaves.miniatura));
      assert.equal(fs.existsSync(m.fisico(m.chaves.miniatura)), false);
    } finally { await backup.liberar(); }
  });

  teste('CS-13 — a gravação e a leitura não exigem a janela (não mudaram): adicionar arquivo durante o backup é possível e não remove nada', async () => {
    const m = await mundo();
    const backup = await m.adquirir(TIPOS.BACKUP);
    try {
      const antes = m.hashes();
      const novo = crypto.randomBytes(24);
      const chaveNova = chaveDe({ escopo: 'EMPRESA', empresaId: 7, sha256: sha(novo), variante: 'mestre', formato: 'PNG' });
      await m.escrita.gravar(chaveNova, novo, { maxBytes: 4096 });
      assert.equal(await m.escrita.existe(chaveNova), true);
      assert.deepEqual(m.hashes(), antes);
    } finally { await backup.liberar(); }
  });
});
