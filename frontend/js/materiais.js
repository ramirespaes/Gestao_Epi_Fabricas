(function (global) {
  'use strict';

  /**
   * EpiMateriais — cadastro de materiais e EPIs e estoque por lote:
   *
   *   GET   /materiais?ativo=&busca=&pagina=&limite=   (materials.visualizar)
   *   POST  /materiais                                 (materials.criar)
   *   GET   /materiais/:id                             (materials.visualizar)
   *   PATCH /materiais/:id                             (materials.editar)
   *   GET   /materiais/:id/estoque/lotes               (materials.visualizar)
   *   POST  /materiais/:id/estoque/entradas            (ação MOVIMENTAR_ESTOQUE)
   *   POST  /estoque/lotes/:loteId/baixas              (ação MOVIMENTAR_ESTOQUE)
   *
   * Camadas, como nas outras telas HTTP do projeto:
   *   acoes        — fala com a API e devolve o envelope do EpiHttp.
   *   formulario   — transforma o que a pessoa digitou no corpo que o
   *                  contrato aceita (funções puras). Nunca inclui empresaId.
   *   idempotencia — uma chave por operação de estoque.
   *   estoque      — lotes e saldos em texto e HTML escapado.
   *   mensagens    — traduz códigos do backend em texto (funções puras).
   *   render       — HTML escapado de listas.
   *   fluxo        — cadastro, entrada inicial, entrada, baixa e consulta.
   *
   * O backend é a autoridade final: permissão, CA vencido, tamanho e saldo
   * são conferidos de novo no servidor.
   */

  var CAMINHO = '/materiais';

  // Tetos dos contratos (schemas do backend e migrations).
  var LIMITES = { nome: 150, tipo: 100, tipoDescricao: 100, descricaoOutros: 100, fabricante: 100, caNumero: 20, unidade: 20, categoria: 30, codigoInterno: 30, descricao: 500, tamanho: 20, justificativa: 500 };
  // Teto das colunas INTEGER (int4) do PostgreSQL, o mesmo do backend:
  // prazo em dias, estoque mínimo e quantidade.
  var INTEGER_MAXIMO = 2147483647;
  // Paginação do GET /materiais (LIMITE_MAXIMO do backend) e teto de páginas
  // que o seletor de material percorre (10.000 materiais ativos por empresa).
  var LIMITE_LISTA = 100;
  var PAGINAS_MAXIMAS = 100;

  // 1 mês = 30 dias; 1 ano = 365 dias. A unidade não é persistida.
  var FATORES_PRAZO = { dias: 1, meses: 30, anos: 365 };
  var ROTULOS_PRAZO = { dias: ['dia', 'dias'], meses: ['mês', 'meses'], anos: ['ano', 'anos'] };

  // Lista padrão de tamanhos da entrada. "Único" não entra: material de
  // tamanho único não escolhe tamanho, e o backend grava o lote sem tamanho.
  var TAMANHOS_GRADE = ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44', 'PP', 'P', 'M', 'G', 'GG'];
  var TAMANHOS_CALCADO = ['34', '35', '36', '37', '38', '39', '40', '41', '42', '43', '44'];
  var TAMANHOS_LUVA = ['PP', 'P', 'M', 'G', 'GG'];
  var TAMANHO_UNICO = 'Único';

  // Classificação V2 (08/10/2026): Grupo (campo `categoria`) → Grupo de Proteção
  // → Tipo. Cadastro novo só com EPI, Vestimenta ou "Outros"; EPI e Vestimenta
  // levam o grupo de proteção e um tipo do catálogo da empresa
  // (GET /tipos-material, só ativos). "Outros" é opção da interface em qualquer
  // nível, nunca linha do catálogo, e leva a especificação em campo próprio.
  // Vocabulário igual ao de backend/src/utils/classificacao-material.js,
  // conferido por teste. O material gravado antes (modeloClassificacao LEGADO)
  // continua editável nos demais campos sem reclassificar.
  var OUTROS = 'Outros';
  var GRUPOS_CATALOGO = ['EPI', 'Vestimenta'];
  var GRUPOS = GRUPOS_CATALOGO.concat([OUTROS]);
  var GRUPOS_PROTECAO = [
    'Proteção auditiva', 'Proteção contra quedas', 'Proteção da cabeça', 'Proteção das mãos', 'Proteção das pernas', 'Proteção dos braços',
    'Proteção dos pés', 'Proteção facial', 'Proteção ocular', 'Proteção da pele (membros superiores)', 'Proteção respiratória', 'Proteção do tronco',
  ];
  var PROTECAO_OCULAR = 'Proteção ocular';
  var MODELO_V2 = 'V2';
  var CONTROLE = /[\u0000-\u001f\u007f]/;
  // Campos da classificação na tela; a edição compara-os com o registro carregado.
  var CAMPOS_CLASSIFICACAO = ['categoria', 'categoriaCustom', 'grupoProtecao', 'grupoProtecaoCustom', 'tipo', 'tipoCustom'];
  // Legado: óculos de proteção reconhecidos pelo tipo gravado, nunca pelo nome
  // (os dois tipos oficiais da 12G-8 e o nome histórico). Na V2 a regra é a
  // classificação (EPI + Proteção ocular), para qualquer tipo.
  var TIPOS_OCULOS = ['Óculos de Proteção Incolor', 'Óculos de Proteção Ampla Visão'];
  var TIPO_OCULOS_LEGADO = 'Óculos de proteção';
  var TIPO_OCULOS = TIPO_OCULOS_LEGADO;
  var CALCADOS = ['Sapatão / Botina', 'Botina de Segurança', 'Sapato de Segurança'];
  var UNIDADES = ['Par', 'Unidade', 'Caixa', 'Pacote', 'Kit'];

  // Controle de tamanho escolhido na tela → exigeTamanho do backend.
  var CONTROLES_TAMANHO = Object.freeze({ unico: false, grade: true });

  // Campos que a edição pode enviar ao PATCH. A unidade de controle fica de
  // fora (mudaria o sentido do saldo), e o CA do cadastro também: o CA que
  // vale é o de cada lote.
  // A classificação não entra aqui: quando muda, vai como bloco completo (montarEdicao).
  var CAMPOS_EDITAVEIS = ['nome', 'fabricante', 'codigoInterno', 'descricao', 'prazoUsoDias', 'exigeTamanho', 'oculosComGrau', 'estoqueMinimo'];

  var MOTIVOS_BAIXA = [
    { codigo: 'CA_VENCIDO', rotulo: 'CA vencido' },
    { codigo: 'AVARIA', rotulo: 'Avaria' },
    { codigo: 'DESCARTE', rotulo: 'Descarte' },
    { codigo: 'PERDA', rotulo: 'Perda' },
    { codigo: 'AJUSTE_INVENTARIO', rotulo: 'Ajuste de inventário' },
    { codigo: 'DEVOLUCAO_FORNECEDOR', rotulo: 'Devolução ao fornecedor' },
    { codigo: 'OUTRO', rotulo: 'Outro' },
  ];

  // Situação do CA calculada pelo backend → rótulo e cor. "A vencer" e
  // "Vence hoje" são só alerta: o saldo continua disponível.
  var SITUACOES_CA = {
    VALIDO: ['Válido', 'badge-ok'],
    VENCE_HOJE: ['Vence hoje', 'badge-warning'],
    A_VENCER: ['A vencer', 'badge-warning'],
    VENCIDO: ['Vencido', 'badge-danger'],
    SEM_CA: ['Sem CA (legado)', 'badge-danger'],
    NAO_EXIGE_CA: ['Não exige CA', 'badge-ok'],
  };

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
    lotes: function (id) {
      return http().requisitar('GET', CAMINHO + '/' + encodeURIComponent(id) + '/estoque/lotes');
    },
    /**
     * Tipos ATIVOS do catálogo da empresa para um grupo e um grupo de proteção
     * (todas as páginas), para o seletor de tipo do material. Mesma regra de
     * listarTodos: página que falha devolve a falha, nunca lista parcial.
     */
    listarTipos: async function (filtro) {
      var f = filtro || {};
      var tipos = [];
      var total = 0;
      for (var pagina = 1; pagina <= PAGINAS_MAXIMAS; pagina += 1) {
        var q = ['grupo=' + encodeURIComponent(texto(f.grupo)), 'grupoProtecao=' + encodeURIComponent(texto(f.grupoProtecao)), 'ativo=true', 'pagina=' + pagina, 'limite=' + LIMITE_LISTA];
        var r = await http().requisitar('GET', '/tipos-material?' + q.join('&'));
        if (!r.ok) return r;
        var lote = r.dados && Array.isArray(r.dados.tipos) ? r.dados.tipos : [];
        total = r.dados && typeof r.dados.total === 'number' ? r.dados.total : tipos.length + lote.length;
        tipos = tipos.concat(lote);
        if (lote.length === 0 || tipos.length >= total) break;
      }
      return { ok: true, status: 200, dados: { tipos: tipos, total: total }, codigo: null, mensagem: null, detalhes: null };
    },
    entrada: function (id, corpo) {
      return http().requisitar('POST', CAMINHO + '/' + encodeURIComponent(id) + '/estoque/entradas', { corpo: corpo });
    },
    baixa: function (loteId, corpo) {
      return http().requisitar('POST', '/estoque/lotes/' + encodeURIComponent(loteId) + '/baixas', { corpo: corpo });
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

  /** Só ordena a lista de tamanhos; não decide se o material possui tamanhos. */
  function tamanhosSugeridos(tipo) {
    var t = texto(tipo);
    if (CALCADOS.indexOf(t) !== -1) return TAMANHOS_CALCADO.slice();
    if (/^luva/i.test(t)) return TAMANHOS_LUVA.slice();
    return [];
  }

  /**
   * Com grade (12G-8), só a grade, na ordem dela. Sem grade: tamanhos que já
   * têm lote, depois os sugeridos pelo tipo e o resto da lista padrão.
   */
  function tamanhosDaEntrada(lotes, tipo, grade) {
    if (Array.isArray(grade) && grade.length > 0) return grade.slice();
    var lista = [];
    var incluir = function (t) { if (t !== null && t !== undefined && t !== '' && lista.indexOf(t) === -1) lista.push(t); };
    (lotes || []).forEach(function (l) { incluir(l.tamanho); });
    tamanhosSugeridos(tipo).forEach(incluir);
    TAMANHOS_GRADE.forEach(incluir);
    return lista;
  }

  // 12G-8: grade de tamanhos do material, separados por vírgula, na ordem
  // digitada. Vazio é "sem grade" (legado). O servidor confere de novo.
  var LIMITE_GRADE = 50;
  function lerGrade(valor) {
    var tamanhos = texto(valor).split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    if (tamanhos.length > LIMITE_GRADE) return { tamanhos: [], erro: 'A grade aceita até ' + LIMITE_GRADE + ' tamanhos.' };
    var vistos = Object.create(null);
    for (var i = 0; i < tamanhos.length; i += 1) {
      if (tamanhos[i].length > LIMITES.tamanho) return { tamanhos: [], erro: 'Cada tamanho da grade pode ter até ' + LIMITES.tamanho + ' caracteres.' };
      var chave = tamanhos[i].toUpperCase();
      if (vistos[chave] === true) return { tamanhos: [], erro: 'A grade tem um tamanho repetido: ' + tamanhos[i] + '.' };
      vistos[chave] = true;
    }
    return { tamanhos: tamanhos, erro: null };
  }

  function exigeTamanhoDoControle(controle) {
    var c = texto(controle);
    return hasOwn(CONTROLES_TAMANHO, c) ? CONTROLES_TAMANHO[c] : null;
  }

  function controleDoMaterial(exigeTamanho) {
    if (exigeTamanho === true) return 'grade';
    if (exigeTamanho === false) return 'unico';
    return '';
  }

  function dataIso(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }

  /** Legado: o tipo, aparado, é exatamente um dos tipos de óculos de proteção (oficiais ou o histórico). */
  function ehOculos(tipo) {
    var t = texto(tipo);
    return TIPOS_OCULOS.indexOf(t) !== -1 || t === TIPO_OCULOS_LEGADO;
  }

  /** O material gravado pede "óculos com grau": V2 pela classificação (EPI + Proteção ocular); legado pelo tipo. */
  function oculosDoMaterial(material) {
    var m = material || {};
    if (m.modeloClassificacao === MODELO_V2) return texto(m.categoria) === 'EPI' && texto(m.grupoProtecao) === PROTECAO_OCULAR;
    return ehOculos(m.tipo);
  }

  /** Óculos gravados antes da informação existir: nem com grau, nem sem grau. */
  function oculosSemClassificacao(material) {
    var m = material || {};
    return oculosDoMaterial(m) && m.oculosComGrau !== true && m.oculosComGrau !== false;
  }

  // ── classificação V2 ──

  /** Tipos ATIVOS do catálogo carregado para o grupo e o grupo de proteção, em ordem de nome; "Outros" em qualquer nível não tem tipos. */
  function tiposDoCatalogo(catalogo, grupo, grupoProtecao) {
    var g = texto(grupo);
    var p = texto(grupoProtecao);
    if (!Array.isArray(catalogo) || GRUPOS_CATALOGO.indexOf(g) === -1 || GRUPOS_PROTECAO.indexOf(p) === -1) return [];
    return catalogo.filter(function (t) { return !!t && t.ativo !== false && t.grupo === g && t.grupoProtecao === p; })
      .sort(function (a, b) { return String(a.nome).localeCompare(String(b.nome), 'pt-BR'); });
  }

  /**
   * O que a tela mostra para a combinação atual: proteção só em EPI/Vestimenta;
   * cada "Especifique…" só com o seu "Outros"; tipo travado em "Outros" quando
   * o grupo ou a proteção são "Outros"; óculos com grau só em EPI + Proteção
   * ocular, para qualquer tipo.
   */
  function estadoClassificacao(campos) {
    var c = campos || {};
    var grupo = texto(c.categoria);
    var protecao = texto(c.grupoProtecao);
    var grupoOutros = grupo === OUTROS;
    var noCatalogo = GRUPOS_CATALOGO.indexOf(grupo) !== -1;
    var protecaoOutros = noCatalogo && protecao === OUTROS;
    var forcado = grupoOutros || protecaoOutros;
    return {
      mostrarProtecao: noCatalogo,
      mostrarCategoriaCustom: grupoOutros,
      mostrarProtecaoCustom: protecaoOutros,
      mostrarTipoCustom: forcado || texto(c.tipo) === OUTROS,
      tipoForcadoOutros: forcado,
      mostrarOculos: grupo === 'EPI' && protecao === PROTECAO_OCULAR,
    };
  }

  /** Os campos da classificação na tela são os mesmos do registro carregado (nada a reclassificar). */
  function classificacaoIntocada(campos, original) {
    var c = campos || {};
    var baseline = camposDoMaterial(original).campos;
    return CAMPOS_CLASSIFICACAO.every(function (k) { return texto(c[k]) === texto(baseline[k]); });
  }

  /** A caixa "Óculos com grau" vale: pela classificação da tela ou, com a classificação intocada, pela do registro carregado. */
  function oculosAplicavel(campos, original) {
    var c = campos || {};
    if (original && classificacaoIntocada(c, original)) return oculosDoMaterial(original);
    return estadoClassificacao(c).mostrarOculos;
  }

  /**
   * Bloco da classificação V2, nível a nível (para no primeiro nível incompleto):
   * {erros, corpo} só com o que se aplica. Campo escondido nunca entra no corpo,
   * mesmo que tenha texto esquecido. O servidor confere tudo de novo.
   */
  function classificar(campos) {
    var c = campos || {};
    var erros = [];
    var corpo = {};
    var erro = function (campo, mensagem) { erros.push({ campo: campo, mensagem: mensagem }); };
    var especificar = function (campo, valor, rotulo) {
      var d = texto(valor);
      if (!d) erro(campo, 'Especifique ' + rotulo + ' em texto.');
      else if (d.length > LIMITES.descricaoOutros) erro(campo, 'Especificação de ' + rotulo + ' com mais de ' + LIMITES.descricaoOutros + ' caracteres.');
      else if (CONTROLE.test(d)) erro(campo, 'Especificação de ' + rotulo + ' com caractere inválido.');
      else return d;
      return null;
    };
    var tipoOutros = function () {
      var d = especificar('tipoDescricao', c.tipoCustom, 'o tipo');
      if (d === null) return;
      corpo.tipo = OUTROS;
      corpo.tipoDescricao = d;
    };
    var resultado = function () { return { erros: erros, corpo: corpo }; };

    var grupo = texto(c.categoria);
    if (!grupo) { erro('categoria', 'Selecione o grupo do material.'); return resultado(); }
    if (GRUPOS.indexOf(grupo) === -1) { erro('categoria', 'O grupo "' + grupo + '" é do cadastro antigo: para reclassificar, escolha EPI, Vestimenta ou Outros.'); return resultado(); }
    corpo.categoria = grupo;
    if (grupo === OUTROS) {
      var grupoDescricao = especificar('categoriaDescricao', c.categoriaCustom, 'o grupo');
      if (grupoDescricao === null) return resultado();
      corpo.categoriaDescricao = grupoDescricao;
      tipoOutros();
      return resultado();
    }
    var protecao = texto(c.grupoProtecao);
    if (!protecao) { erro('grupoProtecao', 'Selecione o grupo de proteção.'); return resultado(); }
    if (protecao !== OUTROS && GRUPOS_PROTECAO.indexOf(protecao) === -1) { erro('grupoProtecao', 'Grupo de proteção inválido.'); return resultado(); }
    corpo.grupoProtecao = protecao;
    if (protecao === OUTROS) {
      var protecaoDescricao = especificar('grupoProtecaoDescricao', c.grupoProtecaoCustom, 'o grupo de proteção');
      if (protecaoDescricao === null) return resultado();
      corpo.grupoProtecaoDescricao = protecaoDescricao;
      tipoOutros();
      return resultado();
    }
    var tipo = texto(c.tipo);
    if (!tipo) { erro('tipo', 'Selecione o tipo.'); return resultado(); }
    if (tipo === OUTROS) { tipoOutros(); return resultado(); }
    var escolhido = null;
    tiposDoCatalogo(c.catalogo, grupo, protecao).forEach(function (t) { if (String(t.id) === tipo) escolhido = t; });
    if (!escolhido) { erro('tipo', 'Escolha um tipo ativo do catálogo deste grupo de proteção, ou "Outros".'); return resultado(); }
    corpo.tipoMaterialId = escolhido.id;
    return resultado();
  }

  function presente(v) { return v !== null && v !== undefined && texto(v) !== ''; }
  // A MESMA regra de classificacao-material.js (grupoEfetivo etc.), conferida por teste.
  function efetivo(valor, descricao) {
    if (!presente(valor)) return null;
    return valor === OUTROS && presente(descricao) ? descricao : valor;
  }
  /** Valor de exibição do grupo: a categoria, ou a especificação quando o grupo é "Outros". */
  function grupoEfetivo(material) { var m = material || {}; return efetivo(m.categoria, m.categoriaDescricao); }
  function grupoProtecaoEfetivo(material) { var m = material || {}; return efetivo(m.grupoProtecao, m.grupoProtecaoDescricao); }
  function tipoEfetivo(material) { var m = material || {}; return efetivo(m.tipo, m.tipoDescricao); }

  /** 'LEGADO' (cadastro antigo, sem reclassificar), 'TIPO_INATIVO' (V2 ligado a tipo inativado) ou ''. */
  function rotuloClassificacao(material) {
    var m = material || {};
    if (m.modeloClassificacao !== MODELO_V2) return 'LEGADO';
    if (m.tipoMaterialAtivo === false) return 'TIPO_INATIVO';
    return '';
  }

  /**
   * Corpo do POST /materiais/:id/estoque/entradas, sem a chave. CA e
   * validade sempre; o tamanho só vai quando o material possui tamanhos.
   * Material ainda não classificado não recebe entrada.
   */
  function montarEntrada(campos, exigeTamanho) {
    var c = campos || {};
    var erros = [];
    var erro = function (campo, mensagem) { erros.push({ campo: campo, mensagem: mensagem }); };
    if (exigeTamanho !== true && exigeTamanho !== false) {
      erro('controleTamanho', 'Defina no cadastro do material o controle de tamanho (tamanho único ou possui tamanhos) antes de registrar entradas.');
      return { ok: false, erros: erros };
    }
    var corpo = {};
    if (exigeTamanho) {
      var tamanho = texto(c.tamanho);
      if (!tamanho) erro('tamanho', 'Selecione o tamanho da entrada.');
      else if (tamanho.length > LIMITES.tamanho) erro('tamanho', 'Tamanho com mais de ' + LIMITES.tamanho + ' caracteres.');
      else corpo.tamanho = tamanho;
    }
    var q = inteiro(c.quantidade);
    if (q === null || q <= 0) erro('quantidade', 'Informe uma quantidade inteira maior que zero.');
    else if (q > INTEGER_MAXIMO) erro('quantidade', 'Quantidade acima do limite (' + INTEGER_MAXIMO + ').');
    else corpo.quantidade = q;
    var ca = texto(c.caNumero);
    if (!ca) erro('caNumero', 'Informe o número do CA.');
    else if (ca.length > LIMITES.caNumero) erro('caNumero', 'Número do CA com mais de ' + LIMITES.caNumero + ' caracteres.');
    else corpo.caNumero = ca;
    var validade = texto(c.caValidade);
    if (!validade) erro('caValidade', 'Informe a validade do CA.');
    else if (!dataIso(validade)) erro('caValidade', 'Validade do CA deve ser uma data (AAAA-MM-DD).');
    else corpo.caValidade = validade;
    if (erros.length > 0) return { ok: false, erros: erros };
    return { ok: true, corpo: corpo };
  }

  var CAMPO_DA_ENTRADA_INICIAL = { tamanho: 'tamanhoEntrada', quantidade: 'quantidadeComprada', caNumero: 'caEntrada', caValidade: 'caValidadeEntrada' };

  // Monta o corpo e junta os erros; montarCorpo e montarEdicao decidem o que fazer com eles.
  // opcoes.semClassificacao pula o bloco da classificação (edição sem reclassificar);
  // opcoes.oculos diz se a caixa do grau vale (senão, decide a classificação montada).
  function montarCadastro(campos, opcoes) {
    var c = campos || {};
    var o = opcoes || {};
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

    var cls = o.semClassificacao ? { erros: [], corpo: {} } : classificar(c);
    cls.erros.forEach(function (e) { erro(e.campo, e.mensagem); });
    Object.keys(cls.corpo).forEach(function (k) { corpo[k] = cls.corpo[k]; });
    // Óculos com grau só onde a classificação pede; fora disso a informação não
    // vai, e o servidor grava NULL.
    var oculos = typeof o.oculos === 'boolean' ? o.oculos : estadoClassificacao(cls.corpo).mostrarOculos;
    if (oculos) corpo.oculosComGrau = c.oculosComGrau === true;

    opcional('fabricante', c.fabricante, LIMITES.fabricante, 'Fabricante');
    opcional('codigoInterno', c.codigoInterno, LIMITES.codigoInterno, 'Código interno');
    opcional('descricao', c.descricao, LIMITES.descricao, 'Descrição');

    var unidade = texto(c.unidade).toLowerCase() || 'unidade';
    if (unidade.length > LIMITES.unidade) erro('unidade', 'Unidade com mais de ' + LIMITES.unidade + ' caracteres.');
    else corpo.unidade = unidade;

    var minimo = texto(c.estoqueMinimo);
    if (minimo) {
      var m = inteiro(minimo);
      if (m === null || m < 0) erro('estoqueMinimo', 'Mínimo padrão deve ser um inteiro maior ou igual a zero.');
      else if (m > INTEGER_MAXIMO) erro('estoqueMinimo', 'Mínimo padrão acima do limite (' + INTEGER_MAXIMO + ').');
      else corpo.estoqueMinimo = m;
    }

    var dias = converterPrazo(c.prazo, texto(c.prazoUnidade));
    if (dias === null) erro('prazo', 'Informe o prazo de uso: um número inteiro maior que zero.');
    else if (dias > INTEGER_MAXIMO) erro('prazo', 'Prazo de uso, em dias, acima do limite (' + INTEGER_MAXIMO + ' dias).');
    else corpo.prazoUsoDias = dias;

    var exigeTamanho = exigeTamanhoDoControle(c.controleTamanho);
    if (exigeTamanho === null) erro('controleTamanho', 'Escolha o controle de tamanho: tamanho único ou possui tamanhos.');
    else corpo.exigeTamanho = exigeTamanho;

    // Grade (12G-8): só com "Possui tamanhos"; em branco, o material fica sem grade.
    var grade = [];
    if (exigeTamanho === true) {
      var lida = lerGrade(c.grade);
      if (lida.erro) erro('grade', lida.erro);
      grade = lida.tamanhos;
      if (grade.length > 0) corpo.tamanhos = grade;
    }

    // Entrada inicial só com "Sim" explícito. Ela vira uma entrada separada,
    // registrada depois do cadastro, com o CA e a validade do lote.
    var entrada = null;
    if (texto(c.registrarEntrada) === 'sim') {
      var montada = montarEntrada({ tamanho: c.tamanhoEntrada, quantidade: c.quantidadeComprada, caNumero: c.caEntrada, caValidade: c.caValidadeEntrada }, exigeTamanho === true);
      if (!montada.ok) montada.erros.forEach(function (e) { erro(CAMPO_DA_ENTRADA_INICIAL[e.campo], e.mensagem); });
      else if (grade.length > 0 && grade.indexOf(montada.corpo.tamanho) === -1) erro('tamanhoEntrada', 'Escolha para a entrada inicial um tamanho da grade.');
      else entrada = montada.corpo;
    }
    return { erros: erros, corpo: corpo, entrada: entrada };
  }

  /**
   * Monta o corpo do POST /materiais e a entrada inicial (separada) a
   * partir dos campos da tela, todos como texto. Devolve
   * {ok:true, corpo, entrada|null} ou {ok:false, erros:[{campo, mensagem}]}.
   * Opcionais vazios são omitidos: o servidor grava NULL.
   */
  function montarCorpo(campos) {
    var m = montarCadastro(campos);
    if (m.erros.length > 0) return { ok: false, erros: m.erros };
    return { ok: true, corpo: m.corpo, entrada: m.entrada };
  }

  // ── edição de material existente ──

  /** Prazo gravado em dias → anos (múltiplo de 365), meses (de 30) ou dias; ida e volta exata. */
  function prazoParaCampos(dias) {
    var n = typeof dias === 'number' ? dias : inteiro(dias);
    if (n === null || n === undefined || n <= 0) return { prazoUnidade: 'meses', prazo: '' };
    if (n % 365 === 0) return { prazoUnidade: 'anos', prazo: String(n / 365) };
    if (n % 30 === 0) return { prazoUnidade: 'meses', prazo: String(n / 30) };
    return { prazoUnidade: 'dias', prazo: String(n) };
  }

  /**
   * Data para o campo date (AAAA-MM-DD). A API devolve a data pura; data e
   * hora ainda são aceitas: uso só a parte da data, sem converter fuso.
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
   * V2: grupo, proteção e o id do tipo (ou "Outros" com a especificação).
   * Legado: o grupo e o tipo gravados como estão; fora das opções do HTML, voltam
   * em `opcoesExtras` como opção temporária "(legado)" — nada é trocado em
   * silêncio. Tipo V2 inativado volta como opção "(inativo)". `legado` diz o modelo.
   */
  function camposDoMaterial(material) {
    var m = material || {};
    var v2 = m.modeloClassificacao === MODELO_V2;
    var tipo = texto(m.tipo);
    var categoria = texto(m.categoria);
    var protecao = v2 ? texto(m.grupoProtecao) : '';
    var temId = v2 && m.tipoMaterialId !== null && m.tipoMaterialId !== undefined;
    var unidade = texto(m.unidade);
    var unidadeLista = naLista(UNIDADES, unidade);
    var prazo = prazoParaCampos(m.prazoUsoDias);
    return {
      legado: !v2,
      campos: {
        nome: texto(m.nome),
        categoria: categoria,
        categoriaCustom: v2 && categoria === OUTROS ? texto(m.categoriaDescricao) : '',
        grupoProtecao: protecao,
        grupoProtecaoCustom: protecao === OUTROS ? texto(m.grupoProtecaoDescricao) : '',
        tipo: temId ? String(m.tipoMaterialId) : (tipo === OUTROS ? OUTROS : (v2 ? '' : tipo)),
        tipoCustom: tipo === OUTROS ? texto(m.tipoDescricao) : '',
        fabricante: texto(m.fabricante),
        codigoInterno: texto(m.codigoInterno),
        unidade: unidadeLista || unidade,
        estoqueMinimo: m.estoqueMinimo === null || m.estoqueMinimo === undefined ? '' : String(m.estoqueMinimo),
        prazoUnidade: prazo.prazoUnidade,
        prazo: prazo.prazo,
        controleTamanho: controleDoMaterial(m.exigeTamanho),
        grade: Array.isArray(m.tamanhos) ? m.tamanhos.join(', ') : '',
        oculosComGrau: m.oculosComGrau === true,
        oculosComGrauTocado: false,
        descricao: texto(m.descricao),
        registrarEntrada: 'nao',
        quantidadeComprada: '',
        tamanhoEntrada: '',
        caEntrada: '',
        caValidadeEntrada: '',
      },
      opcoesExtras: {
        categoria: !v2 && categoria && GRUPOS.indexOf(categoria) === -1 ? { valor: categoria, rotulo: categoria + ' (legado)' } : null,
        tipo: temId && m.tipoMaterialAtivo === false ? { valor: String(m.tipoMaterialId), rotulo: tipo + ' (inativo)' }
          : (!v2 && tipo && tipo !== OUTROS ? { valor: tipo, rotulo: tipo + ' (legado)' } : null),
        unidade: unidadeLista || !unidade ? null : { valor: unidade, rotulo: unidade },
      },
    };
  }

  function valorOriginal(campo, valor) {
    if (valor === null || valor === undefined) return null;
    if (campo === 'exigeTamanho' || campo === 'oculosComGrau') return typeof valor === 'boolean' ? valor : null;
    if (campo === 'prazoUsoDias' || campo === 'estoqueMinimo') return Number(valor);
    return texto(valor) || null;
  }

  /**
   * Corpo do PATCH /materiais/:id: só os campos que mudaram em relação ao
   * registro carregado; opcional apagado → null. Mesmas validações do
   * cadastro. Nunca envia unidade, CA, estoque ou empresaId.
   * {ok:true, corpo, alterado} ou {ok:false, erros}.
   */
  function montarEdicao(campos, original) {
    var o = original || {};
    var base = {};
    Object.keys(campos || {}).forEach(function (k) { base[k] = campos[k]; });
    base.registrarEntrada = 'nao';
    // Classificação intocada (inclusive o legado): nada dela vai, e a caixa do grau
    // segue a regra do registro. Tocada: o bloco V2 completo é exigido e vai inteiro.
    var intocada = classificacaoIntocada(base, o);
    var montado = montarCadastro(base, { semClassificacao: intocada, oculos: intocada ? oculosDoMaterial(o) : undefined });
    // Óculos sem a informação (antes dela existir) continuam sem até a pessoa mexer na caixa.
    if (hasOwn(montado.corpo, 'oculosComGrau') && oculosSemClassificacao(o) && base.oculosComGrauTocado !== true) delete montado.corpo.oculosComGrau;
    // Material legado sem prazo ou sem controle de tamanho continua editável sem
    // preencher esses campos; o que já existe nunca pode ser apagado.
    var erros = montado.erros.filter(function (e) {
      if (e.campo === 'prazo' && !texto(base.prazo) && valorOriginal('prazoUsoDias', o.prazoUsoDias) === null) return false;
      if (e.campo === 'controleTamanho' && !texto(base.controleTamanho) && valorOriginal('exigeTamanho', o.exigeTamanho) === null) return false;
      return true;
    });
    if (!texto(base.estoqueMinimo) && !erros.some(function (e) { return e.campo === 'estoqueMinimo'; })) {
      erros.push({ campo: 'estoqueMinimo', mensagem: 'Informe o mínimo padrão (use 0 para nenhum).' });
    }
    if (erros.length > 0) return { ok: false, erros: erros };
    var corpo = {};
    CAMPOS_EDITAVEIS.forEach(function (campo) {
      var novo = hasOwn(montado.corpo, campo) ? montado.corpo[campo] : null;
      if (novo !== valorOriginal(campo, o[campo])) corpo[campo] = novo;
    });
    if (!intocada) {
      ['categoria', 'categoriaDescricao', 'grupoProtecao', 'grupoProtecaoDescricao', 'tipoMaterialId', 'tipo', 'tipoDescricao'].forEach(function (campo) {
        if (hasOwn(montado.corpo, campo)) corpo[campo] = montado.corpo[campo];
      });
    }
    // Grade (12G-8): vai só quando muda; [] apaga, inclusive ao passar a tamanho único.
    var gradeNova = montado.corpo.tamanhos || [];
    var gradeOriginal = Array.isArray(o.tamanhos) ? o.tamanhos : [];
    if (gradeNova.join('\n') !== gradeOriginal.join('\n')) corpo.tamanhos = gradeNova;
    return { ok: true, corpo: corpo, alterado: Object.keys(corpo).length > 0 };
  }

  function motivoDaBaixa(codigo) {
    for (var i = 0; i < MOTIVOS_BAIXA.length; i += 1) if (MOTIVOS_BAIXA[i].codigo === codigo) return MOTIVOS_BAIXA[i];
    return null;
  }

  /**
   * Corpo do POST /estoque/lotes/:loteId/baixas, sem a chave. A quantidade
   * não passa do físico do lote na última consulta; o servidor confere de
   * novo com o saldo atual. Outro exige justificativa.
   * {ok:true, loteId, corpo} ou {ok:false, erros}.
   */
  function montarBaixa(campos, lotes) {
    var c = campos || {};
    var erros = [];
    var erro = function (campo, mensagem) { erros.push({ campo: campo, mensagem: mensagem }); };
    var loteId = inteiro(c.loteId);
    var lote = null;
    (lotes || []).forEach(function (l) { if (l.loteId === loteId) lote = l; });
    if (!lote) erro('lote', 'Selecione o lote da baixa.');
    var q = inteiro(c.quantidade);
    if (q === null || q <= 0) erro('quantidade', 'Informe uma quantidade inteira maior que zero.');
    else if (lote && q > lote.fisico) erro('quantidade', 'Quantidade maior que o saldo físico do lote (' + lote.fisico + ').');
    var motivo = texto(c.motivo);
    if (!motivoDaBaixa(motivo)) erro('motivo', 'Selecione o motivo da baixa.');
    var justificativa = texto(c.justificativa);
    if (justificativa.length > LIMITES.justificativa) erro('justificativa', 'Justificativa com mais de ' + LIMITES.justificativa + ' caracteres.');
    else if (motivo === 'OUTRO' && !justificativa) erro('justificativa', 'Informe a justificativa para o motivo Outro.');
    if (erros.length > 0) return { ok: false, erros: erros };
    var corpo = { quantidade: q, motivo: motivo };
    if (justificativa) corpo.justificativa = justificativa;
    return { ok: true, loteId: loteId, corpo: corpo };
  }

  var formulario = {
    LIMITES: LIMITES,
    INTEGER_MAXIMO: INTEGER_MAXIMO,
    FATORES_PRAZO: FATORES_PRAZO,
    TAMANHOS_GRADE: TAMANHOS_GRADE,
    GRUPOS: GRUPOS,
    GRUPOS_CATALOGO: GRUPOS_CATALOGO,
    GRUPOS_PROTECAO: GRUPOS_PROTECAO,
    PROTECAO_OCULAR: PROTECAO_OCULAR,
    TIPO_OCULOS: TIPO_OCULOS,
    OUTROS: OUTROS,
    TIPOS_OCULOS: TIPOS_OCULOS,
    TIPO_OCULOS_LEGADO: TIPO_OCULOS_LEGADO,
    tiposDoCatalogo: tiposDoCatalogo,
    estadoClassificacao: estadoClassificacao,
    classificacaoIntocada: classificacaoIntocada,
    oculosAplicavel: oculosAplicavel,
    oculosDoMaterial: oculosDoMaterial,
    rotuloClassificacao: rotuloClassificacao,
    grupoEfetivo: grupoEfetivo,
    grupoProtecaoEfetivo: grupoProtecaoEfetivo,
    tipoEfetivo: tipoEfetivo,
    UNIDADES: UNIDADES,
    CONTROLES_TAMANHO: CONTROLES_TAMANHO,
    MOTIVOS_BAIXA: MOTIVOS_BAIXA,
    converterPrazo: converterPrazo,
    textoPrazo: textoPrazo,
    tamanhosSugeridos: tamanhosSugeridos,
    tamanhosDaEntrada: tamanhosDaEntrada,
    lerGrade: lerGrade,
    exigeTamanhoDoControle: exigeTamanhoDoControle,
    controleDoMaterial: controleDoMaterial,
    montarCorpo: montarCorpo,
    montarEntrada: montarEntrada,
    montarBaixa: montarBaixa,
    prazoParaCampos: prazoParaCampos,
    dataParaCampo: dataParaCampo,
    camposDoMaterial: camposDoMaterial,
    montarEdicao: montarEdicao,
    ehOculos: ehOculos,
    oculosSemClassificacao: oculosSemClassificacao,
  };

  // ───────────────────────────────────────────────────────────────────
  // Situação do saldo (Itens Disponíveis também usa esta regra)
  // ───────────────────────────────────────────────────────────────────

  /** 0 → sem estoque; abaixo do mínimo (quando há mínimo) → atenção; senão com saldo. */
  function situacao(quantidade, estoqueMinimo) {
    var q = Number(quantidade) || 0;
    var minimo = Number(estoqueMinimo) || 0;
    if (q <= 0) return 'sem-estoque';
    if (minimo > 0 && q < minimo) return 'abaixo-minimo';
    return 'com-saldo';
  }

  var grade = { situacao: situacao };

  // ───────────────────────────────────────────────────────────────────
  // Idempotência
  // ───────────────────────────────────────────────────────────────────

  // Chaves ordenadas: o mesmo conteúdo dá a mesma assinatura, em qualquer ordem.
  function assinatura(alvo, corpo) {
    var c = corpo || {};
    return JSON.stringify([String(alvo), Object.keys(c).sort().map(function (k) { return [k, c[k]]; })]);
  }

  function gerarChave() {
    var cripto = global.crypto;
    if (!cripto || typeof cripto.randomUUID !== 'function') {
      throw new Error('crypto.randomUUID indisponível: abra a página por HTTPS ou localhost');
    }
    return cripto.randomUUID();
  }

  /**
   * Uma chave por operação lógica. A mesma operação (mesmo alvo e mesmo
   * corpo) repete a chave até dar certo, então repetir depois de uma
   * resposta inconclusiva não duplica o registro. Conteúdo novo ou sucesso
   * geram outra chave.
   */
  function criarOperacao(gerar) {
    var gerador = typeof gerar === 'function' ? gerar : gerarChave;
    var atual = null;
    return {
      chave: function (alvo, corpo) {
        var a = assinatura(alvo, corpo);
        if (!atual || atual.assinatura !== a) atual = { assinatura: a, chave: gerador() };
        return atual.chave;
      },
      concluir: function () { atual = null; },
    };
  }

  var idempotencia = { criar: criarOperacao, assinatura: assinatura };

  // ───────────────────────────────────────────────────────────────────
  // Estoque por lote
  // ───────────────────────────────────────────────────────────────────

  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Lote sem tamanho aparece como "Único"; o valor recebido continua null. */
  function rotuloTamanho(tamanho) {
    return tamanho === null || tamanho === undefined || tamanho === '' ? TAMANHO_UNICO : String(tamanho);
  }

  function rotuloSituacao(situacao) { return hasOwn(SITUACOES_CA, situacao) ? SITUACOES_CA[situacao][0] : texto(situacao); }
  function classeSituacao(situacao) { return hasOwn(SITUACOES_CA, situacao) ? SITUACOES_CA[situacao][1] : 'badge-warning'; }

  /** AAAA-MM-DD → DD/MM/AAAA, sem converter fuso; '' quando não é data. */
  function dataBr(valor) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(texto(valor));
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }

  function linhasLotes(lotes) {
    var numero = function (v) { return '<td style="text-align:right">' + escaparHtml(Number(v) || 0) + '</td>'; };
    return (lotes || []).map(function (l) {
      return '<tr><td>' + escaparHtml(rotuloTamanho(l.tamanho)) + '</td><td>' + escaparHtml(l.caNumero || '—') + '</td><td>' + escaparHtml(dataBr(l.caValidade) || '—') + '</td>'
        + '<td><span class="badge ' + classeSituacao(l.situacaoCa) + '">' + escaparHtml(rotuloSituacao(l.situacaoCa)) + '</span></td>'
        + numero(l.fisico) + numero(l.bloqueado) + numero(l.disponivel) + '</tr>';
    }).join('');
  }

  /** Opções do lote da baixa: só lotes com saldo físico, identificados por tamanho, CA e validade. */
  function opcoesLotes(lotes) {
    return '<option value="">Selecione o lote</option>' + (lotes || []).filter(function (l) { return Number(l.fisico) > 0; }).map(function (l) {
      var partes = [rotuloTamanho(l.tamanho), l.caNumero ? 'CA ' + l.caNumero : 'sem CA'];
      if (l.caValidade) partes.push('val. ' + dataBr(l.caValidade));
      partes.push('físico ' + l.fisico);
      return '<option value="' + escaparHtml(l.loteId) + '">' + escaparHtml(partes.join(' · ')) + '</option>';
    }).join('');
  }

  var estoque = {
    TAMANHO_UNICO: TAMANHO_UNICO,
    rotuloTamanho: rotuloTamanho,
    rotuloSituacao: rotuloSituacao,
    classeSituacao: classeSituacao,
    dataBr: dataBr,
    linhasLotes: linhasLotes,
    opcoesLotes: opcoesLotes,
  };

  // ───────────────────────────────────────────────────────────────────
  // Mensagens
  // ───────────────────────────────────────────────────────────────────

  var MSG = {
    REDE: 'Falha de rede: não foi possível falar com o servidor. Verifique a conexão e tente novamente.',
    CADASTRO_NAO_CONFIRMADO_REDE: 'Falha de rede: não foi possível confirmar se o material foi cadastrado. Confira a lista de materiais antes de repetir o cadastro.',
    CADASTRO_NAO_CONFIRMADO_SERVIDOR: 'Erro no servidor: não foi possível confirmar se o material foi cadastrado. Confira a lista de materiais antes de repetir o cadastro.',
    ENTRADA_NAO_CONFIRMADA_REDE: 'falha de rede: o servidor pode ou não ter registrado a entrada.',
    ENTRADA_NAO_CONFIRMADA_SERVIDOR: 'erro no servidor: a entrada pode ou não ter sido registrada.',
    BAIXA_NAO_CONFIRMADA_REDE: 'falha de rede: o servidor pode ou não ter registrado a baixa.',
    BAIXA_NAO_CONFIRMADA_SERVIDOR: 'erro no servidor: a baixa pode ou não ter sido registrada.',
    ORIENTACAO_REPETIR: 'Confira os lotes do material. Repetir a mesma operação, sem mudar nada, não duplica o registro.',
    SESSAO: 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.',
    SEM_CRIAR: 'Seu perfil não pode cadastrar materiais nesta empresa.',
    SEM_MOVIMENTAR: 'seu perfil não pode movimentar estoque nesta empresa.',
    SEM_VISUALIZAR: 'Seu perfil não pode consultar o estoque nesta empresa.',
    NAO_ENCONTRADO: 'Material não encontrado nesta empresa.',
    CODIGO_DUPLICADO: 'Já existe um material com este código interno nesta empresa. Use outro código ou deixe em branco.',
    // Classificação V2 (mesmos códigos do servidor, em body.<campo>).
    GRUPO_OBRIGATORIO: 'Selecione o grupo do material.',
    GRUPO_INVALIDO: 'Grupo inválido: use EPI, Vestimenta ou Outros.',
    CATEGORIA_DESCRICAO_OBRIGATORIA: 'Com o grupo "Outros", especifique o grupo.',
    CATEGORIA_DESCRICAO_INVALIDA: 'Especificação do grupo inválida: até 100 caracteres, sem caracteres de controle.',
    CATEGORIA_DESCRICAO_NAO_SE_APLICA: 'A especificação do grupo só vale para o grupo "Outros".',
    GRUPO_PROTECAO_OBRIGATORIO: 'Selecione o grupo de proteção.',
    GRUPO_PROTECAO_INVALIDO: 'Grupo de proteção inválido.',
    GRUPO_PROTECAO_NAO_SE_APLICA: 'O grupo de proteção não se aplica ao grupo "Outros".',
    GRUPO_PROTECAO_DESCRICAO_OBRIGATORIA: 'Com o grupo de proteção "Outros", especifique o grupo de proteção.',
    GRUPO_PROTECAO_DESCRICAO_INVALIDA: 'Especificação do grupo de proteção inválida: até 100 caracteres, sem caracteres de controle.',
    GRUPO_PROTECAO_DESCRICAO_NAO_SE_APLICA: 'A especificação do grupo de proteção só vale para "Outros".',
    TIPO_OBRIGATORIO: 'Selecione o tipo no catálogo ou "Outros".',
    TIPO_NAO_SE_APLICA: 'O nome do tipo vem do catálogo: escolha o tipo na lista.',
    TIPO_MATERIAL_NAO_SE_APLICA: 'Com grupo ou grupo de proteção "Outros", o tipo é "Outros" com a especificação.',
    TIPO_MATERIAL_NAO_ENCONTRADO: 'Tipo não encontrado no catálogo desta empresa. Escolha a proteção de novo para atualizar a lista.',
    TIPO_MATERIAL_INCOMPATIVEL: 'O tipo escolhido não pertence a este grupo e grupo de proteção.',
    TIPO_MATERIAL_INATIVO: 'O tipo escolhido está inativo no catálogo: escolha um tipo ativo.',
    TIPO_DESCRICAO_OBRIGATORIA: 'Com o tipo "Outros", especifique o tipo.',
    TIPO_DESCRICAO_NAO_SE_APLICA: 'A especificação do tipo só vale para o tipo "Outros".',
    TIPO_DESCRICAO_INVALIDA: 'Especificação do tipo inválida: até 100 caracteres, sem caracteres de controle.',
    CADASTRO_GENERICO: 'Não foi possível cadastrar o material. Tente novamente.',
    ENTRADA_GENERICO: 'não foi possível registrar a entrada de estoque.',
    BAIXA_GENERICO: 'não foi possível registrar a baixa de estoque.',
    ESTOQUE_GENERICO: 'Não foi possível consultar o estoque deste material.',
    SUCESSO: 'Material cadastrado com sucesso.',
    SEM_ESTOQUE_INICIAL: 'Registrado sem quantidade em estoque: nenhuma entrada inicial foi feita.',
    SEM_EDITAR: 'Seu perfil não pode editar materiais nesta empresa.',
    EDICAO_SUCESSO: 'Alterações do material salvas. O estoque não foi alterado.',
    EDICAO_SEM_ALTERACAO: 'Nenhuma alteração para salvar.',
    EDICAO_NAO_CONFIRMADA_REDE: 'Falha de rede: não foi possível confirmar se as alterações foram salvas. Cancele a edição e abra o material de novo para conferir antes de salvar outra vez.',
    EDICAO_NAO_CONFIRMADA_SERVIDOR: 'Erro no servidor: não foi possível confirmar se as alterações foram salvas. Cancele a edição e abra o material de novo para conferir antes de salvar outra vez.',
    EDICAO_GENERICO: 'Não foi possível salvar as alterações. Tente novamente.',
    TAMANHO_SALDO_INCOMPATIVEL: 'Não foi possível mudar o controle de tamanho: há saldo em estoque em lotes que não combinam com a nova configuração. Dê baixa nesses lotes antes de mudar.',
    TAMANHO_MINIMOS_INCOMPATIVEIS: 'Não foi possível mudar o controle de tamanho: o material tem mínimos por tamanho configurados. Remova esses mínimos (cartão "Estoque mínimo por tamanho") antes de mudar.',
    // Minúscula inicial: compõe com "Baixa não realizada: ...". Não diz qual solicitação, de quem nem quanto.
    BAIXA_SALDO_LIVRE: 'o saldo físico existe, mas esta baixa reduziria o estoque comprometido com solicitações já aprovadas. Devolução ao fornecedor e "Outro" só podem usar o saldo livre. Registre o motivo conforme o que realmente aconteceu com o item.',
    AVISO_MOTIVO_SALDO_LIVRE: 'Esta baixa só pode usar o saldo livre: não pode reduzir o estoque comprometido com solicitações já aprovadas.',
    CARREGAR_GENERICO: 'Não foi possível abrir o material para edição.',
    OCULOS_OBRIGATORIO: 'Informe se os óculos de proteção são com grau: marque "Óculos com grau" ou deixe desmarcado para sem grau.',
    OCULOS_NAO_SE_APLICA: '"Óculos com grau" só vale para os tipos de óculos de proteção (Incolor e Ampla Visão).',
    GRADE_EM_USO: 'Não foi possível salvar a grade: um tamanho que saiu dela ainda tem saldo em estoque, mínimo próprio ou solicitação em aberto. Mantenha esse tamanho na grade ou resolva antes o que o usa.',
    GRADE_INCOMPATIVEL: 'Para passar a tamanho único, apague a grade de tamanhos deste material na mesma alteração.',
    GRADE_REPETIDA: 'A grade tem um tamanho repetido.',
    GRADE_NAO_SE_APLICA: 'Material de tamanho único não tem grade de tamanhos.',
    GRADE_TAMANHO_INVALIDO: 'Cada tamanho da grade precisa ter de 1 a 20 caracteres.',
    GRADE_GRANDE_DEMAIS: 'A grade aceita até 50 tamanhos.',
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

  function temDetalhe(r, codigo) {
    return (r && Array.isArray(r.detalhes) ? r.detalhes : []).some(function (d) { return !!d && d.codigo === codigo; });
  }

  function temDetalheNaGrade(r, codigo) {
    return (r && Array.isArray(r.detalhes) ? r.detalhes : []).some(function (d) {
      return !!d && d.codigo === codigo && typeof d.campo === 'string' && d.campo.indexOf('body.tamanhos') === 0;
    });
  }

  /** Recusa da grade de tamanhos (12G-8), no cadastro ou na edição; null quando não é o caso. */
  function erroGrade(r) {
    if (temDetalheNaGrade(r, 'TAMANHO_REPETIDO')) return MSG.GRADE_REPETIDA;
    if (temDetalheNaGrade(r, 'GRADE_NAO_SE_APLICA')) return MSG.GRADE_NAO_SE_APLICA;
    if (temDetalheNaGrade(r, 'TAMANHO_INVALIDO')) return MSG.GRADE_TAMANHO_INVALIDO;
    if (temDetalheNaGrade(r, 'TAMANHO_MAXIMO')) return MSG.GRADE_GRANDE_DEMAIS;
    return null;
  }

  /** Recusa da regra dos óculos com grau, no cadastro ou na edição; null quando não é o caso. */
  function erroOculos(r) {
    if (temDetalhe(r, 'OCULOS_COM_GRAU_OBRIGATORIO')) return MSG.OCULOS_OBRIGATORIO;
    if (temDetalhe(r, 'OCULOS_COM_GRAU_NAO_SE_APLICA')) return MSG.OCULOS_NAO_SE_APLICA;
    return null;
  }

  var CODIGOS_CLASSIFICACAO = [
    'GRUPO_OBRIGATORIO', 'GRUPO_INVALIDO', 'CATEGORIA_DESCRICAO_OBRIGATORIA', 'CATEGORIA_DESCRICAO_INVALIDA', 'CATEGORIA_DESCRICAO_NAO_SE_APLICA',
    'GRUPO_PROTECAO_OBRIGATORIO', 'GRUPO_PROTECAO_INVALIDO', 'GRUPO_PROTECAO_NAO_SE_APLICA', 'GRUPO_PROTECAO_DESCRICAO_OBRIGATORIA',
    'GRUPO_PROTECAO_DESCRICAO_INVALIDA', 'GRUPO_PROTECAO_DESCRICAO_NAO_SE_APLICA', 'TIPO_OBRIGATORIO', 'TIPO_NAO_SE_APLICA', 'TIPO_MATERIAL_NAO_SE_APLICA',
    'TIPO_MATERIAL_NAO_ENCONTRADO', 'TIPO_MATERIAL_INCOMPATIVEL', 'TIPO_MATERIAL_INATIVO', 'TIPO_DESCRICAO_OBRIGATORIA', 'TIPO_DESCRICAO_NAO_SE_APLICA',
    'TIPO_DESCRICAO_INVALIDA',
  ];

  /** Recusa da classificação (grupo, grupo de proteção, tipo ou especificação de "Outros"), no cadastro ou na edição; null quando não é o caso. */
  function erroClassificacao(r) {
    for (var i = 0; i < CODIGOS_CLASSIFICACAO.length; i += 1) if (temDetalhe(r, CODIGOS_CLASSIFICACAO[i])) return MSG[CODIGOS_CLASSIFICACAO[i]];
    return null;
  }

  function erroCadastro(r) {
    if (ehRede(r)) return MSG.CADASTRO_NAO_CONFIRMADO_REDE;
    if (ehServidor(r)) return MSG.CADASTRO_NAO_CONFIRMADO_SERVIDOR;
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return MSG.SEM_CRIAR;
    if (r.codigo === 'MATERIAL_CODIGO_INTERNO_DUPLICADO') return MSG.CODIGO_DUPLICADO;
    if (erroGrade(r)) return erroGrade(r);
    if (erroOculos(r)) return erroOculos(r);
    if (erroClassificacao(r)) return erroClassificacao(r);
    if (r.status === 400) return 'Dados recusados pelo servidor.' + camposDe(r);
    return MSG.CADASTRO_GENERICO;
  }

  /** Minúscula inicial: compõe com "Entrada não realizada: ...". */
  function erroEntrada(r) {
    if (ehRede(r)) return MSG.ENTRADA_NAO_CONFIRMADA_REDE;
    if (ehServidor(r)) return MSG.ENTRADA_NAO_CONFIRMADA_SERVIDOR;
    if (r.status === 401) return 'sua sessão terminou.';
    if (r.status === 403) return MSG.SEM_MOVIMENTAR;
    if (r.status === 404) return 'material não encontrado nesta empresa.';
    if (r.codigo === 'MATERIAL_INATIVO') return 'o material está inativo.';
    if (r.codigo === 'MATERIAL_TAMANHO_NAO_CLASSIFICADO') return 'defina no cadastro o controle de tamanho do material (tamanho único ou possui tamanhos).';
    if (r.codigo === 'IDEMPOTENCIA_CONFLITO') return 'esta operação conflita com outra já registrada; atualize os lotes e tente de novo.';
    if (temDetalhe(r, 'CA_VENCIDO')) return 'CA vencido: a validade precisa ser hoje ou uma data futura.';
    if (temDetalhe(r, 'TAMANHO_OBRIGATORIO')) return 'informe o tamanho: este material possui tamanhos.';
    if (temDetalhe(r, 'TAMANHO_NAO_SE_APLICA')) return 'este material é de tamanho único: a entrada não leva tamanho.';
    if (temDetalhe(r, 'TAMANHO_FORA_DA_GRADE')) return 'este tamanho não está na grade do material: escolha um tamanho da grade.';
    if (r.status === 400) return 'dados da entrada recusados pelo servidor.' + camposDe(r);
    return MSG.ENTRADA_GENERICO;
  }

  /** Minúscula inicial: compõe com "Baixa não realizada: ...". */
  function erroBaixa(r) {
    if (ehRede(r)) return MSG.BAIXA_NAO_CONFIRMADA_REDE;
    if (ehServidor(r)) return MSG.BAIXA_NAO_CONFIRMADA_SERVIDOR;
    if (r.status === 401) return 'sua sessão terminou.';
    if (r.status === 403) return MSG.SEM_MOVIMENTAR;
    if (r.status === 404) return 'lote não encontrado nesta empresa.';
    if (r.codigo === 'SALDO_LOTE_INSUFICIENTE') return 'quantidade maior que o saldo atual do lote.';
    if (r.codigo === 'SALDO_LIVRE_INSUFICIENTE') return MSG.BAIXA_SALDO_LIVRE;
    if (r.codigo === 'IDEMPOTENCIA_CONFLITO') return 'esta operação conflita com outra já registrada; atualize os lotes e tente de novo.';
    if (temDetalhe(r, 'JUSTIFICATIVA_OBRIGATORIA')) return 'informe a justificativa para o motivo Outro.';
    if (r.status === 400) return 'dados da baixa recusados pelo servidor.' + camposDe(r);
    return MSG.BAIXA_GENERICO;
  }

  function erroEstoque(r) {
    if (ehRede(r)) return 'Falha de rede ao consultar o estoque. Verifique a conexão e tente novamente.';
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return MSG.SEM_VISUALIZAR;
    if (r.status === 404) return MSG.NAO_ENCONTRADO;
    return MSG.ESTOQUE_GENERICO;
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
    if (r.codigo === 'MATERIAL_TAMANHO_SALDO_INCOMPATIVEL') return MSG.TAMANHO_SALDO_INCOMPATIVEL;
    if (r.codigo === 'MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS') return MSG.TAMANHO_MINIMOS_INCOMPATIVEIS;
    if (r.codigo === 'MATERIAL_GRADE_TAMANHO_EM_USO') return MSG.GRADE_EM_USO;
    if (r.codigo === 'MATERIAL_TAMANHO_GRADE_INCOMPATIVEL') return MSG.GRADE_INCOMPATIVEL;
    if (erroGrade(r)) return erroGrade(r);
    if (erroOculos(r)) return erroOculos(r);
    if (erroClassificacao(r)) return erroClassificacao(r);
    if (r.status === 400) return 'Dados recusados pelo servidor.' + camposDe(r);
    return MSG.EDICAO_GENERICO;
  }

  /** GET /tipos-material para o seletor de tipo do material; o cadastro continua possível com "Outros". */
  function erroCatalogo(r) {
    if (ehRede(r)) return 'Falha de rede ao consultar o catálogo de tipos. Verifique a conexão e escolha o grupo de proteção de novo.';
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return 'Seu perfil não pode consultar o catálogo de tipos nesta empresa.';
    return 'Não foi possível consultar o catálogo de tipos. Escolha o grupo de proteção de novo para tentar outra vez.';
  }

  /** GET /materiais/:id ao entrar no modo edição. */
  function erroCarregarEdicao(r) {
    if (ehRede(r)) return 'Falha de rede ao abrir o material. Verifique a conexão e tente novamente.';
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return 'Seu perfil não pode consultar este material nesta empresa.';
    if (r.status === 404) return MSG.NAO_ENCONTRADO;
    return MSG.CARREGAR_GENERICO;
  }

  /** "12 no tamanho 42" ou "12 (tamanho único)". */
  function descreverEntrada(e) {
    var d = e || {};
    return d.quantidade + (d.tamanho ? ' no tamanho ' + d.tamanho : ' (tamanho único)');
  }

  /** Texto final do cadastro: sucesso, com ou sem a entrada inicial. */
  function resultado(res) {
    var e = res && res.entrada ? res.entrada : { solicitada: false };
    if (!e.solicitada) return MSG.SUCESSO + ' ' + MSG.SEM_ESTOQUE_INICIAL;
    if (e.realizada) return MSG.SUCESSO + ' Entrada inicial registrada: ' + descreverEntrada(e) + '.';
    if (e.motivo === 'NAO_CONFIRMADO') {
      var m = res.material || {};
      var identificacao = 'nº ' + m.id + (m.codigoInterno ? ', código ' + m.codigoInterno : '') + (m.nome ? ', "' + m.nome + '"' : '');
      return 'Material cadastrado com sucesso (' + identificacao + '). Entrada inicial não confirmada: ' + erroEntrada(e.resposta) + ' ' + MSG.ORIENTACAO_REPETIR;
    }
    var motivo = e.motivo === 'SEM_PERMISSAO' ? MSG.SEM_MOVIMENTAR : erroEntrada(e.resposta);
    return MSG.SUCESSO + ' Entrada inicial não realizada: ' + motivo;
  }

  /** Resultado da entrada em material já cadastrado. `corpo` é o que foi enviado; `material` identifica. */
  function resultadoEntrada(r, corpo, material) {
    var m = material || {};
    var onde = m.nome ? ' em "' + m.nome + '"' : '';
    if (r && r.ok) {
      if (r.repetida) return 'Esta entrada já estava registrada' + onde + '; nada foi duplicado.';
      return 'Entrada registrada' + onde + ': ' + descreverEntrada(corpo) + '.';
    }
    var resposta = r ? r.resposta : null;
    if (r && r.confirmado === false) return 'Entrada não confirmada: ' + erroEntrada(resposta) + ' ' + MSG.ORIENTACAO_REPETIR;
    return 'Entrada não realizada: ' + erroEntrada(resposta);
  }

  /** Resultado da baixa. `lote` é o lote escolhido na última consulta. */
  function resultadoBaixa(r, corpo, lote) {
    var l = lote || {};
    var qual = ' do lote ' + rotuloTamanho(l.tamanho) + (l.caNumero ? ' (CA ' + l.caNumero + ')' : '');
    if (r && r.ok) {
      if (r.repetida) return 'Esta baixa já estava registrada; nada foi duplicado.';
      return 'Baixa registrada: ' + (corpo ? corpo.quantidade : '') + qual + '.';
    }
    var resposta = r ? r.resposta : null;
    if (r && r.confirmado === false) return 'Baixa não confirmada: ' + erroBaixa(resposta) + ' ' + MSG.ORIENTACAO_REPETIR;
    return 'Baixa não realizada: ' + erroBaixa(resposta);
  }

  // Só as baixas discricionárias dependem do saldo livre; os fatos físicos (avaria, perda, descarte, CA vencido, ajuste) não ganham dica.
  function avisoMotivoBaixa(motivo) {
    return motivo === 'DEVOLUCAO_FORNECEDOR' || motivo === 'OUTRO' ? MSG.AVISO_MOTIVO_SALDO_LIVRE : '';
  }

  var mensagens = {
    avisoMotivoBaixa: avisoMotivoBaixa,
    exigeNovoLogin: exigeNovoLogin, confirmado: confirmado, erroCadastro: erroCadastro, erroEntrada: erroEntrada, erroBaixa: erroBaixa,
    erroEstoque: erroEstoque, erroEdicao: erroEdicao, erroCarregarEdicao: erroCarregarEdicao, erroCatalogo: erroCatalogo, resultado: resultado,
    resultadoEntrada: resultadoEntrada, resultadoBaixa: resultadoBaixa, MSG: MSG,
  };

  // ───────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────

  function opcoesMateriais(lista) {
    return (lista || []).map(function (m) {
      var rotulo = m.nome + (m.codigoInterno ? ' · ' + m.codigoInterno : '');
      return '<option value="' + escaparHtml(m.id) + '">' + escaparHtml(rotulo) + '</option>';
    }).join('');
  }

  /** A primeira opção é vazia: nenhum tamanho é escolhido automaticamente. */
  function opcoesTamanhos(lista) {
    return '<option value="">Selecione o tamanho</option>'
      + (lista || []).map(function (t) { return '<option value="' + escaparHtml(t) + '">' + escaparHtml(t) + '</option>'; }).join('');
  }

  /** Opções do grupo de proteção: placeholder, os doze grupos e "Outros". Nada é escolhido sozinho. */
  function opcoesProtecao() {
    return '<option value="">Selecione</option>' + GRUPOS_PROTECAO.concat([OUTROS]).map(function (p) {
      return '<option value="' + escaparHtml(p) + '">' + escaparHtml(p) + '</option>';
    }).join('');
  }

  /**
   * Opções do tipo: placeholder, os tipos ATIVOS recebidos (valor = id do
   * catálogo), "Outros" e, se houver, a opção temporária do registro aberto
   * (tipo legado ou tipo inativado). `tipos` null = ainda sem grupo de proteção:
   * só o placeholder (nem "Outros"). Tudo escapado.
   */
  function opcoesTipos(tipos, extra) {
    var html = '<option value="">Selecione</option>' + (tipos === null ? '' : (tipos || []).map(function (t) {
      return '<option value="' + escaparHtml(t.id) + '">' + escaparHtml(t.nome) + '</option>';
    }).join('') + '<option value="' + escaparHtml(OUTROS) + '">' + escaparHtml(OUTROS) + '</option>');
    if (extra && extra.valor) html += '<option value="' + escaparHtml(extra.valor) + '">' + escaparHtml(extra.rotulo) + '</option>';
    return html;
  }

  var render = { escaparHtml: escaparHtml, opcoesMateriais: opcoesMateriais, opcoesTamanhos: opcoesTamanhos, opcoesProtecao: opcoesProtecao, opcoesTipos: opcoesTipos };

  // ───────────────────────────────────────────────────────────────────
  // Fluxo
  // ───────────────────────────────────────────────────────────────────

  // Envia com a chave da operação. Só o sucesso a conclui: depois de uma
  // resposta inconclusiva, repetir o mesmo conteúdo reaproveita a chave.
  async function comChave(enviar, operacao, alvo, corpo) {
    var op = operacao || criarOperacao();
    var envio = {};
    Object.keys(corpo || {}).forEach(function (k) { envio[k] = corpo[k]; });
    envio.chaveIdempotencia = op.chave(alvo, corpo);
    var r = await enviar(alvo, envio);
    if (!r.ok) return { ok: false, confirmado: confirmado(r), resposta: r, lote: null, repetida: false };
    op.concluir();
    var d = r.dados || {};
    return { ok: true, confirmado: true, resposta: r, lote: d.lote || null, operacao: d.operacao || null, repetida: d.repetida === true };
  }

  /** Entrada por lote em material já cadastrado; nunca PATCH do material. */
  function registrarEntrada(materialId, corpo, operacao) {
    return comChave(acoes.entrada, operacao, materialId, corpo);
  }

  /** Baixa manual no lote escolhido. */
  function registrarBaixa(loteId, corpo, operacao) {
    return comChave(acoes.baixa, operacao, loteId, corpo);
  }

  /**
   * 1) POST /materiais. Recusado → {ok:false, etapa:'cadastro', resposta}.
   * 2) Só depois do 201, e só se houver entrada e a pessoa tiver
   *    MOVIMENTAR_ESTOQUE, a entrada inicial como operação separada. Recusa
   *    ou falha da entrada NÃO desfaz o cadastro e não é repetida sozinha.
   * A entrada usa a mesma `idempotencia` da página: repetir essa entrada
   * depois, sem mudar nada, reaproveita a chave.
   */
  async function cadastrar(opcoes) {
    var o = opcoes || {};
    var r = await acoes.criar(o.corpo);
    if (!r.ok) return { ok: false, etapa: 'cadastro', confirmado: confirmado(r), resposta: r };
    var material = r.dados && r.dados.material ? r.dados.material : null;
    var entrada = o.entrada || null;
    var e = {
      solicitada: !!entrada, realizada: false, motivo: null, resposta: null, lote: null,
      tamanho: entrada ? entrada.tamanho : undefined, quantidade: entrada ? entrada.quantidade : undefined,
    };
    if (!entrada) return { ok: true, material: material, entrada: e };
    if (!o.podeMovimentar) {
      e.motivo = 'SEM_PERMISSAO';
      return { ok: true, material: material, entrada: e };
    }
    var feita = await registrarEntrada(material.id, entrada, o.idempotencia);
    e.realizada = feita.ok;
    e.motivo = feita.ok ? null : (feita.confirmado ? 'RECUSADA' : 'NAO_CONFIRMADO');
    e.resposta = feita.resposta;
    e.lote = feita.lote;
    return { ok: true, material: material, entrada: e };
  }

  /** GET /materiais/:id/estoque/lotes → material, lotes com saldo e totais. */
  async function carregarEstoque(materialId) {
    var r = await acoes.lotes(materialId);
    if (!r.ok) return { ok: false, resposta: r };
    var d = r.dados || {};
    return {
      ok: true,
      material: d.material || {},
      lotes: Array.isArray(d.lotes) ? d.lotes : [],
      totais: d.totais || { fisico: 0, bloqueado: 0, disponivel: 0 },
      hoje: d.hoje || null,
    };
  }

  var fluxo = { cadastrar: cadastrar, carregarEstoque: carregarEstoque, registrarEntrada: registrarEntrada, registrarBaixa: registrarBaixa };

  global.EpiMateriais = {
    acoes: acoes,
    formulario: formulario,
    grade: grade,
    idempotencia: idempotencia,
    estoque: estoque,
    mensagens: mensagens,
    render: render,
    fluxo: fluxo,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiMateriais;
  }
})(typeof window !== 'undefined' ? window : globalThis);
