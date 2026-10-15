'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { ATENDIMENTO_INVALIDO, COOKIE_ATENDIMENTO, cookieDoAtendimentoNaResposta } = require('./helpers/token-atendimento');
const { CATALOGO, CHAVES_DO_MATERIAL, abrirAmbienteCatalogo } = require('./helpers/token-catalogo');
const { sha256, lerSetCookie, cookieDoTabletNaResposta, IP_TESTE } = require('./helpers/token-tablet');
const { cpfFicticio } = require('../helpers/cpf-ficticio');
const { hashTokenSessao } = require('../../src/security/token');
const tokenTabletService = require('../../src/services/token-tablet.service');
const contextoRepo = require('../../src/repositories/solicitacao-epi-contexto.repository');

/**
 * Atendimento Token — Etapa E (RED): CATÁLOGO de materiais físicos autorizados para o funcionário do atendimento vigente.
 * PostgreSQL real, schema temporário com TODAS as migrations. Sem migration nova: usa as estruturas existentes (ver helpers/token-catalogo.js).
 *
 * Regra de seleção proposta (GREEN E): a MESMA definição única de "previsto no GHE" que já existe (src/repositories/sql/previsto-ghe.js:
 * vínculo direto ghe_materiais OU material.tipo_material_id ligado ao GHE por ghe_tipos_material, OBRIGATORIO e NAO_OBRIGATORIO iguais, nada
 * inferido por nome), aplicada ao GHE ATUAL do funcionário do atendimento, mais: material da empresa do tablet e ATIVO; classificado quanto
 * a tamanho (exige_tamanho não nulo); e, se exige tamanho, com ao menos um tamanho cadastrado (grade, ou lotes no legado sem grade).
 * Saldo NUNCA entra (nem como filtro nem como campo). Imagem: estado explícito (nenhuma estrutura de imagem existe ainda).
 *
 * TODOS os testes E1–E23 falham hoje PRIMEIRO pela ausência da rota (404 ROTA_NAO_ENCONTRADA na primeira asserção). As asserções internas de
 * cada teste só serão efetivamente verificadas no GREEN E; os controles K1–K4 e os testes do contrato de erro que independem da rota passam já.
 */

const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const NAO_AUTORIZADO = [401, 'DISPOSITIVO_NAO_AUTORIZADO'];
const LIMITE_DE_SEGURANCA_MS = 10000;
const SEM_IMAGEM = Object.freeze({ disponivel: false });

