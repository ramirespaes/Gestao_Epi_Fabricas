'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { criarSelagem } = require('./imagem-backup-selagem.service');
const { criarServicoDePacote } = require('./imagem-backup-publicacao.service');
const { criarLeitorV2, ehFonteDeChaves } = require('./imagem-backup-manifesto-autenticado.service');
const { planejarArquivos } = require('./imagem-backup-plano.service');
const { criarArmazenamentoImagens } = require('../storage/armazenamento-imagens');
const { ehFaltaDeEspaco } = require('../utils/orcamento-de-bytes');
const { ehRegistroDeOperacoes } = require('../utils/registro-operacoes-pendentes');
const { lerSituacao, ESTADOS: ESTADOS_DO_REGISTRO } = require('./imagem-backup-registro-publicacao.service');

const lerNoDescritor = promisify(fs.read);

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, MARCO D): RESTAURAÇÃO INDEPENDENTE de um pacote completo. Contrato PROVISÓRIO, para chamador confiável. A restauração parte SÓ dos arquivos persistidos do pacote: nada de closures,
 * objetos, marcas em memória, correlações ou evidências da criação original do backup. Nenhuma entrada aceita evidência pronta (chaves desconhecidas, como `correlacao`, `pacote`, `recuperavel` ou `restauracaoReal`, são recusadas).
 *
 * `abrirPacote({ raizAutorizada, nome })` -> { ok:true, ...} | { ok:false, motivo } (congelado, motivos fixos, sem caminho). Ordem: (1) a raiz é absoluta, canônica, existente, real e não é link; (2) o nome é um único componente seguro e o
 * pacote é um diretório real (não link) cujo caminho real é ele mesmo; (3) a SELAGEM é relida do disco pelo componente aprovado (`manifesto.json` + `manifesto.sha256`), que também valida o manifesto canônico; (4) o conjunto de arquivos
 * encontrado é EXATAMENTE o esperado pelo manifesto (`imagens/<chave>`, `manifesto.json`, `manifesto.sha256`, `dump/postgres.dump`: nem faltante, nem extra, sem link) e cada arquivo é relido (tamanho e SHA-256 contra o manifesto, o manifesto contra o
 * digest da selagem, o dump contra `manifesto.dump`). Motivos: ORIGEM_NAO_AUTORIZADA, PACOTE_AUSENTE, LINK_SIMBOLICO, PACOTE_INVALIDO, CAMINHO_FORA_DA_ORIGEM, SELAGEM_INVALIDA, ARQUIVO_AUSENTE, ARQUIVO_EXTRA, ENTRADA_INVALIDA,
 * ARQUIVO_DIVERGENTE, MANIFESTO_ADULTERADO, SELO_DIVERGENTE, LEITURA_FALHOU.
 *
 * `criarRestaurador({ ops?, restauradorDoBanco? })` -> `{ restaurarPacote({ raizAutorizada, nome, imagens: { raiz, nome }, banco?: { destino } }) }`. Ordem: pacote lido e verificado -> imagens restauradas em destino NOVO e isolado (mkdir exclusivo, 0700; destino
 * existente = DESTINO_EXISTENTE sem tocar em nada; gravação pelo armazenamento de imagens, que não sobrescreve e confere o SHA-256; cada arquivo lido do pacote é conferido (tamanho e SHA-256) NO MOMENTO da leitura; depois o destino é relido: conjunto exato e
 * SHA-256 de cada arquivo) -> banco (SÓ se solicitado, pelo restaurador INJETADO, com o dump conferido de novo imediatamente antes e entregue como entrada padrão) -> o pacote é relido ao final e precisa estar igual. Uma falha em qualquer etapa interrompe as
 * seguintes; NADA é apagado (destino parcial e banco temporário parcial ficam como estão: a limpeza de destino cuja propriedade não está comprovada é decisão humana) e o pacote de origem nunca é alterado.
 *
 * O RESULTADO diz sempre `restauracaoReal: false` e `recuperavel: false`, e `consistenciaLogica.verificada: false`: uma restauração com executor injetado/simulado NÃO é restauração operacional real, e hashes individuais coincidentes NÃO provam consistência lógica
 * entre PostgreSQL e imagens (nenhuma conferência das tabelas restauradas contra os arquivos existe; CONS-02 permanece com as suas limitações).
 *
 * LIMITES DO FORMATO ATUAL (campos ausentes, não fabricados): o manifesto não traz (a) o caminho relativo do dump (`dump.arquivo`) nem (b) a versão do LAYOUT do pacote; ambos são convenção fixa deste módulo (`dump/postgres.dump`, `imagens/<chave>`). Também não traz
 * autenticação: SHA-256 sem assinatura/HMAC não autentica (quem regrava manifesto e selo juntos é aceito). Extensão mínima: versão 2 do manifesto com `dump.arquivo`, `layout` e um HMAC/assinatura com segredo fora do pacote.
 */

