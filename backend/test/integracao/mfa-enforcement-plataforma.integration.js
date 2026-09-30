'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const totpReferencia = require('../helpers/totp-referencia');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarPainelPlataformaRoutes } = require('../../src/routes/painel-plataforma.routes');
const { painelPlataformaController } = require('../../src/controllers/painel-plataforma.controller');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarExigirDesafioMfa } = require('../../src/middleware/desafio-mfa-plataforma');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const liberacaoService = require('../../src/services/liberacao-cadastro-mfa-plataforma.service');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const sessaoRepo = require('../../src/repositories/sessao-plataforma.repository');
const mfaCripto = require('../../src/security/mfa-cripto');
const codigosMfa = require('../../src/security/codigos-mfa');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');
const { gerarHashSenha } = require('../../src/security/password');
const { authConfig } = require('../../src/config/auth');

/**
 * Sessão plena do Painel Privado só vale se nasceu de um desafio de MFA
 * concluído. Duas camadas, provadas em separado:
 *   - a aplicação, num schema SEM a proteção do banco (até a 054), onde dá
 *     para gravar sessões incompatíveis como um produtor antigo gravaria;
 *   - o banco, no schema com todas as migrations existentes.
 */

const ATE_A_054 = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '030', '031', '048', '049', '050', '051', '052', '053', '054'];
const DIRETORIO = path.join(__dirname, '..', '..', 'migrations');
// Só as migrations da plataforma que vêm depois da 054: as da entrega de EPI
// (057 em diante) alteram tabelas que este schema não monta.
const POSTERIORES = ['055', '056'];
const SENHA = 'planeta-nebulosa-ozonio-42';
const COOKIE_SESSAO = () => authConfig.sessao.cookieNomeAdmin;
const COOKIE_DESAFIO = () => authConfig.desafioMfa.cookieNome;
const VIOLACAO_CHECK = '23514';
const VIOLACAO_UNICA = '23505';
const VIOLACAO_FK = '23503';
const GATILHO = 'trg_sessoes_plataforma_desafio_concluido';
const FK_SESSAO_CRIADA = 'fk_desafios_mfa_plataforma_sessao_criada_mesmo_administrador';
const TIPO_DO_METODO = { TOTP: 'VERIFICACAO', CADASTRO: 'CADASTRO', RECADASTRO: 'RECUPERACAO' };
const hashAleatorio = () => crypto.randomBytes(32).toString('hex');

let hashSenha;
let sequencia = 0;

