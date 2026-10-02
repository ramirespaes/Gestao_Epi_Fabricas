'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Marca SafeWork dos e-mails: um PNG pequeno, lido uma vez de um arquivo da
 * própria aplicação e entregue ao transporte como Buffer inline (CID). Nenhum
 * dado de usuário escolhe o caminho ou a URL do que o transporte carrega.
 */

const CID_MARCA = 'marca-safework';
const ARQUIVO = path.join(__dirname, 'assets', 'marca-safework.png');

const MARCA = Object.freeze({
  cid: CID_MARCA,
  filename: 'marca-safework.png',
  contentType: 'image/png',
  content: fs.readFileSync(ARQUIVO),
});

const marca = () => MARCA;

module.exports = { marca, CID_MARCA };
