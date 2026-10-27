'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  abrirSchemaTemporario, abrirPoolTemporario, aguardarEsperaPeloLock, migrationExiste, conteudoDaMigration,
} = require('./helpers/schema-temporario');
const {
  todasAsMigrations, erroDe, inserir, criarEmpresa, criarUsuario,
} = require('./helpers/entrega-epi');
const { BANCO_DE_TESTE } = require('./helpers/banco-de-teste');
const {
  CNPJ_A, montarCenario, criarSolicitacao, criarSolicitacaoAprovada, criarLoteDeEntrada, entregarDireta,
} = require('./helpers/solicitacao-epi');

/**
 * Biblioteca de Imagens, Unidade 2 (RED) — migration 090: estrutura de banco das imagens de produto (contratos DB-01 a DB-08 do doc. 14).
 * PostgreSQL real, banco de teste exclusivo (helpers/banco-de-teste.js), schema temporário exclusivo; o cleanup é o `DROP SCHEMA ... CASCADE`
 * do helper, inclusive quando o teste falha. Nunca o schema `public`, nunca banco de homologação, validação ou produção.
 *
 * Modelo (docs. 07 e 12): `imagens_padrao` (biblioteca global SafeWork), `imagens_empresa` (biblioteca privada, isolada por empresa),
 * `imagens_padrao_tipos` (sugestões imagem × NOME de tipo, só as aprovadas, nível PRINCIPAL ou ALTERNATIVA) e, em `materiais`, as colunas
 * opcionais `imagem_padrao_id` e `imagem_empresa_id` (no máximo uma). A sugestão só DESTACA a imagem: nenhum vínculo é criado sozinho.
 *
 * RED: nenhum teste falha por quebra do próprio harness. O cenário legado é semeado ANTES da 090 (sem ela); a 090 só é aplicada se o arquivo
 * existir, e cada verificação exige a migration com uma asserção explícita. Itens que dependem de decisão pendente da V7 estão marcados [DECISÃO].
 */

const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';
const NULO_OBRIGATORIO = '23502';
const VALOR_LONGO_DEMAIS = '22001';
// D-U2-5 (V7): os gatilhos recusam SEMPRE com check_violation (23514) e CONSTRAINT = nome do gatilho; nenhum erro genérico é aceito.
const GATILHO_DA_IMAGEM_DO_MATERIAL = 'trg_materiais_validar_imagem';
const GATILHO_DE_IMUTABILIDADE = 'trg_imagens_empresa_imutavel';
const NOVAS_TABELAS = ['imagens_empresa', 'imagens_padrao', 'imagens_padrao_tipos'];
const PRESERVADAS = [
  'empresas', 'usuarios', 'funcionarios', 'materiais', 'tipos_material', 'ghe_materiais', 'estoque_lotes', 'estoque_operacoes',
  'fichas_epi', 'entregas_epi', 'entregas_epi_itens', 'entregas_epi_confirmacoes', 'solicitacoes_epi', 'solicitacoes_epi_itens',
];
const COLUNAS_NOVAS_DE_MATERIAIS = ['imagem_empresa_id', 'imagem_padrao_id'];
const TS = 'timestamp with time zone';
const VC = 'character varying';
const CH = 'character';

// [coluna, tipo, anulável]. As colunas listadas são as EXIGIDAS; o teste não proíbe colunas extras que o GREEN justificar.
const COLUNAS = {
  imagens_empresa: [
    ['id', 'bigint', 'NO'], ['empresa_id', 'integer', 'NO'], ['nome', VC, 'NO'], ['sha256', CH, 'NO'], ['sha256_mestre', CH, 'NO'],
    ['sha256_exibicao', CH, 'NO'], ['sha256_miniatura', CH, 'NO'], ['formato', VC, 'NO'], ['largura', 'integer', 'NO'], ['altura', 'integer', 'NO'],
    ['bytes_mestre', 'integer', 'NO'], ['bytes_exibicao', 'integer', 'NO'], ['bytes_miniatura', 'integer', 'NO'], ['versao', 'integer', 'NO'],
    ['estado', VC, 'NO'], ['criado_por', 'integer', 'NO'], ['criado_em', TS, 'NO'], ['atualizado_em', TS, 'NO'], ['inativada_em', TS, 'YES'],
  ],
  imagens_padrao: [
    ['id', 'bigint', 'NO'], ['nome', VC, 'NO'], ['arquivo_origem', VC, 'NO'], ['sha256', CH, 'NO'], ['sha256_miniatura', CH, 'NO'],
    ['sha256_exibicao', CH, 'YES'], ['sha256_original_ref', CH, 'YES'], ['pacote_origem', VC, 'YES'], ['pacote_sha256', CH, 'YES'],
    ['formato', VC, 'NO'], ['largura', 'integer', 'NO'], ['altura', 'integer', 'NO'], ['bytes_mestre', 'integer', 'NO'], ['bytes_miniatura', 'integer', 'NO'],
    ['bytes_exibicao', 'integer', 'YES'], ['versao', 'integer', 'NO'], ['ativo', 'boolean', 'NO'], ['ilustrativa', 'boolean', 'NO'],
    ['criado_em', TS, 'NO'], ['atualizado_em', TS, 'NO'],
  ],
  imagens_padrao_tipos: [
    ['id', 'bigint', 'NO'], ['imagem_padrao_id', 'bigint', 'NO'], ['tipo_nome', VC, 'NO'], ['nivel', VC, 'NO'],
    ['aprovado_por', VC, 'NO'], ['aprovado_em', 'date', 'NO'], ['criado_em', TS, 'NO'],
  ],
};

const par = (erro) => [erro?.code, erro?.constraint];
const hex = (semente) => crypto.createHash('sha256').update(String(semente)).digest('hex');

function exigir090() {
  assert.equal(migrationExiste('090'), true, 'migration 090 ainda não implementada (imagens_padrao, imagens_empresa, imagens_padrao_tipos e colunas de imagem em materiais)');
}

