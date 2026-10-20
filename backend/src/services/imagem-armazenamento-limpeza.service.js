'use strict';

const crypto = require('node:crypto');
const fsNode = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const verificador = require('./imagem-armazenamento-verificacao.service');
const imagemEmpresaRepo = require('../repositories/imagem-empresa.repository');
const { chaveDe } = require('../storage/armazenamento-imagens');
const janelaDeEscrita = require('../utils/janela-escrita-imagens');

/**
 * Limpeza de órfãos do armazenamento de imagens (Biblioteca de Imagens, P-ORF-01): ferramenta SEPARADA do verificador, que continua somente leitura.
 *
 * Planejamento: reaproveita o verificador, sem alterá-lo, para ler o banco (uma transação READ ONLY) e o disco (lstat, readdir, realpath e open). Candidato é apenas o que o
 * verificador classifica como ORFAO de empresa e fora de "recente" (idade do arquivo mais novo do conjunto >= retenção); a biblioteca padrão só é relatada; nada INVESTIGAR ou
 * RECUPERAVEL vira candidato; armazenamento que o verificador não considera confiável impede a execução. SIMULAÇÃO (padrão) só lê e relata.
 *
 * Execução (`executar: true`), nesta ordem: (1) a política recusa antes de ler qualquer coisa; (2) adquire a trava de janela (tipo LIMPEZA) ANTES de ler e só a solta, em qualquer
 * desfecho, depois do último commit; (3) planeja e recusa se o armazenamento não for confiável; (4) para cada candidato, na ordem do relatório e até `limite`, abre UMA transação
 * READ ONLY (READ COMMITTED, para enxergar o que um envio acabou de confirmar), toma a MESMA trava de biblioteca que o envio usa (espera limitada), relê o registro por
 * (empresa, SHA-256) e o disco e SÓ ENTÃO remove, ainda sob a trava: arquivo por arquivo e, ficando a pasta da imagem vazia e sem registro, um rmdir. A limpeza nunca escreve no
 * banco; nunca remove registro, biblioteca padrão, link, nome estranho nem diretório que não seja a pasta de uma imagem; só monta caminho de componentes validados sob a raiz
 * já resolvida. O que mudou depois do plano é ignorado com motivo; falha de E/S ao remover isola o conjunto (falhas) e a execução segue; mudança que as travas deveriam
 * impedir (janela perdida, arquivo trocado entre a conferência e a remoção) interrompe a execução com ErroDeLimpeza. Erro inesperado propaga com o código original e, havendo
 * o que relatar, leva em `relatorioParcial` o que já foi feito.
 *
 * Parada cooperativa (G7): `deveParar()` (opção; ausente = nunca para) é consultada ANTES de cada conjunto e nunca durante. O conjunto em andamento SEMPRE termina (remoção completa
 * e fim da transação); depois do pedido nenhum conjunto novo começa (sem transação, sem trava da biblioteca, sem remoção); o que não começou conta em `restantes` e o relatório diz
 * `paradaSolicitada: true`. Pedido que não deixou de fazer nada não é parada. A trava de janela é solta pelo token como em qualquer desfecho. A simulação não consulta o pedido.
 * O planejamento (verificador) não é interrompível: um pedido feito durante ele vale antes do primeiro conjunto.
 *
 * Política (Documento 65, seção 7.2; decisão A de 19/10/2026): retenção >= intervalo entre backups + 60 min, nunca menos de 24 h, e executar exige o intervalo.
 * A recusa por política não lê banco nem disco. O relatório só leva hashes, tipos e nomes de variante já validados pelo verificador: nunca caminho absoluto.
 */

