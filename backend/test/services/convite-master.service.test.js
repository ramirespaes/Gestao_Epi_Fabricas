'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const servico = require('../../src/services/convite-master.service');
const empresaRepo = require('../../src/repositories/empresa.repository');
const conviteRepo = require('../../src/repositories/convite-master.repository');
const tentativaRepo = require('../../src/repositories/convite-master-tentativa.repository');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const usuarioRepo = require('../../src/repositories/usuario.repository');
const auditoriaPlataformaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const entregaConvite = require('../../src/services/entrega-convite.service');
const password = require('../../src/security/password');
const passwordPolicy = require('../../src/security/password-policy');
const { gerarTokenSessao } = require('../../src/security/token');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Testes unitários do convite do MASTER (Pacote 3), sem PostgreSQL. Foco
 * no que o fluxo real (integração) não isola: ordem das chamadas, a quem
 * cada auditoria é atribuída, o que NÃO é chamado em cada recusa, e que a
 * tentativa negada é COMMITADA. Repositórios mockados por namespace.
 */

const TOKEN = gerarTokenSessao();
const empresa = { id: 3, razaoSocial: 'Empresa', ativo: true };
const agora = new Date();
const convitePendente = { id: '7', empresaId: 3, emailConvite: 'p@x.com', criadoPor: 1, expiraEm: new Date(agora.getTime() + 3600e3), situacao: 'PENDENTE' };

function clienteFalso() {
  const chamadas = [];
  return {
    chamadas,
    query: async (t) => { chamadas.push(t); return /clock_timestamp/.test(t) ? { rows: [{ agora }] } : { rows: [], rowCount: 0 }; },
    release: () => chamadas.push('RELEASE'),
  };
}
function poolFalso(cliente) {
  const chamadas = { connect: 0 };
  return { chamadas, connect: async () => { chamadas.connect += 1; return cliente; } };
}
const contar = (chamadas, re) => chamadas.filter((t) => typeof t === 'string' && re.test(t)).length;

describe('criar (administrador)', () => {
  test('sucesso: token em claro devolvido UMA vez, hash gravado, expira_em pela configuração, auditoria da PLATAFORMA com quem convidou e sem token', async (t) => {
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => empresa);
    t.mock.method(conviteRepo, 'buscarPendentePorEmailParaAtualizacao', async () => null);
    const criar = t.mock.method(conviteRepo, 'criar', async (_, d) => ({ ...convitePendente, expiraEm: d.expiraEm }));
    const audit = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '1' }));

    const cliente = clienteFalso();
    const r = await servico.criar(poolFalso(cliente), { administradorId: 1, empresaId: 3, email: 'P@X.com' });
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    // Item 2: advisory lock por (empresa, e-mail) adquirido ANTES da busca por pendente.
    const posLock = cliente.chamadas.findIndex((c) => /pg_advisory_xact_lock/.test(c));
    assert.ok(posLock > cliente.chamadas.indexOf('BEGIN'), 'lock dentro da transação');
    const args = criar.mock.calls[0].arguments[1];
    assert.equal(args.emailConvite, 'p@x.com');
    assert.equal(args.criadoPor, 1);
    assert.match(args.tokenHash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(audit.mock.calls[0].arguments[1]).includes(r.token), false);
    assert.equal(audit.mock.calls[0].arguments[1].administradorId, 1);
  });

  test('recusas: e-mail inválido antes de conectar; empresa inexistente 404; inativa 409; pendente 409 (nada criado)', async (t) => {
    const pool = poolFalso(clienteFalso());
    await assert.rejects(() => servico.criar(pool, { administradorId: 1, empresaId: 3, email: 'x' }), (e) => e.codigo === 'CONVITE_EMAIL_INVALIDO');
    assert.equal(pool.chamadas.connect, 0);

    const criar = t.mock.method(conviteRepo, 'criar', async () => { throw new Error('não deveria'); });
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => null);
    await assert.rejects(() => servico.criar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 3, email: 'p@x.com' }), (e) => e.status === 404);
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => ({ ...empresa, ativo: false }));
    await assert.rejects(() => servico.criar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 3, email: 'p@x.com' }), (e) => e.codigo === 'EMPRESA_INATIVA');
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => empresa);
    t.mock.method(conviteRepo, 'buscarPendentePorEmailParaAtualizacao', async () => convitePendente);
    await assert.rejects(() => servico.criar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 3, email: 'p@x.com' }), (e) => e.codigo === 'CONVITE_JA_PENDENTE');
    assert.equal(criar.mock.calls.length, 0);
  });
});

