'use strict';

const alertaRepo = require('../repositories/alerta-estoque.repository');
const autorizacao = require('../middleware/autorizacao');
const { normalizarEmail } = require('../utils/normalizacao');

/**
 * Destinatários dos alertas de estoque (12G-6), resolvidos no momento do
 * envio: usuário ativo, da empresa ativa, com e-mail de conta utilizável e
 * com a ação EFETIVA pela mesma avaliação das rotas (perfil, grupo, exceção
 * individual e bloqueio), nunca pelo nome do perfil. Com `exigirSst`, só quem
 * tem vínculo SST, MASTER incluído.
 *
 * @returns {Promise<Array<{id: number, email: string}>>}
 */
async function contasComAcao(executor, empresaId, { acao, exigirSst }) {
  const contas = await alertaRepo.listarContasDaEmpresa(executor, { empresaId, exigirSst });
  const vistos = new Set();
  const destinatarios = [];
  for (const conta of contas) {
    const email = normalizarEmail(conta.email);
    if (email === null || vistos.has(email)) continue;
    if (await autorizacao.avaliarPermissaoAcao(executor, { empresaId, usuarioId: conta.id, perfil: conta.perfil }, acao)) {
      vistos.add(email);
      destinatarios.push({ id: conta.id, email });
    }
  }
  return destinatarios;
}

module.exports = { contasComAcao };
