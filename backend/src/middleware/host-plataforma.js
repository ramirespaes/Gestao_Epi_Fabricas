'use strict';

const { HttpError } = require('../errors/HttpError');
const { httpConfig } = require('../config/http');

/**
 * Validação de Host para o namespace /api/plataforma (Autenticação Global —
 * Pacote 2, adendo v2.1 seção 3).
 *
 * CAMADA ADICIONAL, NUNCA A ÚNICA: host-only cookie + esta validação de Host
 * NÃO substituem a proteção de Origin/Referer (src/middleware/origem.js,
 * instanciada com a allowlist própria da plataforma em app.js) — o adendo
 * v2.1 é explícito sobre isso: `app.` e `admin.` são o MESMO SITE para
 * SameSite, então uma requisição same-site cross-origin não é barrada por
 * SameSite nem por esta checagem de Host sozinha. As três camadas (Host +
 * Origin/Referer específico + CORS por namespace) trabalham juntas.
 *
 * OPCIONAL DE PROPÓSITO: httpConfig.plataforma.host só existe quando
 * PLATAFORMA_HOST está configurado (produção, quando admin.<domínio> for
 * real). Em desenvolvimento/teste, sem a variável, esta função nunca
 * recusa nada — não há subdomínio real para comparar ainda.
 *
 * req.hostname já reflete a configuração de "trust proxy" de app.js (não
 * inclui porta), então não há necessidade de normalizar aqui.
 */
function criarVerificarHostPlataforma({ host }) {
  if (host !== null && typeof host !== 'string') {
    throw new TypeError('host deve ser string ou null');
  }

  return function verificarHostPlataforma(req, res, next) {
    if (host === null || req.hostname === host) {
      next();
      return;
    }
    next(HttpError.notFound());
  };
}

const verificarHostPlataforma = criarVerificarHostPlataforma({ host: httpConfig.plataforma.host });

module.exports = { criarVerificarHostPlataforma, verificarHostPlataforma };
