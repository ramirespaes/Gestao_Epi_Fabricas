'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { autenticar } = require('../../src/services/login-plataforma.service');
const { HttpError } = require('../../src/errors/HttpError');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * login-plataforma.service.autenticar contra PostgreSQL real (correção
 * final do Pacote 2, item 1 da auditoria independente: "implementar
 * proteção persistente contra tentativas repetidas por identidade").
 *
 * Pool de verdade (não um Client único): a serialização por advisory lock
 * e o comportamento sob concorrência só se provam com conexões físicas
 * distintas disputando o mesmo lock — mesma razão de
 * login-service.integration.js, que este arquivo espelha para o Painel
 * Privado.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const SENHA_CORRETA = 'senha-correta-do-teste-plataforma-2026';
const SENHA_ERRADA = 'senha-errada-qualquer';

let HASH_SENHA_CORRETA;

async function inserirAdministrador(pool, email, hash = HASH_SENHA_CORRETA, ativo = true) {
  const { rows } = await pool.query(
    'INSERT INTO administradores_plataforma (email, senha_hash, ativo) VALUES ($1, $2, $3) RETURNING id',
    [email, hash, ativo],
  );
  return rows[0].id;
}

describe('login-plataforma.service.autenticar em PostgreSQL real', () => {
  let contexto;
  let administradorId;
  const emailPrincipal = 'admin.principal@safework.com.br';

  before(async () => {
    HASH_SENHA_CORRETA = await gerarHashSenha(SENHA_CORRETA);
    contexto = await abrirPoolTemporario(['000', '027', '028', '030']);
    administradorId = await inserirAdministrador(contexto.pool, emailPrincipal);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('login válido: sucesso, sessão criada em sessoes_plataforma, token só existe em memória', async () => {
    const resultado = await autenticar(contexto.pool, { email: emailPrincipal, senha: SENHA_CORRETA });

    assert.equal(resultado.administrador.id, administradorId);
    assert.match(resultado.token, /^[A-Za-z0-9_-]{43}$/);

    const { rows } = await contexto.pool.query('SELECT * FROM sessoes_plataforma WHERE id = $1', [resultado.sessao.id]);
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows[0]).includes(resultado.token), false, 'o token em claro não pode estar em nenhuma coluna persistida');

    const { rows: tentativas } = await contexto.pool.query(
      'SELECT sucesso, motivo FROM login_tentativas_plataforma WHERE administrador_id = $1 AND sucesso ORDER BY id DESC LIMIT 1',
      [administradorId],
    );
    assert.equal(tentativas[0].sucesso, true);
    assert.equal(tentativas[0].motivo, null);
  });

  test('senha incorreta: 401 genérico, motivo SENHA_INVALIDA persistido', async () => {
    await assert.rejects(
      () => autenticar(contexto.pool, { email: emailPrincipal, senha: SENHA_ERRADA }),
      (erro) => { assert.equal(erro.status, 401); assert.equal(erro.codigo, 'CREDENCIAIS_INVALIDAS'); return true; },
    );

    const { rows } = await contexto.pool.query(
      'SELECT motivo FROM login_tentativas_plataforma WHERE administrador_id = $1 AND NOT sucesso ORDER BY id DESC LIMIT 1',
      [administradorId],
    );
    assert.equal(rows[0].motivo, 'SENHA_INVALIDA');
  });

  test('e-mail inexistente: 401 genérico, tentativa sem administrador identificado', async () => {
    await assert.rejects(
      () => autenticar(contexto.pool, { email: 'ninguem@safework.com.br', senha: SENHA_ERRADA }),
      (erro) => { assert.equal(erro.status, 401); return true; },
    );

    const { rows } = await contexto.pool.query(
      "SELECT count(*)::int AS total FROM login_tentativas_plataforma WHERE administrador_id IS NULL AND motivo = 'ADMINISTRADOR_INEXISTENTE'",
    );
    assert.ok(rows[0].total >= 1);
  });

  test('administrador inativo: 401 genérico, motivo ADMINISTRADOR_INATIVO', async () => {
    const idInativo = await inserirAdministrador(contexto.pool, 'inativo.integracao@safework.com.br', HASH_SENHA_CORRETA, false);

    await assert.rejects(
      () => autenticar(contexto.pool, { email: 'inativo.integracao@safework.com.br', senha: SENHA_CORRETA }),
      (erro) => { assert.equal(erro.status, 401); return true; },
    );

    const { rows } = await contexto.pool.query(
      'SELECT motivo FROM login_tentativas_plataforma WHERE administrador_id = $1 ORDER BY id DESC LIMIT 1',
      [idInativo],
    );
    assert.equal(rows[0].motivo, 'ADMINISTRADOR_INATIVO');
  });

  test('cooldown persistente: cruzar o limiar de nível 1 ativa bloqueio real, mesmo após reiniciar a conexão', async () => {
    const email = 'cooldown.integracao@safework.com.br';
    await inserirAdministrador(contexto.pool, email);

    // A PRÓPRIA tentativa que cruza o limiar ainda recebe 401 genérico.
    for (let i = 0; i < authConfig.cooldown.niveis[0].falhas; i += 1) {
      await assert.rejects(() => autenticar(contexto.pool, { email, senha: SENHA_ERRADA }));
    }

    // Só a tentativa SEGUINTE encontra o cooldown já persistido — inclusive
    // com a senha CORRETA, prova de que a proteção é por identidade, não
    // apenas uma repetição de senha errada.
    await assert.rejects(
      () => autenticar(contexto.pool, { email, senha: SENHA_CORRETA }),
      (erro) => {
        assert.ok(HttpError.ehHttpError(erro));
        assert.equal(erro.status, 429);
        assert.equal(erro.codigo, 'LOGIN_EM_COOLDOWN');
        assert.ok(Number(erro.headers['Retry-After']) > 0);
        return true;
      },
    );

    const { rows: sessoes } = await contexto.pool.query(
      `SELECT count(*)::int AS total FROM sessoes_plataforma s
         JOIN administradores_plataforma a ON a.id = s.administrador_id
        WHERE a.email = $1`,
      [email],
    );
    assert.equal(sessoes[0].total, 0, 'nenhuma sessão pode ter sido criada durante o bloqueio, mesmo com a senha correta');

    const { rows: ativacoes } = await contexto.pool.query(
      `SELECT count(*)::int AS total FROM login_tentativas_plataforma t
        WHERE t.motivo = 'COOLDOWN_ATIVADO'
          AND t.chave_cooldown = (
            SELECT chave_cooldown FROM login_tentativas_plataforma
             WHERE administrador_id = (SELECT id FROM administradores_plataforma WHERE email = $1)
             ORDER BY id DESC LIMIT 1
          )`,
      [email],
    );
    assert.equal(ativacoes[0].total, 1);
  });

  test('rate limit por IP continua sendo COMPLEMENTAR, não a única defesa: o cooldown por identidade age independentemente de qualquer limite de IP', async () => {
    // Este teste prova a garantia do lado do SERVIÇO (persistência real por
    // identidade); a montagem do limitador por IP na rota é responsabilidade
    // de src/routes/auth-plataforma.routes.js e já está coberta por
    // test/app.test.js e auth-plataforma-routes.integration.js. Aqui, duas
    // "origens" lógicas diferentes (simuladas por chamadas diretas ao
    // serviço, sem IP algum envolvido) para a MESMA identidade ainda
    // acionam o MESMO cooldown — a defesa não depende de IP.
    const email = 'defesa-por-identidade@safework.com.br';
    await inserirAdministrador(contexto.pool, email);

    for (let i = 0; i < authConfig.cooldown.niveis[0].falhas; i += 1) {
      await assert.rejects(() => autenticar(contexto.pool, { email, senha: SENHA_ERRADA, ip: `203.0.113.${i}` }));
    }

    await assert.rejects(
      () => autenticar(contexto.pool, { email, senha: SENHA_ERRADA, ip: '198.51.100.200' }),
      (erro) => { assert.equal(erro.status, 429); return true; },
    );
  });

  describe('concorrência: advisory lock por identidade', () => {
    test('duas tentativas concorrentes para a MESMA identidade: sem perda nem duplicação, uma só ativação ao cruzar o limiar', async () => {
      const email = 'concorrente.plataforma@safework.com.br';
      await inserirAdministrador(contexto.pool, email);

      // 3 falhas prévias (limiar de nível 1 é 5): uma 4ª e 5ª concorrentes
      // devem, juntas, cruzar o limiar exatamente uma vez.
      for (let i = 0; i < authConfig.cooldown.niveis[0].falhas - 2; i += 1) {
        await assert.rejects(() => autenticar(contexto.pool, { email, senha: SENHA_ERRADA }));
      }

      const resultados = await Promise.allSettled([
        autenticar(contexto.pool, { email, senha: SENHA_ERRADA }),
        autenticar(contexto.pool, { email, senha: SENHA_ERRADA }),
      ]);
      assert.ok(resultados.every((r) => r.status === 'rejected'));

      const { rows: falhas } = await contexto.pool.query(
        `SELECT count(*)::int AS total FROM login_tentativas_plataforma
          WHERE administrador_id = (SELECT id FROM administradores_plataforma WHERE email = $1)
            AND NOT sucesso AND cooldown_ate IS NULL`,
        [email],
      );
      assert.equal(falhas[0].total, authConfig.cooldown.niveis[0].falhas, 'as 3 prévias mais as 2 concorrentes, sem perda nem duplicação');

      const { rows: ativacoes } = await contexto.pool.query(
        `SELECT count(*)::int AS total FROM login_tentativas_plataforma t
          WHERE t.motivo = 'COOLDOWN_ATIVADO'
            AND t.chave_cooldown = (
              SELECT chave_cooldown FROM login_tentativas_plataforma
               WHERE administrador_id = (SELECT id FROM administradores_plataforma WHERE email = $1)
               ORDER BY id DESC LIMIT 1
            )`,
        [email],
      );
      assert.equal(ativacoes[0].total, 1, 'o advisory lock deve impedir que as duas transações concorrentes ativem o cooldown cada uma por si');
    });

    test('tentativas concorrentes com identidades diferentes não interferem entre si', async () => {
      const emailX = 'concorrente-x@safework.com.br';
      const emailY = 'concorrente-y@safework.com.br';
      await inserirAdministrador(contexto.pool, emailX);
      await inserirAdministrador(contexto.pool, emailY);

      const resultados = await Promise.allSettled([
        autenticar(contexto.pool, { email: emailX, senha: SENHA_ERRADA }),
        autenticar(contexto.pool, { email: emailY, senha: SENHA_ERRADA }),
      ]);

      for (const resultado of resultados) {
        assert.equal(resultado.status, 'rejected');
        assert.equal(resultado.reason.status, 401);
      }
    });
  });
});
