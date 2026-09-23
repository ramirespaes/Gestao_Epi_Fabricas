'use strict';

const { describe, test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { criarAppTeste } = require('../helpers/app-teste');
const { criarExigirPermissaoRecurso, criarExigirPermissaoAcao } = require('../../src/middleware/autorizacao');
const permissaoRepo = require('../../src/repositories/permissao.repository');

/**
 * Testes do middleware de autorização por recurso, sem PostgreSQL real.
 *
 * permissao.repository é sempre mockado via t.mock.method — o middleware
 * não sabe (nem deve saber) como o repositório decide o valor das flags, só
 * como reagir ao resultado. src/middleware/autorizacao.js chama
 * `permissaoRepo.funcao(...)` por namespace, nunca desestruturado, o que
 * torna esse mock possível.
 *
 * req.empresa/req.usuario são montados manualmente pela rota de teste, para
 * simular exatamente o que exigirSessao já teria populado — este middleware
 * é testado isoladamente, depois da autenticação, nunca antes dela.
 *
 * buscarGrupoAcessoDoUsuario e buscarPermissaoRecursoIndividual têm mocks
 * padrão (usuário sem grupo, sem exceção individual) instalados em todo o
 * arquivo por beforeEach/afterEach — o mesmo padrão já usado em outros
 * arquivos de teste de middleware (ver rate-limit.test.js). Isso preserva,
 * sem repetição, o comportamento de todos os testes anteriores à Subetapa
 * 3D/3G (que nunca mencionavam grupo ou exceção individual), e cada teste
 * que precisa de um valor específico sobrescreve com o próprio
 * t.mock.method, restaurado ao final do teste antes de o afterEach global
 * restaurar o resto.
 */

function semGrupo(t) {
  return t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => null);
}

function mockGrupo(t, { id = 900, ativo = true } = {}) {
  return t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => ({ id, ativo }));
}

function mockPermissaoRecursoGrupo(t, flags) {
  return t.mock.method(permissaoRepo, 'buscarPermissaoRecursoGrupo', async () => (flags === null ? null : {
    podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null, ...flags,
  }));
}

function mockPermissaoAcaoGrupo(t, permitido) {
  return t.mock.method(permissaoRepo, 'buscarPermissaoAcaoGrupo', async () => (permitido === null ? null : { permitido }));
}

function semExcecaoIndividualRecurso(t) {
  return t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => null);
}

function mockPermissaoRecursoIndividual(t, flags) {
  return t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => (flags === null ? null : {
    podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null, ...flags,
  }));
}

beforeEach(() => {
  mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => null);
  mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => null);
});
afterEach(() => mock.restoreAll());

const RECURSO = 'materials';
const CONTEXTO_PADRAO = Object.freeze({
  usuario: { id: 7, nome: 'Ana Souza', email: 'ana.souza@demo.safeworkengenharia.com.br', perfil: 'ADMINISTRADOR' },
  empresa: { id: 42, nome: 'Empresa Teste', cnpj: '12345678000195' },
});

function montarApp(middleware, { comContexto = true, contexto = CONTEXTO_PADRAO, comSessaoParcial = false } = {}) {
  return criarAppTeste((app) => {
    app.get('/protegida', (req, res, next) => {
      if (comSessaoParcial) {
        req.usuario = contexto.usuario;
        // req.empresa deliberadamente ausente, simulando contexto incompleto.
      } else if (comContexto) {
        req.usuario = contexto.usuario;
        req.empresa = contexto.empresa;
        req.sessao = { id: '555' };
      }
      next();
    }, middleware, (req, res) => {
      res.json({ sessao: req.sessao, usuario: req.usuario, empresa: req.empresa });
    });
  });
}

function permissaoRecurso(flags) {
  return {
    podeVisualizar: false, podeCriar: false, podeEditar: false, podeExcluir: false, ...flags,
  };
}

describe('criarExigirPermissaoRecurso — configuração da fábrica', () => {
  test('recusa operação desconhecida imediatamente, sem esperar requisição', () => {
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'apagar'), /operação/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, RECURSO, ''), /operação/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, RECURSO, undefined), /operação/i);
  });

  test('nunca assume "visualizar" como operação padrão', () => {
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, RECURSO));
  });

  test('recusa propriedades herdadas de Object.prototype como operação, não apenas ausentes do mapa', () => {
    // MAPA_OPERACAO_FLAG[operacao] === undefined não bastaria: toString,
    // constructor e __proto__ existem em qualquer objeto por herança, e
    // `MAPA_OPERACAO_FLAG['toString']` resolveria para a função nativa em
    // vez de undefined. Object.hasOwn distingue propriedade própria de
    // herdada, e é isso que a fábrica precisa recusar aqui.
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'toString'), /operação/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'constructor'), /operação/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, RECURSO, '__proto__'), /operação/i);
  });

  test('recusa recurso inválido imediatamente', () => {
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, '', 'visualizar'), /recurso/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, null, 'visualizar'), /recurso/i);
  });

  test('recusa recurso fora do formato do repositório (mesmo contrato de permissao.repository.js)', () => {
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, 'com espaco', 'visualizar'), /recurso/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, 'com-hifen', 'visualizar'), /recurso/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, 'x'.repeat(61), 'visualizar'), /recurso/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, '', 'visualizar'), /recurso/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, 123, 'visualizar'), /recurso/i);
    assert.throws(() => criarExigirPermissaoRecurso({ pool: {} }, undefined, 'visualizar'), /recurso/i);
  });

  test('aceita identificadores de recurso reais do frontend', () => {
    assert.doesNotThrow(() => criarExigirPermissaoRecurso({ pool: {} }, 'materials', 'visualizar'));
    assert.doesNotThrow(() => criarExigirPermissaoRecurso({ pool: {} }, 'userAdmin', 'visualizar'));
    assert.doesNotThrow(() => criarExigirPermissaoRecurso({ pool: {} }, 'stockValidity', 'visualizar'));
  });
});

