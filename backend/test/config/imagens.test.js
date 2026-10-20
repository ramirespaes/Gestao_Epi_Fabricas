'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Biblioteca de Imagens, Unidade 1 (RED): configuração e limites das imagens de produto (contratos CFG-01 a CFG-05 do doc. 14).
 * Módulo de produção previsto: src/config/imagens.js (`lerConfiguracao(origem)`, `exigirDiretorio(configuracao)`).
 * Decisões da V7 refletidas aqui: miniatura 320×320, derivada de exibição 640×640 (prevista, não gerada), mínimo de 320 px por
 * lado nos envios de clientes, PNG/JPEG/WebP estáticos. A configuração é uma função PURA da `origem` recebida (os testes nunca
 * leem nem alteram `process.env`) e nunca guarda segredo.
 */
const C = () => exigirModulo('src/config/imagens');
// A ausência do módulo (RED) deve falhar o teste PELO MOTIVO CERTO: nunca pode satisfazer, por acidente, um assert.throws.
const lanca = (funcao, validador, mensagem) => { C(); return assert.throws(funcao, validador, mensagem); };
const naoLanca = (funcao) => { C(); return assert.doesNotThrow(funcao); };
const POSIX = process.platform !== 'win32';
const DIR = POSIX ? '/var/dados/imagens-teste' : 'C:\\dados\\imagens-teste';
const MIB = 1024 * 1024;

describe('[CFG-01] valores padrão', () => {
  test('os limites aprovados e o congelamento do objeto inteiro', () => {
    const c = C().lerConfiguracao({});
    assert.equal(c.arquivoMaxBytes, 2 * MIB);
    assert.equal(c.arquivoPadraoMaxBytes, 5 * MIB);
    assert.equal(c.ladoMin, 320);
    assert.equal(c.ladoMax, 4096);
    assert.equal(c.pixelsMax, 8388608);
    assert.deepEqual({ ...c.miniatura }, { lado: 320, formato: 'webp', bytesMax: 65536 });
    assert.deepEqual({ ...c.exibicao }, { lado: 640, formato: 'webp' });
    assert.equal(c.ampliar, false);
    assert.equal(c.cotaImagens, 300);
    assert.equal(c.cotaBytes, 300 * MIB);
    assert.equal(c.envioPorMinutoUsuario, 10);
    assert.equal(c.envioPorHoraEmpresa, 60);
    assert.equal(c.loteMaximo, 10);
    assert.equal(c.processamentosSimultaneos, 2);
    assert.deepEqual({ ...c.nome }, { min: 1, max: 100 });
    assert.deepEqual([...c.formatosAceitos], ['PNG', 'JPEG', 'WEBP']);
    assert.equal(c.diretorio, null);
    for (const objeto of [c, c.miniatura, c.exibicao, c.nome, c.formatosAceitos]) assert.equal(Object.isFrozen(objeto), true);
  });

  test('é função pura da origem: dois resultados são independentes e a origem não é alterada', () => {
    const origem = Object.freeze({ IMAGENS_COTA_IMAGENS: '50' });
    const a = C().lerConfiguracao(origem);
    const b = C().lerConfiguracao({});
    assert.equal(a.cotaImagens, 50);
    assert.equal(b.cotaImagens, 300);
    assert.deepEqual(origem, { IMAGENS_COTA_IMAGENS: '50' });
  });
});

