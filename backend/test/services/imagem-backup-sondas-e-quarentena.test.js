'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { criarBackupDeProducao, criarRestauracaoDeProducao, classificarEstadoDoBackup } = require('../../src/services/imagem-backup-composicao-producao.service');
const { criarRestaurador } = require('../../src/services/imagem-backup-restauracao.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');
const { ambiente, spawnFalso, novaRaiz, clienteFalso, linhas, PRAZOS, POLITICA } = require('../helpers/ambiente-backup-operacao');

/**
 * Verificações finais de fechamento local: (A) CARACTERIZAÇÃO do cenário de publicação INCERTA depois que o fluxo normal libera a trava — o que está e o que NÃO está garantido de forma durável; (B) as sondas de instância (antes/depois), que não passam pelo registro de operações.
 * Os testes de (A) documentam um LIMITE CONHECIDO (como os "LIMITE conhecido" de Marco D): quando existir quarentena persistente, estas asserções devem ser revistas de propósito, nunca silenciadas. Só dependências controladas; nenhuma conexão real.
 */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-sq-test-' });
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
    quantos: () => ativos.size,
  };
}

const pubPath = require.resolve('../../src/services/imagem-backup-publicacao.service');
const encPath = require.resolve('../../src/services/imagem-backup-encadeamento-confiavel-integrado.service');
const prodPath = require.resolve('../../src/services/imagem-backup-composicao-producao.service');
async function comPublicador(fabrica, fn) {
  require(pubPath);
  const original = require.cache[pubPath].exports;
  const salvos = { enc: require.cache[encPath], prod: require.cache[prodPath] };
  const marcados = new WeakSet();
  require.cache[pubPath].exports = { ...original, criarPublicador: (o) => { const f = fabrica(original, o); marcados.add(f); return f; }, ehPublicador: (v) => marcados.has(v) || original.ehPublicador(v) };
  delete require.cache[encPath];
  delete require.cache[prodPath];
  try { return await fn(require(prodPath)); } finally {
    require.cache[pubPath].exports = original;
    if (salvos.enc === undefined) delete require.cache[encPath]; else require.cache[encPath] = salvos.enc;
    if (salvos.prod === undefined) delete require.cache[prodPath]; else require.cache[prodPath] = salvos.prod;
  }
}
const fsyncReal = async (p) => { const h = await fsp.open(p, fs.constants.O_RDONLY); try { await h.sync(); } finally { await h.close(); } };

