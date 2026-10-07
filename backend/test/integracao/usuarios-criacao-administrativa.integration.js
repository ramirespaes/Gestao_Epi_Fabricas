'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarEmpresa } = require('./helpers/entrega-epi');
const { todasAsMigrations } = require('./helpers/recuperacao-senha');
const { fabricaPortal } = require('./helpers/troca-senha');
const { turnstileDeTeste, TOKEN_TURNSTILE_TESTE } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { cpfFicticio, comMascara } = require('../helpers/cpf-ficticio');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarUsuarioAdministracaoRoutes } = require('../../src/routes/usuario-administracao.routes');
const { criarUsuarioAdministracaoController } = require('../../src/controllers/usuario-administracao.controller');
const { criarContaRoutes } = require('../../src/routes/conta.routes');
const { criarContaController } = require('../../src/controllers/conta.controller');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const usuarioIpRepo = require('../../src/repositories/usuario-ip.repository');
const password = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Gestão de Usuários → Novo → Usuário ADMINISTRATIVO (decisão de 05/10/2026):
 * POST /administracao/usuarios estendido com CPF (identidade; único, imutável),
 * matrícula (única na empresa), setor, horário informativo, IPs permitidos
 * (aplicados no servidor pelo endereço que ele resolve) e grupo de acesso, em
 * uma transação só. PostgreSQL real, schema temporário com todas as
 * migrations (075–077 inclusive). O app confia em UM salto de proxy
 * (TRUST_PROXY_HOPS = 1), como atrás do balanceador/CDN: X-Forwarded-For é
 * o endereço remoto resolvido, nunca um cabeçalho lido pela aplicação.
 */

const ROTA = '/api/administracao/usuarios';
const LOGIN = '/api/auth/global/login';
const ME_GLOBAL = '/api/auth/global/me';
const ME = '/api/auth/me';
const CONTA = '/api/auth/global/conta';
const selecionarRota = (empresaId) => `/api/auth/global/empresas/${empresaId}/selecionar`;
const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA } = authConfig.sessao;

const SENHA_PROVISORIA = 'cometa-lanterna-ardosia-77';
const IP_A = '203.0.113.10';
const IP_B = '198.51.100.7';
const IP6 = '2001:db8::10';
const IP6_EXTENSO = '2001:0DB8:0000:0000:0000:0000:0000:0010';
// Projeção da listagem (05/10/2026): dados administrativos reais, CPF só mascarado, nunca a lista de IPs.
const CAMPOS_DO_USUARIO = ['acessoQualquerIp', 'ativo', 'cpfMascarado', 'criadoEm', 'email', 'grupo', 'horarioTrabalho', 'id', 'matricula', 'nome', 'perfil', 'perfilFixo', 'podeGerenciar', 'proprio', 'setor'];
const NAO_PERMITIDO = { status: 'error', codigo: 'ACESSO_IP_NAO_PERMITIDO', message: 'Acesso não permitido a partir deste endereço' };

