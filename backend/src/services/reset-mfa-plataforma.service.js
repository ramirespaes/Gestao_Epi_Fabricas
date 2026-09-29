'use strict';

const { normalizarEmail } = require('../utils/normalizacao');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../repositories/lote-recuperacao-mfa-plataforma.repository');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria-plataforma.repository');
const liberacaoService = require('./liberacao-cadastro-mfa-plataforma.service');
const { emTransacao } = require('./etapa-mfa-plataforma');

/**
 * Reset operacional do MFA, só por CLI: revoga tudo o que o MFA dava ao
 * administrador (fatores, recovery codes, desafios e sessões) e deixa uma
 * liberação nova para o cadastro seguro. Não cria secret, fator nem sessão,
 * e não mexe na senha nem no estado ativo. Administrador inativo é recusado.
 */

class ErroResetMfa extends Error {
  constructor(motivo) {
    super('reset de MFA recusado');
    this.name = 'ErroResetMfa';
    this.motivo = motivo;
  }
}

/** @returns {Promise<{administradorId: number, codigo: string, expiraEm: Date}>} */
async function redefinirMfa(pool, { email }) {
  const emailNormalizado = normalizarEmail(email);
  if (emailNormalizado === null) {
    throw new ErroResetMfa('EMAIL_INVALIDO');
  }

  return emTransacao(pool, async (client) => {
    const administrador = await administradorRepo.buscarPorEmail(client, emailNormalizado);
    if (administrador === null) {
      throw new ErroResetMfa('ADMINISTRADOR_INEXISTENTE');
    }
    // Conta inativa não pode autenticar: uma liberação para ela seria só um código válido à espera.
    if (!administrador.ativo) {
      throw new ErroResetMfa('ADMINISTRADOR_INATIVO');
    }
    const administradorId = administrador.id;
    await travaRepo.travarAdministrador(client, administradorId);

    let fatores = 0;
    const ativo = await fatorRepo.buscarTotpAtivo(client, administradorId, { travar: true });
    if (ativo !== null && (await fatorRepo.revogar(client, { administradorId, fatorId: ativo.id, motivo: 'RESET_OPERACIONAL' }))) {
      fatores += 1;
    }
    fatores += await fatorRepo.revogarPendenteTotp(client, { administradorId, motivo: 'RESET_OPERACIONAL' });
    const loteRevogado = await loteRepo.revogarAtivo(client, { administradorId, motivo: 'RESET_OPERACIONAL' });
    const desafios = await desafioRepo.encerrarAbertos(client, { administradorId, motivo: 'RESET_OPERACIONAL' });
    const sessoes = await sessaoRepo.revogarTodasDoAdministrador(client, administradorId, 'MFA_RESET_OPERACIONAL');
    const liberacao = await liberacaoService.emitirLiberacaoSobTrava(client, { administradorId, origem: 'CLI_RESET' });

    await auditoriaRepo.registrarOperacaoCli(client, {
      administradorAfetadoId: administradorId, acao: 'MFA_RESET_OPERACIONAL', contexto: { origem: 'CLI_RESET', fatores, desafios, loteRevogado },
    });
    await auditoriaRepo.registrarOperacaoCli(client, {
      administradorAfetadoId: administradorId,
      acao: 'LIBERACAO_CADASTRO_CRIADA',
      referencia: String(liberacao.id),
      contexto: { origem: 'CLI_RESET' },
      dadosNovos: { expiraEm: liberacao.expiraEm.toISOString() },
    });
    await auditoriaRepo.registrarOperacaoCli(client, {
      administradorAfetadoId: administradorId, acao: 'SESSOES_ADMINISTRADOR_REVOGADAS', contexto: { motivo: 'MFA_RESET_OPERACIONAL', quantidade: sessoes },
    });

    return { administradorId, codigo: liberacao.codigo, expiraEm: liberacao.expiraEm };
  });
}

module.exports = { redefinirMfa, ErroResetMfa };
