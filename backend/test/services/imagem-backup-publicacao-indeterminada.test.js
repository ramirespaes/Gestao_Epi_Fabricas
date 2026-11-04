'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { criarProdutorDeRelatorio } = require('../../src/services/imagem-backup-publicacao.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');
const { ambiente } = require('../helpers/ambiente-backup-operacao');

/**
 * PUBLICAÇÃO INDETERMINADA: a publicação (`publicar`) é o ÚNICO ponto físico sem cancelamento. Aqui o publicador REAL é usado com dependências controladas (ops de sistema de arquivos injetáveis, que o próprio `criarPublicador` aceita) e, quando é preciso uma exceção DEPOIS da
 * publicação física, com um invólucro que chama o publicador real e só então lança (o módulo de publicação é substituído no cache só neste processo e restaurado ao fim). Nada fabrica origem OPERACIONAL; HMAC, proveniência e reconhecimento da publicação ficam como estão.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-ind-test-' });
after(() => { fix.remover(); });
const adiado = () => { let resolver; const promessa = new Promise((r) => { resolver = r; }); return { promessa, resolver }; };
const andar = async (vezes = 10) => { for (let i = 0; i < vezes; i += 1) await new Promise((r) => setImmediate(r)); };
const ate = async (condicao, rotulo = 'condição') => { const limite = Date.now() + 10000; while (Date.now() < limite) { if (condicao()) return; await new Promise((r) => setTimeout(r, 2)); } assert.fail(`não ocorreu: ${rotulo}`); };
const erroCom = (code) => Object.assign(new Error('SEGREDO-NUNCA-EXPOR'), { code });
function relogioManual() {
  const ativos = new Set();
  return {
    prazo(ms) { const p = { ms }; p.promessa = new Promise((r) => { p.resolver = r; }); ativos.add(p); return { promessa: p.promessa, cancelar() { ativos.delete(p); } }; },
    intervalo: () => Promise.resolve(),
    disparar(ms) { for (const p of [...ativos]) if (p.ms === ms) { ativos.delete(p); p.resolver(); } },
    registrado: (ms) => [...ativos].some((p) => p.ms === ms),
  };
}

const pubPath = require.resolve('../../src/services/imagem-backup-publicacao.service');
const encPath = require.resolve('../../src/services/imagem-backup-encadeamento-confiavel-integrado.service');
const prodPath = require.resolve('../../src/services/imagem-backup-composicao-producao.service');

/** Carrega a composição de produção com `criarPublicador` substituído por uma fábrica de teste (só neste processo; restaura tudo ao fim). */
async function comPublicador(fabrica, fn) {
  require(pubPath);
  const original = require.cache[pubPath].exports;
  const salvos = { enc: require.cache[encPath], prod: require.cache[prodPath] };
  const marcados = new WeakSet();
  require.cache[pubPath].exports = {
    ...original,
    criarPublicador: (opcoes) => { const falso = fabrica(original, opcoes); marcados.add(falso); return falso; },
    ehPublicador: (v) => marcados.has(v) || original.ehPublicador(v),
  };
  delete require.cache[encPath];
  delete require.cache[prodPath];
  try {
    return await fn(require(prodPath));
  } finally {
    require.cache[pubPath].exports = original;
    if (salvos.enc === undefined) delete require.cache[encPath]; else require.cache[encPath] = salvos.enc;
    if (salvos.prod === undefined) delete require.cache[prodPath]; else require.cache[prodPath] = salvos.prod;
  }
}

