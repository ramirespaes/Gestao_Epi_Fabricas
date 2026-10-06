(function (global) {
  'use strict';

  /**
   * EpiGestaoUsuarios — Gestão de Usuários (consolidação de acessos, primeira
   * subetapa: tela + listagem real). O HTML aprovado é o alvo visual; este
   * módulo só liga o que a tela já mostra aos dados reais da empresa da
   * sessão, por GET /administracao/usuarios (js/usuarios.js, única fonte da
   * rota). Nada aqui vem do array `users`, de localStorage ou de empresas,
   * grupos, setores e nomes do protótipo.
   *
   *   modelo  — projeção dos campos reais que o backend devolve.
   *   acoes   — carrega todas as páginas da listagem real e salva o tema pelo
   *             mesmo contrato das Configurações.
   *   visao   — filtro de situação, busca, ordenação e agrupamento, locais,
   *             sobre o conjunto real carregado.
   *   render  — a marcação do HTML aprovado, montada com createElement e
   *             textContent (nenhum innerHTML: o que vem do servidor é texto).
   *   csv     — exportação só dos campos reais.
   *
   * Desde 05/10/2026 a listagem real traz os dados administrativos: CPF só
   * mascarado, matrícula, setor, horário de trabalho e `acessoQualquerIp`
   * (derivado no servidor: sem IP permitido = Sim). Colunas ainda sem fonte
   * (Empresa(s), Visualiza logs) mostram "—": nunca um valor inventado.
   */

  var TRACO = '—';
  var LIMITE_PAGINA = 100; // LIMITE_MAXIMO do backend
  var MAX_PAGINAS = 50;
  var CAMINHO_CONTA = '/auth/global/conta';
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var TEXTOS = Object.freeze({
    EM_INTEGRACAO: 'Funcionalidade em integração',
    CARREGANDO: 'Carregando usuários…',
    VAZIO_ANTES: 'Nenhum usuário encontrado. Ajuste a pesquisa ou o filtro de status, ou cadastre um novo usuário em ',
    VAZIO_DEPOIS: '.',
    FALHA_LISTAGEM: 'Não foi possível carregar os usuários agora. Verifique a conexão e tente novamente.',
    LISTA_INCOMPLETA: 'A empresa tem mais usuários do que a tela carrega de uma vez; a listagem está incompleta.',
    TEMA_FALHA: 'Não foi possível salvar o tema agora.',
    CSV_COPIADO: 'CSV copiado.',
    CSV_MANUAL: 'Selecione o texto e copie com Ctrl+C.',
    HABILITADO: 'Habilitado',
    DESABILITADO: 'Desabilitado',
    SEM_GRUPO: 'Sem grupo',
    GRUPO_NAO_SE_APLICA: 'Não se aplica',
    SEM_SETOR: 'Sem setor',
    SIM: 'Sim',
    NAO: 'Não',
    // Novo → Usuário (usuário administrativo; decisão de 05/10/2026)
    NOVO_USUARIO_SUCESSO: 'Usuário criado com sucesso. Informe ao usuário o e-mail e a senha provisória pelos meios internos da empresa.',
    GRUPOS_FALHA: 'Não foi possível carregar os grupos de acesso agora; o usuário pode ser criado sem grupo.',
    CRIAR_FALHA: 'Não foi possível criar o usuário agora. Verifique a conexão e tente novamente.',
    SEM_AUTORIDADE: 'Sem autoridade para criar usuários nesta empresa.',
    CAMPOS_INVALIDOS: 'Verifique os campos destacados.',
    GRUPO_CRIADO_OK: 'Grupo criado com sucesso.',
    GRUPO_EDITADO_OK: 'Grupo alterado com sucesso.',
    GRUPO_INATIVADO_OK: 'Grupo inativado. Ele deixa de valer para os integrantes até ser reativado.',
    GRUPO_REATIVADO_OK: 'Grupo reativado.',
    GRUPOS_LISTA_FALHA: 'Não foi possível carregar os grupos agora. Tente novamente.',
    GRUPOS_VAZIO: 'Nenhum grupo cadastrado. Use Novo › Grupo para criar o primeiro.',
    GRUPO_INATIVAR_FALHA: 'Não foi possível alterar a situação do grupo agora. A lista foi atualizada.',
    GRUPO_NAO_ENCONTRADO: 'Grupo não encontrado. A lista foi atualizada.',
    ALTERADO_OK: 'Usuário alterado com sucesso.',
    DESABILITADO_OK: 'Usuário desabilitado.',
    REATIVADO_OK: 'Usuário reativado.',
    ULTIMO_MASTER: 'A empresa precisa continuar com pelo menos um Master ativo.',
    ACAO_FALHA: 'Não foi possível concluir a ação agora. Tente novamente.',
    INDISPONIVEL: 'Esta função não está disponível no servidor atual. Verifique se o servidor foi atualizado.',
    JA_NO_ESTADO: 'O usuário já estava nesse estado. A lista foi atualizada.',
    NAO_ENCONTRADO: 'Usuário não encontrado. A lista foi atualizada.',
    DESABILITAR_TEXTO: 'O usuário perderá o acesso ao SafeWork. O cadastro e o histórico serão preservados.',
  });

  var STATUS = Object.freeze({ hab: 'Habilitados', des: 'Desabilitados', todos: 'Todos' });
  var AGRUPAMENTOS = Object.freeze([['nenhum', 'Nenhum'], ['grupo', 'Grupo'], ['setor', 'Setor']]);
  var AGRUPAVEIS = Object.freeze({ nenhum: true, grupo: true, setor: true });
  var HORA_LISTA = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  var CPF_MASCARADO = /^\*\*\*\.\*\*\*\.\*\*\*-\d{2}$/;
  var COLS = Object.freeze([
    ['id', 'ID'], ['nome', 'Usuário'], ['login', 'Login'], ['empresas', 'Empresa(s)'], ['grupo', 'Grupo'], ['cpf', 'CPF'],
    ['email', 'E-mail'], ['setor', 'Setor'], ['de', 'Horário de trabalho'], ['logs', 'Visualiza logs'], ['qualquerIP', 'Acesso de qualquer IP'],
  ]);
  var PERFIS = Object.freeze({ MASTER: 'Master', ADMINISTRADOR: 'Administrador', SUPERVISOR: 'Supervisor', USUARIO: 'Usuário' });
  var ACOES_LINHA = Object.freeze([
    ['alterar', '✎ Alterar usuário'], ['duplicar', '⧉ Duplicar usuário'], ['permissoes', '☰ Configurar permissões'],
    ['copiar', '⇄ Copiar permissões'], ['senha', '🔑 Alterar senha'],
  ]);
  var GUIA = Object.freeze([
    [['b', 'Novo › Usuário'], ' cadastra um acesso. O grupo escolhido define as permissões iniciais.'],
    [['b', 'Duplicar usuário'], ' cria outro acesso com o mesmo grupo, setor, empresas e permissões. Login, e-mail e senha ficam em branco.'],
    [['b', 'Configurar permissões'], ' abre a lista por módulo (Colaboradores, Estoque, Entregas, Fichas, Totem…) para ligar ou desligar cada item.'],
    [['b', 'Copiar permissões'], ' substitui as permissões do usuário pelas de outro.'],
    [['b', 'Grupos'], ' lista os grupos para editar, inativar, reativar e configurar as permissões do grupo (ligar ou desligar cada acesso).'],
  ]);

  function hasOwn(obj, chave) { return Object.prototype.hasOwnProperty.call(obj, chave); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiroPositivo(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0; }

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/gestao-usuarios.js');
    return cliente;
  }

  // ─── Modelo ────────────────────────────────────────────────────────
  var modelo = {
    /** Só o que o backend devolve e a tela usa; qualquer campo do protótipo é ignorado. */
    normalizar: function (u) {
      if (!u || typeof u !== 'object' || !inteiroPositivo(u.id) || !texto(u.nome)) return null;
      var grupo = u.grupo && typeof u.grupo === 'object' && texto(u.grupo.nome) ? texto(u.grupo.nome) : null;
      var h = u.horarioTrabalho;
      var horario = h && typeof h === 'object' && HORA_LISTA.test(h.inicio) && HORA_LISTA.test(h.fim) ? { inicio: h.inicio, fim: h.fim } : null;
      return {
        id: u.id,
        nome: texto(u.nome),
        email: texto(u.email),
        perfil: hasOwn(PERFIS, u.perfil) ? u.perfil : null,
        ativo: u.ativo === true,
        grupo: grupo,
        grupoAtivo: grupo !== null && u.grupo.ativo !== false,
        // Só o CPF mascarado do servidor; qualquer outra forma é descartada.
        cpfMascarado: typeof u.cpfMascarado === 'string' && CPF_MASCARADO.test(u.cpfMascarado) ? u.cpfMascarado : null,
        matricula: texto(u.matricula) || null,
        setor: texto(u.setor) || null,
        horarioTrabalho: horario,
        // Derivado no servidor (sem IP permitido = true); ausente = desconhecido, nunca inventado.
        acessoQualquerIp: typeof u.acessoQualquerIp === 'boolean' ? u.acessoQualquerIp : null,
        // Decidido pelo servidor: perfil fixo (Master) não é destino de perfil nem modelo de acesso.
        perfilFixo: u.perfilFixo === true,
      };
    },
    /** "08:00 - 18:00", ou "—" sem horário. */
    horarioTexto: function (u) {
      return u && u.horarioTrabalho ? u.horarioTrabalho.inicio + ' - ' + u.horarioTrabalho.fim : TRACO;
    },
    /** "Sim" (sem IP permitido), "Não" (com lista) ou "—" (desconhecido). */
    acessoQualquerIpTexto: function (u) {
      if (!u || typeof u.acessoQualquerIp !== 'boolean') return TRACO;
      return u.acessoQualquerIp ? TEXTOS.SIM : TEXTOS.NAO;
    },
  };

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    /**
     * Carrega a listagem real inteira, página a página, no limite do backend.
     * `listar` é EpiUsuarios.acoes.listar (injetável nos testes). Situação e
     * busca ficam fora da consulta: são locais, sobre o conjunto real.
     */
    carregarTodos: async function (opcoes) {
      var o = opcoes || {};
      var listar = typeof o.listar === 'function' ? o.listar : function (f) { return global.EpiUsuarios.acoes.listar(f); };
      var maxPaginas = inteiroPositivo(o.maxPaginas) ? o.maxPaginas : MAX_PAGINAS;
      var usuarios = [];
      var total = 0;
      var pagina = 1;
      // Perfis que o servidor diz que esta pessoa pode criar (vem na listagem).
      var perfis = Object.keys(PERFIS);
      // O que a tela pode oferecer para cadastrar/atribuir (o servidor exclui o Master); sem a lista, nada é oferecido.
      var cadastraveis = [];
      for (;;) {
        var r = await listar({ ordem: 'nome', pagina: pagina, limite: LIMITE_PAGINA });
        if (!r || !r.ok) return { ok: false, status: r ? r.status : 0, codigo: r ? r.codigo : null, usuarios: [], total: 0, truncado: false };
        var d = r.dados || {};
        if (pagina === 1 && Array.isArray(d.perfisGerenciaveis)) perfis = d.perfisGerenciaveis.filter(function (p) { return hasOwn(PERFIS, p); });
        if (pagina === 1 && Array.isArray(d.perfisCadastraveis)) cadastraveis = d.perfisCadastraveis.filter(function (p) { return hasOwn(PERFIS, p); });
        var lote = Array.isArray(d.usuarios) ? d.usuarios : [];
        for (var i = 0; i < lote.length; i += 1) {
          var n = modelo.normalizar(lote[i]);
          if (n) usuarios.push(n);
        }
        total = Number(d.total) || usuarios.length;
        if (lote.length === 0 || pagina * LIMITE_PAGINA >= total) return { ok: true, usuarios: usuarios, total: total, truncado: false, perfisGerenciaveis: perfis, perfisCadastraveis: cadastraveis };
        if (pagina >= maxPaginas) return { ok: true, usuarios: usuarios, total: total, truncado: true, perfisGerenciaveis: perfis, perfisCadastraveis: cadastraveis };
        pagina += 1;
      }
    },
    /** O mesmo contrato das Configurações (PATCH da conta da própria identidade). */
    salvarTema: function (tema) {
      if (tema !== 'claro' && tema !== 'escuro' && tema !== 'sistema') throw new TypeError('tema inválido');
      return http().requisitar('PATCH', CAMINHO_CONTA, { corpo: { tema: tema } });
    },
  };

  // ─── Visão (local, sobre o conjunto real) ──────────────────────────
  function comparar(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b), 'pt-BR', { sensitivity: 'base' });
  }
  function chaveDeOrdem(u, col) {
    if (col === 'id') return u.id;
    if (col === 'nome') return u.nome;
    if (col === 'login' || col === 'email') return u.email;
    if (col === 'grupo') return u.grupo || '';
    if (col === 'setor') return u.setor || '';
    if (col === 'de') return u.horarioTrabalho ? u.horarioTrabalho.inicio + u.horarioTrabalho.fim : '';
    if (col === 'qualquerIP') return u.acessoQualquerIp === null ? '' : modelo.acessoQualquerIpTexto(u);
    // CPF mascarado não ordena (só dois dígitos visíveis); Empresa(s) e Visualiza logs ainda não têm fonte.
    return '';
  }

  var visao = {
    filtrar: function (lista, v) {
      var status = v && hasOwn(STATUS, v.status) ? v.status : 'hab';
      var q = texto(v && v.q).toLowerCase();
      return (lista || []).filter(function (u) {
        if (status === 'hab' && !u.ativo) return false;
        if (status === 'des' && u.ativo) return false;
        if (!q) return true;
        return [u.id, u.nome, u.email, u.grupo || ''].join(' ').toLowerCase().indexOf(q) !== -1;
      });
    },
    ordenar: function (lista, sort) {
      var col = sort && typeof sort.col === 'string' ? sort.col : 'id';
      var dir = sort && sort.dir === -1 ? -1 : 1;
      return (lista || []).slice().sort(function (a, b) { return comparar(chaveDeOrdem(a, col), chaveDeOrdem(b, col)) * dir; });
    },
    agrupamentoDisponivel: function (modo) { return hasOwn(AGRUPAVEIS, modo); },
    /** [[titulo|null, usuarios]] — por grupo ou setor reais ("Sem grupo"/"Sem setor" para quem não tem); títulos em ordem. */
    agrupar: function (lista, modo) {
      if (modo !== 'grupo' && modo !== 'setor') return [[null, lista || []]];
      var mapa = {};
      var ordem = [];
      (lista || []).forEach(function (u) {
        var g = modo === 'grupo' ? (u.grupo || TEXTOS.SEM_GRUPO) : (u.setor || TEXTOS.SEM_SETOR);
        if (!hasOwn(mapa, g)) { mapa[g] = []; ordem.push(g); }
        mapa[g].push(u);
      });
      ordem.sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); });
      return ordem.map(function (g) { return [g, mapa[g]]; });
    },
  };

  // ─── Render: a marcação do HTML aprovado, só com nós e texto ───────
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
  function svg(doc, atributos, partes) {
    var s = doc.createElementNS(SVG_NS, 'svg');
    Object.keys(atributos).forEach(function (k) { s.setAttribute(k, atributos[k]); });
    partes.forEach(function (p) {
      var filho = doc.createElementNS(SVG_NS, p[0]);
      Object.keys(p[1]).forEach(function (k) { filho.setAttribute(k, p[1][k]); });
      s.appendChild(filho);
    });
    return s;
  }
  function tags(doc, u) {
    return u.ativo ? null : no(doc, 'span', { class: 'tag off' }, [TEXTOS.DESABILITADO]);
  }
  function kebab(doc, u) {
    return no(doc, 'button', { class: 'kebab', 'data-menu': u.id, 'aria-label': 'Ações de ' + u.nome }, [
      svg(doc, { viewBox: '0 0 24 24', fill: 'currentColor' }, [
        ['circle', { cx: '12', cy: '5', r: '2' }], ['circle', { cx: '12', cy: '12', r: '2' }], ['circle', { cx: '12', cy: '19', r: '2' }],
      ]),
    ]);
  }
  function cabecalhoModal(doc, titulo) {
    return no(doc, 'div', { class: 'mh' }, [
      no(doc, 'h2', {}, [titulo]),
      no(doc, 'button', { class: 'btn icon ghost', 'data-close': '', 'aria-label': 'Fechar' }, ['✕']),
    ]);
  }
  function cartao(doc, u) {
    return no(doc, 'div', { class: 'card' }, [
      kebab(doc, u),
      no(doc, 'h3', {}, [u.nome, tags(doc, u)]),
      no(doc, 'div', { class: 'meta' }, [
        String(u.id) + ' · ' + u.email, no(doc, 'br'),
        (u.grupo || TRACO) + ' · ' + (u.setor || TRACO), no(doc, 'br'),
        u.email, no(doc, 'br'),
        'Horário: ' + modelo.horarioTexto(u),
      ]),
    ]);
  }
  function celula(doc, conteudo, classe) {
    return no(doc, 'td', classe ? { class: classe } : {}, Array.isArray(conteudo) ? conteudo : [conteudo]);
  }
  function linha(doc, u) {
    // Colunas na ordem de COLS: ID, Usuário, Login, Empresa(s), Grupo, CPF, E-mail, Setor, Horário, Visualiza logs, Acesso de qualquer IP.
    return no(doc, 'tr', {}, [
      celula(doc, String(u.id)),
      celula(doc, [u.nome, tags(doc, u)]),
      celula(doc, u.email),
      celula(doc, TRACO, 'c'),
      celula(doc, u.grupo || TRACO),
      celula(doc, u.cpfMascarado || TRACO),
      celula(doc, u.email),
      celula(doc, u.setor || TRACO),
      celula(doc, modelo.horarioTexto(u)),
      celula(doc, TRACO, 'c'),
      celula(doc, modelo.acessoQualquerIpTexto(u), 'c'),
      celula(doc, kebab(doc, u), 'c'),
    ]);
  }

  var render = {
    /** Botões dos menus de situação e agrupamento, e os rótulos dos dois botões da toolbar. */
    menus: function (doc, v) {
      var status = Object.keys(STATUS).map(function (k) {
        return no(doc, 'button', { 'data-status': k, class: v.status === k ? 'sel' : '' }, [STATUS[k]]);
      });
      var grupo = AGRUPAMENTOS.map(function (par) {
        return no(doc, 'button', { 'data-agrupar': par[0], class: v.agrupar === par[0] ? 'sel' : '' }, [par[1]]);
      });
      var atual = AGRUPAMENTOS.filter(function (p) { return p[0] === v.agrupar; })[0] || AGRUPAMENTOS[0];
      return { status: status, grupo: grupo, rotuloStatus: STATUS[v.status] || STATUS.hab, rotuloGrupo: atual[1] };
    },
    mensagem: function (doc, t) {
      return no(doc, 'div', { class: 'tablewrap' }, [no(doc, 'div', { class: 'empty' }, [t])]);
    },
    vazio: function (doc) {
      return no(doc, 'div', { class: 'tablewrap' }, [no(doc, 'div', { class: 'empty' }, [TEXTOS.VAZIO_ANTES, no(doc, 'b', {}, ['Novo']), TEXTOS.VAZIO_DEPOIS])]);
    },
    /** blocos: saída de visao.agrupar; v.modo 'table' | 'cards'; v.sort {col, dir}. */
    lista: function (doc, blocos, v) {
      var modo = v && v.modo === 'cards' ? 'cards' : 'table';
      var sort = v && v.sort ? v.sort : { col: 'id', dir: 1 };
      if (modo === 'cards') {
        var cartoes = no(doc, 'div', { class: 'cards' });
        blocos.forEach(function (b) {
          if (b[0]) cartoes.appendChild(no(doc, 'div', { class: 'grptitle' }, [b[0] + ' (' + b[1].length + ')']));
          b[1].forEach(function (u) { cartoes.appendChild(cartao(doc, u)); });
        });
        return cartoes;
      }
      var cabecalho = no(doc, 'tr', {}, COLS.map(function (c) {
        return no(doc, 'th', { 'data-sort': c[0] }, [c[1], sort.col === c[0] ? no(doc, 'span', { class: 'arr' }, [sort.dir > 0 ? '▲' : '▼']) : null]);
      }).concat([no(doc, 'th', { class: 'noclick' }, ['Ações'])]));
      var corpo = no(doc, 'tbody');
      blocos.forEach(function (b) {
        if (b[0]) corpo.appendChild(no(doc, 'tr', { class: 'grp' }, [no(doc, 'td', { colspan: COLS.length + 1 }, [b[0] + ' (' + b[1].length + ')'])]));
        b[1].forEach(function (u) { corpo.appendChild(linha(doc, u)); });
      });
      return no(doc, 'div', { class: 'tablewrap' }, [no(doc, 'table', {}, [no(doc, 'thead', {}, [cabecalho]), corpo])]);
    },
    menuAcoes: function (doc, u) {
      // Perfil fixo (Master) não é modelo de acesso: sem "Duplicar usuário".
      return ACOES_LINHA.filter(function (a) { return !(a[0] === 'duplicar' && u.perfilFixo); })
        .map(function (a) { return no(doc, 'button', { 'data-acao': a[0] }, [a[1]]); })
        .concat([u.ativo
          ? no(doc, 'button', { 'data-acao': 'desabilitar', class: 'danger' }, ['⊘ Desabilitar usuário'])
          : no(doc, 'button', { 'data-acao': 'habilitar' }, ['✓ Reativar usuário'])]);
    },
    /** Confirmação genérica no mesmo modal pequeno: {titulo, texto, rotulo}. */
    modalConfirmar: function (doc, c) {
      return [
        cabecalhoModal(doc, c.titulo),
        no(doc, 'div', { class: 'mb' }, [no(doc, 'p', { style: 'margin:0' }, [c.texto])]),
        no(doc, 'div', { class: 'mf' }, [
          no(doc, 'button', { class: 'btn link', type: 'button', 'data-close': '' }, ['Cancelar']),
          no(doc, 'button', { class: 'btn primary', type: 'button', id: 'btnConfirmar' }, [c.rotulo]),
        ]),
      ];
    },
    modalGuia: function (doc) {
      var corpo = no(doc, 'div', { class: 'mb', style: 'line-height:1.6' }, GUIA.map(function (p, i) {
        var estilo = i === 0 ? 'margin-top:0' : (i === GUIA.length - 1 ? 'margin-bottom:0' : null);
        return no(doc, 'p', { style: estilo }, [no(doc, p[0][0], {}, [p[0][1]]), p[1]]);
      }));
      return [
        cabecalhoModal(doc, 'Guia rápido'),
        corpo,
        no(doc, 'div', { class: 'mf' }, [no(doc, 'span'), no(doc, 'button', { class: 'btn primary', 'data-close': '' }, ['Entendi'])]),
      ];
    },
    modalExportar: function (doc, csvTexto, quantidade) {
      var area = no(doc, 'textarea', {
        class: 'in', id: 'csv', rows: '10', readonly: '', style: 'font-family:ui-monospace,Consolas,monospace;font-size:.82rem;resize:vertical',
      }, [csvTexto]);
      area.value = csvTexto;
      return [
        cabecalhoModal(doc, 'Exportar'),
        no(doc, 'div', { class: 'mb' }, [
          no(doc, 'p', { style: 'margin-top:0' }, [Number(quantidade) + ' usuário(s) da visão atual, em CSV separado por ponto e vírgula. Copie e cole no Excel.']),
          area,
        ]),
        no(doc, 'div', { class: 'mf' }, [
          no(doc, 'button', { class: 'btn link', 'data-close': '' }, ['Fechar']),
          no(doc, 'button', { class: 'btn primary', id: 'btnCopy' }, ['Copiar CSV']),
        ]),
      ];
    },
  };

  // ─── Novo → Usuário: formulário do usuário administrativo ───────────
  // Regras locais iguais às do servidor (que decide de novo): CPF com dígitos
  // verificadores, matrícula e setor obrigatórios, horário inteiro ou vazio,
  // IPs IPv4/IPv6 sem faixa. A confirmação da senha é só da tela; nenhum
  // valor digitado vai para armazenamento do navegador.
  var LIMITES_NOVO = Object.freeze({ nome: 150, email: 200, matricula: 30, setor: 100, senhaMinima: 12, senhaMaxima: 128, ips: 20 });
  var ERROS_NOVO = Object.freeze({
    nome: 'Informe o nome completo (até 150 caracteres).',
    email: 'Informe um e-mail válido.',
    tipoConta: 'Escolha o perfil / tipo de conta.',
    cpf: 'Informe um CPF válido (11 dígitos).',
    matricula: 'Informe a matrícula (até 30 caracteres).',
    setor: 'Informe o setor (até 100 caracteres).',
    senhaProvisoria: 'A senha provisória precisa ter de 12 a 128 caracteres.',
    senhaPolitica: 'A senha provisória não atende à política de senhas: evite sequências, repetições, partes do e-mail e senhas comuns.',
    confirmacao: 'A confirmação não confere com a senha provisória.',
    horario: 'Informe o início e o fim do horário (HH:MM), ou deixe os dois em branco.',
    ipsPermitidos: 'Há endereço IP inválido. Use IPv4 ou IPv6 (sem faixa), separados por vírgula, até 20.',
    grupoAcessoId: 'Grupo de acesso inválido.',
  });
  // Códigos do servidor → [campo destacado | null, texto da tela]. Nunca o texto do servidor.
  var POR_CODIGO_NOVO = Object.freeze({
    IDENTIDADE_EMAIL_JA_EXISTENTE: ['email', 'Este e-mail já possui conta de acesso.'],
    USUARIO_VINCULO_EXISTENTE: ['email', 'Este e-mail já tem acesso nesta empresa.'],
    IDENTIDADE_CPF_JA_EXISTENTE: ['cpf', 'Este CPF já possui conta de acesso.'],
    USUARIO_MATRICULA_JA_EXISTENTE: ['matricula', 'Esta matrícula já está em uso nesta empresa.'],
    GRUPO_NAO_ENCONTRADO: ['grupoAcessoId', 'Grupo de acesso não encontrado. Feche e abra o formulário para atualizar a lista.'],
    GRUPO_INATIVO: ['grupoAcessoId', 'Grupo de acesso inativo não recebe novos usuários.'],
    USUARIO_MASTER_SEM_GRUPO: ['grupoAcessoId', 'Usuário Master não é vinculado a grupo de acesso.'],
    USUARIO_PERFIL_NAO_PERMITIDO: ['tipoConta', 'Você não pode criar usuários com este perfil.'],
    USUARIO_ADMINISTRACAO_NAO_AUTORIZADA: [null, TEXTOS.SEM_AUTORIDADE],
    IP_TRANCARIA_O_PROPRIO_ATOR: ['ipsPermitidos', 'A lista não inclui o endereço de onde você está acessando agora.'],
    EMAIL_IDENTIDADE_COMPARTILHADA: ['email', 'Esta pessoa tem acesso a outras empresas: o e-mail de login não pode ser alterado aqui.'],
    USUARIO_ULTIMO_MASTER: ['tipoConta', 'A empresa precisa continuar com pelo menos um Master ativo.'],
  });
  var CAMPOS_DO_CORPO = Object.freeze({
    nome: 'nome', email: 'email', tipoConta: 'tipoConta', senhaProvisoria: 'senhaProvisoria', cpf: 'cpf', matricula: 'matricula', setor: 'setor',
    horarioTrabalho: 'horario', ipsPermitidos: 'ipsPermitidos', grupoAcessoId: 'grupoAcessoId',
  });
  // Tipo de conta ESCOLHIDO NO FORMULÁRIO para quem está sendo criado, nunca o perfil de quem age. A autoridade do
  // Master é própria e ele não usa grupo (3L): aqui é só a aplicabilidade do campo; o servidor recusa o vínculo (409).
  var TIPO_SEM_GRUPO = 'MASTER';
  var EMAIL_SIMPLES = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var HORA_HH_MM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
  var IPV4 = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

  function cpfValido(d) {
    if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
    var dv = function (n) {
      var soma = 0;
      for (var i = 0; i < n; i += 1) soma += Number(d[i]) * (n + 1 - i);
      var r = (soma * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
  }
  function ipValido(v) {
    if (typeof v !== 'string' || v.length === 0 || v.length > 45 || /[\s/%\[\]]/.test(v)) return false;
    if (IPV4.test(v)) return true;
    if (v.indexOf(':') === -1) return false;
    try { return new URL('http://[' + v + ']/').hostname.length > 2; } catch (e) { return false; }
  }
  function pontos(s) { return Array.from(String(s)).length; }

  // 404 só é "usuário não encontrado" quando o SERVIDOR diz isso (código do usuário). Rota inexistente (servidor desatualizado)
  // ou outro 404 nunca é apresentado como usuário inexistente.
  function texto404(r) {
    if (r && (r.codigo === 'USUARIO_NAO_ENCONTRADO' || r.codigo === 'USUARIO_ORIGEM_NAO_ENCONTRADO' || r.codigo === 'USUARIO_MODELO_NAO_ENCONTRADO')) return TEXTOS.NAO_ENCONTRADO;
    if (r && r.codigo === 'ROTA_NAO_ENCONTRADA') return TEXTOS.INDISPONIVEL;
    return TEXTOS.ACAO_FALHA;
  }

  /** Textos da confirmação de desabilitar e a leitura dos erros do servidor (códigos estáveis, nunca o texto dele). */
  var situacao = {
    confirmacaoDesabilitar: function (u) {
      return { titulo: 'Desabilitar acesso de ' + u.nome + '?', texto: TEXTOS.DESABILITAR_TEXTO, rotulo: 'Desabilitar usuário' };
    },
    erro: function (r) {
      if (r && r.status === 409 && r.codigo === 'USUARIO_ULTIMO_MASTER') return TEXTOS.ULTIMO_MASTER;
      if (r && r.status === 409) return TEXTOS.JA_NO_ESTADO;
      if (r && r.status === 404) return texto404(r);
      if (r && r.status === 403) return TEXTOS.SEM_AUTORIDADE;
      return TEXTOS.ACAO_FALHA;
    },
  };

  // Novo → Grupo (POST /grupos-acesso, infraestrutura existente da 3M). Grupo NÃO é Setor: é o conjunto de acessos.
  var GRUPO_TEXTOS = Object.freeze({
    NOME: 'Informe o nome do grupo (até 100 caracteres).',
    DESCRICAO: 'A descrição pode ter até 500 caracteres.',
    NOME_EM_USO: 'Já existe um grupo com este nome nesta empresa.',
    DICA: 'Grupo é o conjunto de acessos usado pelos usuários, não o setor onde a pessoa trabalha. O grupo nasce sem permissões: elas são configuradas depois.',
  });
  var grupoForm = {
    TEXTOS: GRUPO_TEXTOS,
    validar: function (d) {
      var erros = {};
      var nome = texto(d && d.nome);
      if (!nome || pontos(nome) > 100) erros.nome = GRUPO_TEXTOS.NOME;
      if (pontos(texto(d && d.descricao)) > 500) erros.descricao = GRUPO_TEXTOS.DESCRICAO;
      return { ok: Object.keys(erros).length === 0, erros: erros };
    },
    corpo: function (d) {
      var corpo = { nome: texto(d && d.nome) };
      var descricao = texto(d && d.descricao);
      if (descricao) corpo.descricao = descricao;
      return corpo;
    },
    /** Campos que mudaram na edição (ausente = não enviar; descrição vazia limpa). Sem mudança, nada vai. */
    camposAlterados: function (grupo, d) {
      var campos = {};
      var nome = texto(d && d.nome);
      var descricao = texto(d && d.descricao);
      if (nome !== texto(grupo && grupo.nome)) campos.nome = nome;
      if (descricao !== texto(grupo && grupo.descricao)) campos.descricao = descricao;
      return campos;
    },
    confirmacaoInativar: function (g) {
      return { titulo: 'Inativar o grupo ' + g.nome + '?', texto: 'Um grupo inativo deixa de valer para os integrantes e não recebe novos usuários. Nada é apagado: o grupo pode ser reativado.', rotulo: 'Inativar grupo' };
    },
    erroDeSituacao: function (r) {
      if (r && r.status === 403) return TEXTOS.SEM_AUTORIDADE;
      if (r && r.status === 404) return TEXTOS.GRUPO_NAO_ENCONTRADO;
      return TEXTOS.GRUPO_INATIVAR_FALHA;
    },
    erroDoServidor: function (r) {
      var erros = {};
      if (!r || r.ok) return { mensagem: '', erros: erros };
      if (r.status === 404) return { mensagem: TEXTOS.GRUPO_NAO_ENCONTRADO, erros: erros };
      if (r.status === 409 && r.codigo === 'GRUPO_NOME_EM_USO') { erros.nome = GRUPO_TEXTOS.NOME_EM_USO; return { mensagem: '', erros: erros }; }
      if (r.status === 400) {
        var campos = Array.isArray(r.detalhes) ? r.detalhes.map(function (x) { return x && x.campo; }) : [];
        if (campos.indexOf('body.descricao') !== -1) erros.descricao = GRUPO_TEXTOS.DESCRICAO; else erros.nome = GRUPO_TEXTOS.NOME;
        return { mensagem: '', erros: erros };
      }
      if (r.status === 403) return { mensagem: TEXTOS.SEM_AUTORIDADE, erros: erros };
      return { mensagem: TEXTOS.ACAO_FALHA, erros: erros };
    },
  };

  // Alterar senha: contingência administrativa que define uma NOVA SENHA PROVISÓRIA (a pessoa troca no próximo login).
  var SENHA_TEXTOS = Object.freeze({
    TAMANHO: 'A senha provisória precisa ter de 12 a 128 caracteres.',
    CONFIRMACAO: 'A confirmação não confere com a senha provisória.',
    POLITICA: ERROS_NOVO.senhaPolitica,
    PROPRIA: 'A própria senha é alterada nas Configurações.',
    COMPARTILHADA: 'Esta pessoa tem acesso a outras empresas: use a recuperação de senha por e-mail.',
    OK: 'Senha provisória redefinida. Informe ao usuário pelos meios internos da empresa; ele a troca no próximo acesso.',
  });
  var senhaForm = {
    TEXTOS: SENHA_TEXTOS,
    validar: function (d) {
      var erros = {};
      var s = typeof (d && d.senhaProvisoria) === 'string' ? d.senhaProvisoria : '';
      var n = pontos(s);
      if (n < LIMITES_NOVO.senhaMinima || n > LIMITES_NOVO.senhaMaxima) erros.senhaProvisoria = SENHA_TEXTOS.TAMANHO;
      else if (d.confirmacao !== s) erros.confirmacao = SENHA_TEXTOS.CONFIRMACAO;
      return { ok: Object.keys(erros).length === 0, erros: erros };
    },
    erroDoServidor: function (r) {
      var erros = {};
      if (!r || r.ok) return { mensagem: '', erros: erros };
      if (r.status === 400) { erros.senhaProvisoria = SENHA_TEXTOS.POLITICA; return { mensagem: '', erros: erros }; }
      if (r.codigo === 'USUARIO_SENHA_PROPRIA') return { mensagem: SENHA_TEXTOS.PROPRIA, erros: erros };
      if (r.codigo === 'SENHA_IDENTIDADE_COMPARTILHADA') return { mensagem: SENHA_TEXTOS.COMPARTILHADA, erros: erros };
      if (r.status === 403) return { mensagem: TEXTOS.SEM_AUTORIDADE, erros: erros };
      if (r.status === 404) return { mensagem: texto404(r), erros: erros };
      return { mensagem: TEXTOS.ACAO_FALHA, erros: erros };
    },
  };

  var formulario = {
    LIMITES: LIMITES_NOVO,
    ERROS: ERROS_NOVO,
    POR_CODIGO: POR_CODIGO_NOVO,
    /** Máscara progressiva 000.000.000-00 sobre os dígitos digitados. */
    mascaraCpf: function (v) {
      var d = String(v === undefined || v === null ? '' : v).replace(/\D/g, '').slice(0, 11);
      var s = d.slice(0, 3);
      if (d.length > 3) s += '.' + d.slice(3, 6);
      if (d.length > 6) s += '.' + d.slice(6, 9);
      if (d.length > 9) s += '-' + d.slice(9);
      return s;
    },
    /** "203.0.113.10, 2001:db8::1" → ['203.0.113.10', '2001:db8::1'] (vírgula, ponto e vírgula ou espaço). */
    ipsDe: function (t) {
      return texto(t).split(/[,;\s]+/).filter(function (p) { return p.length > 0; });
    },
    cpfValido: cpfValido,
    ipValido: ipValido,
    /** O Grupo de acesso se aplica a todo tipo de conta, menos Master. */
    grupoSeAplica: function (tipoConta) { return tipoConta !== TIPO_SEM_GRUPO; },
    /**
     * Mantém o campo Grupo coerente com o tipo de conta escolhido: Master →
     * vazio, desabilitado e "Não se aplica" dentro do próprio campo; qualquer
     * outro → disponível e "Sem grupo". O grupo escolhido antes nunca volta.
     */
    ajustarGrupo: function (doc) {
      var tipo = doc.getElementById('nu-tipoConta');
      var grupo = doc.getElementById('nu-grupoAcessoId');
      if (!tipo || !grupo) return;
      var aplica = formulario.grupoSeAplica(tipo.value);
      if (!aplica) grupo.value = '';
      grupo.disabled = !aplica;
      var vazio = grupo.querySelector('option');
      if (vazio) vazio.textContent = aplica ? TEXTOS.SEM_GRUPO : TEXTOS.GRUPO_NAO_SE_APLICA;
    },
    /** Valores do formulário pelos `name` dos controles; a senha não é aparada. */
    lerCampos: function (form) {
      var d = {};
      var controles = form.elements || form.querySelectorAll('input, select, textarea');
      for (var i = 0; i < controles.length; i += 1) {
        var c = controles[i];
        var nome = c && (c.name || (typeof c.getAttribute === 'function' && c.getAttribute('name')));
        if (nome) d[nome] = typeof c.value === 'string' ? c.value : '';
      }
      return d;
    },
    /** @returns {{ok: boolean, erros: Object<string,string>}} erros por campo, na ordem da tela. */
    validar: function (dados, modo) {
      var d = dados || {};
      var edicao = modo === 'editar';
      var erros = {};
      var nome = texto(d.nome);
      if (!nome || pontos(nome) > LIMITES_NOVO.nome) erros.nome = ERROS_NOVO.nome;
      var cpf = texto(d.cpf).replace(/\D/g, '');
      if (!edicao && !cpfValido(cpf)) erros.cpf = ERROS_NOVO.cpf;
      var email = texto(d.email);
      if (!email || pontos(email) > LIMITES_NOVO.email || !EMAIL_SIMPLES.test(email)) erros.email = ERROS_NOVO.email;
      if (!hasOwn(PERFIS, d.tipoConta)) erros.tipoConta = ERROS_NOVO.tipoConta;
      var senha = typeof d.senhaProvisoria === 'string' ? d.senhaProvisoria : '';
      var tamanhoSenha = pontos(senha);
      if (!edicao && (tamanhoSenha < LIMITES_NOVO.senhaMinima || tamanhoSenha > LIMITES_NOVO.senhaMaxima)) erros.senhaProvisoria = ERROS_NOVO.senhaProvisoria;
      else if (!edicao && d.confirmacao !== senha) erros.confirmacao = ERROS_NOVO.confirmacao;
      var ips = formulario.ipsDe(d.ipsPermitidos);
      if (ips.length > LIMITES_NOVO.ips || !ips.every(ipValido)) erros.ipsPermitidos = ERROS_NOVO.ipsPermitidos;
      var grupo = texto(d.grupoAcessoId);
      if (formulario.grupoSeAplica(d.tipoConta) && grupo && !/^[1-9][0-9]{0,9}$/.test(grupo)) erros.grupoAcessoId = ERROS_NOVO.grupoAcessoId;
      var setor = texto(d.setor);
      if (!setor || pontos(setor) > LIMITES_NOVO.setor) erros.setor = ERROS_NOVO.setor;
      var matricula = texto(d.matricula);
      if (!matricula || pontos(matricula) > LIMITES_NOVO.matricula) erros.matricula = ERROS_NOVO.matricula;
      var inicio = texto(d.horarioInicio);
      var fim = texto(d.horarioFim);
      if ((inicio || fim) && !(HORA_HH_MM.test(inicio) && HORA_HH_MM.test(fim))) erros.horario = ERROS_NOVO.horario;
      return { ok: Object.keys(erros).length === 0, erros: erros };
    },
    /**
     * Valores iniciais de "Duplicar usuário": SÓ configuração de acesso do modelo
     * (perfil, se o ator pode criá-lo, e o grupo, achado pelo nome entre os grupos
     * ativos). Nome, e-mail, CPF, matrícula, setor, senha, horário e IPs ficam vazios.
     */
    valoresDeDuplicacao: function (modelo, grupos, perfisPermitidos) {
      var tipo = modelo && (perfisPermitidos || []).indexOf(modelo.perfil) !== -1 ? modelo.perfil : '';
      var grupoId = '';
      if (modelo && modelo.grupo && formulario.grupoSeAplica(modelo.perfil) && formulario.grupoSeAplica(tipo)) {
        gruposValidos(grupos).forEach(function (g) { if (g[1].toLowerCase() === String(modelo.grupo).toLowerCase()) grupoId = g[0]; });
      }
      return { tipoConta: tipo, grupoAcessoId: grupoId };
    },
    /** Valores iniciais do modal de edição, a partir do detalhe autorizado (CPF completo formatado). */
    valoresDeEdicao: function (d) {
      var h = d.horarioTrabalho;
      return {
        nome: d.nome, cpf: formulario.mascaraCpf(d.cpf || ''), email: d.email, tipoConta: d.perfil, matricula: d.matricula || '', setor: d.setor || '',
        horarioInicio: h ? h.inicio : '', horarioFim: h ? h.fim : '', ipsPermitidos: (d.ipsPermitidos || []).join(', '), grupoAcessoId: d.grupoAcessoId === null || d.grupoAcessoId === undefined ? '' : d.grupoAcessoId,
      };
    },
    /**
     * Corpo do PATCH: todos os campos editáveis (nunca CPF nem senha). E-mail só
     * vai se mudou (a identidade pode ser de outras empresas); horário e grupo
     * vazios viram null (limpam); IPs vazios limpam a lista.
     */
    corpoAlteracao: function (dados, original) {
      var d = dados || {};
      var corpo = { nome: texto(d.nome), matricula: texto(d.matricula), setor: texto(d.setor) };
      // O perfil só vai quando MUDOU (o Master, de perfil fixo, nunca envia).
      if (!original || d.tipoConta !== original.perfil) corpo.tipoConta = d.tipoConta;
      var email = texto(d.email);
      if (!original || email.toLowerCase() !== texto(original.email).toLowerCase()) corpo.email = email;
      var inicio = texto(d.horarioInicio);
      var fim = texto(d.horarioFim);
      corpo.horarioTrabalho = inicio && fim ? { inicio: inicio, fim: fim } : null;
      corpo.ipsPermitidos = formulario.ipsDe(d.ipsPermitidos);
      var grupo = texto(d.grupoAcessoId);
      corpo.grupoAcessoId = formulario.grupoSeAplica(d.tipoConta) && /^[1-9][0-9]{0,9}$/.test(grupo) ? Number(grupo) : null;
      return corpo;
    },
    /** Corpo do POST (contrato do backend): CPF só dígitos; opcionais só quando informados; nunca a confirmação. */
    corpo: function (dados) {
      var d = dados || {};
      var corpo = {
        nome: texto(d.nome), email: texto(d.email), tipoConta: d.tipoConta, senhaProvisoria: typeof d.senhaProvisoria === 'string' ? d.senhaProvisoria : '',
        cpf: texto(d.cpf).replace(/\D/g, ''), matricula: texto(d.matricula), setor: texto(d.setor),
      };
      var inicio = texto(d.horarioInicio);
      var fim = texto(d.horarioFim);
      if (inicio && fim) corpo.horarioTrabalho = { inicio: inicio, fim: fim };
      var ips = formulario.ipsDe(d.ipsPermitidos);
      if (ips.length) corpo.ipsPermitidos = ips;
      var grupo = texto(d.grupoAcessoId);
      if (formulario.grupoSeAplica(d.tipoConta) && /^[1-9][0-9]{0,9}$/.test(grupo)) corpo.grupoAcessoId = Number(grupo);
      return corpo;
    },
    /**
     * Resposta de erro do servidor → {mensagem, erros}: 400 aponta os campos
     * pelo caminho `body.<campo>`; 409/403/404 pelo código. Sempre textos daqui.
     */
    erroDoServidor: function (r) {
      var erros = {};
      if (!r || r.ok) return { mensagem: '', erros: erros };
      if (r.status === 400 && Array.isArray(r.detalhes)) {
        r.detalhes.forEach(function (det) {
          var caminho = det && typeof det.campo === 'string' ? det.campo.split('.') : [];
          var campo = caminho[0] === 'body' && hasOwn(CAMPOS_DO_CORPO, caminho[1]) ? CAMPOS_DO_CORPO[caminho[1]] : null;
          if (!campo || erros[campo]) return;
          if (campo === 'senhaProvisoria' && det.codigo !== 'SENHA_CURTA' && det.codigo !== 'SENHA_LONGA' && det.codigo !== 'SENHA_VAZIA' && det.codigo !== 'SENHA_MUITO_LONGA') {
            erros[campo] = ERROS_NOVO.senhaPolitica;
          } else {
            erros[campo] = ERROS_NOVO[campo];
          }
        });
        return { mensagem: Object.keys(erros).length ? '' : TEXTOS.CAMPOS_INVALIDOS, erros: erros };
      }
      if (hasOwn(POR_CODIGO_NOVO, r.codigo)) {
        var par = POR_CODIGO_NOVO[r.codigo];
        if (par[0]) { erros[par[0]] = par[1]; return { mensagem: '', erros: erros }; }
        return { mensagem: par[1], erros: erros };
      }
      if (r.status === 403) return { mensagem: TEXTOS.SEM_AUTORIDADE, erros: erros };
      return { mensagem: TEXTOS.CRIAR_FALHA, erros: erros };
    },
  };

  function campo(doc, nome, rotulo, controle, obrigatorio) {
    controle.setAttribute('name', nome);
    controle.setAttribute('id', 'nu-' + nome);
    controle.setAttribute('data-campo', nome);
    if (obrigatorio) controle.setAttribute('required', '');
    var titulo = no(doc, 'span', {}, [rotulo, obrigatorio ? ' ' : null, obrigatorio ? no(doc, 'span', { class: 'req', 'aria-hidden': 'true' }, ['*']) : null]);
    return no(doc, 'label', { class: 'f' }, [titulo, controle]);
  }
  function entrada(doc, atributos) {
    return no(doc, 'input', Object.assign({ class: 'in', type: 'text', autocomplete: 'off' }, atributos || {}));
  }
  function selecao(doc, opcoes, vazio) {
    return no(doc, 'select', { class: 'in' }, [no(doc, 'option', { value: '' }, [vazio])].concat(opcoes.map(function (o) {
      return no(doc, 'option', { value: String(o[0]) }, [o[1]]);
    })));
  }
  function gruposValidos(lista) {
    return (lista || []).filter(function (g) { return g && inteiroPositivo(g.id) && texto(g.nome) && g.ativo !== false; })
      .map(function (g) { return [g.id, texto(g.nome)]; });
  }

  render.modalSenha = function (doc, nome) {
    function c(n, rotulo) {
      var i = entrada(doc, { type: 'password', autocomplete: 'new-password', maxlength: LIMITES_NOVO.senhaMaxima });
      i.setAttribute('name', n);
      i.setAttribute('id', 'sn-' + n);
      i.setAttribute('data-campo', n);
      return no(doc, 'label', { class: 'f' }, [no(doc, 'span', {}, [rotulo, ' ', no(doc, 'span', { class: 'req', 'aria-hidden': 'true' }, ['*'])]), i]);
    }
    return [
      cabecalhoModal(doc, 'Alterar senha de ' + nome),
      no(doc, 'form', { class: 'mb', id: 'fSenha', novalidate: '', autocomplete: 'off' }, [
        no(doc, 'div', { class: 'grid g-2' }, [c('senhaProvisoria', 'Nova senha provisória'), c('confirmacao', 'Confirmar senha provisória')]),
        no(doc, 'div', { class: 'hint', id: 'hintSenha', role: 'alert', 'aria-live': 'polite' }),
      ]),
      no(doc, 'div', { class: 'mf' }, [
        no(doc, 'button', { class: 'btn link', type: 'button', 'data-close': '' }, ['Cancelar']),
        no(doc, 'button', { class: 'btn primary', type: 'button', id: 'btnRedefinirSenha' }, ['Redefinir senha']),
      ]),
    ];
  };

  /** Lista de grupos da empresa (ativos e inativos) com as ações de cada um; tudo vem do servidor. */
  render.modalGrupos = function (doc, grupos) {
    var linhas = grupos.map(function (g) {
      return no(doc, 'div', { class: 'prow', 'data-linha-grupo': String(g.id) }, [
        no(doc, 'span', { class: 'lbl' }, [
          g.nome, ' ', no(doc, 'span', { class: 'tag ' + (g.ativo ? 'ok' : 'off') }, [g.ativo ? 'Ativo' : 'Inativo']),
          g.descricao ? no(doc, 'small', {}, [g.descricao]) : null,
        ]),
        no(doc, 'span', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end' }, [
          no(doc, 'button', { class: 'btn', type: 'button', 'data-grupo-acao': 'editar', 'data-grupo-id': String(g.id) }, ['Editar']),
          no(doc, 'button', { class: 'btn', type: 'button', 'data-grupo-acao': 'permissoes', 'data-grupo-id': String(g.id) }, ['Permissões']),
          no(doc, 'button', { class: 'btn' + (g.ativo ? ' danger' : ''), type: 'button', 'data-grupo-acao': g.ativo ? 'inativar' : 'reativar', 'data-grupo-id': String(g.id) }, [g.ativo ? 'Inativar' : 'Reativar']),
        ]),
      ]);
    });
    return [
      cabecalhoModal(doc, 'Grupos de acesso'),
      no(doc, 'div', { class: 'mb', id: 'listaGrupos' }, linhas.length
        ? linhas
        : [no(doc, 'p', { class: 'dim', id: 'gruposVazio', style: 'margin:0' }, [TEXTOS.GRUPOS_VAZIO])]),
      no(doc, 'div', { class: 'hint', id: 'hintGrupos', role: 'status', 'aria-live': 'polite' }),
      no(doc, 'div', { class: 'mf' }, [
        no(doc, 'button', { class: 'btn', type: 'button', 'data-grupo-acao': 'novo' }, ['Novo grupo']),
        no(doc, 'button', { class: 'btn primary', type: 'button', 'data-close': '' }, ['Fechar']),
      ]),
    ];
  };

  render.modalNovoGrupo = function (doc, opcoes) {
    var grupoEmEdicao = opcoes && opcoes.grupo ? opcoes.grupo : null;
    var nome = entrada(doc, { maxlength: 100 });
    var descricao = entrada(doc, { maxlength: 500 });
    if (grupoEmEdicao) {
      nome.value = grupoEmEdicao.nome || '';
      descricao.value = grupoEmEdicao.descricao || '';
    }
    function campoGrupo(n, rotulo, controle, obrigatorio) {
      controle.setAttribute('name', n);
      controle.setAttribute('id', 'ng-' + n);
      controle.setAttribute('data-campo', n);
      return no(doc, 'label', { class: 'f' }, [no(doc, 'span', {}, [rotulo, obrigatorio ? ' ' : null, obrigatorio ? no(doc, 'span', { class: 'req', 'aria-hidden': 'true' }, ['*']) : null]), controle]);
    }
    return [
      cabecalhoModal(doc, grupoEmEdicao ? 'Editar grupo' : 'Novo grupo'),
      no(doc, 'form', { class: 'mb', id: 'fGrupo', novalidate: '', autocomplete: 'off' }, [
        no(doc, 'p', { class: 'dim', style: 'margin:0 0 14px;font-size:.85rem' }, [GRUPO_TEXTOS.DICA]),
        no(doc, 'div', { class: 'grid g-2' }, [campoGrupo('nome', 'Nome do grupo', nome, true), campoGrupo('descricao', 'Descrição', descricao, false)]),
        no(doc, 'div', { class: 'hint', id: 'hintGrupo', role: 'alert', 'aria-live': 'polite' }),
      ]),
      no(doc, 'div', { class: 'mf' }, [
        no(doc, 'button', { class: 'btn link', type: 'button', 'data-close': '' }, ['Voltar sem mudar nada']),
        no(doc, 'button', { class: 'btn primary', type: 'button', id: 'btnSalvarGrupo' }, [grupoEmEdicao ? 'Salvar alterações' : 'Criar grupo']),
      ]),
    ];
  };

  // Modos do mesmo modal: 'novo' | 'editar' (CPF completo e só leitura, sem senha) | 'duplicar' (dados pessoais vazios, "modelo de acesso").
  var TITULOS_MODO = Object.freeze({ novo: ['Novo usuário', 'Cadastrar usuário'], editar: ['Alterar usuário', 'Salvar alterações'], duplicar: ['Duplicar usuário', 'Duplicar usuário'] });
  render.modalNovoUsuario = function (doc, opcoes) {
    var o = opcoes || {};
    var modo = hasOwn(TITULOS_MODO, o.modo) ? o.modo : 'novo';
    var v = o.valores || {};
    var perfis = (Array.isArray(o.perfis) ? o.perfis : []).filter(function (p) { return hasOwn(PERFIS, p); });
    function com(controle, nome) { if (v[nome] !== undefined && v[nome] !== null) controle.value = String(v[nome]); return controle; }
    var cpf = com(entrada(doc, { inputmode: 'numeric', placeholder: '000.000.000-00', maxlength: 14 }), 'cpf');
    if (modo === 'editar') { cpf.setAttribute('readonly', ''); cpf.setAttribute('aria-readonly', 'true'); }
    var linha2 = [];
    if (modo !== 'editar') {
      linha2.push(
        campo(doc, 'senhaProvisoria', 'Senha provisória', entrada(doc, { type: 'password', autocomplete: 'new-password', maxlength: LIMITES_NOVO.senhaMaxima }), true),
        campo(doc, 'confirmacao', 'Confirmar senha provisória', entrada(doc, { type: 'password', autocomplete: 'new-password', maxlength: LIMITES_NOVO.senhaMaxima }), true)
      );
    }
    linha2.push(campo(doc, 'ipsPermitidos', 'IP(s) permitido(s)', com(entrada(doc, { placeholder: 'Opcional: IPv4 ou IPv6, separados por vírgula' }), 'ipsPermitidos'), false));
    var tipo = com(selecao(doc, perfis.map(function (p) { return [p, PERFIS[p]]; }), 'Selecione'), 'tipoConta');
    // Edição de usuário de perfil fixo (Master): só o perfil atual, travado; nenhuma transformação por esta tela.
    if (o.perfilFixo) tipo.setAttribute('disabled', '');
    var grupo = com(selecao(doc, gruposValidos(o.grupos), TEXTOS.SEM_GRUPO), 'grupoAcessoId');
    var filhos = [];
    if (modo === 'duplicar' && o.modelo) filhos.push(no(doc, 'p', { class: 'dim', id: 'notaModelo', style: 'margin:0 0 12px;font-size:.85rem' }, ['Usando ' + o.modelo + ' como modelo de acesso']));
    filhos.push(
      no(doc, 'h3', {}, ['Dados cadastrais']),
      no(doc, 'div', { class: 'grid g-user1' }, [
        campo(doc, 'nome', 'Nome completo', com(entrada(doc, { maxlength: LIMITES_NOVO.nome }), 'nome'), true),
        campo(doc, 'cpf', 'CPF', cpf, true),
        campo(doc, 'email', 'E-mail', com(entrada(doc, { type: 'email', placeholder: 'exemplo@dominio.com', maxlength: LIMITES_NOVO.email }), 'email'), true),
        campo(doc, 'tipoConta', 'Perfil / Tipo de conta', tipo, true),
      ]),
      no(doc, 'div', { class: 'grid g-user2', style: 'margin-top:14px' }, linha2),
      no(doc, 'div', { class: 'hint', id: 'hintUser', role: 'alert', 'aria-live': 'polite' }),
      no(doc, 'h3', {}, ['Estrutura']),
      no(doc, 'div', { class: 'grid g-est' }, [
        campo(doc, 'grupoAcessoId', 'Grupo de acesso', grupo, false),
        campo(doc, 'setor', 'Setor', com(entrada(doc, { maxlength: LIMITES_NOVO.setor }), 'setor'), true),
        campo(doc, 'matricula', 'Matrícula', com(entrada(doc, { maxlength: LIMITES_NOVO.matricula }), 'matricula'), true),
        campo(doc, 'horarioInicio', 'Horário de trabalho de', com(entrada(doc, { type: 'time' }), 'horarioInicio'), false),
        campo(doc, 'horarioFim', 'até', com(entrada(doc, { type: 'time' }), 'horarioFim'), false)
      ])
    );
    var form = no(doc, 'form', { class: 'mb', id: 'fUser', novalidate: '', autocomplete: 'off', 'data-modo': modo }, filhos);
    return [
      cabecalhoModal(doc, TITULOS_MODO[modo][0]),
      form,
      no(doc, 'div', { class: 'mf' }, [
        no(doc, 'button', { class: 'btn link', type: 'button', 'data-close': '' }, ['Voltar sem mudar nada']),
        no(doc, 'button', { class: 'btn primary', type: 'button', id: 'btnSalvarUser' }, [TITULOS_MODO[modo][1]]),
      ]),
    ];
  };

  // ─── CSV (só campos reais) ─────────────────────────────────────────
  var csv = {
    celula: function (v) {
      var s = String(v === undefined || v === null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      if (/[;"\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    },
    gerar: function (lista) {
      var linhas = [['ID', 'Usuário', 'Login', 'Perfil', 'Grupo', 'E-mail', 'Status'].join(';')];
      (lista || []).forEach(function (u) {
        linhas.push([u.id, u.nome, u.email, u.perfil && PERFIS[u.perfil] ? PERFIS[u.perfil] : TRACO, u.grupo || TRACO, u.email, u.ativo ? TEXTOS.HABILITADO : TEXTOS.DESABILITADO]
          .map(csv.celula).join(';'));
      });
      return linhas.join('\n');
    },
  };

  global.EpiGestaoUsuarios = {
    modelo: modelo,
    acoes: acoes,
    visao: visao,
    render: render,
    formulario: formulario,
    situacao: situacao,
    grupoForm: grupoForm,
    senhaForm: senhaForm,
    csv: csv,
    rotuloPerfil: function (p) { return hasOwn(PERFIS, p) ? PERFIS[p] : TRACO; },
    TEXTOS: TEXTOS,
    STATUS: STATUS,
    AGRUPAMENTOS: AGRUPAMENTOS,
    COLS: COLS,
    LIMITE_PAGINA: LIMITE_PAGINA,
    CAMINHO_CONTA: CAMINHO_CONTA,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiGestaoUsuarios;
  }
})(typeof window !== 'undefined' ? window : globalThis);
