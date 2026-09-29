'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');
const mfaCripto = require('../security/mfa-cripto');
const totp = require('../security/totp');
const codigosMfa = require('../security/codigos-mfa');
const cooldown = require('../security/cooldown');
const token = require('../security/token');
const travaRepo = require('../repositories/trava-mfa-plataforma.repository');
const desafioRepo = require('../repositories/desafio-mfa-plataforma.repository');
const loteRepo = require('../repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../repositories/codigo-recuperacao-mfa-plataforma.repository');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria-plataforma.repository');
const tentativaRepo = require('../repositories/login-tentativa-plataforma.repository');

/**
 * Base comum das etapas do MFA do Painel Privado.
 *
 * Cada etapa roda numa transação, com a trava do administrador primeiro e
 * o desafio relido com trava de linha. O secret em claro existe só em
 * memória: é cifrado antes de ir ao banco e zerado depois de montar a URI e
 * a chave manual.
 *
 * FAIL-CLOSED: qualquer falha da criptografia (chave indisponível,
 * envelope inválido, tag que não confere) desfaz a transação inteira e
 * responde 503 MFA_INDISPONIVEL. Nada é consumido, nenhum PENDENTE fica,
 * nenhuma falha é atribuída ao administrador. O evento vai para a auditoria
 * com ator SISTEMA, numa transação própria. Nunca é tratado como "MFA não
 * configurado".
 *
 * Código errado conta: tentativa em login_tentativas_plataforma (chave de
 * MFA por administrador), falha no desafio (no limite, o desafio é
 * encerrado) e cooldown de MFA pelos mesmos níveis do login. Com o
 * cooldown vigente, nenhum código é conferido.
 *
 * Dependências chamadas por namespace, para os testes poderem substituí-las.
 */

const QUANTIDADE_CODIGOS_RECUPERACAO = 10;
const MINUTOS_PARA_MS = 60_000;
const MOTIVOS_CRIPTOGRAFIA = new Set(Object.values(mfaCripto.MOTIVOS));

const desafioInvalido = () => HttpError.unauthorized('DESAFIO_INVALIDO', 'Etapa de verificação inválida ou expirada');
const codigoInvalido = () => HttpError.unauthorized('MFA_CODIGO_INVALIDO', 'Código inválido');
const indisponivel = () => new HttpError(503, 'MFA_INDISPONIVEL', 'Verificação em duas etapas indisponível no momento');

