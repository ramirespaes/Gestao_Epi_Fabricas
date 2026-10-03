'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, erroDe, transacao, criarMaterial, criarUsuario, criarFuncionario, criarEmpresa, criarGhe, criarLote, criarFicha, registrarEntrega,
} = require('./helpers/entrega-epi');
const {
  CNPJ_A, montarCenario, criarSolicitacao, decidirSolicitacao, cancelarSolicitacao, aprovar, reprovar, criarLoteDeEntrada, entregarDireta,
  entregueDoItem, entregarPorSolicitacao, gravarEntregaPorSolicitacao,
} = require('./helpers/solicitacao-epi');

/**
 * Migration 066 — entrega por solicitação: o vínculo entre o item da entrega e
 * o item da solicitação, a origem SOLICITACAO e as barreiras estruturais que
 * impedem entrega de item alheio, divergente, não aprovado, acima do aprovado
 * ou misturada. PostgreSQL real, schema temporário.
 *
 * A quantidade entregue de um item da solicitação é derivada das entregas
 * ligadas a ele: nada é contado em coluna. A migration só acrescenta; as
 * entregas DIRETA que já existem ficam como estão.
 *
 * Ordem das conferências na gravação de um item: BEFORE (origem, status da
 * solicitação, item aprovado, uma só solicitação por entrega, trabalhador,
 * tamanho, quantidade) → CHECK → FK (empresa, item e material) → gatilhos
 * adiados no COMMIT (entrega coerente com a solicitação). O que só se vê no
 * conjunto é provado numa transação com COMMIT.
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const ARQUIVO_066 = '066_alter_entregas_epi_origem_solicitacao.sql';
const TODAS = todasAsMigrations();
const ATE_A_065 = TODAS.filter((prefixo) => prefixo <= '065');
const VIOLACAO_FK = '23503';
const VIOLACAO_CHECK = '23514';
const RECUSA_DO_TRIGGER = 'P0001';
const COERENCIA_DA_ENTREGA = 'trg_solicitacoes_epi_entrega_coerente';

const par = (erro) => [erro?.code, erro?.constraint];

function exigirMigration066() {
  assert.equal(migrationExiste('066'), true, 'migration 066 ainda não implementada');
}

describe('migration 066 — estrutura logo após a sua aplicação', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);
  const definicao = async (tabela, nome) => (await q(
    'SELECT pg_get_constraintdef(oid) AS definicao FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2', [tabela, nome],
  )).rows[0]?.definicao;

  before(async () => {
    contexto = await abrirSchemaTemporario(TODAS);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('o arquivo da migration 066 existe', () => {
    exigirMigration066();
  });

  test('o item da entrega ganha solicitacao_item_id opcional; DIRETA continua sem vínculo', async () => {
    const { rows } = await q(
      "SELECT is_nullable, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entregas_epi_itens' AND column_name = 'solicitacao_item_id'",
    );
    assert.deepEqual(rows, [{ is_nullable: 'YES', data_type: 'integer' }]);
  });

  test('FK composta por empresa e material, sem cascata; o lado referenciado é uma unicidade (empresa, id, material)', async () => {
    assert.match(
      await definicao('entregas_epi_itens', 'fk_entregas_epi_itens_item_da_solicitacao') ?? '',
      /FOREIGN KEY \(empresa_id, solicitacao_item_id, material_id\) REFERENCES solicitacoes_epi_itens\(empresa_id, id, material_id\) ON DELETE RESTRICT/,
    );
    assert.match(
      await definicao('solicitacoes_epi_itens', 'uq_solicitacoes_epi_itens_empresa_id_material') ?? '',
      /UNIQUE \(empresa_id, id, material_id\)/,
    );
  });

  test('a origem aceita DIRETA e SOLICITACAO, e nada mais', async () => {
    const regra = await definicao('entregas_epi', 'chk_entregas_epi_origem') ?? '';
    assert.match(regra, /DIRETA/);
    assert.match(regra, /SOLICITACAO/);
    assert.doesNotMatch(regra, /AUTOATENDIMENTO|OUTRA/);
  });

  test('índice parcial por solicitacao_item_id, só das linhas ligadas, com a quantidade incluída para somar sem tocar a tabela', async () => {
    const { rows } = await q(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_entregas_epi_itens_solicitacao_item'",
    );
    assert.equal(rows.length, 1, 'índice idx_entregas_epi_itens_solicitacao_item');
    assert.match(rows[0].indexdef, /\(empresa_id, solicitacao_item_id\) INCLUDE \(quantidade\) WHERE \(solicitacao_item_id IS NOT NULL\)/);
  });

  test('gatilhos: uma conferência por linha antes da gravação e conferências adiadas no COMMIT, no item da entrega e no cabeçalho da solicitação', async () => {
    const { rows: gatilhos } = await q(
      `SELECT tgname, tgrelid::regclass::text AS tabela, (tgtype & 2) <> 0 AS antes, (tgtype & 4) <> 0 AS insercao, (tgtype & 16) <> 0 AS atualizacao
         FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
           ('trg_entregas_epi_itens_vinculo_solicitacao', 'trg_entregas_epi_itens_entrega_coerente', 'trg_solicitacoes_epi_entrega_coerente')
        ORDER BY tgname`,
    );
    assert.deepEqual(gatilhos, [
      { tgname: 'trg_entregas_epi_itens_entrega_coerente', tabela: 'entregas_epi_itens', antes: false, insercao: true, atualizacao: false },
      { tgname: 'trg_entregas_epi_itens_vinculo_solicitacao', tabela: 'entregas_epi_itens', antes: true, insercao: true, atualizacao: false },
      { tgname: 'trg_solicitacoes_epi_entrega_coerente', tabela: 'solicitacoes_epi', antes: false, insercao: false, atualizacao: true },
    ]);
    const { rows: adiados } = await q(
      `SELECT conname, condeferrable, condeferred FROM pg_constraint
        WHERE conname IN ('trg_entregas_epi_itens_entrega_coerente', 'trg_solicitacoes_epi_entrega_coerente') ORDER BY conname`,
    );
    assert.deepEqual(adiados, [
      { conname: 'trg_entregas_epi_itens_entrega_coerente', condeferrable: true, condeferred: true },
      { conname: 'trg_solicitacoes_epi_entrega_coerente', condeferrable: true, condeferred: true },
    ]);
  });

  test('nada de contador: a solicitação não ganha coluna de entregue, pendente ou reserva, e não nasce tabela nova', async () => {
    const { rows: colunas } = await q(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('solicitacoes_epi', 'solicitacoes_epi_itens')
          AND (column_name LIKE '%entregue%' OR column_name LIKE '%pendente%' OR column_name LIKE '%reserva%' OR column_name LIKE '%alocad%')`,
    );
    assert.deepEqual(colunas, [{ table_name: 'solicitacoes_epi', column_name: 'entregue_em' }], 'só o carimbo de fechamento da 065');
    const { rows: nomes } = await q("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'solicitacoes\\_epi%' ORDER BY 1");
    assert.deepEqual(nomes.map((r) => r.table_name), ['solicitacoes_epi', 'solicitacoes_epi_itens', 'solicitacoes_epi_numeracao']);
  });

  test('manifesto: entrada da 066 coerente com o arquivo; uma entrada por arquivo; 69 migrations', () => {
    exigirMigration066();
    const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, ARQUIVO_066))).digest('hex');
    assert.equal(manifesto.migrations[ARQUIVO_066], sha);
    const arquivos = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
    assert.equal(arquivos.length, 69);
    assert.deepEqual(Object.keys(manifesto.migrations).sort(), arquivos);
  });
});

describe('migration 066 — as entregas DIRETA que já existem ficam como estão', () => {
  let contexto;

  const q = (sql, params) => contexto.cliente.query(sql, params);

  before(async () => {
    contexto = await abrirSchemaTemporario(ATE_A_065);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('uma base com entregas DIRETA na 065 recebe a 066 sem alterar nenhuma linha; novas DIRETA continuam valendo', async () => {
    exigirMigration066();
    const c = contexto.cliente;
    const empresa = await criarEmpresa(c, CNPJ_A, 'Empresa Histórica Fictícia');
    const usuario = await criarUsuario(c, empresa, 'historico@example.invalid');
    const ghe = await criarGhe(c, empresa, 'GHE histórico');
    const trabalhador = await criarFuncionario(c, empresa, { matricula: 'H-1', cpf: '44444444444', gheId: ghe });
    const botina = await criarMaterial(c, empresa, 'Botina histórica');
    const luva = await criarMaterial(c, empresa, 'Luva histórica');
    const loteBotina = await criarLote(c, { empresaId: empresa, materialId: botina, quantidade: 20 });
    const loteLuva = await criarLote(c, { empresaId: empresa, materialId: luva, quantidade: 20 });
    const ficha = await criarFicha(c, empresa, trabalhador);
    const entregue = async (itens) => registrarEntrega(c, {
      entrega: { empresa_id: empresa, ficha_id: ficha.id, responsavel_id: usuario, empresa_cnpj: CNPJ_A }, itens, usuarioId: usuario,
    });
    await entregue([{ material_id: botina, lote_id: loteBotina, quantidade: 2 }]);
    await entregue([{ material_id: botina, lote_id: loteBotina, quantidade: 1 }, { material_id: luva, lote_id: loteLuva, quantidade: 3 }]);

    const tabelas = ['entregas_epi', 'estoque_operacoes', 'estoque_lotes', 'entregas_epi_confirmacoes'];
    const instantaneo = async () => {
      const lido = {};
      for (const tabela of tabelas) lido[tabela] = (await q(`SELECT * FROM ${tabela} ORDER BY 1, 2`)).rows;
      lido.itens = (await q('SELECT * FROM entregas_epi_itens ORDER BY id')).rows;
      return lido;
    };
    const antes = await instantaneo();
    assert.equal(antes.itens.length, 3);

    await q(conteudoDaMigration('066'));

    const depois = await instantaneo();
    for (const tabela of tabelas) assert.deepEqual(depois[tabela], antes[tabela], `${tabela} inalterada`);
    assert.deepEqual(
      depois.itens.map(({ solicitacao_item_id: vinculo, ...resto }) => { assert.equal(vinculo, null); return resto; }),
      antes.itens,
      'itens inalterados; o vínculo novo é nulo em todos',
    );
    assert.deepEqual(depois.entregas_epi.map((e) => e.origem), ['DIRETA', 'DIRETA']);

    const nova = await entregue([{ material_id: luva, lote_id: loteLuva, quantidade: 1 }]);
    assert.equal(nova.entrega.origem, 'DIRETA');
    assert.equal(nova.itens[0].solicitacao_item_id, null);
  });
});

describe('migration 066 — barreiras estruturais, com todas as migrations do diretório', () => {
  let contexto;
  let c;
  let d;
  let sequencia = 0;

  const q = (sql, params) => c.query(sql, params);

  const entrada = (materialId, quantidade, { tamanho = '40' } = {}) => criarLoteDeEntrada(c, {
    empresaId: d.empresaA, materialId, quantidade, usuarioId: d.aprovador, tamanho,
  });
  const novoMaterial = (opcoes = {}) => {
    sequencia += 1;
    return criarMaterial(c, d.empresaA, `Material 066 n.${sequencia}`, opcoes);
  };

  // Solicitação aprovada de um item (APROVADA; reduzida vira APROVADA_PARCIAL), com o lote do par.
  async function cenario({
    quantidade = 3, aprovada = quantidade, tamanho = '40', trabalhador = d.trabalhadorA, saldo = 50, exigeTamanho = tamanho !== null,
  } = {}) {
    const materialId = await novoMaterial({ exigeTamanho });
    const loteId = await entrada(materialId, saldo, { tamanho });
    const { solicitacao, itens } = await criarSolicitacao(c, d, {
      funcionarioId: trabalhador, itens: [{ material_id: materialId, tamanho, quantidade }],
    });
    const reduzida = aprovada < quantidade;
    const decidida = await decidirSolicitacao(c, solicitacao, {
      status: reduzida ? 'APROVADA_PARCIAL' : 'APROVADA',
      decididaPor: d.aprovador,
      decisoes: [reduzida ? aprovar(itens[0], aprovada, 'Quantidade reduzida pela SST') : aprovar(itens[0])],
    });
    return { materialId, loteId, solicitacao: decidida, item: itens[0] };
  }

  const entregar = (cen, quantidade, opcoes = {}) => entregarPorSolicitacao(c, {
    solicitacao: cen.solicitacao, usuarioId: d.aprovador, itens: [{ item: cen.item, loteId: cen.loteId, quantidade }], ...opcoes,
  });
  const statusDe = async (solicitacao) => (await q('SELECT status, entregue_em FROM solicitacoes_epi WHERE id = $1', [solicitacao.id])).rows[0];

  before(async () => {
    contexto = await abrirSchemaTemporario(TODAS);
    c = contexto.cliente;
    d = await montarCenario(c);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('o vínculo e a origem', () => {
    test('SOLICITACAO aceita o vínculo correto: a entrega fica com origem SOLICITACAO e o item aponta para o item da solicitação', async () => {
      const cen = await cenario({ quantidade: 3 });
      const { entrega, itens } = await entregar(cen, 1);
      assert.equal(entrega.origem, 'SOLICITACAO');
      assert.equal(itens[0].solicitacao_item_id, cen.item.id);
      assert.equal(itens[0].material_id, cen.materialId);
      assert.equal(await entregueDoItem(c, cen.item.id), 1);
    });

    test('DIRETA continua valendo sem vínculo, e DIRETA com vínculo é recusada', async () => {
      const cen = await cenario({ quantidade: 3 });
      const direta = await entregarDireta(c, {
        empresaId: d.empresaA, funcionarioId: d.trabalhadorA2, usuarioId: d.aprovador, materialId: cen.materialId, loteId: cen.loteId, quantidade: 1, cnpj: CNPJ_A,
      });
      assert.equal(direta.entrega.origem, 'DIRETA');
      assert.equal(direta.itens[0].solicitacao_item_id, null);
      assert.equal(await entregueDoItem(c, cen.item.id), 0, 'a entrega direta não conta como entregue do item');

      const erro = await erroDe(entregar(cen, 1, { origem: 'DIRETA' }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'vinculo_origem']);
      assert.equal(await entregueDoItem(c, cen.item.id), 0);
    });

    test('SOLICITACAO exige o vínculo em todos os itens, e uma entrega não mistura itens DIRETA e SOLICITACAO', async () => {
      const cen = await cenario({ quantidade: 3 });
      const outro = await cenario({ quantidade: 3 });
      const semVinculo = await erroDe(entregarPorSolicitacao(c, {
        solicitacao: cen.solicitacao, usuarioId: d.aprovador,
        itens: [{ item: cen.item, loteId: cen.loteId, quantidade: 1, solicitacao_item_id: null }],
      }));
      assert.deepEqual(par(semVinculo), [VIOLACAO_CHECK, 'vinculo_origem']);

      const misturada = await erroDe(entregarPorSolicitacao(c, {
        solicitacao: cen.solicitacao, usuarioId: d.aprovador,
        itens: [
          { item: cen.item, loteId: cen.loteId, quantidade: 1 },
          { item: outro.item, loteId: outro.loteId, quantidade: 1, solicitacao_item_id: null },
        ],
      }));
      assert.deepEqual(par(misturada), [VIOLACAO_CHECK, 'vinculo_origem']);
      assert.equal(await entregueDoItem(c, cen.item.id), 0);
      assert.equal(await entregueDoItem(c, outro.item.id), 0);
    });

    test('uma entrega não mistura solicitações, mesmo do mesmo trabalhador; o segundo item da mesma solicitação é aceito', async () => {
      const a = await cenario({ quantidade: 2 });
      const b = await cenario({ quantidade: 2 });
      const mistura = await erroDe(entregarPorSolicitacao(c, {
        solicitacao: a.solicitacao, usuarioId: d.aprovador,
        itens: [{ item: a.item, loteId: a.loteId, quantidade: 1 }, { item: b.item, loteId: b.loteId, quantidade: 1 }],
      }));
      assert.deepEqual(par(mistura), [VIOLACAO_CHECK, 'vinculo_solicitacao_unica']);
      assert.equal(await entregueDoItem(c, a.item.id) + await entregueDoItem(c, b.item.id), 0);

      const m1 = await novoMaterial();
      const m2 = await novoMaterial();
      const lote1 = await entrada(m1, 10);
      const lote2 = await entrada(m2, 10);
      const { solicitacao, itens } = await criarSolicitacao(c, d, {
        itens: [{ material_id: m1, tamanho: '40', quantidade: 2 }, { material_id: m2, tamanho: '40', quantidade: 1 }],
      });
      const decidida = await decidirSolicitacao(c, solicitacao, { status: 'APROVADA', decididaPor: d.aprovador, decisoes: itens.map((i) => aprovar(i)) });
      const { itens: gravados } = await entregarPorSolicitacao(c, {
        solicitacao: decidida, usuarioId: d.aprovador,
        itens: [{ item: itens[0], loteId: lote1, quantidade: 2 }, { item: itens[1], loteId: lote2, quantidade: 1 }],
      });
      assert.equal(gravados.length, 2);
      assert.equal((await statusDe(decidida)).status, 'ENTREGUE');
    });
  });

  describe('o item da solicitação tem de ser daquela empresa, daquele material, daquele tamanho e daquele trabalhador', () => {
    test('item de outra empresa: recusado pela FK composta', async () => {
      const cen = await cenario({ quantidade: 2 });
      const materialB = await criarMaterial(c, d.empresaB, 'Botina da empresa B 066');
      const aprovadorB = await criarUsuario(c, d.empresaB, `aprovador-b-066-${++sequencia}@example.invalid`);
      const { solicitacao: solicitacaoB, itens: itensB } = await criarSolicitacao(c, d, {
        empresaId: d.empresaB, funcionarioId: d.trabalhadorB, solicitanteId: d.usuarioB, itens: [{ material_id: materialB, tamanho: '40', quantidade: 2 }],
      });
      const decididaB = await decidirSolicitacao(c, solicitacaoB, { status: 'APROVADA', decididaPor: aprovadorB, decisoes: itensB.map((i) => aprovar(i)) });
      assert.equal(decididaB.status, 'APROVADA');
      // Entrega da empresa A apontando para o item da empresa B.
      const erro = await erroDe(entregarPorSolicitacao(c, {
        solicitacao: cen.solicitacao, usuarioId: d.aprovador,
        itens: [{ item: itensB[0], loteId: cen.loteId, quantidade: 1 }],
        extra: { material_id: cen.materialId },
      }));
      assert.deepEqual(par(erro), [VIOLACAO_FK, 'fk_entregas_epi_itens_item_da_solicitacao']);
      assert.equal(await entregueDoItem(c, itensB[0].id), 0);
    });

    test('material divergente: o item da entrega é de outro material que o do item da solicitação', async () => {
      const cen = await cenario({ quantidade: 2 });
      const outroMaterial = await novoMaterial();
      const outroLote = await entrada(outroMaterial, 10);
      const erro = await erroDe(entregarPorSolicitacao(c, {
        solicitacao: cen.solicitacao, usuarioId: d.aprovador,
        itens: [{ item: cen.item, loteId: outroLote, quantidade: 1 }],
        extra: { material_id: outroMaterial },
      }));
      assert.deepEqual(par(erro), [VIOLACAO_FK, 'fk_entregas_epi_itens_item_da_solicitacao']);
    });

    test('tamanho divergente: lote de outro tamanho, lote sem tamanho para item com tamanho e o inverso', async () => {
      const cen = await cenario({ quantidade: 2, tamanho: '40' });
      // A entrada segue a classificação do material; o saldo inicial migrado (042/043) é histórico e pode destoar.
      const lote41 = await entrada(cen.materialId, 10, { tamanho: '41' });
      const loteSem = await criarLote(c, { empresaId: d.empresaA, materialId: cen.materialId, quantidade: 10, tamanho: null });
      for (const loteId of [lote41, loteSem]) {
        const erro = await erroDe(entregarPorSolicitacao(c, { solicitacao: cen.solicitacao, usuarioId: d.aprovador, itens: [{ item: cen.item, loteId, quantidade: 1 }] }));
        assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'vinculo_tamanho']);
      }
      const semTamanho = await cenario({ quantidade: 2, tamanho: null });
      const lote40 = await criarLote(c, { empresaId: d.empresaA, materialId: semTamanho.materialId, quantidade: 10, tamanho: '40' });
      const inverso = await erroDe(entregarPorSolicitacao(c, { solicitacao: semTamanho.solicitacao, usuarioId: d.aprovador, itens: [{ item: semTamanho.item, loteId: lote40, quantidade: 1 }] }));
      assert.deepEqual(par(inverso), [VIOLACAO_CHECK, 'vinculo_tamanho']);
      assert.equal(await entregueDoItem(c, cen.item.id) + await entregueDoItem(c, semTamanho.item.id), 0);
      // Material sem tamanho entrega de lote sem tamanho.
      assert.equal((await entregar(semTamanho, 1)).itens[0].solicitacao_item_id, semTamanho.item.id);
    });

    test('trabalhador divergente: a ficha da entrega é de outro trabalhador que o da solicitação', async () => {
      const cen = await cenario({ quantidade: 2, trabalhador: d.trabalhadorA });
      const erro = await erroDe(entregar(cen, 1, { funcionarioId: d.trabalhadorA2 }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'vinculo_trabalhador']);
      assert.equal(await entregueDoItem(c, cen.item.id), 0);
      assert.equal((await entregar(cen, 1)).entrega.origem, 'SOLICITACAO', 'o trabalhador certo recebe');
    });
  });

  describe('o item e a solicitação têm de estar aprovados e abertos', () => {
    test('item reprovado de uma solicitação APROVADA_PARCIAL não é entregue; o aprovado é', async () => {
      const m1 = await novoMaterial();
      const m2 = await novoMaterial();
      const lote1 = await entrada(m1, 10);
      const lote2 = await entrada(m2, 10);
      const { solicitacao, itens } = await criarSolicitacao(c, d, {
        itens: [{ material_id: m1, tamanho: '40', quantidade: 2 }, { material_id: m2, tamanho: '40', quantidade: 2 }],
      });
      const decidida = await decidirSolicitacao(c, solicitacao, { status: 'APROVADA_PARCIAL', decididaPor: d.aprovador, decisoes: [aprovar(itens[0]), reprovar(itens[1])] });
      const erro = await erroDe(entregarPorSolicitacao(c, { solicitacao: decidida, usuarioId: d.aprovador, itens: [{ item: itens[1], loteId: lote2, quantidade: 1 }] }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'vinculo_item_aprovado']);
      assert.equal(await entregueDoItem(c, itens[1].id), 0);
      await entregarPorSolicitacao(c, { solicitacao: decidida, usuarioId: d.aprovador, itens: [{ item: itens[0], loteId: lote1, quantidade: 2 }] });
      assert.equal((await statusDe(decidida)).status, 'ENTREGUE', 'o item reprovado não entra na conta do fechamento');
    });

    test('solicitação PENDENTE, CANCELADA ou REPROVADA não é entregável', async () => {
      const m = await novoMaterial();
      const lote = await entrada(m, 20);
      const nova = (trabalhador) => criarSolicitacao(c, d, { funcionarioId: trabalhador, itens: [{ material_id: m, tamanho: '40', quantidade: 2 }] });
      const pendente = await nova(d.trabalhadorA);
      const cancelada = await nova(d.trabalhadorA2);
      await cancelarSolicitacao(c, cancelada.solicitacao, { canceladaPor: d.solicitante });
      const reprovada = await nova(d.trabalhadorA);
      await decidirSolicitacao(c, reprovada.solicitacao, { status: 'REPROVADA', decididaPor: d.aprovador, decisoes: [reprovar(reprovada.itens[0])] });
      for (const { solicitacao, itens } of [pendente, cancelada, reprovada]) {
        const erro = await erroDe(entregarPorSolicitacao(c, { solicitacao, usuarioId: d.aprovador, itens: [{ item: itens[0], loteId: lote, quantidade: 1 }] }));
        assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'vinculo_solicitacao_entregavel'], solicitacao.status);
        assert.equal(await entregueDoItem(c, itens[0].id), 0);
      }
    });

    test('solicitação já ENTREGUE não recebe nova entrega', async () => {
      const cen = await cenario({ quantidade: 1 });
      await entregar(cen, 1);
      assert.equal((await statusDe(cen.solicitacao)).status, 'ENTREGUE');
      const erro = await erroDe(entregar(cen, 1));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, 'vinculo_solicitacao_entregavel']);
    });
  });

  describe('quantidade entregue derivada das entregas ligadas ao item', () => {
    test('acima da quantidade aprovada é recusado, num ato só ou somando os atos; a reduzida vale pela aprovada, não pelo pedido', async () => {
      const cen = await cenario({ quantidade: 5, aprovada: 3 });
      const demais = await erroDe(entregar(cen, 4));
      assert.deepEqual(par(demais), [VIOLACAO_CHECK, 'vinculo_quantidade']);
      await entregar(cen, 2);
      const soma = await erroDe(entregar(cen, 2));
      assert.deepEqual(par(soma), [VIOLACAO_CHECK, 'vinculo_quantidade']);
      assert.equal(await entregueDoItem(c, cen.item.id), 2);
      await entregar(cen, 1);
      assert.equal(await entregueDoItem(c, cen.item.id), 3);
    });

    test('a conferência do COMMIT é a última barreira contra excesso, mesmo quando a da gravação é contornada', async () => {
      const cen = await cenario({ quantidade: 2 });
      const { rows } = await q('SELECT id FROM fichas_epi WHERE empresa_id = $1 AND funcionario_id = $2', [d.empresaA, d.trabalhadorA]);
      const ficha = rows[0] ?? await criarFicha(c, d.empresaA, d.trabalhadorA);
      const erro = await erroDe(transacao(c, async (cliente) => {
        await cliente.query('ALTER TABLE entregas_epi_itens DISABLE TRIGGER trg_entregas_epi_itens_vinculo_solicitacao');
        return gravarEntregaPorSolicitacao(cliente, {
          solicitacao: cen.solicitacao, usuarioId: d.aprovador, fichaId: ficha.id, fechar: false, itens: [{ item: cen.item, loteId: cen.loteId, quantidade: 3 }],
        });
      }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, COERENCIA_DA_ENTREGA]);
      assert.match(erro.message, /além da quantidade aprovada/);
      assert.equal(await entregueDoItem(c, cen.item.id), 0);
      const { rows: [{ ativo }] } = await q("SELECT tgenabled = 'O' AS ativo FROM pg_trigger WHERE tgname = 'trg_entregas_epi_itens_vinculo_solicitacao'");
      assert.equal(ativo, true, 'o DISABLE foi desfeito junto com a transação');
    });

    test('entrega parcial mantém a pendente e a solicitação aberta; várias entregas somam; a completa zera a pendente e fecha', async () => {
      const cen = await cenario({ quantidade: 3 });
      const pendente = async () => 3 - await entregueDoItem(c, cen.item.id);
      await entregar(cen, 1);
      assert.equal(await pendente(), 2);
      assert.deepEqual(await statusDe(cen.solicitacao), { status: 'APROVADA', entregue_em: null });
      await entregar(cen, 1);
      assert.equal(await pendente(), 1);
      assert.equal((await statusDe(cen.solicitacao)).status, 'APROVADA');
      await entregar(cen, 1);
      assert.equal(await pendente(), 0);
      const fechada = await statusDe(cen.solicitacao);
      assert.equal(fechada.status, 'ENTREGUE');
      assert.ok(fechada.entregue_em instanceof Date);
      const { rows: entregas } = await q(
        `SELECT e.id FROM entregas_epi e JOIN entregas_epi_itens i ON i.entrega_id = e.id WHERE i.solicitacao_item_id = $1`, [cen.item.id],
      );
      assert.equal(entregas.length, 3, 'cada ato é uma entrega própria');
    });

    test('um item da solicitação entregue por mais de um lote: vários itens da entrega somam no mesmo item', async () => {
      const cen = await cenario({ quantidade: 5, saldo: 3 });
      const segundoLote = await entrada(cen.materialId, 4);
      const { itens } = await entregarPorSolicitacao(c, {
        solicitacao: cen.solicitacao, usuarioId: d.aprovador,
        itens: [{ item: cen.item, loteId: cen.loteId, quantidade: 3 }, { item: cen.item, loteId: segundoLote, quantidade: 2 }],
      });
      assert.equal(itens.length, 2);
      assert.deepEqual(itens.map((i) => i.solicitacao_item_id), [cen.item.id, cen.item.id]);
      assert.equal(await entregueDoItem(c, cen.item.id), 5);
      assert.equal((await statusDe(cen.solicitacao)).status, 'ENTREGUE');
    });

    test('a mesma entrega com o mesmo lote duas vezes continua recusada pela unicidade da 058', async () => {
      const cen = await cenario({ quantidade: 4 });
      const erro = await erroDe(entregarPorSolicitacao(c, {
        solicitacao: cen.solicitacao, usuarioId: d.aprovador,
        itens: [{ item: cen.item, loteId: cen.loteId, quantidade: 1 }, { item: cen.item, loteId: cen.loteId, quantidade: 1 }],
      }));
      assert.deepEqual(par(erro), ['23505', 'uq_entregas_epi_itens_entrega_lote']);
    });
  });

  describe('o fechamento ENTREGUE confere, no COMMIT, nos dois sentidos', () => {
    test('toda a quantidade aprovada entregue e a solicitação ainda aberta: o COMMIT recusa', async () => {
      const cen = await cenario({ quantidade: 2 });
      const erro = await erroDe(entregar(cen, 2, { fechar: false }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, COERENCIA_DA_ENTREGA]);
      assert.match(erro.message, /inteiramente entregue/);
      assert.equal(await entregueDoItem(c, cen.item.id), 0, 'nada ficou gravado');
      assert.equal((await statusDe(cen.solicitacao)).status, 'APROVADA');
    });

    test('ENTREGUE com quantidade ainda pendente: o COMMIT recusa', async () => {
      const cen = await cenario({ quantidade: 3 });
      const erro = await erroDe(entregar(cen, 1, { fechar: true }));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, COERENCIA_DA_ENTREGA]);
      assert.match(erro.message, /ENTREGUE/);
      assert.equal(await entregueDoItem(c, cen.item.id), 0);
      assert.equal((await statusDe(cen.solicitacao)).status, 'APROVADA');
    });

    test('ENTREGUE sem nenhuma entrega ligada: o COMMIT recusa', async () => {
      const cen = await cenario({ quantidade: 2 });
      const erro = await erroDe(transacao(c, (cliente) => cliente.query(
        "UPDATE solicitacoes_epi SET status = 'ENTREGUE', entregue_em = clock_timestamp() WHERE id = $1", [cen.solicitacao.id],
      )));
      assert.deepEqual(par(erro), [VIOLACAO_CHECK, COERENCIA_DA_ENTREGA]);
      assert.equal((await statusDe(cen.solicitacao)).status, 'APROVADA');
    });

    test('com vários itens aprovados só fecha quando todos estão completos; item reduzido vale pela aprovada', async () => {
      const m1 = await novoMaterial();
      const m2 = await novoMaterial();
      const lote1 = await entrada(m1, 10);
      const lote2 = await entrada(m2, 10);
      const { solicitacao, itens } = await criarSolicitacao(c, d, {
        itens: [{ material_id: m1, tamanho: '40', quantidade: 4 }, { material_id: m2, tamanho: '40', quantidade: 2 }],
      });
      const decidida = await decidirSolicitacao(c, solicitacao, {
        status: 'APROVADA_PARCIAL', decididaPor: d.aprovador, decisoes: [aprovar(itens[0], 3, 'Quantidade reduzida pela SST'), aprovar(itens[1])],
      });
      const entrega = (item, loteId, quantidade, opcoes = {}) => entregarPorSolicitacao(c, { solicitacao: decidida, usuarioId: d.aprovador, itens: [{ item, loteId, quantidade }], ...opcoes });
      await entrega(itens[0], lote1, 3);
      assert.equal((await statusDe(decidida)).status, 'APROVADA_PARCIAL', 'o primeiro item completo não fecha: o segundo está pendente');
      const cedo = await erroDe(entrega(itens[1], lote2, 1, { fechar: true }));
      assert.deepEqual(par(cedo), [VIOLACAO_CHECK, COERENCIA_DA_ENTREGA]);
      await entrega(itens[1], lote2, 1);
      assert.equal((await statusDe(decidida)).status, 'APROVADA_PARCIAL');
      await entrega(itens[1], lote2, 1);
      assert.equal((await statusDe(decidida)).status, 'ENTREGUE');
    });
  });

  describe('o histórico da entrega continua só de INSERT', () => {
    test('o vínculo gravado não muda nem some', async () => {
      const cen = await cenario({ quantidade: 2 });
      const { itens } = await entregar(cen, 1);
      for (const sql of [
        'UPDATE entregas_epi_itens SET solicitacao_item_id = NULL WHERE id = $1',
        'UPDATE entregas_epi_itens SET quantidade = 2 WHERE id = $1',
        'DELETE FROM entregas_epi_itens WHERE id = $1',
      ]) {
        const erro = await erroDe(q(sql, [itens[0].id]));
        assert.equal(erro?.code, RECUSA_DO_TRIGGER, sql);
      }
      assert.equal(await entregueDoItem(c, cen.item.id), 1);
    });
  });
});
