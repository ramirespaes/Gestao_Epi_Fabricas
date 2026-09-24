'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarGrupoAcessoController } = require('../../src/controllers/grupo-acesso.controller');
const { criarGrupoAcessoRoutes } = require('../../src/routes/grupo-acesso.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { corsApi } = require('../../src/middleware/cors');
const { semCache } = require('../../src/middleware/cabecalhos');
const { verificarOrigem } = require('../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { httpConfig } = require('../../src/config/http');
const { gerarHashSenha } = require('../../src/security/password');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiAuth = require('../../../frontend/js/auth-session');

/**
 * Cliente HTTP do frontend contra o backend REAL (Bloco 8, Incremento 8,
 * Etapa 5A, Subetapa 3R): frontend/js/api-http.js e
 * frontend/js/auth-session.js exercitados de ponta a ponta — servidor HTTP
 * de verdade numa porta efêmera, middlewares de produção (CORS,
 * verificação de origem, política de conteúdo JSON), rotas reais de
 * autenticação (Incremento 6) e de grupos (Subetapa 3M), autoridade
 * administrativa da 3Q e PostgreSQL real em schema temporário exclusivo.
 *
 * POR QUE ESTE TESTE VIVE NO BACKEND: ele precisa de `abrirPoolTemporario`,
 * das migrations reais e do app Express — toda a infraestrutura de
 * integração já existente aqui. Os testes que são responsabilidade
 * exclusiva do cliente (montagem da requisição, normalização de erro,
 * recusa de campos de autoridade) ficam em frontend/test/, com fetch
 * injetado e sem banco.
 *
 * A CADEIA DE MIDDLEWARES É A DE PRODUÇÃO, não a mínima de
 * helpers/app-teste.js: o objetivo aqui é justamente provar que o cliente
 * funciona contra CORS com allowlist e contra a verificação de origem
 * (CSRF) que um navegador real enfrenta. Só o pool e o limitador são
 * exclusivos deste arquivo, como em todos os demais testes de integração.
 *
 * O `fetch` injetado faz o que o NAVEGADOR faz e o Node não faz sozinho:
 * envia o cabeçalho Origin e mantém o cookie de sessão entre requisições.
 * Nada disso é papel do código de produção — no navegador o Origin é
 * inforjável e o cookie HttpOnly é anexado automaticamente.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '025', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3r-2026';
const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';

/**
 * fetch com jar de cookies e cabeçalho Origin — o papel do navegador.
 * Guarda os cookies por nome e os reenvia; um Set-Cookie com Max-Age=0
 * (o logout do backend) remove o cookie, como o navegador faria.
 */
function criarFetchDeNavegador(origem) {
  const jar = new Map();

  const fn = async (url, opcoes) => {
    const cabecalhos = { ...(opcoes.headers || {}), Origin: origem };
    if (opcoes.credentials === 'include' && jar.size > 0) {
      cabecalhos.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const resposta = await fetch(url, { ...opcoes, headers: cabecalhos });

    for (const bruto of resposta.headers.getSetCookie()) {
      const [par, ...atributos] = bruto.split(';');
      const separador = par.indexOf('=');
      const nome = par.slice(0, separador).trim();
      const valor = par.slice(separador + 1).trim();
      const expirado = atributos.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expirado) jar.delete(nome); else jar.set(nome, valor);
    }
    return resposta;
  };

  fn.cookies = jar;
  return fn;
}

describe('cliente HTTP do frontend contra o backend real', () => {
  let contexto;
  let pool;
  let servidor;
  let baseUrl;
  let origem;
  let empresaA;
  let masterA;
  let adminA;

  before(async () => {
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;

    const hash = await gerarHashSenha(SENHA);
    assert.equal(await inserirEmpresa(pool, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, CNPJ_B, 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    const empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    const inserirUsuario = async (empresaId, email, perfil) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, true) RETURNING id',
        [empresaId, `Usuário ${email}`, email, hash, perfil],
      );
      return criado[0].id;
    };
    masterA = await inserirUsuario(empresaA, EMAIL_MASTER_A, 'MASTER');
    adminA = await inserirUsuario(empresaA, EMAIL_ADMIN_A, 'ADMINISTRADOR');
    await inserirUsuario(empresaB, 'master-b@demo.safeworkengenharia.com.br', 'MASTER');

    const exigirSessao = criarExigirSessao({ pool });
    const limitador = criarLimitador({ limite: 1000, janelaSegundos: 60 });
    const app = express();
    app.disable('x-powered-by');
    app.use(
      '/api',
      corsApi, semCache, verificarOrigem, exigirJson, parserJson,
      criarAuthRoutes({ controller: criarAuthController({ pool }), limitador, exigirSessao }),
      criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);

    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}/api`;

    // Origem exatamente como a allowlist do backend a canonizou.
    [origem] = httpConfig.cors.origens;
  });

  after(async () => {
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  /** Cada cenário começa com um "navegador" limpo: sem cookie nenhum. */
  function navegadorNovo() {
    const fetchNavegador = criarFetchDeNavegador(origem);
    EpiHttp.configurar({ baseUrl, fetch: fetchNavegador });
    return fetchNavegador;
  }

  const entrarComoMaster = () => EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_MASTER_A, senha: SENHA });

  describe('autenticação real', () => {
    test('login real: 200, identidade da empresa correta e cookie de sessão HttpOnly emitido', async () => {
      const navegador = navegadorNovo();

      const r = await EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_MASTER_A, senha: SENHA });

      assert.equal(r.ok, true);
      assert.equal(r.identidade.usuario.id, masterA);
      assert.equal(r.identidade.usuario.perfil, 'MASTER');
      assert.equal(r.identidade.empresa.id, empresaA);
      assert.equal('senha_hash' in r.identidade.usuario, false, 'o hash nunca chega ao navegador');
      assert.equal(navegador.cookies.size, 1, 'o backend emitiu o cookie de sessão');
    });

    test('o cookie emitido é HttpOnly e o token nunca aparece no corpo da resposta', async () => {
      const navegador = criarFetchDeNavegador(origem);
      const resposta = await navegador(`${baseUrl}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cnpj: CNPJ_A, email: EMAIL_MASTER_A, senha: SENHA }),
      });
      const [setCookie] = resposta.headers.getSetCookie();
      const corpo = await resposta.text();

      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite/i);
      assert.match(setCookie, /Path=\//i);
      const valorDoCookie = setCookie.split(';')[0].split('=')[1];
      assert.equal(corpo.includes(valorDoCookie), false, 'o token só existe no Set-Cookie');
      assert.equal(corpo.includes(SENHA), false);
    });

    test('credencial inválida: 401 genérico, sem revelar se empresa ou usuário existem', async () => {
      navegadorNovo();

      const inexistente = await EpiAuth.entrar({ cnpj: CNPJ_A, email: 'nao-existe@demo.safeworkengenharia.com.br', senha: SENHA });
      const senhaErrada = await EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_MASTER_A, senha: 'senha-errada-desta-vez-2026' });

      assert.equal(inexistente.ok, false);
      assert.equal(senhaErrada.ok, false);
      assert.equal(inexistente.resposta.status, 401);
      assert.equal(senhaErrada.resposta.status, 401);
      assert.equal(inexistente.resposta.codigo, senhaErrada.resposta.codigo, 'as duas causas são indistinguíveis');
      assert.equal(inexistente.resposta.mensagem, senhaErrada.resposta.mensagem);
      assert.equal(EpiAuth.identidade(), null);
    });

    test('corpo inválido é 400 VALIDACAO com detalhes por campo, sem devolver o valor recebido', async () => {
      navegadorNovo();

      const r = await EpiHttp.requisitar('POST', '/auth/login', {
        corpo: { cnpj: 'nao-e-cnpj', email: 'nao-e-email', senha: '' },
      });

      assert.equal(r.status, 400);
      assert.equal(r.codigo, 'VALIDACAO');
      assert.ok(Array.isArray(r.detalhes) && r.detalhes.length > 0);
      assert.equal(JSON.stringify(r.detalhes).includes('nao-e-cnpj'), false);
    });

    test('/auth/me sem sessão é 401; com sessão devolve a identidade; o cookie sobrevive entre requisições', async () => {
      navegadorNovo();

      const semSessao = await EpiAuth.sessaoAtual();
      assert.equal(semSessao.autenticado, false);
      assert.equal(semSessao.resposta.status, 401);
      assert.equal(semSessao.resposta.codigo, 'SESSAO_INVALIDA');

      await entrarComoMaster();
      const comSessao = await EpiAuth.sessaoAtual();

      assert.equal(comSessao.autenticado, true);
      assert.equal(comSessao.identidade.usuario.id, masterA);
    });

    test('logout real revoga a sessão no servidor: a requisição seguinte é 401', async () => {
      const navegador = navegadorNovo();
      await entrarComoMaster();
      assert.equal((await EpiHttp.requisitar('GET', '/grupos-acesso')).ok, true);

      const saida = await EpiAuth.sair();

      assert.equal(saida.ok, true);
      assert.equal(EpiAuth.identidade(), null);
      assert.equal(navegador.cookies.size, 0, 'o navegador descartou o cookie (Max-Age=0)');
      const depois = await EpiHttp.requisitar('GET', '/grupos-acesso');
      assert.equal(depois.status, 401, 'a sessão foi revogada no servidor, não só esquecida no cliente');
    });
  });

  describe('o cliente carrega a autoridade real do backend (3M/3Q)', () => {
    test('MASTER autenticado consome as rotas de grupos da 3M pelo cliente', async () => {
      navegadorNovo();
      await entrarComoMaster();

      const criado = await EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'Almoxarifado 3R' } });
      assert.equal(criado.status, 201);
      assert.equal(criado.dados.grupo.nome, 'Almoxarifado 3R');

      const listado = await EpiHttp.requisitar('GET', '/grupos-acesso');
      assert.equal(listado.ok, true);
      assert.equal(listado.dados.grupos.some((g) => g.id === criado.dados.grupo.id), true);
    });

    test('ADMINISTRADOR sem autorização expressa recebe 403 — o perfil no navegador não autoriza nada', async () => {
      navegadorNovo();
      const entrada = await EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_ADMIN_A, senha: SENHA });
      assert.equal(entrada.ok, true, 'ele autentica normalmente...');
      assert.equal(entrada.identidade.usuario.perfil, 'ADMINISTRADOR');

      const r = await EpiHttp.requisitar('GET', '/grupos-acesso');

      assert.equal(r.status, 403, '...mas não administra');
      assert.equal(r.codigo, 'GRUPO_NAO_AUTORIZADO');
      assert.equal(EpiHttp.ehSemAutorizacao(r), true);
    });

    test('404 e 409 reais chegam distinguíveis à interface', async () => {
      navegadorNovo();
      await entrarComoMaster();

      const inexistente = await EpiHttp.requisitar('GET', '/grupos-acesso/999999');
      assert.equal(EpiHttp.ehNaoEncontrado(inexistente), true);
      assert.equal(inexistente.codigo, 'GRUPO_NAO_ENCONTRADO');

      await EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'Nome Repetido 3R' } });
      const duplicado = await EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'Nome Repetido 3R' } });
      assert.equal(EpiHttp.ehConflito(duplicado), true);
      assert.equal(duplicado.codigo, 'GRUPO_NOME_EM_USO');
    });

    test('campo de autoridade no corpo é barrado no navegador; e, se escapasse, o backend também o recusaria', async () => {
      const navegador = navegadorNovo();
      await entrarComoMaster();

      // Barreira 1 — o cliente nem envia.
      await assert.rejects(
        EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'Forjado', empresaId: 2 } }),
        TypeError,
      );

      // Barreira 2 — contornando o cliente, com a MESMA sessão autenticada
      // (sem o cookie a rota pararia antes, em 401, e nada se provaria
      // sobre a validação do corpo): o backend recusa sozinho, por
      // strictObject.
      const cookie = [...navegador.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const semOCliente = await fetch(`${baseUrl}/grupos-acesso`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origem, Cookie: cookie },
        body: JSON.stringify({ nome: 'Forjado', empresaId: 2 }),
      });
      assert.equal(semOCliente.status, 400);
      assert.equal((await semOCliente.json()).codigo, 'VALIDACAO');
    });

    test('isolamento multiempresa: a sessão de A nunca alcança dados de B', async () => {
      navegadorNovo();
      await entrarComoMaster();
      const daEmpresaA = await EpiHttp.requisitar('POST', '/grupos-acesso', { corpo: { nome: 'Exclusivo de A 3R' } });

      navegadorNovo();
      await EpiAuth.entrar({ cnpj: CNPJ_B, email: 'master-b@demo.safeworkengenharia.com.br', senha: SENHA });
      const tentativa = await EpiHttp.requisitar('GET', `/grupos-acesso/${daEmpresaA.dados.grupo.id}`);

      assert.equal(tentativa.status, 404, 'para a empresa B esse grupo simplesmente não existe');
      const listaDeB = await EpiHttp.requisitar('GET', '/grupos-acesso');
      assert.equal(listaDeB.dados.grupos.some((g) => g.nome === 'Exclusivo de A 3R'), false);
    });
  });

  describe('proteções do navegador que o cliente precisa respeitar', () => {
    test('requisição que altera estado sem Origin é recusada pelo backend (CSRF) — o cliente nunca forja esse cabeçalho', async () => {
      const semOrigem = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cnpj: CNPJ_A, email: EMAIL_MASTER_A, senha: SENHA }),
      });

      assert.equal(semOrigem.status, 403);
      assert.equal((await semOrigem.json()).codigo, 'ORIGEM_AUSENTE');
    });

    test('origem fora da allowlist é recusada mesmo com credenciais válidas', async () => {
      const comOrigemAlheia = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://invasor.example.com' },
        body: JSON.stringify({ cnpj: CNPJ_A, email: EMAIL_MASTER_A, senha: SENHA }),
      });

      assert.equal(comOrigemAlheia.status, 403);
      assert.equal((await comOrigemAlheia.json()).codigo, 'ORIGEM_NAO_PERMITIDA');
    });

    test('o CORS responde com a origem da allowlist e permite credenciais', async () => {
      const resposta = await fetch(`${baseUrl}/auth/me`, { headers: { Origin: origem } });

      assert.equal(resposta.headers.get('access-control-allow-origin'), origem);
      assert.equal(resposta.headers.get('access-control-allow-credentials'), 'true');
    });
  });
});