function montar(pool) {
  const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
  const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
  return criarAppTeste((a) => {
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
}

function ambiente(contexto, app) {
  const q = (sql, params) => contexto().pool.query(sql, params);
  const um = async (sql, params) => (await q(sql, params)).rows[0];
  const get = (caminho, cookie) => request(app()).get(`/api/plataforma${caminho}`).set('Cookie', cookie);
  const post = (caminho, cookie, corpo = {}) => {
    const r = request(app()).post(`/api/plataforma${caminho}`).send(corpo);
    return cookie ? r.set('Cookie', cookie) : r;
  };

  async function administrador(prefixo, { comFator = true } = {}) {
    sequencia += 1;
    const email = `${prefixo}-${sequencia}-${crypto.randomBytes(3).toString('hex')}@safework.com.br`;
    const { id } = await um('INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id', [email, hashSenha]);
    if (!comFator) return { id, email };
    const segredo = crypto.randomBytes(20);
    const fatorUid = crypto.randomUUID();
    const envelope = mfaCripto.cifrarSegredoTotp({ segredo: Buffer.from(segredo), administradorId: id, fatorUid });
    const fator = await fatorRepo.criarPendenteTotp(contexto().pool, { administradorId: id, fatorUid, envelope, validadeMinutos: 15 });
    assert.equal(await fatorRepo.ativarTotp(contexto().pool, { administradorId: id, fatorId: fator.id, step: 1 }), true);
    const lote = await loteRepo.criar(contexto().pool, id);
    const codigos = Array.from({ length: 10 }, () => codigosMfa.gerarCodigo());
    await codigoRepo.inserirHashes(contexto().pool, {
      administradorId: id, loteId: lote.id, hashes: codigos.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: id, codigo: codigosMfa.normalizarCodigo(c) })),
    });
    return { id, email, segredo, fatorId: fator.id, codigos };
  }

  /**
   * Grava, numa transação só, a sessão e (se pedido) o desafio ligado a ela.
   * Os instantes são segundos antes de agora: desafio criado, MFA verificado,
   * desafio encerrado, sessão criada. Devolve o erro do banco, se houver.
   *
   * donoDoDesafio, ligarA, encerramento e ligado existem para montar os
   * casos que o banco deve recusar.
   */
  async function gravar(admin, {
    metodo = null, desafio = null, revogada = null, expiraEmSegundos = 8 * 3600, ultimoUsoHa = 28,
    desafioCriadoHa = 60, verificadoHa = 30, desafioEncerradoHa = 29, sessaoCriadaHa = 28,
    donoDoDesafio = admin, ligarA = null, encerramento = 'CONCLUIDO', ligado = true,
  } = {}) {
    const token = gerarTokenSessao();
    const cliente = await contexto().pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows: [s] } = await cliente.query(
        `INSERT INTO sessoes_plataforma
           (administrador_id, token_hash, criado_em, expira_em, ultimo_uso_em, revogada_em, motivo_revogacao, mfa_verificado_em, mfa_metodo)
         VALUES ($1, $2, clock_timestamp() - make_interval(secs => $3), clock_timestamp() + make_interval(secs => $4),
                 clock_timestamp() - make_interval(secs => $5), $6::timestamptz, $7,
                 CASE WHEN $8::text IS NULL THEN NULL ELSE clock_timestamp() - make_interval(secs => $9) END, $8)
         RETURNING id`,
        [admin.id, hashTokenSessao(token), sessaoCriadaHa, expiraEmSegundos, ultimoUsoHa, revogada === null ? null : new Date(), revogada, metodo, verificadoHa],
      );
      let desafioId = null;
      if (desafio !== null) {
        const origem = desafio === 'SUBSTITUICAO'
          ? (await cliente.query(
            `INSERT INTO sessoes_plataforma (administrador_id, token_hash, expira_em, revogada_em, motivo_revogacao)
             VALUES ($1, $2, now() + interval '1 hour', now(), 'MFA_SUBSTITUIDO') RETURNING id`,
            [admin.id, hashAleatorio()],
          )).rows[0].id
          : null;
        ({ rows: [{ id: desafioId }] } = await cliente.query(
          `INSERT INTO desafios_mfa_plataforma
             (administrador_id, token_hash, tipo, fator_pendente_id, sessao_origem_id, sessao_criada_id, criado_em, expira_em, encerrado_em, motivo_encerramento)
           VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() - make_interval(secs => $7), clock_timestamp() + interval '5 minutes',
                   CASE WHEN $9::text IS NULL THEN NULL ELSE clock_timestamp() - make_interval(secs => $8) END, $9)
           RETURNING id`,
          [donoDoDesafio.id, hashAleatorio(), desafio, desafio === 'VERIFICACAO' ? null : donoDoDesafio.fatorId, origem,
            ligado ? (ligarA ?? s.id) : null, desafioCriadoHa, desafioEncerradoHa, encerramento],
        ));
      }
      await cliente.query('COMMIT');
      return { ok: true, id: s.id, desafioId, token, cookie: `${COOKIE_SESSAO()}=${token}` };
    } catch (erro) {
      await cliente.query('ROLLBACK').catch(() => {});
      return { ok: false, code: erro.code, constraint: erro.constraint ?? null };
    } finally {
      cliente.release();
    }
  }

  const nascidaDoMfa = (admin, metodo, extra = {}) => gravar(admin, { metodo, desafio: TIPO_DO_METODO[metodo], ...extra });
  const linha = (id) => um('SELECT xmin::text AS xmin, revogada_em, motivo_revogacao, mfa_verificado_em, mfa_metodo, ultimo_uso_em FROM sessoes_plataforma WHERE id = $1', [id]);
  const restou = (admin) => um(
    `SELECT (SELECT count(*)::int FROM sessoes_plataforma WHERE administrador_id = $1) AS sessoes,
            (SELECT count(*)::int FROM desafios_mfa_plataforma WHERE administrador_id = $1) AS desafios`,
    [admin.id],
  );
  const cookieDe = (resposta, nome) => resposta.headers['set-cookie'].find((c) => c.startsWith(`${nome}=`)).split(';')[0];
  const stepAgora = async () => totpReferencia.stepDe((await um('SELECT clock_timestamp() AS t')).t.getTime());

  /** Sessão criada pelo fluxo real, com o desafio que a comprova. */
  const comprovada = (cookieSessao) => um(
    `SELECT s.mfa_metodo, s.revogada_em, d.tipo, d.motivo_encerramento, d.administrador_id = s.administrador_id AS mesmo_administrador,
            d.criado_em <= s.mfa_verificado_em AND s.mfa_verificado_em <= d.encerrado_em AND d.encerrado_em <= s.criado_em AS em_ordem
       FROM sessoes_plataforma s JOIN desafios_mfa_plataforma d ON d.sessao_criada_id = s.id
      WHERE s.token_hash = $1`,
    [hashTokenSessao(cookieSessao.split('=')[1])],
  );

  return { q, um, get, post, administrador, gravar, nascidaDoMfa, linha, restou, cookieDe, stepAgora, comprovada };
}