describe('Atendimento Token — E: catálogo de materiais do atendimento (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;

  before(async () => {
    a = await abrirAmbienteCatalogo();
    app = a.criarApp({ hops: 0 });
    gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const forcarRestante = (id, segundos) => a.q(`UPDATE token_atendimentos SET iniciado_em = LEAST(iniciado_em, now() - interval '200 seconds'), expira_em = now() + make_interval(secs => $2::int) WHERE id = $1`, [id, segundos]);
  const gerarCodigo = async (tabletId) => (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${tabletId}/ativacao`)).body.ativacao.codigo;
  const ver = (c) => a.catalogo(app, c.t, c.token);
  /** Catálogo 200 já validado na forma; devolve o corpo `catalogo`. */
  async function obter(c) {
    const r = await ver(c);
    assert.equal(r.status, 200, `a rota do catálogo deveria responder 200: ${aviso(r)}`);
    assert.deepEqual(Object.keys(r.body).sort(), ['catalogo', 'status']);
    assert.deepEqual(Object.keys(r.body.catalogo).sort(), ['estado', 'materiais', 'total']);
    assert.equal(r.body.catalogo.total, r.body.catalogo.materiais.length);
    for (const m of r.body.catalogo.materiais) assert.deepEqual(Object.keys(m).sort(), CHAVES_DO_MATERIAL, 'projeção mínima e exata do material');
    return r.body.catalogo;
  }
  const nomes = (cat) => cat.materiais.map((m) => m.nome);

  // ───────────── controles do ambiente e das funcionalidades existentes (passam já no RED) ─────────────
  describe('controles (devem passar já no RED)', () => {
    test('K1 — os construtores de dados usam as estruturas reais: GHE do funcionário, vínculo direto e por tipo, material V2 e legado; a regra EXISTENTE de "previsto no GHE" enxerga o que foi montado', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const direto = await a.material(a.d.empresaA, { nome: 'K1 direto' });
      const t = await a.tipo(a.d.empresaA);
      const porTipo = await a.material(a.d.empresaA, { nome: 'K1 por tipo', tipoLinha: t });
      const fora = await a.material(a.d.empresaA, { nome: 'K1 fora' });
      await a.vincularMaterial(a.d.empresaA, ghe, direto);
      await a.vincularTipo(a.d.empresaA, ghe, t.id, 'NAO_OBRIGATORIO');
      const previstos = await contextoRepo.listarMateriais(a.ctx.pool, a.d.empresaA, { gheId: ghe, previstoNoGhe: true, pagina: 1, limite: 100 });
      assert.deepEqual(previstos.map((m) => m.id).sort((x, y) => x - y), [direto, porTipo].sort((x, y) => x - y));
      assert.equal(previstos.some((m) => m.id === fora), false);
    });

    test('K2 — a Etapa D já fornece o contexto confiável: com o atendimento aberto no GHE do funcionário, o estado responde 200 com o primeiro nome e o registro pertence ao tablet e à empresa corretos', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const c = await a.cenario(app, { gheId: ghe });
      const r = await a.consultar(app, c.t, c.token);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(r.body.atendimento.funcionario, { primeiroNome: 'Maria' });
      const linha = await a.atendimento(c.atendimentoId);
      assert.deepEqual([linha.empresa_id, linha.dispositivo_id, linha.funcionario_id], [a.d.empresaA, c.t.id, c.f.id]);
    });

    test('K3 — tamanhos reais já existentes: a grade (070) vem na ordem cadastrada, inclusive tamanho sem estoque, e o legado sem grade usa os tamanhos dos lotes (regra existente do contexto do pedido)', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const comGrade = await a.material(a.d.empresaA, { nome: 'K3 grade', exigeTamanho: true, grade: ['P', 'M', 'G'], lotes: [{ tamanho: 'M', quantidade: 0 }] });
      const legado = await a.material(a.d.empresaA, { nome: 'K3 legado', exigeTamanho: true, lotes: [{ tamanho: '42', quantidade: 3 }, { tamanho: '40', quantidade: 1 }] });
      await a.vincularMaterial(a.d.empresaA, ghe, comGrade); await a.vincularMaterial(a.d.empresaA, ghe, legado);
      const lista = await contextoRepo.listarMateriais(a.ctx.pool, a.d.empresaA, { gheId: ghe, previstoNoGhe: true, pagina: 1, limite: 100 });
      const por = Object.fromEntries(lista.map((m) => [m.id, m.tamanhosSugeridos]));
      assert.deepEqual(por[comGrade], ['P', 'M', 'G']);
      assert.deepEqual(por[legado], ['40', '42']);
    });

    test('K4 — LACUNA CONFIRMADA das fotografias: hoje não existe nenhuma coluna, tabela ou rota de imagem de material (nem upload, nem armazenamento de imagem); o único armazenamento é o local do ZIP da fiscalização', async () => {
      const colunas = await a.q("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND (column_name ~* '(imagem|foto|image|url_|arquivo|storage)' OR table_name ~* '(imagem|foto|image)')");
      assert.deepEqual(colunas.rows, [], 'quando a estrutura de imagens existir (decisão futura), este controle será revisto');
      const doMaterial = await a.q("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'materiais'");
      assert.equal(doMaterial.rows.some((c) => /img|imag|foto/i.test(c.column_name)), false);
    });
  });

  // ───────────────────────── seleção: funcionário ativo, GHE, vínculos ─────────────────────────
  describe('seleção pelo GHE', () => {
    test('E1 — funcionário ATIVO com GHE válido: 200, estado OK e o material permitido com a projeção mínima exata (sem estoque, sem dado pessoal)', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const m = await a.material(a.d.empresaA, { nome: 'E1 Protetor', unidade: 'par' });
      await a.vincularMaterial(a.d.empresaA, ghe, m);
      const c = await a.cenario(app, { gheId: ghe });
      const cat = await obter(c);
      assert.equal(cat.estado, 'OK');
      assert.deepEqual(cat.materiais, [{
        id: m, nome: 'E1 Protetor', unidade: 'par', categoria: null, grupoProtecao: null, tipo: null, exigeTamanho: false, tamanhos: [], imagem: SEM_IMAGEM,
      }]);
    });

    test('E2 — material físico ativo permitido DIRETAMENTE pelo GHE (ghe_materiais) aparece; o do mesmo cadastro sem vínculo não', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const permitido = await a.material(a.d.empresaA, { nome: 'E2 permitido' });
      await a.material(a.d.empresaA, { nome: 'E2 sem vínculo' });
      await a.vincularMaterial(a.d.empresaA, ghe, permitido);
      const cat = await obter(await a.cenario(app, { gheId: ghe }));
      assert.deepEqual(nomes(cat), ['E2 permitido']);
    });

    test('E3 — material permitido por TIPO (ghe_tipos_material, OBRIGATORIO ou NAO_OBRIGATORIO) aparece, com o tipo do catálogo identificado; material legado de nome parecido ao do tipo NÃO aparece (nada é inferido por nome)', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const t1 = await a.tipo(a.d.empresaA, { nome: 'E3 Tipo Obrigatório' });
      const t2 = await a.tipo(a.d.empresaA, { nome: 'E3 Tipo Facultativo' });
      const m1 = await a.material(a.d.empresaA, { nome: 'E3 Material do tipo 1', tipoLinha: t1 });
      const m2 = await a.material(a.d.empresaA, { nome: 'E3 Material do tipo 2', tipoLinha: t2 });
      await a.material(a.d.empresaA, { nome: 'E3 Homônimo legado', tipoTexto: t1.nome });
      await a.vincularTipo(a.d.empresaA, ghe, t1.id, 'OBRIGATORIO');
      await a.vincularTipo(a.d.empresaA, ghe, t2.id, 'NAO_OBRIGATORIO');
      const cat = await obter(await a.cenario(app, { gheId: ghe }));
      assert.deepEqual(cat.materiais.map((m) => m.id).sort((x, y) => x - y), [m1, m2].sort((x, y) => x - y));
      const doTipo1 = cat.materiais.find((m) => m.id === m1);
      assert.deepEqual([doTipo1.tipo, doTipo1.categoria, doTipo1.grupoProtecao], [{ id: t1.id, nome: t1.nome }, 'EPI', 'Proteção auditiva']);
    });

    test('E4 — materiais NÃO autorizados ficam de fora: sem vínculo, vinculado só a OUTRO GHE, com tipo ligado só a OUTRO GHE, e com nome idêntico ao de um autorizado', async () => {
      const ghe = await a.ghe(a.d.empresaA); const outro = await a.ghe(a.d.empresaA);
      const tOutro = await a.tipo(a.d.empresaA);
      const autorizado = await a.material(a.d.empresaA, { nome: 'E4 Luva' });
      const gemeo = await a.material(a.d.empresaA, { nome: 'E4 Luva' });
      const doOutroGhe = await a.material(a.d.empresaA, { nome: 'E4 do outro GHE' });
      const doTipoOutro = await a.material(a.d.empresaA, { nome: 'E4 tipo do outro GHE', tipoLinha: tOutro });
      await a.material(a.d.empresaA, { nome: 'E4 solto' });
      await a.vincularMaterial(a.d.empresaA, ghe, autorizado);
      await a.vincularMaterial(a.d.empresaA, outro, doOutroGhe);
      await a.vincularTipo(a.d.empresaA, outro, tOutro.id);
      const cat = await obter(await a.cenario(app, { gheId: ghe }));
      assert.deepEqual(cat.materiais.map((m) => m.id), [autorizado]);
      assert.equal(cat.materiais.some((m) => [gemeo, doOutroGhe, doTipoOutro].includes(m.id)), false);
    });

    test('E5 — material INATIVO não aparece (direto ou por tipo); TIPO inativo não concede autorização INDIRETA no catálogo (D-E3), mas o vínculo DIRETO do material ativo continua valendo mesmo que o tipo dele esteja inativo; a regra compartilhada de "previsto" não muda', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const t = await a.tipo(a.d.empresaA); const tInativo = await a.tipo(a.d.empresaA, { ativo: false });
      const inativoDireto = await a.material(a.d.empresaA, { nome: 'E5 inativo direto', ativo: false });
      const inativoPorTipo = await a.material(a.d.empresaA, { nome: 'E5 inativo por tipo', tipoLinha: t, ativo: false });
      const soPorTipoInativo = await a.material(a.d.empresaA, { nome: 'E5 só por tipo inativo', tipoLinha: tInativo });
      const diretoDeTipoInativo = await a.material(a.d.empresaA, { nome: 'E5 direto de tipo inativo', tipoLinha: tInativo });
      const ativo = await a.material(a.d.empresaA, { nome: 'E5 ativo' });
      await a.vincularMaterial(a.d.empresaA, ghe, inativoDireto); await a.vincularMaterial(a.d.empresaA, ghe, ativo);
      await a.vincularMaterial(a.d.empresaA, ghe, diretoDeTipoInativo);
      await a.vincularTipo(a.d.empresaA, ghe, t.id); await a.vincularTipo(a.d.empresaA, ghe, tInativo.id);
      const cat = await obter(await a.cenario(app, { gheId: ghe }));
      assert.deepEqual(cat.materiais.map((m) => m.id).sort((x, y) => x - y), [ativo, diretoDeTipoInativo].sort((x, y) => x - y));
      assert.equal(cat.materiais.some((m) => [inativoDireto, inativoPorTipo, soPorTipoInativo].includes(m.id)), false);
      // a regra compartilhada (pedido, entrega) NÃO mudou: o tipo inativo continua prevendo o material lá
      const previstos = await contextoRepo.listarMateriais(a.ctx.pool, a.d.empresaA, { gheId: ghe, previstoNoGhe: true, pagina: 1, limite: 100 });
      assert.equal(previstos.some((m) => m.id === soPorTipoInativo), true, 'previsto-ghe.js intocado');
    });

    test('E6 — SALDO não interfere: material autorizado sem lote algum, com lote zerado e com saldo positivo aparecem do mesmo jeito, e a resposta não traz quantidade', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const semLote = await a.material(a.d.empresaA, { nome: 'E6 sem lote' });
      const zerado = await a.material(a.d.empresaA, { nome: 'E6 zerado', exigeTamanho: true, lotes: [{ tamanho: '40', quantidade: 0 }] });
      const comSaldo = await a.material(a.d.empresaA, { nome: 'E6 com saldo', exigeTamanho: true, lotes: [{ tamanho: '40', quantidade: 25 }] });
      for (const m of [semLote, zerado, comSaldo]) await a.vincularMaterial(a.d.empresaA, ghe, m);
      const r = await ver(await a.cenario(app, { gheId: ghe }));
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(r.body.catalogo.materiais.map((m) => m.id).sort((x, y) => x - y), [semLote, zerado, comSaldo].sort((x, y) => x - y));
      assert.equal(/quantidade|saldo|estoque|disponivel_|lote/i.test(Object.keys(r.body.catalogo.materiais[0]).join(' ')), false);
    });

    test('E7 — TIPO genérico sem material físico válido não vira item: tipo ligado ao GHE sem nenhum material (ou só com material inativo) resulta em catálogo vazio SEM_MATERIAIS e a resposta não tem lista de tipos', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const t = await a.tipo(a.d.empresaA);
      const tComInativo = await a.tipo(a.d.empresaA);
      await a.material(a.d.empresaA, { nome: 'E7 só inativo', tipoLinha: tComInativo, ativo: false });
      await a.vincularTipo(a.d.empresaA, ghe, t.id); await a.vincularTipo(a.d.empresaA, ghe, tComInativo.id);
      const r = await ver(await a.cenario(app, { gheId: ghe }));
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual([r.body.catalogo.estado, r.body.catalogo.materiais, r.body.catalogo.total], ['SEM_MATERIAIS', [], 0]);
      assert.equal(Object.keys(r.body.catalogo).includes('tipos'), false);
      assert.equal(JSON.stringify(r.body).includes(t.nome), false, 'o nome do tipo genérico não é item solicitável');
    });

    test('E8 — variações e tamanhos REAIS: a grade na ordem cadastrada (inclusive sem estoque); o legado sem grade usa os tamanhos dos lotes; material sem tamanho tem lista vazia; "exige tamanho" sem nenhum tamanho cadastrado e não classificado (nulo) NÃO são solicitáveis e ficam de fora', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const grade = await a.material(a.d.empresaA, { nome: 'E8 grade', exigeTamanho: true, grade: ['38', 'P', 'M'], lotes: [{ tamanho: 'M', quantidade: 0 }] });
      const legado = await a.material(a.d.empresaA, { nome: 'E8 legado', exigeTamanho: true, lotes: [{ tamanho: '42', quantidade: 1 }, { tamanho: '40', quantidade: 0 }, { tamanho: '40', quantidade: 5 }] });
      const unico = await a.material(a.d.empresaA, { nome: 'E8 único', exigeTamanho: false, lotes: [{ tamanho: 'Único', quantidade: 3 }] });
      const semTamanho = await a.material(a.d.empresaA, { nome: 'E8 exige sem tamanho', exigeTamanho: true });
      const naoClassificado = await a.material(a.d.empresaA, { nome: 'E8 não classificado', exigeTamanho: null });
      for (const m of [grade, legado, unico, semTamanho, naoClassificado]) await a.vincularMaterial(a.d.empresaA, ghe, m);
      const cat = await obter(await a.cenario(app, { gheId: ghe }));
      const por = Object.fromEntries(cat.materiais.map((m) => [m.id, m]));
      assert.deepEqual(por[grade].tamanhos, ['38', 'P', 'M']);
      assert.deepEqual([por[grade].exigeTamanho, por[legado].exigeTamanho, por[unico].exigeTamanho], [true, true, false]);
      assert.deepEqual(por[legado].tamanhos, ['40', '42']);
      assert.deepEqual(por[unico].tamanhos, []);
      assert.equal(semTamanho in por, false, 'exige tamanho e não há nenhum tamanho cadastrado');
      assert.equal(naoClassificado in por, false, 'exige_tamanho nulo: a criação do pedido o recusaria');
    });

    test('E9 — SEM GHE válido: funcionário sem GHE e funcionário com GHE INATIVO recebem 200 com catálogo vazio e estado explícito (SEM_GHE / GHE_INATIVO), mesmo havendo materiais na empresa; nunca um catálogo "geral"', async () => {
      const outro = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, outro, await a.material(a.d.empresaA, { nome: 'E9 de outro GHE' }));
      const semGhe = await obter(await a.cenario(app, { gheId: null }));
      assert.deepEqual([semGhe.estado, semGhe.materiais], ['SEM_GHE', []]);
      const inativo = await a.ghe(a.d.empresaA, { ativo: false });
      await a.vincularMaterial(a.d.empresaA, inativo, await a.material(a.d.empresaA, { nome: 'E9 do GHE inativo' }));
      const comGheInativo = await obter(await a.cenario(app, { gheId: inativo }));
      assert.deepEqual([comGheInativo.estado, comGheInativo.materiais], ['GHE_INATIVO', []]);
    });

    test('E10 — GHE sem vínculos, ou só com vínculos incompletos (material inativo, tipo sem material): 200 SEM_MATERIAIS, nunca erro nem catálogo de outro GHE', async () => {
      const vazio = await a.ghe(a.d.empresaA);
      const cat = await obter(await a.cenario(app, { gheId: vazio }));
      assert.deepEqual([cat.estado, cat.materiais, cat.total], ['SEM_MATERIAIS', [], 0]);
      const incompleto = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, incompleto, await a.material(a.d.empresaA, { nome: 'E10 inativo', ativo: false }));
      await a.vincularTipo(a.d.empresaA, incompleto, (await a.tipo(a.d.empresaA)).id);
      const cat2 = await obter(await a.cenario(app, { gheId: incompleto }));
      assert.deepEqual([cat2.estado, cat2.materiais], ['SEM_MATERIAIS', []]);
    });
  });

  // ───────────────────────── tablet, atendimento e contexto ─────────────────────────
  describe('tablet, atendimento e rede', () => {
    test('E11 — tablet REVOGADO, sem a credencial do tablet, só com o cookie do atendimento ou fora da rede autorizada: 401 DISPOSITIVO_NAO_AUTORIZADO / 403 REDE_NAO_AUTORIZADA e NENHUM dado', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, ghe, await a.material(a.d.empresaA, { nome: 'E11 material' }));
      const c = await a.cenario(app, { gheId: ghe });
      const semTablet = await a.catalogo(app, null, c.token);
      assert.deepEqual([semTablet.status, semTablet.body.codigo], NAO_AUTORIZADO, aviso(semTablet));
      const semAtendimentoNemTablet = await request(app).get(CATALOGO);
      assert.deepEqual([semAtendimentoNemTablet.status, semAtendimentoNemTablet.body.codigo], NAO_AUTORIZADO);
      await a.redes({ A: [], B: [] });
      const foraDaRede = await ver(c);
      assert.deepEqual([foraDaRede.status, foraDaRede.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(foraDaRede));
      await a.redes(a.redeDeTeste);
      assert.equal((await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${c.t.id}/revogar`)).status, 200);
      const revogado = await ver(c);
      assert.deepEqual([revogado.status, revogado.body.codigo], NAO_AUTORIZADO, aviso(revogado));
      assert.equal(JSON.stringify(revogado.body).includes('E11 material'), false);
    });

    test('E12 — atendimento EXPIRADO, ENCERRADO (saída), inexistente ou malformado: 401 ATENDIMENTO_INVALIDO, resposta única, cookie descartado e sem dados; o catálogo é SÓ LEITURA (o vencido não é fechado por ele)', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, ghe, await a.material(a.d.empresaA, { nome: 'E12 material' }));
      const vencido = await a.cenario(app, { gheId: ghe });
      await forcarRestante(vencido.atendimentoId, -10);
      const antes = await a.atendimento(vencido.atendimentoId);
      const rVencido = await ver(vencido);
      assert.deepEqual([rVencido.status, rVencido.body.codigo], ATENDIMENTO_INVALIDO, aviso(rVencido));
      assert.ok(lerSetCookie(rVencido).some((x) => x.nome === COOKIE_ATENDIMENTO && x.atributos['max-age'] === '0'));
      assert.deepEqual(await a.atendimento(vencido.atendimentoId), antes, 'o catálogo não escreve');
      const encerrado = await a.cenario(app, { gheId: ghe });
      assert.equal((await a.encerrarAtendimento(app, encerrado.t, encerrado.token)).status, 200);
      const inexistente = { t: await a.tabletNovo(), token: 'a'.repeat(64) };
      const semCookie = { t: encerrado.t, token: null };
      const respostas = [rVencido, await ver(encerrado), await ver(inexistente), await ver(semCookie), await a.catalogo(app, encerrado.t, 'abc')];
      for (const r of respostas) assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      assert.equal(new Set(respostas.map((r) => JSON.stringify(r.body))).size, 1, 'indistinguíveis');
    });

    test('E13 — ISOLAMENTO entre empresas: com GHE, vínculos e materiais de nomes idênticos na empresa B, o catálogo da A traz só materiais da A; o token da A com o tablet da B é recusado; um CPF comum às duas identifica sempre a empresa do tablet', async () => {
      const gheA = await a.ghe(a.d.empresaA); const gheB = await a.ghe(a.d.empresaB);
      const mA = await a.material(a.d.empresaA, { nome: 'E13 Capacete' });
      const mB = await a.material(a.d.empresaB, { nome: 'E13 Capacete' });
      await a.material(a.d.empresaB, { nome: 'E13 só da B' });
      await a.vincularMaterial(a.d.empresaA, gheA, mA); await a.vincularMaterial(a.d.empresaB, gheB, mB);
      await assert.rejects(() => a.vincularMaterial(a.d.empresaA, gheA, mB), (e) => e.code === '23503', 'o banco já impede vínculo entre empresas');
      const c = await a.cenario(app, { gheId: gheA });
      const cat = await obter(c);
      assert.deepEqual(cat.materiais.map((m) => m.id), [mA]);
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }], B: [{ tipo: 'IP_FIXO', rede: `${IP_TESTE}/32` }] });
      const tB = await a.tabletNovo(a.d.empresaB);
      const cruzado = await a.catalogo(app, tB, c.token);
      assert.deepEqual([cruzado.status, cruzado.body.codigo], ATENDIMENTO_INVALIDO, aviso(cruzado));
      const cpfComum = cpfFicticio(970001);
      await a.funcionarioNoGhe(a.d.empresaB, gheB, { cpf: cpfComum });
      const catComum = await obter(await a.cenario(app, { gheId: gheA, funcionario: { cpf: cpfComum } }));
      assert.deepEqual(catComum.materiais.map((m) => m.id), [mA]);
    });

    test('E14 — MANIPULAÇÃO de empresa, funcionário, GHE e material: query (qualquer parâmetro) é 400 VALIDACAO; cabeçalhos x-* e métodos de escrita não mudam nem ampliam nada; o catálogo é sempre o do GHE do funcionário do atendimento', async () => {
      const gheA = await a.ghe(a.d.empresaA); const gheOutro = await a.ghe(a.d.empresaA);
      const permitido = await a.material(a.d.empresaA, { nome: 'E14 permitido' });
      const proibido = await a.material(a.d.empresaA, { nome: 'E14 proibido' });
      await a.vincularMaterial(a.d.empresaA, gheA, permitido); await a.vincularMaterial(a.d.empresaA, gheOutro, proibido);
      const c = await a.cenario(app, { gheId: gheA });
      for (const query of [`empresaId=${a.d.empresaB}`, `gheId=${gheOutro}`, `funcionarioId=${c.f.id + 1}`, `materialId=${proibido}`, 'limite=1000', 'pagina=2', 'busca=proibido', 'todos=true']) {
        const r = await a.catalogoComQuery(app, c.t, c.token, query);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${query}: ${aviso(r)}`);
      }
      const comCabecalhos = await a.catalogo(app, c.t, c.token, { 'x-empresa-id': String(a.d.empresaB), 'x-ghe-id': String(gheOutro), 'x-funcionario-id': '1', 'x-material-id': String(proibido) });
      assert.equal(comCabecalhos.status, 200, aviso(comCabecalhos));
      assert.deepEqual(comCabecalhos.body.catalogo.materiais.map((m) => m.id), [permitido]);
      for (const metodo of ['post', 'put', 'patch', 'delete']) {
        const r = await a.escreverNoCatalogo(app, metodo, c.t, c.token);
        assert.ok(r.status >= 400, `${metodo} no catálogo deveria ser recusado: ${aviso(r)}`);
      }
    });

    test('E15 — IMAGEM associada ao material físico correto e à empresa correta (e nunca só pelo nome)', { skip: 'BLOQUEADO: não existe estrutura de imagem (ver K4). Testar tabela/coluna fictícia é proibido; este teste só pode ser escrito depois da decisão sobre a estrutura de imagens (nova migration) e do armazenamento' }, () => {});

    test('E16 — material SEM imagem: todo item traz imagem = { disponivel: false } (estado explícito, sem URL nula solta nem campos de armazenamento) e continua selecionável', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const t = await a.tipo(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, ghe, await a.material(a.d.empresaA, { nome: 'E16 direto' }));
      await a.vincularTipo(a.d.empresaA, ghe, t.id);
      await a.material(a.d.empresaA, { nome: 'E16 por tipo', tipoLinha: t });
      const cat = await obter(await a.cenario(app, { gheId: ghe }));
      assert.equal(cat.materiais.length, 2);
      for (const m of cat.materiais) assert.deepEqual(m.imagem, SEM_IMAGEM, m.nome);
    });

    test('E17 — SEM VAZAMENTO: nem CPF, matrícula, nome do funcionário ou de colegas do GHE, nem token, hash, credencial, nem chaves de saldo, empresa, GHE ou identificadores internos no corpo, nos cabeçalhos ou no cookie', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, ghe, await a.material(a.d.empresaA, { nome: 'E17 Botina', exigeTamanho: true, grade: ['40', '41'], lotes: [{ tamanho: '40', quantidade: 77 }] }));
      const colega = await a.funcionarioNoGhe(a.d.empresaA, ghe, { nome: 'Colega Reservado Santos' });
      const c = await a.cenario(app, { gheId: ghe, funcionario: { nome: 'Zenaida Quirino Albuquerque' } });
      const r = await ver(c);
      assert.equal(r.status, 200, aviso(r));
      const { 'set-cookie': cookies, ...cabecalhos } = r.headers;
      assert.equal(cookies, undefined, 'o catálogo não reemite cookie');
      const texto = JSON.stringify(r.body) + JSON.stringify(cabecalhos);
      for (const proibido of [c.f.cpf, c.f.matricula, 'Zenaida', 'Quirino', 'Albuquerque', colega.cpf, colega.matricula, 'Colega', 'Reservado', c.token, hashTokenSessao(c.token), sha256(c.token), c.t.credencial, hashTokenSessao(c.t.credencial)]) {
        assert.equal(texto.includes(proibido), false, `vazou: ${String(proibido).slice(0, 12)}`);
      }
      assert.equal(texto.includes('77'), false, 'o saldo do lote não aparece');
      const chaves = [];
      (function colher(v) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { chaves.push(k); colher(x); } }(r.body));
      assert.deepEqual(chaves.filter((k) => /saldo|quantidade|estoque|lote|cpf|matricula|token|hash|senha|credencial|funcionario|empresa|ghe|dispositivo|tablet|ca_|validade/i.test(k)), []);
    });

    test('E18 — consultar o catálogo NÃO renova nem altera o atendimento: dezenas de consultas deixam o registro idêntico (expira_em incluído), não reemitem cookie, e o atendimento vence no horário mesmo assim', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, ghe, await a.material(a.d.empresaA, { nome: 'E18 material' }));
      const c = await a.cenario(app, { gheId: ghe });
      await forcarRestante(c.atendimentoId, 20);
      const antes = JSON.stringify(await a.atendimento(c.atendimentoId));
      for (let i = 0; i < 12; i += 1) {
        const r = await ver(c);
        assert.equal(r.status, 200, `consulta ${i + 1}: ${aviso(r)}`);
        assert.equal(lerSetCookie(r).some((x) => x.nome === COOKIE_ATENDIMENTO), false);
      }
      assert.equal(JSON.stringify(await a.atendimento(c.atendimentoId)), antes, 'registro idêntico');
      await forcarRestante(c.atendimentoId, -10);
      const vencido = await ver(c);
      assert.deepEqual([vencido.status, vencido.body.codigo], ATENDIMENTO_INVALIDO, 'as consultas não impediram a expiração');
    });

    test('E19 — atendimento SUBSTITUÍDO: o token antigo não consulta nada (401) e o novo atendimento vê o catálogo do SEU funcionário (GHE diferente), nunca o da sessão anterior', async () => {
      const gheA = await a.ghe(a.d.empresaA); const gheB = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, gheA, await a.material(a.d.empresaA, { nome: 'E19 da sessão A' }));
      await a.vincularMaterial(a.d.empresaA, gheB, await a.material(a.d.empresaA, { nome: 'E19 da sessão B' }));
      const velho = await a.cenario(app, { gheId: gheA });
      assert.deepEqual(nomes(await obter(velho)), ['E19 da sessão A']);
      const fB = await a.funcionarioNoGhe(a.d.empresaA, gheB);
      const novo = await a.identificar(app, velho.t.credencial, { tipo: 'CPF', valor: fB.cpf });
      assert.equal(novo.status, 201, aviso(novo));
      const tokenNovo = cookieDoAtendimentoNaResposta(novo).valor;
      const atrasada = await ver(velho);
      assert.deepEqual([atrasada.status, atrasada.body.codigo], ATENDIMENTO_INVALIDO, aviso(atrasada));
      assert.equal(JSON.stringify(atrasada.body).includes('E19'), false);
      assert.deepEqual(nomes(await obter({ t: velho.t, token: tokenNovo })), ['E19 da sessão B']);
    });

    test('E25 — VOLUME (D-E10): nenhum limite arbitrário elimina material elegível: 650 materiais autorizados (por vínculo direto e por tipo) voltam TODOS, sem repetição, na ordem estável, numa única resposta', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const t = await a.tipo(a.d.empresaA);
      const diretos = (await a.q(
        `INSERT INTO materiais (empresa_id, nome, exige_ca, exige_tamanho, prazo_uso_dias)
         SELECT $1, 'E25 direto ' || lpad(g::text, 4, '0'), true, false, 180 FROM generate_series(1, 400) g RETURNING id`, [a.d.empresaA],
      )).rows.map((r) => r.id);
      await a.q('INSERT INTO ghe_materiais (empresa_id, grupo_homogeneo_id, material_id) SELECT $1, $2, x FROM unnest($3::int[]) x', [a.d.empresaA, ghe, diretos]);
      const porTipo = (await a.q(
        `INSERT INTO materiais (empresa_id, nome, exige_ca, exige_tamanho, prazo_uso_dias, modelo_classificacao, categoria, grupo_protecao, tipo, tipo_material_id)
         SELECT $1, 'E25 tipo ' || lpad(g::text, 4, '0'), true, false, 180, 'V2', $2, $3, $4, $5 FROM generate_series(1, 250) g RETURNING id`,
        [a.d.empresaA, t.grupo, t.grupo_protecao, t.nome, t.id],
      )).rows.map((r) => r.id);
      await a.vincularTipo(a.d.empresaA, ghe, t.id);
      await a.material(a.d.empresaA, { nome: 'E25 fora do GHE' });
      const cat = await obter(await a.cenario(app, { gheId: ghe }));
      assert.equal(cat.total, 650);
      assert.equal(new Set(cat.materiais.map((m) => m.id)).size, 650);
      assert.deepEqual(cat.materiais.map((m) => m.id).sort((x, y) => x - y), [...diretos, ...porTipo].sort((x, y) => x - y));
      const nomesOrdenados = [...nomes(cat)].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase()));
      assert.deepEqual(nomes(cat), nomesOrdenados, 'ordem estável por nome');
    });

    test('E26 — LIMITE por tablet (chave do servidor): com o limitador injetado em 2, a 3ª consulta é 429 mesmo com atendimento válido, e OUTRO tablet do mesmo IP não é afetado', async () => {
      const { criarLimitador } = require('../../src/middleware/rate-limit');
      const { chavePorDispositivo } = require('../../src/routes/token-tablet.routes');
      const ghe = await a.ghe(a.d.empresaA);
      const c1 = await a.cenario(app, { gheId: ghe }); const c2 = await a.cenario(app, { gheId: ghe });
      const limitado = a.criarApp({ hops: 0, limitadorDispositivo: criarLimitador({ limite: 2, janelaSegundos: 60, chave: chavePorDispositivo }) });
      assert.equal((await a.catalogo(limitado, c1.t, c1.token)).status, 200);
      assert.equal((await a.catalogo(limitado, c1.t, c1.token)).status, 200);
      const barrada = await a.catalogo(limitado, c1.t, c1.token);
      assert.deepEqual([barrada.status, barrada.body.codigo], [429, 'LIMITE_REQUISICOES_EXCEDIDO'], aviso(barrada));
      assert.equal((await a.catalogo(limitado, c2.t, c2.token)).status, 200, 'o outro tablet não é afetado');
    });

    test('E24 — funcionário que deixa de ser ATIVO DURANTE o atendimento (AFASTADO ou INATIVO) perde o catálogo na próxima consulta: 401 ATENDIMENTO_INVALIDO, sem dados, sem renovar e sem fechar o registro com causa inventada (regra da Etapa D)', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, ghe, await a.material(a.d.empresaA, { nome: 'E24 material' }));
      for (const situacao of ['AFASTADO', 'INATIVO']) {
        const c = await a.cenario(app, { gheId: ghe });
        assert.deepEqual(nomes(await obter(c)), ['E24 material'], 'premissa: enquanto ATIVO, o catálogo vem');
        await a.q('UPDATE funcionarios SET situacao = $2 WHERE id = $1', [c.f.id, situacao]);
        const antes = await a.atendimento(c.atendimentoId);
        const r = await ver(c);
        assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, `${situacao}: ${aviso(r)}`);
        assert.equal(JSON.stringify(r.body).includes('E24'), false);
        assert.deepEqual(await a.atendimento(c.atendimentoId), antes, `${situacao}: nada renovado nem fechado`);
      }
    });

    test('E20 — REATIVAÇÃO efetiva do tablet invalida o contexto anterior: a credencial antiga é 401 e o atendimento aberto antes da reativação é 401 também com a credencial NOVA; um atendimento aberto depois da reativação vê o catálogo normalmente', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, ghe, await a.material(a.d.empresaA, { nome: 'E20 material' }));
      const c = await a.cenario(app, { gheId: ghe });
      const nova = cookieDoTabletNaResposta(await a.ativar(app, await gerarCodigo(c.t.id))).valor;
      const antiga = await ver(c);
      assert.deepEqual([antiga.status, antiga.body.codigo], NAO_AUTORIZADO, aviso(antiga));
      const anterior = await a.catalogo(app, { credencial: nova }, c.token);
      assert.deepEqual([anterior.status, anterior.body.codigo], ATENDIMENTO_INVALIDO, aviso(anterior));
      const depois = await a.identificar(app, nova, { tipo: 'CPF', valor: c.f.cpf });
      assert.equal(depois.status, 201, aviso(depois));
      const ok = await a.catalogo(app, { credencial: nova }, cookieDoAtendimentoNaResposta(depois).valor);
      assert.equal(ok.status, 200, aviso(ok));
      assert.deepEqual(nomes(ok.body.catalogo), ['E20 material']);
    });

    test('E20b — a JANELA da Etapa D também vale para o catálogo: atendimento aberto durante a transação de reativação já iniciada (pool instrumentado, sem sleep) é 401 com a credencial nova', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, ghe, await a.material(a.d.empresaA, { nome: 'E20b material' }));
      const f = await a.funcionarioNoGhe(a.d.empresaA, ghe);
      const t = await a.tabletNovo();
      const codigo = await gerarCodigo(t.id);
      let liberar; let pausou; let jaPausou = false;
      const liberada = new Promise((r) => { liberar = r; }); const pausado = new Promise((r) => { pausou = r; });
      const pool = {
        query: (...args) => a.ctx.pool.query(...args),
        connect: async () => {
          const client = await a.ctx.pool.connect();
          return {
            release: (...args) => client.release(...args),
            async query(texto, ...resto) {
              if (!jaPausou && typeof texto === 'string' && texto.includes('FOR UPDATE OF d')) { jaPausou = true; pausou(); await liberada; }
              return client.query(texto, ...resto);
            },
          };
        },
      };
      const ativacao = tokenTabletService.ativar(pool, { codigo, ip: IP_TESTE, agente: null });
      const prazo = Date.now() + LIMITE_DE_SEGURANCA_MS;
      await Promise.race([pausado, new Promise((_, rej) => setTimeout(() => rej(new Error('a reativação não chegou à trava (limite de segurança do teste)')), prazo - Date.now()))]);
      const identificacao = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
      assert.equal(identificacao.status, 201, aviso(identificacao));
      const token = cookieDoAtendimentoNaResposta(identificacao).valor;
      liberar();
      const { credencial: nova } = await ativacao;
      const r = await a.catalogo(app, { credencial: nova }, token);
      assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
    });
  });

  // ───────────────────────── identificação, duplicidade e compatibilidade ─────────────────────────
  describe('identificação, reprodutibilidade e contrato', () => {
    test('E21 — CPF e MATRÍCULA continuam sendo formas explícitas de identificação e NÃO mudam a elegibilidade: a mesma pessoa tem o mesmo catálogo por qualquer forma; e o identificador ambíguo (CPF de um = matrícula de outro) resulta no catálogo de QUEM o tipo escolhido identifica', async () => {
      const gheA = await a.ghe(a.d.empresaA); const gheB = await a.ghe(a.d.empresaA);
      await a.vincularMaterial(a.d.empresaA, gheA, await a.material(a.d.empresaA, { nome: 'E21 do dono do CPF' }));
      await a.vincularMaterial(a.d.empresaA, gheB, await a.material(a.d.empresaA, { nome: 'E21 do dono da matrícula' }));
      const pessoa = await a.funcionarioNoGhe(a.d.empresaA, gheA);
      const tCpf = await a.tabletNovo(); const tMat = await a.tabletNovo();
      const abertoPorCpf = await a.identificar(app, tCpf.credencial, { tipo: 'CPF', valor: pessoa.cpf });
      const abertoPorMat = await a.identificar(app, tMat.credencial, { tipo: 'MATRICULA', valor: pessoa.matricula });
      assert.deepEqual([abertoPorCpf.status, abertoPorMat.status], [201, 201]);
      const porCpf = await obter({ t: tCpf, token: cookieDoAtendimentoNaResposta(abertoPorCpf).valor });
      const porMatricula = await obter({ t: tMat, token: cookieDoAtendimentoNaResposta(abertoPorMat).valor });
      assert.deepEqual(porMatricula, porCpf);
      assert.deepEqual(nomes(porCpf), ['E21 do dono do CPF']);

      const donoDoCpf = await a.funcionarioNoGhe(a.d.empresaA, gheA);
      await a.funcionarioNoGhe(a.d.empresaA, gheB, { matricula: donoDoCpf.cpf });
      const t1 = await a.tabletNovo(); const t2 = await a.tabletNovo();
      const rCpf = await a.identificar(app, t1.credencial, { tipo: 'CPF', valor: donoDoCpf.cpf });
      const rMat = await a.identificar(app, t2.credencial, { tipo: 'MATRICULA', valor: donoDoCpf.cpf });
      assert.deepEqual([rCpf.status, rMat.status], [201, 201]);
      assert.deepEqual(nomes(await obter({ t: t1, token: cookieDoAtendimentoNaResposta(rCpf).valor })), ['E21 do dono do CPF']);
      assert.deepEqual(nomes(await obter({ t: t2, token: cookieDoAtendimentoNaResposta(rMat).valor })), ['E21 do dono da matrícula']);
    });

    test('E22 — sem DUPLICIDADE e reproduzível: material permitido pelo vínculo direto E por tipo (OBRIGATORIO) aparece UMA vez; duas consultas seguidas são idênticas; a ordem é nome (sem caixa) e depois id', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const t = await a.tipo(a.d.empresaA);
      const ambos = await a.material(a.d.empresaA, { nome: 'E22 b ambos', tipoLinha: t });
      const g1 = await a.material(a.d.empresaA, { nome: 'E22 Gêmeo' });
      const g2 = await a.material(a.d.empresaA, { nome: 'E22 Gêmeo' });
      const primeiro = await a.material(a.d.empresaA, { nome: 'E22 a primeiro' });
      await a.vincularMaterial(a.d.empresaA, ghe, ambos); await a.vincularTipo(a.d.empresaA, ghe, t.id, 'OBRIGATORIO');
      for (const m of [g1, g2, primeiro]) await a.vincularMaterial(a.d.empresaA, ghe, m);
      const c = await a.cenario(app, { gheId: ghe });
      const um = await obter(c); const dois = await obter(c);
      assert.deepEqual(um, dois);
      assert.deepEqual(um.materiais.map((m) => m.id), [primeiro, ambos, g1, g2], 'ordem: lower(nome), id');
      assert.equal(new Set(um.materiais.map((m) => m.id)).size, um.materiais.length);
    });

    test('E23 — COMPATIBILIDADE com as etapas posteriores (sem implementar pedidos): todo item do catálogo é um material que a regra EXISTENTE do pedido considera "previsto no GHE" e ativo, com o mesmo exigeTamanho e os MESMOS tamanhos que o pedido aceitaria; nada é criado (solicitações, entregas, fichas, reservas, estoque)', async () => {
      const ghe = await a.ghe(a.d.empresaA);
      const t = await a.tipo(a.d.empresaA);
      const ids = [
        await a.material(a.d.empresaA, { nome: 'E23 grade', exigeTamanho: true, grade: ['P', 'M'] }),
        await a.material(a.d.empresaA, { nome: 'E23 legado', exigeTamanho: true, lotes: [{ tamanho: '40', quantidade: 2 }] }),
        await a.material(a.d.empresaA, { nome: 'E23 único' }),
        await a.material(a.d.empresaA, { nome: 'E23 do tipo', tipoLinha: t }),
      ];
      for (const m of ids.slice(0, 3)) await a.vincularMaterial(a.d.empresaA, ghe, m);
      await a.vincularTipo(a.d.empresaA, ghe, t.id);
      const contagens = async () => Object.fromEntries(await Promise.all(['solicitacoes_epi', 'solicitacoes_autoatendimento', 'entregas_epi', 'fichas_epi', 'estoque_lotes', 'estoque_operacoes'].map(async (tab) => [tab, (await a.q(`SELECT count(*)::int AS n FROM ${tab}`)).rows[0].n])));
      const antes = await contagens();
      const cat = await obter(await a.cenario(app, { gheId: ghe }));
      const previstos = await contextoRepo.listarMateriais(a.ctx.pool, a.d.empresaA, { gheId: ghe, previstoNoGhe: true, pagina: 1, limite: 100 });
      const porId = Object.fromEntries(previstos.map((m) => [m.id, m]));
      assert.equal(cat.materiais.length, ids.length);
      for (const m of cat.materiais) {
        const pedido = porId[m.id];
        assert.ok(pedido, `${m.nome} deveria ser previsto no GHE pela regra do pedido`);
        assert.deepEqual([m.exigeTamanho, m.tamanhos], [pedido.exigeTamanho, pedido.tamanhosSugeridos]);
        assert.equal(Number.isInteger(m.id), true);
      }
      assert.deepEqual(await contagens(), antes, 'consultar o catálogo não cria nem altera pedidos, entregas, fichas nem estoque');
    });
  });
});
