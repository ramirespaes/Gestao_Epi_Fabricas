'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { todasAsMigrations } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario } = require('./helpers/solicitacao-epi-servico');
const { criarSolicitacao } = require('./helpers/solicitacao-epi');
const { sessaoDeTeste, CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * Atendimento Token — Etapa B (RED): backend de administração dos tablets. PostgreSQL real, schema temporário com TODAS as
 * migrations (086/087 incluídas); só o banco de teste. A sessão é a de teste (o usuário vem do cabeçalho; empresa e perfil,
 * da linha do usuário), como nos demais ambientes HTTP.
 *
 * Contrato da API (menor desenho, no padrão de tipo-material e ghe-importacao):
 *   GET   /api/atendimento-token/dispositivos            atendimentoToken.visualizar   ?pagina&limite (1..100, ordem por nome)
 *   GET   /api/atendimento-token/dispositivos/:id        atendimentoToken.visualizar
 *   POST  /api/atendimento-token/dispositivos            atendimentoToken.criar        { nome*, unidade?, setor?, localInstalacao?,
 *                                                                                        fabricante?, modelo?, numeroSerie? }
 *   PATCH /api/atendimento-token/dispositivos/:id        atendimentoToken.editar       os mesmos sete campos, ao menos um (null limpa)
 *   POST  /api/atendimento-token/dispositivos/:id/revogar  ação TOKEN_REVOGAR_DISPOSITIVO   corpo {}
 *   Respostas: { status:'ok', dispositivo } (201 no cadastro) | { dispositivos, total, pagina, limite } | { dispositivo, alterado }.
 *   dispositivo = { id, identificador, nome, unidade, setor, localInstalacao, fabricante, modelo, numeroSerie,
 *     situacao: PENDENTE|ATIVO|REVOGADO (DERIVADA dos carimbos), comunicacao: { registrada: null|ONLINE|OFFLINE, ultimoContatoEm },
 *     ativadoEm, revogadoEm, criadoPor, revogadoPor, criadoEm, atualizadoEm } — nunca hash, credencial nem código de ativação.
 *   Erros: 400 VALIDACAO; 401; 403 (sem permissão); 404 DISPOSITIVO_NAO_ENCONTRADO (inexistente = de outra empresa); 409
 *     DISPOSITIVO_NOME_EM_USO | DISPOSITIVO_NUMERO_SERIE_EM_USO | DISPOSITIVO_REVOGADO.
 *   Empresa e autoria SEMPRE da sessão; corpo estrito recusa empresaId, criadoPor, revogadoPor, identificador, credencial,
 *   ativadoEm, revogadoEm, situacao, comunicação etc. Revogar: carimba revogado_em/revogado_por, ZERA a credencial, cancela a
 *   ativação pendente e encerra o atendimento aberto (DISPOSITIVO_REVOGADO); repetir é idempotente (200, alterado:false).
 *   Auditoria (logs_auditoria, sem segredo): TOKEN_DISPOSITIVO_CADASTRADO | _ALTERADO (dados_anteriores/dados_novos só com os
 *   campos que mudaram — é onde o histórico de localização guarda os VALORES) | _REVOGADO; e um evento em
 *   token_dispositivo_eventos (CADASTRO | ALTERACAO | REVOGACAO) com o usuário e o instante, que não guarda valores.
 *   DECISÕES PROPOSTAS ainda abertas (documentadas no relatório): dispositivo REVOGADO é somente leitura (PATCH → 409); só `nome`
 *   é obrigatório (como na 086).
 *
 * Enquanto as rotas não existirem, cada teste falha por asserção (404 no lugar do status esperado).
 */

const RAIZ = '/api/atendimento-token/dispositivos';
const CHAVES_DO_DISPOSITIVO = ['ativadoEm', 'atualizadoEm', 'comunicacao', 'criadoEm', 'criadoPor', 'fabricante', 'id', 'identificador', 'localInstalacao',
  'modelo', 'nome', 'numeroSerie', 'revogadoEm', 'revogadoPor', 'setor', 'situacao', 'unidade'];
const CAMPOS_EDITAVEIS = ['nome', 'unidade', 'setor', 'localInstalacao', 'fabricante', 'modelo', 'numeroSerie'];
const SEGREDO = /hash|credencial|senha|segredo|codigo_?ativacao|token_?hash/i;
const HEX64 = /\b[0-9a-f]{64}\b/i;
const hash = () => crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex');

function carregarModulos() {
  try {
    return {
      rotas: require('../../src/routes/token-dispositivo.routes'),
      controller: require('../../src/controllers/token-dispositivo.controller'),
    };
  } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && /token-dispositivo/.test(erro.message)) return null;
    throw erro;
  }
}

/** Todas as chaves (em qualquer profundidade) de um valor JSON. */
function chavesDe(valor, acumulado = []) {
  if (Array.isArray(valor)) valor.forEach((x) => chavesDe(x, acumulado));
  else if (valor !== null && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) { acumulado.push(k); chavesDe(v, acumulado); }
  }
  return acumulado;
}