describe('[CFG-02] ajuste por ambiente: só cotas, taxas e semáforo, dentro de piso e teto', () => {
  const AJUSTAVEIS = [
    ['IMAGENS_COTA_IMAGENS', 'cotaImagens', 10, 5000, (n) => n],
    ['IMAGENS_COTA_MIB', 'cotaBytes', 10, 10240, (n) => n * MIB],
    ['IMAGENS_ENVIOS_POR_MINUTO_USUARIO', 'envioPorMinutoUsuario', 1, 60, (n) => n],
    // Piso 10 = o padrão da taxa por minuto do usuário: a taxa por hora nunca fica abaixo dela (ver o teste de coerência abaixo).
    ['IMAGENS_ENVIOS_POR_HORA_EMPRESA', 'envioPorHoraEmpresa', 10, 1000, (n) => n],
    ['IMAGENS_PROCESSAMENTOS_SIMULTANEOS', 'processamentosSimultaneos', 1, 8, (n) => n],
  ];

  for (const [variavel, campo, piso, teto, converter] of AJUSTAVEIS) {
    test(`${variavel}: aceita o piso (${piso}), o teto (${teto}) e um valor intermediário, com espaços ao redor`, () => {
      const meio = Math.floor((piso + teto) / 2);
      for (const valor of [piso, teto, meio]) {
        const c = C().lerConfiguracao({ [variavel]: ` ${valor} ` });
        assert.equal(c[campo], converter(valor), `${variavel}=${valor}`);
      }
    });

    test(`${variavel}: ausente ou em branco usa o padrão; valor fora do intervalo ou mal formado é recusado`, () => {
      const padrao = C().lerConfiguracao({})[campo];
      for (const vazio of [undefined, '', '   ']) assert.equal(C().lerConfiguracao({ [variavel]: vazio })[campo], padrao);
      const invalidos = [String(piso - 1), String(teto + 1), '-1', '0', '1.5', '1e2', '0x10', 'abc', '10abc', '١٢', '１０', '+5', '5 6'];
      for (const invalido of invalidos) {
        if (Number(invalido) >= piso && Number(invalido) <= teto && /^[0-9]+$/.test(invalido)) continue;
        lanca(() => C().lerConfiguracao({ [variavel]: invalido }), (falha) => {
          assert.ok(falha.message.includes(variavel), `a mensagem nomeia a variável (${invalido})`);
          return true;
        }, `${variavel}=${JSON.stringify(invalido)}`);
      }
    });
  }

  test('a taxa por hora da empresa não pode ser menor que a taxa por minuto do usuário', () => {
    lanca(
      () => C().lerConfiguracao({ IMAGENS_ENVIOS_POR_MINUTO_USUARIO: '60', IMAGENS_ENVIOS_POR_HORA_EMPRESA: '30' }),
      (falha) => /IMAGENS_ENVIOS_POR_MINUTO_USUARIO/.test(falha.message) && /IMAGENS_ENVIOS_POR_HORA_EMPRESA/.test(falha.message),
    );
    naoLanca(() => C().lerConfiguracao({ IMAGENS_ENVIOS_POR_MINUTO_USUARIO: '30', IMAGENS_ENVIOS_POR_HORA_EMPRESA: '30' }));
  });

  test('os limites de arquivo, lado, pixels e derivadas NÃO são ajustáveis: variáveis desse tipo são ignoradas', () => {
    const base = C().lerConfiguracao({});
    const c = C().lerConfiguracao({
      IMAGENS_ARQUIVO_MAX_BYTES: '999999999', IMAGENS_ARQUIVO_PADRAO_MAX_BYTES: '1', IMAGENS_LADO_MIN: '1', IMAGENS_LADO_MAX: '99999',
      IMAGENS_PIXELS_MAX: '999999999', IMAGENS_MINIATURA_LADO: '64', IMAGENS_EXIBICAO_LADO: '9999', IMAGENS_AMPLIAR: 'true',
    });
    const FIXOS = { arquivoMaxBytes: 2 * MIB, arquivoPadraoMaxBytes: 5 * MIB, ladoMin: 320, ladoMax: 4096, pixelsMax: 8388608, ampliar: false };
    for (const [campo, valor] of Object.entries(FIXOS)) {
      assert.equal(base[campo], valor, `${campo}: valor fixo definido (um teste vazio não pode passar)`);
      assert.equal(c[campo], valor, `${campo}: variável de ambiente ignorada`);
    }
    assert.equal(base.miniatura.lado, 320);
    assert.equal(base.exibicao.lado, 640);
    assert.deepEqual({ ...c.miniatura }, { ...base.miniatura });
    assert.deepEqual({ ...c.exibicao }, { ...base.exibicao });
  });
});