const RETENCAO_MINIMA_MINUTOS = 24 * 60;
const RETENCAO_PADRAO_MINUTOS = 1500;
const RETENCAO_MAXIMA_MINUTOS = verificador.IDADE_MINIMA_ORFAO_MAXIMA_MINUTOS;
const MARGEM_SOBRE_O_INTERVALO_MINUTOS = 60;
const INTERVALO_BACKUP_MAXIMO_MINUTOS = RETENCAO_MAXIMA_MINUTOS - MARGEM_SOBRE_O_INTERVALO_MINUTOS;
const LIMITE_PADRAO = 50;
const LIMITE_MAXIMO = 1000;
const TEMPO_PADRAO_DA_TRAVA_MS = 5000;
const TEMPO_MAXIMO_DA_TRAVA_MS = 60000;
const VERSAO_DO_RELATORIO = 1;
const NOMES_DOS_GANCHOS = ['aposPlanejar', 'aposTravar', 'antesDeRemover', 'aposRemover'];
const ORDEM_DO_TIPO = Object.freeze({ ORFAO_CONJUNTO: 0, ORFAO_VARIANTE: 1, TEMPORARIO_RESIDUAL: 2 });
const SHA256 = /^[0-9a-f]{64}$/;
const EMPRESA = /^[1-9][0-9]{0,14}$/;
const NOME_VARIANTE = /^(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const TEMPORARIO = /^(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)\.[0-9a-f]{16}\.tmp$/;
const CODIGO_DO_SISTEMA = /^[A-Z0-9_]{1,30}$/;
const BLOCO_DE_LEITURA = 64 * 1024;
const MS_POR_MINUTO = 60 * 1000;
const FALHA_AO_REMOVER = 'FALHA_AO_REMOVER';
const PASTA_NAO_VAZIA_OU_SUMIDA = new Set(['ENOTEMPTY', 'EEXIST', 'ENOENT']);
const TRAVA_NAO_OBTIDA_NO_PRAZO = '55P03';

const IMPEDIMENTOS = Object.freeze({
  RETENCAO_ABAIXO_DO_MINIMO: 'RETENCAO_ABAIXO_DO_MINIMO',
  RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP: 'RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP',
  INTERVALO_DE_BACKUP_NAO_INFORMADO: 'INTERVALO_DE_BACKUP_NAO_INFORMADO',
  JANELA_NAO_CONFIGURADA: 'JANELA_NAO_CONFIGURADA',
  JANELA_INVALIDA: 'JANELA_INVALIDA',
  JANELA_OCUPADA: 'JANELA_OCUPADA',
  ARMAZENAMENTO_NAO_CONFIAVEL: 'ARMAZENAMENTO_NAO_CONFIAVEL',
});

const MOTIVOS = Object.freeze({
  REGISTRO_APARECEU: 'REGISTRO_APARECEU',
  MAIS_NOVO_QUE_A_RETENCAO: 'MAIS_NOVO_QUE_A_RETENCAO',
  ENTRADA_ESTRANHA: 'ENTRADA_ESTRANHA',
  TRAVA_OCUPADA: 'TRAVA_OCUPADA',
  JA_REMOVIDO: 'JA_REMOVIDO',
});

/** Erros que INTERROMPEM a execução: algo que as travas deveriam impedir aconteceu, e continuar apagando não é seguro. */
const ERROS = Object.freeze({
  JANELA_PERDIDA: 'JANELA_PERDIDA',
  ARMAZENAMENTO_ALTERADO_DURANTE_A_REMOCAO: 'ARMAZENAMENTO_ALTERADO_DURANTE_A_REMOCAO',
});
const MENSAGENS_DE_ERRO = {
  JANELA_PERDIDA: 'a trava de janela de escrita deixou de ser da limpeza durante a execução',
  ARMAZENAMENTO_ALTERADO_DURANTE_A_REMOCAO: 'um arquivo mudou entre a conferência e a remoção',
};

class ErroDeLimpeza extends Error {
  constructor(codigo) {
    super(MENSAGENS_DE_ERRO[codigo]);
    this.name = 'ErroDeLimpeza';
    this.codigo = codigo;
  }
}

/** Fachada padrão do sistema de arquivos da limpeza: as operações do verificador mais unlink e rmdir, que só a remoção controlada usa. */
const FS_DE_LIMPEZA = Object.freeze({
  lstat: fsp.lstat,
  readdir: fsp.readdir,
  realpath: fsp.realpath,
  open: fsp.open,
  unlink: fsp.unlink,
  rmdir: fsp.rmdir,
  constants: fsNode.constants,
});

const comparar = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const inteiroEntre = (valor, minimo, maximo) => Number.isInteger(valor) && valor >= minimo && valor <= maximo;
const codigoDoSistema = (falha) => (typeof falha?.code === 'string' && CODIGO_DO_SISTEMA.test(falha.code) ? falha.code : 'DESCONHECIDO');

function exigirNumerosDaPolitica({ retencaoMinutos, intervaloBackupMinutos, executar }) {
  if (!inteiroEntre(retencaoMinutos, 0, RETENCAO_MAXIMA_MINUTOS)) throw new TypeError('retenção inválida');
  if (intervaloBackupMinutos !== null && !inteiroEntre(intervaloBackupMinutos, 1, INTERVALO_BACKUP_MAXIMO_MINUTOS)) throw new TypeError('intervalo entre backups inválido');
  if (typeof executar !== 'boolean') throw new TypeError('executar deve ser booleano');
}

/**
 * Impedimentos de POLÍTICA, em ordem fixa (vazio = política aceita). A retenção nunca é menor que 24 h; havendo intervalo entre backups, a retenção precisa ser
 * >= intervalo + margem; para EXECUTAR o intervalo é obrigatório. Valor fora dos limites numéricos é erro de programação (TypeError), não impedimento.
 */
function validarPolitica({ retencaoMinutos = RETENCAO_PADRAO_MINUTOS, intervaloBackupMinutos = null, executar = false } = {}) {
  exigirNumerosDaPolitica({ retencaoMinutos, intervaloBackupMinutos, executar });
  const impedimentos = [];
  if (retencaoMinutos < RETENCAO_MINIMA_MINUTOS) impedimentos.push(IMPEDIMENTOS.RETENCAO_ABAIXO_DO_MINIMO);
  if (intervaloBackupMinutos !== null) {
    if (retencaoMinutos < intervaloBackupMinutos + MARGEM_SOBRE_O_INTERVALO_MINUTOS) impedimentos.push(IMPEDIMENTOS.RETENCAO_NAO_SUPERA_O_INTERVALO_DE_BACKUP);
  } else if (executar) {
    impedimentos.push(IMPEDIMENTOS.INTERVALO_DE_BACKUP_NAO_INFORMADO);
  }
  return impedimentos;
}

function validarJanela(janela) {
  if (janela === undefined || janela === null) return null;
  if (typeof janela !== 'object' || Array.isArray(janela) || typeof janela.arquivo !== 'string') throw new TypeError('janela inválida');
  return { arquivo: janela.arquivo };
}

function validarGanchos(ganchos) {
  if (ganchos === undefined) return {};
  if (ganchos === null || typeof ganchos !== 'object' || Array.isArray(ganchos)) throw new TypeError('ganchos inválidos');
  for (const nome of NOMES_DOS_GANCHOS) if (ganchos[nome] !== undefined && typeof ganchos[nome] !== 'function') throw new TypeError('gancho inválido');
  return ganchos;
}

function validarOpcoes(pool, opcoes) {
  if (pool === null || typeof pool !== 'object' || typeof pool.connect !== 'function') throw new TypeError('pool inválido');
  if (opcoes === null || typeof opcoes !== 'object' || Array.isArray(opcoes)) throw new TypeError('opções obrigatórias');
  const {
    diretorio, executar = false, retencaoMinutos = RETENCAO_PADRAO_MINUTOS, intervaloBackupMinutos = null, janela, limite = LIMITE_PADRAO, agora = Date.now,
    fs = FS_DE_LIMPEZA, tempoMaximoDaTravaMs = TEMPO_PADRAO_DA_TRAVA_MS, ganchos, deveParar = () => false,
  } = opcoes;
  if (typeof diretorio !== 'string' || diretorio.trim() === '' || diretorio.includes('\0') || !path.isAbsolute(diretorio)) throw new TypeError('diretório de armazenamento inválido');
  exigirNumerosDaPolitica({ retencaoMinutos, intervaloBackupMinutos, executar });
  if (!inteiroEntre(limite, 1, LIMITE_MAXIMO)) throw new TypeError('limite inválido');
  if (!inteiroEntre(tempoMaximoDaTravaMs, 1, TEMPO_MAXIMO_DA_TRAVA_MS)) throw new TypeError('tempo máximo da trava inválido');
  if (typeof agora !== 'function') throw new TypeError('relógio inválido');
  if (typeof deveParar !== 'function') throw new TypeError('pedido de parada inválido');
  if (fs === null || typeof fs !== 'object') throw new TypeError('fachada de arquivos inválida');
  for (const operacao of ['lstat', 'readdir', 'realpath', 'open', ...(executar ? ['unlink', 'rmdir'] : [])]) {
    if (typeof fs[operacao] !== 'function') throw new TypeError('fachada de arquivos inválida');
  }
  return {
    diretorio: path.resolve(diretorio),
    executar,
    retencaoMinutos,
    intervaloBackupMinutos,
    janela: validarJanela(janela),
    limite,
    agora,
    fs,
    tempoMaximoDaTravaMs,
    ganchos: validarGanchos(ganchos),
    deveParar,
  };
}

function instanteDoRelogio(agora) {
  const instante = Number(agora());
  if (!Number.isFinite(instante) || Math.abs(instante) > 8.64e15) throw new TypeError('relógio inválido');
  return instante;
}

const ordemDoRelatorio = (a, b) => ((a.empresaId ?? 0) - (b.empresaId ?? 0)) || comparar(a.hash, b.hash)
  || (ORDEM_DO_TIPO[a.tipo] - ORDEM_DO_TIPO[b.tipo]) || comparar(a.arquivos[0] ?? '', b.arquivos[0] ?? '');

const resumirSobra = ({ escopo, empresaId, hash, tipo, arquivos, bytes, idadeMinutos }) => ({
  escopo, empresaId: empresaId ?? null, hash, tipo, arquivos: [...arquivos], bytes, idadeMinutos,
});

/** Separa as sobras que o verificador classificou como ORFAO: candidatas (empresa, fora de "recente"), retidas (empresa, recentes) e fora do escopo (biblioteca padrão). */
function separarSobras(armazenamento) {
  const candidatos = [];
  const retidos = [];
  const foraDoEscopo = [];
  for (const achado of armazenamento) {
    if (achado.classe !== verificador.CLASSES.ORFAO || !Object.hasOwn(ORDEM_DO_TIPO, achado.tipo)) continue;
    const sobra = resumirSobra(achado);
    if (achado.escopo === 'PADRAO') foraDoEscopo.push(sobra);
    else if (achado.escopo === 'EMPRESA') (achado.recente ? retidos : candidatos).push(sobra);
  }
  return { candidatos: candidatos.sort(ordemDoRelatorio), retidos: retidos.sort(ordemDoRelatorio), foraDoEscopo: foraDoEscopo.sort(ordemDoRelatorio) };
}

const janelaNaoAvaliada = (janela) => ({ configurada: janela !== null, estado: janela === null ? 'NAO_CONFIGURADA' : 'NAO_AVALIADA', dono: null });

/** Estado da trava de janela SÓ por leitura (simulação): nunca cria, apaga nem altera o arquivo. */
async function estadoDaJanela(janela, raizArmazenamento) {
  if (janela === null) return { configurada: false, estado: 'NAO_CONFIGURADA', dono: null };
  const { arquivo } = janela;
  try {
    await janelaDeEscrita.validarArquivoDaJanela({ arquivo, raizArmazenamento });
  } catch (erro) {
    if (erro instanceof janelaDeEscrita.ErroDeJanela) return { configurada: true, estado: 'INVALIDA', dono: null };
    throw erro;
  }
  try {
    const dono = await janelaDeEscrita.lerJanela({ arquivo });
    if (dono === null) return { configurada: true, estado: 'LIVRE', dono: null };
    return { configurada: true, estado: 'OCUPADA', dono: { tipo: dono.tipo, pid: dono.pid, iniciadoEm: dono.iniciadoEm } };
  } catch (erro) {
    if (erro instanceof janelaDeEscrita.ErroDeJanela && erro.codigo === 'JANELA_DOCUMENTO_INVALIDO') return { configurada: true, estado: 'OCUPADA', dono: null };
    throw erro;
  }
}

const IMPEDIMENTO_DA_JANELA = Object.freeze({
  NAO_CONFIGURADA: IMPEDIMENTOS.JANELA_NAO_CONFIGURADA, INVALIDA: IMPEDIMENTOS.JANELA_INVALIDA, OCUPADA: IMPEDIMENTOS.JANELA_OCUPADA,
});

function montarRelatorio(base, parte) {
  const { bytesLiberados = 0, ...resto } = parte;
  const completo = {
    versao: VERSAO_DO_RELATORIO,
    geradoEm: base.geradoEm,
    modo: base.executar ? 'EXECUCAO' : 'SIMULACAO',
    retencaoMinutos: base.retencaoMinutos,
    intervaloBackupMinutos: base.intervaloBackupMinutos,
    limite: base.limite,
    veredito: null,
    alertas: [],
    impedimentos: [],
    executavel: false,
    recusa: null,
    janela: janelaNaoAvaliada(base.janela),
    candidatos: [],
    retidos: [],
    foraDoEscopo: [],
    removidos: [],
    ignorados: [],
    falhas: [],
    restantes: 0,
    paradaSolicitada: false,
    ...resto,
  };
  completo.resumo = {
    candidatos: completo.candidatos.length,
    retidos: completo.retidos.length,
    foraDoEscopo: completo.foraDoEscopo.length,
    removidos: completo.removidos.length,
    ignorados: completo.ignorados.length,
    falhas: completo.falhas.length,
    restantes: completo.restantes,
    bytesLiberados,
  };
  return completo;
}

// ------------------------------------------------------------------------------------------------------------------------- caminhos e os ÚNICOS pontos que apagam
/**
 * Caminho absoluto da pasta da empresa, da pasta de uma imagem ou de um arquivo dela, montado SÓ de componentes validados sob a raiz já resolvida. Nada vindo do disco
 * chega aqui sem passar pelos padrões fixos de nome; qualquer desvio é erro de programação.
 */
function caminhoDoArmazenamento(raiz, empresaId, hash = null, nome = null) {
  const partes = [String(empresaId)];
  let valido = Number.isSafeInteger(empresaId) && EMPRESA.test(partes[0]);
  if (hash !== null) { partes.push(hash); valido = valido && SHA256.test(hash); }
  if (nome !== null) { partes.push(nome); valido = valido && hash !== null && (NOME_VARIANTE.test(nome) || TEMPORARIO.test(nome)); }
  const alvo = valido ? path.join(raiz, ...partes) : null;
  if (alvo === null || path.relative(raiz, alvo) !== partes.join(path.sep)) throw new TypeError('caminho de armazenamento inválido');
  return alvo;
}

/** ÚNICO ponto que apaga arquivo: o caminho é remontado aqui, de componentes validados (nunca chega pronto). unlink nunca segue link simbólico. */
async function apagarArquivo(contexto, empresaId, hash, nome) {
  await contexto.fs.unlink(caminhoDoArmazenamento(contexto.raiz, empresaId, hash, nome));
}

/** ÚNICO ponto que apaga pasta: rmdir, nunca recursivo (o sistema recusa pasta não vazia), só da pasta de UMA imagem; jamais a da empresa nem a raiz. */
async function apagarPastaVazia(contexto, empresaId, hash) {
  await contexto.fs.rmdir(caminhoDoArmazenamento(contexto.raiz, empresaId, hash));
}

// ------------------------------------------------------------------------------------------------------------------------- reconferência do disco (sem apagar nada)
const identidadeDe = (estado) => ({
  dev: estado.dev, ino: estado.ino, size: estado.size, mtimeMs: estado.mtimeMs,
});
const mesmaIdentidade = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
const idadeEmMinutos = (instante, mtimeMs) => Math.max(0, Math.floor((instante - mtimeMs) / MS_POR_MINUTO));
const ehDiretorio = (lido) => lido.estado !== undefined && lido.estado.isDirectory();

/** lstat sem seguir o último componente. ENOENT = ausente; ENOTDIR/ELOOP = o caminho deixou de ter a forma esperada; qualquer outro erro propaga com o código original. */
async function estadoDoCaminho(contexto, caminho) {
  try {
    return { estado: await contexto.fs.lstat(caminho) };
  } catch (falha) {
    if (falha?.code === 'ENOENT') return { ausente: true };
    if (falha?.code === 'ENOTDIR' || falha?.code === 'ELOOP') return { estranho: true };
    throw falha;
  }
}

/** Nomes dos três arquivos que um registro exige (como o verificador os deriva), ou null se o registro não se deixa interpretar. */
function nomesEsperados(empresaId, hash, formato) {
  try {
    const nomeDe = (variante, formatoDaVariante) => chaveDe({ escopo: 'EMPRESA', empresaId, sha256: hash, variante, formato: formatoDaVariante }).split('/')[2];
    return new Set([nomeDe('mestre', formato), nomeDe('exibicao', 'WEBP'), nomeDe('miniatura', 'WEBP')]);
  } catch {
    return null;
  }
}

/** Lê e resume UM arquivo sem seguir link (O_NOFOLLOW), conferindo que é o mesmo que o lstat mediu e que não mudou enquanto era lido. */
async function resumirArquivo(contexto, empresaId, hash, { nome, identidade }) {
  let aberto;
  try {
    aberto = await contexto.fs.open(caminhoDoArmazenamento(contexto.raiz, empresaId, hash, nome), contexto.fs.constants.O_RDONLY | contexto.fs.constants.O_NOFOLLOW);
  } catch (falha) {
    if (falha?.code === 'ENOENT') return { ausente: true };
    if (falha?.code === 'ELOOP' || falha?.code === 'ENOTDIR') return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };
    throw falha;
  }
  try {
    const estado = await aberto.stat();
    if (!estado.isFile()) return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };
    const aberta = identidadeDe(estado);
    if (aberta.dev !== identidade.dev || aberta.ino !== identidade.ino) return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };
    if (!mesmaIdentidade(aberta, identidade)) return { ignorar: MOTIVOS.MAIS_NOVO_QUE_A_RETENCAO };
    const resumo = crypto.createHash('sha256');
    const bloco = Buffer.allocUnsafe(BLOCO_DE_LEITURA);
    let total = 0;
    for (;;) {
      const { bytesRead } = await aberto.read(bloco, 0, bloco.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > estado.size) return { ignorar: MOTIVOS.MAIS_NOVO_QUE_A_RETENCAO };
      resumo.update(bloco.subarray(0, bytesRead));
    }
    if (total !== estado.size) return { ignorar: MOTIVOS.MAIS_NOVO_QUE_A_RETENCAO };
    return { alvo: { nome, bytes: estado.size, sha256: resumo.digest('hex'), identidade } };
  } finally {
    await aberto.close().catch(() => {});
  }
}

