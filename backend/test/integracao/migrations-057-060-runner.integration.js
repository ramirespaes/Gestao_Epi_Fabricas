'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { aplicarMigrations } = require('../../scripts/migrate');
const {
  HASH, erroDe, transacao, inserir, criarEmpresa, criarUsuario, criarFuncionario, criarMaterial, criarLote, criarFicha,
  registrarEntrega,
} = require('./helpers/entrega-epi');

/**
 * 057 a 060 pelo runner real, sobre um banco que já está na 056 com estoque
 * movimentado (entrada operacional, saldo inicial e baixa). É o caminho de
 * todo banco existente: as quatro entram numa transação só. Monto a
 * estrutura até a 056 pelo mesmo runner, a partir de um diretório temporário
 * com cópias dos arquivos reais, gravo o estoque e só então rodo o runner no
 * diretório real. PostgreSQL real, schema temporário; nenhum banco
 * persistente é tocado.
 */

const DIRETORIO_REAL = path.join(__dirname, '..', '..', 'migrations');
const ATE_A_056 = /^0(?:[0-4]\d|5[0-6])_.+\.sql$/;
const PENDENTES = [
  '057_alter_funcionarios_estoque_lotes_add_unicidades',
  '058_create_fichas_entregas_epi',
  '059_alter_estoque_operacoes_add_entrega',
  '060_create_entregas_epi_confirmacoes',
];
const CNPJ = '11222333000181';
const VIOLACAO_CHECK = '23514';

