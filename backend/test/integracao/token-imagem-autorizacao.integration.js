'use strict';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');

const { abrirAmbienteCatalogo } = require('./helpers/token-catalogo');
const { BASE, cabecalhoCookie } = require('./helpers/token-atendimento');
const { ORIGEM, CAMINHO_TABLET, cookieDoTabletNaResposta, criarLimitador } = require('./helpers/token-tablet');
const { semearEmpresa, semearPadrao, cabecalhosComparaveis } = require('./helpers/imagem-material-entrega');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { chavePorDispositivo } = require('../../src/routes/token-tablet.routes');
const tabletService = require('../../src/services/token-tablet.service');
const { criarVerificacaoOrigem } = require('../../src/middleware/origem');
const { espiarPool, ESCRITA_SQL } = require('../helpers/instrumentacao-importacao');
const { inserir } = require('./helpers/entrega-epi');
const { criarAppTeste } = require('../helpers/app-teste');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Atendimento Token — imagens do material no tablet (RED-1, PostgreSQL real em schema temporário, só o banco de teste). Contrato proposto, ainda NÃO
 * implementado (GREEN futuro): GET|HEAD /api/atendimento-token/tablet/atendimento/imagens/:origem/:id/:variante?v= em src/routes/token-imagem.routes.js,
 * src/controllers/token-imagem.controller.js (criarTokenImagemController({ pool, armazenamento })) e src/services/token-imagem.service.js.
 *
 * AUTORIZAÇÃO: a imagem só sai se for a imagem ATUALMENTE vinculada (válida e ativa) a pelo menos um material SELECIONÁVEL pelo funcionário do atendimento
 * vigente, no sentido EXATO do catálogo (atendimento aberto e não vencido; funcionário ativo; GHE existente e ativo; material ativo; previsto no GHE por vínculo
 * direto ou por tipo ATIVO; classificação de tamanho presente; grade quando o material exige tamanho). Nenhum identificador do navegador autoriza nada. Todo caso
 * negado é a MESMA resposta externa 404 (inexistente, inativa, de outra empresa, não autorizada). A rota não renova o atendimento, não rotaciona credenciais e
 * não emite Set-Cookie do tablet; as falhas de autenticação preservam os eventos de segurança existentes (REUSO_CREDENCIAL, REDE_RECUSADA, com a supressão atual).
 *
 * As etapas de preparo (tablet, atendimento aberto pela API, catálogo) rodam de verdade AGORA, com o app existente; o app com a rota de imagem só é montado no
 * primeiro pedido de imagem, de modo que a ausência da funcionalidade apareça como RED nesse ponto e não como erro de montagem.
 */

const caminhoDaImagem = (origem, id, variante = 'miniatura', consulta = '') => `${BASE}/imagens/${origem}/${id}/${variante}${consulta}`;
const binario = (r) => r.buffer(true).parse((res, cb) => { const p = []; res.on('data', (c) => p.push(c)); res.on('end', () => cb(null, Buffer.concat(p))); });
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const NAO_ENCONTRADA = [404, 'IMAGEM_NAO_ENCONTRADA'];
const MARCA_FIM_AUTENTICACAO = 'FIM_AUTENTICACAO';

