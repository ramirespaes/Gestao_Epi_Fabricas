'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, criarEmpresa, criarUsuario, criarGhe, criarFuncionario, criarMaterial, criarLote, inserir,
} = require('./helpers/entrega-epi');
const servico = require('../../src/services/entrega-epi.service');
const fichaRepo = require('../../src/repositories/ficha-epi.repository');
const entregaRepo = require('../../src/repositories/entrega-epi.repository');
const itemRepo = require('../../src/repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../../src/repositories/entrega-epi-confirmacao.repository');
const operacaoRepo = require('../../src/repositories/estoque-operacao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const estoqueServico = require('../../src/services/estoque.service');
const { HttpError } = require('../../src/errors/HttpError');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Serviço transacional da entrega de EPI (10C + 10D) contra PostgreSQL real:
 * ficha criada na primeira entrega e reutilizada depois, numeração por
 * empresa, regras de trabalhador, material, GHE, lote, CA e saldo, cópias
 * congeladas, operação ENTREGA pelo gatilho da 059, confirmação, hash de
 * conteúdo, auditoria na mesma transação, idempotência, rollback total e
 * concorrência com travas de verdade. Schema temporário; só dados fictícios.
 */

const TODAS = todasAsMigrations();
const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const HOJE = dataOperacional();
const ONTEM = somarDias(HOJE, -1);
const DECLARACAO = 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).';
const TRACOS = [[[10, 10], [20, 12], [30, 15]], [[40, 40], [42, 41]]];
const ACEITE = { modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };
const DESENHO = { modo: 'DESENHO', tracos: TRACOS, declaracaoVersao: 'NR6-2026-09', declaracaoTexto: DECLARACAO };

