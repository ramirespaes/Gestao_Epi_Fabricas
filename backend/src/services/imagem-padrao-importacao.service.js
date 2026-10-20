'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { lerConfiguracao } = require('../config/imagens');
const repositorio = require('../repositories/imagem-padrao-importacao.repository');
const { chaveDe } = require('../storage/armazenamento-imagens');
const { CATALOGO_BASE } = require('../utils/classificacao-material');
const { ErroImportacaoPadrao, nomeSeguro } = require('../utils/pacote-padrao-erros');
const { validarPng, validarWebp } = require('../utils/pacote-padrao-formatos');
const { lerManifesto, quantidadeValida } = require('../utils/pacote-padrao-manifesto');
const { lerMapeamento } = require('../utils/pacote-padrao-mapeamento');
const { abrirPacoteZip, lerEntradaDoPacote } = require('../utils/pacote-padrao-zip');

/**
 * Importação OFFLINE da biblioteca padrão de imagens (Biblioteca de Imagens, Unidade 5A-2): lê o pacote aprovado (ZIP), confere o SHA-256 dos
 * bytes físicos de TODOS os arquivos (3 por imagem; 90 no pacote das 30), e só então grava as imagens padronizadas (PNG 1024x1024) e as miniaturas (WebP 320x320),
 * byte a byte. O pacote tem 30 imagens por padrão; `quantidadeEsperada` (1 a 30) aceita um pacote menor, como o da 31ª imagem.
 *
 * Fases, nesta ordem, e a recusa de uma fase acontece antes de qualquer escrita:
 *   1. verificação pura em memória (argumentos, ZIP, SHA-256 aprovado do pacote, estrutura e limites, manifesto, presença, hashes, formatos) e do mapeamento;
 *   2. leitura do estado (banco e armazenamento) e comparação com o pacote: divergência é ESTADO_DIVERGENTE e NADA é alterado;
 *   3. escrita, só com `executar` e só se nada divergiu: primeiro os arquivos que faltam, depois as linhas (imagens e sugestões) numa ÚNICA transação,
 *      sob uma trava consultiva própria que serializa importações simultâneas. Os bytes gravados são os bytes verificados.
 *
 * Destino: gravar exige `destinoAutorizado` ({ banco, oid }, informado pelo operador, nunca lido do ambiente). A PRIMEIRA instrução da transação, na conexão que vai escrever,
 * lê current_database() e o OID de pg_database e exige igualdade exata; divergência é DESTINO_NAO_AUTORIZADO, antes de qualquer trava, leitura de estado ou arquivo.
 *
 * A chave de idempotência é o SHA-256 do PNG padronizado. Imagem já cadastrada nunca é reescrita: os campos que definem o conteúdo precisam conferir
 * com o pacote, os administrativos (nome, ativa, ilustrativa, versão, proveniência, exibição) nunca são tocados. Registro sem arquivo é divergência
 * (sem reparo automático) e as sugestões de tipo só entram junto com a imagem NOVA. Nunca importa o original, nunca gera a derivada de 640 px e nunca
 * vincula imagem a material.
 */

const MIB = 1024 * 1024;
const CONFIGURACAO = lerConfiguracao({});
const LIMITES_PADRAO = Object.freeze({ maxBytesPorArquivo: CONFIGURACAO.arquivoPadraoMaxBytes, maxBytesTotal: 128 * MIB, maxEntradas: 128 });
const NOME_DO_MANIFESTO = 'MANIFESTO_SHA256.csv';
const NOME_DO_LEIA_ME = 'LEIA-ME.txt';
const PASTAS = Object.freeze({ ORIGINAL: '01_ORIGINAIS_PRESERVADOS/', PADRONIZADO: '02_PNG_PADRONIZADOS/', MINIATURA: '03_MINIATURAS_WEBP/' });
const TETO_DO_MAPEAMENTO = MIB;
const MAX_FALHAS_DE_LEITURA = 50;
const ESPERA_PELA_TRAVA = "SET LOCAL lock_timeout = '120s'";
const SHA256 = /^[0-9a-f]{64}$/;
const CODIGO_TECNICO = /^[A-Za-z0-9_.]{1,40}$/;

