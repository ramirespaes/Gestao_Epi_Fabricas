'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const script = require('../../scripts/provisionar-permissoes-master');

/**
 * Parte pura do script administrativo (Bloco 9, Etapa B): interpretação de
 * argumentos e formatação do relatório. A execução contra PostgreSQL real
 * está em test/integracao/provisionamento-permissoes.integration.js.
 */

describe('interpretarArgumentos', () => {
  test('--empresa é obrigatório; sem --executar o modo é dry-run (seguro por padrão)', () => {
    assert.deepEqual(script.interpretarArgumentos(['--empresa', '7']), { ok: true, empresaId: 7, atorId: null, executar: false });
    assert.deepEqual(script.interpretarArgumentos(['--empresa', '7', '--dry-run']), { ok: true, empresaId: 7, atorId: null, executar: false });
    assert.deepEqual(script.interpretarArgumentos(['--executar', '--empresa', '7', '--ator', '3']), { ok: true, empresaId: 7, atorId: 3, executar: true });
    assert.equal(script.interpretarArgumentos([]).ok, false);
    assert.match(script.interpretarArgumentos([]).erro, /--empresa/);
  });

  test('recusa: id não numérico, zero, negativo, repetido, argumento desconhecido, --dry-run junto de --executar', () => {
    for (const argumentos of [
      ['--empresa', 'abc'], ['--empresa', '0'], ['--empresa', '-1'], ['--empresa', '01'], ['--empresa'],
      ['--empresa', '7', '--empresa', '8'], ['--empresa', '7', '--ator', 'x'], ['--empresa', '7', '--todas'],
      ['--empresa', '7', '--dry-run', '--executar'],
    ]) {
      const r = script.interpretarArgumentos(argumentos);
      assert.equal(r.ok, false, JSON.stringify(argumentos));
      assert.equal(typeof r.erro, 'string');
    }
    assert.throws(() => script.interpretarArgumentos('--empresa 7'), TypeError);
  });

  test('códigos de saída são distintos e o texto de uso cita os quatro argumentos', () => {
    assert.deepEqual(script.SAIDAS, { OK: 0, ERRO: 1, ARGUMENTOS: 2, EMPRESA: 3, ATENCAO: 4 });
    for (const flag of ['--empresa', '--ator', '--dry-run', '--executar']) {
      assert.ok(script.uso().includes(flag));
    }
  });
});

describe('formatarPlano', () => {
  test('lista recursos e ações com situação; INSUFICIENTE mostra as operações faltantes; nada além de identificadores', () => {
    const linhas = script.formatarPlano({
      empresa: { id: 5, nome: 'Empresa A', ativo: true },
      perfil: 'MASTER',
      recursos: [
        { recurso: 'materials', operacoes: ['visualizar', 'criar', 'editar'], situacao: 'INSUFICIENTE', faltantes: ['editar'] },
        { recurso: 'employeeGroups', operacoes: ['visualizar', 'criar', 'editar'], situacao: 'AUSENTE', faltantes: [] },
      ],
      acoes: [{ acaoCodigo: 'MOVIMENTAR_ESTOQUE', situacao: 'NAO_CATALOGADA', catalogo: 'INEXISTENTE' }],
    });
    assert.equal(linhas[0], 'Empresa 5 — Empresa A (ativa), perfil MASTER');
    assert.ok(linhas.some((l) => /INSUFICIENTE\s+materials .*faltam: editar/.test(l)));
    assert.ok(linhas.some((l) => /AUSENTE\s+employeeGroups/.test(l)));
    assert.ok(linhas.some((l) => /NAO_CATALOGADA\s+MOVIMENTAR_ESTOQUE .*INEXISTENTE/.test(l)));
  });
});
