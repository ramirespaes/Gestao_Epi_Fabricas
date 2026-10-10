'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Writable } = require('node:stream');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');

/**
 * Armazenamento local do ZIP da fiscalização (12K-D6), atrás de uma interface que um driver S3 também implementaria:
 *   iniciar({ empresaId, pacoteId }) -> { chave, escrita, publicar(), abortar() }
 *   abrir(chave) | existe(chave) | remover(chave) | removerResiduos({ empresaId, pacoteId })
 *
 * - A chave é montada SÓ com inteiros do servidor ("<empresa>/pacote-<id>.zip"); texto do cliente nunca entra no caminho.
 * - Toda chave recebida é conferida contra esse formato e o caminho resolvido tem de ficar dentro da raiz (path traversal).
 * - A escrita vai para um temporário e só é publicada no destino por link, que NUNCA sobrescreve (EEXIST). O SHA-256 e o
 *   tamanho são calculados durante a escrita e o arquivo é sincronizado em disco antes de publicar.
 * - O diretório e as pastas das empresas ficam só do dono (0700) e os arquivos 0600.
 */

const CHAVE_FORMATO = /^([1-9][0-9]{0,14})\/pacote-([1-9][0-9]{0,14})\.zip$/;
const INTEIRO_SEGURO = (n) => Number.isSafeInteger(n) && n > 0;

function erroChave() {
  return new Error('chave de armazenamento inválida');
}

function criarArmazenamentoLocal({ diretorio } = {}) {
  if (typeof diretorio !== 'string' || diretorio.trim() === '') throw new TypeError('diretório de armazenamento obrigatório');
  if (!path.isAbsolute(diretorio)) throw new TypeError('o diretório de armazenamento deve ser um caminho absoluto');
  const raiz = path.resolve(diretorio);
  fs.mkdirSync(raiz, { recursive: true, mode: 0o700 });

  const chaveDe = (empresaId, pacoteId) => {
    if (!INTEIRO_SEGURO(empresaId) || !INTEIRO_SEGURO(pacoteId)) throw erroChave();
    return `${empresaId}/pacote-${pacoteId}.zip`;
  };
  const caminhoDaChave = (chave) => {
    if (typeof chave !== 'string' || !CHAVE_FORMATO.test(chave)) throw erroChave();
    const absoluto = path.resolve(raiz, chave);
    if (!absoluto.startsWith(raiz + path.sep)) throw erroChave();
    return absoluto;
  };
  const temporarioDe = (empresaId, pacoteId) => path.join(path.dirname(caminhoDaChave(chaveDe(empresaId, pacoteId))), `pacote-${pacoteId}.tmp`);
  const tolerarAusente = async (acao) => {
    try { await acao(); } catch (erro) { if (erro.code !== 'ENOENT') throw erro; }
  };

  async function iniciar({ empresaId, pacoteId } = {}) {
    const chave = chaveDe(empresaId, pacoteId);
    const destino = caminhoDaChave(chave);
    const temporario = temporarioDe(empresaId, pacoteId);
    await fsp.mkdir(path.dirname(destino), { recursive: true, mode: 0o700 });
    const arquivo = fs.createWriteStream(temporario, { flags: 'wx', mode: 0o600 });
    await once(arquivo, 'open');
    const hash = crypto.createHash('sha256');
    let tamanho = 0;
    let encerrado = false;

    const escrita = new Writable({
      write(bloco, _codificacao, proximo) {
        hash.update(bloco);
        tamanho += bloco.length;
        arquivo.write(bloco, proximo);
      },
      final(proximo) { arquivo.end(proximo); },
      destroy(erro, proximo) {
        if (!arquivo.destroyed) arquivo.destroy();
        proximo(erro);
      },
    });
    arquivo.on('error', (erro) => escrita.destroy(erro));

    async function abortar() {
      if (encerrado) return;
      encerrado = true;
      if (!escrita.destroyed) escrita.destroy();
      await tolerarAusente(() => fsp.rm(temporario, { force: false }));
    }

    async function publicar() {
      if (encerrado) throw new Error('escrita já encerrada');
      if (!escrita.writableEnded) escrita.end();
      try {
        await finished(escrita);
        const fd = await fsp.open(temporario, 'r');
        try { await fd.sync(); } finally { await fd.close(); }
        await fsp.link(temporario, destino);
      } catch (erro) {
        await abortar();
        if (erro.code === 'EEXIST') throw new Error('o arquivo já existe: sobrescrever não é permitido (EEXIST)');
        throw erro;
      }
      encerrado = true;
      await fsp.rm(temporario, { force: true });
      return { chave, tamanhoBytes: tamanho, sha256: hash.digest('hex') };
    }

    return { chave, escrita, publicar, abortar };
  }

  async function abrir(chave) {
    const caminho = caminhoDaChave(chave);
    try { await fsp.access(caminho, fs.constants.R_OK); } catch (erro) {
      const falha = new Error('arquivo do pacote indisponível');
      falha.codigo = 'ARQUIVO_AUSENTE';
      throw falha;
    }
    return fs.createReadStream(caminho);
  }

  async function existe(chave) {
    const caminho = caminhoDaChave(chave);
    try { await fsp.access(caminho); return true; } catch { return false; }
  }

  async function remover(chave) {
    const caminho = caminhoDaChave(chave);
    await tolerarAusente(() => fsp.rm(caminho, { force: false }));
  }

  /** Apaga o temporário e o arquivo final órfãos de um pacote (geração abandonada). */
  async function removerResiduos({ empresaId, pacoteId }) {
    await tolerarAusente(() => fsp.rm(temporarioDe(empresaId, pacoteId), { force: false }));
    await remover(chaveDe(empresaId, pacoteId));
  }

  return { iniciar, abrir, existe, remover, removerResiduos };
}

module.exports = { criarArmazenamentoLocal };
