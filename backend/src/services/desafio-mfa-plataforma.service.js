'use strict';

const { authConfig } = require('../config/auth');
const token = require('../security/token');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');

/**
 * Desafio pré-MFA do Painel Privado. A senha correta abre um desafio, nunca
 * uma sessão: o token do desafio é aleatório e próprio (mesmo formato do
 * token de sessão, 256 bits), só o SHA-256 vai ao banco e ele nunca é
 * promovido a token de sessão.
 *
 * Limite de desafios abertos por administrador: sob a trava do
 * administrador, encerra os vencidos, e se ainda houver 5 ou mais abertos,
 * encerra os mais antigos até restarem 4; só então cria o novo. Como toda
 * criação passa pela mesma trava, nenhuma transação termina com mais de 5.
 *
 * Repositórios chamados por namespace, para os testes poderem substituí-los.
 */

const LIMITE_DESAFIOS_ABERTOS = 5;

/**
 * Chamado pelo login por senha, dentro da transação dele e depois da trava
 * do e-mail. Com TOTP ativo, VERIFICACAO; sem, LIBERACAO.
 *
 * @returns {Promise<{token: string, desafio: {etapa: string, expiraEm: Date, validadeMinutos: number}}>}
 */
async function abrirDesafioAposSenha(client, { administradorId }) {
  await travaRepo.travarAdministrador(client, administradorId);

  const fatorAtivo = await fatorRepo.buscarTotpAtivo(client, administradorId);
  const etapa = fatorAtivo === null ? 'LIBERACAO' : 'VERIFICACAO';
  const validadeMinutos = etapa === 'VERIFICACAO' ? authConfig.desafioMfa.verificacaoMinutos : authConfig.desafioMfa.cadastroMinutos;

  return criarDesafioSobTrava(client, { administradorId, tipo: etapa, validadeMinutos });
}

/**
 * Cria um desafio aplicando o limite de abertos. Pré-condição: a trava do
 * administrador já foi tomada nesta transação (login por senha ou etapa do
 * MFA que encerra um desafio e abre o seguinte).
 */
async function criarDesafioSobTrava(client, {
  administradorId, tipo, validadeMinutos, fatorPendenteId = null, desafioAnteriorId = null,
}) {
  await desafioRepo.encerrarExpirados(client, administradorId);
  const abertos = await desafioRepo.listarAbertos(client, administradorId, { travar: true });
  if (abertos.length >= LIMITE_DESAFIOS_ABERTOS) {
    await desafioRepo.encerrarMaisAntigos(client, {
      administradorId, manterAbertos: LIMITE_DESAFIOS_ABERTOS - 1, motivo: 'LIMITE_DESAFIOS',
    });
  }

  const tokenClaro = token.gerarTokenSessao();
  const criado = await desafioRepo.criar(client, {
    administradorId, tokenHash: token.hashTokenSessao(tokenClaro), tipo, validadeMinutos, fatorPendenteId, desafioAnteriorId,
  });

  return { token: tokenClaro, desafio: { etapa: tipo, expiraEm: criado.expiraEm, validadeMinutos } };
}

/**
 * Logout: encerra com LOGOUT o desafio deste token, se ainda estiver aberto.
 * Token fora do formato não vai ao banco. Devolve se encerrou algum.
 */
async function encerrarDesafioPorToken(executor, tokenClaro) {
  if (!token.tokenSessaoTemFormatoValido(tokenClaro)) {
    return false;
  }
  const desafio = await desafioRepo.buscarPorHash(executor, token.hashTokenSessao(tokenClaro));
  if (desafio === null || desafio.encerradoEm !== null) {
    return false;
  }
  return desafioRepo.encerrar(executor, { desafioId: desafio.id, motivo: 'LOGOUT' });
}

module.exports = { abrirDesafioAposSenha, criarDesafioSobTrava, encerrarDesafioPorToken };
