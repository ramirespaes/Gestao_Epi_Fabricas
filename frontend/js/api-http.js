(function (global) {
  'use strict';

  /**
   * EpiHttp — cliente HTTP real da API (Bloco 8, Incremento 8, Etapa 5A,
   * Subetapa 3R).
   *
   * PRIMEIRA camada do frontend que fala de verdade com o backend. Até
   * aqui o projeto tinha apenas js/db-api.js (EpiAPI), que SIMULA um
   * fetch sobre localStorage — útil como protótipo, incapaz de sessão,
   * autoridade ou isolamento multiempresa. Este arquivo não substitui
   * nem altera aquele: db-api.js continua intocado servindo as telas
   * antigas, e as telas novas passam a usar EpiHttp. Não há duas
   * arquiteturas HTTP concorrentes — havia zero, e esta é a primeira.
   *
   * O QUE ESTA CAMADA FAZ, E SÓ ISSO: transporte. Monta a URL, envia o
   * corpo como JSON, anexa o cookie de sessão, e normaliza a resposta
   * (inclusive erro e falha de rede) num envelope único. Não conhece
   * grupos, permissões, usuários ou qualquer regra de negócio — quem
   * conhece são os módulos de domínio construídos sobre ela.
   *
   * COOKIE DE SESSÃO, NUNCA TOKEN NO JAVASCRIPT: toda requisição vai com
   * `credentials: 'include'`, para que o navegador anexe sozinho o cookie
   * HttpOnly emitido por POST /api/auth/login. O token em claro nunca é
   * lido, guardado ou transportado por este código — ele é inacessível ao
   * JavaScript por desenho do backend, e continua assim aqui.
   *
   * AUTORIDADE NUNCA SAI DO NAVEGADOR: empresa, ator e perfil são
   * decididos no servidor, a partir da sessão. Para que isso não dependa
   * de disciplina de quem escreve a próxima tela, esta camada RECUSA, com
   * erro de programação (TypeError, antes de qualquer rede), um corpo que
   * contenha campos de autoridade — ver CAMPOS_DE_AUTORIDADE_PROIBIDOS. O
   * backend já rejeita esses campos por conta própria (strictObject em
   * todos os schemas); a recusa aqui é a segunda barreira, e torna a
   * regra verificável por teste em vez de convenção.
   *
   * ORIGIN NÃO É DEFINIDO AQUI: o backend exige origem válida em métodos
   * que alteram estado (middleware/origem.js, proteção CSRF), e o
   * navegador envia o cabeçalho Origin automaticamente — JavaScript não
   * pode forjá-lo, e é exatamente isso que dá valor à verificação. Este
   * cliente não tenta defini-lo.
   *
   * NADA DO CORPO VAI PARA O CONSOLE: db-api.js registra o body de cada
   * chamada; aqui isso seria vazar senha no log do navegador durante o
   * login. Só método, caminho e status são registrados.
   *
   * USO NO NAVEGADOR:
   *   <script src="../js/api-http.js"></script>
   *   EpiHttp.configurar({ baseUrl: 'http://localhost:3000/api' });
   *   const r = await EpiHttp.requisitar('GET', '/grupos-acesso');
   *   if (r.ok) { ... } else if (EpiHttp.ehNaoAutenticado(r)) { ... }
   */

  // Porta padrão do backend (PORT=3000 em .env.example). O prefixo /api é
  // onde app.js monta todas as rotas.
  var BASE_PADRAO = 'http://localhost:3000/api';

  /**
   * Campos que identificam QUEM age e em QUAL empresa. Sempre vêm da
   * sessão no servidor; um corpo que os traga é tentativa de forjar
   * autoridade (ou, mais provavelmente, engano de programação) e não
   * chega a ser enviado.
   *
   * `usuarioId` NÃO está aqui de propósito: em /api/autorizacoes-individuais
   * ele é o BENEFICIÁRIO da concessão, dado de negócio legítimo — quem
   * age continua sendo sempre a sessão.
   */
  var CAMPOS_DE_AUTORIDADE_PROIBIDOS = [
    'empresaId', 'empresa_id',
    'atorId', 'ator_id',
    'isMaster', 'perfil',
    'concedidoPor', 'concedido_por',
    'autorizadoPor', 'autorizado_por',
    'revogadoPor', 'revogado_por',
    'criadoPor', 'criado_por',
  ];

  var METODOS_SEM_CORPO = ['GET', 'HEAD'];

  // Códigos que o backend usa para causas que a interface precisa
  // distinguir. Os demais chegam como estão, sem tradução.
  var MENSAGENS_PADRAO = {
    400: 'Dados inválidos. Revise os campos e tente novamente.',
    401: 'Sua sessão expirou. Entre novamente para continuar.',
    403: 'Você não tem autorização para esta operação.',
    404: 'Registro não encontrado.',
    409: 'A operação conflita com o estado atual do registro.',
    429: 'Muitas tentativas. Aguarde um momento e tente novamente.',
    500: 'Não foi possível concluir a operação. Tente novamente.',
  };

  var MENSAGEM_REDE = 'Não foi possível falar com o servidor. Verifique sua conexão.';

  var configuracao = { baseUrl: BASE_PADRAO, fetch: null };

  /**
   * @param {{baseUrl?: string, fetch?: Function}} opcoes `fetch` existe
   *   para teste automatizado (injeção de dependência, como o `pool` nos
   *   serviços do backend). No navegador não se informa nada além, quando
   *   muito, da baseUrl.
   */
  function configurar(opcoes) {
    var o = opcoes || {};
    if (o.baseUrl !== undefined) {
      if (typeof o.baseUrl !== 'string' || o.baseUrl.length === 0) {
        throw new TypeError('baseUrl inválida');
      }
      configuracao.baseUrl = o.baseUrl.replace(/\/+$/, '');
    }
    if (o.fetch !== undefined) {
      if (o.fetch !== null && typeof o.fetch !== 'function') {
        throw new TypeError('fetch inválido');
      }
      configuracao.fetch = o.fetch;
    }
    return { baseUrl: configuracao.baseUrl };
  }

  function obterFetch() {
    if (configuracao.fetch) return configuracao.fetch;
    if (typeof global.fetch === 'function') return global.fetch.bind(global);
    throw new Error('fetch indisponível neste ambiente');
  }

  function exigirCaminho(caminho) {
    if (typeof caminho !== 'string' || caminho.charAt(0) !== '/') {
      throw new TypeError('caminho deve começar com "/"');
    }
  }

  /** Ver CAMPOS_DE_AUTORIDADE_PROIBIDOS: recusa antes de qualquer rede. */
  function exigirCorpoSemAutoridade(corpo) {
    if (corpo === undefined || corpo === null) return;
    if (typeof corpo !== 'object' || Array.isArray(corpo)) {
      throw new TypeError('corpo deve ser um objeto');
    }
    for (var i = 0; i < CAMPOS_DE_AUTORIDADE_PROIBIDOS.length; i += 1) {
      var campo = CAMPOS_DE_AUTORIDADE_PROIBIDOS[i];
      if (Object.prototype.hasOwnProperty.call(corpo, campo)) {
        throw new TypeError(
          'campo "' + campo + '" não pode ser enviado pelo navegador: '
          + 'empresa, ator e perfil vêm sempre da sessão no servidor'
        );
      }
    }
  }

  function envelopeOk(status, dados) {
    return { ok: true, status: status, dados: dados, codigo: null, mensagem: null, detalhes: null };
  }

  function envelopeErro(status, codigo, mensagem, detalhes) {
    return {
      ok: false,
      status: status,
      dados: null,
      codigo: codigo || null,
      mensagem: mensagem || MENSAGENS_PADRAO[status] || 'Não foi possível concluir a operação.',
      detalhes: detalhes || null,
    };
  }

  /**
   * Lê o corpo da resposta e classifica o resultado em três desfechos
   * distintos, cada um com tratamento próprio em requisitar():
   *
   *   { falhou: true }    — a leitura do corpo foi interrompida. O
   *     servidor chegou a responder (há status HTTP), mas a conexão caiu
   *     no meio do corpo, e `resposta.text()` rejeitou. É uma falha de
   *     REDE, não uma resposta: não há corpo para interpretar e o status
   *     recebido não descreve nenhum desfecho concluído.
   *   { naoEhJson: true } — o corpo foi lido inteiro, mas não é JSON
   *     (ex.: HTML de um proxy). Desfecho diferente do anterior: a troca
   *     se completou, só veio algo que esta camada não sabe interpretar.
   *   { valor: ... }      — corpo lido e interpretado (null se vazio).
   *
   * Um objeto etiquetado, em vez de sentinelas (`undefined`/`null`):
   * com três desfechos possíveis e `null` sendo um corpo VÁLIDO, qualquer
   * sentinela ficaria ambígua — e foi exatamente a ausência do primeiro
   * desfecho que deixou requisitar() rejeitar em vez de devolver
   * envelope quando a conexão caía durante a leitura.
   */
  async function lerCorpo(resposta) {
    var texto;
    try {
      texto = await resposta.text();
    } catch (erroDeLeitura) {
      return { falhou: true };
    }

    if (texto.length === 0) return { valor: null };

    try {
      return { valor: JSON.parse(texto) };
    } catch (erroDeJson) {
      return { naoEhJson: true }; // nunca devolve o texto cru
    }
  }

  /**
   * Executa a requisição e devolve SEMPRE um envelope — nunca lança por
   * causa de status HTTP nem de falha de rede. Só lança por erro de
   * programação (caminho inválido, corpo com campo de autoridade),
   * detectado antes de sair do navegador.
   *
   * @returns {Promise<{ok: boolean, status: number, dados: *, codigo: ?string, mensagem: ?string, detalhes: ?Array}>}
   */
  async function requisitar(metodo, caminho, opcoes) {
    var o = opcoes || {};
    var metodoNormalizado = String(metodo).toUpperCase();
    exigirCaminho(caminho);

    var levaCorpo = METODOS_SEM_CORPO.indexOf(metodoNormalizado) === -1 && o.corpo !== undefined;
    if (levaCorpo) exigirCorpoSemAutoridade(o.corpo);

    var requisicao = {
      method: metodoNormalizado,
      // O cookie HttpOnly de sessão só viaja com isto.
      credentials: 'include',
      headers: levaCorpo ? { 'Content-Type': 'application/json' } : {},
    };
    if (levaCorpo) requisicao.body = JSON.stringify(o.corpo);

    var resposta;
    try {
      resposta = await obterFetch()(configuracao.baseUrl + caminho, requisicao);
    } catch (erroDeRede) {
      registrar(metodoNormalizado, caminho, 0);
      return envelopeErro(0, 'FALHA_DE_REDE', MENSAGEM_REDE, null);
    }

    var corpo = await lerCorpo(resposta);

    // Conexão caiu durante a leitura do corpo: mesmo desfecho de um fetch
    // que nem chegou a responder — status 0, para que ehFalhaDeRede()
    // reconheça as duas situações sem o chamador precisar distingui-las.
    // O status HTTP recebido não é reportado porque a troca não se
    // completou: anunciar "200" com corpo perdido seria pior que dizer
    // que a rede falhou.
    if (corpo.falhou) {
      registrar(metodoNormalizado, caminho, 0);
      return envelopeErro(0, 'FALHA_DE_REDE', MENSAGEM_REDE, null);
    }

    registrar(metodoNormalizado, caminho, resposta.status);

    if (corpo.naoEhJson) {
      return envelopeErro(resposta.status, 'RESPOSTA_INVALIDA', null, null);
    }
    if (resposta.ok) {
      return envelopeOk(resposta.status, corpo.valor);
    }
    return envelopeErro(
      resposta.status,
      corpo.valor && corpo.valor.codigo,
      corpo.valor && corpo.valor.message,
      corpo.valor && corpo.valor.detalhes
    );
  }

  /**
   * Método, caminho e status. NUNCA o corpo — ali viaja senha no login.
   * Status 0 significa "a troca não se completou", seja porque o fetch
   * falhou, seja porque a leitura do corpo foi interrompida.
   */
  function registrar(metodo, caminho, status) {
    if (global.console && typeof global.console.log === 'function') {
      global.console.log('%c[HTTP] ' + metodo + ' ' + caminho + ' → ' + status, 'color:#007AFF');
    }
  }

  var ehFalhaDeRede = function (r) { return r.ok === false && r.status === 0; };
  var ehValidacao = function (r) { return r.ok === false && r.status === 400; };
  var ehNaoAutenticado = function (r) { return r.ok === false && r.status === 401; };
  var ehSemAutorizacao = function (r) { return r.ok === false && r.status === 403; };
  var ehNaoEncontrado = function (r) { return r.ok === false && r.status === 404; };
  var ehConflito = function (r) { return r.ok === false && r.status === 409; };

  global.EpiHttp = {
    configurar: configurar,
    requisitar: requisitar,
    ehFalhaDeRede: ehFalhaDeRede,
    ehValidacao: ehValidacao,
    ehNaoAutenticado: ehNaoAutenticado,
    ehSemAutorizacao: ehSemAutorizacao,
    ehNaoEncontrado: ehNaoEncontrado,
    ehConflito: ehConflito,
    // Getter, não uma cópia única criada no carregamento: cada leitura
    // devolve um array novo, para que mexer no que foi lido nunca altere
    // a lista que o cliente realmente aplica.
    get CAMPOS_DE_AUTORIDADE_PROIBIDOS() { return CAMPOS_DE_AUTORIDADE_PROIBIDOS.slice(); },
  };

  // Permite `require()` nos testes automatizados; no navegador `module` não
  // existe e esta linha é ignorada.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiHttp;
  }
})(typeof window !== 'undefined' ? window : globalThis);
