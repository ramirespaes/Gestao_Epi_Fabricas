'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { detalhesDePoliticaSenha } = require('../middleware/validar');
const { normalizarEmail } = require('../utils/normalizacao');
const identidadeRepo = require('../repositories/identidade.repository');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const redefinicaoRepo = require('../repositories/redefinicao-senha.repository');
const redefinicaoPlataformaRepo = require('../repositories/redefinicao-senha-plataforma.repository');
const solicitacaoRepo = require('../repositories/recuperacao-senha-solicitacao.repository');
const auditoriaIdentidadeRepo = require('../repositories/auditoria-identidade.repository');
const auditoriaPlataformaRepo = require('../repositories/auditoria-plataforma.repository');
const sessaoGlobalRepo = require('../repositories/sessao-global.repository');
const sessaoRepo = require('../repositories/sessao.repository');
const sessaoPlataformaRepo = require('../repositories/sessao-plataforma.repository');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const entregaRecuperacao = require('./entrega-recuperacao-senha.service');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const passwordPolicy = require('../security/password-policy');
const token = require('../security/token');

/**
 * Recuperação de senha por link, para o Portal do Cliente (identidades) e
 * para o Painel Privado (administradores da plataforma). O escopo vem do
 * controller de cada namespace, nunca do cliente.
 *
 * SOLICITAÇÃO. A resposta é sempre a mesma, exista ou não a conta, esteja
 * ela inativa, o limite estourado ou tenha havido erro interno: nada do que
 * sai daqui permite enumerar contas. O limite é de 3 solicitações aceitas
 * por e-mail a cada 60 minutos, contadas pela chave HMAC do e-mail. A
 * tentativa que encontra o limite já atingido não grava nada, nem linha de
 * solicitação nem auditoria: assim ninguém estica a janela nem infla a
 * tabela, e por isso o evento de limite não tem telemetria persistente.
 *
 * REDEFINIÇÃO. Token de uso único; só o hash chega aos repositórios. Token
 * malformado, desconhecido, usado, cancelado ou expirado e conta inativa
 * produzem o mesmo erro. A redefinição revoga todas as sessões da conta,
 * não preserva nem cria sessão. No Painel Privado encerra os desafios
 * pré-MFA abertos e não toca em fator, lote ou código de recuperação: o
 * próximo login continua exigindo o segundo fator.
 *
 * ORDEM DAS TRAVAS, sempre a mesma, para não haver deadlock:
 *   solicitação   chave de recuperação do e-mail > conta > pedido
 *   redefinição   chave de login do e-mail > (Painel) trava do MFA > conta > pedido
 * A redefinição usa a mesma chave que o login daquela conta
 * (gerarChaveCooldownGlobal / gerarChaveCooldownPlataforma). Login e
 * redefinição ficam em série: a sessão ou o desafio aberto com a senha
 * antiga existe antes da redefinição, e é revogado por ela, ou o login vem
 * depois e já encontra a senha nova. O pedido é lido uma vez sem trava só
 * para descobrir a conta; a decisão é tomada com as linhas travadas.
 *
 * AUDITORIA. Fluxo sem sessão: o ator é sempre SISTEMA
 * (registrarEventoSistema), nunca a identidade. Token, hash, link, senha e
 * e-mail não entram em nenhum campo.
 *
 * E-MAIL. Enfileirado só depois do COMMIT e sem esperar a entrega (ver
 * entrega-recuperacao-senha.service). Falha na entrega não desfaz a
 * transação nem muda a resposta.
 *
 * Repositórios e módulos de segurança sempre por namespace, para os testes
 * poderem substituí-los.
 */

const ESCOPOS = cooldown.ESCOPOS_RECUPERACAO_SENHA;
const LIMITE_SOLICITACOES = Object.freeze({ quantidade: 3, janelaMinutos: 60 });
const RESPOSTA_SOLICITACAO = Object.freeze({ status: 'SOLICITACAO_RECEBIDA' });

