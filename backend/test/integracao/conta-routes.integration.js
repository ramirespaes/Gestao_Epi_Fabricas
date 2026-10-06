'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarEmpresa, criarFuncionario } = require('./helpers/entrega-epi');
const { mascararCpf } = require('../../src/utils/normalizacao');
const { todasAsMigrations } = require('./helpers/recuperacao-senha');
const { espiarConsole } = require('./helpers/recuperacao-senha-servico');
const { SENHA_ATUAL, OUTRA_SENHA, fabricaPortal } = require('./helpers/troca-senha');
const { turnstileDeTeste } = require('./helpers/turnstile-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarExigirSessaoGlobal } = require('../../src/middleware/autenticacao-global');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarAuthGlobalRoutes } = require('../../src/routes/auth-global.routes');
const { criarAuthGlobalController } = require('../../src/controllers/auth-global.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarContaRoutes } = require('../../src/routes/conta.routes');
const { criarContaController } = require('../../src/controllers/conta.controller');
const entrega = require('../../src/services/entrega-recuperacao-senha.service');
const loginGlobalService = require('../../src/services/login-global.service');
const password = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Configurações — conta da identidade autenticada pela camada HTTP, contra
 * PostgreSQL real em schema temporário com todas as migrations (inclusive a
 * 072). Leitura pelas rotas existentes (/auth/global/me e /auth/me,
 * estendidas), escrita por PATCH /auth/global/conta e PATCH /auth/global/email.
 */

const ME_GLOBAL = '/api/auth/global/me';
const ME = '/api/auth/me';
const CONTA = '/api/auth/global/conta';
const EMAIL = '/api/auth/global/email';
const { cookieNomeGlobal: NOME_GLOBAL, cookieNome: NOME_EMPRESA } = authConfig.sessao;
const PADRAO = { telefone: null, tema: 'sistema', modoVisual: 'padrao' };

describe('Configurações — conta, aparência e e-mail de acesso (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let hashAtual;
  let portal;
  const empresas = [];

  const cookie = (c) => [`${NOME_GLOBAL}=${c.global.token}`, ...(c.empresarial ? [`${NOME_EMPRESA}=${c.empresarial.token}`] : [])].join('; ');
  const get = (caminho, c) => request(app).get(caminho).set('Cookie', cookie(c));
  const patch = (caminho, c, corpo) => request(app).patch(caminho).set('Cookie', cookie(c)).set('User-Agent', 'Agente de Teste').send(corpo);
  const identidadeNoBanco = async (id) => (await pool.query('SELECT email, telefone, tema, modo_visual, senha_hash FROM identidades WHERE id = $1', [id])).rows[0];
  const auditoriaDe = async (id, acao) => (await pool.query('SELECT contexto, descricao, referencia, dados_anteriores, dados_novos FROM logs_auditoria_identidade WHERE identidade_id = $1 AND acao = $2 ORDER BY id', [id, acao])).rows;

  async function cenario() {
    const identidade = await portal.novaIdentidade();
    await portal.vincular(identidade, empresas[0], 'SUPERVISOR');
    const global = await portal.entrar(identidade);
    const empresarial = await portal.selecionar(identidade, global, empresas[0]);
    return { identidade, global, empresarial };
  }

  function semSensiveis(resposta, extras = []) {
    const texto = JSON.stringify(resposta.body) + JSON.stringify(resposta.headers);
    for (const sensivel of [SENHA_ATUAL, OUTRA_SENHA, hashAtual, 'senha_hash', 'senhaHash', ...extras]) {
      assert.equal(texto.includes(sensivel), false, `a resposta contém ${String(sensivel).slice(0, 8)}…`);
    }
  }

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha(SENHA_ATUAL);
    portal = fabricaPortal({ pool, hashSenha: hashAtual });
    empresas.push(await criarEmpresa(pool, '11222333000181', 'Empresa Alfa'));
    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const exigirSessaoGlobal = criarExigirSessaoGlobal({ pool });
    app = criarAppTeste((a) => {
      a.use(
        '/api',
        criarAuthGlobalRoutes({ controller: criarAuthGlobalController({ pool }), limitador: semLimite(), exigirSessaoGlobal, ...turnstileDeTeste() }),
        criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao: criarExigirSessao({ pool }) }),
        criarContaRoutes({ controller: criarContaController({ pool }), limitadorEmail: semLimite(), exigirSessaoGlobal }),
      );
    });
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('leitura: /auth/global/me traz telefone, tema, modo visual e último acesso da identidade; /auth/me traz as preferências; a primeira sessão não tem acesso anterior', async () => {
    const c = await cenario();
    const me = await get(ME_GLOBAL, c);
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.deepEqual(me.body.identidade, { id: c.identidade.id, email: c.identidade.email, ...PADRAO, ultimoAcessoEm: null, trocaSenhaObrigatoria: false });
    assert.equal(me.body.contexto.usuario.perfil, 'SUPERVISOR');
    assert.equal(me.body.contexto.usuario.ativo, true, 'situação real do vínculo');
    assert.deepEqual(me.body.contexto.usuario.funcionario, { vinculado: false, matricula: null, cpfMascarado: null }, 'sem vínculo explícito, nada é inferido');
    semSensiveis(me);
    const empresarial = await get(ME, c);
    assert.equal(empresarial.status, 200);
    assert.deepEqual(empresarial.body.preferencias, { tema: 'sistema', modoVisual: 'padrao' });
    assert.equal('telefone' in empresarial.body.usuario, false, '/auth/me continua com o corpo de antes, mais as preferências');

    // Segundo login (outro "computador"): o último acesso passa a ser a criação da sessão global anterior.
    const outra = await portal.entrar(c.identidade);
    const me2 = await get(ME_GLOBAL, { global: outra });
    const anterior = (await pool.query('SELECT criado_em FROM sessoes_globais WHERE id = $1', [c.global.id])).rows[0].criado_em;
    assert.equal(me2.body.identidade.ultimoAcessoEm, anterior.toISOString());
  });

  test('Minha Conta: CPF mascarado e matrícula vêm SÓ do funcionário explicitamente vinculado (073); nome igual não vincula; o CPF completo nunca sai; desvincular volta a "não vinculado"', async () => {
    const identidade = await portal.novaIdentidade();
    const usuarioId = await portal.vincular(identidade, empresas[0], 'USUARIO');
    const global = await portal.entrar(identidade);
    const empresarial = await portal.selecionar(identidade, global, empresas[0]);
    const c = { identidade, global, empresarial };
    const CPF = '52998224725';
    // Funcionário com o MESMO nome do usuário ('Pessoa de Teste'): sem vínculo explícito, não aparece.
    await pool.query("INSERT INTO funcionarios (empresa_id, matricula, nome, cpf) VALUES ($1, 'HOMONIMO-1', 'Pessoa de Teste', '11144477735')", [empresas[0]]);
    const funcionarioId = await criarFuncionario(pool, empresas[0], { matricula: 'MAT-0077', cpf: CPF });

    const antes = await get(ME_GLOBAL, c);
    assert.deepEqual(antes.body.contexto.usuario.funcionario, { vinculado: false, matricula: null, cpfMascarado: null });

    await pool.query('UPDATE usuarios SET funcionario_id = $2 WHERE id = $1', [usuarioId, funcionarioId]);
    const depois = await get(ME_GLOBAL, c);
    assert.equal(depois.status, 200, JSON.stringify(depois.body));
    assert.deepEqual(depois.body.contexto.usuario.funcionario, { vinculado: true, matricula: 'MAT-0077', cpfMascarado: mascararCpf(CPF) });
    assert.match(depois.body.contexto.usuario.funcionario.cpfMascarado, /^\*\*\*\.\*\*\*\.\*\*\*-\d{2}$/);
    assert.equal(depois.body.contexto.usuario.ativo, true);
    semSensiveis(depois, [CPF, '11144477735', 'HOMONIMO-1']);
    assert.equal('cpf' in depois.body.contexto.usuario.funcionario, false);

    await pool.query('UPDATE usuarios SET funcionario_id = NULL WHERE id = $1', [usuarioId]);
    const desvinculado = await get(ME_GLOBAL, c);
    assert.deepEqual(desvinculado.body.contexto.usuario.funcionario, { vinculado: false, matricula: null, cpfMascarado: null });
  });

  test('PATCH /auth/global/conta: telefone, tema e modo visual da própria identidade, aplicados nas duas leituras e em uma sessão nova; null limpa o telefone; auditoria só com os nomes dos campos', async () => {
    const c = await cenario();
    const r = await patch(CONTA, c, { telefone: ' (47) 99999-0001 ', tema: 'escuro', modoVisual: 'baixa_visao' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: 'ok', conta: { telefone: '(47) 99999-0001', tema: 'escuro', modoVisual: 'baixa_visao' } });
    semSensiveis(r);
    const banco = await identidadeNoBanco(c.identidade.id);
    assert.deepEqual([banco.telefone, banco.tema, banco.modo_visual], ['(47) 99999-0001', 'escuro', 'baixa_visao']);
    assert.deepEqual((await get(ME_GLOBAL, c)).body.identidade, { id: c.identidade.id, email: c.identidade.email, telefone: '(47) 99999-0001', tema: 'escuro', modoVisual: 'baixa_visao', ultimoAcessoEm: null, trocaSenhaObrigatoria: false });
    assert.deepEqual((await get(ME, c)).body.preferencias, { tema: 'escuro', modoVisual: 'baixa_visao' });

    // Só um campo: os outros ficam; null limpa o telefone.
    const soTema = await patch(CONTA, c, { tema: 'claro' });
    assert.deepEqual(soTema.body.conta, { telefone: '(47) 99999-0001', tema: 'claro', modoVisual: 'baixa_visao' });
    const limpa = await patch(CONTA, c, { telefone: null, modoVisual: 'padrao' });
    assert.deepEqual(limpa.body.conta, { telefone: null, tema: 'claro', modoVisual: 'padrao' });

    // Outro computador: login e seleção novos restauram a preferência.
    const global2 = await portal.entrar(c.identidade);
    const empresarial2 = await portal.selecionar(c.identidade, global2, empresas[0]);
    const nova = { global: global2, empresarial: empresarial2 };
    assert.deepEqual((await get(ME, nova)).body.preferencias, { tema: 'claro', modoVisual: 'padrao' });
    assert.equal((await get(ME_GLOBAL, nova)).body.identidade.tema, 'claro');

    const eventos = await auditoriaDe(c.identidade.id, 'CONTA_ATUALIZADA');
    assert.deepEqual(eventos.map((e) => e.contexto.campos), [['telefone', 'tema', 'modoVisual'], ['tema'], ['telefone', 'modoVisual']]);
    assert.doesNotMatch(JSON.stringify(eventos), /99999-0001|escuro|baixa_visao|claro/, 'a auditoria não guarda valores');
    assert.equal((await patch(CONTA, c, { tema: 'claro' })).status, 200, 'repetir o mesmo valor é aceito');
    assert.equal((await auditoriaDe(c.identidade.id, 'CONTA_ATUALIZADA')).length, 3, 'sem mudança, sem auditoria');
  });

  test('PATCH /auth/global/conta: corpo vazio, valor fora do domínio, telefone inválido e campo de autoridade → 400 sem alterar; sem sessão → 401; A nunca altera B', async () => {
    const a = await cenario();
    const b = await cenario();
    await patch(CONTA, b, { tema: 'escuro' });
    for (const corpo of [{}, { tema: 'dark' }, { modoVisual: 'contrast' }, { telefone: '' }, { telefone: '1'.repeat(21) }, { identidadeId: b.identidade.id, tema: 'claro' }, { email: 'x@y.co' }]) {
      const r = await patch(CONTA, a, corpo);
      assert.equal(r.status, 400, JSON.stringify(corpo));
    }
    assert.equal((await request(app).patch(CONTA).send({ tema: 'claro' })).status, 401);
    await patch(CONTA, a, { tema: 'claro', telefone: '(11) 90000-0000' });
    const deB = await identidadeNoBanco(b.identidade.id);
    assert.deepEqual([deB.telefone, deB.tema], [null, 'escuro'], 'B continua com o que B escolheu');
    assert.equal((await get(ME_GLOBAL, b)).body.identidade.tema, 'escuro');
  });

  test('PATCH /auth/global/email: senha atual confere → e-mail normalizado passa a valer no login, o antigo não; demais sessões revogadas (EMAIL_ALTERADO), a atual e a empresarial dela preservadas; auditoria sem o endereço; aviso ao e-mail antigo', async (t) => {
    const avisos = [];
    t.mock.method(entrega, 'enfileirarAvisoEmailAlterado', (mensagem) => { avisos.push(mensagem); });
    const c = await cenario();
    const outraGlobal = await portal.entrar(c.identidade);
    const outraEmpresarial = await portal.selecionar(c.identidade, outraGlobal, empresas[0]);
    const antigo = c.identidade.email;
    const novo = `Nova.${c.identidade.id}@Example.INVALID`;

    const r = await patch(EMAIL, c, { senhaAtual: SENHA_ATUAL, novoEmail: ` ${novo} ` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: 'EMAIL_ALTERADO', email: novo.toLowerCase() });
    semSensiveis(r);

    const banco = await identidadeNoBanco(c.identidade.id);
    assert.equal(banco.email, novo.toLowerCase());
    assert.equal(banco.senha_hash, hashAtual, 'a senha não muda');
    const entrou = await loginGlobalService.autenticar(pool, { email: novo.toLowerCase(), senha: SENHA_ATUAL });
    assert.equal(entrou.identidade.id, c.identidade.id, 'o novo e-mail entra');
    await assert.rejects(loginGlobalService.autenticar(pool, { email: antigo, senha: SENHA_ATUAL }), 'o antigo não entra mais');

    assert.equal(await portal.globalVale(c.global), true, 'sessão global atual preservada');
    assert.equal(await portal.empresarialVale(c.empresarial), true, 'sessão empresarial da atual preservada');
    assert.equal(await portal.globalVale(outraGlobal), false, 'outra sessão global revogada');
    assert.equal(await portal.empresarialVale(outraEmpresarial), false, 'outra sessão empresarial revogada');
    assert.deepEqual(await portal.motivosGlobais([outraGlobal.id]), ['EMAIL_ALTERADO']);
    assert.deepEqual(await portal.motivosEmpresariais([outraEmpresarial.id]), ['EMAIL_ALTERADO']);

    const [evento] = await auditoriaDe(c.identidade.id, 'EMAIL_ALTERADO');
    assert.ok(evento, 'auditoria EMAIL_ALTERADO');
    assert.deepEqual([evento.contexto.sessoesGlobaisRevogadas, evento.contexto.sessoesEmpresariaisRevogadas, evento.contexto.sessaoEmpresarialPreservada], [1, 1, true]);
    assert.doesNotMatch(JSON.stringify(evento), new RegExp(`${antigo}|${novo.toLowerCase()}|${SENHA_ATUAL}`), 'auditoria sem e-mail nem senha');
    assert.deepEqual(avisos, [{ escopo: 'PORTAL', email: antigo }], 'aviso ao endereço ANTIGO, uma vez');
    assert.equal((await get(ME_GLOBAL, c)).body.identidade.email, novo.toLowerCase());
  });

  test('PATCH /auth/global/email: senha errada → 401 e nada muda; e-mail já usado por outra identidade (em outra caixa) → 409 genérico; igual ao atual → 400; inválido → 400; sem sessão → 401', async (t) => {
    const avisos = [];
    t.mock.method(entrega, 'enfileirarAvisoEmailAlterado', (mensagem) => { avisos.push(mensagem); });
    const a = await cenario();
    const b = await cenario();
    const errada = await patch(EMAIL, a, { senhaAtual: OUTRA_SENHA, novoEmail: `x.${a.identidade.id}@example.invalid` });
    assert.deepEqual([errada.status, errada.body.codigo], [401, 'SENHA_ATUAL_INVALIDA']);
    const emUso = await patch(EMAIL, a, { senhaAtual: SENHA_ATUAL, novoEmail: b.identidade.email.toUpperCase() });
    assert.deepEqual([emUso.status, emUso.body.codigo], [409, 'EMAIL_INDISPONIVEL']);
    assert.doesNotMatch(JSON.stringify(emUso.body), new RegExp(b.identidade.email, 'i'), 'não revela o dono');
    const igual = await patch(EMAIL, a, { senhaAtual: SENHA_ATUAL, novoEmail: a.identidade.email.toUpperCase() });
    assert.deepEqual([igual.status, igual.body.codigo], [400, 'EMAIL_IGUAL_AO_ATUAL']);
    for (const novoEmail of ['sem-arroba', 'acento@exémplo.com', '']) {
      assert.equal((await patch(EMAIL, a, { senhaAtual: SENHA_ATUAL, novoEmail })).status, 400, novoEmail);
    }
    for (const corpo of [{ senhaAtual: SENHA_ATUAL }, { novoEmail: 'a@b.co' }, { senhaAtual: SENHA_ATUAL, novoEmail: 'a@b.co', identidadeId: b.identidade.id }]) {
      assert.equal((await patch(EMAIL, a, corpo)).status, 400, JSON.stringify(corpo));
    }
    assert.equal((await request(app).patch(EMAIL).send({ senhaAtual: SENHA_ATUAL, novoEmail: 'a@b.co' })).status, 401);
    assert.equal((await identidadeNoBanco(a.identidade.id)).email, a.identidade.email);
    assert.equal((await identidadeNoBanco(b.identidade.id)).email, b.identidade.email);
    assert.equal(await portal.globalVale(a.global), true);
    assert.deepEqual(avisos, [], 'nenhum aviso sem alteração');
    assert.equal((await auditoriaDe(a.identidade.id, 'EMAIL_ALTERADO')).length, 0);
  });

  test('falha ao enfileirar o aviso: a alteração já confirmada fica, o cliente recebe 200 e o registro técnico não traz o e-mail nem a senha', async (t) => {
    t.mock.method(entrega, 'enfileirarAvisoEmailAlterado', () => { throw new Error(`falha com ${SENHA_ATUAL} e e-mail@dentro.invalid`); });
    const linhas = espiarConsole(t);
    const c = await cenario();
    const antigo = c.identidade.email;
    const novo = `aviso.falhou.${c.identidade.id}@example.invalid`;
    const r = await patch(EMAIL, c, { senhaAtual: SENHA_ATUAL, novoEmail: novo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await identidadeNoBanco(c.identidade.id)).email, novo);
    assert.equal((await auditoriaDe(c.identidade.id, 'EMAIL_ALTERADO')).length, 1);
    const erros = linhas.filter((l) => l.metodo === 'error');
    assert.equal(erros.length, 1, 'uma linha técnica da falha');
    assert.match(erros[0].texto, /troca-email|aviso/);
    assert.doesNotMatch(erros[0].texto, new RegExp(`${antigo}|${novo}|${SENHA_ATUAL}|e-mail@dentro`));
  });
});
