'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const repositorio = require('../../src/repositories/auditoria-plataforma.repository');

const { registrar } = repositorio;

/**
 * Contrato do repositório de auditoria de plataforma (migrations 029 e
 * 048). registrar() é a ação de um administrador: administrador_id é
 * OBRIGATÓRIO e empresa_afetada_id é OPCIONAL. Operação de CLI e evento do
 * sistema têm funções próprias, que fixam o ator e nunca aceitam um
 * administrador como autor. O repositório só grava o que recebe; a recusa
 * de chave sensível é responsabilidade do PostgreSQL (trigger reaproveitada
 * de 014), não deste módulo.
 */

const ADMIN_ID = 5;

const executorFalso = (linhas = []) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas };
    },
  };
};

describe('registrar', () => {
  test('grava com administrador_id obrigatório e empresa_afetada_id nulo por padrão', async () => {
    const executor = executorFalso([{ id: '1', criado_em: new Date('2026-09-23T10:00:00Z') }]);

    const resultado = await registrar(executor, { administradorId: ADMIN_ID, acao: 'ADMINISTRADOR_PLATAFORMA_CRIADO' });

    assert.deepEqual(resultado, { id: '1', criadoEm: new Date('2026-09-23T10:00:00Z') });
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+logs_auditoria_plataforma/i);
    assert.match(texto, /ator_tipo/i);
    assert.deepEqual(valores, [ADMIN_ID, null, 'ADMINISTRADOR_PLATAFORMA_CRIADO', null, null, null, null, null, null, null, 'ADMINISTRADOR', null]);
  });

  test('aceita outro administrador como alvo, nunca o próprio ator', async () => {
    const executor = executorFalso([{ id: '4', criado_em: new Date() }]);

    await registrar(executor, { administradorId: ADMIN_ID, administradorAfetadoId: 9, acao: 'X' });

    assert.deepEqual(executor.chamadas[0].valores.slice(-2), ['ADMINISTRADOR', 9]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, administradorAfetadoId: ADMIN_ID, acao: 'X' }), /alvo/i);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, administradorAfetadoId: 0, acao: 'X' }), /alvo/i);
    assert.equal(executor.chamadas.length, 1);
  });

  test('o tipo de ator não é parâmetro: registrar é sempre ADMINISTRADOR', async () => {
    const executor = executorFalso([{ id: '5', criado_em: new Date() }]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', atorTipo: 'SISTEMA' }), TypeError);
    assert.equal(executor.chamadas.length, 0);
  });

  test('repassa empresa_afetada_id e os campos JSONB tal como recebidos, sem alterar', async () => {
    const executor = executorFalso([{ id: '2', criado_em: new Date() }]);
    const contexto = { origem: 'script_administrativo_bootstrap' };

    await registrar(executor, {
      administradorId: ADMIN_ID,
      empresaAfetadaId: 77,
      acao: 'EMPRESA_INSPECIONADA',
      referencia: '77',
      descricao: 'consulta administrativa',
      ip: '203.0.113.10',
      dispositivo: 'curl/8.0',
      contexto,
      dadosAnteriores: null,
      dadosNovos: { ativo: true },
    });

    const { valores } = executor.chamadas[0];
    assert.deepEqual(valores, [ADMIN_ID, 77, 'EMPRESA_INSPECIONADA', '77', 'consulta administrativa', '203.0.113.10', 'curl/8.0', contexto, null, { ativo: true }, 'ADMINISTRADOR', null]);
  });

  test('recusa administrador_id inválido ou ausente antes de consultar', async () => {
    const executor = executorFalso([]);

    await assert.rejects(() => registrar(executor, { administradorId: 0, acao: 'X' }), /administrador/i);
    await assert.rejects(() => registrar(executor, { administradorId: null, acao: 'X' }), /administrador/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa empresa_afetada_id inválido (quando informado)', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, empresaAfetadaId: 0, acao: 'X' }), /empresa/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa ação vazia ou fora do limite da coluna', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: '' }), /ação/i);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'A'.repeat(61) }), /ação/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa contexto/dados_anteriores/dados_novos que não sejam objeto ou null', async () => {
    const executor = executorFalso([]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', contexto: 'não é objeto' }), /contexto/i);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', dadosAnteriores: [] }), /dadosAnteriores/i);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', dadosNovos: 42 }), /dadosNovos/i);
    assert.equal(executor.chamadas.length, 0);
  });

  test('propaga sem tradução um erro do PostgreSQL (ex.: rejeição por chave sensível)', async () => {
    const executor = {
      chamadas: [],
      query: async () => { throw new Error('logs_auditoria: campo JSONB contém chave sensível'); },
    };

    await assert.rejects(
      () => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', contexto: { senha: 'x' } }),
      /chave sensível/,
    );
  });
});

