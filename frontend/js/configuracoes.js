(function (global) {
  'use strict';

  /**
   * EpiConfiguracoes — Configurações (05/10/2026): a conta da PRÓPRIA pessoa
   * autenticada, sem navegador para testar.
   *
   * Leitura pelas rotas existentes (GET /auth/global/me, estendida com
   * telefone, aparência e último acesso da identidade; o perfil, o nome e a
   * situação vêm do contexto empresarial da sessão). Escrita por
   *   PATCH /auth/global/conta   telefone, tema e modo visual
   *   PATCH /auth/global/email   e-mail de acesso, com a senha atual
   * e a senha pelo fluxo real já existente (portal/trocar-senha.html).
   *
   * O cliente nunca envia identidade ou usuário: o servidor decide pela
   * sessão. Nada vai para armazenamento do navegador (o cache de aparência
   * é de js/tema.js). Textos de erro são próprios, por código, e nunca ecoam
   * o que foi digitado nem a mensagem do servidor.
   */

  var CAMINHOS = { me: '/auth/global/me', conta: '/auth/global/conta', email: '/auth/global/email' };
  var TROCAR_SENHA = '../portal/trocar-senha.html';
  var TEMAS = ['sistema', 'claro', 'escuro'];
  var MODOS_VISUAIS = ['padrao', 'alto_contraste', 'deuteranopia', 'protanopia', 'tritanopia', 'baixa_visao', 'monocromatico'];
  var LIMITES = { email: 150, telefone: 20 };
  var CONTROLE = /[\u0000-\u001f\u007f]/;
  var EMAIL_ASCII_VISIVEL = /^[\x21-\x7e]+$/;
  var EMAIL_FORMATO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  var PERFIS = { MASTER: 'Master', ADMINISTRADOR: 'Administrador', SUPERVISOR: 'Supervisor', USUARIO: 'Usuário' };

  var TEXTOS = {
    EMAIL_INDISPONIVEL: 'Este e-mail não pode ser usado. Escolha outro endereço.',
    SENHA_ATUAL_INVALIDA: 'A senha atual não confere.',
    LOGIN_EM_COOLDOWN: 'Muitas tentativas. Tente novamente mais tarde.',
    EMAIL_IGUAL_AO_ATUAL: 'O novo e-mail é igual ao atual.',
    EMAIL_INVALIDO: 'E-mail inválido.',
    VALIDACAO: 'Dados inválidos. Confira o e-mail e a senha atual.',
    SESSAO_INVALIDA: 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.',
    FALHA_DE_REDE: 'Não foi possível falar com o servidor. Verifique sua conexão e tente de novo.',
    PADRAO: 'Não foi possível concluir. Tente novamente.',
    CARREGAR: 'Não foi possível carregar sua conta. Recarregue a página.',
  };

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/configuracoes.js');
    return cliente;
  }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }

  function falha(resposta, padrao) {
    var codigo = resposta && typeof resposta.codigo === 'string' ? resposta.codigo : null;
    return {
      ok: false,
      status: resposta && typeof resposta.status === 'number' ? resposta.status : 0,
      codigo: codigo,
      mensagem: (codigo && hasOwn(TEXTOS, codigo) ? TEXTOS[codigo] : null) || padrao || TEXTOS.PADRAO,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Validação local (mesmas regras do servidor; ele revalida)
  // ───────────────────────────────────────────────────────────────────

  function validarEmail(valor) {
    var v = texto(valor).toLowerCase();
    if (!v) return { ok: false, mensagem: 'Informe o novo e-mail.' };
    if (v.length > LIMITES.email || !EMAIL_ASCII_VISIVEL.test(v) || !EMAIL_FORMATO.test(v)) {
      return { ok: false, mensagem: 'E-mail inválido: use letras sem acento, números e os sinais permitidos, no formato nome@dominio.' };
    }
    return { ok: true, valor: v };
  }

  function validarTelefone(valor) {
    var v = texto(valor);
    if (!v) return { ok: true, valor: null };
    if (v.length > LIMITES.telefone) return { ok: false, mensagem: 'Telefone com mais de ' + LIMITES.telefone + ' caracteres.' };
    if (CONTROLE.test(v)) return { ok: false, mensagem: 'Telefone com caractere inválido.' };
    return { ok: true, valor: v };
  }

  var validar = { email: validarEmail, telefone: validarTelefone };

  // ───────────────────────────────────────────────────────────────────
  // Ações (HTTP)
  // ───────────────────────────────────────────────────────────────────

  async function consultar() {
    var r = await http().requisitar('GET', CAMINHOS.me);
    if (!r.ok) return falha(r, TEXTOS.CARREGAR);
    var d = r.dados || {};
    var i = d.identidade || {};
    var ctx = d.contexto || null;
    var u = ctx && ctx.usuario ? ctx.usuario : {};
    return {
      ok: true,
      conta: {
        nome: texto(u.nome),
        perfil: typeof u.perfil === 'string' ? u.perfil : null,
        ativo: typeof u.ativo === 'boolean' ? u.ativo : null,
        email: texto(i.email),
        telefone: typeof i.telefone === 'string' ? i.telefone : null,
        tema: TEMAS.indexOf(i.tema) !== -1 ? i.tema : 'sistema',
        modoVisual: MODOS_VISUAIS.indexOf(i.modoVisual) !== -1 ? i.modoVisual : 'padrao',
        ultimoAcessoEm: typeof i.ultimoAcessoEm === 'string' ? i.ultimoAcessoEm : null,
        empresa: ctx && ctx.empresa ? texto(ctx.empresa.nome) : '',
        funcionario: funcionarioVinculado(u.funcionario),
      },
    };
  }

  // Só o que o servidor declarou como vínculo explícito; nada é deduzido aqui.
  function funcionarioVinculado(f) {
    if (!f || f.vinculado !== true) return { vinculado: false, matricula: null, cpfMascarado: null };
    return {
      vinculado: true,
      matricula: typeof f.matricula === 'string' && f.matricula !== '' ? f.matricula : null,
      cpfMascarado: typeof f.cpfMascarado === 'string' && f.cpfMascarado !== '' ? f.cpfMascarado : null,
    };
  }

  /** Só os três campos da conta saem; qualquer outra chave é descartada aqui. */
  async function atualizarConta(campos) {
    var corpo = {};
    var c = campos || {};
    if (hasOwn(c, 'telefone')) corpo.telefone = c.telefone === null ? null : texto(c.telefone);
    if (hasOwn(c, 'tema')) corpo.tema = c.tema;
    if (hasOwn(c, 'modoVisual')) corpo.modoVisual = c.modoVisual;
    var r = await http().requisitar('PATCH', CAMINHOS.conta, { corpo: corpo });
    if (!r.ok) return falha(r);
    return { ok: true, conta: r.dados && r.dados.conta ? r.dados.conta : corpo };
  }

  async function trocarEmail(dados) {
    var d = dados || {};
    var r = await http().requisitar('PATCH', CAMINHOS.email, { corpo: { senhaAtual: String(d.senhaAtual), novoEmail: String(d.novoEmail) } });
    if (!r.ok) return falha(r);
    return { ok: true, email: r.dados && typeof r.dados.email === 'string' ? r.dados.email : String(d.novoEmail) };
  }

  var acoes = { consultar: consultar, atualizarConta: atualizarConta, trocarEmail: trocarEmail };

  // ───────────────────────────────────────────────────────────────────
  // Apresentação
  // ───────────────────────────────────────────────────────────────────

  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function iniciais(nome) {
    var partes = texto(nome).replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean);
    if (partes.length === 0) return '?';
    var primeira = partes[0].charAt(0);
    var ultima = partes.length > 1 ? partes[partes.length - 1].charAt(0) : '';
    return (primeira + ultima).toUpperCase();
  }

  function ultimoAcesso(iso) {
    if (typeof iso !== 'string' || !iso) return '—';
    var data = new Date(iso);
    if (isNaN(data.getTime())) return '—';
    try {
      var formatado = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
      }).format(data);
      return formatado.replace(/,?\s+/, ' às ');
    } catch (e) {
      return '—';
    }
  }

  function rotuloPerfil(perfil) {
    return hasOwn(PERFIS, perfil) ? PERFIS[perfil] : texto(perfil);
  }

  function contato(conta) {
    var c = conta || {};
    return c.telefone ? texto(c.email) + ' · ' + texto(c.telefone) : texto(c.email);
  }

  function situacao(ativo) {
    if (ativo === true) return { texto: 'Ativo', classe: 'status-active' };
    if (ativo === false) return { texto: 'Inativo', classe: 'status-inactive' };
    return { texto: '—', classe: '' };
  }

  var NAO_VINCULADO = 'Não vinculado';

  /** CPF (já mascarado pelo servidor) e matrícula do funcionário vinculado; sem vínculo, o estado neutro. */
  function vinculo(funcionario) {
    var f = funcionario && funcionario.vinculado === true ? funcionario : null;
    return {
      cpf: f && f.cpfMascarado ? texto(f.cpfMascarado) : NAO_VINCULADO,
      matricula: f && f.matricula ? texto(f.matricula) : NAO_VINCULADO,
    };
  }

  var render = { escaparHtml: escaparHtml, iniciais: iniciais, ultimoAcesso: ultimoAcesso, rotuloPerfil: rotuloPerfil, contato: contato, situacao: situacao, vinculo: vinculo };

  // ───────────────────────────────────────────────────────────────────
  // Controles da aparência ↔ valor persistido (nada de valor de interface guardado)
  // ───────────────────────────────────────────────────────────────────

  function temaDosControles(estado) {
    var e = estado || {};
    if (e.seguirSistema) return 'sistema';
    return e.escuro ? 'escuro' : 'claro';
  }

  function estadoDoTema(tema) {
    return { seguirSistema: tema === 'sistema', escuro: tema === 'escuro' };
  }

  var MODO_DO_CONTROLE = {
    chipDefault: 'padrao',
    chipContrast: 'alto_contraste',
    'a11y-padrao': 'padrao',
    'a11y-deuteranopia': 'deuteranopia',
    'a11y-protanopia': 'protanopia',
    'a11y-tritanopia': 'tritanopia',
    'a11y-baixa_visao': 'baixa_visao',
    'a11y-monocromatico': 'monocromatico',
  };

  var controles = { temaDosControles: temaDosControles, estadoDoTema: estadoDoTema, MODO_DO_CONTROLE: MODO_DO_CONTROLE };

  global.EpiConfiguracoes = {
    CAMINHOS: CAMINHOS,
    TROCAR_SENHA: TROCAR_SENHA,
    TEMAS: TEMAS.slice(),
    MODOS_VISUAIS: MODOS_VISUAIS.slice(),
    LIMITES: LIMITES,
    TEXTOS: TEXTOS,
    validar: validar,
    acoes: acoes,
    render: render,
    controles: controles,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiConfiguracoes;
  }
})(typeof window !== 'undefined' ? window : globalThis);
