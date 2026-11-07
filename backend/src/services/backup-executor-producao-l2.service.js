'use strict';

const path = require('node:path');
const { classificarEstadoDoBackup } = require('./imagem-backup-composicao-producao.service');

/**
 * D-ORF-6, L1 (Bloco B): ADAPTADOR `producao` (layout 2) do executor operacional. Liga a porta `producao.produzir({ operacaoId, conjuntoId })` à composição de produção JÁ APROVADA (`criarBackupDeProducao`), que contém a
 * supervisão D-LIG-1 (controle de processo por operação, coordenação da janela, publicação confiável). Este módulo NÃO cria processo, NÃO escreve nem remove arquivo e NÃO lê ambiente: recebe a composição e um leitor de pacote por injeção.
 *
 * `criarProducaoL2({ composicao, raizPublicados, lerPacote })` -> `{ produzir(pedido) }`.
 *  - `composicao.executar({ nomeDaPreparacao, conjuntoId })` é a da composição real (configurada pelo chamador com layout 2); `raizPublicados` é a mesma raiz `armazenamento.publicados` dessa configuração (caminho absoluto canônico);
 *  - `lerPacote({ dir, nome }) -> lido` devolve o manifesto L2 já lido e autenticado (`lido.identidade.sha256Manifesto` obrigatório); a leitura real fica com quem integra (Bloco B real).
 *  - `produzir` devolve `{ ok: true, pacote: { dir, lido } }` SÓ se o resultado foi PRODUZIDO pela composição (reconhecido), o pacote foi publicado, a correlação contratual vale e não há quarentena recomendada. Qualquer outra coisa ou erro
 *    vira `{ ok: false, codigo }` com código fixo (nunca mensagem, causa ou caminho). Nunca lança.
 * A produção NÃO atesta operação real: as dimensões operacionais continuam sob a política e a evidência do executor.
 */

const NOME_DA_PREPARACAO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ID_OPERACAO = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const configuracaoInvalida = () => Object.assign(new TypeError('adaptador de produção inválido'), { code: 'PRODUCAO_L2_CONFIGURACAO_INVALIDA' });
const recusa = (codigo) => Object.freeze({ ok: false, codigo });
const caminhoCanonico = (c) => typeof c === 'string' && c.length > 1 && c.length <= 4096 && path.isAbsolute(c) && path.normalize(c) === c && !c.endsWith('/') && !c.includes('\0');

function criarProducaoL2(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['composicao', 'raizPublicados', 'lerPacote'].includes(k))) throw configuracaoInvalida();
  const { composicao, raizPublicados, lerPacote } = opcoes;
  if (!ehObjeto(composicao) || typeof composicao.executar !== 'function' || !caminhoCanonico(raizPublicados) || typeof lerPacote !== 'function') throw configuracaoInvalida();

  async function produzir(pedido) {
    if (!ehObjeto(pedido) || !Reflect.ownKeys(pedido).every((k) => k === 'operacaoId' || k === 'conjuntoId')) return recusa('PRODUCAO_PEDIDO_INVALIDO');
    const { operacaoId, conjuntoId } = pedido;
    if (typeof operacaoId !== 'string' || !ID_OPERACAO.test(operacaoId) || typeof conjuntoId !== 'string' || conjuntoId === '') return recusa('PRODUCAO_PEDIDO_INVALIDO');
    const nome = `l2-${operacaoId}`;
    if (!NOME_DA_PREPARACAO.test(nome)) return recusa('PRODUCAO_PEDIDO_INVALIDO');
    let composto;
    try { composto = await composicao.executar({ nomeDaPreparacao: nome, conjuntoId }); } catch { return recusa('PRODUCAO_COMPOSICAO_FALHOU'); }
    let estado;
    try { estado = classificarEstadoDoBackup(composto); } catch { return recusa('PRODUCAO_RESULTADO_NAO_RECONHECIDO'); }
    if (estado.reconhecido !== true) return recusa('PRODUCAO_RESULTADO_NAO_RECONHECIDO');
    if (estado.quarentena.recomendada === true) return recusa('PRODUCAO_EM_QUARENTENA');
    if (estado.pacotePublicado !== true) return recusa('PRODUCAO_NAO_PUBLICADA');
    if (estado.correlacaoContratual !== true) return recusa('PRODUCAO_SEM_CORRELACAO');
    const dir = path.join(raizPublicados, nome);
    let lido;
    try { lido = await lerPacote(Object.freeze({ dir, nome })); } catch { return recusa('PRODUCAO_PACOTE_ILEGIVEL'); }
    if (!ehObjeto(lido) || !ehObjeto(lido.identidade) || typeof lido.identidade.sha256Manifesto !== 'string' || !SHA256.test(lido.identidade.sha256Manifesto)) return recusa('PRODUCAO_PACOTE_ILEGIVEL');
    return Object.freeze({ ok: true, pacote: Object.freeze({ dir, lido }) });
  }

  return Object.freeze({ produzir });
}

module.exports = { criarProducaoL2 };
