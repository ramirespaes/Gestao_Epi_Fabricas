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
const { criarGrupoUsuarioController } = require('../../src/controllers/grupo-usuario.controller');
const { criarGrupoUsuarioRoutes } = require('../../src/routes/grupo-usuario.routes');
const { criarUsuarioConsultaController } = require('../../src/controllers/usuario-consulta.controller');
const { criarUsuarioConsultaRoutes } = require('../../src/routes/usuario-consulta.routes');
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
const EpiVinculos = require('../../../frontend/js/grupo-usuarios');

/**
 * Tela de integrantes dos grupos (Subetapa 3U) contra o backend REAL:
 * frontend/js/grupo-usuarios.js exercitado de ponta a ponta — servidor
 * HTTP de verdade, middlewares de produção (CORS, origem/CSRF,
 * conteúdo), rotas reais da 3O, a rota de consulta criada nesta
 * subetapa, autoridade granular da 3Q e PostgreSQL real em schema
 * temporário exclusivo.
 *
 * O que só este teste prova:
 *
 *   • que vincular ESCREVE em usuarios.grupo_acesso_id, e desvincular o
 *     devolve a NULL — verificado lendo a coluna direto no banco;
 *   • que vincular quem já está em outro grupo TRANSFERE, em vez de
 *     criar um segundo vínculo (a pessoa tem um grupo só);
 *   • que desvincular NÃO apaga o usuário, e não mexe em mais ninguém;
 *   • que os 409 da 3L (autovínculo, MASTER, inativo, grupo inativo) são
 *     os do backend, e não suposições da tela;
 *   • que o 403 da 3Q aparece e some depois da concessão real da 3I;
 *   • que outra empresa não alcança nem o grupo nem as pessoas desta;
 *   • que a gravação atinge o grupo de origem mesmo com outro
 *     selecionado depois.
 *
 * O `fetch` injetado faz o papel do navegador (Origin + jar de cookies),
 * como na 3R/3S/3T. A migration 024 é aplicada NESTE SCHEMA TEMPORÁRIO
 * apenas — o banco principal não é tocado.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3u-2026';
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

function uiFalso() {
  const registro = {
    vinculados: [], disponiveis: [], avisos: [], resumos: [], inativo: [], sessao: [], paginacao: [],
  };
  return {
    registro,
    renderVinculados(html) { registro.vinculados.push(html); },
    renderDisponiveis(html) { registro.disponiveis.push(html); },
    aviso(texto, tipo) { registro.avisos.push({ texto, tipo }); },
    resumo(texto) { registro.resumos.push(texto); },
    // Acrescentado na correção pós-auditoria da 3U, junto dos controles
    // de página.
    paginacao(html) { registro.paginacao.push(html); },
    grupoInativo(valor) { registro.inativo.push(valor); },
    sessaoExpirada(mensagem) { registro.sessao.push(mensagem); },
  };
}

const ultimoDe = (lista) => lista[lista.length - 1];

describe('tela de integrantes do grupo (3U) contra o backend real', () => {
  let contexto;
  let pool;
  let servidor;
  let baseUrl;
  let origem;
  let empresaA;
  let masterA;
  let adminA;
  let ana;
  let bruno;
  let zilda;
  let grupoA;
  let grupoB;
  let grupoInativo;
  let grupoOutraEmpresa;

  before(async () => {
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;

    const hash = await gerarHashSenha(SENHA);
    assert.equal(await inserirEmpresa(pool, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, CNPJ_B, 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    const empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    const inserirUsuario = async (empresaId, email, perfil, nome, ativo = true) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [empresaId, nome, email, hash, perfil, ativo],
      );
      return criado[0].id;
    };

    masterA = await inserirUsuario(empresaA, EMAIL_MASTER_A, 'MASTER', 'Master da Empresa A');
    adminA = await inserirUsuario(empresaA, EMAIL_ADMIN_A, 'ADMINISTRADOR', 'Administrador da Empresa A');
    ana = await inserirUsuario(empresaA, 'ana@demo.safeworkengenharia.com.br', 'USUARIO', 'Ana Souza');
    bruno = await inserirUsuario(empresaA, 'bruno@demo.safeworkengenharia.com.br', 'SUPERVISOR', 'Bruno Lima');
    zilda = await inserirUsuario(empresaA, 'zilda@demo.safeworkengenharia.com.br', 'USUARIO', 'Zilda Inativa', false);
    const masterB = await inserirUsuario(empresaB, EMAIL_MASTER_B, 'MASTER', 'Master da Empresa B');

    const criarGrupo = async (empresaId, criadoPor, nome, ativo = true) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO grupos_acesso (empresa_id, nome, criado_por, ativo) VALUES ($1, $2, $3, $4) RETURNING id',
        [empresaId, nome, criadoPor, ativo],
      );
      return criado[0].id;
    };
    grupoA = await criarGrupo(empresaA, masterA, 'Almoxarifado 3U');
    grupoB = await criarGrupo(empresaA, masterA, 'Obra Norte 3U');
    grupoInativo = await criarGrupo(empresaA, masterA, 'Grupo Inativo 3U', false);
    grupoOutraEmpresa = await criarGrupo(empresaB, masterB, 'Grupo da Empresa B');

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
      criarGrupoUsuarioRoutes({ controller: criarGrupoUsuarioController({ pool }), exigirSessao }),
      criarUsuarioConsultaRoutes({ controller: criarUsuarioConsultaController({ pool }), exigirSessao }),
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

  const entrar = (email, cnpj = CNPJ_A) => EpiAuth.entrar({ cnpj, email, senha: SENHA });

  /** O vínculo real, direto no banco — a prova final. */
  async function grupoNoBanco(usuarioId) {
    const { rows } = await pool.query('SELECT grupo_acesso_id FROM usuarios WHERE id = $1', [usuarioId]);
    return rows[0] ? rows[0].grupo_acesso_id : undefined;
  }

  async function definirGrupo(usuarioId, grupoId) {
    await pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupoId, usuarioId]);
  }

  // ───────────────────────────────────────────────────────────────────
  describe('sessão', () => {
    test('sem sessão, as consultas respondem 401 e a tela volta ao login', async () => {
      navegadorNovo();

      for (const resposta of [
        await EpiVinculos.acoes.listarDoGrupo(grupoA),
        await EpiVinculos.acoes.listarDaEmpresa({}),
      ]) {
        assert.equal(resposta.status, 401);
        assert.equal(EpiVinculos.mensagens.exigeNovoLogin(resposta), true);
      }
    });

    test('sessão revogada no meio do uso devolve ao login pelo controlador', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      assert.equal((await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' })).status, 'ok');

      await pool.query('UPDATE sessoes SET revogada_em = now(), motivo_revogacao = $1 WHERE revogada_em IS NULL', ['TESTE']);

      const depois = await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      assert.equal(depois.status, 'sessao');
      assert.equal(ui.registro.sessao.length, 1);
      assert.match(ui.registro.sessao[0], /sess(ã|a)o expirou/i);
      assert.equal(controlador.grupoAtual(), null);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('consulta dos vínculos', () => {
    test('grupo vazio mostra mensagem própria, e a lista da empresa vem completa', async () => {
      await definirGrupo(ana, null);
      await definirGrupo(bruno, null);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      const resultado = await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      assert.equal(resultado.status, 'ok');
      assert.equal(resultado.vinculados, 0);
      assert.match(ultimoDe(ui.registro.vinculados), /Ninguém está neste grupo/i);
      assert.match(ultimoDe(ui.registro.disponiveis), /Ana Souza/);
      assert.match(ultimoDe(ui.registro.disponiveis), /Bruno Lima/);
    });

    test('quem está no grupo aparece na lista de vinculados', async () => {
      await definirGrupo(ana, grupoA);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      assert.match(ultimoDe(ui.registro.vinculados), /Ana Souza/);
      assert.equal(controlador.estaVinculado(ana), true);
      assert.equal(controlador.estaVinculado(bruno), false);
    });

    test('a busca por nome funciona contra o banco real', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });
      await controlador.buscar({ busca: 'bruno' });

      const html = ultimoDe(ui.registro.disponiveis);
      assert.match(html, /Bruno Lima/);
      assert.equal(html.includes('Ana Souza'), false);
    });

    test('o filtro "sem grupo" exclui quem já está vinculado', async () => {
      await definirGrupo(ana, grupoA);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });
      await controlador.buscar({ busca: '', vinculo: 'sem_grupo' });

      assert.equal(ultimoDe(ui.registro.disponiveis).includes('Ana Souza'), false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('inclusão e remoção de vínculos', () => {
    test('incluir grava usuarios.grupo_acesso_id no banco', async () => {
      await definirGrupo(bruno, null);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.vincular(bruno, 'Bruno Lima');

      assert.equal(resultado.status, 'ok');
      assert.equal(resultado.alterado, true);
      assert.equal(await grupoNoBanco(bruno), grupoA);
      assert.match(ultimoDe(ui.registro.avisos).texto, /agora faz parte/i);
      assert.equal(controlador.estaVinculado(bruno), true, 'a lista foi atualizada');
    });

    test('incluir quem já está em outro grupo TRANSFERE: continua um grupo só', async () => {
      await definirGrupo(bruno, grupoB);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.vincular(bruno, 'Bruno Lima');

      assert.equal(resultado.status, 'ok');
      assert.equal(await grupoNoBanco(bruno), grupoA, 'o vínculo anterior foi substituído');
      assert.match(ultimoDe(ui.registro.avisos).texto, /transferid/i);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS total FROM usuarios WHERE id = $1 AND grupo_acesso_id = $2', [bruno, grupoB],
      );
      assert.equal(rows[0].total, 0, 'não sobrou vínculo com o grupo antigo');
    });

    test('incluir de novo quem já está devolve alterado=false, sem erro', async () => {
      await definirGrupo(bruno, grupoA);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.vincular(bruno, 'Bruno Lima');

      assert.equal(resultado.status, 'ok');
      assert.equal(resultado.alterado, false);
      assert.equal(await grupoNoBanco(bruno), grupoA);
    });

    test('retirar devolve o vínculo a NULL — e NÃO exclui a pessoa', async () => {
      await definirGrupo(ana, grupoA);
      const { rows: antes } = await pool.query('SELECT count(*)::int AS total FROM usuarios');

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.desvincular(ana, 'Ana Souza');

      assert.equal(resultado.status, 'ok');
      assert.equal(await grupoNoBanco(ana), null);

      const { rows: depois } = await pool.query('SELECT count(*)::int AS total FROM usuarios');
      assert.equal(depois[0].total, antes[0].total, 'ninguém foi excluído');

      const { rows: viva } = await pool.query('SELECT nome, ativo FROM usuarios WHERE id = $1', [ana]);
      assert.equal(viva[0].nome, 'Ana Souza');
      assert.equal(viva[0].ativo, true, 'retirar do grupo não inativa a pessoa');
    });

    test('retirar uma pessoa não mexe no vínculo das outras', async () => {
      await definirGrupo(ana, grupoA);
      await definirGrupo(bruno, grupoA);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });
      await controlador.desvincular(ana, 'Ana Souza');

      assert.equal(await grupoNoBanco(ana), null);
      assert.equal(await grupoNoBanco(bruno), grupoA, 'o vínculo de Bruno continua');
    });

    test('retirar quem não está em grupo nenhum devolve alterado=false', async () => {
      await definirGrupo(ana, null);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.desvincular(ana, 'Ana Souza');

      assert.equal(resultado.status, 'ok');
      assert.equal(resultado.alterado, false);
      assert.match(ultimoDe(ui.registro.avisos).texto, /já não estava/i);
    });

    test('as operações são auditadas', async () => {
      await definirGrupo(bruno, null);
      const { rows: antes } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaA]);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });
      await controlador.vincular(bruno, 'Bruno Lima');

      const { rows: depois } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaA]);
      assert.ok(depois[0].total > antes[0].total, 'a vinculação deixou rastro');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('as recusas da 3L, vindas do backend', () => {
    test('grupo inativo não aceita novos integrantes (409)', async () => {
      await definirGrupo(bruno, null);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoInativo, { nome: 'Grupo Inativo 3U', inativo: true });

      const resultado = await controlador.vincular(bruno, 'Bruno Lima');

      assert.equal(resultado.status, 'erro');
      assert.match(ultimoDe(ui.registro.avisos).texto, /inativo/i);
      assert.equal(await grupoNoBanco(bruno), null, 'nada foi gravado');
      assert.equal(ui.registro.inativo.includes(true), true, 'a tela avisou antes');
    });

    test('usuário inativo não entra em grupo (409)', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.vincular(zilda, 'Zilda Inativa');

      assert.equal(resultado.status, 'erro');
      assert.match(ultimoDe(ui.registro.avisos).texto, /inativa/i);
      assert.equal(await grupoNoBanco(zilda), null);
    });

    test('MASTER não entra em grupo (409)', async () => {
      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA,
        acaoCodigo: autoridade.ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO,
      });

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.vincular(masterA, 'Master da Empresa A');

      assert.equal(resultado.status, 'erro');
      assert.match(ultimoDe(ui.registro.avisos).texto, /master/i);
      assert.equal(await grupoNoBanco(masterA), null);
    });

    test('ninguém altera o próprio grupo (409)', async () => {
      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.vincular(adminA, 'Administrador da Empresa A');

      assert.equal(resultado.status, 'erro');
      assert.match(ultimoDe(ui.registro.avisos).texto, /próprio grupo/i);
      assert.equal(await grupoNoBanco(adminA), null);
    });

    test('usuário inexistente responde 404, não 500', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const resposta = await EpiVinculos.acoes.vincular(grupoA, 999999);

      assert.equal(resposta.status, 404);
      assert.match(EpiVinculos.mensagens.deErro(resposta), /pessoa/i);
    });

    test('grupo inexistente responde 404', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      assert.equal((await EpiVinculos.acoes.listarDoGrupo(999999)).status, 404);
      assert.equal((await EpiVinculos.acoes.vincular(999999, bruno)).status, 404);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('autoridade administrativa da 3Q', () => {
    test('ADMINISTRADOR sem autorização recebe 403 nas consultas e na gravação', async () => {
      // Remove a autorização concedida em testes anteriores.
      await pool.query('DELETE FROM usuario_autorizacoes WHERE empresa_id = $1 AND usuario_id = $2', [empresaA, adminA]);

      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      assert.equal((await EpiVinculos.acoes.listarDoGrupo(grupoA)).status, 403);
      assert.equal((await EpiVinculos.acoes.listarDaEmpresa({})).status, 403);
      assert.equal((await EpiVinculos.acoes.vincular(grupoA, bruno)).status, 403);
      assert.equal((await EpiVinculos.acoes.desvincular(bruno)).status, 403);
    });

    test('403 não grava nada: o vínculo do banco fica idêntico', async () => {
      await definirGrupo(bruno, grupoB);

      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      await EpiVinculos.acoes.vincular(grupoA, bruno);
      await EpiVinculos.acoes.desvincular(bruno);

      assert.equal(await grupoNoBanco(bruno), grupoB, 'a recusa terminou em ROLLBACK');
    });

    test('com ADMINISTRAR_VINCULOS_GRUPO concedida, o mesmo usuário passa a administrar', async () => {
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA,
        acaoCodigo: autoridade.ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO,
      });
      await definirGrupo(bruno, null);

      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      const carga = await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });
      assert.equal(carga.status, 'ok');

      const resultado = await controlador.vincular(bruno, 'Bruno Lima');
      assert.equal(resultado.status, 'ok');
      assert.equal(await grupoNoBanco(bruno), grupoA);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('isolamento multiempresa', () => {
    test('o MASTER da empresa A não alcança o grupo da empresa B', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      assert.equal((await EpiVinculos.acoes.listarDoGrupo(grupoOutraEmpresa)).status, 404);
      assert.equal((await EpiVinculos.acoes.vincular(grupoOutraEmpresa, bruno)).status, 404);
    });

    test('o MASTER da empresa B não enxerga nem move as pessoas da empresa A', async () => {
      await definirGrupo(ana, grupoA);

      navegadorNovo();
      await entrar(EMAIL_MASTER_B, CNPJ_B);

      assert.equal((await EpiVinculos.acoes.listarDoGrupo(grupoA)).status, 404);
      assert.equal((await EpiVinculos.acoes.desvincular(ana)).status, 404);
      assert.equal(await grupoNoBanco(ana), grupoA, 'o vínculo da outra empresa segue intacto');

      const daEmpresaB = await EpiVinculos.acoes.listarDaEmpresa({});
      assert.equal(daEmpresaB.ok, true);
      assert.equal(daEmpresaB.dados.usuarios.some((u) => u.nome === 'Ana Souza'), false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('concorrência: gravação com troca de grupo no meio', () => {
    test('a gravação atinge o grupo de origem, não o selecionado depois', async () => {
      await definirGrupo(bruno, null);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const gravando = controlador.vincular(bruno, 'Bruno Lima');
      const trocando = controlador.selecionar(grupoB, { nome: 'Obra Norte 3U' });

      const [resultado] = await Promise.all([gravando, trocando]);

      assert.equal(resultado.grupo, grupoA, 'a escrita pertenceu ao grupo de origem');
      assert.equal(controlador.grupoAtual(), grupoB);
      assert.equal(await grupoNoBanco(bruno), grupoA, 'gravou no grupo certo');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────
  describe('correção pós-auditoria: paginação e confirmação, contra o servidor real', () => {
    test('a paginação navega de verdade, com o total vindo do banco', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      // Limite pequeno para que os poucos usuários do cenário rendam
      // mais de uma página sem precisar inventar dados.
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });
      await controlador.buscar({ busca: '' });

      const { rows } = await pool.query(
        'SELECT count(*)::int AS total FROM usuarios WHERE empresa_id = $1', [empresaA],
      );
      assert.equal(controlador.paginacao().total, rows[0].total, 'o total é o do banco, não o da página');
      assert.equal(controlador.paginacao().pagina, 1);
      assert.match(ultimoDe(ui.registro.paginacao), /Página 1 de/);
    });

    test('pedir página além da última é recusado sem chamar o servidor', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const resultado = await controlador.irParaPagina(999);

      assert.equal(resultado.status, 'fora-do-intervalo');
      assert.equal(controlador.paginacao().pagina, 1);
    });

    test('transferência confirmada atinge o grupo do pedido, verificado no banco', async () => {
      await definirGrupo(bruno, grupoB);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      controlador.definirNomesDeGrupo([
        { id: grupoA, nome: 'Almoxarifado 3U' }, { id: grupoB, nome: 'Obra Norte 3U' },
      ]);
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const pedido = controlador.prepararVinculo(bruno, 'Bruno Lima');
      assert.equal(pedido.grupoId, grupoA);

      const resultado = await controlador.confirmar(pedido);

      assert.equal(resultado.status, 'ok');
      assert.equal(await grupoNoBanco(bruno), grupoA);
    });

    test('troca de grupo com confirmação aberta: NADA é escrito no banco', async () => {
      await definirGrupo(bruno, grupoB);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiVinculos.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      // Confirmação preparada para o Grupo A...
      const pedido = controlador.prepararVinculo(bruno, 'Bruno Lima');

      // ...e a pessoa troca para o Grupo B antes de confirmar.
      await controlador.selecionar(grupoB, { nome: 'Obra Norte 3U' });

      const resultado = await controlador.confirmar(pedido);

      assert.equal(resultado.status, 'contexto-mudou');
      assert.equal(await grupoNoBanco(bruno), grupoB, 'o vínculo continua exatamente como estava');
      assert.match(ultimoDe(ui.registro.avisos).texto, /seleção mudou/i);
    });

    test('desvinculação com contexto alterado também não escreve', async () => {
      await definirGrupo(ana, grupoA);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });

      const pedido = controlador.prepararDesvinculo(ana, 'Ana Souza');
      await controlador.selecionar(grupoB, { nome: 'Obra Norte 3U' });

      assert.equal((await controlador.confirmar(pedido)).status, 'contexto-mudou');
      assert.equal(await grupoNoBanco(ana), grupoA, 'ninguém foi retirado');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('integração com as telas da 3S e da 3T, sem regressão', () => {
    test('o seletor de grupos usa a listagem da 3S', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const lista = await EpiGrupos.acoes.listar({});

      assert.equal(lista.ok, true);
      assert.equal(lista.dados.grupos.some((g) => g.id === grupoA), true);
      assert.equal(lista.dados.grupos.every((g) => g.empresaId === empresaA), true);
    });

    test('administrar vínculos nunca altera o cadastro do grupo', async () => {
      await definirGrupo(bruno, null);

      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const antes = (await EpiGrupos.acoes.buscar(grupoA)).dados.grupo;

      const controlador = EpiVinculos.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3U' });
      await controlador.vincular(bruno, 'Bruno Lima');
      await controlador.desvincular(bruno, 'Bruno Lima');

      const depois = (await EpiGrupos.acoes.buscar(grupoA)).dados.grupo;
      assert.equal(depois.nome, antes.nome);
      assert.equal(depois.descricao, antes.descricao);
      assert.equal(depois.ativo, antes.ativo);
    });

    test('nenhuma das telas oferece exclusão física de usuário', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const resposta = await EpiHttp.requisitar('DELETE', `/usuarios/${bruno}`);

      assert.equal(resposta.ok, false);
      assert.ok([404, 405].includes(resposta.status), `status inesperado: ${resposta.status}`);

      const { rows } = await pool.query('SELECT count(*)::int AS total FROM usuarios WHERE id = $1', [bruno]);
      assert.equal(rows[0].total, 1, 'a pessoa continua lá');
    });

    test('nenhum campo de autoridade sai do cliente na vinculação', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      await assert.rejects(
        () => EpiHttp.requisitar('PUT', `/grupos-acesso/${grupoA}/usuarios/${bruno}`, {
          corpo: { empresaId: 999, isMaster: true },
        }),
        (erro) => {
          assert.ok(erro instanceof TypeError);
          assert.match(erro.message, /empresaId/);
          return true;
        },
      );
    });
  });
});