// SEC-002: mesma garantia da auditoria da empresa, nas colunas VARCHAR(150)
// e VARCHAR(45) da migration 029.
describe('SEC-002 — IP e User-Agent cabem nas colunas', () => {
  const gravar = async (extra) => {
    const executor = executorFalso([{ id: '3', criado_em: new Date() }]);
    await registrar(executor, { administradorId: ADMIN_ID, acao: 'X', ...extra });
    const valores = executor.chamadas[0].valores;
    return { ip: valores[5], dispositivo: valores[6] };
  };

  test('User-Agent com 150 fica igual; com 151 e com 400 é cortado nos primeiros 150', async () => {
    const ua = (n) => 'curl/8.0 '.repeat(50).slice(0, n);
    assert.equal((await gravar({ dispositivo: ua(150) })).dispositivo, ua(150));
    assert.equal((await gravar({ dispositivo: ua(151) })).dispositivo, ua(150));
    assert.equal((await gravar({ dispositivo: ua(400) })).dispositivo, ua(150));
  });

  test('IP no limite fica igual; acima de 45 é cortado', async () => {
    const ipv6 = '0000:0000:0000:0000:0000:ffff:192.168.100.228';
    assert.equal((await gravar({ ip: ipv6 })).ip, ipv6);
    assert.equal((await gravar({ ip: `${ipv6}, 198.51.100.7` })).ip, ipv6);
  });

  test('ausente vira null; tipo que não é texto é erro de programação, antes de consultar', async () => {
    assert.deepEqual(await gravar({}), { ip: null, dispositivo: null });
    const executor = executorFalso([]);
    await assert.rejects(() => registrar(executor, { administradorId: ADMIN_ID, acao: 'X', dispositivo: 5 }), /dispositivo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

// Migration 048: o ator de cada função é fixo. Quem chama escolhe a função,
// nunca o tipo de ator, e nenhuma delas atribui a operação ao alvo.
for (const [nome, ator] of [['registrarOperacaoCli', 'OPERACAO_CLI'], ['registrarEventoSistema', 'SISTEMA']]) {
  const funcao = (...args) => repositorio[nome](...args);

  describe(`${nome} — ator ${ator}`, () => {
    test('grava com administrador_id nulo, o ator fixo e o alvo quando houver', async () => {
      const executor = executorFalso([{ id: '8', criado_em: new Date('2026-09-28T10:00:00Z') }]);
      const contexto = { origem: 'cli', quantidade: 2 };

      const resultado = await funcao(executor, { administradorAfetadoId: 9, acao: 'MFA_RESET_OPERACIONAL', contexto });

      assert.deepEqual(resultado, { id: '8', criadoEm: new Date('2026-09-28T10:00:00Z') });
      const { texto, valores } = executor.chamadas[0];
      assert.match(texto, /insert\s+into\s+logs_auditoria_plataforma/i);
      assert.deepEqual(valores, [null, null, 'MFA_RESET_OPERACIONAL', null, null, null, null, contexto, null, null, ator, 9]);
    });

    test('alvo é opcional', async () => {
      const executor = executorFalso([{ id: '9', criado_em: new Date() }]);
      await funcao(executor, { acao: 'EVENTO' });
      assert.deepEqual(executor.chamadas[0].valores.slice(-2), [ator, null]);
    });

    test('nunca aceita administrador ator nem tipo de ator vindos de quem chama', async () => {
      const executor = executorFalso([{ id: '10', criado_em: new Date() }]);
      for (const extra of [{ administradorId: 9 }, { administradorId: null }, { atorTipo: 'ADMINISTRADOR' }, { atorTipo: ator }]) {
        await assert.rejects(() => funcao(executor, { administradorAfetadoId: 9, acao: 'X', ...extra }), TypeError, JSON.stringify(extra));
      }
      assert.equal(executor.chamadas.length, 0);
    });

    test('mesmas validações de ação, alvo, empresa e JSONB', async () => {
      const executor = executorFalso([]);
      await assert.rejects(() => funcao(executor, { acao: '' }), /ação/i);
      await assert.rejects(() => funcao(executor, { acao: 'X', administradorAfetadoId: 0 }), /alvo/i);
      await assert.rejects(() => funcao(executor, { acao: 'X', empresaAfetadaId: -1 }), /empresa/i);
      await assert.rejects(() => funcao(executor, { acao: 'X', contexto: [] }), /contexto/i);
      assert.equal(executor.chamadas.length, 0);
    });
  });
}
