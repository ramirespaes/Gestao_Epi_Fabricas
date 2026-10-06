'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { abrirSchemaTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');

/**
 * Migration 055 — MFA obrigatório nas sessões do Painel Privado. PostgreSQL
 * real, schema temporário. Monto até a 054, gravo sessões de todas as
 * épocas e só então aplico as migrations posteriores: as que não comprovam
 * o MFA são revogadas, as demais ficam como estavam e nenhuma recebe MFA
 * que não tinha.
 */

const ATE_A_054 = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '049', '050', '051', '052', '053', '054'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVOS = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
// Só as migrations da plataforma que vêm depois da 054: as da entrega de EPI
// (057 em diante) alteram tabelas que este schema não monta.
const POSTERIORES = ['055', '056'];
const VIOLACAO_CHECK = '23514';
const TIPO_DO_METODO = { TOTP: 'VERIFICACAO', CADASTRO: 'CADASTRO', RECADASTRO: 'RECUPERACAO' };
const hashAleatorio = () => crypto.randomBytes(32).toString('hex');
const aplicarPosteriores = async (q) => { for (const p of POSTERIORES) await q(conteudoDaMigration(p)); };

async function montar() {
  const contexto = await abrirSchemaTemporario(ATE_A_054);
  const q = (sql, params) => contexto.cliente.query(sql, params);
  const admin = (await q("INSERT INTO administradores_plataforma (email, senha_hash) VALUES ('admin@safework.com.br', 'h') RETURNING id")).rows[0].id;
  const fatorUid = crypto.randomUUID();
  const envelope = mfaCripto.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: admin, fatorUid });
  const fator = await fatorRepo.criarPendenteTotp(contexto.cliente, { administradorId: admin, fatorUid, envelope, validadeMinutos: 15 });
  await fatorRepo.ativarTotp(contexto.cliente, { administradorId: admin, fatorId: fator.id, step: 1 });

  async function sessao({ metodo = null, desafio = null, revogada = null, expirada = false, verificadoHa = 30, desafioCriadoHa = 60 } = {}) {
    const { rows: [s] } = await q(
      `INSERT INTO sessoes_plataforma
         (administrador_id, token_hash, criado_em, expira_em, ultimo_uso_em, revogada_em, motivo_revogacao, mfa_verificado_em, mfa_metodo)
       VALUES ($1, $2, now() - interval '28 seconds', now() + make_interval(secs => $3), now() - interval '28 seconds',
               CASE WHEN $4::text IS NULL THEN NULL ELSE now() - interval '5 seconds' END, $4,
               CASE WHEN $5::text IS NULL THEN NULL ELSE now() - make_interval(secs => $6) END, $5)
       RETURNING id`,
      [admin, hashAleatorio(), expirada ? -5 : 8 * 3600, revogada, metodo, verificadoHa],
    );
    if (desafio !== null) {
      const origem = desafio === 'SUBSTITUICAO'
        ? (await q(
          `INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em, revogada_em, motivo_revogacao)
           VALUES ($1, $2, now() + interval '1 hour', now(), 'MFA_SUBSTITUIDO') RETURNING id`,
          [admin, hashAleatorio()],
        )).rows[0].id
        : null;
      await q(
        `INSERT INTO desafios_mfa_plataforma
           (administrador_id, token_hash, tipo, fator_pendente_id, sessao_origem_id, sessao_criada_id, criado_em, expira_em, encerrado_em, motivo_encerramento)
         VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(secs => $7), now() + interval '5 minutes', now() - interval '29 seconds', 'CONCLUIDO')`,
        [admin, hashAleatorio(), desafio, desafio === 'VERIFICACAO' ? null : fator.id, origem, s.id, desafioCriadoHa],
      );
    }
    return s.id;
  }

  const foto = async (ids) => (await q(
    `SELECT id, xmin::text AS xmin, revogada_em, motivo_revogacao, mfa_verificado_em, mfa_metodo, expira_em, ultimo_uso_em
       FROM sessoes_plataforma WHERE id = ANY($1) ORDER BY id`,
    [ids],
  )).rows;

  return { contexto, q, admin, fator, sessao, foto };
}

