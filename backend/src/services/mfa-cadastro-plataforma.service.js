'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const codigosMfa = require('../security/codigos-mfa');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const liberacaoRepo = require('../repositories/liberacao-cadastro-mfa-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria-plataforma.repository');
const tentativaRepo = require('../repositories/login-tentativa-plataforma.repository');
const desafioService = require('./desafio-mfa-plataforma.service');
const {
  desafioInvalido,
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
 * Etapas do MFA do Painel Privado que terminam em sessão plena:
 *
 *   LIBERACAO --(código do CLI)--> CADASTRO --(primeiro TOTP)--> sessão plena
 *   VERIFICACAO --(TOTP do fator ATIVO)--> sessão plena
 *
 * A sessão plena só nasce depois de um TOTP válido, com token próprio (o do
 * desafio nunca vira sessão). Transação, fail-closed criptográfico, falhas
 * e cooldown ficam em etapa-mfa-plataforma.js.
 */

const MAXIMO_REINICIOS = 3;

/**
 * LIBERACAO -> CADASTRO. Valida o código de liberação, cria o fator
 * PENDENTE cifrado, consome a liberação e troca o desafio por um novo
 * (CADASTRO), com token novo.
 *
 * @returns {Promise<{token: string, desafio: object, cadastro: {uri: string, chaveManual: string}}>}
 */
async function confirmarLiberacao(pool, dados) {
  const { desafioId, administradorId, codigoLiberacao } = dados;
  const origem = origemDa(dados);
  await exigirChaveAtual(pool, administradorId, 'liberacao');

  return executarEtapa(pool, { administradorId, operacao: 'liberacao' }, async (client) => {
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipos: ['LIBERACAO'] });
    if (etapa.erro) return etapa;
    const { desafio, chave } = etapa;

    const codigo = codigosMfa.normalizarCodigo(codigoLiberacao);
    const codigoHash = codigo === null ? null : codigosMfa.hashCodigoLiberacao({ administradorId, codigo });
    const liberacao = codigoHash === null ? null : await liberacaoRepo.buscarValidaPorHash(client, { administradorId, codigoHash }, { travar: true });
    if (liberacao === null) {
      return registrarFalha(client, { administradorId, desafio, chave, motivo: 'LIBERACAO_INVALIDA', origem });
    }

    const novo = novoSegredoCifrado(administradorId);
    try {
      await fatorRepo.revogarPendenteTotp(client, { administradorId, motivo: 'SUBSTITUIDO' });
      const fator = await fatorRepo.criarPendenteTotp(client, {
        administradorId, fatorUid: novo.fatorUid, envelope: novo.envelope, validadeMinutos: authConfig.desafioMfa.cadastroMinutos,
      });
      if ((await liberacaoRepo.consumir(client, { administradorId, codigoHash })) === null) {
        throw new Error('liberação de cadastro não pôde ser consumida');
      }
      await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'TRANSICAO' });
      const cadastro = await desafioService.criarDesafioSobTrava(client, {
        administradorId,
        tipo: 'CADASTRO',
        validadeMinutos: authConfig.desafioMfa.cadastroMinutos,
        fatorPendenteId: fator.id,
        desafioAnteriorId: desafio.id,
      });

      await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: true, ...origem });
      await auditoriaRepo.registrar(client, {
        administradorId, acao: 'LIBERACAO_CADASTRO_CONSUMIDA', referencia: liberacao.id, contexto: { etapa: 'pre_mfa', origem: liberacao.origem }, ...origem,
      });
      await auditoriaRepo.registrar(client, {
        administradorId, acao: 'MFA_CADASTRO_INICIADO', referencia: fator.id, contexto: { etapa: 'pre_mfa', fatorUid: novo.fatorUid }, ...origem,
      });

      const entrega = await entregaDoCadastro(client, administradorId, novo.segredo);
      return { resultado: { token: cadastro.token, desafio: cadastro.desafio, cadastro: entrega } };
    } finally {
      novo.segredo.fill(0);
    }
  });
}

/**
 * Novo secret para o mesmo desafio CADASTRO ou RECUPERACAO (QR novo), no
 * máximo 3 vezes. O PENDENTE anterior é revogado (ciphertext apagado); o
 * ATIVO, se houver, não é tocado. Falha de criptografia não conta como
 * reinício.
 */
async function reiniciarCadastro(pool, dados) {
  const { desafioId, administradorId } = dados;
  const origem = origemDa(dados);
  await exigirChaveAtual(pool, administradorId, 'cadastro_reinicio');

  return executarEtapa(pool, { administradorId, operacao: 'cadastro_reinicio' }, async (client) => {
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipos: ['CADASTRO', 'RECUPERACAO'] });
    if (etapa.erro) return etapa;
    const { desafio } = etapa;
    if (desafio.reinicios >= MAXIMO_REINICIOS) {
      return { erro: HttpError.conflict('MFA_CADASTRO_REINICIOS_ESGOTADOS', 'Limite de novos códigos atingido. Entre de novo com a senha') };
    }

    const novo = novoSegredoCifrado(administradorId);
    try {
      await fatorRepo.revogar(client, { administradorId, fatorId: desafio.fatorPendenteId, motivo: 'REINICIADO' });
      const fator = await fatorRepo.criarPendenteTotp(client, {
        administradorId, fatorUid: novo.fatorUid, envelope: novo.envelope, validadeMinutos: authConfig.desafioMfa.cadastroMinutos,
      });
      if (!(await desafioRepo.trocarFatorPendente(client, { desafioId: desafio.id, fatorPendenteId: fator.id, maximoReinicios: MAXIMO_REINICIOS }))) {
        throw new Error('desafio de cadastro não pôde ser reiniciado');
      }
      await auditoriaRepo.registrar(client, {
        administradorId,
        acao: 'MFA_CADASTRO_INICIADO',
        referencia: fator.id,
        contexto: { etapa: 'pre_mfa', fatorUid: novo.fatorUid, reinicio: desafio.reinicios + 1 },
        ...origem,
      });

      const entrega = await entregaDoCadastro(client, administradorId, novo.segredo);
      return { resultado: { desafio: { etapa: desafio.tipo, expiraEm: desafio.expiraEm }, cadastro: entrega } };
    } finally {
      novo.segredo.fill(0);
    }
  });
}

