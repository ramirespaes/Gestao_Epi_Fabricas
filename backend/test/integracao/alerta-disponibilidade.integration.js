'use strict';

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { montarAmbiente12f } = require('./helpers/ambiente-http-12f');
const { chaveNova, vincularMaterialAoGhe, comLimite } = require('./helpers/solicitacao-epi-servico');
const { exigirModulo } = require('../helpers/exigir-modulo');
const estoqueSvc = require('../../src/services/estoque.service');
const solicitacaoSvc = require('../../src/services/solicitacao-epi.service');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * 12G-6 — aviso automático de disponibilidade, contra PostgreSQL real
 * (schema temporário com todas as migrations, inclusive a 069).
 *
 * A disponibilidade continua derivada e nada é gravado item a item. A ENTRADA
 * de estoque é relevante quando faz algum item de solicitação aprovada passar
 * de cobertura 0 para cobertura > 0 no par da entrada; aí ela abre ou estende o
 * agendamento PENDENTE da empresa (cerca de 10 minutos depois da última entrada
 * relevante). O processador recalcula a situação ATUAL da empresa no envio e
 * manda um resumo operacional agregado por EPI + tamanho (quantidade disponível
 * agora e quantos pedidos), sem trabalhador nem pedido individual — o detalhe é
 * da tela Entregas por solicitação. O envio é at-least-once: só fica ENVIADO
 * quando todos os destinatários da tentativa receberam.
 */

const TIPO = 'DISPONIBILIDADE_ESTOQUE_ENTREGA';
const MINUTO = 60_000;

function servicoEmailFalso({ resposta = () => ({ estado: 'ENVIADO' }), atraso = 0 } = {}) {
  const enviados = [];
  return {
    enviados,
    async enviarAguardando(mensagem) {
      if (atraso > 0) await new Promise((r) => { setTimeout(r, atraso); });
      enviados.push(mensagem);
      return resposta(mensagem);
    },
  };
}

