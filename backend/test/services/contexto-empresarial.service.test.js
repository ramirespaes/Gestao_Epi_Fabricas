'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/contexto-empresarial.service');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const sessaoRepo = require('../../src/repositories/sessao.repository');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { authConfig } = require('../../src/config/auth');

/**
 * Serviço de contexto empresarial (Pacote 4), sem PostgreSQL: prova a ORDEM
 * e as CONDIÇÕES da seleção de empresa — identidade ativa, vínculo ativo em
 * empresa ativa, revogação da sessão anterior na mesma transação, sessão
 * nova marcada como SESSAO_GLOBAL e ligada à sessão global — e que o
 * empresaId do cliente nunca é confiado sem essa revalidação. O fluxo
 * completo está em test/integracao/auth-global-routes.integration.js.
 */

const AGORA = new Date('2026-09-24T12:00:00.000Z');
const identidade = { id: 9, email: 'pessoa@exemplo-cliente.com.br', ativo: true };
const vinculoA = { usuarioId: 70, nome: 'Pessoa', perfil: 'MASTER', empresa: { id: 3, nome: 'Empresa A', cnpj: '11222333000181' } };
const vinculoB = { usuarioId: 71, nome: 'Pessoa', perfil: 'USUARIO', empresa: { id: 4, nome: 'Empresa B', cnpj: '22333444000100' } };

function clienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (t) => { chamadas.push(t); return /clock_timestamp/.test(t) ? { rows: [{ agora: AGORA }] } : { rows: [], rowCount: 0 }; },
    release: () => chamadas.push('RELEASE'),
  };
}
function poolFalso(cliente) {
  const chamadas = { connect: 0 };
  return { chamadas, connect: async () => { chamadas.connect += 1; return cliente; }, query: async () => ({ rows: [] }) };
}
const contar = (chamadas, re) => chamadas.filter((t) => typeof t === 'string' && re.test(t)).length;

describe('listarEmpresas', () => {
  test('devolve só o resumo público dos vínculos ativos, na ordem do repositório', async (t) => {
    const listar = t.mock.method(usuarioRepo, 'listarVinculosAtivosDaIdentidade', async () => [vinculoA, vinculoB]);
    const r = await servico.listarEmpresas({ query: async () => ({ rows: [] }) }, { identidadeId: 9 });
    assert.deepEqual(r, [
      { id: 3, nome: 'Empresa A', cnpj: '11222333000181', perfil: 'MASTER' },
      { id: 4, nome: 'Empresa B', cnpj: '22333444000100', perfil: 'USUARIO' },
    ]);
    assert.equal(listar.mock.calls[0].arguments[1], 9);
    assert.equal(JSON.stringify(r).includes('usuarioId'), false, 'o id do vínculo não sai ao cliente');
  });

  test('recusa identificador inválido antes de consultar', async (t) => {
    const listar = t.mock.method(usuarioRepo, 'listarVinculosAtivosDaIdentidade', async () => []);
    await assert.rejects(() => servico.listarEmpresas({}, { identidadeId: '9' }), TypeError);
    assert.equal(listar.mock.calls.length, 0);
  });
});

