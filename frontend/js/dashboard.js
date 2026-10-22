(function (global) {
  'use strict';

  /**
   * EpiDashboard — indicadores do dashboard (Bloco 9, Etapa C, Parte C6),
   * sobre GET /api/dashboard/indicadores (recurso `dashboard`, visualizar).
   *
   * Oito indicadores têm dado real: itens disponíveis (físico utilizável),
   * saldo livre, comprometido, sem cobertura, necessidade de reposição,
   * estoque abaixo do mínimo, CA vencido (com a vencer) e funcionários
   * ativos. Os seis de estoque saem da mesma posição por par
   * (material, tamanho) e são somados pelo SERVIDOR; o frontend só os
   * mostra, nunca recalcula livre, comprometido nem necessidade. A 12G-6
   * acrescentou três contagens de solicitações (aguardando SST, aguardando
   * estoque e disponíveis para entrega, as duas últimas exclusivas), cada uma
   * liberada pela ação que a trabalha. Cada um só traz número se o servidor
   * o liberou; sem permissão: "—" e "sem permissão", nunca um zero
   * mascarado. Os demais cards e painéis da página ficam em "—" / "em
   * integração". Nenhum valor fixo, nada guardado no navegador.
   *
   * 12I (decisão de 21/10/2026): cada cartão com destino confirmado é um link
   * para a tela correspondente, já filtrada (`destinos`). Não há ampliação,
   * prévia nem temporizador: o movimento do hover é só CSS.
   */

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/dashboard.js');
    return global.EpiHttp;
  }

  var acoes = {
    consultar: function () { return http().requisitar('GET', '/dashboard/indicadores'); },
  };

  function inteiroNaoNegativo(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0; }
  function milhar(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }

  var TRACO = '—';
  var SEM_PERMISSAO = { valor: TRACO, meta: 'sem permissão' };
  var INDISPONIVEL = { valor: TRACO, meta: 'indisponível' };
  var EM_INTEGRACAO = { valor: TRACO, meta: 'em integração' };

  /** Um indicador simples: número só com permitido === true e valor inteiro >= 0. */
  function simples(ind, meta) {
    if (ind && ind.permitido === false) return SEM_PERMISSAO;
    if (ind && ind.permitido === true && inteiroNaoNegativo(ind.valor)) return { valor: milhar(ind.valor), meta: meta };
    return INDISPONIVEL;
  }

  var render = {
    EM_INTEGRACAO: EM_INTEGRACAO,
    /**
     * Um cartão com destino (Tasks 01 a 06) só some quando o servidor NEGA a fonte (permitido === false). Zero, erro de carga, indicador
     * ausente ou malformado mantêm o cartão: falha de leitura nunca é lida como falta de permissão.
     */
    visivelCartao: function (ind) { return !(ind && ind.permitido === false); },
    CARREGANDO: { valor: TRACO, meta: 'Carregando…' },
    cards: function (indicadores) {
      var i = indicadores || {};
      var ca = i.caVencido;
      var caVencido = simples(ca, '');
      if (caVencido.valor !== TRACO) {
        caVencido = inteiroNaoNegativo(ca.aVencer) && inteiroNaoNegativo(ca.diasAlerta)
          ? { valor: caVencido.valor, meta: ca.aVencer + ' a vencer em ' + ca.diasAlerta + ' dias' }
          : INDISPONIVEL;
      }
      return {
        disponiveis: simples(i.itensDisponiveis, 'Físico utilizável em estoque'),
        saldoLivre: simples(i.saldoLivre, 'Físico utilizável menos o comprometido'),
        comprometido: simples(i.comprometido, 'Reservado a solicitações aprovadas'),
        caVencido: caVencido,
        semCobertura: simples(i.semCobertura, 'Aprovado sem estoque para cobrir'),
        necessidade: simples(i.necessidadeReposicao, 'Sem cobertura mais déficit do mínimo'),
        abaixoMinimo: simples(i.estoqueAbaixoMinimo, 'Itens (material × tamanho) abaixo do mínimo pelo saldo livre'),
        funcionarios: simples(i.funcionariosAtivos, 'Funcionários ativos cadastrados'),
        aguardandoSst: simples(i.solicitacoesAguardandoSst, 'Pedidos aguardando a decisão da Segurança do Trabalho'),
        aguardandoEstoque: simples(i.solicitacoesAguardandoEstoque, 'Pedidos aprovados sem nenhum item coberto pelo estoque'),
        disponiveisEntrega: simples(i.disponiveisParaEntrega, 'Pedidos com algum item já coberto pelo estoque'),
        episEntregues: simples(i.episEntregues, 'Unidades entregues no mês'),
        proximoVencimento: simples(i.proximoVencimentoUso, 'Itens com prazo de uso vencendo em até 30 dias'),
      };
    },
    escaparHtml: function (s) {
      return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
  };

  var mensagens = {
    erro: function (r) {
      if (!r || !r.status) return 'Falha de rede: não foi possível carregar os indicadores. Verifique a conexão e tente novamente.';
      if (r.status === 401) return 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
      if (r.status === 403) return 'Seu perfil não pode consultar o dashboard nesta empresa.';
      return 'Não foi possível carregar os indicadores. Tente novamente.';
    },
    exigeNovoLogin: function (r) { return !!r && r.status === 401; },
  };

  /** Só um indicador liberado e bem formado (valor inteiro, inclusive zero) leva à tela de destino; malformado é "indisponível", sem link. */
  function destinoDoIndicador(ind, destino) {
    return ind && ind.permitido === true && inteiroNaoNegativo(ind.valor) ? destino : null;
  }

  // Cada cartão é um link para a tela correspondente, já filtrada. A fonte que libera o número é a mesma autoridade que abre a tela de
  // destino (availableItems; employeeHistory; REALIZAR_ENTREGA ou ENCERRAR_SOLICITACAO; APROVAR_SOLICITACAO); o servidor revalida na tela.
  var DESTINOS = {
    abaixoMinimo: 'available-items.html?situacao=ABAIXO_MINIMO',
    necessidade: 'available-items.html?somenteComNecessidade=true',
    semCobertura: 'available-items.html?situacao=SEM_COBERTURA',
    funcionarios: 'funcionarios.html?situacao=ATIVO',
    disponiveisEntrega: 'stock-requests.html?cobertura=COBERTURA_COMPLETA', // 12I: só os pedidos completamente disponíveis
    aguardandoEstoque: 'stock-requests.html?cobertura=SEM_COBERTURA',
    itensDisponiveis: 'available-items.html',
    saldoLivre: 'available-items.html',
    comprometido: 'available-items.html?situacao=COM_COMPROMETIDO',
    aguardandoSst: 'supervisor-approval.html',
    proximoVencimentoUso: 'reports.html#reportUpcoming',
  };
  var destinos = {};
  Object.keys(DESTINOS).forEach(function (nome) {
    destinos[nome] = function (ind) { return destinoDoIndicador(ind, DESTINOS[nome]); };
  });

  /**
   * EPIs entregues: abre a aba "EPIs entregues" dos Relatórios já com o mês corrente. O período (de/ate) vem do SERVIDOR junto do número, que
   * soma as unidades desse mesmo período; sem um par de datas de calendário válido e em ordem, não há link (nada é inventado no navegador).
   */
  function dataDeCalendario(v) {
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
  }
  destinos.episEntregues = function (ind) {
    if (!destinoDoIndicador(ind, true)) return null;
    try {
      if (!dataDeCalendario(ind.de) || !dataDeCalendario(ind.ate) || ind.de > ind.ate) return null;
    } catch (erro) { return null; }
    return 'reports.html?de=' + ind.de + '&ate=' + ind.ate + '#reportDelivered';
  };

  global.EpiDashboard = { acoes: acoes, render: render, mensagens: mensagens, destinos: destinos };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiDashboard;
})(typeof window !== 'undefined' ? window : globalThis);
