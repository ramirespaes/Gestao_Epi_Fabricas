'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { normalizarEmail } = require('../utils/normalizacao');
const { detalhesDePoliticaSenha } = require('../middleware/validar');
const autoridade = require('./autoridade-administrativa');
const { perfisGerenciaveis } = require('./usuario-administracao.service');
const entrega = require('./entrega-convite-usuario.service');
const empresaRepo = require('../repositories/empresa.repository');
const conviteRepo = require('../repositories/convite-usuario.repository');
const tentativaRepo = require('../repositories/convite-usuario-tentativa.repository');
const identidadeRepo = require('../repositories/identidade.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const usuarioAdministracaoRepo = require('../repositories/usuario-administracao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const passwordPolicy = require('../security/password-policy');
const token = require('../security/token');

/**
 * Convite de usuário da empresa (Bloco 9, parte F, decisão D1). Mesmo
 * desenho do convite do MASTER (convite-master.service.js), com quem
 * convida sendo um usuário da própria empresa:
 *
 *   CRIAR / LISTAR / CANCELAR: MASTER, ou ADMINISTRADOR com
 *     GERENCIAR_USUARIOS (D2), com as regras de perfil D3. A empresa vem
 *     da sessão. Criação serializada por (empresa, e-mail) com trava
 *     consultiva; e-mail que já tem vínculo NESTA empresa é recusado.
 *     Vínculo da mesma pessoa em OUTRA empresa não muda nada na resposta:
 *     quem convida nunca descobre onde mais a pessoa trabalha.
 *   ACEITAR (público, o token é a autoridade): identidade nova define a
 *     própria senha (política completa, Argon2id); identidade existente
 *     prova a senha atual e ganha só o vínculo. Cooldown por token, uso
 *     único com FOR UPDATE e condição de estado no UPDATE.
 *
 * Token: 32 bytes aleatórios; só o SHA-256 fica no banco. O token em claro
 * existe na criação (para a entrega) e no aceite. Nunca em log, auditoria
 * ou mensagem de erro.
 *
 * Desfechos de negócio do aceite (senha errada, cooldown) são lançados
 * DEPOIS do COMMIT, para a tentativa negada ficar gravada e contar.
 */

const MINUTOS_PARA_MS = 60_000;
const TAMANHO_MAXIMO_IP = 45;
const TAMANHO_MAXIMO_DISPOSITIVO = 150;
const VIOLACAO_UNIQUE = '23505';
const CONSTRAINT_VINCULO = 'uq_usuarios_empresa_identidade';
const CONSTRAINT_IDENTIDADE_EMAIL = 'uq_identidades_email_lower';
const ORIGEM_AUDITORIA = Object.freeze({ origem: 'administracao_usuarios' });

const ACAO = Object.freeze({
  CONVIDADO: 'USUARIO_CONVIDADO',
  CANCELADO: 'USUARIO_CONVITE_CANCELADO',
  CRIADO: 'USUARIO_CRIADO',
});

const MSG = Object.freeze({
  NAO_AUTORIZADO: 'Sem autoridade para administrar os usuários da empresa',
  PERFIL: 'Somente o MASTER gerencia usuários MASTER e ADMINISTRADOR',
  EMAIL_INVALIDO: 'E-mail inválido',
  VINCULO_EXISTENTE: 'Este e-mail já tem um usuário nesta empresa. Se ele estiver inativo, reative-o em Administração de usuários',
  JA_PENDENTE: 'Já existe um convite em aberto para este e-mail nesta empresa',
  NAO_ENCONTRADO: 'Convite não encontrado',
  NAO_CANCELAVEL: 'Convite já aceito ou já cancelado não pode ser cancelado',
  INVALIDO: 'Convite inválido',
  EXPIRADO: 'Convite expirado',
  CANCELADO: 'Convite cancelado',
  JA_UTILIZADO: 'Convite já utilizado',
  EMPRESA_INATIVA: 'Aceite indisponível: a empresa está inativa',
  CREDENCIAIS: 'Senha inválida',
  COOLDOWN: 'Muitas tentativas. Tente novamente mais tarde',
  VINCULO_NO_ACEITE: 'Esta conta já possui usuário nesta empresa',
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function cortar(valor, tamanhoMaximo) {
  if (typeof valor !== 'string') {
    return null;
  }
  return valor.length > tamanhoMaximo ? valor.slice(0, tamanhoMaximo) : valor;
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }
}

async function buscarInstanteReal(client) {
  const { rows } = await client.query('SELECT clock_timestamp() AS agora');
  return rows[0].agora;
}

const somarMinutos = (data, minutos) => new Date(data.getTime() + minutos * MINUTOS_PARA_MS);

/** Trava da criação por (empresa, e-mail): a ausência de convite também precisa ser serializada. */
function travaDeCriacao(empresaId, emailNormalizado) {
  const digest = crypto.createHash('sha256').update(`CONVITE_USUARIO_CRIACAO\n${empresaId}\n${emailNormalizado}`, 'utf8').digest('hex');
  return cooldown.derivarAdvisoryLock64(digest);
}

function exigirPerfilGerenciavel(ator, perfil) {
  if (!perfisGerenciaveis(ator).includes(perfil)) {
    throw HttpError.forbidden('USUARIO_PERFIL_NAO_PERMITIDO', MSG.PERFIL);
  }
}

const exigirEscrita = (client, empresaId, atorId) => autoridade.exigirAutoridadeAdministrativa(
  client, empresaId, atorId, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA', MSG.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
);

/** O que quem administra vê de um convite: nada de hash, identidade ou vínculo. */
const apresentar = (convite) => ({
  id: convite.id,
  emailConvite: convite.emailConvite,
  nome: convite.nome,
  perfil: convite.perfil,
  situacao: convite.situacao,
  criadoEm: convite.criadoEm,
  expiraEm: convite.expiraEm,
  canceladoEm: convite.canceladoEm,
});

async function registrarAuditoria(client, {
  empresaId, usuarioId, acao, referencia, ip, dispositivo, contexto, dadosNovos,
}) {
  await auditoriaRepo.registrar(client, {
    empresaId,
    usuarioId,
    acao,
    referencia: String(referencia),
    ip: cortar(ip, TAMANHO_MAXIMO_IP),
    dispositivo: cortar(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO),
    contexto,
    dadosNovos,
  });
}

// ---------------------------------------------------------------------------
// Quem administra: criar / listar / cancelar
// ---------------------------------------------------------------------------

/**
 * Cria o convite e devolve o token EM CLARO uma única vez, para o
 * controller entregá-lo. Nunca o persiste.
 * @returns {Promise<{convite: object, token: string}>}
 */
async function criar(pool, {
  empresaId, atorId, email, nome, perfil, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const emailN = normalizarEmail(email);
  if (emailN === null) {
    throw HttpError.badRequest('CONVITE_EMAIL_INVALIDO', MSG.EMAIL_INVALIDO);
  }
  entrega.exigirDisponivel();

  return emTransacao(pool, async (client) => {
    const ator = await exigirEscrita(client, empresaId, atorId);
    exigirPerfilGerenciavel(ator, perfil);

    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [travaDeCriacao(empresaId, emailN)]);

    if (await usuarioAdministracaoRepo.buscarVinculoPorEmail(client, empresaId, emailN) !== null) {
      throw HttpError.conflict('USUARIO_VINCULO_EXISTENTE', MSG.VINCULO_EXISTENTE);
    }
    if (await conviteRepo.buscarPendentePorEmailParaAtualizacao(client, empresaId, emailN) !== null) {
      throw HttpError.conflict('CONVITE_JA_PENDENTE', MSG.JA_PENDENTE);
    }

    const agora = await buscarInstanteReal(client);
    // Mesmo prazo curto do convite do MASTER (CONVITE_MASTER_EXPIRACAO_MINUTOS).
    const expiraEm = somarMinutos(agora, authConfig.conviteMaster.expiracaoMinutos);
    const tokenClaro = token.gerarTokenSessao();
    const convite = await conviteRepo.criar(client, {
      empresaId, emailConvite: emailN, nome, perfil, tokenHash: token.hashTokenSessao(tokenClaro), criadoPor: ator.id, expiraEm,
    });

    // SEC-023/PRIV-001: e-mail, nome, perfil e expiração já ficam no
    // registro do convite, que é histórico (ON DELETE RESTRICT) e não tem
    // esses campos alterados depois. A auditoria só aponta para ele.
    await registrarAuditoria(client, {
      empresaId, usuarioId: ator.id, acao: ACAO.CONVIDADO, referencia: convite.id, ip, dispositivo,
      contexto: { ...ORIGEM_AUDITORIA },
      dadosNovos: { conviteId: convite.id },
    });

    return { convite: apresentar(convite), token: tokenClaro };
  });
}

async function listarEmAberto(pool, {
  empresaId, atorId, pagina = 1, limite = 20,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const ator = await autoridade.exigirAutoridadeAdministrativaLeitura(
    pool, empresaId, atorId, 'USUARIO_ADMINISTRACAO_NAO_AUTORIZADA', MSG.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
  );
  const { convites, total } = await conviteRepo.listarEmAberto(pool, empresaId, { pagina, limite });
  const gerenciaveis = perfisGerenciaveis(ator);
  return {
    convites: convites.map((convite) => ({
      ...apresentar(convite),
      criadoPor: { nome: convite.criadoPorNome },
      podeCancelar: gerenciaveis.includes(convite.perfil),
    })),
    total,
    pagina,
    limite,
    paginas: Math.ceil(total / limite),
    perfisGerenciaveis: [...gerenciaveis],
  };
}

async function cancelar(pool, {
  empresaId, atorId, conviteId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  return emTransacao(pool, async (client) => {
    const ator = await exigirEscrita(client, empresaId, atorId);
    const convite = await conviteRepo.buscarPorIdParaAtualizacao(client, empresaId, conviteId);
    if (convite === null) {
      throw HttpError.notFound('CONVITE_NAO_ENCONTRADO', MSG.NAO_ENCONTRADO);
    }
    exigirPerfilGerenciavel(ator, convite.perfil);
    const cancelado = await conviteRepo.cancelar(client, empresaId, conviteId);
    if (cancelado === null) {
      throw HttpError.conflict('CONVITE_NAO_CANCELAVEL', MSG.NAO_CANCELAVEL);
    }
    await registrarAuditoria(client, {
      empresaId, usuarioId: ator.id, acao: ACAO.CANCELADO, referencia: cancelado.id, ip, dispositivo,
      contexto: { ...ORIGEM_AUDITORIA },
      dadosNovos: { conviteId: cancelado.id, canceladoEm: cancelado.canceladoEm },
    });
    return apresentar(cancelado);
  });
}

// ---------------------------------------------------------------------------
// Pessoa convidada: consultar / aceitar (sem sessão)
// ---------------------------------------------------------------------------

function erroDaSituacao(convite) {
  const { SITUACAO } = conviteRepo;
  if (convite.situacao === SITUACAO.ACEITO) return HttpError.conflict('CONVITE_JA_UTILIZADO', MSG.JA_UTILIZADO);
  if (convite.situacao === SITUACAO.CANCELADO) return HttpError.conflict('CONVITE_CANCELADO', MSG.CANCELADO);
  if (convite.situacao === SITUACAO.EXPIRADO) return HttpError.conflict('CONVITE_EXPIRADO', MSG.EXPIRADO);
  return null;
}

/** Token em formato canônico vira hash; qualquer outra coisa é "convite inválido", sem tocar o banco. */
function hashDoTokenOuNull(tokenClaro) {
  return token.tokenSessaoTemFormatoValido(tokenClaro) ? token.hashTokenSessao(tokenClaro) : null;
}

async function empresaAtiva(executor, empresaId) {
  const empresa = await empresaRepo.buscarDetalhesPorId(executor, empresaId);
  return empresa !== null && empresa.ativo === true ? empresa : null;
}

/**
 * O que a pessoa precisa ver antes de enviar o formulário: empresa, e-mail,
 * nome, perfil, prazo e se a conta já existe (para pedir "defina sua
 * senha" ou "confirme sua senha atual"). Não consome o convite.
 */
async function consultarPorToken(pool, { token: tokenClaro }) {
  const tokenHash = hashDoTokenOuNull(tokenClaro);
  const convite = tokenHash === null ? null : await conviteRepo.buscarPorHash(pool, tokenHash);
  if (convite === null) {
    throw HttpError.notFound('CONVITE_INVALIDO', MSG.INVALIDO);
  }
  const erro = erroDaSituacao(convite);
  if (erro !== null) {
    throw erro;
  }
  const empresa = await empresaAtiva(pool, convite.empresaId);
  if (empresa === null) {
    throw HttpError.conflict('CONVITE_EMPRESA_INATIVA', MSG.EMPRESA_INATIVA);
  }
  const identidade = await identidadeRepo.buscarPorEmail(pool, convite.emailConvite);
  return {
    situacao: convite.situacao,
    empresa: { razaoSocial: empresa.razaoSocial },
    emailConvite: convite.emailConvite,
    nome: convite.nome,
    perfil: convite.perfil,
    expiraEm: convite.expiraEm,
    identidadeExistente: identidade !== null,
  };
}

/** Grava a falha e ativa o cooldown do maior nível cruzado (mesma regra do login). */
async function tratarFalha(client, { chaveCooldown, conviteId, motivo, ip, dispositivo }) {
  await tentativaRepo.registrarTentativa(client, { chaveCooldown, conviteId, sucesso: false, motivo, ip, dispositivo });
  const agora = await buscarInstanteReal(client);
  let duracao = null;
  for (const nivel of authConfig.cooldown.niveis) {
    const total = await tentativaRepo.contarFalhasRecentes(client, chaveCooldown, somarMinutos(agora, -nivel.janelaMinutos));
    if (total >= nivel.falhas && (duracao === null || nivel.duracaoMinutos > duracao)) {
      duracao = nivel.duracaoMinutos;
    }
  }
  if (duracao !== null) {
    await tentativaRepo.registrarAtivacaoCooldown(client, {
      chaveCooldown, cooldownAte: somarMinutos(agora, duracao), conviteId, ip, dispositivo,
    });
  }
}

function traduzirViolacaoAceite(erro) {
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_VINCULO) {
    return HttpError.conflict('CONVITE_VINCULO_EXISTENTE', MSG.VINCULO_NO_ACEITE);
  }
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_IDENTIDADE_EMAIL) {
    return HttpError.conflict('CONVITE_IDENTIDADE_CONCORRENTE', 'Conta criada ao mesmo tempo por outro acesso; repita o aceite');
  }
  return erro;
}

/** Resolve a identidade (criando, se nova) e cria o vínculo; devolve o desfecho em vez de lançar. */
async function resolverAceite(client, { convite, senha, chaveCooldown, ip, dispositivo }) {
  const credencial = await identidadeRepo.buscarCredencialPorEmail(client, convite.emailConvite);

  let identidadeId;
  let identidadeCriada;
  if (credencial === null) {
    const politica = passwordPolicy.validarPoliticaSenha(senha, { email: convite.emailConvite });
    if (!politica.ok) {
      return { tipo: 'SENHA_FORA_DA_POLITICA', detalhes: detalhesDePoliticaSenha(politica, 'body.senha') };
    }
    const identidade = await identidadeRepo.criar(client, { email: convite.emailConvite, senhaHash: await password.gerarHashSenha(senha) });
    identidadeId = identidade.id;
    identidadeCriada = true;
  } else {
    // Verifica sempre que existe hash real, ativa ou não (CLAUDE.md §17).
    const senhaOk = await password.verificarSenha(credencial.senhaHash, senha);
    if (credencial.ativo !== true || !senhaOk) {
      await tratarFalha(client, {
        chaveCooldown, conviteId: convite.id, motivo: credencial.ativo !== true ? 'IDENTIDADE_INATIVA' : 'SENHA_INVALIDA', ip, dispositivo,
      });
      return { tipo: 'CREDENCIAIS_INVALIDAS' };
    }
    identidadeId = credencial.id;
    identidadeCriada = false;
  }

  const usuario = await usuarioRepo.criar(client, {
    empresaId: convite.empresaId, nome: convite.nome, perfil: convite.perfil, identidadeId,
  });
  if (await conviteRepo.marcarAceito(client, convite.id, { identidadeId, usuarioId: usuario.id }) === null) {
    throw new Error(`convite ${convite.id} deixou de ser pendente durante o aceite`);
  }
  await tentativaRepo.registrarTentativa(client, { chaveCooldown, conviteId: convite.id, sucesso: true, ip, dispositivo });

  // Trilha da empresa, atribuída ao NOVO usuário; quem convidou vai no contexto.
  await registrarAuditoria(client, {
    empresaId: convite.empresaId, usuarioId: usuario.id, acao: ACAO.CRIADO, referencia: usuario.id, ip, dispositivo,
    contexto: { origem: 'aceite_convite_usuario', conviteId: convite.id, conviteCriadoPor: convite.criadoPor, identidadeCriada },
    dadosNovos: { usuarioId: usuario.id, nome: usuario.nome, perfil: usuario.perfil },
  });

  const empresa = await empresaRepo.buscarDetalhesPorId(client, convite.empresaId);
  return {
    tipo: 'SUCESSO',
    resultado: {
      empresa: { razaoSocial: empresa === null ? null : empresa.razaoSocial },
      usuario: { nome: usuario.nome, perfil: usuario.perfil },
      identidadeCriada,
    },
  };
}

/**
 * Aceita o convite. Não cria sessão: a pessoa entra depois pelo login do
 * Portal, com o e-mail e a senha dela.
 */
async function aceitar(pool, {
  token: tokenClaro, senha, ip = null, dispositivo = null,
}) {
  const tokenHash = hashDoTokenOuNull(tokenClaro);
  if (tokenHash === null) {
    throw HttpError.notFound('CONVITE_INVALIDO', MSG.INVALIDO);
  }
  if (typeof senha !== 'string' || senha.length === 0) {
    throw HttpError.badRequest('CONVITE_SENHA_INVALIDA', MSG.CREDENCIAIS);
  }
  const chaveCooldown = cooldown.gerarChaveCooldownConviteUsuario(tokenClaro);
  const ipP = cortar(ip, TAMANHO_MAXIMO_IP);
  const dispositivoP = cortar(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO);

  const client = await pool.connect();
  let desfecho;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [cooldown.derivarAdvisoryLock64(chaveCooldown)]);

      const vigente = await tentativaRepo.buscarCooldownVigente(client, chaveCooldown);
      if (vigente !== null) {
        desfecho = { tipo: 'COOLDOWN_ATIVO', ativoAte: vigente.ativoAte };
      } else {
        const convite = await conviteRepo.buscarPorHashParaAtualizacao(client, tokenHash);
        if (convite === null) {
          await tratarFalha(client, { chaveCooldown, conviteId: null, motivo: 'CONVITE_INEXISTENTE', ip: ipP, dispositivo: dispositivoP });
          desfecho = { tipo: 'CONVITE_INVALIDO' };
        } else {
          const erroSituacao = erroDaSituacao(convite);
          const erroEmpresa = erroSituacao === null && await empresaAtiva(client, convite.empresaId) === null
            ? HttpError.conflict('CONVITE_EMPRESA_INATIVA', MSG.EMPRESA_INATIVA)
            : null;
          if (erroSituacao !== null || erroEmpresa !== null) {
            desfecho = { tipo: 'SITUACAO', erro: erroSituacao ?? erroEmpresa };
          } else {
            try {
              desfecho = await resolverAceite(client, { convite, senha, chaveCooldown, ip: ipP, dispositivo: dispositivoP });
            } catch (erro) {
              throw traduzirViolacaoAceite(erro);
            }
          }
        }
      }

      await client.query('COMMIT');
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }

  switch (desfecho.tipo) {
    case 'SUCESSO':
      return desfecho.resultado;
    case 'COOLDOWN_ATIVO': {
      const retryAfterSegundos = Math.max(1, Math.ceil((desfecho.ativoAte.getTime() - Date.now()) / 1000));
      throw HttpError.tooManyRequests('CONVITE_EM_COOLDOWN', MSG.COOLDOWN, { retryAfterSegundos });
    }
    case 'CONVITE_INVALIDO':
      throw HttpError.notFound('CONVITE_INVALIDO', MSG.INVALIDO);
    case 'SITUACAO':
      throw desfecho.erro;
    case 'SENHA_FORA_DA_POLITICA':
      throw HttpError.validacao(desfecho.detalhes);
    default:
      throw HttpError.unauthorized('CREDENCIAIS_INVALIDAS', MSG.CREDENCIAIS);
  }
}

module.exports = {
  criar, listarEmAberto, cancelar, consultarPorToken, aceitar, ACAO,
};
