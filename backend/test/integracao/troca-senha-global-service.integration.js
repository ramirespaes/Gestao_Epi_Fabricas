'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarEmpresa } = require('./helpers/entrega-epi');
const { todasAsMigrations, inserirPedido } = require('./helpers/recuperacao-senha');
const {
  servico: servicoRecuperacao, entrega, sinal, capturarEntrega, espiarConsole, aguardarEmEspera, segurarTravaConsultiva, sondarLinha, pausarEm,
} = require('./helpers/recuperacao-senha-servico');
const {
  SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, IP, DISPOSITIVO, MOTIVO, RESPOSTA,
  servicoGlobal, poolEspiaoDetalhado, comandosDa, exigirOrdem, travaConsultivaLivre, segurarTravaMfa, travaMfaLivre, despejo, fabricaPortal,
} = require('./helpers/troca-senha');
const { HttpError } = require('../../src/errors/HttpError');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const redefinicaoRepo = require('../../src/repositories/redefinicao-senha.repository');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const auditoriaIdentidadeRepo = require('../../src/repositories/auditoria-identidade.repository');
const loginGlobalService = require('../../src/services/login-global.service');
const contextoEmpresarialService = require('../../src/services/contexto-empresarial.service');
const cooldown = require('../../src/security/cooldown');
const password = require('../../src/security/password');
const token = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');

/**
 * Troca de senha autenticada do Portal (Bloco 11E) contra PostgreSQL real, com
 * todas as migrations num schema temporário. As sessões são as que o login
 * global e a seleção de empresa existentes criam, com token real. A entrega
 * do aviso é uma caixa em memória. Os cenários de concorrência usam conexões
 * distintas e só avançam depois de o próprio banco mostrar que a outra
 * conexão está esperando.
 */

const TABELA_PEDIDOS = { tabela: 'redefinicoes_senha', coluna: 'identidade_id' };
const FALHAS_DO_NIVEL_1 = authConfig.cooldown.niveis[0].falhas;

const erroDe = (status, codigo) => (erro) => erro instanceof HttpError && erro.status === status && erro.codigo === codigo;
const SESSAO_INVALIDA = erroDe(401, 'SESSAO_INVALIDA');
const SENHA_ATUAL_INVALIDA = (erro) => erroDe(401, 'SENHA_ATUAL_INVALIDA')(erro) && erro.message === 'Senha atual incorreta';
const EM_COOLDOWN = (erro) => erroDe(429, 'LOGIN_EM_COOLDOWN')(erro) && Number(erro.headers?.['Retry-After']) > 0;
const SENHA_IGUAL = erroDe(400, 'SENHA_IGUAL_A_ATUAL');
const CREDENCIAIS_INVALIDAS = erroDe(401, 'CREDENCIAIS_INVALIDAS');
const REDEFINICAO_INVALIDA = erroDe(400, 'REDEFINICAO_INVALIDA');
const VALIDACAO = (regra) => (erro) => erroDe(400, 'VALIDACAO')(erro) && erro.detalhes.some((d) => d.codigo === regra && d.campo === 'body.novaSenha');

