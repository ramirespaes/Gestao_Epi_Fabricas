'use strict';

const { HttpError } = require('../errors/HttpError');
const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');
const identidadeRepo = require('../repositories/identidade.repository');
const sessaoGlobalRepo = require('../repositories/sessao-global.repository');
const sessaoRepo = require('../repositories/sessao.repository');
const redefinicaoRepo = require('../repositories/redefinicao-senha.repository');
const loginTentativaGlobalRepo = require('../repositories/login-tentativa-global.repository');
const auditoriaIdentidadeRepo = require('../repositories/auditoria-identidade.repository');
const loginGlobalService = require('./login-global.service');
const trocaSenhaGlobal = require('./troca-senha-global.service');
const { avisarTrocaEmail } = require('./aviso-troca-email');
const cooldown = require('../security/cooldown');
const password = require('../security/password');

/**
 * Troca do e-mail de acesso da identidade autenticada (Configurações).
 *
 * Mesmo desenho e mesma ordem de travas da troca de senha autenticada
 * (troca-senha-global.service.js): chave de login do e-mail ATUAL, linha da
 * identidade, sessão global atual; a senha atual é conferida pelo mesmo
 * Argon2 e a senha errada conta no mesmo cooldown do login. Só então o novo
 * endereço, já normalizado pelo schema, é conferido: igual ao atual é 400;
 * usado por outra identidade (uq_identidades_email_lower) é 409 genérico,
 * sem dizer de quem é.
 *
 * NO SUCESSO o novo e-mail passa a valer no próximo login; os pedidos de
 * redefinição pendentes (enviados ao endereço antigo) são cancelados; as
 * demais sessões globais e empresariais da identidade são revogadas e a
 * sessão global atual, com a empresarial nascida dela, é preservada. A
 * auditoria EMAIL_ALTERADO guarda só contadores e indicadores — nunca o
 * endereço antigo, o novo ou a senha. Depois do COMMIT, o aviso vai ao
 * e-mail ANTIGO; falha no aviso não desfaz a troca.
 */

const MOTIVO = 'EMAIL_ALTERADO';
const ACAO = 'EMAIL_ALTERADO';
const VIOLACAO_UNIQUE = '23505';
const TRAVA_CONSULTIVA = 'SELECT pg_advisory_xact_lock($1::bigint)';
const MENSAGEM_COOLDOWN = 'Muitas tentativas. Tente novamente mais tarde';
const MENSAGEM_INDISPONIVEL = 'Este e-mail não pode ser usado';

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

