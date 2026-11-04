'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { exigirDiretorio } = require('../config/imagens');
const { criarArmazenamentoImagens } = require('../storage/armazenamento-imagens');
const { criarMontagemDeDestinoConfiavel } = require('./imagem-backup-montagem-destino-confiavel.service');
const { ehOrcamentoDeBytes } = require('../utils/orcamento-de-bytes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-INTEGRADO-ORIGEM-PREPARACAO-EXCLUSIVA-1, Marco A): camada interna confiável ANTERIOR à montagem aprovada. Para chamador confiável; contrato PROVISÓRIO.
 * Obtém a origem da CONFIGURAÇÃO (não do consumidor), valida a separação física entre origem e preparação, ADQUIRE uma preparação nova por criação exclusiva de diretório e só então monta a operação.
 *
 * `adquirirPreparacaoExclusiva({ configuracaoDeImagens, diretorioPai, nomeDaPreparacao, conjuntoId, maxBytesPorArquivo, selagem? })` -> Promise<{ compor, obterVerificacao }> (a mesma forma pública da montagem). Rejeita
 * com Error de `code` e mensagem FIXOS, sem eco de caminho: PARAMETROS_INVALIDOS (TypeError), ORIGEM_INVALIDA, ORIGEM_SOBREPOSTA, PREPARACAO_EXISTENTE, AQUISICAO_FALHOU.
 * Ordem: (1) valida tudo SEM efeito em disco; (2) origem EXISTENTE e canônica (`criarArmazenamentoImagens` cria o diretório se ele não existir, então nenhuma fábrica roda antes); (3) separação por COMPONENTES de caminho
 * canônico; (4) AQUISIÇÃO por `mkdir` NÃO recursivo (a criação é o ato de aquisição; entrada existente = PREPARACAO_EXISTENTE, nunca adoção); (5) revalida a preparação já existente; (6) `criarMontagemDeDestinoConfiavel`.
 * Nunca limpa, remove, sobrescreve nem reutiliza: falha depois da aquisição deixa a preparação reservada. A origem é construída AQUI, a partir do caminho verificado; nada de capacidade ou caminho do consumidor.
 *
 * LIMITES: o reconhecimento da configuração por `exigirDiretorio` comprova que ela foi PRODUZIDA por `lerConfiguracao`, não que veio da inicialização operacional autorizada nem identidade física contínua; `diretorioPai`
 * é parâmetro de integração interna (não existe configuração para ele) e sua validação não prova a autoridade de quem chama; a comparação de caminhos é pontual (TOCTOU, escritores externos e aliases que os
 * contratos não detectam permanecem); a atomicidade do `mkdir` é a do filesystem local; sem cancelamento, recuperação, publicação, durabilidade ou recuperabilidade.
 */

const OBRIGATORIAS = ['configuracaoDeImagens', 'diretorioPai', 'nomeDaPreparacao', 'conjuntoId', 'maxBytesPorArquivo'];
const PERMITIDAS = new Set([...OBRIGATORIAS, 'selagem', 'orcamento']);
const NOME_DA_PREPARACAO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MENSAGENS = Object.freeze({
  PARAMETROS_INVALIDOS: 'parâmetros da preparação inválidos',
  ORIGEM_INVALIDA: 'origem das imagens indisponível',
  ORIGEM_SOBREPOSTA: 'origem e preparação se sobrepõem',
  PREPARACAO_EXISTENTE: 'a preparação já existe',
  AQUISICAO_FALHOU: 'falha ao adquirir a preparação',
});

const erro = (codigo) => Object.assign(codigo === 'PARAMETROS_INVALIDOS' ? new TypeError(MENSAGENS[codigo]) : new Error(MENSAGENS[codigo]), { code: codigo });
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ehFuncao = (v) => typeof v === 'function';

/** Valida TUDO e captura cada propriedade UMA vez; nada em disco além de `lstat`/`realpath` do diretório-pai. */
function capturar(opcoes) {
  try {
    if (!ehObjeto(opcoes)) throw erro('PARAMETROS_INVALIDOS');
    const proprias = Reflect.ownKeys(opcoes);
    if (!proprias.every((k) => typeof k === 'string' && PERMITIDAS.has(k)) || !OBRIGATORIAS.every((k) => proprias.includes(k))) throw erro('PARAMETROS_INVALIDOS');
    const { configuracaoDeImagens, diretorioPai, nomeDaPreparacao, conjuntoId, maxBytesPorArquivo } = opcoes;
    const temSelagem = proprias.includes('selagem');
    const selagem = temSelagem ? opcoes.selagem : undefined;

    const origem = exigirDiretorio(configuracaoDeImagens); // só configuração PRODUZIDA por lerConfiguracao; senão lança
    if (typeof diretorioPai !== 'string' || diretorioPai === '' || diretorioPai.includes('\0') || !path.isAbsolute(diretorioPai) || diretorioPai.split(/[\\/]/).includes('..')) throw erro('PARAMETROS_INVALIDOS');
    const pai = path.resolve(diretorioPai);
    const estado = fs.lstatSync(pai);
    if (estado.isSymbolicLink() || !estado.isDirectory() || fs.realpathSync(pai) !== pai) throw erro('PARAMETROS_INVALIDOS');
    if (typeof nomeDaPreparacao !== 'string' || !NOME_DA_PREPARACAO.test(nomeDaPreparacao)) throw erro('PARAMETROS_INVALIDOS');
    if (typeof conjuntoId !== 'string') throw erro('PARAMETROS_INVALIDOS');
    if (!Number.isSafeInteger(maxBytesPorArquivo) || maxBytesPorArquivo <= 0) throw erro('PARAMETROS_INVALIDOS');
    if (temSelagem && (!ehObjeto(selagem) || !ehFuncao(selagem.selar) || !ehFuncao(selagem.verificar))) throw erro('PARAMETROS_INVALIDOS');
    const orcamento = proprias.includes('orcamento') ? opcoes.orcamento : null;
    if (orcamento !== null && !ehOrcamentoDeBytes(orcamento)) throw erro('PARAMETROS_INVALIDOS');
    return { origem, pai, nomeDaPreparacao, conjuntoId, maxBytesPorArquivo, temSelagem, selagem, orcamento };
  } catch {
    throw erro('PARAMETROS_INVALIDOS');
  }
}

const componentes = (caminho) => path.resolve(caminho).split(path.sep).filter((c) => c !== '');
/** `ancestral` é igual a `descendente` ou o contém, comparando COMPONENTES (nunca prefixo textual). */
function contem(ancestral, descendente) {
  const a = componentes(ancestral);
  const d = componentes(descendente);
  return a.length <= d.length && a.every((c, i) => c === d[i]);
}
const sobrepostos = (origem, preparacao) => contem(origem, preparacao) || contem(preparacao, origem);

async function adquirirPreparacaoExclusiva(opcoes) {
  const { origem: origemDaConfiguracao, pai, nomeDaPreparacao, conjuntoId, maxBytesPorArquivo, temSelagem, selagem, orcamento } = capturar(opcoes);

  // Origem EXISTENTE e canônica, antes de qualquer fábrica que possa criar diretórios.
  let origemCanonica;
  try {
    if (!fs.statSync(origemDaConfiguracao).isDirectory()) throw erro('ORIGEM_INVALIDA');
    origemCanonica = fs.realpathSync(origemDaConfiguracao);
  } catch {
    throw erro('ORIGEM_INVALIDA');
  }

  // Separação física pontual, ANTES da aquisição: a preparação ainda não existe, então usa o pai canônico e o nome controlado.
  const preparacao = path.join(pai, nomeDaPreparacao);
  if (sobrepostos(origemCanonica, preparacao)) throw erro('ORIGEM_SOBREPOSTA');

  // A capacidade de leitura é construída AQUI, com o caminho verificado (o diretório já existe: a fábrica não cria nada).
  let origem;
  try {
    origem = criarArmazenamentoImagens({ diretorio: origemCanonica });
  } catch {
    throw erro('ORIGEM_INVALIDA');
  }

  // AQUISIÇÃO: criação exclusiva do diretório final (sem `recursive`).
  try {
    await fsp.mkdir(preparacao, { mode: 0o700 });
  } catch (falha) {
    throw erro(falha && falha.code === 'EEXIST' ? 'PREPARACAO_EXISTENTE' : 'AQUISICAO_FALHOU');
  }

  // Revalidação do que agora é observável; qualquer falha deixa a preparação reservada (sem limpeza) e não devolve montagem.
  try {
    const estado = fs.lstatSync(preparacao);
    if (estado.isSymbolicLink() || !estado.isDirectory() || fs.realpathSync(preparacao) !== preparacao) throw erro('AQUISICAO_FALHOU');
    if (fs.realpathSync(origemDaConfiguracao) !== origemCanonica) throw erro('ORIGEM_INVALIDA');
    if (sobrepostos(origemCanonica, preparacao)) throw erro('ORIGEM_SOBREPOSTA');
  } catch (falha) {
    throw erro(falha && MENSAGENS[falha.code] !== undefined && falha.code !== 'PARAMETROS_INVALIDOS' ? falha.code : 'AQUISICAO_FALHOU');
  }

  try {
    return criarMontagemDeDestinoConfiavel({ preparacao, origem, conjuntoId, maxBytesPorArquivo, ...(temSelagem ? { selagem } : {}), ...(orcamento === null ? {} : { orcamento }) });
  } catch {
    throw erro('AQUISICAO_FALHOU');
  }
}

module.exports = { adquirirPreparacaoExclusiva };
