'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');

const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarAppTeste } = require('../helpers/app-teste');
const { criarAuthPlataformaController } = require('../../src/controllers/auth-plataforma.controller');
const { criarAuthPlataformaRoutes } = require('../../src/routes/auth-plataforma.routes');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarEmpresaCadastroController } = require('../../src/controllers/empresa-cadastro.controller');
const { criarEmpresaCadastroRoutes } = require('../../src/routes/empresa-cadastro.routes');
const { criarConviteMasterController } = require('../../src/controllers/convite-master.controller');
const { criarConviteMasterRoutes } = require('../../src/routes/convite-master.routes');
const { criarAuthController } = require('../../src/controllers/auth.controller');
const { criarAuthRoutes } = require('../../src/routes/auth.routes');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarLimitador } = require('../../src/middleware/rate-limit');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const entregaConvite = require('../../src/services/entrega-convite.service');
const { gerarHashSenha } = require('../../src/security/password');
const { cnpjTemDigitosVerificadoresValidos } = require('../../src/utils/normalizacao');
const { authConfig } = require('../../src/config/auth');
const { ESCOPO_PROVISIONAMENTO_MASTER } = require('../../src/rbac/recursos');

/**
 * Pacote 3 — Cadastro de Empresas e Convite do MASTER: fluxo HTTP completo
 * contra PostgreSQL real (schema temporário exclusivo, todas as migrations
 * 000-034, removido em cascata ao final). Nenhum mock nos caminhos de
 * sucesso: serviços, repositórios, provisionamento e triggers reais.
 *
 * Monta, no mesmo app de teste, as rotas administrativas do Painel Privado
 * (empresas + convites), as rotas de login do Painel Privado (para obter o
 * cookie administrativo) e as rotas de login EMPRESARIAL (para provar que
 * o cookie empresarial não autentica as rotas administrativas).
 */

const TODAS_AS_MIGRATIONS = Array.from({ length: 35 }, (_, i) => String(i).padStart(3, '0'));
const SENHA_ADMIN = 'planeta-nebulosa-ozonio-42';
const SENHA_MASTER = 'quasar-boreal-91-nebula';
const SENHA_CLIENTE = 'senha-correta-do-teste-http-2026';

/** Dígitos verificadores do CNPJ alfanumérico (valor = código ASCII - 48). */
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

const CNPJ_A = completarCnpj('123456780001');
const CNPJ_B = completarCnpj('987654320001');
const CNPJ_ALFA = completarCnpj('12ABC345GH01');

function cookieDe(resposta, nome) {
  const cookies = resposta.headers['set-cookie'] ?? [];
  const alvo = cookies.find((c) => c.startsWith(`${nome}=`));
  assert.ok(alvo, `esperado Set-Cookie ${nome}`);
  return alvo.split(';')[0];
}

// O token viaja no FRAGMENTO do link (item 1 da correção), nunca na query.
const tokenDoLink = (link) => new URLSearchParams(new URL(link).hash.slice(1)).get('token');
const sha256 = (texto) => crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

const cadastroCompleto = (cnpj, extra = {}) => ({
  razaoSocial: 'Cobresul Indústria e Comércio Ltda',
  nomeFantasia: 'Cobresul',
  cnpj,
  inscricaoEstadual: '123.456.789.012',
  situacaoInscricaoEstadual: 'CONTRIBUINTE',
  endereco: 'Rua das Indústrias',
  numero: '1500',
  complemento: 'Galpão 3',
  bairro: 'Distrito Industrial',
  cidade: 'Caxias do Sul',
  uf: 'rs',
  cep: '95000-000',
  telefone: '(54) 3333-0000',
  email: 'Contato@Cobresul.com.br',
  representanteNome: 'Maria Representante',
  representanteCargo: 'Diretora',
  representanteEmail: 'maria@cobresul.com.br',
  representanteTelefone: '(54) 99999-0001',
  financeiroNome: 'João Financeiro',
  financeiroEmail: 'financeiro@cobresul.com.br',
  financeiroTelefone: '(54) 99999-0002',
  ...extra,
});

