'use strict';

const { HttpError } = require('../errors/HttpError');
const { detalhesDePoliticaSenha } = require('../middleware/validar');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const redefinicaoPlataformaRepo = require('../repositories/redefinicao-senha-plataforma.repository');
const sessaoPlataformaRepo = require('../repositories/sessao-plataforma.repository');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const tentativaRepo = require('../repositories/login-tentativa-plataforma.repository');
const auditoriaPlataformaRepo = require('../repositories/auditoria-plataforma.repository');
const { executarEtapa, origemDa } = require('./etapa-mfa-plataforma');
const { sessaoInvalida, reautenticarSobTrava } = require('./reautenticacao-plataforma');
const { avisarTroca } = require('./aviso-troca-senha');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const passwordPolicy = require('../security/password-policy');

/**
 * Troca de senha autenticada do Painel Privado. É um evento sensível com
 * sessão plena: exige a senha atual e um TOTP atual válido (recovery code
 * nunca substitui), pelo mesmo caminho de reautenticação da troca do
 * autenticador e da regeneração dos códigos — mesmo cooldown de MFA do
 * administrador, mesmo anti-replay do step, mesmo 503 fail-closed se a chave
 * do MFA estiver indisponível. Quem falhou não descobre qual fator foi.
 *
 * A recusa da nova senha (política ou igual à atual) vem depois da
 * reautenticação e termina em COMMIT: o step já consumido continua
 * consumido, e a política só é revelada a quem provou os dois fatores.
 *
 * NO SUCESSO só a sessão atual continua; as demais sessões do administrador
 * são revogadas e os desafios de MFA abertos são encerrados. Fator, secret,
 * lote e códigos de recuperação não são tocados. Os pedidos de redefinição
 * pendentes são cancelados. Nenhuma sessão nova nasce e nenhum token muda.
 *
 * ORDEM DAS TRAVAS, a do login: chave de login do e-mail, trava do MFA, linha
 * do administrador, linha do fator, e só então as escritas.
 *
 * AUDITORIA: ator ADMINISTRADOR. A trilha não admite alvo igual ao ator, então
 * o alvo fica nulo, como nos demais eventos do próprio administrador.
 *
 * O aviso por e-mail sai depois do COMMIT, sem esperar.
 */

const OPERACAO = 'troca_senha';
const MOTIVO = 'SENHA_ALTERADA';
const ACAO = 'SENHA_ALTERADA';
const TRAVA_CONSULTIVA = 'SELECT pg_advisory_xact_lock($1::bigint)';

async function etapa(client, {
  administradorId, sessaoId, tokenSessao, senhaAtual, novaSenha, codigo, origem,
}) {
  const lida = await administradorRepo.buscarPorId(client, administradorId);
  if (lida === null || !lida.ativo) {
    return { erro: sessaoInvalida() };
  }
  await client.query(TRAVA_CONSULTIVA, [cooldown.derivarAdvisoryLock64(cooldown.gerarChaveCooldownPlataforma(lida.email))]);
  await travaRepo.travarAdministrador(client, administradorId);
  const conta = await administradorRepo.buscarPorIdParaAtualizacao(client, administradorId);
  if (conta === null || !conta.ativo || conta.email !== lida.email) {
    return { erro: sessaoInvalida() };
  }

  const reautenticacao = await reautenticarSobTrava(client, {
    administradorId, sessaoId, tokenSessao, senha: senhaAtual, codigo, origem,
  });
  if (reautenticacao.erro) {
    return reautenticacao;
  }

  const politica = passwordPolicy.validarPoliticaSenha(novaSenha, { email: conta.email });
  if (!politica.ok) {
    return { erro: HttpError.validacao(detalhesDePoliticaSenha(politica)) };
  }
  const credencial = await administradorRepo.buscarCredencialPorEmail(client, conta.email);
  if (credencial === null || credencial.id !== conta.id) {
    return { erro: sessaoInvalida() };
  }
  if (await password.verificarSenha(credencial.senhaHash, novaSenha)) {
    return { erro: HttpError.badRequest('SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual') };
  }

  await administradorRepo.atualizarSenhaHash(client, conta.id, await password.gerarHashSenha(novaSenha));
  await tentativaRepo.registrarTentativa(client, {
    chaveCooldown: reautenticacao.chave, administradorId: conta.id, sucesso: true, ...origem,
  });
  const pedidosCancelados = await redefinicaoPlataformaRepo.cancelarPendentes(client, conta.id, MOTIVO);
  const sessoesRevogadas = await sessaoPlataformaRepo.revogarTodasDoAdministrador(client, conta.id, MOTIVO, { exceto: sessaoId });
  const desafiosEncerrados = await desafioRepo.encerrarAbertos(client, { administradorId: conta.id, motivo: MOTIVO });
  await auditoriaPlataformaRepo.registrar(client, {
    administradorId: conta.id,
    acao: ACAO,
    contexto: {
      origem: 'TROCA_AUTENTICADA', sessoesRevogadas, desafiosEncerrados, pedidosCancelados,
    },
    ...origem,
  });
  return { resultado: { email: conta.email } };
}

/**
 * Troca a senha do administrador autenticado. Não cria sessão.
 *
 * @param {import('pg').Pool} pool
 * @param {{administradorId: number, sessaoId: string, tokenSessao: string|null, senhaAtual: string,
 *          novaSenha: string, codigo: string, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{status: 'SENHA_ALTERADA'}>}
 */
async function trocar(pool, dados) {
  const {
    administradorId, sessaoId, tokenSessao, senhaAtual, novaSenha, codigo,
  } = dados;
  const origem = origemDa(dados);

  const { email } = await executarEtapa(pool, { administradorId, operacao: OPERACAO }, (client) => etapa(client, {
    administradorId, sessaoId, tokenSessao, senhaAtual, novaSenha, codigo, origem,
  }));

  avisarTroca({ escopo: 'PLATAFORMA', email });
  return { status: 'SENHA_ALTERADA' };
}

module.exports = { trocar };
