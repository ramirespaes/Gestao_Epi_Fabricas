'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const servico = require('../../src/services/convite-master.service');
const entregaConvite = require('../../src/services/entrega-convite.service');
const empresaRepo = require('../../src/repositories/empresa.repository');
const conviteRepo = require('../../src/repositories/convite-master.repository');
const auditoriaPlataformaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Reenvio do convite do primeiro MASTER e teto de envios (Bloco 11H), sem
 * PostgreSQL. O reenvio é ato do administrador da plataforma e vai para a
 * trilha da PLATAFORMA; o anterior é cancelado e nasce outro convite, com
 * token e validade novos, na mesma transação. O comportamento no banco está
 * em convite-reenvio.integration.js.
 */

const ADMIN_ID = 1;
const EMPRESA_ID = 3;
const EMAIL = 'pessoa.master@exemplo-cliente.com.br';
const agora = new Date('2026-10-02T12:00:00.000Z');
const empresa = Object.freeze({ id: EMPRESA_ID, razaoSocial: 'Empresa Convidante Ltda', ativo: true });
const SEM_ENVIOS = Object.freeze({
  total: 0, primeiroEm: null, ultimoEm: null, agora,
});

const convite = (extra = {}) => ({
  id: '40', empresaId: EMPRESA_ID, emailConvite: EMAIL, criadoPor: ADMIN_ID, situacao: 'PENDENTE', criadoEm: new Date('2026-10-02T10:00:00Z'), expiraEm: new Date('2026-10-02T14:00:00Z'), canceladoEm: null, ...extra,
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

function mundo(t, {
  empresaLida = empresa, lido = convite(), travado = lido, pendente = lido, resumo = SEM_ENVIOS,
} = {}) {
  const ordem = [];
  const marca = (nome, valor) => async (...args) => { ordem.push(nome); return typeof valor === 'function' ? valor(...args) : valor; };
  return {
    ordem,
    empresa: t.mock.method(empresaRepo, 'buscarDetalhesPorId', marca('empresa', empresaLida)),
    lido: t.mock.method(conviteRepo, 'buscarPorId', marca('leitura', lido)),
    travado: t.mock.method(conviteRepo, 'buscarPorIdParaAtualizacao', marca('linha-travada', travado)),
    pendente: t.mock.method(conviteRepo, 'buscarPendentePorEmailParaAtualizacao', marca('pendente', pendente)),
    resumo: t.mock.method(conviteRepo, 'resumirEnvios', marca('teto', resumo)),
    cancelar: t.mock.method(conviteRepo, 'cancelar', marca('cancelar', () => ({ ...convite(), situacao: 'CANCELADO', canceladoEm: agora }))),
    criar: t.mock.method(conviteRepo, 'criar', marca('criar', (_, d) => ({
      id: '41', empresaId: d.empresaId, emailConvite: d.emailConvite, criadoPor: d.criadoPor, situacao: 'PENDENTE', criadoEm: agora, expiraEm: d.expiraEm, canceladoEm: null,
    }))),
    audit: t.mock.method(auditoriaPlataformaRepo, 'registrar', marca('auditoria', { id: '1' })),
  };
}

const reenviar = (cliente, extra = {}) => servico.reenviar(poolFalso(cliente), {
  administradorId: ADMIN_ID, empresaId: EMPRESA_ID, conviteId: '40', ip: '10.0.0.1', dispositivo: 'Navegador', ...extra,
});

describe('reenviar — caminho de sucesso', () => {
  test('cancela o convite anterior e cria um novo para o mesmo e-mail, numa única transação', async (t) => {
    const m = mundo(t);
    const cliente = clienteFalso(m.ordem);
    const r = await reenviar(cliente);

    assert.deepEqual(m.cancelar.mock.calls[0].arguments.slice(1), [EMPRESA_ID, '40']);
    const gravado = m.criar.mock.calls[0].arguments[1];
    assert.equal(gravado.empresaId, EMPRESA_ID);
    assert.equal(gravado.emailConvite, EMAIL);
    assert.equal(gravado.criadoPor, ADMIN_ID);
    assert.ok(gravado.expiraEm > agora);
    assert.equal(cliente.chamadas.filter((c) => c === 'BEGIN').length, 1);
    assert.equal(cliente.chamadas.filter((c) => c === 'COMMIT').length, 1);
    assert.equal(cliente.chamadas.includes('ROLLBACK'), false);
    assert.equal(r.conviteAnteriorId, '40');
    assert.equal(r.convite.id, '41');
    assert.deepEqual(r.empresa, { id: EMPRESA_ID, razaoSocial: 'Empresa Convidante Ltda' });
  });

  test('a ordem é: empresa, leitura, trava consultiva do par, linha travada, pendente, teto, cancelar, criar, auditoria', async (t) => {
    const m = mundo(t);
    await reenviar(clienteFalso(m.ordem));
    assert.deepEqual(m.ordem, ['empresa', 'leitura', 'trava-consultiva', 'linha-travada', 'pendente', 'teto', 'cancelar', 'criar', 'auditoria']);
  });

  test('o token novo é forte, só o hash dele é gravado e o token em claro volta uma única vez, na resposta', async (t) => {
    const m = mundo(t);
    const r = await reenviar(clienteFalso(m.ordem));
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(m.criar.mock.calls[0].arguments[1].tokenHash, crypto.createHash('sha256').update(r.token, 'utf8').digest('hex'));
    assert.equal(JSON.stringify(m.criar.mock.calls[0].arguments).includes(r.token), false);
    assert.equal(Object.keys(r).sort().join(), 'convite,conviteAnteriorId,empresa,token');
    const outro = await reenviar(clienteFalso(m.ordem));
    assert.notEqual(outro.token, r.token);
  });

  test('convite expirado também pode ser reenviado', async (t) => {
    const m = mundo(t, { lido: convite({ situacao: 'EXPIRADO' }), pendente: null });
    const r = await reenviar(clienteFalso(m.ordem));
    assert.equal(m.cancelar.mock.calls.length, 1);
    assert.equal(r.convite.id, '41');
  });

  test('o teto é consultado para o par (empresa, e-mail) com a janela de 24 horas', async (t) => {
    const m = mundo(t);
    await reenviar(clienteFalso(m.ordem));
    assert.deepEqual(m.resumo.mock.calls[0].arguments.slice(1), [EMPRESA_ID, EMAIL, 24]);
  });
});

describe('reenviar — auditoria da plataforma', () => {
  test('atribuída ao administrador da plataforma, aponta para o convite novo e o anterior, sem e-mail, token ou hash', async (t) => {
    const m = mundo(t);
    const r = await reenviar(clienteFalso(m.ordem));
    assert.equal(m.audit.mock.calls.length, 1);
    const registro = m.audit.mock.calls[0].arguments[1];
    assert.equal(registro.acao, 'CONVITE_MASTER_REENVIADO');
    assert.equal(registro.administradorId, ADMIN_ID);
    assert.equal(registro.empresaAfetadaId, EMPRESA_ID);
    assert.equal(registro.referencia, '41');
    assert.deepEqual(registro.dadosNovos, { conviteId: '41', conviteAnteriorId: '40' });
    assert.deepEqual(registro.contexto, { origem: 'painel_privado' });

    const texto = JSON.stringify(registro);
    for (const dado of [EMAIL, 'pessoa.master', r.token, m.criar.mock.calls[0].arguments[1].tokenHash]) {
      assert.equal(texto.includes(dado), false, dado);
    }
  });

  test('a ação existe no catálogo exportado', () => {
    assert.equal(servico.ACAO.REENVIADO, 'CONVITE_MASTER_REENVIADO');
  });
});

describe('reenviar — recusas não alteram nada', () => {
  async function recusado(t, configuracao, esperado) {
    const m = mundo(t, configuracao);
    const cliente = clienteFalso(m.ordem);
    await assert.rejects(() => reenviar(cliente), esperado);
    assert.equal(m.cancelar.mock.calls.length, 0, 'não cancela');
    assert.equal(m.criar.mock.calls.length, 0, 'não cria');
    assert.equal(m.audit.mock.calls.length, 0, 'não audita');
    assert.equal(cliente.chamadas.includes('COMMIT'), false);
    assert.equal(cliente.chamadas.includes('ROLLBACK'), true);
    return m;
  }

  test('empresa inexistente: 404; empresa inativa: 409', async (t) => {
    await recusado(t, { empresaLida: null }, (e) => e.status === 404 && e.codigo === 'EMPRESA_NAO_ENCONTRADA');
    t.mock.reset();
    await recusado(t, { empresaLida: { ...empresa, ativo: false } }, (e) => e.status === 409 && e.codigo === 'EMPRESA_INATIVA');
  });

  test('convite inexistente na empresa: 404, sem tomar a trava consultiva', async (t) => {
    const m = await recusado(t, { lido: null }, (e) => e.status === 404 && e.codigo === 'CONVITE_NAO_ENCONTRADO');
    assert.equal(m.ordem.includes('trava-consultiva'), false);
  });

  test('convite que sumiu entre a leitura e a trava da linha: 404', async (t) => {
    await recusado(t, { travado: null }, (e) => e.status === 404 && e.codigo === 'CONVITE_NAO_ENCONTRADO');
  });

  test('convite já aceito ou já cancelado: 409 CONVITE_NAO_REENVIAVEL, decidido pela linha travada', async (t) => {
    for (const situacao of ['ACEITO', 'CANCELADO']) {
      await recusado(t, { lido: convite(), travado: convite({ situacao }) }, (e) => e.status === 409 && e.codigo === 'CONVITE_NAO_REENVIAVEL');
      t.mock.reset();
    }
  });

  test('há outro convite pendente para o mesmo e-mail (o reenviado já expirou): 409 CONVITE_JA_PENDENTE', async (t) => {
    await recusado(
      t,
      { lido: convite({ situacao: 'EXPIRADO' }), travado: convite({ situacao: 'EXPIRADO' }), pendente: convite({ id: '45' }) },
      (e) => e.status === 409 && e.codigo === 'CONVITE_JA_PENDENTE',
    );
  });

  test('teto de envios atingido: 429 com Retry-After, sem cancelar o convite que ainda vale', async (t) => {
    const resumo = {
      total: 5, primeiroEm: new Date('2026-10-01T13:00:00Z'), ultimoEm: new Date('2026-10-02T11:00:00Z'), agora,
    };
    await recusado(t, { resumo }, (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_LIMITE_DIARIO' && e.headers['Retry-After'] === '3600');
    t.mock.reset();
    const recente = {
      total: 1, primeiroEm: new Date(agora.getTime() - 20_000), ultimoEm: new Date(agora.getTime() - 20_000), agora,
    };
    await recusado(t, { resumo: recente }, (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_MUITO_RECENTE' && e.headers['Retry-After'] === '40');
  });
});

describe('reenviar — atomicidade e escopo', () => {
  test('se a criação do novo convite falhar, a transação é desfeita', async (t) => {
    const m = mundo(t);
    t.mock.method(conviteRepo, 'criar', async () => { throw new Error('falha de banco simulada'); });
    const cliente = clienteFalso(m.ordem);
    await assert.rejects(() => reenviar(cliente), /falha de banco simulada/);
    assert.equal(cliente.chamadas.includes('ROLLBACK'), true);
    assert.equal(cliente.chamadas.includes('COMMIT'), false);
    assert.equal(m.audit.mock.calls.length, 0);
    assert.equal(cliente.chamadas.at(-1), 'RELEASE');
  });

  test('o convite é procurado SEMPRE na empresa da rota: id de convite de outra empresa não é encontrado', async (t) => {
    const m = mundo(t, { lido: null });
    await assert.rejects(() => reenviar(clienteFalso(m.ordem), { empresaId: 9 }), (e) => e.status === 404);
    assert.equal(m.lido.mock.calls[0].arguments[1], 9);
  });

  test('em production sem provedor de e-mail real, recusa com 503 antes de conectar ao banco', async (t) => {
    const m = mundo(t);
    t.mock.method(entregaConvite, 'exigirDisponivel', () => { throw new HttpError(503, 'CONVITE_ENTREGA_INDISPONIVEL', 'indisponível'); });
    let conexoes = 0;
    const pool = { connect: async () => { conexoes += 1; return clienteFalso(m.ordem); } };
    await assert.rejects(() => servico.reenviar(pool, { administradorId: ADMIN_ID, empresaId: EMPRESA_ID, conviteId: '40' }), (e) => e.status === 503);
    assert.equal(conexoes, 0);
  });

  test('identificadores inválidos são erro de programação', async () => {
    const pool = { connect: async () => assert.fail('não deve conectar') };
    await assert.rejects(() => servico.reenviar(pool, { administradorId: 0, empresaId: 1, conviteId: '40' }), TypeError);
    await assert.rejects(() => servico.reenviar(pool, { administradorId: 1, empresaId: '1', conviteId: '40' }), TypeError);
  });
});

describe('criar — teto de envios', () => {
  function mundoDaCriacao(t, resumo) {
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => empresa);
    t.mock.method(conviteRepo, 'buscarPendentePorEmailParaAtualizacao', async () => null);
    const resumirEnvios = t.mock.method(conviteRepo, 'resumirEnvios', async () => resumo);
    const criar = t.mock.method(conviteRepo, 'criar', async (_, d) => ({
      id: '41', empresaId: d.empresaId, emailConvite: d.emailConvite, criadoPor: d.criadoPor, situacao: 'PENDENTE', criadoEm: agora, expiraEm: d.expiraEm, canceladoEm: null,
    }));
    const audit = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '1' }));
    return { resumirEnvios, criar, audit };
  }
  const criarConvite = () => servico.criar(poolFalso(clienteFalso([])), { administradorId: ADMIN_ID, empresaId: EMPRESA_ID, email: EMAIL });

  test('cancelar e convidar de novo não contorna o teto: a criação também consulta o par e é recusada com 429', async (t) => {
    const m = mundoDaCriacao(t, {
      total: 1, primeiroEm: new Date(agora.getTime() - 10_000), ultimoEm: new Date(agora.getTime() - 10_000), agora,
    });
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

  test('depois do quinto envio no dia, a criação é recusada', async (t) => {
    const m = mundoDaCriacao(t, {
      total: 5, primeiroEm: new Date(agora.getTime() - 3600_000), ultimoEm: new Date(agora.getTime() - 600_000), agora,
    });
    await assert.rejects(criarConvite, (e) => e.status === 429 && e.codigo === 'CONVITE_ENVIO_LIMITE_DIARIO');
    assert.equal(m.criar.mock.calls.length, 0);
  });
});