const CHAVES_DA_VERIFICACAO = Object.freeze(['pacote', 'pacoteSha256Esperado', 'limites', 'quantidadeEsperada']);
const CHAVES_DA_IMPORTACAO = Object.freeze([...CHAVES_DA_VERIFICACAO, 'armazenamento', 'mapeamento', 'executar', 'destinoAutorizado']);
const CHAVES_DO_DESTINO = Object.freeze(['banco', 'oid']);
const NOME_DO_BANCO = /^[!-~]{1,63}$/;
const OID_CANONICO = /^[1-9][0-9]{0,9}$/;
const OID_MAXIMO = 4294967295;

const argumentoInvalido = () => new ErroImportacaoPadrao('PACOTE_ARGUMENTOS_INVALIDOS');
const destinoNaoAutorizado = (detalhes) => new ErroImportacaoPadrao('DESTINO_NAO_AUTORIZADO', detalhes);
const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// ------------------------------------------------------------------------------------------------------------------------------ argumentos
function caminhoAbsoluto(valor) {
  return typeof valor === 'string' && valor.length > 0 && valor.length <= 4096 && !valor.includes('\0') && path.isAbsolute(valor);
}

function normalizarLimites(limites) {
  if (limites === undefined || limites === null) return LIMITES_PADRAO;
  if (typeof limites !== 'object' || Array.isArray(limites)) throw argumentoInvalido();
  if (Object.keys(limites).some((chave) => !Object.hasOwn(LIMITES_PADRAO, chave))) throw argumentoInvalido();
  const resultado = { ...LIMITES_PADRAO, ...limites };
  if (Object.values(resultado).some((valor) => !Number.isSafeInteger(valor) || valor <= 0)) throw argumentoInvalido();
  return Object.freeze(resultado);
}

function exigirArgumentosDaVerificacao(argumentos, permitidas) {
  if (argumentos === null || typeof argumentos !== 'object' || Array.isArray(argumentos)) throw argumentoInvalido();
  if (Object.keys(argumentos).some((chave) => !permitidas.includes(chave))) throw argumentoInvalido();
  if (!caminhoAbsoluto(argumentos.pacote)) throw argumentoInvalido();
  if (typeof argumentos.pacoteSha256Esperado !== 'string' || !SHA256.test(argumentos.pacoteSha256Esperado)) throw argumentoInvalido();
  const { quantidadeEsperada } = argumentos;
  if (quantidadeEsperada !== undefined && !quantidadeValida(quantidadeEsperada)) throw argumentoInvalido();
  return { pacote: argumentos.pacote, pacoteSha256Esperado: argumentos.pacoteSha256Esperado, limites: normalizarLimites(argumentos.limites), quantidadeEsperada };
}

/** Destino autorizado pelo operador: exatamente { banco, oid }, em texto canônico. Obrigatório para gravar; na simulação é opcional e, se vier, também é conferido. */
function exigirDestinoAutorizado(destino, executar) {
  if (destino === undefined || destino === null) {
    if (executar) throw destinoNaoAutorizado([{ campo: 'destino', motivo: 'AUSENTE' }]);
    return null;
  }
  if (typeof destino !== 'object' || Array.isArray(destino) || Object.keys(destino).some((chave) => !CHAVES_DO_DESTINO.includes(chave))) {
    throw destinoNaoAutorizado([{ campo: 'destino', motivo: 'FORMATO_INVALIDO' }]);
  }
  const problemas = [];
  const conferir = (campo, valido) => {
    const valor = Object.hasOwn(destino, campo) ? destino[campo] : undefined;
    if (valor === undefined || valor === null) problemas.push({ campo, motivo: 'AUSENTE' });
    else if (!valido(valor)) problemas.push({ campo, motivo: 'FORMATO_INVALIDO' });
  };
  conferir('banco', (valor) => typeof valor === 'string' && NOME_DO_BANCO.test(valor));
  conferir('oid', (valor) => typeof valor === 'string' && OID_CANONICO.test(valor) && Number(valor) <= OID_MAXIMO);
  if (problemas.length > 0) throw destinoNaoAutorizado(problemas);
  return Object.freeze({ banco: destino.banco, oid: destino.oid });
}