/**
 * Relê, sob a trava da biblioteca, o que o plano viu. Devolve { ignorar: motivo } se a situação mudou, ou { alvos, temRegistro } com os arquivos verificados (nome, tamanho,
 * SHA-256 e identidade no disco). Não apaga nada. Toda entrada da pasta tem de ser um alvo, um resíduo de gravação ou um arquivo que o registro atual exige; qualquer outra
 * coisa (inclusive link e diretório) ignora o conjunto inteiro, sem remover nem os arquivos legítimos.
 */
async function inspecionar(contexto, candidato, registro) {
  const { empresaId, hash, tipo, arquivos } = candidato;
  const esperados = registro === null ? null : nomesEsperados(empresaId, hash, registro.formato);
  if (registro !== null && (tipo === 'ORFAO_CONJUNTO' || esperados === null || arquivos.some((nome) => esperados.has(nome)))) return { ignorar: MOTIVOS.REGISTRO_APARECEU };

  const daEmpresa = await estadoDoCaminho(contexto, caminhoDoArmazenamento(contexto.raiz, empresaId));
  if (daEmpresa.ausente) return { ignorar: MOTIVOS.JA_REMOVIDO };
  if (!ehDiretorio(daEmpresa)) return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };
  const pasta = caminhoDoArmazenamento(contexto.raiz, empresaId, hash);
  const daPasta = await estadoDoCaminho(contexto, pasta);
  if (daPasta.ausente) return { ignorar: MOTIVOS.JA_REMOVIDO };
  if (!ehDiretorio(daPasta)) return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };

  let entradas;
  try {
    entradas = await contexto.fs.readdir(pasta, { withFileTypes: true });
  } catch (falha) {
    if (falha?.code === 'ENOENT') return { ignorar: MOTIVOS.JA_REMOVIDO };
    throw falha;
  }
  if (arquivos.length === 0 && entradas.length > 0) return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };
  const alvos = new Set(arquivos);
  const presentes = new Set();
  for (const entrada of entradas) {
    if (alvos.has(entrada.name)) {
      if (!entrada.isFile()) return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };
      presentes.add(entrada.name);
    } else if (!entrada.isFile() || !(TEMPORARIO.test(entrada.name) || (esperados !== null && esperados.has(entrada.name)))) {
      return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };
    }
  }

  const medidos = [];
  for (const nome of arquivos.filter((candidata) => presentes.has(candidata))) {
    const lido = await estadoDoCaminho(contexto, caminhoDoArmazenamento(contexto.raiz, empresaId, hash, nome));
    if (lido.ausente) continue;
    if (lido.estado === undefined || !lido.estado.isFile()) return { ignorar: MOTIVOS.ENTRADA_ESTRANHA };
    medidos.push({ nome, identidade: identidadeDe(lido.estado) });
  }
  if (arquivos.length > 0 && medidos.length === 0) return { ignorar: MOTIVOS.JA_REMOVIDO };
  const maisNovo = arquivos.length === 0 ? daPasta.estado.mtimeMs : Math.max(...medidos.map((medido) => medido.identidade.mtimeMs));
  if (idadeEmMinutos(contexto.instante, maisNovo) < contexto.retencaoMinutos) return { ignorar: MOTIVOS.MAIS_NOVO_QUE_A_RETENCAO };

  const verificados = [];
  for (const medido of medidos) {
    const resumo = await resumirArquivo(contexto, empresaId, hash, medido);
    if (resumo.ignorar !== undefined) return resumo;
    if (resumo.alvo !== undefined) verificados.push(resumo.alvo);
  }
  if (arquivos.length > 0 && verificados.length === 0) return { ignorar: MOTIVOS.JA_REMOVIDO };
  return { alvos: verificados, temRegistro: registro !== null };
}