const SEGMENTO = /^[A-Za-z0-9._+~@-]{1,255}$/;
const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BLOCO = 1024 * 1024;
const ARQUIVO_DO_DUMP = 'postgres.dump';
const PASTA_DO_DUMP = 'dump';
const RDONLY_SEM_LINK = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const LIMITES = Object.freeze(['SEM_RESTAURACAO_OPERACIONAL_REAL', 'SEM_CONSISTENCIA_LOGICA_BANCO_IMAGENS', 'SEM_AUTENTICACAO_DO_MANIFESTO', 'LAYOUT_DO_PACOTE_POR_CONVENCAO']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const caminhoAbsolutoCanonico = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 4096 && v[0] === '/' && v.slice(1).split('/').every((p) => SEGMENTO.test(p) && p !== '.' && p !== '..');
const recusa = (motivo, extra = {}) => Object.freeze({ ok: false, motivo, ...extra });
const erroDeParametros = () => Object.assign(new TypeError('parâmetros da restauração inválidos'), { code: 'PARAMETROS_INVALIDOS' });
const dentroDe = (pasta, raiz) => pasta === raiz || pasta.startsWith(raiz.endsWith('/') ? raiz : `${raiz}/`);

async function diretorioReal(caminho) {
  try {
    const estado = await fsp.lstat(caminho);
    return estado.isDirectory() && !estado.isSymbolicLink() && fs.realpathSync(caminho) === caminho;
  } catch {
    return false;
  }
}

/** Leitura SEGURA de um arquivo do pacote: sem seguir link, regular, tamanho exato; devolve os bytes. */
async function lerArquivoSeguro(caminho, bytesEsperados) {
  const h = await fsp.open(caminho, RDONLY_SEM_LINK);
  try {
    const estado = await h.stat({ bigint: true });
    if (!estado.isFile() || Number(estado.size) !== bytesEsperados) return null;
    const dados = Buffer.allocUnsafe(bytesEsperados);
    let lidos = 0;
    while (lidos < bytesEsperados) {
      const { bytesRead } = await h.read(dados, lidos, bytesEsperados - lidos, lidos);
      if (bytesRead === 0) return null;
      lidos += bytesRead;
    }
    const { bytesRead: excesso } = await h.read(Buffer.allocUnsafe(1), 0, 1, lidos);
    return excesso === 0 ? dados : null;
  } finally {
    await h.close().catch(() => {});
  }
}

const OPS_PADRAO = Object.freeze({
  lerImagem: (caminho, bytesEsperados) => lerArquivoSeguro(caminho, bytesEsperados),
  gravarImagem: (armazenamento, chave, bytes, opcoes) => armazenamento.gravar(chave, bytes, opcoes),
});
function completarOps(ops) {
  if (ops === undefined) return OPS_PADRAO;
  if (!ehObjeto(ops) || !Reflect.ownKeys(ops).every((k) => typeof k === 'string' && Object.hasOwn(OPS_PADRAO, k)) || !Object.values(ops).every(ehFuncao)) throw erroDeParametros();
  return Object.freeze({ ...OPS_PADRAO, ...ops });
}

const mapaDeMotivos = {
  ARQUIVO_AUSENTE: 'ARQUIVO_AUSENTE',
  ARQUIVO_EXTRA: 'ARQUIVO_EXTRA',
  ENTRADA_INVALIDA: 'ENTRADA_INVALIDA',
  ARQUIVO_DIVERGENTE: 'ARQUIVO_DIVERGENTE',
  MANIFESTO_ADULTERADO: 'MANIFESTO_ADULTERADO',
  SELO_DIVERGENTE: 'SELO_DIVERGENTE',
  LEITURA_FALHOU: 'LEITURA_FALHOU',
  PREPARACAO_INVALIDA: 'PACOTE_INVALIDO',
};

const MOTIVOS_DE_AUTENTICACAO = Object.freeze({
  VERSAO_NAO_AUTENTICADA: 'MANIFESTO_NAO_AUTENTICADO',
  AUTENTICACAO_AUSENTE: 'AUTENTICACAO_AUSENTE',
  ALGORITMO_INVALIDO: 'AUTENTICACAO_INVALIDA',
  MAC_INVALIDO: 'AUTENTICACAO_INVALIDA',
  CHAVE_INDISPONIVEL: 'CHAVE_INDISPONIVEL',
  CHAVE_REVOGADA: 'CHAVE_REVOGADA',
});

/**
 * Sem `fonteDeChaves`: leitura LEGADA (manifesto V1, sem autenticação; o resultado diz `autenticacao.autenticado:false`). Com `fonteDeChaves` (produzida por `criarFonteDeChaves`): leitura ESTRITA do manifesto V2 AUTENTICADO — o MAC é
 * verificado antes de qualquer caminho, layout ou hash do manifesto ser confiado, e um pacote V1 é recusado como downgrade (MANIFESTO_NAO_AUTENTICADO). Motivos adicionais: MANIFESTO_NAO_AUTENTICADO, AUTENTICACAO_AUSENTE,
 * AUTENTICACAO_INVALIDA, CHAVE_INDISPONIVEL, CHAVE_REVOGADA.
 */
async function abrirPacote(entrada) {
  if (!ehObjeto(entrada)) throw erroDeParametros();
  const proprias = Reflect.ownKeys(entrada);
  if (!proprias.every((k) => typeof k === 'string' && ['raizAutorizada', 'nome', 'fonteDeChaves', 'exigirRegistro'].includes(k)) || !['raizAutorizada', 'nome'].every((k) => proprias.includes(k))) throw erroDeParametros();
  const estrito = proprias.includes('fonteDeChaves');
  if (estrito && !ehFonteDeChaves(entrada.fonteDeChaves)) throw erroDeParametros();
  // `exigirRegistro` (opcional): a AUSÊNCIA de registro durável da publicação deixa de ser aceita (nunca é prova de publicação válida). Os leitores de produção a ligam.
  if (proprias.includes('exigirRegistro') && typeof entrada.exigirRegistro !== 'boolean') throw erroDeParametros();
  const exigirRegistro = entrada.exigirRegistro === true;
  const { raizAutorizada, nome } = entrada;
  if (!caminhoAbsolutoCanonico(raizAutorizada) || typeof nome !== 'string' || !NOME.test(nome)) return recusa('ORIGEM_NAO_AUTORIZADA');
  if (!(await diretorioReal(raizAutorizada))) return recusa('ORIGEM_NAO_AUTORIZADA');

  const caminho = path.join(raizAutorizada, nome);
  let estado;
  try {
    estado = await fsp.lstat(caminho);
  } catch (falha) {
    return recusa(falha && falha.code === 'ENOENT' ? 'PACOTE_AUSENTE' : 'LEITURA_FALHOU');
  }
  if (estado.isSymbolicLink()) return recusa('LINK_SIMBOLICO');
  if (!estado.isDirectory()) return recusa('PACOTE_INVALIDO');
  let real;
  try { real = fs.realpathSync(caminho); } catch { return recusa('LEITURA_FALHOU'); }
  if (real !== caminho || !dentroDe(real, raizAutorizada)) return recusa('CAMINHO_FORA_DA_ORIGEM');

  // (3) selagem relida do disco pelo componente aprovado; manifesto e selo vêm SÓ dos arquivos persistidos.
  const selagem = await (estrito ? criarSelagem({ leitor: criarLeitorV2({ fonteDeChaves: entrada.fonteDeChaves }) }) : criarSelagem()).verificar({ area: caminho });
  if (selagem.ok !== true) {
    const motivo = estrito && selagem.falha ? MOTIVOS_DE_AUTENTICACAO[selagem.falha.motivo] : undefined;
    if (motivo !== undefined) return recusa(motivo);
    return recusa('SELAGEM_INVALIDA', { codigo: selagem.falha && /^[A-Z_]{3,40}$/.test(selagem.falha.codigo) ? selagem.falha.codigo : 'DESCONHECIDO' });
  }
  const { manifesto, identidade } = selagem;
  // modo estrito: o objeto RECONHECIDO emitido pelo leitor V2 (marcado no módulo do manifesto), nunca uma cópia reconstruída
  const autenticacao = estrito ? selagem.autenticacao : Object.freeze({ versao: 1, autenticado: false });

  // (4) conjunto exato + releitura de cada arquivo (reutiliza a verificação de arquivos persistidos; ela só recebe o que acabou de ser lido do disco).
  const verificacao = await criarServicoDePacote().verificarPacote({ preparacao: caminho, manifesto, identidade });
  if (verificacao.ok !== true) return recusa(mapaDeMotivos[verificacao.motivo] ?? 'PACOTE_INVALIDO');

  // (5) REGISTRO DURÁVEL da publicação (lido do disco, nunca da memória do processo): quarentena, publicação não concluída ou registro inválido recusam o pacote MESMO íntegro. Sem registro algum, só o modo `exigirRegistro` recusa.
  const situacao = await lerSituacao({
    raiz: raizAutorizada,
    identidade: { nome, conjuntoId: manifesto.conjuntoId, sha256Manifesto: identidade.sha256Manifesto, dump: { bytes: manifesto.dump.bytes, sha256: manifesto.dump.sha256 } },
    // No modo de PRODUÇÃO (`exigirRegistro`) a conclusão precisa ser AUTENTICADA (HMAC com a fonte de chaves); fora dele a integridade e a ligação ao pacote bastam.
    ...(estrito && exigirRegistro ? { fonteDeChaves: entrada.fonteDeChaves } : {}),
  });
  if (situacao.estado === ESTADOS_DO_REGISTRO.EM_QUARENTENA) return recusa('PACOTE_EM_QUARENTENA');
  if (situacao.estado === ESTADOS_DO_REGISTRO.PUBLICACAO_NAO_CONCLUIDA) return recusa('PUBLICACAO_NAO_CONCLUIDA');
  if (situacao.estado === ESTADOS_DO_REGISTRO.REGISTRO_INVALIDO) return recusa('REGISTRO_DE_PUBLICACAO_INVALIDO');
  if (situacao.estado === ESTADOS_DO_REGISTRO.SEM_REGISTRO && exigirRegistro) return recusa('PUBLICACAO_SEM_REGISTRO');

  return Object.freeze({
    ok: true,
    origem: 'PACOTE_LIDO_DO_DISCO',
    autenticacao,
    caminho,
    manifesto,
    identidade,
    dump: Object.freeze({ bytes: manifesto.dump.bytes, sha256: manifesto.dump.sha256 }),
    arquivos: verificacao.arquivos,
  });
}

/** Abre o dump do pacote (sem seguir link), confere tamanho e SHA-256 por leitura POSICIONAL (o deslocamento do descritor fica em 0, pronto para ser a entrada padrão) e entrega o descritor. */
async function abrirDump(pacote) {
  const alvo = path.join(pacote.caminho, PASTA_DO_DUMP, ARQUIVO_DO_DUMP);
  let fd = null;
  try {
    fd = fs.openSync(alvo, RDONLY_SEM_LINK);
    const estado = fs.fstatSync(fd, { bigint: true });
    if (!estado.isFile() || Number(estado.size) !== pacote.dump.bytes) throw new Error('divergente');
    const hash = crypto.createHash('sha256');
    const bloco = Buffer.allocUnsafe(Math.min(BLOCO, pacote.dump.bytes));
    let posicao = 0;
    while (posicao < pacote.dump.bytes) {
      const { bytesRead } = await lerNoDescritor(fd, bloco, 0, Math.min(bloco.length, pacote.dump.bytes - posicao), posicao);
      if (bytesRead === 0) throw new Error('truncado');
      hash.update(bloco.subarray(0, bytesRead));
      posicao += bytesRead;
    }
    if (hash.digest('hex') !== pacote.dump.sha256) throw new Error('divergente');
    let aberto = true;
    const descritor = fd;
    return Object.freeze({ ok: true, descritor, bytes: pacote.dump.bytes, sha256: pacote.dump.sha256, fechar() { if (aberto) { aberto = false; try { fs.closeSync(descritor); } catch { /* já fechado */ } } } });
  } catch {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* já fechado */ } }
    return recusa('DUMP_DIVERGENTE');
  }
}

