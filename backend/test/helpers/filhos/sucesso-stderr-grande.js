'use strict';
// Filho de teste (modo: stderr-grande): 400 KiB na saída de erro antes de responder (a saída de erro precisa ser drenada). Ver sucesso-adulterado.js.
require('./sucesso-adulterado').executar('stderr-grande');