/**
 * Primeiro TOTP: ativa o fator com o step aceito (base do anti-replay),
 * cria o lote de 10 recovery codes (só hashes no banco), encerra o desafio
 * e cria a sessão plena, com token novo e registro do MFA. A sessão que
 * este navegador já apresentava, se ainda válida, é revogada: o cookie dela
 * vai ser substituído.
 *
 * @returns {Promise<{token: string, sessao: {id: string, expiraEm: Date}, codigosRecuperacao: string[]}>}
 */
async function confirmarCadastro(pool, dados) {
  const { desafioId, administradorId, codigo, tokenSessaoAnterior = null } = dados;
  const origem = origemDa(dados);

  return executarEtapa(pool, { administradorId, operacao: 'cadastro' }, async (client) => {
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipos: ['CADASTRO'] });
    if (etapa.erro) return etapa;
    const { desafio, chave } = etapa;

    const fator = await fatorRepo.buscarPorId(client, { administradorId, fatorId: desafio.fatorPendenteId }, { travar: true });
    if (fator === null || fator.estado !== 'PENDENTE' || !fator.pendenteVigente) {
      return { erro: HttpError.conflict('MFA_CADASTRO_EXPIRADO', 'O cadastro expirou. Gere um novo código ou entre de novo com a senha') };
    }
    if ((await fatorRepo.buscarTotpAtivo(client, administradorId)) !== null) {
      return { erro: HttpError.conflict('MFA_JA_ATIVO', 'Este administrador já tem o segundo fator ativo') };
    }

    const agora = await instanteDoBanco(client);
    const aceito = validarTotpDoFator({ administradorId, fator, codigo, agora });
    if (aceito === null) {
      return registrarFalha(client, { administradorId, desafio, chave, motivo: 'TOTP_INVALIDO', origem });
    }

    if (!(await fatorRepo.ativarTotp(client, { administradorId, fatorId: fator.id, step: aceito.step }))) {
      return { erro: HttpError.conflict('MFA_CADASTRO_EXPIRADO', 'O cadastro expirou. Gere um novo código ou entre de novo com a senha') };
    }

    const codigosRecuperacao = await emitirLoteRecuperacao(client, { administradorId, motivoRevogacao: 'NOVO_CADASTRO' });

    await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: true, ...origem });
    await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'CONCLUIDO' });
    const sessao = await criarSessaoPlena(client, { administradorId, desafioId: desafio.id, agora, metodo: 'CADASTRO', tokenSessaoAnterior, origem });

    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'MFA_CADASTRO_CONCLUIDO', referencia: fator.id, contexto: { metodo: 'CADASTRO', fatorUid: fator.fatorUid }, ...origem,
    });

    return { resultado: { ...sessao, codigosRecuperacao } };
  });
}

/**
 * Login de quem já tem TOTP ATIVO: conclui o desafio VERIFICACAO e cria a
 * sessão plena. Sem fator ATIVO o desafio é encerrado, sem cair no cadastro.
 *
 * @returns {Promise<{token: string, sessao: {id: string, expiraEm: Date}}>}
 */
async function verificarLogin(pool, dados) {
  const { desafioId, administradorId, codigo, tokenSessaoAnterior = null } = dados;
  const origem = origemDa(dados);

  return executarEtapa(pool, { administradorId, operacao: 'verificacao' }, async (client) => {
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipos: ['VERIFICACAO'] });
    if (etapa.erro) return etapa;
    const { desafio, chave } = etapa;

    const fator = await fatorRepo.buscarTotpAtivo(client, administradorId, { travar: true });
    if (fator === null) {
      await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'SEM_FATOR_ATIVO' });
      return { erro: desafioInvalido() };
    }

    const agora = await instanteDoBanco(client);
    const aceito = validarTotpDoFator({ administradorId, fator, codigo, agora });
    if (aceito === null) {
      return registrarFalha(client, { administradorId, desafio, chave, motivo: 'TOTP_INVALIDO', origem });
    }
    // O UPDATE condicional é o anti-replay: step igual ou anterior ao último aceito não passa.
    if (!(await fatorRepo.registrarStepAceito(client, { administradorId, fatorId: fator.id, step: aceito.step }))) {
      return registrarFalha(client, { administradorId, desafio, chave, motivo: 'TOTP_REPETIDO', origem });
    }

    await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'CONCLUIDO' });
    await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: true, ...origem });
    const sessao = await criarSessaoPlena(client, { administradorId, desafioId: desafio.id, agora, metodo: 'TOTP', tokenSessaoAnterior, origem });

    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'MFA_LOGIN_CONCLUIDO', referencia: sessao.sessao.id, contexto: { metodo: 'TOTP', fatorUid: fator.fatorUid }, ...origem,
    });

    return { resultado: sessao };
  });
}

module.exports = { confirmarLiberacao, reiniciarCadastro, confirmarCadastro, verificarLogin, MAXIMO_REINICIOS };
