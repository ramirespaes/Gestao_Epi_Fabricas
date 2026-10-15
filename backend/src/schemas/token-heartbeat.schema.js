'use strict';

const { z } = require('zod');

/**
 * Atendimento Token — heartbeat do tablet (Etapa J, J2a). Corpo e query vazios e estritos: empresa, tablet, credencial e
 * qualquer campo extra NUNCA vêm do cliente (a identidade vem só do cookie do tablet, pela autenticação existente).
 * A ordem entre autenticação e validação fica para a integração da rota.
 */

const heartbeat = {
  body: z.strictObject({}),
  query: z.strictObject({}),
};

module.exports = { heartbeat };
