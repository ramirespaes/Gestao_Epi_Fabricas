'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const travaRepo = require('../../src/repositories/trava-mfa-plataforma.repository');
const desafioRepo = require('../../src/repositories/desafio-mfa-plataforma.repository');
const fatorRepo = require('../../src/repositories/fator-mfa-plataforma.repository');
const liberacaoRepo = require('../../src/repositories/liberacao-cadastro-mfa-plataforma.repository');
const loteRepo = require('../../src/repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../../src/repositories/codigo-recuperacao-mfa-plataforma.repository');
const sessaoRepo = require('../../src/repositories/sessao-plataforma.repository');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const auditoriaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const tentativaRepo = require('../../src/repositories/login-tentativa-plataforma.repository');
const desafioService = require('../../src/services/desafio-mfa-plataforma.service');
const mfaCripto = require('../../src/security/mfa-cripto');
const totp = require('../../src/security/totp');
const codigosMfa = require('../../src/security/codigos-mfa');
const cooldown = require('../../src/security/cooldown');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');
const { authConfig } = require('../../src/config/auth');
const { HttpError } = require('../../src/errors/HttpError');

const servico = require('../../src/services/mfa-cadastro-plataforma.service');

/**
 * Cadastro do primeiro TOTP, sem PostgreSQL: repositórios, criptografia e
 * wrapper TOTP mockados por namespace, registrando a ORDEM das chamadas.
 * Cada teste prova um contrato do fluxo: sequência transacional, fail-closed
 * criptográfico (503 sem consumir nada), falhas por desafio e cooldown, e que
 * segredo, URI, recovery codes e tokens só existem no retorno.
 */

const ADMIN = 9;
const DESAFIO = '300';
const FATOR = '41';
const FATOR_UID = '3f2c8a4e-9b1d-4c7a-8e2f-5a6b7c8d9e0f';
const AGORA = new Date('2026-09-28T12:00:00.000Z');
const ENVELOPE = Object.freeze({ formatoVersao: 1, chaveVersao: 1, nonce: Buffer.alloc(12, 1), segredoCifrado: Buffer.alloc(36, 2) });
const CHAVE_COOLDOWN = cooldown.gerarChaveCooldownMfaPlataforma(ADMIN);

function criarCliente() {
  const chamadas = [];
  return {
    chamadas,
    query: async (texto) => {
      chamadas.push(texto);
      if (/clock_timestamp/i.test(texto)) return { rows: [{ agora: AGORA }] };
      return { rows: [], rowCount: 0 };
    },
    release: () => chamadas.push('RELEASE'),
  };
}
function criarPool(cliente) {
  const pool = { conexoes: 0, connect: async () => { pool.conexoes += 1; return cliente; } };
  return pool;
}
const contar = (chamadas, texto) => chamadas.filter((c) => c === texto).length;

const desafio = (extra = {}) => ({
  id: DESAFIO, administradorId: ADMIN, tipo: 'LIBERACAO', fatorPendenteId: null, falhas: 0, reinicios: 0, encerradoEm: null, expiraEm: new Date('2026-09-28T12:15:00Z'), ...extra,
});
const pendente = (extra = {}) => ({
  id: FATOR, fatorUid: FATOR_UID, administradorId: ADMIN, tipo: 'TOTP', estado: 'PENDENTE', formatoVersao: 1, chaveVersao: 1,
  nonce: ENVELOPE.nonce, segredoCifrado: ENVELOPE.segredoCifrado, ultimoStepAceito: null, pendenteVigente: true, ...extra,
});

