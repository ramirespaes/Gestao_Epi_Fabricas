'use strict';

const sessaoPlataformaRepo = require('../../../src/repositories/sessao-plataforma.repository');
const { gerarTokenSessao, hashTokenSessao } = require('../../../src/security/token');
const { authConfig } = require('../../../src/config/auth');

/**
 * Sessão administrativa já existente, criada pelo repositório, como as que
 * existiam antes do MFA. A senha não cria mais sessão e a conclusão do MFA
 * ainda não existe; é assim que as suítes exercitam as rotas que exigem
 * sessão plena. Só o hash vai ao banco; o token volta pronto para o cookie.
 */
async function criarSessaoAdministrativa(pool, administradorId, { validadeMinutos = 60 } = {}) {
  const token = gerarTokenSessao();
  const id = await sessaoPlataformaRepo.criar(pool, {
    administradorId,
    tokenHash: hashTokenSessao(token),
    expiraEm: new Date(Date.now() + validadeMinutos * 60_000),
  });
  return { id, token, cookie: `${authConfig.sessao.cookieNomeAdmin}=${token}` };
}

module.exports = { criarSessaoAdministrativa };
