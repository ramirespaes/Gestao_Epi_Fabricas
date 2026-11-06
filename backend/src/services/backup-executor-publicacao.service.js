'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { cifrarPacote } = require('./backup-fontes-cifra-envelope.service');
const { consolidarRecibos, LIMITE_OBJETO_BYTES } = require('./backup-recibo-duravel.service');
const { verificarNomeLivre, ehDestinoValidado } = require('./imagem-backup-destinos.service');

/**
 * D-ORF-6, EXECUTOR OPERACIONAL: ESTÁGIO DE PUBLICAÇÃO DURÁVEL. Recebe um pacote L2 local já produzido (a produção do pacote é de outra etapa) e executa, em ordem e com falha
 * fechada: DESTINO_LOCAL (pasta nova dentro de uma raiz AUTORIZADA) -> CIFRA (cifra em envelope; a verificação do pacote vem antes de qualquer cifragem) -> INVENTARIO (só arquivos
 * regulares, com limites; envelope por último) -> PRE_VOO (obrigatório) -> ENVIO (uma gravação por arquivo, sem repetição) -> CONSOLIDACAO (recibos completos) -> CONFIRMACAO ->
 * VERIFICACAO independente (opcional: o host do backup não tem a credencial do verificador; sem ela a verificação fica PENDENTE).
 * Nada é apagado ou repetido: o que for ambíguo vira INCERTO, o contêiner local e o que já estiver no bucket permanecem. Sem escrita própria (a cifra é a escrita aprovada da entrada 47).
 * Erros de programação (entrada fora do contrato) lançam ENTRADA_INVALIDA; falhas de execução voltam como resultado com SÓ códigos fixos (sem mensagens de erro).
 */

