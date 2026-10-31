'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const f = require('../../src/schemas/funcionario.schema');

/**
 * Datas efetivas da situação do funcionário (RED, especificação 02, decisões D1 a D6): schema de entrada.
 *
 *   INATIVO  → { situacao, dataEfetiva } (data do desligamento, obrigatória)
 *   AFASTADO → { situacao, dataEfetiva } (data do afastamento, obrigatória)
 *   ATIVO    → { situacao } ou { situacao, dataEfetiva }: a opcionalidade existe só no schema; o serviço decide pelo estado
 *              travado (AFASTADO → ATIVO exige a data do retorno; INATIVO → ATIVO recusa a data).
 *
 * Nenhum motivo, descrição, observação, INSS, CID, diagnóstico, previsão de retorno nem confirmação de conflito.
 * Rotas legadas: inativar exige { dataEfetiva }; reativar aceita {} ou { dataEfetiva }.
 */

const DATA = '2026-10-01';
const corpos = {
  INATIVO: (extra = {}) => ({ situacao: 'INATIVO', dataEfetiva: DATA, ...extra }),
  AFASTADO: (extra = {}) => ({ situacao: 'AFASTADO', dataEfetiva: DATA, ...extra }),
  ATIVO: (extra = {}) => ({ situacao: 'ATIVO', ...extra }),
};
const apontaParaData = (r) => r.error.issues.some((i) => i.path.includes('dataEfetiva'));

describe('situação — dataEfetiva obrigatória em INATIVO e AFASTADO', () => {
  for (const destino of ['INATIVO', 'AFASTADO']) {
    test(`${destino}: com data válida passa e a data segue como texto AAAA-MM-DD`, () => {
      const r = f.situacao.body.safeParse(corpos[destino]());
      assert.equal(r.success, true, JSON.stringify(r.error?.issues));
      assert.equal(r.data.dataEfetiva, DATA);
    });

    test(`${destino}: sem dataEfetiva (ausente, null ou vazia) é recusado apontando para o campo`, () => {
      for (const corpo of [{ situacao: destino }, { situacao: destino, dataEfetiva: null }, { situacao: destino, dataEfetiva: '' }]) {
        const r = f.situacao.body.safeParse(corpo);
        assert.equal(r.success, false, JSON.stringify(corpo));
        assert.equal(apontaParaData(r), true, JSON.stringify(corpo));
      }
    });
  }
});

describe('situação — ATIVO', () => {
  test('aceita só { situacao } e também { situacao, dataEfetiva } (o serviço decide pelo estado)', () => {
    assert.equal(f.situacao.body.safeParse(corpos.ATIVO()).success, true);
    const comData = f.situacao.body.safeParse(corpos.ATIVO({ dataEfetiva: DATA }));
    assert.equal(comData.success, true, JSON.stringify(comData.error?.issues));
    assert.equal(comData.data.dataEfetiva, DATA);
  });

  test('data inválida em ATIVO também é recusada (e a válida é aceita, para o teste não passar por chave desconhecida)', () => {
    assert.equal(f.situacao.body.safeParse(corpos.ATIVO({ dataEfetiva: DATA })).success, true);
    assert.equal(f.situacao.body.safeParse(corpos.ATIVO({ dataEfetiva: '2026-02-30' })).success, false);
  });
});

describe('situação — formato e calendário da data', () => {
  const INVALIDAS = ['2026-02-30', '2026-13-01', '2023-02-29', '0000-01-01', '26-01-01', '01/10/2026', '2026-1-1', ' 2026-10-01', '2026-10-01 ', '2026-10-01T00:00:00Z', 'ontem', 20261001, true, {}, []];

  for (const destino of ['INATIVO', 'AFASTADO']) {
    test(`${destino}: datas fora do contrato são recusadas`, () => {
      for (const valor of INVALIDAS) {
        const r = f.situacao.body.safeParse(corpos[destino]({ dataEfetiva: valor }));
        assert.equal(r.success, false, JSON.stringify(valor));
        assert.equal(apontaParaData(r), true, JSON.stringify(valor));
      }
    });
  }

  test('ano bissexto real é aceito', () => {
    assert.equal(f.situacao.body.safeParse(corpos.INATIVO({ dataEfetiva: '2024-02-29' })).success, true);
  });

  test('o erro de formato usa o código DATA_EFETIVA_INVALIDA e nunca ecoa o valor recebido', () => {
    const r = f.situacao.body.safeParse(corpos.INATIVO({ dataEfetiva: '2026-02-30' }));
    assert.equal(r.success, false);
    assert.ok(r.error.issues.some((i) => i.params?.codigo === 'DATA_EFETIVA_INVALIDA'), JSON.stringify(r.error.issues));
    assert.equal(JSON.stringify(r.error.issues).includes('2026-02-30'), false);
  });
});

