'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const servico = require('../../src/services/convite-usuario.service');
const autoridade = require('../../src/services/autoridade-administrativa');
const entrega = require('../../src/services/entrega-convite-usuario.service');
const conviteRepo = require('../../src/repositories/convite-usuario.repository');
const usuarioAdministracaoRepo = require('../../src/repositories/usuario-administracao.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Reenvio do convite de usuário e teto de envios (Bloco 11H), sem
 * PostgreSQL. Foco no que o fluxo real não isola: a ordem das travas, o que
 * NÃO é chamado em cada recusa, que cancelar o anterior e criar o novo
 * acontecem na mesma transação e que a auditoria aponta sem carregar dados
 * pessoais. O comportamento no banco está em convite-reenvio.integration.js.
 */

const EMPRESA_ID = 3;
const MASTER = Object.freeze({ id: 5, perfil: 'MASTER', ativo: true });
const ADMINISTRADOR = Object.freeze({ id: 6, perfil: 'ADMINISTRADOR', ativo: true });
const EMAIL = 'pessoa.convidada@exemplo-cliente.com.br';
const NOME = 'Pessoa Convidada da Silva';
const agora = new Date('2026-10-02T12:00:00.000Z');
const SEM_ENVIOS = Object.freeze({
  total: 0, primeiroEm: null, ultimoEm: null, agora,
});

const convite = (extra = {}) => ({
  id: '40', empresaId: EMPRESA_ID, emailConvite: EMAIL, nome: NOME, perfil: 'SUPERVISOR', criadoPor: 5, situacao: 'PENDENTE', criadoEm: new Date('2026-10-02T10:00:00Z'), expiraEm: new Date('2026-10-02T14:00:00Z'), canceladoEm: null, ...extra,
});

function clienteFalso(ordem) {
  const chamadas = [];
  return {
    chamadas,
    query: async (t) => {
      chamadas.push(t);
      if (/pg_advisory_xact_lock/.test(t)) ordem.push('trava-consultiva');
      return /clock_timestamp/.test(t) ? { rows: [{ agora }] } : { rows: [], rowCount: 0 };
    },
    release: () => chamadas.push('RELEASE'),
  };
}
const poolFalso = (cliente) => ({ connect: async () => cliente });

/** Monta o mundo do reenvio; cada teste troca só o que importa. */
function mundo(t, { ator = MASTER, lido = convite(), travado = lido, vinculo = null, pendente = lido, resumo = SEM_ENVIOS, cancelado } = {}) {
  const ordem = [];
  const marca = (nome, valor) => async (...args) => { ordem.push(nome); return typeof valor === 'function' ? valor(...args) : valor; };
  const mocks = {
    autoridade: t.mock.method(autoridade, 'exigirAutoridadeAdministrativa', marca('autoridade', ator)),
    lido: t.mock.method(conviteRepo, 'buscarPorId', marca('leitura', lido)),
    travado: t.mock.method(conviteRepo, 'buscarPorIdParaAtualizacao', marca('linha-travada', travado)),
    vinculo: t.mock.method(usuarioAdministracaoRepo, 'buscarVinculoPorEmail', marca('vinculo', vinculo)),
    pendente: t.mock.method(conviteRepo, 'buscarPendentePorEmailParaAtualizacao', marca('pendente', pendente)),
    resumo: t.mock.method(conviteRepo, 'resumirEnvios', marca('teto', resumo)),
    cancelar: t.mock.method(conviteRepo, 'cancelar', marca('cancelar', cancelado ?? (() => ({ ...convite(), situacao: 'CANCELADO', canceladoEm: agora })))),
    criar: t.mock.method(conviteRepo, 'criar', marca('criar', (_, d) => ({
      id: '41', empresaId: d.empresaId, emailConvite: d.emailConvite, nome: d.nome, perfil: d.perfil, situacao: 'PENDENTE', criadoEm: agora, expiraEm: d.expiraEm, canceladoEm: null,
    }))),
    audit: t.mock.method(auditoriaRepo, 'registrar', marca('auditoria', { id: '1' })),
  };
  return { ordem, ...mocks };
}

const reenviar = (cliente, extra = {}) => servico.reenviar(poolFalso(cliente), {
  empresaId: EMPRESA_ID, atorId: MASTER.id, conviteId: '40', ip: '10.0.0.1', dispositivo: 'Navegador', ...extra,
});

describe('reenviar — caminho de sucesso', () => {
  test('cancela o convite anterior e cria um novo com o mesmo e-mail, nome e perfil, dentro de uma única transação', async (t) => {
    const m = mundo(t);
    const cliente = clienteFalso(m.ordem);
    const r = await reenviar(cliente);

    assert.equal(m.cancelar.mock.calls.length, 1);
    assert.deepEqual(m.cancelar.mock.calls[0].arguments.slice(1), [EMPRESA_ID, '40']);
    const gravado = m.criar.mock.calls[0].arguments[1];
    assert.equal(gravado.empresaId, EMPRESA_ID);
    assert.equal(gravado.emailConvite, EMAIL);
    assert.equal(gravado.nome, NOME);
    assert.equal(gravado.perfil, 'SUPERVISOR');
    assert.equal(gravado.criadoPor, MASTER.id, 'quem reenvia passa a ser quem convidou');
    assert.ok(gravado.expiraEm > agora, 'validade nova, a partir do instante do reenvio');

    assert.equal(cliente.chamadas.filter((c) => c === 'BEGIN').length, 1);
    assert.equal(cliente.chamadas.filter((c) => c === 'COMMIT').length, 1);
    assert.equal(cliente.chamadas.includes('ROLLBACK'), false);
    assert.equal(r.conviteAnteriorId, '40');
    assert.equal(r.convite.id, '41');
  });

  test('a ordem é: autoridade, leitura, trava consultiva do par, linha travada, vínculo, pendente, teto, cancelar, criar, auditoria', async (t) => {
    const m = mundo(t);
    await reenviar(clienteFalso(m.ordem));
    assert.deepEqual(m.ordem, ['autoridade', 'leitura', 'trava-consultiva', 'linha-travada', 'vinculo', 'pendente', 'teto', 'cancelar', 'criar', 'auditoria']);
  });

  test('o token novo é forte, só o hash dele é gravado e a resposta traz o token em claro uma única vez', async (t) => {
    const m = mundo(t);
    const r = await reenviar(clienteFalso(m.ordem));
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    const { tokenHash } = m.criar.mock.calls[0].arguments[1];
    assert.equal(tokenHash, crypto.createHash('sha256').update(r.token, 'utf8').digest('hex'));
    assert.equal(JSON.stringify(m.criar.mock.calls[0].arguments).includes(r.token), false, 'o token em claro nunca vai ao repositório');
    assert.equal(Object.keys(r).sort().join(), 'convite,conviteAnteriorId,token');
  });

  test('cada reenvio gera um token diferente', async (t) => {
    const m = mundo(t);
    const a = await reenviar(clienteFalso(m.ordem));
    const b = await reenviar(clienteFalso(m.ordem));
    assert.notEqual(a.token, b.token);
  });

  test('convite expirado também pode ser reenviado: o anterior é cancelado e o novo nasce', async (t) => {
    const m = mundo(t, { lido: convite({ situacao: 'EXPIRADO' }), pendente: null });
    const r = await reenviar(clienteFalso(m.ordem));
    assert.equal(m.cancelar.mock.calls.length, 1);
    assert.equal(r.convite.id, '41');
  });

  test('a resposta apresenta o convite sem hash, identidade ou vínculo', async (t) => {
    const m = mundo(t);
    const r = await reenviar(clienteFalso(m.ordem));
    assert.deepEqual(Object.keys(r.convite).sort(), ['canceladoEm', 'criadoEm', 'emailConvite', 'expiraEm', 'id', 'nome', 'perfil', 'situacao']);
  });

  test('o teto é consultado para o par (empresa, e-mail) com a janela de 24 horas', async (t) => {
    const m = mundo(t);
    await reenviar(clienteFalso(m.ordem));
    assert.deepEqual(m.resumo.mock.calls[0].arguments.slice(1), [EMPRESA_ID, EMAIL, 24]);
  });
});

describe('reenviar — auditoria', () => {
  test('aponta para o convite novo e para o anterior, sem e-mail, nome, perfil, expiração, token ou hash', async (t) => {
    const m = mundo(t);
    const r = await reenviar(clienteFalso(m.ordem));
    assert.equal(m.audit.mock.calls.length, 1);
    const registro = m.audit.mock.calls[0].arguments[1];
    assert.equal(registro.acao, 'USUARIO_CONVITE_REENVIADO');
    assert.equal(registro.empresaId, EMPRESA_ID);
    assert.equal(registro.usuarioId, MASTER.id);
    assert.equal(registro.referencia, '41');
    assert.deepEqual(registro.dadosNovos, { conviteId: '41', conviteAnteriorId: '40' });
    assert.deepEqual(registro.contexto, { origem: 'administracao_usuarios' });
    assert.equal(registro.ip, '10.0.0.1');

    const tokenHash = m.criar.mock.calls[0].arguments[1].tokenHash;
    const texto = JSON.stringify(registro);
    for (const dado of [EMAIL, 'pessoa.convidada', NOME, 'SUPERVISOR', r.token, tokenHash]) {
      assert.equal(texto.includes(dado), false, dado);
    }
  });

  test('a ação existe no catálogo exportado', () => {
    assert.equal(servico.ACAO.REENVIADO, 'USUARIO_CONVITE_REENVIADO');
  });
});

describe('reenviar — recusas não alteram nada', () => {
  async function recusado(t, configuracao, esperado, cliente) {
    const m = mundo(t, configuracao);
    const c = cliente ?? clienteFalso(m.ordem);
    await assert.rejects(() => reenviar(c), esperado);
    assert.equal(m.cancelar.mock.calls.length, 0, 'não cancela');
    assert.equal(m.criar.mock.calls.length, 0, 'não cria');
    assert.equal(m.audit.mock.calls.length, 0, 'não audita');
    assert.equal(c.chamadas.includes('COMMIT'), false);
    assert.equal(c.chamadas.includes('ROLLBACK'), true);
    return m;
  }

  test('convite inexistente na empresa: 404, sem tomar a trava consultiva', async (t) => {
    const m = await recusado(t, { lido: null }, (e) => e.status === 404 && e.codigo === 'CONVITE_NAO_ENCONTRADO');
    assert.equal(m.ordem.includes('trava-consultiva'), false);
  });

  test('convite que sumiu entre a leitura e a trava da linha: 404', async (t) => {
    await recusado(t, { travado: null }, (e) => e.status === 404 && e.codigo === 'CONVITE_NAO_ENCONTRADO');
  });

  test('convite já aceito: 409 CONVITE_NAO_REENVIAVEL', async (t) => {
    await recusado(t, { travado: convite({ situacao: 'ACEITO' }) }, (e) => e.status === 409 && e.codigo === 'CONVITE_NAO_REENVIAVEL');
  });

  test('convite já cancelado: 409 CONVITE_NAO_REENVIAVEL', async (t) => {
    await recusado(t, { travado: convite({ situacao: 'CANCELADO' }) }, (e) => e.status === 409 && e.codigo === 'CONVITE_NAO_REENVIAVEL');
  });

  test('a situação decisiva é a da linha travada, não a da leitura anterior', async (t) => {
    await recusado(t, { lido: convite({ situacao: 'PENDENTE' }), travado: convite({ situacao: 'ACEITO' }) }, (e) => e.codigo === 'CONVITE_NAO_REENVIAVEL');
  });

  test('ADMINISTRADOR não reenvia convite de MASTER nem de ADMINISTRADOR: 403, como na criação e no cancelamento', async (t) => {
    for (const perfil of ['MASTER', 'ADMINISTRADOR']) {
      await recusado(t, { ator: ADMINISTRADOR, lido: convite({ perfil }), travado: convite({ perfil }) }, (e) => e.status === 403 && e.codigo === 'USUARIO_PERFIL_NAO_PERMITIDO');
      t.mock.reset();
    }
  });

  test('ADMINISTRADOR reenvia convite de SUPERVISOR e de USUARIO', async (t) => {
    for (const perfil of ['SUPERVISOR', 'USUARIO']) {
      const m = mundo(t, { ator: ADMINISTRADOR, lido: convite({ perfil }), travado: convite({ perfil }), pendente: null });
      await reenviar(clienteFalso(m.ordem), { atorId: ADMINISTRADOR.id });
      assert.equal(m.criar.mock.calls.length, 1, perfil);
      t.mock.reset();
    }
  });

  test('e-mail que já virou usuário nesta empresa: 409 USUARIO_VINCULO_EXISTENTE', async (t) => {
    await recusado(t, { vinculo: { id: 9 } }, (e) => e.status === 409 && e.codigo === 'USUARIO_VINCULO_EXISTENTE');
  });

  test('há outro convite pendente para o mesmo e-mail (o reenviado já expirou): 409 CONVITE_JA_PENDENTE, sem criar um segundo em aberto', async (t) => {
    await recusado(
      t,
      { lido: convite({ situacao: 'EXPIRADO' }), travado: convite({ situacao: 'EXPIRADO' }), pendente: convite({ id: '45', situacao: 'PENDENTE' }) },
      (e) => e.status === 409 && e.codigo === 'CONVITE_JA_PENDENTE',
    );
  });

  test('teto de envios atingido: 429 com Retry-After, sem cancelar o convite que ainda vale', async (t) => {
    const resumo = {
      total: 5, primeiroEm: new Date('2026-10-01T13:00:00Z'), ultimoEm: new Date('2026-10-02T11:00:00Z'), agora,
    };
    const m = await recusado(t, { resumo }, (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_LIMITE_DIARIO' && e.headers['Retry-After'] === '3600');
    assert.equal(m.ordem.includes('teto'), true);
  });

  test('menos de 60 segundos do último envio: 429 CONVITE_ENVIO_MUITO_RECENTE', async (t) => {
    const resumo = {
      total: 1, primeiroEm: new Date(agora.getTime() - 20_000), ultimoEm: new Date(agora.getTime() - 20_000), agora,
    };
    await recusado(t, { resumo }, (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_MUITO_RECENTE' && e.headers['Retry-After'] === '40');
  });

  test('quem não tem autoridade administrativa é recusado antes de qualquer leitura de convite', async (t) => {
    const m = mundo(t);
    t.mock.method(autoridade, 'exigirAutoridadeAdministrativa', async () => { throw HttpError.forbidden('USUARIO_ADMINISTRACAO_NAO_AUTORIZADA', 'Sem autoridade'); });
    const cliente = clienteFalso(m.ordem);
    await assert.rejects(() => reenviar(cliente), (e) => e.status === 403);
    assert.equal(m.lido.mock.calls.length, 0);
    assert.equal(m.cancelar.mock.calls.length, 0);
    assert.equal(m.criar.mock.calls.length, 0);
  });
});

describe('reenviar — atomicidade e escopo', () => {
  test('se a criação do novo convite falhar, a transação é desfeita (o cancelamento do anterior não fica)', async (t) => {
    const m = mundo(t);
    t.mock.method(conviteRepo, 'criar', async () => { throw new Error('falha de banco simulada'); });
    const cliente = clienteFalso(m.ordem);
    await assert.rejects(() => reenviar(cliente), /falha de banco simulada/);
    assert.equal(m.cancelar.mock.calls.length, 1);
    assert.equal(cliente.chamadas.includes('ROLLBACK'), true);
    assert.equal(cliente.chamadas.includes('COMMIT'), false);
    assert.equal(m.audit.mock.calls.length, 0);
    assert.equal(cliente.chamadas.at(-1), 'RELEASE');
  });

  test('a empresa usada em todas as leituras e escritas é a da sessão', async (t) => {
    const m = mundo(t);
    await reenviar(clienteFalso(m.ordem), { empresaId: 8 });
    assert.equal(m.lido.mock.calls[0].arguments[1], 8);
    assert.equal(m.travado.mock.calls[0].arguments[1], 8);
    assert.equal(m.cancelar.mock.calls[0].arguments[1], 8);
    assert.equal(m.criar.mock.calls[0].arguments[1].empresaId, 8);
    assert.equal(m.audit.mock.calls[0].arguments[1].empresaId, 8);
  });

  test('em production sem provedor de e-mail real, recusa com 503 antes de conectar ao banco', async (t) => {
    const m = mundo(t);
    t.mock.method(entrega, 'exigirDisponivel', () => { throw new HttpError(503, 'CONVITE_ENTREGA_INDISPONIVEL', 'indisponível'); });
    let conexoes = 0;
    const pool = { connect: async () => { conexoes += 1; return clienteFalso(m.ordem); } };
    await assert.rejects(() => servico.reenviar(pool, { empresaId: EMPRESA_ID, atorId: MASTER.id, conviteId: '40' }), (e) => e.status === 503);
    assert.equal(conexoes, 0);
  });

  test('identificadores de empresa e de ator inválidos são erro de programação', async () => {
    const pool = { connect: async () => assert.fail('não deve conectar') };
    await assert.rejects(() => servico.reenviar(pool, { empresaId: 0, atorId: 1, conviteId: '40' }), TypeError);
    await assert.rejects(() => servico.reenviar(pool, { empresaId: 1, atorId: '1', conviteId: '40' }), TypeError);
  });
});

describe('criar — teto de envios', () => {
  function mundoDaCriacao(t, resumo) {
    t.mock.method(autoridade, 'exigirAutoridadeAdministrativa', async () => MASTER);
    t.mock.method(usuarioAdministracaoRepo, 'buscarVinculoPorEmail', async () => null);
    t.mock.method(conviteRepo, 'buscarPendentePorEmailParaAtualizacao', async () => null);
    const resumirEnvios = t.mock.method(conviteRepo, 'resumirEnvios', async () => resumo);
    const criar = t.mock.method(conviteRepo, 'criar', async (_, d) => ({
      id: '41', empresaId: d.empresaId, emailConvite: d.emailConvite, nome: d.nome, perfil: d.perfil, situacao: 'PENDENTE', criadoEm: agora, expiraEm: d.expiraEm, canceladoEm: null,
    }));
    const audit = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1' }));
    return { resumirEnvios, criar, audit };
  }
  const criarConvite = () => servico.criar(poolFalso(clienteFalso([])), {
    empresaId: EMPRESA_ID, atorId: MASTER.id, email: EMAIL, nome: NOME, perfil: 'SUPERVISOR',
  });

  test('cancelar e convidar de novo não contorna o teto: a criação também consulta o par (empresa, e-mail) e é recusada com 429', async (t) => {
    const resumo = {
      total: 1, primeiroEm: new Date(agora.getTime() - 10_000), ultimoEm: new Date(agora.getTime() - 10_000), agora,
    };
    const m = mundoDaCriacao(t, resumo);
    await assert.rejects(criarConvite, (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_MUITO_RECENTE');
    assert.deepEqual(m.resumirEnvios.mock.calls[0].arguments.slice(1), [EMPRESA_ID, EMAIL, 24]);
    assert.equal(m.criar.mock.calls.length, 0);
    assert.equal(m.audit.mock.calls.length, 0);
  });

  test('sem envio anterior, a criação segue normalmente', async (t) => {
    const m = mundoDaCriacao(t, SEM_ENVIOS);
    const r = await criarConvite();
    assert.equal(r.convite.id, '41');
    assert.equal(m.criar.mock.calls.length, 1);
  });

  test('o teto vale também depois do quinto envio no dia', async (t) => {
    const m = mundoDaCriacao(t, {
      total: 5, primeiroEm: new Date(agora.getTime() - 3600_000), ultimoEm: new Date(agora.getTime() - 600_000), agora,
    });
    await assert.rejects(criarConvite, (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_LIMITE_DIARIO');
    assert.equal(m.criar.mock.calls.length, 0);
  });
});