describe('criar em production (item 3)', () => {
  test('recusa 503 CONVITE_ENTREGA_INDISPONIVEL antes de conectar: nenhum repositório, nenhuma auditoria', async (t) => {
    const original = entregaConvite.exigirDisponivel;
    t.mock.method(entregaConvite, 'exigirDisponivel', () => original('production'));
    const buscar = t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => empresa);
    const criar = t.mock.method(conviteRepo, 'criar', async () => convitePendente);
    const audit = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '1' }));
    const pool = poolFalso(clienteFalso());
    await assert.rejects(() => servico.criar(pool, { administradorId: 1, empresaId: 3, email: 'p@x.com' }), (e) => e.status === 503 && e.codigo === 'CONVITE_ENTREGA_INDISPONIVEL');
    assert.deepEqual([pool.chamadas.connect, buscar.mock.calls.length, criar.mock.calls.length, audit.mock.calls.length], [0, 0, 0, 0]);
  });
});

describe('cancelar (administrador)', () => {
  test('nada mudou: 404 se não existe, 409 se já resolvido; sucesso audita a PLATAFORMA', async (t) => {
    t.mock.method(conviteRepo, 'cancelar', async () => null);
    t.mock.method(conviteRepo, 'buscarPorId', async () => null);
    await assert.rejects(() => servico.cancelar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 3, conviteId: '7' }), (e) => e.status === 404);
    t.mock.method(conviteRepo, 'buscarPorId', async () => ({ ...convitePendente, situacao: 'ACEITO' }));
    await assert.rejects(() => servico.cancelar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 3, conviteId: '7' }), (e) => e.codigo === 'CONVITE_NAO_CANCELAVEL');

    t.mock.method(conviteRepo, 'cancelar', async () => ({ ...convitePendente, situacao: 'CANCELADO', canceladoEm: agora }));
    const audit = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '1' }));
    const r = await servico.cancelar(poolFalso(clienteFalso()), { administradorId: 1, empresaId: 3, conviteId: '7' });
    assert.equal(r.situacao, 'CANCELADO');
    assert.equal(audit.mock.calls[0].arguments[1].acao, 'CONVITE_MASTER_CANCELADO');
  });
});

