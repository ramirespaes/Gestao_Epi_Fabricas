'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { gerador } = require('./helpers/gerador');
const {
  todasAsMigrations, criarEmpresa, criarUsuario, criarFuncionario, criarMaterial, criarLote,
} = require('./helpers/entrega-epi');
const {
  criarSolicitacao, decidirSolicitacao, cancelarSolicitacao, aprovar, reprovar, baixarLote, entregarPorSolicitacao,
} = require('./helpers/solicitacao-epi');
const coberturaRepo = require('../../src/repositories/solicitacao-epi-cobertura.repository');
const loteRepo = require('../../src/repositories/estoque-lote.repository');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * Prova de equivalência da definição única de "utilizável" (12D-1), em banco
 * real. Mundos aleatórios, com semente fixa, são montados com os fixtures; um
 * ORÁCULO INDEPENDENTE, escrito em JS sobre as linhas cruas das tabelas (sem
 * nenhum SQL de posição), calcula U, D, C, L, G, o mínimo efetivo, o déficit e a
 * necessidade de cada par. Todas as leituras que dependem da definição têm de
 * concordar com ele, par a par:
 *   - a consulta de todos os pares (paginada) e o seu resumo;
 *   - lerPosicoes (a leitura das escritas: baixa, DIRETA e entrega por solicitação);
 *   - a cobertura FIFO por item (físico utilizável e soma coberta e sem cobertura);
 *   - a leitura por lote da Validade (saldo bloqueado e físico);
 *   - a leitura de Itens Disponíveis e o indicador de disponível do Dashboard (legados).
 * Cobre: material ativo e inativo, com e sem exigência de CA, CA válido, vencido,
 * vencendo hoje e ausente, lote zerado, tamanho e sem tamanho, demanda, entrega
 * parcial e todos os status de solicitação.
 */

const posicaoRepo = () => exigirModulo('src/repositories/posicao-estoque.repository');
const HOJE = dataOperacional();
const DIAS_ALERTA = 60;
const SEMENTES = Number.parseInt(process.env.SEMENTES_EQUIVALENCIA ?? '12', 10);
const TAMANHOS = ['P', 'M', 'G', 'GG'];

const chave = (materialId, tamanho) => `${materialId}|${tamanho ?? ''}`;

