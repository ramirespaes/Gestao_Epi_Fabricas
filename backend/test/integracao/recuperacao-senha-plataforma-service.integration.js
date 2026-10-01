'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/recuperacao-senha');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const {
  servico, sinal, capturarEntrega, poolEspiao, aguardarEmEspera, segurarTravaConsultiva, sondarLinha, pausarEm, DEADLOCK,
} = require('./helpers/recuperacao-senha-servico');
const { HttpError } = require('../../src/errors/HttpError');
const redefinicaoPlataformaRepo = require('../../src/repositories/redefinicao-senha-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const loginPlataformaService = require('../../src/services/login-plataforma.service');
const mfaCripto = require('../../src/security/mfa-cripto');
const codigosMfa = require('../../src/security/codigos-mfa');
const cooldown = require('../../src/security/cooldown');
const password = require('../../src/security/password');
const token = require('../../src/security/token');

/**
 * Recuperação de senha do Painel Privado (Bloco 11C) contra PostgreSQL real.
 * O que é próprio do administrador: a trilha de auditoria da plataforma, a
 * trava do MFA, o encerramento dos desafios pré-MFA e a revogação das
 * sessões administrativas — sem tocar em fator, lote ou código de
 * recuperação. O próximo login continua pedindo o segundo fator.
 */

const ESCOPO = 'PLATAFORMA';
const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const IP = '203.0.113.7';
const DISPOSITIVO = 'Agente de Teste';
const RESPOSTA = { status: 'SOLICITACAO_RECEBIDA' };
const INVALIDA = (erro) => erro instanceof HttpError && erro.status === 400 && erro.codigo === 'REDEFINICAO_INVALIDA';

describe('recuperação de senha do Painel Privado — service com PostgreSQL real', () => {
  let contexto;
  let pool;
  let hashAtual;
  let sequencia = 0;

  const um = async (sql, parametros) => (await pool.query(sql, parametros)).rows[0];
  const todos = async (sql, parametros) => (await pool.query(sql, parametros)).rows;

  async function novoAdministrador({ comMfa = true, ativo = true } = {}) {
    sequencia += 1;
    const email = `admin-recuperacao-${sequencia}@example.invalid`;
    const { id } = await um('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hashAtual]);
    const admin = { id, email, chave: cooldown.gerarChaveRecuperacaoSenha(ESCOPO, email) };
    if (comMfa) {
      const fatorUid = crypto.randomUUID();
      const envelope = mfaCripto.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: id, fatorUid });
      const fator = await fatorRepo.criarPendenteTotp(pool, { administradorId: id, fatorUid, envelope, validadeMinutos: 15 });
      assert.equal(await fatorRepo.ativarTotp(pool, { administradorId: id, fatorId: fator.id, step: 1 }), true);
      const lote = await loteRepo.criar(pool, id);
      const hashes = Array.from({ length: 10 }, () => codigosMfa.hashCodigoRecuperacao({
        administradorId: id, codigo: codigosMfa.normalizarCodigo(codigosMfa.gerarCodigo()),
      }));
      assert.equal(await codigoRepo.inserirHashes(pool, { administradorId: id, loteId: lote.id, hashes }), 10);
    }
    if (!ativo) await pool.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [id]);
    return admin;
  }

  const estadoDoMfa = async (administradorId) => ({
    fatores: await todos('SELECT * FROM fatores_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]),
    lotes: await todos('SELECT * FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]),
    codigos: await todos('SELECT * FROM codigos_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]),
    liberacoes: await todos('SELECT * FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]),
  });

  async function desafioAberto(administradorId) {
    const criado = await desafioRepo.criar(pool, {
      administradorId, tokenHash: token.hashTokenSessao(token.gerarTokenSessao()), tipo: 'VERIFICACAO', validadeMinutos: 5,
    });
    return criado.id;
  }

  const pedidosDe = (administradorId) => todos('SELECT * FROM redefinicoes_senha_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]);
  const pendentesDe = async (administradorId) => (await pedidosDe(administradorId)).filter((p) => p.usado_em === null && p.cancelado_em === null);
  const solicitacoesDe = (chave) => todos('SELECT * FROM recuperacao_senha_solicitacoes WHERE chave = $1 ORDER BY id', [chave]);
  const auditoriaDe = (administradorId) => todos('SELECT * FROM logs_auditoria_plataforma WHERE administrador_afetado_id = $1 ORDER BY id', [administradorId]);
  const hashDaSenha = async (administradorId) => (await um('SELECT senha_hash FROM administradores_plataforma WHERE id = $1', [administradorId])).senha_hash;
  const sessoesDe = (administradorId) => todos('SELECT id, revogada_em, motivo_revogacao FROM sessoes_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]);
  const desafiosDe = (administradorId) => todos('SELECT id, encerrado_em, motivo_encerramento FROM desafios_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [administradorId]);

  const solicitar = (email, escopo = ESCOPO) => servico().solicitar(pool, { escopo, email, ip: IP, dispositivo: DISPOSITIVO });
  const redefinir = (tokenClaro, novaSenha = SENHA_NOVA, executor = pool) => servico().redefinir(executor, {
    escopo: ESCOPO, token: tokenClaro, novaSenha, ip: IP, dispositivo: DISPOSITIVO,
  });

  async function pedirToken(caixa, email) {
    const antes = caixa.redefinicoes.length;
    assert.deepEqual(await solicitar(email), RESPOSTA);
    assert.equal(caixa.redefinicoes.length, antes + 1, 'a solicitação deveria ter enfileirado um e-mail');
    return caixa.redefinicoes.at(-1).token;
  }

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha(SENHA_ATUAL);
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('controle das fixtures', () => {
    test('o administrador de teste, com TOTP ativo e códigos de recuperação, passa pela senha no login existente e recebe o desafio do segundo fator', async () => {
      const admin = await novoAdministrador();
      const resultado = await loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_ATUAL });
      assert.equal(resultado.desafio.etapa, 'VERIFICACAO');
      const mfa = await estadoDoMfa(admin.id);
      assert.deepEqual([mfa.fatores.length, mfa.lotes.length, mfa.codigos.length], [1, 1, 10]);
      assert.deepEqual(await sessoesDe(admin.id), [], 'senha sozinha não cria sessão');
    });

    test('a sessão administrativa e o desafio aberto de teste existem como o reset espera encontrá-los', async () => {
      const admin = await novoAdministrador();
      const sessao = await criarSessaoAdministrativa(pool, admin.id);
      const desafio = await desafioAberto(admin.id);
      assert.deepEqual((await sessoesDe(admin.id)).map((s) => [s.id, s.revogada_em]), [[sessao.id, null]]);
      const abertos = (await desafiosDe(admin.id)).filter((d) => d.encerrado_em === null);
      assert.deepEqual(abertos.map((d) => d.id), [desafio]);
    });

    test('o administrador sem MFA e o administrador inativo de teste ficam no estado esperado', async () => {
      const semMfa = await novoAdministrador({ comMfa: false });
      assert.deepEqual(await estadoDoMfa(semMfa.id), { fatores: [], lotes: [], codigos: [], liberacoes: [] });
      const inativo = await novoAdministrador({ ativo: false });
      assert.equal((await um('SELECT ativo FROM administradores_plataforma WHERE id = $1', [inativo.id])).ativo, false);
    });

    test('a trava do MFA de teste segura uma segunda conexão, e a linha do administrador segue livre', async () => {
      const admin = await novoAdministrador();
      const espiao = poolEspiao(pool);
      const ocupante = await pool.connect();
      const segunda = await espiao.connect();
      try {
        await ocupante.query('BEGIN');
        await travaRepo.travarAdministrador(ocupante, admin.id);
        await segunda.query('BEGIN');
        const espera = travaRepo.travarAdministrador(segunda, admin.id);
        try {
          assert.deepEqual(await aguardarEmEspera(pool, espiao, 1, 'advisory'), [segunda.processID]);
          assert.equal(await sondarLinha(pool, 'administradores_plataforma', admin.id), 'LIVRE');
        } finally {
          await ocupante.query('COMMIT');
        }
        await espera;
        await segunda.query('COMMIT');
      } finally {
        await ocupante.query('ROLLBACK').catch(() => {});
        await segunda.query('ROLLBACK').catch(() => {});
        ocupante.release();
        segunda.release();
      }
    });
  });

  describe('solicitação', () => {
    test('pedido na tabela da plataforma, solicitação com o escopo PLATAFORMA, auditoria do sistema sobre o administrador e e-mail do Painel', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      assert.deepEqual(await solicitar(admin.email), RESPOSTA);

      const [mensagem] = caixa.redefinicoes;
      assert.deepEqual([caixa.redefinicoes.length, mensagem.escopo, mensagem.email], [1, ESCOPO, admin.email]);
      const [pedido, ...outros] = await pedidosDe(admin.id);
      assert.deepEqual(outros, []);
      assert.equal(pedido.token_hash, token.hashTokenSessao(mensagem.token));
      assert.equal(pedido.expira_em.getTime() - pedido.criado_em.getTime(), 60 * 60_000);

      const [solicitacao] = await solicitacoesDe(admin.chave);
      assert.equal(solicitacao.escopo, ESCOPO);

      const [evento, ...resto] = await auditoriaDe(admin.id);
      assert.deepEqual(resto, []);
      assert.deepEqual(
        [evento.ator_tipo, evento.administrador_id, evento.acao, evento.referencia],
        ['SISTEMA', null, 'REDEFINICAO_SENHA_SOLICITADA', pedido.id],
      );
      assert.deepEqual(evento.contexto, { pedidosSubstituidos: 0, validadeMinutos: 60 });
    });

    test('os namespaces não se misturam: o mesmo e-mail no Portal não recebe pedido, e o limite de um não vale para o outro', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const { id: identidadeId } = await um('INSERT INTO identidades (email, senha_hash) VALUES ($1, $2) RETURNING id', [admin.email, hashAtual]);

      for (let i = 0; i < 4; i += 1) assert.deepEqual(await solicitar(admin.email), RESPOSTA);
      assert.equal((await pedidosDe(admin.id)).length, 3, 'três aceitas no Painel');
      assert.deepEqual(await todos('SELECT id FROM redefinicoes_senha WHERE identidade_id = $1', [identidadeId]), [], 'nada no Portal');
      assert.equal(caixa.redefinicoes.every((m) => m.escopo === ESCOPO), true);

      assert.deepEqual(await solicitar(admin.email, 'PORTAL'), RESPOSTA);
      assert.equal((await todos('SELECT id FROM redefinicoes_senha WHERE identidade_id = $1', [identidadeId])).length, 1, 'o Portal tem o próprio limite');
      assert.equal((await pedidosDe(admin.id)).length, 3);
    });

    test('administrador inativo ou inexistente: mesma resposta, sem pedido e sem e-mail', async (t) => {
      const caixa = capturarEntrega(t);
      const inativo = await novoAdministrador({ ativo: false });
      assert.deepEqual(await solicitar(inativo.email), RESPOSTA);
      assert.deepEqual(await solicitar(`admin-ninguem-${sequencia}@example.invalid`), RESPOSTA);
      assert.equal(caixa.redefinicoes.length, 0);
      assert.deepEqual(await pedidosDe(inativo.id), []);
      const recusas = (await auditoriaDe(inativo.id)).filter((e) => e.acao === 'REDEFINICAO_SENHA_RECUSADA');
      assert.deepEqual(recusas.map((e) => [e.ator_tipo, e.contexto]), [['SISTEMA', { etapa: 'SOLICITACAO', motivo: 'CONTA_INATIVA' }]]);
    });
  });

  describe('redefinição pelo link', () => {
    test('troca a senha, revoga as sessões administrativas e encerra os desafios abertos, sem alterar fator, lote, códigos nem liberações do MFA', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const vizinho = await novoAdministrador();
      const sessao = await criarSessaoAdministrativa(pool, admin.id);
      const sessaoVizinha = await criarSessaoAdministrativa(pool, vizinho.id);
      const desafio = await desafioAberto(admin.id);
      const desafioVizinho = await desafioAberto(vizinho.id);
      const tokenClaro = await pedirToken(caixa, admin.email);
      const mfaAntes = await estadoDoMfa(admin.id);
      const mfaVizinhoAntes = await estadoDoMfa(vizinho.id);
      const sessoesAntes = (await um('SELECT count(*)::int AS n FROM sessoes_plataforma')).n;

      assert.deepEqual(await redefinir(tokenClaro), { status: 'SENHA_REDEFINIDA' });

      const hashNovo = await hashDaSenha(admin.id);
      assert.equal(await password.verificarSenha(hashNovo, SENHA_NOVA), true);
      assert.equal(await password.verificarSenha(hashNovo, SENHA_ATUAL), false);
      assert.deepEqual(await estadoDoMfa(admin.id), mfaAntes, 'MFA do administrador byte a byte igual');
      assert.deepEqual(await estadoDoMfa(vizinho.id), mfaVizinhoAntes);

      assert.deepEqual((await sessoesDe(admin.id)).map((s) => [s.id, s.motivo_revogacao]), [[sessao.id, 'SENHA_REDEFINIDA']]);
      assert.deepEqual((await sessoesDe(vizinho.id)).map((s) => [s.id, s.motivo_revogacao]), [[sessaoVizinha.id, null]]);
      assert.equal((await um('SELECT count(*)::int AS n FROM sessoes_plataforma')).n, sessoesAntes, 'nenhuma sessão nova');

      const doAdmin = await desafiosDe(admin.id);
      assert.equal(doAdmin.find((d) => d.id === desafio).motivo_encerramento, 'SENHA_REDEFINIDA');
      assert.equal(doAdmin.every((d) => d.encerrado_em !== null), true, 'nenhum desafio aberto sobra');
      assert.equal((await desafiosDe(vizinho.id)).find((d) => d.id === desafioVizinho).encerrado_em, null, 'desafio de outro administrador intocado');
      assert.equal(await hashDaSenha(vizinho.id), hashAtual);

      const [pedido] = await pedidosDe(admin.id);
      assert.ok(pedido.usado_em instanceof Date);
      const eventos = await auditoriaDe(admin.id);
      const redefinida = eventos.find((e) => e.acao === 'SENHA_REDEFINIDA');
      assert.deepEqual([redefinida.ator_tipo, redefinida.administrador_id, redefinida.referencia], ['SISTEMA', null, pedido.id]);
      assert.deepEqual(redefinida.contexto, { origem: 'LINK', sessoesRevogadas: 1, desafiosEncerrados: 1, pedidosCancelados: 0 });
      assert.deepEqual(caixa.avisos, [{ escopo: ESCOPO, email: admin.email }]);
    });

    test('o próximo login continua exigindo o segundo fator: senha nova abre o desafio de verificação e não cria sessão; a antiga é recusada', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      await redefinir(await pedirToken(caixa, admin.email));

      await assert.rejects(
        () => loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_ATUAL }),
        (erro) => erro instanceof HttpError && erro.codigo === 'CREDENCIAIS_INVALIDAS',
      );
      const login = await loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_NOVA });
      assert.equal(login.desafio.etapa, 'VERIFICACAO');
      assert.deepEqual(await sessoesDe(admin.id), [], 'sem TOTP não há sessão');
    });

    test('administrador sem MFA cadastrado: o reset não cria fator nem liberação, e o login segue para a etapa de liberação', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador({ comMfa: false });
      await redefinir(await pedirToken(caixa, admin.email));
      assert.deepEqual(await estadoDoMfa(admin.id), { fatores: [], lotes: [], codigos: [], liberacoes: [] });
      const login = await loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_NOVA });
      assert.equal(login.desafio.etapa, 'LIBERACAO');
    });

    test('replay e link de administrador inativado são recusados com o mesmo erro; a recusa fica na trilha da plataforma', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const tokenClaro = await pedirToken(caixa, admin.email);
      await redefinir(tokenClaro);
      await assert.rejects(() => redefinir(tokenClaro), INVALIDA);
      const recusa = (await auditoriaDe(admin.id)).at(-1);
      assert.deepEqual([recusa.ator_tipo, recusa.acao, recusa.contexto], ['SISTEMA', 'REDEFINICAO_SENHA_RECUSADA', { etapa: 'REDEFINICAO', motivo: 'PEDIDO_USADO' }]);

      const inativado = await novoAdministrador();
      const tokenInativado = await pedirToken(caixa, inativado.email);
      await pool.query('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [inativado.id]);
      await assert.rejects(() => redefinir(tokenInativado), INVALIDA);
      assert.equal(await hashDaSenha(inativado.id), hashAtual);
    });

    test('trava do MFA antes da conta: com a trava do administrador ocupada, o reset espera sem ter travado a linha nem trocado a senha', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const tokenClaro = await pedirToken(caixa, admin.email);
      const espiao = poolEspiao(pool);
      const ocupante = await pool.connect();
      let emAndamento;
      try {
        await ocupante.query('BEGIN');
        await travaRepo.travarAdministrador(ocupante, admin.id);
        emAndamento = redefinir(tokenClaro, SENHA_NOVA, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await hashDaSenha(admin.id), hashAtual);
        assert.equal(await sondarLinha(pool, 'administradores_plataforma', admin.id), 'LIVRE');
      } finally {
        await ocupante.query('COMMIT').finally(() => ocupante.release());
      }
      assert.deepEqual(await emAndamento, { status: 'SENHA_REDEFINIDA' });
    });

    test('reset e login não se cruzam: com a chave de login do administrador ocupada, o reset espera', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const tokenClaro = await pedirToken(caixa, admin.email);
      const espiao = poolEspiao(pool);
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(cooldown.gerarChaveCooldownPlataforma(admin.email)));
      let emAndamento;
      try {
        emAndamento = redefinir(tokenClaro, SENHA_NOVA, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await hashDaSenha(admin.id), hashAtual);
      } finally {
        await trava.soltar();
      }
      assert.deepEqual(await emAndamento, { status: 'SENHA_REDEFINIDA' });
    });

    test('compatível com o login existente: um login real do administrador em andamento segura o reset, e o desafio que ele abre é encerrado em seguida', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const tokenClaro = await pedirToken(caixa, admin.email);
      const espiao = poolEspiao(pool);

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

      const login = loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_ATUAL });
      let reset;
      try {
        await chegou.promessa;
        reset = redefinir(tokenClaro, SENHA_NOVA, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await hashDaSenha(admin.id), hashAtual, 'o reset não avança enquanto o login não termina');
      } finally {
        liberar.resolver();
      }
      const desafioDoLogin = await login;
      assert.equal(desafioDoLogin.desafio.etapa, 'VERIFICACAO');
      assert.deepEqual(await reset, { status: 'SENHA_REDEFINIDA' });
      const { motivo_encerramento: motivo } = await um(
        'SELECT motivo_encerramento FROM desafios_mfa_plataforma WHERE token_hash = $1', [token.hashTokenSessao(desafioDoLogin.token)],
      );
      assert.equal(motivo, 'SENHA_REDEFINIDA', 'o desafio aberto com a senha antiga não sobrevive');
    });

    test('logins reais simultâneos do administrador e o reset: sem deadlock, sem sessão e sem desafio aberto com a senha antiga', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const tokenClaro = await pedirToken(caixa, admin.email);

      const [reset, ...logins] = await Promise.allSettled([
        redefinir(tokenClaro),
        ...Array.from({ length: 4 }, () => loginPlataformaService.autenticar(pool, { email: admin.email, senha: SENHA_ATUAL })),
      ]);

      assert.equal(reset.status, 'fulfilled', String(reset.reason?.code ?? reset.reason?.message));
      for (const login of logins) {
        if (login.status === 'rejected') {
          assert.notEqual(login.reason?.code, DEADLOCK);
          assert.equal(login.reason instanceof HttpError && login.reason.codigo === 'CREDENCIAIS_INVALIDAS', true, 'login depois do reset: senha antiga recusada');
        }
      }
      assert.deepEqual((await desafiosDe(admin.id)).filter((d) => d.encerrado_em === null), [], 'nenhum desafio aberto com a senha antiga');
      assert.deepEqual(await sessoesDe(admin.id), []);
      assert.equal(await password.verificarSenha(await hashDaSenha(admin.id), SENHA_NOVA), true);
    });

    test('conta antes do pedido: com a linha do administrador já travada, a linha do pedido ainda está livre', async (t) => {
      const caixa = capturarEntrega(t);
      const admin = await novoAdministrador();
      const tokenClaro = await pedirToken(caixa, admin.email);
      const pedido = (await pendentesDe(admin.id))[0];
      const pausa = pausarEm(t, redefinicaoPlataformaRepo, 'buscarPorHashParaAtualizacao');
      const emAndamento = redefinir(tokenClaro);
      try {
        await pausa.chegou;
        assert.equal(await sondarLinha(pool, 'administradores_plataforma', admin.id), 'TRAVADA');
        assert.equal(await sondarLinha(pool, 'redefinicoes_senha_plataforma', pedido.id), 'LIVRE');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await emAndamento, { status: 'SENHA_REDEFINIDA' });
    });
  });
});
