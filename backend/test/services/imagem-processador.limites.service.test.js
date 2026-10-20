'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');
const path = require('node:path');
const servico = require('../../src/services/imagem-processador.service');
const { ErroDeImagem } = require('../../src/utils/imagem-container');
const { gerarVariantes } = require('../helpers/filhos/sucesso-adulterado');
const F = require('../helpers/imagens-reais');

/**
 * Biblioteca de Imagens, Unidade 5C-4 (T-04, mutantes SV23, SV39, SV41, SV43 e SV49) — quadro, limites e tempo no lado de quem chama (src/services/imagem-processador.service.js):
 * (1) as medidas que o quadro declara têm de ser as do contrato, não só as dos arquivos; (2) os tetos valem EXATAMENTE (no teto passa, um byte acima não) e a moldura do
 * quadro cabe na folga da saída; (3) a saída de erro do filho é lida até o fim, mesmo grande; (4) a espera pela morte do filho é validada como o prazo externo; (5) matar
 * duas vezes não deixa temporizador para trás.
 */

const teste = (nome, fn) => test(nome, { timeout: 90000 }, fn);
const filho = (nome) => path.join(__dirname, '..', 'helpers', 'filhos', nome);
const dormir = (ms) => new Promise((resolver) => { setTimeout(resolver, ms); });
async function esperarAte(condicao, ms = 5000) { const limite = Date.now() + ms; while (Date.now() < limite) { if (await condicao()) return true; await dormir(10); } return false; }
const contar = (tipo) => process.getActiveResourcesInfo().filter((r) => r === tipo).length;
const internoCom = (codigo) => (erro) => {
  assert.ok(erro instanceof Error && !(erro instanceof ErroDeImagem), `esperava erro interno e veio ${erro?.name}: ${erro?.message}`);
  assert.equal(erro.codigo, codigo);
  return true;
};
const RESPOSTA = 'IMAGEM_FILHO_RESPOSTA_INVALIDA';

describe('quadro, limites e tempo do processador (T-04)', () => {
  teste('LIM-01 — as medidas que o quadro DECLARA têm de ser as do contrato (1024 x 1024): largura ou altura diferente, mesmo com as três variantes corretas, é resposta inválida', async () => {
    const entrada = await F.png(400, 320);
    const certo = servico.criarProcessadorDeImagens({ caminhoDoFilho: filho('sucesso-valido.js'), prazoExternoMs: 20000 });
    const r = await certo.processar(entrada);
    assert.deepEqual([r.largura, r.altura], [1024, 1024]);
    for (const script of ['sucesso-largura-errada.js', 'sucesso-altura-errada.js']) {
      const processador = servico.criarProcessadorDeImagens({ caminhoDoFilho: filho(script), prazoExternoMs: 20000 });
      internoCom(RESPOSTA)(await processador.processar(entrada).then(() => null, (e) => e));
      assert.deepEqual(processador.ativos(), [], script);
    }
  });

  teste('LIM-02 — tetos exatos: com cada teto igual ao tamanho da variante a resposta passa (a moldura do quadro cabe na folga da saída); um byte a menos em qualquer teto recusa', async () => {
    const entrada = await F.png(400, 320);
    const v = await gerarVariantes();
    const tamanhos = { mestre: v.mestre.length, exibicao: v.exibicao.length, miniatura: v.miniatura.length };
    const com = (teto) => servico.criarProcessadorDeImagens({
      caminhoDoFilho: filho('sucesso-valido.js'),
      prazoExternoMs: 20000,
      parametros: servico.parametrosDoProcessamento(undefined, { mestre: { bytesMax: teto.mestre }, exibicao: { bytesMax: teto.exibicao }, miniatura: { bytesMax: teto.miniatura } }),
    });
    const r = await com(tamanhos).processar(entrada);
    assert.deepEqual([r.mestre.length, r.exibicao.length, r.miniatura.length], [tamanhos.mestre, tamanhos.exibicao, tamanhos.miniatura]);
    for (const nome of ['mestre', 'exibicao', 'miniatura']) {
      const apertado = com({ ...tamanhos, [nome]: tamanhos[nome] - 1 });
      internoCom(RESPOSTA)(await apertado.processar(entrada).then(() => null, (e) => e));
    }
  });

  teste('LIM-03 — a saída de erro do filho é lida até o fim: um filho que escreve 400 KiB no stderr antes de responder (e espera cada escrita sair) ainda entrega o resultado dentro do prazo', async () => {
    const processador = servico.criarProcessadorDeImagens({ caminhoDoFilho: filho('sucesso-stderr-grande.js'), prazoExternoMs: 8000 });
    const r = await processador.processar(await F.png(400, 320));
    assert.deepEqual([r.formato, r.largura, r.altura], ['PNG', 1024, 1024]);
    assert.deepEqual(processador.ativos(), []);
  });

  teste('LIM-04 — esperaPelaMorteMs é validado como o prazo externo: zero, negativo, fracionário, texto, nulo, NaN e infinito são TypeError; 1 e um valor comum são aceitos', () => {
    for (const ruim of [0, -1, 1.5, '5000', null, NaN, Infinity]) assert.throws(() => servico.criarProcessadorDeImagens({ esperaPelaMorteMs: ruim }), TypeError, String(ruim));
    assert.doesNotThrow(() => servico.criarProcessadorDeImagens({ esperaPelaMorteMs: 1 }));
    assert.doesNotThrow(() => servico.criarProcessadorDeImagens({ esperaPelaMorteMs: 5000 }));
  });

  teste('LIM-05 — matar duas vezes o mesmo filho (dois encerrarTodos seguidos) não deixa temporizador para trás: nem o de espera pela morte nem o prazo externo, depois do fechamento do filho', async () => {
    const falso = new EventEmitter();
    falso.pid = 424242;
    falso.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    falso.stdout = new PassThrough();
    falso.stderr = new PassThrough();
    falso.kill = () => true;
    const entrada = await F.png(400, 320);
    const base = contar('Timeout');
    const processador = servico.criarProcessadorDeImagens({ spawnar: () => falso, prazoExternoMs: 60000, esperaPelaMorteMs: 2000 });
    const execucao = processador.processar(entrada).then(() => null, (e) => e);
    assert.ok(await esperarAte(() => processador.ativos().length === 1), 'o filho falso apareceu em ativos()');
    const pedidos = [processador.encerrarTodos(), processador.encerrarTodos()];
    falso.stdout.end();
    falso.stderr.end();
    falso.emit('exit', null, 'SIGKILL');
    falso.emit('close', null, 'SIGKILL');
    await Promise.all(pedidos);
    internoCom('IMAGEM_FILHO_ENCERRADO')(await execucao);
    assert.deepEqual(processador.ativos(), []);
    assert.equal(contar('Timeout'), base, 'nenhum temporizador sobra');
  });
});
