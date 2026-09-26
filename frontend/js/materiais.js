(function (global) {
  'use strict';

  /**
   * EpiMateriais — cadastro real de materiais e EPIs (Bloco 9, Etapa C,
   * Parte C2), sobre os contratos do Bloco 9, Etapa A:
   *
   *   GET  /materiais?ativo=&busca=&pagina=&limite=   (materials.visualizar)
   *   POST /materiais                                   (materials.criar)
   *   GET  /materiais/:id                               (materials.visualizar)
   *   PATCH /materiais/:id                              (materials.editar; melhoria da C2)
   *   GET  /materiais/:id/estoque                       (materials.visualizar)
   *   POST /materiais/:id/estoque/movimentar            (ação MOVIMENTAR_ESTOQUE)
   *
   * Mesmas camadas das telas HTTP do projeto (js/grupos-acesso.js):
   *   acoes      — fala com a API e devolve o envelope do EpiHttp.
   *   formulario — transforma o que a pessoa digitou no corpo que o
   *                contrato aceita (funções puras): prazo em dias, tipo
   *                "Outro", vazio → omitido, quantidade comprada → ENTRADA
   *                separada. Nunca inclui empresaId.
   *   mensagens  — traduz códigos do backend em texto (funções puras).
   *   grade      — saldos reais por tamanho → estado de cada chip.
   *   render     — HTML escapado.
   *   fluxo      — cadastro e entrada inicial, duas operações, na ordem.
   *
   * O BACKEND É A AUTORIDADE FINAL: `podeMovimentar` só evita uma chamada
   * que seria recusada; o servidor recusa com 403 de qualquer forma.
   */

  var CAMINHO = '/materiais';
  var MOTIVO_ENTRADA_INICIAL = 'Entrada inicial do cadastro';

  // Tetos dos contratos (schemas do backend / migrations 007, 008 e 039).
  // motivo: MOTIVO_MAXIMO do schema de movimentação de estoque (estoque.schema.js).
  var LIMITES = { nome: 150, tipo: 100, fabricante: 100, caNumero: 20, unidade: 20, categoria: 30, codigoInterno: 30, descricao: 500, tamanho: 20, motivo: 200 };
  // Teto das colunas INTEGER (int4) do PostgreSQL, o mesmo do backend
  // (LIMITES.INTEGER_MAXIMO): prazo em dias, estoque mínimo e quantidade.
  // Validado aqui para não iniciar um cadastro cuja entrada seria recusada.
  var INTEGER_MAXIMO = 2147483647;
  // Paginação do GET /materiais (LIMITE_MAXIMO do backend) e teto de páginas
  // que o seletor da grade percorre (10.000 materiais ativos por empresa).
  var LIMITE_LISTA = 100;
  var PAGINAS_MAXIMAS = 100;

  // 1 mês = 30 dias; 1 ano = 365 dias (decisão E1). A unidade não é persistida.
  var FATORES_PRAZO = { dias: 1, meses: 30, anos: 365 };
  var ROTULOS_PRAZO = { dias: ['dia', 'dias'], meses: ['mês', 'meses'], anos: ['ano', 'anos'] };

  // Os 17 chips da grade original, na mesma ordem.
  var TAMANHOS_GRADE = ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', 'Único', 'PP', 'P', 'M', 'G', 'GG'];
  var TAMANHOS_CALCADO = ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44'];
  var TAMANHOS_LUVA = ['PP', 'P', 'M', 'G', 'GG'];

  // Opções dos selects do formulário original (materials.html), na mesma
  // ordem. Usadas para reabrir um material sem trocar valores em silêncio.
  var CATEGORIAS = ['EPI', 'Uniforme', 'Ferramenta', 'Material de consumo'];
  var TIPOS = ['Sapatão / Botina', 'Óculos de proteção', 'Luva', 'Protetor auricular', 'Capacete', 'Respirador'];
  var UNIDADES = ['Par', 'Unidade', 'Caixa', 'Pacote', 'Kit'];
  // Campos que a edição pode enviar ao PATCH. A unidade de controle fica de
  // fora (decisão 3): mudar "par" para "unidade" mudaria o sentido do saldo.
  var CAMPOS_EDITAVEIS = ['nome', 'categoria', 'tipo', 'caNumero', 'caValidade', 'fabricante', 'codigoInterno', 'descricao', 'prazoUsoDias', 'estoqueMinimo'];

  var CLASSES_CHIP ={ 'sem-estoque': 'chip-empty', 'abaixo-minimo': 'chip-warning', 'com-saldo': 'chip-ok' };

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/materiais.js');
    }
    return cliente;
  }

  function hasOwn(obj, chave) { return Object.prototype.hasOwnProperty.call(obj, chave); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }
  function inteiro(v) {
    var s = texto(v);
    if (!/^-?\d+$/.test(s)) return null;
    var n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }

  // ───────────────────────────────────────────────────────────────────
  // Ações
  // ───────────────────────────────────────────────────────────────────

  var acoes = {
    listar: function (filtro) {
      var f = filtro || {};
      var q = [];
      if (typeof f.ativo === 'boolean') q.push('ativo=' + f.ativo);
      if (texto(f.busca)) q.push('busca=' + encodeURIComponent(texto(f.busca)));
      if (f.pagina) q.push('pagina=' + encodeURIComponent(f.pagina));
      if (f.limite) q.push('limite=' + encodeURIComponent(f.limite));
      return http().requisitar('GET', CAMINHO + (q.length ? '?' + q.join('&') : ''));
    },
    /**
     * Todos os materiais (páginas de 100 até o total). Qualquer página que
     * falhe devolve a falha — nunca uma lista parcial como se fosse
     * completa. `completo=false` só quando o teto de páginas é atingido ou
     * o servidor devolve uma página vazia antes do total anunciado.
     */
    listarTodos: async function (filtro) {
      var f = filtro || {};
      var materiais = [];
      var total = 0;
      var completo = false;
      for (var pagina = 1; pagina <= PAGINAS_MAXIMAS; pagina += 1) {
        var r = await acoes.listar({ ativo: f.ativo, busca: f.busca, pagina: pagina, limite: LIMITE_LISTA });
        if (!r.ok) return r;
        var lote = r.dados && Array.isArray(r.dados.materiais) ? r.dados.materiais : [];
        total = r.dados && typeof r.dados.total === 'number' ? r.dados.total : materiais.length + lote.length;
        materiais = materiais.concat(lote);
        if (lote.length === 0 || materiais.length >= total) {
          completo = materiais.length >= total;
          break;
        }
      }
      return { ok: true, status: 200, dados: { materiais: materiais, total: total, completo: completo }, codigo: null, mensagem: null, detalhes: null };
    },
    criar: function (corpo) {
      return http().requisitar('POST', CAMINHO, { corpo: corpo });
    },
    /** Registro real para o modo edição. */
    buscar: function (id) {
      return http().requisitar('GET', CAMINHO + '/' + encodeURIComponent(id));
    },
    /** Só os campos cadastrais alterados (formulario.montarEdicao); nunca estoque. */
    alterar: function (id, corpo) {
      return http().requisitar('PATCH', CAMINHO + '/' + encodeURIComponent(id), { corpo: corpo });
    },
    estoque: function (id) {
      return http().requisitar('GET', CAMINHO + '/' + encodeURIComponent(id) + '/estoque');
    },
    movimentar: function (id, corpo) {
      return http().requisitar('POST', CAMINHO + '/' + encodeURIComponent(id) + '/estoque/movimentar', { corpo: corpo });
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Formulário
  // ───────────────────────────────────────────────────────────────────

  function converterPrazo(valor, unidade) {
    var n = inteiro(valor);
    if (n === null || n <= 0 || !hasOwn(FATORES_PRAZO, unidade)) return null;
    return n * FATORES_PRAZO[unidade];
  }

  /** "6 meses = 180 dias", "1 ano = 365 dias", "45 dias"; '' quando inválido. */
  function textoPrazo(valor, unidade) {
    var dias = converterPrazo(valor, unidade);
    if (dias === null) return '';
    var n = inteiro(valor);
    var rotulo = ROTULOS_PRAZO[unidade][n === 1 ? 0 : 1];
    if (unidade === 'dias') return n + ' ' + rotulo;
    return n + ' ' + rotulo + ' = ' + dias + ' dias';
  }

  function tamanhosSugeridos(tipo) {
    var t = texto(tipo);
    if (t === 'Sapatão / Botina') return TAMANHOS_CALCADO.slice();
    if (/^luva/i.test(t)) return TAMANHOS_LUVA.slice();
    return ['Único'];
  }

  /**
   * Monta o corpo do POST /materiais e a entrada inicial (separada) a
   * partir dos campos da tela, todos como texto. Devolve
   * {ok:true, corpo, entrada|null} ou {ok:false, erros:[{campo, mensagem}]}.
   * Opcionais vazios são omitidos: o servidor grava NULL.
   */
  function montarCorpo(campos) {
    var c = campos || {};
    var erros = [];
    var corpo = {};
    var erro = function (campo, mensagem) { erros.push({ campo: campo, mensagem: mensagem }); };
    var opcional = function (campo, valor, limite, rotulo) {
      var v = texto(valor);
      if (!v) return;
      if (v.length > limite) erro(campo, rotulo + ' com mais de ' + limite + ' caracteres.');
      else corpo[campo] = v;
    };

    var nome = texto(c.nome);
    if (!nome) erro('nome', 'Informe o nome do material.');
    else if (nome.length > LIMITES.nome) erro('nome', 'Nome com mais de ' + LIMITES.nome + ' caracteres.');
    else corpo.nome = nome;

    var tipo = texto(c.tipo);
    if (tipo === 'Outro') {
      tipo = texto(c.tipoCustom);
      if (!tipo) erro('tipo', 'Informe o nome do tipo.');
    }
    if (tipo) {
      if (tipo.length > LIMITES.tipo) erro('tipo', 'Tipo com mais de ' + LIMITES.tipo + ' caracteres.');
      else corpo.tipo = tipo;
    }

    opcional('categoria', c.categoria, LIMITES.categoria, 'Categoria');
    opcional('caNumero', c.caNumero, LIMITES.caNumero, 'Número do CA');
    var data = texto(c.caValidade);
    if (data) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) erro('caValidade', 'Validade do CA deve ser uma data (AAAA-MM-DD).');
      else corpo.caValidade = data;
    }
    opcional('fabricante', c.fabricante, LIMITES.fabricante, 'Fabricante');
    opcional('codigoInterno', c.codigoInterno, LIMITES.codigoInterno, 'Código interno');
    opcional('descricao', c.descricao, LIMITES.descricao, 'Descrição');

    var unidade = texto(c.unidade).toLowerCase() || 'unidade';
    if (unidade.length > LIMITES.unidade) erro('unidade', 'Unidade com mais de ' + LIMITES.unidade + ' caracteres.');
    else corpo.unidade = unidade;

    var minimo = texto(c.estoqueMinimo);
    if (minimo) {
      var m = inteiro(minimo);
      if (m === null || m < 0) erro('estoqueMinimo', 'Estoque mínimo deve ser um inteiro maior ou igual a zero.');
      else if (m > INTEGER_MAXIMO) erro('estoqueMinimo', 'Estoque mínimo acima do limite (' + INTEGER_MAXIMO + ').');
      else corpo.estoqueMinimo = m;
    }

    if (texto(c.definePrazo) === 'sim') {
      var dias = converterPrazo(c.prazo, texto(c.prazoUnidade));
      if (dias === null) erro('prazo', 'Informe um prazo inteiro maior que zero.');
      else if (dias > INTEGER_MAXIMO) erro('prazo', 'Prazo de uso, em dias, acima do limite (' + INTEGER_MAXIMO + ' dias).');
      else corpo.prazoUsoDias = dias;
    }

    // Entrada inicial só com "Sim" explícito (decisão 2 da melhoria da C2):
    // com "Não" (ou sem escolha), quantidade e tamanho são ignorados e o
    // material nasce sem estoque. Com "Sim", os dois são obrigatórios.
    var entrada = null;
    if (texto(c.registrarEntrada) === 'sim') {
      var quantidade = texto(c.quantidadeComprada);
      var q = inteiro(quantidade);
      var tamanho = texto(c.tamanhoEntrada);
      if (!quantidade) erro('quantidadeComprada', 'Informe a quantidade comprada da entrada inicial.');
      else if (q === null || q <= 0) erro('quantidadeComprada', 'Quantidade comprada deve ser um inteiro maior que zero.');
      else if (q > INTEGER_MAXIMO) erro('quantidadeComprada', 'Quantidade comprada acima do limite (' + INTEGER_MAXIMO + ').');
      if (!tamanho) erro('tamanhoEntrada', 'Escolha o tamanho da entrada inicial.');
      else if (tamanho.length > LIMITES.tamanho) erro('tamanhoEntrada', 'Tamanho com mais de ' + LIMITES.tamanho + ' caracteres.');
      if (q !== null && q > 0 && q <= INTEGER_MAXIMO && tamanho && tamanho.length <= LIMITES.tamanho) entrada = { tamanho: tamanho, quantidade: q };
    }

    if (erros.length > 0) return { ok: false, erros: erros };
    return { ok: true, corpo: corpo, entrada: entrada };
  }

  // ── edição de material existente (melhoria da C2) ──

  /** Prazo gravado em dias → anos (múltiplo de 365), meses (de 30) ou dias; ida e volta exata. */
  function prazoParaCampos(dias) {
    var n = typeof dias === 'number' ? dias : inteiro(dias);
    if (n === null || n === undefined || n <= 0) return { definePrazo: 'nao', prazoUnidade: 'meses', prazo: '' };
    if (n % 365 === 0) return { definePrazo: 'sim', prazoUnidade: 'anos', prazo: String(n / 365) };
    if (n % 30 === 0) return { definePrazo: 'sim', prazoUnidade: 'meses', prazo: String(n / 30) };
    return { definePrazo: 'sim', prazoUnidade: 'dias', prazo: String(n) };
  }

  /**
   * Validade do CA para o campo date (AAAA-MM-DD). A API devolve a data
   * pura, formatada no PostgreSQL, em qualquer fuso do servidor (ajuste de
   * 25/09/2026). Data e hora ainda são aceitas por compatibilidade: usa só
   * a parte da data, sem converter fuso no navegador.
   */
  function dataParaCampo(valor) {
    var s = texto(valor);
    return /^\d{4}-\d{2}-\d{2}(T|$)/.test(s) ? s.slice(0, 10) : '';
  }

  function naLista(lista, valor) {
    var v = texto(valor).toLowerCase();
    for (var i = 0; i < lista.length; i += 1) if (lista[i].toLowerCase() === v) return lista[i];
    return null;
  }

  /**
   * Material da API → campos do formulário (mesmo formato de montarCorpo).
   * Valor fora das opções do HTML volta em `opcoesExtras` para a página
   * acrescentar uma opção temporária: nada é trocado em silêncio.
   */
  function camposDoMaterial(material) {
    var m = material || {};
    var tipo = texto(m.tipo);
    var tipoLista = naLista(TIPOS, tipo);
    var categoria = texto(m.categoria);
    var categoriaLista = categoria ? naLista(CATEGORIAS, categoria) : null;
    var unidade = texto(m.unidade);
    var unidadeLista = naLista(UNIDADES, unidade);
    var prazo = prazoParaCampos(m.prazoUsoDias);
    return {
      campos: {
        nome: texto(m.nome),
        categoria: categoriaLista || categoria,
        tipo: tipoLista || 'Outro',
        tipoCustom: tipoLista ? '' : tipo,
        caNumero: texto(m.caNumero),
        caValidade: dataParaCampo(m.caValidade),
        fabricante: texto(m.fabricante),
        codigoInterno: texto(m.codigoInterno),
        unidade: unidadeLista || unidade,
        estoqueMinimo: m.estoqueMinimo === null || m.estoqueMinimo === undefined ? '' : String(m.estoqueMinimo),
        definePrazo: prazo.definePrazo,
        prazoUnidade: prazo.prazoUnidade,
        prazo: prazo.prazo,
        descricao: texto(m.descricao),
        registrarEntrada: 'nao',
        quantidadeComprada: '',
        tamanhoEntrada: '',
      },
      opcoesExtras: {
        categoria: !categoria ? { valor: '', rotulo: 'Sem categoria' } : (categoriaLista ? null : { valor: categoria, rotulo: categoria }),
        unidade: unidadeLista || !unidade ? null : { valor: unidade, rotulo: unidade },
      },
    };
  }

  function valorOriginal(campo, valor) {
    if (valor === null || valor === undefined) return null;
    if (campo === 'caValidade') return dataParaCampo(valor) || null;
    if (campo === 'prazoUsoDias' || campo === 'estoqueMinimo') return Number(valor);
    return texto(valor) || null;
  }

  /**
   * Corpo do PATCH /materiais/:id: só os campos que mudaram em relação ao
   * registro carregado; opcional apagado → null. Mesmas validações do
   * cadastro (montarCorpo). Nunca envia unidade, quantidade, tamanho ou
   * empresaId: a edição não mexe em estoque.
   * {ok:true, corpo, alterado} ou {ok:false, erros}.
   */
  function montarEdicao(campos, original) {
    var o = original || {};
    var base = {};
    Object.keys(campos || {}).forEach(function (k) { base[k] = campos[k]; });
    base.registrarEntrada = 'nao';
    base.quantidadeComprada = '';
    base.tamanhoEntrada = '';
    // "Outro" sem texto só é aceito quando o material já não tinha tipo.
    if (texto(base.tipo) === 'Outro' && !texto(base.tipoCustom) && !texto(o.tipo)) base.tipo = '';
    var montado = montarCorpo(base);
    var erros = montado.ok ? [] : montado.erros.slice();
    if (!texto(base.estoqueMinimo) && !erros.some(function (e) { return e.campo === 'estoqueMinimo'; })) {
      erros.push({ campo: 'estoqueMinimo', mensagem: 'Informe o estoque mínimo (use 0 para nenhum).' });
    }
    if (erros.length > 0) return { ok: false, erros: erros };
    var corpo = {};
    CAMPOS_EDITAVEIS.forEach(function (campo) {
      var novo = hasOwn(montado.corpo, campo) ? montado.corpo[campo] : null;
      if (novo !== valorOriginal(campo, o[campo])) corpo[campo] = novo;
    });
    return { ok: true, corpo: corpo, alterado: Object.keys(corpo).length > 0 };
  }

  /**
   * Entrada de estoque em material já cadastrado (25/09/2026): corpo do
   * POST /materiais/:id/estoque/movimentar, SEMPRE tipo ENTRADA. Tamanho
   * escolhido e quantidade inteira > 0 obrigatórios; motivo opcional
   * (vazio → omitido, o contrato aceita ausente). Nunca empresaId.
   */
  function montarEntrada(campos) {
    var c = campos || {};
    var erros = [];
    var tamanho = texto(c.tamanho);
    if (!tamanho) erros.push({ campo: 'tamanho', mensagem: 'Selecione o tamanho da entrada.' });
    else if (tamanho.length > LIMITES.tamanho) erros.push({ campo: 'tamanho', mensagem: 'Tamanho com mais de ' + LIMITES.tamanho + ' caracteres.' });
    var q = inteiro(c.quantidade);
    if (q === null || q <= 0) erros.push({ campo: 'quantidade', mensagem: 'Informe uma quantidade inteira maior que zero.' });
    else if (q > INTEGER_MAXIMO) erros.push({ campo: 'quantidade', mensagem: 'Quantidade acima do limite (' + INTEGER_MAXIMO + ').' });
    var motivo = texto(c.motivo);
    if (motivo.length > LIMITES.motivo) erros.push({ campo: 'motivo', mensagem: 'Motivo com mais de ' + LIMITES.motivo + ' caracteres.' });
    if (erros.length > 0) return { ok: false, erros: erros };
    var corpo = { tamanho: tamanho, tipo: 'ENTRADA', quantidade: q };
    if (motivo) corpo.motivo = motivo;
    return { ok: true, corpo: corpo };
  }

  var formulario = {
    LIMITES: LIMITES,
    INTEGER_MAXIMO: INTEGER_MAXIMO,
    FATORES_PRAZO: FATORES_PRAZO,
    TAMANHOS_GRADE: TAMANHOS_GRADE,
    CATEGORIAS: CATEGORIAS,
    TIPOS: TIPOS,
    UNIDADES: UNIDADES,
    converterPrazo: converterPrazo,
    textoPrazo: textoPrazo,
    tamanhosSugeridos: tamanhosSugeridos,
    montarCorpo: montarCorpo,
    prazoParaCampos: prazoParaCampos,
    dataParaCampo: dataParaCampo,
    camposDoMaterial: camposDoMaterial,
    montarEdicao: montarEdicao,
    montarEntrada: montarEntrada,
  };

  // ───────────────────────────────────────────────────────────────────
  // Grade de tamanhos
  // ───────────────────────────────────────────────────────────────────

  /** 0 → sem estoque; abaixo do mínimo (quando há mínimo) → atenção; senão com saldo. */
  function situacao(quantidade, estoqueMinimo) {
    var q = Number(quantidade) || 0;
    var minimo = Number(estoqueMinimo) || 0;
    if (q <= 0) return 'sem-estoque';
    if (minimo > 0 && q < minimo) return 'abaixo-minimo';
    return 'com-saldo';
  }

  function classeChip(s) { return hasOwn(CLASSES_CHIP, s) ? CLASSES_CHIP[s] : CLASSES_CHIP['sem-estoque']; }

  /** Chips = sugeridos pelo tipo + tamanhos com saldo no banco; ausente = 0, nunca inventado. */
  function montar(saldos, estoqueMinimo, sugeridos) {
    var porTamanho = Object.create(null);
    var ordem = [];
    (sugeridos || []).forEach(function (t) { if (ordem.indexOf(t) === -1) ordem.push(t); });
    (saldos || []).forEach(function (s) {
      porTamanho[s.tamanho] = Number(s.quantidade) || 0;
      if (ordem.indexOf(s.tamanho) === -1) ordem.push(s.tamanho);
    });
    return ordem.map(function (t) {
      var q = t in porTamanho ? porTamanho[t] : 0;
      return { tamanho: t, quantidade: q, situacao: situacao(q, estoqueMinimo) };
    });
  }

  function resumo(chips) {
    if (!chips || chips.length === 0) return 'Nenhum saldo registrado';
    var n = { 'com-saldo': 0, 'abaixo-minimo': 0, 'sem-estoque': 0 };
    chips.forEach(function (c) { if (hasOwn(n, c.situacao)) n[c.situacao] += 1; });
    return n['com-saldo'] + ' disponível · ' + n['abaixo-minimo'] + ' atenção · ' + n['sem-estoque'] + ' em falta';
  }

  var grade = { situacao: situacao, classeChip: classeChip, montar: montar, resumo: resumo };

  // ───────────────────────────────────────────────────────────────────
  // Mensagens
  // ───────────────────────────────────────────────────────────────────

  var MSG = {
    REDE: 'Falha de rede: não foi possível falar com o servidor. Verifique a conexão e tente novamente.',
    CADASTRO_NAO_CONFIRMADO_REDE: 'Falha de rede: não foi possível confirmar se o material foi cadastrado. Confira a lista de materiais (seletor da grade) antes de repetir o cadastro.',
    CADASTRO_NAO_CONFIRMADO_SERVIDOR: 'Erro no servidor: não foi possível confirmar se o material foi cadastrado. Confira a lista de materiais (seletor da grade) antes de repetir o cadastro.',
    ENTRADA_NAO_CONFIRMADA_REDE: 'falha de rede: o servidor pode ou não ter registrado a entrada.',
    ENTRADA_NAO_CONFIRMADA_SERVIDOR: 'erro no servidor: a entrada pode ou não ter sido registrada.',
    ORIENTACAO_SALDO: 'Consulte o saldo real do material na grade de tamanhos antes de repetir a entrada.',
    SESSAO: 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.',
    SEM_CRIAR: 'Seu perfil não pode cadastrar materiais nesta empresa.',
    SEM_MOVIMENTAR: 'seu perfil não pode movimentar estoque nesta empresa.',
    SEM_VISUALIZAR: 'Seu perfil não pode consultar o estoque nesta empresa.',
    NAO_ENCONTRADO: 'Material não encontrado nesta empresa.',
    CODIGO_DUPLICADO: 'Já existe um material com este código interno nesta empresa. Use outro código ou deixe em branco.',
    CADASTRO_GENERICO: 'Não foi possível cadastrar o material. Tente novamente.',
    ENTRADA_GENERICO: 'não foi possível registrar a entrada de estoque.',
    GRADE_GENERICO: 'Não foi possível consultar o estoque deste material.',
    SUCESSO: 'Material cadastrado com sucesso.',
    SEM_ESTOQUE_INICIAL: 'Registrado sem quantidade em estoque: nenhuma entrada inicial foi feita.',
    SEM_EDITAR: 'Seu perfil não pode editar materiais nesta empresa.',
    EDICAO_SUCESSO: 'Alterações do material salvas. O estoque não foi alterado.',
    EDICAO_SEM_ALTERACAO: 'Nenhuma alteração para salvar.',
    EDICAO_NAO_CONFIRMADA_REDE: 'Falha de rede: não foi possível confirmar se as alterações foram salvas. Cancele a edição e abra o material de novo para conferir antes de salvar outra vez.',
    EDICAO_NAO_CONFIRMADA_SERVIDOR: 'Erro no servidor: não foi possível confirmar se as alterações foram salvas. Cancele a edição e abra o material de novo para conferir antes de salvar outra vez.',
    EDICAO_GENERICO: 'Não foi possível salvar as alterações. Tente novamente.',
    CARREGAR_GENERICO: 'Não foi possível abrir o material para edição.',
  };

  function ehRede(r) { return !r || r.status === 0 || typeof r.status !== 'number'; }
  function ehServidor(r) { return !!r && typeof r.status === 'number' && r.status >= 500; }
  /**
   * Uma escrita só é "recusada" quando o servidor respondeu 4xx: ele
   * recebeu, avaliou e negou. Falha de rede e 5xx não dizem se a operação
   * aconteceu (a resposta pode ter se perdido depois do commit): resultado
   * NÃO confirmado, que nunca autoriza uma nova tentativa automática.
   */
  function confirmado(r) { return !ehRede(r) && !ehServidor(r); }
  function exigeNovoLogin(r) { return !!r && r.status === 401; }

  function camposDe(r) {
    var d = r && Array.isArray(r.detalhes) ? r.detalhes : [];
    var campos = d.map(function (x) { return x && (x.caminho || x.campo); }).filter(Boolean);
    return campos.length ? ' Campos: ' + campos.join(', ') + '.' : '';
  }

  function erroCadastro(r) {
    if (ehRede(r)) return MSG.CADASTRO_NAO_CONFIRMADO_REDE;
    if (ehServidor(r)) return MSG.CADASTRO_NAO_CONFIRMADO_SERVIDOR;
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return MSG.SEM_CRIAR;
    if (r.codigo === 'MATERIAL_CODIGO_INTERNO_DUPLICADO') return MSG.CODIGO_DUPLICADO;
    if (r.status === 400) return 'Dados recusados pelo servidor.' + camposDe(r);
    return MSG.CADASTRO_GENERICO;
  }

  /** Minúscula inicial: compõe com "Entrada de estoque não realizada: ...". */
  function erroEntrada(r) {
    if (ehRede(r)) return MSG.ENTRADA_NAO_CONFIRMADA_REDE;
    if (ehServidor(r)) return MSG.ENTRADA_NAO_CONFIRMADA_SERVIDOR;
    if (r.status === 401) return 'sua sessão terminou.';
    if (r.status === 403) return MSG.SEM_MOVIMENTAR;
    if (r.status === 404) return 'material não encontrado nesta empresa.';
    if (r.codigo === 'MATERIAL_INATIVO') return 'o material está inativo.';
    if (r.codigo === 'ESTOQUE_LIMITE_EXCEDIDO') return 'a quantidade ultrapassa o limite de saldo do tamanho.';
    if (r.codigo === 'ESTOQUE_INSUFICIENTE') return 'saldo insuficiente.';
    if (r.status === 400) return 'dados da entrada recusados pelo servidor.' + camposDe(r);
    return MSG.ENTRADA_GENERICO;
  }

  function erroGrade(r) {
    if (ehRede(r)) return 'Falha de rede ao consultar o estoque. Verifique a conexão e tente novamente.';
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return MSG.SEM_VISUALIZAR;
    if (r.status === 404) return MSG.NAO_ENCONTRADO;
    return MSG.GRADE_GENERICO;
  }

  /**
   * Resultado da entrada de estoque em material já cadastrado.
   * `r` vem de fluxo.registrarEntrada; `entrada` é o corpo enviado; `material` identifica.
   */
  function resultadoEntradaPosterior(r, entrada, material) {
    var m = material || {};
    if (r && r.ok) {
      var s = r.saldo || {};
      var e = entrada || {};
      var identificacao = (m.nome ? ' de "' + m.nome + '"' : '') + (m.codigoInterno ? ' (código ' + m.codigoInterno + ')' : '');
      return 'Entrada de estoque registrada: ' + e.quantidade + ' no tamanho ' + e.tamanho + identificacao + '. Saldo atual do tamanho ' + s.tamanho + ': ' + s.quantidade + '.';
    }
    var resposta = r ? r.resposta : null;
    if (r && r.confirmado === false) return 'Entrada de estoque não confirmada: ' + erroEntrada(resposta) + ' ' + MSG.ORIENTACAO_SALDO;
    return 'Entrada de estoque não realizada: ' + erroEntrada(resposta);
  }

  /** PATCH /materiais/:id. Rede e 5xx: não confirmado, nunca repetido sozinho. */
  function erroEdicao(r) {
    if (ehRede(r)) return MSG.EDICAO_NAO_CONFIRMADA_REDE;
    if (ehServidor(r)) return MSG.EDICAO_NAO_CONFIRMADA_SERVIDOR;
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return MSG.SEM_EDITAR;
    if (r.status === 404) return MSG.NAO_ENCONTRADO;
    if (r.codigo === 'MATERIAL_CODIGO_INTERNO_DUPLICADO') return MSG.CODIGO_DUPLICADO;
    if (r.codigo === 'MATERIAL_SEM_ALTERACAO') return MSG.EDICAO_SEM_ALTERACAO;
    if (r.status === 400) return 'Dados recusados pelo servidor.' + camposDe(r);
    return MSG.EDICAO_GENERICO;
  }

  /** GET /materiais/:id ao entrar no modo edição. */
  function erroCarregarEdicao(r) {
    if (ehRede(r)) return 'Falha de rede ao abrir o material. Verifique a conexão e tente novamente.';
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return 'Seu perfil não pode consultar este material nesta empresa.';
    if (r.status === 404) return MSG.NAO_ENCONTRADO;
    return MSG.CARREGAR_GENERICO;
  }

  /** Texto final do cadastro: sucesso, com ou sem a entrada inicial. */
  function resultado(res) {
    var e = res && res.entrada ? res.entrada : { solicitada: false };
    if (!e.solicitada) return MSG.SUCESSO + ' ' + MSG.SEM_ESTOQUE_INICIAL;
    if (e.realizada) {
      var quantidade = e.quantidade !== undefined ? e.quantidade : (e.saldo ? e.saldo.quantidade : '');
      var tamanho = e.tamanho !== undefined ? e.tamanho : (e.saldo ? e.saldo.tamanho : '');
      return MSG.SUCESSO + ' Entrada de estoque registrada: ' + quantidade + ' no tamanho ' + tamanho + '.';
    }
    if (e.motivo === 'NAO_CONFIRMADO') {
      var m = res.material || {};
      var identificacao = 'nº ' + m.id + (m.codigoInterno ? ', código ' + m.codigoInterno : '') + (m.nome ? ', "' + m.nome + '"' : '');
      return 'Material cadastrado com sucesso (' + identificacao + '). Entrada de estoque não confirmada: ' + erroEntrada(e.resposta) + ' ' + MSG.ORIENTACAO_SALDO;
    }
    var motivo = e.motivo === 'SEM_PERMISSAO' ? MSG.SEM_MOVIMENTAR : erroEntrada(e.resposta);
    return MSG.SUCESSO + ' Entrada de estoque não realizada: ' + motivo;
  }

  var mensagens = {
    exigeNovoLogin: exigeNovoLogin, confirmado: confirmado, erroCadastro: erroCadastro, erroEntrada: erroEntrada, erroGrade: erroGrade,
    erroEdicao: erroEdicao, erroCarregarEdicao: erroCarregarEdicao, resultado: resultado, resultadoEntradaPosterior: resultadoEntradaPosterior, MSG: MSG,
  };

  // ───────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────

  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Chips somente leitura (sem clique): a cor vem do saldo real. */
  function chips(lista) {
    return (lista || []).map(function (c) {
      return '<button class="size-chip ' + classeChip(c.situacao) + '" type="button" disabled title="'
        + escaparHtml(c.quantidade + ' em estoque') + '">' + escaparHtml(c.tamanho) + '</button>';
    }).join('');
  }

  function opcoesMateriais(lista) {
    return (lista || []).map(function (m) {
      var rotulo = m.nome + (m.codigoInterno ? ' · ' + m.codigoInterno : '');
      return '<option value="' + escaparHtml(m.id) + '">' + escaparHtml(rotulo) + '</option>';
    }).join('');
  }

  var render = { escaparHtml: escaparHtml, chips: chips, opcoesMateriais: opcoesMateriais };

  // ───────────────────────────────────────────────────────────────────
  // Fluxo
  // ───────────────────────────────────────────────────────────────────

  /**
   * 1) POST /materiais. Recusado → {ok:false, etapa:'cadastro', resposta}.
   * 2) Só depois do 201, e só se houver quantidade e a pessoa tiver
   *    MOVIMENTAR_ESTOQUE, uma ENTRADA separada. Recusa da entrada NÃO
   *    desfaz o cadastro, não apaga o material e não é repetida.
   * Rede e 5xx: resultado NÃO confirmado (`confirmado=false` no cadastro;
   * motivo `NAO_CONFIRMADO` na entrada) — distinto de recusa, e também
   * nunca repetido automaticamente.
   */
  async function cadastrar(opcoes) {
    var o = opcoes || {};
    var r = await acoes.criar(o.corpo);
    if (!r.ok) return { ok: false, etapa: 'cadastro', confirmado: confirmado(r), resposta: r };
    var material = r.dados && r.dados.material ? r.dados.material : null;
    var entrada = o.entrada || null;
    if (!entrada) {
      return { ok: true, material: material, entrada: { solicitada: false, realizada: false, motivo: null, resposta: null, saldo: null } };
    }
    if (!o.podeMovimentar) {
      return { ok: true, material: material, entrada: { solicitada: true, realizada: false, motivo: 'SEM_PERMISSAO', resposta: null, saldo: null, tamanho: entrada.tamanho, quantidade: entrada.quantidade } };
    }
    var m = await acoes.movimentar(material.id, { tamanho: entrada.tamanho, tipo: 'ENTRADA', quantidade: entrada.quantidade, motivo: MOTIVO_ENTRADA_INICIAL });
    return {
      ok: true,
      material: material,
      entrada: {
        solicitada: true,
        realizada: !!m.ok,
        motivo: m.ok ? null : (confirmado(m) ? 'RECUSADA' : 'NAO_CONFIRMADO'),
        resposta: m,
        saldo: m.ok && m.dados ? m.dados.saldo : null,
        tamanho: entrada.tamanho,
        quantidade: entrada.quantidade,
      },
    };
  }

  /** GET /materiais/:id/estoque → chips com o mínimo do material e os tamanhos sugeridos pelo tipo. */
  async function carregarGrade(materialId) {
    var r = await acoes.estoque(materialId);
    if (!r.ok) return { ok: false, resposta: r };
    var material = r.dados && r.dados.material ? r.dados.material : {};
    var lista = montar(r.dados ? r.dados.saldos : [], material.estoqueMinimo, tamanhosSugeridos(material.tipo));
    return { ok: true, material: material, chips: lista, resumo: resumo(lista) };
  }

  /**
   * Entrada de estoque em material já cadastrado: uma única chamada à rota
   * existente, sempre ENTRADA (o tipo recebido é ignorado). Nunca PATCH do
   * material. 4xx = recusa confirmada; rede e 5xx = não confirmada; nenhuma
   * nova tentativa automática.
   */
  async function registrarEntrada(materialId, corpo) {
    var c = corpo || {};
    var envio = { tamanho: c.tamanho, tipo: 'ENTRADA', quantidade: c.quantidade };
    if (c.motivo) envio.motivo = c.motivo;
    var r = await acoes.movimentar(materialId, envio);
    if (!r.ok) return { ok: false, confirmado: confirmado(r), resposta: r, saldo: null };
    return { ok: true, confirmado: true, resposta: r, saldo: r.dados ? r.dados.saldo : null };
  }

  var fluxo = { cadastrar: cadastrar, carregarGrade: carregarGrade, registrarEntrada: registrarEntrada, MOTIVO_ENTRADA_INICIAL: MOTIVO_ENTRADA_INICIAL };

  global.EpiMateriais = {
    acoes: acoes,
    formulario: formulario,
    grade: grade,
    mensagens: mensagens,
    render: render,
    fluxo: fluxo,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiMateriais;
  }
})(typeof window !== 'undefined' ? window : globalThis);