function exigirArgumentosDaImportacao(pool, argumentos) {
  if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') throw argumentoInvalido();
  const base = exigirArgumentosDaVerificacao(argumentos, CHAVES_DA_IMPORTACAO);
  const { armazenamento, executar } = argumentos;
  const mapeamento = argumentos.mapeamento ?? null;
  const armazenamentoValido = armazenamento !== null && typeof armazenamento === 'object'
    && ['gravar', 'existe', 'abrir'].every((metodo) => typeof armazenamento[metodo] === 'function');
  if (!armazenamentoValido || typeof executar !== 'boolean') throw argumentoInvalido();
  if (mapeamento !== null && !caminhoAbsoluto(mapeamento)) throw argumentoInvalido();
  const destinoAutorizado = exigirDestinoAutorizado(argumentos.destinoAutorizado, executar);
  return { ...base, armazenamento, executar, mapeamento, destinoAutorizado };
}

// -------------------------------------------------------------------------------------------------------------------------------- pacote
async function lerArquivoDoPacote(caminho, limites) {
  const teto = limites.maxBytesTotal + limites.maxEntradas * 4096 + MIB;
  const grande = (tamanho) => new ErroImportacaoPadrao('PACOTE_INVALIDO', [{ motivo: 'TAMANHO_EXCEDIDO', esperado: teto, calculado: tamanho }]);
  let arquivo;
  try {
    arquivo = await fsp.open(caminho, 'r');
  } catch {
    throw new ErroImportacaoPadrao('PACOTE_INDISPONIVEL');
  }
  try {
    const informacao = await arquivo.stat();
    if (!informacao.isFile()) throw new ErroImportacaoPadrao('PACOTE_INDISPONIVEL');
    if (informacao.size > teto) throw grande(informacao.size);
    const bytes = await arquivo.readFile();
    if (bytes.length > teto) throw grande(bytes.length);
    return bytes;
  } catch (erro) {
    if (erro instanceof ErroImportacaoPadrao) throw erro;
    throw new ErroImportacaoPadrao('PACOTE_INDISPONIVEL');
  } finally {
    await arquivo.close();
  }
}

/** Os arquivos que o manifesto promete, na ordem do manifesto: original, PNG padronizado e miniatura de cada imagem. */
function arquivosPrevistos(linhas) {
  return linhas.flatMap((linha) => [
    { papel: 'ORIGINAL', linha, nome: `${PASTAS.ORIGINAL}${linha.nome}`, sha256Esperado: linha.sha256Original, bytesEsperados: linha.bytesOriginal },
    { papel: 'PADRONIZADO', linha, nome: `${PASTAS.PADRONIZADO}${linha.nome}`, sha256Esperado: linha.sha256Padronizado, bytesEsperados: linha.bytesPadronizado },
    { papel: 'MINIATURA', linha, nome: `${PASTAS.MINIATURA}${linha.base}.webp`, sha256Esperado: linha.sha256Miniatura, bytesEsperados: linha.bytesMiniatura },
  ]);
}

/**
 * Fase 1 do pacote: tudo em memória, sem tocar banco nem armazenamento. Devolve o resumo público e, à parte, as imagens a importar com os BYTES já verificados.
 */
