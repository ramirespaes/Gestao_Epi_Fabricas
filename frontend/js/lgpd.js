(function (global) {
  'use strict';

  /**
   * EpiLgpd — Privacidade e LGPD do Portal Empresarial (pages/lgpd.html), página de CONSULTA, com a gestão do encarregado
   * (DPO) do Pacote LGPD-1.
   *
   * Rotas, sempre da empresa da SESSÃO (o navegador nunca informa empresa):
   *   GET  /lgpd/resumo                     (lgpd.visualizar) → { controladora, titulares, encarregado: { principal, substituto } }
   *   GET  /lgpd/encarregados               (lgpdEncarregado.visualizar) → vigentes com id e versão
   *   POST /lgpd/encarregados               (lgpdEncarregado.editar) designar
   *   POST /lgpd/encarregados/:id/substituir | /contato | /encerrar
   *
   * Só o que o servidor mediu entra na tela: funcionários e usuários nunca são somados nem chamados de "todos os
   * titulares"; o encarregado só aparece quando há designação vigente. Solicitações de titulares, política e retenção
   * continuam sem fonte: indisponíveis ou pendentes de validação. A gestão do encarregado abre só com `capacidades.
   * editarEncarregado` (recurso exclusivo do MASTER, decidido pelo servidor a cada chamada; a tela nunca decide pelo perfil).
   *
   * Todo texto do servidor entra no DOM só por textContent/value; nada vai para armazenamento do navegador.
   */

  var CAMINHO = '/lgpd/resumo';
  var CAMINHO_ENCARREGADOS = '/lgpd/encarregados';
  var VAZIO = '—';
  var NAO_CADASTRADO = 'Não cadastrado';
  var FUNCOES = ['PRINCIPAL', 'SUBSTITUTO'];
  var TIPOS_PESSOA = ['PF', 'PJ'];
  var VINCULOS = ['INTERNO', 'EXTERNO'];
  var CONFLITOS = ['NAO_AVALIADO', 'SEM_CONFLITO', 'COM_CONFLITO_MITIGADO'];
  var OPERACOES = ['DESIGNAR', 'SUBSTITUIR', 'CONTATO', 'ENCERRAR'];
  var CAMPOS_DESIGNACAO = ['funcao', 'tipoPessoa', 'nome', 'razaoSocial', 'cnpj', 'vinculo', 'cargo', 'email', 'telefone', 'inicioEm', 'atoReferencia', 'atoData', 'conflitoInteresses', 'conflitoNota'];
  var CNPJ_CANONICO = /^[0-9A-Z]{12}[0-9]{2}$/; // regra canônica do SafeWork (14 posições); os dígitos verificadores são do servidor

  var TEXTOS = {
    CARREGANDO: 'Carregando…',
    INDISPONIVEL: 'Indisponível no momento',
    FALHA: 'Não foi possível carregar as informações desta empresa agora. Recarregue a página para tentar novamente.',
    SOLICITACOES_INDISPONIVEL: 'Registro ainda não disponível neste sistema',
    CONFORMIDADE_INDISPONIVEL: 'Avaliação não disponível',
    DPO_GESTAO: 'Designação, substituição, correção de contato e encerramento do encarregado ficam registrados com histórico e auditoria. A divulgação pública ainda não está disponível neste sistema.',
    DPO_SOMENTE_CONSULTA: 'A designação do encarregado (principal e substituto) é administrada pelo perfil Master, com histórico e auditoria. O canal do encarregado deve ser divulgado aos funcionários para o exercício dos direitos do titular (art. 18 LGPD); a divulgação pública ainda não está disponível neste sistema.',
    DPO_FALHA_GESTAO: 'Não foi possível carregar a gestão do encarregado. A consulta continua disponível.',
    DPO_SALVANDO: 'Salvando…',
    DPO_SALVO: { DESIGNAR: 'Encarregado designado.', SUBSTITUIR: 'Encarregado substituído; o anterior ficou no histórico.', CONTATO: 'Contato corrigido; o registro anterior ficou no histórico.', ENCERRAR: 'Designação encerrada.' },
    DPO_SEM_VIGENTE: 'Não há designação vigente para esta função.',
    DPO_JA_VIGENTE: 'Já existe uma designação vigente para esta função: use "Substituir".',
    DPO_VERSAO: 'A designação foi alterada por outra pessoa. Recarregue a página.',
    DPO_SEM_ALTERACAO: 'Nenhum contato foi alterado.',
    CNPJ_NAO_INFORMADO: 'não informado',
    DPO_FUNCAO_DIVERGENTE: 'A substituição mantém a função da designação substituída.',
    /** @param {string} inicioBr início do vigente em DD/MM/AAAA */
    dpoPeriodoInvalido: function (inicioBr) {
      return 'A data de encerramento do vigente não pode ser anterior ao início da designação dele (' + inicioBr + '). Informe, em "Data de encerramento do vigente", uma data a partir desse início.';
    },
    /** @param {string} inicioBr @param {boolean} padraoHoje se o campo vazio usa hoje */
    rotuloFimVigente: function (inicioBr) {
      return 'Data de encerramento do vigente (opcional; padrão: hoje; início registrado do vigente: ' + inicioBr + ')';
    },
    ROTULO_FIM_VIGENTE: 'Data de encerramento do vigente (opcional; padrão: hoje)',
    DPO_PERMISSAO: 'Você não tem autorização para esta operação.',
    DPO_REDE: 'Não foi possível falar com o servidor. Verifique sua conexão e tente novamente.',
    DPO_GENERICO: 'Não foi possível concluir agora. Tente novamente.',
    CORRIJA: 'Corrija os campos destacados: ',
    detalheFuncionarios: function (f) {
      return plural(f.ativos, 'ativo', 'ativos') + ' · ' + plural(f.afastados, 'afastado', 'afastados') + ' · ' + plural(f.inativos, 'inativo', 'inativos');
    },
    detalheUsuarios: function (u) { return plural(u.ativos, 'ativo', 'ativos'); },
  };
  var POR_CODIGO = {
    LGPD_DPO_JA_VIGENTE: TEXTOS.DPO_JA_VIGENTE,
    LGPD_DPO_VERSAO_DESATUALIZADA: TEXTOS.DPO_VERSAO,
    LGPD_DPO_NAO_VIGENTE: TEXTOS.DPO_VERSAO,
    LGPD_DPO_NAO_ENCONTRADO: TEXTOS.DPO_VERSAO,
    LGPD_DPO_SEM_ALTERACAO: TEXTOS.DPO_SEM_ALTERACAO,
    LGPD_DPO_CNPJ_IMUTAVEL: 'O CNPJ já gravado não é corrigido por aqui: outra pessoa jurídica é uma substituição.',
    LGPD_DPO_CNPJ_NAO_SE_APLICA: 'Só o encarregado pessoa jurídica tem CNPJ.',
    LGPD_DPO_FUNCAO_DIVERGENTE: TEXTOS.DPO_FUNCAO_DIVERGENTE,
    LGPD_DPO_PERIODO_INVALIDO: 'A data de encerramento do vigente não pode ser anterior ao início da designação dele. Recarregue a página e informe uma data a partir do início registrado.',
    LGPD_DPO_SOMENTE_MASTER: TEXTOS.DPO_PERMISSAO,
    PERMISSAO_NEGADA: TEXTOS.DPO_PERMISSAO,
  };
  var MSG_CAMPO = {
    nome: 'nome (1 a 150 caracteres)', razaoSocial: 'razão social (obrigatória para pessoa jurídica)', cnpj: 'CNPJ (obrigatório para pessoa jurídica; 14 posições)', email: 'e-mail profissional', telefone: 'telefone (8 a 20 caracteres)',
    inicioEm: 'data de início', atoData: 'data do ato formal (exige a referência ao ato)', cargo: 'cargo (até 100 caracteres)', fimEm: 'data de encerramento', atoReferencia: 'referência ao ato', conflitoNota: 'nota (até 500 caracteres)',
  };

  function plural(n, um, varios) { return n + ' ' + (n === 1 ? um : varios); }

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/lgpd.js');
    return global.EpiHttp;
  }
  function ehObjeto(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function contagem(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0; }
  function texto(v) { return typeof v === 'string' && v.length > 0; }
  function textoOuNulo(v) { return v === null || typeof v === 'string'; }
  function inteiroPositivo(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0; }
  function exigirId(id) { if (!inteiroPositivo(id)) throw new TypeError('identificador inválido'); }

  var acoes = {
    resumo: function () { return http().requisitar('GET', CAMINHO); },
    encarregados: function () { return http().requisitar('GET', CAMINHO_ENCARREGADOS); },
    designar: function (corpo) { return http().requisitar('POST', CAMINHO_ENCARREGADOS, { corpo: corpo }); },
    substituir: function (id, corpo) { exigirId(id); return http().requisitar('POST', CAMINHO_ENCARREGADOS + '/' + id + '/substituir', { corpo: corpo }); },
    corrigirContato: function (id, corpo) { exigirId(id); return http().requisitar('POST', CAMINHO_ENCARREGADOS + '/' + id + '/contato', { corpo: corpo }); },
    encerrar: function (id, corpo) { exigirId(id); return http().requisitar('POST', CAMINHO_ENCARREGADOS + '/' + id + '/encerrar', { corpo: corpo }); },
  };

  function contatoValido(e) {
    return ehObjeto(e) && TIPOS_PESSOA.indexOf(e.tipoPessoa) !== -1 && texto(e.nome) && textoOuNulo(e.razaoSocial) && VINCULOS.indexOf(e.vinculo) !== -1
      && (e.cnpj === undefined || textoOuNulo(e.cnpj)) // ausente no backend anterior à 095; null no PF e no PJ legado
      && textoOuNulo(e.cargo) && texto(e.email) && textoOuNulo(e.telefone) && texto(e.inicioEm);
  }

  var modelo = {
    /** Só o formato exato; qualquer desvio é null (nada vira número na tela). `encarregado` é opcional (contrato do A1). */
    resumo: function (r) {
      var d = r && r.ok && ehObjeto(r.dados) ? r.dados.resumo : null;
      if (!ehObjeto(d) || !ehObjeto(d.controladora) || !ehObjeto(d.titulares)) return null;
      var c = d.controladora;
      var f = d.titulares.funcionarios;
      var u = d.titulares.usuarios;
      if (!texto(c.razaoSocial) || typeof c.cnpj !== 'string') return null;
      if (!ehObjeto(f) || !contagem(f.total) || !contagem(f.ativos) || !contagem(f.afastados) || !contagem(f.inativos)) return null;
      if (!ehObjeto(u) || !contagem(u.total) || !contagem(u.ativos)) return null;
      var encarregado = { principal: null, substituto: null };
      if (d.encarregado !== undefined) {
        if (!ehObjeto(d.encarregado)) return null;
        var p = d.encarregado.principal;
        var s = d.encarregado.substituto;
        if (p !== null && !contatoValido(p)) return null;
        if (s !== null && !contatoValido(s)) return null;
        encarregado = { principal: p === null ? null : modelo.contato(p), substituto: s === null ? null : modelo.contato(s) };
      }
      return {
        controladora: { razaoSocial: c.razaoSocial, cnpj: c.cnpj },
        titulares: {
          funcionarios: { total: f.total, ativos: f.ativos, afastados: f.afastados, inativos: f.inativos },
          usuarios: { total: u.total, ativos: u.ativos },
        },
        encarregado: encarregado,
      };
    },
    contato: function (e) {
      return { tipoPessoa: e.tipoPessoa, nome: e.nome, razaoSocial: e.razaoSocial, cnpj: typeof e.cnpj === 'string' ? e.cnpj : null, vinculo: e.vinculo, cargo: e.cargo, email: e.email, telefone: e.telefone, inicioEm: e.inicioEm };
    },
    /** Vigentes com id e versão (GET /lgpd/encarregados); null se fora do contrato. */
    encarregados: function (r) {
      var d = r && r.ok && ehObjeto(r.dados) ? r.dados.encarregados : null;
      if (!ehObjeto(d)) return null;
      var saida = {};
      var chaves = ['principal', 'substituto'];
      for (var i = 0; i < chaves.length; i += 1) {
        var e = d[chaves[i]];
        if (e === null || e === undefined) { saida[chaves[i]] = null; continue; }
        if (!contatoValido(e) || !inteiroPositivo(e.id) || !inteiroPositivo(e.versao) || FUNCOES.indexOf(e.funcao) === -1) return null;
        var c = modelo.contato(e);
        c.id = e.id; c.versao = e.versao; c.funcao = e.funcao;
        saida[chaves[i]] = c;
      }
      return saida;
    },
  };

  /** CNPJ canônico (14 posições, alfanumérico) → 00.000.000/0000-00; outra coisa volta como está. */
  function formatarCnpj(cnpj) {
    if (typeof cnpj !== 'string') return '';
    if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(cnpj)) return cnpj;
    return cnpj.slice(0, 2) + '.' + cnpj.slice(2, 5) + '.' + cnpj.slice(5, 8) + '/' + cnpj.slice(8, 12) + '-' + cnpj.slice(12);
  }

  /** O que a tela pode fazer, pelas permissões EFETIVAS do servidor; nunca pelo nome do perfil. */
  function capacidades(permissoes) {
    var P = global.EpiPermissoes;
    var pode = function (op) { return !!(P && typeof P.recurso === 'function' && P.recurso(permissoes, 'lgpdEncarregado', op)); };
    return { editarEncarregado: pode('visualizar') && pode('editar') };
  }

  // ─── Datas: a tela aceita DD/MM/AAAA, D/M/AAAA, DD/MM/AA (AA → 20AA) ou AAAA-MM-DD; o contrato do servidor é só AAAA-MM-DD ──
  var DATA_BR = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
  var DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
  function dataDeCalendario(ano, mes, dia) {
    if (ano < 1900 || ano > 2100 || mes < 1 || mes > 12 || dia < 1) return false;
    var bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
    var dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return dia <= dias[mes - 1];
  }
  function dois(n) { return (n < 10 ? '0' : '') + n; }

  // ─── Formulário do encarregado (puro, testável sem DOM) ─────────────
  var formulario = {
    /** Normaliza os valores digitados: aparados; vazio = ausente. */
    limpar: function (v) {
      if (typeof v !== 'string') return '';
      return v.trim();
    },
    /** CNPJ digitado/colado → 14 posições canônicas (sem máscara, maiúsculas); '' para vazio; null se o formato não fecha. */
    normalizarCnpj: function (texto) {
      var t = formulario.limpar(texto).replace(/[.\-/\s]/g, '').toUpperCase();
      if (t === '') return '';
      return CNPJ_CANONICO.test(t) ? t : null;
    },
    /** Máscara 00.000.000/0000-00 enquanto digita (aceita letras nas 12 primeiras posições, como a regra canônica). */
    mascaraCnpj: function (texto) {
      var t = String(texto || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase().slice(0, 14);
      var s = t.slice(0, 2);
      if (t.length > 2) s += '.' + t.slice(2, 5);
      if (t.length > 5) s += '.' + t.slice(5, 8);
      if (t.length > 8) s += '/' + t.slice(8, 12);
      if (t.length > 12) s += '-' + t.slice(12);
      return s;
    },
    /** Data digitada/colada → AAAA-MM-DD; '' para vazio; null quando não é uma data válida de calendário. */
    normalizarData: function (texto) {
      var t = formulario.limpar(texto);
      if (t === '') return '';
      var ano; var mes; var dia;
      var m = DATA_BR.exec(t);
      if (m) {
        dia = Number(m[1]); mes = Number(m[2]); ano = Number(m[3]);
        if (m[3].length === 2) ano += 2000; // 26 → 2026 (regra explícita: dois dígitos são sempre do século 21)
      } else {
        m = DATA_ISO.exec(t);
        if (!m) return null;
        ano = Number(m[1]); mes = Number(m[2]); dia = Number(m[3]);
      }
      return dataDeCalendario(ano, mes, dia) ? ano + '-' + dois(mes) + '-' + dois(dia) : null;
    },
    /** AAAA-MM-DD → DD/MM/AAAA (só para mostrar); qualquer outra coisa volta como está. */
    dataParaBr: function (iso) {
      var m = DATA_ISO.exec(typeof iso === 'string' ? iso : '');
      return m ? m[3] + '/' + m[2] + '/' + m[1] : (typeof iso === 'string' ? iso : '');
    },
    /**
     * Máscara progressiva só para quem digita dígitos corridos (2710 → 27/10). Texto com barras ou hífen (digitado assim, ou
     * colado em D/M/AAAA, DD/MM/AA, AAAA-MM-DD) é preservado, só sem caracteres estranhos: a validação fica em normalizarData.
     */
    mascaraData: function (texto) {
      var t = String(texto || '').trim().replace(/[^\d/-]/g, '').slice(0, 10);
      if (t.indexOf('/') !== -1 || t.indexOf('-') !== -1) return t;
      var d = t.slice(0, 8);
      if (d.length <= 2) return d;
      if (d.length <= 4) return d.slice(0, 2) + '/' + d.slice(2);
      return d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4);
    },
    /** @returns {{ok: true, corpo} | {ok: false, campos: string[]}} corpo EXATO do contrato (sem chaves vazias nem extras). */
    corpoDesignacao: function (valores) {
      var v = {};
      for (var i = 0; i < CAMPOS_DESIGNACAO.length; i += 1) v[CAMPOS_DESIGNACAO[i]] = formulario.limpar(valores[CAMPOS_DESIGNACAO[i]]);
      var campos = [];
      if (FUNCOES.indexOf(v.funcao) === -1) campos.push('funcao');
      if (TIPOS_PESSOA.indexOf(v.tipoPessoa) === -1) campos.push('tipoPessoa');
      if (VINCULOS.indexOf(v.vinculo) === -1) campos.push('vinculo');
      if (CONFLITOS.indexOf(v.conflitoInteresses) === -1) campos.push('conflitoInteresses');
      if (v.nome.length < 1 || v.nome.length > 150) campos.push('nome');
      if (v.tipoPessoa === 'PJ' && (v.razaoSocial.length < 1 || v.razaoSocial.length > 150)) campos.push('razaoSocial');
      var cnpj = v.tipoPessoa === 'PJ' ? formulario.normalizarCnpj(v.cnpj) : '';
      if (v.tipoPessoa === 'PJ' && !cnpj) campos.push('cnpj');
      if (v.email.length < 3 || v.email.length > 150 || v.email.indexOf('@') === -1) campos.push('email');
      if (v.telefone !== '' && (v.telefone.length < 8 || v.telefone.length > 20)) campos.push('telefone');
      if (v.cargo.length > 100) campos.push('cargo');
      var inicioEm = formulario.normalizarData(v.inicioEm);
      var atoData = formulario.normalizarData(v.atoData);
      if (!inicioEm) campos.push('inicioEm');
      if (v.atoReferencia.length > 200) campos.push('atoReferencia');
      if (atoData === null || (atoData !== '' && v.atoReferencia === '')) campos.push('atoData');
      if (v.conflitoNota.length > 500) campos.push('conflitoNota');
      if (campos.length > 0) return { ok: false, campos: campos };
      var corpo = { funcao: v.funcao, tipoPessoa: v.tipoPessoa, nome: v.nome, vinculo: v.vinculo, email: v.email, inicioEm: inicioEm, conflitoInteresses: v.conflitoInteresses };
      if (v.tipoPessoa === 'PJ') { corpo.razaoSocial = v.razaoSocial; corpo.cnpj = cnpj; }
      if (v.cargo !== '') corpo.cargo = v.cargo;
      if (v.telefone !== '') corpo.telefone = v.telefone;
      if (v.atoReferencia !== '') corpo.atoReferencia = v.atoReferencia;
      if (atoData !== '') corpo.atoData = atoData;
      if (v.conflitoNota !== '') corpo.conflitoNota = v.conflitoNota;
      return { ok: true, corpo: corpo };
    },
    /** O CNPJ só entra aqui para COMPLETAR o legado: vigente PJ sem CNPJ (nunca para trocar um CNPJ gravado; isso é Substituição). */
    corpoContato: function (vigente, valores) {
      var email = formulario.limpar(valores.email);
      var telefone = formulario.limpar(valores.telefone);
      var cargo = formulario.limpar(valores.cargo);
      var cnpjAceito = vigente.tipoPessoa === 'PJ' && !vigente.cnpj;
      var cnpj = cnpjAceito ? formulario.normalizarCnpj(valores.cnpj) : '';
      var campos = [];
      if (email !== '' && (email.length < 3 || email.length > 150 || email.indexOf('@') === -1)) campos.push('email');
      if (telefone !== '' && (telefone.length < 8 || telefone.length > 20)) campos.push('telefone');
      if (cargo.length > 100) campos.push('cargo');
      if (cnpj === null) campos.push('cnpj');
      if (campos.length > 0) return { ok: false, campos: campos };
      var corpo = { versao: vigente.versao };
      if (email !== '' && email !== vigente.email) corpo.email = email;
      if (telefone !== (vigente.telefone || '')) corpo.telefone = telefone === '' ? null : telefone;
      if (cargo !== (vigente.cargo || '')) corpo.cargo = cargo === '' ? null : cargo;
      if (cnpjAceito && cnpj !== '') corpo.cnpj = cnpj;
      if (Object.keys(corpo).length === 1) return { ok: false, campos: [], semAlteracao: true };
      return { ok: true, corpo: corpo };
    },
    /** Dia civil de hoje em São Paulo (AAAA-MM-DD), o mesmo "hoje" que o servidor usa quando a data fica vazia. */
    hojeSaoPaulo: function () {
      var partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      return DATA_ISO.test(partes) ? partes : '';
    },
    /**
     * Regra local igual à do servidor: o encerramento (informado, ou hoje quando vazio) não pode ser anterior ao início do
     * vigente. Devolve null quando está tudo certo; senão { fimEfetivo, inicio } para a mensagem. O servidor continua decidindo.
     */
    periodoInvalido: function (vigente, fimEm, hoje) {
      if (!vigente || typeof vigente.inicioEm !== 'string') return null;
      var efetivo = fimEm || hoje || '';
      if (efetivo === '' || efetivo >= vigente.inicioEm) return null;
      return { fimEfetivo: efetivo, inicio: vigente.inicioEm };
    },
    corpoEncerramento: function (vigente, valores, hoje) {
      var fimEm = formulario.normalizarData(valores.fimEm);
      if (fimEm === null) return { ok: false, campos: ['fimEm'] };
      var periodo = formulario.periodoInvalido(vigente, fimEm, hoje === undefined ? formulario.hojeSaoPaulo() : hoje);
      if (periodo !== null) return { ok: false, campos: ['fimEm'], periodo: periodo };
      var corpo = { versao: vigente.versao };
      if (fimEm !== '') corpo.fimEm = fimEm;
      return { ok: true, corpo: corpo };
    },
    /** Texto do erro do servidor, sempre pela tabela da tela (nunca o texto do servidor). */
    erroDoServidor: function (r) {
      if (!r || r.ok) return '';
      if (http().ehFalhaDeRede(r)) return TEXTOS.DPO_REDE;
      if (r.status === 400 && Array.isArray(r.detalhes) && r.detalhes.length > 0) {
        var nomes = [];
        for (var i = 0; i < r.detalhes.length; i += 1) {
          var campo = String(r.detalhes[i].campo || '').replace(/^body\./, '');
          nomes.push(MSG_CAMPO[campo] || campo || 'dados');
        }
        return TEXTOS.CORRIJA + nomes.join(', ') + '.';
      }
      if (r.codigo && POR_CODIGO[r.codigo]) return POR_CODIGO[r.codigo];
      if (r.status === 403) return TEXTOS.DPO_PERMISSAO;
      return TEXTOS.DPO_GENERICO;
    },
  };

  // ─── Estado do modal no fragmento da URL ─────────────────────────
  // Sobrevive ao F5 sem armazenamento do navegador. Só operação, função e id da empresa da sessão que gravou (nunca o que foi
  // digitado): `#dpo=<OPERACAO>.<FUNCAO>.e<empresaId>`. O id da empresa só evita reabrir noutra empresa na mesma aba; sessão e
  // permissão são sempre revalidadas pela página antes de restaurar.
  var FRAGMENTO =/^#dpo=(DESIGNAR|SUBSTITUIR|CONTATO|ENCERRAR)\.(PRINCIPAL|SUBSTITUTO)\.e([1-9][0-9]{0,9})$/;
  var fragmento = {
    /** @returns {{operacao: string, funcao: string, empresaId: number}|null} null para qualquer formato fora do contrato. */
    ler: function (hash) {
      var m = FRAGMENTO.exec(typeof hash === 'string' ? hash : '');
      return m ? { operacao: m[1], funcao: m[2], empresaId: Number(m[3]) } : null;
    },
    montar: function (operacao, funcao, empresaId) {
      if (OPERACOES.indexOf(operacao) === -1 || FUNCOES.indexOf(funcao) === -1) return null;
      if (!(Number.isInteger(empresaId) && empresaId > 0)) return null;
      return '#dpo=' + operacao + '.' + funcao + '.e' + empresaId;
    },
    /** Verdadeiro quando o fragmento atual é do DPO (válido ou não): é o que a página apaga. */
    ehDoDpo: function (hash) { return typeof hash === 'string' && hash.indexOf('#dpo=') === 0; },
  };

  /**
   * @param {{documento?: Document, capacidades?: {editarEncarregado: boolean}, empresaId?: number, aoSessaoEncerrada?: Function, aoSemAutorizacao?: Function}} opcoes
   * @returns {{iniciar: Function, encerrar: Function}}
   */
  function criarTela(opcoes) {
    var o = opcoes || {};
    var doc = o.documento || global.document;
    var cap = o.capacidades || { editarEncarregado: false };
    var empresaId = Number.isInteger(o.empresaId) && o.empresaId > 0 ? o.empresaId : null; // da sessão validada, nunca da URL
    var $ = function (id) { return doc.getElementById(id); };
    var encerrada = false;
    var vigentes = null; // com id e versão, só para quem gere
    var salvando = false;
    var modalLigado = false;
    var focoAnterior = null; // quem tinha o foco ao abrir o modal; recebe-o de volta ao fechar
    var basePreenchida = {}; // valores que a própria tela preencheu (contato do vigente): não contam como "digitado"
    var avisoLigado = false;

    // ── fragmento da URL (replaceState: nunca cria entrada no histórico) ──
    function urlSemFragmento() {
      var l = global.location;
      return l ? String(l.pathname || '') + String(l.search || '') : null;
    }
    function trocarUrl(destino) {
      var h = global.history;
      if (!h || typeof h.replaceState !== 'function' || destino === null) return;
      try { h.replaceState(h.state === undefined ? null : h.state, '', destino); } catch (e) { /* URL inalterável aqui: segue sem restauração */ }
    }
    function gravarFragmento() {
      var alvo = fragmento.montar(valorCampo('acao'), valorCampo('funcao'), empresaId);
      if (alvo === null) return;
      var base = urlSemFragmento();
      if (base !== null) trocarUrl(base + alvo);
    }
    function apagarFragmento() {
      var l = global.location;
      if (!l || !fragmento.ehDoDpo(l.hash)) return;
      trocarUrl(urlSemFragmento());
    }

    function definir(id, valor) { var el = $(id); if (el) el.textContent = valor; }
    function aviso(t) {
      var caixa = $('lgpdAviso');
      if (!caixa) return;
      caixa.textContent = t || '';
      caixa.style.display = t ? '' : 'none';
    }
    function indicadores(valorFuncionarios, detalheFuncionarios, valorUsuarios, detalheUsuarios) {
      definir('lgpdKpiFuncionarios', valorFuncionarios);
      definir('lgpdKpiFuncionariosDetalhe', detalheFuncionarios);
      definir('lgpdKpiUsuarios', valorUsuarios);
      definir('lgpdKpiUsuariosDetalhe', detalheUsuarios);
      definir('lgpdKpiSolicitacoes', VAZIO);
      definir('lgpdKpiSolicitacoesDetalhe', TEXTOS.SOLICITACOES_INDISPONIVEL);
      definir('lgpdKpiConformidade', VAZIO);
      definir('lgpdKpiConformidadeDetalhe', TEXTOS.CONFORMIDADE_INDISPONIVEL);
    }
    function nomeECargo(e) {
      var base = e.nome;
      if (e.tipoPessoa === 'PJ') base = e.razaoSocial + ' (CNPJ ' + (e.cnpj ? formatarCnpj(e.cnpj) : TEXTOS.CNPJ_NAO_INFORMADO) + ') · ' + e.nome;
      return e.cargo ? base + ' — ' + e.cargo : base;
    }
    function mostrarEncarregado(enc) {
      var p = enc ? enc.principal : null;
      var s = enc ? enc.substituto : null;
      definir('dpoNome', p ? nomeECargo(p) : NAO_CADASTRADO);
      definir('dpoEmail', p ? p.email : NAO_CADASTRADO);
      definir('dpoTel', p && p.telefone ? p.telefone : NAO_CADASTRADO);
      definir('dpoSubNome', s ? nomeECargo(s) : NAO_CADASTRADO);
      definir('dpoSubEmail', s ? s.email : NAO_CADASTRADO);
    }
    function limpar(detalhe) {
      indicadores(VAZIO, detalhe, VAZIO, detalhe);
      definir('lgpdEmpresa', '');
      definir('dpoEmpresa', VAZIO);
      mostrarEncarregado(null);
      definir('dpoStatus', '');
      var botao = $('dpoEditar');
      if (botao) botao.disabled = true;
    }
    function mostrar(m) {
      indicadores(String(m.titulares.funcionarios.total), TEXTOS.detalheFuncionarios(m.titulares.funcionarios),
        String(m.titulares.usuarios.total), TEXTOS.detalheUsuarios(m.titulares.usuarios));
      var cnpj = formatarCnpj(m.controladora.cnpj);
      definir('lgpdEmpresa', m.controladora.razaoSocial + (cnpj ? ' · CNPJ ' + cnpj : ''));
      definir('dpoEmpresa', m.controladora.razaoSocial);
      mostrarEncarregado(m.encarregado);
    }

    // ─── Gestão do encarregado ──────────────────────────────────────
    function botaoGestao(ativo) {
      var botao = $('dpoEditar');
      if (botao) botao.disabled = !ativo;
      definir('dpoIndisponivel', ativo ? TEXTOS.DPO_GESTAO : TEXTOS.DPO_SOMENTE_CONSULTA);
    }
    async function carregarGestao() {
      if (!cap.editarEncarregado) { botaoGestao(false); apagarFragmento(); return false; }
      var r = await acoes.encarregados();
      if (encerrada) return false;
      if (http().ehNaoAutenticado(r)) { sessaoCaiu(); return false; }
      var m = modelo.encarregados(r);
      if (m === null) {
        // 403 (permissão retirada) ou falha: a consulta segue; a gestão fica fechada.
        vigentes = null;
        botaoGestao(false);
        apagarFragmento();
        definir('dpoStatus', r.ok ? TEXTOS.DPO_FALHA_GESTAO : (r.status === 403 ? '' : TEXTOS.DPO_FALHA_GESTAO));
        return false;
      }
      vigentes = m;
      botaoGestao(true);
      ligarModal();
      restaurarDoFragmento();
      return true;
    }
    function sessaoCaiu() {
      encerrada = true;
      apagarFragmento();
      desligarAviso();
      limpar(TEXTOS.INDISPONIVEL);
      if (typeof o.aoSessaoEncerrada === 'function') o.aoSessaoEncerrada();
    }
    function valorCampo(id) { var el = $('dpo-' + id); return el ? el.value : ''; }
    function definirCampo(id, v) { var el = $('dpo-' + id); if (el) el.value = v === null || v === undefined ? '' : String(v); }
    function mensagemModal(t) { definir('dpoModalMsg', t || ''); }
    function vigenteDaFuncao() {
      if (!vigentes) return null;
      return valorCampo('funcao') === 'PRINCIPAL' ? vigentes.principal : vigentes.substituto;
    }
    /** Mostra só os campos da operação escolhida; sem vigente, só Designar faz sentido (e vice-versa). */
    function ajustarCampos() {
      var operacao = valorCampo('acao');
      if (OPERACOES.indexOf(operacao) === -1) operacao = 'DESIGNAR';
      var vigente = vigenteDaFuncao();
      // Em "corrigir contato" quem decide PJ é o vigente; o CNPJ só aparece ali para completar o legado sem CNPJ.
      var pj = operacao === 'CONTATO' ? Boolean(vigente && vigente.tipoPessoa === 'PJ') : valorCampo('tipoPessoa') === 'PJ';
      var cnpjCompletavel = operacao !== 'CONTATO' || Boolean(vigente && vigente.tipoPessoa === 'PJ' && !vigente.cnpj);
      var grupos = { DESIGNAR: ['designacao'], SUBSTITUIR: ['designacao', 'substituir'], CONTATO: ['contato'], ENCERRAR: ['encerrar'] };
      var visiveis = grupos[operacao];
      var campos = doc.querySelectorAll ? doc.querySelectorAll('[data-dpo-campo]') : [];
      Array.prototype.forEach.call(campos, function (el) {
        var tags = String(el.getAttribute('data-dpo-campo') || '').split(' ');
        var mostra = tags.some(function (t) { return visiveis.indexOf(t) !== -1; });
        if (mostra && el.hasAttribute('data-dpo-pj') && !pj) mostra = false;
        if (mostra && el.hasAttribute('data-dpo-cnpj') && !cnpjCompletavel) mostra = false;
        el.style.display = mostra ? '' : 'none';
      });
      definir('dpo-nome-rotulo', pj ? 'Pessoa natural responsável (nome completo)' : 'Nome completo');
      // Em Substituir e Encerrar, o início registrado do vigente aparece no rótulo: o encerramento não pode ser anterior a ele.
      definir('dpo-fimEm-rotulo', (operacao === 'SUBSTITUIR' || operacao === 'ENCERRAR') && vigente !== null && vigente.inicioEm
        ? TEXTOS.rotuloFimVigente(formulario.dataParaBr(vigente.inicioEm)) : TEXTOS.ROTULO_FIM_VIGENTE);
      var incoerente = (operacao === 'DESIGNAR' && vigente !== null) || (operacao !== 'DESIGNAR' && vigente === null);
      mensagemModal(incoerente ? (vigente === null ? TEXTOS.DPO_SEM_VIGENTE : TEXTOS.DPO_JA_VIGENTE) : '');
      var salvar = $('dpoModalSalvar');
      if (salvar) salvar.disabled = incoerente || salvando;
      basePreenchida = {};
      if (operacao === 'CONTATO' && vigente !== null) {
        definirCampo('email', vigente.email);
        definirCampo('telefone', vigente.telefone);
        definirCampo('cargo', vigente.cargo);
        definirCampo('cnpj', '');
        basePreenchida = { email: vigente.email || '', telefone: vigente.telefone || '', cargo: vigente.cargo || '', cnpj: '' };
      }
    }
    function modalAberto() { var m = $('dpoModal'); return Boolean(m && m.classList.contains('open')); }
    /** Abre o modal; `inicial` (operação e função) vem só da restauração após F5, já validado pelo fragmento. */
    function abrirModal(inicial) {
      if (!vigentes) return;
      var modal = $('dpoModal');
      if (!modal) return;
      CAMPOS_DESIGNACAO.concat(['fimEm']).forEach(function (c) { definirCampo(c, ''); });
      definirCampo('funcao', vigentes.principal === null ? 'PRINCIPAL' : (vigentes.substituto === null ? 'SUBSTITUTO' : 'PRINCIPAL'));
      definirCampo('acao', vigenteDaFuncao() === null ? 'DESIGNAR' : 'SUBSTITUIR');
      if (inicial) { definirCampo('funcao', inicial.funcao); definirCampo('acao', inicial.operacao); }
      definirCampo('tipoPessoa', 'PF');
      definirCampo('vinculo', 'INTERNO');
      definirCampo('conflitoInteresses', 'NAO_AVALIADO');
      definirCampo('conflito', 'NAO_AVALIADO');
      ajustarCampos();
      focoAnterior = (inicial ? null : doc.activeElement) || $('dpoEditar');
      modal.classList.add('open');
      gravarFragmento();
      ligarAviso();
      var primeiro = $('dpo-funcao');
      if (primeiro && typeof primeiro.focus === 'function') primeiro.focus();
    }
    function fecharModal() {
      var modal = $('dpoModal');
      var estavaAberto = modal && modal.classList.contains('open');
      if (modal) modal.classList.remove('open');
      mensagemModal('');
      apagarFragmento();
      desligarAviso();
      // Devolve o foco a quem abriu (o botão de gestão), só quando o modal estava mesmo aberto.
      if (estavaAberto && focoAnterior && typeof focoAnterior.focus === 'function') focoAnterior.focus();
      focoAnterior = null;
    }
    /** Restaura o modal gravado no fragmento, só depois de sessão e permissão confirmadas (vigentes carregados). */
    function restaurarDoFragmento() {
      var l = global.location;
      if (!l || !fragmento.ehDoDpo(l.hash)) return;
      var f = fragmento.ler(l.hash);
      if (f === null || !cap.editarEncarregado || !vigentes || empresaId === null || f.empresaId !== empresaId) { apagarFragmento(); return; }
      if (modalAberto()) return; // reler os vigentes depois de um 409 não reinicia o formulário
      abrirModal({ operacao: f.operacao, funcao: f.funcao });
    }
    // ── alterações não salvas: aviso nativo do navegador ao sair/recarregar, só com o modal aberto e algo digitado ──
    function estaOculto(el, raiz) {
      for (var p = el; p && p !== raiz; p = p.parentNode) if (p.style && p.style.display === 'none') return true;
      return false;
    }
    function estaSujo() {
      if (!modalAberto()) return false;
      var modal = $('dpoModal');
      var ids = ['nome', 'razaoSocial', 'cnpj', 'cargo', 'email', 'telefone', 'inicioEm', 'atoReferencia', 'atoData', 'conflitoNota', 'fimEm'];
      return ids.some(function (id) {
        var el = $('dpo-' + id);
        if (!el || estaOculto(el, modal)) return false;
        var base = Object.prototype.hasOwnProperty.call(basePreenchida, id) ? basePreenchida[id] : '';
        return String(el.value || '') !== String(base || '');
      });
    }
    function aoDescarregar(ev) {
      if (!estaSujo()) return undefined;
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
      if (ev) ev.returnValue = ''; // texto genérico do navegador; não é personalizável
      return '';
    }
    function ligarAviso() {
      if (avisoLigado || typeof global.addEventListener !== 'function') return;
      global.addEventListener('beforeunload', aoDescarregar);
      avisoLigado = true;
    }
    function desligarAviso() {
      if (!avisoLigado || typeof global.removeEventListener !== 'function') return;
      global.removeEventListener('beforeunload', aoDescarregar);
      avisoLigado = false;
    }
    /** Elementos focáveis do modal, na ordem do DOM, ignorando desabilitados e os campos ocultos pela operação. */
    function focaveisDoModal(modal) {
      var todos = modal.querySelectorAll('button, input, select, textarea, [tabindex]');
      var lista = [];
      for (var i = 0; i < todos.length; i += 1) {
        var el = todos[i];
        if (el.disabled || (el.getAttribute && el.getAttribute('tabindex') === '-1')) continue;
        var oculto = false;
        for (var p = el; p && p !== modal; p = p.parentNode) {
          if (p.style && p.style.display === 'none') { oculto = true; break; }
        }
        if (!oculto) lista.push(el);
      }
      return lista;
    }
    // Escape = Cancelar; Tab e Shift+Tab ficam dentro do modal enquanto ele está aberto. Clique fora não fecha (evita perder o digitado).
    function teclaNoModal(ev) {
      var modal = $('dpoModal');
      if (!modal || !modal.classList.contains('open')) return;
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        if (ev.preventDefault) ev.preventDefault();
        fecharModal();
        return;
      }
      if (ev.key !== 'Tab') return;
      var lista = focaveisDoModal(modal);
      if (lista.length === 0) return;
      var primeiro = lista[0];
      var ultimo = lista[lista.length - 1];
      var ativo = doc.activeElement;
      var dentro = ativo && modal.contains(ativo);
      if (ev.shiftKey) {
        if (!dentro || ativo === primeiro) { if (ev.preventDefault) ev.preventDefault(); ultimo.focus(); }
      } else if (!dentro || ativo === ultimo) {
        if (ev.preventDefault) ev.preventDefault();
        primeiro.focus();
      }
    }
    function valoresDesignacao() {
      var v = {};
      CAMPOS_DESIGNACAO.forEach(function (c) { v[c] = valorCampo(c); });
      v.conflitoInteresses = valorCampo('conflito');
      return v;
    }
    async function salvar() {
      if (salvando || encerrada || !vigentes) return;
      var operacao = valorCampo('acao');
      var vigente = vigenteDaFuncao();
      var preparado;
      var enviar;
      if (operacao === 'DESIGNAR') {
        if (vigente !== null) { mensagemModal(TEXTOS.DPO_JA_VIGENTE); return; }
        preparado = formulario.corpoDesignacao(valoresDesignacao());
        enviar = function (corpo) { return acoes.designar(corpo); };
      } else if (operacao === 'SUBSTITUIR') {
        if (vigente === null) { mensagemModal(TEXTOS.DPO_SEM_VIGENTE); return; }
        preparado = formulario.corpoDesignacao(valoresDesignacao());
        if (preparado.ok) {
          preparado.corpo.versao = vigente.versao;
          var fim = formulario.normalizarData(valorCampo('fimEm'));
          var periodo = fim === null ? null : formulario.periodoInvalido(vigente, fim, formulario.hojeSaoPaulo());
          if (fim === null) preparado = { ok: false, campos: ['fimEm'] };
          else if (periodo !== null) preparado = { ok: false, campos: ['fimEm'], periodo: periodo };
          else if (fim !== '') preparado.corpo.fimAnteriorEm = fim;
        }
        enviar = function (corpo) { return acoes.substituir(vigente.id, corpo); };
      } else if (operacao === 'CONTATO') {
        if (vigente === null) { mensagemModal(TEXTOS.DPO_SEM_VIGENTE); return; }
        preparado = formulario.corpoContato(vigente, { email: valorCampo('email'), telefone: valorCampo('telefone'), cargo: valorCampo('cargo'), cnpj: valorCampo('cnpj') });
        if (!preparado.ok && preparado.semAlteracao) { mensagemModal(TEXTOS.DPO_SEM_ALTERACAO); return; }
        enviar = function (corpo) { return acoes.corrigirContato(vigente.id, corpo); };
      } else if (operacao === 'ENCERRAR') {
        if (vigente === null) { mensagemModal(TEXTOS.DPO_SEM_VIGENTE); return; }
        preparado = formulario.corpoEncerramento(vigente, { fimEm: valorCampo('fimEm') });
        enviar = function (corpo) { return acoes.encerrar(vigente.id, corpo); };
      } else {
        return;
      }
      if (!preparado.ok) {
        if (preparado.periodo) { mensagemModal(TEXTOS.dpoPeriodoInvalido(formulario.dataParaBr(preparado.periodo.inicio))); return; }
        mensagemModal(TEXTOS.CORRIJA + preparado.campos.map(function (c) { return MSG_CAMPO[c] || c; }).join(', ') + '.');
        return;
      }
      salvando = true;
      var botao = $('dpoModalSalvar');
      if (botao) botao.disabled = true;
      mensagemModal(TEXTOS.DPO_SALVANDO);
      var r = await enviar(preparado.corpo);
      salvando = false;
      if (botao) botao.disabled = false;
      if (encerrada) return;
      if (http().ehNaoAutenticado(r)) { fecharModal(); sessaoCaiu(); return; }
      if (!r.ok) {
        mensagemModal(formulario.erroDoServidor(r));
        if (r.status === 409 || r.status === 404) await recarregarGestao();
        return;
      }
      fecharModal();
      definir('dpoStatus', TEXTOS.DPO_SALVO[operacao]);
      await recarregarGestao();
    }
    /** Relê vigentes (ids e versões) e o resumo (apresentação), depois de qualquer escrita ou conflito. */
    async function recarregarGestao() {
      var r = await acoes.resumo();
      if (encerrada) return;
      var m = modelo.resumo(r);
      if (m !== null) mostrar(m);
      await carregarGestao();
    }
    // ── campos de data: texto (digitar/colar) + calendário nativo escondido, aberto pelo botão via showPicker() ──
    var CAMPOS_DATA = ['inicioEm', 'atoData', 'fimEm'];
    function ligarCampoData(id) {
      var texto = $('dpo-' + id);
      var seletor = $('dpo-' + id + '-seletor');
      var botao = $('dpo-' + id + '-abrir');
      if (!texto) return;
      var liga = function (el, evento, fn) { if (el && typeof el.addEventListener === 'function') el.addEventListener(evento, fn); };
      liga(texto, 'input', function () {
        var mascarado = formulario.mascaraData(texto.value);
        if (mascarado !== texto.value) texto.value = mascarado;
        if (seletor) { var iso = formulario.normalizarData(texto.value); seletor.value = iso || ''; }
      });
      if (!seletor) return;
      // Sem showPicker (navegador antigo): o calendário nativo fica visível ao lado do texto, no fluxo do Tab, e o botão some.
      var mostrarSeletor = function () {
        seletor.style.display = '';
        seletor.removeAttribute('tabindex');
        seletor.removeAttribute('aria-hidden');
        seletor.setAttribute('aria-label', 'Selecionar no calendário');
        if (botao) botao.style.display = 'none';
      };
      if (typeof seletor.showPicker !== 'function') mostrarSeletor();
      // Com showPicker: o calendário abre só pelo botão (gesto da pessoa, exigido pelo navegador), já posicionado na data digitada.
      liga(botao, 'click', function () {
        var iso = formulario.normalizarData(texto.value);
        seletor.value = iso || '';
        if (typeof seletor.showPicker !== 'function') { mostrarSeletor(); seletor.focus(); return; }
        try { seletor.showPicker(); } catch (e) { mostrarSeletor(); seletor.focus(); }
      });
      liga(seletor, 'change', function () {
        if (seletor.value) texto.value = formulario.dataParaBr(seletor.value);
      });
    }
    function ligarModal() {
      if (modalLigado) return;
      modalLigado = true;
      var liga = function (id, evento, fn) { var el = $(id); if (el && typeof el.addEventListener === 'function') el.addEventListener(evento, fn); };
      liga('dpoEditar', 'click', function () { abrirModal(); });
      liga('dpoModalFechar', 'click', fecharModal);
      liga('dpoModalCancelar', 'click', fecharModal);
      liga('dpoModalSalvar', 'click', function () { salvar(); });
      liga('dpoModal', 'keydown', teclaNoModal);
      liga('dpo-funcao', 'change', function () { ajustarCampos(); gravarFragmento(); });
      liga('dpo-acao', 'change', function () { ajustarCampos(); gravarFragmento(); });
      CAMPOS_DATA.forEach(ligarCampoData);
      liga('dpo-cnpj', 'input', function () {
        var el = $('dpo-cnpj');
        var mascarado = formulario.mascaraCnpj(el.value);
        if (mascarado !== el.value) el.value = mascarado;
      });
      liga('dpo-tipoPessoa', 'change', ajustarCampos);
    }

    async function iniciar() {
      if (encerrada) return false;
      aviso('');
      limpar(TEXTOS.CARREGANDO);
      var r = await acoes.resumo();
      // A página pode ter sido encerrada (sessão, troca de contexto) enquanto a resposta viajava: nada dela é pintado.
      if (encerrada) return false;
      if (http().ehNaoAutenticado(r)) {
        sessaoCaiu();
        return false;
      }
      if (http().ehSemAutorizacao(r)) {
        encerrada = true;
        limpar(TEXTOS.INDISPONIVEL);
        if (typeof o.aoSemAutorizacao === 'function') o.aoSemAutorizacao();
        return false;
      }
      var m = modelo.resumo(r);
      if (m === null) {
        limpar(TEXTOS.INDISPONIVEL);
        aviso(TEXTOS.FALHA);
        return false;
      }
      mostrar(m);
      await carregarGestao();
      return true;
    }

    /** Depois disto nenhuma resposta pendente toca a tela, e o que havia sai. */
    function encerrar() {
      encerrada = true;
      vigentes = null;
      fecharModal(); // apaga o fragmento e desliga o aviso de saída
      limpar(TEXTOS.INDISPONIVEL);
      aviso('');
    }

    return { iniciar: iniciar, encerrar: encerrar };
  }

  global.EpiLgpd = {
    CAMINHO: CAMINHO,
    CAMINHO_ENCARREGADOS: CAMINHO_ENCARREGADOS,
    TEXTOS: TEXTOS,
    acoes: acoes,
    modelo: modelo,
    formulario: formulario,
    capacidades: capacidades,
    fragmento: fragmento,
    formatarCnpj: formatarCnpj,
    criarTela: criarTela,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiLgpd;
  }
})(typeof window !== 'undefined' ? window : globalThis);