describe('[CFG-03] diretório de armazenamento', () => {
  test('ausente ou em branco: o recurso fica INDISPONÍVEL (diretório nulo) e exigirDiretorio lança IMAGENS_INDISPONIVEL', () => {
    for (const origem of [{}, { IMAGENS_ARMAZENAMENTO_DIRETORIO: '' }, { IMAGENS_ARMAZENAMENTO_DIRETORIO: '   ' }]) {
      const c = C().lerConfiguracao(origem);
      assert.equal(c.diretorio, null);
      lanca(() => C().exigirDiretorio(c), (falha) => falha.codigo === 'IMAGENS_INDISPONIVEL');
    }
  });

  test('absoluto e canônico é aceito e devolvido por exigirDiretorio; barra final é normalizada', () => {
    const c = C().lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: DIR });
    assert.equal(c.diretorio, DIR);
    assert.equal(C().exigirDiretorio(c), DIR);
    if (POSIX) assert.equal(C().lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: `${DIR}/` }).diretorio, DIR);
  });

  test('relativo, não canônico, com NUL ou a raiz do sistema é recusado (IMAGENS_DIRETORIO_INVALIDO)', { skip: !POSIX && 'caminhos POSIX' }, () => {
    const invalidos = ['relativo/x', './x', '../x', 'x', `${DIR}/../x`, `${DIR}//x`, `${DIR}/./x`, `${DIR}\0x`, '/', '//', '/.'];
    for (const invalido of invalidos) {
      lanca(() => C().lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: invalido }), (falha) => {
        assert.equal(falha.codigo, 'IMAGENS_DIRETORIO_INVALIDO', JSON.stringify(invalido));
        assert.ok(falha.message.includes('IMAGENS_ARMAZENAMENTO_DIRETORIO'));
        return true;
      });
    }
  });

  test('exigirDiretorio recusa uma configuração que não é a produzida por lerConfiguracao', () => {
    for (const estranha of [undefined, null, {}, { diretorio: 'relativo' }, { diretorio: 123 }]) {
      lanca(() => C().exigirDiretorio(estranha), (falha) => falha.codigo === 'IMAGENS_INDISPONIVEL' || falha instanceof TypeError);
    }
  });
});

describe('[CFG-04] mensagens de erro nunca levam o valor recebido', () => {
  const MARCA = 'SEGREDO-VALOR-9137';

  test('valor numérico inválido', () => {
    for (const variavel of ['IMAGENS_COTA_IMAGENS', 'IMAGENS_COTA_MIB', 'IMAGENS_ENVIOS_POR_MINUTO_USUARIO', 'IMAGENS_ENVIOS_POR_HORA_EMPRESA', 'IMAGENS_PROCESSAMENTOS_SIMULTANEOS']) {
      lanca(() => C().lerConfiguracao({ [variavel]: `x${MARCA}` }), (falha) => {
        assert.ok(!falha.message.includes(MARCA), `${variavel}: a mensagem vazou o valor`);
        assert.ok(!String(falha.stack).includes(MARCA), `${variavel}: o stack vazou o valor`);
        return true;
      });
    }
  });

  test('diretório inválido', { skip: !POSIX && 'caminhos POSIX' }, () => {
    lanca(() => C().lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: `relativo/${MARCA}` }), (falha) => {
      assert.ok(!falha.message.includes(MARCA));
      assert.ok(!String(falha.stack).includes(MARCA));
      return true;
    });
  });
});

describe('[CFG-05] coerência entre os limites', () => {
  test('miniatura 320 e exibição 640 em WebP, sem ampliar; mínimo de envio ≥ lado da miniatura; ordem dos tetos', () => {
    const c = C().lerConfiguracao({});
    assert.equal(c.miniatura.lado, 320);
    assert.equal(c.exibicao.lado, 640);
    assert.equal(c.miniatura.formato, 'webp');
    assert.equal(c.exibicao.formato, 'webp');
    assert.equal(c.ampliar, false);
    assert.ok(c.ladoMin >= c.miniatura.lado, 'a derivada nunca precisa ser ampliada');
    assert.ok(c.miniatura.lado < c.exibicao.lado && c.exibicao.lado <= c.ladoMax);
    assert.ok(c.ladoMin * c.ladoMin <= c.pixelsMax && c.ladoMax * c.ladoMax > c.pixelsMax, 'o teto de pixels é o limite efetivo das imagens grandes');
    assert.ok(c.arquivoMaxBytes <= c.arquivoPadraoMaxBytes && c.arquivoPadraoMaxBytes <= c.cotaBytes);
    assert.ok(c.envioPorHoraEmpresa >= c.envioPorMinutoUsuario);
    assert.ok(c.loteMaximo >= 1 && c.processamentosSimultaneos >= 1);
  });

  test('os valores padrão sempre respeitam os próprios intervalos de ajuste (a configuração padrão é válida em qualquer ambiente)', () => {
    naoLanca(() => C().lerConfiguracao({}));
    const c = C().lerConfiguracao({});
    assert.ok(c.cotaImagens >= 10 && c.cotaImagens <= 5000);
    assert.ok(c.envioPorMinutoUsuario >= 1 && c.envioPorMinutoUsuario <= 60);
    assert.ok(c.envioPorHoraEmpresa >= 10 && c.envioPorHoraEmpresa <= 1000);
    assert.ok(c.processamentosSimultaneos >= 1 && c.processamentosSimultaneos <= 8);
  });
});