/** A trava de janela ainda é da limpeza? Conferido logo antes de apagar, pelo TOKEN da aquisição: se alguém a tirou ou a trocou (um backup, ou outra trava com tipo, PID e instante iguais), nada mais é apagado. */
async function exigirPosseDaJanela(contexto) {
  const { confirmada } = await contexto.posse.confirmarPosse();
  if (!confirmada) throw new ErroDeLimpeza(ERROS.JANELA_PERDIDA);
}

// ------------------------------------------------------------------------------------------------------------------------- remoção de UM candidato
/**
 * Apaga os alvos verificados (ordem alfabética) e, se a pasta da imagem não tem registro, tenta o rmdir. Antes de cada unlink confere que o arquivo ainda é o mesmo que foi
 * lido; se mudou, interrompe a execução. unlink que falha isola o conjunto (falhas) e para por ali; arquivo que já sumiu não é falha; rmdir de pasta que não está mais
 * vazia (ou que já não existe) não é falha, só deixa `pastaRemovida` falso. O registro do resultado é feito aqui, antes de qualquer gancho ou commit.
 */
async function remover(contexto, candidato, inspecao, acumulado) {
  const { empresaId, hash, tipo } = candidato;
  const arquivos = [];
  const registrarFalha = (falha) => acumulado.falhas.push({
    empresaId, hash, tipo, codigo: FALHA_AO_REMOVER, codigoSistema: codigoDoSistema(falha),
  });
  for (const alvo of inspecao.alvos) {
    const atual = await estadoDoCaminho(contexto, caminhoDoArmazenamento(contexto.raiz, empresaId, hash, alvo.nome));
    if (atual.ausente) continue;
    if (atual.estado === undefined || !atual.estado.isFile() || !mesmaIdentidade(identidadeDe(atual.estado), alvo.identidade)) {
      throw Object.assign(new ErroDeLimpeza(ERROS.ARMAZENAMENTO_ALTERADO_DURANTE_A_REMOCAO), { conjunto: { empresaId, hash, tipo, arquivosJaRemovidos: arquivos } });
    }
    try {
      await apagarArquivo(contexto, empresaId, hash, alvo.nome);
    } catch (falha) {
      if (falha?.code === 'ENOENT') continue;
      registrarFalha(falha);
      return;
    }
    contexto.bytesLiberados += alvo.bytes;
    arquivos.push({ nome: alvo.nome, bytes: alvo.bytes, sha256: alvo.sha256 });
  }
  let pastaRemovida = false;
  if (!inspecao.temRegistro) {
    try {
      await apagarPastaVazia(contexto, empresaId, hash);
      pastaRemovida = true;
    } catch (falha) {
      if (!PASTA_NAO_VAZIA_OU_SUMIDA.has(falha?.code)) {
        registrarFalha(falha);
        return;
      }
    }
  }
  acumulado.removidos.push({ empresaId, hash, tipo, arquivos, pastaRemovida });
}

