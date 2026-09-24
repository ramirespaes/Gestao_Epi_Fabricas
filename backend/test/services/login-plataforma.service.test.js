'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { autenticar } = require('../../src/services/login-plataforma.service');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const sessaoRepo = require('../../src/repositories/sessao-plataforma.repository');
const loginTentativaPlataformaRepo = require('../../src/repositories/login-tentativa-plataforma.repository');
const password = require('../../src/security/password');
const { HttpError } = require('../../src/errors/HttpError');
const { authConfig } = require('../../src/config/auth');

/**
 * Testes unitários do login do Painel Privado da plataforma, sem
 * PostgreSQL real — mesma técnica de login.service.test.js (a versão
 * empresarial que esta correção final espelha): t.mock.method nas funções
 * de repositório e de senha, restaurado automaticamente ao fim de cada
 * teste. Só as chamadas que o SERVIÇO faz diretamente ao cliente — BEGIN,
 * advisory lock, SELECT clock_timestamp(), COMMIT/ROLLBACK — passam pelo
 * cliente falso abaixo; nenhuma consulta de repositório chega a ele,
 * porque as funções mockadas nunca delegam ao client.query() real.
 *
 * Desde a correção final do Pacote 2 (item 1 da auditoria independente:
 * "implementar proteção persistente contra tentativas repetidas por
 * identidade"), este serviço abre transação própria (antes não abria) —
 * por isso o "pool" de teste agora precisa de connect()/release(), como em
 * login.service.test.js, e não mais um objeto opaco qualquer.
 */

const EMAIL = 'admin@safework.com.br';
const SENHA = 'uma-senha-de-teste-qualquer';
const ADMIN_ID = 9;
const SESSAO_ID = '321';
const AGORA_FIXO = new Date('2026-09-24T12:00:00.000Z');

const administradorBase = Object.freeze({
  id: ADMIN_ID,
  email: EMAIL,
  senhaHash: '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaHNpbnRldGljbw',
  ativo: true,
});
const administradorInativo = Object.freeze({ ...administradorBase, ativo: false });

function criarClienteFalso({ agora = AGORA_FIXO } = {}) {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => {
      chamadas.push(texto);
      if (/clock_timestamp/i.test(texto)) {
        return { rows: [{ agora }] };
      }
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

describe('autenticar — login válido', () => {
  test('registra a tentativa como sucesso, cria a sessão e devolve token/expiração coerentes', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    const registrar = t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
    const criarSessao = t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    const resultado = await autenticar(pool, { email: EMAIL, senha: SENHA });

    assert.deepEqual(resultado.administrador, { id: ADMIN_ID, email: EMAIL });
    assert.equal(resultado.sessao.id, SESSAO_ID);
    assert.match(resultado.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal('empresa' in resultado, false, 'login administrativo nunca devolve empresa alguma');

    assert.equal(registrar.mock.calls.length, 1);
    assert.equal(registrar.mock.calls[0].arguments[1].sucesso, true);
    assert.equal(registrar.mock.calls[0].arguments[1].administradorId, ADMIN_ID);

    assert.equal(criarSessao.mock.calls.length, 1);
    const argsCriar = criarSessao.mock.calls[0].arguments[1];
    assert.equal(argsCriar.administradorId, ADMIN_ID);
    assert.deepEqual(argsCriar.expiraEm, new Date(AGORA_FIXO.getTime() + authConfig.sessao.expiracaoMinutos * 60_000));

    assert.equal(contar(cliente.chamadas, /^BEGIN$/i), 1);
    assert.equal(contar(cliente.chamadas, /pg_advisory_xact_lock/i), 1);
    assert.equal(contar(cliente.chamadas, /clock_timestamp/i), 1, 'só o instante da sessão precisa ser buscado no caminho de sucesso');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 0);
    assert.equal(cliente.chamadas.includes('RELEASE'), true);
  });

  test('e-mail passa por normalizarEmail antes de consultar o repositório', async (t) => {
    const buscar = t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    await autenticar(criarPoolFalso(criarClienteFalso()), { email: '  Admin@SafeWork.com.br  ', senha: SENHA });

    assert.equal(buscar.mock.calls[0].arguments[1], EMAIL);
  });
});

describe('autenticar — falhas de credencial, todas com resposta pública genérica', () => {
  const casos = [
    {
      nome: 'senha incorreta',
      motivoEsperado: 'SENHA_INVALIDA',
      setup: (t) => {
        t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
        const senhaReal = t.mock.method(password, 'verificarSenha', async () => false);
        const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
        return { senhaReal, senhaFicticia, esperaSenhaReal: true, esperaSenhaFicticia: false, administradorId: ADMIN_ID };
      },
    },
    {
      nome: 'administrador inativo, mesmo com senha correta',
      motivoEsperado: 'ADMINISTRADOR_INATIVO',
      setup: (t) => {
        t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorInativo);
        const senhaReal = t.mock.method(password, 'verificarSenha', async () => true);
        const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
        return { senhaReal, senhaFicticia, esperaSenhaReal: true, esperaSenhaFicticia: false, administradorId: ADMIN_ID };
      },
    },
    {
      nome: 'e-mail inexistente',
      motivoEsperado: 'ADMINISTRADOR_INEXISTENTE',
      setup: (t) => {
        const buscar = t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => null);
        const senhaReal = t.mock.method(password, 'verificarSenha', async () => true);
        const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
        return {
          senhaReal, senhaFicticia, esperaSenhaReal: false, esperaSenhaFicticia: true, administradorId: null, buscar,
        };
      },
    },
  ];

  for (const caso of casos) {
    test(`${caso.nome}: 401 genérico, motivo ${caso.motivoEsperado} persistido, sem sessão`, async (t) => {
      const contexto = caso.setup(t);
      t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
      const registrar = t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
      const contarFalhas = t.mock.method(loginTentativaPlataformaRepo, 'contarFalhasRecentes', async () => 0);
      const criarSessao = t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

      const cliente = criarClienteFalso();
      const pool = criarPoolFalso(cliente);

      await assert.rejects(
        () => autenticar(pool, { email: EMAIL, senha: SENHA }),
        (erro) => {
          assert.ok(HttpError.ehHttpError(erro));
          assert.equal(erro.status, 401);
          assert.equal(erro.codigo, 'CREDENCIAIS_INVALIDAS');
          assert.equal(erro.message, 'E-mail ou senha inválidos');
          return true;
        },
      );

      assert.equal(registrar.mock.calls.length, 1);
      const args = registrar.mock.calls[0].arguments[1];
      assert.equal(args.sucesso, false);
      assert.equal(args.motivo, caso.motivoEsperado);
      assert.equal(args.administradorId, contexto.administradorId);

      assert.equal(contexto.senhaReal.mock.calls.length, contexto.esperaSenhaReal ? 1 : 0);
      assert.equal(contexto.senhaFicticia.mock.calls.length, contexto.esperaSenhaFicticia ? 1 : 0);

      assert.equal(criarSessao.mock.calls.length, 0, 'nenhuma sessão pode ser criada numa falha de credencial');
      assert.ok(contarFalhas.mock.calls.length >= 1, 'a contagem de falhas por nível deve rodar após registrar a falha');

      assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 1, 'a tentativa negada precisa ser persistida (COMMIT), não desfeita');
      assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 0);
    });
  }
});

