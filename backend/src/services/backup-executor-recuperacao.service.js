'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { restaurarContainerDoDestinoDuravel } = require('./backup-restauracao-duravel.service');
const { verificarPacoteL2 } = require('./backup-fontes-composicao-l2.service');
const { criarLeitorL2 } = require('./backup-fontes-manifesto-l2.service');
const { planejarEnsaioDeDR, avaliarEnsaioDeDR } = require('./backup-fontes-dr.service');
const { ehDestinoValidado } = require('./imagem-backup-destinos.service');
const { ambienteDeTeste } = require('./imagem-backup-durabilidade.service');

/**
 * D-ORF-6, EXECUTOR OPERACIONAL: ESTÁGIO DE RECUPERAÇÃO. A partir do consolidado de recibos: DESTINO_LOCAL (raiz AUTORIZADA, destinos novos) -> RESTAURAR_CONTAINER (o orquestrador
 * existente: baixa por versão explícita, confere o MAC antes de confiar e decifra para pasta nova; B1: este é o único caminho) -> VERIFICAR_PACOTE (manifesto L2 autenticado e conjunto
 * exato) -> RESTAURAR_FONTES (porta do restaurador do banco NOVO e das fontes, com a conciliação P7; a ligação real depende de PostgreSQL e é da homologação) -> AVALIAR_DR.
 * Produção continua proibida (destinos sempre novos) e o resultado NUNCA promove `recuperavelEmProducao`. Sem alvos de RPO/RTO (decisão pendente) o ensaio de DR fica NAO_AVALIADO
 * e a pendência é registrada; com alvos, só RECUPERADO conta como sucesso. Sem escrita própria. Nada é apagado: pastas parciais ficam para análise humana.
 * Erros de programação lançam ENTRADA_INVALIDA; falhas de execução voltam como resultado com SÓ códigos fixos.
 */

const NOME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FIXO = /^[A-Z][A-Z0-9_]{2,59}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MANIFESTO_MAXIMO = 64 * 1024 * 1024;
const OBRIGATORIAS = Object.freeze(['baixador', 'validadorDeDestinos', 'consolidado', 'destinoLocalId', 'raiz', 'nomeContainer', 'nomeDecifrado', 'cifra', 'mac', 'restaurador', 'relogio']);
const OPCIONAIS = Object.freeze(['alvos', 'ultimoBackupEm', 'marcar', 'verificarPacote']);
const RECUSAS_DO_CONTAINER = new Set(['ENTRADA_INVALIDA', 'CONSOLIDADO_INVALIDO', 'DESTINO_DIVERGENTE', 'LIMITE_TOTAL_EXCEDIDO', 'LIMITE_DE_ARQUIVOS_EXCEDIDO', 'DESTINO_NAO_AUTORIZADO', 'DESTINO_PROTEGIDO',
  'DESTINO_EXISTENTE', 'DESTINO_INVALIDO', 'ESPACO_INSUFICIENTE', 'INODES_INSUFICIENTES', 'ESPACO_INDETERMINADO', 'IDENTIDADE_DIVERGENTE']);
const CODIGO_DA_CLASSE = Object.freeze({ RECUPERADO_FORA_DO_ALVO: 'DR_FORA_DO_ALVO', PARCIAL: 'DR_PARCIAL', FALHOU: 'DR_FALHOU' });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const entradaInvalida = () => Object.assign(new TypeError('entrada do estágio de recuperação inválida'), { code: 'ENTRADA_INVALIDA' });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/');
const fixo = (v) => (typeof v === 'string' && FIXO.test(v) ? v : 'INDETERMINADO');
const comFuncoes = (o, nomes) => ehObjeto(o) && nomes.every((n) => typeof o[n] === 'function');
const iso = (ms) => new Date(ms).toISOString();

