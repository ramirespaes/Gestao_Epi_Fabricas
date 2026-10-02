'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { montarMundoDoServico, chaveNova } = require('./helpers/solicitacao-epi-servico');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Criação da solicitação de EPI (12B) contra PostgreSQL real: validações de
 * trabalhador, GHE, material e tamanho, de 1 a 20 itens, idempotência,
 * numeração por empresa, atomicidade com a auditoria e isolamento entre
 * empresas. A solicitação nasce PENDENTE e não toca o estoque.
 */

const servico = () => exigirModulo('src/services/solicitacao-epi.service');

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
    assert.ok(erro.detalhes.some((x) => x.campo === campo && x.codigo === codigo), JSON.stringify(erro.detalhes));
    return true;
  });
}

describe('criação da solicitação de EPI — serviço (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;

  const q = (sql, params) => pool.query(sql, params);
  const contar = async (tabela, onde = 'true', params = []) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${onde}`, params)).rows[0].n;
  const item = (materialId, extra = {}) => ({ materialId, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', ...extra });
  const criar = (extra = {}) => servico().criarSolicitacao(pool, {
    empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador, itens: [item(d.botina)], chaveIdempotencia: chaveNova(), ...extra,
  });
  const fotoDoEstoque = async () => (await q(
    `SELECT (SELECT json_agg(l ORDER BY l.id) FROM estoque_lotes l) AS lotes, (SELECT json_agg(o ORDER BY o.id) FROM estoque_operacoes o) AS operacoes`,
  )).rows[0];

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('criação válida: nasce PENDENTE, com número da empresa, GHE do trabalhador e previsão no GHE por item; o estoque não é tocado', async () => {
    const antes = await fotoDoEstoque();
    const chave = chaveNova();
    const resultado = await criar({
      chaveIdempotencia: chave,
      observacao: '  Admissão do novo trabalhador  ',
      itens: [
        item(d.luva, { tamanho: '42', quantidade: 2, motivo: 'DESGASTE_DANO', justificativa: 'Luva rasgada' }),
        item(d.capacete, { tamanho: undefined, quantidade: 1 }),
        item(d.botina, { quantidade: 4 }),
      ],
    });
    assert.equal(resultado.repetida, false);
    const { solicitacao, itens } = resultado;
    assert.deepEqual(
      [solicitacao.status, solicitacao.funcionarioId, solicitacao.gheId, solicitacao.origemSolicitacao, solicitacao.solicitanteUsuarioId, solicitacao.quantidadeItens, solicitacao.observacao],
      ['PENDENTE', d.trabalhador, d.gheA, 'USUARIO_INTERNO', d.solicitante, 3, 'Admissão do novo trabalhador'],
    );
    assert.ok(Number.isInteger(solicitacao.numero) && solicitacao.numero > 0);
    assert.deepEqual([solicitacao.decisao, solicitacao.cancelamento, solicitacao.entregueEm, solicitacao.situacaoOperacional], [null, null, null, null]);
    for (const proibida of ['chaveIdempotencia', 'requisicaoHash', 'empresaId']) assert.equal(proibida in solicitacao, false, proibida);

    assert.deepEqual(itens.map((i) => [i.materialId, i.tamanho, i.quantidade, i.motivo, i.previstoNoGhe]), [
      [d.botina, '40', 4, 'ADMISSAO', true],
      [d.capacete, null, 1, 'ADMISSAO', true],
      [d.luva, '42', 2, 'DESGASTE_DANO', false],
    ], 'itens em ordem canônica de material e tamanho');
    assert.deepEqual(itens.map((i) => [i.decisao, i.quantidadeAprovada, i.situacao, i.cobertura, i.posicao]), Array(3).fill([null, null, null, null, null]));
    assert.equal(itens[2].justificativa, 'Luva rasgada');

    const { rows: [gravada] } = await q('SELECT * FROM solicitacoes_epi WHERE id = $1', [solicitacao.id]);
    assert.equal(gravada.chave_idempotencia, chave);
    assert.match(gravada.requisicao_hash, /^[0-9a-f]{64}$/);
    assert.equal(gravada.empresa_id, d.empresaA);
    assert.deepEqual(await fotoDoEstoque(), antes, 'solicitar não reserva nem baixa nada');
  });

  test('um item, e vinte itens (um por tamanho do mesmo material); 21 itens são recusados sem gravar nada', async () => {
    assert.equal((await criar({ itens: [item(d.botina, { tamanho: '39' })] })).itens.length, 1);
    const vinte = Array.from({ length: 20 }, (_, i) => item(d.botina, { tamanho: String(30 + i), quantidade: 1 }));
    const criada = await criar({ itens: vinte });
    assert.equal(criada.itens.length, 20);
    assert.equal(await contar('solicitacoes_epi_itens', 'solicitacao_id = $1', [criada.solicitacao.id]), 20);

    const antes = await contar('solicitacoes_epi');
    const vinteEUm = [...vinte, item(d.capacete, { tamanho: undefined })];
    await esperarValidacao(criar({ itens: vinteEUm }), 'body.itens', 'ITENS_FORA_DO_LIMITE');
    assert.equal(await contar('solicitacoes_epi'), antes);
  });

  test('o mesmo material e tamanho duas vezes é recusado; o mesmo material com tamanhos diferentes é aceito', async () => {
    const antes = await contar('solicitacoes_epi');
    await esperarValidacao(criar({ itens: [item(d.botina), item(d.botina, { quantidade: 5 })] }), 'body.itens', 'ITEM_REPETIDO');
    assert.equal(await contar('solicitacoes_epi'), antes);
    const criada = await criar({ itens: [item(d.botina, { tamanho: '40' }), item(d.botina, { tamanho: '41' })] });
    assert.equal(criada.itens.length, 2);
  });

  test('trabalhador: inexistente, de outra empresa ou inativo é recusado; nada é gravado', async () => {
    const antes = await contar('solicitacoes_epi');
    await esperarHttpError(criar({ funcionarioId: 999999 }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
    await esperarHttpError(criar({ funcionarioId: d.trabalhadorB }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
    await esperarHttpError(criar({ funcionarioId: d.trabalhadorInativo }), 409, 'FUNCIONARIO_INATIVO');
    assert.equal(await contar('solicitacoes_epi'), antes);
  });

  test('material: inexistente, de outra empresa, inativo ou sem classificação de tamanho é recusado', async () => {
    const antes = await contar('solicitacoes_epi');
    await esperarHttpError(criar({ itens: [item(999999)] }), 404, 'MATERIAL_NAO_ENCONTRADO');
    await esperarHttpError(criar({ itens: [item(d.botinaB)] }), 404, 'MATERIAL_NAO_ENCONTRADO');
    await esperarHttpError(criar({ itens: [item(d.inativo)] }), 409, 'MATERIAL_INATIVO');
    await esperarHttpError(criar({ itens: [item(d.naoClassificado, { tamanho: undefined })] }), 409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO');
    assert.equal(await contar('solicitacoes_epi'), antes);
  });

  test('tamanho segue a classificação do material: obrigatório quando exige, recusado quando não usa', async () => {
    await esperarValidacao(criar({ itens: [item(d.botina, { tamanho: undefined })] }), 'body.itens[0].tamanho', 'TAMANHO_OBRIGATORIO');
    await esperarValidacao(criar({ itens: [item(d.botina, { tamanho: null })] }), 'body.itens[0].tamanho', 'TAMANHO_OBRIGATORIO');
    await esperarValidacao(criar({ itens: [item(d.capacete, { tamanho: '40' })] }), 'body.itens[0].tamanho', 'TAMANHO_NAO_SE_APLICA');
    const semTamanho = await criar({ itens: [item(d.capacete, { tamanho: undefined }), item(d.protetor, { tamanho: null })] });
    assert.deepEqual(semTamanho.itens.map((i) => i.tamanho), [null, null]);
  });

  test('o tamanho é gravado na forma canônica (aparado), a mesma dos lotes', async () => {
    const criada = await criar({ itens: [item(d.botina, { tamanho: '  43 ' })] });
    assert.equal(criada.itens[0].tamanho, '43');
  });

  test('fora do GHE é permitido na criação, sem justificativa do solicitante: previsto_no_ghe registra a situação do momento', async () => {
    const criada = await criar({ itens: [item(d.luva, { tamanho: '41' }), item(d.capacete, { tamanho: undefined })] });
    const previsto = Object.fromEntries(criada.itens.map((i) => [i.materialId, i.previstoNoGhe]));
    assert.equal(previsto[d.luva], false);
    assert.equal(previsto[d.capacete], true);
    assert.deepEqual(criada.itens.map((i) => i.justificativa), [null, null], 'nenhuma justificativa técnica exigida');

    const semGhe = await criar({ funcionarioId: d.trabalhadorSemGhe, itens: [item(d.botina, { tamanho: '44' })] });
    assert.equal(semGhe.solicitacao.gheId, null);
    assert.equal(semGhe.itens[0].previstoNoGhe, false, 'sem GHE, nenhum item é previsto');
  });

  test('o GHE e a previsão ficam como eram na criação, mesmo que o trabalhador mude de GHE depois', async () => {
    const trabalhador = await d.novoTrabalhador(d.empresaA, { gheId: d.gheA });
    const criada = await criar({ funcionarioId: trabalhador, itens: [item(d.botina, { tamanho: '45' })] });
    await q('UPDATE funcionarios SET grupo_homogeneo_id = $2 WHERE id = $1', [trabalhador, d.gheA2]);
    const { rows: [lido] } = await q('SELECT ghe_id FROM solicitacoes_epi WHERE id = $1', [criada.solicitacao.id]);
    const { rows: [i] } = await q('SELECT previsto_no_ghe FROM solicitacoes_epi_itens WHERE solicitacao_id = $1', [criada.solicitacao.id]);
    assert.deepEqual([lido.ghe_id, i.previsto_no_ghe], [d.gheA, true]);
  });

  test('o solicitante precisa existir na empresa e estar ativo', async () => {
    await esperarHttpError(criar({ atorId: 999999 }), 404, 'USUARIO_NAO_ENCONTRADO');
    await esperarHttpError(criar({ atorId: d.usuarioB }), 404, 'USUARIO_NAO_ENCONTRADO');
    await esperarHttpError(criar({ atorId: d.usuarioInativo }), 403, 'USUARIO_INATIVO');
  });

  test('motivo OUTRO exige justificativa; texto do pedido aparado e normalizado', async () => {
    await esperarValidacao(criar({ itens: [item(d.botina, { motivo: 'OUTRO' })] }), 'body.itens[0].justificativa', 'JUSTIFICATIVA_OBRIGATORIA');
    const criada = await criar({ itens: [item(d.botina, { tamanho: '46', motivo: 'OUTRO', justificativa: '  Tamanho errado é pequeno  ' })] });
    assert.equal(criada.itens[0].justificativa, 'Tamanho errado é pequeno');
  });

  test('idempotência: a mesma chave e a mesma requisição devolvem a solicitação original, sem gravar de novo nem gastar número', async () => {
    const chave = chaveNova();
    const itens = [item(d.botina, { tamanho: '47' }), item(d.capacete, { tamanho: undefined })];
    const primeira = await criar({ chaveIdempotencia: chave, itens });
    const { rows: [{ ultimo }] } = await q('SELECT ultimo_numero AS ultimo FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaA]);
    const repetida = await criar({ chaveIdempotencia: chave, itens: [...itens].reverse() });
    assert.equal(repetida.repetida, true);
    assert.equal(repetida.solicitacao.id, primeira.solicitacao.id);
    assert.deepEqual(repetida.itens.map((i) => i.id), primeira.itens.map((i) => i.id));
    assert.equal(await contar('solicitacoes_epi', 'chave_idempotencia = $1', [chave]), 1);
    assert.equal(await contar('logs_auditoria', "acao = 'SOLICITACAO_EPI_CRIADA' AND referencia = $1", [String(primeira.solicitacao.id)]), 1);
    const { rows: [{ depois }] } = await q('SELECT ultimo_numero AS depois FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaA]);
    assert.equal(depois, ultimo, 'a repetição não consome número');
  });

  test('a mesma chave com outra requisição, ou de outro solicitante, é conflito; outra empresa pode usar a mesma chave', async () => {
    const chave = chaveNova();
    await criar({ chaveIdempotencia: chave, itens: [item(d.botina, { tamanho: '48' })] });
    await esperarHttpError(criar({ chaveIdempotencia: chave, itens: [item(d.botina, { tamanho: '48', quantidade: 3 })] }), 409, 'IDEMPOTENCIA_CONFLITO');
    await esperarHttpError(criar({ chaveIdempotencia: chave, atorId: d.outroSolicitante, itens: [item(d.botina, { tamanho: '48' })] }), 409, 'IDEMPOTENCIA_CONFLITO');
    await esperarHttpError(criar({ chaveIdempotencia: chave, funcionarioId: d.trabalhador2, itens: [item(d.botina, { tamanho: '48' })] }), 409, 'IDEMPOTENCIA_CONFLITO');
    const outraEmpresa = await servico().criarSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [item(d.botinaB)], chaveIdempotencia: chave,
    });
    assert.equal(outraEmpresa.repetida, false);
  });

  test('cinco requisições simultâneas com a mesma chave criam uma solicitação só; as outras recebem a original', async () => {
    const chave = chaveNova();
    const itens = [item(d.botina, { tamanho: '49' })];
    const resultados = await Promise.all(Array.from({ length: 5 }, () => criar({ chaveIdempotencia: chave, itens })));
    assert.equal(resultados.filter((r) => r.repetida === false).length, 1);
    assert.equal(new Set(resultados.map((r) => r.solicitacao.id)).size, 1);
    assert.equal(await contar('solicitacoes_epi', 'chave_idempotencia = $1', [chave]), 1);
  });

  test('numeração por empresa: dez criações simultâneas recebem números consecutivos; a outra empresa tem a sua sequência', async () => {
    const { rows: [{ ultimo }] } = await q('SELECT COALESCE(max(ultimo_numero), 0)::int AS ultimo FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaA]);
    const resultados = await Promise.all(Array.from({ length: 10 }, (_, i) => criar({ itens: [item(d.protetor, { tamanho: undefined, quantidade: i + 1 })] })));
    const numeros = resultados.map((r) => r.solicitacao.numero).sort((a, b) => a - b);
    assert.deepEqual(numeros, Array.from({ length: 10 }, (_, i) => ultimo + 1 + i));
    const { rows: [{ ultimoB }] } = await q('SELECT COALESCE(max(ultimo_numero), 0)::int AS "ultimoB" FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaB]);
    const deB = await servico().criarSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [item(d.botinaB)], chaveIdempotencia: chaveNova(),
    });
    assert.equal(deB.solicitacao.numero, ultimoB + 1, 'a sequência da B é a dela, independente da A');
  });

  test('auditoria SOLICITACAO_EPI_CRIADA na mesma transação: quem, o quê, itens e a chave; sem texto livre nem dado pessoal', async () => {
    const chave = chaveNova();
    const criada = await criar({ chaveIdempotencia: chave, observacao: 'Texto livre da observação', itens: [item(d.botina, { tamanho: '50', justificativa: 'Texto livre do pedido' })] });
    const { rows } = await q("SELECT usuario_id, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'SOLICITACAO_EPI_CRIADA' AND referencia = $2", [d.empresaA, String(criada.solicitacao.id)]);
    assert.equal(rows.length, 1);
    const [linha] = rows;
    assert.equal(linha.usuario_id, d.solicitante);
    assert.deepEqual(linha.contexto, {
      solicitacaoId: criada.solicitacao.id,
      numero: criada.solicitacao.numero,
      funcionarioId: d.trabalhador,
      gheId: d.gheA,
      origemSolicitacao: 'USUARIO_INTERNO',
      solicitanteId: d.solicitante,
      temObservacao: true,
      itens: [{ itemId: criada.itens[0].id, materialId: d.botina, tamanho: '50', quantidade: 2, motivo: 'ADMISSAO', previstoNoGhe: true }],
      idempotencia: { chave, requisicaoHash: (await q('SELECT requisicao_hash FROM solicitacoes_epi WHERE id = $1', [criada.solicitacao.id])).rows[0].requisicao_hash },
    });
    assert.equal(linha.dados_anteriores, null);
    assert.deepEqual(linha.dados_novos, { status: 'PENDENTE', quantidadeItens: 1 });
    assert.doesNotMatch(JSON.stringify(linha), /Texto livre/);
  });

  test('atomicidade: se a auditoria falhar, nada fica — nem solicitação, nem itens, nem o número', async (t) => {
    const { rows: [{ ultimo }] } = await q('SELECT COALESCE(max(ultimo_numero), 0)::int AS ultimo FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaA]);
    const solicitacoes = await contar('solicitacoes_epi');
    const itens = await contar('solicitacoes_epi_itens');
    t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha de auditoria'); });
    await assert.rejects(criar({ itens: [item(d.botina, { tamanho: '51' })] }), /falha de auditoria/);
    t.mock.restoreAll();
    assert.equal(await contar('solicitacoes_epi'), solicitacoes);
    assert.equal(await contar('solicitacoes_epi_itens'), itens);
    const { rows: [{ depois }] } = await q('SELECT COALESCE(max(ultimo_numero), 0)::int AS depois FROM solicitacoes_epi_numeracao WHERE empresa_id = $1', [d.empresaA]);
    assert.equal(depois, ultimo, 'o número da transação revertida não é consumido');
  });

  test('isolamento: a empresa B cria só com os seus; a solicitação da A não aparece para a B', async () => {
    const deA = await criar({ itens: [item(d.botina, { tamanho: '52' })] });
    await esperarHttpError(servico().criarSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhador, itens: [item(d.botinaB)], chaveIdempotencia: chaveNova(),
    }), 404, 'FUNCIONARIO_NAO_ENCONTRADO');
    await esperarHttpError(servico().criarSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [item(d.botina)], chaveIdempotencia: chaveNova(),
    }), 404, 'MATERIAL_NAO_ENCONTRADO');
    await esperarHttpError(servico().buscarSolicitacao(pool, { empresaId: d.empresaB, solicitacaoId: deA.solicitacao.id }), 404, 'SOLICITACAO_NAO_ENCONTRADA');
  });

  test('nenhuma exigência de estoque: sem lote algum a solicitação é criada normalmente', async () => {
    assert.equal(await contar('estoque_lotes'), 0);
    const criada = await criar({ itens: [item(d.botina, { tamanho: '53' })] });
    assert.equal(criada.solicitacao.status, 'PENDENTE');
  });
});
