'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirSchemaTemporario, migrationExiste, conteudoDaMigration } = require('./helpers/schema-temporario');
const { todasAsMigrations, erroDe } = require('./helpers/entrega-epi');
const { CATALOGO_BASE, GRUPOS_PROTECAO } = require('./helpers/classificacao-v2');

/**
 * RED da migration 082 — classificação V2 do material (Grupo → Grupo de Proteção → Tipo), PostgreSQL real em schema
 * temporário. O schema nasce com TODAS as migrations anteriores, recebe dados "antigos" (empresas, materiais legados,
 * Uniforme, lotes e vínculos GHE) e SÓ ENTÃO a 082 é aplicada, como em produção. Enquanto a 082 não existir, cada teste
 * falha dizendo isso; nenhum hook falha.
 *
 * Contrato aprovado: tabela `tipos_material` por empresa (catálogo, sem linha "Outros"); `materiais` ganha
 * modelo_classificacao ('LEGADO'|'V2'), categoria_descricao, grupo_protecao, grupo_protecao_descricao e tipo_material_id
 * (FK composta); a 071 (tipo 'Outros' ⇔ descrição, NOT VALID) é substituída por regra que respeita o modelo; Uniforme →
 * Vestimenta; óculos com grau por Proteção ocular (V2) ou pelos nomes históricos (LEGADO); snapshot
 * entregas_epi_itens.material_grupo_protecao.
 */

const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNICIDADE = '23505';
const VIOLACAO_FK = '23503';
const EXCECAO_GATILHO = 'P0001';
const CHAVE = (t) => t.join('|');