/** Mocks de todas as dependências; `ordem` registra a sequência das chamadas. */
function preparar(t, cenario = {}) {
  const ordem = [];
  const m = (alvo, nome, retorno) => t.mock.method(alvo, nome, async (...args) => {
    ordem.push(nome);
    return typeof retorno === 'function' ? retorno(...args) : retorno;
  });
  const sincrono = (alvo, nome, retorno) => t.mock.method(alvo, nome, (...args) => {
    ordem.push(nome);
    return typeof retorno === 'function' ? retorno(...args) : retorno;
  });
  const segredosEntregues = [];
  return {
    ordem,
    segredosEntregues,
    garantir: sincrono(mfaCripto, 'garantirChaveAtual', cenario.garantir ?? undefined),
    cifrar: sincrono(mfaCripto, 'cifrarSegredoTotp', cenario.cifrar ?? ((dados) => { segredosEntregues.push(dados.segredo); return ENVELOPE; })),
    decifrar: sincrono(mfaCripto, 'decifrarSegredoTotp', cenario.decifrar ?? (() => Buffer.alloc(20, 7))),
    validar: sincrono(totp, 'validarCodigo', cenario.validar ?? (() => ({ step: 59999999 }))),
    travar: m(travaRepo, 'travarAdministrador', undefined),
    buscarDesafio: m(desafioRepo, 'buscarValidoPorId', cenario.desafio === undefined ? desafio() : cenario.desafio),
    cooldownVigente: m(tentativaRepo, 'buscarCooldownVigente', cenario.cooldown ?? null),
    tentativa: m(tentativaRepo, 'registrarTentativa', '1'),
    contarFalhas: m(tentativaRepo, 'contarFalhasRecentes', cenario.falhasRecentes ?? 0),
    ativarCooldown: m(tentativaRepo, 'registrarAtivacaoCooldown', '2'),
    incrementar: m(desafioRepo, 'incrementarFalhas', cenario.falhasDoDesafio ?? 1),
    buscarLiberacao: m(liberacaoRepo, 'buscarValidaPorHash', cenario.liberacao === undefined ? { id: '5', origem: 'CLI_LIBERACAO' } : cenario.liberacao),
    consumir: m(liberacaoRepo, 'consumir', '5'),
    revogarPendente: m(fatorRepo, 'revogarPendenteTotp', 0),
    revogarFator: m(fatorRepo, 'revogar', true),
    criarPendente: m(fatorRepo, 'criarPendenteTotp', { id: '42', fatorUid: FATOR_UID, criadoEm: AGORA, pendenteExpiraEm: new Date('2026-09-28T12:15:00Z') }),
    buscarFator: m(fatorRepo, 'buscarPorId', cenario.fator === undefined ? pendente() : cenario.fator),
    buscarAtivo: m(fatorRepo, 'buscarTotpAtivo', cenario.ativo ?? null),
    ativar: m(fatorRepo, 'ativarTotp', cenario.ativou ?? true),
    trocar: m(desafioRepo, 'trocarFatorPendente', cenario.trocou ?? true),
    encerrar: m(desafioRepo, 'encerrar', true),
    ligar: m(desafioRepo, 'ligarSessaoCriada', cenario.ligou ?? true),
    criarDesafio: m(desafioService, 'criarDesafioSobTrava', async (_, dados) => ({
      token: gerarTokenSessao(), desafio: { etapa: dados.tipo, expiraEm: new Date('2026-09-28T12:15:00Z'), validadeMinutos: dados.validadeMinutos },
    })),
    administrador: m(administradorRepo, 'buscarPorId', { id: ADMIN, email: 'admin@safework.com.br', ativo: true }),
    revogarLote: m(loteRepo, 'revogarAtivo', false),
    criarLote: m(loteRepo, 'criar', { id: '7', criadoEm: AGORA }),
    inserirHashes: m(codigoRepo, 'inserirHashes', (_, dados) => dados.hashes.length),
    sessaoAnterior: m(sessaoRepo, 'buscarValidaPorHash', cenario.sessaoAnterior ?? null),
    revogarSessao: m(sessaoRepo, 'revogar', true),
    criarSessao: m(sessaoRepo, 'criar', '777'),
    auditar: m(auditoriaRepo, 'registrar', { id: '1', criadoEm: AGORA }),
    auditarSistema: m(auditoriaRepo, 'registrarEventoSistema', { id: '2', criadoEm: AGORA }),
  };
}

