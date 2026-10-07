'use strict';

const {
  describe, test, before, after, beforeEach,
} = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { chaveNova, comLimite, vincularMaterialAoGhe } = require('./helpers/solicitacao-epi-servico');
const { ACEITE } = require('./helpers/reserva-estoque');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');

/**
 * 12G-6 — "Gerar alerta": alerta MANUAL de falta de estoque de um pedido, pela
 * camada HTTP real (PostgreSQL real, schema temporário).
 *
 *   POST /api/alertas-estoque/falta   { solicitacaoId }
 *
 * Quem dispara: REALIZAR_ENTREGA efetiva (sem ação nova). Quem recebe: ativo,
 * da empresa ativa, com e-mail utilizável e ENTRADA_ESTOQUE efetiva, sem
 * exigir vínculo SST, resolvido no envio, nunca pelo nome do perfil. Conteúdo
 * mínimo para a reposição (pedido, EPI, tamanho, pendente e sem cobertura),
 * sem trabalhador. O clique repetido do mesmo usuário no mesmo pedido é
 * suprimido pelo padrão de auditoria com trava própria, sem tabela nova e sem
 * passar pela fila automática da 069. A falha do alerta nunca mexe na entrega.
 */

const ACAO_AUDITORIA = 'ALERTA_FALTA_ESTOQUE';