function emCooldown(ativoAte) {
  // Date.now() aqui é só a dica do Retry-After, fora da transação.
  const retryAfterSegundos = Math.max(1, Math.ceil((ativoAte.getTime() - Date.now()) / 1000));
  return HttpError.tooManyRequests('MFA_EM_COOLDOWN', 'Muitas tentativas. Tente novamente mais tarde', { retryAfterSegundos });
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

/** Log estruturado e evento SISTEMA; o 503 prevalece mesmo se a auditoria falhar. */
async function registrarIndisponibilidade(pool, administradorId, operacao, erro) {
  const motivo = MOTIVOS_CRIPTOGRAFIA.has(erro.motivo) ? erro.motivo : 'DESCONHECIDO';
  console.error('[mfa]', { evento: 'mfa_criptografia_indisponivel', operacao, motivo });
  try {
    await auditoriaRepo.registrarEventoSistema(pool, {
      administradorAfetadoId: administradorId,
      acao: 'MFA_CHAVE_INDISPONIVEL',
      contexto: { operacao, motivo },
    });
  } catch {
    console.error('[mfa]', { evento: 'mfa_auditoria_indisponibilidade_falhou', operacao });
  }
}

/**
 * Roda a etapa numa transação. A etapa devolve { erro } para um desfecho de
 * negócio já persistido (COMMIT e depois o HttpError) ou { resultado }.
 * Erro lançado de dentro da etapa desfaz tudo. Erro de criptografia vira
 * 503 depois do ROLLBACK.
 */
async function executarEtapa(pool, { administradorId, operacao }, etapa) {
  let desfecho;
  try {
    desfecho = await emTransacao(pool, etapa);
  } catch (erro) {
    if (erro instanceof mfaCripto.ErroCriptografiaMfa) {
      await registrarIndisponibilidade(pool, administradorId, operacao, erro);
      throw indisponivel();
    }
    throw erro;
  }
  if (desfecho.erro) {
    throw desfecho.erro;
  }
  return desfecho.resultado;
}

/** Antes de abrir transação: sem a chave atual, nada é tocado. */
async function exigirChaveAtual(pool, administradorId, operacao) {
  try {
    mfaCripto.garantirChaveAtual();
  } catch (erro) {
    if (erro instanceof mfaCripto.ErroCriptografiaMfa) {
      await registrarIndisponibilidade(pool, administradorId, operacao, erro);
      throw indisponivel();
    }
    throw erro;
  }
}

/** Trava do administrador, desafio relido com trava e de um dos tipos aceitos, cooldown de MFA. */
async function abrirEtapa(client, { desafioId, administradorId, tipos }) {
  await travaRepo.travarAdministrador(client, administradorId);
  const desafio = await desafioRepo.buscarValidoPorId(client, { desafioId, administradorId }, { travar: true });
  if (desafio === null || !tipos.includes(desafio.tipo) || desafio.falhas >= authConfig.desafioMfa.maxFalhas) {
    return { erro: desafioInvalido() };
  }
  const chave = cooldown.gerarChaveCooldownMfaPlataforma(administradorId);
  const vigente = await tentativaRepo.buscarCooldownVigente(client, chave);
  if (vigente !== null) {
    return { erro: emCooldown(vigente.ativoAte) };
  }
  return { desafio, chave };
}

async function instanteDoBanco(client) {
  const { rows } = await client.query('SELECT clock_timestamp() AS agora');
  return rows[0].agora;
}

/** Mesmos níveis do login por senha, sobre a chave de MFA do administrador. */
async function aplicarCooldown(client, { administradorId, chave, origem }) {
  const agora = await instanteDoBanco(client);
  let duracaoMinutos = null;
  for (const nivel of authConfig.cooldown.niveis) {
    const desde = new Date(agora.getTime() - nivel.janelaMinutos * MINUTOS_PARA_MS);
    const total = await tentativaRepo.contarFalhasRecentes(client, chave, desde);
    if (total >= nivel.falhas && (duracaoMinutos === null || nivel.duracaoMinutos > duracaoMinutos)) {
      duracaoMinutos = nivel.duracaoMinutos;
    }
  }
  if (duracaoMinutos === null) {
    return;
  }
  await tentativaRepo.registrarAtivacaoCooldown(client, {
    chaveCooldown: chave, cooldownAte: new Date(agora.getTime() + duracaoMinutos * MINUTOS_PARA_MS), administradorId, ...origem,
  });
  await auditoriaRepo.registrar(client, {
    administradorId, acao: 'MFA_COOLDOWN_ATIVADO', contexto: { etapa: 'pre_mfa', duracaoMinutos }, ...origem,
  });
}

/** Código errado: tentativa, falha no desafio (encerra no limite) e cooldown. */
async function registrarFalha(client, { administradorId, desafio, chave, motivo, origem }) {
  await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: false, motivo, ...origem });
  const falhas = await desafioRepo.incrementarFalhas(client, desafio.id);
  if (falhas !== null && falhas >= authConfig.desafioMfa.maxFalhas) {
    await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'FALHAS_EXCEDIDAS' });
    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'MFA_DESAFIO_ESGOTADO', referencia: desafio.id, contexto: { etapa: 'pre_mfa', tipoDesafio: desafio.tipo }, ...origem,
    });
  }
  await aplicarCooldown(client, { administradorId, chave, origem });
  return { erro: codigoInvalido() };
}