describe('Gestão de Usuários — Novo → Usuário administrativo (PostgreSQL real, proxy de um salto)', () => {
  let contexto;
  let pool;
  let app;
  let hashAtual;
  let portal;
  const empresas = {};
  const grupos = {};
  const masters = {};
  let sequencia = 0;

  const um = async (sql, p) => (await pool.query(sql, p)).rows[0];
  const todos = async (sql, p) => (await pool.query(sql, p)).rows;
  const cookie = (c) => [`${NOME_GLOBAL}=${c.global.token}`, ...(c.empresarial ? [`${NOME_EMPRESA}=${c.empresarial.token}`] : [])].join('; ');
  const cookiesDe = (r) => Object.fromEntries((r.headers['set-cookie'] ?? []).map((c) => c.split(';')[0].split('=')));
  const deCookies = (jar) => Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  const deIp = (req, ip) => (ip ? req.set('X-Forwarded-For', ip) : req);
  const criar = (c, corpo, ip) => deIp(request(app).post(ROTA).set('Cookie', cookie(c)).set('User-Agent', 'Agente de Teste'), ip).send(corpo);
  const login = (email, senha, ip) => deIp(request(app).post(LOGIN).set('User-Agent', 'Agente de Teste'), ip).send({ email, senha, turnstileToken: TOKEN_TURNSTILE_TESTE });
  const comJar = (metodo, rota, jar, ip) => deIp(request(app)[metodo](rota).set('Cookie', deCookies(jar)), ip);
  const contagens = async () => [
    (await um('SELECT count(*)::int AS n FROM identidades')).n,
    (await um('SELECT count(*)::int AS n FROM usuarios')).n,
    (await um('SELECT count(*)::int AS n FROM usuario_ips_permitidos')).n,
  ];
  const linhaUsuario = (id) => um(
    `SELECT empresa_id, perfil, ativo, matricula, setor, horario_trabalho_inicio::text AS inicio, horario_trabalho_fim::text AS fim, grupo_acesso_id, identidade_id
       FROM usuarios WHERE id = $1`,
    [id],
  );
  const cpfDe = async (identidadeId) => (await um('SELECT cpf FROM identidades WHERE id = $1', [identidadeId])).cpf;
  // Ordem textual, não a do INET (que põe o IPv6 antes do IPv4): só o conjunto importa.
  const ipsDe = async (empresaId, usuarioId) => (await todos('SELECT host(ip) AS ip FROM usuario_ips_permitidos WHERE empresa_id = $1 AND usuario_id = $2', [empresaId, usuarioId])).map((l) => l.ip).sort();
  const IPS_A_E_6 = [IP_A, IP6].sort();
  const auditoriaDe = (empresaId, usuarioId) => um("SELECT dados_novos FROM logs_auditoria WHERE empresa_id = $1 AND acao = 'USUARIO_CRIADO' AND referencia = $2", [empresaId, String(usuarioId)]);
  /** Fixture: encerra a senha provisória direto no banco; o ciclo da troca é provado em usuarios-criacao-direta. */
  const senhaDefinitiva = (identidadeId) => pool.query('UPDATE identidades SET senha_provisoria = false, senha_provisoria_definida_em = NULL, senha_provisoria_expira_em = NULL WHERE id = $1', [identidadeId]);

  function corpoBase(extra = {}) {
    sequencia += 1;
    return {
      nome: `Pessoa Administrativa ${sequencia}`, email: `pessoa.adm.${sequencia}@example.invalid`, tipoConta: 'USUARIO', senhaProvisoria: SENHA_PROVISORIA,
      cpf: cpfFicticio(1000 + sequencia), matricula: `ADM-${sequencia}`, setor: 'Administrativo', ...extra,
    };
  }

  async function contaDaEmpresa(empresaId, perfil = 'MASTER') {
    const identidade = await portal.novaIdentidade();
    const usuarioId = await portal.vincular(identidade, empresaId, perfil);
    const global = await portal.entrar(identidade);
    const empresarial = await portal.selecionar(identidade, global, empresaId);
    return { identidade, usuarioId, empresaId, global, empresarial };
  }
  async function administradorAutorizado(empresaId, master) {
    const c = await contaDaEmpresa(empresaId, 'ADMINISTRADOR');
    await pool.query("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'GERENCIAR_USUARIOS', $3)", [empresaId, c.usuarioId, master.usuarioId]);
    return c;
  }
  /** Cria pelo POST, encerra a provisória e devolve o que o login precisa. */
  async function usuarioPronto(master, extra = {}) {
    const corpo = corpoBase(extra);
    const r = await criar(master, corpo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { identidade_id: identidadeId } = await linhaUsuario(r.body.usuario.id);
    await senhaDefinitiva(identidadeId);
    return { corpo, usuarioId: r.body.usuario.id, identidadeId, email: corpo.email };
  }

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha('planeta-nebulosa-ozonio-42');
    portal = fabricaPortal({ pool, hashSenha: hashAtual });
    empresas.A = await criarEmpresa(pool, '11222333000181', 'Empresa Alfa');
    empresas.B = await criarEmpresa(pool, '11444777000161', 'Empresa Beta');
    masters.A = await contaDaEmpresa(empresas.A);
    masters.B = await contaDaEmpresa(empresas.B);
    for (const [chave, empresaId, nome, ativo, master] of [
      ['A', empresas.A, 'Recursos Humanos', true, masters.A], ['AInativo', empresas.A, 'Antigo', false, masters.A], ['B', empresas.B, 'RH de B', true, masters.B],
    ]) {
      grupos[chave] = (await um('INSERT INTO grupos_acesso (empresa_id, nome, ativo, criado_por) VALUES ($1, $2, $3, $4) RETURNING id', [empresaId, nome, ativo, master.usuarioId])).id;
    }

    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirGlobal = criarExigirSessaoGlobal({ pool });
    const exigirEmpresarial = criarExigirSessao({ pool });
    app = criarAppTeste((a) => {
      a.set('trust proxy', 1);
      a.use(
        '/api',
        criarAuthGlobalRoutes({
          controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal: exigirGlobal, exigirSessaoGlobalMe: exigirGlobal, ...turnstileDeTeste(),
        }),
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao: exigirEmpresarial }),
        criarUsuarioAdministracaoRoutes({ controller: criarUsuarioAdministracaoController({ pool }), exigirSessao: exigirEmpresarial }),
        criarContaRoutes({ controller: criarContaController({ pool }), limitadorEmail: semLimite(), exigirSessaoGlobal: exigirGlobal }),
      );
    });
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('caminho completo: CPF (com máscara), matrícula, setor, horário, IPs IPv4/IPv6 (canônicos, sem repetição) e grupo numa transação só; resposta e auditoria sem CPF em claro, sem IP e sem senha', async () => {
    const corpo = corpoBase({ cpf: comMascara(cpfFicticio(777)), matricula: ' ADM-777 ', setor: 'Recursos Humanos', horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: [IP_A, IP6_EXTENSO, IP6, `::ffff:${IP_A}`], grupoAcessoId: grupos.A });
    const antes = await contagens();
    const r = await criar(masters.A, corpo);

    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(Object.keys(r.body.usuario).sort(), CAMPOS_DO_USUARIO, 'o usuário da resposta é o mesmo da listagem: sem CPF');
    assert.deepEqual([r.body.usuario.nome, r.body.usuario.perfil, r.body.usuario.ativo, r.body.usuario.grupo], [corpo.nome, 'USUARIO', true, { nome: 'Recursos Humanos', ativo: true }]);
    assert.deepEqual(r.body.administrativo, {
      cpfMascarado: '***.***.***-' + cpfFicticio(777).slice(9), matricula: 'ADM-777', setor: 'Recursos Humanos', horarioTrabalho: { inicio: '08:00', fim: '18:00' }, ipsPermitidos: [IP_A, IP6], grupoAcessoId: grupos.A, vinculoSst: false,
    });
    const texto = JSON.stringify(r.body) + JSON.stringify(r.headers);
    assert.equal(texto.includes(cpfFicticio(777)), false, 'o CPF nunca volta em claro');
    assert.equal(/senha_hash|senhaHash|\$argon2|cometa-lanterna/.test(texto), false);

    const u = await linhaUsuario(r.body.usuario.id);
    assert.deepEqual(u, { empresa_id: empresas.A, perfil: 'USUARIO', ativo: true, matricula: 'ADM-777', setor: 'Recursos Humanos', inicio: '08:00:00', fim: '18:00:00', grupo_acesso_id: grupos.A, identidade_id: u.identidade_id });
    assert.equal(await cpfDe(u.identidade_id), cpfFicticio(777), 'CPF canônico na identidade');
    assert.deepEqual(await ipsDe(empresas.A, r.body.usuario.id), IPS_A_E_6, 'o mesmo IPv6 escrito de três formas é um só; o IPv4 mapeado é o IPv4');
    assert.deepEqual(await contagens(), [antes[0] + 1, antes[1] + 1, antes[2] + 2]);

    const { dados_novos: auditoria } = await auditoriaDe(empresas.A, r.body.usuario.id);
    assert.deepEqual([auditoria.temCpf, auditoria.matricula, auditoria.setor, auditoria.horarioTrabalho, auditoria.grupoAcessoId, auditoria.ipsPermitidos, auditoria.origem], [true, 'ADM-777', 'Recursos Humanos', true, grupos.A, 2, 'CRIACAO_DIRETA']);
    const textoAuditoria = JSON.stringify(auditoria);
    assert.equal(textoAuditoria.includes(cpfFicticio(777)) || textoAuditoria.includes('203.0.113') || textoAuditoria.includes('2001:db8'), false, 'auditoria sem CPF e sem IP');
    assert.equal(textoAuditoria.toLowerCase().includes('senha'), false);

    const lista = await request(app).get(`${ROTA}?limite=100`).set('Cookie', cookie(masters.A));
    const item = lista.body.usuarios.find((x) => x.id === r.body.usuario.id);
    assert.deepEqual(Object.keys(item).sort(), CAMPOS_DO_USUARIO, 'a listagem traz os dados administrativos, sem CPF em claro');
    assert.deepEqual(item.grupo, { nome: 'Recursos Humanos', ativo: true });
  });

  test('listagem e detalhe projetam os dados administrativos reais: CPF só mascarado, matrícula, setor, horário (ou null) e "acesso de qualquer IP" derivado (sem IP = true, com IP = false); nunca a lista de IPs nem o CPF em claro', async () => {
    const comTudo = await criar(masters.A, corpoBase({ cpf: cpfFicticio(4242), setor: 'Segurança do Trabalho', horarioTrabalho: { inicio: '07:30', fim: '17:00' }, ipsPermitidos: [IP_A, IP6] }));
    const semOpcionais = await criar(masters.A, corpoBase({ cpf: cpfFicticio(4243), setor: 'Compras' }));
    assert.deepEqual([comTudo.status, semOpcionais.status], [201, 201], JSON.stringify([comTudo.body, semOpcionais.body]));

    const lista = await request(app).get(`${ROTA}?limite=100`).set('Cookie', cookie(masters.A));
    assert.equal(lista.status, 200);
    const de = (id) => lista.body.usuarios.find((x) => x.id === id);
    const a = de(comTudo.body.usuario.id);
    assert.deepEqual(
      [a.cpfMascarado, a.matricula, a.setor, a.horarioTrabalho, a.acessoQualquerIp],
      ['***.***.***-' + cpfFicticio(4242).slice(9), comTudo.body.administrativo.matricula, 'Segurança do Trabalho', { inicio: '07:30', fim: '17:00' }, false],
    );
    const b = de(semOpcionais.body.usuario.id);
    assert.deepEqual([b.cpfMascarado, b.setor, b.horarioTrabalho, b.acessoQualquerIp], ['***.***.***-' + cpfFicticio(4243).slice(9), 'Compras', null, true]);
    const master = de(masters.A.usuarioId);
    assert.deepEqual([master.cpfMascarado, master.matricula, master.setor, master.horarioTrabalho, master.acessoQualquerIp], [null, null, null, null, true], 'vínculo anterior às 075–077: nada inventado');
    const texto = JSON.stringify(lista.body);
    assert.equal(texto.includes(cpfFicticio(4242)) || texto.includes(cpfFicticio(4243)), false, 'nenhum CPF em claro');
    assert.equal(texto.includes('203.0.113') || texto.includes('2001:db8') || /ipsPermitidos|restricaoIp/.test(texto), false, 'nenhuma lista de IPs na listagem');
    for (const item of lista.body.usuarios) assert.deepEqual(Object.keys(item).sort(), CAMPOS_DO_USUARIO);

    const detalhe = await request(app).get(`${ROTA}/${comTudo.body.usuario.id}`).set('Cookie', cookie(masters.A));
    assert.equal(detalhe.status, 200);
    assert.deepEqual([detalhe.body.usuario.cpfMascarado, detalhe.body.usuario.setor, detalhe.body.usuario.horarioTrabalho, detalhe.body.usuario.acessoQualquerIp], [a.cpfMascarado, 'Segurança do Trabalho', { inicio: '07:30', fim: '17:00' }, false]);
    assert.equal(JSON.stringify(detalhe.body).includes(cpfFicticio(4242)), false);
  });

  test('grupo é OPCIONAL para os perfis cadastráveis (ADMINISTRADOR, SUPERVISOR e USUARIO); MASTER não é cadastrável aqui (409 e nada criado); grupo informado segue validado', async () => {
    const antes = await contagens();
    const master = await criar(masters.A, corpoBase({ tipoConta: 'MASTER' }));
    assert.deepEqual([master.status, master.body.codigo], [409, 'MASTER_SOMENTE_PELO_PAINEL_PRIVADO']);
    assert.deepEqual(await contagens(), antes);
    for (const tipoConta of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
      const r = await criar(masters.A, corpoBase({ tipoConta }));
      assert.equal(r.status, 201, `${tipoConta}: ${JSON.stringify(r.body)}`);
      assert.deepEqual([r.body.usuario.perfil, r.body.usuario.grupo, r.body.administrativo.grupoAcessoId, (await linhaUsuario(r.body.usuario.id)).grupo_acesso_id], [tipoConta, null, null, null]);
    }
    const comGrupo = await criar(masters.A, corpoBase({ tipoConta: 'SUPERVISOR', grupoAcessoId: grupos.A }));
    assert.equal(comGrupo.status, 201);
    assert.equal((await linhaUsuario(comGrupo.body.usuario.id)).grupo_acesso_id, grupos.A);
    assert.equal((await criar(masters.A, corpoBase({ tipoConta: 'SUPERVISOR', grupoAcessoId: grupos.AInativo }))).status, 409);
  });

  test('CPF: obrigatório, com dígitos verificadores, único no sistema inteiro (inclusive em outra empresa), também na corrida (ROLLBACK real), e imutável: nenhuma rota aceita cpf depois', async (t) => {
    const antes = await contagens();
    const semCpf = corpoBase();
    delete semCpf.cpf;
    const r1 = await criar(masters.A, semCpf);
    assert.equal(r1.status, 400, JSON.stringify(r1.body));
    assert.ok(r1.body.detalhes.some((d) => d.campo === 'body.cpf'), JSON.stringify(r1.body.detalhes));
    const r2 = await criar(masters.A, corpoBase({ cpf: '529.982.247-26' }));
    assert.deepEqual([r2.status, r2.body.detalhes[0].campo, r2.body.detalhes[0].codigo], [400, 'body.cpf', 'CPF_DV_INVALIDO']);
    assert.equal((await criar(masters.A, corpoBase({ cpf: '111.111.111-11' }))).status, 400, 'dígitos iguais');

    const primeiro = await criar(masters.A, corpoBase({ cpf: cpfFicticio(888) }));
    assert.equal(primeiro.status, 201, JSON.stringify(primeiro.body));
    const depoisDoPrimeiro = await contagens();
    const emB = await criar(masters.B, corpoBase({ cpf: comMascara(cpfFicticio(888)) }));
    assert.deepEqual([emB.status, emB.body.codigo], [409, 'IDENTIDADE_CPF_JA_EXISTENTE'], JSON.stringify(emB.body));
    assert.equal(JSON.stringify(emB.body).includes(cpfFicticio(888)), false);
    assert.deepEqual(await contagens(), depoisDoPrimeiro, 'nada criado');

    // Corrida: a conferência não vê o CPF, o índice único da 075 vê — a transação inteira volta.
    t.mock.method(identidadeRepo, 'buscarPorCpf', async () => null);
    const corrida = await criar(masters.A, corpoBase({ cpf: cpfFicticio(888) }));
    assert.deepEqual([corrida.status, corrida.body.codigo], [409, 'IDENTIDADE_CPF_JA_EXISTENTE']);
    assert.deepEqual(await contagens(), depoisDoPrimeiro, 'a identidade da corrida foi desfeita com o ROLLBACK');
    assert.ok(depoisDoPrimeiro[0] === antes[0] + 1 && depoisDoPrimeiro[1] === antes[1] + 1);

    const { identidade_id: identidadeId } = await linhaUsuario(primeiro.body.usuario.id);
    await assert.rejects(pool.query('UPDATE identidades SET cpf = $2 WHERE id = $1', [identidadeId, cpfFicticio(889)]), (e) => e.code === 'P0001');
    await assert.rejects(pool.query('UPDATE identidades SET cpf = NULL WHERE id = $1', [identidadeId]), (e) => e.code === 'P0001');
    assert.equal(await cpfDe(identidadeId), cpfFicticio(888));
    const patchUsuario = await request(app).patch(`${ROTA}/${primeiro.body.usuario.id}`).set('Cookie', cookie(masters.A)).send({ cpf: cpfFicticio(889) });
    assert.equal(patchUsuario.status, 400, 'a alteração de usuário não conhece cpf');
    const patchConta = await request(app).patch(CONTA).set('Cookie', cookie(masters.A)).send({ cpf: cpfFicticio(889) });
    assert.equal(patchConta.status, 400, 'a conta da própria identidade não conhece cpf');
    assert.equal(await cpfDe(identidadeId), cpfFicticio(888));
  });

  test('matrícula e setor: obrigatórios e aparados; matrícula única por empresa (igual em outra empresa é aceita), inclusive na corrida — a identidade já inserida volta com o ROLLBACK', async (t) => {
    const semMatricula = corpoBase();
    delete semMatricula.matricula;
    const r1 = await criar(masters.A, semMatricula);
    assert.ok(r1.status === 400 && r1.body.detalhes.some((d) => d.campo === 'body.matricula'), JSON.stringify(r1.body));
    const semSetor = corpoBase();
    delete semSetor.setor;
    const r2 = await criar(masters.A, semSetor);
    assert.ok(r2.status === 400 && r2.body.detalhes.some((d) => d.campo === 'body.setor'), JSON.stringify(r2.body));
    assert.ok((await criar(masters.A, corpoBase({ matricula: '   ' }))).body.detalhes.some((d) => d.codigo === 'MATRICULA_INVALIDA'));
    assert.ok((await criar(masters.A, corpoBase({ setor: 'S'.repeat(101) }))).body.detalhes.some((d) => d.codigo === 'SETOR_INVALIDO'));

    const primeiro = await criar(masters.A, corpoBase({ matricula: '  MAT-100  ', setor: '  Segurança do Trabalho  ' }));
    assert.equal(primeiro.status, 201, JSON.stringify(primeiro.body));
    const u = await linhaUsuario(primeiro.body.usuario.id);
    assert.deepEqual([u.matricula, u.setor, u.inicio, u.fim, u.grupo_acesso_id], ['MAT-100', 'Segurança do Trabalho', null, null, null], 'aparados; opcionais nulos');
    const antes = await contagens();
    const repetida = await criar(masters.A, corpoBase({ matricula: 'MAT-100' }));
    assert.deepEqual([repetida.status, repetida.body.codigo], [409, 'USUARIO_MATRICULA_JA_EXISTENTE'], JSON.stringify(repetida.body));
    assert.deepEqual(await contagens(), antes);
    const emB = await criar(masters.B, corpoBase({ matricula: 'MAT-100' }));
    assert.equal(emB.status, 201, 'a unicidade é por empresa');
    const depoisDeB = await contagens();

    t.mock.method(usuarioRepo, 'existeMatricula', async () => false);
    const corrida = await criar(masters.A, corpoBase({ matricula: 'MAT-100' }));
    assert.deepEqual([corrida.status, corrida.body.codigo], [409, 'USUARIO_MATRICULA_JA_EXISTENTE']);
    assert.deepEqual(await contagens(), depoisDeB, 'a identidade inserida antes do vínculo não sobrevive: uma transação só');
  });

  test('horário de trabalho: opcional, gravado como informado e só informativo — o acesso não depende do horário; metade do horário ou formato errado é 400', async () => {
    const r1 = await criar(masters.A, corpoBase({ horarioTrabalho: { inicio: '08:00' } }));
    assert.ok(r1.status === 400 && r1.body.detalhes.some((d) => d.campo === 'body.horarioTrabalho.fim'), JSON.stringify(r1.body));
    const r2 = await criar(masters.A, corpoBase({ horarioTrabalho: { inicio: '8h', fim: '18:00' } }));
    assert.ok(r2.status === 400 && r2.body.detalhes.some((d) => d.codigo === 'HORARIO_INVALIDO' && d.campo === 'body.horarioTrabalho.inicio'), JSON.stringify(r2.body));
    assert.equal((await criar(masters.A, corpoBase({ horarioTrabalho: null }))).status, 201, 'null explícito = sem horário');

    // Janela de um minuto: em qualquer instante do dia o acesso continua igual.
    const pronto = await usuarioPronto(masters.A, { horarioTrabalho: { inicio: '03:00', fim: '03:01' } });
    const u = await linhaUsuario(pronto.usuarioId);
    assert.deepEqual([u.inicio, u.fim], ['03:00:00', '03:01:00']);
    const entrada = await login(pronto.email, SENHA_PROVISORIA, IP_B);
    assert.equal(entrada.status, 200, JSON.stringify(entrada.body));
    const jar = cookiesDe(entrada);
    assert.equal((await comJar('get', ME, jar, IP_B)).status, 200, 'nenhum middleware olha o horário');
    const fonte = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'src', 'middleware', 'autenticacao.js'), 'utf8');
    assert.equal(/horario/i.test(fonte), false, 'o middleware de sessão não conhece horário de trabalho');
  });

  test('IPs: sem lista, qualquer endereço; com um IP, só ele — login, seleção e toda requisição da sessão empresarial; de outro endereço, 403 ACESSO_IP_NAO_PERMITIDO sem sessão nova (login compensado) e sem renovar a existente', async () => {
    const livre = await usuarioPronto(masters.A);
    for (const ip of [IP_A, IP_B, undefined]) {
      const entrada = await login(livre.email, SENHA_PROVISORIA, ip);
      assert.equal(entrada.status, 200, `sem restrição, de ${ip || 'loopback'}`);
      assert.equal((await comJar('get', ME, cookiesDe(entrada), IP_B)).status, 200);
    }

    const restrito = await usuarioPronto(masters.A, { ipsPermitidos: [IP_A] });
    const permitido = await login(restrito.email, SENHA_PROVISORIA, IP_A);
    assert.equal(permitido.status, 200, JSON.stringify(permitido.body));
    const jar = cookiesDe(permitido);
    assert.ok(jar[NOME_GLOBAL] && jar[NOME_EMPRESA], 'uma empresa só: selecionada automaticamente, do IP permitido');
    assert.equal((await comJar('get', ME, jar, IP_A)).status, 200);
    assert.equal((await comJar('get', ME, jar, `::ffff:${IP_A}`)).status, 200, 'IPv4 mapeado em IPv6 é o mesmo endereço');

    for (const [nome, pedido] of [
      ['GET /auth/me de outro IP', comJar('get', ME, jar, IP_B)],
      ['GET /administracao/usuarios de outro IP', comJar('get', ROTA, jar, IP_B)],
      ['GET /auth/me sem cabeçalho (loopback)', comJar('get', ME, jar)],
    ]) {
      const r = await pedido;
      assert.equal(r.status, 403, `${nome}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body, NAO_PERMITIDO, nome);
    }
    const usoAntes = (await um('SELECT ultimo_uso_em FROM sessoes WHERE empresa_id = $1 AND usuario_id = $2 ORDER BY id DESC LIMIT 1', [empresas.A, restrito.usuarioId])).ultimo_uso_em;
    await comJar('get', ME, jar, IP_B);
    const usoDepois = (await um('SELECT ultimo_uso_em FROM sessoes WHERE empresa_id = $1 AND usuario_id = $2 ORDER BY id DESC LIMIT 1', [empresas.A, restrito.usuarioId])).ultimo_uso_em;
    assert.equal(usoDepois.toISOString(), usoAntes.toISOString(), 'a recusa não renova a sessão');
    assert.equal((await comJar('get', ME, jar, IP_A)).status, 200, 'do IP permitido a sessão segue valendo');
    assert.equal((await comJar('get', ME_GLOBAL, jar, IP_B)).status, 200, 'a sessão GLOBAL (pessoa) não é restrita: a lista de IPs é do vínculo na empresa');

    const globaisAntes = (await um('SELECT count(*)::int AS n FROM sessoes_globais WHERE identidade_id = $1 AND revogada_em IS NULL', [restrito.identidadeId])).n;
    const empresariaisAntes = (await um('SELECT count(*)::int AS n FROM sessoes WHERE empresa_id = $1 AND usuario_id = $2 AND revogada_em IS NULL', [empresas.A, restrito.usuarioId])).n;
    const negado = await login(restrito.email, SENHA_PROVISORIA, IP_B);
    assert.equal(negado.status, 403, JSON.stringify(negado.body));
    assert.deepEqual(negado.body, NAO_PERMITIDO);
    assert.equal('set-cookie' in negado.headers, false, 'nenhum cookie');
    assert.equal((await um('SELECT count(*)::int AS n FROM sessoes_globais WHERE identidade_id = $1 AND revogada_em IS NULL', [restrito.identidadeId])).n, globaisAntes, 'a sessão global do login negado foi compensada');
    assert.equal((await um('SELECT count(*)::int AS n FROM sessoes WHERE empresa_id = $1 AND usuario_id = $2 AND revogada_em IS NULL', [empresas.A, restrito.usuarioId])).n, empresariaisAntes, 'nenhuma sessão empresarial nasceu');
    assert.equal((await login(restrito.email, SENHA_PROVISORIA)).status, 403, 'sem X-Forwarded-For o endereço é o do loopback, fora da lista');
  });

  test('IPs: vários (IPv4 e IPv6) valem todos, em qualquer grafia; em duas empresas a restrição é só da empresa que a tem; endereço inválido, faixa ou mais de 20 são 400', async () => {
    const r1 = await criar(masters.A, corpoBase({ ipsPermitidos: ['203.0.113.0/24'] }));
    assert.ok(r1.status === 400 && r1.body.detalhes.some((d) => d.campo === 'body.ipsPermitidos.0' && d.codigo === 'IP_INVALIDO'), JSON.stringify(r1.body));
    assert.equal((await criar(masters.A, corpoBase({ ipsPermitidos: ['localhost'] }))).status, 400);
    assert.equal((await criar(masters.A, corpoBase({ ipsPermitidos: ['203.0.113.10:8080'] }))).status, 400);
    assert.equal((await criar(masters.A, corpoBase({ ipsPermitidos: Array.from({ length: 21 }, (_, i) => `203.0.113.${i + 1}`) }))).status, 400, 'mais de 20');
    assert.equal((await criar(masters.A, corpoBase({ ipsPermitidos: [] }))).status, 201, 'lista vazia = sem restrição');

    const dois = await usuarioPronto(masters.A, { ipsPermitidos: [IP_A, IP6] });
    assert.deepEqual(await ipsDe(empresas.A, dois.usuarioId), IPS_A_E_6);
    const entrada = await login(dois.email, SENHA_PROVISORIA, IP6_EXTENSO);
    assert.equal(entrada.status, 200, 'IPv6 por extenso e maiúsculo é o IPv6 cadastrado');
    const jar = cookiesDe(entrada);
    assert.equal((await comJar('get', ME, jar, IP_A)).status, 200);
    assert.equal((await comJar('get', ME, jar, '2001:db8:0:0:0:0:0:10')).status, 200);
    assert.equal((await comJar('get', ME, jar, IP_B)).status, 403);
    assert.equal((await comJar('get', ME, jar, '2001:db8::11')).status, 403);

    // A mesma pessoa em A (restrita a IP_A) e em B (livre): o vínculo decide.
    const duas = await usuarioPronto(masters.A, { ipsPermitidos: [IP_A] });
    await pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Pessoa em B', NULL, NULL, 'USUARIO', $2)", [empresas.B, duas.identidadeId]);
    const deB = await login(duas.email, SENHA_PROVISORIA, IP_B);
    assert.equal(deB.status, 200, JSON.stringify(deB.body));
    assert.equal(deB.body.empresas.length, 2);
    assert.equal(deB.body.contexto, null, 'duas empresas: nada selecionado');
    const jarB = cookiesDe(deB);
    const selecionarA = await comJar('post', selecionarRota(empresas.A), jarB, IP_B).send();
    assert.deepEqual([selecionarA.status, selecionarA.body.codigo], [403, 'ACESSO_IP_NAO_PERMITIDO'], JSON.stringify(selecionarA.body));
    assert.equal((await um('SELECT count(*)::int AS n FROM sessoes WHERE empresa_id = $1 AND usuario_id = $2', [empresas.A, duas.usuarioId])).n, 0, 'nenhuma sessão em A nasceu');
    const selecionarB = await comJar('post', selecionarRota(empresas.B), jarB, IP_B).send();
    assert.equal(selecionarB.status, 200, JSON.stringify(selecionarB.body));
    const selecionarADePermitido = await comJar('post', selecionarRota(empresas.A), jarB, IP_A).send();
    assert.equal(selecionarADePermitido.status, 200, 'de IP_A a empresa A abre');
  });

  test('grupo de acesso: opcional; inativo é 409, de outra empresa ou inexistente é 404 (idênticos), MASTER com grupo é 409; nada é criado nesses casos', async () => {
    const antes = await contagens();
    const inativo = await criar(masters.A, corpoBase({ grupoAcessoId: grupos.AInativo }));
    assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'GRUPO_INATIVO'], JSON.stringify(inativo.body));
    const deB = await criar(masters.A, corpoBase({ grupoAcessoId: grupos.B }));
    const inexistente = await criar(masters.A, corpoBase({ grupoAcessoId: 999999 }));
    assert.deepEqual([deB.status, deB.body], [404, inexistente.body], 'grupo de outra empresa = inexistente');
    assert.equal(inexistente.body.codigo, 'GRUPO_NAO_ENCONTRADO');
    const masterComGrupo = await criar(masters.A, corpoBase({ tipoConta: 'MASTER', grupoAcessoId: grupos.A }));
    assert.deepEqual([masterComGrupo.status, masterComGrupo.body.codigo], [409, 'MASTER_SOMENTE_PELO_PAINEL_PRIVADO'], 'MASTER nunca nasce por aqui, com ou sem grupo');
    assert.equal((await criar(masters.A, corpoBase({ grupoAcessoId: 0 }))).status, 400);
    assert.deepEqual(await contagens(), antes, 'nenhuma recusa deixa rastro');

    const com = await criar(masters.A, corpoBase({ grupoAcessoId: grupos.A }));
    assert.equal(com.status, 201, JSON.stringify(com.body));
    assert.equal((await linhaUsuario(com.body.usuario.id)).grupo_acesso_id, grupos.A);
    const sem = await criar(masters.A, corpoBase());
    assert.equal(sem.status, 201);
    assert.deepEqual([(await linhaUsuario(sem.body.usuario.id)).grupo_acesso_id, sem.body.usuario.grupo, sem.body.administrativo.grupoAcessoId], [null, null, null]);
  });

  test('senha provisória e e-mail continuam como antes: a criada entra em troca obrigatória; e-mail já existente é 409 IDENTIDADE_EMAIL_JA_EXISTENTE sem tocar a senha de ninguém; nenhum convite', async () => {
    const corpo = corpoBase();
    const r = await criar(masters.A, corpo);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const entrada = await login(corpo.email, SENHA_PROVISORIA, IP_A);
    assert.deepEqual([entrada.status, entrada.body.identidade.trocaSenhaObrigatoria], [200, true]);
    const me = await comJar('get', ME, cookiesDe(entrada), IP_A);
    assert.deepEqual([me.status, me.body.codigo], [403, 'TROCA_SENHA_OBRIGATORIA']);

    const antes = await contagens();
    const hashAntes = (await um('SELECT senha_hash FROM identidades WHERE lower(email) = lower($1)', [masters.A.identidade.email])).senha_hash;
    const duplicado = await criar(masters.A, corpoBase({ email: masters.A.identidade.email.toUpperCase() }));
    assert.deepEqual([duplicado.status, duplicado.body.codigo], [409, 'IDENTIDADE_EMAIL_JA_EXISTENTE']);
    assert.equal((await um('SELECT senha_hash FROM identidades WHERE lower(email) = lower($1)', [masters.A.identidade.email])).senha_hash, hashAntes);
    assert.deepEqual(await contagens(), antes);
    assert.equal((await um('SELECT count(*)::int AS n FROM convites_usuario')).n, 0);
  });

  test('autoridade, perfis e contrato estrito: SUPERVISOR e ADMINISTRADOR sem autorização não criam; o autorizado cria USUARIO e não MASTER; sem sessão 401; confirmação da senha, empresa, perfil, permissões e cpf no PATCH são recusados; B nunca vê A', async () => {
    const supervisor = await contaDaEmpresa(empresas.A, 'SUPERVISOR');
    assert.equal((await criar(supervisor, corpoBase())).status, 403);
    const adminSem = await contaDaEmpresa(empresas.A, 'ADMINISTRADOR');
    assert.deepEqual([(await criar(adminSem, corpoBase())).status, (await criar(adminSem, corpoBase())).body.codigo], [403, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA']);
    const admin = await administradorAutorizado(empresas.A, masters.A);
    const criadoPeloAdmin = await criar(admin, corpoBase({ tipoConta: 'USUARIO', ipsPermitidos: [IP_A], grupoAcessoId: grupos.A }));
    assert.equal(criadoPeloAdmin.status, 201, JSON.stringify(criadoPeloAdmin.body));
    assert.deepEqual([(await criar(admin, corpoBase({ tipoConta: 'MASTER' }))).status, (await criar(admin, corpoBase({ tipoConta: 'ADMINISTRADOR' }))).body.codigo], [403, 'USUARIO_PERFIL_NAO_PERMITIDO']);
    assert.equal((await request(app).post(ROTA).send(corpoBase())).status, 401);

    for (const extra of [{ confirmarSenhaProvisoria: SENHA_PROVISORIA }, { empresaId: empresas.B }, { perfil: 'MASTER' }, { permissoes: { stock: true } }, { ativo: false }, { funcionarioId: 1 }]) {
      const r = await criar(masters.A, corpoBase(extra));
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.ok(r.body.detalhes.some((d) => d.codigo === 'CAMPO_NAO_PERMITIDO'), JSON.stringify(r.body));
    }

    const listaB = await request(app).get(`${ROTA}?limite=100`).set('Cookie', cookie(masters.B));
    assert.equal(listaB.status, 200);
    assert.equal(listaB.body.usuarios.some((u) => u.id === criadoPeloAdmin.body.usuario.id), false);
    const matriculasDeA = (await todos('SELECT matricula FROM usuarios WHERE empresa_id = $1 AND matricula IS NOT NULL', [empresas.A])).map((l) => l.matricula);
    const matriculasDeB = (await todos('SELECT matricula FROM usuarios WHERE empresa_id = $1 AND matricula IS NOT NULL', [empresas.B])).map((l) => l.matricula);
    assert.ok(matriculasDeA.length > 0 && matriculasDeB.length > 0 && matriculasDeA.includes('MAT-100') && matriculasDeB.includes('MAT-100'), 'a mesma matrícula vive em A e em B, cada uma na sua empresa');
  });

  test('atomicidade de ponta a ponta: se a gravação dos IPs falhar, identidade e vínculo já inseridos não sobrevivem (500 e contagens iguais)', async (t) => {
    const antes = await contagens();
    t.mock.method(usuarioIpRepo, 'inserir', async () => { throw new Error('falha simulada na gravação dos IPs'); });
    const r = await criar(masters.A, corpoBase({ ipsPermitidos: [IP_A] }));
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(JSON.stringify(r.body).includes('falha simulada'), false, 'erro interno genérico');
    assert.deepEqual(await contagens(), antes, 'nenhum cadastro pela metade');
  });
});
