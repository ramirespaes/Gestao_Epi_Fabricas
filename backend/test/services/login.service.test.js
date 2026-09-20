'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { autenticar } = require('../../src/services/login.service');
const empresaRepo = require('../../src/repositories/empresa.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const loginTentativaRepo = require('../../src/repositories/login-tentativa.repository');
const password = require('../../src/security/password');
const { HttpError } = require('../../src/errors/HttpError');
const { authConfig } = require('../../src/config/auth');

/**
 * Testes unitários do serviço de login, sem PostgreSQL real.
 *
 * As quatro funções de repositório e as duas de verificação de senha são
 * substituídas via t.mock.method (restaurado automaticamente ao fim de cada
 * teste). Só as chamadas que o SERVIÇO faz diretamente ao cliente — BEGIN,
 * advisory lock, SELECT clock_timestamp(), COMMIT/ROLLBACK — passam pelo
 * cliente falso abaixo; nenhuma consulta de repositório chega a ele, porque
 * as funções mockadas nunca delegam ao client.query() real.
 *
 * `login.service.js` chama módulos por `modulo.funcao(...)`, nunca
 * desestruturado — é o que torna mock.method eficaz aqui.
 */

const CNPJ = '12345678000195';
const EMAIL = 'ana.souza@demo.safeworkengenharia.com.br';
const SENHA = 'uma-senha-de-teste-qualquer';
const EMPRESA_ID = 42;
const USUARIO_ID = 7;
const SESSAO_ID = '555';
const AGORA_FIXO = new Date('2026-09-20T12:00:00.000Z');

const empresaAtiva = Object.freeze({ id: EMPRESA_ID, nome: 'Empresa Teste', cnpj: CNPJ, ativo: true });
const empresaInativa = Object.freeze({ ...empresaAtiva, ativo: false });

const usuarioBase = Object.freeze({
  id: USUARIO_ID, empresa_id: EMPRESA_ID, nome: 'Ana Souza', email: EMAIL,
  perfil: 'ADMINISTRADOR', biometria_cadastrada: false,
  senha_hash: '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaHNpbnRldGljbw',
});
const usuarioAtivo = Object.freeze({ ...usuarioBase, ativo: true });
const usuarioInativo = Object.freeze({ ...usuarioBase, ativo: false });

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

/** Conta quantas vezes o texto de uma chamada bate com o padrão dado. */
function contar(chamadas, padrao) {
  return chamadas.filter((texto) => padrao.test(texto)).length;
}

describe('autenticar — login válido', () => {
  test('registra a tentativa como sucesso e cria a sessão', async (t) => {
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    const registrar = t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
    const criarSessao = t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    const resultado = await autenticar(pool, { cnpj: CNPJ, email: EMAIL, senha: SENHA });

    assert.equal(resultado.usuario.id, USUARIO_ID);
    assert.equal(resultado.empresa.id, EMPRESA_ID);
    assert.equal(resultado.sessao.id, SESSAO_ID);
    assert.match(resultado.token, /^[A-Za-z0-9_-]{43}$/);

    assert.equal(registrar.mock.calls.length, 1);
    assert.equal(registrar.mock.calls[0].arguments[1].sucesso, true);
    assert.equal(registrar.mock.calls[0].arguments[1].empresaId, EMPRESA_ID);
    assert.equal(registrar.mock.calls[0].arguments[1].usuarioId, USUARIO_ID);

    assert.equal(criarSessao.mock.calls.length, 1);
    const argsCriar = criarSessao.mock.calls[0].arguments[1];
    assert.equal(argsCriar.empresaId, EMPRESA_ID);
    assert.equal(argsCriar.usuarioId, USUARIO_ID);
    assert.equal(argsCriar.autenticadoVia, 'SENHA');
    assert.deepEqual(argsCriar.expiraEm, new Date(AGORA_FIXO.getTime() + authConfig.sessao.expiracaoMinutos * 60_000));

    assert.equal(contar(cliente.chamadas, /^BEGIN$/i), 1);
    assert.equal(contar(cliente.chamadas, /pg_advisory_xact_lock/i), 1);
    assert.equal(contar(cliente.chamadas, /clock_timestamp/i), 1, 'só o instante da sessão precisa ser buscado no caminho de sucesso');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 1);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 0);
    assert.equal(cliente.chamadas.includes('RELEASE'), true);
  });

  test('não confia em empresa_id/usuario_id do cliente: usa sempre os resolvidos pelo repositório', async (t) => {
    const buscarUsuario = t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    await autenticar(criarPoolFalso(criarClienteFalso()), { cnpj: CNPJ, email: EMAIL, senha: SENHA });

    // buscarCredencialPorEmail é chamada com o empresa.id devolvido por
    // buscarPorCnpj — nunca um valor vindo de fora.
    assert.equal(buscarUsuario.mock.calls[0].arguments[1], EMPRESA_ID);
  });
});

