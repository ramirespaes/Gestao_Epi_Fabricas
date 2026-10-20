'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const dotenv = require('dotenv');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Biblioteca de Imagens, Unidade 5C-6 — a ÚNICA porta de ativação do processador real no app. Desligada por padrão: só o valor EXATO `ativo` de
 * IMAGENS_PROCESSADOR_REAL liga; qualquer outra coisa (ausente, vazio, outra grafia, herança de protótipo) mantém o envio recusado com 503, sem criar
 * processador. A fábrica é injetável para provar que, desligada, nada é criado.
 */

const ROTULO = 'src/services/imagem-processador.ambiente';
const ARQUIVO = path.join(__dirname, '..', '..', 'src', 'services', 'imagem-processador.ambiente.js');
const EXEMPLO = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
const VARIAVEL = 'IMAGENS_PROCESSADOR_REAL';
const modulo = () => exigirModulo(ROTULO);

function fabricaContada() {
  const chamadas = [];
  const processador = Object.freeze({ processar: async () => ({}), encerrarTodos: async () => {}, ativos: () => [] });
  return { chamadas, processador, fabrica: (...argumentos) => { chamadas.push(argumentos); return processador; } };
}

/** Roda `corpo` com o módulo recém-carregado e a variável no estado pedido (`undefined` = ausente); restaura tudo no fim. */
function comAmbiente(valor, corpo) {
  const guardado = process.env[VARIAVEL];
  try {
    if (valor === undefined) delete process.env[VARIAVEL]; else process.env[VARIAVEL] = valor;
    delete require.cache[ARQUIVO];
    return corpo(modulo());
  } finally {
    if (guardado === undefined) delete process.env[VARIAVEL]; else process.env[VARIAVEL] = guardado;
    delete require.cache[ARQUIVO];
  }
}

describe('processador real de imagens — ativação pelo ambiente (Unidade 5C-6)', () => {
  test('AMB-01 — o nome da variável e o único valor que liga são fixos', () => {
    const m = modulo();
    assert.equal(m.VARIAVEL_DE_ATIVACAO, VARIAVEL);
    assert.equal(m.VALOR_DE_ATIVACAO, 'ativo');
  });

  test('AMB-02 — SEM a variável: nenhum processador (nulo) e a fábrica NÃO é chamada', () => {
    const { chamadas, fabrica } = fabricaContada();
    assert.equal(modulo().criarProcessadorDoAmbiente({ origem: {}, fabrica }), null);
    assert.equal(chamadas.length, 0);
  });

  test('AMB-03 — com o valor exato `ativo`: a fábrica é chamada uma vez, sem argumentos, e o processador dela é devolvido', () => {
    const { chamadas, processador, fabrica } = fabricaContada();
    const resultado = modulo().criarProcessadorDoAmbiente({ origem: { [VARIAVEL]: 'ativo' }, fabrica });
    assert.equal(resultado, processador);
    assert.deepEqual(chamadas, [[]]);
  });

  test('AMB-04 — qualquer outro valor mantém DESLIGADO e não chama a fábrica (a decisão é de igualdade exata, sem normalização)', () => {
    const valores = ['', ' ', 'ATIVO', 'Ativo', ' ativo', 'ativo ', 'ativo\n', 'ativa', 'ativado', 'true', 'TRUE', '1', '0', 'sim', 'on', 'yes', 'false', 'desativado', 'inativo', 'real'];
    for (const valor of valores) {
      const { chamadas, fabrica } = fabricaContada();
      assert.equal(modulo().criarProcessadorDoAmbiente({ origem: { [VARIAVEL]: valor }, fabrica }), null, JSON.stringify(valor));
      assert.equal(chamadas.length, 0, JSON.stringify(valor));
    }
  });

  test('AMB-05 — valor que não é texto (número, booleano, objeto, lista) não liga', () => {
    for (const valor of [1, true, {}, ['ativo'], null, undefined]) {
      const { chamadas, fabrica } = fabricaContada();
      assert.equal(modulo().criarProcessadorDoAmbiente({ origem: { [VARIAVEL]: valor }, fabrica }), null);
      assert.equal(chamadas.length, 0);
    }
  });

  test('AMB-06 — só vale propriedade PRÓPRIA da origem: protótipo herdado não liga', () => {
    const { chamadas, fabrica } = fabricaContada();
    const herdada = Object.create({ [VARIAVEL]: 'ativo' });
    assert.equal(modulo().criarProcessadorDoAmbiente({ origem: herdada, fabrica }), null);
    assert.equal(chamadas.length, 0);
  });

  test('AMB-07 — origem inválida (nula, texto, número) não liga e não lança', () => {
    for (const origem of [null, 'ativo', 7, true]) {
      const { chamadas, fabrica } = fabricaContada();
      assert.equal(modulo().criarProcessadorDoAmbiente({ origem, fabrica }), null);
      assert.equal(chamadas.length, 0);
    }
  });

  test('AMB-08 — a fábrica padrão é a do processador real: ligado, devolve o objeto com processar, encerrarTodos e ativos, sem nenhum filho iniciado', () => {
    const processador = modulo().criarProcessadorDoAmbiente({ origem: { [VARIAVEL]: 'ativo' } });
    assert.equal(typeof processador.processar, 'function');
    assert.equal(typeof processador.encerrarTodos, 'function');
    assert.deepEqual(processador.ativos(), []);
    assert.equal(Object.isFrozen(processador), true);
  });

  test('AMB-09 — processadorDoProcesso decide UMA vez: desligado fica desligado mesmo que o ambiente mude depois', () => {
    comAmbiente(undefined, (m) => {
      assert.equal(m.processadorDoProcesso(), null);
      process.env[VARIAVEL] = 'ativo';
      assert.equal(m.processadorDoProcesso(), null, 'mudar o ambiente depois do primeiro uso não liga');
    });
  });

  test('AMB-10 — processadorDoProcesso ligado devolve SEMPRE o mesmo processador (um só conjunto de filhos por processo)', () => {
    comAmbiente('ativo', (m) => {
      const primeiro = m.processadorDoProcesso();
      assert.notEqual(primeiro, null);
      assert.equal(m.processadorDoProcesso(), primeiro);
      assert.deepEqual(primeiro.ativos(), []);
    });
  });

  test('AMB-11 — processadorDoProcesso com valor diferente de `ativo` no ambiente real do processo fica nulo', () => {
    comAmbiente('true', (m) => assert.equal(m.processadorDoProcesso(), null));
    comAmbiente('', (m) => assert.equal(m.processadorDoProcesso(), null));
  });
});

