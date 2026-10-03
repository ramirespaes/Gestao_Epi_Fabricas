'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { abrirPoolTemporario, conteudoDaMigration } = require('./helpers/schema-temporario');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const liberacaoRepo = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');
const codigosMfa = require('../../src/security/codigos-mfa');

/**
 * Migration 056 — inativar o administrador encerra desafios abertos, revoga
 * fatores PENDENTE e liberações abertas. PostgreSQL real, schema
 * temporário. Monto até a 055, gravo administradores com artefatos de
 * todos os estados e só então aplico a 056.
 */

const ATE_A_055 = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '049', '050', '051', '052', '053', '054', '055'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO = '056_create_trigger_inativacao_administrador_invalida_artefatos_mfa.sql';
const INATIVADO = 'ADMINISTRADOR_INATIVADO';
const hashAleatorio = () => crypto.randomBytes(32).toString('hex');

async function montar() {
  const contexto = await abrirPoolTemporario(ATE_A_055);
  const { pool } = contexto;
  const q = (sql, params) => pool.query(sql, params);
  let sequencia = 0;

  async function pendente(administradorId) {
    const fatorUid = crypto.randomUUID();
    const envelope = mfaCripto.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId, fatorUid });
    return fatorRepo.criarPendenteTotp(pool, { administradorId, fatorUid, envelope, validadeMinutos: 15 });
  }

  const liberacao = (administradorId) => liberacaoRepo.criar(pool, { administradorId, codigoHash: hashAleatorio(), origem: 'CLI_LIBERACAO', validadeMinutos: 30 });

  /** Administrador com um artefato de cada estado: os que ainda valem e os que já tiveram desfecho. */
  async function administrador() {
    sequencia += 1;
    const id = (await q('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [`adm-${sequencia}@safework.com.br`, 'h'])).rows[0].id;

    const ativo = await pendente(id);
    await fatorRepo.ativarTotp(pool, { administradorId: id, fatorId: ativo.id, step: 1 });
    const revogado = await pendente(id);
    await fatorRepo.revogar(pool, { administradorId: id, fatorId: revogado.id, motivo: 'REINICIADO' });
    const emCadastro = await pendente(id);

    const lote = await loteRepo.criar(pool, id);
    const hashes = Array.from({ length: 10 }, () => codigosMfa.hashCodigoRecuperacao({ administradorId: id, codigo: codigosMfa.normalizarCodigo(codigosMfa.gerarCodigo()) }));
    await codigoRepo.inserirHashes(pool, { administradorId: id, loteId: lote.id, hashes });

    const consumida = hashAleatorio();
    await liberacaoRepo.criar(pool, { administradorId: id, codigoHash: consumida, origem: 'CLI_CRIACAO', validadeMinutos: 30 });
    await liberacaoRepo.consumir(pool, { administradorId: id, codigoHash: consumida });
    await liberacao(id);
    await liberacaoRepo.revogarAberta(pool, { administradorId: id, motivo: 'SUBSTITUIDA' });
    await liberacao(id);

    const novoDesafio = (tipo, fatorPendenteId = null) => desafioRepo.criar(pool, { administradorId: id, tokenHash: hashAleatorio(), tipo, validadeMinutos: 15, fatorPendenteId });
    await novoDesafio('VERIFICACAO');
    await novoDesafio('CADASTRO', emCadastro.id);
    const encerrado = await novoDesafio('LIBERACAO');
    await desafioRepo.encerrar(pool, { desafioId: encerrado.id, motivo: 'LOGOUT' });

    const sessao = await criarSessaoAdministrativa(pool, id);
    return { id, sessao };
  }

  const foto = async (administradorId) => ({
    desafios: (await q(
      'SELECT tipo, encerrado_em IS NULL AS aberto, motivo_encerramento AS motivo, encerrado_em, xmin::text AS xmin FROM desafios_mfa_plataforma WHERE administrador_id = $1 ORDER BY id',
      [administradorId],
    )).rows,
    fatores: (await q(
      `SELECT estado, motivo_revogacao AS motivo, revogado_em, totp_nonce IS NULL AND totp_segredo_cifrado IS NULL AS sem_segredo, xmin::text AS xmin
         FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id`,
      [administradorId],
    )).rows,
    liberacoes: (await q(
      `SELECT consumida_em IS NOT NULL AS consumida, revogada_em IS NOT NULL AS revogada, motivo_revogacao AS motivo, revogada_em, xmin::text AS xmin
         FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 ORDER BY id`,
      [administradorId],
    )).rows,
    recuperacao: (await q(
      `SELECT (SELECT array_agg(xmin::text ORDER BY id) FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND revogado_em IS NULL) AS lotes,
              (SELECT count(*)::int FROM codigos_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND consumido_em IS NULL) AS codigos`,
      [administradorId],
    )).rows[0],
    sessoes: (await q('SELECT revogada_em IS NOT NULL AS revogada, motivo_revogacao AS motivo FROM sessoes_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId])).rows,
  });

  const resumo = (f) => ({
    desafios: f.desafios.map((d) => [d.tipo, d.aberto, d.motivo]),
    fatores: f.fatores.map((x) => [x.estado, x.motivo, x.sem_segredo]),
    liberacoes: f.liberacoes.map((l) => [l.consumida, l.revogada, l.motivo]),
    recuperacao: [f.recuperacao.lotes.length, f.recuperacao.codigos],
  });

  const ativo = (id, valor) => q('UPDATE administradores_plataforma SET ativo = $2 WHERE id = $1', [id, valor]);
  const aplicar = (executor = pool) => executor.query(conteudoDaMigration('056'));

  return { contexto, pool, q, administrador, foto, resumo, ativo, aplicar };
}

// O último desafio é o que comprova a sessão: concluído, não pode ser tocado.
const ANTES = {
  desafios: [['VERIFICACAO', true, null], ['CADASTRO', true, null], ['LIBERACAO', false, 'LOGOUT'], ['VERIFICACAO', false, 'CONCLUIDO']],
  fatores: [['ATIVO', null, false], ['REVOGADO', 'REINICIADO', true], ['PENDENTE', null, false]],
  liberacoes: [[true, false, null], [false, true, 'SUBSTITUIDA'], [false, false, null]],
  recuperacao: [1, 10],
};
const INVALIDADO = {
  desafios: [['VERIFICACAO', false, INATIVADO], ['CADASTRO', false, INATIVADO], ['LIBERACAO', false, 'LOGOUT'], ['VERIFICACAO', false, 'CONCLUIDO']],
  fatores: [['ATIVO', null, false], ['REVOGADO', 'REINICIADO', true], ['REVOGADO', INATIVADO, true]],
  liberacoes: [[true, false, null], [false, true, 'SUBSTITUIDA'], [false, true, INATIVADO]],
  recuperacao: [1, 10],
};

describe('migration 056 — saneamento de quem já estava inativo', () => {
  let m;
  let inativo;
  let emAtividade;
  let antes;

  before(async () => {
    m = await montar();
    inativo = await m.administrador();
    emAtividade = await m.administrador();
    await m.ativo(inativo.id, false);
    antes = { inativo: await m.foto(inativo.id), emAtividade: await m.foto(emAtividade.id) };
    await m.aplicar();
  });
  after(async () => { if (m) await m.contexto.encerrar(); });

  test('ponto de partida: inativo antes da 056, os artefatos abertos continuavam abertos; só as sessões estavam revogadas', () => {
    assert.deepEqual(m.resumo(antes.inativo), ANTES);
    assert.deepEqual(antes.inativo.sessoes, [{ revogada: true, motivo: INATIVADO }]);
  });

  test('desafios abertos encerrados, PENDENTE revogado sem segredo e liberação aberta revogada, com ADMINISTRADOR_INATIVADO', async () => {
    assert.deepEqual(m.resumo(await m.foto(inativo.id)), INVALIDADO);
  });

  test('o que já tinha desfecho mantém motivo e instante; fator ATIVO, lote e códigos não são reescritos', async () => {
    const depois = await m.foto(inativo.id);
    assert.deepEqual(depois.desafios.slice(2), antes.inativo.desafios.slice(2));
    assert.deepEqual([depois.fatores[0], depois.fatores[1]], [antes.inativo.fatores[0], antes.inativo.fatores[1]]);
    assert.deepEqual([depois.liberacoes[0], depois.liberacoes[1]], [antes.inativo.liberacoes[0], antes.inativo.liberacoes[1]]);
    assert.deepEqual(depois.recuperacao, antes.inativo.recuperacao);
    assert.deepEqual(depois.sessoes, antes.inativo.sessoes, 'a 056 não toca em sessões');
  });

  test('administrador ativo não é tocado pelo saneamento', async () => {
    assert.deepEqual(await m.foto(emAtividade.id), antes.emAtividade);
  });

  test('instantes pelo relógio real: cada encerramento é posterior ao início da aplicação', async () => {
    const { rows: [r] } = await m.q(
      `SELECT (SELECT bool_and(encerrado_em > criado_em) FROM desafios_mfa_plataforma WHERE motivo_encerramento = $1) AS desafios,
              (SELECT bool_and(revogado_em > criado_em) FROM fatores_mfa_plataforma WHERE motivo_revogacao = $1) AS fatores,
              (SELECT bool_and(revogada_em > criado_em) FROM liberacoes_cadastro_mfa_plataforma WHERE motivo_revogacao = $1) AS liberacoes`,
      [INATIVADO],
    );
    assert.deepEqual(r, { desafios: true, fatores: true, liberacoes: true });
  });
});

describe('migration 056 — gatilho na inativação', () => {
  let m;

  before(async () => {
    m = await montar();
    await m.aplicar();
  });
  after(async () => { if (m) await m.contexto.encerrar(); });

  test('inativar: encerra e revoga o que ainda valia; fator ATIVO, lote e códigos ficam; sessão revogada pela 031, uma vez', async () => {
    const a = await m.administrador();
    assert.deepEqual(m.resumo(await m.foto(a.id)), ANTES);

    await m.ativo(a.id, false);

    const depois = await m.foto(a.id);
    assert.deepEqual(m.resumo(depois), INVALIDADO);
    assert.deepEqual(depois.sessoes, [{ revogada: true, motivo: INATIVADO }]);
  });

  test('reativar não encerra, não revoga e não reabre nada', async () => {
    const a = await m.administrador();
    await m.ativo(a.id, false);
    const inativo = await m.foto(a.id);

    await m.ativo(a.id, true);

    assert.deepEqual(await m.foto(a.id), inativo);
  });

  test('inativar de novo não reescreve o que já estava encerrado ou revogado; só o que nasceu depois', async () => {
    const a = await m.administrador();
    await m.ativo(a.id, false);
    await m.ativo(a.id, true);
    const primeira = await m.foto(a.id);
    await desafioRepo.criar(m.pool, { administradorId: a.id, tokenHash: hashAleatorio(), tipo: 'VERIFICACAO', validadeMinutos: 5 });

    await m.ativo(a.id, false);

    const segunda = await m.foto(a.id);
    assert.deepEqual(segunda.desafios.slice(0, 4), primeira.desafios, 'motivo, instante e linha iguais');
    assert.deepEqual([segunda.desafios[4].aberto, segunda.desafios[4].motivo], [false, INATIVADO]);
    assert.deepEqual([segunda.fatores, segunda.liberacoes, segunda.recuperacao], [primeira.fatores, primeira.liberacoes, primeira.recuperacao]);
  });

  test('UPDATE que não muda ativo não dispara: outra coluna, ativo repetido e inativo repetido', async () => {
    const a = await m.administrador();
    const antes = await m.foto(a.id);

    await m.q("UPDATE administradores_plataforma SET senha_hash = 'outro' WHERE id = $1", [a.id]);
    await m.ativo(a.id, true);
    assert.deepEqual(await m.foto(a.id), antes);

    const b = await m.administrador();
    await m.ativo(b.id, false);
    const inativo = await m.foto(b.id);
    await m.ativo(b.id, false);
    await m.q("UPDATE administradores_plataforma SET senha_hash = 'outro' WHERE id = $1", [b.id]);
    assert.deepEqual(await m.foto(b.id), inativo);
  });

  test('só o administrador inativado é afetado', async () => {
    const a = await m.administrador();
    const vizinho = await m.administrador();
    const antes = await m.foto(vizinho.id);

    await m.ativo(a.id, false);

    assert.deepEqual(await m.foto(vizinho.id), antes);
  });

  test('inativação desfeita por ROLLBACK não deixa nada encerrado', async () => {
    const a = await m.administrador();
    const antes = await m.foto(a.id);
    const cliente = await m.pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [a.id]);
      const dentro = await cliente.query("SELECT count(*)::int AS n FROM desafios_mfa_plataforma WHERE administrador_id = $1 AND motivo_encerramento = 'ADMINISTRADOR_INATIVADO'", [a.id]);
      assert.equal(dentro.rows[0].n, 2, 'dentro da transação o gatilho agiu');
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
    assert.deepEqual(await m.foto(a.id), antes);
  });

  test('estrutura: gatilho próprio só na transição para inativo; o gatilho e a função da 031 continuam; a 056 não escreve em sessões', async () => {
    const { rows: gatilhos } = await m.q(
      `SELECT t.tgname AS nome, p.proname AS funcao, pg_get_triggerdef(t.oid) AS definicao
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE c.relname = 'administradores_plataforma' AND c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal
          AND t.tgname LIKE '%inativar'
        ORDER BY t.tgname`,
    );
    assert.deepEqual(gatilhos.map((g) => [g.nome, g.funcao]), [
      ['trg_administradores_plataforma_invalidar_mfa_ao_inativar', 'invalidar_artefatos_mfa_administrador_inativado'],
      ['trg_administradores_plataforma_revogar_sessoes_ao_inativar', 'revogar_sessoes_administrador_inativado'],
    ]);
    for (const g of gatilhos) {
      assert.match(g.definicao, /AFTER UPDATE ON/);
      assert.match(g.definicao, /old\.ativo = true\) AND \(new\.ativo = false/i);
    }

    const sql = conteudoDaMigration('056').replace(/^\s*--.*$/gm, '');
    assert.doesNotMatch(sql, /sessoes_plataforma/);
    assert.doesNotMatch(sql, /lotes_recuperacao|codigos_recuperacao/);
    assert.doesNotMatch(sql, /\bnow\(\)/i);
    assert.doesNotMatch(sql, /^\s*(DROP|ALTER|DELETE|INSERT)\b/im);
    assert.doesNotMatch(sql, /estado\s*=\s*'ATIVO'|estado\s+IN/i, 'fator ATIVO não entra em nenhuma condição de revogação');
  });
});

describe('migration 056 — aplicação', () => {
  test('banco sem administrador inativo: aplica sem tocar em linha alguma', async () => {
    const m = await montar();
    try {
      const a = await m.administrador();
      const antes = await m.foto(a.id);
      await m.aplicar();
      assert.deepEqual(await m.foto(a.id), antes);
    } finally {
      await m.contexto.encerrar();
    }
  });

  test('aplicada numa transação desfeita, não deixa saneamento, função nem gatilho', async () => {
    const m = await montar();
    try {
      const a = await m.administrador();
      await m.ativo(a.id, false);
      const antes = await m.foto(a.id);

      const cliente = await m.pool.connect();
      try {
        await cliente.query('BEGIN');
        await m.aplicar(cliente);
        const dentro = await cliente.query("SELECT count(*)::int AS n FROM desafios_mfa_plataforma WHERE administrador_id = $1 AND motivo_encerramento = 'ADMINISTRADOR_INATIVADO'", [a.id]);
        assert.equal(dentro.rows[0].n, 2, 'dentro da transação o saneamento aconteceu');
        await cliente.query('ROLLBACK');
      } finally {
        cliente.release();
      }

      assert.deepEqual(await m.foto(a.id), antes);
      const { rows: [sobrou] } = await m.q(
        `SELECT (SELECT count(*)::int FROM pg_proc WHERE pronamespace = current_schema()::regnamespace AND proname LIKE 'invalidar_artefatos_mfa%') AS funcoes,
                (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relnamespace = current_schema()::regnamespace AND t.tgname = 'trg_administradores_plataforma_invalidar_mfa_ao_inativar') AS gatilhos`,
      );
      assert.deepEqual(sobrou, { funcoes: 0, gatilhos: 0 });
    } finally {
      await m.contexto.encerrar();
    }
  });

  test('aplicada duas vezes no mesmo banco: a segunda é recusada e nada muda', async () => {
    const m = await montar();
    try {
      const a = await m.administrador();
      await m.aplicar();
      const antes = await m.foto(a.id);

      const erro = await m.aplicar().then(() => null, (e) => e);

      assert.equal(erro?.code, '42723', 'a função já existe: quem garante a aplicação única é o runner');
      assert.deepEqual(await m.foto(a.id), antes);
    } finally {
      await m.contexto.encerrar();
    }
  });

  test('manifesto: 69 entradas, uma por arquivo, todas coerentes; a da 056 confere', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8')).migrations;
    const arquivos = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, 69);
    assert.deepEqual(Object.keys(manifesto).sort(), arquivos);
    for (const arquivo of arquivos) {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
      assert.equal(manifesto[arquivo], sha, arquivo);
    }
    assert.equal(arquivos[56], ARQUIVO);
  });
});
