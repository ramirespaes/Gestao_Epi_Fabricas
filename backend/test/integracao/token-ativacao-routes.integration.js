'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const {
  abrirAmbiente, sha256, hashAleatorio, varrer, CABECALHO, ORIGEM,
} = require('./helpers/token-tablet');
const { tokenSessaoTemFormatoValido } = require('../../src/security/token');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');

/**
 * Atendimento Token — Etapa C (RED), parte administrativa: GERAÇÃO do código de ativação do tablet.
 * PostgreSQL real em schema temporário; só o banco de teste. Nenhum código de produção existe ainda para estes contratos.
 *
 * Contrato proposto:
 *   POST /api/atendimento-token/dispositivos/:id/ativacao     ação TOKEN_GERAR_ATIVACAO     corpo {}  (estrito)
 *   201 { status:'ok', ativacao: { dispositivoId, codigo, expiraEm } }  — o código em claro SÓ nesta resposta (vira o QR depois);
 *   o banco guarda só o SHA-256; validade de 10 minutos; no máximo uma ativação pendente por tablet (a nova cancela a anterior,
 *   inclusive a expirada que ainda ocupa o índice único parcial da 086); tablet revogado → 409 DISPOSITIVO_REVOGADO;
 *   outro tablet de empresa diferente ou inexistente → o mesmo 404 DISPOSITIVO_NAO_ENCONTRADO; auditoria TOKEN_ATIVACAO_GERADA
 *   e evento ATIVACAO_GERADA, sem o código nem o hash.
 *
 * Decisões ainda abertas (NÃO testadas aqui, documentadas no relatório): gerar ativação para tablet já ATIVO (reativação).
 */

const RAIZ = '/api/atendimento-token/dispositivos';