async function carregarPacoteVerificado({ pacote, pacoteSha256Esperado, limites, quantidadeEsperada }) {
  const bytes = await lerArquivoDoPacote(pacote, limites);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== pacoteSha256Esperado) {
    throw new ErroImportacaoPadrao('PACOTE_SHA256_DIVERGENTE', [{ motivo: 'SHA256', esperado: pacoteSha256Esperado, calculado: sha256 }]);
  }

  const { zip, entradas } = await abrirPacoteZip(bytes, limites);
  const porNome = new Map(entradas.map((entrada) => [entrada.nome, entrada]));

  const doManifesto = porNome.get(NOME_DO_MANIFESTO);
  if (doManifesto === undefined) throw new ErroImportacaoPadrao('PACOTE_MANIFESTO_INVALIDO', [{ campo: 'arquivo', motivo: 'AUSENTE' }]);
  const manifestoLido = await lerEntradaDoPacote(zip, doManifesto, { reter: true });
  if (!manifestoLido.ok) {
    throw new ErroImportacaoPadrao('PACOTE_INVALIDO', [{ entrada: doManifesto.entrada, motivo: manifestoLido.motivo, detalhe: manifestoLido.detalhe }]);
  }
  const { itens: linhas } = lerManifesto(manifestoLido.dados, { quantidadeEsperada });

  const previstos = arquivosPrevistos(linhas);
  const permitidos = new Set([NOME_DO_MANIFESTO, NOME_DO_LEIA_ME, ...previstos.map((p) => p.nome)]);
  const naoPrevistas = entradas.filter((entrada) => !permitidos.has(entrada.nome));
  if (naoPrevistas.length > 0) {
    throw new ErroImportacaoPadrao('PACOTE_INVALIDO', naoPrevistas.map((entrada) => ({ entrada: entrada.entrada, motivo: 'ENTRADA_NAO_PREVISTA' })));
  }
  const ausentes = previstos.filter((p) => !porNome.has(p.nome));
  if (ausentes.length > 0) {
    throw new ErroImportacaoPadrao('PACOTE_ARQUIVO_AUSENTE', ausentes.map((p) => ({ entrada: nomeSeguro(p.nome), papel: p.papel })));
  }

  const lidos = [];
  const falhas = [];
  for (const previsto of previstos) {
    // O original só é conferido por hash: seus bytes não são guardados nem interpretados como imagem.
    const lido = await lerEntradaDoPacote(zip, porNome.get(previsto.nome), { reter: previsto.papel !== 'ORIGINAL' });
    if (lido.ok) lidos.push({ ...previsto, ...lido });
    else falhas.push({ entrada: nomeSeguro(previsto.nome), motivo: lido.motivo, detalhe: lido.detalhe });
    if (falhas.length >= MAX_FALHAS_DE_LEITURA) break;
  }
  if (falhas.length > 0) throw new ErroImportacaoPadrao('PACOTE_INVALIDO', falhas);

  const divergencias = [];
  for (const lido of lidos) {
    const entrada = nomeSeguro(lido.nome);
    if (lido.sha256 !== lido.sha256Esperado) divergencias.push({ entrada, motivo: 'SHA256', esperado: lido.sha256Esperado, calculado: lido.sha256 });
    else if (lido.bytes !== lido.bytesEsperados) divergencias.push({ entrada, motivo: 'TAMANHO', esperado: lido.bytesEsperados, calculado: lido.bytes });
  }
  if (divergencias.length > 0) throw new ErroImportacaoPadrao('PACOTE_HASH_DIVERGENTE', divergencias);

  const invalidas = [];
  for (const lido of lidos) {
    let motivo = null;
    if (lido.papel === 'PADRONIZADO') motivo = validarPng(lido.dados);
    else if (lido.papel === 'MINIATURA') motivo = validarWebp(lido.dados, { bytesMax: CONFIGURACAO.miniatura.bytesMax });
    if (motivo !== null) invalidas.push({ entrada: nomeSeguro(lido.nome), motivo });
  }
  if (invalidas.length > 0) throw new ErroImportacaoPadrao('IMAGEM_PADRAO_INVALIDA', invalidas);

  const porPapel = (papel, linha) => lidos.find((l) => l.papel === papel && l.linha === linha);
  return {
    publico: {
      pacote: { nome: nomeSeguro(path.basename(pacote)), bytes: bytes.length, sha256 },
      manifesto: { linhas: linhas.length },
      verificados: lidos.length,
      arquivos: lidos.map((l) => ({ entrada: nomeSeguro(l.nome), papel: l.papel, bytes: l.bytes, sha256Esperado: l.sha256Esperado, sha256Calculado: l.sha256, confere: true })),
    },
    itens: linhas.map((linha) => ({
      nome: linha.base,
      arquivoOrigem: linha.nome,
      sha256Original: linha.sha256Original,
      sha256Padronizado: linha.sha256Padronizado,
      sha256Miniatura: linha.sha256Miniatura,
      padronizado: porPapel('PADRONIZADO', linha).dados,
      miniatura: porPapel('MINIATURA', linha).dados,
    })),
  };
}

// --------------------------------------------------------------------------------------------------------------------------- mapeamento
async function carregarMapeamento(caminho, itens) {
  let bytes;
  try {
    const arquivo = await fsp.open(caminho, 'r');
    try {
      const informacao = await arquivo.stat();
      if (!informacao.isFile() || informacao.size > TETO_DO_MAPEAMENTO) throw new ErroImportacaoPadrao('MAPEAMENTO_INDISPONIVEL');
      bytes = await arquivo.readFile();
    } finally {
      await arquivo.close();
    }
  } catch (erro) {
    if (erro instanceof ErroImportacaoPadrao) throw erro;
    throw new ErroImportacaoPadrao('MAPEAMENTO_INDISPONIVEL');
  }
  return lerMapeamento(bytes, { nomes: new Set(itens.map((item) => item.nome)), tiposBase: new Set(CATALOGO_BASE.map((tipo) => tipo.nome)) });
}

