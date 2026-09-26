(function (global) {
  'use strict';

  /**
   * EpiFuncionarios — Bloco 9, Etapa C, Parte C4 (25/09/2026):
   * importação de funcionários por planilha e consulta do histórico.
   *
   *   GET  /funcionarios?busca=|cpf=&pagina=&limite=   (employeeHistory.visualizar)
   *   GET  /funcionarios/:id                            (employeeHistory.visualizar)
   *   POST /funcionarios/importacao                     (employeeHistory.criar; até 100 linhas por lote)
   *
   * Camadas (mesmo padrão de js/materiais.js):
   *   arquivo   — formato, tamanho, assinatura; CSV (RFC 4180, UTF-8 ou
   *               Windows-1252) e .xlsx (read-excel-file, cópia local).
   *   planilha  — cabeçalhos, conversão das células e as mesmas regras do
   *               servidor, linha a linha, SEM inventar dado perdido.
   *   lotes     — até 100 linhas E até o limite real de bytes do corpo.
   *   fluxo     — envio sequencial, sem reenvio automático; consolidação.
   *   historico — consulta por nome/matrícula ou CPF completo.
   *   mensagens, render — texto e HTML escapado.
   *
   * PRIVACIDADE: o ARQUIVO é interpretado só no navegador e nunca é enviado
   * inteiro; os DADOS NECESSÁRIOS de cada funcionário válido (nome, CPF,
   * matrícula, datas, setor, função, telefone) SÃO enviados ao servidor
   * para gravação. Nenhum valor de planilha é logado; a prévia mostra o CPF
   * minimizado (***.***.***-XX) e o relatório final não o exibe. O BACKEND É A AUTORIDADE FINAL: tudo o que é validado aqui é
   * validado de novo no servidor.
   */

  var CAMINHO = '/funcionarios';
  var LIMITES = {
    nome: 150, matricula: 30, setor: 100, funcao: 100, telefone: 20, busca: 100,
    arquivoBytes: 10 * 1024 * 1024, linhasArquivo: 1000, linhasLote: 100,
    // Corpo JSON da API: 32 KB (JSON_LIMITE). Margem para cabeçalhos do lote.
    bytesLote: 28 * 1024, nomeArquivo: 100, limitePagina: 20,
  };
  // Texto EXATO apresentado ao responsável pela importação; igual ao do
  // servidor (backend/src/services/declaracao-lgpd.js), conferido em teste.
  // É uma DECLARAÇÃO de quem importa — não é consentimento dos trabalhadores.
  var DECLARACAO = {
    versao: 'IMPORTACAO-FUNCIONARIOS-V1',
    texto: 'Confirmo que todos os funcionários desta planilha foram informados sobre o tratamento dos seus dados pessoais conforme a Política de Privacidade (LGPD — Lei 13.709/2018).',
  };
  var ADMISSAO_MINIMA = '1900-01-01';
  var CONTROLE = /[\u0000-\u001f\u007f]/;

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/funcionarios.js');
    return cliente;
  }
  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function texto(v) { return String(v === undefined || v === null ? '' : v).trim(); }

  // ───────────────────────────────────────────────────────────────────
  // Utilitários (CPF e calendário) — mesmas regras do servidor
  // ───────────────────────────────────────────────────────────────────

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

  function dataDeCalendario(ano, mes, dia) {
    if (ano < 1 || mes < 1 || mes > 12 || dia < 1) return false;
    var bissexto = (ano % 4 === 0 && ano % 100 !== 0) || ano % 400 === 0;
    var dias = [31, bissexto ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1];
    return dia <= dias;
  }

  function iso(ano, mes, dia) {
    var p = function (n, t) { return String(n).padStart(t, '0'); };
    return p(ano, 4) + '-' + p(mes, 2) + '-' + p(dia, 2);
  }

  // Minimização na tela (segurança S3 do Bloco 9): só os dois últimos
  // dígitos; valor fora do formato não aparece nem em parte.
  function mascararCpf(d) {
    if (!d) return '';
    return /^\d{11}$/.test(d) ? '***.***.***-' + d.slice(9) : '***.***.***-**';
  }

  var utilitarios = { cpfValido: cpfValido, dataDeCalendario: dataDeCalendario, mascararCpf: mascararCpf };

  // ───────────────────────────────────────────────────────────────────
  // Ações
  // ───────────────────────────────────────────────────────────────────

  var acoes = {
    /** Ativos e inativos: o histórico de quem saiu continua consultável. */
    listar: function (filtro) {
      var f = filtro || {};
      var q = [];
      if (texto(f.busca)) q.push('busca=' + encodeURIComponent(texto(f.busca)));
      if (texto(f.cpf)) q.push('cpf=' + encodeURIComponent(texto(f.cpf)));
      q.push('pagina=' + encodeURIComponent(f.pagina || 1));
      q.push('limite=' + encodeURIComponent(f.limite || LIMITES.limitePagina));
      return http().requisitar('GET', CAMINHO + '?' + q.join('&'));
    },
    buscar: function (id) {
      return http().requisitar('GET', CAMINHO + '/' + encodeURIComponent(id));
    },
    importarLote: function (corpo) {
      return http().requisitar('POST', CAMINHO + '/importacao', { corpo: corpo });
    },
  };

  // ───────────────────────────────────────────────────────────────────
  // Arquivo
  // ───────────────────────────────────────────────────────────────────

  function formato(nome) {
    var m = /\.([a-z0-9]+)$/i.exec(texto(nome));
    var ext = m ? m[1].toLowerCase() : '';
    return ext === 'xlsx' || ext === 'csv' || ext === 'xls' ? ext : null;
  }

  /** {nome, tamanho, inicio: Uint8Array com os primeiros bytes} → {ok, formato} ou {ok:false, codigo}. */
  function verificar(a) {
    var f = formato(a && a.nome);
    if (f === 'xls') return { ok: false, codigo: 'FORMATO_XLS' };
    if (!f) return { ok: false, codigo: 'FORMATO_INVALIDO' };
    if (!a.tamanho) return { ok: false, codigo: 'ARQUIVO_VAZIO' };
    if (a.tamanho > LIMITES.arquivoBytes) return { ok: false, codigo: 'ARQUIVO_GRANDE' };
    var b = a.inicio || new Uint8Array();
    if (f === 'xlsx' && !(b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04)) {
      return { ok: false, codigo: 'CONTEUDO_INCOMPATIVEL' };
    }
    if (f === 'csv' && Array.prototype.indexOf.call(b, 0) !== -1) return { ok: false, codigo: 'CONTEUDO_INCOMPATIVEL' };
    return { ok: true, formato: f };
  }

  /** UTF-8 estrito; se inválido, Windows-1252 (CSV salvo pelo Excel em português). */
  function decodificarCsv(bytes) {
    var t;
    var codificacao = 'utf-8';
    try {
      t = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      t = new TextDecoder('windows-1252').decode(bytes);
      codificacao = 'windows-1252';
    }
    return { texto: t.charAt(0) === '﻿' ? t.slice(1) : t, codificacao: codificacao };
  }

  /** Separador do cabeçalho: ';' (Excel pt-BR) ou ',', contado fora de aspas. */
  function separadorDe(t) {
    var pv = 0; var vg = 0; var aspas = false;
    for (var i = 0; i < t.length; i += 1) {
      var c = t[i];
      if (c === '"') aspas = !aspas;
      else if (!aspas && (c === '\n' || c === '\r')) break;
      else if (!aspas && c === ';') pv += 1;
      else if (!aspas && c === ',') vg += 1;
    }
    return pv >= vg && pv > 0 ? ';' : ',';
  }

  /** CSV (RFC 4180): aspas, aspas escapadas, separador e quebra de linha dentro de aspas, CRLF, BOM. */
  function lerCsv(entrada) {
    var t = String(entrada || '');
    if (t.charAt(0) === '﻿') t = t.slice(1);
    var sep = separadorDe(t);
    var linhas = []; var linha = []; var campo = ''; var aspas = false;
    for (var i = 0; i < t.length; i += 1) {
      var c = t[i];
      if (aspas) {
        if (c === '"' && t[i + 1] === '"') { campo += '"'; i += 1; } else if (c === '"') aspas = false; else campo += c;
      } else if (c === '"') {
        aspas = true;
      } else if (c === sep) {
        linha.push(campo); campo = '';
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && t[i + 1] === '\n') i += 1;
        linha.push(campo); linhas.push(linha); linha = []; campo = '';
      } else {
        campo += c;
      }
    }
    if (campo !== '' || linha.length > 0) { linha.push(campo); linhas.push(linha); }
    return linhas;
  }

  /** .xlsx pela biblioteca local (read-excel-file): só a primeira aba. */
  async function lerXlsx(arquivo, leitor) {
    var ler = leitor || global.readXlsxFile;
    if (typeof ler !== 'function') return { ok: false, codigo: 'XLSX_ILEGIVEL' };
    try {
      var r = await ler(arquivo);
      var dados = Array.isArray(r) && r[0] && Array.isArray(r[0].data) ? r[0].data : null;
      return dados ? { ok: true, linhas: dados } : { ok: false, codigo: 'XLSX_ILEGIVEL' };
    } catch (e) {
      return { ok: false, codigo: 'XLSX_ILEGIVEL' };
    }
  }

  var arquivo = { formato: formato, verificar: verificar, decodificarCsv: decodificarCsv, lerCsv: lerCsv, lerXlsx: lerXlsx };

  // ───────────────────────────────────────────────────────────────────
  // Planilha
  // ───────────────────────────────────────────────────────────────────

  // Sinônimos de cabeçalho (os do protótipo, mais admissão). Objeto SEM
  // protótipo: '__proto__' ou 'constructor' vindos da planilha nunca
  // alcançam propriedades herdadas.
  var CABECALHOS = Object.create(null);
  [
    ['nome', ['nome', 'name', 'funcionário', 'funcionario']],
    ['setor', ['setor', 'departamento', 'area', 'área']],
    ['cpf', ['cpf']],
    ['matricula', ['matrícula', 'matricula', 'mat', 'registro']],
    ['nascimento', ['nascimento', 'data de nascimento', 'dt nascimento']],
    ['contratacao', ['contratação', 'contratacao', 'admissão', 'admissao', 'data de contratação', 'data contratação', 'data de admissão', 'data de admissao', 'data admissão']],
    ['telefone', ['telefone', 'tel', 'celular', 'fone', 'whatsapp', 'contato', 'número', 'numero']],
    ['cargo', ['cargo', 'função', 'funcao', 'função/cargo', 'posição']],
  ].forEach(function (par) { par[1].forEach(function (s) { CABECALHOS[s] = par[0]; }); });
  var OBRIGATORIAS = [['nome', 'Nome'], ['setor', 'Setor'], ['cpf', 'CPF'], ['matricula', 'Matrícula'], ['contratacao', 'Contratação'], ['cargo', 'Cargo']];

  function normalizarCabecalho(v) { return texto(v).toLowerCase().replace(/\s+/g, ' '); }

  function vazia(celula) { return celula === null || celula === undefined || texto(celula) === ''; }

  /** Célula de texto: Date → AAAA-MM-DD; número inteiro → dígitos; nunca notação científica. */
  function textoDaCelula(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
    if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('fullwide', { useGrouping: false }) : String(v);
    return texto(v);
  }

  /** Data: Date (UTC, da biblioteca) ou texto DD/MM/AAAA ou AAAA-MM-DD. Número comum: erro, sem adivinhar. */
  function dataDaCelula(v) {
    if (vazia(v)) return { valor: null };
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return { erro: 'INVALIDA' };
      return { valor: iso(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) };
    }
    if (typeof v === 'number') return { erro: 'NUMERICA' };
    var t = texto(v);
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
    var ano; var mes; var dia;
    if (m) { dia = Number(m[1]); mes = Number(m[2]); ano = Number(m[3]); } else {
      m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
      if (!m) return { erro: 'INVALIDA' };
      ano = Number(m[1]); mes = Number(m[2]); dia = Number(m[3]);
    }
    return dataDeCalendario(ano, mes, dia) ? { valor: iso(ano, mes, dia) } : { erro: 'INVALIDA' };
  }

  function exibirData(valorIso, bruto) {
    if (valorIso) return valorIso.slice(8, 10) + '/' + valorIso.slice(5, 7) + '/' + valorIso.slice(0, 4);
    return textoDaCelula(bruto);
  }

  /** Converte e valida UMA linha; nunca completa dado perdido sem prova (DV do CPF). */
  function interpretarLinha(numero, celula) {
    var erros = []; var avisos = [];
    var erro = function (campo, mensagem) { erros.push({ campo: campo, mensagem: mensagem }); };
    var aviso = function (campo, mensagem) { avisos.push({ campo: campo, mensagem: mensagem }); };
    var textoObrigatorio = function (campo, bruto, limite, rotulo) {
      var t = textoDaCelula(bruto);
      if (!t) erro(campo, rotulo + ' obrigatório.');
      else if (t.length > limite) erro(campo, rotulo + ' com mais de ' + limite + ' caracteres.');
      else if (CONTROLE.test(t)) erro(campo, rotulo + ' com caractere inválido.');
      return t;
    };

    var nome = textoObrigatorio('nome', celula('nome'), LIMITES.nome, 'Nome');
    var setor = textoObrigatorio('setor', celula('setor'), LIMITES.setor, 'Setor');
    var funcao = textoObrigatorio('funcao', celula('cargo'), LIMITES.funcao, 'Cargo');

    // Matrícula: número do Excel é lido como está — zeros à esquerda perdidos NÃO são recriados.
    var matriculaBruta = celula('matricula');
    var matricula;
    if (typeof matriculaBruta === 'number' && !Number.isInteger(matriculaBruta)) {
      matricula = String(matriculaBruta);
      erro('matricula', 'Matrícula numérica com casas decimais: formate a coluna como texto.');
    } else {
      matricula = textoObrigatorio('matricula', matriculaBruta, LIMITES.matricula, 'Matrícula');
      if (typeof matriculaBruta === 'number') aviso('matricula', 'Matrícula lida como número: se havia zeros à esquerda, o Excel os removeu. Confira ou formate a coluna como texto.');
    }

    // Telefone (opcional): também nunca completado.
    var telefoneBruto = celula('telefone');
    var telefone = textoDaCelula(telefoneBruto);
    if (typeof telefoneBruto === 'number' && !Number.isInteger(telefoneBruto)) erro('telefone', 'Telefone numérico com casas decimais: formate a coluna como texto.');
    else if (telefone.length > LIMITES.telefone) erro('telefone', 'Telefone com mais de ' + LIMITES.telefone + ' caracteres.');
    else if (telefone && CONTROLE.test(telefone)) erro('telefone', 'Telefone com caractere inválido.');
    else if (typeof telefoneBruto === 'number') aviso('telefone', 'Telefone lido como número: zeros e DDD não são completados. Confira.');

    // CPF: texto precisa ter os 11 dígitos; número do Excel só é completado
    // com zeros à esquerda se o resultado passar no dígito verificador.
    var cpfBruto = celula('cpf');
    var cpf = '';
    if (typeof cpfBruto === 'number') {
      var digitos = Number.isInteger(cpfBruto) && cpfBruto > 0 ? textoDaCelula(cpfBruto) : '';
      if (digitos.length === 11 && cpfValido(digitos)) {
        cpf = digitos;
      } else if (digitos && digitos.length < 11 && cpfValido(digitos.padStart(11, '0'))) {
        cpf = digitos.padStart(11, '0');
        aviso('cpf', 'CPF lido como número: completado com zeros à esquerda e conferido pelos dígitos verificadores. Confira.');
      } else {
        cpf = digitos;
        erro('cpf', 'CPF lido como número e sem os zeros à esquerda ou inválido: formate a coluna como texto e digite o CPF completo.');
      }
    } else {
      var t = textoDaCelula(cpfBruto);
      if (!t) erro('cpf', 'CPF obrigatório.');
      else if (!/^[\d.\-\s]+$/.test(t) || !cpfValido(t.replace(/[.\-\s]/g, ''))) erro('cpf', 'CPF inválido.');
      cpf = t.replace(/[.\-\s]/g, '');
    }

    var nasc = dataDaCelula(celula('nascimento'));
    if (nasc.erro) erro('dataNascimento', nasc.erro === 'NUMERICA' ? 'Data de nascimento em formato numérico: formate a coluna como data (DD/MM/AAAA).' : 'Data de nascimento inválida (use DD/MM/AAAA).');
    var adm = dataDaCelula(celula('contratacao'));
    if (adm.erro) erro('dataAdmissao', adm.erro === 'NUMERICA' ? 'Data de contratação em formato numérico: formate a coluna como data (DD/MM/AAAA).' : 'Data de contratação inválida (use DD/MM/AAAA).');
    else if (!adm.valor) erro('dataAdmissao', 'Data de contratação obrigatória.');
    else if (adm.valor < ADMISSAO_MINIMA) erro('dataAdmissao', 'Data de contratação anterior a 1900.');
    else if (nasc.valor && adm.valor <= nasc.valor) erro('dataAdmissao', 'Data de contratação deve ser posterior ao nascimento.');

    return {
      linha: numero,
      dados: {
        nome: nome, setor: setor, telefone: telefone || null, cpf: cpf, matricula: matricula,
        dataNascimento: nasc.valor || null, dataAdmissao: adm.valor || null, funcao: funcao,
      },
      exibicao: {
        nome: nome, setor: setor, telefone: telefone, cpf: mascararCpf(cpf), matricula: matricula,
        nascimento: exibirData(nasc.valor, celula('nascimento')), contratacao: exibirData(adm.valor, celula('contratacao')), cargo: funcao,
      },
      erros: erros,
      avisos: avisos,
    };
  }

  /** Linhas da planilha (a primeira é o cabeçalho) → linhas interpretadas, ou erro do arquivo. */
  function interpretar(linhas) {
    if (!Array.isArray(linhas) || linhas.length === 0) return { ok: false, codigo: 'SEM_DADOS' };
    var indice = Object.create(null);
    (linhas[0] || []).forEach(function (h, i) {
      var chave = CABECALHOS[normalizarCabecalho(h)];
      if (chave && !(chave in indice)) indice[chave] = i;
    });
    var ausentes = OBRIGATORIAS.filter(function (o) { return !(o[0] in indice); }).map(function (o) { return o[1]; });
    if (ausentes.length) return { ok: false, codigo: 'COLUNAS_AUSENTES', colunas: ausentes };

    var comDados = [];
    for (var i = 1; i < linhas.length; i += 1) {
      var bruta = Array.isArray(linhas[i]) ? linhas[i] : [];
      if (!bruta.every(vazia)) comDados.push({ numero: i + 1, bruta: bruta });
    }
    if (comDados.length === 0) return { ok: false, codigo: 'SEM_DADOS' };
    if (comDados.length > LIMITES.linhasArquivo) return { ok: false, codigo: 'LINHAS_EXCEDIDAS', total: comDados.length };

    var resultado = comDados.map(function (l) {
      return interpretarLinha(l.numero, function (chave) { return chave in indice ? l.bruta[indice[chave]] : null; });
    });

    // Repetidos DENTRO da planilha: a segunda ocorrência aponta a primeira.
    var cpfs = Object.create(null); var matriculas = Object.create(null);
    resultado.forEach(function (l) {
      var cpfOk = l.dados.cpf && !l.erros.some(function (e) { return e.campo === 'cpf'; });
      if (cpfOk) {
        if (l.dados.cpf in cpfs) l.erros.push({ campo: 'cpf', mensagem: 'CPF repetido na planilha (linha ' + cpfs[l.dados.cpf] + ').' });
        else cpfs[l.dados.cpf] = l.linha;
      }
      var mat = l.dados.matricula;
      if (mat && !l.erros.some(function (e) { return e.campo === 'matricula'; })) {
        if (mat in matriculas) l.erros.push({ campo: 'matricula', mensagem: 'Matrícula repetida na planilha (linha ' + matriculas[mat] + ').' });
        else matriculas[mat] = l.linha;
      }
    });

    return {
      ok: true,
      linhas: resultado,
      validas: resultado.filter(function (l) { return l.erros.length === 0; }).length,
      comErro: resultado.filter(function (l) { return l.erros.length > 0; }).length,
      comAviso: resultado.filter(function (l) { return l.erros.length === 0 && l.avisos.length > 0; }).length,
    };
  }

  /** Modelo para download: só o cabeçalho (nenhum funcionário fictício), ';' e BOM para o Excel. */
  function modeloCsv() {
    return '﻿Nome;Setor;Telefone;CPF;Matrícula;Nascimento;Contratação;Cargo\r\n';
  }

  var planilha = { interpretar: interpretar, modeloCsv: modeloCsv, OBRIGATORIAS: OBRIGATORIAS };

  // ───────────────────────────────────────────────────────────────────
  // Lotes
  // ───────────────────────────────────────────────────────────────────

  function nomeSeguro(nome) {
    var base = texto(nome).split(/[\\/]/).pop();
    return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, LIMITES.nomeArquivo) || 'planilha';
  }

  function bytes(obj) { return new TextEncoder().encode(JSON.stringify(obj)).length; }

  /**
   * Só linhas sem erro. Cada lote fecha em 100 linhas OU quando o corpo
   * JSON (em bytes UTF-8, estrutura incluída) passaria de `bytesLote` —
   * o que vier primeiro. Nenhuma linha é descartada.
   */
  function montar(linhas, meta, opcoes) {
    var validas = (linhas || []).filter(function (l) { return l.erros.length === 0; });
    // Ajuste de fechamento (25/09/2026): linha com valor ambíguo ("Atenção")
    // só é enviada com a conferência EXPRESSA de quem importa — distinta da
    // declaração LGPD. Sem ela, falha fechado: nada é montado.
    var ambiguos = validas.some(function (l) { return l.avisos && l.avisos.length > 0; });
    if (ambiguos && !(opcoes && opcoes.ambiguosConferidos === true)) {
      throw new Error('valores ambíguos sem conferência expressa: nenhum lote foi montado');
    }
    var m = meta || {};
    var arq = { nome: nomeSeguro(m.arquivo && m.arquivo.nome), formato: m.arquivo && m.arquivo.formato, totalLinhas: (m.arquivo && m.arquivo.totalLinhas) || validas.length };
    var corpo = function (itens, numero, total) {
      return { importacaoId: m.importacaoId, lote: { numero: numero, total: total }, arquivo: arq, declaracaoLgpd: { versao: DECLARACAO.versao, confirmada: true }, linhas: itens };
    };
    var grupos = []; var atual = [];
    validas.forEach(function (l) {
      var d = l.dados;
      var item = {
        linha: l.linha, nome: d.nome, cpf: d.cpf, matricula: d.matricula, dataAdmissao: d.dataAdmissao,
        dataNascimento: d.dataNascimento, setor: d.setor, funcao: d.funcao, telefone: d.telefone,
      };
      var tentativa = atual.concat([item]);
      // Números do lote no pior caso de dígitos, para a conta de bytes ser conservadora.
      if (atual.length > 0 && (tentativa.length > LIMITES.linhasLote || bytes(corpo(tentativa, LIMITES.linhasArquivo, LIMITES.linhasArquivo)) > LIMITES.bytesLote)) {
        grupos.push(atual);
        atual = [item];
      } else {
        atual = tentativa;
      }
    });
    if (atual.length) grupos.push(atual);
    return grupos.map(function (g, i) { return corpo(g, i + 1, grupos.length); });
  }

  var lotes = { montar: montar };

  // ───────────────────────────────────────────────────────────────────
  // Mensagens
  // ───────────────────────────────────────────────────────────────────

  var SITUACOES = {
    CADASTRADO: 'Cadastrado', DUPLICADO: 'Duplicado', RECUSADO: 'Recusado', ERRO: 'Erro de processamento',
    NAO_CONFIRMADO: 'Não confirmado', NAO_ENVIADO: 'Não enviado',
  };

  var MSG = {
    NAO_CONFIRMADO: 'Não foi possível confirmar se esta linha foi gravada (falha de rede ou do servidor). Consulte o Histórico de Funcionários antes de reenviar; uma linha já gravada volta como "Duplicado".',
    NAO_ENVIADO: 'Não enviada: a importação foi interrompida antes deste lote.',
    SEM_ENTREGAS: 'Nenhuma entrega registrada para este colaborador. As entregas de EPI aparecerão aqui quando o módulo de entregas estiver disponível.',
    SEM_ENTREGAS_EXPORTACAO: 'Não há entregas registradas para este colaborador. Nenhum arquivo foi gerado.',
    SESSAO: 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.',
  };

  function ehRede(r) { return !r || r.status === 0 || typeof r.status !== 'number'; }
  function confirmado(r) { return !ehRede(r) && r.status < 500; }
  function exigeNovoLogin(r) { return !!r && r.status === 401; }

  function erroArquivo(e) {
    var c = e && e.codigo;
    if (c === 'FORMATO_XLS') return 'Arquivo .xls (formato antigo do Excel) não é aceito. No Excel, use "Salvar como" e salve como .xlsx; depois importe de novo.';
    if (c === 'FORMATO_INVALIDO') return 'Formato não aceito. Use uma planilha .xlsx ou um arquivo .csv.';
    if (c === 'ARQUIVO_VAZIO') return 'O arquivo está vazio.';
    if (c === 'ARQUIVO_GRANDE') return 'O arquivo passa de 10 MB. Divida a planilha e importe em partes.';
    if (c === 'CONTEUDO_INCOMPATIVEL') return 'O conteúdo do arquivo não corresponde à extensão (.xlsx ou .csv). Salve de novo no formato correto.';
    if (c === 'XLSX_ILEGIVEL') return 'Não foi possível ler esta planilha .xlsx. Ela pode estar corrompida ou protegida; salve de novo no Excel e tente outra vez.';
    if (c === 'COLUNAS_AUSENTES') return 'Faltam colunas obrigatórias: ' + (e.colunas || []).join(', ') + '. Use o modelo de planilha.';
    if (c === 'SEM_DADOS') return 'A planilha não tem funcionários: além do cabeçalho, nenhuma linha preenchida.';
    if (c === 'LINHAS_EXCEDIDAS') return 'A planilha tem ' + e.total + ' funcionários; o máximo por importação é ' + LIMITES.linhasArquivo + '. Divida a planilha e importe em partes.';
    return 'Não foi possível ler o arquivo.';
  }

  /** Motivo de recusa de um lote inteiro (a linha não chegou a ser avaliada). */
  function erroLote(r) {
    if (r.status === 403) return 'seu perfil não tem permissão para cadastrar funcionários nesta empresa.';
    if (r.status === 413) return 'lote grande demais para o servidor.';
    if (r.status === 429) return 'muitas requisições em pouco tempo; aguarde um minuto.';
    if (r.codigo === 'IMPORTACAO_DECLARACAO_LGPD_INVALIDA') return 'a declaração sobre o tratamento dos dados não foi aceita.';
    return 'dados do lote recusados.';
  }

  function erroConsulta(r) {
    if (ehRede(r)) return 'Falha de rede ao consultar. Verifique a conexão e tente novamente.';
    if (r.status === 401) return MSG.SESSAO;
    if (r.status === 403) return 'Seu perfil não pode consultar funcionários nesta empresa.';
    if (r.status === 404) return 'Funcionário não encontrado nesta empresa.';
    if (r.status === 400) return 'Consulta recusada: confira o valor informado.';
    return 'Não foi possível consultar o funcionário.';
  }

  var mensagens = {
    MSG: MSG, SEM_ENTREGAS: MSG.SEM_ENTREGAS, SITUACOES: SITUACOES,
    erroArquivo: erroArquivo, erroLote: erroLote, erroConsulta: erroConsulta, exigeNovoLogin: exigeNovoLogin, confirmado: confirmado,
  };

  // ───────────────────────────────────────────────────────────────────
  // Fluxo
  // ───────────────────────────────────────────────────────────────────

  /**
   * Envia os lotes EM SEQUÊNCIA. Lote com resultado incerto (rede/5xx):
   * suas linhas ficam NAO_CONFIRMADO e a importação para — nunca há
   * reenvio automático. Recusa do lote (4xx) ou sessão encerrada também
   * param; as linhas dos lotes seguintes ficam NAO_ENVIADO.
   */
  async function importar(corpos, opcoes) {
    var o = opcoes || {};
    var resultados = [];
    var interrupcao = null;
    for (var i = 0; i < corpos.length; i += 1) {
      var corpo = corpos[i];
      var marcar = function (situacao, extra) {
        corpo.linhas.forEach(function (l) { resultados.push(Object.assign({ linha: l.linha, situacao: situacao }, extra)); });
      };
      // Sessão encerrada (ou outro motivo de parada da página): nenhum lote
      // NOVO é iniciado. O lote já enviado mantém a própria classificação.
      if (!interrupcao && typeof o.deveContinuar === 'function' && !o.deveContinuar()) {
        interrupcao = { motivo: 'SESSAO_ENCERRADA', status: null };
      }
      if (interrupcao) { marcar('NAO_ENVIADO', { motivo: MSG.NAO_ENVIADO }); continue; }
      // eslint-disable-next-line no-await-in-loop
      var r = await acoes.importarLote(corpo);
      if (r.ok) {
        var porLinha = Object.create(null);
        ((r.dados && r.dados.linhas) || []).forEach(function (l) { porLinha[l.linha] = l; });
        corpo.linhas.forEach(function (l) { resultados.push(porLinha[l.linha] || { linha: l.linha, situacao: 'NAO_CONFIRMADO', motivo: MSG.NAO_CONFIRMADO }); });
      } else if (exigeNovoLogin(r)) {
        interrupcao = { motivo: 'SESSAO', status: 401 };
        marcar('NAO_ENVIADO', { motivo: MSG.NAO_ENVIADO });
      } else if (confirmado(r)) {
        interrupcao = { motivo: 'LOTE_RECUSADO', status: r.status };
        marcar('RECUSADO', { codigo: r.codigo || null, motivo: 'Lote recusado pelo servidor: ' + erroLote(r) });
      } else {
        interrupcao = { motivo: 'NAO_CONFIRMADO', status: r.status };
        marcar('NAO_CONFIRMADO', { motivo: MSG.NAO_CONFIRMADO });
      }
      if (typeof o.aoProgresso === 'function') o.aoProgresso(i + 1, corpos.length);
    }
    return { linhas: resultados, interrupcao: interrupcao };
  }

  /** Junta o resultado do servidor às linhas com erro na prévia (RECUSADO local), na ordem da planilha. */
  function consolidar(interpretadas, enviado) {
    var porLinha = Object.create(null);
    ((enviado && enviado.linhas) || []).forEach(function (l) { porLinha[l.linha] = l; });
    var linhas = (interpretadas || []).map(function (l) {
      var base = { linha: l.linha, matricula: (l.dados && l.dados.matricula) || '' };
      if (l.erros.length) return Object.assign(base, { situacao: 'RECUSADO', origem: 'previa', motivo: l.erros.map(function (e) { return e.mensagem; }).join(' ') });
      var r = porLinha[l.linha] || { situacao: 'NAO_ENVIADO', motivo: MSG.NAO_ENVIADO };
      return Object.assign(base, { situacao: r.situacao, codigo: r.codigo || null, motivo: r.motivo || '' });
    });
    var contar = function (s) { return linhas.filter(function (l) { return l.situacao === s; }).length; };
    return {
      linhas: linhas,
      resumo: {
        cadastrados: contar('CADASTRADO'), duplicados: contar('DUPLICADO'), recusados: contar('RECUSADO'),
        erros: contar('ERRO'), naoConfirmados: contar('NAO_CONFIRMADO'), naoEnviados: contar('NAO_ENVIADO'),
      },
      interrupcao: (enviado && enviado.interrupcao) || null,
    };
  }

  /**
   * Confirmações exigidas antes de enviar: a declaração LGPD, sempre; e,
   * havendo linhas com valores ambíguos ("Atenção"), a conferência expressa
   * desses valores — uma confirmação à parte, que não se confunde com a
   * declaração. A alternativa é corrigir a planilha e enviar de novo.
   */
  function verificarConfirmacoes(interpretado, marcadas) {
    var m = marcadas || {};
    if (m.declaracao !== true) {
      return { ok: false, codigo: 'DECLARACAO_NAO_CONFIRMADA', mensagem: 'Marque a declaração sobre o tratamento dos dados para importar.' };
    }
    var ambiguos = ((interpretado && interpretado.linhas) || []).some(function (l) { return l.erros.length === 0 && l.avisos.length > 0; });
    if (ambiguos && m.ambiguos !== true) {
      return { ok: false, codigo: 'AMBIGUOS_NAO_CONFERIDOS', mensagem: 'Há valores marcados como "Atenção" na prévia. Confira-os e marque a confirmação de conferência, ou corrija a planilha e envie o arquivo de novo.' };
    }
    return { ok: true };
  }

  var fluxo = { importar: importar, consolidar: consolidar, verificarConfirmacoes: verificarConfirmacoes };

  // ───────────────────────────────────────────────────────────────────
  // Histórico
  // ───────────────────────────────────────────────────────────────────

  /** Consulta: nome ou matrícula → busca livre; CPF → só completo e válido (igualdade exata no servidor). */
  function consulta(tipo, valor) {
    if (tipo === 'cpf') {
      // Mesma regra do servidor: só dígitos, pontos e hífen (espaços apenas
      // nas pontas). Letras ou outros símbolos recusam o valor — nunca são
      // descartados para "achar" um CPF (ajuste de fechamento, 25/09/2026).
      var t = texto(valor);
      var d = /^[\d.-]+$/.test(t) ? t.replace(/[.-]/g, '') : '';
      if (d.length !== 11 || !cpfValido(d)) return { ok: false, mensagem: 'Informe o CPF completo e válido, com 11 dígitos: somente números ou no formato 000.000.000-00, sem letras ou outros símbolos.' };
      return { ok: true, filtro: { cpf: d } };
    }
    var t = texto(valor);
    if (!t) return { ok: false, mensagem: 'Digite o nome ou a matrícula do colaborador.' };
    if (t.length > LIMITES.busca) return { ok: false, mensagem: 'Busca com mais de ' + LIMITES.busca + ' caracteres.' };
    return { ok: true, filtro: { busca: t } };
  }

  var historico = { consulta: consulta };

  // ───────────────────────────────────────────────────────────────────
  // Render
  // ───────────────────────────────────────────────────────────────────

  function escaparHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function previa(linhas) {
    return (linhas || []).map(function (l) {
      var e = l.exibicao || {};
      // 'warn' (classe já existente em main.css): valor ambíguo a conferir, linha importável.
      var status = l.erros.length ? 'err' : (l.avisos.length ? 'warn' : 'ok');
      var rotulo = l.erros.length ? 'Erro' : (l.avisos.length ? 'Atenção' : 'Válido');
      return '<tr class="import-row-' + status + '"><td>' + l.linha + '</td><td><strong>' + (escaparHtml(e.nome) || '—') + '</strong></td>'
        + ['setor', 'telefone', 'cpf', 'matricula', 'nascimento', 'contratacao', 'cargo'].map(function (k) { return '<td>' + (escaparHtml(e[k]) || '—') + '</td>'; }).join('')
        + '<td><span class="import-row-badge ' + status + '">' + rotulo + '</span></td></tr>';
    }).join('');
  }

  /** Problemas da prévia: erros (bloqueiam a linha) e avisos (valores ambíguos a conferir). */
  function problemas(linhas) {
    var itens = [];
    (linhas || []).forEach(function (l) {
      l.erros.forEach(function (x) { itens.push('<div class="import-error-item"><span class="material-symbols-outlined" style="font-size:14px;color:#FF3B30;flex-shrink:0">arrow_right</span>Linha ' + l.linha + ': ' + escaparHtml(x.mensagem) + '</div>'); });
      l.avisos.forEach(function (x) { itens.push('<div class="import-error-item"><span class="material-symbols-outlined" style="font-size:14px;color:#FF9500;flex-shrink:0">warning</span>Linha ' + l.linha + ' (atenção): ' + escaparHtml(x.mensagem) + '</div>'); });
    });
    return itens.length ? '<div class="import-error-list"><strong>' + itens.length + ' ponto(s) a conferir</strong>' + itens.join('') + '</div>' : '';
  }

  function resumoPrevia(total, validas, comErro, comAviso, nomeArquivo) {
    return '<div class="import-stat"><span>Total de linhas</span><strong>' + total + '</strong></div>'
      + '<div class="import-stat ok"><span>Válidos</span><strong>' + validas + '</strong></div>'
      + '<div class="import-stat err"><span>Com erro</span><strong>' + comErro + '</strong></div>'
      + '<div class="import-stat"><span>Com atenção</span><strong>' + comAviso + '</strong></div>'
      + '<div class="import-stat"><span>Arquivo</span><strong style="font-size:13px;margin-top:8px">' + escaparHtml(nomeArquivo) + '</strong></div>';
  }

  /** Relatório final: contadores e as linhas não cadastradas, com o motivo — nunca CPF. */
  function relatorio(c) {
    var r = c.resumo;
    var stat = function (rotulo, n, classe) { return '<div class="import-stat' + (classe ? ' ' + classe : '') + '"><span>' + rotulo + '</span><strong>' + n + '</strong></div>'; };
    var grade = '<div class="import-result-grid">' + stat('Cadastrados', r.cadastrados, 'ok') + stat('Duplicados (não alterados)', r.duplicados) + stat('Recusados', r.recusados, 'err')
      + stat('Erro de processamento', r.erros, 'err') + stat('Não confirmados', r.naoConfirmados, 'err') + stat('Não enviados', r.naoEnviados) + '</div>';
    var pendentes = c.linhas.filter(function (l) { return l.situacao !== 'CADASTRADO'; });
    var tabela = pendentes.length
      ? '<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Linha</th><th>Matrícula</th><th>Situação</th><th>Motivo</th></tr></thead><tbody>'
        + pendentes.map(function (l) { return '<tr><td>' + l.linha + '</td><td>' + (escaparHtml(l.matricula) || '—') + '</td><td>' + escaparHtml(SITUACOES[l.situacao] || l.situacao) + '</td><td>' + escaparHtml(l.motivo) + '</td></tr>'; }).join('')
        + '</tbody></table></div>'
      : '';
    return grade + tabela;
  }

  function resultados(lista) {
    return '<div class="table-wrap"><table><thead><tr><th>Funcionário</th><th>Matrícula</th><th>Setor</th><th>Situação</th><th></th></tr></thead><tbody>'
      + (lista || []).map(function (f) {
        return '<tr><td><strong>' + escaparHtml(f.nome) + '</strong></td><td>' + escaparHtml(f.matricula) + '</td><td>' + (escaparHtml(f.setor) || '—') + '</td><td>'
          + (f.ativo === false ? '<span class="badge status-inactive">Inativo</span>' : '<span class="badge status-active">Ativo</span>')
          + '</td><td><button class="outlined-btn" type="button" data-id="' + escaparHtml(f.id) + '">Selecionar</button></td></tr>';
      }).join('')
      + '</tbody></table></div>';
  }

  var render = {
    escaparHtml: escaparHtml, previa: previa, problemas: problemas, resumoPrevia: resumoPrevia, relatorio: relatorio, resultados: resultados,
  };

  global.EpiFuncionarios = {
    LIMITES: LIMITES,
    DECLARACAO: DECLARACAO,
    utilitarios: utilitarios,
    acoes: acoes,
    arquivo: arquivo,
    planilha: planilha,
    lotes: lotes,
    mensagens: mensagens,
    fluxo: fluxo,
    historico: historico,
    render: render,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiFuncionarios;
  }
})(typeof window !== 'undefined' ? window : globalThis);
