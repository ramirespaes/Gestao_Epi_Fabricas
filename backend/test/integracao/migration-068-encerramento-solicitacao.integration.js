'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, erroDe, transacao, criarEmpresa, criarUsuario, criarGhe, criarFuncionario, criarMaterial, criarFicha,
} = require('./helpers/entrega-epi');
const {
  CNPJ_A, montarCenario, criarSolicitacao, decidirSolicitacao, cancelarSolicitacao, aprovar, reprovar, criarLoteDeEntrada,
  entregarPorSolicitacao, gravarEntregaPorSolicitacao,
} = require('./helpers/solicitacao-epi');

/**
 * Migration 068 — encerramento da solicitação de EPI aprovada que não será
 * mais entregue (D6, 12E-2), a ação ENCERRAR_SOLICITACAO no catálogo e o índice
 * de "Minhas solicitações". PostgreSQL real, schema temporário.
 *
 * ENCERRADA é terminal e só vem de APROVADA ou APROVADA_PARCIAL. Quem, quando
 * e a justificativa ficam na própria solicitação; a quantidade entregue
 * continua derivada das entregas, que não mudam. A demanda pendente sai da
 * posição porque ela só conta APROVADA e APROVADA_PARCIAL: nada de reserva,
 * contador ou alocação gravada.
 *
 * O índice (empresa_id, solicitante_usuario_id, criada_em DESC, id DESC) vem
 * do EXPLAIN da 12E-1: com cerca de 90 mil solicitações, "Minhas solicitações"
 * fazia Seq Scan em cerca de 2,6 a 3,2 ms e caiu para cerca de 0,04 ms com ele.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const TODAS = todasAsMigrations();
const ATE_A_067 = TODAS.filter((prefixo) => prefixo <= '067');
const VIOLACAO_FK = '23503';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';
const COERENCIA_DA_ENTREGA = 'trg_solicitacoes_epi_entrega_coerente';
const COERENCIA_DA_DECISAO = 'trg_solicitacoes_epi_coerencia_decisao';
const JUSTIFICATIVA = 'Trabalhador transferido para outra unidade';

const par = (erro) => [erro?.code, erro?.constraint];

function exigirMigration068() {
  assert.equal(migrationExiste('068'), true, 'migration 068 ainda não implementada');
}

const arquivoDa068 = () => fs.readdirSync(DIRETORIO).find((n) => /^068_.*\.sql$/.test(n));

// Encerra por SQL, como o repositório faz.
const encerrarSql = (executor, solicitacao, { encerradaPor, justificativa = JUSTIFICATIVA } = {}) => executor.query(
  `UPDATE solicitacoes_epi
      SET status = 'ENCERRADA', encerrada_por = $1, encerrada_em = clock_timestamp(), justificativa_encerramento = $2
    WHERE empresa_id = $3 AND id = $4
    RETURNING *`,
  [encerradaPor, justificativa, solicitacao.empresa_id, solicitacao.id],
);

describe('migration 068 — estrutura', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const definicao = async (nome) => (await q(
    "SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid = 'solicitacoes_epi'::regclass AND conname = $1", [nome],
  )).rows[0]?.definicao;

  before(async () => {
    exigirMigration068();
    contexto = await abrirSchemaTemporario(TODAS);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('o arquivo é a 068, única, e acrescenta o encerramento à solicitação', () => {
    assert.equal(fs.readdirSync(DIRETORIO).filter((n) => /^068_/.test(n)).length, 1);
    assert.match(conteudoDaMigration('068'), /ALTER TABLE solicitacoes_epi/);
    assert.ok(TODAS.includes('068'));
  });

  test('colunas novas: encerrada_por inteiro, encerrada_em com fuso e justificativa de texto, todas opcionais', async () => {
    const { rows } = await q(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'solicitacoes_epi' AND column_name IN ('encerrada_por', 'encerrada_em', 'justificativa_encerramento')
        ORDER BY ordinal_position`,
    );
    assert.deepEqual(rows.map((c) => [c.column_name, c.data_type, c.is_nullable, c.column_default]), [
      ['encerrada_por', 'integer', 'YES', null],
      ['encerrada_em', 'timestamp with time zone', 'YES', null],
      ['justificativa_encerramento', 'text', 'YES', null],
    ]);
  });

  test('quem encerra é usuário da mesma empresa: FK composta com RESTRICT, no padrão de quem decide e de quem cancela', async () => {
    assert.equal(
      await definicao('fk_solicitacoes_epi_encerrador_mesma_empresa'),
      'FOREIGN KEY (empresa_id, encerrada_por) REFERENCES usuarios(empresa_id, id) ON DELETE RESTRICT',
    );
  });

  test('status aceita ENCERRADA; a decisão continua obrigatória para ela', async () => {
    assert.match(await definicao('chk_solicitacoes_epi_status'), /'ENCERRADA'/);
    for (const status of ['PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE']) {
      assert.match(await definicao('chk_solicitacoes_epi_status'), new RegExp(`'${status}'`), status);
    }
    assert.match(await definicao('chk_solicitacoes_epi_decisao'), /'ENCERRADA'/);
  });

  test('coerência do encerramento e ordem do carimbo: CHECKs próprios', async () => {
    assert.ok(await definicao('chk_solicitacoes_epi_encerramento'));
    assert.match(await definicao('chk_solicitacoes_epi_encerramento'), /btrim\(justificativa_encerramento\) = justificativa_encerramento/);
    assert.match(await definicao('chk_solicitacoes_epi_encerramento'), /char_length\(justificativa_encerramento\) >= 1/);
    assert.match(await definicao('chk_solicitacoes_epi_encerramento'), /char_length\(justificativa_encerramento\) <= 500/);
    assert.match(await definicao('chk_solicitacoes_epi_ordem_do_encerramento'), /encerrada_em >= decidida_em/);
  });

  test('índice de "Minhas solicitações" (EXPLAIN da 12E-1): empresa, solicitante, criada_em DESC e id DESC, sem predicado', async () => {
    const { rows } = await q(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'solicitacoes_epi' AND indexname = 'idx_solicitacoes_epi_solicitante'",
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /ON \S*solicitacoes_epi USING btree \(empresa_id, solicitante_usuario_id, criada_em DESC, id DESC\)$/);
  });

  test('nenhum índice novo além do comprovado; nenhuma coluna de reserva, contador ou entregue', async () => {
    const { rows } = await q("SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'solicitacoes_epi' ORDER BY indexname");
    assert.deepEqual(rows.map((r) => r.indexname), [
      'idx_solicitacoes_epi_aprovadas', 'idx_solicitacoes_epi_funcionario', 'idx_solicitacoes_epi_pendentes', 'idx_solicitacoes_epi_solicitante',
      'solicitacoes_epi_pkey', 'uq_solicitacoes_epi_empresa_id', 'uq_solicitacoes_epi_empresa_numero', 'uq_solicitacoes_epi_idempotencia',
    ]);
    const { rows: colunas } = await q(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name IN ('solicitacoes_epi', 'solicitacoes_epi_itens')
        AND (column_name LIKE '%reserva%' OR column_name LIKE '%alocad%' OR column_name LIKE '%quantidade_entregue%' OR column_name LIKE '%quantidade_encerrada%')`,
    );
    assert.deepEqual(colunas, []);
  });

  test('catálogo: ENCERRAR_SOLICITACAO ativa, exige SST e autorização individual OBRIGATORIA, como aprovar e reprovar', async () => {
    const { rows } = await q(
      "SELECT codigo, nome, ativo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo IN ('APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO') ORDER BY codigo",
    );
    assert.deepEqual(rows.map((r) => [r.codigo, r.ativo, r.exige_sst, r.modo_autorizacao_individual]), [
      ['APROVAR_SOLICITACAO', true, true, 'OBRIGATORIA'],
      ['ENCERRAR_SOLICITACAO', true, true, 'OBRIGATORIA'],
      ['REPROVAR_SOLICITACAO', true, true, 'OBRIGATORIA'],
    ]);
    assert.equal(typeof rows.find((r) => r.codigo === 'ENCERRAR_SOLICITACAO').nome, 'string');
  });

  test('a 068 não concede a ação a ninguém: nenhuma permissão, autorização individual ou permissão de grupo nasce com ela', async () => {
    const { rows: [{ n }] } = await q(
      `SELECT (SELECT count(*) FROM permissoes_acao WHERE acao_codigo = 'ENCERRAR_SOLICITACAO')
            + (SELECT count(*) FROM usuario_autorizacoes WHERE acao_codigo = 'ENCERRAR_SOLICITACAO')
            + (SELECT count(*) FROM grupo_permissoes_acao WHERE acao_codigo = 'ENCERRAR_SOLICITACAO') AS n`,
    );
    assert.equal(Number(n), 0);
    assert.doesNotMatch(conteudoDaMigration('068'), /INSERT INTO (permissoes_acao|usuario_autorizacoes|grupo_permissoes_acao)/);
  });

  test('a 068 não edita nenhuma migration antiga e só acrescenta a sua entrada ao manifesto: 69 migrations, 000 a 068', () => {
    exigirMigration068();
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, 69);
    assert.equal(arquivos[0].slice(0, 3), '000');
    assert.equal(arquivos[arquivos.length - 1].slice(0, 3), '068');
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    for (const nome of arquivos) {
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, nome))).digest('hex');
      assert.equal(manifesto.migrations[nome], sha, nome);
    }
  });
});

describe('migration 068 — uma base na 067 recebe a 068 sem mudar nenhuma linha', () => {
  let contexto;

  before(async () => {
    contexto = await abrirSchemaTemporario(ATE_A_067);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('solicitações em todos os estados, com entrega parcial e total, ficam como estavam; as colunas novas nascem nulas', async () => {
    exigirMigration068();
    const c = contexto.cliente;
    const d = await montarCenario(c);
    const pendente = await criarSolicitacao(c, d, { itens: [{ material_id: d.botina }] });
    const cancelada = await criarSolicitacao(c, d, { itens: [{ material_id: d.botina }] });
    await cancelarSolicitacao(c, cancelada.solicitacao, { canceladaPor: d.solicitante });
    const reprovada = await criarSolicitacao(c, d, { itens: [{ material_id: d.botina }] });
    await decidirSolicitacao(c, reprovada.solicitacao, { status: 'REPROVADA', decididaPor: d.aprovador, decisoes: reprovada.itens.map((i) => reprovar(i)) });
    const parcial = await criarSolicitacao(c, d, { itens: [{ material_id: d.luva, quantidade: 3 }] });
    const parcialDecidida = await decidirSolicitacao(c, parcial.solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: parcial.itens.map((i) => aprovar(i)) });
    const entregue = await criarSolicitacao(c, d, { itens: [{ material_id: d.botina, quantidade: 1 }] });
    const entregueDecidida = await decidirSolicitacao(c, entregue.solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: entregue.itens.map((i) => aprovar(i)) });
    const loteLuva = await criarLoteDeEntrada(c, { empresaId: d.empresaA, materialId: d.luva, quantidade: 5, usuarioId: d.aprovador });
    const loteBotina = await criarLoteDeEntrada(c, { empresaId: d.empresaA, materialId: d.botina, quantidade: 5, usuarioId: d.aprovador });
    await entregarPorSolicitacao(c, { solicitacao: parcialDecidida, itens: [{ item: parcial.itens[0], loteId: loteLuva, quantidade: 1 }], usuarioId: d.aprovador });
    await entregarPorSolicitacao(c, { solicitacao: entregueDecidida, itens: [{ item: entregue.itens[0], loteId: loteBotina, quantidade: 1 }], usuarioId: d.aprovador });

    const tabelas = ['solicitacoes_epi_itens', 'entregas_epi', 'entregas_epi_itens', 'estoque_lotes', 'estoque_operacoes', 'fichas_epi', 'acoes'];
    const instantaneo = async () => {
      const lido = { solicitacoes: (await c.query('SELECT * FROM solicitacoes_epi ORDER BY id')).rows };
      for (const tabela of tabelas) lido[tabela] = (await c.query(`SELECT * FROM ${tabela} ORDER BY 1`)).rows;
      return lido;
    };
    const antes = await instantaneo();
    assert.deepEqual(antes.solicitacoes.map((s) => s.status), ['PENDENTE', 'CANCELADA', 'REPROVADA', 'APROVADA', 'ENTREGUE']);
    assert.equal(pendente.solicitacao.status, 'PENDENTE');

    await c.query(conteudoDaMigration('068'));

    const depois = await instantaneo();
    for (const tabela of tabelas.filter((t) => t !== 'acoes')) assert.deepEqual(depois[tabela], antes[tabela], `${tabela} inalterada`);
    assert.deepEqual(depois.acoes.filter((a) => a.codigo !== 'ENCERRAR_SOLICITACAO'), antes.acoes, 'as ações antigas não mudam');
    assert.deepEqual(depois.acoes.filter((a) => a.codigo === 'ENCERRAR_SOLICITACAO').length, 1);
    assert.deepEqual(
      depois.solicitacoes.map(({
        encerrada_por: por, encerrada_em: em, justificativa_encerramento: justificativa, ...resto
      }) => { assert.deepEqual([por, em, justificativa], [null, null, null]); return resto; }),
      antes.solicitacoes,
    );
  });
});

describe('migration 068 — comportamento no banco', () => {
  let contexto;
  let d;
  let n = 0;

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const c = () => contexto.cliente;

  // Material novo por teste: a coerência da entrega e o estoque são por material.
  async function material(opcoes = {}) {
    n += 1;
    return criarMaterial(c(), d.empresaA, `Material da 068 ${n}`, opcoes);
  }
  async function aprovadaCom(quantidades, { parcial = false } = {}) {
    const itens = [];
    for (const quantidade of quantidades) itens.push({ material_id: await material(), quantidade });
    const criada = await criarSolicitacao(c(), d, { itens });
    const decisoes = criada.itens.map((i, indice) => (parcial && indice === 0 ? reprovar(i) : aprovar(i)));
    const decidida = await decidirSolicitacao(c(), criada.solicitacao, { status: parcial ? 'APROVADA_PARCIAL' : 'APROVADA', decididaPor: d.aprovador, decisoes });
    return { solicitacao: decidida, itens: criada.itens };
  }
  const lote = (materialId, quantidade) => criarLoteDeEntrada(c(), { empresaId: d.empresaA, materialId, quantidade, usuarioId: d.aprovador });
  const fichaDe = async (funcionarioId) => (
    await q('SELECT id FROM fichas_epi WHERE empresa_id = $1 AND funcionario_id = $2', [d.empresaA, funcionarioId])
  ).rows[0] ?? criarFicha(c(), d.empresaA, funcionarioId);

  before(async () => {
    exigirMigration068();
    contexto = await abrirSchemaTemporario(TODAS);
    d = await montarCenario(c());
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('APROVADA sem entrega vai para ENCERRADA com quem, quando e a justificativa', async () => {
    const { solicitacao } = await aprovadaCom([2]);
    const { rows: [encerrada] } = await encerrarSql(c(), solicitacao, { encerradaPor: d.aprovador });
    assert.equal(encerrada.status, 'ENCERRADA');
    assert.deepEqual([encerrada.encerrada_por, encerrada.justificativa_encerramento], [d.aprovador, JUSTIFICATIVA]);
    assert.ok(encerrada.encerrada_em >= encerrada.decidida_em);
    assert.deepEqual([encerrada.decidida_por, encerrada.cancelada_em, encerrada.entregue_em], [d.aprovador, null, null]);
  });

  test('APROVADA_PARCIAL vai para ENCERRADA; quem encerra pode ser o próprio solicitante (sem regra de autodecisão no banco)', async () => {
    const { solicitacao } = await aprovadaCom([1, 2], { parcial: true });
    assert.equal(solicitacao.status, 'APROVADA_PARCIAL');
    const { rows: [encerrada] } = await encerrarSql(c(), solicitacao, { encerradaPor: d.solicitante });
    assert.deepEqual([encerrada.status, encerrada.encerrada_por], ['ENCERRADA', d.solicitante]);
  });

  test('com entrega parcial: encerra, e a entrega, o lote e a ficha ficam como estavam', async () => {
    const { solicitacao, itens } = await aprovadaCom([3]);
    const loteId = await lote(itens[0].material_id, 5);
    await entregarPorSolicitacao(c(), { solicitacao, itens: [{ item: itens[0], loteId, quantidade: 1 }], usuarioId: d.aprovador });
    const antes = (await q('SELECT * FROM entregas_epi_itens WHERE solicitacao_item_id = $1', [itens[0].id])).rows;
    const loteAntes = (await q('SELECT * FROM estoque_lotes WHERE id = $1', [loteId])).rows;
    await encerrarSql(c(), solicitacao, { encerradaPor: d.aprovador });
    assert.deepEqual((await q('SELECT * FROM entregas_epi_itens WHERE solicitacao_item_id = $1', [itens[0].id])).rows, antes);
    assert.deepEqual((await q('SELECT * FROM estoque_lotes WHERE id = $1', [loteId])).rows, loteAntes);
  });

  test('só APROVADA e APROVADA_PARCIAL chegam a ENCERRADA: PENDENTE, REPROVADA, CANCELADA e ENTREGUE são recusadas pelo gatilho', async () => {
    const pendente = await criarSolicitacao(c(), d, { itens: [{ material_id: await material() }] });
    const reprovada = await criarSolicitacao(c(), d, { itens: [{ material_id: await material() }] });
    const reprovadaDecidida = await decidirSolicitacao(c(), reprovada.solicitacao, { status: 'REPROVADA', decididaPor: d.aprovador, decisoes: reprovada.itens.map((i) => reprovar(i)) });
    const cancelada = await criarSolicitacao(c(), d, { itens: [{ material_id: await material() }] });
    const canceladaFeita = await cancelarSolicitacao(c(), cancelada.solicitacao, { canceladaPor: d.solicitante });
    const entregue = await aprovadaCom([1]);
    const loteId = await lote(entregue.itens[0].material_id, 1);
    await entregarPorSolicitacao(c(), { solicitacao: entregue.solicitacao, itens: [{ item: entregue.itens[0], loteId, quantidade: 1 }], usuarioId: d.aprovador });
    for (const [rotulo, alvo] of [['PENDENTE', pendente.solicitacao], ['REPROVADA', reprovadaDecidida], ['CANCELADA', canceladaFeita], ['ENTREGUE', entregue.solicitacao]]) {
      const erro = await erroDe(encerrarSql(c(), alvo, { encerradaPor: d.aprovador }));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER, rotulo);
      assert.match(erro.message, /transição de \w+ para ENCERRADA não é permitida/, rotulo);
    }
  });

  test('ENCERRADA é terminal: não volta, não vira ENTREGUE e não regrava o próprio encerramento', async () => {
    const { solicitacao } = await aprovadaCom([2]);
    await encerrarSql(c(), solicitacao, { encerradaPor: d.aprovador });
    for (const status of ['APROVADA', 'APROVADA_PARCIAL', 'ENTREGUE', 'CANCELADA', 'PENDENTE']) {
      const erro = await erroDe(q('UPDATE solicitacoes_epi SET status = $1 WHERE id = $2', [status, solicitacao.id]));
      assert.equal(erro?.code, RECUSA_DO_TRIGGER, status);
    }
    const regravar = await erroDe(encerrarSql(c(), solicitacao, { encerradaPor: d.solicitante, justificativa: 'Outra justificativa' }));
    assert.equal(regravar?.code, RECUSA_DO_TRIGGER);
    const { rows: [lida] } = await q('SELECT status, encerrada_por, justificativa_encerramento FROM solicitacoes_epi WHERE id = $1', [solicitacao.id]);
    assert.deepEqual([lida.status, lida.encerrada_por, lida.justificativa_encerramento], ['ENCERRADA', d.aprovador, JUSTIFICATIVA]);
  });

  test('ENCERRADA sem quem, quando ou justificativa é recusada pelo CHECK', async () => {
    const incompletos = [
      ['sem quem', 'encerrada_por = NULL, encerrada_em = clock_timestamp(), justificativa_encerramento = $2'],
      ['sem quando', 'encerrada_por = $1, encerrada_em = NULL, justificativa_encerramento = $2'],
      ['sem justificativa', 'encerrada_por = $1, encerrada_em = clock_timestamp(), justificativa_encerramento = NULL'],
    ];
    for (const [rotulo, campos] of incompletos) {
      const { solicitacao } = await aprovadaCom([1]);
      const erro = await erroDe(q(
        `UPDATE solicitacoes_epi SET status = 'ENCERRADA', ${campos} WHERE id = $3 AND ($1::int IS NOT NULL OR $2::text IS NOT NULL)`,
        [d.aprovador, JUSTIFICATIVA, solicitacao.id],
      ));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_encerramento'], rotulo);
    }
  });

  test('justificativa efetivamente preenchida: só espaços, tabulação, quebra de linha, espaço nas pontas e mais de 500 caracteres são recusados', async () => {
    for (const justificativa of ['   ', '\t', '\n', ' Texto ', 'Texto\u0007', 'x'.repeat(501), '']) {
      const { solicitacao } = await aprovadaCom([1]);
      const erro = await erroDe(encerrarSql(c(), solicitacao, { encerradaPor: d.aprovador, justificativa }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_encerramento'], JSON.stringify(justificativa));
    }
    const { solicitacao } = await aprovadaCom([1]);
    const { rows: [ok] } = await encerrarSql(c(), solicitacao, { encerradaPor: d.aprovador, justificativa: 'x'.repeat(500) });
    assert.equal(ok.status, 'ENCERRADA');
  });

  test('os dados de encerramento não existem fora de ENCERRADA, nem na aprovação, nem na entrega', async () => {
    const pendente = await criarSolicitacao(c(), d, { itens: [{ material_id: await material() }] });
    const naAprovacao = await erroDe(q(
      `UPDATE solicitacoes_epi SET encerrada_por = $1, encerrada_em = clock_timestamp(), justificativa_encerramento = $2 WHERE id = $3`,
      [d.aprovador, JUSTIFICATIVA, pendente.solicitacao.id],
    ));
    assert.ok([RECUSA_DO_TRIGGER, VIOLACAO_CHECK].includes(naAprovacao?.code));
    const { solicitacao, itens } = await aprovadaCom([1]);
    const loteId = await lote(itens[0].material_id, 1);
    const ficha = await fichaDe(solicitacao.funcionario_id);
    const erro = await erroDe(transacao(c(), async (t) => {
      await gravarEntregaPorSolicitacao(t, {
        solicitacao, itens: [{ item: itens[0], loteId, quantidade: 1 }], usuarioId: d.aprovador, fichaId: ficha.id, fechar: false,
      });
      await t.query(
        "UPDATE solicitacoes_epi SET status = 'ENTREGUE', entregue_em = clock_timestamp(), encerrada_por = $1, encerrada_em = clock_timestamp(), justificativa_encerramento = $2 WHERE id = $3",
        [d.aprovador, JUSTIFICATIVA, solicitacao.id],
      );
    }));
    assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_encerramento']);
  });

  test('quem encerra precisa ser usuário da mesma empresa: FK composta', async () => {
    const { solicitacao } = await aprovadaCom([1]);
    const erro = await erroDe(encerrarSql(c(), solicitacao, { encerradaPor: d.usuarioB }));
    assert.deepEqual(par(erro), [VIOLACAO_FK, 'fk_solicitacoes_epi_encerrador_mesma_empresa']);
  });

  test('o carimbo do encerramento não é anterior ao da decisão', async () => {
    const { solicitacao } = await aprovadaCom([1]);
    const erro = await erroDe(q(
      `UPDATE solicitacoes_epi SET status = 'ENCERRADA', encerrada_por = $1, encerrada_em = decidida_em - interval '1 second', justificativa_encerramento = $2 WHERE id = $3`,
      [d.aprovador, JUSTIFICATIVA, solicitacao.id],
    ));
    assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'chk_solicitacoes_epi_ordem_do_encerramento']);
  });

  test('a ENCERRADA não recebe entrega: o gatilho da 066 continua recusando tudo o que não é APROVADA ou APROVADA_PARCIAL', async () => {
    const { solicitacao, itens } = await aprovadaCom([3]);
    const loteId = await lote(itens[0].material_id, 5);
    await encerrarSql(c(), solicitacao, { encerradaPor: d.aprovador });
    const { rows: [encerrada] } = await q('SELECT * FROM solicitacoes_epi WHERE id = $1', [solicitacao.id]);
    const erro = await erroDe(entregarPorSolicitacao(c(), { solicitacao: encerrada, itens: [{ item: itens[0], loteId, quantidade: 1 }], usuarioId: d.aprovador, fechar: false }));
    assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'vinculo_solicitacao_entregavel']);
    assert.equal((await q('SELECT count(*)::int AS n FROM entregas_epi_itens WHERE solicitacao_item_id = $1', [itens[0].id])).rows[0].n, 0);
  });

  test('a conferência do COMMIT da 066 conhece ENCERRADA: entregar tudo e encerrar na mesma transação é recusado (o fechamento é ENTREGUE)', async () => {
    const { solicitacao, itens } = await aprovadaCom([2]);
    const loteId = await lote(itens[0].material_id, 2);
    const ficha = await fichaDe(solicitacao.funcionario_id);
    const erro = await erroDe(transacao(c(), async (t) => {
      await gravarEntregaPorSolicitacao(t, {
        solicitacao, itens: [{ item: itens[0], loteId, quantidade: 2 }], usuarioId: d.aprovador, fichaId: ficha.id, fechar: false,
      });
      await encerrarSql(t, solicitacao, { encerradaPor: d.aprovador });
    }));
    assert.deepEqual(par(erro), [VIOLACAO_CHECK, COERENCIA_DA_ENTREGA]);
    const { rows: [lida] } = await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [solicitacao.id]);
    assert.equal(lida.status, 'APROVADA');
  });

  test('a conferência da decisão no COMMIT aceita a ENCERRADA (itens decididos, ao menos um aprovado)', async () => {
    const { solicitacao } = await aprovadaCom([1, 1], { parcial: true });
    await transacao(c(), (t) => encerrarSql(t, solicitacao, { encerradaPor: d.aprovador }));
    const { rows: [lida] } = await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [solicitacao.id]);
    assert.equal(lida.status, 'ENCERRADA');
  });

  test('a conferência da decisão exige item aprovado na ENCERRADA: reprovar tudo, gravar APROVADA e encerrar na mesma transação é recusado no COMMIT', async () => {
    const criada = await criarSolicitacao(c(), d, { itens: [{ material_id: await material() }, { material_id: await material() }] });
    const erro = await erroDe(transacao(c(), async (t) => {
      for (const item of criada.itens) {
        await t.query(
          "UPDATE solicitacoes_epi_itens SET decisao = 'REPROVADO', quantidade_aprovada = 0, justificativa_decisao = 'Sem necessidade' WHERE id = $1", [item.id],
        );
      }
      await t.query("UPDATE solicitacoes_epi SET status = 'APROVADA', decidida_por = $1, decidida_em = clock_timestamp() WHERE id = $2", [d.aprovador, criada.solicitacao.id]);
      await encerrarSql(t, criada.solicitacao, { encerradaPor: d.aprovador });
    }));
    assert.deepEqual(par(erro), [VIOLACAO_CHECK, COERENCIA_DA_DECISAO]);
    assert.equal((await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [criada.solicitacao.id])).rows[0].status, 'PENDENTE');
  });

  test('a conferência da decisão continua barrando item sem decisão: um item novo não entra na ENCERRADA nem em nenhuma outra', async () => {
    const { solicitacao } = await aprovadaCom([1]);
    await encerrarSql(c(), solicitacao, { encerradaPor: d.aprovador });
    const erro = await erroDe(q(
      `INSERT INTO solicitacoes_epi_itens (empresa_id, solicitacao_id, material_id, tamanho, quantidade, motivo, previsto_no_ghe)
       VALUES ($1, $2, $3, '40', 1, 'ADMISSAO', true)`,
      [d.empresaA, solicitacao.id, await material()],
    ));
    assert.ok(erro, 'o item novo foi aceito');
    assert.ok([VIOLACAO_CHECK].includes(erro.code), JSON.stringify(erro));
    assert.ok(['trg_solicitacoes_epi_exigir_item', COERENCIA_DA_DECISAO].includes(erro.constraint), JSON.stringify(erro));
  });

  test('as transições antigas continuam: PENDENTE decide ou cancela, aprovada fecha ENTREGUE, e um item não aprovado não recebe entrega', async () => {
    const aprovada = await aprovadaCom([1]);
    const loteId = await lote(aprovada.itens[0].material_id, 1);
    const fechada = await entregarPorSolicitacao(c(), { solicitacao: aprovada.solicitacao, itens: [{ item: aprovada.itens[0], loteId, quantidade: 1 }], usuarioId: d.aprovador });
    assert.equal(fechada.itens.length, 1);
    assert.equal((await q('SELECT status FROM solicitacoes_epi WHERE id = $1', [aprovada.solicitacao.id])).rows[0].status, 'ENTREGUE');
    const pendente = await criarSolicitacao(c(), d, { itens: [{ material_id: await material() }] });
    assert.equal((await cancelarSolicitacao(c(), pendente.solicitacao, { canceladaPor: d.solicitante })).status, 'CANCELADA');
  });
});

describe('migration 068 — numa base sem empresas, a migration roda sozinha sobre a 067', () => {
  let contexto;

  before(async () => {
    contexto = await abrirSchemaTemporario(ATE_A_067);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('aplicada sobre a 067 vazia, cria as colunas, o índice e a ação; a empresa e o usuário criados depois encerram normalmente', async () => {
    exigirMigration068();
    const cliente = contexto.cliente;
    await cliente.query(conteudoDaMigration('068'));
    const empresa = await criarEmpresa(cliente, CNPJ_A, 'Empresa Nova Fictícia');
    const usuario = await criarUsuario(cliente, empresa, 'novo@example.invalid');
    const ghe = await criarGhe(cliente, empresa, 'GHE novo');
    const trabalhador = await criarFuncionario(cliente, empresa, { matricula: 'N-1', cpf: '55555555555', gheId: ghe });
    const materialId = await criarMaterial(cliente, empresa, 'Material novo');
    const outro = await criarUsuario(cliente, empresa, 'outro@example.invalid');
    const d = { empresaA: empresa, trabalhadorA: trabalhador, solicitante: outro, aprovador: usuario };
    const criada = await criarSolicitacao(cliente, d, { itens: [{ material_id: materialId }] });
    const decidida = await decidirSolicitacao(cliente, criada.solicitacao, { status: 'APROVADA', decididaPor: usuario, decisoes: criada.itens.map((i) => aprovar(i)) });
    const { rows: [encerrada] } = await encerrarSql(cliente, decidida, { encerradaPor: usuario });
    assert.equal(encerrada.status, 'ENCERRADA');
    assert.ok(arquivoDa068());
  });
});