describe('.env.example — o exemplo nunca liga o processador (Unidade 5C-6)', () => {
  test('AMB-12 — a variável existe SÓ como exemplo comentado: copiar o exemplo para .env mantém desligado', () => {
    assert.match(EXEMPLO, /^# IMAGENS_PROCESSADOR_REAL=ativo$/m);
    const analisado = dotenv.parse(EXEMPLO);
    assert.equal(Object.hasOwn(analisado, VARIAVEL), false);
    const { chamadas, fabrica } = fabricaContada();
    assert.equal(modulo().criarProcessadorDoAmbiente({ origem: analisado, fabrica }), null);
    assert.equal(chamadas.length, 0);
  });

  test('AMB-13 — descomentada, a linha documentada é exatamente o valor que liga (o exemplo não ensina um valor que não funciona)', () => {
    const descomentado = dotenv.parse(EXEMPLO.replace(/^# (IMAGENS_PROCESSADOR_REAL=ativo)$/m, '$1'));
    assert.equal(descomentado[VARIAVEL], 'ativo');
    const { chamadas, processador, fabrica } = fabricaContada();
    assert.equal(modulo().criarProcessadorDoAmbiente({ origem: descomentado, fabrica }), processador);
    assert.equal(chamadas.length, 1);
  });

  test('AMB-14 — o comentário logo acima do exemplo diz que o padrão é desligado, que só o valor exato liga e que o diretório também é necessário', () => {
    const linhas = EXEMPLO.split('\n');
    const indice = linhas.indexOf('# IMAGENS_PROCESSADOR_REAL=ativo');
    assert.ok(indice > 0, 'exemplo comentado ausente');
    const bloco = [];
    for (let i = indice - 1; i >= 0 && linhas[i].startsWith('#'); i -= 1) bloco.unshift(linhas[i]);
    const texto = bloco.join('\n');
    assert.match(texto, /DESLIGADO por padrão/);
    assert.match(texto, /`ativo`/);
    assert.match(texto, /IMAGENS_ARMAZENAMENTO_DIRETORIO/);
  });
});
