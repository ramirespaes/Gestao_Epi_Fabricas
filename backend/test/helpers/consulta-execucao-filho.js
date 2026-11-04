'use strict';

// Processo NOVO (simula reinício): consulta uma identidade de execução emitida por outro processo. Sem rede, banco ou arquivos.
const { REGISTRO_DE_EXECUCOES } = require('../../src/services/imagem-backup-execucoes.service');

const id = process.argv[2];
process.stdout.write(JSON.stringify({ estado: REGISTRO_DE_EXECUCOES.estado(id), resultado: REGISTRO_DE_EXECUCOES.resultado(id), concluiu: REGISTRO_DE_EXECUCOES.concluir(id, Object.freeze({ reconhecida: true })), tamanho: REGISTRO_DE_EXECUCOES.tamanho() }));
