'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const crypto = require('node:crypto');

const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const { autenticar } = require('../../src/services/login-plataforma.service');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const { HttpError } = require('../../src/errors/HttpError');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

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
    // 049 e 052: fatores e desafios do MFA (a 052 depende também de 028).
    contexto = await abrirPoolTemporario(['000', '027', '028', '030', '049', '052']);
    administradorId = await inserirAdministrador(contexto.pool, emailPrincipal);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('login válido: desafio LIBERACAO aberto, nenhuma sessão criada, token só em memória', async () => {
    const resultado = await autenticar(contexto.pool, { email: emailPrincipal, senha: SENHA_CORRETA });

    assert.deepEqual(Object.keys(resultado).sort(), ['desafio', 'token']);
    assert.equal(resultado.desafio.etapa, 'LIBERACAO');
    assert.equal(resultado.desafio.validadeMinutos, authConfig.desafioMfa.cadastroMinutos);
    assert.match(resultado.token, /^[A-Za-z0-9_-]{43}$/);

    const { rows: sessoes } = await contexto.pool.query('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1', [administradorId]);
    assert.equal(sessoes[0].n, 0, 'senha correta não cria sessão');

    const { rows } = await contexto.pool.query('SELECT * FROM desafios_mfa_plataforma WHERE token_hash = $1', [sha256(resultado.token)]);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].tipo, rows[0].administrador_id, rows[0].encerrado_em], ['LIBERACAO', administradorId, null]);
    assert.deepEqual(rows[0].expira_em, resultado.desafio.expiraEm);
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

  describe('limite de 5 desafios abertos por administrador', () => {
    const desafiosDe = async (id) => (await contexto.pool.query(
      `SELECT id, token_hash, criado_em, encerrado_em, motivo_encerramento
         FROM desafios_mfa_plataforma WHERE administrador_id = $1 ORDER BY criado_em, id`,
      [id],
    )).rows;

    test('sequencial: 7 logins válidos deixam exatamente 5 abertos; os 2 mais antigos saem por LIMITE_DESAFIOS', async () => {
      const email = 'limite.sequencial@safework.com.br';
      const id = await inserirAdministrador(contexto.pool, email);

      for (let i = 0; i < 7; i += 1) {
        await autenticar(contexto.pool, { email, senha: SENHA_CORRETA });
      }

      const linhas = await desafiosDe(id);
      assert.equal(linhas.length, 7);
      assert.deepEqual(linhas.map((l) => l.encerrado_em === null), [false, false, true, true, true, true, true]);
      assert.deepEqual(linhas.slice(0, 2).map((l) => l.motivo_encerramento), ['LIMITE_DESAFIOS', 'LIMITE_DESAFIOS']);
    });

    test('concorrente: partindo de 4 abertos, 10 logins simultâneos terminam com exatamente 5; cada desafio devolvido estava aberto no seu COMMIT', async () => {
      const email = 'limite.concorrente@safework.com.br';
      const id = await inserirAdministrador(contexto.pool, email);
      for (let i = 0; i < 4; i += 1) {
        await desafioRepo.criar(contexto.pool, {
          administradorId: id, tokenHash: crypto.randomBytes(32).toString('hex'), tipo: 'LIBERACAO', validadeMinutos: 15,
        });
      }

      const resultados = await Promise.allSettled(Array.from({ length: 10 }, () => autenticar(contexto.pool, { email, senha: SENHA_CORRETA })));

      assert.ok(resultados.every((r) => r.status === 'fulfilled'), 'todos os logins válidos respondem com desafio');
      const linhas = await desafiosDe(id);
      assert.equal(linhas.length, 14);
      assert.equal(linhas.filter((l) => l.encerrado_em === null).length, 5, 'nunca mais de 5 abertos');
      assert.deepEqual(linhas.slice(-5).map((l) => l.encerrado_em), [null, null, null, null, null], 'os abertos são os 5 mais novos');

      const porHash = new Map(linhas.map((l, i) => [l.token_hash, i]));
      for (const { value } of resultados) {
        assert.ok(porHash.has(sha256(value.token)), 'cada resposta corresponde a um desafio persistido deste administrador');
      }
      // Serializadas pela trava, a transação que cria o desafio k só encerra
      // o desafio k-5, depois que a do k-1 já fez COMMIT. Então nenhum
      // desafio é encerrado na própria transação: estava aberto no COMMIT.
      // A comparação fica no banco: Date do JavaScript perde os microssegundos,
      // e encerrar k-5 e criar k acontecem na mesma transação.
      const { rows: janelas } = await contexto.pool.query(
        `SELECT motivo_encerramento,
                encerrado_em > lead(criado_em, 4) OVER w AS depois_do_commit_anterior,
                encerrado_em < lead(criado_em, 5) OVER w AS antes_do_proximo
           FROM desafios_mfa_plataforma
          WHERE administrador_id = $1
         WINDOW w AS (ORDER BY criado_em, id)
          ORDER BY criado_em, id`,
        [id],
      );
      for (let i = 0; i < janelas.length - 5; i += 1) {
        assert.equal(janelas[i].motivo_encerramento, 'LIMITE_DESAFIOS');
        assert.equal(janelas[i].depois_do_commit_anterior, true, `desafio ${i} encerrado depois do COMMIT do ${i + 4}`);
        assert.equal(janelas[i].antes_do_proximo, true, `desafio ${i} encerrado antes de nascer o ${i + 5}`);
      }
    });
  });

  describe('trava do administrador', () => {
    // Só este bloco usa o serviço e a trava diretamente.
    let desafioMfaService;
    let trava;
    before(() => {
      desafioMfaService = require('../../src/services/desafio-mfa-plataforma.service');
      trava = require('../../src/repositories/trava-mfa-plataforma.repository');
    });

    async function abrirTransacao() {
      const cliente = await contexto.pool.connect();
      await cliente.query('BEGIN');
      const pid = (await cliente.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return {
        cliente,
        pid,
        async fim(acao) { try { await cliente.query(acao); } finally { cliente.release(); } },
      };
    }

    test('serializa a abertura de desafios do mesmo administrador mesmo sem a trava do e-mail; outro administrador não espera', async () => {
      const id = await inserirAdministrador(contexto.pool, 'trava.a@safework.com.br');
      const outro = await inserirAdministrador(contexto.pool, 'trava.b@safework.com.br');
      const t1 = await abrirTransacao();
      const t2 = await abrirTransacao();
      const t3 = await abrirTransacao();
      try {
        await desafioMfaService.abrirDesafioAposSenha(t1.cliente, { administradorId: id });

        await t3.cliente.query("SET LOCAL lock_timeout = '2s'");
        await desafioMfaService.abrirDesafioAposSenha(t3.cliente, { administradorId: outro });
        await t3.fim('COMMIT');

        const segundo = desafioMfaService.abrirDesafioAposSenha(t2.cliente, { administradorId: id });
        await aguardarEsperaPeloLock(contexto.pool, t2.pid);
        await t1.fim('COMMIT');
        await segundo;
        await t2.fim('COMMIT');
      } catch (erro) {
        for (const t of [t1, t2, t3]) await t.fim('ROLLBACK').catch(() => {});
        throw erro;
      }
      const { rows } = await contexto.pool.query(
        'SELECT count(*)::int AS n FROM desafios_mfa_plataforma WHERE administrador_id = $1 AND encerrado_em IS NULL',
        [id],
      );
      assert.equal(rows[0].n, 2);
    });

    test('o espaço de duas chaves não colide com a forma bigint usada pelo cooldown, nem com o mesmo valor numérico', async () => {
      const id = await inserirAdministrador(contexto.pool, 'trava.espaco@safework.com.br');
      const mesmoNumero = ((BigInt(trava.ESPACO_TRAVA_ADMINISTRADOR_MFA) << 32n) | BigInt(id)).toString();
      const t1 = await abrirTransacao();
      const t2 = await abrirTransacao();
      const t3 = await abrirTransacao();
      try {
        await t1.cliente.query('SELECT pg_advisory_xact_lock($1::bigint)', [mesmoNumero]);

        await t2.cliente.query("SET LOCAL lock_timeout = '2s'");
        await trava.travarAdministrador(t2.cliente, id);

        await t3.cliente.query("SET LOCAL lock_timeout = '200ms'");
        const bigintOcupado = await t3.cliente.query('SELECT pg_advisory_xact_lock($1::bigint)', [mesmoNumero]).then(() => null, (e) => e);
        assert.equal(bigintOcupado?.code, '55P03', 'controle: a trava bigint está mesmo ocupada');
      } finally {
        for (const t of [t1, t2, t3]) await t.fim('ROLLBACK').catch(() => {});
      }
    });
  });
});
