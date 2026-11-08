'use strict';

const crypto = require('node:crypto');
const { lerConfiguracaoOperacional } = require('./backup-executor-configuracao.service');
const { criarFornecedoresPorArquivo } = require('./backup-executor-credenciais-arquivo.service');
const { criarConjuntoDeCredenciais, PAPEIS_DA_ACAO } = require('./backup-executor-credenciais.service');
const { criarLigacaoDoExecutor } = require('./backup-executor-ligacao.service');
const { criarCompositor } = require('./backup-executor-compositor.service');
const { lerLinhaDeEvidencia } = require('./backup-executor-evidencia.service');
const { criarValidadorDeDestinos } = require('./imagem-backup-destinos.service');

/**
 * D-ORF-6, Rodada B (B1): MONTAGEM DA LIGAÇÃO PARA O CLI. Devolve o `portas.compor` que o `backup-operar` já sabe usar, SOMENTE para ensaio isolado: modo ENSAIO, ambiente HOMOLOGACAO, finalidade
 * ENSAIO_ISOLADO e credenciais sintéticas por arquivo. Não escreve em disco, não cria processo e não decide política: os portões, a trava de operação e as listas continuam onde estão.
 *
 * `montarPortasDoCli({ pedido, ambiente, relogio, carregarSdk, escreverRecibo, colaboradores?, lerArquivo?, uid? })`:
 *  - sem `BACKUP_EXECUTOR_CONFIG` devolve `undefined` e o CLI mantém o comportamento sem ligação;
 *  - qualquer outra falha lança um erro de código fixo `LIGACAO_*` (o CLI o imprime no stderr e a execução fica BLOQUEADA com os motivos da política);
 *  - `colaboradores` (coordenação, auditoria, fatos, trabalho, adaptadores de produção e restauração, chaves, destinos) só chegam por injeção de quem chama em processo; nenhum código de produção os
 *    fornece nesta etapa, e o CLI real nunca os passa. Sem eles a montagem para antes de compor: o resultado real é sempre BLOQUEADO. Com eles (testes, adaptadores falsos) o compositor roda,
 *    e ainda assim a política exige destino aprovado, fonte de chaves aprovada e `OPERACAO_HABILITADA` (falsa) para qualquer coisa além do ensaio sintético.
 *  - configuração v2 (B2): destino local da ação, áreas protegidas, limites e prazo vêm da configuração e entram no compositor; colaboradores que também os tragam são recusados. A configuração só DESCREVE: o validador de
 *    destinos é sempre o OFICIAL sobre a lista operacional (hoje vazia, logo nada é autorizado); `registroDeDestinos` só existe para teste em processo e o validador oficial o recusa fora de NODE_ENV=test.
 *  - evidência: a linha é conferida por `lerLinhaDeEvidencia` e impressa pelo CLI no stdout (uma linha); recibo consolidado: UMA linha `RECIBO_CONSOLIDADO <json>` entregue a `escreverRecibo` (stderr).
 */

const LIMITE_RECIBO_BYTES = 1024 * 1024;
const ID_CONJUNTO = /^[A-Za-z0-9._-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PROIBIDOS_NOS_COLABORADORES = Object.freeze(['ligacao', 'evidencia', 'recibos', 'relogio']);
const CAUSAS_DE_CREDENCIAL = Object.freeze(['CREDENCIAL_INDISPONIVEL', 'CREDENCIAL_INVALIDA', 'CREDENCIAL_DE_OUTRO_PAPEL', 'CREDENCIAL_EXPIRADA', 'CREDENCIAIS_REPETIDAS_ENTRE_PAPEIS']);
const MODOS_ACOES = Object.freeze(Object.keys(PAPEIS_DA_ACAO));

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const recusa = (code) => Object.assign(new TypeError('ligação do CLI inválida'), { code });

/** Parâmetros que a configuração v2 fornece ao compositor, por ação; a verificação do destino não os usa. O validador é sempre o oficial. */
function parametrosDaConfiguracao(configuracao, acao, registroDeDestinos) {
  if (acao === 'VERIFICACAO_DESTINO') return {};
  const destino = configuracao.destinosLocais[acao];
  if (destino === undefined) throw recusa('LIGACAO_DESTINO_LOCAL_AUSENTE');
  const { limites } = configuracao;
  if (acao === 'BACKUP' && limites.arquivosMaximo === undefined) throw recusa('LIGACAO_LIMITES_INVALIDOS');
  let validador;
  try { validador = criarValidadorDeDestinos({ ambiente: 'HOMOLOGACAO', ...(registroDeDestinos === undefined ? {} : { registro: registroDeDestinos }) }); } catch { throw recusa('LIGACAO_DESTINO_LOCAL_INVALIDO'); }
  return { destinoLocal: { validador, destinoLocalId: destino.id, raiz: destino.raiz }, protegidos: { ...configuracao.protegidos }, limites: { ...limites }, prazoMs: configuracao.prazoMs };
}

function criarRegistradores({ escreverRecibo }) {
  const evidencia = Object.freeze({
    async registrar(linha) {
      if (typeof linha !== 'string' || lerLinhaDeEvidencia(linha).ok !== true) throw new TypeError('evidência inválida');
    },
  });
  const recibos = Object.freeze({
    async registrar(recibo) {
      if (!ehObjeto(recibo) || typeof recibo.conjuntoId !== 'string' || !ID_CONJUNTO.test(recibo.conjuntoId) || typeof recibo.sha256 !== 'string' || !SHA256.test(recibo.sha256) || !(recibo.bytes instanceof Uint8Array) || recibo.bytes.length < 1 || recibo.bytes.length > LIMITE_RECIBO_BYTES) throw new TypeError('recibo inválido');
      const bytes = Buffer.from(recibo.bytes);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== recibo.sha256) throw new TypeError('recibo inconsistente');
      escreverRecibo(`RECIBO_CONSOLIDADO ${JSON.stringify({ conjuntoId: recibo.conjuntoId, sha256: recibo.sha256, bytes: bytes.toString('base64') })}\n`);
    },
  });
  return { evidencia, recibos };
}