/**
 * UM candidato em UMA transação READ ONLY (READ COMMITTED: a leitura do registro depois de obter a trava enxerga o que um envio acabou de confirmar): trava da biblioteca da
 * empresa (a mesma do envio, com espera limitada), registro, disco, remoção, fim da transação. A transação só termina depois da remoção; erro inesperado a desfaz e propaga.
 */
async function processarCandidato(contexto, ganchos, candidato, acumulado) {
  const { empresaId, hash, tipo } = candidato;
  const identificacao = () => ({ empresaId, hash, tipo });
  const cliente = await contexto.pool.connect();
  let aberta = false;
  try {
    await cliente.query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    aberta = true;
    await cliente.query("SELECT set_config('lock_timeout', $1, true)", [`${contexto.tempoMaximoDaTravaMs}ms`]);
    try {
      await imagemEmpresaRepo.travarBiblioteca(cliente, empresaId);
    } catch (falha) {
      if (falha?.code !== TRAVA_NAO_OBTIDA_NO_PRAZO) throw falha;
      acumulado.ignorados.push({ ...identificacao(), motivo: MOTIVOS.TRAVA_OCUPADA });
      return;
    }
    if (ganchos.aposTravar !== undefined) await ganchos.aposTravar(identificacao());
    const registro = await imagemEmpresaRepo.buscarPorSha256(cliente, empresaId, hash);
    const inspecao = await inspecionar(contexto, candidato, registro);
    if (inspecao.ignorar !== undefined) {
      acumulado.ignorados.push({ ...identificacao(), motivo: inspecao.ignorar });
    } else {
      if (ganchos.antesDeRemover !== undefined) await ganchos.antesDeRemover(identificacao());
      await exigirPosseDaJanela(contexto);
      await remover(contexto, candidato, inspecao, acumulado);
      if (ganchos.aposRemover !== undefined) await ganchos.aposRemover(identificacao());
    }
    await cliente.query('COMMIT');
    aberta = false;
  } finally {
    if (aberta) {
      try { await cliente.query('ROLLBACK'); } catch { /* a conexão pode já estar inutilizada; o ROLLBACK é só higiene (a transação só lê) */ }
    }
    cliente.release();
  }
}

