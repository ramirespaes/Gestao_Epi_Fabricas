'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarUsuarioAdministracaoController } = require('../../src/controllers/usuario-administracao.controller');
const { criarUsuarioAdministracaoRoutes } = require('../../src/routes/usuario-administracao.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Parte F — administração de usuários da empresa: listar, consultar,
 * alterar nome e perfil, inativar e reativar. Autoridade pelo ponto único
 * (MASTER, ou ADMINISTRADOR com GERENCIAR_USUARIOS), regras de perfil D3,
 * proteção do último MASTER sob concorrência, isolamento A × B e
 * auditoria sem segredos. PostgreSQL real, schema temporário.
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 48 }, (_, i) => String(i).padStart(3, '0'));
const SENHA = 'senha-forte-da-parte-f-2026';
const BASE = '/api/administracao/usuarios';
const { cookieNome: C_EMPRESA, cookieNomeGlobal: C_GLOBAL } = authConfig.sessao;
const PERFIS = ['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO'];
const CAMPOS_DO_ITEM = ['ativo', 'criadoEm', 'email', 'grupo', 'id', 'nome', 'perfil', 'podeGerenciar', 'proprio'];

function cookiesDe(resposta) {
  const saida = {};
  for (const bruto of resposta.headers['set-cookie'] || []) {
    const [par] = bruto.split(';');
    const i = par.indexOf('=');
    saida[par.slice(0, i)] = par.slice(i + 1);
  }
  return saida;
}