async function montarPortasDoCli(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['pedido', 'ambiente', 'relogio', 'carregarSdk', 'escreverRecibo', 'colaboradores', 'registroDeDestinos', 'lerArquivo', 'uid'].includes(k))) throw new TypeError('opções da montagem inválidas');
  const { pedido, ambiente, relogio, carregarSdk, escreverRecibo, colaboradores, registroDeDestinos, lerArquivo, uid } = opcoes;
  if (!ehObjeto(pedido) || typeof pedido.modo !== 'string' || typeof pedido.acao !== 'string' || typeof pedido.ambiente !== 'string' || !ehObjeto(ambiente)
    || typeof relogio !== 'function' || typeof carregarSdk !== 'function' || typeof escreverRecibo !== 'function') throw new TypeError('opções da montagem inválidas');

  const lida = lerConfiguracaoOperacional({ ambiente, ...(lerArquivo === undefined ? {} : { lerArquivo }), ...(uid === undefined ? {} : { uid }) });
  if (!lida.ok) {
    if (lida.codigo === 'CONFIGURACAO_AUSENTE') return undefined;
    throw recusa(`LIGACAO_${lida.codigo}`);
  }
  const { configuracao } = lida;
  if (pedido.modo !== 'ENSAIO' || pedido.ambiente !== 'HOMOLOGACAO') throw recusa('LIGACAO_FINALIDADE_NAO_AUTORIZADA');
  if (!MODOS_ACOES.includes(pedido.acao)) throw recusa('LIGACAO_ACAO_INVALIDA');

  const regra = PAPEIS_DA_ACAO[pedido.acao];
  if (!regra.obrigatorios.every((p) => Object.hasOwn(configuracao.papeis, p))) throw recusa('LIGACAO_PAPEL_OBRIGATORIO_AUSENTE');
  const papeis = [...regra.obrigatorios, ...regra.opcionaisNoEnsaio.filter((p) => Object.hasOwn(configuracao.papeis, p))];
  const caminhos = Object.fromEntries(papeis.map((p) => [p, configuracao.papeis[p]]));

  let conjunto;
  try {
    const fornecedores = criarFornecedoresPorArquivo({ caminhos, ...(lerArquivo === undefined ? {} : { lerArquivo }), ...(uid === undefined ? {} : { uid }) });
    conjunto = criarConjuntoDeCredenciais({ acao: pedido.acao, modo: 'ENSAIO', fornecedores, relogio });
    await conjunto.verificarSeparacao();
  } catch (e) {
    throw recusa(ehObjeto(e) && CAUSAS_DE_CREDENCIAL.includes(e.code) ? `LIGACAO_${e.code}` : 'LIGACAO_CREDENCIAIS_INVALIDAS');
  }

  let sdk;
  try { sdk = carregarSdk(); } catch { throw recusa('LIGACAO_SDK_NAO_APROVADO'); }
  if (!ehObjeto(sdk)) throw recusa('LIGACAO_SDK_NAO_APROVADO');

  if (colaboradores === undefined) throw recusa('LIGACAO_COLABORADORES_AUSENTES');
  if (!ehObjeto(colaboradores) || PROIBIDOS_NOS_COLABORADORES.some((k) => Object.hasOwn(colaboradores, k)) || !ehObjeto(colaboradores.auditoria) || typeof colaboradores.auditoria.registrar !== 'function') throw recusa('LIGACAO_COLABORADORES_INVALIDOS');
  const { auditoria, ...resto } = colaboradores;
  const daConfiguracao = configuracao.versao === 2 ? parametrosDaConfiguracao(configuracao, pedido.acao, registroDeDestinos) : {};
  if (Object.keys(daConfiguracao).some((k) => Object.hasOwn(resto, k))) throw recusa('LIGACAO_COLABORADORES_INVALIDOS');

  let ligacao;
  try { ligacao = criarLigacaoDoExecutor({ acao: pedido.acao, modo: 'ENSAIO', sdk, regiao: configuracao.regiao, credenciais: conjunto, auditoria }); } catch { throw recusa('LIGACAO_MONTAGEM_FALHOU'); }
  let compositor;
  try { compositor = criarCompositor({ ...resto, ...daConfiguracao, ligacao, ...criarRegistradores({ escreverRecibo }), relogio }); } catch { throw recusa('LIGACAO_COMPOSITOR_INVALIDO'); }
  return Object.freeze({ relogio, compor: compositor.compor });
}

module.exports = { montarPortasDoCli, LIMITE_RECIBO_BYTES };