// ------------------------------------------------------------------------------------------------------------------------------- estado
const chaveDoPng = (item) => chaveDe({ escopo: 'PADRAO', sha256: item.sha256Padronizado, variante: 'mestre', formato: 'PNG' });
const chaveDaMiniatura = (item) => chaveDe({ escopo: 'PADRAO', sha256: item.sha256Padronizado, variante: 'miniatura', formato: 'WEBP' });

/** 'CONFERE' (existe com os bytes do pacote), 'AUSENTE' ou 'DIVERGENTE' (existe com outros bytes ou num lugar inválido). Só lê. */
async function conferirArquivoGuardado(armazenamento, chave, { sha256, bytes }) {
  let existe;
  try {
    existe = await armazenamento.existe(chave);
  } catch (erro) {
    if (erro?.codigo === 'CHAVE_INVALIDA') return 'DIVERGENTE';
    throw erro;
  }
  if (!existe) return 'AUSENTE';
  let fluxo;
  try {
    fluxo = await armazenamento.abrir(chave);
  } catch (erro) {
    if (erro?.codigo === 'ARQUIVO_AUSENTE') return 'AUSENTE';
    if (erro?.codigo === 'CHAVE_INVALIDA') return 'DIVERGENTE';
    throw erro;
  }
  const hash = crypto.createHash('sha256');
  let total = 0;
  try {
    for await (const bloco of fluxo) {
      total += bloco.length;
      if (total > bytes) return 'DIVERGENTE';
      hash.update(bloco);
    }
  } finally {
    fluxo.destroy();
  }
  return total === bytes && hash.digest('hex') === sha256 ? 'CONFERE' : 'DIVERGENTE';
}

/** Campos que DEFINEM o conteúdo da imagem: se a linha existente difere do pacote em algum, é divergência. Os administrativos não entram. */
function camposDivergentes(linha, item) {
  const campos = [];
  if (linha.sha256Miniatura !== item.sha256Miniatura) campos.push('sha256_miniatura');
  if (linha.formato !== 'PNG') campos.push('formato');
  if (linha.largura !== 1024) campos.push('largura');
  if (linha.altura !== 1024) campos.push('altura');
  if (linha.bytesMestre !== item.padronizado.length) campos.push('bytes_mestre');
  if (linha.bytesMiniatura !== item.miniatura.length) campos.push('bytes_miniatura');
  return campos;
}

async function lerEstado(executor, armazenamento, itens) {
  const porHash = new Map((await repositorio.buscarPorHashes(executor, itens.map((item) => item.sha256Padronizado))).map((linha) => [linha.sha256, linha]));
  const semLinha = itens.filter((item) => !porHash.has(item.sha256Padronizado));
  const nomesUsados = new Set((await repositorio.buscarPorNomes(executor, semLinha.map((item) => item.nome))).map((linha) => linha.nome));

  const estados = [];
  const divergencias = [];
  for (const item of itens) {
    const linha = porHash.get(item.sha256Padronizado) ?? null;
    if (linha !== null) {
      const campos = camposDivergentes(linha, item);
      if (campos.length > 0) divergencias.push({ nome: item.nome, alvo: 'REGISTRO', campo: campos[0], campos });
    } else if (nomesUsados.has(item.nome)) {
      divergencias.push({ nome: item.nome, alvo: 'REGISTRO', campo: 'nome' });
    }
    const png = await conferirArquivoGuardado(armazenamento, chaveDoPng(item), { sha256: item.sha256Padronizado, bytes: item.padronizado.length });
    const miniatura = await conferirArquivoGuardado(armazenamento, chaveDaMiniatura(item), { sha256: item.sha256Miniatura, bytes: item.miniatura.length });
    if (png === 'DIVERGENTE' || miniatura === 'DIVERGENTE') divergencias.push({ nome: item.nome, alvo: 'ARQUIVO', motivo: 'CONTEUDO_DIVERGENTE' });
    else if (linha !== null && (png === 'AUSENTE' || miniatura === 'AUSENTE')) divergencias.push({ nome: item.nome, alvo: 'ARQUIVO', motivo: 'AUSENTE' });
    estados.push({ item, linha, png, miniatura });
  }
  if (divergencias.length > 0) throw new ErroImportacaoPadrao('ESTADO_DIVERGENTE', divergencias);
  return estados;
}

