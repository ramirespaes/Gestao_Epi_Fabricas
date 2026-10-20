'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const imagemEmpresaRepo = require('../repositories/imagem-empresa.repository');
const imagemPadraoRepo = require('../repositories/imagem-padrao.repository');
const { chaveDe } = require('../storage/armazenamento-imagens');

/**
 * Entrega das imagens de produto ao navegador (Biblioteca de Imagens, Unidade 5A-1). `obter` devolve os bytes de UMA variante
 * (`miniatura` ou `exibicao`) já VERIFICADOS, ou lança erro. Arquivo nenhum sai sem: existir, caber no teto de leitura, bater com o
 * SHA-256 registrado e começar como WebP. O arquivo mestre nunca é entregue.
 *
 * - A empresa vem da sessão (argumento do controller) e a chave de armazenamento sai do banco; nada do cliente chega ao disco.
 * - Inexistente, inativa, de outra empresa e todo defeito do arquivo (ausente, adulterado, grande demais, não-WebP) são o MESMO 404
 *   IMAGEM_NAO_ENCONTRADA: nenhum oráculo de existência. O motivo real vai só para o registro técnico (ids e motivo; nunca chave,
 *   caminho ou hash). Falha de E/S do armazenamento é 500 genérico, e não 404.
 * - Sem armazenamento configurado, 503 antes de consultar qualquer coisa.
 */

const ORIGENS = Object.freeze(['empresa', 'padrao']);
const VARIANTES = Object.freeze(['miniatura', 'exibicao']);
const LIMITE_LEITURA_BYTES = 1024 * 1024;
const MOTIVO_DA_ABERTURA = new Map([['ARQUIVO_AUSENTE', 'ARQUIVO_AUSENTE'], ['CHAVE_INVALIDA', 'CHAVE_RECUSADA']]);

const naoEncontrada = () => HttpError.notFound('IMAGEM_NAO_ENCONTRADA', 'Imagem não encontrada');
const indisponivel = () => new HttpError(503, 'IMAGENS_INDISPONIVEL', 'Imagens indisponíveis');
const registroPadrao = (etiqueta, campos) => { console.error(etiqueta, campos); };

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const ehWebp = (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP';

/** Lê o fluxo até o teto; passando dele, devolve null. O fluxo é sempre destruído (no excesso, no erro e no fim). */
async function lerComTeto(fluxo, limite) {
  const blocos = [];
  let total = 0;
  try {
    for await (const bloco of fluxo) {
      total += bloco.length;
      if (total > limite) return null;
      blocos.push(bloco);
    }
  } finally {
    fluxo.destroy();
  }
  return Buffer.concat(blocos, total);
}

/** A imagem da empresa da sessão ou da biblioteca padrão, só se ativa; qualquer outra coisa é null. */
async function buscarAtiva(executor, { empresaId, origem, id }) {
  if (origem === 'padrao') {
    const imagem = await imagemPadraoRepo.buscarPorId(executor, id);
    return imagem !== null && imagem.ativo === true ? imagem : null;
  }
  const imagem = await imagemEmpresaRepo.buscarPorId(executor, empresaId, id);
  // A segunda conferência de empresa é defesa em profundidade: o repositório já filtra por ela.
  return imagem !== null && imagem.empresaId === empresaId && imagem.estado === 'ATIVA' ? imagem : null;
}

/**
 * @param {{ armazenamento?: object|null, registro?: Function, limiteBytes?: number }} dependencias
 *   `armazenamento` ausente ou nulo deixa o recurso indisponível; `registro(etiqueta, campos)` é o registro técnico (padrão: console.error).
 */
function criarEntregaDeImagens({ armazenamento = null, registro = registroPadrao, limiteBytes = LIMITE_LEITURA_BYTES } = {}) {
  async function obter(executor, { empresaId, origem, id, variante }) {
    if (armazenamento === null || armazenamento === undefined) throw indisponivel();
    if (!ORIGENS.includes(origem) || !VARIANTES.includes(variante)) throw naoEncontrada();

    const imagem = await buscarAtiva(executor, { empresaId, origem, id });
    if (imagem === null) throw naoEncontrada();
    // A biblioteca padrão pode não ter a exibição registrada: sem hash não há arquivo a servir nem disco a consultar.
    const hash = variante === 'miniatura' ? imagem.sha256Miniatura : imagem.sha256Exibicao;
    if (typeof hash !== 'string') throw naoEncontrada();

    const registrar = (motivo) => registro('[imagem-entrega]', { empresaId, imagemId: imagem.id, motivo, origem, variante });
    let fluxo;
    try {
      // A derivada é sempre .webp, qualquer que seja o formato do mestre; o diretório leva o SHA-256 do envio.
      const escopo = origem === 'padrao' ? { escopo: 'PADRAO' } : { escopo: 'EMPRESA', empresaId: imagem.empresaId };
      fluxo = await armazenamento.abrir(chaveDe({ ...escopo, sha256: imagem.sha256, variante, formato: 'WEBP' }));
    } catch (falha) {
      const motivo = MOTIVO_DA_ABERTURA.get(falha?.codigo);
      if (motivo !== undefined) {
        registrar(motivo);
        throw naoEncontrada();
      }
      registrar('FALHA_ARMAZENAMENTO');
      throw HttpError.internal(falha);
    }

    let corpo;
    try {
      corpo = await lerComTeto(fluxo, limiteBytes);
    } catch (falha) {
      registrar('FALHA_ARMAZENAMENTO');
      throw HttpError.internal(falha);
    }
    if (corpo === null) {
      registrar('TAMANHO_EXCEDIDO');
      throw naoEncontrada();
    }
    if (sha256Hex(corpo) !== hash) {
      registrar('SHA256_DIVERGENTE');
      throw naoEncontrada();
    }
    if (!ehWebp(corpo)) {
      registrar('ASSINATURA_INVALIDA');
      throw naoEncontrada();
    }
    return { corpo, tipo: 'image/webp', etag: `"${hash}"`, versao: imagem.versao };
  }

  return Object.freeze({ obter });
}

module.exports = { criarEntregaDeImagens };