const erroHttp = (status, codigo) => (erro) => {
  assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}`);
  assert.deepEqual([erro.status, erro.codigo], [status, codigo]);
  return true;
};
const indisponivel = erroHttp(503, 'MFA_INDISPONIVEL');
const dadosLiberacao = (codigoLiberacao = 'ABCD-EFGH-JKMN-PQRS') => ({ desafioId: DESAFIO, administradorId: ADMIN, codigoLiberacao, ip: '203.0.113.9', dispositivo: 'teste' });

describe('confirmarLiberacao: LIBERACAO -> CADASTRO', () => {
  test('sucesso: sequência sob as travas, PENDENTE cifrado, liberação consumida, desafio novo com token novo; URI e chave manual só no retorno', async (t) => {
    const x = preparar(t);
    const cliente = criarCliente();

    const r = await servico.confirmarLiberacao(criarPool(cliente), dadosLiberacao('abcd efgh jkmn pqrs'));

    assert.deepEqual(x.ordem.slice(0, 5), ['garantirChaveAtual', 'travarAdministrador', 'buscarValidoPorId', 'buscarCooldownVigente', 'buscarValidaPorHash']);
    assert.deepEqual(x.buscarDesafio.mock.calls[0].arguments.slice(1), [{ desafioId: DESAFIO, administradorId: ADMIN }, { travar: true }]);
    assert.deepEqual(x.buscarLiberacao.mock.calls[0].arguments[1], {
      administradorId: ADMIN, codigoHash: codigosMfa.hashCodigoLiberacao({ administradorId: ADMIN, codigo: 'ABCDEFGHJKMNPQRS' }),
    });
    assert.deepEqual(x.buscarLiberacao.mock.calls[0].arguments[2], { travar: true });
    const depois = x.ordem.slice(x.ordem.indexOf('cifrarSegredoTotp'));
    assert.deepEqual(
      depois.filter((n) => ['cifrarSegredoTotp', 'revogarPendenteTotp', 'criarPendenteTotp', 'consumir', 'encerrar', 'criarDesafioSobTrava'].includes(n)),
      ['cifrarSegredoTotp', 'revogarPendenteTotp', 'criarPendenteTotp', 'consumir', 'encerrar', 'criarDesafioSobTrava'],
    );
    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'TRANSICAO' });
    const novo = x.criarDesafio.mock.calls[0].arguments[1];
    assert.deepEqual(novo, {
      administradorId: ADMIN, tipo: 'CADASTRO', validadeMinutos: authConfig.desafioMfa.cadastroMinutos, fatorPendenteId: '42', desafioAnteriorId: DESAFIO,
    });
    assert.equal(x.criarPendente.mock.calls[0].arguments[1].envelope, ENVELOPE);
    assert.equal(x.criarPendente.mock.calls[0].arguments[1].validadeMinutos, authConfig.desafioMfa.cadastroMinutos);

    assert.deepEqual(Object.keys(r).sort(), ['cadastro', 'desafio', 'token']);
    assert.equal(r.desafio.etapa, 'CADASTRO');
    assert.match(r.cadastro.uri, /^otpauth:\/\/totp\//);
    assert.match(r.cadastro.chaveManual, /^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/);
    assert.equal(x.segredosEntregues[0].equals(Buffer.alloc(20)), true, 'o secret em claro é zerado depois de usado');

    const auditorias = x.auditar.mock.calls.map((c) => c.arguments[1]);
    assert.deepEqual(auditorias.map((a) => a.acao), ['LIBERACAO_CADASTRO_CONSUMIDA', 'MFA_CADASTRO_INICIADO']);
    for (const a of auditorias) {
      assert.equal(a.administradorId, ADMIN);
      assert.equal(a.contexto.etapa, 'pre_mfa');
      const texto = JSON.stringify(a);
      for (const proibido of ['otpauth', r.cadastro.chaveManual.replace(/ /g, ''), r.token, 'ABCDEFGHJKMNPQRS']) {
        assert.equal(texto.includes(proibido), false);
      }
    }
    assert.equal(x.tentativa.mock.calls[0].arguments[1].sucesso, true);
    assert.equal(x.tentativa.mock.calls[0].arguments[1].chaveCooldown, CHAVE_COOLDOWN);
    assert.deepEqual([contar(cliente.chamadas, 'COMMIT'), contar(cliente.chamadas, 'ROLLBACK')], [1, 0]);
  });

  test('chave atual indisponível antes da transação: 503, nada aberto, evento SISTEMA com o alvo, nenhuma falha contada', async (t) => {
    const x = preparar(t, { garantir: () => { throw new mfaCripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL'); } });
    const pool = criarPool(criarCliente());

    await assert.rejects(() => servico.confirmarLiberacao(pool, dadosLiberacao()), indisponivel);

    assert.equal(pool.conexoes, 0);
    assert.equal(x.buscarLiberacao.mock.calls.length, 0);
    assert.equal(x.tentativa.mock.calls.length, 0);
    const evento = x.auditarSistema.mock.calls[0].arguments[1];
    assert.equal(evento.acao, 'MFA_CHAVE_INDISPONIVEL');
    assert.equal(evento.administradorAfetadoId, ADMIN);
    assert.deepEqual(evento.contexto, { operacao: 'liberacao', motivo: 'CHAVE_INDISPONIVEL' });
  });

  test('cifragem falha dentro da transação: ROLLBACK, 503, liberação não consumida, nenhum PENDENTE, desafio intacto, evento SISTEMA depois', async (t) => {
    const x = preparar(t, { cifrar: () => { throw new mfaCripto.ErroCriptografiaMfa('CHAVE_INDISPONIVEL'); } });
    const cliente = criarCliente();

    await assert.rejects(() => servico.confirmarLiberacao(criarPool(cliente), dadosLiberacao()), indisponivel);

    assert.deepEqual([contar(cliente.chamadas, 'ROLLBACK'), contar(cliente.chamadas, 'COMMIT')], [1, 0]);
    for (const mockado of [x.consumir, x.criarPendente, x.revogarPendente, x.encerrar, x.criarDesafio, x.incrementar, x.tentativa]) {
      assert.equal(mockado.mock.calls.length, 0);
    }
    assert.equal(x.auditarSistema.mock.calls.length, 1);
    assert.notEqual(x.auditarSistema.mock.calls[0].arguments[0], cliente, 'o evento vai em transação própria, depois do ROLLBACK');
  });

  test('código inválido: falha contada no desafio e no cooldown, COMMIT, 401 genérico; nada criado', async (t) => {
    for (const cenario of [{ entrada: 'nao-e-um-codigo' }, { entrada: 'ABCD-EFGH-JKMN-PQRS', liberacao: null }]) {
      const x = preparar(t, { liberacao: cenario.liberacao });
      const cliente = criarCliente();

      await assert.rejects(() => servico.confirmarLiberacao(criarPool(cliente), dadosLiberacao(cenario.entrada)), erroHttp(401, 'MFA_CODIGO_INVALIDO'));

      const tentativa = x.tentativa.mock.calls[0].arguments[1];
      assert.deepEqual([tentativa.sucesso, tentativa.motivo, tentativa.chaveCooldown, tentativa.administradorId], [false, 'LIBERACAO_INVALIDA', CHAVE_COOLDOWN, ADMIN]);
      assert.equal(x.incrementar.mock.calls[0].arguments[1], DESAFIO);
      assert.equal(x.cifrar.mock.calls.length, 0);
      assert.equal(x.consumir.mock.calls.length, 0);
      assert.deepEqual([contar(cliente.chamadas, 'COMMIT'), contar(cliente.chamadas, 'ROLLBACK')], [1, 0]);
      t.mock.restoreAll();
    }
  });

  test('ao atingir o máximo de falhas, o desafio é encerrado (FALHAS_EXCEDIDAS) e auditado', async (t) => {
    const x = preparar(t, { liberacao: null, falhasDoDesafio: authConfig.desafioMfa.maxFalhas });

    await assert.rejects(() => servico.confirmarLiberacao(criarPool(criarCliente()), dadosLiberacao()), erroHttp(401, 'MFA_CODIGO_INVALIDO'));

    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'FALHAS_EXCEDIDAS' });
    assert.ok(x.auditar.mock.calls.some((c) => c.arguments[1].acao === 'MFA_DESAFIO_ESGOTADO'));
  });

  test('falhas recentes acima do limiar ativam o cooldown de MFA do administrador', async (t) => {
    const x = preparar(t, { liberacao: null, falhasRecentes: authConfig.cooldown.niveis[0].falhas });

    await assert.rejects(() => servico.confirmarLiberacao(criarPool(criarCliente()), dadosLiberacao()), erroHttp(401, 'MFA_CODIGO_INVALIDO'));

    const ativacao = x.ativarCooldown.mock.calls[0].arguments[1];
    assert.equal(ativacao.chaveCooldown, CHAVE_COOLDOWN);
    assert.ok(ativacao.cooldownAte > AGORA);
  });

  test('cooldown vigente: 429 com Retry-After, o código nem é conferido e nenhuma tentativa nova é gravada', async (t) => {
    const x = preparar(t, { cooldown: { ativoAte: new Date(Date.now() + 60_000) } });

    await assert.rejects(() => servico.confirmarLiberacao(criarPool(criarCliente()), dadosLiberacao()), (erro) => {
      erroHttp(429, 'MFA_EM_COOLDOWN')(erro);
      assert.ok(Number(erro.headers['Retry-After']) > 0);
      return true;
    });
    assert.equal(x.buscarLiberacao.mock.calls.length, 0);
    assert.equal(x.tentativa.mock.calls.length, 0);
  });

  test('desafio não mais válido dentro da transação (encerrado por outra requisição, vencido ou de outro tipo): 401 DESAFIO_INVALIDO', async (t) => {
    for (const d of [null, desafio({ tipo: 'CADASTRO', fatorPendenteId: FATOR })]) {
      const x = preparar(t, { desafio: d });
      await assert.rejects(() => servico.confirmarLiberacao(criarPool(criarCliente()), dadosLiberacao()), erroHttp(401, 'DESAFIO_INVALIDO'));
      assert.equal(x.buscarLiberacao.mock.calls.length, 0);
      t.mock.restoreAll();
    }
  });
});

describe('reiniciarCadastro', () => {
  const dados = { desafioId: DESAFIO, administradorId: ADMIN, ip: null, dispositivo: null };

  test('gera secret novo, revoga o PENDENTE anterior, grava o novo e conta o reinício; nada de sessão', async (t) => {
    const x = preparar(t, { desafio: desafio({ tipo: 'CADASTRO', fatorPendenteId: FATOR, reinicios: 1 }) });

    const r = await servico.reiniciarCadastro(criarPool(criarCliente()), dados);

    assert.deepEqual(x.revogarFator.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: FATOR, motivo: 'REINICIADO' });
    assert.deepEqual(x.trocar.mock.calls[0].arguments[1], { desafioId: DESAFIO, fatorPendenteId: '42', maximoReinicios: 3 });
    assert.ok(x.ordem.indexOf('cifrarSegredoTotp') < x.ordem.indexOf('revogar'));
    assert.match(r.cadastro.uri, /^otpauth:/);
    assert.equal(r.desafio.etapa, 'CADASTRO');
    assert.equal(x.criarSessao.mock.calls.length, 0);
    assert.equal(x.segredosEntregues[0].equals(Buffer.alloc(20)), true);
  });

  test('com 3 reinícios já feitos: 409, sem gerar nem cifrar secret', async (t) => {
    const x = preparar(t, { desafio: desafio({ tipo: 'CADASTRO', fatorPendenteId: FATOR, reinicios: 3 }) });

    await assert.rejects(() => servico.reiniciarCadastro(criarPool(criarCliente()), dados), erroHttp(409, 'MFA_CADASTRO_REINICIOS_ESGOTADOS'));
    assert.equal(x.cifrar.mock.calls.length, 0);
  });

  test('falha de cifragem: 503, ROLLBACK, o reinício não é contado', async (t) => {
    const x = preparar(t, {
      desafio: desafio({ tipo: 'CADASTRO', fatorPendenteId: FATOR }),
      cifrar: () => { throw new mfaCripto.ErroCriptografiaMfa('AUTENTICACAO_FALHOU'); },
    });
    const cliente = criarCliente();

    await assert.rejects(() => servico.reiniciarCadastro(criarPool(cliente), dados), indisponivel);

    assert.equal(x.trocar.mock.calls.length, 0);
    assert.equal(x.revogarFator.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, 'ROLLBACK'), 1);
  });

  test('só em CADASTRO ou RECUPERACAO: outro tipo é 401 DESAFIO_INVALIDO', async (t) => {
    for (const d of [desafio(), desafio({ tipo: 'VERIFICACAO' }), desafio({ tipo: 'SUBSTITUICAO', fatorPendenteId: FATOR })]) {
      preparar(t, { desafio: d });
      await assert.rejects(() => servico.reiniciarCadastro(criarPool(criarCliente()), dados), erroHttp(401, 'DESAFIO_INVALIDO'), d.tipo);
      t.mock.restoreAll();
    }
  });
});

describe('desafio no limite de falhas', () => {
  const limite = authConfig.desafioMfa.maxFalhas;
  const base = { desafioId: DESAFIO, administradorId: ADMIN, ip: '203.0.113.9', dispositivo: 'teste' };

  test('LIBERACAO, reinício e confirmação do cadastro recusam o desafio sem tocar em nada', async (t) => {
    const casos = [
      ['confirmarLiberacao', desafio({ falhas: limite }), { ...base, codigoLiberacao: 'ABCD-EFGH-JKMN-PQRS' }, 'buscarLiberacao'],
      ['reiniciarCadastro', desafio({ tipo: 'CADASTRO', fatorPendenteId: FATOR, falhas: limite }), base, 'cifrar'],
      ['confirmarCadastro', desafio({ tipo: 'CADASTRO', fatorPendenteId: FATOR, falhas: limite }), { ...base, codigo: '123456' }, 'buscarFator'],
    ];
    for (const [funcao, noLimite, dados, naoChamado] of casos) {
      const x = preparar(t, { desafio: noLimite });
      await assert.rejects(() => servico[funcao](criarPool(criarCliente()), dados), erroHttp(401, 'DESAFIO_INVALIDO'), funcao);
      assert.equal(x[naoChamado].mock.calls.length, 0, funcao);
      assert.equal(x.incrementar.mock.calls.length, 0, funcao);
      t.mock.restoreAll();
    }
  });

  test('uma falha abaixo do limite ainda conclui o cadastro', async (t) => {
    preparar(t, { desafio: desafio({ tipo: 'CADASTRO', fatorPendenteId: FATOR, falhas: limite - 1 }) });
    const r = await servico.confirmarCadastro(criarPool(criarCliente()), { ...base, codigo: '123456' });
    assert.equal(r.codigosRecuperacao.length, 10);
  });
});

describe('confirmarCadastro: primeiro TOTP, recovery codes e sessão plena', () => {
  const dados = (extra = {}) => ({ desafioId: DESAFIO, administradorId: ADMIN, codigo: '123456', tokenSessaoAnterior: null, ip: '203.0.113.9', dispositivo: 'teste', ...extra });
  const emCadastro = () => desafio({ tipo: 'CADASTRO', fatorPendenteId: FATOR });

  test('sucesso: ativa com o step do banco, 10 recovery codes só como hash, desafio concluído, sessão nova com MFA CADASTRO', async (t) => {
    const x = preparar(t, { desafio: emCadastro() });
    const cliente = criarCliente();

    const r = await servico.confirmarCadastro(criarPool(cliente), dados());

    assert.deepEqual(x.validar.mock.calls[0].arguments[0].instanteMs, AGORA.getTime(), 'o instante vem do clock_timestamp() do banco');
    assert.equal(x.validar.mock.calls[0].arguments[0].codigo, '123456');
    assert.deepEqual(x.buscarFator.mock.calls[0].arguments.slice(1), [{ administradorId: ADMIN, fatorId: FATOR }, { travar: true }]);
    assert.deepEqual(x.ativar.mock.calls[0].arguments[1], { administradorId: ADMIN, fatorId: FATOR, step: 59999999 });

    assert.equal(r.codigosRecuperacao.length, 10);
    assert.equal(new Set(r.codigosRecuperacao).size, 10);
    for (const codigo of r.codigosRecuperacao) assert.match(codigo, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    const hashes = x.inserirHashes.mock.calls[0].arguments[1].hashes;
    assert.deepEqual(hashes, r.codigosRecuperacao.map((c) => codigosMfa.hashCodigoRecuperacao({ administradorId: ADMIN, codigo: codigosMfa.normalizarCodigo(c) })));
    assert.equal(x.inserirHashes.mock.calls[0].arguments[1].loteId, '7');

    assert.deepEqual(x.encerrar.mock.calls[0].arguments[1], { desafioId: DESAFIO, motivo: 'CONCLUIDO' });
    const sessao = x.criarSessao.mock.calls[0].arguments[1];
    assert.equal(sessao.tokenHash, hashTokenSessao(r.token));
    assert.deepEqual(sessao.mfa, { verificadoEm: AGORA, metodo: 'CADASTRO' });
    assert.deepEqual(sessao.expiraEm, new Date(AGORA.getTime() + authConfig.sessao.expiracaoMinutosAdmin * 60_000));
    assert.deepEqual(x.ligar.mock.calls[0].arguments[1], { desafioId: DESAFIO, sessaoId: '777' });
    assert.ok(x.ordem.indexOf('encerrar') < x.ordem.indexOf('ligarSessaoCriada'));

    const texto = JSON.stringify(x.auditar.mock.calls.map((c) => c.arguments[1]));
    assert.ok(texto.includes('MFA_CADASTRO_CONCLUIDO'));
    for (const proibido of [...r.codigosRecuperacao, r.token, '123456']) assert.equal(texto.includes(proibido), false);
    assert.deepEqual([contar(cliente.chamadas, 'COMMIT'), contar(cliente.chamadas, 'ROLLBACK')], [1, 0]);
  });

  test('sessão que não fica ligada ao desafio concluído: erro e ROLLBACK; nenhum token nem código é devolvido', async (t) => {
    const x = preparar(t, { desafio: emCadastro(), ligou: false });
    const cliente = criarCliente();

    await assert.rejects(() => servico.confirmarCadastro(criarPool(cliente), dados()), (erro) => {
      assert.equal(HttpError.ehHttpError(erro), false, 'falha interna, não resposta pública');
      return true;
    });

    assert.equal(x.ligar.mock.calls.length, 1);
    assert.equal(x.auditar.mock.calls.length, 0);
    assert.deepEqual([contar(cliente.chamadas, 'COMMIT'), contar(cliente.chamadas, 'ROLLBACK')], [0, 1]);
  });

  test('a sessão que este navegador já apresentava é revogada; o token do desafio nunca vira sessão', async (t) => {
    const tokenAnterior = gerarTokenSessao();
    const x = preparar(t, { desafio: emCadastro(), sessaoAnterior: { sessao: { id: '500' }, administrador: { id: ADMIN } } });

    const r = await servico.confirmarCadastro(criarPool(criarCliente()), dados({ tokenSessaoAnterior: tokenAnterior }));

    assert.equal(x.sessaoAnterior.mock.calls[0].arguments[1], hashTokenSessao(tokenAnterior));
    assert.deepEqual(x.revogarSessao.mock.calls[0].arguments.slice(1), ['500', 'SUBSTITUIDA_NO_NAVEGADOR']);
    assert.notEqual(r.token, tokenAnterior);
  });

  test('TOTP errado: falha contada (TOTP_INVALIDO), nada ativado, nenhuma sessão', async (t) => {
    const x = preparar(t, { desafio: emCadastro(), validar: () => null });

    await assert.rejects(() => servico.confirmarCadastro(criarPool(criarCliente()), dados()), erroHttp(401, 'MFA_CODIGO_INVALIDO'));

    assert.equal(x.tentativa.mock.calls[0].arguments[1].motivo, 'TOTP_INVALIDO');
    for (const mockado of [x.ativar, x.criarLote, x.criarSessao]) assert.equal(mockado.mock.calls.length, 0);
  });

  test('falha ao decifrar: 503, ROLLBACK, nada ativado, nenhuma falha atribuída ao administrador', async (t) => {
    const x = preparar(t, { desafio: emCadastro(), decifrar: () => { throw new mfaCripto.ErroCriptografiaMfa('AUTENTICACAO_FALHOU'); } });
    const cliente = criarCliente();

    await assert.rejects(() => servico.confirmarCadastro(criarPool(cliente), dados()), indisponivel);

    assert.equal(contar(cliente.chamadas, 'ROLLBACK'), 1);
    for (const mockado of [x.ativar, x.criarSessao, x.tentativa, x.incrementar]) assert.equal(mockado.mock.calls.length, 0);
    assert.deepEqual(x.auditarSistema.mock.calls[0].arguments[1].contexto, { operacao: 'cadastro', motivo: 'AUTENTICACAO_FALHOU' });
  });

  test('PENDENTE vencido: 409, sem decifrar; já existe TOTP ATIVO: 409, sem ativar', async (t) => {
    let x = preparar(t, { desafio: emCadastro(), fator: pendente({ pendenteVigente: false }) });
    await assert.rejects(() => servico.confirmarCadastro(criarPool(criarCliente()), dados()), erroHttp(409, 'MFA_CADASTRO_EXPIRADO'));
    assert.equal(x.decifrar.mock.calls.length, 0);
    t.mock.restoreAll();

    x = preparar(t, { desafio: emCadastro(), ativo: { id: '40', estado: 'ATIVO' } });
    await assert.rejects(() => servico.confirmarCadastro(criarPool(criarCliente()), dados()), erroHttp(409, 'MFA_JA_ATIVO'));
    assert.equal(x.ativar.mock.calls.length, 0);
  });

  test('só em CADASTRO: LIBERACAO ou RECUPERACAO são 401 DESAFIO_INVALIDO', async (t) => {
    for (const d of [desafio(), desafio({ tipo: 'RECUPERACAO', fatorPendenteId: FATOR })]) {
      preparar(t, { desafio: d });
      await assert.rejects(() => servico.confirmarCadastro(criarPool(criarCliente()), dados()), erroHttp(401, 'DESAFIO_INVALIDO'));
      t.mock.restoreAll();
    }
  });
});