const BLOCO = 256 * 1024;
const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONJUNTO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FIXO = /^[A-Z][A-Z0-9_]{2,59}$/;
const OBRIGATORIAS = Object.freeze(['pacote', 'conjuntoId', 'validadorDeDestinos', 'destinoLocalId', 'raiz', 'nomeContainer', 'cifra', 'mac', 'enviador', 'limites', 'prazoMs']);
const OPCIONAIS = Object.freeze(['verificador', 'marcar']);
const LIMITES_RECUSADOS = new Set(['LIMITE_DE_ARQUIVOS_EXCEDIDO', 'LIMITE_TOTAL_EXCEDIDO']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const entradaInvalida = () => Object.assign(new TypeError('entrada do estágio de publicação inválida'), { code: 'ENTRADA_INVALIDA' });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/');
const fixo = (v) => (typeof v === 'string' && FIXO.test(v) ? v : 'INDETERMINADO');
const inteiroEntre = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const comFuncoes = (o, nomes) => ehObjeto(o) && nomes.every((n) => typeof o[n] === 'function');

function validarEntrada(e) {
  if (!ehObjeto(e)) throw entradaInvalida();
  const proprias = Reflect.ownKeys(e);
  if (!proprias.every((k) => OBRIGATORIAS.includes(k) || OPCIONAIS.includes(k)) || !OBRIGATORIAS.every((k) => proprias.includes(k))) throw entradaInvalida();
  const { pacote, conjuntoId, validadorDeDestinos, destinoLocalId, raiz, nomeContainer, cifra, mac, enviador, verificador, limites, prazoMs, marcar } = e;
  if (!ehObjeto(pacote) || Reflect.ownKeys(pacote).length !== 2 || !caminhoCanonico(pacote.dir) || !ehObjeto(pacote.lido)) throw entradaInvalida();
  if (typeof conjuntoId !== 'string' || !CONJUNTO.test(conjuntoId) || typeof nomeContainer !== 'string' || !NOME.test(nomeContainer) || typeof destinoLocalId !== 'string' || !caminhoCanonico(raiz)) throw entradaInvalida();
  if (!comFuncoes(validadorDeDestinos, ['validar']) || !ehObjeto(cifra) || !ehObjeto(mac)) throw entradaInvalida();
  if (!comFuncoes(enviador, ['executarPreVoo', 'enviarArquivo', 'recibos', 'criarDestino']) || !ehObjeto(enviador.destino) || typeof enviador.destino.id !== 'string' || typeof enviador.destino.ambiente !== 'string') throw entradaInvalida();
  if (verificador !== undefined && !comFuncoes(verificador, ['verificar'])) throw entradaInvalida();
  if (marcar !== undefined && typeof marcar !== 'function') throw entradaInvalida();
  if (!ehObjeto(limites) || Reflect.ownKeys(limites).length !== 2 || !inteiroEntre(limites.arquivosMaximo, 1, 400000) || !inteiroEntre(limites.totalBytesMaximo, 1, Number.MAX_SAFE_INTEGER)) throw entradaInvalida();
  if (!inteiroEntre(prazoMs, 1, 600000)) throw entradaInvalida();
}

async function resumir(caminho, bytes) {
  const fh = await fsp.open(caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size !== bytes) throw new Error('arquivo mudou');
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(BLOCO);
    let posicao = 0;
    while (posicao < bytes) {
      const { bytesRead } = await fh.read(buffer, 0, Math.min(BLOCO, bytes - posicao), posicao);
      if (bytesRead === 0) throw new Error('leitura curta');
      hash.update(buffer.subarray(0, bytesRead));
      posicao += bytesRead;
    }
    return hash.digest('hex');
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Lista os arquivos do contêiner (só regulares, sem seguir link), confere os limites e calcula o SHA-256 de cada um. `dados/...` em ordem estável e `envelope.json` por ÚLTIMO. */
async function inventariarContainer(dir, limites) {
  const recusa = (codigo) => Object.freeze({ ok: false, codigo });
  try {
    const st = await fsp.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return recusa('CONTAINER_INVALIDO');
  } catch { return recusa('CONTAINER_INVALIDO'); }
  const achados = [];
  async function andar(abs, rel) {
    for (const nome of (await fsp.readdir(abs)).sort()) {
      const filho = path.join(abs, nome);
      const relFilho = rel === '' ? nome : `${rel}/${nome}`;
      const st = await fsp.lstat(filho);
      if (st.isSymbolicLink()) return 'CONTAINER_INVALIDO';
      if (st.isDirectory()) { const erro = await andar(filho, relFilho); if (erro !== null) return erro; continue; }
      if (!st.isFile()) return 'CONTAINER_INVALIDO';
      if (st.size > LIMITE_OBJETO_BYTES) return 'ARQUIVO_ACIMA_DO_LIMITE';
      achados.push({ rel: relFilho, caminho: filho, bytes: st.size });
      if (achados.length > limites.arquivosMaximo) return 'LIMITE_DE_ARQUIVOS_EXCEDIDO';
    }
    return null;
  }
  let erro;
  try { erro = await andar(dir, ''); } catch { return recusa('CONTAINER_INVALIDO'); }
  if (erro !== null) return recusa(erro);
  const totalBytes = achados.reduce((s, a) => s + a.bytes, 0);
  if (totalBytes > limites.totalBytesMaximo) return recusa('LIMITE_TOTAL_EXCEDIDO');
  if (!achados.some((a) => a.rel === 'envelope.json')) return recusa('ENVELOPE_AUSENTE');
  achados.sort((a, b) => (a.rel === 'envelope.json') - (b.rel === 'envelope.json') || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  try {
    const arquivos = [];
    for (const a of achados) arquivos.push(Object.freeze({ ...a, sha256: await resumir(a.caminho, a.bytes) }));
    return Object.freeze({ ok: true, arquivos: Object.freeze(arquivos), totalBytes });
  } catch { return recusa('CONTAINER_INVALIDO'); }
}

async function publicarPacoteDuravel(entrada) {
  validarEntrada(entrada);
  const { pacote, conjuntoId, validadorDeDestinos, destinoLocalId, raiz, nomeContainer, cifra, mac, enviador, verificador, limites, prazoMs } = entrada;
  const observar = entrada.marcar === undefined ? () => {} : entrada.marcar;
  const etapas = [];
  const acumulado = { container: null, consolidado: null, sha256Consolidado: null, verificacao: 'PENDENTE', confirmacoes: 0 };
  const origemDoDestino = enviador.destino.origem === 'OPERACIONAL' ? 'OPERACIONAL' : 'TESTE_CONTROLADO';
  const registrar = (id, ok, codigo = null) => {
    etapas.push(Object.freeze({ id, ok, codigo }));
    try { observar(id, ok, codigo); } catch { /* o observador não decide o resultado */ }
  };
  const recibosEmitidos = () => { try { return enviador.recibos().length; } catch { return 0; } };
  const resultado = (ok, estado, falha) => Object.freeze({
    ok, estado, etapas: Object.freeze([...etapas]), falha, container: acumulado.container, recibos: recibosEmitidos(), consolidado: acumulado.consolidado, sha256Consolidado: acumulado.sha256Consolidado,
    verificacao: acumulado.verificacao, origemDoDestino, confirmacoes: acumulado.confirmacoes,
  });
  const falhar = (estado, etapa, codigo, extras = {}) => {
    registrar(etapa, false, codigo);
    return resultado(false, estado, Object.freeze({ etapa, codigo, ...extras }));
  };
  let passo = 'DESTINO_LOCAL';
  try {
    let validacao;
    try { validacao = validadorDeDestinos.validar({ destinoId: destinoLocalId, raiz }); } catch { validacao = null; }
    if (!ehDestinoValidado(validacao) || validacao.autorizado !== true) return falhar('RECUSADO', 'DESTINO_LOCAL', 'DESTINO_LOCAL_NAO_AUTORIZADO', { detalhe: fixo(validacao === null ? undefined : validacao.motivo) });
    const livre = verificarNomeLivre(validacao, nomeContainer);
    if (livre.livre !== true) return falhar('RECUSADO', 'DESTINO_LOCAL', 'DESTINO_LOCAL_OCUPADO', { detalhe: fixo(livre.motivo) });
    const containerDir = path.join(validacao.raiz, nomeContainer);
    registrar('DESTINO_LOCAL', true);

    passo = 'CIFRA';
    const cifrado = await cifrarPacote({ pacote: pacote.dir, lido: pacote.lido, destino: containerDir, cifra, mac });
    if (!ehObjeto(cifrado) || cifrado.ok !== true) return falhar('FALHOU', 'CIFRA', 'CIFRA_FALHOU', { componente: Object.freeze({ passo: fixo(cifrado?.falha?.passo), codigo: fixo(cifrado?.falha?.codigo) }) });
    registrar('CIFRA', true);

    passo = 'INVENTARIO';
    const inventario = await inventariarContainer(containerDir, limites);
    if (!inventario.ok) return falhar(LIMITES_RECUSADOS.has(inventario.codigo) ? 'RECUSADO' : 'FALHOU', 'INVENTARIO', inventario.codigo);
    acumulado.container = Object.freeze({ arquivos: inventario.arquivos.length, bytes: inventario.totalBytes });
    registrar('INVENTARIO', true);

    passo = 'PRE_VOO';
    const preVoo = await enviador.executarPreVoo();
    if (!ehObjeto(preVoo) || preVoo.ok !== true) {
      const itens = ehObjeto(preVoo) && Array.isArray(preVoo.itens) ? preVoo.itens.filter((i) => ehObjeto(i) && i.ok !== true).map((i) => fixo(i.id)) : [];
      return falhar('RECUSADO', 'PRE_VOO', 'PRE_VOO_REPROVADO', { itensReprovados: Object.freeze(itens) });
    }
    registrar('PRE_VOO', true);

    passo = 'ENVIO';
    for (const arquivo of inventario.arquivos) {
      const envio = await enviador.enviarArquivo({ caminho: arquivo.caminho, chave: `${conjuntoId}/${arquivo.rel}`, sha256: arquivo.sha256, bytes: arquivo.bytes });
      if (!ehObjeto(envio) || envio.estado !== 'GRAVADO') {
        const estado = ehObjeto(envio) && (envio.estado === 'RECUSADO' || envio.estado === 'INCERTO') ? envio.estado : 'FALHOU';
        return falhar(estado, 'ENVIO', `ENVIO_${estado === 'FALHOU' ? 'FALHOU' : estado}`, { detalhe: fixo(ehObjeto(envio) ? envio.motivo : undefined) });
      }
    }
    registrar('ENVIO', true);

    passo = 'CONSOLIDACAO';
    const consolidacao = consolidarRecibos({ destinoId: enviador.destino.id, ambiente: enviador.destino.ambiente, conjuntoId, recibos: [...enviador.recibos()] });
    if (!ehObjeto(consolidacao) || consolidacao.ok !== true) return falhar('FALHOU', 'CONSOLIDACAO', 'CONSOLIDACAO_FALHOU', { detalhe: fixo(ehObjeto(consolidacao) ? consolidacao.motivo : undefined) });
    if (consolidacao.consolidado.recibos.length !== inventario.arquivos.length) return falhar('FALHOU', 'CONSOLIDACAO', 'CONSOLIDACAO_FALHOU', { detalhe: 'RECIBOS_INCOMPLETOS' });
    acumulado.consolidado = consolidacao.consolidado;
    acumulado.sha256Consolidado = consolidacao.sha256;
    registrar('CONSOLIDACAO', true);

    passo = 'CONFIRMACAO';
    const destino = enviador.criarDestino({ prazoMs });
    for (const recibo of consolidacao.consolidado.recibos) {
      const confirmacao = await destino.confirmarGravacao({ chave: recibo.chave, sha256: recibo.sha256, bytes: recibo.bytes });
      if (!ehObjeto(confirmacao) || confirmacao.confirmado !== true) return falhar('FALHOU', 'CONFIRMACAO', 'CONFIRMACAO_FALHOU');
      acumulado.confirmacoes += 1;
    }
    registrar('CONFIRMACAO', true);

    if (verificador !== undefined) {
      passo = 'VERIFICACAO';
      const verificacao = await verificador.verificar(consolidacao.consolidado);
      if (!ehObjeto(verificacao) || verificacao.conforme !== true) { acumulado.verificacao = 'DIVERGENTE'; return falhar('FALHOU', 'VERIFICACAO', 'VERIFICACAO_DIVERGENTE'); }
      acumulado.verificacao = 'CONFORME';
      registrar('VERIFICACAO', true);
    }
    return resultado(true, 'CONCLUIDO', null);
  } catch {
    return falhar('FALHOU', passo, 'ERRO_INESPERADO');
  }
}

module.exports = { publicarPacoteDuravel, inventariarContainer };
