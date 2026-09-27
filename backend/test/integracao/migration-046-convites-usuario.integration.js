'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, inserirEmpresa, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 046 — convites_usuario e convite_usuario_tentativas. PostgreSQL
 * real, schema temporário. Dependências mínimas: empresas (001), perfis e
 * usuarios (002/005), uq_usuarios_empresa_id (013, exigido pelas FKs
 * compostas) e identidades (025).
 */

const MIGRATIONS = ['000', '001', '002', '005', '013', '025', '046'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const HASH = (c) => c.repeat(64);
const CHAVE = 'a'.repeat(64);

describe('migration 046 — convites_usuario', () => {
  let contexto;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;
  let identidade;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    await inserirEmpresa(contexto.cliente, '11222333000181', 'A');
    await inserirEmpresa(contexto.cliente, '44555666000162', 'B');
    const { rows } = await q('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '11222333000181').id;
    empresaB = rows.find((e) => e.cnpj === '44555666000162').id;
    identidade = (await q("INSERT INTO identidades (email, senha_hash) VALUES ('master@x.com', 'h') RETURNING id")).rows[0].id;
    masterA = (await q("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'Master A', 'MASTER', $2) RETURNING id", [empresaA, identidade])).rows[0].id;
    masterB = (await q("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'Master B', 'MASTER', $2) RETURNING id", [empresaB, identidade])).rows[0].id;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  async function inserir(dados) {
    try {
      const { rows } = await q(
        `INSERT INTO convites_usuario (empresa_id, email_convite, nome, perfil, token_hash, criado_por, expira_em, criado_em, aceito_em, cancelado_em, identidade_id, usuario_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [dados.empresaId ?? empresaA, dados.email ?? 'nova@x.com', dados.nome ?? 'Pessoa Nova', dados.perfil ?? 'USUARIO', dados.hash,
          dados.criadoPor ?? masterA, dados.expiraEm ?? new Date(Date.now() + 3600e3), dados.criadoEm ?? new Date(),
          dados.aceitoEm ?? null, dados.canceladoEm ?? null, dados.identidadeId ?? null, dados.usuarioId ?? null],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  test('convite pendente válido é aceito, com nome e perfil do vínculo que vai nascer', async () => {
    const r = await inserir({ hash: HASH('a') });
    assert.equal(r.ok, true);
    const { rows: [linha] } = await q('SELECT nome, perfil, aceito_em, cancelado_em FROM convites_usuario WHERE id = $1', [r.id]);
    assert.deepEqual(linha, { nome: 'Pessoa Nova', perfil: 'USUARIO', aceito_em: null, cancelado_em: null });
  });

  test('token_hash é único e precisa ser SHA-256 hex minúsculo', async () => {
    const dup = await inserir({ hash: HASH('a') });
    assert.deepEqual([dup.ok, dup.code], [false, VIOLACAO_UNIQUE]);
    const ruim = await inserir({ hash: 'A'.repeat(64) });
    assert.deepEqual([ruim.ok, ruim.code], [false, VIOLACAO_CHECK]);
  });

  test('quem convida é usuário da MESMA empresa (FK composta)', async () => {
    const outraEmpresa = await inserir({ hash: HASH('b'), empresaId: empresaA, criadoPor: masterB });
    assert.deepEqual([outraEmpresa.ok, outraEmpresa.code, outraEmpresa.constraint], [false, VIOLACAO_FK, 'fk_convites_usuario_criado_por_mesma_empresa']);
    const inexistente = await inserir({ hash: HASH('b'), criadoPor: 999999 });
    assert.deepEqual([inexistente.ok, inexistente.code], [false, VIOLACAO_FK]);
    const erro = await q('DELETE FROM usuarios WHERE id = $1', [masterA]).catch((e) => e);
    assert.equal(erro.code, VIOLACAO_FK, 'quem convidou não pode ser apagado');
  });

  test('perfil precisa existir no catálogo de perfis', async () => {
    const r = await inserir({ hash: HASH('c'), perfil: 'ROOT' });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_FK]);
    for (const perfil of ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR']) {
      assert.equal((await inserir({ hash: crypto.randomBytes(32).toString('hex'), perfil })).ok, true, perfil);
    }
  });

  test('e-mail guardado só na forma normalizada; nome não pode ficar em branco', async () => {
    for (const email of ['Nova@x.com', ' nova@x.com', 'nova@x.com ', '']) {
      const r = await inserir({ hash: crypto.randomBytes(32).toString('hex'), email });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(email));
    }
    for (const nome of ['', '   ']) {
      const r = await inserir({ hash: crypto.randomBytes(32).toString('hex'), nome });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(nome));
    }
  });

  test('expira_em precisa ser posterior a criado_em', async () => {
    const agora = new Date();
    const r = await inserir({ hash: HASH('d'), criadoEm: agora, expiraEm: agora });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
  });

  test('aceito e cancelado são mutuamente exclusivos', async () => {
    const r = await inserir({ hash: HASH('e'), aceitoEm: new Date(), canceladoEm: new Date() });
    assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK]);
  });

  test('aceite coerente: aceito_em exige identidade e vínculo da MESMA empresa; pendente não carrega nenhum dos dois', async () => {
    const semVinculo = await inserir({ hash: HASH('f'), aceitoEm: new Date() });
    assert.deepEqual([semVinculo.ok, semVinculo.code], [false, VIOLACAO_CHECK]);

    const pessoa = (await q("INSERT INTO identidades (email, senha_hash) VALUES ('nova@x.com', 'h') RETURNING id")).rows[0].id;
    const vinculoA = (await q("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'Pessoa Nova', 'USUARIO', $2) RETURNING id", [empresaA, pessoa])).rows[0].id;
    const vinculoB = (await q("INSERT INTO usuarios (empresa_id, nome, perfil, identidade_id) VALUES ($1, 'Pessoa Nova', 'USUARIO', $2) RETURNING id", [empresaB, pessoa])).rows[0].id;

    const outraEmpresa = await inserir({ hash: HASH('1'), aceitoEm: new Date(), identidadeId: pessoa, usuarioId: vinculoB });
    assert.deepEqual([outraEmpresa.ok, outraEmpresa.code, outraEmpresa.constraint], [false, VIOLACAO_FK, 'fk_convites_usuario_usuario_mesma_empresa']);

    assert.equal((await inserir({ hash: HASH('2'), aceitoEm: new Date(), identidadeId: pessoa, usuarioId: vinculoA })).ok, true);

    const pendenteComVinculo = await inserir({ hash: HASH('3'), identidadeId: pessoa, usuarioId: vinculoA });
    assert.deepEqual([pendenteComVinculo.ok, pendenteComVinculo.code], [false, VIOLACAO_CHECK]);
  });

  test('índice parcial dos pendentes por empresa e e-mail existe', async () => {
    const { rows } = await q(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_convites_usuario_empresa_email_pendentes'",
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /\(empresa_id, email_convite\)/);
    assert.match(rows[0].indexdef, /aceito_em IS NULL/);
    assert.match(rows[0].indexdef, /cancelado_em IS NULL/);
  });

  describe('convite_usuario_tentativas', () => {
    let conviteId;

    before(async () => {
      conviteId = (await inserir({ hash: HASH('9') })).id;
    });

    async function tentar(d) {
      try {
        await q(
          'INSERT INTO convite_usuario_tentativas (chave_cooldown, convite_id, sucesso, motivo, cooldown_ate) VALUES ($1, $2, $3, $4, $5)',
          [d.chave ?? CHAVE, d.conviteId ?? null, d.sucesso, d.motivo ?? null, d.cooldownAte ?? null],
        );
        return { ok: true };
      } catch (erro) {
        return { ok: false, code: erro.code };
      }
    }

    test('falha sem convite identificado é aceita; sucesso exige convite', async () => {
      assert.equal((await tentar({ sucesso: false, motivo: 'CONVITE_INEXISTENTE' })).ok, true);
      assert.equal((await tentar({ sucesso: true, conviteId })).ok, true);
      assert.deepEqual(Object.values(await tentar({ sucesso: true })), [false, VIOLACAO_CHECK]);
    });

    test('coerência de motivo, sucesso e cooldown, e formato da chave', async () => {
      assert.equal((await tentar({ sucesso: false })).code, VIOLACAO_CHECK);
      assert.equal((await tentar({ sucesso: true, conviteId, motivo: 'X' })).code, VIOLACAO_CHECK);
      assert.equal((await tentar({ sucesso: false, motivo: 'SENHA_INVALIDA', cooldownAte: new Date(Date.now() + 60e3) })).code, VIOLACAO_CHECK);
      assert.equal((await tentar({ sucesso: false, motivo: 'COOLDOWN_ATIVADO', cooldownAte: new Date(Date.now() + 60e3) })).ok, true);
      assert.equal((await tentar({ sucesso: false, motivo: 'motivo minusculo' })).code, VIOLACAO_CHECK);
      assert.equal((await tentar({ chave: 'curta', sucesso: false, motivo: 'X' })).ok, false);
    });

    test('convite_id aponta para convites_usuario, nunca para convites_master nem id solto', async () => {
      assert.equal((await tentar({ sucesso: false, motivo: 'X', conviteId: 999999 })).code, VIOLACAO_FK);
      const erro = await q('DELETE FROM convites_usuario WHERE id = $1', [conviteId]).catch((e) => e);
      assert.equal(erro.code, VIOLACAO_FK, 'convite com tentativas não é apagado');
    });

    test('índices do cooldown por chave existem', async () => {
      const { rows } = await q(
        "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'convite_usuario_tentativas' ORDER BY indexname",
      );
      const nomes = rows.map((r) => r.indexname);
      for (const nome of ['idx_convite_usuario_tentativas_chave_criado_em', 'idx_convite_usuario_tentativas_chave_cooldown_ate']) {
        assert.ok(nomes.includes(nome), nome);
      }
    });
  });

  test('a migration 046 declara a situação derivada de timestamps, sem coluna "status"', () => {
    const sql = conteudoDaMigration('046');
    assert.match(sql, /CREATE TABLE convites_usuario/i);
    assert.match(sql, /CREATE TABLE convite_usuario_tentativas/i);
    assert.doesNotMatch(sql, /\bstatus\b\s+VARCHAR/i);
  });

  test('manifesto: entrada da 046 coerente com o arquivo; algoritmo sha256', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith('046_') && nome.endsWith('.sql'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
    assert.equal(manifesto.algoritmo, 'sha256');
    assert.equal(manifesto.migrations[arquivo], sha);
  });
});