async function destinoDasImagens(imagens, pacote, raizAutorizada) {
  if (!ehObjeto(imagens) || !chavesExatas(imagens, ['raiz', 'nome']) || !caminhoAbsolutoCanonico(imagens.raiz) || typeof imagens.nome !== 'string' || !NOME.test(imagens.nome)) throw erroDeParametros();
  const { raiz, nome } = imagens;
  if (!(await diretorioReal(raiz))) return recusa('DESTINO_NAO_AUTORIZADO');
  try {
    const estado = fs.statSync(raiz);
    if ((estado.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && estado.uid !== process.getuid())) return recusa('DESTINO_NAO_AUTORIZADO');
  } catch {
    return recusa('DESTINO_NAO_AUTORIZADO');
  }
  const destino = path.join(raiz, nome);
  if (dentroDe(destino, raizAutorizada) || dentroDe(raizAutorizada, destino) || dentroDe(destino, pacote.caminho)) return recusa('DESTINO_NAO_ISOLADO');
  try {
    await fsp.lstat(destino);
    return recusa('DESTINO_EXISTENTE');
  } catch (falha) {
    if (!falha || falha.code !== 'ENOENT') return recusa('DESTINO_NAO_AUTORIZADO');
  }
  return Object.freeze({ ok: true, destino });
}

