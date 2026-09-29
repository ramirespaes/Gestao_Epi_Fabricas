'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const totpReferencia = require('../helpers/totp-referencia');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarPainelPlataformaRoutes } = require('../../src/routes/painel-plataforma.routes');
const { painelPlataformaController } = require('../../src/controllers/painel-plataforma.controller');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarExigirDesafioMfa } = require('../../src/middleware/desafio-mfa-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const liberacaoService = require('../../src/services/liberacao-cadastro-mfa-plataforma.service');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const liberacaoRepo = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');
const codigosMfa = require('../../src/security/codigos-mfa');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');
const scriptLiberacao = require('../../scripts/mfa-liberar-cadastro');

/**
 * Primeiro cadastro do TOTP do Painel Privado contra PostgreSQL real
 * (schema temporário, 000–054): CLI de liberação, LIBERACAO -> CADASTRO,
 * reinício, confirmação com recovery codes e sessão plena, concorrência,
 * falha criptográfica fail-closed e ausência de segredos em banco e log.
 *
 * O "aplicativo autenticador" é test/helpers/totp-referencia.js (RFC 6238
 * com node:crypto), não a biblioteca que o servidor usa para validar.
 */

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '049', '050', '051', '052', '053', '054', '055', '056'];
const SENHA = 'planeta-nebulosa-ozonio-42';
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
const COOKIE_DESAFIO = () => authConfig.desafioMfa.cookieNome;

/** Promessa que o próprio teste resolve: barreira entre transações. */
function sinal() {
  let resolver;
  const promessa = new Promise((r) => { resolver = r; });
  return { promessa, resolver };
}

/** Falha com mensagem clara em vez de pendurar o teste. */
function comPrazo(promessa, ms, mensagem) {
  let relogio;
  const prazo = new Promise((_, rejeitar) => { relogio = setTimeout(() => rejeitar(new Error(mensagem)), ms); });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
}

