'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  criar,
  buscarValidaPorHash,
  registrarUso,
  revogar,
  revogarDoUsuario,
  CAMPOS_SESSAO,
} = require('../../src/repositories/sessao.repository');

/**
 * Contrato do repositório de sessões.
 *
 * A sessão é a fonte da identidade autenticada. Tudo que o resto do sistema
 * sabe sobre quem está pedindo vem daqui, e não de um identificador enviado
 * pelo navegador.
 *
 * Só o SHA-256 do token chega a este repositório. O token em claro existe
 * apenas no momento da emissão, na camada acima, e nunca é persistido nem
 * consultado.
 *
 * As condições de validade ficam na própria consulta, e não em código depois
 * do resultado: revogação, expiração absoluta, inatividade e situação do
 * usuário e da empresa. Uma sessão inválida simplesmente não é encontrada.
 */

const EMPRESA_A = 4242;
const EMPRESA_B = 8888;
const USUARIO = 77;
// sessoes.id é BIGINT: o driver pg devolve como string, e o repositório
// adota essa representação como contrato — nunca um number. O dublê de
// executor abaixo simula esse formato real em vez do valor numérico que um
// SERIAL/INTEGER teria.
const SESSAO = '555';
const HASH = 'a'.repeat(64);
const INATIVIDADE = 30;

const executorFalso = (linhas = [], rowCount) => {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto, valores) => {
      chamadas.push({ texto, valores });
      return { rows: linhas, rowCount: rowCount ?? linhas.length };
    },
  };
};

const linhaSessao = (extra = {}) => ({
  id: SESSAO,
  empresa_id: EMPRESA_A,
  usuario_id: USUARIO,
  criado_em: new Date('2026-09-19T10:00:00Z'),
  expira_em: new Date('2026-09-19T22:00:00Z'),
  ultimo_uso_em: new Date('2026-09-19T10:30:00Z'),
  usuario_nome: 'Ana Souza',
  usuario_email: 'ana.souza@demo.safeworkengenharia.com.br',
  usuario_perfil: 'ADMINISTRADOR',
  empresa_nome: 'Empresa A',
  empresa_cnpj: '12345678000195',
  ...extra,
});