async function hashDoFluxo(fluxo) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const bloco of fluxo) { hash.update(bloco); bytes += bloco.length; }
  return { sha256: hash.digest('hex'), bytes };
}

async function restaurarImagens({ pacote, destino, ops, sinal = null }) {
  // P3 (opcional): `sinal` = pedido de cancelamento COOPERATIVO, conferido só em pontos seguros (antes de cada imagem e de cada releitura). Cancelar nunca apaga: o destino parcial é PRESERVADO e o pacote de origem não é tocado.
  const cancelado = () => sinal !== null && sinal.aborted === true;
  if (cancelado()) return recusa('CANCELADO', { restaurados: 0, destino: 'NAO_CRIADO' });
  try {
    await fsp.mkdir(destino, { mode: 0o700 });
  } catch (falha) {
    return recusa(falha && falha.code === 'EEXIST' ? 'DESTINO_EXISTENTE' : ehFaltaDeEspaco(falha) ? 'ESPACO_ESGOTADO' : 'ESCRITA_FALHOU');
  }
  const armazenamento = criarArmazenamentoImagens({ diretorio: destino });
  const itens = [...pacote.manifesto.arquivos].sort((a, b) => (a.chave < b.chave ? -1 : 1));
  let restaurados = 0;
  for (const item of itens) {
    if (cancelado()) return recusa('CANCELADO', { restaurados, destino: 'PARCIAL_PRESERVADO' });
    let bytes;
    try {
      bytes = await ops.lerImagem(path.join(pacote.caminho, 'imagens', ...item.chave.split('/')), item.bytes);
    } catch {
      return recusa('LEITURA_FALHOU', { restaurados, destino: 'PARCIAL_PRESERVADO' });
    }
    if (!Buffer.isBuffer(bytes) || bytes.length !== item.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
      return recusa('INTEGRIDADE_DIVERGENTE', { restaurados, destino: 'PARCIAL_PRESERVADO' });
    }
    try {
      await ops.gravarImagem(armazenamento, item.chave, bytes, { maxBytes: item.bytes, sha256Esperado: item.sha256 });
    } catch {
      return recusa('ESCRITA_FALHOU', { restaurados, destino: 'PARCIAL_PRESERVADO' });
    }
    restaurados += 1;
  }
  if (cancelado()) return recusa('CANCELADO', { restaurados, destino: 'PARCIAL_PRESERVADO' });
  // Releitura do destino: conjunto exato e SHA-256 de cada arquivo restaurado.
  try {
    const esperadas = new Map(itens.map((i) => [i.chave, i]));
    const prefixos = [...new Set(itens.map((i) => i.chave.split('/')[0]))].sort();
    const encontradas = [];
    for (const prefixo of prefixos) encontradas.push(...(await armazenamento.listar(prefixo)));
    if (encontradas.length !== esperadas.size || !encontradas.every((c) => esperadas.has(c))) return recusa('DESTINO_DIVERGENTE', { restaurados, destino: 'PARCIAL_PRESERVADO' });
    for (const [chave, item] of esperadas) {
      if (cancelado()) return recusa('CANCELADO', { restaurados, destino: 'PARCIAL_PRESERVADO' });
      const lido = await hashDoFluxo(await armazenamento.abrir(chave));
      if (lido.sha256 !== item.sha256 || lido.bytes !== item.bytes) return recusa('DESTINO_DIVERGENTE', { restaurados, destino: 'PARCIAL_PRESERVADO' });
    }
  } catch {
    return recusa('LEITURA_FALHOU', { restaurados, destino: 'PARCIAL_PRESERVADO' });
  }
  return Object.freeze({ ok: true, arquivos: restaurados });
}

