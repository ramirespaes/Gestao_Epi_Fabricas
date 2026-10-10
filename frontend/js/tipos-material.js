(function (global) {
  'use strict';

  /**
   * EpiTiposMaterial — catálogo de tipos de material (classificação V2), dentro de Materiais / Gestão de Estoque:
   *
   *   GET  /tipos-material?grupo=&grupoProtecao=&ativo=&busca=&pagina=&limite=   (materials.visualizar)
   *   POST /tipos-material                                                        (materials.criar)
   *   POST /tipos-material/:id/inativar | /reativar                               (materials.editar)
   *
   * "Outros" nunca é linha do catálogo: é opção da interface do material. Importação CSV/XLSX ficou fora do escopo
   * (decisão de 08/10/2026). O backend é a autoridade: vocabulário, unicidade e permissão são conferidos lá de novo.
   */

  var CAMINHO = '/tipos-material';
  var OUTROS = 'Outros';
  var LIMITES = { nome: 100, busca: 100, limitePagina: 100 };
  var VOCABULARIO = {
    grupos: ['EPI', 'Vestimenta'],
    gruposProtecao: [
      'Proteção auditiva', 'Proteção contra quedas', 'Proteção da cabeça', 'Proteção das mãos', 'Proteção das pernas', 'Proteção dos braços',
      'Proteção dos pés', 'Proteção facial', 'Proteção ocular', 'Proteção da pele (membros superiores)', 'Proteção respiratória', 'Proteção do tronco',
    ],
  };
  var CONTROLE = /[\u0000-\u001f\u007f]/;

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/tipos-material.js');
    return global.EpiHttp;
  }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function escaparHtml(v) {
    return String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function idValido(id) { var n = Number(id); return Number.isInteger(n) && n > 0 ? n : null; }
  /** Mesma normalização do servidor: sequências de espaço, tab, CR e LF viram um espaço; pontas aparadas. */
  function normalizarNome(valor) { return String(valor === undefined || valor === null ? '' : valor).replace(/[ \t\r\n]+/g, ' ').replace(/^ | $/g, ''); }

  // ─── Ações ─────────────────────────────────────────────────────────
  var CHAVES_FILTRO = ['grupo', 'grupoProtecao', 'ativo', 'busca', 'pagina', 'limite'];
  var acoes = {
    /** A empresa é sempre a da sessão: qualquer chave fora do filtro é erro de programação, nunca vai na consulta. */
    listar: function (filtro) {
      var f = filtro || {};
      Object.keys(f).forEach(function (k) { if (CHAVES_FILTRO.indexOf(k) === -1) throw new TypeError('filtro desconhecido: ' + k); });
      var q = [];
      if (texto(f.grupo)) q.push('grupo=' + encodeURIComponent(texto(f.grupo)));
      if (texto(f.grupoProtecao)) q.push('grupoProtecao=' + encodeURIComponent(texto(f.grupoProtecao)));
      if (f.ativo === true || f.ativo === false) q.push('ativo=' + String(f.ativo));
      if (texto(f.busca)) q.push('busca=' + encodeURIComponent(texto(f.busca).slice(0, LIMITES.busca)));
      q.push('pagina=' + encodeURIComponent(f.pagina || 1));
      q.push('limite=' + encodeURIComponent(f.limite || 20));
      return http().requisitar('GET', CAMINHO + '?' + q.join('&'));
    },
    criar: function (dados) {
      var d = dados || {};
      return http().requisitar('POST', CAMINHO, { corpo: { grupo: texto(d.grupo), grupoProtecao: texto(d.grupoProtecao), nome: normalizarNome(d.nome) } });
    },
    inativar: function (id) {
      var n = idValido(id);
      if (n === null) throw new TypeError('identificador de tipo inválido');
      return http().requisitar('POST', CAMINHO + '/' + n + '/inativar', { corpo: {} });
    },
    reativar: function (id) {
      var n = idValido(id);
      if (n === null) throw new TypeError('identificador de tipo inválido');
      return http().requisitar('POST', CAMINHO + '/' + n + '/reativar', { corpo: {} });
    },
  };

  // ─── Formulário ────────────────────────────────────────────────────
  /** Valida o cadastro manual de um tipo; {ok:true, corpo} ou {ok:false, erros:[{campo, mensagem}]}. */
  function montarTipo(campos) {
    var c = campos || {};
    var erros = [];
    var erro = function (campo, mensagem) { erros.push({ campo: campo, mensagem: mensagem }); };
    var grupo = texto(c.grupo);
    if (!grupo) erro('grupo', 'Selecione o grupo: EPI ou Vestimenta.');
    else if (VOCABULARIO.grupos.indexOf(grupo) === -1) erro('grupo', 'Grupo inválido: o catálogo só tem EPI e Vestimenta ("Outros" é opção do material).');
    var protecao = texto(c.grupoProtecao);
    if (!protecao) erro('grupoProtecao', 'Selecione o grupo de proteção.');
    else if (VOCABULARIO.gruposProtecao.indexOf(protecao) === -1) erro('grupoProtecao', 'Grupo de proteção inválido ("Outros" é opção do material).');
    var nome = normalizarNome(c.nome);
    if (!nome) erro('nome', 'Informe o nome do tipo.');
    else if (nome.length > LIMITES.nome) erro('nome', 'Nome do tipo com mais de ' + LIMITES.nome + ' caracteres.');
    else if (CONTROLE.test(nome)) erro('nome', 'Nome do tipo com caractere inválido.');
    else if (nome.toLowerCase() === OUTROS.toLowerCase()) erro('nome', '"Outros" é reservado: informe o nome real do tipo.');
    if (erros.length) return { ok: false, erros: erros };
    return { ok: true, corpo: { grupo: grupo, grupoProtecao: protecao, nome: nome } };
  }

  var formulario = { OUTROS: OUTROS, LIMITES: LIMITES, VOCABULARIO: VOCABULARIO, montarTipo: montarTipo, normalizarNome: normalizarNome };

  // ─── Mensagens ─────────────────────────────────────────────────────
  var POR_CODIGO = {
    TIPO_MATERIAL_JA_EXISTE: 'Já existe um tipo com este nome neste grupo.',
    TIPO_MATERIAL_OUTROS_RESERVADO: '"Outros" é reservado: informe o nome real do tipo.',
    TIPO_MATERIAL_NAO_ENCONTRADO: 'Tipo não encontrado.',
    GRUPO_INVALIDO: 'Grupo inválido.',
    GRUPO_PROTECAO_INVALIDO: 'Grupo de proteção inválido.',
    NOME_INVALIDO: 'Nome do tipo inválido.',
    SEM_PERMISSAO: 'Seu perfil não tem permissão para esta operação.',
    VALIDACAO: 'Dados inválidos.',
  };
  function codigoDe(r) {
    var d = r && r.dados ? r.dados : {};
    if (Array.isArray(d.detalhes) && d.detalhes.length && d.detalhes[0].codigo) return d.detalhes[0].codigo;
    return d.codigo || r.codigo || '';
  }
  function exigeNovoLogin(r) { return !!r && r.status === 401; }
  function erro(r) {
    if (!r || r.status === 0 || typeof r.status !== 'number') return 'Falha de rede: não foi possível concluir. Tente novamente.';
    if (r.status === 403) return POR_CODIGO.SEM_PERMISSAO;
    return POR_CODIGO[codigoDe(r)] || (r.status >= 500 ? 'Falha no servidor. Tente novamente.' : 'Não foi possível concluir a operação.');
  }
  var mensagens = { erro: erro, exigeNovoLogin: exigeNovoLogin, codigoDe: codigoDe, POR_CODIGO: POR_CODIGO };

  // ─── Render ────────────────────────────────────────────────────────
  function opcoes(lista, placeholder) {
    return '<option value="">' + escaparHtml(placeholder) + '</option>'
      + (lista || []).map(function (v) { return '<option value="' + escaparHtml(v) + '">' + escaparHtml(v) + '</option>'; }).join('');
  }
  /** Linhas da tabela do catálogo: tudo escapado; o botão de estado só com materials.editar. */
  function linhas(tipos, podeEditar) {
    var lista = tipos || [];
    if (!lista.length) return '<tr><td colspan="5" class="vazio">Nenhum tipo cadastrado com este filtro.</td></tr>';
    return lista.map(function (t) {
      var ativo = t.ativo !== false;
      var botao = podeEditar
        ? '<button type="button" class="outlined-btn btn-sm" data-acao="' + (ativo ? 'inativar' : 'reativar') + '" data-id="' + escaparHtml(t.id) + '">' + (ativo ? 'Inativar' : 'Reativar') + '</button>'
        : '';
      return '<tr class="' + (ativo ? 'tipo-ativo' : 'tipo-inativo') + '">'
        + '<td>' + escaparHtml(t.grupo) + '</td><td>' + escaparHtml(t.grupoProtecao) + '</td><td>' + escaparHtml(t.nome)
        + (t.origem === 'BASE' ? ' <small style="color:var(--on-surface-variant)">base</small>' : '') + '</td>'
        + '<td><span class="badge ' + (ativo ? 'ok' : 'off') + '">' + (ativo ? 'Ativo' : 'Inativo') + '</span></td>'
        + '<td>' + botao + '</td></tr>';
    }).join('');
  }
  var render = { escaparHtml: escaparHtml, opcoes: opcoes, linhas: linhas };

  global.EpiTiposMaterial = { OUTROS: OUTROS, LIMITES: LIMITES, VOCABULARIO: VOCABULARIO, acoes: acoes, formulario: formulario, mensagens: mensagens, render: render };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiTiposMaterial;
  }
}(typeof window !== 'undefined' ? window : globalThis));
