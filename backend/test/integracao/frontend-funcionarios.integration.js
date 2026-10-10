'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarFuncionarioController } = require('../../src/controllers/funcionario.controller');
const { criarFuncionarioRoutes } = require('../../src/routes/funcionario.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { corsApi } = require('../../src/middleware/cors');
const { semCache } = require('../../src/middleware/cabecalhos');
const { verificarOrigem } = require('../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../src/middleware/errorHandler');
const { gerarHashSenha } = require('../../src/security/password');
const { httpConfig } = require('../../src/config/http');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const declaracao = require('../../src/services/declaracao-lgpd');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiPortal = require('../../../frontend/js/portal-cliente');
const EpiFuncionarios = require('../../../frontend/js/funcionarios');

/**
 * Bloco 9, Etapa C, Parte C4 — ponta a ponta: o módulo real das páginas
 * (frontend/js/funcionarios.js) lê a planilha, monta os lotes e envia ao
 * servidor HTTP de verdade (cadeia /api de produção: CORS, origem, JSON de
 * 32 KB), com PostgreSQL real em schema temporário exclusivo com TODAS as
 * migrations (000–040). O `fetch` injetado é o navegador (Origin + jar de
 * cookies HttpOnly).
 */

// 041, 042 e 057: a FK composta da 073 referencia uq_funcionarios_empresa_id (057), que também exige estoque_lotes (042) e uq_materiais_empresa_id (041).
// Schema atual do sistema (inclui a 083, que a leitura de GHE projeta).
const TODAS_AS_MIGRATIONS = todasAsMigrations();
const SENHA = 'senha-forte-da-parte-c4-ponta-a-ponta';
const EMAILS = { master: 'master.c4e2e@exemplo-cliente.com.br', leitor: 'leitor.c4e2e@exemplo-cliente.com.br' };

function gerarCpf(n) {
  const base = String(100000000 + n).slice(-9).split('').map(Number);
  const dv = (d) => { const r = (d.reduce((s, x, i) => s + x * (d.length + 1 - i), 0) * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join('');
}

function criarNavegador(origem) {
  const jar = new Map();
  const fn = async (url, opcoes = {}) => {
    const cabecalhos = { ...(opcoes.headers || {}), Origin: origem };
    if (opcoes.credentials === 'include' && jar.size > 0) cabecalhos.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const resposta = await fetch(url, { ...opcoes, headers: cabecalhos });
    for (const bruto of resposta.headers.getSetCookie()) {
      const [par, ...atributos] = bruto.split(';');
      const i = par.indexOf('=');
      const nome = par.slice(0, i).trim();
      if (atributos.some((a) => /^\s*max-age=0\s*$/i.test(a))) jar.delete(nome); else jar.set(nome, par.slice(i + 1).trim());
    }
    return resposta;
  };
  return fn;
}

describe('C4 — importação e histórico pelo módulo real das páginas (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let servidor;
  let base;
  let origem;
  let empresaId;

  async function entrar(email) {
    EpiHttp.configurar({ baseUrl: `${base}/api`, fetch: criarNavegador(origem) });
    const login = await EpiPortal.acoes.entrar({ email, senha: SENHA, turnstileToken: TOKEN_TURNSTILE_TESTE });
    assert.equal(login.ok, true, JSON.stringify(login));
  }

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const hash = await gerarHashSenha(SENHA);
    empresaId = (await pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa C4 e2e', '11222333000181') RETURNING id")).rows[0].id;
    await provisionamento.provisionar(pool, { empresaId, dryRun: false });
    for (const [email, perfil] of [[EMAILS.master, 'MASTER'], [EMAILS.leitor, 'SUPERVISOR']]) {
      const id = (await pool.query('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hash])).rows[0].id;
      await pool.query('INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, $2, NULL, NULL, $3, $4)', [empresaId, perfil, perfil, id]);
    }
    await pool.query("INSERT INTO permissoes_recurso (empresa_id, perfil, recurso, pode_visualizar, pode_criar) VALUES ($1, 'SUPERVISOR', 'employeeHistory', true, false)", [empresaId]);
    // 12G-9: a coluna GHE da planilha traz o nome exato de um GHE da empresa.
    await pool.query("INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome) VALUES ($1, 'GHE e2e')", [empresaId]);

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessao = criarExigirSessao({ pool });
    const app = express();
    app.disable('x-powered-by');
    app.use(
      '/api',
      corsApi, semCache, verificarOrigem, exigirJson, parserJson,
      criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: criarExigirSessaoGlobal({ pool }), ...turnstileDeTeste() }),
      criarFuncionarioRoutes({ controller: criarFuncionarioController({ pool }), exigirSessao, pool }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    servidor = http.createServer(app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
    [origem] = httpConfig.cors.origens;
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (contexto) await contexto.encerrar();
  });

  test('a declaração da página é a mesma do servidor (versão e texto)', () => {
    assert.equal(EpiFuncionarios.DECLARACAO.versao, declaracao.VERSAO_ATUAL);
    assert.equal(EpiFuncionarios.DECLARACAO.texto, declaracao.textoDaVersao(declaracao.VERSAO_ATUAL));
  });

  test('CSV com 250 funcionários (acentos longos) e 2 linhas com erro: lotes dentro dos 32 KB reais, 250 cadastrados, erros não enviados, relatório sem CPF', async () => {
    await entrar(EMAILS.master);
    const linhas = ['Nome;Setor;Telefone;CPF;Matrícula;Nascimento;Contratação;Cargo;Situação;GHE'];
    for (let i = 0; i < 250; i += 1) {
      linhas.push(`Funcionária ${'Ç'.repeat(100)} ${i};Produção ${'Á'.repeat(60)};(47) 9999-${String(i).padStart(4, '0')};${gerarCpf(i + 1)};E2E-${i};15/03/1990;01/06/2020;Operação ${'É'.repeat(60)};Ativo;GHE e2e`);
    }
    linhas.push('Erro CPF;TI;;529.982.247-26;E2E-X1;;01/06/2020;Analista;Ativo;GHE e2e');
    linhas.push(`Repetido;TI;;${gerarCpf(1)};E2E-X2;;01/06/2020;Analista;Ativo;GHE e2e`);
    const bytes = new TextEncoder().encode(`﻿${linhas.join('\r\n')}\r\n`);
    const { texto } = EpiFuncionarios.arquivo.decodificarCsv(bytes);
    const interpretado = EpiFuncionarios.planilha.interpretar(EpiFuncionarios.arquivo.lerCsv(texto));
    assert.equal(interpretado.ok, true, JSON.stringify(interpretado).slice(0, 300));
    assert.deepEqual([interpretado.validas, interpretado.comErro], [250, 2]);

    const corpos = EpiFuncionarios.lotes.montar(interpretado.linhas, { importacaoId: '6f1c1b1e-8d5a-4c7e-9b2a-1d3e5f7a9c0b', arquivo: { nome: 'funcionarios.csv', formato: 'csv', totalLinhas: interpretado.linhas.length } });
    assert.ok(corpos.length > 3, `linhas longas: mais lotes que 250/100 (${corpos.length})`);
    for (const c of corpos) assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 32 * 1024, `lote ${c.lote.numero}`);

    const enviado = await EpiFuncionarios.fluxo.importar(corpos);
    assert.equal(enviado.interrupcao, null, JSON.stringify(enviado.interrupcao));
    const consolidado = EpiFuncionarios.fluxo.consolidar(interpretado.linhas, enviado);
    assert.deepEqual(consolidado.resumo, { total: 252, cadastrados: 250, jaCadastrados: 0, divergentes: 0, duplicados: 0, recusados: 2, erros: 0, naoConfirmados: 0, naoEnviados: 0, naoImportados: 2 });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1 AND grupo_homogeneo_id IS NOT NULL', [empresaId])).rows[0].n, 250, 'todos vinculados ao GHE pelo nome');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1', [empresaId])).rows[0].n, 250);
    assert.doesNotMatch(EpiFuncionarios.render.relatorio(consolidado), new RegExp(gerarCpf(1)));
    const lotesAuditados = (await pool.query("SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'FUNCIONARIOS_IMPORTACAO_LOTE'", [empresaId])).rows[0].n;
    assert.equal(lotesAuditados, corpos.length, 'um registro de declaração por lote');
  });

  test('reimportar um CPF já cadastrado com outros dados: nada em dobro — volta como já cadastrado com divergências (campo e valor atual) e nada é alterado', async () => {
    await entrar(EMAILS.master);
    const csv = `Nome;Setor;Telefone;CPF;Matrícula;Nascimento;Contratação;Cargo;Situação;GHE\r\nA;S;;${gerarCpf(1)};E2E-0;;01/06/2020;C;Ativo;GHE e2e\r\n`;
    const interpretado = EpiFuncionarios.planilha.interpretar(EpiFuncionarios.arquivo.lerCsv(csv));
    const corpos = EpiFuncionarios.lotes.montar(interpretado.linhas, { importacaoId: '6f1c1b1e-8d5a-4c7e-9b2a-1d3e5f7a9c0c', arquivo: { nome: 'a.csv', formato: 'csv', totalLinhas: 1 } });
    const r = await EpiFuncionarios.fluxo.importar(corpos);
    assert.deepEqual(r.linhas.map((l) => [l.situacao, l.codigo]), [['JA_CADASTRADO', 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE']]);
    assert.deepEqual(r.linhas[0].divergencias.map((d) => d.campo), ['nome', 'setor', 'funcao']);
    const consolidado = EpiFuncionarios.fluxo.consolidar(interpretado.linhas, r);
    assert.deepEqual(consolidado.linhas[0].divergencias.map((d) => [d.rotulo, d.planilha, d.oculto]), [['Nome', 'A', false], ['Setor', 'S', false], ['Cargo', 'C', false]]);
    assert.match(EpiFuncionarios.render.relatorio(consolidado), /Já cadastrado — dados divergentes/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1', [empresaId])).rows[0].n, 250);
    assert.equal((await pool.query("SELECT nome FROM funcionarios WHERE empresa_id = $1 AND matricula = 'E2E-0'", [empresaId])).rows[0].nome, `Funcionária ${'Ç'.repeat(100)} 0`, 'nada sobrescrito');
  });

  test('perfil só com visualizar: a importação é recusada (403) e a página mostra o motivo; o histórico funciona', async () => {
    await entrar(EMAILS.leitor);
    const csv = `Nome;Setor;Telefone;CPF;Matrícula;Nascimento;Contratação;Cargo;Situação;GHE\r\nB;S;;${gerarCpf(900)};E2E-L;;01/06/2020;C;Ativo;GHE e2e\r\n`;
    const interpretado = EpiFuncionarios.planilha.interpretar(EpiFuncionarios.arquivo.lerCsv(csv));
    const corpos = EpiFuncionarios.lotes.montar(interpretado.linhas, { importacaoId: '6f1c1b1e-8d5a-4c7e-9b2a-1d3e5f7a9c0d', arquivo: { nome: 'b.csv', formato: 'csv', totalLinhas: 1 } });
    const r = await EpiFuncionarios.fluxo.importar(corpos);
    assert.deepEqual([r.linhas[0].situacao, r.interrupcao.status], ['RECUSADO', 403]);
    assert.match(r.linhas[0].motivo, /permissão/);
    const busca = await EpiFuncionarios.acoes.listar({ busca: 'E2E-10' });
    assert.equal(busca.ok, true);
    assert.ok(busca.dados.funcionarios.some((f) => f.matricula === 'E2E-10'));
  });

  test('histórico: CPF completo por igualdade exata; CPF parcial nem chega ao servidor; datas AAAA-MM-DD', async () => {
    await entrar(EMAILS.master);
    const consulta = EpiFuncionarios.historico.consulta('cpf', gerarCpf(5));
    const r = await EpiFuncionarios.acoes.listar(consulta.filtro);
    assert.deepEqual(r.dados.funcionarios.map((f) => [f.matricula, f.dataAdmissao, f.dataNascimento]), [['E2E-4', '2020-06-01', '1990-03-15']]);
    assert.equal(EpiFuncionarios.historico.consulta('cpf', gerarCpf(5).slice(0, 8)).ok, false);
  });
});