describe('Atendimento Token — B: administração dos dispositivos (PostgreSQL real)', () => {
  let ctx;
  let d;
  let app;
  let seq = 0;

  const q = (sql, parametros = []) => ctx.pool.query(sql, parametros);
  const unico = (prefixo) => { seq += 1; return `${prefixo} ${seq}`; };
  const como = (usuarioId) => ({
    get: (url) => request(app).get(url).set(CABECALHO, String(usuarioId)),
    post: (url, corpo = {}) => request(app).post(url).set(CABECALHO, String(usuarioId)).send(corpo),
    patch: (url, corpo = {}) => request(app).patch(url).set(CABECALHO, String(usuarioId)).send(corpo),
  });
  const masterDe = (empresaId) => (empresaId === d.empresaA ? d.master : d.masterB);

  /** Usuário comum com permissões individuais explícitas (recurso atendimentoToken e/ou ações). */
  async function usuario(empresaId, { perfil = 'USUARIO', operacoes = [], acoes = [] } = {}) {
    const id = await inserirUsuario(ctx.pool, empresaId, `${unico('tablet-rbac')}@example.invalid`.replace(/ /g, '-'), perfil);
    if (operacoes.length > 0) {
      await q(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, 'atendimentoToken', $3, $4, $5, false, $6)`,
        [empresaId, id, operacoes.includes('visualizar'), operacoes.includes('criar'), operacoes.includes('editar'), masterDe(empresaId)],
      );
    }
    for (const acao of acoes) {
      await q('INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)', [empresaId, id, acao, masterDe(empresaId)]);
    }
    return id;
  }

  /** Dispositivo direto no banco (os testes de consulta, edição e revogação não dependem do cadastro por API). */
  async function dispositivo(empresaId, extra = {}) {
    const valores = { empresa_id: empresaId, nome: unico('Tablet'), criado_por: masterDe(empresaId), ...extra };
    const colunas = Object.keys(valores);
    const { rows } = await q(`INSERT INTO token_dispositivos (${colunas.join(', ')}) VALUES (${colunas.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(valores));
    return rows[0];
  }
  async function ativar(id) {
    const credencial = hash();
    await q('UPDATE token_dispositivos SET ativado_em = now(), credencial_hash = $1, credencial_anterior_hash = $2, credencial_emitida_em = now() WHERE id = $3', [credencial, hash(), id]);
    return credencial;
  }
  const linha = async (id) => (await q('SELECT * FROM token_dispositivos WHERE id = $1', [id])).rows[0];
  const auditorias = async (acao, empresaId = d.empresaA) => (await q(
    'SELECT usuario_id, referencia, contexto, dados_anteriores, dados_novos, empresa_id FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 ORDER BY id', [empresaId, acao],
  )).rows;
  const eventos = async (dispositivoId, tipo) => (await q(
    'SELECT usuario_id, empresa_id, ocorrido_em FROM token_dispositivo_eventos WHERE dispositivo_id = $1 AND tipo = $2 ORDER BY id', [dispositivoId, tipo],
  )).rows;
  const totalDeDispositivos = async (empresaId) => (await q('SELECT count(*)::int AS n FROM token_dispositivos WHERE empresa_id = $1', [empresaId])).rows[0].n;
  const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
  const codigo = (r) => r.body.codigo;
  const semSegredo = (corpo, rotulo, ocultos = []) => {
    const texto = JSON.stringify(corpo);
    assert.deepEqual(chavesDe(corpo).filter((k) => SEGREDO.test(k)), [], `${rotulo}: chave de segredo na resposta`);
    assert.equal(HEX64.test(texto), false, `${rotulo}: hash em hexadecimal na resposta`);
    for (const oculto of ocultos) assert.equal(texto.includes(oculto), false, `${rotulo}: valor secreto na resposta`);
  };

  let admin; let gestorA; let gestorB; let exigirSessao;
  before(async () => {
    ctx = await abrirPoolTemporario(todasAsMigrations());
    d = await montarMundoDoServico(ctx.pool);
    exigirSessao = sessaoDeTeste(ctx.pool);
    const modulos = carregarModulos();
    app = criarAppTeste((a) => {
      if (modulos) a.use('/api', modulos.rotas.criarTokenDispositivoRoutes({ controller: modulos.controller.criarTokenDispositivoController({ pool: ctx.pool }), exigirSessao, pool: ctx.pool }));
    });
    // Quem administra: as quatro permissões da Etapa B (visualizar, criar, editar e a ação de revogar), por concessão individual.
    gestorA = await usuario(d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO'] });
    gestorB = await usuario(d.empresaB, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO'] });
    admin = await usuario(d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO'] });
  });
  after(async () => { if (ctx) await ctx.encerrar(); });

  // ───────────── controles do ambiente (usam só o que JÁ existe; passam já no RED e não contam como RED) ─────────────
  // Provam que fixtures, concessões e o MASTER sem provisionamento se comportam como os testes abaixo presumem; assim, uma
  // falha futura nunca é defeito do ambiente de teste.
  describe('controles do ambiente (devem passar já no RED)', () => {
    test('K1 — as seis tabelas da 086 e as seis ações da 087 existem no schema temporário; as fixtures de dispositivo, ativação e atendimento gravam', async () => {
      for (const tabela of ['token_dispositivos', 'token_ativacoes', 'token_atendimentos', 'token_redes_autorizadas', 'token_dispositivo_eventos', 'solicitacoes_autoatendimento']) {
        assert.equal((await q('SELECT to_regclass($1) IS NOT NULL AS existe', [tabela])).rows[0].existe, true, tabela);
      }
      assert.equal((await q("SELECT count(*)::int AS n FROM acoes WHERE codigo LIKE 'TOKEN\\_%'")).rows[0].n, 6);
      const x = await dispositivo(d.empresaA, { nome: unico('Controle') });
      assert.deepEqual([x.empresa_id, x.criado_por, x.ativado_em, x.revogado_em], [d.empresaA, d.master, null, null]);
      assert.equal((await ativar(x.id)).length, 64);
    });

    test('K2 — a concessão individual das fixtures vale para as funções de decisão de produção (recurso e ação); quem não tem nada, não tem', async () => {
      const { avaliarPermissaoRecurso, avaliarPermissaoAcao } = require('../../src/middleware/autorizacao');
      const contexto = (id) => ({ empresaId: d.empresaA, usuarioId: id, perfil: 'USUARIO' });
      const semNada = await usuario(d.empresaA);
      const soLer = await usuario(d.empresaA, { operacoes: ['visualizar'] });
      assert.deepEqual(await avaliarPermissaoRecurso(ctx.pool, contexto(gestorA), 'atendimentoToken'), { visualizar: true, criar: true, editar: true, excluir: false });
      assert.deepEqual(await avaliarPermissaoRecurso(ctx.pool, contexto(soLer), 'atendimentoToken'), { visualizar: true, criar: false, editar: false, excluir: false });
      assert.deepEqual(await avaliarPermissaoRecurso(ctx.pool, contexto(semNada), 'atendimentoToken'), { visualizar: false, criar: false, editar: false, excluir: false });
      assert.equal(await avaliarPermissaoAcao(ctx.pool, contexto(gestorA), 'TOKEN_REVOGAR_DISPOSITIVO'), true);
      assert.equal(await avaliarPermissaoAcao(ctx.pool, contexto(soLer), 'TOKEN_REVOGAR_DISPOSITIVO'), false);
      assert.equal(await avaliarPermissaoAcao(ctx.pool, contexto(semNada), 'TOKEN_REVOGAR_DISPOSITIVO'), false);
    });

    test('K3 — o MASTER decide SÓ pelo perfil: sem provisionamento não tem o recurso nem a ação (por isso a Etapa B precisa do escopo)', async () => {
      const { avaliarPermissaoRecurso, avaliarPermissaoAcao } = require('../../src/middleware/autorizacao');
      const master = { empresaId: d.empresaA, usuarioId: d.master, perfil: 'MASTER' };
      assert.deepEqual(await avaliarPermissaoRecurso(ctx.pool, master, 'atendimentoToken'), { visualizar: false, criar: false, editar: false, excluir: false });
      assert.equal(await avaliarPermissaoAcao(ctx.pool, master, 'TOKEN_REVOGAR_DISPOSITIVO'), false);
      assert.equal((await q("SELECT count(*)::int AS n FROM permissoes_acao WHERE acao_codigo LIKE 'TOKEN\\_%'")).rows[0].n, 0, 'a 087 não concede a ninguém');
    });
  });

  // ───────────────────────── 4.1 cadastro ─────────────────────────
  describe('cadastro', () => {
    test('C1 — cadastra na empresa da SESSÃO, com a autoria da sessão; nasce PENDENTE, sem comunicação; só as chaves do contrato', async () => {
      const r = await como(gestorA).post(RAIZ, { nome: 'Tablet Expedição', unidade: 'Fábrica 1', setor: 'Expedição', localInstalacao: 'Portaria norte', fabricante: 'Samsung', modelo: 'Tab A9', numeroSerie: 'SN-9001' });
      assert.equal(r.status, 201, aviso(r));
      const x = r.body.dispositivo;
      assert.deepEqual(Object.keys(x).sort(), CHAVES_DO_DISPOSITIVO);
      assert.deepEqual([x.nome, x.unidade, x.setor, x.localInstalacao, x.fabricante, x.modelo, x.numeroSerie],
        ['Tablet Expedição', 'Fábrica 1', 'Expedição', 'Portaria norte', 'Samsung', 'Tab A9', 'SN-9001']);
      assert.equal(x.situacao, 'PENDENTE');
      assert.deepEqual(x.comunicacao, { registrada: null, ultimoContatoEm: null });
      assert.match(x.identificador, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const gravado = await linha(x.id);
      assert.deepEqual([gravado.empresa_id, gravado.criado_por, gravado.ativado_em, gravado.revogado_em, gravado.credencial_hash], [d.empresaA, gestorA, null, null, null]);
      assert.equal(x.criadoPor, gestorA);
    });

    test('C2 — só o nome é obrigatório (como na migration 086); sem nome, em branco ou ausente, é 400 e nada é gravado', async () => {
      const antes = await totalDeDispositivos(d.empresaA);
      const minimo = await como(gestorA).post(RAIZ, { nome: unico('Só nome') });
      assert.equal(minimo.status, 201, aviso(minimo));
      assert.deepEqual([minimo.body.dispositivo.unidade, minimo.body.dispositivo.setor, minimo.body.dispositivo.localInstalacao,
        minimo.body.dispositivo.fabricante, minimo.body.dispositivo.modelo, minimo.body.dispositivo.numeroSerie], [null, null, null, null, null, null]);
      for (const corpo of [{}, { nome: '' }, { nome: '   ' }, { setor: 'Expedição' }]) {
        const r = await como(gestorA).post(RAIZ, corpo);
        assert.equal(r.status, 400, `${JSON.stringify(corpo)} → ${aviso(r)}`);
        assert.equal(codigo(r), 'VALIDACAO');
      }
      assert.equal(await totalDeDispositivos(d.empresaA), antes + 1);
    });

    test('C3 — textos aparados; opcional em branco vira nulo; acima do limite ou com caractere de controle é 400', async () => {
      const nomeLimpo = unico('Aparado');
      const aparado = await como(gestorA).post(RAIZ, { nome: `  ${nomeLimpo}  `, fabricante: '  Samsung  ', modelo: '   ', numeroSerie: ' ', setor: ' Expedição ' });
      assert.equal(aparado.status, 201, aviso(aparado));
      const x = aparado.body.dispositivo;
      assert.equal(x.nome, nomeLimpo);
      assert.deepEqual([x.fabricante, x.modelo, x.numeroSerie, x.setor], ['Samsung', null, null, 'Expedição']);
      const invalidos = [{ nome: 'n'.repeat(101) }, { nome: unico('Longo'), fabricante: 'f'.repeat(101) }, { nome: unico('Longo'), modelo: 'm'.repeat(101) },
        { nome: unico('Longo'), numeroSerie: 's'.repeat(101) }, { nome: unico('Longo'), unidade: 'u'.repeat(101) }, { nome: unico('Longo'), setor: 's'.repeat(101) },
        { nome: unico('Longo'), localInstalacao: 'l'.repeat(151) }, { nome: 'Tablet\u0000X' }, { nome: unico('Controle'), setor: 'Expe\ndição' }, { nome: 123 }];
      for (const corpo of invalidos) {
        const r = await como(gestorA).post(RAIZ, corpo);
        assert.equal(r.status, 400, `${JSON.stringify(corpo).slice(0, 60)} → ${aviso(r)}`);
        assert.equal(codigo(r), 'VALIDACAO');
      }
      assert.equal((await como(gestorA).post(RAIZ, { nome: 'n'.repeat(100) })).status, 201, '100 caracteres cabem');
    });

    test('C4 — nome duplicado na mesma empresa (sem diferenciar caixa nem espaços das pontas) é 409; em outra empresa pode repetir', async () => {
      const nome = unico('Tablet Duplo');
      assert.equal((await como(gestorA).post(RAIZ, { nome })).status, 201);
      for (const repetido of [nome, nome.toUpperCase(), `  ${nome.toLowerCase()} `]) {
        const r = await como(gestorA).post(RAIZ, { nome: repetido });
        assert.equal(r.status, 409, `${repetido} → ${aviso(r)}`);
        assert.equal(codigo(r), 'DISPOSITIVO_NOME_EM_USO');
      }
      assert.equal((await como(gestorB).post(RAIZ, { nome })).status, 201, 'a empresa B pode usar o mesmo nome');
    });

    test('C5 — número de série duplicado na empresa é 409; vários sem série valem; outra empresa pode repetir a série', async () => {
      const serie = unico('SN-DUP').replace(' ', '-');
      assert.equal((await como(gestorA).post(RAIZ, { nome: unico('Com série'), numeroSerie: serie })).status, 201);
      const r = await como(gestorA).post(RAIZ, { nome: unico('Outra série'), numeroSerie: serie });
      assert.equal(r.status, 409, aviso(r));
      assert.equal(codigo(r), 'DISPOSITIVO_NUMERO_SERIE_EM_USO');
      assert.equal((await como(gestorA).post(RAIZ, { nome: unico('Sem série 1') })).status, 201);
      assert.equal((await como(gestorA).post(RAIZ, { nome: unico('Sem série 2') })).status, 201);
      assert.equal((await como(gestorB).post(RAIZ, { nome: unico('Série na B'), numeroSerie: serie })).status, 201);
    });

    test('C6 — o cliente NUNCA determina empresa nem autoria: cada campo de autoridade, credencial ou estado é 400 e nada é gravado', async () => {
      const antesA = await totalDeDispositivos(d.empresaA);
      const antesB = await totalDeDispositivos(d.empresaB);
      const proibidos = { empresaId: d.empresaB, empresa_id: d.empresaB, criadoPor: d.master, criado_por: d.master, revogadoPor: d.master, identificador: crypto.randomUUID(),
        credencialHash: hash(), credencial_hash: hash(), ativadoEm: new Date().toISOString(), revogadoEm: new Date().toISOString(), situacao: 'ATIVO', id: 9999,
        comunicacaoRegistrada: 'ONLINE', ultimoContatoEm: new Date().toISOString(), criadoEm: new Date().toISOString() };
      for (const [campo, valor] of Object.entries(proibidos)) {
        const r = await como(gestorA).post(RAIZ, { nome: unico('Manipulado'), [campo]: valor });
        assert.equal(r.status, 400, `${campo} → ${aviso(r)}`);
        assert.equal(codigo(r), 'VALIDACAO', campo);
      }
      assert.equal(await totalDeDispositivos(d.empresaA), antesA);
      assert.equal(await totalDeDispositivos(d.empresaB), antesB);
    });

    test('C7 — auditoria do cadastro: uma linha com o usuário e a empresa da sessão, mais o evento CADASTRO; recusa não audita; sem segredo', async () => {
      const antes = (await auditorias('TOKEN_DISPOSITIVO_CADASTRADO')).length;
      const nome = unico('Tablet Auditado');
      const r = await como(gestorA).post(RAIZ, { nome, numeroSerie: unico('SN-AUD').replace(' ', '-') });
      assert.equal(r.status, 201, aviso(r));
      const registros = await auditorias('TOKEN_DISPOSITIVO_CADASTRADO');
      assert.equal(registros.length, antes + 1);
      const ultimo = registros.at(-1);
      assert.deepEqual([ultimo.usuario_id, ultimo.empresa_id, ultimo.referencia], [gestorA, d.empresaA, String(r.body.dispositivo.id)]);
      semSegredo(ultimo, 'auditoria do cadastro');
      const eventosCadastro = await eventos(r.body.dispositivo.id, 'CADASTRO');
      assert.deepEqual(eventosCadastro.map((e) => [e.usuario_id, e.empresa_id]), [[gestorA, d.empresaA]]);
      const recusado = await como(gestorA).post(RAIZ, { nome });
      assert.equal(recusado.status, 409);
      assert.equal((await auditorias('TOKEN_DISPOSITIVO_CADASTRADO')).length, antes + 1, 'o cadastro recusado não audita');
    });
  });

  // ───────────────────────── 4.2 consulta ─────────────────────────
  describe('consulta', () => {
    test('Q1 — lista SÓ os dispositivos da empresa da sessão, por nome, com total e paginação; limite fora de 1..100 é 400', async () => {
      const prefixo = unico('Lista');
      const nomes = [`${prefixo} C`, `${prefixo} A`, `${prefixo} B`];
      for (const nome of nomes) await dispositivo(d.empresaA, { nome });
      const daB = await dispositivo(d.empresaB, { nome: `${prefixo} DA B` });
      const r = await como(gestorA).get(`${RAIZ}?limite=100`);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(Object.keys(r.body).sort(), ['dispositivos', 'limite', 'pagina', 'status', 'total']);
      const doPrefixo = r.body.dispositivos.filter((x) => x.nome.startsWith(prefixo));
      assert.deepEqual(doPrefixo.map((x) => x.nome), [`${prefixo} A`, `${prefixo} B`, `${prefixo} C`], 'ordem por nome, sem o da outra empresa');
      assert.equal(r.body.dispositivos.some((x) => x.id === daB.id), false, 'vazou dispositivo de outra empresa');
      assert.equal(r.body.total, await totalDeDispositivos(d.empresaA));
      for (const x of r.body.dispositivos) assert.deepEqual(Object.keys(x).sort(), CHAVES_DO_DISPOSITIVO);
      const pagina2 = await como(gestorA).get(`${RAIZ}?limite=2&pagina=2`);
      assert.equal(pagina2.status, 200, aviso(pagina2));
      assert.deepEqual([pagina2.body.pagina, pagina2.body.limite, pagina2.body.dispositivos.length], [2, 2, 2]);
      for (const consulta of ['limite=0', 'limite=101', 'pagina=0', 'pagina=abc', 'situacao=ATIVO']) {
        assert.equal((await como(gestorA).get(`${RAIZ}?${consulta}`)).status, 400, consulta);
      }
    });

    test('Q2 — consulta por id; o de OUTRA empresa responde exatamente como o inexistente (404 DISPOSITIVO_NAO_ENCONTRADO); id inválido é 400', async () => {
      const meu = await dispositivo(d.empresaA, { nome: unico('Meu') });
      const dele = await dispositivo(d.empresaB, { nome: unico('Dele') });
      const ok = await como(gestorA).get(`${RAIZ}/${meu.id}`);
      assert.equal(ok.status, 200, aviso(ok));
      assert.deepEqual(Object.keys(ok.body.dispositivo).sort(), CHAVES_DO_DISPOSITIVO);
      assert.equal(ok.body.dispositivo.id, meu.id);
      const alheio = await como(gestorA).get(`${RAIZ}/${dele.id}`);
      const inexistente = await como(gestorA).get(`${RAIZ}/999999`);
      assert.equal(alheio.status, 404, aviso(alheio));
      assert.deepEqual([alheio.status, alheio.body], [inexistente.status, inexistente.body], 'o de outra empresa não pode ser distinguido do inexistente');
      assert.equal(codigo(alheio), 'DISPOSITIVO_NAO_ENCONTRADO');
      for (const id of ['abc', '0', '-1', '1.5']) assert.equal((await como(gestorA).get(`${RAIZ}/${id}`)).status, 400, id);
    });

    test('Q3 — a situação administrativa é DERIVADA dos carimbos e a comunicação ONLINE/OFFLINE vem SEPARADA, nunca misturada', async () => {
      const pendente = await dispositivo(d.empresaA, { nome: unico('Pendente') });
      const ativo = await dispositivo(d.empresaA, { nome: unico('Ativo') });
      await ativar(ativo.id);
      await q("UPDATE token_dispositivos SET comunicacao_registrada = 'ONLINE', ultimo_contato_em = now() WHERE id = $1", [ativo.id]);
      const revogado = await dispositivo(d.empresaA, { nome: unico('Revogado') });
      await q("UPDATE token_dispositivos SET comunicacao_registrada = 'OFFLINE', ultimo_contato_em = now() - interval '1 hour', revogado_em = now(), revogado_por = $2 WHERE id = $1", [revogado.id, d.master]);
      const leitura = async (x) => (await como(gestorA).get(`${RAIZ}/${x.id}`)).body.dispositivo;
      const p = await leitura(pendente);
      const a = await leitura(ativo);
      const v = await leitura(revogado);
      assert.deepEqual([p?.situacao, a?.situacao, v?.situacao], ['PENDENTE', 'ATIVO', 'REVOGADO']);
      assert.deepEqual(p.comunicacao, { registrada: null, ultimoContatoEm: null });
      assert.equal(a.comunicacao.registrada, 'ONLINE');
      assert.match(a.comunicacao.ultimoContatoEm, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(v.comunicacao.registrada, 'OFFLINE', 'a comunicação registrada não muda a situação administrativa');
      assert.equal(v.situacao, 'REVOGADO');
      for (const x of [p, a, v]) assert.equal(['ONLINE', 'OFFLINE'].includes(x.situacao), false, 'situação administrativa não é comunicação');
      assert.ok(a.ativadoEm && !a.revogadoEm && v.revogadoEm && !p.ativadoEm, 'carimbos coerentes com a situação');
    });

    test('Q4 — nenhuma resposta (lista, detalhe, cadastro, edição, revogação) expõe hash, credencial ou código de ativação', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Segredos') });
      const credencial = await ativar(x.id);
      const gravado = await linha(x.id);
      const codigoAtivacao = hash();
      const ocultos = [credencial, gravado.credencial_anterior_hash, codigoAtivacao];
      const detalhe = await como(gestorA).get(`${RAIZ}/${x.id}`);
      const lista = await como(gestorA).get(`${RAIZ}?limite=100`);
      assert.equal(detalhe.status, 200, aviso(detalhe));
      assert.equal(lista.status, 200, aviso(lista));
      semSegredo(detalhe.body, 'detalhe', ocultos);
      semSegredo(lista.body, 'lista', ocultos);
      const criado = await como(gestorA).post(RAIZ, { nome: unico('Novo sem segredo') });
      semSegredo(criado.body, 'cadastro');
      const editado = await como(gestorA).patch(`${RAIZ}/${x.id}`, { setor: 'Qualidade' });
      semSegredo(editado.body, 'edição', ocultos);
      const revogado = await como(gestorA).post(`${RAIZ}/${x.id}/revogar`);
      semSegredo(revogado.body, 'revogação', ocultos);
      assert.equal([detalhe, criado, editado, revogado].every((r) => r.status === 200 || r.status === 201), true, 'premissa: as quatro operações deram certo');
    });
  });

  // ───────────────────────── 4.3 edição ─────────────────────────
  describe('edição', () => {
    test('E1 — edita os campos administrativos; preserva identificador, empresa, autoria e credencial; devolve alterado:true', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Editável'), unidade: 'Fábrica 1', setor: 'Expedição', local_instalacao: 'Portaria norte', fabricante: 'Samsung', modelo: 'Tab A', numero_serie: unico('SN-ED').replace(' ', '-') });
      await ativar(x.id);
      const antes = await linha(x.id);
      const novo = { nome: unico('Editado'), unidade: 'Fábrica 2', setor: 'Almoxarifado', localInstalacao: 'Doca 3', fabricante: 'Lenovo', modelo: 'Tab M10', numeroSerie: unico('SN-NOVA').replace(' ', '-') };
      const r = await como(admin).patch(`${RAIZ}/${x.id}`, novo);
      assert.equal(r.status, 200, aviso(r));
      assert.equal(r.body.alterado, true);
      assert.deepEqual(CAMPOS_EDITAVEIS.map((c) => r.body.dispositivo[c]), CAMPOS_EDITAVEIS.map((c) => novo[c]));
      const depois = await linha(x.id);
      for (const coluna of ['identificador', 'empresa_id', 'criado_por', 'criado_em', 'credencial_hash', 'credencial_anterior_hash', 'credencial_emitida_em', 'ativado_em', 'revogado_em', 'revogado_por', 'comunicacao_registrada']) {
        assert.deepEqual(depois[coluna], antes[coluna], `${coluna} não pode mudar na edição`);
      }
      assert.deepEqual([depois.nome, depois.unidade, depois.setor, depois.local_instalacao, depois.fabricante, depois.modelo, depois.numero_serie],
        [novo.nome, novo.unidade, novo.setor, novo.localInstalacao, novo.fabricante, novo.modelo, novo.numeroSerie]);
    });

    test('E2 — edição parcial; null limpa um opcional; corpo vazio é 400; os mesmos valores dão alterado:false sem auditoria nem evento', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Parcial'), setor: 'Expedição', fabricante: 'Samsung' });
      const parcial = await como(admin).patch(`${RAIZ}/${x.id}`, { setor: 'Qualidade' });
      assert.equal(parcial.status, 200, aviso(parcial));
      assert.deepEqual([parcial.body.dispositivo.setor, parcial.body.dispositivo.fabricante, parcial.body.dispositivo.nome], ['Qualidade', 'Samsung', x.nome]);
      const limpa = await como(admin).patch(`${RAIZ}/${x.id}`, { fabricante: null });
      assert.equal(limpa.status, 200, aviso(limpa));
      assert.equal(limpa.body.dispositivo.fabricante, null);
      assert.equal((await como(admin).patch(`${RAIZ}/${x.id}`, { nome: null })).status, 400, 'o nome não pode ser limpo');
      assert.equal((await como(admin).patch(`${RAIZ}/${x.id}`, {})).status, 400, 'corpo vazio');
      const auditoriasAntes = (await auditorias('TOKEN_DISPOSITIVO_ALTERADO')).length;
      const eventosAntes = (await eventos(x.id, 'ALTERACAO')).length;
      const igual = await como(admin).patch(`${RAIZ}/${x.id}`, { setor: 'Qualidade', nome: x.nome });
      assert.equal(igual.status, 200, aviso(igual));
      assert.equal(igual.body.alterado, false);
      assert.equal((await auditorias('TOKEN_DISPOSITIVO_ALTERADO')).length, auditoriasAntes, 'sem mudança, sem auditoria');
      assert.equal((await eventos(x.id, 'ALTERACAO')).length, eventosAntes, 'sem mudança, sem evento');
    });

    test('E3 — nenhum campo de autoridade, credencial, situação ou autoria é aceito na edição: 400 e o registro fica intacto', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Intocável'), setor: 'Expedição' });
      const antes = await linha(x.id);
      const proibidos = { empresaId: d.empresaB, criadoPor: d.master2, revogadoPor: d.master, identificador: crypto.randomUUID(), credencialHash: hash(), ativadoEm: new Date().toISOString(),
        revogadoEm: new Date().toISOString(), situacao: 'ATIVO', id: 12345, comunicacaoRegistrada: 'ONLINE', ultimoContatoEm: new Date().toISOString(), criadoEm: new Date().toISOString() };
      for (const [campo, valor] of Object.entries(proibidos)) {
        const r = await como(admin).patch(`${RAIZ}/${x.id}`, { setor: 'Mudou', [campo]: valor });
        assert.equal(r.status, 400, `${campo} → ${aviso(r)}`);
        assert.equal(codigo(r), 'VALIDACAO', campo);
      }
      assert.deepEqual(await linha(x.id), antes);
    });

    test('E4 — conflitos de nome e de série com OUTRO dispositivo da empresa são 409; mudar só a caixa do próprio nome vale; outra empresa não conflita', async () => {
      const a = await dispositivo(d.empresaA, { nome: unico('Conflito A'), numero_serie: unico('SN-CA').replace(' ', '-') });
      const b = await dispositivo(d.empresaA, { nome: unico('Conflito B'), numero_serie: unico('SN-CB').replace(' ', '-') });
      const outraEmpresa = await dispositivo(d.empresaB, { nome: unico('Conflito Z'), numero_serie: unico('SN-CZ').replace(' ', '-') });
      const nome = await como(admin).patch(`${RAIZ}/${b.id}`, { nome: a.nome.toUpperCase() });
      assert.equal(nome.status, 409, aviso(nome));
      assert.equal(codigo(nome), 'DISPOSITIVO_NOME_EM_USO');
      const serie = await como(admin).patch(`${RAIZ}/${b.id}`, { numeroSerie: a.numero_serie });
      assert.equal(serie.status, 409, aviso(serie));
      assert.equal(codigo(serie), 'DISPOSITIVO_NUMERO_SERIE_EM_USO');
      const propria = await como(admin).patch(`${RAIZ}/${b.id}`, { nome: b.nome.toUpperCase() });
      assert.equal(propria.status, 200, aviso(propria));
      const daOutra = await como(admin).patch(`${RAIZ}/${b.id}`, { nome: outraEmpresa.nome, numeroSerie: outraEmpresa.numero_serie });
      assert.equal(daOutra.status, 200, aviso(daOutra));
    });

    test('E5 — editar o de outra empresa ou o inexistente é 404 idêntico; o registro alheio não muda', async () => {
      const dele = await dispositivo(d.empresaB, { nome: unico('Alheio'), setor: 'Original' });
      const alheio = await como(admin).patch(`${RAIZ}/${dele.id}`, { setor: 'Invadido' });
      const inexistente = await como(admin).patch(`${RAIZ}/999999`, { setor: 'Invadido' });
      assert.equal(alheio.status, 404, aviso(alheio));
      assert.equal(codigo(alheio), 'DISPOSITIVO_NAO_ENCONTRADO', 'o 404 é do domínio (dispositivo), não de rota inexistente');
      assert.deepEqual([alheio.status, alheio.body], [inexistente.status, inexistente.body]);
      assert.equal((await linha(dele.id)).setor, 'Original');
    });

    test('E6 — dispositivo REVOGADO é somente leitura (decisão proposta): editar é 409 DISPOSITIVO_REVOGADO e nada muda', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Aposentado'), setor: 'Expedição' });
      await q('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $2 WHERE id = $1', [x.id, d.master]);
      const antes = await linha(x.id);
      const r = await como(admin).patch(`${RAIZ}/${x.id}`, { setor: 'Qualidade' });
      assert.equal(r.status, 409, aviso(r));
      assert.equal(codigo(r), 'DISPOSITIVO_REVOGADO');
      assert.deepEqual(await linha(x.id), antes);
      assert.equal((await como(admin).get(`${RAIZ}/${x.id}`)).status, 200, 'a consulta do revogado continua permitida');
    });

    test('E7 — histórico de LOCALIZAÇÃO: cada mudança audita valores anteriores e novos (só o que mudou), o usuário, a empresa e o instante; evento ALTERACAO por mudança', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Histórico'), unidade: 'Fábrica 1', setor: 'Expedição', local_instalacao: 'Portaria norte' });
      const segundo = await usuario(d.empresaA, { operacoes: ['visualizar', 'editar'] });
      const antes = (await auditorias('TOKEN_DISPOSITIVO_ALTERADO')).length;
      const primeira = await como(admin).patch(`${RAIZ}/${x.id}`, { setor: 'Almoxarifado', localInstalacao: 'Doca 3' });
      assert.equal(primeira.status, 200, aviso(primeira));
      const segunda = await como(segundo).patch(`${RAIZ}/${x.id}`, { unidade: 'Fábrica 2', localInstalacao: 'Portaria sul' });
      assert.equal(segunda.status, 200, aviso(segunda));
      const registros = (await auditorias('TOKEN_DISPOSITIVO_ALTERADO')).slice(antes);
      assert.equal(registros.length, 2);
      assert.deepEqual(registros.map((r) => [r.usuario_id, r.empresa_id, r.referencia]), [[admin, d.empresaA, String(x.id)], [segundo, d.empresaA, String(x.id)]]);
      assert.deepEqual(registros[0].dados_anteriores, { setor: 'Expedição', localInstalacao: 'Portaria norte' });
      assert.deepEqual(registros[0].dados_novos, { setor: 'Almoxarifado', localInstalacao: 'Doca 3' });
      assert.deepEqual(registros[1].dados_anteriores, { unidade: 'Fábrica 1', localInstalacao: 'Doca 3' });
      assert.deepEqual(registros[1].dados_novos, { unidade: 'Fábrica 2', localInstalacao: 'Portaria sul' });
      for (const registro of registros) semSegredo(registro, 'auditoria da alteração');
      const marcas = await eventos(x.id, 'ALTERACAO');
      assert.deepEqual(marcas.map((e) => [e.usuario_id, e.empresa_id]), [[admin, d.empresaA], [segundo, d.empresaA]]);
      assert.ok(marcas.every((e) => e.ocorrido_em instanceof Date), 'cada evento tem o instante');
    });

    test('E8 — a localização copiada em solicitacoes_autoatendimento NÃO acompanha a edição posterior do tablet', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Preservado'), unidade: 'Fábrica 1', setor: 'Expedição', local_instalacao: 'Portaria norte' });
      const { solicitacao } = await criarSolicitacao(ctx.pool, d, { empresaId: d.empresaA, funcionarioId: d.trabalhador, origem: 'AUTOATENDIMENTO', itens: [{ material_id: d.capacete, tamanho: null }] });
      const atendimento = (await q(
        `INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, expira_em) VALUES ($1, $2, $3, $4, now() + interval '90 seconds') RETURNING id`,
        [d.empresaA, x.id, d.trabalhador, hash()],
      )).rows[0];
      await q('INSERT INTO solicitacoes_autoatendimento (empresa_id, solicitacao_id, dispositivo_id, atendimento_id, unidade, setor, local_instalacao) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [d.empresaA, solicitacao.id, x.id, atendimento.id, 'Fábrica 1', 'Expedição', 'Portaria norte']);
      const r = await como(admin).patch(`${RAIZ}/${x.id}`, { unidade: 'Fábrica 2', setor: 'Almoxarifado', localInstalacao: 'Doca 9' });
      assert.equal(r.status, 200, aviso(r));
      const copia = (await q('SELECT unidade, setor, local_instalacao FROM solicitacoes_autoatendimento WHERE solicitacao_id = $1', [solicitacao.id])).rows[0];
      assert.deepEqual(copia, { unidade: 'Fábrica 1', setor: 'Expedição', local_instalacao: 'Portaria norte' });
      assert.equal((await linha(x.id)).local_instalacao, 'Doca 9');
    });
  });

  // ───────────────────────── 4.4 revogação ─────────────────────────
  describe('revogação', () => {
    test('R1 — revoga com o usuário da SESSÃO como responsável e ZERA a credencial persistida; a antiga deixa de ser localizável como válida', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('A revogar') });
      const credencial = await ativar(x.id);
      assert.equal((await q('SELECT count(*)::int AS n FROM token_dispositivos WHERE credencial_hash = $1 AND revogado_em IS NULL', [credencial])).rows[0].n, 1, 'premissa: a credencial vale antes');
      const r = await como(gestorA).post(`${RAIZ}/${x.id}/revogar`);
      assert.equal(r.status, 200, aviso(r));
      assert.equal(r.body.alterado, true);
      assert.deepEqual([r.body.dispositivo.situacao, r.body.dispositivo.revogadoPor], ['REVOGADO', gestorA]);
      assert.match(r.body.dispositivo.revogadoEm, /^\d{4}-\d{2}-\d{2}T/);
      const depois = await linha(x.id);
      assert.deepEqual([depois.revogado_por, depois.credencial_hash, depois.credencial_anterior_hash], [gestorA, null, null], 'a credencial anterior (rotação) também é zerada');
      assert.ok(depois.revogado_em instanceof Date);
      assert.equal((await q('SELECT count(*)::int AS n FROM token_dispositivos WHERE credencial_hash = $1', [credencial])).rows[0].n, 0, 'a credencial antiga não existe mais');
      semSegredo(r.body, 'revogação', [credencial]);
    });

    test('R2 — exige a AÇÃO TOKEN_REVOGAR_DISPOSITIVO: quem tem visualizar, criar e editar sem a ação recebe 403; a ação sozinha basta', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Exige ação') });
      const semAcao = await usuario(d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'] });
      const soAcao = await usuario(d.empresaA, { acoes: ['TOKEN_REVOGAR_DISPOSITIVO'] });
      const negada = await como(semAcao).post(`${RAIZ}/${x.id}/revogar`);
      assert.equal(negada.status, 403, aviso(negada));
      assert.equal((await linha(x.id)).revogado_em, null);
      const permitida = await como(soAcao).post(`${RAIZ}/${x.id}/revogar`);
      assert.equal(permitida.status, 200, aviso(permitida));
      assert.equal((await linha(x.id)).revogado_por, soAcao);
    });

    test('R3 — revogar cancela a ativação pendente e encerra o atendimento aberto (DISPOSITIVO_REVOGADO)', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Em uso') });
      const ativacao = (await q(
        `INSERT INTO token_ativacoes (empresa_id, dispositivo_id, codigo_hash, criado_por, criado_em, expira_em) VALUES ($1, $2, $3, $4, now(), now() + interval '10 minutes') RETURNING id`,
        [d.empresaA, x.id, hash(), d.master],
      )).rows[0];
      const atendimento = (await q(
        `INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, expira_em) VALUES ($1, $2, $3, $4, now() + interval '90 seconds') RETURNING id`,
        [d.empresaA, x.id, d.trabalhador2, hash()],
      )).rows[0];
      const r = await como(gestorA).post(`${RAIZ}/${x.id}/revogar`);
      assert.equal(r.status, 200, aviso(r));
      const ativacaoDepois = (await q('SELECT cancelado_em, usado_em FROM token_ativacoes WHERE id = $1', [ativacao.id])).rows[0];
      assert.ok(ativacaoDepois.cancelado_em instanceof Date && ativacaoDepois.usado_em === null, 'a ativação pendente deveria ser cancelada');
      const atendimentoDepois = (await q('SELECT encerrado_em, motivo_encerramento FROM token_atendimentos WHERE id = $1', [atendimento.id])).rows[0];
      assert.ok(atendimentoDepois.encerrado_em instanceof Date, 'o atendimento aberto deveria ser encerrado');
      assert.equal(atendimentoDepois.motivo_encerramento, 'DISPOSITIVO_REVOGADO');
    });

    test('R4 — repetir a revogação é idempotente: 200 alterado:false, o primeiro responsável e o instante ficam, sem auditoria nem evento novos', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Revogado duas vezes') });
      const primeira = await como(gestorA).post(`${RAIZ}/${x.id}/revogar`);
      assert.equal(primeira.status, 200, aviso(primeira));
      const depoisDaPrimeira = await linha(x.id);
      const auditoriasAntes = (await auditorias('TOKEN_DISPOSITIVO_REVOGADO')).length;
      const eventosAntes = (await eventos(x.id, 'REVOGACAO')).length;
      const repetida = await como(admin).post(`${RAIZ}/${x.id}/revogar`);
      assert.equal(repetida.status, 200, aviso(repetida));
      assert.equal(repetida.body.alterado, false);
      assert.equal(repetida.body.dispositivo.revogadoPor, gestorA, 'o responsável é o da primeira revogação');
      assert.deepEqual(await linha(x.id), depoisDaPrimeira);
      assert.equal((await auditorias('TOKEN_DISPOSITIVO_REVOGADO')).length, auditoriasAntes);
      assert.equal((await eventos(x.id, 'REVOGACAO')).length, eventosAntes);
      assert.equal(eventosAntes, 1);
    });

    test('R5 — revogar o de OUTRA empresa ou o inexistente é 404 idêntico e nada muda; id inválido e corpo com autoria são 400', async () => {
      const dele = await dispositivo(d.empresaB, { nome: unico('Da B') });
      await ativar(dele.id);
      const antes = await linha(dele.id);
      const alheio = await como(gestorA).post(`${RAIZ}/${dele.id}/revogar`);
      const inexistente = await como(gestorA).post(`${RAIZ}/999999/revogar`);
      assert.equal(alheio.status, 404, aviso(alheio));
      assert.equal(codigo(alheio), 'DISPOSITIVO_NAO_ENCONTRADO', 'o 404 é do domínio (dispositivo), não de rota inexistente');
      assert.deepEqual([alheio.status, alheio.body], [inexistente.status, inexistente.body]);
      assert.deepEqual(await linha(dele.id), antes);
      assert.equal((await como(gestorA).post(`${RAIZ}/abc/revogar`)).status, 400);
      const meu = await dispositivo(d.empresaA, { nome: unico('Corpo indevido') });
      for (const corpo of [{ revogadoPor: d.master }, { empresaId: d.empresaB }, { motivo: 'x' }]) {
        const r = await como(gestorA).post(`${RAIZ}/${meu.id}/revogar`, corpo);
        assert.equal(r.status, 400, `${JSON.stringify(corpo)} → ${aviso(r)}`);
      }
      assert.equal((await linha(meu.id)).revogado_em, null);
    });

    test('R6 — auditoria e evento da revogação: um de cada, com o usuário da sessão; nada de credencial; revogar um tablet ainda pendente também vale', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Pendente revogado') });
      const antes = (await auditorias('TOKEN_DISPOSITIVO_REVOGADO')).length;
      const r = await como(gestorA).post(`${RAIZ}/${x.id}/revogar`);
      assert.equal(r.status, 200, aviso(r));
      const registros = (await auditorias('TOKEN_DISPOSITIVO_REVOGADO')).slice(antes);
      assert.equal(registros.length, 1);
      assert.deepEqual([registros[0].usuario_id, registros[0].empresa_id, registros[0].referencia], [gestorA, d.empresaA, String(x.id)]);
      semSegredo(registros[0], 'auditoria da revogação');
      assert.deepEqual((await eventos(x.id, 'REVOGACAO')).map((e) => [e.usuario_id, e.empresa_id]), [[gestorA, d.empresaA]]);
    });
  });

  // ───────────────────────── consistência transacional (DB-4) ─────────────────────────
  // A edição/cadastro/revogação, o evento e a auditoria são UMA transação. A falha de qualquer uma das escritas desfaz as outras.
  // Adicionado no GREEN B (exigência explícita de consistência transacional; o RED não a cobria): um pool que faz falhar o
  // INSERT escolhido, SÓ para o serviço; a autorização continua no pool real.
  describe('atomicidade (dispositivo + evento + auditoria numa transação)', () => {
    function appComFalhaEm(padrao) {
      const falhando = new Proxy(ctx.pool, {
        get(alvo, propriedade) {
          if (propriedade === 'connect') {
            return async () => {
              const cliente = await alvo.connect();
              return {
                query: (...args) => (typeof args[0] === 'string' && padrao.test(args[0]) ? Promise.reject(new Error('falha induzida pelo teste')) : cliente.query(...args)),
                release: () => cliente.release(),
              };
            };
          }
          const valor = alvo[propriedade];
          return typeof valor === 'function' ? valor.bind(alvo) : valor;
        },
      });
      const modulos = carregarModulos();
      return criarAppTeste((a) => {
        if (modulos) a.use('/api', modulos.rotas.criarTokenDispositivoRoutes({ controller: modulos.controller.criarTokenDispositivoController({ pool: falhando }), exigirSessao, pool: ctx.pool }));
      });
    }
    const comoNaFalha = (appFalho, usuarioId) => ({
      post: (url, corpo = {}) => request(appFalho).post(url).set(CABECALHO, String(usuarioId)).send(corpo),
      patch: (url, corpo = {}) => request(appFalho).patch(url).set(CABECALHO, String(usuarioId)).send(corpo),
    });

    test('A1 — cadastro: se a auditoria falha, o dispositivo e o evento NÃO ficam gravados', async () => {
      const nome = unico('Atômico cadastro');
      const r = await comoNaFalha(appComFalhaEm(/INSERT INTO logs_auditoria/), gestorA).post(RAIZ, { nome });
      assert.equal(r.status, 500, aviso(r));
      assert.equal((await q('SELECT count(*)::int AS n FROM token_dispositivos WHERE empresa_id = $1 AND nome = $2', [d.empresaA, nome])).rows[0].n, 0, 'o dispositivo ficou gravado sem a auditoria');
      assert.equal((await q("SELECT count(*)::int AS n FROM token_dispositivo_eventos e JOIN token_dispositivos t ON t.id = e.dispositivo_id WHERE t.nome = $1", [nome])).rows[0].n, 0);
      assert.equal((await como(gestorA).post(RAIZ, { nome })).status, 201, 'o mesmo cadastro, sem falha, funciona (o nome não ficou preso)');
    });

    test('A2 — edição: se a auditoria falha, o dispositivo NÃO muda e nenhum evento ALTERACAO fica; se o evento falha, nem auditoria nem mudança', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Atômico edição'), setor: 'Original' });
      const antes = await linha(x.id);
      const auditoriasAntes = (await auditorias('TOKEN_DISPOSITIVO_ALTERADO')).length;
      for (const padrao of [/INSERT INTO logs_auditoria/, /INSERT INTO token_dispositivo_eventos/]) {
        const r = await comoNaFalha(appComFalhaEm(padrao), admin).patch(`${RAIZ}/${x.id}`, { setor: 'Mudou' });
        assert.equal(r.status, 500, `${padrao} → ${aviso(r)}`);
        assert.deepEqual(await linha(x.id), antes, `${padrao}: o dispositivo mudou apesar da falha`);
        assert.equal((await eventos(x.id, 'ALTERACAO')).length, 0, `${padrao}: ficou evento`);
        assert.equal((await auditorias('TOKEN_DISPOSITIVO_ALTERADO')).length, auditoriasAntes, `${padrao}: ficou auditoria`);
      }
    });

    test('A3 — revogação: se o evento falha, NADA é revogado: a credencial continua, a ativação pendente segue pendente e o atendimento aberto segue aberto', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Atômico revogação') });
      const credencial = await ativar(x.id);
      const ativacao = (await q(
        `INSERT INTO token_ativacoes (empresa_id, dispositivo_id, codigo_hash, criado_por, criado_em, expira_em) VALUES ($1, $2, $3, $4, now(), now() + interval '10 minutes') RETURNING id`,
        [d.empresaA, x.id, hash(), d.master],
      )).rows[0];
      const atendimento = (await q(
        `INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, expira_em) VALUES ($1, $2, $3, $4, now() + interval '90 seconds') RETURNING id`,
        [d.empresaA, x.id, d.trabalhador3, hash()],
      )).rows[0];
      const antes = await linha(x.id);
      for (const padrao of [/INSERT INTO token_dispositivo_eventos/, /INSERT INTO logs_auditoria/]) {
        const r = await comoNaFalha(appComFalhaEm(padrao), gestorA).post(`${RAIZ}/${x.id}/revogar`);
        assert.equal(r.status, 500, `${padrao} → ${aviso(r)}`);
        assert.deepEqual(await linha(x.id), antes, `${padrao}: a revogação ficou pela metade`);
        assert.equal((await linha(x.id)).credencial_hash, credencial);
        assert.equal((await q('SELECT cancelado_em FROM token_ativacoes WHERE id = $1', [ativacao.id])).rows[0].cancelado_em, null, `${padrao}: a ativação foi cancelada`);
        assert.equal((await q('SELECT encerrado_em FROM token_atendimentos WHERE id = $1', [atendimento.id])).rows[0].encerrado_em, null, `${padrao}: o atendimento foi encerrado`);
      }
      assert.equal((await como(gestorA).post(`${RAIZ}/${x.id}/revogar`)).status, 200, 'sem falha, a revogação funciona');
    });
  });

  // ───────────────────────── 4.5 RBAC e isolamento ─────────────────────────
  describe('RBAC e isolamento (autorização no BACKEND)', () => {
    test('P1 — sem sessão é 401; sem nenhuma permissão é 403 em TODAS as rotas, e nada é criado, alterado ou revogado', async () => {
      const semNada = await usuario(d.empresaA);
      const x = await dispositivo(d.empresaA, { nome: unico('Protegido'), setor: 'Original' });
      const antes = await linha(x.id);
      const totalAntes = await totalDeDispositivos(d.empresaA);
      assert.equal((await request(app).get(RAIZ)).status, 401);
      assert.equal((await request(app).post(RAIZ).send({ nome: 'x' })).status, 401);
      const tentativas = [
        ['GET lista', () => como(semNada).get(RAIZ)], ['GET detalhe', () => como(semNada).get(`${RAIZ}/${x.id}`)],
        ['POST', () => como(semNada).post(RAIZ, { nome: unico('Negado') })], ['PATCH', () => como(semNada).patch(`${RAIZ}/${x.id}`, { setor: 'Invadido' })],
        ['revogar', () => como(semNada).post(`${RAIZ}/${x.id}/revogar`)],
      ];
      for (const [rotulo, chamar] of tentativas) {
        const r = await chamar();
        assert.equal(r.status, 403, `${rotulo} → ${aviso(r)}`);
      }
      assert.deepEqual(await linha(x.id), antes);
      assert.equal(await totalDeDispositivos(d.empresaA), totalAntes);
    });

    test('P2 — cada operação é independente: só visualizar não cria nem edita; só criar não lê; só editar não lê nem cria; só a ação não faz nada além de revogar', async () => {
      const x = await dispositivo(d.empresaA, { nome: unico('Independência') });
      const soVer = await usuario(d.empresaA, { operacoes: ['visualizar'] });
      const soCriar = await usuario(d.empresaA, { operacoes: ['criar'] });
      const soEditar = await usuario(d.empresaA, { operacoes: ['editar'] });
      const soRevogar = await usuario(d.empresaA, { acoes: ['TOKEN_REVOGAR_DISPOSITIVO'] });
      const status = async (u, chamar) => (await chamar(como(u))).status;
      assert.deepEqual([
        await status(soVer, (c) => c.get(RAIZ)), await status(soVer, (c) => c.get(`${RAIZ}/${x.id}`)),
        await status(soVer, (c) => c.post(RAIZ, { nome: unico('Ver cria') })), await status(soVer, (c) => c.patch(`${RAIZ}/${x.id}`, { setor: 'A' })),
        await status(soVer, (c) => c.post(`${RAIZ}/${x.id}/revogar`)),
      ], [200, 200, 403, 403, 403], 'só visualizar');
      assert.deepEqual([
        await status(soCriar, (c) => c.post(RAIZ, { nome: unico('Criar') })), await status(soCriar, (c) => c.get(RAIZ)),
        await status(soCriar, (c) => c.patch(`${RAIZ}/${x.id}`, { setor: 'B' })),
      ], [201, 403, 403], 'só criar');
      assert.deepEqual([
        await status(soEditar, (c) => c.patch(`${RAIZ}/${x.id}`, { setor: 'C' })), await status(soEditar, (c) => c.get(RAIZ)),
        await status(soEditar, (c) => c.post(RAIZ, { nome: unico('Editar cria') })), await status(soEditar, (c) => c.post(`${RAIZ}/${x.id}/revogar`)),
      ], [200, 403, 403, 403], 'só editar');
      assert.deepEqual([
        await status(soRevogar, (c) => c.get(RAIZ)), await status(soRevogar, (c) => c.post(RAIZ, { nome: unico('Revogar cria') })),
        await status(soRevogar, (c) => c.patch(`${RAIZ}/${x.id}`, { setor: 'D' })), await status(soRevogar, (c) => c.post(`${RAIZ}/${x.id}/revogar`)),
      ], [403, 403, 403, 200], 'só a ação');
    });

    test('P3 — a decisão é de CONCESSÃO, não do nome do perfil: ADMINISTRADOR, SUPERVISOR e USUÁRIO sem concessão recebem 403; a negação individual e o bloqueio da ação valem', async () => {
      for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
        const semConcessao = await usuario(d.empresaA, { perfil });
        assert.equal((await como(semConcessao).get(RAIZ)).status, 403, perfil);
        assert.equal((await como(semConcessao).post(RAIZ, { nome: unico(`Perfil ${perfil}`) })).status, 403, perfil);
      }
      const x = await dispositivo(d.empresaA, { nome: unico('Bloqueio') });
      const bloqueado = await usuario(d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO'] });
      await q('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, $2, $3)', [bloqueado, 'TOKEN_REVOGAR_DISPOSITIVO', d.master]);
      await q('UPDATE usuario_permissoes_recurso SET pode_editar = false WHERE usuario_id = $1 AND recurso = $2', [bloqueado, 'atendimentoToken']);
      assert.equal((await como(bloqueado).post(`${RAIZ}/${x.id}/revogar`)).status, 403, 'o bloqueio individual vence a autorização');
      assert.equal((await como(bloqueado).patch(`${RAIZ}/${x.id}`, { setor: 'Z' })).status, 403, 'a negação individual vence');
      assert.equal((await como(bloqueado).get(RAIZ)).status, 200, 'o resto da concessão continua');
    });

    test('P4 — o MASTER recebe só pelo PROVISIONAMENTO do escopo: antes (empresa A sem provisionar) é 403; depois, cadastra, edita e revoga; a empresa B segue sem; reaplicar não duplica', async () => {
      assert.equal((await como(d.master).get(RAIZ)).status, 403, 'MASTER sem provisionamento não acessa (nada é concedido só pelo perfil)');
      assert.equal((await como(d.master).post(RAIZ, { nome: unico('MASTER sem escopo') })).status, 403);
      await provisionamento.provisionar(ctx.pool, { empresaId: d.empresaA, dryRun: false });
      const criado = await como(d.master).post(RAIZ, { nome: unico('MASTER cria') });
      assert.equal(criado.status, 201, aviso(criado));
      assert.equal((await como(d.master).get(RAIZ)).status, 200);
      assert.equal((await como(d.master).patch(`${RAIZ}/${criado.body.dispositivo.id}`, { setor: 'MASTER edita' })).status, 200);
      const revogado = await como(d.master).post(`${RAIZ}/${criado.body.dispositivo.id}/revogar`);
      assert.equal(revogado.status, 200, aviso(revogado));
      assert.equal((await linha(criado.body.dispositivo.id)).revogado_por, d.master);
      assert.equal((await como(d.masterB).get(RAIZ)).status, 403, 'provisionar a empresa A não toca a B');
      const reaplicada = await provisionamento.provisionar(ctx.pool, { empresaId: d.empresaA, dryRun: false });
      assert.equal(reaplicada.inseridos.acoes.length, 0, JSON.stringify(reaplicada.inseridos));
      const linhasDoRecurso = (await q("SELECT perfil FROM permissoes_recurso WHERE empresa_id = $1 AND recurso = 'atendimentoToken'", [d.empresaA])).rows;
      assert.deepEqual(linhasDoRecurso.map((l) => l.perfil), ['MASTER'], 'só o MASTER recebe o recurso');
      const linhasDaAcao = (await q("SELECT perfil FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo = 'TOKEN_REVOGAR_DISPOSITIVO' AND permitido", [d.empresaA])).rows;
      assert.deepEqual(linhasDaAcao.map((l) => l.perfil), ['MASTER'], 'só o MASTER recebe a ação');
    });

    test('P5 — o provisionamento do MASTER NÃO concede nada a ADMINISTRADOR, SUPERVISOR ou USUÁRIO da mesma empresa (nem às demais ações do Token)', async () => {
      for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
        const conta = await usuario(d.empresaA, { perfil });
        assert.equal((await como(conta).get(RAIZ)).status, 403, `${perfil} após o provisionamento`);
        const x = await dispositivo(d.empresaA, { nome: unico(`Sem concessão ${perfil}`) });
        assert.equal((await como(conta).post(`${RAIZ}/${x.id}/revogar`)).status, 403, `${perfil} revoga`);
      }
      const concedidas = (await q("SELECT perfil, acao_codigo FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo LIKE 'TOKEN\\_%' AND perfil <> 'MASTER'", [d.empresaA])).rows;
      assert.deepEqual(concedidas, []);
    });

    test('P6 — acesso cruzado com IDs VÁLIDOS: quem administra a empresa B não lê, edita nem revoga o dispositivo da A (404, nada muda) e vice-versa', async () => {
      const daA = await dispositivo(d.empresaA, { nome: unico('Cruzado A'), setor: 'Original A' });
      await ativar(daA.id);
      const daB = await dispositivo(d.empresaB, { nome: unico('Cruzado B'), setor: 'Original B' });
      const antesA = await linha(daA.id);
      const antesB = await linha(daB.id);
      for (const [rotulo, resposta] of [
        ['B lê A', await como(gestorB).get(`${RAIZ}/${daA.id}`)], ['B edita A', await como(gestorB).patch(`${RAIZ}/${daA.id}`, { setor: 'Invadido' })],
        ['B revoga A', await como(gestorB).post(`${RAIZ}/${daA.id}/revogar`)], ['A lê B', await como(gestorA).get(`${RAIZ}/${daB.id}`)],
        ['A edita B', await como(gestorA).patch(`${RAIZ}/${daB.id}`, { setor: 'Invadido' })], ['A revoga B', await como(gestorA).post(`${RAIZ}/${daB.id}/revogar`)],
      ]) {
        assert.equal(resposta.status, 404, `${rotulo} → ${aviso(resposta)}`);
        assert.equal(codigo(resposta), 'DISPOSITIVO_NAO_ENCONTRADO', `${rotulo}: o 404 é do domínio`);
      }
      assert.deepEqual(await linha(daA.id), antesA);
      assert.deepEqual(await linha(daB.id), antesB);
      const listaDaB = (await como(gestorB).get(`${RAIZ}?limite=100`)).body.dispositivos ?? [];
      assert.equal(listaDaB.some((x) => x.id === daA.id), false);
      assert.ok(listaDaB.some((x) => x.id === daB.id), 'a lista da B deveria trazer o dispositivo da B');
    });

    test('P7 — defesa em profundidade no repositório: UPDATE de edição e de revogação carregam o filtro de empresa (id da A com empresa B não altera nada) e a listagem tem teto próprio', async () => {
      const repositorio = require('../../src/repositories/token-dispositivo.repository');
      const daA = await dispositivo(d.empresaA, { nome: unico('Repo A'), setor: 'Original' });
      await ativar(daA.id);
      const antes = await linha(daA.id);
      assert.equal(await repositorio.atualizar(ctx.pool, d.empresaB, daA.id, { setor: 'Invadido' }), null);
      assert.equal(await repositorio.revogar(ctx.pool, d.empresaB, daA.id, d.masterB), null);
      assert.deepEqual(await linha(daA.id), antes);
      assert.equal((await repositorio.atualizar(ctx.pool, d.empresaA, daA.id, { setor: 'Legítimo' })).setor, 'Legítimo', 'controle: com a empresa certa o UPDATE acontece');
      await assert.rejects(() => repositorio.listar(ctx.pool, d.empresaA, { pagina: 1, limite: 101 }), TypeError, 'o teto de 100 também vale no repositório');
      await assert.rejects(() => repositorio.listar(ctx.pool, d.empresaA, { pagina: 1, limite: 0 }), TypeError);
      assert.ok(Array.isArray(await repositorio.listar(ctx.pool, d.empresaA, { pagina: 1, limite: 100 })), 'controle: 100 é aceito');
    });
  });

  // ───────────────────────── segredos fora da auditoria e dos eventos (reforço do GREEN B) ─────────────────────────
  // A trava da migration 014 só olha NOMES de chave JSON: o VALOR de um hash sob chave neutra, ou em descricao, referencia e
  // dispositivo, passa. Por isso a prova é uma varredura de VALORES em todas as colunas, com credenciais reais de um tablet ATIVO.
  describe('segredos fora de logs_auditoria e token_dispositivo_eventos', () => {
    const CHAVE_SENSIVEL = /hash|credencial|senha|segredo|secret|cookie|authorization|api.?key|codigo.?ativacao|private/i;
    const chavesJson = (valor, acumulado = []) => {
      if (Array.isArray(valor)) valor.forEach((v) => chavesJson(v, acumulado));
      else if (valor !== null && typeof valor === 'object') for (const [k, v] of Object.entries(valor)) { acumulado.push(k); chavesJson(v, acumulado); }
      return acumulado;
    };
    /** Varre TODAS as colunas das linhas (texto e JSONB). Devolve só {coluna, motivo}: nunca o valor encontrado. */
    function varrer(linhas, segredos) {
      const achados = [];
      linhas.forEach((linhaDoBanco, i) => {
        for (const [coluna, valor] of Object.entries(linhaDoBanco)) {
          const texto = JSON.stringify(valor) ?? '';
          if (segredos.some((s) => texto.includes(s))) achados.push({ linha: i, coluna, motivo: 'VALOR_SECRETO' });
          if (HEX64.test(texto)) achados.push({ linha: i, coluna, motivo: 'HASH_64_HEX' });
          if (chavesJson(valor).some((k) => CHAVE_SENSIVEL.test(k))) achados.push({ linha: i, coluna, motivo: 'CHAVE_SENSIVEL' });
        }
      });
      return achados;
    }
    const todaAuditoria = async (empresaId) => (await q('SELECT * FROM logs_auditoria WHERE empresa_id = $1 ORDER BY id', [empresaId])).rows;
    const todosEventos = async (empresaId) => (await q('SELECT * FROM token_dispositivo_eventos WHERE empresa_id = $1 ORDER BY id', [empresaId])).rows;

    test('S1 — tablet ATIVO com credencial atual e anterior, ativação pendente e atendimento aberto: cadastro, edição e revogação não persistem nenhum segredo em nenhuma coluna', async () => {
      const cadastro = await como(gestorA).post(RAIZ, { nome: unico('Segredos'), unidade: 'Fábrica', setor: 'Expedição', localInstalacao: 'Portaria' });
      assert.equal(cadastro.status, 201, aviso(cadastro));
      const id = cadastro.body.dispositivo.id;
      const [credencial, anterior, codigoAtivacao, tokenAtendimento] = [hash(), hash(), hash(), hash()];
      await q('UPDATE token_dispositivos SET ativado_em = now(), credencial_hash = $1, credencial_anterior_hash = $2, credencial_emitida_em = now() WHERE id = $3', [credencial, anterior, id]);
      await q(`INSERT INTO token_ativacoes (empresa_id, dispositivo_id, codigo_hash, criado_por, criado_em, expira_em) VALUES ($1, $2, $3, $4, now(), now() + interval '10 minutes')`, [d.empresaA, id, codigoAtivacao, d.master]);
      await q(`INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, expira_em) VALUES ($1, $2, $3, $4, now() + interval '90 seconds')`, [d.empresaA, id, d.trabalhador2, tokenAtendimento]);
      const segredos = [credencial, anterior, codigoAtivacao, tokenAtendimento];

      const edicao = await como(gestorA).patch(`${RAIZ}/${id}`, { setor: 'Almoxarifado', localInstalacao: 'Doca 3', modelo: 'M2' });
      assert.equal(edicao.status, 200, aviso(edicao));
      assert.equal((await q('SELECT credencial_hash FROM token_dispositivos WHERE id = $1', [id])).rows[0].credencial_hash, credencial, 'premissa: editar um tablet ativo não mexe na credencial');
      const revogacao = await como(gestorA).post(`${RAIZ}/${id}/revogar`);
      assert.equal(revogacao.status, 200, aviso(revogacao));
      assert.equal(revogacao.body.alterado, true);

      // A revogação continua invalidando as credenciais, a ativação pendente e o atendimento aberto.
      const depois = await linha(id);
      assert.deepEqual([depois.credencial_hash, depois.credencial_anterior_hash], [null, null]);
      for (const segredo of [credencial, anterior]) assert.equal((await q('SELECT count(*)::int AS n FROM token_dispositivos WHERE credencial_hash = $1 OR credencial_anterior_hash = $1', [segredo])).rows[0].n, 0);
      assert.ok((await q('SELECT cancelado_em FROM token_ativacoes WHERE dispositivo_id = $1', [id])).rows[0].cancelado_em instanceof Date);
      assert.equal((await q('SELECT motivo_encerramento FROM token_atendimentos WHERE dispositivo_id = $1', [id])).rows[0].motivo_encerramento, 'DISPOSITIVO_REVOGADO');

      const auditoria = await todaAuditoria(d.empresaA);
      assert.deepEqual(auditoria.filter((l) => l.referencia === String(id)).map((l) => l.acao).sort(), ['TOKEN_DISPOSITIVO_ALTERADO', 'TOKEN_DISPOSITIVO_CADASTRADO', 'TOKEN_DISPOSITIVO_REVOGADO'], 'premissa: as três auditorias do ciclo existem e foram varridas');
      assert.deepEqual(varrer(auditoria, segredos), [], 'segredo em logs_auditoria (coluna e motivo, nunca o valor)');
      const eventos = await todosEventos(d.empresaA);
      assert.deepEqual(eventos.filter((e) => e.dispositivo_id === id).map((e) => e.tipo).sort(), ['ALTERACAO', 'CADASTRO', 'REVOGACAO'], 'premissa: os três eventos do ciclo existem e foram varridos');
      assert.deepEqual(varrer(eventos, segredos), [], 'segredo em token_dispositivo_eventos (coluna e motivo, nunca o valor)');
    });

    test('S2 — controle positivo ISOLADO: a mesma varredura acha um valor secreto em cada coluna relevante (JSONB sob chave neutra, descricao, referencia, dispositivo, ip) e uma chave sensível, só com dados sintéticos', () => {
      const segredo = hash();
      const base = { acao: 'X', contexto: null, dados_anteriores: null, dados_novos: null, descricao: null, referencia: '1', ip: null, dispositivo: null };
      for (const [coluna, valor] of [['contexto', { resumo: segredo }], ['dados_anteriores', { a: { b: segredo } }], ['dados_novos', { lista: [segredo] }], ['descricao', segredo], ['referencia', `1:${segredo}`], ['dispositivo', segredo], ['ip', segredo]]) {
        const achados = varrer([{ ...base, [coluna]: valor }], [segredo]);
        assert.ok(achados.some((a) => a.coluna === coluna && a.motivo === 'VALOR_SECRETO'), `a varredura não enxergou o segredo em ${coluna}`);
      }
      assert.ok(varrer([{ ...base, dados_novos: { x: hash() } }], []).some((a) => a.motivo === 'HASH_64_HEX'), 'hash desconhecido de 64 hex também é achado');
      assert.ok(varrer([{ ...base, contexto: { credencial_hash: 'x' } }], []).some((a) => a.motivo === 'CHAVE_SENSIVEL'));
      assert.deepEqual(varrer([{ ...base, contexto: { ativacoesCanceladas: 1, atendimentosEncerrados: 0 }, dados_novos: { situacao: 'REVOGADO' } }], [segredo]), [], 'controle negativo: linha limpa não gera achado');
    });

    test('S3 — controle positivo no BANCO (empresa B, isolada): um valor secreto plantado em chave neutra passa pela trava da 014 e a varredura o acha; a empresa A segue limpa', async () => {
      const segredo = hash();
      await q(`INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, contexto) VALUES ($1, $2, 'PLANTADO_CONTROLE', '0', $3::jsonb)`, [d.empresaB, masterDe(d.empresaB), JSON.stringify({ resumo: segredo })]);
      assert.ok(varrer(await todaAuditoria(d.empresaB), [segredo]).some((a) => a.coluna === 'contexto' && a.motivo === 'VALOR_SECRETO'));
      assert.deepEqual(varrer(await todaAuditoria(d.empresaA), [segredo]), []);
    });
  });
});
