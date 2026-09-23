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
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');
const { criarCatalogoController } = require('../../src/controllers/catalogo.controller');
const { criarCatalogoRoutes } = require('../../src/routes/catalogo.routes');
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
const EpiPermissoes = require('../../../frontend/js/grupo-permissoes');

/**
 * Tela de permissões de grupo (Subetapa 3T) contra o backend REAL:
 * frontend/js/grupo-permissoes.js exercitado de ponta a ponta — servidor
 * HTTP de verdade, middlewares de produção (CORS, origem/CSRF,
 * conteúdo), rotas reais da 3N e do catálogo da 3T, autoridade granular
 * da 3Q e PostgreSQL real em schema temporário exclusivo.
 *
 * O que só este teste prova, e nenhum `fetch` falso provaria:
 *
 *   • que o tri-state sobrevive à viagem inteira — tela → HTTP → Zod →
 *     serviço → PostgreSQL → serviço → HTTP → tela — sem FALSE virar
 *     NULL em nenhum ponto;
 *   • que a alteração parcial preserva no BANCO as operações que a tela
 *     não enviou;
 *   • que o 403 da 3Q aparece de verdade e some depois da concessão
 *     real pelo caminho da 3I;
 *   • que o 409 de ação não-ALTERNATIVA é o do backend, e não uma
 *     suposição da tela;
 *   • que o catálogo exposto pela 3T é o catálogo real das migrations;
 *   • que outra empresa não alcança o grupo desta.
 *
 * O `fetch` injetado faz o papel do navegador (Origin + jar de cookies),
 * como na 3R/3S. A migration 024 é aplicada NESTE SCHEMA TEMPORÁRIO
 * apenas — o banco principal não é tocado.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3t-2026';
const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';
const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';

const RECURSO = 'materials';
const OUTRO_RECURSO = 'reports';

const ultimoDe = (lista) => lista[lista.length - 1];

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

describe('tela de permissões de grupo (3T) contra o backend real', () => {
  let contexto;
  let pool;
  let servidor;
  let baseUrl;
  let origem;
  let empresaA;
  let empresaB;
  let masterA;
  let adminA;
  let grupoA;
  let grupoB;
  let acaoAlternativa;
  let acaoNaoAlternativa;

  before(async () => {
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;

    const hash = await gerarHashSenha(SENHA);
    assert.equal(await inserirEmpresa(pool, CNPJ_A, 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, CNPJ_B, 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
    empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;

    const inserirUsuario = async (empresaId, email, perfil) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, true) RETURNING id',
        [empresaId, `Usuário ${email}`, email, hash, perfil],
      );
      return criado[0].id;
    };
    masterA = await inserirUsuario(empresaA, EMAIL_MASTER_A, 'MASTER');
    adminA = await inserirUsuario(empresaA, EMAIL_ADMIN_A, 'ADMINISTRADOR');
    const masterB = await inserirUsuario(empresaB, EMAIL_MASTER_B, 'MASTER');

    const criarGrupo = async (empresaId, criadoPor, nome) => {
      const { rows: criado } = await pool.query(
        'INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id',
        [empresaId, nome, criadoPor],
      );
      return criado[0].id;
    };
    grupoA = await criarGrupo(empresaA, masterA, 'Almoxarifado 3T');
    grupoB = await criarGrupo(empresaB, masterB, 'Grupo da Empresa B');

    // As ações usadas vêm do catálogo REAL, escolhidas pelo modo que o
    // banco declara — nada aqui presume qual código tem qual modo.
    const { rows: catalogo } = await pool.query(
      'SELECT codigo, modo_autorizacao_individual FROM acoes WHERE ativo = true ORDER BY codigo',
    );
    acaoAlternativa = catalogo.find((a) => a.modo_autorizacao_individual === 'ALTERNATIVA').codigo;
    acaoNaoAlternativa = catalogo.find((a) => a.modo_autorizacao_individual !== 'ALTERNATIVA').codigo;

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
      criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao }),
      criarCatalogoRoutes({ controller: criarCatalogoController({ pool }), exigirSessao }),
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

  /** Estado do recurso direto no banco — a prova final do que foi gravado. */
  async function noBanco(grupoId, recurso) {
    const { rows } = await pool.query(
      `SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir
         FROM grupo_permissoes_recurso
        WHERE grupo_acesso_id = $1 AND recurso = $2`,
      [grupoId, recurso],
    );
    return rows[0] || null;
  }

  // ───────────────────────────────────────────────────────────────────
  describe('sessão', () => {
    test('sem sessão, as três consultas da tela respondem 401 e ela volta ao login', async () => {
      navegadorNovo();

      for (const resposta of [
        await EpiPermissoes.acoes.listarRecursos(grupoA),
        await EpiPermissoes.acoes.listarAcoes(grupoA),
        await EpiPermissoes.acoes.catalogoDeAcoes(),
      ]) {
        assert.equal(resposta.status, 401);
        assert.equal(EpiPermissoes.mensagens.exigeNovoLogin(resposta), true);
      }
    });

    test('sessão revogada no meio do uso: 401 e a mensagem pede novo login', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);
      assert.equal((await EpiPermissoes.acoes.listarRecursos(grupoA)).ok, true);

      await pool.query('UPDATE sessoes SET revogada_em = now(), motivo_revogacao = $1 WHERE revogada_em IS NULL', ['TESTE']);

      const depois = await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, { podeCriar: true });
      assert.equal(depois.status, 401);
      assert.match(EpiPermissoes.mensagens.deErro(depois), /sess(ã|a)o expirou/i);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('catálogo de ações (rota nova da 3T)', () => {
    test('devolve o catálogo real das migrations, com modo e situação de cada ação', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const resposta = await EpiPermissoes.acoes.catalogoDeAcoes();
      assert.equal(resposta.ok, true);

      const { rows } = await pool.query('SELECT codigo FROM acoes ORDER BY codigo');
      assert.deepEqual(
        resposta.dados.acoes.map((a) => a.codigo),
        rows.map((r) => r.codigo),
        'a tela recebe exatamente o catálogo do banco, na mesma ordem',
      );

      for (const acao of resposta.dados.acoes) {
        assert.equal(typeof acao.nome, 'string');
        assert.equal(typeof acao.ativo, 'boolean');
        assert.equal(typeof acao.exigeSst, 'boolean');
        assert.ok(['NENHUMA', 'ALTERNATIVA', 'OBRIGATORIA'].includes(acao.modoAutorizacaoIndividual));
      }
    });

    test('inclui as três ações administrativas da migration 024', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const codigos = (await EpiPermissoes.acoes.catalogoDeAcoes()).dados.acoes.map((a) => a.codigo);

      for (const codigo of Object.values(autoridade.ACOES_ADMINISTRATIVAS)) {
        assert.ok(codigos.includes(codigo), `faltou ${codigo} no catálogo`);
      }
    });

    test('a tela só oferece configuração para ações ALTERNATIVA e ativas', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const catalogo = (await EpiPermissoes.acoes.catalogoDeAcoes()).dados.acoes;
      const html = EpiPermissoes.render.tabelaAcoes(catalogo, {});

      for (const acao of catalogo) {
        const linha = EpiPermissoes.render.linhaAcao(acao, null);
        const configuravel = acao.ativo === true && acao.modoAutorizacaoIndividual === 'ALTERNATIVA';
        assert.equal(linha.includes('disabled'), !configuravel, `${acao.codigo} (${acao.modoAutorizacaoIndividual})`);
      }
      assert.ok(html.includes(acaoAlternativa));
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('tri-state de ponta a ponta', () => {
    test('grupo sem nenhuma configuração devolve listas vazias — e a tela mostra tudo herdando', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const recursos = await EpiPermissoes.acoes.listarRecursos(grupoA);
      assert.equal(recursos.ok, true);
      assert.deepEqual(recursos.dados.recursos, []);

      const html = EpiPermissoes.render.tabelaRecursos(
        EpiPermissoes.RECURSOS,
        EpiPermissoes.indexarPor(recursos.dados.recursos, 'recurso'),
      );
      assert.equal((html.match(/value="true" selected/g) || []).length, 0);
      assert.equal((html.match(/value="false" selected/g) || []).length, 0);
    });

    test('TRUE, FALSE e NULL sobrevivem à viagem completa e chegam assim ao banco', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const gravado = await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, {
        podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: false,
      });
      assert.equal(gravado.ok, true);
      assert.equal(gravado.dados.alterado, true);
      assert.deepEqual(
        {
          podeVisualizar: gravado.dados.configuracao.podeVisualizar,
          podeCriar: gravado.dados.configuracao.podeCriar,
          podeEditar: gravado.dados.configuracao.podeEditar,
          podeExcluir: gravado.dados.configuracao.podeExcluir,
        },
        { podeVisualizar: true, podeCriar: false, podeEditar: null, podeExcluir: false },
      );

      assert.deepEqual(await noBanco(grupoA, RECURSO), {
        pode_visualizar: true, pode_criar: false, pode_editar: null, pode_excluir: false,
      }, 'FALSE não virou NULL em nenhum ponto do caminho');
    });

    test('a consulta devolve os três estados distinguíveis e a tela os marca corretamente', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const lista = await EpiPermissoes.acoes.listarRecursos(grupoA);
      const configurado = lista.dados.recursos.find((r) => r.recurso === RECURSO);

      assert.equal(configurado.podeVisualizar, true);
      assert.equal(configurado.podeCriar, false);
      assert.equal(configurado.podeEditar, null);

      const linha = EpiPermissoes.render.linhaRecurso({ id: RECURSO, nome: 'Materiais' }, configurado);
      assert.equal((linha.match(/value="true" selected/g) || []).length, 1);
      assert.equal((linha.match(/value="false" selected/g) || []).length, 2);
      assert.equal((linha.match(/value="null" selected/g) || []).length, 1);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('alteração parcial preserva o que ninguém tocou', () => {
    test('mudar uma operação não altera as outras três no banco', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const antes = await noBanco(grupoA, RECURSO);
      const diferenca = EpiPermissoes.diferencaDeRecurso(
        {
          podeVisualizar: antes.pode_visualizar, podeCriar: antes.pode_criar,
          podeEditar: antes.pode_editar, podeExcluir: antes.pode_excluir,
        },
        {
          podeVisualizar: antes.pode_visualizar, podeCriar: true,
          podeEditar: antes.pode_editar, podeExcluir: antes.pode_excluir,
        },
      );
      assert.deepEqual(diferenca, { podeCriar: true }, 'só a operação alterada foi enviada');

      const resposta = await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, diferenca);
      assert.equal(resposta.ok, true);

      const depois = await noBanco(grupoA, RECURSO);
      assert.equal(depois.pode_criar, true, 'mudou o que devia');
      assert.equal(depois.pode_visualizar, antes.pode_visualizar);
      assert.equal(depois.pode_editar, antes.pode_editar, 'NULL continuou NULL');
      assert.equal(depois.pode_excluir, antes.pode_excluir, 'FALSE continuou FALSE, não virou NULL');
    });

    test('negar uma operação nunca apaga as demais: FALSE é gravado, os outros ficam', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const antes = await noBanco(grupoA, RECURSO);
      await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, { podeEditar: false });

      const depois = await noBanco(grupoA, RECURSO);
      assert.equal(depois.pode_editar, false, 'NULL virou FALSE porque foi pedido');
      assert.equal(depois.pode_criar, antes.pode_criar);
      assert.equal(depois.pode_visualizar, antes.pode_visualizar);
    });

    test('voltar uma operação para "herdar" grava NULL, sem tocar nas outras', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const antes = await noBanco(grupoA, RECURSO);
      await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, { podeEditar: null });

      const depois = await noBanco(grupoA, RECURSO);
      assert.equal(depois.pode_editar, null);
      assert.equal(depois.pode_criar, antes.pode_criar);
      assert.equal(depois.pode_excluir, antes.pode_excluir);
    });

    test('enviar o estado atual sem mudança nenhuma devolve alterado=false e não audita', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const antes = await noBanco(grupoA, RECURSO);
      const { rows: auditoriaAntes } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');

      const resposta = await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, {
        podeCriar: antes.pode_criar,
      });

      assert.equal(resposta.ok, true);
      assert.equal(resposta.dados.alterado, false);

      const { rows: auditoriaDepois } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria');
      assert.equal(auditoriaDepois[0].total, auditoriaAntes[0].total, 'sem mudança efetiva, sem auditoria');
    });

    test('recursos diferentes não se contaminam', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      await EpiPermissoes.acoes.configurarRecurso(grupoA, OUTRO_RECURSO, { podeVisualizar: false });

      const materiais = await noBanco(grupoA, RECURSO);
      const relatorios = await noBanco(grupoA, OUTRO_RECURSO);

      assert.equal(relatorios.pode_visualizar, false);
      assert.notEqual(materiais.pode_criar, relatorios.pode_criar);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('ações: modo do catálogo decidido pelo backend', () => {
    test('ação ALTERNATIVA aceita permitir, negar e herdar', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      for (const valor of [true, false, null]) {
        const resposta = await EpiPermissoes.acoes.configurarAcao(grupoA, acaoAlternativa, valor);
        assert.equal(resposta.ok, true, `${valor} deveria ser aceito`);
        assert.equal(resposta.dados.configuracao.permitido, valor);
      }

      const { rows } = await pool.query(
        'SELECT permitido FROM grupo_permissoes_acao WHERE grupo_acesso_id = $1 AND acao_codigo = $2',
        [grupoA, acaoAlternativa],
      );
      assert.equal(rows[0].permitido, null);
    });

    test('ação fora de ALTERNATIVA recusa permitir com 409 real, e a tela explica', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const resposta = await EpiPermissoes.acoes.configurarAcao(grupoA, acaoNaoAlternativa, true);

      assert.equal(resposta.status, 409);
      assert.equal(resposta.codigo, 'GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA');
      assert.match(EpiPermissoes.mensagens.deErro(resposta), /herdar/i);
    });

    test('ação inexistente no catálogo é recusada pelo backend', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const resposta = await EpiPermissoes.acoes.configurarAcao(grupoA, 'ACAO_QUE_NAO_EXISTE', true);

      assert.equal(resposta.ok, false);
      assert.ok([400, 404, 409].includes(resposta.status), `status inesperado: ${resposta.status}`);
      assert.notEqual(EpiPermissoes.mensagens.deErro(resposta), '');
    });

    test('a consulta de ações devolve o que foi configurado, indexável por acaoCodigo', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      await EpiPermissoes.acoes.configurarAcao(grupoA, acaoAlternativa, false);

      const lista = await EpiPermissoes.acoes.listarAcoes(grupoA);
      const mapa = EpiPermissoes.indexarPor(lista.dados.acoes, 'acaoCodigo');

      assert.equal(mapa[acaoAlternativa].permitido, false);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('autoridade administrativa da 3Q', () => {
    test('ADMINISTRADOR sem autorização recebe 403 nas três consultas e na gravação', async () => {
      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      const recursos = await EpiPermissoes.acoes.listarRecursos(grupoA);
      assert.equal(recursos.status, 403);
      assert.match(EpiPermissoes.mensagens.deErro(recursos), /não tem autorização/i);

      assert.equal((await EpiPermissoes.acoes.listarAcoes(grupoA)).status, 403);

      const catalogo = await EpiPermissoes.acoes.catalogoDeAcoes();
      assert.equal(catalogo.status, 403);
      assert.equal(catalogo.codigo, 'CATALOGO_NAO_AUTORIZADO');

      const gravacao = await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, { podeCriar: true });
      assert.equal(gravacao.status, 403);
    });

    test('403 não grava nada: o estado do banco fica idêntico', async () => {
      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      const antes = await noBanco(grupoA, RECURSO);
      await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, { podeExcluir: true });

      assert.deepEqual(await noBanco(grupoA, RECURSO), antes, 'a recusa terminou em ROLLBACK');
    });

    test('com ADMINISTRAR_PERMISSOES_GRUPO concedida pelo MASTER, o mesmo usuário passa a configurar', async () => {
      // Concessão pelo caminho real da 3I, com a ação da migration 024.
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA,
        concedidoPor: masterA,
        usuarioId: adminA,
        acaoCodigo: autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO,
      });

      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      assert.equal((await EpiPermissoes.acoes.listarRecursos(grupoA)).ok, true);
      assert.equal((await EpiPermissoes.acoes.catalogoDeAcoes()).ok, true, 'o catálogo acompanha a mesma autoridade');

      const gravacao = await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, { podeExcluir: true });
      assert.equal(gravacao.ok, true);
      assert.equal((await noBanco(grupoA, RECURSO)).pode_excluir, true);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('isolamento multiempresa e grupo inexistente', () => {
    test('o MASTER da empresa A não alcança o grupo da empresa B', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const consulta = await EpiPermissoes.acoes.listarRecursos(grupoB);
      assert.equal(consulta.status, 404);
      assert.match(EpiPermissoes.mensagens.deErro(consulta), /não existe/i);

      const gravacao = await EpiPermissoes.acoes.configurarRecurso(grupoB, RECURSO, { podeCriar: true });
      assert.equal(gravacao.status, 404);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS total FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1',
        [grupoB],
      );
      assert.equal(rows[0].total, 0, 'nada foi gravado no grupo da outra empresa');
    });

    test('o MASTER da empresa B não enxerga as permissões do grupo da empresa A', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_B, CNPJ_B);

      assert.equal((await EpiPermissoes.acoes.listarRecursos(grupoA)).status, 404);
    });

    test('grupo inexistente responde 404, não 500', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const resposta = await EpiPermissoes.acoes.listarRecursos(999999);
      assert.equal(resposta.status, 404);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('integração com a tela da 3S e ausência de regressões', () => {
    test('o seletor de grupos usa a listagem da 3S, sem duplicar contrato', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const lista = await EpiGrupos.acoes.listar({});
      assert.equal(lista.ok, true);
      assert.equal(lista.dados.grupos.some((g) => g.id === grupoA), true);
      assert.equal(lista.dados.grupos.every((g) => g.empresaId === empresaA), true);
    });

    test('um grupo inativado pela 3S continua configurável: as negações seguem valendo', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const inativado = await EpiGrupos.acoes.inativar(grupoA);
      assert.equal(inativado.ok, true);
      assert.equal(inativado.dados.grupo.ativo, false);

      const gravacao = await EpiPermissoes.acoes.configurarRecurso(grupoA, OUTRO_RECURSO, { podeCriar: false });
      assert.equal(gravacao.ok, true, 'configurar permissão não depende do grupo estar ativo');
      assert.equal((await noBanco(grupoA, OUTRO_RECURSO)).pode_criar, false);

      const reativado = await EpiGrupos.acoes.reativar(grupoA);
      assert.equal(reativado.dados.grupo.ativo, true);
    });

    test('configurar permissões nunca altera o cadastro do grupo', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const antes = (await EpiGrupos.acoes.buscar(grupoA)).dados.grupo;
      await EpiPermissoes.acoes.configurarRecurso(grupoA, RECURSO, { podeVisualizar: false });
      const depois = (await EpiGrupos.acoes.buscar(grupoA)).dados.grupo;

      assert.equal(depois.nome, antes.nome);
      assert.equal(depois.descricao, antes.descricao);
      assert.equal(depois.ativo, antes.ativo);
    });

    test('nenhuma das duas telas oferece caminho de exclusão física de permissão', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const resposta = await EpiHttp.requisitar('DELETE', `/grupos-acesso/${grupoA}/permissoes/recursos/${RECURSO}`);

      assert.equal(resposta.ok, false);
      assert.ok([404, 405].includes(resposta.status), `status inesperado: ${resposta.status}`);

      const { rows } = await pool.query(
        'SELECT count(*)::int AS total FROM grupo_permissoes_recurso WHERE grupo_acesso_id = $1 AND recurso = $2',
        [grupoA, RECURSO],
      );
      assert.equal(rows[0].total, 1, 'a configuração continua lá');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('controlador da tela contra o servidor real (correção pós-auditoria)', () => {
    /**
     * A guarda contra resposta fora de ordem é exercitada com respostas
     * controladas nos testes unitários do frontend, onde dá para
     * resolvê-las na ordem errada de propósito. O que se prova AQUI é o
     * outro lado: que o controlador criado por aquela correção conversa
     * de verdade com o backend — carrega, grava o tri-state, preserva o
     * que não mudou e sempre escreve no grupo de origem.
     */
    function uiFalso() {
      const registro = { recursos: [], acoes: [], avisos: [], inativo: [], sessao: [] };
      return {
        registro,
        renderRecursos(html) { registro.recursos.push(html); },
        renderAcoes(html) { registro.acoes.push(html); },
        aviso(texto, tipo) { registro.avisos.push({ texto, tipo }); },
        grupoInativo(valor) { registro.inativo.push(valor); },
        sessaoExpirada(mensagem) { registro.sessao.push(mensagem); },
      };
    }

    test('carrega um grupo real e mostra o que o servidor devolveu', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiPermissoes.criarControlador({ ui });

      const resultado = await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3T' });

      assert.equal(resultado.status, 'ok');
      assert.equal(resultado.grupo, grupoA);
      assert.equal(controlador.grupoAtual(), grupoA);
      assert.equal(ui.registro.sessao.length, 0);
      assert.ok(ui.registro.recursos.length >= 2, 'pintou "carregando" e depois a tabela');
      assert.match(ultimoDe(ui.registro.recursos), /data-recurso="materials"/);
    });

    test('grava o tri-state pelo controlador e preserva as operações não tocadas', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const controlador = EpiPermissoes.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3T' });

      const antes = await noBanco(grupoA, RECURSO);
      const naTela = {
        podeVisualizar: antes.pode_visualizar,
        podeCriar: antes.pode_criar,
        podeEditar: true,                      // a única mudança
        podeExcluir: antes.pode_excluir,
      };

      const resultado = await controlador.salvarRecurso(RECURSO, naTela);
      assert.equal(resultado.status, 'ok');
      assert.equal(resultado.grupo, grupoA);

      const depois = await noBanco(grupoA, RECURSO);
      assert.equal(depois.pode_editar, true);
      assert.equal(depois.pode_visualizar, antes.pode_visualizar);
      assert.equal(depois.pode_criar, antes.pode_criar);
      assert.equal(depois.pode_excluir, antes.pode_excluir, 'FALSE não virou NULL');
    });

    test('a gravação atinge o grupo de origem mesmo com outro selecionado depois', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      // Um segundo grupo da MESMA empresa, para que a troca seja legítima.
      const { rows } = await pool.query(
        'INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id',
        [empresaA, 'Segundo Grupo 3T', masterA],
      );
      const segundoGrupo = rows[0].id;

      const controlador = EpiPermissoes.criarControlador({ ui: uiFalso() });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3T' });

      const gravando = controlador.salvarRecurso('config', {
        podeVisualizar: true, podeCriar: null, podeEditar: null, podeExcluir: null,
      });
      // Troca de grupo antes de a gravação terminar.
      const trocando = controlador.selecionar(segundoGrupo, { nome: 'Segundo Grupo 3T' });

      const [resultadoGravacao] = await Promise.all([gravando, trocando]);

      assert.equal(resultadoGravacao.grupo, grupoA, 'a escrita pertenceu ao grupo de origem');
      assert.equal(controlador.grupoAtual(), segundoGrupo);

      const origem = await noBanco(grupoA, 'config');
      const destino = await noBanco(segundoGrupo, 'config');
      assert.equal(origem.pode_visualizar, true, 'gravou no grupo certo');
      assert.equal(destino, null, 'o grupo selecionado depois não recebeu nada');
    });

    test('sessão revogada durante o uso devolve ao login pelo controlador', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const ui = uiFalso();
      const controlador = EpiPermissoes.criarControlador({ ui });
      await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3T' });

      await pool.query('UPDATE sessoes SET revogada_em = now(), motivo_revogacao = $1 WHERE revogada_em IS NULL', ['TESTE']);

      const resultado = await controlador.selecionar(grupoA, { nome: 'Almoxarifado 3T' });

      assert.equal(resultado.status, 'sessao');
      assert.equal(ui.registro.sessao.length, 1);
      assert.match(ui.registro.sessao[0], /sess(ã|a)o expirou/i);
      assert.equal(controlador.grupoAtual(), null);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('autoridade forjada pelo cliente não vale', () => {
    test('barreira 1: o cliente HTTP recusa empresaId no corpo antes de sair do navegador', async () => {
      navegadorNovo();
      await entrar(EMAIL_ADMIN_A);  // autorizado apenas na empresa A

      await assert.rejects(
        () => EpiHttp.requisitar('PATCH', `/grupos-acesso/${grupoA}/permissoes/recursos/${RECURSO}`, {
          corpo: { podeCriar: true, empresaId: empresaB },
        }),
        (erro) => {
          assert.ok(erro instanceof TypeError);
          assert.match(erro.message, /empresaId/);
          assert.match(erro.message, /sess(ã|a)o/i);
          return true;
        },
      );

      const { rows } = await pool.query(
        'SELECT count(*)::int AS total FROM grupo_permissoes_recurso WHERE empresa_id = $1',
        [empresaB],
      );
      assert.equal(rows[0].total, 0);
    });

    test('barreira 2: contornando o cliente, o Zod strict da 3N recusa o mesmo campo', async () => {
      const navegador = navegadorNovo();
      await entrar(EMAIL_ADMIN_A);

      // Requisição crua, sem passar pelo EpiHttp — é o que um atacante
      // faria. A sessão vai junto: o que se prova aqui é a recusa do
      // CAMPO, não a falta de autenticação.
      const cookie = [...navegador.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      const resposta = await fetch(`${baseUrl}/grupos-acesso/${grupoA}/permissoes/recursos/${RECURSO}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: origem, Cookie: cookie },
        body: JSON.stringify({ podeCriar: true, empresaId: empresaB }),
      });

      assert.equal(resposta.status, 400);
      assert.equal((await resposta.json()).codigo, 'VALIDACAO');

      const { rows } = await pool.query(
        'SELECT count(*)::int AS total FROM grupo_permissoes_recurso WHERE empresa_id = $1',
        [empresaB],
      );
      assert.equal(rows[0].total, 0, 'a empresa B continua sem nenhuma permissão de grupo');
    });

    test('campo desconhecido no corpo é recusado pelo Zod strict da 3N', async () => {
      navegadorNovo();
      await entrar(EMAIL_MASTER_A);

      const resposta = await EpiHttp.requisitar('PATCH', `/grupos-acesso/${grupoA}/permissoes/recursos/${RECURSO}`, {
        corpo: { podeCriar: true, podeTudo: true },
      });

      assert.equal(resposta.status, 400);
      assert.equal(resposta.codigo, 'VALIDACAO');
    });
  });
});