describe('criarExigirPermissaoRecurso — operação visualizar', () => {
  test('podeVisualizar=true chama next() sem erro', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
  });

  test('podeVisualizar=false nega com 403 PERMISSAO_NEGADA', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('registro ausente (null) nega com 403 PERMISSAO_NEGADA', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => null);
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });
});

describe('criarExigirPermissaoRecurso — demais operações', () => {
  test('podeCriar=true permite, podeCriar=false nega', async (t) => {
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'criar');

    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeCriar: true }));
    assert.equal((await request(montarApp(middleware)).get('/protegida')).status, 200);

    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeCriar: false }));
    const negado = await request(montarApp(middleware)).get('/protegida');
    assert.equal(negado.status, 403);
    assert.equal(negado.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('podeEditar=true permite, podeEditar=false nega', async (t) => {
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'editar');

    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeEditar: true }));
    assert.equal((await request(montarApp(middleware)).get('/protegida')).status, 200);

    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeEditar: false }));
    const negado = await request(montarApp(middleware)).get('/protegida');
    assert.equal(negado.status, 403);
    assert.equal(negado.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('podeExcluir=true permite, podeExcluir=false nega', async (t) => {
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'excluir');

    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeExcluir: true }));
    assert.equal((await request(montarApp(middleware)).get('/protegida')).status, 200);

    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeExcluir: false }));
    const negado = await request(montarApp(middleware)).get('/protegida');
    assert.equal(negado.status, 403);
    assert.equal(negado.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('permissão para visualizar não autoriza automaticamente criar, editar ou excluir', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));

    const criar = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'criar');
    const editar = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'editar');
    const excluir = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'excluir');

    assert.equal((await request(montarApp(criar)).get('/protegida')).status, 403);
    assert.equal((await request(montarApp(editar)).get('/protegida')).status, 403);
    assert.equal((await request(montarApp(excluir)).get('/protegida')).status, 403);
  });
});

describe('criarExigirPermissaoRecurso — perfis e identidade', () => {
  test('MASTER sem linha explícita de permissão recebe 403, sem bypass', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => null);
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');
    const contextoMaster = {
      usuario: { id: 1, nome: 'Master', email: 'master@demo.safeworkengenharia.com.br', perfil: 'MASTER' },
      empresa: CONTEXTO_PADRAO.empresa,
    };

    const resposta = await request(montarApp(middleware, { contexto: contextoMaster })).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('empresaId e perfil chegam ao repositório exclusivamente de req.empresa/req.usuario, nunca de query/params/headers', async (t) => {
    const buscar = t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    await request(montarApp(middleware))
      .get('/protegida?empresaId=999&perfil=MASTER')
      .set('X-Empresa-Id', '999')
      .set('X-Perfil', 'MASTER');

    assert.equal(buscar.mock.calls.length, 1);
    assert.equal(buscar.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(buscar.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.perfil);
    assert.equal(buscar.mock.calls[0].arguments[3], RECURSO);
  });

  test('contexto autenticado ausente não autoriza nem consulta o repositório', async (t) => {
    const buscar = t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware, { comContexto: false })).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.equal(buscar.mock.calls.length, 0);
    assert.notEqual(resposta.body.codigo, 'PERMISSAO_NEGADA', 'contexto ausente não é uma decisão de negócio de permissão');
  });

  test('contexto autenticado incompleto (sem req.empresa) não autoriza nem consulta o repositório', async (t) => {
    const buscar = t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware, { comSessaoParcial: true })).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.equal(buscar.mock.calls.length, 0);
    assert.notEqual(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('não altera req.usuario, req.empresa nem req.sessao', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.deepEqual(resposta.body.usuario, CONTEXTO_PADRAO.usuario);
    assert.deepEqual(resposta.body.empresa, CONTEXTO_PADRAO.empresa);
    assert.deepEqual(resposta.body.sessao, { id: '555' });
  });

  test('contexto incompleto (usuário sem id) não autoriza nem consulta o repositório, mesmo com perfil e empresa presentes', async (t) => {
    const buscar = t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const grupo = mockGrupo(t);
    const contextoSemId = {
      usuario: { nome: 'Sem Id', email: 'sem.id@demo.safeworkengenharia.com.br', perfil: 'ADMINISTRADOR' },
      empresa: CONTEXTO_PADRAO.empresa,
    };
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware, { contexto: contextoSemId })).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.equal(buscar.mock.calls.length, 0);
    assert.equal(grupo.mock.calls.length, 0);
    assert.notEqual(resposta.body.codigo, 'PERMISSAO_NEGADA', 'usuario.id ausente é erro de contexto — a leitura do grupo depende dele');
  });
});