describe('12G-6 — aviso automático de disponibilidade (agendamento e processador, sem nada item a item)', () => {
  let env;
  let pool;
  let d;
  let f;
  let svc;
  const u = {};
  const hoje = dataOperacional();

  before(async () => {
    svc = exigirModulo('src/services/alerta-disponibilidade.service');
    env = await montarAmbiente12f();
    ({ pool, d, f } = env);
    u.sstEntrega = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'], sst: true });
    u.soEntrega = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'] });
    u.soSst = await env.usuarioCom(d.empresaA, { sst: true });
    u.supervisor = await env.usuarioCom(d.empresaA, { perfil: 'SUPERVISOR', acoes: ['REALIZAR_ENTREGA'], sst: true });
    u.sstEntregaB = await env.usuarioCom(d.empresaB, { acoes: ['REALIZAR_ENTREGA'], sst: true });
    await vincularMaterialAoGhe(pool, d.empresaB, d.gheB, d.botinaB);
  });
  after(async () => { if (env) await env.encerrar(); });

  // Cada cenário parte de uma empresa sem demanda aprovada (encerrada pelo serviço real) e sem agendamento.
  beforeEach(async () => {
    await pool.query('DELETE FROM alertas_estoque_agendamentos');
    const { rows } = await pool.query("SELECT id, empresa_id FROM solicitacoes_epi WHERE status IN ('APROVADA', 'APROVADA_PARCIAL')");
    for (const r of rows) {
      await solicitacaoSvc.encerrarSolicitacao(pool, {
        empresaId: r.empresa_id, atorId: r.empresa_id === d.empresaA ? d.master : d.masterB, solicitacaoId: r.id, justificativa: 'Fim do cenário de teste (fictício)', hoje,
      });
    }
  });

  const entrar = (materialId, quantidade, { empresaId = d.empresaA, tamanho = '40', chave = chaveNova() } = {}) => estoqueSvc.registrarEntrada(pool, {
    empresaId, atorId: empresaId === d.empresaA ? d.master : d.masterB, materialId, tamanho, quantidade, caNumero: '12345', caValidade: '2099-12-31', chaveIdempotencia: chave, hoje,
  });
  const agendamentos = async (empresaId = d.empresaA) => (await pool.query('SELECT * FROM alertas_estoque_agendamentos WHERE empresa_id = $1 ORDER BY id', [empresaId])).rows;
  const depoisDaJanela = async () => new Date((await pool.query('SELECT now() AS agora')).rows[0].agora.getTime() + 11 * MINUTO);
  const processar = async (servicoEmail, agora) => svc.processarVencidos(pool, { agora: agora ?? await depoisDaJanela(), hoje, servicoEmail });
  const nomeDoMaterial = async (id) => (await pool.query('SELECT nome FROM materiais WHERE id = $1', [id])).rows[0].nome;
  const trabalhadores = async (ids) => (await pool.query('SELECT nome, matricula, cpf FROM funcionarios WHERE id = ANY($1)', [ids])).rows;
  const numeroDe = async (solicitacaoId) => (await pool.query('SELECT numero FROM solicitacoes_epi WHERE id = $1', [solicitacaoId])).rows[0].numero;
  const linhaDe = (texto, material) => texto.split('\n').find((l) => l.startsWith(`${material},`) || l.startsWith(`${material}:`));

  // Solicitação aprovada na empresa B, pelos serviços, com o decisor de B. Cada cenário usa um tamanho
  // próprio, porque o estoque de um cenário anterior continua no par (só a demanda é encerrada).
  async function aprovadaB(quantidade, tamanho) {
    const criada = await solicitacaoSvc.criarSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.usuarioB, funcionarioId: d.trabalhadorB, itens: [{ materialId: d.botinaB, tamanho, quantidade, motivo: 'ADMISSAO' }],
      chaveIdempotencia: chaveNova(),
    });
    await solicitacaoSvc.decidirSolicitacao(pool, {
      empresaId: d.empresaB, atorId: d.sstB, solicitacaoId: criada.solicitacao.id, decisoes: [{ itemId: criada.itens[0].id, decisao: 'APROVADO' }], hoje,
    });
    return { id: criada.solicitacao.id, item: criada.itens[0].id };
  }

  // Um pedido aguardando e a entrada que o deixa disponível: abre a janela.
  async function umDisponivel(quantidade = 1) {
    const m = await f.material();
    const alvo = await f.aprovada({ materialId: m, quantidade });
    await entrar(m, quantidade);
    return { m, ...alvo };
  }

  // ───────────────────────────── entrada → agendamento (relevância 0 → > 0) ─────────────────────────────
  describe('entrada de estoque → agendamento (relevante = algum item passa de cobertura 0 para > 0)', () => {
    test('entrada relevante abre um PENDENTE com a janela de ~10 minutos; o contrato da entrada não muda; nada item a item é gravado', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 3 });
      const antes = (await pool.query('SELECT now() AS t')).rows[0].t;
      const r = await entrar(m, 1);
      assert.deepEqual(Object.keys(r).sort(), ['lote', 'operacao', 'repetida']);
      const [a, outro] = await agendamentos();
      assert.equal(outro, undefined);
      assert.deepEqual([a.tipo, a.estado, a.tentativas], [TIPO, 'PENDENTE', 0]);
      assert.ok(a.primeira_entrada_em >= antes && a.ultima_entrada_em.getTime() === a.primeira_entrada_em.getTime());
      const janela = a.enviar_apos.getTime() - a.ultima_entrada_em.getTime();
      assert.ok(janela >= 9 * MINUTO && janela <= 11 * MINUTO, `janela de ${janela} ms`);
      const { rows } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'alertas%'");
      assert.deepEqual(rows.map((x) => x.table_name), ['alertas_estoque_agendamentos']);
    });

    test('entrada sem demanda no par não abre agendamento', async () => {
      await entrar(await f.material(), 5);
      assert.deepEqual(await agendamentos(), []);
    });

    test('entrada para item que já tinha cobertura > 0 não é relevante', async () => {
      const m = await f.material();
      await f.estoque(m, 1);
      await f.aprovada({ materialId: m, quantidade: 3 });
      await entrar(m, 2);
      assert.deepEqual(await agendamentos(), []);
    });

    test('na fila FIFO, basta um item sair de zero para a entrada ser relevante', async () => {
      const m = await f.material();
      await f.estoque(m, 2);
      await f.aprovada({ materialId: m, quantidade: 2 });
      await f.aprovada({ materialId: m, quantidade: 2, funcionarioId: d.trabalhador2 });
      await entrar(m, 1);
      assert.equal((await agendamentos()).length, 1);
    });

    test('entrada em outro tamanho não toca o par do pedido', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 1 });
      await entrar(m, 3, { tamanho: '42' });
      assert.deepEqual(await agendamentos(), []);
    });

    test('a repetição da mesma entrada (mesma chave) não estende a janela', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 1 });
      const chave = chaveNova();
      await entrar(m, 1, { chave });
      const [a1] = await agendamentos();
      await new Promise((r) => { setTimeout(r, 20); });
      assert.equal((await entrar(m, 1, { chave })).repetida, true);
      const [a2] = await agendamentos();
      assert.equal(a2.ultima_entrada_em.getTime(), a1.ultima_entrada_em.getTime());
    });

    test('nova entrada relevante durante o PENDENTE estende a janela e preserva a primeira entrada; continua um PENDENTE só', async () => {
      await umDisponivel();
      const [a1] = await agendamentos();
      await new Promise((r) => { setTimeout(r, 20); });
      await umDisponivel();
      const [a2, extra] = await agendamentos();
      assert.equal(extra, undefined);
      assert.equal(a2.id, a1.id);
      assert.equal(a2.primeira_entrada_em.getTime(), a1.primeira_entrada_em.getTime());
      assert.ok(a2.ultima_entrada_em > a1.ultima_entrada_em);
      assert.ok(a2.enviar_apos > a1.enviar_apos);
      assert.equal(a2.enviar_apos.getTime() - a2.ultima_entrada_em.getTime(), a1.enviar_apos.getTime() - a1.ultima_entrada_em.getTime(), 'enviar_apos acompanha a última entrada');
    });

    test('entrada que não é relevante não estende a janela do PENDENTE', async () => {
      await umDisponivel();
      const [a1] = await agendamentos();
      await entrar(await f.material(), 3);
      const [a2] = await agendamentos();
      assert.equal(a2.enviar_apos.getTime(), a1.enviar_apos.getTime());
    });

    for (const [estado, preparar] of [
      ['ENVIANDO', "UPDATE alertas_estoque_agendamentos SET estado = 'ENVIANDO', reivindicado_em = now(), tentativas = 1 WHERE id = $1"],
      ['AGUARDANDO_RETRY', "UPDATE alertas_estoque_agendamentos SET estado = 'AGUARDANDO_RETRY', proxima_tentativa_em = now() + interval '2 minutes', codigo_ultimo_erro = 'ETIMEDOUT' WHERE id = $1"],
      ['FALHA', "UPDATE alertas_estoque_agendamentos SET estado = 'FALHA', processado_em = now(), codigo_ultimo_erro = 'ETIMEDOUT' WHERE id = $1"],
    ]) {
      test(`${estado} + nova entrada relevante → o lote antigo não muda e nasce um PENDENTE novo`, async () => {
        await umDisponivel();
        const [a] = await agendamentos();
        await pool.query("UPDATE alertas_estoque_agendamentos SET estado = 'ENVIANDO', reivindicado_em = now(), tentativas = 1 WHERE id = $1", [a.id]);
        if (estado !== 'ENVIANDO') await pool.query(preparar, [a.id]);
        const antes = (await agendamentos())[0];
        await umDisponivel();
        const [velho, novo] = await agendamentos();
        assert.deepEqual([velho.id, velho.estado, velho.enviar_apos.getTime(), velho.ultima_entrada_em.getTime()], [a.id, estado, antes.enviar_apos.getTime(), antes.ultima_entrada_em.getTime()]);
        assert.equal(novo.estado, 'PENDENTE');
      });
    }

    test('duas entradas relevantes simultâneas de materiais diferentes: um PENDENTE só', async () => {
      const m = await f.material();
      const m2 = await f.material();
      await f.aprovada({ materialId: m, quantidade: 1 });
      await f.aprovada({ materialId: m2, quantidade: 1 });
      await Promise.all([entrar(m, 1), entrar(m2, 1)]);
      assert.equal((await agendamentos()).length, 1);
    });

    test('isolamento: a entrada da empresa B abre o agendamento de B e não toca o de A', async () => {
      await umDisponivel();
      const [deA] = await agendamentos();
      await aprovadaB(1, '41');
      await entrar(d.botinaB, 1, { empresaId: d.empresaB, tamanho: '41' });
      assert.equal((await agendamentos(d.empresaB)).length, 1);
      const [aDepois, extra] = await agendamentos(d.empresaA);
      assert.equal(extra, undefined);
      assert.equal(aDepois.ultima_entrada_em.getTime(), deA.ultima_entrada_em.getTime());
    });
  });

  // ───────────────────────────────── processador ─────────────────────────────────
  describe('processador: resumo operacional ATUAL, agregado por EPI + tamanho', () => {
    test('antes da janela nada é enviado', async () => {
      await umDisponivel();
      const email = servicoEmailFalso();
      await processar(email, new Date());
      assert.deepEqual([email.enviados.length, (await agendamentos())[0].estado], [0, 'PENDENTE']);
    });

    test('resumo agregado: cada EPI + tamanho com a quantidade disponível agora e quantos pedidos; sem trabalhador, matrícula, CPF nem número de pedido; ENVIADO', async () => {
      const m = await f.material();
      const m2 = await f.material();
      const um = await f.aprovada({ materialId: m, quantidade: 3 });
      const dois = await f.aprovada({ materialId: m, quantidade: 1, funcionarioId: d.trabalhador2 });
      const tres = await f.aprovada({ materialId: m2, quantidade: 1, funcionarioId: d.trabalhador3 });
      await entrar(m, 4);
      await entrar(m2, 1);
      const email = servicoEmailFalso();
      const r = await processar(email);
      const [a] = await agendamentos();
      assert.deepEqual([a.estado, a.linhas_resumo, a.destinatarios_alcancados], ['ENVIADO', 2, 2]);
      assert.deepEqual(r.processados.map((p) => p.estado), ['ENVIADO']);
      assert.deepEqual(email.enviados.map((e) => e.para).sort(), ['usuario-12f-1@example.invalid', 'usuario-12f-4@example.invalid'], 'só quem tem vínculo SST e REALIZAR_ENTREGA');
      for (const e of email.enviados) {
        assert.equal(e.tipo, TIPO);
        const { texto, html } = e.conteudo;
        assert.equal(linhaDe(texto, await nomeDoMaterial(m)), `${await nomeDoMaterial(m)}, tamanho 40: 4 unidades disponíveis para 2 pedidos`);
        assert.equal(linhaDe(texto, await nomeDoMaterial(m2)), `${await nomeDoMaterial(m2)}, tamanho 40: 1 unidade disponível para 1 pedido`);
        for (const t of await trabalhadores([d.trabalhador, d.trabalhador2, d.trabalhador3])) {
          for (const pessoal of [t.nome, t.matricula, t.cpf]) assert.equal(texto.includes(pessoal) || html.includes(pessoal), false, `dado pessoal no e-mail: ${pessoal}`);
        }
        assert.doesNotMatch(texto, /Pedido nº|matrícula/i);
        for (const alvo of [um, dois, tres]) assert.doesNotMatch(texto, new RegExp(`nº ${await numeroDe(alvo.id)}\\b`));
      }
    });

    test('o resumo é a situação atual: entra o que já estava disponível sem ter aberto a janela; sai o pedido encerrado antes do envio', async () => {
      const antigo = await f.material();
      await f.estoque(antigo, 1);
      await f.aprovada({ materialId: antigo, quantidade: 1 });
      const encerrado = await umDisponivel();
      const valido = await umDisponivel();
      await solicitacaoSvc.encerrarSolicitacao(pool, {
        empresaId: d.empresaA, atorId: d.master, solicitacaoId: encerrado.id, justificativa: 'Trabalhador transferido (fictício)', hoje,
      });
      const email = servicoEmailFalso();
      await processar(email);
      const { texto } = email.enviados[0].conteudo;
      assert.ok(linhaDe(texto, await nomeDoMaterial(antigo)), 'o disponível que não abriu a janela também está no resumo atual');
      assert.ok(linhaDe(texto, await nomeDoMaterial(valido.m)));
      assert.equal(linhaDe(texto, await nomeDoMaterial(encerrado.m)), undefined, 'o encerrado não aparece');
      assert.equal((await agendamentos())[0].linhas_resumo, 2);
    });

    test('sem nenhuma disponibilidade no envio: DESCARTADO com SEM_DISPONIBILIDADE, sem e-mail', async () => {
      const m = await f.material();
      await f.aprovada({ materialId: m, quantidade: 1 });
      const { lote } = await entrar(m, 1);
      await f.baixa(lote.loteId, 1, 'AVARIA');
      const email = servicoEmailFalso();
      await processar(email);
      const [a] = await agendamentos();
      assert.deepEqual([a.estado, a.codigo_ultimo_erro, email.enviados.length], ['DESCARTADO', 'SEM_DISPONIBILIDADE', 0]);
    });

    test('decisão aceita: o que segue disponível volta a aparecer no resumo de uma janela seguinte (resumo atual, não histórico de transições)', async () => {
      const primeiro = await umDisponivel();
      const email = servicoEmailFalso();
      await processar(email);
      const segundo = await umDisponivel();
      email.enviados.length = 0;
      await processar(email);
      const { texto } = email.enviados[0].conteudo;
      assert.ok(linhaDe(texto, await nomeDoMaterial(primeiro.m)), 'o primeiro, ainda disponível, aparece de novo');
      assert.ok(linhaDe(texto, await nomeDoMaterial(segundo.m)));
    });

    test('sem destinatário válido no envio: DESCARTADO com SEM_DESTINATARIO, sem retry e sem e-mail', async () => {
      await umDisponivel();
      await pool.query('UPDATE usuarios SET ativo = false WHERE id = ANY($1)', [[u.sstEntrega, u.supervisor]]);
      try {
        const email = servicoEmailFalso();
        await processar(email);
        const [a] = await agendamentos();
        assert.deepEqual([a.estado, a.codigo_ultimo_erro, email.enviados.length], ['DESCARTADO', 'SEM_DESTINATARIO', 0]);
      } finally {
        await pool.query('UPDATE usuarios SET ativo = true WHERE id = ANY($1)', [[u.sstEntrega, u.supervisor]]);
      }
    });

    test('e-mail desativado no ambiente: DESCARTADO com EMAIL_DESATIVADO, sem fingir envio', async () => {
      await umDisponivel();
      await processar(servicoEmailFalso({ resposta: () => ({ estado: 'NAO_ENVIADO' }) }));
      const [a] = await agendamentos();
      assert.deepEqual([a.estado, a.codigo_ultimo_erro], ['DESCARTADO', 'EMAIL_DESATIVADO']);
    });

    test('modo arquivo (GRAVADO) conta como enviado', async () => {
      await umDisponivel();
      await processar(servicoEmailFalso({ resposta: () => ({ estado: 'GRAVADO' }) }));
      assert.equal((await agendamentos())[0].estado, 'ENVIADO');
    });

    test('at-least-once: um destinatário recebe e outro falha → AGUARDANDO_RETRY, nunca ENVIADO', async () => {
      await umDisponivel();
      let n = 0;
      await processar(servicoEmailFalso({ resposta: () => { n += 1; return n === 1 ? { estado: 'ENVIADO' } : { estado: 'FALHA', codigo: 'ETIMEDOUT' }; } }));
      const [a] = await agendamentos();
      assert.deepEqual([a.estado, a.tentativas, a.codigo_ultimo_erro, a.destinatarios_alcancados], ['AGUARDANDO_RETRY', 1, 'ETIMEDOUT', null]);
    });

    test('falha de todos: AGUARDANDO_RETRY com espera crescente; antes da próxima tentativa nada acontece; no limite, FALHA', async () => {
      await umDisponivel();
      const falha = servicoEmailFalso({ resposta: () => ({ estado: 'FALHA', codigo: 'ETIMEDOUT' }) });
      let agora = await depoisDaJanela();
      await processar(falha, agora);
      let [a] = await agendamentos();
      assert.deepEqual([a.estado, a.tentativas, a.codigo_ultimo_erro], ['AGUARDANDO_RETRY', 1, 'ETIMEDOUT']);
      let ultimaEspera = a.proxima_tentativa_em.getTime() - agora.getTime();
      assert.ok(ultimaEspera > 0);
      await processar(falha, new Date(a.proxima_tentativa_em.getTime() - 1000));
      assert.equal((await agendamentos())[0].tentativas, 1, 'antes da próxima tentativa');
      for (let tentativa = 2; tentativa <= svc.MAX_TENTATIVAS; tentativa += 1) {
        agora = new Date(a.proxima_tentativa_em.getTime() + 1000);
        await processar(falha, agora);
        [a] = await agendamentos();
        assert.equal(a.tentativas, tentativa);
        if (tentativa < svc.MAX_TENTATIVAS) {
          const espera = a.proxima_tentativa_em.getTime() - agora.getTime();
          assert.ok(espera > ultimaEspera, `a espera cresce a cada tentativa (${espera} ms depois de ${ultimaEspera} ms)`);
          ultimaEspera = espera;
        }
      }
      assert.deepEqual([a.estado, a.codigo_ultimo_erro], ['FALHA', 'ETIMEDOUT']);
      await processar(falha, new Date(agora.getTime() + 24 * 60 * MINUTO));
      assert.equal((await agendamentos())[0].tentativas, svc.MAX_TENTATIVAS, 'FALHA é final');
    });

    test('a nova tentativa resolve os destinatários de novo: quem perdeu o vínculo sai, quem ganhou entra (reenviar a quem já recebeu é aceito)', async () => {
      await umDisponivel();
      await processar(servicoEmailFalso({ resposta: () => ({ estado: 'FALHA', codigo: 'ETIMEDOUT' }) }));
      const [a] = await agendamentos();
      await pool.query('DELETE FROM vinculo_sst WHERE usuario_id = $1', [u.supervisor]);
      const novo = await env.usuarioCom(d.empresaA, { acoes: ['REALIZAR_ENTREGA'], sst: true });
      try {
        const email = servicoEmailFalso();
        await processar(email, new Date(a.proxima_tentativa_em.getTime() + 1000));
        const esperados = (await pool.query('SELECT email FROM usuarios WHERE id = ANY($1) ORDER BY email', [[u.sstEntrega, novo]])).rows.map((x) => x.email);
        assert.deepEqual(email.enviados.map((e) => e.para).sort(), esperados);
        assert.equal((await agendamentos())[0].estado, 'ENVIADO');
      } finally {
        await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [novo]);
        await pool.query('INSERT INTO vinculo_sst (empresa_id, usuario_id, concedido_por) VALUES ($1, $2, $3)', [d.empresaA, u.supervisor, d.master]);
      }
    });

    test('dois processadores ao mesmo tempo não enviam o mesmo agendamento', async () => {
      await umDisponivel();
      const email = servicoEmailFalso({ atraso: 50 });
      const agora = await depoisDaJanela();
      await Promise.all([processar(email, agora), processar(email, agora)]);
      assert.equal(email.enviados.length, 2, 'uma vez para cada um dos dois destinatários');
      assert.equal((await agendamentos())[0].estado, 'ENVIADO');
    });

    // Um retry vencido (A) e um PENDENTE vencido (B) da mesma empresa e tipo.
    async function doisLotesVencidos() {
      await umDisponivel();
      const [a] = await agendamentos();
      await pool.query("UPDATE alertas_estoque_agendamentos SET estado = 'ENVIANDO', reivindicado_em = now(), tentativas = 1 WHERE id = $1", [a.id]);
      await pool.query("UPDATE alertas_estoque_agendamentos SET estado = 'AGUARDANDO_RETRY', proxima_tentativa_em = now(), codigo_ultimo_erro = 'ETIMEDOUT' WHERE id = $1", [a.id]);
      await umDisponivel();
      const [, b] = await agendamentos();
      return { a, b };
    }
    const estadoDe = async (id) => (await pool.query('SELECT estado FROM alertas_estoque_agendamentos WHERE id = $1', [id])).rows[0].estado;

    test('dois lotes vencidos da mesma empresa e tipo não saem juntos: um por vez, o mais antigo primeiro', async () => {
      const { a, b } = await doisLotesVencidos();
      const email = servicoEmailFalso();
      const r = await processar(email);
      assert.deepEqual(r.processados.map((p) => p.estado), ['ENVIADO']);
      assert.deepEqual([await estadoDe(a.id), await estadoDe(b.id)], ['ENVIADO', 'PENDENTE']);
      await processar(email);
      assert.equal(await estadoDe(b.id), 'ENVIADO');
    });

    test('dois processadores simultâneos também não enviam dois lotes da mesma empresa e tipo ao mesmo tempo', async () => {
      const { a, b } = await doisLotesVencidos();
      const email = servicoEmailFalso({ atraso: 50 });
      const agora = await depoisDaJanela();
      await Promise.all([processar(email, agora), processar(email, agora)]);
      assert.deepEqual([await estadoDe(a.id), await estadoDe(b.id)], ['ENVIADO', 'PENDENTE']);
      assert.equal(email.enviados.length, 2, 'só o lote A, para os dois destinatários');
    });

    test('o processador não espera a entrada em andamento: o agendamento travado fica para a próxima execução', async () => {
      await umDisponivel();
      const [a] = await agendamentos();
      const segurando = await pool.connect();
      const email = servicoEmailFalso();
      try {
        await segurando.query('BEGIN');
        await segurando.query('SELECT id FROM alertas_estoque_agendamentos WHERE id = $1 FOR UPDATE', [a.id]);
        const r = await comLimite(processar(email), 'processador com o agendamento travado');
        assert.deepEqual([r.processados, email.enviados.length], [[], 0]);
      } finally {
        await segurando.query('ROLLBACK');
        segurando.release();
      }
      await processar(email);
      assert.equal((await agendamentos())[0].estado, 'ENVIADO');
    });

    test('reinício: o PENDENTE sobrevive no banco e um processador novo o envia; o ENVIANDO abandonado é retomado', async () => {
      await umDisponivel();
      const [a] = await agendamentos();
      await pool.query("UPDATE alertas_estoque_agendamentos SET estado = 'ENVIANDO', reivindicado_em = now() - interval '30 minutes', tentativas = 1 WHERE id = $1", [a.id]);
      const email = servicoEmailFalso();
      await processar(email);
      const [depois] = await agendamentos();
      assert.deepEqual([depois.estado, depois.tentativas], ['ENVIADO', 2]);
      assert.equal(email.enviados.length, 2);
    });

    test('isolamento: cada empresa recebe o seu resumo, com os seus EPIs, pelos seus destinatários (o MASTER de B com vínculo SST só recebe o de B)', async () => {
      const deA = await umDisponivel();
      await aprovadaB(1, '43');
      await entrar(d.botinaB, 1, { empresaId: d.empresaB, tamanho: '43' });
      await pool.query('INSERT INTO vinculo_sst (empresa_id, usuario_id, concedido_por) VALUES ($1, $2, $2)', [d.empresaB, d.masterB]);
      try {
        const email = servicoEmailFalso();
        await processar(email);
        const deB = ['usuario-12f-5@example.invalid', 'master-b@example.invalid'];
        const paraB = email.enviados.filter((e) => deB.includes(e.para));
        const paraA = email.enviados.filter((e) => !deB.includes(e.para));
        assert.deepEqual(paraB.map((e) => e.para).sort(), [...deB].sort());
        assert.deepEqual(paraA.map((e) => e.para).sort(), ['usuario-12f-1@example.invalid', 'usuario-12f-4@example.invalid']);
        const materialB = await nomeDoMaterial(d.botinaB);
        const materialA = await nomeDoMaterial(deA.m);
        for (const e of paraA) {
          assert.equal(linhaDe(e.conteudo.texto, materialB), undefined, 'A nunca vê EPI de B');
          assert.ok(linhaDe(e.conteudo.texto, materialA));
        }
        for (const e of paraB) {
          assert.ok(linhaDe(e.conteudo.texto, materialB));
          assert.equal(linhaDe(e.conteudo.texto, materialA), undefined, 'B nunca vê EPI de A');
        }
      } finally {
        await pool.query('DELETE FROM vinculo_sst WHERE usuario_id = $1', [d.masterB]);
      }
    });
  });

  // ───────────────────────────── transportes reais do Bloco 11 ─────────────────────────────
  describe('com o serviço de e-mail e os transportes reais (desativado, arquivo e SMTP de teste)', () => {
    const { criarServicoEmail } = require('../../src/email/servico-email'); // eslint-disable-line global-require
    const { criarTransporte } = require('../../src/email/transporte'); // eslint-disable-line global-require
    const { carregarConfigEmail } = require('../../src/config/email'); // eslint-disable-line global-require
    const servicoReal = (config) => criarServicoEmail({ transporte: criarTransporte(config), registrar: () => {} });

    test('desativado: nada sai e o lote termina DESCARTADO com EMAIL_DESATIVADO', async () => {
      await umDisponivel();
      await processar(servicoReal({ modo: 'desativado' }));
      const [a] = await agendamentos();
      assert.deepEqual([a.estado, a.codigo_ultimo_erro], ['DESCARTADO', 'EMAIL_DESATIVADO']);
    });

    test('arquivo: grava uma mensagem por destinatário, com o resumo por EPI + tamanho e sem dado pessoal; ENVIADO', async () => {
      const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'alerta-12g6-'));
      try {
        const alvo = await umDisponivel();
        await processar(servicoReal({ modo: 'arquivo', arquivo: { diretorio } }));
        assert.equal((await agendamentos())[0].estado, 'ENVIADO');
        const txts = fs.readdirSync(diretorio).filter((n) => n.endsWith('.txt'));
        assert.equal(txts.length, 2);
        const [t] = await trabalhadores([d.trabalhador]);
        const material = await nomeDoMaterial(alvo.m);
        for (const arquivo of txts) {
          const conteudo = fs.readFileSync(path.join(diretorio, arquivo), 'utf8');
          assert.match(conteudo, /^Assunto: EPIs disponíveis para entrega — SafeWork Engenharia$/m);
          assert.ok(conteudo.includes(`${material}, tamanho 40: 1 unidade disponível para 1 pedido`));
          for (const pessoal of [t.nome, t.matricula, t.cpf]) assert.equal(conteudo.includes(pessoal), false);
        }
      } finally {
        fs.rmSync(diretorio, { recursive: true, force: true });
      }
    });

    async function comSmtpFalso({ recusar = false }, corpo) {
      const rcpt = [];
      const servidor = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.write('220 fake.test ESMTP\r\n');
        let buffer = '';
        let emDados = false;
        socket.on('data', (pedaco) => {
          buffer += pedaco.toString('latin1');
          for (let i = buffer.indexOf('\r\n'); i !== -1; i = buffer.indexOf('\r\n')) {
            const linha = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            if (emDados) {
              if (linha === '.') { emDados = false; socket.write('250 OK\r\n'); }
              continue;
            }
            const verbo = linha.slice(0, 4).toUpperCase();
            if (verbo === 'EHLO' || verbo === 'HELO') socket.write('250-fake.test\r\n250 8BITMIME\r\n');
            else if (verbo === 'RCPT') { rcpt.push(linha); socket.write(recusar ? '550 5.1.1 user unknown\r\n' : '250 OK\r\n'); }
            else if (verbo === 'DATA') { emDados = true; socket.write('354 go ahead\r\n'); }
            else if (verbo === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
            else socket.write('250 OK\r\n');
          }
        });
      });
      await new Promise((r) => { servidor.listen(0, '127.0.0.1', r); });
      const config = carregarConfigEmail({
        EMAIL_MODO: 'smtp', SMTP_HOST: '127.0.0.1', SMTP_PORTA: String(servidor.address().port), SMTP_SEGURANCA: 'nenhuma',
      });
      const servico = servicoReal(config);
      try {
        await corpo(servico, rcpt);
      } finally {
        await servico.fechar();
        await new Promise((r) => { servidor.close(r); });
      }
    }

    test('SMTP de teste em loopback: um envelope por destinatário; ENVIADO', async () => {
      await umDisponivel();
      await comSmtpFalso({}, async (servico, rcpt) => {
        await processar(servico);
        assert.deepEqual(rcpt.map((l) => l.replace(/^RCPT TO:/i, '')).sort(), ['<usuario-12f-1@example.invalid>', '<usuario-12f-4@example.invalid>']);
      });
      assert.equal((await agendamentos())[0].estado, 'ENVIADO');
    });

    test('SMTP que recusa os destinatários: AGUARDANDO_RETRY com o código técnico, sem texto livre', async () => {
      await umDisponivel();
      await comSmtpFalso({ recusar: true }, async (servico) => { await processar(servico); });
      const [a] = await agendamentos();
      assert.equal(a.estado, 'AGUARDANDO_RETRY');
      assert.match(a.codigo_ultimo_erro, /^[A-Z][A-Z0-9_]{0,39}$/);
    });
  });

  // ───────────────────────────────── destinatários ─────────────────────────────────
  describe('destinatários do aviso automático: ativo, empresa, e-mail, vínculo SST e REALIZAR_ENTREGA efetiva, resolvidos no envio', () => {
    const ids = async (empresaId = d.empresaA) => (await svc.resolverDestinatarios(pool, empresaId)).map((x) => x.id).sort((a, b) => a - b);

    test('recebe só quem cumpre tudo; o MASTER sem vínculo SST não recebe; outro perfil que cumpre tudo recebe', async () => {
      assert.deepEqual(await ids(), [u.sstEntrega, u.supervisor].sort((a, b) => a - b));
      assert.deepEqual(await ids(d.empresaB), [u.sstEntregaB]);
    });

    test('MASTER com vínculo SST e REALIZAR_ENTREGA cumpre os mesmos requisitos e recebe; sem a ação, não', async () => {
      await pool.query('INSERT INTO vinculo_sst (empresa_id, usuario_id, concedido_por) VALUES ($1, $2, $3)', [d.empresaA, d.master2, d.master]);
      try {
        assert.ok((await ids()).includes(d.master2));
        await pool.query("UPDATE permissoes_acao SET permitido = false WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = 'REALIZAR_ENTREGA'", [d.empresaA]);
        assert.equal((await ids()).includes(d.master2), false);
      } finally {
        await pool.query("UPDATE permissoes_acao SET permitido = true WHERE empresa_id = $1 AND perfil = 'MASTER' AND acao_codigo = 'REALIZAR_ENTREGA'", [d.empresaA]);
        await pool.query('DELETE FROM vinculo_sst WHERE empresa_id = $1 AND usuario_id = $2', [d.empresaA, d.master2]);
      }
    });

    test('perde a ação, perde o vínculo SST ou é inativado durante a janela: não recebe', async () => {
      await umDisponivel();
      const autorizacao = (await pool.query("SELECT * FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = 'REALIZAR_ENTREGA'", [u.supervisor])).rows[0];
      await pool.query('DELETE FROM usuario_autorizacoes WHERE id = $1', [autorizacao.id]);
      await pool.query('DELETE FROM vinculo_sst WHERE usuario_id = $1', [u.sstEntrega]);
      try {
        const email = servicoEmailFalso();
        await processar(email);
        assert.deepEqual(email.enviados, []);
        assert.equal((await agendamentos())[0].codigo_ultimo_erro, 'SEM_DESTINATARIO');
      } finally {
        await pool.query(
          'INSERT INTO usuario_autorizacoes (usuario_id, empresa_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)',
          [u.supervisor, d.empresaA, 'REALIZAR_ENTREGA', d.master],
        );
        await pool.query('INSERT INTO vinculo_sst (empresa_id, usuario_id, concedido_por) VALUES ($1, $2, $3)', [d.empresaA, u.sstEntrega, d.master]);
      }
    });

    test('usuário sem e-mail utilizável fica de fora', async () => {
      await pool.query("UPDATE usuarios SET email = 'sem-arroba' WHERE id = $1", [u.supervisor]);
      try {
        assert.equal((await ids()).includes(u.supervisor), false);
      } finally {
        await pool.query("UPDATE usuarios SET email = 'usuario-12f-4@example.invalid' WHERE id = $1", [u.supervisor]);
      }
    });
  });

  test('nada de disponibilidade gravada: nenhuma coluna de disponibilidade e nenhuma tabela de candidatos ou equivalente', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name ~ 'dispon'`,
    );
    assert.deepEqual(rows, []);
    const { rows: tabelas } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name ~ 'alerta|candidat|comunicad'");
    assert.deepEqual(tabelas.map((t) => t.table_name), ['alertas_estoque_agendamentos']);
  });
});
