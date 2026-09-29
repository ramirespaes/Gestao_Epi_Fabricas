'use strict';

const { authConfig } = require('../config/auth');
const token = require('../security/token');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const { emTransacao } = require('./etapa-mfa-plataforma');

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
  administradorId, tipo, validadeMinutos, fatorPendenteId = null, desafioAnteriorId = null, sessaoOrigemId = null,
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
    administradorId, tokenHash: token.hashTokenSessao(tokenClaro), tipo, validadeMinutos, fatorPendenteId, desafioAnteriorId, sessaoOrigemId,
  });

  return { token: tokenClaro, desafio: { etapa: tipo, expiraEm: criado.expiraEm, validadeMinutos } };
}

const concluidoComSessao = (desafio) => desafio.motivoEncerramento === 'CONCLUIDO' && desafio.sessaoCriadaId !== null;

/**
 * Logout: encerra com LOGOUT o desafio deste token, se ainda estiver aberto,
 * e revoga como ABANDONADO o PENDENTE ligado a ele. Se o desafio já foi
 * concluído com sessão criada, revoga só essa sessão. Token fora do formato
 * não vai ao banco. Devolve se encerrou ou revogou algo.
 */
async function encerrarDesafioPorToken(pool, tokenClaro) {
  if (!token.tokenSessaoTemFormatoValido(tokenClaro)) {
    return false;
  }
  const tokenHash = token.hashTokenSessao(tokenClaro);
  const desafio = await desafioRepo.buscarPorHash(pool, tokenHash);
  if (desafio === null || (desafio.encerradoEm !== null && !concluidoComSessao(desafio))) {
    return false;
  }

  return emTransacao(pool, async (client) => {
    // Relido sob a trava: a confirmação pode ter concluído o desafio e criado a sessão enquanto o logout esperava.
    await travaRepo.travarAdministrador(client, desafio.administradorId);
    const atual = await desafioRepo.buscarPorHash(client, tokenHash);
    if (concluidoComSessao(atual)) {
      return sessaoRepo.revogar(client, atual.sessaoCriadaId, 'LOGOUT');
    }
    if (!(await desafioRepo.encerrar(client, { desafioId: atual.id, motivo: 'LOGOUT' }))) {
      return false;
    }
    if (atual.fatorPendenteId !== null) {
      const fator = await fatorRepo.buscarPorId(client, { administradorId: atual.administradorId, fatorId: atual.fatorPendenteId }, { travar: true });
      if (fator !== null && fator.estado === 'PENDENTE') {
        await fatorRepo.revogar(client, { administradorId: atual.administradorId, fatorId: fator.id, motivo: 'ABANDONADO' });
      }
    }
    return true;
  });
}

module.exports = { abrirDesafioAposSenha, criarDesafioSobTrava, encerrarDesafioPorToken };