describe('criarExigirPermissaoRecurso — grupo de acesso (Subetapa 3D)', () => {
  test('sem grupo: comportamento anterior é preservado, só o perfil decide', async (t) => {
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const permissaoGrupo = mockPermissaoRecursoGrupo(t, { podeVisualizar: false });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
    assert.equal(permissaoGrupo.mock.calls.length, 0, 'sem grupo, a permissão de grupo nem precisa ser consultada');
  });

  test('grupo ativo com TRUE concede mesmo com o perfil negando (FALSE)', async (t) => {
    mockGrupo(t, { ativo: true });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    mockPermissaoRecursoGrupo(t, { podeVisualizar: true });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
  });

  test('grupo ativo com FALSE nega mesmo com o perfil concedendo (TRUE)', async (t) => {
    mockGrupo(t, { ativo: true });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockPermissaoRecursoGrupo(t, { podeVisualizar: false });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('grupo com NULL na coluna herda a base do perfil, nos dois sentidos', async (t) => {
    mockGrupo(t, { ativo: true });
    mockPermissaoRecursoGrupo(t, { podeVisualizar: null });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    assert.equal((await request(montarApp(middleware)).get('/protegida')).status, 200);

    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    assert.equal((await request(montarApp(middleware)).get('/protegida')).status, 403);
  });

  test('grupo sem nenhuma linha de permissão para o recurso herda a base do perfil', async (t) => {
    mockGrupo(t, { ativo: true });
    mockPermissaoRecursoGrupo(t, null);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
  });

  test('grupo inativo com TRUE não concede: herda a base (perfil nega)', async (t) => {
    mockGrupo(t, { ativo: false });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    mockPermissaoRecursoGrupo(t, { podeVisualizar: true });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'grupo inativo nunca concede o que o perfil não concedia');
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('grupo inativo com FALSE continua negando, mesmo com o perfil concedendo', async (t) => {
    mockGrupo(t, { ativo: false });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockPermissaoRecursoGrupo(t, { podeVisualizar: false });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'grupo inativo continua restringindo, mesmo inativo');
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('MASTER não é restringido pelo grupo: grupo nunca é consultado, mesmo tendo um', async (t) => {
    const grupo = mockGrupo(t, { ativo: true });
    const permissaoGrupo = mockPermissaoRecursoGrupo(t, { podeVisualizar: false });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_MASTER })).get('/protegida');

    assert.equal(resposta.status, 200, 'MASTER usa só a permissão empresarial de perfil');
    assert.equal(grupo.mock.calls.length, 0);
    assert.equal(permissaoGrupo.mock.calls.length, 0);
  });

  test('cada operação é independente: grupo concede visualizar mas não interfere em criar', async (t) => {
    mockGrupo(t, { ativo: true });
    mockPermissaoRecursoGrupo(t, { podeVisualizar: true, podeCriar: false });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false, podeCriar: true }));

    const visualizar = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');
    const criar = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'criar');

    assert.equal((await request(montarApp(visualizar)).get('/protegida')).status, 200, 'grupo concedeu visualizar (perfil negava)');
    assert.equal((await request(montarApp(criar)).get('/protegida')).status, 403, 'grupo negou criar (perfil concedia)');
  });

  test('empresaId e usuarioId chegam às consultas de grupo exclusivamente do contexto autenticado', async (t) => {
    const grupo = mockGrupo(t, { id: 77, ativo: true });
    const permissaoGrupo = mockPermissaoRecursoGrupo(t, { podeVisualizar: true });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    await request(montarApp(middleware))
      .get('/protegida?empresaId=999&grupoAcessoId=888')
      .set('X-Empresa-Id', '999');

    assert.equal(grupo.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(grupo.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.id);
    assert.equal(permissaoGrupo.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(permissaoGrupo.mock.calls[0].arguments[2], 77);
    assert.equal(permissaoGrupo.mock.calls[0].arguments[3], RECURSO);
  });
});

describe('criarExigirPermissaoRecurso — exceção individual (Subetapa 3G)', () => {
  test('A. sem exceção individual: comportamento da 3D (perfil + grupo) é preservado', async (t) => {
    semExcecaoIndividualRecurso(t);
    mockGrupo(t, { ativo: true });
    mockPermissaoRecursoGrupo(t, { podeVisualizar: true });
    const excecao = t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => null);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'grupo concedeu (perfil negava); sem exceção individual o resultado do grupo prevalece');
    assert.equal(excecao.mock.calls.length, 1, 'a consulta individual é sempre feita para não-MASTER, mesmo devolvendo null');
  });

  test('B. exceção individual TRUE concede mesmo com o perfil negando (sem grupo)', async (t) => {
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    mockPermissaoRecursoIndividual(t, { podeVisualizar: true });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
  });

  test('C. exceção individual FALSE nega mesmo com o perfil concedendo (sem grupo)', async (t) => {
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockPermissaoRecursoIndividual(t, { podeVisualizar: false });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('D. exceção individual TRUE concede mesmo com o grupo negando (FALSE)', async (t) => {
    mockGrupo(t, { ativo: true });
    mockPermissaoRecursoGrupo(t, { podeVisualizar: false });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockPermissaoRecursoIndividual(t, { podeVisualizar: true });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'exceção individual substitui inclusive uma negativa de grupo');
  });

  test('E. exceção individual FALSE nega mesmo com o grupo concedendo (TRUE)', async (t) => {
    mockGrupo(t, { ativo: true });
    mockPermissaoRecursoGrupo(t, { podeVisualizar: true });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    mockPermissaoRecursoIndividual(t, { podeVisualizar: false });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'exceção individual substitui inclusive uma concessão de grupo');
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('F. exceção individual NULL herda o resultado já definido pelo grupo', async (t) => {
    mockGrupo(t, { ativo: true });
    mockPermissaoRecursoGrupo(t, { podeVisualizar: true });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    mockPermissaoRecursoIndividual(t, { podeVisualizar: null });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'NULL individual não tem opinião; o resultado do grupo (concedeu) prevalece');
  });

  test('G. exceção individual NULL herda a base do perfil quando não existe grupo', async (t) => {
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockPermissaoRecursoIndividual(t, { podeVisualizar: null });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'NULL individual não tem opinião; sem grupo, a base é o perfil (concedeu)');
  });

  test('H. linha individual com os quatro campos NULL não modifica o resultado', async (t) => {
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockPermissaoRecursoIndividual(t, {});
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'uma linha existente mas totalmente NULL equivale a nenhuma opinião');
  });

  test('I. operações são independentes: exceção individual em excluir não altera visualizar, criar ou editar', async (t) => {
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({
      podeVisualizar: true, podeCriar: true, podeEditar: true, podeExcluir: true,
    }));
    mockPermissaoRecursoIndividual(t, { podeExcluir: false });

    const visualizar = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');
    const criar = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'criar');
    const editar = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'editar');
    const excluir = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'excluir');

    assert.equal((await request(montarApp(visualizar)).get('/protegida')).status, 200);
    assert.equal((await request(montarApp(criar)).get('/protegida')).status, 200);
    assert.equal((await request(montarApp(editar)).get('/protegida')).status, 200);
    assert.equal((await request(montarApp(excluir)).get('/protegida')).status, 403, 'só excluir tem exceção individual negando');
  });

  test('J. grupo inativo nega (FALSE), mas exceção individual TRUE resgata a concessão', async (t) => {
    mockGrupo(t, { ativo: false });
    mockPermissaoRecursoGrupo(t, { podeVisualizar: false });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockPermissaoRecursoIndividual(t, { podeVisualizar: true });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'a exceção individual aplica-se depois do cálculo de grupo, mesmo com grupo inativo negando');
  });

  test('K. grupo inativo com TRUE não concede (herda perfil), e exceção individual FALSE nega por cima', async (t) => {
    mockGrupo(t, { ativo: false });
    mockPermissaoRecursoGrupo(t, { podeVisualizar: true });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockPermissaoRecursoIndividual(t, { podeVisualizar: false });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'grupo inativo com TRUE não concede (herda o perfil, que concedia); a exceção individual nega por cima');
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('L. MASTER nunca consulta exceção individual, mesmo com uma que negaria a ação', async (t) => {
    const excecao = t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => ({
      podeVisualizar: false, podeCriar: null, podeEditar: null, podeExcluir: null,
    }));
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_MASTER })).get('/protegida');

    assert.equal(resposta.status, 200, 'MASTER usa só a permissão empresarial de perfil, sem restrição individual');
    assert.equal(excecao.mock.calls.length, 0);
  });

  test('M. empresaId e usuarioId chegam à consulta individual exclusivamente do contexto autenticado', async (t) => {
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: false }));
    const excecao = mockPermissaoRecursoIndividual(t, { podeVisualizar: true });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    await request(montarApp(middleware))
      .get('/protegida?empresaId=999&usuarioId=999')
      .set('X-Empresa-Id', '999')
      .set('X-Usuario-Id', '999');

    assert.equal(excecao.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id, 'nunca o empresaId forjado na query/header');
    assert.equal(excecao.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.id, 'nunca o usuarioId forjado na query/header');
    assert.equal(excecao.mock.calls[0].arguments[3], RECURSO);
  });

  test('N. falha real na consulta individual propaga (500), nunca vira concessão — ver também "erros inesperados" abaixo', async (t) => {
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => { throw new Error('timeout ao consultar usuario_permissoes_recurso'); });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('O. usuario_permissoes_recurso nunca é consultada por criarExigirPermissaoAcao', async (t) => {
    const excecao = t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => ({
      podeVisualizar: true, podeCriar: null, podeEditar: null, podeExcluir: null,
    }));
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'NENHUMA' });
    mockPermissaoAcao(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
    assert.equal(excecao.mock.calls.length, 0, 'uma exceção de RECURSO nunca pode influenciar autorização de AÇÃO');
  });
});