function validarEntrada(e) {
  if (!ehObjeto(e)) throw entradaInvalida();
  const proprias = Reflect.ownKeys(e);
  if (!proprias.every((k) => OBRIGATORIAS.includes(k) || OPCIONAIS.includes(k)) || !OBRIGATORIAS.every((k) => proprias.includes(k))) throw entradaInvalida();
  const { baixador, validadorDeDestinos, consolidado, destinoLocalId, raiz, nomeContainer, nomeDecifrado, cifra, mac, restaurador, relogio, alvos, ultimoBackupEm, marcar, verificarPacote } = e;
  if (!comFuncoes(baixador, ['baixar', 'autorizarNovoDestino']) || !comFuncoes(validadorDeDestinos, ['validar']) || !ehObjeto(consolidado) || !comFuncoes(restaurador, ['restaurar']) || typeof relogio !== 'function') throw entradaInvalida();
  if (typeof destinoLocalId !== 'string' || !caminhoCanonico(raiz) || typeof nomeContainer !== 'string' || !NOME.test(nomeContainer) || typeof nomeDecifrado !== 'string' || !NOME.test(nomeDecifrado) || nomeContainer === nomeDecifrado) throw entradaInvalida();
  if (!ehObjeto(cifra) || !ehObjeto(mac) || !ehObjeto(mac.fonte) || typeof mac.chaveId !== 'string') throw entradaInvalida();
  if ((alvos === undefined) !== (ultimoBackupEm === undefined)) throw entradaInvalida();
  if (alvos !== undefined) {
    if (!ehObjeto(alvos) || Reflect.ownKeys(alvos).length !== 2 || !Number.isSafeInteger(alvos.rpoMs) || alvos.rpoMs <= 0 || !Number.isSafeInteger(alvos.rtoMs) || alvos.rtoMs <= 0) throw entradaInvalida();
    if (typeof ultimoBackupEm !== 'string' || !ISO.test(ultimoBackupEm)) throw entradaInvalida();
  }
  if (marcar !== undefined && typeof marcar !== 'function') throw entradaInvalida();
  if (verificarPacote !== undefined && (typeof verificarPacote !== 'function' || !ambienteDeTeste())) throw entradaInvalida();
}