/** Secret novo e fator_uid novo, já cifrados. Quem chama zera o secret. */
function novoSegredoCifrado(administradorId) {
  const fatorUid = crypto.randomUUID();
  const segredo = totp.gerarSegredo();
  try {
    return { fatorUid, segredo, envelope: mfaCripto.cifrarSegredoTotp({ segredo, administradorId, fatorUid }) };
  } catch (erro) {
    segredo.fill(0);
    throw erro;
  }
}

/** URI otpauth e chave manual, só para a resposta desta etapa. */
async function entregaDoCadastro(client, administradorId, segredo) {
  const { email } = await administradorRepo.buscarPorId(client, administradorId);
  return { uri: totp.montarUriCadastro({ segredo, email }), chaveManual: totp.chaveManual(segredo) };
}

const origemDa = ({ ip, dispositivo }) => ({ ip: ipParaGravar(ip ?? null), dispositivo: dispositivoParaGravar(dispositivo ?? null) });

function gerarCodigosRecuperacao(administradorId) {
  const codigos = Array.from({ length: QUANTIDADE_CODIGOS_RECUPERACAO }, () => codigosMfa.gerarCodigo());
  const hashes = codigos.map((codigo) => codigosMfa.hashCodigoRecuperacao({ administradorId, codigo: codigosMfa.normalizarCodigo(codigo) }));
  return { codigos, hashes };
}

/** Revoga o lote ativo e cria outro; os códigos em claro só voltam para a resposta. */
async function emitirLoteRecuperacao(client, { administradorId, motivoRevogacao }) {
  await loteRepo.revogarAtivo(client, { administradorId, motivo: motivoRevogacao });
  const lote = await loteRepo.criar(client, administradorId);
  const recuperacao = gerarCodigosRecuperacao(administradorId);
  if ((await codigoRepo.inserirHashes(client, { administradorId, loteId: lote.id, hashes: recuperacao.hashes })) !== recuperacao.hashes.length) {
    throw new Error('lote de recovery codes incompleto');
  }
  return recuperacao.codigos;
}

function validarTotpDoFator({ administradorId, fator, codigo, agora }) {
  const segredo = mfaCripto.decifrarSegredoTotp({
    administradorId,
    fatorUid: fator.fatorUid,
    formatoVersao: fator.formatoVersao,
    chaveVersao: fator.chaveVersao,
    nonce: fator.nonce,
    segredoCifrado: fator.segredoCifrado,
  });
  try {
    return totp.validarCodigo({ segredo, codigo, instanteMs: agora.getTime() });
  } finally {
    segredo.fill(0);
  }
}

// Só a sessão que este navegador apresentou é trocada; as de outros dispositivos seguem válidas.
async function criarSessaoPlena(client, { administradorId, desafioId, agora, metodo, tokenSessaoAnterior, origem }) {
  if (token.tokenSessaoTemFormatoValido(tokenSessaoAnterior)) {
    const anterior = await sessaoRepo.buscarValidaPorHash(client, token.hashTokenSessao(tokenSessaoAnterior), authConfig.sessao.inatividadeMinutos);
    if (anterior !== null) {
      await sessaoRepo.revogar(client, anterior.sessao.id, 'SUBSTITUIDA_NO_NAVEGADOR');
    }
  }

  const tokenSessao = token.gerarTokenSessao();
  const expiraEm = new Date(agora.getTime() + authConfig.sessao.expiracaoMinutosAdmin * MINUTOS_PARA_MS);
  const sessaoId = await sessaoRepo.criar(client, {
    administradorId,
    tokenHash: token.hashTokenSessao(tokenSessao),
    expiraEm,
    ...origem,
    mfa: { verificadoEm: agora, metodo },
  });
  await desafioRepo.ligarSessaoCriada(client, { desafioId, sessaoId });
  return { token: tokenSessao, sessao: { id: sessaoId, expiraEm } };
}

module.exports = {
  desafioInvalido,
  codigoInvalido,
  emCooldown,
  emTransacao,
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
  criarSessaoPlena,
};