describe('criarExigirPermissaoRecurso — erros inesperados', () => {
  test('erro inesperado do repositório propaga (500), não vira 403', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => { throw new Error('conexão perdida com o banco'); });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('erro inesperado em buscarGrupoAcessoDoUsuario propaga (500), não vira 403 nem autoriza', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => { throw new Error('timeout ao consultar grupos_acesso'); });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('erro inesperado em buscarPermissaoRecursoGrupo propaga (500), não vira 403 nem autoriza', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockGrupo(t, { ativo: true });
    t.mock.method(permissaoRepo, 'buscarPermissaoRecursoGrupo', async () => { throw new Error('timeout ao consultar grupo_permissoes_recurso'); });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('erro inesperado em buscarPermissaoRecursoIndividual propaga (500), não vira 403 nem autoriza', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    semGrupo(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoRecursoIndividual', async () => { throw new Error('timeout ao consultar usuario_permissoes_recurso'); });
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });
});

/**
 * Testes do middleware de autorização por ação de negócio, sem PostgreSQL
 * real. permissao.repository é sempre mockado, cada função separadamente,
 * respeitando o contrato real de cada uma: buscarConfiguracaoAcao devolve
 * `{ativo, exigeSst, modoAutorizacaoIndividual} | null`; buscarPermissaoAcao
 * devolve `{permitido: boolean} | null`; usuarioIntegraSst,
 * usuarioTemAutorizacaoIndividual e usuarioTemBloqueio sempre devolvem um
 * boolean.
 */

const ACAO = 'REALIZAR_ENTREGA';

const CONTEXTO_SEM_USUARIO_ID = Object.freeze({
  usuario: { nome: 'Sem Id', email: 'sem.id@demo.safeworkengenharia.com.br', perfil: 'ADMINISTRADOR' },
  empresa: CONTEXTO_PADRAO.empresa,
});

const CONTEXTO_MASTER = Object.freeze({
  usuario: { id: 1, nome: 'Master', email: 'master@demo.safeworkengenharia.com.br', perfil: 'MASTER' },
  empresa: CONTEXTO_PADRAO.empresa,
});

function mockConfiguracaoAcao(t, { ativo = true, exigeSst = false, modoAutorizacaoIndividual = 'NENHUMA' } = {}) {
  return t.mock.method(permissaoRepo, 'buscarConfiguracaoAcao', async () => ({ ativo, exigeSst, modoAutorizacaoIndividual }));
}

function mockConfiguracaoAcaoInexistente(t) {
  return t.mock.method(permissaoRepo, 'buscarConfiguracaoAcao', async () => null);
}

function mockPermissaoAcao(t, permitido) {
  return t.mock.method(permissaoRepo, 'buscarPermissaoAcao', async () => (permitido === null ? null : { permitido }));
}

function mockBloqueio(t, bloqueado) {
  return t.mock.method(permissaoRepo, 'usuarioTemBloqueio', async () => bloqueado);
}

function mockSst(t, integra) {
  return t.mock.method(permissaoRepo, 'usuarioIntegraSst', async () => integra);
}

function mockAutorizacaoIndividual(t, autorizado) {
  return t.mock.method(permissaoRepo, 'usuarioTemAutorizacaoIndividual', async () => autorizado);
}

describe('criarExigirPermissaoAcao — configuração da fábrica', () => {
  test('aceita códigos legítimos do catálogo existente', () => {
    for (const codigo of ['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'MOVIMENTAR_ESTOQUE', 'REALIZAR_ENTREGA', 'GERENCIAR_USUARIOS', 'ALTERAR_CONFIGURACOES']) {
      assert.doesNotThrow(() => criarExigirPermissaoAcao({ pool: {} }, codigo));
    }
  });

  test('recusa código de ação inválido imediatamente, sem esperar requisição', () => {
    assert.throws(() => criarExigirPermissaoAcao({ pool: {} }, ''), /ação/i);
    assert.throws(() => criarExigirPermissaoAcao({ pool: {} }, 'minuscula'), /ação/i);
    assert.throws(() => criarExigirPermissaoAcao({ pool: {} }, 'com espaco'), /ação/i);
    assert.throws(() => criarExigirPermissaoAcao({ pool: {} }, 'A'.repeat(61)), /ação/i);
    assert.throws(() => criarExigirPermissaoAcao({ pool: {} }, null), /ação/i);
    assert.throws(() => criarExigirPermissaoAcao({ pool: {} }, undefined), /ação/i);
    assert.throws(() => criarExigirPermissaoAcao({ pool: {} }, 123), /ação/i);
  });
});

describe('criarExigirPermissaoAcao — configuração da ação no catálogo', () => {
  test('ação inexistente no catálogo: 403, sem consultar mais nada', async (t) => {
    mockConfiguracaoAcaoInexistente(t);
    const permissao = mockPermissaoAcao(t, true);
    const bloqueio = mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    assert.equal(permissao.mock.calls.length, 0, 'ação inexistente já basta para negar');
    assert.equal(bloqueio.mock.calls.length, 0);
  });

  test('ação inativa (ativo=false): 403, mesmo com permissão de perfil concedida', async (t) => {
    mockConfiguracaoAcao(t, { ativo: false });
    mockPermissaoAcao(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  // Correção pós-auditoria: um modo_autorizacao_individual desconhecido NÃO
  // pode mais herdar o comportamento de NENHUMA (que ainda concede via
  // permissoes_acao). Configuração fora do esperado nega incondicionalmente,
  // para qualquer perfil, antes mesmo de consultar permissoes_acao,
  // usuario_autorizacoes ou usuarioIntegraSst.
  test('modo_autorizacao_individual desconhecido nega incondicionalmente, mesmo com permissão de perfil concedida', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'VALOR_INESPERADO' });
    const permissao = mockPermissaoAcao(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'permitido=true no perfil não pode conceder quando a configuração da ação é inválida');
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    assert.equal(permissao.mock.calls.length, 0, 'configuração inválida nega antes mesmo de consultar permissoes_acao');
  });

  test('modo_autorizacao_individual desconhecido nega incondicionalmente, mesmo com autorização individual concedida', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'VALOR_INESPERADO' });
    mockPermissaoAcao(t, false);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    assert.equal(autorizacaoIndividual.mock.calls.length, 0, 'configuração inválida nega antes mesmo de consultar usuario_autorizacoes');
  });

  test('modo_autorizacao_individual desconhecido nega até para MASTER, mesmo com permissão empresarial concedida', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'VALOR_INESPERADO' });
    const permissao = mockPermissaoAcao(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_MASTER })).get('/protegida');

    assert.equal(resposta.status, 403, 'MASTER não escapa da validação de configuração — ela roda antes de qualquer ramo por perfil');
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    assert.equal(permissao.mock.calls.length, 0);
  });

  test('exigeSst fora do tipo booleano nega incondicionalmente, sem presumir false', async (t) => {
    let exigeSstAtual;
    t.mock.method(permissaoRepo, 'buscarConfiguracaoAcao', async () => ({
      ativo: true, exigeSst: exigeSstAtual, modoAutorizacaoIndividual: 'NENHUMA',
    }));
    const permissao = mockPermissaoAcao(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    for (const exigeSstInvalido of [undefined, null, 'false', 0, 1]) {
      exigeSstAtual = exigeSstInvalido;

      const resposta = await request(montarApp(middleware)).get('/protegida');

      assert.equal(resposta.status, 403, `exigeSst=${JSON.stringify(exigeSstInvalido)} não pode ser tratado como false`);
      assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    }
    assert.equal(permissao.mock.calls.length, 0, 'configuração inválida nega antes mesmo de consultar permissoes_acao, em todos os casos');
  });
});

