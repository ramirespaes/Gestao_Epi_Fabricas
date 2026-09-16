'use strict';

// Carregado via --require antes de qualquer módulo de teste ou de src/.
// O segredo do HMAC existe SOMENTE em memória durante a execução: gerado a
// cada rodada, nunca lido do .env real nem gravado em disco. Cada arquivo de
// teste roda em processo próprio e herda este ambiente.
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.LOGIN_COOLDOWN_HMAC_SECRET = crypto.randomBytes(32).toString('hex');

// Rate limit praticamente desligado para o app real: a suíte faz muitas
// requisições a /api e o MemoryStore vive enquanto o processo do arquivo de
// teste existir. O contrato do limitador é exercitado com factories de
// limite pequeno em test/middleware/rate-limit.test.js. Infraestrutura da
// suíte apenas: nenhum desvio no código de produção.
process.env.RATE_LIMIT_GERAL_LIMITE = '100000';
process.env.RATE_LIMIT_AUTH_LIMITE = '100000';