/** A restauração NUNCA é apta à operação real aqui: restauração injetada/simulada, sem produtor operacional, e (V1) sem autenticação ou (V2) com chave de teste. */
function aptidaoOperacional(autenticacao) {
  const motivos = ['RESTAURACAO_NAO_REAL', 'SEM_PRODUTOR_OPERACIONAL'];
  if (autenticacao.autenticado !== true) motivos.push('MANIFESTO_NAO_AUTENTICADO');
  if (autenticacao.origemDaChave === 'TESTE_CONTROLADO') motivos.push('CHAVE_DE_TESTE');
  return Object.freeze({ apta: false, motivos: Object.freeze(motivos) });
}
function limitesAutenticados(autenticacao) {
  const limites = ['SEM_RESTAURACAO_OPERACIONAL_REAL', 'SEM_CONSISTENCIA_LOGICA_BANCO_IMAGENS', 'SEM_FONTE_OPERACIONAL_DE_CHAVES'];
  if (autenticacao.origemDaChave === 'TESTE_CONTROLADO') limites.push('CHAVE_DE_TESTE_NAO_OPERACIONAL');
  return Object.freeze(limites);
}

/**
 * CONSISTÊNCIA LÓGICA (contrato mínimo): depois de restaurar o banco, a consulta INJETADA lê as referências do BANCO RESTAURADO e devolve exatamente `{ ok:true, completa:true, banco, conjuntoId, sha256Manifesto, registros:{ padrao, empresa } }`
 * (as MESMAS linhas que o snapshot do backup lê de `imagens_padrao` e `imagens_empresa`; as chaves vêm de `planejarArquivos`, a única fonte do mapeamento). Contra o manifesto: toda referência precisa ter imagem com o MESMO SHA-256 e toda imagem
 * precisa ser referenciada. A resposta precisa pertencer a ESTA operação (banco destino, conjunto e manifesto). `contratual:true` só diz que o contrato foi satisfeito sobre os dados DEVOLVIDOS pela consulta; `verificada` é sempre false,
 * porque com executor injetado nenhuma consulta efetiva a um banco restaurado de verdade é demonstrada. Esta camada não conhece tabelas além das que o plano do backup já consome.
 */