describe('criarExigirPermissaoAcao — modo NENHUMA (equivalente ao contrato anterior)', () => {
  test('permitido=true e sem bloqueio: autoriza', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'NENHUMA' });
    mockPermissaoAcao(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
  });

  test('permitido=true e com bloqueio: 403 PERMISSAO_NEGADA', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'NENHUMA' });
    mockPermissaoAcao(t, true);
    mockBloqueio(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('permitido=false: 403 PERMISSAO_NEGADA', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'NENHUMA' });
    mockPermissaoAcao(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('linha de permissão ausente (null): 403 PERMISSAO_NEGADA, bloqueio nunca consultado', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'NENHUMA' });
    mockPermissaoAcao(t, null);
    const bloqueio = mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
    assert.equal(bloqueio.mock.calls.length, 0, 'sem concessão, bloqueio não precisa ser consultado');
  });

  test('usuario_autorizacoes nunca é consultada neste modo', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'NENHUMA' });
    mockPermissaoAcao(t, false);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'modo NENHUMA nunca concede via autorização individual, mesmo que exista uma');
    assert.equal(autorizacaoIndividual.mock.calls.length, 0);
  });

  test('grupo nunca é consultado neste modo, mesmo com um grupo que concederia a ação', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'NENHUMA' });
    mockPermissaoAcao(t, false);
    mockBloqueio(t, false);
    const grupo = mockGrupo(t, { ativo: true });
    const permissaoGrupo = mockPermissaoAcaoGrupo(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'grupo não participa do modo NENHUMA — só a permissão do perfil decide');
    assert.equal(grupo.mock.calls.length, 0);
    assert.equal(permissaoGrupo.mock.calls.length, 0);
  });
});