describe('runner real: 057 a 060 numa transação, sobre a 056 com estoque movimentado', () => {
  let contexto;
  let c;
  let diretorioAteA056;
  const d = {};
  let estoqueAntes;

  const q = (sql, params) => c.query(sql, params);
  const registradas = async () => (await q('SELECT name, run_on FROM pgmigrations ORDER BY id')).rows;
  const fotografiaDoEstoque = async () => (await q(
    `SELECT l.id, l.origem, l.quantidade_entrada, l.quantidade_baixada, l.quantidade_entregue, l.saldo,
            (SELECT json_agg(json_build_object('tipo', o.tipo, 'quantidade', o.quantidade, 'chave', o.chave_idempotencia) ORDER BY o.id)
               FROM estoque_operacoes o WHERE o.lote_id = l.id) AS operacoes
       FROM estoque_lotes l ORDER BY l.id`,
  )).rows;

  before(async () => {
    contexto = await abrirSchemaTemporario([]);
    c = contexto.cliente;
    diretorioAteA056 = fs.mkdtempSync(path.join(os.tmpdir(), 'gestao-epi-migrations-'));
    for (const nome of fs.readdirSync(DIRETORIO_REAL).filter((arquivo) => ATE_A_056.test(arquivo))) {
      fs.copyFileSync(path.join(DIRETORIO_REAL, nome), path.join(diretorioAteA056, nome));
    }
    await aplicarMigrations({ schema: contexto.schema, diretorio: diretorioAteA056 });

    d.empresa = await criarEmpresa(c, CNPJ, 'Empresa Fictícia');
    d.usuario = await criarUsuario(c, d.empresa, 'a@example.invalid');
    d.funcionario = await criarFuncionario(c, d.empresa, { matricula: 'A-1', cpf: '11111111111' });
    d.botina = await criarMaterial(c, d.empresa, 'Botina');
    d.loteEntrada = await transacao(c, async (t) => {
      const lote = await inserir(t, 'estoque_lotes', {
        empresa_id: d.empresa, material_id: d.botina, tamanho: '40', ca_numero: '12345', ca_validade: '2099-12-31',
        origem: 'ENTRADA', quantidade_entrada: 10,
      });
      await inserir(t, 'estoque_operacoes', {
        empresa_id: d.empresa, lote_id: lote.id, tipo: 'ENTRADA', quantidade: 10, usuario_id: d.usuario,
        chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
      });
      return lote.id;
    });
    d.loteInicial = await criarLote(c, { empresaId: d.empresa, materialId: d.botina, quantidade: 4, tamanho: '41' });
    await inserir(c, 'estoque_operacoes', {
      empresa_id: d.empresa, lote_id: d.loteEntrada, tipo: 'BAIXA', quantidade: 2, motivo: 'AVARIA', usuario_id: d.usuario,
      chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
    });
    estoqueAntes = await fotografiaDoEstoque();
  });

  after(async () => {
    if (diretorioAteA056) fs.rmSync(diretorioAteA056, { recursive: true, force: true });
    if (contexto) await contexto.encerrar();
  });

  test('ponto de partida: 000 a 056 aplicadas, estoque movimentado e nenhuma tabela da entrega ainda', async () => {
    const nomes = (await registradas()).map((linha) => linha.name);
    assert.equal(nomes.length, 57);
    assert.equal(nomes.at(-1), '056_create_trigger_inativacao_administrador_invalida_artefatos_mfa');
    assert.deepEqual(estoqueAntes.map((l) => [l.origem, l.quantidade_entrada, l.quantidade_baixada, l.saldo]), [['ENTRADA', 10, 2, 8], ['SALDO_INICIAL', 4, 0, 4]]);
    for (const tabela of ['fichas_epi', 'fichas_epi_numeracao', 'entregas_epi', 'entregas_epi_itens', 'entregas_epi_confirmacoes']) {
      assert.equal((await q('SELECT to_regclass($1) IS NULL AS ausente', [tabela])).rows[0].ausente, true, tabela);
    }
  });

  test('o runner aplica 057 a 060 juntas, em ordem, e registra as 61', async () => {
    const aplicadas = await aplicarMigrations({ schema: contexto.schema, diretorio: DIRETORIO_REAL });

    assert.deepEqual(aplicadas.map((migration) => migration.name), PENDENTES);
    const linhas = await registradas();
    assert.equal(linhas.length, 61);
    assert.deepEqual(linhas.slice(-PENDENTES.length).map((linha) => linha.name), PENDENTES);
  });

  // run_on é o NOW() da transação. Comparo no banco, em microssegundos.
  test('as quatro entraram numa transação só, separada da que aplicou até a 056', async () => {
    const { rows } = await q(
      `SELECT count(DISTINCT run_on) FILTER (WHERE name = ANY($1))::int AS instantes,
              count(*) FILTER (WHERE name = ANY($1))::int AS pendentes,
              bool_and(run_on <> (SELECT run_on FROM pgmigrations WHERE name LIKE '056\\_%'))
                FILTER (WHERE name = ANY($1)) AS depois_da_056
         FROM pgmigrations`,
      [PENDENTES],
    );
    assert.deepEqual(rows[0], { instantes: 1, pendentes: PENDENTES.length, depois_da_056: true });
  });

  test('o estoque existente não mudou: lotes, contadores, saldos e operações iguais aos de antes', async () => {
    assert.deepEqual(await fotografiaDoEstoque(), estoqueAntes);
    const { rows: [{ entrega_item_id }] } = await q('SELECT entrega_item_id FROM estoque_operacoes ORDER BY id LIMIT 1');
    assert.equal(entrega_item_id, null, 'as operações antigas ficam sem vínculo com item');
  });

  test('as novas chaves existem: UNIQUE em funcionarios e estoque_lotes, tipo ENTREGA, vínculo com o item', async () => {
    const { rows } = await q(
      `SELECT conname FROM pg_constraint
        WHERE connamespace = $1::regnamespace
          AND conname IN ('uq_funcionarios_empresa_id', 'uq_estoque_lotes_empresa_id_material', 'chk_estoque_operacoes_vinculo_entrega',
                          'fk_estoque_operacoes_item_da_entrega', 'trg_entregas_epi_itens_exigir_operacao', 'trg_entregas_epi_exigir_item',
                          'trg_entregas_epi_fechar_com_confirmacao')
        ORDER BY conname`,
      [contexto.schema],
    );
    assert.deepEqual(rows.map((r) => r.conname), [
      'chk_estoque_operacoes_vinculo_entrega',
      'fk_estoque_operacoes_item_da_entrega',
      'trg_entregas_epi_exigir_item',
      'trg_entregas_epi_fechar_com_confirmacao',
      'trg_entregas_epi_itens_exigir_operacao',
      'uq_estoque_lotes_empresa_id_material',
      'uq_funcionarios_empresa_id',
    ]);
  });

  test('a regra antiga continua valendo nos dados migrados: ENTRADA e BAIXA exigem chave e hash; SALDO_INICIAL não aceita', async () => {
    const baixaSemChave = await erroDe(inserir(c, 'estoque_operacoes', {
      empresa_id: d.empresa, lote_id: d.loteEntrada, tipo: 'BAIXA', quantidade: 1, motivo: 'AVARIA', usuario_id: d.usuario,
    }));
    assert.deepEqual([baixaSemChave?.code, baixaSemChave?.constraint], [VIOLACAO_CHECK, 'chk_estoque_operacoes_idempotencia']);
    const inicialComChave = await erroDe(transacao(c, async (t) => {
      const lote = await inserir(t, 'estoque_lotes', {
        empresa_id: d.empresa, material_id: d.botina, tamanho: '42', origem: 'SALDO_INICIAL', quantidade_entrada: 1,
      });
      await inserir(t, 'estoque_operacoes', {
        empresa_id: d.empresa, lote_id: lote.id, tipo: 'SALDO_INICIAL', quantidade: 1,
        chave_idempotencia: crypto.randomUUID(), requisicao_hash: HASH,
      });
    }));
    assert.deepEqual([inicialComChave?.code, inicialComChave?.constraint], [VIOLACAO_CHECK, 'chk_estoque_operacoes_idempotencia']);
  });

  test('a primeira entrega do banco migrado: ficha nº 1, item do lote antigo, operação ENTREGA e confirmação; o saldo cai', async () => {
    const ficha = await criarFicha(c, d.empresa, d.funcionario);
    assert.equal(ficha.numero, 1);
    const { entrega, itens } = await registrarEntrega(c, {
      entrega: { empresa_id: d.empresa, ficha_id: ficha.id, responsavel_id: d.usuario, empresa_cnpj: CNPJ },
      itens: [
        { material_id: d.botina, lote_id: d.loteEntrada, quantidade: 3 },
        { material_id: d.botina, lote_id: d.loteInicial, quantidade: 4 },
      ],
      usuarioId: d.usuario,
    });
    assert.equal(itens.length, 2);
    const { rows } = await q('SELECT id, quantidade_baixada, quantidade_entregue, saldo FROM estoque_lotes ORDER BY id');
    assert.deepEqual(rows, [
      { id: d.loteEntrada, quantidade_baixada: 2, quantidade_entregue: 3, saldo: 5 },
      { id: d.loteInicial, quantidade_baixada: 0, quantidade_entregue: 4, saldo: 0 },
    ]);
    const { rows: [{ n }] } = await q("SELECT count(*)::int AS n FROM estoque_operacoes WHERE tipo = 'ENTREGA' AND entrega_item_id = ANY($1)", [itens.map((i) => i.id)]);
    assert.equal(n, 2);
    const { rows: [{ confirmada }] } = await q('SELECT count(*)::int = 1 AS confirmada FROM entregas_epi_confirmacoes WHERE entrega_id = $1', [entrega.id]);
    assert.equal(confirmada, true);
  });

  test('manifesto: as quatro entradas novas conferem com os arquivos e o total é 61', () => {
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO_REAL, 'checksums.json'), 'utf8'));
    const arquivos = fs.readdirSync(DIRETORIO_REAL).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, 61);
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
    for (const nome of PENDENTES) {
      const arquivo = `${nome}.sql`;
      const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO_REAL, arquivo))).digest('hex');
      assert.equal(manifesto.migrations[arquivo], sha, arquivo);
    }
  });
});
