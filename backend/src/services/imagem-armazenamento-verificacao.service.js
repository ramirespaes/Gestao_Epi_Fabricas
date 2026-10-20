'use strict';

const crypto = require('node:crypto');
const fsNode = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const repositorio = require('../repositories/imagem-verificacao.repository');
const { chaveDe } = require('../storage/armazenamento-imagens');
const { nomeSeguro } = require('../utils/pacote-padrao-erros');

/**
 * Verificador de integridade das imagens armazenadas (Biblioteca de Imagens, Unidade 5C-5). SOMENTE LEITURA, do início ao fim:
 *   - no banco, só SELECT dentro de uma transação READ ONLY e REPEATABLE READ, sempre encerrada com ROLLBACK;
 *   - no disco, só lstat, readdir, realpath e open com O_RDONLY | O_NOFOLLOW. O módulo nem possui outra operação: a fachada de arquivos que recebe (ou a padrão)
 *     expõe apenas essas quatro. Nunca cria o diretório, nunca apaga, move, corrige, restaura nem toca em registro algum.
 *
 * Cruza os REGISTROS (imagens_padrao e imagens_empresa) com os ARQUIVOS e classifica cada imagem e cada sobra:
 *   INTEGRO     — registro e arquivos conferem (tipo da entrada, tamanho, SHA-256 e assinatura do formato).
 *   RECUPERAVEL — registro íntegro e arquivo esperado AUSENTE: restaura-se o arquivo do backup e confere-se o SHA-256 que o próprio registro guarda.
 *   INVESTIGAR  — divergência de conteúdo, entrada imprópria (link simbólico, tipo errado), registro inconsistente, estrutura estranha ou leitura que falhou
 *                 (nunca contada como íntegra, nunca como ausente). Ninguém corrige sozinho.
 *   ORFAO       — arquivo sem registro: sobra por desenho (a exclusão remove só a linha; falha entre gravações; resíduo .tmp). Não é dano.
 * O veredito é a PIOR classe presente (INTEGRO < ORFAO < RECUPERAVEL < INVESTIGAR).
 *
 * Os arquivos são gravados ANTES do INSERT, então um envio em andamento aparece, por instantes, como arquivo sem registro. Por isso o que é mais novo que a idade
 * mínima (padrão 24 horas, a decisão D-C3 do plano) é listado em `recente: true` e fica fora dos contadores e do veredito. O relatório é uma fotografia.
 *
 * Caminhos: nada vindo do disco entra num caminho. Os caminhos de arquivo são montados só de valores validados dos registros (pela mesma `chaveDe` do armazenamento);
 * os nomes lidos do disco só são comparados com padrões fixos e, quando estranhos, apenas descritos (escapados), nunca abertos nem listados. Link simbólico em qualquer
 * nível é recusado e nunca seguido. Relatório e mensagens nunca levam caminho absoluto, só chaves relativas de armazenamento e códigos do sistema.
 */

const CLASSES = Object.freeze({ INTEGRO: 'INTEGRO', ORFAO: 'ORFAO', RECUPERAVEL: 'RECUPERAVEL', INVESTIGAR: 'INVESTIGAR' });
const GRAVIDADE = Object.freeze({ INTEGRO: 0, ORFAO: 1, RECUPERAVEL: 2, INVESTIGAR: 3 });
const TIPOS = Object.freeze({
  ARQUIVO_AUSENTE: 'ARQUIVO_AUSENTE',
  TAMANHO_DIVERGENTE: 'TAMANHO_DIVERGENTE',
  SHA256_DIVERGENTE: 'SHA256_DIVERGENTE',
  ASSINATURA_DIVERGENTE: 'ASSINATURA_DIVERGENTE',
  FORMATO_DIVERGENTE: 'FORMATO_DIVERGENTE',
  ENTRADA_INVALIDA: 'ENTRADA_INVALIDA',
  LEITURA_FALHOU: 'LEITURA_FALHOU',
  REGISTRO_INVALIDO: 'REGISTRO_INVALIDO',
  ORFAO_CONJUNTO: 'ORFAO_CONJUNTO',
  ORFAO_VARIANTE: 'ORFAO_VARIANTE',
  TEMPORARIO_RESIDUAL: 'TEMPORARIO_RESIDUAL',
  ENTRADA_INESPERADA: 'ENTRADA_INESPERADA',
  ORFAO_EMPRESA_INEXISTENTE: 'ORFAO_EMPRESA_INEXISTENTE',
});
const ALERTAS = Object.freeze({
  RAIZ_AUSENTE: 'RAIZ_AUSENTE',
  RAIZ_INVALIDA: 'RAIZ_INVALIDA',
  RAIZ_ILEGIVEL: 'RAIZ_ILEGIVEL',
  NENHUM_ARQUIVO_ESPERADO_PRESENTE: 'NENHUM_ARQUIVO_ESPERADO_PRESENTE',
  BANCO_SEM_REGISTROS_COM_ARQUIVOS: 'BANCO_SEM_REGISTROS_COM_ARQUIVOS',
});