describe('criarExigirPermissaoAcao — modo OBRIGATORIA (não-MASTER)', () => {
  test('autorização individual concedida, SEM linha em permissoes_acao: autoriza — a ausência de permissão por perfil não nega antecipadamente', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'OBRIGATORIA' });
    const permissao = mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'SST/autorização individual, sem linha em permissoes_acao, deve autorizar em modo OBRIGATORIA');
    assert.equal(permissao.mock.calls.length, 1, 'buscarPermissaoAcao ainda é chamada, mas seu resultado é ignorado para não-MASTER neste modo');
  });

  test('autorização individual concedida mesmo com permissoes_acao.permitido=false: autoriza — permissoes_acao é ignorada', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, false);
    mockAutorizacaoIndividual(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
  });

  test('sem autorização individual: 403, mesmo com permissoes_acao.permitido=true — permissão de perfil não basta sozinha', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, true);
    mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('bloqueio individual nega mesmo com autorização individual concedida', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, true);
    mockBloqueio(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('grupo nunca é consultado neste modo: não substitui a exigência de autorização individual', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, true);
    mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const grupo = mockGrupo(t, { ativo: true });
    const permissaoGrupo = mockPermissaoAcaoGrupo(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'sem autorização individual, nem grupo nem perfil substituem a exigência em OBRIGATORIA');
    assert.equal(grupo.mock.calls.length, 0);
    assert.equal(permissaoGrupo.mock.calls.length, 0);
  });
});

describe('criarExigirPermissaoAcao — modo ALTERNATIVA (não-MASTER)', () => {
  test('permitido=true, sem autorização individual: autoriza', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, true);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
    assert.equal(autorizacaoIndividual.mock.calls.length, 0, 'permissão de perfil já concede; autorização individual não precisa ser consultada (OR de curto-circuito)');
  });

  test('SEM linha em permissoes_acao, mas com autorização individual: autoriza — ausência de permissão por perfil não nega antecipadamente', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'exemplo Carlos/almoxarifado: individual concede mesmo sem linha de perfil');
  });

  test('permitido=false, com autorização individual: autoriza', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, false);
    mockAutorizacaoIndividual(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
  });

  test('sem permissão de perfil e sem autorização individual: 403 — exemplo Pedro/produção', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('bloqueio individual nega mesmo com concessão por perfil e por autorização individual', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, true);
    mockAutorizacaoIndividual(t, true);
    mockBloqueio(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('grupo ativo com TRUE concede mesmo com o perfil negando (permitido=false)', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, false);
    mockGrupo(t, { ativo: true });
    mockPermissaoAcaoGrupo(t, true);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
    assert.equal(autorizacaoIndividual.mock.calls.length, 0, 'grupo já concedeu; autorização individual não precisa ser consultada');
  });

  test('grupo ativo com FALSE nega a base do perfil (permitido=true), mas concessão individual explícita ainda resgata', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, true);
    mockGrupo(t, { ativo: true });
    mockPermissaoAcaoGrupo(t, false);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200, 'autorização individual funciona como exceção final, mesmo após negativa de grupo');
    assert.equal(autorizacaoIndividual.mock.calls.length, 1);
  });

  test('grupo ativo com FALSE nega, e sem autorização individual permanece negado', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, true);
    mockGrupo(t, { ativo: true });
    mockPermissaoAcaoGrupo(t, false);
    mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('grupo com NULL herda a base do perfil normalmente', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockGrupo(t, { ativo: true });
    mockPermissaoAcaoGrupo(t, null);
    mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    mockPermissaoAcao(t, true);
    assert.equal((await request(montarApp(middleware)).get('/protegida')).status, 200);

    mockPermissaoAcao(t, false);
    assert.equal((await request(montarApp(middleware)).get('/protegida')).status, 403);
  });

  test('grupo inativo com TRUE não concede: herda a base do perfil (negada)', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, false);
    mockGrupo(t, { ativo: false });
    mockPermissaoAcaoGrupo(t, true);
    mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'grupo inativo nunca concede o que o perfil não concedia');
  });

  test('grupo inativo com FALSE continua negando, mesmo com o perfil concedendo', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, true);
    mockGrupo(t, { ativo: false });
    mockPermissaoAcaoGrupo(t, false);
    mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'grupo inativo continua restringindo, mesmo inativo');
  });

  test('sem grupo: comportamento anterior é preservado (perfil OU individual decide)', async (t) => {
    semGrupo(t);
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, false);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, true);
    const permissaoGrupo = mockPermissaoAcaoGrupo(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
    assert.equal(autorizacaoIndividual.mock.calls.length, 1);
    assert.equal(permissaoGrupo.mock.calls.length, 0, 'sem grupo, a permissão de grupo nem precisa ser consultada');
  });

  test('empresaId, grupoAcessoId e acaoCodigo chegam corretamente às consultas de grupo', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, false);
    const grupo = mockGrupo(t, { id: 321, ativo: true });
    const permissaoGrupo = mockPermissaoAcaoGrupo(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    await request(montarApp(middleware))
      .get('/protegida?empresaId=999&grupoAcessoId=888')
      .set('X-Empresa-Id', '999');

    assert.equal(grupo.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(grupo.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.id);
    assert.equal(permissaoGrupo.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(permissaoGrupo.mock.calls[0].arguments[2], 321);
    assert.equal(permissaoGrupo.mock.calls[0].arguments[3], ACAO);
  });
});

