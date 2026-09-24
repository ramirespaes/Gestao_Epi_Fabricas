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
const autorizacaoServico = require('../../src/services/autorizacao-individual.service');
const autoridade = require('../../src/services/autoridade-administrativa');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiAuth = require('../../../frontend/js/auth-session');
const EpiGrupos = require('../../../frontend/js/grupos-acesso');

/**
 * Tela de gestão de grupos (Subetapa 3S) contra o backend REAL: o módulo
 * frontend/js/grupos-acesso.js exercitado de ponta a ponta — servidor
 * HTTP de verdade, middlewares de produção (CORS, origem/CSRF, conteúdo),
 * rotas reais da 3M, autoridade da 3Q e PostgreSQL real em schema
 * temporário exclusivo.
 *
 * O que se prova aqui e não dá para provar com fetch falso: que os seis
 * contratos da 3M respondem ao que a tela envia, que o 403 da 3Q aparece
 * para um ADMINISTRADOR sem autorização e some quando o MASTER a concede,
 * que 404/409 reais chegam distinguíveis, e que não existe caminho de
 * exclusão física.
 *
 * O `fetch` injetado faz o papel do navegador (Origin + jar de cookies),
 * como na 3R. A migration 024 é aplicada NESTE SCHEMA TEMPORÁRIO apenas —
 * o banco principal não é tocado.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '025', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3s-2026';
const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';
const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';

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
      if (atributos.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(nome); else jar.set(nome, valor);
    }
    return resposta;
  };
  fn.cookies = jar;
  return fn;
}

describe('tela de grupos de acesso (3S) contra o backend real', () => {
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
    await inserirUsuario(empresaB, EMAIL_MASTER_B, 'MASTER');

    const exigirSessao = criarExigirSessao({ pool });
    const app = express();
    app.disable('x-powered-by');
    app.use(
      '/api',
      corsApi, semCache, verificarOrigem, exigirJson, parserJson,
      criarAuthRoutes({
        controller: criarAuthController({ pool }),
        limitador: criarLimitador({ limite: 1000, janelaSegundos: 60 }),
        exigirSessao,
      }),
      criarGrupoAcessoRoutes({ controller: criarGrupoAcessoController({ pool }), exigirSessao }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);

    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${servidor.address().port}/api`;
    [origem] = httpConfig.cors.origens;
  });

  after(async () => {
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  function navegadorNovo() {
    const fetchNavegador = criarFetchDeNavegador(origem);
    EpiHttp.configurar({ baseUrl, fetch: fetchNavegador });
    return fetchNavegador;
  }

  const entrar = (email) => EpiAuth.entrar({ cnpj: CNPJ_A, email, senha: SENHA });

  describe('sessão real da tela', () => {
    test('login pela tela emite cookie e a listagem passa a responder', async () => {
      const navegador = navegadorNovo();

      const semSessao = await EpiGrupos.acoes.listar();
      assert.equal(semSessao.status, 401);
      assert.equal(EpiGrupos.mensagens.exigeNovoLogin(semSessao), true, 'a tela volta ao login');

      const entrada = await entrar(EMAIL_MASTER_A);
      assert.equal(entrada.ok, true);
      assert.equal(navegador.cookies.size, 1);

      const comSessao = await EpiGrupos.acoes.listar();
      assert.equal(comSessao.ok, true);
      assert.ok(Array.isArray(comSessao.dados.grupos));
    });

    test('sessão expirada no meio do uso: a tela recebe 401 e a mensagem pede novo login', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      assert.equal((await EpiGrupos.acoes.listar()).ok, true);

      // Revoga a sessão no servidor, como uma expiração real faria.
      await pool.query('UPDATE sessoes SET revogada_em = now(), motivo_revogacao = $1 WHERE revogada_em IS NULL', ['TESTE']);

      const depois = await EpiGrupos.acoes.listar();
      assert.equal(depois.status, 401);
      assert.equal(EpiGrupos.mensagens.exigeNovoLogin(depois), true);
      assert.match(EpiGrupos.mensagens.deErro(depois), /sess(ã|a)o expirou/i);
    });
  });

  describe('as seis operações da 3M pela tela', () => {
    test('cadastro, listagem e consulta com dados reais', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const criado = await EpiGrupos.acoes.criar({ nome: 'Almoxarifado 3S', descricao: 'Equipe do estoque' });
      assert.equal(criado.status, 201);
      assert.equal(criado.dados.grupo.nome, 'Almoxarifado 3S');
      assert.equal(criado.dados.grupo.ativo, true);
      assert.equal(criado.dados.grupo.criadoPor, masterA);

      const lista = await EpiGrupos.acoes.listar();
      assert.equal(lista.dados.grupos.some((g) => g.id === criado.dados.grupo.id), true);

      const consulta = await EpiGrupos.acoes.buscar(criado.dados.grupo.id);
      assert.equal(consulta.dados.grupo.descricao, 'Equipe do estoque');
    });

    test('criar sem descrição e depois limpá-la: ausente x null atravessam até o banco', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const criado = await EpiGrupos.acoes.criar({ nome: 'Sem Descricao 3S', descricao: '' });
      assert.equal(criado.dados.grupo.descricao, null);

      const comDescricao = await EpiGrupos.acoes.alterar(criado.dados.grupo.id, { descricao: 'agora tem' });
      assert.equal(comDescricao.dados.grupo.descricao, 'agora tem');

      // Só o nome informado: a descrição precisa ser preservada.
      const soNome = await EpiGrupos.acoes.alterar(criado.dados.grupo.id, { nome: 'Renomeado 3S' });
      assert.equal(soNome.dados.grupo.nome, 'Renomeado 3S');
      assert.equal(soNome.dados.grupo.descricao, 'agora tem', 'campo ausente preserva o valor');

      const limpa = await EpiGrupos.acoes.alterar(criado.dados.grupo.id, { descricao: '' });
      assert.equal(limpa.dados.grupo.descricao, null, 'descrição vazia limpa o campo');
    });

    test('inativação e reativação pelas rotas próprias, com o filtro da listagem refletindo', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      const grupo = (await EpiGrupos.acoes.criar({ nome: 'Ciclo 3S' })).dados.grupo;

      const inativado = await EpiGrupos.acoes.inativar(grupo.id);
      assert.equal(inativado.ok, true);
      assert.equal(inativado.dados.alterado, true);
      assert.equal(inativado.dados.grupo.ativo, false);

      const inativos = await EpiGrupos.acoes.listar({ ativo: false });
      assert.equal(inativos.dados.grupos.some((g) => g.id === grupo.id), true);
      const ativos = await EpiGrupos.acoes.listar({ ativo: true });
      assert.equal(ativos.dados.grupos.some((g) => g.id === grupo.id), false);

      const reativado = await EpiGrupos.acoes.reativar(grupo.id);
      assert.equal(reativado.dados.grupo.ativo, true);
      assert.equal((await EpiGrupos.acoes.listar({ ativo: true })).dados.grupos.some((g) => g.id === grupo.id), true);

      // Idempotência: reativar de novo não é erro, e a tela sabe disso.
      const denovo = await EpiGrupos.acoes.reativar(grupo.id);
      assert.equal(denovo.ok, true);
      assert.equal(denovo.dados.alterado, false);
    });

    test('inativar NÃO exclui: o grupo continua existindo e consultável', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      const grupo = (await EpiGrupos.acoes.criar({ nome: 'Preservado 3S' })).dados.grupo;

      await EpiGrupos.acoes.inativar(grupo.id);

      const consulta = await EpiGrupos.acoes.buscar(grupo.id);
      assert.equal(consulta.ok, true, 'o registro não foi apagado');
      assert.equal(consulta.dados.grupo.ativo, false);
      const { rows } = await pool.query('SELECT ativo FROM grupos_acesso WHERE id = $1', [grupo.id]);
      assert.equal(rows.length, 1, 'a linha permanece no banco');
    });
  });

  describe('erros reais que a tela precisa distinguir', () => {
    test('400 de validação com detalhe por campo, e a mensagem certa para a pessoa', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const vazio = await EpiGrupos.acoes.criar({ nome: '' });
      assert.equal(vazio.status, 400);
      assert.equal(vazio.codigo, 'VALIDACAO');
      assert.ok(EpiGrupos.mensagens.deErro(vazio).length > 0);

      const longo = await EpiGrupos.acoes.criar({ nome: 'x'.repeat(101) });
      assert.equal(longo.status, 400);
    });

    test('400 de regra de negócio: alterar sem informar nada', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      const grupo = (await EpiGrupos.acoes.criar({ nome: 'Sem Alteracao 3S' })).dados.grupo;

      const nada = await EpiGrupos.acoes.alterar(grupo.id, {});

      assert.equal(nada.status, 400);
      assert.equal(nada.codigo, 'GRUPO_SEM_ALTERACAO');
      assert.match(EpiGrupos.mensagens.deErro(nada), /Altere o nome ou a descri/i);
    });

    test('409 de nome repetido, com mensagem própria', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      await EpiGrupos.acoes.criar({ nome: 'Repetido 3S' });

      const duplicado = await EpiGrupos.acoes.criar({ nome: 'Repetido 3S' });

      assert.equal(duplicado.status, 409);
      assert.equal(duplicado.codigo, 'GRUPO_NOME_EM_USO');
      assert.match(EpiGrupos.mensagens.deErro(duplicado), /j(á|a) existe um grupo/i);
    });

    test('404 em grupo inexistente, nas três rotas por id', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      for (const resposta of [
        await EpiGrupos.acoes.buscar(999999),
        await EpiGrupos.acoes.alterar(999999, { nome: 'X' }),
        await EpiGrupos.acoes.inativar(999999),
      ]) {
        assert.equal(resposta.status, 404);
        assert.equal(resposta.codigo, 'GRUPO_NAO_ENCONTRADO');
        assert.match(EpiGrupos.mensagens.deErro(resposta), /n(ã|a)o existe mais/i);
      }
    });

    test('falha de rede (servidor fora do ar) não quebra a tela', async () => {
      navegadorNovo();
      EpiHttp.configurar({ baseUrl: 'http://127.0.0.1:1/api' });

      const resposta = await EpiGrupos.acoes.listar();

      assert.equal(resposta.ok, false);
      assert.equal(resposta.status, 0);
      assert.equal(resposta.codigo, 'FALHA_DE_REDE');
      assert.match(EpiGrupos.mensagens.deErro(resposta), /servidor/i);
      assert.equal(EpiGrupos.mensagens.exigeNovoLogin(resposta), false, 'rede caída não é sessão expirada');
    });
  });

  describe('autoridade da 3Q — o backend decide, não a tela', () => {
    test('ADMINISTRADOR sem autorização expressa: autentica, mas recebe 403 em TODAS as operações', async () => {
      navegadorNovo();
      const entrada = await entrar(EMAIL_ADMIN_A);
      assert.equal(entrada.ok, true);
      assert.equal(entrada.identidade.usuario.perfil, 'ADMINISTRADOR', 'o perfil aparece na tela...');

      const operacoes = [
        await EpiGrupos.acoes.listar(),
        await EpiGrupos.acoes.criar({ nome: 'Do Admin 3S' }),
        await EpiGrupos.acoes.buscar(1),
        await EpiGrupos.acoes.alterar(1, { nome: 'X' }),
        await EpiGrupos.acoes.inativar(1),
        await EpiGrupos.acoes.reativar(1),
      ];

      for (const resposta of operacoes) {
        assert.equal(resposta.status, 403, '...mas não autoriza nada');
        assert.equal(resposta.codigo, 'GRUPO_NAO_AUTORIZADO');
        assert.match(EpiGrupos.mensagens.deErro(resposta), /n(ã|a)o tem autoriza(ç|c)(ã|a)o/i);
      }
    });

    test('com a autorização granular da 3Q concedida pelo MASTER, o mesmo ADMINISTRADOR passa a administrar', async () => {
      // Concessão pelo caminho real da 3I, com a ação da migration 024.
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA,
        concedidoPor: masterA,
        usuarioId: adminA,
        acaoCodigo: autoridade.ACOES_ADMINISTRATIVAS.GRUPOS_ACESSO,
      });

      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      const lista = await EpiGrupos.acoes.listar();
      assert.equal(lista.ok, true, 'a mesma pessoa, agora autorizada, enxerga a lista');

      const criado = await EpiGrupos.acoes.criar({ nome: 'Criado pelo Admin 3S' });
      assert.equal(criado.status, 201);
      assert.equal(criado.dados.grupo.criadoPor, adminA);
    });

    test('isolamento multiempresa: a sessão de B não alcança um grupo de A', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      const daEmpresaA = (await EpiGrupos.acoes.criar({ nome: 'Exclusivo de A 3S' })).dados.grupo;

      navegadorNovo();
      await EpiAuth.entrar({ cnpj: CNPJ_B, email: EMAIL_MASTER_B, senha: SENHA });

      const tentativa = await EpiGrupos.acoes.buscar(daEmpresaA.id);
      assert.equal(tentativa.status, 404, 'para a empresa B esse grupo não existe');

      const listaDeB = await EpiGrupos.acoes.listar();
      assert.equal(listaDeB.dados.grupos.some((g) => g.nome === 'Exclusivo de A 3S'), false);
    });
  });

  describe('separação de domínios preservada', () => {
    test('o nome do grupo é só um rótulo: "SST" não cria vinculo_sst nem permissão nenhuma', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      const { rows: [antes] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM vinculo_sst WHERE empresa_id = $1) AS sst,
               (SELECT count(*)::int FROM grupo_permissoes_recurso WHERE empresa_id = $1) AS gpr,
               (SELECT count(*)::int FROM grupo_permissoes_acao WHERE empresa_id = $1) AS gpa`, [empresaA]);

      await EpiGrupos.acoes.criar({ nome: 'SST', descricao: 'Segurança do Trabalho' });
      await EpiGrupos.acoes.criar({ nome: 'Funcionários' });

      const { rows: [depois] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM vinculo_sst WHERE empresa_id = $1) AS sst,
               (SELECT count(*)::int FROM grupo_permissoes_recurso WHERE empresa_id = $1) AS gpr,
               (SELECT count(*)::int FROM grupo_permissoes_acao WHERE empresa_id = $1) AS gpa`, [empresaA]);

      assert.deepEqual(depois, antes, 'criar grupo não cria SST nem permissão por causa do nome');
    });

    test('texto com HTML é aceito pelo backend e sai escapado na renderização', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      const nomePerigoso = '<img src=x onerror=alert(1)>';

      const criado = await EpiGrupos.acoes.criar({ nome: nomePerigoso });
      assert.equal(criado.status, 201);
      assert.equal(criado.dados.grupo.nome, nomePerigoso, 'o backend guarda o texto como veio');

      const html = EpiGrupos.render.tabela([criado.dados.grupo]);
      assert.equal(html.includes('<img'), false, 'a tela nunca interpreta esse texto como HTML');
      assert.ok(html.includes('&lt;img'));
    });
  });
});
