'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const token = require('../security/token');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria-plataforma.repository');
const tentativaRepo = require('../repositories/login-tentativa-plataforma.repository');
const desafioService = require('./desafio-mfa-plataforma.service');
const {
  desafioInvalido,
  emCooldown,
  executarEtapa,
  exigirChaveAtual,
  abrirEtapa,
  instanteDoBanco,
  aplicarCooldown,
  registrarFalha,
  novoSegredoCifrado,
  entregaDoCadastro,
  origemDa,
  emitirLoteRecuperacao,
  validarTotpDoFator,
} = require('./etapa-mfa-plataforma');

/**
 * Eventos sensíveis com sessão plena: trocar o TOTP e regenerar os recovery
 * codes. Os dois exigem senha e TOTP atual e terminam revogando todas as
 * sessões do administrador, inclusive a atual, sem sessão nova no lugar: o
 * próximo acesso exige login completo.
 */

const sessaoInvalida = () => HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada');
// Senha, TOTP, replay e fator ausente respondem igual: quem tem só a sessão não descobre o que falhou.
const reautenticacaoInvalida = () => HttpError.unauthorized('REAUTENTICACAO_INVALIDA', 'Senha ou código inválidos');
const cadastroExpirado = () => HttpError.conflict('MFA_CADASTRO_EXPIRADO', 'O cadastro expirou. Gere um novo código ou entre de novo com a senha');

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

/** Sob a trava: sessão relida, cooldown de MFA, senha, TOTP do fator ATIVO e step consumido. */
async function reautenticar(client, { administradorId, sessaoId, tokenSessao, senha, codigo, origem }) {
  await travaRepo.travarAdministrador(client, administradorId);
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

/**
 * Sessão plena -> SUBSTITUICAO. Cria o PENDENTE novo e o desafio ligado à
 * sessão de origem; o fator antigo continua ATIVO até a confirmação.
 *
 * @returns {Promise<{token: string, desafio: object, cadastro: {uri: string, chaveManual: string}}>}
 */
async function iniciarSubstituicao(pool, dados) {
  const { administradorId, sessaoId, tokenSessao, senha, codigo } = dados;
  const origem = origemDa(dados);
  await exigirChaveAtual(pool, administradorId, 'substituicao');

  return executarEtapa(pool, { administradorId, operacao: 'substituicao' }, async (client) => {
    const reautenticacao = await reautenticar(client, { administradorId, sessaoId, tokenSessao, senha, codigo, origem });
    if (reautenticacao.erro) return reautenticacao;

    const novo = novoSegredoCifrado(administradorId);
    try {
      await fatorRepo.revogarPendenteTotp(client, { administradorId, motivo: 'SUBSTITUIDO' });
      const fator = await fatorRepo.criarPendenteTotp(client, {
        administradorId, fatorUid: novo.fatorUid, envelope: novo.envelope, validadeMinutos: authConfig.desafioMfa.cadastroMinutos,
      });
      // Outro desafio aberto apontaria para um PENDENTE revogado.
      await desafioRepo.encerrarAbertos(client, { administradorId, motivo: 'SUBSTITUICAO_INICIADA' });
      const substituicao = await desafioService.criarDesafioSobTrava(client, {
        administradorId,
        tipo: 'SUBSTITUICAO',
        validadeMinutos: authConfig.desafioMfa.cadastroMinutos,
        fatorPendenteId: fator.id,
        sessaoOrigemId: sessaoId,
      });

      await tentativaRepo.registrarTentativa(client, { chaveCooldown: reautenticacao.chave, administradorId, sucesso: true, ...origem });
      await auditoriaRepo.registrar(client, {
        administradorId, acao: 'MFA_SUBSTITUICAO_INICIADA', referencia: fator.id, contexto: { fatorUid: novo.fatorUid }, ...origem,
      });

      const entrega = await entregaDoCadastro(client, administradorId, novo.segredo);
      return { resultado: { token: substituicao.token, desafio: substituicao.desafio, cadastro: entrega } };
    } finally {
      novo.segredo.fill(0);
    }
  });
}

const porId = (a, b) => (BigInt(a) < BigInt(b) ? -1 : 1);

/**
 * TOTP novo confirmado pela sessão que iniciou a troca: até o COMMIT só o
 * fator antigo vale; depois dele, só o novo.
 *
 * @returns {Promise<{codigosRecuperacao: string[]}>}
 */
async function confirmarSubstituicao(pool, dados) {
  const { desafioId, administradorId, sessaoId, tokenSessao, codigo } = dados;
  const origem = origemDa(dados);

  return executarEtapa(pool, { administradorId, operacao: 'substituicao_conclusao' }, async (client) => {
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipos: ['SUBSTITUICAO'] });
    if (etapa.erro) return etapa;
    const { desafio, chave } = etapa;

    const contexto = await sessaoRelida(client, { administradorId, sessaoId, tokenSessao });
    if (contexto === null) {
      return { erro: sessaoInvalida() };
    }
    if (desafio.sessaoOrigemId !== contexto.sessao.id) {
      return { erro: desafioInvalido() };
    }

    const antigoId = (await fatorRepo.buscarTotpAtivo(client, administradorId))?.id ?? null;
    const travados = new Map();
    for (const id of [desafio.fatorPendenteId, antigoId].filter((id) => id !== null).sort(porId)) {
      travados.set(id, await fatorRepo.buscarPorId(client, { administradorId, fatorId: id }, { travar: true }));
    }
    const novo = travados.get(desafio.fatorPendenteId);
    const antigo = antigoId === null ? null : travados.get(antigoId);
    if (novo === null || novo.estado !== 'PENDENTE' || !novo.pendenteVigente) {
      return { erro: cadastroExpirado() };
    }

    const agora = await instanteDoBanco(client);
    const aceito = validarTotpDoFator({ administradorId, fator: novo, codigo, agora });
    if (aceito === null) {
      return registrarFalha(client, { administradorId, desafio, chave, motivo: 'TOTP_INVALIDO', origem });
    }

    // O banco admite um só TOTP ATIVO: o antigo sai antes; se a ativação falhar, tudo é desfeito.
    if (antigo !== null && antigo.estado === 'ATIVO') {
      await fatorRepo.revogar(client, { administradorId, fatorId: antigo.id, motivo: 'SUBSTITUIDO' });
    }
    if (!(await fatorRepo.ativarTotp(client, { administradorId, fatorId: novo.id, step: aceito.step }))) {
      throw cadastroExpirado();
    }
    const codigosRecuperacao = await emitirLoteRecuperacao(client, { administradorId, motivoRevogacao: 'SUBSTITUICAO' });

    await desafioRepo.encerrarAbertos(client, { administradorId, motivo: 'MFA_SUBSTITUIDO', exceto: desafio.id });
    await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: true, ...origem });
    await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'CONCLUIDO' });
    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'MFA_FATOR_SUBSTITUIDO', referencia: novo.id, contexto: { metodo: 'SUBSTITUICAO', fatorUid: novo.fatorUid }, ...origem,
    });

    const sessoesRevogadas = await sessaoRepo.revogarTodasDoAdministrador(client, administradorId, 'MFA_SUBSTITUIDO');
    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'SESSOES_ADMINISTRADOR_REVOGADAS', contexto: { motivo: 'MFA_SUBSTITUIDO', quantidade: sessoesRevogadas }, ...origem,
    });

    return { resultado: { codigosRecuperacao } };
  });
}

