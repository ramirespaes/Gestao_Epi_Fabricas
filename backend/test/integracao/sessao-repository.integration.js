'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const empresas = require('../../src/repositories/empresa.repository');
const sessoes = require('../../src/repositories/sessao.repository');

/**
 * Repositório de sessões contra PostgreSQL real.
 *
 * Os critérios de validade de uma sessão vivem dentro da consulta, não em
 * código que examina a linha depois. Isso só se prova com banco: dublê de
 * executor não avalia `now()`, não aplica INTERVAL e não executa a chave
 * estrangeira composta que impede vincular sessão a usuário de outra
 * contratante. Cada critério é derrubado isoladamente, com as demais
 * condições mantidas válidas, para que a falha de um teste aponte a
 * cláusula exata que se perdeu.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const CNPJ_C = '11222333000181';
const MINUTOS_INATIVIDADE = 30;

// Hash sintético no formato do Argon2id, sem correspondência com senha
// alguma. Existe para provar que ele não escapa pela consulta de sessão.
const HASH_SENHA = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNvc2Vzc2FvdGVzdA$aGFzaHNpbnRldGljb2Rlc2Vzc2FvZGVtbw';

// O token em claro nasce e morre aqui, como nasceria na camada de emissão:
// o banco recebe apenas o digest. Guardamos o valor original só para provar
// que ele não reaparece em nenhum resultado.
const TOKEN_EM_CLARO = crypto.randomBytes(32).toString('base64url');
const HASH_DO_TOKEN = crypto.createHash('sha256').update(TOKEN_EM_CLARO).digest('hex');

/** Hashes distintos e estáveis por cenário; token_hash é UNIQUE na tabela. */
const hashDe = (semente) => crypto.createHash('sha256').update(`sessao:${semente}`).digest('hex');

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
 * Insere sessão por SQL direto, com datas arbitrárias. O repositório não
 * serve para montar os cenários vencidos: `criar` grava criado_em = now(),
 * e a constraint chk_sessoes_expira_apos_criacao recusaria uma expiração no
 * passado. Os cenários de expiração exigem, portanto, inserção controlada.
 */