// ------------------------------------------------------------------------------------------------------------------------- execução
const donoPublico = (dono) => (dono === null ? null : { tipo: dono.tipo, pid: dono.pid, iniciadoEm: dono.iniciadoEm });

/** Toma a trava de janela da limpeza ou devolve a recusa que a explica; erro inesperado (E/S) propaga com o código original. */
async function tomarJanela(o, instante) {
  if (o.janela === null) {
    return { recusa: { codigo: IMPEDIMENTOS.JANELA_NAO_CONFIGURADA }, janela: { configurada: false, estado: 'NAO_CONFIGURADA', dono: null } };
  }
  try {
    const posse = await janelaDeEscrita.adquirirJanela({
      arquivo: o.janela.arquivo, tipo: janelaDeEscrita.TIPOS.LIMPEZA, raizArmazenamento: o.diretorio, agora: () => instante,
    });
    return { posse };
  } catch (erro) {
    if (!(erro instanceof janelaDeEscrita.ErroDeJanela)) throw erro;
    if (erro.codigo === 'JANELA_OCUPADA') {
      return {
        recusa: { codigo: IMPEDIMENTOS.JANELA_OCUPADA, dono: donoPublico(erro.dono) },
        janela: { configurada: true, estado: 'OCUPADA', dono: donoPublico(erro.dono) },
      };
    }
    if (erro.codigo === 'JANELA_ARQUIVO_INVALIDO' || erro.codigo === 'JANELA_DENTRO_DO_ARMAZENAMENTO') {
      return { recusa: { codigo: IMPEDIMENTOS.JANELA_INVALIDA, motivo: erro.codigo }, janela: { configurada: true, estado: 'INVALIDA', dono: null } };
    }
    throw erro;
  }
}