const VERSAO_DO_RELATORIO = 1;
const IDADE_MINIMA_ORFAO_PADRAO_MINUTOS = 24 * 60;
const IDADE_MINIMA_ORFAO_MAXIMA_MINUTOS = 525600;
const PAGINA_PADRAO = 500;
const PAGINA_MAXIMA = 1000;
const BLOCO_DE_LEITURA = 64 * 1024;
const BYTES_DE_ASSINATURA = 12;
const INT_MAXIMO = 2147483647;
const MS_POR_MINUTO = 60 * 1000;

const SHA256 = /^[0-9a-f]{64}$/;
const PREFIXO = /^(?:[1-9][0-9]{0,14}|padrao)$/;
const NOME_VARIANTE = /^(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const TEMPORARIO = /^(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)\.[0-9a-f]{16}\.tmp$/;
const CODIGO_DO_SISTEMA = /^[A-Z0-9_]{1,30}$/;
const FORMATOS = Object.freeze(['PNG', 'JPEG', 'WEBP']);
const NOMES_DO_MESTRE = Object.freeze(['mestre.png', 'mestre.jpg', 'mestre.webp']);
const ORDEM_DO_ESCOPO = Object.freeze({ RAIZ: 0, PADRAO: 1, EMPRESA: 2 });
const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A assinatura que os primeiros bytes do arquivo precisam ter para o formato registrado. */
const TEM_ASSINATURA = Object.freeze({
  PNG: (b) => b.length >= 8 && b.subarray(0, 8).equals(ASSINATURA_PNG),
  JPEG: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  WEBP: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
});

/** Fachada padrão do sistema de arquivos: SÓ as operações de leitura que o verificador usa. */
const FS_DE_LEITURA = Object.freeze({
  lstat: fsp.lstat,
  readdir: fsp.readdir,
  realpath: fsp.realpath,
  open: fsp.open,
  constants: fsNode.constants,
});

// ------------------------------------------------------------------------------------------------------------------------- utilidades
const codigoDoSistema = (falha) => (typeof falha?.code === 'string' && CODIGO_DO_SISTEMA.test(falha.code) ? falha.code : 'DESCONHECIDO');
const piorClasse = (classes) => classes.reduce((pior, atual) => (GRAVIDADE[atual] > GRAVIDADE[pior] ? atual : pior), CLASSES.INTEGRO);
const hexOuNulo = (valor) => (typeof valor === 'string' && SHA256.test(valor) ? valor : null);
const bytesValidos = (valor) => Number.isInteger(valor) && valor > 0 && valor <= INT_MAXIMO;
const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compararIds = (a, b) => comparar(BigInt(a), BigInt(b));
const tipoDaEntrada = (entrada) => {
  if (entrada.isSymbolicLink()) return 'LINK_SIMBOLICO';
  if (entrada.isDirectory()) return 'DIRETORIO';
  if (entrada.isFile()) return 'ARQUIVO';
  return 'OUTRO';
};
const tipoDoEstado = (estado) => ({ LINK: 'LINK_SIMBOLICO', DIRETORIO: 'DIRETORIO', ARQUIVO: 'ARQUIVO' })[estado.tipo] ?? 'OUTRO';

function validarOpcoes(pool, opcoes) {
  if (opcoes === null || typeof opcoes !== 'object') throw new TypeError('opções obrigatórias');
  if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') throw new TypeError('pool inválido');
  const {
    diretorio, idadeMinimaOrfaoMinutos = IDADE_MINIMA_ORFAO_PADRAO_MINUTOS, agora = Date.now, fs = FS_DE_LEITURA, tamanhoDaPagina = PAGINA_PADRAO,
  } = opcoes;
  if (typeof diretorio !== 'string' || diretorio.trim() === '' || diretorio.includes('\0') || !path.isAbsolute(diretorio)) throw new TypeError('diretório de armazenamento inválido');
  if (!Number.isInteger(idadeMinimaOrfaoMinutos) || idadeMinimaOrfaoMinutos < 0 || idadeMinimaOrfaoMinutos > IDADE_MINIMA_ORFAO_MAXIMA_MINUTOS) throw new TypeError('idade mínima inválida');
  if (!Number.isInteger(tamanhoDaPagina) || tamanhoDaPagina < 1 || tamanhoDaPagina > PAGINA_MAXIMA) throw new TypeError('tamanho de página inválido');
  if (typeof agora !== 'function') throw new TypeError('relógio inválido');
  for (const operacao of ['lstat', 'readdir', 'realpath', 'open']) if (typeof fs?.[operacao] !== 'function') throw new TypeError('fachada de arquivos inválida');
  return { diretorio: path.resolve(diretorio), idadeMinimaOrfaoMinutos, agora, fs, tamanhoDaPagina };
}

// ------------------------------------------------------------------------------------------------------------------------- banco (leitura)
async function paginar(buscar, tamanho) {
  const todos = [];
  let depoisDe = '0';
  for (;;) {
    const pagina = await buscar(depoisDe);
    todos.push(...pagina);
    if (pagina.length < tamanho) return todos;
    const ultimo = pagina[pagina.length - 1].id;
    if (compararIds(ultimo, depoisDe) <= 0) throw new Error('a leitura paginada não avançou');
    depoisDe = ultimo;
  }
}

/** Uma fotografia consistente do banco: tudo numa transação READ ONLY e REPEATABLE READ, sempre desfeita no fim. */
async function lerBanco(pool, tamanhoDaPagina) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const padrao = await paginar((depoisDe) => repositorio.listarPadrao(cliente, { depoisDe, limite: tamanhoDaPagina }), tamanhoDaPagina);
    const empresa = await paginar((depoisDe) => repositorio.listarEmpresa(cliente, { depoisDe, limite: tamanhoDaPagina }), tamanhoDaPagina);
    const empresas = new Set(await repositorio.listarIdsDeEmpresas(cliente));
    const usoPadrao = new Map((await repositorio.contarUsoPadrao(cliente)).map((u) => [u.imagemId, u.materiais]));
    const usoEmpresa = new Map((await repositorio.contarUsoEmpresa(cliente)).map((u) => [`${u.empresaId}:${u.imagemId}`, u.materiais]));
    return { padrao, empresa, empresas, usoPadrao, usoEmpresa };
  } finally {
    try { await cliente.query('ROLLBACK'); } catch { /* a conexão pode já estar inutilizada; o ROLLBACK é só higiene */ }
    cliente.release();
  }
}