describe('Pacote 3 — cadastro de empresas e convite do MASTER (HTTP + PostgreSQL real)', () => {
  let contexto;
  let app;
  let cookieAdmin;
  let administradorId;

  before(async () => {
    assert.ok(cnpjTemDigitosVerificadoresValidos(CNPJ_A) && cnpjTemDigitosVerificadoresValidos(CNPJ_ALFA), 'pré-condição: gerador de DV do teste concorda com utils/normalizacao');

    contexto = await abrirPoolTemporario(TODAS_AS_MIGRATIONS);
    const { pool } = contexto;

    const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
    const semLimite = () => criarLimitador({ limite: 100000, janelaSegundos: 60 });
    const authPlataformaRoutes = criarAuthPlataformaRoutes({
      controller: criarAuthPlataformaController({ pool }), limitador: semLimite(), exigirSessaoPlataforma,
    });
    const empresaRoutes = criarEmpresaCadastroRoutes({ controller: criarEmpresaCadastroController({ pool }), exigirSessaoPlataforma });
    const conviteRoutes = criarConviteMasterRoutes({ controller: criarConviteMasterController({ pool }), exigirSessaoPlataforma, limitador: semLimite() });
    const authClienteRoutes = criarAuthRoutes({ controller: criarAuthController({ pool }), limitador: semLimite(), exigirSessao: criarExigirSessao({ pool }) });

    app = criarAppTeste((a) => {
      a.use('/api', authClienteRoutes);
      a.use('/api/plataforma', authPlataformaRoutes, empresaRoutes, conviteRoutes);
    });

    const administrador = await criarInicial(pool, { email: 'admin@safework.com.br', senha: SENHA_ADMIN });
    administradorId = administrador.id;
    const login = await request(app).post('/api/plataforma/auth/login').send({ email: 'admin@safework.com.br', senha: SENHA_ADMIN });
    assert.equal(login.status, 200);
    cookieAdmin = cookieDe(login, authConfig.sessao.cookieNomeAdmin);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const admin = (req) => req.set('Cookie', cookieAdmin);

  // ---------------------------------------------------------------------
  // CADASTRO DE EMPRESA
  // ---------------------------------------------------------------------
  describe('cadastro de empresa', () => {
    let empresaA;

    test('cadastro completo: 201, todos os campos persistidos, normalizados; provisionamento MASTER pronto; auditoria da plataforma com o administrador da sessão', async () => {
      const r = await admin(request(app).post('/api/plataforma/empresas')).send(cadastroCompleto(CNPJ_A));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      empresaA = r.body.empresa;

      assert.equal(empresaA.razaoSocial, 'Cobresul Indústria e Comércio Ltda');
      assert.equal(empresaA.nomeFantasia, 'Cobresul');
      assert.equal(empresaA.cnpj, CNPJ_A);
      assert.equal(empresaA.inscricaoEstadual, '123.456.789.012');
      assert.equal(empresaA.situacaoInscricaoEstadual, 'CONTRIBUINTE');
      assert.equal(empresaA.uf, 'RS', 'UF normalizada para maiúsculas');
      assert.equal(empresaA.cep, '95000000', 'CEP canônico sem máscara');
      assert.equal(empresaA.email, 'contato@cobresul.com.br', 'e-mail institucional normalizado');
      assert.deepEqual(empresaA.representante, { nome: 'Maria Representante', cargo: 'Diretora', email: 'maria@cobresul.com.br', telefone: '(54) 99999-0001' });
      assert.deepEqual(empresaA.financeiro, { nome: 'João Financeiro', email: 'financeiro@cobresul.com.br', telefone: '(54) 99999-0002' });
      assert.equal(empresaA.ativo, true);

      // Persistido de verdade, na coluna certa (nome = razão social; IE nunca "ISENTO" por padrão).
      const { rows } = await contexto.pool.query('SELECT nome, nome_fantasia, inscricao_estadual, situacao_inscricao_estadual, bairro, representante_email, financeiro_email FROM empresas WHERE id = $1', [empresaA.id]);
      assert.equal(rows[0].nome, 'Cobresul Indústria e Comércio Ltda');
      assert.equal(rows[0].nome_fantasia, 'Cobresul');
      assert.equal(rows[0].bairro, 'Distrito Industrial');
      assert.equal(rows[0].representante_email, 'maria@cobresul.com.br');
      assert.equal(rows[0].financeiro_email, 'financeiro@cobresul.com.br');

      // Provisionamento MASTER na mesma transação: linhas reais em permissoes_recurso/permissoes_acao.
      assert.equal(r.body.provisionamento.prontaParaMaster, true);
      const { rows: perms } = await contexto.pool.query("SELECT recurso FROM permissoes_recurso WHERE empresa_id = $1 AND perfil = 'MASTER' ORDER BY recurso", [empresaA.id]);
      assert.deepEqual(perms.map((p) => p.recurso).sort(), ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((x) => x.recurso).sort());
      const { rows: acoes } = await contexto.pool.query("SELECT acao_codigo, permitido FROM permissoes_acao WHERE empresa_id = $1 AND perfil = 'MASTER'", [empresaA.id]);
      assert.deepEqual(acoes, [{ acao_codigo: 'MOVIMENTAR_ESTOQUE', permitido: true }]);

      // Auditoria: trilha da PLATAFORMA, com o administrador da sessão e a empresa afetada.
      const { rows: audit } = await contexto.pool.query("SELECT administrador_id, empresa_afetada_id, acao, dados_novos FROM logs_auditoria_plataforma WHERE acao = 'EMPRESA_CRIADA' AND empresa_afetada_id = $1", [empresaA.id]);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].administrador_id, administradorId);
      assert.equal(audit[0].dados_novos.cnpj, CNPJ_A);

      // Nenhum acesso operacional automático: nada em usuarios/sessoes para o administrador.
      const { rows: usuarios } = await contexto.pool.query('SELECT count(*)::int AS total FROM usuarios WHERE empresa_id = $1', [empresaA.id]);
      assert.equal(usuarios[0].total, 0);
    });

    test('CNPJ duplicado: 409 EMPRESA_CNPJ_EM_USO, nada gravado', async () => {
      const r = await admin(request(app).post('/api/plataforma/empresas')).send(cadastroCompleto(CNPJ_A, { razaoSocial: 'Outra Razão' }));
      assert.deepEqual([r.status, r.body.codigo], [409, 'EMPRESA_CNPJ_EM_USO']);
      const { rows } = await contexto.pool.query('SELECT count(*)::int AS total FROM empresas WHERE cnpj = $1', [CNPJ_A]);
      assert.equal(rows[0].total, 1);
    });

    test('CNPJ alfanumérico (Receita Federal) com DV válido: aceito e persistido em maiúsculas', async () => {
      const r = await admin(request(app).post('/api/plataforma/empresas')).send({ razaoSocial: 'Alfa Numérica S.A.', cnpj: CNPJ_ALFA.toLowerCase() });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.empresa.cnpj, CNPJ_ALFA);
    });

    test('CNPJ com dígitos verificadores inválidos: 400 de validação, sem tocar o banco', async () => {
      const invalido = `${CNPJ_B.slice(0, 12)}${CNPJ_B.slice(12) === '00' ? '11' : '00'}`;
      assert.equal(cnpjTemDigitosVerificadoresValidos(invalido), false);
      const r = await admin(request(app).post('/api/plataforma/empresas')).send({ razaoSocial: 'X', cnpj: invalido });
      assert.equal(r.status, 400);
      assert.ok(r.body.detalhes.some((d) => d.codigo === 'CNPJ_DV_INVALIDO'));
    });

    test('campos inválidos: UF com 3 letras, e-mail malformado, situação de IE desconhecida, CONTRIBUINTE sem IE', async () => {
      const casos = [
        [{ uf: 'RSX' }, 'UF_INVALIDA'],
        [{ representanteEmail: 'sem-arroba' }, 'EMAIL_INVALIDO'],
        [{ situacaoInscricaoEstadual: 'QUALQUER' }, 'VALOR_NAO_PERMITIDO'],
        [{ cep: '1234' }, 'CEP_INVALIDO'],
      ];
      for (const [extra, codigo] of casos) {
        const r = await admin(request(app).post('/api/plataforma/empresas')).send(cadastroCompleto(CNPJ_B, extra));
        assert.equal(r.status, 400, JSON.stringify(extra));
        assert.ok(r.body.detalhes.some((d) => d.codigo === codigo), `${JSON.stringify(extra)} -> ${JSON.stringify(r.body.detalhes)}`);
      }
      const semIe = await admin(request(app).post('/api/plataforma/empresas')).send(cadastroCompleto(CNPJ_B, { inscricaoEstadual: null, situacaoInscricaoEstadual: 'CONTRIBUINTE' }));
      assert.deepEqual([semIe.status, semIe.body.codigo], [400, 'EMPRESA_IE_EXIGIDA']);

      const { rows } = await contexto.pool.query('SELECT count(*)::int AS total FROM empresas WHERE cnpj = $1', [CNPJ_B]);
      assert.equal(rows[0].total, 0, 'nenhuma tentativa inválida pode ter gravado a empresa');
    });

    test('IE não é obrigatória e NUNCA é preenchida com "ISENTO" por padrão', async () => {
      const r = await admin(request(app).post('/api/plataforma/empresas')).send({ razaoSocial: 'Sem IE Ltda', cnpj: CNPJ_B });
      assert.equal(r.status, 201);
      assert.equal(r.body.empresa.inscricaoEstadual, null);
      assert.equal(r.body.empresa.situacaoInscricaoEstadual, null);
    });

    test('consulta e listagem: GET por id traz o cadastro completo; busca por nome fantasia e por CNPJ', async () => {
      const um = await admin(request(app).get(`/api/plataforma/empresas/${empresaA.id}`));
      assert.equal(um.status, 200);
      assert.equal(um.body.empresa.representante.nome, 'Maria Representante');

      const porFantasia = await admin(request(app).get('/api/plataforma/empresas').query({ busca: 'cobresul' }));
      assert.equal(porFantasia.status, 200);
      assert.equal(porFantasia.body.total, 1);
      assert.equal(porFantasia.body.empresas[0].id, empresaA.id);

      const porCnpj = await admin(request(app).get('/api/plataforma/empresas').query({ busca: CNPJ_B }));
      assert.equal(porCnpj.body.total, 1);

      const inexistente = await admin(request(app).get('/api/plataforma/empresas/999999'));
      assert.deepEqual([inexistente.status, inexistente.body.codigo], [404, 'EMPRESA_NAO_ENCONTRADA']);
    });

    test('edição: altera campos, limpa campo com null explícito, preserva o que não foi informado; CNPJ é imutável (400 CAMPO_NAO_PERMITIDO); auditoria com antes/depois', async () => {
      const r = await admin(request(app).patch(`/api/plataforma/empresas/${empresaA.id}`)).send({ nomeFantasia: 'Cobresul Metais', complemento: null, financeiroTelefone: '(54) 3333-9999' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.empresa.nomeFantasia, 'Cobresul Metais');
      assert.equal(r.body.empresa.complemento, null, 'null explícito limpa');
      assert.equal(r.body.empresa.bairro, 'Distrito Industrial', 'não informado permanece');
      assert.equal(r.body.empresa.financeiro.telefone, '(54) 3333-9999');

      const cnpj = await admin(request(app).patch(`/api/plataforma/empresas/${empresaA.id}`)).send({ cnpj: CNPJ_B });
      assert.equal(cnpj.status, 400);
      assert.ok(cnpj.body.detalhes.some((d) => d.codigo === 'CAMPO_NAO_PERMITIDO'));

      const vazio = await admin(request(app).patch(`/api/plataforma/empresas/${empresaA.id}`)).send({});
      assert.deepEqual([vazio.status, vazio.body.codigo], [400, 'EMPRESA_SEM_ALTERACAO']);

      const { rows } = await contexto.pool.query("SELECT dados_anteriores, dados_novos FROM logs_auditoria_plataforma WHERE acao = 'EMPRESA_ALTERADA' AND empresa_afetada_id = $1", [empresaA.id]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].dados_anteriores.nomeFantasia, 'Cobresul');
      assert.equal(rows[0].dados_novos.nomeFantasia, 'Cobresul Metais');
    });

    test('inativar e reativar: idempotentes, auditados, sem exclusão física; empresa inativa não recebe convite nem provisionamento', async () => {
      const inativar = await admin(request(app).post(`/api/plataforma/empresas/${empresaA.id}/inativar`)).send({});
      assert.deepEqual([inativar.status, inativar.body.alterado, inativar.body.empresa.ativo], [200, true, false]);
      const denovo = await admin(request(app).post(`/api/plataforma/empresas/${empresaA.id}/inativar`)).send({});
      assert.deepEqual([denovo.status, denovo.body.alterado], [200, false]);

      const convite = await admin(request(app).post(`/api/plataforma/empresas/${empresaA.id}/convites-master`)).send({ email: 'master@cobresul.com.br' });
      assert.deepEqual([convite.status, convite.body.codigo], [409, 'EMPRESA_INATIVA']);
      const prov = await admin(request(app).get(`/api/plataforma/empresas/${empresaA.id}/provisionamento`));
      assert.deepEqual([prov.status, prov.body.codigo], [409, 'EMPRESA_INATIVA']);

      const reativar = await admin(request(app).post(`/api/plataforma/empresas/${empresaA.id}/reativar`)).send({});
      assert.deepEqual([reativar.status, reativar.body.alterado, reativar.body.empresa.ativo], [200, true, true]);

      const { rows } = await contexto.pool.query("SELECT acao FROM logs_auditoria_plataforma WHERE empresa_afetada_id = $1 AND acao IN ('EMPRESA_INATIVADA','EMPRESA_REATIVADA') ORDER BY id", [empresaA.id]);
      assert.deepEqual(rows.map((x) => x.acao), ['EMPRESA_INATIVADA', 'EMPRESA_REATIVADA']);
      const { rows: existe } = await contexto.pool.query('SELECT count(*)::int AS total FROM empresas WHERE id = $1', [empresaA.id]);
      assert.equal(existe[0].total, 1);
    });

    test('provisionamento: consulta relata pronta=true; uma linha INSUFICIENTE (pode_editar=false) é DETECTADA e a empresa deixa de ser apresentada como pronta', async () => {
      const antes = await admin(request(app).get(`/api/plataforma/empresas/${empresaA.id}/provisionamento`));
      assert.equal(antes.status, 200);
      assert.equal(antes.body.prontaParaMaster, true);

      await contexto.pool.query("UPDATE permissoes_recurso SET pode_editar = false WHERE empresa_id = $1 AND perfil = 'MASTER' AND recurso = 'materials'", [empresaA.id]);
      const depois = await admin(request(app).get(`/api/plataforma/empresas/${empresaA.id}/provisionamento`));
      assert.equal(depois.body.prontaParaMaster, false);
      assert.equal(depois.body.totais.INSUFICIENTE, 1);
      const item = depois.body.plano.recursos.find((x) => x.recurso === 'materials');
      assert.deepEqual([item.situacao, item.faltantes], ['INSUFICIENTE', ['editar']]);

      await contexto.pool.query("UPDATE permissoes_recurso SET pode_editar = true WHERE empresa_id = $1 AND perfil = 'MASTER' AND recurso = 'materials'", [empresaA.id]);
    });

    test('falha transacional: se o provisionamento falhar, a empresa NÃO fica criada e nada é auditado', async (t) => {
      const cnpj = completarCnpj('555555550001');
      t.mock.method(provisionamento, 'provisionarComExecutor', async () => { throw new Error('falha simulada no provisionamento'); });
      t.mock.method(console, 'error', () => {});

      const r = await admin(request(app).post('/api/plataforma/empresas')).send({ razaoSocial: 'Transacional Ltda', cnpj });
      assert.equal(r.status, 500);

      const { rows } = await contexto.pool.query('SELECT count(*)::int AS total FROM empresas WHERE cnpj = $1', [cnpj]);
      assert.equal(rows[0].total, 0, 'ROLLBACK: o INSERT da empresa foi desfeito junto com o provisionamento');
      const { rows: audit } = await contexto.pool.query("SELECT count(*)::int AS total FROM logs_auditoria_plataforma WHERE acao = 'EMPRESA_CRIADA' AND dados_novos->>'cnpj' = $1", [cnpj]);
      assert.equal(audit[0].total, 0);
    });
  });

  // ---------------------------------------------------------------------
  // AUTORIDADE E ISOLAMENTO
  // ---------------------------------------------------------------------
  describe('autoridade do Painel Privado e isolamento entre autoridades', () => {
    test('sem sessão administrativa: 401 em todas as rotas administrativas', async () => {
      const rotas = [
        request(app).post('/api/plataforma/empresas').send({}),
        request(app).get('/api/plataforma/empresas'),
        request(app).get('/api/plataforma/empresas/1'),
        request(app).patch('/api/plataforma/empresas/1').send({}),
        request(app).post('/api/plataforma/empresas/1/inativar').send({}),
        request(app).post('/api/plataforma/empresas/1/convites-master').send({ email: 'x@y.com' }),
        request(app).get('/api/plataforma/empresas/1/convites-master'),
        request(app).post('/api/plataforma/convites-master/1/1/cancelar').send({}),
      ];
      for (const rota of rotas) {
        const r = await rota;
        assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA']);
      }
    });

    test('o cookie EMPRESARIAL (usuário de uma empresa) nunca autentica as rotas administrativas; administrador_id no corpo é recusado', async () => {
      const { rows: empresas } = await contexto.pool.query('SELECT id FROM empresas WHERE cnpj = $1', [CNPJ_A]);
      const hash = await gerarHashSenha(SENHA_CLIENTE);
      await contexto.pool.query("INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil) VALUES ($1, 'Usuário Cliente', 'usuario@cobresul.com.br', $2, 'ADMINISTRADOR')", [empresas[0].id, hash]);
      const login = await request(app).post('/api/auth/login').send({ cnpj: CNPJ_A, email: 'usuario@cobresul.com.br', senha: SENHA_CLIENTE });
      assert.equal(login.status, 200);
      const cookieCliente = cookieDe(login, authConfig.sessao.cookieNome);

      const r = await request(app).get('/api/plataforma/empresas').set('Cookie', cookieCliente);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA']);

      const forjado = await admin(request(app).post('/api/plataforma/empresas')).send({ razaoSocial: 'X', cnpj: CNPJ_B, administradorId: 999 });
      assert.equal(forjado.status, 400);
      assert.ok(forjado.body.detalhes.some((d) => d.codigo === 'CAMPO_NAO_PERMITIDO'));
    });
  });

  // ---------------------------------------------------------------------
  // CONVITE DO MASTER
  // ---------------------------------------------------------------------
  describe('convite do primeiro MASTER', () => {
    let empresaA;
    let empresaB;
    const EMAIL_MASTER = 'pessoa.master@exemplo-cliente.com.br';

    before(async () => {
      const { rows } = await contexto.pool.query('SELECT id, cnpj FROM empresas WHERE cnpj IN ($1, $2)', [CNPJ_A, CNPJ_B]);
      empresaA = rows.find((e) => e.cnpj === CNPJ_A).id;
      empresaB = rows.find((e) => e.cnpj === CNPJ_B).id;
    });

    // Consulta pública: token SEMPRE em corpo JSON (item 1 da correção).
    const consultar = (token) => request(app).post('/api/plataforma/convite-master/consultar').send({ token });

    async function criarConvite(empresaId, email) {
      const r = await admin(request(app).post(`/api/plataforma/empresas/${empresaId}/convites-master`)).send({ email });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return { ...r.body, token: tokenDoLink(r.body.entrega.linkAceite) };
    }

    test('criar: 201 com entrega de DESENVOLVIMENTO (link com token); só o hash vai ao banco; auditoria da plataforma com quem convidou; duplicado pendente é 409', async () => {
      const { convite, entrega, token } = await criarConvite(empresaA, EMAIL_MASTER);
      assert.equal(entrega.modo, 'DESENVOLVIMENTO_SEM_EMAIL');
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(convite.situacao, 'PENDENTE');
      assert.equal(JSON.stringify(convite).includes(token), false, 'o token em claro nunca sai no objeto do convite');

      const { rows } = await contexto.pool.query('SELECT token_hash, criado_por, email_convite FROM convites_master WHERE id = $1', [convite.id]);
      assert.equal(rows[0].token_hash, sha256(token));
      assert.equal(rows[0].criado_por, administradorId);
      assert.equal(rows[0].email_convite, EMAIL_MASTER);

      const { rows: audit } = await contexto.pool.query("SELECT administrador_id, empresa_afetada_id, dados_novos FROM logs_auditoria_plataforma WHERE acao = 'CONVITE_MASTER_CRIADO' AND referencia = $1", [convite.id]);
      assert.equal(audit.length, 1);
      assert.equal(audit[0].administrador_id, administradorId);
      assert.equal(JSON.stringify(audit[0].dados_novos).includes(token), false);

      const duplicado = await admin(request(app).post(`/api/plataforma/empresas/${empresaA}/convites-master`)).send({ email: EMAIL_MASTER.toUpperCase() });
      assert.deepEqual([duplicado.status, duplicado.body.codigo], [409, 'CONVITE_JA_PENDENTE']);

      const lista = await admin(request(app).get(`/api/plataforma/empresas/${empresaA}/convites-master`));
      assert.equal(lista.status, 200);
      assert.equal(lista.body.convites.length, 1);
      const um = await admin(request(app).get(`/api/plataforma/convites-master/${empresaA}/${convite.id}`));
      assert.equal(um.body.convite.situacao, 'PENDENTE');
    });

    test('consulta pública pelo token: empresa, e-mail, prazo e se já existe identidade (não consome o convite)', async () => {
      const { token } = await criarConvite(empresaB, 'novo.master@exemplo-cliente.com.br');
      const r = await consultar(token);
      assert.equal(r.status, 200);
      assert.equal(r.body.situacao, 'PENDENTE');
      assert.equal(r.body.empresa.id, empresaB);
      assert.equal(r.body.identidadeExistente, false);
      assert.equal('token' in r.body, false);
    });

    test('token malformado ou desconhecido: 404 CONVITE_INVALIDO; o desconhecido conta como tentativa para o cooldown', async () => {
      const malformado = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token: 'abc', nome: 'X', senha: SENHA_MASTER });
      assert.equal(malformado.status, 400, 'formato é recusado pelo schema antes do serviço');
      const desconhecido = 'A'.repeat(43);
      const r = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token: desconhecido, nome: 'X', senha: SENHA_MASTER });
      assert.deepEqual([r.status, r.body.codigo], [404, 'CONVITE_INVALIDO']);
      const { rows } = await contexto.pool.query("SELECT count(*)::int AS total FROM convite_master_tentativas WHERE motivo = 'CONVITE_INEXISTENTE' AND convite_id IS NULL");
      assert.ok(rows[0].total >= 1);
    });

    test('aceite com identidade NOVA: identidade + vínculo MASTER na empresa certa nascem juntos; auditoria EMPRESARIAL atribuída ao novo usuário, nunca ao administrador; sem sessão emitida', async () => {
      const { rows: convites } = await contexto.pool.query('SELECT id FROM convites_master WHERE empresa_id = $1 AND email_convite = $2 AND aceito_em IS NULL', [empresaA, EMAIL_MASTER]);
      assert.equal(convites.length, 1);
      // Recupera o token: o teste anterior o obteve; aqui refazemos a criação numa empresa nova para ter o token em mãos.
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Empresa Aceite', $1) RETURNING id", [completarCnpj('777777770001')]);
      const empresaAceite = e[0].id;
      const { convite, token } = await criarConvite(empresaAceite, EMAIL_MASTER);

      const r = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'Pessoa Master', senha: SENHA_MASTER });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.identidadeCriada, true);
      assert.equal(r.body.empresa.id, empresaAceite);
      assert.equal(r.body.usuario.perfil, 'MASTER');
      assert.equal(r.headers['set-cookie'], undefined, 'o aceite não emite sessão: o login global é o Pacote 4');
      assert.equal(JSON.stringify(r.body).includes(token), false);

      const { rows: ident } = await contexto.pool.query('SELECT id, email, ativo FROM identidades WHERE lower(email) = $1', [EMAIL_MASTER]);
      assert.equal(ident.length, 1);
      const { rows: usuarios } = await contexto.pool.query('SELECT empresa_id, perfil, identidade_id, email, senha_hash, ativo FROM usuarios WHERE id = $1', [r.body.usuario.id]);
      assert.deepEqual(usuarios[0], { empresa_id: empresaAceite, perfil: 'MASTER', identidade_id: ident[0].id, email: null, senha_hash: null, ativo: true });

      const { rows: c } = await contexto.pool.query('SELECT aceito_em, identidade_id, usuario_id FROM convites_master WHERE id = $1', [convite.id]);
      assert.notEqual(c[0].aceito_em, null);
      assert.deepEqual([c[0].identidade_id, c[0].usuario_id], [ident[0].id, r.body.usuario.id]);

      const { rows: audit } = await contexto.pool.query("SELECT empresa_id, usuario_id FROM logs_auditoria WHERE acao = 'CONVITE_MASTER_ACEITO' AND referencia = $1", [convite.id]);
      assert.deepEqual(audit, [{ empresa_id: empresaAceite, usuario_id: r.body.usuario.id }]);
      const { rows: auditPlat } = await contexto.pool.query("SELECT count(*)::int AS total FROM logs_auditoria_plataforma WHERE acao = 'CONVITE_MASTER_ACEITO'");
      assert.equal(auditPlat[0].total, 0, 'o aceite não é ato do administrador da plataforma');

      // Uso único.
      const denovo = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'Pessoa Master', senha: SENHA_MASTER });
      assert.deepEqual([denovo.status, denovo.body.codigo], [409, 'CONVITE_JA_UTILIZADO']);

      // Isolamento: o vínculo existe SÓ na empresa do convite.
      const { rows: outras } = await contexto.pool.query('SELECT count(*)::int AS total FROM usuarios WHERE identidade_id = $1 AND empresa_id <> $2', [ident[0].id, empresaAceite]);
      assert.equal(outras[0].total, 0);
    });

    test('aceite com identidade EXISTENTE: exige a senha atual (errada -> 401 + tentativa registrada; certa -> vínculo na NOVA empresa ligado à MESMA identidade, nenhuma identidade nova)', async () => {
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Segunda Empresa', $1) RETURNING id", [completarCnpj('888888880001')]);
      const segunda = e[0].id;
      const { convite, token } = await criarConvite(segunda, EMAIL_MASTER);

      const consulta = await consultar(token);
      assert.equal(consulta.body.identidadeExistente, true);

      const errada = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'Pessoa Master', senha: 'senha-errada-qualquer' });
      assert.deepEqual([errada.status, errada.body.codigo], [401, 'CREDENCIAIS_INVALIDAS']);
      const { rows: tent } = await contexto.pool.query("SELECT motivo FROM convite_master_tentativas WHERE convite_id = $1 ORDER BY id DESC LIMIT 1", [convite.id]);
      assert.equal(tent[0].motivo, 'SENHA_INVALIDA');
      const { rows: semVinculo } = await contexto.pool.query('SELECT count(*)::int AS total FROM usuarios WHERE empresa_id = $1', [segunda]);
      assert.equal(semVinculo[0].total, 0, 'senha errada não cria vínculo nenhum');

      const certa = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'Pessoa Master', senha: SENHA_MASTER });
      assert.equal(certa.status, 201, JSON.stringify(certa.body));
      assert.equal(certa.body.identidadeCriada, false);
      const { rows: ident } = await contexto.pool.query('SELECT count(*)::int AS total FROM identidades WHERE lower(email) = $1', [EMAIL_MASTER]);
      assert.equal(ident[0].total, 1, 'nenhuma identidade nova');
      const { rows: vinculo } = await contexto.pool.query('SELECT empresa_id, perfil FROM usuarios WHERE id = $1', [certa.body.usuario.id]);
      assert.deepEqual(vinculo[0], { empresa_id: segunda, perfil: 'MASTER' });
    });

    test('cooldown: senhas erradas repetidas bloqueiam o aceite daquele token (429), mesmo com a senha correta', async () => {
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Terceira', $1) RETURNING id", [completarCnpj('999999990001')]);
      const { token } = await criarConvite(e[0].id, EMAIL_MASTER);
      for (let i = 0; i < authConfig.cooldown.niveis[0].falhas; i += 1) {
        const r = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'X', senha: 'senha-errada-qualquer' });
        assert.equal(r.status, 401);
      }
      const bloqueada = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'X', senha: SENHA_MASTER });
      assert.deepEqual([bloqueada.status, bloqueada.body.codigo], [429, 'CONVITE_EM_COOLDOWN']);
      assert.ok(Number(bloqueada.headers['retry-after']) > 0);
    });

    test('senha fora da política em identidade nova: 400 de validação com detalhe em body.senha; nada criado', async () => {
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Quarta', $1) RETURNING id", [completarCnpj('111111110001')]);
      const email = 'alguem.novo@exemplo-cliente.com.br';
      const { token } = await criarConvite(e[0].id, email);
      const r = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'Alguém', senha: '123' });
      assert.equal(r.status, 400);
      assert.ok(r.body.detalhes.every((d) => d.campo === 'body.senha'));
      const { rows } = await contexto.pool.query('SELECT count(*)::int AS total FROM identidades WHERE lower(email) = $1', [email]);
      assert.equal(rows[0].total, 0);
    });

    test('convite expirado: 409 CONVITE_EXPIRADO; convite cancelado: 409 CONVITE_CANCELADO e não pode ser cancelado de novo', async () => {
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Quinta', $1) RETURNING id", [completarCnpj('222222220001')]);
      const empresaId = e[0].id;

      const expirado = await criarConvite(empresaId, 'expira@exemplo-cliente.com.br');
      await contexto.pool.query("UPDATE convites_master SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 minute' WHERE id = $1", [expirado.convite.id]);
      const r1 = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token: expirado.token, nome: 'X', senha: SENHA_MASTER });
      assert.deepEqual([r1.status, r1.body.codigo], [409, 'CONVITE_EXPIRADO']);
      const situacao = await admin(request(app).get(`/api/plataforma/convites-master/${empresaId}/${expirado.convite.id}`));
      assert.equal(situacao.body.convite.situacao, 'EXPIRADO');

      const cancelado = await criarConvite(empresaId, 'cancela@exemplo-cliente.com.br');
      const c = await admin(request(app).post(`/api/plataforma/convites-master/${empresaId}/${cancelado.convite.id}/cancelar`)).send({});
      assert.deepEqual([c.status, c.body.convite.situacao], [200, 'CANCELADO']);
      const r2 = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token: cancelado.token, nome: 'X', senha: SENHA_MASTER });
      assert.deepEqual([r2.status, r2.body.codigo], [409, 'CONVITE_CANCELADO']);
      const c2 = await admin(request(app).post(`/api/plataforma/convites-master/${empresaId}/${cancelado.convite.id}/cancelar`)).send({});
      assert.deepEqual([c2.status, c2.body.codigo], [409, 'CONVITE_NAO_CANCELAVEL']);
      const { rows: audit } = await contexto.pool.query("SELECT administrador_id FROM logs_auditoria_plataforma WHERE acao = 'CONVITE_MASTER_CANCELADO' AND referencia = $1", [cancelado.convite.id]);
      assert.deepEqual(audit, [{ administrador_id: administradorId }]);
    });

    test('SIGILO (item 1): o token só existe no fragmento do link e no corpo JSON — nunca em query, console ou log, ao criar, consultar e aceitar', async (t) => {
      const logs = [];
      t.mock.method(console, 'log', (...a) => { logs.push(a); });
      t.mock.method(console, 'error', (...a) => { logs.push(a); });
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Sigilo', $1) RETURNING id", [completarCnpj('444444440001')]);
      const { entrega, token } = await criarConvite(e[0].id, 'sigilo@exemplo-cliente.com.br');
      const url = new URL(entrega.linkAceite);
      assert.equal(url.search, '', 'nenhuma query string no link');
      assert.equal(url.hash, `#token=${token}`);

      const c = await consultar(token);
      assert.equal(c.status, 200);
      const a = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'Sigilo', senha: SENHA_MASTER });
      assert.equal(a.status, 201, JSON.stringify(a.body));

      const texto = JSON.stringify(logs);
      assert.ok(logs.length > 0, 'houve registro no console (entrega de desenvolvimento)');
      assert.equal(texto.includes(token), false, 'o token nunca aparece em console.log/console.error');
      const { rows: audit } = await contexto.pool.query("SELECT contexto::text || coalesce(dados_novos::text,'') AS t FROM logs_auditoria_plataforma WHERE empresa_afetada_id = $1", [e[0].id]);
      assert.ok(audit.every((l) => !l.t.includes(token)), 'nem na auditoria');
    });

    test('CONCORRÊNCIA NA CRIAÇÃO (item 2): duas criações simultâneas para a mesma empresa e e-mail -> um 201 e um 409, um único convite pendente', async () => {
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Corrida', $1) RETURNING id", [completarCnpj('666666660001')]);
      const email = 'corrida@exemplo-cliente.com.br';
      const resultados = await Promise.all([
        admin(request(app).post(`/api/plataforma/empresas/${e[0].id}/convites-master`)).send({ email }),
        admin(request(app).post(`/api/plataforma/empresas/${e[0].id}/convites-master`)).send({ email }),
      ]);
      assert.deepEqual(resultados.map((r) => r.status).sort(), [201, 409], JSON.stringify(resultados.map((r) => r.body)));
      assert.equal(resultados.find((r) => r.status === 409).body.codigo, 'CONVITE_JA_PENDENTE');
      const { rows } = await contexto.pool.query('SELECT count(*)::int AS total FROM convites_master WHERE empresa_id = $1 AND lower(email_convite) = $2 AND aceito_em IS NULL AND cancelado_em IS NULL', [e[0].id, email]);
      assert.equal(rows[0].total, 1);
      const { rows: audit } = await contexto.pool.query("SELECT count(*)::int AS total FROM logs_auditoria_plataforma WHERE acao = 'CONVITE_MASTER_CRIADO' AND empresa_afetada_id = $1", [e[0].id]);
      assert.equal(audit[0].total, 1, 'só a criação vencedora é auditada');
    });

    test('PRODUÇÃO SEM E-MAIL (item 3): criação recusada com 503 antes de gravar — nenhum convite, nenhuma auditoria, nenhum token na resposta', async (t) => {
      const original = entregaConvite.exigirDisponivel;
      t.mock.method(entregaConvite, 'exigirDisponivel', () => original('production'));
      t.mock.method(console, 'error', () => {});
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Producao', $1) RETURNING id", [completarCnpj('123123120001')]);
      const r = await admin(request(app).post(`/api/plataforma/empresas/${e[0].id}/convites-master`)).send({ email: 'prod@exemplo-cliente.com.br' });
      assert.deepEqual([r.status, r.body.codigo], [503, 'CONVITE_ENTREGA_INDISPONIVEL']);
      assert.equal('entrega' in r.body, false);
      assert.equal(JSON.stringify(r.body).includes('token'), false);
      const { rows: convites } = await contexto.pool.query('SELECT count(*)::int AS total FROM convites_master WHERE empresa_id = $1', [e[0].id]);
      const { rows: audit } = await contexto.pool.query("SELECT count(*)::int AS total FROM logs_auditoria_plataforma WHERE acao = 'CONVITE_MASTER_CRIADO' AND empresa_afetada_id = $1", [e[0].id]);
      assert.deepEqual([convites[0].total, audit[0].total], [0, 0]);
    });

    test('EMPRESA INATIVA (item 4): ativa -> convite criado -> inativada -> consulta e aceite recusados -> nada criado; reativada -> aceite volta a funcionar', async () => {
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Suspensa', $1) RETURNING id", [completarCnpj('321321320001')]);
      const empresaId = e[0].id;
      const email = 'suspensa@exemplo-cliente.com.br';
      const { token } = await criarConvite(empresaId, email);

      const inativar = await admin(request(app).post(`/api/plataforma/empresas/${empresaId}/inativar`)).send({});
      assert.equal(inativar.status, 200);

      const consulta = await consultar(token);
      assert.deepEqual([consulta.status, consulta.body.codigo], [409, 'CONVITE_EMPRESA_INATIVA']);
      const aceite = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'X', senha: SENHA_MASTER });
      assert.deepEqual([aceite.status, aceite.body.codigo], [409, 'CONVITE_EMPRESA_INATIVA']);

      const { rows: ident } = await contexto.pool.query('SELECT count(*)::int AS total FROM identidades WHERE lower(email) = $1', [email]);
      const { rows: usu } = await contexto.pool.query('SELECT count(*)::int AS total FROM usuarios WHERE empresa_id = $1', [empresaId]);
      const { rows: conv } = await contexto.pool.query('SELECT aceito_em FROM convites_master WHERE empresa_id = $1', [empresaId]);
      assert.deepEqual([ident[0].total, usu[0].total, conv[0].aceito_em], [0, 0, null]);
      const { rows: tent } = await contexto.pool.query("SELECT count(*)::int AS total FROM convite_master_tentativas t JOIN convites_master c ON c.id = t.convite_id WHERE c.empresa_id = $1", [empresaId]);
      assert.equal(tent[0].total, 0, 'empresa inativa não é falha de credencial: não conta para o cooldown');

      await admin(request(app).post(`/api/plataforma/empresas/${empresaId}/reativar`)).send({});
      const depois = await request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'X', senha: SENHA_MASTER });
      assert.equal(depois.status, 201, JSON.stringify(depois.body));
    });

    test('convites concorrentes: duas aceitações simultâneas do MESMO token -> exatamente um 201 e um 409, um único vínculo', async () => {
      const { rows: e } = await contexto.pool.query("INSERT INTO empresas (nome, cnpj) VALUES ('Sexta', $1) RETURNING id", [completarCnpj('333333330001')]);
      const email = 'concorrente@exemplo-cliente.com.br';
      const { token } = await criarConvite(e[0].id, email);

      const resultados = await Promise.all([
        request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'A', senha: SENHA_MASTER }),
        request(app).post('/api/plataforma/convite-master/aceitar').send({ token, nome: 'B', senha: SENHA_MASTER }),
      ]);
      const status = resultados.map((r) => r.status).sort();
      assert.deepEqual(status, [201, 409], JSON.stringify(resultados.map((r) => r.body)));
      assert.equal(resultados.find((r) => r.status === 409).body.codigo, 'CONVITE_JA_UTILIZADO');

      const { rows } = await contexto.pool.query('SELECT count(*)::int AS total FROM usuarios WHERE empresa_id = $1', [e[0].id]);
      assert.equal(rows[0].total, 1);
      const { rows: ident } = await contexto.pool.query('SELECT count(*)::int AS total FROM identidades WHERE lower(email) = $1', [email]);
      assert.equal(ident[0].total, 1);
    });
  });
});
