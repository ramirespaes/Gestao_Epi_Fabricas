(function (global) {
  'use strict';

  /**
   * EpiAtendimentoToken — Central Administrativa do Atendimento Token (Etapa H,
   * bloco frontend): contratos das rotas, validações, modelos e textos. Sem DOM
   * (a tela está em js/atendimento-token-tela.js) e sem armazenamento do
   * navegador. Cada operação repete só o FORMATO que o servidor valida; quem
   * decide autorização, empresa e ator é sempre o servidor (a sessão), e o
   * navegador nunca envia empresa, ator, situação, carimbo nem identificador.
   *
   *   GET  /atendimento-token/visao-geral                 atendimentoToken.visualizar
   *   GET  /atendimento-token/dispositivos[/:id]          atendimentoToken.visualizar
   *   POST /atendimento-token/dispositivos                atendimentoToken.criar
   *   PATCH /atendimento-token/dispositivos/:id           atendimentoToken.editar
   *   POST /atendimento-token/dispositivos/:id/revogar    TOKEN_REVOGAR_DISPOSITIVO
   *   GET  /atendimento-token/dispositivos/:id/ativacao   atendimentoToken.visualizar (estado derivado)
   *   POST /atendimento-token/dispositivos/:id/ativacao   TOKEN_GERAR_ATIVACAO (o código sai só nesta resposta)
   *   GET|POST /atendimento-token/redes, POST .../redes/:id/desativar   TOKEN_GERENCIAR_REDES
   *   GET  /atendimento-token/previa/catalogo?funcionarioId=            TOKEN_PREVIA_CATALOGO_REAL
   *   GET  /funcionarios?busca=...   (busca da prévia; employeeHistory.visualizar)
   *
   * O código de ativação nunca é guardado aqui: quem o recebe (a tela) o mantém só na memória do QR exibido.
   */

  var RAIZ = '/atendimento-token';
  var ACAO = Object.freeze({
    REVOGAR: 'TOKEN_REVOGAR_DISPOSITIVO',
    GERAR_ATIVACAO: 'TOKEN_GERAR_ATIVACAO',
    REDES: 'TOKEN_GERENCIAR_REDES',
    PREVIA: 'TOKEN_PREVIA_CATALOGO_REAL',
    MONITORAMENTO: 'TOKEN_VISUALIZAR_MONITORAMENTO',
    HISTORICO: 'TOKEN_VISUALIZAR_HISTORICO',
  });
  var ABAS = Object.freeze(['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico', 'visualizarTotem']);
  var ROTULOS_ABA = Object.freeze({
    visaoGeral: 'Visão Geral',
    dispositivos: 'Dispositivos',
    ativacao: 'Ativação',
    monitoramento: 'Monitoramento',
    previa: 'Prévia e Testes',
    historico: 'Histórico',
    visualizarTotem: 'Visualizar Totem',
  });

  var FUSO = 'America/Sao_Paulo';
  var LIMITE_LISTA = 20;
  var LIMITE_API = 100;
  var PAGINAS_MAXIMAS = 10;
  var BUSCA_MAXIMA = 100;
  var IDENTIFICADOR_MAXIMO = 30; // CPF (11 algarismos, com ou sem pontuação) ou matrícula: o limite do servidor para o valor
  var LIMITES = Object.freeze({ nome: 100, unidade: 100, setor: 100, localInstalacao: 150, fabricante: 100, modelo: 100, numeroSerie: 100, descricaoRede: 150 });
  // Validade máxima do código de ativação (uso único). O prazo exibido é sempre o do servidor; este teto só protege a tela.
  var VALIDADE_MAXIMA_MS = 10 * 60 * 1000;
  var CAMPOS_DISPOSITIVO = Object.freeze(['nome', 'unidade', 'setor', 'localInstalacao', 'fabricante', 'modelo', 'numeroSerie']);
  var ROTULOS_CAMPO = Object.freeze({
    nome: 'Nome', unidade: 'Unidade', setor: 'Setor', localInstalacao: 'Local de instalação',
    fabricante: 'Fabricante', modelo: 'Modelo', numeroSerie: 'Número de série',
  });

  var SITUACOES_DISPOSITIVO = Object.freeze({ PENDENTE: 'Aguardando ativação', ATIVO: 'Ativo', REVOGADO: 'Revogado' });
  var ESTADOS_ATIVACAO = Object.freeze(['NENHUMA', 'PENDENTE', 'EXPIRADA', 'CONSUMIDA', 'CANCELADA']);
  var ROTULOS_ATIVACAO = Object.freeze({
    NENHUMA: 'Nenhuma ativação gerada',
    PENDENTE: 'Aguardando leitura do QR',
    EXPIRADA: 'Expirada sem uso',
    CONSUMIDA: 'Usada',
    CANCELADA: 'Cancelada',
  });
  var SITUACOES_GERAIS = Object.freeze({
    SEM_DISPOSITIVOS: 'Nenhum dispositivo cadastrado.',
    SEM_DISPOSITIVO_ATIVO: 'Há dispositivos cadastrados, mas nenhum está ativo.',
    COM_DISPOSITIVO_ATIVO: 'Há ao menos um dispositivo ativo.',
  });
  var ESTADOS_CATALOGO = Object.freeze({
    OK: 'O funcionário vê estes materiais no tablet.',
    SEM_GHE: 'O funcionário não tem GHE. O tablet não mostraria nenhum material.',
    GHE_INATIVO: 'O GHE do funcionário está inativo. O tablet não mostraria nenhum material.',
    SEM_MATERIAIS: 'O GHE não tem material físico elegível para o tablet (ativo, classificado e, se exige tamanho, com grade).',
  });

  var TEXTO_SESSAO = 'Sua sessão expirou. Entre novamente para continuar.';
  var TEXTO_REDE = 'Não foi possível falar com o servidor. Verifique sua conexão.';
  var TEXTO_FALHA = 'Não foi possível concluir a operação. Tente novamente.';
  var POR_CODIGO = Object.freeze({
    VALIDACAO: 'Revise os campos destacados e tente de novo.',
    NOME_INVALIDO: 'Informe o nome do dispositivo (1 a 100 caracteres, sem caracteres de controle).',
    UNIDADE_INVALIDA: 'Unidade inválida (até 100 caracteres, sem caracteres de controle).',
    SETOR_INVALIDO: 'Setor inválido (até 100 caracteres, sem caracteres de controle).',
    LOCAL_INVALIDO: 'Local de instalação inválido (até 150 caracteres, sem caracteres de controle).',
    FABRICANTE_INVALIDO: 'Fabricante inválido (até 100 caracteres, sem caracteres de controle).',
    MODELO_INVALIDO: 'Modelo inválido (até 100 caracteres, sem caracteres de controle).',
    NUMERO_SERIE_INVALIDO: 'Número de série inválido (até 100 caracteres, sem caracteres de controle).',
    CORPO_VAZIO: 'Altere ao menos um campo para salvar.',
    DISPOSITIVO_NOME_EM_USO: 'Já existe um dispositivo com este nome nesta empresa.',
    DISPOSITIVO_NUMERO_SERIE_EM_USO: 'Já existe um dispositivo com este número de série nesta empresa.',
    DISPOSITIVO_REVOGADO: 'Este dispositivo foi revogado: não pode mais ser alterado nem ativado.',
    DISPOSITIVO_NAO_ENCONTRADO: 'Dispositivo não encontrado. Atualize a lista.',
    IP_INVALIDO: 'Informe um endereço IP exato (sem faixa, máscara ou texto adicional).',
    DESCRICAO_INVALIDA: 'Descrição inválida (até 150 caracteres, sem caracteres de controle).',
    REDE_JA_AUTORIZADA: 'Este endereço IP já está autorizado.',
    REDE_NAO_ENCONTRADA: 'Rede não encontrada. Atualize a lista.',
    FUNCIONARIO_NAO_ENCONTRADO: 'Funcionário não encontrado nesta empresa.',
    FUNCIONARIO_NAO_ELEGIVEL: 'Este funcionário não está ativo e não pode ser usado na prévia.',
    PERMISSAO_NEGADA: 'Você não tem autorização para esta operação.',
  });
  var CAMPO_DO_CODIGO = Object.freeze({
    NOME_INVALIDO: 'nome', UNIDADE_INVALIDA: 'unidade', SETOR_INVALIDO: 'setor', LOCAL_INVALIDO: 'localInstalacao',
    FABRICANTE_INVALIDO: 'fabricante', MODELO_INVALIDO: 'modelo', NUMERO_SERIE_INVALIDO: 'numeroSerie',
    DISPOSITIVO_NOME_EM_USO: 'nome', DISPOSITIVO_NUMERO_SERIE_EM_USO: 'numeroSerie',
    IP_INVALIDO: 'rede', DESCRICAO_INVALIDA: 'descricao', REDE_JA_AUTORIZADA: 'rede',
  });

  var CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/atendimento-token.js');
    return global.EpiHttp;
  }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function ehObjeto(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function texto(v) { return typeof v === 'string' ? v : ''; }
  function inteiro(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }
  function inteiroNaoNegativo(v) { return inteiro(v) && v >= 0; }
  function inteiroPositivo(v) { return inteiro(v) && v > 0; }
  function tamanhoEmPontos(s) { return Array.from(s).length; }

  // Referência da fotografia do catálogo (mesmo contrato do Totem): só os quatro campos; o id BIGINT segue como texto canônico.
  // Qualquer outra forma (inclusive URL fornecida pelo servidor) vira "sem fotografia".
  var ID_IMAGEM_MAXIMO = '9223372036854775807';
  var ORIGENS_IMAGEM = ['EMPRESA', 'PADRAO'];
  function imagemDoCatalogo(i) {
    if (!ehObjeto(i) || i.disponivel !== true || ORIGENS_IMAGEM.indexOf(i.origem) === -1) return { disponivel: false };
    if (typeof i.id !== 'string' || !/^[1-9][0-9]{0,18}$/.test(i.id) || (i.id.length === 19 && i.id > ID_IMAGEM_MAXIMO)) return { disponivel: false };
    if (!inteiro(i.versao) || i.versao < 1 || i.versao > 2147483647) return { disponivel: false };
    return { disponivel: true, origem: i.origem, id: i.id, versao: i.versao };
  }

  function exigirId(id, nome) {
    if (!inteiroPositivo(id)) throw new TypeError(nome + ' inválido');
  }
  function exigirPagina(pagina, limite) {
    if (!inteiroPositivo(pagina)) throw new TypeError('página inválida');
    if (!inteiroPositivo(limite) || limite > LIMITE_API) throw new TypeError('limite inválido');
  }

  var acoes = {
    visaoGeral: function () { return http().requisitar('GET', RAIZ + '/visao-geral'); },
    listarDispositivos: function (pagina, limite) {
      exigirPagina(pagina, limite);
      return http().requisitar('GET', RAIZ + '/dispositivos?pagina=' + pagina + '&limite=' + limite);
    },
    consultarDispositivo: function (id) {
      exigirId(id, 'identificador de dispositivo');
      return http().requisitar('GET', RAIZ + '/dispositivos/' + id);
    },
    cadastrarDispositivo: function (corpo) { return http().requisitar('POST', RAIZ + '/dispositivos', { corpo: corpo }); },
    editarDispositivo: function (id, corpo) {
      exigirId(id, 'identificador de dispositivo');
      return http().requisitar('PATCH', RAIZ + '/dispositivos/' + id, { corpo: corpo });
    },
    revogarDispositivo: function (id) {
      exigirId(id, 'identificador de dispositivo');
      return http().requisitar('POST', RAIZ + '/dispositivos/' + id + '/revogar', { corpo: {} });
    },
    estadoAtivacao: function (id) {
      exigirId(id, 'identificador de dispositivo');
      return http().requisitar('GET', RAIZ + '/dispositivos/' + id + '/ativacao');
    },
    gerarAtivacao: function (id) {
      exigirId(id, 'identificador de dispositivo');
      return http().requisitar('POST', RAIZ + '/dispositivos/' + id + '/ativacao', { corpo: {} });
    },
    listarRedes: function (pagina, limite) {
      exigirPagina(pagina, limite);
      return http().requisitar('GET', RAIZ + '/redes?pagina=' + pagina + '&limite=' + limite);
    },
    cadastrarRede: function (corpo) { return http().requisitar('POST', RAIZ + '/redes', { corpo: corpo }); },
    desativarRede: function (id) {
      exigirId(id, 'identificador de rede');
      return http().requisitar('POST', RAIZ + '/redes/' + id + '/desativar', { corpo: {} });
    },
    previa: function (funcionarioId) {
      exigirId(funcionarioId, 'identificador de funcionário');
      return http().requisitar('GET', RAIZ + '/previa/catalogo?funcionarioId=' + funcionarioId);
    },
    /**
     * Consulta real da prévia (K7): identifica o colaborador por CPF ou matrícula. O identificador vai SÓ no corpo do POST, nunca na URL;
     * a validação é a do servidor (CPF: 11 algarismos com pontuação opcional; matrícula: 1 a 30 pontos de código, sem controle).
     */
    previaIdentificar: function (tipo, valor) {
      if (tipo !== 'CPF' && tipo !== 'MATRICULA') throw new TypeError('tipo de identificador inválido');
      if (typeof valor !== 'string' || valor.length === 0 || tamanhoEmPontos(valor) > IDENTIFICADOR_MAXIMO || CONTROLE.test(valor)) throw new TypeError('identificador inválido');
      return http().requisitar('POST', RAIZ + '/previa/identificar', { corpo: { tipo: tipo, valor: valor } });
    },
    /** Busca do cadastro de funcionários (nome ou matrícula; nunca CPF na URL). */
    buscarFuncionarios: function (busca, limite) {
      var termo = typeof busca === 'string' ? busca.trim() : '';
      if (termo.length === 0 || tamanhoEmPontos(termo) > BUSCA_MAXIMA || CONTROLE.test(termo)) throw new TypeError('busca inválida');
      exigirPagina(1, limite);
      return http().requisitar('GET', '/funcionarios?busca=' + encodeURIComponent(termo) + '&pagina=1&limite=' + limite);
    },
  };

  /**
   * Junta todas as páginas de uma listagem (até o teto de páginas). Metadados inconsistentes ou página sem nada novo
   * viram falha da carga, nunca uma lista parcial apresentada como completa; o teto devolve `incompleta`.
   * @param {function(number): Promise<object>} pagina (n) => envelope do EpiHttp
   * @param {string} campo nome do array na resposta
   * @param {function(object): ?object} normalizar
   */
  async function carregarTodos(pagina, campo, normalizar) {
    var itens = [];
    var vistos = {};
    var total = 0;
    for (var n = 1; n <= PAGINAS_MAXIMAS; n += 1) {
      var r = await pagina(n);
      if (!r || !r.ok) return { ok: false, status: r ? r.status : 0, codigo: r ? r.codigo : null, itens: [], incompleta: false };
      var d = r.dados;
      if (!ehObjeto(d) || !Array.isArray(d[campo]) || !inteiroNaoNegativo(d.total)) return { ok: false, status: 0, codigo: 'RESPOSTA_INVALIDA', itens: [], incompleta: false };
      total = d.total;
      var novos = 0;
      for (var i = 0; i < d[campo].length; i += 1) {
        var item = normalizar(d[campo][i]);
        if (item === null) return { ok: false, status: 0, codigo: 'RESPOSTA_INVALIDA', itens: [], incompleta: false };
        if (!vistos[item.id]) { vistos[item.id] = true; itens.push(item); novos += 1; }
      }
      if (itens.length >= total || d[campo].length === 0) return { ok: true, itens: itens, total: total, incompleta: false };
      if (novos === 0) return { ok: false, status: 0, codigo: 'RESPOSTA_INVALIDA', itens: [], incompleta: false };
    }
    return { ok: true, itens: itens, total: total, incompleta: itens.length < total };
  }

  // ─── Formatação ────────────────────────────────────────────────────
  var tempo = {
    /** Dia e hora de um instante em São Paulo ("dd/mm/aaaa hh:mm"); inválido → "—". */
    instante: function (valor) {
      var s = texto(valor);
      var d = new Date(s);
      if (s === '' || isNaN(d.getTime())) return '—';
      try {
        var p = {};
        new Intl.DateTimeFormat('pt-BR', {
          timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(d).forEach(function (parte) { p[parte.type] = parte.value; });
        return p.day + '/' + p.month + '/' + p.year + ' ' + p.hour + ':' + p.minute;
      } catch (e) {
        return '—';
      }
    },
    /** "hh:mm:ss" para o tempo que falta (nunca negativo). */
    contagem: function (ms) {
      var total = Math.max(0, Math.ceil(ms / 1000));
      var m = Math.floor(total / 60);
      var s = total % 60;
      return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    },
  };

  // ─── Modelos (aceitam só o formato exato do servidor) ──────────────
  function opcional(v) { return v === null || v === undefined ? null : texto(v); }
  function instanteOuNulo(v) { return typeof v === 'string' && v.length > 0 ? v : null; }

  var modelo = {
    visaoGeral: function (dados) {
      var v = ehObjeto(dados) ? dados.visaoGeral : null;
      if (!ehObjeto(v) || !ehObjeto(v.dispositivos)) return null;
      var d = v.dispositivos;
      var chaves = ['cadastrados', 'ativos', 'pendentes', 'revogados'];
      for (var i = 0; i < chaves.length; i += 1) if (!inteiroNaoNegativo(d[chaves[i]])) return null;
      if (!inteiroNaoNegativo(v.ativacoesPendentes) || !hasOwn(SITUACOES_GERAIS, v.situacaoGeral)) return null;
      return {
        dispositivos: { cadastrados: d.cadastrados, ativos: d.ativos, pendentes: d.pendentes, revogados: d.revogados },
        ativacoesPendentes: v.ativacoesPendentes,
        situacaoGeral: v.situacaoGeral,
      };
    },
    dispositivo: function (d) {
      if (!ehObjeto(d) || !inteiroPositivo(d.id) || typeof d.nome !== 'string' || !hasOwn(SITUACOES_DISPOSITIVO, d.situacao)) return null;
      return {
        id: d.id,
        nome: d.nome,
        unidade: opcional(d.unidade),
        setor: opcional(d.setor),
        localInstalacao: opcional(d.localInstalacao),
        fabricante: opcional(d.fabricante),
        modelo: opcional(d.modelo),
        numeroSerie: opcional(d.numeroSerie),
        situacao: d.situacao,
        ativadoEm: instanteOuNulo(d.ativadoEm),
        revogadoEm: instanteOuNulo(d.revogadoEm),
        criadoEm: instanteOuNulo(d.criadoEm),
        atualizadoEm: instanteOuNulo(d.atualizadoEm),
      };
    },
    ativacao: function (dados) {
      var a = ehObjeto(dados) ? dados.ativacao : null;
      if (!ehObjeto(a) || ESTADOS_ATIVACAO.indexOf(a.estado) === -1) return null;
      return {
        estado: a.estado,
        geradaEm: instanteOuNulo(a.geradaEm),
        expiraEm: instanteOuNulo(a.expiraEm),
        usadaEm: instanteOuNulo(a.usadaEm),
        canceladaEm: instanteOuNulo(a.canceladaEm),
      };
    },
    rede: function (r) {
      if (!ehObjeto(r) || !inteiroPositivo(r.id) || typeof r.endereco !== 'string' || typeof r.ativa !== 'boolean') return null;
      return {
        id: r.id,
        endereco: r.endereco,
        descricao: opcional(r.descricao),
        ativa: r.ativa,
        criadaEm: instanteOuNulo(r.criadaEm),
        desativadaEm: instanteOuNulo(r.desativadaEm),
      };
    },
    funcionario: function (f) {
      if (!ehObjeto(f) || !inteiroPositivo(f.id) || typeof f.nome !== 'string') return null;
      var ghe = ehObjeto(f.grupoHomogeneo) && typeof f.grupoHomogeneo.descricao === 'string' ? f.grupoHomogeneo.descricao : null;
      var situacao = f.situacao === 'ATIVO' || f.situacao === 'AFASTADO' || f.situacao === 'INATIVO' ? f.situacao : (f.ativo === true ? 'ATIVO' : 'INATIVO');
      return { id: f.id, nome: f.nome, matricula: opcional(f.matricula), funcao: opcional(f.funcao), setor: opcional(f.setor), ghe: ghe, situacao: situacao };
    },
    /** A prévia é exatamente o catálogo do tablet: estado, total e materiais (nome, unidade, tipo, tamanhos). */
    previa: function (dados) {
      var c = ehObjeto(dados) && ehObjeto(dados.previa) ? dados.previa.catalogo : null;
      if (!ehObjeto(c) || !hasOwn(ESTADOS_CATALOGO, c.estado) || !inteiroNaoNegativo(c.total) || !Array.isArray(c.materiais)) return null;
      var materiais = [];
      for (var i = 0; i < c.materiais.length; i += 1) {
        var m = c.materiais[i];
        if (!ehObjeto(m) || !inteiroPositivo(m.id) || typeof m.nome !== 'string') return null;
        materiais.push({
          id: m.id,
          nome: m.nome,
          unidade: opcional(m.unidade),
          categoria: opcional(m.categoria),
          tipo: ehObjeto(m.tipo) && typeof m.tipo.nome === 'string' ? m.tipo.nome : null,
          exigeTamanho: m.exigeTamanho === true,
          tamanhos: Array.isArray(m.tamanhos) ? m.tamanhos.filter(function (t) { return typeof t === 'string'; }) : [],
        });
      }
      return { estado: c.estado, total: c.total, materiais: materiais };
    },
    /**
     * Consulta real (K7): SÓ primeiro nome, GHE e catálogo, com exatamente os campos que o Totem usa; qualquer outro campo (CPF,
     * matrícula, nome completo, ids, setor, saldo) é descartado, e formato fora do contrato vira null (nunca um resultado parcial).
     */
    previaIdentificar: function (dados) {
      var p = ehObjeto(dados) ? dados.previa : null;
      if (!ehObjeto(p) || !ehObjeto(p.funcionario) || !ehObjeto(p.catalogo)) return null;
      var nome = p.funcionario.primeiroNome;
      if (typeof nome !== 'string' || nome.trim() === '' || tamanhoEmPontos(nome) > 100) return null;

      var ghe = null;
      if (p.ghe !== null && p.ghe !== undefined) {
        var g = p.ghe;
        var codigo = g && g.codigo;
        if (!ehObjeto(g) || (codigo !== null && (typeof codigo !== 'string' || tamanhoEmPontos(codigo) > 30)) || typeof g.descricao !== 'string' || g.descricao === '' || tamanhoEmPontos(g.descricao) > 150 || typeof g.ativo !== 'boolean') return null;
        ghe = { codigo: codigo, descricao: g.descricao, ativo: g.ativo };
      }

      var c = p.catalogo;
      if (!hasOwn(ESTADOS_CATALOGO, c.estado) || !inteiroNaoNegativo(c.total) || !Array.isArray(c.materiais) || c.materiais.length > 200) return null;
      var texto100 = function (v) { return v === null || v === undefined ? null : (typeof v === 'string' && tamanhoEmPontos(v) <= 100 ? v : false); };
      var materiais = [];
      for (var i = 0; i < c.materiais.length; i += 1) {
        var m = c.materiais[i];
        if (!ehObjeto(m) || !inteiroPositivo(m.id) || typeof m.nome !== 'string' || m.nome === '' || tamanhoEmPontos(m.nome) > 150 || typeof m.exigeTamanho !== 'boolean') return null;
        if (!Array.isArray(m.tamanhos) || m.tamanhos.length > 100 || !m.tamanhos.every(function (t) { return typeof t === 'string' && t !== '' && tamanhoEmPontos(t) <= 20; })) return null;
        var unidade = texto100(m.unidade);
        var categoria = texto100(m.categoria);
        var protecao = texto100(m.grupoProtecao);
        if (unidade === false || categoria === false || protecao === false) return null;
        var tipo = null;
        if (m.tipo !== null && m.tipo !== undefined) {
          if (!ehObjeto(m.tipo) || !inteiroPositivo(m.tipo.id) || typeof m.tipo.nome !== 'string' || tamanhoEmPontos(m.tipo.nome) > 150) return null;
          tipo = { id: m.tipo.id, nome: m.tipo.nome };
        }
        materiais.push({
          id: m.id, nome: m.nome, unidade: unidade, categoria: categoria, grupoProtecao: protecao, tipo: tipo, exigeTamanho: m.exigeTamanho, tamanhos: m.tamanhos.slice(), imagem: imagemDoCatalogo(m.imagem),
        });
      }
      return { primeiroNome: nome, ghe: ghe, catalogo: { estado: c.estado, total: c.total, materiais: materiais } };
    },
  };

  // ─── Dispositivo: formulário ───────────────────────────────────────
  function aparar(v) { return typeof v === 'string' ? v.trim().normalize('NFC') : ''; }

  var formulario = {
    CAMPOS: CAMPOS_DISPOSITIVO,
    ROTULOS: ROTULOS_CAMPO,
    LIMITES: LIMITES,
    /** Valores apurados dos campos (aparados, NFC); em branco = ''. */
    apurar: function (valores) {
      var v = {};
      CAMPOS_DISPOSITIVO.forEach(function (c) { v[c] = aparar(valores && valores[c]); });
      return v;
    },
    /** Mesmas regras do servidor (nome obrigatório, limites em pontos de código, sem controle). Devolve {campo: texto}. */
    validar: function (valores) {
      var v = formulario.apurar(valores);
      var erros = {};
      CAMPOS_DISPOSITIVO.forEach(function (c) {
        if (c === 'nome' && v.nome.length === 0) { erros.nome = POR_CODIGO.NOME_INVALIDO; return; }
        if (v[c].length === 0) return;
        if (tamanhoEmPontos(v[c]) > LIMITES[c] || CONTROLE.test(v[c])) {
          erros[c] = POR_CODIGO[{ nome: 'NOME_INVALIDO', unidade: 'UNIDADE_INVALIDA', setor: 'SETOR_INVALIDO', localInstalacao: 'LOCAL_INVALIDO', fabricante: 'FABRICANTE_INVALIDO', modelo: 'MODELO_INVALIDO', numeroSerie: 'NUMERO_SERIE_INVALIDO' }[c]];
        }
      });
      return erros;
    },
    /** Cadastro: só o nome e os opcionais preenchidos. */
    corpoCriacao: function (valores) {
      var v = formulario.apurar(valores);
      var corpo = { nome: v.nome };
      CAMPOS_DISPOSITIVO.forEach(function (c) { if (c !== 'nome' && v[c] !== '') corpo[c] = v[c]; });
      return corpo;
    },
    /** Edição: só o que mudou em relação ao dispositivo mostrado; campo opcional esvaziado vai como null. */
    corpoEdicao: function (original, valores) {
      var v = formulario.apurar(valores);
      var corpo = {};
      CAMPOS_DISPOSITIVO.forEach(function (c) {
        var antes = original && typeof original[c] === 'string' ? original[c] : '';
        if (v[c] === antes) return;
        corpo[c] = v[c] === '' ? null : v[c];
      });
      return corpo;
    },
  };

  // ─── Rede autorizada: endereço IP exato ────────────────────────────
  var IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  var HEX16 = /^[0-9a-fA-F]{1,4}$/;

  function ipv4Valido(s) { return IPV4.test(s); }
  function ipv6Valido(s) {
    if (s.indexOf(':') === -1 || /[^0-9a-fA-F:.]/.test(s) || s.indexOf(':::') !== -1) return false;
    var duplo = s.split('::');
    if (duplo.length > 2) return false;
    var cauda = s.charAt(s.length - 1) !== ':' && s.lastIndexOf(':') !== -1 ? s.slice(s.lastIndexOf(':') + 1) : '';
    var temV4 = cauda.indexOf('.') !== -1;
    if (temV4 && !ipv4Valido(cauda)) return false;
    var corpo = temV4 ? s.slice(0, s.lastIndexOf(':') + 1) + '0:0' : s;
    var partes = corpo.split('::');
    var lado = function (p) { return p === '' ? [] : p.split(':'); };
    var esquerda = lado(partes[0]);
    var direita = partes.length === 2 ? lado(partes[1]) : [];
    var grupos = esquerda.concat(direita);
    for (var i = 0; i < grupos.length; i += 1) if (!HEX16.test(grupos[i])) return false;
    return partes.length === 2 ? grupos.length <= 7 : grupos.length === 8;
  }

  var rede = {
    LIMITE_DESCRICAO: LIMITES.descricaoRede,
    /** IP exato IPv4 ou IPv6: sem barra, máscara, faixa, espaço ou texto; 0.0.0.0 e :: não servem. O servidor valida de novo. */
    validarEndereco: function (valor) {
      var s = aparar(valor);
      if (s.length === 0) return POR_CODIGO.IP_INVALIDO;
      if (/[\s/%,\-*]/.test(s)) return POR_CODIGO.IP_INVALIDO;
      if (s === '0.0.0.0' || /^(0{1,4}:){7}0{1,4}$/.test(s) || s === '::') return POR_CODIGO.IP_INVALIDO;
      return ipv4Valido(s) || ipv6Valido(s) ? '' : POR_CODIGO.IP_INVALIDO;
    },
    validarDescricao: function (valor) {
      var s = aparar(valor);
      if (s.length === 0) return '';
      return tamanhoEmPontos(s) > LIMITES.descricaoRede || CONTROLE.test(s) ? POR_CODIGO.DESCRICAO_INVALIDA : '';
    },
    corpo: function (valores) {
      var corpo = { rede: aparar(valores && valores.rede) };
      var d = aparar(valores && valores.descricao);
      if (d !== '') corpo.descricao = d;
      return corpo;
    },
    /** A rede ativa informada é a única ativa da lista (conhecida por completo)? */
    ehUnicaAtiva: function (redes, id, incompleta) {
      if (incompleta === true || !Array.isArray(redes)) return false;
      var ativas = redes.filter(function (r) { return r.ativa; });
      return ativas.length === 1 && ativas[0].id === id;
    },
  };

  // ─── Ativação ──────────────────────────────────────────────────────
  var ativacao = {
    VALIDADE_MAXIMA_MS: VALIDADE_MAXIMA_MS,
    /**
     * O que vai dentro do QR: a URL do Totem, na mesma origem desta página, com o código de uso único no FRAGMENTO
     * (https://<origem>/totem/#ativar=<código>). O fragmento não vai ao servidor nem a proxies; o Totem o lê e o remove da URL
     * antes de qualquer requisição. Nunca é gravado, escrito em texto na página nem registrado. Sem origem http(s) não há QR.
     */
    conteudoQr: function (codigo) {
      var origem = typeof location === 'object' && location !== null ? location.origin : null;
      if (typeof origem !== 'string' || !/^https?:\/\/[^/]+$/.test(origem)) throw new TypeError('origem da página indisponível para o QR');
      return origem + '/totem/#ativar=' + String(codigo);
    },
    /** Valida a resposta da geração: código e prazo (o prazo é o do servidor, limitado a 10 minutos a partir de agora). */
    daGeracao: function (dados, agora) {
      var a = ehObjeto(dados) ? dados.ativacao : null;
      if (!ehObjeto(a) || typeof a.codigo !== 'string' || a.codigo.length === 0 || !inteiroPositivo(a.dispositivoId)) return null;
      var fim = new Date(texto(a.expiraEm)).getTime();
      if (isNaN(fim)) return null;
      var teto = agora + VALIDADE_MAXIMA_MS;
      return { dispositivoId: a.dispositivoId, codigo: a.codigo, expiraEm: a.expiraEm, fimMs: Math.min(fim, teto) };
    },
    restanteMs: function (fimMs, agora) { return Math.max(0, fimMs - agora); },
  };

  // ─── Permissões da tela ────────────────────────────────────────────
  /** O que a pessoa pode ver e fazer, pelas permissões reais. Apresentação apenas: o servidor decide cada rota de novo. */
  function capacidades(permissoes) {
    var P = global.EpiPermissoes;
    if (!P) throw new Error('EpiPermissoes não carregado: inclua js/permissoes-efetivas.js antes de js/atendimento-token.js');
    var visualizar = P.recurso(permissoes, 'atendimentoToken', 'visualizar');
    var gerarAtivacao = P.acao(permissoes, ACAO.GERAR_ATIVACAO);
    var redes = P.acao(permissoes, ACAO.REDES);
    var previa = P.acao(permissoes, ACAO.PREVIA);
    return {
      visualizar: visualizar,
      criar: visualizar && P.recurso(permissoes, 'atendimentoToken', 'criar'),
      editar: visualizar && P.recurso(permissoes, 'atendimentoToken', 'editar'),
      revogar: visualizar && P.acao(permissoes, ACAO.REVOGAR),
      gerarAtivacao: gerarAtivacao,
      redes: redes,
      previa: previa,
      buscarFuncionario: P.recurso(permissoes, 'employeeHistory', 'visualizar'),
      // Etapa J: reservadas; ainda não há rota nem dado.
      monitoramento: P.acao(permissoes, ACAO.MONITORAMENTO),
      historico: P.acao(permissoes, ACAO.HISTORICO),
      abas: {
        visaoGeral: visualizar,
        dispositivos: visualizar,
        ativacao: visualizar || gerarAtivacao || redes,
        monitoramento: true,
        previa: previa,
        historico: true,
        // K7: a prévia visual usa dados fictícios e nenhuma rota; reaproveita a permissão da prévia só para organizar quem a vê.
        visualizarTotem: previa,
      },
    };
  }

  // ─── Mensagens ─────────────────────────────────────────────────────
  var mensagens = {
    exigeNovoLogin: function (r) { return !!r && r.ok === false && r.status === 401; },
    doCodigo: function (codigo) { return hasOwn(POR_CODIGO, codigo) ? POR_CODIGO[codigo] : POR_CODIGO.VALIDACAO; },
    /** Texto de uma falha: sempre dos textos daqui, nunca o do servidor. */
    deErro: function (r) {
      if (!r || r.ok) return '';
      if (r.status === 0) return TEXTO_REDE;
      if (r.status === 401) return TEXTO_SESSAO;
      if (r.status === 429) return 'Muitas tentativas. Aguarde um momento e tente novamente.';
      if (r.status >= 500) return TEXTO_FALHA;
      if (r.codigo && hasOwn(POR_CODIGO, r.codigo)) return POR_CODIGO[r.codigo];
      if (r.status === 403) return POR_CODIGO.PERMISSAO_NEGADA;
      if (r.status === 404) return 'Registro não encontrado. Atualize a página.';
      if (r.status === 400) return POR_CODIGO.VALIDACAO;
      return TEXTO_FALHA;
    },
    /**
     * Erros de campo de uma resposta: 400 pelo caminho `body.<campo>` e 409 de unicidade pelo código. Devolve
     * [{campo, mensagem}] com os nomes de campo da API; vazio quando nada é de campo.
     */
    deCampos: function (r, permitidos) {
      if (!r || r.ok) return [];
      var ok = function (c) { return Array.isArray(permitidos) && permitidos.indexOf(c) !== -1; };
      if (r.status === 400 && Array.isArray(r.detalhes)) {
        var saida = [];
        r.detalhes.forEach(function (d) {
          if (!d || typeof d.campo !== 'string') return;
          var partes = d.campo.split('.');
          if (partes[0] !== 'body' || !ok(partes[1])) return;
          var codigo = typeof d.codigo === 'string' && hasOwn(POR_CODIGO, d.codigo) ? d.codigo : 'VALIDACAO';
          saida.push({ campo: partes[1], mensagem: POR_CODIGO[codigo] });
        });
        return saida;
      }
      if (r.status === 409 && r.codigo && hasOwn(CAMPO_DO_CODIGO, r.codigo) && ok(CAMPO_DO_CODIGO[r.codigo])) {
        return [{ campo: CAMPO_DO_CODIGO[r.codigo], mensagem: POR_CODIGO[r.codigo] }];
      }
      return [];
    },
  };

  global.EpiAtendimentoToken = {
    acoes: acoes,
    carregarTodos: carregarTodos,
    capacidades: capacidades,
    mensagens: mensagens,
    modelo: modelo,
    formulario: formulario,
    rede: rede,
    ativacao: ativacao,
    tempo: tempo,
    ACAO: ACAO,
    ABAS: ABAS,
    ROTULOS_ABA: ROTULOS_ABA,
    SITUACOES_DISPOSITIVO: SITUACOES_DISPOSITIVO,
    ESTADOS_ATIVACAO: ESTADOS_ATIVACAO,
    ROTULOS_ATIVACAO: ROTULOS_ATIVACAO,
    SITUACOES_GERAIS: SITUACOES_GERAIS,
    ESTADOS_CATALOGO: ESTADOS_CATALOGO,
    POR_CODIGO: POR_CODIGO,
    LIMITE_LISTA: LIMITE_LISTA,
    LIMITE_API: LIMITE_API,
    PAGINAS_MAXIMAS: PAGINAS_MAXIMAS,
    BUSCA_MAXIMA: BUSCA_MAXIMA,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiAtendimentoToken;
  }
})(typeof window !== 'undefined' ? window : globalThis);