describe('migration 055 — MFA obrigatório nas sessões do Painel Privado', () => {
  let m;
  let compativeis;
  let incompativeis;
  let jaRevogadas;
  let antes;

  before(async () => {
    m = await montar();
    compativeis = {
      'TOTP com desafio VERIFICACAO': await m.sessao({ metodo: 'TOTP', desafio: 'VERIFICACAO' }),
      'CADASTRO com desafio CADASTRO': await m.sessao({ metodo: 'CADASTRO', desafio: 'CADASTRO' }),
      'RECADASTRO com desafio RECUPERACAO': await m.sessao({ metodo: 'RECADASTRO', desafio: 'RECUPERACAO' }),
    };
    incompativeis = {
      'sem MFA, ativa': await m.sessao(),
      'sem MFA, expirada e nunca revogada': await m.sessao({ expirada: true }),
      'TOTP declarado, sem desafio': await m.sessao({ metodo: 'TOTP' }),
      'SUBSTITUICAO com desafio SUBSTITUICAO': await m.sessao({ metodo: 'SUBSTITUICAO', desafio: 'SUBSTITUICAO' }),
      'REAUTENTICACAO sem desafio': await m.sessao({ metodo: 'REAUTENTICACAO' }),
      'TOTP com desafio CADASTRO': await m.sessao({ metodo: 'TOTP', desafio: 'CADASTRO' }),
      'TOTP verificado antes de o desafio existir': await m.sessao({ metodo: 'TOTP', desafio: 'VERIFICACAO', verificadoHa: 90, desafioCriadoHa: 60 }),
    };
    jaRevogadas = {
      'sem MFA, revogada por LOGOUT': await m.sessao({ revogada: 'LOGOUT' }),
      'TOTP, revogada por MFA_SUBSTITUIDO': await m.sessao({ metodo: 'TOTP', desafio: 'VERIFICACAO', revogada: 'MFA_SUBSTITUIDO' }),
    };
    antes = new Map((await m.foto([...Object.values(compativeis), ...Object.values(incompativeis), ...Object.values(jaRevogadas)])).map((l) => [l.id, l]));
    await aplicarPosteriores(m.q);
  });
  after(async () => { if (m) await m.contexto.encerrar(); });

  const atual = async (id) => (await m.foto([id]))[0];

  test('H. sessões que não comprovam o MFA são revogadas com MFA_OBRIGATORIO', async () => {
    for (const [rotulo, id] of Object.entries(incompativeis)) {
      const linha = await atual(id);
      assert.notEqual(linha.revogada_em, null, rotulo);
      assert.equal(linha.motivo_revogacao, 'MFA_OBRIGATORIO', rotulo);
    }
    const validas = await m.q('SELECT id FROM sessoes_plataforma WHERE revogada_em IS NULL ORDER BY id');
    assert.deepEqual(validas.rows.map((r) => r.id), Object.values(compativeis), 'só as compatíveis seguem não revogadas');
  });

  test('I. nenhuma sessão histórica recebe MFA: instante e método ficam como estavam', async () => {
    for (const [rotulo, id] of Object.entries({ ...incompativeis, ...jaRevogadas, ...compativeis })) {
      const linha = await atual(id);
      assert.deepEqual([linha.mfa_verificado_em, linha.mfa_metodo], [antes.get(id).mfa_verificado_em, antes.get(id).mfa_metodo], rotulo);
      assert.deepEqual([linha.expira_em, linha.ultimo_uso_em], [antes.get(id).expira_em, antes.get(id).ultimo_uso_em], rotulo);
    }
    assert.equal((await m.q('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE mfa_metodo IS NULL AND revogada_em IS NULL')).rows[0].n, 0);
  });

  test('sessões compatíveis e sessões já revogadas não são reescritas', async () => {
    for (const [rotulo, id] of Object.entries({ ...compativeis, ...jaRevogadas })) assert.deepEqual(await atual(id), antes.get(id), rotulo);
    assert.equal((await atual(jaRevogadas['sem MFA, revogada por LOGOUT'])).motivo_revogacao, 'LOGOUT');
  });

  test('nenhum desafio é criado, alterado ou removido', async () => {
    const { rows } = await m.q("SELECT count(*)::int AS total, count(*) FILTER (WHERE motivo_encerramento = 'CONCLUIDO')::int AS concluidos FROM desafios_mfa_plataforma");
    assert.deepEqual(rows[0], { total: 7, concluidos: 7 });
  });

  test('estrutura: CHECK de MFA obrigatório, índice único do vínculo e gatilho adiado só nas colunas que importam', async () => {
    const check = await m.q("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_sessoes_plataforma_mfa_obrigatorio' AND connamespace = current_schema()::regnamespace");
    assert.equal(check.rows.length, 1);
    assert.match(check.rows[0].def, /revogada_em IS NOT NULL/i);
    for (const metodo of ['TOTP', 'CADASTRO', 'RECADASTRO']) assert.ok(check.rows[0].def.includes(`'${metodo}'`), metodo);
    for (const metodo of ['SUBSTITUICAO', 'REAUTENTICACAO']) assert.equal(check.rows[0].def.includes(metodo), false, metodo);

    const indice = await m.q("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_desafios_mfa_plataforma_sessao_criada'");
    assert.equal(indice.rows.length, 1);
    assert.match(indice.rows[0].indexdef, /UNIQUE INDEX .*\(sessao_criada_id\) WHERE \(sessao_criada_id IS NOT NULL\)/i);

    const gatilho = await m.q(
      `SELECT t.tgdeferrable, t.tginitdeferred, pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'trg_sessoes_plataforma_desafio_concluido' AND c.relnamespace = current_schema()::regnamespace`,
    );
    assert.equal(gatilho.rows.length, 1);
    assert.deepEqual([gatilho.rows[0].tgdeferrable, gatilho.rows[0].tginitdeferred], [true, true]);
    assert.match(gatilho.rows[0].def, /AFTER INSERT OR UPDATE OF/i);
    assert.doesNotMatch(gatilho.rows[0].def, /ultimo_uso_em/i, 'renovar o uso não dispara o gatilho');
  });

  test('constraints anteriores da 054 continuam valendo', async () => {
    const { rows } = await m.q("SELECT conname FROM pg_constraint WHERE conrelid = 'sessoes_plataforma'::regclass AND conname LIKE 'chk_sessoes_plataforma_mfa%' ORDER BY conname");
    assert.deepEqual(rows.map((r) => r.conname), [
      'chk_sessoes_plataforma_mfa_antes_da_criacao', 'chk_sessoes_plataforma_mfa_coerente', 'chk_sessoes_plataforma_mfa_metodo', 'chk_sessoes_plataforma_mfa_obrigatorio',
    ]);
  });

  test('depois da migration, sessão ativa sem MFA não entra', async () => {
    const erro = await m.q(
      "INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em) VALUES ($1, $2, now() + interval '8 hours')",
      [m.admin, hashAleatorio()],
    ).then(() => null, (e) => e);
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'chk_sessoes_plataforma_mfa_obrigatorio']);
  });

  test('manifesto: uma entrada por migration, todas coerentes com os arquivos; a 055 existe e a 056 vem depois dela', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), ARQUIVOS);
    for (const arquivo of ARQUIVOS) {
      assert.equal(manifesto.migrations[arquivo], crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex'), arquivo);
    }
    for (const prefixo of POSTERIORES) {
      assert.ok(ARQUIVOS.some((n) => n.startsWith(`${prefixo}_`)), prefixo);
    }
    assert.equal(ARQUIVOS.length, 79);
  });
});

