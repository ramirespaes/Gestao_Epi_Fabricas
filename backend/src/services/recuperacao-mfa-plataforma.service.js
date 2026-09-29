'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const codigosMfa = require('../security/codigos-mfa');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const loteRepo = require('../repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../repositories/codigo-recuperacao-mfa-plataforma.repository');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria-plataforma.repository');
const tentativaRepo = require('../repositories/login-tentativa-plataforma.repository');
const desafioService = require('./desafio-mfa-plataforma.service');
const {
  desafioInvalido,
  codigoInvalido,
  executarEtapa,
  exigirChaveAtual,
  abrirEtapa,
  instanteDoBanco,
  registrarFalha,
  novoSegredoCifrado,
  entregaDoCadastro,
  origemDa,
  emitirLoteRecuperacao,
  validarTotpDoFator,
  criarSessaoPlena,
} = require('./etapa-mfa-plataforma');

/**
 * Recuperação com recovery code:
 *
 *   VERIFICACAO --(recovery code)--> RECUPERACAO --(novo TOTP)--> sessão plena
 *
 * O recovery code nunca autentica: só autoriza cadastrar um fator novo. A
 * sessão nasce depois do novo TOTP, com todas as sessões antigas revogadas.
 */

const cadastroExpirado = () => HttpError.conflict('MFA_CADASTRO_EXPIRADO', 'O cadastro expirou. Gere um novo código ou entre de novo com a senha');

/**
 * VERIFICACAO -> RECUPERACAO. O código é localizado com trava e só consumido
 * depois de o PENDENTE novo existir; o fator antigo continua ATIVO.
 *
 * @returns {Promise<{token: string, desafio: object, cadastro: {uri: string, chaveManual: string}}>}
 */
async function iniciarRecuperacao(pool, dados) {
  const { desafioId, administradorId, codigoRecuperacao } = dados;
  const origem = origemDa(dados);
  // Basta a chave atual, para cifrar o fator novo; o antigo não é decifrado.
  await exigirChaveAtual(pool, administradorId, 'recuperacao');

  return executarEtapa(pool, { administradorId, operacao: 'recuperacao' }, async (client) => {
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipos: ['VERIFICACAO'] });
    if (etapa.erro) return etapa;
    const { desafio, chave } = etapa;

    if ((await fatorRepo.buscarTotpAtivo(client, administradorId)) === null) {
      await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'SEM_FATOR_ATIVO' });
      return { erro: desafioInvalido() };
    }

    const lote = await loteRepo.buscarAtivo(client, administradorId, { travar: true });
    const codigo = codigosMfa.normalizarCodigo(codigoRecuperacao);
    const codigoHash = codigo === null ? null : codigosMfa.hashCodigoRecuperacao({ administradorId, codigo });
    const encontrado = lote === null || codigoHash === null
      ? null
      : await codigoRepo.buscarUtilizavelPorHash(client, { administradorId, codigoHash }, { travar: true });
    if (encontrado === null) {
      return registrarFalha(client, { administradorId, desafio, chave, motivo: 'RECUPERACAO_INVALIDA', origem });
    }

    const novo = novoSegredoCifrado(administradorId);
    try {
      await fatorRepo.revogarPendenteTotp(client, { administradorId, motivo: 'SUBSTITUIDO' });
      const fator = await fatorRepo.criarPendenteTotp(client, {
        administradorId, fatorUid: novo.fatorUid, envelope: novo.envelope, validadeMinutos: authConfig.desafioMfa.cadastroMinutos,
      });
      if ((await codigoRepo.consumir(client, { administradorId, codigoHash })) === null) {
        throw codigoInvalido();
      }
      await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'TRANSICAO' });
      // Outro desafio aberto apontaria para um PENDENTE revogado ou abriria uma segunda recuperação.
      await desafioRepo.encerrarAbertos(client, { administradorId, motivo: 'RECUPERACAO_INICIADA' });
      const recuperacao = await desafioService.criarDesafioSobTrava(client, {
        administradorId,
        tipo: 'RECUPERACAO',
        validadeMinutos: authConfig.desafioMfa.cadastroMinutos,
        fatorPendenteId: fator.id,
        desafioAnteriorId: desafio.id,
      });

      await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: true, ...origem });
      await auditoriaRepo.registrar(client, {
        administradorId, acao: 'MFA_RECUPERACAO_INICIADA', referencia: fator.id, contexto: { etapa: 'pre_mfa', fatorUid: novo.fatorUid }, ...origem,
      });

      const entrega = await entregaDoCadastro(client, administradorId, novo.segredo);
      return { resultado: { token: recuperacao.token, desafio: recuperacao.desafio, cadastro: entrega } };
    } finally {
      novo.segredo.fill(0);
    }
  });
}

/**
 * Novo TOTP confirmado: troca o fator, o lote de recovery codes e todas as
 * sessões do administrador; a sessão nova nasce por último.
 *
 * @returns {Promise<{token: string, sessao: {id: string, expiraEm: Date}, codigosRecuperacao: string[]}>}
 */
async function concluirRecuperacao(pool, dados) {
  const { desafioId, administradorId, codigo } = dados;
  const origem = origemDa(dados);

  return executarEtapa(pool, { administradorId, operacao: 'recuperacao_conclusao' }, async (client) => {
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipos: ['RECUPERACAO'] });
    if (etapa.erro) return etapa;
    const { desafio, chave } = etapa;

    const novo = await fatorRepo.buscarPorId(client, { administradorId, fatorId: desafio.fatorPendenteId }, { travar: true });
    if (novo === null || novo.estado !== 'PENDENTE' || !novo.pendenteVigente) {
      return { erro: cadastroExpirado() };
    }
    const antigo = await fatorRepo.buscarTotpAtivo(client, administradorId, { travar: true });

    const agora = await instanteDoBanco(client);
    const aceito = validarTotpDoFator({ administradorId, fator: novo, codigo, agora });
    if (aceito === null) {
      return registrarFalha(client, { administradorId, desafio, chave, motivo: 'TOTP_INVALIDO', origem });
    }

    // O banco admite um só TOTP ATIVO: o antigo sai antes, sem ser decifrado.
    if (antigo !== null) {
      await fatorRepo.revogar(client, { administradorId, fatorId: antigo.id, motivo: 'RECUPERACAO' });
    }
    if (!(await fatorRepo.ativarTotp(client, { administradorId, fatorId: novo.id, step: aceito.step }))) {
      throw cadastroExpirado();
    }
    const codigosRecuperacao = await emitirLoteRecuperacao(client, { administradorId, motivoRevogacao: 'RECUPERACAO' });

    const sessoesRevogadas = await sessaoRepo.revogarTodasDoAdministrador(client, administradorId, 'MFA_RECUPERADO');
    await desafioRepo.encerrarAbertos(client, { administradorId, motivo: 'MFA_RECUPERADO', exceto: desafio.id });
    await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: true, ...origem });
    await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'CONCLUIDO' });
    const sessao = await criarSessaoPlena(client, { administradorId, desafioId: desafio.id, agora, metodo: 'RECADASTRO', tokenSessaoAnterior: null, origem });

    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'MFA_RECUPERACAO_CONCLUIDA', referencia: novo.id, contexto: { metodo: 'RECADASTRO', fatorUid: novo.fatorUid }, ...origem,
    });
    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'SESSOES_ADMINISTRADOR_REVOGADAS', contexto: { motivo: 'MFA_RECUPERADO', quantidade: sessoesRevogadas }, ...origem,
    });

    return { resultado: { ...sessao, codigosRecuperacao } };
  });
}

module.exports = { iniciarRecuperacao, concluirRecuperacao };
