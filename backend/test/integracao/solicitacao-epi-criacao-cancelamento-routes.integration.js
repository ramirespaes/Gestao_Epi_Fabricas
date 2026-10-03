'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { vincularMaterialAoGhe, chaveNova } = require('./helpers/solicitacao-epi-servico');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');

/**
 * Criação e cancelamento da solicitação de EPI pela camada HTTP (12F-2), contra
 * PostgreSQL real, com as rotas, autorizações, schemas e serviços de produção:
 *   POST /api/solicitacoes-epi                    recurso `request`, criar;
 *   POST /api/solicitacoes-epi/:id/cancelamento   recurso `request`, editar
 *                                                 (e o domínio: só o próprio
 *                                                 solicitante, só PENDENTE).
 * Empresa e solicitante saem só da sessão; o que o cliente tenta mandar no lugar
 * deles é recusado. A criação é atômica e não reserva estoque (Modelo A). Outra
 * empresa recebe o mesmo 404 da solicitação inexistente.
 */

const TEXTO_LIVRE = 'Observação livre do solicitante que a auditoria não guarda';
const ID_INEXISTENTE = 2147483000;
const URL = '/api/solicitacoes-epi';
const cancelamento = (id) => `${URL}/${id}/cancelamento`;

describe('criação e cancelamento HTTP da solicitação de EPI (PostgreSQL real)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};

  const q = (sql, params) => pool.query(sql, params);
  const resposta = (r) => ({ status: r.status, corpo: r.body });
  const cpfs = async () => (await q('SELECT cpf FROM funcionarios')).rows.map((l) => l.cpf);
  const semCpf = async (texto, rotulo) => { for (const cpf of await cpfs()) assert.equal(texto.includes(cpf), false, `CPF em ${rotulo}`); };
  const linha = async (id) => (await q(
    `SELECT empresa_id, status, origem_solicitacao, solicitante_usuario_id, cancelada_por, justificativa_cancelamento, numero
       FROM solicitacoes_epi WHERE id = $1`, [id],
  )).rows[0];
  const contagens = async (empresaId) => (await q(
    `SELECT (SELECT count(*)::int FROM solicitacoes_epi WHERE empresa_id = $1) AS solicitacoes,
            (SELECT count(*)::int FROM solicitacoes_epi_itens WHERE empresa_id = $1) AS itens,
            (SELECT count(*)::int FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'SOLICITACAO_EPI_CRIADA') AS auditorias,
            (SELECT COALESCE(max(numero), 0)::int FROM solicitacoes_epi WHERE empresa_id = $1) AS "ultimoNumero"`, [empresaId],
  )).rows[0];
  const auditorias = async (acao, referencia) => (await q(
    'SELECT usuario_id, referencia, descricao, ip, dispositivo, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id',
    [acao, String(referencia)],
  )).rows;
  const item = (materialId, extra = {}) => ({
    materialId, tamanho: '40', quantidade: 2, motivo: 'ADMISSAO', ...extra,
  });
  const corpo = (itens, extra = {}) => ({
    funcionarioId: d.trabalhador, itens, chaveIdempotencia: chaveNova(), ...extra,
  });
  const criarPeloServico = async (atorId, materialId, { empresaId = d.empresaA, funcionarioId = d.trabalhador, quantidade = 2 } = {}) => solicitacaoSvc.criarSolicitacao(pool, {
    empresaId, atorId, funcionarioId, itens: [{ materialId, tamanho: '40', quantidade, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
  });
  const aprovarPeloServico = (criada, { empresaId = d.empresaA, decisor = d.sst1 } = {}) => solicitacaoSvc.decidirSolicitacao(pool, {
    empresaId, atorId: decisor, solicitacaoId: criada.solicitacao.id, decisoes: criada.itens.map((i) => ({ itemId: i.id, decisao: 'APROVADO' })), hoje: f.HOJE,
  });

  before(async () => {
    env = await montarAmbiente12f();
    ({ pool, d, f, como } = env);
    const A = d.empresaA;
    const B = d.empresaB;
    u.solicitante = await env.usuarioCom(A, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    u.outroSolicitante = await env.usuarioCom(A, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    u.soCria = await env.usuarioCom(A, { recursos: { request: ['criar'] } });
    u.soVe = await env.usuarioCom(A, { recursos: { request: ['visualizar'] } });
    u.soEdita = await env.usuarioCom(A, { recursos: { request: ['editar'] } });
    u.semNada = await env.usuarioCom(A);
    u.solicitanteB = await env.usuarioCom(B, { recursos: { request: ['visualizar', 'criar', 'editar'] } });
    await vincularMaterialAoGhe(pool, B, d.gheB, d.botinaB);
  });

  after(async () => { if (env) await env.encerrar(); });

  describe('POST /solicitacoes-epi — criação', () => {
    test('201: dois itens (com e sem tamanho), empresa e solicitante da sessão, PENDENTE, sem CPF nem números de estoque; auditoria do ator da sessão sem o texto livre', async () => {
      const m = await f.material();
      const pedido = corpo([item(m, { tamanho: '41' }), item(d.capacete, { tamanho: null, quantidade: 1, motivo: 'DESGASTE_DANO' })], { observacao: TEXTO_LIVRE });
      const r = await como(u.solicitante).post(URL, pedido).set('User-Agent', 'Navegador da 12F-2');
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.status, r.body.repetida, r.body.solicitacao.status], ['ok', false, 'PENDENTE']);
      assert.deepEqual([r.body.solicitacao.solicitanteUsuarioId, r.body.solicitacao.funcionarioId, r.body.solicitacao.quantidadeItens], [u.solicitante, d.trabalhador, 2]);
      const itens = [...r.body.itens].sort((a, b) => a.materialId - b.materialId);
      assert.deepEqual(itens.map((i) => [i.materialId, i.tamanho, i.quantidade, i.motivo, i.decisao]), [
        [d.capacete, null, 1, 'DESGASTE_DANO', null], [m, '41', 2, 'ADMISSAO', null],
      ].sort((a, b) => a[0] - b[0]));
      assert.ok(r.body.itens.every((i) => !('cobertura' in i) && !('posicao' in i)), 'quem pede não vê números de estoque');
      await semCpf(JSON.stringify(r.body), 'resposta da criação');
      for (const proibido of ['chave', 'requisicaoHash', 'empresaId']) assert.equal(JSON.stringify(r.body).includes(`"${proibido}"`), false, proibido);

      const gravada = await linha(r.body.solicitacao.id);
      assert.deepEqual([gravada.empresa_id, gravada.status, gravada.origem_solicitacao, gravada.solicitante_usuario_id], [d.empresaA, 'PENDENTE', 'USUARIO_INTERNO', u.solicitante]);
      const [registro] = await auditorias('SOLICITACAO_EPI_CRIADA', r.body.solicitacao.id);
      assert.deepEqual([registro.usuario_id, registro.dispositivo, registro.descricao], [u.solicitante, 'Navegador da 12F-2', null]);
      assert.equal(registro.contexto.temObservacao, true);
      assert.equal(JSON.stringify(registro).includes(TEXTO_LIVRE), false, 'a observação não vai para a auditoria');
    });

    test('limite de itens: 20 é aceito; 21 é 400 e nada é gravado', async () => {
      const m = await f.material();
      const itens = (n) => Array.from({ length: n }, (_, i) => item(m, { tamanho: String(30 + i), quantidade: 1 }));
      const antes = await contagens(d.empresaA);
      const r21 = await como(u.solicitante).post(URL, corpo(itens(21)));
      assert.deepEqual([r21.status, r21.body.codigo], [400, 'VALIDACAO']);
      assert.deepEqual(await contagens(d.empresaA), antes);
      const r20 = await como(u.solicitante).post(URL, corpo(itens(20)));
      assert.equal(r20.status, 201, JSON.stringify(r20.body));
      assert.deepEqual([r20.body.itens.length, r20.body.solicitacao.quantidadeItens], [20, 20]);
    });

    test('empresa da sessão: o usuário da B não alcança trabalhador nem material da A (404), e nada é gravado em nenhuma das duas', async () => {
      const antesA = await contagens(d.empresaA);
      const antesB = await contagens(d.empresaB);
      const trabalhadorDaA = await como(u.solicitanteB).post(URL, corpo([item(d.botinaB)], { funcionarioId: d.trabalhador }));
      assert.deepEqual([trabalhadorDaA.status, trabalhadorDaA.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      const materialDaA = await como(u.solicitanteB).post(URL, corpo([item(d.botina)], { funcionarioId: d.trabalhadorB }));
      assert.deepEqual([materialDaA.status, materialDaA.body.codigo], [404, 'MATERIAL_NAO_ENCONTRADO']);
      assert.deepEqual([await contagens(d.empresaA), await contagens(d.empresaB)], [antesA, antesB]);
      const daB = await como(u.solicitanteB).post(URL, corpo([item(d.botinaB)], { funcionarioId: d.trabalhadorB }));
      assert.equal(daB.status, 201, JSON.stringify(daB.body));
      assert.equal((await linha(daB.body.solicitacao.id)).empresa_id, d.empresaB, 'a empresa é a da sessão');
    });

    test('injetar empresaId, solicitanteUsuarioId, atorId ou campos do servidor (no corpo ou no item): 400 CAMPO_NAO_PERMITIDO e nada gravado', async () => {
      const m = await f.material();
      const antes = await contagens(d.empresaA);
      const tentativas = [
        corpo([item(m)], { empresaId: d.empresaB }),
        corpo([item(m)], { solicitanteUsuarioId: u.outroSolicitante }),
        corpo([item(m)], { atorId: u.outroSolicitante }),
        corpo([item(m)], { status: 'APROVADA' }),
        corpo([item(m, { empresaId: d.empresaB })]),
        corpo([item(m, { previstoNoGhe: true })]),
      ];
      for (const tentativa of tentativas) {
        const r = await como(u.solicitante).post(URL, tentativa);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(tentativa));
        assert.ok(r.body.detalhes.some((x) => x.codigo === 'CAMPO_NAO_PERMITIDO'), JSON.stringify(r.body.detalhes));
      }
      assert.deepEqual(await contagens(d.empresaA), antes);
    });

    test('atomicidade: um item inválido no fim (material inativo ou de outra empresa) desfaz tudo — sem solicitação, itens, auditoria nem número consumido', async () => {
      const m = await f.material();
      const antes = await contagens(d.empresaA);
      const inativo = await como(u.solicitante).post(URL, corpo([item(m), item(d.inativo)]));
      assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'MATERIAL_INATIVO']);
      const deOutraEmpresa = await como(u.solicitante).post(URL, corpo([item(m), item(d.botinaB)]));
      assert.deepEqual([deOutraEmpresa.status, deOutraEmpresa.body.codigo], [404, 'MATERIAL_NAO_ENCONTRADO']);
      assert.deepEqual(await contagens(d.empresaA), antes);
      const valida = await como(u.solicitante).post(URL, corpo([item(m)]));
      assert.equal(valida.status, 201);
      assert.equal(valida.body.solicitacao.numero, antes.ultimoNumero + 1, 'a numeração não pulou');
    });

    test('tamanho conforme o material: sem tamanho onde é exigido e com tamanho onde não se aplica são 400, sem gravar', async () => {
      const m = await f.material();
      const antes = await contagens(d.empresaA);
      const semTamanho = await como(u.solicitante).post(URL, corpo([item(m, { tamanho: null })]));
      assert.ok(semTamanho.body.detalhes.some((x) => x.codigo === 'TAMANHO_OBRIGATORIO'), JSON.stringify(semTamanho.body));
      const comTamanho = await como(u.solicitante).post(URL, corpo([item(d.capacete, { tamanho: 'M' })]));
      assert.ok(comTamanho.body.detalhes.some((x) => x.codigo === 'TAMANHO_NAO_SE_APLICA'), JSON.stringify(comTamanho.body));
      assert.deepEqual([semTamanho.status, comTamanho.status], [400, 400]);
      assert.deepEqual(await contagens(d.empresaA), antes);
    });

    test('GHE: o EPI fora do GHE é pedido sem justificativa técnica do solicitante (previsto = false); justificativaForaGhe no item é recusada', async () => {
      const foraDoGhe = await f.material({ previsto: false });
      const r = await como(u.solicitante).post(URL, corpo([item(foraDoGhe)]));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.itens[0].previstoNoGhe, r.body.itens[0].justificativa, r.body.itens[0].justificativaDecisao], [false, null, null]);
      const comJustificativaTecnica = await como(u.solicitante).post(URL, corpo([item(foraDoGhe, { justificativaForaGhe: 'Risco químico' })]));
      assert.deepEqual([comJustificativaTecnica.status, comJustificativaTecnica.body.codigo], [400, 'VALIDACAO']);
    });

    test('sem request.criar (só visualizar, só editar ou nada): o mesmo 403 PERMISSAO_NEGADA, e nada gravado', async () => {
      const m = await f.material();
      const antes = await contagens(d.empresaA);
      const respostas = [];
      for (const usuario of [u.soVe, u.soEdita, u.semNada]) respostas.push(resposta(await como(usuario).post(URL, corpo([item(m)]))));
      assert.deepEqual([respostas[0].status, respostas[0].corpo.codigo], [403, 'PERMISSAO_NEGADA']);
      for (const r of respostas) assert.deepEqual(r, respostas[0]);
      assert.deepEqual(await contagens(d.empresaA), antes);
      assert.equal((await env.anonimo.post(URL, corpo([item(m)]))).status, 401);
    });

    test('repetição: a mesma chave e o mesmo corpo devolvem 200 com a mesma solicitação (já aprovada, ainda sem números de estoque); outro corpo ou outro solicitante com a chave é 409', async () => {
      const m = await f.material();
      await f.estoque(m, 5);
      const pedido = corpo([item(m)]);
      const primeira = await como(u.solicitante).post(URL, pedido);
      assert.equal(primeira.status, 201);
      await aprovarPeloServico({ solicitacao: primeira.body.solicitacao, itens: primeira.body.itens });
      const repetida = await como(u.solicitante).post(URL, pedido);
      assert.deepEqual([repetida.status, repetida.body.repetida, repetida.body.solicitacao.id, repetida.body.solicitacao.status], [200, true, primeira.body.solicitacao.id, 'APROVADA']);
      assert.ok(repetida.body.itens.every((i) => !('cobertura' in i) && !('posicao' in i)));
      const outroCorpo = await como(u.solicitante).post(URL, { ...pedido, itens: [item(m, { quantidade: 3 })] });
      assert.deepEqual([outroCorpo.status, outroCorpo.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO']);
      const outroSolicitante = await como(u.outroSolicitante).post(URL, pedido);
      assert.deepEqual([outroSolicitante.status, outroSolicitante.body.codigo], [409, 'IDEMPOTENCIA_CONFLITO'], 'a chave alheia nunca devolve a solicitação de outro');
      assert.equal((await q('SELECT count(*)::int AS n FROM solicitacoes_epi WHERE id = $1', [primeira.body.solicitacao.id])).rows[0].n, 1);
    });

    test('Modelo A: criar não reserva nada — a posição do par não muda', async () => {
      const m = await f.material();
      await f.estoque(m, 3);
      const antes = f.numeros(await f.posicao(m));
      const r = await como(u.solicitante).post(URL, corpo([item(m, { quantidade: 3 })]));
      assert.equal(r.status, 201);
      assert.deepEqual(f.numeros(await f.posicao(m)), antes);
    });
  });

  describe('POST /solicitacoes-epi/:id/cancelamento — cancelamento', () => {
    test('200: o próprio solicitante com request.editar cancela a PENDENTE; quem cancelou é o da sessão; auditoria do ator da sessão', async () => {
      const criada = await criarPeloServico(u.solicitante, await f.material());
      const r = await como(u.solicitante).post(cancelamento(criada.solicitacao.id), { justificativa: 'Pedido em duplicidade' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.status, r.body.solicitacao.status, r.body.solicitacao.cancelamento.canceladaPor], ['ok', 'CANCELADA', u.solicitante]);
      assert.ok(r.body.itens.every((i) => !('cobertura' in i) && !('posicao' in i)));
      const gravada = await linha(criada.solicitacao.id);
      assert.deepEqual([gravada.status, gravada.cancelada_por, gravada.justificativa_cancelamento], ['CANCELADA', u.solicitante, 'Pedido em duplicidade']);
      const registros = await auditorias('SOLICITACAO_EPI_CANCELADA', criada.solicitacao.id);
      assert.deepEqual(registros.map((x) => [x.usuario_id, x.dados_anteriores.status, x.dados_novos.status]), [[u.solicitante, 'PENDENTE', 'CANCELADA']]);
      // Fechamento 12E+12F: a auditoria diz que houve justificativa, sem o texto.
      assert.deepEqual([registros[0].descricao, registros[0].contexto.comJustificativa], [null, true]);
      assert.equal(JSON.stringify(registros).includes('Pedido em duplicidade'), false, 'o texto livre não vai para a auditoria');
    });

    test('sem justificativa também cancela (corpo vazio)', async () => {
      const criada = await criarPeloServico(u.solicitante, await f.material());
      const r = await como(u.solicitante).post(cancelamento(criada.solicitacao.id), {});
      assert.deepEqual([r.status, r.body.solicitacao.status], [200, 'CANCELADA']);
    });

    test('sem request.editar: quem só cria não cancela nem a própria (403 PERMISSAO_NEGADA); continua PENDENTE', async () => {
      const criada = await criarPeloServico(u.soCria, await f.material());
      const r = await como(u.soCria).post(cancelamento(criada.solicitacao.id), {});
      assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA']);
      assert.equal((await linha(criada.solicitacao.id)).status, 'PENDENTE');
      assert.deepEqual(await auditorias('SOLICITACAO_EPI_CANCELADA', criada.solicitacao.id), []);
    });

    test('anti-enumeração (fechamento 12E+12F): A) inexistente, B) de outro usuário da mesma empresa e C) de outra empresa dão exatamente o mesmo 404 e o mesmo corpo; nada muda', async () => {
      const deOutroUsuario = await criarPeloServico(u.solicitante, await f.material());
      const deOutraEmpresa = await criarPeloServico(u.solicitanteB, d.botinaB, { empresaId: d.empresaB, funcionarioId: d.trabalhadorB });
      const a = await como(u.outroSolicitante).post(cancelamento(ID_INEXISTENTE), {});
      const b = await como(u.outroSolicitante).post(cancelamento(deOutroUsuario.solicitacao.id), {});
      const c = await como(u.outroSolicitante).post(cancelamento(deOutraEmpresa.solicitacao.id), {});
      assert.deepEqual(resposta(a), { status: 404, corpo: { status: 'error', codigo: 'SOLICITACAO_NAO_ENCONTRADA', message: 'Solicitação não encontrada' } });
      assert.deepEqual(resposta(b), resposta(a), 'B igual a A');
      assert.deepEqual(resposta(c), resposta(a), 'C igual a A');
      assert.deepEqual([a.headers['content-type'], b.headers['content-type'], c.headers['content-type']], Array(3).fill(a.headers['content-type']));
      assert.deepEqual([(await linha(deOutroUsuario.solicitacao.id)).status, (await linha(deOutraEmpresa.solicitacao.id)).status], ['PENDENTE', 'PENDENTE']);
      assert.deepEqual(await auditorias('SOLICITACAO_EPI_CANCELADA', deOutroUsuario.solicitacao.id), []);
    });

    test('a própria não cancelável continua 409 do domínio, e sem request.editar continua o 403 da autorização central antes do domínio', async () => {
      const aprovada = await criarPeloServico(u.solicitante, await f.material());
      await aprovarPeloServico(aprovada);
      const naoCancelavel = await como(u.solicitante).post(cancelamento(aprovada.solicitacao.id), {});
      assert.deepEqual([naoCancelavel.status, naoCancelavel.body.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      const deOutro = await criarPeloServico(u.solicitante, await f.material());
      for (const id of [deOutro.solicitacao.id, ID_INEXISTENTE]) {
        const semEditar = await como(u.soCria).post(cancelamento(id), {});
        assert.deepEqual([semEditar.status, semEditar.body.codigo], [403, 'PERMISSAO_NEGADA'], `id ${id}`);
      }
    });

    test('outra empresa: cancelar a da outra é o mesmo 404 da inexistente (corpo idêntico), nos dois sentidos; nada muda', async () => {
      const daA = await criarPeloServico(u.solicitante, await f.material());
      const daB = await criarPeloServico(u.solicitanteB, d.botinaB, { empresaId: d.empresaB, funcionarioId: d.trabalhadorB });
      const inexistenteA = resposta(await como(u.solicitante).post(cancelamento(ID_INEXISTENTE), {}));
      const cruzadaA = resposta(await como(u.solicitante).post(cancelamento(daB.solicitacao.id), {}));
      assert.deepEqual([inexistenteA.status, inexistenteA.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(cruzadaA, inexistenteA);
      const inexistenteB = resposta(await como(u.solicitanteB).post(cancelamento(ID_INEXISTENTE), {}));
      const cruzadaB = resposta(await como(u.solicitanteB).post(cancelamento(daA.solicitacao.id), {}));
      assert.deepEqual([inexistenteB.status, inexistenteB.corpo.codigo], [404, 'SOLICITACAO_NAO_ENCONTRADA']);
      assert.deepEqual(cruzadaB, inexistenteB);
      assert.deepEqual([(await linha(daA.solicitacao.id)).status, (await linha(daB.solicitacao.id)).status], ['PENDENTE', 'PENDENTE']);
    });

    test('estado inválido e repetição: APROVADA é 409 SOLICITACAO_NAO_PENDENTE; cancelar duas vezes, a segunda é 409; uma auditoria só', async () => {
      const aprovada = await criarPeloServico(u.solicitante, await f.material());
      await aprovarPeloServico(aprovada);
      const r = await como(u.solicitante).post(cancelamento(aprovada.solicitacao.id), {});
      assert.deepEqual([r.status, r.body.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      assert.equal((await linha(aprovada.solicitacao.id)).status, 'APROVADA');

      const criada = await criarPeloServico(u.solicitante, await f.material());
      assert.equal((await como(u.solicitante).post(cancelamento(criada.solicitacao.id), {})).status, 200);
      const segunda = await como(u.solicitante).post(cancelamento(criada.solicitacao.id), {});
      assert.deepEqual([segunda.status, segunda.body.codigo], [409, 'SOLICITACAO_NAO_PENDENTE']);
      assert.equal((await auditorias('SOLICITACAO_EPI_CANCELADA', criada.solicitacao.id)).length, 1);
    });

    test('corpo com quem cancela, empresa ou status: 400; justificativa só com espaços: 400; id inválido: 400; nada muda', async () => {
      const criada = await criarPeloServico(u.solicitante, await f.material());
      for (const extra of [{ canceladaPor: u.outroSolicitante }, { empresaId: d.empresaB }, { status: 'CANCELADA' }, { justificativa: '   ' }]) {
        const r = await como(u.solicitante).post(cancelamento(criada.solicitacao.id), extra);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(extra));
      }
      const idInvalido = await como(u.solicitante).post(cancelamento('abc'), {});
      assert.deepEqual([idInvalido.status, idInvalido.body.codigo], [400, 'VALIDACAO']);
      assert.equal((await linha(criada.solicitacao.id)).status, 'PENDENTE');
    });
  });
});