function somarDias(dataIso, dias) {
  const d = new Date(`${dataIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [status, codigo], erro.message);
    return true;
  });
}

async function esperarValidacao(promessa, campo, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
    assert.ok(erro.detalhes.some((d) => d.campo === campo && d.codigo === codigo), JSON.stringify(erro.detalhes));
    return true;
  });
}

// Pausa a primeira chamada de modulo[fn] até liberar(); as demais passam direto.
function portao(t, modulo, fn) {
  const original = modulo[fn];
  let liberar;
  let chegou;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const chegada = new Promise((resolve) => { chegou = resolve; });
  let primeira = true;
  t.mock.method(modulo, fn, async (...args) => {
    if (primeira) {
      primeira = false;
      chegou();
      await espera;
    }
    return original(...args);
  });
  return { liberar, chegada };
}

describe('entrega de EPI — serviço transacional (PostgreSQL real)', () => {
  let contexto;
  let pool;
  const d = {};
  let cpfSequencia = 0;
  let matriculaSequencia = 0;

  const q = (sql, params) => pool.query(sql, params);
  const contar = async (sql, params) => (await q(sql, params)).rows[0].n;
  const lote = async (id) => (await q('SELECT quantidade_entregue, saldo FROM estoque_lotes WHERE id = $1', [id])).rows[0];
  const fichasDe = (funcionarioId) => contar('SELECT count(*)::int AS n FROM fichas_epi WHERE funcionario_id = $1', [funcionarioId]);
  const contador = async (empresaId) => (await q('SELECT ultimo_numero FROM fichas_epi_numeracao WHERE empresa_id = $1', [empresaId])).rows[0]?.ultimo_numero ?? null;
  const retrato = async (empresaId) => (await q(
    `SELECT (SELECT count(*) FROM fichas_epi WHERE empresa_id = $1)::int AS fichas,
            (SELECT count(*) FROM entregas_epi WHERE empresa_id = $1)::int AS entregas,
            (SELECT count(*) FROM entregas_epi_itens WHERE empresa_id = $1)::int AS itens,
            (SELECT count(*) FROM entregas_epi_confirmacoes WHERE empresa_id = $1)::int AS confirmacoes,
            (SELECT count(*) FROM estoque_operacoes WHERE empresa_id = $1 AND tipo = 'ENTREGA')::int AS operacoes,
            (SELECT COALESCE(sum(quantidade_entregue), 0) FROM estoque_lotes WHERE empresa_id = $1)::int AS entregue,
            (SELECT count(*) FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'ENTREGA_REGISTRADA')::int AS auditorias,
            (SELECT ultimo_numero FROM fichas_epi_numeracao WHERE empresa_id = $1) AS contador`,
    [empresaId],
  )).rows[0];

  async function novoFuncionario(empresaId = d.empresaA, extra = {}) {
    cpfSequencia += 1;
    matriculaSequencia += 1;
    return criarFuncionario(pool, empresaId, { matricula: `M-${matriculaSequencia}`, cpf: String(cpfSequencia).padStart(11, '0'), ...extra });
  }

  const item = (extra = {}) => ({ materialId: d.botina, loteId: d.loteBotina40, quantidade: 1, motivo: 'ADMISSAO', ...extra });
  const dados = (extra = {}) => ({
    empresaId: d.empresaA, atorId: d.masterA, funcionarioId: d.funcA1, itens: [item()], confirmacao: ACEITE,
    chaveIdempotencia: crypto.randomUUID(), ip: '203.0.113.10', dispositivo: 'Navegador de teste', ...extra,
  });
  const registrar = (extra = {}) => servico.registrarEntrega(pool, dados(extra));

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS);
    pool = contexto.pool;
    d.empresaA = await criarEmpresa(pool, CNPJ_A, 'Empresa A Ltda');
    await q("UPDATE empresas SET numero = '100', complemento = 'Galpão 2', bairro = 'Industrial' WHERE id = $1", [d.empresaA]);
    d.empresaB = await criarEmpresa(pool, CNPJ_B, 'Empresa B Ltda');
    d.masterA = await criarUsuario(pool, d.empresaA, 'master.a@example.invalid');
    d.masterB = await criarUsuario(pool, d.empresaB, 'master.b@example.invalid');
    d.gheA = await criarGhe(pool, d.empresaA, 'GHE Produção');
    d.funcA1 = await novoFuncionario(d.empresaA, { gheId: d.gheA, setor: 'Produção', funcao: 'Operador' });
    d.funcA2 = await novoFuncionario(d.empresaA);
    d.funcInativo = await novoFuncionario(d.empresaA, { ativo: false });
    d.funcB1 = await novoFuncionario(d.empresaB);

    d.botina = await criarMaterial(pool, d.empresaA, 'Botina de segurança', { tipo: 'Calçado', codigoInterno: 'BOT-01', unidade: 'par' });
    d.luva = await criarMaterial(pool, d.empresaA, 'Luva nitrílica', { exigeTamanho: false, prazo: 90 });
    d.uniforme = await criarMaterial(pool, d.empresaA, 'Uniforme', { exigeCa: false, exigeTamanho: true });
    d.oculos = await criarMaterial(pool, d.empresaA, 'Óculos de proteção incolor', { tipo: 'Óculos de proteção', oculosComGrau: false, exigeTamanho: false });
    d.oculosSemClassificacao = await criarMaterial(pool, d.empresaA, 'Óculos sem classificação', { tipo: 'Óculos de proteção', exigeTamanho: false });
    d.semPrazo = await criarMaterial(pool, d.empresaA, 'Material sem prazo', { prazo: null, exigeTamanho: false });
    d.semClassificacaoTamanho = await criarMaterial(pool, d.empresaA, 'Material sem classificação de tamanho', { exigeTamanho: null });
    d.inativo = await criarMaterial(pool, d.empresaA, 'Material inativo', { ativo: false, exigeTamanho: false });
    d.botinaB = await criarMaterial(pool, d.empresaB, 'Botina B');
    await inserir(pool, 'ghe_materiais', { empresa_id: d.empresaA, grupo_homogeneo_id: d.gheA, material_id: d.botina });
    await inserir(pool, 'ghe_materiais', { empresa_id: d.empresaA, grupo_homogeneo_id: d.gheA, material_id: d.luva });

    const loteA = (materialId, quantidade, extra = {}) => criarLote(pool, { empresaId: d.empresaA, materialId, quantidade, ...extra });
    d.loteBotina40 = await loteA(d.botina, 100);
    d.loteBotina41 = await loteA(d.botina, 5, { tamanho: '41' });
    d.loteBotinaSemCa = await loteA(d.botina, 5, { tamanho: '42', caNumero: null, caValidade: null });
    d.loteBotinaSemTamanho = await loteA(d.botina, 5, { tamanho: null });
    d.loteLuva = await loteA(d.luva, 50, { tamanho: null });
    d.loteLuvaVenceHoje = await loteA(d.luva, 5, { tamanho: null, caNumero: '555', caValidade: HOJE });
    d.loteLuvaVencido = await loteA(d.luva, 5, { tamanho: null, caNumero: '556', caValidade: ONTEM });
    d.loteUniforme = await loteA(d.uniforme, 10, { tamanho: 'G', caNumero: null, caValidade: null });
    d.loteOculos = await loteA(d.oculos, 10, { tamanho: null });
    d.loteOculosSemClassificacao = await loteA(d.oculosSemClassificacao, 10, { tamanho: null });
    d.loteSemPrazo = await loteA(d.semPrazo, 10, { tamanho: null });
    d.loteSemClassificacaoTamanho = await loteA(d.semClassificacaoTamanho, 10);
    d.loteInativo = await loteA(d.inativo, 10, { tamanho: null });
    d.loteBotinaB = await criarLote(pool, { empresaId: d.empresaB, materialId: d.botinaB, quantidade: 10 });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('ficha e numeração', () => {
    test('a primeira entrega cria a ficha nº 1 do trabalhador; a segunda reutiliza a mesma ficha', async () => {
      const antes = await retrato(d.empresaA);
      const primeira = await registrar();
      assert.equal(primeira.repetida, false);
      assert.deepEqual([primeira.ficha.numero, primeira.ficha.funcionarioId], [1, d.funcA1]);
      assert.equal(await fichasDe(d.funcA1), 1);

      const segunda = await registrar({ itens: [item({ loteId: d.loteBotina41 })] });
      assert.equal(segunda.ficha.id, primeira.ficha.id);
      assert.equal(await fichasDe(d.funcA1), 1);
      const depois = await retrato(d.empresaA);
      assert.deepEqual(depois, { ...antes, fichas: antes.fichas + 1, entregas: antes.entregas + 2, itens: antes.itens + 2, confirmacoes: antes.confirmacoes + 2, operacoes: antes.operacoes + 2, entregue: antes.entregue + 2, auditorias: antes.auditorias + 2, contador: 1 });
      d.fichaA1 = primeira.ficha.id;
    });

    test('a ficha de outro trabalhador recebe o número seguinte; a numeração é por empresa', async () => {
      const r = await registrar({ funcionarioId: d.funcA2, itens: [item({ justificativaForaGhe: 'Trabalhador sem GHE definido' })] });
      assert.equal(r.ficha.numero, 2);
      assert.equal(await contador(d.empresaA), 2);
      const b = await servico.registrarEntrega(pool, dados({
        empresaId: d.empresaB, atorId: d.masterB, funcionarioId: d.funcB1,
        itens: [{ materialId: d.botinaB, loteId: d.loteBotinaB, quantidade: 1, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE' }],
      }));
      assert.equal(b.ficha.numero, 1);
    });

    test('falha depois de criar a ficha desfaz a ficha e o contador: sem lacuna na numeração', async (t) => {
      const funcionario = await novoFuncionario();
      const itens = [item({ justificativaForaGhe: 'Trabalhador sem GHE definido' })];
      const antes = await retrato(d.empresaA);
      t.mock.method(confirmacaoRepo, 'criar', async () => { throw new Error('falha simulada na confirmação'); });
      await assert.rejects(registrar({ funcionarioId: funcionario, itens }), /falha simulada/);
      assert.deepEqual(await retrato(d.empresaA), antes);
      t.mock.restoreAll();
      const r = await registrar({ funcionarioId: funcionario, itens });
      assert.equal(r.ficha.numero, antes.contador + 1);
    });
  });

  describe('trabalhador', () => {
    test('inexistente e de outra empresa: 404; inativo: 409 FUNCIONARIO_INATIVO; nada gravado', async () => {
      const antes = await retrato(d.empresaA);
      await esperarHttpError(registrar({ funcionarioId: 999999 }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
      await esperarHttpError(registrar({ funcionarioId: d.funcB1 }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
      await esperarHttpError(registrar({ funcionarioId: d.funcInativo }), 409, 'FUNCIONARIO_INATIVO');
      assert.deepEqual(await retrato(d.empresaA), antes);
    });
  });

  describe('material', () => {
    test('inexistente e de outra empresa: 404; inativo, sem prazo, sem classificação de tamanho e óculos sem classificação: 409 específicos', async () => {
      const antes = await retrato(d.empresaA);
      await esperarHttpError(registrar({ itens: [item({ materialId: 999999 })] }), 404, 'MATERIAL_NAO_ENCONTRADO');
      await esperarHttpError(registrar({ itens: [item({ materialId: d.botinaB, loteId: d.loteBotinaB })] }), 404, 'MATERIAL_NAO_ENCONTRADO');
      await esperarHttpError(registrar({ itens: [item({ materialId: d.inativo, loteId: d.loteInativo, justificativaForaGhe: 'x' })] }), 409, 'MATERIAL_INATIVO');
      await esperarHttpError(registrar({ itens: [item({ materialId: d.semPrazo, loteId: d.loteSemPrazo, justificativaForaGhe: 'x' })] }), 409, 'MATERIAL_PRAZO_NAO_CLASSIFICADO');
      await esperarHttpError(registrar({ itens: [item({ materialId: d.semClassificacaoTamanho, loteId: d.loteSemClassificacaoTamanho, justificativaForaGhe: 'x' })] }), 409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO');
      await esperarHttpError(registrar({ itens: [item({ materialId: d.oculosSemClassificacao, loteId: d.loteOculosSemClassificacao, justificativaForaGhe: 'x' })] }), 409, 'MATERIAL_OCULOS_NAO_CLASSIFICADO');
      assert.deepEqual(await retrato(d.empresaA), antes);
    });

    test('óculos classificado é entregue com a cópia de oculos_com_grau', async () => {
      const r = await registrar({ itens: [item({ materialId: d.oculos, loteId: d.loteOculos, justificativaForaGhe: 'Atividade eventual com projeção de partículas' })] });
      assert.deepEqual(r.itens[0].material, {
        nome: 'Óculos de proteção incolor', tipo: 'Óculos de proteção', codigoInterno: null, unidade: 'unidade', prazoUsoDias: 180, oculosComGrau: false, exigeCa: true,
      });
    });
  });

  describe('GHE', () => {
    test('EPI previsto no GHE: previsto_no_ghe = true e sem justificativa; justificativa de exceção indevida é recusada', async () => {
      const r = await registrar({ itens: [item({ loteId: d.loteBotina41 })] });
      assert.deepEqual([r.itens[0].previstoNoGhe, r.itens[0].justificativaForaGhe], [true, null]);
      assert.deepEqual([r.entrega.ghe.id, r.entrega.ghe.nome], [d.gheA, 'GHE Produção']);
      await esperarHttpError(registrar({ itens: [item({ justificativaForaGhe: 'Não se aplica' })] }), 409, 'JUSTIFICATIVA_FORA_GHE_NAO_SE_APLICA');
    });

    test('EPI fora do GHE: exige justificativa e fica registrado como exceção', async () => {
      await esperarHttpError(registrar({ itens: [item({ materialId: d.uniforme, loteId: d.loteUniforme })] }), 409, 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA');
      const r = await registrar({ itens: [item({ materialId: d.uniforme, loteId: d.loteUniforme, justificativaForaGhe: 'Visita à área externa' })] });
      assert.deepEqual([r.itens[0].previstoNoGhe, r.itens[0].justificativaForaGhe], [false, 'Visita à área externa']);
    });

    test('trabalhador sem GHE: todo item é fora do GHE e a entrega não guarda GHE', async () => {
      await esperarHttpError(registrar({ funcionarioId: d.funcA2 }), 409, 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA');
      const r = await registrar({ funcionarioId: d.funcA2, itens: [item({ justificativaForaGhe: 'Sem GHE definido' })] });
      assert.deepEqual([r.entrega.ghe, r.itens[0].previstoNoGhe], [null, false]);
    });
  });

  describe('lote, tamanho, CA e saldo', () => {
    test('lote inexistente e de outra empresa: 404; lote de outro material: 409', async () => {
      await esperarHttpError(registrar({ itens: [item({ loteId: 999999 })] }), 404, 'LOTE_NAO_ENCONTRADO');
      await esperarHttpError(registrar({ itens: [item({ loteId: d.loteBotinaB })] }), 404, 'LOTE_NAO_ENCONTRADO');
      await esperarHttpError(registrar({ itens: [item({ loteId: d.loteLuva })] }), 409, 'LOTE_MATERIAL_DIVERGENTE');
    });

    test('material que exige tamanho não sai de lote sem tamanho; material sem tamanho sai do lote como ele é', async () => {
      await esperarHttpError(registrar({ itens: [item({ loteId: d.loteBotinaSemTamanho })] }), 409, 'LOTE_SEM_TAMANHO');
      const r = await registrar({ itens: [item({ materialId: d.luva, loteId: d.loteLuva })] });
      assert.deepEqual([r.itens[0].lote.tamanho, r.itens[0].lote.caNumero], [null, '12345']);
    });

    test('CA vencido: 409 CA_VENCIDO; CA que vence hoje: aceito; material que exige CA não sai de lote sem CA; material sem CA sai', async () => {
      await esperarHttpError(registrar({ itens: [item({ materialId: d.luva, loteId: d.loteLuvaVencido })] }), 409, 'CA_VENCIDO');
      const hoje = await registrar({ itens: [item({ materialId: d.luva, loteId: d.loteLuvaVenceHoje })] });
      assert.deepEqual([hoje.itens[0].lote.caValidade, hoje.entrega.dataOperacional], [HOJE, HOJE]);
      await esperarHttpError(registrar({ itens: [item({ loteId: d.loteBotinaSemCa })] }), 409, 'CA_AUSENTE');
      const uniforme = await registrar({ itens: [item({ materialId: d.uniforme, loteId: d.loteUniforme, justificativaForaGhe: 'Visita' })] });
      assert.deepEqual([uniforme.itens[0].lote.caNumero, uniforme.itens[0].material.exigeCa], [null, false]);
    });

    test('saldo suficiente sai pelo gatilho da 059 (quantidade_entregue); saldo insuficiente é 409 e nada é gravado', async () => {
      const antes = await lote(d.loteBotina41);
      const r = await registrar({ itens: [item({ loteId: d.loteBotina41, quantidade: 2 })] });
      const depois = await lote(d.loteBotina41);
      assert.deepEqual([depois.quantidade_entregue - antes.quantidade_entregue, antes.saldo - depois.saldo], [2, 2]);
      // O item histórico não carrega o saldo do estoque, que é mutável; o saldo se prova no estoque.
      assert.equal('saldo' in r.itens[0].lote, false);
      assert.deepEqual(Object.keys(r.itens[0].lote).sort(), ['caNumero', 'caValidade', 'tamanho']);
      const retratoAntes = await retrato(d.empresaA);
      await esperarHttpError(registrar({ itens: [item({ loteId: d.loteBotina41, quantidade: depois.saldo + 1 })] }), 409, 'SALDO_INSUFICIENTE');
      assert.deepEqual(await retrato(d.empresaA), retratoAntes);
      assert.deepEqual(await lote(d.loteBotina41), depois);
    });
  });

  describe('itens', () => {
    test('vários itens: um por lote, gravados em ordem canônica de lote, cada um com a sua operação ENTREGA', async () => {
      const r = await registrar({
        itens: [
          item({ materialId: d.luva, loteId: d.loteLuva, quantidade: 3, motivo: 'SUBSTITUICAO_PRAZO' }),
          item({ loteId: d.loteBotina40, quantidade: 2, motivo: 'DESGASTE_DANO' }),
          item({ materialId: d.uniforme, loteId: d.loteUniforme, motivo: 'OUTRO', justificativa: 'Reposição extra', justificativaForaGhe: 'Visita' }),
        ],
      });
      const lotesEsperados = [d.loteBotina40, d.loteLuva, d.loteUniforme].sort((a, b) => a - b);
      assert.deepEqual(r.itens.map((i) => i.loteId), lotesEsperados);
      const { rows } = await q(
        `SELECT i.lote_id, i.quantidade, o.tipo, o.quantidade AS op_quantidade, o.chave_idempotencia, o.requisicao_hash
           FROM entregas_epi_itens i JOIN estoque_operacoes o ON o.entrega_item_id = i.id
          WHERE i.entrega_id = $1 ORDER BY i.id`,
        [r.entrega.id],
      );
      assert.deepEqual(rows.map((l) => [l.lote_id, l.quantidade === l.op_quantidade, l.tipo, l.chave_idempotencia, l.requisicao_hash]), lotesEsperados.map((id) => [id, true, 'ENTREGA', null, null]));
      assert.deepEqual(r.itens.map((i) => i.operacaoId !== undefined && /^\d+$/.test(i.operacaoId)), [true, true, true]);
    });

    test('20 itens são aceitos; 21 e lote repetido são recusados antes de tocar o banco', async () => {
      const lotes = [];
      for (let i = 0; i < 21; i += 1) {
        lotes.push(await criarLote(pool, { empresaId: d.empresaA, materialId: d.luva, quantidade: 2, tamanho: null }));
      }
      const itens = (n) => lotes.slice(0, n).map((loteId) => item({ materialId: d.luva, loteId }));
      const r = await registrar({ itens: itens(20) });
      assert.equal(r.itens.length, 20);
      await esperarValidacao(registrar({ itens: itens(21) }), 'body.itens', 'ITENS_FORA_DO_LIMITE');
      await esperarValidacao(registrar({ itens: [item(), item({ quantidade: 2 })] }), 'body.itens', 'LOTE_REPETIDO');
      await esperarValidacao(registrar({ itens: [] }), 'body.itens', 'ITENS_FORA_DO_LIMITE');
    });

    test('motivo fora da lista e OUTRO sem justificativa são recusados', async () => {
      await esperarValidacao(registrar({ itens: [item({ motivo: 'TROCA' })] }), 'body.itens[0].motivo', 'VALOR_NAO_PERMITIDO');
      await esperarValidacao(registrar({ itens: [item({ motivo: 'OUTRO' })] }), 'body.itens[0].justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
      const r = await registrar({ itens: [item({ motivo: 'PERDA_EXTRAVIO', justificativa: 'Extraviada no deslocamento' })] });
      assert.deepEqual([r.itens[0].motivo, r.itens[0].justificativa], ['PERDA_EXTRAVIO', 'Extraviada no deslocamento']);
    });
  });

  describe('confirmação e hash de conteúdo', () => {
    test('DESENHO grava os traços normalizados; DESENHO sem traços ou com estrutura inválida é recusado', async () => {
      const r = await registrar({ confirmacao: DESENHO });
      assert.deepEqual([r.confirmacao.modo, r.confirmacao.tracos], ['DESENHO', TRACOS]);
      const { rows: [linha] } = await q('SELECT modo, tracos, declaracao_versao, declaracao_texto FROM entregas_epi_confirmacoes WHERE entrega_id = $1', [r.entrega.id]);
      assert.deepEqual(linha, { modo: 'DESENHO', tracos: TRACOS, declaracao_versao: 'NR6-2026-09', declaracao_texto: DECLARACAO });
      await esperarValidacao(registrar({ confirmacao: { ...DESENHO, tracos: null } }), 'body.confirmacao.tracos', 'TRACOS_OBRIGATORIOS');
      await esperarValidacao(registrar({ confirmacao: { ...DESENHO, tracos: { pontos: [[1, 1]] } } }), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS');
      await esperarValidacao(registrar({ confirmacao: { ...DESENHO, tracos: [[[1.5, 2]]] } }), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS');
      await esperarValidacao(registrar({ confirmacao: { ...DESENHO, tracos: [[[1, 2, 3]]] } }), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS');
      await esperarValidacao(registrar({ confirmacao: { ...DESENHO, tracos: [[]] } }), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS');
      await esperarValidacao(registrar({ confirmacao: { ...DESENHO, tracos: [[[{ x: 1 }, 2]]] } }), 'body.confirmacao.tracos', 'TRACOS_INVALIDOS');
    });

    test('ACEITE_PRESENCIAL grava tracos nulos; com traços é recusado; modo desconhecido é recusado', async () => {
      const r = await registrar({ confirmacao: ACEITE });
      assert.deepEqual([r.confirmacao.modo, r.confirmacao.tracos], ['ACEITE_PRESENCIAL', null]);
      await esperarValidacao(registrar({ confirmacao: { ...ACEITE, tracos: TRACOS } }), 'body.confirmacao.tracos', 'TRACOS_NAO_SE_APLICAM');
      await esperarValidacao(registrar({ confirmacao: { ...ACEITE, modo: 'BIOMETRIA' } }), 'body.confirmacao.modo', 'VALOR_NAO_PERMITIDO');
    });

    test('declaracaoTexto é persistido exatamente como validado; vazio, com espaço nas pontas, com caractere de controle ou acima de 4000 é recusado', async () => {
      const texto = 'Declaração — 1ª via.\nRecebi os EPIs e fui orientado(a).';
      const r = await registrar({ confirmacao: { ...ACEITE, declaracaoTexto: texto, declaracaoVersao: 'NR6-2026-09.1' } });
      assert.deepEqual([r.confirmacao.declaracaoTexto, r.confirmacao.declaracaoVersao], [texto, 'NR6-2026-09.1']);
      for (const invalido of ['', '   ', ' texto ', 'a\tb', 'x'.repeat(4001)]) {
        await esperarValidacao(registrar({ confirmacao: { ...ACEITE, declaracaoTexto: invalido } }), 'body.confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA');
      }
      await esperarValidacao(registrar({ confirmacao: { ...ACEITE, declaracaoVersao: 'nr6 2026' } }), 'body.confirmacao.declaracaoVersao', 'FORMATO_INVALIDO');
      const limite = await registrar({ confirmacao: { ...ACEITE, declaracaoTexto: 'x'.repeat(4000) } });
      assert.equal(limite.confirmacao.declaracaoTexto.length, 4000);
    });

    test('o limite de 4000 conta caracteres, como char_length: 4000 caracteres fora do BMP são aceitos e persistidos exatamente; 4001 são recusados', async () => {
      // U+1D400 ocupa duas unidades UTF-16: .length seria 8000.
      const astral = '\u{1D400}';
      const texto = astral.repeat(4000);
      assert.deepEqual([texto.length, Array.from(texto).length], [8000, 4000]);
      const r = await registrar({ confirmacao: { ...ACEITE, declaracaoTexto: texto } });
      assert.equal(r.confirmacao.declaracaoTexto, texto);
      const { rows: [linha] } = await q('SELECT declaracao_texto, char_length(declaracao_texto)::int AS caracteres FROM entregas_epi_confirmacoes WHERE entrega_id = $1', [r.entrega.id]);
      assert.deepEqual([linha.declaracao_texto === texto, linha.caracteres], [true, 4000]);
      await esperarValidacao(registrar({ confirmacao: { ...ACEITE, declaracaoTexto: astral.repeat(4001) } }), 'body.confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA');
      await esperarValidacao(registrar({ confirmacao: { ...ACEITE, declaracaoTexto: `${'x'.repeat(4000)}y` } }), 'body.confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA');
    });

    test('hash_conteudo: SHA-256 determinístico do conteúdo histórico, recalculável a partir do que foi gravado, sem incluir a si mesmo', async () => {
      const r = await registrar({ confirmacao: DESENHO, itens: [item({ loteId: d.loteBotina40, quantidade: 2 })] });
      assert.match(r.confirmacao.hashConteudo, /^[0-9a-f]{64}$/);
      const { rows: [gravado] } = await q('SELECT hash_conteudo FROM entregas_epi_confirmacoes WHERE entrega_id = $1', [r.entrega.id]);
      assert.equal(gravado.hash_conteudo, r.confirmacao.hashConteudo);

      const entrega = await entregaRepo.buscarPorId(pool, d.empresaA, r.entrega.id);
      const itens = await itemRepo.listarPorEntrega(pool, d.empresaA, r.entrega.id);
      const confirmacao = await confirmacaoRepo.buscarPorEntrega(pool, d.empresaA, r.entrega.id);
      const ficha = await fichaRepo.buscarPorId(pool, d.empresaA, r.entrega.fichaId);
      const recalculado = servico.calcularHashConteudo({ entrega, ficha, itens, confirmacao });
      assert.equal(recalculado, gravado.hash_conteudo);
      const alterado = servico.calcularHashConteudo({ entrega, ficha, itens: [{ ...itens[0], quantidade: 3 }], confirmacao });
      assert.notEqual(alterado, gravado.hash_conteudo);
      assert.equal(servico.calcularHashConteudo({ entrega, ficha, itens, confirmacao: { ...confirmacao, hashConteudo: 'f'.repeat(64) } }), gravado.hash_conteudo);
    });
  });

  describe('cópias congeladas e auditoria', () => {
    test('a entrega guarda a empresa, o trabalhador, o GHE e o responsável lidos na transação; entregue_em e data_operacional vêm do servidor', async () => {
      const r = await registrar();
      assert.deepEqual(r.entrega.empresa, { nome: 'Empresa A Ltda', cnpj: CNPJ_A, endereco: 'Rua Fictícia, 100, 100 - Galpão 2 - Industrial', cidade: 'Cidade Fictícia', uf: 'SP' });
      assert.deepEqual(r.entrega.trabalhador, { nome: `Trabalhador M-1`, matricula: 'M-1', funcao: 'Operador', setor: 'Produção' });
      assert.deepEqual(r.entrega.responsavel, { id: d.masterA, nome: 'Responsável Fictício' });
      assert.deepEqual([r.entrega.origem, r.entrega.dataOperacional], ['DIRETA', HOJE]);
      assert.ok(r.entrega.entregueEm instanceof Date && Date.now() - r.entrega.entregueEm.getTime() < 60_000);
      await q("UPDATE funcionarios SET nome = 'Nome Alterado' WHERE id = $1", [d.funcA1]);
      const { rows: [linha] } = await q('SELECT trabalhador_nome FROM entregas_epi WHERE id = $1', [r.entrega.id]);
      assert.equal(linha.trabalhador_nome, 'Trabalhador M-1');
      await q("UPDATE funcionarios SET nome = 'Trabalhador M-1' WHERE id = $1", [d.funcA1]);
    });

    test('ENTREGA_REGISTRADA na mesma transação: contexto estruturado com ficha, itens, operações, confirmação, hash, idempotência e saldos antes/depois; sem traços nem texto da declaração', async () => {
      const chave = crypto.randomUUID();
      const antes = await lote(d.loteBotina40);
      const r = await registrar({ chaveIdempotencia: chave, confirmacao: DESENHO, itens: [item({ quantidade: 2 })] });
      const { rows: [log] } = await q(
        "SELECT usuario_id, referencia, ip, dispositivo, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'ENTREGA_REGISTRADA' AND referencia = $2",
        [d.empresaA, String(r.entrega.id)],
      );
      assert.deepEqual([log.usuario_id, log.ip, log.dispositivo], [d.masterA, '203.0.113.10', 'Navegador de teste']);
      assert.deepEqual(log.contexto.ficha, { id: r.ficha.id, numero: r.ficha.numero });
      assert.deepEqual([log.contexto.entregaId, log.contexto.funcionarioId, log.contexto.gheId], [r.entrega.id, d.funcA1, d.gheA]);
      assert.deepEqual(log.contexto.itens, r.itens.map((i) => ({ itemId: i.id, materialId: i.materialId, loteId: i.loteId, quantidade: i.quantidade, motivo: i.motivo, previstoNoGhe: i.previstoNoGhe, operacaoId: i.operacaoId })));
      assert.deepEqual(log.contexto.confirmacao, { modo: 'DESENHO', declaracaoVersao: 'NR6-2026-09', hashConteudo: r.confirmacao.hashConteudo });
      assert.deepEqual(log.contexto.idempotencia, { chave, requisicaoHash: log.contexto.idempotencia.requisicaoHash });
      assert.match(log.contexto.idempotencia.requisicaoHash, /^[0-9a-f]{64}$/);
      assert.deepEqual(log.dados_anteriores, { saldos: [{ loteId: d.loteBotina40, saldo: antes.saldo }] });
      assert.deepEqual(log.dados_novos, { saldos: [{ loteId: d.loteBotina40, saldo: antes.saldo - 2 }] });
      const texto = JSON.stringify(log.contexto);
      assert.doesNotMatch(texto, /tracos|declaracaoTexto|Declaro/);
    });
  });

  describe('rollback total', () => {
    const cenarios = [
      ['a confirmação falha', confirmacaoRepo, 'criar'],
      ['a operação de estoque falha', operacaoRepo, 'registrarEntrega'],
      ['a auditoria falha', auditoriaRepo, 'registrar'],
      ['a gravação de um item falha', itemRepo, 'criar'],
    ];
    for (const [rotulo, modulo, fn] of cenarios) {
      test(`quando ${rotulo}, nada fica gravado: entrega, itens, operações, saldo, ficha, contador e auditoria iguais a antes`, async (t) => {
        const funcionario = await novoFuncionario();
        const antes = await retrato(d.empresaA);
        const saldoAntes = await lote(d.loteBotina40);
        t.mock.method(modulo, fn, async () => { throw new Error(`falha simulada: ${fn}`); });
        await assert.rejects(registrar({ funcionarioId: funcionario, itens: [item({ quantidade: 3, justificativaForaGhe: 'Sem GHE' })] }), /falha simulada/);
        t.mock.restoreAll();
        assert.deepEqual(await retrato(d.empresaA), antes);
        assert.deepEqual(await lote(d.loteBotina40), saldoAntes);
        assert.equal(await fichasDe(funcionario), 0);
      });
    }
  });

  describe('idempotência', () => {
    test('mesma chave e mesmo conteúdo em sequência: devolve a entrega original, sem gravar de novo (mesmo com a ordem dos itens trocada)', async () => {
      const chave = crypto.randomUUID();
      const itens = [item({ loteId: d.loteBotina40, quantidade: 1 }), item({ materialId: d.luva, loteId: d.loteLuva, quantidade: 2 })];
      const primeira = await registrar({ chaveIdempotencia: chave, itens, confirmacao: DESENHO });
      const antes = await retrato(d.empresaA);
      const repetida = await registrar({ chaveIdempotencia: chave, itens: [itens[1], itens[0]], confirmacao: DESENHO });
      assert.equal(repetida.repetida, true);
      assert.deepEqual(
        [repetida.entrega.id, repetida.ficha.id, repetida.itens.map((i) => i.id), repetida.confirmacao.hashConteudo, repetida.confirmacao.tracos],
        [primeira.entrega.id, primeira.ficha.id, primeira.itens.map((i) => i.id), primeira.confirmacao.hashConteudo, TRACOS],
      );
      assert.deepEqual(await retrato(d.empresaA), antes);
    });

    test('a repetição devolve o mesmo conteúdo histórico mesmo depois de o saldo do lote mudar: o item não carrega saldo', async () => {
      const chave = crypto.randomUUID();
      const loteId = await criarLote(pool, { empresaId: d.empresaA, materialId: d.luva, quantidade: 10, tamanho: null, caNumero: '888', caValidade: '2099-12-31' });
      const requisicao = { chaveIdempotencia: chave, itens: [item({ materialId: d.luva, loteId, quantidade: 2 })], confirmacao: DESENHO };
      const primeira = await registrar(requisicao);
      assert.equal(primeira.repetida, false);
      assert.deepEqual(await lote(loteId), { quantidade_entregue: 2, saldo: 8 });

      const baixa = await estoqueServico.registrarBaixa(pool, {
        empresaId: d.empresaA, atorId: d.masterA, loteId, quantidade: 3, motivo: 'AVARIA', chaveIdempotencia: crypto.randomUUID(),
      });
      assert.deepEqual([baixa.repetida, (await lote(loteId)).saldo], [false, 5]);

      const repetida = await registrar(requisicao);
      assert.deepEqual([repetida.repetida, repetida.entrega.id], [true, primeira.entrega.id]);
      const { repetida: _a, ...conteudoPrimeira } = primeira;
      const { repetida: _b, ...conteudoRepetida } = repetida;
      assert.deepEqual(conteudoRepetida, conteudoPrimeira);
      assert.equal('saldo' in repetida.itens[0].lote, false);
      assert.equal('saldo' in primeira.itens[0].lote, false);
    });

    test('mesma chave com conteúdo diferente: 409 IDEMPOTENCIA_CONFLITO, sem gravar', async () => {
      const chave = crypto.randomUUID();
      await registrar({ chaveIdempotencia: chave });
      const antes = await retrato(d.empresaA);
      await esperarHttpError(registrar({ chaveIdempotencia: chave, itens: [item({ quantidade: 2 })] }), 409, 'IDEMPOTENCIA_CONFLITO');
      await esperarHttpError(registrar({ chaveIdempotencia: chave, confirmacao: DESENHO }), 409, 'IDEMPOTENCIA_CONFLITO');
      await esperarHttpError(registrar({ chaveIdempotencia: chave, confirmacao: { ...ACEITE, declaracaoTexto: 'Outro texto' } }), 409, 'IDEMPOTENCIA_CONFLITO');
      assert.deepEqual(await retrato(d.empresaA), antes);
    });

    test('os espaços de idempotência são independentes: o mesmo UUID vale uma vez no estoque e uma vez na entrega; outra empresa também pode usá-lo', async () => {
      const chave = crypto.randomUUID();
      const entrada = await estoqueServico.registrarEntrada(pool, {
        empresaId: d.empresaA, atorId: d.masterA, materialId: d.luva, tamanho: null, quantidade: 3, caNumero: '777', caValidade: '2099-01-01', chaveIdempotencia: chave, hoje: HOJE,
      });
      assert.equal(entrada.repetida, false);
      const entrega = await registrar({ chaveIdempotencia: chave });
      assert.equal(entrega.repetida, false);
      const outraEmpresa = await servico.registrarEntrega(pool, dados({
        empresaId: d.empresaB, atorId: d.masterB, funcionarioId: d.funcB1, chaveIdempotencia: chave,
        itens: [{ materialId: d.botinaB, loteId: d.loteBotinaB, quantidade: 1, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE' }],
      }));
      assert.equal(outraEmpresa.repetida, false);
      assert.equal(await contar('SELECT count(*)::int AS n FROM entregas_epi WHERE chave_idempotencia = $1', [chave]), 2);
    });
  });

  describe('multiempresa', () => {
    test('a empresa B não alcança trabalhador, material nem lote da empresa A, e o ator de B só assina entregas de B', async () => {
      const deB = (extra) => servico.registrarEntrega(pool, dados({ empresaId: d.empresaB, atorId: d.masterB, funcionarioId: d.funcB1, ...extra }));
      const itemB = (extra = {}) => ({ materialId: d.botinaB, loteId: d.loteBotinaB, quantidade: 1, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE', ...extra });
      await esperarHttpError(deB({ funcionarioId: d.funcA1, itens: [itemB()] }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
      await esperarHttpError(deB({ itens: [itemB({ materialId: d.botina, loteId: d.loteBotina40 })] }), 404, 'MATERIAL_NAO_ENCONTRADO');
      await esperarHttpError(deB({ itens: [itemB({ loteId: d.loteBotina40 })] }), 404, 'LOTE_NAO_ENCONTRADO');
      await esperarHttpError(registrar({ atorId: d.masterB }), 404, 'RESPONSAVEL_NAO_ENCONTRADO');
      assert.equal(await contar('SELECT count(*)::int AS n FROM entregas_epi e JOIN fichas_epi f ON f.id = e.ficha_id WHERE e.empresa_id <> f.empresa_id'), 0);
    });
  });
});

describe('entrega de EPI — concorrência (PostgreSQL real, conexões simultâneas)', () => {
  let contexto;
  let pool;
  const d = {};
  let cpfSequencia = 100;

  const q = (sql, params) => pool.query(sql, params);
  const lote = async (id) => (await q('SELECT quantidade_entregue, saldo FROM estoque_lotes WHERE id = $1', [id])).rows[0];
  const fichasDe = (funcionarioId) => (async () => (await q('SELECT count(*)::int AS n FROM fichas_epi WHERE funcionario_id = $1', [funcionarioId])).rows[0].n)();

  async function novoFuncionario(extra = {}) {
    cpfSequencia += 1;
    return criarFuncionario(pool, d.empresa, { matricula: `C-${cpfSequencia}`, cpf: String(cpfSequencia).padStart(11, '0'), ...extra });
  }
  const dados = (extra = {}) => ({
    empresaId: d.empresa, atorId: d.master, funcionarioId: d.funcionario, itens: [{ materialId: d.material, loteId: d.lote, quantidade: 1, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE' }],
    confirmacao: ACEITE, chaveIdempotencia: crypto.randomUUID(), ...extra,
  });
  const registrar = (extra) => servico.registrarEntrega(pool, dados(extra)).then((r) => ({ ok: true, r }), (erro) => ({ ok: false, erro }));

  // Alguém deste banco, fora a conexão administrativa, está esperando um lock.
  async function aguardarAlguemEsperandoLock(admin, { tentativas = 300, intervaloMs = 10 } = {}) {
    for (let i = 0; i < tentativas; i += 1) {
      const { rows } = await admin.query(
        "SELECT wait_event FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' LIMIT 1",
      );
      if (rows.length > 0) return rows[0].wait_event;
      await new Promise((resolve) => { setTimeout(resolve, intervaloMs); });
    }
    throw new Error('nenhuma conexão chegou a esperar lock dentro do tempo esperado');
  }

  // A primeira chamada passa pelo portão e para; a segunda só é disparada
  // depois que a primeira chegou lá; o portão abre quando a segunda está
  // presa numa trava do banco.
  async function emParalelo(t, modulo, fn, dadosA, dadosB) {
    const admin = await pool.connect();
    try {
      const { liberar, chegada } = portao(t, modulo, fn);
      const promessaA = registrar(dadosA);
      await chegada;
      const promessaB = registrar(dadosB);
      const esperou = await aguardarAlguemEsperandoLock(admin);
      liberar();
      const [a, b] = await Promise.all([promessaA, promessaB]);
      return { a, b, esperou };
    } finally {
      admin.release();
      t.mock.restoreAll();
    }
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS);
    pool = contexto.pool;
    d.empresa = await criarEmpresa(pool, CNPJ_A, 'Empresa A');
    d.master = await criarUsuario(pool, d.empresa, 'master@example.invalid');
    d.funcionario = await novoFuncionario();
    d.outroFuncionario = await novoFuncionario();
    d.material = await criarMaterial(pool, d.empresa, 'Botina');
    d.lote = await criarLote(pool, { empresaId: d.empresa, materialId: d.material, quantidade: 100 });
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('duas primeiras entregas simultâneas do mesmo trabalhador: a segunda espera a trava do trabalhador e reutiliza a ficha; nasce uma ficha só', async (t) => {
    const funcionario = await novoFuncionario();
    const { a, b, esperou } = await emParalelo(t, fichaRepo, 'criar', { funcionarioId: funcionario }, { funcionarioId: funcionario });
    assert.ok(['transactionid', 'tuple'].includes(esperou), esperou);
    assert.equal(a.ok && b.ok, true, JSON.stringify([a.erro?.message, b.erro?.message]));
    assert.equal(a.r.ficha.id, b.r.ficha.id);
    assert.equal(await fichasDe(funcionario), 1);
    assert.equal((await lote(d.lote)).quantidade_entregue, 2);
  });

  test('a inativação do trabalhador espera a entrega em curso terminar', async (t) => {
    const funcionario = await novoFuncionario();
    const admin = await pool.connect();
    const outra = await pool.connect();
    try {
      const { liberar, chegada } = portao(t, itemRepo, 'criar');
      const promessaEntrega = registrar({ funcionarioId: funcionario });
      await chegada;
      const promessaInativacao = outra.query('UPDATE funcionarios SET ativo = false WHERE id = $1', [funcionario]).then(() => 'inativado');
      const esperou = await aguardarAlguemEsperandoLock(admin);
      assert.ok(['transactionid', 'tuple'].includes(esperou), esperou);
      liberar();
      const entrega = await promessaEntrega;
      assert.equal(entrega.ok, true, entrega.erro?.message);
      assert.equal(await promessaInativacao, 'inativado');
      const depois = await registrar({ funcionarioId: funcionario });
      assert.deepEqual([depois.ok, depois.erro?.codigo], [false, 'FUNCIONARIO_INATIVO']);
    } finally {
      outra.release();
      admin.release();
      t.mock.restoreAll();
    }
  });

  test('duas entregas de trabalhadores diferentes no mesmo lote: saldo suficiente para as duas, gravadas em série', async (t) => {
    const loteId = await criarLote(pool, { empresaId: d.empresa, materialId: d.material, quantidade: 10, tamanho: '41' });
    const itens = (quantidade) => [{ materialId: d.material, loteId, quantidade, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE' }];
    const { a, b } = await emParalelo(t, itemRepo, 'criar', { funcionarioId: d.funcionario, itens: itens(4) }, { funcionarioId: d.outroFuncionario, itens: itens(6) });
    assert.equal(a.ok && b.ok, true, JSON.stringify([a.erro?.message, b.erro?.message]));
    assert.deepEqual(await lote(loteId), { quantidade_entregue: 10, saldo: 0 });
  });

  test('duas entregas no mesmo lote com saldo só para uma: a segunda espera a trava do lote e é recusada com 409, sem saldo negativo nem baixa duplicada', async (t) => {
    const loteId = await criarLote(pool, { empresaId: d.empresa, materialId: d.material, quantidade: 10, tamanho: '42' });
    const itens = (quantidade) => [{ materialId: d.material, loteId, quantidade, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE' }];
    const { a, b, esperou } = await emParalelo(t, itemRepo, 'criar', { funcionarioId: d.funcionario, itens: itens(6) }, { funcionarioId: d.outroFuncionario, itens: itens(6) });
    assert.ok(['transactionid', 'tuple'].includes(esperou), esperou);
    assert.equal(a.ok, true, a.erro?.message);
    assert.deepEqual([b.ok, b.erro?.status, b.erro?.codigo], [false, 409, 'SALDO_INSUFICIENTE']);
    assert.deepEqual(await lote(loteId), { quantidade_entregue: 6, saldo: 4 });
    assert.equal((await q("SELECT count(*)::int AS n FROM estoque_operacoes WHERE lote_id = $1 AND tipo = 'ENTREGA'", [loteId])).rows[0].n, 1);
  });

  test('duas entregas competindo pelo último saldo: só uma leva; a outra recebe 409', async (t) => {
    const loteId = await criarLote(pool, { empresaId: d.empresa, materialId: d.material, quantidade: 1, tamanho: '43' });
    const itens = [{ materialId: d.material, loteId, quantidade: 1, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE' }];
    const { a, b } = await emParalelo(t, itemRepo, 'criar', { funcionarioId: d.funcionario, itens }, { funcionarioId: d.outroFuncionario, itens });
    assert.equal(a.ok, true, a.erro?.message);
    assert.deepEqual([b.ok, b.erro?.codigo], [false, 'SALDO_INSUFICIENTE']);
    assert.deepEqual(await lote(loteId), { quantidade_entregue: 1, saldo: 0 });
  });

  test('a mesma chave enviada em paralelo: a segunda espera o advisory lock e recebe a entrega original; uma entrega e uma operação só', async (t) => {
    const chave = crypto.randomUUID();
    const antes = await lote(d.lote);
    const { a, b, esperou } = await emParalelo(t, entregaRepo, 'criar', { chaveIdempotencia: chave }, { chaveIdempotencia: chave });
    assert.equal(esperou, 'advisory');
    assert.equal(a.ok && b.ok, true, JSON.stringify([a.erro?.message, b.erro?.message]));
    assert.deepEqual([a.r.repetida, b.r.repetida, a.r.entrega.id === b.r.entrega.id], [false, true, true]);
    assert.equal((await q('SELECT count(*)::int AS n FROM entregas_epi WHERE chave_idempotencia = $1', [chave])).rows[0].n, 1);
    assert.equal((await lote(d.lote)).quantidade_entregue, antes.quantidade_entregue + 1);
  });

  test('a mesma chave em paralelo com conteúdo diferente: a segunda espera e recebe 409 IDEMPOTENCIA_CONFLITO', async (t) => {
    const chave = crypto.randomUUID();
    const { a, b, esperou } = await emParalelo(t, entregaRepo, 'criar', { chaveIdempotencia: chave }, { chaveIdempotencia: chave, itens: [{ materialId: d.material, loteId: d.lote, quantidade: 2, motivo: 'ADMISSAO', justificativaForaGhe: 'Sem GHE' }] });
    assert.equal(esperou, 'advisory');
    assert.equal(a.ok, true, a.erro?.message);
    assert.deepEqual([b.ok, b.erro?.codigo], [false, 'IDEMPOTENCIA_CONFLITO']);
    assert.equal((await q('SELECT count(*)::int AS n FROM entregas_epi WHERE chave_idempotencia = $1', [chave])).rows[0].n, 1);
  });
});