describe('situação — campos descartados e chaves que nunca vêm do cliente', () => {
  const PROIBIDAS = [
    'motivo', 'motivoDesligamento', 'tipoDesligamento', 'descricao', 'observacao', 'justificativa', 'previsaoRetorno', 'reconheceConflito',
    'cid', 'diagnostico', 'inss', 'acidenteTrabalho', 'empresaId', 'usuarioId', 'atorId', 'registradoPor', 'registradoEm', 'situacaoAnterior',
    'id', 'funcionarioId', 'cpf', 'ativo', 'hoje',
  ];
  for (const destino of ['INATIVO', 'AFASTADO', 'ATIVO']) {
    test(`${destino}: qualquer chave fora do contrato é recusada (strict)`, () => {
      assert.equal(f.situacao.body.safeParse(corpos[destino]()).success, true, 'o corpo base do contrato precisa ser aceito, senão a recusa abaixo seria vazia');
      for (const chave of PROIBIDAS) {
        const r = f.situacao.body.safeParse(corpos[destino]({ [chave]: 'x' }));
        assert.equal(r.success, false, `${destino} aceitou ${chave}`);
      }
    });
  }

  test('situação inválida continua recusada', () => {
    assert.equal(f.situacao.body.safeParse(corpos.INATIVO()).success, true, 'precondição: o corpo válido do contrato é aceito');
    for (const situacao of ['DESLIGADO', 'ativo', '', null, 1, ['INATIVO']]) {
      assert.equal(f.situacao.body.safeParse({ situacao, dataEfetiva: DATA }).success, false, JSON.stringify(situacao));
    }
  });
});

describe('rotas legadas — inativar e reativar', () => {
  test('inativar exige dataEfetiva e não aceita situacao nem outros campos', () => {
    assert.equal(f.inativar.body.safeParse({}).success, false, 'inativar sem data não pode continuar permitido');
    assert.equal(f.inativar.body.safeParse({ dataEfetiva: null }).success, false);
    const ok = f.inativar.body.safeParse({ dataEfetiva: DATA });
    assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
    assert.equal(ok.data.dataEfetiva, DATA);
    for (const chave of ['situacao', 'motivo', 'descricao', 'empresaId', 'reconheceConflito']) {
      assert.equal(f.inativar.body.safeParse({ dataEfetiva: DATA, [chave]: 'x' }).success, false, chave);
    }
    assert.equal(f.inativar.body.safeParse({ dataEfetiva: '2026-02-30' }).success, false);
  });

  test('reativar aceita {} (compatibilidade) e { dataEfetiva }, e nada além', () => {
    assert.equal(f.reativar.body.safeParse({}).success, true, 'reativar sem corpo continua válido');
    const ok = f.reativar.body.safeParse({ dataEfetiva: DATA });
    assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
    assert.equal(ok.data.dataEfetiva, DATA);
    for (const chave of ['situacao', 'motivo', 'descricao', 'previsaoRetorno', 'empresaId']) {
      assert.equal(f.reativar.body.safeParse({ [chave]: 'x' }).success, false, chave);
    }
    assert.equal(f.reativar.body.safeParse({ dataEfetiva: '2026-02-30' }).success, false);
  });

  test('os parâmetros de rota continuam exigindo identificador válido', () => {
    for (const rota of [f.situacao, f.inativar, f.reativar]) {
      assert.equal(rota.params.safeParse({ id: '70' }).success, true);
      for (const id of ['0', '-1', 'abc', '1.5']) assert.equal(rota.params.safeParse({ id }).success, false, id);
    }
  });
});
