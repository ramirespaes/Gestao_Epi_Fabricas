'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const token = require('../security/token');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const tentativaRepo = require('../repositories/login-tentativa-plataforma.repository');
const {
  emCooldown,
  instanteDoBanco,
  aplicarCooldown,
  validarTotpDoFator,
} = require('./etapa-mfa-plataforma');

/**
 * Reautenticação de quem já tem sessão plena, para os eventos sensíveis do
 * Painel Privado: senha atual e TOTP atual do fator ATIVO, com o anti-replay
 * do step e o cooldown de MFA do administrador. Usada pela troca do
 * autenticador, pela regeneração dos códigos de recuperação e pela troca de
 * senha.
 *
 * Roda dentro da transação de quem chama. Cada função devolve `{ erro }` para
 * um desfecho de negócio já gravado (quem chama faz o COMMIT e depois lança)
 * ou `{ chave }` quando senha e TOTP conferem.
 */

const sessaoInvalida = () => HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada');
// Senha, TOTP, replay e fator ausente respondem igual: quem tem só a sessão não descobre o que falhou.
const reautenticacaoInvalida = () => HttpError.unauthorized('REAUTENTICACAO_INVALIDA', 'Senha ou código inválidos');

async function sessaoRelida(client, { administradorId, sessaoId, tokenSessao }) {
  if (!token.tokenSessaoTemFormatoValido(tokenSessao)) {
    return null;
  }
  const contexto = await sessaoRepo.buscarValidaPorHash(client, token.hashTokenSessao(tokenSessao), authConfig.sessao.inatividadeMinutos);
  if (contexto === null || contexto.sessao.id !== sessaoId || contexto.administrador.id !== administradorId) {
    return null;
  }
  return contexto;
}

async function falhaDeReautenticacao(client, { administradorId, chave, motivo, origem }) {
  await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: false, motivo, ...origem });
  await aplicarCooldown(client, { administradorId, chave, origem });
  return { erro: reautenticacaoInvalida() };
}

/** Com a trava do administrador já tomada: sessão relida, cooldown de MFA, senha, TOTP do fator ATIVO e step consumido. */
async function reautenticarSobTrava(client, { administradorId, sessaoId, tokenSessao, senha, codigo, origem }) {
  const contexto = await sessaoRelida(client, { administradorId, sessaoId, tokenSessao });
  if (contexto === null) {
    return { erro: sessaoInvalida() };
  }

  const chave = cooldown.gerarChaveCooldownMfaPlataforma(administradorId);
  const vigente = await tentativaRepo.buscarCooldownVigente(client, chave);
  if (vigente !== null) {
    return { erro: emCooldown(vigente.ativoAte) };
  }

  const credencial = await administradorRepo.buscarCredencialPorEmail(client, contexto.administrador.email);
  if (credencial === null || credencial.id !== administradorId || !credencial.ativo) {
    return { erro: sessaoInvalida() };
  }
  if (!(await password.verificarSenha(credencial.senhaHash, senha))) {
    return falhaDeReautenticacao(client, { administradorId, chave, motivo: 'REAUTENTICACAO_INVALIDA', origem });
  }

  const fator = await fatorRepo.buscarTotpAtivo(client, administradorId, { travar: true });
  if (fator === null) {
    return { erro: reautenticacaoInvalida() };
  }
  const agora = await instanteDoBanco(client);
  const aceito = validarTotpDoFator({ administradorId, fator, codigo, agora });
  if (aceito === null) {
    return falhaDeReautenticacao(client, { administradorId, chave, motivo: 'TOTP_INVALIDO', origem });
  }
  if (!(await fatorRepo.registrarStepAceito(client, { administradorId, fatorId: fator.id, step: aceito.step }))) {
    return falhaDeReautenticacao(client, { administradorId, chave, motivo: 'TOTP_REPETIDO', origem });
  }
  return { chave };
}

/** Sob a trava: toma a trava do administrador no MFA e reautentica. */
async function reautenticar(client, dados) {
  await travaRepo.travarAdministrador(client, dados.administradorId);
  return reautenticarSobTrava(client, dados);
}

module.exports = { sessaoInvalida, sessaoRelida, reautenticar, reautenticarSobTrava };
