'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/recuperacao-senha');
const {
  servico: servicoRecuperacao, entrega, sinal, capturarEntrega, espiarConsole, aguardarEmEspera, segurarTravaConsultiva, sondarLinha, pausarEm,
} = require('./helpers/recuperacao-senha-servico');
const {
  SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, IP, DISPOSITIVO, MOTIVO, RESPOSTA,
  servicoPlataforma, poolEspiaoDetalhado, comandosDa, exigirOrdem, travaConsultivaLivre, travaMfaLivre, segurarTravaMfa, despejo, fabricaPainel,
} = require('./helpers/troca-senha');
const { HttpError } = require('../../src/errors/HttpError');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const redefinicaoPlataformaRepo = require('../../src/repositories/redefinicao-senha-plataforma.repository');
const auditoriaPlataformaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const { ESPACO_TRAVA_ADMINISTRADOR_MFA } = require('../../src/repositories/trava-mfa-plataforma.repository');
const loginPlataformaService = require('../../src/services/login-plataforma.service');
const substituicaoMfaService = require('../../src/services/substituicao-mfa-plataforma.service');
const totp = require('../../src/security/totp');
const cooldown = require('../../src/security/cooldown');
const password = require('../../src/security/password');
const token = require('../../src/security/token');
const codigosMfa = require('../../src/security/codigos-mfa');
const { authConfig } = require('../../src/config/auth');

/**
 * Troca de senha autenticada do Painel Privado (Bloco 11E) contra PostgreSQL
 * real. É um evento sensível com sessão plena: exige a senha atual e um TOTP
 * atual válido (nunca recovery code), pelo mesmo padrão de reautenticação e
 * pelo mesmo anti-replay dos eventos de MFA já existentes, e preserva só a
 * sessão atual. Fator, lote e códigos de recuperação não são tocados. Os
 * cenários de concorrência usam conexões distintas e só avançam depois de o
 * próprio banco mostrar que a outra conexão está esperando.
 */

const FALHAS_DO_NIVEL_1 = authConfig.cooldown.niveis[0].falhas;
const MENSAGEM_DA_REAUTENTICACAO = 'Senha ou código inválidos';

const erroDe = (status, codigo) => (erro) => erro instanceof HttpError && erro.status === status && erro.codigo === codigo;
const SESSAO_INVALIDA = erroDe(401, 'SESSAO_INVALIDA');
const REAUTENTICACAO_INVALIDA = (erro) => erroDe(401, 'REAUTENTICACAO_INVALIDA')(erro) && erro.message === MENSAGEM_DA_REAUTENTICACAO;
const MFA_EM_COOLDOWN = (erro) => erroDe(429, 'MFA_EM_COOLDOWN')(erro) && Number(erro.headers?.['Retry-After']) > 0;
const MFA_INDISPONIVEL = erroDe(503, 'MFA_INDISPONIVEL');
const SENHA_IGUAL = erroDe(400, 'SENHA_IGUAL_A_ATUAL');
const REDEFINICAO_INVALIDA = erroDe(400, 'REDEFINICAO_INVALIDA');
const VALIDACAO = (regra) => (erro) => erroDe(400, 'VALIDACAO')(erro) && erro.detalhes.some((d) => d.codigo === regra && d.campo === 'body.novaSenha');
const FALHA_DE_LOGIN = (erro) => erro instanceof HttpError && erro.status === 401;

