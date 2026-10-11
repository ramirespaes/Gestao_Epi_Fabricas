(function (global) {
  'use strict';

  /**
   * EpiHistoricoFuncionarios — página Histórico de Funcionários (pacotes A+B e C).
   *
   *   A — busca única (classificar): um campo só; o tipo vem do valor e a consulta continua a de js/funcionarios.js
   *       (acoes.listar: nome ou matrícula por GET, CPF completo só no corpo do POST /funcionarios/consulta-cpf). Escolher um resultado — ou o resultado
   *       único — consulta GET /funcionarios/:id pelo id interno real. Cada busca e cada seleção têm o seu número: trocar
   *       de funcionário, limpar, nova busca ou sessão encerrada invalidam a resposta pendente da anterior.
   *   B — a identificação vem SÓ do detalhe ({ funcionario }): nome, matrícula, setor, cargo/função, GHE atual (código e
   *       descrição; sem código, só a descrição) e situação (Ativo, Afastado, Inativo). Ausente vira "—". Crachá, CPF,
   *       telefone, nascimento e admissão chegam da API mas não são exibidos aqui.
   *   C — histórico de EPIs (exige epiFicha.visualizar): id do funcionário → GET /fichas-epi?funcionarioId= → GET
   *       /fichas-epi/:fichaId/entregas, uma página por vez, na ordem do servidor. Cada entrega é um ato separado. "Sem
   *       retiradas" só com resposta válida (sem ficha, ou ficha sem entregas); corpo inválido ou ficha de outro
   *       funcionário é falha da seção, com nova tentativa, sem tocar na ficha cadastral.
   *   D — os quatro indicadores saem do `resumo` da ficha (calculado no servidor, histórico total): retiradas
   *       realizadas, EPIs distintos, última retirada (dd/mm/aaaa em São Paulo) e EPIs dentro do prazo de uso. Sem ficha
   *       = 0, 0, "—", 0; sem permissão, falha ou resposta inválida do resumo = "—"; nunca calculados das páginas.
   *   E — histórico de GHE (GET /funcionarios/:id/eventos?tipo=GHE, employeeHistory.visualizar), em cartão próprio,
   *       separado das entregas: GHE da época quando gravado; senão a identificação atual, marcada como tal.
   *   F — histórico de situação (mesmo endpoint, tipo=SITUACAO), em cartão próprio, com o mesmo comportamento do E.
   *   G — histórico de alterações cadastrais (mesmo endpoint, tipo=CADASTRAL): nome, matrícula, setor, cargo/função e
   *       data de admissão, uma linha por campo alterado; em cartão próprio, com o mesmo comportamento do E.
   *   H — período (data inicial e final, inclusivas) dos quatro históricos acima, enviado como de/ate; só depois de
   *       "Aplicar filtro". Os indicadores do D continuam do histórico completo. Continua na troca de colaborador;
   *       "Todo o histórico" e Limpar o desfazem.
   *   I — exportação em PDF ou XLSX (POST /funcionarios/:id/historico/exportacao) com o período aplicado; o controle só
   *       aparece com as duas permissões (pacote J) e o colaborador identificado; o servidor confere tudo de novo.
   *
   * Antes de um funcionário ser identificado só a pesquisa aparece: ficha, indicadores, linha do tempo e históricos de
   * GHE, de situação e cadastral ficam ocultos (Limpar, nova pesquisa, falha e sessão encerrada os ocultam de novo; CPF recusado
   * localmente não mexe na ficha aberta).
   *
   * Tudo é montado com createElement/textContent; nada vai para armazenamento do navegador.
   */

  var CAMINHO = '/funcionarios';
  var VAZIO = '—';
  var ROTULOS_SITUACAO = { ATIVO: 'Ativo', AFASTADO: 'Afastado', INATIVO: 'Inativo' };
  var CAMPOS = {
    nome: 'historyEmployeeName', matricula: 'historyEmployeeMatricula', setor: 'historySector',
    funcao: 'historyEmployeeFuncao', ghe: 'historyEmployeeGhe', situacao: 'historyEmployeeSituacao',
  };
  var INDICADORES = ['hkpiTotal', 'hkpiEpis', 'hkpiUltima', 'hkpiAtivos'];
  var LIMITE_ENTREGAS = 20;
  var LIMITE_EVENTOS = 20;
  var ROTULOS_EVENTO_GHE = { CADASTRO: 'Cadastro', IMPORTACAO: 'Importação', ALTERACAO: 'Alteração' };
  // Pacote I: os mesmos ids e extensões de FORMATOS do serviço de exportação do backend (conferido por teste).
  var FORMATOS_EXPORTACAO = [
    { id: 'pdf', extensao: 'pdf', rotulo: 'PDF' },
    { id: 'xlsx', extensao: 'xlsx', rotulo: 'Excel (XLSX)' },
  ];
  // Só estes campos aparecem no histórico cadastral; qualquer outro que chegue é ignorado.
  var ROTULOS_CAMPO_CADASTRAL = {
    nome: 'Nome', matricula: 'Matrícula', setor: 'Setor', funcao: 'Cargo / função', dataAdmissao: 'Data de admissão',
  };
  var FUSO = 'America/Sao_Paulo';
  // Os mesmos rótulos de js/entregas-epi-historico.js (origem) e js/solicitacoes-epi.js (motivo).
  var ROTULOS_ORIGEM = { DIRETA: 'Direta', SOLICITACAO: 'Por solicitação' };
  var ROTULOS_MOTIVO = {
    ADMISSAO: 'Admissão', SUBSTITUICAO_PRAZO: 'Substituição por prazo', DESGASTE_DANO: 'Desgaste ou dano',
    PERDA_EXTRAVIO: 'Perda ou extravio', OUTRO: 'Outro',
  };

  var TEXTOS = {
    NENHUM_SELECIONADO: 'Consulte um colaborador para ver o histórico.',
    CARREGANDO: 'Carregando dados do colaborador…',
    NENHUM_RESULTADO: 'Nenhum funcionário encontrado nesta empresa com esse critério.',
    RESPOSTA_INVALIDA: 'Não foi possível consultar o funcionário.',
    EPIS_CARREGANDO: 'Carregando histórico de EPIs…',
    EPIS_VAZIO: 'Nenhuma retirada de EPI registrada para este colaborador.',
    EPIS_SEM_PERMISSAO: 'Sem permissão para ver o histórico de EPIs.',
    EPIS_FALHA: 'Não foi possível carregar o histórico de EPIs.',
    TENTAR_NOVAMENTE: 'Tentar novamente',
    GHE_CARREGANDO: 'Carregando histórico de GHE…',
    GHE_VAZIO: 'Nenhuma alteração de GHE registrada para este colaborador.',
    GHE_SEM_PERMISSAO: 'Sem permissão para ver o histórico de GHE.',
    GHE_FALHA: 'Não foi possível carregar o histórico de GHE.',
    GHE_SEM_VINCULO: 'Sem GHE',
    GHE_SEM_IDENTIFICACAO: 'GHE histórico sem identificação disponível',
    GHE_IDENTIFICACAO_ATUAL: '(identificação atual)',
    SITUACAO_CARREGANDO: 'Carregando histórico de situação…',
    SITUACAO_VAZIO: 'Nenhuma alteração de situação registrada para este colaborador.',
    SITUACAO_SEM_PERMISSAO: 'Sem permissão para ver o histórico de situação.',
    SITUACAO_FALHA: 'Não foi possível carregar o histórico de situação.',
    CADASTRAL_CARREGANDO: 'Carregando histórico cadastral…',
    CADASTRAL_VAZIO: 'Nenhuma alteração cadastral registrada para este colaborador.',
    CADASTRAL_SEM_PERMISSAO: 'Sem permissão para ver o histórico cadastral.',
    CADASTRAL_FALHA: 'Não foi possível carregar o histórico cadastral.',
    EPIS_VAZIO_PERIODO: 'Nenhuma retirada de EPI registrada neste período.',
    GHE_VAZIO_PERIODO: 'Nenhuma alteração de GHE registrada neste período.',
    SITUACAO_VAZIO_PERIODO: 'Nenhuma alteração de situação registrada neste período.',
    CADASTRAL_VAZIO_PERIODO: 'Nenhuma alteração cadastral registrada neste período.',
    PERIODO_TODO: 'Todo o histórico',
    PERIODO_APLICADO: 'Período aplicado: ',
    PERIODO_INFORME_DATAS: 'Informe a data inicial e a data final.',
    PERIODO_DATA_INICIAL_INVALIDA: 'Data inicial inválida.',
    PERIODO_DATA_FINAL_INVALIDA: 'Data final inválida.',
    PERIODO_INVERTIDO: 'A data final precisa ser igual ou posterior à data inicial.',
    EXPORT_GERANDO: 'Gerando o arquivo…',
    EXPORT_CONCLUIDO: 'Arquivo gerado. O download foi iniciado.',
    EXPORT_SEM_PERMISSAO: 'Sem permissão para exportar o histórico deste colaborador.',
    EXPORT_PERIODO: 'Não foi possível gerar a exportação: confira o período aplicado.',
    EXPORT_GRANDE: 'O histórico tem registros demais para um arquivo. Aplique um período menor e tente de novo.',
    EXPORT_LIMITE: 'Muitas exportações em pouco tempo. Aguarde um minuto e tente de novo.',
    EXPORT_FALHA: 'Não foi possível gerar a exportação. Tente novamente.',
    CPF_INVALIDO: 'CPF inválido. Confira os 11 dígitos.',
    CPF_INCOMPLETO: 'CPF incompleto. Digite os 11 dígitos do CPF.',
  };

  // Início reconhecível da máscara 000.000.000-00 (ponto ou espaço entre os grupos), ainda sem os 11 dígitos.
  var PREFIXO_MASCARA_CPF = /^\d{3}[.\s](\d{1,3}([.\s](\d{1,3}([-\s]\d{0,2})?)?)?)?$/;

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/historico-funcionarios.js');
    return global.EpiHttp;
  }
  function funcionarios() {
    if (!global.EpiFuncionarios) throw new Error('EpiFuncionarios não carregado: inclua js/funcionarios.js antes de js/historico-funcionarios.js');
    return global.EpiFuncionarios;
  }
  function texto(v) { return v === null || v === undefined ? '' : String(v); }
  function ouVazio(v) { var t = texto(v).trim(); return t === '' ? VAZIO : t; }

  // Nome do arquivo do Content-Disposition, reduzido a letras, números, ponto, hífen e sublinhado (nunca caminho).
  function nomeDoAnexo(cabecalho, formato) {
    var m = /filename="([^"]*)"/.exec(texto(cabecalho));
    var nome = (m ? m[1] : '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.').replace(/^\.+/, '');
    var extensao = FORMATOS_EXPORTACAO.filter(function (f) { return f.id === formato; }).map(function (f) { return f.extensao; })[0] || 'arquivo';
    return nome || 'historico-funcionario.' + extensao;
  }

  // ─── Período (pacote H) ────────────────────────────────────────────
  // `de` e `ate` são os nomes que o servidor já usa nas entregas da ficha; as datas vão como foram digitadas.
  function parametrosPeriodo(periodo) {
    if (!periodo) return '';
    return '&de=' + encodeURIComponent(periodo.de) + '&ate=' + encodeURIComponent(periodo.ate);
  }
  /** 'AAAA-MM-DD' de um dia que existe no calendário (sem passar por fuso). */
  function dataValida(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto(v));
    if (!m) return false;
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  }
  /** A tela só aplica período fechado: as duas datas, válidas e em ordem. { ok, periodo } ou { ok: false, mensagem }. */
  function validarPeriodo(inicial, final) {
    var i = texto(inicial).trim();
    var f = texto(final).trim();
    if (i === '' || f === '') return { ok: false, mensagem: TEXTOS.PERIODO_INFORME_DATAS };
    if (!dataValida(i)) return { ok: false, mensagem: TEXTOS.PERIODO_DATA_INICIAL_INVALIDA };
    if (!dataValida(f)) return { ok: false, mensagem: TEXTOS.PERIODO_DATA_FINAL_INVALIDA };
    if (i > f) return { ok: false, mensagem: TEXTOS.PERIODO_INVERTIDO };
    return { ok: true, periodo: { de: i, ate: f } };
  }

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    /** Ficha cadastral pelo id interno real; a empresa é a da sessão (404 igual para inexistente e de outra empresa). */
    detalhar: function (id) {
      return http().requisitar('GET', CAMINHO + '/' + encodeURIComponent(id));
    },
    /** A ficha de EPI do funcionário (uma por funcionário na empresa), pelo id interno — nunca por nome ou matrícula. */
    fichaDoFuncionario: function (funcionarioId) {
      return http().requisitar('GET', '/fichas-epi?funcionarioId=' + encodeURIComponent(funcionarioId) + '&pagina=1&limite=1');
    },
    /**
     * Uma página dos eventos do funcionário de um tipo (GHE, SITUACAO ou CADASTRAL; auditoria montada campo a campo no
     * servidor). `periodo` { de, ate } (YYYY-MM-DD, dias de São Paulo) é opcional; sem ele, todo o histórico.
     */
    eventos: function (funcionarioId, tipo, pagina, periodo) {
      return http().requisitar('GET', CAMINHO + '/' + encodeURIComponent(funcionarioId) + '/eventos?tipo=' + encodeURIComponent(tipo)
        + parametrosPeriodo(periodo) + '&pagina=' + encodeURIComponent(pagina) + '&limite=' + LIMITE_EVENTOS);
    },
    eventosGhe: function (funcionarioId, pagina) { return acoes.eventos(funcionarioId, 'GHE', pagina); },
    /**
     * Pacote I: pede o arquivo (PDF ou XLSX) ao servidor, que confere as permissões, o período e gera o documento.
     * Resposta binária: não passa pelo EpiHttp.requisitar (JSON). Nunca lança: { ok: true, blob, nomeArquivo } ou
     * { ok: false, status, codigo } (status 0 = falha de rede).
     */
    exportar: async function (funcionarioId, opcoes) {
      var corpo = { formato: opcoes.formato };
      if (opcoes.de && opcoes.ate) { corpo.de = opcoes.de; corpo.ate = opcoes.ate; }
      var resposta;
      try {
        resposta = await global.fetch(http().configurar({}).baseUrl + CAMINHO + '/' + encodeURIComponent(funcionarioId) + '/historico/exportacao', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
        });
      } catch (e) {
        return { ok: false, status: 0, codigo: null };
      }
      if (!resposta.ok) {
        var codigo = null;
        try { var erro = JSON.parse(await resposta.text()); codigo = erro && typeof erro.codigo === 'string' ? erro.codigo : null; } catch (e) { codigo = null; }
        return { ok: false, status: resposta.status, codigo: codigo };
      }
      try {
        var blob = await resposta.blob();
        return { ok: true, blob: blob, nomeArquivo: nomeDoAnexo(resposta.headers && resposta.headers.get('content-disposition'), opcoes.formato) };
      } catch (e) {
        return { ok: false, status: 0, codigo: null };
      }
    },
    /** Entrega o arquivo ao navegador (âncora temporária com download) e libera a URL do blob. */
    salvarArquivo: function (doc, blob, nome) {
      var url = global.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url;
      a.download = nome;
      a.rel = 'noopener';
      if (doc.body) doc.body.appendChild(a);
      a.click();
      if (typeof a.remove === 'function') a.remove();
      global.URL.revokeObjectURL(url);
    },
    /** Uma página das entregas da ficha (entregue_em DESC, id DESC no servidor); o período filtra pelo dia operacional. */
    entregasDaFicha: function (fichaId, pagina, periodo) {
      var p = parametrosPeriodo(periodo);
      return http().requisitar('GET', '/fichas-epi/' + encodeURIComponent(fichaId) + '/entregas?' + (p ? p.slice(1) + '&' : '')
        + 'pagina=' + encodeURIComponent(pagina) + '&limite=' + LIMITE_ENTREGAS);
    },
  };

  // ─── Busca única ───────────────────────────────────────────────────
  /**
   * Reconhece o tipo pelo valor e devolve o mesmo formato de EpiFuncionarios.historico.consulta ({ ok, filtro } ou
   * { ok: false, mensagem }), cujas validações reaproveita. CPF só sai como { cpf } (POST, corpo); o que parece CPF e
   * não é válido ou está incompleto é recusado aqui, sem requisição, para nunca chegar à URL. Sem fallback para matrícula:
   * matrícula só numérica de 11 dígitos não é buscável pelo número inteiro.
   */
  function classificar(valor) {
    var F = funcionarios();
    var t = texto(valor).trim();
    var digitos = t.replace(/\D/g, '');
    if (/^[\d.\-\s]+$/.test(t)) {
      if (digitos.length === 11) {
        var c = F.historico.consulta('cpf', digitos);
        return c.ok ? c : { ok: false, mensagem: TEXTOS.CPF_INVALIDO };
      }
      if (PREFIXO_MASCARA_CPF.test(t)) return { ok: false, mensagem: TEXTOS.CPF_INCOMPLETO };
    } else if (!/\s/.test(t) && /[A-Za-z]/.test(t) && digitos.length === 11) {
      return { ok: false, mensagem: TEXTOS.CPF_INVALIDO }; // 11 dígitos misturados com letras
    }
    return F.historico.consulta('nome', t);
  }

  // ─── Modelo ────────────────────────────────────────────────────────
  var modelo = {
    situacao: function (f) {
      if (f && ROTULOS_SITUACAO[f.situacao]) return ROTULOS_SITUACAO[f.situacao];
      if (f && f.ativo === true) return 'Ativo';
      if (f && f.ativo === false) return 'Inativo';
      return VAZIO;
    },
    ghe: function (g) {
      if (!g) return VAZIO;
      var codigo = texto(g.codigo).trim();
      var descricao = texto(g.descricao).trim();
      if (codigo && descricao) return codigo + ' — ' + descricao;
      return codigo || descricao || VAZIO;
    },
    /** Os seis campos da identificação, só do detalhe. Nada além deles. */
    ficha: function (f) {
      return {
        nome: ouVazio(f.nome), matricula: ouVazio(f.matricula), setor: ouVazio(f.setor), funcao: ouVazio(f.funcao),
        ghe: modelo.ghe(f.grupoHomogeneo), situacao: modelo.situacao(f),
      };
    },
    /** 'AAAA-MM-DD' → 'DD/MM/AAAA'; qualquer outra coisa → ''. */
    data: function (iso) {
      var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto(iso));
      return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
    },
    /** Dia e hora de um instante em São Paulo (o fuso da data operacional). */
    instante: function (valor) {
      var d = new Date(texto(valor));
      if (texto(valor) === '' || isNaN(d.getTime())) return { data: '', hora: '' };
      try {
        var partes = {};
        new Intl.DateTimeFormat('pt-BR', {
          timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(d).forEach(function (p) { partes[p.type] = p.value; });
        return { data: partes.day + '/' + partes.month + '/' + partes.year, hora: partes.hour + ':' + partes.minute };
      } catch (e) {
        return { data: '', hora: '' };
      }
    },
    entrega: function (e) {
      var quando = modelo.instante(e.entregueEm);
      return {
        data: modelo.data(e.dataOperacional) || quando.data || VAZIO,
        hora: quando.hora,
        origem: ROTULOS_ORIGEM[e.origem] || ouVazio(e.origem),
        responsavel: ouVazio(e.responsavel && e.responsavel.nome),
        ghe: e.ghe && texto(e.ghe.nome).trim() ? texto(e.ghe.nome).trim() : '',
      };
    },
    /** Os quatro cards, na ordem de INDICADORES; campo ausente ou inválido vira "—" só naquele card, nunca zero. */
    indicadores: function (r) {
      if (!r || typeof r !== 'object') return [VAZIO, VAZIO, VAZIO, VAZIO];
      var contagem = function (v) { return Number.isInteger(v) && v >= 0 ? String(v) : VAZIO; };
      var ultima = typeof r.ultimaEntregaEm === 'string' ? modelo.instante(r.ultimaEntregaEm).data : '';
      return [contagem(r.totalEntregas), contagem(r.episDistintos), ultima || VAZIO, contagem(r.episDentroPrazoUso)];
    },
    /**
     * Texto de um GHE do histórico: o registrado na época (código e descrição); se o evento só gravou o id, a
     * identificação ATUAL com o aviso "(identificação atual)"; sem nenhuma, que não há identificação. Nunca o id interno.
     */
    gheEvento: function (g) {
      if (g === null || g === undefined) return TEXTOS.GHE_SEM_VINCULO;
      var historico = modelo.ghe({ codigo: g.codigo, descricao: g.descricao });
      if (historico !== VAZIO) return historico;
      var atual = g.atual ? modelo.ghe({ codigo: g.atual.codigo, descricao: g.atual.descricao }) : VAZIO;
      return atual !== VAZIO ? atual + ' ' + TEXTOS.GHE_IDENTIFICACAO_ATUAL : TEXTOS.GHE_SEM_IDENTIFICACAO;
    },
    eventoGhe: function (e) {
      var quando = modelo.instante(e.ocorridoEm);
      return {
        data: quando.data || VAZIO,
        hora: quando.hora,
        tipo: ROTULOS_EVENTO_GHE[e.tipo] || VAZIO,
        inicial: e.tipo === 'CADASTRO' || e.tipo === 'IMPORTACAO',
        anterior: modelo.gheEvento(e.anterior),
        novo: modelo.gheEvento(e.novo),
        responsavel: ouVazio(e.responsavel && e.responsavel.nome),
      };
    },
    /** Evento de situação: códigos ATIVO/AFASTADO/INATIVO com os rótulos da ficha; desconhecido ou ausente vira "—". */
    eventoSituacao: function (e) {
      var quando = modelo.instante(e.ocorridoEm);
      var rotulo = function (s) { return Object.prototype.hasOwnProperty.call(ROTULOS_SITUACAO, s) ? ROTULOS_SITUACAO[s] : VAZIO; };
      return {
        data: quando.data || VAZIO,
        hora: quando.hora,
        tipo: ROTULOS_EVENTO_GHE[e.tipo] || VAZIO,
        inicial: e.tipo === 'CADASTRO' || e.tipo === 'IMPORTACAO',
        anterior: rotulo(e.anterior),
        novo: rotulo(e.novo),
        responsavel: ouVazio(e.responsavel && e.responsavel.nome),
      };
    },
    /**
     * Evento cadastral: uma linha por campo conhecido, na ordem do servidor. Data de admissão YYYY-MM-DD vira dd/mm/aaaa
     * sem passar por Date (sem fuso); fora do formato ou nula, "—".
     */
    eventoCadastral: function (e) {
      var quando = modelo.instante(e.ocorridoEm);
      var valor = function (campo, v) { return campo === 'dataAdmissao' ? (modelo.data(v) || VAZIO) : ouVazio(v); };
      var alteracoes = (Array.isArray(e.alteracoes) ? e.alteracoes : []).filter(function (a) {
        return a && Object.prototype.hasOwnProperty.call(ROTULOS_CAMPO_CADASTRAL, a.campo);
      }).map(function (a) {
        return { rotulo: ROTULOS_CAMPO_CADASTRAL[a.campo], anterior: valor(a.campo, a.anterior), novo: valor(a.campo, a.novo) };
      });
      return {
        data: quando.data || VAZIO,
        hora: quando.hora,
        tipo: ROTULOS_EVENTO_GHE[e.tipo] || VAZIO,
        inicial: e.tipo === 'CADASTRO' || e.tipo === 'IMPORTACAO',
        alteracoes: alteracoes,
        responsavel: ouVazio(e.responsavel && e.responsavel.nome),
      };
    },
    /** Validade do CA (do lote) e prazo de uso (do material, em dias) são grandezas diferentes e saem separadas. */
    item: function (i) {
      var m = i.material || {};
      var l = i.lote || {};
      var unidade = texto(m.unidade).trim();
      var prazo = Number(m.prazoUsoDias);
      return {
        material: ouVazio(m.nome),
        codigo: ouVazio(m.codigoInterno),
        quantidade: ouVazio(i.quantidade) + (unidade ? ' ' + unidade : ''),
        tamanho: ouVazio(l.tamanho),
        ca: ouVazio(l.caNumero),
        validadeCa: modelo.data(l.caValidade) || VAZIO,
        prazoUso: Number.isInteger(prazo) && prazo > 0 ? prazo + (prazo === 1 ? ' dia' : ' dias') : VAZIO,
        motivo: ROTULOS_MOTIVO[i.motivo] || ouVazio(i.motivo),
        justificativa: texto(i.justificativa).trim(),
      };
    },
  };

  // ─── Aviso (mesmo visual do aviso da página) ──────────────────────
  function mostrarAviso(doc, mensagem, tipo) {
    var caixa = doc.getElementById('aviso');
    if (!caixa) return;
    caixa.replaceChildren();
    if (!mensagem) { caixa.style.display = 'none'; return; }
    var nota = doc.createElement('div');
    nota.className = 'notice';
    nota.setAttribute('style', tipo === 'erro'
      ? 'background:var(--error-container);color:var(--error);border-color:rgba(255,59,48,0.2)'
      : 'background:rgba(255,149,0,0.08);color:#C07000;border-color:rgba(255,149,0,0.25)');
    nota.textContent = mensagem;
    caixa.appendChild(nota);
    caixa.style.display = 'block';
  }

  // ─── Tela ──────────────────────────────────────────────────────────
  function criarTela(opcoes) {
    var o = opcoes || {};
    var doc = o.documento || global.document;
    var $ = function (id) { return doc.getElementById(id); };
    var F = funcionarios();

    var encerrada = false;
    var buscaAtual = 0;    // só a busca mais recente toca a tela
    var selecaoAtual = 0;  // só a seleção mais recente toca a ficha
    var episAtual = 0;     // só a carga mais recente (ficha, página ou nova tentativa) toca a área de EPIs
    var epi = null;        // { funcionarioId, fichaId, pagina, periodo } do funcionário exibido
    var ultimaLista = [];
    var podeVerEpis = o.podeVerEpis === true;
    // Período APLICADO ({ de, ate } ou null = todo o histórico). As datas digitadas só contam em "Aplicar filtro". Continua
    // na troca de colaborador; Limpar e o fim da sessão o desfazem.
    var periodoAplicado = null;
    var colaboradorId = null; // funcionário identificado pelo detalhe, alvo do período
    // Pacote I: as DUAS permissões efetivas (visualizar E exportar) só mostram o controle; quem decide é o servidor.
    var podeExportar = o.podeExportar === true;
    var exportacaoAtual = 0; // a resposta de uma exportação antiga (outro colaborador, Limpar, sessão) não baixa nada
    var exportando = false;

    function no(tag, atributos, filhos) {
      var e = doc.createElement(tag);
      Object.keys(atributos || {}).forEach(function (k) {
        if (k === 'class') e.className = atributos[k];
        else e.setAttribute(k, atributos[k]);
      });
      (filhos || []).forEach(function (f) { e.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f); });
      return e;
    }
    function aviso(mensagem, tipo) { mostrarAviso(doc, mensagem, tipo); }
    function estadoFicha(mensagem) { var e = $('historyFichaEstado'); if (e) e.textContent = mensagem || ''; }
    function linhaDoTempo(mensagem) {
      var t = $('historyTimeline');
      if (!t) return;
      t.replaceChildren(no('div', { class: 'helper' }, [mensagem]));
    }
    function preencherCampos(valores) {
      Object.keys(CAMPOS).forEach(function (k) { var e = $(CAMPOS[k]); if (e) e.value = valores ? valores[k] : ''; });
    }
    // Ficha, indicadores e linha do tempo só ficam à vista com um funcionário identificado pelo detalhe real.
    // Os três contêineres são os da página (achados pelos ids que contêm); '' devolve o display ao CSS.
    function exibirColaborador(sim) {
      [['historyEmployeeName', '.form-grid'], ['hkpiTotal', '.history-summary'], ['historyTimeline', '.card'], ['historyGheTimeline', '.card'],
        ['historySituacaoTimeline', '.card'], ['historyCadastralTimeline', '.card'], ['historyPeriodoInicial', '.card']].forEach(function (p) {
        var e = $(p[0]);
        var c = e && e.closest(p[1]);
        if (c) c.style.display = sim ? '' : 'none';
      });
      var cartao = $('historyExportCartao');
      if (cartao) cartao.style.display = sim && podeExportar ? '' : 'none';
      atualizarBotaoExportar();
    }
    function atualizarBotaoExportar() {
      var b = $('botaoExportarHistorico');
      if (b) b.disabled = !podeExportar || colaboradorId === null || exportando || encerrada;
    }
    function estadoExportacao(mensagem) { var e = $('historyExportEstado'); if (e) e.textContent = mensagem || ''; }
    function invalidarExportacao() {
      exportacaoAtual += 1;
      exportando = false;
      estadoExportacao('');
    }
    function mostrarIndicadores(valores) {
      INDICADORES.forEach(function (id, k) { var e = $(id); if (e) e.textContent = valores ? valores[k] : VAZIO; });
    }
    function limparColaborador() {
      episAtual += 1;
      epi = null;
      colaboradorId = null;
      invalidarExportacao();
      secaoGhe.limpar();
      secaoSituacao.limpar();
      secaoCadastral.limpar();
      exibirColaborador(false);
      preencherCampos(null);
      mostrarIndicadores(null);
      estadoFicha('');
      linhaDoTempo(TEXTOS.NENHUM_SELECIONADO);
    }
    function limparResultados() {
      ultimaLista = [];
      var r = $('historyResultados');
      if (!r) return;
      r.replaceChildren();
      r.style.display = 'none';
    }
    function sessaoCaiu() {
      encerrar();
      if (typeof o.aoSessaoEncerrada === 'function') o.aoSessaoEncerrada();
    }

    // ── A: seleção pelo id interno
    async function selecionar(id) {
      if (encerrada) return;
      var minha = ++selecaoAtual;
      episAtual += 1;
      epi = null;
      colaboradorId = null;
      invalidarExportacao();
      secaoGhe.invalidar();
      secaoSituacao.invalidar();
      secaoCadastral.invalidar();
      aviso('', null);
      exibirColaborador(false);
      preencherCampos(null);
      mostrarIndicadores(null);
      estadoFicha(TEXTOS.CARREGANDO);
      linhaDoTempo(TEXTOS.CARREGANDO);
      var r = await acoes.detalhar(id);
      if (encerrada || minha !== selecaoAtual) return; // resposta de uma seleção antiga: descartada
      var f = r && r.ok && r.dados ? r.dados.funcionario : null;
      if (f && String(f.id) === String(id)) {
        preencherCampos(modelo.ficha(f));
        estadoFicha('');
        colaboradorId = f.id;
        exibirColaborador(true);
        // employeeHistory.visualizar basta; independentes da área de EPIs
        secaoGhe.carregar(f.id);
        secaoSituacao.carregar(f.id);
        secaoCadastral.carregar(f.id);
        if (!podeVerEpis) { linhaDoTempo(TEXTOS.EPIS_SEM_PERMISSAO); return; }
        // Sem await: a seleção termina com a ficha cadastral; a área de EPIs carrega por conta própria.
        carregarEpis(f.id);
        return;
      }
      limparColaborador();
      if (r && F.mensagens.exigeNovoLogin(r)) { sessaoCaiu(); return; }
      aviso(r && !r.ok ? F.mensagens.erroConsulta(r) : TEXTOS.RESPOSTA_INVALIDA, 'erro');
    }

    // ── C: histórico de EPIs. Toda carga recebe um número; a que não é mais a atual (outro funcionário, outra página,
    //    Limpar, nova busca, sessão encerrada) é descartada sem tocar em nada.
    function episObsoleta(minha) { return encerrada || minha !== episAtual; }

    async function carregarEpis(funcionarioId) {
      var minha = ++episAtual;
      epi = { funcionarioId: funcionarioId, fichaId: null, pagina: 1, periodo: periodoAplicado };
      linhaDoTempo(TEXTOS.EPIS_CARREGANDO);
      var r = await acoes.fichaDoFuncionario(funcionarioId);
      if (episObsoleta(minha)) return;
      if (!r || !r.ok) { falhaEpis(r); return; }
      var fichas = r.dados && Array.isArray(r.dados.fichas) ? r.dados.fichas : null;
      if (!fichas) { falhaEpis(null); return; }
      if (fichas.length === 0) { // sem ficha = nenhuma entrega registrada
        mostrarIndicadores(['0', '0', VAZIO, '0']);
        linhaDoTempo(TEXTOS.EPIS_VAZIO);
        return;
      }
      var ficha = fichas.filter(function (x) { return x && x.id !== null && x.id !== undefined && String(x.funcionarioId) === String(funcionarioId); })[0];
      if (!ficha) { falhaEpis(null); return; } // ficha de outro funcionário: nada dela é usado nem mostrado
      epi.fichaId = ficha.id;
      mostrarIndicadores(modelo.indicadores(ficha.resumo));
      await carregarPagina(1, minha);
    }

    async function carregarPagina(pagina, minha) {
      var fichaId = epi.fichaId;
      var funcionarioId = epi.funcionarioId;
      var periodo = epi.periodo;
      epi.pagina = pagina;
      linhaDoTempo(TEXTOS.EPIS_CARREGANDO);
      var r = await acoes.entregasDaFicha(fichaId, pagina, periodo);
      if (episObsoleta(minha)) return;
      if (!r || !r.ok) { falhaEpis(r); return; }
      var d = r.dados;
      var valida = d && Array.isArray(d.entregas) && Number.isInteger(d.total) && d.total >= 0
        && d.ficha && String(d.ficha.id) === String(fichaId) && String(d.ficha.funcionarioId) === String(funcionarioId);
      if (!valida) { falhaEpis(null); return; }
      if (d.entregas.length === 0) {
        if (d.total === 0) linhaDoTempo(periodo ? TEXTOS.EPIS_VAZIO_PERIODO : TEXTOS.EPIS_VAZIO);
        else falhaEpis(null);
        return;
      }
      var limite = Number.isInteger(d.limite) && d.limite > 0 ? d.limite : LIMITE_ENTREGAS;
      mostrarEntregas(d.entregas, pagina, Math.max(1, Math.ceil(d.total / limite)));
    }

    function irParaPagina(pagina) {
      if (encerrada || !epi || epi.fichaId === null) return undefined;
      return carregarPagina(pagina, ++episAtual);
    }

    function tentarDeNovo() {
      if (encerrada || !epi) return undefined;
      // Só o que falhou: a página, se a ficha já é conhecida; senão a ficha. A ficha cadastral não é relida.
      if (epi.fichaId !== null) return carregarPagina(epi.pagina, ++episAtual);
      return carregarEpis(epi.funcionarioId);
    }

    function falhaEpis(r) {
      if (r && F.mensagens.exigeNovoLogin(r)) { sessaoCaiu(); return; }
      if (r && r.status === 403) { linhaDoTempo(TEXTOS.EPIS_SEM_PERMISSAO); return; }
      var botao = no('button', { id: 'historyEpisTentar', class: 'outlined-btn', type: 'button' }, [TEXTOS.TENTAR_NOVAMENTE]);
      botao.addEventListener('click', tentarDeNovo);
      $('historyTimeline').replaceChildren(
        no('div', { class: 'helper', role: 'alert' }, [TEXTOS.EPIS_FALHA]),
        no('div', {}, [botao])
      );
    }

    function linhaItem(i) {
      var v = modelo.item(i);
      var linhas = [
        no('strong', {}, [v.material]),
        no('span', {}, ['Código: ' + v.codigo + ' · Quantidade: ' + v.quantidade + ' · Tamanho: ' + v.tamanho]),
        no('span', {}, ['CA: ' + v.ca + ' · Validade do CA: ' + v.validadeCa + ' · Prazo de uso: ' + v.prazoUso]),
        no('span', {}, ['Motivo: ' + v.motivo]),
      ];
      if (v.justificativa) linhas.push(no('span', {}, ['Justificativa: ' + v.justificativa]));
      return no('div', { 'data-item-id': texto(i.id), style: 'margin-top:10px' }, separados(linhas));
    }

    // Um espaço entre as linhas: o texto do bloco (leitor de tela, copiar) não emenda "42" com "CA".
    function separados(nos) {
      var r = [];
      nos.forEach(function (n, k) { if (k > 0) r.push(' '); r.push(n); });
      return r;
    }

    function blocoEntrega(e) {
      var v = modelo.entrega(e);
      var cabecalho = [no('strong', {}, ['Entrega — ' + v.origem])];
      cabecalho.push(no('span', {}, ['Responsável: ' + v.responsavel]));
      if (v.ghe) cabecalho.push(no('span', {}, ['GHE na entrega: ' + v.ghe]));
      var itens = Array.isArray(e.itens) ? e.itens.map(linhaItem) : [];
      return no('div', { class: 'timeline-item', 'data-entrega-id': texto(e.id) }, [
        no('div', { class: 'timeline-date' }, v.hora ? [v.data, no('br'), ' ', v.hora] : [v.data]),
        ' ',
        no('div', { class: 'timeline-content' }, separados(cabecalho.concat(itens))),
      ]);
    }

    function paginacao(pagina, paginas) {
      var anterior = no('button', { id: 'historyEpisAnterior', class: 'outlined-btn', type: 'button' }, ['Anterior']);
      var proxima = no('button', { id: 'historyEpisProxima', class: 'outlined-btn', type: 'button' }, ['Próxima']);
      anterior.disabled = pagina <= 1;
      proxima.disabled = pagina >= paginas;
      anterior.addEventListener('click', function () { return irParaPagina(pagina - 1); });
      proxima.addEventListener('click', function () { return irParaPagina(pagina + 1); });
      return no('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:10px' }, [
        anterior, no('span', { id: 'historyEpisPagina', class: 'helper' }, ['Página ' + pagina + ' de ' + paginas]), proxima,
      ]);
    }

    // ── E, F e G: históricos de eventos (GHE, situação e cadastro), cada um no seu cartão e com o mesmo comportamento. Mesmo desenho do
    //    C: cada carga tem número; a que não é a atual (outro funcionário, outra página, Limpar, nova busca, sessão
    //    encerrada) é descartada sem tocar em nada. `cfg.prefixo` dá os ids (Timeline, Anterior, Proxima, Pagina, Tentar).
    //    H: cada carga guarda o período com que foi pedida; paginação e nova tentativa repetem esse mesmo período.
    function criarSecaoEventos(cfg) {
      var atual = 0;
      var estado = null; // { funcionarioId, pagina, periodo } do funcionário exibido
      function area(nos) { var a = $(cfg.prefixo + 'Timeline'); if (a) a.replaceChildren.apply(a, nos); }
      function obsoleta(minha) { return encerrada || minha !== atual; }

      async function carregar(funcionarioId, pagina, periodo) {
        var minha = ++atual;
        estado = { funcionarioId: funcionarioId, pagina: pagina, periodo: periodo };
        area([no('div', { class: 'helper' }, [cfg.textos.carregando])]);
        var r = await acoes.eventos(funcionarioId, cfg.tipo, pagina, periodo);
        if (obsoleta(minha)) return;
        if (!r || !r.ok) { falha(r); return; }
        var d = r.dados;
        var valida = d && Array.isArray(d.eventos) && Number.isInteger(d.total) && d.total >= 0
          && String(d.funcionarioId) === String(funcionarioId);
        if (!valida) { falha(null); return; }
        if (d.eventos.length === 0) {
          if (d.total === 0) area([no('div', { class: 'helper' }, [periodo ? cfg.textos.vazioPeriodo : cfg.textos.vazio])]);
          else falha(null);
          return;
        }
        var limite = Number.isInteger(d.limite) && d.limite > 0 ? d.limite : LIMITE_EVENTOS;
        var paginas = Math.max(1, Math.ceil(d.total / limite));
        var nos = d.eventos.map(bloco);
        if (paginas > 1) nos.push(paginacaoEventos(pagina, paginas));
        area(nos);
      }

      function falha(r) {
        if (r && F.mensagens.exigeNovoLogin(r)) { sessaoCaiu(); return; }
        if (r && r.status === 403) { area([no('div', { class: 'helper' }, [cfg.textos.semPermissao])]); return; }
        var botao = no('button', { id: cfg.prefixo + 'Tentar', class: 'outlined-btn', type: 'button' }, [TEXTOS.TENTAR_NOVAMENTE]);
        botao.addEventListener('click', function () {
          if (encerrada || !estado) return undefined;
          return carregar(estado.funcionarioId, estado.pagina, estado.periodo); // só os eventos; a ficha não é relida
        });
        area([no('div', { class: 'helper', role: 'alert' }, [cfg.textos.falha]), no('div', {}, [botao])]);
      }

      function bloco(e) {
        var v = cfg.modelo(e);
        var linhas = [no('strong', {}, [v.tipo])]
          .concat(cfg.linhas(v).map(function (l) { return no('span', {}, [l]); }))
          .concat([no('span', {}, ['Responsável: ' + v.responsavel])]);
        return no('div', { class: 'timeline-item', 'data-evento-id': texto(e.id) }, [
          no('div', { class: 'timeline-date' }, v.hora ? [v.data, no('br'), ' ', v.hora] : [v.data]),
          ' ',
          no('div', { class: 'timeline-content' }, separados(linhas)),
        ]);
      }

      function paginacaoEventos(pagina, paginas) {
        var anterior = no('button', { id: cfg.prefixo + 'Anterior', class: 'outlined-btn', type: 'button' }, ['Anterior']);
        var proxima = no('button', { id: cfg.prefixo + 'Proxima', class: 'outlined-btn', type: 'button' }, ['Próxima']);
        anterior.disabled = pagina <= 1;
        proxima.disabled = pagina >= paginas;
        var ir = function (p) { return function () { if (encerrada || !estado) return undefined; return carregar(estado.funcionarioId, p, estado.periodo); }; };
        anterior.addEventListener('click', ir(pagina - 1));
        proxima.addEventListener('click', ir(pagina + 1));
        return no('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:10px' }, [
          anterior, no('span', { id: cfg.prefixo + 'Pagina', class: 'helper' }, ['Página ' + pagina + ' de ' + paginas]), proxima,
        ]);
      }

      return {
        carregar: function (funcionarioId) { return carregar(funcionarioId, 1, periodoAplicado); },
        invalidar: function () { atual += 1; estado = null; },
        limpar: function () { atual += 1; estado = null; area([]); },
      };
    }

    var secaoGhe = criarSecaoEventos({
      tipo: 'GHE',
      prefixo: 'historyGhe',
      textos: {
        carregando: TEXTOS.GHE_CARREGANDO, vazio: TEXTOS.GHE_VAZIO, vazioPeriodo: TEXTOS.GHE_VAZIO_PERIODO, semPermissao: TEXTOS.GHE_SEM_PERMISSAO, falha: TEXTOS.GHE_FALHA,
      },
      modelo: modelo.eventoGhe,
      linhas: function (v) { return v.inicial ? ['GHE inicial: ' + v.novo] : ['GHE anterior: ' + v.anterior, 'GHE novo: ' + v.novo]; },
    });
    var secaoSituacao = criarSecaoEventos({
      tipo: 'SITUACAO',
      prefixo: 'historySituacao',
      textos: {
        carregando: TEXTOS.SITUACAO_CARREGANDO, vazio: TEXTOS.SITUACAO_VAZIO, vazioPeriodo: TEXTOS.SITUACAO_VAZIO_PERIODO, semPermissao: TEXTOS.SITUACAO_SEM_PERMISSAO, falha: TEXTOS.SITUACAO_FALHA,
      },
      modelo: modelo.eventoSituacao,
      linhas: function (v) { return v.inicial ? ['Situação inicial: ' + v.novo] : ['Situação anterior: ' + v.anterior, 'Situação nova: ' + v.novo]; },
    });
    var secaoCadastral = criarSecaoEventos({
      tipo: 'CADASTRAL',
      prefixo: 'historyCadastral',
      textos: {
        carregando: TEXTOS.CADASTRAL_CARREGANDO, vazio: TEXTOS.CADASTRAL_VAZIO, vazioPeriodo: TEXTOS.CADASTRAL_VAZIO_PERIODO, semPermissao: TEXTOS.CADASTRAL_SEM_PERMISSAO, falha: TEXTOS.CADASTRAL_FALHA,
      },
      modelo: modelo.eventoCadastral,
      linhas: function (v) {
        return v.alteracoes.map(function (a) { return a.rotulo + ': ' + (v.inicial ? a.novo : a.anterior + ' → ' + a.novo); });
      },
    });

    function mostrarEntregas(entregas, pagina, paginas) {
      var nos = entregas.map(blocoEntrega);
      if (paginas > 1) nos.push(paginacao(pagina, paginas));
      $('historyTimeline').replaceChildren.apply($('historyTimeline'), nos);
    }

    function linhaResultado(f) {
      var botao = no('button', { class: 'outlined-btn', type: 'button', 'data-id': texto(f.id) }, ['Selecionar']);
      botao.addEventListener('click', function () { selecionar(f.id); });
      return no('tr', {}, [
        no('td', {}, [no('strong', {}, [texto(f.nome)])]),
        no('td', {}, [ouVazio(f.matricula)]),
        no('td', {}, [ouVazio(f.setor)]),
        no('td', {}, [modelo.situacao(f)]),
        no('td', {}, [botao]),
      ]);
    }
    function mostrarResultados(lista, total) {
      var r = $('historyResultados');
      ultimaLista = lista;
      r.replaceChildren();
      if (total > lista.length) {
        r.appendChild(no('div', { class: 'helper', style: 'margin-bottom:8px' }, ['Mostrando ' + lista.length + ' de ' + total + ' resultados. Refine a busca para encontrar o colaborador.']));
      }
      var cabeca = no('tr', {}, ['Funcionário', 'Matrícula', 'Setor', 'Situação', ''].map(function (t) { return no('th', {}, [t]); }));
      r.appendChild(no('div', { class: 'table-wrap' }, [no('table', {}, [no('thead', {}, [cabeca]), no('tbody', {}, lista.map(linhaResultado))])]));
      r.style.display = 'block';
    }

    async function consultar() {
      if (encerrada) return;
      var c = classificar($('historySearchValue').value);
      if (!c.ok) { aviso(c.mensagem, 'erro'); return; }
      aviso('', null);
      var minha = ++buscaAtual;
      selecaoAtual += 1; // uma busca nova invalida a seleção pendente
      limparColaborador();
      limparResultados();
      var r = await F.acoes.listar(c.filtro);
      if (encerrada || minha !== buscaAtual) return; // resposta antiga: descartada
      if (!r.ok) {
        if (F.mensagens.exigeNovoLogin(r)) { sessaoCaiu(); return; }
        aviso(F.mensagens.erroConsulta(r), 'erro');
        return;
      }
      var lista = (r.dados && Array.isArray(r.dados.funcionarios)) ? r.dados.funcionarios : [];
      var total = (r.dados && typeof r.dados.total === 'number') ? r.dados.total : lista.length;
      if (lista.length === 0) { aviso(TEXTOS.NENHUM_RESULTADO, 'atencao'); return; }
      if (lista.length === 1) { await selecionar(lista[0].id); return; }
      mostrarResultados(lista, total);
    }

    // ── H: período dos quatro históricos. Os indicadores (resumo da ficha) não entram: GET /fichas-epi não é relida.
    function mostrarPeriodo() {
      var e = $('historyPeriodoEstado');
      if (!e) return;
      e.textContent = periodoAplicado
        ? TEXTOS.PERIODO_APLICADO + modelo.data(periodoAplicado.de) + ' a ' + modelo.data(periodoAplicado.ate)
        : TEXTOS.PERIODO_TODO;
    }
    function erroPeriodo(mensagem) { var e = $('historyPeriodoErro'); if (e) e.textContent = mensagem || ''; }
    function datasDoPeriodo(inicial, final) {
      var i = $('historyPeriodoInicial');
      var f = $('historyPeriodoFinal');
      if (i) i.value = inicial;
      if (f) f.value = final;
    }
    /** Página 1 das quatro seções do colaborador exibido, com o período aplicado (cada carga anterior fica obsoleta). */
    function recarregarHistoricos() {
      secaoGhe.carregar(colaboradorId);
      secaoSituacao.carregar(colaboradorId);
      secaoCadastral.carregar(colaboradorId);
      if (!podeVerEpis || !epi || String(epi.funcionarioId) !== String(colaboradorId)) return;
      epi.periodo = periodoAplicado;
      // Ficha conhecida: só as entregas. Ficha ainda chegando: a carga em curso já usa o novo período. Sem ficha ou
      // falha da ficha: nada a refazer aqui (a nova tentativa usa o período aplicado).
      if (epi.fichaId !== null) carregarPagina(1, ++episAtual);
    }
    function aplicarPeriodo() {
      if (encerrada || colaboradorId === null) return;
      var v = validarPeriodo($('historyPeriodoInicial').value, $('historyPeriodoFinal').value);
      if (!v.ok) { erroPeriodo(v.mensagem); return; }
      erroPeriodo('');
      periodoAplicado = v.periodo;
      mostrarPeriodo();
      recarregarHistoricos();
    }
    function todoHistorico() {
      if (encerrada || colaboradorId === null) return;
      datasDoPeriodo('', '');
      erroPeriodo('');
      periodoAplicado = null;
      mostrarPeriodo();
      recarregarHistoricos();
    }
    function desfazerPeriodo() {
      periodoAplicado = null;
      datasDoPeriodo('', '');
      erroPeriodo('');
      mostrarPeriodo();
    }

    function limpar() {
      buscaAtual += 1;
      selecaoAtual += 1;
      $('historySearchValue').value = '';
      limparResultados();
      limparColaborador();
      desfazerPeriodo();
      aviso('', null);
    }

    // ── I: exportação do colaborador exibido, no formato escolhido e com o período APLICADO (não o digitado).
    function formatoEscolhido() {
      var s = $('historyExportFormato');
      var valor = s ? s.value : '';
      var conhecido = FORMATOS_EXPORTACAO.filter(function (f) { return f.id === valor; })[0];
      return (conhecido || FORMATOS_EXPORTACAO[0]).id;
    }
    function mensagemDaFalha(r) {
      if (r.status === 403) return TEXTOS.EXPORT_SEM_PERMISSAO;
      if (r.status === 400) return TEXTOS.EXPORT_PERIODO;
      if (r.status === 422) return TEXTOS.EXPORT_GRANDE;
      if (r.status === 429) return TEXTOS.EXPORT_LIMITE;
      return TEXTOS.EXPORT_FALHA;
    }
    async function exportarHistorico() {
      if (encerrada || !podeExportar || colaboradorId === null || exportando) return;
      var minha = ++exportacaoAtual;
      var opcoes = { formato: formatoEscolhido() };
      if (periodoAplicado) { opcoes.de = periodoAplicado.de; opcoes.ate = periodoAplicado.ate; }
      exportando = true;
      atualizarBotaoExportar();
      estadoExportacao(TEXTOS.EXPORT_GERANDO);
      var r;
      try {
        r = await acoes.exportar(colaboradorId, opcoes);
      } catch (e) {
        r = { ok: false, status: 0, codigo: null };
      }
      if (encerrada || minha !== exportacaoAtual) return; // outro colaborador, Limpar ou sessão encerrada: nada é salvo
      exportando = false;
      atualizarBotaoExportar();
      if (r && r.ok) {
        try {
          acoes.salvarArquivo(doc, r.blob, r.nomeArquivo);
          estadoExportacao(TEXTOS.EXPORT_CONCLUIDO);
        } catch (e) {
          estadoExportacao(TEXTOS.EXPORT_FALHA);
        }
        return;
      }
      if (r && r.status === 401) { sessaoCaiu(); return; }
      estadoExportacao(mensagemDaFalha(r || {}));
    }

    function encerrar() {
      encerrada = true;
      buscaAtual += 1;
      selecaoAtual += 1;
      var busca = $('historySearchValue');
      if (busca) busca.value = '';
      limparResultados();
      limparColaborador();
      desfazerPeriodo();
      aviso('', null);
    }

    return {
      iniciar: function () {
        $('botaoConsultar').addEventListener('click', consultar);
        $('botaoLimparHistorico').addEventListener('click', limpar);
        $('historySearchValue').addEventListener('keydown', function (e) { if (e && e.key === 'Enter') consultar(); });
        var aplicarBotao = $('botaoAplicarPeriodo');
        var todoBotao = $('botaoTodoHistorico');
        if (aplicarBotao) aplicarBotao.addEventListener('click', aplicarPeriodo);
        if (todoBotao) todoBotao.addEventListener('click', todoHistorico);
        var formatos = $('historyExportFormato');
        if (formatos) {
          formatos.replaceChildren.apply(formatos, FORMATOS_EXPORTACAO.map(function (f) { return no('option', { value: f.id }, [f.rotulo]); }));
          formatos.value = FORMATOS_EXPORTACAO[0].id;
        }
        var exportarBotao = $('botaoExportarHistorico');
        if (exportarBotao) exportarBotao.addEventListener('click', exportarHistorico);
        limparColaborador();
        mostrarPeriodo();
      },
      encerrar: encerrar,
      resultados: function () { return ultimaLista.slice(); },
      /** Período aplicado ({ de, ate }) ou null (todo o histórico): o mesmo que as consultas usam. */
      periodo: function () { return periodoAplicado ? { de: periodoAplicado.de, ate: periodoAplicado.ate } : null; },
    };
  }

  global.EpiHistoricoFuncionarios = {
    acoes: acoes, modelo: modelo, classificar: classificar, validarPeriodo: validarPeriodo, criarTela: criarTela, mostrarAviso: mostrarAviso, TEXTOS: TEXTOS, CAMPOS: CAMPOS, ROTULOS_SITUACAO: ROTULOS_SITUACAO,
    ROTULOS_ORIGEM: ROTULOS_ORIGEM, ROTULOS_MOTIVO: ROTULOS_MOTIVO, LIMITE_ENTREGAS: LIMITE_ENTREGAS,
    ROTULOS_EVENTO_GHE: ROTULOS_EVENTO_GHE, ROTULOS_CAMPO_CADASTRAL: ROTULOS_CAMPO_CADASTRAL, LIMITE_EVENTOS: LIMITE_EVENTOS,
    FORMATOS_EXPORTACAO: FORMATOS_EXPORTACAO,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiHistoricoFuncionarios;
})(typeof window !== 'undefined' ? window : globalThis);