describe('autenticar — falhas de credencial, todas com resposta pública genérica', () => {
  const casos = [
    {
      nome: 'senha incorreta',
      motivoEsperado: 'SENHA_INVALIDA',
      setup: (t) => {
        t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
        t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
        const senhaReal = t.mock.method(password, 'verificarSenha', async () => false);
        const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
        return { senhaReal, senhaFicticia, esperaSenhaReal: true, esperaSenhaFicticia: false, empresaId: EMPRESA_ID, usuarioId: USUARIO_ID };
      },
    },
    {
      nome: 'usuário inativo, mesmo com senha correta',
      motivoEsperado: 'USUARIO_INATIVO',
      setup: (t) => {
        t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
        t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioInativo);
        const senhaReal = t.mock.method(password, 'verificarSenha', async () => true);
        const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
        return { senhaReal, senhaFicticia, esperaSenhaReal: true, esperaSenhaFicticia: false, empresaId: EMPRESA_ID, usuarioId: USUARIO_ID };
      },
    },
    {
      nome: 'e-mail inexistente na empresa',
      motivoEsperado: 'EMAIL_INEXISTENTE',
      setup: (t) => {
        t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
        t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => null);
        const senhaReal = t.mock.method(password, 'verificarSenha', async () => true);
        const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
        return { senhaReal, senhaFicticia, esperaSenhaReal: false, esperaSenhaFicticia: true, empresaId: EMPRESA_ID, usuarioId: null };
      },
    },
    {
      nome: 'empresa inativa',
      motivoEsperado: 'EMPRESA_INATIVA',
      setup: (t) => {
        t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaInativa);
        const buscarUsuario = t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
        const senhaReal = t.mock.method(password, 'verificarSenha', async () => true);
        const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
        return {
          senhaReal, senhaFicticia, esperaSenhaReal: false, esperaSenhaFicticia: true,
          empresaId: EMPRESA_ID, usuarioId: null, buscarUsuario,
        };
      },
    },
    {
      nome: 'empresa inexistente',
      motivoEsperado: 'EMPRESA_INEXISTENTE',
      setup: (t) => {
        t.mock.method(empresaRepo, 'buscarPorCnpj', async () => null);
        const buscarUsuario = t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
        const senhaReal = t.mock.method(password, 'verificarSenha', async () => true);
        const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
        return {
          senhaReal, senhaFicticia, esperaSenhaReal: false, esperaSenhaFicticia: true,
          empresaId: null, usuarioId: null, buscarUsuario,
        };
      },
    },
  ];

  for (const caso of casos) {
    test(`${caso.nome}: 401 genérico, motivo ${caso.motivoEsperado} persistido, sem sessão`, async (t) => {
      const contexto = caso.setup(t);
      t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
      const registrar = t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
      const contarFalhas = t.mock.method(loginTentativaRepo, 'contarFalhasRecentes', async () => 0);
      const criarSessao = t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

      const cliente = criarClienteFalso();
      const pool = criarPoolFalso(cliente);

      await assert.rejects(
        () => autenticar(pool, { cnpj: CNPJ, email: EMAIL, senha: SENHA }),
        (erro) => {
          assert.ok(HttpError.ehHttpError(erro));
          assert.equal(erro.status, 401);
          assert.equal(erro.codigo, 'CREDENCIAIS_INVALIDAS');
          assert.equal(erro.message, 'CNPJ, e-mail ou senha inválidos');
          return true;
        },
      );

      assert.equal(registrar.mock.calls.length, 1);
      const args = registrar.mock.calls[0].arguments[1];
      assert.equal(args.sucesso, false);
      assert.equal(args.motivo, caso.motivoEsperado);
      assert.equal(args.empresaId, contexto.empresaId);
      assert.equal(args.usuarioId, contexto.usuarioId);

      assert.equal(contexto.senhaReal.mock.calls.length, contexto.esperaSenhaReal ? 1 : 0);
      assert.equal(contexto.senhaFicticia.mock.calls.length, contexto.esperaSenhaFicticia ? 1 : 0);
      if (contexto.buscarUsuario) {
        assert.equal(contexto.buscarUsuario.mock.calls.length, 0, 'empresa inexistente/inativa não deve nem consultar o usuário');
      }

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
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => ({ ativoAte }));
    const buscarEmpresa = t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    const senhaReal = t.mock.method(password, 'verificarSenha', async () => true);
    const senhaFicticia = t.mock.method(password, 'verificarSenhaContraFicticio', async () => false);
    const registrar = t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => autenticar(pool, { cnpj: CNPJ, email: EMAIL, senha: SENHA }),
      (erro) => {
        assert.ok(HttpError.ehHttpError(erro));
        assert.equal(erro.status, 429);
        assert.equal(erro.codigo, 'LOGIN_EM_COOLDOWN');
        assert.ok(erro.headers['Retry-After']);
        assert.ok(Number(erro.headers['Retry-After']) > 0);
        return true;
      },
    );

    assert.equal(buscarEmpresa.mock.calls.length, 0, 'durante cooldown, nem a identidade precisa ser resolvida');
    assert.equal(senhaReal.mock.calls.length, 0);
    assert.equal(senhaFicticia.mock.calls.length, 0);
    assert.equal(registrar.mock.calls.length, 0, 'tentativa feita durante cooldown não gera nova linha');
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 1);
  });
});

