'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { localizarArmazenamentoDuravel, criarDestinoDuravel } = require('./imagem-backup-durabilidade.service');
const { identidadeConfere, AMBIENTES, COMPROVACOES_POSTERIORES } = require('./backup-armazenamento-duravel-fichas.service');
const { validarRecibo, LIMITE_OBJETO_BYTES } = require('./backup-recibo-duravel.service');

/**
 * D-ORF-6, R-D45 (D-F4): ENVIADOR S3 do contêiner cifrado, com PRÉ-VOO e RECIBOS. Só fala com uma PORTA injetada (`cliente`); o módulo não conhece SDK, rede, ambiente nem
 * arquivo de configuração, e só LÊ arquivos locais. O destino vem exclusivamente da FICHA (`localizarArmazenamentoDuravel`): bucket, conta proprietária, região, prefixo,
 * chaves KMS, retenção e identidades. Lista real vazia = nenhum enviador pode ser criado fora de NODE_ENV=test.
 *
 * Porta do PUBLICADOR (somente estas quatro operações; nenhuma de apagar, listar, ler objeto, retenção, política ou ciclo de vida):
 *  - `identidade() -> { contaId, arn }`                      (quem a AWS diz que está operando; confere com a identidade do publicador na ficha)
 *  - `lerConfiguracaoDoBucket({ bucket, donoEsperado }) -> { regiao, versionamento, objectLock:{habilitado,modo,dias}, criptografiaPadrao, propriedade, donoConfirmado }`
 *  - `descreverChave({ chaveArn }) -> { estado, especificacao }`
 *  - `gravarObjeto({ bucket, donoEsperado, chave, bytes, sha256, abrirFluxo, naoSobrescrever:true }) -> { resultado:'GRAVADO', versaoId, sha256, bytes, tentativas } | { resultado:'JA_EXISTE', tentativas }`
 * Requisitos da ligação real (T2): uma única gravação com o SHA-256 informado e a condição de objeto novo; `donoEsperado` em todo pedido (o DONO do bucket é a conta
 * da ficha; a identidade IAM que opera pode ser de outra conta); `tentativas` = quantas vezes o cliente enviou (reenvio interno > 1); erros com `code`: NEGADO,
 * DONO_DIVERGENTE e CHECKSUM_REJEITADO provam que NADA foi gravado; qualquer outro erro é ambíguo.
 *
 * Estados do envio: GRAVADO (recibo com a VERSÃO), RECUSADO (nada foi chamado ou o objeto já existia: nunca sobrescreve), FALHOU (falha DEFINITIVA, pode tentar de novo)
 * e INCERTO (resposta perdida, queda, prazo, resposta fora do contrato, reenvio interno que encontrou o objeto: pode ter gravado; nunca durável, sem recibo,
 * a chave fica bloqueada nesta execução e a verificação independente decide). Sem retentativa automática. O pré-voo vale por um tempo e é obrigatório.
 */

const PRAZO_PADRAO_MS = 60000;
const PRAZO_MAXIMO_MS = 600000;
const TTL_PADRAO_MS = 600000;
const TTL_MINIMO_MS = 1000;
const TTL_MAXIMO_MS = 3600000;
const BLOCO = 256 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const CHAVE_RELATIVA = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const VERSAO_ID = /^[A-Za-z0-9._+-]{1,1024}$/;
const DEFINITIVOS = new Set(['NEGADO', 'DONO_DIVERGENTE', 'CHECKSUM_REJEITADO']);
const METODOS_DA_PORTA = Object.freeze(['identidade', 'lerConfiguracaoDoBucket', 'descreverChave', 'gravarObjeto']);
const ITENS_DE_CONFIGURACAO = Object.freeze(['DONO_DO_DESTINO', 'REGIAO', 'VERSIONAMENTO', 'OBJECT_LOCK', 'RETENCAO_PADRAO', 'CRIPTOGRAFIA_PADRAO', 'PROPRIEDADE_DO_OBJETO']);
const CHAVES_DA_CONFIGURACAO = Object.freeze(['regiao', 'versionamento', 'objectLock', 'criptografiaPadrao', 'propriedade', 'donoConfirmado']);
const OPCOES = Object.freeze(['destinoId', 'ambiente', 'cliente', 'relogio', 'prazoMs', 'ttlPreVooMs', 'registro']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};
const configuracaoInvalida = () => Object.assign(new TypeError('configuração do enviador S3 inválida'), { code: 'CONFIGURACAO_INVALIDA' });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.includes('\0') && !c.endsWith('/');
const resultado = (estado, motivo) => Object.freeze({ estado, motivo });