async function conferirConsistenciaLogica({ consulta, pacote, banco, execucaoId }) {
  const falhou = (motivo) => Object.freeze({ verificada: false, contratual: false, motivo });
  let resposta;
  try { resposta = await consulta.consultar({ banco, conjuntoId: pacote.manifesto.conjuntoId, sha256Manifesto: pacote.identidade.sha256Manifesto, ...(execucaoId === null ? {} : { execucaoId }) }); } catch { return falhou('CONSULTA_DE_REFERENCIAS_FALHOU'); }
  if (!ehObjeto(resposta) || resposta.ok !== true) return falhou('CONSULTA_DE_REFERENCIAS_FALHOU');
  if (resposta.completa !== true) return falhou('CONSULTA_DE_REFERENCIAS_INCOMPLETA');
  if (resposta.banco !== banco || resposta.conjuntoId !== pacote.manifesto.conjuntoId || resposta.sha256Manifesto !== pacote.identidade.sha256Manifesto || (resposta.execucaoId ?? null) !== execucaoId) return falhou('CONSULTA_DE_OUTRA_OPERACAO');
  let plano;
  try {
    if (!ehObjeto(resposta.registros)) throw new Error('registros');
    plano = planejarArquivos({ padrao: resposta.registros.padrao, empresa: resposta.registros.empresa });
  } catch {
    return falhou('CONSULTA_DE_REFERENCIAS_INVALIDA');
  }
  const imagens = new Map(pacote.manifesto.arquivos.map((a) => [a.chave, a.sha256]));
  const referenciadas = new Set();
  for (const ref of plano) {
    if (!imagens.has(ref.chave)) return falhou('REFERENCIA_SEM_IMAGEM');
    if (imagens.get(ref.chave) !== ref.sha256) return falhou('IMAGEM_DIVERGENTE_DA_REFERENCIA');
    referenciadas.add(ref.chave);
  }
  for (const chave of imagens.keys()) if (!referenciadas.has(chave)) return falhou('IMAGEM_SEM_REFERENCIA');
  return Object.freeze({ verificada: false, contratual: true, referencias: plano.length, motivo: 'CONTRATO_SATISFEITO_COM_CONSULTA_INJETADA' });
}

const resultadosDeRestauracao = new WeakSet();
const ehResultadoDeRestauracao = (v) => v !== null && typeof v === 'object' && resultadosDeRestauracao.has(v);

