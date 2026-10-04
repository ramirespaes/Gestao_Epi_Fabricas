'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { chaveNova } = require('./helpers/solicitacao-epi-servico');

const EpiHttp = require('../../../frontend/js/api-http');
require('../../../frontend/js/permissoes-efetivas');
const EpiSolicitacoesEpi = require('../../../frontend/js/solicitacoes-epi');
const EpiAprovacaoSst = require('../../../frontend/js/aprovacao-sst');

/**
 * 12G-3 — a Aprovação da Segurança do Trabalho do frontend contra o servidor
 * HTTP real e o PostgreSQL real (schema temporário com todas as migrations): a
 * fila e o detalhe trazem o que a tela lê; o corpo que a tela monta
 * (EpiAprovacaoSst.rascunho.validar) é aceito; o resultado previsto pela tela é
 * o que o servidor grava; a separação de funções, a concorrência, a autoridade
 * por ação e o isolamento por empresa são os do servidor. Aprovar não depende de
 * estoque (o mundo do teste não tem lote). A única peça de teste é a sessão.
 */

const S = EpiSolicitacoesEpi;
const A = EpiAprovacaoSst;

describe('12G-3 — Aprovação da SST do frontend contra servidor e PostgreSQL reais', () => {
  let env;
  let servidor;
  let base;
  const u = {};

  before(async () => {
    env = await montarAmbiente12f();
    servidor = http.createServer(env.app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
    const { d } = env;
    u.solicitante = await env.usuarioCom(d.empresaA, { recursos: { request: ['visualizar', 'criar'] } });
    u.sst = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'], sst: true });
    u.sstQuePede = await env.usuarioCom(d.empresaA, {
      perfil: 'ADMINISTRADOR', recursos: { request: ['visualizar', 'criar'] }, acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'], sst: true,
    });
    u.soAprova = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO'], sst: true });
    u.sstB = await env.usuarioCom(d.empresaB, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO'], sst: true });
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (env) await env.encerrar();
  });

  const comoUsuario = (usuarioId) => {
    EpiHttp.configurar({
      baseUrl: `${base}/api`,
      fetch: (url, opcoes = {}) => fetch(url, { ...opcoes, headers: { ...(opcoes.headers || {}), 'x-teste-usuario': String(usuarioId) } }),
    });
  };

  /** Um pedido criado pela tela do Pedido (rota real): botina 40 (no GHE), capacete (no GHE, sem tamanho) e, se pedido, luva (fora do GHE). */
  async function pedido(autor, { comLuva = false } = {}) {
    comoUsuario(autor);
    const itens = [
      { materialId: env.d.botina, tamanho: '40', quantidade: 2, motivo: 'DESGASTE_DANO', justificativa: null },
      { materialId: env.d.capacete, tamanho: null, quantidade: 3, motivo: 'ADMISSAO', justificativa: null },
    ];
    if (comLuva) itens.push({ materialId: env.d.luva, tamanho: 'M', quantidade: 1, motivo: 'OUTRO', justificativa: 'Corte na mão' });
    const r = await S.acoes.criar({
      funcionarioId: env.d.trabalhador, itens, observacao: 'Troca antes da parada', chaveIdempotencia: chaveNova(),
    });
    assert.equal(r.status, 201, JSON.stringify(r));
    return r.dados.solicitacao.id;
  }

  /** O que a tela faz: abre o detalhe, aplica as decisões no rascunho, valida e envia. */
  async function decidirComoATela(id, decisoesPorMaterial, cap = { aprovar: true, reprovar: true }) {
    const detalhe = await S.acoes.detalhe(id);
    assert.equal(detalhe.status, 200, JSON.stringify(detalhe));
    const decisoes = {};
    for (const item of detalhe.dados.itens) decisoes[item.id] = { ...A.rascunho.novaDecisao(item), ...decisoesPorMaterial[item.materialId] };
    const v = A.rascunho.validar(detalhe.dados.itens, decisoes, cap);
    assert.equal(v.ok, true, JSON.stringify(v.erros));
    const previsto = A.rascunho.resultadoPrevisto(detalhe.dados.itens, decisoes);
    return { r: await S.acoes.decidir(id, v.corpo), previsto, corpo: v.corpo, detalhe };
  }

  test('fila e detalhe trazem o que a tela lê; nada de CPF ou e-mail; a origem e o solicitante permitem o aviso de separação de funções', async () => {
    const id = await pedido(u.solicitante, { comLuva: true });
    comoUsuario(u.sst);
    const fila = await S.acoes.fila({ pagina: 1, limite: A.LIMITE_FILA });
    assert.equal(fila.status, 200, JSON.stringify(fila));
    const linha = fila.dados.solicitacoes.find((s) => s.id === id);
    assert.ok(linha, 'o pedido pendente está na fila');
    for (const k of ['numero', 'status', 'criadaEm', 'quantidadeItens', 'solicitanteUsuarioId']) assert.ok(k in linha, k);
    assert.deepEqual([linha.status, linha.funcionario.matricula, linha.quantidades.solicitada, linha.solicitanteUsuarioId], ['PENDENTE', 'T-1', 6, u.solicitante]);
    const detalhe = await S.acoes.detalhe(id);
    const s = detalhe.dados.solicitacao;
    assert.deepEqual([s.origemSolicitacao, s.solicitanteUsuarioId, typeof s.solicitante.nome, s.observacao], ['USUARIO_INTERNO', u.solicitante, 'string', 'Troca antes da parada']);
    for (const k of ['setor', 'funcao', 'matricula', 'nome']) assert.ok(k in s.funcionario, k);
    const porMaterial = Object.fromEntries(detalhe.dados.itens.map((i) => [i.materialId, i]));
    assert.deepEqual([porMaterial[env.d.botina].previstoNoGhe, porMaterial[env.d.capacete].tamanho, porMaterial[env.d.luva].previstoNoGhe], [true, null, false]);
    assert.equal(typeof porMaterial[env.d.luva].material.nome, 'string');
    assert.equal(/"cpf"|"email"/.test(JSON.stringify(detalhe.dados)), false);
    assert.equal(A.rascunho.criadaPor(s, u.sst), false);
  });

  test('aprovação integral sem estoque nenhum: 200 APROVADA, o resultado que a tela previu; o pedido sai da fila; a segunda decisão é 409 com o texto da tela', async () => {
    const id = await pedido(u.solicitante);
    comoUsuario(u.sst);
    const { r, previsto } = await decidirComoATela(id, { [env.d.botina]: { decisao: 'APROVADO' }, [env.d.capacete]: { decisao: 'APROVADO' } });
    assert.deepEqual([r.status, r.dados.solicitacao.status, previsto], [200, 'APROVADA', 'APROVADA']);
    const fila = await S.acoes.fila({ pagina: 1, limite: 100 });
    assert.equal(fila.dados.solicitacoes.some((x) => x.id === id), false);
    const itensDecididos = (await S.acoes.detalhe(id)).dados.itens;
    const denovo = await S.acoes.decidir(id, { decisoes: itensDecididos.map((i) => ({ itemId: i.id, decisao: 'REPROVADO', justificativa: 'x' })) });
    assert.deepEqual([denovo.status, denovo.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
    assert.match(A.TEXTOS[denovo.codigo], /já foi analisada ou cancelada/);
  });

  test('redução com justificativa e reprovação com justificativa (mista): 200 APROVADA_PARCIAL, como a tela previu', async () => {
    const id = await pedido(u.solicitante);
    comoUsuario(u.sst);
    const { r, previsto, corpo } = await decidirComoATela(id, {
      [env.d.botina]: { decisao: 'APROVADO', quantidade: '1', justificativa: 'Um pé só' },
      [env.d.capacete]: { decisao: 'REPROVADO', justificativa: 'Troca recente' },
    });
    assert.deepEqual([r.status, r.dados.solicitacao.status, previsto], [200, 'APROVADA_PARCIAL', 'APROVADA_PARCIAL']);
    assert.deepEqual(corpo.decisoes.map((x) => x.decisao), ['APROVADO', 'REPROVADO']);
  });

  test('tudo aprovado, mas um item reduzido (com justificativa): 200 APROVADA_PARCIAL, como a tela previu', async () => {
    const id = await pedido(u.solicitante);
    comoUsuario(u.sst);
    const { r, previsto } = await decidirComoATela(id, {
      [env.d.botina]: { decisao: 'APROVADO' }, [env.d.capacete]: { decisao: 'APROVADO', quantidade: '2', justificativa: 'Dois bastam' },
    });
    assert.deepEqual([r.status, r.dados.solicitacao.status, previsto], [200, 'APROVADA_PARCIAL', 'APROVADA_PARCIAL']);
  });

  test('tudo reprovado com justificativa: 200 REPROVADA, como a tela previu', async () => {
    const id = await pedido(u.solicitante);
    comoUsuario(u.sst);
    const { r, previsto } = await decidirComoATela(id, {
      [env.d.botina]: { decisao: 'REPROVADO', justificativa: 'Fora da política' }, [env.d.capacete]: { decisao: 'REPROVADO', justificativa: 'Fora da política' },
    });
    assert.deepEqual([r.status, r.dados.solicitacao.status, previsto], [200, 'REPROVADA', 'REPROVADA']);
  });

  test('aprovação fora do GHE: a tela exige a justificativa; sem ela o servidor também recusa no mesmo campo, e a tela traduz o código', async () => {
    const id = await pedido(u.solicitante, { comLuva: true });
    comoUsuario(u.sst);
    const detalhe = await S.acoes.detalhe(id);
    const decisoes = Object.fromEntries(detalhe.dados.itens.map((i) => [i.id, { ...A.rascunho.novaDecisao(i), decisao: 'APROVADO' }]));
    const v = A.rascunho.validar(detalhe.dados.itens, decisoes, { aprovar: true, reprovar: true });
    const luva = detalhe.dados.itens.find((i) => i.materialId === env.d.luva);
    assert.deepEqual(v.erros.map((e) => [e.itemId, e.campo]), [[luva.id, 'justificativa']]);
    const indice = detalhe.dados.itens.indexOf(luva);
    const cru = await S.acoes.decidir(id, { decisoes: detalhe.dados.itens.map((i) => ({ itemId: i.id, decisao: 'APROVADO', quantidadeAprovada: i.quantidade, justificativa: null })) });
    assert.equal(cru.status, 400);
    assert.deepEqual(cru.detalhes.map((x) => [x.campo, x.codigo]), [[`body.decisoes[${indice}].justificativa`, 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA']]);
    assert.match(A.TEXTOS[cru.detalhes[0].codigo], /não estava previsto no GHE/);
  });

  test('quantidade acima da solicitada: a tela recusa antes; o servidor também (no campo da quantidade)', async () => {
    const id = await pedido(u.solicitante);
    comoUsuario(u.sst);
    const detalhe = await S.acoes.detalhe(id);
    const botina = detalhe.dados.itens.find((i) => i.materialId === env.d.botina);
    const decisoes = Object.fromEntries(detalhe.dados.itens.map((i) => [i.id, { ...A.rascunho.novaDecisao(i), decisao: 'APROVADO' }]));
    decisoes[botina.id].quantidade = '9';
    assert.deepEqual(A.rascunho.validar(detalhe.dados.itens, decisoes, { aprovar: true, reprovar: true }).erros.map((e) => e.campo), ['quantidade']);
    const cru = await S.acoes.decidir(id, { decisoes: detalhe.dados.itens.map((i) => ({ itemId: i.id, decisao: 'APROVADO', quantidadeAprovada: i.id === botina.id ? 9 : i.quantidade })) });
    assert.deepEqual([cru.status, cru.detalhes[0].codigo], [400, 'QUANTIDADE_APROVADA_INVALIDA']);
  });

  test('decisão incompleta (a tela nunca envia): o servidor recusa DECISAO_INCOMPLETA', async () => {
    const id = await pedido(u.solicitante);
    comoUsuario(u.sst);
    const detalhe = await S.acoes.detalhe(id);
    const cru = await S.acoes.decidir(id, { decisoes: [{ itemId: detalhe.dados.itens[0].id, decisao: 'APROVADO' }] });
    assert.deepEqual([cru.status, cru.detalhes[0].codigo], [400, 'DECISAO_INCOMPLETA']);
  });

  test('separação de funções: quem criou não decide (403 AUTODECISAO_PROIBIDA), e a tela previu o mesmo pela mesma condição', async () => {
    const id = await pedido(u.sstQuePede);
    comoUsuario(u.sstQuePede);
    const detalhe = await S.acoes.detalhe(id);
    assert.equal(A.rascunho.criadaPor(detalhe.dados.solicitacao, u.sstQuePede), true);
    const r = await S.acoes.decidir(id, { decisoes: detalhe.dados.itens.map((i) => ({ itemId: i.id, decisao: 'APROVADO', quantidadeAprovada: i.quantidade, justificativa: null })) });
    assert.deepEqual([r.status, r.codigo], [403, 'AUTODECISAO_PROIBIDA']);
    assert.match(A.TEXTOS[r.codigo], /outra pessoa da Segurança do Trabalho/);
    comoUsuario(u.sst);
    const outro = await decidirComoATela(id, { [env.d.botina]: { decisao: 'APROVADO' }, [env.d.capacete]: { decisao: 'APROVADO' } });
    assert.equal(outro.r.status, 200, 'outra pessoa da SST decide');
  });

  test('autoridade por ação: só APROVAR não reprova (403 do servidor); a capacidade da tela pelas permissões reais diz o mesmo', async () => {
    const id = await pedido(u.solicitante);
    comoUsuario(u.soAprova);
    const detalhe = await S.acoes.detalhe(id);
    const r = await S.acoes.decidir(id, { decisoes: detalhe.dados.itens.map((i) => ({ itemId: i.id, decisao: 'REPROVADO', justificativa: 'x' })) });
    assert.deepEqual([r.status, r.codigo], [403, 'PERMISSAO_NEGADA']);
    const decisoes = Object.fromEntries(detalhe.dados.itens.map((i) => [i.id, { ...A.rascunho.novaDecisao(i), decisao: 'REPROVADO', justificativa: 'x' }]));
    assert.deepEqual(A.rascunho.validar(detalhe.dados.itens, decisoes, { aprovar: true, reprovar: false }).erros.map((e) => e.campo), ['decisao', 'decisao']);
  });

  test('isolamento por empresa: a SST da outra empresa não vê o pedido na fila e recebe o mesmo 404 do inexistente', async () => {
    const id = await pedido(u.solicitante);
    comoUsuario(u.sstB);
    const fila = await S.acoes.fila({ pagina: 1, limite: 100 });
    assert.equal(fila.dados.solicitacoes.some((x) => x.id === id), false);
    const alheio = await S.acoes.detalhe(id);
    const inexistente = await S.acoes.detalhe(2147483000);
    assert.deepEqual([alheio.status, alheio.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
    assert.deepEqual([alheio.status, alheio.codigo], [inexistente.status, inexistente.codigo]);
    const decisao = await S.acoes.decidir(id, { decisoes: [{ itemId: 1, decisao: 'REPROVADO', justificativa: 'x' }] });
    assert.equal(decisao.status, 404);
  });
});