// ------------------------------------------------------------------------------------------------------------------------- registros → arquivos esperados
function arquivoEsperado(plano, variante, formato, sha256, bytes) {
  const chave = chaveDe({
    escopo: plano.escopo, ...(plano.escopo === 'EMPRESA' ? { empresaId: plano.empresaId } : {}), sha256: plano.hash, variante, formato,
  });
  return { variante, formato, sha256, bytes, chave, nome: chave.split('/')[2] };
}

/** Plano de UM registro: os arquivos que ele exige, ou o primeiro campo inconsistente (sem valores). */
function planejarPadrao(linha) {
  const hash = hexOuNulo(linha.sha256);
  const plano = { escopo: 'PADRAO', empresaId: null, imagemId: linha.id, ns: 'padrao', hash };
  const invalido = (campo) => ({ ...plano, invalido: campo });
  if (hash === null) return invalido('sha256');
  if (!FORMATOS.includes(linha.formato)) return invalido('formato');
  if (!bytesValidos(linha.bytesMestre)) return invalido('bytes_mestre');
  if (hexOuNulo(linha.sha256Miniatura) === null) return invalido('sha256_miniatura');
  if (!bytesValidos(linha.bytesMiniatura)) return invalido('bytes_miniatura');
  const temHash = linha.sha256Exibicao !== null && linha.sha256Exibicao !== undefined;
  const temBytes = linha.bytesExibicao !== null && linha.bytesExibicao !== undefined;
  if (temHash !== temBytes) return invalido('exibicao');
  if (temHash && (hexOuNulo(linha.sha256Exibicao) === null || !bytesValidos(linha.bytesExibicao))) return invalido('exibicao');
  const arquivos = [arquivoEsperado(plano, 'mestre', linha.formato, hash, linha.bytesMestre)];
  if (temHash) arquivos.push(arquivoEsperado(plano, 'exibicao', 'WEBP', linha.sha256Exibicao, linha.bytesExibicao));
  arquivos.push(arquivoEsperado(plano, 'miniatura', 'WEBP', linha.sha256Miniatura, linha.bytesMiniatura));
  return { ...plano, arquivos };
}

function planejarEmpresa(linha) {
  const empresaValida = Number.isInteger(linha.empresaId) && linha.empresaId >= 1 && linha.empresaId <= INT_MAXIMO;
  const hash = hexOuNulo(linha.sha256);
  const plano = { escopo: 'EMPRESA', empresaId: linha.empresaId, imagemId: linha.id, ns: empresaValida ? String(linha.empresaId) : null, hash };
  const invalido = (campo) => ({ ...plano, invalido: campo });
  if (!empresaValida) return invalido('empresa_id');
  if (hash === null) return invalido('sha256');
  if (!FORMATOS.includes(linha.formato)) return invalido('formato');
  const campos = [
    ['mestre', linha.formato, 'sha256_mestre', linha.sha256Mestre, 'bytes_mestre', linha.bytesMestre],
    ['exibicao', 'WEBP', 'sha256_exibicao', linha.sha256Exibicao, 'bytes_exibicao', linha.bytesExibicao],
    ['miniatura', 'WEBP', 'sha256_miniatura', linha.sha256Miniatura, 'bytes_miniatura', linha.bytesMiniatura],
  ];
  const arquivos = [];
  for (const [variante, formato, campoHash, sha256, campoBytes, bytes] of campos) {
    if (hexOuNulo(sha256) === null) return invalido(campoHash);
    if (!bytesValidos(bytes)) return invalido(campoBytes);
    arquivos.push(arquivoEsperado(plano, variante, formato, sha256, bytes));
  }
  return { ...plano, arquivos };
}

