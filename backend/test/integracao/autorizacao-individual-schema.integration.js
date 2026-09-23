'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');

/**
 * Estrutura PostgreSQL das migrations 017-019 (Bloco 8, Incremento 8,
 * Etapa 5A — subetapa 1): dois atributos novos em `acoes`, e as tabelas
 * `vinculo_sst` e `usuario_autorizacoes`.
 *
 * Este arquivo testa exclusivamente estrutura de banco — constraints,
 * FKs compostas, valores de catálogo — nunca repository, middleware ou
 * lógica de autorização (nada disso foi alterado nesta subetapa). As
 * asserções usam o cliente PostgreSQL diretamente, no mesmo padrão de
 * migration-016-cnpj.integration.js.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';

const MIGRATIONS = ['000', '001', '002', '003', '005', '013', '016', '017', '018', '019'];

const inserirUsuario = async (cliente, empresaId, email, perfil = 'ADMINISTRADOR') => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
    [empresaId, 'Usuário Teste', email, '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28', perfil],
  );
  return rows[0].id;
};

/** Executa um INSERT em vinculo_sst e devolve 'ok' ou o SQLSTATE do erro. */
const concederSst = async (cliente, { empresaId, usuarioId, concedidoPor }) => {
  try {
    await cliente.query(
      'INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)',
      [usuarioId, empresaId, concedidoPor],
    );
    return 'ok';
  } catch (erro) {
    return erro.code;
  }
};

/** Executa um INSERT em usuario_autorizacoes e devolve 'ok' ou o SQLSTATE do erro. */
const concederAutorizacao = async (cliente, { empresaId, usuarioId, acaoCodigo, autorizadoPor }) => {
  try {
    await cliente.query(
      'INSERT INTO usuario_autorizacoes (usuario_id, empresa_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)',
      [usuarioId, empresaId, acaoCodigo, autorizadoPor],
    );
    return 'ok';
  } catch (erro) {
    return erro.code;
  }
};