const MOTIVO_REDEFINIDA = 'SENHA_REDEFINIDA';
const ACAO = Object.freeze({
  SOLICITADA: 'REDEFINICAO_SENHA_SOLICITADA',
  RECUSADA: 'REDEFINICAO_SENHA_RECUSADA',
  REDEFINIDA: 'SENHA_REDEFINIDA',
});
const MOTIVO_POR_SITUACAO = Object.freeze({ USADA: 'PEDIDO_USADO', CANCELADA: 'PEDIDO_CANCELADO', EXPIRADA: 'PEDIDO_EXPIRADO' });
const TRAVA_CONSULTIVA = 'SELECT pg_advisory_xact_lock($1::bigint)';
const NOME_ERRO_FORMATO = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODIGO_FORMATO = /^[A-Za-z0-9_.]{1,40}$/;

const PERFIS = Object.freeze({
  PORTAL: {
    contaRepo: identidadeRepo,
    pedidoRepo: redefinicaoRepo,
    campoConta: 'identidadeId',
    chaveLogin: (email) => cooldown.gerarChaveCooldownGlobal(email),
    travarAntesDaConta: async () => {},
    auditar: (client, { contaId, acao, referencia = null, contexto, ip, dispositivo }) => auditoriaIdentidadeRepo.registrarEventoSistema(client, {
      identidadeId: contaId, acao, referencia, ip, dispositivo, contexto,
    }),
    revogarAcessos: async (client, contaId) => ({
      sessoesGlobaisRevogadas: await sessaoGlobalRepo.revogarTodasDaIdentidade(client, contaId, MOTIVO_REDEFINIDA),
      sessoesEmpresariaisRevogadas: await sessaoRepo.revogarTodasDaIdentidade(client, contaId, MOTIVO_REDEFINIDA),
    }),
  },
  PLATAFORMA: {
    contaRepo: administradorRepo,
    pedidoRepo: redefinicaoPlataformaRepo,
    campoConta: 'administradorId',
    chaveLogin: (email) => cooldown.gerarChaveCooldownPlataforma(email),
    travarAntesDaConta: (client, contaId) => travaRepo.travarAdministrador(client, contaId),
    // Evento do sistema na trilha da plataforma não grava IP nem dispositivo; a origem fica no pedido.
    auditar: (client, { contaId, acao, referencia = null, contexto }) => auditoriaPlataformaRepo.registrarEventoSistema(client, {
      administradorAfetadoId: contaId, acao, referencia, contexto,
    }),
    revogarAcessos: async (client, contaId) => ({
      sessoesRevogadas: await sessaoPlataformaRepo.revogarTodasDoAdministrador(client, contaId, MOTIVO_REDEFINIDA),
      desafiosEncerrados: await desafioRepo.encerrarAbertos(client, { administradorId: contaId, motivo: MOTIVO_REDEFINIDA }),
    }),
  },
});

/** Consumo do pedido perdido para outra transação: desfaz tudo e vira o erro genérico. */
class ConsumoPerdido extends Error {}

const redefinicaoInvalida = () => HttpError.badRequest('REDEFINICAO_INVALIDA', 'Link de redefinição inválido ou expirado');

function exigirPerfil(escopo) {
  if (typeof escopo !== 'string' || !Object.hasOwn(PERFIS, escopo)) {
    throw new TypeError('escopo de recuperação de senha inválido');
  }
  return PERFIS[escopo];
}

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

/** Só o nome e o código do erro: a mensagem pode trazer dado de quem chamou. */
function registrarFalha(evento, escopo, erro, chave = null) {
  const nome = erro && erro.constructor && erro.constructor.name;
  const registro = { evento, escopo, erro: typeof nome === 'string' && NOME_ERRO_FORMATO.test(nome) ? nome : 'Error' };
  if (erro && typeof erro.code === 'string' && CODIGO_FORMATO.test(erro.code)) {
    registro.codigo = erro.code;
  }
  if (chave !== null) {
    registro.correlacao = cooldown.idCorrelacaoCooldown(chave);
  }
  console.error('[recuperacao-senha]', registro);
}

/**
 * Chama a entrega depois do COMMIT. Nada do que acontecer aqui volta para
 * quem chamou: nem exceção, nem promessa rejeitada sem tratamento.
 */