// ------------------------------------------------------------------------------------------------------------------------- disco (leitura)
async function estadoDe(ctx, partes) {
  const caminho = partes.length === 0 ? ctx.raiz : path.join(ctx.raiz, ...partes);
  try {
    const estado = await ctx.fs.lstat(caminho);
    if (estado.isSymbolicLink()) return { tipo: 'LINK' };
    if (estado.isDirectory()) return { tipo: 'DIRETORIO', mtimeMs: estado.mtimeMs };
    if (estado.isFile()) return { tipo: 'ARQUIVO', tamanho: estado.size, mtimeMs: estado.mtimeMs };
    return { tipo: 'OUTRO' };
  } catch (falha) {
    if (falha?.code === 'ENOENT') return { tipo: 'AUSENTE' };
    return { tipo: 'FALHA', codigoSistema: codigoDoSistema(falha) };
  }
}

/** Estado de uma PASTA (empresa ou imagem), guardado: os três arquivos de uma imagem dividem as mesmas duas pastas. */
function estadoDaPasta(ctx, partes) {
  const chave = partes.join('/');
  if (!ctx.pastas.has(chave)) ctx.pastas.set(chave, estadoDe(ctx, partes));
  return ctx.pastas.get(chave);
}

async function listarPasta(ctx, partes) {
  const caminho = partes.length === 0 ? ctx.raiz : path.join(ctx.raiz, ...partes);
  try {
    return { entradas: await ctx.fs.readdir(caminho, { withFileTypes: true }) };
  } catch (falha) {
    return { codigoSistema: codigoDoSistema(falha) };
  }
}

