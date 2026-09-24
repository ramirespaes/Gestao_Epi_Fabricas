'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { criarInicial, ErroSenhaInvalida } = require('../../src/services/administrador-plataforma.service');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const auditoriaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const passwordPolicy = require('../../src/security/password-policy');
const password = require('../../src/security/password');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do bootstrap do administrador de plataforma, sem
 * PostgreSQL real. Este serviço NÃO é exposto por rota HTTP — só o script
 * administrativo o chama; os testes cobrem exatamente o contrato que esse
 * script depende: idempotência, política de senha, ausência de
 * provisionamento indevido (empresa, perfil, acesso operacional) e,
 * desde a correção final do Pacote 2 (item 2 da auditoria independente),
 * a ATOMICIDADE entre a criação da conta e o registro de auditoria.
 */

const EMAIL = 'admin@safework.com.br';
const SENHA = 'uma-senha-forte-o-bastante-123';
const administradorCriado = Object.freeze({ id: 1, email: EMAIL, ativo: true, criadoEm: new Date(), atualizadoEm: new Date() });

function criarClienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => {
      chamadas.push(texto);
      return { rows: [], rowCount: 0 };
    },
    release: () => { chamadas.push('RELEASE'); },
  };
}

function criarPoolFalso(cliente) {
  const chamadas = { connect: 0 };
  return {
    chamadas,
    connect: async () => {
      chamadas.connect += 1;
      return cliente;
    },
  };
}

function contar(chamadas, padrao) {
  return chamadas.filter((texto) => typeof texto === 'string' && padrao.test(texto)).length;
}

describe('administrador-plataforma.service.criarInicial — sucesso e transação', () => {
  test('normaliza o e-mail, aplica a política de senha, gera hash Argon2id, audita sem dado sensível, e faz TUDO numa única transação', async (t) => {
    t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: true, erros: [] }));
    t.mock.method(administradorRepo, 'buscarPorEmail', async () => null);
    const gerarHash = t.mock.method(password, 'gerarHashSenha', async () => 'hash-argon2id-simulado');
    const criar = t.mock.method(administradorRepo, 'criar', async () => administradorCriado);
    const auditar = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() }));

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    const resultado = await criarInicial(pool, { email: '  Admin@SafeWork.com.br  ', senha: SENHA });

    assert.deepEqual(resultado, administradorCriado);

    assert.equal(gerarHash.mock.calls.length, 1);
    assert.equal(gerarHash.mock.calls[0].arguments[0], SENHA);

    // criar() e registrar() recebem o CLIENTE da transação, nunca o pool.
    assert.equal(criar.mock.calls.length, 1);
    assert.equal(criar.mock.calls[0].arguments[0], cliente);
    assert.deepEqual(criar.mock.calls[0].arguments[1], { email: EMAIL, senhaHash: 'hash-argon2id-simulado' });

    assert.equal(auditar.mock.calls.length, 1);
    assert.equal(auditar.mock.calls[0].arguments[0], cliente);
    const dadosAuditoria = auditar.mock.calls[0].arguments[1];
    assert.equal(dadosAuditoria.administradorId, administradorCriado.id);
    assert.equal(dadosAuditoria.acao, 'ADMINISTRADOR_PLATAFORMA_CRIADO');
    const textoAuditoria = JSON.stringify(dadosAuditoria);
    assert.equal(textoAuditoria.includes(SENHA), false, 'a senha em claro nunca vai para auditoria');
    assert.equal(textoAuditoria.includes('hash-argon2id-simulado'), false, 'o hash nunca vai para auditoria');

    assert.equal(contar(cliente.chamadas, /^BEGIN$/i), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 0);
    assert.equal(cliente.chamadas.includes('RELEASE'), true);
  });

  test('idempotência (buscarPorEmail) roda ANTES de abrir a transação: nenhuma conexão é aberta se o e-mail já existe', async (t) => {
    t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: true, erros: [] }));
    t.mock.method(administradorRepo, 'buscarPorEmail', async () => administradorCriado);
    const criar = t.mock.method(administradorRepo, 'criar', async () => administradorCriado);

    const pool = criarPoolFalso(criarClienteFalso());

    await assert.rejects(() => criarInicial(pool, { email: EMAIL, senha: SENHA }), (erro) => {
      assert.ok(HttpError.ehHttpError(erro));
      assert.equal(erro.status, 409);
      assert.equal(erro.codigo, 'ADMINISTRADOR_EMAIL_EM_USO');
      return true;
    });

    assert.equal(pool.chamadas.connect, 0, 'a pré-checagem de idempotência não deve abrir transação alguma');
    assert.equal(criar.mock.calls.length, 0);
  });
});