// ----------------------------------------------------------------------------------------------------------------------------- escrita
function arquivosAGravar(estados) {
  const limiteDoPng = Math.min(CONFIGURACAO.arquivoPadraoMaxBytes, LIMITES_PADRAO.maxBytesPorArquivo);
  const limiteDaMiniatura = Math.min(CONFIGURACAO.miniatura.bytesMax, LIMITES_PADRAO.maxBytesPorArquivo);
  const lista = [];
  for (const { item, png, miniatura } of estados) {
    if (png === 'AUSENTE') lista.push({ nome: item.nome, chave: chaveDoPng(item), dados: item.padronizado, sha256: item.sha256Padronizado, maxBytes: limiteDoPng });
    if (miniatura === 'AUSENTE') lista.push({ nome: item.nome, chave: chaveDaMiniatura(item), dados: item.miniatura, sha256: item.sha256Miniatura, maxBytes: limiteDaMiniatura });
  }
  return lista;
}

async function gravarArquivos(armazenamento, arquivos) {
  for (const arquivo of arquivos) {
    try {
      // Um de cada vez: ao falhar, nada fica em voo. A camada de armazenamento ainda confere o SHA-256 e recusa sobrescrever outro conteúdo.
      await armazenamento.gravar(arquivo.chave, arquivo.dados, { maxBytes: arquivo.maxBytes, sha256Esperado: arquivo.sha256 });
    } catch (erro) {
      if (erro?.codigo === 'CHAVE_COM_CONTEUDO_DIFERENTE') {
        throw new ErroImportacaoPadrao('ESTADO_DIVERGENTE', [{ nome: arquivo.nome, alvo: 'ARQUIVO', motivo: 'CONTEUDO_DIVERGENTE' }]);
      }
      throw erro;
    }
  }
}

// -------------------------------------------------------------------------------------------------------------------------- transação
function traduzirFalha(erro) {
  if (erro instanceof ErroImportacaoPadrao) return erro;
  if (erro?.code === '55P03') return new ErroImportacaoPadrao('IMPORTACAO_EM_ANDAMENTO', [], { cause: erro });
  const causa = [erro?.code, erro?.codigo].find((codigo) => typeof codigo === 'string' && CODIGO_TECNICO.test(codigo));
  return new ErroImportacaoPadrao('IMPORTACAO_FALHOU', causa === undefined ? [] : [{ causa }], { cause: erro });
}

/** Uma transação só para ler o estado e, se for execução, escrever. Qualquer falha desfaz tudo e devolve a conexão ao pool. */
async function naTransacao(pool, executar, trabalho) {
  let cliente;
  try {
    cliente = await pool.connect();
  } catch (erro) {
    throw traduzirFalha(erro);
  }
  let aberta = false;
  let descartar = false;
  try {
    await cliente.query(executar ? 'BEGIN' : 'BEGIN READ ONLY');
    aberta = true;
    const resultado = await trabalho(cliente);
    await cliente.query('COMMIT');
    aberta = false;
    return resultado;
  } catch (erro) {
    if (aberta) {
      try {
        await cliente.query('ROLLBACK');
      } catch {
        descartar = true;
      }
    }
    throw traduzirFalha(erro);
  } finally {
    cliente.release(descartar);
  }
}

/** Primeira instrução da transação: o banco e o OID da conexão que vai escrever têm de ser os autorizados. Nada é travado, lido ou gravado antes disto. */
async function conferirDestino(cliente, autorizado) {
  const real = await repositorio.lerIdentidade(cliente);
  const divergencias = [];
  if (real === null) {
    divergencias.push({ campo: 'destino', motivo: 'IDENTIDADE_INDISPONIVEL' });
  } else {
    for (const campo of CHAVES_DO_DESTINO) {
      if (real[campo] !== autorizado[campo]) divergencias.push({ campo, motivo: 'DIFERENTE_DO_AUTORIZADO', esperado: autorizado[campo], calculado: real[campo] });
    }
  }
  if (divergencias.length > 0) throw destinoNaoAutorizado(divergencias);
  return real;
}

