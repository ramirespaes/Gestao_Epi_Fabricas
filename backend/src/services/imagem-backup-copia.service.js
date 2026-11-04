'use strict';

const { ehOrcamentoDeBytes } = require('../utils/orcamento-de-bytes');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN-COPIA-VERIFICADA-1): CÓPIA VERIFICADA das imagens do plano para uma área de preparação isolada. Contrato PROVISÓRIO: `origem` e
 * `destino` são instâncias do armazenamento de imagens (`abrir`, `existe`, `gravar`), injetadas só para este contrato e os testes (D8). Este módulo não faz E/S própria, não cria manifesto, não
 * publica o conjunto e uma cópia concluída NÃO é prova de restauração.
 *
 * `criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo })` -> `copia(contexto)` assíncrona, que usa diretamente `contexto.plano` (itens `{ chave, sha256 }`, sem segunda representação).
 * Resultado congelado `{ ok, completo, arquivos, copiados, falha }`: em sucesso, `arquivos` = [{ chave, sha256, bytes }] na ordem do plano, com o SHA-256 e os bytes RECALCULADOS pelo `gravar`
 * sobre os bytes efetivamente gravados; em falha, `arquivos` é [] e `falha` = { codigo, chave | null } com código FIXO (PLANO_INVALIDO, ORIGEM_AUSENTE, ORIGEM_INVALIDA, DESTINO_INVALIDO,
 * DESTINO_EXISTENTE, INTEGRIDADE_DIVERGENTE, LIMITE_EXCEDIDO, LIMITE_TOTAL_EXCEDIDO (só com `orcamento`), CANCELADO (só com `sinal` abortado; P3), COPIA_FALHOU), nunca caminho, temporário, mensagem de dependência nem conteúdo.
 *
 * Regras: o plano inteiro é validado ANTES de qualquer E/S (forma, chave no formato do armazenamento, hash de 64 hex, sem chave repetida); plano vazio é legítimo; os itens seguem a ordem do plano e
 * a cópia PARA no primeiro erro. A integridade é a conferência do SHA-256 dos bytes GRAVADOS contra o esperado (feita pelo `gravar`); o hash declarado pelo banco nunca basta.
 *
 * DESTINO EXISTENTE sem falsa garantia de atomicidade: `existe()` é só uma recusa antecipada, NÃO uma garantia. A evidência confiável de CRIAÇÃO é o retorno de `gravar()`: ele publica por `link`, que
 * falha atomicamente se o nome já existe; chave existente com os mesmos bytes volta com `reaproveitado: true` (arquivo preexistente intacto) e com bytes diferentes lança CHAVE_COM_CONTEUDO_DIFERENTE. Só
 * `reaproveitado === false` conta como "criado por esta operação"; qualquer outro caso é DESTINO_EXISTENTE (nada é sobrescrito, removido nem reaproveitado para declarar cópia nova).
 *
 * LIMITE DE TAMANHO: imposto pelo `gravar` (`maxBytes`) durante a leitura em blocos: nenhum arquivo inteiro é alocado, e a leitura é interrompida ao exceder o limite (no máximo um bloco além). A interface
 * de `abrir` só entrega um fluxo, sem tamanho prévio, então o tamanho NÃO é conhecido antes de ler: o limite é aplicado em fluxo, não antecipado.
 *
 * FALHAS PARCIAIS: o temporário de uma gravação falha é removido pelo próprio `gravar` (só o seu); itens anteriores já publicados e verificados NÃO são apagados (nenhuma exclusão genérica), mas o
 * resultado não é completo, `arquivos` fica vazio e nada é publicado: arquivo individual verificado ≠ conjunto completo ≠ backup publicado ≠ backup recuperável.
 * LIMITES: a proteção contra links é a do armazenamento (`lstat` por componente e O_NOFOLLOW só no arquivo final): uma troca concorrente de diretório intermediário não é excluída (sem `openat` no Node);
 * o snapshot do PostgreSQL não congela arquivos, e a trava de escrita ainda não cobre todos os escritores. Publicação atômica, manifesto e descarte da preparação são incrementos futuros.
 */

