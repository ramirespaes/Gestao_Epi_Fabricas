'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { detalhesDePoliticaSenha } = require('../middleware/validar');
const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');
const identidadeRepo = require('../repositories/identidade.repository');
const sessaoGlobalRepo = require('../repositories/sessao-global.repository');
const sessaoRepo = require('../repositories/sessao.repository');
const redefinicaoRepo = require('../repositories/redefinicao-senha.repository');
const loginTentativaGlobalRepo = require('../repositories/login-tentativa-global.repository');
const auditoriaIdentidadeRepo = require('../repositories/auditoria-identidade.repository');
const loginGlobalService = require('./login-global.service');
const { avisarTroca } = require('./aviso-troca-senha');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const passwordPolicy = require('../security/password-policy');
const token = require('../security/token');

/**
 * Troca de senha autenticada do Portal do Cliente: a pessoa, com a sessão
 * global em uso, informa a senha atual e a nova.
 *
 * QUEM AGE vem da sessão, nunca do cliente: o controller entrega a identidade
 * e a sessão que o middleware provou, e os dois tokens dos cookies, que o
 * service relê dentro da transação.
 *
 * SENHA ATUAL ERRADA conta no cooldown do login global: a mesma chave e os
 * mesmos níveis (tratarFalha do login). Com o cooldown vigente nenhuma senha
 * é conferida. A política e a igualdade com a atual só são avaliadas depois
 * de a senha atual conferir, e não deixam linha nem contam falha.
 *
 * NO SUCESSO a sessão global em uso e a sessão empresarial dela continuam; as
 * demais sessões globais e empresariais da identidade, em todas as empresas,
 * são revogadas. A empresarial só é preservada se for válida, de um vínculo
 * desta identidade e nascida da sessão global atual: cookie presente não
 * basta. Os pedidos de redefinição pendentes são cancelados. Nenhuma sessão
 * nova nasce e nenhum token muda.
 *
 * ORDEM DAS TRAVAS, a mesma do login e da redefinição: chave de login do
 * e-mail, linha da identidade, linha da sessão global atual, e só então as
 * escritas, com as globais revogadas antes das empresariais (uma seleção de
 * empresa concorrente cria a empresarial depois de travar a própria global;
 * revogar nesta ordem enxerga a sessão que ela acabou de criar).
 *
 * Desfechos de negócio terminam em COMMIT (a falha contada fica) e só depois
 * viram HttpError. O aviso por e-mail sai depois do COMMIT, sem esperar.
 *
 * Repositórios e módulos de segurança sempre por namespace, para os testes
 * poderem substituí-los.
 */

const MOTIVO = 'SENHA_ALTERADA';
const ACAO = 'SENHA_ALTERADA';
const TRAVA_CONSULTIVA = 'SELECT pg_advisory_xact_lock($1::bigint)';
const MENSAGEM_COOLDOWN = 'Muitas tentativas. Tente novamente mais tarde';

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

/** A sessão global do token é a da requisição, é desta identidade e continua válida sob a trava da própria linha. */
async function sessaoGlobalAtual(client, { identidadeId, sessaoGlobalId, tokenSessaoGlobal }) {
  if (!token.tokenSessaoTemFormatoValido(tokenSessaoGlobal)) {
    return false;
  }
  const contexto = await sessaoGlobalRepo.buscarValidaPorHash(client, token.hashTokenSessao(tokenSessaoGlobal), authConfig.sessao.inatividadeMinutos);
  if (contexto === null || contexto.sessao.id !== sessaoGlobalId || contexto.identidade.id !== identidadeId) {
    return false;
  }
  return sessaoGlobalRepo.bloquearValida(client, sessaoGlobalId);
}

/** A empresarial do cookie, só se for desta identidade e nascida da sessão global atual. */
async function empresarialAtual(client, { identidadeId, sessaoGlobalId, tokenSessaoEmpresarial }) {
  if (!token.tokenSessaoTemFormatoValido(tokenSessaoEmpresarial)) {
    return null;
  }
  return sessaoRepo.buscarIdDaAtualDaSessaoGlobal(client, {
    tokenHash: token.hashTokenSessao(tokenSessaoEmpresarial),
    sessaoGlobalId,
    identidadeId,
    inatividadeMinutos: authConfig.sessao.inatividadeMinutos,
  });
}

