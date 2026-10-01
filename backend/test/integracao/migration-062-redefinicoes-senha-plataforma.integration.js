'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const { descreverTabelaDeRedefinicao } = require('./helpers/redefinicao-senha-contrato');
const { todasAsMigrations, criarAdministrador, criarIdentidade, inserirPedido, erroDe, VIOLACAO_FK } = require('./helpers/recuperacao-senha');

/**
 * Migration 062 — redefinicoes_senha_plataforma: pedidos de redefinição de
 * senha dos administradores da plataforma (Painel Privado). Mesmo contrato
 * da 061, em tabela separada, e nenhuma ligação com o MFA.
 */
descreverTabelaDeRedefinicao({
  titulo: 'migration 062 — redefinicoes_senha_plataforma (administradores)',
  prefixo: '062',
  tabela: 'redefinicoes_senha_plataforma',
  coluna: 'administrador_id',
  rotuloConta: 'administrador',
  tabelaConta: 'administradores_plataforma',
  criarConta: criarAdministrador,
});

describe('migration 062 — separação dos namespaces e do MFA', () => {
  let contexto;
  let c;

  before(async () => {
    contexto = await abrirSchemaTemporario(todasAsMigrations());
    c = contexto.cliente;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cada tabela só aceita a própria conta: identidade não entra na da plataforma, nem administrador na das identidades', async () => {
    // Três identidades e um administrador: o id 3 só existe como identidade.
    const identidades = [];
    for (const n of [1, 2, 3]) identidades.push(await criarIdentidade(c, `pessoa${n}@example.invalid`));
    const administrador = await criarAdministrador(c, 'admin@example.invalid');
    const soIdentidade = identidades.find((id) => id !== administrador);
    const naPlataforma = await erroDe(inserirPedido(c, { tabela: 'redefinicoes_senha_plataforma', coluna: 'administrador_id' }, soIdentidade));
    assert.deepEqual([naPlataforma?.code, naPlataforma?.constraint], [VIOLACAO_FK, 'redefinicoes_senha_plataforma_administrador_id_fkey']);
    // Mais administradores do que identidades: o id mais alto só existe como administrador.
    let soAdministrador = administrador;
    while (identidades.includes(soAdministrador)) soAdministrador = await criarAdministrador(c, `admin${soAdministrador}@example.invalid`);
    const nasIdentidades = await erroDe(inserirPedido(c, { tabela: 'redefinicoes_senha', coluna: 'identidade_id' }, soAdministrador));
    assert.deepEqual([nasIdentidades?.code, nasIdentidades?.constraint], [VIOLACAO_FK, 'redefinicoes_senha_identidade_id_fkey']);
    const { rows } = await c.query(
      `SELECT confrelid::regclass::text AS alvo FROM pg_constraint
        WHERE contype = 'f' AND conrelid IN ('redefinicoes_senha'::regclass, 'redefinicoes_senha_plataforma'::regclass)
        ORDER BY conrelid::regclass::text`,
    );
    assert.deepEqual(rows.map((r) => r.alvo), ['identidades', 'administradores_plataforma']);
  });

  test('a migration não toca em nenhuma estrutura do MFA nem das sessões da plataforma', () => {
    assert.equal(migrationExiste('062'), true, 'arquivo da migration 062');
    const sql = conteudoDaMigration('062').replace(/--.*$/gm, '');
    for (const proibido of [/mfa/i, /sessoes_plataforma/i, /fatores_/i, /codigos_recuperacao/i, /desafios_/i, /ALTER\s+TABLE\s+administradores_plataforma/i]) {
      assert.doesNotMatch(sql, proibido, String(proibido));
    }
  });
});