describe('autenticar — cooldown vigente', () => {
  test('não verifica senha nem registra nova tentativa; responde 429 com Retry-After', async (t) => {
    const ativoAte = new Date(Date.now() + 90_000);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => ({ ativoAte }));
    const buscarAdministrador = t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    const senhaReal = t.mock.method(password, 'verificarSenha', async () => true);
    const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
    const registrar = t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => autenticar(pool, { email: EMAIL, senha: SENHA }),
      (erro) => {
        assert.ok(HttpError.ehHttpError(erro));
        assert.equal(erro.status, 429);
        assert.equal(erro.codigo, 'LOGIN_EM_COOLDOWN');
        assert.ok(erro.headers['Retry-After']);
        assert.ok(Number(erro.headers['Retry-After']) > 0);
        return true;
      },
    );

    assert.equal(buscarAdministrador.mock.calls.length, 0, 'durante cooldown, nem a identidade precisa ser resolvida');
    assert.equal(senhaReal.mock.calls.length, 0);
    assert.equal(senhaFicticia.mock.calls.length, 0);
    assert.equal(registrar.mock.calls.length, 0, 'tentativa feita durante cooldown não gera nova linha');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 1);
  });
});

describe('autenticar — ativação de cooldown', () => {
  test('nível 1: ativa com a duração do primeiro nível ao cruzar o limiar de 15 min', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => false);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
    const ativar = t.mock.method(loginTentativaPlataformaRepo, 'registrarAtivacaoCooldown', async () => '2');

    let chamada = 0;
    t.mock.method(loginTentativaPlataformaRepo, 'contarFalhasRecentes', async () => {
      chamada += 1;
      return chamada === 1 ? 5 : 1; // nível 1 (5/15min) cruzado; nível 2 (10/60min) não
    });

    await assert.rejects(() => autenticar(criarPoolFalso(criarClienteFalso()), { email: EMAIL, senha: SENHA }));

    assert.equal(ativar.mock.calls.length, 1);
    const cooldownAte = ativar.mock.calls[0].arguments[1].cooldownAte;
    assert.deepEqual(cooldownAte, new Date(AGORA_FIXO.getTime() + 15 * 60_000));
  });

  test('nível 2: ativa com a duração do segundo nível quando ele também é cruzado', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => false);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
    const ativar = t.mock.method(loginTentativaPlataformaRepo, 'registrarAtivacaoCooldown', async () => '2');

    let chamada = 0;
    t.mock.method(loginTentativaPlataformaRepo, 'contarFalhasRecentes', async () => {
      chamada += 1;
      return chamada === 1 ? 5 : 10; // ambos os níveis cruzados
    });

    await assert.rejects(() => autenticar(criarPoolFalso(criarClienteFalso()), { email: EMAIL, senha: SENHA }));

    assert.equal(ativar.mock.calls.length, 1);
    const cooldownAte = ativar.mock.calls[0].arguments[1].cooldownAte;
    assert.deepEqual(
      cooldownAte, new Date(AGORA_FIXO.getTime() + 60 * 60_000),
      'quando os dois níveis são cruzados, prevalece a duração mais longa',
    );
  });

  test('sem cruzar nenhum limiar, não ativa cooldown', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => false);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(loginTentativaPlataformaRepo, 'contarFalhasRecentes', async () => 1);
    const ativar = t.mock.method(loginTentativaPlataformaRepo, 'registrarAtivacaoCooldown', async () => '2');

    await assert.rejects(() => autenticar(criarPoolFalso(criarClienteFalso()), { email: EMAIL, senha: SENHA }));

    assert.equal(ativar.mock.calls.length, 0);
  });
});