describe('[QUAR] publicação INCERTA sem cancelamento: liberação da trava e (falta de) garantia durável', () => {
  teste('QUAR-1 — (INVERTIDO pela quarentena durável) a trava é liberada só depois de tudo assentar (nenhuma operação pendente) e com a regra do supervisor; e o pacote INCERTO deixa marca DURÁVEL de quarentena — um leitor independente (restaurador novo, sem estado do processo) o recusa; a inelegibilidade a "backup válido" vem do estado volátil E do registro em disco', async () => {
    const fabrica = (original, opcoes) => {
      let renames = 0;
      return original.criarPublicador({ ...opcoes, ops: { rename: async (de, para) => { renames += 1; if (renames === 1) return fsp.rename(de, para); throw erroCom('EIO'); }, fsyncDiretorio: async (p) => { if (p === opcoes.raizDoDestino) throw erroCom('EIO'); return fsyncReal(p); } } });
    };
    await comPublicador(fabrica, async (producao) => {
      const relogio = relogioManual();
      const a = await ambiente({ portasExtras: { temporizador: relogio }, alterarConfig: (c) => { c.operacoes = { etapaMs: 7401, cortesiaMs: 7402 }; return c; } });
      const composto = await producao.criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: 'prep-1', conjuntoId: 'conjunto-sq-0001' });
      // condição de liberação do responsável: nada pendente + supervisão autoriza => trava liberada
      assert.deepEqual([composto.resultado.publicacao.estado, composto.resultado.publicacao.publicada], ['INCERTA', false]);
      assert.deepEqual([composto.resultado.coordenador.janela, composto.proveniencia.operacoes.pendentes], ['LIBERADA', 0]);
      assert.equal(fs.existsSync(path.join(a.raiz, 'janela.lock')), false);
      // elegibilidade volátil: o resultado reconhecido em memória nega a validade...
      const e = producao.classificarEstadoDoBackup(composto);
      assert.deepEqual([e.backupOperacionalValido, e.quarentena.recomendada], [false, true]);
      // ...e EXISTE marca durável: o registro (fora do pacote) contém a quarentena; o pacote em si segue com o mesmo conjunto de arquivos
      assert.deepEqual(fs.readdirSync(a.dirs.publicados), ['prep-1']);
      assert.ok(fs.readdirSync(path.join(path.dirname(a.dirs.publicados), '.registro-publicacao-publicados')).includes('prep-1.quarentena.json'));
      assert.deepEqual(fs.readdirSync(path.join(a.dirs.publicados, 'prep-1')).sort(), ['dump', 'imagens', 'manifesto.json', 'manifesto.sha256']);
      assert.deepEqual(fs.readdirSync(a.raiz).filter((n) => /quarent/i.test(n)), []);
      // leitor independente (após "reinicialização": nenhum objeto, marca ou closure do processo anterior): RECUSA o pacote
      const independente = await criarRestaurador({ fonteDeChaves: a.fonteDeChaves }).restaurarPacote({ raizAutorizada: a.dirs.publicados, nome: 'prep-1', imagens: { raiz: novaRaiz(), nome: 'img' } });
      assert.deepEqual([independente.ok, independente.motivo], [false, 'PACOTE_EM_QUARENTENA']);
      // e uma classificação feita sem o resultado reconhecido (como após reiniciar) nunca declara validade
      const aposReinicio = producao.classificarEstadoDoBackup(JSON.parse(JSON.stringify({ resultado: composto.resultado, prontidao: composto.prontidao, proveniencia: {} })));
      assert.deepEqual([aposReinicio.reconhecido, aposReinicio.backupOperacionalValido], [false, false]);
    });
  });
});

