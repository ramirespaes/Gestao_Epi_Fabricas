'use strict';
// Filho de teste: responde com lixo que não é um quadro, e sai com sucesso.
process.stdin.on('data', () => {});
process.stdin.on('end', () => { process.stdout.write(Buffer.from('isto nao e um quadro valido de resposta'), () => process.exit(0)); });