describe('criar', () => {
  test('grava o vínculo entre empresa e usuário, de forma parametrizada', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const expiraEm = new Date('2026-09-19T22:00:00Z');

    const id = await criar(executor, {
      empresaId: EMPRESA_A, usuarioId: USUARIO, tokenHash: HASH, expiraEm,
    });

    assert.equal(id, SESSAO);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+sessoes/i);
    assert.equal(valores[0], EMPRESA_A);
    assert.equal(valores[1], USUARIO);
    assert.equal(valores[2], HASH);
    assert.equal(valores[3], expiraEm);
    assert.equal(texto.includes(HASH), false, 'o hash não pode ser concatenado no SQL');
    // criado_em e ultimo_uso_em vêm de clock_timestamp() escrito no próprio
    // SQL, não de parâmetros novos: a assinatura pública não muda, e o
    // valor não fica preso ao início da transação (ver docstring de criar).
    assert.match(texto, /criado_em/i);
    assert.match(texto, /ultimo_uso_em/i);
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.equal(valores.length, 7, 'nenhum parâmetro novo deve ser exigido do chamador');
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const base = { empresaId: EMPRESA_A, usuarioId: USUARIO, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3) };

    await assert.rejects(() => criar(executor, { ...base, empresaId: 0 }), /empresa/i);
    await assert.rejects(() => criar(executor, { ...base, usuarioId: -1 }), /usuário/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'curto' }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'A'.repeat(64) }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, expiraEm: '2026-09-19' }), /expira/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa forma de autenticação fora do formato da coluna', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const base = { empresaId: EMPRESA_A, usuarioId: USUARIO, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3) };

    await assert.rejects(() => criar(executor, { ...base, autenticadoVia: 'senha' }), /autentica/i);
    await assert.rejects(() => criar(executor, { ...base, autenticadoVia: '' }), /autentica/i);
    await assert.rejects(() => criar(executor, { ...base, autenticadoVia: null }), /autentica/i);
    await assert.rejects(() => criar(executor, { ...base, autenticadoVia: 'V'.repeat(21) }), /autentica/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('aceita a forma de autenticação padrão sem que ela seja informada', async () => {
    const executor = executorFalso([{ id: SESSAO }]);

    await criar(executor, {
      empresaId: EMPRESA_A, usuarioId: USUARIO, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3),
    });

    assert.equal(executor.chamadas[0].valores[4], 'SENHA');
  });

  test('aceita forma de autenticação alternativa no limite da coluna', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const limite = 'V'.repeat(20);

    await criar(executor, {
      empresaId: EMPRESA_A, usuarioId: USUARIO, tokenHash: HASH,
      expiraEm: new Date(Date.now() + 3600e3), autenticadoVia: limite,
    });

    assert.equal(executor.chamadas[0].valores[4], limite);
  });

  test('recusa token em claro no lugar do hash', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const tokenEmClaro = 'Zm9ybWF0b2Jhc2U2NHVybGRldG9rZW5jb21fNDNjaGFycw';

    await assert.rejects(() => criar(executor, {
      empresaId: EMPRESA_A, usuarioId: USUARIO, tokenHash: tokenEmClaro, expiraEm: new Date(Date.now() + 3600e3),
    }), /hash/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarValidaPorHash', () => {
  test('as condições de validade estão na consulta, não depois dela', async () => {
    const executor = executorFalso([linhaSessao()]);

    await buscarValidaPorHash(executor, HASH, INATIVIDADE);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [HASH, INATIVIDADE]);
    assert.match(texto, /revogada_em\s+is\s+null/i, 'sessão revogada não pode ser encontrada');
    assert.match(texto, /expira_em\s*>/i, 'expiração absoluta');
    assert.match(texto, /ultimo_uso_em/i, 'inatividade');
    assert.match(texto, /u\.ativo/i, 'usuário inativo derruba a sessão');
    assert.match(texto, /e\.ativo/i, 'empresa inativa derruba a sessão');
    // Aceita as duas ordens: a igualdade é simétrica e exigir uma delas
    // amarraria o teste ao estilo de escrita, não ao comportamento.
    assert.match(
      texto,
      /(s\.empresa_id\s*=\s*u\.empresa_id|u\.empresa_id\s*=\s*s\.empresa_id)/i,
      'a empresa da sessão precisa ser a mesma do usuário',
    );
  });

  test('devolve contexto estruturado, sem hash de senha nem token', async () => {
    const executor = executorFalso([linhaSessao()]);

    const contexto = await buscarValidaPorHash(executor, HASH, INATIVIDADE);

    assert.deepEqual(Object.keys(contexto).sort(), ['empresa', 'sessao', 'usuario']);
    assert.equal(contexto.sessao.id, SESSAO);
    assert.equal(contexto.empresa.id, EMPRESA_A);
    assert.equal(contexto.usuario.perfil, 'ADMINISTRADOR');

    const serializado = JSON.stringify(contexto);
    assert.equal(serializado.includes('senha_hash'), false);
    assert.equal(serializado.includes('token'), false);
    assert.equal(serializado.includes(HASH), false);
    assert.equal(/senha_hash/i.test(executor.chamadas[0].texto), false);
  });

  test('a projeção declara os campos esperados', async () => {
    const executor = executorFalso([linhaSessao()]);

    await buscarValidaPorHash(executor, HASH, INATIVIDADE);

    for (const campo of CAMPOS_SESSAO) {
      assert.match(executor.chamadas[0].texto, new RegExp(campo, 'i'), `a consulta deve projetar ${campo}`);
    }
  });

  test('sessão inválida não é encontrada e devolve null', async () => {
    assert.equal(await buscarValidaPorHash(executorFalso([]), HASH, INATIVIDADE), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaSessao()]);

    await assert.rejects(() => buscarValidaPorHash(executor, 'curto', INATIVIDADE), /hash/i);
    await assert.rejects(() => buscarValidaPorHash(executor, null, INATIVIDADE), /hash/i);
    await assert.rejects(() => buscarValidaPorHash(executor, HASH, 0), /inatividade/i);
    await assert.rejects(() => buscarValidaPorHash(executor, HASH, -5), /inatividade/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('registrarUso', () => {
  test('atualiza o último uso, sob os mesmos critérios de validade da leitura', async () => {
    const executor = executorFalso([], 1);

    const atualizou = await registrarUso(executor, SESSAO, INATIVIDADE);

    assert.equal(atualizou, true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes/i);
    assert.match(texto, /ultimo_uso_em\s*=\s*now\(\)/i);
    assert.match(texto, /revogada_em\s+is\s+null/i, 'sessão revogada não pode ter o uso renovado');
    assert.match(texto, /expira_em\s*>\s*now\(\)/i, 'sessão vencida por expiração absoluta não pode ter o uso renovado');
    assert.match(texto, /ultimo_uso_em\s*>\s*now\(\)/i, 'sessão vencida por inatividade não pode ter o uso renovado');
    assert.deepEqual(valores, [SESSAO, INATIVIDADE]);
  });

  test('devolve false quando nada foi atualizado (sessão inexistente ou vencida)', async () => {
    assert.equal(await registrarUso(executorFalso([], 0), SESSAO, INATIVIDADE), false);
  });

  test('recusa identificador de sessão fora do formato decimal canônico', async () => {
    const executor = executorFalso([], 1);

    await assert.rejects(() => registrarUso(executor, 555, INATIVIDADE), /sess/i, 'number não é aceito, só string');
    await assert.rejects(() => registrarUso(executor, '0', INATIVIDADE), /sess/i, 'IDENTITY começa em 1');
    await assert.rejects(() => registrarUso(executor, '007', INATIVIDADE), /sess/i, 'zero à esquerda não é canônico');
    await assert.rejects(() => registrarUso(executor, '-5', INATIVIDADE), /sess/i);
    await assert.rejects(() => registrarUso(executor, '', INATIVIDADE), /sess/i);
    await assert.rejects(() => registrarUso(executor, null, INATIVIDADE), /sess/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa janela de inatividade inválida', async () => {
    const executor = executorFalso([], 1);

    await assert.rejects(() => registrarUso(executor, SESSAO, 0), /inatividade/i);
    await assert.rejects(() => registrarUso(executor, SESSAO, -1), /inatividade/i);
    await assert.rejects(() => registrarUso(executor, SESSAO, 1.5), /inatividade/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('revogar', () => {
  test('revoga uma sessão dentro da empresa, registrando o motivo', async () => {
    const executor = executorFalso([], 1);

    const revogou = await revogar(executor, EMPRESA_A, SESSAO, 'LOGOUT');

    assert.equal(revogou, true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes/i);
    assert.match(texto, /revogada_em\s*=\s*now\(\)/i);
    assert.match(texto, /empresa_id\s*=\s*\$1/i, 'sem o filtro de empresa seria possível revogar sessão alheia');
    assert.deepEqual(valores, [EMPRESA_A, SESSAO, 'LOGOUT']);
  });

  test('não revoga duas vezes a mesma sessão', async () => {
    const executor = executorFalso([], 1);

    await revogar(executor, EMPRESA_A, SESSAO, 'LOGOUT');

    assert.match(executor.chamadas[0].texto, /revogada_em\s+is\s+null/i);
  });

  test('devolve false quando a sessão é de outra empresa', async () => {
    assert.equal(await revogar(executorFalso([], 0), EMPRESA_B, SESSAO, 'LOGOUT'), false);
  });

  test('recusa motivo fora do formato aceito pela coluna', async () => {
    const executor = executorFalso([], 1);

    await assert.rejects(() => revogar(executor, EMPRESA_A, SESSAO, 'logout'), /motivo/i);
    await assert.rejects(() => revogar(executor, EMPRESA_A, SESSAO, ''), /motivo/i);
    await assert.rejects(() => revogar(executor, EMPRESA_A, SESSAO, 'M'.repeat(31)), /motivo/i);
    await assert.rejects(() => revogar(executor, 0, SESSAO, 'LOGOUT'), /empresa/i);

    assert.equal(executor.chamadas.length, 0);
  });

  test('recusa identificador de sessão fora do formato decimal canônico', async () => {
    const executor = executorFalso([], 1);

    await assert.rejects(() => revogar(executor, EMPRESA_A, 555, 'LOGOUT'), /sess/i, 'number não é aceito, só string');
    await assert.rejects(() => revogar(executor, EMPRESA_A, '0', 'LOGOUT'), /sess/i);
    await assert.rejects(() => revogar(executor, EMPRESA_A, '007', 'LOGOUT'), /sess/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('revogarDoUsuario', () => {
  test('revoga todas as sessões ativas do usuário na empresa', async () => {
    const executor = executorFalso([], 3);

    const quantidade = await revogarDoUsuario(executor, EMPRESA_A, USUARIO, 'TROCA_SENHA');

    assert.equal(quantidade, 3);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /empresa_id\s*=\s*\$1/i);
    assert.match(texto, /usuario_id\s*=\s*\$2/i);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.deepEqual(valores, [EMPRESA_A, USUARIO, 'TROCA_SENHA']);
  });

  test('devolve zero quando não há sessão ativa', async () => {
    assert.equal(await revogarDoUsuario(executorFalso([], 0), EMPRESA_A, USUARIO, 'LOGOUT_GLOBAL'), 0);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([], 1);

    await assert.rejects(() => revogarDoUsuario(executor, 0, USUARIO, 'LOGOUT_GLOBAL'), /empresa/i);
    await assert.rejects(() => revogarDoUsuario(executor, EMPRESA_A, 0, 'LOGOUT_GLOBAL'), /usuário/i);
    await assert.rejects(() => revogarDoUsuario(executor, EMPRESA_A, USUARIO, 'minusculo'), /motivo/i);

    assert.equal(executor.chamadas.length, 0);
  });
});