describe('Parte F — administração de usuários (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let hash;
  const empresa = {};
  const u = {};
  const email = {};
  const cookie = {};
  const segredos = [];

  const q = (sql, params) => pool.query(sql, params);
  const get = (quem, rota) => request(app).get(rota).set('Cookie', cookie[quem]);
  const patch = (quem, id, corpo, ua) => {
    const r = request(app).patch(`${BASE}/${id}`).set('Cookie', cookie[quem]);
    if (ua) r.set('User-Agent', ua);
    return r.send(corpo);
  };
  const post = (quem, id, acao) => request(app).post(`${BASE}/${id}/${acao}`).set('Cookie', cookie[quem]).send({});
  const listar = (quem, query = '?limite=100') => get(quem, `${BASE}${query}`);
  const linha = async (id) => (await q('SELECT id, empresa_id, nome, perfil, ativo, identidade_id, grupo_acesso_id FROM usuarios WHERE id = $1', [id])).rows[0];
  const mastersAtivos = async (empresaId) => (await q("SELECT count(*)::int AS n FROM usuarios WHERE empresa_id = $1 AND perfil = 'MASTER' AND ativo", [empresaId])).rows[0].n;
  const auditorias = async (acao, referencia) => (await q(
    'SELECT empresa_id, usuario_id, acao, referencia, contexto, dados_anteriores, dados_novos, dispositivo FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id',
    [acao, String(referencia)],
  )).rows;

  async function entrar(chave) {
    const login = await request(app).post('/api/auth/global/login').send({ email: email[chave], senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const c = cookiesDe(login);
    segredos.push(c[C_GLOBAL]);
    if (c[C_EMPRESA]) segredos.push(c[C_EMPRESA]);
    return { login, c };
  }

  async function entrarNaEmpresa(chave, empresaId, destino = chave) {
    const { c } = await entrar(chave);
    let empresarial = c[C_EMPRESA];
    if (!empresarial) {
      const sel = await request(app).post(`/api/auth/global/empresas/${empresaId}/selecionar`).set('Cookie', `${C_GLOBAL}=${c[C_GLOBAL]}`).send();
      assert.equal(sel.status, 200, JSON.stringify(sel.body));
      empresarial = cookiesDe(sel)[C_EMPRESA];
      segredos.push(empresarial);
    }
    cookie[destino] = `${C_GLOBAL}=${c[C_GLOBAL]}; ${C_EMPRESA}=${empresarial}`;
  }

  async function novaIdentidade(chave) {
    email[chave] = `${chave.toLowerCase()}.f@exemplo-cliente.com.br`;
    return (await q('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email[chave], hash])).rows[0].id;
  }

  async function vinculo(chave, empresaId, perfil, { nome = chave, identidadeId = null, ativo = true } = {}) {
    const identidade = identidadeId ?? await novaIdentidade(chave);
    const id = (await q(
      'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id, ativo) VALUES ($1, $2, NULL, NULL, $3, $4, $5) RETURNING id',
      [empresaId, nome, perfil, identidade, ativo],
    )).rows[0].id;
    return { id, identidade };
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    hash = await gerarHashSenha(SENHA);

    for (const [k, nome, cnpj] of [
      ['A', 'Empresa Alfa F', '11222333000181'], ['B', 'Empresa Beta F', '22333444000100'],
      ['C', 'Empresa Gama F', '33444555000102'], ['D', 'Empresa Delta F', '44555666000162'],
    ]) {
      empresa[k] = (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [nome, cnpj])).rows[0].id;
    }

    for (const [chave, perfil, nome] of [
      ['masterA', 'MASTER', 'Marta Master'], ['master2A', 'MASTER', 'Mauro Master'],
      ['admA', 'ADMINISTRADOR', 'Adriana Admin'], ['adm2A', 'ADMINISTRADOR', 'Alberto Admin'], ['adm3A', 'ADMINISTRADOR', 'Amanda Admin'],
      ['supA', 'SUPERVISOR', 'Sérgio Supervisor'], ['usuA', 'USUARIO', 'Úrsula Usuária'], ['usu2A', 'USUARIO', 'Ubirajara Usuário'],
      ['especialA', 'USUARIO', 'Ana 100%_teste'],
    ]) {
      u[chave] = (await vinculo(chave, empresa.A, perfil, { nome })).id;
    }
    u.inativoA = (await vinculo('inativoA', empresa.A, 'USUARIO', { nome: 'Ivo Inativo', ativo: false })).id;

    const multi = await vinculo('multi', empresa.A, 'USUARIO', { nome: 'Múltipla em A' });
    u.multiA = multi.id;
    u.multiB = (await vinculo('multi', empresa.B, 'USUARIO', { nome: 'Múltipla em B', identidadeId: multi.identidade })).id;

    u.masterB = (await vinculo('masterB', empresa.B, 'MASTER', { nome: 'Beto Master' })).id;
    u.usuB = (await vinculo('usuB', empresa.B, 'USUARIO', { nome: 'Úrsula de B' })).id;
    u.masterC1 = (await vinculo('masterC1', empresa.C, 'MASTER', { nome: 'Carla Master' })).id;
    u.masterC2 = (await vinculo('masterC2', empresa.C, 'MASTER', { nome: 'Caio Master' })).id;
    u.masterD = (await vinculo('masterD', empresa.D, 'MASTER', { nome: 'Dora Única' })).id;

    // Grupo de acesso de A (ativo) e um inativo; o vínculo fica na tela de integrantes.
    const grupoA = (await q("INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, 'Almoxarifado F', true, $2) RETURNING id", [empresa.A, u.masterA])).rows[0].id;
    const grupoAntigo = (await q("INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, 'Antigo F', false, $2) RETURNING id", [empresa.A, u.masterA])).rows[0].id;
    await q('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = $1', [u.usuA, grupoA]);
    await q('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = $1', [u.supA, grupoAntigo]);

    // Autorização nominal do MASTER, como a tela de autorizações faria.
    for (const chave of ['admA', 'adm3A']) {
      await q("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'GERENCIAR_USUARIOS', $3)", [empresa.A, u[chave], u.masterA]);
    }

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao }),
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
        criarUsuarioAdministracaoRoutes({ controller: criarUsuarioAdministracaoController({ pool }), exigirSessao }),
      );
    });

    for (const chave of ['masterA', 'master2A', 'admA', 'adm2A', 'adm3A', 'supA', 'usuA', 'usu2A', 'masterB', 'usuB', 'masterC1', 'masterC2', 'masterD']) {
      await entrarNaEmpresa(chave, null);
    }
    await entrarNaEmpresa('multi', empresa.A, 'multiA');
    await entrarNaEmpresa('multi', empresa.B, 'multiB');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('listagem', () => {
    test('MASTER lista só a própria empresa, com o e-mail da conta e sem credencial nem dado interno', async () => {
      const r = await listar('masterA');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const idsA = (await q('SELECT id FROM usuarios WHERE empresa_id = $1 ORDER BY id', [empresa.A])).rows.map((l) => l.id);
      assert.deepEqual(r.body.usuarios.map((x) => x.id).sort((a, b) => a - b), idsA);
      assert.equal(r.body.total, idsA.length);
      for (const item of r.body.usuarios) assert.deepEqual(Object.keys(item).sort(), CAMPOS_DO_ITEM);
      const marta = r.body.usuarios.find((x) => x.id === u.masterA);
      assert.deepEqual([marta.email, marta.perfil, marta.ativo, marta.proprio], [email.masterA, 'MASTER', true, true]);
      assert.equal(r.body.usuarios.find((x) => x.id === u.multiA).nome, 'Múltipla em A');
      const grupoDe = (id) => r.body.usuarios.find((x) => x.id === id).grupo;
      assert.deepEqual([grupoDe(u.usuA), grupoDe(u.supA), grupoDe(u.masterA)], [{ nome: 'Almoxarifado F', ativo: true }, { nome: 'Antigo F', ativo: false }, null]);
      assert.equal(r.body.mastersAtivos, 2);
      assert.deepEqual(r.body.perfisGerenciaveis, PERFIS);
      const texto = JSON.stringify(r.body);
      assert.doesNotMatch(texto, /senha|hash|argon|token|cookie|sessao|identidade/i);
      assert.doesNotMatch(texto, /Beta|Úrsula de B|Múltipla em B|Carla|Dora/);
    });

    test('paginação no backend, com total, páginas e limite máximo 100', async () => {
      const total = (await listar('masterA')).body.total;
      const p1 = await listar('masterA', '?limite=2&pagina=1');
      const p2 = await listar('masterA', '?limite=2&pagina=2');
      assert.deepEqual([p1.status, p1.body.usuarios.length, p1.body.total, p1.body.paginas], [200, 2, total, Math.ceil(total / 2)]);
      assert.equal(p2.body.usuarios.length, 2);
      assert.equal(p1.body.usuarios.some((x) => p2.body.usuarios.some((y) => y.id === x.id)), false);
      for (const query of ['?limite=101', '?limite=0', '?pagina=0', '?limite=abc', '?pagina=1e2']) {
        assert.equal((await listar('masterA', query)).status, 400, query);
      }
    });

    test('busca por nome e e-mail sem diferenciar maiúsculas; % e _ são texto, não curinga', async () => {
      const nomes = async (busca) => (await listar('masterA', `?limite=100&busca=${encodeURIComponent(busca)}`)).body.usuarios.map((x) => x.nome);
      assert.deepEqual(await nomes('ANA 100%'), ['Ana 100%_teste']);
      assert.deepEqual(await nomes('%'), ['Ana 100%_teste']);
      assert.deepEqual(await nomes('_'), ['Ana 100%_teste']);
      assert.deepEqual(await nomes('SUPA.F@EXEMPLO'), ['Sérgio Supervisor']);
      assert.deepEqual(await nomes("' OR 1=1 --"), []);
      assert.equal((await listar('masterA', `?busca=${'x'.repeat(101)}`)).status, 400);
    });

    test('filtros de situação e perfil; ordem só entre as opções fixas', async () => {
      const r = async (query) => listar('masterA', `?limite=100&${query}`);
      assert.deepEqual((await r('situacao=INATIVO')).body.usuarios.map((x) => x.id), [u.inativoA]);
      assert.equal((await r('situacao=ATIVO')).body.usuarios.some((x) => x.id === u.inativoA), false);
      assert.deepEqual((await r('perfil=MASTER')).body.usuarios.map((x) => x.id).sort((a, b) => a - b), [u.masterA, u.master2A].sort((a, b) => a - b));
      const crescente = (await r('ordem=nome')).body.usuarios.map((x) => x.id);
      const decrescente = (await r('ordem=nome_desc')).body.usuarios.map((x) => x.id);
      assert.deepEqual(decrescente, [...crescente].reverse());
      for (const query of ['ordem=id', 'ordem=nome%3B%20DROP%20TABLE%20usuarios', 'situacao=xyz', 'perfil=ROOT', 'empresaId=2', 'empresa_id=2']) {
        assert.equal((await r(query)).status, 400, query);
      }
    });

    test('ADMINISTRADOR autorizado lista e vê o que pode gerenciar; sem autorização, SUPERVISOR e USUARIO recebem 403', async () => {
      const r = await listar('admA');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.perfisGerenciaveis, ['SUPERVISOR', 'USUARIO']);
      const pode = Object.fromEntries(r.body.usuarios.map((x) => [x.id, x.podeGerenciar]));
      assert.deepEqual([pode[u.masterA], pode[u.adm2A], pode[u.admA], pode[u.supA], pode[u.usuA]], [false, false, false, true, true]);
      for (const quem of ['adm2A', 'supA', 'usuA']) {
        const negado = await listar(quem);
        assert.deepEqual([negado.status, negado.body.codigo], [403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA'], quem);
      }
      assert.equal((await request(app).get(BASE)).status, 401);
    });
  });

  describe('consulta por id e isolamento A × B', () => {
    test('usuário da própria empresa: 200; de outra empresa ou inexistente: 404 idêntico', async () => {
      const ok = await get('masterA', `${BASE}/${u.usuA}`);
      assert.deepEqual([ok.status, ok.body.usuario.id, ok.body.usuario.email], [200, u.usuA, email.usuA]);
      const deB = await get('masterA', `${BASE}/${u.usuB}`);
      const inexistente = await get('masterA', `${BASE}/2147483000`);
      assert.deepEqual([deB.status, inexistente.status], [404, 404]);
      assert.deepEqual(deB.body, inexistente.body);
      assert.equal(deB.body.codigo, 'USUARIO_NAO_ENCONTRADO');
      assert.doesNotMatch(JSON.stringify(deB.body), /Úrsula de B|Beta/);
      assert.equal((await get('masterA', `${BASE}/abc`)).status, 400);
    });

    test('IDOR: MASTER de B não altera, inativa nem reativa usuário de A, e nada muda em A', async () => {
      const antes = await linha(u.usuA);
      const respostas = [
        await patch('masterB', u.usuA, { nome: 'Invadido' }),
        await patch('masterB', u.usuA, { tipoConta: 'MASTER' }),
        await post('masterB', u.usuA, 'inativar'),
        await post('masterB', u.inativoA, 'reativar'),
      ];
      const inexistente = await patch('masterB', 2147483000, { nome: 'X' });
      for (const r of respostas) {
        assert.equal(r.status, 404);
        assert.deepEqual(r.body, inexistente.body);
      }
      assert.deepEqual(await linha(u.usuA), antes);
      assert.equal((await linha(u.inativoA)).ativo, false);
    });
  });

  describe('edição de nome e perfil', () => {
    test('MASTER altera o nome; auditoria USUARIO_ALTERADO só com o nome antes e depois', async () => {
      const r = await patch('masterA', u.usu2A, { nome: '  Ubirajara   Silva  ' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.usuario.nome, r.body.alterado], ['Ubirajara   Silva', true]);
      const [a] = await auditorias('USUARIO_ALTERADO', u.usu2A);
      assert.deepEqual([a.empresa_id, a.usuario_id], [empresa.A, u.masterA]);
      assert.deepEqual([a.dados_anteriores, a.dados_novos], [{ nome: 'Ubirajara Usuário' }, { nome: 'Ubirajara   Silva' }]);
      const repetido = await patch('masterA', u.usu2A, { nome: 'Ubirajara   Silva' });
      assert.deepEqual([repetido.status, repetido.body.alterado], [200, false]);
      assert.equal((await auditorias('USUARIO_ALTERADO', u.usu2A)).length, 1, 'sem mudança, sem auditoria');
    });

    test('mass assignment: qualquer campo fora de nome e perfil é recusado e nada muda', async () => {
      const antes = await linha(u.usuA);
      for (const corpo of [
        { email: 'outro@x.com' }, { ativo: false }, { empresaId: empresa.B }, { empresa_id: empresa.B }, { identidadeId: 1 },
        { senha: 'nova-senha-muito-forte' }, { senhaHash: 'x' }, { grupoAcessoId: 1 }, { id: u.masterA }, { nome: 'Válido', ativo: false }, {},
        // O perfil do alvo viaja como tipoConta; "perfil" no corpo é campo de autoridade.
        { perfil: 'MASTER' }, { usuarioId: u.masterA }, { master: true }, { permissoes: { materials: true } },
      ]) {
        const r = await patch('masterA', u.usuA, corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo));
        assert.doesNotMatch(JSON.stringify(r.body), /nova-senha-muito-forte|outro@x\.com/);
      }
      assert.deepEqual(await linha(u.usuA), antes);
    });

    test('nome inválido: vazio, só espaços, acima de 150 caracteres ou com caractere de controle', async () => {
      for (const nome of ['', '   ', 'x'.repeat(151), 'Nome\u0000Nulo', 'Linha\nQuebrada']) {
        assert.equal((await patch('masterA', u.usuA, { nome })).status, 400, JSON.stringify(nome));
      }
      assert.equal((await patch('masterA', u.usuA, { nome: 'é'.repeat(150) })).status, 200);
      assert.equal((await patch('masterA', u.usuA, { nome: 'Úrsula Usuária' })).status, 200);
    });

    test('XSS no nome é guardado como texto e devolvido igual, sempre em JSON', async () => {
      const carga = '<img src=x onerror=alert(1)><script>alert(2)</script>';
      const r = await patch('masterA', u.especialA, { nome: carga });
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'], /application\/json/);
      assert.equal((await get('masterA', `${BASE}/${u.especialA}`)).body.usuario.nome, carga);
      assert.equal((await patch('masterA', u.especialA, { nome: 'Ana 100%_teste' })).status, 200);
    });

    test('D3: MASTER muda o perfil de qualquer um; auditoria USUARIO_PERFIL_ALTERADO só com o perfil', async () => {
      const r = await patch('masterA', u.supA, { tipoConta: 'ADMINISTRADOR' });
      assert.deepEqual([r.status, r.body.usuario.perfil], [200, 'ADMINISTRADOR']);
      assert.equal((await patch('masterA', u.supA, { tipoConta: 'SUPERVISOR' })).status, 200);
      const registros = await auditorias('USUARIO_PERFIL_ALTERADO', u.supA);
      assert.deepEqual(registros.map((a) => [a.dados_anteriores, a.dados_novos]), [
        [{ perfil: 'SUPERVISOR' }, { perfil: 'ADMINISTRADOR' }], [{ perfil: 'ADMINISTRADOR' }, { perfil: 'SUPERVISOR' }],
      ]);
      assert.equal((await patch('masterA', u.supA, { tipoConta: 'ROOT' })).status, 400);
    });

    test('D3: ADMINISTRADOR autorizado gerencia só SUPERVISOR e USUARIO', async () => {
      assert.equal((await patch('admA', u.usuA, { tipoConta: 'SUPERVISOR' })).status, 200);
      assert.equal((await patch('admA', u.usuA, { tipoConta: 'USUARIO', nome: 'Úrsula Usuária' })).status, 200);
      const antes = await Promise.all([u.usuA, u.masterA, u.adm2A].map(linha));
      for (const [alvo, corpo] of [
        [u.usuA, { tipoConta: 'ADMINISTRADOR' }], [u.usuA, { tipoConta: 'MASTER' }],
        [u.masterA, { nome: 'Outro nome' }], [u.adm2A, { nome: 'Outro nome' }], [u.adm2A, { tipoConta: 'USUARIO' }],
      ]) {
        const r = await patch('admA', alvo, corpo);
        assert.deepEqual([r.status, r.body.codigo], [403, 'USUARIO_PERFIL_NAO_PERMITIDO'], JSON.stringify(corpo));
      }
      assert.deepEqual(await Promise.all([u.usuA, u.masterA, u.adm2A].map(linha)), antes);
      assert.equal((await patch('adm2A', u.usuA, { nome: 'Sem autorização' })).status, 403);
      assert.equal((await patch('supA', u.usuA, { nome: 'Supervisor' })).status, 403);
    });

    test('rebaixamento vale na hora: o ADMINISTRADOR rebaixado perde a administração de usuários', async () => {
      assert.equal((await listar('adm3A')).status, 200);
      assert.equal((await patch('masterA', u.adm3A, { tipoConta: 'USUARIO' })).status, 200);
      assert.equal((await listar('adm3A')).status, 403);
    });
  });

  describe('inativação e reativação', () => {
    test('inativar preserva o vínculo, revoga as sessões dele nesta empresa e audita', async () => {
      assert.equal((await get('usu2A', '/api/auth/me')).status, 200);
      const r = await post('masterA', u.usu2A, 'inativar');
      assert.deepEqual([r.status, r.body.usuario.ativo], [200, false]);
      assert.equal((await linha(u.usu2A)).ativo, false, 'o vínculo continua existindo');
      assert.equal((await get('usu2A', '/api/auth/me')).status, 401);
      const [a] = await auditorias('USUARIO_INATIVADO', u.usu2A);
      assert.deepEqual([a.usuario_id, a.dados_anteriores, a.dados_novos], [u.masterA, { ativo: true }, { ativo: false }]);
      const repetido = await post('masterA', u.usu2A, 'inativar');
      assert.deepEqual([repetido.status, repetido.body.codigo], [409, 'USUARIO_JA_INATIVO']);
    });

    test('pessoa com vínculo em A e em B: inativar em A não afeta a sessão nem o acesso em B', async () => {
      assert.equal((await post('masterA', u.multiA, 'inativar')).status, 200);
      assert.equal((await get('multiA', '/api/auth/me')).status, 401);
      assert.equal((await get('multiB', '/api/auth/me')).status, 200);
      assert.equal((await linha(u.multiB)).ativo, true);
      const { login } = await entrar('multi');
      assert.deepEqual(login.body.empresas.map((e) => e.id), [empresa.B]);
    });

    test('reativar devolve o MESMO vínculo, audita, e a pessoa volta a entrar', async () => {
      const r = await post('masterA', u.usu2A, 'reativar');
      assert.deepEqual([r.status, r.body.usuario.id, r.body.usuario.ativo], [200, u.usu2A, true]);
      assert.equal((await q('SELECT count(*)::int AS n FROM usuarios WHERE identidade_id = (SELECT identidade_id FROM usuarios WHERE id = $1)', [u.usu2A])).rows[0].n, 1);
      const [a] = await auditorias('USUARIO_REATIVADO', u.usu2A);
      assert.deepEqual([a.dados_anteriores, a.dados_novos], [{ ativo: false }, { ativo: true }]);
      await entrarNaEmpresa('usu2A', null);
      assert.equal((await get('usu2A', '/api/auth/me')).status, 200);
      const repetido = await post('masterA', u.usu2A, 'reativar');
      assert.deepEqual([repetido.status, repetido.body.codigo], [409, 'USUARIO_JA_ATIVO']);
      assert.equal((await post('masterA', u.multiA, 'reativar')).status, 200);
    });

    test('D3: ADMINISTRADOR autorizado inativa e reativa SUPERVISOR e USUARIO, nunca MASTER nem ADMINISTRADOR', async () => {
      assert.equal((await post('admA', u.supA, 'inativar')).status, 200);
      assert.equal((await post('admA', u.supA, 'reativar')).status, 200);
      for (const alvo of [u.masterA, u.master2A, u.adm2A]) {
        const r = await post('admA', alvo, 'inativar');
        assert.deepEqual([r.status, r.body.codigo], [403, 'USUARIO_PERFIL_NAO_PERMITIDO']);
        assert.equal((await linha(alvo)).ativo, true);
      }
      await entrarNaEmpresa('supA', null);
    });
  });

  describe('último MASTER', () => {
    test('o único MASTER ativo não pode ser inativado nem rebaixado, nem por ele mesmo', async () => {
      for (const r of [await patch('masterD', u.masterD, { tipoConta: 'ADMINISTRADOR' }), await post('masterD', u.masterD, 'inativar')]) {
        assert.deepEqual([r.status, r.body.codigo], [409, 'USUARIO_ULTIMO_MASTER']);
      }
      assert.deepEqual([(await linha(u.masterD)).perfil, (await linha(u.masterD)).ativo, await mastersAtivos(empresa.D)], ['MASTER', true, 1]);
      assert.equal((await patch('masterD', u.masterD, { nome: 'Dora Única Master' })).status, 200, 'o nome continua editável');
    });

    test('com dois MASTERs, um rebaixa o outro; o que sobra passa a ser protegido', async () => {
      assert.equal((await patch('masterC1', u.masterC2, { tipoConta: 'ADMINISTRADOR' })).status, 200);
      const r = await post('masterC1', u.masterC1, 'inativar');
      assert.deepEqual([r.status, r.body.codigo], [409, 'USUARIO_ULTIMO_MASTER']);
      assert.equal((await patch('masterC1', u.masterC2, { tipoConta: 'MASTER' })).status, 200);
      assert.equal(await mastersAtivos(empresa.C), 2);
    });

    test('concorrência: inativações e rebaixamentos simultâneos nunca deixam a empresa sem MASTER', async () => {
      const cenarios = [
        () => [post('masterC1', u.masterC1, 'inativar'), post('masterC2', u.masterC2, 'inativar')],
        () => [post('masterC1', u.masterC2, 'inativar'), post('masterC2', u.masterC1, 'inativar')],
        () => [patch('masterC1', u.masterC1, { tipoConta: 'USUARIO' }), patch('masterC2', u.masterC2, { tipoConta: 'USUARIO' })],
        () => [patch('masterC1', u.masterC2, { tipoConta: 'SUPERVISOR' }), patch('masterC2', u.masterC1, { tipoConta: 'SUPERVISOR' })],
      ];
      for (let rodada = 0; rodada < 3; rodada += 1) {
        for (const [i, cenario] of cenarios.entries()) {
          await q("UPDATE usuarios SET perfil = 'MASTER', ativo = true WHERE id = ANY($1::int[])", [[u.masterC1, u.masterC2]]);
          await entrarNaEmpresa('masterC1', null);
          await entrarNaEmpresa('masterC2', null);
          const respostas = await Promise.all(cenario());
          const sucessos = respostas.filter((r) => r.status === 200).length;
          assert.equal(sucessos, 1, `rodada ${rodada}, cenário ${i}: ${respostas.map((r) => r.status)}`);
          for (const r of respostas.filter((x) => x.status !== 200)) assert.ok([401, 403, 409].includes(r.status), `status ${r.status}`);
          assert.equal(await mastersAtivos(empresa.C), 1, `rodada ${rodada}, cenário ${i}`);
        }
      }
      await q("UPDATE usuarios SET perfil = 'MASTER', ativo = true WHERE id = ANY($1::int[])", [[u.masterC1, u.masterC2]]);
    });
  });

  describe('RBAC: grupo e URL direta', () => {
    test('grupo comum não dá autoridade de usuários nem vira MASTER, nem com todas as permissões de recurso e a ação no grupo', async () => {
      const grupo = (await q("INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, 'Tudo F', true, $2) RETURNING id", [empresa.A, u.masterA])).rows[0].id;
      await q(
        `INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir)
         SELECT $1, $2, r, true, true, true, true FROM unnest(ARRAY['newUser', 'userAdmin', 'config']) AS r`,
        [empresa.A, grupo],
      );
      await q("INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, 'GERENCIAR_USUARIOS', true)", [empresa.A, grupo]);
      await q('UPDATE usuarios SET grupo_acesso_id = $2 WHERE id = ANY($1::int[])', [[u.adm2A, u.supA], grupo]);
      for (const quem of ['adm2A', 'supA']) {
        assert.equal((await listar(quem)).status, 403, quem);
        assert.equal((await patch(quem, u.usuA, { nome: 'Pelo grupo' })).status, 403, quem);
      }
      assert.deepEqual([(await linha(u.adm2A)).perfil, (await linha(u.supA)).perfil], ['ADMINISTRADOR', 'SUPERVISOR']);
      await q('UPDATE usuarios SET grupo_acesso_id = NULL WHERE id = ANY($1::int[])', [[u.adm2A, u.supA]]);
    });

    test('URL direta sem autoridade: toda rota da administração responde 403 e nada muda', async () => {
      const antes = await Promise.all([u.usuA, u.inativoA, u.masterA].map(linha));
      const respostas = [
        await get('usuA', BASE), await get('usuA', `${BASE}/${u.usuA}`), await get('usuA', `${BASE}/${u.masterA}`),
        await patch('usuA', u.usuA, { nome: 'Eu mesma' }), await patch('usuA', u.usuA, { tipoConta: 'MASTER' }),
        await post('usuA', u.masterA, 'inativar'), await post('usuA', u.inativoA, 'reativar'),
      ];
      assert.deepEqual(respostas.map((r) => r.status), Array(respostas.length).fill(403));
      for (const r of respostas) assert.equal(r.body.codigo, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA');
      assert.deepEqual(await Promise.all([u.usuA, u.inativoA, u.masterA].map(linha)), antes);
    });
  });

  describe('auditoria, segredos e robustez', () => {
    test('User-Agent longo não derruba a operação: o dispositivo é cortado em 150', async () => {
      const r = await patch('masterA', u.usuA, { nome: 'Úrsula Longa' }, 'Navegador/1.0 '.repeat(40));
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const registros = await auditorias('USUARIO_ALTERADO', u.usuA);
      assert.equal(registros.at(-1).dispositivo.length, 150);
    });

    test('nenhum registro de auditoria da administração de usuários contém senha, hash, token, cookie ou dado de outra empresa', async () => {
      const { rows } = await q("SELECT empresa_id, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao LIKE 'USUARIO\\_%'");
      assert.ok(rows.length >= 8, `registros: ${rows.length}`);
      const texto = JSON.stringify(rows);
      assert.doesNotMatch(texto, /senha|hash|argon|token|cookie|authorization|segredo/i);
      assert.equal(texto.includes(SENHA), false);
      for (const valor of segredos) assert.equal(texto.includes(valor), false, 'valor de cookie na auditoria');
      const idsB = [u.masterB, u.usuB, u.multiB].map(String);
      assert.equal(rows.some((l) => idsB.includes(l.referencia) && l.empresa_id === empresa.A), false);
      assert.equal(rows.filter((l) => l.empresa_id === empresa.B).length, 0, 'nenhuma operação aconteceu em B');
    });
  });
});
