'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, migrationExiste } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe } = require('./helpers/entrega-epi');
const { montarCenario } = require('./helpers/solicitacao-epi');

/**
 * Migration 069 — só a infraestrutura durável (scheduler/outbox) do aviso de
 * disponibilidade da 12G-6, em PostgreSQL real e schema temporário.
 *
 * Uma tabela só, `alertas_estoque_agendamentos`: a janela, o estado do
 * processamento, as tentativas e o resultado agregado do envio consolidado,
 * no máximo um PENDENTE por empresa e tipo, convivendo com um ENVIANDO, um
 * AGUARDANDO_RETRY ou uma FALHA anteriores. Nada item a item: nem candidato,
 * nem "já comunicado", nem cobertura ou disponibilidade, que continuam
 * derivadas e são recalculadas no envio.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const TIPO = 'DISPONIBILIDADE_ESTOQUE_ENTREGA';
const UNICIDADE = '23505';
const VIOLACAO_FK = '23503';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';

function exigirMigration069() {
  assert.equal(migrationExiste('069'), true, 'migration 069 ainda não implementada');
}

const tabelasDoSchema = async (cliente) => (await cliente.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1",
)).rows.map((r) => r.table_name);

describe('migration 069 — agendamento (scheduler/outbox) do aviso de disponibilidade', () => {
  let ctx;
  let d;
  const q = (sql, params) => ctx.cliente.query(sql, params);

  // Agendamento com valores coerentes por padrão; `extra` sobrescreve.
  const agendar = (extra = {}) => {
    const v = {
      empresa_id: d.empresaA, tipo: TIPO, estado: 'PENDENTE', primeira_entrada_em: '2026-10-04T10:00:00Z', ultima_entrada_em: '2026-10-04T10:00:00Z',
      enviar_apos: '2026-10-04T10:10:00Z', tentativas: 0, ...extra,
    };
    const colunas = Object.keys(v);
    return q(`INSERT INTO alertas_estoque_agendamentos (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(v));
  };
  const mudarEstado = (agendamento, sets) => {
    const colunas = Object.keys(sets);
    return q(
      `UPDATE alertas_estoque_agendamentos SET ${colunas.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [agendamento.id, ...Object.values(sets)],
    );
  };
  const codigo = async (promessa) => (await erroDe(promessa))?.code;

  before(async () => {
    exigirMigration069();
    ctx = await abrirSchemaTemporario(todasAsMigrations());
    d = await montarCenario(ctx.cliente);
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('a 069 cria exatamente uma tabela, alertas_estoque_agendamentos: nenhuma de candidatos nem substituta (diferença real entre 000–068 e 000–069)', async () => {
    const antes = await abrirSchemaTemporario(todasAsMigrations().filter((p) => p !== '069'));
    let semA069;
    try {
      semA069 = await tabelasDoSchema(antes.cliente);
    } finally {
      await antes.encerrar();
    }
    const novas = (await tabelasDoSchema(ctx.cliente)).filter((t) => !semA069.includes(t));
    assert.deepEqual(novas, ['alertas_estoque_agendamentos']);
    assert.equal((await tabelasDoSchema(ctx.cliente)).includes('alertas_estoque_candidatos'), false);
    assert.equal((fs.readFileSync(path.join(DIRETORIO, '069_create_alertas_estoque.sql'), 'utf8').match(/CREATE TABLE/gi) || []).length, 1);
  });

  test('o agendamento não guarda nada item a item nem disponibilidade: nenhuma coluna de item, solicitação, trabalhador, cobertura ou quantidade, e nenhuma FK fora de empresas', async () => {
    const { rows } = await q(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'alertas_estoque_agendamentos'",
    );
    const colunas = rows.map((r) => r.column_name);
    for (const coluna of colunas) {
      assert.doesNotMatch(coluna, /item|solicitac|funcionario|trabalhador|material|dispon|cobert|saldo|pendente|quantidade|reserv|comprometid|comunicad|candidat/, coluna);
    }
    for (const c of ['id', 'empresa_id', 'tipo', 'estado', 'primeira_entrada_em', 'ultima_entrada_em', 'enviar_apos', 'tentativas', 'proxima_tentativa_em',
      'reivindicado_em', 'processado_em', 'codigo_ultimo_erro', 'criado_em', 'atualizado_em']) assert.ok(colunas.includes(c), c);
    const { rows: fks } = await q(
      `SELECT ccu.table_name AS referenciada
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.table_schema = current_schema() AND tc.table_name = 'alertas_estoque_agendamentos' AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    assert.deepEqual([...new Set(fks.map((r) => r.referenciada))], ['empresas']);
  });

  test('no máximo um PENDENTE por empresa e tipo; outra empresa tem o seu', async () => {
    const a = (await agendar()).rows[0];
    assert.equal(await codigo(agendar()), UNICIDADE);
    const b = (await agendar({ empresa_id: d.empresaB })).rows[0];
    await q('DELETE FROM alertas_estoque_agendamentos WHERE id = ANY($1)', [[a.id, b.id]]);
  });

  test('ENVIANDO, AGUARDANDO_RETRY e FALHA convivem com um PENDENTE novo da mesma empresa e tipo', async () => {
    const enviando = (await agendar()).rows[0];
    await mudarEstado(enviando, { estado: 'ENVIANDO', reivindicado_em: '2026-10-04T10:10:00Z', tentativas: 1 });
    const pendente = (await agendar({ primeira_entrada_em: '2026-10-04T10:10:02Z', ultima_entrada_em: '2026-10-04T10:10:02Z', enviar_apos: '2026-10-04T10:20:02Z' })).rows[0];
    await mudarEstado(enviando, { estado: 'AGUARDANDO_RETRY', proxima_tentativa_em: '2026-10-04T10:12:00Z', codigo_ultimo_erro: 'ETIMEDOUT' });
    assert.equal(await codigo(agendar()), UNICIDADE, 'ainda um PENDENTE só');
    await mudarEstado(enviando, { estado: 'ENVIANDO', reivindicado_em: '2026-10-04T10:12:00Z', tentativas: 2 });
    await mudarEstado(enviando, { estado: 'FALHA', processado_em: '2026-10-04T10:12:05Z', codigo_ultimo_erro: 'ETIMEDOUT' });
    const { rows } = await q('SELECT estado FROM alertas_estoque_agendamentos WHERE empresa_id = $1 ORDER BY id', [d.empresaA]);
    assert.deepEqual(rows.map((r) => r.estado), ['FALHA', 'PENDENTE']);
    await q('DELETE FROM alertas_estoque_agendamentos WHERE id = ANY($1)', [[enviando.id, pendente.id]]);
  });

  test('restrições: tipo, estado, tentativas, código de erro, ordem das datas, contagens e campos exigidos por estado', async () => {
    assert.equal(await codigo(agendar({ tipo: 'OUTRO' })), VIOLACAO_CHECK);
    assert.equal(await codigo(agendar({ tentativas: -1 })), VIOLACAO_CHECK);
    assert.equal(await codigo(agendar({ ultima_entrada_em: '2026-10-04T09:00:00Z' })), VIOLACAO_CHECK, 'última antes da primeira');
    assert.equal(await codigo(agendar({ enviar_apos: '2026-10-04T09:59:00Z' })), VIOLACAO_CHECK, 'envio antes da última entrada');
    assert.equal(await codigo(agendar({ codigo_ultimo_erro: 'texto livre com dado' })), VIOLACAO_CHECK);
    assert.equal(await codigo(agendar({ linhas_resumo: -1 })), VIOLACAO_CHECK);
    assert.equal(await codigo(agendar({ empresa_id: 999999 })), VIOLACAO_FK);
    const a = (await agendar()).rows[0];
    assert.equal(await codigo(mudarEstado(a, { estado: 'QUALQUER' })), VIOLACAO_CHECK);
    assert.equal(await codigo(mudarEstado(a, { estado: 'ENVIANDO' })), VIOLACAO_CHECK, 'ENVIANDO exige reivindicado_em');
    await q('DELETE FROM alertas_estoque_agendamentos WHERE id = $1', [a.id]);
  });

  test('transições: só PENDENTE nasce; estados finais não mudam; a janela só anda enquanto PENDENTE; tentativas nunca diminuem', async () => {
    assert.equal(await codigo(agendar({ estado: 'ENVIADO', processado_em: '2026-10-04T10:11:00Z' })), RECUSA_DO_TRIGGER, 'nasce PENDENTE');
    const a = (await agendar()).rows[0];
    await mudarEstado(a, { ultima_entrada_em: '2026-10-04T10:05:00Z', enviar_apos: '2026-10-04T10:15:00Z' });
    assert.equal(await codigo(mudarEstado(a, { primeira_entrada_em: '2026-10-04T10:01:00Z' })), RECUSA_DO_TRIGGER, 'primeira entrada é imutável');
    await mudarEstado(a, { estado: 'ENVIANDO', reivindicado_em: '2026-10-04T10:15:00Z', tentativas: 1 });
    assert.equal(await codigo(mudarEstado(a, { enviar_apos: '2026-10-04T10:30:00Z' })), RECUSA_DO_TRIGGER, 'a janela não anda depois de reivindicado');
    assert.equal(await codigo(mudarEstado(a, { estado: 'PENDENTE' })), RECUSA_DO_TRIGGER, 'não volta a PENDENTE');
    assert.equal(await codigo(mudarEstado(a, { tentativas: 0 })), RECUSA_DO_TRIGGER, 'tentativas não diminuem');
    await mudarEstado(a, { estado: 'ENVIADO', processado_em: '2026-10-04T10:15:05Z' });
    for (const sets of [{ estado: 'ENVIANDO', reivindicado_em: '2026-10-04T10:16:00Z' }, { estado: 'DESCARTADO' }, { codigo_ultimo_erro: 'X' }]) {
      assert.equal(await codigo(mudarEstado(a, sets)), RECUSA_DO_TRIGGER, JSON.stringify(sets));
    }
    await q('DELETE FROM alertas_estoque_agendamentos WHERE id = $1', [a.id]);
  });

  test('a 069 não edita nenhuma migration antiga e só acrescenta a sua entrada ao manifesto: 85 migrations, 000 a 084 (a 070 e a 071 são da 12G-8; a 072 e a 073 são das Configurações; a 074 é da Gestão de Usuários; a 075 a 077 são do usuário administrativo; a 078 e a 079 são das permissões e da auditoria; a 080 é da Fiscalização)', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, 85);
    assert.equal(arquivos[arquivos.length - 16].slice(0, 3), '069');
    assert.equal(arquivos[arquivos.length - 15].slice(0, 3), '070');
    assert.equal(arquivos[arquivos.length - 14].slice(0, 3), '071');
    assert.equal(arquivos[arquivos.length - 13].slice(0, 3), '072');
    assert.equal(arquivos[arquivos.length - 12].slice(0, 3), '073');
    assert.equal(arquivos[arquivos.length - 11].slice(0, 3), '074');
    assert.equal(arquivos[arquivos.length - 10].slice(0, 3), '075');
    assert.equal(arquivos[arquivos.length - 9].slice(0, 3), '076');
    assert.equal(arquivos[arquivos.length - 8].slice(0, 3), '077');
    assert.equal(arquivos[arquivos.length - 7].slice(0, 3), '078');
    assert.equal(arquivos[arquivos.length - 6].slice(0, 3), '079');
    assert.equal(arquivos[arquivos.length - 5].slice(0, 3), '080');
    assert.equal(arquivos[arquivos.length - 4].slice(0, 3), '081');
    assert.equal(arquivos[arquivos.length - 3].slice(0, 3), '082');
    assert.equal(arquivos[arquivos.length - 2].slice(0, 3), '083');
    assert.equal(arquivos[arquivos.length - 1].slice(0, 3), '084');
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    for (const nome of arquivos) {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, nome))).digest('hex');
      assert.equal(manifesto.migrations[nome], sha, nome);
    }
  });
});
