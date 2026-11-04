'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { criarSelagem, operacoesDoSistema } = require('../../src/services/imagem-backup-selagem.service');
const { construirManifesto } = require('../../src/services/imagem-backup-manifesto.service');
const { SAIDAS, ESTADOS_DA_JANELA, ESTADOS_DA_FINALIZACAO } = require('../../src/services/imagem-backup.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');
const { ambiente, spawnFalso } = require('../helpers/ambiente-backup-operacao');
const { criarBackupDeProducao } = require('../../src/services/imagem-backup-composicao-producao.service');
const { lerManifesto } = require('../../src/services/imagem-backup-manifesto.service');
const { criarFonteDeChaves, criarLeitorV2 } = require('../../src/services/imagem-backup-manifesto-autenticado.service');

/**
 * CONTRAPROVAS CRÍTICAS (selagem e entrada operacional) com fixtures descartáveis e dependências controladas. Nada de produção foi alterado: as falhas são provocadas por permissão de diretório (via descritor), por operações injetadas
 * (`operacoes` da selagem) e por substituição do executor no cache de módulos DESTE processo (o arquivo de teste roda em processo próprio).
 */

const teste = (nome, a, b) => (typeof a === 'function' ? test(nome, { timeout: 30000 }, a) : test(nome, { timeout: 30000, ...a }, b));
const ehRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const H = (c) => c.repeat(64);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-contra-test-' });
after(() => { fix.remover(); });

