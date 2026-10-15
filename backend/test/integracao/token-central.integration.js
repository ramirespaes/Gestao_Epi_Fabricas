'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const {
  RAIZ, CHAVES_DA_VISAO_GERAL, CHAVES_DOS_DISPOSITIVOS, CHAVES_DA_ATIVACAO, abrirAmbienteCentral,
} = require('./helpers/token-central');
const { cookieDoTabletNaResposta, cookieDoTablet } = require('./helpers/token-tablet');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { avaliarPermissaoRecurso, avaliarPermissaoAcao } = require('../../src/middleware/autorizacao');

/**
 * Atendimento Token — Etapa H (RED): Central Administrativa. PostgreSQL real, schema temporário com TODAS as migrations; nenhuma migration nova.
 * O que a Central usa HOJE já existe nas Etapas B e C (listar, cadastrar, editar, revogar, gerar ativação) e é coberto aqui por CONTROLES que
 * passam já. O que falta para a Central é pequeno e está nos contratos de `helpers/token-central.js`: Visão Geral, estado da ativação e Prévia
 * (todos GET). Esses testes falham hoje PRIMEIRO pela ausência da rota (404 ROTA_NAO_ENCONTRADA na primeira asserção) — falha de integração
 * real, não artificial —, e só no GREEN H suas asserções internas são verificadas (a coerência foi validada à parte contra um oráculo em memória).
 *
 * Fora daqui, por decisão: Monitoramento e Histórico são da Etapa J (H24 garante que não foram antecipados); a visualização (navegação,
 * layout, abas) é do GREEN H e está nos critérios verificáveis do relatório, não em teste que force HTML; os toggles do Token na Gestão de
 * Usuários e a gestão de redes dependem de decisão (testes `todo`).
 */

const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const SEGREDO = /hash|credencial|senha|segredo|codigo_?ativacao|token_?hash/i;
const HEX64 = /\b[0-9a-f]{64}\b/i;
const TOKEN43 = /\b[A-Za-z0-9_-]{43}\b/;
const ACOES_TOKEN = Object.freeze(['TOKEN_GERAR_ATIVACAO', 'TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERENCIAR_REDES', 'TOKEN_PREVIA_CATALOGO_REAL', 'TOKEN_VISUALIZAR_MONITORAMENTO', 'TOKEN_VISUALIZAR_HISTORICO']);

function chavesDe(valor, acumulado = []) {
  if (Array.isArray(valor)) valor.forEach((x) => chavesDe(x, acumulado));
  else if (valor !== null && typeof valor === 'object') for (const [k, v] of Object.entries(valor)) { acumulado.push(k); chavesDe(v, acumulado); }
  return acumulado;
}
function semSegredo(corpo, rotulo, ocultos = []) {
  const texto = JSON.stringify(corpo);
  assert.deepEqual(chavesDe(corpo).filter((k) => SEGREDO.test(k)), [], `${rotulo}: chave de segredo na resposta`);
  assert.equal(HEX64.test(texto), false, `${rotulo}: hash em hexadecimal na resposta`);
  for (const oculto of ocultos) assert.equal(texto.includes(oculto), false, `${rotulo}: valor secreto na resposta`);
}
const erroSeguro = (r, status, codigo, rotulo = '') => {
  assert.equal(r.status, status, `${rotulo} ${aviso(r)}`);
  assert.equal(r.body.status, 'error', rotulo);
  assert.equal(r.body.codigo, codigo, `${rotulo} ${aviso(r)}`);
  assert.equal(typeof r.body.message, 'string', rotulo);
  assert.equal(JSON.stringify(r.body).includes('stack'), false, rotulo);
};

