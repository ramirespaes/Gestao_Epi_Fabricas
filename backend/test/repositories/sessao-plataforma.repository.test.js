'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  criar, buscarValidaPorHash, registrarUso, revogar, revogarTodasDoAdministrador,
} = require('../../src/repositories/sessao-plataforma.repository');

/**
 * Contrato do repositório de sessões de plataforma (migration 028). Mesma
 * disciplina de sessao.repository.test.js: condições de validade só na
 * consulta, nunca depois; sem empresa_id em lugar nenhum (uma sessão de
 * plataforma não carrega contexto empresarial).
 */

const ADMIN_ID = 9;
const SESSAO = '777';
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
  criado_em: new Date('2026-09-23T10:00:00Z'),
  expira_em: new Date('2026-09-23T22:00:00Z'),
  ultimo_uso_em: new Date('2026-09-23T10:30:00Z'),
  administrador_id: ADMIN_ID,
  administrador_email: 'admin@safework.com.br',
  ...extra,
});

const VERIFICADO_EM = new Date('2026-09-23T09:59:58Z');
const MFA = Object.freeze({ verificadoEm: VERIFICADO_EM, metodo: 'TOTP' });

describe('criar', () => {
  test('grava o vínculo com o administrador e o registro do MFA, sem empresa_id/usuario_id', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const expiraEm = new Date('2026-09-23T22:00:00Z');

    const id = await criar(executor, { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm, mfa: MFA });

    assert.equal(id, SESSAO);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /insert\s+into\s+sessoes_plataforma/i);
    assert.deepEqual(valores, [ADMIN_ID, HASH, expiraEm, null, null, VERIFICADO_EM, 'TOTP']);
    assert.equal(texto.includes(HASH), false, 'o hash não pode ser concatenado no SQL');
    assert.match(texto, /clock_timestamp\(\)/i);
    assert.doesNotMatch(texto, /empresa_id|usuario_id/i);
  });

  test('sem MFA não há sessão: registro ausente ou nulo é recusado antes de consultar', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const base = { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3) };

    await assert.rejects(() => criar(executor, base), /mfa/i, 'mfa ausente');
    await assert.rejects(() => criar(executor, { ...base, mfa: null }), /mfa/i, 'mfa nulo');
    await assert.rejects(() => criar(executor, { ...base, mfa: undefined }), /mfa/i, 'mfa indefinido');

    assert.equal(executor.chamadas.length, 0);
  });

  test('só TOTP, CADASTRO e RECADASTRO criam sessão; SUBSTITUICAO e REAUTENTICACAO não', async () => {
    const base = { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3) };

    for (const metodo of ['TOTP', 'CADASTRO', 'RECADASTRO']) {
      const executor = executorFalso([{ id: SESSAO }]);
      await criar(executor, { ...base, mfa: { verificadoEm: VERIFICADO_EM, metodo } });
      assert.equal(executor.chamadas[0].valores[6], metodo);
    }
    for (const metodo of ['SUBSTITUICAO', 'REAUTENTICACAO']) {
      const executor = executorFalso([{ id: SESSAO }]);
      await assert.rejects(() => criar(executor, { ...base, mfa: { verificadoEm: VERIFICADO_EM, metodo } }), /mfa/i, metodo);
      assert.equal(executor.chamadas.length, 0, metodo);
    }
  });

  test('sessão nascida do MFA grava o instante e o método da verificação', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const expiraEm = new Date('2026-09-28T18:00:00Z');
    const verificadoEm = new Date('2026-09-28T10:00:00Z');

    await criar(executor, { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm, mfa: { verificadoEm, metodo: 'CADASTRO' } });

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /mfa_verificado_em/i);
    assert.match(texto, /mfa_metodo/i);
    assert.deepEqual(valores, [ADMIN_ID, HASH, expiraEm, null, null, verificadoEm, 'CADASTRO']);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([{ id: SESSAO }]);
    const base = { administradorId: ADMIN_ID, tokenHash: HASH, expiraEm: new Date(Date.now() + 3600e3) };

    await assert.rejects(() => criar(executor, { ...base, administradorId: 0 }), /administrador/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'curto' }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, tokenHash: 'A'.repeat(64) }), /hash/i);
    await assert.rejects(() => criar(executor, { ...base, expiraEm: '2026-09-23' }), /data/i);
    for (const mfa of [{ verificadoEm: new Date(), metodo: 'SENHA' }, { verificadoEm: 'ontem', metodo: 'TOTP' }, { metodo: 'TOTP' }, 'TOTP']) {
      await assert.rejects(() => criar(executor, { ...base, mfa }), /mfa/i, JSON.stringify(mfa));
    }

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('buscarValidaPorHash', () => {
  test('as condições de validade estão na consulta, inclusive administrador.ativo', async () => {
    const executor = executorFalso([linhaSessao()]);

    await buscarValidaPorHash(executor, HASH, INATIVIDADE);

    const { texto, valores } = executor.chamadas[0];
    assert.deepEqual(valores, [HASH, INATIVIDADE]);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.match(texto, /expira_em\s*>/i);
    assert.match(texto, /ultimo_uso_em/i);
    assert.match(texto, /a\.ativo/i, 'administrador inativo derruba a sessão');
    assert.doesNotMatch(texto, /empresa_id|usuario_id/i);
  });

  test('devolve contexto estruturado, sem hash nem token', async () => {
    const executor = executorFalso([linhaSessao()]);

    const contexto = await buscarValidaPorHash(executor, HASH, INATIVIDADE);

    assert.deepEqual(Object.keys(contexto).sort(), ['administrador', 'sessao']);
    assert.equal(contexto.sessao.id, SESSAO);
    assert.equal(contexto.administrador.id, ADMIN_ID);
    const serializado = JSON.stringify(contexto);
    assert.equal(serializado.includes(HASH), false);
    assert.equal(/senha_hash/i.test(executor.chamadas[0].texto), false);
  });

  test('sessão inválida não é encontrada e devolve null', async () => {
    assert.equal(await buscarValidaPorHash(executorFalso([]), HASH, INATIVIDADE), null);
  });

  test('recusa entrada inválida antes de consultar', async () => {
    const executor = executorFalso([linhaSessao()]);

    await assert.rejects(() => buscarValidaPorHash(executor, 'curto', INATIVIDADE), /hash/i);
    await assert.rejects(() => buscarValidaPorHash(executor, HASH, 0), /inatividade/i);

    assert.equal(executor.chamadas.length, 0);
  });
});