function enfileirar(escopo, chamada) {
  try {
    const retorno = chamada();
    if (retorno && typeof retorno.then === 'function') {
      retorno.then(undefined, (erro) => registrarFalha('entrega_falhou', escopo, erro));
    }
  } catch (erro) {
    registrarFalha('entrega_falhou', escopo, erro);
  }
}

/**
 * Registra a solicitação de recuperação e, se a conta existir e estiver
 * ativa, cria o pedido e enfileira o e-mail com o link.
 *
 * @param {import('pg').Pool} pool
 * @param {{escopo: string, email: string, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{status: 'SOLICITACAO_RECEBIDA'}>} sempre o mesmo objeto
 */
async function solicitar(pool, { escopo, email, ip = null, dispositivo = null } = {}) {
  const perfil = exigirPerfil(escopo);

  let chave;
  let emailNormalizado;
  try {
    chave = cooldown.gerarChaveRecuperacaoSenha(escopo, email);
    emailNormalizado = normalizarEmail(email);
  } catch {
    return RESPOSTA_SOLICITACAO;
  }

  let mensagem;
  try {
    mensagem = await emTransacao(pool, async (client) => {
      await client.query(TRAVA_CONSULTIVA, [cooldown.derivarAdvisoryLock64(chave)]);

      const recentes = await solicitacaoRepo.contarRecentes(client, { escopo, chave, janelaMinutos: LIMITE_SOLICITACOES.janelaMinutos });
      if (recentes >= LIMITE_SOLICITACOES.quantidade) {
        return null;
      }
      await solicitacaoRepo.registrar(client, { escopo, chave, ip, dispositivo });

      const encontrada = await perfil.contaRepo.buscarPorEmail(client, emailNormalizado);
      if (encontrada === null) {
        return null;
      }
      const conta = await perfil.contaRepo.buscarPorIdParaAtualizacao(client, encontrada.id);
      if (conta === null) {
        return null;
      }
      if (!conta.ativo) {
        await perfil.auditar(client, {
          contaId: conta.id, acao: ACAO.RECUSADA, contexto: { etapa: 'SOLICITACAO', motivo: 'CONTA_INATIVA' }, ip, dispositivo,
        });
        return null;
      }

      const tokenClaro = token.gerarTokenSessao();
      const validadeMinutos = authConfig.recuperacaoSenha.validadeMinutos;
      const pedido = await perfil.pedidoRepo.criar(client, {
        [perfil.campoConta]: conta.id, tokenHash: token.hashTokenSessao(tokenClaro), validadeMinutos, ip, dispositivo,
      });
      await perfil.auditar(client, {
        contaId: conta.id,
        acao: ACAO.SOLICITADA,
        referencia: pedido.id,
        contexto: { pedidosSubstituidos: pedido.substituidos, validadeMinutos },
        ip,
        dispositivo,
      });
      return { email: conta.email, token: tokenClaro, expiraEm: pedido.expiraEm };
    });
  } catch (erro) {
    registrarFalha('solicitacao_falhou', escopo, erro, chave);
    return RESPOSTA_SOLICITACAO;
  }

  if (mensagem !== null) {
    enfileirar(escopo, () => entregaRecuperacao.enfileirarRedefinicao({ escopo, ...mensagem }));
  }
  return RESPOSTA_SOLICITACAO;
}