describe('definição única de utilizável — equivalência contra o oráculo independente (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let sequencia = 0;
  const estatistica = { pares: 0, entregas: 0, comDemanda: 0, comProprio: 0, bloqueados: 0, inativos: 0 };

  const q = (sql, params) => pool.query(sql, params);

  before(async () => {
    exigirModulo('src/repositories/posicao-estoque.repository');
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  // ─── o mundo ───────────────────────────────────────────────────────
  async function montarMundo(semente) {
    const r = gerador(semente);
    const sorteio = (n) => Math.floor(r() * n);
    const escolha = (lista) => lista[sorteio(lista.length)];

    sequencia += 1;
    const empresaId = await criarEmpresa(pool, String(40000000000000 + sequencia), `Empresa do mundo ${semente}`);
    const solicitante = await criarUsuario(pool, empresaId, `s-${empresaId}@example.invalid`);
    const aprovador = await criarUsuario(pool, empresaId, `a-${empresaId}@example.invalid`);
    const trabalhadores = [];
    for (let i = 0; i < 4; i += 1) {
      trabalhadores.push(await criarFuncionario(pool, empresaId, { matricula: `T-${i}`, cpf: String(50000000000 + empresaId * 10 + i), ativo: i !== 3 || r() < 0.5 }));
    }

    const materiais = [];
    const quantidadeDeMateriais = 5 + sorteio(4);
    for (let i = 0; i < quantidadeDeMateriais; i += 1) {
      const classificacao = r() < 0.6 ? true : (r() < 0.75 ? false : null);
      const exigeCa = r() < 0.7;
      const id = await criarMaterial(pool, empresaId, `Material ${semente}-${i}`, { exigeTamanho: classificacao, exigeCa });
      await q('UPDATE materiais SET estoque_minimo = $1 WHERE id = $2', [sorteio(13), id]);
      materiais.push({ id, classificacao, exigeCa, lotes: [] });
    }

    const tamanhoDoMaterial = (m) => {
      if (m.classificacao === true) return escolha(TAMANHOS);
      if (m.classificacao === false) return null;
      return escolha([null, 'Único']);
    };

    for (const m of materiais) {
      if (m.classificacao === true) {
        for (const tamanho of TAMANHOS) {
          if (r() < 0.4) await q('INSERT INTO estoque_minimos (empresa_id, material_id, tamanho, minimo) VALUES ($1, $2, $3, $4)', [empresaId, m.id, tamanho, sorteio(16)]);
        }
      }
      const quantidadeDeLotes = sorteio(4);
      for (let i = 0; i < quantidadeDeLotes; i += 1) {
        const modo = m.exigeCa ? escolha(['valido', 'vencido', 'hoje', 'sem']) : escolha(['valido', 'vencido', 'sem']);
        const ca = {
          valido: { caNumero: '100', caValidade: '2099-12-31' },
          vencido: { caNumero: '200', caValidade: '2020-01-01' },
          hoje: { caNumero: '300', caValidade: HOJE },
          sem: { caNumero: null, caValidade: null },
        }[modo];
        const tamanho = tamanhoDoMaterial(m);
        const quantidade = 1 + sorteio(9);
        const loteId = await criarLote(pool, { empresaId, materialId: m.id, quantidade, tamanho, ...ca });
        m.lotes.push({ id: loteId, tamanho, quantidade });
        if (r() < 0.15) await baixarLote(pool, { empresaId, loteId, quantidade, usuarioId: solicitante });
      }
    }

    const cenario = { empresaA: empresaId, aprovador, solicitante };
    const quantidadeDeSolicitacoes = 5 + sorteio(6);
    for (let s = 0; s < quantidadeDeSolicitacoes; s += 1) {
      const itens = [];
      const usados = new Set();
      const quantidadeDeItens = 1 + sorteio(3);
      for (let i = 0; i < quantidadeDeItens; i += 1) {
        const m = escolha(materiais);
        const tamanho = tamanhoDoMaterial(m);
        if (usados.has(chave(m.id, tamanho))) continue;
        usados.add(chave(m.id, tamanho));
        itens.push({ material_id: m.id, tamanho, quantidade: 1 + sorteio(6), motivo: 'ADMISSAO' });
      }
      const criada = await criarSolicitacao(pool, cenario, { empresaId, funcionarioId: escolha(trabalhadores), solicitanteId: solicitante, itens });
      const sorteioDeStatus = r();
      if (sorteioDeStatus < 0.15) continue; // PENDENTE
      if (sorteioDeStatus < 0.25) {
        await decidirSolicitacao(pool, criada.solicitacao, { status: 'REPROVADA', decididaPor: aprovador, decisoes: criada.itens.map((i) => reprovar(i)) });
        continue;
      }
      if (sorteioDeStatus < 0.35) {
        await cancelarSolicitacao(pool, criada.solicitacao, { canceladaPor: solicitante });
        continue;
      }
      const reduzivel = criada.itens.find((i) => i.quantidade > 1);
      const parcial = sorteioDeStatus < 0.55 && (criada.itens.length > 1 || reduzivel);
      let decisoes = criada.itens.map((i) => aprovar(i));
      let status = 'APROVADA';
      if (parcial) {
        status = 'APROVADA_PARCIAL';
        decisoes = criada.itens.length > 1
          ? [aprovar(criada.itens[0]), ...criada.itens.slice(1).map((i) => reprovar(i))]
          : [aprovar(reduzivel, reduzivel.quantidade - 1, 'Quantidade reduzida pela SST')];
      }
      const decidida = await decidirSolicitacao(pool, criada.solicitacao, { status, decididaPor: aprovador, decisoes });

      if (r() < 0.6) {
        const aprovado = decisoes.find((x) => x.decisao === 'APROVADO');
        const item = criada.itens.find((i) => i.id === aprovado.id);
        const par = materiais.find((m) => m.id === item.material_id);
        const compativel = par.lotes.find((l) => (l.tamanho ?? null) === (item.tamanho ?? null) && l.quantidade >= 1);
        if (compativel) {
          const { rows: [saldo] } = await q('SELECT saldo FROM estoque_lotes WHERE id = $1', [compativel.id]);
          const quantidade = Math.min(aprovado.quantidade_aprovada, saldo.saldo, 1 + sorteio(4));
          if (quantidade >= 1) {
            await entregarPorSolicitacao(pool, { solicitacao: decidida, itens: [{ item, loteId: compativel.id, quantidade }], usuarioId: solicitante });
            estatistica.entregas += 1;
          }
        }
      }
    }

    for (const m of materiais) {
      if (r() < 0.15) {
        await q('UPDATE materiais SET ativo = false WHERE id = $1', [m.id]);
        estatistica.inativos += 1;
      }
    }
    return { empresaId };
  }

  // ─── o oráculo: JS sobre as linhas cruas ────────────────────────────
  async function oraculo(empresaId) {
    const materiais = (await q('SELECT id, nome, ativo, exige_ca, exige_tamanho, estoque_minimo FROM materiais WHERE empresa_id = $1', [empresaId])).rows;
    const lotes = (await q("SELECT id, material_id, tamanho, saldo, to_char(ca_validade, 'YYYY-MM-DD') AS ca_validade FROM estoque_lotes WHERE empresa_id = $1", [empresaId])).rows;
    const funcionarios = new Map((await q('SELECT id, ativo FROM funcionarios WHERE empresa_id = $1', [empresaId])).rows.map((f) => [f.id, f]));
    const solicitacoes = new Map((await q('SELECT id, status, funcionario_id FROM solicitacoes_epi WHERE empresa_id = $1', [empresaId])).rows.map((s) => [s.id, s]));
    const itens = (await q('SELECT id, solicitacao_id, material_id, tamanho, decisao, quantidade_aprovada FROM solicitacoes_epi_itens WHERE empresa_id = $1', [empresaId])).rows;
    const entregue = new Map((await q(
      'SELECT solicitacao_item_id, sum(quantidade)::int AS entregue FROM entregas_epi_itens WHERE empresa_id = $1 AND solicitacao_item_id IS NOT NULL GROUP BY solicitacao_item_id', [empresaId],
    )).rows.map((e) => [e.solicitacao_item_id, e.entregue]));
    const proprios = new Map((await q('SELECT material_id, tamanho, minimo FROM estoque_minimos WHERE empresa_id = $1', [empresaId])).rows.map((m) => [chave(m.material_id, m.tamanho), m.minimo]));

    const porId = new Map(materiais.map((m) => [m.id, m]));
    const pares = new Map();
    const par = (materialId, tamanho) => {
      const k = chave(materialId, tamanho);
      if (!pares.has(k)) pares.set(k, { materialId, tamanho: tamanho ?? null, saldo: 0, bloqueado: 0, fisicoUtilizavel: 0, demandaPendente: 0, lotes: 0 });
      return pares.get(k);
    };

    for (const l of lotes) {
      const m = porId.get(l.material_id);
      if (!m.ativo) continue;
      const p = par(l.material_id, l.tamanho);
      const bloqueado = m.exige_ca && (l.ca_validade === null || l.ca_validade < HOJE);
      p.lotes += 1;
      p.saldo += l.saldo;
      if (bloqueado) p.bloqueado += l.saldo; else p.fisicoUtilizavel += l.saldo;
    }
    for (const i of itens) {
      const s = solicitacoes.get(i.solicitacao_id);
      const m = porId.get(i.material_id);
      if (i.decisao !== 'APROVADO' || !['APROVADA', 'APROVADA_PARCIAL'].includes(s.status)) continue;
      if (!funcionarios.get(s.funcionario_id).ativo || !m.ativo) continue;
      const pendente = i.quantidade_aprovada - (entregue.get(i.id) ?? 0);
      if (pendente <= 0) continue;
      par(i.material_id, i.tamanho).demandaPendente += pendente;
    }
    for (const k of proprios.keys()) {
      const [materialId, tamanho] = [Number(k.split('|')[0]), k.split('|')[1]];
      if (porId.get(materialId).ativo) par(materialId, tamanho);
    }
    for (const m of materiais) {
      if (m.ativo && m.exige_tamanho === false && m.estoque_minimo > 0) par(m.id, null);
    }

    for (const p of pares.values()) {
      const m = porId.get(p.materialId);
      const proprio = proprios.get(chave(p.materialId, p.tamanho));
      p.comprometido = Math.min(p.fisicoUtilizavel, p.demandaPendente);
      p.saldoLivre = Math.max(0, p.fisicoUtilizavel - p.demandaPendente);
      p.semCobertura = Math.max(0, p.demandaPendente - p.fisicoUtilizavel);
      p.estoqueMinimo = proprio ?? m.estoque_minimo;
      p.minimoOrigem = proprio === undefined ? 'PADRAO' : 'PROPRIO';
      p.deficit = Math.max(0, p.estoqueMinimo - p.saldoLivre);
      p.necessidade = p.semCobertura + p.deficit;
      p.abaixoDoMinimo = p.estoqueMinimo > 0 && p.saldoLivre < p.estoqueMinimo;
    }
    return { pares, materiais: porId };
  }

  const visao = (p) => ({
    fisicoUtilizavel: p.fisicoUtilizavel,
    demandaPendente: p.demandaPendente,
    comprometido: p.comprometido,
    saldoLivre: p.saldoLivre,
    semCobertura: p.semCobertura,
    estoqueMinimo: p.estoqueMinimo,
    minimoOrigem: p.minimoOrigem,
    abaixoDoMinimo: p.abaixoDoMinimo,
    deficit: p.deficit,
    necessidade: p.necessidade,
    saldo: p.saldo,
    bloqueado: p.bloqueado,
  });

  async function todasAsPaginas(empresaId, limite) {
    const itens = [];
    let total = null;
    for (let pagina = 1; pagina < 1000; pagina += 1) {
      const r = await posicaoRepo().listarPosicoes(pool, empresaId, { hoje: HOJE, diasAlerta: DIAS_ALERTA, pagina, limite });
      total = r.total;
      if (r.itens.length === 0) break;
      itens.push(...r.itens);
      assert.equal(r.total, total, 'o total não muda entre páginas');
    }
    return { itens, total };
  }

  for (let semente = 1; semente <= SEMENTES; semente += 1) {
    test(`mundo ${semente}: todas as leituras concordam com o oráculo, par a par`, async () => {
      const { empresaId } = await montarMundo(semente);
      const { pares, materiais } = await oraculo(empresaId);
      estatistica.pares += pares.size;
      for (const p of pares.values()) {
        if (p.demandaPendente > 0) estatistica.comDemanda += 1;
        if (p.minimoOrigem === 'PROPRIO') estatistica.comProprio += 1;
        if (p.bloqueado > 0) estatistica.bloqueados += 1;
      }

      // 1) a consulta de todos os pares, em páginas de 7 (a última pode ser parcial), e o total
      const { itens, total } = await todasAsPaginas(empresaId, 7);
      assert.equal(total, pares.size, 'total de pares');
      assert.equal(itens.length, pares.size, 'nenhum par perdido nem repetido entre as páginas');
      const lidos = new Map(itens.map((i) => [chave(i.materialId, i.tamanho), i]));
      assert.equal(lidos.size, itens.length);
      for (const [k, esperado] of pares) {
        const lido = lidos.get(k);
        assert.ok(lido, `par ${k} ausente na consulta de todos os pares`);
        assert.deepEqual(visao(lido), visao(esperado), `par ${k}`);
      }

      // 2) lerPosicoes: a leitura das escritas, só dos pares pedidos
      const pedidos = [...pares.values()].map((p) => ({ materialId: p.materialId, tamanho: p.tamanho }));
      const posicoes = await coberturaRepo.lerPosicoes(pool, empresaId, pedidos, { hoje: HOJE });
      for (const x of posicoes) {
        const esperado = pares.get(chave(x.materialId, x.tamanho));
        assert.deepEqual(
          [x.fisicoUtilizavel, x.demandaPendente, x.comprometido, x.saldoLivre, x.semCobertura],
          [esperado.fisicoUtilizavel, esperado.demandaPendente, esperado.comprometido, esperado.saldoLivre, esperado.semCobertura],
          `lerPosicoes ${chave(x.materialId, x.tamanho)}`,
        );
      }

      // 3) a cobertura FIFO por item: o físico utilizável do par, e a soma coberta e sem cobertura
      const cobertura = await coberturaRepo.listarCobertura(pool, empresaId, { hoje: HOJE });
      const somas = new Map();
      for (const c of cobertura) {
        const k = chave(c.materialId, c.tamanho);
        const esperado = pares.get(k);
        assert.equal(c.fisicoUtilizavel, esperado.fisicoUtilizavel, `cobertura: U de ${k}`);
        const s = somas.get(k) ?? { coberta: 0, semCobertura: 0 };
        s.coberta += c.coberta;
        s.semCobertura += c.semCobertura;
        somas.set(k, s);
      }
      for (const [k, s] of somas) {
        const esperado = pares.get(k);
        assert.deepEqual([s.coberta, s.semCobertura], [esperado.comprometido, esperado.semCobertura], `cobertura: soma de ${k}`);
      }
      for (const [k, p] of pares) if (p.demandaPendente > 0) assert.ok(somas.has(k), `par ${k} com demanda fora da fila`);

      // 4) a leitura por lote (Validade): saldo bloqueado e físico utilizável por par de material ativo
      const lotes = await loteRepo.listarValidade(pool, empresaId, { hoje: HOJE, diasAlerta: DIAS_ALERTA, pagina: 1, limite: 100000 });
      const porLote = new Map();
      for (const l of lotes.filter((x) => x.materialAtivo)) {
        const k = chave(l.materialId, l.tamanho);
        const s = porLote.get(k) ?? { fisico: 0, bloqueado: 0 };
        s.fisico += l.fisico;
        s.bloqueado += l.bloqueado;
        porLote.set(k, s);
      }
      for (const [k, s] of porLote) {
        const esperado = pares.get(k);
        assert.deepEqual([s.fisico, s.bloqueado, s.fisico - s.bloqueado], [esperado.saldo, esperado.bloqueado, esperado.fisicoUtilizavel], `validade: ${k}`);
      }

      // 5) a leitura por lote da Gestão de estoque (listarPorMaterial, a que a tela de materiais usa), somada por par de
      //    material ativo: a referência por lote que ficou no lugar da antiga listagem de Itens Disponíveis por lote
      //    (removida na 12D-3, quando a lista da rota passou a sair só da posição)
      const porLoteDaGestao = new Map();
      for (const m of [...materiais.values()].filter((x) => x.ativo)) {
        for (const l of await loteRepo.listarPorMaterial(pool, empresaId, m.id, { hoje: HOJE, diasAlerta: DIAS_ALERTA })) {
          const k = chave(l.materialId, l.tamanho);
          const s = porLoteDaGestao.get(k) ?? { fisico: 0, bloqueado: 0 };
          s.fisico += l.fisico;
          s.bloqueado += l.bloqueado;
          porLoteDaGestao.set(k, s);
        }
      }
      for (const [k, s] of porLoteDaGestao) {
        const esperado = pares.get(k);
        assert.ok(esperado, `a Gestão de estoque lista um par que o oráculo não tem: ${k}`);
        assert.deepEqual([s.fisico, s.bloqueado, s.fisico - s.bloqueado], [esperado.saldo, esperado.bloqueado, esperado.fisicoUtilizavel], `gestão de estoque: ${k}`);
      }
      for (const [k, p] of pares) if (p.saldo > 0) assert.ok(porLoteDaGestao.has(k), `par ${k} com saldo fora da leitura por lote da Gestão de estoque`);

      // 6) o resumo que o Dashboard soma (o disponível dele é o físico utilizável agregado)
      const resumo = await posicaoRepo().resumirPosicoes(pool, empresaId, { hoje: HOJE });
      const soma = (campo) => [...pares.values()].reduce((s, p) => s + p[campo], 0);
      assert.deepEqual(resumo, {
        pares: pares.size,
        fisicoUtilizavel: soma('fisicoUtilizavel'),
        demandaPendente: soma('demandaPendente'),
        comprometido: soma('comprometido'),
        saldoLivre: soma('saldoLivre'),
        semCobertura: soma('semCobertura'),
        paresAbaixoDoMinimo: [...pares.values()].filter((p) => p.abaixoDoMinimo).length,
        deficit: soma('deficit'),
        necessidade: soma('necessidade'),
      });
      assert.ok(materiais.size > 0);
    });
  }

  test('os mundos aleatórios exercitam de verdade os casos obrigatórios (não passam vazios)', () => {
    assert.ok(estatistica.pares > SEMENTES, `pares: ${JSON.stringify(estatistica)}`);
    assert.ok(estatistica.entregas > 0, `entregas parciais: ${JSON.stringify(estatistica)}`);
    assert.ok(estatistica.comDemanda > 0, 'pares com demanda');
    assert.ok(estatistica.comProprio > 0, 'pares com mínimo próprio');
    assert.ok(estatistica.bloqueados > 0, 'pares com saldo bloqueado por CA');
    assert.ok(estatistica.inativos > 0, 'materiais inativos');
  });
});