describe('12G-6 — Gerar alerta (falta de estoque de um pedido)', () => {
  let env;
  let pool;
  let d;
  let f;
  let como;
  const u = {};
  const email = {
    enviados: [],
    resposta: () => ({ estado: 'ENVIADO' }),
    async enviarAguardando(mensagem) {
      this.enviados.push(mensagem);
      return this.resposta(mensagem);
    },
  };

  const ROTA = '/api/alertas-estoque/falta';
  const alertar = (ator, solicitacaoId, extra = {}) => como(ator).post(ROTA, { solicitacaoId, ...extra });
  // Mesma ordenação nos dois lados (JavaScript): a collation do PostgreSQL varia entre ambientes e não pode decidir o resultado.
  const emailsDe = async (ids) => (await pool.query('SELECT email FROM usuarios WHERE id = ANY($1)', [ids])).rows.map((l) => l.email).sort();
  const auditorias = async (solicitacaoId) => (await pool.query(
    'SELECT usuario_id, referencia, descricao, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id',
    [ACAO_AUDITORIA, String(solicitacaoId)],
  )).rows;

  // Pedido aprovado com falta: 3 pendentes e 1 coberto (2 sem cobertura).
  async function pedidoComFalta() {
    const m = await f.material();
    await f.estoque(m, 1);
    const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
    const { numero } = (await pool.query('SELECT numero FROM solicitacoes_epi WHERE id = $1', [alvo.id])).rows[0];
    return { ...alvo, materialId: m, numero };
  }

  before(async () => {
    env = await montarAmbiente12f({ servicoEmail: email });
    ({ pool, d, f, como } = env);
    u.entrega = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'] });
    u.entrega2 = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'] });
    u.soEncerra = await env.usuarioCom(d.empresaA, { acoes: ['ENCERRAR_SOLICITACAO'], sst: true });
    u.soVe = await env.usuarioCom(d.empresaA, { recursos: { request: ['visualizar'] } });
    u.movimentador = await env.usuarioCom(d.empresaA, { perfil: 'SUPERVISOR', acoes: ['ENTRADA_ESTOQUE'] });
    u.bloqueado = await env.usuarioCom(d.empresaA, { acoes: ['ENTRADA_ESTOQUE'] });
    await pool.query('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo, bloqueado_por) VALUES ($1, $2, $3)', [u.bloqueado, 'ENTRADA_ESTOQUE', d.master]);
    u.inativo = await env.usuarioCom(d.empresaA, { acoes: ['ENTRADA_ESTOQUE'] });
    await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [u.inativo]);
    u.movimentadorB = await env.usuarioCom(d.empresaB, { acoes: ['ENTRADA_ESTOQUE'] });
  });
  after(async () => { if (env) await env.encerrar(); });
  beforeEach(() => {
    email.enviados.length = 0;
    email.resposta = () => ({ estado: 'ENVIADO' });
  });

  describe('autoridade de quem dispara', () => {
    test('REALIZAR_ENTREGA dispara: 200 com quantos receberam', async () => {
      const alvo = await pedidoComFalta();
      const r = await alertar(u.entrega, alvo.id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: 'ok', alerta: { destinatarios: 3 } });
    });

    test('sem REALIZAR_ENTREGA (só encerra, ou só vê os próprios pedidos): 403 e nenhum e-mail', async () => {
      const alvo = await pedidoComFalta();
      for (const ator of [u.soEncerra, u.soVe, u.movimentador]) {
        const r = await alertar(ator, alvo.id);
        assert.equal(r.status, 403, JSON.stringify(r.body));
        assert.equal(r.body.codigo, 'PERMISSAO_NEGADA');
      }
      assert.deepEqual(email.enviados, []);
    });

    test('sem sessão: 401', async () => {
      const alvo = await pedidoComFalta();
      const r = await env.anonimo.post(ROTA, { solicitacaoId: alvo.id });
      assert.equal(r.status, 401);
    });
  });

  describe('destinatários', () => {
    test('recebe só quem tem ENTRADA_ESTOQUE efetiva, ativo e da empresa: MASTER pela permissão, não pelo nome; bloqueado, inativo, outra empresa e quem só entrega ficam de fora', async () => {
      const alvo = await pedidoComFalta();
      await alertar(u.entrega, alvo.id);
      assert.deepEqual(email.enviados.map((e) => e.para).sort(), await emailsDe([d.master, d.master2, u.movimentador]));
    });

    test('MASTER sem a permissão efetiva não recebe', async () => {
      await pool.query("UPDATE permissoes_acao SET permitido = false WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = 'ENTRADA_ESTOQUE'", [d.empresaA]);
      try {
        const alvo = await pedidoComFalta();
        await alertar(u.entrega, alvo.id);
        assert.deepEqual(email.enviados.map((e) => e.para), await emailsDe([u.movimentador]));
      } finally {
        await pool.query("UPDATE permissoes_acao SET permitido = true WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = 'ENTRADA_ESTOQUE'", [d.empresaA]);
      }
    });

    test('e-mail ausente ou inutilizável: a conta fica de fora e o alerta segue para os demais', async () => {
      const [original] = await emailsDe([u.movimentador]);
      await pool.query("UPDATE usuarios SET email = 'sem-arroba' WHERE id = $1", [u.movimentador]);
      try {
        const alvo = await pedidoComFalta();
        const r = await alertar(u.entrega, alvo.id);
        assert.equal(r.body.alerta.destinatarios, 2);
        assert.deepEqual(email.enviados.map((e) => e.para).sort(), await emailsDe([d.master, d.master2]));
      } finally {
        await pool.query('UPDATE usuarios SET email = $1 WHERE id = $2', [original, u.movimentador]);
      }
    });

    test('nenhum destinatário: 409 ALERTA_SEM_DESTINATARIO, sem e-mail e sem auditoria', async () => {
      await pool.query("UPDATE permissoes_acao SET permitido = false WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = 'ENTRADA_ESTOQUE'", [d.empresaA]);
      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [u.movimentador]);
      try {
        const alvo = await pedidoComFalta();
        const r = await alertar(u.entrega, alvo.id);
        assert.equal(r.status, 409);
        assert.equal(r.body.codigo, 'ALERTA_SEM_DESTINATARIO');
        assert.deepEqual([email.enviados.length, (await auditorias(alvo.id)).length], [0, 0]);
      } finally {
        await pool.query('UPDATE usuarios SET ativo = true WHERE id = $1', [u.movimentador]);
        await pool.query("UPDATE permissoes_acao SET permitido = true WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = 'ENTRADA_ESTOQUE'", [d.empresaA]);
      }
    });
  });

  describe('conteúdo', () => {
    test('pedido, EPI, tamanho, pendente e sem cobertura; nenhum dado do trabalhador; assunto constante', async () => {
      const alvo = await pedidoComFalta();
      await alertar(u.entrega, alvo.id);
      const { nome, matricula, cpf } = (await pool.query('SELECT nome, matricula, cpf FROM funcionarios WHERE id = $1', [d.trabalhador])).rows[0];
      const material = (await pool.query('SELECT nome FROM materiais WHERE id = $1', [alvo.materialId])).rows[0].nome;
      assert.equal(email.enviados.length, 3);
      for (const e of email.enviados) {
        assert.equal(e.tipo, 'FALTA_ESTOQUE_ENTREGA');
        assert.equal(e.conteudo.assunto, 'Falta de estoque para entrega de EPI — SafeWork Engenharia');
        const { texto, html } = e.conteudo;
        assert.match(texto, new RegExp(`Pedido nº ${alvo.numero}\\b`));
        assert.ok(texto.includes(`${material}, tamanho 40: 3 pendentes, 2 sem cobertura`), texto);
        for (const pessoal of [nome, matricula, cpf]) assert.equal(texto.includes(pessoal) || html.includes(pessoal), false, pessoal);
      }
    });
  });

  describe('supressão do clique repetido', () => {
    test('o mesmo usuário no mesmo pedido: 429 ALERTA_FALTA_RECENTE e nenhum e-mail novo', async () => {
      const alvo = await pedidoComFalta();
      assert.equal((await alertar(u.entrega, alvo.id)).status, 200);
      const enviados = email.enviados.length;
      const r = await alertar(u.entrega, alvo.id);
      assert.equal(r.status, 429);
      assert.equal(r.body.codigo, 'ALERTA_FALTA_RECENTE');
      assert.equal(email.enviados.length, enviados);
      assert.equal((await auditorias(alvo.id)).length, 1);
    });

    test('outro pedido do mesmo usuário e o mesmo pedido por outro usuário não são suprimidos', async () => {
      const um = await pedidoComFalta();
      const outro = await pedidoComFalta();
      assert.equal((await alertar(u.entrega, um.id)).status, 200);
      assert.equal((await alertar(u.entrega, outro.id)).status, 200);
      assert.equal((await alertar(u.entrega2, um.id)).status, 200);
    });

    test('dois cliques simultâneos: um 200 e um 429; cada destinatário recebe uma vez', async () => {
      const alvo = await pedidoComFalta();
      email.resposta = () => new Promise((r) => { setTimeout(() => r({ estado: 'ENVIADO' }), 40); });
      const respostas = await comLimite(Promise.all([alertar(u.entrega, alvo.id), alertar(u.entrega, alvo.id)]), 'dois cliques', 10000);
      assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 429]);
      assert.equal(email.enviados.length, 3);
    });

    test('auditoria do alerta: só ids e números; nada de e-mail, nome, texto ou conteúdo da mensagem', async () => {
      const alvo = await pedidoComFalta();
      await alertar(u.entrega, alvo.id);
      const [registro] = await auditorias(alvo.id);
      assert.equal(registro.usuario_id, u.entrega);
      assert.deepEqual(registro.contexto, { solicitacaoId: alvo.id, itensSemCobertura: 1, destinatarios: 3 });
      const tudo = JSON.stringify(registro);
      assert.doesNotMatch(tudo, /@|Pedido nº|Material de reserva/);
    });
  });

  describe('falha do alerta não mexe na entrega', () => {
    test('falha de envio: 503 ALERTA_NAO_ENVIADO, sem auditoria (o próximo clique não é suprimido); a solicitação continua igual e a entrega segue normal', async () => {
      const m = await f.material();
      const loteId = await f.estoque(m, 1);
      const alvo = await f.aprovada({ materialId: m, quantidade: 3 });
      email.resposta = () => ({ estado: 'FALHA', codigo: 'ETIMEDOUT' });
      const r = await alertar(u.entrega, alvo.id);
      assert.equal(r.status, 503);
      assert.equal(r.body.codigo, 'ALERTA_NAO_ENVIADO');
      assert.deepEqual(await auditorias(alvo.id), []);
      assert.equal((await pool.query('SELECT status FROM solicitacoes_epi WHERE id = $1', [alvo.id])).rows[0].status, 'APROVADA');
      const entrega = await como(d.master).post(`/api/solicitacoes-epi/${alvo.id}/entregas`, {
        itens: [{ solicitacaoItemId: alvo.item, loteId, quantidade: 1 }], confirmacao: ACEITE, chaveIdempotencia: chaveNova(),
      });
      assert.equal(entrega.status, 201, JSON.stringify(entrega.body));
      email.resposta = () => ({ estado: 'ENVIADO' });
      assert.equal((await alertar(u.entrega, alvo.id)).status, 200, 'sem auditoria da falha, o novo clique passa');
    });

    test('e-mail desativado no ambiente: 503 ALERTA_NAO_ENVIADO, sem fingir envio e sem auditoria', async () => {
      const alvo = await pedidoComFalta();
      email.resposta = () => ({ estado: 'NAO_ENVIADO' });
      const r = await alertar(u.entrega, alvo.id);
      assert.deepEqual([r.status, r.body.codigo], [503, 'ALERTA_NAO_ENVIADO']);
      assert.deepEqual(await auditorias(alvo.id), []);
    });

    test('parte dos destinatários falha: 200 com quantos receberam, e a auditoria registra', async () => {
      const alvo = await pedidoComFalta();
      let n = 0;
      email.resposta = () => { n += 1; return n === 1 ? { estado: 'FALHA', codigo: 'ETIMEDOUT' } : { estado: 'ENVIADO' }; };
      const r = await alertar(u.entrega, alvo.id);
      assert.deepEqual([r.status, r.body.alerta.destinatarios], [200, 2]);
      assert.equal((await auditorias(alvo.id))[0].contexto.destinatarios, 2);
    });
  });

  describe('pedido e empresa', () => {
    test('pedido inexistente e pedido de outra empresa: o mesmo 404', async () => {
      await vincularMaterialAoGhe(pool, d.empresaB, d.gheB, d.botinaB);
      const criadaB = await solicitacaoSvc.criarSolicitacao(pool, {
        empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [{ materialId: d.botinaB, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }],
        chaveIdempotencia: chaveNova(),
      });
      await solicitacaoSvc.decidirSolicitacao(pool, {
        empresaId: d.empresaB, atorId: d.sstB, solicitacaoId: criadaB.solicitacao.id, decisoes: [{ itemId: criadaB.itens[0].id, decisao: 'APROVADO' }], hoje: f.HOJE,
      });
      const inexistente = await alertar(u.entrega, 2147483001);
      const deB = await alertar(u.entrega, criadaB.solicitacao.id);
      assert.deepEqual([inexistente.status, deB.status], [404, 404]);
      assert.deepEqual(deB.body, inexistente.body);
      assert.equal(inexistente.body.codigo, 'SOLICITACAO_NAO_ENCONTRADA');
      assert.deepEqual(email.enviados, []);
    });

    test('pedido sem falta (tudo coberto): 409 SEM_FALTA_DE_ESTOQUE', async () => {
      const m = await f.material();
      await f.estoque(m, 5);
      const alvo = await f.aprovada({ materialId: m, quantidade: 2 });
      const r = await alertar(u.entrega, alvo.id);
      assert.deepEqual([r.status, r.body.codigo], [409, 'SEM_FALTA_DE_ESTOQUE']);
    });

    test('pedido que não está aprovado para entrega (pendente ou encerrado): 409 SOLICITACAO_NAO_ENTREGAVEL', async () => {
      const m = await f.material();
      const pendente = await solicitacaoSvc.criarSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.solicitante, funcionarioId: d.trabalhador, itens: [{ materialId: m, tamanho: '40', quantidade: 1, motivo: 'ADMISSAO' }], chaveIdempotencia: chaveNova(),
      });
      const encerrada = await pedidoComFalta();
      await solicitacaoSvc.encerrarSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.master, solicitacaoId: encerrada.id, justificativa: 'Não será mais entregue (fictício)', hoje: f.HOJE,
      });
      for (const id of [pendente.solicitacao.id, encerrada.id]) {
        const r = await alertar(u.entrega, id);
        assert.deepEqual([r.status, r.body.codigo], [409, 'SOLICITACAO_NAO_ENTREGAVEL']);
      }
    });

    test('corpo estrito: empresa, destinatários ou texto vindos do cliente são recusados com 400', async () => {
      const alvo = await pedidoComFalta();
      for (const extra of [{ empresaId: d.empresaB }, { destinatarios: ['x@example.invalid'] }, { mensagem: 'oi' }]) {
        const r = await alertar(u.entrega, alvo.id, extra);
        assert.equal(r.status, 400, JSON.stringify(extra));
      }
      for (const id of ['abc', 0, -1, 1.5, null]) assert.equal((await alertar(u.entrega, id)).status, 400, String(id));
      assert.equal((await como(u.entrega).post(ROTA, {})).status, 400, 'sem o pedido');
      assert.deepEqual(email.enviados, []);
    });
  });
});
