'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarRegistroDeExecucoes, REGISTRO_DE_EXECUCOES, POLITICA_PADRAO } = require('../../src/services/imagem-backup-execucoes.service');
const { criarRestauracaoDeProducao } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarFonteDeChaves } = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { emitirExecucaoDeRestauracao } = require('../../src/services/imagem-backup-proveniencia-restauracao.service');

/**
 * CICLO DE VIDA DAS IDENTIDADES DE EXECUÇÃO: registro limitado, política explícita, relógio falso, falha fechada com o registro cheio. Nenhum processo, banco ou diretório operacional. O último teste ENCHE o registro de produção deste processo (cada arquivo de teste roda em processo próprio),
 * por isso ele é o ÚLTIMO deste arquivo.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const relogioFalso = () => { let t = 1000; return { agora: () => t, avancar: (ms) => { t += ms; } }; };
const registro = (extra = {}) => { const c = relogioFalso(); return { c, R: criarRegistroDeExecucoes({ capacidade: 5, ttlAtivaMs: 1000, retencaoTerminalMs: 5000, relogio: c.agora, ...extra }) }; };
const avaliacao = (extra = {}) => Object.freeze({ reconhecida: true, ...extra });
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const r of raizes) if (path.dirname(r) === tmp && path.basename(r).startsWith('gepi-exe-test-')) fs.rmSync(r, { recursive: true, force: true });
});

describe('[EXE] registro de identidades de execução', () => {
  teste('EXE-01 — identidade única por execução (128 bits), emitida só pelo registro; ids inválidos ou desconhecidos são desconhecidos', () => {
    const { R } = registro({ capacidade: 5000 });
    const ids = new Set();
    for (let i = 0; i < 2000; i += 1) { const { id } = R.emitir(); assert.match(id, /^[0-9a-f]{32}$/); ids.add(id); }
    assert.equal(ids.size, 2000);
    assert.equal(Object.isFrozen(R.emitir()), true);
    for (const ruim of [undefined, null, '', 'zz', 'A'.repeat(32), 'a'.repeat(31), 42, {}, '0'.repeat(32)]) assert.equal(R.estado(ruim), null, String(ruim));
    assert.equal(R.concluir('0'.repeat(32), avaliacao()), false);
    assert.equal(R.resultado('0'.repeat(32)), null);
  });

  teste('EXE-02 — política explícita e validada; o padrão é limitado; relógio padrão monotônico', () => {
    for (const ruim of [{ capacidade: 0 }, { capacidade: 1.5 }, { ttlAtivaMs: -1 }, { retencaoTerminalMs: 'x' }, { relogio: 5 }, { extra: 1 }, null, 'x']) assert.throws(() => criarRegistroDeExecucoes(ruim), TypeError, JSON.stringify(ruim));
    assert.deepEqual({ ...criarRegistroDeExecucoes().politica }, { ...POLITICA_PADRAO });
    assert.ok(POLITICA_PADRAO.capacidade > 0 && Object.isFrozen(POLITICA_PADRAO));
    assert.ok(Object.isFrozen(REGISTRO_DE_EXECUCOES));
    const { id } = REGISTRO_DE_EXECUCOES.emitir();
    assert.equal(REGISTRO_DE_EXECUCOES.estado(id), 'ATIVA');
  });

  teste('EXE-03 — conclusão ÚNICA: só ATIVA conclui, com avaliação imutável; reconclusão, avaliação mutável e identidade desconhecida são recusadas e nada muda', () => {
    const { R } = registro();
    const { id } = R.emitir();
    assert.equal(R.resultado(id), null, 'ainda não concluída');
    assert.equal(R.concluir(id, { reconhecida: true }), false, 'avaliação mutável recusada');
    assert.equal(R.estado(id), 'ATIVA');
    const primeira = avaliacao({ n: 1 });
    assert.equal(R.concluir(id, primeira), true);
    assert.equal(R.concluir(id, avaliacao({ n: 2 })), false);
    assert.equal(R.resultado(id), primeira);
    assert.equal(R.estado(id), 'CONCLUIDA');
  });

  teste('EXE-04 — EXPIRAÇÃO: ATIVA vencida vira EXPIRADA (não pode mais ser concluída) e continua registrada até a retenção; só então é removida e passa a DESCONHECIDA, nunca a "nova"', () => {
    const { c, R } = registro();
    const { id } = R.emitir();
    c.avancar(999);
    assert.equal(R.estado(id), 'ATIVA');
    c.avancar(1);
    assert.equal(R.estado(id), 'EXPIRADA');
    assert.equal(R.concluir(id, avaliacao()), false);
    assert.equal(R.tamanho(), 1, 'expirar não remove');
    c.avancar(4999);
    assert.deepEqual({ ...R.manter() }, { expiradas: 0, removidas: 0, ativas: 0, total: 1 });
    c.avancar(1);
    assert.equal(R.manter().removidas, 1);
    assert.equal(R.estado(id), null);
    assert.equal(R.concluir(id, avaliacao()), false, 'a identidade removida não pode ser concluída nem reativada');
    const novas = new Set(Array.from({ length: 4 }, () => R.emitir().id));
    assert.equal(novas.has(id), false);
  });

  teste('EXE-05 — REGISTRO CHEIO: falha fechada na emissão, sem despejar execuções ATIVAS; terminais dentro da retenção também não saem; ao vencer a retenção a emissão volta', () => {
    const { c, R } = registro({ ttlAtivaMs: 100000 });
    const ativas = Array.from({ length: 5 }, () => R.emitir().id);
    assert.throws(() => R.emitir(), (e) => e.code === 'REGISTRO_DE_EXECUCOES_CHEIO');
    for (const id of ativas) assert.equal(R.estado(id), 'ATIVA');
    assert.equal(R.concluir(ativas[0], avaliacao()), true);
    assert.throws(() => R.emitir(), (e) => e.code === 'REGISTRO_DE_EXECUCOES_CHEIO', 'terminal ainda dentro da retenção');
    c.avancar(5000);
    const nova = R.emitir();
    assert.equal(R.estado(nova.id), 'ATIVA');
    assert.equal(R.estado(ativas[0]), null, 'a terminal vencida saiu');
    for (const id of ativas.slice(1)) assert.equal(R.estado(id), 'ATIVA', 'nenhuma ATIVA foi removida');
  });

  teste('EXE-06 — EXECUÇÃO ATIVA DURANTE A MANUTENÇÃO: manter() repetido, com terminais antigas saindo, não toca a ATIVA no prazo, que continua concluível; ao passar do prazo ela só EXPIRA (não é removida de imediato)', () => {
    const { c, R } = registro({ ttlAtivaMs: 3000, retencaoTerminalMs: 1000 });
    const viva = R.emitir().id;
    const velha = R.emitir().id;
    assert.equal(R.concluir(velha, avaliacao()), true);
    c.avancar(1000);
    assert.deepEqual({ ...R.manter() }, { expiradas: 0, removidas: 1, ativas: 1, total: 1 });
    c.avancar(1000);
    R.manter();
    R.manter();
    assert.equal(R.estado(viva), 'ATIVA');
    assert.equal(R.concluir(viva, avaliacao({ ok: 1 })), true);
    const outra = R.emitir().id;
    c.avancar(3000);
    const m = R.manter();
    assert.equal(m.expiradas, 1);
    assert.equal(R.estado(outra), 'EXPIRADA');
    assert.equal(R.tamanho() >= 1, true, 'a expirada continua registrada');
  });

  teste('EXE-07 — o registro não conhece processo, arquivo nem janela: expirar ou remover uma identidade não libera nem sinaliza nada (só `node:crypto`)', () => {
    const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'imagem-backup-execucoes.service.js'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('*')).join('\n');
    const requires = [...codigo.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual(requires, ['node:crypto']);
    assert.equal(/process\.kill|unlink|rmSync|liberar|janela|spawn/i.test(codigo), false);
  });

  teste('EXE-08 — REGISTRO DE PRODUÇÃO CHEIO: a composição falha FECHADA antes de lançar qualquer processo, sem despejar execuções em andamento; as ATIVAS seguem válidas', async () => {
    const tmp = fs.realpathSync(os.tmpdir());
    const raiz = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'gepi-exe-test-')));
    raizes.push(raiz);
    const pgRestore = path.join(raiz, 'pg_restore');
    fs.writeFileSync(pgRestore, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const lancamentos = [];
    const r = criarRestauracaoDeProducao({
      postgres: { pgRestore },
      politicaDeDestino: { prefixoDoBanco: 'gepi_exe_', hostsAutorizados: ['127.0.0.1'], bancosProtegidos: [] },
      fonteDeChaves: criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'k-1', segredo: Buffer.alloc(32, 7) }] }),
      criarConexaoDoBanco: () => { lancamentos.push('conexao'); throw new Error('não deveria conectar'); },
      prazos: { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 },
      portas: { spawn: () => { lancamentos.push('spawn'); throw new Error('não deveria lançar'); }, observarGrupo: async () => false },
    });
    const emitidas = [];
    for (;;) {
      try { emitidas.push(emitirExecucaoDeRestauracao().id); } catch (e) { assert.equal(e.code, 'REGISTRO_DE_EXECUCOES_CHEIO'); break; }
      if (emitidas.length > POLITICA_PADRAO.capacidade + 10) assert.fail('o registro não é limitado');
    }
    assert.ok(emitidas.length >= POLITICA_PADRAO.capacidade - 10);
    await assert.rejects(() => r.restaurar({ raizAutorizada: raiz, nome: 'prep-1', imagens: { raiz, nome: 'img' }, destino: { banco: 'gepi_exe_destino', host: '127.0.0.1', porta: 5432, usuario: 'u', arquivoDeSenha: '/tmp/s' } }), (e) => e.code === 'REGISTRO_DE_EXECUCOES_CHEIO');
    assert.deepEqual(lancamentos, [], 'nenhuma conexão e nenhum processo antes da identidade');
    for (const id of emitidas.slice(0, 20)) assert.equal(REGISTRO_DE_EXECUCOES.estado(id), 'ATIVA', 'nenhuma execução em andamento foi despejada');
  });
});