/** Raiz real do armazenamento (link só na própria raiz, como no verificador), ou null se deixou de ser um diretório. */
async function resolverRaizReal(fs, diretorio) {
  let real;
  try {
    real = await fs.realpath(diretorio);
  } catch (falha) {
    if (falha?.code === 'ENOENT' || falha?.code === 'ENOTDIR') return null;
    throw falha;
  }
  const lido = await estadoDoCaminho({ fs }, real);
  return ehDiretorio(lido) ? real : null;
}

function recusarPorArmazenamento(acumulado) {
  acumulado.executavel = false;
  acumulado.impedimentos = [IMPEDIMENTOS.ARMAZENAMENTO_NAO_CONFIAVEL];
  acumulado.recusa = { codigo: IMPEDIMENTOS.ARMAZENAMENTO_NAO_CONFIAVEL };
  acumulado.restantes = 0;
}

/** Com a janela já tomada: planeja, recusa se o armazenamento não for confiável e processa os candidatos, um a um, até `limite`. Escreve o que faz em `acumulado`. */
async function trabalhar(contexto, o, base, acumulado) {
  const plano = await verificador.verificarArmazenamento(contexto.pool, {
    diretorio: o.diretorio, idadeMinimaOrfaoMinutos: o.retencaoMinutos, agora: () => contexto.instante, fs: o.fs,
  });
  Object.assign(acumulado, { veredito: plano.veredito, alertas: plano.alertas.map((alerta) => alerta.codigo), ...separarSobras(plano.armazenamento) });
  const naoConfiavel = plano.veredito === verificador.CLASSES.RECUPERAVEL || plano.veredito === verificador.CLASSES.INVESTIGAR || plano.alertas.length > 0;
  if (naoConfiavel) {
    recusarPorArmazenamento(acumulado);
    return;
  }
  const lote = acumulado.candidatos.slice(0, o.limite);
  acumulado.executavel = true;
  acumulado.restantes = acumulado.candidatos.length - lote.length;
  if (o.ganchos.aposPlanejar !== undefined) {
    const nosso = { tipo: janelaDeEscrita.TIPOS.LIMPEZA, pid: process.pid, iniciadoEm: contexto.iniciadoEm };
    await o.ganchos.aposPlanejar(montarRelatorio(base, { ...acumulado, janela: { configurada: true, estado: 'OCUPADA', dono: nosso } }));
  }
  if (lote.length === 0) return;
  contexto.raiz = await resolverRaizReal(o.fs, o.diretorio);
  if (contexto.raiz === null) {
    recusarPorArmazenamento(acumulado);
    return;
  }
  for (let i = 0; i < lote.length; i += 1) {
    if (o.deveParar() === true) {
      acumulado.paradaSolicitada = true;
      acumulado.restantes += lote.length - i;
      break;
    }
    await processarCandidato(contexto, o.ganchos, lote[i], acumulado);
  }
}

/** O relatório do que já foi feito vai junto do erro (propriedade não enumerável: não aparece em log nem em JSON por descuido). */
function anexarRelatorioParcial(falha, relatorio) {
  if (falha === null || typeof falha !== 'object' || !Object.isExtensible(falha)) return;
  Object.defineProperty(falha, 'relatorioParcial', {
    value: relatorio, enumerable: false, configurable: true, writable: true,
  });
}

/**
 * A janela é tomada ANTES de qualquer leitura e só solta DEPOIS do último commit, em qualquer desfecho. Janela perdida no fim, ou que não pôde ser solta, nunca vira sucesso:
 * o erro leva o relatório completo. Erro do trabalho tem prioridade sobre o da liberação.
 */
