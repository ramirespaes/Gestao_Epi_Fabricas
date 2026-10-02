'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { erroDeArquivo } = require('../erros');
const { marca, CID_MARCA } = require('../marca');

/**
 * Grava a mensagem em arquivo, só para desenvolvimento e teste: o TXT leva
 * Para, Assunto e o texto; o HTML irmão serve à revisão visual e leva a marca
 * embutida no lugar do CID. Os arquivos ficam restritos ao dono, num
 * diretório fora do repositório (garantido pela configuração), e não levam
 * dado do usuário no nome.
 */

const ETIQUETA = /[^a-z0-9_]/g;

function criarArquivo(config) {
  const { diretorio } = config.arquivo ?? {};
  if (typeof diretorio !== 'string') {
    throw new TypeError('diretório do modo arquivo ausente');
  }
  const marcaEmbutida = `data:${marca().contentType};base64,${marca().content.toString('base64')}`;

  async function gravar(base, extensao, conteudo) {
    await fs.writeFile(path.join(diretorio, `${base}.${extensao}`), conteudo, { mode: 0o600, flag: 'wx' });
  }

  return {
    modo: 'arquivo',
    async enviar({ tipo, escopo, para, assunto, texto, html }) {
      try {
        await fs.mkdir(diretorio, { recursive: true, mode: 0o700 });
        const instante = new Date().toISOString().replace(/[-:.]/g, '');
        const base = `${instante}-${String(tipo).toLowerCase().replace(ETIQUETA, '')}-${String(escopo).toLowerCase().replace(ETIQUETA, '')}-${crypto.randomBytes(6).toString('hex')}`;
        await gravar(base, 'txt', `Para: ${para}\nAssunto: ${assunto}\n\n${texto}`);
        await gravar(base, 'html', html.split(`cid:${CID_MARCA}`).join(marcaEmbutida));
        return { estado: 'GRAVADO' };
      } catch (erro) {
        throw erroDeArquivo(erro);
      }
    },
    fechar() {},
  };
}

module.exports = { criarArquivo };