describe('Atendimento Token — H: Central Administrativa (PostgreSQL real)', () => {
  let a;
  let app;
  let master;

  before(async () => {
    a = await abrirAmbienteCentral();
    app = a.criarApp();
    // MASTER da empresa A pelo provisionamento REAL do escopo (nada é concedido só pelo nome do perfil); a empresa B fica sem provisionar.
    await provisionamento.provisionar(a.ctx.pool, { empresaId: a.d.empresaA, dryRun: false });
    master = a.d.master;
  });
  after(async () => { if (a) await a.encerrar(); });

  const A = () => a.d.empresaA;
  const B = () => a.d.empresaB;
  const como = (usuarioId) => a.admin(app, usuarioId);
  const comuns = async (empresaId, opcoes) => a.usuario(empresaId, opcoes);
  /** Todas as superfícies de LEITURA da Central (a existente e as propostas), com um dispositivo e um funcionário válidos. */
  async function superficies(empresaId) {
    const x = await a.dispositivoEm(empresaId, 'PENDENTE');
    const ghe = await a.ghe(empresaId);
    const f = await a.funcionarioNoGhe(empresaId, ghe);
    return {
      existentes: [['lista', `${RAIZ}/dispositivos`], ['detalhe', `${RAIZ}/dispositivos/${x.id}`]],
      novas: [['visão geral', `${RAIZ}/visao-geral`], ['estado da ativação', `${RAIZ}/dispositivos/${x.id}/ativacao`], ['prévia', `${RAIZ}/previa/catalogo?funcionarioId=${f.id}`]],
      dispositivo: x,
      funcionario: f,
    };
  }

  // ───────────── controles das Etapas B e C (devem passar já no RED) ─────────────
  describe('controles B e C (devem passar já)', () => {
    test('K1 — a jornada administrativa já existe ponta a ponta com as rotas REAIS: cadastrar → listar → editar → gerar ativação → o tablet consome o código → revogar; cada passo na empresa e com o ator da sessão', async () => {
      const gestor = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO', 'TOKEN_REVOGAR_DISPOSITIVO'] });
      const criado = await como(gestor).post(`${RAIZ}/dispositivos`, { nome: a.unico('Jornada'), localInstalacao: 'Portaria' });
      assert.equal(criado.status, 201, aviso(criado));
      assert.equal(criado.body.dispositivo.situacao, 'PENDENTE');
      const id = criado.body.dispositivo.id;
      assert.equal((await como(gestor).get(`${RAIZ}/dispositivos`)).body.dispositivos.some((x) => x.id === id), true);
      const editado = await como(gestor).patch(`${RAIZ}/dispositivos/${id}`, { setor: 'Expedição' });
      assert.deepEqual([editado.status, editado.body.alterado], [200, true], aviso(editado));
      const ativacao = await como(gestor).post(`${RAIZ}/dispositivos/${id}/ativacao`);
      assert.equal(ativacao.status, 201, aviso(ativacao));
      await a.redes(a.redeDeTeste);
      const consumo = await a.ativar(app, ativacao.body.ativacao.codigo);
      assert.equal(consumo.status, 200, aviso(consumo));
      assert.ok(cookieDoTabletNaResposta(consumo), 'o tablet recebe a credencial pelo cookie');
      assert.equal((await como(gestor).get(`${RAIZ}/dispositivos/${id}`)).body.dispositivo.situacao, 'ATIVO');
      const revogado = await como(gestor).post(`${RAIZ}/dispositivos/${id}/revogar`);
      assert.deepEqual([revogado.status, revogado.body.dispositivo.situacao], [200, 'REVOGADO'], aviso(revogado));
      assert.equal((await a.q('SELECT empresa_id, criado_por, revogado_por FROM token_dispositivos WHERE id = $1', [id])).rows[0].revogado_por, gestor);
    });

    test('K2 — as seis ações TOKEN_* e os modos de autorização estão no catálogo real: GERENCIAR_REDES é OBRIGATORIA (só concessão individual) e as outras cinco são ALTERNATIVA; nenhuma exige SST', async () => {
      const { rows } = await a.q("SELECT codigo, modo_autorizacao_individual AS modo, exige_sst FROM acoes WHERE codigo LIKE 'TOKEN\\_%' ORDER BY codigo");
      assert.deepEqual(rows.map((r) => r.codigo), [...ACOES_TOKEN].sort());
      for (const r of rows) {
        assert.equal(r.exige_sst, false, r.codigo);
        assert.equal(r.modo, r.codigo === 'TOKEN_GERENCIAR_REDES' ? 'OBRIGATORIA' : 'ALTERNATIVA', r.codigo);
      }
    });

    test('K3 — a rede autorizada já protege o tablet (Etapa C): só o tablet consome código de dentro da rede; fora dela, REDE_NAO_AUTORIZADA. A gestão administrativa das redes (Etapa H, D5) exige a ação TOKEN_GERENCIAR_REDES: quem só tem o recurso recebe 403', async () => {
      const x = await a.dispositivo(A(), { nome: a.unico('Rede') });
      const codigo = await a.codigoPendente(x);
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '198.51.100.7/32' }], B: [] });
      const fora = await a.ativar(app, codigo);
      assert.deepEqual([fora.status, fora.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(fora));
      await a.redes(a.redeDeTeste);
      const soRecurso = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO', 'TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_PREVIA_CATALOGO_REAL'] });
      erroSeguro(await como(soRecurso).get(`${RAIZ}/redes`), 403, 'PERMISSAO_NEGADA', 'redes sem a ação');
    });
  });

  // ───────────── acesso, permissões e isolamento ─────────────
  describe('acesso, permissões e isolamento', () => {
    test('H1 — o administrador autorizado (MASTER provisionado) acessa os dados reais da Central: lista e detalhe dos dispositivos da sua empresa, com o contrato congelado da B', async () => {
      const x = await a.dispositivoEm(A(), 'ATIVO');
      const lista = await como(master).get(`${RAIZ}/dispositivos`);
      assert.equal(lista.status, 200, aviso(lista));
      assert.equal(lista.body.dispositivos.some((d) => d.id === x.id), true);
      assert.equal((await como(master).get(`${RAIZ}/dispositivos/${x.id}`)).body.dispositivo.situacao, 'ATIVO');
    });

    test('H1b — o mesmo administrador acessa a Visão Geral, o estado da ativação e a prévia (superfícies novas da Central), todos 200 e na empresa da sessão', async () => {
      const s = await superficies(A());
      for (const [rotulo, url] of s.novas) {
        const r = await como(master).get(url);
        assert.equal(r.status, 200, `${rotulo}: ${aviso(r)}`);
      }
    });

    test('H2 — quem NÃO tem permissão recebe acesso negado (403) em TODA a Central, existente e nova, e nada é criado; sem sessão é 401', async () => {
      const semNada = await comuns(A(), {});
      const s = await superficies(A());
      for (const [rotulo, url] of [...s.existentes, ...s.novas]) {
        erroSeguro(await como(semNada).get(url), 403, 'PERMISSAO_NEGADA', rotulo);
      }
      for (const [rotulo, url] of [...s.existentes, ...s.novas]) {
        const r = await request(app).get(url);
        assert.equal(r.status, 401, `${rotulo} sem sessão: ${aviso(r)}`);
      }
    });

    test('H3 — visualizar NÃO autoriza criar, editar, revogar nem gerar ativação (controle B/C); e visualizar basta para a Visão Geral e o estado da ativação, mas NÃO para a prévia, que exige a ação própria', async () => {
      const leitor = await comuns(A(), { operacoes: ['visualizar'] });
      const s = await superficies(A());
      const id = s.dispositivo.id;
      assert.equal((await como(leitor).post(`${RAIZ}/dispositivos`, { nome: a.unico('Leitor') })).status, 403);
      assert.equal((await como(leitor).patch(`${RAIZ}/dispositivos/${id}`, { setor: 'X' })).status, 403);
      assert.equal((await como(leitor).post(`${RAIZ}/dispositivos/${id}/revogar`)).status, 403);
      assert.equal((await como(leitor).post(`${RAIZ}/dispositivos/${id}/ativacao`)).status, 403);
      assert.equal((await como(leitor).get(`${RAIZ}/dispositivos`)).status, 200);
      assert.equal((await como(leitor).get(`${RAIZ}/visao-geral`)).status, 200, 'visualizar basta para a Visão Geral');
      assert.equal((await como(leitor).get(`${RAIZ}/dispositivos/${id}/ativacao`)).status, 200, 'visualizar basta para o estado da ativação');
      erroSeguro(await como(leitor).get(`${RAIZ}/previa/catalogo?funcionarioId=${s.funcionario.id}`), 403, 'PERMISSAO_NEGADA', 'prévia');
    });

    test('H4 — isolamento entre empresas nas superfícies existentes: o administrador da B não vê nem toca os dispositivos da A (404 idêntico ao inexistente) e a lista da B só tem os da B', async () => {
      const gestorB = await comuns(B(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
      const daA = await a.dispositivoEm(A(), 'ATIVO');
      const daB = await a.dispositivoEm(B(), 'PENDENTE');
      const lista = await como(gestorB).get(`${RAIZ}/dispositivos?limite=100`);
      assert.equal(lista.status, 200, aviso(lista));
      assert.equal(lista.body.dispositivos.some((d) => d.id === daA.id), false);
      assert.equal(lista.body.dispositivos.some((d) => d.id === daB.id), true);
      for (const r of [await como(gestorB).get(`${RAIZ}/dispositivos/${daA.id}`), await como(gestorB).patch(`${RAIZ}/dispositivos/${daA.id}`, { setor: 'Invasão' }),
        await como(gestorB).post(`${RAIZ}/dispositivos/${daA.id}/revogar`), await como(gestorB).post(`${RAIZ}/dispositivos/${daA.id}/ativacao`)]) {
        erroSeguro(r, 404, 'DISPOSITIVO_NAO_ENCONTRADO');
      }
      assert.equal((await a.linha(daA.id)).revogado_em, null);
    });

    test('H4b — isolamento nas superfícies novas: o estado da ativação do dispositivo da A, pedido pela B, é o 404 do inexistente; a Visão Geral da B só conta a B; a prévia de funcionário da A, pela B, é o 404 do inexistente', async () => {
      const gestorB = await comuns(B(), { operacoes: ['visualizar'], acoes: ['TOKEN_PREVIA_CATALOGO_REAL'] });
      const daA = await a.dispositivoEm(A(), 'PENDENTE');
      const gheA = await a.ghe(A());
      const fA = await a.funcionarioNoGhe(A(), gheA);
      erroSeguro(await como(gestorB).get(`${RAIZ}/dispositivos/${daA.id}/ativacao`), 404, 'DISPOSITIVO_NAO_ENCONTRADO', 'ativação');
      erroSeguro(await como(gestorB).get(`${RAIZ}/previa/catalogo?funcionarioId=${fA.id}`), 404, 'FUNCIONARIO_NAO_ENCONTRADO', 'prévia');
      const visao = await como(gestorB).get(`${RAIZ}/visao-geral`);
      assert.equal(visao.status, 200, aviso(visao));
      assert.deepEqual(visao.body.visaoGeral, await a.contagensReais(B()), 'a Visão Geral da B é a contagem da B');
    });
  });

  // ───────────── dispositivos e ativação (controles B/C + estado novo) ─────────────
  describe('dispositivos e ativação', () => {
    test('H5/H6/H7 — lista de dispositivos REAIS, cadastro e edição de campos permitidos pelas operações existentes (contrato B congelado: situação derivada, sem segredo; campos de autoridade são 400)', async () => {
      const gestor = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'] });
      const criado = await como(gestor).post(`${RAIZ}/dispositivos`, { nome: a.unico('Central'), unidade: 'Fábrica 1', setor: 'Expedição', localInstalacao: 'Portaria' });
      assert.equal(criado.status, 201, aviso(criado));
      assert.equal(criado.body.dispositivo.localInstalacao, 'Portaria');
      const lista = await como(gestor).get(`${RAIZ}/dispositivos?limite=100`);
      assert.deepEqual(Object.keys(lista.body).sort(), ['dispositivos', 'limite', 'pagina', 'status', 'total']);
      assert.equal(lista.body.total, (await a.q('SELECT count(*)::int AS n FROM token_dispositivos WHERE empresa_id = $1', [A()])).rows[0].n);
      const id = criado.body.dispositivo.id;
      const editado = await como(gestor).patch(`${RAIZ}/dispositivos/${id}`, { localInstalacao: 'Refeitório', modelo: 'Tab 10' });
      assert.deepEqual([editado.status, editado.body.alterado, editado.body.dispositivo.localInstalacao], [200, true, 'Refeitório'], aviso(editado));
      for (const proibido of [{ empresaId: B() }, { criadoPor: 1 }, { situacao: 'ATIVO' }, { identificador: 'x' }, { credencial: 'x' }]) {
        erroSeguro(await como(gestor).patch(`${RAIZ}/dispositivos/${id}`, proibido), 400, 'VALIDACAO');
      }
      semSegredo([criado.body, lista.body, editado.body], 'dispositivos');
    });

    test('H8 — revogação com autorização granular: só a ação TOKEN_REVOGAR_DISPOSITIVO revoga; revogar cancela a ativação pendente e encerra o atendimento; repetir é idempotente (alterado:false)', async () => {
      const sem = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO'] });
      const com = await comuns(A(), { acoes: ['TOKEN_REVOGAR_DISPOSITIVO'] });
      const x = await a.dispositivoEm(A(), 'ATIVO');
      await a.codigoPendente(x);
      erroSeguro(await como(sem).post(`${RAIZ}/dispositivos/${x.id}/revogar`), 403, 'PERMISSAO_NEGADA');
      const r = await como(com).post(`${RAIZ}/dispositivos/${x.id}/revogar`);
      assert.deepEqual([r.status, r.body.alterado, r.body.dispositivo.situacao], [200, true, 'REVOGADO'], aviso(r));
      assert.equal((await a.ativacoesDe(x.id)).every((v) => v.usado_em !== null || v.cancelado_em !== null), true, 'nenhuma ativação segue pendente');
      assert.equal((await como(com).post(`${RAIZ}/dispositivos/${x.id}/revogar`)).body.alterado, false);
    });

    test('H9/H10 — gerar ativação exige SÓ a ação TOKEN_GERAR_ATIVACAO; o código tem uso único e validade de até 10 minutos, aparece UMA vez na geração e nunca em lista, detalhe nem auditoria; gerar de novo cancela o anterior', async () => {
      const gera = await comuns(A(), { acoes: ['TOKEN_GERAR_ATIVACAO'] });
      const leitor = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'] });
      const x = await a.dispositivoEm(A(), 'PENDENTE');
      erroSeguro(await como(leitor).post(`${RAIZ}/dispositivos/${x.id}/ativacao`), 403, 'PERMISSAO_NEGADA');
      const antes = Date.now();
      const g1 = await como(gera).post(`${RAIZ}/dispositivos/${x.id}/ativacao`);
      assert.equal(g1.status, 201, aviso(g1));
      const dados = g1.body.ativacao;
      assert.match(dados.codigo, /^[A-Za-z0-9_-]{43}$/);
      const validade = new Date(dados.expiraEm).getTime() - antes;
      assert.ok(validade > 0 && validade <= 10 * 60 * 1000 + 5000, `validade ${validade} ms`);
      const g2 = await como(gera).post(`${RAIZ}/dispositivos/${x.id}/ativacao`);
      const linhas = await a.ativacoesDe(x.id);
      assert.equal(linhas.length, 2);
      assert.deepEqual(linhas.map((v) => v.cancelado_em !== null), [true, false], 'a anterior foi cancelada; só a nova está pendente');
      const detalhe = await como(master).get(`${RAIZ}/dispositivos/${x.id}`);
      const lista = await como(master).get(`${RAIZ}/dispositivos?limite=100`);
      for (const codigo of [dados.codigo, g2.body.ativacao.codigo]) {
        assert.equal(JSON.stringify([detalhe.body, lista.body]).includes(codigo), false, 'o código não volta em lista nem detalhe');
        assert.equal((await a.todaAuditoria(A())).some((l) => JSON.stringify(l).includes(codigo)), false, 'o código não vai à auditoria');
      }
    });

    test('H11 — o estado da ativação é consultável pela Central: NENHUMA → PENDENTE (com validade ≤ 10 min) → PENDENTE da nova (a anterior cancelada) → CONSUMIDA quando o tablet usa o código → PENDENTE na recuperação → CANCELADA ao revogar → EXPIRADA quando vence; nunca traz código, hash nem autor', async () => {
      const gera = await comuns(A(), { operacoes: ['visualizar'], acoes: ['TOKEN_GERAR_ATIVACAO', 'TOKEN_REVOGAR_DISPOSITIVO'] });
      await a.redes(a.redeDeTeste);
      const x = await a.dispositivo(A(), { nome: a.unico('Estado') });
      const estado = async () => {
        const r = await como(gera).get(`${RAIZ}/dispositivos/${x.id}/ativacao`);
        assert.equal(r.status, 200, aviso(r));
        semSegredo(r.body, 'estado');
        assert.equal(TOKEN43.test(JSON.stringify(r.body)), false, 'nenhum código de 43 caracteres em nenhum estado');
        assert.deepEqual(Object.keys(r.body.ativacao).sort(), [...CHAVES_DA_ATIVACAO], 'só as chaves do contrato, em todos os estados');
        return r.body.ativacao;
      };
      let e = await estado();
      assert.equal(e.estado, 'NENHUMA');
      assert.deepEqual([e.geradaEm, e.expiraEm, e.usadaEm, e.canceladaEm], [null, null, null, null]);
      const g1 = await como(gera).post(`${RAIZ}/dispositivos/${x.id}/ativacao`);
      e = await estado();
      assert.equal(e.estado, 'PENDENTE');
      assert.ok(new Date(e.expiraEm) - new Date(e.geradaEm) <= 10 * 60 * 1000);
      const g2 = await como(gera).post(`${RAIZ}/dispositivos/${x.id}/ativacao`);
      assert.equal((await estado()).estado, 'PENDENTE', 'a mais recente é a pendente; a anterior ficou cancelada');
      const consumo = await a.ativar(app, g2.body.ativacao.codigo);
      assert.equal(consumo.status, 200, aviso(consumo));
      e = await estado();
      assert.equal(e.estado, 'CONSUMIDA');
      assert.notEqual(e.usadaEm, null);
      assert.equal((await como(gera).post(`${RAIZ}/dispositivos/${x.id}/ativacao`)).status, 201);
      assert.equal((await estado()).estado, 'PENDENTE', 'recuperação de tablet ativo');
      await como(gera).post(`${RAIZ}/dispositivos/${x.id}/revogar`);
      e = await estado();
      assert.equal(e.estado, 'CANCELADA');
      assert.notEqual(e.canceladaEm, null);
      void g1;
      const y = await a.dispositivo(A(), { nome: a.unico('Expirada') });
      await a.codigoPendente(y, { criadoHaMinutos: 20, validadeMinutos: 10 });
      const vencida = await como(gera).get(`${RAIZ}/dispositivos/${y.id}/ativacao`);
      assert.equal(vencida.body.ativacao.estado, 'EXPIRADA', aviso(vencida));
    });

    test('H12 — dispositivo REVOGADO não é reativado indevidamente: gerar ativação é 409 DISPOSITIVO_REVOGADO, editar é 409, o código antigo não ativa mais e a credencial segue zerada', async () => {
      const gestor = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO', 'TOKEN_REVOGAR_DISPOSITIVO'] });
      await a.redes(a.redeDeTeste);
      const x = await a.dispositivo(A(), { nome: a.unico('Revogado') });
      const codigo = await a.codigoPendente(x);
      assert.equal((await como(gestor).post(`${RAIZ}/dispositivos/${x.id}/revogar`)).status, 200);
      erroSeguro(await como(gestor).post(`${RAIZ}/dispositivos/${x.id}/ativacao`), 409, 'DISPOSITIVO_REVOGADO');
      erroSeguro(await como(gestor).patch(`${RAIZ}/dispositivos/${x.id}`, { setor: 'Depois' }), 409, 'DISPOSITIVO_REVOGADO');
      const usar = await a.ativar(app, codigo);
      assert.ok(usar.status >= 400, aviso(usar));
      const linha = await a.linha(x.id);
      assert.equal(linha.credencial_hash, null);
      assert.equal(linha.ativado_em, null);
    });
  });

  // ───────────── Visão Geral ─────────────
  describe('Visão Geral', () => {
    test('H13 — a Visão Geral é derivada do BANCO REAL da empresa da sessão: cadastrados, ativos, pendentes, revogados, ativações pendentes e situação geral conferem com SQL independente, só as chaves do contrato', async () => {
      await a.dispositivoEm(A(), 'PENDENTE');
      await a.dispositivoEm(A(), 'ATIVO');
      await a.dispositivoEm(A(), 'REVOGADO');
      const comAtivacao = await a.dispositivoEm(A(), 'PENDENTE');
      await a.codigoPendente(comAtivacao);
      const vencida = await a.dispositivoEm(A(), 'PENDENTE');
      await a.codigoPendente(vencida, { criadoHaMinutos: 30, validadeMinutos: 10 });
      const r = await como(master).get(`${RAIZ}/visao-geral`);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(Object.keys(r.body.visaoGeral).sort(), [...CHAVES_DA_VISAO_GERAL]);
      assert.deepEqual(Object.keys(r.body.visaoGeral.dispositivos).sort(), [...CHAVES_DOS_DISPOSITIVOS]);
      assert.deepEqual(r.body.visaoGeral, await a.contagensReais(A()));
      semSegredo(r.body, 'visão geral');
    });

    test('H13b — empresa SEM dispositivos: contagens zeradas e situação SEM_DISPOSITIVOS (não é erro); só com dispositivo revogado: SEM_DISPOSITIVO_ATIVO; ativação de outra empresa nunca conta', async () => {
      const { criarEmpresa } = require('./helpers/entrega-epi');
      const { inserirUsuario } = require('./helpers/solicitacao-epi-servico');
      const empresaC = await criarEmpresa(a.ctx.pool, '99887766000155', 'Empresa C Fictícia');
      const masterC = await inserirUsuario(a.ctx.pool, empresaC, 'master-c@example.invalid', 'MASTER');
      const leitorC = await inserirUsuario(a.ctx.pool, empresaC, 'leitor-c@example.invalid', 'USUARIO');
      await a.q(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por)
         VALUES ($1, $2, 'atendimentoToken', true, false, false, false, $3)`, [empresaC, leitorC, masterC],
      );
      const ler = async () => { const r = await como(leitorC).get(`${RAIZ}/visao-geral`); assert.equal(r.status, 200, aviso(r)); return r.body.visaoGeral; };
      assert.deepEqual(await ler(), { dispositivos: { cadastrados: 0, ativos: 0, pendentes: 0, revogados: 0 }, ativacoesPendentes: 0, situacaoGeral: 'SEM_DISPOSITIVOS' });
      await a.dispositivoEm(empresaC, 'REVOGADO', { criado_por: masterC });
      assert.deepEqual(await ler(), { dispositivos: { cadastrados: 1, ativos: 0, pendentes: 0, revogados: 1 }, ativacoesPendentes: 0, situacaoGeral: 'SEM_DISPOSITIVO_ATIVO' });
    });

    test('H14 — os indicadores não duplicam: cadastrados = ativos + pendentes + revogados (o revogado nunca conta como ativo nem pendente); a ativação vencida, usada ou cancelada não é "pendente"; muda em tempo real com a revogação e a ativação', async () => {
      const gestor = await comuns(A(), { operacoes: ['visualizar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
      const x = await a.dispositivoEm(A(), 'ATIVO');
      const ler = async () => { const r = await como(gestor).get(`${RAIZ}/visao-geral`); assert.equal(r.status, 200, aviso(r)); return r.body.visaoGeral; };
      let v = await ler();
      assert.equal(v.dispositivos.cadastrados, v.dispositivos.ativos + v.dispositivos.pendentes + v.dispositivos.revogados);
      const antes = v;
      assert.equal((await como(gestor).post(`${RAIZ}/dispositivos/${x.id}/revogar`)).status, 200);
      v = await ler();
      assert.deepEqual([v.dispositivos.ativos, v.dispositivos.revogados, v.dispositivos.cadastrados], [antes.dispositivos.ativos - 1, antes.dispositivos.revogados + 1, antes.dispositivos.cadastrados]);
      const p = await a.dispositivoEm(A(), 'PENDENTE');
      const g = await como(gestor).post(`${RAIZ}/dispositivos/${p.id}/ativacao`);
      assert.equal(g.status, 201);
      const depois = await ler();
      assert.equal(depois.ativacoesPendentes, v.ativacoesPendentes + 1);
      await como(gestor).post(`${RAIZ}/dispositivos/${p.id}/ativacao`);
      assert.equal((await ler()).ativacoesPendentes, depois.ativacoesPendentes, 'gerar de novo cancela a anterior: continua uma por dispositivo');
      assert.deepEqual(await ler(), await a.contagensReais(A()));
    });
  });

  // ───────────── segredos, autenticação e auditoria ─────────────
  describe('segredos, autenticação e auditoria', () => {
    test('H15 — nenhuma resposta administrativa existente expõe credencial, hash, segredo ou o código de ativação fora da geração (lista, detalhe, edição, revogação, geração sem o próprio código)', async () => {
      const x = await a.dispositivoEm(A(), 'ATIVO');
      await a.codigoPendente(x);
      const cred = x.credencial;
      const gestor = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO', 'TOKEN_REVOGAR_DISPOSITIVO'] });
      const respostas = [await como(gestor).get(`${RAIZ}/dispositivos?limite=100`), await como(gestor).get(`${RAIZ}/dispositivos/${x.id}`),
        await como(gestor).patch(`${RAIZ}/dispositivos/${x.id}`, { setor: 'Seguro' })];
      for (const r of respostas) { assert.equal(r.status, 200, aviso(r)); semSegredo(r.body, r.req.path, [cred]); }
      const g = await como(gestor).post(`${RAIZ}/dispositivos/${x.id}/ativacao`);
      const { codigo, ...resto } = g.body.ativacao;
      semSegredo(resto, 'geração (sem o código)');
      assert.match(codigo, TOKEN43);
    });

    test('H15b — nenhuma superfície NOVA expõe segredo: Visão Geral, estado da ativação e prévia não trazem credencial, hash, código de ativação, CPF ou matrícula', async () => {
      const s = await superficies(A());
      await a.codigoPendente(s.dispositivo);
      for (const [rotulo, url] of s.novas) {
        const r = await como(master).get(url);
        assert.equal(r.status, 200, `${rotulo}: ${aviso(r)}`);
        semSegredo(r.body, rotulo);
        const texto = JSON.stringify(r.body);
        assert.equal(texto.includes(s.funcionario.cpf), false, `${rotulo}: CPF`);
        assert.equal(texto.includes(String(s.funcionario.matricula)), false, `${rotulo}: matrícula`);
      }
    });

    test('H16 — o MASTER recebe pelo PROVISIONAMENTO REAL do escopo (não pelo nome do perfil): atendimentoToken visualizar/criar/editar e as ações de revogar e gerar ativação; excluir não existe; a empresa B (sem provisionar) não tem nada', async () => {
      const contexto = { empresaId: A(), usuarioId: master, perfil: 'MASTER' };
      assert.deepEqual(await avaliarPermissaoRecurso(a.ctx.pool, contexto, 'atendimentoToken'), { visualizar: true, criar: true, editar: true, excluir: false });
      for (const acao of ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO']) assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, acao), true, acao);
      const emB = { empresaId: B(), usuarioId: a.d.masterB, perfil: 'MASTER' };
      assert.equal((await avaliarPermissaoRecurso(a.ctx.pool, emB, 'atendimentoToken')).visualizar, false);
      for (const acao of ACOES_TOKEN) assert.equal(await avaliarPermissaoAcao(a.ctx.pool, emB, acao), false, `B ${acao}`);
    });

    test('H16b — o MASTER provisionado também recebe a ação da prévia e a de gerenciar redes (as rotas que as aplicam passam a existir); as ações de Monitoramento e Histórico (Etapa J) NÃO são concedidas ao MASTER por esta etapa', async () => {
      const contexto = { empresaId: A(), usuarioId: master, perfil: 'MASTER' };
      assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, 'TOKEN_PREVIA_CATALOGO_REAL'), true);
      assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, 'TOKEN_GERENCIAR_REDES'), true);
      for (const acao of ['TOKEN_VISUALIZAR_MONITORAMENTO', 'TOKEN_VISUALIZAR_HISTORICO']) assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, acao), false, `${acao} é da Etapa J`);
    });

    test('H17 — permissões por GRUPO e por USUÁRIO valem na Central: grupo com atendimentoToken.visualizar lista; ação concedida por grupo (ALTERNATIVA) revoga; exceção individual negativa e bloqueio de ação têm a última palavra; TOKEN_GERENCIAR_REDES (OBRIGATORIA) NÃO vem de grupo, só de concessão individual', async () => {
      const x = await a.dispositivoEm(A(), 'ATIVO');
      const membro = await comuns(A(), {});
      const { rows: [{ id: grupo }] } = await a.q('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [A(), a.unico('Grupo Token'), master]);
      await a.q("INSERT INTO grupo_permissoes_recurso (empresa_id, grupo_acesso_id, recurso, pode_visualizar) VALUES ($1, $2, 'atendimentoToken', true)", [A(), grupo]);
      await a.q("INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, 'TOKEN_REVOGAR_DISPOSITIVO', true)", [A(), grupo]);
      await a.q("INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, 'TOKEN_GERENCIAR_REDES', true)", [A(), grupo]);
      await a.q('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupo, membro]);
      const contexto = { empresaId: A(), usuarioId: membro, perfil: 'USUARIO' };
      assert.equal((await como(membro).get(`${RAIZ}/dispositivos`)).status, 200, 'o grupo concede a leitura');
      assert.equal((await como(membro).post(`${RAIZ}/dispositivos`, { nome: a.unico('x') })).status, 403, 'o grupo não concedeu criar');
      assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, 'TOKEN_REVOGAR_DISPOSITIVO'), true);
      assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, 'TOKEN_GERENCIAR_REDES'), false, 'OBRIGATORIA: grupo não basta');
      await a.q("INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, 'TOKEN_GERENCIAR_REDES', $3)", [A(), membro, master]);
      assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, 'TOKEN_GERENCIAR_REDES'), true, 'só a concessão individual vale');
      await a.q("INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, pode_criar, pode_editar, pode_excluir, concedido_por) VALUES ($1, $2, 'atendimentoToken', false, false, false, false, $3)", [A(), membro, master]);
      assert.equal((await como(membro).get(`${RAIZ}/dispositivos`)).status, 403, 'a exceção individual negativa vence o grupo');
      await a.q("INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, 'TOKEN_REVOGAR_DISPOSITIVO', $2)", [membro, master]);
      assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, 'TOKEN_REVOGAR_DISPOSITIVO'), false, 'o bloqueio individual é a última palavra');
      assert.equal((await como(membro).post(`${RAIZ}/dispositivos/${x.id}/revogar`)).status, 403);
    });

    test('H18 — as seis ações TOKEN_* nascem NEGADAS: usuário comum sem concessão não tem nenhuma (nem o recurso), em qualquer perfil não-MASTER; a avaliação é a mesma que o middleware usa', async () => {
      for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
        const u = await comuns(A(), { perfil });
        const contexto = { empresaId: A(), usuarioId: u, perfil };
        assert.deepEqual(await avaliarPermissaoRecurso(a.ctx.pool, contexto, 'atendimentoToken'), { visualizar: false, criar: false, editar: false, excluir: false }, perfil);
        for (const acao of ACOES_TOKEN) assert.equal(await avaliarPermissaoAcao(a.ctx.pool, contexto, acao), false, `${perfil} ${acao}`);
      }
    });

    test('H27/H28 — NENHUMA autenticação paralela: as superfícies administrativas (existentes e novas) só aceitam a sessão administrativa; o cookie do TABLET e o do atendimento não autenticam a Central, e a sessão administrativa não autentica o tablet', async () => {
      const s = await superficies(A());
      const tablet = await a.ativado(A());
      for (const [rotulo, url] of [...s.existentes, ...s.novas]) {
        const r = await request(app).get(url).set('Cookie', cookieDoTablet(tablet.credencial));
        assert.equal(r.status, 401, `${rotulo} com cookie de tablet: ${aviso(r)}`);
      }
      const comoAdminNoTablet = await como(master).post('/api/atendimento-token/tablet/ativar', { codigo: 'a'.repeat(43) });
      assert.ok([400, 401, 403, 404].includes(comoAdminNoTablet.status) && comoAdminNoTablet.body.codigo !== 'OK', aviso(comoAdminNoTablet));
    });

    test('H29 — auditoria das ações sensíveis, sem segredo: cadastrar, alterar, revogar e gerar ativação deixam linha com o ator e a empresa da sessão (controle B/C); a CONSULTA de prévia com catálogo real também é auditada, só com ids', async () => {
      const gestor = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO', 'TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_PREVIA_CATALOGO_REAL'] });
      const criado = await como(gestor).post(`${RAIZ}/dispositivos`, { nome: a.unico('Audit') });
      const id = criado.body.dispositivo.id;
      await como(gestor).patch(`${RAIZ}/dispositivos/${id}`, { setor: 'A' });
      const g = await como(gestor).post(`${RAIZ}/dispositivos/${id}/ativacao`);
      await como(gestor).post(`${RAIZ}/dispositivos/${id}/revogar`);
      for (const acao of ['TOKEN_DISPOSITIVO_CADASTRADO', 'TOKEN_DISPOSITIVO_ALTERADO', 'TOKEN_ATIVACAO_GERADA', 'TOKEN_DISPOSITIVO_REVOGADO']) {
        const linhas = (await a.auditorias(acao)).filter((l) => l.usuario_id === gestor);
        assert.equal(linhas.length, 1, acao);
        assert.equal(JSON.stringify(linhas[0]).includes(g.body.ativacao.codigo), false, `${acao}: sem código`);
      }
      const ghe = await a.ghe(A());
      const f = await a.funcionarioNoGhe(A(), ghe);
      const previa = await como(gestor).get(`${RAIZ}/previa/catalogo?funcionarioId=${f.id}`);
      assert.equal(previa.status, 200, aviso(previa));
      const consultas = (await a.auditorias('TOKEN_PREVIA_CONSULTADA')).filter((l) => l.usuario_id === gestor);
      assert.equal(consultas.length, 1);
      assert.equal(String(consultas[0].referencia), String(f.id));
      assert.deepEqual(Object.keys(consultas[0].contexto ?? {}), ['total'], 'o contexto da auditoria da prévia leva só a contagem, nunca materiais, dados do funcionário ou quantidades');
      assert.equal(consultas[0].dados_novos, null);
      assert.equal(consultas[0].dados_anteriores, null);
      const texto = JSON.stringify(consultas[0]);
      assert.equal(texto.includes(f.cpf) || texto.includes(String(f.matricula)) || texto.includes(f.nome), false, 'só ids');
    });

    test('H30 — contratos de erro SEGUROS e consistentes: 400 VALIDACAO, 401, 403 PERMISSAO_NEGADA, 404 DISPOSITIVO_NAO_ENCONTRADO / FUNCIONARIO_NAO_ENCONTRADO e 409 têm o mesmo formato {status:"error", codigo, message}, sem stack, SQL, caminho local nem segredo — nas superfícies existentes e nas novas', async () => {
      const gestor = await comuns(A(), { operacoes: ['visualizar'], acoes: ['TOKEN_PREVIA_CATALOGO_REAL'] });
      const s = await superficies(A());
      erroSeguro(await como(gestor).get(`${RAIZ}/dispositivos/abc`), 400, 'VALIDACAO', 'id inválido');
      erroSeguro(await como(gestor).get(`${RAIZ}/dispositivos/2147483000/ativacao`), 404, 'DISPOSITIVO_NAO_ENCONTRADO', 'ativação inexistente');
      erroSeguro(await como(gestor).get(`${RAIZ}/previa/catalogo`), 400, 'VALIDACAO', 'prévia sem funcionário');
      erroSeguro(await como(gestor).get(`${RAIZ}/previa/catalogo?funcionarioId=abc`), 400, 'VALIDACAO', 'prévia id inválido');
      erroSeguro(await como(gestor).get(`${RAIZ}/previa/catalogo?funcionarioId=${s.funcionario.id}&empresaId=${A()}`), 400, 'VALIDACAO', 'prévia com empresa do cliente');
      erroSeguro(await como(gestor).get(`${RAIZ}/previa/catalogo?funcionarioId=2147483000`), 404, 'FUNCIONARIO_NAO_ENCONTRADO', 'prévia funcionário inexistente');
      erroSeguro(await como(gestor).get(`${RAIZ}/visao-geral?empresaId=${B()}`), 400, 'VALIDACAO', 'visão geral com empresa do cliente');
    });
  });

  // ───────────── prévia estritamente não operacional ─────────────
  describe('prévia (somente leitura, com dados reais autorizados)', () => {
    async function cenario() {
      const ghe = await a.ghe(A());
      const botina = await a.material(A(), { nome: 'H Botina', exigeTamanho: true, grade: ['P', 'M'] });
      const protetor = await a.material(A(), { nome: 'H Protetor', exigeTamanho: false });
      await a.vincularMaterial(A(), ghe, botina);
      await a.vincularMaterial(A(), ghe, protetor);
      const f = await a.funcionarioNoGhe(A(), ghe);
      const outroGhe = await a.ghe(A());
      const naoAutorizado = await a.material(A(), { nome: 'H Fora do GHE', exigeTamanho: false });
      await a.vincularMaterial(A(), outroGhe, naoAutorizado);
      return { f, botina, protetor, naoAutorizado };
    }

    test('H19 — a prévia mostra EXATAMENTE o catálogo real que o tablet mostraria ao funcionário (autorizado pelo GHE atual), só por GET, com a ação TOKEN_PREVIA_CATALOGO_REAL; outros verbos nunca são aceitos', async () => {
      const c = await cenario();
      const previa = await comuns(A(), { acoes: ['TOKEN_PREVIA_CATALOGO_REAL'] });
      const r = await como(previa).get(`${RAIZ}/previa/catalogo?funcionarioId=${c.f.id}`);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(Object.keys(r.body.previa).sort(), ['catalogo']);
      assert.deepEqual(r.body.previa.catalogo.materiais.map((m) => m.id).sort((x, y) => x - y), [c.botina, c.protetor].sort((x, y) => x - y));
      assert.equal(r.body.previa.catalogo.materiais.some((m) => m.id === c.naoAutorizado), false, 'material de outro GHE não aparece');
      assert.deepEqual(r.body.previa.catalogo.materiais.find((m) => m.id === c.botina).tamanhos, ['P', 'M'], 'a grade na ordem cadastrada, como no tablet');
      for (const metodo of ['post', 'put', 'patch', 'delete']) {
        const x = await como(previa)[metodo](`${RAIZ}/previa/catalogo?funcionarioId=${c.f.id}`);
        assert.ok(x.status >= 400, `${metodo}: ${aviso(x)}`);
      }
    });

    test('H19b — funcionário INATIVO ou AFASTADO não tem prévia (o tablet também não o atenderia): 409 FUNCIONARIO_NAO_ELEGIVEL, sem catálogo', async () => {
      const c = await cenario();
      const previa = await comuns(A(), { acoes: ['TOKEN_PREVIA_CATALOGO_REAL'] });
      for (const situacao of ['INATIVO', 'AFASTADO']) {
        await a.q('UPDATE funcionarios SET situacao = $2 WHERE id = $1', [c.f.id, situacao]);
        const r = await como(previa).get(`${RAIZ}/previa/catalogo?funcionarioId=${c.f.id}`);
        erroSeguro(r, 409, 'FUNCIONARIO_NAO_ELEGIVEL', situacao);
        assert.equal(JSON.stringify(r.body).includes('materiais'), false);
      }
    });

    test('H20 — a prévia NÃO cria solicitações: nenhum pedido, item, lateral, número, atendimento nem funcionário novo, mesmo repetida e com todos os dados reais', async () => {
      const c = await cenario();
      const previa = await comuns(A(), { acoes: ['TOKEN_PREVIA_CATALOGO_REAL'] });
      const antes = await a.fotografiaOperacional();
      for (let i = 0; i < 3; i += 1) assert.equal((await como(previa).get(`${RAIZ}/previa/catalogo?funcionarioId=${c.f.id}`)).status, 200);
      const depois = await a.fotografiaOperacional();
      assert.deepEqual([depois.solicitacoes, depois.itens, depois.autoatendimento, depois.numeracao, depois.atendimentos, depois.funcionarios],
        [antes.solicitacoes, antes.itens, antes.autoatendimento, antes.numeracao, antes.atendimentos, antes.funcionarios]);
    });

    test('H21 — a prévia NÃO altera estoque, reservas, entregas nem fichas: lotes, operações, entregas e fichas idênticos; e a Visão Geral também é só leitura (dispositivos e ativações idênticos)', async () => {
      const c = await cenario();
      await a.material(A(), { nome: 'H Com estoque', exigeTamanho: false, lotes: [{ quantidade: 5 }] });
      const previa = await comuns(A(), { operacoes: ['visualizar'], acoes: ['TOKEN_PREVIA_CATALOGO_REAL'] });
      const antes = await a.fotografiaOperacional();
      assert.equal((await como(previa).get(`${RAIZ}/previa/catalogo?funcionarioId=${c.f.id}`)).status, 200);
      assert.equal((await como(previa).get(`${RAIZ}/visao-geral`)).status, 200);
      assert.deepEqual(await a.fotografiaOperacional(), antes);
    });

    test('H19c — a prévia não revela o funcionário (nome, CPF, matrícula, GHE) nem o estoque: a resposta é só o catálogo, igual à do tablet', async () => {
      const c = await cenario();
      const previa = await comuns(A(), { acoes: ['TOKEN_PREVIA_CATALOGO_REAL'] });
      const r = await como(previa).get(`${RAIZ}/previa/catalogo?funcionarioId=${c.f.id}`);
      assert.equal(r.status, 200, aviso(r));
      const texto = JSON.stringify(r.body).toLowerCase();
      for (const proibido of [c.f.cpf, String(c.f.matricula), c.f.nome, 'saldo', 'lote', 'quantidadeentrada', 'cpf', 'matricula']) {
        assert.equal(texto.includes(String(proibido).toLowerCase()), false, `a prévia não pode conter "${proibido}"`);
      }
    });
  });

  // ───────────── separação entre H e J ─────────────
  describe('separação entre as Etapas H e J', () => {
    test('H24 — NADA da Etapa J foi antecipado: nenhuma rota de monitoramento, heartbeat, alertas, histórico de eventos ou carrinhos abandonados responde sob a administração do Token, e as ações MONITORAMENTO e HISTORICO não têm rota que as aplique', async () => {
      const u = await comuns(A(), { operacoes: ['visualizar'], acoes: ['TOKEN_VISUALIZAR_MONITORAMENTO', 'TOKEN_VISUALIZAR_HISTORICO'] });
      for (const caminho of ['monitoramento', 'historico', 'eventos', 'alertas', 'heartbeat', 'carrinhos-abandonados', 'atendimentos', 'dispositivos/1/eventos', 'dispositivos/1/historico']) {
        const r = await como(u).get(`${RAIZ}/${caminho}`);
        assert.equal(r.status, 404, `${caminho}: ${aviso(r)}`);
        assert.equal(r.body.codigo, 'ROTA_NAO_ENCONTRADA', caminho);
      }
      const { ACOES_COM_EFEITO } = require('../../src/rbac/recursos');
      assert.equal(ACOES_COM_EFEITO.includes('TOKEN_VISUALIZAR_MONITORAMENTO') || ACOES_COM_EFEITO.includes('TOKEN_VISUALIZAR_HISTORICO'), false);
    });

    test('H24b — o dispositivo do contrato congelado da B não ganhou campos operacionais: as chaves exatas continuam as da Etapa B (a situação ONLINE/OFFLINE e os eventos detalhados seguem na Etapa J)', async () => {
      const x = await a.dispositivoEm(A(), 'ATIVO');
      const r = await como(master).get(`${RAIZ}/dispositivos/${x.id}`);
      assert.deepEqual(Object.keys(r.body.dispositivo).sort(), ['ativadoEm', 'atualizadoEm', 'comunicacao', 'criadoEm', 'criadoPor', 'fabricante', 'id', 'identificador',
        'localInstalacao', 'modelo', 'nome', 'numeroSerie', 'revogadoEm', 'revogadoPor', 'setor', 'situacao', 'unidade']);
    });
  });

  // ───────────── dependentes de decisão (contratos pendentes) ─────────────
  describe('integração com a Gestão de Usuários (Etapa H)', () => {
    test('H17c — a Gestão de Usuários oferece os sete interruptores do Atendimento Token (consultar, cadastrar, editar, revogar, gerar ativação, redes, prévia) por um catálogo de acessos real, para conceder a usuários e grupos sem mexer em SQL', () => {
      const { TOGGLES, PENDENCIAS } = require('../../src/rbac/toggles');
      const ids = TOGGLES.map((t) => t.id);
      for (const id of ['tokenVisualizar', 'tokenCadastrar', 'tokenEditar', 'tokenRevogar', 'tokenGerarAtivacao', 'tokenRedes', 'tokenPrevia']) assert.ok(ids.includes(id), id);
      assert.equal(PENDENCIAS.some((p) => p.id === 'token'), false, 'a pendência genérica "token" deixa de existir');
      assert.ok(PENDENCIAS.some((p) => p.id === 'tokenMonitoramentoHistorico'), 'Monitoramento e Histórico seguem como pendência da Etapa J');
    });
  });

  // ───────────── redes autorizadas (D5): listar, cadastrar IP fixo exato, desativar ─────────────
  describe('redes autorizadas (TOKEN_GERENCIAR_REDES)', () => {
    const redesDe = async (empresaId) => (await a.q('SELECT id, tipo, host(rede) AS endereco, masklen(rede) AS mascara, descricao, desativada_em, desativada_por, criado_por FROM token_redes_autorizadas WHERE empresa_id = $1 ORDER BY id', [empresaId])).rows;
    const gerente = (empresaId = A()) => comuns(empresaId, { acoes: ['TOKEN_GERENCIAR_REDES'] });
    const IP = (n) => `203.0.113.${n}`;

    test('H31a — a ação é OBRIGATORIA: só concessão individual (ou o MASTER provisionado) lista, cadastra e desativa; recurso sozinho, ação de grupo e quem não tem nada recebem 403; sem sessão é 401; nada é criado nas recusas', async () => {
      const antes = await redesDe(A());
      const soRecurso = await comuns(A(), { operacoes: ['visualizar', 'criar', 'editar'] });
      const semNada = await comuns(A(), {});
      const doGrupo = await comuns(A(), {});
      const { rows: [{ id: grupo }] } = await a.q('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [A(), a.unico('Grupo Redes'), master]);
      await a.q("INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, 'TOKEN_GERENCIAR_REDES', true)", [A(), grupo]);
      await a.q('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupo, doGrupo]);
      for (const quem of [soRecurso, semNada, doGrupo]) {
        erroSeguro(await como(quem).get(`${RAIZ}/redes`), 403, 'PERMISSAO_NEGADA', 'listar');
        erroSeguro(await como(quem).post(`${RAIZ}/redes`, { rede: IP(1) }), 403, 'PERMISSAO_NEGADA', 'cadastrar');
        erroSeguro(await como(quem).post(`${RAIZ}/redes/1/desativar`), 403, 'PERMISSAO_NEGADA', 'desativar');
      }
      assert.equal((await request(app).get(`${RAIZ}/redes`)).status, 401);
      assert.deepEqual(await redesDe(A()), antes);
      assert.equal((await como(await gerente()).get(`${RAIZ}/redes`)).status, 200, 'a concessão individual basta');
      assert.equal((await como(master).get(`${RAIZ}/redes`)).status, 200, 'o MASTER provisionado também');
    });

    test('H31b — cadastra IP fixo EXATO na empresa da sessão: IPv4 vira /32, IPv6 vira /128, tipo IP_FIXO, descrição aparada (em branco = nula), autoria da sessão; só as chaves do contrato', async () => {
      const g = await gerente();
      const v4 = await como(g).post(`${RAIZ}/redes`, { rede: ` ${IP(11)} `, descricao: '  Portaria principal  ' });
      assert.equal(v4.status, 201, aviso(v4));
      assert.deepEqual(Object.keys(v4.body.rede).sort(), ['ativa', 'criadaEm', 'desativadaEm', 'descricao', 'endereco', 'id', 'tipo']);
      assert.deepEqual([v4.body.rede.tipo, v4.body.rede.endereco, v4.body.rede.descricao, v4.body.rede.ativa], ['IP_FIXO', IP(11), 'Portaria principal', true]);
      const v6 = await como(g).post(`${RAIZ}/redes`, { rede: '2001:DB8::10', descricao: '   ' });
      assert.equal(v6.status, 201, aviso(v6));
      assert.deepEqual([v6.body.rede.endereco, v6.body.rede.descricao], ['2001:db8::10', null]);
      const linhas = await redesDe(A());
      const l4 = linhas.find((l) => l.id === v4.body.rede.id);
      const l6 = linhas.find((l) => l.id === v6.body.rede.id);
      assert.deepEqual([l4.mascara, l6.mascara], [32, 128]);
      assert.deepEqual([l4.criado_por, l6.criado_por], [g, g]);
    });

    test('H31c — entradas inválidas são 400 e nada é gravado: faixa CIDR, intervalo, máscara, texto, vazio, endereço não utilizável, tipo TUNEL, empresa/autoria do cliente, campo extra, descrição acima de 150 ou com controle', async () => {
      const g = await gerente();
      const antes = await redesDe(A());
      const invalidos = [{ rede: '203.0.113.0/24' }, { rede: '203.0.113.7/32' }, { rede: '203.0.113.1-203.0.113.9' }, { rede: 'abc' }, { rede: '' }, { rede: '0.0.0.0' }, { rede: '::' },
        { rede: '256.1.1.1' }, { rede: '203.0.113.7%eth0' }, { rede: 12345 }, {}, { rede: IP(5), tipo: 'TUNEL' }, { rede: IP(5), empresaId: B() }, { rede: IP(5), criadoPor: 1 },
        { rede: IP(5), desativadaEm: 'x' }, { rede: IP(5), extra: true }, { rede: IP(5), descricao: 'x'.repeat(151) }, { rede: IP(5), descricao: 'a\u0007b' }];
      for (const corpo of invalidos) erroSeguro(await como(g).post(`${RAIZ}/redes`, corpo), 400, 'VALIDACAO', JSON.stringify(corpo).slice(0, 50));
      erroSeguro(await como(g).post(`${RAIZ}/redes?empresaId=${B()}`, { rede: IP(5) }), 400, 'VALIDACAO', 'query');
      assert.deepEqual(await redesDe(A()), antes);
    });

    test('H31d — o mesmo endereço ATIVO na empresa é 409 REDE_JA_AUTORIZADA; depois de desativado pode ser cadastrado de novo (novo registro); outra empresa pode ter o mesmo IP; e duas tentativas SIMULTÂNEAS geram exatamente uma rede ativa', async () => {
      const g = await gerente();
      const gb = await gerente(B());
      const primeira = await como(g).post(`${RAIZ}/redes`, { rede: IP(21) });
      assert.equal(primeira.status, 201, aviso(primeira));
      erroSeguro(await como(g).post(`${RAIZ}/redes`, { rede: IP(21) }), 409, 'REDE_JA_AUTORIZADA');
      assert.equal((await como(gb).post(`${RAIZ}/redes`, { rede: IP(21) })).status, 201, 'IP fixo pode coincidir entre empresas');
      assert.equal((await como(g).post(`${RAIZ}/redes/${primeira.body.rede.id}/desativar`)).status, 200);
      const nova = await como(g).post(`${RAIZ}/redes`, { rede: IP(21) });
      assert.equal(nova.status, 201, aviso(nova));
      assert.notEqual(nova.body.rede.id, primeira.body.rede.id, 'o histórico da desativada é preservado');
      const corrida = await Promise.all([1, 2, 3].map(() => como(g).post(`${RAIZ}/redes`, { rede: IP(22) })));
      assert.deepEqual(corrida.map((r) => r.status).sort(), [201, 409, 409], corrida.map(aviso).join(' | '));
      assert.equal((await redesDe(A())).filter((l) => l.endereco === IP(22) && l.desativada_em === null).length, 1);
    });

    test('H31e — lista só as redes da empresa da sessão, ativas primeiro, com total e paginação (limite fora de 1..100 é 400); nada de outra empresa', async () => {
      const g = await gerente();
      const gb = await gerente(B());
      await como(gb).post(`${RAIZ}/redes`, { rede: IP(31), descricao: 'da B' });
      const minha = await como(g).post(`${RAIZ}/redes`, { rede: IP(32) });
      const desativada = await como(g).post(`${RAIZ}/redes`, { rede: IP(33) });
      await como(g).post(`${RAIZ}/redes/${desativada.body.rede.id}/desativar`);
      const lista = await como(g).get(`${RAIZ}/redes?limite=100`);
      assert.equal(lista.status, 200, aviso(lista));
      assert.deepEqual(Object.keys(lista.body).sort(), ['limite', 'pagina', 'redes', 'status', 'total']);
      assert.equal(lista.body.total, (await redesDe(A())).length);
      assert.equal(lista.body.redes.some((r) => r.descricao === 'da B' || r.endereco === IP(31)), false, 'nada da B');
      const ativas = lista.body.redes.map((r) => r.ativa);
      assert.deepEqual(ativas, [...ativas].sort((x, y) => Number(y) - Number(x)), 'ativas antes das desativadas');
      assert.ok(lista.body.redes.find((r) => r.id === minha.body.rede.id).ativa);
      const pagina = await como(g).get(`${RAIZ}/redes?pagina=1&limite=1`);
      assert.equal(pagina.body.redes.length, 1);
      for (const q of ['limite=0', 'limite=101', 'pagina=0', 'empresaId=1', 'tipo=TUNEL']) erroSeguro(await como(g).get(`${RAIZ}/redes?${q}`), 400, 'VALIDACAO', q);
    });

    test('H31f — desativa SEM apagar: carimba data e autoria da sessão, mantém a linha; repetir é idempotente (200, alterado:false, sem nova auditoria); id de outra empresa ou inexistente é o mesmo 404 e nada muda; id inválido e corpo extra são 400; não existe DELETE, PUT nem PATCH', async () => {
      const g = await gerente();
      const gb = await gerente(B());
      const rede = await como(g).post(`${RAIZ}/redes`, { rede: IP(41) });
      const id = rede.body.rede.id;
      const alheia = await como(gb).post(`${RAIZ}/redes`, { rede: IP(42) });
      const d1 = await como(g).post(`${RAIZ}/redes/${id}/desativar`);
      assert.deepEqual([d1.status, d1.body.alterado, d1.body.rede.ativa], [200, true, false], aviso(d1));
      assert.notEqual(d1.body.rede.desativadaEm, null);
      const linha = (await redesDe(A())).find((l) => l.id === id);
      assert.deepEqual([linha.desativada_por, linha.desativada_em !== null], [g, true]);
      const auditoriasAntes = (await a.auditorias('TOKEN_REDE_DESATIVADA')).length;
      const d2 = await como(g).post(`${RAIZ}/redes/${id}/desativar`);
      assert.deepEqual([d2.status, d2.body.alterado], [200, false], aviso(d2));
      assert.equal((await a.auditorias('TOKEN_REDE_DESATIVADA')).length, auditoriasAntes, 'repetir não audita de novo');
      const cruzada = await como(g).post(`${RAIZ}/redes/${alheia.body.rede.id}/desativar`);
      const inexistente = await como(g).post(`${RAIZ}/redes/2147483000/desativar`);
      erroSeguro(cruzada, 404, 'REDE_NAO_ENCONTRADA', 'outra empresa');
      assert.deepEqual([cruzada.status, cruzada.body.codigo, cruzada.body.message], [inexistente.status, inexistente.body.codigo, inexistente.body.message]);
      assert.equal((await redesDe(B())).find((l) => l.id === alheia.body.rede.id).desativada_em, null, 'a rede da B segue ativa');
      erroSeguro(await como(g).post(`${RAIZ}/redes/abc/desativar`), 400, 'VALIDACAO');
      erroSeguro(await como(g).post(`${RAIZ}/redes/${id}/desativar`, { empresaId: B() }), 400, 'VALIDACAO');
      for (const metodo of ['delete', 'put', 'patch']) assert.ok((await como(g)[metodo](`${RAIZ}/redes/${id}`)).status >= 400, metodo);
      assert.equal((await redesDe(A())).some((l) => l.id === id), true, 'a linha nunca é apagada');
    });

    test('H31g — auditoria: cadastrar e desativar deixam uma linha cada, com o ator e a empresa da sessão, o id da rede como referência e o endereço configurado; nunca credencial; recusas (validação, permissão) não auditam', async () => {
      const g = await gerente();
      const cadAntes = (await a.auditorias('TOKEN_REDE_CADASTRADA')).length;
      const rede = await como(g).post(`${RAIZ}/redes`, { rede: IP(51) });
      await como(g).post(`${RAIZ}/redes`, { rede: 'invalido' });
      await como(await comuns(A(), {})).post(`${RAIZ}/redes`, { rede: IP(52) });
      const cad = (await a.auditorias('TOKEN_REDE_CADASTRADA')).filter((l) => l.usuario_id === g);
      assert.equal((await a.auditorias('TOKEN_REDE_CADASTRADA')).length, cadAntes + 1, 'só o cadastro válido audita');
      assert.equal(String(cad[cad.length - 1].referencia), String(rede.body.rede.id));
      assert.deepEqual(cad[cad.length - 1].dados_novos, { tipo: 'IP_FIXO', endereco: IP(51) });
      await como(g).post(`${RAIZ}/redes/${rede.body.rede.id}/desativar`);
      const des = (await a.auditorias('TOKEN_REDE_DESATIVADA')).filter((l) => l.usuario_id === g && String(l.referencia) === String(rede.body.rede.id));
      assert.equal(des.length, 1);
      assert.deepEqual([des[0].dados_anteriores.ativa, des[0].dados_novos.ativa], [true, false]);
      semSegredo((await a.todaAuditoria(A())).filter((l) => /TOKEN_REDE/.test(l.acao)), 'auditoria das redes');
    });

    test('H31h — DESATIVAR A REDE NÃO REVOGA O TABLET (regra real da Etapa C, sem alterar a C): com a rede cadastrada pela API, o tablet ativado e o funcionário identificado funcionam; desativada a rede, TODA requisição do tablet é 403 REDE_NAO_AUTORIZADA (identificar, atendimento, catálogo), a credencial NÃO é revogada nem rotacionada, o atendimento aberto não é encerrado, o evento REDE_RECUSADA é registrado; ao autorizar de novo o mesmo endereço, o MESMO tablet volta a funcionar; o tablet de outra empresa não é afetado', async () => {
      await a.redes({ A: [], B: [] });
      const g = await gerente();
      const gb = await gerente(B());
      const redeA = await como(g).post(`${RAIZ}/redes`, { rede: '127.0.0.1' });
      assert.equal(redeA.status, 201, aviso(redeA));
      assert.equal((await como(gb).post(`${RAIZ}/redes`, { rede: '127.0.0.1' })).status, 201, 'a B autoriza o mesmo IP, separadamente');
      const ghe = await a.ghe(A());
      const material = await a.material(A(), { nome: a.unico('Rede Material'), exigeTamanho: false });
      await a.vincularMaterial(A(), ghe, material);
      const gheB = await a.ghe(B());
      const tabletA = await a.cenario(app, { gheId: ghe });
      const tabletB = await a.cenario(app, { empresaId: B(), gheId: gheB });
      assert.equal((await a.catalogo(app, tabletA.t, tabletA.token)).status, 200, 'antes da desativação o tablet da A funciona');
      assert.equal((await a.catalogo(app, tabletB.t, tabletB.token)).status, 200);
      const credencialAntes = (await a.linha(tabletA.t.id)).credencial_hash;
      const eventosAntes = (await a.eventos(tabletA.t.id, 'REDE_RECUSADA')).length;

      const des = await como(g).post(`${RAIZ}/redes/${redeA.body.rede.id}/desativar`);
      assert.deepEqual([des.status, des.body.alterado], [200, true], aviso(des));

      const identificar = await a.identificar(app, tabletA.t.credencial, { tipo: 'CPF', valor: tabletA.f.cpf });
      const catalogo = await a.catalogo(app, tabletA.t, tabletA.token);
      const consultar = await a.consultar(app, tabletA.t, tabletA.token);
      for (const [rotulo, r] of [['identificar', identificar], ['catálogo', catalogo], ['atendimento', consultar]]) {
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], `${rotulo}: ${aviso(r)}`);
      }
      const linha = await a.linha(tabletA.t.id);
      assert.equal(linha.revogado_em, null, 'desativar a rede não revoga o tablet');
      assert.equal(linha.credencial_hash, credencialAntes, 'a credencial segue a mesma (nem revogada nem rotacionada)');
      assert.equal((await a.atendimento(tabletA.atendimentoId)).encerrado_em, null, 'o atendimento aberto não é encerrado pela desativação');
      assert.ok((await a.eventos(tabletA.t.id, 'REDE_RECUSADA')).length >= eventosAntes, 'a recusa por rede é registrada pela Etapa C (supressível)');
      assert.equal((await como(master).get(`${RAIZ}/dispositivos/${tabletA.t.id}`)).body.dispositivo.situacao, 'ATIVO', 'a situação administrativa não muda');
      assert.equal((await a.catalogo(app, tabletB.t, tabletB.token)).status, 200, 'o tablet da outra empresa não é afetado');

      const volta = await como(g).post(`${RAIZ}/redes`, { rede: '127.0.0.1' });
      assert.equal(volta.status, 201, aviso(volta));
      assert.equal((await a.catalogo(app, tabletA.t, tabletA.token)).status, 200, 'autorizado de novo, o MESMO tablet e o MESMO atendimento voltam a funcionar');
    });
  });
});