describe('selecionar', () => {
  test('caminho feliz: identidade ativa -> vínculo ativo -> sessão SESSAO_GLOBAL ligada à sessão global; COMMIT; token só em memória', async (t) => {
    t.mock.method(identidadeRepo, 'buscarPorId', async () => identidade);
    t.mock.method(sessaoGlobalRepo, 'bloquearValida', async () => true);
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobalComSituacao', async () => []);
    const vinculo = t.mock.method(usuarioRepo, 'buscarVinculoAtivoDaIdentidade', async () => vinculoA);
    const revogar = t.mock.method(sessaoRepo, 'revogar', async () => true);
    const criar = t.mock.method(sessaoRepo, 'criar', async () => '900');
    const auditar = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: AGORA }));
    const cliente = clienteFalso();

    const r = await servico.selecionar(poolFalso(cliente), { identidadeId: 9, sessaoGlobalId: '55', empresaId: 3, ip: '10.0.0.1', dispositivo: 'ua' });

    assert.deepEqual(vinculo.mock.calls[0].arguments.slice(1), [9, 3]);
    assert.equal(revogar.mock.calls.length, 0, 'sem sessão anterior, nada a revogar');
    const args = criar.mock.calls[0].arguments[1];
    assert.equal(args.empresaId, 3, 'empresa vem do VÍNCULO revalidado');
    assert.equal(args.usuarioId, 70);
    assert.equal(args.autenticadoVia, 'SESSAO_GLOBAL');
    assert.equal(args.sessaoGlobalId, '55');
    assert.deepEqual(args.expiraEm, new Date(AGORA.getTime() + authConfig.sessao.expiracaoMinutos * 60_000));
    assert.match(args.tokenHash, /^[0-9a-f]{64}$/);
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(r.usuario, { id: 70, nome: 'Pessoa', email: identidade.email, perfil: 'MASTER' });
    assert.deepEqual(r.empresa, { id: 3, nome: 'Empresa A', cnpj: '11222333000181' });
    assert.equal(r.sessao.id, '900');
    assert.deepEqual(auditar.mock.calls.map((c) => c.arguments[1]), [
      { empresaId: 3, usuarioId: 70, acao: 'EMPRESA_SELECIONADA', ip: '10.0.0.1', dispositivo: 'ua', contexto: { tipo: 'SELECAO_INICIAL' } },
    ]);
    assert.equal(contar(cliente.chamadas, /^BEGIN$/), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
    assert.equal(cliente.chamadas.at(-1), 'RELEASE');
  });

  test('troca de empresa: as empresariais nascidas desta global e a do cookie são revogadas (TROCA_EMPRESA) ANTES de criar a nova, na mesma transação', async (t) => {
    t.mock.method(identidadeRepo, 'buscarPorId', async () => identidade);
    t.mock.method(sessaoGlobalRepo, 'bloquearValida', async () => true);
    t.mock.method(usuarioRepo, 'buscarVinculoAtivoDaIdentidade', async () => vinculoB);
    const ordem = [];
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobalComSituacao', async (_c, id, motivo, inatividade) => {
      ordem.push(['cascata', id, motivo, inatividade]);
      return [{ sessaoId: '900', empresaId: 3, usuarioId: 70, valida: true }];
    });
    t.mock.method(sessaoRepo, 'revogar', async (_c, empresaId, sessaoId, motivo) => { ordem.push(['revogar', empresaId, sessaoId, motivo]); return false; });
    t.mock.method(sessaoRepo, 'criar', async () => { ordem.push(['criar']); return '901'; });
    t.mock.method(auditoriaRepo, 'registrar', async (_c, dados) => { ordem.push(['auditar', dados.empresaId, dados.acao]); return { id: '1', criadoEm: AGORA }; });

    await servico.selecionar(poolFalso(clienteFalso()), {
      identidadeId: 9, sessaoGlobalId: '55', empresaId: 4, sessaoEmpresarialAnterior: { empresaId: 3, sessaoId: '900', usuarioId: 70, identidadeId: 9 },
    });

    assert.deepEqual(ordem, [
      ['cascata', '55', 'TROCA_EMPRESA', authConfig.sessao.inatividadeMinutos], ['revogar', 3, '900', 'TROCA_EMPRESA'], ['criar'],
      ['auditar', 3, 'EMPRESA_CONTEXTO_ENCERRADO'], ['auditar', 4, 'EMPRESA_SELECIONADA'],
    ]);
  });

  test('empresa não autorizada (sem vínculo, vínculo inativo, empresa inativa ou inexistente — tudo null): 403 genérico, nada criado, nada revogado', async (t) => {
    t.mock.method(identidadeRepo, 'buscarPorId', async () => identidade);
    t.mock.method(sessaoGlobalRepo, 'bloquearValida', async () => true);
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobalComSituacao', async () => []);
    t.mock.method(usuarioRepo, 'buscarVinculoAtivoDaIdentidade', async () => null);
    const revogar = t.mock.method(sessaoRepo, 'revogar', async () => true);
    const criar = t.mock.method(sessaoRepo, 'criar', async () => '902');
    const auditar = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: AGORA }));
    const cliente = clienteFalso();

    await assert.rejects(
      () => servico.selecionar(poolFalso(cliente), { identidadeId: 9, sessaoGlobalId: '55', empresaId: 999, sessaoEmpresarialAnterior: { empresaId: 3, sessaoId: '900' } }),
      (e) => e.status === 403 && e.codigo === 'EMPRESA_NAO_AUTORIZADA',
    );
    assert.equal(criar.mock.calls.length, 0);
    assert.equal(revogar.mock.calls.length, 0, 'a sessão anterior sobrevive a uma seleção recusada');
    assert.equal(sessaoRepo.revogarDaSessaoGlobalComSituacao.mock.calls.length, 0, 'nem em cascata');
    assert.equal(auditar.mock.calls.length, 0, 'recusa não gera evento');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });

  test('identidade inativa ou inexistente dentro da transação: 401 SESSAO_INVALIDA, vínculo nem consultado', async (t) => {
    t.mock.method(identidadeRepo, 'buscarPorId', async () => ({ ...identidade, ativo: false }));
    t.mock.method(sessaoGlobalRepo, 'bloquearValida', async () => true);
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobal', async () => 0);
    const vinculo = t.mock.method(usuarioRepo, 'buscarVinculoAtivoDaIdentidade', async () => vinculoA);
    await assert.rejects(() => servico.selecionar(poolFalso(clienteFalso()), { identidadeId: 9, sessaoGlobalId: '55', empresaId: 3 }), (e) => e.status === 401 && e.codigo === 'SESSAO_INVALIDA');
    assert.equal(vinculo.mock.calls.length, 0);
  });

  test('entradas inválidas são recusadas antes de conectar', async () => {
    const pool = poolFalso(clienteFalso());
    for (const dados of [
      { identidadeId: '9', sessaoGlobalId: '55', empresaId: 3 },
      { identidadeId: 9, sessaoGlobalId: 55, empresaId: 3 },
      { identidadeId: 9, sessaoGlobalId: '55', empresaId: '3' },
      { identidadeId: 9, sessaoGlobalId: '55', empresaId: 0 },
    ]) {
      await assert.rejects(() => servico.selecionar(pool, dados), TypeError);
    }
    assert.equal(pool.chamadas.connect, 0);
  });

  test('sessão global revogada//expirada entre o middleware e a transação: 401, vínculo nem consultado, nada criado', async (t) => {
    t.mock.method(identidadeRepo, 'buscarPorId', async () => identidade);
    t.mock.method(sessaoGlobalRepo, 'bloquearValida', async () => false);
    const vinculo = t.mock.method(usuarioRepo, 'buscarVinculoAtivoDaIdentidade', async () => vinculoA);
    const criar = t.mock.method(sessaoRepo, 'criar', async () => '904');
    await assert.rejects(() => servico.selecionar(poolFalso(clienteFalso()), { identidadeId: 9, sessaoGlobalId: '55', empresaId: 3 }), (e) => e.status === 401);
    assert.deepEqual([vinculo.mock.calls.length, criar.mock.calls.length], [0, 0]);
  });
});

