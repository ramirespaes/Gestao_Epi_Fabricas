'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');
const { STATUS: STATUS_DO_BACKEND } = require('../../backend/src/repositories/solicitacao-epi-consulta.repository');
const { SITUACOES: SITUACOES_DO_BACKEND } = require('../../backend/src/services/solicitacao-epi-situacao');

/**
 * 12G-1 — contratos do frontend com a solicitação de EPI (rotas da 12F e da
 * 12G-0), com `fetch` injetado: caminhos, consulta estrita (o que o servidor
 * aceita, nada além), nenhum campo de autoridade, a mesma mensagem para todo
 * "não encontrada" e as capacidades vindas só das permissões reais. A prova
 * contra o servidor real está em
 * backend/test/integracao/frontend-12g1-contrato.integration.js.
 */

const BASE = 'http://localhost:3000/api';
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

function carregarModulo() {
  try {
    return require('../js/solicitacoes-epi'); // eslint-disable-line global-require
  } catch (erro) {
    if (erro && erro.code === 'MODULE_NOT_FOUND' && String(erro.message).includes('solicitacoes-epi')) return null;
    throw erro;
  }
}
const S = () => {
  const modulo = carregarModulo();
  assert.ok(modulo, 'comportamento ausente: js/solicitacoes-epi.js (contratos da solicitação de EPI) não existe');
  return modulo;
};

let chamadas;
let proxima;
beforeEach(() => {
  chamadas = [];
  proxima = resposta(200, { status: 'ok' });
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => { chamadas.push({ url, metodo: opcoes.method, credentials: opcoes.credentials, corpo: opcoes.body === undefined ? undefined : JSON.parse(opcoes.body) }); return proxima; },
  });
});

const ultima = () => chamadas[chamadas.length - 1];
const caminho = (c) => c.url.slice(BASE.length);

describe('consultas: caminho e consulta exatamente como o servidor aceita', () => {
  test('minhas: status opcional, página e limite (padrão 1 e 20), GET com a sessão do cookie e sem corpo', async () => {
    await S().acoes.minhas();
    assert.equal(caminho(ultima()), '/solicitacoes-epi/minhas?pagina=1&limite=20');
    assert.deepEqual([ultima().metodo, ultima().credentials, ultima().corpo], ['GET', 'include', undefined]);
    await S().acoes.minhas({ status: 'APROVADA_PARCIAL', pagina: 3, limite: 100 });
    assert.equal(caminho(ultima()), '/solicitacoes-epi/minhas?status=APROVADA_PARCIAL&pagina=3&limite=100');
  });

  test('fila, entregáveis e encerráveis: o filtro por trabalhador só onde o servidor aceita', async () => {
    await S().acoes.fila({ pagina: 2, limite: 10 });
    assert.equal(caminho(ultima()), '/solicitacoes-epi/fila?pagina=2&limite=10');
    await S().acoes.entregaveis({ funcionarioId: 5 });
    assert.equal(caminho(ultima()), '/solicitacoes-epi/entregaveis?funcionarioId=5&pagina=1&limite=20');
    await S().acoes.encerraveis({ funcionarioId: 5, pagina: 2 });
    assert.equal(caminho(ultima()), '/solicitacoes-epi/encerraveis?funcionarioId=5&pagina=2&limite=20');
    await S().acoes.encerraveis();
    assert.equal(caminho(ultima()), '/solicitacoes-epi/encerraveis?pagina=1&limite=20');
    assert.ok(chamadas.every((c) => c.metodo === 'GET'));
  });

  test('detalhe: o id vai no caminho só se for inteiro positivo; nada mais na consulta', async () => {
    await S().acoes.detalhe(9);
    assert.equal(caminho(ultima()), '/solicitacoes-epi/9');
    for (const id of [0, -1, 1.5, '9', '../minhas', null, undefined, 2147483648]) {
      assert.throws(() => S().acoes.detalhe(id), TypeError, String(id));
    }
    assert.equal(chamadas.length, 1, 'id inválido nunca chega à rede');
  });

  test('contexto da criação: trabalhadores por busca (aparada; vazia não vai) e materiais do trabalhador do caminho', async () => {
    await S().acoes.contextoFuncionarios({ busca: '  Ana & 50%  ' });
    assert.equal(caminho(ultima()), '/solicitacoes-epi/contexto/funcionarios?busca=Ana%20%26%2050%25&pagina=1&limite=20');
    await S().acoes.contextoFuncionarios({ busca: '   ' });
    assert.equal(caminho(ultima()), '/solicitacoes-epi/contexto/funcionarios?pagina=1&limite=20');
    await S().acoes.contextoMateriais(5, { busca: 'Bota', previstoNoGhe: true });
    assert.equal(caminho(ultima()), '/solicitacoes-epi/contexto/5/materiais?busca=Bota&previstoNoGhe=true&pagina=1&limite=20');
    await S().acoes.contextoMateriais(5, { previstoNoGhe: false, limite: 100 });
    assert.equal(caminho(ultima()), '/solicitacoes-epi/contexto/5/materiais?previstoNoGhe=false&pagina=1&limite=100');
  });

  test('busca acima de 100 caracteres não sai do navegador: resposta local de validação, sem rede', async () => {
    const r = await S().acoes.contextoFuncionarios({ busca: 'x'.repeat(101) });
    assert.deepEqual([r.ok, r.status, r.codigo], [false, 400, 'BUSCA_INVALIDA']);
    const m = await S().acoes.contextoMateriais(5, { busca: 'y'.repeat(101) });
    assert.deepEqual([m.ok, m.status, m.codigo], [false, 400, 'BUSCA_INVALIDA']);
    assert.equal(chamadas.length, 0);
  });

  test('erro de programação nunca vira requisição: página, limite, status, trabalhador e previsto inválidos', () => {
    const a = S().acoes;
    const invalidas = [
      () => a.minhas({ pagina: 0 }), () => a.minhas({ limite: 101 }), () => a.minhas({ limite: 1.5 }), () => a.minhas({ pagina: '2' }),
      () => a.minhas({ status: 'QUALQUER' }), () => a.fila({ pagina: 10001 }), () => a.entregaveis({ funcionarioId: '5' }),
      () => a.encerraveis({ funcionarioId: 0 }), () => a.contextoMateriais('5', {}), () => a.contextoMateriais(5, { previstoNoGhe: 'true' }),
      () => a.contextoFuncionarios({ busca: 42 }),
    ];
    for (const chamada of invalidas) assert.throws(chamada, TypeError);
    assert.equal(chamadas.length, 0);
  });

  test('filtro desconhecido é recusado: empresa, usuário, CPF ou status fora do lugar nunca vão na consulta', () => {
    const a = S().acoes;
    for (const chamada of [
      () => a.minhas({ empresaId: 3 }), () => a.minhas({ usuarioId: 7 }), () => a.fila({ status: 'PENDENTE' }),
      () => a.entregaveis({ empresaId: 3 }), () => a.encerraveis({ situacao: 'X' }), () => a.contextoFuncionarios({ cpf: '12345678909' }),
      () => a.contextoMateriais(5, { saldo: 1 }),
    ]) assert.throws(chamada, TypeError);
    assert.equal(chamadas.length, 0);
  });
});