describe('troca de senha do Portal — service com PostgreSQL real', () => {
  let contexto;
  let pool;
  let hashAtual;
  let f;
  const empresas = [];

  /** Identidade com vínculo em duas empresas, uma sessão global (a atual) e, se pedido, a empresarial que nasce dela. */
  async function cenarioSimples({ comEmpresarial = true } = {}) {
    const identidade = await f.novaIdentidade();
    const usuarioA = await f.vincular(identidade, empresas[0]);
    const usuarioB = await f.vincular(identidade, empresas[1]);
    const global = await f.entrar(identidade);
    const empresarial = comEmpresarial ? await f.selecionar(identidade, global, empresas[0]) : null;
    return { identidade, usuarioA, usuarioB, global, empresarial };
  }

  /**
   * Tudo o que uma identidade pode ter aberto: a sessão atual (g1 e e1), outro
   * dispositivo com empresa (g2 e e2, em outra empresa), outro dispositivo sem
   * empresa (g3), uma empresarial sem sessão global de origem (e3) e, ao lado,
   * as sessões de outra pessoa (gv e ev).
   */
  async function cenarioCompleto() {
    const c = await cenarioSimples();
    const g2 = await f.entrar(c.identidade);
    const e2 = await f.selecionar(c.identidade, g2, empresas[1]);
    const g3 = await f.entrar(c.identidade);
    const e3 = await f.empresarialSemGlobal(c.usuarioA, empresas[0]);
    const vizinha = await f.novaIdentidade();
    await f.vincular(vizinha, empresas[0]);
    const gv = await f.entrar(vizinha);
    const ev = await f.selecionar(vizinha, gv, empresas[0]);
    return { ...c, g1: c.global, e1: c.empresarial, g2, e2, g3, e3, vizinha, gv, ev };
  }

  const trocar = (c, sobrescrever = {}, executor = pool) => servicoGlobal().trocar(executor, {
    identidadeId: c.identidade.id,
    sessaoGlobalId: c.global.id,
    tokenSessaoGlobal: c.global.token,
    tokenSessaoEmpresarial: c.empresarial?.token ?? null,
    senhaAtual: SENHA_ATUAL,
    novaSenha: SENHA_NOVA,
    ip: IP,
    dispositivo: DISPOSITIVO,
    ...sobrescrever,
  });

  async function fotografia(c) {
    const id = c.identidade.id;
    return {
      hash: await f.hashDaSenha(id),
      tentativas: (await f.tentativasDe(id)).length,
      auditoria: (await f.auditoriaDe(id)).length,
      globais: await f.globaisNaoRevogadasDe(id),
      totalDeSessoes: await f.totalDeSessoes(),
    };
  }

  const falhasDe = async (identidadeId) => (await f.tentativasDe(identidadeId)).filter((t) => !t.sucesso && t.motivo !== 'COOLDOWN_ATIVADO');
  const ativacoesDe = async (identidadeId) => (await f.tentativasDe(identidadeId)).filter((t) => t.motivo === 'COOLDOWN_ATIVADO');

  async function erraAteOLimite(c, vezes, tentativa) {
    for (let i = 0; i < vezes; i += 1) await assert.rejects(() => tentativa(i), (erro) => SENHA_ATUAL_INVALIDA(erro) || CREDENCIAIS_INVALIDAS(erro));
  }

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha(SENHA_ATUAL);
    f = fabricaPortal({ pool, hashSenha: hashAtual });
    empresas.push(await criarEmpresa(pool, '11222333000181', 'Empresa Alfa'));
    empresas.push(await criarEmpresa(pool, '44555666000162', 'Empresa Beta'));
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('controle das fixtures', () => {
    test('a identidade de teste autentica pelo login global existente, e os tokens das sessões são os reais: resolvem a própria sessão', async () => {
      const c = await cenarioSimples();
      assert.equal(await f.globalVale(c.global), true);
      assert.equal(await f.empresarialVale(c.empresarial), true);
      const linha = await f.um('SELECT sessao_global_id FROM sessoes WHERE id = $1', [c.empresarial.id]);
      assert.equal(linha.sessao_global_id, c.global.id, 'a empresarial nasce da sessão global');
      assert.equal(await password.verificarSenha(await f.hashDaSenha(c.identidade.id), SENHA_ATUAL), true);
    });

    test('o cenário completo tem sessões ativas de várias origens e de outra pessoa, e a empresarial sem global não aponta para nenhuma', async () => {
      const c = await cenarioCompleto();
      for (const sessao of [c.g1, c.g2, c.g3, c.gv]) assert.equal(await f.globalVale(sessao), true);
      for (const sessao of [c.e1, c.e2, c.e3, c.ev]) assert.equal(await f.empresarialVale(sessao), true);
      assert.equal((await f.um('SELECT sessao_global_id FROM sessoes WHERE id = $1', [c.e3.id])).sessao_global_id, null);
      assert.equal((await f.um('SELECT sessao_global_id FROM sessoes WHERE id = $1', [c.e2.id])).sessao_global_id, c.g2.id);
      assert.notEqual(c.vizinha.id, c.identidade.id);
    });

    test('as sondas e o espião de pool enxergam as travas e guardam comando e parâmetros', async () => {
      const identidade = await f.novaIdentidade();
      const chave64 = cooldown.derivarAdvisoryLock64(identidade.chaveLogin);
      assert.equal(await travaConsultivaLivre(pool, chave64), true);
      const trava = await segurarTravaConsultiva(pool, chave64);
      try {
        assert.equal(await travaConsultivaLivre(pool, chave64), false);
      } finally {
        await trava.soltar();
      }
      assert.equal(await travaConsultivaLivre(pool, chave64), true);

      assert.equal(await travaMfaLivre(pool, identidade.id), true);
      const travaMfa = await segurarTravaMfa(pool, identidade.id);
      try {
        assert.equal(await travaMfaLivre(pool, identidade.id), false);
      } finally {
        await travaMfa.soltar();
      }

      const espiao = poolEspiaoDetalhado(pool);
      const cliente = await espiao.connect();
      await cliente.query('SELECT $1::int AS n', [7]);
      cliente.release();
      assert.deepEqual(comandosDa(espiao, espiao.pids[0]).map((x) => [x.texto, x.parametros]), [['SELECT $1::int AS n', [7]]]);
    });

    test('a caixa de entrega capta o aviso e as senhas de teste passam na política', async (t) => {
      const caixa = capturarEntrega(t);
      assert.deepEqual(caixa.avisos, []);
      const politica = require('../../src/security/password-policy'); // eslint-disable-line global-require
      for (const senha of [SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA]) assert.equal(politica.validarPoliticaSenha(senha, { email: 'x@example.invalid' }).ok, true, senha);
    });
  });

  describe('sucesso: sessões', () => {
    test('preserva a sessão global atual e a empresarial atual; revoga todas as outras, em todas as empresas; não cria nada; a senha nova vale', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioCompleto();
      const totalAntes = await f.totalDeSessoes();

      assert.deepEqual(await trocar(c), RESPOSTA);

      assert.equal(await f.globalVale(c.g1), true, 'a sessão global atual segue válida');
      assert.equal(await f.empresarialVale(c.e1), true, 'a empresarial atual segue válida');
      assert.deepEqual(await f.motivosGlobais([c.g1.id, c.g2.id, c.g3.id]), [null, MOTIVO, MOTIVO]);
      assert.deepEqual(await f.motivosEmpresariais([c.e1.id, c.e2.id, c.e3.id]), [null, MOTIVO, MOTIVO], 'inclusive a de outra empresa e a sem sessão global');
      assert.deepEqual(await f.motivosGlobais([c.gv.id]), [null], 'outra pessoa intocada');
      assert.deepEqual(await f.motivosEmpresariais([c.ev.id]), [null]);
      assert.equal(await f.hashDaSenha(c.vizinha.id), hashAtual);
      assert.equal(await f.totalDeSessoes(), totalAntes, 'nenhuma sessão nova');

      const hashNovo = await f.hashDaSenha(c.identidade.id);
      assert.notEqual(hashNovo, hashAtual);
      assert.equal(await password.verificarSenha(hashNovo, SENHA_NOVA), true);
      assert.equal(await password.verificarSenha(hashNovo, SENHA_ATUAL), false);
      assert.equal(caixa.avisos.length, 1);
    });

    test('depois da troca, o login com a senha antiga falha, o com a nova funciona e a sessão preservada continua servindo para outra troca', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();
      await trocar(c);
      await assert.rejects(() => f.entrar(c.identidade, { senhaDeEntrada: SENHA_ATUAL }), CREDENCIAIS_INVALIDAS);
      assert.equal((await f.entrar(c.identidade, { senhaDeEntrada: SENHA_NOVA })).id !== undefined, true);
      assert.deepEqual(await trocar(c, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), RESPOSTA, 'a mesma sessão global e a mesma empresarial seguem valendo');
    });

    test('o cookie empresarial de outra identidade não é preservado e a sessão dela não é tocada; as da própria identidade caem, menos a global atual', async (t) => {
      capturarEntrega(t);
      const c = await cenarioCompleto();

      assert.deepEqual(await trocar(c, { tokenSessaoEmpresarial: c.ev.token }), RESPOSTA);

      assert.equal(await f.globalVale(c.g1), true);
      assert.deepEqual(await f.motivosEmpresariais([c.e1.id, c.e2.id, c.e3.id]), [MOTIVO, MOTIVO, MOTIVO], 'nada foi preservado: o cookie empresarial recebido não era desta identidade');
      assert.equal(await f.empresarialVale(c.ev), true, 'a sessão de outra identidade nunca é revogada por esta troca');
      assert.equal(await f.globalVale(c.gv), true);
      assert.equal(await f.hashDaSenha(c.vizinha.id), hashAtual);
    });

    test('a empresarial da mesma identidade que nasceu de OUTRA sessão global não é "a atual" e cai com ela', async (t) => {
      capturarEntrega(t);
      const c = await cenarioCompleto();
      await trocar(c, { tokenSessaoEmpresarial: c.e2.token });
      assert.equal(await f.globalVale(c.g1), true);
      assert.deepEqual(await f.motivosEmpresariais([c.e1.id, c.e2.id, c.e3.id]), [MOTIVO, MOTIVO, MOTIVO]);
      assert.deepEqual(await f.motivosGlobais([c.g2.id]), [MOTIVO]);
    });

    test('a empresarial sem sessão global de origem não é preservada, mesmo sendo da mesma identidade', async (t) => {
      capturarEntrega(t);
      const c = await cenarioCompleto();
      await trocar(c, { tokenSessaoEmpresarial: c.e3.token });
      assert.deepEqual(await f.motivosEmpresariais([c.e1.id, c.e2.id, c.e3.id]), [MOTIVO, MOTIVO, MOTIVO]);
    });

    test('cookie empresarial ausente, malformado, desconhecido, revogado ou expirado: só a sessão global atual fica', async (t) => {
      capturarEntrega(t);
      const casos = [
        ['ausente', async () => null],
        ['malformado', async () => 'formato-invalido'],
        ['de tamanho certo mas desconhecido', async () => token.gerarTokenSessao()],
        ['revogado', async (c) => { await pool.query("UPDATE sessoes SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [c.empresarial.id]); return c.empresarial.token; }],
        ['expirado', async (c) => { await pool.query("UPDATE sessoes SET criado_em = now() - interval '2 minutes', expira_em = now() - interval '1 minute' WHERE id = $1", [c.empresarial.id]); return c.empresarial.token; }],
      ];
      for (const [nome, preparar] of casos) {
        const c = await cenarioSimples();
        const outra = await f.entrar(c.identidade);
        const tokenEmpresarial = await preparar(c);

        assert.deepEqual(await trocar(c, { tokenSessaoEmpresarial: tokenEmpresarial }), RESPOSTA, nome);

        assert.equal(await f.globalVale(c.global), true, nome);
        assert.deepEqual(await f.motivosGlobais([outra.id]), [MOTIVO], nome);
        assert.equal(await f.empresarialVale(c.empresarial), false, `${nome}: nenhuma empresarial segue válida`);
        const linha = await f.um('SELECT revogada_em FROM sessoes WHERE id = $1', [c.empresarial.id]);
        assert.notEqual(linha.revogada_em, null, `${nome}: revogada`);
      }
    });

    test('sem sessão empresarial alguma: a global atual fica e as demais caem', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples({ comEmpresarial: false });
      const outra = await f.entrar(c.identidade);
      assert.deepEqual(await trocar(c), RESPOSTA);
      assert.equal(await f.globalVale(c.global), true);
      assert.deepEqual(await f.motivosGlobais([outra.id]), [MOTIVO]);
    });
  });

  describe('senha atual e o cooldown do login global', () => {
    test('senha atual errada: 401 próprio, uma falha na tentativa do login global pela chave do login, e nada muda', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioCompleto();
      const antes = await fotografia(c);

      await assert.rejects(() => trocar(c, { senhaAtual: 'senha-errada-qualquer-99' }), SENHA_ATUAL_INVALIDA);

      const depois = await fotografia(c);
      assert.deepEqual({ ...depois, tentativas: undefined }, { ...antes, tentativas: undefined }, 'senha, sessões e auditoria intactas');
      assert.equal(depois.tentativas, antes.tentativas + 1);
      const [falha, ...resto] = await falhasDe(c.identidade.id);
      assert.deepEqual(resto, []);
      assert.deepEqual([falha.chave_cooldown, falha.motivo, falha.ip, falha.dispositivo, falha.cooldown_ate], [c.identidade.chaveLogin, 'SENHA_ATUAL_INVALIDA', IP, DISPOSITIVO, null]);
      for (const sessao of [c.g1, c.g2, c.g3]) assert.equal(await f.globalVale(sessao), true);
      assert.deepEqual(caixa.avisos, []);
    });

    test('o limite do login vale: no número de falhas do primeiro nível o cooldown é ativado, e a tentativa seguinte, mesmo certa, recebe 429 sem verificar a senha nem gravar linha', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();
      await erraAteOLimite(c, FALHAS_DO_NIVEL_1, (i) => trocar(c, { senhaAtual: `errada-${i}-qualquer` }));

      const ativacoes = await ativacoesDe(c.identidade.id);
      assert.equal(ativacoes.length, 1);
      assert.equal(ativacoes[0].chave_cooldown, c.identidade.chaveLogin);
      assert.ok(ativacoes[0].cooldown_ate.getTime() > Date.now());

      const linhasAntes = (await f.tentativasDe(c.identidade.id)).length;
      const hashAntes = await f.hashDaSenha(c.identidade.id);
      const verificar = t.mock.method(password, 'verificarSenha');
      await assert.rejects(() => trocar(c), EM_COOLDOWN);
      assert.equal(verificar.mock.calls.length, 0, 'durante o cooldown nenhuma senha é verificada');
      assert.equal((await f.tentativasDe(c.identidade.id)).length, linhasAntes, 'durante o cooldown nenhuma linha nova');
      assert.equal(await f.hashDaSenha(c.identidade.id), hashAntes);
    });

    test('é o MESMO domínio do login: falhas de login bloqueiam a troca, falhas da troca bloqueiam o login, e as duas se somam na mesma chave', async (t) => {
      capturarEntrega(t);
      const porLogin = await cenarioSimples();
      await erraAteOLimite(porLogin, FALHAS_DO_NIVEL_1, (i) => f.entrar(porLogin.identidade, { senhaDeEntrada: `errada-${i}-qualquer` }));
      await assert.rejects(() => trocar(porLogin), EM_COOLDOWN);

      const porTroca = await cenarioSimples();
      await erraAteOLimite(porTroca, FALHAS_DO_NIVEL_1, (i) => trocar(porTroca, { senhaAtual: `errada-${i}-qualquer` }));
      await assert.rejects(() => f.entrar(porTroca.identidade), EM_COOLDOWN);

      const misto = await cenarioSimples();
      const doLogin = Math.floor(FALHAS_DO_NIVEL_1 / 2);
      await erraAteOLimite(misto, doLogin, (i) => f.entrar(misto.identidade, { senhaDeEntrada: `errada-${i}-qualquer` }));
      await erraAteOLimite(misto, FALHAS_DO_NIVEL_1 - doLogin, (i) => trocar(misto, { senhaAtual: `errada-${i}-qualquer` }));
      await assert.rejects(() => trocar(misto), EM_COOLDOWN);
      await assert.rejects(() => f.entrar(misto.identidade), EM_COOLDOWN);

      for (const cenario of [porLogin, porTroca, misto]) {
        assert.deepEqual(await f.chavesDeTentativa(cenario.identidade.id), [cenario.identidade.chaveLogin], 'um único contador, o do login');
      }
    });

    test('um sucesso zera a contagem, como no login: depois dele o cooldown só vem com o limite inteiro de novo', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();
      const quase = FALHAS_DO_NIVEL_1 - 1;
      await erraAteOLimite(c, quase, (i) => trocar(c, { senhaAtual: `errada-${i}-qualquer` }));
      assert.deepEqual(await trocar(c), RESPOSTA);

      await erraAteOLimite(c, quase, (i) => trocar(c, { senhaAtual: `${SENHA_ATUAL}-${i}`, novaSenha: OUTRA_SENHA }));
      assert.deepEqual(await ativacoesDe(c.identidade.id), [], 'a contagem recomeçou no sucesso');
      assert.deepEqual(await trocar(c, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), RESPOSTA);
    });

    test('a senha atual vem antes da política: com a atual errada, nada da política da nova é revelado', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();
      await assert.rejects(() => trocar(c, { senhaAtual: 'senha-errada-qualquer-99', novaSenha: 'Zx9!kq' }), SENHA_ATUAL_INVALIDA);
      await assert.rejects(() => trocar(c, { senhaAtual: 'senha-errada-qualquer-99', novaSenha: SENHA_ATUAL }), SENHA_ATUAL_INVALIDA);
    });
  });

  describe('nova senha', () => {
    test('fora da política: validação com a regra violada, sem contar no cooldown, sem mexer em nada', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioCompleto();
      const antes = await fotografia(c);
      await assert.rejects(() => trocar(c, { novaSenha: 'Zx9!kq' }), VALIDACAO('SENHA_CURTA'));
      await assert.rejects(() => trocar(c, { novaSenha: `${c.identidade.email}-2026` }), VALIDACAO('SENHA_CONTEM_EMAIL'));
      assert.deepEqual(await fotografia(c), antes);
      assert.deepEqual(await falhasDe(c.identidade.id), []);
      assert.deepEqual(caixa.avisos, []);
    });

    test('igual à atual: SENHA_IGUAL_A_ATUAL, sem contar no cooldown, sem mexer em nada', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioCompleto();
      const antes = await fotografia(c);
      await assert.rejects(() => trocar(c, { novaSenha: SENHA_ATUAL }), SENHA_IGUAL);
      assert.deepEqual(await fotografia(c), antes);
      assert.deepEqual(await falhasDe(c.identidade.id), []);
      assert.deepEqual(caixa.avisos, []);
    });

    test('igual à atual também quando só muda a forma de normalização do texto', async (t) => {
      capturarEntrega(t);
      const composta = 'girassol-ação-quartzo-58';
      const decomposta = composta.normalize('NFD');
      assert.notEqual(composta, decomposta);
      const identidade = await f.novaIdentidade();
      await pool.query('UPDATE identidades SET senha_hash = $2 WHERE id = $1', [identidade.id, await password.gerarHashSenha(composta)]);
      await f.vincular(identidade, empresas[0]);
      const global = await f.entrar(identidade, { senhaDeEntrada: composta });

      await assert.rejects(() => trocar({ identidade, global, empresarial: null }, { senhaAtual: composta, novaSenha: decomposta }), SENHA_IGUAL);
    });
  });

  describe('revalidação dentro da transação', () => {
    test('sessão que já não vale, token de outra pessoa, sessão que não é a do token e token malformado: 401 SESSAO_INVALIDA e nada muda, nem contagem de falha', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioCompleto();
      const revogada = await cenarioSimples();
      await pool.query("UPDATE sessoes_globais SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [revogada.global.id]);
      const antes = await fotografia(c);

      const casos = [
        ['sessão global revogada', () => trocar(revogada)],
        ['token de outra pessoa', () => trocar(c, { tokenSessaoGlobal: c.gv.token })],
        ['id de sessão que não é a do token', () => trocar(c, { sessaoGlobalId: c.g2.id })],
        ['identidade que não é a da sessão', () => trocar(c, { identidadeId: c.vizinha.id })],
        ['token malformado', () => trocar(c, { tokenSessaoGlobal: 'abc' })],
        ['token ausente', () => trocar(c, { tokenSessaoGlobal: null })],
      ];
      for (const [nome, chamar] of casos) await assert.rejects(chamar, SESSAO_INVALIDA, nome);

      assert.deepEqual(await fotografia(c), antes);
      assert.equal(await f.hashDaSenha(revogada.identidade.id), hashAtual);
      assert.deepEqual(await falhasDe(c.identidade.id), []);
      assert.deepEqual(caixa.avisos, []);
    });

    test('conta inativada depois de a transação abrir e antes de a linha ser travada: a troca recusa sem mudar nada', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioSimples();
      const pausa = pausarEm(t, identidadeRepo, 'buscarPorIdParaAtualizacao');
      const emAndamento = trocar(c);
      try {
        await pausa.chegou;
        await pool.query('UPDATE identidades SET ativo = false WHERE id = $1', [c.identidade.id]);
      } finally {
        pausa.liberar();
      }
      await assert.rejects(() => emAndamento, SESSAO_INVALIDA);
      assert.equal(await f.hashDaSenha(c.identidade.id), hashAtual);
      assert.deepEqual(caixa.avisos, []);
    });

    test('sessão global revogada entre a primeira leitura e a trava da sessão: a troca recusa sem mudar nada', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioSimples();
      const pausa = pausarEm(t, sessaoGlobalRepo, 'bloquearValida');
      const emAndamento = trocar(c);
      try {
        await pausa.chegou;
        await pool.query("UPDATE sessoes_globais SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [c.global.id]);
      } finally {
        pausa.liberar();
      }
      await assert.rejects(() => emAndamento, SESSAO_INVALIDA);
      assert.equal(await f.hashDaSenha(c.identidade.id), hashAtual);
      assert.deepEqual(await falhasDe(c.identidade.id), []);
      assert.deepEqual(caixa.avisos, []);
    });
  });

  describe('links de redefinição pendentes', () => {
    test('o pedido pendente é cancelado com motivo próprio na mesma transação, o token dele deixa de valer e os pedidos já usados ou cancelados ficam como estavam', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioCompleto();
      // O banco só deixa o pedido nascer pendente: os dois já fechados são criados e depois fechados, um de cada vez (um pendente por identidade).
      const usado = await inserirPedido(pool, TABELA_PEDIDOS, c.identidade.id, { criadoHaMinutos: 30 });
      await pool.query('UPDATE redefinicoes_senha SET usado_em = clock_timestamp() WHERE id = $1', [usado.id]);
      const cancelado = await inserirPedido(pool, TABELA_PEDIDOS, c.identidade.id, { criadoHaMinutos: 20 });
      await pool.query("UPDATE redefinicoes_senha SET cancelado_em = clock_timestamp(), motivo_cancelamento = 'SUBSTITUIDA' WHERE id = $1", [cancelado.id]);
      await servicoRecuperacao().solicitar(pool, { escopo: 'PORTAL', email: c.identidade.email, ip: IP, dispositivo: DISPOSITIVO });
      const tokenDoLink = caixa.redefinicoes.at(-1).token;
      const pedidoPendente = (await f.pedidosDe(c.identidade.id)).find((p) => p.usado_em === null && p.cancelado_em === null);
      assert.ok(pedidoPendente, 'pré-condição: um pedido pendente');
      const antes = await f.pedidosDe(c.identidade.id);

      await trocar(c);

      const depois = await f.pedidosDe(c.identidade.id);
      for (const intocado of [usado.id, cancelado.id]) {
        assert.deepEqual(depois.find((p) => p.id === intocado), antes.find((p) => p.id === intocado), 'pedido já fechado não muda');
      }
      const cancelamento = depois.find((p) => p.id === pedidoPendente.id);
      assert.ok(cancelamento.cancelado_em instanceof Date);
      assert.equal(cancelamento.motivo_cancelamento, MOTIVO);
      assert.equal(cancelamento.usado_em, null);

      await assert.rejects(
        () => servicoRecuperacao().redefinir(pool, { escopo: 'PORTAL', token: tokenDoLink, novaSenha: OUTRA_SENHA, ip: IP, dispositivo: DISPOSITIVO }),
        REDEFINICAO_INVALIDA,
      );
      assert.equal(await password.verificarSenha(await f.hashDaSenha(c.identidade.id), SENHA_NOVA), true, 'a senha continua a da troca');
    });

    test('sem pedido pendente a troca segue normalmente e o contador de pedidos cancelados é zero', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();
      await trocar(c);
      const evento = (await f.auditoriaDe(c.identidade.id)).find((e) => e.acao === 'SENHA_ALTERADA');
      assert.equal(evento.contexto.pedidosCancelados, 0);
    });
  });

  describe('auditoria', () => {
    test('uma linha SENHA_ALTERADA com ator IDENTIDADE, origem da requisição e só contagens e indicadores no contexto', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioCompleto();
      await servicoRecuperacao().solicitar(pool, { escopo: 'PORTAL', email: c.identidade.email, ip: IP, dispositivo: DISPOSITIVO });
      assert.equal(caixa.redefinicoes.length, 1);

      await trocar(c);

      const eventos = (await f.auditoriaDe(c.identidade.id)).filter((e) => e.acao === 'SENHA_ALTERADA');
      assert.equal(eventos.length, 1);
      const [evento] = eventos;
      assert.deepEqual([evento.ator_tipo, evento.identidade_id, evento.ip, evento.dispositivo], ['IDENTIDADE', c.identidade.id, IP, DISPOSITIVO]);
      assert.deepEqual(evento.contexto, {
        origem: 'TROCA_AUTENTICADA', sessoesGlobaisRevogadas: 2, sessoesEmpresariaisRevogadas: 2, pedidosCancelados: 1, sessaoEmpresarialPreservada: true,
      });
      assert.equal((await f.auditoriaDe(c.identidade.id)).some((e) => e.acao === 'SENHA_ALTERADA' && e.ator_tipo !== 'IDENTIDADE'), false, 'nunca como SISTEMA');
    });

    test('sem empresarial preservada o indicador diz false, e as recusas não deixam linha na trilha', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();
      await assert.rejects(() => trocar(c, { senhaAtual: 'errada-qualquer-12345' }), SENHA_ATUAL_INVALIDA);
      await assert.rejects(() => trocar(c, { novaSenha: 'Zx9!kq' }), VALIDACAO('SENHA_CURTA'));
      await assert.rejects(() => trocar(c, { novaSenha: SENHA_ATUAL }), SENHA_IGUAL);
      assert.deepEqual(await f.auditoriaDe(c.identidade.id), [], 'nenhuma recusa vira linha da trilha de auditoria');

      await trocar(c, { tokenSessaoEmpresarial: null });
      const [evento, ...resto] = await f.auditoriaDe(c.identidade.id);
      assert.deepEqual(resto, []);
      assert.equal(evento.contexto.sessaoEmpresarialPreservada, false);
    });
  });

  describe('aviso de senha alterada', () => {
    test('só depois do COMMIT, com uma única conexão e uma única transação, e com a variante da troca', async (t) => {
      const espiao = poolEspiaoDetalhado(pool);
      const noInstante = [];
      const visiveis = [];
      const c = await cenarioCompleto();
      const caixa = capturarEntrega(t, {
        aoEnfileirar: (tipo) => {
          if (tipo !== 'AVISO') return;
          // Fotografia síncrona do que já concluiu na conexão da troca, tirada dentro da própria chamada do aviso.
          noInstante.push(comandosDa(espiao, espiao.pids[0]).map((x) => x.texto));
          visiveis.push(pool.query('SELECT senha_hash FROM identidades WHERE id = $1', [c.identidade.id]));
        },
      });

      assert.deepEqual(await trocar(c, {}, espiao), RESPOSTA);

      assert.equal(espiao.pids.length, 1, 'uma única conexão: a troca é uma transação só');
      assert.equal(noInstante.length, 1, 'um aviso enfileirado');
      const [concluidos] = noInstante;
      assert.equal(concluidos[0], 'BEGIN');
      assert.equal(concluidos.at(-1), 'COMMIT', 'no instante do aviso o último comando concluído é o COMMIT');
      assert.deepEqual(concluidos.filter((x) => x === 'BEGIN' || x === 'COMMIT' || x === 'ROLLBACK'), ['BEGIN', 'COMMIT']);
      assert.equal(concluidos.some((x) => /UPDATE identidades\s+SET senha_hash/.test(x)), true, 'a troca foi gravada nessa mesma transação');
      assert.deepEqual(caixa.avisos, [{ escopo: 'PORTAL', email: c.identidade.email, origem: 'TROCA' }]);
      const hashNovo = await f.hashDaSenha(c.identidade.id);
      assert.deepEqual((await Promise.all(visiveis)).map((r) => r.rows[0].senha_hash), [hashNovo], 'no instante do aviso a troca já estava confirmada');
    });

    test('nenhuma recusa enfileira aviso', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioSimples();
      await assert.rejects(() => trocar(c, { senhaAtual: 'errada-qualquer-12345' }), SENHA_ATUAL_INVALIDA);
      await assert.rejects(() => trocar(c, { novaSenha: 'Zx9!kq' }), VALIDACAO('SENHA_CURTA'));
      await assert.rejects(() => trocar(c, { novaSenha: SENHA_ATUAL }), SENHA_IGUAL);
      await assert.rejects(() => trocar(c, { tokenSessaoGlobal: 'abc' }), SESSAO_INVALIDA);
      await erraAteOLimite(c, FALHAS_DO_NIVEL_1 - 1, (i) => trocar(c, { senhaAtual: `errada-${i}-qualquer` }));
      await assert.rejects(() => trocar(c), EM_COOLDOWN);
      assert.deepEqual(caixa.avisos, []);
    });

    test('falha de entrega, síncrona ou por promessa rejeitada: a troca já confirmada continua, a resposta é a mesma e nada sensível vai ao console', async (t) => {
      const linhas = espiarConsole(t);
      const rejeicoes = [];
      const ouvinte = (motivo) => { rejeicoes.push(motivo); };
      process.on('unhandledRejection', ouvinte);
      try {
        const c = await cenarioCompleto();
        const sensivel = `falha simulada com ${c.identidade.email}, ${SENHA_NOVA}, ${SENHA_ATUAL} e ${c.g1.token}`;
        let modo = 'sincrona';
        t.mock.method(entrega(), 'enfileirarAvisoSenhaAlterada', () => {
          if (modo === 'sincrona') throw new Error(sensivel);
          return Promise.reject(new Error(sensivel));
        });

        assert.deepEqual(await trocar(c), RESPOSTA);
        assert.equal(await password.verificarSenha(await f.hashDaSenha(c.identidade.id), SENHA_NOVA), true, 'a troca não foi desfeita');
        assert.deepEqual(await f.motivosGlobais([c.g1.id, c.g2.id]), [null, MOTIVO], 'as revogações também não');

        modo = 'promessa';
        assert.deepEqual(await trocar(c, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), RESPOSTA);
        for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve); });

        assert.deepEqual(rejeicoes, [], 'nenhuma promessa rejeitada sem tratamento');
        const texto = linhas.map((l) => l.texto).join('\n');
        for (const valor of [c.identidade.email, 'example.invalid', SENHA_NOVA, SENHA_ATUAL, OUTRA_SENHA, c.g1.token, 'falha simulada']) {
          assert.equal(texto.includes(valor), false, `console contém ${valor.slice(0, 8)}…`);
        }
      } finally {
        process.off('unhandledRejection', ouvinte);
      }
    });
  });

  describe('ordem das travas e serialização', () => {
    test('a ordem é a do login: trava consultiva da chave de login, linha da conta, linha da sessão global atual, e só então as escritas, com as globais antes das empresariais', async (t) => {
      capturarEntrega(t);
      const c = await cenarioCompleto();
      const espiao = poolEspiaoDetalhado(pool);
      assert.deepEqual(await trocar(c, {}, espiao), RESPOSTA);

      assert.equal(espiao.pids.length, 1);
      const comandos = comandosDa(espiao, espiao.pids[0]);
      assert.equal(comandos.filter((x) => /pg_advisory/.test(x.texto)).length, 1, 'uma única trava consultiva');

      // As travas, nesta ordem: a consultiva da chave de login, a linha da conta e a linha da sessão global atual.
      const [, indiceConsultiva, , indiceSessao] = exigirOrdem(comandos, [
        /^BEGIN$/,
        /pg_advisory_xact_lock\(\$1::bigint\)/,
        /FROM identidades[\s\S]*FOR UPDATE/,
        /FROM sessoes_globais[\s\S]*FOR UPDATE/,
      ], 'travas da troca do Portal');

      // Toda escrita vem depois das travas; a auditoria entra antes do COMMIT, que fecha a transação.
      const ESCRITAS = {
        senha: /UPDATE identidades\s+SET senha_hash/,
        pedidos: /UPDATE redefinicoes_senha\b/,
        globais: /UPDATE sessoes_globais\s+SET revogada_em/,
        empresariais: /UPDATE sessoes s\s+SET revogada_em/,
        auditoria: /INSERT INTO logs_auditoria_identidade/,
      };
      const onde = {};
      for (const [nome, padrao] of Object.entries(ESCRITAS)) {
        onde[nome] = comandos.findIndex((x) => padrao.test(x.texto));
        assert.ok(onde[nome] > indiceSessao, `${nome}: escrita depois de todas as travas`);
      }
      assert.ok(onde.globais < onde.empresariais, 'as globais são revogadas antes das empresariais');
      assert.equal(comandos.at(-1).texto, 'COMMIT');
      assert.ok(onde.auditoria < comandos.length - 1, 'a auditoria entra antes do COMMIT');
      assert.deepEqual(comandos.filter((x) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(x.texto)).map((x) => x.texto), ['BEGIN', 'COMMIT']);

      // A chave é exatamente a que o login da mesma conta usa.
      const espiaoLogin = poolEspiaoDetalhado(pool);
      await loginGlobalService.autenticar(espiaoLogin, { email: c.identidade.email, senha: SENHA_NOVA });
      const doLogin = comandosDa(espiaoLogin, espiaoLogin.pids[0]).find((x) => /pg_advisory_xact_lock\(\$1::bigint\)/.test(x.texto));
      assert.equal(String(comandos[indiceConsultiva].parametros[0]), String(doLogin.parametros[0]));
      assert.equal(String(comandos[indiceConsultiva].parametros[0]), String(cooldown.derivarAdvisoryLock64(c.identidade.chaveLogin)));
    });

    test('com a chave de login ocupada (um login em andamento), a troca espera antes de qualquer linha e nada é gravado', async (t) => {
      capturarEntrega(t);
      const c = await cenarioCompleto();
      const espiao = poolEspiaoDetalhado(pool);
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(c.identidade.chaveLogin));
      let emAndamento;
      try {
        emAndamento = trocar(c, {}, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await f.hashDaSenha(c.identidade.id), hashAtual);
        assert.equal(await sondarLinha(pool, 'identidades', c.identidade.id), 'LIVRE', 'a trava consultiva vem antes da linha da conta');
        assert.equal(await sondarLinha(pool, 'sessoes_globais', c.g1.id), 'LIVRE');
        assert.equal(comandosDa(espiao, espiao.pids[0]).some((x) => /FOR UPDATE|^UPDATE|^INSERT/.test(x.texto)), false, 'nenhuma escrita nem trava de linha antes da trava consultiva');
      } finally {
        await trava.soltar();
      }
      assert.deepEqual(await emAndamento, RESPOSTA);
    });

    test('a trava é por conta: a troca de outra identidade não espera por esta chave', async (t) => {
      capturarEntrega(t);
      const ocupada = await cenarioSimples();
      const livre = await cenarioSimples();
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(ocupada.identidade.chaveLogin));
      try {
        assert.deepEqual(await trocar(livre), RESPOSTA);
      } finally {
        await trava.soltar();
      }
    });

    test('um login real em andamento segura a troca, e a sessão que ele abre com a senha antiga é revogada em seguida', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();
      const espiao = poolEspiaoDetalhado(pool);

      // O login real para dentro da própria transação, já com a trava do e-mail, até o teste liberar.
      const original = password.verificarSenha;
      const chegou = sinal();
      const liberar = sinal();
      let primeira = true;
      t.mock.method(password, 'verificarSenha', async (...argumentos) => {
        if (primeira) {
          primeira = false;
          chegou.resolver();
          await liberar.promessa;
        }
        return original(...argumentos);
      });

      const login = loginGlobalService.autenticar(pool, { email: c.identidade.email, senha: SENHA_ATUAL });
      let troca;
      try {
        await chegou.promessa;
        troca = trocar(c, {}, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await f.hashDaSenha(c.identidade.id), hashAtual, 'a troca não avança enquanto o login não termina');
      } finally {
        liberar.resolver();
      }
      const { sessao } = await login;
      assert.deepEqual(await troca, RESPOSTA);
      assert.deepEqual(await f.motivosGlobais([sessao.id]), [MOTIVO], 'a sessão aberta com a senha antiga não sobrevive');
      assert.equal(await f.globalVale(c.global), true);
    });

    test('uma troca em andamento segura o login com a senha antiga: ele só roda depois do COMMIT, recebe senha inválida e não abre sessão', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();
      const pausa = pausarEm(t, auditoriaIdentidadeRepo, 'registrarDaIdentidade');
      const troca = trocar(c);
      const espiaoLogin = poolEspiaoDetalhado(pool);
      let login;
      try {
        await pausa.chegou;
        login = loginGlobalService.autenticar(espiaoLogin, { email: c.identidade.email, senha: SENHA_ATUAL });
        login.catch(() => {});
        await aguardarEmEspera(pool, espiaoLogin, 1, 'advisory');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await troca, RESPOSTA);
      await assert.rejects(() => login, CREDENCIAIS_INVALIDAS);
      assert.deepEqual(await f.globaisNaoRevogadasDe(c.identidade.id), [c.global.id], 'só a sessão atual vale');
      assert.equal((await f.entrar(c.identidade, { senhaDeEntrada: SENHA_NOVA })).id !== undefined, true);
    });

    test('reset público já em andamento (com a conta travada) segura a troca; ao terminar, a sessão da troca já foi revogada: 401 e a senha é a do reset', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioSimples();
      await servicoRecuperacao().solicitar(pool, { escopo: 'PORTAL', email: c.identidade.email, ip: IP, dispositivo: DISPOSITIVO });
      const tokenDoLink = caixa.redefinicoes.at(-1).token;
      const pausa = pausarEm(t, redefinicaoRepo, 'buscarPorHashParaAtualizacao');
      const reset = servicoRecuperacao().redefinir(pool, { escopo: 'PORTAL', token: tokenDoLink, novaSenha: OUTRA_SENHA, ip: IP, dispositivo: DISPOSITIVO });
      const espiao = poolEspiaoDetalhado(pool);
      let troca;
      try {
        await pausa.chegou;
        troca = trocar(c, {}, espiao);
        troca.catch(() => {});
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await reset, { status: 'SENHA_REDEFINIDA' });
      await assert.rejects(() => troca, SESSAO_INVALIDA);
      const hash = await f.hashDaSenha(c.identidade.id);
      assert.equal(await password.verificarSenha(hash, OUTRA_SENHA), true, 'a senha é a do reset');
      assert.equal(await password.verificarSenha(hash, SENHA_NOVA), false, 'a troca não foi aplicada');
    });

    test('troca já em andamento segura o reset público; ao terminar, o link foi cancelado pela troca e o reset recebe o erro genérico', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioSimples();
      await servicoRecuperacao().solicitar(pool, { escopo: 'PORTAL', email: c.identidade.email, ip: IP, dispositivo: DISPOSITIVO });
      const tokenDoLink = caixa.redefinicoes.at(-1).token;
      const pausa = pausarEm(t, auditoriaIdentidadeRepo, 'registrarDaIdentidade');
      const troca = trocar(c);
      const espiaoReset = poolEspiaoDetalhado(pool);
      let reset;
      try {
        await pausa.chegou;
        reset = servicoRecuperacao().redefinir(espiaoReset, { escopo: 'PORTAL', token: tokenDoLink, novaSenha: OUTRA_SENHA, ip: IP, dispositivo: DISPOSITIVO });
        reset.catch(() => {});
        await aguardarEmEspera(pool, espiaoReset, 1, 'advisory');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await troca, RESPOSTA);
      await assert.rejects(() => reset, REDEFINICAO_INVALIDA);
      assert.equal(await password.verificarSenha(await f.hashDaSenha(c.identidade.id), SENHA_NOVA), true, 'a senha é a da troca');
    });

    test('uma seleção de empresa em andamento, de outra sessão global da mesma pessoa, segura a troca; a sessão empresarial que ela cria é revogada em seguida', async (t) => {
      capturarEntrega(t);
      const c = await cenarioCompleto();
      const pausa = pausarEm(t, usuarioRepo, 'buscarVinculoAtivoDaIdentidade');
      const selecao = contextoEmpresarialService.selecionar(pool, {
        identidadeId: c.identidade.id, sessaoGlobalId: c.g2.id, empresaId: empresas[0], ip: IP, dispositivo: DISPOSITIVO,
      });
      selecao.catch(() => {});
      const espiao = poolEspiaoDetalhado(pool);
      let troca;
      try {
        await pausa.chegou;
        troca = trocar(c, {}, espiao);
        troca.catch(() => {});
        await aguardarEmEspera(pool, espiao, 1, 'transactionid');
      } finally {
        pausa.liberar();
      }
      const nova = await selecao;
      assert.deepEqual(await troca, RESPOSTA);
      assert.deepEqual(await f.motivosEmpresariais([nova.sessao.id]), [MOTIVO], 'revogar as globais antes das empresariais enxerga a sessão que a seleção acabou de criar');
      assert.equal(await f.globalVale(c.g1), true);
      assert.equal(await f.empresarialVale(c.e1), true);
    });

    test('logins reais simultâneos com a senha antiga e a troca: sem deadlock, e nenhuma sessão aberta com a senha antiga fica viva', async (t) => {
      capturarEntrega(t);
      const c = await cenarioSimples();

      const [troca, ...logins] = await Promise.allSettled([
        trocar(c),
        ...Array.from({ length: 4 }, () => loginGlobalService.autenticar(pool, { email: c.identidade.email, senha: SENHA_ATUAL })),
      ]);

      assert.equal(troca.status, 'fulfilled', String(troca.reason?.code ?? troca.reason?.message));
      for (const login of logins) {
        if (login.status === 'rejected') {
          assert.notEqual(login.reason?.code, '40P01', 'deadlock');
          assert.equal(CREDENCIAIS_INVALIDAS(login.reason), true, 'login depois da troca: senha antiga recusada');
        }
      }
      assert.deepEqual(await f.globaisNaoRevogadasDe(c.identidade.id), [c.global.id]);
      assert.equal(await password.verificarSenha(await f.hashDaSenha(c.identidade.id), SENHA_NOVA), true);
    });

    test('duas trocas simultâneas da mesma conta, por duas sessões: exatamente uma vence; a outra encontra a própria sessão já revogada', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenarioSimples();
      const outra = await f.entrar(c.identidade);

      const resultados = await Promise.allSettled([
        trocar(c, { novaSenha: SENHA_NOVA }),
        trocar({ identidade: c.identidade, global: outra, empresarial: null }, { novaSenha: OUTRA_SENHA }),
      ]);

      assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
      const perdedora = resultados.find((r) => r.status === 'rejected');
      assert.equal(SESSAO_INVALIDA(perdedora.reason), true, String(perdedora.reason?.message));
      assert.equal((await f.globaisNaoRevogadasDe(c.identidade.id)).length, 1, 'só a sessão da vencedora');
      const vencedora = resultados[0].status === 'fulfilled' ? SENHA_NOVA : OUTRA_SENHA;
      assert.equal(await password.verificarSenha(await f.hashDaSenha(c.identidade.id), vencedora), true);
      assert.equal(caixa.avisos.length, 1);
    });
  });

  describe('dados sensíveis', () => {
    test('nem a trilha de auditoria, nem as tentativas, nem os pedidos, nem o console guardam senha, hash, token de sessão, link ou e-mail', async (t) => {
      const caixa = capturarEntrega(t);
      const linhas = espiarConsole(t);
      const c = await cenarioCompleto();
      await servicoRecuperacao().solicitar(pool, { escopo: 'PORTAL', email: c.identidade.email, ip: IP, dispositivo: DISPOSITIVO });
      const tokenDoLink = caixa.redefinicoes.at(-1).token;
      const erradaDaVez = 'senha-errada-qualquer-12345';

      await assert.rejects(() => trocar(c, { senhaAtual: erradaDaVez }), SENHA_ATUAL_INVALIDA);
      await assert.rejects(() => trocar(c, { novaSenha: 'Zx9!kq' }), VALIDACAO('SENHA_CURTA'));
      await assert.rejects(() => trocar(c, { novaSenha: SENHA_ATUAL }), SENHA_IGUAL);
      await trocar(c);

      const hashNovo = await f.hashDaSenha(c.identidade.id);
      const id = c.identidade.id;
      const auditoria = await despejo(pool, 'logs_auditoria_identidade', 'identidade_id = $1', [id]);
      const tentativas = await despejo(pool, 'login_tentativas_globais', 'identidade_id = $1', [id]);
      const pedidos = await despejo(pool, 'redefinicoes_senha', 'identidade_id = $1', [id]);
      const tecnico = linhas.map((l) => l.texto).join('\n');
      assert.notEqual(auditoria, '');

      const tokensDeSessao = [c.g1, c.g2, c.g3, c.e1, c.e2, c.e3].map((s) => s.token);
      const segredos = [SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, erradaDaVez, tokenDoLink, '#token=', 'redefinir-senha.html', ...tokensDeSessao, ...tokensDeSessao.map((s) => token.hashTokenSessao(s))];
      const emails = [c.identidade.email, 'example.invalid'];
      for (const valor of [...segredos, ...emails, hashNovo, hashAtual]) {
        assert.equal(auditoria.includes(valor), false, `auditoria contém ${valor.slice(0, 8)}…`);
        assert.equal(tecnico.includes(valor), false, `console contém ${valor.slice(0, 8)}…`);
      }
      for (const valor of [...segredos, ...emails, hashNovo, hashAtual]) {
        assert.equal(tentativas.includes(valor), false, `tentativas contêm ${valor.slice(0, 8)}…`);
      }
      for (const valor of [...segredos, ...emails, hashNovo]) {
        assert.equal(pedidos.includes(valor), false, `pedidos contêm ${valor.slice(0, 8)}…`);
      }
    });
  });
});
