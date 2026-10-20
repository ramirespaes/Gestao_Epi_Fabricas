(function (global) {
  'use strict';

  /**
   * EpiImagensMaterial — imagem do material, escolhida na Biblioteca Padrão SafeWork ou na biblioteca da EMPRESA (Biblioteca de Imagens, Unidades
   * 5B-2, 5B-3, 5C-8a e 5C-8b):
   *
   *   GET /imagens-material?origem=TODAS&pagina=N&limite=100        (materials.visualizar) as duas bibliotecas, página a página
   *   GET /imagens-material/padrao|empresa/:id/miniatura?v=<versão>  (materials.visualizar) WebP 320×320 verificado, com o cookie de sessão
   *   PATCH  /imagens-material/empresa/:id            { nome }                (materials.editar) renomear
   *   POST   /imagens-material/empresa/:id/inativar   {}                      (materials.editar) 409 IMAGEM_EM_USO se algum material a usa
   *   POST   /imagens-material/empresa/:id/reativar   {}                      (materials.editar)
   *   DELETE /imagens-material/empresa/:id            { confirmacao: true }   (materials.editar) 409 IMAGEM_EM_USO se algum material a usa
   *
   * A pessoa ESCOLHE na tela; nada vem escolhido sozinho, sem sugestão por tipo, grupo ou GHE. A escolha só é gravada quando a página salva o
   * material, e nem escolher nem enviar uma imagem nova grava vínculo: `paraEnvio()` diz o que entra no corpo do POST ou do PATCH de /materiais —
   * `{ origem, id }` para associar ou trocar, `null` para remover e `undefined` (a chave não vai) quando nada mudou em relação à imagem que o
   * servidor já tem (`definirGravada`). O módulo é a única fonte dos caminhos da listagem e da miniatura; o transporte é o EpiHttp (JSON); o
   * envio de imagens novas (binário) é do EpiImagensEnvio; os textos de falha são próprios (nunca o do servidor); e tudo o que aparece vem de nós
   * de DOM e `textContent`: o nome de uma imagem é sempre texto. A identidade de uma imagem é (origem, id): os ids das duas bibliotecas podem
   * coincidir. Os ids são BIGINT e ficam como texto decimal canônico do começo ao fim, sem passar por Number, inclusive ao comparar a escolha
   * com a imagem gravada.
   *
   * Camadas: caminhos e urlMiniatura (funções puras), acoes (transporte), mensagens (texto por falha) e montar (campo do formulário e seletor
   * em pop-up: abas Todas, Padrão SafeWork e Minha Empresa, pesquisa local, a vista "Adicionar imagens" para enviar arquivos novos e, só com
   * `materials.editar`, o modo "Gerenciar" da aba Minha Empresa: renomear, inativar, reativar e excluir as imagens da EMPRESA. A Biblioteca
   * Padrão nunca é gerenciável por aqui. O servidor é a autoridade: a tela usa o `emUso` da listagem só para orientar e trata o 409 IMAGEM_EM_USO.
   */

  var ORIGENS = ['PADRAO', 'EMPRESA'];
  var ROTULO_DA_ORIGEM = { PADRAO: 'Padrão SafeWork', EMPRESA: 'Minha Empresa' };
  var CAMINHO_DA_ORIGEM = { PADRAO: 'padrao', EMPRESA: 'empresa' };
  var ABAS = [{ chave: 'TODAS', rotulo: 'Todas' }, { chave: 'PADRAO', rotulo: 'Padrão SafeWork' }, { chave: 'EMPRESA', rotulo: 'Minha Empresa' }];
  var ORIGENS_DA_LISTA = ['TODAS', 'PADRAO', 'EMPRESA'];
  var ESTADOS_DA_LISTA = ['ATIVA', 'INATIVA', 'TODAS'];
  var CHAVES_DA_LISTA = ['origem', 'estado', 'pagina', 'limite', 'busca'];
  var LIMITE_LISTA = 100;
  var LIMITE_PAGINAS = 50;
  var PAGINA_MAXIMA = 10000;
  var BUSCA_MAXIMA = 100;
  var VERSAO_MAXIMA = 2147483647;
  var ID_DECIMAL = /^[1-9][0-9]*$/;
  var CONTROLE = /\p{Cc}/u;
  var FINAIS_DO_ENVIO = ['CRIADA', 'REAPROVEITADA', 'RECUSADA'];
  var NOME_MAXIMO = 100;

  var TEXTOS = {
    SESSAO: 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.',
    PERMISSAO: 'Sem permissão para consultar a biblioteca de imagens.',
    INDISPONIVEL: 'A biblioteca de imagens está indisponível no momento. Tente novamente mais tarde.',
    REDE: 'Falha de rede: não foi possível carregar as imagens. Verifique a conexão e tente novamente.',
    GENERICO: 'Não foi possível carregar as imagens. Tente novamente.',
    CARREGANDO: 'Carregando as imagens…',
    BIBLIOTECA_VAZIA: 'Nenhuma imagem disponível.',
    PADRAO_VAZIA: 'Nenhuma imagem disponível na Biblioteca Padrão.',
    EMPRESA_VAZIA: 'Sua empresa ainda não tem imagens.',
    EMPRESA_VAZIA_ENVIO: 'Sua empresa ainda não tem imagens. Use “Adicionar imagens” para enviar as primeiras.',
    SEM_RESULTADO: 'Nenhuma imagem encontrada para esta pesquisa.',
    LISTA_INCOMPLETA: 'A lista pode estar incompleta: algumas imagens não puderam ser carregadas. Feche e abra o seletor para tentar de novo.',
    NENHUMA: 'Nenhuma imagem selecionada',
    GRAVADA: 'Imagem gravada neste material.',
    SERA_GRAVADA: 'Será gravada ao salvar o material.',
    SERA_REMOVIDA: 'A imagem atual será removida ao salvar o material.',
    ARQUIVO_INDISPONIVEL: 'Arquivo indisponível; a escolha continua registrada.',
    IMAGEM_INDISPONIVEL: 'Imagem indisponível',
    SEM_IMAGEM: 'Sem imagem',
    SEM_NOME: 'Imagem da Biblioteca Padrão',
    SEM_NOME_EMPRESA: 'Imagem da empresa',
    DESCRICAO: 'Selecione uma imagem da Biblioteca Padrão SafeWork ou da biblioteca da sua empresa para este material. Nada é escolhido automaticamente. A imagem escolhida será gravada quando você salvar o material.',
    NAO_ENCONTRADA: 'A imagem escolhida não está mais disponível na Biblioteca Padrão. Escolha outra imagem ou remova a seleção e salve novamente.',
    NAO_ENCONTRADA_EMPRESA: 'A imagem escolhida não está mais disponível na biblioteca da empresa. Escolha outra imagem ou remova a seleção e salve novamente.',
    RECUSADA: 'O servidor não aceitou a imagem escolhida. Escolha outra imagem ou remova a seleção e salve novamente.',
    ADICIONAR: 'Adicionar imagens',
    ENVIO_TITULO: 'Adicionar imagens à biblioteca da empresa',
    ENVIO_DESCRICAO: 'Escolha um ou vários arquivos. Eles ficarão privados à sua empresa e poderão ser usados em vários materiais.',
    ENVIO_ESCOLHA: 'Escolha as imagens no seu computador',
    SELECIONAR_ARQUIVOS: 'Selecionar arquivos',
    ENVIO_REGRAS: [
      'PNG, JPEG ou WebP, estáticos',
      'Até 2 MiB por arquivo e 10 arquivos por vez',
      'Mínimo de 320 pixels por lado (máximo de 4096)',
      'Enviar o mesmo arquivo duas vezes não cria cópia',
    ],
    NENHUM_ARQUIVO: 'Nenhum arquivo escolhido.',
    ENVIANDO: 'Enviando as imagens…',
    VOLTAR: 'Voltar à biblioteca',
    ADICIONAR_A_BIBLIOTECA: 'Adicionar à biblioteca',
    TIRAR_DA_LISTA: 'Tirar da lista',
    ERRO_ENVIO: 'Não foi possível enviar as imagens. Tente novamente.',
    ERRO_LEITURA: 'Não foi possível ler os arquivos escolhidos. Tente novamente.',
    GERENCIAR: 'Gerenciar imagens',
    GESTAO_TITULO: 'Gerenciar imagens da empresa',
    GESTAO_DESCRICAO: 'Renomeie, inative ou exclua as imagens da biblioteca da sua empresa. A Biblioteca Padrão SafeWork não pode ser alterada.',
    GESTAO_AJUDA: 'Inativar tira a imagem do seletor, mas ela continua ocupando uma vaga da cota. Excluir libera a vaga e não pode ser desfeito. Uma imagem usada por material não pode ser inativada nem excluída.',
    GESTAO_CARREGANDO: 'Carregando as imagens da empresa…',
    GESTAO_VAZIA: 'Sua empresa ainda não tem imagens.',
    GESTAO_SO_INATIVAS: 'Nenhuma imagem ativa. Use “Mostrar inativas” para ver e reativar as imagens inativas.',
    GESTAO_INCOMPLETA: 'A lista pode estar incompleta: algumas imagens não puderam ser carregadas. Use “Atualizar lista” para tentar de novo.',
    MOSTRAR_INATIVAS: 'Mostrar inativas',
    ATUALIZAR_LISTA: 'Atualizar lista',
    CONCLUIR: 'Concluir',
    RENOMEAR: 'Renomear',
    INATIVAR: 'Inativar',
    REATIVAR: 'Reativar',
    EXCLUIR: 'Excluir',
    SALVAR_NOME: 'Salvar nome',
    CANCELAR: 'Cancelar',
    EXCLUIR_IMAGEM: 'Excluir imagem',
    ESTADO_ATIVA: 'Ativa',
    ESTADO_INATIVA: 'Inativa',
    SEM_USO: 'Sem uso em materiais',
    NO_FORMULARIO: 'Escolhida no formulário, ainda não salva',
    AVISO_NO_FORMULARIO: 'Ela está escolhida no formulário e ainda não foi salva: ao salvar o material o servidor a recusará. Escolha outra imagem ou remova a seleção.',
    NOME_DA_GESTAO: 'Informe um nome de 1 a 100 caracteres.',
    CONFIRMA_EXCLUSAO: 'Esta ação não pode ser desfeita. A imagem sai da biblioteca da sua empresa e a vaga volta para a cota.',
    GESTAO_REDE: 'Falha de rede: não foi possível concluir a operação. Verifique a conexão e tente novamente.',
    GESTAO_PERMISSAO: 'Sem permissão para gerenciar as imagens da biblioteca da empresa.',
    GESTAO_NAO_ENCONTRADA: 'Esta imagem não está mais disponível na biblioteca da empresa; outra pessoa pode tê-la excluído.',
    GESTAO_EM_USO: 'Esta imagem está em uso por material e não pode ser inativada nem excluída. Tire a imagem dos materiais que a usam e tente de novo.',
    GESTAO_CONFLITO: 'Não foi possível concluir a operação por um conflito. Atualize a lista e tente novamente.',
    GESTAO_LIMITE: 'Muitas operações em pouco tempo. Aguarde um instante e tente novamente.',
    GESTAO_NOME: 'O nome da imagem não foi aceito. Informe um nome de 1 a 100 caracteres.',
    GESTAO_RECUSADA: 'O servidor não aceitou a operação. Atualize a lista e tente novamente.',
    GESTAO_GENERICO: 'Não foi possível concluir a operação. Tente novamente.',
  };

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/imagens-material.js');
    }
    return cliente;
  }

  /** O módulo de envio (binário) é opcional para quem só escolhe imagens; sem ele a tela não oferece "Adicionar imagens". */
  function envio() {
    return global.EpiImagensEnvio || null;
  }

  // ───────────────────────────────────────────────────────────────────
  // Caminhos e URL da miniatura
  // ───────────────────────────────────────────────────────────────────

  /** Imagem de uma das duas bibliotecas: origem PADRAO ou EMPRESA, id BIGINT em texto decimal canônico e versão inteira de 1 a 2147483647. */
  function validar(imagem) {
    if (!imagem || typeof imagem !== 'object') throw new TypeError('imagem inválida');
    if (ORIGENS.indexOf(imagem.origem) === -1) throw new TypeError('origem de imagem inválida');
    if (typeof imagem.id !== 'string' || !ID_DECIMAL.test(imagem.id)) throw new TypeError('identificador de imagem inválido');
    if (typeof imagem.versao !== 'number' || !Number.isInteger(imagem.versao) || imagem.versao < 1 || imagem.versao > VERSAO_MAXIMA) {
      throw new TypeError('versão de imagem inválida');
    }
  }

  function inteiroEntre(valor, minimo, maximo, nome) {
    if (typeof valor !== 'number' || !Number.isInteger(valor) || valor < minimo || valor > maximo) throw new TypeError(nome + ' da listagem inválido');
    return valor;
  }

  /**
   * GET /imagens-material: sem opções é a listagem da Biblioteca Padrão da 5B; com opções leva, nesta ordem, origem (TODAS, PADRAO ou EMPRESA),
   * estado (ATIVA, INATIVA ou TODAS; só vale para a empresa), página (1 a 10000), limite (1 a 100) e busca (aparada, até 100 caracteres, vazia não vai).
   * Opção fora do contrato, ou chave desconhecida, é TypeError antes de montar o endereço.
   */
  function caminhoDaLista(opcoes) {
    if (opcoes === undefined) return '/imagens-material?origem=PADRAO&pagina=1&limite=' + LIMITE_LISTA;
    if (opcoes === null || typeof opcoes !== 'object' || Array.isArray(opcoes)) throw new TypeError('opções da listagem inválidas');
    Object.keys(opcoes).forEach(function (chave) {
      if (CHAVES_DA_LISTA.indexOf(chave) === -1) throw new TypeError('opção desconhecida da listagem: ' + chave);
    });
    var origem = opcoes.origem === undefined ? 'PADRAO' : opcoes.origem;
    if (ORIGENS_DA_LISTA.indexOf(origem) === -1) throw new TypeError('origem da listagem inválida');
    var estado = opcoes.estado;
    if (estado !== undefined && ESTADOS_DA_LISTA.indexOf(estado) === -1) throw new TypeError('estado da listagem inválido');
    var pagina = opcoes.pagina === undefined ? 1 : inteiroEntre(opcoes.pagina, 1, PAGINA_MAXIMA, 'página');
    var limite = opcoes.limite === undefined ? LIMITE_LISTA : inteiroEntre(opcoes.limite, 1, LIMITE_LISTA, 'limite');
    var busca = '';
    if (opcoes.busca !== undefined) {
      if (typeof opcoes.busca !== 'string') throw new TypeError('busca da listagem inválida');
      busca = opcoes.busca.trim().normalize('NFC');
      if (Array.from(busca).length > BUSCA_MAXIMA || CONTROLE.test(busca)) throw new TypeError('busca da listagem inválida');
    }
    return '/imagens-material?origem=' + origem + (estado === undefined ? '' : '&estado=' + estado) + '&pagina=' + pagina + '&limite=' + limite
      + (busca === '' ? '' : '&busca=' + encodeURIComponent(busca));
  }

  /** Identificador de imagem: BIGINT em texto decimal canônico (nunca Number). */
  function exigirIdDaImagem(id) {
    if (typeof id !== 'string' || !ID_DECIMAL.test(id)) throw new TypeError('identificador de imagem inválido');
    return id;
  }

  /** Nome de imagem: aparado, em NFC, de 1 a 100 pontos de código e sem caractere de controle (a regra do servidor). TypeError se não servir. */
  function normalizarNomeDaImagem(nome) {
    if (typeof nome !== 'string') throw new TypeError('nome de imagem inválido');
    var texto = nome.trim().normalize('NFC');
    var tamanho = Array.from(texto).length;
    if (tamanho < 1 || tamanho > NOME_MAXIMO || CONTROLE.test(texto)) throw new TypeError('nome de imagem inválido');
    return texto;
  }

  var caminhos = {
    lista: caminhoDaLista,
    miniatura: function (imagem) {
      validar(imagem);
      return '/imagens-material/' + CAMINHO_DA_ORIGEM[imagem.origem] + '/' + imagem.id + '/miniatura?v=' + imagem.versao;
    },
    /** Gerenciar a imagem da EMPRESA (renomear e excluir; inativar e reativar). A Biblioteca Padrão nunca tem rota de escrita. */
    empresa: function (id) { return '/imagens-material/empresa/' + exigirIdDaImagem(id); },
    inativar: function (id) { return '/imagens-material/empresa/' + exigirIdDaImagem(id) + '/inativar'; },
    reativar: function (id) { return '/imagens-material/empresa/' + exigirIdDaImagem(id) + '/reativar'; },
  };

  function urlMiniatura(imagem, baseUrl) {
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl inválida');
    return baseUrl.replace(/\/+$/, '') + caminhos.miniatura(imagem);
  }

  /**
   * A imagem que o servidor devolve em `material.imagem`: { origem, id, versao, nome }, ou null quando não há ou quando não tem o formato do
   * contrato. O id continua texto; a versão serve à miniatura; sem nome, um rótulo neutro da origem.
   */
  function lerGravada(imagem) {
    if (!imagem || typeof imagem !== 'object') return null;
    var candidata = { origem: imagem.origem, id: imagem.id, versao: imagem.versao };
    try { validar(candidata); } catch (erro) { return null; }
    var semNome = candidata.origem === 'EMPRESA' ? TEXTOS.SEM_NOME_EMPRESA : TEXTOS.SEM_NOME;
    var nome = typeof imagem.nome === 'string' && imagem.nome.trim() !== '' ? imagem.nome : semNome;
    return { origem: candidata.origem, id: candidata.id, versao: candidata.versao, nome: nome };
  }

  // ───────────────────────────────────────────────────────────────────
  // Ações e mensagens
  // ───────────────────────────────────────────────────────────────────

  var acoes = {
    /** Todas as imagens da Biblioteca Padrão (uma página: as 30 cabem em limite=100). */
    listarPadrao: function () {
      return http().requisitar('GET', caminhos.lista());
    },
    /** Uma página da listagem, pelo caminho de `caminhos.lista(opcoes)`. */
    listar: function (opcoes) {
      return http().requisitar('GET', caminhos.lista(opcoes));
    },
    /**
     * A biblioteca inteira, página por página (limite 100, até 50 páginas), sem repetir (origem, id). A falha da PRIMEIRA página é a falha da operação;
     * a de uma página seguinte mantém o que já veio e marca `completa: false` com a `falha`. Nunca insiste numa página que falhou.
     * Devolve o envelope do EpiHttp com `dados: { imagens, total, completa, falha }`.
     */
    listarTodas: async function (opcoes) {
      var o = opcoes === undefined ? {} : opcoes;
      if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new TypeError('opções da listagem inválidas');
      Object.keys(o).forEach(function (chave) {
        if (chave !== 'origem' && chave !== 'estado') throw new TypeError('opção desconhecida da listagem: ' + chave);
      });
      var base = { origem: o.origem === undefined ? 'TODAS' : o.origem };
      if (o.estado !== undefined) base.estado = o.estado;
      var pedido = function (pagina) { return Object.assign({}, base, { pagina: pagina, limite: LIMITE_LISTA }); };
      caminhos.lista(pedido(1));

      var imagens = [];
      var vistos = {};
      var total = null;
      var completa = false;
      var falha = null;
      for (var pagina = 1; pagina <= LIMITE_PAGINAS; pagina += 1) {
        var r = await acoes.listar(pedido(pagina));
        if (!r.ok) {
          if (pagina === 1) return r;
          falha = r;
          break;
        }
        var lote = r.dados && Array.isArray(r.dados.imagens) ? r.dados.imagens : null;
        if (lote === null) {
          if (pagina === 1) return r;
          falha = { ok: false, status: 200, dados: null, codigo: 'RESPOSTA_INVALIDA', mensagem: null, detalhes: null };
          break;
        }
        var novas = 0;
        lote.forEach(function (imagem) {
          var chave = String(imagem && imagem.origem) + ':' + String(imagem && imagem.id);
          if (vistos[chave] === true) return;
          vistos[chave] = true;
          imagens.push(imagem);
          novas += 1;
        });
        if (typeof r.dados.total === 'number' && isFinite(r.dados.total)) total = r.dados.total;
        if (total !== null ? imagens.length >= total : lote.length < LIMITE_LISTA) {
          completa = true;
          break;
        }
        if (lote.length === 0 || novas === 0) break;
      }
      return {
        ok: true,
        status: 200,
        dados: { imagens: imagens, total: total === null ? imagens.length : total, completa: completa, falha: falha },
        codigo: null,
        mensagem: null,
        detalhes: null,
      };
    },
    /**
     * Gerenciar a imagem da EMPRESA (materials.editar). Todas devolvem o envelope do EpiHttp, também nas falhas; id ou nome fora do contrato é TypeError
     * antes da rede. Nada aqui repete sozinho: quem chama decide. Renomear e reativar/inativar são idempotentes no servidor (`alterado: false`).
     */
    renomear: function (id, nome) {
      var caminho = caminhos.empresa(id);
      return http().requisitar('PATCH', caminho, { corpo: { nome: normalizarNomeDaImagem(nome) } });
    },
    inativar: function (id) {
      return http().requisitar('POST', caminhos.inativar(id), { corpo: {} });
    },
    reativar: function (id) {
      return http().requisitar('POST', caminhos.reativar(id), { corpo: {} });
    },
    /** Excluir NUNCA sai sem a confirmação explícita `{ confirmado: true }` (qualquer outra coisa é TypeError e nada vai à rede). */
    excluir: function (id, opcoes) {
      var caminho = caminhos.empresa(id);
      if (!opcoes || typeof opcoes !== 'object' || opcoes.confirmado !== true) throw new TypeError('excluir exige { confirmado: true }');
      return http().requisitar('DELETE', caminho, { corpo: { confirmacao: true } });
    },
  };

  /** Texto da falha da listagem pelo status e pelo código; o texto que o servidor mandou nunca é usado. */
  function deLista(r) {
    var status = r && typeof r.status === 'number' ? r.status : 0;
    if (status === 0) return TEXTOS.REDE;
    if (status === 401) return TEXTOS.SESSAO;
    if (status === 403) return TEXTOS.PERMISSAO;
    if (status === 503 || r.codigo === 'IMAGENS_INDISPONIVEL') return TEXTOS.INDISPONIVEL;
    return TEXTOS.GENERICO;
  }

  /** O 400 aponta o campo `imagem` do corpo: body.imagem, body.imagem.id ou body.imagem.origem. */
  function detalheDaImagem(r) {
    var detalhes = r && Array.isArray(r.detalhes) ? r.detalhes : [];
    return detalhes.some(function (d) {
      var campo = d && typeof d.campo === 'string' ? d.campo : '';
      return campo === 'body.imagem' || campo.indexOf('body.imagem.') === 0;
    });
  }

  /**
   * Texto da recusa DA IMAGEM ao gravar o material (POST ou PATCH de /materiais), ou null quando a resposta não é dela. Só dois casos são da imagem:
   * 404 com o código IMAGEM_NAO_ENCONTRADA (inexistente, inativa ou de outra empresa; nunca o 404 do material, que tem outro código) e 400 com o
   * detalhe em body.imagem. O texto que o servidor mandou nunca é usado. `origem` é a da imagem que foi enviada: para a da empresa o texto não fala
   * da Biblioteca Padrão.
   */
  function deGravacao(r, origem) {
    if (!r || typeof r.status !== 'number') return null;
    if (r.status === 404 && r.codigo === 'IMAGEM_NAO_ENCONTRADA') return origem === 'EMPRESA' ? TEXTOS.NAO_ENCONTRADA_EMPRESA : TEXTOS.NAO_ENCONTRADA;
    if (r.status === 400 && detalheDaImagem(r)) return TEXTOS.RECUSADA;
    return null;
  }

  /** O 400 de renomear aponta o campo `nome` do corpo. */
  function detalheDoNome(r) {
    var detalhes = r && Array.isArray(r.detalhes) ? r.detalhes : [];
    return detalhes.some(function (d) { return d && typeof d.campo === 'string' && d.campo === 'body.nome'; });
  }

  /**
   * Texto da falha de renomear, inativar, reativar ou excluir pelo status e pelo código; o texto que o servidor mandou nunca é usado. O 404 só vira
   * "não está mais disponível" com o código do servidor (IMAGEM_NAO_ENCONTRADA): uma rota inexistente não pode passar por exclusão de outra pessoa.
   */
  function deGerenciamento(r) {
    var status = r && typeof r.status === 'number' ? r.status : 0;
    var codigo = r && typeof r.codigo === 'string' ? r.codigo : '';
    if (status === 0) return TEXTOS.GESTAO_REDE;
    if (status === 401) return TEXTOS.SESSAO;
    if (status === 403) return TEXTOS.GESTAO_PERMISSAO;
    if (status === 404 && codigo === 'IMAGEM_NAO_ENCONTRADA') return TEXTOS.GESTAO_NAO_ENCONTRADA;
    if (status === 409) return codigo === 'IMAGEM_EM_USO' ? TEXTOS.GESTAO_EM_USO : TEXTOS.GESTAO_CONFLITO;
    if (status === 429) return TEXTOS.GESTAO_LIMITE;
    if (status === 503 || codigo === 'IMAGENS_INDISPONIVEL') return TEXTOS.INDISPONIVEL;
    if (status === 400) return detalheDoNome(r) ? TEXTOS.GESTAO_NOME : TEXTOS.GESTAO_RECUSADA;
    return TEXTOS.GESTAO_GENERICO;
  }

  var mensagens = { TEXTOS: TEXTOS, deLista: deLista, deGravacao: deGravacao, deGerenciamento: deGerenciamento };

  // ───────────────────────────────────────────────────────────────────
  // DOM seguro
  // ───────────────────────────────────────────────────────────────────

  function normalizar(texto) {
    return String(texto).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }

  /** Cria o nó, grava os atributos com setAttribute e acrescenta filhos: texto vira nó de texto, nunca marcação. */
  function criar(doc, tag, atributos, filhos) {
    var no = doc.createElement(tag);
    Object.keys(atributos || {}).forEach(function (k) { no.setAttribute(k, String(atributos[k])); });
    (filhos || []).forEach(function (f) {
      if (f === null || f === undefined) return;
      no.appendChild(typeof f === 'string' ? doc.createTextNode(f) : f);
    });
    return no;
  }

  function icone(doc, nome) {
    return criar(doc, 'span', { class: 'material-symbols-outlined', 'aria-hidden': 'true' }, [nome]);
  }

  /** Quadro com ícone e texto só para leitor de tela (sem imagem, ou arquivo indisponível). */
  function quadro(doc, classe, nomeIcone, texto) {
    return criar(doc, 'div', { class: classe, role: 'img', 'aria-label': texto }, [icone(doc, nomeIcone), criar(doc, 'span', { class: 'bi-so-leitor' }, [texto])]);
  }

  function mostrar(no, visivel) {
    no.hidden = !visivel;
    no.style.display = visivel ? '' : 'none';
  }

  function plural(n, singular, plurais) {
    return n === 1 ? n + ' ' + singular : n + ' ' + plurais;
  }

  function tamanhoLegivel(bytes) {
    return bytes / 1024 < 1024 ? Math.max(1, Math.round(bytes / 1024)) + ' KiB' : (bytes / 1048576).toFixed(1) + ' MiB';
  }

  function construirModal(doc) {
    var titulo = criar(doc, 'h2', { id: 'imagemModalTitulo', tabindex: '-1' }, ['Escolher imagem do material']);
    var fechar = criar(doc, 'button', { id: 'botaoImagemFechar', class: 'modal-close', type: 'button', 'aria-label': 'Fechar' }, ['close']);
    var abas = ABAS.map(function (aba) {
      return criar(doc, 'button', { type: 'button', class: 'bi-seg', 'data-aba': aba.chave, 'aria-pressed': 'false' }, [aba.rotulo]);
    });
    var adicionar = criar(doc, 'button', { id: 'botaoImagemAdicionar', class: 'outlined-btn', type: 'button' }, [icone(doc, 'add'), TEXTOS.ADICIONAR]);
    var busca = criar(doc, 'input', { id: 'imagemBusca', class: 'input', type: 'search', placeholder: 'Pesquisar pelo nome', 'aria-label': 'Pesquisar imagens pelo nome', autocomplete: 'off' });
    var contagem = criar(doc, 'div', { id: 'imagemContagem', class: 'bi-contagem', role: 'status', 'aria-live': 'polite' });
    var aviso = criar(doc, 'div', { id: 'imagemAvisoLote', class: 'bi-aviso-lote', role: 'status', 'aria-live': 'polite', hidden: '' });
    var estado = criar(doc, 'div', { id: 'imagemModalEstado', class: 'bi-estado-modal', role: 'status', 'aria-live': 'polite' });
    var lista = criar(doc, 'div', { id: 'imagemLista', class: 'bi-grade', role: 'listbox', 'aria-label': 'Imagens disponíveis' });
    var resumo = criar(doc, 'div', { id: 'imagemResumoSelecao', class: 'bi-selecao-resumo', role: 'status', 'aria-live': 'polite' }, [TEXTOS.NENHUMA + '.']);
    var cancelar = criar(doc, 'button', { id: 'botaoImagemCancelar', class: 'outlined-btn', type: 'button' }, ['Cancelar']);
    var confirmar = criar(doc, 'button', { id: 'botaoImagemConfirmar', class: 'filled-btn', type: 'button' }, ['Salvar imagem selecionada']);
    confirmar.disabled = true;
    // O botão "Gerenciar imagens" NÃO nasce aqui: só existe no DOM enquanto a pessoa tem materials.editar (ver `atualizarGerenciar`).
    var barra = criar(doc, 'div', { class: 'bi-barra' }, [
      criar(doc, 'div', { class: 'bi-filtro', role: 'group', 'aria-label': 'Filtrar por biblioteca' }, abas),
      criar(doc, 'div', { class: 'bi-busca' }, [icone(doc, 'search'), busca]),
      adicionar,
    ]);
    var vistaBiblioteca = criar(doc, 'div', { id: 'imagemVistaBiblioteca', class: 'bi-vista' }, [
      criar(doc, 'div', { class: 'modal-header bi-modal-topo' }, [
        criar(doc, 'div', { class: 'modal-title bi-modal-titulo' }, [
          criar(doc, 'div', { class: 'card-icon', 'aria-hidden': 'true' }, ['photo_library']),
          criar(doc, 'div', {}, [titulo, criar(doc, 'p', { id: 'imagemModalDescricao' }, [TEXTOS.DESCRICAO])]),
        ]),
        fechar,
      ]),
      barra,
      contagem,
      aviso,
      estado,
      criar(doc, 'div', { class: 'bi-corpo' }, [lista]),
      criar(doc, 'div', { class: 'bi-rodape' }, [resumo, criar(doc, 'div', { class: 'bi-rodape-acoes' }, [cancelar, confirmar])]),
    ]);

    var envioTitulo = criar(doc, 'h2', { id: 'imagemEnvioTitulo', tabindex: '-1' }, [TEXTOS.ENVIO_TITULO]);
    var envioFechar = criar(doc, 'button', { id: 'botaoImagemEnvioFechar', class: 'modal-close', type: 'button', 'aria-label': 'Fechar' }, ['close']);
    var selecionarArquivos = criar(doc, 'button', { id: 'botaoImagemSelecionarArquivos', class: 'filled-btn bi-botao-arquivo', type: 'button' }, [icone(doc, 'folder_open'), TEXTOS.SELECIONAR_ARQUIVOS]);
    var arquivos = criar(doc, 'input', { id: 'imagemArquivos', class: 'bi-oculto-visual', type: 'file', multiple: '', accept: '', tabindex: '-1', 'aria-hidden': 'true' });
    var envioMensagem = criar(doc, 'div', { id: 'imagemEnvioMensagem', class: 'bi-lote-mensagem', role: 'status', 'aria-live': 'polite' });
    var envioLista = criar(doc, 'ul', { id: 'imagemEnvioLista', class: 'bi-arquivos', 'aria-label': 'Arquivos escolhidos' });
    var envioResumo = criar(doc, 'div', { id: 'imagemEnvioResumo', class: 'bi-selecao-resumo', role: 'status', 'aria-live': 'polite' }, [TEXTOS.NENHUM_ARQUIVO]);
    var voltar = criar(doc, 'button', { id: 'botaoImagemVoltar', class: 'outlined-btn', type: 'button' }, [icone(doc, 'arrow_back'), TEXTOS.VOLTAR]);
    var enviar = criar(doc, 'button', { id: 'botaoImagemEnviar', class: 'filled-btn', type: 'button' }, [TEXTOS.ADICIONAR_A_BIBLIOTECA]);
    enviar.disabled = true;
    var vistaEnvio = criar(doc, 'div', { id: 'imagemVistaEnvio', class: 'bi-vista', hidden: '' }, [
      criar(doc, 'div', { class: 'modal-header bi-modal-topo' }, [
        criar(doc, 'div', { class: 'modal-title bi-modal-titulo' }, [
          criar(doc, 'div', { class: 'card-icon', 'aria-hidden': 'true' }, ['upload_file']),
          criar(doc, 'div', {}, [envioTitulo, criar(doc, 'p', { id: 'imagemEnvioDescricao' }, [TEXTOS.ENVIO_DESCRICAO])]),
        ]),
        envioFechar,
      ]),
      criar(doc, 'div', { class: 'bi-corpo bi-corpo-upload' }, [
        criar(doc, 'div', { class: 'bi-soltar' }, [
          icone(doc, 'cloud_upload'),
          criar(doc, 'p', { class: 'bi-soltar-titulo' }, [TEXTOS.ENVIO_ESCOLHA]),
          selecionarArquivos,
          arquivos,
          criar(doc, 'ul', { class: 'bi-regras-upload' }, TEXTOS.ENVIO_REGRAS.map(function (regra) { return criar(doc, 'li', {}, [regra]); })),
        ]),
        envioMensagem,
        envioLista,
      ]),
      criar(doc, 'div', { class: 'bi-rodape' }, [envioResumo, criar(doc, 'div', { class: 'bi-rodape-acoes' }, [voltar, enviar])]),
    ]);

    // Vista "Gerenciar" (5C-8b): só as imagens da EMPRESA (a Biblioteca Padrão nunca entra aqui).
    var gestaoTitulo = criar(doc, 'h2', { id: 'imagemGestaoTitulo', tabindex: '-1' }, [TEXTOS.GESTAO_TITULO]);
    var gestaoFechar = criar(doc, 'button', { id: 'botaoImagemGestaoFechar', class: 'modal-close', type: 'button', 'aria-label': 'Fechar' }, ['close']);
    var gestaoInativas = criar(doc, 'input', { id: 'imagemGestaoInativas', type: 'checkbox' });
    var gestaoAtualizar = criar(doc, 'button', { id: 'botaoImagemGestaoAtualizar', class: 'outlined-btn', type: 'button' }, [icone(doc, 'refresh'), TEXTOS.ATUALIZAR_LISTA]);
    var gestaoContagem = criar(doc, 'div', { id: 'imagemGestaoContagem', class: 'bi-contagem', role: 'status', 'aria-live': 'polite' });
    var gestaoAviso = criar(doc, 'div', { id: 'imagemGestaoAviso', class: 'bi-aviso-lote', role: 'status', 'aria-live': 'polite', hidden: '' });
    var gestaoEstado = criar(doc, 'div', { id: 'imagemGestaoEstado', class: 'bi-estado-modal', role: 'status', 'aria-live': 'polite' });
    var gestaoLista = criar(doc, 'ul', { id: 'imagemGestaoLista', class: 'bi-gestao-lista', 'aria-label': 'Imagens da biblioteca da empresa' });
    var gestaoConcluir = criar(doc, 'button', { id: 'botaoImagemGestaoConcluir', class: 'filled-btn', type: 'button' }, [TEXTOS.CONCLUIR]);
    var vistaGestao = criar(doc, 'div', { id: 'imagemVistaGestao', class: 'bi-vista', hidden: '' }, [
      criar(doc, 'div', { class: 'modal-header bi-modal-topo' }, [
        criar(doc, 'div', { class: 'modal-title bi-modal-titulo' }, [
          criar(doc, 'div', { class: 'card-icon', 'aria-hidden': 'true' }, ['tune']),
          criar(doc, 'div', {}, [gestaoTitulo, criar(doc, 'p', { id: 'imagemGestaoDescricao' }, [TEXTOS.GESTAO_DESCRICAO])]),
        ]),
        gestaoFechar,
      ]),
      criar(doc, 'div', { class: 'bi-barra' }, [
        criar(doc, 'label', { class: 'bi-gestao-chave' }, [gestaoInativas, TEXTOS.MOSTRAR_INATIVAS]),
        gestaoAtualizar,
      ]),
      criar(doc, 'p', { class: 'bi-gestao-ajuda' }, [TEXTOS.GESTAO_AJUDA]),
      gestaoContagem,
      gestaoAviso,
      gestaoEstado,
      criar(doc, 'div', { class: 'bi-corpo' }, [gestaoLista]),
      criar(doc, 'div', { class: 'bi-rodape bi-rodape-gestao' }, [criar(doc, 'div', { class: 'bi-rodape-acoes' }, [gestaoConcluir])]),
    ]);

    var dialogo = criar(doc, 'div', {
      class: 'modal-card bi-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'imagemModalTitulo', 'aria-describedby': 'imagemModalDescricao',
    }, [vistaBiblioteca, vistaEnvio, vistaGestao]);
    var raiz = criar(doc, 'div', { id: 'modalImagemMaterial', class: 'modal-overlay bi-overlay', 'aria-hidden': 'true' }, [dialogo]);
    return {
      raiz: raiz,
      dialogo: dialogo,
      titulo: titulo,
      fechar: fechar,
      abas: abas,
      adicionar: adicionar,
      busca: busca,
      contagem: contagem,
      aviso: aviso,
      estado: estado,
      lista: lista,
      resumo: resumo,
      cancelar: cancelar,
      confirmar: confirmar,
      vistaBiblioteca: vistaBiblioteca,
      vistaEnvio: vistaEnvio,
      envioTitulo: envioTitulo,
      envioFechar: envioFechar,
      selecionarArquivos: selecionarArquivos,
      arquivos: arquivos,
      envioMensagem: envioMensagem,
      envioLista: envioLista,
      envioResumo: envioResumo,
      voltar: voltar,
      enviar: enviar,
      barra: barra,
      gerenciar: null,
      vistaGestao: vistaGestao,
      gestaoTitulo: gestaoTitulo,
      gestaoFechar: gestaoFechar,
      gestaoInativas: gestaoInativas,
      gestaoAtualizar: gestaoAtualizar,
      gestaoContagem: gestaoContagem,
      gestaoAviso: gestaoAviso,
      gestaoEstado: gestaoEstado,
      gestaoLista: gestaoLista,
      gestaoConcluir: gestaoConcluir,
    };
  }

  // ───────────────────────────────────────────────────────────────────
  // Campo do formulário e seletor
  // ───────────────────────────────────────────────────────────────────

  /**
   * Liga o campo "Imagem do material" (marcação estática da página: #imagemMaterialPrevia, #imagemMaterialEstado, #botaoEscolherImagem e
   * #botaoRemoverImagem) ao seletor em pop-up, que este módulo monta e acrescenta ao <body>.
   *
   * @param {{documento?: Document, baseUrl?: string, aoSessaoEncerrada?: Function}} opcoes
   * @returns {{habilitar: Function, reiniciar: Function, definirGravada: Function, paraEnvio: Function, fechar: Function, encerrar: Function}}
   */
  function montar(opcoes) {
    var o = opcoes || {};
    var doc = o.documento || global.document;
    var base = o.baseUrl || http().configurar({}).baseUrl;
    var aoSessaoEncerrada = typeof o.aoSessaoEncerrada === 'function' ? o.aoSessaoEncerrada : function () {};
    var porId = function (id) { return doc.getElementById(id); };

    var campo = { previa: porId('imagemMaterialPrevia'), estado: porId('imagemMaterialEstado'), escolher: porId('botaoEscolherImagem'), remover: porId('botaoRemoverImagem') };
    if (!campo.previa || !campo.estado || !campo.escolher || !campo.remover) throw new Error('campo "Imagem do material" ausente na página');
    if (porId('modalImagemMaterial')) throw new Error('seletor de imagens já montado');
    var m = construirModal(doc);
    doc.body.appendChild(m.raiz);

    var escolhida = null; // { origem, id, versao, nome } mostrada no formulário: a imagem gravada do material ou a escolha ainda pendente
    var gravada = null; // { origem, id } que o servidor já tem para o material em edição; null = nenhuma
    var rascunho = null; // { origem, id } marcado dentro do seletor, ainda não confirmado
    var imagens = null; // lista validada da última consulta bem-sucedida; null = ainda não carregada ou falhou
    var incompleta = false; // a última consulta trouxe só parte da biblioteca (uma página seguinte falhou): a próxima abertura consulta de novo
    var opcoesNos = []; // { imagem, no, chave } na ordem da API
    var previaIndisponivel = false;
    var habilitado = true;
    var podeEnviar = false;
    var aberto = false;
    var sequencia = 0;
    var aba = 'TODAS';
    var vista = 'BIBLIOTECA';
    var lote = []; // linhas da vista de envio: { id, arquivo, url, nome, recusa, hash, dim, resultado }
    var geracaoLote = 0; // muda quando o lote é descartado: leitura ou envio antigo não escreve na tela
    var emLeitura = 0;
    var fila = Promise.resolve();
    var proximaLinha = 1;
    var enviando = false;
    var listaDesatualizada = false; // houve imagem criada, reaproveitada ou alterada pelo gerenciamento: a lista da biblioteca precisa ser lida de novo
    // Gerenciar as imagens da empresa (5C-8b)
    var podeGerenciar = false; // materials.editar efetivo, entregue pela página; o servidor continua a autoridade
    var gestaoImagens = null; // imagens da EMPRESA (ativas e inativas) da última leitura: { id, versao, nome, estado, emUso|null }; null = ainda não lida
    var gestaoCarregando = false;
    var gestaoFalha = ''; // texto da última falha de LEITURA da lista (a das operações vai no aviso)
    var gestaoIncompleta = false;
    var gestaoMostrarInativas = false;
    var gestaoOcupada = null; // { id, tipo } da operação em andamento: uma por vez, armada ANTES de qualquer espera
    var gestaoRenomeando = null; // id da imagem cujo nome está sendo editado
    var gestaoValor = '';
    var gestaoErroNome = '';
    var gestaoConfirmando = null; // id da imagem cuja exclusão aguarda a confirmação
    var gestaoFocoPendente = null; // candidatos a receber o foco assim que a lista estiver habilitada de novo (depois de uma leitura, por exemplo)
    var gestaoLeitura = 0; // muda a cada leitura da lista e ao sair da vista: resposta antiga não escreve na tela
    var gestaoGeracao = 0; // muda ao sair da vista: o resultado de uma operação antiga não escreve na tela

    /** Mesma imagem: origem e id comparados como TEXTO (ids BIGINT nunca passam por Number). */
    function mesma(a, b) {
      if (a === null || b === null) return a === b;
      return a.origem === b.origem && a.id === b.id;
    }

    // ── campo no formulário ──
    function renderCampo() {
      campo.previa.replaceChildren();
      campo.estado.replaceChildren();
      if (escolhida === null) {
        campo.previa.appendChild(quadro(doc, 'bi-previa-vazia', 'image', TEXTOS.SEM_IMAGEM));
        campo.estado.appendChild(criar(doc, 'span', { class: 'bi-nome' }, [TEXTOS.NENHUMA]));
        if (gravada !== null) campo.estado.appendChild(criar(doc, 'span', { class: 'bi-sub' }, [TEXTOS.SERA_REMOVIDA]));
        mostrar(campo.remover, false);
        return;
      }
      if (previaIndisponivel) {
        campo.previa.appendChild(quadro(doc, 'bi-previa-falha', 'image_not_supported', TEXTOS.IMAGEM_INDISPONIVEL));
      } else {
        var img = criar(doc, 'img', { alt: '', src: urlMiniatura(escolhida, base) });
        img.addEventListener('error', function () {
          if (img.parentNode !== campo.previa) return;
          previaIndisponivel = true;
          renderCampo();
        });
        campo.previa.appendChild(img);
      }
      campo.estado.appendChild(criar(doc, 'span', { class: 'bi-nome', title: escolhida.nome }, [escolhida.nome]));
      if (previaIndisponivel) campo.estado.appendChild(criar(doc, 'span', { class: 'bi-sub' }, [TEXTOS.ARQUIVO_INDISPONIVEL]));
      campo.estado.appendChild(criar(doc, 'span', { class: 'bi-sub' }, [mesma(escolhida, gravada) ? TEXTOS.GRAVADA : TEXTOS.SERA_GRAVADA]));
      mostrar(campo.remover, true);
    }

    // ── lista do seletor ──
    function achar(referencia) {
      if (referencia === null) return null;
      for (var i = 0; i < opcoesNos.length; i += 1) if (mesma(opcoesNos[i].imagem, referencia)) return opcoesNos[i];
      return null;
    }

    function opcoesVisiveis() {
      return Array.prototype.slice.call(m.lista.querySelectorAll('[role="option"]'));
    }

    /** Só uma opção entra na ordem de tabulação: a marcada, ou a primeira. */
    function ajustarTabindex(foco) {
      var visiveis = opcoesVisiveis();
      var alvo = foco || null;
      if (alvo === null) visiveis.forEach(function (n) { if (alvo === null && n.getAttribute('aria-selected') === 'true') alvo = n; });
      if (alvo === null) alvo = visiveis[0] || null;
      opcoesNos.forEach(function (op) { op.no.setAttribute('tabindex', op.no === alvo ? '0' : '-1'); });
    }

    function atualizarSelecao() {
      opcoesNos.forEach(function (op) { op.no.setAttribute('aria-selected', rascunho !== null && mesma(op.imagem, rascunho) ? 'true' : 'false'); });
      var item = achar(rascunho);
      m.resumo.textContent = item ? 'Selecionada: ' + item.imagem.nome + ' (' + ROTULO_DA_ORIGEM[item.imagem.origem] + ')' : TEXTOS.NENHUMA + '.';
      m.confirmar.disabled = item === null || (escolhida !== null && mesma(escolhida, item.imagem));
    }

    function atualizarAbas() {
      m.abas.forEach(function (botao) { botao.setAttribute('aria-pressed', botao.getAttribute('data-aba') === aba ? 'true' : 'false'); });
      atualizarGerenciar();
    }

    function daAba() {
      return opcoesNos.filter(function (op) { return aba === 'TODAS' || op.imagem.origem === aba; });
    }

    function renderLista() {
      if (imagens === null) return;
      var termo = normalizar(m.busca.value);
      var naAba = daAba();
      var visiveis = naAba.filter(function (op) { return termo === '' || op.chave.indexOf(termo) !== -1; });
      m.lista.replaceChildren();
      visiveis.forEach(function (op) { m.lista.appendChild(op.no); });
      if (imagens.length === 0) m.estado.textContent = TEXTOS.BIBLIOTECA_VAZIA;
      else if (naAba.length === 0) m.estado.textContent = aba === 'EMPRESA' ? (podeEnviar ? TEXTOS.EMPRESA_VAZIA_ENVIO : TEXTOS.EMPRESA_VAZIA) : TEXTOS.PADRAO_VAZIA;
      else if (visiveis.length === 0) m.estado.textContent = TEXTOS.SEM_RESULTADO;
      else m.estado.textContent = incompleta ? TEXTOS.LISTA_INCOMPLETA : '';
      var rotulo = function (n) { return n + (n === 1 ? ' imagem' : ' imagens'); };
      m.contagem.textContent = termo === '' && aba === 'TODAS' ? rotulo(imagens.length) : 'Mostrando ' + visiveis.length + ' de ' + rotulo(naAba.length);
      atualizarSelecao();
      ajustarTabindex(null);
    }

    function trocarAba(chave) {
      if (chave === aba) return;
      aba = chave;
      atualizarAbas();
      renderLista();
    }

    function construirOpcao(imagem) {
      var img = criar(doc, 'img', { alt: '', src: urlMiniatura(imagem, base) });
      var quadroImg = criar(doc, 'div', { class: 'bi-item-img' }, [img]);
      img.addEventListener('error', function () {
        if (img.parentNode === quadroImg) quadroImg.replaceChildren(quadro(doc, 'bi-previa-falha', 'image_not_supported', TEXTOS.IMAGEM_INDISPONIVEL));
      });
      var no = criar(doc, 'div', {
        class: 'bi-item', role: 'option', tabindex: '-1', 'aria-selected': 'false', 'data-imagem-origem': imagem.origem, 'data-imagem-id': imagem.id,
      }, [
        quadroImg,
        criar(doc, 'span', { class: 'bi-item-nome' }, [imagem.nome]),
        criar(doc, 'span', { class: 'bi-item-origem' }, [ROTULO_DA_ORIGEM[imagem.origem]]),
        criar(doc, 'span', { class: 'bi-item-marca', 'aria-hidden': 'true' }, [icone(doc, 'check')]),
      ]);
      return { imagem: imagem, no: no, chave: normalizar(imagem.nome) };
    }

    /** Só entra o que tem o formato do contrato; o resto é descartado em silêncio (a tela nunca monta URL a partir de dado malformado). */
    function validarLista(dados) {
      if (!dados || !Array.isArray(dados.imagens)) return null;
      var saida = [];
      dados.imagens.forEach(function (i) {
        if (!i || typeof i.nome !== 'string' || i.nome.trim() === '') return;
        var candidata = { origem: i.origem, id: i.id, versao: i.versao, nome: i.nome };
        try { validar(candidata); } catch (erro) { return; }
        saida.push(candidata);
      });
      return saida;
    }

    async function carregar() {
      if (imagens !== null && !incompleta) {
        renderLista();
        return;
      }
      sequencia += 1;
      var minha = sequencia;
      imagens = null;
      opcoesNos = [];
      m.lista.replaceChildren();
      m.contagem.textContent = '';
      m.estado.textContent = TEXTOS.CARREGANDO;
      atualizarSelecao();
      var r = await acoes.listarTodas({ origem: 'TODAS' });
      if (minha !== sequencia || !aberto) return; // resposta antiga: descartada
      var lida = r.ok ? validarLista(r.dados) : null;
      if (lida === null) {
        m.estado.textContent = deLista(r.ok ? { status: 200 } : r);
        if (!r.ok && r.status === 401) aoSessaoEncerrada();
        return;
      }
      incompleta = r.dados.completa === false;
      imagens = lida;
      opcoesNos = lida.map(construirOpcao);
      renderLista();
      if (incompleta && r.dados.falha && r.dados.falha.status === 401) aoSessaoEncerrada();
    }

    // ── abrir, fechar, escolher ──
    function selecionar(referencia) {
      rascunho = { origem: referencia.origem, id: referencia.id };
      atualizarSelecao();
      ajustarTabindex(achar(rascunho).no);
    }

    function referenciaDe(no) {
      return { origem: no.getAttribute('data-imagem-origem'), id: no.getAttribute('data-imagem-id') };
    }

    function mover(visiveis, k) {
      if (visiveis.length === 0) return;
      var destino = visiveis[Math.max(0, Math.min(visiveis.length - 1, k))];
      ajustarTabindex(destino);
      destino.focus();
    }

    function aoTeclarNaLista(ev) {
      var alvo = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[role="option"]') : null;
      var visiveis = opcoesVisiveis();
      var i = alvo === null ? -1 : visiveis.indexOf(alvo);
      if (ev.key === 'Enter' || ev.key === ' ') {
        if (alvo === null) return;
        ev.preventDefault();
        selecionar(referenciaDe(alvo));
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        mover(visiveis, i + 1);
      } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        mover(visiveis, i < 0 ? 0 : i - 1);
      } else if (ev.key === 'Home') {
        ev.preventDefault();
        mover(visiveis, 0);
      } else if (ev.key === 'End') {
        ev.preventDefault();
        mover(visiveis, visiveis.length - 1);
      }
    }

    function aoClicarNaLista(ev) {
      var alvo = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[role="option"]') : null;
      if (alvo === null) return;
      selecionar(referenciaDe(alvo));
      alvo.focus();
    }

    /** O foco fica dentro do pop-up, na vista que está aparecendo: Tab no último volta ao primeiro e Shift+Tab no primeiro vai ao último. */
    function prenderFoco(ev) {
      var tituloAtual = vista === 'ENVIO' ? m.envioTitulo : (vista === 'GESTAO' ? m.gestaoTitulo : m.titulo);
      var focaveis = Array.prototype.filter.call(m.dialogo.querySelectorAll('button, input, [role="option"]'), function (n) {
        return !n.disabled && n.getAttribute('tabindex') !== '-1' && n.closest('[hidden]') === null;
      });
      if (focaveis.length === 0) {
        ev.preventDefault();
        return;
      }
      var primeiro = focaveis[0];
      var ultimo = focaveis[focaveis.length - 1];
      var ativo = doc.activeElement;
      var dentro = ativo !== null && ativo !== undefined && m.dialogo.contains(ativo);
      if (ev.shiftKey && (ativo === primeiro || ativo === tituloAtual || !dentro)) {
        ev.preventDefault();
        ultimo.focus();
      } else if (!ev.shiftKey && (ativo === ultimo || !dentro)) {
        ev.preventDefault();
        primeiro.focus();
      }
    }

    function aoTeclarNoDocumento(ev) {
      if (!aberto) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        // Na vista de gerenciar, Esc cancela primeiro a edição do nome ou a confirmação da exclusão; só sem nada aberto fecha o pop-up.
        if (vista === 'GESTAO' && (gestaoRenomeando !== null || gestaoConfirmando !== null)) cancelarEdicaoGestao();
        else fechar(true, false);
      } else if (ev.key === 'Tab') {
        prenderFoco(ev);
      }
    }

    function mostrarAviso(texto) {
      m.aviso.textContent = texto;
      mostrar(m.aviso, texto !== '');
    }

    function mostrarVista() {
      mostrar(m.vistaBiblioteca, vista === 'BIBLIOTECA');
      mostrar(m.vistaEnvio, vista === 'ENVIO');
      mostrar(m.vistaGestao, vista === 'GESTAO');
      var prefixo = vista === 'ENVIO' ? 'imagemEnvio' : (vista === 'GESTAO' ? 'imagemGestao' : 'imagemModal');
      m.dialogo.setAttribute('aria-labelledby', prefixo + 'Titulo');
      m.dialogo.setAttribute('aria-describedby', prefixo + 'Descricao');
    }

    function atualizarAdicionar() {
      mostrar(m.adicionar, podeEnviar && envio() !== null);
    }

    function abrir() {
      if (aberto || !habilitado) return Promise.resolve();
      aberto = true;
      rascunho = escolhida === null ? null : { origem: escolhida.origem, id: escolhida.id };
      m.busca.value = '';
      aba = 'TODAS';
      atualizarAbas();
      vista = 'BIBLIOTECA';
      mostrarVista();
      mostrarAviso('');
      m.raiz.classList.add('open');
      m.raiz.setAttribute('aria-hidden', 'false');
      doc.body.classList.add('bi-sem-rolagem');
      doc.addEventListener('keydown', aoTeclarNoDocumento);
      m.titulo.focus();
      return carregar();
    }

    /** `forcar` fecha mesmo durante um envio ou uma operação de gerenciar (sessão encerrada, campo bloqueado); a pessoa não fecha no meio de um lote nem de uma operação. */
    function fechar(devolverFoco, forcar) {
      if (!aberto) return;
      if ((enviando || gestaoOcupada !== null) && forcar !== true) return;
      aberto = false;
      sequencia += 1; // uma consulta em andamento deixa de valer
      doc.removeEventListener('keydown', aoTeclarNoDocumento);
      if (listaDesatualizada) {
        // Entrou imagem nova na biblioteca: a lista guardada ficou velha e a próxima abertura a lê de novo.
        imagens = null;
        incompleta = false;
        listaDesatualizada = false;
      }
      descartarLote();
      sairDaGestao();
      vista = 'BIBLIOTECA';
      mostrarVista();
      m.raiz.classList.remove('open');
      m.raiz.setAttribute('aria-hidden', 'true');
      doc.body.classList.remove('bi-sem-rolagem');
      if (devolverFoco) campo.escolher.focus();
    }

    function confirmar() {
      if (m.confirmar.disabled) return;
      var item = achar(rascunho);
      if (item === null) return;
      escolhida = { origem: item.imagem.origem, id: item.imagem.id, versao: item.imagem.versao, nome: item.imagem.nome };
      previaIndisponivel = false;
      renderCampo();
      fechar(true, false);
    }

    function remover() {
      if (!habilitado) return;
      escolhida = null;
      previaIndisponivel = false;
      renderCampo();
      campo.escolher.focus();
    }

    // ── vista "Adicionar imagens": arquivos novos para a biblioteca da empresa ──
    function criarUrlDoObjeto(arquivo) {
      var u = global.URL;
      return u && typeof u.createObjectURL === 'function' ? u.createObjectURL(arquivo) : null;
    }

    function revogarUrl(url) {
      var u = global.URL;
      if (url !== null && u && typeof u.revokeObjectURL === 'function') u.revokeObjectURL(url);
    }

    /** Uma linha repete o conteúdo de outra ANTERIOR e aceita: ela não é enviada (o servidor reaproveitaria a primeira). Recalculada a cada vez. */
    function repetidaDe(linha) {
      if (linha.hash === null || linha.recusa !== null) return null;
      for (var i = 0; i < lote.length; i += 1) {
        var outra = lote[i];
        if (outra === linha) return null;
        if (outra.recusa === null && outra.hash === linha.hash) return outra;
      }
      return null;
    }

    function linhaEnviavel(linha) {
      var estado = linha.resultado ? linha.resultado.estado : null;
      return linha.recusa === null && repetidaDe(linha) === null && FINAIS_DO_ENVIO.indexOf(estado) === -1;
    }

    function atualizarEnvio() {
      var ferramentas = envio();
      var enviaveis = lote.filter(linhaEnviavel);
      var nomesValidos = ferramentas !== null && enviaveis.every(function (l) { return ferramentas.validarNome(l.nome).ok; });
      m.enviar.disabled = enviando || enviaveis.length === 0 || !nomesValidos;
      m.voltar.disabled = enviando;
      m.envioFechar.disabled = enviando;
      m.selecionarArquivos.disabled = enviando;
      m.arquivos.disabled = enviando;
      if (lote.length === 0) {
        m.envioResumo.textContent = TEXTOS.NENHUM_ARQUIVO;
        return;
      }
      if (enviando) {
        m.envioResumo.textContent = TEXTOS.ENVIANDO;
        return;
      }
      var criadas = lote.filter(function (l) { return l.resultado && l.resultado.estado === 'CRIADA'; }).length;
      var existentes = lote.filter(function (l) { return l.resultado && l.resultado.estado === 'REAPROVEITADA'; }).length;
      var repetidas = lote.filter(function (l) { return repetidaDe(l) !== null; }).length;
      var recusadas = lote.filter(function (l) { return l.recusa !== null || (l.resultado && l.resultado.estado === 'RECUSADA'); }).length;
      var partes = [enviaveis.length + ' pronta(s) para adicionar'];
      if (criadas > 0) partes.push(criadas + ' adicionada(s)');
      if (existentes > 0) partes.push(existentes + ' já existente(s)');
      if (repetidas > 0) partes.push(repetidas + ' reaproveitada(s)');
      if (recusadas > 0) partes.push(recusadas + ' recusada(s)');
      m.envioResumo.textContent = partes.join(' · ') + '.';
    }

    function rotuloDoEstado(linha, repetida) {
      var estado = linha.resultado ? linha.resultado.estado : null;
      if (linha.recusa !== null) return { texto: 'Recusada', icone: 'error', classe: 'erro' };
      if (estado === 'ENVIANDO') return { texto: 'Enviando…', icone: 'cloud_upload', classe: 'aviso' };
      if (estado === 'CRIADA') return { texto: 'Adicionada', icone: 'check_circle', classe: 'ok' };
      if (estado === 'REAPROVEITADA') return { texto: 'Já existia na biblioteca', icone: 'content_copy', classe: 'aviso' };
      if (estado === 'RECUSADA') return { texto: 'Recusada', icone: 'error', classe: 'erro' };
      if (estado === 'INCERTA') return { texto: 'Resultado incerto', icone: 'help', classe: 'aviso' };
      if (estado === 'PENDENTE') return { texto: 'Aguardando envio', icone: 'schedule', classe: 'aviso' };
      if (repetida !== null) return { texto: 'Reaproveitada', icone: 'content_copy', classe: 'aviso' };
      return { texto: 'Pronta', icone: 'check_circle', classe: 'ok' };
    }

    function construirLinha(linha, indice) {
      var ferramentas = envio();
      var repetida = repetidaDe(linha);
      var resultado = linha.resultado;
      var estado = resultado ? resultado.estado : null;
      var recusada = linha.recusa !== null || estado === 'RECUSADA';
      var rotulo = rotuloDoEstado(linha, repetida);
      var li = criar(doc, 'li', { class: 'bi-arquivo' + (recusada ? ' recusado' : '') });
      var mini = criar(doc, 'div', { class: 'bi-arquivo-mini' });
      if (linha.url !== null) {
        var previa = criar(doc, 'img', { alt: '', src: linha.url });
        previa.addEventListener('error', function () {
          if (previa.parentNode === mini) mini.replaceChildren(icone(doc, 'broken_image'));
        });
        mini.appendChild(previa);
      } else {
        mini.appendChild(icone(doc, 'broken_image'));
      }
      var remover = criar(doc, 'button', { type: 'button', class: 'bi-arquivo-remover', 'aria-label': 'Tirar ' + linha.arquivo.name + ' da lista' }, [TEXTOS.TIRAR_DA_LISTA]);
      remover.disabled = enviando;
      remover.addEventListener('click', function () { removerLinha(linha); });
      var informacoes = [criar(doc, 'span', { class: 'bi-estado ' + rotulo.classe }, [icone(doc, rotulo.icone), rotulo.texto])];
      if (linha.dim) informacoes.push(criar(doc, 'span', {}, [linha.dim.largura + '×' + linha.dim.altura + ' px']));
      informacoes.push(criar(doc, 'span', {}, [tamanhoLegivel(linha.arquivo.size)]));
      informacoes.push(remover);
      var dados = criar(doc, 'div', { class: 'bi-arquivo-dados' }, [criar(doc, 'div', { class: 'bi-arquivo-linha' }, informacoes)]);
      if (linha.recusa !== null) {
        dados.appendChild(criar(doc, 'div', { class: 'bi-erro-campo' }, [linha.recusa]));
      } else {
        var erroDoNome = criar(doc, 'div', { class: 'bi-erro-campo', role: 'alert' });
        var nome = criar(doc, 'input', {
          class: 'input', type: 'text', maxlength: String(ferramentas.LIMITES.nomeMax), 'aria-label': 'Nome da imagem ' + (indice + 1), autocomplete: 'off', value: linha.nome,
        });
        nome.value = linha.nome;
        nome.disabled = enviando || FINAIS_DO_ENVIO.indexOf(estado) !== -1;
        nome.addEventListener('input', function () {
          linha.nome = nome.value;
          erroDoNome.textContent = ferramentas.validarNome(linha.nome).ok ? '' : ferramentas.mensagens.deNome();
          atualizarEnvio();
        });
        dados.appendChild(nome);
        dados.appendChild(erroDoNome);
        // O aviso do lote já diz o que a linha diria (parada por limite, ocupação, cota, rede…): não se repete o mesmo texto duas vezes.
        var jaNoAviso = resultado && resultado.mensagem && m.envioMensagem.textContent.indexOf(resultado.mensagem) !== -1;
        if (resultado && resultado.mensagem && !jaNoAviso) dados.appendChild(criar(doc, 'div', { class: estado === 'RECUSADA' ? 'bi-erro-campo' : 'bi-arquivo-linha' }, [resultado.mensagem]));
        if (resultado && estado === 'REAPROVEITADA' && resultado.imagem && typeof resultado.imagem.nome === 'string') {
          dados.appendChild(criar(doc, 'div', { class: 'bi-arquivo-linha' }, ['Já existe na biblioteca como “' + resultado.imagem.nome + '”.']));
        }
        if (repetida !== null && estado === null) {
          dados.appendChild(criar(doc, 'div', { class: 'bi-arquivo-linha' }, ['Mesma imagem de “' + repetida.nome + '”: será reaproveitada, não duplicada.']));
        }
      }
      li.appendChild(mini);
      li.appendChild(dados);
      return li;
    }

    function renderLote() {
      m.envioLista.replaceChildren();
      lote.forEach(function (linha, indice) { m.envioLista.appendChild(construirLinha(linha, indice)); });
      atualizarEnvio();
    }

    function removerLinha(linha) {
      if (enviando) return;
      var posicao = lote.indexOf(linha);
      if (posicao === -1) return;
      revogarUrl(linha.url);
      lote.splice(posicao, 1);
      renderLote();
      m.selecionarArquivos.focus();
    }

    /** Desfaz o lote inteiro: libera as miniaturas locais, esquece as linhas e invalida qualquer leitura ou envio em andamento. */
    function descartarLote() {
      geracaoLote += 1;
      emLeitura = 0;
      lote.forEach(function (linha) { revogarUrl(linha.url); });
      lote = [];
      enviando = false;
      m.envioMensagem.textContent = '';
      m.arquivos.value = '';
      m.envioLista.replaceChildren();
      atualizarEnvio();
    }

    async function lerArquivos(arquivos, geracao) {
      var ferramentas = envio();
      for (var i = 0; i < arquivos.length; i += 1) {
        var arquivo = arquivos[i];
        var linha = { id: proximaLinha, arquivo: arquivo, url: null, nome: '', recusa: null, hash: null, dim: null, resultado: null };
        proximaLinha += 1;
        var validacao = null;
        try { validacao = ferramentas.validarArquivo(arquivo); } catch (erro) { validacao = { ok: false, codigo: 'ARQUIVO_INVALIDO' }; }
        if (validacao.ok) {
          linha.nome = ferramentas.nomePadraoDoArquivo(arquivo.name);
          linha.url = criarUrlDoObjeto(arquivo);
          var medidas = await ferramentas.medirDimensoes(arquivo);
          if (medidas !== null) {
            var dimensoes = ferramentas.validarDimensoes(medidas);
            if (dimensoes.ok) linha.dim = medidas;
            else linha.recusa = ferramentas.mensagens.deArquivo(dimensoes.codigo);
          }
          if (linha.recusa === null) linha.hash = await ferramentas.resumoSha256(arquivo);
        } else {
          linha.recusa = ferramentas.mensagens.deArquivo(validacao.codigo);
        }
        if (geracao !== geracaoLote) {
          revogarUrl(linha.url);
          return;
        }
        emLeitura -= 1;
        lote.push(linha);
        renderLote();
      }
    }

    function aoEscolherArquivos() {
      var ferramentas = envio();
      var recebidos = Array.prototype.slice.call(m.arquivos.files || []);
      m.arquivos.value = ''; // permite escolher o mesmo arquivo de novo
      if (ferramentas === null || enviando || recebidos.length === 0) return undefined;
      var vagas = ferramentas.LIMITES.loteMax - lote.length - emLeitura;
      m.envioMensagem.textContent = '';
      if (recebidos.length > vagas) {
        m.envioMensagem.textContent = 'O limite é de ' + ferramentas.LIMITES.loteMax + ' imagens por vez; as que passaram do limite foram ignoradas.';
        recebidos = recebidos.slice(0, Math.max(vagas, 0));
      }
      if (recebidos.length === 0) return undefined;
      emLeitura += recebidos.length;
      var geracao = geracaoLote;
      fila = fila.then(function () { return lerArquivos(recebidos, geracao); }).catch(function () {
        // Um erro inesperado na leitura não pode travar as escolhas seguintes nem deixar vagas contadas à toa.
        if (geracao !== geracaoLote) return;
        emLeitura = 0;
        m.envioMensagem.textContent = TEXTOS.ERRO_LEITURA;
      });
      return fila;
    }

    function textoDoResultado() {
      var criadas = lote.filter(function (l) { return l.resultado && l.resultado.estado === 'CRIADA'; }).length;
      var existentes = lote.filter(function (l) { return l.resultado && l.resultado.estado === 'REAPROVEITADA'; }).length;
      var repetidas = lote.filter(function (l) { return repetidaDe(l) !== null; }).length;
      var partes = [];
      if (criadas > 0) partes.push(plural(criadas, 'imagem adicionada', 'imagens adicionadas') + ' à biblioteca da empresa.');
      if (existentes > 0) partes.push(existentes === 1 ? '1 já existia na biblioteca e foi reaproveitada.' : existentes + ' já existiam na biblioteca e foram reaproveitadas.');
      if (repetidas > 0) partes.push(repetidas === 1 ? '1 repetida no lote foi reaproveitada, não duplicada.' : repetidas + ' repetidas no lote foram reaproveitadas, não duplicadas.');
      return partes.join(' ');
    }

    function abrirEnvio() {
      if (!aberto || !podeEnviar || envio() === null || vista === 'ENVIO') return;
      vista = 'ENVIO';
      mostrarAviso('');
      mostrarVista();
      atualizarEnvio();
      m.envioTitulo.focus();
    }

    function voltarBiblioteca() {
      if (enviando || vista !== 'ENVIO') return undefined;
      var recarregar = listaDesatualizada;
      var texto = recarregar ? textoDoResultado() : '';
      descartarLote();
      listaDesatualizada = false;
      vista = 'BIBLIOTECA';
      mostrarVista();
      mostrarAviso(texto);
      m.adicionar.focus();
      if (!recarregar) {
        renderLista();
        return undefined;
      }
      imagens = null;
      incompleta = false;
      return carregar();
    }

    /** Tudo o que podia ser enviado foi aceito (criado ou reaproveitado): sem recusa do servidor, sem resultado incerto e sem pendência. */
    function loteConcluido() {
      var aceitas = 0;
      var abertas = lote.some(function (l) {
        var estado = l.resultado ? l.resultado.estado : null;
        if (estado === 'CRIADA' || estado === 'REAPROVEITADA') aceitas += 1;
        return estado === 'RECUSADA' || estado === 'INCERTA' || estado === 'PENDENTE' || estado === 'ENVIANDO' || linhaEnviavel(l);
      });
      return !abertas && aceitas > 0;
    }

    async function concluirEnvio() {
      var texto = textoDoResultado();
      descartarLote();
      listaDesatualizada = false;
      vista = 'BIBLIOTECA';
      aba = 'EMPRESA';
      mostrarVista();
      atualizarAbas();
      mostrarAviso(texto);
      imagens = null;
      incompleta = false;
      m.titulo.focus();
      await carregar();
    }

    async function enviarLote() {
      var ferramentas = envio();
      if (enviando || vista !== 'ENVIO' || ferramentas === null) return;
      var enviaveis = lote.filter(linhaEnviavel);
      if (enviaveis.length === 0 || !enviaveis.every(function (l) { return ferramentas.validarNome(l.nome).ok; })) return;
      enviando = true; // antes de qualquer espera: um segundo clique não passa
      var geracao = geracaoLote;
      m.envioMensagem.textContent = '';
      enviaveis.forEach(function (l) { l.resultado = { estado: 'PENDENTE', mensagem: null }; });
      renderLote();
      var itens = enviaveis.map(function (l) { return { arquivo: l.arquivo, nome: l.nome }; });
      var andamento = null;
      try {
        andamento = await ferramentas.enviarLote(itens, {
          aoMudar: function (indice, estado) {
            if (geracao !== geracaoLote) return;
            enviaveis[indice].resultado = estado;
            renderLote();
          },
        });
      } catch (falha) {
        if (geracao !== geracaoLote) return;
        enviaveis.forEach(function (l) {
          if (l.resultado && (l.resultado.estado === 'ENVIANDO' || l.resultado.estado === 'PENDENTE')) l.resultado = null;
        });
        enviando = false;
        m.envioMensagem.textContent = TEXTOS.ERRO_ENVIO;
        renderLote();
        return;
      }
      if (geracao !== geracaoLote) return;
      enviando = false;
      andamento.itens.forEach(function (resultado, i) {
        enviaveis[i].resultado = resultado;
        if (resultado.estado === 'CRIADA' || resultado.estado === 'REAPROVEITADA') listaDesatualizada = true;
      });
      if (andamento.interrompido !== null) m.envioMensagem.textContent = ferramentas.mensagens.deInterrupcao(andamento.interrompido, andamento.esperaSegundos);
      renderLote();
      if (andamento.interrompido === 'SESSAO') {
        aoSessaoEncerrada();
        return;
      }
      if (loteConcluido()) await concluirEnvio();
    }

    // ── vista "Gerenciar": renomear, inativar, reativar e excluir as imagens da EMPRESA (5C-8b) ──

    /** O botão "Gerenciar imagens" só existe no DOM com materials.editar e só aparece na aba "Minha Empresa". */
    function atualizarGerenciar() {
      if (podeGerenciar && m.gerenciar === null) {
        m.gerenciar = criar(doc, 'button', { id: 'botaoImagemGerenciar', class: 'outlined-btn', type: 'button' }, [icone(doc, 'tune'), TEXTOS.GERENCIAR]);
        m.gerenciar.addEventListener('click', abrirGestao);
        m.barra.appendChild(m.gerenciar);
      } else if (!podeGerenciar && m.gerenciar !== null) {
        if (m.gerenciar.parentNode) m.gerenciar.parentNode.removeChild(m.gerenciar);
        m.gerenciar = null;
      }
      if (m.gerenciar !== null) mostrar(m.gerenciar, aba === 'EMPRESA');
    }

    function usoTexto(n) {
      return n === 1 ? 'Em uso por 1 material' : 'Em uso por ' + n + ' materiais';
    }

    /** A imagem escolhida no formulário e ainda não salva não é vínculo no banco: só avisamos, nunca bloqueamos nem apagamos a escolha. */
    function daEscolhaPendente(imagem) {
      return escolhida !== null && escolhida.origem === 'EMPRESA' && escolhida.id === imagem.id;
    }

    function mostrarAvisoGestao(texto, tipo) {
      m.gestaoAviso.textContent = texto;
      m.gestaoAviso.setAttribute('class', 'bi-aviso-lote' + (tipo === 'erro' ? ' bi-aviso-erro' : ''));
      mostrar(m.gestaoAviso, texto !== '');
    }

    function acharImagemGestao(id) {
      if (gestaoImagens === null) return null;
      for (var i = 0; i < gestaoImagens.length; i += 1) if (gestaoImagens[i].id === id) return gestaoImagens[i];
      return null;
    }

    function visiveisDaGestao() {
      return gestaoImagens === null ? [] : gestaoImagens.filter(function (i) { return gestaoMostrarInativas || i.estado === 'ATIVA'; });
    }

    /** A ordem da lista: nome e, no empate, id (decimal canônico: mais curto primeiro). */
    function compararImagens(a, b) {
      var porNome = a.nome.localeCompare(b.nome, 'pt-BR');
      if (porNome !== 0) return porNome;
      return a.id.length !== b.id.length ? a.id.length - b.id.length : (a.id < b.id ? -1 : 1);
    }

    /** Só entra o que tem o formato do contrato (origem EMPRESA, id, versão, nome e estado); `emUso` ausente ou inválido fica nulo: a tela não inventa. */
    function validarGestao(dados) {
      if (!dados || !Array.isArray(dados.imagens)) return null;
      var saida = [];
      dados.imagens.forEach(function (i) {
        if (!i || i.origem !== 'EMPRESA' || typeof i.nome !== 'string' || i.nome.trim() === '') return;
        if (i.estado !== 'ATIVA' && i.estado !== 'INATIVA') return;
        try { validar({ origem: 'EMPRESA', id: i.id, versao: i.versao }); } catch (erro) { return; }
        saida.push({ id: i.id, versao: i.versao, nome: i.nome, estado: i.estado, emUso: typeof i.emUso === 'number' && Number.isInteger(i.emUso) && i.emUso >= 0 ? i.emUso : null });
      });
      return saida;
    }

    function acharBotaoGestao(id, acao) {
      var linhas = Array.prototype.slice.call(m.gestaoLista.children);
      for (var i = 0; i < linhas.length; i += 1) {
        if (linhas[i].getAttribute('data-imagem-id') !== id) continue;
        var controles = Array.prototype.slice.call(linhas[i].querySelectorAll('button, input'));
        for (var j = 0; j < controles.length; j += 1) if (controles[j].getAttribute('data-acao') === acao) return controles[j];
      }
      return null;
    }

    /** O foco devolvido a quem agiu: o primeiro candidato que existe e está habilitado; se nenhum, o título da vista (nunca se perde no <body>). */
    function restaurarFocoGestao(candidatos) {
      if (!candidatos) return;
      for (var i = 0; i < candidatos.length; i += 1) {
        var alvo = acharBotaoGestao(candidatos[i].id, candidatos[i].acao);
        if (alvo !== null && !alvo.disabled) {
          alvo.focus();
          return;
        }
      }
      m.gestaoTitulo.focus();
    }

    /** Candidatos de foco para quando a linha some ou muda de lugar: a própria linha, depois a seguinte e a anterior. */
    function candidatosDeFoco(id, acao) {
      var visiveis = visiveisDaGestao();
      var indice = -1;
      visiveis.forEach(function (i, k) { if (i.id === id) indice = k; });
      var lista = [{ id: id, acao: acao }];
      if (indice >= 0 && indice + 1 < visiveis.length) lista.push({ id: visiveis[indice + 1].id, acao: 'RENOMEAR' });
      if (indice > 0) lista.push({ id: visiveis[indice - 1].id, acao: 'RENOMEAR' });
      return lista;
    }

    function criarBotaoGestao(imagem, acao, texto, classe, aoClicar, motivo) {
      var travado = gestaoOcupada !== null || gestaoCarregando;
      var botao = criar(doc, 'button', { type: 'button', class: classe, 'data-acao': acao, 'aria-label': texto + ' ' + imagem.nome + (motivo ? ' (indisponível: ' + motivo + ')' : '') }, [texto]);
      botao.disabled = travado || !!motivo;
      if (motivo) botao.setAttribute('title', motivo);
      botao.addEventListener('click', aoClicar);
      return botao;
    }

    function construirLinhaGestao(imagem) {
      var aqui = gestaoOcupada !== null && gestaoOcupada.id === imagem.id;
      var inativa = imagem.estado === 'INATIVA';
      var usada = imagem.emUso !== null && imagem.emUso > 0;
      var renomeando = gestaoRenomeando === imagem.id;
      var confirmando = gestaoConfirmando === imagem.id;
      var travado = gestaoOcupada !== null || gestaoCarregando;
      var motivoDeUso = usada ? usoTexto(imagem.emUso) + '; tire a imagem dos materiais antes de ' : '';

      var img = criar(doc, 'img', { alt: '', src: urlMiniatura({ origem: 'EMPRESA', id: imagem.id, versao: imagem.versao }, base) });
      var mini = criar(doc, 'div', { class: 'bi-gestao-mini' }, [img]);
      img.addEventListener('error', function () {
        if (img.parentNode === mini) mini.replaceChildren(quadro(doc, 'bi-previa-falha', 'image_not_supported', TEXTOS.IMAGEM_INDISPONIVEL));
      });
      var corpo = criar(doc, 'div', { class: 'bi-gestao-corpo' });

      if (renomeando) {
        var erroNome = criar(doc, 'div', { class: 'bi-erro-campo', role: 'alert' }, [gestaoErroNome]);
        var campoNome = criar(doc, 'input', {
          class: 'input', type: 'text', maxlength: String(NOME_MAXIMO), 'aria-label': 'Novo nome da imagem ' + imagem.nome, autocomplete: 'off', 'data-acao': 'NOME',
        });
        campoNome.value = gestaoValor;
        campoNome.disabled = travado;
        campoNome.addEventListener('input', function () {
          gestaoValor = campoNome.value;
          if (gestaoErroNome !== '') {
            gestaoErroNome = '';
            erroNome.textContent = '';
          }
        });
        campoNome.addEventListener('keydown', function (ev) {
          if (ev.key !== 'Enter') return;
          ev.preventDefault();
          salvarNome(imagem.id);
        });
        corpo.appendChild(campoNome);
        corpo.appendChild(erroNome);
      } else {
        corpo.appendChild(criar(doc, 'div', { class: 'bi-gestao-nome', title: imagem.nome }, [imagem.nome]));
      }

      var meta = criar(doc, 'div', { class: 'bi-gestao-meta' }, [criar(doc, 'span', { class: 'bi-selo ' + (inativa ? 'inativa' : 'ativa') }, [inativa ? TEXTOS.ESTADO_INATIVA : TEXTOS.ESTADO_ATIVA])]);
      if (imagem.emUso !== null) meta.appendChild(criar(doc, 'span', {}, [usada ? usoTexto(imagem.emUso) : TEXTOS.SEM_USO]));
      if (daEscolhaPendente(imagem)) meta.appendChild(criar(doc, 'span', { class: 'bi-etiqueta' }, [TEXTOS.NO_FORMULARIO]));
      corpo.appendChild(meta);

      if (aqui) {
        var rotulos = { RENOMEAR: 'Renomeando…', INATIVAR: 'Inativando…', REATIVAR: 'Reativando…', EXCLUIR: 'Excluindo…' };
        corpo.appendChild(criar(doc, 'div', { class: 'bi-gestao-acoes' }, [criar(doc, 'span', { class: 'bi-estado aviso', role: 'status' }, [icone(doc, 'hourglass_top'), rotulos[gestaoOcupada.tipo]])]));
      } else if (confirmando) {
        var nomeEntreAspas = '“' + imagem.nome + '”';
        var painel = criar(doc, 'div', { class: 'bi-gestao-confirma', role: 'group', 'aria-label': 'Confirmar a exclusão de ' + imagem.nome }, [
          criar(doc, 'p', { class: 'bi-gestao-confirma-titulo' }, ['Excluir ' + nomeEntreAspas + '?']),
          criar(doc, 'p', {}, [TEXTOS.CONFIRMA_EXCLUSAO]),
        ]);
        if (daEscolhaPendente(imagem)) painel.appendChild(criar(doc, 'p', { class: 'bi-gestao-dica' }, [TEXTOS.AVISO_NO_FORMULARIO]));
        var excluirImagem = criar(doc, 'button', { type: 'button', class: 'filled-btn bi-perigo', 'data-acao': 'CONFIRMAR_EXCLUSAO' }, [TEXTOS.EXCLUIR_IMAGEM]);
        excluirImagem.disabled = travado;
        excluirImagem.addEventListener('click', function () { executarGestao('EXCLUIR', imagem); });
        var cancelarExclusao = criar(doc, 'button', { type: 'button', class: 'outlined-btn', 'data-acao': 'CANCELAR_EXCLUSAO' }, [TEXTOS.CANCELAR]);
        cancelarExclusao.disabled = travado;
        cancelarExclusao.addEventListener('click', cancelarEdicaoGestao);
        painel.appendChild(criar(doc, 'div', { class: 'bi-gestao-acoes' }, [excluirImagem, cancelarExclusao]));
        corpo.appendChild(painel);
      } else if (renomeando) {
        var salvar = criar(doc, 'button', { type: 'button', class: 'filled-btn', 'data-acao': 'SALVAR_NOME' }, [TEXTOS.SALVAR_NOME]);
        salvar.disabled = travado;
        salvar.addEventListener('click', function () { salvarNome(imagem.id); });
        var cancelarNome = criar(doc, 'button', { type: 'button', class: 'outlined-btn', 'data-acao': 'CANCELAR_NOME' }, [TEXTOS.CANCELAR]);
        cancelarNome.disabled = travado;
        cancelarNome.addEventListener('click', cancelarEdicaoGestao);
        corpo.appendChild(criar(doc, 'div', { class: 'bi-gestao-acoes' }, [salvar, cancelarNome]));
      } else {
        corpo.appendChild(criar(doc, 'div', { class: 'bi-gestao-acoes' }, [
          criarBotaoGestao(imagem, 'RENOMEAR', TEXTOS.RENOMEAR, 'outlined-btn', function () { iniciarRenomear(imagem); }, ''),
          inativa
            ? criarBotaoGestao(imagem, 'REATIVAR', TEXTOS.REATIVAR, 'outlined-btn', function () { executarGestao('REATIVAR', imagem); }, '')
            : criarBotaoGestao(imagem, 'INATIVAR', TEXTOS.INATIVAR, 'outlined-btn', function () { executarGestao('INATIVAR', imagem); }, motivoDeUso && motivoDeUso + 'inativar.'),
          criarBotaoGestao(imagem, 'EXCLUIR', TEXTOS.EXCLUIR, 'outlined-btn bi-perigo-texto', function () { pedirExclusao(imagem); }, motivoDeUso && motivoDeUso + 'excluir.'),
        ]));
      }

      var linha = criar(doc, 'li', { class: 'bi-gestao-item' + (inativa ? ' inativa' : ''), 'data-imagem-origem': 'EMPRESA', 'data-imagem-id': imagem.id }, [mini, corpo]);
      if (aqui) linha.setAttribute('aria-busy', 'true');
      return linha;
    }

    /** Desenha a lista inteira de novo a partir do estado (nós e texto); `foco` = candidatos a receber o foco depois (ver `candidatosDeFoco`). */
    function renderGestao(foco) {
      if (foco) gestaoFocoPendente = foco;
      if (gestaoRenomeando !== null && acharImagemGestao(gestaoRenomeando) === null) gestaoRenomeando = null;
      if (gestaoConfirmando !== null && acharImagemGestao(gestaoConfirmando) === null) gestaoConfirmando = null;
      var travado = gestaoOcupada !== null || gestaoCarregando;
      m.gestaoLista.replaceChildren();
      m.gestaoLista.setAttribute('aria-busy', travado ? 'true' : 'false');
      m.gestaoInativas.disabled = gestaoOcupada !== null;
      m.gestaoAtualizar.disabled = travado;
      m.gestaoConcluir.disabled = gestaoOcupada !== null;
      m.gestaoFechar.disabled = gestaoOcupada !== null;
      if (gestaoImagens === null) {
        m.gestaoContagem.textContent = '';
        m.gestaoEstado.textContent = gestaoCarregando ? TEXTOS.GESTAO_CARREGANDO : gestaoFalha;
        return;
      }
      var ativas = gestaoImagens.filter(function (i) { return i.estado === 'ATIVA'; }).length;
      var inativas = gestaoImagens.length - ativas;
      m.gestaoContagem.textContent = plural(ativas, 'imagem ativa', 'imagens ativas') + ' · ' + plural(inativas, 'inativa', 'inativas')
        + (inativas > 0 && !gestaoMostrarInativas ? ' (' + (inativas === 1 ? 'oculta' : 'ocultas') + ')' : '');
      var visiveis = visiveisDaGestao();
      if (gestaoFalha !== '') m.gestaoEstado.textContent = gestaoFalha;
      else if (gestaoCarregando) m.gestaoEstado.textContent = TEXTOS.GESTAO_CARREGANDO;
      else if (gestaoImagens.length === 0) m.gestaoEstado.textContent = TEXTOS.GESTAO_VAZIA;
      else if (visiveis.length === 0) m.gestaoEstado.textContent = TEXTOS.GESTAO_SO_INATIVAS;
      else m.gestaoEstado.textContent = gestaoIncompleta ? TEXTOS.GESTAO_INCOMPLETA : '';
      visiveis.forEach(function (imagem) { m.gestaoLista.appendChild(construirLinhaGestao(imagem)); });
      if (gestaoFocoPendente !== null && !travado) {
        var candidatos = gestaoFocoPendente;
        gestaoFocoPendente = null;
        restaurarFocoGestao(candidatos);
      }
    }

    /** Lê TODAS as imagens da empresa (ativas e inativas, página por página). Uma leitura antiga nunca escreve na tela; a que falha mantém o que já havia. */
    async function carregarGestao() {
      gestaoLeitura += 1;
      var minha = gestaoLeitura;
      gestaoCarregando = true;
      gestaoFalha = '';
      renderGestao();
      var r = await acoes.listarTodas({ origem: 'EMPRESA', estado: 'TODAS' });
      if (minha !== gestaoLeitura || !aberto || vista !== 'GESTAO') return;
      gestaoCarregando = false;
      var lida = r.ok ? validarGestao(r.dados) : null;
      if (lida === null) {
        gestaoFalha = deLista(r.ok ? { status: 200 } : r);
        renderGestao();
        if (!r.ok && r.status === 401) aoSessaoEncerrada();
        return;
      }
      gestaoImagens = lida;
      gestaoIncompleta = r.dados.completa === false;
      renderGestao();
      if (gestaoIncompleta && r.dados.falha && r.dados.falha.status === 401) aoSessaoEncerrada();
    }

    /** Volta ao estado de partida da vista: nada de uma visita anterior (lista, edição, confirmação, operação) sobra, e respostas antigas deixam de valer. */
    function sairDaGestao() {
      gestaoGeracao += 1;
      gestaoLeitura += 1;
      gestaoImagens = null;
      gestaoCarregando = false;
      gestaoFalha = '';
      gestaoIncompleta = false;
      gestaoMostrarInativas = false;
      m.gestaoInativas.checked = false;
      gestaoOcupada = null;
      gestaoRenomeando = null;
      gestaoValor = '';
      gestaoErroNome = '';
      gestaoConfirmando = null;
      gestaoFocoPendente = null;
      m.gestaoLista.replaceChildren();
      m.gestaoContagem.textContent = '';
      m.gestaoEstado.textContent = '';
      mostrarAvisoGestao('', 'ok');
    }

    function abrirGestao() {
      if (!aberto || !podeGerenciar || vista !== 'BIBLIOTECA' || aba !== 'EMPRESA' || enviando) return undefined;
      sairDaGestao();
      vista = 'GESTAO';
      mostrarAviso('');
      mostrarVista();
      m.gestaoTitulo.focus();
      return carregarGestao();
    }

    /** "Concluir": volta à biblioteca (aba Minha Empresa); se algo foi alterado, a lista do seletor é lida de novo. */
    function voltarDaGestao() {
      if (vista !== 'GESTAO' || gestaoOcupada !== null) return undefined;
      sairDaGestao();
      vista = 'BIBLIOTECA';
      mostrarVista();
      mostrarAviso('');
      if (m.gerenciar !== null) m.gerenciar.focus();
      if (!listaDesatualizada) {
        renderLista();
        return undefined;
      }
      listaDesatualizada = false;
      imagens = null;
      incompleta = false;
      return carregar();
    }

    function iniciarRenomear(imagem) {
      if (gestaoOcupada !== null || gestaoCarregando || vista !== 'GESTAO') return;
      gestaoRenomeando = imagem.id;
      gestaoConfirmando = null;
      gestaoValor = imagem.nome;
      gestaoErroNome = '';
      renderGestao([{ id: imagem.id, acao: 'NOME' }]);
      var campoNome = acharBotaoGestao(imagem.id, 'NOME');
      if (campoNome !== null && typeof campoNome.select === 'function') campoNome.select();
    }

    /** Esc ou "Cancelar" na edição do nome ou na confirmação da exclusão: fecha só isso, nunca o pop-up. */
    function cancelarEdicaoGestao() {
      if (gestaoOcupada !== null) return;
      var id = gestaoRenomeando !== null ? gestaoRenomeando : gestaoConfirmando;
      var acao = gestaoRenomeando !== null ? 'RENOMEAR' : 'EXCLUIR';
      gestaoRenomeando = null;
      gestaoConfirmando = null;
      gestaoErroNome = '';
      renderGestao(id === null ? null : [{ id: id, acao: acao }]);
    }

    function pedirExclusao(imagem) {
      if (gestaoOcupada !== null || gestaoCarregando || vista !== 'GESTAO') return;
      if (imagem.emUso !== null && imagem.emUso > 0) return; // o botão já está desabilitado; o servidor continua a autoridade (409)
      gestaoConfirmando = imagem.id;
      gestaoRenomeando = null;
      renderGestao([{ id: imagem.id, acao: 'CANCELAR_EXCLUSAO' }]);
    }

    function salvarNome(id) {
      if (gestaoOcupada !== null || gestaoCarregando || gestaoRenomeando !== id || vista !== 'GESTAO') return;
      var imagem = acharImagemGestao(id);
      if (imagem === null) return;
      var texto = null;
      try { texto = normalizarNomeDaImagem(gestaoValor); } catch (erro) { texto = null; }
      if (texto === null) {
        gestaoErroNome = TEXTOS.NOME_DA_GESTAO;
        renderGestao([{ id: id, acao: 'NOME' }]);
        return;
      }
      if (texto === imagem.nome) { // nome igual ao atual: nada vai ao servidor
        gestaoRenomeando = null;
        gestaoErroNome = '';
        mostrarAvisoGestao('O nome da imagem “' + imagem.nome + '” não foi alterado.', 'ok');
        renderGestao([{ id: id, acao: 'RENOMEAR' }]);
        return;
      }
      executarGestao('RENOMEAR', imagem, texto);
    }

    /** Posição certa de uma imagem renomeada na lista (mesma ordem da API), sem mexer na ordem das outras. */
    function reposicionar(imagem) {
      gestaoImagens = gestaoImagens.filter(function (i) { return i !== imagem; });
      var posicao = gestaoImagens.length;
      for (var k = 0; k < gestaoImagens.length; k += 1) {
        if (compararImagens(imagem, gestaoImagens[k]) < 0) {
          posicao = k;
          break;
        }
      }
      gestaoImagens.splice(posicao, 0, imagem);
    }

    function falhaDaOperacao(tipo, imagem, r) {
      if (r !== null && r.status === 401) {
        aoSessaoEncerrada();
        return;
      }
      var texto = r === null ? TEXTOS.GESTAO_GENERICO : deGerenciamento(r);
      var status = r === null ? 0 : r.status;
      var sumiu = r !== null && status === 404 && r.codigo === 'IMAGEM_NAO_ENCONTRADA';
      var conflito = r !== null && status === 409;
      // Resultado incerto (rede, 5xx diferente de 503) ou mudança vinda de outra sessão: a lista é lida de novo; a operação NUNCA é repetida sozinha.
      var reler = sumiu || conflito || status === 0 || (status >= 500 && status !== 503);
      var foco = candidatosDeFoco(imagem.id, tipo === 'RENOMEAR' && !sumiu ? 'NOME' : tipo);
      if (sumiu) {
        gestaoImagens = gestaoImagens.filter(function (i) { return i.id !== imagem.id; });
        if (gestaoRenomeando === imagem.id) gestaoRenomeando = null;
      }
      if (tipo === 'RENOMEAR' && !sumiu && status === 400) gestaoErroNome = TEXTOS.NOME_DA_GESTAO;
      mostrarAvisoGestao(texto, 'erro');
      if (reler) carregarGestao(); // a releitura trava a tela primeiro: o foco pendente espera ela destravar, em vez de se perder no redesenho
      renderGestao(foco);
    }

    function sucessoDaOperacao(tipo, imagem, r, pendente) {
      var dados = r.dados;
      // O foco é decidido ANTES de mudar a lista: a linha pode sumir (excluída, ou inativada com as inativas ocultas) e o foco passa à seguinte ou à anterior.
      var foco = candidatosDeFoco(imagem.id, tipo === 'INATIVAR' ? 'REATIVAR' : (tipo === 'REATIVAR' ? 'INATIVAR' : tipo));
      var texto;
      if (tipo === 'EXCLUIR') {
        if (!dados || dados.excluida !== true || dados.imagemId !== imagem.id) return false;
        gestaoImagens = gestaoImagens.filter(function (i) { return i.id !== imagem.id; });
        texto = 'A imagem “' + imagem.nome + '” foi excluída. A vaga voltou para a cota.';
      } else {
        var nova = dados && dados.imagem;
        if (!nova || nova.id !== imagem.id || typeof nova.nome !== 'string' || (nova.estado !== 'ATIVA' && nova.estado !== 'INATIVA') || typeof dados.alterado !== 'boolean') return false;
        var nomeAntes = imagem.nome;
        imagem.nome = nova.nome;
        imagem.estado = nova.estado;
        if (tipo === 'RENOMEAR') {
          reposicionar(imagem);
          if (pendente) {
            escolhida.nome = imagem.nome;
            renderCampo();
          }
          gestaoRenomeando = null;
          gestaoErroNome = '';
          foco = [{ id: imagem.id, acao: 'RENOMEAR' }];
          texto = dados.alterado ? 'A imagem “' + nomeAntes + '” agora se chama “' + imagem.nome + '”.' : 'O nome da imagem já era “' + imagem.nome + '”.';
        } else if (tipo === 'INATIVAR') {
          texto = dados.alterado ? 'A imagem “' + imagem.nome + '” foi inativada. Ela saiu do seletor, mas continua ocupando uma vaga da cota.' : 'A imagem “' + imagem.nome + '” já estava inativa.';
        } else {
          texto = dados.alterado ? 'A imagem “' + imagem.nome + '” foi reativada e voltou ao seletor.' : 'A imagem “' + imagem.nome + '” já estava ativa.';
        }
      }
      if (pendente && (tipo === 'EXCLUIR' || (tipo === 'INATIVAR' && imagem.estado === 'INATIVA'))) texto += ' ' + TEXTOS.AVISO_NO_FORMULARIO;
      mostrarAvisoGestao(texto, 'ok');
      renderGestao(foco);
      return true;
    }

    /**
     * Uma operação de gerenciar, de cada vez: a trava é armada antes de qualquer espera (o segundo clique não passa), tudo fica desabilitado até o resultado
     * e a vista não fecha no meio. Nada é repetido sozinho. Só a resposta do servidor muda a lista; o 409 IMAGEM_EM_USO e o 404 são tratados e a lista é relida.
     */
    async function executarGestao(tipo, imagem, valor) {
      if (gestaoOcupada !== null || gestaoCarregando || vista !== 'GESTAO') return;
      var geracao = gestaoGeracao;
      var pendente = daEscolhaPendente(imagem);
      gestaoOcupada = { id: imagem.id, tipo: tipo };
      gestaoConfirmando = null;
      listaDesatualizada = true; // mesmo que falhe: a próxima leitura do seletor é a verdade
      mostrarAvisoGestao('', 'ok');
      renderGestao();
      var r = null;
      try {
        if (tipo === 'RENOMEAR') r = await acoes.renomear(imagem.id, valor);
        else if (tipo === 'INATIVAR') r = await acoes.inativar(imagem.id);
        else if (tipo === 'REATIVAR') r = await acoes.reativar(imagem.id);
        else r = await acoes.excluir(imagem.id, { confirmado: true });
      } catch (falha) {
        r = null;
      }
      if (geracao !== gestaoGeracao) return;
      gestaoOcupada = null;
      if (r !== null && r.ok && sucessoDaOperacao(tipo, imagem, r, pendente)) return;
      // Falha, ou 200 fora do contrato (nesse caso o resultado é incerto: a lista é lida de novo).
      falhaDaOperacao(tipo, imagem, r !== null && r.ok ? null : r);
    }

    function habilitar(sim, permissoes) {
      habilitado = sim === true;
      podeEnviar = habilitado && !!permissoes && permissoes.enviar === true;
      podeGerenciar = habilitado && !!permissoes && permissoes.gerenciar === true;
      campo.escolher.disabled = !habilitado;
      campo.remover.disabled = !habilitado;
      if (!habilitado) fechar(false, true);
      atualizarAdicionar();
      atualizarGerenciar();
      if (aberto && vista === 'ENVIO' && !podeEnviar && !enviando) voltarBiblioteca();
      if (aberto && vista === 'GESTAO' && !podeGerenciar && gestaoOcupada === null) voltarDaGestao();
    }

    /** Desfaz a escolha e esquece a imagem gravada (formulário limpo, edição aberta ou fechada) sem mexer no foco. */
    function reiniciar() {
      fechar(false, true);
      escolhida = null;
      gravada = null;
      rascunho = null;
      previaIndisponivel = false;
      renderCampo();
    }

    /**
     * Edição de um material: parte do que o servidor já tem (`material.imagem`) e a mostra como escolha atual, seja da Biblioteca Padrão ou da
     * empresa. Sem imagem, ou com uma fora do formato do contrato, o campo começa vazio e a imagem existente não é enviada nem apagada.
     */
    function definirGravada(imagem) {
      reiniciar();
      var lida = lerGravada(imagem);
      if (lida === null) return;
      gravada = { origem: lida.origem, id: lida.id };
      escolhida = lida;
      renderCampo();
    }

    /**
     * O que entra no corpo do POST ou do PATCH de /materiais: `undefined` = a chave `imagem` não vai (nada mudou, ou o campo está bloqueado);
     * `null` = remover a imagem que o material tem; `{ origem, id }` = associar ou trocar. Só origem e id: o resto da imagem nunca é enviado.
     */
    function paraEnvio() {
      if (!habilitado || mesma(escolhida, gravada)) return undefined;
      return escolhida === null ? null : { origem: escolhida.origem, id: escolhida.id };
    }

    /** Sessão encerrada: fecha o seletor, descarta a lista e qualquer consulta em andamento. */
    function encerrar() {
      reiniciar();
      imagens = null;
      opcoesNos = [];
      sequencia += 1;
    }

    campo.escolher.addEventListener('click', function () { return abrir(); });
    campo.remover.addEventListener('click', remover);
    m.cancelar.addEventListener('click', function () { fechar(true, false); });
    m.fechar.addEventListener('click', function () { fechar(true, false); });
    m.envioFechar.addEventListener('click', function () { fechar(true, false); });
    m.confirmar.addEventListener('click', confirmar);
    m.busca.addEventListener('input', renderLista);
    m.lista.addEventListener('click', aoClicarNaLista);
    m.lista.addEventListener('keydown', aoTeclarNaLista);
    m.abas.forEach(function (botao) { botao.addEventListener('click', function () { trocarAba(botao.getAttribute('data-aba')); }); });
    m.adicionar.addEventListener('click', abrirEnvio);
    m.voltar.addEventListener('click', function () { return voltarBiblioteca(); });
    m.enviar.addEventListener('click', function () { return enviarLote(); });
    m.selecionarArquivos.addEventListener('click', function () { m.arquivos.click(); });
    m.arquivos.addEventListener('change', function () { return aoEscolherArquivos(); });
    m.gestaoInativas.addEventListener('change', function () {
      gestaoMostrarInativas = m.gestaoInativas.checked;
      renderGestao();
    });
    m.gestaoAtualizar.addEventListener('click', function () {
      if (gestaoOcupada === null && !gestaoCarregando) return carregarGestao();
      return undefined;
    });
    m.gestaoConcluir.addEventListener('click', function () { return voltarDaGestao(); });
    m.gestaoFechar.addEventListener('click', function () { fechar(true, false); });

    if (envio() !== null) m.arquivos.setAttribute('accept', envio().ACEITAS);
    atualizarAbas();
    mostrarVista();
    atualizarAdicionar();
    renderCampo();
    return {
      habilitar: habilitar, reiniciar: reiniciar, definirGravada: definirGravada, paraEnvio: paraEnvio, fechar: function () { fechar(false, false); }, encerrar: encerrar,
    };
  }

  global.EpiImagensMaterial = {
    LIMITE_LISTA: LIMITE_LISTA,
    caminhos: caminhos,
    urlMiniatura: urlMiniatura,
    acoes: acoes,
    mensagens: mensagens,
    montar: montar,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiImagensMaterial;
  }
}(typeof window !== 'undefined' ? window : globalThis));