describe('migration 082 — classificação V2, catálogo de tipos e Uniforme → Vestimenta', () => {
  let ctx;
  const estado = { aplicada: false, erro: null };
  const dados = {};
  const q = (sql, params) => ctx.cliente.query(sql, params);
  const codigo = async (promessa) => (await erroDe(promessa))?.code;
  const aplicada = () => assert.equal(estado.aplicada, true, `migration 082 ainda não aplicada: ${estado.erro ? estado.erro.message : 'arquivo inexistente'}`);
  let seq = 0;

  const material = async (empresaId, extra = {}) => {
    seq += 1;
    const c = { categoria: 'EPI', tipo: null, tipo_descricao: null, oculos_com_grau: null, ...extra };
    return (await q(
      `INSERT INTO materiais (empresa_id, nome, categoria, tipo, tipo_descricao, prazo_uso_dias, exige_tamanho, oculos_com_grau)
       VALUES ($1, $2, $3, $4, $5, 180, false, $6) RETURNING id`,
      [empresaId, `Material ${seq}`, c.categoria, c.tipo, c.tipo_descricao, c.oculos_com_grau],
    )).rows[0].id;
  };
  const tipoCatalogo = async (empresaId, grupo, nome) => (await q('SELECT id, grupo_protecao FROM tipos_material WHERE empresa_id = $1 AND grupo = $2 AND nome = $3', [empresaId, grupo, nome])).rows[0];
  const v2 = (empresaId, c) => q(
    `INSERT INTO materiais (empresa_id, nome, categoria, categoria_descricao, grupo_protecao, grupo_protecao_descricao, tipo_material_id, tipo, tipo_descricao,
        oculos_com_grau, modelo_classificacao, prazo_uso_dias, exige_tamanho)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'V2', 180, false) RETURNING id`,
    [empresaId, `V2 ${seq += 1}`, c.categoria, c.categoriaDescricao ?? null, c.grupoProtecao ?? null, c.grupoProtecaoDescricao ?? null, c.tipoMaterialId ?? null,
      c.tipo ?? null, c.tipoDescricao ?? null, c.oculosComGrau ?? null],
  );

  before(async () => {
    const anteriores = todasAsMigrations().filter((p) => p < '082');
    ctx = await abrirSchemaTemporario(anteriores);
    dados.empresaA = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Alfa', '11222333000181') RETURNING id")).rows[0].id;
    dados.empresaB = (await q("INSERT INTO empresas (nome, cnpj) VALUES ('Beta', '11444777000161') RETURNING id")).rows[0].id;
    // Legado típico: Uniforme (vira Vestimenta), EPI com tipo histórico, óculos histórico, Ferramenta, e 'Outros' sem descrição (anterior à 071).
    dados.uniforme = await material(dados.empresaA, { categoria: 'Uniforme', tipo: 'Calça' });
    dados.capacete = await material(dados.empresaA, { categoria: 'EPI', tipo: 'Capacete' });
    dados.oculosHistorico = await material(dados.empresaA, { categoria: 'EPI', tipo: 'Óculos de proteção', oculos_com_grau: true });
    dados.ferramenta = await material(dados.empresaB, { categoria: 'Ferramenta', tipo: 'Outros', tipo_descricao: 'Chave' });
    dados.uniformeB = await material(dados.empresaB, { categoria: 'Uniforme', tipo: 'Camisa' });
    // Estoque e vínculo GHE do Uniforme: nada disso pode se mexer.
    const ghe = (await q("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome) VALUES ($1, 'GHE Histórico') RETURNING id", [dados.empresaA])).rows[0].id;
    await q('INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id) VALUES ($1, $2, $3)', [dados.empresaA, ghe, dados.uniforme]);
    dados.antes = (await q('SELECT id, nome, categoria, tipo FROM materiais ORDER BY id')).rows;
    dados.vinculosAntes = (await q('SELECT count(*)::int n FROM ghe_materiais')).rows[0].n;
    if (migrationExiste('082')) {
      estado.erro = await erroDe(q(conteudoDaMigration('082')));
      estado.aplicada = estado.erro === null;
    }
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  test('a migration 082 existe e aplica sobre dados existentes sem erro', () => {
    assert.equal(migrationExiste('082'), true, 'arquivo 082_*.sql ainda não existe');
    aplicada();
  });

  describe('catálogo tipos_material', () => {
    test('colunas, tipos e anulabilidade', async () => {
      aplicada();
      const cols = (await q("SELECT column_name, data_type, character_maximum_length len, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tipos_material' ORDER BY column_name")).rows.sort((a, b) => a.column_name.localeCompare(b.column_name));
      assert.deepEqual(cols.map((c) => [c.column_name, c.data_type, c.len, c.is_nullable]), [
        ['atualizado_em', 'timestamp with time zone', null, 'NO'], ['ativo', 'boolean', null, 'NO'], ['criado_em', 'timestamp with time zone', null, 'NO'],
        ['empresa_id', 'integer', null, 'NO'], ['grupo', 'character varying', 30, 'NO'], ['grupo_protecao', 'character varying', 60, 'NO'],
        ['id', 'integer', null, 'NO'], ['nome', 'character varying', 100, 'NO'], ['origem', 'character varying', 10, 'NO'],
      ].sort((a, b) => a[0].localeCompare(b[0])));
    });

    test('CHECKs: grupo só EPI/Vestimenta; "Outros" nunca é linha física; proteção só entre as 12; nome aparado e sem controle; origem fechada', async () => {
      aplicada();
      const ins = (grupo, protecao, nome, origem = 'MANUAL') => q('INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, origem) VALUES ($1, $2, $3, $4, $5)', [dados.empresaA, grupo, protecao, nome, origem]);
      assert.equal(await codigo(ins('Ferramenta', 'Proteção ocular', 'X1')), VIOLACAO_CHECK, 'grupo fora de EPI/Vestimenta');
      assert.equal(await codigo(ins('Outros', 'Proteção ocular', 'X2')), VIOLACAO_CHECK, 'grupo Outros');
      assert.equal(await codigo(ins('EPI', 'Outros', 'X3')), VIOLACAO_CHECK, 'proteção Outros');
      assert.equal(await codigo(ins('EPI', 'Proteção inexistente', 'X4')), VIOLACAO_CHECK, 'proteção fora das 12');
      assert.equal(await codigo(ins('EPI', 'Proteção ocular', 'Outros')), VIOLACAO_CHECK, 'nome Outros (reservado)');
      assert.equal(await codigo(ins('EPI', 'Proteção ocular', 'outros')), VIOLACAO_CHECK, 'nome outros, caixa diferente');
      assert.equal(await codigo(ins('EPI', 'Proteção ocular', ' X5')), VIOLACAO_CHECK, 'não aparado');
      assert.equal(await codigo(ins('EPI', 'Proteção ocular', '')), VIOLACAO_CHECK, 'vazio');
      assert.equal(await codigo(ins('EPI', 'Proteção ocular', 'X6\nquebra')), VIOLACAO_CHECK, 'quebra de linha no nome');
      assert.equal(await codigo(ins('EPI', 'Proteção ocular', 'X7', 'OUTRA')), VIOLACAO_CHECK, 'origem fora de BASE/MANUAL/IMPORTACAO');
      for (const p of GRUPOS_PROTECAO) assert.equal(await codigo(ins('EPI', p, `Item ${p}`)), undefined, p);
    });

    test('unicidade lógica por empresa, grupo e nome (sem diferenciar caixa nem espaços repetidos); outra empresa pode repetir', async () => {
      aplicada();
      const ins = (empresa, grupo, protecao, nome) => q('INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome) VALUES ($1, $2, $3, $4)', [empresa, grupo, protecao, nome]);
      await ins(dados.empresaA, 'EPI', 'Proteção das mãos', 'Luva Teste Unica');
      assert.equal(await codigo(ins(dados.empresaA, 'EPI', 'Proteção das mãos', 'LUVA TESTE UNICA')), VIOLACAO_UNICIDADE, 'caixa');
      assert.equal(await codigo(ins(dados.empresaA, 'EPI', 'Proteção das mãos', 'Luva  Teste   Unica')), VIOLACAO_UNICIDADE, 'espaços repetidos');
      assert.equal(await codigo(ins(dados.empresaA, 'EPI', 'Proteção dos braços', 'Luva Teste Unica')), VIOLACAO_UNICIDADE, 'mesmo nome em outra proteção do mesmo grupo');
      assert.equal(await codigo(ins(dados.empresaA, 'Vestimenta', 'Proteção das mãos', 'Luva Teste Unica')), undefined, 'outro grupo pode repetir o nome');
      assert.equal(await codigo(ins(dados.empresaB, 'EPI', 'Proteção das mãos', 'Luva Teste Unica')), undefined, 'outra empresa pode repetir');
    });

    test('grupo, proteção e nome são IMUTÁVEIS (gatilho); ativo e atualizado_em mudam; tipo referenciado por material não é apagado', async () => {
      aplicada();
      const id = (await q("INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome) VALUES ($1, 'EPI', 'Proteção facial', 'Imutavel Teste') RETURNING id", [dados.empresaA])).rows[0].id;
      assert.equal(await codigo(q("UPDATE tipos_material SET nome = 'Outro Nome' WHERE id = $1", [id])), EXCECAO_GATILHO, 'nome');
      assert.equal(await codigo(q("UPDATE tipos_material SET grupo_protecao = 'Proteção ocular' WHERE id = $1", [id])), EXCECAO_GATILHO, 'proteção');
      assert.equal(await codigo(q("UPDATE tipos_material SET grupo = 'Vestimenta' WHERE id = $1", [id])), EXCECAO_GATILHO, 'grupo');
      await q('UPDATE tipos_material SET ativo = false WHERE id = $1', [id]);
      assert.equal((await q('SELECT ativo FROM tipos_material WHERE id = $1', [id])).rows[0].ativo, false);
      const ref = await tipoCatalogo(dados.empresaA, 'EPI', 'Capacete de Segurança');
      await v2(dados.empresaA, { categoria: 'EPI', grupoProtecao: ref.grupo_protecao, tipoMaterialId: ref.id, tipo: 'Capacete de Segurança' });
      assert.equal(await codigo(q('DELETE FROM tipos_material WHERE id = $1', [ref.id])), VIOLACAO_FK, 'RESTRICT');
    });
  });

  describe('seed do catálogo base nas empresas existentes', () => {
    test('cada empresa existente recebe exatamente as 26 linhas aprovadas (origem BASE), sem "Outros" e sem duplicar', async () => {
      aplicada();
      const esperado = CATALOGO_BASE.map(CHAVE).sort();
      for (const empresa of [dados.empresaA, dados.empresaB]) {
        const linhas = (await q("SELECT grupo, grupo_protecao, nome, origem, ativo FROM tipos_material WHERE empresa_id = $1 AND origem = 'BASE'", [empresa])).rows;
        assert.equal(linhas.length, 26, `empresa ${empresa}`);
        assert.deepEqual(linhas.map((l) => CHAVE([l.grupo, l.grupo_protecao, l.nome])).sort(), esperado);
        assert.ok(linhas.every((l) => l.ativo === true));
        assert.equal(linhas.some((l) => /^outros$/i.test(l.nome) || l.grupo_protecao === 'Outros' || l.grupo === 'Outros'), false);
      }
    });

    test('a unicidade impede o seed de duplicar (repetir uma linha base falha)', async () => {
      aplicada();
      assert.equal(await codigo(q("INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, origem) VALUES ($1, 'EPI', 'Proteção ocular', 'Óculos de Proteção Fumê', 'BASE')", [dados.empresaA])), VIOLACAO_UNICIDADE);
    });
  });

  describe('materiais: colunas, legado e Uniforme → Vestimenta', () => {
    test('colunas novas, defaults e anulabilidade', async () => {
      aplicada();
      const cols = (await q("SELECT column_name, data_type, character_maximum_length len, is_nullable, column_default def FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'materiais' AND column_name IN ('modelo_classificacao','categoria_descricao','grupo_protecao','grupo_protecao_descricao','tipo_material_id') ORDER BY column_name")).rows.sort((a, b) => a.column_name.localeCompare(b.column_name));
      assert.deepEqual(cols.map((c) => [c.column_name, c.data_type, c.len, c.is_nullable]), [
        ['categoria_descricao', 'character varying', 100, 'YES'], ['grupo_protecao', 'character varying', 60, 'YES'], ['grupo_protecao_descricao', 'character varying', 100, 'YES'],
        ['modelo_classificacao', 'character varying', 10, 'NO'], ['tipo_material_id', 'integer', null, 'YES'],
      ]);
      assert.match(cols.find((c) => c.column_name === 'modelo_classificacao').def, /LEGADO/);
    });

    test('todos os materiais existentes continuam LEGADO, com as colunas novas nulas; nenhum id, nome, tipo ou estoque mudou', async () => {
      aplicada();
      const depois = (await q('SELECT id, nome, categoria, tipo, modelo_classificacao, categoria_descricao, grupo_protecao, grupo_protecao_descricao, tipo_material_id FROM materiais WHERE id = ANY($1) ORDER BY id', [dados.antes.map((m) => m.id)])).rows;
      assert.equal(depois.length, dados.antes.length);
      for (const m of depois) {
        assert.equal(m.modelo_classificacao, 'LEGADO');
        assert.deepEqual([m.categoria_descricao, m.grupo_protecao, m.grupo_protecao_descricao, m.tipo_material_id], [null, null, null, null]);
        const antes = dados.antes.find((a) => a.id === m.id);
        assert.deepEqual([m.nome, m.tipo], [antes.nome, antes.tipo]);
      }
      assert.equal((await q('SELECT count(*)::int n FROM ghe_materiais')).rows[0].n, dados.vinculosAntes);
    });

    test('Uniforme virou Vestimenta de verdade (qualquer empresa), preservando o id e os vínculos; as demais categorias não mudam', async () => {
      aplicada();
      const get = async (id) => (await q('SELECT categoria FROM materiais WHERE id = $1', [id])).rows[0].categoria;
      assert.equal(await get(dados.uniforme), 'Vestimenta');
      assert.equal(await get(dados.uniformeB), 'Vestimenta');
      assert.equal(await get(dados.capacete), 'EPI');
      assert.equal(await get(dados.ferramenta), 'Ferramenta');
      assert.equal((await q("SELECT count(*)::int n FROM materiais WHERE categoria = 'Uniforme'")).rows[0].n, 0);
      assert.equal((await q('SELECT count(*)::int n FROM ghe_materiais WHERE material_id = $1', [dados.uniforme])).rows[0].n, 1);
      assert.equal((await q('SELECT modelo_classificacao m FROM materiais WHERE id = $1', [dados.uniforme])).rows[0].m, 'LEGADO', 'renomear não converte para V2');
    });

    test('a coluna de snapshot entregas_epi_itens.material_grupo_protecao existe, é anulável e as entregas antigas ficam nulas', async () => {
      aplicada();
      const c = (await q("SELECT data_type, character_maximum_length len, is_nullable FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'entregas_epi_itens' AND column_name = 'material_grupo_protecao'")).rows[0];
      assert.deepEqual(c && [c.data_type, c.len, c.is_nullable], ['character varying', 60, 'YES']);
      assert.equal((await q('SELECT count(*)::int n FROM entregas_epi_itens WHERE material_grupo_protecao IS NOT NULL')).rows[0].n, 0);
    });
  });

  describe('CHECKs do modelo V2 e FK composta com o catálogo', () => {
    test('combinações VÁLIDAS são aceitas: catálogo, Grupo Outros, Proteção Outros e Tipo Outros com proteção conhecida', async () => {
      aplicada();
      const t = await tipoCatalogo(dados.empresaA, 'Vestimenta', 'Avental de Segurança');
      await v2(dados.empresaA, { categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipoMaterialId: t.id, tipo: 'Avental de Segurança' });
      await v2(dados.empresaA, { categoria: 'Outros', categoriaDescricao: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'Chave isolada 1000 V' });
      await v2(dados.empresaA, { categoria: 'EPI', grupoProtecao: 'Outros', grupoProtecaoDescricao: 'Proteção contra arco elétrico', tipo: 'Outros', tipoDescricao: 'Balaclava' });
      await v2(dados.empresaA, { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Outros', tipoDescricao: 'Protetor auricular eletrônico' });
    });

    test('combinações INVÁLIDAS são recusadas pelo banco (CHECK ou FK)', async () => {
      aplicada();
      const concha = await tipoCatalogo(dados.empresaA, 'EPI', 'Protetor Auricular Concha');
      const avental = await tipoCatalogo(dados.empresaA, 'Vestimenta', 'Avental de Segurança');
      const deOutraEmpresa = await tipoCatalogo(dados.empresaB, 'EPI', 'Protetor Auricular Concha');
      const casos = [
        ['grupo antigo em V2', { categoria: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['Outros sem categoria_descricao', { categoria: 'Outros', tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['categoria_descricao sem Outros', { categoria: 'EPI', categoriaDescricao: 'x', grupoProtecao: 'Proteção auditiva', tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['Grupo Outros com grupo_protecao', { categoria: 'Outros', categoriaDescricao: 'Ferramenta', grupoProtecao: 'Proteção ocular', tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['EPI sem grupo_protecao', { categoria: 'EPI', tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['grupo_protecao fora das 12', { categoria: 'EPI', grupoProtecao: 'Inexistente', tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['Proteção Outros sem descrição', { categoria: 'EPI', grupoProtecao: 'Outros', tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['descrição de proteção sem Outros', { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', grupoProtecaoDescricao: 'x', tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['Proteção Outros com tipo do catálogo', { categoria: 'EPI', grupoProtecao: 'Outros', grupoProtecaoDescricao: 'x', tipoMaterialId: concha.id, tipo: 'Protetor Auricular Concha' }, VIOLACAO_CHECK],
        ['tipo do catálogo com tipo_descricao', { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: concha.id, tipo: 'Protetor Auricular Concha', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['tipo do catálogo com tipo Outros', { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: concha.id, tipo: 'Outros', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['V2 com tipo Outros sem descrição', { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Outros' }, VIOLACAO_CHECK],
        ['V2 com descrição sem tipo Outros', { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Capacete', tipoDescricao: 'x' }, VIOLACAO_CHECK],
        ['Vestimenta com tipo de EPI (FK)', { categoria: 'Vestimenta', grupoProtecao: 'Proteção auditiva', tipoMaterialId: concha.id, tipo: 'Protetor Auricular Concha' }, VIOLACAO_FK],
        ['proteção diferente da do tipo (FK)', { categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipoMaterialId: concha.id, tipo: 'Protetor Auricular Concha' }, VIOLACAO_FK],
        ['nome diferente do tipo do catálogo (FK)', { categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipoMaterialId: avental.id, tipo: 'Outro Nome' }, VIOLACAO_FK],
        ['tipo de outra empresa (FK)', { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipoMaterialId: deOutraEmpresa.id, tipo: 'Protetor Auricular Concha' }, VIOLACAO_FK],
      ];
      for (const [nome, c, esperado] of casos) assert.equal(await codigo(v2(dados.empresaA, c)), esperado, nome);
    });

    test('LEGADO não pode carregar as colunas novas; modelo_classificacao só aceita LEGADO ou V2', async () => {
      aplicada();
      assert.equal(await codigo(q("UPDATE materiais SET grupo_protecao = 'Proteção ocular' WHERE id = $1", [dados.capacete])), VIOLACAO_CHECK);
      assert.equal(await codigo(q("UPDATE materiais SET categoria_descricao = 'x' WHERE id = $1", [dados.capacete])), VIOLACAO_CHECK);
      assert.equal(await codigo(q("UPDATE materiais SET modelo_classificacao = 'V3' WHERE id = $1", [dados.capacete])), VIOLACAO_CHECK);
    });
  });

  describe('substituição consciente da constraint da 071', () => {
    test('LEGADO com tipo "Outros" e descrição vazia pode ser alterado em campo NÃO relacionado, sem conversão forçada', async () => {
      aplicada();
      const id = await material(dados.empresaA, { categoria: 'EPI', tipo: 'Outros', tipo_descricao: null });
      await q("UPDATE materiais SET nome = 'Renomeado', fabricante = 'Fab' WHERE id = $1", [id]);
      const m = (await q('SELECT nome, fabricante, tipo, tipo_descricao, modelo_classificacao FROM materiais WHERE id = $1', [id])).rows[0];
      assert.deepEqual(m, { nome: 'Renomeado', fabricante: 'Fab', tipo: 'Outros', tipo_descricao: null, modelo_classificacao: 'LEGADO' });
    });

    test('a constraint chk_materiais_tipo_descricao_so_outros foi reformulada para respeitar o modelo (ou substituída por outra que cite modelo_classificacao)', async () => {
      aplicada();
      const defs = (await q("SELECT conname, pg_get_constraintdef(oid) def, convalidated FROM pg_constraint WHERE conrelid = 'materiais'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%tipo_descricao%' AND pg_get_constraintdef(oid) ILIKE '%Outros%'")).rows;
      assert.ok(defs.length >= 1, 'a equivalência tipo Outros ⇔ descrição continua existindo');
      for (const d of defs) assert.match(d.def, /modelo_classificacao/, `${d.conname} precisa respeitar o modelo`);
    });

    test('V2 mantém a equivalência: tipo Outros ⇔ descrição preenchida (nos dois sentidos)', async () => {
      aplicada();
      assert.equal(await codigo(v2(dados.empresaA, { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Outros' })), VIOLACAO_CHECK);
      assert.equal(await codigo(v2(dados.empresaA, { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Capacete', tipoDescricao: 'x' })), VIOLACAO_CHECK);
    });

  });

  describe('óculos com grau', () => {
    test('V2: oculos_com_grau só em EPI + Proteção ocular, qualquer tipo; fora disso é recusado', async () => {
      aplicada();
      const novo = (await q("INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome) VALUES ($1, 'EPI', 'Proteção ocular', 'Visor Novo Qualquer') RETURNING id", [dados.empresaA])).rows[0].id;
      await v2(dados.empresaA, { categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipoMaterialId: novo, tipo: 'Visor Novo Qualquer', oculosComGrau: false });
      await v2(dados.empresaA, { categoria: 'EPI', grupoProtecao: 'Proteção ocular', tipo: 'Outros', tipoDescricao: 'Óculos especial', oculosComGrau: true });
      assert.equal(await codigo(v2(dados.empresaA, { categoria: 'EPI', grupoProtecao: 'Proteção auditiva', tipo: 'Outros', tipoDescricao: 'x', oculosComGrau: true })), VIOLACAO_CHECK);
      assert.equal(await codigo(v2(dados.empresaA, { categoria: 'Vestimenta', grupoProtecao: 'Proteção do tronco', tipo: 'Outros', tipoDescricao: 'x', oculosComGrau: false })), VIOLACAO_CHECK);
    });

    test('LEGADO: os três nomes históricos continuam aceitos; outro tipo com óculos com grau continua recusado', async () => {
      aplicada();
      for (const tipo of ['Óculos de proteção', 'Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão']) {
        // eslint-disable-next-line no-await-in-loop
        await material(dados.empresaA, { categoria: 'EPI', tipo, oculos_com_grau: false });
      }
      assert.equal(await codigo(material(dados.empresaA, { categoria: 'EPI', tipo: 'Capacete', oculos_com_grau: true })), VIOLACAO_CHECK);
    });

    test('o CHECK do snapshot da entrega aceita Proteção ocular (qualquer tipo) além dos nomes históricos', async () => {
      aplicada();
      const def = (await q("SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid = 'entregas_epi_itens'::regclass AND conname = 'chk_entregas_epi_itens_material_oculos'")).rows[0].def;
      assert.match(def, /material_grupo_protecao/);
      assert.match(def, /Proteção ocular/);
      assert.match(def, /Óculos de Proteção Ampla Visão/);
    });
  });

  describe('histórico e idempotência', () => {
    test('a migration não altera logs de auditoria nem cria eventos', async () => {
      aplicada();
      assert.equal((await q('SELECT count(*)::int n FROM logs_auditoria')).rows[0].n, 0);
    });

  });
});
