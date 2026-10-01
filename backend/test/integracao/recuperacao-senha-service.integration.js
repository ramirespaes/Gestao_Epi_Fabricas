'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarEmpresa } = require('./helpers/entrega-epi');
const { todasAsMigrations, hashDeToken, inserirPedido } = require('./helpers/recuperacao-senha');
const {
  servico, sinal, capturarEntrega, espiarConsole, poolEspiao, concluidosNaConexao, aguardarEmEspera, segurarTravaConsultiva, sondarLinha, pausarEm,
  DEADLOCK,
} = require('./helpers/recuperacao-senha-servico');
const { HttpError } = require('../../src/errors/HttpError');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const redefinicaoRepo = require('../../src/repositories/redefinicao-senha.repository');
const auditoriaIdentidadeRepo = require('../../src/repositories/auditoria-identidade.repository');
const loginGlobalService = require('../../src/services/login-global.service');
const cooldown = require('../../src/security/cooldown');
const password = require('../../src/security/password');
const token = require('../../src/security/token');

/**
 * Recuperação de senha do Portal (Bloco 11C) contra PostgreSQL real, com
 * todas as migrations num schema temporário. A entrega de e-mail é trocada
 * por uma caixa em memória, que é também a única fonte do token em claro.
 * Os cenários de concorrência usam conexões distintas e só avançam depois de
 * o próprio banco mostrar que a outra conexão está esperando.
 */

const ESCOPO = 'PORTAL';
const TABELA = { tabela: 'redefinicoes_senha', coluna: 'identidade_id' };
const SENHA_ATUAL = 'planeta-nebulosa-ozonio-42';
const SENHA_NOVA = 'girassol-quartzo-bussola-58';
const OUTRA_SENHA = 'lanterna-cometa-ardosia-91';
const IP = '203.0.113.7';
const DISPOSITIVO = 'Agente de Teste';
const RESPOSTA = { status: 'SOLICITACAO_RECEBIDA' };
const CNPJS = ['11222333000181', '44555666000162'];

const INVALIDA = (erro) => erro instanceof HttpError && erro.status === 400 && erro.codigo === 'REDEFINICAO_INVALIDA';

