'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');

/**
 * Driver FALSO em memória do armazenamento de imagens, só para os testes (Biblioteca de Imagens, Unidade 1).
 *
 * Serve de calibração do contrato: a mesma suíte (helpers/contrato-armazenamento-imagens.js) roda contra o driver local e
 * contra este. Se um comportamento do contrato não coubesse num armazenamento sem disco, um driver S3 também não o cumpriria.
 * É uma implementação de REFERÊNCIA escrita só com o texto do contrato; não importa nenhum módulo de src/ e valida as chaves
 * com a sua própria expressão regular (oráculo independente da implementação de produção).
 */

const CHAVE = /^(?:[1-9][0-9]{0,14}|padrao)\/[0-9a-f]{64}\/(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)$/;
const PREFIXO = /^(?:[1-9][0-9]{0,14}|padrao)$/;
const SHA = /^[0-9a-f]{64}$/;

const erro = (codigo, mensagem) => Object.assign(new Error(mensagem), { codigo });
const validarChave = (chave) => {
  if (typeof chave !== 'string' || !CHAVE.test(chave)) throw erro('CHAVE_INVALIDA', 'chave de armazenamento inválida');
};

function lerTudo(fonte, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(erro('GRAVACAO_ABORTADA', 'gravação abortada')); return; }
    if (Buffer.isBuffer(fonte)) {
      if (fonte.length > maxBytes) reject(erro('LIMITE_BYTES_EXCEDIDO', 'o conteúdo excede o limite de bytes'));
      else resolve(Buffer.from(fonte));
      return;
    }
    const partes = [];
    let total = 0;
    let fim = false;
    const terminar = (falha, conteudo) => {
      if (fim) return;
      fim = true;
      if (signal) signal.removeEventListener('abort', aoAbortar); // eslint-disable-line no-use-before-define
      if (falha) {
        if (typeof fonte.destroy === 'function') fonte.destroy();
        reject(falha);
      } else resolve(conteudo);
    };
    const aoAbortar = () => terminar(erro('GRAVACAO_ABORTADA', 'gravação abortada'));
    if (signal) {
      if (signal.aborted) { terminar(erro('GRAVACAO_ABORTADA', 'gravação abortada')); return; }
      signal.addEventListener('abort', aoAbortar, { once: true });
    }
    fonte.on('data', (bloco) => {
      total += bloco.length;
      if (total > maxBytes) terminar(erro('LIMITE_BYTES_EXCEDIDO', 'o conteúdo excede o limite de bytes'));
      else partes.push(Buffer.from(bloco));
    });
    fonte.on('end', () => terminar(null, Buffer.concat(partes)));
    fonte.on('error', (falha) => terminar(falha));
    fonte.on('close', () => { if (!fim && !fonte.readableEnded) terminar(erro('GRAVACAO_ABORTADA', 'a fonte foi encerrada antes do fim')); });
  });
}

function criarArmazenamentoMemoriaFalso() {
  const arquivos = new Map();

  async function gravar(chave, fonte, { maxBytes, sha256Esperado, signal } = {}) {
    validarChave(chave);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw erro('LIMITE_OBRIGATORIO', 'informe o limite de bytes da gravação');
    const conteudo = await lerTudo(fonte, maxBytes, signal);
    const sha256 = crypto.createHash('sha256').update(conteudo).digest('hex');
    if (sha256Esperado !== undefined && sha256Esperado !== sha256) throw erro('INTEGRIDADE_DIVERGENTE', 'o SHA-256 do conteúdo não confere com o esperado');
    const existente = arquivos.get(chave);
    if (existente) {
      if (!existente.equals(conteudo)) throw erro('CHAVE_COM_CONTEUDO_DIFERENTE', 'a chave já existe com outro conteúdo');
      return { chave, bytes: conteudo.length, sha256, reaproveitado: true };
    }
    arquivos.set(chave, conteudo);
    return { chave, bytes: conteudo.length, sha256, reaproveitado: false };
  }

  async function abrir(chave) {
    validarChave(chave);
    if (!arquivos.has(chave)) throw erro('ARQUIVO_AUSENTE', 'arquivo indisponível');
    return Readable.from([Buffer.from(arquivos.get(chave))]);
  }

  async function existe(chave) {
    validarChave(chave);
    return arquivos.has(chave);
  }

  async function remover(chave) {
    validarChave(chave);
    arquivos.delete(chave);
  }

  async function removerVariantes({ escopo, empresaId, sha256 } = {}) {
    let prefixo;
    if (escopo === 'EMPRESA' && Number.isSafeInteger(empresaId) && typeof sha256 === 'string' && SHA.test(sha256)) prefixo = `${empresaId}/${sha256}/`;
    else if (escopo === 'PADRAO' && empresaId === undefined && typeof sha256 === 'string' && SHA.test(sha256)) prefixo = `padrao/${sha256}/`;
    if (prefixo === undefined || !CHAVE.test(`${prefixo}mestre.png`)) throw erro('CHAVE_INVALIDA', 'chave de armazenamento inválida');
    for (const chave of [...arquivos.keys()]) if (chave.startsWith(prefixo)) arquivos.delete(chave);
  }

  async function listar(prefixo) {
    if (typeof prefixo !== 'string' || !PREFIXO.test(prefixo)) throw erro('CHAVE_INVALIDA', 'prefixo de armazenamento inválido');
    return [...arquivos.keys()].filter((chave) => chave.startsWith(`${prefixo}/`)).sort();
  }

  return { gravar, abrir, existe, remover, removerVariantes, listar };
}

module.exports = { criarArmazenamentoMemoriaFalso };