const CHAVE = /^(?:[1-9][0-9]{0,14}|padrao)\/[0-9a-f]{64}\/(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const OPCOES = ['origem', 'destino', 'maxBytesPorArquivo'];
const OPCOES_OPCIONAIS = ['orcamento'];

const ehObjeto = (valor) => valor !== null && typeof valor === 'object' && !Array.isArray(valor);
const ehFuncao = (valor) => typeof valor === 'function';
const chavesExatas = (objeto, esperadas) => {
  const proprias = Reflect.ownKeys(objeto);
  return proprias.length === esperadas.length && proprias.every((chave) => typeof chave === 'string' && esperadas.includes(chave));
};

function resultado({ ok, arquivos = [], copiados = 0, falha = null }) {
  return Object.freeze({ ok, completo: ok, arquivos: Object.freeze(arquivos.map((a) => Object.freeze({ ...a }))), copiados, falha });
}
const falhou = (codigo, chave, copiados) => resultado({ ok: false, copiados, falha: Object.freeze({ codigo, chave: chave ?? null }) });

/** Valida e COPIA o plano numa passada (cada propriedade lida uma vez); null se qualquer coisa estiver fora do formato. */
function capturarPlano(contexto) {
  try {
    if (!ehObjeto(contexto)) return null;
    const plano = contexto.plano;
    if (!Array.isArray(plano)) return null;
    const itens = [];
    const vistas = new Set();
    for (let i = 0; i < plano.length; i += 1) {
      const item = plano[i];
      if (!ehObjeto(item) || !chavesExatas(item, ['chave', 'sha256'])) return null;
      const { chave, sha256 } = item;
      if (typeof chave !== 'string' || !CHAVE.test(chave) || typeof sha256 !== 'string' || !SHA256.test(sha256) || vistas.has(chave)) return null;
      vistas.add(chave);
      itens.push({ chave, sha256 });
    }
    return itens;
  } catch {
    return null;
  }
}

/** Código do armazenamento (lido uma vez, sob proteção) ou null. */
function codigoDe(falha) {
  try {
    return falha !== null && typeof falha === 'object' && typeof falha.codigo === 'string' ? falha.codigo : null;
  } catch {
    return null;
  }
}

function criarCopiaDeImagens(opcoes) {
  if (!ehObjeto(opcoes)) throw new TypeError('opções da cópia inválidas');
  const proprias = Reflect.ownKeys(opcoes);
  if (!proprias.every((k) => typeof k === 'string' && (OPCOES.includes(k) || OPCOES_OPCIONAIS.includes(k))) || !OPCOES.every((k) => proprias.includes(k))) throw new TypeError('opções da cópia inválidas');
  const { origem, destino, maxBytesPorArquivo } = opcoes;
  // P4 (opcional): orçamento de bytes da execução, compartilhado com a captura do dump; o `maxBytes` de cada arquivo passa a ser min(limite por arquivo, saldo), aplicado pelo `gravar` DURANTE a leitura
  const orcamento = proprias.includes('orcamento') ? opcoes.orcamento : null;
  if (orcamento !== null && !ehOrcamentoDeBytes(orcamento)) throw new TypeError('orçamento inválido');
  if (!ehObjeto(origem) || !ehObjeto(destino)) throw new TypeError('armazenamento inválido');
  const abrir = origem.abrir;
  const existe = destino.existe;
  const gravar = destino.gravar;
  if (!ehFuncao(abrir) || !ehFuncao(existe) || !ehFuncao(gravar)) throw new TypeError('armazenamento inválido');
  if (!Number.isSafeInteger(maxBytesPorArquivo) || maxBytesPorArquivo <= 0) throw new TypeError('limite de bytes inválido');

  return async function copia(contexto, execucao) {
    const plano = capturarPlano(contexto);
    if (plano === null) return falhou('PLANO_INVALIDO', null, 0);
    // P3 (opcional): `execucao.sinal` é um PEDIDO de cancelamento cooperativo. Pontos seguros: antes de cada item e DURANTE a gravação (o `gravar` do armazenamento já aceita `signal`). Nada é apagado: os itens já publicados ficam, o temporário da gravação interrompida é removido pelo próprio `gravar`.
    const sinal = execucao !== null && typeof execucao === 'object' && execucao.sinal !== undefined ? execucao.sinal : null;

    const copiados = [];
    for (const item of plano) {
      const { chave, sha256 } = item;
      if (sinal !== null && sinal.aborted === true) return falhou('CANCELADO', chave, copiados.length);

      // Recusa antecipada (NÃO é garantia): o destino já tem a chave. Chave inválida/link no destino é DESTINO_INVALIDO.
      try {
        if ((await existe.call(destino, chave)) === true) return falhou('DESTINO_EXISTENTE', chave, copiados.length);
      } catch (falha) {
        return falhou(codigoDe(falha) === 'CHAVE_INVALIDA' ? 'DESTINO_INVALIDO' : 'COPIA_FALHOU', chave, copiados.length);
      }

      // saldo do orçamento ANTES de abrir a fonte: sem saldo nada é lido nem gravado (um arquivo de imagem nunca tem 0 byte)
      const saldo = orcamento === null ? maxBytesPorArquivo : orcamento.restante();
      if (saldo <= 0) return falhou('LIMITE_TOTAL_EXCEDIDO', chave, copiados.length);
      const limiteDoArquivo = Math.min(maxBytesPorArquivo, saldo);

      let fonte;
      try {
        fonte = await abrir.call(origem, chave);
      } catch (falha) {
        const codigo = codigoDe(falha);
        if (codigo === 'ARQUIVO_AUSENTE') return falhou('ORIGEM_AUSENTE', chave, copiados.length);
        return falhou(codigo === 'CHAVE_INVALIDA' ? 'ORIGEM_INVALIDA' : 'COPIA_FALHOU', chave, copiados.length);
      }

      let gravado;
      try {
        gravado = await gravar.call(destino, chave, fonte, { maxBytes: limiteDoArquivo, sha256Esperado: sha256, ...(sinal === null ? {} : { signal: sinal }) });
      } catch (falha) {
        const codigo = codigoDe(falha);
        // o armazenamento usa GRAVACAO_ABORTADA também para falha de leitura: só é cancelamento se o sinal DESTA operação está de fato abortado
        if (codigo === 'GRAVACAO_ABORTADA' && sinal !== null && sinal.aborted === true) return falhou('CANCELADO', chave, copiados.length);
        if (codigo === 'INTEGRIDADE_DIVERGENTE') return falhou('INTEGRIDADE_DIVERGENTE', chave, copiados.length);
        if (codigo === 'LIMITE_BYTES_EXCEDIDO') return falhou(limiteDoArquivo < maxBytesPorArquivo ? 'LIMITE_TOTAL_EXCEDIDO' : 'LIMITE_EXCEDIDO', chave, copiados.length);
        if (codigo === 'CHAVE_COM_CONTEUDO_DIFERENTE') return falhou('DESTINO_EXISTENTE', chave, copiados.length);
        if (codigo === 'CHAVE_INVALIDA') return falhou('DESTINO_INVALIDO', chave, copiados.length);
        return falhou('COPIA_FALHOU', chave, copiados.length);
      } finally {
        try { if (ehObjeto(fonte) && ehFuncao(fonte.destroy)) fonte.destroy(); } catch { /* o fluxo já pode estar encerrado */ }
      }

      // Só `reaproveitado === false` prova que ESTA operação criou o arquivo; os bytes e o hash gravados precisam bater com o plano.
      if (!ehObjeto(gravado) || gravado.reaproveitado !== false) return falhou('DESTINO_EXISTENTE', chave, copiados.length);
      if (gravado.sha256 !== sha256) return falhou('INTEGRIDADE_DIVERGENTE', chave, copiados.length);
      if (!Number.isSafeInteger(gravado.bytes) || gravado.bytes < 0) return falhou('COPIA_FALHOU', chave, copiados.length);
      // contagem EXATA dos bytes gravados (o `maxBytes` acima já impede que passe do saldo; a reserva abaixo é a contabilidade e a defesa em profundidade)
      if (orcamento !== null && orcamento.reservar(gravado.bytes).ok !== true) return falhou('LIMITE_TOTAL_EXCEDIDO', chave, copiados.length);
      copiados.push({ chave, sha256: gravado.sha256, bytes: gravado.bytes });
    }

    return resultado({ ok: true, arquivos: copiados, copiados: copiados.length });
  };
}

module.exports = { criarCopiaDeImagens };
