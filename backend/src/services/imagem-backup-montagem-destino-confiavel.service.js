'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { criarArmazenamentoImagens } = require('../storage/armazenamento-imagens');
const { criarCopiaDeImagens } = require('./imagem-backup-copia.service');
const { criarVerificadorDeImagensCopiadas } = require('./imagem-backup-verificacao-imagens-copiadas.service');
const { criarEtapaDeCopiaVerificada } = require('./imagem-backup-copia-verificada.service');
const { criarComposicaoDoConjunto } = require('./imagem-backup-composicao.service');
const { criarSelagem } = require('./imagem-backup-selagem.service');
const { ehOrcamentoDeBytes } = require('../utils/orcamento-de-bytes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-VF09-MONTAGEM-CONFIAVEL-DESTINO-1): MONTAGEM CONFIÁVEL de UMA operação. Interna e para chamador confiável; contrato PROVISÓRIO.
 * Cria UM armazenamento de destino sobre a preparação e dele deriva, por construção, o `destino` da cópia e o `destino` do verificador físico, depois o vínculo `copiarVerificado` e a composição existentes.
 * O chamador não pode fornecer `copiar`, `verificador`, `destino`, `armazenamento` ou `area`; o armazenamento completo (gravar, remover, abrir, existe, listar...) fica PRIVADO nesta closure e nada dele é
 * devolvido. Não altera nenhum módulo existente e não constrói manifesto, não sela e não publica por conta própria: a composição existente faz isso.
 *
 * `criarMontagemDeDestinoConfiavel({ preparacao, origem, conjuntoId, maxBytesPorArquivo, selagem? })` (ESTRITO; TypeError de mensagem fixa, sem eco, ANTES de criar qualquer diretório) -> congelado
 * { compor, obterVerificacao }.
 *   - `preparacao`: caminho ABSOLUTO, canônico (sem `..`, NUL nem link simbólico em nenhum componente) de um diretório JÁ EXISTENTE; é a `area` do manifesto. LAYOUT PROVISÓRIO (a aprovar): a raiz do
 *     armazenamento é o subdiretório FIXO `imagens` da preparação (`<preparacao>/imagens`, criado pela fábrica do armazenamento); o manifesto fica em `<preparacao>/manifesto.*`. O nome é fixo e não é parâmetro;
 *   - `origem`: capacidade de leitura da ORIGEM das imagens (precisa de `abrir`), distinta do destino; nunca devolvida; `selagem` opcional (padrão `criarSelagem()`);
 *   - `compor` é o da composição (consumo único herdado da etapa); `obterVerificacao` é o do vínculo (lateral, síncrono, sem ler arquivo).
 *
 * LIMITES (VF-09 NÃO está integralmente resolvido): a garantia de que cópia e verificação usam a MESMA capacidade é POR CONSTRUÇÃO deste código (inspeção estrutural), não prova de identidade física contínua;
 * o `realpath` do armazenamento é resolvido na criação; `lstat`/`O_NOFOLLOW` não eliminam TOCTOU; nenhum escritor externo é excluído e nada garante imutabilidade depois da verificação; se `origem` for a própria
 * preparação, os contratos não detectam; operação pendente indefinidamente não tem cancelamento. Não prova integridade do dump, autenticidade, publicação, durabilidade nem recuperabilidade.
 */

const OBRIGATORIAS = ['preparacao', 'origem', 'conjuntoId', 'maxBytesPorArquivo'];
const PERMITIDAS = new Set([...OBRIGATORIAS, 'selagem', 'orcamento']);
const SUBDIRETORIO_DAS_IMAGENS = 'imagens';

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';

function invalido() {
  return new TypeError('parâmetros da montagem inválidos');
}

/** Preparação: caminho absoluto, canônico e JÁ EXISTENTE como diretório (sem link simbólico); nada é criado aqui. */
function preparacaoValida(preparacao) {
  if (typeof preparacao !== 'string' || preparacao === '' || preparacao.includes('\0') || !path.isAbsolute(preparacao)) return false;
  if (preparacao.split(/[\\/]/).includes('..')) return false;
  const resolvida = path.resolve(preparacao);
  try {
    const estado = fs.lstatSync(resolvida);
    if (estado.isSymbolicLink() || !estado.isDirectory()) return false;
    return fs.realpathSync(resolvida) === resolvida;
  } catch {
    return false;
  }
}

/** Valida TUDO e captura cada propriedade UMA vez, antes de qualquer efeito em disco. */
function capturar(opcoes) {
  try {
    if (!ehObjeto(opcoes)) throw invalido();
    const proprias = Reflect.ownKeys(opcoes);
    if (!proprias.every((k) => typeof k === 'string' && PERMITIDAS.has(k)) || !OBRIGATORIAS.every((k) => proprias.includes(k))) throw invalido();
    const { preparacao, origem, conjuntoId, maxBytesPorArquivo } = opcoes;
    const selagem = proprias.includes('selagem') ? opcoes.selagem : null;
    if (!preparacaoValida(preparacao)) throw invalido();
    if (!ehObjeto(origem) || !ehFuncao(origem.abrir)) throw invalido();
    if (typeof conjuntoId !== 'string') throw invalido();
    if (!Number.isSafeInteger(maxBytesPorArquivo) || maxBytesPorArquivo <= 0) throw invalido();
    if (proprias.includes('selagem') && (!ehObjeto(selagem) || !ehFuncao(selagem.selar) || !ehFuncao(selagem.verificar))) throw invalido();
    const orcamento = proprias.includes('orcamento') ? opcoes.orcamento : null;
    if (orcamento !== null && !ehOrcamentoDeBytes(orcamento)) throw invalido();
    return { preparacao, origem, conjuntoId, maxBytesPorArquivo, selagem, orcamento };
  } catch {
    throw invalido();
  }
}

function criarMontagemDeDestinoConfiavel(opcoes) {
  const { preparacao, origem, conjuntoId, maxBytesPorArquivo, selagem, orcamento } = capturar(opcoes);

  // UMA capacidade de destino, privada a esta closure: dela derivam cópia e verificação.
  const armazenamento = criarArmazenamentoImagens({ diretorio: path.join(preparacao, SUBDIRETORIO_DAS_IMAGENS) });
  const copiar = criarCopiaDeImagens({ origem, destino: armazenamento, maxBytesPorArquivo, ...(orcamento === null ? {} : { orcamento }) });
  const verificador = criarVerificadorDeImagensCopiadas({ destino: armazenamento });
  const etapa = criarEtapaDeCopiaVerificada({ copiar, verificador });
  const composicao = criarComposicaoDoConjunto({ copiar: etapa.copiarVerificado, selagem: selagem === null ? criarSelagem() : selagem, area: preparacao, conjuntoId });

  // Só as duas capacidades públicas, em funções próprias (nenhuma referência interna é devolvida).
  return Object.freeze({
    compor: (entrada) => composicao.compor(entrada),
    obterVerificacao: () => etapa.obterVerificacao(),
  });
}

module.exports = { criarMontagemDeDestinoConfiavel };
