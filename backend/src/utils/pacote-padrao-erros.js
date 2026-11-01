'use strict';

/**
 * Erro da importação da biblioteca padrão: `codigo` estável e `detalhes` estruturados. A mensagem é FIXA por código e nunca leva caminho, hash,
 * nome cru de entrada ou valor recebido; o que identifica o problema vai em `detalhes`, já em forma imprimível (ver `nomeSeguro`).
 */

const MENSAGENS = Object.freeze({
  PACOTE_ARGUMENTOS_INVALIDOS: 'argumentos inválidos',
  PACOTE_INDISPONIVEL: 'o pacote não está disponível para leitura',
  PACOTE_SHA256_DIVERGENTE: 'o SHA-256 do pacote não confere com o aprovado',
  PLANO_INDISPONIVEL: 'o plano de pacotes aprovados não está disponível para leitura',
  PLANO_SHA256_DIVERGENTE: 'o SHA-256 do plano de pacotes não confere com o aprovado',
  PLANO_INVALIDO: 'o plano de pacotes aprovados é inválido',
  PACOTE_INVALIDO: 'a estrutura do pacote é inválida ou insegura',
  PACOTE_MANIFESTO_INVALIDO: 'o manifesto do pacote é inválido',
  PACOTE_ARQUIVO_AUSENTE: 'há arquivos do manifesto ausentes do pacote',
  PACOTE_HASH_DIVERGENTE: 'há arquivos que não conferem com o manifesto',
  IMAGEM_PADRAO_INVALIDA: 'há imagens com formato inválido',
  MAPEAMENTO_INDISPONIVEL: 'o mapeamento não está disponível para leitura',
  MAPEAMENTO_INVALIDO: 'o mapeamento é inválido',
  ESTADO_DIVERGENTE: 'o banco ou o armazenamento já contêm dados que divergem do pacote',
  DESTINO_NAO_AUTORIZADO: 'o destino da importação não está autorizado',
  IMPORTACAO_EM_ANDAMENTO: 'outra importação da biblioteca padrão está em andamento',
  IMPORTACAO_FALHOU: 'falha ao importar a biblioteca padrão',
});

const MAX_DETALHES = 200;
const MAX_NOME = 160;
const A_ESCAPAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}�]/gu;

class ErroImportacaoPadrao extends Error {
  constructor(codigo, detalhes = [], opcoes = undefined) {
    if (!Object.hasOwn(MENSAGENS, codigo)) throw new TypeError('código de erro desconhecido');
    super(MENSAGENS[codigo], opcoes);
    this.name = 'ErroImportacaoPadrao';
    this.codigo = codigo;
    this.detalhes = Object.freeze(detalhes.slice(0, MAX_DETALHES).map((detalhe) => Object.freeze({ ...detalhe })));
  }
}

/** Texto imprimível de um nome vindo do pacote: controles, formatação bidirecional e bytes inválidos viram \uXXXX; nunca quebra linha nem comanda o terminal. */
function nomeSeguro(nome) {
  const texto = Buffer.isBuffer(nome) ? nome.toString('utf8') : String(nome);
  const escapado = texto.replace(A_ESCAPAR, (c) => {
    const ponto = c.codePointAt(0);
    return ponto > 0xffff ? `\\u{${ponto.toString(16)}}` : `\\u${ponto.toString(16).padStart(4, '0')}`;
  });
  const pontos = Array.from(escapado);
  return pontos.length > MAX_NOME ? `${pontos.slice(0, MAX_NOME).join('')}…` : escapado;
}

module.exports = { ErroImportacaoPadrao, MENSAGENS, MAX_DETALHES, nomeSeguro };
