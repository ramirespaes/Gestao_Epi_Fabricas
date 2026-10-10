'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const {
  todasAsMigrations, criarEmpresa, criarUsuario, criarGhe, criarFuncionario, criarMaterial, criarLote,
} = require('./helpers/entrega-epi');
const solicitacaoContexto = require('../../src/services/solicitacao-epi-contexto.service');
const entregaConsulta = require('../../src/services/entrega-epi-consulta.service');
const solicitacaoServico = require('../../src/services/solicitacao-epi.service');
const entregaServico = require('../../src/services/entrega-epi.service');
const gheMaterialServico = require('../../src/services/ghe-material.service');
const gheTipoServico = require('../../src/services/ghe-tipo-material.service');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Incremento 4 (RED): `previsto_no_ghe` HÍBRIDO.
 *
 *   previsto_no_ghe = vínculo direto GHE × material (ghe_materiais)
 *                     OU  o material tem tipo_material_id e esse tipo está em ghe_tipos_material para o GHE.
 *
 * OBRIGATORIO e NAO_OBRIGATORIO contam igual; tipo ou GHE inativo com vínculo já existente continua valendo; material
 * sem tipo só fica previsto pelo vínculo direto. O cálculo existe hoje em QUATRO pontos, e o RED mede os quatro:
 *   1. contexto do Pedido de EPI (solicitacao-epi-contexto.repository, SQL PREVISTO) — com e sem o filtro previstoNoGhe;
 *   2. contexto da entrega (entrega-epi-contexto.repository, SQL PREVISTO idêntico) — idem;
 *   3. criação da solicitação (solicitacao-epi.service, conjunto de materiais do GHE);
 *   4. registro da entrega (entrega-epi.service, mesmo conjunto), observado pela exigência da justificativa de exceção.
 * Snapshots já gravados (solicitacoes_epi_itens / entregas_epi_itens) nunca são recalculados. Fiscalização fica fora.
 * O RED falha porque hoje só ghe_materiais entra no cálculo.
 */

const CNPJ_A = '11222333000181';
const CNPJ_B = '44555666000162';
const ACEITE = {
  modo: 'ACEITE_PRESENCIAL', declaracaoVersao: 'NR6-2026-09', declaracaoTexto: 'Declaro que recebi os EPIs relacionados e fui orientado sobre o uso correto (texto fictício).',
};

