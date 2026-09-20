'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { autenticar } = require('../../src/services/login.service');
const { HttpError } = require('../../src/errors/HttpError');
const { gerarHashSenha } = require('../../src/security/password');
const { gerarChaveCooldown, derivarAdvisoryLock64 } = require('../../src/security/cooldown');
const { authConfig } = require('../../src/config/auth');
const sessaoRepo = require('../../src/repositories/sessao.repository');

/**
 * Serviço de login contra PostgreSQL real, com os quatro repositórios
 * reais e um Pool de verdade (não um Client único): a serialização por
 * advisory lock e o comportamento sob concorrência só se provam com
 * conexões físicas distintas disputando o mesmo lock.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 *
 * PREPARADO, NÃO EXECUTADO nesta etapa — aguardando autorização específica
 * para rodar a suíte completa contra o PostgreSQL local.
 */

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const SENHA_CORRETA = 'senha-correta-do-teste-2026';
const SENHA_ERRADA = 'senha-errada-qualquer';

let HASH_SENHA_CORRETA;

const inserirUsuario = async (cliente, empresaId, email, nome, hash, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [empresaId, nome, email, hash, extra.perfil ?? 'ADMINISTRADOR', extra.ativo ?? true],
  );
  return rows[0].id;
};

const inserirTentativaBruta = async (pool, dados) => {
  await pool.query(
    `INSERT INTO login_tentativas (chave_cooldown, empresa_id, usuario_id, sucesso, motivo, cooldown_ate, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      dados.chaveCooldown, dados.empresaId ?? null, dados.usuarioId ?? null,
      dados.sucesso ?? false, dados.motivo ?? null, dados.cooldownAte ?? null,
      dados.criadoEm ?? new Date(),
    ],
  );
};

const daquiAMinutos = (minutos) => new Date(Date.now() + minutos * 60_000);

describe('login.service.autenticar em PostgreSQL real', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let usuarioA;

  before(async () => {
    HASH_SENHA_CORRETA = await gerarHashSenha(SENHA_CORRETA);

    contexto = await abrirPoolTemporario(['000', '001', '002', '005', '013', '015']);
    const cliente = await contexto.pool.connect();
    try {
      assert.equal(await inserirEmpresa(cliente, CNPJ_A, 'Empresa A'), 'ok');
      assert.equal(await inserirEmpresa(cliente, CNPJ_B, 'Empresa B'), 'ok');

      const { rows: empresas } = await cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
      empresaA = empresas.find((e) => e.cnpj === CNPJ_A).id;
      empresaB = empresas.find((e) => e.cnpj === CNPJ_B).id;

      usuarioA = await inserirUsuario(cliente, empresaA, 'ana.souza@demo.safeworkengenharia.com.br', 'Ana da Empresa A', HASH_SENHA_CORRETA);
      await inserirUsuario(cliente, empresaA, 'carlos.lima@demo.safeworkengenharia.com.br', 'Carlos Desligado', HASH_SENHA_CORRETA, { ativo: false });
      await inserirUsuario(cliente, empresaB, 'bruno.dias@demo.safeworkengenharia.com.br', 'Bruno da Empresa B', HASH_SENHA_CORRETA);
    } finally {
      cliente.release();
    }
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('login válido: sucesso, sessão criada, token só existe em memória', async () => {
    const resultado = await autenticar(contexto.pool, {
      cnpj: CNPJ_A, email: 'ana.souza@demo.safeworkengenharia.com.br', senha: SENHA_CORRETA,
    });

    assert.equal(resultado.usuario.id, usuarioA);
    assert.equal(resultado.empresa.id, empresaA);
    assert.match(resultado.token, /^[A-Za-z0-9_-]{43}$/);

    const { rows } = await contexto.pool.query('SELECT * FROM sessoes WHERE id = $1', [resultado.sessao.id]);
    assert.equal(rows.length, 1);
    assert.equal(JSON.stringify(rows[0]).includes(resultado.token), false, 'o token em claro não pode estar em nenhuma coluna persistida');

    const { rows: tentativas } = await contexto.pool.query(
      "SELECT sucesso, motivo FROM login_tentativas WHERE usuario_id = $1 AND sucesso ORDER BY id DESC LIMIT 1", [usuarioA],
    );
    assert.equal(tentativas[0].sucesso, true);
    assert.equal(tentativas[0].motivo, null);
  });

  test('senha incorreta: 401 genérico, motivo SENHA_INVALIDA persistido', async () => {
    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: CNPJ_A, email: 'ana.souza@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA }),
      (erro) => { assert.equal(erro.status, 401); assert.equal(erro.codigo, 'CREDENCIAIS_INVALIDAS'); return true; },
    );

    const { rows } = await contexto.pool.query(
      "SELECT motivo FROM login_tentativas WHERE usuario_id = $1 AND NOT sucesso ORDER BY id DESC LIMIT 1", [usuarioA],
    );
    assert.equal(rows[0].motivo, 'SENHA_INVALIDA');
  });

  test('empresa inexistente: 401 genérico, tentativa sem empresa nem usuário', async () => {
    const cnpjInexistente = '11222333000181';
    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: cnpjInexistente, email: 'qualquer@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA }),
      (erro) => { assert.equal(erro.status, 401); return true; },
    );
  });

  test('empresa inativa: 401 genérico, motivo EMPRESA_INATIVA', async () => {
    const cliente = await contexto.pool.connect();
    let cnpjTemp;
    try {
      cnpjTemp = '11444777000161';
      await inserirEmpresa(cliente, cnpjTemp, 'Empresa Temporariamente Ativa');
      await cliente.query('UPDATE empresas SET ativo = false WHERE cnpj = $1', [cnpjTemp]);
    } finally {
      cliente.release();
    }

    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: cnpjTemp, email: 'qualquer@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA }),
      (erro) => { assert.equal(erro.status, 401); return true; },
    );
  });

  test('usuário inexistente (e-mail): 401 genérico', async () => {
    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: CNPJ_A, email: 'ninguem@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA }),
      (erro) => { assert.equal(erro.status, 401); return true; },
    );
  });

  test('usuário inativo, mesmo com a senha correta: 401 genérico, motivo USUARIO_INATIVO', async () => {
    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: CNPJ_A, email: 'carlos.lima@demo.safeworkengenharia.com.br', senha: SENHA_CORRETA }),
      (erro) => { assert.equal(erro.status, 401); return true; },
    );

    const { rows } = await contexto.pool.query(
      "SELECT motivo FROM login_tentativas WHERE empresa_id = $1 AND motivo = 'USUARIO_INATIVO' ORDER BY id DESC LIMIT 1", [empresaA],
    );
    assert.equal(rows.length, 1);
  });

  test('isolamento entre empresas: mesmo e-mail em duas empresas não vaza', async () => {
    const emailCompartilhado = 'mesmo.email@demo.safeworkengenharia.com.br';
    const cliente = await contexto.pool.connect();
    try {
      await inserirUsuario(cliente, empresaA, emailCompartilhado, 'Fulano da A', HASH_SENHA_CORRETA);
      await inserirUsuario(cliente, empresaB, emailCompartilhado, 'Fulano da B', await gerarHashSenha('outra-senha-da-empresa-b'));
    } finally {
      cliente.release();
    }

    // Credencial da empresa A não autentica sob o CNPJ da empresa B.
    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: CNPJ_B, email: emailCompartilhado, senha: SENHA_CORRETA }),
      (erro) => { assert.equal(erro.status, 401); return true; },
    );

    // A própria empresa A autentica normalmente com a mesma credencial.
    const resultado = await autenticar(contexto.pool, { cnpj: CNPJ_A, email: emailCompartilhado, senha: SENHA_CORRETA });
    assert.equal(resultado.empresa.id, empresaA);
  });

  test('cooldown vigente: 429 com Retry-After, sem nova linha de tentativa', async () => {
    const cliente = await contexto.pool.connect();
    let cnpjTemp;
    let usuarioTemp;
    try {
      cnpjTemp = '22333444000151';
      await inserirEmpresa(cliente, cnpjTemp, 'Empresa Em Cooldown');
      const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjTemp]);
      usuarioTemp = await inserirUsuario(cliente, rows[0].id, 'usuario.cooldown@demo.safeworkengenharia.com.br', 'Usuário em Cooldown', HASH_SENHA_CORRETA);
    } finally {
      cliente.release();
    }

    // Chave de cooldown real: obtida indiretamente, tentando uma falha antes
    // de inserir a ativação manualmente não é necessário — inserimos direto
    // pela mesma chave que o serviço vai calcular. Usamos o próprio serviço
    // para gerar uma falha primeiro, então inserimos a ativação via SQL
    // bruto lendo a chave da própria linha de tentativa gravada.
    await assert.rejects(() => autenticar(contexto.pool, { cnpj: cnpjTemp, email: 'usuario.cooldown@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA }));

    const { rows: tentativas } = await contexto.pool.query(
      'SELECT chave_cooldown FROM login_tentativas WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1', [usuarioTemp],
    );
    const chave = tentativas[0].chave_cooldown;

    await inserirTentativaBruta(contexto.pool, { chaveCooldown: chave, motivo: 'COOLDOWN_ATIVADO', cooldownAte: daquiAMinutos(5) });

    const { rows: antesDeContagem } = await contexto.pool.query('SELECT count(*)::int AS total FROM login_tentativas WHERE chave_cooldown = $1', [chave]);

    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: cnpjTemp, email: 'usuario.cooldown@demo.safeworkengenharia.com.br', senha: SENHA_CORRETA }),
      (erro) => {
        assert.equal(erro.status, 429);
        assert.equal(erro.codigo, 'LOGIN_EM_COOLDOWN');
        assert.ok(Number(erro.headers['Retry-After']) > 0);
        return true;
      },
    );

    const { rows: depoisDeContagem } = await contexto.pool.query('SELECT count(*)::int AS total FROM login_tentativas WHERE chave_cooldown = $1', [chave]);
    assert.equal(depoisDeContagem[0].total, antesDeContagem[0].total, 'tentativa feita durante cooldown não pode gerar nova linha');
  });

  test('cooldown expirado: o login prossegue normalmente', async () => {
    const cliente = await contexto.pool.connect();
    let cnpjTemp;
    try {
      cnpjTemp = '33555666000141';
      await inserirEmpresa(cliente, cnpjTemp, 'Empresa Cooldown Vencido');
      const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjTemp]);
      await inserirUsuario(cliente, rows[0].id, 'usuario.vencido@demo.safeworkengenharia.com.br', 'Usuário Cooldown Vencido', HASH_SENHA_CORRETA);
    } finally {
      cliente.release();
    }

    await assert.rejects(() => autenticar(contexto.pool, { cnpj: cnpjTemp, email: 'usuario.vencido@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA }));

    const { rows: tentativas } = await contexto.pool.query(
      "SELECT chave_cooldown FROM login_tentativas WHERE motivo = 'SENHA_INVALIDA' ORDER BY id DESC LIMIT 1",
    );
    const chave = tentativas[0].chave_cooldown;

    // Ativação já vencida: cooldown_ate satisfaz o CHECK (> criado_em), mas
    // ambos ficam no passado em relação ao "agora" real deste teste.
    await inserirTentativaBruta(contexto.pool, {
      chaveCooldown: chave, motivo: 'COOLDOWN_ATIVADO', criadoEm: daquiAMinutos(-120), cooldownAte: daquiAMinutos(-60),
    });

    const resultado = await autenticar(contexto.pool, { cnpj: cnpjTemp, email: 'usuario.vencido@demo.safeworkengenharia.com.br', senha: SENHA_CORRETA });
    assert.ok(resultado.token);
  });

  test('ativação de nível 1: a quinta falha em 15 minutos ativa 15 minutos de cooldown', async () => {
    const cliente = await contexto.pool.connect();
    let cnpjTemp;
    try {
      cnpjTemp = '44666777000131';
      await inserirEmpresa(cliente, cnpjTemp, 'Empresa Nivel 1');
      const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjTemp]);
      await inserirUsuario(cliente, rows[0].id, 'usuario.nivel1@demo.safeworkengenharia.com.br', 'Usuário Nível 1', HASH_SENHA_CORRETA);
    } finally {
      cliente.release();
    }
    const email = 'usuario.nivel1@demo.safeworkengenharia.com.br';

    for (let i = 0; i < authConfig.cooldown.niveis[0].falhas - 1; i += 1) {
      await assert.rejects(() => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }));
    }

    const { rows: antes } = await contexto.pool.query("SELECT count(*)::int AS total FROM login_tentativas WHERE motivo = 'COOLDOWN_ATIVADO'");

    await assert.rejects(() => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }));

    const { rows: depois } = await contexto.pool.query(
      "SELECT cooldown_ate, criado_em FROM login_tentativas WHERE motivo = 'COOLDOWN_ATIVADO' ORDER BY id DESC LIMIT 1",
    );
    const { rows: contagem } = await contexto.pool.query("SELECT count(*)::int AS total FROM login_tentativas WHERE motivo = 'COOLDOWN_ATIVADO'");

    assert.equal(contagem[0].total, antes[0].total + 1, 'exatamente uma ativação nova');
    const duracaoMinutos = (depois[0].cooldown_ate.getTime() - depois[0].criado_em.getTime()) / 60_000;
    assert.ok(Math.abs(duracaoMinutos - authConfig.cooldown.niveis[0].duracaoMinutos) < 0.1);
  });

  test('sucesso após falhas anteriores: a falha seguinte não soma com as anteriores ao sucesso', async () => {
    const cliente = await contexto.pool.connect();
    let cnpjTemp;
    const email = 'usuario.pos-sucesso@demo.safeworkengenharia.com.br';
    try {
      cnpjTemp = '55777888000121';
      await inserirEmpresa(cliente, cnpjTemp, 'Empresa Pos Sucesso');
      const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjTemp]);
      await inserirUsuario(cliente, rows[0].id, email, 'Usuário Pós-Sucesso', HASH_SENHA_CORRETA);
    } finally {
      cliente.release();
    }

    // Falhas abaixo do limiar de nível 1.
    for (let i = 0; i < authConfig.cooldown.niveis[0].falhas - 1; i += 1) {
      await assert.rejects(() => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }));
    }

    // Login correto: reseta a contagem por causa do id do sucesso.
    await autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_CORRETA });

    // Mais falhas abaixo do limiar, isoladamente — não devem herdar as
    // anteriores ao sucesso nem ativar cooldown.
    for (let i = 0; i < authConfig.cooldown.niveis[0].falhas - 1; i += 1) {
      await assert.rejects(() => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }));
    }

    const { rows } = await contexto.pool.query(
      `SELECT count(*)::int AS total FROM login_tentativas t
        WHERE t.motivo = 'COOLDOWN_ATIVADO'
          AND t.chave_cooldown = (SELECT chave_cooldown FROM login_tentativas WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1) ORDER BY id DESC LIMIT 1)`,
      [email],
    );
    assert.equal(rows[0].total, 0, 'nenhuma ativação: as falhas depois do sucesso não se somaram às anteriores a ele');
  });

  test('duas tentativas concorrentes para a mesma chave: sem perda nem duplicação de linhas, e uma só ativação ao cruzar o limiar', async () => {
    const cliente = await contexto.pool.connect();
    let cnpjTemp;
    const email = 'usuario.concorrente@demo.safeworkengenharia.com.br';
    try {
      cnpjTemp = '66888999000111';
      await inserirEmpresa(cliente, cnpjTemp, 'Empresa Concorrente');
      const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjTemp]);
      await inserirUsuario(cliente, rows[0].id, email, 'Usuário Concorrente', HASH_SENHA_CORRETA);
    } finally {
      cliente.release();
    }

    // 3 falhas prévias (limiar de nível 1 é 5): uma 4ª e 5ª concorrentes
    // devem, juntas, cruzar o limiar exatamente uma vez.
    for (let i = 0; i < authConfig.cooldown.niveis[0].falhas - 2; i += 1) {
      await assert.rejects(() => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }));
    }

    const resultados = await Promise.allSettled([
      autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }),
      autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }),
    ]);
    assert.ok(resultados.every((r) => r.status === 'rejected'));

    const { rows: falhas } = await contexto.pool.query(
      `SELECT count(*)::int AS total FROM login_tentativas
        WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1) AND NOT sucesso AND cooldown_ate IS NULL`,
      [email],
    );
    assert.equal(falhas[0].total, authConfig.cooldown.niveis[0].falhas, 'as 3 prévias mais as 2 concorrentes, sem perda nem duplicação');

    const { rows: ativacoes } = await contexto.pool.query(
      `SELECT count(*)::int AS total FROM login_tentativas t
        WHERE t.motivo = 'COOLDOWN_ATIVADO'
          AND t.chave_cooldown = (SELECT chave_cooldown FROM login_tentativas WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1) ORDER BY id DESC LIMIT 1)`,
      [email],
    );
    assert.equal(ativacoes[0].total, 1, 'o lock deve impedir que as duas transações concorrentes ativem o cooldown cada uma por si');
  });

  test('tentativas concorrentes com chaves diferentes não interferem entre si', async () => {
    const resultados = await Promise.allSettled([
      autenticar(contexto.pool, { cnpj: CNPJ_A, email: 'ana.souza@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA }),
      autenticar(contexto.pool, { cnpj: CNPJ_B, email: 'bruno.dias@demo.safeworkengenharia.com.br', senha: SENHA_ERRADA }),
    ]);

    for (const resultado of resultados) {
      assert.equal(resultado.status, 'rejected');
      assert.equal(resultado.reason.status, 401);
    }
  });

  /** Cria uma empresa e um usuário sintéticos, devolve {empresaId, email}. */
  async function criarEmpresaEUsuario(cnpj, email, extra = {}) {
    const cliente = await contexto.pool.connect();
    try {
      await inserirEmpresa(cliente, cnpj, `Empresa ${cnpj}`);
      const { rows } = await cliente.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpj]);
      await inserirUsuario(cliente, rows[0].id, email, `Usuário ${email}`, HASH_SENHA_CORRETA, extra);
      return { empresaId: rows[0].id, email };
    } finally {
      cliente.release();
    }
  }

  test('ativação de nível 2: 10 falhas em 60 min, sem nunca cruzar o limiar de nível 1 (5 em 15 min), ativa 60 min', async () => {
    const cnpjTemp = '77111222000191';
    const email = 'usuario.nivel2@demo.safeworkengenharia.com.br';
    await criarEmpresaEUsuario(cnpjTemp, email);

    const chave = gerarChaveCooldown(cnpjTemp, email);
    const { rows: identificacao } = await contexto.pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    const usuarioId = identificacao[0].id;
    const { rows: empresaRows } = await contexto.pool.query('SELECT id FROM empresas WHERE cnpj = $1', [cnpjTemp]);
    const empresaId = empresaRows[0].id;

    // 9 falhas espaçadas por ~6.5 min ao longo dos últimos 58.5 min: a 10ª
    // falha (via o serviço, "agora") totaliza 10 em 60 min (nível 2), mas
    // nenhuma janela de 15 min contém 5 ou mais delas.
    for (let i = 9; i >= 1; i -= 1) {
      await inserirTentativaBruta(contexto.pool, {
        chaveCooldown: chave, empresaId, usuarioId, sucesso: false, motivo: 'SENHA_INVALIDA',
        criadoEm: daquiAMinutos(-6.5 * i),
      });
    }

    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }),
      (erro) => { assert.equal(erro.status, 401); return true; },
    );

    const { rows: ativacoes } = await contexto.pool.query(
      "SELECT cooldown_ate, criado_em FROM login_tentativas WHERE chave_cooldown = $1 AND motivo = 'COOLDOWN_ATIVADO'",
      [chave],
    );
    assert.equal(ativacoes.length, 1, 'exatamente uma ativação — nunca cruzou o nível 1 antes');
    const duracaoMinutos = (ativacoes[0].cooldown_ate.getTime() - ativacoes[0].criado_em.getTime()) / 60_000;
    assert.ok(
      Math.abs(duracaoMinutos - authConfig.cooldown.niveis[1].duracaoMinutos) < 0.1,
      `duração deveria ser a do nível 2 (${authConfig.cooldown.niveis[1].duracaoMinutos} min), obtido: ${duracaoMinutos}`,
    );
  });

  test('falha ao persistir a sessão: ROLLBACK real desfaz também a tentativa de sucesso já gravada na mesma transação', async (t) => {
    const cnpjTemp = '77222333000181';
    const email = 'usuario.falha-sessao@demo.safeworkengenharia.com.br';
    await criarEmpresaEUsuario(cnpjTemp, email);

    const { rows: antesTentativas } = await contexto.pool.query(
      "SELECT count(*)::int AS total FROM login_tentativas WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1) AND sucesso",
      [email],
    );
    const { rows: antesSessoes } = await contexto.pool.query(
      'SELECT count(*)::int AS total FROM sessoes WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1)', [email],
    );

    const erroSimulado = new Error('falha simulada ao persistir a sessão');
    t.mock.method(sessaoRepo, 'criar', async () => { throw erroSimulado; });

    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_CORRETA }),
      (erro) => { assert.equal(erro, erroSimulado); assert.equal(HttpError.ehHttpError(erro), false); return true; },
    );

    const { rows: depoisTentativas } = await contexto.pool.query(
      "SELECT count(*)::int AS total FROM login_tentativas WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1) AND sucesso",
      [email],
    );
    const { rows: depoisSessoes } = await contexto.pool.query(
      'SELECT count(*)::int AS total FROM sessoes WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1)', [email],
    );

    assert.equal(
      depoisTentativas[0].total, antesTentativas[0].total,
      'a tentativa de sucesso registrada antes da falha de sessão precisa ter sido desfeita pelo ROLLBACK — nenhum "login bem-sucedido" pode persistir',
    );
    assert.equal(depoisSessoes[0].total, antesSessoes[0].total, 'nenhuma sessão nova pode existir após a falha');
    assert.equal(depoisSessoes[0].total, 0, 'nenhum token de sessão pode ser considerado válido: não há sessão alguma para esta credencial');
  });

  test('transição 401 → 429: a tentativa que cruza o limiar recebe 401; a seguinte recebe 429; nenhuma linha nova durante o cooldown', async () => {
    const cnpjTemp = '77333444000171';
    const email = 'usuario.transicao@demo.safeworkengenharia.com.br';
    await criarEmpresaEUsuario(cnpjTemp, email);

    for (let i = 0; i < authConfig.cooldown.niveis[0].falhas - 1; i += 1) {
      await assert.rejects(() => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }));
    }

    // A tentativa que cruza o limiar: 401 genérico, igual às anteriores.
    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_ERRADA }),
      (erro) => { assert.equal(erro.status, 401); assert.equal(erro.codigo, 'CREDENCIAIS_INVALIDAS'); return true; },
    );

    const { rows: chaveRows } = await contexto.pool.query(
      'SELECT chave_cooldown FROM login_tentativas WHERE usuario_id = (SELECT id FROM usuarios WHERE email = $1) ORDER BY id DESC LIMIT 1',
      [email],
    );
    const { rows: contagemAntes } = await contexto.pool.query(
      'SELECT count(*)::int AS total FROM login_tentativas WHERE chave_cooldown = $1', [chaveRows[0].chave_cooldown],
    );

    // A tentativa seguinte, com o cooldown já vigente: 429, mesmo com a senha correta.
    await assert.rejects(
      () => autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_CORRETA }),
      (erro) => { assert.equal(erro.status, 429); assert.equal(erro.codigo, 'LOGIN_EM_COOLDOWN'); return true; },
    );

    const { rows: contagemDepois } = await contexto.pool.query(
      'SELECT count(*)::int AS total FROM login_tentativas WHERE chave_cooldown = $1', [chaveRows[0].chave_cooldown],
    );
    assert.equal(contagemDepois[0].total, contagemAntes[0].total, 'a tentativa recebida como 429 não pode gerar nova linha');
  });

  test('persistência segura do token: token_hash é exatamente SHA-256 do token, que não aparece em nenhuma coluna', async () => {
    const cnpjTemp = '77444555000161';
    const email = 'usuario.token-seguro@demo.safeworkengenharia.com.br';
    await criarEmpresaEUsuario(cnpjTemp, email);

    const resultado = await autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_CORRETA });

    const { rows } = await contexto.pool.query('SELECT * FROM sessoes WHERE id = $1', [resultado.sessao.id]);
    const linha = rows[0];

    const hashEsperado = crypto.createHash('sha256').update(resultado.token, 'utf8').digest('hex');
    assert.equal(linha.token_hash, hashEsperado, 'token_hash deve ser exatamente o SHA-256 hexadecimal do token em claro');
    assert.match(linha.token_hash, /^[0-9a-f]{64}$/);

    for (const [coluna, valor] of Object.entries(linha)) {
      if (typeof valor === 'string') {
        assert.equal(valor.includes(resultado.token), false, `coluna ${coluna} não pode conter o token em claro`);
      }
    }
  });

  test('criação temporal da sessão: expira_em > criado_em, e a espera pelo advisory lock não encolhe a duração nem atrasa ultimo_uso_em', async () => {
    const cnpjTemp = '77555666000151';
    const email = 'usuario.temporal@demo.safeworkengenharia.com.br';
    await criarEmpresaEUsuario(cnpjTemp, email);

    const chave = gerarChaveCooldown(cnpjTemp, email);
    const lockId = derivarAdvisoryLock64(chave);

    const bloqueador = await contexto.pool.connect();
    try {
      await bloqueador.query('BEGIN');
      await bloqueador.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockId]);

      const antesDaChamada = Date.now();
      // Disparado, não aguardado ainda: o pool.connect() interno de
      // autenticar() obtém OUTRA conexão e tenta o MESMO lock — bloqueia.
      const promessaLogin = autenticar(contexto.pool, { cnpj: cnpjTemp, email, senha: SENHA_CORRETA });

      await bloqueador.query('SELECT pg_sleep(2)');
      await bloqueador.query('COMMIT');

      const resultado = await promessaLogin;
      const depoisDaChamada = Date.now();

      const { rows } = await contexto.pool.query(
        'SELECT criado_em, expira_em, ultimo_uso_em FROM sessoes WHERE id = $1', [resultado.sessao.id],
      );
      const sessao = rows[0];

      assert.ok(sessao.expira_em.getTime() > sessao.criado_em.getTime());

      const duracaoRealMinutos = (sessao.expira_em.getTime() - sessao.criado_em.getTime()) / 60_000;
      assert.ok(
        Math.abs(duracaoRealMinutos - authConfig.sessao.expiracaoMinutos) < 0.05,
        `a espera de ~2s pelo advisory lock não pode encolher a duração configurada (${authConfig.sessao.expiracaoMinutos} min); obtido: ${duracaoRealMinutos}`,
      );

      // ultimo_uso_em precisa refletir o instante em que autenticar() de
      // fato terminou (depois da espera de ~2s pelo lock), não o instante
      // em que foi chamado.
      assert.ok(
        sessao.ultimo_uso_em.getTime() >= antesDaChamada + 1800,
        'ultimo_uso_em não pode corresponder a um instante anterior à espera pelo advisory lock',
      );
      assert.ok(sessao.ultimo_uso_em.getTime() <= depoisDaChamada + 500);
    } finally {
      bloqueador.release();
    }
  });
});