/**
 * Lote novo de 10 recovery codes, sem trocar o fator.
 *
 * @returns {Promise<{codigosRecuperacao: string[]}>}
 */
async function regenerarCodigos(pool, dados) {
  const { administradorId, sessaoId, tokenSessao, senha, codigo } = dados;
  const origem = origemDa(dados);

  return executarEtapa(pool, { administradorId, operacao: 'regeneracao' }, async (client) => {
    const reautenticacao = await reautenticar(client, { administradorId, sessaoId, tokenSessao, senha, codigo, origem });
    if (reautenticacao.erro) return reautenticacao;

    // Recuperação ou substituição em andamento não pode sobreviver à rotação, senão trocaria o fator depois dela.
    const desafios = await desafioRepo.encerrarAbertos(client, { administradorId, motivo: 'MFA_CODIGOS_REGENERADOS' });
    const pendentes = await fatorRepo.revogarPendenteTotp(client, { administradorId, motivo: 'MFA_CODIGOS_REGENERADOS' });
    const codigosRecuperacao = await emitirLoteRecuperacao(client, { administradorId, motivoRevogacao: 'REGENERADO' });
    await tentativaRepo.registrarTentativa(client, { chaveCooldown: reautenticacao.chave, administradorId, sucesso: true, ...origem });
    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'MFA_CODIGOS_RECUPERACAO_REGENERADOS', contexto: { quantidade: codigosRecuperacao.length, desafios, pendentes }, ...origem,
    });

    const sessoesRevogadas = await sessaoRepo.revogarTodasDoAdministrador(client, administradorId, 'MFA_CODIGOS_REGENERADOS');
    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'SESSOES_ADMINISTRADOR_REVOGADAS', contexto: { motivo: 'MFA_CODIGOS_REGENERADOS', quantidade: sessoesRevogadas }, ...origem,
    });

    return { resultado: { codigosRecuperacao } };
  });
}

module.exports = { iniciarSubstituicao, confirmarSubstituicao, regenerarCodigos };