describe('resolverAposLogin', () => {
  test('exatamente uma empresa: seleciona automaticamente; zero ou várias: contexto null, nada selecionado', async (t) => {
    t.mock.method(identidadeRepo, 'buscarPorId', async () => identidade);
    t.mock.method(sessaoGlobalRepo, 'bloquearValida', async () => true);
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobalComSituacao', async () => []);
    t.mock.method(usuarioRepo, 'buscarVinculoAtivoDaIdentidade', async () => vinculoA);
    const criar = t.mock.method(sessaoRepo, 'criar', async () => '903');
    const auditar = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: AGORA }));

    t.mock.method(usuarioRepo, 'listarVinculosAtivosDaIdentidade', async () => [vinculoA]);
    const uma = await servico.resolverAposLogin(poolFalso(clienteFalso()), { identidadeId: 9, sessaoGlobalId: '55' });
    assert.equal(uma.empresas.length, 1);
    assert.equal(uma.contexto.empresa.id, 3);
    assert.equal(criar.mock.calls.length, 1);
    assert.deepEqual(auditar.mock.calls.map((c) => [c.arguments[1].empresaId, c.arguments[1].acao, c.arguments[1].contexto]), [[3, 'EMPRESA_SELECIONADA', { tipo: 'SELECAO_INICIAL' }]]);

    t.mock.method(usuarioRepo, 'listarVinculosAtivosDaIdentidade', async () => [vinculoA, vinculoB]);
    const varias = await servico.resolverAposLogin(poolFalso(clienteFalso()), { identidadeId: 9, sessaoGlobalId: '55' });
    assert.deepEqual([varias.empresas.length, varias.contexto], [2, null]);

    t.mock.method(usuarioRepo, 'listarVinculosAtivosDaIdentidade', async () => []);
    const nenhuma = await servico.resolverAposLogin(poolFalso(clienteFalso()), { identidadeId: 9, sessaoGlobalId: '55' });
    assert.deepEqual([nenhuma.empresas, nenhuma.contexto], [[], null]);
    assert.equal(criar.mock.calls.length, 1, 'só o caso de uma empresa criou sessão');
  });
});

