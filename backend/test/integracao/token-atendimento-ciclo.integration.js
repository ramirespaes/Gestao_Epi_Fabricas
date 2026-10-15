'use strict';

const { describe, test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const {
  COOKIE_ATENDIMENTO, BASE, ATENDIMENTO_INVALIDO, INATIVIDADE_SEGUNDOS, cookieDoAtendimentoNaResposta, abrirAmbienteAtendimento, cabecalhoCookie,
} = require('./helpers/token-atendimento');
const {
  sha256, varrer, lerSetCookie, cookieDoTabletNaResposta, ORIGEM, CAMINHO_TABLET,
} = require('./helpers/token-tablet');
const { hashTokenSessao, gerarTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — Etapa D (RED): CICLO DE VIDA do atendimento temporário do funcionário no tablet. PostgreSQL real, schema temporário.
 * Estrutura da migration 086 usada SEM migration nova: `token_atendimentos` (token_hash único, iniciado_em, expira_em, encerrado_em,
 * motivo_encerramento ∈ PEDIDO_ENVIADO | SAIDA | INATIVIDADE | SUBSTITUIDO | DISPOSITIVO_REVOGADO) e o índice único parcial "um aberto por tablet".
 *
 * Política (decisões do responsável de 11/10/2026):
 *  - o prazo de inatividade é de 60 s DESLIZANTES, decidido pelo SERVIDOR no instante do banco (expira_em); consultar o estado NÃO prorroga
 *    (nem polling, nem heartbeat, nem atualização visual); só a interação do funcionário (POST .../atividade) renova para 60 s a partir de
 *    agora (40 s sem interação + uma interação válida = mais 60 s; 60 s completos sem interação = expirado);
 *  - o encerramento NUNCA é registrado com uma causa que não é a sua: SAIDA é só a saída voluntária e PEDIDO_ENVIADO só a conclusão do
 *    pedido (Etapa F). RECUSAR NÃO É ENCERRAR: funcionário que deixou de ser ATIVO ou tablet reativado depois do início do atendimento
 *    recebem 401 sem renovar e SEM fechar o registro (a 086 não tem motivo para essas causas; a migration 088 está suspensa); o registro
 *    termina por causa verdadeira (INATIVIDADE ao vencer, SUBSTITUIDO, DISPOSITIVO_REVOGADO);
 *  - vencido, o atendimento é recusado (401 ATENDIMENTO_INVALIDO), encerrado com INATIVIDADE e não pode ser reutilizado nem prorrogado;
 *  - um atendimento aberto por tablet: nova identificação ENCERRA o aberto (SUBSTITUIDO, ou INATIVIDADE se já vencido) na mesma
 *    transação, sob a trava da linha do tablet; o token antigo nunca atua sobre o novo (token único por atendimento);
 *  - a credencial do tablet segue valendo depois que o atendimento termina por qualquer motivo.
 */

const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;

describe('Atendimento Token — D: ciclo de vida do atendimento temporário (PostgreSQL real)', () => {
  let a;
  let app;
  let gestor;

  before(async () => {
    a = await abrirAmbienteAtendimento();
    app = a.criarApp({ hops: 0 });
    gestor = await a.usuario(a.d.empresaA, { operacoes: ['visualizar', 'criar', 'editar'], acoes: ['TOKEN_REVOGAR_DISPOSITIVO', 'TOKEN_GERAR_ATIVACAO'] });
  });
  after(async () => { if (a) await a.encerrar(); });
  beforeEach(async () => { await a.redes(a.redeDeTeste); });

  const tabletNovo = (empresaId = a.d.empresaA, horas = 0) => a.ativado(empresaId, { horasDesdeEmissao: horas });
  /** Tablet + funcionário + atendimento aberto REAL pela API; devolve tudo o que os cenários precisam. */
  async function comAtendimento(opcoes = {}) {
    const f = await a.funcionario(a.d.empresaA, opcoes.funcionario);
    const t = await tabletNovo();
    const r = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
    assert.equal(r.status, 201, `premissa: o atendimento abre pela API → ${aviso(r)}`);
    const token = cookieDoAtendimentoNaResposta(r).valor;
    const [linha] = await a.abertosDe(t.id);
    return { f, t, token, id: linha.id, resposta: r };
  }
  const expiraEmSegundos = async (id) => Number((await a.q('SELECT EXTRACT(EPOCH FROM (expira_em - now())) AS s FROM token_atendimentos WHERE id = $1', [id])).rows[0].s);
  const forcarRestante = (id, segundos) => a.q(`UPDATE token_atendimentos SET iniciado_em = LEAST(iniciado_em, now() - interval '200 seconds'), expira_em = now() + make_interval(secs => $2::int) WHERE id = $1`, [id, segundos]);

  // ───────────── controles do ambiente (usam só o que JÁ existe; passam já no RED) ─────────────
  describe('controles do ambiente (devem passar já no RED)', () => {
    test('K1 — a revogação da Etapa B (congelada) já ENCERRA o atendimento aberto com DISPOSITIVO_REVOGADO: é a base da regra "revogação encerra o atendimento"', async () => {
      const f = await a.funcionario(a.d.empresaA); const t = await tabletNovo();
      const { id } = await a.atendimentoDireto(t, f.id);
      const rev = await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${t.id}/revogar`);
      assert.equal(rev.status, 200, aviso(rev));
      const linha = await a.atendimento(id);
      assert.ok(linha.encerrado_em instanceof Date);
      assert.equal(linha.motivo_encerramento, 'DISPOSITIVO_REVOGADO');
    });

    test('K2 — a estrutura da 086 já garante UM aberto por tablet (índice único parcial) e que o token é único; o prazo pode ser deslocado por UPDATE (relógio controlável)', async () => {
      const f = await a.funcionario(a.d.empresaA); const f2 = await a.funcionario(a.d.empresaA); const t = await tabletNovo();
      const { id } = await a.atendimentoDireto(t, f.id);
      await assert.rejects(() => a.atendimentoDireto(t, f2.id), (e) => e.code === '23505' && /uq_token_atendimentos_aberto_por_dispositivo/.test(e.constraint ?? ''));
      await forcarRestante(id, 30);
      assert.ok(Math.abs((await expiraEmSegundos(id)) - 30) < 2);
    });

    test('K4 — a 086 comporta o ciclo SEM migration: motivos de encerramento aceitos (SAIDA, INATIVIDADE, SUBSTITUIDO, DISPOSITIVO_REVOGADO, PEDIDO_ENVIADO), motivo e instante andam juntos, motivo fora da lista é recusado; a lista NÃO foi ampliada (migration 088 suspensa): funcionário inativado ou tablet reativado não ganham motivo próprio, e o registro termina por INATIVIDADE, SUBSTITUIDO ou DISPOSITIVO_REVOGADO, conforme a causa efetiva', async () => {
      const f = await a.funcionario(a.d.empresaA);
      for (const motivo of ['SAIDA', 'INATIVIDADE', 'SUBSTITUIDO', 'DISPOSITIVO_REVOGADO', 'PEDIDO_ENVIADO']) {
        const t = await tabletNovo();
        const { id } = await a.atendimentoDireto(t, f.id);
        await a.q('UPDATE token_atendimentos SET encerrado_em = now(), motivo_encerramento = $2 WHERE id = $1', [id, motivo]);
        assert.equal((await a.atendimento(id)).motivo_encerramento, motivo);
      }
      const t = await tabletNovo();
      const { id } = await a.atendimentoDireto(t, f.id);
      await assert.rejects(() => a.q("UPDATE token_atendimentos SET encerrado_em = now(), motivo_encerramento = 'FUNCIONARIO_INATIVADO' WHERE id = $1", [id]), (e) => e.code === '23514');
      await assert.rejects(() => a.q("UPDATE token_atendimentos SET motivo_encerramento = 'SAIDA' WHERE id = $1", [id]), (e) => e.code === '23514');
    });

    test('K5 — o isolamento multiempresa do atendimento é estrutural: funcionário de outra empresa e tablet de outra empresa são recusados pelas FKs compostas da 086', async () => {
      const fB = await a.funcionario(a.d.empresaB); const tA = await tabletNovo();
      await assert.rejects(() => a.atendimentoDireto(tA, fB.id), (e) => e.code === '23503' && /fk_token_atendimentos_funcionario_mesma_empresa/.test(e.constraint ?? ''));
      const fA = await a.funcionario(a.d.empresaA);
      await assert.rejects(() => a.atendimentoDireto({ ...tA, empresaId: a.d.empresaB }, fA.id), (e) => e.code === '23503');
    });

    test('K3 — a credencial do tablet da Etapa C independe do atendimento: com o atendimento vencido no banco o tablet segue autenticado em /tablet/estado', async () => {
      const f = await a.funcionario(a.d.empresaA); const t = await tabletNovo();
      await a.atendimentoDireto(t, f.id, { restanteSegundos: -30, iniciadoHaSegundos: 200 });
      const r = await a.comoTablet(app, t.credencial).get(`${CAMINHO_TABLET}/estado`);
      assert.equal(r.status, 200, aviso(r));
    });
  });

  // ───────────────────────── estado e atividade ─────────────────────────
  describe('estado e renovação por atividade', () => {
    test('A1 — consultar o estado: 200 com o primeiro nome e o tempo restante (≤ 60 s); consultar NÃO prorroga o prazo e não altera o banco', async () => {
      const x = await comAtendimento({ funcionario: { nome: 'Ana Paula Souza' } });
      await forcarRestante(x.id, 40);
      const antes = await a.atendimento(x.id);
      const r = await a.consultar(app, x.t, x.token);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(Object.keys(r.body.atendimento).sort(), ['expiraEm', 'funcionario', 'restanteSegundos']);
      assert.deepEqual(r.body.atendimento.funcionario, { primeiroNome: 'Ana' });
      assert.ok(r.body.atendimento.restanteSegundos > 30 && r.body.atendimento.restanteSegundos <= 40, `restante ${r.body.atendimento.restanteSegundos}`);
      assert.deepEqual(await a.atendimento(x.id), antes, 'GET não escreve');
      assert.equal(lerSetCookie(r).some((c) => c.nome === COOKIE_ATENDIMENTO), false, 'GET não reemite o cookie do atendimento');
      const texto = JSON.stringify(r.body);
      for (const proibido of [x.f.cpf, x.f.matricula, 'Paula', 'Souza']) assert.equal(texto.includes(proibido), false);
    });

    test('A2 — a ATIVIDADE do funcionário renova o prazo para 60 s a partir de agora (no relógio do banco) e a resposta traz o novo prazo; o estado seguinte o reflete', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, 10);
      const r = await a.prorrogar(app, x.t, x.token);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(Object.keys(r.body.atendimento).sort(), ['expiraEm', 'funcionario', 'restanteSegundos']);
      assert.ok(r.body.atendimento.restanteSegundos > 55 && r.body.atendimento.restanteSegundos <= INATIVIDADE_SEGUNDOS, `restante ${r.body.atendimento.restanteSegundos}`);
      const noBanco = await expiraEmSegundos(x.id);
      assert.ok(noBanco > 55 && noBanco <= 61, `no banco: ${noBanco}`);
      const estado = await a.consultar(app, x.t, x.token);
      assert.ok(estado.body.atendimento.restanteSegundos > 55);
      assert.equal((await a.abertosDe(x.t.id)).length, 1);
    });

    test('A3 — EXEMPLO OFICIAL do prazo deslizante: inicia, fica 40 s sem interação (restam 20 s), interage (o prazo REINICIA para mais 60 s, não soma nem acumula), fica outros 40 s sem interação (ainda vale) e, ao completar 60 s sem interação, expira', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, 20); // 40 s sem interação desde o início
      assert.equal((await a.consultar(app, x.t, x.token)).status, 200, 'aos 40 s ainda vale');
      const interacao = await a.prorrogar(app, x.t, x.token);
      assert.equal(interacao.status, 200, aviso(interacao));
      assert.ok(interacao.body.atendimento.restanteSegundos > 55 && interacao.body.atendimento.restanteSegundos <= 60, 'reinício: 60 s a partir da interação, não 20 + 60');
      const depoisDaInteracao = await expiraEmSegundos(x.id);
      assert.ok(depoisDaInteracao > 55 && depoisDaInteracao <= 61, `no banco: ${depoisDaInteracao}`);
      await forcarRestante(x.id, 20); // mais 40 s sem interação depois da interação
      assert.equal((await a.consultar(app, x.t, x.token)).status, 200, '40 s depois da interação ainda vale (se o prazo não tivesse reiniciado, teria vencido)');
      await forcarRestante(x.id, -10); // 60 s completos sem interação
      const expirado = await a.consultar(app, x.t, x.token);
      assert.deepEqual([expirado.status, expirado.body.codigo], ATENDIMENTO_INVALIDO, aviso(expirado));
      assert.equal((await a.atendimento(x.id)).motivo_encerramento, 'INATIVIDADE');
    });

    test('A4 — fronteira temporal no servidor: com 5 s restantes o atendimento vale e uma atividade o renova; vencido há 5 s é recusado e uma atividade NÃO o revive', async () => {
      const dentro = await comAtendimento();
      await forcarRestante(dentro.id, 5);
      assert.equal((await a.consultar(app, dentro.t, dentro.token)).status, 200, '5 s antes do vencimento');
      assert.equal((await a.prorrogar(app, dentro.t, dentro.token)).status, 200, 'a atividade ainda renova');
      const fora = await comAtendimento();
      await forcarRestante(fora.id, -5);
      assert.deepEqual([(await a.prorrogar(app, fora.t, fora.token)).status], [401], '5 s depois do vencimento a atividade não revive');
      assert.equal((await a.abertosDe(fora.t.id)).length, 0);
    });

    test('A5 — NADA além da interação mantém o atendimento aberto: dezenas de consultas de estado e de leituras do estado do tablet (polling/heartbeat/atualização visual) não alteram o prazo nem o registro, e o atendimento expira no horário mesmo assim', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, 20);
      const antes = JSON.stringify(await a.atendimento(x.id));
      for (let i = 0; i < 12; i += 1) {
        assert.equal((await a.consultar(app, x.t, x.token)).status, 200, `consulta ${i + 1}`);
        assert.equal((await a.comoTablet(app, x.t.credencial).get(`${CAMINHO_TABLET}/estado`)).status, 200, `estado do tablet ${i + 1}`);
      }
      assert.equal(JSON.stringify(await a.atendimento(x.id)), antes, 'o registro do atendimento é idêntico depois do polling');
      await forcarRestante(x.id, -10);
      const r = await a.consultar(app, x.t, x.token);
      assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, 'o polling não impediu a expiração');
    });

    test('A6 — NÃO existe teto absoluto de duração: um atendimento aberto há 2 horas, mas com interação dentro do prazo, é renovado por mais 60 s e continua válido', async () => {
      const x = await comAtendimento();
      await a.q(`UPDATE token_atendimentos SET iniciado_em = now() - interval '2 hours', expira_em = now() + interval '20 seconds' WHERE id = $1`, [x.id]);
      const r = await a.prorrogar(app, x.t, x.token);
      assert.equal(r.status, 200, aviso(r));
      assert.ok(r.body.atendimento.restanteSegundos > 55 && r.body.atendimento.restanteSegundos <= 60, `restante ${r.body.atendimento.restanteSegundos}`);
      assert.equal((await a.consultar(app, x.t, x.token)).status, 200);
      assert.ok((await expiraEmSegundos(x.id)) > 55);
      assert.equal((await a.atendimento(x.id)).encerrado_em, null);
    });

    test('A7 — o cookie acompanha o prazo do servidor: a ATIVIDADE reemite o cookie com o MESMO token (Max-Age curto, Strict, Path próprio) e o estado não o reemite', async () => {
      const x = await comAtendimento();
      const r = await a.prorrogar(app, x.t, x.token);
      assert.equal(r.status, 200, aviso(r));
      const renovado = cookieDoAtendimentoNaResposta(r);
      assert.ok(renovado, 'a atividade renova o cookie');
      assert.equal(renovado.valor, x.token, 'o token é o mesmo: o servidor segue a autoridade');
      assert.deepEqual([renovado.atributos.path, String(renovado.atributos.samesite).toLowerCase(), renovado.atributos.httponly], [BASE, 'strict', true]);
      assert.ok(Number(renovado.atributos['max-age']) > 0 && Number(renovado.atributos['max-age']) <= 1800);
      assert.equal(lerSetCookie(await a.consultar(app, x.t, x.token)).some((c) => c.nome === COOKIE_ATENDIMENTO), false);
    });
  });

  // ───────────────────────── expiração por inatividade (servidor) ─────────────────────────
  describe('expiração por inatividade de 60 s', () => {
    test('B1 — fronteira de 60 s no servidor: com 30 s restantes o atendimento vale; vencido há 30 s é 401 ATENDIMENTO_INVALIDO, encerrado com INATIVIDADE, cookie removido e SEM dado pessoal', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, 30);
      assert.equal((await a.consultar(app, x.t, x.token)).status, 200);
      await forcarRestante(x.id, -30);
      const r = await a.consultar(app, x.t, x.token);
      assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      const linha = await a.atendimento(x.id);
      assert.ok(linha.encerrado_em instanceof Date);
      assert.equal(linha.motivo_encerramento, 'INATIVIDADE');
      const remocao = lerSetCookie(r).find((c) => c.nome === COOKIE_ATENDIMENTO);
      assert.ok(remocao, 'o cookie do atendimento é removido');
      assert.equal(remocao.atributos['max-age'], '0');
      assert.equal(remocao.atributos.path, BASE);
      const texto = JSON.stringify(r.body) + JSON.stringify(r.headers);
      for (const proibido of [x.f.cpf, x.f.matricula, 'Maria', 'Silva']) assert.equal(texto.includes(proibido), false);
    });

    test('B2 — vencido NÃO volta: atividade e encerramento voluntário com o atendimento vencido são 401 e não prorrogam nem reabrem (o prazo no banco não muda)', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, -30);
      const antes = (await a.atendimento(x.id)).expira_em;
      const atividade = await a.prorrogar(app, x.t, x.token);
      assert.deepEqual([atividade.status, atividade.body.codigo], ATENDIMENTO_INVALIDO, aviso(atividade));
      const saida = await a.encerrarAtendimento(app, x.t, x.token);
      assert.deepEqual([saida.status, saida.body.codigo], ATENDIMENTO_INVALIDO, aviso(saida));
      const linha = await a.atendimento(x.id);
      assert.deepEqual(linha.expira_em, antes, 'o prazo vencido não foi prorrogado');
      assert.equal(linha.motivo_encerramento, 'INATIVIDADE', 'o motivo é o da expiração, não o do encerramento posterior');
      assert.equal((await a.abertosDe(x.t.id)).length, 0);
    });

    test('B3 — o TABLET continua autenticado depois que o atendimento expira: a credencial da Etapa C segue valendo e uma nova identificação abre outro atendimento', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, -30);
      assert.deepEqual((await a.consultar(app, x.t, x.token)).status, 401);
      const estado = await a.comoTablet(app, x.t.credencial).get(`${CAMINHO_TABLET}/estado`);
      assert.equal(estado.status, 200, aviso(estado));
      const novo = await a.identificar(app, x.t.credencial, { tipo: 'CPF', valor: x.f.cpf });
      assert.equal(novo.status, 201, aviso(novo));
      assert.notEqual(cookieDoAtendimentoNaResposta(novo).valor, x.token, 'o token do atendimento vencido nunca é reaproveitado');
      assert.equal((await a.abertosDe(x.t.id)).length, 1);
    });

    test('B4 — a expiração é lazy mas ÚNICA e auditada: duas consultas ao vencido geram UMA auditoria TOKEN_ATENDIMENTO_ENCERRADO (motivo INATIVIDADE), sem segredo', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, -30);
      const antes = (await a.auditorias('TOKEN_ATENDIMENTO_ENCERRADO')).length;
      await a.consultar(app, x.t, x.token); await a.consultar(app, x.t, x.token);
      const registros = (await a.auditorias('TOKEN_ATENDIMENTO_ENCERRADO')).slice(antes);
      assert.equal(registros.length, 1);
      assert.deepEqual([registros[0].usuario_id, registros[0].empresa_id, registros[0].referencia, registros[0].contexto], [null, a.d.empresaA, String(x.id), { motivo: 'INATIVIDADE', dispositivoId: x.t.id, funcionarioId: x.f.id }]);
      assert.deepEqual(varrer(await a.todaAuditoria(a.d.empresaA), [x.token, hashTokenSessao(x.token), x.f.cpf, x.f.matricula, 'Maria']), []);
    });
  });

  // ───────────────────────── encerramento voluntário ─────────────────────────
  describe('encerramento voluntário e contexto limpo', () => {
    test('C1 — encerrar: 200, motivo SAIDA, cookie removido (Max-Age=0, mesmo Path), resposta sem dado do funcionário; o atendimento encerrado NÃO é reutilizável (estado, atividade e novo encerramento são 401) e nada muda no registro', async () => {
      const x = await comAtendimento();
      const r = await a.encerrarAtendimento(app, x.t, x.token);
      assert.equal(r.status, 200, aviso(r));
      assert.deepEqual(r.body, { status: 'ok' });
      const remocao = lerSetCookie(r).find((c) => c.nome === COOKIE_ATENDIMENTO);
      assert.ok(remocao && remocao.atributos['max-age'] === '0' && remocao.atributos.path === BASE && remocao.atributos.httponly === true);
      const linha = await a.atendimento(x.id);
      assert.equal(linha.motivo_encerramento, 'SAIDA');
      for (const chamada of [() => a.consultar(app, x.t, x.token), () => a.prorrogar(app, x.t, x.token), () => a.encerrarAtendimento(app, x.t, x.token)]) {
        const depois = await chamada();
        assert.deepEqual([depois.status, depois.body.codigo], ATENDIMENTO_INVALIDO, aviso(depois));
      }
      assert.deepEqual(await a.atendimento(x.id), linha, 'o registro encerrado é imutável');
      assert.equal((await a.abertosDe(x.t.id)).length, 0);
    });

    test('C2 — limpeza do contexto: encerrado por saída, vencido ou substituído, a resposta de qualquer outro pedido com o token antigo é a MESMA genérica (sem nome, matrícula, CPF nem o motivo)', async () => {
      const saida = await comAtendimento(); await a.encerrarAtendimento(app, saida.t, saida.token);
      const vencido = await comAtendimento(); await forcarRestante(vencido.id, -30);
      const substituido = await comAtendimento(); await a.identificar(app, substituido.t.credencial, { tipo: 'CPF', valor: (await a.funcionario(a.d.empresaA)).cpf });
      const inexistente = { t: await tabletNovo(), token: gerarTokenSessao() };
      const respostas = [];
      for (const x of [saida, vencido, substituido, inexistente]) respostas.push(await a.consultar(app, x.t, x.token));
      for (const r of respostas) assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      assert.equal(new Set(respostas.map((r) => JSON.stringify(r.body))).size, 1, 'indistinguíveis: não revelam se existiu, quem era nem por que acabou');
    });

    test('C3 — o encerramento voluntário é auditado (TOKEN_ATENDIMENTO_ENCERRADO, motivo SAIDA) sem segredo nem dado pessoal, e a credencial do tablet segue válida', async () => {
      const x = await comAtendimento();
      const antes = (await a.auditorias('TOKEN_ATENDIMENTO_ENCERRADO')).length;
      assert.equal((await a.encerrarAtendimento(app, x.t, x.token)).status, 200);
      const registros = (await a.auditorias('TOKEN_ATENDIMENTO_ENCERRADO')).slice(antes);
      assert.deepEqual(registros.map((l) => l.contexto), [{ motivo: 'SAIDA', dispositivoId: x.t.id, funcionarioId: x.f.id }]);
      assert.deepEqual(varrer(await a.todaAuditoria(a.d.empresaA), [x.token, sha256(x.token), hashTokenSessao(x.token), x.f.cpf, x.f.matricula, 'Maria', 'Silva']), []);
      assert.equal((await a.comoTablet(app, x.t.credencial).get(`${CAMINHO_TABLET}/estado`)).status, 200);
    });
  });

  // ───────────────────────── um atendimento por tablet, substituição e concorrência ─────────────────────────
  describe('um atendimento ativo por tablet', () => {
    test('D1 — nova identificação no mesmo tablet ENCERRA a anterior (SUBSTITUIDO), deixa exatamente UM aberto e invalida o token antigo; o novo funciona', async () => {
      const x = await comAtendimento();
      const outro = await a.funcionario(a.d.empresaA, { nome: 'Pedro Henrique Costa' });
      const r = await a.identificar(app, x.t.credencial, { tipo: 'CPF', valor: outro.cpf });
      assert.equal(r.status, 201, aviso(r));
      const novoToken = cookieDoAtendimentoNaResposta(r).valor;
      const linhas = await a.atendimentosDe(x.t.id);
      assert.equal(linhas.length, 2);
      assert.deepEqual([linhas[0].motivo_encerramento, linhas[1].encerrado_em, linhas[1].funcionario_id], ['SUBSTITUIDO', null, outro.id]);
      assert.equal((await a.abertosDe(x.t.id)).length, 1);
      const velho = await a.consultar(app, x.t, x.token);
      assert.deepEqual([velho.status, velho.body.codigo], ATENDIMENTO_INVALIDO, aviso(velho));
      const novo = await a.consultar(app, x.t, novoToken);
      assert.equal(novo.status, 200, aviso(novo));
      assert.deepEqual(novo.body.atendimento.funcionario, { primeiroNome: 'Pedro' });
    });

    test('D2 — se o aberto já VENCEU (e ainda não foi encerrado), a nova identificação o encerra como INATIVIDADE (não SUBSTITUIDO) e abre o novo sem violar o índice único', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, -30);
      const outro = await a.funcionario(a.d.empresaA);
      const r = await a.identificar(app, x.t.credencial, { tipo: 'MATRICULA', valor: outro.matricula });
      assert.equal(r.status, 201, aviso(r));
      assert.equal((await a.atendimento(x.id)).motivo_encerramento, 'INATIVIDADE');
      assert.equal((await a.abertosDe(x.t.id)).length, 1);
    });

    test('D3 — abertura CONCORRENTE por funcionários diferentes no mesmo tablet: todas 201 (nenhum 5xx), exatamente UM atendimento aberto, os demais encerrados como SUBSTITUIDO, e só o token do aberto vale', async () => {
      const t = await tabletNovo();
      const funcionarios = await Promise.all(Array.from({ length: 6 }, (_, i) => a.funcionario(a.d.empresaA, { nome: `Pessoa${i} Teste` })));
      const respostas = await Promise.all(funcionarios.map((f) => a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf })));
      assert.deepEqual(respostas.map((r) => r.status), Array(6).fill(201), respostas.map(aviso).join(' | '));
      const tokens = respostas.map((r) => cookieDoAtendimentoNaResposta(r).valor);
      assert.equal(new Set(tokens).size, 6);
      const abertos = await a.abertosDe(t.id);
      assert.equal(abertos.length, 1, 'um só aberto por tablet');
      assert.equal((await a.atendimentosDe(t.id)).filter((l) => l.motivo_encerramento === 'SUBSTITUIDO').length, 5);
      const validos = [];
      for (const token of tokens) validos.push((await a.consultar(app, t, token)).status);
      assert.equal(validos.filter((s) => s === 200).length, 1, `exatamente um token vale: ${validos.join(',')}`);
      assert.deepEqual(abertos.map((l) => l.token_hash), [hashTokenSessao(tokens[validos.indexOf(200)])], 'o token que vale é o do atendimento aberto');
    });

    test('D4 — a MESMA pessoa identificada várias vezes ao mesmo tempo também termina com um só atendimento aberto e uma única auditoria de início por atendimento criado', async () => {
      const t = await tabletNovo(); const f = await a.funcionario(a.d.empresaA);
      const respostas = await Promise.all(Array.from({ length: 4 }, () => a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf })));
      assert.deepEqual(respostas.map((r) => r.status), [201, 201, 201, 201], respostas.map(aviso).join(' | '));
      assert.equal((await a.abertosDe(t.id)).length, 1);
      assert.equal((await a.atendimentosDe(t.id)).length, 4);
      const iniciadas = (await a.auditorias('TOKEN_ATENDIMENTO_INICIADO')).filter((l) => (l.contexto ?? {}).dispositivoId === t.id);
      assert.equal(iniciadas.length, 4);
    });

    test('D5 — dois tablets são independentes: cada um tem o seu atendimento aberto ao mesmo tempo, e o token de um não atua no outro', async () => {
      const x1 = await comAtendimento(); const x2 = await comAtendimento();
      assert.equal((await a.consultar(app, x1.t, x1.token)).status, 200);
      assert.equal((await a.consultar(app, x2.t, x2.token)).status, 200);
      assert.equal((await a.encerrarAtendimento(app, x1.t, x1.token)).status, 200);
      assert.equal((await a.consultar(app, x2.t, x2.token)).status, 200, 'o atendimento do outro tablet segue aberto');
      assert.equal((await a.abertosDe(x2.t.id)).length, 1);
    });
  });

  // ───────────────────────── requisição atrasada ─────────────────────────
  describe('requisição atrasada de atendimento encerrado', () => {
    test('E1 — o token de um atendimento SUBSTITUÍDO nunca atua sobre o novo: atividade, encerramento e estado com o token antigo são 401 e o atendimento novo continua aberto com o prazo intacto', async () => {
      const velho = await comAtendimento();
      const outro = await a.funcionario(a.d.empresaA);
      const r = await a.identificar(app, velho.t.credencial, { tipo: 'CPF', valor: outro.cpf });
      assert.equal(r.status, 201, aviso(r));
      const novoToken = cookieDoAtendimentoNaResposta(r).valor;
      const [novoLinha] = await a.abertosDe(velho.t.id);
      await forcarRestante(novoLinha.id, 50);
      const antes = await a.atendimento(novoLinha.id);
      for (const chamada of [() => a.prorrogar(app, velho.t, velho.token), () => a.encerrarAtendimento(app, velho.t, velho.token), () => a.consultar(app, velho.t, velho.token)]) {
        const atrasada = await chamada();
        assert.deepEqual([atrasada.status, atrasada.body.codigo], ATENDIMENTO_INVALIDO, aviso(atrasada));
      }
      assert.deepEqual(await a.atendimento(novoLinha.id), antes, 'o novo não foi prorrogado nem encerrado');
      assert.equal((await a.consultar(app, velho.t, novoToken)).status, 200);
    });

    test('E2 — corrida: o encerramento ATRASADO do atendimento antigo disputado com a abertura do novo nunca fecha o novo (8 rodadas; em qualquer ordem o novo termina aberto e utilizável)', async () => {
      for (let i = 0; i < 8; i += 1) {
        const velho = await comAtendimento();
        const outro = await a.funcionario(a.d.empresaA);
        const [abertura, atrasada] = await Promise.all([
          a.identificar(app, velho.t.credencial, { tipo: 'CPF', valor: outro.cpf }),
          a.encerrarAtendimento(app, velho.t, velho.token),
        ]);
        assert.equal(abertura.status, 201, `rodada ${i}: ${aviso(abertura)}`);
        assert.ok([200, 401].includes(atrasada.status), `rodada ${i}: ${aviso(atrasada)}`);
        const novoToken = cookieDoAtendimentoNaResposta(abertura).valor;
        const abertos = await a.abertosDe(velho.t.id);
        assert.equal(abertos.length, 1, `rodada ${i}: o novo atendimento deve estar aberto`);
        assert.equal(abertos[0].token_hash, hashTokenSessao(novoToken));
        assert.equal((await a.consultar(app, velho.t, novoToken)).status, 200, `rodada ${i}`);
      }
    });
  });

  // ───────────────────────── revogação, inativação e isolamento ─────────────────────────
  describe('revogação do tablet, funcionário inativado e isolamento', () => {
    test('R1 — revogar o tablet encerra o atendimento aberto (DISPOSITIVO_REVOGADO) e NADA o recupera: token e credencial antigos são 401, nova identificação é 401, nova ativação é 409, e o atendimento de OUTRO tablet fica intacto', async () => {
      const x = await comAtendimento(); const outro = await comAtendimento();
      assert.equal((await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${x.t.id}/revogar`)).status, 200);
      const linha = await a.atendimento(x.id);
      assert.ok(linha.encerrado_em instanceof Date);
      assert.equal(linha.motivo_encerramento, 'DISPOSITIVO_REVOGADO');
      const consulta = await a.consultar(app, x.t, x.token);
      assert.deepEqual([consulta.status, consulta.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(consulta));
      const reidentificar = await a.identificar(app, x.t.credencial, { tipo: 'CPF', valor: x.f.cpf });
      assert.deepEqual([reidentificar.status, reidentificar.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(reidentificar));
      const cruzado = await a.consultar(app, outro.t, x.token);
      assert.deepEqual([cruzado.status, cruzado.body.codigo], ATENDIMENTO_INVALIDO, 'o token do revogado com a credencial de outro tablet');
      const gerar = await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${x.t.id}/ativacao`);
      assert.deepEqual([gerar.status, gerar.body.codigo], [409, 'DISPOSITIVO_REVOGADO'], 'um tablet revogado não volta a ser ativado');
      assert.equal((await a.abertosDe(x.t.id)).length, 0);
      assert.equal((await a.consultar(app, outro.t, outro.token)).status, 200, 'o outro tablet segue intacto');
      assert.equal((await a.abertosDe(outro.t.id)).length, 1);
    });

    test('R2 — funcionário INATIVADO ou AFASTADO durante o atendimento (D-D6): estado, atividade e encerramento são 401 ATENDIMENTO_INVALIDO, o prazo NÃO é renovado e o registro NÃO é fechado com causa inventada (nem SAIDA, nem INATIVIDADE antes de vencer); sem auditoria de recusa cadastral; o registro termina por causa verdadeira: INATIVIDADE ao vencer ou SUBSTITUIDO por nova identificação', async () => {
      for (const situacao of ['INATIVO', 'AFASTADO']) {
        const x = await comAtendimento();
        await a.q('UPDATE funcionarios SET situacao = $2 WHERE id = $1', [x.f.id, situacao]);
        const antes = await a.atendimento(x.id);
        const auditoriasAntes = (await a.todaAuditoria(a.d.empresaA)).length;
        for (const [rotulo, chamada] of [['estado', () => a.consultar(app, x.t, x.token)], ['atividade', () => a.prorrogar(app, x.t, x.token)], ['encerramento', () => a.encerrarAtendimento(app, x.t, x.token)]]) {
          const r = await chamada();
          assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, `${situacao} ${rotulo}: ${aviso(r)}`);
          assert.ok(lerSetCookie(r).some((c) => c.nome === COOKIE_ATENDIMENTO && c.atributos['max-age'] === '0'), `${situacao} ${rotulo}: o navegador descarta o cookie`);
        }
        assert.deepEqual(await a.atendimento(x.id), antes, `${situacao}: nada foi renovado nem fechado (motivo falso)`);
        assert.equal((await a.todaAuditoria(a.d.empresaA)).length, auditoriasAntes, `${situacao}: nenhuma auditoria de recusa cadastral`);

        await forcarRestante(x.id, -10); // o prazo realmente se esgota: só agora é INATIVIDADE
        const vencido = await a.consultar(app, x.t, x.token);
        assert.deepEqual([vencido.status, vencido.body.codigo], ATENDIMENTO_INVALIDO, aviso(vencido));
        assert.equal((await a.atendimento(x.id)).motivo_encerramento, 'INATIVIDADE', `${situacao}: INATIVIDADE só depois de vencer`);
      }
      const y = await comAtendimento();
      await a.q("UPDATE funcionarios SET situacao = 'AFASTADO' WHERE id = $1", [y.f.id]);
      assert.equal((await a.abertosDe(y.t.id)).length, 1, 'o registro segue aberto (não há motivo cadastral na 086)');
      const outro = await a.funcionario(a.d.empresaA);
      assert.equal((await a.identificar(app, y.t.credencial, { tipo: 'CPF', valor: outro.cpf })).status, 201);
      assert.equal((await a.atendimento(y.id)).motivo_encerramento, 'SUBSTITUIDO', 'substituído por nova identificação válida');
      assert.equal((await a.abertosDe(y.t.id)).length, 1);
    });

    test('R3 — isolamento: um atendimento de outra empresa plantado no banco, o token de atendimento fabricado e o token com cookie duplicado ou malformado são 401 genérico e nada é alterado', async () => {
      const x = await comAtendimento();
      await a.redes({ A: [{ tipo: 'IP_FIXO', rede: '127.0.0.1/32' }], B: [{ tipo: 'IP_FIXO', rede: '127.0.0.1/32' }] });
      const fB = await a.funcionario(a.d.empresaB); const tB = await tabletNovo(a.d.empresaB);
      const daB = await a.atendimentoDireto(tB, fB.id);
      const antes = JSON.stringify(await a.atendimento(x.id));
      const variantes = [
        ['token de outra empresa', () => a.consultar(app, x.t, daB.token)],
        ['token fabricado', () => a.consultar(app, x.t, gerarTokenSessao())],
        ['token malformado', () => a.consultar(app, x.t, 'abc')],
        ['cookie duplicado', () => request(app).get(BASE).set('Cookie', `${cabecalhoCookie(x.t.credencial, x.token)}; ${COOKIE_ATENDIMENTO}=${gerarTokenSessao()}`)],
      ];
      for (const [rotulo, montar] of variantes) {
        const r = await montar();
        assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, `${rotulo} → ${aviso(r)}`);
      }
      assert.equal(JSON.stringify(await a.atendimento(x.id)), antes);
      assert.equal((await a.atendimento(daB.id)).encerrado_em, null, 'o atendimento da outra empresa não foi tocado');
    });

    test('R4 — a rede continua obrigatória durante o atendimento: fora da rede autorizada estado, atividade e encerramento são 403 REDE_NAO_AUTORIZADA e nada muda no atendimento', async () => {
      const x = await comAtendimento();
      await a.redes({ A: [], B: [] });
      const antes = JSON.stringify(await a.atendimento(x.id));
      for (const chamada of [() => a.consultar(app, x.t, x.token), () => a.prorrogar(app, x.t, x.token), () => a.encerrarAtendimento(app, x.t, x.token)]) {
        const r = await chamada();
        assert.deepEqual([r.status, r.body.codigo], [403, 'REDE_NAO_AUTORIZADA'], aviso(r));
      }
      assert.equal(JSON.stringify(await a.atendimento(x.id)), antes);
    });

    test('R5 — a rotação da credencial do tablet durante o atendimento (credencial vencida) não derruba o atendimento: 200, Set-Cookie novo do tablet, e o mesmo token de atendimento segue valendo', async () => {
      const f = await a.funcionario(a.d.empresaA); const t = await tabletNovo(a.d.empresaA, 25);
      const r = await a.identificar(app, t.credencial, { tipo: 'CPF', valor: f.cpf });
      assert.equal(r.status, 201, aviso(r));
      const token = cookieDoAtendimentoNaResposta(r).valor;
      const novoTablet = cookieDoTabletNaResposta(r);
      assert.ok(novoTablet, 'rotação na identificação');
      const consulta = await a.consultar(app, { credencial: novoTablet.valor }, token);
      assert.equal(consulta.status, 200, aviso(consulta));
    });

    test('R6 — recuperação do tablet por nova ativação (D-D7): a credencial ANTIGA é 401 DISPOSITIVO_NAO_AUTORIZADO e o atendimento iniciado ANTES da reativação também é recusado pela credencial NOVA (401 ATENDIMENTO_INVALIDO em estado, atividade e encerramento), sem renovar e sem fechar o registro com causa falsa; o registro vence por INATIVIDADE ou é substituído por nova identificação, e o tablet recuperado identifica e opera normalmente', async () => {
      const x = await comAtendimento();
      const codigo = (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${x.t.id}/ativacao`)).body.ativacao.codigo;
      const ativacao = await a.ativar(app, codigo);
      assert.equal(ativacao.status, 200, aviso(ativacao));
      const nova = cookieDoTabletNaResposta(ativacao).valor;
      for (const chamada of [() => a.consultar(app, x.t, x.token), () => a.prorrogar(app, x.t, x.token), () => a.encerrarAtendimento(app, x.t, x.token)]) {
        const r = await chamada();
        assert.deepEqual([r.status, r.body.codigo], [401, 'DISPOSITIVO_NAO_AUTORIZADO'], aviso(r));
      }
      const antes = await a.atendimento(x.id);
      for (const [rotulo, chamada] of [['estado', () => a.consultar(app, { credencial: nova }, x.token)], ['atividade', () => a.prorrogar(app, { credencial: nova }, x.token)], ['encerramento', () => a.encerrarAtendimento(app, { credencial: nova }, x.token)]]) {
        const r = await chamada();
        assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, `${rotulo} com a credencial nova: ${aviso(r)}`);
      }
      assert.deepEqual(await a.atendimento(x.id), antes, 'nada foi renovado nem fechado: sem motivo inventado');
      assert.ok((await expiraEmSegundos(x.id)) <= 61, 'o atendimento anterior nunca passa do prazo de inatividade');

      const outro = await a.funcionario(a.d.empresaA);
      const novoAtendimento = await a.identificar(app, nova, { tipo: 'CPF', valor: outro.cpf });
      assert.equal(novoAtendimento.status, 201, aviso(novoAtendimento));
      assert.equal((await a.atendimento(x.id)).motivo_encerramento, 'SUBSTITUIDO');
      assert.equal((await a.abertosDe(x.t.id)).length, 1, 'continua UM aberto por tablet');
      const tokenNovo = cookieDoAtendimentoNaResposta(novoAtendimento).valor;
      assert.equal((await a.consultar(app, { credencial: nova }, tokenNovo)).status, 200, 'o atendimento aberto DEPOIS da reativação é válido');
      assert.equal((await a.prorrogar(app, { credencial: nova }, tokenNovo)).status, 200);
    });

    test('R8 — a ROTAÇÃO da credencial com o atendimento já aberto (evento CREDENCIAL_RENOVADA depois do início) NÃO é reativação: o atendimento segue válido e renovável com a credencial nova e com a anterior na carência', async () => {
      const x = await comAtendimento();
      await a.q("UPDATE token_dispositivos SET credencial_emitida_em = now() - interval '25 hours' WHERE id = $1", [x.t.id]);
      const r = await a.consultar(app, x.t, x.token);
      assert.equal(r.status, 200, aviso(r));
      const rotacionada = cookieDoTabletNaResposta(r);
      assert.ok(rotacionada, 'premissa: a credencial vencida foi rotacionada neste pedido');
      assert.equal((await a.eventos(x.t.id, 'CREDENCIAL_RENOVADA')).length, 1, 'premissa: o evento de rotação é posterior ao início do atendimento');
      assert.equal((await a.consultar(app, { credencial: rotacionada.valor }, x.token)).status, 200);
      assert.equal((await a.prorrogar(app, { credencial: rotacionada.valor }, x.token)).status, 200);
      assert.equal((await a.consultar(app, x.t, x.token)).status, 200, 'a anterior na carência também opera');
    });

    test('V1 — o corpo e a query das operações do atendimento são estritos: campo extra (empresa, tablet, funcionário, motivo, tempo) é 400 VALIDACAO e nada é renovado nem encerrado', async () => {
      const x = await comAtendimento();
      await forcarRestante(x.id, 20);
      const antes = await a.atendimento(x.id);
      for (const caminho of [`${BASE}/atividade`, `${BASE}/encerrar`]) {
        for (const extra of [{ empresaId: a.d.empresaB }, { motivo: 'PEDIDO_ENVIADO' }, { restanteSegundos: 9999 }, { funcionarioId: x.f.id }]) {
          const r = await request(app).post(caminho).set('Origin', ORIGEM).set('Cookie', cabecalhoCookie(x.t.credencial, x.token)).send(extra);
          assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${caminho} ${Object.keys(extra)[0]}: ${aviso(r)}`);
        }
        const comQuery = await request(app).post(`${caminho}?empresaId=${a.d.empresaB}`).set('Origin', ORIGEM).set('Cookie', cabecalhoCookie(x.t.credencial, x.token)).send({});
        assert.deepEqual([comQuery.status, comQuery.body.codigo], [400, 'VALIDACAO'], aviso(comQuery));
      }
      assert.deepEqual(await a.atendimento(x.id), antes);
    });

    test('R7 — recuperação com o atendimento anterior vencido: o registro é fechado como INATIVIDADE (o prazo realmente venceu), nunca como causa de reativação', async () => {
      const x = await comAtendimento();
      const codigo = (await a.comoAdmin(app, gestor).post(`/api/atendimento-token/dispositivos/${x.t.id}/ativacao`)).body.ativacao.codigo;
      const nova = cookieDoTabletNaResposta(await a.ativar(app, codigo)).valor;
      await forcarRestante(x.id, -10);
      const r = await a.consultar(app, { credencial: nova }, x.token);
      assert.deepEqual([r.status, r.body.codigo], ATENDIMENTO_INVALIDO, aviso(r));
      assert.equal((await a.atendimento(x.id)).motivo_encerramento, 'INATIVIDADE');
    });
  });
});
