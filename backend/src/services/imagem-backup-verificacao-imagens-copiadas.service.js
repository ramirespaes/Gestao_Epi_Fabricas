'use strict';

const crypto = require('node:crypto');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-VERIFICACAO-IMAGENS-COPIADAS-1): VERIFICAÇÃO FÍSICA independente das imagens JÁ COPIADAS para a preparação. Contrato PROVISÓRIO.
 * Relê os bytes dos arquivos do DESTINO e confere plano, resultado da cópia e disco; não copia, não grava, não remove, não sela, não publica, não finaliza snapshot e não libera trava.
 *
 * DIVISÃO DE RESPONSABILIDADES: este verificador cuida só da correspondência FÍSICA entre plano, cópia e arquivos do destino. A consistência LÓGICA do manifesto com o plano e a cópia é do
 * `construirManifesto`; este módulo não recebe nem valida o manifesto. Uma garantia não substitui a outra e a futura integração precisa exigir as duas.
 *
 * `criarVerificadorDeImagensCopiadas({ destino })` (ESTRITO; TypeError se inválido) -> { verificar }. `destino.abrir` é capturado UMA vez e chamado com o `this` original; o destino é a preparação
 * fixada por composição confiável (nenhum caminho é aceito do chamador); só `abrir` é usado. `verificar({ plano, copia })` é ESTRITO, assíncrono, REENTRANTE e SEM estado entre chamadas: cada chamada
 * tem o próprio estado e relê os arquivos de verdade (nada positivo é guardado). Antes de qualquer E/S exige plano (itens { chave, sha256 }, chaves no formato do armazenamento, sem repetição) e cópia
 * completa e positiva (itens { chave, sha256, bytes }) coerentes entre si; senão { concluida:false, ok:false, motivo:'ENTRADA_INVALIDA' } sem abrir nada. Para cada item lê o fluxo, conta os bytes e
 * calcula o SHA-256 dos bytes LIDOS e compara com o hash do ITEM DO PLANO (nunca o segmento de diretório da chave) e os bytes da cópia.
 * Resultados congelados: { concluida:true, ok:true, examinados, bytes } | { concluida:true, ok:false, examinados, divergencias:[{ chave, codigo }] } (ARQUIVO_AUSENTE | ARQUIVO_INVALIDO |
 * TAMANHO_DIVERGENTE | SHA256_DIVERGENTE) | { concluida:false, ok:false, motivo } (ENTRADA_INVALIDA | LEITURA_FALHOU: leitura que não pôde ser concluída, inclusive falha ao fechar o fluxo próprio).
 * Nada de caminho, mensagem de exceção ou valor recebido sai daqui. Nenhum veredito, `valido`, `recuperavel` ou `publicado`.
 *
 * LIMITES: a conferência de caminho e a abertura são as do armazenamento (`lstat` por componente e O_NOFOLLOW), que reduzem e NÃO eliminam TOCTOU; nada garante imutabilidade depois da leitura;
 * arquivos EXTRAS no destino não são inventariados (política em aberto); a regra de formato da chave repete a do armazenamento, que não a exporta, para recusar antes de qualquer leitura.
 * Não prova integridade do dump, autenticidade, consistência transacional banco x filesystem, restauração nem recuperabilidade.
 */