describe('enforcement do MFA nas sessões do Painel Privado (PostgreSQL real)', () => {
  before(async () => { hashSenha = await gerarHashSenha(SENHA); });

  describe('a aplicação recusa sessão sem MFA comprovado, mesmo num banco sem a proteção (schema até a 054)', () => {
    let contexto;
    let app;
    const a = ambiente(() => contexto, () => app);

    before(async () => {
      contexto = await abrirPoolTemporario(ATE_A_054);
      app = montar(contexto.pool);
    });
    after(async () => { if (contexto) await contexto.encerrar(); });

    const recusada = async (sessao, rotulo) => {
      assert.equal(sessao.ok, true, `${rotulo}: o schema até a 054 aceita gravar`);
      const antes = await a.linha(sessao.id);
      const r = await a.get('/auth/me', sessao.cookie);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], rotulo);
      assert.equal(r.body.administrador, undefined, rotulo);
      assert.equal((await a.get('/painel', sessao.cookie)).status, 401, `${rotulo}: painel`);
      assert.deepEqual(await a.linha(sessao.id), antes, `${rotulo}: a linha não é renovada, revogada nem consertada`);
    };

    test('A/J. produtor antigo: sessão gravada sem MFA não autentica em nenhuma rota', async () => {
      const admin = await a.administrador('antigo');
      const sessao = await a.gravar(admin);
      const lotes = () => a.q('SELECT id, estado FROM lotes_recuperacao_mfa_plataforma WHERE administrador_id = $1 ORDER BY id', [admin.id]).then((r) => r.rows);
      const antes = await lotes();

      await recusada(sessao, 'sem MFA');
      const r = await a.post('/auth/mfa/recuperacao/regenerar', sessao.cookie, { senha: SENHA, codigo: '123456' });
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], 'rota sensível com sessão');
      assert.equal(r.body.codigosRecuperacao, undefined);
      assert.deepEqual(await lotes(), antes, 'o lote de códigos não foi trocado');
      assert.deepEqual(antes.map((l) => l.estado), ['ATIVO']);
    });

    test('J. produtor que só declara o MFA, sem desafio concluído ligado, não autentica', async () => {
      const admin = await a.administrador('declarado');
      for (const metodo of ['TOTP', 'CADASTRO', 'RECADASTRO']) await recusada(await a.gravar(admin, { metodo }), `${metodo} sem desafio`);
    });

    test('método que não cria sessão (SUBSTITUICAO, REAUTENTICACAO) não autentica, com ou sem desafio ligado', async () => {
      const admin = await a.administrador('metodo');
      await recusada(await a.gravar(admin, { metodo: 'SUBSTITUICAO', desafio: 'SUBSTITUICAO' }), 'SUBSTITUICAO com desafio');
      await recusada(await a.gravar(admin, { metodo: 'REAUTENTICACAO' }), 'REAUTENTICACAO');
    });

    test('desafio ligado de tipo incompatível com o método não autentica', async () => {
      const admin = await a.administrador('tipo');
      await recusada(await a.gravar(admin, { metodo: 'TOTP', desafio: 'CADASTRO' }), 'TOTP com desafio CADASTRO');
      await recusada(await a.gravar(admin, { metodo: 'CADASTRO', desafio: 'VERIFICACAO' }), 'CADASTRO com desafio VERIFICACAO');
      await recusada(await a.gravar(admin, { metodo: 'RECADASTRO', desafio: 'CADASTRO' }), 'RECADASTRO com desafio CADASTRO');
    });

    test('instante do MFA fora da vida do desafio não autentica', async () => {
      const admin = await a.administrador('instante');
      await recusada(await a.nascidaDoMfa(admin, 'TOTP', { desafioCriadoHa: 60, verificadoHa: 90 }), 'verificado antes de o desafio existir');
      await recusada(await a.nascidaDoMfa(admin, 'TOTP', { desafioEncerradoHa: 29, verificadoHa: 20, sessaoCriadaHa: 10, ultimoUsoHa: 10 }), 'verificado depois de o desafio encerrar');
    });

    test('B/C/D. sessão nascida de desafio concluído vale para TOTP, CADASTRO e RECADASTRO', async () => {
      for (const metodo of ['TOTP', 'CADASTRO', 'RECADASTRO']) {
        const admin = await a.administrador(`valida${metodo.toLowerCase()}`);
        const sessao = await a.nascidaDoMfa(admin, metodo);
        assert.equal(sessao.ok, true, metodo);

        const r = await a.get('/auth/me', sessao.cookie);

        assert.equal(r.status, 200, `${metodo}: ${JSON.stringify(r.body)}`);
        assert.deepEqual(r.body.administrador, { id: admin.id, email: admin.email });
        assert.equal((await a.get('/painel', sessao.cookie)).status, 200, metodo);
      }
    });

    test('E/F/G. sessão com MFA válido continua inválida se revogada, expirada, inativa ou de administrador inativo', async () => {
      const admin = await a.administrador('invalida');
      const casos = {
        revogada: await a.nascidaDoMfa(admin, 'TOTP', { revogada: 'LOGOUT' }),
        expirada: await a.nascidaDoMfa(admin, 'TOTP', { expiraEmSegundos: -5 }),
        'sem uso além da inatividade': await a.nascidaDoMfa(admin, 'TOTP', { desafioCriadoHa: 9000, verificadoHa: 8990, desafioEncerradoHa: 8989, sessaoCriadaHa: 8988, ultimoUsoHa: 8988 }),
      };
      for (const [rotulo, sessao] of Object.entries(casos)) {
        assert.equal(sessao.ok, true, rotulo);
        assert.equal((await a.get('/auth/me', sessao.cookie)).status, 401, rotulo);
      }

      const inativo = await a.administrador('inativo');
      const sessao = await a.nascidaDoMfa(inativo, 'TOTP');
      assert.equal((await a.get('/auth/me', sessao.cookie)).status, 200, 'vale enquanto o administrador está ativo');
      await a.q('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [inativo.id]);
      assert.equal((await a.get('/auth/me', sessao.cookie)).status, 401, 'administrador inativo');
    });

    test('logout com sessão incompatível: 200 idempotente, cookies removidos, linha intacta', async () => {
      const admin = await a.administrador('logout');
      const sessao = await a.gravar(admin);
      const antes = await a.linha(sessao.id);

      const r = await a.post('/auth/logout', sessao.cookie);

      assert.equal(r.status, 200);
      assert.equal((r.headers['set-cookie'] ?? []).some((c) => c.startsWith(`${COOKIE_SESSAO()}=;`)), true);
      assert.deepEqual(await a.linha(sessao.id), antes);
    });
  });

  describe('o banco recusa sessão ativa sem MFA comprovado (schema com todas as migrations existentes)', () => {
    let contexto;
    let app;
    const a = ambiente(() => contexto, () => app);

    before(async () => {
      contexto = await abrirPoolTemporario([...ATE_A_054, ...POSTERIORES]);
      app = montar(contexto.pool);
    });
    after(async () => { if (contexto) await contexto.encerrar(); });

    const recusadaPeloBanco = (resultado, constraint, rotulo) => {
      assert.deepEqual([resultado.ok, resultado.code, resultado.constraint], [false, VIOLACAO_CHECK, constraint], rotulo);
    };

    const NADA = { sessoes: 0, desafios: 0 };

    test('J. produtor antigo: INSERT de sessão ativa sem MFA é recusado', async () => {
      const admin = await a.administrador('bancoantigo');
      recusadaPeloBanco(await a.gravar(admin), 'chk_sessoes_plataforma_mfa_obrigatorio', 'sem MFA');
      assert.deepEqual(await a.restou(admin), NADA);
    });

    test('10. método que não cria sessão (SUBSTITUICAO, REAUTENTICACAO) é recusado, com ou sem desafio ligado', async () => {
      const admin = await a.administrador('bancometodo');
      for (const metodo of ['SUBSTITUICAO', 'REAUTENTICACAO']) recusadaPeloBanco(await a.gravar(admin, { metodo }), 'chk_sessoes_plataforma_mfa_obrigatorio', metodo);
      recusadaPeloBanco(await a.gravar(admin, { metodo: 'SUBSTITUICAO', desafio: 'SUBSTITUICAO' }), 'chk_sessoes_plataforma_mfa_obrigatorio', 'SUBSTITUICAO com desafio');
      assert.deepEqual(await a.restou(admin), NADA);
    });

    test('4 e 11. MFA só declarado: a transação não fecha e nada dela sobrevive', async () => {
      const admin = await a.administrador('bancodeclarado');
      for (const metodo of ['TOTP', 'CADASTRO', 'RECADASTRO']) recusadaPeloBanco(await a.gravar(admin, { metodo }), GATILHO, metodo);
      assert.deepEqual(await a.restou(admin), NADA, 'nenhuma sessão parcial');
    });

    test('5. desafio que não foi concluído não comprova sessão', async () => {
      const admin = await a.administrador('banconaoconcluido');
      const coerencia = 'chk_desafios_mfa_plataforma_sessao_criada_coerente';

      recusadaPeloBanco(await a.gravar(admin, { metodo: 'TOTP', desafio: 'VERIFICACAO', encerramento: null }), coerencia, 'desafio aberto ligado');
      for (const motivo of ['LOGOUT', 'EXPIRADO', 'FALHAS_EXCEDIDAS']) {
        recusadaPeloBanco(await a.gravar(admin, { metodo: 'TOTP', desafio: 'VERIFICACAO', encerramento: motivo }), coerencia, `desafio ${motivo} ligado`);
      }
      recusadaPeloBanco(await a.gravar(admin, { metodo: 'TOTP', desafio: 'VERIFICACAO', encerramento: null, ligado: false }), GATILHO, 'desafio aberto, sem vínculo');
      recusadaPeloBanco(await a.gravar(admin, { metodo: 'TOTP', desafio: 'VERIFICACAO', ligado: false }), GATILHO, 'desafio concluído, sem vínculo');
      assert.deepEqual(await a.restou(admin), NADA);
    });

    test('6. desafio de tipo incompatível com o método: a transação não fecha', async () => {
      const admin = await a.administrador('bancotipo');
      for (const [metodo, desafio] of [['TOTP', 'CADASTRO'], ['TOTP', 'RECUPERACAO'], ['CADASTRO', 'VERIFICACAO'], ['CADASTRO', 'RECUPERACAO'], ['RECADASTRO', 'VERIFICACAO'], ['RECADASTRO', 'CADASTRO'], ['TOTP', 'SUBSTITUICAO']]) {
        recusadaPeloBanco(await a.gravar(admin, { metodo, desafio }), GATILHO, `${metodo} com ${desafio}`);
      }
      assert.deepEqual(await a.restou(admin), NADA, 'nem sessão nem vínculo parcial');
    });

    test('7 e 8. desafio de outro administrador e vínculo para sessão de outro administrador: recusados', async () => {
      const dono = await a.administrador('bancodono');
      const outro = await a.administrador('bancooutro');
      const doOutro = await a.nascidaDoMfa(outro, 'TOTP');
      const semVinculo = await a.gravar(outro, { revogada: 'LOGOUT' });
      assert.deepEqual([doOutro.ok, semVinculo.ok], [true, true]);
      const antes = await a.restou(outro);

      const desafioAlheio = await a.gravar(dono, { metodo: 'TOTP', desafio: 'VERIFICACAO', donoDoDesafio: outro });
      assert.deepEqual([desafioAlheio.ok, desafioAlheio.code, desafioAlheio.constraint], [false, VIOLACAO_FK, FK_SESSAO_CRIADA], 'desafio de outro administrador');

      const sessaoAlheia = await a.gravar(dono, { metodo: 'TOTP', desafio: 'VERIFICACAO', ligarA: semVinculo.id });
      assert.deepEqual([sessaoAlheia.ok, sessaoAlheia.code, sessaoAlheia.constraint], [false, VIOLACAO_FK, FK_SESSAO_CRIADA], 'vínculo para sessão de outro administrador');

      assert.deepEqual(await a.restou(dono), NADA);
      assert.deepEqual(await a.restou(outro), antes, 'o outro administrador não é afetado');
      assert.equal((await a.get('/auth/me', doOutro.cookie)).status, 200);
    });

    test('9. instante do MFA fora da vida do desafio: a transação não fecha', async () => {
      const admin = await a.administrador('bancoinstante');
      recusadaPeloBanco(await a.nascidaDoMfa(admin, 'TOTP', { desafioCriadoHa: 60, verificadoHa: 90 }), GATILHO, 'antes de o desafio existir');
      recusadaPeloBanco(await a.nascidaDoMfa(admin, 'TOTP', { desafioEncerradoHa: 29, verificadoHa: 20, sessaoCriadaHa: 10, ultimoUsoHa: 10 }), GATILHO, 'depois de o desafio encerrar');
      recusadaPeloBanco(await a.nascidaDoMfa(admin, 'TOTP', { verificadoHa: 5, sessaoCriadaHa: 28 }), 'chk_sessoes_plataforma_mfa_antes_da_criacao', 'depois de a sessão ser criada');
      assert.deepEqual(await a.restou(admin), NADA);
    });

    test('12. renovar o uso não passa pelo gatilho nem quebra sessão válida', async () => {
      const admin = await a.administrador('bancouso');
      const sessao = await a.nascidaDoMfa(admin, 'TOTP');
      const falha = (sql, params) => a.q(sql, params).then(() => null, (e) => [e.code, e.constraint]);

      const antes = await a.linha(sessao.id);
      for (let i = 0; i < 3; i += 1) assert.equal((await a.get('/auth/me', sessao.cookie)).status, 200);
      assert.equal(await sessaoRepo.registrarUso(contexto.pool, sessao.id, authConfig.sessao.inatividadeMinutos), true);
      const depois = await a.linha(sessao.id);
      assert.ok(depois.ultimo_uso_em > antes.ultimo_uso_em, 'o uso foi renovado');
      assert.deepEqual([depois.revogada_em, depois.mfa_metodo, depois.mfa_verificado_em], [null, 'TOTP', antes.mfa_verificado_em]);

      // Com a comprovação desfeita por fora, só a escrita numa coluna vigiada é avaliada.
      await a.q("UPDATE desafios_mfa_plataforma SET tipo = 'CADASTRO', fator_pendente_id = $2 WHERE id = $1", [sessao.desafioId, admin.fatorId]);
      assert.equal(await falha('UPDATE sessoes_plataforma SET ultimo_uso_em = clock_timestamp() WHERE id = $1', [sessao.id]), null, 'renovação não é avaliada');
      assert.deepEqual(await falha('UPDATE sessoes_plataforma SET mfa_metodo = mfa_metodo WHERE id = $1', [sessao.id]), [VIOLACAO_CHECK, GATILHO], 'coluna vigiada é avaliada');
      assert.equal((await a.get('/auth/me', sessao.cookie)).status, 401, 'sem comprovação, a aplicação recusa');
    });

    test('B/C/D. sessão nascida de desafio concluído é aceita e autentica', async () => {
      for (const metodo of ['TOTP', 'CADASTRO', 'RECADASTRO']) {
        const admin = await a.administrador(`banco${metodo.toLowerCase()}`);
        const sessao = await a.nascidaDoMfa(admin, metodo);
        assert.equal(sessao.ok, true, `${metodo}: ${sessao.code} ${sessao.constraint}`);
        assert.equal((await a.get('/auth/me', sessao.cookie)).status, 200, metodo);
      }
    });

    test('um desafio comprova uma sessão só; sessão revogada pode existir sem MFA', async () => {
      const admin = await a.administrador('bancounico');
      const primeira = await a.nascidaDoMfa(admin, 'TOTP');
      const outro = await a.q(
        `INSERT INTO desafios_mfa_plataforma (administrador_id, token_hash, tipo, sessao_criada_id, criado_em, expira_em, encerrado_em, motivo_encerramento)
         VALUES ($1, $2, 'VERIFICACAO', $3, now() - interval '1 minute', now() + interval '5 minutes', now(), 'CONCLUIDO')`,
        [admin.id, hashAleatorio(), primeira.id],
      ).then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code, constraint: e.constraint }));
      assert.deepEqual(outro, { ok: false, code: VIOLACAO_UNICA, constraint: 'uq_desafios_mfa_plataforma_sessao_criada' });

      const historica = await a.gravar(admin, { revogada: 'LOGOUT' });
      assert.equal(historica.ok, true, 'linha histórica revogada, sem MFA');
    });

    test('sessão ativa não pode perder o MFA nem ser reativada sem ele; renovar o uso continua permitido', async () => {
      const admin = await a.administrador('bancoupdate');
      const valida = await a.nascidaDoMfa(admin, 'TOTP');
      const falha = (sql, params) => a.q(sql, params).then(() => null, (e) => [e.code, e.constraint]);

      assert.deepEqual(
        await falha('UPDATE sessoes_plataforma SET mfa_verificado_em = NULL, mfa_metodo = NULL WHERE id = $1', [valida.id]),
        [VIOLACAO_CHECK, 'chk_sessoes_plataforma_mfa_obrigatorio'],
      );
      assert.equal(await falha("UPDATE sessoes_plataforma SET ultimo_uso_em = now() WHERE id = $1", [valida.id]), null);

      const semMfa = await a.gravar(admin, { revogada: 'LOGOUT' });
      assert.deepEqual(
        await falha('UPDATE sessoes_plataforma SET revogada_em = NULL, motivo_revogacao = NULL WHERE id = $1', [semMfa.id]),
        [VIOLACAO_CHECK, 'chk_sessoes_plataforma_mfa_obrigatorio'],
      );
      const declarada = await a.gravar(admin, { metodo: 'TOTP', revogada: 'LOGOUT' });
      assert.deepEqual(
        await falha('UPDATE sessoes_plataforma SET revogada_em = NULL, motivo_revogacao = NULL WHERE id = $1', [declarada.id]),
        [VIOLACAO_CHECK, GATILHO],
      );
      assert.equal((await a.get('/auth/me', valida.cookie)).status, 200);
    });

    const COMPROVADA = (metodo, tipo) => ({ mfa_metodo: metodo, revogada_em: null, tipo, motivo_encerramento: 'CONCLUIDO', mesmo_administrador: true, em_ordem: true });

    test('1 e K. fluxo real do login com TOTP: desafio VERIFICACAO concluído, sessão TOTP ligada, COMMIT aceito', async () => {
      const admin = await a.administrador('realtotp');
      const login = await a.post('/auth/login', null, { email: admin.email, senha: SENHA });
      assert.deepEqual([login.status, login.body.etapa], [200, 'VERIFICACAO'], JSON.stringify(login.body));

      const r = await a.post('/auth/mfa/verificar', a.cookieDe(login, COOKIE_DESAFIO()), { codigo: totpReferencia.codigoDoStep(admin.segredo, await a.stepAgora()) });

      assert.equal(r.status, 200, JSON.stringify(r.body));
      const sessao = a.cookieDe(r, COOKIE_SESSAO());
      assert.equal((await a.get('/auth/me', sessao)).status, 200);
      assert.deepEqual(await a.comprovada(sessao), COMPROVADA('TOTP', 'VERIFICACAO'));
    });

    test('2 e K. fluxo real do primeiro cadastro: desafio CADASTRO concluído, sessão CADASTRO ligada, COMMIT aceito', async () => {
      const admin = await a.administrador('realcadastro', { comFator: false });
      const { codigo } = await liberacaoService.liberarCadastro(contexto.pool, { email: admin.email });
      const login = await a.post('/auth/login', null, { email: admin.email, senha: SENHA });
      assert.deepEqual([login.status, login.body.etapa], [200, 'LIBERACAO'], JSON.stringify(login.body));
      const liberado = await a.post('/auth/mfa/liberacao', a.cookieDe(login, COOKIE_DESAFIO()), { codigoLiberacao: codigo });
      assert.deepEqual([liberado.status, liberado.body.etapa], [200, 'CADASTRO'], JSON.stringify(liberado.body));
      const segredo = totpReferencia.segredoDaChaveManual(liberado.body.cadastro.chaveManual);

      const r = await a.post('/auth/mfa/cadastro/confirmar', a.cookieDe(liberado, COOKIE_DESAFIO()), { codigo: totpReferencia.codigoDoStep(segredo, await a.stepAgora()) });

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.codigosRecuperacao.length, 10);
      const sessao = a.cookieDe(r, COOKIE_SESSAO());
      assert.equal((await a.get('/auth/me', sessao)).status, 200);
      assert.deepEqual(await a.comprovada(sessao), COMPROVADA('CADASTRO', 'CADASTRO'));
    });

    test('3 e K. fluxo real da recuperação: desafio RECUPERACAO concluído, sessão RECADASTRO ligada, COMMIT aceito', async () => {
      const admin = await a.administrador('realrecadastro');
      const login = await a.post('/auth/login', null, { email: admin.email, senha: SENHA });
      const recuperando = await a.post('/auth/mfa/recuperacao', a.cookieDe(login, COOKIE_DESAFIO()), { codigoRecuperacao: admin.codigos[0] });
      assert.deepEqual([recuperando.status, recuperando.body.etapa], [200, 'RECUPERACAO'], JSON.stringify(recuperando.body));
      assert.equal((await a.restou(admin)).sessoes, 0, 'o código de recuperação não cria sessão');
      const segredo = totpReferencia.segredoDaChaveManual(recuperando.body.cadastro.chaveManual);

      const r = await a.post('/auth/mfa/cadastro/confirmar', a.cookieDe(recuperando, COOKIE_DESAFIO()), { codigo: totpReferencia.codigoDoStep(segredo, await a.stepAgora()) });

      assert.equal(r.status, 200, JSON.stringify(r.body));
      const sessao = a.cookieDe(r, COOKIE_SESSAO());
      assert.equal((await a.get('/auth/me', sessao)).status, 200);
      assert.deepEqual(await a.comprovada(sessao), COMPROVADA('RECADASTRO', 'RECUPERACAO'));
    });

    test('substituição e regeneração continuam sem criar sessão: nada a comprovar, 0 sessões válidas', async () => {
      const admin = await a.administrador('realsemsessao');
      const sessao = await a.nascidaDoMfa(admin, 'TOTP');

      const r = await a.post('/auth/mfa/recuperacao/regenerar', sessao.cookie, { senha: SENHA, codigo: totpReferencia.codigoDoStep(admin.segredo, await a.stepAgora()) });

      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.codigosRecuperacao.length, 10);
      assert.equal((await a.um('SELECT count(*)::int AS n FROM sessoes_plataforma WHERE administrador_id = $1 AND revogada_em IS NULL', [admin.id])).n, 0);
      assert.equal((await a.get('/auth/me', sessao.cookie)).status, 401);
    });
  });

  describe('o gatilho confere o administrador por conta própria (schema sem a FK composta do vínculo)', () => {
    let contexto;
    const a = ambiente(() => contexto, () => null);

    before(async () => {
      contexto = await abrirPoolTemporario([...ATE_A_054, ...POSTERIORES]);
      await contexto.pool.query(`ALTER TABLE desafios_mfa_plataforma DROP CONSTRAINT ${FK_SESSAO_CRIADA}`);
    });
    after(async () => { if (contexto) await contexto.encerrar(); });

    test('7. sem a FK, o desafio de outro administrador continua não comprovando a sessão', async () => {
      const dono = await a.administrador('gatilhodono');
      const outro = await a.administrador('gatilhooutro');

      const r = await a.gravar(dono, { metodo: 'TOTP', desafio: 'VERIFICACAO', donoDoDesafio: outro });

      assert.deepEqual([r.ok, r.code, r.constraint], [false, VIOLACAO_CHECK, GATILHO]);
      assert.deepEqual([await a.restou(dono), await a.restou(outro)], [{ sessoes: 0, desafios: 0 }, { sessoes: 0, desafios: 0 }]);
    });
  });
});