async function decidir(client, dados) {
  const { identidadeId, sessaoGlobalId, senhaAtual, novaSenha, ip, dispositivo } = dados;

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
  if (!(await sessaoGlobalAtual(client, dados))) {
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

  const politica = passwordPolicy.validarPoliticaSenha(novaSenha, { email: conta.email });
  if (!politica.ok) {
    return { tipo: 'SENHA_FORA_DA_POLITICA', detalhes: detalhesDePoliticaSenha(politica) };
  }
  if (await password.verificarSenha(credencial.senhaHash, novaSenha)) {
    return { tipo: 'SENHA_IGUAL_A_ATUAL' };
  }

  const senhaHash = await password.gerarHashSenha(novaSenha);
  await loginTentativaGlobalRepo.registrarTentativa(client, {
    chaveCooldown: chave, identidadeId: conta.id, sucesso: true, ip, dispositivo,
  });
  await identidadeRepo.atualizarSenhaHash(client, conta.id, senhaHash);
  const pedidosCancelados = await redefinicaoRepo.cancelarPendentes(client, conta.id, MOTIVO);
  const preservada = await empresarialAtual(client, dados);
  const sessoesGlobaisRevogadas = await sessaoGlobalRepo.revogarTodasDaIdentidade(client, conta.id, MOTIVO, { exceto: sessaoGlobalId });
  const sessoesEmpresariaisRevogadas = await sessaoRepo.revogarTodasDaIdentidade(client, conta.id, MOTIVO, { exceto: preservada });
  await auditoriaIdentidadeRepo.registrarDaIdentidade(client, {
    identidadeId: conta.id,
    acao: ACAO,
    contexto: {
      origem: 'TROCA_AUTENTICADA',
      sessoesGlobaisRevogadas,
      sessoesEmpresariaisRevogadas,
      pedidosCancelados,
      sessaoEmpresarialPreservada: preservada !== null,
    },
    ip,
    dispositivo,
  });
  return { tipo: 'SUCESSO', email: conta.email };
}

/**
 * Troca a senha da identidade autenticada. Não cria sessão.
 *
 * @param {import('pg').Pool} pool
 * @param {{identidadeId: number, sessaoGlobalId: string, tokenSessaoGlobal: string|null,
 *          tokenSessaoEmpresarial: string|null, senhaAtual: string, novaSenha: string,
 *          ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{status: 'SENHA_ALTERADA'}>}
 */
async function trocar(pool, dados) {
  const origem = { ip: ipParaGravar(dados.ip ?? null), dispositivo: dispositivoParaGravar(dados.dispositivo ?? null) };
  const desfecho = await emTransacao(pool, (client) => decidir(client, { ...dados, ...origem }));

  switch (desfecho.tipo) {
    case 'SUCESSO':
      avisarTroca({ escopo: 'PORTAL', email: desfecho.email });
      return { status: 'SENHA_ALTERADA' };
    case 'COOLDOWN': {
      // Date.now() é só a dica do Retry-After, fora da transação.
      const retryAfterSegundos = Math.max(1, Math.ceil((desfecho.ativoAte.getTime() - Date.now()) / 1000));
      throw HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', MENSAGEM_COOLDOWN, { retryAfterSegundos });
    }
    case 'SENHA_ATUAL_INVALIDA':
      throw HttpError.unauthorized('SENHA_ATUAL_INVALIDA', 'Senha atual incorreta');
    case 'SENHA_FORA_DA_POLITICA':
      throw HttpError.validacao(desfecho.detalhes);
    case 'SENHA_IGUAL_A_ATUAL':
      throw HttpError.badRequest('SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual');
    default:
      throw HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada');
  }
}

module.exports = { trocar };