describe('registrarUso', () => {
  test('atualiza o último uso sob os mesmos critérios de validade', async () => {
    const executor = executorFalso([], 1);

    const atualizou = await registrarUso(executor, SESSAO, INATIVIDADE);

    assert.equal(atualizou, true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes_plataforma/i);
    assert.match(texto, /ultimo_uso_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /revogada_em\s+is\s+null/i);
    assert.deepEqual(valores, [SESSAO, INATIVIDADE]);
  });

  test('devolve false quando nada foi atualizado', async () => {
    assert.equal(await registrarUso(executorFalso([], 0), SESSAO, INATIVIDADE), false);
  });

  test('recusa identificador fora do formato decimal canônico', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => registrarUso(executor, 777, INATIVIDADE), /sess/i);
    await assert.rejects(() => registrarUso(executor, '0', INATIVIDADE), /sess/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('revogar', () => {
  test('revoga a sessão registrando o motivo, sem filtro de empresa', async () => {
    const executor = executorFalso([], 1);

    const revogou = await revogar(executor, SESSAO, 'LOGOUT');

    assert.equal(revogou, true);
    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes_plataforma/i);
    assert.match(texto, /revogada_em\s*=\s*clock_timestamp\(\)/i);
    assert.deepEqual(valores, [SESSAO, 'LOGOUT']);
  });

  test('não revoga duas vezes a mesma sessão', async () => {
    const executor = executorFalso([], 1);
    await revogar(executor, SESSAO, 'LOGOUT');
    assert.match(executor.chamadas[0].texto, /revogada_em\s+is\s+null/i);
  });

  test('devolve false quando a sessão já não está ativa', async () => {
    assert.equal(await revogar(executorFalso([], 0), SESSAO, 'LOGOUT'), false);
  });

  test('recusa motivo fora do formato aceito pela coluna', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => revogar(executor, SESSAO, 'logout'), /motivo/i);
    await assert.rejects(() => revogar(executor, SESSAO, ''), /motivo/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

describe('revogarTodasDoAdministrador', () => {
  test('revoga todas as sessões não revogadas do administrador e devolve a quantidade', async () => {
    const executor = executorFalso([], 3);

    assert.equal(await revogarTodasDoAdministrador(executor, ADMIN_ID, 'MFA_RESET_OPERACIONAL'), 3);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /update\s+sessoes_plataforma/i);
    assert.match(texto, /revogada_em\s*=\s*clock_timestamp\(\)/i);
    assert.match(texto, /motivo_revogacao\s*=\s*\$2/i);
    assert.match(texto, /administrador_id\s*=\s*\$1/i);
    assert.match(texto, /revogada_em\s+is\s+null/i, 'não sobrescreve motivo nem instante de quem já foi revogada');
    assert.deepEqual(valores, [ADMIN_ID, 'MFA_RESET_OPERACIONAL', null]);
  });

  test('exceção opcional de uma sessão (a que continua ou a que vai ser trocada por outra via)', async () => {
    const executor = executorFalso([], 2);

    assert.equal(await revogarTodasDoAdministrador(executor, ADMIN_ID, 'MFA_SUBSTITUIDO', { exceto: SESSAO }), 2);

    const { texto, valores } = executor.chamadas[0];
    assert.match(texto, /id\s*<>\s*\$3/i);
    assert.deepEqual(valores, [ADMIN_ID, 'MFA_SUBSTITUIDO', SESSAO]);
  });

  test('idempotente: sem nada a revogar devolve 0', async () => {
    assert.equal(await revogarTodasDoAdministrador(executorFalso([], 0), ADMIN_ID, 'MFA_RESET_OPERACIONAL'), 0);
  });

  test('motivo é obrigatório e exceção precisa ser um id de sessão; nada é consultado antes', async () => {
    const executor = executorFalso([], 1);
    await assert.rejects(() => revogarTodasDoAdministrador(executor, ADMIN_ID), /motivo/i);
    await assert.rejects(() => revogarTodasDoAdministrador(executor, ADMIN_ID, 'mfa'), /motivo/i);
    await assert.rejects(() => revogarTodasDoAdministrador(executor, 0, 'MFA_RESET_OPERACIONAL'), /administrador/i);
    await assert.rejects(() => revogarTodasDoAdministrador(executor, ADMIN_ID, 'MFA_RESET_OPERACIONAL', { exceto: 777 }), /sess/i);
    assert.equal(executor.chamadas.length, 0);
  });
});

// As condições ficam na consulta: sessão sem MFA comprovado não é encontrada.
describe('tempo medido pelo relógio real', () => {
  test('validade e inatividade comparam com clock_timestamp(), na leitura e na renovação', async () => {
    const leitura = executorFalso([linhaSessao()]);
    await buscarValidaPorHash(leitura, HASH, INATIVIDADE);
    const renovacao = executorFalso([], 1);
    await registrarUso(renovacao, SESSAO, INATIVIDADE);

    for (const { texto } of [leitura.chamadas[0], renovacao.chamadas[0]]) {
      assert.match(texto, /expira_em\s*>\s*clock_timestamp\(\)/i);
      assert.match(texto, /ultimo_uso_em\s*>\s*clock_timestamp\(\)\s*-/i);
    }
  });

  test('nenhuma consulta do repositório usa now(), que é o início da transação', () => {
    const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'repositories', 'sessao-plataforma.repository.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(codigo, /\bnow\(\)/i);
  });
});

describe('sessão plena exige MFA comprovado', () => {
  const consulta = async (fn) => {
    const executor = executorFalso([]);
    await fn(executor);
    return executor.chamadas[0].texto.replace(/\s+/g, ' ');
  };

  test('buscarValidaPorHash exige instante e método do MFA, só com os três métodos que criam sessão', async () => {
    const texto = await consulta((e) => buscarValidaPorHash(e, HASH, INATIVIDADE));

    assert.match(texto, /s\.mfa_verificado_em IS NOT NULL/i);
    assert.match(texto, /s\.mfa_metodo IN \('TOTP', 'CADASTRO', 'RECADASTRO'\)/i);
    assert.match(texto, /s\.mfa_verificado_em <= s\.criado_em/i);
    assert.doesNotMatch(texto, /SUBSTITUICAO|REAUTENTICACAO/);
  });

  test('buscarValidaPorHash exige o desafio concluído que criou a sessão, do mesmo administrador e do tipo do método', async () => {
    const texto = await consulta((e) => buscarValidaPorHash(e, HASH, INATIVIDADE));

    assert.match(texto, /EXISTS \( SELECT 1 FROM desafios_mfa_plataforma d/i);
    assert.match(texto, /d\.sessao_criada_id = s\.id/i);
    assert.match(texto, /d\.administrador_id = s\.administrador_id/i);
    assert.match(texto, /d\.motivo_encerramento = 'CONCLUIDO'/i);
    assert.match(texto, /WHEN 'TOTP' THEN 'VERIFICACAO'/i);
    assert.match(texto, /WHEN 'CADASTRO' THEN 'CADASTRO'/i);
    assert.match(texto, /WHEN 'RECADASTRO' THEN 'RECUPERACAO'/i);
    assert.match(texto, /d\.criado_em <= s\.mfa_verificado_em/i);
    assert.match(texto, /s\.mfa_verificado_em <= d\.encerrado_em/i);
  });

  test('registrarUso não renova sessão sem MFA', async () => {
    const texto = await consulta((e) => registrarUso(e, SESSAO, INATIVIDADE));

    assert.match(texto, /mfa_verificado_em IS NOT NULL/i);
    assert.match(texto, /mfa_metodo IN \('TOTP', 'CADASTRO', 'RECADASTRO'\)/i);
  });
});
