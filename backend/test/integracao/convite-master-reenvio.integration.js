'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarConviteMasterController } = require('../../src/controllers/convite-master.controller');
const { criarConviteMasterRoutes } = require('../../src/routes/convite-master.routes');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const entregaConvite = require('../../src/services/entrega-convite.service');
const conviteRepo = require('../../src/repositories/convite-master.repository');
const auditoriaPlataformaRepo = require('../../src/repositories/auditoria-plataforma.repository');
const { criarServicoEmail } = require('../../src/email/servico-email');
const { criarSmtp } = require('../../src/email/transporte/smtp');
const { carregarConfigEmail } = require('../../src/config/email');

/**
 * Reenvio do convite do primeiro MASTER e teto de envios (Bloco 11H) contra
 * PostgreSQL real, schema temporário. O reenvio é ato do administrador da
 * plataforma e vai para a trilha da PLATAFORMA. O anterior é cancelado e
 * nasce outro, com token novo; o link antigo morre e o novo vale até o aceite.
 * O teto (60 segundos entre envios, 5 em 24 horas por empresa e e-mail) vale
 * para criar e reenviar, e as corridas nunca deixam dois convites em aberto.
 */

// 048: a auditoria da plataforma grava ator e alvo; 053: criarInicial emite a
// liberação do MFA; 049, 052, 054 e 055: a sessão administrativa só vale ligada
// a um desafio de MFA concluído.
const TODAS_AS_MIGRATIONS = [...Array.from({ length: 35 }, (_, i) => String(i).padStart(3, '0')), '048', '049', '052', '053', '054', '055', '072', '074', '075', '076', '077'];
const SENHA_ADMIN = 'planeta-nebulosa-ozonio-42';
const SENHA_MASTER = 'quasar-boreal-91-nebula';
const PLATAFORMA = '/api/plataforma';
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');
const tokenDoLink = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get('token');