async function decidir(client, dados) {
  const { identidadeId, sessaoGlobalId, senhaAtual, novoEmail, ip, dispositivo } = dados;

  const lida = await identidadeRepo.buscarPorId(client, identidadeId);
  if (lida === null || !lida.ativo) {
    return { tipo: 'SESSAO_INVALIDA' };
  }
  const chave = cooldown.gerarChaveCooldownGlobal(lida.email);
  await client.query(TRAVA_CONSULTIVA, [cooldown.derivarAdvisoryLock64(chave)]);
  const conta = await identidadeRepo.buscarPorIdParaAtualizacao(client, identidadeId);
  if (conta === null || !conta.ativo || conta.email !== lida.email) {
    return { tipo: 'SESSAO_INVALIDA' };
  }
  if (!(await trocaSenhaGlobal.sessaoGlobalAtual(client, dados))) {
    return { tipo: 'SESSAO_INVALIDA' };
  }

  const vigente = await loginTentativaGlobalRepo.buscarCooldownVigente(client, chave);
  if (vigente !== null) {
    return { tipo: 'COOLDOWN', ativoAte: vigente.ativoAte };
  }

  const credencial = await identidadeRepo.buscarCredencialPorEmail(client, conta.email);
  if (credencial === null || credencial.id !== conta.id || !credencial.ativo) {
    return { tipo: 'SESSAO_INVALIDA' };
  }
  if (!(await password.verificarSenha(credencial.senhaHash, senhaAtual))) {
    await loginGlobalService.tratarFalha(client, {
      chaveCooldown: chave, identidadeId: conta.id, motivo: 'SENHA_ATUAL_INVALIDA', ip, dispositivo,
    });
    return { tipo: 'SENHA_ATUAL_INVALIDA' };
  }

  if (novoEmail === conta.email) {
    return { tipo: 'EMAIL_IGUAL_AO_ATUAL' };
  }
  if ((await identidadeRepo.buscarPorEmail(client, novoEmail)) !== null) {
    return { tipo: 'EMAIL_INDISPONIVEL' };
  }

  await loginTentativaGlobalRepo.registrarTentativa(client, {
    chaveCooldown: chave, identidadeId: conta.id, sucesso: true, ip, dispositivo,
  });
  try {
    await identidadeRepo.atualizarEmail(client, conta.id, novoEmail);
  } catch (erro) {
    if (erro && erro.code === VIOLACAO_UNIQUE) {
      return { tipo: 'EMAIL_INDISPONIVEL' };
    }
    throw erro;
  }
  const pedidosCancelados = await redefinicaoRepo.cancelarPendentes(client, conta.id, MOTIVO);
  const preservada = await trocaSenhaGlobal.empresarialAtual(client, dados);
  const sessoesGlobaisRevogadas = await sessaoGlobalRepo.revogarTodasDaIdentidade(client, conta.id, MOTIVO, { exceto: sessaoGlobalId });
  const sessoesEmpresariaisRevogadas = await sessaoRepo.revogarTodasDaIdentidade(client, conta.id, MOTIVO, { exceto: preservada });
  await auditoriaIdentidadeRepo.registrarDaIdentidade(client, {
    identidadeId: conta.id,
    acao: ACAO,
    contexto: {
      origem: 'CONFIGURACOES',
      sessoesGlobaisRevogadas,
      sessoesEmpresariaisRevogadas,
      pedidosCancelados,
      sessaoEmpresarialPreservada: preservada !== null,
    },
    ip,
    dispositivo,
  });
  return { tipo: 'SUCESSO', emailAntigo: conta.email, email: novoEmail };
}

/**
 * Troca o e-mail de acesso da identidade autenticada. Não cria sessão.
 *
 * @param {import('pg').Pool} pool
 * @param {{identidadeId: number, sessaoGlobalId: string, tokenSessaoGlobal: string|null,
 *          tokenSessaoEmpresarial: string|null, senhaAtual: string, novoEmail: string,
 *          ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{status: 'EMAIL_ALTERADO', email: string}>}
 */
async function trocar(pool, dados) {
  const origem = { ip: ipParaGravar(dados.ip ?? null), dispositivo: dispositivoParaGravar(dados.dispositivo ?? null) };
  const desfecho = await emTransacao(pool, (client) => decidir(client, { ...dados, ...origem }));

  switch (desfecho.tipo) {
    case 'SUCESSO':
      avisarTrocaEmail({ escopo: 'PORTAL', email: desfecho.emailAntigo });
      return { status: 'EMAIL_ALTERADO', email: desfecho.email };
    case 'COOLDOWN': {
      const retryAfterSegundos = Math.max(1, Math.ceil((desfecho.ativoAte.getTime() - Date.now()) / 1000));
      throw HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', MENSAGEM_COOLDOWN, { retryAfterSegundos });
    }
    case 'SENHA_ATUAL_INVALIDA':
      throw HttpError.unauthorized('SENHA_ATUAL_INVALIDA', 'Senha atual incorreta');
    case 'EMAIL_IGUAL_AO_ATUAL':
      throw HttpError.badRequest('EMAIL_IGUAL_AO_ATUAL', 'O novo e-mail é igual ao atual');
    case 'EMAIL_INDISPONIVEL':
      throw HttpError.conflict('EMAIL_INDISPONIVEL', MENSAGEM_INDISPONIVEL);
    default:
      throw HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada');
  }
}

module.exports = { trocar };
