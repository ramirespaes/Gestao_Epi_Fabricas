'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const { criarEmpresaDadosRoutes } = require('../../src/routes/empresa-dados.routes');
const { criarEmpresaDadosController } = require('../../src/controllers/empresa-dados.controller');
const { criarEmpresaCadastroRoutes } = require('../../src/routes/empresa-cadastro.routes');
const { criarEmpresaCadastroController } = require('../../src/controllers/empresa-cadastro.controller');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * Dados da Empresa (F1) — HTTP real contra PostgreSQL real (schema temporário, todas as migrations): autenticação, RBAC (MASTER,
 * ADMINISTRADOR com toggles), proteção de Razão Social/CNPJ, isolamento A×B, persistência, concorrência, 409, auditoria e
 * compatibilidade com o Painel Restrito (montado aqui em /api/empresas, mesmo código das rotas /api/plataforma/empresas).
 */
const DADOS = '/api/empresa/dados';
const ACESSOS = '/api/administracao/usuarios';

describe('Dados da Empresa — HTTP + RBAC + Painel (PostgreSQL real)', () => {
  let g;
  let masterA;
  let masterB;
  let cookieAdminPlataforma;

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
      return [
        // Limites folgados: a suíte faz dezenas de PATCH com o mesmo usuário. O comportamento dos limites tem teste próprio abaixo.
        criarEmpresaDadosRoutes({ controller: criarEmpresaDadosController({ pool }), exigirSessao: exigirEmpresarial, pool, limites: { porUsuario: 100000, porEmpresa: 100000 } }),
        criarEmpresaCadastroRoutes({ controller: criarEmpresaCadastroController({ pool }), exigirSessaoPlataforma }),
      ];
    } });
    masterA = await g.contaDaEmpresa(g.empresas.A);
    masterB = await g.contaDaEmpresa(g.empresas.B);
    for (const empresaId of [g.empresas.A, g.empresas.B]) await provisionamento.provisionar(g.pool, { empresaId, dryRun: false });
    const admin = await criarInicial(g.pool, { email: 'admin.f1@safework.com.br', senha: 'planeta-nebulosa-ozonio-42' });
    ({ cookie: cookieAdminPlataforma } = await criarSessaoAdministrativa(g.pool, admin.id));
  });
  after(async () => { if (g) await g.encerrar(); });

  const get = (cookie) => g.request(g.app).get(DADOS).set('Cookie', cookie);
  const patch = (cookie, corpo) => g.request(g.app).patch(DADOS).set('Cookie', cookie).send(corpo);
  const linha = (id) => g.um('SELECT * FROM empresas WHERE id = $1', [id]);
  const painelPatch = (id, corpo) => g.request(g.app).patch(`/api/empresas/${id}`).set('Cookie', cookieAdminPlataforma).send(corpo);
  const painelGet = (id) => g.request(g.app).get(`/api/empresas/${id}`).set('Cookie', cookieAdminPlataforma);
  const acesso = (c, id, toggle, ligado) => g.request(g.app).put(`${ACESSOS}/${id}/acessos/${toggle}`).set('Cookie', g.cookie(c)).send({ ligado });
  const cookieDe = async (u) => g.deCookies(g.cookiesDe(await g.login(u.email, g.SENHA_PROVISORIA)));
  const auditorias = (empresaId) => g.todos("SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'EMPRESA_DADOS_ALTERADOS' ORDER BY id", [empresaId]);
  async function administrador(toggles) {
    const u = await g.usuarioPronto(masterA, { tipoConta: 'ADMINISTRADOR' });
    for (const [toggle, ligado] of toggles) {
      const r = await acesso(masterA, u.id, toggle, ligado);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    return { ...u, cookie: await cookieDe(u) };
  }

  test('401: sem sessão, GET e PATCH são recusados', async () => {
    assert.equal((await g.request(g.app).get(DADOS)).status, 401);
    assert.equal((await g.request(g.app).patch(DADOS).send({ versao: 1, telefone: '1' })).status, 401);
  });

  test('401: o cookie da plataforma não autentica o Portal', async () => {
    assert.equal((await g.request(g.app).get(DADOS).set('Cookie', cookieAdminPlataforma)).status, 401);
  });

  test('MASTER: consulta com versão e campos bloqueados; razão social e CNPJ da própria empresa', async () => {
    const r = await get(g.cookie(masterA));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.dados.razaoSocial, 'Empresa Alfa');
    assert.equal(r.body.dados.cnpj, '11222333000181');
    assert.equal(r.body.dados.versao, 1);
    assert.deepEqual(r.body.dados.camposBloqueados, ['razaoSocial', 'cnpj']);
    for (const chave of ['ativo', 'id']) assert.equal(Object.hasOwn(r.body.dados, chave), false);
  });

  test('MASTER: edita, a versão avança, persiste (nova leitura e novo login) e a auditoria guarda só nomes e versões', async () => {
    const r = await patch(g.cookie(masterA), { versao: 1, telefone: '(11) 4000-1000', emailSst: 'SST@Alfa.com.br', emailAlmoxarifado: 'almox@alfa.com.br', uf: 'rj', cep: '20000-000' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.alterado, true);
    assert.deepEqual([...r.body.camposAlterados].sort(), ['cep', 'emailAlmoxarifado', 'emailSst', 'telefone', 'uf']);
    assert.equal(r.body.dados.versao, 2);
    const nova = g.cookie(await g.contaDaEmpresa(g.empresas.A));
    const lida = await get(nova);
    assert.equal(lida.body.dados.emailSst, 'sst@alfa.com.br');
    assert.equal(lida.body.dados.uf, 'RJ');
    assert.equal(lida.body.dados.cep, '20000000');
    assert.equal(lida.body.dados.telefone, '(11) 4000-1000');
    assert.equal((await linha(g.empresas.A)).versao, 2);

    const logs = await auditorias(g.empresas.A);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].usuario_id, masterA.usuarioId);
    assert.equal(logs[0].referencia, String(g.empresas.A));
    assert.deepEqual(logs[0].contexto.versaoAnterior, 1);
    assert.deepEqual(logs[0].contexto.versaoNova, 2);
    const bruto = JSON.stringify(logs[0]);
    for (const valor of ['4000-1000', 'alfa.com.br', '20000']) assert.equal(bruto.includes(valor), false, `valor ${valor} não pode ir à auditoria`);
  });

  test('null limpa um campo; PATCH sem mudança real é 200 alterado=false, sem versão nova e sem auditoria', async () => {
    const antes = (await auditorias(g.empresas.A)).length;
    const versao = (await linha(g.empresas.A)).versao;
    const igual = await patch(g.cookie(masterA), { versao, telefone: '(11) 4000-1000' });
    assert.equal(igual.status, 200);
    assert.equal(igual.body.alterado, false);
    assert.equal((await linha(g.empresas.A)).versao, versao);
    assert.equal((await auditorias(g.empresas.A)).length, antes);

    const limpa = await patch(g.cookie(masterA), { versao, emailAlmoxarifado: null });
    assert.equal(limpa.status, 200);
    assert.equal((await linha(g.empresas.A)).email_almoxarifado, null);
    assert.equal((await linha(g.empresas.A)).versao, versao + 1);
  });

  test('Razão Social e CNPJ: 400 por qualquer campo, linha idêntica e versão intacta (inclusive com MASTER)', async () => {
    const antes = await linha(g.empresas.A);
    for (const chave of ['razaoSocial', 'cnpj', 'nome']) {
      const r = await patch(g.cookie(masterA), { versao: antes.versao, [chave]: chave === 'cnpj' ? '11444777000161' : 'Outro Nome Ltda' });
      assert.equal(r.status, 400, chave);
    }
    const r = await patch(g.cookie(masterA), { versao: antes.versao, telefone: '1', razaoSocial: 'X' });
    assert.equal(r.status, 400, 'mistura de campo válido com proibido também é recusada inteira');
    const depois = await linha(g.empresas.A);
    assert.deepEqual({ ...depois, atualizado_em: null }, { ...antes, atualizado_em: null });
  });

  test('empresaId, usuarioId, ativo e versão inválida no corpo: 400, nada gravado', async () => {
    const antes = await linha(g.empresas.A);
    const base = { versao: antes.versao, telefone: '1199' };
    for (const extra of [{ empresaId: g.empresas.B }, { empresa_id: g.empresas.B }, { usuarioId: 1 }, { ativo: false }, { versao: 'x' }]) {
      assert.equal((await patch(g.cookie(masterA), { ...base, ...extra })).status, 400, JSON.stringify(extra));
    }
    assert.equal((await patch(g.cookie(masterA), { telefone: '1' })).status, 400, 'versão obrigatória');
    assert.equal((await patch(g.cookie(masterA), { versao: antes.versao })).status, 400, 'sem campo nenhum');
    assert.equal((await linha(g.empresas.A)).versao, antes.versao);
  });

  test('validação: e-mail inválido e IE CONTRIBUINTE sem número são 400 e não gravam', async () => {
    const antes = await linha(g.empresas.A);
    assert.equal((await patch(g.cookie(masterA), { versao: antes.versao, emailSst: 'nao-e-email' })).status, 400);
    const ie = await patch(g.cookie(masterA), { versao: antes.versao, situacaoInscricaoEstadual: 'CONTRIBUINTE' });
    assert.equal(ie.status, 400);
    assert.equal(ie.body.codigo, 'EMPRESA_IE_EXIGIDA');
    assert.equal((await linha(g.empresas.A)).versao, antes.versao);
  });

  test('isolamento A×B: o MASTER de A altera só A; o de B só enxerga B; ids no corpo não redirecionam', async () => {
    const b0 = await linha(g.empresas.B);
    const versaoA = (await linha(g.empresas.A)).versao;
    assert.equal((await patch(g.cookie(masterA), { versao: versaoA, bairro: 'Só da A' })).status, 200);
    assert.deepEqual({ ...(await linha(g.empresas.B)), atualizado_em: null }, { ...b0, atualizado_em: null });
    const lidaB = await get(g.cookie(masterB));
    assert.equal(lidaB.body.dados.razaoSocial, 'Empresa Beta');
    assert.equal(lidaB.body.dados.bairro, null);
    assert.equal((await patch(g.cookie(masterB), { versao: versaoA, bairro: 'Só da B' })).status, versaoA === b0.versao ? 200 : 409);
    assert.equal((await linha(g.empresas.A)).bairro, 'Só da A');
  });

  test('versão antiga é 409 sem alterar nada nem auditar; relendo e reenviando funciona', async () => {
    const atual = (await linha(g.empresas.A)).versao;
    const logs = (await auditorias(g.empresas.A)).length;
    const r = await patch(g.cookie(masterA), { versao: atual - 1, cidade: 'Outra' });
    assert.equal(r.status, 409);
    assert.equal(r.body.codigo, 'EMPRESA_DADOS_DESATUALIZADOS');
    assert.equal(r.body.dados, undefined, 'o 409 não devolve dados');
    assert.notEqual((await linha(g.empresas.A)).cidade, 'Outra');
    assert.equal((await auditorias(g.empresas.A)).length, logs);
    const lida = await get(g.cookie(masterA));
    assert.equal((await patch(g.cookie(masterA), { versao: lida.body.dados.versao, cidade: 'Outra' })).status, 200);
  });

  test('dois PATCH simultâneos com a mesma versão: exatamente um vence, o outro é 409; a versão sobe uma vez', async () => {
    const atual = (await linha(g.empresas.A)).versao;
    const [r1, r2] = await Promise.all([
      patch(g.cookie(masterA), { versao: atual, complemento: 'corrida-1' }),
      patch(g.cookie(masterA), { versao: atual, complemento: 'corrida-2' }),
    ]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    const final = await linha(g.empresas.A);
    assert.equal(final.versao, atual + 1);
    assert.equal(final.complemento, r1.status === 200 ? 'corrida-1' : 'corrida-2');
  });

  test('ADMINISTRADOR sem nenhum toggle: 403 na leitura e na escrita; nada é gravado', async () => {
    const u = await administrador([]);
    const antes = await linha(g.empresas.A);
    assert.equal((await get(u.cookie)).status, 403);
    assert.equal((await patch(u.cookie, { versao: antes.versao, telefone: '1' })).status, 403);
    assert.equal((await linha(g.empresas.A)).versao, antes.versao);
  });

  test('ADMINISTRADOR com Visualizar ON e Editar OFF: lê, mas o PATCH é 403', async () => {
    const u = await administrador([['dadosEmpresaVisualizar', true]]);
    assert.equal((await get(u.cookie)).status, 200);
    const antes = await linha(g.empresas.A);
    assert.equal((await patch(u.cookie, { versao: antes.versao, telefone: '1' })).status, 403);
    assert.equal((await linha(g.empresas.A)).versao, antes.versao);
  });

  test('ADMINISTRADOR com os dois ON: lê e edita; a auditoria registra o ator; Razão Social segue bloqueada', async () => {
    const u = await administrador([['dadosEmpresaEditar', true]]);
    const lida = await get(u.cookie);
    assert.equal(lida.status, 200, 'ligar Editar também concede a leitura (dependência do catálogo)');
    const r = await patch(u.cookie, { versao: lida.body.dados.versao, representanteNome: 'Quem Edita' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const logs = await auditorias(g.empresas.A);
    assert.equal(logs.at(-1).usuario_id, u.id);
    assert.equal((await patch(u.cookie, { versao: r.body.dados.versao, razaoSocial: 'Nope' })).status, 400);
    assert.equal((await patch(u.cookie, { versao: r.body.dados.versao, cnpj: '11444777000161' })).status, 400);
  });

  test('ADMINISTRADOR com Visualizar OFF e Editar ON: 403 na leitura E no PATCH (Editar não basta)', async () => {
    const u = await administrador([['dadosEmpresaEditar', true], ['dadosEmpresaVisualizar', false]]);
    const antes = await linha(g.empresas.A);
    assert.equal((await get(u.cookie)).status, 403);
    assert.equal((await patch(u.cookie, { versao: antes.versao, telefone: '999' })).status, 403);
    assert.equal((await linha(g.empresas.A)).versao, antes.versao);
  });

  test('desligar Editar depois de ligado volta o PATCH a 403 na próxima requisição', async () => {
    const u = await administrador([['dadosEmpresaEditar', true]]);
    const v = (await get(u.cookie)).body.dados.versao;
    assert.equal((await patch(u.cookie, { versao: v, bairro: 'Antes' })).status, 200);
    assert.equal((await acesso(masterA, u.id, 'dadosEmpresaEditar', false)).status, 200);
    assert.equal((await patch(u.cookie, { versao: v + 1, bairro: 'Depois' })).status, 403);
    assert.equal((await get(u.cookie)).status, 200);
  });

  test('ADMINISTRADOR de outra empresa com toggles não alcança a empresa A', async () => {
    const uB = await g.usuarioPronto(masterB, { tipoConta: 'ADMINISTRADOR' });
    for (const t of ['dadosEmpresaEditar']) assert.equal((await g.request(g.app).put(`${ACESSOS}/${uB.id}/acessos/${t}`).set('Cookie', g.cookie(masterB)).send({ ligado: true })).status, 200);
    const cookie = await cookieDe(uB);
    const lida = await get(cookie);
    assert.equal(lida.status, 200);
    assert.equal(lida.body.dados.razaoSocial, 'Empresa Beta');
  });

  test('Painel ↔ Portal: o Painel enxerga o que o Portal gravou (e a versão) e o Portal enxerga o que o Painel gravou com a versão lida', async () => {
    const v0 = (await linha(g.empresas.A)).versao;
    const doPortal = await patch(g.cookie(masterA), { versao: v0, email: 'portal@alfa.com.br' });
    assert.equal(doPortal.status, 200);
    const visto = await painelGet(g.empresas.A);
    assert.equal(visto.body.empresa.email, 'portal@alfa.com.br');
    assert.equal(visto.body.empresa.versao, v0 + 1);

    const comVersao = await painelPatch(g.empresas.A, { versao: visto.body.empresa.versao, telefone: '(54) 3333-0000' });
    assert.equal(comVersao.status, 200, JSON.stringify(comVersao.body));
    assert.equal(comVersao.body.empresa.versao, v0 + 2);
    assert.equal((await get(g.cookie(masterA))).body.dados.telefone, '(54) 3333-0000');
  });

  test('Painel SEM `versao` é recusado (400, body.versao obrigatória) e NADA é gravado, auditado nem versionado — não há mais sobrescrita silenciosa', async () => {
    const SQL_TRILHA = "SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao = 'EMPRESA_ALTERADA' AND empresa_afetada_id = $1";
    const antes = await linha(g.empresas.A);
    const trilhaAntes = (await g.um(SQL_TRILHA, [g.empresas.A])).n;
    const semVersao = await painelPatch(g.empresas.A, { telefone: '(54) 0000-SEM-VERSAO', cidade: 'Sem Versao Nao Grava' });
    assert.equal(semVersao.status, 400, JSON.stringify(semVersao.body));
    assert.equal(semVersao.body.codigo, 'VALIDACAO');
    assert.ok(semVersao.body.detalhes.some((d) => d.campo === 'body.versao' && d.codigo === 'CAMPO_OBRIGATORIO'), JSON.stringify(semVersao.body.detalhes));
    assert.deepEqual(await linha(g.empresas.A), antes, 'a linha não pode ter mudado (nem a versão)');
    assert.equal((await g.um(SQL_TRILHA, [g.empresas.A])).n, trilhaAntes);
    // Variações: versão nula, texto, zero e negativa também são recusadas sem escrever.
    for (const versao of [null, '1', 0, -1]) {
      const r = await painelPatch(g.empresas.A, { versao, telefone: '(54) 0000-INVALIDA' });
      assert.equal(r.status, 400, `versao=${JSON.stringify(versao)}`);
    }
    assert.deepEqual(await linha(g.empresas.A), antes);
  });

  test('Painel com `versao`: antiga é 409 (sem alterar), correta grava; o Portal com a versão que carregou antes é 409', async () => {
    const lidaPortal = await get(g.cookie(masterA));
    const vPortal = lidaPortal.body.dados.versao;
    const antigo = await painelPatch(g.empresas.A, { versao: vPortal - 1, cidade: 'Painel Antigo' });
    assert.equal(antigo.status, 409);
    assert.equal(antigo.body.codigo, 'EMPRESA_DADOS_DESATUALIZADOS');
    assert.notEqual((await linha(g.empresas.A)).cidade, 'Painel Antigo');
    const certo = await painelPatch(g.empresas.A, { versao: vPortal, cidade: 'Painel Certo' });
    assert.equal(certo.status, 200, JSON.stringify(certo.body));
    const portalAntigo = await patch(g.cookie(masterA), { versao: vPortal, cidade: 'Portal Velho' });
    assert.equal(portalAntigo.status, 409, 'o Portal que carregou antes do Painel não sobrescreve');
    assert.equal((await linha(g.empresas.A)).cidade, 'Painel Certo');
  });

  test('Painel: razão social segue editável por ele e CNPJ segue imutável; a trilha da plataforma continua gravando', async () => {
    const vB = (await linha(g.empresas.B)).versao;
    const r = await painelPatch(g.empresas.B, { versao: vB, razaoSocial: 'Empresa Beta Renomeada Ltda' });
    assert.equal(r.status, 200);
    assert.equal((await get(g.cookie(masterB))).body.dados.razaoSocial, 'Empresa Beta Renomeada Ltda');
    assert.equal((await painelPatch(g.empresas.B, { versao: vB + 1, cnpj: '11222333000181' })).status, 400);
    const trilha = await g.um("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE acao = 'EMPRESA_ALTERADA' AND empresa_afetada_id = $1", [g.empresas.B]);
    assert.ok(trilha.n >= 1);
  });

  test('Painel não expõe nem aceita os e-mails de SST/Almoxarifado (sem campo novo na UI do Painel)', async () => {
    const r = await painelPatch(g.empresas.A, { versao: (await linha(g.empresas.A)).versao, emailSst: 'x@y.com' });
    assert.equal(r.status, 400);
    assert.ok(r.body.detalhes.some((d) => d.campo === 'body.emailSst' && d.codigo === 'CAMPO_NAO_PERMITIDO'), 'recusado por campo não permitido (não por falta de versão)');
  });

  test('limite do PATCH por usuário: acima do teto é 429, só conta quem já foi autorizado e a leitura não é limitada', async () => {
    const { criarAppTeste } = require('../helpers/app-teste');
    const { criarExigirSessao } = require('../../src/middleware/autenticacao');
    const apertado = criarAppTeste((a) => {
      a.set('trust proxy', 1);
      a.use('/api', criarEmpresaDadosRoutes({
        controller: criarEmpresaDadosController({ pool: g.pool }), exigirSessao: criarExigirSessao({ pool: g.pool }), pool: g.pool, limites: { porUsuario: 2, porEmpresa: 100 },
      }));
    });
    const v = (await linha(g.empresas.A)).versao;
    const enviar = () => g.request(apertado).patch(DADOS).set('Cookie', g.cookie(masterA)).send({ versao: v, telefone: '(54) 3333-0000' });
    assert.equal((await g.request(apertado).patch(DADOS).send({ versao: v, telefone: '1' })).status, 401, 'sem sessão não consome o limite');
    const statuses = [(await enviar()).status, (await enviar()).status, (await enviar()).status];
    assert.notEqual(statuses[0], 429);
    assert.notEqual(statuses[1], 429);
    assert.equal(statuses[2], 429);
    for (let i = 0; i < 5; i += 1) assert.equal((await g.request(apertado).get(DADOS).set('Cookie', g.cookie(masterA))).status, 200);
  });

  test('o MASTER provisionado tem exatamente companyData visualizar+editar (sem criar/excluir)', async () => {
    const l = await g.um("SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir FROM permissoes_recurso WHERE empresa_id = $1 AND perfil = 'MASTER' AND recurso = 'companyData'", [g.empresas.A]);
    assert.deepEqual(l, { pode_visualizar: true, pode_criar: false, pode_editar: true, pode_excluir: false });
  });
});
