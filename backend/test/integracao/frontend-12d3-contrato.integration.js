'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { montarAmbiente } = require('./helpers/ambiente-http-12d2');
const entregaSolicitacaoSvc = require('../../src/services/entrega-solicitacao.service');

const EpiHttp = require('../../../frontend/js/api-http');
const EpiItens = require('../../../frontend/js/itens-disponiveis');
const EpiDashboard = require('../../../frontend/js/dashboard');
const EpiOperacoes = require('../../../frontend/js/operacoes-estoque');
const EpiFicha = require('../../../frontend/js/epi-ficha');
const EpiMateriais = require('../../../frontend/js/materiais');
const EpiMinimos = require('../../../frontend/js/estoque-minimos');

/**
 * 12D-3 — contrato dos módulos REAIS do frontend com o servidor HTTP real e o
 * PostgreSQL real (schema temporário com todas as migrations): Itens
 * Disponíveis, Dashboard, histórico com ENTREGA, entrega direta com a posição
 * e a recusa por saldo livre, baixa e mínimo por tamanho. Cada módulo fala por
 * `fetch` real com as rotas, os schemas, as autorizações e os serviços de
 * produção; a única peça de teste é a sessão (`x-teste-usuario`). Os números
 * esperados vêm de cenários montados pelos serviços de verdade; nada é
 * simulado no servidor. Se o backend renomear um campo que a tela lê, este
 * arquivo reprova.
 */

const CHAVES_DO_ITEM = ['abaixoDoMinimo', 'bloqueado', 'caValidade', 'categoria', 'codigoInterno', 'comprometido', 'deficit', 'disponivel', 'estoqueMinimo', 'fisicoUtilizavel',
  'material', 'materialId', 'minimoOrigem', 'necessidade', 'saldo', 'saldoLivre', 'semCobertura', 'tamanho', 'tipo', 'unidade', 'validade'];
// As oito fontes de recurso da 12D; a 12G-6 acrescentou três contagens de solicitações, liberadas por ação.
const CHAVES_DAS_FONTES = ['caVencido', 'comprometido', 'estoqueAbaixoMinimo', 'funcionariosAtivos', 'itensDisponiveis', 'necessidadeReposicao', 'saldoLivre', 'semCobertura'];
const CHAVES_DO_DASHBOARD = [...CHAVES_DAS_FONTES, 'disponiveisParaEntrega', 'solicitacoesAguardandoEstoque', 'solicitacoesAguardandoSst'].sort();