function criarEnviadorS3(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => OPCOES.includes(k)) || !['destinoId', 'ambiente', 'cliente'].every((k) => Reflect.ownKeys(opcoes).includes(k))) throw configuracaoInvalida();
  const { destinoId, ambiente, cliente, registro } = opcoes;
  const relogio = opcoes.relogio === undefined ? () => Date.now() : opcoes.relogio;
  const prazoMs = opcoes.prazoMs === undefined ? PRAZO_PADRAO_MS : opcoes.prazoMs;
  const ttlMs = opcoes.ttlPreVooMs === undefined ? TTL_PADRAO_MS : opcoes.ttlPreVooMs;
  if (typeof destinoId !== 'string' || !AMBIENTES.includes(ambiente) || typeof relogio !== 'function') throw configuracaoInvalida();
  if (!ehObjeto(cliente) || !METODOS_DA_PORTA.every((m) => typeof cliente[m] === 'function')) throw configuracaoInvalida();
  if (!Number.isSafeInteger(prazoMs) || prazoMs < 1 || prazoMs > PRAZO_MAXIMO_MS || !Number.isSafeInteger(ttlMs) || ttlMs < TTL_MINIMO_MS || ttlMs > TTL_MAXIMO_MS) throw configuracaoInvalida();
  const achado = localizarArmazenamentoDuravel(destinoId, ambiente, registro);
  if (!achado.encontrada) throw Object.assign(new Error('destino durável não autorizado'), { code: 'DESTINO_DURAVEL_NAO_AUTORIZADO', motivo: achado.motivo });
  const { ficha, origem } = achado;
  const publicador = ficha.identidades.publicador;
  const estados = new Map();
  const porChave = new Map();
  const recibosEmitidos = [];
  let preVooValidoAte = null;

  const comPrazo = (executar) => new Promise((resolver, rejeitar) => {
    const timer = setTimeout(() => rejeitar(Object.assign(new Error('prazo'), { code: 'PRAZO' })), prazoMs);
    Promise.resolve().then(executar).then((v) => { clearTimeout(timer); resolver(v); }, (e) => { clearTimeout(timer); rejeitar(e); });
  });
  const consultar = async (executar) => { try { return { ok: true, valor: await comPrazo(executar) }; } catch { return { ok: false, valor: null }; } };

  async function executarPreVoo() {
    preVooValidoAte = null;
    const itens = [];
    const registrar = (id, ok, codigo) => { itens.push(Object.freeze({ id, ok, codigo })); };
    const identidade = await consultar(() => cliente.identidade());
    if (!identidade.ok || !ehObjeto(identidade.valor)) registrar('IDENTIDADE_PUBLICADOR', false, 'FALHA_AO_CONSULTAR');
    else if (identidadeConfere(publicador, identidade.valor)) registrar('IDENTIDADE_PUBLICADOR', true, 'CONFERE');
    else registrar('IDENTIDADE_PUBLICADOR', false, identidade.valor.contaId !== publicador.contaId ? 'CONTA_DIVERGENTE' : 'PRINCIPAL_DIVERGENTE');
    registrar('AUTORIZACAO_ENTRE_CONTAS', true, publicador.contaId !== ficha.contaId ? 'ENTRE_CONTAS_A_COMPROVAR' : 'MESMA_CONTA');
    if (!itens[0].ok) {
      for (const id of [...ITENS_DE_CONFIGURACAO, 'CHAVE_MAC', 'CHAVE_CIFRA']) registrar(id, false, 'NAO_EXECUTADO');
    } else {
      const c = await consultar(() => cliente.lerConfiguracaoDoBucket({ bucket: ficha.bucket, donoEsperado: ficha.contaId }));
      const v = c.valor;
      if (!c.ok || !ehObjeto(v) || !chavesExatas(v, CHAVES_DA_CONFIGURACAO) || !ehObjeto(v.objectLock) || !chavesExatas(v.objectLock, ['habilitado', 'modo', 'dias'])) {
        for (const id of ITENS_DE_CONFIGURACAO) registrar(id, false, 'FALHA_AO_CONSULTAR');
      } else {
        registrar('DONO_DO_DESTINO', v.donoConfirmado === true, v.donoConfirmado === true ? 'CONFIRMADO' : 'DONO_NAO_CONFIRMADO');
        registrar('REGIAO', v.regiao === ficha.regiao, v.regiao === ficha.regiao ? 'CONFERE' : 'REGIAO_DIVERGENTE');
        registrar('VERSIONAMENTO', v.versionamento === 'Enabled', v.versionamento === 'Enabled' ? 'HABILITADO' : 'VERSIONAMENTO_NAO_HABILITADO');
        registrar('OBJECT_LOCK', v.objectLock.habilitado === true, v.objectLock.habilitado === true ? 'HABILITADO' : 'OBJECT_LOCK_AUSENTE');
        const { modo, dias } = v.objectLock;
        if (modo === null || dias === null || modo === undefined || dias === undefined) registrar('RETENCAO_PADRAO', false, 'RETENCAO_AUSENTE');
        else if (modo !== ficha.retencao.modo) registrar('RETENCAO_PADRAO', false, 'MODO_DIVERGENTE');
        else if (!Number.isInteger(dias) || dias < ficha.retencao.dias) registrar('RETENCAO_PADRAO', false, 'DIAS_INSUFICIENTES');
        else registrar('RETENCAO_PADRAO', true, 'CONFERE');
        registrar('CRIPTOGRAFIA_PADRAO', v.criptografiaPadrao === 'AES256', v.criptografiaPadrao === 'AES256' ? 'CONFERE' : 'CRIPTOGRAFIA_PADRAO_DIVERGENTE');
        registrar('PROPRIEDADE_DO_OBJETO', v.propriedade === 'BucketOwnerEnforced', v.propriedade === 'BucketOwnerEnforced' ? 'CONFERE' : 'PROPRIEDADE_NAO_ENFORCED');
      }
      for (const [id, chaveArn] of [['CHAVE_MAC', ficha.chaveMac], ['CHAVE_CIFRA', ficha.chaveCifra]]) {
        const k = await consultar(() => cliente.descreverChave({ chaveArn }));
        if (!k.ok || !ehObjeto(k.valor) || !chavesExatas(k.valor, ['estado', 'especificacao'])) registrar(id, false, 'FALHA_AO_CONSULTAR');
        else if (k.valor.estado !== 'Enabled') registrar(id, false, 'CHAVE_KMS_NAO_HABILITADA');
        else if (k.valor.especificacao !== 'SYMMETRIC_DEFAULT') registrar(id, false, 'CHAVE_KMS_NAO_SIMETRICA');
        else registrar(id, true, 'HABILITADA');
      }
    }
    const ok = itens.every((i) => i.ok);
    if (ok) preVooValidoAte = relogio() + ttlMs;
    return Object.freeze({ ok, itens: Object.freeze(itens), validoAte: ok ? preVooValidoAte : null, comprovacoesPendentes: COMPROVACOES_POSTERIORES });
  }

  async function resumir(fh, bytes) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(BLOCO);
    let posicao = 0;
    while (posicao < bytes) {
      const { bytesRead } = await fh.read(buffer, 0, Math.min(BLOCO, bytes - posicao), posicao);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      posicao += bytesRead;
    }
    return hash.digest('hex');
  }

  function classificar(resposta, entrada) {
    const tentativasOk = (t) => Number.isInteger(t) && t >= 1 && t <= 100;
    if (!ehObjeto(resposta)) return { tipo: 'FORA' };
    if (resposta.resultado === 'JA_EXISTE') {
      if (!chavesExatas(resposta, ['resultado', 'tentativas']) || !tentativasOk(resposta.tentativas)) return { tipo: 'FORA' };
      return { tipo: resposta.tentativas > 1 ? 'EXISTENTE_AMBIGUO' : 'EXISTENTE' };
    }
    if (resposta.resultado === 'GRAVADO' && chavesExatas(resposta, ['resultado', 'versaoId', 'sha256', 'bytes', 'tentativas']) && tentativasOk(resposta.tentativas)
      && typeof resposta.versaoId === 'string' && VERSAO_ID.test(resposta.versaoId) && resposta.versaoId !== 'null' && resposta.sha256 === entrada.sha256 && resposta.bytes === entrada.bytes) return { tipo: 'GRAVADO', versaoId: resposta.versaoId };
    return { tipo: 'FORA' };
  }

  async function enviarUm(entrada, chaveCompleta) {
    let fh = null;
    let chamou = false;
    try {
      try { fh = await fsp.open(entrada.caminho, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); } catch { return resultado('FALHOU', 'ARQUIVO_LOCAL_INVALIDO'); }
      const estado = await fh.stat();
      if (!estado.isFile() || estado.size !== entrada.bytes) return resultado('FALHOU', 'ARQUIVO_LOCAL_INVALIDO');
      if ((await resumir(fh, entrada.bytes)) !== entrada.sha256) return resultado('FALHOU', 'ARQUIVO_LOCAL_DIVERGENTE');
      const abrirFluxo = () => (entrada.bytes === 0 ? Readable.from([]) : fh.createReadStream({ start: 0, end: entrada.bytes - 1, autoClose: false, emitClose: false }));
      chamou = true;
      let resposta;
      try {
        resposta = await comPrazo(() => cliente.gravarObjeto({ bucket: ficha.bucket, donoEsperado: ficha.contaId, chave: chaveCompleta, bytes: entrada.bytes, sha256: entrada.sha256, abrirFluxo, naoSobrescrever: true }));
      } catch (erro) {
        const codigo = erro !== null && typeof erro === 'object' ? String(erro.code ?? '') : '';
        return DEFINITIVOS.has(codigo) ? resultado('FALHOU', codigo) : resultado('INCERTO', 'RESPOSTA_PERDIDA_OU_ERRO');
      }
      const c = classificar(resposta, entrada);
      if (c.tipo === 'EXISTENTE') return resultado('RECUSADO', 'OBJETO_JA_EXISTE');
      if (c.tipo === 'EXISTENTE_AMBIGUO') return resultado('INCERTO', 'EXISTENTE_APOS_TENTATIVA_AMBIGUA');
      if (c.tipo !== 'GRAVADO') return resultado('INCERTO', 'RESPOSTA_FORA_DO_CONTRATO');
      const recibo = Object.freeze({ versao: 1, destinoId: ficha.id, ambiente: ficha.ambiente, bucket: ficha.bucket, chave: chaveCompleta, versaoId: c.versaoId, sha256: entrada.sha256, bytes: entrada.bytes, gravadoEm: new Date(relogio()).toISOString() });
      if (validarRecibo(recibo) !== null) return resultado('INCERTO', 'RESPOSTA_FORA_DO_CONTRATO');
      porChave.set(chaveCompleta, recibo);
      recibosEmitidos.push(recibo);
      return Object.freeze({ estado: 'GRAVADO', recibo });
    } catch {
      return chamou ? resultado('INCERTO', 'RESPOSTA_PERDIDA_OU_ERRO') : resultado('FALHOU', 'ARQUIVO_LOCAL_INVALIDO');
    } finally {
      if (fh !== null) await fh.close().catch(() => {});
    }
  }

  async function enviarArquivo(entrada) {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['caminho', 'chave', 'sha256', 'bytes'])) return resultado('RECUSADO', 'ENTRADA_INVALIDA');
    if (!caminhoCanonico(entrada.caminho) || typeof entrada.chave !== 'string' || entrada.chave.length > 200 || !CHAVE_RELATIVA.test(entrada.chave) || typeof entrada.sha256 !== 'string' || !SHA256.test(entrada.sha256) || !Number.isSafeInteger(entrada.bytes) || entrada.bytes < 0) return resultado('RECUSADO', 'ENTRADA_INVALIDA');
    if (entrada.bytes > LIMITE_OBJETO_BYTES) return resultado('RECUSADO', 'ARQUIVO_ACIMA_DO_LIMITE');
    if (preVooValidoAte === null || relogio() > preVooValidoAte) return resultado('RECUSADO', 'PRE_VOO_AUSENTE_OU_EXPIRADO');
    const chaveCompleta = `${ficha.prefixo}${entrada.chave}`;
    const anterior = estados.get(chaveCompleta);
    if (anterior !== undefined && anterior !== 'FALHOU') return resultado('RECUSADO', 'CHAVE_JA_USADA_NESTA_EXECUCAO');
    estados.set(chaveCompleta, 'EM_ANDAMENTO');
    const r = await enviarUm(entrada, chaveCompleta);
    estados.set(chaveCompleta, r.estado);
    return r;
  }

  /** O que o armazenamento afirma ter gravado, para o contrato `criarDestinoDuravel`: só existe para chaves COM recibo; hash ou bytes diferentes do recibo não confirmam. */
  const adaptadorDeConfirmacao = Object.freeze({
    async confirmar(pedido) {
      const r = ehObjeto(pedido) ? porChave.get(pedido.chave) : undefined;
      if (r === undefined) return { confirmado: false, chave: pedido.chave, sha256: pedido.sha256, bytes: pedido.bytes };
      return { confirmado: true, chave: r.chave, sha256: r.sha256, bytes: r.bytes };
    },
  });

  function criarDestino(entrada) {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['prazoMs'])) throw configuracaoInvalida();
    return criarDestinoDuravel({ id: ficha.id, adaptador: adaptadorDeConfirmacao, prazoMs: entrada.prazoMs, ...(registro === undefined ? {} : { registro }) });
  }

  return Object.freeze({
    destino: Object.freeze({ id: ficha.id, ambiente: ficha.ambiente, bucket: ficha.bucket, regiao: ficha.regiao, origem }),
    executarPreVoo,
    enviarArquivo,
    recibos: () => Object.freeze([...recibosEmitidos]),
    adaptadorDeConfirmacao,
    criarDestino,
  });
}

module.exports = { criarEnviadorS3, METODOS_DA_PORTA };
