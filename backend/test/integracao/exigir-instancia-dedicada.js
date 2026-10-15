'use strict';

// Carregado com --require DEPOIS de dotenv/config e ANTES de qualquer teste ou helper. Não abre conexão. Falha fechada: qualquer
// divergência encerra o processo (código 1). Lê só IDENTIDADE e SYSTEM_ID (não secretos); nunca lê nem imprime senha.
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const guarda = require('./helpers/guarda-instancia-dedicada');

const RAIZ = '/Users/ramirespaes/PostgresTeste/j2a';
const VERSAO_PG_ESPERADA = '8.23.0';
const aoFalhar = (motivo) => { process.stderr.write(`GUARDA J2a: ${motivo}\n`); process.exit(1); };

const motivoAmbiente = guarda.validarAmbiente(process.env, process.execArgv, `${RAIZ}/segredos/ambiente-teste.env`);
if (motivoAmbiente !== null) aoFalhar(motivoAmbiente);

const pg = require('pg');
const versaoDoPg = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('pg')), '..', 'package.json'), 'utf8')).version;
if (versaoDoPg !== VERSAO_PG_ESPERADA) aoFalhar('versão do driver pg diferente da validada para a guarda');

const lerArquivo = (nome) => fs.readFileSync(`${RAIZ}/${nome}`, 'utf8').trim();
let marcador;
try { marcador = guarda.marcadorEsperado(lerArquivo('IDENTIDADE'), lerArquivo('SYSTEM_ID')); } catch (_) { aoFalhar('IDENTIDADE ou SYSTEM_ID ausente ou inválido'); }

guarda.instalarGuarda({ pg, net, alvo: guarda.ALVO, marcador, aoFalhar });
globalThis.__GEPI_GUARDA_J2A__ = Object.freeze({ versao: 1 });