describe('criarExigirPermissaoAcao — exige_sst', () => {
  test('não-MASTER concedido mas sem SST: 403', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, true);
    mockSst(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('não-MASTER concedido e com SST: autoriza', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, true);
    mockSst(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
  });

  test('MASTER dispensa SST mesmo quando a ação exige, desde que tenha permissão de perfil', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, true);
    const sst = mockSst(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_MASTER })).get('/protegida');

    assert.equal(resposta.status, 200);
    assert.equal(sst.mock.calls.length, 0, 'MASTER nunca consulta vinculo_sst');
  });

  test('SST só é consultada depois de uma concessão: negado por falta de concessão nunca consulta SST', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, false);
    const sst = mockSst(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(sst.mock.calls.length, 0, 'sem concessão, não há razão para consultar SST');
  });

  test('exige_sst=false: SST nunca é consultada, para nenhum perfil', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: false, modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, true);
    const sst = mockSst(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 200);
    assert.equal(sst.mock.calls.length, 0);
  });

  test('APROVAR_SOLICITACAO: não-MASTER com autorização individual mas sem SST é negado — as regras reais de 017/018/019 continuam intactas', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, true);
    mockAutorizacaoIndividual(t, true);
    mockSst(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, 'APROVAR_SOLICITACAO');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('um grupo com permissão para APROVAR_SOLICITACAO (mesmo que o grupo se chame "SST") não substitui vinculo_sst nem usuario_autorizacoes: modo OBRIGATORIA nunca consulta grupo', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, true);
    mockAutorizacaoIndividual(t, false);
    mockSst(t, false);
    mockBloqueio(t, false);
    // Um grupo com opinião TRUE aqui simula exatamente o cenário do
    // relatório: mesmo que exista, ele nunca chega a ser consultado neste
    // modo — só vinculo_sst e usuario_autorizacoes decidem.
    const grupo = mockGrupo(t, { ativo: true });
    const permissaoGrupo = mockPermissaoAcaoGrupo(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, 'APROVAR_SOLICITACAO');

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 403, 'sem autorização individual e sem SST, nada substitui a exigência — grupo incluído');
    assert.equal(grupo.mock.calls.length, 0);
    assert.equal(permissaoGrupo.mock.calls.length, 0);
  });
});

describe('criarExigirPermissaoAcao — MASTER', () => {
  test('MASTER com permissão de perfil explícita: autoriza, sem consultar SST nem autorização individual', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, true);
    const sst = mockSst(t, false);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_MASTER })).get('/protegida');

    assert.equal(resposta.status, 200);
    assert.equal(sst.mock.calls.length, 0);
    assert.equal(autorizacaoIndividual.mock.calls.length, 0, 'MASTER nunca consulta usuario_autorizacoes, mesmo em modo OBRIGATORIA');
  });

  test('MASTER sem permissão explícita: 403, mesmo com autorização individual concedida — sem bypass', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_MASTER })).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('MASTER com permissão do perfil mas bloqueio individual: 403', async (t) => {
    mockConfiguracaoAcao(t);
    mockPermissaoAcao(t, true);
    mockBloqueio(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_MASTER })).get('/protegida');

    assert.equal(resposta.status, 403);
    assert.equal(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('MASTER nunca consulta grupo, mesmo em modo ALTERNATIVA com um grupo que negaria a ação', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, true);
    const grupo = mockGrupo(t, { ativo: true });
    const permissaoGrupo = mockPermissaoAcaoGrupo(t, false);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_MASTER })).get('/protegida');

    assert.equal(resposta.status, 200, 'MASTER usa só a permissão empresarial de perfil, sem restrição de grupo');
    assert.equal(grupo.mock.calls.length, 0);
    assert.equal(permissaoGrupo.mock.calls.length, 0);
  });
});

describe('criarExigirPermissaoAcao — identidade confiável', () => {
  test('empresaId, usuarioId e perfil chegam a todos os métodos exclusivamente do contexto autenticado', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'ALTERNATIVA' });
    const permissao = mockPermissaoAcao(t, false);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, true);
    const sst = mockSst(t, true);
    const bloqueio = mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    await request(montarApp(middleware)).get('/protegida');

    assert.equal(permissao.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(permissao.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.perfil);
    assert.equal(autorizacaoIndividual.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(autorizacaoIndividual.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.id);
    assert.equal(sst.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(sst.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.id);
    assert.equal(bloqueio.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(bloqueio.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.id);
  });

  test('valores falsificados em query, body e headers não substituem a identidade do contexto', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    const permissao = mockPermissaoAcao(t, true);
    const bloqueio = mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    await request(montarApp(middleware))
      .get('/protegida?empresaId=999&usuarioId=999&perfil=MASTER')
      .set('X-Empresa-Id', '999')
      .set('X-Usuario-Id', '999')
      .set('X-Perfil', 'MASTER')
      .send();

    assert.equal(permissao.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(permissao.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.perfil);
    assert.equal(bloqueio.mock.calls[0].arguments[1], CONTEXTO_PADRAO.empresa.id);
    assert.equal(bloqueio.mock.calls[0].arguments[2], CONTEXTO_PADRAO.usuario.id);
  });

  test('código de ação enviado a todos os métodos é exatamente o configurado na fábrica', async (t) => {
    const configuracao = mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'ALTERNATIVA' });
    const permissao = mockPermissaoAcao(t, false);
    const autorizacaoIndividual = mockAutorizacaoIndividual(t, true);
    const sst = mockSst(t, true);
    const bloqueio = mockBloqueio(t, false);
    const outraAcao = 'MOVIMENTAR_ESTOQUE';
    const middleware = criarExigirPermissaoAcao({ pool: {} }, outraAcao);

    await request(montarApp(middleware)).get('/protegida');

    assert.equal(configuracao.mock.calls[0].arguments[1], outraAcao);
    assert.equal(permissao.mock.calls[0].arguments[3], outraAcao);
    assert.equal(autorizacaoIndividual.mock.calls[0].arguments[3], outraAcao);
    assert.equal(bloqueio.mock.calls[0].arguments[3], outraAcao);
    assert.equal(sst.mock.calls.length, 1, 'usuarioIntegraSst não recebe acaoCodigo — SST é por usuário/empresa, não por ação');
  });

  test('contexto autenticado totalmente ausente não consulta o banco', async (t) => {
    const configuracao = mockConfiguracaoAcao(t);
    const permissao = mockPermissaoAcao(t, true);
    const bloqueio = mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { comContexto: false })).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.equal(configuracao.mock.calls.length, 0);
    assert.equal(permissao.mock.calls.length, 0);
    assert.equal(bloqueio.mock.calls.length, 0);
    assert.notEqual(resposta.body.codigo, 'PERMISSAO_NEGADA');
  });

  test('contexto incompleto (sem req.empresa) não consulta o banco', async (t) => {
    const configuracao = mockConfiguracaoAcao(t);
    const permissao = mockPermissaoAcao(t, true);
    const bloqueio = mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { comSessaoParcial: true })).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.equal(configuracao.mock.calls.length, 0);
    assert.equal(permissao.mock.calls.length, 0);
    assert.equal(bloqueio.mock.calls.length, 0);
  });

  test('contexto incompleto (usuario sem id) não consulta o banco, mesmo com perfil e empresa presentes', async (t) => {
    const configuracao = mockConfiguracaoAcao(t);
    const permissao = mockPermissaoAcao(t, true);
    const bloqueio = mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware, { contexto: CONTEXTO_SEM_USUARIO_ID })).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.equal(configuracao.mock.calls.length, 0);
    assert.equal(permissao.mock.calls.length, 0);
    assert.equal(bloqueio.mock.calls.length, 0);
    assert.notEqual(resposta.body.codigo, 'PERMISSAO_NEGADA', 'usuario.id ausente é erro de contexto, não decisão de negócio');
  });

  test('não altera req.usuario, req.empresa nem req.sessao', async (t) => {
    mockConfiguracaoAcao(t);
    mockPermissaoAcao(t, true);
    mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.deepEqual(resposta.body.usuario, CONTEXTO_PADRAO.usuario);
    assert.deepEqual(resposta.body.empresa, CONTEXTO_PADRAO.empresa);
    assert.deepEqual(resposta.body.sessao, { id: '555' });
  });
});

