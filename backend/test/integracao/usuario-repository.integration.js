'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirSchemaTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const empresas = require('../../src/repositories/empresa.repository');
const usuarios = require('../../src/repositories/usuario.repository');

/**
 * Repositório de usuários contra PostgreSQL real.
 *
 * O ponto central aqui é o isolamento: duas empresas recebem um usuário com o
 * mesmo endereço de e-mail, e nenhuma consulta feita no contexto de uma pode
 * alcançar o registro da outra. Isso não se prova com dublê, só com banco.
 *
 * Dados sintéticos, em schema temporário exclusivo removido em cascata ao
 * final. O schema public não é lido nem escrito.
 */

const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const EMAIL_COMPARTILHADO = 'ana.souza@demo.safeworkengenharia.com.br';
const EMAIL_EXCLUSIVO = 'carlos.lima@demo.safeworkengenharia.com.br';
// Hashes sintéticos no formato do Argon2id. Não correspondem a senha alguma:
// estes testes não verificam senha, apenas a projeção do campo.
//
// São distintos por empresa de propósito. Com um hash único, um vazamento
// entre contratantes passaria despercebido, porque o valor recuperado seria
// o mesmo nos dois casos e a asserção não distinguiria a origem.
const HASH_EMPRESA_A = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNvZW1wcmVzYUE$aGFzaGV4Y2x1c2l2b2RhZW1wcmVzYUFkZW1v';
const HASH_EMPRESA_B = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNvZW1wcmVzYUI$aGFzaGV4Y2x1c2l2b2RhZW1wcmVzYUJkZW1v';

const inserirUsuario = async (cliente, empresaId, email, nome, hash, extra = {}) => {
  const { rows } = await cliente.query(
    `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [empresaId, nome, email, hash, extra.perfil ?? 'ADMINISTRADOR', extra.ativo ?? true],
  );
  return rows[0].id;
};

describe('repositório de usuários em PostgreSQL real', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let usuarioA;
  let usuarioB;

  before(async () => {
    contexto = await abrirSchemaTemporario(['000', '001', '002', '005', '016']);
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(contexto.cliente, CNPJ_B, 'Empresa B'), 'ok');

    empresaA = (await empresas.buscarPorCnpj(contexto.cliente, CNPJ_A)).id;
    empresaB = (await empresas.buscarPorCnpj(contexto.cliente, CNPJ_B)).id;

    usuarioA = await inserirUsuario(contexto.cliente, empresaA, EMAIL_COMPARTILHADO, 'Ana da Empresa A', HASH_EMPRESA_A);
    usuarioB = await inserirUsuario(contexto.cliente, empresaB, EMAIL_COMPARTILHADO, 'Ana da Empresa B', HASH_EMPRESA_B);
    await inserirUsuario(contexto.cliente, empresaA, EMAIL_EXCLUSIVO, 'Carlos', HASH_EMPRESA_A, { perfil: 'USUARIO', ativo: false });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('encontra o usuário dentro da empresa correspondente', async () => {
    const naEmpresaA = await usuarios.buscarPorEmail(contexto.cliente, empresaA, EMAIL_COMPARTILHADO);
    const naEmpresaB = await usuarios.buscarPorEmail(contexto.cliente, empresaB, EMAIL_COMPARTILHADO);

    assert.equal(naEmpresaA.nome, 'Ana da Empresa A');
    assert.equal(naEmpresaB.nome, 'Ana da Empresa B');
    assert.equal(naEmpresaA.empresa_id, empresaA);
    assert.equal(naEmpresaB.empresa_id, empresaB);
    assert.notEqual(naEmpresaA.id, naEmpresaB.id);
  });

  test('o mesmo e-mail em outra empresa não é alcançado', async () => {
    const soNaEmpresaA = await usuarios.buscarPorEmail(contexto.cliente, empresaB, EMAIL_EXCLUSIVO);

    assert.equal(soNaEmpresaA, null, 'usuário da empresa A não pode aparecer na consulta da empresa B');
  });

  test('a busca por identificador não atravessa empresas', async () => {
    const proprio = await usuarios.buscarPorId(contexto.cliente, empresaA, usuarioA);
    const alheio = await usuarios.buscarPorId(contexto.cliente, empresaA, usuarioB);

    assert.equal(proprio.nome, 'Ana da Empresa A');
    assert.equal(alheio, null, 'identificador de outra empresa não pode ser resolvido');
  });

  test('consultas comuns não trazem o hash da senha', async () => {
    const porEmail = await usuarios.buscarPorEmail(contexto.cliente, empresaA, EMAIL_COMPARTILHADO);
    const porId = await usuarios.buscarPorId(contexto.cliente, empresaA, usuarioA);

    for (const usuario of [porEmail, porId]) {
      assert.equal('senha_hash' in usuario, false);
      assert.equal(JSON.stringify(usuario).includes('argon2'), false);
    }
    assert.deepEqual(Object.keys(porEmail).sort(), [...usuarios.CAMPOS_PUBLICOS].sort());
  });

  test('a consulta de credencial traz o hash, delimitada por empresa', async () => {
    const credencial = await usuarios.buscarCredencialPorEmail(contexto.cliente, empresaA, EMAIL_COMPARTILHADO);

    assert.equal(credencial.senha_hash, HASH_EMPRESA_A);
    assert.equal(credencial.empresa_id, empresaA);

    const daOutraEmpresa = await usuarios.buscarCredencialPorEmail(contexto.cliente, empresaB, EMAIL_EXCLUSIVO);
    assert.equal(daOutraEmpresa, null);
  });

  test('o mesmo e-mail em empresas distintas devolve credenciais distintas', async () => {
    const naEmpresaA = await usuarios.buscarCredencialPorEmail(contexto.cliente, empresaA, EMAIL_COMPARTILHADO);
    const naEmpresaB = await usuarios.buscarCredencialPorEmail(contexto.cliente, empresaB, EMAIL_COMPARTILHADO);

    assert.equal(naEmpresaA.senha_hash, HASH_EMPRESA_A);
    assert.equal(naEmpresaB.senha_hash, HASH_EMPRESA_B);
    assert.notEqual(naEmpresaA.senha_hash, naEmpresaB.senha_hash, 'o hash de uma empresa não pode alcançar a outra');
    assert.notEqual(naEmpresaA.id, naEmpresaB.id);
    assert.equal(naEmpresaA.empresa_id, empresaA);
    assert.equal(naEmpresaB.empresa_id, empresaB);
  });

  test('usuário inativo é devolvido, porque a decisão não é do repositório', async () => {
    const credencial = await usuarios.buscarCredencialPorEmail(contexto.cliente, empresaA, EMAIL_EXCLUSIVO);

    assert.notEqual(credencial, null);
    assert.equal(credencial.ativo, false);
    assert.equal(credencial.perfil, 'USUARIO');
  });

  test('e-mail inexistente devolve null nas três consultas', async () => {
    const ausente = 'ninguem@demo.safeworkengenharia.com.br';

    assert.equal(await usuarios.buscarPorEmail(contexto.cliente, empresaA, ausente), null);
    assert.equal(await usuarios.buscarCredencialPorEmail(contexto.cliente, empresaA, ausente), null);
    assert.equal(await usuarios.buscarPorId(contexto.cliente, empresaA, 999999), null);
  });
});
