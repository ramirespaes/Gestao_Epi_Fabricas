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
const fatorRepo = require('../repositories/fator-mfa-plataforma.repository');
const liberacaoRepo = require('../repositories/liberacao-cadastro-mfa-plataforma.repository');
const loteRepo = require('../repositories/lote-recuperacao-mfa-plataforma.repository');
const codigoRepo = require('../repositories/codigo-recuperacao-mfa-plataforma.repository');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria-plataforma.repository');
const tentativaRepo = require('../repositories/login-tentativa-plataforma.repository');
const desafioService = require('./desafio-mfa-plataforma.service');

/**
 * Primeiro cadastro do TOTP de um administrador da plataforma:
 *
 *   LIBERACAO --(código do CLI)--> CADASTRO --(primeiro TOTP)--> sessão plena
 *
 * Cada etapa roda numa transação, com a trava do administrador primeiro e
 * o desafio relido com trava de linha. A sessão plena só nasce aqui, depois
 * do primeiro TOTP válido, com token próprio (o do desafio nunca vira
 * sessão). O secret em claro existe só em memória: é cifrado antes de ir ao
 * banco e zerado depois de montar a URI e a chave manual.
 *
 * FAIL-CLOSED: qualquer falha da criptografia (chave indisponível,
 * envelope inválido, tag que não confere) desfaz a transação inteira e
 * responde 503 MFA_INDISPONIVEL. A liberação não é consumida, nenhum
 * PENDENTE fica, nenhuma falha é atribuída ao administrador. O evento vai
 * para a auditoria com ator SISTEMA, numa transação própria. Nunca é
 * tratado como "MFA não configurado".
 *
 * Código errado conta: tentativa em login_tentativas_plataforma (chave de
 * MFA por administrador), falha no desafio (no limite, o desafio é
 * encerrado) e cooldown de MFA pelos mesmos níveis do login. Com o
 * cooldown vigente, nenhum código é conferido.
 *
 * Dependências chamadas por namespace, para os testes poderem substituí-las.
 */

const MAXIMO_REINICIOS = 3;
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
 * Erro de criptografia vira 503 depois do ROLLBACK.
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

/** Trava do administrador, desafio relido com trava e do tipo esperado, cooldown de MFA. */
async function abrirEtapa(client, { desafioId, administradorId, tipo }) {
  await travaRepo.travarAdministrador(client, administradorId);
  const desafio = await desafioRepo.buscarValidoPorId(client, { desafioId, administradorId }, { travar: true });
  if (desafio === null || desafio.tipo !== tipo) {
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
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipo: 'LIBERACAO' });
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
 * Novo secret para o mesmo desafio CADASTRO (QR novo), no máximo 3 vezes.
 * O PENDENTE anterior é revogado (ciphertext apagado); o ATIVO, se houver,
 * não é tocado. Falha de criptografia não conta como reinício.
 */
async function reiniciarCadastro(pool, dados) {
  const { desafioId, administradorId } = dados;
  const origem = origemDa(dados);
  await exigirChaveAtual(pool, administradorId, 'cadastro_reinicio');

  return executarEtapa(pool, { administradorId, operacao: 'cadastro_reinicio' }, async (client) => {
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipo: 'CADASTRO' });
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
      return { resultado: { desafio: { etapa: 'CADASTRO', expiraEm: desafio.expiraEm }, cadastro: entrega } };
    } finally {
      novo.segredo.fill(0);
    }
  });
}

function gerarCodigosRecuperacao(administradorId) {
  const codigos = Array.from({ length: QUANTIDADE_CODIGOS_RECUPERACAO }, () => codigosMfa.gerarCodigo());
  const hashes = codigos.map((codigo) => codigosMfa.hashCodigoRecuperacao({ administradorId, codigo: codigosMfa.normalizarCodigo(codigo) }));
  return { codigos, hashes };
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
    const etapa = await abrirEtapa(client, { desafioId, administradorId, tipo: 'CADASTRO' });
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
    const segredo = mfaCripto.decifrarSegredoTotp({
      administradorId,
      fatorUid: fator.fatorUid,
      formatoVersao: fator.formatoVersao,
      chaveVersao: fator.chaveVersao,
      nonce: fator.nonce,
      segredoCifrado: fator.segredoCifrado,
    });
    let aceito;
    try {
      aceito = totp.validarCodigo({ segredo, codigo, instanteMs: agora.getTime() });
    } finally {
      segredo.fill(0);
    }
    if (aceito === null) {
      return registrarFalha(client, { administradorId, desafio, chave, motivo: 'TOTP_INVALIDO', origem });
    }

    if (!(await fatorRepo.ativarTotp(client, { administradorId, fatorId: fator.id, step: aceito.step }))) {
      return { erro: HttpError.conflict('MFA_CADASTRO_EXPIRADO', 'O cadastro expirou. Gere um novo código ou entre de novo com a senha') };
    }

    await loteRepo.revogarAtivo(client, { administradorId, motivo: 'NOVO_CADASTRO' });
    const lote = await loteRepo.criar(client, administradorId);
    const recuperacao = gerarCodigosRecuperacao(administradorId);
    if ((await codigoRepo.inserirHashes(client, { administradorId, loteId: lote.id, hashes: recuperacao.hashes })) !== recuperacao.hashes.length) {
      throw new Error('lote de recovery codes incompleto');
    }

    await tentativaRepo.registrarTentativa(client, { chaveCooldown: chave, administradorId, sucesso: true, ...origem });
    await desafioRepo.encerrar(client, { desafioId: desafio.id, motivo: 'CONCLUIDO' });

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
      mfa: { verificadoEm: agora, metodo: 'CADASTRO' },
    });
    await desafioRepo.ligarSessaoCriada(client, { desafioId: desafio.id, sessaoId });

    await auditoriaRepo.registrar(client, {
      administradorId, acao: 'MFA_CADASTRO_CONCLUIDO', referencia: fator.id, contexto: { metodo: 'CADASTRO', fatorUid: fator.fatorUid }, ...origem,
    });

    return { resultado: { token: tokenSessao, sessao: { id: sessaoId, expiraEm }, codigosRecuperacao: recuperacao.codigos } };
  });
}

module.exports = { confirmarLiberacao, reiniciarCadastro, confirmarCadastro, MAXIMO_REINICIOS };