async function resolverRedefinicao(client, perfil, { tokenHash, novaSenha, ip, dispositivo }) {
  const lido = await perfil.pedidoRepo.buscarPorHash(client, tokenHash);
  if (lido === null) {
    return { tipo: 'INVALIDA' };
  }
  const contaId = lido[perfil.campoConta];
  const encontrada = await perfil.contaRepo.buscarPorId(client, contaId);
  if (encontrada === null) {
    return { tipo: 'INVALIDA' };
  }

  await client.query(TRAVA_CONSULTIVA, [cooldown.derivarAdvisoryLock64(perfil.chaveLogin(encontrada.email))]);
  await perfil.travarAntesDaConta(client, contaId);
  const conta = await perfil.contaRepo.buscarPorIdParaAtualizacao(client, contaId);
  if (conta === null) {
    return { tipo: 'INVALIDA' };
  }

  const recusar = async (motivo) => {
    await perfil.auditar(client, {
      contaId: conta.id, acao: ACAO.RECUSADA, referencia: lido.id, contexto: { etapa: 'REDEFINICAO', motivo }, ip, dispositivo,
    });
    return { tipo: 'INVALIDA' };
  };

  if (!conta.ativo) {
    return recusar('CONTA_INATIVA');
  }
  const pedido = await perfil.pedidoRepo.buscarPorHashParaAtualizacao(client, tokenHash);
  if (pedido === null || pedido[perfil.campoConta] !== conta.id) {
    return { tipo: 'INVALIDA' };
  }
  if (pedido.situacao !== perfil.pedidoRepo.SITUACAO.PENDENTE) {
    return recusar(MOTIVO_POR_SITUACAO[pedido.situacao]);
  }

  const politica = passwordPolicy.validarPoliticaSenha(novaSenha, { email: conta.email });
  if (!politica.ok) {
    return { tipo: 'SENHA_FORA_DA_POLITICA', detalhes: detalhesDePoliticaSenha(politica) };
  }
  const credencial = await perfil.contaRepo.buscarCredencialPorEmail(client, conta.email);
  if (credencial === null || credencial.id !== conta.id) {
    return { tipo: 'INVALIDA' };
  }
  if (await password.verificarSenha(credencial.senhaHash, novaSenha)) {
    return { tipo: 'SENHA_IGUAL_A_ATUAL' };
  }

  if (!(await perfil.pedidoRepo.marcarUsada(client, pedido.id))) {
    throw new ConsumoPerdido();
  }
  await perfil.contaRepo.atualizarSenhaHash(client, conta.id, await password.gerarHashSenha(novaSenha));
  const pedidosCancelados = await perfil.pedidoRepo.cancelarPendentes(client, conta.id, MOTIVO_REDEFINIDA);
  const revogados = await perfil.revogarAcessos(client, conta.id);
  await perfil.auditar(client, {
    contaId: conta.id,
    acao: ACAO.REDEFINIDA,
    referencia: pedido.id,
    contexto: { origem: 'LINK', ...revogados, pedidosCancelados },
    ip,
    dispositivo,
  });
  return { tipo: 'SUCESSO', email: conta.email };
}

/**
 * Troca a senha a partir do token do link. Não cria sessão.
 *
 * @param {import('pg').Pool} pool
 * @param {{escopo: string, token: string, novaSenha: string, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{status: 'SENHA_REDEFINIDA'}>}
 */
async function redefinir(pool, { escopo, token: tokenClaro, novaSenha, ip = null, dispositivo = null } = {}) {
  const perfil = exigirPerfil(escopo);
  if (!token.tokenSessaoTemFormatoValido(tokenClaro)) {
    throw redefinicaoInvalida();
  }
  const tokenHash = token.hashTokenSessao(tokenClaro);

  let desfecho;
  try {
    // Recusa de negócio termina em COMMIT, para a auditoria da recusa ficar.
    desfecho = await emTransacao(pool, (client) => resolverRedefinicao(client, perfil, { tokenHash, novaSenha, ip, dispositivo }));
  } catch (erro) {
    if (erro instanceof ConsumoPerdido) {
      throw redefinicaoInvalida();
    }
    throw erro;
  }

  switch (desfecho.tipo) {
    case 'SUCESSO':
      enfileirar(escopo, () => entregaRecuperacao.enfileirarAvisoSenhaAlterada({ escopo, email: desfecho.email }));
      return { status: 'SENHA_REDEFINIDA' };
    case 'SENHA_FORA_DA_POLITICA':
      throw HttpError.validacao(desfecho.detalhes);
    case 'SENHA_IGUAL_A_ATUAL':
      throw HttpError.badRequest('SENHA_IGUAL_A_ATUAL', 'A nova senha deve ser diferente da senha atual');
    default:
      throw redefinicaoInvalida();
  }
}

module.exports = { ESCOPOS, LIMITE_SOLICITACOES, RESPOSTA_SOLICITACAO, solicitar, redefinir };
