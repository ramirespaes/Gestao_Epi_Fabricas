(function (global) {
  'use strict';

  /**
   * EpiUsuarios — usuários da empresa (Bloco 9, parte F): Administração de
   * usuários, Novo usuário (convites) e o aceite público do convite.
   *
   *   acoes     — fala com a API e devolve o envelope do EpiHttp. Só manda
   *               os campos de cada contrato; empresa, identidade, senha de
   *               quem administra e situação nunca saem daqui.
   *   texto     — perfil, iniciais, data e situação em texto de tela.
   *   regras    — só apresentação (último MASTER). Quem decide é o servidor.
   *   render    — HTML escapado das tabelas e das opções de perfil.
   *   mensagens — texto próprio por código, sem repetir o servidor.
   *
   * Quais perfis a pessoa pode gerenciar e se pode agir sobre cada linha
   * vêm do servidor (perfisGerenciaveis, podeGerenciar, podeCancelar).
   */

  var CAMINHO = '/administracao/usuarios';
  var CAMINHO_CONVITES = '/administracao/convites-usuario';
  var LIMITE = 20;
  var TRACO = '—';
  var ID_CONVITE = /^[1-9][0-9]{0,17}$/;
  var PERFIL_MASTER = 'MASTER';

  var PERFIS = Object.freeze({
    MASTER: Object.freeze({ rotulo: 'Master', classe: 'role-master' }),
    ADMINISTRADOR: Object.freeze({ rotulo: 'Administrador', classe: 'role-admin' }),
    SUPERVISOR: Object.freeze({ rotulo: 'Supervisor', classe: 'role-supervisor' }),
    USUARIO: Object.freeze({ rotulo: 'Usuário', classe: 'role-user' }),
  });
  // Ordem do seletor "Tipo de conta" do HTML original.
  var ORDEM_PERFIS = Object.freeze(['USUARIO', 'SUPERVISOR', 'ADMINISTRADOR', PERFIL_MASTER]);
  var SITUACOES = Object.freeze([['', 'Todas'], ['ATIVO', 'Ativos'], ['INATIVO', 'Inativos']]);
  var ORDENS = Object.freeze([['nome', 'Nome (A–Z)'], ['nome_desc', 'Nome (Z–A)'], ['perfil', 'Tipo de conta'], ['situacao', 'Situação'], ['recentes', 'Mais recentes']]);
  var SITUACOES_CONVITE = Object.freeze({ PENDENTE: 'Pendente', EXPIRADO: 'Expirado' });

  var FORMATO_DATA = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
  });

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/usuarios.js');
    }
    return cliente;
  }

  function hasOwn(obj, chave) { return Object.prototype.hasOwnProperty.call(obj, chave); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiroPositivo(v) { return typeof v === 'number' && Math.floor(v) === v && v > 0; }
  function perfilPermitido(v) { return typeof v === 'string' && hasOwn(PERFIS, v); }
  function daLista(lista, v) { return typeof v === 'string' && v !== '' && lista.some(function (o) { return o[0] === v; }); }

  function exigirId(id) {
    if (!inteiroPositivo(id)) throw new TypeError('identificador de usuário inválido');
    return id;
  }

  function exigirIdConvite(id) {
    if (typeof id !== 'string' || !ID_CONVITE.test(id)) throw new TypeError('identificador de convite inválido');
    return id;
  }

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    listar: function (filtro) {
      var f = filtro || {};
      var q = [];
      var busca = texto(f.busca);
      if (busca) q.push('busca=' + encodeURIComponent(busca));
      if (daLista(SITUACOES, f.situacao)) q.push('situacao=' + f.situacao);
      if (perfilPermitido(f.perfil)) q.push('perfil=' + f.perfil);
      if (daLista(ORDENS, f.ordem)) q.push('ordem=' + f.ordem);
      q.push('pagina=' + (inteiroPositivo(f.pagina) ? f.pagina : 1));
      q.push('limite=' + LIMITE);
      return http().requisitar('GET', CAMINHO + '?' + q.join('&'));
    },
    /**
     * Só nome e tipo de conta. O perfil do alvo viaja como `tipoConta`:
     * `perfil` num corpo é campo de autoridade e o EpiHttp não o envia.
     * E-mail, empresa, situação e grupo não são deste contrato.
     */
    alterar: function (id, dados) {
      var d = dados || {};
      var corpo = {};
      if (typeof d.nome === 'string') corpo.nome = d.nome.trim();
      if (perfilPermitido(d.tipoConta)) corpo.tipoConta = d.tipoConta;
      return http().requisitar('PATCH', CAMINHO + '/' + exigirId(id), { corpo: corpo });
    },
    inativar: function (id) {
      return http().requisitar('POST', CAMINHO + '/' + exigirId(id) + '/inativar', { corpo: {} });
    },
    reativar: function (id) {
      return http().requisitar('POST', CAMINHO + '/' + exigirId(id) + '/reativar', { corpo: {} });
    },
    convidar: function (dados) {
      var d = dados || {};
      return http().requisitar('POST', CAMINHO_CONVITES, {
        corpo: { email: texto(d.email), nome: texto(d.nome), tipoConta: d.tipoConta },
      });
    },
    listarConvites: function (filtro) {
      var f = filtro || {};
      return http().requisitar('GET', CAMINHO_CONVITES + '?pagina=' + (inteiroPositivo(f.pagina) ? f.pagina : 1) + '&limite=' + LIMITE);
    },
    cancelarConvite: function (id) {
      return http().requisitar('POST', CAMINHO_CONVITES + '/' + exigirIdConvite(id) + '/cancelar', { corpo: {} });
    },
    // Aceite público: o token é o segredo e viaja só no corpo.
    consultarConvite: function (token) {
      return http().requisitar('POST', '/convite-usuario/consultar', { corpo: { token: token } });
    },
    aceitarConvite: function (token, senha) {
      return http().requisitar('POST', '/convite-usuario/aceitar', { corpo: { token: token, senha: senha } });
    },
  };

  // ─── Texto ─────────────────────────────────────────────────────────
  function data(valor) {
    if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(valor)) return TRACO;
    var instante = new Date(valor);
    if (isNaN(instante.getTime())) return TRACO;
    var p = {};
    FORMATO_DATA.formatToParts(instante).forEach(function (parte) { p[parte.type] = parte.value; });
    return p.day + '/' + p.month + '/' + p.year;
  }

  var textoDe = {
    perfil: function (codigo) { return perfilPermitido(codigo) ? PERFIS[codigo].rotulo : TRACO; },
    iniciais: function (nome) {
      var partes = texto(nome).split(/\s+/).filter(Boolean);
      if (partes.length === 0) return '?';
      var primeira = Array.from(partes[0])[0];
      var ultima = partes.length > 1 ? Array.from(partes[partes.length - 1])[0] : '';
      return (primeira + ultima).toUpperCase();
    },
    data: data,
    situacaoConvite: function (s) { return typeof s === 'string' && hasOwn(SITUACOES_CONVITE, s) ? SITUACOES_CONVITE[s] : TRACO; },
    grupo: function (u) {
      if (u.perfil === PERFIL_MASTER) return 'Acesso pelo perfil';
      if (!u.grupo || !texto(u.grupo.nome)) return 'Sem grupo';
      return 'Grupo ' + texto(u.grupo.nome) + (u.grupo.ativo === false ? ' (inativo)' : '');
    },
  };

  // ─── Regras de tela ────────────────────────────────────────────────
  var regras = {
    /** A tela só antecipa o que o servidor recusa (409 USUARIO_ULTIMO_MASTER). */
    ultimoMaster: function (u, mastersAtivos) {
      return !!u && u.perfil === PERFIL_MASTER && u.ativo === true && !(Number(mastersAtivos) > 1);
    },
  };

  // ─── Render ────────────────────────────────────────────────────────
  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function botao(acao, id, rotulo, desabilitado) {
    return '<button class="mini-btn" type="button" data-acao="' + acao + '" data-id="' + escaparHtml(id) + '"'
      + (desabilitado ? ' disabled title="' + escaparHtml(desabilitado) + '"' : '') + '>' + escaparHtml(rotulo) + '</button>';
  }

  function acoesDoUsuario(u, opcoes) {
    if (!opcoes.podeAlterar) return TRACO;
    if (u.podeGerenciar !== true) return '<span class="detalhe">Somente o MASTER</span>';
    if (!inteiroPositivo(u.id)) return TRACO;
    var situacao = u.ativo === true
      ? botao('inativar', u.id, 'Desativar', regras.ultimoMaster(u, opcoes.mastersAtivos) ? 'Não é possível desativar o único MASTER ativo da empresa' : null)
      : botao('reativar', u.id, 'Reativar');
    return '<div class="inline-actions">' + botao('editar', u.id, 'Editar') + situacao + '</div>';
  }

  function linhaUsuario(u, opcoes) {
    var perfil = perfilPermitido(u.perfil) ? PERFIS[u.perfil] : { rotulo: TRACO, classe: 'role-user' };
    var selo = u.proprio === true ? ' <span class="selo-voce">Você</span>' : '';
    return '<tr>'
      + '<td><div class="user-cell"><div class="avatar">' + escaparHtml(textoDe.iniciais(u.nome)) + '</div><div>'
      + '<strong>' + escaparHtml(texto(u.nome) || TRACO) + '</strong>' + selo + '<br>'
      + '<span class="detalhe">Desde ' + escaparHtml(data(u.criadoEm)) + '</span></div></div></td>'
      + '<td>' + escaparHtml(texto(u.email) || TRACO) + '</td>'
      + '<td><span class="badge ' + perfil.classe + '">' + escaparHtml(perfil.rotulo) + '</span><small class="detalhe">' + escaparHtml(textoDe.grupo(u)) + '</small></td>'
      + '<td>' + (u.ativo === true ? '<span class="badge status-active">Ativo</span>' : '<span class="badge status-inactive">Inativo</span>') + '</td>'
      + '<td>' + acoesDoUsuario(u, opcoes) + '</td>'
      + '</tr>';
  }

  function linhaConvite(c, opcoes) {
    var cancelar = opcoes.podeAlterar && c.podeCancelar === true && typeof c.id === 'string' && ID_CONVITE.test(c.id)
      ? botao('cancelar-convite', c.id, 'Cancelar')
      : TRACO;
    return '<tr>'
      + '<td>' + escaparHtml(texto(c.emailConvite) || TRACO) + '</td>'
      + '<td>' + escaparHtml(texto(c.nome) || TRACO) + '</td>'
      + '<td>' + escaparHtml(textoDe.perfil(c.perfil)) + '</td>'
      + '<td>' + escaparHtml(textoDe.situacaoConvite(c.situacao)) + '</td>'
      + '<td>' + escaparHtml(data(c.expiraEm)) + '</td>'
      + '<td>' + escaparHtml(texto(c.criadoPor && c.criadoPor.nome) || TRACO) + '</td>'
      + '<td>' + cancelar + '</td>'
      + '</tr>';
  }

  var render = {
    escaparHtml: escaparHtml,
    linhasUsuarios: function (usuarios, opcoes) {
      var o = opcoes || {};
      return (usuarios || []).map(function (u) { return linhaUsuario(u || {}, o); }).join('');
    },
    tabelaUsuarios: function (usuarios, opcoes, mensagemVazia) {
      return usuarios && usuarios.length ? render.linhasUsuarios(usuarios, opcoes) : render.vazio(mensagemVazia || 'Nenhum usuário.', 5);
    },
    linhasConvites: function (convites, opcoes) {
      var o = opcoes || {};
      return (convites || []).map(function (c) { return linhaConvite(c || {}, o); }).join('');
    },
    tabelaConvites: function (convites, opcoes) {
      return convites && convites.length ? render.linhasConvites(convites, opcoes) : render.vazio('Nenhum convite em aberto.', 7);
    },
    vazio: function (mensagem, colunas) {
      return '<tr><td colspan="' + (inteiroPositivo(colunas) ? colunas : 1) + '" class="estado">' + escaparHtml(mensagem) + '</td></tr>';
    },
    /** Só os perfis que o servidor liberou, na ordem do seletor original. */
    opcoesPerfil: function (permitidos, selecionado) {
      var lista = Array.isArray(permitidos) ? permitidos : [];
      return ORDEM_PERFIS.filter(function (p) { return lista.indexOf(p) !== -1; }).map(function (p) {
        return '<option value="' + p + '"' + (p === selecionado ? ' selected' : '') + '>' + escaparHtml(PERFIS[p].rotulo) + '</option>';
      }).join('');
    },
    /** `tipo` 'convites' para a lista de convites; sem ele, usuários. */
    paginacao: function (d, quantidade, tipo) {
      var nomes = tipo === 'convites' ? ['Convites', 'Nenhum convite'] : ['Usuários', 'Nenhum usuário'];
      var total = d && Number(d.total);
      if (!total) return { texto: nomes[1], anterior: false, proxima: false };
      var inicio = (d.pagina - 1) * d.limite + 1;
      var fim = inicio + quantidade - 1;
      return { texto: nomes[0] + ' ' + inicio + '–' + fim + ' de ' + total + ' · página ' + d.pagina + ' de ' + d.paginas, anterior: d.pagina > 1, proxima: d.pagina < d.paginas };
    },
  };

  // ─── Mensagens ─────────────────────────────────────────────────────
  var SESSAO = 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
  var REDE = 'Falha de rede. Verifique a conexão e tente novamente.';

  var POR_CODIGO = Object.freeze({
    USUARIO_ULTIMO_MASTER: 'A empresa precisa continuar com pelo menos um MASTER ativo. Promova outro usuário a MASTER antes.',
    USUARIO_PERFIL_NAO_PERMITIDO: 'Somente o MASTER gerencia usuários MASTER e ADMINISTRADOR.',
    USUARIO_JA_INATIVO: 'Este usuário já está inativo.',
    USUARIO_JA_ATIVO: 'Este usuário já está ativo.',
    USUARIO_NAO_ENCONTRADO: 'Usuário não encontrado nesta empresa. Atualize a lista.',
    USUARIO_ADMINISTRACAO_NAO_AUTORIZADA: 'Você não tem autoridade para administrar os usuários desta empresa.',
    USUARIO_VINCULO_EXISTENTE: 'Este e-mail já tem um usuário nesta empresa. Se ele estiver inativo, reative-o em Administração de usuários.',
    CONVITE_JA_PENDENTE: 'Já existe um convite em aberto para este e-mail. Cancele-o antes de convidar de novo.',
    CONVITE_ENTREGA_INDISPONIVEL: 'O envio de convites por e-mail ainda não está disponível neste ambiente.',
    CONVITE_NAO_ENCONTRADO: 'Convite não encontrado nesta empresa. Atualize a lista.',
    CONVITE_NAO_CANCELAVEL: 'Este convite já foi aceito ou cancelado.',
  });

  var ACEITE = Object.freeze({
    CONVITE_INVALIDO: 'Link de convite inválido. Peça um novo convite a quem administra a empresa.',
    CONVITE_EXPIRADO: 'Este convite expirou. Peça um novo convite a quem administra a empresa.',
    CONVITE_CANCELADO: 'Este convite foi cancelado.',
    CONVITE_JA_UTILIZADO: 'Este convite já foi usado. Entre pelo Portal do Cliente com seu e-mail e senha.',
    CONVITE_EMPRESA_INATIVA: 'A empresa deste convite está inativa no momento.',
    CREDENCIAIS_INVALIDAS: 'Senha incorreta.',
    CONVITE_EM_COOLDOWN: 'Muitas tentativas com este link. Aguarde alguns minutos e tente de novo.',
    CONVITE_VINCULO_EXISTENTE: 'Esta conta já tem acesso a esta empresa. Entre pelo Portal do Cliente.',
    CONVITE_IDENTIDADE_CONCORRENTE: 'A conta foi criada agora mesmo por outro acesso. Tente de novo com a mesma senha.',
  });

  var POLITICA_SENHA = Object.freeze({
    SENHA_CURTA: 'A senha precisa ter pelo menos 12 caracteres.',
    SENHA_LONGA: 'A senha pode ter no máximo 128 caracteres.',
    SENHA_CARACTERE_INVALIDO: 'A senha tem um caractere que não é aceito.',
    SENHA_POUCOS_CARACTERES_DISTINTOS: 'A senha repete poucos caracteres. Use mais variedade.',
    SENHA_TRIVIAL: 'Essa senha é comum ou previsível. Escolha outra.',
    SENHA_CONTEM_EMAIL: 'A senha não pode conter o seu e-mail.',
    SENHA_CONTEM_CNPJ: 'A senha não pode conter o CNPJ da empresa.',
  });

  function codigoDe(r) { return r && typeof r.codigo === 'string' ? r.codigo : ''; }
  function semRede(r) { return !r || typeof r.status !== 'number' || r.status === 0; }

  var mensagens = {
    exigeNovoLogin: function (r) { return !!r && r.status === 401; },
    erroListagem: function (r) {
      if (semRede(r)) return REDE;
      if (r.status === 401) return SESSAO;
      if (r.status === 403) return POR_CODIGO.USUARIO_ADMINISTRACAO_NAO_AUTORIZADA;
      if (r.status === 400) return 'Filtro não aceito pelo servidor. Confira a busca e os filtros.';
      return 'Não foi possível consultar os usuários. Tente novamente.';
    },
    erroAcao: function (r) {
      if (semRede(r)) return REDE;
      if (r.status === 401) return SESSAO;
      var codigo = codigoDe(r);
      if (hasOwn(POR_CODIGO, codigo)) return POR_CODIGO[codigo];
      if (r.status === 400) return 'Dados não aceitos pelo servidor. Confira o nome e o tipo de conta.';
      return 'Não foi possível concluir a operação. Tente novamente.';
    },
    erroConvite: function (r) {
      if (semRede(r)) return REDE;
      if (r.status === 401) return SESSAO;
      var codigo = codigoDe(r);
      if (hasOwn(POR_CODIGO, codigo)) return POR_CODIGO[codigo];
      if (r.status === 400) return 'Dados não aceitos pelo servidor. Confira o e-mail, o nome e o tipo de conta.';
      return 'Não foi possível criar o convite. Tente novamente.';
    },
    erroAceite: function (r) {
      if (semRede(r)) return 'Não foi possível falar com o servidor. Verifique a conexão.';
      var codigo = codigoDe(r);
      if (hasOwn(ACEITE, codigo)) return ACEITE[codigo];
      var detalhe = r && Array.isArray(r.detalhes) && r.detalhes[0] ? r.detalhes[0].codigo : '';
      if (typeof detalhe === 'string' && hasOwn(POLITICA_SENHA, detalhe)) return POLITICA_SENHA[detalhe];
      if (r.status === 400) return 'Confira a senha informada.';
      return 'Não foi possível concluir o aceite. Tente novamente.';
    },
  };

  global.EpiUsuarios = {
    CAMINHO: CAMINHO,
    CAMINHO_CONVITES: CAMINHO_CONVITES,
    LIMITE: LIMITE,
    PERFIS: PERFIS,
    ORDEM_PERFIS: ORDEM_PERFIS,
    SITUACOES: SITUACOES,
    ORDENS: ORDENS,
    perfilPermitido: perfilPermitido,
    acoes: acoes,
    texto: textoDe,
    regras: regras,
    render: render,
    mensagens: mensagens,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiUsuarios;
  }
})(typeof window !== 'undefined' ? window : globalThis);