describe('recuperação de senha do Portal — service com PostgreSQL real', () => {
  let contexto;
  let pool;
  let hashAtual;
  let sequencia = 0;
  const empresas = [];

  const um = async (sql, parametros) => (await pool.query(sql, parametros)).rows[0];
  const todos = async (sql, parametros) => (await pool.query(sql, parametros)).rows;

  async function novaIdentidade({ ativo = true } = {}) {
    sequencia += 1;
    const email = `pessoa-${sequencia}@example.invalid`;
    const { id } = await um('INSERT INTO identidades (email, senha_hash, ativo) VALUES ($1, $2, $3) RETURNING id', [email, hashAtual, ativo]);
    return { id, email, chave: cooldown.gerarChaveRecuperacaoSenha(ESCOPO, email) };
  }

  const pedidosDe = (identidadeId) => todos('SELECT * FROM redefinicoes_senha WHERE identidade_id = $1 ORDER BY id', [identidadeId]);
  const pendentesDe = async (identidadeId) => (await pedidosDe(identidadeId)).filter((p) => p.usado_em === null && p.cancelado_em === null);
  const solicitacoesDe = (chave) => todos('SELECT * FROM recuperacao_senha_solicitacoes WHERE chave = $1 ORDER BY id', [chave]);
  const auditoriaDe = (identidadeId) => todos('SELECT * FROM logs_auditoria_identidade WHERE identidade_id = $1 ORDER BY id', [identidadeId]);
  const hashDaSenha = async (identidadeId) => (await um('SELECT senha_hash FROM identidades WHERE id = $1', [identidadeId])).senha_hash;

  const solicitar = (email, executor = pool) => servico().solicitar(executor, { escopo: ESCOPO, email, ip: IP, dispositivo: DISPOSITIVO });
  const redefinir = (tokenClaro, novaSenha = SENHA_NOVA, executor = pool) => servico().redefinir(executor, {
    escopo: ESCOPO, token: tokenClaro, novaSenha, ip: IP, dispositivo: DISPOSITIVO,
  });

  /** Solicita e devolve o token em claro que a entrega recebeu. */
  async function pedirToken(caixa, email) {
    const antes = caixa.redefinicoes.length;
    assert.deepEqual(await solicitar(email), RESPOSTA);
    assert.equal(caixa.redefinicoes.length, antes + 1, 'a solicitação deveria ter enfileirado um e-mail');
    return caixa.redefinicoes.at(-1).token;
  }

  /** Sessões da identidade em duas empresas, mais as de outra pessoa. */
  async function comSessoes(identidade) {
    const vizinha = await novaIdentidade();
    const usuario = async (empresaId, identidadeId) => (await um(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Pessoa', NULL, NULL, 'USUARIO', $2) RETURNING id", [empresaId, identidadeId],
    )).id;
    const global = async (identidadeId) => (await um(
      "INSERT INTO sessoes_globais (identidade_id, token_hash, expira_em) VALUES ($1, $2, now() + interval '1 hour') RETURNING id", [identidadeId, hashDeToken()],
    )).id;
    const empresarial = async (empresaId, usuarioId, sessaoGlobalId) => (await um(
      "INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, sessao_global_id) VALUES ($1, $2, $3, now() + interval '1 hour', $4) RETURNING id",
      [empresaId, usuarioId, hashDeToken(), sessaoGlobalId],
    )).id;

    const usuarioA = await usuario(empresas[0], identidade.id);
    const usuarioB = await usuario(empresas[1], identidade.id);
    const usuarioVizinho = await usuario(empresas[0], vizinha.id);
    const globais = [await global(identidade.id), await global(identidade.id)];
    const empresariais = [
      await empresarial(empresas[0], usuarioA, globais[0]),
      await empresarial(empresas[1], usuarioB, globais[0]),
      await empresarial(empresas[0], usuarioA, globais[1]),
      await empresarial(empresas[1], usuarioB, null),
    ];
    const globalVizinha = await global(vizinha.id);
    const empresarialVizinha = await empresarial(empresas[0], usuarioVizinho, globalVizinha);
    return { vizinha, globais, empresariais, globalVizinha, empresarialVizinha };
  }

  const motivosGlobais = (ids) => todos('SELECT id, motivo_revogacao FROM sessoes_globais WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]);
  const motivosEmpresariais = (ids) => todos('SELECT id, motivo_revogacao FROM sessoes WHERE id = ANY($1::bigint[]) ORDER BY id', [ids]);
  const totalDeSessoes = async () => (await um('SELECT (SELECT count(*) FROM sessoes_globais)::int + (SELECT count(*) FROM sessoes)::int AS n')).n;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    hashAtual = await password.gerarHashSenha(SENHA_ATUAL);
    empresas.push(await criarEmpresa(pool, CNPJS[0], 'Empresa Alfa'));
    empresas.push(await criarEmpresa(pool, CNPJS[1], 'Empresa Beta'));
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('controle das fixtures', () => {
    test('a identidade de teste autentica com a senha atual pelo login global existente', async () => {
      const identidade = await novaIdentidade();
      const resultado = await loginGlobalService.autenticar(pool, { email: identidade.email, senha: SENHA_ATUAL });
      assert.equal(resultado.identidade.id, identidade.id);
      assert.equal(await password.verificarSenha(await hashDaSenha(identidade.id), SENHA_ATUAL), true);
    });

    test('as sessões de teste cobrem duas empresas, duas sessões globais e uma empresarial sem global, todas ativas', async () => {
      const identidade = await novaIdentidade();
      const sessoes = await comSessoes(identidade);
      assert.deepEqual((await motivosGlobais(sessoes.globais)).map((s) => s.motivo_revogacao), [null, null]);
      assert.deepEqual((await motivosEmpresariais(sessoes.empresariais)).map((s) => s.motivo_revogacao), Array(4).fill(null));
      assert.deepEqual((await motivosGlobais([sessoes.globalVizinha])).map((s) => s.motivo_revogacao), [null]);
      assert.notEqual(sessoes.vizinha.id, identidade.id);
    });

    test('o pedido expirado de teste nasce vencido e ainda pendente', async () => {
      const identidade = await novaIdentidade();
      const tokenClaro = token.gerarTokenSessao();
      await inserirPedido(pool, TABELA, identidade.id, { tokenHash: token.hashTokenSessao(tokenClaro), criadoHaMinutos: 120, validadeMinutos: 60 });
      const lido = await redefinicaoRepo.buscarPorHash(pool, token.hashTokenSessao(tokenClaro));
      assert.deepEqual([lido.identidadeId, lido.situacao, lido.usadoEm, lido.canceladoEm], [identidade.id, 'EXPIRADA', null, null]);
    });

    test('o harness de concorrência enxerga uma conexão parada numa trava consultiva e distingue linha travada de linha livre', async () => {
      const identidade = await novaIdentidade();
      const chave64 = cooldown.derivarAdvisoryLock64(identidade.chave);
      const trava = await segurarTravaConsultiva(pool, chave64);
      const espiao = poolEspiao(pool);
      const segunda = await espiao.connect();
      try {
        await segunda.query('BEGIN');
        const espera = segunda.query('SELECT pg_advisory_xact_lock($1::bigint)', [chave64]);
        try {
          assert.deepEqual(await aguardarEmEspera(pool, espiao, 1, 'advisory'), [segunda.processID]);
        } finally {
          await trava.soltar();
        }
        await espera;
        await segunda.query('SELECT id FROM identidades WHERE id = $1 FOR UPDATE', [identidade.id]);
        assert.equal(await sondarLinha(pool, 'identidades', identidade.id), 'TRAVADA');
        await segunda.query('COMMIT');
        assert.equal(await sondarLinha(pool, 'identidades', identidade.id), 'LIVRE');
      } finally {
        await segunda.query('ROLLBACK').catch(() => {});
        segunda.release();
      }
    });
  });

  describe('solicitação', () => {
    test('conta ativa: pedido pendente só com o hash do token, validade de 60 minutos, solicitação pela chave HMAC, auditoria do sistema e um e-mail', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      assert.deepEqual(await solicitar(identidade.email), RESPOSTA);

      assert.equal(caixa.redefinicoes.length, 1);
      const mensagem = caixa.redefinicoes[0];
      assert.deepEqual([mensagem.escopo, mensagem.email], [ESCOPO, identidade.email]);
      assert.equal(token.tokenSessaoTemFormatoValido(mensagem.token), true, 'token opaco de 32 bytes');

      const [pedido, ...outros] = await pedidosDe(identidade.id);
      assert.deepEqual(outros, []);
      assert.equal(pedido.token_hash, token.hashTokenSessao(mensagem.token));
      assert.equal(pedido.expira_em.getTime() - pedido.criado_em.getTime(), 60 * 60_000, 'validade padrão de 60 minutos');
      assert.equal(mensagem.expiraEm.getTime(), pedido.expira_em.getTime());
      assert.deepEqual([pedido.usado_em, pedido.cancelado_em, pedido.ip, pedido.dispositivo], [null, null, IP, DISPOSITIVO]);
      assert.equal(JSON.stringify(pedido).includes(mensagem.token), false, 'o token em claro não está em coluna alguma');

      const [solicitacao, ...demais] = await solicitacoesDe(identidade.chave);
      assert.deepEqual(demais, []);
      assert.deepEqual([solicitacao.escopo, solicitacao.ip, solicitacao.dispositivo], [ESCOPO, IP, DISPOSITIVO]);

      const [evento, ...resto] = await auditoriaDe(identidade.id);
      assert.deepEqual(resto, []);
      assert.deepEqual([evento.ator_tipo, evento.acao, evento.referencia], ['SISTEMA', 'REDEFINICAO_SENHA_SOLICITADA', pedido.id]);
      assert.deepEqual(evento.contexto, { pedidosSubstituidos: 0, validadeMinutos: 60 });
    });

    test('novo pedido cancela o pendente anterior, e o token antigo deixa de valer', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const primeiro = await pedirToken(caixa, identidade.email);
      const segundo = await pedirToken(caixa, identidade.email);
      assert.notEqual(primeiro, segundo);

      const pedidos = await pedidosDe(identidade.id);
      assert.deepEqual(pedidos.map((p) => p.motivo_cancelamento), ['SUBSTITUIDA', null]);
      assert.equal((await pendentesDe(identidade.id)).length, 1);

      await assert.rejects(() => redefinir(primeiro), INVALIDA);
      assert.equal(await hashDaSenha(identidade.id), hashAtual, 'senha intacta');
      assert.deepEqual(await redefinir(segundo), { status: 'SENHA_REDEFINIDA' });
    });

    test('limite de 3 por hora: a quarta solicitação recebe a mesma resposta e não registra, não cria pedido e não envia e-mail', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      for (let i = 0; i < 3; i += 1) assert.deepEqual(await solicitar(identidade.email), RESPOSTA);
      assert.equal(caixa.redefinicoes.length, 3);
      const pendenteAntes = (await pendentesDe(identidade.id))[0];

      for (let i = 0; i < 3; i += 1) assert.deepEqual(await solicitar(identidade.email), RESPOSTA);

      assert.equal(caixa.redefinicoes.length, 3, 'nenhum e-mail além dos três');
      assert.equal((await solicitacoesDe(identidade.chave)).length, 3, 'tentativa limitada não vira linha');
      assert.equal((await pedidosDe(identidade.id)).length, 3);
      assert.deepEqual((await pendentesDe(identidade.id)).map((p) => p.id), [pendenteAntes.id], 'o link vigente continua valendo');
      assert.deepEqual(await redefinir(caixa.redefinicoes.at(-1).token), { status: 'SENHA_REDEFINIDA' });
    });

    test('a janela é de 60 minutos pelo relógio do banco: solicitação mais antiga não conta', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      await pool.query(
        "INSERT INTO recuperacao_senha_solicitacoes (escopo, chave, criado_em) SELECT $1, $2, now() - interval '61 minutes' FROM generate_series(1, 3)", [ESCOPO, identidade.chave],
      );
      assert.deepEqual(await solicitar(identidade.email), RESPOSTA);
      assert.equal(caixa.redefinicoes.length, 1);
      assert.equal((await solicitacoesDe(identidade.chave)).length, 4);
    });

    test('conta inexistente: mesma resposta e mesma linha de solicitação; nenhum pedido, nenhuma auditoria, nenhum e-mail; o limite vale igual', async (t) => {
      const caixa = capturarEntrega(t);
      sequencia += 1;
      const email = `ninguem-${sequencia}@example.invalid`;
      const chave = cooldown.gerarChaveRecuperacaoSenha(ESCOPO, email);
      const pedidosAntes = (await um('SELECT count(*)::int AS n FROM redefinicoes_senha')).n;
      const auditoriaAntes = (await um('SELECT count(*)::int AS n FROM logs_auditoria_identidade')).n;

      for (let i = 0; i < 5; i += 1) assert.deepEqual(await solicitar(email), RESPOSTA);

      const linhas = await solicitacoesDe(chave);
      assert.equal(linhas.length, 3, 'três registradas, as demais limitadas');
      assert.deepEqual([linhas[0].escopo, linhas[0].ip, linhas[0].dispositivo], [ESCOPO, IP, DISPOSITIVO]);
      assert.equal(caixa.redefinicoes.length, 0);
      assert.equal((await um('SELECT count(*)::int AS n FROM redefinicoes_senha')).n, pedidosAntes);
      assert.equal((await um('SELECT count(*)::int AS n FROM logs_auditoria_identidade')).n, auditoriaAntes);
    });

    test('conta inativa: mesma resposta, sem pedido e sem e-mail; a recusa fica na trilha como evento do sistema', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade({ ativo: false });
      assert.deepEqual(await solicitar(identidade.email), RESPOSTA);
      assert.equal(caixa.redefinicoes.length, 0);
      assert.deepEqual(await pedidosDe(identidade.id), []);
      assert.equal((await solicitacoesDe(identidade.chave)).length, 1);
      const eventos = await auditoriaDe(identidade.id);
      assert.deepEqual(eventos.map((e) => [e.ator_tipo, e.acao]), [['SISTEMA', 'REDEFINICAO_SENHA_RECUSADA']]);
      assert.deepEqual(eventos[0].contexto, { etapa: 'SOLICITACAO', motivo: 'CONTA_INATIVA' });
    });

    test('existente, inexistente, inativa, limitada e e-mail inválido devolvem exatamente a mesma resposta', async (t) => {
      capturarEntrega(t);
      const ativa = await novaIdentidade();
      const inativa = await novaIdentidade({ ativo: false });
      const limitada = await novaIdentidade();
      for (let i = 0; i < 3; i += 1) await solicitar(limitada.email);

      const respostas = [
        await solicitar(ativa.email), await solicitar(`ninguem-${sequencia}-x@example.invalid`), await solicitar(inativa.email),
        await solicitar(limitada.email), await solicitar('isto não é e-mail'),
      ];
      assert.deepEqual([...new Set(respostas.map((r) => JSON.stringify(r)))], [JSON.stringify(RESPOSTA)]);
      for (const resposta of respostas) assert.deepEqual(Object.keys(resposta), ['status']);
    });

    test('o e-mail só é enfileirado depois do COMMIT: no instante da entrega, outra conexão já enxerga o pedido', async (t) => {
      const espiao = poolEspiao(pool);
      const noInstante = [];
      const visiveis = [];
      const caixa = capturarEntrega(t, {
        aoEnfileirar: (tipo, mensagem) => {
          // Fotografia síncrona do que já concluiu na conexão do service, tirada dentro da própria chamada da entrega.
          noInstante.push({ tipo, concluidos: concluidosNaConexao(espiao, espiao.pids[0]) });
          visiveis.push(pool.query('SELECT count(*)::int AS n FROM redefinicoes_senha WHERE token_hash = $1', [token.hashTokenSessao(mensagem.token)]));
        },
      });
      const identidade = await novaIdentidade();
      await solicitar(identidade.email, espiao);

      assert.equal(caixa.redefinicoes.length, 1);
      assert.equal(espiao.pids.length, 1, 'uma única conexão do service');
      assert.deepEqual(noInstante.map((f) => f.tipo), ['REDEFINICAO']);
      const { concluidos } = noInstante[0];
      assert.equal(concluidos[0], 'BEGIN');
      assert.equal(concluidos.at(-1), 'COMMIT', 'no instante da entrega, o último comando concluído na conexão do service é o COMMIT');
      assert.deepEqual(concluidos.filter((c) => c === 'BEGIN' || c === 'COMMIT' || c === 'ROLLBACK'), ['BEGIN', 'COMMIT']);
      assert.equal(concluidos.some((c) => /INSERT INTO redefinicoes_senha/.test(c)), true, 'o pedido foi gravado nessa mesma transação');

      // Complemento: depois do COMMIT o pedido é visível para outra conexão.
      assert.deepEqual((await Promise.all(visiveis)).map((r) => r.rows[0].n), [1]);
    });

    test('falha interna depois de criar o pedido: ROLLBACK real, nenhum e-mail e a mesma resposta', async (t) => {
      const caixa = capturarEntrega(t);
      const console_ = espiarConsole(t);
      const identidade = await novaIdentidade();
      const falha = t.mock.method(auditoriaIdentidadeRepo, 'registrarEventoSistema', async () => { throw new Error('falha simulada na auditoria'); });

      assert.deepEqual(await solicitar(identidade.email), RESPOSTA);

      assert.equal(falha.mock.calls.length, 1, 'a falha aconteceu dentro da transação, depois do pedido');
      assert.deepEqual(await pedidosDe(identidade.id), [], 'pedido desfeito');
      assert.deepEqual(await solicitacoesDe(identidade.chave), [], 'solicitação desfeita');
      assert.equal(caixa.redefinicoes.length, 0, 'nenhum e-mail de operação abortada');
      const erros = console_.filter((l) => l.metodo === 'error');
      assert.equal(erros.length, 1);
      assert.match(erros[0].texto, /solicitacao_falhou/);
      assert.equal(erros[0].texto.includes(identidade.email), false);
    });
  });

  describe('concorrência das solicitações', () => {
    test('trava consultiva pela chave HMAC: com a chave ocupada por outra conexão, a solicitação espera e nada é gravado', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const espiao = poolEspiao(pool);
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(identidade.chave));
      let emAndamento;
      try {
        emAndamento = solicitar(identidade.email, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.deepEqual(await solicitacoesDe(identidade.chave), []);
        assert.deepEqual(await pedidosDe(identidade.id), []);
        assert.equal(caixa.redefinicoes.length, 0);
      } finally {
        await trava.soltar();
      }
      assert.deepEqual(await emAndamento, RESPOSTA);
      assert.equal((await solicitacoesDe(identidade.chave)).length, 1);
      assert.equal(caixa.redefinicoes.length, 1);
    });

    test('a trava é por e-mail: solicitação de outra conta não espera', async (t) => {
      const caixa = capturarEntrega(t);
      const ocupada = await novaIdentidade();
      const livre = await novaIdentidade();
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(ocupada.chave));
      try {
        assert.deepEqual(await solicitar(livre.email), RESPOSTA);
        assert.equal(caixa.redefinicoes.length, 1);
      } finally {
        await trava.soltar();
      }
    });

    test('duas solicitações simultâneas da mesma conta, em duas conexões: as duas são atendidas em série e sobra um único pedido pendente', async (t) => {
      const caixa = capturarEntrega(t);
      const console_ = espiarConsole(t);
      const identidade = await novaIdentidade();
      const espiao = poolEspiao(pool);
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(identidade.chave));
      let emAndamento;
      try {
        emAndamento = [solicitar(identidade.email, espiao), solicitar(identidade.email, espiao)];
        const esperando = await aguardarEmEspera(pool, espiao, 2, 'advisory');
        assert.equal(new Set(esperando).size, 2, 'duas conexões distintas paradas na mesma trava');
      } finally {
        await trava.soltar();
      }
      assert.deepEqual(await Promise.all(emAndamento), [RESPOSTA, RESPOSTA]);

      const pedidos = await pedidosDe(identidade.id);
      assert.equal(pedidos.length, 2, 'as duas solicitações criaram pedido; nenhuma se perdeu em erro');
      assert.deepEqual(pedidos.map((p) => p.motivo_cancelamento).sort(), ['SUBSTITUIDA', null].sort());
      assert.equal((await pendentesDe(identidade.id)).length, 1);
      assert.equal((await solicitacoesDe(identidade.chave)).length, 2);
      assert.equal(caixa.redefinicoes.length, 2);
      assert.deepEqual(console_.filter((l) => l.metodo === 'error'), [], 'nenhuma falha engolida');

      const pendente = (await pendentesDe(identidade.id))[0];
      const hashes = caixa.redefinicoes.map((m) => token.hashTokenSessao(m.token));
      assert.equal(hashes.includes(pendente.token_hash), true);
      assert.equal(pedidos.every((p) => hashes.includes(p.token_hash)), true);
    });

    test('limite sob concorrência: com 2 já aceitas, de 4 simultâneas só 1 é aceita', async (t) => {
      const caixa = capturarEntrega(t);
      const console_ = espiarConsole(t);
      const identidade = await novaIdentidade();
      await solicitar(identidade.email);
      await solicitar(identidade.email);
      assert.equal(caixa.redefinicoes.length, 2);

      const espiao = poolEspiao(pool);
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(identidade.chave));
      let emAndamento;
      try {
        emAndamento = Array.from({ length: 4 }, () => solicitar(identidade.email, espiao));
        await aguardarEmEspera(pool, espiao, 4, 'advisory');
      } finally {
        await trava.soltar();
      }
      assert.deepEqual(await Promise.all(emAndamento), [RESPOSTA, RESPOSTA, RESPOSTA, RESPOSTA]);

      assert.equal((await solicitacoesDe(identidade.chave)).length, 3, 'o limite de 3 não é ultrapassado');
      assert.equal(caixa.redefinicoes.length, 3);
      assert.equal((await pedidosDe(identidade.id)).length, 3);
      assert.equal((await pendentesDe(identidade.id)).length, 1);
      assert.deepEqual(console_.filter((l) => l.metodo === 'error'), []);
    });

    test('SELECT ... FOR UPDATE da conta, e conta antes do pedido: enquanto o pedido ainda não foi gravado, a linha da identidade já está travada', async (t) => {
      capturarEntrega(t);
      const identidade = await novaIdentidade();
      const outra = await novaIdentidade();
      const pausa = pausarEm(t, redefinicaoRepo, 'criar');
      const emAndamento = solicitar(identidade.email);
      try {
        await pausa.chegou;
        assert.equal(await sondarLinha(pool, 'identidades', identidade.id), 'TRAVADA');
        assert.equal(await sondarLinha(pool, 'identidades', outra.id), 'LIVRE', 'só a linha da conta é travada');
        assert.deepEqual(await pedidosDe(identidade.id), [], 'nenhum pedido antes da trava da conta');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await emAndamento, RESPOSTA);
      assert.equal(await sondarLinha(pool, 'identidades', identidade.id), 'LIVRE', 'trava solta no fim da transação');
      assert.equal((await pendentesDe(identidade.id)).length, 1);
    });
  });

  describe('redefinição pelo link', () => {
    test('token válido: senha trocada, pedido consumido, todas as sessões revogadas, nenhuma sessão criada, auditoria e aviso depois do COMMIT', async (t) => {
      const espiao = poolEspiao(pool);
      const noInstante = [];
      const visiveis = [];
      const identidade = await novaIdentidade();
      const caixa = capturarEntrega(t, {
        aoEnfileirar: (tipo) => {
          if (tipo !== 'AVISO') return;
          // Fotografia síncrona do que já concluiu na conexão do reset, tirada dentro da própria chamada do aviso.
          noInstante.push(concluidosNaConexao(espiao, espiao.pids[0]));
          visiveis.push(pool.query('SELECT senha_hash FROM identidades WHERE id = $1', [identidade.id]));
        },
      });
      const sessoes = await comSessoes(identidade);
      const tokenClaro = await pedirToken(caixa, identidade.email);
      const sessoesAntes = await totalDeSessoes();

      // Só o reset passa pelo espião: os comandos registrados são os da transação dele.
      const resultado = await redefinir(tokenClaro, SENHA_NOVA, espiao);
      assert.deepEqual(resultado, { status: 'SENHA_REDEFINIDA' });

      assert.equal(espiao.pids.length, 1, 'uma única conexão do reset');
      assert.equal(noInstante.length, 1, 'um aviso enfileirado');
      const [concluidos] = noInstante;
      assert.equal(concluidos[0], 'BEGIN');
      assert.equal(concluidos.at(-1), 'COMMIT', 'no instante do aviso, o último comando concluído na conexão do reset é o COMMIT');
      assert.deepEqual(concluidos.filter((c) => c === 'BEGIN' || c === 'COMMIT' || c === 'ROLLBACK'), ['BEGIN', 'COMMIT']);
      assert.equal(concluidos.some((c) => /UPDATE identidades\s+SET senha_hash/.test(c)), true, 'a troca da senha foi gravada nessa mesma transação');

      const hashNovo = await hashDaSenha(identidade.id);
      assert.notEqual(hashNovo, hashAtual);
      assert.equal(await password.verificarSenha(hashNovo, SENHA_NOVA), true);
      assert.equal(await password.verificarSenha(hashNovo, SENHA_ATUAL), false);

      const [pedido] = await pedidosDe(identidade.id);
      assert.ok(pedido.usado_em instanceof Date);
      assert.equal(pedido.cancelado_em, null);

      assert.deepEqual((await motivosGlobais(sessoes.globais)).map((s) => s.motivo_revogacao), ['SENHA_REDEFINIDA', 'SENHA_REDEFINIDA']);
      assert.deepEqual((await motivosEmpresariais(sessoes.empresariais)).map((s) => s.motivo_revogacao), Array(4).fill('SENHA_REDEFINIDA'));
      assert.deepEqual((await motivosGlobais([sessoes.globalVizinha])).map((s) => s.motivo_revogacao), [null], 'outra identidade intocada');
      assert.deepEqual((await motivosEmpresariais([sessoes.empresarialVizinha])).map((s) => s.motivo_revogacao), [null]);
      assert.equal(await hashDaSenha(sessoes.vizinha.id), hashAtual);
      assert.equal(await totalDeSessoes(), sessoesAntes, 'nenhuma sessão nova');

      const eventos = await auditoriaDe(identidade.id);
      assert.deepEqual(eventos.map((e) => [e.ator_tipo, e.acao]), [['SISTEMA', 'REDEFINICAO_SENHA_SOLICITADA'], ['SISTEMA', 'SENHA_REDEFINIDA']]);
      assert.equal(eventos[1].referencia, pedido.id);
      assert.deepEqual([eventos[1].ip, eventos[1].dispositivo], [IP, DISPOSITIVO]);
      assert.deepEqual(eventos[1].contexto, { origem: 'LINK', sessoesGlobaisRevogadas: 2, sessoesEmpresariaisRevogadas: 4, pedidosCancelados: 0 });

      assert.deepEqual(caixa.avisos, [{ escopo: ESCOPO, email: identidade.email }]);
      assert.deepEqual((await Promise.all(visiveis)).map((r) => r.rows[0].senha_hash), [hashNovo], 'no instante do aviso a troca já estava confirmada');
    });

    test('depois do reset, o login com a senha antiga falha e com a nova funciona', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      await redefinir(await pedirToken(caixa, identidade.email));
      await assert.rejects(
        () => loginGlobalService.autenticar(pool, { email: identidade.email, senha: SENHA_ATUAL }),
        (erro) => erro instanceof HttpError && erro.codigo === 'CREDENCIAIS_INVALIDAS',
      );
      const login = await loginGlobalService.autenticar(pool, { email: identidade.email, senha: SENHA_NOVA });
      assert.equal(login.identidade.id, identidade.id);
    });

    test('replay: o mesmo token não vale duas vezes e a segunda tentativa não troca a senha de novo', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);
      await redefinir(tokenClaro, SENHA_NOVA);
      const hashDepois = await hashDaSenha(identidade.id);

      await assert.rejects(() => redefinir(tokenClaro, OUTRA_SENHA), INVALIDA);
      assert.equal(await hashDaSenha(identidade.id), hashDepois);
      assert.equal(caixa.avisos.length, 1);
      const recusa = (await auditoriaDe(identidade.id)).at(-1);
      assert.deepEqual([recusa.ator_tipo, recusa.acao, recusa.contexto], ['SISTEMA', 'REDEFINICAO_SENHA_RECUSADA', { etapa: 'REDEFINICAO', motivo: 'PEDIDO_USADO' }]);
    });

    test('dez redefinições simultâneas com o mesmo token: exatamente uma vence', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);
      const espiao = poolEspiao(pool);

      const resultados = await Promise.allSettled(Array.from({ length: 10 }, () => redefinir(tokenClaro, SENHA_NOVA, espiao)));

      assert.equal(new Set(espiao.pids).size > 1, true, 'mais de uma conexão real');
      assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(resultados.filter((r) => r.status === 'rejected' && INVALIDA(r.reason)).length, 9);
      assert.equal(caixa.avisos.length, 1);
      assert.equal(await password.verificarSenha(await hashDaSenha(identidade.id), SENHA_NOVA), true);
    });

    test('token expirado é recusado; a senha fica intacta e a validade do pedido não é estendida', async (t) => {
      capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = token.gerarTokenSessao();
      const pedido = await inserirPedido(pool, TABELA, identidade.id, { tokenHash: token.hashTokenSessao(tokenClaro), criadoHaMinutos: 120, validadeMinutos: 60 });
      const antes = (await pedidosDe(identidade.id))[0];
      assert.ok(pedido);

      await assert.rejects(() => redefinir(tokenClaro), INVALIDA);

      const depois = (await pedidosDe(identidade.id))[0];
      assert.equal(depois.expira_em.getTime(), antes.expira_em.getTime());
      assert.deepEqual([depois.usado_em, depois.cancelado_em], [null, null]);
      assert.equal(await hashDaSenha(identidade.id), hashAtual);
      const recusa = (await auditoriaDe(identidade.id)).at(-1);
      assert.deepEqual(recusa.contexto, { etapa: 'REDEFINICAO', motivo: 'PEDIDO_EXPIRADO' });
    });

    test('token desconhecido e token malformado recebem o mesmo erro do token expirado, sem tocar em nada', async (t) => {
      capturarEntrega(t);
      const auditoriaAntes = (await um('SELECT count(*)::int AS n FROM logs_auditoria_identidade')).n;
      const erros = [];
      for (const ruim of [token.gerarTokenSessao(), 'token-malformado', '']) {
        await assert.rejects(() => redefinir(ruim), (erro) => { erros.push(JSON.stringify(erro.corpoResposta())); return INVALIDA(erro); });
      }
      assert.equal(new Set(erros).size, 1, 'corpo de erro idêntico');
      assert.equal((await um('SELECT count(*)::int AS n FROM logs_auditoria_identidade')).n, auditoriaAntes);
    });

    test('nova senha igual à atual é recusada: pedido continua pendente, sessões intactas, e o mesmo link ainda serve para outra senha', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const sessoes = await comSessoes(identidade);
      const tokenClaro = await pedirToken(caixa, identidade.email);

      await assert.rejects(
        () => redefinir(tokenClaro, SENHA_ATUAL),
        (erro) => erro instanceof HttpError && erro.status === 400 && erro.codigo === 'SENHA_IGUAL_A_ATUAL',
      );
      assert.equal(await hashDaSenha(identidade.id), hashAtual);
      assert.equal((await pendentesDe(identidade.id)).length, 1);
      assert.deepEqual((await motivosGlobais(sessoes.globais)).map((s) => s.motivo_revogacao), [null, null]);
      assert.equal(caixa.avisos.length, 0);

      assert.deepEqual(await redefinir(tokenClaro, SENHA_NOVA), { status: 'SENHA_REDEFINIDA' });
    });

    test('senha fora da política é recusada com as regras violadas e o pedido continua pendente', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);
      await assert.rejects(
        () => redefinir(tokenClaro, 'Zx9!kq'),
        (erro) => erro instanceof HttpError && erro.codigo === 'VALIDACAO' && erro.detalhes.some((d) => d.codigo === 'SENHA_CURTA'),
      );
      await assert.rejects(
        () => redefinir(tokenClaro, `${identidade.email}-2026`),
        (erro) => erro instanceof HttpError && erro.codigo === 'VALIDACAO' && erro.detalhes.some((d) => d.codigo === 'SENHA_CONTEM_EMAIL'),
      );
      assert.equal(await hashDaSenha(identidade.id), hashAtual);
      assert.equal((await pendentesDe(identidade.id)).length, 1);
    });

    test('conta inativada depois do pedido: o link deixa de valer', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);
      await pool.query('UPDATE identidades SET ativo = false WHERE id = $1', [identidade.id]);

      await assert.rejects(() => redefinir(tokenClaro), INVALIDA);
      assert.equal(await hashDaSenha(identidade.id), hashAtual);
      assert.deepEqual((await auditoriaDe(identidade.id)).at(-1).contexto, { etapa: 'REDEFINICAO', motivo: 'CONTA_INATIVA' });
    });

    test('ordem das travas no reset: com a conta já travada, a linha do pedido ainda está livre', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);
      const pedido = (await pendentesDe(identidade.id))[0];
      const pausa = pausarEm(t, redefinicaoRepo, 'buscarPorHashParaAtualizacao');
      const emAndamento = redefinir(tokenClaro);
      try {
        await pausa.chegou;
        assert.equal(await sondarLinha(pool, 'identidades', identidade.id), 'TRAVADA');
        assert.equal(await sondarLinha(pool, 'redefinicoes_senha', pedido.id), 'LIVRE');
      } finally {
        pausa.liberar();
      }
      assert.deepEqual(await emAndamento, { status: 'SENHA_REDEFINIDA' });
    });

    test('o reset usa a primitiva de trava da conta do repositório', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);
      const original = identidadeRepo.buscarPorIdParaAtualizacao;
      assert.equal(typeof original, 'function', 'primitiva de trava da conta ausente');
      const espia = t.mock.method(identidadeRepo, 'buscarPorIdParaAtualizacao', (...argumentos) => original(...argumentos));
      await redefinir(tokenClaro);
      assert.deepEqual(espia.mock.calls.map((c) => c.arguments[1]), [identidade.id]);
    });

    test('reset e login não se cruzam: com a chave de login da conta ocupada, o reset espera e a senha ainda é a antiga', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);
      const espiao = poolEspiao(pool);
      const trava = await segurarTravaConsultiva(pool, cooldown.derivarAdvisoryLock64(cooldown.gerarChaveCooldownGlobal(identidade.email)));
      let emAndamento;
      try {
        emAndamento = redefinir(tokenClaro, SENHA_NOVA, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await hashDaSenha(identidade.id), hashAtual);
        assert.equal(await sondarLinha(pool, 'identidades', identidade.id), 'LIVRE', 'a trava consultiva vem antes da linha da conta');
      } finally {
        await trava.soltar();
      }
      assert.deepEqual(await emAndamento, { status: 'SENHA_REDEFINIDA' });
    });

    test('compatível com o login existente: um login real em andamento segura o reset, e a sessão que ele abre é revogada em seguida', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);
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

      const login = loginGlobalService.autenticar(pool, { email: identidade.email, senha: SENHA_ATUAL });
      let reset;
      try {
        await chegou.promessa;
        reset = redefinir(tokenClaro, SENHA_NOVA, espiao);
        await aguardarEmEspera(pool, espiao, 1, 'advisory');
        assert.equal(await hashDaSenha(identidade.id), hashAtual, 'o reset não avança enquanto o login não termina');
      } finally {
        liberar.resolver();
      }
      const { sessao } = await login;
      assert.deepEqual(await reset, { status: 'SENHA_REDEFINIDA' });
      assert.deepEqual((await motivosGlobais([sessao.id])).map((s) => s.motivo_revogacao), ['SENHA_REDEFINIDA'], 'a sessão aberta com a senha antiga não sobrevive');
    });

    test('logins reais simultâneos com a senha antiga e o reset: sem deadlock, e nenhuma sessão aberta com a senha antiga fica viva', async (t) => {
      const caixa = capturarEntrega(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);

      const [reset, ...logins] = await Promise.allSettled([
        redefinir(tokenClaro),
        ...Array.from({ length: 4 }, () => loginGlobalService.autenticar(pool, { email: identidade.email, senha: SENHA_ATUAL })),
      ]);

      assert.equal(reset.status, 'fulfilled', String(reset.reason?.code ?? reset.reason?.message));
      for (const login of logins) {
        if (login.status === 'rejected') {
          assert.notEqual(login.reason?.code, DEADLOCK);
          assert.equal(login.reason instanceof HttpError && login.reason.codigo === 'CREDENCIAIS_INVALIDAS', true, 'login depois do reset: senha antiga recusada');
        }
      }
      assert.deepEqual(await todos('SELECT id FROM sessoes_globais WHERE identidade_id = $1 AND revogada_em IS NULL', [identidade.id]), []);
      assert.equal(await password.verificarSenha(await hashDaSenha(identidade.id), SENHA_NOVA), true);
    });

    test('reset e novas solicitações ao mesmo tempo terminam sem deadlock e sem dois pedidos pendentes', async (t) => {
      const caixa = capturarEntrega(t);
      const console_ = espiarConsole(t);
      const identidade = await novaIdentidade();
      const tokenClaro = await pedirToken(caixa, identidade.email);

      const [reset, ...solicitacoes] = await Promise.allSettled([redefinir(tokenClaro), solicitar(identidade.email), solicitar(identidade.email)]);

      assert.deepEqual(solicitacoes.map((r) => r.status), ['fulfilled', 'fulfilled']);
      assert.equal(reset.status === 'fulfilled' || INVALIDA(reset.reason), true, 'o reset vence ou encontra o pedido substituído');
      assert.notEqual(reset.reason?.code, DEADLOCK);
      assert.equal(console_.some((l) => l.texto.includes(DEADLOCK) || l.texto.includes('solicitacao_falhou')), false, 'nenhuma falha engolida');
      assert.equal((await pendentesDe(identidade.id)).length <= 1, true);
      assert.equal((await solicitacoesDe(identidade.chave)).length, 3);
    });
  });

  describe('dados sensíveis', () => {
    test('nem a trilha de auditoria, nem as tabelas do ciclo de senha, nem o console guardam token, link, senha ou e-mail', async (t) => {
      const caixa = capturarEntrega(t);
      const console_ = espiarConsole(t);
      const identidade = await novaIdentidade();
      const inativa = await novaIdentidade({ ativo: false });
      await comSessoes(identidade);

      const primeiro = await pedirToken(caixa, identidade.email);
      const segundo = await pedirToken(caixa, identidade.email);
      await solicitar(inativa.email);
      await assert.rejects(() => redefinir(primeiro), INVALIDA);
      await assert.rejects(() => redefinir(segundo, SENHA_ATUAL));
      await redefinir(segundo, SENHA_NOVA);
      await assert.rejects(() => redefinir(segundo, OUTRA_SENHA), INVALIDA);

      const hashNovo = await hashDaSenha(identidade.id);
      const despejo = async (tabela, filtro, parametros) => (await todos(`SELECT row_to_json(t)::text AS linha FROM ${tabela} t WHERE ${filtro}`, parametros)).map((l) => l.linha).join('\n');
      const auditoria = await despejo('logs_auditoria_identidade', 'identidade_id = ANY($1::int[])', [[identidade.id, inativa.id]]);
      const solicitacoes = await despejo('recuperacao_senha_solicitacoes', 'chave = ANY($1::text[])', [[identidade.chave, inativa.chave]]);
      const pedidos = await despejo('redefinicoes_senha', 'identidade_id = $1', [identidade.id]);
      const tecnico = console_.map((l) => l.texto).join('\n');
      assert.notEqual(auditoria, '');

      const segredos = [primeiro, segundo, '#token=', 'redefinir-senha.html', SENHA_ATUAL, SENHA_NOVA, OUTRA_SENHA];
      const emails = [identidade.email, inativa.email, 'example.invalid'];
      for (const valor of [...segredos, ...emails, hashNovo, hashAtual]) {
        assert.equal(auditoria.includes(valor), false, `auditoria contém ${valor.slice(0, 8)}…`);
        assert.equal(tecnico.includes(valor), false, `console contém ${valor.slice(0, 8)}…`);
      }
      for (const valor of [...segredos, ...emails]) {
        assert.equal(solicitacoes.includes(valor), false, `solicitações contêm ${valor.slice(0, 8)}…`);
        assert.equal(pedidos.includes(valor), false, `pedidos contêm ${valor.slice(0, 8)}…`);
      }
      for (const hash of [primeiro, segundo].map((tk) => token.hashTokenSessao(tk))) {
        assert.equal(auditoria.includes(hash), false, 'nem o hash do token vai para a auditoria');
      }
    });
  });
});
