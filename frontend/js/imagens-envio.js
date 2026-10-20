(function (global) {
  'use strict';

  /**
   * EpiImagensEnvio — envio de imagens para a biblioteca da EMPRESA (Biblioteca de Imagens, Unidade 5C-8a).
   *
   *   POST /imagens-material/empresa?nome=<nome>   (materials.criar) corpo BINÁRIO image/png|jpeg|webp, até 2 MiB
   *                                                201 { imagem, reaproveitada:false } ou 200 reaproveitada:true (mesmo conteúdo já na empresa)
   *
   * O EpiHttp só envia JSON (um File no corpo viraria "{}" em silêncio), então o transporte binário mora aqui, separado e sem tocar nele:
   * o corpo é o PRÓPRIO arquivo, o único cabeçalho é o Content-Type dele, e a sessão vai pelo cookie (`credentials: 'include'`). A origem da
   * requisição é do navegador; empresa e ator vêm só da sessão no servidor; nada de autoridade na consulta. O endereço-base é o do EpiHttp.
   *
   * Regras que este módulo cumpre: uma imagem por requisição, uma de cada vez; nenhuma repetição automática (um resultado incerto fica
   * INCERTO e só a pessoa decide reenviar, o que é seguro porque o servidor deduplica pelo conteúdo); validações locais só orientam (o backend
   * é a autoridade); texto de falha próprio, nunca o do servidor; nada no console, nada guardado no navegador, nenhuma montagem de HTML.
   * O arquivo é reconhecido pela forma (name, size, type), nunca por `instanceof File`.
   *
   * Camadas: LIMITES e ACEITAS (iguais à configuração do backend), caminhos, validações (nome, arquivo, dimensões opcionais), resumoSha256
   * (prevê a duplicata dentro do lote), enviar (uma imagem), enviarLote (várias, em sequência) e mensagens.
   */

  var MIB = 1024 * 1024;
  var LIMITES = Object.freeze({
    arquivoMaxBytes: 2 * MIB,
    ladoMin: 320,
    ladoMax: 4096,
    pixelsMax: 8388608,
    loteMax: 10,
    nomeMin: 1,
    nomeMax: 100,
    formatos: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
  });
  var ACEITAS = LIMITES.formatos.join(',');
  var CONTROLE = /\p{Cc}/u;
  var ESPERA_MAXIMA_SEGUNDOS = 3600;

  var TEXTOS = {
    REDE: 'Falha de rede: não foi possível enviar a imagem. Verifique a conexão e tente novamente.',
    SESSAO: 'Sua sessão terminou. Entre novamente pelo Portal do Cliente.',
    PERMISSAO: 'Sem permissão para adicionar imagens à biblioteca da empresa.',
    INDISPONIVEL: 'O armazenamento de imagens está indisponível no momento. Tente novamente mais tarde.',
    OCUPADO: 'O servidor está ocupado processando outras imagens. Aguarde um instante e tente novamente.',
    LIMITE: 'Muitas imagens enviadas em pouco tempo. Aguarde um instante e tente novamente.',
    COTA: 'O limite de imagens da biblioteca da empresa foi atingido.',
    ARQUIVO_GRANDE: 'O arquivo é grande demais: o máximo é 2 MiB.',
    FORMATO: 'Formato não aceito. Use PNG, JPEG ou WebP.',
    ANIMADA: 'Imagens animadas não são aceitas. Use uma imagem estática.',
    INVALIDA: 'Não foi possível ler a imagem: o arquivo está corrompido ou não é uma imagem válida.',
    DIMENSOES: 'A imagem precisa ter lados de 320 a 4096 pixels e até 8 megapixels.',
    TEMPO: 'A imagem demorou demais para ser processada. Tente outro arquivo.',
    SAIDA: 'Não foi possível processar a imagem: o resultado ficou grande demais. Tente um arquivo mais simples.',
    NOME: 'Informe um nome de 1 a 100 caracteres.',
    NOME_RECUSADO: 'O nome da imagem não foi aceito. Informe um nome de 1 a 100 caracteres.',
    RECUSADA: 'O servidor não aceitou esta imagem.',
    GENERICO: 'Não foi possível enviar a imagem. Tente novamente.',
    ARQUIVO_VAZIO: 'O arquivo está vazio.',
    ARQUIVO_GRANDE_LOCAL: 'Arquivo maior que 2 MiB.',
    DIMENSOES_PEQUENAS: 'Imagem pequena demais: o menor lado precisa ter pelo menos 320 pixels.',
    DIMENSOES_GRANDES: 'Imagem grande demais: cada lado pode ter no máximo 4096 pixels e a imagem até 8 megapixels.',
    CONTINUAR: 'A imagem em andamento pode ter sido recebida: use “Adicionar à biblioteca” de novo para continuar; se ela já existir, será reaproveitada.',
  };

  var configuracao = { fetch: null };

  function http() {
    var cliente = global.EpiHttp;
    if (!cliente) {
      throw new Error('EpiHttp não carregado: inclua js/api-http.js antes de js/imagens-envio.js');
    }
    return cliente;
  }

  /**
   * `fetch` existe para teste automatizado. Sem ele vale o `fetch` global, lido NA HORA da chamada (como o EpiHttp). Nulo volta ao global.
   * @param {{fetch?: Function|null}} opcoes
   */
  function configurar(opcoes) {
    var o = opcoes || {};
    if (o.fetch !== undefined) {
      if (o.fetch !== null && typeof o.fetch !== 'function') throw new TypeError('fetch inválido');
      configuracao.fetch = o.fetch;
    }
  }

  function obterFetch() {
    if (configuracao.fetch) return configuracao.fetch;
    if (typeof global.fetch === 'function') return global.fetch.bind(global);
    throw new Error('fetch indisponível neste ambiente');
  }

  // ───────────────────────────────────────────────────────────────────
  // Nome, arquivo e dimensões (a mesma regra do servidor; aqui só orienta)
  // ───────────────────────────────────────────────────────────────────

  /** Nome da imagem: aparado, em NFC, de 1 a 100 pontos de código e sem caractere de controle (igual ao schema do backend). */
  function validarNome(nome) {
    if (typeof nome !== 'string') return { ok: false, codigo: 'NOME_INVALIDO' };
    var texto = nome.trim().normalize('NFC');
    var tamanho = Array.from(texto).length;
    if (tamanho < LIMITES.nomeMin || tamanho > LIMITES.nomeMax || CONTROLE.test(texto)) return { ok: false, codigo: 'NOME_INVALIDO' };
    return { ok: true, nome: texto };
  }

  /** Nome sugerido a partir do arquivo: sem a extensão, "_" e "-" viram espaço, em NFC e até 100 pontos de código (nunca corta um par substituto). */
  function nomePadraoDoArquivo(nomeDoArquivo) {
    if (typeof nomeDoArquivo !== 'string') return '';
    var semExtensao = nomeDoArquivo.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().normalize('NFC');
    return Array.from(semExtensao).slice(0, LIMITES.nomeMax).join('').trim();
  }

  function ehArquivo(arquivo) {
    return arquivo !== null && typeof arquivo === 'object' && typeof arquivo.size === 'number' && isFinite(arquivo.size) && typeof arquivo.type === 'string';
  }

  /** O tipo informado decide (não a extensão); o que não é arquivo é erro de programação (TypeError), não recusa de quem usa a tela. */
  function validarArquivo(arquivo) {
    if (!ehArquivo(arquivo)) throw new TypeError('arquivo inválido');
    if (LIMITES.formatos.indexOf(arquivo.type) === -1) return { ok: false, codigo: 'FORMATO_NAO_ACEITO' };
    if (arquivo.size === 0) return { ok: false, codigo: 'ARQUIVO_VAZIO' };
    if (arquivo.size > LIMITES.arquivoMaxBytes) return { ok: false, codigo: 'ARQUIVO_GRANDE' };
    return { ok: true };
  }

  function inteiroPositivo(n) {
    return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n > 0;
  }

  /** Dimensões já conhecidas: menor lado, maior lado e total de pixels dentro do que o servidor aceita. */
  function validarDimensoes(dimensoes) {
    if (!dimensoes || !inteiroPositivo(dimensoes.largura) || !inteiroPositivo(dimensoes.altura)) throw new TypeError('dimensões inválidas');
    var menor = Math.min(dimensoes.largura, dimensoes.altura);
    var maior = Math.max(dimensoes.largura, dimensoes.altura);
    if (menor < LIMITES.ladoMin) return { ok: false, codigo: 'DIMENSOES_PEQUENAS' };
    if (maior > LIMITES.ladoMax || dimensoes.largura * dimensoes.altura > LIMITES.pixelsMax) return { ok: false, codigo: 'DIMENSOES_GRANDES' };
    return { ok: true };
  }

  /**
   * Dimensões do arquivo, SE o navegador souber decodificar (createImageBitmap); senão, ou se a leitura falhar, nulo: nada é inventado e nada é
   * bloqueado, a decisão obrigatória é do backend. Só orienta (poupa um envio que o servidor recusaria, e a cota é de 10 por minuto).
   */
  async function medirDimensoes(arquivo) {
    try {
      if (!ehArquivo(arquivo) || typeof global.createImageBitmap !== 'function') return null;
      var imagem = await global.createImageBitmap(arquivo);
      var medidas = { largura: imagem.width, altura: imagem.height };
      if (typeof imagem.close === 'function') imagem.close();
      return inteiroPositivo(medidas.largura) && inteiroPositivo(medidas.altura) ? medidas : null;
    } catch (erro) {
      return null;
    }
  }

  function hexadecimal(bytes) {
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /** SHA-256 do conteúdo, em minúsculas; nulo sem crypto.subtle (página servida sem HTTPS) ou se o arquivo não puder ser lido. Só para achar repetidas no lote. */
  async function resumoSha256(arquivo) {
    try {
      var subtle = global.crypto && global.crypto.subtle;
      if (!subtle || typeof subtle.digest !== 'function' || !arquivo || typeof arquivo.arrayBuffer !== 'function') return null;
      var conteudo = await arquivo.arrayBuffer();
      var resumo = await subtle.digest('SHA-256', conteudo);
      return hexadecimal(new Uint8Array(resumo));
    } catch (erro) {
      return null;
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Caminho e transporte
  // ───────────────────────────────────────────────────────────────────

  var caminhos = {
    /** /imagens-material/empresa?nome=<nome codificado>: a consulta leva SÓ o nome, aparado e em NFC. */
    envio: function (nome) {
      var valido = validarNome(nome);
      if (!valido.ok) throw new TypeError('nome de imagem inválido');
      return '/imagens-material/empresa?nome=' + encodeURIComponent(valido.nome);
    },
  };

  function envelopeOk(status, dados) {
    return { ok: true, status: status, dados: dados, codigo: null, mensagem: null, detalhes: null };
  }

  function envelopeErro(status, codigo, mensagem, detalhes, espera) {
    return { ok: false, status: status, dados: null, codigo: codigo || null, mensagem: mensagem || null, detalhes: detalhes || null, esperaSegundos: espera === undefined ? null : espera };
  }

  /** Corpo da resposta: lido inteiro, interpretado como JSON; o texto cru de uma resposta que não é JSON nunca sai daqui. */
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
      return { naoEhJson: true };
    }
  }

  /** Retry-After em segundos inteiros de 1 a 3600; o navegador só o entrega ao JavaScript quando a API é da mesma origem, então ausente é normal. */
  function lerEspera(resposta) {
    try {
      if (!resposta.headers || typeof resposta.headers.get !== 'function') return null;
      var cabecalho = resposta.headers.get('Retry-After');
      if (typeof cabecalho !== 'string' || !/^[0-9]+$/.test(cabecalho.trim())) return null;
      var segundos = Number(cabecalho.trim());
      return segundos >= 1 && segundos <= ESPERA_MAXIMA_SEGUNDOS ? segundos : null;
    } catch (erro) {
      return null;
    }
  }

  /**
   * Uma imagem, um POST. Devolve SEMPRE um envelope (o mesmo do EpiHttp, mais `esperaSegundos` nas falhas), nunca lança por status nem por rede;
   * só lança TypeError por erro de programação (arquivo ou nome fora do contrato), antes de qualquer rede.
   *
   * @param {{arquivo: File, nome: string}} item
   */
  async function enviar(item) {
    var o = item || {};
    var arquivo = validarArquivo(o.arquivo);
    if (!arquivo.ok) throw new TypeError('arquivo recusado: ' + arquivo.codigo);
    var nome = validarNome(o.nome);
    if (!nome.ok) throw new TypeError('nome de imagem inválido');

    var base = http().configurar({}).baseUrl;
    var resposta;
    try {
      resposta = await obterFetch()(base + caminhos.envio(nome.nome), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': o.arquivo.type },
        body: o.arquivo,
      });
    } catch (erroDeRede) {
      return envelopeErro(0, 'FALHA_DE_REDE', TEXTOS.REDE, null);
    }

    var corpo = await lerCorpo(resposta);
    if (corpo.falhou) return envelopeErro(0, 'FALHA_DE_REDE', TEXTOS.REDE, null);
    if (corpo.naoEhJson) return envelopeErro(resposta.status, 'RESPOSTA_INVALIDA', null, null);
    if (resposta.ok) return envelopeOk(resposta.status, corpo.valor);
    var espera = resposta.status === 429 || resposta.status === 503 ? lerEspera(resposta) : null;
    return envelopeErro(resposta.status, corpo.valor && corpo.valor.codigo, corpo.valor && corpo.valor.message, corpo.valor && corpo.valor.detalhes, espera);
  }

  // ───────────────────────────────────────────────────────────────────
  // Mensagens: texto próprio por falha, nunca o do servidor
  // ───────────────────────────────────────────────────────────────────

  function ehDoNome(r) {
    var detalhes = r && Array.isArray(r.detalhes) ? r.detalhes : [];
    return detalhes.some(function (d) { return d && typeof d.campo === 'string' && d.campo.indexOf('query.nome') === 0; });
  }

  /** Texto da falha de UMA imagem pelo status e pelo código; nulo quando deu certo (201 ou 200). */
  function deEnvio(r) {
    if (r && r.ok === true) return null;
    var status = r && typeof r.status === 'number' ? r.status : 0;
    var codigo = r && typeof r.codigo === 'string' ? r.codigo : '';
    if (status === 0) return TEXTOS.REDE;
    switch (codigo) {
      case 'IMAGEM_INVALIDA': return TEXTOS.INVALIDA;
      case 'IMAGEM_DIMENSOES_INVALIDAS': return TEXTOS.DIMENSOES;
      case 'IMAGEM_FORMATO_NAO_SUPORTADO':
      case 'TIPO_CONTEUDO_NAO_SUPORTADO': return TEXTOS.FORMATO;
      case 'IMAGEM_ANIMADA_NAO_SUPORTADA': return TEXTOS.ANIMADA;
      case 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO': return TEXTOS.TEMPO;
      case 'IMAGEM_SAIDA_EXCEDE_LIMITE': return TEXTOS.SAIDA;
      case 'IMAGEM_COTA_EXCEDIDA': return TEXTOS.COTA;
      case 'PAYLOAD_MUITO_GRANDE': return TEXTOS.ARQUIVO_GRANDE;
      case 'IMAGENS_INDISPONIVEL': return TEXTOS.INDISPONIVEL;
      case 'IMAGENS_OCUPADO': return TEXTOS.OCUPADO;
      case 'LIMITE_REQUISICOES_EXCEDIDO': return TEXTOS.LIMITE;
      default: break;
    }
    if (status === 401) return TEXTOS.SESSAO;
    if (status === 403) return TEXTOS.PERMISSAO;
    if (status === 413) return TEXTOS.ARQUIVO_GRANDE;
    if (status === 415) return TEXTOS.FORMATO;
    if (status === 429) return TEXTOS.LIMITE;
    if (status === 400) return ehDoNome(r) ? TEXTOS.NOME_RECUSADO : TEXTOS.RECUSADA;
    return TEXTOS.GENERICO;
  }

  /** Texto da validação local de um arquivo, pelo código de `validarArquivo` ou de `validarDimensoes`. */
  function deArquivo(codigo) {
    switch (codigo) {
      case 'FORMATO_NAO_ACEITO': return TEXTOS.FORMATO;
      case 'ARQUIVO_VAZIO': return TEXTOS.ARQUIVO_VAZIO;
      case 'ARQUIVO_GRANDE': return TEXTOS.ARQUIVO_GRANDE_LOCAL;
      case 'DIMENSOES_PEQUENAS': return TEXTOS.DIMENSOES_PEQUENAS;
      case 'DIMENSOES_GRANDES': return TEXTOS.DIMENSOES_GRANDES;
      default: return TEXTOS.RECUSADA;
    }
  }

  function deNome() {
    return TEXTOS.NOME;
  }

  /** Aviso do lote inteiro quando o envio parou, com a espera sugerida quando o navegador a deixou ler. */
  function deInterrupcao(motivo, esperaSegundos) {
    var espera = typeof esperaSegundos === 'number' ? ' Aguarde cerca de ' + esperaSegundos + (esperaSegundos === 1 ? ' segundo.' : ' segundos.') : '';
    switch (motivo) {
      case 'SESSAO': return TEXTOS.SESSAO;
      case 'PERMISSAO': return TEXTOS.PERMISSAO;
      case 'COTA': return TEXTOS.COTA;
      case 'LIMITE': return TEXTOS.LIMITE + espera;
      case 'OCUPADO': return TEXTOS.OCUPADO + espera;
      case 'INDISPONIVEL': return TEXTOS.INDISPONIVEL;
      case 'REDE': return TEXTOS.REDE + ' ' + TEXTOS.CONTINUAR;
      case 'SERVIDOR': return 'O servidor não confirmou o envio. ' + TEXTOS.CONTINUAR;
      default: return TEXTOS.GENERICO;
    }
  }

  var mensagens = { TEXTOS: TEXTOS, deEnvio: deEnvio, deArquivo: deArquivo, deNome: deNome, deInterrupcao: deInterrupcao };

  // ───────────────────────────────────────────────────────────────────
  // Lote: uma imagem por vez, estado por imagem, parada no que não adianta insistir
  // ───────────────────────────────────────────────────────────────────

  var emAndamento = false;

  /**
   * Como o resultado de UMA imagem se classifica e se o lote para:
   *   aceita (201 ou 200)                            CRIADA | REAPROVEITADA
   *   rede, 5xx, ou sucesso/ilegível sem confirmação INCERTA  (o servidor pode ter gravado; nada é repetido sozinho)
   *   401 / 403 / 429 / 503 ocupado ou indisponível  PENDENTE (nada foi aceito) e para
   *   409 cota da empresa                            RECUSADA e para (as seguintes falhariam igual)
   *   demais 4xx (400, 413, 415, 422…)               RECUSADA e segue com a próxima
   */
  function classificar(r) {
    var status = r.status;
    if (r.ok) {
      var sucesso = r.dados && typeof r.dados === 'object' && r.dados.imagem && typeof r.dados.imagem === 'object';
      if (!sucesso) return { estado: 'INCERTA', parar: 'SERVIDOR' };
      return { estado: r.dados.reaproveitada === true ? 'REAPROVEITADA' : 'CRIADA', parar: null };
    }
    if (status === 0) return { estado: 'INCERTA', parar: 'REDE' };
    if (status === 401) return { estado: 'PENDENTE', parar: 'SESSAO' };
    if (status === 403) return { estado: 'PENDENTE', parar: 'PERMISSAO' };
    if (status === 429) return { estado: 'PENDENTE', parar: 'LIMITE' };
    if (status === 503 && r.codigo === 'IMAGENS_OCUPADO') return { estado: 'PENDENTE', parar: 'OCUPADO' };
    if (status === 503 && r.codigo === 'IMAGENS_INDISPONIVEL') return { estado: 'PENDENTE', parar: 'INDISPONIVEL' };
    if (status === 409 && r.codigo === 'IMAGEM_COTA_EXCEDIDA') return { estado: 'RECUSADA', parar: 'COTA' };
    if (status >= 500 || (r.codigo === 'RESPOSTA_INVALIDA' && status < 400)) return { estado: 'INCERTA', parar: 'SERVIDOR' };
    return { estado: 'RECUSADA', parar: null };
  }

  function resultadoDe(classe, r) {
    if (classe.estado === 'CRIADA' || classe.estado === 'REAPROVEITADA') {
      return { estado: classe.estado, imagem: r.dados.imagem, reaproveitada: classe.estado === 'REAPROVEITADA' };
    }
    return { estado: classe.estado, status: r.status, codigo: r.codigo, mensagem: deEnvio(r) };
  }

  function exigirLote(itens) {
    if (!Array.isArray(itens) || itens.length < 1 || itens.length > LIMITES.loteMax) {
      throw new TypeError('o lote precisa ter de 1 a ' + LIMITES.loteMax + ' imagens');
    }
    return itens.map(function (item) {
      if (!item || typeof item !== 'object') throw new TypeError('item do lote inválido');
      var arquivo = validarArquivo(item.arquivo);
      if (!arquivo.ok) throw new TypeError('arquivo recusado: ' + arquivo.codigo);
      var nome = validarNome(item.nome);
      if (!nome.ok) throw new TypeError('nome de imagem inválido');
      return { arquivo: item.arquivo, nome: nome.nome };
    });
  }

  /**
   * Envia as imagens em sequência (1 a 10, um lote por vez). `aoMudar(indice, estado)` avisa ENVIANDO e depois o estado final de cada imagem
   * tentada (a que volta a PENDENTE por uma parada também é avisada). Devolve `{ itens, interrompido, esperaSegundos }`: `interrompido` é nulo
   * quando o lote foi até o fim. Reenviar o que ficou INCERTO ou PENDENTE é um novo lote, decidido por quem usa a tela.
   *
   * @param {Array<{arquivo: File, nome: string}>} itens
   * @param {{aoMudar?: Function}} [opcoes]
   */
  async function enviarLote(itens, opcoes) {
    var lote = exigirLote(itens);
    if (emAndamento) {
      var ocupado = new Error('já há um envio em andamento');
      ocupado.codigo = 'ENVIO_EM_ANDAMENTO';
      throw ocupado;
    }
    emAndamento = true;
    var aoMudar = opcoes && typeof opcoes.aoMudar === 'function' ? opcoes.aoMudar : null;
    var avisar = function (indice, estado) {
      if (!aoMudar) return;
      try { aoMudar(indice, estado); } catch (erroDaTela) { /* a tela não pode mudar o que a rede fez */ }
    };
    try {
      var resultados = lote.map(function () { return { estado: 'PENDENTE', status: null, codigo: null, mensagem: null }; });
      var interrompido = null;
      var espera = null;
      for (var i = 0; i < lote.length; i += 1) {
        avisar(i, { estado: 'ENVIANDO' });
        var r = await enviar(lote[i]);
        var classe = classificar(r);
        resultados[i] = resultadoDe(classe, r);
        avisar(i, resultados[i]);
        if (classe.parar !== null) {
          interrompido = classe.parar;
          espera = typeof r.esperaSegundos === 'number' ? r.esperaSegundos : null;
          break;
        }
      }
      return { itens: resultados, interrompido: interrompido, esperaSegundos: espera };
    } finally {
      emAndamento = false;
    }
  }

  global.EpiImagensEnvio = {
    LIMITES: LIMITES,
    ACEITAS: ACEITAS,
    caminhos: caminhos,
    configurar: configurar,
    validarNome: validarNome,
    nomePadraoDoArquivo: nomePadraoDoArquivo,
    validarArquivo: validarArquivo,
    validarDimensoes: validarDimensoes,
    medirDimensoes: medirDimensoes,
    resumoSha256: resumoSha256,
    enviar: enviar,
    enviarLote: enviarLote,
    mensagens: mensagens,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.EpiImagensEnvio;
  }
}(typeof window !== 'undefined' ? window : globalThis));