describe('previsto_no_ghe híbrido — GHE × material OU GHE × tipo (PostgreSQL real)', () => {
  let contexto;
  let pool;
  const d = {};
  let seq = 0;

  const q = (sql, params) => pool.query(sql, params);
  const unico = (prefixo) => `${prefixo} ${++seq}-${crypto.randomUUID().slice(0, 6)}`;

  async function semearTipo(empresaId, { ativo = true } = {}) {
    return (await q(
      'INSERT INTO tipos_material (empresa_id, grupo, grupo_protecao, nome, ativo, origem) VALUES ($1, \'EPI\', \'Proteção da cabeça\', $2, $3, \'MANUAL\') RETURNING *',
      [empresaId, unico('Tipo'), ativo],
    )).rows[0];
  }
  /** Material de estoque simples (sem tamanho, sem óculos). Com `tipo`, fica classificado nesse tipo do catálogo (V2). */
  async function novoMaterial(empresaId, { tipo = null } = {}) {
    const nome = unico('Material');
    const id = await criarMaterial(pool, empresaId, nome, { exigeTamanho: false, unidade: 'unidade' });
    if (tipo !== null) await classificar(id, tipo);
    return { id, nome };
  }
  async function classificar(materialId, tipo) {
    await q(
      `UPDATE materiais SET modelo_classificacao = 'V2', categoria = $2, grupo_protecao = $3, tipo = $4, tipo_material_id = $5 WHERE id = $1`,
      [materialId, tipo.grupo, tipo.grupo_protecao, tipo.nome, tipo.id],
    );
  }
  async function novoCenario(empresaId = d.empresaA, { comGhe = true } = {}) {
    const gheId = comGhe ? await criarGhe(pool, empresaId, unico('GHE')) : null;
    const funcionarioId = await criarFuncionario(pool, empresaId, {
      matricula: unico('M'), cpf: String(90000000000 + seq).slice(0, 11), gheId,
    });
    return { empresaId, atorId: empresaId === d.empresaA ? d.atorA : d.atorB, gheId, funcionarioId };
  }

  // Vínculos pelos serviços reais (Incrementos 3 e anteriores): o estado do teste é o que a aplicação produz.
  const ligarTipo = (c, tipoId, classificacao = 'OBRIGATORIO') => gheTipoServico.definir(pool, {
    empresaId: c.empresaId, atorId: c.atorId, gheId: c.gheId, tipoId, classificacao,
  });
  const desligarTipo = (c, tipoId) => gheTipoServico.desvincular(pool, { empresaId: c.empresaId, atorId: c.atorId, gheId: c.gheId, tipoId });
  const ligarMaterial = (c, materialId) => gheMaterialServico.vincular(pool, { empresaId: c.empresaId, atorId: c.atorId, gheId: c.gheId, materialId });
  const desligarMaterial = (c, materialId) => gheMaterialServico.desvincular(pool, { empresaId: c.empresaId, atorId: c.atorId, gheId: c.gheId, materialId });

  const itemDeEntrega = (materialId, loteId, extra = {}) => ({ materialId, loteId, quantidade: 1, motivo: 'ADMISSAO', ...extra });
  const entregar = (c, itens) => entregaServico.registrarEntrega(pool, {
    empresaId: c.empresaId, atorId: c.atorId, funcionarioId: c.funcionarioId, itens, confirmacao: ACEITE,
    chaveIdempotencia: crypto.randomUUID(), ip: '203.0.113.10', dispositivo: 'Navegador de teste',
  });
  const solicitar = (c, materialId) => solicitacaoServico.criarSolicitacao(pool, {
    empresaId: c.empresaId, atorId: c.atorId, funcionarioId: c.funcionarioId,
    itens: [{ materialId, tamanho: null, quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: crypto.randomUUID(),
  });

  /** Os dois contextos (com e sem o filtro previstoNoGhe) e a criação da solicitação. */
  async function observarSemEstoque(c, material) {
    const base = { empresaId: c.empresaId, funcionarioId: c.funcionarioId, busca: material.nome, pagina: 1, limite: 100 };
    const achar = (lista) => lista.materiais.find((m) => m.id === material.id);
    const flag = async (leitor) => {
      const livre = await leitor({ ...base, previstoNoGhe: null });
      const item = achar(livre);
      assert.ok(item, 'o material ativo aparece no contexto');
      return item.previstoNoGhe;
    };
    const noFiltro = async (leitor) => {
      const sim = await leitor({ ...base, previstoNoGhe: true });
      const nao = await leitor({ ...base, previstoNoGhe: false });
      assert.equal(Boolean(achar(sim)) !== Boolean(achar(nao)), true, 'o material cai em exatamente um dos dois filtros');
      return Boolean(achar(sim));
    };
    const lerSolicitacao = (args) => solicitacaoContexto.listarMateriais(pool, args);
    const lerEntrega = (args) => entregaConsulta.listarMateriaisDoContexto(pool, args);
    return {
      contextoSolicitacao: await flag(lerSolicitacao),
      filtroSolicitacao: await noFiltro(lerSolicitacao),
      contextoEntrega: await flag(lerEntrega),
      filtroEntrega: await noFiltro(lerEntrega),
      criacaoSolicitacao: (await solicitar(c, material.id)).itens[0].previstoNoGhe,
    };
  }
  /** Registra a entrega sem justificativa de exceção: se o material está previsto passa; se não, a regra exige a justificativa. */
  async function observarEntrega(c, material) {
    const loteId = await criarLote(pool, { empresaId: c.empresaId, materialId: material.id, quantidade: 5, tamanho: null });
    try {
      const entrega = await entregar(c, [itemDeEntrega(material.id, loteId)]);
      return entrega.itens[0].previstoNoGhe;
    } catch (erro) {
      if (HttpError.ehHttpError(erro) && erro.codigo === 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA') return false;
      throw erro;
    }
  }
  const quatroPontos = (esperado) => ({
    contextoSolicitacao: esperado, filtroSolicitacao: esperado, contextoEntrega: esperado, filtroEntrega: esperado, criacaoSolicitacao: esperado, entrega: esperado,
  });
  const semEntrega = (esperado) => { const { entrega, ...resto } = quatroPontos(esperado); return resto; };
  async function observar(c, material) {
    return { ...(await observarSemEstoque(c, material)), entrega: await observarEntrega(c, material) };
  }
  async function esperar(c, material, esperado, rotulo) {
    assert.deepEqual(await observar(c, material), quatroPontos(esperado), rotulo);
  }

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d.empresaA = await criarEmpresa(pool, CNPJ_A, 'Empresa A Ltda');
    d.empresaB = await criarEmpresa(pool, CNPJ_B, 'Empresa B Ltda');
    d.atorA = await criarUsuario(pool, d.empresaA, 'ator.a@example.invalid');
    d.atorB = await criarUsuario(pool, d.empresaB, 'ator.b@example.invalid');
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('as combinações de vínculo (os quatro pontos medidos juntos)', () => {
    test('1. só GHE × material → previsto (comportamento atual preservado)', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarMaterial(c, material.id);
      await esperar(c, material, true, 'só vínculo direto');
    });

    test('2. só GHE × tipo do material → previsto', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarTipo(c, tipo.id);
      await esperar(c, material, true, 'só vínculo por tipo');
    });

    test('3. os dois vínculos → previsto (decisão booleana, sem duplicar o item)', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarMaterial(c, material.id);
      await ligarTipo(c, tipo.id);
      await esperar(c, material, true, 'os dois vínculos');
      const base = { empresaId: c.empresaId, funcionarioId: c.funcionarioId, busca: material.nome, previstoNoGhe: true, pagina: 1, limite: 100 };
      assert.equal((await solicitacaoContexto.listarMateriais(pool, base)).materiais.filter((m) => m.id === material.id).length, 1);
      assert.equal((await solicitacaoContexto.listarMateriais(pool, base)).total, 1, 'a contagem não soma os vínculos');
      assert.equal((await entregaConsulta.listarMateriaisDoContexto(pool, base)).total, 1);
    });

    test('4. nenhum vínculo → não previsto (material classificado, mas o tipo não está no GHE)', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await esperar(c, material, false, 'sem vínculo algum');
    });

    test('5 e 6. a classificação é informativa: OBRIGATORIO e NAO_OBRIGATORIO contam como previsto', async () => {
      for (const classificacao of ['OBRIGATORIO', 'NAO_OBRIGATORIO']) {
        const c = await novoCenario();
        const tipo = await semearTipo(c.empresaId);
        const material = await novoMaterial(c.empresaId, { tipo });
        await ligarTipo(c, tipo.id, classificacao);
        await esperar(c, material, true, classificacao);
      }
    });

    test('7. tipo inativado depois de vinculado continua valendo; sem vínculo, o tipo inativo não prevê nada', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarTipo(c, tipo.id);
      await q('UPDATE tipos_material SET ativo = false WHERE id = $1', [tipo.id]);
      await esperar(c, material, true, 'tipo inativo com vínculo existente');

      const c2 = await novoCenario();
      const tipo2 = await semearTipo(c2.empresaId, { ativo: false });
      const material2 = await novoMaterial(c2.empresaId, { tipo: tipo2 });
      await esperar(c2, material2, false, 'tipo inativo sem vínculo');
    });

    test('GHE inativado depois do vínculo: o resultado é o mesmo de GHE ativo, por vínculo direto e por tipo; nada é apagado', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const porTipo = await novoMaterial(c.empresaId, { tipo });
      const porMaterial = await novoMaterial(c.empresaId);
      await ligarTipo(c, tipo.id);
      await ligarMaterial(c, porMaterial.id);
      await q('UPDATE grupos_homogeneos_exposicao SET ativo = false WHERE id = $1', [c.gheId]);
      await esperar(c, porMaterial, true, 'GHE inativo, vínculo direto');
      await esperar(c, porTipo, true, 'GHE inativo, vínculo por tipo');
      assert.equal((await q('SELECT count(*)::int AS n FROM ghe_tipos_material WHERE grupo_homogeneo_id = $1', [c.gheId])).rows[0].n, 1);
      assert.equal((await q('SELECT count(*)::int AS n FROM ghe_materiais WHERE grupo_homogeneo_id = $1', [c.gheId])).rows[0].n, 1);
    });
  });

  describe('material sem tipo do catálogo', () => {
    test('8. sem tipo e sem vínculo direto → não previsto, mesmo que haja vínculos de tipo no GHE (nada é inferido pelo nome)', async () => {
      const c = await novoCenario();
      const tipoLigado = await semearTipo(c.empresaId);
      await ligarTipo(c, tipoLigado.id);
      const material = await novoMaterial(c.empresaId);
      await q('UPDATE materiais SET nome = $2 WHERE id = $1', [material.id, `${material.nome} ${tipoLigado.nome}`]);
      material.nome = `${material.nome} ${tipoLigado.nome}`;
      await esperar(c, material, false, 'material legado sem tipo');
    });

    test('9. sem tipo mas com vínculo direto → previsto', async () => {
      const c = await novoCenario();
      const material = await novoMaterial(c.empresaId);
      await ligarMaterial(c, material.id);
      await esperar(c, material, true, 'legado com vínculo direto');
    });
  });

  describe('remoções e troca de tipo (o cálculo acompanha os vínculos de agora)', () => {
    test('11. remover o vínculo direto mantendo o de tipo → continua previsto', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarMaterial(c, material.id);
      await ligarTipo(c, tipo.id);
      await desligarMaterial(c, material.id);
      await esperar(c, material, true, 'sobrou o vínculo de tipo');
    });

    test('12. remover o vínculo de tipo mantendo o direto → continua previsto', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarMaterial(c, material.id);
      await ligarTipo(c, tipo.id);
      await desligarTipo(c, tipo.id);
      await esperar(c, material, true, 'sobrou o vínculo direto');
    });

    test('13. remover os dois → não previsto', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarMaterial(c, material.id);
      await ligarTipo(c, tipo.id);
      assert.equal((await observarSemEstoque(c, material)).contextoSolicitacao, true);
      await desligarMaterial(c, material.id);
      await desligarTipo(c, tipo.id);
      await esperar(c, material, false, 'sem nenhum vínculo');
    });

    test('o material que muda para outro tipo, não vinculado, só fica previsto se tiver vínculo direto', async () => {
      const c = await novoCenario();
      const tipoLigado = await semearTipo(c.empresaId);
      const outroTipo = await semearTipo(c.empresaId);
      const semDireto = await novoMaterial(c.empresaId, { tipo: tipoLigado });
      const comDireto = await novoMaterial(c.empresaId, { tipo: tipoLigado });
      await ligarTipo(c, tipoLigado.id);
      await ligarMaterial(c, comDireto.id);
      const antes = await observarSemEstoque(c, semDireto);
      assert.deepEqual(antes, semEntrega(true), 'ligado pelo tipo antes da troca');

      await classificar(semDireto.id, outroTipo);
      await classificar(comDireto.id, outroTipo);
      await esperar(c, semDireto, false, 'trocou para tipo não vinculado, sem vínculo direto');
      await esperar(c, comDireto, true, 'trocou para tipo não vinculado, mas tem vínculo direto');
    });
  });

  describe('isolamento por empresa', () => {
    test('10. o vínculo de tipo de outra empresa não influencia; o da própria empresa funciona na mesma situação', async () => {
      const a = await novoCenario(d.empresaA);
      const b = await novoCenario(d.empresaB);
      const tipoA = await semearTipo(d.empresaA);
      const tipoB = await semearTipo(d.empresaB);
      const materialA = await novoMaterial(d.empresaA, { tipo: tipoA });
      const materialB = await novoMaterial(d.empresaB, { tipo: tipoB });
      await ligarTipo(b, tipoB.id);
      await esperar(a, materialA, false, 'empresa A não herda o vínculo da B');
      await esperar(b, materialB, true, 'a empresa B usa o próprio vínculo');
      assert.deepEqual(
        (await q('SELECT empresa_id FROM ghe_tipos_material WHERE grupo_homogeneo_id = ANY($1)', [[a.gheId, b.gheId]])).rows.map((r) => r.empresa_id),
        [d.empresaB],
      );
    });

    test('trabalhador sem GHE: nenhum material previsto, nem por tipo', async () => {
      const c = await novoCenario(d.empresaA, { comGhe: false });
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      const outro = await novoCenario();
      await ligarTipo(outro, tipo.id);
      assert.deepEqual(await observarSemEstoque(c, material), semEntrega(false));
    });
  });

  describe('14. snapshots históricos não são recalculados', () => {
    // A foto nunca pode ser vazia: comparar "nada" com "nada" provaria nada.
    const exigirLinha = (resultado) => {
      assert.equal(resultado.rows.length, 1, 'a foto precisa achar a linha');
      assert.ok(resultado.rows[0].cabecalho && resultado.rows[0].itens && resultado.rows[0].itens.length > 0, 'cabeçalho e itens presentes');
      return resultado.rows[0];
    };
    const fotoSolicitacao = async (solicitacaoId) => exigirLinha(await q(
      `SELECT to_jsonb(s) AS cabecalho, (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM solicitacoes_epi_itens i WHERE i.solicitacao_id = s.id) AS itens
         FROM solicitacoes_epi s WHERE s.id = $1`, [solicitacaoId],
    ));
    const fotoEntrega = async (entregaId) => exigirLinha(await q(
      `SELECT to_jsonb(e) AS cabecalho, (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM entregas_epi_itens i WHERE i.entrega_id = e.id) AS itens
         FROM entregas_epi e WHERE e.id = $1`, [entregaId],
    ));

    test('solicitação gravada como NÃO prevista continua assim depois de o tipo ser vinculado ao GHE', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      const criada = await solicitar(c, material.id);
      assert.equal(criada.itens[0].previstoNoGhe, false);
      const antes = await fotoSolicitacao(criada.solicitacao.id);
      await ligarTipo(c, tipo.id);
      assert.deepEqual(await fotoSolicitacao(criada.solicitacao.id), antes, 'nada foi reescrito');
      assert.equal((await solicitar(c, material.id)).itens[0].previstoNoGhe, true, 'a solicitação NOVA já vê o vínculo');
    });

    test('solicitação gravada como prevista POR TIPO continua assim depois de o vínculo ser removido', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarTipo(c, tipo.id);
      const criada = await solicitar(c, material.id);
      assert.equal(criada.itens[0].previstoNoGhe, true);
      const antes = await fotoSolicitacao(criada.solicitacao.id);
      await desligarTipo(c, tipo.id);
      assert.deepEqual(await fotoSolicitacao(criada.solicitacao.id), antes, 'nada foi reescrito');
      assert.equal((await q('SELECT previsto_no_ghe FROM solicitacoes_epi_itens WHERE solicitacao_id = $1', [criada.solicitacao.id])).rows[0].previsto_no_ghe, true);
    });

    test('entrega gravada como EXCEÇÃO (fora do GHE, com justificativa) continua assim depois de o tipo ser vinculado', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      const loteId = await criarLote(pool, { empresaId: c.empresaId, materialId: material.id, quantidade: 5, tamanho: null });
      const entrega = await entregar(c, [itemDeEntrega(material.id, loteId, { justificativaForaGhe: 'Visita à área externa' })]);
      assert.deepEqual([entrega.itens[0].previstoNoGhe, entrega.itens[0].justificativaForaGhe], [false, 'Visita à área externa']);
      const antes = await fotoEntrega(entrega.entrega.id);
      await ligarTipo(c, tipo.id);
      assert.deepEqual(await fotoEntrega(entrega.entrega.id), antes, 'itens, justificativa e hash ficam como foram gravados');
    });

    test('entrega gravada como prevista POR TIPO continua assim depois de o vínculo ser removido', async () => {
      const c = await novoCenario();
      const tipo = await semearTipo(c.empresaId);
      const material = await novoMaterial(c.empresaId, { tipo });
      await ligarTipo(c, tipo.id);
      const loteId = await criarLote(pool, { empresaId: c.empresaId, materialId: material.id, quantidade: 5, tamanho: null });
      const entrega = await entregar(c, [itemDeEntrega(material.id, loteId)]);
      assert.deepEqual([entrega.itens[0].previstoNoGhe, entrega.itens[0].justificativaForaGhe], [true, null]);
      const antes = await fotoEntrega(entrega.entrega.id);
      await desligarTipo(c, tipo.id);
      assert.deepEqual(await fotoEntrega(entrega.entrega.id), antes);
    });

    test('previsto por vínculo direto gravado antes continua assim depois de o vínculo direto sair (regra atual preservada)', async () => {
      const c = await novoCenario();
      const material = await novoMaterial(c.empresaId);
      await ligarMaterial(c, material.id);
      const criada = await solicitar(c, material.id);
      assert.equal(criada.itens[0].previstoNoGhe, true);
      const antes = await fotoSolicitacao(criada.solicitacao.id);
      await desligarMaterial(c, material.id);
      assert.deepEqual(await fotoSolicitacao(criada.solicitacao.id), antes);
    });
  });
});
