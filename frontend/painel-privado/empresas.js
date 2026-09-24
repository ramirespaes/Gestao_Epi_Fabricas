(function () {
  'use strict';

  /**
   * Gestão de empresas no Painel Privado (Pacote 3): listagem, cadastro,
   * consulta, edição, inativar/reativar, situação do provisionamento MASTER
   * e convite do primeiro MASTER. Toda autoridade vem do cookie
   * administrativo (credentials:'include' em EpiHttp); nenhum id de
   * administrador é enviado pelo navegador. Sessão inválida -> login.
   */

  window.EpiHttp.configurar({ baseUrl: window.SAFEWORK_PLATAFORMA_API_BASE_URL });
  var Http = window.EpiHttp;

  var CAMPOS = ['razaoSocial', 'nomeFantasia', 'cnpj', 'inscricaoEstadual', 'situacaoInscricaoEstadual', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'cep', 'email', 'telefone', 'representanteNome', 'representanteCargo', 'representanteEmail', 'representanteTelefone', 'financeiroNome', 'financeiroEmail', 'financeiroTelefone'];
  var CAMPOS_EDITAVEIS = CAMPOS.filter(function (c) { return c !== 'cnpj'; });

  var el = function (id) { return document.getElementById(id); };
  var empresaAtual = null;

  function irParaLogin() { window.location.href = 'index.html'; }
  function mensagem(id, texto, classe) { var e = el(id); e.textContent = texto || ''; e.className = 'mensagem ' + (classe || ''); }
  function escapar(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function tratar(resposta, idMensagem) {
    if (Http.ehNaoAutenticado(resposta)) { irParaLogin(); return false; }
    if (!resposta.ok) {
      var detalhe = resposta.detalhes && resposta.detalhes[0] ? ' (' + resposta.detalhes[0].campo + ': ' + resposta.detalhes[0].mensagem + ')' : '';
      mensagem(idMensagem, resposta.mensagem + detalhe, 'erro');
      return false;
    }
    return true;
  }

  // ----- listagem -----
  function carregarLista() {
    var busca = el('busca').value.trim();
    Http.requisitar('GET', '/empresas' + (busca ? '?busca=' + encodeURIComponent(busca) : '')).then(function (r) {
      if (!tratar(r, 'msg-lista')) return;
      var linhas = r.dados.empresas.map(function (e) {
        return '<tr class="selecionavel" data-id="' + e.id + '"><td>' + escapar(e.razaoSocial) + (e.nomeFantasia ? ' <small>(' + escapar(e.nomeFantasia) + ')</small>' : '') + '</td><td>' + escapar(e.cnpj) + '</td><td class="' + (e.ativo ? '' : 'inativa') + '">' + (e.ativo ? 'Ativa' : 'Inativa') + '</td></tr>';
      });
      el('lista').innerHTML = linhas.join('') || '<tr><td colspan="3">Nenhuma empresa encontrada.</td></tr>';
      mensagem('msg-lista', r.dados.total + ' empresa(s).');
    });
  }
  el('lista').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr[data-id]');
    if (tr) abrirEmpresa(Number(tr.getAttribute('data-id')));
  });
  el('btn-buscar').addEventListener('click', carregarLista);

  // ----- formulário -----
  function preencher(empresa) {
    CAMPOS.forEach(function (c) {
      var valor = c === 'representanteNome' ? empresa.representante.nome : c === 'representanteCargo' ? empresa.representante.cargo
        : c === 'representanteEmail' ? empresa.representante.email : c === 'representanteTelefone' ? empresa.representante.telefone
        : c === 'financeiroNome' ? empresa.financeiro.nome : c === 'financeiroEmail' ? empresa.financeiro.email
        : c === 'financeiroTelefone' ? empresa.financeiro.telefone : empresa[c];
      el(c).value = valor == null ? '' : valor;
    });
  }
  function limparFormulario() {
    empresaAtual = null;
    el('form-empresa').reset();
    el('cnpj').disabled = false;
    el('titulo-form').textContent = 'Nova empresa';
    el('detalhe').style.display = 'none';
    mensagem('msg-form', '');
  }
  el('btn-nova').addEventListener('click', limparFormulario);
  el('btn-cancelar-edicao').addEventListener('click', limparFormulario);

  function lerCorpo(campos) {
    var corpo = {};
    campos.forEach(function (c) {
      var v = el(c).value.trim();
      corpo[c] = v === '' ? null : v;
    });
    return corpo;
  }

  el('form-empresa').addEventListener('submit', function (ev) {
    ev.preventDefault();
    el('btn-salvar').disabled = true;
    mensagem('msg-form', '');
    var promessa;
    if (empresaAtual === null) {
      var corpo = lerCorpo(CAMPOS);
      if (!corpo.razaoSocial || !corpo.cnpj) { mensagem('msg-form', 'Razão social e CNPJ são obrigatórios.', 'erro'); el('btn-salvar').disabled = false; return; }
      promessa = Http.requisitar('POST', '/empresas', { corpo: corpo }).then(function (r) {
        if (!tratar(r, 'msg-form')) return;
        mensagem('msg-form', 'Empresa cadastrada. Provisionamento MASTER: ' + (r.dados.provisionamento.prontaParaMaster ? 'pronto.' : 'COM PENDÊNCIAS — verifique.'), r.dados.provisionamento.prontaParaMaster ? 'ok' : 'aviso');
        carregarLista();
        abrirEmpresa(r.dados.empresa.id);
      });
    } else {
      var corpoEdicao = lerCorpo(CAMPOS_EDITAVEIS);
      promessa = Http.requisitar('PATCH', '/empresas/' + empresaAtual.id, { corpo: corpoEdicao }).then(function (r) {
        if (!tratar(r, 'msg-form')) return;
        mensagem('msg-form', 'Alterações salvas.', 'ok');
        carregarLista();
        abrirEmpresa(empresaAtual.id);
      });
    }
    promessa.catch(function () { mensagem('msg-form', 'Não foi possível falar com o servidor.', 'erro'); }).then(function () { el('btn-salvar').disabled = false; });
  });

  // ----- detalhe -----
  function abrirEmpresa(id) {
    Http.requisitar('GET', '/empresas/' + id).then(function (r) {
      if (!tratar(r, 'msg-form')) return;
      empresaAtual = r.dados.empresa;
      preencher(empresaAtual);
      el('cnpj').disabled = true;
      el('titulo-form').textContent = 'Empresa #' + empresaAtual.id + ' — ' + empresaAtual.razaoSocial;
      el('situacao').textContent = 'Situação na plataforma: ' + (empresaAtual.ativo ? 'ATIVA' : 'INATIVA');
      el('btn-inativar').style.display = empresaAtual.ativo ? '' : 'none';
      el('btn-reativar').style.display = empresaAtual.ativo ? 'none' : '';
      el('detalhe').style.display = 'block';
      el('entrega').style.display = 'none';
      mensagem('msg-convite', '');
      carregarProvisionamento();
      carregarConvites();
    });
  }

  function carregarProvisionamento() {
    Http.requisitar('GET', '/empresas/' + empresaAtual.id + '/provisionamento').then(function (r) {
      if (Http.ehNaoAutenticado(r)) { irParaLogin(); return; }
      if (!r.ok) { mensagem('provisionamento', r.mensagem, 'aviso'); return; }
      var t = r.dados.totais;
      mensagem('provisionamento', (r.dados.prontaParaMaster ? 'Pronta para o MASTER operar.' : 'ATENÇÃO: o MASTER ainda receberia 403 em funções obrigatórias.')
        + ' Adequadas: ' + t.ADEQUADA + ', inseridas: ' + t.INSERIDA + ', ausentes: ' + t.AUSENTE + ', insuficientes: ' + t.INSUFICIENTE + ', não catalogadas: ' + t.NAO_CATALOGADA + '.',
        r.dados.prontaParaMaster ? 'ok' : 'aviso');
    });
  }

  function mudarEstado(acao) {
    Http.requisitar('POST', '/empresas/' + empresaAtual.id + '/' + acao, { corpo: {} }).then(function (r) {
      if (!tratar(r, 'msg-form')) return;
      mensagem('msg-form', acao === 'inativar' ? 'Empresa inativada.' : 'Empresa reativada.', 'ok');
      carregarLista();
      abrirEmpresa(empresaAtual.id);
    });
  }
  el('btn-inativar').addEventListener('click', function () { mudarEstado('inativar'); });
  el('btn-reativar').addEventListener('click', function () { mudarEstado('reativar'); });

  // ----- convites -----
  function carregarConvites() {
    Http.requisitar('GET', '/empresas/' + empresaAtual.id + '/convites-master').then(function (r) {
      if (!tratar(r, 'msg-convite')) return;
      el('convites').innerHTML = r.dados.convites.map(function (c) {
        var cancelar = c.situacao === 'PENDENTE' ? '<button type="button" class="secundario" data-cancelar="' + c.id + '">Cancelar</button>' : '';
        return '<tr><td>' + escapar(c.emailConvite) + '</td><td>' + escapar(c.situacao) + '</td><td>' + escapar(new Date(c.expiraEm).toLocaleString('pt-BR')) + '</td><td>' + cancelar + '</td></tr>';
      }).join('') || '<tr><td colspan="4">Nenhum convite.</td></tr>';
    });
  }
  el('convites').addEventListener('click', function (ev) {
    var botao = ev.target.closest('button[data-cancelar]');
    if (!botao) return;
    botao.disabled = true;
    Http.requisitar('POST', '/convites-master/' + empresaAtual.id + '/' + botao.getAttribute('data-cancelar') + '/cancelar', { corpo: {} }).then(function (r) {
      if (!tratar(r, 'msg-convite')) return;
      mensagem('msg-convite', 'Convite cancelado.', 'ok');
      carregarConvites();
    });
  });
  el('btn-convidar').addEventListener('click', function () {
    var email = el('email-master').value.trim();
    if (!email) { mensagem('msg-convite', 'Informe o e-mail do primeiro MASTER.', 'erro'); return; }
    el('btn-convidar').disabled = true;
    Http.requisitar('POST', '/empresas/' + empresaAtual.id + '/convites-master', { corpo: { email: email } }).then(function (r) {
      el('btn-convidar').disabled = false;
      if (!tratar(r, 'msg-convite')) return;
      mensagem('msg-convite', 'Convite gerado para ' + r.dados.convite.emailConvite + '.', 'ok');
      el('link-aceite').textContent = r.dados.entrega.linkAceite;
      el('entrega').style.display = 'block';
      carregarConvites();
    });
  });

  // ----- sessão -----
  el('sair').addEventListener('click', function () {
    Http.requisitar('POST', '/auth/logout').then(irParaLogin).catch(irParaLogin);
  });

  Http.requisitar('GET', '/auth/me').then(function (r) {
    if (Http.ehNaoAutenticado(r)) { irParaLogin(); return; }
    carregarLista();
  }).catch(function () { mensagem('msg-lista', 'Não foi possível falar com o servidor.', 'erro'); });
})();
