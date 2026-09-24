'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAutorizacaoIndividualController } = require('../../src/controllers/autorizacao-individual.controller');
const { criarAutorizacaoIndividualRoutes } = require('../../src/routes/autorizacao-individual.routes');
const { criarAutorizacaoConsultaController } = require('../../src/controllers/autorizacao-consulta.controller');
const { criarAutorizacaoConsultaRoutes } = require('../../src/routes/autorizacao-consulta.routes');
const { criarCatalogoController } = require('../../src/controllers/catalogo.controller');
const { criarCatalogoRoutes } = require('../../src/routes/catalogo.routes');
const { criarUsuarioConsultaController } = require('../../src/controllers/usuario-consulta.controller');
const { criarUsuarioConsultaRoutes } = require('../../src/routes/usuario-consulta.routes');
const { criarDelegacaoDestinatariosController } = require('../../src/controllers/delegacao-destinatarios.controller');
const { criarDelegacaoDestinatariosRoutes } = require('../../src/routes/delegacao-destinatarios.routes');
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

const EpiHttp = require('../../../frontend/js/api-http');
const EpiAuth = require('../../../frontend/js/auth-session');
const EpiAutorizacoes = require('../../../frontend/js/autorizacoes-individuais');

/**
 * Tela de autorizações individuais (Subetapa 3V) contra o backend REAL:
 * frontend/js/autorizacoes-individuais.js exercitado de ponta a ponta —
 * servidor HTTP de verdade, middlewares de produção, rotas reais da 3P,
 * a consulta criada nesta subetapa, o catálogo da 3T, a consulta de
 * pessoas da 3U e PostgreSQL real em schema temporário exclusivo.
 *
 * O que só este teste prova, verificado lendo usuario_autorizacoes:
 *
 *   • o MASTER concede direto pela tela e a linha nasce sem origem;
 *   • um não-MASTER com autorização repassável delega pela tela, a
 *     linha nasce com origem_id apontando para a dele, e a AÇÃO é a da
 *     origem — sem que a tela a tenha escolhido;
 *   • sem pode_delegar não há origem oferecida, e a tentativa crua
 *     recebe 403 do backend;
 *   • origem forjada (de outra pessoa) recebe 403 e não cria nada;
 *   • revogar a origem faz a delegada cair junto (FK da 023), e a tela
 *     informa quantas caíram — enquanto a direta independente de outro
 *     caminho continua existindo;
 *   • a regra de SST vale para delegar: quem tem a origem repassável
 *     mas não integra a SST NÃO consegue delegar uma ação que exige
 *     SST; ao entrar na SST, consegue;
 *   • outra empresa não lê nem revoga;
 *   • troca de pessoa com confirmação aberta não escreve nada.
 *
 * A migration 024 é aplicada NESTE SCHEMA TEMPORÁRIO apenas.
 */

const MIGRATIONS = ['000', '001', '002', '003', '005', '025', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024'];

const SENHA = 'senha-correta-do-teste-3v-2026';
const CNPJ_A = '12345678000195';
const CNPJ_B = '98765432000110';
const EMAIL_MASTER_A = 'master-a@demo.safeworkengenharia.com.br';
const EMAIL_ADMIN_A = 'admin-a@demo.safeworkengenharia.com.br';
const EMAIL_ANA = 'ana@demo.safeworkengenharia.com.br';
const EMAIL_MASTER_B = 'master-b@demo.safeworkengenharia.com.br';

const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';
const ACAO_COM_SST = 'APROVAR_SOLICITACAO';   // OBRIGATORIA + exige_sst (migration 017)

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
    autorizacoes: [], pessoas: [], avisos: [], escopos: [], origens: [],
    acoesConcediveis: [], podeConceder: [], avisoDelegacao: [], sessao: [], usuario: [],
  };
  return {
    registro,
    renderAutorizacoes(html) { registro.autorizacoes.push(html); },
    renderPessoas(valor, total) { registro.pessoas.push({ valor, total }); },
    aviso(texto, tipo) { registro.avisos.push({ texto, tipo }); },
    escopo(texto) { registro.escopos.push(texto); },
    origens(html, quantas) { registro.origens.push({ html, quantas }); },
    acoesConcediveis(html, temAlguma) { registro.acoesConcediveis.push({ html, temAlguma }); },
    podeConcederDireta(pode) { registro.podeConceder.push(pode); },
    avisoDelegacao(texto) { registro.avisoDelegacao.push(texto); },
    sessaoExpirada(mensagem) { registro.sessao.push(mensagem); },
    usuarioSelecionado(nome) { registro.usuario.push(nome); },
  };
}