describe('escrita: só o caminho, o método e o corpo recebido; autoridade nunca sai do navegador', () => {
  test('criar, cancelar, decidir, encerrar e entregar: POST nos caminhos da 12F', async () => {
    const a = S().acoes;
    await a.criar({ funcionarioId: 5, itens: [], chaveIdempotencia: 'k' });
    await a.cancelar(9, { justificativa: null });
    await a.decidir(9, { decisoes: [] });
    await a.encerrar(9, { justificativa: 'Transferido' });
    await a.entregar(9, { itens: [], chaveIdempotencia: 'k' });
    assert.deepEqual(chamadas.map((c) => `${c.metodo} ${caminho(c)}`), [
      'POST /solicitacoes-epi', 'POST /solicitacoes-epi/9/cancelamento', 'POST /solicitacoes-epi/9/decisao',
      'POST /solicitacoes-epi/9/encerramento', 'POST /solicitacoes-epi/9/entregas',
    ]);
    assert.deepEqual(chamadas[3].corpo, { justificativa: 'Transferido' });
  });

  test('id inválido ou campo de autoridade no corpo: TypeError antes de qualquer rede', async () => {
    const a = S().acoes;
    assert.throws(() => a.cancelar('9', {}), TypeError);
    assert.throws(() => a.encerrar(0, { justificativa: 'x' }), TypeError);
    for (const campo of ['empresaId', 'atorId', 'perfil']) {
      await assert.rejects(a.criar({ [campo]: 1, funcionarioId: 5 }), TypeError, campo);
    }
    assert.equal(chamadas.length, 0);
  });
});