function setCookie(resposta, nome) {
  const bruto = (resposta.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${nome}=`));
  if (bruto === undefined) return null;
  const [par, ...resto] = bruto.split(';').map((p) => p.trim());
  const atributos = {};
  for (const parte of resto) {
    const i = parte.indexOf('=');
    atributos[(i === -1 ? parte : parte.slice(0, i)).toLowerCase()] = i === -1 ? true : parte.slice(i + 1);
  }
  return { valor: par.slice(nome.length + 1), atributos, par };
}

describe('cadastro do primeiro TOTP do Painel Privado (PostgreSQL real)', () => {
  let contexto;
  let app;
  let hashSenha;
  let sequencia = 0;

  const q = (sql, params) => contexto.pool.query(sql, params);
  const post = (caminho, cookie, corpo = {}) => {
    const r = request(app).post(`/api/plataforma${caminho}`).send(corpo);
    return cookie ? r.set('Cookie', cookie) : r;
  };

  async function novoAdministrador(prefixo = 'adm') {
    sequencia += 1;
    const email = `${prefixo}-${sequencia}-${crypto.randomBytes(3).toString('hex')}@safework.com.br`;
    const id = (await q('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hashSenha])).rows[0].id;
    return { id, email };
  }

  /** Login por senha: devolve o par "nome=token" do cookie do desafio. */
  async function entrar(email) {
    const r = await post('/auth/login', null, { email, senha: SENHA });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return setCookie(r, COOKIE_DESAFIO());
  }

  /** Administrador em CADASTRO: liberação pelo CLI, login, liberação consumida. */
  async function emCadastro() {
    const admin = await novoAdministrador('cad');
    const { codigo } = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
    const desafio = await entrar(admin.email);
    const r = await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: codigo });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return { admin, cookie: setCookie(r, COOKIE_DESAFIO()), cadastro: r.body.cadastro, codigoLiberacao: codigo };
  }

  const contar = async (sql, params) => (await q(sql, params)).rows[0].n;
  const pendentes = (id) => contar("SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'PENDENTE'", [id]);
  const ativos = (id) => contar("SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [id]);
  const desafioDoToken = async (token) => (await q('SELECT * FROM desafios_mfa_plataforma WHERE token_hash = $1', [sha256(token)])).rows[0];

  before(async () => {
    hashSenha = await gerarHashSenha(SENHA);
    contexto = await abrirPoolTemporario(MIGRATIONS);
    const { pool } = contexto;
    const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    app = criarAppTeste((a) => {
      a.use(
        '/api/plataforma',
        criarAuthPlataformaRoutes({
          controller: criarAuthPlataformaController({ pool }),
          limitador: semLimite(),
          limitadorMfa: semLimite(),
          exigirSessaoPlataforma,
          desafioMfa: (tipos) => criarExigirDesafioMfa({ pool, tipos }),
        }),
        criarPainelPlataformaRoutes({ controller: painelPlataformaController, exigirSessaoPlataforma }),
      );
    });
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('CLI de liberação', () => {
    const capturar = () => {
      const logs = [];
      const erros = [];
      return { logs, erros, saida: { log: (m) => logs.push(String(m)), error: (m) => erros.push(String(m)) } };
    };

    test('válido: imprime o código uma vez; o banco guarda só o hash, com 30 min, origem CLI_LIBERACAO; auditoria OPERACAO_CLI com o alvo', async () => {
      const admin = await novoAdministrador('cli');
      const { logs, saida } = capturar();

      const saidaCli = await scriptLiberacao.executarComando({ email: admin.email, confirmo: true }, { pool: contexto.pool, saida });

      assert.equal(saidaCli, scriptLiberacao.SAIDAS.OK);
      const texto = logs.join('\n');
      const codigo = texto.match(/[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}/)[0];
      assert.equal(texto.split(codigo).length - 1, 1);
      const { rows: [liberacao] } = await q(
        `SELECT codigo_hash, origem, round(extract(epoch FROM (expira_em - criado_em)))::int AS prazo, consumida_em, revogada_em
           FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1`,
        [admin.id],
      );
      assert.deepEqual(liberacao, {
        codigo_hash: codigosMfa.hashCodigoLiberacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(codigo) }),
        origem: 'CLI_LIBERACAO', prazo: authConfig.liberacaoMfa.expiracaoMinutos * 60, consumida_em: null, revogada_em: null,
      });
      const { rows: [auditoria] } = await q(
        "SELECT ator_tipo, administrador_id, administrador_afetado_id, row_to_json(l)::text AS linha FROM logs_auditoria_plataforma l WHERE acao = 'LIBERACAO_CADASTRO_CRIADA' AND administrador_afetado_id = $1",
        [admin.id],
      );
      assert.deepEqual([auditoria.ator_tipo, auditoria.administrador_id, auditoria.administrador_afetado_id], ['OPERACAO_CLI', null, admin.id]);
      assert.equal(auditoria.linha.includes(codigo), false);
      assert.equal(auditoria.linha.includes(codigosMfa.normalizarCodigo(codigo)), false);
    });

    test('recusas: inexistente, inativo e já com TOTP ativo, cada uma com a sua saída, sem emitir nada', async () => {
      const inativo = await novoAdministrador('inativo');
      await q('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [inativo.id]);
      const comTotp = await novoAdministrador('totp');
      const fatorUid = crypto.randomUUID();
      const envelope = mfaCripto.cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: comTotp.id, fatorUid });
      const fator = await fatorRepo.criarPendenteTotp(contexto.pool, { administradorId: comTotp.id, fatorUid, envelope, validadeMinutos: 15 });
      await fatorRepo.ativarTotp(contexto.pool, { administradorId: comTotp.id, fatorId: fator.id, step: 1 });

      for (const [email, esperado] of [
        ['ninguem@safework.com.br', scriptLiberacao.SAIDAS.ADMINISTRADOR_INEXISTENTE],
        [inativo.email, scriptLiberacao.SAIDAS.ADMINISTRADOR_INATIVO],
        [comTotp.email, scriptLiberacao.SAIDAS.TOTP_ATIVO],
      ]) {
        const { logs, saida } = capturar();
        assert.equal(await scriptLiberacao.executarComando({ email, confirmo: true }, { pool: contexto.pool, saida }), esperado, email);
        assert.doesNotMatch(logs.join('\n'), /código:/);
      }
      assert.equal(await contar('SELECT count(*)::int AS n FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = ANY($1)', [[inativo.id, comTotp.id]]), 0);
    });

    test('emissão sucessiva: a nova revoga a anterior; só a última vale no endpoint', async () => {
      const admin = await novoAdministrador('suc');
      const primeira = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const segunda = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });

      const { rows } = await q('SELECT revogada_em IS NOT NULL AS revogada, motivo_revogacao FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id]);
      assert.deepEqual(rows, [{ revogada: true, motivo_revogacao: 'SUBSTITUIDA' }, { revogada: false, motivo_revogacao: null }]);

      const desafio = await entrar(admin.email);
      assert.equal((await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: primeira.codigo })).status, 401);
      assert.equal((await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: segunda.codigo })).status, 200);
    });

    test('liberação vencida não vale; depois de usada, não vale de novo (uso único)', async () => {
      const admin = await novoAdministrador('venc');
      const vencida = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      await q("UPDATE liberacoes_cadastro_mfa_plataforma SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE administrador_id = $1", [admin.id]);
      const desafio = await entrar(admin.email);
      assert.deepEqual((await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: vencida.codigo })).body.codigo, 'MFA_CODIGO_INVALIDO');

      const valida = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      assert.equal((await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: valida.codigo })).status, 200);
      const outroDesafio = await entrar(admin.email);
      assert.equal((await post('/auth/mfa/liberacao', outroDesafio.par, { codigoLiberacao: valida.codigo })).status, 401);
    });

    // Disputa forçada, não "duas execuções rápidas": a 1ª emissão pelo CLI
    // para logo depois do INSERT, com a transação aberta; a 2ª só conta como
    // em disputa depois de o banco mostrá-la bloqueada; o outro administrador
    // emite com as duas nesse estado. Tudo é medido durante a retenção e
    // conferido depois de soltar, começando pelo desfecho da 2ª: sem a trava,
    // a primeira falha exibida é a própria corrida. O wait_event é só
    // diagnóstico.
    test('concorrência: emissões sobrepostas do mesmo administrador são serializadas pela trava; outro administrador não espera', async (t) => {
      const admin = await novoAdministrador('trava');
      const outro = await novoAdministrador('livre');
      const inicial = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const abertasDe = async (id) => (await q(
        'SELECT codigo_hash FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 AND consumida_em IS NULL AND revogada_em IS NULL',
        [id],
      )).rows.map((l) => l.codigo_hash);
      const hashDe = (administradorId, codigo) => codigosMfa.hashCodigoLiberacao({ administradorId, codigo: codigosMfa.normalizarCodigo(codigo) });

      const travarOriginal = travaRepo.travarAdministrador;
      const criarOriginal = liberacaoRepo.criar;
      const primeiraRetida = sinal();
      const segundaChegou = sinal();
      const portao = sinal();
      const pids = [];
      t.mock.method(travaRepo, 'travarAdministrador', async (executor, administradorId) => {
        if (administradorId === admin.id) {
          pids.push(executor.processID);
          if (pids.length === 2) segundaChegou.resolver();
        }
        return travarOriginal(executor, administradorId);
      });
      let retidas = 0;
      t.mock.method(liberacaoRepo, 'criar', async (executor, dados) => {
        const criada = await criarOriginal(executor, dados);
        if (dados.administradorId === admin.id && retidas === 0) {
          retidas += 1;
          primeiraRetida.resolver();
          await portao.promessa;
        }
        return criada;
      });

      // Cada execução do CLI guarda a própria saída; o código impresso fica só na memória do teste.
      const cli = (email) => {
        const logs = [];
        const saida = { log: (m) => logs.push(String(m)), error: (m) => logs.push(String(m)) };
        return { logs, execucao: scriptLiberacao.executarComando({ email, confirmo: true }, { pool: contexto.pool, saida }) };
      };
      const impresso = (execucao) => {
        const texto = execucao.logs.join('\n');
        return {
          codigo: texto.match(/[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}/)?.[0] ?? null,
          validaAte: texto.match(/válida até: (\S+)/)?.[1] ?? null,
        };
      };

      let primeira;
      let segunda;
      let doOutro;
      const disputa = {};
      let resultados;
      try {
        primeira = cli(admin.email);
        await primeiraRetida.promessa;
        segunda = cli(admin.email);
        await segundaChegou.promessa;
        disputa.esperaDaSegunda = await aguardarEsperaPeloLock(contexto.pool, pids[1]);

        doOutro = cli(outro.email);
        const inicio = process.hrtime.bigint();
        await comPrazo(doOutro.execucao, 5000, 'a emissão de outro administrador ficou presa atrás da trava do primeiro');
        disputa.outroConcluiuEmMs = Number((process.hrtime.bigint() - inicio) / 1_000_000n);

        // Fotografia tirada DEPOIS de o outro concluir: a 1ª segue retida e a 2ª, esperando.
        ({ rows: disputa.trava } = await q(
          `SELECT pid, granted FROM pg_locks
            WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
              AND classid = $1::oid AND objid = $2::oid AND objsubid = 2
            ORDER BY granted DESC`,
          [travaRepo.ESPACO_TRAVA_ADMINISTRADOR_MFA, admin.id],
        ));
        ({ rows: disputa.transacoes } = await q(
          `SELECT pid, state, wait_event_type, wait_event FROM pg_stat_activity
            WHERE pid = ANY($1::int[]) ORDER BY array_position($1::int[], pid)`,
          [pids],
        ));
        // De fora, a 1ª ainda não existe: a transação dela segue aberta.
        disputa.abertasDoAdministrador = await abertasDe(admin.id);
        disputa.abertasDoOutro = await abertasDe(outro.id);
      } finally {
        portao.resolver();
        resultados = await Promise.allSettled([primeira?.execucao, segunda?.execucao, doOutro?.execucao]);
      }
      const [r1, r2, rOutro] = resultados;
      const concluiu = (r) => r.status === 'fulfilled' && r.value === scriptLiberacao.SAIDAS.OK;
      const desfecho = (r, execucao) => `${r.status === 'rejected'
        ? `rejeitada com ${r.reason.code ?? '?'} ${r.reason.constraint ?? ''} (${r.reason.message})`
        : `saída ${r.value}`}; código impresso: ${impresso(execucao).codigo === null ? 'nenhum' : 'sim'}`;

      t.diagnostic(`disputa: ${JSON.stringify({
        trava: { detentor: pids[0], aguardando: pids[1], pgLocks: disputa.trava },
        transacoes: disputa.transacoes,
        esperaDaSegunda: disputa.esperaDaSegunda,
        vistoDeFora: { abertasDoAdministrador: disputa.abertasDoAdministrador?.length, abertasDoOutro: disputa.abertasDoOutro?.length },
        outroAdministradorConcluiuEmMs: disputa.outroConcluiuEmMs,
        desfechos: { primeira: desfecho(r1, primeira), segunda: desfecho(r2, segunda), outro: desfecho(rOutro, doOutro) },
      })}`);

      assert.ok(concluiu(r1), `1ª emissão pelo CLI não concluiu: ${desfecho(r1, primeira)}`);
      assert.ok(concluiu(r2), `2ª emissão pelo CLI não concluiu: ${desfecho(r2, segunda)}`);
      assert.ok(concluiu(rOutro), `emissão do outro administrador não concluiu: ${desfecho(rOutro, doOutro)}`);

      // Serialização pela trava: a 1ª detinha o advisory lock do administrador e a 2ª o aguardava.
      assert.deepEqual(disputa.trava, [{ pid: pids[0], granted: true }, { pid: pids[1], granted: false }]);
      assert.deepEqual(disputa.transacoes.map((x) => [x.pid, x.state]), [[pids[0], 'idle in transaction'], [pids[1], 'active']]);
      assert.equal(disputa.transacoes[1].wait_event_type, 'Lock');
      assert.deepEqual(disputa.abertasDoAdministrador, [hashDe(admin.id, inicial.codigo)]);

      // O outro administrador concluiu, com commit visível, enquanto a trava do primeiro seguia retida.
      assert.deepEqual(disputa.abertasDoOutro, [hashDe(outro.id, impresso(doOutro).codigo)]);

      // Estado final: a inicial e a 1ª revogadas como SUBSTITUIDA; aberta só a da 2ª, que concluiu.
      const { rows: liberacoes } = await q(
        `SELECT id, codigo_hash, consumida_em, revogada_em IS NOT NULL AS revogada, motivo_revogacao, expira_em
           FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 ORDER BY id`,
        [admin.id],
      );
      assert.deepEqual(
        liberacoes.map((l) => [l.codigo_hash, l.revogada, l.motivo_revogacao, l.consumida_em]),
        [
          [hashDe(admin.id, inicial.codigo), true, 'SUBSTITUIDA', null],
          [hashDe(admin.id, impresso(primeira).codigo), true, 'SUBSTITUIDA', null],
          [hashDe(admin.id, impresso(segunda).codigo), false, null, null],
        ],
      );
      assert.equal(liberacoes[2].expira_em.toISOString(), impresso(segunda).validaAte);

      // Uma auditoria por liberação emitida, na ordem, com ator CLI e o prazo gravado.
      const { rows: auditorias } = await q(
        `SELECT referencia, ator_tipo, administrador_id, contexto, dados_novos
           FROM logs_auditoria_plataforma WHERE acao = 'LIBERACAO_CADASTRO_CRIADA' AND administrador_afetado_id = $1 ORDER BY id`,
        [admin.id],
      );
      assert.deepEqual(auditorias, liberacoes.map((l) => ({
        referencia: String(l.id),
        ator_tipo: 'OPERACAO_CLI',
        administrador_id: null,
        contexto: { origem: 'CLI_LIBERACAO' },
        dados_novos: { expiraEm: l.expira_em.toISOString() },
      })));
    });
  });

  describe('criação de administrador pelo CLI', () => {
    test('nasce com liberação CLI_CRIACAO; auditoria OPERACAO_CLI com o novo administrador como alvo; sem TOTP nem sessão', async () => {
      const criado = await criarInicial(contexto.pool, { email: 'novo.admin@safework.com.br', senha: SENHA });

      const { rows: auditorias } = await q(
        'SELECT acao, ator_tipo, administrador_id, administrador_afetado_id FROM logs_auditoria_plataforma WHERE administrador_afetado_id = $1 ORDER BY id',
        [criado.id],
      );
      assert.deepEqual(auditorias, [
        { acao: 'ADMINISTRADOR_PLATAFORMA_CRIADO', ator_tipo: 'OPERACAO_CLI', administrador_id: null, administrador_afetado_id: criado.id },
        { acao: 'LIBERACAO_CADASTRO_CRIADA', ator_tipo: 'OPERACAO_CLI', administrador_id: null, administrador_afetado_id: criado.id },
      ]);
      assert.equal(await contar("SELECT count(*)::int AS n FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1 AND origem = 'CLI_CRIACAO' AND consumida_em IS NULL AND revogada_em IS NULL", [criado.id]), 1);
      assert.equal(await contar('SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1', [criado.id]), 0);
      assert.equal(await contar('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1', [criado.id]), 0);

      const desafio = await entrar('novo.admin@safework.com.br');
      assert.equal((await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: criado.liberacao.codigo })).status, 200, 'a liberação da criação serve para o primeiro cadastro');
    });
  });

  describe('POST /auth/mfa/liberacao', () => {
    test('sucesso: CADASTRO com token novo, PENDENTE cifrado, liberação consumida; só URI e chave manual na resposta', async () => {
      const admin = await novoAdministrador('lib');
      const { codigo } = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const desafio = await entrar(admin.email);

      const r = await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: codigo.toLowerCase() });

      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body).sort(), ['cadastro', 'etapa', 'expiraEm', 'status']);
      assert.deepEqual(Object.keys(r.body.cadastro).sort(), ['chaveManual', 'uri']);
      assert.equal(r.body.etapa, 'CADASTRO');
      assert.match(r.body.cadastro.uri, /^otpauth:\/\/totp\/SafeWork:/);
      assert.equal(r.body.cadastro.uri.includes(encodeURIComponent(admin.email)), true, 'o e-mail só aparece como rótulo da URI');
      // O id numérico curto pode surgir por acaso na chave ou na data: as chaves exatas do corpo já cobrem isso.
      const corpoSemUri = JSON.stringify({ ...r.body, cadastro: { chaveManual: r.body.cadastro.chaveManual } });
      assert.equal(corpoSemUri.includes(admin.email), false);

      const novoCookie = setCookie(r, COOKIE_DESAFIO());
      assert.notEqual(novoCookie.valor, desafio.valor, 'token novo a cada transição');
      assert.equal(novoCookie.atributos['max-age'], String(authConfig.desafioMfa.cadastroMinutos * 60));
      const anterior = await desafioDoToken(desafio.valor);
      const atual = await desafioDoToken(novoCookie.valor);
      assert.deepEqual([anterior.tipo, anterior.motivo_encerramento], ['LIBERACAO', 'TRANSICAO']);
      assert.deepEqual([atual.tipo, atual.encerrado_em, atual.desafio_anterior_id], ['CADASTRO', null, anterior.id]);

      const { rows: [fator] } = await q('SELECT * FROM fatores_mfa_plataforma WHERE id = $1', [atual.fator_pendente_id]);
      assert.equal(fator.estado, 'PENDENTE');
      const segredo = totpReferencia.segredoDaChaveManual(r.body.cadastro.chaveManual);
      assert.equal(fator.totp_segredo_cifrado.includes(segredo), false, 'o secret nunca fica em claro');
      const decifrado = mfaCripto.decifrarSegredoTotp({
        administradorId: admin.id, fatorUid: fator.fator_uid, formatoVersao: fator.totp_formato_versao, chaveVersao: fator.totp_chave_versao,
        nonce: fator.totp_nonce, segredoCifrado: fator.totp_segredo_cifrado,
      });
      assert.equal(decifrado.equals(segredo), true);
      assert.notEqual((await q('SELECT consumida_em FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1', [admin.id])).rows[0].consumida_em, null);
      assert.equal(await contar('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1', [admin.id]), 0, 'liberação não cria sessão');
    });

    test('código errado: 401 genérico, falha contada, nada criado; com TOTP já ativo o desafio é VERIFICACAO e a rota recusa', async () => {
      const admin = await novoAdministrador('errado');
      await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const desafio = await entrar(admin.email);

      const r = await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' });

      assert.deepEqual([r.status, r.body], [401, { status: 'error', codigo: 'MFA_CODIGO_INVALIDO', message: 'Código inválido' }]);
      assert.equal((await desafioDoToken(desafio.valor)).falhas, 1);
      assert.equal(await contar("SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE administrador_id = $1 AND motivo = 'LIBERACAO_INVALIDA'", [admin.id]), 1);
      assert.equal(await pendentes(admin.id), 0);
      assert.equal((await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: 'A'.repeat(65) })).body.codigo, 'VALIDACAO');
    });

    test('falha criptográfica: 503, liberação preservada, desafio intacto, nenhum PENDENTE, evento SISTEMA; depois o mesmo código funciona', async (t) => {
      const admin = await novoAdministrador('cripto');
      const { codigo } = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const desafio = await entrar(admin.email);
      const logs = [];
      t.mock.method(console, 'error', (...args) => logs.push(args));

      t.mock.method(mfaCripto, 'cifrarSegredoTotp', () => { throw new mfaCripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL'); });
      const falhou = await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: codigo });
      assert.deepEqual([falhou.status, falhou.body.codigo], [503, 'MFA_INDISPONIVEL']);
      t.mock.restoreAll();

      assert.equal((await q('SELECT consumida_em FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1', [admin.id])).rows[0].consumida_em, null);
      const intacto = await desafioDoToken(desafio.valor);
      assert.deepEqual([intacto.encerrado_em, intacto.falhas], [null, 0]);
      assert.equal(await pendentes(admin.id), 0);
      assert.equal(await contar("SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE administrador_id = $1 AND NOT sucesso", [admin.id]), 0);
      const { rows: [evento] } = await q(
        "SELECT ator_tipo, administrador_id, administrador_afetado_id, contexto FROM logs_auditoria_plataforma WHERE acao = 'MFA_CHAVE_INDISPONIVEL' AND administrador_afetado_id = $1",
        [admin.id],
      );
      assert.deepEqual(evento, { ator_tipo: 'SISTEMA', administrador_id: null, administrador_afetado_id: admin.id, contexto: { operacao: 'liberacao', motivo: 'CHAVE_INDISPONIVEL' } });
      assert.equal(JSON.stringify(logs).includes(codigo), false);

      assert.equal((await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: codigo })).status, 200, 'a liberação não foi consumida pela falha de infraestrutura');
    });

    test('chave atual indisponível antes da transação: 503 sem tocar em nada', async (t) => {
      const admin = await novoAdministrador('semchave');
      const { codigo } = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const desafio = await entrar(admin.email);
      t.mock.method(console, 'error', () => {});
      t.mock.method(mfaCripto, 'garantirChaveAtual', () => { throw new mfaCripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL'); });

      assert.equal((await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: codigo })).status, 503);
      t.mock.restoreAll();
      assert.equal((await desafioDoToken(desafio.valor)).falhas, 0);
      assert.equal((await q('SELECT consumida_em FROM liberacoes_cadastro_mfa_plataforma WHERE administrador_id = $1', [admin.id])).rows[0].consumida_em, null);
    });

    test('concorrência: a mesma liberação em dois desafios simultâneos tem um único vencedor', async () => {
      const admin = await novoAdministrador('dupla');
      const { codigo } = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const d1 = await entrar(admin.email);
      const d2 = await entrar(admin.email);

      const [r1, r2] = await Promise.all([
        post('/auth/mfa/liberacao', d1.par, { codigoLiberacao: codigo }),
        post('/auth/mfa/liberacao', d2.par, { codigoLiberacao: codigo }),
      ]);

      assert.deepEqual([r1.status, r2.status].sort(), [200, 401]);
      assert.equal(await pendentes(admin.id), 1);
      assert.equal(await contar("SELECT count(*)::int AS n FROM desafios_mfa_plataforma WHERE administrador_id = $1 AND tipo = 'CADASTRO'", [admin.id]), 1);
    });
  });

  describe('POST /auth/mfa/cadastro/reiniciar', () => {
    test('até 3 reinícios, cada um com secret novo; o PENDENTE anterior perde o ciphertext; o 4º é recusado; nenhuma sessão', async () => {
      const { admin, cookie, cadastro } = await emCadastro();
      const chaves = [cadastro.chaveManual];

      for (let i = 1; i <= 3; i += 1) {
        const r = await post('/auth/mfa/cadastro/reiniciar', cookie.par);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.etapa, 'CADASTRO');
        assert.equal(r.headers['set-cookie'], undefined, 'o desafio continua o mesmo');
        chaves.push(r.body.cadastro.chaveManual);
      }
      assert.equal(new Set(chaves).size, 4);
      const quarto = await post('/auth/mfa/cadastro/reiniciar', cookie.par);
      assert.deepEqual([quarto.status, quarto.body.codigo], [409, 'MFA_CADASTRO_REINICIOS_ESGOTADOS']);

      assert.equal(await pendentes(admin.id), 1);
      const { rows } = await q("SELECT totp_nonce, totp_segredo_cifrado, motivo_revogacao FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'REVOGADO'", [admin.id]);
      assert.equal(rows.length, 3);
      for (const linha of rows) assert.deepEqual(linha, { totp_nonce: null, totp_segredo_cifrado: null, motivo_revogacao: 'REINICIADO' });
      assert.equal((await desafioDoToken(cookie.valor)).reinicios, 3);
      assert.equal(await contar('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1', [admin.id]), 0);
    });

    test('concorrência: 4 reinícios simultâneos dão 3 sucessos e 1 recusa; sobra um único PENDENTE', async () => {
      const { admin, cookie } = await emCadastro();

      const respostas = await Promise.all(Array.from({ length: 4 }, () => post('/auth/mfa/cadastro/reiniciar', cookie.par)));

      assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 200, 200, 409]);
      assert.equal(await pendentes(admin.id), 1);
      assert.equal((await desafioDoToken(cookie.valor)).reinicios, 3);
    });

    test('no estado LIBERACAO a rota recusa', async () => {
      const admin = await novoAdministrador('reini');
      const desafio = await entrar(admin.email);
      const r = await post('/auth/mfa/cadastro/reiniciar', desafio.par);
      assert.deepEqual([r.status, r.body.codigo], [401, 'DESAFIO_INVALIDO']);
    });
  });

  describe('POST /auth/mfa/cadastro/confirmar', () => {
    test('primeiro TOTP: fator ATIVO com o step aceito, 10 recovery codes, sessão plena nova com MFA CADASTRO; cookie do desafio removido', async () => {
      const { admin, cookie, cadastro } = await emCadastro();
      const antes = Date.now();
      const codigoTotp = totpReferencia.codigoAgora(cadastro.chaveManual, antes);

      const r = await post('/auth/mfa/cadastro/confirmar', cookie.par, { codigo: codigoTotp });

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['codigosRecuperacao', 'status']);
      assert.equal(r.body.codigosRecuperacao.length, 10);
      assert.equal(new Set(r.body.codigosRecuperacao).size, 10);

      const sessao = setCookie(r, authConfig.sessao.cookieNomeAdmin);
      assert.equal(sessao.atributos.httponly, true);
      assert.equal(sessao.atributos.path, '/');
      assert.equal(sessao.atributos['max-age'], String(authConfig.sessao.expiracaoMinutosAdmin * 60));
      assert.notEqual(sessao.valor, cookie.valor, 'o token do desafio nunca vira sessão');
      assert.deepEqual([setCookie(r, COOKIE_DESAFIO()).valor, setCookie(r, COOKIE_DESAFIO()).atributos['max-age']], ['', '0']);

      assert.equal((await request(app).get('/api/plataforma/auth/me').set('Cookie', sessao.par)).status, 200);
      assert.equal((await request(app).get('/api/plataforma/painel').set('Cookie', sessao.par)).status, 200);
      assert.equal((await request(app).get('/api/plataforma/auth/mfa/estado').set('Cookie', cookie.par)).status, 401, 'o desafio foi encerrado');

      const { rows: [fator] } = await q("SELECT id, estado, ativado_em, totp_ultimo_step_aceito FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [admin.id]);
      const step = Number(fator.totp_ultimo_step_aceito);
      assert.ok(Math.abs(step - totpReferencia.stepDe(antes)) <= 1, 'o step aceito é o do código confirmado');
      assert.equal(await fatorRepo.registrarStepAceito(contexto.pool, { administradorId: admin.id, fatorId: fator.id, step }), false, 'anti-replay: o mesmo step não é aceito de novo');
      assert.equal(await pendentes(admin.id), 0);

      const { rows: codigos } = await q(
        `SELECT c.codigo_hash FROM codigos_recuperacao_mfa_plataforma c
           JOIN lotes_recuperacao_mfa_plataforma l ON l.id = c.lote_id
          WHERE l.administrador_id = $1 AND l.estado = 'ATIVO' AND c.consumido_em IS NULL ORDER BY c.id`,
        [admin.id],
      );
      const esperados = r.body.codigosRecuperacao.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: admin.id, codigo: codigosMfa.normalizarCodigo(c) }));
      assert.deepEqual(codigos.map((c) => c.codigo_hash).sort(), [...esperados].sort());

      const { rows: [linhaSessao] } = await q(
        `SELECT id, mfa_metodo, mfa_verificado_em <= criado_em AS mfa_antes, round(extract(epoch FROM (expira_em - criado_em)) / 60)::int AS minutos
           FROM sessoes_plataforma WHERE token_hash = $1`,
        [sha256(sessao.valor)],
      );
      assert.deepEqual([linhaSessao.mfa_metodo, linhaSessao.mfa_antes, linhaSessao.minutos], ['CADASTRO', true, authConfig.sessao.expiracaoMinutosAdmin]);
      const desafio = await desafioDoToken(cookie.valor);
      assert.deepEqual([desafio.motivo_encerramento, desafio.sessao_criada_id], ['CONCLUIDO', linhaSessao.id]);
    });

    test('a sessão que o navegador já tinha é revogada (SUBSTITUIDA_NO_NAVEGADOR)', async () => {
      const { admin, cookie, cadastro } = await emCadastro();
      const antiga = await criarSessaoAdministrativa(contexto.pool, admin.id);

      const r = await post('/auth/mfa/cadastro/confirmar', `${antiga.cookie}; ${cookie.par}`, { codigo: totpReferencia.codigoAgora(cadastro.chaveManual) });

      assert.equal(r.status, 200);
      assert.equal((await q('SELECT motivo_revogacao FROM sessoes_plataforma WHERE id = $1', [antiga.id])).rows[0].motivo_revogacao, 'SUBSTITUIDA_NO_NAVEGADOR');
    });

    test('TOTP errado conta falha; no limite o desafio é encerrado e o cooldown de MFA passa a valer para o administrador', async () => {
      const { admin, cookie, cadastro } = await emCadastro();
      const certo = totpReferencia.codigoAgora(cadastro.chaveManual);
      const errado = certo === '000000' ? '000001' : '000000';

      for (let i = 0; i < authConfig.desafioMfa.maxFalhas; i += 1) {
        const r = await post('/auth/mfa/cadastro/confirmar', cookie.par, { codigo: errado });
        assert.deepEqual([r.status, r.body.codigo], [401, 'MFA_CODIGO_INVALIDO'], `tentativa ${i + 1}`);
      }
      assert.equal((await desafioDoToken(cookie.valor)).motivo_encerramento, 'FALHAS_EXCEDIDAS');
      assert.equal((await post('/auth/mfa/cadastro/confirmar', cookie.par, { codigo: certo })).body.codigo, 'DESAFIO_INVALIDO');
      assert.equal(await contar("SELECT count(*)::int AS n FROM login_tentativas_plataforma WHERE administrador_id = $1 AND motivo = 'TOTP_INVALIDO'", [admin.id]), authConfig.desafioMfa.maxFalhas);
      assert.ok(await contar("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE administrador_id = $1 AND acao = 'MFA_DESAFIO_ESGOTADO'", [admin.id]) >= 1);

      // O cooldown vale entre desafios: um desafio novo do mesmo administrador também recebe 429.
      await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const novo = await entrar(admin.email);
      const bloqueado = await post('/auth/mfa/liberacao', novo.par, { codigoLiberacao: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ' });
      assert.deepEqual([bloqueado.status, bloqueado.body.codigo], [429, 'MFA_EM_COOLDOWN']);
      assert.ok(Number(bloqueado.headers['retry-after']) > 0);
      assert.equal(await ativos(admin.id), 0);
    });

    test('concorrência: dois confirmar simultâneos com o mesmo TOTP têm um único vencedor; um ATIVO, um lote, uma sessão', async () => {
      const { admin, cookie, cadastro } = await emCadastro();
      const codigo = totpReferencia.codigoAgora(cadastro.chaveManual);

      const [r1, r2] = await Promise.all([
        post('/auth/mfa/cadastro/confirmar', cookie.par, { codigo }),
        post('/auth/mfa/cadastro/confirmar', cookie.par, { codigo }),
      ]);

      assert.deepEqual([r1.status, r2.status].sort(), [200, 401]);
      assert.equal(await ativos(admin.id), 1);
      assert.equal(await contar("SELECT count(*)::int AS n FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [admin.id]), 1);
      assert.equal(await contar('SELECT count(*)::int AS n FROM codigos_recuperacao_mfa_plataforma WHERE administrador_id = $1', [admin.id]), 10);
      assert.equal(await contar("SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1 AND mfa_metodo = 'CADASTRO'", [admin.id]), 1);
    });

    test('um segundo TOTP ATIVO nunca nasce: com outro já ativo, 409 e nada muda', async () => {
      const { admin, cookie, cadastro } = await emCadastro();
      await q(
        `INSERT INTO fatores_mfa_plataforma
           (fator_uid, administrador_id, tipo, estado, totp_formato_versao, totp_chave_versao, totp_nonce, totp_segredo_cifrado,
            totp_algoritmo, totp_digitos, totp_periodo, pendente_expira_em, ativado_em, totp_ultimo_step_aceito)
         VALUES ($1, $2, 'TOTP', 'ATIVO', 1, 1, $3, $4, 'SHA1', 6, 30, now() + interval '1 minute', now(), 1)`,
        [crypto.randomUUID(), admin.id, crypto.randomBytes(12), crypto.randomBytes(36)],
      );

      const r = await post('/auth/mfa/cadastro/confirmar', cookie.par, { codigo: totpReferencia.codigoAgora(cadastro.chaveManual) });

      assert.deepEqual([r.status, r.body.codigo], [409, 'MFA_JA_ATIVO']);
      assert.equal(await ativos(admin.id), 1);
      assert.equal(await pendentes(admin.id), 1);
      assert.equal(await contar('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1', [admin.id]), 0);
    });

    test('falha ao decifrar: 503, nada ativado, nenhuma falha contada, evento SISTEMA', async (t) => {
      const { admin, cookie, cadastro } = await emCadastro();
      t.mock.method(console, 'error', () => {});
      t.mock.method(mfaCripto, 'decifrarSegredoTotp', () => { throw new mfaCripto.ErroCriptografiaMfa('AUTENTICACAO_FALHOU'); });

      const r = await post('/auth/mfa/cadastro/confirmar', cookie.par, { codigo: totpReferencia.codigoAgora(cadastro.chaveManual) });

      t.mock.restoreAll();
      assert.deepEqual([r.status, r.body.codigo], [503, 'MFA_INDISPONIVEL']);
      assert.equal(await ativos(admin.id), 0);
      assert.equal((await desafioDoToken(cookie.valor)).falhas, 0);
      assert.equal(await contar("SELECT count(*)::int AS n FROM logs_auditoria_plataforma WHERE ator_tipo = 'SISTEMA' AND administrador_afetado_id = $1", [admin.id]), 1);
    });
  });

  describe('nenhum segredo em banco nem em log', () => {
    test('fluxo completo: liberação, secret, URI, TOTP, recovery codes e tokens nunca aparecem fora das respostas legítimas', async (t) => {
      const logs = [];
      for (const metodo of ['log', 'error', 'warn', 'info']) t.mock.method(console, metodo, (...args) => logs.push(args));

      const admin = await novoAdministrador('vazamento');
      const { codigo: liberacao } = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const desafio = await entrar(admin.email);
      const lib = await post('/auth/mfa/liberacao', desafio.par, { codigoLiberacao: liberacao });
      const cookieCadastro = setCookie(lib, COOKIE_DESAFIO());
      const { chaveManual, uri } = lib.body.cadastro;
      const codigoTotp = totpReferencia.codigoAgora(chaveManual);
      const fim = await post('/auth/mfa/cadastro/confirmar', cookieCadastro.par, { codigo: codigoTotp });
      assert.equal(fim.status, 200);
      const sessao = setCookie(fim, authConfig.sessao.cookieNomeAdmin);
      t.mock.restoreAll();

      const segredo = totpReferencia.segredoDaChaveManual(chaveManual);
      const longos = [
        liberacao, codigosMfa.normalizarCodigo(liberacao), chaveManual.replace(/ /g, ''), segredo.toString('hex'), segredo.toString('base64'), uri,
        desafio.valor, cookieCadastro.valor, sessao.valor,
        ...fim.body.codigosRecuperacao, ...fim.body.codigosRecuperacao.map((c) => codigosMfa.normalizarCodigo(c)),
      ];

      const tabelas = ['logs_auditoria_plataforma', 'login_tentativas_plataforma', 'desafios_mfa_plataforma', 'fatores_mfa_plataforma',
        'liberacoes_cadastro_mfa_plataforma', 'lotes_recuperacao_mfa_plataforma', 'codigos_recuperacao_mfa_plataforma', 'sessoes_plataforma'];
      for (const tabela of tabelas) {
        const { rows } = await q(`SELECT row_to_json(t)::text AS linha FROM ${tabela} t`);
        const texto = rows.map((r) => r.linha).join('\n');
        for (const valor of longos) assert.equal(texto.includes(valor), false, `${tabela} não pode conter segredo`);
      }
      // O código TOTP tem só 6 dígitos: confiro onde ele poderia ter sido gravado.
      const { rows: jsons } = await q('SELECT contexto::text AS c, dados_anteriores::text AS a, dados_novos::text AS n FROM logs_auditoria_plataforma WHERE administrador_id = $1', [admin.id]);
      for (const linha of jsons) assert.equal(JSON.stringify(linha).includes(codigoTotp), false);

      const textoLogs = JSON.stringify(logs);
      for (const valor of [...longos, codigoTotp]) assert.equal(textoLogs.includes(valor), false, 'log técnico sem segredo');
    });
  });
});
