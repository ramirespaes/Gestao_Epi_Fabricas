(function (global) {
  'use strict';

  /**
   * EpiImportacaoGhe — importação de GHE / EPIs no navegador (Incremento 6C).
   *
   * O arquivo .xlsx é lido AQUI, pela biblioteca local já existente (vendor/read-excel-file, global readXlsxFile, injetada
   * como na importação de funcionários); o servidor recebe só JSON e é a autoridade de tudo o que é regra de negócio
   * (normalização do código, correspondência de GHE e de EPI, classificação, conflitos, duplicatas, situação do vínculo).
   * O navegador lê, estrutura, valida o mínimo (formato, colunas, 1000 linhas) e apresenta.
   *
   *   arquivo   — verificar (só .xlsx) e lerXlsx (primeira aba).
   *   planilha  — montarLinhas: matriz → [{ ghe, descricao, epi, classificacao, linha }], com a linha real da planilha.
   *   acoes     — previa e confirmar: POST com corpo SÓ { linhas } (a confirmação reenvia as linhas ORIGINAIS).
   *   rotulos   — textos humanos dos códigos do servidor.
   *   render    — resumo e tabelas, tudo escapado.
   *   mensagens — textos de erro locais e da API.
   *
   * Nada é dividido em lotes: o arquivo inteiro vai numa requisição (conflitos internos exigem enxergar o arquivo todo e
   * a confirmação é atômica). Nada vai para armazenamento local.
   */

  var CAMINHO = '/grupos-homogeneos/importacao';
  var LIMITE_LINHAS = 1000;
  var LIMITE_ARQUIVO_BYTES = 10 * 1024 * 1024;
  var CABECALHO_MAXIMO_LINHAS = 10;

  function http() {
    if (!global.EpiHttp) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/importacao-ghe.js');
    return global.EpiHttp;
  }
  function texto(v) { return v === null || v === undefined ? '' : String(v); }

  // ─── Arquivo ───────────────────────────────────────────────────────
  function extensao(nome) {
    var m = /\.([a-z0-9]+)$/i.exec(texto(nome));
    return m ? m[1].toLowerCase() : '';
  }

  /** {nome, tamanho, inicio: Uint8Array com os primeiros bytes} → {ok:true} ou {ok:false, codigo}. */
  function verificar(a) {
    var dados = a || {};
    var ext = extensao(dados.nome);
    if (ext === 'xls') return { ok: false, codigo: 'FORMATO_XLS' };
    if (ext !== 'xlsx') return { ok: false, codigo: 'FORMATO_INVALIDO' };
    if (!dados.tamanho) return { ok: false, codigo: 'ARQUIVO_VAZIO' };
    if (dados.tamanho > LIMITE_ARQUIVO_BYTES) return { ok: false, codigo: 'ARQUIVO_GRANDE' };
    var b = dados.inicio || new Uint8Array();
    if (!(b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04)) return { ok: false, codigo: 'CONTEUDO_INCOMPATIVEL' };
    return { ok: true };
  }

  /** .xlsx pela biblioteca local (read-excel-file): só a primeira aba. */
  async function lerXlsx(arquivoXlsx, leitor) {
    var ler = leitor || global.readXlsxFile;
    if (typeof ler !== 'function') return { ok: false, codigo: 'XLSX_ILEGIVEL' };
    try {
      var r = await ler(arquivoXlsx);
      var dados = Array.isArray(r) && r[0] && Array.isArray(r[0].data) ? r[0].data : null;
      return dados ? { ok: true, linhas: dados } : { ok: false, codigo: 'XLSX_ILEGIVEL' };
    } catch (e) {
      return { ok: false, codigo: 'XLSX_ILEGIVEL' };
    }
  }

  var arquivo = { verificar: verificar, lerXlsx: lerXlsx };

  // ─── Planilha ──────────────────────────────────────────────────────
  // Reconhecimento conservador do cabeçalho: sem diferenciar caixa, com e sem acento; nada aproximado.
  var COLUNAS = [
    { chave: 'ghe', rotulo: 'GHE', nomes: ['ghe'] },
    { chave: 'descricao', rotulo: 'DESCRIÇÃO', nomes: ['descrição', 'descricao'] },
    { chave: 'epi', rotulo: 'EPI', nomes: ['epi'] },
    { chave: 'classificacao', rotulo: 'CLASSIFICAÇÃO', nomes: ['classificação', 'classificacao'] },
  ];
  function normalizarCabecalho(v) { return texto(v).trim().toLowerCase().replace(/\s+/g, ' '); }
  function chaveDoCabecalho(v) {
    var n = normalizarCabecalho(v);
    for (var i = 0; i < COLUNAS.length; i += 1) if (COLUNAS[i].nomes.indexOf(n) !== -1) return COLUNAS[i].chave;
    return null;
  }

  function celulaVazia(v) { return v === null || v === undefined || v === ''; }
  function brancaOuVazia(v) { return celulaVazia(v) || texto(v).trim() === ''; }
  // O valor segue como está na planilha (nada é corrigido aqui); só o tipo vira texto.
  function valorDaCelula(v) {
    if (celulaVazia(v)) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    return typeof v === 'string' ? v : String(v);
  }

  function localizarCabecalho(matriz) {
    var limite = Math.min(matriz.length, CABECALHO_MAXIMO_LINHAS);
    for (var i = 0; i < limite; i += 1) {
      var posicoes = {};
      (Array.isArray(matriz[i]) ? matriz[i] : []).forEach(function (celula, coluna) {
        var chave = chaveDoCabecalho(celula);
        if (chave && posicoes[chave] === undefined) posicoes[chave] = coluna;
      });
      if (Object.keys(posicoes).length > 0) return { indice: i, posicoes: posicoes };
    }
    return null;
  }

  /**
   * @returns {{ok:true, linhas:Array, ignoradas:number, total:number}
   *   | {ok:false, codigo:'COLUNAS_AUSENTES', faltando:string[]} | {ok:false, codigo:'SEM_DADOS'}
   *   | {ok:false, codigo:'LINHAS_EXCEDIDAS', total:number}}
   */
  function montarLinhas(matriz) {
    var entrada = Array.isArray(matriz) ? matriz : [];
    var cabecalho = localizarCabecalho(entrada);
    var posicoes = cabecalho ? cabecalho.posicoes : {};
    var faltando = COLUNAS.filter(function (c) { return posicoes[c.chave] === undefined; }).map(function (c) { return c.rotulo; });
    if (faltando.length > 0) return { ok: false, codigo: 'COLUNAS_AUSENTES', faltando: faltando };

    var linhas = [];
    var ignoradas = 0;
    for (var i = cabecalho.indice + 1; i < entrada.length; i += 1) {
      var celulas = Array.isArray(entrada[i]) ? entrada[i] : [];
      var item = { ghe: null, descricao: null, epi: null, classificacao: null, linha: i + 1 };
      var algumaCoisa = false;
      COLUNAS.forEach(function (c) {
        var bruto = celulas[posicoes[c.chave]];
        item[c.chave] = valorDaCelula(bruto);
        if (!brancaOuVazia(bruto)) algumaCoisa = true;
      });
      if (!algumaCoisa) { ignoradas += 1; } else { linhas.push(item); }
    }
    if (linhas.length === 0) return { ok: false, codigo: 'SEM_DADOS' };
    // Mais de 1000: bloqueia. Nunca trunca nem divide em lotes.
    if (linhas.length > LIMITE_LINHAS) return { ok: false, codigo: 'LINHAS_EXCEDIDAS', total: linhas.length };
    return { ok: true, linhas: linhas, ignoradas: ignoradas, total: linhas.length };
  }

  var planilha = { COLUNAS: COLUNAS, LIMITE_LINHAS: LIMITE_LINHAS, montarLinhas: montarLinhas };

  // ─── Ações ─────────────────────────────────────────────────────────
  // Corpo SÓ { linhas }: nada que o servidor calcula (situação, ids, resumo, importacaoId) volta como autoridade.
  var acoes = {
    previa: function (linhas) { return http().requisitar('POST', CAMINHO + '/preview', { corpo: { linhas: linhas } }); },
    confirmar: function (linhas) { return http().requisitar('POST', CAMINHO + '/confirmar', { corpo: { linhas: linhas } }); },
  };

  // ─── Rótulos ───────────────────────────────────────────────────────
  var SITUACAO = {
    NOVO_VINCULO: 'Novo vínculo', VINCULO_EXISTENTE: 'Vínculo existente', CLASSIFICACAO_ALTERADA: 'Classificação será alterada',
    EPI_NAO_ENCONTRADO: 'EPI não encontrado', EPI_AMBIGUO: 'EPI ambíguo', EPI_INATIVO: 'EPI inativo', GHE_INATIVO: 'GHE inativo',
    CONFLITO_GHE: 'Conflito de GHE', GHE_AMBIGUO: 'GHE ambíguo', DUPLICADA_NO_ARQUIVO: 'Linha duplicada',
    CONFLITO_NO_ARQUIVO: 'Conflito no arquivo', LINHA_INVALIDA: 'Linha inválida',
  };
  var SITUACAO_GHE = {
    GHE_NOVO: 'Novo GHE', GHE_EXISTENTE: 'GHE existente', LEGADO_RECEBERA_CODIGO: 'GHE existente receberá código',
    CONFLITO_GHE: 'Conflito de GHE', AMBIGUO: 'GHE ambíguo',
  };
  var RESULTADO_LINHA = { APLICADA: 'Aplicada', SEM_ALTERACAO: 'Sem alteração', BLOQUEADA: 'Não aplicada' };
  var RESULTADO_GHE = { CRIADO: 'GHE criado', CODIGO_ATRIBUIDO: 'Código atribuído ao GHE', SEM_ALTERACAO: 'Sem alteração', BLOQUEADO: 'Não aplicado' };
  var CLASSIFICACAO = { OBRIGATORIO: 'Obrigatório', NAO_OBRIGATORIO: 'Não obrigatório' };
  var MOTIVO = {
    CODIGO_COM_DESCRICAO_DIFERENTE: 'O código já existe com outra descrição.',
    DESCRICAO_COM_OUTRO_CODIGO: 'A descrição já pertence a um GHE com outro código.',
    DESCRICAO_DIVERGENTE_NO_ARQUIVO: 'O mesmo código aparece com descrições diferentes no arquivo.',
    DESCRICAO_REPETIDA_NO_ARQUIVO: 'A mesma descrição aparece com códigos diferentes no arquivo.',
  };
  var PROBLEMA = {
    GHE_CODIGO_OBRIGATORIO: 'Informe o código do GHE.',
    GHE_CODIGO_INVALIDO: 'Código inválido: use GHE- e 3 a 6 dígitos.',
    DESCRICAO_OBRIGATORIA: 'Informe a descrição.',
    DESCRICAO_INVALIDA: 'Descrição inválida (até 150 caracteres, sem caracteres de controle).',
    EPI_OBRIGATORIO: 'Informe o EPI.',
    EPI_INVALIDO: 'EPI inválido.',
    CLASSIFICACAO_OBRIGATORIA: 'Informe a classificação.',
    CLASSIFICACAO_INVALIDA: 'Classificação inválida: use Obrigatório ou Não obrigatório.',
  };
  function tem(mapa, chave) { return Object.prototype.hasOwnProperty.call(mapa, chave); }
  var rotulos = {
    situacao: function (c) { return tem(SITUACAO, c) ? SITUACAO[c] : 'Situação não reconhecida'; },
    situacaoGhe: function (c) { return tem(SITUACAO_GHE, c) ? SITUACAO_GHE[c] : 'GHE não reconhecido'; },
    resultadoLinha: function (c) { return tem(RESULTADO_LINHA, c) ? RESULTADO_LINHA[c] : 'Resultado não reconhecido'; },
    resultadoGhe: function (c) { return tem(RESULTADO_GHE, c) ? RESULTADO_GHE[c] : 'Resultado não reconhecido'; },
    classificacao: function (c) { return tem(CLASSIFICACAO, c) ? CLASSIFICACAO[c] : '—'; },
    motivo: function (c) { return tem(MOTIVO, c) ? MOTIVO[c] : 'Conflito não reconhecido.'; },
    problema: function (c) { return tem(PROBLEMA, c) ? PROBLEMA[c] : 'Valor inválido.'; },
  };

  // ─── Diferenças ────────────────────────────────────────────────────
  // O servidor já classifica cada linha (aplicavel) e cada GHE (operacao); aqui só se separa o que grava do que já está em dia.
  // Não basta olhar resumo.aplicaveis: um GHE legado que só vai receber código tem 0 linhas aplicáveis e ainda assim muda.
  var SEM_ALTERACAO_SITUACAO = 'VINCULO_EXISTENTE';
  function semAlteracaoDaLinha(l) { return l.aplicavel !== true && l.situacao === SEM_ALTERACAO_SITUACAO; }

  var diferencas = {
    resumir: function (dados) {
      var linhas = (dados && dados.linhas) || [];
      var ghes = (dados && dados.ghes) || [];
      var importaveis = linhas.filter(function (l) { return l.aplicavel === true; });
      var semAlteracao = linhas.filter(semAlteracaoDaLinha).length;
      var novosGhes = ghes.filter(function (g) { return g.operacao === 'CRIAR'; }).length;
      var ghesComCodigo = ghes.filter(function (g) { return g.operacao === 'ATRIBUIR_CODIGO'; }).length;
      return {
        analisadas: linhas.length,
        importaveis: importaveis.length,
        semAlteracao: semAlteracao,
        comProblema: linhas.length - importaveis.length - semAlteracao,
        novosGhes: novosGhes,
        novosVinculos: importaveis.filter(function (l) { return l.situacao === 'NOVO_VINCULO'; }).length,
        alteracoes: importaveis.filter(function (l) { return l.situacao === 'CLASSIFICACAO_ALTERADA'; }).length,
        ghesComCodigo: ghesComCodigo,
        haAlteracao: importaveis.length > 0 || novosGhes > 0 || ghesComCodigo > 0,
      };
    },
    /** Linhas da tabela principal, na ordem da planilha: o que grava, o que tem problema e o GHE que só recebe código. */
    linhasVisiveis: function (dados, opcoes) {
      var linhas = (dados && dados.linhas) || [];
      if (opcoes && opcoes.mostrarExistentes === true) return linhas.slice();
      var visiveis = {};
      linhas.forEach(function (l) { if (!semAlteracaoDaLinha(l)) visiveis[l.linha] = true; });
      ((dados && dados.ghes) || []).forEach(function (g) {
        var proprias = g.linhas || [];
        if (g.operacao !== 'ATRIBUIR_CODIGO' || proprias.length === 0) return;
        if (!proprias.some(function (n) { return visiveis[n]; })) visiveis[proprias[0]] = true; // ao menos uma linha do GHE que vai receber código
      });
      return linhas.filter(function (l) { return visiveis[l.linha] === true; });
    },
  };

  // ─── Render ────────────────────────────────────────────────────────
  function escaparHtml(s) {
    return texto(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function celula(v) { return '<td>' + (texto(v) ? escaparHtml(v) : '—') + '</td>'; }
  function item(rotulo, valor) { return '<li>' + escaparHtml(rotulo) + ': <strong>' + escaparHtml(valor) + '</strong></li>'; }
  var BLOQUEANTES = ['EPI_NAO_ENCONTRADO', 'EPI_AMBIGUO', 'EPI_INATIVO', 'GHE_INATIVO', 'CONFLITO_GHE', 'GHE_AMBIGUO', 'CONFLITO_NO_ARQUIVO', 'LINHA_INVALIDA'];

  function observacao(l) {
    var partes = [];
    (l.problemas || []).forEach(function (p) { partes.push(rotulos.problema(p.codigo)); });
    if (l.motivo) partes.push(rotulos.motivo(l.motivo));
    if (l.duplicadaDe) partes.push('Repete a linha ' + l.duplicadaDe + '.');
    return partes.join(' ');
  }

  function linhasDaTabela(linhas, colunaResultado) {
    return (linhas || []).map(function (l) {
      var bloqueada = BLOQUEANTES.indexOf(l.situacao) !== -1 || l.resultado === 'BLOQUEADA';
      return (bloqueada ? '<tr class="linha-bloqueada">' : '<tr>')
        + '<td>' + escaparHtml(l.linha) + '</td>' + celula(l.ghe) + celula(l.descricao) + celula(l.epi)
        + '<td>' + escaparHtml(rotulos.classificacao(l.classificacao)) + '</td>'
        + '<td>' + escaparHtml(colunaResultado(l)) + '</td>' + celula(observacao(l)) + '</tr>';
    }).join('');
  }

  var render = {
    escaparHtml: escaparHtml,
    /** Conferência: uma linha por linha da planilha, com o resultado previsto. Linhas bloqueadas continuam visíveis. */
    linhasPrevia: function (linhas) { return linhasDaTabela(linhas, function (l) { return rotulos.situacao(l.situacao); }); },
    /** Resultado final da confirmação: o que foi mesmo aplicado, sem alteração ou não aplicado. */
    linhasResultado: function (linhas) { return linhasDaTabela(linhas, function (l) { return rotulos.resultadoLinha(l.resultado); }); },
    /** Resumo do preview: os números são os do servidor; aqui só há apresentação. */
    resumoPrevia: function (resumo, ghesDoArquivo) {
      var r = resumo || {};
      var porSituacao = r.porSituacao || {};
      var ghes = r.ghes || {};
      var semAlteracao = porSituacao[SEM_ALTERACAO_SITUACAO] || 0;
      var html = '<ul class="resumo-importacao">'
        + item('Linhas lidas', r.linhasRecebidas) + item('Linhas ignoradas (vazias)', r.linhasIgnoradas)
        + (semAlteracao > 0 ? item('Sem alteração', semAlteracao) : '') + item('Serão aplicadas', r.aplicaveis)
        + Object.keys(porSituacao).filter(function (k) { return k !== SEM_ALTERACAO_SITUACAO; }).map(function (k) { return item(rotulos.situacao(k), porSituacao[k]); }).join('')
        + Object.keys(ghes).map(function (k) { return item(rotulos.situacaoGhe(k), ghes[k]); }).join('')
        + '</ul>';
      if (Object.keys(porSituacao).some(function (k) { return BLOQUEANTES.indexOf(k) !== -1; })) {
        html += '<p>As linhas bloqueadas ou inválidas não serão aplicadas.</p>';
      }
      // Operação sobre o GHE (não sobre linha): o GHE legado existente que vai receber o código da planilha.
      var recebem = (ghesDoArquivo || []).filter(function (g) { return g.operacao === 'ATRIBUIR_CODIGO'; });
      if (recebem.length > 0) {
        html += '<p>' + (recebem.length === 1 ? 'GHE que receberá código: ' : 'GHEs que receberão código: ')
          + recebem.slice(0, 5).map(function (g) { return escaparHtml(g.codigo + ' · ' + g.descricao); }).join('; ')
          + (recebem.length > 5 ? escaparHtml(' e mais ' + (recebem.length - 5)) : '') + '.</p>';
      }
      return html;
    },
    /** Resumo do resultado final. Sem importacaoId não houve gravação: nunca se diz que algo foi importado. */
    resumoResultado: function (resultado) {
      var res = resultado || {};
      var r = res.resumo || {};
      var contagens = '<ul class="resumo-importacao">'
        + (res.importacaoId ? item('GHEs criados', r.ghesCriados) + item('GHEs com código atribuído', r.ghesComCodigoAtribuido)
          + item('Vínculos criados', r.vinculosCriados) + item('Classificações alteradas', r.classificacoesAlteradas) : '')
        + item('Linhas sem alteração', r.semAlteracao) + item('Linhas não aplicadas', r.bloqueadas) + '</ul>';
      return '<p><strong>' + (res.importacaoId ? 'Importação concluída.' : 'Nenhuma alteração necessária.') + '</strong></p>' + contagens;
    },
  };

  // ─── Mensagens ─────────────────────────────────────────────────────
  var mensagens = {
    SEM_ALTERACAO: 'Nenhuma alteração para importar. Os dados desta planilha já estão cadastrados.',
    SEM_ALTERACAO_COM_PROBLEMAS: 'Nenhuma alteração para importar. Corrija as linhas com problema e envie a planilha novamente.',
    /** Texto de "nada a importar" para o preview, ou null quando há alteração a confirmar. */
    semAlteracao: function (d) {
      if (!d || d.haAlteracao) return null;
      return d.comProblema > 0 ? mensagens.SEM_ALTERACAO_COM_PROBLEMAS : mensagens.SEM_ALTERACAO;
    },
    PERGUNTA_CONFIRMAR: 'Confirmar a importação? As linhas válidas serão aplicadas; as linhas bloqueadas ou inválidas não serão aplicadas. '
      + 'GHEs e vínculos que não estão no arquivo não são removidos.',
    arquivo: function (r) {
      var c = (r && r.codigo) || '';
      if (c === 'FORMATO_XLS') return 'Arquivo .xls antigo não é aceito. Salve como .xlsx no Excel e tente novamente.';
      if (c === 'FORMATO_INVALIDO') return 'Formato não aceito. Envie um arquivo .xlsx.';
      if (c === 'ARQUIVO_VAZIO') return 'O arquivo está vazio.';
      if (c === 'ARQUIVO_GRANDE') return 'O arquivo é grande demais (máximo de 10 MB).';
      if (c === 'CONTEUDO_INCOMPATIVEL') return 'O conteúdo não corresponde a um arquivo .xlsx.';
      if (c === 'XLSX_ILEGIVEL') return 'Não foi possível ler a planilha. Confira se o arquivo é um .xlsx válido.';
      if (c === 'COLUNAS_AUSENTES') {
        return 'Colunas obrigatórias ausentes: ' + (r.faltando || []).join(', ') + '. Use o cabeçalho GHE, DESCRIÇÃO, EPI e CLASSIFICAÇÃO.';
      }
      if (c === 'SEM_DADOS') return 'A planilha não possui nenhuma linha de dados.';
      if (c === 'LINHAS_EXCEDIDAS') return 'A planilha tem ' + r.total + ' linhas; a importação aceita no máximo ' + LIMITE_LINHAS + ' linhas por arquivo.';
      return 'Não foi possível usar este arquivo.';
    },
    erro: function (r) {
      if (!r || !r.status) return 'Falha de rede: não foi possível falar com o servidor. Verifique a conexão e tente novamente.';
      if (r.status === 401) return 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.';
      if (r.status === 403) return 'Seu perfil não tem permissão para importar GHE / EPIs nesta empresa.';
      if (r.status === 413) return 'O arquivo possui dados demais para esta importação.';
      if (r.status === 400) {
        var detalhes = Array.isArray(r.detalhes) ? r.detalhes : [];
        if (detalhes.some(function (d) { return d && d.campo === 'body.linhas'; })) return 'A importação aceita no máximo ' + LIMITE_LINHAS + ' linhas por arquivo.';
        if (detalhes.some(function (d) { return d && /^body\.linhas\.\d+\./.test(d.campo || ''); })) return 'Algum campo da planilha tem texto longo demais (até 500 caracteres). Revise a planilha.';
        return 'Dados inválidos: revise a planilha e tente novamente.';
      }
      return 'Não foi possível concluir a importação. Tente novamente.';
    },
    exigeNovoLogin: function (r) { return !!r && r.status === 401; },
  };

  global.EpiImportacaoGhe = { arquivo: arquivo, planilha: planilha, acoes: acoes, rotulos: rotulos, diferencas: diferencas, render: render, mensagens: mensagens };

  if (typeof module !== 'undefined' && module.exports) module.exports = global.EpiImportacaoGhe;
})(typeof window !== 'undefined' ? window : globalThis);