describe('migration 017 — atributos de autorização em acoes', () => {
  let contexto;
  before(async () => { contexto = await abrirSchemaTemporario(MIGRATIONS); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('APROVAR_SOLICITACAO e REPROVAR_SOLICITACAO: exige_sst=true, modo=OBRIGATORIA', async () => {
    const { rows } = await contexto.cliente.query(
      'SELECT codigo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo IN ($1, $2) ORDER BY codigo',
      ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'],
    );
    assert.equal(rows.length, 2);
    for (const linha of rows) {
      assert.equal(linha.exige_sst, true, linha.codigo);
      assert.equal(linha.modo_autorizacao_individual, 'OBRIGATORIA', linha.codigo);
    }
  });

  test('MOVIMENTAR_ESTOQUE e REALIZAR_ENTREGA: exige_sst=false, modo=ALTERNATIVA', async () => {
    const { rows } = await contexto.cliente.query(
      'SELECT codigo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo IN ($1, $2) ORDER BY codigo',
      ['MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA'],
    );
    assert.equal(rows.length, 2);
    for (const linha of rows) {
      assert.equal(linha.exige_sst, false, linha.codigo);
      assert.equal(linha.modo_autorizacao_individual, 'ALTERNATIVA', linha.codigo);
    }
  });

  test('demais ações do catálogo permanecem nos valores padrão (exige_sst=false, modo=NENHUMA)', async () => {
    const { rows } = await contexto.cliente.query(
      `SELECT codigo, exige_sst, modo_autorizacao_individual FROM acoes
        WHERE codigo NOT IN ('APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA')`,
    );
    assert.ok(rows.length > 0, 'deveria haver outras ações no catálogo além das quatro alteradas');
    for (const linha of rows) {
      assert.equal(linha.exige_sst, false, linha.codigo);
      assert.equal(linha.modo_autorizacao_individual, 'NENHUMA', linha.codigo);
    }
  });

  test('CHECK rejeita um modo_autorizacao_individual fora dos três valores aceitos', async () => {
    await assert.rejects(
      () => contexto.cliente.query(
        "INSERT INTO acoes (codigo, nome, modo_autorizacao_individual) VALUES ('ACAO_SINTETICA_1', 'Sintética', 'QUALQUER_COISA')",
      ),
      (erro) => erro.code === VIOLACAO_CHECK,
    );
  });

  test('nova ação sem especificar os campos novos recebe os padrões seguros (false / NENHUMA)', async () => {
    await contexto.cliente.query("INSERT INTO acoes (codigo, nome) VALUES ('ACAO_SINTETICA_2', 'Sintética 2')");
    const { rows } = await contexto.cliente.query(
      "SELECT exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo = 'ACAO_SINTETICA_2'",
    );
    assert.equal(rows[0].exige_sst, false);
    assert.equal(rows[0].modo_autorizacao_individual, 'NENHUMA');
  });
});

describe('migration 018 — vinculo_sst', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let usuarioA;
  let usuarioB;
  let outroUsuarioA;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    assert.equal(await inserirEmpresa(contexto.cliente, '12345678000195', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, '98765432000110', 'Empresa B'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '12345678000195').id;
    empresaB = rows.find((e) => e.cnpj === '98765432000110').id;

    usuarioA = await inserirUsuario(contexto.cliente, empresaA, 'sst-a@demo.safeworkengenharia.com.br');
    outroUsuarioA = await inserirUsuario(contexto.cliente, empresaA, 'concessor-a@demo.safeworkengenharia.com.br');
    usuarioB = await inserirUsuario(contexto.cliente, empresaB, 'usuario-b@demo.safeworkengenharia.com.br');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('concessão válida: beneficiário e concessor da mesma empresa', async () => {
    assert.equal(
      await concederSst(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, concedidoPor: outroUsuarioA }),
      'ok',
    );
  });

  test('rejeita quando concedido_por pertence a outra empresa', async () => {
    const resultado = await concederSst(contexto.cliente, { empresaId: empresaB, usuarioId: usuarioB, concedidoPor: outroUsuarioA });
    assert.equal(resultado, VIOLACAO_FK, 'concessor de empresa diferente da do beneficiário deve ser rejeitado pela FK composta');
  });

  test('rejeita quando o empresa_id informado não corresponde à empresa real do usuario_id beneficiário', async () => {
    // Usuário próprio deste teste (nunca usado em outro cenário deste
    // describe): usuario_id é a chave primária de vinculo_sst, então
    // reaproveitar usuarioA aqui coincidiria com a violação de UNIQUE do
    // teste anterior, mascarando a violação de FK composta que este teste
    // quer comprovar.
    const usuarioIsolado = await inserirUsuario(contexto.cliente, empresaA, 'isolado-empresa-errada@demo.safeworkengenharia.com.br');
    const resultado = await concederSst(contexto.cliente, { empresaId: empresaB, usuarioId: usuarioIsolado, concedidoPor: usuarioB });
    assert.equal(resultado, VIOLACAO_FK, 'empresa_id divergente do usuario_id real deve ser rejeitado pela FK composta');
  });

  test('usuario_id é a chave primária: não é possível conceder duas vezes ao mesmo usuário', async () => {
    const resultado = await concederSst(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, concedidoPor: outroUsuarioA });
    assert.equal(resultado, VIOLACAO_UNIQUE);
  });

  test('revogar é um DELETE simples', async () => {
    const { rowCount } = await contexto.cliente.query('DELETE FROM vinculo_sst WHERE usuario_id = $1', [usuarioA]);
    assert.equal(rowCount, 1);
    const { rows } = await contexto.cliente.query('SELECT 1 FROM vinculo_sst WHERE usuario_id = $1', [usuarioA]);
    assert.equal(rows.length, 0);
  });

  test('excluir o usuário beneficiário (ON DELETE CASCADE) remove o vínculo de SST junto', async () => {
    const usuarioDescartavel = await inserirUsuario(contexto.cliente, empresaA, 'descartavel@demo.safeworkengenharia.com.br');
    assert.equal(await concederSst(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioDescartavel, concedidoPor: outroUsuarioA }), 'ok');

    await contexto.cliente.query('DELETE FROM usuarios WHERE id = $1', [usuarioDescartavel]);

    const { rows } = await contexto.cliente.query('SELECT 1 FROM vinculo_sst WHERE usuario_id = $1', [usuarioDescartavel]);
    assert.equal(rows.length, 0, 'a linha de vinculo_sst deveria ter sido removida em cascata');
  });
});