describe('migration 090 — imagens de produto (biblioteca padrão, biblioteca da empresa, sugestões e vínculo com materiais)', () => {
  let ctx;
  let d;
  let usuarioA2;
  let erroDoCenario = null;
  let erroAoAplicar = 'não aplicada: o arquivo da 090 não existe';
  let antes = null;
  let estruturaAntes = null;
  let seq = 0;

  const q = (sql, params) => ctx.cliente.query(sql, params);

  const imagemEmpresa = (empresaId, criadoPor, extra = {}) => {
    seq += 1;
    return inserir(ctx.cliente, 'imagens_empresa', {
      empresa_id: empresaId, nome: `Imagem de teste ${seq}`, sha256: hex(`e${seq}`), sha256_mestre: hex(`m${seq}`), sha256_exibicao: hex(`x${seq}`),
      sha256_miniatura: hex(`n${seq}`), formato: 'PNG', largura: 1024, altura: 1024, bytes_mestre: 90000, bytes_exibicao: 40000, bytes_miniatura: 9000,
      criado_por: criadoPor, ...extra,
    });
  };
  const imagemPadrao = (extra = {}) => {
    seq += 1;
    return inserir(ctx.cliente, 'imagens_padrao', {
      nome: `Imagem padrão ${seq}`, arquivo_origem: `padrao-${seq}.png`, sha256: hex(`p${seq}`), sha256_miniatura: hex(`pn${seq}`), formato: 'PNG',
      largura: 1024, altura: 1024, bytes_mestre: 80000, bytes_miniatura: 8000, ...extra,
    });
  };
  const sugestao = (imagemPadraoId, tipoNome, extra = {}) => inserir(ctx.cliente, 'imagens_padrao_tipos', {
    imagem_padrao_id: imagemPadraoId, tipo_nome: tipoNome, nivel: 'PRINCIPAL', aprovado_por: 'V7', aprovado_em: '2026-10-16', ...extra,
  });
  const materialNovo = async (empresaId, extra = {}) => {
    seq += 1;
    return (await inserir(ctx.cliente, 'materiais', { empresa_id: empresaId, nome: `Material de imagem ${seq}`, exige_ca: true, exige_tamanho: false, prazo_uso_dias: 180, ...extra }));
  };
  const imagemDoMaterial = async (materialId) => (await q('SELECT imagem_padrao_id, imagem_empresa_id FROM materiais WHERE id = $1', [materialId])).rows[0];
  const linha = async (tabela, id) => (await q(`SELECT to_jsonb(t) AS j FROM ${tabela} t WHERE id = $1`, [id])).rows[0].j;

  /** Retrato (md5 + contagem) de uma tabela; `sem` tira chaves do JSON (as colunas novas de materiais). */
  const retrato = async (tabela, sem = []) => {
    const retirar = sem.map((c) => ` - '${c}'`).join('');
    const { rows } = await q(
      `SELECT md5(COALESCE(string_agg(j, '|' ORDER BY j), '')) AS md5, count(*)::int AS n FROM (SELECT ((to_jsonb(t)${retirar}))::text AS j FROM ${tabela} t) s`,
    );
    return rows[0];
  };
  const retratos = async () => {
    const r = {};
    for (const tabela of PRESERVADAS) r[tabela] = await retrato(tabela, tabela === 'materiais' ? COLUNAS_NOVAS_DE_MATERIAIS : []);
    return r;
  };
  /** Os quatro materiais semeados antes da 090, sem as colunas novas: devem ficar idênticos depois dela. */
  const retratoDosLegados = async () => (await q(
    `SELECT md5(string_agg(j, '|' ORDER BY j)) AS md5, count(*)::int AS n
       FROM (SELECT ((to_jsonb(t) - 'imagem_padrao_id' - 'imagem_empresa_id'))::text AS j FROM materiais t WHERE id = ANY ($1)) s`,
    [[d.botina, d.capacete, d.luva, d.botinaB]],
  )).rows[0];
  const estruturaDe = async (cliente) => {
    const tabelas = (await cliente.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1")).rows.map((x) => x.table_name);
    const colunas = {};
    for (const x of (await cliente.query(
      `SELECT table_name, column_name, data_type, is_nullable, character_maximum_length FROM information_schema.columns
        WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`,
    )).rows) {
      (colunas[x.table_name] = colunas[x.table_name] || []).push(`${x.column_name}:${x.data_type}:${x.is_nullable}:${x.character_maximum_length ?? ''}`);
    }
    return { tabelas, colunas };
  };
  const objetosDe = async (cliente) => ({
    restricoes: (await cliente.query(
      `SELECT c.conname || ':' || c.contype::text AS x FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relnamespace = current_schema()::regnamespace ORDER BY 1`,
    )).rows.map((r) => r.x),
    indices: (await cliente.query('SELECT indexname AS x FROM pg_indexes WHERE schemaname = current_schema() ORDER BY 1')).rows.map((r) => r.x),
    gatilhos: (await cliente.query(
      `SELECT t.tgname AS x FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relnamespace = current_schema()::regnamespace AND NOT t.tgisinternal ORDER BY 1`,
    )).rows.map((r) => r.x),
  });

  before(async () => {
    // Schema com tudo até a 089, SEM a 090 (mesmo depois de ela existir): o cenário legado nasce antes da migration.
    ctx = await abrirSchemaTemporario(todasAsMigrations().filter((prefixo) => prefixo !== '090'));
    try {
      d = await montarCenario(ctx.cliente);
      usuarioA2 = await criarUsuario(ctx.cliente, d.empresaA, 'segundo-a@example.invalid');
      const lote = await criarLoteDeEntrada(ctx.cliente, { empresaId: d.empresaA, materialId: d.botina, quantidade: 10, usuarioId: d.aprovador });
      await entregarDireta(ctx.cliente, {
        empresaId: d.empresaA, funcionarioId: d.trabalhadorA, usuarioId: d.aprovador, materialId: d.botina, loteId: lote, quantidade: 1, cnpj: CNPJ_A,
      });
      await criarSolicitacaoAprovada(ctx.cliente, d, { gheId: d.gheA, itens: [{ material_id: d.botina, quantidade: 2, previsto_no_ghe: true }] });
      await criarSolicitacao(ctx.cliente, d, { gheId: d.gheA, itens: [{ material_id: d.luva, quantidade: 1, previsto_no_ghe: false, tamanho: '40' }] });
      antes = await retratos();
      antes.materiaisLegados = await retratoDosLegados();
      estruturaAntes = await estruturaDe(ctx.cliente);
    } catch (erro) {
      erroDoCenario = erro;
    }
    // A falha da aplicação vira asserção abaixo (e não cancelamento da suíte).
    if (erroDoCenario === null && migrationExiste('090')) erroAoAplicar = await erroDe(q(conteudoDaMigration('090')));
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  // ───────────────────────── [DB-00] isolamento do próprio teste e sanidade do cenário (roda hoje) ─────────────────────────

  describe('[DB-00] isolamento do teste', () => {
    test('a conexão é do banco de teste exclusivo, num schema temporário próprio; nunca o public', async () => {
      const { rows } = await q('SELECT current_database() AS banco, current_schema() AS schema, current_user AS usuario, current_setting(\'search_path\') AS caminho');
      assert.equal(rows[0].banco, BANCO_DE_TESTE);
      assert.match(rows[0].schema, /^test_migration_[0-9a-f]{12}$/);
      assert.notEqual(rows[0].schema, 'public');
      assert.equal(rows[0].caminho, rows[0].schema, 'o search_path aponta só para o schema temporário');
      assert.equal(rows[0].schema, ctx.schema);
      assert.ok(rows[0].usuario.length > 0);
    });

    test('o cenário legado foi semeado ANTES da 090 (empresas A e B, usuários, materiais, entrega e solicitações com snapshots)', () => {
      assert.equal(erroDoCenario, null, erroDoCenario ? `${erroDoCenario.message}` : '');
      assert.ok(antes.materiais.n >= 4, 'materiais');
      assert.ok(antes.entregas_epi_itens.n >= 1, 'item de entrega com snapshot');
      assert.ok(antes.solicitacoes_epi_itens.n >= 2, 'itens de solicitação com snapshot');
      assert.ok(antes.usuarios.n >= 4, 'usuários');
      assert.deepEqual(estruturaAntes.tabelas.filter((t) => NOVAS_TABELAS.includes(t)), [], 'as tabelas de imagem ainda não existem antes da 090');
    });

    test('a numeração 088 continua suspensa e a 090 é o próximo prefixo após a 089', () => {
      assert.equal(migrationExiste('088'), false, 'a 088 está suspensa e não pode ser reutilizada');
      const prefixos = [...new Set(todasAsMigrations())];
      assert.equal(prefixos.includes('089'), true);
      assert.deepEqual(prefixos.filter((p) => p > '089').sort(), ['090', '091', '092', '093'], 'depois da 089, exatamente a 090, a 091 (Dados da Empresa, F1), a 092 (Suporte) e a 093 (conversa do Suporte); nada além');
    });
  });

  // ───────────────────────── [DB-07] aplicação, manifesto e reaplicação ─────────────────────────

  describe('[DB-07] aplicação da migration', () => {
    test('a 090 existe, tem o nome no padrão e aplica sobre o schema com dados legados sem erro', () => {
      exigir090();
      const arquivos = fs.readdirSync(DIRETORIO).filter((n) => n.startsWith('090_') && n.endsWith('.sql') && !/ 2\.sql$/.test(n));
      assert.equal(arquivos.length, 1);
      assert.match(arquivos[0], /^090_[a-z0-9_]+\.sql$/);
      assert.equal(erroAoAplicar, null, JSON.stringify(erroAoAplicar));
    });

    test('é ADITIVA: nenhum comando de dado (INSERT, UPDATE, DELETE, TRUNCATE) nem DROP no texto da migration', () => {
      exigir090();
      const sql = conteudoDaMigration('090').replace(/--[^\n]*/g, '');
      for (const [rotulo, regra] of [
        ['INSERT', /^\s*INSERT\s+INTO\b/im], ['DELETE', /^\s*DELETE\s+FROM\b/im], ['UPDATE', /^\s*UPDATE\s+\w+\s+SET\b/im],
        ['TRUNCATE', /^\s*TRUNCATE\b/im], ['DROP', /\bDROP\s+(TABLE|COLUMN|SCHEMA|CONSTRAINT|TRIGGER)\b/i],
      ]) assert.doesNotMatch(sql, regra, rotulo);
    });

    test('o manifesto checksums.json registra a 090 com o SHA-256 do arquivo e o conjunto de entradas continua coerente com o diretório', () => {
      exigir090();
      const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8'));
      const arquivo = fs.readdirSync(DIRETORIO).find((n) => n.startsWith('090_') && n.endsWith('.sql') && !/ 2\.sql$/.test(n));
      const esperado = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
      assert.equal(manifesto.migrations[arquivo], esperado);
      const emDisco = fs.readdirSync(DIRETORIO).filter((n) => /^\d{3}_.*\.sql$/.test(n) && !/ 2\.sql$/.test(n)).sort();
      assert.deepEqual(Object.keys(manifesto.migrations).sort(), emDisco, 'o manifesto lista exatamente as migrations do diretório');
    });

    test('reaplicação: um schema novo, só com as migrations (000 a 090), sobe sem erro e fica estruturalmente igual ao que recebeu a 090 sobre dados legados', async () => {
      exigir090();
      const novo = await abrirSchemaTemporario(todasAsMigrations());
      try {
        assert.deepEqual(await estruturaDe(novo.cliente), await estruturaDe(ctx.cliente));
        assert.deepEqual(await objetosDe(novo.cliente), await objetosDe(ctx.cliente), 'restrições, índices e gatilhos idênticos');
      } finally { await novo.encerrar(); }
    });
  });

  // ───────────────────────── [DB-01] estrutura ─────────────────────────

  describe('[DB-01] tabelas, colunas e chaves', () => {
    test('só objetos da 090: três tabelas novas e duas colunas novas em materiais; nenhuma outra tabela muda', async () => {
      exigir090();
      const depois = await estruturaDe(ctx.cliente);
      assert.deepEqual(depois.tabelas.filter((t) => !estruturaAntes.tabelas.includes(t)), NOVAS_TABELAS);
      assert.deepEqual(estruturaAntes.tabelas.filter((t) => !depois.tabelas.includes(t)), [], 'nenhuma tabela removida');
      for (const tabela of estruturaAntes.tabelas) {
        if (tabela === 'materiais') {
          // As colunas novas vêm no fim; a ordem entre as duas é livre.
          assert.deepEqual(depois.colunas.materiais.slice(0, estruturaAntes.colunas.materiais.length), estruturaAntes.colunas.materiais, 'colunas de materiais preservadas, na mesma ordem');
          assert.deepEqual(depois.colunas.materiais.slice(estruturaAntes.colunas.materiais.length).sort(), ['imagem_empresa_id:bigint:YES:', 'imagem_padrao_id:bigint:YES:']);
        } else {
          assert.deepEqual(depois.colunas[tabela], estruturaAntes.colunas[tabela], `colunas de ${tabela}`);
        }
      }
    });

    for (const tabela of NOVAS_TABELAS) {
      test(`${tabela}: colunas exigidas, tipos e obrigatoriedade`, async () => {
        exigir090();
        const { rows } = await q(
          `SELECT column_name, data_type, is_nullable, character_maximum_length FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = $1`,
          [tabela],
        );
        const achadas = Object.fromEntries(rows.map((c) => [c.column_name, c]));
        for (const [nome, tipo, anulavel] of COLUNAS[tabela]) {
          assert.ok(achadas[nome], `${tabela}.${nome} ausente`);
          assert.equal(achadas[nome].data_type, tipo, `${tabela}.${nome}: tipo`);
          assert.equal(achadas[nome].is_nullable, anulavel, `${tabela}.${nome}: anulável`);
          if (tipo === CH && (nome.startsWith('sha256') || nome === 'pacote_sha256')) assert.equal(achadas[nome].character_maximum_length, 64, `${tabela}.${nome}: CHAR(64)`);
        }
      });
    }

    test('colunas que NÃO podem existir: lista de tipos dentro da imagem padrão, identificador de tipo nas sugestões, empresa na biblioteca padrão, ilustrativa na da empresa', async () => {
      exigir090();
      const colunasDe = async (tabela) => (await q("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [tabela])).rows.map((c) => c.column_name);
      const padrao = await colunasDe('imagens_padrao');
      assert.equal(padrao.includes('tipos_sugeridos'), false, 'as sugestões ficam na tabela própria');
      assert.equal(padrao.includes('empresa_id'), false, 'a biblioteca padrão é global');
      assert.equal((await colunasDe('imagens_empresa')).includes('ilustrativa'), false);
      const tipos = await colunasDe('imagens_padrao_tipos');
      assert.deepEqual(tipos.filter((c) => /tipo.*_id$|^tipo_material/.test(c)), [], 'a sugestão guarda o NOME do tipo, nunca um identificador');
      assert.equal((await q(
        `SELECT 1 FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid = 'imagens_padrao_tipos'::regclass AND c.confrelid = 'tipos_material'::regclass`,
      )).rowCount, 0, 'sem chave estrangeira para o catálogo por empresa');
    });

    test('chaves únicas que sustentam o isolamento: (empresa_id, id) e (empresa_id, sha256) na imagem da empresa; sha256 na padrão; (imagem, tipo) nas sugestões', async () => {
      exigir090();
      const unicas = (await q(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'u' AND conrelid = ANY (ARRAY['imagens_empresa'::regclass, 'imagens_padrao'::regclass, 'imagens_padrao_tipos'::regclass])`,
      )).rows;
      const definicoes = unicas.map((u) => u.def.replace(/\s+/g, ' '));
      assert.ok(definicoes.includes('UNIQUE (empresa_id, id)'), 'uq (empresa_id, id)');
      assert.ok(definicoes.includes('UNIQUE (empresa_id, sha256)'), 'uq (empresa_id, sha256)');
      assert.ok(definicoes.includes('UNIQUE (sha256)'), 'uq (sha256) da biblioteca padrão');
      assert.ok(definicoes.includes('UNIQUE (imagem_padrao_id, tipo_nome)'), 'uq (imagem_padrao_id, tipo_nome)');
      const nomes = unicas.map((u) => u.conname);
      assert.ok(nomes.includes('uq_imagens_empresa_id') && nomes.includes('uq_imagens_empresa_sha'), 'nomes aprovados no doc. 07');
    });

    test('materiais: as duas colunas de imagem nascem NULL, sem valor padrão, e a chave estrangeira composta e o CHECK têm os nomes aprovados', async () => {
      exigir090();
      const colunas = (await q(
        `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'materiais' AND column_name = ANY ($1) ORDER BY column_name`,
        [COLUNAS_NOVAS_DE_MATERIAIS],
      )).rows;
      assert.deepEqual(colunas, [
        { column_name: 'imagem_empresa_id', data_type: 'bigint', is_nullable: 'YES', column_default: null },
        { column_name: 'imagem_padrao_id', data_type: 'bigint', is_nullable: 'YES', column_default: null },
      ]);
      const restricoes = Object.fromEntries((await q(
        `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'materiais'::regclass AND conname IN ('fk_materiais_imagem_empresa', 'chk_materiais_uma_imagem')`,
      )).rows.map((r) => [r.conname, r.def.replace(/\s+/g, ' ')]));
      assert.match(restricoes.fk_materiais_imagem_empresa ?? '', /FOREIGN KEY \(empresa_id, imagem_empresa_id\) REFERENCES imagens_empresa\(empresa_id, id\) ON DELETE RESTRICT/);
      assert.match(restricoes.chk_materiais_uma_imagem ?? '', /CHECK/);
      const fkPadrao = (await q(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'materiais'::regclass AND contype = 'f' AND confrelid = 'imagens_padrao'::regclass`,
      )).rows.map((r) => r.def.replace(/\s+/g, ' '));
      assert.equal(fkPadrao.length, 1);
      assert.match(fkPadrao[0], /FOREIGN KEY \(imagem_padrao_id\) REFERENCES imagens_padrao\(id\) ON DELETE RESTRICT/);
    });

    test('valores padrão e domínios da imagem da empresa: versão 1, estado ATIVA, formato e estado restritos, medidas e bytes positivos, hash em hexadecimal minúsculo', async () => {
      exigir090();
      const img = await imagemEmpresa(d.empresaA, d.aprovador);
      assert.equal(img.versao, 1);
      assert.equal(img.estado, 'ATIVA');
      assert.equal(img.inativada_em, null);
      assert.ok(img.criado_em && img.atualizado_em);
      const invalidos = [
        { formato: 'GIF' }, { formato: 'png' }, { formato: 'SVG' }, { estado: 'ATIVO' }, { estado: 'ativa' }, { estado: '' }, { versao: 0 }, { versao: -1 },
        { largura: 319 }, { altura: 319 }, { largura: 4097 }, { altura: 4097 }, { largura: 0 }, { bytes_mestre: 0 }, { bytes_exibicao: 0 }, { bytes_miniatura: -1 },
        { nome: '' }, { nome: '   ' }, { sha256: hex('x').toUpperCase() }, { sha256: hex('x').slice(1) }, { sha256: `g${hex('x').slice(1)}` },
        { sha256_mestre: hex('y').toUpperCase() }, { sha256_exibicao: hex('y').slice(1) }, { sha256_miniatura: `z${hex('y').slice(1)}` },
      ];
      for (const extra of invalidos) {
        const erro = await erroDe(imagemEmpresa(d.empresaA, d.aprovador, extra));
        assert.equal(erro?.code, VIOLACAO_CHECK, JSON.stringify(extra));
      }
      assert.equal((await erroDe(imagemEmpresa(d.empresaA, d.aprovador, { nome: 'N'.repeat(101) })))?.code, VALOR_LONGO_DEMAIS, 'nome acima de 100 caracteres');
      assert.equal((await erroDe(imagemEmpresa(d.empresaA, d.aprovador, { sha256: `${hex('w')}0` })))?.code, VALOR_LONGO_DEMAIS, 'hash com 65 caracteres');
      for (const valido of [{ formato: 'JPEG' }, { formato: 'WEBP' }, { largura: 320, altura: 320 }, { largura: 4096, altura: 4096 }, { estado: 'INATIVA', inativada_em: new Date() }, { nome: 'N'.repeat(100) }]) {
        await imagemEmpresa(d.empresaA, d.aprovador, valido);
      }
      for (const campo of ['nome', 'sha256', 'sha256_mestre', 'sha256_exibicao', 'sha256_miniatura', 'formato', 'largura', 'altura', 'bytes_mestre', 'bytes_exibicao', 'bytes_miniatura', 'criado_por']) {
        assert.equal((await erroDe(imagemEmpresa(d.empresaA, d.aprovador, { [campo]: null })))?.code, NULO_OBRIGATORIO, `${campo} nulo`);
      }
    });

    test('valores padrão e domínios da imagem padrão: ativa e ilustrativa por padrão, versão 1, hash e medidas válidos, sha256 único', async () => {
      exigir090();
      const img = await imagemPadrao();
      assert.deepEqual([img.versao, img.ativo, img.ilustrativa], [1, true, true]);
      const invalidos = [
        { formato: 'GIF' }, { formato: 'png' }, { versao: 0 }, { largura: 0 }, { altura: 0 }, { largura: 255 }, { altura: 255 }, { largura: 4097 }, { altura: 4097 }, { bytes_mestre: 0 }, { bytes_miniatura: 0 },
        { bytes_exibicao: 0 }, { nome: '' }, { nome: '  ' }, { arquivo_origem: '' }, { sha256: hex('x').toUpperCase() }, { sha256: hex('x').slice(1) },
        { sha256_miniatura: hex('y').slice(1) }, { sha256_original_ref: hex('y').toUpperCase() }, { sha256_exibicao: hex('y').slice(1) }, { pacote_sha256: hex('y').slice(1) },
      ];
      for (const extra of invalidos) assert.equal((await erroDe(imagemPadrao(extra)))?.code, VIOLACAO_CHECK, JSON.stringify(extra));
      for (const campo of ['nome', 'arquivo_origem', 'sha256', 'sha256_miniatura', 'formato', 'largura', 'altura', 'bytes_mestre', 'bytes_miniatura']) {
        assert.equal((await erroDe(imagemPadrao({ [campo]: null })))?.code, NULO_OBRIGATORIO, `${campo} nulo`);
      }
      await imagemPadrao({ sha256_original_ref: hex('orig'), pacote_origem: 'SafeWork_Biblioteca_30_EPIs_Padronizada.zip', pacote_sha256: hex('pacote'), sha256_exibicao: hex('640'), bytes_exibicao: 30000 });
      await imagemPadrao({ sha256_original_ref: null, pacote_origem: null, pacote_sha256: null });
      for (const medida of [256, 1024, 4096]) await imagemPadrao({ largura: medida, altura: medida }); // D-U2-2: piso de 256 px por lado na biblioteca padrão
      const unico = hex('unico-padrao');
      await imagemPadrao({ sha256: unico });
      assert.equal((await erroDe(imagemPadrao({ sha256: unico })))?.code, VIOLACAO_UNIQUE);
    });
  });

  // ───────────────────────── [DB-02] isolamento entre empresas ─────────────────────────

  describe('[DB-02] isolamento multiempresa por chave estrangeira composta', () => {
    test('o material da empresa A NÃO recebe uma imagem privada da empresa B (INSERT e UPDATE, SQL direto)', async () => {
      exigir090();
      const imgA = await imagemEmpresa(d.empresaA, d.aprovador);
      const imgB = await imagemEmpresa(d.empresaB, d.usuarioB);
      const materialA = await materialNovo(d.empresaA);
      assert.deepEqual(par(await erroDe(q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [imgB.id, materialA.id]))), [VIOLACAO_FK, 'fk_materiais_imagem_empresa']);
      assert.deepEqual(par(await erroDe(materialNovo(d.empresaA, { imagem_empresa_id: imgB.id }))), [VIOLACAO_FK, 'fk_materiais_imagem_empresa']);
      assert.deepEqual(await imagemDoMaterial(materialA.id), { imagem_padrao_id: null, imagem_empresa_id: null }, 'o material continua sem imagem');
      await q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [imgA.id, materialA.id]);
      assert.equal((await imagemDoMaterial(materialA.id)).imagem_empresa_id, String(imgA.id), 'a imagem da própria empresa é aceita');
      const materialB = await materialNovo(d.empresaB, { imagem_empresa_id: imgB.id });
      assert.equal((await imagemDoMaterial(materialB.id)).imagem_empresa_id, String(imgB.id));
      assert.deepEqual(par(await erroDe(q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [imgA.id, materialB.id]))), [VIOLACAO_FK, 'fk_materiais_imagem_empresa'], 'vale nos dois sentidos');
    });

    test('imagem inexistente não é aceita; trocar a empresa de uma imagem em uso é recusado', async () => {
      exigir090();
      const material = await materialNovo(d.empresaA);
      assert.equal((await erroDe(q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [987654321, material.id])))?.code, VIOLACAO_FK);
      const img = await imagemEmpresa(d.empresaA, d.aprovador);
      await q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [img.id, material.id]);
      assert.ok((await erroDe(q('UPDATE imagens_empresa SET empresa_id = $1 WHERE id = $2', [d.empresaB, img.id]))) !== null, 'a empresa da imagem é imutável');
    });

    test('a imagem da empresa só nasce com criador e empresa coerentes: usuário de outra empresa é recusado; empresa inexistente também', async () => {
      exigir090();
      assert.equal((await erroDe(imagemEmpresa(d.empresaA, d.usuarioB)))?.code, VIOLACAO_FK, 'criador de outra empresa');
      assert.equal((await erroDe(imagemEmpresa(d.empresaA, 987654321)))?.code, VIOLACAO_FK, 'criador inexistente');
      assert.equal((await erroDe(imagemEmpresa(987654321, d.aprovador)))?.code, VIOLACAO_FK, 'empresa inexistente');
      await imagemEmpresa(d.empresaB, d.usuarioB);
    });
  });

  // ───────────────────────── biblioteca padrão: integridade referencial ─────────────────────────

  describe('[DB-02b] integridade referencial da biblioteca padrão', () => {
    test('material de qualquer empresa pode usar a MESMA imagem padrão; imagem padrão inexistente é recusada', async () => {
      exigir090();
      const padrao = await imagemPadrao();
      const materialA = await materialNovo(d.empresaA, { imagem_padrao_id: padrao.id });
      const materialB = await materialNovo(d.empresaB, { imagem_padrao_id: padrao.id });
      assert.equal((await imagemDoMaterial(materialA.id)).imagem_padrao_id, String(padrao.id));
      assert.equal((await imagemDoMaterial(materialB.id)).imagem_padrao_id, String(padrao.id));
      assert.equal((await erroDe(materialNovo(d.empresaA, { imagem_padrao_id: 987654321 })))?.code, VIOLACAO_FK);
      assert.equal((await erroDe(q('UPDATE materiais SET imagem_padrao_id = 987654321 WHERE id = $1', [materialA.id])))?.code, VIOLACAO_FK);
    });

    test('sugestão só aponta para imagem padrão existente', async () => {
      exigir090();
      assert.equal((await erroDe(sugestao(987654321, 'Capacete')))?.code, VIOLACAO_FK);
    });
  });

  // ───────────────────────── [DB-03] proteção contra exclusão ─────────────────────────

  describe('[DB-03] imagem em uso não pode ser apagada', () => {
    test('imagem da empresa referenciada por material: DELETE recusado (RESTRICT); depois de liberada, pode ser apagada', async () => {
      exigir090();
      const img = await imagemEmpresa(d.empresaA, d.aprovador);
      const m1 = await materialNovo(d.empresaA, { imagem_empresa_id: img.id });
      const m2 = await materialNovo(d.empresaA, { imagem_empresa_id: img.id });
      assert.deepEqual(par(await erroDe(q('DELETE FROM imagens_empresa WHERE id = $1', [img.id]))), [VIOLACAO_FK, 'fk_materiais_imagem_empresa']);
      await q('UPDATE materiais SET imagem_empresa_id = NULL WHERE id = $1', [m1.id]);
      assert.equal((await erroDe(q('DELETE FROM imagens_empresa WHERE id = $1', [img.id])))?.code, VIOLACAO_FK, 'ainda em uso pelo segundo material');
      await q('UPDATE materiais SET imagem_empresa_id = NULL WHERE id = $1', [m2.id]);
      await q('DELETE FROM imagens_empresa WHERE id = $1', [img.id]);
      assert.equal((await q('SELECT count(*)::int AS n FROM imagens_empresa WHERE id = $1', [img.id])).rows[0].n, 0);
    });

    test('imagem padrão referenciada por material: DELETE recusado; sem uso, pode ser apagada junto com as suas sugestões', async () => {
      exigir090();
      const padrao = await imagemPadrao();
      await sugestao(padrao.id, 'Luva');
      const material = await materialNovo(d.empresaB, { imagem_padrao_id: padrao.id });
      assert.equal((await erroDe(q('DELETE FROM imagens_padrao WHERE id = $1', [padrao.id])))?.code, VIOLACAO_FK);
      await q('UPDATE materiais SET imagem_padrao_id = NULL WHERE id = $1', [material.id]);
      await q('DELETE FROM imagens_padrao_tipos WHERE imagem_padrao_id = $1', [padrao.id]);
      await q('DELETE FROM imagens_padrao WHERE id = $1', [padrao.id]);
    });

    test('[D-U2-8] CASCADE só nas sugestões: apagar uma imagem padrão SEM uso leva as suas sugestões; as de outra imagem ficam', async () => {
      exigir090();
      const [apagada, mantida] = [await imagemPadrao(), await imagemPadrao()];
      await sugestao(apagada.id, 'Protetor');
      await sugestao(apagada.id, 'Abafador', { nivel: 'ALTERNATIVA' });
      await sugestao(mantida.id, 'Protetor');
      await q('DELETE FROM imagens_padrao WHERE id = $1', [apagada.id]);
      assert.equal((await q('SELECT count(*)::int AS n FROM imagens_padrao_tipos WHERE imagem_padrao_id = $1', [apagada.id])).rows[0].n, 0);
      assert.equal((await q('SELECT count(*)::int AS n FROM imagens_padrao_tipos WHERE imagem_padrao_id = $1', [mantida.id])).rows[0].n, 1);
    });

  });

  // ───────────────────────── [DB-04] no máximo uma imagem por material ─────────────────────────

  describe('[DB-04] no máximo uma imagem por material; material sem imagem continua válido', () => {
    test('imagem padrão e imagem da empresa ao mesmo tempo é recusado (INSERT e UPDATE); trocar de origem num único comando é aceito', async () => {
      exigir090();
      const padrao = await imagemPadrao();
      const propria = await imagemEmpresa(d.empresaA, d.aprovador);
      assert.deepEqual(par(await erroDe(materialNovo(d.empresaA, { imagem_padrao_id: padrao.id, imagem_empresa_id: propria.id }))), [VIOLACAO_CHECK, 'chk_materiais_uma_imagem']);
      const material = await materialNovo(d.empresaA, { imagem_padrao_id: padrao.id });
      assert.deepEqual(par(await erroDe(q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [propria.id, material.id]))), [VIOLACAO_CHECK, 'chk_materiais_uma_imagem']);
      await q('UPDATE materiais SET imagem_empresa_id = $1, imagem_padrao_id = NULL WHERE id = $2', [propria.id, material.id]);
      assert.deepEqual(await imagemDoMaterial(material.id), { imagem_padrao_id: null, imagem_empresa_id: String(propria.id) });
      await q('UPDATE materiais SET imagem_padrao_id = $1, imagem_empresa_id = NULL WHERE id = $2', [padrao.id, material.id]);
      assert.deepEqual(await imagemDoMaterial(material.id), { imagem_padrao_id: String(padrao.id), imagem_empresa_id: null });
    });

    test('material sem imagem é válido: nasce com as duas colunas nulas e continua editável; remover a imagem volta a nulo', async () => {
      exigir090();
      const material = await materialNovo(d.empresaA);
      assert.deepEqual(await imagemDoMaterial(material.id), { imagem_padrao_id: null, imagem_empresa_id: null });
      await q('UPDATE materiais SET nome = $1, fabricante = $2 WHERE id = $3', [`Renomeado ${material.id}`, 'Fabricante Fictício', material.id]);
      const padrao = await imagemPadrao();
      await q('UPDATE materiais SET imagem_padrao_id = $1 WHERE id = $2', [padrao.id, material.id]);
      await q('UPDATE materiais SET imagem_padrao_id = NULL WHERE id = $1', [material.id]);
      assert.deepEqual(await imagemDoMaterial(material.id), { imagem_padrao_id: null, imagem_empresa_id: null });
    });

    test('os materiais que já existiam antes da 090 continuam sem imagem', async () => {
      exigir090();
      const { rows } = await q('SELECT count(*)::int AS total, count(imagem_padrao_id)::int AS com_padrao, count(imagem_empresa_id)::int AS com_empresa FROM materiais WHERE id = ANY ($1)', [[d.botina, d.capacete, d.luva, d.botinaB]]);
      assert.deepEqual(rows[0], { total: 4, com_padrao: 0, com_empresa: 0 });
    });
  });

  // ───────────────────────── deduplicação e reutilização ─────────────────────────

  describe('[DB-01b] deduplicação por empresa e reutilização', () => {
    test('a mesma imagem (SHA-256) não se repete na empresa, nem inativa; outra empresa pode ter o mesmo SHA-256', async () => {
      exigir090();
      const sha = hex('conteudo-compartilhado');
      const original = await imagemEmpresa(d.empresaA, d.aprovador, { sha256: sha });
      assert.deepEqual(par(await erroDe(imagemEmpresa(d.empresaA, usuarioA2, { sha256: sha }))), [VIOLACAO_UNIQUE, 'uq_imagens_empresa_sha']);
      await q("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [original.id]);
      assert.equal((await erroDe(imagemEmpresa(d.empresaA, d.aprovador, { sha256: sha })))?.code, VIOLACAO_UNIQUE, 'inativa também ocupa o SHA-256: reaproveita-se reativando');
      const deB = await imagemEmpresa(d.empresaB, d.usuarioB, { sha256: sha });
      assert.equal(deB.empresa_id, d.empresaB);
      assert.notEqual(deB.id, original.id);
    });

    test('a mesma imagem serve a vários materiais da empresa', async () => {
      exigir090();
      const img = await imagemEmpresa(d.empresaA, d.aprovador);
      for (let i = 0; i < 4; i += 1) await materialNovo(d.empresaA, { imagem_empresa_id: img.id });
      assert.equal((await q('SELECT count(*)::int AS n FROM materiais WHERE imagem_empresa_id = $1', [img.id])).rows[0].n, 4);
    });
  });

  // ───────────────────────── [DB-05] gatilhos ─────────────────────────

  describe('[DB-05] o material só RECEBE imagem ativa; a imagem da empresa é imutável fora do que muda de verdade', () => {
    test('imagem inativa da empresa não é recebida (INSERT e UPDATE); ativa volta a ser aceita depois de reativada', async () => {
      exigir090();
      const inativa = await imagemEmpresa(d.empresaA, d.aprovador, { estado: 'INATIVA', inativada_em: new Date() });
      const material = await materialNovo(d.empresaA);
      assert.deepEqual(par(await erroDe(q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [inativa.id, material.id]))), [VIOLACAO_CHECK, GATILHO_DA_IMAGEM_DO_MATERIAL]);
      assert.deepEqual(par(await erroDe(materialNovo(d.empresaA, { imagem_empresa_id: inativa.id }))), [VIOLACAO_CHECK, GATILHO_DA_IMAGEM_DO_MATERIAL]);
      assert.equal((await imagemDoMaterial(material.id)).imagem_empresa_id, null);
      await q("UPDATE imagens_empresa SET estado = 'ATIVA', inativada_em = NULL WHERE id = $1", [inativa.id]);
      await q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [inativa.id, material.id]);
      assert.equal((await imagemDoMaterial(material.id)).imagem_empresa_id, String(inativa.id));
    });

    test('[D-U2-3] imagem padrão inativa também não é recebida', async () => {
      exigir090();
      const inativa = await imagemPadrao({ ativo: false });
      const material = await materialNovo(d.empresaA);
      assert.deepEqual(par(await erroDe(q('UPDATE materiais SET imagem_padrao_id = $1 WHERE id = $2', [inativa.id, material.id]))), [VIOLACAO_CHECK, GATILHO_DA_IMAGEM_DO_MATERIAL]);
      assert.deepEqual(par(await erroDe(materialNovo(d.empresaA, { imagem_padrao_id: inativa.id }))), [VIOLACAO_CHECK, GATILHO_DA_IMAGEM_DO_MATERIAL]);
    });

    test('quem já tem a imagem a MANTÉM depois de ela ser inativada: editar o material, regravar o mesmo valor e remover continuam permitidos', async () => {
      exigir090();
      const img = await imagemEmpresa(d.empresaA, d.aprovador);
      const material = await materialNovo(d.empresaA, { imagem_empresa_id: img.id });
      await q("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [img.id]);
      await q('UPDATE materiais SET nome = $1 WHERE id = $2', [`Editado ${material.id}`, material.id]);
      await q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [img.id, material.id]);
      assert.equal((await imagemDoMaterial(material.id)).imagem_empresa_id, String(img.id));
      await q('UPDATE materiais SET imagem_empresa_id = NULL WHERE id = $1', [material.id]);
      assert.deepEqual(par(await erroDe(q('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [img.id, material.id]))), [VIOLACAO_CHECK, GATILHO_DA_IMAGEM_DO_MATERIAL], 'depois de remover, a inativa não volta');
    });

    test('imagem da empresa: só nome, estado, versão, inativada_em e atualizado_em mudam; qualquer outra coluna é imutável', async () => {
      exigir090();
      const img = await imagemEmpresa(d.empresaA, d.aprovador);
      const imutaveis = {
        sha256: hex('troca-1'), sha256_mestre: hex('troca-2'), sha256_exibicao: hex('troca-3'), sha256_miniatura: hex('troca-4'), formato: 'JPEG', largura: 900, altura: 900,
        bytes_mestre: 12345, bytes_exibicao: 2345, bytes_miniatura: 345, criado_por: usuarioA2, criado_em: '2020-01-01T00:00:00Z',
      };
      const antesDaTentativa = await linha('imagens_empresa', img.id);
      for (const [coluna, valor] of Object.entries(imutaveis)) {
        const erro = await erroDe(q(`UPDATE imagens_empresa SET ${coluna} = $1 WHERE id = $2`, [valor, img.id]));
        assert.deepEqual(par(erro), [VIOLACAO_CHECK, GATILHO_DE_IMUTABILIDADE], `${coluna} deveria ser imutável`);
      }
      assert.deepEqual(await linha('imagens_empresa', img.id), antesDaTentativa, 'nenhuma tentativa alterou a linha');
      await q('UPDATE imagens_empresa SET nome = $1 WHERE id = $2', ['Novo nome', img.id]);
      await q('UPDATE imagens_empresa SET versao = 2 WHERE id = $1', [img.id]);
      await q("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [img.id]);
      await q("UPDATE imagens_empresa SET estado = 'ATIVA', inativada_em = NULL WHERE id = $1", [img.id]);
      const depois = await linha('imagens_empresa', img.id);
      assert.deepEqual([depois.nome, depois.versao, depois.estado, depois.inativada_em], ['Novo nome', 2, 'ATIVA', null]);
      for (const coluna of Object.keys(imutaveis)) assert.deepEqual(depois[coluna], antesDaTentativa[coluna], `${coluna} intacta`);
    });

    test('atualizado_em acompanha cada alteração permitida, sem ser barrado pela imutabilidade', async () => {
      exigir090();
      const img = await imagemEmpresa(d.empresaA, d.aprovador);
      const inicio = (await linha('imagens_empresa', img.id)).atualizado_em;
      await q('SELECT pg_sleep(0.05)');
      await q("UPDATE imagens_empresa SET nome = 'Outro nome' WHERE id = $1", [img.id]);
      const fim = (await linha('imagens_empresa', img.id)).atualizado_em;
      assert.ok(new Date(fim) > new Date(inicio), 'atualizado_em avançou');
    });
  });

  // ───────────────────────── [DB-06] sugestões imagem × tipo ─────────────────────────

  describe('[DB-06] sugestões imagem × tipo: só nome, só níveis válidos, só aprovadas', () => {
    test('nível restrito a PRINCIPAL e ALTERNATIVA; nulo, vazio e outro texto são recusados', async () => {
      exigir090();
      const img = await imagemPadrao();
      let n = 0;
      for (const valido of ['PRINCIPAL', 'ALTERNATIVA']) { n += 1; await sugestao(img.id, `Tipo ${n}`, { nivel: valido }); }
      for (const invalido of ['', 'principal', 'SECUNDARIA', 'PRINCIPAL ', 'ALTERNATIVO']) {
        assert.equal((await erroDe(sugestao(img.id, 'Tipo X', { nivel: invalido })))?.code, VIOLACAO_CHECK, JSON.stringify(invalido));
      }
      assert.equal((await erroDe(sugestao(img.id, 'Tipo X', { nivel: null })))?.code, NULO_OBRIGATORIO);
    });

    test('a mesma imagem não repete o mesmo tipo; a mesma imagem pode servir a vários tipos', async () => {
      exigir090();
      const img = await imagemPadrao();
      await sugestao(img.id, 'Botina de Segurança', { nivel: 'ALTERNATIVA' });
      assert.equal((await erroDe(sugestao(img.id, 'Botina de Segurança', { nivel: 'PRINCIPAL' })))?.code, VIOLACAO_UNIQUE);
      await sugestao(img.id, 'Sapato de Segurança', { nivel: 'ALTERNATIVA' });
      assert.equal((await q('SELECT count(*)::int AS n FROM imagens_padrao_tipos WHERE imagem_padrao_id = $1', [img.id])).rows[0].n, 2);
    });

    test('várias imagens podem ser candidatas ao MESMO tipo (principal e alternativas), sem escolher nenhuma', async () => {
      exigir090();
      const [a, b, c] = [await imagemPadrao(), await imagemPadrao(), await imagemPadrao()];
      await sugestao(a.id, 'Capacete', { nivel: 'PRINCIPAL' });
      await sugestao(b.id, 'Capacete', { nivel: 'ALTERNATIVA' });
      await sugestao(c.id, 'Capacete', { nivel: 'ALTERNATIVA' });
      const { rows } = await q("SELECT nivel, count(*)::int AS n FROM imagens_padrao_tipos WHERE tipo_nome = 'Capacete' GROUP BY nivel ORDER BY nivel");
      assert.deepEqual(rows, [{ nivel: 'ALTERNATIVA', n: 2 }, { nivel: 'PRINCIPAL', n: 1 }]);
    });

    test('o tipo é um NOME aparado e não vazio, de até 100 caracteres', async () => {
      exigir090();
      const img = await imagemPadrao();
      for (const invalido of ['', '   ', ' Luva', 'Luva ', 'Luva\n']) assert.equal((await erroDe(sugestao(img.id, invalido)))?.code, VIOLACAO_CHECK, JSON.stringify(invalido));
      assert.equal((await erroDe(sugestao(img.id, 'T'.repeat(101))))?.code, VALOR_LONGO_DEMAIS);
      assert.equal((await erroDe(sugestao(img.id, null)))?.code, NULO_OBRIGATORIO);
      await sugestao(img.id, 'T'.repeat(100));
    });

    test('[D-U2-1] só entra sugestão APROVADA: sem quem aprovou e quando, a linha é recusada', async () => {
      exigir090();
      const img = await imagemPadrao();
      assert.equal((await erroDe(sugestao(img.id, 'Luva', { aprovado_por: null })))?.code, NULO_OBRIGATORIO);
      assert.equal((await erroDe(sugestao(img.id, 'Luva', { aprovado_em: null })))?.code, NULO_OBRIGATORIO);
      for (const invalido of ['', '   ']) assert.equal((await erroDe(sugestao(img.id, 'Luva', { aprovado_por: invalido })))?.code, VIOLACAO_CHECK, JSON.stringify(invalido));
      const ok = await sugestao(img.id, 'Luva', { aprovado_por: 'Ramires', aprovado_em: '2026-10-17' });
      const gravada = (await q('SELECT aprovado_por, aprovado_em::text AS aprovado_em FROM imagens_padrao_tipos WHERE id = $1', [ok.id])).rows[0];
      assert.deepEqual(gravada, { aprovado_por: 'Ramires', aprovado_em: '2026-10-17' });
    });

    test('a imagem sem nenhuma sugestão (como a Camiseta Azul) é válida: a biblioteca não exige tipo', async () => {
      exigir090();
      const img = await imagemPadrao({ nome: 'Camiseta Azul' });
      assert.equal((await q('SELECT count(*)::int AS n FROM imagens_padrao_tipos WHERE imagem_padrao_id = $1', [img.id])).rows[0].n, 0);
    });
  });

  // ───────────────────────── ilustrativa e rastreabilidade ─────────────────────────

  describe('[DB-01c] imagem ilustrativa e rastreabilidade', () => {
    test('imagem padrão é ilustrativa por padrão, pode ser marcada como não ilustrativa e a marca nunca é nula', async () => {
      exigir090();
      assert.equal((await imagemPadrao()).ilustrativa, true);
      assert.equal((await imagemPadrao({ ilustrativa: false })).ilustrativa, false);
      assert.equal((await erroDe(imagemPadrao({ ilustrativa: null })))?.code, NULO_OBRIGATORIO);
    });

    test('rastreabilidade: nome do arquivo de origem, hash do PNG padronizado, da miniatura, do original (só referência) e do pacote ficam registrados', async () => {
      exigir090();
      const registro = {
        arquivo_origem: '07_Botina.png', sha256: hex('png-padronizado'), sha256_miniatura: hex('webp-320'), sha256_original_ref: hex('png-original'),
        pacote_origem: 'SafeWork_Biblioteca_30_EPIs_Padronizada.zip', pacote_sha256: '23044e37d7c0fce2028fd221e5f3474c824facc31412adb8691b7a36889d5b55',
      };
      const img = await imagemPadrao(registro);
      for (const [campo, valor] of Object.entries(registro)) assert.equal(img[campo], valor, campo);
    });

    test('a imagem da empresa registra o hash de cada um dos três arquivos e quem a importou', async () => {
      exigir090();
      const img = await imagemEmpresa(d.empresaA, d.aprovador);
      for (const campo of ['sha256', 'sha256_mestre', 'sha256_exibicao', 'sha256_miniatura']) assert.match(img[campo], /^[0-9a-f]{64}$/, campo);
      assert.equal(img.criado_por, d.aprovador);
    });
  });

  // ───────────────────────── nenhum vínculo automático ─────────────────────────

  describe('[DB-06c] nenhum vínculo automático', () => {
    test('cadastrar material, importar imagens e gravar sugestões não associam imagem a ninguém', async () => {
      exigir090();
      const materiaisAntes = await retrato('materiais');
      const padrao = await imagemPadrao();
      await sugestao(padrao.id, 'Botina de Segurança', { nivel: 'PRINCIPAL' });
      await sugestao(padrao.id, 'Capacete', { nivel: 'ALTERNATIVA' });
      await imagemEmpresa(d.empresaA, d.aprovador);
      assert.deepEqual(await retrato('materiais'), materiaisAntes, 'importar e sugerir não toca em material algum');
      const novo = await materialNovo(d.empresaA, { nome: 'Botina de segurança (cadastro novo)', tipo: 'Botina de Segurança' });
      const mesmoNome = await materialNovo(d.empresaB, { nome: 'Capacete (cadastro novo)', tipo: 'Capacete' });
      for (const material of [novo, mesmoNome]) assert.deepEqual(await imagemDoMaterial(material.id), { imagem_padrao_id: null, imagem_empresa_id: null }, 'nome igual ao do tipo sugerido não associa');
      await q('UPDATE materiais SET fabricante = $1 WHERE id = $2', ['Fabricante Fictício', novo.id]);
      assert.deepEqual(await imagemDoMaterial(novo.id), { imagem_padrao_id: null, imagem_empresa_id: null }, 'alterar o material também não associa');
    });

    test('nenhuma função de gatilho do schema escreve em materiais para escolher imagem', async () => {
      exigir090();
      // MATERIALIZED + prokind: o PostgreSQL não garante a ordem dos filtros, e pg_get_functiondef não aceita agregados do catálogo.
      const { rows } = await q(
        `WITH funcoes AS MATERIALIZED (SELECT p.oid, p.proname FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace AND p.prokind = 'f')
         SELECT proname, pg_get_functiondef(oid) AS def FROM funcoes`,
      );
      assert.ok(rows.length >= 2, 'as funções de gatilho da 090 existem no schema');
      for (const funcao of rows.filter((f) => /imagem_(padrao|empresa)_id/i.test(f.def))) {
        assert.doesNotMatch(funcao.def, /\bUPDATE\s+materiais\b/i, `${funcao.proname} não pode atribuir imagem a material`);
        assert.doesNotMatch(funcao.def, /\bNEW\.imagem_(padrao|empresa)_id\s*:=\s*(?!NULL)/i, `${funcao.proname} não pode escolher imagem para o material`);
      }
    });
  });

  // ───────────────────────── [DB-08] sem backfill, compatibilidade e histórico ─────────────────────────

  describe('[DB-08] compatibilidade com o legado e preservação de históricos', () => {
    test('nenhuma linha existente muda: materiais (sem as colunas novas), funcionários, estoque, fichas, entregas, solicitações e snapshots idênticos', async () => {
      exigir090();
      const depois = await retratos();
      for (const tabela of PRESERVADAS) {
        if (tabela === 'materiais') continue; // materiais ganha linhas nos testes acima; o legado é conferido abaixo por id
        assert.deepEqual(depois[tabela], antes[tabela], tabela);
      }
      assert.deepEqual(await retratoDosLegados(), antes.materiaisLegados, 'os quatro materiais legados idênticos (sem as colunas novas)');
      assert.equal(antes.materiaisLegados.n, 4);
      assert.equal((await q('SELECT count(*)::int AS n FROM entregas_epi_itens')).rows[0].n, antes.entregas_epi_itens.n, 'itens de entrega com snapshot preservados');
      assert.equal((await q('SELECT count(*)::int AS n FROM solicitacoes_epi_itens')).rows[0].n, antes.solicitacoes_epi_itens.n, 'itens de solicitação preservados');
    });

    test('sem backfill: logo após a 090, as três tabelas novas estão vazias e nenhum material tem imagem (conferido em um schema novo, sem a semeadura dos testes acima)', async () => {
      exigir090();
      const novo = await abrirSchemaTemporario(todasAsMigrations());
      try {
        for (const tabela of NOVAS_TABELAS) assert.equal((await novo.cliente.query(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0].n, 0, `${tabela} nasce vazia`);
        assert.equal((await novo.cliente.query('SELECT count(*)::int AS n FROM materiais WHERE imagem_padrao_id IS NOT NULL OR imagem_empresa_id IS NOT NULL')).rows[0].n, 0);
      } finally { await novo.encerrar(); }
    });

    test('as migrations históricas 000 a 089 permanecem imutáveis (a 090 não as reescreve)', () => {
      exigir090();
      const manifesto = JSON.parse(fs.readFileSync(path.join(DIRETORIO, 'checksums.json'), 'utf8')).migrations;
      for (const [arquivo, esperado] of Object.entries(manifesto)) {
        if (arquivo.startsWith('090_')) continue;
        const real = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIRETORIO, arquivo))).digest('hex');
        assert.equal(real, esperado, arquivo);
      }
    });
  });
});

// ───────────────────────── [DB-09] concorrência e exclusão de empresa (D-U2-7 e D-U2-8) ─────────────────────────

describe('[DB-09] associar × inativar a imagem da empresa se serializam; empresa com imagem não é apagada', () => {
  let ctx;
  let d;
  let seq = 0;

  const imagemDaEmpresa = (executor, empresaId, criadoPor) => {
    seq += 1;
    return inserir(executor, 'imagens_empresa', {
      empresa_id: empresaId, nome: `Imagem concorrente ${seq}`, sha256: hex(`ce${seq}`), sha256_mestre: hex(`cm${seq}`), sha256_exibicao: hex(`cx${seq}`),
      sha256_miniatura: hex(`cn${seq}`), formato: 'PNG', largura: 1024, altura: 1024, bytes_mestre: 90000, bytes_exibicao: 40000, bytes_miniatura: 9000, criado_por: criadoPor,
    });
  };
  const materialDaEmpresa = (executor, empresaId) => {
    seq += 1;
    return inserir(executor, 'materiais', { empresa_id: empresaId, nome: `Material concorrente ${seq}`, exige_ca: true, exige_tamanho: false, prazo_uso_dias: 180 });
  };
  // Cada schema é novo (D-U2-6); a espera do segundo comando é provada no próprio banco, nunca por pausa arbitrária.
  const esperando = async (promessa, pid) => {
    let terminou = false;
    const pendente = promessa.then((v) => { terminou = true; return v; }, (e) => { terminou = true; throw e; });
    pendente.catch(() => {});
    const evento = await aguardarEsperaPeloLock(ctx.pool, pid);
    assert.equal(terminou, false, 'o segundo comando ainda está bloqueado');
    return { pendente, evento };
  };

  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarCenario(ctx.pool);
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('associação em andamento segura a imagem: a inativação ESPERA e depois conclui; o vínculo já confirmado permanece', async () => {
    exigir090();
    const img = await imagemDaEmpresa(ctx.pool, d.empresaA, d.aprovador);
    const material = await materialDaEmpresa(ctx.pool, d.empresaA);
    const associacao = await ctx.pool.connect();
    const inativacao = await ctx.pool.connect();
    try {
      await associacao.query('BEGIN');
      await associacao.query('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [img.id, material.id]);
      const pid = (await inativacao.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const { pendente, evento } = await esperando(inativacao.query("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [img.id]), pid);
      assert.ok(evento, 'a inativação está esperando um lock');
      await associacao.query('COMMIT');
      await pendente;
      const { rows } = await ctx.pool.query('SELECT m.imagem_empresa_id, i.estado FROM materiais m JOIN imagens_empresa i ON i.id = m.imagem_empresa_id WHERE m.id = $1', [material.id]);
      assert.deepEqual(rows[0], { imagem_empresa_id: String(img.id), estado: 'INATIVA' }, 'a associação confirmada antes da inativação permanece íntegra');
    } finally {
      await associacao.query('ROLLBACK').catch(() => {});
      associacao.release();
      inativacao.release();
    }
  });

  test('inativação em andamento segura a imagem: a associação ESPERA e é RECUSADA ao concluir; o material continua sem imagem', async () => {
    exigir090();
    const img = await imagemDaEmpresa(ctx.pool, d.empresaA, d.aprovador);
    const material = await materialDaEmpresa(ctx.pool, d.empresaA);
    const inativacao = await ctx.pool.connect();
    const associacao = await ctx.pool.connect();
    try {
      await inativacao.query('BEGIN');
      await inativacao.query("UPDATE imagens_empresa SET estado = 'INATIVA', inativada_em = now() WHERE id = $1", [img.id]);
      const pid = (await associacao.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const { pendente, evento } = await esperando(associacao.query('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [img.id, material.id]), pid);
      assert.ok(evento, 'a associação está esperando um lock');
      await inativacao.query('COMMIT');
      const erro = await pendente.then(() => null, (e) => ({ code: e.code, constraint: e.constraint }));
      assert.deepEqual([erro?.code, erro?.constraint], [VIOLACAO_CHECK, GATILHO_DA_IMAGEM_DO_MATERIAL], 'nenhuma associação nasce para imagem já inativada');
      assert.equal((await ctx.pool.query('SELECT imagem_empresa_id FROM materiais WHERE id = $1', [material.id])).rows[0].imagem_empresa_id, null);
    } finally {
      await inativacao.query('ROLLBACK').catch(() => {});
      inativacao.release();
      associacao.release();
    }
  });

  test('duas associações simultâneas da MESMA imagem a materiais diferentes convivem (travas compartilhadas, sem espera entre si)', async () => {
    exigir090();
    const img = await imagemDaEmpresa(ctx.pool, d.empresaA, d.aprovador);
    const [m1, m2] = [await materialDaEmpresa(ctx.pool, d.empresaA), await materialDaEmpresa(ctx.pool, d.empresaA)];
    const [c1, c2] = [await ctx.pool.connect(), await ctx.pool.connect()];
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');
      await c1.query('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [img.id, m1.id]);
      await c2.query('UPDATE materiais SET imagem_empresa_id = $1 WHERE id = $2', [img.id, m2.id]);
      await c1.query('COMMIT');
      await c2.query('COMMIT');
      assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM materiais WHERE imagem_empresa_id = $1', [img.id])).rows[0].n, 2);
    } finally {
      await c1.query('ROLLBACK').catch(() => {});
      await c2.query('ROLLBACK').catch(() => {});
      c1.release();
      c2.release();
    }
  });

  test('a empresa que tem imagem privada não é apagada (empresas são inativadas) e a imagem permanece (D-U2-8)', async () => {
    exigir090();
    const empresa = await criarEmpresa(ctx.pool, '55666777000143', 'Empresa C Fictícia');
    const usuario = await criarUsuario(ctx.pool, empresa, 'c@example.invalid');
    const img = await imagemDaEmpresa(ctx.pool, empresa, usuario);
    assert.equal((await erroDe(ctx.pool.query('DELETE FROM empresas WHERE id = $1', [empresa])))?.code, VIOLACAO_FK);
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM imagens_empresa WHERE id = $1', [img.id])).rows[0].n, 1, 'a imagem não sumiu por cascata');
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM empresas WHERE id = $1', [empresa])).rows[0].n, 1);
  });
});
