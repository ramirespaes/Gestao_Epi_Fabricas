'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');

/**
 * Migration 052 — desafios_mfa_plataforma. PostgreSQL real, schema
 * temporário. Dependências: administradores (027), sessões (028 e as
 * constraints da 031, que também alcançam a auditoria da 029 e por isso
 * puxam 001/002/005/012/014) e fatores (049).
 */

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '031', '049', '052'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';
const hashAleatorio = () => crypto.randomBytes(32).toString('hex');

describe('migration 052 — desafios_mfa_plataforma', () => {
  let contexto;
  const a = {};
  const b = {};

  const q = (sql, params) => contexto.cliente.query(sql, params);

  async function prepararAdministrador(destino, email) {
    destino.id = (await q('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, 'h'])).rows[0].id;
    destino.fator = (await q(
      `INSERT INTO fatores_mfa_plataforma
         (fator_uid, administrador_id, tipo, estado, totp_formato_versao, totp_chave_versao, totp_nonce, totp_segredo_cifrado,
          totp_algoritmo, totp_digitos, totp_periodo, pendente_expira_em)
       VALUES ($1, $2, 'TOTP', 'PENDENTE', 1, 1, $3, $4, 'SHA1', 6, 30, now() + interval '15 minutes') RETURNING id`,
      [crypto.randomUUID(), destino.id, crypto.randomBytes(12), crypto.randomBytes(36)],
    )).rows[0].id;
    destino.sessao = (await q(
      "INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em) VALUES ($1, $2, now() + interval '8 hours') RETURNING id",
      [destino.id, hashAleatorio()],
    )).rows[0].id;
  }

  async function inserir(d) {
    try {
      const { rows } = await q(
        `INSERT INTO desafios_mfa_plataforma
           (administrador_id, token_hash, tipo, fator_pendente_id, sessao_origem_id, sessao_criada_id, desafio_anterior_id,
            criado_em, expira_em, falhas, reinicios, encerrado_em, motivo_encerramento)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [d.administradorId ?? a.id, d.tokenHash ?? hashAleatorio(), d.tipo ?? 'VERIFICACAO', d.fator ?? null, d.sessaoOrigem ?? null,
          d.sessaoCriada ?? null, d.anterior ?? null, d.criadoEm ?? new Date(), d.expiraEm ?? new Date(Date.now() + 5 * 60e3),
          d.falhas ?? 0, d.reinicios ?? 0, d.encerradoEm ?? null, d.motivo ?? null],
      );
      return { ok: true, id: rows[0].id };
    } catch (erro) {
      return { ok: false, code: erro.code, constraint: erro.constraint };
    }
  }

  before(async () => {
    contexto = await abrirSchemaTemporario(MIGRATIONS);
    await prepararAdministrador(a, 'a@safework.com.br');
    await prepararAdministrador(b, 'b@safework.com.br');
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('cada tipo aceito com os vínculos que lhe cabem', async () => {
    assert.equal((await inserir({ tipo: 'LIBERACAO' })).ok, true);
    assert.equal((await inserir({ tipo: 'VERIFICACAO' })).ok, true);
    assert.equal((await inserir({ tipo: 'CADASTRO', fator: a.fator })).ok, true);
    assert.equal((await inserir({ tipo: 'RECUPERACAO', fator: a.fator })).ok, true);
    assert.equal((await inserir({ tipo: 'SUBSTITUICAO', fator: a.fator, sessaoOrigem: a.sessao })).ok, true);
  });

  test('tipo fora da lista é recusado', async () => {
    for (const tipo of ['SESSAO', 'verificacao', '']) {
      const r = await inserir({ tipo });
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], tipo);
    }
  });

  test('fator pendente é obrigatório só para CADASTRO, RECUPERACAO e SUBSTITUICAO; sessão de origem só para SUBSTITUICAO', async () => {
    const casos = [
      { tipo: 'CADASTRO' },
      { tipo: 'RECUPERACAO' },
      { tipo: 'SUBSTITUICAO', sessaoOrigem: a.sessao },
      { tipo: 'VERIFICACAO', fator: a.fator },
      { tipo: 'LIBERACAO', fator: a.fator },
      { tipo: 'SUBSTITUICAO', fator: a.fator },
      { tipo: 'CADASTRO', fator: a.fator, sessaoOrigem: a.sessao },
      { tipo: 'VERIFICACAO', sessaoOrigem: a.sessao },
    ];
    for (const caso of casos) {
      const r = await inserir(caso);
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(caso));
    }
  });

  test('fator e sessão de outro administrador são recusados (FKs compostas)', async () => {
    const fatorAlheio = await inserir({ tipo: 'CADASTRO', fator: b.fator });
    assert.deepEqual([fatorAlheio.ok, fatorAlheio.code, fatorAlheio.constraint], [false, VIOLACAO_FK, 'fk_desafios_mfa_plataforma_fator_mesmo_administrador']);
    const sessaoAlheia = await inserir({ tipo: 'SUBSTITUICAO', fator: a.fator, sessaoOrigem: b.sessao });
    assert.deepEqual([sessaoAlheia.ok, sessaoAlheia.code, sessaoAlheia.constraint], [false, VIOLACAO_FK, 'fk_desafios_mfa_plataforma_sessao_origem_mesmo_administrador']);
  });

  test('token_hash único, SHA-256 hexadecimal minúsculo', async () => {
    const hash = hashAleatorio();
    assert.equal((await inserir({ tokenHash: hash })).ok, true);
    const dup = await inserir({ tokenHash: hash });
    assert.deepEqual([dup.ok, dup.code], [false, VIOLACAO_UNIQUE]);
    const maiusculo = await inserir({ tokenHash: hashAleatorio().toUpperCase() });
    assert.deepEqual([maiusculo.ok, maiusculo.code], [false, VIOLACAO_CHECK]);
  });

  test('prazo, falhas e reinícios dentro dos limites', async () => {
    const agora = new Date();
    const casos = [
      { criadoEm: agora, expiraEm: agora },
      { falhas: -1 },
      { falhas: 101 },
      { reinicios: -1 },
    ];
    for (const caso of casos) {
      const r = await inserir(caso);
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(caso));
    }
    assert.equal((await inserir({ falhas: 100 })).ok, true);
  });

  test('encerramento coerente: instante e motivo juntos, motivo no formato da coluna', async () => {
    for (const caso of [{ encerradoEm: new Date() }, { motivo: 'LOGOUT' }, { encerradoEm: new Date(), motivo: 'logout' }]) {
      const r = await inserir(caso);
      assert.deepEqual([r.ok, r.code], [false, VIOLACAO_CHECK], JSON.stringify(caso));
    }
    assert.equal((await inserir({ encerradoEm: new Date(), motivo: 'LOGOUT' })).ok, true);
  });

  test('sessao_criada_id só num desafio CONCLUIDO, nunca em LIBERACAO, e só com sessão do mesmo administrador', async () => {
    const aberto = await inserir({ sessaoCriada: a.sessao });
    assert.deepEqual([aberto.ok, aberto.code], [false, VIOLACAO_CHECK]);
    const liberacao = await inserir({ tipo: 'LIBERACAO', encerradoEm: new Date(), motivo: 'CONCLUIDO', sessaoCriada: a.sessao });
    assert.deepEqual([liberacao.ok, liberacao.code], [false, VIOLACAO_CHECK]);
    const transicao = await inserir({ encerradoEm: new Date(), motivo: 'TRANSICAO', sessaoCriada: a.sessao });
    assert.deepEqual([transicao.ok, transicao.code], [false, VIOLACAO_CHECK]);
    const alheia = await inserir({ encerradoEm: new Date(), motivo: 'CONCLUIDO', sessaoCriada: b.sessao });
    assert.deepEqual([alheia.ok, alheia.code, alheia.constraint], [false, VIOLACAO_FK, 'fk_desafios_mfa_plataforma_sessao_criada_mesmo_administrador']);
    assert.equal((await inserir({ encerradoEm: new Date(), motivo: 'CONCLUIDO', sessaoCriada: a.sessao })).ok, true);
  });

  test('desafio anterior: mesmo administrador, nunca o próprio; apagar o anterior só desfaz o elo', async () => {
    const anterior = (await inserir({ tipo: 'LIBERACAO', encerradoEm: new Date(), motivo: 'TRANSICAO' })).id;
    const seguinte = await inserir({ tipo: 'CADASTRO', fator: a.fator, anterior });
    assert.equal(seguinte.ok, true);
    const alheio = await inserir({ administradorId: b.id, anterior });
    assert.deepEqual([alheio.ok, alheio.code, alheio.constraint], [false, VIOLACAO_FK, 'fk_desafios_mfa_plataforma_anterior_mesmo_administrador']);

    const proprio = await q('UPDATE desafios_mfa_plataforma SET desafio_anterior_id = id WHERE id = $1', [anterior]).catch((e) => e);
    assert.equal(proprio.code, VIOLACAO_CHECK);

    await q('DELETE FROM desafios_mfa_plataforma WHERE id = $1', [anterior]);
    const { rows } = await q('SELECT desafio_anterior_id, administrador_id FROM desafios_mfa_plataforma WHERE id = $1', [seguinte.id]);
    assert.deepEqual(rows[0], { desafio_anterior_id: null, administrador_id: a.id });
  });

  test('o limite de desafios abertos não é constraint de banco (é do serviço, sob a trava do administrador)', async () => {
    const x = {};
    await prepararAdministrador(x, 'limite@safework.com.br');
    for (let i = 0; i < 7; i += 1) {
      assert.equal((await inserir({ administradorId: x.id })).ok, true, `desafio ${i + 1}`);
    }
    const { rows } = await q('SELECT count(*)::int AS n FROM desafios_mfa_plataforma WHERE administrador_id = $1 AND encerrado_em IS NULL', [x.id]);
    assert.equal(rows[0].n, 7);
  });

  test('sem IP nem User-Agent; sem coluna para o token em claro', async () => {
    const { rows } = await q(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'desafios_mfa_plataforma' ORDER BY ordinal_position`,
    );
    const colunas = rows.map((r) => r.column_name);
    assert.deepEqual(colunas, [
      'id', 'administrador_id', 'token_hash', 'tipo', 'fator_pendente_id', 'sessao_origem_id', 'sessao_criada_id',
      'desafio_anterior_id', 'criado_em', 'expira_em', 'falhas', 'reinicios', 'encerrado_em', 'motivo_encerramento',
    ]);
  });

  test('índices: abertos por administrador, prazo e elo com o anterior', async () => {
    const { rows } = await q(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'desafios_mfa_plataforma'",
    );
    const porNome = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    assert.match(porNome.idx_desafios_mfa_plataforma_administrador_abertos, /\(administrador_id\).*encerrado_em IS NULL/);
    assert.match(porNome.idx_desafios_mfa_plataforma_expira_em, /\(expira_em\)/);
    assert.match(porNome.idx_desafios_mfa_plataforma_desafio_anterior_id, /\(desafio_anterior_id\)/);
  });

  test('sessoes_plataforma ganhou (id, administrador_id) único, base das FKs compostas', async () => {
    const { rows } = await q(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'sessoes_plataforma'::regclass AND conname = 'uq_sessoes_plataforma_id_administrador'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].def, /UNIQUE \(id, administrador_id\)/);
  });

  test('manifesto: entrada da 052 coerente com o arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivo = fs.readdirSync(DIRETORIO).find((nome) => nome.startsWith('052_') && nome.endsWith('.sql'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
    assert.equal(manifesto.migrations[arquivo], sha);
    assert.match(conteudoDaMigration('052'), /CREATE TABLE desafios_mfa_plataforma/i);
  });
});