describe('criarExigirPermissaoAcao — erros inesperados', () => {
  test('falha inesperada em buscarConfiguracaoAcao propaga (500), não vira 403 nem autoriza', async (t) => {
    t.mock.method(permissaoRepo, 'buscarConfiguracaoAcao', async () => { throw new Error('conexão perdida com o banco'); });
    const permissao = mockPermissaoAcao(t, true);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.equal(permissao.mock.calls.length, 0, 'falha na primeira consulta não pode levar às demais');
  });

  test('falha inesperada em buscarPermissaoAcao propaga (500), não vira 403 nem autoriza', async (t) => {
    mockConfiguracaoAcao(t);
    t.mock.method(permissaoRepo, 'buscarPermissaoAcao', async () => { throw new Error('conexão perdida com o banco'); });
    const bloqueio = mockBloqueio(t, false);
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
    assert.equal(bloqueio.mock.calls.length, 0, 'falha na consulta de permissão não pode levar ao bloqueio');
  });

  test('falha inesperada em usuarioTemAutorizacaoIndividual propaga (500)', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, null);
    t.mock.method(permissaoRepo, 'usuarioTemAutorizacaoIndividual', async () => { throw new Error('timeout ao consultar usuario_autorizacoes'); });
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('falha inesperada em buscarGrupoAcessoDoUsuario propaga (500), em modo ALTERNATIVA', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, false);
    t.mock.method(permissaoRepo, 'buscarGrupoAcessoDoUsuario', async () => { throw new Error('timeout ao consultar grupos_acesso'); });
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('falha inesperada em buscarPermissaoAcaoGrupo propaga (500), em modo ALTERNATIVA', async (t) => {
    mockConfiguracaoAcao(t, { modoAutorizacaoIndividual: 'ALTERNATIVA' });
    mockPermissaoAcao(t, false);
    mockGrupo(t, { ativo: true });
    t.mock.method(permissaoRepo, 'buscarPermissaoAcaoGrupo', async () => { throw new Error('timeout ao consultar grupo_permissoes_acao'); });
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('falha inesperada em usuarioIntegraSst propaga (500)', async (t) => {
    mockConfiguracaoAcao(t, { exigeSst: true, modoAutorizacaoIndividual: 'OBRIGATORIA' });
    mockPermissaoAcao(t, null);
    mockAutorizacaoIndividual(t, true);
    t.mock.method(permissaoRepo, 'usuarioIntegraSst', async () => { throw new Error('timeout ao consultar vinculo_sst'); });
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });

  test('falha inesperada em usuarioTemBloqueio propaga (500), não vira 403 nem autoriza', async (t) => {
    mockConfiguracaoAcao(t);
    mockPermissaoAcao(t, true);
    t.mock.method(permissaoRepo, 'usuarioTemBloqueio', async () => { throw new Error('timeout ao consultar usuario_bloqueios'); });
    const middleware = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const resposta = await request(montarApp(middleware)).get('/protegida');

    assert.equal(resposta.status, 500);
    assert.deepEqual(resposta.body, { status: 'error', codigo: 'ERRO_INTERNO', message: 'Erro interno do servidor' });
  });
});

describe('criarExigirPermissaoRecurso e criarExigirPermissaoAcao — coexistência', () => {
  test('criarExigirPermissaoRecurso continua com o mesmo comportamento após a adição de criarExigirPermissaoAcao', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    const middleware = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');

    assert.equal((await request(montarApp(middleware)).get('/protegida')).status, 200);
  });

  test('os dois middlewares aplicados em sequência (recurso, depois ação) compõem sem interferência', async (t) => {
    t.mock.method(permissaoRepo, 'buscarPermissaoRecurso', async () => permissaoRecurso({ podeVisualizar: true }));
    mockConfiguracaoAcao(t);
    mockPermissaoAcao(t, true);
    mockBloqueio(t, false);
    const exigirRecurso = criarExigirPermissaoRecurso({ pool: {} }, RECURSO, 'visualizar');
    const exigirAcao = criarExigirPermissaoAcao({ pool: {} }, ACAO);

    const app = criarAppTeste((expressApp) => {
      expressApp.get('/protegida-dupla', (req, res, next) => {
        req.usuario = CONTEXTO_PADRAO.usuario;
        req.empresa = CONTEXTO_PADRAO.empresa;
        next();
      }, exigirRecurso, exigirAcao, (req, res) => {
        res.json({ ok: true });
      });
    });

    const resposta = await request(app).get('/protegida-dupla');

    assert.equal(resposta.status, 200);
    assert.deepEqual(resposta.body, { ok: true });
  });
});