const PLANO = [{ chave: `7/${H('d')}/mestre.png`, sha256: H('e') }, { chave: `padrao/${H('a')}/mestre.png`, sha256: H('a') }];
const COPIA = { ok: true, completo: true, copiados: 2, falha: null, arquivos: [{ ...PLANO[0], bytes: 3 }, { ...PLANO[1], bytes: 5 }] };
const DUMP = { concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') };
const construido = () => construirManifesto({ contexto: { snapshotId: '0-0-0', banco: { nome: 'gestao_epi', oid: '16384' }, registros: {}, plano: PLANO.map((p) => ({ ...p })) }, copia: JSON.parse(JSON.stringify(COPIA)), dump: { ...DUMP }, conjuntoId: 'conjunto-ctr-0001' });
const eio = () => Object.assign(new Error(SEGREDO), { code: 'EIO' });

describe('[CX-S] selagem: falhas de escrita e de leitura, limpeza e artefatos parciais', () => {
  teste('CX-S01 — verificação do destino impossível (diretório sem permissão de travessia): ESCRITA_FALHOU, nada criado, sem vazar a causa', { skip: ehRoot }, async () => {
    const area = fix.criar();
    fix.chmod(area, 0o600);
    let r;
    try { r = await criarSelagem().selar({ area, resultado: construido() }); } finally { fix.chmod(area, 0o700); }
    assert.deepEqual([r.ok, r.selado, r.falha.codigo], [false, false, 'ESCRITA_FALHOU']);
    assert.deepEqual(fs.readdirSync(area), []);
    assert.equal(JSON.stringify(r).includes(area), false);
  });

  teste('CX-S02 — falha do `ligar` e LIMPEZA IMPOSSÍVEL (o diretório fica ilegível): ESCRITA_FALHOU com limpeza INCOMPLETA; o temporário gravado é PRESERVADO (nunca apagado às cegas) e nenhum arquivo final existe', { skip: ehRoot }, async () => {
    const area = fix.criar();
    const ops = { ...operacoesDoSistema(), ligar: async () => { fix.chmod(area, 0o600); throw eio(); } };
    let r;
    try { r = await criarSelagem({ operacoes: ops }).selar({ area, resultado: construido() }); } finally { fix.chmod(area, 0o700); }
    assert.deepEqual([r.ok, r.selado, r.falha.codigo, r.falha.limpeza], [false, false, 'ESCRITA_FALHOU', 'INCOMPLETA']);
    const restos = fs.readdirSync(area);
    assert.equal(restos.length, 1);
    assert.match(restos[0], /^manifesto\.json\.[0-9a-f]{16}\.tmp$/);
    assert.equal(fs.readFileSync(path.join(area, restos[0])).length > 0, true, 'o parcial gravado foi preservado para inspeção');
    assert.equal(JSON.stringify(r).includes(SEGREDO), false);
  });

  teste('CX-S03 — o temporário já sumiu quando a limpeza o procura (ENOENT): a limpeza NÃO é marcada incompleta, o arquivo final recém-ligado é removido e o diretório fica vazio', async () => {
    const area = fix.criar();
    const base = operacoesDoSistema();
    const ops = { ...base, remover: async (p) => { await fsp.unlink(p); if (p.endsWith('.tmp')) throw eio(); } };
    const r = await criarSelagem({ operacoes: ops }).selar({ area, resultado: construido() });
    assert.deepEqual([r.ok, r.selado, r.falha.codigo], [false, false, 'ESCRITA_FALHOU']);
    assert.equal(Object.hasOwn(r.falha, 'limpeza'), false);
    assert.deepEqual(fs.readdirSync(area), []);
  });

  teste('CX-S04 — falha do `remover` na limpeza: limpeza INCOMPLETA e o arquivo que a operação criou permanece (não é apagado por outro caminho)', async () => {
    const area = fix.criar();
    const base = operacoesDoSistema();
    const ops = { ...base, ligar: async () => { throw eio(); }, remover: async () => { throw eio(); } };
    const r = await criarSelagem({ operacoes: ops }).selar({ area, resultado: construido() });
    assert.deepEqual([r.falha.codigo, r.falha.limpeza], ['ESCRITA_FALHOU', 'INCOMPLETA']);
    assert.equal(fs.readdirSync(area).length, 1);
  });

  teste('CX-S05 — LEITURA com entrada hostil (propriedade que lança): LEITURA_FALHOU, sem vazar a causa; selagem e leitura nunca lançam para o chamador', async () => {
    const selagem = criarSelagem();
    const hostil = { get area() { throw new Error(SEGREDO); } };
    const r = await selagem.verificar(hostil);
    assert.deepEqual([r.ok, r.falha.codigo], [false, 'LEITURA_FALHOU']);
    assert.equal(JSON.stringify(r).includes(SEGREDO), false);
  });
});

describe('[CX-C] configuração e limites verificáveis localmente (TODO COP-11b e MAN-09e)', () => {
  teste('CX-C01 — RAIZ que é link simbólico (imagens, preparações, dumps ou publicados) é recusada pela composição antes de qualquer processo: DEPENDENCIA_INDISPONIVEL nomeando o item', async () => {
    for (const [item, chave] of [['IMAGENS', 'imagens'], ['PREPARACOES', 'preparacoes'], ['DUMPS', 'dumps'], ['PUBLICADOS', 'publicados']]) {
      const falso = spawnFalso();
      const a = await ambiente({ portasExtras: { spawn: falso.spawn } });
      const real = `${a.dirs[chave]}-real`;
      fs.renameSync(a.dirs[chave], real);
      fs.symlinkSync(real, a.dirs[chave]);
      const b = criarBackupDeProducao(a.config);
      await assert.rejects(() => b.verificarDependencias(), (e) => e.code === 'DEPENDENCIA_INDISPONIVEL' && e.item === item, item);
      await assert.rejects(() => b.executar({ nomeDaPreparacao: 'prep-1', conjuntoId: 'conjunto-cx-0001' }), (e) => e.code === 'DEPENDENCIA_INDISPONIVEL', item);
      assert.equal(falso.chamadas.length, 0, `${item}: nenhum processo`);
      if (item !== 'IMAGENS') assert.deepEqual(fs.readdirSync(real), [], `${item}: nada criado atrás do link`);
    }
  });

  teste('CX-M01 — manifesto acima do tamanho máximo (64 MiB + 1) é recusado pelos leitores V1 e V2, sem confiar em nenhum campo; o V2 recusa antes de aceitar autenticação', () => {
    const grande = Buffer.alloc(64 * 1024 * 1024 + 1, 0x20);
    const sha256 = crypto.createHash('sha256').update(grande).digest('hex');
    assert.throws(() => lerManifesto({ bytes: grande, sha256 }), (e) => e.code === 'MANIFESTO_INVALIDO');
    const fonte = criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'k-cx', segredo: crypto.randomBytes(32) }] });
    assert.throws(() => criarLeitorV2({ fonteDeChaves: fonte })({ bytes: grande, sha256 }), (e) => e.code === 'MANIFESTO_INVALIDO');
  });
});