describe('Atendimento Token — C: geração do código de ativação (PostgreSQL real)', () => {
  let a; // ambiente
  let app;
  let gestor;

  before(async () => {
    a = await abrirAmbiente();
    app = a.criarApp({ admin: 'cabecalho' });
    gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });

  const gerar = (usuarioId, id, corpo = {}) => a.comoAdmin(app, usuarioId).post(`${RAIZ}/${id}/ativacao`, corpo);
  const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;

  // ───────────── controles do ambiente (usam só o que JÁ existe; passam já no RED) ─────────────
  describe('controles do ambiente (devem passar já no RED)', () => {
    test('K1 — fixtures: tablet PENDENTE, ativação pendente e concessão individual da ação valem para a decisão de produção', async () => {
      const { avaliarPermissaoAcao } = require('../../src/middleware/autorizacao');
      const x = await a.dispositivo(a.d.empresaA);
      const codigo = await a.codigoPendente(x);
      assert.equal(tokenSessaoTemFormatoValido(codigo), true);
      assert.equal((await a.ativacoesDe(x.id)).length, 1);
      assert.equal(await avaliarPermissaoAcao(a.ctx.pool, { empresaId: a.d.empresaA, usuarioId: gestor, perfil: 'USUARIO' }, 'TOKEN_GERAR_ATIVACAO'), true);
      const semAcao = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'] });
      assert.equal(await avaliarPermissaoAcao(a.ctx.pool, { empresaId: a.d.empresaA, usuarioId: semAcao, perfil: 'USUARIO' }, 'TOKEN_GERAR_ATIVACAO'), false);
    });

    test('K2 — o índice único parcial da 086 vale para pendente E para expirada ainda não cancelada (por isso gerar uma nova precisa cancelar a anterior)', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      await a.codigoPendente(x, { criadoHaMinutos: 30, validadeMinutos: 10 }); // expirou há 20 minutos, mas segue "pendente" no índice
      await assert.rejects(() => a.codigoPendente(x), (e) => e.code === '23505' && /uq_token_ativacoes_pendente_por_dispositivo/.test(e.constraint ?? ''));
    });
  });

  // ───────────────────────── A. geração e armazenamento ─────────────────────────
  describe('geração', () => {
    test('A1 — gera código canônico e aleatório, devolve em claro só nesta resposta e guarda SÓ o hash; validade de 10 minutos; criador e empresa da sessão', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const r = await gerar(gestor, x.id);
      assert.equal(r.status, 201, aviso(r));
      assert.deepEqual(Object.keys(r.body).sort(), ['ativacao', 'status']);
      assert.deepEqual(Object.keys(r.body.ativacao).sort(), ['codigo', 'dispositivoId', 'expiraEm']);
      const { codigo, expiraEm, dispositivoId } = r.body.ativacao;
      assert.equal(dispositivoId, x.id);
      assert.equal(tokenSessaoTemFormatoValido(codigo), true, 'código de 256 bits em formato canônico (mesma fonte criptográfica das sessões)');
      const restante = (new Date(expiraEm).getTime() - Date.now()) / 1000;
      assert.ok(restante > 9 * 60 && restante <= 10 * 60 + 5, `validade de 10 minutos, veio ${restante}s`);
      const linhas = await a.ativacoesDe(x.id);
      assert.equal(linhas.length, 1);
      assert.equal(linhas[0].codigo_hash, sha256(codigo), 'o banco guarda exatamente o SHA-256 do código');
      assert.deepEqual([linhas[0].criado_por, linhas[0].empresa_id, linhas[0].usado_em, linhas[0].cancelado_em], [gestor, a.d.empresaA, null, null]);
      assert.deepEqual(varrer(linhas, [codigo], { hex64: false }), [], 'o código em claro não pode estar em nenhuma coluna');
    });

    test('A2 — cada geração produz um código diferente (aleatoriedade): nenhum repetido em 5 gerações', async () => {
      const codigos = new Set();
      for (let i = 0; i < 5; i += 1) {
        const x = await a.dispositivo(a.d.empresaA);
        const r = await gerar(gestor, x.id);
        assert.equal(r.status, 201, aviso(r));
        codigos.add(r.body.ativacao.codigo);
      }
      assert.equal(codigos.size, 5);
    });

    test('A3 — corpo estrito: empresa, autoria, código, validade e qualquer campo extra são 400 e nada é criado', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      for (const campo of [{ empresaId: a.d.empresaB }, { criadoPor: a.d.master }, { codigo: 'x'.repeat(43) }, { expiraEm: '2099-01-01T00:00:00Z' }, { validadeMinutos: 1 }, { dispositivoId: x.id }]) {
        const r = await gerar(gestor, x.id, campo);
        assert.equal(r.status, 400, `${JSON.stringify(Object.keys(campo))} → ${aviso(r)}`);
        assert.equal(r.body.codigo, 'VALIDACAO');
      }
      assert.equal((await a.ativacoesDe(x.id)).length, 0);
      for (const id of ['abc', '0', '-1', '1.5']) assert.equal((await gerar(gestor, id)).status, 400, `id ${id}`);
    });

    test('A4 — a validade vem do servidor: o corpo não a controla e o banco confirma o teto de 10 minutos (expira_em ≤ criado_em + 10 min)', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const r = await gerar(gestor, x.id);
      assert.equal(r.status, 201, aviso(r));
      const { rows } = await a.q("SELECT (expira_em - criado_em) <= interval '10 minutes' AND expira_em > criado_em AS ok FROM token_ativacoes WHERE dispositivo_id = $1", [x.id]);
      assert.equal(rows[0].ok, true);
    });
  });

  // ───────────────────────── B. uma pendente por tablet, substituição, expiração ─────────────────────────
  describe('pendente única, substituição e expiração', () => {
    test('B1 — gerar de novo substitui: o código anterior fica cancelado, existe uma só ativação pendente e os dois códigos são distintos', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const primeira = await gerar(gestor, x.id);
      const segunda = await gerar(gestor, x.id);
      assert.equal(primeira.status, 201, aviso(primeira));
      assert.equal(segunda.status, 201, aviso(segunda));
      assert.notEqual(primeira.body.ativacao.codigo, segunda.body.ativacao.codigo);
      const linhas = await a.ativacoesDe(x.id);
      assert.equal(linhas.length, 2);
      assert.equal(linhas.filter((l) => l.usado_em === null && l.cancelado_em === null).length, 1, 'uma só pendente');
      assert.ok(linhas[0].cancelado_em instanceof Date, 'a primeira foi cancelada');
      assert.equal(linhas[1].codigo_hash, sha256(segunda.body.ativacao.codigo));
    });

    test('B2 — depois da expiração da anterior (que ainda ocupa o índice único), gerar de novo funciona e a expirada é cancelada, sem erro 500', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      await a.codigoPendente(x, { criadoHaMinutos: 30, validadeMinutos: 10 });
      const r = await gerar(gestor, x.id);
      assert.equal(r.status, 201, aviso(r));
      const linhas = await a.ativacoesDe(x.id);
      assert.equal(linhas.filter((l) => l.usado_em === null && l.cancelado_em === null).length, 1);
      assert.ok(linhas[0].cancelado_em instanceof Date, 'a expirada foi cancelada para liberar o índice');
    });

    test('B3 — gerar depois de uma ativação já USADA cria uma nova pendente sem tocar na usada', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      await a.codigoPendente(x);
      await a.q('UPDATE token_ativacoes SET usado_em = now() WHERE dispositivo_id = $1', [x.id]);
      const r = await gerar(gestor, x.id);
      assert.equal(r.status, 201, aviso(r));
      const linhas = await a.ativacoesDe(x.id);
      assert.deepEqual(linhas.map((l) => [l.usado_em !== null, l.cancelado_em !== null]), [[true, false], [false, false]]);
    });

    test('B4 — gerações simultâneas para o mesmo tablet: todas respondem 201 (nenhuma estoura o índice único em 500) e sobra exatamente UMA pendente', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const respostas = await Promise.all(Array.from({ length: 6 }, () => gerar(gestor, x.id)));
      assert.deepEqual(respostas.map((r) => r.status), [201, 201, 201, 201, 201, 201], respostas.map(aviso).join(' | '));
      const linhas = await a.ativacoesDe(x.id);
      assert.equal(linhas.length, 6);
      assert.equal(linhas.filter((l) => l.usado_em === null && l.cancelado_em === null).length, 1);
      const pendente = linhas.find((l) => l.cancelado_em === null);
      assert.ok(respostas.some((r) => sha256(r.body.ativacao.codigo) === pendente.codigo_hash), 'o código pendente é um dos devolvidos');
    });
  });

  // ───────────────────────── C. tablet revogado, empresa e isolamento ─────────────────────────
  describe('tablet revogado e isolamento entre empresas', () => {
    test('C1 — tablet REVOGADO: 409 DISPOSITIVO_REVOGADO e nenhuma ativação criada', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      await a.q('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $2 WHERE id = $1', [x.id, a.d.master]);
      const r = await gerar(gestor, x.id);
      assert.equal(r.status, 409, aviso(r));
      assert.equal(r.body.codigo, 'DISPOSITIVO_REVOGADO');
      assert.equal((await a.ativacoesDe(x.id)).length, 0);
    });

    test('C2 — tablet de OUTRA empresa e tablet inexistente respondem o mesmo 404 DISPOSITIVO_NAO_ENCONTRADO; nada é criado e o tablet alheio não muda', async () => {
      const daB = await a.dispositivo(a.d.empresaB);
      const antes = await a.linha(daB.id);
      const cruzado = await gerar(gestor, daB.id);
      const inexistente = await gerar(gestor, 2147483000);
      for (const r of [cruzado, inexistente]) {
        assert.equal(r.status, 404, aviso(r));
        assert.equal(r.body.codigo, 'DISPOSITIVO_NAO_ENCONTRADO');
      }
      assert.deepEqual(cruzado.body, inexistente.body, 'indistinguíveis pelo cliente');
      assert.equal((await a.ativacoesDe(daB.id)).length, 0);
      assert.deepEqual(await a.linha(daB.id), antes);
    });

    test('C3 — a ativação nasce na empresa do TABLET, que vem da sessão e do cadastro, nunca do cliente (gestor da B gera para o tablet da B)', async () => {
      const gestorB = await a.usuario(a.d.empresaB, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO'] });
      const daB = await a.dispositivo(a.d.empresaB);
      const r = await gerar(gestorB, daB.id);
      assert.equal(r.status, 201, aviso(r));
      assert.equal((await a.ativacoesDe(daB.id))[0].empresa_id, a.d.empresaB);
    });
  });

  // ───────────────────────── D. RBAC ─────────────────────────
  describe('RBAC (autorização no BACKEND)', () => {
    test('D1 — sem sessão é 401; sem a AÇÃO é 403 mesmo com visualizar, criar e editar; a ação sozinha basta; nada é criado nas negativas', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      assert.equal((await request(app).post(`${RAIZ}/${x.id}/ativacao`).set('Origin', ORIGEM).send({})).status, 401);
      const semAcao = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'] });
      const nada = await a.usuario(a.d.empresaA);
      for (const [rotulo, id] of [['só recurso', semAcao], ['sem nada', nada]]) {
        const r = await gerar(id, x.id);
        assert.equal(r.status, 403, `${rotulo} → ${aviso(r)}`);
      }
      assert.equal((await a.ativacoesDe(x.id)).length, 0);
      const soAcao = await a.usuario(a.d.empresaA, { acoes: ['TOKEN_GERAR_ATIVACAO'] });
      const ok = await gerar(soAcao, x.id);
      assert.equal(ok.status, 201, aviso(ok));
    });

    test('D2 — a decisão é de CONCESSÃO, não do nome do perfil: ADMINISTRADOR e SUPERVISOR sem concessão recebem 403; o bloqueio individual vence a concessão', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR']) {
        const conta = await a.usuario(a.d.empresaA, { perfil, operacoes: ['visualizar', 'criar', 'editar'] });
        assert.equal((await gerar(conta, x.id)).status, 403, perfil);
      }
      const bloqueado = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_GERAR_ATIVACAO'] });
      await a.q('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, $2, $3)', [bloqueado, 'TOKEN_GERAR_ATIVACAO', a.d.master]);
      assert.equal((await gerar(bloqueado, x.id)).status, 403);
      assert.equal((await a.ativacoesDe(x.id)).length, 0);
    });

    test('D3 — o MASTER só recebe a ação pelo PROVISIONAMENTO do escopo: antes é 403; depois, 201; nenhum outro perfil nem as outras ações do Token são concedidos', async () => {
      const daB = await a.dispositivo(a.d.empresaB);
      const antes = await gerar(a.d.masterB, daB.id);
      assert.equal(antes.status, 403, `sem provisionar o MASTER não pode: ${aviso(antes)}`);
      await provisionamento.provisionar(a.ctx.pool, { empresaId: a.d.empresaB, dryRun: false });
      const depois = await gerar(a.d.masterB, daB.id);
      assert.equal(depois.status, 201, aviso(depois));
      const concedidas = (await a.q("SELECT perfil, acao_codigo FROM permissoes_acao WHERE empresa_id = $1 AND acao_codigo LIKE 'TOKEN\\_%' ORDER BY perfil, acao_codigo", [a.d.empresaB])).rows;
      assert.deepEqual(concedidas, [
        { perfil: 'MASTER', acao_codigo: 'TOKEN_GERAR_ATIVACAO' },
        { perfil: 'MASTER', acao_codigo: 'TOKEN_GERENCIAR_REDES' },
        { perfil: 'MASTER', acao_codigo: 'TOKEN_PREVIA_CATALOGO_REAL' },
        { perfil: 'MASTER', acao_codigo: 'TOKEN_REVOGAR_DISPOSITIVO' },
      ], 'só as quatro ações com rota (revogar e gerar, B/C; redes e prévia, Etapa H), só para o MASTER; MONITORAMENTO e HISTORICO (Etapa J) seguem sem enforcement e fora do escopo');
    });

    test('D4 — a credencial do TABLET nunca autentica esta rota: com o cookie do tablet (sessão administrativa REAL exigida) a resposta é 401, e nada é criado', async () => {
      const real = a.criarApp({ admin: 'cookie' });
      const tablet = await a.ativado(a.d.empresaA);
      const alvo = await a.dispositivo(a.d.empresaA);
      const r = await request(real).post(`${RAIZ}/${alvo.id}/ativacao`).set('Origin', ORIGEM).set('Cookie', `gepi_tablet=${tablet.credencial}`).send({});
      assert.equal(r.status, 401, aviso(r));
      assert.equal(r.body.codigo, 'SESSAO_INVALIDA');
      assert.equal((await a.ativacoesDe(alvo.id)).length, 0);
    });
  });

  // ───────────────────────── E. auditoria e segredos ─────────────────────────
  describe('auditoria, eventos e segredos', () => {
    test('E1 — cada geração: uma auditoria TOKEN_ATIVACAO_GERADA (usuário, empresa, tablet) e um evento ATIVACAO_GERADA; nada de código, hash ou chave sensível', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const antesAud = (await a.auditorias('TOKEN_ATIVACAO_GERADA')).length;
      const r = await gerar(gestor, x.id);
      assert.equal(r.status, 201, aviso(r));
      const registros = (await a.auditorias('TOKEN_ATIVACAO_GERADA')).slice(antesAud);
      assert.equal(registros.length, 1);
      assert.deepEqual([registros[0].usuario_id, registros[0].empresa_id, registros[0].referencia], [gestor, a.d.empresaA, String(x.id)]);
      const eventos = await a.eventos(x.id, 'ATIVACAO_GERADA');
      assert.deepEqual(eventos.map((e) => [e.usuario_id, e.empresa_id]), [[gestor, a.d.empresaA]]);
      const codigo = r.body.ativacao.codigo;
      assert.deepEqual(varrer(await a.todaAuditoria(a.d.empresaA), [codigo, sha256(codigo)]), [], 'segredo em logs_auditoria');
      assert.deepEqual(varrer(await a.todosEventos(a.d.empresaA), [codigo, sha256(codigo)]), [], 'segredo em token_dispositivo_eventos');
    });

    test('E2 — substituir também audita (uma por geração) e a tabela de ativações é o ÚNICO lugar do banco com o hash do código; o código em claro não existe em lugar nenhum', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      const r1 = await gerar(gestor, x.id);
      const r2 = await gerar(gestor, x.id);
      const codigos = [r1.body.ativacao?.codigo, r2.body.ativacao?.codigo];
      assert.ok(codigos.every((c) => typeof c === 'string'), `as duas gerações devolvem o código: ${aviso(r1)} | ${aviso(r2)}`);
      assert.equal((await a.eventos(x.id, 'ATIVACAO_GERADA')).length, 2);
      for (const tabela of ['logs_auditoria', 'token_dispositivo_eventos', 'token_dispositivos', 'token_atendimentos']) {
        const { rows } = await a.q(`SELECT * FROM ${tabela}`);
        assert.deepEqual(varrer(rows, [...codigos, ...codigos.map(sha256)], { hex64: false }), [], tabela);
      }
      const emAtivacoes = (await a.ativacoesDe(x.id)).map((l) => l.codigo_hash).sort();
      assert.deepEqual(emAtivacoes, codigos.map(sha256).sort());
    });

    test('E3 — a resposta de recusa não revela código, hash nem estrutura interna (403, 404 e 409 sem segredos)', async () => {
      const x = await a.dispositivo(a.d.empresaA);
      await a.q('UPDATE token_dispositivos SET revogado_em = now(), revogado_por = $2 WHERE id = $1', [x.id, a.d.master]);
      const nada = await a.usuario(a.d.empresaA);
      const esperados = [[403, 'PERMISSAO_NEGADA'], [409, 'DISPOSITIVO_REVOGADO'], [404, 'DISPOSITIVO_NAO_ENCONTRADO']];
      const respostas = [await gerar(nada, x.id), await gerar(gestor, x.id), await gerar(gestor, 2147483000)];
      respostas.forEach((r, i) => assert.deepEqual([r.status, r.body.codigo], esperados[i], aviso(r)));
      for (const r of respostas) {
        assert.deepEqual(varrer([{ corpo: r.body }], [hashAleatorio()]), [], 'resposta de erro sem segredo');
        assert.equal(/stack|sql|constraint|token_ativacoes/i.test(JSON.stringify(r.body)), false);
      }
    });
  });
});