describe('[IND] publicação indeterminada, cancelamento durante a publicação e bloqueio efetivo', () => {
  const ETAPA = 7201;
  const CORTESIA = 7202;
  const executar = (producao, a) => producao.criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: 'prep-1', conjuntoId: 'conjunto-ind-0001' });
  const fsyncReal = async (p) => { const h = await fsp.open(p, fs.constants.O_RDONLY); try { await h.sync(); } finally { await h.close(); } };

  teste('IND-1 — publicação INCERTA (rename físico feito, fsync do destino falha e a reversão também falha): o pacote está FISICAMENTE no destino, mas sem conclusão reconhecida (publicada:false, INCERTA); nada vira publicação operacional nem backup válido; quarentena como bloqueio efetivo', async () => {
    const fabrica = (original, opcoes) => {
      let renames = 0;
      return original.criarPublicador({
        ...opcoes,
        ops: {
          rename: async (de, para) => { renames += 1; if (renames === 1) return fsp.rename(de, para); throw erroCom('EIO'); },
          fsyncDiretorio: async (p) => { if (p === opcoes.raizDoDestino) throw erroCom('EIO'); return fsyncReal(p); },
        },
      });
    };
    await comPublicador(fabrica, async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.deepEqual([composto.resultado.publicacao.publicada, composto.resultado.publicacao.estado], [false, 'INCERTA']);
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), ['prep-1'], 'fisicamente no destino');
      assert.equal(fs.existsSync(path.join(a.dirs.publicados, 'prep-1', 'manifesto.json')), true);
      const e = producao.classificarEstadoDoBackup(composto);
      assert.deepEqual([e.pacotePublicado, e.publicacaoOperacional, e.backupOperacionalValido, e.recuperabilidadeComprovada], [false, false, false, false]);
      assert.deepEqual([e.quarentena.recomendada, [...e.quarentena.motivos]], [true, ['PUBLICACAO_INCERTA']]);
      assert.equal(JSON.stringify(composto.resultado).includes('SEGREDO'), false);
    });
  });

  teste('IND-2 — EXCEÇÃO durante a publicação, DEPOIS de a publicação física acontecer (publicador real, invólucro que lança em seguida): fase INDETERMINADA, pacote ERRO_INTERNO, `publicacao` nulo, pacote fisicamente publicado sem conclusão reconhecida; nada válido, quarentena efetiva, a causa não vaza', async () => {
    const fabrica = (original, opcoes) => {
      const real = original.criarPublicador(opcoes);
      return Object.freeze({ servico: real.servico, async publicar(entrada) { await real.publicar(entrada); throw erroCom('EIO'); } });
    };
    await comPublicador(fabrica, async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.equal(composto.resultado.publicacao, null);
      assert.equal(composto.resultado.pacote.motivo, 'ERRO_INTERNO');
      assert.equal(composto.proveniencia.publicacao.faseNaSaida, 'INDETERMINADA');
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), ['prep-1'], 'publicado fisicamente');
      const e = producao.classificarEstadoDoBackup(composto);
      assert.deepEqual([e.pacotePublicado, e.publicacaoOperacional, e.backupOperacionalValido, e.recuperabilidadeComprovada], [false, false, false, false]);
      assert.deepEqual([e.quarentena.recomendada, [...e.quarentena.motivos]], [true, ['PUBLICACAO_SEM_CONCLUSAO_CONHECIDA']]);
      assert.equal(composto.resultado.coordenador.valido, false);
      assert.equal(JSON.stringify(composto).includes('SEGREDO'), false);
    });
  });

  teste('IND-3 — CANCELAMENTO durante a publicação + exceção TARDIA: a cortesia vence com a publicação em andamento (trava RETIDA, nada publicado na saída); depois a publicação física termina e a exceção chega: a conclusão tardia é observada (INDETERMINADA, operação tardia, nenhuma pendência), a trava continua retida e a classificação feita DEPOIS reflete a leitura fresca', async () => {
    const portao = adiado();
    const estado = { entrou: false };
    const fabrica = (original, opcoes) => {
      const real = original.criarPublicador(opcoes);
      return Object.freeze({ servico: real.servico, async publicar(entrada) { estado.entrou = true; await portao.promessa; await real.publicar(entrada); throw erroCom('EIO'); } });
    };
    await comPublicador(fabrica, async (producao) => {
      const relogio = relogioManual();
      const a = await ambiente({ portasExtras: { temporizador: relogio }, alterarConfig: (c) => { c.operacoes = { etapaMs: ETAPA, cortesiaMs: CORTESIA }; return c; } });
      const rodando = executar(producao, a);
      await ate(() => estado.entrou, 'publicação em andamento');
      relogio.disparar(ETAPA);
      await ate(() => relogio.registrado(CORTESIA), 'cortesia');
      relogio.disparar(CORTESIA);
      const composto = await rodando;
      const c = composto.resultado.coordenador;
      assert.deepEqual([c.saida, c.janela, c.finalizacao, c.valido], [11, 'RETIDA', 'ADIADA', false]);
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), []);
      assert.equal(composto.proveniencia.publicacao.faseNaSaida, 'PUBLICANDO');
      const naSaida = producao.classificarEstadoDoBackup(composto);
      assert.deepEqual([naSaida.quarentena.recomendada, naSaida.backupOperacionalValido, naSaida.recuperacaoAutorizadaDaTravaNecessaria], [true, false, true]);
      assert.ok(naSaida.quarentena.motivos.includes('OPERACAO_AINDA_PENDENTE'), 'a leitura fresca vê a operação ainda pendente');

      portao.resolver();
      await ate(() => composto.proveniencia.situacaoAtual().fasePublicacao === 'INDETERMINADA', 'resultado tardio observado');
      const agora = composto.proveniencia.situacaoAtual();
      assert.equal(agora.operacoes.pendentes, 0, 'a operação assentou (tardiamente)');
      const avaliacao = agora.operacoes.operacoes.find((o) => o.etapa === 'avaliacao');
      assert.deepEqual([avaliacao.estado, avaliacao.tardia], ['ASSENTADA', true]);
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), ['prep-1'], 'publicado fisicamente depois da saída');
      assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), true, 'a trava continua retida');
      assert.equal(composto.resultado.publicacao, null, 'o resultado devolvido não é reescrito');
      const depois = producao.classificarEstadoDoBackup(composto);
      assert.deepEqual([depois.quarentena.recomendada, depois.backupOperacionalValido, depois.publicacaoOperacional, depois.pacotePublicado], [true, false, false, false]);
      assert.ok(depois.quarentena.motivos.includes('PUBLICACAO_SEM_CONCLUSAO_CONHECIDA'));
      assert.equal(depois.quarentena.motivos.includes('OPERACAO_AINDA_PENDENTE'), false, 'a pendência assentou; a quarentena continua pela publicação sem conclusão');
    });
  });

  teste('IND-4 — publicado sob cancelamento NÃO é promovido por outro caminho de leitura: a classificação feita de uma CÓPIA/clone do resultado é irreconhecível (tudo falso), o resultado reconhecido é congelado e a leitura fresca só acrescenta cautela', async () => {
    const portao = adiado();
    const estado = { entrou: false };
    const fabrica = (original, opcoes) => {
      const real = original.criarPublicador(opcoes);
      return Object.freeze({ servico: real.servico, publicar: async (entrada) => { estado.entrou = true; await portao.promessa; return real.publicar(entrada); } });
    };
    await comPublicador(fabrica, async (producao) => {
      const relogio = relogioManual();
      const a = await ambiente({ portasExtras: { temporizador: relogio }, alterarConfig: (c) => { c.operacoes = { etapaMs: ETAPA, cortesiaMs: CORTESIA }; return c; } });
      const rodando = executar(producao, a);
      await ate(() => estado.entrou);
      relogio.disparar(ETAPA);
      await ate(() => relogio.registrado(CORTESIA));
      portao.resolver();
      const composto = await rodando;
      const e = producao.classificarEstadoDoBackup(composto);
      assert.deepEqual([e.pacotePublicado, e.quarentena.recomendada, e.backupOperacionalValido, e.publicacaoOperacional], [true, true, false, false]);
      assert.deepEqual([...e.quarentena.motivos], ['PUBLICADO_SOB_CANCELAMENTO_OU_PENDENCIA']);
      for (const falso of [{ ...composto }, JSON.parse(JSON.stringify({ resultado: composto.resultado, prontidao: composto.prontidao, proveniencia: {} })), Object.create(composto)]) {
        const x = producao.classificarEstadoDoBackup(falso);
        assert.deepEqual([x.reconhecido, x.backupOperacionalValido, x.publicacaoOperacional, x.pacotePublicado], [false, false, false, false]);
      }
      assert.equal(Object.isFrozen(composto) && Object.isFrozen(composto.resultado), true);
    });
  });

  teste('IND-5 — o BLOQUEIO é efetivo, não textual: a decisão única de validade recusa qualquer combinação em quarentena, ainda que todas as outras dimensões sejam verdadeiras, e recusa valores que não sejam exatamente booleanos', async () => {
    const { derivarBackupOperacionalValido } = require(prodPath);
    const tudo = { prontidaoOperacional: true, coordenadorValido: true, publicacaoOperacional: true, emQuarentena: false };
    assert.equal(derivarBackupOperacionalValido(tudo), true, 'contraprova: só a combinação completa e fora de quarentena é válida');
    assert.equal(derivarBackupOperacionalValido({ ...tudo, emQuarentena: true }), false);
    for (const k of Object.keys(tudo)) {
      assert.equal(derivarBackupOperacionalValido({ ...tudo, [k]: k === 'emQuarentena' ? true : false }), false, k);
      for (const estranho of [undefined, null, 1, 'true', {}]) assert.equal(derivarBackupOperacionalValido({ ...tudo, [k]: estranho }), false, `${k}=${String(estranho)}`);
    }
  });

  teste('IND-6 — contraprova de sucesso: a mesma publicação real, sem cancelamento nem exceção, termina CONCLUIDA, fora de quarentena (a validade continua impossível porque a publicação operacional está bloqueada)', async () => {
    const fabrica = (original, opcoes) => original.criarPublicador(opcoes);
    await comPublicador(fabrica, async (producao) => {
      const a = await ambiente();
      const composto = await executar(producao, a);
      assert.equal(composto.resultado.publicacao.publicada, true);
      assert.equal(composto.proveniencia.publicacao.faseNaSaida, 'CONCLUIDA');
      const e = producao.classificarEstadoDoBackup(composto);
      assert.deepEqual([e.quarentena.recomendada, e.backupOperacionalValido, e.publicacaoOperacional], [false, false, false]);
    });
  });
});
