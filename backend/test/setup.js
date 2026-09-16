'use strict';

// Carregado via --require antes de qualquer módulo de teste ou de src/.
// O segredo do HMAC existe SOMENTE em memória durante a execução: gerado a
// cada rodada, nunca lido do .env real nem gravado em disco. Cada arquivo de
// teste roda em processo próprio e herda este ambiente.
const crypto = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.LOGIN_COOLDOWN_HMAC_SECRET = crypto.randomBytes(32).toString('hex');
