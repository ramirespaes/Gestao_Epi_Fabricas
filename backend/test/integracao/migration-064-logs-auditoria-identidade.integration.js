'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const {
  VIOLACAO_NAO_NULO, VIOLACAO_FK, VIOLACAO_CHECK, RECUSA_DO_TRIGGER, todasAsMigrations, erroDe, criarIdentidade,
  constraintsDe, indicesDe, gatilhosDe, colunasDe, tabelaExiste,
} = require('./helpers/recuperacao-senha');

/**
 * Migration 064 — logs_auditoria_identidade: trilha append-only dos eventos
 * da identidade global (solicitação de recuperação, redefinição e troca de
 * senha). O evento é da identidade, não de uma empresa, por isso não há
 * empresa_id. Reaproveita as funções de 012 (append-only) e de 014 (bloqueio
 * de chave JSON sensível). PostgreSQL real, schema temporário.
 */

const TABELA = 'logs_auditoria_identidade';
const LIMITE_JSON_BYTES = 16384;

describe('migration 064 — logs_auditoria_identidade', () => {
  let contexto;
  let c;
  let identidade;

  const registrar = (extra = {}) => {
    const valores = { identidade_id: identidade, ator_tipo: 'SISTEMA', acao: 'SENHA_REDEFINIDA', ...extra };
    const colunas = Object.keys(valores);
    return c.query(
      `INSERT INTO ${TABELA} (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(valores).map((v) => (v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v)),
    );
  };

  before(async () => {
    contexto = await abrirSchemaTemporario(todasAsMigrations());
    c = contexto.cliente;
    identidade = await criarIdentidade(c, 'pessoa@example.invalid');
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('a migration existe e cria a tabela com colunas, constraints, índices e gatilhos esperados; sem empresa_id', async () => {
    assert.equal(migrationExiste('064'), true, 'arquivo da migration 064');
    assert.equal(await tabelaExiste(c, TABELA), true, `tabela ${TABELA}`);
    assert.deepEqual(await colunasDe(c, contexto.schema, TABELA), [
      'id', 'identidade_id', 'ator_tipo', 'acao', 'referencia', 'descricao', 'ip', 'dispositivo', 'contexto', 'dados_anteriores', 'dados_novos', 'criado_em',
    ]);
    assert.deepEqual((await constraintsDe(c, contexto.schema, TABELA)).sort(), [
      `chk_${TABELA}_ator_tipo`,
      `chk_${TABELA}_contexto_objeto`,
      `chk_${TABELA}_contexto_tamanho`,
      `chk_${TABELA}_dados_anteriores_objeto`,
      `chk_${TABELA}_dados_anteriores_tamanho`,
      `chk_${TABELA}_dados_novos_objeto`,
      `chk_${TABELA}_dados_novos_tamanho`,
      `${TABELA}_identidade_id_fkey`,
      `${TABELA}_pkey`,
    ].sort());
    assert.deepEqual((await indicesDe(c, contexto.schema, TABELA)).sort(), [
      `idx_${TABELA}_criado_em`,
      `idx_${TABELA}_identidade_id`,
      `${TABELA}_pkey`,
    ].sort());
    assert.deepEqual((await gatilhosDe(c, contexto.schema, TABELA)).sort(), [
      `trg_${TABELA}_bloquear_dado_sensivel`,
      `trg_${TABELA}_bloquear_delete`,
      `trg_${TABELA}_bloquear_truncate`,
      `trg_${TABELA}_bloquear_update`,
    ].sort());
  });

  test('registra evento da identidade sem empresa; ator SISTEMA (fluxo anônimo) e IDENTIDADE (troca autenticada)', async () => {
    const { rows: [anonimo] } = await registrar({ ator_tipo: 'SISTEMA', acao: 'REDEFINICAO_SOLICITADA', ip: '203.0.113.7', dispositivo: 'Agente de Teste' });
    assert.deepEqual([anonimo.identidade_id, anonimo.ator_tipo, anonimo.acao], [identidade, 'SISTEMA', 'REDEFINICAO_SOLICITADA']);
    assert.ok(anonimo.criado_em instanceof Date);
    const { rows: [autenticado] } = await registrar({ ator_tipo: 'IDENTIDADE', acao: 'SENHA_ALTERADA', contexto: { origem: 'portal', sessoesRevogadas: 2 } });
    assert.deepEqual(autenticado.contexto, { origem: 'portal', sessoesRevogadas: 2 });
  });

  test('identidade, ator e ação são obrigatórios; ator fora da lista é recusado; a ação segue o contrato das outras trilhas (até 60 caracteres)', async () => {
    for (const campo of ['identidade_id', 'ator_tipo', 'acao']) {
      const erro = await erroDe(registrar({ [campo]: null }));
      assert.equal(erro?.code, VIOLACAO_NAO_NULO, campo);
    }
    for (const ator of ['ADMINISTRADOR', 'USUARIO', 'identidade', '']) {
      const erro = await erroDe(registrar({ ator_tipo: ator }));
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, `chk_${TABELA}_ator_tipo`], ator);
    }
    // Mesmo contrato de logs_auditoria (012) e logs_auditoria_plataforma (029):
    // VARCHAR(60) NOT NULL, sem regra de formato própria desta trilha.
    const { rows: [noLimite] } = await registrar({ acao: 'A'.repeat(60) });
    assert.equal(noLimite.acao.length, 60);
    const longa = await erroDe(registrar({ acao: 'A'.repeat(61) }));
    assert.equal(longa?.code, '22001');
    const { rows: tipos } = await c.query(
      `SELECT table_name, data_type, character_maximum_length AS tamanho, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND column_name = 'acao'
          AND table_name IN ('logs_auditoria', 'logs_auditoria_plataforma', 'logs_auditoria_identidade')
        ORDER BY table_name`,
      [contexto.schema],
    );
    assert.deepEqual(tipos.map((t) => [t.data_type, t.tamanho, t.is_nullable]), Array(3).fill(['character varying', 60, 'NO']), 'as três trilhas têm a mesma coluna de ação');
  });

  test('identidade inexistente é recusada pela FK; identidade com trilha não pode ser apagada', async () => {
    const inexistente = await erroDe(registrar({ identidade_id: 999999 }));
    assert.deepEqual([inexistente?.code, inexistente?.constraint], [VIOLACAO_FK, `${TABELA}_identidade_id_fkey`]);
    const apagar = await erroDe(c.query('DELETE FROM identidades WHERE id = $1', [identidade]));
    assert.equal(apagar?.code, VIOLACAO_FK);
  });

  test('append-only: UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const { rows: [linha] } = await registrar();
    for (const sql of [
      `UPDATE ${TABELA} SET descricao = 'alterada' WHERE id = ${Number(linha.id)}`,
      `DELETE FROM ${TABELA} WHERE id = ${Number(linha.id)}`,
      `TRUNCATE ${TABELA}`,
    ]) {
      const erro = await erroDe(c.query(sql));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER, sql);
      assert.match(erro.message, /append-only/);
    }
    const { rows: [{ n }] } = await c.query(`SELECT count(*)::int AS n FROM ${TABELA} WHERE id = $1`, [linha.id]);
    assert.equal(n, 1);
  });

  test('chave JSON sensível é recusada em contexto, dados_anteriores e dados_novos, inclusive aninhada', async () => {
    for (const coluna of ['contexto', 'dados_anteriores', 'dados_novos']) {
      for (const dado of [{ senha: 'x' }, { senha_hash: 'x' }, { token: 'x' }, { token_hash: 'x' }, { interno: { password: 'x' } }, { lista: [{ cookie: 'x' }] }]) {
        const erro = await erroDe(registrar({ [coluna]: dado }));
        assert.equal(erro?.code, RECUSA_DO_TRIGGER, `${coluna} ${JSON.stringify(dado)}`);
        assert.match(erro.message, /chave sensível/);
      }
    }
    const { rows: [aceito] } = await registrar({ contexto: { origem: 'link', sessoesRevogadas: 3, pedidosCancelados: 1 } });
    assert.equal(aceito.contexto.sessoesRevogadas, 3);
  });

  test('JSON precisa ser objeto e caber no limite de 16 KiB', async () => {
    for (const coluna of ['contexto', 'dados_anteriores', 'dados_novos']) {
      const lista = await erroDe(c.query(
        `INSERT INTO ${TABELA} (identidade_id, ator_tipo, acao, ${coluna}) VALUES ($1, 'SISTEMA', 'SENHA_REDEFINIDA', '[1, 2]'::jsonb)`, [identidade],
      ));
      assert.deepEqual([lista?.code, lista?.constraint], [VIOLACAO_CHECK, `chk_${TABELA}_${coluna}_objeto`], coluna);
      const grande = await erroDe(registrar({ [coluna]: { observacao: 'x'.repeat(LIMITE_JSON_BYTES) } }));
      assert.deepEqual([grande?.code, grande?.constraint], [VIOLACAO_CHECK, `chk_${TABELA}_${coluna}_tamanho`], coluna);
    }
  });

  test('a migration reaproveita as funções de 012 e 014 e não as redefine', () => {
    assert.equal(migrationExiste('064'), true, 'arquivo da migration 064');
    const sql = conteudoDaMigration('064').replace(/--.*$/gm, '');
    assert.match(sql, /EXECUTE FUNCTION bloquear_alteracao_logs_auditoria\(\)/);
    assert.match(sql, /EXECUTE FUNCTION logs_auditoria_bloquear_dado_sensivel\(\)/);
    assert.doesNotMatch(sql, /CREATE (OR REPLACE )?FUNCTION/i);
    assert.doesNotMatch(sql, /empresa_id/i);
  });
});