function completarCnpj(base12) {
  const valor = (c) => c.charCodeAt(0) - 48;
  const dv = (texto, pesos) => {
    const soma = [...texto].reduce((acc, c, i) => acc + valor(c) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(`${base12}${d1}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base12}${d1}${d2}`;
}

describe('Bloco 11H — reenvio do convite do primeiro MASTER (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let app;
  let cookieAdmin;
  let administradorId;
  let sequencia = 0;

  const q = (sql, params) => pool.query(sql, params);
  const admin = (req) => req.set('Cookie', cookieAdmin);
  const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });

  function montarApp(entregar) {
    const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
    const controller = entregar ? criarConviteMasterController({ pool, entregar }) : criarConviteMasterController({ pool });
    return criarAppTeste((a) => {
      a.use(PLATAFORMA, criarConviteMasterRoutes({
        controller, exigirSessaoPlataforma, limitador: semLimite(), limitadorEnvio: semLimite(),
      }));
    });
  }

  async function novaEmpresa(nome = 'Empresa Reenvio') {
    sequencia += 1;
    const cnpj = completarCnpj(`77${String(sequencia).padStart(6, '0')}0001`);
    return (await q('INSERT INTO empresas (nome, cnpj) VALUES ($1, $2) RETURNING id', [`${nome} ${sequencia}`, cnpj])).rows[0].id;
  }
  const novoEmail = () => { sequencia += 1; return `master.reenvio.${sequencia}@exemplo-cliente.com.br`; };

  const criar = (empresaId, email, alvo = () => app) => admin(request(alvo()).post(`${PLATAFORMA}/empresas/${empresaId}/convites-master`)).send({ email });
  const reenviar = (empresaId, conviteId, alvo = () => app) => admin(request(alvo()).post(`${PLATAFORMA}/convites-master/${empresaId}/${conviteId}/reenviar`)).send({});
  const cancelar = (empresaId, conviteId) => admin(request(app).post(`${PLATAFORMA}/convites-master/${empresaId}/${conviteId}/cancelar`)).send({});
  const consultar = (token) => request(app).post(`${PLATAFORMA}/convite-master/consultar`).send({ token });
  const aceitar = (token) => request(app).post(`${PLATAFORMA}/convite-master/aceitar`).send({ token, nome: 'Pessoa Master', senha: SENHA_MASTER });

  async function convidar(empresaId = null) {
    const empresaDoConvite = empresaId ?? await novaEmpresa();
    const email = novoEmail();
    const r = await criar(empresaDoConvite, email);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return {
      empresaId: empresaDoConvite, email, id: r.body.convite.id, token: tokenDoLink(r.body.entrega.linkAceite),
    };
  }

  const linha = async (id) => (await q('SELECT * FROM convites_master WHERE id = $1', [id])).rows[0];
  const abertos = async (empresaId, email) => (await q(
    'SELECT id FROM convites_master WHERE empresa_id = $1 AND lower(email_convite) = $2 AND aceito_em IS NULL AND cancelado_em IS NULL AND expira_em > now()',
    [empresaId, email],
  )).rows;
  const envelhecer = (empresaId, email, intervalo = '3 minutes') => q(
    'UPDATE convites_master SET criado_em = criado_em - $3::interval, expira_em = expira_em - $3::interval WHERE empresa_id = $1 AND lower(email_convite) = $2',
    [empresaId, email, intervalo],
  );
  const expirar = (id) => q("UPDATE convites_master SET criado_em = now() - interval '10 days', expira_em = now() - interval '1 day' WHERE id = $1", [id]);
  const auditorias = async (acao) => (await q('SELECT administrador_id, empresa_afetada_id, referencia, contexto, dados_novos FROM logs_auditoria_plataforma WHERE acao = $1 ORDER BY id', [acao])).rows;

  before(async () => {
    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    pool = contexto.pool;
    const administrador = await criarInicial(pool, { email: 'admin.reenvio@safework.com.br', senha: SENHA_ADMIN });
    administradorId = administrador.id;
    ({ cookie: cookieAdmin } = await criarSessaoAdministrativa(pool, administradorId));
    app = montarApp();
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('o reenvio em si', () => {
    test('cancela o anterior e cria um novo para o mesmo e-mail; o link antigo morre, o novo vale e leva ao aceite; só o hash fica no banco', async (t) => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      const saidas = [];
      for (const metodo of ['log', 'info', 'warn', 'error']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });

      const r = await reenviar(antigo.empresaId, antigo.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.conviteAnteriorId, String(antigo.id));
      assert.notEqual(r.body.convite.id, antigo.id);
      assert.deepEqual([r.body.convite.emailConvite, r.body.convite.situacao, r.body.empresa.id], [antigo.email, 'PENDENTE', antigo.empresaId]);
      const novoToken = tokenDoLink(r.body.entrega.linkAceite);
      assert.notEqual(novoToken, antigo.token);

      assert.notEqual((await linha(antigo.id)).cancelado_em, null);
      const novo = await linha(r.body.convite.id);
      assert.deepEqual([novo.cancelado_em, novo.aceito_em, novo.criado_por], [null, null, administradorId]);
      assert.equal(novo.token_hash, sha256(novoToken));
      assert.equal(JSON.stringify(novo).includes(novoToken), false);

      assert.deepEqual([(await consultar(antigo.token)).status, (await consultar(antigo.token)).body.codigo], [409, 'CONVITE_CANCELADO']);
      assert.equal((await aceitar(antigo.token)).body.codigo, 'CONVITE_CANCELADO');
      assert.equal((await consultar(novoToken)).status, 200);
      const aceite = await aceitar(novoToken);
      assert.equal(aceite.status, 201, JSON.stringify(aceite.body));

      const texto = saidas.join('\n');
      for (const segredo of [antigo.token, novoToken, antigo.email]) assert.equal(texto.includes(segredo), false, 'segredo no console');
    });

    test('auditoria da PLATAFORMA: ação própria, administrador da sessão, convite novo e anterior, sem e-mail, token ou hash', async () => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      const r = await reenviar(antigo.empresaId, antigo.id);
      assert.equal(r.status, 201);
      const registros = (await auditorias('CONVITE_MASTER_REENVIADO')).filter((a) => a.referencia === r.body.convite.id);
      assert.equal(registros.length, 1);
      const [a] = registros;
      assert.deepEqual([a.administrador_id, a.empresa_afetada_id], [administradorId, antigo.empresaId]);
      assert.deepEqual(a.dados_novos, { conviteId: r.body.convite.id, conviteAnteriorId: String(antigo.id) });
      assert.deepEqual(a.contexto, { origem: 'painel_privado' });
      const texto = JSON.stringify(a);
      for (const segredo of [antigo.email, antigo.token, tokenDoLink(r.body.entrega.linkAceite), sha256(antigo.token)]) assert.equal(texto.includes(segredo), false);
    });

    test('convite expirado também pode ser reenviado', async () => {
      const antigo = await convidar();
      await expirar(antigo.id);
      const r = await reenviar(antigo.empresaId, antigo.id);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.notEqual((await linha(antigo.id)).cancelado_em, null);
      assert.equal((await abertos(antigo.empresaId, antigo.email)).length, 1);
    });

    test('convite já aceito ou já cancelado: 409 CONVITE_NAO_REENVIAVEL e nada é criado', async () => {
      const cancelado = await convidar();
      assert.equal((await cancelar(cancelado.empresaId, cancelado.id)).status, 200);
      const aceito = await convidar();
      assert.equal((await aceitar(aceito.token)).status, 201);
      for (const alvo of [cancelado, aceito]) {
        const r = await reenviar(alvo.empresaId, alvo.id);
        assert.deepEqual([r.status, r.body.codigo], [409, 'CONVITE_NAO_REENVIAVEL']);
        assert.equal((await q('SELECT count(*)::int AS n FROM convites_master WHERE empresa_id = $1', [alvo.empresaId])).rows[0].n, 1);
      }
    });

    test('convite expirado substituído por outro em aberto para o mesmo e-mail: 409 CONVITE_JA_PENDENTE', async () => {
      const primeiro = await convidar();
      await expirar(primeiro.id);
      const segundo = await criar(primeiro.empresaId, primeiro.email);
      assert.equal(segundo.status, 201, JSON.stringify(segundo.body));
      await envelhecer(primeiro.empresaId, primeiro.email);
      const r = await reenviar(primeiro.empresaId, primeiro.id);
      assert.deepEqual([r.status, r.body.codigo], [409, 'CONVITE_JA_PENDENTE']);
      assert.equal((await abertos(primeiro.empresaId, primeiro.email)).length, 1);
    });
  });

  describe('escopo e autoridade', () => {
    test('convite de outra empresa na rota, empresa inexistente e empresa inativa: 404, 404 e 409, sem mexer em nada', async () => {
      const alvo = await convidar();
      await envelhecer(alvo.empresaId, alvo.email);
      const outraEmpresa = await novaEmpresa();
      const deOutra = await reenviar(outraEmpresa, alvo.id);
      assert.deepEqual([deOutra.status, deOutra.body.codigo], [404, 'CONVITE_NAO_ENCONTRADO']);
      const inexistente = await reenviar(outraEmpresa, '999999999');
      assert.deepEqual(deOutra.body, inexistente.body);
      assert.deepEqual([(await reenviar(999999, alvo.id)).status, (await reenviar(999999, alvo.id)).body.codigo], [404, 'EMPRESA_NAO_ENCONTRADA']);
      await q('UPDATE empresas SET ativo = false WHERE id = $1', [alvo.empresaId]);
      assert.deepEqual([(await reenviar(alvo.empresaId, alvo.id)).status, (await reenviar(alvo.empresaId, alvo.id)).body.codigo], [409, 'EMPRESA_INATIVA']);
      await q('UPDATE empresas SET ativo = true WHERE id = $1', [alvo.empresaId]);
      assert.equal((await linha(alvo.id)).cancelado_em, null);
    });

    test('sem sessão da plataforma: 401; corpo com campo extra e identificadores inválidos: 400', async () => {
      const alvo = await convidar();
      assert.equal((await request(app).post(`${PLATAFORMA}/convites-master/${alvo.empresaId}/${alvo.id}/reenviar`).send({})).status, 401);
      const comExtra = await admin(request(app).post(`${PLATAFORMA}/convites-master/${alvo.empresaId}/${alvo.id}/reenviar`)).send({ email: 'x@y.com' });
      assert.equal(comExtra.status, 400);
      assert.equal((await admin(request(app).post(`${PLATAFORMA}/convites-master/${alvo.empresaId}/abc/reenviar`)).send({})).status, 400);
      assert.equal((await linha(alvo.id)).cancelado_em, null);
    });
  });

  describe('teto de envios por (empresa, e-mail)', () => {
    test('reenviar de novo em menos de 60 segundos: 429 com Retry-After, e o convite que vale continua pendente', async () => {
      const alvo = await convidar();
      const r = await reenviar(alvo.empresaId, alvo.id);
      assert.deepEqual([r.status, r.body.codigo], [429, 'CONVITE_ENVIO_MUITO_RECENTE']);
      const espera = Number(r.headers['retry-after']);
      assert.ok(Number.isInteger(espera) && espera >= 1 && espera <= 60, r.headers['retry-after']);
      assert.equal((await linha(alvo.id)).cancelado_em, null);
    });

    test('cancelar e convidar de novo logo em seguida não contorna o teto; passados os 60 segundos, passa', async () => {
      const alvo = await convidar();
      assert.equal((await cancelar(alvo.empresaId, alvo.id)).status, 200);
      const logo = await criar(alvo.empresaId, alvo.email);
      assert.deepEqual([logo.status, logo.body.codigo], [429, 'CONVITE_ENVIO_MUITO_RECENTE']);
      await envelhecer(alvo.empresaId, alvo.email);
      assert.equal((await criar(alvo.empresaId, alvo.email)).status, 201);
    });

    test('cinco convites em 24 horas: o sexto, por reenvio ou por criação, é recusado (429 diário); depois da janela volta a passar', async () => {
      const primeiro = await convidar();
      let atualId = primeiro.id;
      for (let i = 0; i < 4; i += 1) {
        await envelhecer(primeiro.empresaId, primeiro.email);
        const r = await reenviar(primeiro.empresaId, atualId);
        assert.equal(r.status, 201, `reenvio ${i + 1}: ${JSON.stringify(r.body)}`);
        atualId = r.body.convite.id;
      }
      await envelhecer(primeiro.empresaId, primeiro.email);
      const sexto = await reenviar(primeiro.empresaId, atualId);
      assert.deepEqual([sexto.status, sexto.body.codigo], [429, 'CONVITE_ENVIO_LIMITE_DIARIO']);
      assert.ok(Number(sexto.headers['retry-after']) > 60);
      assert.equal((await abertos(primeiro.empresaId, primeiro.email)).length, 1);

      await cancelar(primeiro.empresaId, atualId);
      const criacao = await criar(primeiro.empresaId, primeiro.email);
      assert.deepEqual([criacao.status, criacao.body.codigo], [429, 'CONVITE_ENVIO_LIMITE_DIARIO']);

      await envelhecer(primeiro.empresaId, primeiro.email, '25 hours');
      assert.equal((await criar(primeiro.empresaId, primeiro.email)).status, 201);
    });

    test('o teto é por empresa e e-mail: o mesmo e-mail em outra empresa não é afetado', async () => {
      const alvo = await convidar();
      assert.equal((await reenviar(alvo.empresaId, alvo.id)).status, 429);
      const outraEmpresa = await novaEmpresa();
      assert.equal((await criar(outraEmpresa, alvo.email)).status, 201);
    });
  });

  describe('concorrência', () => {
    test('dois reenvios simultâneos do mesmo convite: um 201 e um 409, um único convite em aberto', async () => {
      const alvo = await convidar();
      await envelhecer(alvo.empresaId, alvo.email);
      const respostas = await Promise.all([reenviar(alvo.empresaId, alvo.id), reenviar(alvo.empresaId, alvo.id), reenviar(alvo.empresaId, alvo.id)]);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(respostas.map((r) => r.body)));
      assert.ok(respostas.filter((r) => r.status === 409).every((r) => r.body.codigo === 'CONVITE_NAO_REENVIAVEL'));
      assert.equal((await abertos(alvo.empresaId, alvo.email)).length, 1);
    });

    test('reenviar e aceitar ao mesmo tempo: só um vence; nunca há MASTER criado por link cancelado nem dois convites em aberto', async () => {
      const alvo = await convidar();
      await envelhecer(alvo.empresaId, alvo.email);
      const [reenvio, aceite] = await Promise.all([reenviar(alvo.empresaId, alvo.id), aceitar(alvo.token)]);
      const vinculos = (await q('SELECT count(*)::int AS n FROM usuarios WHERE empresa_id = $1', [alvo.empresaId])).rows[0].n;
      const anterior = await linha(alvo.id);
      if (aceite.status === 201) {
        assert.deepEqual([reenvio.status, reenvio.body.codigo], [409, 'CONVITE_NAO_REENVIAVEL']);
        assert.deepEqual([vinculos, anterior.cancelado_em === null], [1, true]);
        assert.equal((await abertos(alvo.empresaId, alvo.email)).length, 0);
      } else {
        assert.equal(reenvio.status, 201, JSON.stringify([reenvio.body, aceite.body]));
        assert.deepEqual([aceite.status, aceite.body.codigo], [409, 'CONVITE_CANCELADO']);
        assert.deepEqual([vinculos, anterior.cancelado_em !== null], [0, true]);
        assert.equal((await abertos(alvo.empresaId, alvo.email)).length, 1);
      }
    });

    test('reenviar e cancelar ao mesmo tempo: exatamente um 2xx e o estado final é coerente', async () => {
      const alvo = await convidar();
      await envelhecer(alvo.empresaId, alvo.email);
      const [reenvio, cancelamento] = await Promise.all([reenviar(alvo.empresaId, alvo.id), cancelar(alvo.empresaId, alvo.id)]);
      assert.equal([reenvio, cancelamento].filter((r) => r.status >= 200 && r.status < 300).length, 1, JSON.stringify([reenvio.body, cancelamento.body]));
      assert.equal((await abertos(alvo.empresaId, alvo.email)).length, reenvio.status === 201 ? 1 : 0);
    });

    test('criar e reenviar ao mesmo tempo para o mesmo e-mail: o reenvio vence e a criação encontra convite em aberto (409)', async () => {
      const alvo = await convidar();
      await envelhecer(alvo.empresaId, alvo.email);
      const [reenvio, criacao] = await Promise.all([reenviar(alvo.empresaId, alvo.id), criar(alvo.empresaId, alvo.email)]);
      assert.equal(reenvio.status, 201, JSON.stringify(reenvio.body));
      assert.deepEqual([criacao.status, criacao.body.codigo], [409, 'CONVITE_JA_PENDENTE']);
      assert.equal((await abertos(alvo.empresaId, alvo.email)).length, 1);
    });
  });

  describe('entrega', () => {
    const preparar = (entrega) => {
      const chamadas = [];
      const appInjetado = montarApp(async (dados) => { chamadas.push(dados); return entrega(dados); });
      return { chamadas, alvo: () => appInjetado };
    };

    test('com e-mail enviado de verdade: a resposta não traz link nem token, e a entrega recebe o convite novo como reenvio', async () => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      const { chamadas, alvo } = preparar(async (d) => ({ modo: 'EMAIL', estado: 'ENVIADO', expiraEm: d.expiraEm }));
      const r = await reenviar(antigo.empresaId, antigo.id, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal('linkAceite' in r.body.entrega, false);
      assert.equal(JSON.stringify(r.body).includes('token'), false);
      assert.equal(chamadas.length, 1);
      assert.equal(chamadas[0].reenvio, true);
      assert.equal(chamadas[0].email, antigo.email);
      assert.equal((await linha(r.body.convite.id)).token_hash, sha256(chamadas[0].token));
    });

    test('falha no envio: 201, o convite novo fica pendente e pode ser reenviado depois', async () => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      const { alvo } = preparar(async (d) => ({ modo: 'EMAIL', estado: 'FALHA', expiraEm: d.expiraEm }));
      const r = await reenviar(antigo.empresaId, antigo.id, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.entrega.estado, 'FALHA');
      assert.equal((await abertos(antigo.empresaId, antigo.email)).length, 1);
      await envelhecer(antigo.empresaId, antigo.email);
      assert.equal((await reenviar(antigo.empresaId, r.body.convite.id)).status, 201);
    });

    test('production sem provedor de e-mail real: 503 antes de gravar, nada cancelado, nada criado', async (t) => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      const original = entregaConvite.exigirDisponivel;
      t.mock.method(entregaConvite, 'exigirDisponivel', () => original('production', 'desativado'));
      t.mock.method(console, 'error', () => {});
      const r = await reenviar(antigo.empresaId, antigo.id);
      assert.deepEqual([r.status, r.body.codigo], [503, 'CONVITE_ENTREGA_INDISPONIVEL']);
      assert.equal('entrega' in r.body, false);
      assert.equal((await linha(antigo.id)).cancelado_em, null);
      assert.equal((await q('SELECT count(*)::int AS n FROM convites_master WHERE empresa_id = $1', [antigo.empresaId])).rows[0].n, 1);
    });
  });

  describe('atomicidade com falha real no meio do reenvio', () => {
    const contagem = async (empresaId) => (await q('SELECT count(*)::int AS n FROM convites_master WHERE empresa_id = $1', [empresaId])).rows[0].n;
    const reenvios = async () => (await auditorias('CONVITE_MASTER_REENVIADO')).length;

    test('se a criação do convite novo falhar depois do cancelamento, o cancelamento é desfeito: o anterior continua pendente e nada fica gravado', async (t) => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      const auditoriasAntes = await reenvios();
      t.mock.method(console, 'error', () => {});
      const original = conviteRepo.criar;
      t.mock.method(conviteRepo, 'criar', async (...args) => {
        assert.equal((await linha(antigo.id)).cancelado_em, null, 'a leitura fora da transação ainda enxerga o anterior pendente');
        await original(...args);
        throw new Error('falha simulada depois do INSERT');
      });

      const r = await reenviar(antigo.empresaId, antigo.id);
      assert.equal(r.status, 500);
      assert.equal(JSON.stringify(r.body).includes('simulada'), false);
      assert.equal((await linha(antigo.id)).cancelado_em, null, 'o cancelamento foi desfeito');
      assert.equal(await contagem(antigo.empresaId), 1, 'o INSERT do novo também foi desfeito');
      assert.equal(await reenvios(), auditoriasAntes);
      assert.equal((await consultar(antigo.token)).status, 200, 'o link antigo continua valendo');
    });

    test('se a auditoria da plataforma falhar, nada do reenvio fica', async (t) => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      t.mock.method(console, 'error', () => {});
      t.mock.method(auditoriaPlataformaRepo, 'registrar', async () => { throw new Error('falha simulada na auditoria'); });
      const r = await reenviar(antigo.empresaId, antigo.id);
      assert.equal(r.status, 500);
      assert.equal((await linha(antigo.id)).cancelado_em, null);
      assert.equal(await contagem(antigo.empresaId), 1);
    });
  });

  describe('trava consultiva do par (empresa, e-mail)', () => {
    test('reenviar convite expirado e criar ao mesmo tempo para o mesmo e-mail: em 8 rodadas, nunca há dois convites em aberto', async () => {
      for (let rodada = 0; rodada < 8; rodada += 1) {
        const expirado = await convidar();
        await expirar(expirado.id);
        const respostas = await Promise.all([
          reenviar(expirado.empresaId, expirado.id),
          criar(expirado.empresaId, expirado.email),
          reenviar(expirado.empresaId, expirado.id),
        ]);
        assert.equal(respostas.filter((r) => r.status === 201).length, 1, `rodada ${rodada}: ${JSON.stringify(respostas.map((r) => [r.status, r.body.codigo]))}`);
        assert.ok(respostas.filter((r) => r.status !== 201).every((r) => r.status === 409), `rodada ${rodada}`);
        assert.equal((await abertos(expirado.empresaId, expirado.email)).length, 1, `rodada ${rodada}`);
      }
    });
  });

  describe('entrega SMTP de production (transporte e serviço reais, nodemailer substituído)', () => {
    const SENHA_SMTP = 'senhaSmtpFicticiaParaTeste42';
    const USUARIO_SMTP = 'usuarioSmtpFicticio';

    function entregaDeProducao(enviar) {
      const enviadas = [];
      const config = carregarConfigEmail({
        EMAIL_MODO: 'smtp', SMTP_HOST: 'smtp.exemplo-provedor.test', SMTP_USUARIO: USUARIO_SMTP, SMTP_SENHA: SENHA_SMTP,
      });
      const transporte = criarSmtp(config, { criarTransporteNodemailer: () => ({ sendMail: async (mensagem) => { enviadas.push(mensagem); return enviar(mensagem); }, close() {} }) });
      const servico = criarServicoEmail({ transporte });
      const entregar = (dados) => entregaConvite.entregar(dados, { servico, ambiente: 'production', config });
      return { enviadas, alvo: () => montarApp(entregar) };
    }
    const aceita = async (mensagem) => ({ accepted: [mensagem.envelope.to[0]], rejected: [] });
    const tokenDoEmail = (mensagem) => /#token=([A-Za-z0-9_-]{43})/.exec(mensagem.text)[1];

    test('o e-mail leva o link e o token novos; a resposta HTTP não traz link nem token; o banco guarda só o hash', async (t) => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      const { enviadas, alvo } = entregaDeProducao(aceita);
      const saidas = [];
      for (const metodo of ['log', 'info', 'warn', 'error']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });

      const r = await reenviar(antigo.empresaId, antigo.id, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.entrega.modo, r.body.entrega.estado], ['EMAIL', 'ENVIADO']);
      assert.equal('linkAceite' in r.body.entrega, false);
      assert.equal(enviadas.length, 1);
      assert.equal(enviadas[0].to, antigo.email);
      assert.match(enviadas[0].text, /painel-privado\/aceitar-convite\.html#token=/);
      const novoToken = tokenDoEmail(enviadas[0]);
      assert.notEqual(novoToken, antigo.token);
      assert.equal(JSON.stringify(r.body).includes(novoToken), false, 'token na resposta HTTP');
      assert.equal((await linha(r.body.convite.id)).token_hash, sha256(novoToken));
      assert.equal((await consultar(novoToken)).status, 200);
      assert.equal((await consultar(antigo.token)).body.codigo, 'CONVITE_CANCELADO');
      assert.equal(saidas.join('\n').includes(novoToken), false, 'token no console');
    });

    test('provedor recusa: 201 com estado FALHA, o convite novo fica pendente, e o log não leva e-mail, token, link nem texto do provedor', async (t) => {
      const antigo = await convidar();
      await envelhecer(antigo.empresaId, antigo.email);
      const erroDoProvedor = Object.assign(new Error(`550 5.1.1 <${antigo.email}> rejeitado por smtp-interno.exemplo.net com ${SENHA_SMTP}`), { code: 'EENVELOPE' });
      const { enviadas, alvo } = entregaDeProducao(async () => { throw erroDoProvedor; });
      const saidas = [];
      for (const metodo of ['log', 'info', 'warn', 'error']) t.mock.method(console, metodo, (...a) => { saidas.push(JSON.stringify(a)); });

      const r = await reenviar(antigo.empresaId, antigo.id, alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.entrega.estado, 'FALHA');
      assert.equal('linkAceite' in r.body.entrega, false);
      assert.equal((await abertos(antigo.empresaId, antigo.email)).length, 1, 'o convite novo segue pendente');
      const token = tokenDoEmail(enviadas[0]);
      assert.equal((await consultar(token)).status, 200, 'e pode ser reenviado depois');
      const texto = saidas.join('\n');
      assert.match(texto, /entrega_falhou/);
      for (const sensivel of [antigo.email, token, antigo.token, '#token=', 'smtp-interno', SENHA_SMTP, USUARIO_SMTP, 'aceitar-convite']) {
        assert.equal(texto.includes(sensivel), false, `o log contém ${sensivel}`);
      }
    });

    test('criar convite também não devolve link em production com SMTP real', async () => {
      const { enviadas, alvo } = entregaDeProducao(aceita);
      const empresaId = await novaEmpresa();
      const r = await criar(empresaId, novoEmail(), alvo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal('linkAceite' in r.body.entrega, false);
      assert.equal(enviadas.length, 1);
      assert.equal(JSON.stringify(r.body).includes(tokenDoEmail(enviadas[0])), false);
    });
  });

  test('nenhuma auditoria da plataforma guarda token, hash, senha ou cookie dos reenvios', async () => {
    const { rows } = await q("SELECT contexto, dados_anteriores, dados_novos, referencia FROM logs_auditoria_plataforma WHERE acao IN ('CONVITE_MASTER_CRIADO', 'CONVITE_MASTER_CANCELADO', 'CONVITE_MASTER_REENVIADO')");
    const texto = JSON.stringify(rows);
    const { rows: hashes } = await q('SELECT token_hash FROM convites_master');
    for (const { token_hash: h } of hashes) assert.equal(texto.includes(h), false, 'hash do token na auditoria');
    assert.doesNotMatch(texto, /senha|argon|token|cookie|authorization/i);
  });
});