const CHAVE = /^(?:[1-9][0-9]{0,14}|padrao)\/[0-9a-f]{64}\/(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const SHA256 = /^[0-9a-f]{64}$/;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';
const chavesExatas = (o, esperadas) => {
  const proprias = Reflect.ownKeys(o);
  return proprias.length === esperadas.length && proprias.every((k) => typeof k === 'string' && esperadas.includes(k));
};

const inconclusiva = (motivo) => Object.freeze({ concluida: false, ok: false, motivo });

/** Valida e COPIA plano e cópia numa passada (cada propriedade lida uma vez); null se qualquer coisa estiver fora do contrato. */
function capturarEntrada(entrada) {
  try {
    if (!ehObjeto(entrada) || !chavesExatas(entrada, ['plano', 'copia'])) return null;
    const plano = entrada.plano;
    const copia = entrada.copia;
    if (!Array.isArray(plano) || !ehObjeto(copia) || !chavesExatas(copia, ['arquivos', 'completo', 'copiados', 'falha', 'ok'])) return null;
    const { ok, completo, falha, copiados, arquivos } = copia;
    if (ok !== true || completo !== true || falha !== null || !Array.isArray(arquivos) || copiados !== arquivos.length || arquivos.length !== plano.length) return null;

    const esperados = new Map();
    for (let i = 0; i < plano.length; i += 1) {
      const item = plano[i];
      if (!ehObjeto(item) || !chavesExatas(item, ['chave', 'sha256'])) return null;
      const { chave, sha256 } = item;
      if (typeof chave !== 'string' || !CHAVE.test(chave) || typeof sha256 !== 'string' || !SHA256.test(sha256) || esperados.has(chave)) return null;
      esperados.set(chave, { chave, sha256, bytes: null });
    }
    const vistas = new Set();
    for (let i = 0; i < arquivos.length; i += 1) {
      const item = arquivos[i];
      if (!ehObjeto(item) || !chavesExatas(item, ['chave', 'sha256', 'bytes'])) return null;
      const { chave, sha256, bytes } = item;
      if (typeof chave !== 'string' || !Number.isSafeInteger(bytes) || bytes < 1 || vistas.has(chave)) return null;
      const esperado = esperados.get(chave);
      if (esperado === undefined || esperado.sha256 !== sha256) return null;
      vistas.add(chave);
      esperado.bytes = bytes;
    }
    return [...esperados.values()];
  } catch {
    return null;
  }
}

/** Lê um arquivo do destino em fluxo. Devolve { lido, sha256 } ou lança um marcador: { diverge } (ARQUIVO_AUSENTE/INVALIDO) ou { falhou } (leitura inconclusiva). */
async function lerArquivo(abrir, destino, chave) {
  let fluxo;
  try {
    fluxo = await abrir.call(destino, chave);
  } catch (falha) {
    let codigo = null;
    try { codigo = falha !== null && typeof falha === 'object' ? falha.codigo : null; } catch { codigo = null; }
    if (codigo === 'ARQUIVO_AUSENTE') throw { diverge: 'ARQUIVO_AUSENTE' }; // eslint-disable-line no-throw-literal
    if (codigo === 'CHAVE_INVALIDA') throw { diverge: 'ARQUIVO_INVALIDO' }; // eslint-disable-line no-throw-literal
    throw { falhou: true }; // eslint-disable-line no-throw-literal
  }

  let resultado = null;
  let falhou = false;
  try {
    if (fluxo === null || typeof fluxo !== 'object' || !ehFuncao(fluxo[Symbol.asyncIterator])) throw new Error('fluxo inválido');
    const hash = crypto.createHash('sha256');
    let lido = 0;
    for await (const bloco of fluxo) {
      if (!(bloco instanceof Uint8Array)) throw new Error('bloco inválido');
      hash.update(bloco);
      lido += bloco.length;
    }
    resultado = { lido, sha256: hash.digest('hex') };
  } catch {
    falhou = true;
  } finally {
    // O fluxo é próprio desta chamada: se ainda não foi destruído, destrói; falha ao fechar é leitura inconclusiva (nunca ignorada).
    try { if (fluxo !== null && typeof fluxo === 'object' && ehFuncao(fluxo.destroy) && fluxo.destroyed !== true) fluxo.destroy(); } catch { falhou = true; }
  }
  if (falhou || resultado === null) throw { falhou: true }; // eslint-disable-line no-throw-literal
  return resultado;
}

function criarVerificadorDeImagensCopiadas(opcoes) {
  if (!ehObjeto(opcoes) || !chavesExatas(opcoes, ['destino'])) throw new TypeError('opções do verificador inválidas');
  let destino;
  let abrir;
  try {
    destino = opcoes.destino;
    if (!ehObjeto(destino)) throw new TypeError('destino inválido');
    abrir = destino.abrir;
  } catch {
    throw new TypeError('opções do verificador inválidas');
  }
  if (!ehFuncao(abrir)) throw new TypeError('destino inválido');

  async function verificar(bruta) {
    // P3 (opcional): `sinal` = pedido de cancelamento cooperativo; só entra com as DUAS chaves de sempre (nenhuma outra) e é conferido ponto a ponto, entre itens. A verificação é somente leitura: cancelar não altera nada.
    let entrada = bruta;
    let sinal = null;
    try {
      if (ehObjeto(bruta) && Object.hasOwn(bruta, 'sinal')) {
        if (!chavesExatas(bruta, ['plano', 'copia', 'sinal']) || !ehObjeto(bruta.sinal) || typeof bruta.sinal.aborted !== 'boolean') return inconclusiva('ENTRADA_INVALIDA');
        sinal = bruta.sinal;
        entrada = { plano: bruta.plano, copia: bruta.copia };
      }
    } catch {
      return inconclusiva('ENTRADA_INVALIDA');
    }
    const esperados = capturarEntrada(entrada);
    if (esperados === null) return inconclusiva('ENTRADA_INVALIDA');

    // Estado EXCLUSIVO desta chamada.
    const divergencias = [];
    let examinados = 0;
    let bytes = 0;
    for (const item of esperados) {
      if (sinal !== null && sinal.aborted === true) return inconclusiva('CANCELADO');
      let lido;
      try {
        lido = await lerArquivo(abrir, destino, item.chave);
      } catch (marcador) {
        if (marcador !== null && typeof marcador === 'object' && typeof marcador.diverge === 'string') {
          divergencias.push(Object.freeze({ chave: item.chave, codigo: marcador.diverge }));
          continue;
        }
        return inconclusiva('LEITURA_FALHOU');
      }
      examinados += 1;
      bytes += lido.lido;
      if (lido.lido !== item.bytes) divergencias.push(Object.freeze({ chave: item.chave, codigo: 'TAMANHO_DIVERGENTE' }));
      else if (lido.sha256 !== item.sha256) divergencias.push(Object.freeze({ chave: item.chave, codigo: 'SHA256_DIVERGENTE' }));
    }

    if (divergencias.length > 0) return Object.freeze({ concluida: true, ok: false, examinados, divergencias: Object.freeze(divergencias) });
    return Object.freeze({ concluida: true, ok: true, examinados, bytes });
  }

  return Object.freeze({ verificar });
}

module.exports = { criarVerificadorDeImagensCopiadas };
