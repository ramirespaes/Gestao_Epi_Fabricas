'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const {
  MOTIVO_COOLDOWN_ATIVADO,
  registrarTentativa,
  registrarAtivacaoCooldown,
  buscarCooldownVigente,
  contarFalhasRecentes,
} = require('../../src/repositories/login-tentativa.repository');

/**
 * Repositório de tentativas de login contra PostgreSQL real (migration 015).
 *
 * A regra "falhas contam só depois do último sucesso da mesma chave" e a
 * distinção entre ativação de cooldown e tentativa comum só se provam com
 * banco: um dublê de executor não avalia GREATEST/subconsulta nem executa
 * as constraints de coerência da migration. Os cenários usam duas chaves de
 * cooldown e duas empresas lado a lado, para que nenhuma consulta escape do
 * filtro por chave nem por empresa.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const HASH_SENHA = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNvbG9naW50ZXN0$aGFzaHNpbnRldGljb2RlbG9naW50ZXN0ZGVtbw';

/** Chaves de cooldown sintéticas: 64 hex, no formato exigido, sem relação com HMAC real. */
const chaveDe = (semente) => crypto.createHash('sha256').update(`cooldown:${semente}`).digest('hex');
const CHAVE_A = chaveDe('empresa-a');
const CHAVE_B = chaveDe('empresa-b');

const daquiAMinutos = (minutos) => new Date(Date.now() + minutos * 60_000);

const inserirUsuario = async (cliente, empresaId, email, nome, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [empresaId, nome, email, HASH_SENHA, extra.perfil ?? 'ADMINISTRADOR', extra.ativo ?? true],
  );
  return rows[0].id;
};

/**
 * Insere uma linha de login_tentativas por SQL direto, com criado_em
 * arbitrário. O repositório não serve para montar os cenários de janela
 * temporal: registrarTentativa e registrarAtivacaoCooldown sempre gravam
 * criado_em = now(), e os testes de contagem por janela e de cooldown
 * vencido exigem controlar esse instante.
 */