const ultimoDe = (lista) => lista[lista.length - 1];

describe('tela de autorizações individuais (3V) contra o backend real', () => {
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
  let zilda;   // inativa — D. nunca é oferecida como destinatária

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
    ana = await inserirUsuario(empresaA, EMAIL_ANA, 'USUARIO', 'Ana Souza');
    bruno = await inserirUsuario(empresaA, 'bruno@demo.safeworkengenharia.com.br', 'SUPERVISOR', 'Bruno Lima');
    zilda = await inserirUsuario(empresaA, 'zilda@demo.safeworkengenharia.com.br', 'USUARIO', 'Zilda Inativa', false);
    await inserirUsuario(empresaB, EMAIL_MASTER_B, 'MASTER', 'Master da Empresa B');

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
      criarAutorizacaoIndividualRoutes({ controller: criarAutorizacaoIndividualController({ pool }), exigirSessao }),
      criarAutorizacaoConsultaRoutes({ controller: criarAutorizacaoConsultaController({ pool }), exigirSessao }),
      criarCatalogoRoutes({ controller: criarCatalogoController({ pool }), exigirSessao }),
      criarUsuarioConsultaRoutes({ controller: criarUsuarioConsultaController({ pool }), exigirSessao }),
      // Complemento de destinatários: a rota que o delegador não-MASTER usa.
      criarDelegacaoDestinatariosRoutes({ controller: criarDelegacaoDestinatariosController({ pool }), exigirSessao }),
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

  /** Login pela tela e controlador iniciado com a identidade REAL da sessão. */
  async function entrarComoTela(email, cnpj = CNPJ_A) {
    navegadorNovo();
    const entrada = await EpiAuth.entrar({ cnpj, email, senha: SENHA });
    assert.equal(entrada.ok, true, `login de ${email} deveria ter sucesso`);
    const ui = uiFalso();
    const controlador = EpiAutorizacoes.criarControlador({ ui });
    const inicio = await controlador.iniciar({ id: entrada.identidade.usuario.id, perfil: entrada.identidade.usuario.perfil });
    return { ui, controlador, inicio, identidade: entrada.identidade };
  }

  async function autorizacoesNoBanco(usuarioId) {
    const { rows } = await pool.query(
      'SELECT id, acao_codigo, autorizado_por, pode_delegar, origem_id FROM usuario_autorizacoes WHERE usuario_id = $1 ORDER BY id',
      [usuarioId],
    );
    return rows;
  }

  async function limparAutorizacoes() {
    await pool.query('DELETE FROM usuario_autorizacoes WHERE empresa_id = $1', [empresaA]);
    await pool.query('DELETE FROM vinculo_sst WHERE empresa_id = $1', [empresaA]);
  }

  // ───────────────────────────────────────────────────────────────────
  describe('início e identidade real', () => {
    test('MASTER inicia com catálogo e permissão de conceder; sem origem para delegar', async () => {
      await limparAutorizacoes();
      const { inicio, ui } = await entrarComoTela(EMAIL_MASTER_A);

      assert.equal(inicio.status, 'ok');
      assert.equal(inicio.podeConceder, true);
      assert.ok(inicio.acoes > 0, 'o catálogo real chegou');
      assert.equal(inicio.origens, 0);
      assert.match(ultimoDe(ui.registro.avisoDelegacao), /Master não delega/i);
    });

    test('ADMINISTRADOR inicia sem poder conceder e sem catálogo, e a tela sobrevive', async () => {
      await limparAutorizacoes();
      const { inicio } = await entrarComoTela(EMAIL_ADMIN_A);

      assert.equal(inicio.status, 'ok');
      assert.equal(inicio.podeConceder, false);
      assert.equal(inicio.acoes, 0, 'sem ADMINISTRAR_PERMISSOES_GRUPO o catálogo é 403, e isso não derruba a tela');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('A/B. consulta e concessão direta', () => {
    test('B. o MASTER concede direto pela tela: a linha nasce sem origem', async () => {
      await limparAutorizacoes();
      const { controlador, ui } = await entrarComoTela(EMAIL_MASTER_A);
      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      const pedido = controlador.prepararConcessao({ acaoCodigo: ACAO_ALTERNATIVA, acaoNome: 'Movimentar estoque', podeDelegar: true });
      const resultado = await controlador.confirmar(pedido);

      assert.equal(resultado.status, 'ok');
      const linhas = await autorizacoesNoBanco(ana);
      assert.equal(linhas.length, 1);
      assert.equal(linhas[0].acao_codigo, ACAO_ALTERNATIVA);
      assert.equal(linhas[0].autorizado_por, masterA);
      assert.equal(linhas[0].origem_id, null);
      assert.equal(linhas[0].pode_delegar, true);
      assert.match(ultimoDe(ui.registro.avisos).texto, /agora pode/i);
    });

    test('A. a consulta pela tela mostra o que existe, com nomes e escopo', async () => {
      const { controlador, ui } = await entrarComoTela(EMAIL_MASTER_A);

      const resultado = await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      assert.equal(resultado.status, 'ok');
      assert.equal(resultado.total, 1);
      assert.equal(resultado.escopo, 'TOTAL');
      const html = ultimoDe(ui.registro.autorizacoes);
      assert.match(html, /Concedida por Master da Empresa A/);
      assert.match(html, /Direta/);
      assert.match(html, /pode repassar adiante/);
    });

    test('L. conceder de novo a mesma ação é 409, e a tela explica', async () => {
      const { controlador, ui } = await entrarComoTela(EMAIL_MASTER_A);
      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      const resultado = await controlador.confirmar(
        controlador.prepararConcessao({ acaoCodigo: ACAO_ALTERNATIVA, acaoNome: 'Movimentar estoque' }),
      );

      assert.equal(resultado.status, 'erro');
      assert.match(ultimoDe(ui.registro.avisos).texto, /já tem/i);
      assert.equal((await autorizacoesNoBanco(ana)).length, 1, 'nada duplicou');
    });

    test('K. não-MASTER tentando conceder direto recebe 403 do backend', async () => {
      navegadorNovo();
      await EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_ADMIN_A, senha: SENHA });

      const resposta = await EpiAutorizacoes.acoes.concederDireta({ usuarioId: bruno, acaoCodigo: ACAO_ALTERNATIVA });

      assert.equal(resposta.status, 403);
      assert.equal(resposta.codigo, 'CONCESSAO_NAO_AUTORIZADA');
      assert.match(EpiAutorizacoes.mensagens.deErro(resposta), /master/i);
      assert.equal((await autorizacoesNoBanco(bruno)).length, 0);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('C/D/E. delegação', () => {
    let origemDoAdmin;

    test('C. delegação válida: a origem aparece na tela e a ação é herdada', async () => {
      await limparAutorizacoes();
      // O MASTER concede ao ADMINISTRADOR, repassável.
      origemDoAdmin = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });

      const { controlador, inicio, ui } = await entrarComoTela(EMAIL_ADMIN_A);
      assert.equal(inicio.origens, 1, 'a autorização repassável virou origem oferecida');
      assert.match(ultimoDe(ui.registro.origens).html, new RegExp(`value="${origemDoAdmin.id}"`));

      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });
      const pedido = controlador.prepararDelegacao({ origemId: origemDoAdmin.id });
      assert.equal(pedido.acaoCodigo, ACAO_ALTERNATIVA, 'a ação veio da origem, não do formulário');

      const resultado = await controlador.confirmar(pedido);

      assert.equal(resultado.status, 'ok');
      const linhas = await autorizacoesNoBanco(ana);
      assert.equal(linhas.length, 1);
      assert.equal(linhas[0].origem_id, origemDoAdmin.id, 'a delegada aponta para a origem');
      assert.equal(linhas[0].autorizado_por, adminA);
      assert.equal(linhas[0].acao_codigo, ACAO_ALTERNATIVA);
      assert.match(ultimoDe(ui.registro.avisos).texto, /repassou/i);
    });

    test('a tela do delegador vê o que ele delegou; a direta do Master a Ana, não', async () => {
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: ana, acaoCodigo: ACAO_COM_SST,
      });

      const { controlador, ui } = await entrarComoTela(EMAIL_ADMIN_A);
      const resultado = await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      assert.equal(resultado.escopo, 'CONCEDIDAS_POR_MIM');
      assert.equal(resultado.total, 1, 'só a delegada por ele');
      assert.match(ultimoDe(ui.registro.escopos), /apenas as autorizações que você mesmo concedeu/i);
      assert.equal(ultimoDe(ui.registro.autorizacoes).includes(ACAO_COM_SST), false);
    });

    test('D. sem pode_delegar não há origem oferecida, e a tentativa crua é 403', async () => {
      await limparAutorizacoes();
      const semRepasse = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: false,
      });

      const { controlador, inicio, ui } = await entrarComoTela(EMAIL_ADMIN_A);
      assert.equal(inicio.origens, 0);
      assert.match(ultimoDe(ui.registro.avisoDelegacao), /repassável/i);

      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });
      assert.equal(controlador.prepararDelegacao({ origemId: semRepasse.id }), null, 'a tela não monta o pedido');

      // Contornando a tela: o backend recusa.
      const crua = await EpiAutorizacoes.acoes.delegar({ usuarioId: ana, origemId: semRepasse.id });
      assert.equal(crua.status, 403);
      assert.equal(crua.codigo, 'DELEGACAO_NAO_AUTORIZADA');
      assert.equal((await autorizacoesNoBanco(ana)).length, 0);
    });

    test('E. origem de OUTRA pessoa é recusada pelo backend, mesmo com pode_delegar', async () => {
      await limparAutorizacoes();
      const origemDoBruno = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: bruno, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });

      navegadorNovo();
      await EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_ADMIN_A, senha: SENHA });

      const resposta = await EpiAutorizacoes.acoes.delegar({ usuarioId: ana, origemId: origemDoBruno.id });

      assert.equal(resposta.status, 403);
      assert.equal((await autorizacoesNoBanco(ana)).length, 0, 'origem forjada não fabrica cadeia');
    });

    test('E. origem inexistente também é 403, não 500', async () => {
      navegadorNovo();
      await EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_ADMIN_A, senha: SENHA });

      const resposta = await EpiAutorizacoes.acoes.delegar({ usuarioId: ana, origemId: 999999 });

      assert.equal(resposta.status, 403);
    });

    test('autoconcessão é recusada nos dois caminhos', async () => {
      await limparAutorizacoes();
      const { controlador: master } = await entrarComoTela(EMAIL_MASTER_A);
      await master.selecionar({ id: masterA, nome: 'Master da Empresa A' });
      const direta = await master.confirmar(master.prepararConcessao({ acaoCodigo: ACAO_ALTERNATIVA, acaoNome: 'X' }));
      assert.equal(direta.status, 'erro');

      const origemDoAdmin2 = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      const { controlador: admin, ui } = await entrarComoTela(EMAIL_ADMIN_A);
      await admin.selecionar({ id: adminA, nome: 'Administrador da Empresa A' });
      const delegada = await admin.confirmar(admin.prepararDelegacao({ origemId: origemDoAdmin2.id }));
      assert.equal(delegada.status, 'erro');
      assert.match(ultimoDe(ui.registro.avisos).texto, /si mesmo/i);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('Q. a regra de SST vale para delegar', () => {
    test('com origem repassável mas FORA da SST, delegar ação que exige SST é 403', async () => {
      await limparAutorizacoes();
      const origemComSst = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_COM_SST, podeDelegar: true,
      });

      const { controlador, inicio, ui } = await entrarComoTela(EMAIL_ADMIN_A);
      assert.equal(inicio.origens, 1, 'a tela oferece a origem — é o backend que decide');
      assert.match(ultimoDe(ui.registro.origens).html, /Aprovar|APROVAR/i);

      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });
      const resultado = await controlador.confirmar(controlador.prepararDelegacao({ origemId: origemComSst.id }));

      assert.equal(resultado.status, 'erro');
      assert.match(ultimoDe(ui.registro.avisos).texto, /valendo para você agora/i);
      assert.equal((await autorizacoesNoBanco(ana)).length, 0, 'poder executar não é poder delegar');
    });

    test('ao integrar a SST, o mesmo delegador passa a conseguir', async () => {
      await pool.query(
        'INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)',
        [adminA, empresaA, masterA],
      );
      const { rows } = await pool.query(
        'SELECT id FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = $2', [adminA, ACAO_COM_SST],
      );

      const { controlador } = await entrarComoTela(EMAIL_ADMIN_A);
      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });
      const resultado = await controlador.confirmar(controlador.prepararDelegacao({ origemId: rows[0].id }));

      assert.equal(resultado.status, 'ok');
      const linhas = await autorizacoesNoBanco(ana);
      assert.equal(linhas.length, 1);
      assert.equal(linhas[0].acao_codigo, ACAO_COM_SST);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('F/G/H. revogação, cascata e independentes', () => {
    let origem;
    let delegada;
    let independente;

    test('cenário: master -> admin (repassável) -> ana; e master -> ana, independente', async () => {
      await limparAutorizacoes();
      origem = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      delegada = await autorizacaoServico.delegar(pool, {
        empresaId: empresaA, concedidoPor: adminA, origemId: origem.id, usuarioId: ana,
      });
      independente = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: ana, acaoCodigo: ACAO_COM_SST,
      });
      assert.equal((await autorizacoesNoBanco(ana)).length, 2);
    });

    test('K. Ana não revoga o que o Master lhe concedeu: a tela não oferece, e o backend recusa com 403', async () => {
      const { controlador, ui } = await entrarComoTela(EMAIL_ANA);
      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      // Barreira 1 (correção pós-auditoria, item 3): sem botão, sem pedido.
      const html = ultimoDe(ui.registro.autorizacoes);
      assert.equal(html.includes(`data-autorizacao="${independente.id}">Revogar`), false);
      assert.match(html, /Só quem concedeu pode revogar/);
      assert.equal(controlador.prepararRevogacao(independente.id), null);

      // Barreira 2: contornando a tela, o serviço da 3I recusa.
      const crua = await EpiAutorizacoes.acoes.revogar(independente.id);
      assert.equal(crua.status, 403);
      assert.equal(crua.codigo, 'REVOGACAO_NAO_AUTORIZADA');
      assert.match(EpiAutorizacoes.mensagens.deErro(crua), /você mesmo concedeu/i);
      assert.equal((await autorizacoesNoBanco(ana)).length, 2);
    });

    test('F. o delegador revoga o que delegou, e a confirmação nunca promete demais', async () => {
      const { controlador, ui } = await entrarComoTela(EMAIL_ADMIN_A);
      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      const pedido = controlador.prepararRevogacao(delegada.id);
      assert.ok(pedido, 'a delegada é visível ao delegador');
      const alvo = controlador.autorizacoes().find((a) => a.id === delegada.id);
      assert.match(EpiAutorizacoes.mensagens.confirmacaoDeRevogacao(alvo), /por outro caminho não são afetadas/i);

      const resultado = await controlador.confirmar(pedido);

      assert.equal(resultado.status, 'ok');
      const restantes = await autorizacoesNoBanco(ana);
      assert.deepEqual(restantes.map((r) => r.id), [independente.id], 'H. a independente ficou');
    });

    test('G. revogar a ORIGEM faz a delegada cair junto, e a tela conta quantas', async () => {
      // Recria a delegada para o cenário de cascata.
      delegada = await autorizacaoServico.delegar(pool, {
        empresaId: empresaA, concedidoPor: adminA, origemId: origem.id, usuarioId: ana,
      });
      assert.equal((await autorizacoesNoBanco(ana)).length, 2);

      const { controlador, ui } = await entrarComoTela(EMAIL_MASTER_A);
      await controlador.selecionar({ id: adminA, nome: 'Administrador da Empresa A' });

      const resultado = await controlador.confirmar(controlador.prepararRevogacao(origem.id));

      assert.equal(resultado.status, 'ok');
      assert.match(ultimoDe(ui.registro.avisos).texto, /A autorização que tinha sido repassada a partir dela também caiu/);
      assert.equal((await autorizacoesNoBanco(adminA)).length, 0, 'a origem caiu');

      const deAna = await autorizacoesNoBanco(ana);
      assert.deepEqual(deAna.map((r) => r.id), [independente.id], 'H. a delegada caiu, a independente ficou');
    });

    test('L. revogar uma autorização inexistente é 404, e a tela explica', async () => {
      const { controlador, ui } = await entrarComoTela(EMAIL_MASTER_A);
      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      const resposta = await EpiAutorizacoes.acoes.revogar(999999);

      assert.equal(resposta.status, 404);
      assert.match(EpiAutorizacoes.mensagens.deErro(resposta), /não existe mais/i);
      assert.equal(ui.registro.sessao.length, 0);
    });

    test('as operações continuam auditadas pela 3I', async () => {
      const { rows: antes } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaA]);

      const { controlador } = await entrarComoTela(EMAIL_MASTER_A);
      await controlador.selecionar({ id: bruno, nome: 'Bruno Lima' });
      await controlador.confirmar(controlador.prepararConcessao({ acaoCodigo: ACAO_ALTERNATIVA, acaoNome: 'X' }));

      const { rows: depois } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaA]);
      assert.ok(depois[0].total > antes[0].total, 'a concessão deixou rastro');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('I. isolamento multiempresa', () => {
    test('o MASTER da empresa B não lê nem revoga nada da empresa A', async () => {
      const { rows } = await pool.query('SELECT id FROM usuario_autorizacoes WHERE empresa_id = $1 LIMIT 1', [empresaA]);
      assert.ok(rows.length > 0, 'há autorização na empresa A');

      const { controlador } = await entrarComoTela(EMAIL_MASTER_B, CNPJ_B);
      const consulta = await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      assert.equal(consulta.status, 'ok');
      assert.equal(consulta.total, 0, 'o id existe, mas não nesta empresa');

      const revogacao = await EpiAutorizacoes.acoes.revogar(rows[0].id);
      assert.equal(revogacao.status, 404, 'conhecer o id não dá acesso');

      const { rows: ainda } = await pool.query('SELECT 1 FROM usuario_autorizacoes WHERE id = $1', [rows[0].id]);
      assert.equal(ainda.length, 1, 'continua lá');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('J/N/P. sessão e confirmação amarrada ao contexto', () => {
    test('J. sessão revogada no meio do uso devolve ao login', async () => {
      const { controlador, ui } = await entrarComoTela(EMAIL_MASTER_A);
      assert.equal((await controlador.selecionar({ id: ana, nome: 'Ana Souza' })).status, 'ok');

      await pool.query('UPDATE sessoes SET revogada_em = now(), motivo_revogacao = $1 WHERE revogada_em IS NULL', ['TESTE']);

      const depois = await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      assert.equal(depois.status, 'sessao');
      assert.equal(ui.registro.sessao.length, 1);
      assert.equal(controlador.usuarioSelecionado(), null);
    });

    test('N/P. trocar de pessoa com confirmação aberta: NADA é escrito no banco', async () => {
      await limparAutorizacoes();
      const { controlador, ui } = await entrarComoTela(EMAIL_MASTER_A);
      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });

      // Confirmação preparada para Ana...
      const pedido = controlador.prepararConcessao({ acaoCodigo: ACAO_ALTERNATIVA, acaoNome: 'Movimentar estoque' });

      // ...e a pessoa troca para Bruno antes de confirmar.
      await controlador.selecionar({ id: bruno, nome: 'Bruno Lima' });

      const resultado = await controlador.confirmar(pedido);

      assert.equal(resultado.status, 'contexto-mudou');
      assert.equal((await autorizacoesNoBanco(ana)).length, 0, 'nada para Ana');
      assert.equal((await autorizacoesNoBanco(bruno)).length, 0, 'nada para Bruno');
      assert.match(ultimoDe(ui.registro.avisos).texto, /pessoa selecionada mudou/i);
    });

    test('P. a revogação com contexto alterado também não escreve', async () => {
      await limparAutorizacoes();
      const alvo = await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: ana, acaoCodigo: ACAO_ALTERNATIVA,
      });

      const { controlador } = await entrarComoTela(EMAIL_MASTER_A);
      await controlador.selecionar({ id: ana, nome: 'Ana Souza' });
      const pedido = controlador.prepararRevogacao(alvo.id);
      await controlador.selecionar({ id: bruno, nome: 'Bruno Lima' });

      assert.equal((await controlador.confirmar(pedido)).status, 'contexto-mudou');
      assert.equal((await autorizacoesNoBanco(ana)).length, 1, 'a autorização continua lá');
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('DESTINATÁRIOS (complemento). delegador sem autoridade administrativa localiza a quem repassar', () => {
    test('A. ADMINISTRADOR com origem repassável, SEM ADMINISTRAR_VINCULOS_GRUPO, pesquisa e encontra Ana', async () => {
      await limparAutorizacoes();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      // Garantia do cenário: nenhuma autoridade administrativa de grupos.
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo LIKE 'ADMINISTRAR_%'", [adminA],
      );
      assert.equal(rows[0].n, 0);

      const { controlador, inicio, ui } = await entrarComoTela(EMAIL_ADMIN_A);
      assert.equal(inicio.origens, 1);

      const resultado = await controlador.buscarPessoas('ana');

      assert.equal(resultado.status, 'ok', 'a limitação registrada na 3V deixa de existir');
      const pessoas = ultimoDe(ui.registro.pessoas).valor;
      assert.equal(pessoas.some((p) => p.id === ana && p.nome === 'Ana Souza'), true);
      assert.equal(pessoas.some((p) => p.id === adminA), false, 'o próprio delegador não aparece');
      assert.equal(pessoas.some((p) => p.id === zilda), false, 'D. inativa não aparece');
    });

    test('A. e a delegação completa pela tela, com a ação herdada da origem', async () => {
      const { controlador, ui } = await entrarComoTela(EMAIL_ADMIN_A);
      await controlador.buscarPessoas('ana');
      const alvo = ultimoDe(ui.registro.pessoas).valor.find((p) => p.id === ana);
      await controlador.selecionar({ id: alvo.id, nome: alvo.nome });

      const origem = controlador.origensDelegaveis()[0];
      const resultado = await controlador.confirmar(controlador.prepararDelegacao({ origemId: origem.id }));

      assert.equal(resultado.status, 'ok');
      const linhas = await autorizacoesNoBanco(ana);
      assert.equal(linhas.length, 1);
      assert.equal(linhas[0].origem_id, origem.id);
      assert.equal(linhas[0].acao_codigo, ACAO_ALTERNATIVA);
    });

    test('B. quem não pode delegar recebe a explicação, não uma lista', async () => {
      await limparAutorizacoes();
      const { controlador, ui } = await entrarComoTela(EMAIL_ANA);

      const resultado = await controlador.buscarPessoas('');

      assert.equal(resultado.status, 'erro');
      assert.match(ultimoDe(ui.registro.pessoas).valor, /repass/i);
    });

    test('F. consultar destinatários não deu à pessoa autoridade sobre vínculos de grupo', async () => {
      await limparAutorizacoes();
      await autorizacaoServico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: adminA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      const { controlador } = await entrarComoTela(EMAIL_ADMIN_A);
      assert.equal((await controlador.buscarPessoas('')).status, 'ok');

      const rotaDa3U = await EpiHttp.requisitar('GET', '/usuarios');
      assert.equal(rotaDa3U.status, 403, 'a rota administrativa da 3U continua fechada para ele');
    });

    test('o MASTER continua usando a rota da 3U e vendo a lista administrativa', async () => {
      const { controlador, ui } = await entrarComoTela(EMAIL_MASTER_A);

      const resultado = await controlador.buscarPessoas('');

      assert.equal(resultado.status, 'ok');
      assert.ok(ultimoDe(ui.registro.pessoas).valor.length >= 4);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  describe('autoridade forjada pelo cliente não vale', () => {
    test('barreira 1: o cliente HTTP recusa empresaId no corpo', async () => {
      navegadorNovo();
      await EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_MASTER_A, senha: SENHA });

      await assert.rejects(
        () => EpiHttp.requisitar('POST', '/autorizacoes-individuais', {
          corpo: { tipo: 'DIRETA', usuarioId: ana, acaoCodigo: ACAO_ALTERNATIVA, empresaId: 999 },
        }),
        (erro) => erro instanceof TypeError && /empresaId/.test(erro.message),
      );
    });

    test('barreira 2: contornando o cliente, o Zod da 3P recusa concedidoPor e autorizadoPor', async () => {
      const navegador = navegadorNovo();
      await EpiAuth.entrar({ cnpj: CNPJ_A, email: EMAIL_MASTER_A, senha: SENHA });
      const cookie = [...navegador.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

      for (const forjado of [{ concedidoPor: 1 }, { autorizadoPor: 1 }, { acaoCodigo: ACAO_ALTERNATIVA, origemId: 1 }]) {
        const resposta = await fetch(`${baseUrl}/autorizacoes-individuais`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: origem, Cookie: cookie },
          body: JSON.stringify({ tipo: 'DIRETA', usuarioId: ana, acaoCodigo: ACAO_ALTERNATIVA, ...forjado }),
        });
        assert.equal(resposta.status, 400, `${JSON.stringify(forjado)} deveria ser recusado`);
      }
    });
  });
});
