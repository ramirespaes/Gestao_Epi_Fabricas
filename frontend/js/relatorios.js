(function (global) {
  'use strict';

  /**
   * EpiRelatorios — Relatórios (12K-D, etapa 1): Estoque, Próximo do vencimento, Itens vencidos e EPIs entregues, pelas
   * quatro rotas GET /relatorios/*. Só leitura.
   *
   * O servidor decide tudo o que é número (saldo utilizável, dias restantes, faixa e status). Esta tela só apresenta, em
   * nós e texto (nunca HTML montado), e exporta CSV do que o servidor devolveu para o filtro e a ordem em uso — todas as
   * linhas do filtro, não só a página (páginas de 100 até o fim). Nenhum CPF, IP, hash ou dado técnico é pedido ou exibido.
   */

  var LIMITE = 20;
  var LIMITE_EXPORTACAO = 100;
  var LIMITE_PREVIA_CA = 5;
  // Tela operacional onde o CA vencido é tratado; ela já aceita o filtro pela URL (?situacao=VENCIDO).
  var DESTINO_CA_VENCIDO = 'stock-validity.html?situacao=VENCIDO';
  var MAXIMO_PAGINAS_EXPORTACAO = 100;
  var BUSCA_MAXIMA = 100;
  var TRACO = '—';
  var DATA = /^\d{4}-\d{2}-\d{2}$/;

  var TEXTOS = Object.freeze({
    CARREGANDO: 'Carregando…',
    VAZIO_ESTOQUE: 'Nenhum lote de estoque encontrado.',
    VAZIO_ENTREGAS: 'Nenhuma entrega encontrada para os filtros informados.',
    VAZIO_VENCIMENTO: 'Nenhum EPI próximo do vencimento para os filtros informados.',
    VAZIO_VENCIDOS: 'Nenhum item vencido para os filtros informados.',
    SEM_ALERTAS: 'Nenhum alerta de estoque no momento.',
    FALHA: 'Não foi possível carregar o relatório agora. Tente novamente.',
    SEM_AUTORIDADE: 'Sem permissão para consultar este relatório nesta empresa.',
    FILTRO_INVALIDO: 'Verifique os filtros informados.',
    PERIODO_INVERTIDO: 'Período inválido: a data final precisa ser igual ou posterior à inicial.',
    SERVIDOR_DESATUALIZADO: 'Este relatório não está disponível no servidor atual. Reinicie o servidor com a versão mais recente e tente de novo.',
    EXPORTACAO_FALHOU: 'Não foi possível exportar agora. Tente novamente.',
    EXPORTACAO_SEM_LINHAS: 'Não há linhas para exportar com os filtros atuais.',
    EXPORTACAO_INCOMPLETA: 'A exportação ficou incompleta: o relatório é maior que o limite de exportação. Refine os filtros.',
    EXPORTADO: 'Relatório exportado.',
    VAZIO_SOLICITACOES: 'Nenhuma solicitação aprovada aguardando entrega.',
    VAZIO_LOG: 'Nenhum registro na trilha para o período e os filtros informados.',
    PERIODO_MAXIMO: 'O período da trilha não pode passar de 92 dias. Reduza o período.',
    SISTEMA_AUTOMATICO: 'Sistema automático',
    VAZIO_REPROVADAS: 'Nenhum item reprovado pela Segurança do Trabalho para os filtros informados.',
    VAZIO_CA: 'Não há CAs vencidos em estoque.',
    VAZIO_PACOTES: 'Nenhum pacote gerado ainda.',
  });

  var ESTILO = Object.freeze({
    VERMELHO: 'background:rgba(255,59,48,0.12);color:#C0221A',
    LARANJA: 'background:rgba(255,149,0,0.12);color:#C07000',
    AMARELO: 'background:rgba(255,204,0,0.18);color:#8A6D00',
    VERDE: 'background:rgba(52,199,89,0.12);color:#1A7A35',
  });
  var COR = Object.freeze({ VERMELHO: '#FF3B30', LARANJA: '#FF9500', AMARELO: '#B38F00', VERDE: '#34C759' });

  var STATUS = Object.freeze({
    estoque: Object.freeze({
      SEM_ESTOQUE: Object.freeze({ rotulo: 'Sem estoque', estilo: ESTILO.VERMELHO }),
      EM_ALERTA: Object.freeze({ rotulo: 'Em alerta', estilo: ESTILO.LARANJA }),
      DISPONIVEL: Object.freeze({ rotulo: 'Disponível', estilo: ESTILO.VERDE }),
    }),
    proximoVencimento: Object.freeze({
      TROCAR_URGENTE: Object.freeze({ rotulo: 'Trocar urgente', estilo: ESTILO.VERMELHO, cor: COR.VERMELHO }),
      ATENCAO: Object.freeze({ rotulo: 'Atenção', estilo: ESTILO.LARANJA, cor: COR.LARANJA }),
      PROXIMO: Object.freeze({ rotulo: 'Próximo do vencimento', estilo: ESTILO.AMARELO, cor: COR.AMARELO }),
    }),
    vencidos: Object.freeze({
      TROCA_URGENTE: Object.freeze({ rotulo: 'Troca urgente', estilo: ESTILO.VERMELHO, cor: COR.VERMELHO }),
    }),
    auditoriaReprovadas: Object.freeze({
      REPROVADO: Object.freeze({ rotulo: 'Reprovado', estilo: ESTILO.VERMELHO }),
    }),
    // 12K-D6: estados do pacote de fiscalização (o servidor decide; a tela só rotula).
    fiscalPacotes: Object.freeze({
      GERANDO: Object.freeze({ rotulo: 'Gerando', estilo: ESTILO.LARANJA }),
      CONCLUIDO: Object.freeze({ rotulo: 'Concluído', estilo: ESTILO.VERDE }),
      FALHA: Object.freeze({ rotulo: 'Falhou', estilo: ESTILO.VERMELHO }),
    }),
    // Não existe "Atrasado": não há prazo (SLA) oficial decidido.
    auditoriaSolicitacoes: Object.freeze({
      AGUARDANDO_ENTREGA: Object.freeze({ rotulo: 'Aguardando entrega', estilo: ESTILO.LARANJA }),
      PARCIALMENTE_ATENDIDA: Object.freeze({ rotulo: 'Parcialmente atendida', estilo: ESTILO.AMARELO }),
    }),
  });

  var ALERTAS = Object.freeze({
    SEM_ESTOQUE: Object.freeze({ rotulo: 'Sem estoque', estilo: ESTILO.VERMELHO }),
    ABAIXO_MINIMO: Object.freeze({ rotulo: 'No mínimo ou abaixo', estilo: ESTILO.LARANJA }),
    CA_VENCIDO: Object.freeze({ rotulo: 'CA vencido', estilo: ESTILO.VERMELHO }),
    CA_AUSENTE: Object.freeze({ rotulo: 'CA ausente', estilo: ESTILO.VERMELHO }),
    CA_PROXIMO: Object.freeze({ rotulo: 'CA próximo do vencimento', estilo: ESTILO.LARANJA }),
  });

  var SITUACAO_CA = Object.freeze({
    VENCIDO: 'CA vencido', SEM_CA: 'CA ausente', VENCE_HOJE: 'CA vence hoje', A_VENCER: 'CA a vencer',
  });

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiroPositivo(v) { return typeof v === 'number' && Math.floor(v) === v && v > 0; }
  function dataPermitida(v) { return typeof v === 'string' && DATA.test(v); }
  function dataBr(iso) {
    if (!dataPermitida(iso)) return TRACO;
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  }
  var FORMATO_DATA_HORA = typeof Intl !== 'undefined'
    ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    : null;
  function dataHoraBr(valor) {
    var d = valor ? new Date(valor) : null;
    if (!d || isNaN(d.getTime()) || !FORMATO_DATA_HORA) return TRACO;
    var p = {};
    FORMATO_DATA_HORA.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
  }
  function itemComTamanho(i) { return i.material + (i.tamanho ? ' (tam. ' + i.tamanho + ')' : ''); }
  function itensTexto(itens) {
    if (!Array.isArray(itens) || !itens.length) return TRACO;
    return itens.map(function (i) { return i.material + ' (falta ' + i.pendente + ')'; }).join(', ');
  }
  function origemTexto(l) {
    if (l.origem && l.origem.navegador) return l.origem.navegador + (l.origem.sistema ? ' · ' + l.origem.sistema : '');
    return l.dispositivo ? String(l.dispositivo) : '';
  }
  function tamanhoDe(t) { return t === null || t === undefined || t === '' ? 'Único' : String(t); }
  function ou(v) { return v === null || v === undefined || v === '' ? TRACO : String(v); }
  function dias(n) { return n + (n === 1 ? ' dia' : ' dias'); }
  function rotuloStatus(aba, s) { return hasOwn(STATUS[aba], s) ? STATUS[aba][s].rotulo : TRACO; }

  // ─── Definição das quatro abas ────────────────────────────────────
  var SETOR = { campo: 'setor', rotulo: 'Setor', tipo: 'texto', placeholder: 'Ex.: produção, manutenção' };
  var FUNCIONARIO = { campo: 'funcionario', rotulo: 'Funcionário', tipo: 'texto', placeholder: 'Nome ou matrícula' };
  var EPI = { campo: 'item', rotulo: 'EPI', tipo: 'texto', placeholder: 'Nome ou tipo do EPI' };

  function caStatus(l) { return l.ca && l.ca.numero ? l.ca.numero : TRACO; }

  var ABAS = Object.freeze({
    estoque: Object.freeze({
      id: 'estoque',
      caminho: '/relatorios/estoque',
      recurso: 'materials',
      arquivo: 'relatorio-estoque',
      itens: 'linhas',
      vazio: TEXTOS.VAZIO_ESTOQUE,
      ordemPadrao: Object.freeze({ ordem: 'material', direcao: 'asc' }),
      filtros: Object.freeze([
        { campo: 'busca', rotulo: 'Material, tipo ou CA', tipo: 'texto', placeholder: 'Ex.: botina, luva, 12345' },
        {
          campo: 'status', rotulo: 'Status', tipo: 'select', opcoes: [['', 'Todos'], ['SEM_ESTOQUE', 'Sem estoque'], ['EM_ALERTA', 'Em alerta'], ['DISPONIVEL', 'Disponível']],
        },
      ]),
      colunas: Object.freeze([
        { rotulo: 'Material', ordem: 'material', forte: true, valor: function (l) { return l.material; } },
        { rotulo: 'Tipo', ordem: 'tipo', valor: function (l) { return ou(l.tipo); } },
        { rotulo: 'CA', ordem: 'ca', valor: caStatus, detalhe: function (l) { return l.ca && hasOwn(SITUACAO_CA, l.ca.situacao) ? SITUACAO_CA[l.ca.situacao] : ''; } },
        { rotulo: 'Lote', ordem: 'lote', valor: function (l) { return '#' + l.loteId; }, detalhe: function (l) { return 'Tam. ' + tamanhoDe(l.tamanho); } },
        { rotulo: 'Data de entrada', ordem: 'dataEntrada', nowrap: true, valor: function (l) { return dataBr(l.dataEntrada); } },
        { rotulo: 'Quantidade entrada', ordem: 'quantidadeEntrada', valor: function (l) { return String(l.quantidadeEntrada); } },
        {
          rotulo: 'Disponível no lote',
          ordem: 'disponivel',
          valor: function (l) { return String(l.disponivelNoLote); },
          detalhe: function (l) { return l.saldoFisicoNoLote !== l.disponivelNoLote ? 'Físico ' + l.saldoFisicoNoLote + ' (bloqueado por CA)' : ''; },
        },
        { rotulo: 'Estoque mínimo', ordem: 'estoqueMinimo', valor: function (l) { return String(l.estoqueMinimo); } },
        { rotulo: 'Status', ordem: 'status', selo: function (l) { return STATUS.estoque[l.status] || null; }, valor: function (l) { return rotuloStatus('estoque', l.status); } },
      ]),
    }),
    proximoVencimento: Object.freeze({
      id: 'proximoVencimento',
      caminho: '/relatorios/proximo-vencimento',
      recurso: 'epiFicha',
      arquivo: 'relatorio-proximo-do-vencimento',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_VENCIMENTO,
      ordemPadrao: Object.freeze({ ordem: 'dias', direcao: 'asc' }),
      filtros: Object.freeze([
        FUNCIONARIO, SETOR, EPI,
        {
          campo: 'faixa', rotulo: 'Faixa', tipo: 'select', opcoes: [['', 'Todos'], ['0-10', '0 a 10 dias'], ['11-20', '11 a 20 dias'], ['21-30', '21 a 30 dias']],
        },
      ]),
      colunas: Object.freeze([
        { rotulo: 'Funcionário', ordem: 'funcionario', forte: true, valor: function (l) { return l.trabalhador.nome; } },
        { rotulo: 'Setor', ordem: 'setor', valor: function (l) { return ou(l.trabalhador.setor); } },
        { rotulo: 'EPI', ordem: 'epi', valor: function (l) { return l.material.nome; } },
        { rotulo: 'CA', ordem: 'ca', valor: caStatus },
        { rotulo: 'Data da entrega', ordem: 'dataEntrega', nowrap: true, valor: function (l) { return dataBr(l.dataEntrega); } },
        { rotulo: 'Validade de uso', ordem: 'validade', nowrap: true, valor: function (l) { return dataBr(l.validadeUso); } },
        {
          rotulo: 'Dias restantes',
          ordem: 'dias',
          valor: function (l) { return String(l.diasRestantes); },
          cor: function (l) { return hasOwn(STATUS.proximoVencimento, l.status) ? STATUS.proximoVencimento[l.status].cor : null; },
        },
        { rotulo: 'Status', ordem: 'dias', selo: function (l) { return STATUS.proximoVencimento[l.status] || null; }, valor: function (l) { return rotuloStatus('proximoVencimento', l.status); } },
      ]),
    }),
    vencidos: Object.freeze({
      id: 'vencidos',
      caminho: '/relatorios/vencidos',
      recurso: 'epiFicha',
      arquivo: 'relatorio-itens-vencidos',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_VENCIDOS,
      ordemPadrao: Object.freeze({ ordem: 'dias', direcao: 'asc' }),
      filtros: Object.freeze([FUNCIONARIO, SETOR, EPI]),
      colunas: Object.freeze([
        { rotulo: 'Funcionário', ordem: 'funcionario', forte: true, valor: function (l) { return l.trabalhador.nome; } },
        { rotulo: 'Setor', ordem: 'setor', valor: function (l) { return ou(l.trabalhador.setor); } },
        { rotulo: 'EPI', ordem: 'epi', valor: function (l) { return l.material.nome; } },
        { rotulo: 'CA', ordem: 'ca', valor: caStatus },
        { rotulo: 'Data da entrega', ordem: 'dataEntrega', nowrap: true, valor: function (l) { return dataBr(l.dataEntrega); } },
        { rotulo: 'Validade de uso', ordem: 'validade', nowrap: true, valor: function (l) { return dataBr(l.validadeUso); } },
        { rotulo: 'Dias vencidos', ordem: 'dias', valor: function (l) { return String(l.diasVencidos); }, cor: function () { return COR.VERMELHO; } },
        { rotulo: 'Status', ordem: 'dias', selo: function (l) { return STATUS.vencidos[l.status] || null; }, valor: function (l) { return rotuloStatus('vencidos', l.status); } },
      ]),
    }),
    episEntregues: Object.freeze({
      id: 'episEntregues',
      caminho: '/relatorios/epis-entregues',
      recurso: 'epiFicha',
      arquivo: 'relatorio-epis-entregues',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_ENTREGAS,
      ordemPadrao: Object.freeze({ ordem: 'dataEntrega', direcao: 'desc' }),
      filtros: Object.freeze([
        { campo: 'de', rotulo: 'Período inicial', tipo: 'data' },
        { campo: 'ate', rotulo: 'Período final', tipo: 'data' },
        FUNCIONARIO, SETOR, EPI,
      ]),
      colunas: Object.freeze([
        { rotulo: 'Funcionário', ordem: 'funcionario', forte: true, valor: function (l) { return l.trabalhador.nome; } },
        { rotulo: 'Setor', ordem: 'setor', valor: function (l) { return ou(l.trabalhador.setor); } },
        { rotulo: 'EPI', ordem: 'epi', valor: function (l) { return l.material.nome; } },
        { rotulo: 'CA', ordem: 'ca', valor: caStatus },
        { rotulo: 'Quantidade', ordem: 'quantidade', valor: function (l) { return String(l.quantidade); } },
        { rotulo: 'Data da entrega', ordem: 'dataEntrega', nowrap: true, valor: function (l) { return dataBr(l.dataEntrega); } },
        { rotulo: 'Entregue por', ordem: 'responsavel', valor: function (l) { return ou(l.responsavel && l.responsavel.nome); } },
      ]),
    }),
    // ── 12K-D5: Auditoria (permissão própria: reportsAudit) ──
    auditoriaSolicitacoes: Object.freeze({
      id: 'auditoriaSolicitacoes',
      caminho: '/relatorios/auditoria/solicitacoes-nao-atendidas',
      recurso: 'reportsAudit',
      arquivo: 'relatorio-auditoria-solicitacoes-nao-atendidas',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_SOLICITACOES,
      ordemPadrao: Object.freeze({ ordem: 'diasEmFila', direcao: 'desc' }),
      filtros: Object.freeze([
        FUNCIONARIO,
        { campo: 'item', rotulo: 'EPI solicitado', tipo: 'texto', placeholder: 'Nome do EPI' },
        { campo: 'status', rotulo: 'Status', tipo: 'select', opcoes: [['', 'Todos'], ['AGUARDANDO_ENTREGA', 'Aguardando entrega'], ['PARCIALMENTE_ATENDIDA', 'Parcialmente atendida']] },
      ]),
      colunas: Object.freeze([
        { rotulo: 'Pedido', ordem: 'pedido', valor: function (l) { return 'PED-' + String(l.numero).padStart(4, '0'); } },
        { rotulo: 'Funcionário', ordem: 'funcionario', forte: true, valor: function (l) { return l.trabalhador.nome; } },
        { rotulo: 'EPI solicitado', valor: function (l) { return itensTexto(l.itens); } },
        { rotulo: 'Data da aprovação', ordem: 'dataAprovacao', nowrap: true, valor: function (l) { return dataBr(l.aprovadoEm); } },
        { rotulo: 'Aprovado por', ordem: 'aprovadoPor', valor: function (l) { return ou(l.aprovadoPor && l.aprovadoPor.nome); } },
        { rotulo: 'Dias em fila', ordem: 'diasEmFila', valor: function (l) { return String(l.diasEmFila); } },
        { rotulo: 'Status', ordem: 'status', selo: function (l) { return STATUS.auditoriaSolicitacoes[l.status] || null; }, valor: function (l) { return rotuloStatus('auditoriaSolicitacoes', l.status); } },
      ]),
    }),
    // Itens reprovados pela SST: uma linha por item, com o motivo gravado no item e quem decidiu/quando na solicitação.
    auditoriaReprovadas: Object.freeze({
      id: 'auditoriaReprovadas',
      caminho: '/relatorios/auditoria/solicitacoes-reprovadas',
      recurso: 'reportsAudit',
      arquivo: 'relatorio-auditoria-solicitacoes-reprovadas',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_REPROVADAS,
      ordemPadrao: Object.freeze({ ordem: 'dataReprovacao', direcao: 'desc' }),
      filtros: Object.freeze([
        { campo: 'de', rotulo: 'Reprovação — de', tipo: 'data' },
        { campo: 'ate', rotulo: 'Reprovação — até', tipo: 'data' },
        FUNCIONARIO,
        { campo: 'item', rotulo: 'Item solicitado', tipo: 'texto', placeholder: 'Nome do EPI' },
      ]),
      colunas: Object.freeze([
        { rotulo: 'Pedido', ordem: 'pedido', valor: function (l) { return 'PED-' + String(l.numero).padStart(4, '0'); } },
        { rotulo: 'Funcionário', ordem: 'funcionario', forte: true, valor: function (l) { return l.trabalhador.nome; } },
        { rotulo: 'Item solicitado', ordem: 'item', valor: function (l) { return itemComTamanho(l.item); } },
        { rotulo: 'Quantidade', ordem: 'quantidade', valor: function (l) { return String(l.quantidade); } },
        { rotulo: 'Data da reprovação', ordem: 'dataReprovacao', nowrap: true, valor: function (l) { return dataBr(l.reprovadoEm); } },
        { rotulo: 'Reprovado por', ordem: 'reprovadoPor', valor: function (l) { return ou(l.reprovadoPor && l.reprovadoPor.nome); } },
        { rotulo: 'Motivo', valor: function (l) { return ou(l.motivo); } },
        { rotulo: 'Status', selo: function (l) { return STATUS.auditoriaReprovadas[l.status] || null; }, valor: function (l) { return rotuloStatus('auditoriaReprovadas', l.status); } },
      ]),
    }),
    // Modal-resumo do card "CA vencidos em estoque": só as primeiras linhas (a investigação e a tratativa são da tela
    // Validade de Estoque, que tem a regra e o filtro). Quantidade disponível = saldo ATUAL do lote.
    auditoriaCaVencidos: Object.freeze({
      id: 'auditoriaCaVencidos',
      caminho: '/relatorios/auditoria/ca-vencidos',
      recurso: 'reportsAudit',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_CA,
      semOrdenacao: true,
      ordemPadrao: Object.freeze({ ordem: '', direcao: 'asc' }),
      filtros: Object.freeze([]),
      colunas: Object.freeze([
        { rotulo: 'Produto / EPI', forte: true, valor: function (l) { return l.material; } },
        { rotulo: 'CA', valor: function (l) { return ou(l.caNumero); } },
        { rotulo: 'Validade do CA', nowrap: true, valor: function (l) { return dataBr(l.caValidade); } },
        { rotulo: 'Lote', valor: function (l) { return '#' + l.loteId + ' · Tam. ' + tamanhoDe(l.tamanho); } },
        { rotulo: 'Quantidade disponível', valor: function (l) { return String(l.quantidadeDisponivel); } },
      ]),
    }),
    auditoriaLog: Object.freeze({
      id: 'auditoriaLog',
      caminho: '/relatorios/auditoria/log',
      recurso: 'reportsAudit',
      arquivo: 'relatorio-auditoria-log-de-acoes',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_LOG,
      ordemPadrao: Object.freeze({ ordem: 'dataHora', direcao: 'desc' }),
      filtros: Object.freeze([
        { campo: 'de', rotulo: 'Período — de', tipo: 'data' },
        { campo: 'ate', rotulo: 'Período — até', tipo: 'data' },
        { campo: 'usuario', rotulo: 'Usuário', tipo: 'texto', placeholder: 'Nome do usuário' },
        { campo: 'acao', rotulo: 'Ação', tipo: 'texto', placeholder: 'Ex.: ENTREGA, SOLICITACAO' },
        { campo: 'busca', rotulo: 'Referência', tipo: 'texto', placeholder: 'Identificador registrado' },
      ]),
      colunas: Object.freeze([
        { rotulo: 'Data / Hora', ordem: 'dataHora', nowrap: true, valor: function (l) { return dataHoraBr(l.criadoEm); } },
        { rotulo: 'Usuário', ordem: 'usuario', forte: true, valor: function (l) { return l.usuario ? l.usuario.nome : TEXTOS.SISTEMA_AUTOMATICO; } },
        { rotulo: 'Perfil', valor: function (l) { return ou(l.perfil); } },
        { rotulo: 'Ação', ordem: 'acao', valor: function (l) { return l.acao; } },
        { rotulo: 'Referência', valor: function (l) { return l.referenciaAmigavel || ou(l.referencia); }, detalhe: function (l) { return l.referenciaAmigavel && l.referencia ? 'Registrada: ' + l.referencia : ''; } },
        { rotulo: 'IP / Dispositivo', valor: function (l) { return [l.ip, origemTexto(l)].filter(Boolean).join(' · ') || TRACO; } },
      ]),
    }),
    // 12K-D6: histórico dos pacotes de fiscalização da empresa. Sem ordenação e sem filtros; o download é da própria linha.
    fiscalPacotes: Object.freeze({
      id: 'fiscalPacotes',
      caminho: '/relatorios/fiscalizacao/pacotes',
      recurso: 'reportsFiscal',
      itens: 'itens',
      vazio: TEXTOS.VAZIO_PACOTES,
      semOrdenacao: true,
      ordemPadrao: Object.freeze({ ordem: '', direcao: 'asc' }),
      filtros: Object.freeze([]),
      colunas: Object.freeze([
        { rotulo: 'Pacote', forte: true, valor: function (l) { return fiscal.identificador(l.id); }, detalhe: function (l) { return l.status === 'FALHA' ? 'Motivo: ' + fiscal.motivoDaFalha(l.erroCodigo) : ''; } },
        { rotulo: 'Período', nowrap: true, valor: function (l) { return dataBr(l.periodoInicio) + ' a ' + dataBr(l.periodoFim); } },
        { rotulo: 'Finalidade', valor: function (l) { return fiscal.rotuloFinalidade(l.finalidade); } },
        { rotulo: 'Módulos', valor: function (l) { return (Array.isArray(l.escopos) ? l.escopos : []).map(fiscal.rotuloEscopo).join(', '); } },
        { rotulo: 'Gerado por', valor: function (l) { return ou(l.geradoPor && l.geradoPor.nome); } },
        { rotulo: 'Gerado em', nowrap: true, valor: function (l) { return dataHoraBr(l.criadoEm); } },
        { rotulo: 'Status', selo: function (l) { return hasOwn(STATUS.fiscalPacotes, l.status) ? STATUS.fiscalPacotes[l.status] : null; }, valor: function (l) { return rotuloStatus('fiscalPacotes', l.status); } },
      ]),
      // Só o pacote CONCLUÍDO tem download; o servidor confere de novo (permissão, empresa e integridade).
      aposLinha: function (doc, tr, l) {
        if (l.status !== 'CONCLUIDO') return;
        tr.children[tr.children.length - 1].appendChild(no(doc, 'div', { style: NOTA }, [no(doc, 'button', { type: 'button', class: 'outlined-btn', 'data-baixar': String(l.id) }, ['Baixar'])]));
      },
    }),
  });

  function aba(id) {
    if (!hasOwn(ABAS, id)) throw new TypeError('relatório desconhecido');
    return ABAS[id];
  }

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/relatorios.js');
    return global.EpiHttp;
  }

  // ─── Consulta ─────────────────────────────────────────────────────
  function valorDoFiltro(def, bruto) {
    var v = texto(bruto);
    if (def.tipo === 'texto') return v.slice(0, BUSCA_MAXIMA);
    if (def.tipo === 'data') return dataPermitida(v) ? v : '';
    return def.opcoes.some(function (o) { return o[0] === v; }) ? v : '';
  }

  function ordenacaoValida(a, ordenacao) {
    var o = ordenacao || {};
    var conhecida = !!o.ordem && a.colunas.some(function (c) { return c.ordem === o.ordem; });
    return {
      ordem: conhecida ? o.ordem : a.ordemPadrao.ordem,
      direcao: conhecida ? (o.direcao === 'desc' ? 'desc' : 'asc') : a.ordemPadrao.direcao,
    };
  }

  function consulta(a, filtro, ordenacao, pagina, limite) {
    var f = filtro || {};
    var q = [];
    a.filtros.forEach(function (def) {
      var v = valorDoFiltro(def, f[def.campo]);
      if (v) q.push(def.campo + '=' + encodeURIComponent(v));
    });
    if (!a.semOrdenacao) {
      var o = ordenacaoValida(a, ordenacao);
      q.push('ordem=' + o.ordem, 'direcao=' + o.direcao);
    }
    q.push('pagina=' + (inteiroPositivo(pagina) ? pagina : 1), 'limite=' + (inteiroPositivo(limite) ? limite : LIMITE));
    return a.caminho + '?' + q.join('&');
  }

  // ─── Fiscalização (12K-D6): formulário, validação local e textos. O servidor é a autoridade final. ───
  var FINALIDADES = Object.freeze([
    Object.freeze({ valor: 'FISCALIZACAO_TRABALHO', rotulo: 'Fiscalização do Trabalho' }),
    Object.freeze({ valor: 'AUDITORIA_CLIENTE', rotulo: 'Auditoria de cliente' }),
    Object.freeze({ valor: 'AUDITORIA_INTERNA', rotulo: 'Auditoria interna' }),
    Object.freeze({ valor: 'SOLICITACAO_JURIDICA_DOCUMENTAL', rotulo: 'Solicitação jurídica/documental' }),
    Object.freeze({ valor: 'OUTRA', rotulo: 'Outra' }),
  ]);
  var ESCOPOS_FISCAIS = Object.freeze([
    Object.freeze({ valor: 'FICHAS_ENTREGAS_CONFIRMADAS', rotulo: 'Fichas/entregas de EPI confirmadas' }),
    Object.freeze({ valor: 'TRILHA_AUDITORIA', rotulo: 'Trilha de auditoria completa' }),
    Object.freeze({ valor: 'HISTORICO_ESTOQUE_CA', rotulo: 'Histórico de estoque e CA' }),
    Object.freeze({ valor: 'REGRAS_GHE', rotulo: 'Regras de GHE e elegibilidade' }),
  ]);
  var DIAS_FISCAL_MAXIMOS = 366;
  var OBSERVACAO_MAXIMA = 500;
  var CHAVE_FISCAL = /^[A-Za-z0-9_-]{8,128}$/;
  var DIA_MS = 86400000;
  var ERROS_FISCAIS = Object.freeze({
    LIMITE_LINHAS_EXCEDIDO: 'Um dos módulos passou do limite de linhas por pacote. Reduza o período e tente novamente.',
    PACOTE_EXCEDE_TAMANHO: 'O pacote passou do tamanho máximo permitido. Reduza o período ou os módulos e tente novamente.',
    PERIODO_MAXIMO_EXCEDIDO: 'O período não pode passar de 366 dias. Reduza o período.',
    GERACAO_EM_ANDAMENTO: 'Já existe uma geração em andamento para esta empresa. Aguarde a conclusão.',
    IDEMPOTENCIA_CONFLITO: 'Esta tentativa já foi usada para outro pedido. Faça uma nova tentativa.',
    GERACAO_ABANDONADA: 'A geração foi interrompida. Faça uma nova tentativa.',
    FISCALIZACAO_INDISPONIVEL: 'A Fiscalização não está disponível neste ambiente.',
    PACOTE_NAO_CONCLUIDO: 'O pacote ainda não está concluído ou a geração falhou.',
    PACOTE_NAO_ENCONTRADO: 'Pacote não encontrado.',
    PACOTE_INTEGRIDADE: 'Não foi possível validar a integridade do pacote. Gere um novo pacote.',
    PACOTE_ARQUIVO_INDISPONIVEL: 'O arquivo do pacote está indisponível. Gere um novo pacote.',
  });
  var ERRO_FISCAL_PADRAO = 'Não foi possível concluir agora. Tente novamente.';
  var MOTIVOS_DA_FALHA = Object.freeze({
    ZIP_EXCEDE_LIMITE: 'excedeu o tamanho máximo do pacote',
    LIMITE_LINHAS_EXCEDIDO: 'passou do limite de linhas por módulo',
    GERACAO_ABANDONADA: 'geração interrompida',
  });
  function diaFiscal(v) {
    var m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
    if (!m) return NaN;
    var t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    var d = new Date(t);
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : NaN;
  }
  function escoposDoForm(lista) {
    var pedidos = Array.isArray(lista) ? lista : [];
    return ESCOPOS_FISCAIS.map(function (e) { return e.valor; }).filter(function (v) { return pedidos.indexOf(v) !== -1; });
  }
  var fiscal = {
    FINALIDADES: FINALIDADES,
    ESCOPOS: ESCOPOS_FISCAIS,
    DIAS_MAXIMOS: DIAS_FISCAL_MAXIMOS,
    OBSERVACAO_MAXIMA: OBSERVACAO_MAXIMA,
    identificador: function (id) { return 'FIS-' + String(id); },
    rotuloFinalidade: function (valor) { var f = FINALIDADES.filter(function (x) { return x.valor === valor; })[0]; return f ? f.rotulo : TRACO; },
    rotuloEscopo: function (valor) { var e = ESCOPOS_FISCAIS.filter(function (x) { return x.valor === valor; })[0]; return e ? e.rotulo : TRACO; },
    /** Dias do período contando as duas datas (mesmo dia = 1); NaN se alguma data for inválida. Contagem por data civil. */
    diasInclusivos: function (inicio, fim) {
      var a = diaFiscal(inicio);
      var b = diaFiscal(fim);
      return Number.isNaN(a) || Number.isNaN(b) ? NaN : Math.round((b - a) / DIA_MS) + 1;
    },
    /** As mesmas regras do servidor, só para avisar antes da rede: o servidor continua a autoridade. */
    validar: function (form) {
      var f = form || {};
      var erros = {};
      var inicioOk = !Number.isNaN(diaFiscal(f.periodoInicio));
      var fimOk = !Number.isNaN(diaFiscal(f.periodoFim));
      if (!inicioOk) erros.periodoInicio = 'Informe a data inicial.';
      if (!fimOk) erros.periodoFim = 'Informe a data final.';
      if (inicioOk && fimOk) {
        var dias = fiscal.diasInclusivos(f.periodoInicio, f.periodoFim);
        if (dias < 1) erros.periodoFim = 'A data final precisa ser igual ou posterior à inicial.';
        else if (dias > DIAS_FISCAL_MAXIMOS) erros.periodoFim = 'O período não pode passar de 366 dias. Reduza o período.';
      }
      if (!FINALIDADES.some(function (x) { return x.valor === f.finalidade; })) erros.finalidade = 'Selecione a finalidade.';
      var observacao = texto(f.observacao);
      if (Array.from(observacao).length > OBSERVACAO_MAXIMA || /[\u0000-\u001f\u007f]/.test(observacao)) erros.observacao = 'Observação inválida: até 500 caracteres, sem caracteres de controle.';
      else if (f.finalidade === 'OUTRA' && !observacao) erros.observacao = 'Informe a observação para a finalidade Outra.';
      var escopos = Array.isArray(f.escopos) ? f.escopos : [];
      if (!escopos.length || escopos.some(function (e) { return !ESCOPOS_FISCAIS.some(function (x) { return x.valor === e; }); }) || new Set(escopos).size !== escopos.length) erros.escopos = 'Selecione pelo menos um módulo.';
      return { ok: Object.keys(erros).length === 0, erros: erros };
    },
    /** Corpo exato do contrato: nunca empresa, usuário, status, hash ou caminho. A observação vazia nem é enviada. */
    corpo: function (form) {
      var f = form || {};
      var corpo = { periodoInicio: f.periodoInicio, periodoFim: f.periodoFim, finalidade: f.finalidade, escopos: escoposDoForm(f.escopos) };
      var observacao = texto(f.observacao);
      if (observacao) corpo.observacao = observacao;
      return corpo;
    },
    corpoGeracao: function (form, chave) {
      if (typeof chave !== 'string' || !CHAVE_FISCAL.test(chave)) throw new TypeError('chave de idempotência inválida');
      var corpo = fiscal.corpo(form);
      corpo.chaveIdempotencia = chave;
      return corpo;
    },
    /** Uma chave por TENTATIVA de geração (a mesma só se repete quando a resposta ficou incerta). */
    novaChave: function () {
      var c = global.crypto;
      if (c && typeof c.randomUUID === 'function') return 'k-' + c.randomUUID();
      var bytes = new Uint8Array(16);
      if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
      else throw new Error('sem fonte de aleatoriedade segura neste navegador');
      return 'k-' + Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    },
    caminhoDownload: function (id) {
      var numero = typeof id === 'string' && /^[1-9]\d{0,9}$/.test(id) ? Number(id) : id;
      if (!inteiroPositivo(numero) || numero > 2147483647) throw new TypeError('identificador de pacote inválido');
      return '/relatorios/fiscalizacao/pacotes/' + numero + '/download';
    },
    /** Texto fixo por código; nunca o texto do servidor. */
    mensagemDeErro: function (codigo) { return typeof codigo === 'string' && hasOwn(ERROS_FISCAIS, codigo) ? ERROS_FISCAIS[codigo] : ERRO_FISCAL_PADRAO; },
    motivoDaFalha: function (codigo) { return typeof codigo === 'string' && hasOwn(MOTIVOS_DA_FALHA, codigo) ? MOTIVOS_DA_FALHA[codigo] : 'falha na geração'; },
  };

  var acoes = {
    /** Os quatro números do topo da Auditoria, todos derivados no servidor. */
    indicadoresAuditoria: function () { return http().requisitar('GET', '/relatorios/auditoria/indicadores'); },
    /** 12K-D6: pré-visualização (só contagens; não gera pacote). */
    fiscalPrevia: function (corpo) { return http().requisitar('POST', '/relatorios/fiscalizacao/previa', { corpo: corpo }); },
    /** 12K-D6: geração; a chave identifica UMA tentativa. */
    fiscalGerar: function (corpo, chave) { return http().requisitar('POST', '/relatorios/fiscalizacao/pacotes', { corpo: fiscal.corpoGeracao(corpo, chave) }); },
    fiscalListar: function (pagina, limite) { return http().requisitar('GET', consulta(aba('fiscalPacotes'), {}, null, pagina, limite)); },
    consultar: function (id, filtro, ordenacao, pagina, limite) {
      var a = aba(id);
      return http().requisitar('GET', consulta(a, filtro, ordenacao, pagina, limite));
    },
    /** Todas as linhas do filtro e da ordem em uso, em páginas de 100; nunca só a página mostrada. */
    todas: async function (id, filtro, ordenacao) {
      var a = aba(id);
      var linhas = [];
      var total = 0;
      for (var pagina = 1; pagina <= MAXIMO_PAGINAS_EXPORTACAO; pagina += 1) {
        // eslint-disable-next-line no-await-in-loop
        var r = await http().requisitar('GET', consulta(a, filtro, ordenacao, pagina, LIMITE_EXPORTACAO));
        if (!r.ok) return { ok: false, resposta: r };
        var d = r.dados || {};
        var lote = Array.isArray(d[a.itens]) ? d[a.itens] : [];
        total = typeof d.total === 'number' ? d.total : total;
        linhas = linhas.concat(lote);
        if (!lote.length || linhas.length >= total) return { ok: true, linhas: linhas, total: total, completa: true };
      }
      return { ok: true, linhas: linhas, total: total, completa: linhas.length >= total };
    },
  };

  // ─── Modelo / texto ───────────────────────────────────────────────
  function celulaCsv(v) {
    var s = String(v === undefined || v === null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  var modelo = {
    periodoInvertido: function (de, ate) { return dataPermitida(de) && dataPermitida(ate) && de > ate; },
    /** Filtro como a tela o usa: só valores válidos para cada campo da aba. */
    normalizar: function (id, bruto) {
      var a = aba(id);
      var f = {};
      a.filtros.forEach(function (def) { f[def.campo] = valorDoFiltro(def, (bruto || {})[def.campo]); });
      return f;
    },
    comFiltro: function (id, f) { return aba(id).filtros.some(function (def) { return !!(f && f[def.campo]); }); },
    ordenacao: ordenacaoValida,
    /** Próxima ordenação ao clicar no cabeçalho: mesma coluna inverte; outra coluna começa crescente. */
    alternarOrdem: function (id, atual, ordem) {
      var a = aba(id);
      var o = ordenacaoValida(a, atual);
      if (o.ordem === ordem) return { ordem: ordem, direcao: o.direcao === 'asc' ? 'desc' : 'asc' };
      return ordenacaoValida(a, { ordem: ordem, direcao: 'asc' });
    },
    erro: function (r) {
      if (r && r.status === 403) return TEXTOS.SEM_AUTORIDADE;
      if (r && r.status === 400) {
        if (r.codigo === 'PERIODO_MAXIMO_EXCEDIDO') return TEXTOS.PERIODO_MAXIMO;
        var campos = Array.isArray(r.detalhes) ? r.detalhes.map(function (d) { return d && d.campo; }) : [];
        if (campos.some(function (c) { return typeof c === 'string' && c.indexOf('query.') === 0; })) return TEXTOS.FILTRO_INVALIDO;
      }
      if (r && r.status === 404) return TEXTOS.SERVIDOR_DESATUALIZADO;
      return TEXTOS.FALHA;
    },
    paginacao: function (d, quantidade) {
      var pagina = inteiroPositivo(d.pagina) ? d.pagina : 1;
      var limite = inteiroPositivo(d.limite) ? d.limite : LIMITE;
      var total = typeof d.total === 'number' && d.total >= 0 ? d.total : quantidade;
      if (!quantidade) return { texto: '', anterior: pagina > 1, proxima: false };
      var de = (pagina - 1) * limite + 1;
      var ate = (pagina - 1) * limite + quantidade;
      return { texto: de + '–' + ate + ' de ' + total, anterior: pagina > 1, proxima: ate < total };
    },
    indicadoresAuditoria: function (d) {
      var i = d && d.indicadores ? d.indicadores : {};
      function n(v) { return typeof v === 'number' ? String(v) : TRACO; }
      return {
        entregasPendentes: n(i.entregasPendentes), itensReprovados: n(i.itensReprovados), caVencidosEmEstoque: n(i.caVencidosEmEstoque), logs30Dias: n(i.logs30Dias),
      };
    },
    indicadores: function (d) {
      var i = d && d.indicadores ? d.indicadores : {};
      function n(v) { return typeof v === 'number' ? String(v) : TRACO; }
      return { itensCadastrados: n(i.itensCadastrados), comEstoqueDisponivel: n(i.comEstoqueDisponivel), emAlerta: n(i.emAlerta) };
    },
    alerta: function (a) {
      var tipo = hasOwn(ALERTAS, a.tipo) ? ALERTAS[a.tipo] : null;
      var detalhe = 'Disponível: ' + a.saldoTotal + ' · Estoque mínimo: ' + a.estoqueMinimo;
      if (a.caNumero) detalhe += ' · CA ' + a.caNumero;
      return { titulo: a.material, detalhe: detalhe, rotulo: tipo ? tipo.rotulo : TRACO, estilo: tipo ? tipo.estilo : null };
    },
    /** "Exibindo 5 de 18 CAs vencidos" quando há mais do que a prévia mostra; senão, só a contagem. */
    resumoCaVencidos: function (mostrados, total) {
      if (typeof total !== 'number' || total <= 0) return '';
      if (total > mostrados) return 'Exibindo ' + mostrados + ' de ' + total + ' CAs vencidos';
      return total + (total === 1 ? ' CA vencido' : ' CAs vencidos');
    },
    cabecalhoCsv: function (id) { return aba(id).colunas.map(function (c) { return c.rotulo; }); },
    /**
     * CSV para o Excel brasileiro: UTF-8 com BOM, separador ";", fim de linha CRLF, toda célula entre aspas e
     * neutralizada contra fórmula. Mesmas colunas da tabela e só o que a tela exibe.
     */
    csv: function (id, linhas) {
      var a = aba(id);
      var colunas = a.colunas;
      var corpo = [colunas.map(function (c) { return c.rotulo; })].concat(linhas.map(function (l) {
        return colunas.map(function (c) { return c.valor(l); });
      }));
      return '﻿' + corpo.map(function (l) { return l.map(celulaCsv).join(';'); }).join('\r\n');
    },
    nomeArquivo: function (id, hojeIso) { return aba(id).arquivo + '-' + (dataPermitida(hojeIso) ? hojeIso : 'exportacao') + '.csv'; },
  };

  // ─── Render (nós e texto) ─────────────────────────────────────────
  function no(doc, tag, atributos, filhos) {
    var el = doc.createElement(tag);
    Object.keys(atributos || {}).forEach(function (k) {
      var v = atributos[k];
      if (v === null || v === undefined || v === false) return;
      el.setAttribute(k, String(v));
    });
    (filhos || []).forEach(function (f) {
      if (f === null || f === undefined || f === false) return;
      el.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f);
    });
    return el;
  }
  var NOTA = 'font-size:11px;color:var(--on-surface-variant);margin-top:2px';

  var render = {
    filtro: function (doc, id, def) {
      var dom = 'f-' + id + '-' + def.campo;
      var controle;
      if (def.tipo === 'select') {
        controle = no(doc, 'select', { id: dom, class: 'select', 'data-filtro': def.campo }, def.opcoes.map(function (o) { return no(doc, 'option', { value: o[0] }, [o[1]]); }));
      } else {
        controle = no(doc, 'input', {
          id: dom, class: 'input', 'data-filtro': def.campo, type: def.tipo === 'data' ? 'date' : 'search', maxlength: def.tipo === 'texto' ? BUSCA_MAXIMA : null, placeholder: def.placeholder || null, autocomplete: 'off',
        });
      }
      return no(doc, 'div', { class: 'field' }, [no(doc, 'label', { for: dom }, [def.rotulo]), controle]);
    },
    filtros: function (doc, id) {
      var a = aba(id);
      var acoesBox = no(doc, 'div', { class: 'footer-actions filters-actions' }, [
        no(doc, 'button', { type: 'button', class: 'filled-btn', 'data-acao-relatorio': 'filtrar' }, ['Filtrar']),
        no(doc, 'button', { type: 'button', class: 'outlined-btn', 'data-acao-relatorio': 'limpar' }, ['Limpar']),
      ]);
      return a.filtros.map(function (def) { return render.filtro(doc, id, def); }).concat([acoesBox]);
    },
    cabecalho: function (doc, id, ordenacao) {
      var a = aba(id);
      var o = ordenacaoValida(a, ordenacao);
      return no(doc, 'tr', {}, a.colunas.map(function (c, i) {
        if (!c.ordem) return no(doc, 'th', { 'data-coluna': String(i) }, [c.rotulo]);
        var ativa = c.ordem === o.ordem && (c.rotulo !== 'Status' || a.colunas.filter(function (x) { return x.ordem === o.ordem; })[0] === c);
        var seta = ativa ? (o.direcao === 'asc' ? ' ▲' : ' ▼') : '';
        return no(doc, 'th', {
          'data-ordem': c.ordem, 'data-coluna': String(i), role: 'button', tabindex: '0', style: 'cursor:pointer;user-select:none', 'aria-sort': ativa ? (o.direcao === 'asc' ? 'ascending' : 'descending') : 'none',
        }, [c.rotulo + seta]);
      }));
    },
    mensagem: function (doc, id, textoMensagem) {
      return no(doc, 'tr', { 'data-vazio': '' }, [no(doc, 'td', { colspan: String(aba(id).colunas.length), style: 'text-align:center;color:var(--on-surface-variant);padding:32px' }, [textoMensagem])]);
    },
    linha: function (doc, id, l) {
      var a = aba(id);
      var tr = no(doc, 'tr', { 'data-linha': String(l.itemId || l.loteId || l.entregaId || l.solicitacaoId || l.id || '') }, a.colunas.map(function (c) {
        var selo = c.selo ? c.selo(l) : null;
        if (selo) return no(doc, 'td', {}, [no(doc, 'span', { class: 'badge', style: selo.estilo + ';font-size:11px' }, [selo.rotulo])]);
        var detalhe = c.detalhe ? c.detalhe(l) : '';
        var cor = c.cor ? c.cor(l) : null;
        var principal = c.forte ? no(doc, 'strong', {}, [c.valor(l)]) : (cor ? no(doc, 'span', { style: 'color:' + cor + ';font-weight:500' }, [c.valor(l)]) : c.valor(l));
        return no(doc, 'td', { style: c.nowrap ? 'white-space:nowrap' : null }, [principal, detalhe ? no(doc, 'div', { style: NOTA }, [detalhe]) : null]);
      }));
      if (typeof a.aposLinha === 'function') a.aposLinha(doc, tr, l);
      return tr;
    },
    alerta: function (doc, a) {
      var m = modelo.alerta(a);
      return no(doc, 'div', { class: 'switch-row', 'data-alerta': a.tipo }, [
        no(doc, 'div', { class: 'switch-text' }, [no(doc, 'strong', {}, [m.titulo]), no(doc, 'span', {}, [m.detalhe])]),
        no(doc, 'span', { class: 'badge', style: m.estilo }, [m.rotulo]),
      ]);
    },
  };

  global.EpiRelatorios = {
    fiscal: fiscal,
    acoes: acoes, modelo: modelo, render: render, TEXTOS: TEXTOS, ABAS: ABAS, STATUS: STATUS, ALERTAS: ALERTAS, LIMITE: LIMITE, LIMITE_EXPORTACAO: LIMITE_EXPORTACAO, LIMITE_PREVIA_CA: LIMITE_PREVIA_CA, DESTINO_CA_VENCIDO: DESTINO_CA_VENCIDO,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiRelatorios;
})(typeof window !== 'undefined' ? window : globalThis);
