'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { inserirUsuario, chaveNova } = require('./helpers/solicitacao-epi-servico');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');

/**
 * Concessão e remoção do vínculo SST pela camada HTTP (12F-2), contra
 * PostgreSQL real, com a regra do serviço da 12B sem nada novo:
 *   POST   /api/vinculos-sst              só o MASTER ativo da própria empresa;
 *   DELETE /api/vinculos-sst/:usuarioId   idem.
 * Quem não tem autoridade recebe o mesmo 403; o usuário de outra empresa é "não
 * encontrado", igual ao inexistente. O vínculo não concede ação nenhuma:
 * ENCERRAR_SOLICITACAO continua individual e obrigatória.
 */

const ID_INEXISTENTE = 2147483000;
const URL = '/api/vinculos-sst';

describe('vínculo SST HTTP — concessão e remoção (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};
  let sequencia = 0;

  const q = (sql, params) => pool.query(sql, params);
  const resposta = (r) => ({ status: r.status, corpo: r.body });
  const vinculo = async (usuarioId) => (await q('SELECT empresa_id, usuario_id, concedido_por, motivo FROM vinculo_sst WHERE usuario_id = $1', [usuarioId])).rows[0] ?? null;
  const auditorias = async (acao, referencia) => (await q(
    'SELECT empresa_id, usuario_id, contexto FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id', [acao, String(referencia)],
  )).rows;
  const novoUsuario = async (empresaId, perfil = 'USUARIO', opcoes = {}) => {
    sequencia += 1;
    return inserirUsuario(pool, empresaId, `alvo-vinculo-${sequencia}@example.invalid`, perfil, opcoes);
  };

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    u.sst = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO'], sst: true });
    u.comum = await env.usuarioCom(d.empresaA);
  });

  after(async () => { if (env) await env.encerrar(); });

  test('MASTER ativo concede: 201 com o vínculo; quem concedeu é o MASTER da sessão; auditoria na empresa da sessão', async () => {
    const alvo = await novoUsuario(d.empresaA, 'ADMINISTRADOR');
    const r = await como(d.master).post(URL, { usuarioId: alvo, motivo: '  Técnico de segurança do trabalho  ' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.status, r.body.vinculo.usuarioId, r.body.vinculo.concedidoPor, r.body.vinculo.motivo], ['ok', alvo, d.master, 'Técnico de segurança do trabalho']);
    assert.deepEqual(await vinculo(alvo), { empresa_id: d.empresaA, usuario_id: alvo, concedido_por: d.master, motivo: 'Técnico de segurança do trabalho' });
    const [registro] = await auditorias('VINCULO_SST_ADICIONADO', alvo);
    assert.deepEqual([registro.empresa_id, registro.usuario_id, registro.contexto.usuarioId, registro.contexto.comMotivo], [d.empresaA, d.master, alvo, true]);
    // Fechamento 12E+12F: o motivo fica só no vínculo; a auditoria não leva o texto, em coluna nenhuma.
    const { rows: [completo] } = await q("SELECT * FROM logs_auditoria WHERE acao = 'VINCULO_SST_ADICIONADO' AND referencia = $1", [String(alvo)]);
    assert.equal(completo.descricao, null);
    assert.equal(JSON.stringify(completo).includes('Técnico de segurança do trabalho'), false);
  });

  test('o vínculo não concede ação: o integrante novo não encerra (ENCERRAR_SOLICITACAO continua individual e obrigatória) nem decide; nenhuma autorização individual nasce', async () => {
    const alvo = await novoUsuario(d.empresaA, 'ADMINISTRADOR');
    assert.equal((await como(d.master).post(URL, { usuarioId: alvo })).status, 201);
    const m = await f.material();
    const aprovada = await f.aprovada({ materialId: m, quantidade: 1 });
    const encerrar = await como(alvo).post(`/api/solicitacoes-epi/${aprovada.id}/encerramento`, { justificativa: 'Sem necessidade' });
    assert.deepEqual([encerrar.status, encerrar.body.codigo], [403, 'PERMISSAO_NEGADA']);
    const pendente = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador, itens: [{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
    });
    const decidir = await como(alvo).post(`/api/solicitacoes-epi/${pendente.solicitacao.id}/decisao`, { decisoes: [{ itemId: pendente.itens[0].id, decisao: 'APROVADO' }] });
    assert.deepEqual([decidir.status, decidir.body.codigo], [403, 'PERMISSAO_NEGADA']);
    assert.equal((await q('SELECT count(*)::int AS n FROM usuario_autorizacoes WHERE usuario_id = $1', [alvo])).rows[0].n, 0);
    const doMaster = await como(d.master).post(`/api/solicitacoes-epi/${aprovada.id}/encerramento`, { justificativa: 'Sem necessidade' });
    assert.deepEqual([doMaster.status, doMaster.body.codigo], [403, 'PERMISSAO_NEGADA'], 'o MASTER também não recebe ENCERRAR_SOLICITACAO por padrão');
  });

  test('não MASTER (SST, administrador, usuário comum): o mesmo 403 SEM_AUTORIDADE_VINCULO_SST na concessão e na remoção; nada muda', async () => {
    const alvo = await novoUsuario(d.empresaA);
    const comVinculo = await novoUsuario(d.empresaA);
    await como(d.master).post(URL, { usuarioId: comVinculo });
    const respostas = [];
    for (const ator of [u.sst, d.sst1, u.comum]) {
      respostas.push(resposta(await como(ator).post(URL, { usuarioId: alvo })));
      respostas.push(resposta(await como(ator).delete(`${URL}/${comVinculo}`)));
    }
    assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'SEM_AUTORIDADE_VINCULO_SST']);
    for (const r of respostas) assert.deepEqual(r, respostas[0]);
    assert.equal(await vinculo(alvo), null);
    assert.notEqual(await vinculo(comVinculo), null);
    assert.equal((await env.anonimo.post(URL, { usuarioId: alvo })).status, 401);
    assert.equal((await env.anonimo.delete(`${URL}/${comVinculo}`)).status, 401);
  });

  test('outra empresa: o MASTER da A conceder a usuário da B é o mesmo 404 do inexistente; remover o vínculo de usuário da B também; o vínculo da B continua', async () => {
    const daB = await novoUsuario(d.empresaB);
    const comVinculoB = await novoUsuario(d.empresaB);
    assert.equal((await como(d.masterB).post(URL, { usuarioId: comVinculoB })).status, 201);

    const inexistente = resposta(await como(d.master).post(URL, { usuarioId: ID_INEXISTENTE }));
    const cruzada = resposta(await como(d.master).post(URL, { usuarioId: daB }));
    assert.deepEqual([inexistente.status, inexistente.corpo.codigo], [404, 'USUARIO_NAO_ENCONTRADO']);
    assert.deepEqual(cruzada, inexistente);
    assert.equal(await vinculo(daB), null);

    const removerInexistente = resposta(await como(d.master).delete(`${URL}/${ID_INEXISTENTE}`));
    const removerCruzado = resposta(await como(d.master).delete(`${URL}/${comVinculoB}`));
    assert.deepEqual([removerInexistente.status, removerInexistente.corpo.codigo], [404, 'VINCULO_SST_NAO_ENCONTRADO']);
    assert.deepEqual(removerCruzado, removerInexistente);
    assert.deepEqual(await vinculo(comVinculoB), { empresa_id: d.empresaB, usuario_id: comVinculoB, concedido_por: d.masterB, motivo: null });
    assert.deepEqual(await auditorias('VINCULO_SST_REMOVIDO', comVinculoB), []);
  });

  test('remoção: 200; o vínculo some e a auditoria registra; o ex-integrante perde a fila da SST pela autorização central', async () => {
    const alvo = await env.usuarioCom(d.empresaA, { perfil: 'ADMINISTRADOR', acoes: ['APROVAR_SOLICITACAO'] });
    assert.equal((await como(d.master).post(URL, { usuarioId: alvo })).status, 201);
    assert.equal((await como(alvo).get('/api/solicitacoes-epi/fila')).status, 200);
    const r = await como(d.master).delete(`${URL}/${alvo}`);
    assert.deepEqual([r.status, r.body], [200, { status: 'ok', usuarioId: alvo }]);
    assert.equal(await vinculo(alvo), null);
    assert.deepEqual((await auditorias('VINCULO_SST_REMOVIDO', alvo)).map((x) => x.usuario_id), [d.master]);
    const fila = await como(alvo).get('/api/solicitacoes-epi/fila');
    assert.deepEqual([fila.status, fila.body.codigo], [403, 'PERMISSAO_NEGADA']);
  });

  test('repetição: conceder de novo é 409 VINCULO_SST_JA_EXISTE; remover de novo é 404 VINCULO_SST_NAO_ENCONTRADO; uma auditoria de cada', async () => {
    const alvo = await novoUsuario(d.empresaA);
    assert.equal((await como(d.master).post(URL, { usuarioId: alvo })).status, 201);
    const outraVez = await como(d.master2).post(URL, { usuarioId: alvo });
    assert.deepEqual([outraVez.status, outraVez.body.codigo], [409, 'VINCULO_SST_JA_EXISTE']);
    assert.equal((await como(d.master).delete(`${URL}/${alvo}`)).status, 200);
    const removerOutraVez = await como(d.master).delete(`${URL}/${alvo}`);
    assert.deepEqual([removerOutraVez.status, removerOutraVez.body.codigo], [404, 'VINCULO_SST_NAO_ENCONTRADO']);
    assert.equal((await auditorias('VINCULO_SST_ADICIONADO', alvo)).length, 1);
    assert.equal((await auditorias('VINCULO_SST_REMOVIDO', alvo)).length, 1);
  });

  test('regras do alvo preservadas: o MASTER não é alvo (409 VINCULO_SST_NAO_SE_APLICA_AO_MASTER); usuário inativo não recebe (409 USUARIO_INATIVO)', async () => {
    const masterAlvo = await como(d.master).post(URL, { usuarioId: d.master2 });
    assert.deepEqual([masterAlvo.status, masterAlvo.body.codigo], [409, 'VINCULO_SST_NAO_SE_APLICA_AO_MASTER']);
    const inativo = await como(d.master).post(URL, { usuarioId: d.usuarioInativo });
    assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'USUARIO_INATIVO']);
    assert.deepEqual([await vinculo(d.master2), await vinculo(d.usuarioInativo)], [null, null]);
  });

  test('corpo com empresa, quem concede ou perfil, usuário malformado e caminho inválido: 400 sem gravar', async () => {
    const alvo = await novoUsuario(d.empresaA);
    for (const corpo of [{ usuarioId: alvo, empresaId: d.empresaB }, { usuarioId: alvo, concedidoPor: d.master2 }, { usuarioId: alvo, perfil: 'MASTER' }, { usuarioId: String(alvo) }, {}]) {
      const r = await como(d.master).post(URL, corpo);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
    }
    for (const caminho of ['abc', '0', '07']) {
      const r = await como(d.master).delete(`${URL}/${caminho}`);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], caminho);
    }
    assert.equal(await vinculo(alvo), null);
  });
});