describe('[SONDA] sondas de instância antes/depois da restauração: seguras, mas sem prazo', () => {
  const DESTINO = Object.freeze({ banco: 'gepi_cp_restaurado', host: '127.0.0.1', porta: 5432, usuario: 'gepi_cp', arquivoDeSenha: '/tmp/senha-ficticia' });
  const IMG = 7411;
  const CONSULTA = 7412;
  const CORTESIA = 7413;
  async function pacote() {
    const a = await ambiente();
    const c = await criarBackupDeProducao(a.config).executar({ nomeDaPreparacao: 'prep-1', conjuntoId: 'conjunto-sq-0002' });
    assert.equal(c.resultado.publicacao.publicada, true);
    return a;
  }
  /** Retém a N-ésima conexão (1 = sonda antes, 2 = consulta, 3 = sonda depois); conta end() e guarda o que foi enviado. */
  function montar(a, { reter, operacoes, spawn = spawnFalso().spawn }) {
    const relogio = relogioManual();
    const portao = adiado();
    const clientes = [];
    const fins = [];
    const r = criarRestauracaoDeProducao({
      postgres: { pgRestore: a.config.postgres.pgRestore },
      politicaDeDestino: { ...POLITICA },
      fonteDeChaves: a.fonteDeChaves,
      criarConexaoDoBanco: (banco) => {
        const c = clienteFalso(banco, linhas());
        const n = clientes.push(c);
        const fim = { n, chamadas: 0 };
        fins.push(fim);
        const original = c.end;
        c.end = async () => { fim.chamadas += 1; return original.call(c); };
        if (n === reter) c.connect = () => portao.promessa;
        return c;
      },
      prazos: { ...PRAZOS },
      portas: { spawn, observarGrupo: async () => false, temporizador: relogio },
      ...(operacoes === undefined ? {} : { operacoes }),
    });
    return { r, relogio, portao, clientes, fins };
  }
  const pedido = (a, imagens) => ({ raizAutorizada: a.dirs.publicados, nome: 'prep-1', imagens: { raiz: imagens, nome: 'img' }, destino: DESTINO });

  teste('SONDA-1 — sonda ANTES retida: nada começa (nenhum pg_restore, nenhuma imagem restaurada), o prazo/cancelamento do registro NÃO a alcança (nenhum prazo é sequer registrado), nenhuma prova é emitida; liberada, o fluxo conclui normalmente e a conexão é encerrada COM EVIDÊNCIA (ROLLBACK + end())', async () => {
    const a = await pacote();
    const falso = spawnFalso();
    const imagens = novaRaiz();
    const m = montar(a, { reter: 1, operacoes: { imagensMs: IMG, consultaMs: CONSULTA, cortesiaMs: CORTESIA }, spawn: falso.spawn });
    let retornou = false;
    const rodando = m.r.restaurar(pedido(a, imagens)).then((x) => { retornou = true; return x; });
    await ate(() => m.clientes.length === 1, 'sonda antes iniciada');
    await andar(30);
    assert.equal(retornou, false);
    assert.deepEqual(falso.chamadas, [], 'o pg_restore ainda não foi lançado');
    assert.deepEqual(fs.readdirSync(imagens), [], 'nenhuma imagem restaurada');
    assert.deepEqual([m.relogio.registrado(IMG), m.relogio.registrado(CONSULTA), m.relogio.quantos()], [false, false, 0], 'nenhum prazo do registro alcança a sonda');
    assert.deepEqual([m.fins[0].chamadas, m.clientes[0].sqls.length], [0, 0], 'a conexão pendente não foi dada como encerrada');
    m.portao.resolver();
    const out = await rodando;
    assert.equal(out.restauracao.ok, true);
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_restore']);
    assert.deepEqual([m.fins[0].chamadas, m.clientes[0].sqls.includes('ROLLBACK')], [1, true]);
    assert.deepEqual({ ...out.estado }, { restauracaoReal: false, consistenciaLogicaVerificada: false, recuperavelEmProducao: false, publicacaoOperacional: false });
  });

  teste('SONDA-2 — sonda DEPOIS retida: pg_restore e imagens já concluídos e PRESERVADOS, mas a restauração só devolve resultado depois da sonda (nenhuma prova antes); nada acontece depois que ela termina além do seu próprio encerramento com evidência; o registro não tem pendência', async () => {
    const a = await pacote();
    const falso = spawnFalso();
    const imagens = novaRaiz();
    const m = montar(a, { reter: 3, operacoes: { imagensMs: IMG, consultaMs: CONSULTA, cortesiaMs: CORTESIA }, spawn: falso.spawn });
    let retornou = false;
    const rodando = m.r.restaurar(pedido(a, imagens)).then((x) => { retornou = true; return x; });
    await ate(() => m.clientes.length === 3, 'sonda depois iniciada');
    await andar(30);
    assert.equal(retornou, false, 'nenhum resultado (nem prova) enquanto a sonda não assenta');
    assert.deepEqual(falso.chamadas.map((c) => c.nome), ['pg_restore']);
    assert.ok(fs.readdirSync(imagens, { recursive: true }).length > 0, 'imagens restauradas preservadas');
    assert.equal(m.relogio.quantos(), 0, 'nenhum prazo ficou armado');
    m.portao.resolver();
    const out = await rodando;
    assert.equal(out.restauracao.ok, true);
    assert.equal(out.proveniencia.operacoes.pendentes, 0);
    const antesDeEsperar = m.clientes.map((c) => c.sqls.length);
    await andar(30);
    assert.deepEqual(m.clientes.map((c) => c.sqls.length), antesDeEsperar, 'nenhum efeito tardio depois do retorno');
    assert.deepEqual(m.fins.map((f) => f.chamadas), [1, 1, 1], 'todas as conexões encerradas com evidência');
  });

  teste('SONDA-3 — as sondas só enviam SQL de LEITURA permitido e em transação READ ONLY (BEGIN ... READ ONLY, SELECT, ROLLBACK): não há escrita possível que pudesse produzir efeito tardio', async () => {
    const { sqlPermitido } = require('../../src/services/imagem-backup-consistencia-banco.service');
    for (const bom of ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK', 'SELECT 1']) assert.equal(sqlPermitido(bom), true, bom);
    for (const mau of ['INSERT INTO x VALUES (1)', 'UPDATE x SET a=1', 'DELETE FROM x', 'DROP TABLE x', 'COMMIT', 'BEGIN', 'CREATE TABLE x(a int)', 'SELECT 1; DROP TABLE x']) assert.equal(sqlPermitido(mau), false, mau);
  });
});