describe('troca de senha do Painel Privado — service com PostgreSQL real', () => {
  let contexto;
  let pool;
  let hashAtual;
  let f;

  /** Administrador com TOTP ativo, recovery codes e a sessão plena que faz a troca. */
  async function cenario() {
    const admin = await f.novoAdministrador();
    const sessao = await f.sessao(admin);
    return { admin, sessao };
  }

  const trocar = (c, step, sobrescrever = {}, executor = pool) => servicoPlataforma().trocar(executor, {
    administradorId: c.admin.id,
    sessaoId: c.sessao.id,
    tokenSessao: c.sessao.token,
    senhaAtual: SENHA_ATUAL,
    novaSenha: SENHA_NOVA,
    codigo: c.admin.codigoTotp(step),
    ip: IP,
    dispositivo: DISPOSITIVO,
    ...sobrescrever,
  });

  async function fotografia(c) {
    const id = c.admin.id;
    return {
      hash: await f.hashDaSenha(id),
      step: await f.ultimoStep(id),
      tentativas: (await f.tentativasDe(id)).length,
      auditoria: (await f.auditoriaDe(id)).length,
      sessoes: (await f.sessoesDe(id)).map((s) => [s.id, s.revogada_em === null]),
      desafios: (await f.desafiosDe(id)).map((d) => [d.id, d.encerrado_em === null]),
      mfa: await f.estadoDoMfa(id),
    };
  }

  const falhasDe = async (administradorId) => (await f.tentativasDe(administradorId)).filter((t) => !t.sucesso && t.motivo !== 'COOLDOWN_ATIVADO');
  const ativacoesDe = async (administradorId) => (await f.tentativasDe(administradorId)).filter((t) => t.motivo === 'COOLDOWN_ATIVADO');
  const abertosDe = async (administradorId) => (await f.desafiosDe(administradorId)).filter((d) => d.encerrado_em === null);
  const sessoesValidasDe = async (administradorId) => (await f.sessoesDe(administradorId)).filter((s) => s.revogada_em === null).map((s) => s.id);

  async function erraAteOLimite(c, step, vezes) {
    for (let i = 0; i < vezes; i += 1) {
      await assert.rejects(() => trocar(c, step, { senhaAtual: `errada-${i}-qualquer` }), REAUTENTICACAO_INVALIDA);
    }
  }

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha(SENHA_ATUAL);
    f = fabricaPainel({ pool, hashSenha: hashAtual });
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('controle das fixtures', () => {
    test('o TOTP de referência do teste é aceito pelo validador do servidor, e a senha do administrador passa pelo login existente até a etapa do segundo fator', async () => {
      const admin = await f.novoAdministrador();
      const step = await f.stepEstavel();
      const instanteMs = (await f.um('SELECT clock_timestamp() AS t')).t.getTime();
      assert.deepEqual(totp.validarCodigo({ segredo: admin.segredo, codigo: admin.codigoTotp(step), instanteMs }), { step });
      assert.equal((await loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_ATUAL })).desafio.etapa, 'VERIFICACAO');
      assert.equal(await f.ultimoStep(admin.id), 1);
    });

    test('a sessão plena e o desafio aberto de teste existem como o service espera encontrá-los, e o MFA tem fator, lote e dez códigos', async () => {
      const c = await cenario();
      const aberto = await f.desafioAberto(c.admin);
      assert.equal(await f.sessaoVale(c.sessao), true);
      assert.deepEqual((await abertosDe(c.admin.id)).map((d) => d.id), [aberto]);
      const mfa = await f.estadoDoMfa(c.admin.id);
      assert.deepEqual([mfa.fatores.length, mfa.lotes.length, mfa.codigos.length, mfa.liberacoes.length], [1, 1, 10, 0]);
    });

    test('as sondas das duas travas e o espião de pool enxergam o que o service vai fazer', async () => {
      const admin = await f.novoAdministrador();
      const chave64 = cooldown.derivarAdvisoryLock64(admin.chaveLogin);
      const trava = await segurarTravaConsultiva(pool, chave64);
      try {
        assert.equal(await travaConsultivaLivre(pool, chave64), false);
      } finally {
        await trava.soltar();
      }
      const travaMfa = await segurarTravaMfa(pool, admin.id);
      try {
        assert.equal(await travaMfaLivre(pool, admin.id), false);
        assert.equal(await travaConsultivaLivre(pool, chave64), true, 'os dois espaços de chave são independentes');
      } finally {
        await travaMfa.soltar();
      }
      assert.equal(await travaMfaLivre(pool, admin.id), true);
      assert.equal(await sondarLinha(pool, 'administradores_plataforma', admin.id), 'LIVRE');
      assert.equal(await sondarLinha(pool, 'fatores_mfa_plataforma', admin.fatorId), 'LIVRE');
    });

    test('a caixa de entrega capta o aviso e as senhas de teste passam na política', async (t) => {
      const caixa = capturarEntrega(t);
      assert.deepEqual(caixa.avisos, []);
      const politica = require('../../src/security/password-policy'); // eslint-disable-line global-require
      for (const senha of [SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA]) assert.equal(politica.validarPoliticaSenha(senha, { email: 'admin@example.invalid' }).ok, true, senha);
    });
  });

  describe('sucesso', () => {
    test('senha e TOTP corretos: troca a senha, preserva só a sessão atual, encerra os desafios abertos, cancela o link pendente, não cria nada e deixa o MFA como estava', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      const outra1 = await f.sessao(c.admin);
      const outra2 = await f.sessao(c.admin);
      const abertos = [await f.desafioAberto(c.admin), await f.desafioAberto(c.admin)];
      const vizinho = await cenario();
      const desafioDoVizinho = await f.desafioAberto(vizinho.admin);
      await servicoRecuperacao().solicitar(pool, { escopo: 'PLATAFORMA', email: c.admin.email, ip: IP, dispositivo: DISPOSITIVO });
      const tokenDoLink = caixa.redefinicoes.at(-1).token;
      const antes = await fotografia(c);
      const step = await f.stepEstavel();
      const sessoesAntes = await f.totalDeSessoes();

      assert.deepEqual(await trocar(c, step), RESPOSTA);

      assert.deepEqual(await sessoesValidasDe(c.admin.id), [c.sessao.id], 'só a sessão atual segue válida');
      assert.equal(await f.sessaoVale(c.sessao), true);
      const motivos = Object.fromEntries((await f.sessoesDe(c.admin.id)).map((s) => [s.id, s.motivo_revogacao]));
      assert.deepEqual([motivos[outra1.id], motivos[outra2.id], motivos[c.sessao.id]], [MOTIVO, MOTIVO, null]);
      assert.equal(await f.totalDeSessoes(), sessoesAntes, 'nenhuma sessão nova');
      assert.equal((await f.desafiosDe(c.admin.id)).length, antes.desafios.length, 'nenhum desafio novo');
      const encerrados = (await f.desafiosDe(c.admin.id)).filter((d) => abertos.includes(d.id));
      assert.deepEqual(encerrados.map((d) => d.motivo_encerramento), [MOTIVO, MOTIVO]);
      assert.deepEqual(await abertosDe(c.admin.id), []);

      assert.equal(await f.sessaoVale(vizinho.sessao), true, 'outro administrador intocado');
      assert.deepEqual((await abertosDe(vizinho.admin.id)).map((d) => d.id), [desafioDoVizinho]);
      assert.equal(await f.ultimoStep(vizinho.admin.id), 1);

      const hashNovo = await f.hashDaSenha(c.admin.id);
      assert.notEqual(hashNovo, hashAtual);
      assert.equal(await password.verificarSenha(hashNovo, SENHA_NOVA), true);
      assert.equal(await password.verificarSenha(hashNovo, SENHA_ATUAL), false);
      assert.equal(await f.ultimoStep(c.admin.id), step, 'o passo do TOTP foi consumido (anti-replay)');
      assert.deepEqual(await f.estadoDoMfa(c.admin.id), antes.mfa, 'fator, secret, lote e recovery codes intactos; o step aceito é a única mudança do fator');

      const pedido = (await f.pedidosDe(c.admin.id)).at(-1);
      assert.deepEqual([pedido.motivo_cancelamento, pedido.usado_em, pedido.cancelado_em instanceof Date], [MOTIVO, null, true]);
      await assert.rejects(
        () => servicoRecuperacao().redefinir(pool, { escopo: 'PLATAFORMA', token: tokenDoLink, novaSenha: OUTRA_SENHA, ip: IP, dispositivo: DISPOSITIVO }),
        REDEFINICAO_INVALIDA,
      );
      assert.deepEqual(caixa.avisos, [{ escopo: 'PLATAFORMA', email: c.admin.email, origem: 'TROCA' }]);
    });

    test('o próximo login exige o segundo fator de novo, com a senha nova; a antiga é recusada', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      await trocar(c, await f.stepEstavel());
      await assert.rejects(() => loginPlataformaService.autenticar(pool, { email: c.admin.email, senha: SENHA_ATUAL }), FALHA_DE_LOGIN);
      const resultado = await loginPlataformaService.autenticar(pool, { email: c.admin.email, senha: SENHA_NOVA });
      assert.equal(resultado.desafio.etapa, 'VERIFICACAO');
    });

    test('a mesma sessão continua servindo: uma segunda troca, com a senha nova e um código novo, também funciona', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await trocar(c, step);
      assert.deepEqual(await trocar(c, step + 1, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), RESPOSTA);
      assert.equal(await f.sessaoVale(c.sessao), true);
    });
  });

  describe('reautenticação: senha atual e TOTP', () => {
    test('recovery code no lugar do TOTP é recusado como qualquer código errado, e nenhum recovery code é consumido', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      const antes = await fotografia(c);
      const step = await f.stepEstavel();
      for (const codigo of [c.admin.codigosRecuperacao[0], codigosMfa.normalizarCodigo(c.admin.codigosRecuperacao[1]), '']) {
        await assert.rejects(() => trocar(c, step, { codigo }), REAUTENTICACAO_INVALIDA);
      }
      const depois = await fotografia(c);
      assert.deepEqual({ ...depois, tentativas: undefined }, { ...antes, tentativas: undefined });
      assert.equal(depois.tentativas, antes.tentativas + 3);
      assert.deepEqual(caixa.avisos, []);
    });

    test('senha errada, TOTP errado e TOTP repetido recebem exatamente o mesmo erro, e cada um conta como falha no cooldown de MFA do administrador', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const corpos = [];
      const registrar = (erro) => { corpos.push(JSON.stringify(erro.corpoResposta())); return REAUTENTICACAO_INVALIDA(erro); };

      await assert.rejects(() => trocar(c, step, { senhaAtual: 'senha-errada-qualquer-99' }), registrar);
      assert.equal(await f.ultimoStep(c.admin.id), 1, 'senha errada não consome o passo');
      await assert.rejects(() => trocar(c, step, { codigo: f.codigoErrado(c.admin, step) }), registrar);
      assert.equal(await f.ultimoStep(c.admin.id), 1, 'TOTP errado não consome o passo');
      assert.deepEqual(await trocar(c, step), RESPOSTA);
      await assert.rejects(() => trocar(c, step, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), registrar);

      assert.equal(new Set(corpos).size, 1, 'corpo de erro idêntico: não revela qual fator falhou');
      assert.deepEqual(JSON.parse(corpos[0]), { status: 'error', codigo: 'REAUTENTICACAO_INVALIDA', message: MENSAGEM_DA_REAUTENTICACAO });
      const falhas = await falhasDe(c.admin.id);
      assert.deepEqual(falhas.map((x) => x.motivo), ['REAUTENTICACAO_INVALIDA', 'TOTP_INVALIDO', 'TOTP_REPETIDO']);
      assert.equal(falhas.every((x) => x.chave_cooldown === c.admin.chaveMfa), true, 'a chave do cooldown de MFA do administrador');
      assert.equal(await password.verificarSenha(await f.hashDaSenha(c.admin.id), SENHA_NOVA), true, 'o replay não trocou a senha de novo');
    });

    test('anti-replay: depois de um sucesso, nem o mesmo passo nem um passo mais antigo reautenticam', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await trocar(c, step);
      const hashDepois = await f.hashDaSenha(c.admin.id);
      for (const codigo of [c.admin.codigoTotp(step), c.admin.codigoTotp(step - 1)]) {
        await assert.rejects(() => trocar(c, step, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA, codigo }), REAUTENTICACAO_INVALIDA);
      }
      assert.equal(await f.hashDaSenha(c.admin.id), hashDepois);
      assert.equal(await f.ultimoStep(c.admin.id), step);
    });

    test('a recusa da nova senha vem depois da reautenticação e consome o passo: política e igualdade só são reveladas a quem provou os dois fatores', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const antes = await fotografia(c);

      await assert.rejects(() => trocar(c, step, { novaSenha: 'Zx9!kq' }), VALIDACAO('SENHA_CURTA'));
      assert.equal(await f.ultimoStep(c.admin.id), step, 'passo consumido: o mesmo código não vale de novo');
      assert.equal(await f.hashDaSenha(c.admin.id), antes.hash);
      assert.deepEqual(await sessoesValidasDe(c.admin.id), [c.sessao.id]);
      await assert.rejects(() => trocar(c, step), REAUTENTICACAO_INVALIDA);
      assert.deepEqual(await trocar(c, step + 1), RESPOSTA, 'com o código do passo seguinte a troca conclui');
    });

    test('com senha ou TOTP errado a política não é revelada: a recusa é sempre a da reautenticação', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await assert.rejects(() => trocar(c, step, { senhaAtual: 'senha-errada-qualquer-99', novaSenha: 'Zx9!kq' }), REAUTENTICACAO_INVALIDA);
      await assert.rejects(() => trocar(c, step, { codigo: f.codigoErrado(c.admin, step), novaSenha: 'Zx9!kq' }), REAUTENTICACAO_INVALIDA);
      await assert.rejects(() => trocar(c, step, { senhaAtual: 'senha-errada-qualquer-99', novaSenha: SENHA_ATUAL }), REAUTENTICACAO_INVALIDA);
      assert.equal(await f.ultimoStep(c.admin.id), 1);
    });

    test('igual à atual: SENHA_IGUAL_A_ATUAL, também quando só muda a normalização do texto; sem trocar nada, depois da reautenticação', async (t) => {
      capturarEntrega(t);
      const composta = 'girassol-ação-quartzo-58';
      const decomposta = composta.normalize('NFD');
      assert.notEqual(composta, decomposta);
      const c = await cenario();
      await pool.query('UPDATE administradores_plataforma SET senha_hash = $2 WHERE id = $1', [c.admin.id, await password.gerarHashSenha(composta)]);
      const hashAntes = await f.hashDaSenha(c.admin.id);
      const step = await f.stepEstavel();

      await assert.rejects(() => trocar(c, step, { senhaAtual: composta, novaSenha: decomposta }), SENHA_IGUAL);

      assert.equal(await f.hashDaSenha(c.admin.id), hashAntes);
      assert.equal(await f.ultimoStep(c.admin.id), step, 'a reautenticação já tinha sido concluída');
      assert.deepEqual(await sessoesValidasDe(c.admin.id), [c.sessao.id]);
    });

    test('política: a regra violada vem com o campo, e o e-mail do administrador usado como contexto vem do banco', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await assert.rejects(() => trocar(c, step, { novaSenha: `${c.admin.email}-2026` }), VALIDACAO('SENHA_CONTEM_EMAIL'));
    });
  });

  describe('cooldown de MFA', () => {
    test('no limite de falhas o cooldown de MFA é ativado e a tentativa seguinte, mesmo certa, recebe 429 sem consumir o passo nem gravar linha', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await erraAteOLimite(c, step, FALHAS_DO_NIVEL_1);

      const ativacoes = await ativacoesDe(c.admin.id);
      assert.equal(ativacoes.length, 1);
      assert.equal(ativacoes[0].chave_cooldown, c.admin.chaveMfa);
      assert.ok(ativacoes[0].cooldown_ate.getTime() > Date.now());

      const antes = await fotografia(c);
      const verificar = t.mock.method(password, 'verificarSenha');
      await assert.rejects(() => trocar(c, step), MFA_EM_COOLDOWN);
      assert.equal(verificar.mock.calls.length, 0, 'durante o cooldown nenhuma senha é verificada');
      assert.deepEqual(await fotografia(c), antes, 'nenhuma linha nova, passo intacto, senha intacta');
    });

    test('um sucesso zera a contagem: depois dele o cooldown só vem com o limite inteiro de novo', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const quase = FALHAS_DO_NIVEL_1 - 1;
      await erraAteOLimite(c, step, quase);
      assert.deepEqual(await trocar(c, step), RESPOSTA);

      for (let i = 0; i < quase; i += 1) {
        await assert.rejects(() => trocar(c, step + 1, { senhaAtual: `${SENHA_ATUAL}-${i}`, novaSenha: OUTRA_SENHA }), REAUTENTICACAO_INVALIDA);
      }
      assert.deepEqual(await ativacoesDe(c.admin.id), [], 'a contagem recomeçou no sucesso');
      assert.deepEqual(await trocar(c, step + 1, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), RESPOSTA);
    });
  });

  describe('revalidação dentro da transação', () => {
    test('sessão revogada, administrador inativo, token de outra pessoa, sessão que não é a do token, administrador que não é o da sessão e token inválido: 401 SESSAO_INVALIDA antes de qualquer credencial', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      const vizinho = await cenario();
      const outraDoMesmo = await f.sessao(c.admin);
      const revogada = await cenario();
      await pool.query("UPDATE sessoes_plataforma SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [revogada.sessao.id]);
      const inativo = await cenario();
      await pool.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [inativo.admin.id]);
      const step = await f.stepEstavel();
      const antes = await fotografia(c);

      const casos = [
        ['sessão revogada', () => trocar(revogada, step)],
        ['administrador inativo', () => trocar(inativo, step)],
        ['token de outra pessoa', () => trocar(c, step, { tokenSessao: vizinho.sessao.token })],
        ['id de sessão que não é a do token', () => trocar(c, step, { sessaoId: outraDoMesmo.id })],
        ['administrador que não é o da sessão', () => trocar(c, step, { administradorId: vizinho.admin.id })],
        ['token malformado', () => trocar(c, step, { tokenSessao: 'abc' })],
        ['token ausente', () => trocar(c, step, { tokenSessao: null })],
      ];
      for (const [nome, chamar] of casos) await assert.rejects(chamar, SESSAO_INVALIDA, nome);

      assert.deepEqual(await fotografia(c), antes, 'nenhuma falha contada, nenhum passo consumido');
      for (const outro of [vizinho, revogada]) {
        assert.equal(await f.ultimoStep(outro.admin.id), 1);
        assert.deepEqual(await falhasDe(outro.admin.id), []);
      }
      assert.equal(await f.hashDaSenha(inativo.admin.id), hashAtual);
      assert.deepEqual(caixa.avisos, []);
    });

    test('sem fator TOTP ativo a recusa é a da reautenticação e nada muda', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      await fatorRepo.revogar(pool, { administradorId: c.admin.id, fatorId: c.admin.fatorId, motivo: 'REVOGADO_TESTE' });
      const step = await f.stepEstavel();
      await assert.rejects(() => trocar(c, step), REAUTENTICACAO_INVALIDA);
      assert.equal(await f.hashDaSenha(c.admin.id), hashAtual);
      assert.deepEqual(await sessoesValidasDe(c.admin.id), [c.sessao.id]);
    });

    test('administrador inativado depois de a transação abrir e antes de a linha ser travada: a troca recusa sem mudar nada', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const pausa = pausarEm(t, administradorRepo, 'buscarPorIdParaAtualizacao');
      const emAndamento = trocar(c, step);
      emAndamento.catch(() => {});
      try {
        await pausa.chegou;
        await pool.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [c.admin.id]);
      } finally {
        pausa.liberar();
      }
      await assert.rejects(() => emAndamento, SESSAO_INVALIDA);
      assert.equal(await f.hashDaSenha(c.admin.id), hashAtual);
      assert.deepEqual(await falhasDe(c.admin.id), []);
      assert.deepEqual(caixa.avisos, []);
    });
  });

  describe('falha criptográfica do MFA', () => {
    test('fator indecifrável: 503 fail-closed, sem trocar a senha, sem consumir o passo, sem contar falha e sem aviso; restaurado o fator, a troca funciona', async (t) => {
      const caixa = capturarEntrega(t);
      espiarConsole(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const antes = await fotografia(c);

      await pool.query('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 2 WHERE id = $1', [c.admin.fatorId]);
      await assert.rejects(() => trocar(c, step), MFA_INDISPONIVEL);
      await pool.query('UPDATE fatores_mfa_plataforma SET totp_chave_versao = 1 WHERE id = $1', [c.admin.fatorId]);

      const depois = await fotografia(c);
      assert.equal(depois.hash, antes.hash);
      assert.equal(depois.step, antes.step);
      assert.deepEqual(depois.sessoes, antes.sessoes);
      assert.deepEqual(await falhasDe(c.admin.id), [], 'a falha é do sistema, não do administrador');
      assert.deepEqual(caixa.avisos, []);
      assert.deepEqual(await trocar(c, step), RESPOSTA);
    });
  });

  describe('auditoria', () => {
    test('uma linha SENHA_ALTERADA do ADMINISTRADOR autenticado, com a origem da requisição e só contagens no contexto; nada como SISTEMA', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      await f.sessao(c.admin);
      await f.sessao(c.admin);
      await f.desafioAberto(c.admin);
      await f.desafioAberto(c.admin);
      await servicoRecuperacao().solicitar(pool, { escopo: 'PLATAFORMA', email: c.admin.email, ip: IP, dispositivo: DISPOSITIVO });
      assert.equal(caixa.redefinicoes.length, 1);

      await trocar(c, await f.stepEstavel());

      const eventos = (await f.auditoriaDe(c.admin.id)).filter((e) => e.acao === 'SENHA_ALTERADA');
      assert.equal(eventos.length, 1);
      const [evento] = eventos;
      assert.deepEqual(
        [evento.ator_tipo, evento.administrador_id, evento.administrador_afetado_id, evento.ip, evento.dispositivo],
        ['ADMINISTRADOR', c.admin.id, null, IP, DISPOSITIVO],
        'o ator é o próprio administrador; a trilha não admite alvo igual ao ator, então o alvo fica nulo, como nos eventos de MFA',
      );
      assert.deepEqual(evento.contexto, { origem: 'TROCA_AUTENTICADA', sessoesRevogadas: 2, desafiosEncerrados: 2, pedidosCancelados: 1 });
    });

    test('as recusas de senha, de TOTP e de política não geram linha SENHA_ALTERADA', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await assert.rejects(() => trocar(c, step, { senhaAtual: 'errada-qualquer-12345' }), REAUTENTICACAO_INVALIDA);
      await assert.rejects(() => trocar(c, step, { codigo: f.codigoErrado(c.admin, step) }), REAUTENTICACAO_INVALIDA);
      await assert.rejects(() => trocar(c, step, { novaSenha: 'Zx9!kq' }), VALIDACAO('SENHA_CURTA'));
      assert.deepEqual((await f.auditoriaDe(c.admin.id)).filter((e) => e.acao === 'SENHA_ALTERADA'), []);
    });
  });

  describe('aviso de senha alterada', () => {
    test('só depois do COMMIT, com uma única conexão e uma única transação, e com a variante da troca', async (t) => {
      const espiao = poolEspiaoDetalhado(pool);
      const noInstante = [];
      const visiveis = [];
      const c = await cenario();
      const caixa = capturarEntrega(t, {
        aoEnfileirar: (tipo) => {
          if (tipo !== 'AVISO') return;
          noInstante.push(comandosDa(espiao, espiao.pids[0]).map((x) => x.texto));
          visiveis.push(pool.query('SELECT senha_hash FROM administradores_plataforma WHERE id = $1', [c.admin.id]));
        },
      });

      assert.deepEqual(await trocar(c, await f.stepEstavel(), {}, espiao), RESPOSTA);

      assert.equal(espiao.pids.length, 1, 'uma única conexão: a troca é uma transação só');
      assert.equal(noInstante.length, 1);
      const [concluidos] = noInstante;
      assert.equal(concluidos[0], 'BEGIN');
      assert.equal(concluidos.at(-1), 'COMMIT');
      assert.deepEqual(concluidos.filter((x) => x === 'BEGIN' || x === 'COMMIT' || x === 'ROLLBACK'), ['BEGIN', 'COMMIT']);
      assert.equal(concluidos.some((x) => /UPDATE administradores_plataforma\s+SET senha_hash/.test(x)), true);
      assert.deepEqual(caixa.avisos, [{ escopo: 'PLATAFORMA', email: c.admin.email, origem: 'TROCA' }]);
      assert.deepEqual((await Promise.all(visiveis)).map((r) => r.rows[0].senha_hash), [await f.hashDaSenha(c.admin.id)]);
    });

    test('nenhuma recusa enfileira aviso', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await assert.rejects(() => trocar(c, step, { senhaAtual: 'errada-qualquer-12345' }), REAUTENTICACAO_INVALIDA);
      await assert.rejects(() => trocar(c, step, { codigo: f.codigoErrado(c.admin, step) }), REAUTENTICACAO_INVALIDA);
      await assert.rejects(() => trocar(c, step, { novaSenha: 'Zx9!kq' }), VALIDACAO('SENHA_CURTA'));
      await assert.rejects(() => trocar(c, step, { tokenSessao: 'abc' }), SESSAO_INVALIDA);
      assert.deepEqual(caixa.avisos, []);
    });

    test('falha de entrega, síncrona ou por promessa rejeitada: a troca já confirmada continua e nada sensível vai ao console', async (t) => {
      const linhas = espiarConsole(t);
      const rejeicoes = [];
      const ouvinte = (motivo) => { rejeicoes.push(motivo); };
      process.on('unhandledRejection', ouvinte);
      try {
        const c = await cenario();
        const step = await f.stepEstavel();
        const sensivel = `falha simulada com ${c.admin.email}, ${SENHA_NOVA}, ${SENHA_ATUAL} e ${c.sessao.token}`;
        let modo = 'sincrona';
        t.mock.method(entrega(), 'enfileirarAvisoSenhaAlterada', () => {
          if (modo === 'sincrona') throw new Error(sensivel);
          return Promise.reject(new Error(sensivel));
        });

        assert.deepEqual(await trocar(c, step), RESPOSTA);
        assert.equal(await password.verificarSenha(await f.hashDaSenha(c.admin.id), SENHA_NOVA), true, 'a troca não foi desfeita');
        modo = 'promessa';
        assert.deepEqual(await trocar(c, step + 1, { senhaAtual: SENHA_NOVA, novaSenha: OUTRA_SENHA }), RESPOSTA);
        for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve); });

        assert.deepEqual(rejeicoes, []);
        const texto = linhas.map((l) => l.texto).join('\n');
        for (const valor of [c.admin.email, 'example.invalid', SENHA_NOVA, SENHA_ATUAL, OUTRA_SENHA, c.sessao.token, 'falha simulada']) {
          assert.equal(texto.includes(valor), false, `console contém ${valor.slice(0, 8)}…`);
        }
      } finally {
        process.off('unhandledRejection', ouvinte);
      }
    });
  });

  describe('ordem das travas e serialização', () => {
    test('a ordem é a do login: chave de login do e-mail, trava do MFA, linha da conta, linha do fator, e só então as escritas, com a trava do MFA no espaço de duas chaves do administrador', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      await f.desafioAberto(c.admin);
      await f.sessao(c.admin);
      const step = await f.stepEstavel();
      const espiao = poolEspiaoDetalhado(pool);
      assert.deepEqual(await trocar(c, step, {}, espiao), RESPOSTA);

      assert.equal(espiao.pids.length, 1);
      const comandos = comandosDa(espiao, espiao.pids[0]);
      const [, indiceLogin, indiceMfa, , indiceFator] = exigirOrdem(comandos, [
        /^BEGIN$/,
        /pg_advisory_xact_lock\(\$1::bigint\)/,
        /pg_advisory_xact_lock\(\$1::int, \$2::int\)/,
        /FROM administradores_plataforma[\s\S]*FOR UPDATE/,
        /FROM fatores_mfa_plataforma[\s\S]*FOR UPDATE/,
      ], 'travas da troca do Painel');
      assert.equal(comandos.filter((x) => /pg_advisory/.test(x.texto)).length, 2, 'a chave de login e a trava do MFA, nada mais');

      const ESCRITAS = {
        passo: /UPDATE fatores_mfa_plataforma\s+SET totp_ultimo_step_aceito/,
        senha: /UPDATE administradores_plataforma\s+SET senha_hash/,
        pedidos: /UPDATE redefinicoes_senha_plataforma\b/,
        sessoes: /UPDATE sessoes_plataforma\s+SET revogada_em/,
        desafios: /UPDATE desafios_mfa_plataforma\s+SET encerrado_em/,
        auditoria: /INSERT INTO logs_auditoria_plataforma/,
      };
      for (const [nome, padrao] of Object.entries(ESCRITAS)) {
        const indice = comandos.findIndex((x) => padrao.test(x.texto));
        assert.ok(indice > indiceFator, `${nome}: escrita depois de todas as travas`);
        assert.ok(indice < comandos.length - 1, `${nome}: escrita antes do COMMIT`);
      }
      assert.equal(comandos.at(-1).texto, 'COMMIT');
      assert.deepEqual(comandos.filter((x) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(x.texto)).map((x) => x.texto), ['BEGIN', 'COMMIT']);

      // As duas chaves são exatamente as que o login do mesmo administrador usa.
      const espiaoLogin = poolEspiaoDetalhado(pool);
      await loginPlataformaService.autenticar(espiaoLogin, { email: c.admin.email, senha: SENHA_NOVA });
      const doLogin = comandosDa(espiaoLogin, espiaoLogin.pids[0]);
      const loginChave = doLogin.find((x) => /pg_advisory_xact_lock\(\$1::bigint\)/.test(x.texto));
      const loginMfa = doLogin.find((x) => /pg_advisory_xact_lock\(\$1::int, \$2::int\)/.test(x.texto));
      assert.equal(String(comandos[indiceLogin].parametros[0]), String(loginChave.parametros[0]));
      assert.equal(String(comandos[indiceLogin].parametros[0]), String(cooldown.derivarAdvisoryLock64(c.admin.chaveLogin)));
      assert.deepEqual(comandos[indiceMfa].parametros, [ESPACO_TRAVA_ADMINISTRADOR_MFA, c.admin.id]);
      assert.deepEqual(comandos[indiceMfa].parametros, loginMfa.parametros);
    });

    test('com a chave de login ocupada, a troca espera antes de tomar a trava do MFA, antes de qualquer linha, e nada é gravado', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const espiao = poolEspiaoDetalhado(pool);
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(c.admin.chaveLogin));
      let emAndamento;
      try {
        emAndamento = trocar(c, step, {}, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await travaMfaLivre(pool, c.admin.id), true, 'a trava do MFA só vem depois da chave de login');
        assert.equal(await sondarLinha(pool, 'administradores_plataforma', c.admin.id), 'LIVRE');
        assert.equal(await f.hashDaSenha(c.admin.id), hashAtual);
        assert.equal(await f.ultimoStep(c.admin.id), 1);
      } finally {
        await trava.soltar();
      }
      assert.deepEqual(await emAndamento, RESPOSTA);
    });

    test('com a trava do MFA ocupada, a troca já está com a chave de login e espera antes de travar a linha da conta', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const espiao = poolEspiaoDetalhado(pool);
      const travaMfa = await segurarTravaMfa(pool, c.admin.id);
      let emAndamento;
      try {
        emAndamento = trocar(c, step, {}, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await travaConsultivaLivre(pool, cooldown.derivarAdvisoryLock64(c.admin.chaveLogin)), false, 'a chave de login já é da troca');
        assert.equal(await sondarLinha(pool, 'administradores_plataforma', c.admin.id), 'LIVRE', 'a linha da conta só vem depois da trava do MFA');
      } finally {
        await travaMfa.soltar();
      }
      assert.deepEqual(await emAndamento, RESPOSTA);
    });

    test('com a conta travada, a linha do fator ainda está livre: a conta vem antes do fator', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const pausa = pausarEm(t, fatorRepo, 'buscarTotpAtivo');
      const emAndamento = trocar(c, step);
      try {
        await pausa.chegou;
        assert.equal(await travaConsultivaLivre(pool, cooldown.derivarAdvisoryLock64(c.admin.chaveLogin)), false);
        assert.equal(await travaMfaLivre(pool, c.admin.id), false);
        assert.equal(await sondarLinha(pool, 'administradores_plataforma', c.admin.id), 'TRAVADA');
        assert.equal(await sondarLinha(pool, 'fatores_mfa_plataforma', c.admin.fatorId), 'LIVRE');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await emAndamento, RESPOSTA);
    });

    test('um login real em andamento segura a troca, e o desafio que ele abre com a senha antiga é encerrado em seguida', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const espiao = poolEspiaoDetalhado(pool);

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

      const login = loginPlataformaService.autenticar(pool, { email: c.admin.email, senha: SENHA_ATUAL });
      login.catch(() => {});
      let troca;
      try {
        await chegou.promessa;
        troca = trocar(c, step, {}, espiao);
        troca.catch(() => {});
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await f.hashDaSenha(c.admin.id), hashAtual, 'a troca não avança enquanto o login não termina');
      } finally {
        liberar.resolver();
      }
      assert.equal((await login).desafio.etapa, 'VERIFICACAO');
      assert.deepEqual(await troca, RESPOSTA);
      assert.deepEqual(await abertosDe(c.admin.id), [], 'o desafio aberto pelo login com a senha antiga não sobrevive');
      assert.equal((await f.desafiosDe(c.admin.id)).some((d) => d.motivo_encerramento === MOTIVO), true);
      assert.deepEqual(await sessoesValidasDe(c.admin.id), [c.sessao.id]);
    });

    test('uma regeneração de recovery codes em andamento segura a troca; ao terminar, a sessão da troca já foi revogada: 401, senha intacta e o lote novo é o da regeneração', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      const pausa = pausarEm(t, loteRepo, 'revogarAtivo');
      const regeneracao = substituicaoMfaService.regenerarCodigos(pool, {
        administradorId: c.admin.id, sessaoId: c.sessao.id, tokenSessao: c.sessao.token, senha: SENHA_ATUAL, codigo: c.admin.codigoTotp(step), ip: IP, dispositivo: DISPOSITIVO,
      });
      regeneracao.catch(() => {});
      const espiao = poolEspiaoDetalhado(pool);
      let troca;
      try {
        await pausa.chegou;
        troca = trocar(c, step, { codigo: c.admin.codigoTotp(step + 1) }, espiao);
        troca.catch(() => {});
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await travaConsultivaLivre(pool, cooldown.derivarAdvisoryLock64(c.admin.chaveLogin)), false, 'a troca já tem a chave de login e espera a trava do MFA');
      } finally {
        pausa.liberar();
      }
      assert.equal((await regeneracao).codigosRecuperacao.length, 10);
      await assert.rejects(() => troca, SESSAO_INVALIDA);
      assert.equal(await f.hashDaSenha(c.admin.id), hashAtual);
      assert.equal(await f.ultimoStep(c.admin.id), step, 'só a regeneração consumiu passo');
      assert.equal((await f.estadoDoMfa(c.admin.id)).lotes.length, 2, 'a troca não criou nem revogou lote');
    });

    test('reset público já em andamento (com a conta travada) segura a troca; ao terminar, a sessão da troca já foi revogada: 401 e a senha é a do reset', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await servicoRecuperacao().solicitar(pool, { escopo: 'PLATAFORMA', email: c.admin.email, ip: IP, dispositivo: DISPOSITIVO });
      const tokenDoLink = caixa.redefinicoes.at(-1).token;
      const pausa = pausarEm(t, redefinicaoPlataformaRepo, 'buscarPorHashParaAtualizacao');
      const reset = servicoRecuperacao().redefinir(pool, { escopo: 'PLATAFORMA', token: tokenDoLink, novaSenha: OUTRA_SENHA, ip: IP, dispositivo: DISPOSITIVO });
      reset.catch(() => {});
      const espiao = poolEspiaoDetalhado(pool);
      let troca;
      try {
        await pausa.chegou;
        troca = trocar(c, step, {}, espiao);
        troca.catch(() => {});
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await reset, { status: 'SENHA_REDEFINIDA' });
      await assert.rejects(() => troca, SESSAO_INVALIDA);
      const hash = await f.hashDaSenha(c.admin.id);
      assert.equal(await password.verificarSenha(hash, OUTRA_SENHA), true);
      assert.equal(await password.verificarSenha(hash, SENHA_NOVA), false);
      assert.equal(await f.ultimoStep(c.admin.id), 1, 'a troca não chegou a consumir passo');
    });

    test('troca já em andamento segura o reset público; ao terminar, o link foi cancelado pela troca e o reset recebe o erro genérico', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();
      await servicoRecuperacao().solicitar(pool, { escopo: 'PLATAFORMA', email: c.admin.email, ip: IP, dispositivo: DISPOSITIVO });
      const tokenDoLink = caixa.redefinicoes.at(-1).token;
      const pausa = pausarEm(t, auditoriaPlataformaRepo, 'registrar');
      const troca = trocar(c, step);
      troca.catch(() => {});
      const espiaoReset = poolEspiaoDetalhado(pool);
      let reset;
      try {
        await pausa.chegou;
        reset = servicoRecuperacao().redefinir(espiaoReset, { escopo: 'PLATAFORMA', token: tokenDoLink, novaSenha: OUTRA_SENHA, ip: IP, dispositivo: DISPOSITIVO });
        reset.catch(() => {});
        await aguardarEmEspera(pool, espiaoReset, 1, 'advisory');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await troca, RESPOSTA);
      await assert.rejects(() => reset, REDEFINICAO_INVALIDA);
      assert.equal(await password.verificarSenha(await f.hashDaSenha(c.admin.id), SENHA_NOVA), true);
    });

    test('logins reais simultâneos com a senha antiga e a troca: sem deadlock, nenhum desafio aberto sobra e só a sessão atual vale', async (t) => {
      capturarEntrega(t);
      const c = await cenario();
      const step = await f.stepEstavel();

      const [troca, ...logins] = await Promise.allSettled([
        trocar(c, step),
        ...Array.from({ length: 3 }, () => loginPlataformaService.autenticar(pool, { email: c.admin.email, senha: SENHA_ATUAL })),
      ]);

      assert.equal(troca.status, 'fulfilled', String(troca.reason?.code ?? troca.reason?.message));
      for (const login of logins) {
        if (login.status === 'rejected') {
          assert.notEqual(login.reason?.code, '40P01', 'deadlock');
          assert.equal(FALHA_DE_LOGIN(login.reason), true, 'login depois da troca: senha antiga recusada');
        }
      }
      assert.deepEqual(await abertosDe(c.admin.id), []);
      assert.deepEqual(await sessoesValidasDe(c.admin.id), [c.sessao.id]);
      assert.equal(await password.verificarSenha(await f.hashDaSenha(c.admin.id), SENHA_NOVA), true);
    });

    test('duas trocas simultâneas por duas sessões: exatamente uma vence; a outra encontra a própria sessão já revogada, antes de gastar credencial', async (t) => {
      const caixa = capturarEntrega(t);
      const c = await cenario();
      const outra = await f.sessao(c.admin);
      const step = await f.stepEstavel();

      const resultados = await Promise.allSettled([
        trocar(c, step, { novaSenha: SENHA_NOVA }),
        trocar({ admin: c.admin, sessao: outra }, step, { novaSenha: OUTRA_SENHA }),
      ]);

      assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
      const perdedora = resultados.find((r) => r.status === 'rejected');
      assert.equal(SESSAO_INVALIDA(perdedora.reason), true, String(perdedora.reason?.message));
      assert.equal((await sessoesValidasDe(c.admin.id)).length, 1);
      assert.deepEqual(await falhasDe(c.admin.id), [], 'a perdedora não contou falha');
      assert.equal(caixa.avisos.length, 1);
    });
  });

  describe('dados sensíveis', () => {
    test('nem a trilha de auditoria, nem as tentativas, nem os pedidos, nem o console guardam senha, TOTP, recovery code, hash, token de sessão ou e-mail', async (t) => {
      const caixa = capturarEntrega(t);
      const linhas = espiarConsole(t);
      const c = await cenario();
      const outra = await f.sessao(c.admin);
      await servicoRecuperacao().solicitar(pool, { escopo: 'PLATAFORMA', email: c.admin.email, ip: IP, dispositivo: DISPOSITIVO });
      const tokenDoLink = caixa.redefinicoes.at(-1).token;
      const step = await f.stepEstavel();
      const erradaDaVez = 'senha-errada-qualquer-12345';
      const codigoErrado = f.codigoErrado(c.admin, step);

      await assert.rejects(() => trocar(c, step, { senhaAtual: erradaDaVez }), REAUTENTICACAO_INVALIDA);
      await assert.rejects(() => trocar(c, step, { codigo: codigoErrado }), REAUTENTICACAO_INVALIDA);
      await assert.rejects(() => trocar(c, step, { novaSenha: 'Zx9!kq' }), VALIDACAO('SENHA_CURTA'));
      await trocar(c, step + 1);

      const hashNovo = await f.hashDaSenha(c.admin.id);
      const id = c.admin.id;
      const auditoria = await despejo(pool, 'logs_auditoria_plataforma', 'administrador_id = $1 OR administrador_afetado_id = $1', [id]);
      const tentativas = await despejo(pool, 'login_tentativas_plataforma', 'administrador_id = $1', [id]);
      const pedidos = await despejo(pool, 'redefinicoes_senha_plataforma', 'administrador_id = $1', [id]);
      const tecnico = linhas.map((l) => l.texto).join('\n');
      assert.notEqual(auditoria, '');

      const codigosTotp = [step, step + 1].map((s) => JSON.stringify(c.admin.codigoTotp(s))).concat(JSON.stringify(codigoErrado));
      const recoveryCodes = c.admin.codigosRecuperacao.flatMap((codigo) => [codigo, codigosMfa.normalizarCodigo(codigo)]);
      const tokensDeSessao = [c.sessao, outra].map((s) => s.token);
      const segredos = [
        SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA, erradaDaVez, tokenDoLink, '#token=', 'redefinir-senha.html',
        ...recoveryCodes, ...tokensDeSessao, ...tokensDeSessao.map((s) => token.hashTokenSessao(s)), ...codigosTotp,
      ];
      const emails = [c.admin.email, 'example.invalid'];
      for (const valor of [...segredos, ...emails, hashNovo, hashAtual]) {
        assert.equal(auditoria.includes(valor), false, `auditoria contém ${valor.slice(0, 8)}…`);
        assert.equal(tecnico.includes(valor), false, `console contém ${valor.slice(0, 8)}…`);
        assert.equal(tentativas.includes(valor), false, `tentativas contêm ${valor.slice(0, 8)}…`);
      }
      for (const valor of [...segredos, ...emails, hashNovo]) {
        assert.equal(pedidos.includes(valor), false, `pedidos contêm ${valor.slice(0, 8)}…`);
      }
    });
  });
});