describe('migration 019 — usuario_autorizacoes', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let usuarioA;
  let usuarioB;
  let concessorA;

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    assert.equal(await inserirEmpresa(contexto.cliente, '12345678000195', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, '98765432000110', 'Empresa B'), 'ok');
    const { rows } = await contexto.cliente.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '12345678000195').id;
    empresaB = rows.find((e) => e.cnpj === '98765432000110').id;

    usuarioA = await inserirUsuario(contexto.cliente, empresaA, 'carlos-a@demo.safeworkengenharia.com.br', 'USUARIO');
    concessorA = await inserirUsuario(contexto.cliente, empresaA, 'concessor-a@demo.safeworkengenharia.com.br');
    usuarioB = await inserirUsuario(contexto.cliente, empresaB, 'usuario-b@demo.safeworkengenharia.com.br', 'USUARIO');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('concessão individual válida (ex.: Carlos, MOVIMENTAR_ESTOQUE)', async () => {
    assert.equal(
      await concederAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, acaoCodigo: 'MOVIMENTAR_ESTOQUE', autorizadoPor: concessorA }),
      'ok',
    );
  });

  test('o mesmo usuário pode receber uma autorização diferente (ex.: também REALIZAR_ENTREGA)', async () => {
    assert.equal(
      await concederAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, acaoCodigo: 'REALIZAR_ENTREGA', autorizadoPor: concessorA }),
      'ok',
    );
    const { rows } = await contexto.cliente.query('SELECT acao_codigo FROM usuario_autorizacoes WHERE usuario_id = $1 ORDER BY acao_codigo', [usuarioA]);
    assert.deepEqual(rows.map((r) => r.acao_codigo), ['MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA']);
  });

  test('rejeita duplicidade da mesma (usuario, ação)', async () => {
    const resultado = await concederAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, acaoCodigo: 'MOVIMENTAR_ESTOQUE', autorizadoPor: concessorA });
    assert.equal(resultado, VIOLACAO_UNIQUE);
  });

  test('rejeita quando autorizado_por pertence a outra empresa', async () => {
    const resultado = await concederAutorizacao(contexto.cliente, { empresaId: empresaB, usuarioId: usuarioB, acaoCodigo: 'MOVIMENTAR_ESTOQUE', autorizadoPor: concessorA });
    assert.equal(resultado, VIOLACAO_FK);
  });

  test('rejeita quando o empresa_id informado não corresponde à empresa real do usuario_id beneficiário', async () => {
    // Usuário próprio deste teste: usuarioA já tem uma linha para
    // MOVIMENTAR_ESTOQUE (primeiro teste deste describe), e reaproveitá-lo
    // aqui coincidiria com a violação de UNIQUE (usuario_id, acao_codigo),
    // mascarando a violação de FK composta que este teste quer comprovar.
    const usuarioIsolado = await inserirUsuario(contexto.cliente, empresaA, 'isolado-empresa-errada@demo.safeworkengenharia.com.br', 'USUARIO');
    const resultado = await concederAutorizacao(contexto.cliente, { empresaId: empresaB, usuarioId: usuarioIsolado, acaoCodigo: 'MOVIMENTAR_ESTOQUE', autorizadoPor: usuarioB });
    assert.equal(resultado, VIOLACAO_FK);
  });

  test('rejeita acao_codigo inexistente no catálogo', async () => {
    const resultado = await concederAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioA, acaoCodigo: 'ACAO_QUE_NAO_EXISTE', autorizadoPor: concessorA });
    assert.equal(resultado, VIOLACAO_FK);
  });

  test('excluir o usuário beneficiário (ON DELETE CASCADE) remove suas autorizações individuais', async () => {
    const usuarioDescartavel = await inserirUsuario(contexto.cliente, empresaA, 'descartavel-autorizacao@demo.safeworkengenharia.com.br', 'USUARIO');
    assert.equal(await concederAutorizacao(contexto.cliente, { empresaId: empresaA, usuarioId: usuarioDescartavel, acaoCodigo: 'MOVIMENTAR_ESTOQUE', autorizadoPor: concessorA }), 'ok');

    await contexto.cliente.query('DELETE FROM usuarios WHERE id = $1', [usuarioDescartavel]);

    const { rows } = await contexto.cliente.query('SELECT 1 FROM usuario_autorizacoes WHERE usuario_id = $1', [usuarioDescartavel]);
    assert.equal(rows.length, 0);
  });
});