describe('autenticar — falha ao persistir a sessão', () => {
  test('ROLLBACK, libera a conexão, e nunca retorna sucesso', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
    const erroDeSessao = new Error('violação simulada em sessoes_plataforma');
    t.mock.method(sessaoRepo, 'criar', async () => { throw erroDeSessao; });

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => autenticar(pool, { email: EMAIL, senha: SENHA }),
      (erro) => {
        assert.equal(erro, erroDeSessao, 'o erro original deve propagar, não ser mascarado');
        assert.equal(HttpError.ehHttpError(erro), false, 'não é um desfecho de negócio — é um erro inesperado');
        return true;
      },
    );

    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 0);
    assert.equal(cliente.chamadas.includes('RELEASE'), true);
  });
});

describe('autenticar — ROLLBACK em erros inesperados', () => {
  test('erro em qualquer chamada de repositório aciona ROLLBACK e propaga', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    const erroInesperado = new Error('conexão perdida com o banco');
    t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => { throw erroInesperado; });
    const criarSessao = t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => autenticar(pool, { email: EMAIL, senha: SENHA }),
      (erro) => erro === erroInesperado,
    );

    assert.equal(criarSessao.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 0);
    assert.equal(cliente.chamadas.includes('RELEASE'), true);
  });

  test('HashSenhaCorrompidoError propaga como erro de integridade, sem novo motivo de tentativa', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    const erroDeHash = new password.HashSenhaCorrompidoError();
    t.mock.method(password, 'verificarSenha', async () => { throw erroDeHash; });
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    const registrar = t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => autenticar(pool, { email: EMAIL, senha: SENHA }),
      (erro) => erro === erroDeHash,
    );

    assert.equal(registrar.mock.calls.length, 0, 'nenhuma linha é gravada para um hash corrompido nesta etapa');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 1);
  });
});

describe('autenticar — entrada não normalizável, recusada com a mesma resposta pública', () => {
  test('e-mail não normalizável: verifica contra hash fictício, nunca abre transação', async (t) => {
    const buscar = t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    const ficticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
    const pool = criarPoolFalso(criarClienteFalso());

    await assert.rejects(
      () => autenticar(pool, { email: 'sem-arroba', senha: SENHA }),
      (erro) => HttpError.ehHttpError(erro) && erro.status === 401 && erro.codigo === 'CREDENCIAIS_INVALIDAS',
    );

    assert.equal(ficticia.mock.calls.length, 1);
    assert.equal(buscar.mock.calls.length, 0);
    assert.equal(pool.chamadas.connect, 0, 'e-mail não normalizável é recusado antes de qualquer conexão');
  });

  test('ip/dispositivo: ausência vira null, string longa é truncada, tipo inválido lança', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    const registrar = t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    const dispositivoLongo = 'X'.repeat(200);
    await autenticar(criarPoolFalso(criarClienteFalso()), {
      email: EMAIL, senha: SENHA, ip: undefined, dispositivo: dispositivoLongo,
    });

    const args = registrar.mock.calls[0].arguments[1];
    assert.equal(args.ip, null, 'ausência via undefined');
    assert.equal(args.dispositivo.length, 150);
    assert.equal(args.dispositivo, dispositivoLongo.slice(0, 150));

    const poolFalso = criarPoolFalso(criarClienteFalso());
    await assert.rejects(
      () => autenticar(poolFalso, { email: EMAIL, senha: SENHA, ip: 12345 }),
      TypeError,
    );
  });
});

describe('autenticar — ausência de token em claro nos logs', () => {
  test('nenhuma chamada a console.log/console.error recebe o token ou a senha', async (t) => {
    t.mock.method(administradorRepo, 'buscarCredencialPorEmail', async () => administradorBase);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaPlataformaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaPlataformaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    const logChamadas = [];
    t.mock.method(console, 'log', (...args) => { logChamadas.push(args); });
    t.mock.method(console, 'error', (...args) => { logChamadas.push(args); });

    const resultado = await autenticar(criarPoolFalso(criarClienteFalso()), { email: EMAIL, senha: SENHA });

    const textoDosLogs = JSON.stringify(logChamadas);
    assert.equal(textoDosLogs.includes(resultado.token), false);
    assert.equal(textoDosLogs.includes(SENHA), false);
  });
});