describe('autenticar — ativação de cooldown', () => {
  test('nível 1: ativa com a duração do primeiro nível ao cruzar o limiar de 15 min', async (t) => {
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(password, 'verificarSenha', async () => false);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
    const ativar = t.mock.method(loginTentativaRepo, 'registrarAtivacaoCooldown', async () => '2');

    let chamada = 0;
    t.mock.method(loginTentativaRepo, 'contarFalhasRecentes', async () => {
      chamada += 1;
      return chamada === 1 ? 5 : 1; // nível 1 (5/15min) cruzado; nível 2 (10/60min) não
    });

    await assert.rejects(() => autenticar(criarPoolFalso(criarClienteFalso()), { cnpj: CNPJ, email: EMAIL, senha: SENHA }));

    assert.equal(ativar.mock.calls.length, 1);
    const cooldownAte = ativar.mock.calls[0].arguments[1].cooldownAte;
    assert.deepEqual(cooldownAte, new Date(AGORA_FIXO.getTime() + 15 * 60_000));
  });

  test('nível 2: ativa com a duração do segundo nível quando ele também é cruzado', async (t) => {
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(password, 'verificarSenha', async () => false);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
    const ativar = t.mock.method(loginTentativaRepo, 'registrarAtivacaoCooldown', async () => '2');

    let chamada = 0;
    t.mock.method(loginTentativaRepo, 'contarFalhasRecentes', async () => {
      chamada += 1;
      return chamada === 1 ? 5 : 10; // ambos os níveis cruzados
    });

    await assert.rejects(() => autenticar(criarPoolFalso(criarClienteFalso()), { cnpj: CNPJ, email: EMAIL, senha: SENHA }));

    assert.equal(ativar.mock.calls.length, 1);
    const cooldownAte = ativar.mock.calls[0].arguments[1].cooldownAte;
    assert.deepEqual(
      cooldownAte, new Date(AGORA_FIXO.getTime() + 60 * 60_000),
      'quando os dois níveis são cruzados, prevalece a duração mais longa',
    );
  });

  test('sem cruzar nenhum limiar, não ativa cooldown', async (t) => {
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(password, 'verificarSenha', async () => false);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(loginTentativaRepo, 'contarFalhasRecentes', async () => 1);
    const ativar = t.mock.method(loginTentativaRepo, 'registrarAtivacaoCooldown', async () => '2');

    await assert.rejects(() => autenticar(criarPoolFalso(criarClienteFalso()), { cnpj: CNPJ, email: EMAIL, senha: SENHA }));

    assert.equal(ativar.mock.calls.length, 0);
  });
});

