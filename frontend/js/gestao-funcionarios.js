(function (global) {
  'use strict';

  /**
   * EpiGestaoFuncionarios — Gestão de Funcionários (frontend operacional).
   *
   * Somente rotas reais, com as permissões congeladas de employeeHistory (o servidor é a autoridade; aqui só se decide o que
   * mostrar):
   *   GET  /funcionarios?pagina&limite        lista paginada (a tela junta todas as páginas e filtra localmente)
   *   GET  /funcionarios/ghes                 seletor de GHE: { id, codigo, descricao } dos GHEs ativos da empresa
   *   POST /funcionarios                      cadastro individual (employeeHistory.criar); nasce ATIVO
   *   PATCH /funcionarios/:id                 edição (employeeHistory.editar); nunca cpf, situacao nem ativo
   *   POST /funcionarios/:id/situacao         { situacao: ATIVO | AFASTADO | INATIVO } (employeeHistory.editar)
   *
   *   acoes       — chamadas à API (envelope do EpiHttp).
   *   modelo      — normalização do que a API devolve.
   *   visao       — busca local (nome, matrícula, setor, cargo e GHE; nunca CPF).
   *   formulario  — validação local (as mesmas regras de data da API) e montagem dos corpos.
   *   erros       — leitura dos erros da API (código estável; campo só quando inequívoco).
   *   criarTela   — liga tudo ao DOM do protótipo aprovado (pages/funcionarios.html), sempre com textContent.
   *
   * Nada vai para armazenamento do navegador. O CPF completo só aparece, por ~30 s, pelo olho da edição (rota dedicada, com
   employeeHistory.editar); nunca é guardado nem enviado fora do cadastro.
   */

  var CAMINHO = '/funcionarios';
  var LIMITE_PAGINA = 100; // LIMITES.LIMITE_MAXIMO da API (o padrão dela é 20)
  var PAGINA_MAXIMA_API = 10000; // LIMITES.PAGINA_MAXIMA: a API recusa páginas acima disso
  var FUSO = 'America/Sao_Paulo';
  var NASCIMENTO_MINIMO = '1900-01-01';
  var CPF_REVELADO_MS = 30000; // o CPF completo volta à máscara sozinho depois deste tempo

  var ROTULOS_SITUACAO = { ATIVO: 'Ativo', AFASTADO: 'Afastado', INATIVO: 'Inativo' };
  // Ações por situação: INATIVO não vai direto a AFASTADO (regra da API).
  var ACOES_SITUACAO = {
    ATIVO: [{ destino: 'AFASTADO', rotulo: 'Afastar', icone: 'event_busy' }, { destino: 'INATIVO', rotulo: 'Inativar', icone: 'block' }],
    AFASTADO: [{ destino: 'ATIVO', rotulo: 'Ativar', icone: 'check_circle' }, { destino: 'INATIVO', rotulo: 'Inativar', icone: 'block' }],
    INATIVO: [{ destino: 'ATIVO', rotulo: 'Ativar', icone: 'check_circle' }],
  };
  var EXPLICACAO = {
    AFASTADO: 'Enquanto estiver afastado, o colaborador não solicita nem recebe EPI. Nada é apagado e ele pode voltar a ficar ativo.',
    INATIVO: 'O colaborador deixa de solicitar e de receber EPI. O cadastro e o histórico são mantidos.',
    ATIVO: 'O colaborador volta a poder solicitar e receber EPI, conforme as demais regras.',
  };

  var TEXTOS = {
    VAZIO: 'Nenhum colaborador encontrado.',
    CARREGANDO: 'Carregando colaboradores…',
    FALHA_LISTA: 'Não foi possível carregar os colaboradores. Recarregue a página para tentar novamente.',
    FALHA_GHES: 'Não foi possível carregar os GHEs.',
    CORRIJA: 'Corrija os campos destacados.',
    CADASTRADO: 'Colaborador cadastrado!',
    SALVO: 'Alterações salvas!',
    SEM_ALTERACAO: 'Nenhuma alteração para salvar.',
    SITUACAO_ALTERADA: 'Situação alterada.',
    SEM_PERMISSAO: 'Você não tem permissão para esta operação.',
    NAO_ENCONTRADO: 'Colaborador não encontrado. A lista foi atualizada.',
    SITUACAO_MUDOU: 'A situação do colaborador já mudou. A lista foi atualizada.',
    GENERICO: 'Não foi possível concluir a operação. Tente novamente.',
    REDE: 'Não foi possível falar com o servidor. Verifique sua conexão.',
    LIMITE_CPF: 'Muitas consultas ao CPF em pouco tempo. Aguarde um instante e tente novamente.',
    CPF_FALHA: 'Não foi possível mostrar o CPF. Tente novamente.',
    CPF_INDISPONIVEL: 'A consulta do CPF não está disponível neste servidor. Avise o administrador para atualizar o sistema.',
  };
  var MSG = {
    nome: 'Informe o nome.',
    cpfCurto: 'O CPF deve ter 11 dígitos.',
    cpfInvalido: 'CPF inválido.',
    setor: 'Informe o setor.',
    cargo: 'Informe o cargo.',
    ghe: 'Selecione o GHE.',
    gheObrigatorio: 'O colaborador precisa ter um GHE.',
    telefone: 'Telefone incompleto.',
    dataInvalida: 'Data inválida.',
    nascimentoMinimo: 'A data deve ser a partir de 1900.',
    nascimentoPassado: 'A data deve estar no passado.',
    contratacao: 'Informe a data de contratação.',
    contratacaoFutura: 'A data não pode ser futura.',
    contratacaoPosterior: 'Deve ser posterior ao nascimento.',
    cpfEmUso: 'Já existe colaborador com este CPF.',
    matriculaEmUso: 'Já existe colaborador com esta matrícula.',
    gheInativo: 'Este GHE está inativo. Escolha outro GHE.',
    gheInvalido: 'GHE inválido. Escolha um GHE da lista.',
    nascimentoServidor: 'Data de nascimento inválida.',
    contratacaoServidor: 'Data de contratação inválida.',
  };
  // Campo da API (body.<campo>) → sufixo dos ids do formulário (#f<Sufixo>, #e<Sufixo>).
  var CAMPO_DA_TELA = {
    nome: 'Nome', cpf: 'Cpf', matricula: 'Matricula', setor: 'Setor', funcao: 'Cargo', grupoHomogeneoId: 'Ghe', telefone: 'Telefone', dataNascimento: 'Nascimento', dataAdmissao: 'Contratacao',
  };
  var CAMPOS = ['Nome', 'Cpf', 'Matricula', 'Setor', 'Cargo', 'Ghe', 'Telefone', 'Nascimento', 'Contratacao'];

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/gestao-funcionarios.js');
    return global.EpiHttp;
  }
  function texto(v) { return v === null || v === undefined ? '' : String(v); }
  function digitos(v) { return texto(v).replace(/\D/g, ''); }
  function vazioParaNulo(v) { var t = texto(v).trim(); return t === '' ? null : t; }

  /** Data civil de hoje no fuso da operação (o mesmo da API), AAAA-MM-DD. */
  function dataDeHoje() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  function dataReal(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto(s));
    if (!m) return false;
    var d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  }
  function mascararCpf(valor) {
    var v = digitos(valor).slice(0, 11);
    if (v.length > 9) return v.replace(/(\d{3})(\d{3})(\d{3})(\d{0,2})/, '$1.$2.$3-$4');
    if (v.length > 6) return v.replace(/(\d{3})(\d{3})(\d{0,3})/, '$1.$2.$3');
    if (v.length > 3) return v.replace(/(\d{3})(\d{0,3})/, '$1.$2');
    return v;
  }
  function mascararTelefone(valor) {
    var v = digitos(valor).slice(0, 11);
    if (v.length > 10) return v.replace(/(\d{2})(\d{5})(\d{0,4})/, '($1) $2-$3');
    if (v.length > 6) return v.replace(/(\d{2})(\d{4})(\d{0,4})/, '($1) $2-$3');
    if (v.length > 2) return v.replace(/(\d{2})(\d{0,5})/, '($1) $2');
    return v;
  }
  function cpfValido(c) {
    if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
    for (var t = 9; t < 11; t += 1) {
      var soma = 0;
      for (var i = 0; i < t; i += 1) soma += Number(c[i]) * (t + 1 - i);
      if (((soma * 10) % 11) % 10 !== Number(c[t])) return false;
    }
    return true;
  }

  // ─── Ações ─────────────────────────────────────────────────────────
  var acoes = {
    listarPagina: function (pagina, limite) {
      return http().requisitar('GET', CAMINHO + '?pagina=' + encodeURIComponent(pagina) + '&limite=' + encodeURIComponent(limite));
    },
    ghes: function () { return http().requisitar('GET', CAMINHO + '/ghes'); },
    criar: function (corpo) { return http().requisitar('POST', CAMINHO, { corpo: corpo }); },
    alterar: function (id, corpo) { return http().requisitar('PATCH', CAMINHO + '/' + encodeURIComponent(id), { corpo: corpo }); },
    /** Única chamada que devolve o CPF completo: rota dedicada, POST, corpo vazio (empresa e ator vêm da sessão). */
    revelarCpf: function (id) {
      return http().requisitar('POST', CAMINHO + '/' + encodeURIComponent(id) + '/cpf/revelar', { corpo: {} });
    },
    situacao: function (id, destino) {
      return http().requisitar('POST', CAMINHO + '/' + encodeURIComponent(id) + '/situacao', { corpo: { situacao: destino } });
    },
    /**
     * Junta todas as páginas da API (a paginação é a dela). Sem teto de quantidade: a proteção é contra
     * metadados inconsistentes (total inválido, página sem nenhum id novo, página além do máximo da API),
     * que viram falha da carga, nunca uma lista parcial.
     */
    carregarTodos: async function () {
      var falha = function (status) { return { ok: false, status: status, funcionarios: [], total: 0 }; };
      var todos = [];
      var vistos = {};
      var pagina = 1;
      for (;;) {
        var r = await acoes.listarPagina(pagina, LIMITE_PAGINA);
        if (!r || !r.ok) return falha(r ? r.status : 0);
        var d = r.dados || {};
        var total = d.total;
        if (!Array.isArray(d.funcionarios) || !Number.isInteger(total) || total < 0) return falha(0);
        var novos = 0;
        for (var i = 0; i < d.funcionarios.length; i += 1) {
          var n = modelo.normalizar(d.funcionarios[i]);
          if (n && !vistos[n.id]) { vistos[n.id] = true; todos.push(n); novos += 1; }
        }
        if (pagina * LIMITE_PAGINA >= total) return { ok: true, funcionarios: todos, total: total };
        if (novos === 0 || pagina >= PAGINA_MAXIMA_API) return falha(0);
        pagina += 1;
      }
    },
  };

  // ─── Modelo ────────────────────────────────────────────────────────
  var modelo = {
    ghe: function (g) {
      if (!g || !Number.isInteger(g.id) || g.id <= 0) return null;
      return { id: g.id, codigo: g.codigo === null || g.codigo === undefined ? null : texto(g.codigo), descricao: texto(g.descricao) };
    },
    normalizar: function (f) {
      if (!f || !Number.isInteger(f.id)) return null;
      var situacao = ROTULOS_SITUACAO[f.situacao] ? f.situacao : (f.ativo === true ? 'ATIVO' : 'INATIVO');
      return {
        id: f.id,
        nome: texto(f.nome),
        matricula: f.matricula === null || f.matricula === undefined ? null : texto(f.matricula),
        cpfMascarado: f.cpfMascarado === null || f.cpfMascarado === undefined ? null : texto(f.cpfMascarado),
        setor: f.setor === null || f.setor === undefined ? null : texto(f.setor),
        funcao: f.funcao === null || f.funcao === undefined ? null : texto(f.funcao),
        telefone: f.telefone === null || f.telefone === undefined ? null : texto(f.telefone),
        dataNascimento: f.dataNascimento || null,
        dataAdmissao: f.dataAdmissao || null,
        situacao: situacao,
        grupoHomogeneoId: Number.isInteger(f.grupoHomogeneoId) ? f.grupoHomogeneoId : null,
        grupoHomogeneo: modelo.ghe(f.grupoHomogeneo),
      };
    },
  };

  // ─── Visão ─────────────────────────────────────────────────────────
  function textoDoGhe(g) {
    if (!g) return '';
    return (g.codigo ? g.codigo + ' — ' : '') + g.descricao;
  }
  /** Na tabela só o código devolvido pela API; sem GHE ou GHE legado sem código, vazio (a tela mostra "—"; nunca descrição nem código inventado). */
  function rotuloDoGheNaTabela(g) {
    return g && g.codigo ? texto(g.codigo) : '';
  }
  var visao = {
    textoDoGhe: textoDoGhe,
    rotuloDoGheNaTabela: rotuloDoGheNaTabela,
    /**
     * Busca local por nome, matrícula, setor, cargo e GHE (código ou descrição). Nunca CPF. A situação (ATIVO, AFASTADO ou
     * INATIVO) é um filtro à parte, combinado com a busca; qualquer outro valor equivale a "Todos".
     */
    filtrar: function (lista, consulta, situacao) {
      var q = texto(consulta).toLowerCase().trim();
      var base = ROTULOS_SITUACAO[situacao] ? lista.filter(function (f) { return f.situacao === situacao; }) : lista.slice();
      if (!q) return base;
      return base.filter(function (f) {
        var palheiro = [f.nome, f.matricula, f.setor, f.funcao, f.grupoHomogeneo ? f.grupoHomogeneo.codigo : '', f.grupoHomogeneo ? f.grupoHomogeneo.descricao : '']
          .map(texto).join(' ').toLowerCase();
        return palheiro.indexOf(q) >= 0;
      });
    },
    ordenar: function (lista) {
      return lista.slice().sort(function (a, b) { return a.nome.localeCompare(b.nome, 'pt-BR'); });
    },
    contagem: function (mostrados, total) {
      return mostrados + ' de ' + total + ' colaborador' + (total !== 1 ? 'es' : '');
    },
  };

  // ─── Formulário ────────────────────────────────────────────────────
  var formulario = {
    /**
     * valores: o que está nos campos (#f<Campo>). contexto: { original (funcionário normalizado, só na edição), hoje }.
     * Cadastro: nome, CPF (11 dígitos válidos), setor, cargo, GHE e contratação obrigatórios. Edição: parcial, como a API —
     * ninguém é obrigado a preencher retroativamente o que o cadastro antigo não tinha; o que já existia não pode ser esvaziado
     * (GHE incluído) e só as datas ALTERADAS passam pelas regras de data.
     */
    validar: function (v, contexto) {
      var c = contexto || {};
      var o = c.original || null;
      var hoje = c.hoje || dataDeHoje();
      var e = {};
      var nome = texto(v.nome).trim();
      var setor = texto(v.setor).trim();
      var cargo = texto(v.funcao).trim();
      var telefone = texto(v.telefone).trim();
      var nasc = texto(v.dataNascimento).trim();
      var contr = texto(v.dataAdmissao).trim();
      var ghe = texto(v.grupoHomogeneoId).trim();

      if (!nome) e.Nome = MSG.nome;
      if (!o) {
        var cpf = digitos(v.cpf);
        if (cpf.length !== 11) e.Cpf = MSG.cpfCurto;
        else if (!cpfValido(cpf)) e.Cpf = MSG.cpfInvalido;
      }
      if (!setor && (!o || texto(o.setor).trim())) e.Setor = MSG.setor;
      if (!cargo && (!o || texto(o.funcao).trim())) e.Cargo = MSG.cargo;
      if (!ghe) {
        if (!o) e.Ghe = MSG.ghe;
        else if (o.grupoHomogeneoId !== null) e.Ghe = MSG.gheObrigatorio;
      }
      if (telefone && digitos(telefone).length < 10 && (!o || digitos(telefone) !== digitos(o.telefone))) e.Telefone = MSG.telefone;

      var nascAlterada = !o || nasc !== texto(o.dataNascimento);
      var contrAlterada = !o || contr !== texto(o.dataAdmissao);
      if (nasc && nascAlterada) {
        if (!dataReal(nasc)) e.Nascimento = MSG.dataInvalida;
        else if (nasc < NASCIMENTO_MINIMO) e.Nascimento = MSG.nascimentoMinimo;
        else if (nasc >= hoje) e.Nascimento = MSG.nascimentoPassado;
      }
      if (!contr) {
        if (!o || texto(o.dataAdmissao)) e.Contratacao = MSG.contratacao;
      } else if (contrAlterada) {
        if (!dataReal(contr)) e.Contratacao = MSG.dataInvalida;
        else if (contr > hoje) e.Contratacao = MSG.contratacaoFutura;
      }
      if (nasc && contr && (nascAlterada || contrAlterada) && !e.Nascimento && !e.Contratacao && dataReal(nasc) && dataReal(contr) && contr <= nasc) {
        e.Contratacao = MSG.contratacaoPosterior;
      }
      return { ok: Object.keys(e).length === 0, erros: e };
    },
    /** Corpo do POST: só os campos da API; opcionais só quando informados; nunca situacao, ativo nem matrícula inventada. */
    corpoCadastro: function (v) {
      var corpo = {
        nome: texto(v.nome).trim(),
        cpf: digitos(v.cpf),
        setor: texto(v.setor).trim(),
        funcao: texto(v.funcao).trim(),
        grupoHomogeneoId: Number(v.grupoHomogeneoId),
        dataAdmissao: texto(v.dataAdmissao).trim(),
      };
      var matricula = vazioParaNulo(v.matricula);
      var telefone = vazioParaNulo(v.telefone);
      var nascimento = vazioParaNulo(v.dataNascimento);
      if (matricula !== null) corpo.matricula = matricula;
      if (telefone !== null) corpo.telefone = telefone;
      if (nascimento !== null) corpo.dataNascimento = nascimento;
      return corpo;
    },
    /** Corpo do PATCH: só campos editáveis da API que mudaram; nunca CPF, situacao nem ativo; o GHE só como id de um GHE. */
    corpoEdicao: function (v, o) {
      var corpo = {};
      var nome = texto(v.nome).trim();
      var setor = texto(v.setor).trim();
      var cargo = texto(v.funcao).trim();
      if (nome !== texto(o.nome)) corpo.nome = nome;
      if (setor !== texto(o.setor)) corpo.setor = setor;
      if (cargo !== texto(o.funcao)) corpo.funcao = cargo;
      var matricula = vazioParaNulo(v.matricula);
      if (texto(matricula) !== texto(o.matricula)) corpo.matricula = matricula;
      var telefone = vazioParaNulo(v.telefone);
      if (digitos(telefone) !== digitos(o.telefone)) corpo.telefone = telefone;
      var nascimento = vazioParaNulo(v.dataNascimento);
      if (texto(nascimento) !== texto(o.dataNascimento)) corpo.dataNascimento = nascimento;
      var contratacao = vazioParaNulo(v.dataAdmissao);
      if (contratacao !== null && contratacao !== texto(o.dataAdmissao)) corpo.dataAdmissao = contratacao;
      var ghe = texto(v.grupoHomogeneoId).trim();
      if (ghe && Number(ghe) !== o.grupoHomogeneoId) corpo.grupoHomogeneoId = Number(ghe);
      return corpo;
    },
  };

  // ─── Erros da API ──────────────────────────────────────────────────
  var erros = {
    /**
     * { sessao: true } (401) | { campos: {Sufixo: texto} } | { aviso: texto, atualizar: bool, recarregarGhes: bool }.
     * Campo só quando a identificação é inequívoca (código de domínio do campo ou detalhe `body.<campo>`).
     */
    daEscrita: function (r) {
      var status = r ? r.status : 0;
      var codigo = r ? r.codigo : null;
      if (status === 401) return { sessao: true };
      if (status === 403) return { aviso: TEXTOS.SEM_PERMISSAO };
      if (status === 404) return { aviso: TEXTOS.NAO_ENCONTRADO, atualizar: true, fechar: true };
      if (codigo === 'FUNCIONARIO_CPF_EM_USO') return { campos: { Cpf: MSG.cpfEmUso } };
      if (codigo === 'FUNCIONARIO_MATRICULA_EM_USO') return { campos: { Matricula: MSG.matriculaEmUso } };
      if (codigo === 'FUNCIONARIO_GHE_INATIVO') return { campos: { Ghe: MSG.gheInativo }, recarregarGhes: true };
      if (codigo === 'FUNCIONARIO_GHE_INVALIDO') return { campos: { Ghe: MSG.gheInvalido }, recarregarGhes: true };
      if (codigo === 'FUNCIONARIO_GHE_OBRIGATORIO') return { campos: { Ghe: MSG.gheObrigatorio } };
      if (codigo === 'FUNCIONARIO_DATA_NASCIMENTO_INVALIDA') return { campos: { Nascimento: MSG.nascimentoServidor } };
      if (codigo === 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA') return { campos: { Contratacao: MSG.contratacaoServidor } };
      if (codigo === 'VALIDACAO' && r && Array.isArray(r.detalhes)) {
        var campos = {};
        r.detalhes.forEach(function (d) {
          var m = d && typeof d.campo === 'string' ? /^body\.(.+)$/.exec(d.campo) : null;
          if (m && Object.prototype.hasOwnProperty.call(CAMPO_DA_TELA, m[1])) campos[CAMPO_DA_TELA[m[1]]] = texto(d.mensagem) || 'Valor inválido.';
        });
        if (Object.keys(campos).length > 0) return { campos: campos };
      }
      if (status === 0) return { aviso: TEXTOS.REDE };
      return { aviso: TEXTOS.GENERICO };
    },
    /**
     * { sessao: true } (401) | { aviso, atualizar? }. Nunca ecoa dado do servidor. 404 só é "colaborador não encontrado" com o
     * código do serviço; qualquer outro 404 (rota ausente num backend desatualizado) é indisponibilidade, sem reler a lista.
     */
    daRevelacaoCpf: function (r) {
      var status = r ? r.status : 0;
      var codigo = r ? r.codigo : null;
      if (status === 401) return { sessao: true };
      if (status === 403) return { aviso: TEXTOS.SEM_PERMISSAO };
      if (status === 404 && codigo === 'FUNCIONARIO_NAO_ENCONTRADO') return { aviso: TEXTOS.NAO_ENCONTRADO, atualizar: true };
      if (status === 404) return { aviso: TEXTOS.CPF_INDISPONIVEL };
      if (status === 429) return { aviso: TEXTOS.LIMITE_CPF };
      if (status === 0) return { aviso: TEXTOS.REDE };
      return { aviso: TEXTOS.CPF_FALHA };
    },
    /** O CPF de uma resposta de sucesso: exatamente 11 dígitos; qualquer outra coisa não é exibida. */
    cpfDaResposta: function (r) {
      var cpf = r && r.ok && r.dados ? r.dados.cpf : null;
      return typeof cpf === 'string' && /^\d{11}$/.test(cpf) ? cpf : null;
    },
    daSituacao: function (r) {
      var status = r ? r.status : 0;
      var codigo = r ? r.codigo : null;
      if (status === 401) return { sessao: true };
      if (status === 403) return { aviso: TEXTOS.SEM_PERMISSAO };
      if (status === 404) return { aviso: TEXTOS.NAO_ENCONTRADO, atualizar: true };
      if (codigo === 'FUNCIONARIO_SITUACAO_IGUAL' || codigo === 'FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA') return { aviso: TEXTOS.SITUACAO_MUDOU, atualizar: true };
      if (status === 0) return { aviso: TEXTOS.REDE };
      return { aviso: TEXTOS.GENERICO };
    },
  };

  function capacidades(permissoes) {
    var P = global.EpiPermissoes;
    var tem = function (op) { return !!(P && permissoes && P.recurso(permissoes, 'employeeHistory', op)); };
    return { visualizar: tem('visualizar'), cadastrar: tem('criar'), editar: tem('editar') };
  }

  // ─── Tela ──────────────────────────────────────────────────────────
  function criarTela(opcoes) {
    var o = opcoes || {};
    var doc = o.documento || global.document;
    var cap = o.capacidades || { visualizar: false, cadastrar: false, editar: false };
    var $ = function (id) { return doc.getElementById(id); };

    var lista = [];
    var ghes = [];
    var listaFalhou = false;
    var carregandoLista = false;
    var emEdicao = null; // funcionário normalizado em edição; null = cadastro
    var enviando = false;
    var encerrada = false;
    var situacaoPendente = null; // { funcionario, destino }
    var ligada = false;
    // Revelação do CPF: o valor completo nunca é guardado em variável do módulo; vive só no campo enquanto `cpfVisivel`.
    var cpfVisivel = false;
    var temporizadorCpf = null;
    var sequenciaCpf = 0; // invalida resposta atrasada quando o CPF é ocultado, o modal fecha ou outro funcionário abre
    var pedindoCpf = false;

    function no(tag, atributos, filhos) {
      var e = doc.createElement(tag);
      Object.keys(atributos || {}).forEach(function (k) {
        if (k === 'class') e.className = atributos[k];
        else e.setAttribute(k, atributos[k]);
      });
      (filhos || []).forEach(function (f) { e.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f); });
      return e;
    }
    function icone(nome) { return no('span', { class: 'material-symbols-outlined' }, [nome]); }

    function aviso(msg, tipo) {
      var caixa = $('toasts');
      if (!caixa) return;
      var t = no('div', { class: 'toast ' + (tipo || 'info') }, [
        icone(tipo === 'ok' ? 'check_circle' : tipo === 'err' ? 'error' : 'info'), no('span', {}, [msg]),
      ]);
      caixa.appendChild(t);
      if (global.setTimeout) global.setTimeout(function () { if (t.remove) t.remove(); }, 3500);
    }
    function sessaoCaiu() {
      encerrada = true;
      ocultarCpf();
      if (typeof o.aoSessaoEncerrada === 'function') o.aoSessaoEncerrada();
    }

    // ── CPF completo (só na edição, só com employeeHistory.editar)
    function atualizarOlho() {
      var b = $('btnCpfOlho');
      if (!b) return;
      b.setAttribute('aria-label', cpfVisivel ? 'Ocultar CPF' : 'Mostrar CPF');
      b.setAttribute('aria-pressed', cpfVisivel ? 'true' : 'false');
      b.replaceChildren(icone(cpfVisivel ? 'visibility_off' : 'visibility'));
    }
    /** Volta à máscara, cancela o temporizador, invalida resposta em voo e solta o CPF completo. */
    function ocultarCpf() {
      sequenciaCpf += 1;
      pedindoCpf = false;
      if (temporizadorCpf !== null) { global.clearTimeout(temporizadorCpf); temporizadorCpf = null; }
      cpfVisivel = false;
      var campo = $('fCpf');
      if (campo && campo.disabled) campo.value = emEdicao ? texto(emEdicao.cpfMascarado) : '';
      atualizarOlho();
    }
    async function alternarCpf() {
      if (encerrada || !emEdicao || !cap.editar) return;
      if (cpfVisivel) { ocultarCpf(); return; }
      if (pedindoCpf) return;
      var ficha = emEdicao;
      pedindoCpf = true;
      sequenciaCpf += 1;
      var token = sequenciaCpf;
      var r = await acoes.revelarCpf(ficha.id);
      if (token !== sequenciaCpf || encerrada || emEdicao !== ficha) { r = null; return; }
      pedindoCpf = false;
      var cpf = erros.cpfDaResposta(r);
      if (cpf !== null) {
        $('fCpf').value = mascararCpf(cpf);
        cpf = null;
        r = null;
        cpfVisivel = true;
        atualizarOlho();
        temporizadorCpf = global.setTimeout(ocultarCpf, CPF_REVELADO_MS);
        return;
      }
      var tratamento = erros.daRevelacaoCpf(r);
      r = null;
      ocultarCpf();
      if (tratamento.sessao) { sessaoCaiu(); return; }
      aviso(tratamento.aviso, 'err');
      if (tratamento.atualizar) await recarregar();
    }

    // ── lista
    function linhaVazia(msg) {
      var td = no('td', { class: 'empty', colspan: '7' }, [msg]);
      return no('tr', {}, [td]);
    }
    function botaoAcao(rotulo, nomeIcone, aoClicar) {
      var b = no('button', { class: 'btn btn-outlined btn-sm', type: 'button' }, [no('span', { class: 'material-symbols-outlined', style: 'font-size:16px' }, [nomeIcone]), rotulo]);
      b.addEventListener('click', aoClicar);
      return b;
    }
    function linhaDe(f) {
      var celulaAcao = no('td', {});
      var botoes = [];
      if (cap.editar) {
        botoes.push(botaoAcao('Editar', 'edit', function () { abrirFormulario(f); }));
        (ACOES_SITUACAO[f.situacao] || []).forEach(function (a) {
          botoes.push(botaoAcao(a.rotulo, a.icone, function () { abrirConfirmacao(f, a); }));
        });
      }
      if (botoes.length) celulaAcao.appendChild(no('div', { class: 'acoes' }, botoes)); else celulaAcao.textContent = '—';
      return no('tr', {}, [
        no('td', { class: 'name' }, [f.nome]),
        no('td', {}, [f.matricula || '—']),
        no('td', {}, [f.setor || '—']),
        no('td', {}, [f.funcao || '—']),
        no('td', {}, rotuloDoGheNaTabela(f.grupoHomogeneo) ? [no('span', { class: 'badge' }, [rotuloDoGheNaTabela(f.grupoHomogeneo)])] : ['—']),
        no('td', {}, [no('span', { class: 'badge situacao-' + f.situacao }, [ROTULOS_SITUACAO[f.situacao]])]),
        celulaAcao,
      ]);
    }
    function desenharLista() {
      var corpo = $('tbody');
      if (!corpo) return;
      corpo.replaceChildren();
      if (carregandoLista) { corpo.appendChild(linhaVazia(TEXTOS.CARREGANDO)); $('count').textContent = ''; return; }
      if (listaFalhou) { corpo.appendChild(linhaVazia(TEXTOS.FALHA_LISTA)); $('count').textContent = ''; return; }
      var linhas = visao.ordenar(visao.filtrar(lista, $('q').value, $('fSituacaoFiltro').value));
      if (linhas.length === 0) corpo.appendChild(linhaVazia(TEXTOS.VAZIO));
      linhas.forEach(function (f) { corpo.appendChild(linhaDe(f)); });
      $('count').textContent = visao.contagem(linhas.length, lista.length);
    }
    async function recarregar() {
      carregandoLista = true;
      listaFalhou = false;
      desenharLista();
      var r = await acoes.carregarTodos();
      if (encerrada) return;
      carregandoLista = false;
      if (!r.ok) {
        if (r.status === 401) { sessaoCaiu(); return; }
        listaFalhou = true;
        lista = [];
      } else {
        lista = r.funcionarios;
      }
      desenharLista();
      sugestoes();
    }
    function sugestoes() {
      function unicos(chave) {
        var vistos = {};
        var saida = [];
        lista.forEach(function (f) { var v = f[chave]; if (v && !vistos[v]) { vistos[v] = 1; saida.push(v); } });
        return saida.sort();
      }
      [['dlSetor', 'setor'], ['dlCargo', 'funcao']].forEach(function (par) {
        var dl = $(par[0]);
        if (!dl) return;
        dl.replaceChildren();
        unicos(par[1]).forEach(function (v) { dl.appendChild(no('option', { value: v })); });
      });
    }
    async function carregarGhes() {
      var r = await acoes.ghes();
      if (encerrada) return;
      if (r && r.status === 401) { sessaoCaiu(); return; }
      if (!r || !r.ok) { ghes = []; aviso(TEXTOS.FALHA_GHES, 'err'); return; }
      ghes = (Array.isArray(r.dados && r.dados.ghes) ? r.dados.ghes : []).map(modelo.ghe).filter(Boolean);
    }

    // ── formulário
    function limparErros() {
      CAMPOS.forEach(function (n) {
        var e = $('e' + n);
        if (e) e.textContent = '';
        var c = $('f' + n);
        if (c) c.classList.remove('invalid');
      });
    }
    function marcarErro(sufixo, msg) {
      var e = $('e' + sufixo);
      if (e) e.textContent = msg;
      var c = $('f' + sufixo);
      if (c) c.classList.add('invalid');
    }
    function montarOpcoesGhe(selecionado, atual) {
      var s = $('fGhe');
      s.replaceChildren();
      s.appendChild(no('option', { value: '' }, ['Selecione o GHE']));
      var lista2 = ghes.slice();
      // O GHE atual pode ter sido inativado depois do vínculo: continua visível (e inalterado) na edição.
      if (atual && !lista2.some(function (g) { return g.id === atual.id; })) lista2.push(atual);
      lista2.forEach(function (g) { s.appendChild(no('option', { value: String(g.id) }, [textoDoGhe(g)])); });
      s.value = selecionado === null ? '' : String(selecionado);
    }
    function lerCampos() {
      return {
        // Na edição o CPF não é lido da tela: é imutável e nunca vai no corpo (nem revelado).
        nome: $('fNome').value, cpf: emEdicao ? '' : $('fCpf').value, matricula: $('fMatricula').value, setor: $('fSetor').value, funcao: $('fCargo').value,
        grupoHomogeneoId: $('fGhe').value, telefone: $('fTelefone').value, dataNascimento: $('fNascimento').value, dataAdmissao: $('fContratacao').value,
      };
    }
    function abrirFormulario(f) {
      limparErros();
      ocultarCpf(); // trocar de funcionário nunca herda o CPF revelado do anterior
      emEdicao = f || null;
      $('mTitle').textContent = f ? 'Editar colaborador' : 'Novo colaborador';
      $('mSub').textContent = f ? 'Altere os dados e clique em Salvar.' : 'Preencha os dados e clique em Salvar.';
      $('fNome').value = f ? f.nome : '';
      $('fCpf').value = f ? texto(f.cpfMascarado) : '';
      $('fCpf').disabled = !!f; // CPF é imutável após o cadastro; completo só pelo olho, temporariamente
      if ($('btnCpfOlho')) $('btnCpfOlho').style.display = f && cap.editar ? '' : 'none';
      $('fMatricula').value = f ? texto(f.matricula) : '';
      $('fSetor').value = f ? texto(f.setor) : '';
      $('fCargo').value = f ? texto(f.funcao) : '';
      montarOpcoesGhe(f ? f.grupoHomogeneoId : null, f ? f.grupoHomogeneo : null);
      $('fTelefone').value = f ? mascararTelefone(f.telefone) : '';
      $('fNascimento').value = f ? texto(f.dataNascimento) : '';
      $('fContratacao').value = f ? texto(f.dataAdmissao) : '';
      $('overlay').classList.add('open');
      if ($('fNome').focus) $('fNome').focus();
    }
    function fecharFormulario() {
      ocultarCpf();
      if ($('fCpf').disabled) $('fCpf').value = '';
      $('overlay').classList.remove('open');
      emEdicao = null;
    }
    function mostrarErros(mapa) {
      Object.keys(mapa).forEach(function (sufixo) { marcarErro(sufixo, mapa[sufixo]); });
    }
    async function salvar() {
      if (enviando || encerrada) return;
      limparErros();
      var v = lerCampos();
      var edicao = emEdicao;
      var validacao = formulario.validar(v, { original: edicao, hoje: dataDeHoje() });
      if (!validacao.ok) { mostrarErros(validacao.erros); aviso(TEXTOS.CORRIJA, 'err'); return; }
      var corpo = edicao ? formulario.corpoEdicao(v, edicao) : formulario.corpoCadastro(v);
      if (edicao && Object.keys(corpo).length === 0) { aviso(TEXTOS.SEM_ALTERACAO, 'info'); fecharFormulario(); return; }
      enviando = true;
      $('btnSalvar').disabled = true;
      var r;
      try {
        r = edicao ? await acoes.alterar(edicao.id, corpo) : await acoes.criar(corpo);
      } finally {
        enviando = false;
        $('btnSalvar').disabled = false;
      }
      if (encerrada) return;
      if (r && r.ok) {
        fecharFormulario();
        aviso(edicao ? TEXTOS.SALVO : TEXTOS.CADASTRADO, 'ok');
        await recarregar();
        return;
      }
      var tratamento = erros.daEscrita(r);
      if (tratamento.sessao) { sessaoCaiu(); return; }
      if (tratamento.campos) mostrarErros(tratamento.campos);
      if (tratamento.aviso) aviso(tratamento.aviso, 'err');
      if (tratamento.fechar) fecharFormulario();
      if (tratamento.recarregarGhes) {
        await carregarGhes();
        montarOpcoesGhe($('fGhe').value === '' ? null : Number($('fGhe').value), emEdicao ? emEdicao.grupoHomogeneo : null);
      }
      if (tratamento.atualizar) await recarregar();
    }

    // ── situação (com confirmação)
    function abrirConfirmacao(f, acao) {
      situacaoPendente = { funcionario: f, destino: acao.destino, rotulo: acao.rotulo };
      $('cTitulo').textContent = acao.rotulo + ' ' + f.nome + '?';
      $('cTexto').textContent = EXPLICACAO[acao.destino];
      $('cConfirmar').textContent = acao.rotulo + ' colaborador';
      $('confirmacaoSituacao').classList.add('open');
    }
    function fecharConfirmacao() {
      $('confirmacaoSituacao').classList.remove('open');
      situacaoPendente = null;
    }
    async function confirmarSituacao() {
      if (enviando || encerrada || !situacaoPendente) return;
      var pendente = situacaoPendente;
      enviando = true;
      $('cConfirmar').disabled = true;
      var r;
      try {
        r = await acoes.situacao(pendente.funcionario.id, pendente.destino);
      } finally {
        enviando = false;
        $('cConfirmar').disabled = false;
      }
      if (encerrada) return;
      fecharConfirmacao();
      if (r && r.ok) {
        aviso(TEXTOS.SITUACAO_ALTERADA, 'ok');
        await recarregar();
        return;
      }
      var tratamento = erros.daSituacao(r);
      if (tratamento.sessao) { sessaoCaiu(); return; }
      aviso(tratamento.aviso, 'err');
      if (tratamento.atualizar) await recarregar();
    }

    function ligar() {
      if (ligada) return;
      ligada = true;
      $('q').addEventListener('input', desenharLista);
      $('fSituacaoFiltro').addEventListener('change', desenharLista);
      if ($('btnCpfOlho')) $('btnCpfOlho').addEventListener('click', alternarCpf);
      // Aba oculta ou saída da página: o CPF completo não fica para trás (voltar a ficar visível não o revela de novo).
      doc.addEventListener('visibilitychange', function () { if (doc.hidden === true || doc.visibilityState === 'hidden') ocultarCpf(); });
      if (global.addEventListener) global.addEventListener('pagehide', ocultarCpf);
      $('fCpf').addEventListener('input', function () { $('fCpf').value = mascararCpf($('fCpf').value); });
      $('fTelefone').addEventListener('input', function () { $('fTelefone').value = mascararTelefone($('fTelefone').value); });
      $('btnSalvar').addEventListener('click', salvar);
      $('btnCancelar').addEventListener('click', fecharFormulario);
      $('btnFechar').addEventListener('click', fecharFormulario);
      $('cCancelar').addEventListener('click', fecharConfirmacao);
      $('cConfirmar').addEventListener('click', confirmarSituacao);
      $('overlay').addEventListener('click', function (ev) { if (ev && ev.target === $('overlay')) fecharFormulario(); });
      $('confirmacaoSituacao').addEventListener('click', function (ev) { if (ev && ev.target === $('confirmacaoSituacao')) fecharConfirmacao(); });
      doc.addEventListener('keydown', function (ev) {
        if (!ev || ev.key !== 'Escape') return;
        if ($('confirmacaoSituacao').classList.contains('open')) fecharConfirmacao();
        else if ($('overlay').classList.contains('open')) fecharFormulario();
      });
    }

    return {
      iniciar: async function () {
        ligar();
        var olhoCpf = $('btnCpfOlho');
        if (!cap.editar && olhoCpf && olhoCpf.remove) olhoCpf.remove();
        var novo = $('btnNovo');
        if (!cap.cadastrar && novo && novo.remove) novo.remove();
        else if (novo) novo.addEventListener('click', function () { abrirFormulario(null); });
        var tarefas = [recarregar()];
        if (cap.cadastrar || cap.editar) tarefas.push(carregarGhes());
        await Promise.all(tarefas);
      },
      encerrar: function () { encerrada = true; ocultarCpf(); },
    };
  }

  global.EpiGestaoFuncionarios = {
    acoes: acoes, modelo: modelo, visao: visao, formulario: formulario, erros: erros, capacidades: capacidades, criarTela: criarTela,
    TEXTOS: TEXTOS, ACOES_SITUACAO: ACOES_SITUACAO, ROTULOS_SITUACAO: ROTULOS_SITUACAO,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiGestaoFuncionarios;
})(typeof window !== 'undefined' ? window : globalThis);