async function lerManifesto(pacoteDir) {
  const fh = await fsp.open(path.join(pacoteDir, 'manifesto.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size < 1 || st.size > MANIFESTO_MAXIMO) throw new Error('manifesto fora dos limites');
    const bytes = Buffer.alloc(st.size);
    let lidos = 0;
    while (lidos < st.size) {
      const { bytesRead } = await fh.read(bytes, lidos, st.size - lidos, lidos);
      if (bytesRead === 0) throw new Error('leitura curta');
      lidos += bytesRead;
    }
    return bytes;
  } finally {
    await fh.close().catch(() => {});
  }
}

async function restaurarDoDestinoDuravel(entrada) {
  validarEntrada(entrada);
  const { baixador, validadorDeDestinos, consolidado, destinoLocalId, raiz, nomeContainer, nomeDecifrado, cifra, mac, restaurador, relogio, alvos, ultimoBackupEm } = entrada;
  const observar = entrada.marcar === undefined ? () => {} : entrada.marcar;
  const verificarPacote = entrada.verificarPacote === undefined ? verificarPacoteL2 : entrada.verificarPacote;
  const agora = () => { const t = relogio(); if (!Number.isSafeInteger(t) || t < 0) throw new Error('relógio inválido'); return t; };
  const etapas = [];
  const acumulado = { restauracao: null, dr: null, pendencias: [] };
  const registrar = (id, ok, codigo = null) => {
    etapas.push(Object.freeze({ id, ok, codigo }));
    try { observar(id, ok, codigo); } catch { /* o observador não decide o resultado */ }
  };
  const resultado = (ok, estado, falha) => Object.freeze({
    ok, estado, etapas: Object.freeze([...etapas]), falha, restauracao: acumulado.restauracao, dr: acumulado.dr, comprovacoesPendentes: Object.freeze([...acumulado.pendencias]), recuperavelEmProducao: false,
  });
  const falhar = (estado, etapa, codigo, extras = {}) => {
    registrar(etapa, false, codigo);
    return resultado(false, estado, Object.freeze({ etapa, codigo, ...extras }));
  };

  let passo = 'DESTINO_LOCAL';
  try {
    const tInicio = agora();
    let validacao;
    try { validacao = validadorDeDestinos.validar({ destinoId: destinoLocalId, raiz }); } catch { validacao = null; }
    if (!ehDestinoValidado(validacao) || validacao.autorizado !== true) return falhar('RECUSADO', 'DESTINO_LOCAL', 'DESTINO_LOCAL_NAO_AUTORIZADO', { detalhe: fixo(validacao === null ? undefined : validacao.motivo) });
    registrar('DESTINO_LOCAL', true);

    passo = 'RESTAURAR_CONTAINER';
    const t0 = agora();
    const recuperado = await restaurarContainerDoDestinoDuravel({ baixador, validadorDeDestinos, consolidado, destinoLocalId, raiz, nomeContainer, nomeDecifrado, cifra, mac });
    const t1 = agora();
    if (!ehObjeto(recuperado) || recuperado.ok !== true) {
      const falha = ehObjeto(recuperado) && ehObjeto(recuperado.falha) ? recuperado.falha : {};
      const componente = Object.freeze({ passo: fixo(falha.passo), codigo: fixo(falha.codigo) });
      const recusa = RECUSAS_DO_CONTAINER.has(falha.codigo) || falha.passo === 'ENTRADA' || falha.passo === 'DESTINO';
      return falhar(recusa ? 'RECUSADO' : 'FALHOU', 'RESTAURAR_CONTAINER', recusa ? 'RESTAURAR_CONTAINER_RECUSADO' : 'RESTAURAR_CONTAINER_FALHOU', { componente });
    }
    acumulado.restauracao = Object.freeze({ arquivosBaixados: recuperado.baixados.arquivos, bytesBaixados: recuperado.baixados.bytes, arquivosDecifrados: recuperado.decifrado.arquivos, bytesEmClaro: recuperado.decifrado.bytesEmClaro });
    registrar('RESTAURAR_CONTAINER', true);

    passo = 'VERIFICAR_PACOTE';
    const pacoteDir = path.join(raiz, nomeDecifrado);
    const t2 = agora();
    let lido;
    try {
      const bytes = await lerManifesto(pacoteDir);
      lido = criarLeitorL2({ fonteDeChaves: mac.fonte, layoutMinimo: 2 })({ bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    } catch (e) {
      return falhar('FALHOU', 'VERIFICAR_PACOTE', 'PACOTE_NAO_VERIFICADO', { detalhe: fixo(ehObjeto(e) ? (e.code ?? e.motivo) : undefined) });
    }
    const verificacao = await verificarPacote({ pacote: pacoteDir, lido });
    const t3 = agora();
    if (!ehObjeto(verificacao) || verificacao.ok !== true) return falhar('FALHOU', 'VERIFICAR_PACOTE', 'PACOTE_NAO_VERIFICADO', { detalhe: fixo(ehObjeto(verificacao) ? verificacao.motivo : undefined) });
    registrar('VERIFICAR_PACOTE', true);

    passo = 'RESTAURAR_FONTES';
    const fontes = await restaurador.restaurar({ pacote: pacoteDir, lido });
    if (!ehObjeto(fontes) || fontes.ok !== true || !Array.isArray(fontes.passos)) return falhar('FALHOU', 'RESTAURAR_FONTES', 'RESTAURACAO_DE_FONTES_FALHOU');
    registrar('RESTAURAR_FONTES', true);

    passo = 'AVALIAR_DR';
    if (alvos === undefined) {
      acumulado.dr = Object.freeze({ classe: 'NAO_AVALIADO', rpoAtendido: null, rtoAtendido: null, rtoMedidoMs: null, falhouEm: null });
      acumulado.pendencias.push('RPO_E_RTO_NAO_FIXADOS');
      registrar('AVALIAR_DR', true);
      return resultado(true, 'CONCLUIDO', null);
    }
    let avaliacao;
    try {
      const plano = planejarEnsaioDeDR({ ultimoBackupEm, agora: iso(tInicio), alvos: { rpoMs: alvos.rpoMs, rtoMs: alvos.rtoMs } });
      const medidos = [{ id: 'DECIFRAR', ok: true, inicioEm: iso(t0), fimEm: iso(t1) }, { id: 'VERIFICACOES_8_7', ok: true, inicioEm: iso(t2), fimEm: iso(t3) }];
      avaliacao = avaliarEnsaioDeDR({ plano, passos: [...medidos, ...fontes.passos], restauracao: ehObjeto(fontes.restauracao) ? fontes.restauracao : {} });
    } catch { return falhar('FALHOU', 'AVALIAR_DR', 'DR_ENTRADA_INVALIDA'); }
    acumulado.dr = Object.freeze({ classe: avaliacao.classe, rpoAtendido: avaliacao.rpoAtendido, rtoAtendido: avaliacao.rtoAtendido, rtoMedidoMs: avaliacao.rtoMedidoMs, falhouEm: avaliacao.falhouEm });
    if (avaliacao.classe !== 'RECUPERADO') return falhar('FALHOU', 'AVALIAR_DR', CODIGO_DA_CLASSE[avaliacao.classe] ?? 'DR_FALHOU');
    registrar('AVALIAR_DR', true);
    return resultado(true, 'CONCLUIDO', null);
  } catch {
    return falhar('FALHOU', passo, 'ERRO_INESPERADO');
  }
}

module.exports = { restaurarDoDestinoDuravel };