describe('encerrarTudo e encerrarAnteriores', () => {
  test('encerrarTudo: revoga as empresariais nascidas da global (LOGOUT_GLOBAL), a empresarial atual (LOGOUT) e a global (LOGOUT), numa transação', async (t) => {
    const ordem = [];
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobal', async (_c, id, motivo) => { ordem.push(['empresariais', id, motivo]); return 2; });
    t.mock.method(sessaoRepo, 'revogar', async (_c, e, s, motivo) => { ordem.push(['atual', e, s, motivo]); return true; });
    t.mock.method(sessaoGlobalRepo, 'revogar', async (_c, id, motivo) => { ordem.push(['global', id, motivo]); return true; });
    const cliente = clienteFalso();

    const r = await servico.encerrarTudo(poolFalso(cliente), { sessaoGlobalId: '55', sessaoEmpresarialAtual: { empresaId: 3, sessaoId: '900' } });

    assert.deepEqual(r, { global: true, empresariais: 2 });
    assert.deepEqual(ordem, [['empresariais', '55', 'LOGOUT_GLOBAL'], ['atual', 3, '900', 'LOGOUT'], ['global', '55', 'LOGOUT']]);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('encerrarAnteriores: sem nada anterior não conecta; com anteriores revoga com NOVO_LOGIN_GLOBAL', async (t) => {
    const pool = poolFalso(clienteFalso());
    await servico.encerrarAnteriores(pool, {});
    assert.equal(pool.chamadas.connect, 0);

    const motivos = [];
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobal', async (_c, _id, motivo) => { motivos.push(motivo); return 0; });
    t.mock.method(sessaoGlobalRepo, 'revogar', async (_c, _id, motivo) => { motivos.push(motivo); return true; });
    t.mock.method(sessaoRepo, 'revogar', async (_c, _e, _s, motivo) => { motivos.push(motivo); return true; });
    await servico.encerrarAnteriores(poolFalso(clienteFalso()), { sessaoGlobalAnterior: { sessaoId: '1' }, sessaoEmpresarialAnterior: { empresaId: 3, sessaoId: '2' } });
    assert.deepEqual(motivos, ['NOVO_LOGIN_GLOBAL', 'NOVO_LOGIN_GLOBAL', 'NOVO_LOGIN_GLOBAL']);
  });
});

describe('compensarLoginIncompleto (pós-auditoria do Pacote 4, item 2)', () => {
  test('revoga as empresariais nascidas da global e a própria global com LOGIN_INCOMPLETO, numa transação', async (t) => {
    const ordem = [];
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobal', async (_c, id, motivo) => { ordem.push(['empresariais', id, motivo]); return 1; });
    t.mock.method(sessaoGlobalRepo, 'revogar', async (_c, id, motivo) => { ordem.push(['global', id, motivo]); return true; });
    const cliente = clienteFalso();
    assert.equal(await servico.compensarLoginIncompleto(poolFalso(cliente), { sessaoGlobalId: '55' }), true);
    assert.deepEqual(ordem, [['empresariais', '55', 'LOGIN_INCOMPLETO'], ['global', '55', 'LOGIN_INCOMPLETO']]);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('se a própria compensação falhar: devolve false, registra só id e código (nunca token) e não lança — o erro original é o que segue', async (t) => {
    const logs = [];
    t.mock.method(console, 'error', (...a) => logs.push(a));
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobal', async () => { const e = new Error('x'); e.code = '57P01'; throw e; });
    const cliente = clienteFalso();
    assert.equal(await servico.compensarLoginIncompleto(poolFalso(cliente), { sessaoGlobalId: '55' }), false);
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
    assert.deepEqual(logs[0][1], { sessaoGlobalId: '55', codigo: '57P01' });
  });

  test('id inválido é erro de programação, antes de conectar', async () => {
    const pool = poolFalso(clienteFalso());
    await assert.rejects(() => servico.compensarLoginIncompleto(pool, { sessaoGlobalId: 55 }), TypeError);
    assert.equal(pool.chamadas.connect, 0);
  });
});

describe('selecionar: auditoria da ativação do contexto empresarial', () => {
  const eventos = (auditar) => auditar.mock.calls.map((c) => c.arguments[1]);
  function mundo(t, { encerradas = [], vinculo = vinculoB, revogarCookie = false } = {}) {
    t.mock.method(identidadeRepo, 'buscarPorId', async () => identidade);
    t.mock.method(sessaoGlobalRepo, 'bloquearValida', async () => true);
    t.mock.method(usuarioRepo, 'buscarVinculoAtivoDaIdentidade', async () => vinculo);
    t.mock.method(sessaoRepo, 'revogarDaSessaoGlobalComSituacao', async () => encerradas);
    const revogar = t.mock.method(sessaoRepo, 'revogar', async () => revogarCookie);
    t.mock.method(sessaoRepo, 'criar', async () => '950');
    const auditar = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1', criadoEm: AGORA }));
    return { auditar, revogar };
  }
  const selecionarB = (extra = {}) => servico.selecionar(poolFalso(clienteFalso()), { identidadeId: 9, sessaoGlobalId: '55', empresaId: 4, ip: '10.0.0.1', dispositivo: 'ua', ...extra });

  test('sessões atingidas que já não valiam (expiradas ou inativas) não contam: seleção inicial, sem encerramento', async (t) => {
    const { auditar } = mundo(t, { encerradas: [{ sessaoId: '1', empresaId: 3, usuarioId: 70, valida: false }, { sessaoId: '2', empresaId: 4, usuarioId: 71, valida: false }] });
    await selecionarB();
    assert.deepEqual(eventos(auditar), [{ empresaId: 4, usuarioId: 71, acao: 'EMPRESA_SELECIONADA', ip: '10.0.0.1', dispositivo: 'ua', contexto: { tipo: 'SELECAO_INICIAL' } }]);
  });

  test('troca A → B: encerramento em A com o usuário de A e ativação em B com o usuário de B; só tipo e motivo no contexto', async (t) => {
    const { auditar } = mundo(t, { encerradas: [{ sessaoId: '1', empresaId: 3, usuarioId: 70, valida: false }, { sessaoId: '2', empresaId: 3, usuarioId: 70, valida: true }] });
    await selecionarB();
    assert.deepEqual(eventos(auditar), [
      { empresaId: 3, usuarioId: 70, acao: 'EMPRESA_CONTEXTO_ENCERRADO', ip: '10.0.0.1', dispositivo: 'ua', contexto: { motivo: 'TROCA_EMPRESA' } },
      { empresaId: 4, usuarioId: 71, acao: 'EMPRESA_SELECIONADA', ip: '10.0.0.1', dispositivo: 'ua', contexto: { tipo: 'TROCA' } },
    ]);
  });

  test('mesma empresa: um único evento RESELECAO no destino, sem encerramento', async (t) => {
    const { auditar } = mundo(t, { encerradas: [{ sessaoId: '2', empresaId: 4, usuarioId: 71, valida: true }] });
    await selecionarB();
    assert.deepEqual(eventos(auditar).map((e) => [e.empresaId, e.acao, e.contexto]), [[4, 'EMPRESA_SELECIONADA', { tipo: 'RESELECAO' }]]);
  });

  test('sessão do cookie da mesma pessoa, fora deste login e ainda viva: conta como troca, com o encerramento na empresa dela', async (t) => {
    const { auditar } = mundo(t, { revogarCookie: true });
    await selecionarB({ sessaoEmpresarialAnterior: { empresaId: 3, sessaoId: '800', usuarioId: 70, identidadeId: 9 } });
    assert.deepEqual(eventos(auditar).map((e) => [e.empresaId, e.usuarioId, e.acao, e.contexto]), [
      [3, 70, 'EMPRESA_CONTEXTO_ENCERRADO', { motivo: 'TROCA_EMPRESA' }],
      [4, 71, 'EMPRESA_SELECIONADA', { tipo: 'TROCA' }],
    ]);
  });

  test('sessão do cookie de OUTRA pessoa: é encerrada como antes, mas não vira troca dela nem desta', async (t) => {
    const { auditar, revogar } = mundo(t, { revogarCookie: true });
    await selecionarB({ sessaoEmpresarialAnterior: { empresaId: 3, sessaoId: '800', usuarioId: 99, identidadeId: 77 } });
    assert.deepEqual(revogar.mock.calls[0].arguments.slice(1), [3, '800', 'TROCA_EMPRESA']);
    assert.deepEqual(eventos(auditar).map((e) => [e.empresaId, e.acao, e.contexto]), [[4, 'EMPRESA_SELECIONADA', { tipo: 'SELECAO_INICIAL' }]]);
  });

  test('cookie já encerrado pela cascata deste login: não gera um segundo encerramento', async (t) => {
    const { auditar } = mundo(t, { encerradas: [{ sessaoId: '800', empresaId: 3, usuarioId: 70, valida: true }], revogarCookie: false });
    await selecionarB({ sessaoEmpresarialAnterior: { empresaId: 3, sessaoId: '800', usuarioId: 70, identidadeId: 9 } });
    assert.equal(eventos(auditar).filter((e) => e.acao === 'EMPRESA_CONTEXTO_ENCERRADO').length, 1);
  });

  test('User-Agent e IP longos entram cortados como na sessão (150 e 45)', async (t) => {
    const { auditar } = mundo(t);
    await selecionarB({ ip: '1'.repeat(60), dispositivo: 'x'.repeat(400) });
    assert.deepEqual([eventos(auditar)[0].ip.length, eventos(auditar)[0].dispositivo.length], [45, 150]);
  });

  test('falha ao gravar a auditoria: ROLLBACK, nada confirmado, o erro sobe', async (t) => {
    mundo(t, { encerradas: [{ sessaoId: '2', empresaId: 3, usuarioId: 70, valida: true }] });
    auditoriaRepo.registrar.mock.mockImplementation(async () => { throw new Error('falha de auditoria'); });
    const cliente = clienteFalso();
    await assert.rejects(() => servico.selecionar(poolFalso(cliente), { identidadeId: 9, sessaoGlobalId: '55', empresaId: 4 }), /falha de auditoria/);
    assert.deepEqual([contar(cliente.chamadas, /^COMMIT$/), contar(cliente.chamadas, /^ROLLBACK$/)], [0, 1]);
  });
});