describe('migration 055 — aplicação em banco limpo, em banco só com sessões compatíveis e desfeita por ROLLBACK', () => {
  test('banco limpo: aplica sem linhas para tratar', async () => {
    const contexto = await abrirSchemaTemporario(ATE_A_054);
    try {
      const q = (sql, params) => contexto.cliente.query(sql, params);
      await aplicarPosteriores(q);
      assert.equal((await q('SELECT count(*)::int AS n FROM sessoes_plataforma')).rows[0].n, 0);
      assert.equal((await q("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'chk_sessoes_plataforma_mfa_obrigatorio' AND connamespace = current_schema()::regnamespace")).rows[0].n, 1);
    } finally {
      await contexto.encerrar();
    }
  });

  test('banco só com sessões compatíveis: nenhuma linha é revogada nem reescrita', async () => {
    const m = await montar();
    try {
      const ids = [];
      for (const metodo of ['TOTP', 'CADASTRO', 'RECADASTRO']) ids.push(await m.sessao({ metodo, desafio: TIPO_DO_METODO[metodo] }));
      const antes = await m.foto(ids);

      await aplicarPosteriores(m.q);

      assert.deepEqual(await m.foto(ids), antes);
      assert.equal((await m.q("SELECT count(*)::int AS n FROM sessoes_plataforma WHERE motivo_revogacao = 'MFA_OBRIGATORIO'")).rows[0].n, 0);
    } finally {
      await m.contexto.encerrar();
    }
  });

  test('dois desafios ligados à mesma sessão: a migration recusa e nada muda', async () => {
    const m = await montar();
    try {
      const ambigua = await m.sessao({ metodo: 'TOTP', desafio: 'VERIFICACAO' });
      await m.q(
        `INSERT INTO desafios_mfa_plataforma (administrador_id, token_hash, tipo, sessao_criada_id, criado_em, expira_em, encerrado_em, motivo_encerramento)
         VALUES ($1, $2, 'VERIFICACAO', $3, now() - interval '1 minute', now() + interval '5 minutes', now() - interval '29 seconds', 'CONCLUIDO')`,
        [m.admin, hashAleatorio(), ambigua],
      );
      const antiga = await m.sessao();
      const antes = await m.foto([ambigua, antiga]);

      await m.q('BEGIN');
      let erro;
      try {
        erro = await aplicarPosteriores(m.q).then(() => null, (e) => e);
      } finally {
        await m.q('ROLLBACK');
      }

      assert.equal(erro?.code, '23505', 'a ambiguidade precisa ser resolvida por quem opera, não pela migration');
      assert.deepEqual(await m.foto([ambigua, antiga]), antes);
      assert.equal((await m.q('SELECT count(*)::int AS n FROM desafios_mfa_plataforma')).rows[0].n, 2);
    } finally {
      await m.contexto.encerrar();
    }
  });

  test('aplicada numa transação desfeita, não deixa revogação nem estrutura', async () => {
    const m = await montar();
    try {
      const antiga = await m.sessao();
      const antes = await m.foto([antiga]);

      await m.q('BEGIN');
      try {
        await aplicarPosteriores(m.q);
        assert.equal((await m.foto([antiga]))[0].motivo_revogacao, 'MFA_OBRIGATORIO', 'dentro da transação a revogação aconteceu');
      } finally {
        await m.q('ROLLBACK');
      }

      assert.deepEqual(await m.foto([antiga]), antes);
      const sobrou = await m.q(
        `SELECT (SELECT count(*)::int FROM pg_constraint WHERE conname = 'chk_sessoes_plataforma_mfa_obrigatorio' AND connamespace = current_schema()::regnamespace) AS checks,
                (SELECT count(*)::int FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'uq_desafios_mfa_plataforma_sessao_criada') AS indices,
                (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE t.tgname = 'trg_sessoes_plataforma_desafio_concluido' AND c.relnamespace = current_schema()::regnamespace) AS gatilhos`,
      );
      assert.deepEqual(sobrou.rows[0], { checks: 0, indices: 0, gatilhos: 0 });
    } finally {
      await m.contexto.encerrar();
    }
  });
});