function criarRestaurador(opcoes = {}) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => typeof k === 'string' && ['ops', 'restauradorDoBanco', 'fonteDeChaves', 'consultaDeReferencias', 'execucaoId', 'controle', 'exigirRegistroDePublicacao'].includes(k))) throw erroDeParametros();
  if (opcoes.exigirRegistroDePublicacao !== undefined && typeof opcoes.exigirRegistroDePublicacao !== 'boolean') throw erroDeParametros();
  const exigirRegistro = opcoes.exigirRegistroDePublicacao === true;
  // P3 (opcional, DESLIGADO por omissão): `controle` = { registro, imagensMs?, consultaMs? } (registro da fábrica; prazos inteiros positivos que exigem registro com temporizador). As duas etapas listadas passam a ser operações RASTREADAS: prazo só PEDE cancelamento, nunca é conclusão; sem assentamento a etapa é
  // CANCELAMENTO_NAO_CONFIRMADO (falha fechada, operação segue pendente, resultado tardio é observado) e o restante da restauração NÃO começa. O `pg_restore` supervisionado não passa por aqui.
  let controle = null;
  if (opcoes.controle !== undefined) {
    const c = opcoes.controle;
    if (!ehObjeto(c) || !Reflect.ownKeys(c).every((k) => k === 'registro' || k === 'imagensMs' || k === 'consultaMs') || !ehRegistroDeOperacoes(c.registro)) throw erroDeParametros();
    for (const k of ['imagensMs', 'consultaMs']) if (Object.hasOwn(c, k) && !(Number.isSafeInteger(c[k]) && c[k] > 0 && c.registro.temTemporizador === true)) throw erroDeParametros();
    controle = Object.freeze({ registro: c.registro, ...(Object.hasOwn(c, 'imagensMs') ? { imagensMs: c.imagensMs } : {}), ...(Object.hasOwn(c, 'consultaMs') ? { consultaMs: c.consultaMs } : {}) });
  }
  // identidade da EXECUÇÃO (opcional; gerada pela composição, nunca pelo chamador final): ecoada no resultado e passada à consulta de referências
  const execucaoId = opcoes.execucaoId === undefined ? null : opcoes.execucaoId;
  if (execucaoId !== null && !(typeof execucaoId === 'string' && /^[0-9a-f]{32}$/.test(execucaoId))) throw erroDeParametros();
  const ops = completarOps(opcoes.ops);
  const restauradorDoBanco = opcoes.restauradorDoBanco;
  if (restauradorDoBanco !== undefined && !(ehObjeto(restauradorDoBanco) && ehFuncao(restauradorDoBanco.restaurar) && ehFuncao(restauradorDoBanco.autorizarDestino))) throw erroDeParametros();
  const fonteDeChaves = opcoes.fonteDeChaves;
  if (fonteDeChaves !== undefined && !ehFonteDeChaves(fonteDeChaves)) throw erroDeParametros();
  const consultaDeReferencias = opcoes.consultaDeReferencias;
  if (consultaDeReferencias !== undefined && !(ehObjeto(consultaDeReferencias) && ehFuncao(consultaDeReferencias.consultar))) throw erroDeParametros();
  const abrir = (raizAutorizada, nome) => abrirPacote({ raizAutorizada, nome, ...(fonteDeChaves === undefined ? {} : { fonteDeChaves }), ...(exigirRegistro ? { exigirRegistro: true } : {}) });

  async function restaurarPacote(entrada) {
    if (!ehObjeto(entrada)) throw erroDeParametros();
    const proprias = Reflect.ownKeys(entrada);
    if (!proprias.every((k) => typeof k === 'string' && ['raizAutorizada', 'nome', 'imagens', 'banco'].includes(k)) || !['raizAutorizada', 'nome', 'imagens'].every((k) => proprias.includes(k))) throw erroDeParametros();
    const { raizAutorizada, nome, imagens } = entrada;
    const pedeBanco = proprias.includes('banco');
    if (pedeBanco && (restauradorDoBanco === undefined || !ehObjeto(entrada.banco) || !chavesExatas(entrada.banco, ['destino']))) throw erroDeParametros();
    if (!caminhoAbsolutoCanonico(raizAutorizada) || typeof nome !== 'string' || !NOME.test(nome)) throw erroDeParametros();

    const etapas = { pacote: null, imagens: null, banco: null, dump: null };
    let autenticacao = Object.freeze({ versao: null, autenticado: false });
    let consistenciaLogica = Object.freeze({ verificada: false, motivo: 'NAO_VERIFICADA' });
    const final = (ok, motivo) => {
      const r = Object.freeze({
        ok,
        ...(ok ? {} : { motivo }),
        execucaoId,
        etapas: Object.freeze({ ...etapas }),
        restauracaoReal: false,
        recuperavel: false,
        autenticacao,
        aptidaoOperacional: aptidaoOperacional(autenticacao),
        consistenciaLogica,
        limites: autenticacao.autenticado ? limitesAutenticados(autenticacao) : LIMITES,
      });
      resultadosDeRestauracao.add(r); // só este fluxo produz o resultado reconhecido (a proveniência da restauração real parte dele)
      return r;
    };

    const pacote = await abrir(raizAutorizada, nome);
    if (pacote.ok !== true) { etapas.pacote = pacote; return final(false, pacote.motivo); }
    autenticacao = pacote.autenticacao;
    etapas.pacote = Object.freeze({ ok: true, arquivos: pacote.arquivos, conjuntoId: pacote.manifesto.conjuntoId, sha256Manifesto: pacote.identidade.sha256Manifesto });

    // A política de destino do BANCO vale antes de qualquer restauração: um destino não autorizado (por exemplo, um banco de produção) não deixa nada para trás.
    if (pedeBanco && restauradorDoBanco.autorizarDestino(entrada.banco.destino) !== true) { etapas.banco = recusa('DESTINO_NAO_AUTORIZADO'); return final(false, 'DESTINO_NAO_AUTORIZADO'); }

    const destino = await destinoDasImagens(imagens, pacote, raizAutorizada);
    if (destino.ok !== true) { etapas.imagens = destino; return final(false, destino.motivo); }

    let restauradas;
    if (controle === null) {
      restauradas = await restaurarImagens({ pacote, destino: destino.destino, ops });
    } else {
      const e = await controle.registro.executar({ etapa: 'restauracao_imagens', recursos: ['ARMAZENAMENTO', 'ARQUIVO_PARCIAL', 'DESCRITOR'] }, (sinal) => restaurarImagens({ pacote, destino: destino.destino, ops, sinal }), controle.imagensMs === undefined ? {} : { limiteMs: controle.imagensMs });
      // prazo excedido nunca é sucesso, mesmo que a operação tenha concluído depois do pedido de cancelamento
      if (e.estado !== 'ASSENTADA') restauradas = recusa('CANCELAMENTO_NAO_CONFIRMADO', { destino: 'PARCIAL_PRESERVADO' });
      else if (e.desfecho !== 'RESOLVIDA') restauradas = recusa('ESCRITA_FALHOU', { destino: 'PARCIAL_PRESERVADO' });
      else if (e.expirou) restauradas = recusa('PRAZO_EXCEDIDO', { destino: 'PARCIAL_PRESERVADO' });
      else restauradas = e.valor;
    }
    etapas.imagens = restauradas;
    if (restauradas.ok !== true) return final(false, restauradas.motivo);

    if (pedeBanco) {
      const dump = await abrirDump(pacote);
      if (dump.ok !== true) { etapas.banco = dump; return final(false, dump.motivo); }
      etapas.dump = Object.freeze({ conferido: true, bytes: dump.bytes, sha256: dump.sha256 }); // integridade física do arquivo conferida imediatamente antes da restauração
      try {
        etapas.banco = await restauradorDoBanco.restaurar({ destino: entrada.banco.destino, dump });
      } catch {
        etapas.banco = recusa('RESTAURADOR_FALHOU');
      } finally {
        dump.fechar();
      }
      if (etapas.banco.ok !== true) return final(false, etapas.banco.motivo);
      if (consultaDeReferencias !== undefined) {
        const conferir = () => conferirConsistenciaLogica({ consulta: consultaDeReferencias, pacote, banco: entrada.banco.destino.banco, execucaoId });
        if (controle === null) {
          consistenciaLogica = await conferir();
        } else {
          // A consulta não tem cancelamento cooperativo (o adaptador de consistência é intocado): o pedido só limita a ESPERA; uma conexão que não assenta continua rastreada como pendente e NUNCA é dada como encerrada.
          const e = await controle.registro.executar({ etapa: 'conferencia_logica', recursos: ['CONEXAO'] }, () => conferir(), controle.consultaMs === undefined ? {} : { limiteMs: controle.consultaMs });
          const falhou = (motivo) => Object.freeze({ verificada: false, contratual: false, motivo });
          if (e.estado !== 'ASSENTADA') consistenciaLogica = falhou('CANCELAMENTO_NAO_CONFIRMADO');
          else if (e.desfecho !== 'RESOLVIDA') consistenciaLogica = falhou('CONSULTA_DE_REFERENCIAS_FALHOU');
          else if (e.expirou) consistenciaLogica = falhou('PRAZO_EXCEDIDO');
          else consistenciaLogica = e.valor;
        }
        if (consistenciaLogica.contratual !== true) return final(false, consistenciaLogica.motivo);
      }
    }

    // O pacote de origem precisa estar igual ao final: restaurar não o altera, e ninguém o alterou durante a restauração.
    const depois = await abrir(raizAutorizada, nome);
    if (depois.ok !== true || depois.identidade.sha256Manifesto !== pacote.identidade.sha256Manifesto || depois.dump.sha256 !== pacote.dump.sha256) return final(false, 'PACOTE_ALTERADO_DURANTE_A_RESTAURACAO');
    return final(true);
  }

  return Object.freeze({ restaurarPacote });
}

module.exports = { abrirPacote, criarRestaurador, ehResultadoDeRestauracao };