describe('mensagens: anti-enumeração e sessão', () => {
  const erro = (status, codigo, mensagem) => ({ ok: false, status, dados: null, codigo, mensagem, detalhes: null });

  test('toda solicitação não encontrada tem o mesmo texto, venha o que vier do servidor', () => {
    const M = S().mensagens;
    const a = M.deErro(erro(404, 'SOLICITACAO_NAO_ENCONTRADA', 'Solicitação não encontrada'));
    const b = M.deErro(erro(404, 'SOLICITACAO_NAO_ENCONTRADA', 'texto diferente que o servidor mandasse'));
    assert.equal(a, b);
    assert.equal(a, 'Solicitação não encontrada.');
  });

  test('trabalhador fora do alcance, inativo, sem permissão, rede e falha do servidor têm texto próprio e sem detalhe interno', () => {
    const M = S().mensagens;
    assert.equal(M.deErro(erro(404, 'FUNCIONARIO_NAO_ENCONTRADO', 'x')), 'Trabalhador não encontrado.');
    assert.equal(M.deErro(erro(409, 'FUNCIONARIO_INATIVO', 'x')), 'Trabalhador inativo não recebe EPI.');
    assert.equal(M.deErro(erro(403, 'PERMISSAO_NEGADA', 'x')), 'Você não tem permissão para esta operação.');
    assert.equal(M.deErro(erro(0, 'FALHA_DE_REDE', 'x')), 'Não foi possível falar com o servidor. Verifique sua conexão.');
    assert.equal(M.deErro(erro(500, 'ERRO_INTERNO', 'at Object.<anonymous> (/srv/app.js:1)')), 'Não foi possível concluir a operação. Tente novamente.');
    assert.equal(M.deErro(erro(400, 'VALIDACAO', 'x')), 'Dados inválidos. Revise os campos e tente novamente.');
    assert.equal(M.deErro({ ok: true, status: 200 }), '');
  });

  test('401 exige novo login; o resto não', () => {
    const M = S().mensagens;
    assert.equal(M.exigeNovoLogin(erro(401, 'SESSAO_INVALIDA', 'x')), true);
    for (const s of [0, 400, 403, 404, 409, 500]) assert.equal(M.exigeNovoLogin(erro(s, null, 'x')), false, String(s));
  });
});

describe('enumerações do servidor', () => {
  test('status e situações são as listas do backend, cada uma com rótulo em português', () => {
    assert.deepEqual([...S().STATUS], [...STATUS_DO_BACKEND]);
    assert.deepEqual([...S().SITUACOES], [...SITUACOES_DO_BACKEND]);
    for (const s of S().STATUS) assert.equal(typeof S().ROTULOS_STATUS[s], 'string', s);
    for (const s of S().SITUACOES) assert.equal(typeof S().ROTULOS_SITUACAO[s], 'string', s);
    assert.equal(S().ROTULOS_STATUS.APROVADA_PARCIAL, 'Aprovada parcialmente');
  });
});

describe('capacidades: só o que as permissões reais dão, nunca o nome do perfil', () => {
  const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
  const area = (v) => ({ consultar: v, alterar: v });
  const permissoes = ({ perfil = 'USUARIO', request = NENHUMA, acoes = {}, vinculosSst = area(false) } = {}) => ({
    empresaId: 3, usuarioId: 7, perfil, recursos: { request }, acoes,
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst,
    },
  });
  const TODAS = ['verMinhas', 'criar', 'cancelar', 'aprovar', 'reprovar', 'entregar', 'encerrar', 'consultarVinculosSst', 'alterarVinculosSst'];

  test('sem permissões (falha fechada): nada liberado', () => {
    assert.deepEqual(Object.keys(S().capacidades(null)).sort(), [...TODAS].sort());
    for (const c of TODAS) assert.equal(S().capacidades(null)[c], false, c);
  });

  test('MASTER sem nenhuma concessão de solicitação: nenhuma capacidade operacional; os vínculos SST vêm da área própria', () => {
    const c = S().capacidades(permissoes({ perfil: 'MASTER', vinculosSst: area(true) }));
    for (const k of ['verMinhas', 'criar', 'cancelar', 'aprovar', 'reprovar', 'entregar', 'encerrar']) assert.equal(c[k], false, k);
    assert.deepEqual([c.consultarVinculosSst, c.alterarVinculosSst], [true, true]);
    const semArea = S().capacidades(permissoes({ perfil: 'MASTER' }));
    assert.deepEqual([semArea.consultarVinculosSst, semArea.alterarVinculosSst], [false, false], 'o perfil MASTER, sozinho, não dá vínculo SST');
  });

  test('cada capacidade segue a sua permissão: request (ver, criar, cancelar = editar) e as ações da SST e da entrega', () => {
    const c = S().capacidades(permissoes({ request: { ...NENHUMA, visualizar: true, criar: true }, acoes: { APROVAR_SOLICITACAO: true, ENCERRAR_SOLICITACAO: true } }));
    assert.deepEqual(TODAS.map((k) => c[k]), [true, true, false, true, false, false, true, false, false]);
    const outra = S().capacidades(permissoes({ request: { ...NENHUMA, editar: true }, acoes: { REPROVAR_SOLICITACAO: true, REALIZAR_ENTREGA: true } }));
    assert.deepEqual(TODAS.map((k) => outra[k]), [false, false, true, false, true, true, false, false, false]);
  });

  test('só true explícito: texto "true" ou ação ausente não liberam', () => {
    const c = S().capacidades(permissoes({ request: { ...NENHUMA, criar: 'true' }, acoes: { APROVAR_SOLICITACAO: 'true' } }));
    assert.deepEqual([c.criar, c.aprovar], [false, false]);
    assert.equal(typeof P.recurso, 'function', 'as capacidades usam o módulo de permissões efetivas');
  });
});