async function processar(cliente, { executar, armazenamento, verificado, aprovacoes, destinoAutorizado }) {
  const destino = destinoAutorizado === null ? null : await conferirDestino(cliente, destinoAutorizado);
  if (executar) {
    await cliente.query(ESPERA_PELA_TRAVA);
    await repositorio.travarImportacao(cliente);
  }
  const estados = await lerEstado(cliente, armazenamento, verificado.itens);

  const novas = estados.filter((estado) => estado.linha === null);
  const arquivos = arquivosAGravar(estados);
  const sugestoes = novas.filter(({ item }) => aprovacoes.has(item.nome));
  const arquivosPresentes = estados.reduce((soma, e) => soma + (e.png === 'CONFERE' ? 1 : 0) + (e.miniatura === 'CONFERE' ? 1 : 0), 0);

  const idsNovos = new Map();
  if (executar) {
    await gravarArquivos(armazenamento, arquivos);
    for (const { item } of novas) {
      idsNovos.set(item.nome, await repositorio.inserirImagem(cliente, {
        nome: item.nome,
        arquivoOrigem: item.arquivoOrigem,
        sha256: item.sha256Padronizado,
        sha256Miniatura: item.sha256Miniatura,
        sha256OriginalRef: item.sha256Original,
        pacoteOrigem: verificado.publico.pacote.nome,
        pacoteSha256: verificado.publico.pacote.sha256,
        bytesMestre: item.padronizado.length,
        bytesMiniatura: item.miniatura.length,
      }));
    }
    for (const { item } of sugestoes) {
      await repositorio.inserirSugestao(cliente, { imagemId: idsNovos.get(item.nome), ...aprovacoes.get(item.nome) });
    }
  }

  return {
    modo: executar ? 'EXECUCAO' : 'SIMULACAO',
    ...(destino === null ? {} : { destino }),
    pacote: verificado.publico.pacote,
    verificados: verificado.publico.verificados,
    resumo: {
      total: estados.length,
      novas: novas.length,
      existentes: estados.length - novas.length,
      arquivosNovos: arquivos.length,
      arquivosPresentes,
      sugestoes: sugestoes.length,
    },
    itens: estados.map(({ item, linha }) => ({
      nome: item.nome,
      situacao: linha === null ? 'NOVA' : 'EXISTENTE',
      imagemId: linha === null ? (idsNovos.get(item.nome) ?? null) : linha.id,
    })),
  };
}

// ------------------------------------------------------------------------------------------------------------------------------ público
/**
 * Confere o pacote inteiro sem tocar banco nem armazenamento.
 * @returns {Promise<{ ok: true, pacote: { nome: string, bytes: number, sha256: string }, manifesto: { linhas: number }, verificados: number, arquivos: object[] }>}
 */
async function verificarPacotePadrao(argumentos) {
  const opcoes = exigirArgumentosDaVerificacao(argumentos, CHAVES_DA_VERIFICACAO);
  const { publico } = await carregarPacoteVerificado(opcoes);
  return { ok: true, ...publico };
}

/**
 * Importa (`executar: true`) ou simula (`executar: false`) a biblioteca padrão. Ver o cabeçalho do módulo para as fases e as garantias.
 * @param {import('pg').Pool} pool
 * @param {{ pacote: string, pacoteSha256Esperado: string, armazenamento: object, mapeamento?: string|null, executar: boolean, destinoAutorizado?: { banco: string, oid: string }, limites?: object, quantidadeEsperada?: number }} argumentos
 *   `destinoAutorizado` é OBRIGATÓRIO com `executar: true` (DESTINO_NAO_AUTORIZADO se faltar, antes de ler o pacote ou tocar o banco) e conferido na conexão que grava.
 */
async function importarPacotePadrao(pool, argumentos) {
  const { executar, armazenamento, mapeamento, destinoAutorizado, ...opcoesDoPacote } = exigirArgumentosDaImportacao(pool, argumentos);
  const verificado = await carregarPacoteVerificado(opcoesDoPacote);
  const aprovacoes = mapeamento === null ? new Map() : await carregarMapeamento(mapeamento, verificado.itens);
  return naTransacao(pool, executar, (cliente) => processar(cliente, { executar, armazenamento, verificado, aprovacoes, destinoAutorizado }));
}

module.exports = { LIMITES_PADRAO, ErroImportacaoPadrao, verificarPacotePadrao, importarPacotePadrao };
