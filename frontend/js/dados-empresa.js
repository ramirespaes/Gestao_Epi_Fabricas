(function (global) {
  'use strict';

  /**
   * EpiDadosEmpresa — Dados da Empresa (Portal Empresarial, F2).
   *
   * Só rotas reais da F1, sempre da empresa da SESSÃO (o navegador nunca informa empresa nem usuário):
   *   GET   /empresa/dados   consulta (companyData.visualizar)
   *   PATCH /empresa/dados   { versao, <só os campos alterados> } (companyData.visualizar E companyData.editar)
   *
   * Razão social e CNPJ são exibidos, nunca editados e NUNCA enviados: esta camada recusa (TypeError, antes da rede) qualquer
   * corpo que os traga, e o servidor os recusa de novo. A `versao` carregada vai em todo PATCH; conflito (409) não sobrescreve
   * nada: a pessoa é avisada, o que ela digitou fica na tela e os dados atualizados só entram quando ela pede.
   *
   *   acoes       — chamadas à API (envelope do EpiHttp).
   *   modelo      — leitura estrita do que a API devolve.
   *   formulario  — normalização, diff (só o que mudou) e validação local (as mesmas regras do servidor).
   *   erros       — leitura dos erros (código estável; nunca o texto do servidor).
   *   capacidades — o que a pessoa pode fazer, pelo mecanismo central de permissões (EpiPermissoes.PAGINAS.companyData).
   *   criarTela   — liga tudo ao DOM de pages/company-data.html, sempre com textContent/value.
   *
   * Nada vai para armazenamento do navegador.
   */

  var CAMINHO = '/empresa/dados';

  // Campos editáveis: [chave da API, tamanho máximo]. A ordem é a da tela.
  var DEFINICAO = [
    ['nomeFantasia', 150], ['inscricaoEstadual', 20], ['situacaoInscricaoEstadual', 30],
    ['endereco', 200], ['numero', 20], ['complemento', 100], ['bairro', 100], ['cidade', 100], ['uf', 2], ['cep', 9],
    ['telefone', 20], ['email', 150], ['emailSst', 150], ['emailAlmoxarifado', 150],
    ['representanteNome', 150], ['representanteCargo', 100], ['representanteEmail', 150], ['representanteTelefone', 20],
    ['financeiroNome', 150], ['financeiroEmail', 150], ['financeiroTelefone', 20],
  ];
  var CAMPOS = DEFINICAO.map(function (d) { return d[0]; });
  var TAMANHO = {};
  DEFINICAO.forEach(function (d) { TAMANHO[d[0]] = d[1]; });
  var EMAILS = ['email', 'emailSst', 'emailAlmoxarifado', 'representanteEmail', 'financeiroEmail'];
  var SITUACOES_IE = ['CONTRIBUINTE', 'ISENTO', 'NAO_CONTRIBUINTE'];
  var PROTEGIDOS = ['razaoSocial', 'cnpj', 'nome'];
  var EMAIL_FORMATO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  var TEXTOS = {
    CARREGANDO: 'Carregando os dados da empresa…',
    FALHA_CARGA: 'Não foi possível carregar os dados da empresa. Recarregue a página para tentar novamente.',
    SALVANDO: 'Salvando…',
    SALVO: 'Alterações salvas.',
    SEM_ALTERACAO: 'Nenhuma alteração para salvar.',
    SEM_PERMISSAO: 'Você não tem permissão para alterar os dados da empresa.',
    LEITURA: 'Você tem acesso apenas para consulta: não é possível alterar os dados da empresa.',
    CONFLITO: 'Os dados da empresa foram alterados por outra pessoa depois que você abriu esta página. Nada foi salvo. '
      + 'O que você digitou continua na tela. Ao carregar os dados atualizados, o formulário será substituído e as suas alterações '
      + 'não salvas serão descartadas.',
    RECARREGAR_ROTULO: 'Carregar dados atualizados e substituir o formulário',
    CONFIRMAR_DESCARTE: function (n) {
      return 'Você tem ' + n + (n === 1 ? ' campo' : ' campos') + ' com alterações não salvas. Carregar os dados atualizados vai '
        + 'substituir o formulário e descartar essas alterações. Esta ação não pode ser desfeita.';
    },
    RECARREGADO: 'Dados atualizados carregados.',
    FALHA_RECARGA: 'Não foi possível carregar os dados atualizados agora. Tente novamente.',
    LIMITE: 'Muitas tentativas em pouco tempo. Aguarde um momento e tente novamente.',
    REDE: 'Não foi possível falar com o servidor. Verifique sua conexão e tente novamente.',
    GENERICO: 'Não foi possível salvar agora. Tente novamente.',
    CORRIJA: 'Corrija os campos destacados.',
    CAMPO_PROTEGIDO: 'Razão social e CNPJ não podem ser alterados por esta tela.',
    LOGO_BREVE: 'O envio de logotipo estará disponível em uma próxima etapa. Por enquanto, o ícone institucional é mantido.',
  };

  var MSG = {
    email: 'Informe um e-mail válido, como nome@suaempresa.com.br.',
    uf: 'Informe a sigla do estado com 2 letras.',
    cep: 'Informe o CEP com 8 dígitos.',
    situacao: 'Escolha uma situação válida.',
    ieExigida: 'Informe o número da inscrição estadual para a situação Contribuinte.',
    tamanho: function (n) { return 'Use no máximo ' + n + ' caracteres.'; },
  };

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/dados-empresa.js');
    return global.EpiHttp;
  }
  function permissoes() {
    if (!global.EpiPermissoes) throw new Error('EpiPermissoes não carregado: inclua js/permissoes-efetivas.js antes de js/dados-empresa.js');
    return global.EpiPermissoes;
  }
  function ehTexto(v) { return typeof v === 'string'; }
  function temp(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    consultar: function () { return http().requisitar('GET', CAMINHO); },
    /** @param {number} versao a versão carregada; @param {object} campos só os campos alterados (null limpa) */
    alterar: async function (versao, campos) {
      if (typeof versao !== 'number' || Math.floor(versao) !== versao || versao < 1) throw new TypeError('versão inválida');
      if (!campos || typeof campos !== 'object' || Array.isArray(campos)) throw new TypeError('campos inválidos');
      var chaves = Object.keys(campos);
      if (chaves.length === 0) throw new TypeError('nenhum campo para alterar');
      chaves.forEach(function (c) {
        if (CAMPOS.indexOf(c) === -1) throw new TypeError('campo não editável: ' + c);
      });
      var corpo = { versao: versao };
      chaves.forEach(function (c) { corpo[c] = campos[c]; });
      return http().requisitar('PATCH', CAMINHO, { corpo: corpo });
    },
  };

  // ─── Modelo ────────────────────────────────────────────────────────
  var modelo = {
    /** { versao, razaoSocial, cnpj, valores } com os valores como texto (null vira ''), ou null se a resposta não for válida. */
    deResposta: function (r) {
      var d = r && r.ok && r.dados && typeof r.dados === 'object' ? r.dados.dados : null;
      if (!d || typeof d !== 'object') return null;
      if (typeof d.versao !== 'number' || Math.floor(d.versao) !== d.versao || d.versao < 1) return null;
      if (!ehTexto(d.razaoSocial) || !ehTexto(d.cnpj)) return null;
      if (!d.representante || typeof d.representante !== 'object' || !d.financeiro || typeof d.financeiro !== 'object') return null;
      var bruto = {
        nomeFantasia: d.nomeFantasia, inscricaoEstadual: d.inscricaoEstadual, situacaoInscricaoEstadual: d.situacaoInscricaoEstadual,
        endereco: d.endereco, numero: d.numero, complemento: d.complemento, bairro: d.bairro, cidade: d.cidade, uf: d.uf, cep: d.cep,
        telefone: d.telefone, email: d.email, emailSst: d.emailSst, emailAlmoxarifado: d.emailAlmoxarifado,
        representanteNome: d.representante.nome, representanteCargo: d.representante.cargo, representanteEmail: d.representante.email,
        representanteTelefone: d.representante.telefone,
        financeiroNome: d.financeiro.nome, financeiroEmail: d.financeiro.email, financeiroTelefone: d.financeiro.telefone,
      };
      var valores = {};
      for (var i = 0; i < CAMPOS.length; i += 1) {
        var v = bruto[CAMPOS[i]];
        if (v !== null && v !== undefined && !ehTexto(v)) return null;
        valores[CAMPOS[i]] = v === null || v === undefined ? '' : v;
      }
      return { versao: d.versao, razaoSocial: d.razaoSocial, cnpj: d.cnpj, valores: valores };
    },
  };

  // ─── Formulário ────────────────────────────────────────────────────
  /** Representação canônica de um campo (a mesma que o servidor grava): aparado; vazio = null. */
  function normalizar(chave, texto) {
    var t = ehTexto(texto) ? texto.trim() : '';
    if (t === '') return null;
    if (typeof t.normalize === 'function') t = t.normalize('NFC');
    if (EMAILS.indexOf(chave) !== -1) return t.toLowerCase();
    if (chave === 'uf' || chave === 'situacaoInscricaoEstadual') return t.toUpperCase();
    if (chave === 'cep') return t.replace(/-/g, '');
    return t;
  }

  function comprimento(t) { return Array.from(t).length; }

  var formulario = {
    normalizar: normalizar,
    /** Só o que mudou, já normalizado (vazio = null = limpar). Nunca razão social, CNPJ nem chave desconhecida. */
    diff: function (original, atuais) {
      var d = {};
      CAMPOS.forEach(function (c) {
        var o = normalizar(c, original ? original[c] : '');
        var a = normalizar(c, atuais ? atuais[c] : '');
        if (a !== o) d[c] = a;
      });
      return d;
    },
    /** { campo: texto } com os mesmos limites e formatos do servidor; vazio é permitido (campos opcionais). */
    validar: function (valores) {
      var erros = {};
      CAMPOS.forEach(function (c) {
        var v = normalizar(c, valores ? valores[c] : '');
        if (v === null) return;
        if (comprimento(v) > TAMANHO[c]) { erros[c] = MSG.tamanho(TAMANHO[c]); return; }
        if (EMAILS.indexOf(c) !== -1 && !EMAIL_FORMATO.test(v)) erros[c] = MSG.email;
        else if (c === 'uf' && !/^[A-Z]{2}$/.test(v)) erros[c] = MSG.uf;
        else if (c === 'cep' && !/^[0-9]{8}$/.test(v)) erros[c] = MSG.cep;
        else if (c === 'situacaoInscricaoEstadual' && SITUACOES_IE.indexOf(v) === -1) erros[c] = MSG.situacao;
      });
      var situacao = normalizar('situacaoInscricaoEstadual', valores ? valores.situacaoInscricaoEstadual : '');
      if (situacao === 'CONTRIBUINTE' && normalizar('inscricaoEstadual', valores ? valores.inscricaoEstadual : '') === null && !erros.inscricaoEstadual) {
        erros.inscricaoEstadual = MSG.ieExigida;
      }
      return erros;
    },
    mascaraCnpj: function (texto) {
      var t = String(texto || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
      if (t.length !== 14) return String(texto || '');
      return t.slice(0, 2) + '.' + t.slice(2, 5) + '.' + t.slice(5, 8) + '/' + t.slice(8, 12) + '-' + t.slice(12);
    },
    mascaraCep: function (texto) {
      var t = String(texto || '').replace(/\D/g, '');
      return t.length === 8 ? t.slice(0, 5) + '-' + t.slice(5) : String(texto || '');
    },
  };

  // ─── Erros ─────────────────────────────────────────────────────────
  var erros = {
    /**
     * { sessao: true } | { conflito: true, aviso } | { campos: {campo: texto} } | { aviso }.
     * O conflito de versão nunca é tratado como erro comum: a tela não reenvia a versão antiga.
     */
    daEscrita: function (r) {
      var status = r ? r.status : 0;
      var codigo = r ? r.codigo : null;
      if (status === 401) return { sessao: true };
      if (status === 403) return { aviso: TEXTOS.SEM_PERMISSAO };
      if (status === 409 && codigo === 'EMPRESA_DADOS_DESATUALIZADOS') return { conflito: true, aviso: TEXTOS.CONFLITO };
      if (status === 429) return { aviso: TEXTOS.LIMITE };
      if (status === 400) {
        if (codigo === 'EMPRESA_IE_EXIGIDA') return { campos: { inscricaoEstadual: MSG.ieExigida } };
        if (codigo === 'CAMPO_NAO_PERMITIDO') return { aviso: TEXTOS.CAMPO_PROTEGIDO };
        if (codigo === 'VALIDACAO' && r && Array.isArray(r.detalhes)) {
          var campos = {};
          var protegido = false;
          r.detalhes.forEach(function (d) {
            var m = d && ehTexto(d.campo) ? /^body\.(.+)$/.exec(d.campo) : null;
            if (!m) return;
            if (PROTEGIDOS.indexOf(m[1]) !== -1) protegido = true;
            else if (CAMPOS.indexOf(m[1]) !== -1) campos[m[1]] = EMAILS.indexOf(m[1]) !== -1 ? MSG.email : 'Valor inválido.';
          });
          if (Object.keys(campos).length > 0) return { campos: campos };
          if (protegido) return { aviso: TEXTOS.CAMPO_PROTEGIDO };
        }
        return { aviso: TEXTOS.CORRIJA };
      }
      if (status === 0) return { aviso: TEXTOS.REDE };
      return { aviso: TEXTOS.GENERICO };
    },
  };

  // ─── Permissões ────────────────────────────────────────────────────
  /** Pelo mecanismo central: editar = abrir (visualizar) E alterar (editar). Só editar nunca basta. */
  function capacidades(perm) {
    var P = permissoes();
    return { visualizar: P.podeAbrir(perm, 'companyData'), editar: P.podeAlterar(perm, 'companyData') };
  }

  // ─── Tela ──────────────────────────────────────────────────────────
  function criarTela(opcoes) {
    var o = opcoes || {};
    var cap = o.capacidades || { visualizar: false, editar: false };
    var doc = o.documento || global.document;
    var $ = function (id) { return doc.getElementById(id); };

    var base = null;        // o que o servidor confirmou (modelo)
    var salvando = false;
    var emConflito = false;
    var encerrada = false;
    var ligada = false;

    function aviso(texto, tipo) {
      var caixa = $('empAviso');
      if (!caixa) return;
      caixa.textContent = texto || '';
      caixa.style.display = texto ? '' : 'none';
      caixa.setAttribute('data-tipo', tipo || 'erro');
    }
    function status(texto) {
      var el = $('empStatus');
      if (el) el.textContent = texto || '';
    }
    function mostrarConflito(sim) {
      emConflito = sim;
      var caixa = $('empConflito');
      if (caixa) caixa.style.display = sim ? '' : 'none';
      var texto = $('empConflitoTexto');
      if (texto) texto.textContent = sim ? TEXTOS.CONFLITO : '';
      if (!sim) esconderConfirmacao();
    }
    function esconderConfirmacao() {
      var painel = $('empConfirmarRecarga');
      if (painel) painel.style.display = 'none';
    }
    function confirmacaoAberta() {
      var painel = $('empConfirmarRecarga');
      return !!painel && painel.style.display !== 'none';
    }
    /**
     * "Carregar dados atualizados" substitui o formulário. Com alterações não salvas, a substituição só acontece depois de uma
     * confirmação que diz o que será descartado; cancelar não consulta nada e mantém o digitado e o conflito.
     */
    function pedirRecarga() {
      if (salvando || encerrada || base === null) return;
      var n = Object.keys(formulario.diff(base.valores, valoresDaTela())).length;
      if (n === 0) { recarregar(); return; }
      $('empConfirmarTexto').textContent = TEXTOS.CONFIRMAR_DESCARTE(n);
      $('empConfirmarRecarga').style.display = '';
      $('empConfirmarCancelar').focus();
    }
    function cancelarRecarga() {
      esconderConfirmacao();
      if ($('empRecarregar')) $('empRecarregar').focus();
    }
    function confirmarRecarga() {
      esconderConfirmacao();
      return recarregar();
    }
    function limparErros() {
      CAMPOS.forEach(function (c) { erroDoCampo(c, ''); });
    }
    function erroDoCampo(chave, texto) {
      var span = $('err-' + chave);
      var campo = $('emp-' + chave);
      if (span) span.textContent = texto || '';
      if (campo) {
        if (texto) campo.setAttribute('aria-invalid', 'true');
        else campo.removeAttribute('aria-invalid');
      }
    }
    function valoresDaTela() {
      var v = {};
      CAMPOS.forEach(function (c) { v[c] = $('emp-' + c).value; });
      return v;
    }
    function preencher(m) {
      $('emp-razaoSocial').value = m.razaoSocial;
      $('emp-cnpj').value = formulario.mascaraCnpj(m.cnpj);
      CAMPOS.forEach(function (c) {
        var v = m.valores[c];
        $('emp-' + c).value = c === 'cep' ? formulario.mascaraCep(v) : v;
      });
    }
    function atualizarBotao() {
      var botao = $('empSalvar');
      if (!botao) return;
      var pendente = base !== null && Object.keys(formulario.diff(base.valores, valoresDaTela())).length > 0;
      botao.disabled = !(cap.editar && base !== null && pendente && !salvando && !emConflito);
    }
    function sessaoCaiu() {
      encerrada = true;
      if (typeof o.aoSessaoEncerrada === 'function') o.aoSessaoEncerrada();
    }

    function travarCampos() {
      CAMPOS.forEach(function (c) {
        var el = $('emp-' + c);
        if (el.tagName && String(el.tagName).toLowerCase() === 'select') el.disabled = true;
        else el.readOnly = true;
      });
    }

    async function carregar() {
      aviso('');
      status(TEXTOS.CARREGANDO);
      var r = await acoes.consultar();
      if (encerrada) return false;
      status('');
      if (r && r.status === 401) { sessaoCaiu(); return false; }
      var m = modelo.deResposta(r);
      if (!m) {
        aviso(r && r.status === 0 ? TEXTOS.REDE : TEXTOS.FALHA_CARGA);
        atualizarBotao();
        return false;
      }
      base = m;
      preencher(m);
      limparErros();
      atualizarBotao();
      return true;
    }

    async function recarregar() {
      if (salvando || encerrada) return;
      var r = await acoes.consultar();
      if (encerrada) return;
      if (r && r.status === 401) { sessaoCaiu(); return; }
      var m = modelo.deResposta(r);
      if (!m) { aviso(TEXTOS.FALHA_RECARGA); return; }
      base = m;
      preencher(m);
      limparErros();
      mostrarConflito(false);
      aviso('');
      status(TEXTOS.RECARREGADO);
      atualizarBotao();
    }

    async function salvar() {
      if (!cap.editar || salvando || emConflito || base === null || encerrada) return;
      var valores = valoresDaTela();
      var invalidos = formulario.validar(valores);
      limparErros();
      var primeiro = null;
      CAMPOS.forEach(function (c) {
        if (invalidos[c]) {
          erroDoCampo(c, invalidos[c]);
          if (primeiro === null) primeiro = c;
        }
      });
      if (primeiro !== null) {
        aviso(TEXTOS.CORRIJA);
        $('emp-' + primeiro).focus();
        return;
      }
      var mudancas = formulario.diff(base.valores, valores);
      if (Object.keys(mudancas).length === 0) { aviso(''); status(TEXTOS.SEM_ALTERACAO); return; }

      salvando = true;
      aviso('');
      status(TEXTOS.SALVANDO);
      atualizarBotao();
      var r;
      try {
        r = await acoes.alterar(base.versao, mudancas);
      } finally {
        salvando = false;
      }
      if (encerrada) return;
      if (r && r.ok) {
        var novo = modelo.deResposta({ ok: true, dados: { dados: r.dados && r.dados.dados } });
        if (novo) {
          base = novo;
          preencher(novo);
          status(TEXTOS.SALVO);
          atualizarBotao();
        } else {
          status('');
          await carregar();
          status(TEXTOS.SALVO);
        }
        return;
      }
      status('');
      var t = erros.daEscrita(r);
      if (t.sessao) { sessaoCaiu(); return; }
      if (t.conflito) mostrarConflito(true);
      if (t.campos) {
        var foco = null;
        Object.keys(t.campos).forEach(function (c) {
          erroDoCampo(c, t.campos[c]);
          if (foco === null) foco = c;
        });
        aviso(TEXTOS.CORRIJA);
        if (foco !== null) $('emp-' + foco).focus();
      } else if (!t.conflito) {
        aviso(t.aviso);
      }
      atualizarBotao();
    }

    function ligar() {
      if (ligada) return;
      ligada = true;
      CAMPOS.forEach(function (c) {
        var el = $('emp-' + c);
        // Editar com a confirmação aberta a invalida (o número de campos mudou): a pessoa pede de novo, com o texto certo.
        var ao = function () { erroDoCampo(c, ''); if (confirmacaoAberta()) esconderConfirmacao(); atualizarBotao(); };
        el.addEventListener('input', ao);
        el.addEventListener('change', ao);
      });
      $('empSalvar').addEventListener('click', salvar);
      if ($('empRecarregar')) $('empRecarregar').addEventListener('click', pedirRecarga);
      if ($('empConfirmarCancelar')) $('empConfirmarCancelar').addEventListener('click', cancelarRecarga);
      if ($('empConfirmarOk')) $('empConfirmarOk').addEventListener('click', confirmarRecarga);
    }

    return {
      iniciar: async function () {
        ligar();
        mostrarConflito(false);
        aviso('');
        if ($('empLogoInserir')) $('empLogoInserir').disabled = true;
        if ($('empLogoRemover')) $('empLogoRemover').disabled = true;
        if ($('empLogoAviso')) $('empLogoAviso').textContent = TEXTOS.LOGO_BREVE;
        if (!cap.editar) {
          travarCampos();
          $('empSalvar').style.display = 'none';
          if ($('empLeitura')) { $('empLeitura').textContent = TEXTOS.LEITURA; $('empLeitura').style.display = ''; }
        }
        $('empSalvar').disabled = true;
        await carregar();
      },
      encerrar: function () { encerrada = true; },
    };
  }

  global.EpiDadosEmpresa = {
    CAMINHO: CAMINHO, CAMPOS: CAMPOS, TEXTOS: TEXTOS,
    acoes: acoes, modelo: modelo, formulario: formulario, erros: erros, capacidades: capacidades, criarTela: criarTela,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiDadosEmpresa;
})(typeof window !== 'undefined' ? window : globalThis);
