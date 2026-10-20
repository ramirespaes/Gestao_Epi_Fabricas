'use strict';
// Filho de teste: imprime o que o processo realmente recebeu (nomes das variáveis de ambiente, argumentos, flags do node e pasta atual).
process.stdout.write(`${JSON.stringify({ chaves: Object.keys(process.env).sort(), argv: process.argv.slice(2), execArgv: process.execArgv, cwd: process.cwd() })}\n`);
