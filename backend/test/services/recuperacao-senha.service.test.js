'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { HttpError } = require('../../src/errors/HttpError');
const { authConfig } = require('../../src/config/auth');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const redefinicaoRepo = require('../../src/repositories/redefinicao-senha.repository');
const redefinicaoPlataformaRepo = require('../../src/repositories/redefinicao-senha-plataforma.repository');
const solicitacaoRepo = require('../../src/repositories/recuperacao-senha-solicitacao.repository');
const auditoriaIdentidadeRepo = require('../../src/repositories/auditoria-identidade.repository');
const auditoriaPlataformaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const sessaoPlataformaRepo = require('../../src/repositories/sessao-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const cooldown = require('../../src/security/cooldown');
const password = require('../../src/security/password');
const token = require('../../src/security/token');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Service de recuperação de senha (Bloco 11C), sem PostgreSQL: repositórios,
 * senha, token e entrega de e-mail substituídos por t.mock.method, e um
 * cliente falso para o que o service envia direto (BEGIN, travas consultivas,
 * COMMIT, ROLLBACK). A mesma bateria roda para o Portal e para o Painel
 * Privado; o que é só de um dos dois fica em bloco próprio.
 */

const servico = () => exigirModulo('src/services/recuperacao-senha.service');
const entrega = () => exigirModulo('src/services/entrega-recuperacao-senha.service');

const EMAIL = 'pessoa@example.invalid';
const CONTA_ID = 7;
const PEDIDO_ID = '501';
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const TOKEN_HASH = token.hashTokenSessao(TOKEN);
const SENHA_NOVA = 'planeta-nebulosa-ozonio-42';
const HASH_ATUAL = '$argon2id$v=19$m=65536,t=3,p=1$c2FsLWF0dWFsLWZpY3RpY2lv$aGFzaC1hdHVhbC1maWN0aWNpby1kZS10ZXN0ZQ';
const HASH_NOVO = '$argon2id$v=19$m=65536,t=3,p=1$c2FsLW5vdm8tZmljdGljaW8$aGFzaC1ub3ZvLWZpY3RpY2lvLWRlLXRlc3Rl';
const CRIADO = new Date('2026-10-02T12:00:00.000Z');
const EXPIRA = new Date('2026-10-02T13:00:00.000Z');
const IP = '203.0.113.7';
const DISPOSITIVO = 'Agente de Teste';
const RESPOSTA = { status: 'SOLICITACAO_RECEBIDA' };

const PERFIS = {
  PORTAL: {
    contaRepo: identidadeRepo,
    pedidoRepo: redefinicaoRepo,
    campoConta: 'identidadeId',
    chaveLogin: () => cooldown.gerarChaveCooldownGlobal(EMAIL),
  },
  PLATAFORMA: {
    contaRepo: administradorRepo,
    pedidoRepo: redefinicaoPlataformaRepo,
    campoConta: 'administradorId',
    chaveLogin: () => cooldown.gerarChaveCooldownPlataforma(EMAIL),
  },
};

const INVALIDA = (erro) => erro instanceof HttpError && erro.status === 400 && erro.codigo === 'REDEFINICAO_INVALIDA'
  && erro.message === 'Link de redefinição inválido ou expirado' && erro.detalhes === undefined;

/**
 * Monta o cenário feliz de um escopo. Cada dependência registra um rótulo em
 * `eventos`, na ordem em que foi chamada, e as chamadas em `chamadas`.
 * `sobrescritas` troca o retorno de uma dependência pelo rótulo.
 */
function montar(t, escopo, sobrescritas = {}) {
  // Primeiro o service: sem ele não há o que simular.
  const alvo = servico();
  const perfil = PERFIS[escopo];
  const eventos = [];
  const chamadas = {};
  const sql = [];
  const console_ = [];

  const padrao = {
    CONTAR_SOLICITACOES: 0,
    REGISTRAR_SOLICITACAO: '901',
    CONTA_POR_EMAIL: { id: CONTA_ID, email: EMAIL, ativo: true, criadoEm: CRIADO, atualizadoEm: CRIADO },
    CONTA_POR_ID: { id: CONTA_ID, email: EMAIL, ativo: true, criadoEm: CRIADO, atualizadoEm: CRIADO },
    CONTA_TRAVADA: { id: CONTA_ID, email: EMAIL, ativo: true },
    CREDENCIAL: { id: CONTA_ID, email: EMAIL, senhaHash: HASH_ATUAL, ativo: true },
    PEDIDO_CRIADO: { id: PEDIDO_ID, criadoEm: CRIADO, expiraEm: EXPIRA, substituidos: 0 },
    PEDIDO_LIDO: {
      id: PEDIDO_ID, [perfil.campoConta]: CONTA_ID, criadoEm: CRIADO, expiraEm: EXPIRA, usadoEm: null, canceladoEm: null, motivoCancelamento: null, situacao: 'PENDENTE',
    },
    PEDIDO_TRAVADO: {
      id: PEDIDO_ID, [perfil.campoConta]: CONTA_ID, criadoEm: CRIADO, expiraEm: EXPIRA, usadoEm: null, canceladoEm: null, motivoCancelamento: null, situacao: 'PENDENTE',
    },
    PEDIDO_USADO: true,
    PENDENTES_CANCELADOS: 0,
    SENHA_ATUALIZADA: { id: CONTA_ID, atualizadoEm: CRIADO },
    SENHA_CONFERE: false,
    HASH_GERADO: HASH_NOVO,
    SESSOES_GLOBAIS_REVOGADAS: 2,
    SESSOES_EMPRESARIAIS_REVOGADAS: 3,
    SESSOES_ADMIN_REVOGADAS: 4,
    DESAFIOS_ENCERRADOS: 1,
    AUDITORIA: { id: '1', criadoEm: CRIADO },
  };
  const valores = { ...padrao, ...sobrescritas };

  const espiar = (objeto, nome, rotulo, retorno = rotulo) => {
    assert.equal(typeof objeto[nome], 'function', `primitiva ausente no repositório: ${nome}`);
    chamadas[rotulo] ??= [];
    t.mock.method(objeto, nome, (...argumentos) => {
      eventos.push(rotulo);
      chamadas[rotulo].push(argumentos);
      const valor = valores[retorno];
      if (valor instanceof Error) throw valor;
      return typeof valor === 'function' ? valor(...argumentos) : valor;
    });
  };
  const proibir = (objeto, nome, rotulo) => {
    if (typeof objeto[nome] !== 'function') return;
    chamadas[rotulo] ??= [];
    t.mock.method(objeto, nome, (...argumentos) => {
      eventos.push(rotulo);
      chamadas[rotulo].push(argumentos);
      throw new Error(`${rotulo} não pode ser chamado neste fluxo`);
    });
  };

  espiar(solicitacaoRepo, 'contarRecentes', 'CONTAR_SOLICITACOES');
  espiar(solicitacaoRepo, 'registrar', 'REGISTRAR_SOLICITACAO');
  espiar(perfil.contaRepo, 'buscarPorEmail', 'CONTA_POR_EMAIL');
  espiar(perfil.contaRepo, 'buscarPorId', 'CONTA_POR_ID');
  espiar(perfil.contaRepo, 'buscarPorIdParaAtualizacao', 'CONTA_TRAVADA');
  espiar(perfil.contaRepo, 'buscarCredencialPorEmail', 'CREDENCIAL');
  espiar(perfil.contaRepo, 'atualizarSenhaHash', 'SENHA_ATUALIZADA');
  espiar(perfil.pedidoRepo, 'criar', 'PEDIDO_CRIADO');
  espiar(perfil.pedidoRepo, 'buscarPorHash', 'PEDIDO_LIDO');
  espiar(perfil.pedidoRepo, 'buscarPorHashParaAtualizacao', 'PEDIDO_TRAVADO');
  espiar(perfil.pedidoRepo, 'marcarUsada', 'PEDIDO_USADO');
  espiar(perfil.pedidoRepo, 'cancelarPendentes', 'PENDENTES_CANCELADOS');
  espiar(password, 'verificarSenha', 'SENHA_CONFERE');
  espiar(password, 'gerarHashSenha', 'HASH_GERADO');
  t.mock.method(token, 'gerarTokenSessao', () => TOKEN);

  if (escopo === 'PORTAL') {
    espiar(auditoriaIdentidadeRepo, 'registrarEventoSistema', 'AUDITORIA');
    proibir(auditoriaIdentidadeRepo, 'registrarDaIdentidade', 'AUDITORIA_COMO_IDENTIDADE');
    espiar(sessaoGlobalRepo, 'revogarTodasDaIdentidade', 'SESSOES_GLOBAIS_REVOGADAS');
    espiar(sessaoRepo, 'revogarTodasDaIdentidade', 'SESSOES_EMPRESARIAIS_REVOGADAS');
  } else {
    espiar(auditoriaPlataformaRepo, 'registrarEventoSistema', 'AUDITORIA');
    proibir(auditoriaPlataformaRepo, 'registrar', 'AUDITORIA_COMO_ADMINISTRADOR');
    proibir(auditoriaPlataformaRepo, 'registrarOperacaoCli', 'AUDITORIA_COMO_CLI');
    espiar(travaRepo, 'travarAdministrador', 'TRAVA_MFA', 'NADA');
    espiar(sessaoPlataformaRepo, 'revogarTodasDoAdministrador', 'SESSOES_ADMIN_REVOGADAS');
    espiar(desafioRepo, 'encerrarAbertos', 'DESAFIOS_ENCERRADOS');
    for (const [repo, prefixo] of [[fatorRepo, 'FATOR'], [loteRepo, 'LOTE'], [codigoRepo, 'CODIGO']]) {
      for (const nome of Object.keys(repo)) proibir(repo, nome, `MFA_${prefixo}_${nome}`);
    }
  }
  for (const [repo, rotulo] of [[sessaoGlobalRepo, 'SESSAO_GLOBAL_CRIADA'], [sessaoRepo, 'SESSAO_EMPRESARIAL_CRIADA'], [sessaoPlataformaRepo, 'SESSAO_ADMIN_CRIADA']]) {
    proibir(repo, 'criar', rotulo);
  }

  const modEntrega = entrega();
  espiar(modEntrega, 'enfileirarRedefinicao', 'ENFILEIRAR_REDEFINICAO', 'ENTREGA');
  espiar(modEntrega, 'enfileirarAvisoSenhaAlterada', 'ENFILEIRAR_AVISO', 'ENTREGA');

  for (const metodo of ['log', 'info', 'warn', 'error', 'debug']) {
    t.mock.method(console, metodo, (...argumentos) => { console_.push({ metodo, texto: JSON.stringify(argumentos) }); });
  }

  const cliente = {
    liberado: 0,
    query: async (texto, parametros) => {
      sql.push({ texto, parametros });
      if (texto === 'BEGIN' || texto === 'COMMIT' || texto === 'ROLLBACK') eventos.push(texto);
      else if (/pg_advisory_xact_lock/.test(texto)) eventos.push('TRAVA_CONSULTIVA');
      else eventos.push('SQL_DIRETO');
      if (sobrescritas.FALHA_NO_BANCO && sobrescritas.FALHA_NO_BANCO.test(texto)) throw Object.assign(new Error('falha simulada do banco'), { code: '57P01' });
      return { rows: [], rowCount: 0 };
    },
    release: () => { cliente.liberado += 1; },
  };
  const pool = {
    conexoes: 0,
    connect: async () => {
      pool.conexoes += 1;
      if (sobrescritas.FALHA_AO_CONECTAR) throw Object.assign(new Error('falha simulada de conexão'), { code: 'ECONNREFUSED' });
      return cliente;
    },
  };

  const posicao = (rotulo) => eventos.indexOf(rotulo);
  const antes = (a, b) => {
    assert.notEqual(posicao(a), -1, `${a} não aconteceu (${eventos.join(' > ')})`);
    assert.notEqual(posicao(b), -1, `${b} não aconteceu (${eventos.join(' > ')})`);
    assert.ok(posicao(a) < posicao(b), `${a} deveria vir antes de ${b} (${eventos.join(' > ')})`);
  };
  const nunca = (...rotulos) => {
    for (const rotulo of rotulos) assert.equal(posicao(rotulo), -1, `${rotulo} não deveria ter acontecido (${eventos.join(' > ')})`);
  };

  return { alvo, perfil, pool, cliente, eventos, chamadas, sql, console: console_, antes, nunca };
}

const solicitar = (c, escopo, extra = {}) => c.alvo.solicitar(c.pool, { escopo, email: EMAIL, ip: IP, dispositivo: DISPOSITIVO, ...extra });
const redefinir = (c, escopo, extra = {}) => c.alvo.redefinir(c.pool, { escopo, token: TOKEN, novaSenha: SENHA_NOVA, ip: IP, dispositivo: DISPOSITIVO, ...extra });

function semSensiveis(c, { senhas = [] } = {}) {
  const sensiveis = [TOKEN, TOKEN_HASH, EMAIL, 'pessoa@', '#token=', HASH_ATUAL, HASH_NOVO, ...senhas];
  const auditoria = JSON.stringify([c.chamadas.AUDITORIA ?? [], c.chamadas.AUDITORIA_COMO_IDENTIDADE ?? []].map((lista) => lista.map(([, dados]) => dados)));
  const tecnico = c.console.map((linha) => linha.texto).join('\n');
  for (const valor of sensiveis) {
    assert.equal(auditoria.includes(valor), false, `auditoria contém valor sensível (${valor.slice(0, 6)}…)`);
    assert.equal(tecnico.includes(valor), false, `log técnico contém valor sensível (${valor.slice(0, 6)}…)`);
  }
}

describe('contrato do módulo', () => {
  test('exporta só os dois fluxos públicos, os escopos, o limite e a resposta fixa da solicitação', () => {
    const modulo = servico();
    assert.deepEqual(Object.keys(modulo).sort(), ['ESCOPOS', 'LIMITE_SOLICITACOES', 'RESPOSTA_SOLICITACAO', 'redefinir', 'solicitar']);
    assert.deepEqual(modulo.ESCOPOS, { PORTAL: 'PORTAL', PLATAFORMA: 'PLATAFORMA' });
    assert.deepEqual(modulo.LIMITE_SOLICITACOES, { quantidade: 3, janelaMinutos: 60 });
    assert.deepEqual(modulo.RESPOSTA_SOLICITACAO, RESPOSTA);
    for (const objeto of [modulo.ESCOPOS, modulo.LIMITE_SOLICITACOES, modulo.RESPOSTA_SOLICITACAO]) assert.equal(Object.isFrozen(objeto), true);
  });

  test('a validade padrão do link vem da configuração: 60 minutos', () => {
    assert.equal(authConfig.recuperacaoSenha?.validadeMinutos, 60);
  });
});

for (const escopo of ['PORTAL', 'PLATAFORMA']) {
  describe(`solicitar — ${escopo}`, () => {
    test('conta ativa: trava pela chave HMAC, conta as solicitações, registra, trava a conta, cria o pedido, audita e só então confirma; o e-mail sai depois do COMMIT', async (t) => {
      const c = montar(t, escopo);
      const resposta = await solicitar(c, escopo);
      assert.deepEqual(resposta, RESPOSTA);

      c.antes('BEGIN', 'TRAVA_CONSULTIVA');
      c.antes('TRAVA_CONSULTIVA', 'CONTAR_SOLICITACOES');
      c.antes('CONTAR_SOLICITACOES', 'REGISTRAR_SOLICITACAO');
      c.antes('TRAVA_CONSULTIVA', 'CONTA_TRAVADA');
      c.antes('CONTA_TRAVADA', 'PEDIDO_CRIADO');
      c.antes('PEDIDO_CRIADO', 'AUDITORIA');
      c.antes('AUDITORIA', 'COMMIT');
      c.antes('COMMIT', 'ENFILEIRAR_REDEFINICAO');
      c.nunca('ROLLBACK', 'ENFILEIRAR_AVISO', 'CREDENCIAL', 'SENHA_ATUALIZADA');
      assert.equal(c.cliente.liberado, 1);
    });

    test('a trava consultiva é a da chave de recuperação do e-mail naquele escopo, com parâmetro e em 64 bits', async (t) => {
      const c = montar(t, escopo);
      await solicitar(c, escopo);
      const chave = cooldown.gerarChaveRecuperacaoSenha(escopo, EMAIL);
      const travas = c.sql.filter((s) => /pg_advisory_xact_lock/.test(s.texto));
      assert.equal(travas.length, 1);
      assert.equal(travas[0].texto, 'SELECT pg_advisory_xact_lock($1::bigint)');
      assert.deepEqual(travas[0].parametros, [cooldown.derivarAdvisoryLock64(chave)]);
      assert.deepEqual(c.chamadas.CONTAR_SOLICITACOES[0][1], { escopo, chave, janelaMinutos: 60 });
      assert.deepEqual(c.chamadas.REGISTRAR_SOLICITACAO[0][1], { escopo, chave, ip: IP, dispositivo: DISPOSITIVO });
    });

    test('o pedido leva só o hash do token, a validade configurada (60 minutos) e a origem; o token em claro só vai para a entrega', async (t) => {
      const c = montar(t, escopo);
      await solicitar(c, escopo);
      assert.deepEqual(c.chamadas.PEDIDO_CRIADO[0][1], {
        [c.perfil.campoConta]: CONTA_ID, tokenHash: TOKEN_HASH, validadeMinutos: 60, ip: IP, dispositivo: DISPOSITIVO,
      });
      assert.deepEqual(c.chamadas.CONTA_TRAVADA[0][1], CONTA_ID);
      assert.deepEqual(c.chamadas.ENFILEIRAR_REDEFINICAO, [[{ escopo, email: EMAIL, token: TOKEN, expiraEm: EXPIRA }]]);
      assert.equal(JSON.stringify(c.chamadas.PEDIDO_CRIADO).includes(TOKEN), false, 'token em claro nunca chega ao repositório');
    });

    test('e-mail em outra caixa e com espaços resolve para a mesma chave e a mesma conta', async (t) => {
      const c = montar(t, escopo);
      await solicitar(c, escopo, { email: '  Pessoa@Example.INVALID ' });
      assert.equal(c.chamadas.CONTAR_SOLICITACOES[0][1].chave, cooldown.gerarChaveRecuperacaoSenha(escopo, EMAIL));
      assert.equal(c.chamadas.CONTA_POR_EMAIL[0][1], EMAIL);
    });

    test('limite de 3 por hora: com 3 solicitações na janela nada mais é registrado, criado, auditado ou enviado', async (t) => {
      const c = montar(t, escopo, { CONTAR_SOLICITACOES: 3 });
      assert.deepEqual(await solicitar(c, escopo), RESPOSTA);
      c.antes('TRAVA_CONSULTIVA', 'CONTAR_SOLICITACOES');
      c.nunca('REGISTRAR_SOLICITACAO', 'CONTA_TRAVADA', 'PEDIDO_CRIADO', 'AUDITORIA', 'ENFILEIRAR_REDEFINICAO');
      assert.equal(c.eventos.includes('COMMIT') || c.eventos.includes('ROLLBACK'), true, 'a transação é encerrada');
      assert.equal(c.cliente.liberado, 1);
    });

    test('a terceira solicitação da janela ainda é aceita (2 já registradas)', async (t) => {
      const c = montar(t, escopo, { CONTAR_SOLICITACOES: 2 });
      await solicitar(c, escopo);
      assert.equal(c.chamadas.REGISTRAR_SOLICITACAO.length, 1);
      assert.equal(c.chamadas.PEDIDO_CRIADO.length, 1);
      assert.equal(c.chamadas.ENFILEIRAR_REDEFINICAO.length, 1);
    });

    test('conta inexistente: a solicitação é registrada do mesmo jeito, mas não há trava de conta, pedido, auditoria nem e-mail', async (t) => {
      const c = montar(t, escopo, { CONTA_POR_EMAIL: null });
      assert.deepEqual(await solicitar(c, escopo), RESPOSTA);
      assert.equal(c.chamadas.REGISTRAR_SOLICITACAO.length, 1);
      c.nunca('CONTA_TRAVADA', 'PEDIDO_CRIADO', 'AUDITORIA', 'ENFILEIRAR_REDEFINICAO', 'ROLLBACK');
      c.antes('REGISTRAR_SOLICITACAO', 'COMMIT');
    });

    test('conta inativa: solicitação registrada, recusa auditada como evento do sistema, sem pedido e sem e-mail', async (t) => {
      const c = montar(t, escopo, { CONTA_POR_EMAIL: { id: CONTA_ID, email: EMAIL, ativo: false, criadoEm: CRIADO, atualizadoEm: CRIADO }, CONTA_TRAVADA: { id: CONTA_ID, email: EMAIL, ativo: false } });
      assert.deepEqual(await solicitar(c, escopo), RESPOSTA);
      assert.equal(c.chamadas.REGISTRAR_SOLICITACAO.length, 1);
      c.nunca('PEDIDO_CRIADO', 'ENFILEIRAR_REDEFINICAO', 'ROLLBACK');
      assert.equal(c.chamadas.AUDITORIA.length, 1);
      const [, evento] = c.chamadas.AUDITORIA[0];
      assert.equal(evento.acao, 'REDEFINICAO_SENHA_RECUSADA');
      assert.deepEqual(evento.contexto, { etapa: 'SOLICITACAO', motivo: 'CONTA_INATIVA' });
    });

    test('conta inativada entre a busca e a trava: vale a situação lida sob a trava', async (t) => {
      const c = montar(t, escopo, { CONTA_TRAVADA: { id: CONTA_ID, email: EMAIL, ativo: false } });
      assert.deepEqual(await solicitar(c, escopo), RESPOSTA);
      c.nunca('PEDIDO_CRIADO', 'ENFILEIRAR_REDEFINICAO');
    });

    test('e-mail que não normaliza: mesma resposta, sem abrir conexão', async (t) => {
      for (const email of ['', '   ', 'sem-arroba', 'a@b', 'com espaço@example.invalid', 'duas@@example.invalid', 42, null, undefined]) {
        const c = montar(t, escopo);
        assert.deepEqual(await solicitar(c, escopo, { email }), RESPOSTA, JSON.stringify(email));
        assert.equal(c.pool.conexoes, 0, JSON.stringify(email));
        c.nunca('BEGIN', 'REGISTRAR_SOLICITACAO', 'ENFILEIRAR_REDEFINICAO');
        t.mock.restoreAll();
      }
    });

    test('quem chama não distingue os casos: a resposta é sempre o mesmo objeto, sem e-mail, token, link ou identificador', async (t) => {
      const cenarios = {
        existente: {},
        inexistente: { CONTA_POR_EMAIL: null },
        inativa: { CONTA_TRAVADA: { id: CONTA_ID, email: EMAIL, ativo: false } },
        limitada: { CONTAR_SOLICITACOES: 3 },
        'erro interno': { PEDIDO_CRIADO: new Error('falha simulada') },
        'sem conexão': { FALHA_AO_CONECTAR: true },
      };
      const respostas = [];
      for (const [nome, sobrescritas] of Object.entries(cenarios)) {
        const c = montar(t, escopo, sobrescritas);
        const resposta = await solicitar(c, escopo);
        assert.equal(resposta, c.alvo.RESPOSTA_SOLICITACAO, nome);
        respostas.push(JSON.stringify(resposta));
        t.mock.restoreAll();
      }
      assert.deepEqual([...new Set(respostas)], [JSON.stringify(RESPOSTA)]);
    });

    test('falha interna depois de criar o pedido: ROLLBACK, nenhum e-mail, mesma resposta e um registro técnico sem dado sensível', async (t) => {
      const c = montar(t, escopo, { AUDITORIA: Object.assign(new Error(`falha simulada com ${EMAIL} e ${TOKEN}`), { code: 'P0001' }) });
      assert.deepEqual(await solicitar(c, escopo), RESPOSTA);
      c.antes('PEDIDO_CRIADO', 'ROLLBACK');
      c.nunca('COMMIT', 'ENFILEIRAR_REDEFINICAO');
      assert.equal(c.cliente.liberado, 1);

      const erros = c.console.filter((linha) => linha.metodo === 'error');
      assert.equal(erros.length, 1);
      assert.match(erros[0].texto, /recuperacao-senha/);
      assert.match(erros[0].texto, /solicitacao_falhou/);
      assert.ok(erros[0].texto.includes(cooldown.idCorrelacaoCooldown(cooldown.gerarChaveRecuperacaoSenha(escopo, EMAIL))), 'correlação pseudônima pela chave');
      semSensiveis(c);
    });

    test('falha no COMMIT: nenhum e-mail é enviado', async (t) => {
      const c = montar(t, escopo, { FALHA_NO_BANCO: /^COMMIT$/ });
      assert.deepEqual(await solicitar(c, escopo), RESPOSTA);
      c.nunca('ENFILEIRAR_REDEFINICAO');
    });

    test('falha da entrega depois do COMMIT não muda a resposta nem desfaz o pedido', async (t) => {
      const c = montar(t, escopo, { ENTREGA: () => { throw new Error('falha simulada da entrega'); } });
      assert.deepEqual(await solicitar(c, escopo), RESPOSTA);
      c.antes('COMMIT', 'ENFILEIRAR_REDEFINICAO');
      c.nunca('ROLLBACK');
      semSensiveis(c);
    });

    test('entrega que devolve promessa rejeitada: nenhuma rejeição fica sem tratamento, sem ROLLBACK e com a mesma resposta', async (t) => {
      const rejeicoes = [];
      const ouvinte = (motivo) => { rejeicoes.push(motivo); };
      process.on('unhandledRejection', ouvinte);
      try {
        const c = montar(t, escopo, { ENTREGA: () => Promise.reject(new Error(`falha simulada com ${EMAIL} e ${TOKEN}`)) });
        assert.deepEqual(await solicitar(c, escopo), RESPOSTA);
        await new Promise((resolve) => { setImmediate(resolve); });
        await new Promise((resolve) => { setImmediate(resolve); });
        assert.deepEqual(rejeicoes, []);
        c.antes('COMMIT', 'ENFILEIRAR_REDEFINICAO');
        c.nunca('ROLLBACK');
        semSensiveis(c);
      } finally {
        process.off('unhandledRejection', ouvinte);
      }
    });

    test('auditoria: evento do sistema, com o pedido como referência e sem e-mail, token, link ou hash', async (t) => {
      const c = montar(t, escopo, { PEDIDO_CRIADO: { id: PEDIDO_ID, criadoEm: CRIADO, expiraEm: EXPIRA, substituidos: 1 } });
      await solicitar(c, escopo);
      assert.equal(c.chamadas.AUDITORIA.length, 1);
      const [executor, evento] = c.chamadas.AUDITORIA[0];
      assert.equal(executor, c.cliente, 'auditoria na mesma transação');
      assert.equal(evento.acao, 'REDEFINICAO_SENHA_SOLICITADA');
      assert.equal(evento.referencia, PEDIDO_ID);
      assert.deepEqual(evento.contexto, { pedidosSubstituidos: 1, validadeMinutos: 60 });
      assert.equal('atorTipo' in evento, false, 'o ator é o da função chamada');
      if (escopo === 'PORTAL') assert.equal(evento.identidadeId, CONTA_ID);
      else assert.equal(evento.administradorAfetadoId, CONTA_ID);
      semSensiveis(c);
    });

    test('o único SQL enviado direto pelo service é fixo e parametrizado; nenhum valor de entrada entra no texto', async (t) => {
      const c = montar(t, escopo);
      await solicitar(c, escopo);
      const permitidos = [/^BEGIN$/, /^COMMIT$/, /^ROLLBACK$/, /^SELECT pg_advisory_xact_lock\(\$1::bigint\)$/];
      for (const { texto } of c.sql) {
        assert.ok(permitidos.some((padrao) => padrao.test(texto)), `SQL inesperado: ${texto}`);
        for (const valor of [EMAIL, TOKEN, TOKEN_HASH, cooldown.gerarChaveRecuperacaoSenha(escopo, EMAIL)]) assert.equal(texto.includes(valor), false);
      }
    });

    test('escopo desconhecido é erro de programação, antes de qualquer conexão', async (t) => {
      const c = montar(t, escopo);
      for (const ruim of ['portal', 'OUTRO', '', null, undefined]) {
        await assert.rejects(() => c.alvo.solicitar(c.pool, { escopo: ruim, email: EMAIL }), TypeError, String(ruim));
      }
      assert.equal(c.pool.conexoes, 0);
    });
  });

  describe(`redefinir — ${escopo}`, () => {
    test('token válido: conta antes do pedido, consumo, senha nova, cancelamento dos pendentes, revogação das sessões e auditoria na mesma transação; o aviso sai depois do COMMIT', async (t) => {
      const c = montar(t, escopo);
      const resultado = await redefinir(c, escopo);
      assert.deepEqual(resultado, { status: 'SENHA_REDEFINIDA' });

      c.antes('BEGIN', 'PEDIDO_LIDO');
      c.antes('PEDIDO_LIDO', 'TRAVA_CONSULTIVA');
      c.antes('TRAVA_CONSULTIVA', 'CONTA_TRAVADA');
      c.antes('CONTA_TRAVADA', 'PEDIDO_TRAVADO');
      c.antes('PEDIDO_TRAVADO', 'PEDIDO_USADO');
      c.antes('PEDIDO_USADO', 'SENHA_ATUALIZADA');
      c.antes('SENHA_ATUALIZADA', 'COMMIT');
      c.antes('PENDENTES_CANCELADOS', 'COMMIT');
      c.antes('AUDITORIA', 'COMMIT');
      c.antes('COMMIT', 'ENFILEIRAR_AVISO');
      c.nunca('ROLLBACK', 'ENFILEIRAR_REDEFINICAO', 'REGISTRAR_SOLICITACAO');
      assert.equal(c.cliente.liberado, 1);
    });

    test('os repositórios recebem só o hash do token; a senha nova vira hash antes de ser gravada', async (t) => {
      const c = montar(t, escopo);
      await redefinir(c, escopo);
      assert.equal(c.chamadas.PEDIDO_LIDO[0][1], TOKEN_HASH);
      assert.equal(c.chamadas.PEDIDO_TRAVADO[0][1], TOKEN_HASH);
      assert.equal(c.chamadas.PEDIDO_USADO[0][1], PEDIDO_ID);
      assert.deepEqual(c.chamadas.HASH_GERADO[0], [SENHA_NOVA]);
      assert.deepEqual(c.chamadas.SENHA_ATUALIZADA[0].slice(1), [CONTA_ID, HASH_NOVO]);
      assert.deepEqual(c.chamadas.PENDENTES_CANCELADOS[0].slice(1), [CONTA_ID, 'SENHA_REDEFINIDA']);
      assert.deepEqual(c.chamadas.ENFILEIRAR_AVISO, [[{ escopo, email: EMAIL }]]);
      const comBanco = ['PEDIDO_LIDO', 'CONTA_POR_ID', 'CONTA_TRAVADA', 'PEDIDO_TRAVADO', 'CREDENCIAL', 'PEDIDO_USADO', 'SENHA_ATUALIZADA', 'PENDENTES_CANCELADOS', 'AUDITORIA'];
      for (const rotulo of comBanco) {
        for (const argumentos of c.chamadas[rotulo]) assert.equal(argumentos[0], c.cliente, `${rotulo} fora da transação do service`);
      }
    });

    test('a trava consultiva do reset é a mesma chave do login daquela conta, tomada antes de travar a linha', async (t) => {
      const c = montar(t, escopo);
      await redefinir(c, escopo);
      const travas = c.sql.filter((s) => /pg_advisory_xact_lock/.test(s.texto));
      assert.equal(travas.length, 1);
      assert.equal(travas[0].texto, 'SELECT pg_advisory_xact_lock($1::bigint)');
      assert.deepEqual(travas[0].parametros, [cooldown.derivarAdvisoryLock64(c.perfil.chaveLogin())]);
    });

    test('nova senha igual à atual é recusada: nada é consumido, alterado, revogado ou avisado', async (t) => {
      const c = montar(t, escopo, { SENHA_CONFERE: true });
      await assert.rejects(
        () => redefinir(c, escopo),
        (erro) => erro instanceof HttpError && erro.status === 400 && erro.codigo === 'SENHA_IGUAL_A_ATUAL',
      );
      assert.deepEqual(c.chamadas.SENHA_CONFERE[0], [HASH_ATUAL, SENHA_NOVA]);
      c.nunca('PEDIDO_USADO', 'SENHA_ATUALIZADA', 'HASH_GERADO', 'PENDENTES_CANCELADOS', 'ENFILEIRAR_AVISO',
        'SESSOES_GLOBAIS_REVOGADAS', 'SESSOES_EMPRESARIAIS_REVOGADAS', 'SESSOES_ADMIN_REVOGADAS', 'DESAFIOS_ENCERRADOS');
      assert.equal(c.cliente.liberado, 1);
      semSensiveis(c, { senhas: [SENHA_NOVA] });
    });

    test('senha fora da política: 400 de validação com as regras violadas, sem o valor; o pedido continua pendente', async (t) => {
      const c = montar(t, escopo);
      await assert.rejects(
        () => redefinir(c, escopo, { novaSenha: 'Zx9!kq' }),
        (erro) => erro instanceof HttpError && erro.status === 400 && erro.codigo === 'VALIDACAO'
          && erro.detalhes.some((d) => d.campo === 'body.novaSenha' && d.codigo === 'SENHA_CURTA')
          && !JSON.stringify(erro.corpoResposta()).includes('Zx9!kq'),
      );
      c.nunca('PEDIDO_USADO', 'SENHA_ATUALIZADA', 'HASH_GERADO', 'ENFILEIRAR_AVISO');
    });

    test('a política recebe o e-mail da conta: senha que contém o e-mail é recusada', async (t) => {
      const c = montar(t, escopo);
      await assert.rejects(
        () => redefinir(c, escopo, { novaSenha: `${EMAIL}-2026` }),
        (erro) => erro instanceof HttpError && erro.codigo === 'VALIDACAO' && erro.detalhes.some((d) => d.codigo === 'SENHA_CONTEM_EMAIL'),
      );
      c.nunca('SENHA_ATUALIZADA');
    });

    test('token malformado é recusado sem abrir conexão, com o mesmo erro genérico', async (t) => {
      for (const ruim of ['', 'curto', `${TOKEN}=`, TOKEN.slice(0, 42), `${TOKEN.slice(0, 42)}!`, 42, null, undefined]) {
        const c = montar(t, escopo);
        await assert.rejects(() => redefinir(c, escopo, { token: ruim }), INVALIDA, JSON.stringify(ruim));
        assert.equal(c.pool.conexoes, 0);
        t.mock.restoreAll();
      }
    });

    test('pedido inexistente, usado, cancelado ou expirado e conta inativa ou ausente: sempre o mesmo erro, sem trocar senha nem revogar sessão', async (t) => {
      const pedido = (extra) => ({
        id: PEDIDO_ID, [PERFIS[escopo].campoConta]: CONTA_ID, criadoEm: CRIADO, expiraEm: EXPIRA, usadoEm: null, canceladoEm: null, motivoCancelamento: null, situacao: 'PENDENTE', ...extra,
      });
      const cenarios = {
        inexistente: { PEDIDO_LIDO: null },
        'sumiu sob a trava': { PEDIDO_TRAVADO: null },
        usado: { PEDIDO_TRAVADO: pedido({ situacao: 'USADA', usadoEm: CRIADO }) },
        cancelado: { PEDIDO_TRAVADO: pedido({ situacao: 'CANCELADA', canceladoEm: CRIADO, motivoCancelamento: 'SUBSTITUIDA' }) },
        expirado: { PEDIDO_TRAVADO: pedido({ situacao: 'EXPIRADA' }) },
        'conta inativa': { CONTA_TRAVADA: { id: CONTA_ID, email: EMAIL, ativo: false } },
        'conta ausente': { CONTA_POR_ID: null, CONTA_TRAVADA: null },
        'pedido de outra conta sob a trava': { PEDIDO_TRAVADO: pedido({ [PERFIS[escopo].campoConta]: 99 }) },
      };
      for (const [nome, sobrescritas] of Object.entries(cenarios)) {
        const c = montar(t, escopo, sobrescritas);
        await assert.rejects(() => redefinir(c, escopo), INVALIDA, nome);
        c.nunca('PEDIDO_USADO', 'SENHA_ATUALIZADA', 'HASH_GERADO', 'ENFILEIRAR_AVISO',
          'SESSOES_GLOBAIS_REVOGADAS', 'SESSOES_EMPRESARIAIS_REVOGADAS', 'SESSOES_ADMIN_REVOGADAS', 'DESAFIOS_ENCERRADOS');
        if (c.pool.conexoes > 0) assert.equal(c.cliente.liberado, 1, nome);
        semSensiveis(c, { senhas: [SENHA_NOVA] });
        t.mock.restoreAll();
      }
    });

    test('recusa de pedido conhecido é auditada como evento do sistema, com o motivo, e a transação é confirmada', async (t) => {
      const base = { id: PEDIDO_ID, [PERFIS[escopo].campoConta]: CONTA_ID, criadoEm: CRIADO, expiraEm: EXPIRA, usadoEm: null, canceladoEm: null, motivoCancelamento: null };
      const casos = [
        [{ PEDIDO_TRAVADO: { ...base, situacao: 'USADA', usadoEm: CRIADO } }, 'PEDIDO_USADO'],
        [{ PEDIDO_TRAVADO: { ...base, situacao: 'CANCELADA', canceladoEm: CRIADO, motivoCancelamento: 'SUBSTITUIDA' } }, 'PEDIDO_CANCELADO'],
        [{ PEDIDO_TRAVADO: { ...base, situacao: 'EXPIRADA' } }, 'PEDIDO_EXPIRADO'],
        [{ CONTA_TRAVADA: { id: CONTA_ID, email: EMAIL, ativo: false } }, 'CONTA_INATIVA'],
      ];
      for (const [sobrescritas, motivo] of casos) {
        const c = montar(t, escopo, sobrescritas);
        await assert.rejects(() => redefinir(c, escopo), INVALIDA, motivo);
        assert.equal(c.chamadas.AUDITORIA.length, 1, motivo);
        const [, evento] = c.chamadas.AUDITORIA[0];
        assert.equal(evento.acao, 'REDEFINICAO_SENHA_RECUSADA');
        assert.equal(evento.referencia, PEDIDO_ID);
        assert.deepEqual(evento.contexto, { etapa: 'REDEFINICAO', motivo });
        c.antes('AUDITORIA', 'COMMIT');
        semSensiveis(c, { senhas: [SENHA_NOVA] });
        t.mock.restoreAll();
      }
    });

    test('consumo perdido para outra transação: nada mais é gravado, ROLLBACK e erro genérico', async (t) => {
      const c = montar(t, escopo, { PEDIDO_USADO: false });
      await assert.rejects(() => redefinir(c, escopo), INVALIDA);
      c.nunca('SENHA_ATUALIZADA', 'ENFILEIRAR_AVISO', 'COMMIT');
      c.antes('PEDIDO_USADO', 'ROLLBACK');
    });

    test('nenhuma sessão é criada e o resultado não traz token, cookie, e-mail nem identificador', async (t) => {
      const c = montar(t, escopo);
      const resultado = await redefinir(c, escopo);
      assert.deepEqual(Object.keys(resultado), ['status']);
      c.nunca('SESSAO_GLOBAL_CRIADA', 'SESSAO_EMPRESARIAL_CRIADA', 'SESSAO_ADMIN_CRIADA');
    });

    test('falha inesperada no meio do reset: ROLLBACK, erro propagado e nenhum aviso', async (t) => {
      const falha = Object.assign(new Error('falha simulada'), { code: '57P01' });
      const c = montar(t, escopo, { SENHA_ATUALIZADA: falha });
      await assert.rejects(() => redefinir(c, escopo), (erro) => erro === falha);
      c.antes('SENHA_ATUALIZADA', 'ROLLBACK');
      c.nunca('COMMIT', 'ENFILEIRAR_AVISO');
      assert.equal(c.cliente.liberado, 1);
    });

    test('falha da entrega do aviso depois do COMMIT não desfaz nem altera o resultado', async (t) => {
      const c = montar(t, escopo, { ENTREGA: () => { throw new Error('falha simulada da entrega'); } });
      assert.deepEqual(await redefinir(c, escopo), { status: 'SENHA_REDEFINIDA' });
      c.nunca('ROLLBACK');
    });

    test('aviso que devolve promessa rejeitada: nenhuma rejeição fica sem tratamento e o reset continua concluído', async (t) => {
      const rejeicoes = [];
      const ouvinte = (motivo) => { rejeicoes.push(motivo); };
      process.on('unhandledRejection', ouvinte);
      try {
        const c = montar(t, escopo, { ENTREGA: () => Promise.reject(new Error(`falha simulada com ${EMAIL} e ${SENHA_NOVA}`)) });
        assert.deepEqual(await redefinir(c, escopo), { status: 'SENHA_REDEFINIDA' });
        await new Promise((resolve) => { setImmediate(resolve); });
        await new Promise((resolve) => { setImmediate(resolve); });
        assert.deepEqual(rejeicoes, []);
        c.antes('COMMIT', 'ENFILEIRAR_AVISO');
        c.nunca('ROLLBACK');
        semSensiveis(c, { senhas: [SENHA_NOVA] });
      } finally {
        process.off('unhandledRejection', ouvinte);
      }
    });

    test('auditoria e logs do reset não levam senha, token, hash, link nem e-mail', async (t) => {
      const c = montar(t, escopo);
      await redefinir(c, escopo);
      assert.equal(c.chamadas.AUDITORIA.length, 1);
      const [executor, evento] = c.chamadas.AUDITORIA[0];
      assert.equal(executor, c.cliente);
      assert.equal(evento.acao, 'SENHA_REDEFINIDA');
      assert.equal(evento.referencia, PEDIDO_ID);
      assert.equal('atorTipo' in evento, false);
      semSensiveis(c, { senhas: [SENHA_NOVA] });
    });

    test('o único SQL enviado direto pelo service é fixo e parametrizado', async (t) => {
      const c = montar(t, escopo);
      await redefinir(c, escopo);
      const permitidos = [/^BEGIN$/, /^COMMIT$/, /^ROLLBACK$/, /^SELECT pg_advisory_xact_lock\(\$1::bigint\)$/];
      for (const { texto } of c.sql) {
        assert.ok(permitidos.some((padrao) => padrao.test(texto)), `SQL inesperado: ${texto}`);
        for (const valor of [EMAIL, TOKEN, TOKEN_HASH, SENHA_NOVA, HASH_NOVO]) assert.equal(texto.includes(valor), false);
      }
    });

    test('escopo desconhecido é erro de programação, antes de qualquer conexão', async (t) => {
      const c = montar(t, escopo);
      await assert.rejects(() => c.alvo.redefinir(c.pool, { escopo: 'OUTRO', token: TOKEN, novaSenha: SENHA_NOVA }), TypeError);
      assert.equal(c.pool.conexoes, 0);
    });
  });
}

describe('redefinir — só do Portal', () => {
  test('reset público revoga todas as sessões globais e empresariais da identidade, sem exceção, com o motivo SENHA_REDEFINIDA', async (t) => {
    const c = montar(t, 'PORTAL');
    await redefinir(c, 'PORTAL');
    assert.deepEqual(c.chamadas.SESSOES_GLOBAIS_REVOGADAS[0].slice(1), [CONTA_ID, 'SENHA_REDEFINIDA']);
    assert.deepEqual(c.chamadas.SESSOES_EMPRESARIAIS_REVOGADAS[0].slice(1), [CONTA_ID, 'SENHA_REDEFINIDA']);
    c.antes('SESSOES_GLOBAIS_REVOGADAS', 'COMMIT');
    c.antes('SESSOES_EMPRESARIAIS_REVOGADAS', 'COMMIT');
  });

  test('auditoria na trilha da identidade, como evento do sistema, com as contagens e a origem da requisição', async (t) => {
    const c = montar(t, 'PORTAL', { PENDENTES_CANCELADOS: 0 });
    await redefinir(c, 'PORTAL');
    const [, evento] = c.chamadas.AUDITORIA[0];
    assert.equal(evento.identidadeId, CONTA_ID);
    assert.deepEqual([evento.ip, evento.dispositivo], [IP, DISPOSITIVO]);
    assert.deepEqual(evento.contexto, { origem: 'LINK', sessoesGlobaisRevogadas: 2, sessoesEmpresariaisRevogadas: 3, pedidosCancelados: 0 });
    c.nunca('AUDITORIA_COMO_IDENTIDADE');
  });
});

describe('redefinir — só do Painel Privado', () => {
  test('toma a trava do MFA do administrador antes da linha da conta e encerra os desafios abertos', async (t) => {
    const c = montar(t, 'PLATAFORMA');
    await redefinir(c, 'PLATAFORMA');
    c.antes('TRAVA_CONSULTIVA', 'TRAVA_MFA');
    c.antes('TRAVA_MFA', 'CONTA_TRAVADA');
    assert.deepEqual(c.chamadas.TRAVA_MFA[0].slice(1), [CONTA_ID]);
    assert.deepEqual(c.chamadas.DESAFIOS_ENCERRADOS[0][1], { administradorId: CONTA_ID, motivo: 'SENHA_REDEFINIDA' });
    c.antes('DESAFIOS_ENCERRADOS', 'COMMIT');
  });

  test('revoga todas as sessões administrativas, sem exceção', async (t) => {
    const c = montar(t, 'PLATAFORMA');
    await redefinir(c, 'PLATAFORMA');
    assert.deepEqual(c.chamadas.SESSOES_ADMIN_REVOGADAS[0].slice(1), [CONTA_ID, 'SENHA_REDEFINIDA']);
    c.antes('SESSOES_ADMIN_REVOGADAS', 'COMMIT');
  });

  test('não toca em fator, lote nem código de recuperação do MFA, e nenhuma função do Portal é usada', async (t) => {
    const c = montar(t, 'PLATAFORMA');
    await redefinir(c, 'PLATAFORMA');
    assert.deepEqual(c.eventos.filter((e) => e.startsWith('MFA_')), []);
    c.nunca('SESSOES_GLOBAIS_REVOGADAS', 'SESSOES_EMPRESARIAIS_REVOGADAS');
  });

  test('auditoria na trilha da plataforma, como evento do sistema sobre o administrador afetado', async (t) => {
    const c = montar(t, 'PLATAFORMA');
    await redefinir(c, 'PLATAFORMA');
    const [, evento] = c.chamadas.AUDITORIA[0];
    assert.equal(evento.administradorAfetadoId, CONTA_ID);
    assert.equal('administradorId' in evento, false, 'não há administrador ator num fluxo sem sessão');
    assert.deepEqual(evento.contexto, { origem: 'LINK', sessoesRevogadas: 4, desafiosEncerrados: 1, pedidosCancelados: 0 });
    c.nunca('AUDITORIA_COMO_ADMINISTRADOR', 'AUDITORIA_COMO_CLI');
  });
});