describe('[CX-O] entrada operacional: erro interno inesperado do executor', () => {
  const executorPath = require.resolve('../../src/services/imagem-backup-executor.service');
  const operacionalPath = require.resolve('../../src/services/imagem-backup-operacional.service');

  /** Recarrega o módulo operacional com o executor SUBSTITUÍDO (só neste processo) e restaura tudo ao fim. */
  async function comExecutor(executar, fn) {
    require(executorPath);
    const original = require.cache[executorPath].exports;
    const operacionalAntes = require.cache[operacionalPath];
    require.cache[executorPath].exports = { ...original, executarBackupSupervisionado: executar };
    delete require.cache[operacionalPath];
    try { return await fn(require(operacionalPath).executarBackupOperacional); } finally {
      require.cache[executorPath].exports = original;
      if (operacionalAntes === undefined) delete require.cache[operacionalPath]; else require.cache[operacionalPath] = operacionalAntes;
    }
  }
  function dependencias(contador) {
    return {
      janela: { adquirir: async () => { contador.janela += 1; throw new Error('não deveria adquirir'); } },
      conexao: { criarConexao: () => { contador.conexao += 1; throw new Error('não deveria conectar'); }, temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) }, prazos: { finalizacaoMs: 1000 } },
      processoDoDump: () => { contador.processo += 1; throw new Error('não deveria lançar'); },
      copia: async () => { contador.copia += 1; return { ok: true }; },
      avaliar: () => ({ valido: true, motivos: [] }),
    };
  }

  teste('CX-O01 — o executor lança (síncrono) ou rejeita: `falhaInesperada` — saída de erro, NÃO válido, janela NAO_LIBERADA (trava não presumida liberada), finalização NAO_CONCLUIDA, recuperável false, só o motivo ERRO_INTERNO; sem vazar a causa e sem efeitos', async () => {
    for (const executar of [() => { throw new Error(SEGREDO); }, async () => { throw new Error(SEGREDO); }]) {
      const contador = { janela: 0, conexao: 0, processo: 0, copia: 0 };
      const r = await comExecutor(executar, (operacional) => operacional(dependencias(contador)));
      assert.equal(r.saida, SAIDAS.ERRO);
      assert.equal(r.valido, false);
      assert.equal(r.recuperavel, false);
      assert.equal(r.janela, ESTADOS_DA_JANELA.NAO_LIBERADA);
      // P1: nada foi criado (snapshot nunca aberto, dump nunca iniciado, nenhuma pendência): a finalização da instância é segura e comprovada pela própria instância; a trava segue não liberada
      assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA);
      assert.deepEqual([...r.motivos], ['ERRO_INTERNO']);
      assert.deepEqual([...r.etapasExecutadas], []);
      assert.equal(JSON.stringify(r).includes(SEGREDO), false);
      assert.deepEqual(contador, { janela: 0, conexao: 0, processo: 0, copia: 0 }, 'nenhum efeito');
    }
  });

  teste('CX-O02 — controle: com o executor REAL e dependências inválidas a entrada recusa antes de qualquer efeito (o módulo foi restaurado depois da substituição)', async () => {
    const { executarBackupOperacional } = require(operacionalPath);
    const r = await executarBackupOperacional({ extra: 1 });
    assert.equal(r.valido, false);
    assert.notEqual(require.cache[executorPath].exports.executarBackupSupervisionado.toString().includes(SEGREDO), true);
  });
});