describe('mapeamento entre método da sessão e tipo do desafio vem dos fluxos reais', () => {
  const ler = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

  /** Em cada função que cria sessão: os tipos de desafio aceitos e o método gravado. */
  function fluxos() {
    const achados = [];
    for (const arquivo of ['src/services/mfa-cadastro-plataforma.service.js', 'src/services/recuperacao-mfa-plataforma.service.js', 'src/services/substituicao-mfa-plataforma.service.js']) {
      for (const funcao of ler(arquivo).split(/\nasync function /).slice(1)) {
        const metodo = funcao.match(/criarSessaoPlena\([^)]*metodo: '([A-Z_]+)'/)?.[1];
        if (metodo === undefined) continue;
        achados.push({ funcao: funcao.slice(0, funcao.indexOf('(')), tipos: funcao.match(/abrirEtapa\([^)]*tipos: \[([^\]]+)\]/)[1].replace(/'/g, ''), metodo });
      }
    }
    return achados.sort((x, y) => x.metodo.localeCompare(y.metodo));
  }

  test('só três funções criam sessão, cada uma com um tipo de desafio e um método', () => {
    assert.deepEqual(fluxos(), [
      { funcao: 'confirmarCadastro', tipos: 'CADASTRO', metodo: 'CADASTRO' },
      { funcao: 'concluirRecuperacao', tipos: 'RECUPERACAO', metodo: 'RECADASTRO' },
      { funcao: 'verificarLogin', tipos: 'VERIFICACAO', metodo: 'TOTP' },
    ]);
  });

  test('a consulta da aplicação e a migration usam exatamente esse mapeamento', () => {
    const esperado = fluxos().map((f) => `WHEN '${f.metodo}' THEN '${f.tipos}'`).sort();
    const pares = (texto) => [...new Set([...texto.matchAll(/WHEN '([A-Z_]+)' THEN '([A-Z_]+)'/g)].map((m) => m[0]))].sort();

    assert.deepEqual(pares(ler('src/repositories/sessao-plataforma.repository.js')), esperado, 'repositório');
    assert.equal(POSTERIORES.length > 0, true, 'há migration posterior à 054');
    const migration = fs.readdirSync(DIRETORIO).find((n) => n.startsWith('055_'));
    assert.deepEqual(pares(fs.readFileSync(path.join(DIRETORIO, migration ?? ''), 'utf8').replace(/^\s*--.*$/gm, '')), esperado, 'migration 055');
  });
});
