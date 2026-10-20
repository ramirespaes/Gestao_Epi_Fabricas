'use strict';
// Filho de teste (Unidade 5C-6): imprime o que o processo realmente recebeu — os VALORES das variáveis que o processador define, só os NOMES das demais, as flags do node e a pasta atual.
const DEFINIDAS = ['PATH', 'TMPDIR', 'UV_THREADPOOL_SIZE', 'VIPS_BLOCK_UNTRUSTED', 'MALLOC_ARENA_MAX'];
const valores = {};
for (const chave of DEFINIDAS) valores[chave] = process.env[chave];
process.stdout.write(`${JSON.stringify({ valores, chaves: Object.keys(process.env).sort(), execArgv: process.execArgv, cwd: process.cwd() })}\n`);