describe('Atendimento Token — imagens: autorização pelo catálogo (PostgreSQL real)', () => {
  let a;
  let appBase;
  let armazenamento;
  let diretorio;
  let adaptador;
  let appImagemMemo = null;

  before(async () => {
    a = await abrirAmbienteCatalogo();
    diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-img-teste-'));
    armazenamento = criarArmazenamentoImagens({ diretorio });
    adaptador = {
      pool: a.ctx.pool,
      armazenamento,
      padrao: (extra) => inserir(a.ctx.pool, 'imagens_padrao', { arquivo_origem: `padrao-${String(extra.sha256).slice(0, 8)}.png`, formato: 'PNG', largura: 1024, altura: 1024, ...extra }),
    };
    appBase = a.criarApp();
  });
  after(async () => {
    if (a) await a.encerrar();
    if (diretorio) fs.rmSync(diretorio, { recursive: true, force: true });
  });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  /** App com SÓ a rota de imagem (a nova), sobre o mesmo banco; o pool pode ser um espião. Criado no primeiro uso: sem a funcionalidade, falha aqui (RED). */
  function montarAppImagem({ pool = a.ctx.pool } = {}) {
    const rotas = exigirModulo('src/routes/token-imagem.routes');
    const controller = exigirModulo('src/controllers/token-imagem.controller');
    return criarAppTeste((ap) => {
      ap.set('trust proxy', false);
      ap.use('/api', criarVerificacaoOrigem({ origens: [ORIGEM] }));
      ap.use('/api', rotas.criarTokenImagemRoutes({
        controller: controller.criarTokenImagemController({ pool, armazenamento }),
        pool,
        limitador: criarLimitador({ limite: 100000, janelaSegundos: 60 }),
        limitadorDispositivo: criarLimitador({ limite: 100000, janelaSegundos: 60, chave: chavePorDispositivo }),
      }));
    });
  }
  const appImagem = () => (appImagemMemo ??= montarAppImagem());
  const imagem = (credencial, token, caminho, metodo = 'get') => {
    const req = request(appImagem())[metodo](caminho);
    const c = cabecalhoCookie(credencial, token);
    return c ? req.set('Cookie', c) : req;
  };

  const vincular = (materialId, { empresaId = null, padraoId = null }) => a.q('UPDATE materiais SET imagem_empresa_id = $2, imagem_padrao_id = $3 WHERE id = $1', [materialId, empresaId, padraoId]);
  const semearDaEmpresa = (empresaId) => semearEmpresa(adaptador, { empresaId, atorId: a.masterDe(empresaId) });

  /**
   * Mundo mínimo de um funcionário no atendimento: GHE, material com a imagem da empresa vinculada e atendimento aberto pela API real. Opções para as variações
   * de seleção (todas sobre estruturas reais): material inativo, autorização só por tipo (ativo ou não), exigência de tamanho com ou sem grade, GHE inativo.
   */
  async function mundo({ empresaId = a.d.empresaA, via = 'direto', ativoMaterial = true, tipoAtivo = true, exigeTamanho = false, grade = [], gheAtivo = true, semGhe = false } = {}) {
    const gheId = await a.ghe(empresaId, { ativo: gheAtivo });
    let materialId;
    if (via === 'tipo') {
      const tipo = await a.tipo(empresaId, { ativo: tipoAtivo });
      materialId = await a.material(empresaId, { ativo: ativoMaterial, exigeTamanho, grade, tipoLinha: tipo });
      await a.vincularTipo(empresaId, gheId, tipo.id);
    } else {
      materialId = await a.material(empresaId, { ativo: ativoMaterial, exigeTamanho, grade });
      await a.vincularMaterial(empresaId, gheId, materialId);
    }
    const img = await semearDaEmpresa(empresaId);
    await vincular(materialId, { empresaId: img.id });
    const c = await a.cenario(appBase, { empresaId, gheId: semGhe ? null : gheId });
    return { ...c, empresaId, gheId, materialId, img, rota: caminhoDaImagem('empresa', img.id) };
  }

  const catalogoDe = async (c) => (await a.catalogo(appBase, c.t, c.token)).body.catalogo;
  const linhaDoAtendimento = (c) => a.atendimento(c.atendimentoId);

  // ═══════════════════════════════════════════════════════════════════
  // Entrega e identificadores
  // ═══════════════════════════════════════════════════════════════════
  test('TIA-01 — o catálogo entrega os tipos de hoje (material.id inteiro; imagem.id texto decimal; versao inteira ≥ 1; origem EMPRESA|PADRAO) e esses valores, convertidos, buscam a imagem (GET e HEAD)', async () => {
    const c = await mundo();
    const cat = await catalogoDe(c);
    const m = cat.materiais.find((x) => x.id === c.materialId);
    assert.ok(m, 'o material selecionável está no catálogo');
    assert.equal(Number.isInteger(m.id), true, 'material.id segue inteiro JavaScript');
    assert.deepEqual(Object.keys(m.imagem).sort(), ['disponivel', 'id', 'origem', 'versao']);
    assert.equal(m.imagem.disponivel, true);
    assert.match(m.imagem.id, /^[1-9][0-9]{0,18}$/);
    assert.equal(typeof m.imagem.id, 'string', 'imagem.id segue texto decimal');
    assert.equal(Number.isInteger(m.imagem.versao) && m.imagem.versao >= 1, true);
    assert.ok(['EMPRESA', 'PADRAO'].includes(m.imagem.origem));
    const origem = exigirModulo('src/schemas/token-imagem.schema').origemDaRota(m.imagem.origem);
    assert.equal(origem, 'empresa');
    const caminho = caminhoDaImagem(origem, m.imagem.id, 'miniatura', `?v=${m.imagem.versao}`);
    const get = await binario(imagem(c.t.credencial, c.token, caminho));
    assert.equal(get.status, 200, aviso(get));
    assert.deepEqual(get.body, c.img.bytes.miniatura);
    assert.match(get.headers['content-type'], /^image\/webp/);
    assert.ok(String(get.headers['cache-control']).includes('no-store'));
    assert.equal(get.headers.etag, undefined);
    const head = await imagem(c.t.credencial, c.token, caminho, 'head');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
  });

  test('TIA-02 — imagem da biblioteca PADRÃO (global) vinculada a material selecionável da empresa: 200 em miniatura; a variante exibição ausente no pacote cai no mesmo 404 uniforme', async () => {
    const c = await mundo();
    const padrao = await semearPadrao(adaptador, {});
    await vincular(c.materialId, { padraoId: padrao.id });
    const cat = await catalogoDe(c);
    assert.deepEqual(cat.materiais.find((x) => x.id === c.materialId).imagem, { disponivel: true, origem: 'PADRAO', id: padrao.id, versao: padrao.versao });
    const ok = await binario(imagem(c.t.credencial, c.token, caminhoDaImagem('padrao', padrao.id)));
    assert.equal(ok.status, 200, aviso(ok));
    assert.deepEqual(ok.body, padrao.bytes.miniatura);
    const semExibicao = await imagem(c.t.credencial, c.token, caminhoDaImagem('padrao', padrao.id, 'exibicao'));
    assert.deepEqual([semExibicao.status, semExibicao.body.codigo], NAO_ENCONTRADA, aviso(semExibicao));
  });

  // ═══════════════════════════════════════════════════════════════════
  // Atendimento, sessão e não renovação
  // ═══════════════════════════════════════════════════════════════════
  test('TIA-03 — sem atendimento válido é 401 ATENDIMENTO_INVALIDO: ausente, malformado, de outro tablet, expirado e encerrado; a rota NÃO fecha o vencido nem escreve', async () => {
    const c = await mundo();
    const outro = await a.tabletNovo(c.empresaId);
    // Preparo de TODOS os cenários antes do primeiro pedido de imagem, cada um com tablet, funcionário e atendimento próprios: a ausência da rota (RED) só aparece
    // depois que o preparo do vencido e do encerrado foi alcançado, e um cenário não depende do estado do outro.
    const f = await a.funcionarioNoGhe(c.empresaId, c.gheId);
    const t2 = await a.tabletNovo(c.empresaId);
    // Atendimento de 60 s de validade, iniciado há 65 s: já expirou há 5 s (e expira_em > iniciado_em, como exige chk_token_atendimentos_validade).
    const vencido = await a.atendimentoDireto(t2, f.id, { restanteSegundos: -5, iniciadoHaSegundos: 65 });
    const vencidoAntes = await a.atendimento(vencido.id);
    const c2 = await a.cenario(appBase, { empresaId: c.empresaId, gheId: c.gheId });
    const enc = await a.encerrarAtendimento(appBase, c2.t, c2.token);
    assert.equal(enc.status, 200, aviso(enc));
    const cenarios = [
      ['sem cookie do atendimento', () => imagem(c.t.credencial, null, c.rota)],
      ['malformado', () => imagem(c.t.credencial, 'nao-e-um-token', c.rota)],
      ['de outro tablet', () => imagem(outro.credencial, c.token, c.rota)],
      ['expirado', () => imagem(t2.credencial, vencido.token, c.rota)],
      ['encerrado', () => imagem(c2.t.credencial, c2.token, c.rota)],
    ];
    for (const [nome, pedir] of cenarios) {
      const r = await pedir();
      assert.deepEqual([r.status, r.body.codigo], [401, 'ATENDIMENTO_INVALIDO'], `${nome}: ${aviso(r)}`);
    }
    assert.deepEqual(await a.atendimento(vencido.id), vencidoAntes, 'a rota de imagem não fecha o atendimento vencido nem grava nada');
  });

  test('TIA-04 — a consulta de imagem NÃO renova os 60 s do atendimento (expira_em idêntico) e não emite cookie do atendimento; a renovação segue exclusiva de POST /atividade', async () => {
    const c = await mundo();
    const antes = await linhaDoAtendimento(c);
    await new Promise((r) => { setTimeout(r, 1100); });
    const r = await imagem(c.t.credencial, c.token, c.rota);
    assert.equal(r.status, 200, aviso(r));
    assert.deepEqual(await linhaDoAtendimento(c), antes, 'nenhuma coluna do atendimento muda');
    assert.equal(r.headers['set-cookie'], undefined);
    const atividade = await a.prorrogar(appBase, c.t, c.token);
    assert.equal(atividade.status, 200, aviso(atividade));
    assert.notEqual(String((await linhaDoAtendimento(c)).expira_em), String(antes.expira_em), 'só /atividade renova');
  });

  // ═══════════════════════════════════════════════════════════════════
  // Autorização: empresa, GHE, material efetivamente selecionável
  // ═══════════════════════════════════════════════════════════════════
  test('TIA-05 — isolamento entre empresas: a imagem (e o material) de outra empresa é 404 uniforme, mesmo com o id certo; a imagem da própria empresa continua 200', async () => {
    const c = await mundo();
    const empresaB = a.d.empresaB;
    const gheB = await a.ghe(empresaB);
    const materialB = await a.material(empresaB, {});
    await a.vincularMaterial(empresaB, gheB, materialB);
    const imgB = await semearDaEmpresa(empresaB);
    await vincular(materialB, { empresaId: imgB.id });
    const r = await imagem(c.t.credencial, c.token, caminhoDaImagem('empresa', imgB.id));
    assert.deepEqual([r.status, r.body.codigo], NAO_ENCONTRADA, aviso(r));
    assert.equal((await imagem(c.t.credencial, c.token, c.rota)).status, 200);
  });

  test('TIA-06 — 404 EXTERNAMENTE UNIFORME: inexistente, inativa, de outra empresa, de material fora do GHE e padrão inexistente têm o mesmo status, corpo e cabeçalhos (sem vazamento do motivo)', async () => {
    const c = await mundo();
    const foraDoGhe = await a.material(c.empresaId, {});
    const imgFora = await semearDaEmpresa(c.empresaId);
    await vincular(foraDoGhe, { empresaId: imgFora.id });
    const inativa = await semearDaEmpresa(c.empresaId);
    const materialInativa = await a.material(c.empresaId, {});
    await a.vincularMaterial(c.empresaId, c.gheId, materialInativa);
    await vincular(materialInativa, { empresaId: inativa.id });
    await a.q("UPDATE imagens_empresa SET estado = 'INATIVA' WHERE id = $1", [inativa.id]);
    const outraEmpresa = await semearDaEmpresa(a.d.empresaB);
    const alvos = [caminhoDaImagem('empresa', '999999999999'), caminhoDaImagem('empresa', inativa.id), caminhoDaImagem('empresa', outraEmpresa.id), caminhoDaImagem('empresa', imgFora.id), caminhoDaImagem('padrao', '999999999999')];
    const respostas = [];
    for (const alvo of alvos) respostas.push(await imagem(c.t.credencial, c.token, alvo));
    for (const r of respostas) assert.deepEqual([r.status, r.body.codigo], NAO_ENCONTRADA, aviso(r));
    const [referencia, ...demais] = respostas;
    // `ratelimit` traz o contador de requisições restantes (r=) e o tempo até a renovação (t=), que mudam a cada resposta; só esses dois números são normalizados.
    // Limite, janela e `ratelimit-policy` seguem comparados literalmente, e a presença do cabeçalho no formato esperado é exigida.
    const comparaveis = (r) => {
      const cabecalhos = cabecalhosComparaveis(r);
      assert.match(String(cabecalhos.ratelimit), /^"[^"]+"; r=\d+; t=\d+(, "[^"]+"; r=\d+; t=\d+)*$/, 'cabeçalho ratelimit presente e no formato esperado');
      return { ...cabecalhos, ratelimit: cabecalhos.ratelimit.replace(/\br=\d+/g, 'r=#').replace(/\bt=\d+/g, 't=#') };
    };
    for (const r of demais) {
      assert.deepEqual(r.body, referencia.body);
      assert.deepEqual(comparaveis(r), comparaveis(referencia));
    }
    assert.ok(String(referencia.headers['cache-control']).includes('no-store'));
  });

  test('TIA-07 — imagem COMPARTILHADA por dois materiais: basta um selecionável; se o único autorizado deixa de ser (vínculo removido), a próxima consulta é 404', async () => {
    const c = await mundo();
    const naoAutorizado = await a.material(c.empresaId, {});
    await vincular(naoAutorizado, { empresaId: c.img.id });
    assert.equal((await imagem(c.t.credencial, c.token, c.rota)).status, 200, 'um material selecionável basta');
    await a.q('DELETE FROM ghe_materiais WHERE empresa_id = $1 AND grupo_homogeneo_id = $2 AND material_id = $3', [c.empresaId, c.gheId, c.materialId]);
    const r = await imagem(c.t.credencial, c.token, c.rota);
    assert.deepEqual([r.status, r.body.codigo], NAO_ENCONTRADA, `o único material autorizado saiu do GHE: ${aviso(r)}`);
  });

  const CASOS_DE_SELECAO = [
    ['controle: vínculo direto', {}, 200],
    ['controle: autorização por tipo ATIVO', { via: 'tipo' }, 200],
    ['controle: exige tamanho COM grade', { exigeTamanho: true, grade: ['M'] }, 200],
    ['material inativo', { ativoMaterial: false }, 404],
    ['autorização só por tipo e o tipo foi inativado', { via: 'tipo', tipoAtivo: false }, 404],
    ['exige tamanho e não tem nenhum tamanho cadastrado', { exigeTamanho: true, grade: [] }, 404],
    ['classificação de tamanho ausente (nula)', { exigeTamanho: null }, 404],
    ['GHE inativo', { gheAtivo: false }, 404],
    ['funcionário sem GHE', { semGhe: true }, 404],
  ];
  for (const [nome, opcoes, esperado] of CASOS_DE_SELECAO) {
    test(`TIA-08 — seleção pelo catálogo (${nome}): ${esperado}`, async () => {
      const c = await mundo(opcoes);
      const noCatalogo = (await catalogoDe(c)).materiais.some((m) => m.id === c.materialId);
      assert.equal(noCatalogo, esperado === 200, 'a imagem só é autorizada se o material está no conjunto que o catálogo devolve');
      const r = await imagem(c.t.credencial, c.token, c.rota);
      if (esperado === 200) assert.equal(r.status, 200, aviso(r));
      else assert.deepEqual([r.status, r.body.codigo], NAO_ENCONTRADA, aviso(r));
    });
  }

  test('TIA-09 — funcionário afastado depois de aberto o atendimento: 401 ATENDIMENTO_INVALIDO (a regra do catálogo vale para a imagem)', async () => {
    const c = await mundo();
    assert.equal((await imagem(c.t.credencial, c.token, c.rota)).status, 200);
    await a.q("UPDATE funcionarios SET situacao = 'AFASTADO' WHERE id = $1", [c.f.id]);
    const r = await imagem(c.t.credencial, c.token, c.rota);
    assert.deepEqual([r.status, r.body.codigo], [401, 'ATENDIMENTO_INVALIDO'], aviso(r));
  });

  test('TIA-10 — a autorização é a ATUAL: trocar o GHE do funcionário, trocar ou inativar a imagem do material entre o catálogo e o GET nega a imagem antiga; a nova passa', async () => {
    const c = await mundo();
    const nova = await semearDaEmpresa(c.empresaId);
    await vincular(c.materialId, { empresaId: nova.id });
    const antiga = await imagem(c.t.credencial, c.token, c.rota);
    assert.deepEqual([antiga.status, antiga.body.codigo], NAO_ENCONTRADA, 'a imagem antiga não está mais vinculada ao material');
    assert.equal((await imagem(c.t.credencial, c.token, caminhoDaImagem('empresa', nova.id))).status, 200);
    await a.q("UPDATE imagens_empresa SET estado = 'INATIVA' WHERE id = $1", [nova.id]);
    assert.deepEqual((await imagem(c.t.credencial, c.token, caminhoDaImagem('empresa', nova.id))).body.codigo, 'IMAGEM_NAO_ENCONTRADA', 'imagem inativada');
    await a.q("UPDATE imagens_empresa SET estado = 'ATIVA' WHERE id = $1", [nova.id]);
    const outroGhe = await a.ghe(c.empresaId);
    await a.q('UPDATE funcionarios SET grupo_homogeneo_id = $2 WHERE id = $1', [c.f.id, outroGhe]);
    const r = await imagem(c.t.credencial, c.token, caminhoDaImagem('empresa', nova.id));
    assert.deepEqual([r.status, r.body.codigo], NAO_ENCONTRADA, `o GHE mudou: ${aviso(r)}`);
  });

  test('TIA-11 — `v` não autoriza nem nega: versão desatualizada ou inventada recebe a mesma resposta autorizada, sem ETag e sem cache', async () => {
    const c = await mundo();
    for (const v of ['1', '2147483647']) {
      const r = await imagem(c.t.credencial, c.token, caminhoDaImagem('empresa', c.img.id, 'miniatura', `?v=${v}`));
      assert.equal(r.status, 200, `v=${v}: ${aviso(r)}`);
      assert.equal(r.headers.etag, undefined);
      assert.ok(String(r.headers['cache-control']).includes('no-store'));
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // Credenciais do tablet, rotação e eventos de segurança
  // ═══════════════════════════════════════════════════════════════════
  async function mundoComTabletAntigo() {
    const c0 = await mundo();
    const t = await a.ativado(c0.empresaId, { horasDesdeEmissao: 25 });
    const f = await a.funcionarioNoGhe(c0.empresaId, c0.gheId);
    const atendimento = await a.atendimentoDireto(t, f.id);
    return { ...c0, t, token: atendimento.token, atendimentoId: atendimento.id };
  }

  test('TIA-12 — rotação preservada nas rotas existentes e carência respeitada na imagem: depois da rotação (em /estado), a credencial ANTERIOR dentro da carência é aceita sem Set-Cookie e sem novo evento; a atual também', async () => {
    const c = await mundoComTabletAntigo();
    const rot = await a.comoTablet(appBase, c.t.credencial).get(`${CAMINHO_TABLET}/estado`);
    assert.equal(rot.status, 200, aviso(rot));
    const nova = cookieDoTabletNaResposta(rot);
    assert.ok(nova, 'a rotação legítima continua acontecendo em /estado');
    const antes = await a.linha(c.t.id);
    const eventosAntes = (await a.todosEventos(c.empresaId)).length;
    const dentro = await imagem(c.t.credencial, c.token, c.rota);
    assert.equal(dentro.status, 200, aviso(dentro));
    assert.equal(cookieDoTabletNaResposta(dentro), null, 'a imagem não emite o cookie do tablet');
    const atual = await imagem(nova.valor, c.token, c.rota);
    assert.equal(atual.status, 200, aviso(atual));
    assert.deepEqual(await a.linha(c.t.id), antes, 'a imagem não altera hashes, emissão nem contadores do dispositivo');
    assert.equal((await a.todosEventos(c.empresaId)).length, eventosAntes, 'uso legítimo não gera evento');
  });

  test('TIA-13 — credencial anterior FORA da carência: 401 uniforme na imagem, evento REUSO_CREDENCIAL como nas demais rotas, sem Set-Cookie, sem revogar, e a credencial atual segue valendo', async () => {
    const c = await mundoComTabletAntigo();
    const rot = await a.comoTablet(appBase, c.t.credencial).get(`${CAMINHO_TABLET}/estado`);
    const nova = cookieDoTabletNaResposta(rot);
    assert.ok(nova, 'rotação esperada');
    await a.q("UPDATE token_dispositivos SET credencial_emitida_em = now() - interval '15 minutes' WHERE id = $1", [c.t.id]);
    const r = await imagem(c.t.credencial, c.token, c.rota);
    assert.deepEqual([r.status, r.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(r));
    assert.equal(cookieDoTabletNaResposta(r), null);
    assert.equal((await a.eventos(c.t.id, 'REUSO_CREDENCIAL')).length, 1, 'o evento de segurança existente é preservado');
    assert.equal((await a.linha(c.t.id)).revogado_em, null, 'não revoga o tablet legítimo');
    assert.equal((await imagem(nova.valor, c.token, c.rota)).status, 200, 'a credencial atual segue valendo');
  });

  test('TIA-14 — rede não autorizada: 403 REDE_NAO_AUTORIZADA na imagem, e UM evento REDE_RECUSADA em 5 tentativas (a supressão existente), sem segredo na resposta', async () => {
    const c = await mundo();
    await a.redes({ A: [], B: [] });
    try {
      for (let i = 0; i < 5; i += 1) {
        const r = await imagem(c.t.credencial, c.token, c.rota);
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
        assert.equal(cookieDoTabletNaResposta(r), null);
      }
      assert.equal((await a.eventos(c.t.id, 'REDE_RECUSADA')).length, 1);
    } finally {
      await a.redes(a.redeDeTeste);
    }
  });

  test('TIA-15 — 20 pedidos de imagem SIMULTÂNEOS com a credencial vigente não escrevem em lugar algum: dispositivo, atendimento e eventos idênticos antes e depois, e todos 200 sem Set-Cookie do tablet', async () => {
    const c = await mundo();
    const eventosAntes = (await a.todosEventos(c.empresaId)).length;
    const dispositivoAntes = await a.linha(c.t.id);
    const atendimentoAntes = await linhaDoAtendimento(c);
    const respostas = await Promise.all(Array.from({ length: 20 }, () => imagem(c.t.credencial, c.token, c.rota)));
    for (const r of respostas) {
      assert.equal(r.status, 200, aviso(r));
      assert.equal(cookieDoTabletNaResposta(r), null);
    }
    assert.deepEqual(await a.linha(c.t.id), dispositivoAntes);
    assert.deepEqual(await linhaDoAtendimento(c), atendimentoAntes);
    assert.equal((await a.todosEventos(c.empresaId)).length, eventosAntes);
  });

  // ═══════════════════════════════════════════════════════════════════
  // Custo da autorização (instrumentação das consultas efetivamente executadas)
  // ═══════════════════════════════════════════════════════════════════
  /**
   * Mede, no pool espião, as consultas da rota de imagem separadas por fase: tudo até o fim de `tabletService.autenticar` é AUTENTICAÇÃO; o que vem depois é a
   * AUTORIZAÇÃO da imagem (mais a leitura do registro). Devolve só o custo da segunda fase e as escritas dela.
   */
  async function custoDaAutorizacao(t, c, caminho) {
    const { espiao, registros } = espiarPool(a.ctx.pool);
    const original = tabletService.autenticar;
    const espiaoDaAutenticacao = t.mock.method(tabletService, 'autenticar', async (...argumentos) => {
      const resultado = await original(...argumentos);
      registros.push({ origem: 'marca', sql: MARCA_FIM_AUTENTICACAO });
      return resultado;
    });
    let r;
    try {
      const app = montarAppImagem({ pool: espiao });
      r = await request(app).get(caminho).set('Cookie', cabecalhoCookie(c.t.credencial, c.token));
    } finally {
      espiaoDaAutenticacao.mock.restore();
    }
    assert.equal(r.status, 200, aviso(r));
    const fim = registros.findIndex((x) => x.sql === MARCA_FIM_AUTENTICACAO);
    assert.ok(fim >= 0, 'a autenticação passou por tabletService.autenticar');
    const autorizacao = registros.slice(fim + 1);
    return { autenticacao: fim, autorizacao: autorizacao.length, escritasNaAutorizacao: autorizacao.filter((x) => ESCRITA_SQL.test(x.sql)).length };
  }

  async function catalogoGrande(n) {
    const empresaId = a.d.empresaA;
    const gheId = await a.ghe(empresaId);
    let ultimo = null;
    for (let i = 0; i < n; i += 1) {
      ultimo = await a.material(empresaId, {});
      await a.vincularMaterial(empresaId, gheId, ultimo);
    }
    const img = await semearDaEmpresa(empresaId);
    await vincular(ultimo, { empresaId: img.id });
    const c = await a.cenario(appBase, { empresaId, gheId });
    assert.equal((await catalogoDe(c)).total, n, `catálogo de ${n} materiais`);
    return { ...c, empresaId, gheId, img, rota: caminhoDaImagem('empresa', img.id) };
  }

  test('TIA-16 — o custo ADICIONAL da autorização é o mesmo com catálogo de 5, 50 e 500 materiais (imagem do último), pequeno e sem escrita; 10 pedidos custam 10 vezes o de um; a autenticação é medida à parte', async (t) => {
    const cenarios = [];
    for (const n of [5, 50, 500]) cenarios.push({ n, c: await catalogoGrande(n) });
    const medidas = [];
    for (const { n, c } of cenarios) medidas.push({ n, ...(await custoDaAutorizacao(t, c, c.rota)) });
    const [m5, m50, m500] = medidas;
    assert.equal(m50.autorizacao, m5.autorizacao, `5 → 50 materiais: ${JSON.stringify(medidas)}`);
    assert.equal(m500.autorizacao, m5.autorizacao, `5 → 500 materiais: ${JSON.stringify(medidas)}`);
    assert.ok(m5.autorizacao >= 1 && m5.autorizacao <= 8, `custo adicional pequeno e limitado (${m5.autorizacao})`);
    assert.equal(medidas.every((m) => m.escritasNaAutorizacao === 0), true, 'a autorização é só leitura');
    assert.equal(medidas.every((m) => m.autenticacao >= 1), true, 'a autenticação existe e é medida separadamente');
  });

  test('TIA-17 — o custo da autorização NÃO cresce com a quantidade de imagens pedidas em sequência (10 pedidos = 10 × o custo de um) nem com o catálogo', async (t) => {
    const c = await catalogoGrande(50);
    const { espiao, registros } = espiarPool(a.ctx.pool);
    const original = tabletService.autenticar;
    t.mock.method(tabletService, 'autenticar', async (...argumentos) => { const x = await original(...argumentos); registros.push({ origem: 'marca', sql: MARCA_FIM_AUTENTICACAO }); return x; });
    const app = montarAppImagem({ pool: espiao });
    const custos = [];
    for (let i = 0; i < 10; i += 1) {
      registros.length = 0;
      const r = await request(app).get(c.rota).set('Cookie', cabecalhoCookie(c.t.credencial, c.token));
      assert.equal(r.status, 200, aviso(r));
      custos.push(registros.length - registros.findIndex((x) => x.sql === MARCA_FIM_AUTENTICACAO) - 1);
    }
    assert.equal(new Set(custos).size, 1, `custo constante por pedido: ${custos.join(',')}`);
  });
});