describe('autenticar — falha ao persistir a sessão', () => {
  test('ROLLBACK, libera a conexão, e nunca retorna sucesso', async (t) => {
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
    const erroDeSessao = new Error('violação simulada em sessoes');
    t.mock.method(sessaoRepo, 'criar', async () => { throw erroDeSessao; });

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => autenticar(pool, { cnpj: CNPJ, email: EMAIL, senha: SENHA }),
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
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    const erroInesperado = new Error('conexão perdida com o banco');
    t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => { throw erroInesperado; });
    const criarSessao = t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => autenticar(pool, { cnpj: CNPJ, email: EMAIL, senha: SENHA }),
      (erro) => erro === erroInesperado,
    );

    assert.equal(criarSessao.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/i), 0);
    assert.equal(cliente.chamadas.includes('RELEASE'), true);
  });

  test('HashSenhaCorrompidoError propaga como erro de integridade, sem novo motivo de tentativa', async (t) => {
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    const erroDeHash = new password.HashSenhaCorrompidoError();
    t.mock.method(password, 'verificarSenha', async () => { throw erroDeHash; });
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    const registrar = t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');

    const cliente = criarClienteFalso();
    const pool = criarPoolFalso(cliente);

    await assert.rejects(
      () => autenticar(pool, { cnpj: CNPJ, email: EMAIL, senha: SENHA }),
      (erro) => erro === erroDeHash,
    );

    assert.equal(registrar.mock.calls.length, 0, 'nenhuma linha é gravada para um hash corrompido nesta etapa');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/i), 1);
  });
});

describe('autenticar — entradas inválidas, recusadas antes de qualquer conexão', () => {
  test('cnpj ou e-mail não normalizável lança antes de pool.connect', async () => {
    const pool = criarPoolFalso(criarClienteFalso());

    await assert.rejects(() => autenticar(pool, { cnpj: 'não é um cnpj', email: EMAIL, senha: SENHA }), TypeError);
    await assert.rejects(() => autenticar(pool, { cnpj: CNPJ, email: 'sem-arroba', senha: SENHA }), TypeError);

    assert.equal(pool.chamadas.connect, 0);
  });

  test('ip/dispositivo: ausência vira null, string longa é truncada, tipo inválido lança', async (t) => {
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    const registrar = t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    const dispositivoLongo = 'X'.repeat(200);
    await autenticar(criarPoolFalso(criarClienteFalso()), {
      cnpj: CNPJ, email: EMAIL, senha: SENHA, ip: undefined, dispositivo: dispositivoLongo,
    });

    const args = registrar.mock.calls[0].arguments[1];
    assert.equal(args.ip, null, 'ausência via undefined');
    assert.equal(args.dispositivo.length, 150);
    assert.equal(args.dispositivo, dispositivoLongo.slice(0, 150));

    registrar.mock.resetCalls();
    await autenticar(criarPoolFalso(criarClienteFalso()), {
      cnpj: CNPJ, email: EMAIL, senha: SENHA, ip: null, dispositivo: '203.0.113.10-navegador-de-teste',
    });
    const args2 = registrar.mock.calls[0].arguments[1];
    assert.equal(args2.ip, null, 'ausência via null literal');
    assert.equal(args2.dispositivo, '203.0.113.10-navegador-de-teste', 'string dentro do limite não é alterada');

    const poolFalso = criarPoolFalso(criarClienteFalso());
    await assert.rejects(
      () => autenticar(poolFalso, { cnpj: CNPJ, email: EMAIL, senha: SENHA, ip: 12345 }),
      TypeError,
    );
    assert.equal(poolFalso.chamadas.connect, 0, 'tipo inválido é recusado antes de conectar');
  });
});

describe('autenticar — ausência de token em claro nos logs', () => {
  test('nenhuma chamada a console.log/console.error recebe o token ou a senha', async (t) => {
    t.mock.method(empresaRepo, 'buscarPorCnpj', async () => empresaAtiva);
    t.mock.method(usuarioRepo, 'buscarCredencialPorEmail', async () => usuarioAtivo);
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(loginTentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(loginTentativaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(sessaoRepo, 'criar', async () => SESSAO_ID);

    const logChamadas = [];
    t.mock.method(console, 'log', (...args) => { logChamadas.push(args); });
    t.mock.method(console, 'error', (...args) => { logChamadas.push(args); });

    const resultado = await autenticar(criarPoolFalso(criarClienteFalso()), { cnpj: CNPJ, email: EMAIL, senha: SENHA });

    const textoDosLogs = JSON.stringify(logChamadas);
    assert.equal(textoDosLogs.includes(resultado.token), false);
    assert.equal(textoDosLogs.includes(SENHA), false);
  });
});