const inserirSessao = async (cliente, dados) => {
  const { rows } = await cliente.query(
    `INSERT INTO sessoes (empresa_id, usuario_id, token_hash, criado_em, expira_em,
                          ultimo_uso_em, revogada_em, motivo_revogacao)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      dados.empresaId, dados.usuarioId, dados.tokenHash,
      dados.criadoEm ?? daquiAMinutos(-5),
      dados.expiraEm ?? daquiAMinutos(60),
      dados.ultimoUsoEm ?? new Date(),
      dados.revogadaEm ?? null,
      dados.motivoRevogacao ?? null,
    ],
  );
  return rows[0].id;
};

/** Envolve o cliente registrando o texto e os valores de cada consulta. */
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

describe('repositório de sessões em PostgreSQL real', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let empresaC;
  let usuarioA;
  let usuarioB;
  let usuarioInativo;
  let usuarioDaEmpresaInativa;

  before(async () => {
    contexto = await abrirSchemaTemporario(['000', '001', '002', '005', '025', '013', '016']);
    const { cliente } = contexto;

    assert.equal(await inserirEmpresa(cliente, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(cliente, CNPJ_B, 'Empresa B'), 'ok');
    assert.equal(await inserirEmpresa(cliente, CNPJ_C, 'Empresa C'), 'ok');

    empresaA = (await empresas.buscarPorCnpj(cliente, CNPJ_A)).id;
    empresaB = (await empresas.buscarPorCnpj(cliente, CNPJ_B)).id;
    empresaC = (await empresas.buscarPorCnpj(cliente, CNPJ_C)).id;

    usuarioA = await inserirUsuario(cliente, empresaA, 'ana.souza@demo.safeworkengenharia.com.br', 'Ana da Empresa A');
    usuarioB = await inserirUsuario(cliente, empresaB, 'bruno.dias@demo.safeworkengenharia.com.br', 'Bruno da Empresa B');
    usuarioInativo = await inserirUsuario(
      cliente, empresaA, 'carlos.lima@demo.safeworkengenharia.com.br', 'Carlos Desligado', { ativo: false },
    );
    usuarioDaEmpresaInativa = await inserirUsuario(
      cliente, empresaC, 'diana.rocha@demo.safeworkengenharia.com.br', 'Diana da Empresa C',
    );

    // A empresa C só é desativada depois de ter usuário: o cenário exige
    // usuário ativo dentro de empresa inativa, para isolar qual das duas
    // condições da consulta está sendo exercida.
    await cliente.query('UPDATE empresas SET ativo = false WHERE id = $1', [empresaC]);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cria a sessão vinculada à empresa do próprio usuário', async () => {
    const id = await sessoes.criar(contexto.cliente, {
      empresaId: empresaA,
      usuarioId: usuarioA,
      tokenHash: hashDe('criacao'),
      expiraEm: daquiAMinutos(60),
      ip: '203.0.113.10',
      dispositivo: 'navegador de teste',
    });

    // sessoes.id é BIGINT: o contrato do repositório é devolver string
    // decimal canônica, nunca converter para Number (perderia precisão
    // acima de Number.MAX_SAFE_INTEGER).
    assert.match(id, /^[1-9][0-9]*$/);

    const { rows } = await contexto.cliente.query(
      'SELECT empresa_id, usuario_id, autenticado_via, revogada_em FROM sessoes WHERE id = $1', [id],
    );
    assert.equal(rows[0].empresa_id, empresaA);
    assert.equal(rows[0].usuario_id, usuarioA);
    assert.equal(rows[0].autenticado_via, 'SENHA');
    assert.equal(rows[0].revogada_em, null);
  });

  test('o banco recusa sessão apontando para usuário de outra empresa', async () => {
    await assert.rejects(
      () => sessoes.criar(contexto.cliente, {
        empresaId: empresaA,
        usuarioId: usuarioB,
        tokenHash: hashDe('cross-tenant'),
        expiraEm: daquiAMinutos(60),
      }),
      (erro) => {
        // 23503 = foreign_key_violation, vinda de fk_sessoes_usuario_mesma_empresa.
        assert.equal(erro.code, '23503');
        assert.match(erro.constraint, /fk_sessoes_usuario_mesma_empresa/);
        return true;
      },
    );

    const { rows } = await contexto.cliente.query(
      'SELECT count(*)::int AS total FROM sessoes WHERE token_hash = $1', [hashDe('cross-tenant')],
    );
    assert.equal(rows[0].total, 0, 'nenhuma linha pode restar de uma tentativa entre empresas');
  });

  test('recupera a sessão válida pelo hash, com usuário e empresa junto', async () => {
    await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash: HASH_DO_TOKEN,
    });

    const contextoAutenticado = await sessoes.buscarValidaPorHash(
      contexto.cliente, HASH_DO_TOKEN, MINUTOS_INATIVIDADE,
    );

    assert.notEqual(contextoAutenticado, null);
    assert.equal(contextoAutenticado.usuario.id, usuarioA);
    assert.equal(contextoAutenticado.usuario.nome, 'Ana da Empresa A');
    assert.equal(contextoAutenticado.usuario.perfil, 'ADMINISTRADOR');
    assert.equal(contextoAutenticado.empresa.id, empresaA);
    assert.equal(contextoAutenticado.empresa.nome, 'Empresa A');
    assert.equal(contextoAutenticado.empresa.cnpj, CNPJ_A);
    assert.equal(contextoAutenticado.sessao.expiraEm instanceof Date, true);
  });

  test('sessão revogada não é encontrada', async () => {
    const tokenHash = hashDe('revogada');
    await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash,
      revogadaEm: new Date(), motivoRevogacao: 'LOGOUT',
    });

    assert.equal(await sessoes.buscarValidaPorHash(contexto.cliente, tokenHash, MINUTOS_INATIVIDADE), null);
  });

  test('sessão com expiração absoluta vencida não é encontrada, mesmo com uso recente', async () => {
    const tokenHash = hashDe('expirada');
    await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash,
      criadoEm: daquiAMinutos(-120),
      expiraEm: daquiAMinutos(-60),
      ultimoUsoEm: new Date(),
    });

    assert.equal(await sessoes.buscarValidaPorHash(contexto.cliente, tokenHash, MINUTOS_INATIVIDADE), null);
  });

  test('sessão vencida por inatividade não é encontrada, mesmo dentro da validade absoluta', async () => {
    const tokenHash = hashDe('inativa');
    await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash,
      criadoEm: daquiAMinutos(-120),
      expiraEm: daquiAMinutos(600),
      ultimoUsoEm: daquiAMinutos(-(MINUTOS_INATIVIDADE + 1)),
    });

    assert.equal(await sessoes.buscarValidaPorHash(contexto.cliente, tokenHash, MINUTOS_INATIVIDADE), null);
    // A mesma linha volta a ser válida sob uma janela maior: prova que a
    // recusa veio da inatividade, e não de outra condição da consulta.
    assert.notEqual(await sessoes.buscarValidaPorHash(contexto.cliente, tokenHash, MINUTOS_INATIVIDADE * 10), null);
  });

  test('sessão de usuário inativo ou de empresa inativa não é encontrada', async () => {
    const hashUsuarioInativo = hashDe('usuario-inativo');
    const hashEmpresaInativa = hashDe('empresa-inativa');

    await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioInativo, tokenHash: hashUsuarioInativo,
    });
    await inserirSessao(contexto.cliente, {
      empresaId: empresaC, usuarioId: usuarioDaEmpresaInativa, tokenHash: hashEmpresaInativa,
    });

    assert.equal(await sessoes.buscarValidaPorHash(contexto.cliente, hashUsuarioInativo, MINUTOS_INATIVIDADE), null,
      'usuário desligado não pode continuar autenticado');
    assert.equal(await sessoes.buscarValidaPorHash(contexto.cliente, hashEmpresaInativa, MINUTOS_INATIVIDADE), null,
      'empresa inativa não pode ter sessão utilizável');
  });

  test('registrar uso avança ultimo_uso_em de sessão válida e não ressuscita sessão revogada', async () => {
    const tokenHash = hashDe('uso');
    const usoAntigo = daquiAMinutos(-10);
    const id = await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash, ultimoUsoEm: usoAntigo,
    });

    assert.equal(await sessoes.registrarUso(contexto.cliente, id, MINUTOS_INATIVIDADE), true);

    const { rows } = await contexto.cliente.query('SELECT ultimo_uso_em FROM sessoes WHERE id = $1', [id]);
    assert.equal(rows[0].ultimo_uso_em > usoAntigo, true);

    const revogada = await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash: hashDe('uso-revogada'),
      ultimoUsoEm: usoAntigo, revogadaEm: new Date(), motivoRevogacao: 'LOGOUT',
    });
    assert.equal(await sessoes.registrarUso(contexto.cliente, revogada, MINUTOS_INATIVIDADE), false);

    const depois = await contexto.cliente.query('SELECT ultimo_uso_em FROM sessoes WHERE id = $1', [revogada]);
    assert.deepEqual(depois.rows[0].ultimo_uso_em, usoAntigo, 'sessão revogada não pode ter o uso atualizado');
  });

  test('registrar uso não reativa sessão vencida por expiração absoluta', async () => {
    const tokenHash = hashDe('uso-expirada-absoluta');
    const usoAntigo = daquiAMinutos(-90);
    const id = await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash,
      criadoEm: daquiAMinutos(-120),
      expiraEm: daquiAMinutos(-60), // vencida pela expiração absoluta...
      ultimoUsoEm: usoAntigo, // ...mas não pela inatividade, para isolar a causa.
    });

    assert.equal(await sessoes.registrarUso(contexto.cliente, id, MINUTOS_INATIVIDADE), false);

    const { rows } = await contexto.cliente.query('SELECT ultimo_uso_em FROM sessoes WHERE id = $1', [id]);
    assert.deepEqual(rows[0].ultimo_uso_em, usoAntigo, 'sessão vencida pela expiração absoluta não pode ter o uso renovado');
  });

  test('registrar uso não reativa sessão vencida por inatividade', async () => {
    const tokenHash = hashDe('uso-expirada-inatividade');
    const usoAntigo = daquiAMinutos(-(MINUTOS_INATIVIDADE + 1));
    const id = await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash,
      criadoEm: daquiAMinutos(-120),
      expiraEm: daquiAMinutos(600), // longe da expiração absoluta...
      ultimoUsoEm: usoAntigo, // ...mas vencida pela inatividade, para isolar a causa.
    });

    assert.equal(await sessoes.registrarUso(contexto.cliente, id, MINUTOS_INATIVIDADE), false);

    const { rows } = await contexto.cliente.query('SELECT ultimo_uso_em FROM sessoes WHERE id = $1', [id]);
    assert.deepEqual(rows[0].ultimo_uso_em, usoAntigo, 'sessão vencida por inatividade não pode ter o uso renovado');

    // A mesma linha aceita renovação sob uma janela de inatividade maior:
    // prova que a recusa anterior veio da inatividade, não de outra condição.
    assert.equal(await sessoes.registrarUso(contexto.cliente, id, MINUTOS_INATIVIDADE * 10), true);
  });

  test('revogação individual respeita a fronteira da empresa', async () => {
    const tokenHash = hashDe('revogar-individual');
    const id = await inserirSessao(contexto.cliente, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash,
    });

    assert.equal(await sessoes.revogar(contexto.cliente, empresaB, id, 'LOGOUT'), false,
      'outra empresa não pode derrubar sessão alheia conhecendo o identificador');
    assert.notEqual(await sessoes.buscarValidaPorHash(contexto.cliente, tokenHash, MINUTOS_INATIVIDADE), null);

    assert.equal(await sessoes.revogar(contexto.cliente, empresaA, id, 'LOGOUT'), true);
    assert.equal(await sessoes.buscarValidaPorHash(contexto.cliente, tokenHash, MINUTOS_INATIVIDADE), null);

    assert.equal(await sessoes.revogar(contexto.cliente, empresaA, id, 'LOGOUT'), false,
      'revogar de novo não deve alterar linha já revogada');

    const { rows } = await contexto.cliente.query(
      'SELECT revogada_em, motivo_revogacao FROM sessoes WHERE id = $1', [id],
    );
    assert.notEqual(rows[0].revogada_em, null);
    assert.equal(rows[0].motivo_revogacao, 'LOGOUT');
  });

  test('revogação por usuário atinge só as sessões daquele usuário naquela empresa', async () => {
    const hashes = ['global-1', 'global-2'].map(hashDe);
    for (const tokenHash of hashes) {
      await inserirSessao(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, tokenHash });
    }
    const hashDoOutro = hashDe('global-outra-empresa');
    await inserirSessao(contexto.cliente, { empresaId: empresaB, usuarioId: usuarioB, tokenHash: hashDoOutro });

    assert.equal(await sessoes.revogarDoUsuario(contexto.cliente, empresaB, usuarioA, 'TROCA_DE_SENHA'), 0,
      'o par empresa/usuário precisa bater; empresa errada não atinge nada');

    const atingidas = await sessoes.revogarDoUsuario(contexto.cliente, empresaA, usuarioA, 'TROCA_DE_SENHA');
    assert.equal(atingidas >= 2, true);
    for (const tokenHash of hashes) {
      assert.equal(await sessoes.buscarValidaPorHash(contexto.cliente, tokenHash, MINUTOS_INATIVIDADE), null);
    }

    assert.notEqual(await sessoes.buscarValidaPorHash(contexto.cliente, hashDoOutro, MINUTOS_INATIVIDADE), null,
      'sessão de outra empresa não pode ser derrubada por logout global alheio');
    assert.equal(await sessoes.revogarDoUsuario(contexto.cliente, empresaA, usuarioA, 'TROCA_DE_SENHA'), 0);
  });

  test('o resultado não carrega token em claro, hash de token nem hash de senha', async () => {
    const tokenHash = hashDe('projecao');
    const token = crypto.randomBytes(32).toString('base64url');
    await inserirSessao(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, tokenHash });

    const resultado = await sessoes.buscarValidaPorHash(contexto.cliente, tokenHash, MINUTOS_INATIVIDADE);
    const serializado = JSON.stringify(resultado);

    assert.equal(serializado.includes(token), false);
    assert.equal(serializado.includes(TOKEN_EM_CLARO), false);
    assert.equal(serializado.includes(tokenHash), false, 'nem o digest precisa voltar ao chamador');
    assert.equal(serializado.includes('argon2'), false);
    assert.equal(serializado.includes(HASH_SENHA), false);
    assert.deepEqual(Object.keys(resultado).sort(), ['empresa', 'sessao', 'usuario']);
    // identidadeId (Pacote 4): de qual identidade global é este vínculo —
    // null no modelo anterior. Uso interno (o /auth/me público não o expõe).
    assert.deepEqual(Object.keys(resultado.usuario).sort(), ['email', 'id', 'identidadeId', 'nome', 'perfil']);
    assert.equal(resultado.usuario.identidadeId, null, 'vínculo do modelo anterior');
    assert.deepEqual(Object.keys(resultado.sessao).sort(), ['criadoEm', 'expiraEm', 'id', 'ultimoUsoEm']);
  });

  test('entradas inválidas são recusadas antes de qualquer consulta, e as válidas viajam como parâmetro', async () => {
    const executor = espionar(contexto.cliente);

    await assert.rejects(() => sessoes.buscarValidaPorHash(executor, TOKEN_EM_CLARO, MINUTOS_INATIVIDADE), /hash/i);
    await assert.rejects(() => sessoes.buscarValidaPorHash(executor, HASH_DO_TOKEN.toUpperCase(), MINUTOS_INATIVIDADE), /hash/i);
    await assert.rejects(() => sessoes.buscarValidaPorHash(executor, HASH_DO_TOKEN, 0), /inatividade/i);
    // '1' é uma string no formato canônico exigido para sessaoId: o teste
    // aqui mira a validação de motivo, não a de identificador.
    await assert.rejects(() => sessoes.revogar(executor, empresaA, '1', 'logout'), /motivo/i);
    await assert.rejects(() => sessoes.registrarUso(executor, 0, MINUTOS_INATIVIDADE), /sess/i, 'number não é aceito como identificador de sessão');
    await assert.rejects(() => sessoes.registrarUso(executor, '1', 0), /inatividade/i);
    await assert.rejects(() => sessoes.criar(executor, {
      empresaId: empresaA, usuarioId: usuarioA, tokenHash: HASH_DO_TOKEN, expiraEm: 'amanhã',
    }), /data/i);

    assert.equal(executor.chamadas.length, 0, 'entrada inválida não pode chegar ao PostgreSQL');

    await sessoes.buscarValidaPorHash(executor, HASH_DO_TOKEN, MINUTOS_INATIVIDADE);

    assert.equal(executor.chamadas.length, 1);
    const { texto, valores } = executor.chamadas[0];
    assert.equal(texto.includes(HASH_DO_TOKEN), false, 'o hash não pode ser concatenado no SQL');
    assert.equal(texto.includes(String(MINUTOS_INATIVIDADE)), false, 'a janela não pode ser concatenada no SQL');
    assert.deepEqual(valores, [HASH_DO_TOKEN, MINUTOS_INATIVIDADE]);
    assert.match(texto, /\$1/);
    assert.match(texto, /\$2/);
  });
});