/** Lê o conteúdo sem seguir link, no máximo até o tamanho esperado (+1 byte, para notar crescimento), calculando o SHA-256 e guardando os primeiros bytes. */
async function lerConteudo(ctx, partes, bytesEsperados) {
  const caminho = path.join(ctx.raiz, ...partes);
  let identificador;
  try {
    identificador = await ctx.fs.open(caminho, ctx.fs.constants.O_RDONLY | ctx.fs.constants.O_NOFOLLOW);
  } catch (falha) {
    return { falha };
  }
  try {
    const estado = await identificador.stat();
    if (!estado.isFile()) return { naoRegular: true };
    if (estado.size !== bytesEsperados) return { tamanho: estado.size };
    const hash = crypto.createHash('sha256');
    const inicio = Buffer.alloc(BYTES_DE_ASSINATURA);
    const bloco = Buffer.allocUnsafe(BLOCO_DE_LEITURA);
    let capturados = 0;
    let total = 0;
    for (;;) {
      const { bytesRead } = await identificador.read(bloco, 0, bloco.length, null);
      if (bytesRead === 0) break;
      if (capturados < BYTES_DE_ASSINATURA) {
        const quanto = Math.min(BYTES_DE_ASSINATURA - capturados, bytesRead);
        bloco.copy(inicio, capturados, 0, quanto);
        capturados += quanto;
      }
      total += bytesRead;
      if (total > bytesEsperados) return { tamanho: total };
      hash.update(bloco.subarray(0, bytesRead));
    }
    if (total !== bytesEsperados) return { tamanho: total };
    return { sha256: hash.digest('hex'), inicio: inicio.subarray(0, capturados) };
  } catch (falha) {
    return { falha };
  } finally {
    await identificador.close().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------------------------------------- conferência de um registro
const COMPONENTES = Object.freeze({ EMPRESA: 'PASTA_EMPRESA', IMAGEM: 'PASTA_IMAGEM', ARQUIVO: 'ARQUIVO' });

/** Achado de um componente do caminho que não é o que devia ser (ausente, link, tipo errado) ou que não pôde ser lido. */
function achadoDoComponente(base, estado, componente) {
  if (estado.tipo === 'AUSENTE') return { ...base, tipo: TIPOS.ARQUIVO_AUSENTE, classe: CLASSES.RECUPERAVEL };
  if (estado.tipo === 'FALHA') return { ...base, tipo: TIPOS.LEITURA_FALHOU, classe: CLASSES.INVESTIGAR, codigoSistema: estado.codigoSistema, naoVerificado: true };
  return { ...base, tipo: TIPOS.ENTRADA_INVALIDA, classe: CLASSES.INVESTIGAR, componente, encontrado: tipoDoEstado(estado) };
}

/** Mestre ausente: se existir o mestre com OUTRA extensão, é registro e arquivo discordando do formato, não perda. */
async function achadoDeMestreAusente(ctx, plano, arquivo, base) {
  if (arquivo.variante === 'mestre') {
    for (const nome of NOMES_DO_MESTRE) {
      if (nome === arquivo.nome) continue;
      const outro = await estadoDe(ctx, [plano.ns, plano.hash, nome]);
      if (outro.tipo === 'AUSENTE') continue;
      if (outro.tipo === 'FALHA') return achadoDoComponente(base, outro, COMPONENTES.ARQUIVO);
      ctx.consumidas.add(`${plano.ns}/${plano.hash}/${nome}`);
      return { ...base, tipo: TIPOS.FORMATO_DIVERGENTE, classe: CLASSES.INVESTIGAR, encontrado: nome };
    }
  }
  return { ...base, tipo: TIPOS.ARQUIVO_AUSENTE, classe: CLASSES.RECUPERAVEL };
}

/** Confere UM arquivo esperado. Devolve null quando está íntegro. */
async function conferirArquivo(ctx, plano, arquivo) {
  const base = { variante: arquivo.variante, chave: arquivo.chave };
  const empresa = await estadoDaPasta(ctx, [plano.ns]);
  if (empresa.tipo !== 'DIRETORIO') return achadoDoComponente(base, empresa, COMPONENTES.EMPRESA);
  const imagem = await estadoDaPasta(ctx, [plano.ns, plano.hash]);
  if (imagem.tipo !== 'DIRETORIO') return achadoDoComponente(base, imagem, COMPONENTES.IMAGEM);
  const partes = [plano.ns, plano.hash, arquivo.nome];
  const estado = await estadoDe(ctx, partes);
  if (estado.tipo === 'AUSENTE') return achadoDeMestreAusente(ctx, plano, arquivo, base);
  if (estado.tipo !== 'ARQUIVO') return achadoDoComponente(base, estado, COMPONENTES.ARQUIVO);
  const divergeTamanho = (encontrado) => ({
    ...base, tipo: TIPOS.TAMANHO_DIVERGENTE, classe: CLASSES.INVESTIGAR, esperado: arquivo.bytes, encontrado,
  });
  if (estado.tamanho !== arquivo.bytes) return divergeTamanho(estado.tamanho);

  const lido = await lerConteudo(ctx, partes, arquivo.bytes);
  if (lido.falha) {
    const codigo = lido.falha.code;
    if (codigo === 'ENOENT') return achadoDeMestreAusente(ctx, plano, arquivo, base);
    if (codigo === 'ELOOP') return { ...base, tipo: TIPOS.ENTRADA_INVALIDA, classe: CLASSES.INVESTIGAR, componente: COMPONENTES.ARQUIVO, encontrado: 'LINK_SIMBOLICO' };
    return { ...base, tipo: TIPOS.LEITURA_FALHOU, classe: CLASSES.INVESTIGAR, codigoSistema: codigoDoSistema(lido.falha), naoVerificado: true };
  }
  if (lido.naoRegular) return { ...base, tipo: TIPOS.ENTRADA_INVALIDA, classe: CLASSES.INVESTIGAR, componente: COMPONENTES.ARQUIVO, encontrado: 'OUTRO' };
  if (lido.tamanho !== undefined) return divergeTamanho(lido.tamanho);
  if (lido.sha256 !== arquivo.sha256) {
    return {
      ...base, tipo: TIPOS.SHA256_DIVERGENTE, classe: CLASSES.INVESTIGAR, esperado: arquivo.sha256, encontrado: lido.sha256,
    };
  }
  if (!TEM_ASSINATURA[arquivo.formato](lido.inicio)) {
    return { ...base, tipo: TIPOS.ASSINATURA_DIVERGENTE, classe: CLASSES.INVESTIGAR, formatoRegistrado: arquivo.formato };
  }
  return null;
}

function contarResultado(contagem, achado) {
  if (achado === null) contagem.integros += 1;
  else if (achado.tipo === TIPOS.ARQUIVO_AUSENTE) contagem.ausentes += 1;
  else if (achado.tipo === TIPOS.LEITURA_FALHOU) contagem.naoVerificados += 1;
  else contagem.divergentes += 1;
}

// ------------------------------------------------------------------------------------------------------------------------- varredura do armazenamento
const idadeEmMinutos = (ctx, mtimeMs) => Math.max(0, Math.floor((ctx.agora - mtimeMs) / MS_POR_MINUTO));

function achadoDeEntrada(contexto, entrada, onde) {
  return {
    tipo: TIPOS.ENTRADA_INESPERADA,
    classe: CLASSES.INVESTIGAR,
    escopo: contexto.escopo,
    empresaId: contexto.empresaId,
    hash: contexto.hash,
    onde,
    nome: nomeSeguro(entrada.name),
    encontrado: tipoDaEntrada(entrada),
    recente: false,
  };
}

function achadoDePastaIlegivel(contexto, onde, codigoSistema) {
  return {
    tipo: TIPOS.LEITURA_FALHOU, classe: CLASSES.INVESTIGAR, escopo: contexto.escopo, empresaId: contexto.empresaId, hash: contexto.hash, onde, codigoSistema, naoVerificado: true, recente: false,
  };
}

/** Tamanho e idade (mtime) de arquivos de nome JÁ validado; quem não puder ser lido vira achado de leitura e fica de fora da soma. */
async function medirArquivos(ctx, contexto, ns, hash, nomes) {
  const medidos = [];
  for (const nome of nomes) {
    const estado = await estadoDe(ctx, [ns, hash, nome]);
    if (estado.tipo === 'ARQUIVO') medidos.push({ nome, bytes: estado.tamanho, mtimeMs: estado.mtimeMs });
    else if (estado.tipo === 'FALHA') ctx.achados.push(achadoDePastaIlegivel(contexto, 'PASTA_IMAGEM', estado.codigoSistema));
  }
  return medidos;
}

function achadoDeSobra(ctx, contexto, tipo, classe, medidos, mtimeMsDaPasta) {
  const mtimeMs = medidos.length > 0 ? Math.max(...medidos.map((m) => m.mtimeMs)) : mtimeMsDaPasta;
  const idadeMinutos = idadeEmMinutos(ctx, mtimeMs);
  return {
    tipo,
    classe,
    escopo: contexto.escopo,
    empresaId: contexto.empresaId,
    hash: contexto.hash,
    arquivos: medidos.map((m) => m.nome).sort(comparar),
    bytes: medidos.reduce((soma, m) => soma + m.bytes, 0),
    idadeMinutos,
    recente: idadeMinutos < ctx.idadeMinima,
  };
}

async function varrerPastaDaImagem(ctx, contextoEmpresa, ns, hash) {
  const chavePasta = `${ns}/${hash}`;
  if (ctx.reivindicadas.has(chavePasta)) return;
  const contexto = { ...contextoEmpresa, hash };
  const esperados = ctx.esperados.get(chavePasta);
  const listagem = await listarPasta(ctx, [ns, hash]);
  if (listagem.codigoSistema) {
    ctx.achados.push(achadoDePastaIlegivel(contexto, 'PASTA_IMAGEM', listagem.codigoSistema));
    return;
  }
  const extras = [];
  const temporarios = [];
  for (const entrada of listagem.entradas) {
    const nome = entrada.name;
    const jaTratado = (esperados?.has(nome) ?? false) || ctx.consumidas.has(`${chavePasta}/${nome}`);
    if (jaTratado) continue;
    if (entrada.isFile() && NOME_VARIANTE.test(nome)) extras.push(nome);
    else if (entrada.isFile() && TEMPORARIO.test(nome)) temporarios.push(nome);
    else ctx.achados.push(achadoDeEntrada(contexto, entrada, 'PASTA_IMAGEM'));
  }
  const pastaVazia = listagem.entradas.length === 0;
  if (esperados === undefined && (extras.length > 0 || pastaVazia)) {
    const inexistente = contexto.escopo === 'EMPRESA' && !ctx.empresas.has(contexto.empresaId);
    const tipo = inexistente ? TIPOS.ORFAO_EMPRESA_INEXISTENTE : TIPOS.ORFAO_CONJUNTO;
    const medidos = await medirArquivos(ctx, contexto, ns, hash, extras);
    // Só a pasta vazia usa o mtime da própria pasta; com arquivos, a idade vem do mais novo deles.
    const mtimeDaPasta = pastaVazia ? (await estadoDaPasta(ctx, [ns, hash])).mtimeMs ?? ctx.agora : ctx.agora;
    ctx.achados.push(achadoDeSobra(ctx, contexto, tipo, inexistente ? CLASSES.INVESTIGAR : CLASSES.ORFAO, medidos, mtimeDaPasta));
  } else if (esperados !== undefined && extras.length > 0) {
    const medidos = await medirArquivos(ctx, contexto, ns, hash, extras);
    if (medidos.length > 0) ctx.achados.push(achadoDeSobra(ctx, contexto, TIPOS.ORFAO_VARIANTE, CLASSES.ORFAO, medidos, ctx.agora));
  }
  for (const medido of await medirArquivos(ctx, contexto, ns, hash, temporarios)) {
    ctx.achados.push(achadoDeSobra(ctx, contexto, TIPOS.TEMPORARIO_RESIDUAL, CLASSES.ORFAO, [medido], ctx.agora));
  }
}

async function varrerPastaDaEmpresa(ctx, ns) {
  const escopo = ns === 'padrao' ? 'PADRAO' : 'EMPRESA';
  const contexto = { escopo, empresaId: escopo === 'EMPRESA' ? Number(ns) : null, hash: null };
  const listagem = await listarPasta(ctx, [ns]);
  if (listagem.codigoSistema) {
    ctx.achados.push(achadoDePastaIlegivel(contexto, 'PASTA_EMPRESA', listagem.codigoSistema));
    return;
  }
  for (const entrada of listagem.entradas) {
    if (!entrada.isSymbolicLink() && entrada.isDirectory() && SHA256.test(entrada.name)) await varrerPastaDaImagem(ctx, contexto, ns, entrada.name);
    else ctx.achados.push(achadoDeEntrada(contexto, entrada, 'PASTA_EMPRESA'));
  }
}

/** Varre a raiz; se ela não puder ser listada, o motivo vira alerta (os registros já foram conferidos diretamente, um a um). */
async function varrerRaiz(ctx) {
  const listagem = await listarPasta(ctx, []);
  if (listagem.codigoSistema) {
    ctx.alertas.push({ codigo: ALERTAS.RAIZ_ILEGIVEL, classe: CLASSES.INVESTIGAR, codigoSistema: listagem.codigoSistema });
    return;
  }
  const contexto = { escopo: 'RAIZ', empresaId: null, hash: null };
  for (const entrada of listagem.entradas) {
    if (!entrada.isSymbolicLink() && entrada.isDirectory() && PREFIXO.test(entrada.name)) await varrerPastaDaEmpresa(ctx, entrada.name);
    else ctx.achados.push(achadoDeEntrada(contexto, entrada, 'RAIZ'));
  }
}

// ------------------------------------------------------------------------------------------------------------------------- relatório
const ordemDeImagem = (a, b) => (ORDEM_DO_ESCOPO[a.escopo] - ORDEM_DO_ESCOPO[b.escopo]) || ((a.empresaId ?? 0) - (b.empresaId ?? 0)) || compararIds(a.imagemId, b.imagemId);
const ordemDeSobra = (a, b) => (ORDEM_DO_ESCOPO[a.escopo] - ORDEM_DO_ESCOPO[b.escopo]) || ((a.empresaId ?? 0) - (b.empresaId ?? 0))
  || comparar(a.hash ?? '', b.hash ?? '') || comparar(a.tipo, b.tipo) || comparar(a.arquivos?.[0] ?? a.nome ?? '', b.arquivos?.[0] ?? b.nome ?? '') || comparar(a.onde ?? '', b.onde ?? '');

function montarRelatorio({ ctx, registros, imagens, resumoDeArquivos, alertas }) {
  const armazenamento = [...ctx.achados].sort(ordemDeSobra);
  const contados = armazenamento.filter((a) => !a.recente);
  const contagemPorTipo = (...tiposAlvo) => contados.filter((a) => tiposAlvo.includes(a.tipo)).length;
  const resumoImagens = { INTEGRO: registros.total - imagens.length, RECUPERAVEL: 0, INVESTIGAR: 0 };
  for (const imagem of imagens) resumoImagens[imagem.classe] += 1;

  const resumo = {
    registros,
    arquivos: resumoDeArquivos,
    imagens: resumoImagens,
    armazenamento: {
      conjuntosOrfaos: contagemPorTipo(TIPOS.ORFAO_CONJUNTO, TIPOS.ORFAO_EMPRESA_INEXISTENTE),
      variantesOrfas: contagemPorTipo(TIPOS.ORFAO_VARIANTE),
      temporarios: contagemPorTipo(TIPOS.TEMPORARIO_RESIDUAL),
      entradasInesperadas: contagemPorTipo(TIPOS.ENTRADA_INESPERADA),
      pastasIlegiveis: contagemPorTipo(TIPOS.LEITURA_FALHOU),
      recentes: armazenamento.length - contados.length,
    },
    alertas: alertas.length,
  };
  const veredito = piorClasse([...imagens.map((i) => i.classe), ...contados.map((a) => a.classe), ...alertas.map((a) => a.classe)]);
  return {
    versao: VERSAO_DO_RELATORIO,
    geradoEm: new Date(ctx.agora).toISOString(),
    idadeMinimaOrfaoMinutos: ctx.idadeMinima,
    veredito,
    resumo,
    imagens,
    armazenamento,
    alertas,
  };
}

function relatorioDeRaizInutilizavel(agora, idadeMinima, alerta) {
  return {
    versao: VERSAO_DO_RELATORIO,
    geradoEm: new Date(agora).toISOString(),
    idadeMinimaOrfaoMinutos: idadeMinima,
    veredito: CLASSES.INVESTIGAR,
    resumo: {
      registros: { padrao: 0, empresa: 0, total: 0 },
      arquivos: { esperados: 0, integros: 0, ausentes: 0, divergentes: 0, naoVerificados: 0 },
      imagens: { INTEGRO: 0, RECUPERAVEL: 0, INVESTIGAR: 0 },
      armazenamento: { conjuntosOrfaos: 0, variantesOrfas: 0, temporarios: 0, entradasInesperadas: 0, pastasIlegiveis: 0, recentes: 0 },
      alertas: 1,
    },
    imagens: [],
    armazenamento: [],
    alertas: [{ classe: CLASSES.INVESTIGAR, ...alerta }],
  };
}

/** A raiz resolvida (links na própria raiz são aceitos, como no armazenamento), ou o alerta que explica por que não dá para verificar. Não cria nada. */
async function resolverRaiz(fs, diretorio) {
  let real;
  try {
    real = await fs.realpath(diretorio);
  } catch (falha) {
    if (falha?.code === 'ENOENT' || falha?.code === 'ENOTDIR') return { alerta: { codigo: ALERTAS.RAIZ_AUSENTE } };
    return { alerta: { codigo: ALERTAS.RAIZ_ILEGIVEL, codigoSistema: codigoDoSistema(falha) } };
  }
  let estado;
  try {
    estado = await fs.lstat(real);
  } catch (falha) {
    if (falha?.code === 'ENOENT') return { alerta: { codigo: ALERTAS.RAIZ_AUSENTE } };
    return { alerta: { codigo: ALERTAS.RAIZ_ILEGIVEL, codigoSistema: codigoDoSistema(falha) } };
  }
  if (!estado.isDirectory()) return { alerta: { codigo: ALERTAS.RAIZ_INVALIDA } };
  return { raiz: real };
}

/**
 * Verifica a integridade entre os registros de imagens e os arquivos do armazenamento. SOMENTE LEITURA.
 *
 * @param {{connect: Function}} pool pool do `pg` (ou equivalente): usado só para abrir UMA transação READ ONLY
 * @param {{diretorio: string, idadeMinimaOrfaoMinutos?: number, agora?: () => number, fs?: object, tamanhoDaPagina?: number}} opcoes
 *   `diretorio` é o diretório de imagens (absoluto); `agora` e `fs` existem para os testes injetarem relógio e fachada de arquivos.
 * @returns {Promise<object>} relatório estruturado (ver o cabeçalho do módulo); falhas do banco propagam
 */
async function verificarArmazenamento(pool, opcoes) {
  const {
    diretorio, idadeMinimaOrfaoMinutos, agora, fs, tamanhoDaPagina,
  } = validarOpcoes(pool, opcoes);
  const instante = Number(agora());
  if (!Number.isFinite(instante)) throw new TypeError('relógio inválido');

  const resolvida = await resolverRaiz(fs, diretorio);
  if (resolvida.alerta) return relatorioDeRaizInutilizavel(instante, idadeMinimaOrfaoMinutos, resolvida.alerta);

  const banco = await lerBanco(pool, tamanhoDaPagina);
  const ctx = {
    fs,
    raiz: resolvida.raiz,
    agora: instante,
    idadeMinima: idadeMinimaOrfaoMinutos,
    empresas: banco.empresas,
    pastas: new Map(),
    esperados: new Map(),
    reivindicadas: new Set(),
    consumidas: new Set(),
    achados: [],
    alertas: [],
  };

  const planos = [...banco.padrao.map(planejarPadrao), ...banco.empresa.map(planejarEmpresa)];
  const contagem = { esperados: 0, integros: 0, ausentes: 0, divergentes: 0, naoVerificados: 0 };
  for (const plano of planos) {
    const chavePasta = plano.ns !== null && plano.hash !== null ? `${plano.ns}/${plano.hash}` : null;
    if (plano.invalido) {
      // Registro inconsistente com pasta identificável: a pasta é dele (já está INVESTIGAR); seus arquivos não viram "sobra".
      if (chavePasta !== null) ctx.reivindicadas.add(chavePasta);
      continue;
    }
    const nomes = ctx.esperados.get(chavePasta) ?? new Set();
    for (const arquivo of plano.arquivos) nomes.add(arquivo.nome);
    ctx.esperados.set(chavePasta, nomes);
    contagem.esperados += plano.arquivos.length;
  }

  const imagens = [];
  for (const plano of planos) {
    const achados = [];
    if (plano.invalido) {
      achados.push({
        variante: null, tipo: TIPOS.REGISTRO_INVALIDO, classe: CLASSES.INVESTIGAR, campo: plano.invalido,
      });
    } else {
      for (const arquivo of plano.arquivos) {
        const achado = await conferirArquivo(ctx, plano, arquivo);
        contarResultado(contagem, achado);
        if (achado !== null) achados.push(achado);
      }
    }
    if (achados.length === 0) continue;
    const uso = plano.escopo === 'PADRAO' ? banco.usoPadrao.get(plano.imagemId) : banco.usoEmpresa.get(`${plano.empresaId}:${plano.imagemId}`);
    imagens.push({
      escopo: plano.escopo,
      empresaId: plano.empresaId,
      imagemId: plano.imagemId,
      classe: piorClasse(achados.map((a) => a.classe)),
      materiaisEmUso: uso ?? 0,
      achados,
    });
  }
  imagens.sort(ordemDeImagem);

  await varrerRaiz(ctx);

  const registros = { padrao: banco.padrao.length, empresa: banco.empresa.length, total: banco.padrao.length + banco.empresa.length };
  const orfaosAntigos = ctx.achados.filter((a) => !a.recente && (a.tipo === TIPOS.ORFAO_CONJUNTO || a.tipo === TIPOS.ORFAO_EMPRESA_INEXISTENTE));
  if (contagem.esperados > 0 && contagem.ausentes === contagem.esperados) {
    ctx.alertas.push({ codigo: ALERTAS.NENHUM_ARQUIVO_ESPERADO_PRESENTE, classe: CLASSES.INVESTIGAR });
  }
  if (registros.total === 0 && orfaosAntigos.length > 0) {
    ctx.alertas.push({ codigo: ALERTAS.BANCO_SEM_REGISTROS_COM_ARQUIVOS, classe: CLASSES.INVESTIGAR });
  }
  return montarRelatorio({ ctx, registros, imagens, resumoDeArquivos: contagem, alertas: ctx.alertas });
}

/** Banco e OID da conexão, como o PostgreSQL os informa: o operador confere se o par banco/armazenamento é o certo. */
async function identificarBanco(pool) {
  return repositorio.identificarBanco(pool);
}

module.exports = {
  verificarArmazenamento,
  identificarBanco,
  CLASSES,
  TIPOS,
  ALERTAS,
  IDADE_MINIMA_ORFAO_PADRAO_MINUTOS,
  IDADE_MINIMA_ORFAO_MAXIMA_MINUTOS,
};