async function executarLimpeza(pool, o, base, instante) {
  let adquirida;
  try {
    adquirida = await tomarJanela(o, instante);
  } catch (falha) {
    anexarRelatorioParcial(falha, montarRelatorio(base, {}));
    throw falha;
  }
  if (adquirida.recusa !== undefined) {
    return montarRelatorio(base, { impedimentos: [adquirida.recusa.codigo], recusa: adquirida.recusa, janela: adquirida.janela });
  }
  const contexto = {
    pool,
    fs: o.fs,
    instante,
    retencaoMinutos: o.retencaoMinutos,
    tempoMaximoDaTravaMs: o.tempoMaximoDaTravaMs,
    posse: adquirida.posse,
    iniciadoEm: new Date(instante).toISOString(),
    raiz: null,
    bytesLiberados: 0,
  };
  const acumulado = {
    veredito: null, alertas: [], impedimentos: [], executavel: false, recusa: null, candidatos: [], retidos: [], foraDoEscopo: [], removidos: [], ignorados: [], falhas: [], restantes: 0,
    paradaSolicitada: false,
  };
  let interrupcao = null;
  try {
    await trabalhar(contexto, o, base, acumulado);
  } catch (falha) {
    interrupcao = { falha };
  }
  let estado = 'LIBERADA';
  let falhaDaLiberacao = null;
  try {
    if (!(await adquirida.posse.liberar()).liberada) estado = 'PERDIDA';
  } catch (falha) {
    estado = 'NAO_LIBERADA';
    falhaDaLiberacao = { falha };
  }
  const relatorio = montarRelatorio(base, { ...acumulado, bytesLiberados: contexto.bytesLiberados, janela: { configurada: true, estado, dono: null } });
  const desfecho = interrupcao ?? (estado === 'PERDIDA' ? { falha: new ErroDeLimpeza(ERROS.JANELA_PERDIDA) } : falhaDaLiberacao);
  if (desfecho === null) return relatorio;
  anexarRelatorioParcial(desfecho.falha, relatorio);
  throw desfecho.falha;
}

// ------------------------------------------------------------------------------------------------------------------------- simulação
/** SIMULAÇÃO: só lê (banco em transação READ ONLY, disco e a trava de janela) e relata; nunca toma a trava, nunca apaga. */
async function simular(pool, o, base, instante, politica) {
  const plano = await verificador.verificarArmazenamento(pool, {
    diretorio: o.diretorio, idadeMinimaOrfaoMinutos: o.retencaoMinutos, agora: () => instante, fs: o.fs,
  });
  const janela = await estadoDaJanela(o.janela, o.diretorio);
  const naoConfiavel = plano.veredito === verificador.CLASSES.RECUPERAVEL || plano.veredito === verificador.CLASSES.INVESTIGAR || plano.alertas.length > 0;
  const impedimentos = [
    ...politica,
    ...(IMPEDIMENTO_DA_JANELA[janela.estado] ? [IMPEDIMENTO_DA_JANELA[janela.estado]] : []),
    ...(naoConfiavel ? [IMPEDIMENTOS.ARMAZENAMENTO_NAO_CONFIAVEL] : []),
  ];
  const relatorio = montarRelatorio(base, {
    veredito: plano.veredito,
    alertas: plano.alertas.map((alerta) => alerta.codigo),
    impedimentos,
    executavel: impedimentos.length === 0,
    janela,
    ...separarSobras(plano.armazenamento),
  });
  if (o.ganchos.aposPlanejar !== undefined) await o.ganchos.aposPlanejar(relatorio);
  return relatorio;
}

/**
 * Limpa os órfãos do armazenamento. SIMULAÇÃO (padrão): só lê e relata. EXECUÇÃO (`executar: true`): ver o cabeçalho do módulo. Valor de opção inválido é TypeError e nada é lido.
 * A política é avaliada antes de qualquer leitura: o piso da retenção recusa nos dois modos; na execução qualquer impedimento de política recusa; na simulação os demais
 * impedimentos são só informados em `impedimentos`. Recusa devolve o relatório com `recusa`; falha inesperada propaga (ver `relatorioParcial`).
 */
async function limparOrfaos(pool, opcoes) {
  const o = validarOpcoes(pool, opcoes);
  const instante = instanteDoRelogio(o.agora);
  const base = {
    geradoEm: new Date(instante).toISOString(),
    executar: o.executar,
    retencaoMinutos: o.retencaoMinutos,
    intervaloBackupMinutos: o.intervaloBackupMinutos,
    limite: o.limite,
    janela: o.janela,
  };
  const politica = validarPolitica({ retencaoMinutos: o.retencaoMinutos, intervaloBackupMinutos: o.intervaloBackupMinutos, executar: true });
  const recusaPorPolitica = o.executar ? politica[0] : politica.find((impedimento) => impedimento === IMPEDIMENTOS.RETENCAO_ABAIXO_DO_MINIMO);
  if (recusaPorPolitica !== undefined) return montarRelatorio(base, { impedimentos: politica, recusa: { codigo: recusaPorPolitica } });
  if (o.executar) return executarLimpeza(pool, o, base, instante);
  return simular(pool, o, base, instante, politica);
}

module.exports = {
  limparOrfaos,
  validarPolitica,
  ErroDeLimpeza,
  RETENCAO_MINIMA_MINUTOS,
  RETENCAO_PADRAO_MINUTOS,
  RETENCAO_MAXIMA_MINUTOS,
  MARGEM_SOBRE_O_INTERVALO_MINUTOS,
  INTERVALO_BACKUP_MAXIMO_MINUTOS,
  LIMITE_PADRAO,
  LIMITE_MAXIMO,
  IMPEDIMENTOS,
  MOTIVOS,
  ERROS,
  FS_DE_LIMPEZA,
};