describe('aceitar (pessoa convidada)', () => {
  const dados = { token: TOKEN, nome: 'Pessoa', senha: 'quasar-boreal-91-nebula' };

  test('token malformado ou nome/senha vazios: recusados antes de qualquer conexão', async () => {
    const pool = poolFalso(clienteFalso());
    await assert.rejects(() => servico.aceitar(pool, { ...dados, token: 'abc' }), (e) => e.codigo === 'CONVITE_INVALIDO');
    await assert.rejects(() => servico.aceitar(pool, { ...dados, nome: '  ' }), (e) => e.codigo === 'CONVITE_NOME_INVALIDO');
    await assert.rejects(() => servico.aceitar(pool, { ...dados, senha: '' }), (e) => e.codigo === 'CONVITE_SENHA_INVALIDA');
    assert.equal(pool.chamadas.connect, 0);
  });

  test('cooldown vigente: 429 com Retry-After; nem o convite é consultado; COMMIT', async (t) => {
    t.mock.method(tentativaRepo, 'buscarCooldownVigente', async () => ({ ativoAte: new Date(Date.now() + 60e3) }));
    const buscar = t.mock.method(conviteRepo, 'buscarPorHashParaAtualizacao', async () => convitePendente);
    const cliente = clienteFalso();
    await assert.rejects(() => servico.aceitar(poolFalso(cliente), dados), (e) => e.status === 429 && e.codigo === 'CONVITE_EM_COOLDOWN' && Number(e.headers['Retry-After']) > 0);
    assert.equal(buscar.mock.calls.length, 0);
    assert.equal(contar(cliente.chamadas, /pg_advisory_xact_lock/), 1);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('identidade NOVA: política -> hash -> identidade -> vínculo MASTER -> marcarAceito -> tentativa sucesso -> auditoria EMPRESARIAL ao novo usuário', async (t) => {
    t.mock.method(tentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(conviteRepo, 'buscarPorHashParaAtualizacao', async () => convitePendente);
    t.mock.method(identidadeRepo, 'buscarCredencialPorEmail', async () => null);
    t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: true, erros: [] }));
    t.mock.method(password, 'gerarHashSenha', async () => 'hash');
    const criarId = t.mock.method(identidadeRepo, 'criar', async () => ({ id: 20 }));
    const criarUsu = t.mock.method(usuarioRepo, 'criar', async () => ({ id: 30, nome: 'Pessoa', perfil: 'MASTER' }));
    const marcar = t.mock.method(conviteRepo, 'marcarAceito', async () => ({ ...convitePendente, situacao: 'ACEITO', aceitoEm: agora }));
    const tent = t.mock.method(tentativaRepo, 'registrarTentativa', async () => '1');
    const auditEmp = t.mock.method(auditoriaRepo, 'registrar', async () => ({ id: '1' }));
    const auditPlat = t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => ({ id: '1' }));
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => empresa);

    const r = await servico.aceitar(poolFalso(clienteFalso()), dados);
    assert.equal(r.identidadeCriada, true);
    assert.deepEqual(criarId.mock.calls[0].arguments[1], { email: 'p@x.com', senhaHash: 'hash' });
    assert.deepEqual(criarUsu.mock.calls[0].arguments[1], { empresaId: 3, nome: 'Pessoa', perfil: 'MASTER', identidadeId: 20 });
    assert.deepEqual(marcar.mock.calls[0].arguments.slice(1), ['7', { identidadeId: 20, usuarioId: 30 }]);
    assert.equal(tent.mock.calls[0].arguments[1].sucesso, true);
    const a = auditEmp.mock.calls[0].arguments[1];
    assert.deepEqual([a.empresaId, a.usuarioId, a.acao], [3, 30, 'CONVITE_MASTER_ACEITO']);
    assert.equal(auditPlat.mock.calls.length, 0, 'aceite nunca é atribuído ao administrador da plataforma');
    assert.equal(JSON.stringify(r).includes(TOKEN), false);
  });

  test('empresa INATIVA (item 4): 409 CONVITE_EMPRESA_INATIVA; nenhuma identidade, vínculo ou tentativa; COMMIT', async (t) => {
    t.mock.method(tentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(conviteRepo, 'buscarPorHashParaAtualizacao', async () => convitePendente);
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => ({ ...empresa, ativo: false }));
    const cred = t.mock.method(identidadeRepo, 'buscarCredencialPorEmail', async () => null);
    const criarId = t.mock.method(identidadeRepo, 'criar', async () => ({ id: 20 }));
    const criarUsu = t.mock.method(usuarioRepo, 'criar', async () => ({ id: 30 }));
    const tent = t.mock.method(tentativaRepo, 'registrarTentativa', async () => '1');
    const cliente = clienteFalso();
    await assert.rejects(() => servico.aceitar(poolFalso(cliente), dados), (e) => e.status === 409 && e.codigo === 'CONVITE_EMPRESA_INATIVA');
    assert.deepEqual([cred.mock.calls.length, criarId.mock.calls.length, criarUsu.mock.calls.length, tent.mock.calls.length], [0, 0, 0, 0]);
    assert.equal(contar(cliente.chamadas, /^COMMIT$/), 1);
  });

  test('identidade EXISTENTE com senha errada: tratarFalha registra SENHA_INVALIDA, nada é criado, tentativa COMMITADA, 401 genérico', async (t) => {
    t.mock.method(tentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => empresa);
    t.mock.method(conviteRepo, 'buscarPorHashParaAtualizacao', async () => convitePendente);
    t.mock.method(identidadeRepo, 'buscarCredencialPorEmail', async () => ({ id: 20, email: 'p@x.com', senhaHash: 'h', ativo: true }));
    t.mock.method(password, 'verificarSenha', async () => false);
    const criarUsu = t.mock.method(usuarioRepo, 'criar', async () => ({ id: 30 }));
    const tent = t.mock.method(tentativaRepo, 'registrarTentativa', async () => '1');
    t.mock.method(tentativaRepo, 'contarFalhasRecentes', async () => 0);
    const cliente = clienteFalso();
    await assert.rejects(() => servico.aceitar(poolFalso(cliente), dados), (e) => e.status === 401 && e.codigo === 'CREDENCIAIS_INVALIDAS');
    assert.equal(criarUsu.mock.calls.length, 0);
    assert.equal(tent.mock.calls[0].arguments[1].motivo, 'SENHA_INVALIDA');
    assert.deepEqual([contar(cliente.chamadas, /^COMMIT$/), contar(cliente.chamadas, /^ROLLBACK$/)], [1, 0]);
  });

  test('situações do convite geram códigos distintos e nada é criado; senha fora da política é 400 de validação em body.senha', async (t) => {
    t.mock.method(tentativaRepo, 'buscarCooldownVigente', async () => null);
    const criarId = t.mock.method(identidadeRepo, 'criar', async () => ({ id: 20 }));
    for (const [situacao, codigo] of [['ACEITO', 'CONVITE_JA_UTILIZADO'], ['CANCELADO', 'CONVITE_CANCELADO'], ['EXPIRADO', 'CONVITE_EXPIRADO']]) {
      t.mock.method(conviteRepo, 'buscarPorHashParaAtualizacao', async () => ({ ...convitePendente, situacao }));
      await assert.rejects(() => servico.aceitar(poolFalso(clienteFalso()), dados), (e) => e.status === 409 && e.codigo === codigo);
    }
    t.mock.method(conviteRepo, 'buscarPorHashParaAtualizacao', async () => convitePendente);
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => empresa);
    t.mock.method(identidadeRepo, 'buscarCredencialPorEmail', async () => null);
    t.mock.method(passwordPolicy, 'validarPoliticaSenha', () => ({ ok: false, erros: [{ codigo: 'SENHA_CURTA', mensagem: 'm' }] }));
    await assert.rejects(() => servico.aceitar(poolFalso(clienteFalso()), dados), (e) => HttpError.ehHttpError(e) && e.status === 400 && e.detalhes[0].campo === 'body.senha');
    assert.equal(criarId.mock.calls.length, 0);
  });

  test('vínculo já existente na empresa (23505 uq_usuarios_empresa_identidade) vira 409 com ROLLBACK', async (t) => {
    t.mock.method(tentativaRepo, 'buscarCooldownVigente', async () => null);
    t.mock.method(empresaRepo, 'buscarDetalhesPorId', async () => empresa);
    t.mock.method(conviteRepo, 'buscarPorHashParaAtualizacao', async () => convitePendente);
    t.mock.method(identidadeRepo, 'buscarCredencialPorEmail', async () => ({ id: 20, email: 'p@x.com', senhaHash: 'h', ativo: true }));
    t.mock.method(password, 'verificarSenha', async () => true);
    t.mock.method(usuarioRepo, 'criar', async () => { throw Object.assign(new Error('dup'), { code: '23505', constraint: 'uq_usuarios_empresa_identidade' }); });
    const cliente = clienteFalso();
    await assert.rejects(() => servico.aceitar(poolFalso(cliente), dados), (e) => e.codigo === 'CONVITE_VINCULO_EXISTENTE');
    assert.equal(contar(cliente.chamadas, /^ROLLBACK$/), 1);
  });
});