const inserirLinha = async (cliente, dados) => {
  const { rows } = await cliente.query(
    `INSERT INTO login_tentativas
       (chave_cooldown, empresa_id, usuario_id, sucesso, motivo, cooldown_ate, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      dados.chaveCooldown, dados.empresaId ?? null, dados.usuarioId ?? null,
      dados.sucesso, dados.motivo ?? null, dados.cooldownAte ?? null,
      dados.criadoEm ?? new Date(),
    ],
  );
  return rows[0].id;
};

/** Envolve o cliente registrando texto e valores de cada consulta. */
const espionar = (cliente) => {
  const chamadas = [];
  return {
    chamadas,
    query(texto, valores) {
      chamadas.push({ texto, valores });
      return cliente.query(texto, valores);
    },
  };
};

describe('repositório de tentativas de login em PostgreSQL real', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let usuarioA;
  let usuarioB;

  before(async () => {
    contexto = await abrirSchemaTemporario(['000', '001', '002', '005', '013', '015']);
    const { cliente } = contexto;

    assert.equal(await inserirEmpresa(cliente, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(cliente, CNPJ_B, 'Empresa B'), 'ok');

    const { rows: empresas } = await cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = empresas.find((e) => e.cnpj === CNPJ_A).id;
    empresaB = empresas.find((e) => e.cnpj === CNPJ_B).id;

    usuarioA = await inserirUsuario(cliente, empresaA, 'ana.souza@demo.safeworkengenharia.com.br', 'Ana da Empresa A');
    usuarioB = await inserirUsuario(cliente, empresaB, 'bruno.dias@demo.safeworkengenharia.com.br', 'Bruno da Empresa B');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('a tabela não possui colunas para CNPJ, e-mail, senha, hash de senha, token ou cookie', async () => {
    // information_schema.columns não é filtrada pelo search_path: sem o
    // table_schema explícito, a consulta enxergaria também colunas de uma
    // login_tentativas homônima em public ou em outro schema temporário
    // paralelo, mascarando uma coluna proibida que exista só ali.
    const { rows } = await contexto.cliente.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'login_tentativas'`,
      [contexto.schema],
    );
    const colunas = rows.map((r) => r.column_name);
    assert.ok(colunas.length > 0, 'a consulta precisa encontrar a tabela no schema temporário desta execução');

    for (const proibida of ['cnpj', 'email', 'senha', 'senha_hash', 'token', 'token_hash', 'cookie']) {
      assert.equal(colunas.includes(proibida), false, `login_tentativas não pode ter a coluna ${proibida}`);
    }
  });

  test('registra tentativa bem-sucedida, vinculada à empresa e ao usuário, com id BIGINT canônico', async () => {
    const id = await registrarTentativa(contexto.cliente, {
      chaveCooldown: CHAVE_A, empresaId: empresaA, usuarioId: usuarioA, sucesso: true,
    });

    assert.match(id, /^[1-9][0-9]*$/, 'contrato de id BIGINT: string decimal canônica');

    const { rows } = await contexto.cliente.query(
      'SELECT empresa_id, usuario_id, sucesso, motivo, cooldown_ate FROM login_tentativas WHERE id = $1', [id],
    );
    assert.equal(rows[0].empresa_id, empresaA);
    assert.equal(rows[0].usuario_id, usuarioA);
    assert.equal(rows[0].sucesso, true);
    assert.equal(rows[0].motivo, null);
    assert.equal(rows[0].cooldown_ate, null);
  });

  test('registra tentativa malsucedida sem nenhuma identificação (EMPRESA_INEXISTENTE)', async () => {
    const id = await registrarTentativa(contexto.cliente, {
      chaveCooldown: CHAVE_A, sucesso: false, motivo: 'EMPRESA_INEXISTENTE',
    });

    const { rows } = await contexto.cliente.query(
      'SELECT empresa_id, usuario_id, sucesso, motivo FROM login_tentativas WHERE id = $1', [id],
    );
    assert.equal(rows[0].empresa_id, null);
    assert.equal(rows[0].usuario_id, null);
    assert.equal(rows[0].sucesso, false);
    assert.equal(rows[0].motivo, 'EMPRESA_INEXISTENTE');
  });

  test('registra tentativa malsucedida com empresa identificada e usuário não (EMAIL_INEXISTENTE)', async () => {
    const id = await registrarTentativa(contexto.cliente, {
      chaveCooldown: CHAVE_A, empresaId: empresaA, sucesso: false, motivo: 'EMAIL_INEXISTENTE',
    });

    const { rows } = await contexto.cliente.query(
      'SELECT empresa_id, usuario_id, motivo FROM login_tentativas WHERE id = $1', [id],
    );
    assert.equal(rows[0].empresa_id, empresaA);
    assert.equal(rows[0].usuario_id, null);
    assert.equal(rows[0].motivo, 'EMAIL_INEXISTENTE');
  });

  test('o banco recusa tentativa vinculando empresa e usuário de contratantes diferentes', async () => {
    await assert.rejects(
      () => registrarTentativa(contexto.cliente, {
        chaveCooldown: CHAVE_A, empresaId: empresaA, usuarioId: usuarioB, sucesso: false, motivo: 'SENHA_INVALIDA',
      }),
      (erro) => {
        // 23503 = foreign_key_violation, vinda de fk_login_tentativas_usuario_mesma_empresa.
        assert.equal(erro.code, '23503');
        assert.match(erro.constraint, /fk_login_tentativas_usuario_mesma_empresa/);
        return true;
      },
    );
  });

  test('registra a ativação de cooldown como linha própria, distinta de uma tentativa comum', async () => {
    const cooldownAte = daquiAMinutos(15);

    const id = await registrarAtivacaoCooldown(contexto.cliente, { chaveCooldown: CHAVE_A, cooldownAte });

    const { rows } = await contexto.cliente.query(
      'SELECT sucesso, motivo, cooldown_ate, empresa_id, usuario_id FROM login_tentativas WHERE id = $1', [id],
    );
    assert.equal(rows[0].sucesso, false);
    assert.equal(rows[0].motivo, MOTIVO_COOLDOWN_ATIVADO);
    assert.deepEqual(rows[0].cooldown_ate, cooldownAte);
    assert.equal(rows[0].empresa_id, null);
    assert.equal(rows[0].usuario_id, null);
  });

  test('buscarCooldownVigente encontra a ativação vigente e ignora ativação já vencida', async () => {
    const chave = chaveDe('cooldown-vigente');

    // Ativação já vencida: cooldown_ate satisfaz o CHECK (> criado_em), mas
    // ambos ficam no passado em relação ao "agora" real do teste.
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: MOTIVO_COOLDOWN_ATIVADO,
      criadoEm: daquiAMinutos(-120), cooldownAte: daquiAMinutos(-60),
    });

    assert.equal(await buscarCooldownVigente(contexto.cliente, chave), null,
      'ativação vencida não pode ser reportada como cooldown vigente');

    const cooldownAte = daquiAMinutos(20);
    await registrarAtivacaoCooldown(contexto.cliente, { chaveCooldown: chave, cooldownAte });

    const vigente = await buscarCooldownVigente(contexto.cliente, chave);
    assert.notEqual(vigente, null);
    assert.deepEqual(vigente.ativoAte, cooldownAte);
  });

  test('contarFalhasRecentes preserva a fronteira temporal da janela e exclui a ativação de cooldown', async () => {
    const chave = chaveDe('contagem-janela');

    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-10),
    });
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-5),
    });
    // Fora da janela de 15 min informada pelo chamador: não deve ser contada.
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-30),
    });
    // Ativação de cooldown recente: não é falha de tentativa, não conta.
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: MOTIVO_COOLDOWN_ATIVADO,
      criadoEm: daquiAMinutos(-8), cooldownAte: daquiAMinutos(7),
    });

    const total = await contarFalhasRecentes(contexto.cliente, chave, daquiAMinutos(-15));
    assert.equal(total, 2);
  });

  test('contarFalhasRecentes desconsidera falhas anteriores ao último sucesso da mesma chave', async () => {
    const chave = chaveDe('contagem-pos-sucesso');

    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-40),
    });
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: true, empresaId: empresaA, usuarioId: usuarioA, criadoEm: daquiAMinutos(-20),
    });
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-5),
    });

    // Janela larga (60 min) alcançaria a falha anterior ao sucesso se a
    // consulta não respeitasse a regra — o total precisa ser 1, não 2.
    const total = await contarFalhasRecentes(contexto.cliente, chave, daquiAMinutos(-60));
    assert.equal(total, 1);
  });

  test('contarFalhasRecentes conta falhas válidas quando não há sucesso anterior', async () => {
    const chave = chaveDe('sem-sucesso-anterior');

    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-10),
    });
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'EMAIL_INEXISTENTE', criadoEm: daquiAMinutos(-3),
    });

    // COALESCE cai para -1 quando max(id) é NULL (nenhum sucesso): as duas
    // falhas dentro da janela devem ser contadas normalmente.
    const total = await contarFalhasRecentes(contexto.cliente, chave, daquiAMinutos(-15));
    assert.equal(total, 2);
  });

  test('contarFalhasRecentes conta falhas dentro da janela mesmo com sucesso anterior à própria janela', async () => {
    const chave = chaveDe('sucesso-antes-da-janela');

    // O sucesso é bem mais antigo que a janela consultada (15 min): ainda
    // assim, seu id é o piso, e as falhas dentro da janela têm id maior.
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: true, empresaId: empresaA, usuarioId: usuarioA, criadoEm: daquiAMinutos(-100),
    });
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-10),
    });
    await inserirLinha(contexto.cliente, {
      chaveCooldown: chave, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-3),
    });

    const total = await contarFalhasRecentes(contexto.cliente, chave, daquiAMinutos(-15));
    assert.equal(total, 2);
  });

  test('sucesso e falha com o mesmo criado_em, na mesma transação: a falha é contada', async () => {
    // now() é estável dentro de uma transação PostgreSQL: instruções entre
    // BEGIN e COMMIT que usam DEFAULT now() recebem o mesmo carimbo. Isso
    // reproduz de forma determinística o empate que, em produção,
    // dependeria de coincidência de microssegundos entre transações
    // distintas serializadas pelo advisory lock da mesma chave.
    const chave = chaveDe('mesmo-instante-sucesso-depois-falha');
    const { cliente } = contexto;

    await cliente.query('BEGIN');
    try {
      await cliente.query(
        `INSERT INTO login_tentativas (chave_cooldown, empresa_id, usuario_id, sucesso) VALUES ($1, $2, $3, true)`,
        [chave, empresaA, usuarioA],
      );
      await cliente.query(
        `INSERT INTO login_tentativas (chave_cooldown, sucesso, motivo) VALUES ($1, false, 'SENHA_INVALIDA')`,
        [chave],
      );
      await cliente.query('COMMIT');
    } catch (erro) {
      await cliente.query('ROLLBACK');
      throw erro;
    }

    const { rows } = await cliente.query(
      'SELECT id, sucesso, criado_em FROM login_tentativas WHERE chave_cooldown = $1 ORDER BY id', [chave],
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows[0].criado_em, rows[1].criado_em,
      'pré-condição do cenário: as duas linhas precisam ter o mesmo criado_em, senão o teste não reproduz o empate',
    );
    assert.equal(rows[0].sucesso, true);
    assert.equal(rows[1].sucesso, false);

    const total = await contarFalhasRecentes(cliente, chave, daquiAMinutos(-60));
    assert.equal(total, 1, 'a falha registrada após o sucesso, mesmo no mesmo instante, precisa ser contada');
  });

  test('falha e sucesso com o mesmo criado_em, na mesma transação: a falha anterior não é contada', async () => {
    const chave = chaveDe('mesmo-instante-falha-depois-sucesso');
    const { cliente } = contexto;

    await cliente.query('BEGIN');
    try {
      await cliente.query(
        `INSERT INTO login_tentativas (chave_cooldown, sucesso, motivo) VALUES ($1, false, 'SENHA_INVALIDA')`,
        [chave],
      );
      await cliente.query(
        `INSERT INTO login_tentativas (chave_cooldown, empresa_id, usuario_id, sucesso) VALUES ($1, $2, $3, true)`,
        [chave, empresaA, usuarioA],
      );
      await cliente.query('COMMIT');
    } catch (erro) {
      await cliente.query('ROLLBACK');
      throw erro;
    }

    const { rows } = await cliente.query(
      'SELECT id, sucesso, criado_em FROM login_tentativas WHERE chave_cooldown = $1 ORDER BY id', [chave],
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows[0].criado_em, rows[1].criado_em,
      'pré-condição do cenário: as duas linhas precisam ter o mesmo criado_em, senão o teste não reproduz o empate',
    );
    assert.equal(rows[0].sucesso, false);
    assert.equal(rows[1].sucesso, true);

    const total = await contarFalhasRecentes(cliente, chave, daquiAMinutos(-60));
    assert.equal(total, 0, 'a falha anterior ao sucesso, mesmo no mesmo instante, não pode ser contada');
  });

  test('chaves de cooldown distintas nunca se misturam na contagem nem no cooldown vigente', async () => {
    const chaveX = chaveDe('isolamento-x');
    const chaveY = chaveDe('isolamento-y');

    await inserirLinha(contexto.cliente, { chaveCooldown: chaveX, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-5) });
    await inserirLinha(contexto.cliente, { chaveCooldown: chaveX, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-3) });
    await inserirLinha(contexto.cliente, { chaveCooldown: chaveY, sucesso: false, motivo: 'SENHA_INVALIDA', criadoEm: daquiAMinutos(-2) });

    assert.equal(await contarFalhasRecentes(contexto.cliente, chaveX, daquiAMinutos(-60)), 2);
    assert.equal(await contarFalhasRecentes(contexto.cliente, chaveY, daquiAMinutos(-60)), 1);

    await registrarAtivacaoCooldown(contexto.cliente, { chaveCooldown: chaveX, cooldownAte: daquiAMinutos(15) });

    assert.notEqual(await buscarCooldownVigente(contexto.cliente, chaveX), null);
    assert.equal(await buscarCooldownVigente(contexto.cliente, chaveY), null,
      'cooldown ativado para uma chave não pode vazar para outra');
  });

  test('entradas inválidas são recusadas antes de qualquer consulta, e as válidas viajam como parâmetro', async () => {
    const executor = espionar(contexto.cliente);
    const chave = chaveDe('validacao-entrada');

    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: 'curta', sucesso: false, motivo: 'SENHA_INVALIDA' }), /chave/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: chave, usuarioId: usuarioA, sucesso: false, motivo: 'SENHA_INVALIDA' }), /empresa/i);
    await assert.rejects(() => registrarTentativa(executor, { chaveCooldown: chave, sucesso: false }), /motivo/i);
    await assert.rejects(() => registrarAtivacaoCooldown(executor, { chaveCooldown: chave, cooldownAte: 'amanhã' }), /data/i);
    await assert.rejects(() => buscarCooldownVigente(executor, 'curta'), /chave/i);
    await assert.rejects(() => contarFalhasRecentes(executor, chave, 'ontem'), /data/i);

    assert.equal(executor.chamadas.length, 0, 'entrada inválida não pode chegar ao PostgreSQL');

    await contarFalhasRecentes(executor, chave, daquiAMinutos(-15));

    assert.equal(executor.chamadas.length, 1);
    const { texto, valores } = executor.chamadas[0];
    assert.equal(texto.includes(chave), false, 'a chave não pode ser concatenada no SQL');
    assert.match(texto, /\$1/);
    assert.match(texto, /\$2/);
    assert.equal(valores[0], chave);
  });
});
