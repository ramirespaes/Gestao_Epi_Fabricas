'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { abrirPoolTemporario, aguardarEsperaPeloLock } = require('./helpers/schema-temporario');

const fatores = require('../../src/repositories/fator-mfa-plataforma.repository');
const lotes = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigos = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const desafios = require('../../src/repositories/desafio-mfa-plataforma.repository');
const liberacoes = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');
const sessoes = require('../../src/repositories/sessao-plataforma.repository');
const auditoria = require('../../src/repositories/auditoria-plataforma.repository');
const { cifrarSegredoTotp, decifrarSegredoTotp } = require('../../src/security/mfa-cripto');
const codigosMfa = require('../../src/security/codigos-mfa');

/**
 * Repositórios do MFA contra PostgreSQL real, com 048–054 aplicadas em
 * schema temporário. Além do contrato de cada primitiva, as corridas: duas
 * conexões disputam a mesma linha, a segunda espera de fato pelo lock
 * (confirmado em pg_stat_activity) e só uma vence.
 */

const MIGRATIONS = ['000', '001', '002', '005', '012', '014', '027', '028', '029', '031', '048', '049', '050', '051', '052', '053', '054'];
const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';
const hashAleatorio = () => crypto.randomBytes(32).toString('hex');

describe('repositórios do MFA da plataforma (PostgreSQL real)', () => {
  let contexto;

  const q = (sql, params) => contexto.pool.query(sql, params);
  const novoAdministrador = async () => (await q(
    'INSERT INTO administradores_plataforma (email, senha_hash) VALUES ($1, $2) RETURNING id',
    [`adm-${crypto.randomBytes(4).toString('hex')}@safework.com.br`, 'hash-ficticio'],
  )).rows[0].id;

  async function abrirTransacao() {
    const cliente = await contexto.pool.connect();
    await cliente.query('BEGIN');
    const pid = (await cliente.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return {
      cliente,
      pid,
      async fim(acao = 'COMMIT') {
        try { await cliente.query(acao); } finally { cliente.release(); }
      },
    };
  }

  /**
   * Corrida determinística: a primeira transação executa e segura a linha;
   * a segunda começa, fica comprovadamente esperando o lock, e só então a
   * primeira faz COMMIT. Devolve os dois desfechos, na ordem.
   */
  async function corrida(operacao) {
    const t1 = await abrirTransacao();
    const t2 = await abrirTransacao();
    try {
      const primeiro = await operacao(t1.cliente);
      const segundoPendente = operacao(t2.cliente).then((valor) => ({ valor }), (erro) => ({ erro }));
      await aguardarEsperaPeloLock(contexto.pool, t2.pid);
      await t1.fim('COMMIT');
      const segundo = await segundoPendente;
      await t2.fim(segundo.erro ? 'ROLLBACK' : 'COMMIT');
      return { primeiro, segundo };
    } catch (erro) {
      await t1.fim('ROLLBACK').catch(() => {});
      await t2.fim('ROLLBACK').catch(() => {});
      throw erro;
    }
  }

  async function novoPendente(administradorId, validadeMinutos = 15) {
    const fatorUid = crypto.randomUUID();
    const segredo = crypto.randomBytes(20);
    const envelope = cifrarSegredoTotp({ segredo, administradorId, fatorUid });
    const fator = await fatores.criarPendenteTotp(contexto.pool, { administradorId, fatorUid, envelope, validadeMinutos });
    return { ...fator, segredo };
  }

  async function novaSessao(administradorId) {
    return sessoes.criar(contexto.pool, { administradorId, tokenHash: hashAleatorio(), expiraEm: new Date(Date.now() + 8 * 3600e3) });
  }

  before(async () => { contexto = await abrirPoolTemporario(MIGRATIONS); });
  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('fatores', () => {
    test('o envelope gravado volta intacto e decifra com o AAD do mesmo fator', async () => {
      const admin = await novoAdministrador();
      const { id, fatorUid, segredo } = await novoPendente(admin);

      const lido = await fatores.buscarTotpPendente(contexto.pool, admin);

      assert.equal(lido.id, id);
      assert.equal(lido.fatorUid, fatorUid);
      assert.equal(lido.pendenteVigente, true);
      assert.ok(Buffer.isBuffer(lido.nonce) && Buffer.isBuffer(lido.segredoCifrado));
      const decifrado = decifrarSegredoTotp({
        administradorId: admin, fatorUid, formatoVersao: lido.formatoVersao, chaveVersao: lido.chaveVersao, nonce: lido.nonce, segredoCifrado: lido.segredoCifrado,
      });
      assert.equal(decifrado.equals(segredo), true);
      const { rows } = await q('SELECT totp_segredo_cifrado FROM fatores_mfa_plataforma WHERE id = $1', [id]);
      assert.equal(rows[0].totp_segredo_cifrado.includes(segredo), false, 'o secret em claro não está no banco');
    });

    test('ativar: PENDENTE vira ATIVO; um segundo ATIVO só entra depois de revogar o anterior, que perde o ciphertext', async () => {
      const admin = await novoAdministrador();
      const primeiro = await novoPendente(admin);
      assert.equal(await fatores.ativarTotp(contexto.pool, { administradorId: admin, fatorId: primeiro.id, step: 100 }), true);
      assert.equal((await fatores.buscarTotpAtivo(contexto.pool, admin)).ultimoStepAceito, 100);

      const segundo = await novoPendente(admin);
      const conflito = await fatores.ativarTotp(contexto.pool, { administradorId: admin, fatorId: segundo.id, step: 200 }).catch((e) => e);
      assert.equal(conflito.code, VIOLACAO_UNIQUE);
      assert.equal(conflito.constraint, 'uq_fatores_mfa_plataforma_totp_ativo');

      assert.equal(await fatores.revogar(contexto.pool, { administradorId: admin, fatorId: primeiro.id, motivo: 'SUBSTITUIDO' }), true);
      assert.equal(await fatores.ativarTotp(contexto.pool, { administradorId: admin, fatorId: segundo.id, step: 200 }), true);

      const { rows } = await q('SELECT estado, totp_nonce, totp_segredo_cifrado, motivo_revogacao FROM fatores_mfa_plataforma WHERE id = $1', [primeiro.id]);
      assert.deepEqual(rows[0], { estado: 'REVOGADO', totp_nonce: null, totp_segredo_cifrado: null, motivo_revogacao: 'SUBSTITUIDO' });
      assert.equal(await fatores.revogar(contexto.pool, { administradorId: admin, fatorId: primeiro.id, motivo: 'SUBSTITUIDO' }), false, 'revogar de novo não faz nada');
    });

    test('PENDENTE vencido não é ativado; fator de outro administrador também não', async () => {
      const admin = await novoAdministrador();
      const alheio = await novoAdministrador();
      const pendente = await novoPendente(admin);
      assert.equal(await fatores.ativarTotp(contexto.pool, { administradorId: alheio, fatorId: pendente.id, step: 1 }), false);
      assert.equal(await fatores.buscarPorId(contexto.pool, { administradorId: alheio, fatorId: pendente.id }), null);
      await q("UPDATE fatores_mfa_plataforma SET criado_em = now() - interval '1 hour', pendente_expira_em = now() - interval '1 minute' WHERE id = $1", [pendente.id]);
      assert.equal((await fatores.buscarTotpPendente(contexto.pool, admin)).pendenteVigente, false);
      assert.equal(await fatores.ativarTotp(contexto.pool, { administradorId: admin, fatorId: pendente.id, step: 1 }), false);
      assert.equal(await fatores.revogarPendenteTotp(contexto.pool, { administradorId: admin, motivo: 'EXPIRADO' }), 1);
      assert.equal(await fatores.revogarPendenteTotp(contexto.pool, { administradorId: admin, motivo: 'EXPIRADO' }), 0);
    });

    test('corrida: duas ativações do mesmo PENDENTE, um único vencedor', async () => {
      const admin = await novoAdministrador();
      const { id } = await novoPendente(admin);
      const { primeiro, segundo } = await corrida((c) => fatores.ativarTotp(c, { administradorId: admin, fatorId: id, step: 10 }));
      assert.equal(primeiro, true);
      assert.deepEqual(segundo, { valor: false });
    });

    test('corrida: ativações incompatíveis para o mesmo administrador; o índice único barra o segundo ATIVO', async () => {
      const admin = await novoAdministrador();
      const { id } = await novoPendente(admin);
      const t1 = await abrirTransacao();
      const t2 = await abrirTransacao();
      try {
        assert.equal(await fatores.ativarTotp(t1.cliente, { administradorId: admin, fatorId: id, step: 10 }), true);
        // Outro caminho tenta gravar um ATIVO direto para o mesmo administrador.
        const intruso = t2.cliente.query(
          `INSERT INTO fatores_mfa_plataforma
             (fator_uid, administrador_id, tipo, estado, totp_formato_versao, totp_chave_versao, totp_nonce, totp_segredo_cifrado,
              totp_algoritmo, totp_digitos, totp_periodo, pendente_expira_em, ativado_em)
           VALUES ($1, $2, 'TOTP', 'ATIVO', 1, 1, $3, $4, 'SHA1', 6, 30, now() + interval '1 minute', now())`,
          [crypto.randomUUID(), admin, crypto.randomBytes(12), crypto.randomBytes(36)],
        ).then(() => null, (erro) => erro);
        await aguardarEsperaPeloLock(contexto.pool, t2.pid);
        await t1.fim('COMMIT');
        const erro = await intruso;
        await t2.fim('ROLLBACK');
        assert.equal(erro?.code, VIOLACAO_UNIQUE);
      } catch (erro) {
        await t1.fim('ROLLBACK').catch(() => {});
        await t2.fim('ROLLBACK').catch(() => {});
        throw erro;
      }
      const { rows } = await q("SELECT count(*)::int AS n FROM fatores_mfa_plataforma WHERE administrador_id = $1 AND estado = 'ATIVO'", [admin]);
      assert.equal(rows[0].n, 1);
    });

    test('corrida: dois PENDENTES simultâneos para o mesmo administrador, só um sobrevive', async () => {
      const admin = await novoAdministrador();
      const criar = (c) => {
        const fatorUid = crypto.randomUUID();
        const envelope = cifrarSegredoTotp({ segredo: crypto.randomBytes(20), administradorId: admin, fatorUid });
        return fatores.criarPendenteTotp(c, { administradorId: admin, fatorUid, envelope, validadeMinutos: 15 });
      };
      const { primeiro, segundo } = await corrida(criar);
      assert.ok(primeiro.id);
      assert.equal(segundo.erro?.code, VIOLACAO_UNIQUE);
      assert.equal(segundo.erro?.constraint, 'uq_fatores_mfa_plataforma_totp_pendente');
    });

    test('anti-replay: só avança para step maior; mesmo step concorrente tem um único vencedor', async () => {
      const admin = await novoAdministrador();
      const { id } = await novoPendente(admin);
      await fatores.ativarTotp(contexto.pool, { administradorId: admin, fatorId: id, step: 100 });
      const registrar = (c, step) => fatores.registrarStepAceito(c, { administradorId: admin, fatorId: id, step });

      assert.equal(await registrar(contexto.pool, 100), false, 'mesmo step do cadastro');
      assert.equal(await registrar(contexto.pool, 99), false, 'step anterior');
      assert.equal(await registrar(contexto.pool, 101), true);

      const { primeiro, segundo } = await corrida((c) => registrar(c, 102));
      assert.equal(primeiro, true);
      assert.deepEqual(segundo, { valor: false });
      assert.equal((await fatores.buscarTotpAtivo(contexto.pool, admin)).ultimoStepAceito, 102);
    });
  });

  describe('recovery codes', () => {
    async function loteComCodigos(admin) {
      const lote = await lotes.criar(contexto.pool, admin);
      const emClaro = Array.from({ length: 10 }, () => codigosMfa.normalizarCodigo(codigosMfa.gerarCodigo()));
      const hashes = emClaro.map((codigo) => codigosMfa.hashCodigoRecuperacao({ administradorId: admin, codigo }));
      assert.equal(await codigos.inserirHashes(contexto.pool, { administradorId: admin, loteId: lote.id, hashes }), 10);
      return { lote, emClaro, hashes };
    }

    test('lote ativo único: o segundo só nasce depois de revogar o primeiro; revogar é idempotente', async () => {
      const admin = await novoAdministrador();
      const primeiro = await lotes.criar(contexto.pool, admin);
      const conflito = await lotes.criar(contexto.pool, admin).catch((e) => e);
      assert.equal(conflito.code, VIOLACAO_UNIQUE);
      assert.equal(await lotes.revogarAtivo(contexto.pool, { administradorId: admin, motivo: 'REGENERADO' }), true);
      assert.equal(await lotes.revogarAtivo(contexto.pool, { administradorId: admin, motivo: 'REGENERADO' }), false);
      const segundo = await lotes.criar(contexto.pool, admin);
      assert.notEqual(segundo.id, primeiro.id);
      assert.equal((await lotes.buscarAtivo(contexto.pool, admin)).id, segundo.id);
    });

    test('só hashes vão ao banco; nenhum código em claro aparece em coluna alguma', async () => {
      const admin = await novoAdministrador();
      const { emClaro } = await loteComCodigos(admin);
      const { rows } = await q('SELECT row_to_json(c)::text AS linha FROM codigos_recuperacao_mfa_plataforma c WHERE administrador_id = $1', [admin]);
      assert.equal(rows.length, 10);
      for (const { linha } of rows) {
        for (const codigo of emClaro) assert.equal(linha.includes(codigo), false);
      }
    });

    test('consumo: uma vez só; conta os restantes; lote revogado invalida os que sobraram', async () => {
      const admin = await novoAdministrador();
      const { lote, hashes } = await loteComCodigos(admin);
      assert.equal(await codigos.contarRestantes(contexto.pool, admin), 10);

      const utilizavel = await codigos.buscarUtilizavelPorHash(contexto.pool, { administradorId: admin, codigoHash: hashes[0] });
      assert.equal(utilizavel.loteId, lote.id);
      const consumido = await codigos.consumir(contexto.pool, { administradorId: admin, codigoHash: hashes[0] });
      assert.deepEqual(consumido, utilizavel);
      assert.equal(await codigos.consumir(contexto.pool, { administradorId: admin, codigoHash: hashes[0] }), null);
      assert.equal(await codigos.buscarUtilizavelPorHash(contexto.pool, { administradorId: admin, codigoHash: hashes[0] }), null);
      assert.equal(await codigos.contarRestantes(contexto.pool, admin), 9);

      await lotes.revogarAtivo(contexto.pool, { administradorId: admin, motivo: 'REGENERADO' });
      assert.equal(await codigos.consumir(contexto.pool, { administradorId: admin, codigoHash: hashes[1] }), null);
      assert.equal(await codigos.buscarUtilizavelPorHash(contexto.pool, { administradorId: admin, codigoHash: hashes[1] }), null);
      assert.equal(await codigos.contarRestantes(contexto.pool, admin), 0);
      assert.equal(await codigos.inserirHashes(contexto.pool, { administradorId: admin, loteId: lote.id, hashes: [hashAleatorio()] }), 0, 'lote revogado não recebe código');
    });

    test('código de um administrador não serve para outro', async () => {
      const admin = await novoAdministrador();
      const outro = await novoAdministrador();
      const { hashes } = await loteComCodigos(admin);
      await lotes.criar(contexto.pool, outro);
      assert.equal(await codigos.consumir(contexto.pool, { administradorId: outro, codigoHash: hashes[2] }), null);
      assert.equal(await codigos.contarRestantes(contexto.pool, admin), 10);
    });

    test('corrida: dois consumos do mesmo código, um único vencedor', async () => {
      const admin = await novoAdministrador();
      const { hashes } = await loteComCodigos(admin);
      const { primeiro, segundo } = await corrida((c) => codigos.consumir(c, { administradorId: admin, codigoHash: hashes[5] }));
      assert.ok(primeiro?.id);
      assert.deepEqual(segundo, { valor: null });
      assert.equal(await codigos.contarRestantes(contexto.pool, admin), 9);
    });
  });

  describe('desafios', () => {
    test('criar, achar pelo hash, contar falhas e encerrar uma única vez', async () => {
      const admin = await novoAdministrador();
      const tokenHash = hashAleatorio();
      const criado = await desafios.criar(contexto.pool, { administradorId: admin, tokenHash, tipo: 'VERIFICACAO', validadeMinutos: 5 });
      assert.ok(criado.expiraEm > criado.criadoEm);

      const valido = await desafios.buscarValidoPorHash(contexto.pool, tokenHash);
      assert.equal(valido.id, criado.id);
      assert.equal(valido.tipo, 'VERIFICACAO');
      assert.equal(await desafios.incrementarFalhas(contexto.pool, criado.id), 1);
      assert.equal(await desafios.incrementarFalhas(contexto.pool, criado.id), 2);

      assert.equal(await desafios.encerrar(contexto.pool, { desafioId: criado.id, motivo: 'LOGOUT' }), true);
      assert.equal(await desafios.encerrar(contexto.pool, { desafioId: criado.id, motivo: 'LOGOUT' }), false);
      assert.equal(await desafios.buscarValidoPorHash(contexto.pool, tokenHash), null);
      assert.equal(await desafios.incrementarFalhas(contexto.pool, criado.id), null);
      const encerrado = await desafios.buscarPorHash(contexto.pool, tokenHash);
      assert.deepEqual([encerrado.vigente, encerrado.motivoEncerramento, encerrado.falhas], [false, 'LOGOUT', 2]);
    });

    test('vencido e de administrador inativo não são válidos; encerrarExpirados fecha os vencidos', async () => {
      const admin = await novoAdministrador();
      const vencidoHash = hashAleatorio();
      await q(
        `INSERT INTO desafios_mfa_plataforma (administrador_id, token_hash, tipo, criado_em, expira_em)
         VALUES ($1, $2, 'VERIFICACAO', now() - interval '10 minutes', now() - interval '5 minutes')`,
        [admin, vencidoHash],
      );
      assert.equal(await desafios.buscarValidoPorHash(contexto.pool, vencidoHash), null);
      assert.equal(await desafios.encerrarExpirados(contexto.pool, admin), 1);
      assert.equal((await desafios.buscarPorHash(contexto.pool, vencidoHash)).motivoEncerramento, 'EXPIRADO');

      const inativoHash = hashAleatorio();
      await desafios.criar(contexto.pool, { administradorId: admin, tokenHash: inativoHash, tipo: 'LIBERACAO', validadeMinutos: 15 });
      await q('UPDATE administradores_plataforma SET ativo = false WHERE id = $1', [admin]);
      assert.equal(await desafios.buscarValidoPorHash(contexto.pool, inativoHash), null);
    });

    test('encerrarMaisAntigos mantém só os N mais novos; listarAbertos em ordem de criação', async () => {
      const admin = await novoAdministrador();
      const ids = [];
      for (let i = 0; i < 6; i += 1) {
        ids.push((await desafios.criar(contexto.pool, { administradorId: admin, tokenHash: hashAleatorio(), tipo: 'VERIFICACAO', validadeMinutos: 5 })).id);
      }
      assert.deepEqual((await desafios.listarAbertos(contexto.pool, admin)).map((d) => d.id), ids);
      assert.equal(await desafios.encerrarMaisAntigos(contexto.pool, { administradorId: admin, manterAbertos: 4, motivo: 'LIMITE_DESAFIOS' }), 2);
      assert.deepEqual((await desafios.listarAbertos(contexto.pool, admin)).map((d) => d.id), ids.slice(2));
      const { rows } = await q('SELECT motivo_encerramento FROM desafios_mfa_plataforma WHERE id = ANY($1) ORDER BY id', [ids.slice(0, 2)]);
      assert.deepEqual(rows.map((r) => r.motivo_encerramento), ['LIMITE_DESAFIOS', 'LIMITE_DESAFIOS']);
      assert.equal(await desafios.encerrarAbertos(contexto.pool, { administradorId: admin, motivo: 'RESET_OPERACIONAL', exceto: ids[5] }), 3);
      assert.deepEqual((await desafios.listarAbertos(contexto.pool, admin)).map((d) => d.id), [ids[5]]);
    });

    test('transição e sessão criada: CADASTRO ligado ao fator e ao anterior; sessão só depois de CONCLUIDO e do mesmo administrador', async () => {
      const admin = await novoAdministrador();
      const outro = await novoAdministrador();
      const liberacao = await desafios.criar(contexto.pool, { administradorId: admin, tokenHash: hashAleatorio(), tipo: 'LIBERACAO', validadeMinutos: 15 });
      const pendente = await novoPendente(admin);
      await desafios.encerrar(contexto.pool, { desafioId: liberacao.id, motivo: 'TRANSICAO' });
      const cadastro = await desafios.criar(contexto.pool, {
        administradorId: admin, tokenHash: hashAleatorio(), tipo: 'CADASTRO', validadeMinutos: 15, fatorPendenteId: pendente.id, desafioAnteriorId: liberacao.id,
      });
      const sessao = await novaSessao(admin);
      assert.equal(await desafios.ligarSessaoCriada(contexto.pool, { desafioId: cadastro.id, sessaoId: sessao }), false, 'ainda aberto');
      await desafios.encerrar(contexto.pool, { desafioId: cadastro.id, motivo: 'CONCLUIDO' });
      const sessaoAlheia = await novaSessao(outro);
      const erro = await desafios.ligarSessaoCriada(contexto.pool, { desafioId: cadastro.id, sessaoId: sessaoAlheia }).catch((e) => e);
      assert.equal(erro.code, VIOLACAO_FK);
      assert.equal(await desafios.ligarSessaoCriada(contexto.pool, { desafioId: cadastro.id, sessaoId: sessao }), true);
      assert.equal(await desafios.ligarSessaoCriada(contexto.pool, { desafioId: cadastro.id, sessaoId: sessao }), false, 'uma vez só');
      const lido = await desafios.buscarPorHash(contexto.pool, (await q('SELECT token_hash FROM desafios_mfa_plataforma WHERE id = $1', [cadastro.id])).rows[0].token_hash);
      assert.deepEqual([lido.fatorPendenteId, lido.desafioAnteriorId, lido.sessaoCriadaId], [pendente.id, liberacao.id, sessao]);
    });
  });

  describe('liberações de cadastro', () => {
    const novaLiberacao = (administradorId, origem = 'CLI_LIBERACAO') => {
      const codigo = codigosMfa.normalizarCodigo(codigosMfa.gerarCodigo());
      const codigoHash = codigosMfa.hashCodigoLiberacao({ administradorId, codigo });
      return { codigo, codigoHash, criar: () => liberacoes.criar(contexto.pool, { administradorId, codigoHash, origem, validadeMinutos: 30 }) };
    };

    test('criar, achar, consumir uma vez; uma aberta por administrador', async () => {
      const admin = await novoAdministrador();
      const l1 = novaLiberacao(admin);
      const criada = await l1.criar();
      const conflito = await novaLiberacao(admin).criar().catch((e) => e);
      assert.equal(conflito.code, VIOLACAO_UNIQUE);

      assert.equal((await liberacoes.buscarAberta(contexto.pool, admin)).vigente, true);
      assert.equal((await liberacoes.buscarValidaPorHash(contexto.pool, { administradorId: admin, codigoHash: l1.codigoHash })).id, criada.id);
      assert.equal(await liberacoes.consumir(contexto.pool, { administradorId: admin, codigoHash: l1.codigoHash }), criada.id);
      assert.equal(await liberacoes.consumir(contexto.pool, { administradorId: admin, codigoHash: l1.codigoHash }), null);
      assert.equal(await liberacoes.buscarAberta(contexto.pool, admin), null);
      assert.ok((await novaLiberacao(admin, 'CLI_RESET').criar()).id, 'consumida libera espaço para outra');

      const { rows } = await q('SELECT row_to_json(l)::text AS linha FROM liberacoes_cadastro_mfa_plataforma l WHERE administrador_id = $1', [admin]);
      for (const { linha } of rows) assert.equal(linha.includes(l1.codigo), false, 'código em claro nunca no banco');
    });

    test('vencida não é consumível, mas continua aberta até ser revogada', async () => {
      const admin = await novoAdministrador();
      const l = novaLiberacao(admin);
      await q(
        `INSERT INTO liberacoes_cadastro_mfa_plataforma (administrador_id, codigo_hash, origem, criado_em, expira_em)
         VALUES ($1, $2, 'CLI_CRIACAO', now() - interval '1 hour', now() - interval '30 minutes')`,
        [admin, l.codigoHash],
      );
      assert.equal(await liberacoes.buscarValidaPorHash(contexto.pool, { administradorId: admin, codigoHash: l.codigoHash }), null);
      assert.equal(await liberacoes.consumir(contexto.pool, { administradorId: admin, codigoHash: l.codigoHash }), null);
      assert.equal((await liberacoes.buscarAberta(contexto.pool, admin)).vigente, false);
      assert.equal(await liberacoes.revogarAberta(contexto.pool, { administradorId: admin, motivo: 'SUBSTITUIDA' }), true);
      assert.equal(await liberacoes.revogarAberta(contexto.pool, { administradorId: admin, motivo: 'SUBSTITUIDA' }), false);
      assert.equal(await liberacoes.buscarAberta(contexto.pool, admin), null);
    });

    test('código de liberação de um administrador não serve para outro', async () => {
      const admin = await novoAdministrador();
      const outro = await novoAdministrador();
      const l = novaLiberacao(admin);
      await l.criar();
      assert.equal(await liberacoes.consumir(contexto.pool, { administradorId: outro, codigoHash: l.codigoHash }), null);
    });

    test('corrida: dois consumos da mesma liberação, um único vencedor', async () => {
      const admin = await novoAdministrador();
      const l = novaLiberacao(admin);
      const criada = await l.criar();
      const { primeiro, segundo } = await corrida((c) => liberacoes.consumir(c, { administradorId: admin, codigoHash: l.codigoHash }));
      assert.equal(primeiro, criada.id);
      assert.deepEqual(segundo, { valor: null });
    });
  });

  describe('sessões', () => {
    test('revogarTodasDoAdministrador: com exceção, idempotente, sem tocar outro administrador nem sobrescrever revogação antiga', async () => {
      const admin = await novoAdministrador();
      const outro = await novoAdministrador();
      const s1 = await novaSessao(admin);
      const s2 = await novaSessao(admin);
      const s3 = await novaSessao(admin);
      const sOutro = await novaSessao(outro);
      await sessoes.revogar(contexto.pool, s3, 'LOGOUT');

      assert.equal(await sessoes.revogarTodasDoAdministrador(contexto.pool, admin, 'MFA_SUBSTITUIDO', { exceto: s2 }), 1);
      assert.equal(await sessoes.revogarTodasDoAdministrador(contexto.pool, admin, 'MFA_SUBSTITUIDO', { exceto: s2 }), 0);
      assert.equal(await sessoes.revogarTodasDoAdministrador(contexto.pool, admin, 'MFA_RESET_OPERACIONAL'), 1);
      assert.equal(await sessoes.revogarTodasDoAdministrador(contexto.pool, admin, 'MFA_RESET_OPERACIONAL'), 0);

      const { rows } = await q('SELECT id, motivo_revogacao FROM sessoes_plataforma WHERE id = ANY($1) ORDER BY id', [[s1, s2, s3, sOutro]]);
      assert.deepEqual(rows.map((r) => r.motivo_revogacao), ['MFA_SUBSTITUIDO', 'MFA_RESET_OPERACIONAL', 'LOGOUT', null]);
    });

    test('corrida: revogação em massa simultânea revoga cada sessão uma vez só', async () => {
      const admin = await novoAdministrador();
      for (let i = 0; i < 3; i += 1) await novaSessao(admin);
      const { primeiro, segundo } = await corrida((c) => sessoes.revogarTodasDoAdministrador(c, admin, 'MFA_RESET_OPERACIONAL'));
      assert.equal(primeiro, 3);
      assert.deepEqual(segundo, { valor: 0 });
    });

    test('sessão criada pelo caminho atual (sem MFA) ainda é válida: o enforcement não é deste incremento', async () => {
      const admin = await novoAdministrador();
      const tokenHash = hashAleatorio();
      await sessoes.criar(contexto.pool, { administradorId: admin, tokenHash, expiraEm: new Date(Date.now() + 3600e3) });
      const contextoSessao = await sessoes.buscarValidaPorHash(contexto.pool, tokenHash, 30);
      assert.equal(contextoSessao.administrador.id, admin);
      const { rows } = await q('SELECT mfa_verificado_em, mfa_metodo FROM sessoes_plataforma WHERE token_hash = $1', [tokenHash]);
      assert.deepEqual(rows[0], { mfa_verificado_em: null, mfa_metodo: null });
    });
  });

  describe('auditoria com ator e alvo', () => {
    test('registrar, registrarOperacaoCli e registrarEventoSistema gravam o ator certo e o alvo separado', async () => {
      const admin = await novoAdministrador();
      const alvo = await novoAdministrador();
      const ids = [
        (await auditoria.registrar(contexto.pool, { administradorId: admin, administradorAfetadoId: alvo, acao: 'ACAO_ADMIN' })).id,
        (await auditoria.registrarOperacaoCli(contexto.pool, { administradorAfetadoId: alvo, acao: 'MFA_RESET_OPERACIONAL', contexto: { origem: 'cli' } })).id,
        (await auditoria.registrarEventoSistema(contexto.pool, { administradorAfetadoId: alvo, acao: 'MFA_CHAVE_INDISPONIVEL', contexto: { operacao: 'cadastro', chaveVersao: 1 } })).id,
      ];
      const { rows } = await q(
        'SELECT ator_tipo, administrador_id, administrador_afetado_id FROM logs_auditoria_plataforma WHERE id = ANY($1) ORDER BY id',
        [ids],
      );
      assert.deepEqual(rows, [
        { ator_tipo: 'ADMINISTRADOR', administrador_id: admin, administrador_afetado_id: alvo },
        { ator_tipo: 'OPERACAO_CLI', administrador_id: null, administrador_afetado_id: alvo },
        { ator_tipo: 'SISTEMA', administrador_id: null, administrador_afetado_id: alvo },
      ]);
    });

    test('o bloqueio de chave sensível do banco vale também para CLI e SISTEMA', async () => {
      await assert.rejects(
        () => auditoria.registrarOperacaoCli(contexto.pool, { acao: 'X', contexto: { segredo: 'nao-pode' } }),
        /chave sensível/,
      );
      await assert.rejects(
        () => auditoria.registrarEventoSistema(contexto.pool, { acao: 'X', dadosNovos: { totp: 'nao-pode' } }),
        /chave sensível/,
      );
    });
  });
});