describe('12D-3 — módulos reais do frontend contra servidor e PostgreSQL reais', () => {
  let amb;
  let servidor;
  let base;
  const q = (sql, params) => amb.pool.query(sql, params);

  before(async () => {
    amb = await montarAmbiente();
    servidor = http.createServer(amb.app);
    await new Promise((resolve) => { servidor.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${servidor.address().port}`;
  });

  after(async () => {
    EpiHttp.configurar({ fetch: null });
    if (servidor) await new Promise((resolve) => { servidor.close(resolve); });
    if (amb) await amb.encerrar();
  });

  /** Daqui em diante os módulos falam com o servidor como este usuário (ou sem sessão, com `null`). */
  const comoUsuario = (usuarioId) => {
    EpiHttp.configurar({
      baseUrl: `${base}/api`,
      fetch: (url, opcoes = {}) => fetch(url, { ...opcoes, headers: { ...(opcoes.headers || {}), ...(usuarioId === null ? {} : { 'x-teste-usuario': String(usuarioId) }) } }),
    });
  };
  const nomeDe = async (materialId) => (await q('SELECT nome FROM materiais WHERE id = $1', [materialId])).rows[0].nome;
  const itensDo = async (materialId, filtro = {}) => {
    const r = await EpiItens.acoes.listarTodos({ busca: await nomeDe(materialId), ...filtro });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.dados.itens.filter((i) => i.materialId === materialId);
  };
  const porTamanho = (itens) => Object.fromEntries(itens.map((i) => [i.tamanho ?? '-', i]));
  const numero = (cartao) => Number(cartao.valor.replace(/\./g, ''));
  const cartoes = async () => {
    const r = await EpiDashboard.acoes.consultar();
    assert.equal(r.ok, true, JSON.stringify(r));
    return { bruto: r.dados.indicadores, cards: EpiDashboard.render.cards(r.dados.indicadores) };
  };

  describe('Itens Disponíveis', () => {
    test('o item do servidor tem exatamente as 21 chaves que a tela lê; a posição e a situação saem do servidor, nunca recalculadas', async () => {
      comoUsuario(amb.d.master);
      const id = await amb.f.material();
      await q('UPDATE materiais SET estoque_minimo = 5 WHERE id = $1', [id]);
      await amb.f.estoque(id, 8);
      await amb.f.aprovada({ materialId: id, quantidade: 6 });
      await amb.f.aprovada({ materialId: id, quantidade: 4, tamanho: '42', funcionarioId: amb.d.trabalhador3 });
      const itens = porTamanho(await itensDo(id));
      assert.deepEqual(Object.keys(itens['40']).sort(), CHAVES_DO_ITEM);
      assert.deepEqual(['fisicoUtilizavel', 'comprometido', 'saldoLivre', 'semCobertura', 'estoqueMinimo', 'minimoOrigem', 'abaixoDoMinimo'].map((k) => itens['40'][k]), [8, 6, 2, 0, 5, 'PADRAO', true]);
      assert.equal(itens['40'].disponivel, itens['40'].fisicoUtilizavel, 'disponivel segue como apelido do físico utilizável');
      assert.deepEqual(['fisicoUtilizavel', 'comprometido', 'saldoLivre', 'semCobertura'].map((k) => itens['42'][k]), [0, 0, 0, 4], 'demanda sem lote: tudo sem cobertura');
      const html = EpiItens.render.linhas([itens['40'], itens['42']]);
      const linhas = html.split('</tr>').filter((l) => l.includes('<td'));
      assert.match(linhas[0], /Com saldo comprometido/);
      assert.match(linhas[0], /Abaixo do mínimo/);
      assert.match(linhas[1], /Sem cobertura/);
    });

    test('filtros novos (busca, situação e somente com necessidade) são os nomes que o servidor aceita; cada situação devolve o par certo', async () => {
      comoUsuario(amb.d.master);
      const id = await amb.f.material();
      await amb.f.estoque(id, 8);
      await amb.f.aprovada({ materialId: id, quantidade: 3 });
      await amb.f.aprovada({ materialId: id, quantidade: 2, tamanho: '43', funcionarioId: amb.d.trabalhador3 });
      const quais = async (filtro) => (await itensDo(id, filtro)).map((i) => i.tamanho).sort();
      assert.deepEqual(await quais({}), ['40', '43']);
      assert.deepEqual(await quais({ situacao: 'COM_COMPROMETIDO' }), ['40']);
      assert.deepEqual(await quais({ situacao: 'SEM_COBERTURA' }), ['43']);
      assert.deepEqual(await quais({ situacao: 'SEM_ESTOQUE' }), ['43']);
      assert.deepEqual(await quais({ somenteComNecessidade: true }), ['43'], 'o 40 está coberto e sem déficit (mínimo 0): sem necessidade');
      assert.deepEqual(await quais({ situacao: 'QUALQUER' }), ['40', '43'], 'situação fora da lista nem é enviada');
      assert.equal(await EpiItens.acoes.listar({ situacao: 'SEM_COBERTURA' }).then((r) => r.ok), true);
    });

    test('sem sessão: 401 e a tela manda ao Portal; isolamento: o MASTER de outra empresa não vê o material', async () => {
      const id = await amb.f.material();
      await amb.f.estoque(id, 3);
      const nome = await nomeDe(id);
      comoUsuario(null);
      const r = await EpiItens.acoes.listar({});
      assert.deepEqual([r.ok, r.status, EpiItens.mensagens.exigeNovoLogin(r)], [false, 401, true]);
      comoUsuario(amb.d.masterB);
      const b = await EpiItens.acoes.listar({ busca: nome });
      assert.deepEqual([b.ok, b.dados.total], [true, 0]);
    });
  });

  describe('Dashboard', () => {
    test('os onze indicadores têm as chaves que a tela lê; os valores do cenário aparecem como o servidor mediu (deltas sobre o estado anterior)', async () => {
      comoUsuario(amb.d.master);
      const antes = await cartoes();
      assert.deepEqual(Object.keys(antes.bruto).sort(), CHAVES_DO_DASHBOARD);
      for (const k of CHAVES_DAS_FONTES) assert.equal(antes.bruto[k].permitido, true, k);

      const id = await amb.f.material();
      await q('UPDATE materiais SET estoque_minimo = 5 WHERE id = $1', [id]);
      await amb.f.estoque(id, 8);
      await amb.f.aprovada({ materialId: id, quantidade: 6 });
      await amb.f.aprovada({ materialId: id, quantidade: 4, tamanho: '42', funcionarioId: amb.d.trabalhador3 });
      const depois = await cartoes();
      const delta = (k) => numero(depois.cards[k]) - numero(antes.cards[k]);
      assert.equal(delta('disponiveis'), 8, 'físico utilizável');
      assert.equal(delta('comprometido'), 6);
      assert.equal(delta('saldoLivre'), 2);
      assert.equal(delta('semCobertura'), 4, 'o card "Pendências sem estoque" mostra a demanda sem cobertura');
      assert.equal(delta('abaixoMinimo'), 2, 'os dois tamanhos (40 e 42) ficam abaixo do mínimo pelo saldo livre');
      const itens = await itensDo(id);
      assert.equal(delta('necessidade'), itens.reduce((s, i) => s + i.necessidade, 0), 'a necessidade do dashboard é a soma da posição por par');
      assert.ok(delta('necessidade') >= delta('semCobertura'));
    });

    test('permissão por fonte: sem as fontes, tudo é "—" e "sem permissão" (nunca um zero); com a de estoque, só os cartões de estoque têm número', async () => {
      const semFonte = await amb.usuarioCom(amb.d.empresaA, { dashboard: ['visualizar'] });
      comoUsuario(semFonte);
      const nada = await cartoes();
      for (const k of CHAVES_DO_DASHBOARD) assert.deepEqual(nada.bruto[k], { permitido: false }, k);
      for (const c of Object.values(nada.cards)) assert.deepEqual(c, { valor: '—', meta: 'sem permissão' });

      const soEstoque = await amb.usuarioCom(amb.d.empresaA, { dashboard: ['visualizar'], availableItems: ['visualizar'] });
      comoUsuario(soEstoque);
      const parcial = await cartoes();
      for (const k of ['disponiveis', 'saldoLivre', 'comprometido', 'semCobertura', 'necessidade', 'abaixoMinimo']) assert.notEqual(parcial.cards[k].valor, '—', k);
      for (const k of ['caVencido', 'funcionarios']) assert.deepEqual(parcial.cards[k], { valor: '—', meta: 'sem permissão' }, k);
    });

    test('sem sessão: 401 com a orientação de novo login', async () => {
      comoUsuario(null);
      const r = await EpiDashboard.acoes.consultar();
      assert.deepEqual([r.ok, r.status, EpiDashboard.mensagens.exigeNovoLogin(r)], [false, 401, true]);
    });
  });

  describe('Histórico de operações com ENTREGA', () => {
    const f = {};
    let soOperacoes;
    let operacoesEFicha;

    before(async () => {
      const { d } = amb;
      soOperacoes = await amb.usuarioCom(d.empresaA, { operations: ['visualizar'] });
      operacoesEFicha = await amb.usuarioCom(d.empresaA, { operations: ['visualizar'], epiFicha: ['visualizar'] });
      f.id = await amb.f.material();
      f.lote = await amb.f.estoque(f.id, 10);
      await amb.f.direta([[f.id, f.lote, 1]]);
      const alvo = await amb.f.aprovada({ materialId: f.id, quantidade: 2 });
      await entregaSolicitacaoSvc.registrarEntregaPorSolicitacao(amb.pool, {
        empresaId: d.empresaA, atorId: d.master, solicitacaoId: alvo.id, itens: [{ solicitacaoItemId: alvo.item, loteId: f.lote, quantidade: 2 }], confirmacao: amb.ACEITE, chaveIdempotencia: amb.chaveNova(),
      });
      f.nome = await nomeDe(f.id);
    });

    const entregas = async (filtro) => {
      const r = await EpiOperacoes.acoes.listar({ busca: f.nome, limite: 50, ...filtro });
      assert.equal(r.ok, true, JSON.stringify(r));
      return r.dados.operacoes.filter((o) => o.materialId === f.id);
    };

    test('tipo ENTREGA e origem DIRETA ou SOLICITACAO são os valores que o servidor aceita, e cada filtro devolve só as linhas certas', async () => {
      comoUsuario(amb.d.master);
      const todas = await entregas({ tipo: 'ENTREGA' });
      assert.deepEqual(todas.map((o) => [o.tipo, o.entrega.origem, o.quantidade]).sort(), [['ENTREGA', 'DIRETA', 1], ['ENTREGA', 'SOLICITACAO', 2]]);
      assert.deepEqual((await entregas({ tipo: 'ENTREGA', origem: 'DIRETA' })).map((o) => o.entrega.origem), ['DIRETA']);
      assert.deepEqual((await entregas({ tipo: 'ENTREGA', origem: 'SOLICITACAO' })).map((o) => o.entrega.origem), ['SOLICITACAO']);
      assert.deepEqual((await entregas({ origem: 'SOLICITACAO' })).map((o) => o.tipo), ['ENTREGA'], 'origem sem tipo: só existe em ENTREGA');
      const baixas = await entregas({ tipo: 'BAIXA', origem: 'DIRETA' });
      assert.ok(baixas.every((o) => o.tipo === 'BAIXA'), 'com outro tipo a origem nem é enviada');
      const entrada = (await entregas({ tipo: 'ENTRADA' }))[0];
      assert.equal(entrada.entrega, null, 'fora da ENTREGA o bloco entrega é nulo');
    });

    test('com epiFicha.visualizar a linha traz ficha, trabalhador (nome e matrícula) e solicitação e a tela os mostra; o CPF nunca chega nem aparece', async () => {
      comoUsuario(operacoesEFicha);
      const porSolicitacao = (await entregas({ tipo: 'ENTREGA', origem: 'SOLICITACAO' }))[0];
      assert.deepEqual(Object.keys(porSolicitacao.entrega).sort(), ['fichaId', 'fichaNumero', 'origem', 'solicitacao', 'trabalhador']);
      assert.deepEqual(Object.keys(porSolicitacao.entrega.trabalhador).sort(), ['id', 'matricula', 'nome']);
      assert.deepEqual(Object.keys(porSolicitacao.entrega.solicitacao).sort(), ['id', 'numero']);
      const direta = (await entregas({ tipo: 'ENTREGA', origem: 'DIRETA' }))[0];
      assert.equal(direta.entrega.solicitacao, null);
      const html = EpiOperacoes.render.linhas([porSolicitacao, direta]);
      const cpfs = (await q('SELECT cpf FROM funcionarios WHERE empresa_id = $1', [amb.d.empresaA])).rows.map((r) => r.cpf).filter(Boolean);
      for (const texto of [html, JSON.stringify(porSolicitacao), JSON.stringify(direta)]) {
        for (const cpf of cpfs) assert.equal(texto.includes(cpf), false, 'CPF fora da tela e da resposta');
      }
      assert.match(html, new RegExp(`Ficha ${porSolicitacao.entrega.fichaNumero}`));
      assert.match(html, new RegExp(`Solicitação ${porSolicitacao.entrega.solicitacao.numero}`));
      assert.ok(html.includes(`${porSolicitacao.entrega.trabalhador.nome} · ${porSolicitacao.entrega.trabalhador.matricula}`));
      assert.match(html, /Por solicitação/);
      assert.match(html, /Direta/);
    });

    test('sem epiFicha.visualizar o servidor manda só a origem e a tela não mostra ficha, trabalhador, solicitação nem aviso de permissão', async () => {
      comoUsuario(soOperacoes);
      const linhas = await entregas({ tipo: 'ENTREGA' });
      assert.equal(linhas.length, 2);
      for (const o of linhas) assert.deepEqual(Object.keys(o.entrega), ['origem']);
      const html = EpiOperacoes.render.linhas(linhas);
      assert.equal(/Ficha|Solicitação \d|permiss|restrit/i.test(html), false);
      const trabalhadores = (await q('SELECT nome FROM funcionarios WHERE empresa_id = $1', [amb.d.empresaA])).rows.map((r) => r.nome);
      for (const nome of trabalhadores) assert.equal(html.includes(nome), false);
    });

    test('sem sessão: 401', async () => {
      comoUsuario(null);
      const r = await EpiOperacoes.acoes.listar({ tipo: 'ENTREGA' });
      assert.deepEqual([r.ok, r.status], [false, 401]);
    });
  });

  describe('Entrega direta: posição por tamanho e recusa por saldo livre', () => {
    // O trabalhador da entrega é o da ficha (entregas_epi guarda a ficha).
    const entregasDoTrabalhador = async (funcionarioId) => (await q(
      `SELECT count(*)::int AS n FROM entregas_epi e JOIN fichas_epi f ON f.empresa_id = e.empresa_id AND f.id = e.ficha_id
        WHERE e.empresa_id = $1 AND f.funcionario_id = $2`,
      [amb.d.empresaA, funcionarioId],
    )).rows[0].n;

    const preparar = async () => {
      comoUsuario(amb.d.master);
      const id = await amb.f.material();
      const lote = await amb.f.estoque(id, 5);
      await amb.f.aprovada({ materialId: id, quantidade: 4 });
      const nome = await nomeDe(id);
      const fluxo = EpiFicha.fluxo.criar();
      const entrou = await fluxo.selecionarTrabalhador(amb.d.trabalhador2);
      assert.equal(entrou.ok, true, JSON.stringify(entrou));
      const lista = await fluxo.carregarMateriais({ busca: nome, pagina: 1, limite: 20 });
      assert.equal(lista.ok, true, JSON.stringify(lista));
      const material = lista.materiais.find((m) => m.id === id);
      assert.ok(material, 'o material aparece na lista real do contexto');
      return { id, lote, nome, fluxo, material };
    };

    test('o fluxo guarda a posição que o servidor mandou e ela fecha com a posição calculada pelo backend (físico 5, comprometido 4, livre 1)', async () => {
      const { id, fluxo, material } = await preparar();
      const r = await fluxo.selecionarMaterial(material);
      assert.equal(r.ok, true, JSON.stringify(r));
      const posicoes = fluxo.estado().posicoes[String(id)];
      assert.deepEqual(posicoes.map((p) => [p.tamanho, p.fisicoUtilizavel, p.comprometido, p.saldoLivre, p.semCobertura]), [['40', 5, 4, 1, 0]]);
      assert.equal(EpiFicha.posicaoDoTamanho(posicoes, '40').saldoLivre, 1);
      const html = EpiFicha.render.linhasPosicoes(posicoes);
      assert.match(html, />5<\/td>[\s\S]*>4<\/td>[\s\S]*>1</);
    });

    test('recusa real: a quantidade cabe no lote mas não no saldo livre → 409 SALDO_LIVRE_INSUFICIENTE com mensagem de domínio; a posição é relida; só depois de relida a nova tentativa sai e é registrada', async () => {
      const { id, lote, fluxo, material } = await preparar();
      const entregasAntes = await entregasDoTrabalhador(amb.d.trabalhador2); // o schema é compartilhado com os cenários anteriores
      await fluxo.selecionarMaterial(material);
      const loteDaTela = fluxo.estado().lotes.find((l) => l.loteId === lote);
      assert.ok(loteDaTela);
      // Outra demanda aprovada depois da leitura: o livre real cai a 0 e a posição da tela fica velha.
      await amb.f.aprovada({ materialId: id, quantidade: 1, funcionarioId: amb.d.trabalhador3 });
      assert.equal(fluxo.estado().posicoes[String(id)][0].saldoLivre, 1, 'a posição da tela ainda é a antiga');
      const adicionado = fluxo.adicionarItem({ material, lote: loteDaTela, quantidade: 1, motivo: 'ADMISSAO', justificativaForaGhe: material.previstoNoGhe ? undefined : 'Exceção de teste' });
      assert.equal(adicionado.ok, true, JSON.stringify(adicionado));
      assert.equal(fluxo.definirConfirmacao({ modo: 'ACEITE_PRESENCIAL' }).ok, true);

      const recusa = await fluxo.confirmar();
      assert.deepEqual([recusa.ok, recusa.status, recusa.codigo, recusa.recarregarPosicao, recusa.posicaoRecarregada], [false, 409, 'SALDO_LIVRE_INSUFICIENTE', true, true]);
      assert.ok(recusa.mensagem.startsWith('O saldo físico existe, mas parte dele está comprometida com solicitações já aprovadas'));
      assert.equal(/Saldo livre insuficiente para esta operação/.test(recusa.mensagem), false, 'o texto público do servidor não é repetido');
      assert.deepEqual([fluxo.estado().posicoes[String(id)][0].comprometido, fluxo.estado().posicoes[String(id)][0].saldoLivre], [5, 0], 'a posição lida depois da recusa é a real');
      assert.equal(fluxo.estado().posicaoDesatualizada, false);
      assert.equal(await entregasDoTrabalhador(amb.d.trabalhador2), entregasAntes, 'nada foi entregue na recusa');

      // O estoque cresce: a posição da tela fica velha de novo, e "Recarregar posição" a atualiza antes de tentar.
      await amb.f.estoque(id, 3);
      const recarga = await fluxo.recarregarPosicoes();
      assert.equal(recarga.ok, true, JSON.stringify(recarga));
      assert.equal(fluxo.estado().posicoes[String(id)][0].saldoLivre, 3);
      const sucesso = await fluxo.confirmar();
      assert.deepEqual([sucesso.ok, sucesso.repetida], [true, false], JSON.stringify(sucesso));
      assert.equal(await entregasDoTrabalhador(amb.d.trabalhador2), entregasAntes + 1);
    });

    test('posição da resposta e contexto do servidor têm as oito chaves esperadas por tamanho (nenhuma composição de solicitações)', async () => {
      const { id, fluxo, material } = await preparar();
      await fluxo.selecionarMaterial(material);
      const p = fluxo.estado().posicoes[String(id)][0];
      assert.deepEqual(Object.keys(p).sort(), ['abaixoDoMinimo', 'comprometido', 'estoqueMinimo', 'fisicoUtilizavel', 'minimoOrigem', 'saldoLivre', 'semCobertura', 'tamanho']);
    });
  });

  describe('Baixa: SALDO_LIVRE_INSUFICIENTE só nas discricionárias', () => {
    const cenario = async () => {
      comoUsuario(amb.d.master);
      const id = await amb.f.material();
      const lote = await amb.f.estoque(id, 5);
      await amb.f.aprovada({ materialId: id, quantidade: 4 });
      return { id, lote };
    };

    test('"Outro" e devolução ao fornecedor que reduziriam o comprometido: 409 do servidor, mensagem de domínio e recusa confirmada (não "não confirmada")', async () => {
      const { lote } = await cenario();
      for (const [motivo, justificativa] of [['OUTRO', 'Doação para treinamento'], ['DEVOLUCAO_FORNECEDOR', undefined]]) {
        const corpo = justificativa ? { quantidade: 3, motivo, justificativa } : { quantidade: 3, motivo };
        const r = await EpiMateriais.fluxo.registrarBaixa(lote, corpo, EpiMateriais.idempotencia.criar());
        assert.deepEqual([r.ok, r.confirmado, r.resposta.status, r.resposta.codigo], [false, true, 409, 'SALDO_LIVRE_INSUFICIENTE'], motivo);
        const texto = EpiMateriais.mensagens.resultadoBaixa(r, corpo, { tamanho: '40', caNumero: '12345' });
        assert.match(texto, /^Baixa não realizada: o saldo físico existe, mas esta baixa reduziria o estoque comprometido/);
        assert.equal(/não confirmada/.test(texto), false);
      }
      assert.equal((await q('SELECT saldo FROM estoque_lotes WHERE id = $1', [lote])).rows[0].saldo, 5, 'nada foi baixado');
    });

    test('evento físico (avaria) nunca é recusado por reserva: a baixa é registrada e o saldo do lote cai', async () => {
      const { lote } = await cenario();
      const r = await EpiMateriais.fluxo.registrarBaixa(lote, { quantidade: 3, motivo: 'AVARIA' }, EpiMateriais.idempotencia.criar());
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal((await q('SELECT saldo FROM estoque_lotes WHERE id = $1', [lote])).rows[0].saldo, 2);
    });

    test('discricionária que cabe no saldo livre é aceita (devolução de 1 com livre 1)', async () => {
      const { lote } = await cenario();
      const r = await EpiMateriais.fluxo.registrarBaixa(lote, { quantidade: 1, motivo: 'DEVOLUCAO_FORNECEDOR' }, EpiMateriais.idempotencia.criar());
      assert.equal(r.ok, true, JSON.stringify(r));
    });
  });

  describe('Mínimo padrão e mínimo por tamanho', () => {
    const material = async (opcoes = {}) => {
      const id = await amb.f.material(opcoes);
      await q('UPDATE materiais SET estoque_minimo = 5 WHERE id = $1', [id]);
      return id;
    };
    const painelDe = async (id) => {
      const estoque = await EpiMateriais.fluxo.carregarEstoque(id);
      assert.equal(estoque.ok, true, JSON.stringify(estoque));
      const r = await EpiMinimos.acoes.consultar(id);
      assert.equal(r.ok, true, JSON.stringify(r));
      return EpiMinimos.painel.montar(r.dados, estoque.lotes.map((l) => l.tamanho));
    };
    const linhas = (painel) => painel.linhas.map((l) => [l.tamanho, l.proprio, l.efetivo, l.origem]);

    test('GET: o estado do servidor tem as chaves que o painel lê; os tamanhos com lote herdam o padrão e nada é criado para os outros', async () => {
      comoUsuario(amb.d.master);
      const id = await material();
      await amb.f.estoque(id, 4, { tamanho: '40' });
      await amb.f.estoque(id, 4, { tamanho: '41' });
      const r = await EpiMinimos.acoes.consultar(id);
      assert.deepEqual(Object.keys(r.dados).sort(), ['estoqueMinimoPadrao', 'exigeTamanho', 'materialId', 'overrides', 'status']);
      assert.deepEqual(linhas(await painelDe(id)), [['40', null, 5, 'PADRAO'], ['41', null, 5, 'PADRAO']]);
      assert.equal((await q('SELECT count(*)::int AS n FROM estoque_minimos WHERE material_id = $1', [id])).rows[0].n, 0);
    });

    test('definir, repetir, zero próprio, alterar e remover: os códigos e o estado de volta são os que a tela espera, e Itens Disponíveis acompanha (Próprio / Padrão)', async () => {
      comoUsuario(amb.d.master);
      const id = await material();
      await amb.f.estoque(id, 4, { tamanho: '40' });
      await amb.f.estoque(id, 4, { tamanho: '41' });

      const criado = await EpiMinimos.acoes.definir(id, '41', 0);
      assert.deepEqual([criado.status, criado.dados.criado, criado.dados.alterado], [201, true, true]);
      assert.equal(EpiMinimos.mensagens.sucessoDefinir(criado.dados, '41', 0), 'Mínimo do tamanho 41 definido: 0.');
      assert.deepEqual(linhas(EpiMinimos.painel.montar(criado.dados, ['40', '41'])), [['40', null, 5, 'PADRAO'], ['41', 0, 0, 'PROPRIO']]);
      const itens = porTamanho(await itensDo(id));
      assert.deepEqual([itens['41'].estoqueMinimo, itens['41'].minimoOrigem, itens['41'].abaixoDoMinimo], [0, 'PROPRIO', false], 'o zero próprio vence o padrão');
      assert.deepEqual([itens['40'].estoqueMinimo, itens['40'].minimoOrigem, itens['40'].abaixoDoMinimo], [5, 'PADRAO', true]);

      const repetido = await EpiMinimos.acoes.definir(id, '41', 0);
      assert.deepEqual([repetido.status, repetido.dados.alterado], [200, false]);
      assert.equal(EpiMinimos.mensagens.sucessoDefinir(repetido.dados, '41', 0), 'O tamanho 41 já tinha o mínimo 0; nada foi alterado.');

      const alterado = await EpiMinimos.acoes.definir(id, '41', 3);
      assert.deepEqual([alterado.status, alterado.dados.criado, alterado.dados.alterado], [200, false, true]);
      assert.deepEqual([porTamanho(await itensDo(id))['41'].estoqueMinimo, porTamanho(await itensDo(id))['41'].minimoOrigem], [3, 'PROPRIO']);

      const removido = await EpiMinimos.acoes.remover(id, '41');
      assert.deepEqual([removido.status, removido.dados.alterado], [200, true]);
      assert.equal(EpiMinimos.mensagens.sucessoRemover(removido.dados, '41'), 'Mínimo próprio do tamanho 41 removido: o tamanho volta a usar o mínimo padrão (5).');
      assert.deepEqual(linhas(EpiMinimos.painel.montar(removido.dados, ['40', '41'])), [['40', null, 5, 'PADRAO'], ['41', null, 5, 'PADRAO']]);
      assert.deepEqual([porTamanho(await itensDo(id))['41'].estoqueMinimo, porTamanho(await itensDo(id))['41'].minimoOrigem], [5, 'PADRAO'], 'remover volta a herdar o padrão (nunca grava zero)');
      const denovo = await EpiMinimos.acoes.remover(id, '41');
      assert.deepEqual([denovo.status, denovo.dados.alterado], [200, false]);
    });

    test('tamanho com caractere especial vai codificado na URL e volta íntegro no estado', async () => {
      comoUsuario(amb.d.master);
      const id = await material();
      const r = await EpiMinimos.acoes.definir(id, 'G/XG 2', 7);
      assert.equal(r.status, 201, JSON.stringify(r));
      assert.deepEqual(r.dados.overrides, [{ tamanho: 'G/XG 2', minimo: 7 }]);
      assert.equal((await EpiMinimos.acoes.remover(id, 'G/XG 2')).dados.alterado, true);
    });

    test('os 409 do servidor chegam como orientação própria: material sem tamanho e material não classificado', async () => {
      comoUsuario(amb.d.master);
      const unico = await material({ exigeTamanho: false });
      const naoClassificado = await material({ exigeTamanho: null });
      const r1 = await EpiMinimos.acoes.definir(unico, '40', 2);
      assert.deepEqual([r1.status, r1.codigo], [409, 'MATERIAL_NAO_EXIGE_TAMANHO']);
      assert.match(EpiMinimos.mensagens.erroGravacao(r1), /não usa tamanho.*mínimo padrão do cadastro/i);
      const r2 = await EpiMinimos.acoes.definir(naoClassificado, '40', 2);
      assert.deepEqual([r2.status, r2.codigo], [409, 'MATERIAL_TAMANHO_NAO_CLASSIFICADO']);
      assert.match(EpiMinimos.mensagens.erroGravacao(r2), /Defina no cadastro/);
      assert.equal(EpiMinimos.painel.montar((await EpiMinimos.acoes.consultar(unico)).dados, ['40']).modo, 'UNICO');
      assert.equal(EpiMinimos.painel.montar((await EpiMinimos.acoes.consultar(naoClassificado)).dados, ['40']).modo, 'NAO_CLASSIFICADO');
      const inexistente = await EpiMinimos.acoes.consultar(999999);
      assert.deepEqual([inexistente.status, inexistente.codigo], [404, 'MATERIAL_NAO_ENCONTRADO']);
      assert.match(EpiMinimos.mensagens.erroConsulta(inexistente), /não encontrado/i);
    });

    test('permissões: quem só visualiza consulta mas não grava (403); outra empresa não enxerga o material (404); sem sessão, 401', async () => {
      const id = await material();
      const soVer = await amb.usuarioCom(amb.d.empresaA, { materials: ['visualizar'] });
      comoUsuario(soVer);
      assert.equal((await EpiMinimos.acoes.consultar(id)).ok, true);
      const negada = await EpiMinimos.acoes.definir(id, '40', 1);
      assert.deepEqual([negada.status, EpiMinimos.mensagens.erroGravacao(negada)], [403, 'Seu perfil não pode editar materiais nesta empresa.']);
      comoUsuario(amb.d.masterB);
      assert.equal((await EpiMinimos.acoes.consultar(id)).status, 404);
      assert.equal((await EpiMinimos.acoes.definir(id, '40', 1)).status, 404);
      comoUsuario(null);
      const sem = await EpiMinimos.acoes.consultar(id);
      assert.deepEqual([sem.status, EpiMinimos.mensagens.exigeNovoLogin(sem)], [401, true]);
      assert.equal((await q('SELECT count(*)::int AS n FROM estoque_minimos WHERE material_id = $1', [id])).rows[0].n, 0, 'nada foi gravado');
    });

    test('edição do cadastro: trocar o controle de tamanho com mínimos por tamanho configurados → 409 do servidor e mensagem com a orientação de removê-los', async () => {
      comoUsuario(amb.d.master);
      const id = await material();
      await EpiMinimos.acoes.definir(id, '40', 2);
      const r = await EpiMateriais.acoes.alterar(id, { exigeTamanho: false });
      assert.deepEqual([r.ok, r.status, r.codigo], [false, 409, 'MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS']);
      assert.match(EpiMateriais.mensagens.erroEdicao(r), /mínimos por tamanho.*Remova/);
      await EpiMinimos.acoes.remover(id, '40');
      assert.equal((await EpiMateriais.acoes.alterar(id, { exigeTamanho: false })).ok, true, 'sem os mínimos, a troca é aceita');
    });

    test('mínimo padrão: o campo estoqueMinimo continua o da API (0 e inteiro positivo aceitos; negativo recusado pelo servidor e antes, na tela)', async () => {
      comoUsuario(amb.d.master);
      const id = await material();
      assert.equal((await EpiMateriais.acoes.alterar(id, { estoqueMinimo: 0 })).ok, true);
      assert.equal((await EpiMateriais.acoes.alterar(id, { estoqueMinimo: 9 })).dados.material.estoqueMinimo, 9);
      assert.equal((await EpiMateriais.acoes.alterar(id, { estoqueMinimo: -1 })).status, 400);
      const { formulario } = EpiMateriais;
      assert.match(formulario.montarEdicao({ ...formulario.camposDoMaterial({ id, nome: 'x', estoqueMinimo: 9, exigeTamanho: true, prazoUsoDias: 180, categoria: 'EPI', tipo: 'Luva' }).campos, estoqueMinimo: '-1' }, { id, nome: 'x', estoqueMinimo: 9, exigeTamanho: true, prazoUsoDias: 180, categoria: 'EPI', tipo: 'Luva' }).erros[0].mensagem, /^Mínimo padrão deve ser/);
    });
  });
});