describe('administrador-plataforma.service.criarInicial — falha da auditoria: ROLLBACK, nada persiste', () => {
  test('se o registro de auditoria falhar, a conta NÃO pode permanecer criada (ROLLBACK desfaz o INSERT de administradores_plataforma também)', async (t) => {
    t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: true, erros: [] }));
    t.mock.method(administradorRepo, 'buscarPorEmail', async () => null);
    t.mock.method(password, 'gerarHashSenha', async () => 'hash-simulado');
    const criar = t.mock.method(administradorRepo, 'criar', async () => administradorCriado);
    const erroDeAuditoria = new Error('logs_auditoria_plataforma: campo JSONB contém chave sensível');
    const auditar = t.mock.method(auditoriaRepo, 'registrar', async () => { throw erroDeAuditoria; });

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => criarInicial(pool, { email: EMAIL, senha: SENHA }),
      (erro) => erro === erroDeAuditoria,
    );

    assert.equal(criar.mock.calls.length, 1, 'o INSERT de administrador chegou a ser tentado dentro da transação');
    assert.equal(auditar.mock.calls.length, 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 1, 'a falha da auditoria precisa desfazer TUDO, inclusive o administrador recém-inserido');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 0, 'nenhum COMMIT pode ter ocorrido: a conta não pode ficar criada sem o registro de auditoria');
    assert.equal(cliente.chamadas.includes('RELEASE'), true);
  });

  test('erro inesperado no próprio INSERT do administrador também sofre ROLLBACK, e a auditoria nunca chega a ser chamada', async (t) => {
    t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: true, erros: [] }));
    t.mock.method(administradorRepo, 'buscarPorEmail', async () => null);
    t.mock.method(password, 'gerarHashSenha', async () => 'hash-simulado');
    const erroDeInsercao = new Error('conexão perdida com o banco');
    t.mock.method(administradorRepo, 'criar', async () => { throw erroDeInsercao; });
    const auditar = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() }));

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => criarInicial(pool, { email: EMAIL, senha: SENHA }),
      (erro) => erro === erroDeInsercao,
    );

    assert.equal(auditar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 0);
  });

  test('corrida de e-mail (violação UNIQUE dentro da transação): traduzida para 409 ADMINISTRADOR_EMAIL_EM_USO, nunca um erro de SQL cru', async (t) => {
    t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: true, erros: [] }));
    // A pré-checagem NÃO encontra o e-mail (ele ainda não existia quando
    // este processo consultou) — só o INSERT concorrente do outro processo
    // vence a corrida, e é o banco quem detecta o conflito de verdade.
    t.mock.method(administradorRepo, 'buscarPorEmail', async () => null);
    t.mock.method(password, 'gerarHashSenha', async () => 'hash-simulado');
    const erroDeCorrida = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    t.mock.method(administradorRepo, 'criar', async () => { throw erroDeCorrida; });
    const auditar = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: new Date() }));

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => criarInicial(pool, { email: EMAIL, senha: SENHA }),
      (erro) => {
        assert.ok(HttpError.ehHttpError(erro));
        assert.equal(erro.status, 409);
        assert.equal(erro.codigo, 'ADMINISTRADOR_EMAIL_EM_USO');
        return true;
      },
    );

    assert.equal(auditar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 1);
  });
});

describe('administrador-plataforma.service.criarInicial — recusas antes de qualquer transação', () => {
  test('e-mail inválido: 400, nunca chega a validar senha, consultar o repositório ou conectar', async (t) => {
    const validar = t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: true, erros: [] }));
    const buscar = t.mock.method(administradorRepo, 'buscarPorEmail', async () => null);
    const pool = criarPoolFalso(criarClienteFalso());

    await assert.rejects(
      () => criarInicial(pool, { email: 'sem-arroba', senha: SENHA }),
      (erro) => {
        assert.ok(HttpError.ehHttpError(erro));
        assert.equal(erro.status, 400);
        assert.equal(erro.codigo, 'ADMINISTRADOR_EMAIL_INVALIDO');
        return true;
      },
    );

    assert.equal(validar.mock.calls.length, 0);
    assert.equal(buscar.mock.calls.length, 0);
    assert.equal(pool.chamadas.connect, 0);
  });

  test('senha fora da política: lança ErroSenhaInvalida com os erros da política, antes de consultar o repositório ou conectar', async (t) => {
    const erros = [{ codigo: 'SENHA_CURTA', mensagem: 'muito curta' }];
    t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: false, erros }));
    const buscar = t.mock.method(administradorRepo, 'buscarPorEmail', async () => null);
    const criar = t.mock.method(administradorRepo, 'criar', async () => administradorCriado);
    const pool = criarPoolFalso(criarClienteFalso());

    await assert.rejects(
      () => criarInicial(pool, { email: EMAIL, senha: '123' }),
      (erro) => {
        assert.ok(erro instanceof ErroSenhaInvalida);
        assert.deepEqual(erro.erros, erros);
        return true;
      },
    );

    assert.equal(buscar.mock.calls.length, 0);
    assert.equal(criar.mock.calls.length, 0);
    assert.equal(pool.chamadas.connect, 0);
  });
});

describe('administrador-plataforma.service — contrato do módulo', () => {
  test('exporta somente criarInicial e ErroSenhaInvalida: nenhum endpoint HTTP, nenhuma rota', () => {
    const modulo = require('../../src/services/administrador-plataforma.service');
    assert.deepEqual(Object.keys(modulo).sort(), ['ErroSenhaInvalida', 'criarInicial']);
  });
});
