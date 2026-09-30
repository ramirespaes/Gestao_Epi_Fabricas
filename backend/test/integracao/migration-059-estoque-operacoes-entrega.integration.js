'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const {
  HASH, todasAsMigrations, erroDe, transacao, inserir, criarEmpresa, criarUsuario, criarFuncionario, criarMaterial,
  criarLote, criarFicha, inserirEntrega, inserirItem, inserirOperacaoEntrega, inserirConfirmacao, registrarEntrega,
} = require('./helpers/entrega-epi');

/**
 * Migration 059 — estoque_operacoes aceita ENTREGA. A operação pertence a
 * exatamente um item da entrega (FK composta com empresa, lote e quantidade),
 * não carrega chave de cliente, soma quantidade_entregue no lote e o CHECK de
 * saldo da 042 continua sendo a última barreira. PostgreSQL real, schema
 * temporário com todas as migrations do diretório.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_059 = '059_alter_estoque_operacoes_add_entrega.sql';
const TODAS = todasAsMigrations();
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';

// A regra explícita, uma linha por tipo: exige chave e hash?
const IDEMPOTENCIA_POR_TIPO = [
  ['SALDO_INICIAL', false],
  ['ENTREGA', false],
  ['ENTRADA', true],
  ['BAIXA', true],
];

describe('migration 059 — estoque_operacoes com ENTREGA', () => {
  let contexto;
  let c;
  const d = {};

  const q = (sql, params) => c.query(sql, params);
  const lote = async (id) => (await q('SELECT quantidade_entrada, quantidade_baixada, quantidade_entregue, saldo FROM estoque_lotes WHERE id = $1', [id])).rows[0];
  const entregaBase = () => ({ empresa_id: d.empresaA, ficha_id: d.fichaA.id, responsavel_id: d.usuarioA, empresa_cnpj: CNPJ_A });
  const operacao = (valores) => erroDe(inserir(c, 'estoque_operacoes', valores));

  // Cabeçalho e item abertos numa transação, para testar a operação isolada; ROLLBACK no fim.
  async function comItemAberto(fn) {
    await q('BEGIN');
    try {
      const entrega = await inserirEntrega(c, entregaBase());
      const item = await inserirItem(c, {
        empresa_id: d.empresaA, entrega_id: entrega.id, material_id: d.botinaA, lote_id: d.loteA, quantidade: 2,
      });
      return await fn(item, entrega);
    } finally {
      await q('ROLLBACK');
    }
  }

  before(async () => {
    contexto = await abrirSchemaTemporario(TODAS);
    c = contexto.cliente;
    d.empresaA = await criarEmpresa(c, CNPJ_A, 'Empresa A');
    d.empresaB = await criarEmpresa(c, CNPJ_B, 'Empresa B');
    d.usuarioA = await criarUsuario(c, d.empresaA, 'a@example.invalid');
    d.usuarioB = await criarUsuario(c, d.empresaB, 'b@example.invalid');
    d.funcionarioA = await criarFuncionario(c, d.empresaA, { matricula: 'A-1', cpf: '11111111111' });
    d.funcionarioB = await criarFuncionario(c, d.empresaB, { matricula: 'B-1', cpf: '22222222222' });
    d.botinaA = await criarMaterial(c, d.empresaA, 'Botina');
    d.botinaB = await criarMaterial(c, d.empresaB, 'Botina B');
    d.fichaA = await criarFicha(c, d.empresaA, d.funcionarioA);
    d.fichaB = await criarFicha(c, d.empresaB, d.funcionarioB);
    d.loteA = await criarLote(c, { empresaId: d.empresaA, materialId: d.botinaA, quantidade: 10 });
    d.loteA2 = await criarLote(c, { empresaId: d.empresaA, materialId: d.botinaA, quantidade: 5, tamanho: '41' });
    d.loteB = await criarLote(c, { empresaId: d.empresaB, materialId: d.botinaB, quantidade: 4 });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('estrutura: coluna entrega_item_id, CHECKs revistos, FK composta para o item, índice único parcial e gatilho adiado do item', async () => {
    const { rows: colunas } = await q(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'estoque_operacoes' AND column_name = 'entrega_item_id'",
    );
    assert.deepEqual(colunas, [{ data_type: 'integer', is_nullable: 'YES' }]);

    const { rows: constraints } = await q(
      "SELECT conname, pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid = 'estoque_operacoes'::regclass ORDER BY conname",
    );
    const definicao = (nome) => constraints.find((r) => r.conname === nome)?.definicao;
    for (const tipo of ['SALDO_INICIAL', 'ENTRADA', 'BAIXA', 'ENTREGA']) {
      assert.ok(definicao('chk_estoque_operacoes_tipo')?.includes(`'${tipo}'`), `tipo aceita ${tipo}`);
    }
    assert.ok(definicao('chk_estoque_operacoes_idempotencia')?.includes("'ENTREGA'"), 'a idempotência cita ENTREGA explicitamente');
    assert.equal(
      definicao('fk_estoque_operacoes_item_da_entrega'),
      'FOREIGN KEY (empresa_id, entrega_item_id, lote_id, quantidade) REFERENCES entregas_epi_itens(empresa_id, id, lote_id, quantidade) ON DELETE RESTRICT',
    );
    for (const nome of [
      'chk_estoque_operacoes_vinculo_entrega', 'chk_estoque_operacoes_requisicao_hash', 'chk_estoque_operacoes_motivo_da_baixa',
      'chk_estoque_operacoes_responsavel', 'chk_estoque_operacoes_quantidade', 'chk_estoque_operacoes_motivo',
      'chk_estoque_operacoes_justificativa', 'chk_estoque_operacoes_outro_justificado',
      'fk_estoque_operacoes_lote_mesma_empresa', 'fk_estoque_operacoes_usuario_mesma_empresa',
    ]) {
      assert.ok(definicao(nome), nome);
    }

    const { rows: indices } = await q(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'estoque_operacoes' AND indexname LIKE 'uq_%' ORDER BY indexname",
    );
    assert.deepEqual(indices.map((i) => i.indexname), ['uq_estoque_operacoes_entrada_do_lote', 'uq_estoque_operacoes_entrega_item', 'uq_estoque_operacoes_idempotencia']);
    assert.match(indices[1].indexdef, /UNIQUE INDEX uq_estoque_operacoes_entrega_item ON \S+ USING btree \(entrega_item_id\) WHERE \(entrega_item_id IS NOT NULL\)$/);

    const { rows: gatilho } = await q(
      "SELECT contype, condeferrable, condeferred FROM pg_constraint WHERE conname = 'trg_entregas_epi_itens_exigir_operacao' AND conrelid = 'entregas_epi_itens'::regclass",
    );
    assert.deepEqual(gatilho, [{ contype: 't', condeferrable: true, condeferred: true }]);
    // Tipo desconhecido não cabe em nenhuma das duas listas do CHECK de idempotência, que é
    // avaliado antes do CHECK de tipo (ordem alfabética); os dois o recusam.
    const tipoDesconhecido = await operacao({ empresa_id: d.empresaA, lote_id: d.loteA, tipo: 'DEVOLUCAO', quantidade: 1, usuario_id: d.usuarioA });
    assert.equal(tipoDesconhecido?.code, VIOLACAO_CHECK);
    assert.ok(['chk_estoque_operacoes_idempotencia', 'chk_estoque_operacoes_tipo'].includes(tipoDesconhecido?.constraint), tipoDesconhecido?.constraint);
  });

  test('idempotência explícita por tipo: SALDO_INICIAL e ENTREGA sem chave nem hash; ENTRADA e BAIXA com os dois; nunca só um deles', async () => {
    const chaveEHash = { chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH };
    const soChave = { chave_idempotencia: crypto.randomUUID(), requisicao_hash: null };
    const soHash = { chave_idempotencia: null, requisicao_hash: HASH };
    for (const [tipo, exigeChave] of IDEMPOTENCIA_POR_TIPO) {
      const contrarios = exigeChave ? [{}, soChave, soHash] : [chaveEHash, soChave, soHash];
      for (const valores of contrarios) {
        const erro = await comItemAberto((item) => operacao({
          empresa_id: d.empresaA, lote_id: d.loteA, tipo, quantidade: 2, usuario_id: d.usuarioA,
          motivo: tipo === 'BAIXA' ? 'AVARIA' : null,
          entrega_item_id: tipo === 'ENTREGA' ? item.id : null,
          ...valores,
        }));
        assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'chk_estoque_operacoes_idempotencia'], `${tipo} ${JSON.stringify(valores)}`);
      }
    }
  });

  test('ENTREGA sem item, item em operação de outro tipo, item inexistente, lote ou quantidade diferentes do item, empresa cruzada, sem responsável e com motivo: tudo recusado', async () => {
    const casos = [
      [{ tipo: 'ENTREGA', entrega_item_id: null }, VIOLACAO_CHECK, 'chk_estoque_operacoes_vinculo_entrega'],
      [{ tipo: 'BAIXA', motivo: 'AVARIA', chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH }, VIOLACAO_CHECK, 'chk_estoque_operacoes_vinculo_entrega'],
      [{ entrega_item_id: 999999 }, VIOLACAO_FK, 'fk_estoque_operacoes_item_da_entrega'],
      [{ lote_id: d.loteA2 }, VIOLACAO_FK, 'fk_estoque_operacoes_item_da_entrega'],
      [{ quantidade: 3 }, VIOLACAO_FK, 'fk_estoque_operacoes_item_da_entrega'],
      // Lote e usuário válidos da empresa B; só o vínculo com o item de A falha.
      [{ empresa_id: d.empresaB, lote_id: d.loteB, usuario_id: d.usuarioB }, VIOLACAO_FK, 'fk_estoque_operacoes_item_da_entrega'],
      [{ usuario_id: null }, VIOLACAO_CHECK, 'chk_estoque_operacoes_responsavel'],
      [{ motivo: 'AVARIA' }, VIOLACAO_CHECK, 'chk_estoque_operacoes_motivo_da_baixa'],
    ];
    for (const [valores, code, constraint] of casos) {
      const erro = await comItemAberto((item) => operacao({
        empresa_id: d.empresaA, lote_id: d.loteA, tipo: 'ENTREGA', quantidade: 2, usuario_id: d.usuarioA, entrega_item_id: item.id, ...valores,
      }));
      assert.deepEqual([erro?.code, erro?.constraint], [code, constraint], JSON.stringify(valores));
    }
  });

  test('segunda operação ENTREGA para o mesmo item é recusada pelo índice único parcial', async () => {
    const erro = await comItemAberto(async (item) => {
      const valores = { empresa_id: d.empresaA, lote_id: d.loteA, tipo: 'ENTREGA', quantidade: 2, usuario_id: d.usuarioA, entrega_item_id: item.id };
      assert.equal(await operacao(valores), null);
      return operacao(valores);
    });
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_UNIQUE, 'uq_estoque_operacoes_entrega_item']);
  });

  test('ENTREGA soma quantidade_entregue: o saldo cai, a entrada e a baixa não mudam; a operação fica sem chave; a reconciliação da 042 bate', async () => {
    const antes = await lote(d.loteA);
    const { itens } = await registrarEntrega(c, {
      entrega: entregaBase(),
      itens: [{ material_id: d.botinaA, lote_id: d.loteA, quantidade: 3 }],
      usuarioId: d.usuarioA,
    });
    const depois = await lote(d.loteA);
    assert.deepEqual(antes, { quantidade_entrada: 10, quantidade_baixada: 0, quantidade_entregue: 0, saldo: 10 });
    assert.deepEqual(depois, { quantidade_entrada: 10, quantidade_baixada: 0, quantidade_entregue: 3, saldo: 7 });
    const { rows: [op] } = await q(
      'SELECT tipo, quantidade, chave_idempotencia, requisicao_hash, usuario_id FROM estoque_operacoes WHERE entrega_item_id = $1',
      [itens[0].id],
    );
    assert.deepEqual(op, { tipo: 'ENTREGA', quantidade: 3, chave_idempotencia: null, requisicao_hash: null, usuario_id: d.usuarioA });
    const { rows: divergentes } = await q(
      `SELECT l.id FROM estoque_lotes l
         LEFT JOIN estoque_operacoes o ON o.empresa_id = l.empresa_id AND o.lote_id = l.id
        GROUP BY l.id, l.quantidade_baixada, l.quantidade_entregue
       HAVING l.quantidade_baixada <> COALESCE(sum(o.quantidade) FILTER (WHERE o.tipo = 'BAIXA'), 0)
           OR l.quantidade_entregue <> COALESCE(sum(o.quantidade) FILTER (WHERE o.tipo = 'ENTREGA'), 0)`,
    );
    assert.deepEqual(divergentes, []);
  });

  test('saldo negativo continua impossível: a entrega acima do saldo é recusada pelo CHECK do lote e nada fica gravado', async () => {
    const antes = await lote(d.loteA);
    const operacoesAntes = (await q('SELECT count(*)::int AS n FROM estoque_operacoes')).rows[0].n;
    const erro = await erroDe(registrarEntrega(c, {
      entrega: entregaBase(),
      itens: [{ material_id: d.botinaA, lote_id: d.loteA, quantidade: antes.saldo + 1 }],
      usuarioId: d.usuarioA,
    }));
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'chk_estoque_lotes_quantidades']);
    assert.deepEqual(await lote(d.loteA), antes);
    assert.equal((await q('SELECT count(*)::int AS n FROM estoque_operacoes')).rows[0].n, operacoesAntes);
    assert.equal((await q('SELECT count(*)::int AS n FROM entregas_epi_itens WHERE lote_id = $1 AND quantidade = $2', [d.loteA, antes.saldo + 1])).rows[0].n, 0);
  });

  test('a entrega exata do saldo restante zera o lote; depois disso nem uma unidade sai', async () => {
    const antes = await lote(d.loteA);
    await registrarEntrega(c, {
      entrega: entregaBase(),
      itens: [{ material_id: d.botinaA, lote_id: d.loteA, quantidade: antes.saldo }],
      usuarioId: d.usuarioA,
    });
    assert.equal((await lote(d.loteA)).saldo, 0);
    const erro = await erroDe(registrarEntrega(c, {
      entrega: entregaBase(),
      itens: [{ material_id: d.botinaA, lote_id: d.loteA, quantidade: 1 }],
      usuarioId: d.usuarioA,
    }));
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'chk_estoque_lotes_quantidades']);
  });

  test('item sem operação ENTREGA falha no COMMIT e nada fica gravado', async () => {
    const antes = (await q('SELECT count(*)::int AS n FROM entregas_epi_itens')).rows[0].n;
    await q('BEGIN');
    const entrega = await inserirEntrega(c, entregaBase());
    await inserirItem(c, { empresa_id: d.empresaA, entrega_id: entrega.id, material_id: d.botinaA, lote_id: d.loteA2, quantidade: 1 });
    await inserirConfirmacao(c, { empresa_id: d.empresaA, entrega_id: entrega.id });
    const erro = await erroDe(q('COMMIT'));
    assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, 'trg_entregas_epi_itens_exigir_operacao']);
    assert.equal((await q('SELECT count(*)::int AS n FROM entregas_epi_itens')).rows[0].n, antes);
    assert.equal((await lote(d.loteA2)).quantidade_entregue, 0);
  });

  test('operação ENTREGA repetida para um item já gravado em outra transação é recusada', async () => {
    const { itens } = await registrarEntrega(c, {
      entrega: entregaBase(),
      itens: [{ material_id: d.botinaA, lote_id: d.loteA2, quantidade: 1 }],
      usuarioId: d.usuarioA,
    });
    const repetida = await operacao({
      empresa_id: d.empresaA, lote_id: d.loteA2, tipo: 'ENTREGA', quantidade: 1, usuario_id: d.usuarioA, entrega_item_id: itens[0].id,
    });
    assert.deepEqual([repetida?.code, repetida?.constraint], [VIOLACAO_UNIQUE, 'uq_estoque_operacoes_entrega_item']);
    assert.equal((await lote(d.loteA2)).quantidade_entregue, 1);
  });

  test('comportamento antigo preservado: ENTRADA com chave e hash cria lote; BAIXA soma quantidade_baixada; sem chave, com hash inválido ou acima do saldo continuam recusadas', async () => {
    const loteEntrada = await transacao(c, async (t) => {
      const novo = await inserir(t, 'estoque_lotes', {
        empresa_id: d.empresaA, material_id: d.botinaA, tamanho: '42', ca_numero: '777', ca_validade: '2099-01-01',
        origem: 'ENTRADA', quantidade_entrada: 6,
      });
      await inserir(t, 'estoque_operacoes', {
        empresa_id: d.empresaA, lote_id: novo.id, tipo: 'ENTRADA', quantidade: 6, usuario_id: d.usuarioA,
        chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
      });
      return novo.id;
    });
    assert.equal(await operacao({
      empresa_id: d.empresaA, lote_id: loteEntrada, tipo: 'BAIXA', quantidade: 2, motivo: 'AVARIA', usuario_id: d.usuarioA,
      chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
    }), null);
    assert.deepEqual(await lote(loteEntrada), { quantidade_entrada: 6, quantidade_baixada: 2, quantidade_entregue: 0, saldo: 4 });

    const entradaSemChave = await erroDe(transacao(c, async (t) => {
      const novo = await inserir(t, 'estoque_lotes', {
        empresa_id: d.empresaA, material_id: d.botinaA, tamanho: '43', ca_numero: '777', ca_validade: '2099-01-01',
        origem: 'ENTRADA', quantidade_entrada: 1,
      });
      await inserir(t, 'estoque_operacoes', { empresa_id: d.empresaA, lote_id: novo.id, tipo: 'ENTRADA', quantidade: 1, usuario_id: d.usuarioA });
    }));
    assert.deepEqual([entradaSemChave?.code, entradaSemChave?.constraint], [VIOLACAO_CHECK, 'chk_estoque_operacoes_idempotencia']);
    const baixaSemChave = await operacao({
      empresa_id: d.empresaA, lote_id: loteEntrada, tipo: 'BAIXA', quantidade: 1, motivo: 'AVARIA', usuario_id: d.usuarioA,
    });
    assert.deepEqual([baixaSemChave?.code, baixaSemChave?.constraint], [VIOLACAO_CHECK, 'chk_estoque_operacoes_idempotencia']);
    const hashInvalido = await operacao({
      empresa_id: d.empresaA, lote_id: loteEntrada, tipo: 'BAIXA', quantidade: 1, motivo: 'AVARIA', usuario_id: d.usuarioA,
      chave_idempotencia: crypto.randomUUID(), requisicao_hash: 'Z'.repeat(64),
    });
    assert.deepEqual([hashInvalido?.code, hashInvalido?.constraint], [VIOLACAO_CHECK, 'chk_estoque_operacoes_requisicao_hash']);
    const baixaAcima = await operacao({
      empresa_id: d.empresaA, lote_id: loteEntrada, tipo: 'BAIXA', quantidade: 5, motivo: 'AVARIA', usuario_id: d.usuarioA,
      chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
    });
    assert.deepEqual([baixaAcima?.code, baixaAcima?.constraint], [VIOLACAO_CHECK, 'chk_estoque_lotes_quantidades']);
  });

  test('baixa e entrega dividem o mesmo saldo: o CHECK do lote considera as duas saídas', async () => {
    const loteMisto = await criarLote(c, { empresaId: d.empresaA, materialId: d.botinaA, quantidade: 5, tamanho: '44' });
    await registrarEntrega(c, {
      entrega: entregaBase(),
      itens: [{ material_id: d.botinaA, lote_id: loteMisto, quantidade: 3 }],
      usuarioId: d.usuarioA,
    });
    const baixaAcima = await operacao({
      empresa_id: d.empresaA, lote_id: loteMisto, tipo: 'BAIXA', quantidade: 3, motivo: 'AVARIA', usuario_id: d.usuarioA,
      chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
    });
    assert.deepEqual([baixaAcima?.code, baixaAcima?.constraint], [VIOLACAO_CHECK, 'chk_estoque_lotes_quantidades']);
    assert.equal(await operacao({
      empresa_id: d.empresaA, lote_id: loteMisto, tipo: 'BAIXA', quantidade: 2, motivo: 'AVARIA', usuario_id: d.usuarioA,
      chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
    }), null);
    assert.deepEqual(await lote(loteMisto), { quantidade_entrada: 5, quantidade_baixada: 2, quantidade_entregue: 3, saldo: 0 });
  });

  test('proteger_estoque_lote não foi enfraquecido: quantidade_entregue não muda por UPDATE direto; operações continuam append-only', async () => {
    const direto = await erroDe(q('UPDATE estoque_lotes SET quantidade_entregue = 0 WHERE id = $1', [d.loteA]));
    assert.equal(direto?.code, RECUSA_DO_TRIGGER);
    const { rows: [op] } = await q("SELECT id FROM estoque_operacoes WHERE tipo = 'ENTREGA' LIMIT 1");
    assert.equal((await erroDe(q('UPDATE estoque_operacoes SET entrega_item_id = NULL WHERE id = $1', [op.id])))?.code, RECUSA_DO_TRIGGER);
    assert.equal((await erroDe(q('DELETE FROM estoque_operacoes WHERE id = $1', [op.id])))?.code, RECUSA_DO_TRIGGER);
  });

  test('manifesto: entrada da 059 coerente com o arquivo', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_059))).digest('hex');
    assert.equal(manifesto.migrations[ARQUIVO_059], sha);
  });
});

describe('migration 059 — concorrência (PostgreSQL real, conexões simultâneas)', () => {
  let contexto;
  const d = {};

  const q = (sql, params) => contexto.pool.query(sql, params);

  // A conexão A monta a entrega e trava o lote com a operação ENTREGA. A
  // conexão B abre a sua entrega e precisa ficar esperando esse lock de
  // verdade (no item, pela FK para o lote, ou na própria operação) antes do
  // COMMIT de A — nada de espera por tempo.
  async function entregasSimultaneas(loteId, quantidadeA, quantidadeB) {
    const clienteA = await contexto.pool.connect();
    const clienteB = await contexto.pool.connect();
    const admin = await contexto.pool.connect();
    const cabecalho = { empresa_id: d.empresa, ficha_id: d.ficha.id, responsavel_id: d.usuario, empresa_cnpj: CNPJ_A };
    const item = (entregaId, quantidade) => ({ empresa_id: d.empresa, entrega_id: entregaId, material_id: d.material, lote_id: loteId, quantidade });
    const operar = (cliente, linha) => inserirOperacaoEntrega(cliente, {
      empresa_id: d.empresa, lote_id: loteId, quantidade: linha.quantidade, usuario_id: d.usuario, entrega_item_id: linha.id,
    });
    const confirmar = (cliente, entregaId) => inserirConfirmacao(cliente, { empresa_id: d.empresa, entrega_id: entregaId });
    try {
      await clienteA.query('BEGIN');
      const entregaA = await inserirEntrega(clienteA, cabecalho);
      await operar(clienteA, await inserirItem(clienteA, item(entregaA.id, quantidadeA)));

      await clienteB.query('BEGIN');
      const entregaB = await inserirEntrega(clienteB, cabecalho);
      const { rows: [{ pid }] } = await clienteB.query('SELECT pg_backend_pid() AS pid');
      const promessaB = inserirItem(clienteB, item(entregaB.id, quantidadeB))
        .then((linha) => operar(clienteB, linha))
        .then(() => null, (erro) => erro);
      const esperou = await aguardarEsperaPeloLock(admin, pid);

      await confirmar(clienteA, entregaA.id);
      await clienteA.query('COMMIT');
      const erroB = await promessaB;
      if (erroB) {
        await clienteB.query('ROLLBACK');
      } else {
        await confirmar(clienteB, entregaB.id);
        await clienteB.query('COMMIT');
      }
      return { esperou, erroB };
    } finally {
      clienteA.release();
      clienteB.release();
      admin.release();
    }
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS);
    d.empresa = await criarEmpresa(contexto.pool, CNPJ_A, 'Empresa A');
    d.usuario = await criarUsuario(contexto.pool, d.empresa, 'c@example.invalid');
    d.funcionario = await criarFuncionario(contexto.pool, d.empresa, { matricula: 'A-1', cpf: '11111111111' });
    d.material = await criarMaterial(contexto.pool, d.empresa, 'Botina');
    d.ficha = await criarFicha(contexto.pool, d.empresa, d.funcionario);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('duas entregas simultâneas no mesmo lote não ultrapassam o saldo: a segunda espera o lock do lote e é recusada', async () => {
    const loteId = await criarLote(contexto.pool, { empresaId: d.empresa, materialId: d.material, quantidade: 10 });
    const { esperou, erroB } = await entregasSimultaneas(loteId, 6, 6);
    assert.ok(['transactionid', 'tuple'].includes(esperou), `esperou o lock da linha do lote (${esperou})`);
    assert.deepEqual([erroB?.code, erroB?.constraint], [VIOLACAO_CHECK, 'chk_estoque_lotes_quantidades']);
    const { rows: [l] } = await q('SELECT quantidade_entregue, saldo FROM estoque_lotes WHERE id = $1', [loteId]);
    assert.deepEqual([l.quantidade_entregue, l.saldo], [6, 4]);
    const { rows: [{ itens, operacoes }] } = await q(
      `SELECT (SELECT count(*) FROM entregas_epi_itens WHERE lote_id = $1)::int AS itens,
              (SELECT count(*) FROM estoque_operacoes WHERE lote_id = $1 AND tipo = 'ENTREGA')::int AS operacoes`,
      [loteId],
    );
    assert.deepEqual([itens, operacoes], [1, 1]);
  });

  test('duas entregas simultâneas que cabem no saldo são ambas gravadas, em série', async () => {
    const loteId = await criarLote(contexto.pool, { empresaId: d.empresa, materialId: d.material, quantidade: 10, tamanho: '41' });
    const { erroB } = await entregasSimultaneas(loteId, 4, 6);
    assert.equal(erroB, null);
    const { rows: [l] } = await q('SELECT quantidade_entregue, saldo FROM estoque_lotes WHERE id = $1', [loteId]);
    assert.deepEqual([l.quantidade_entregue, l.saldo], [10, 0]);
  });
});
