'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const entregaConvite = require('./entrega-convite.service');
const { normalizarEmail } = require('../utils/normalizacao');
const { detalhesDePoliticaSenha } = require('../middleware/validar');
const empresaRepo = require('../repositories/empresa.repository');
const conviteRepo = require('../repositories/convite-master.repository');
const tentativaRepo = require('../repositories/convite-master-tentativa.repository');
const identidadeRepo = require('../repositories/identidade.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const auditoriaPlataformaRepo = require('../repositories/auditoria-plataforma.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const passwordPolicy = require('../security/password-policy');
const token = require('../security/token');

/**
 * Convite do PRIMEIRO MASTER de uma empresa (Pacote 3 — Autenticação
 * Global, 23/09/2026). Implementa o planejamento v2 §8 e o adendo v2.1 §5.
 *
 * DOIS ATORES, DUAS TRILHAS DE AUDITORIA — nunca confundidos:
 *   - CRIAR e CANCELAR são atos do ADMINISTRADOR DA PLATAFORMA
 *     (administradorId da sessão do Painel Privado) -> logs_auditoria_plataforma.
 *   - ACEITAR é ato da PESSOA CONVIDADA, que não é administrador de nada
 *     ainda -> logs_auditoria (trilha EMPRESARIAL), com empresa_id do
 *     convite e usuario_id do VÍNCULO recém-criado. O administrador que
 *     convidou NUNCA é registrado como autor do aceite.
 *
 * TOKEN: mesmo gerador opaco de 32 bytes de src/security/token.js; só o
 * SHA-256 é persistido (convites_master.token_hash). O token em claro
 * existe em dois instantes: ao criar (devolvido ao controller, que o
 * entrega por entrega-convite.service.js) e ao aceitar (apresentado pela
 * pessoa). Nunca em banco, log, auditoria ou mensagem de erro.
 *
 * ACEITE — dois caminhos, nunca automáticos:
 *   identidade INEXISTENTE para o e-mail  -> a pessoa define a senha
 *     (política de senha completa); identidade + vínculo MASTER nascem na
 *     MESMA transação — se qualquer parte falhar, nada fica meio-criado.
 *   identidade JÁ EXISTENTE               -> exige a senha ATUAL daquela
 *     identidade (prova de titularidade). Nunca vincula só porque o e-mail
 *     bateu; nunca associa contas legadas por igualdade de e-mail.
 *   Em ambos, `nome` é o nome de exibição do VÍNCULO (usuarios.nome, NOT
 *   NULL, por vínculo — a identidade não tem nome, migration 025).
 *
 * COOLDOWN (adendo v2.1 §5 item 2): mesmo mecanismo do login — chave
 * HMAC derivada do TOKEN (cooldown.gerarChaveCooldownConvite), advisory
 * lock por chave, tabela própria (convite_master_tentativas, 034), os
 * MESMOS níveis authConfig.cooldown.niveis. Protege o caminho "identidade
 * existente" contra força bruta de senha por quem tenha o link.
 *
 * USO ÚNICO E CONCORRÊNCIA: a linha do convite é lida com FOR UPDATE
 * dentro da transação; o UPDATE de aceite leva a condição de estado na
 * própria cláusula WHERE (conviteRepo.marcarAceito). Duas aceitações
 * simultâneas do mesmo token: a segunda espera o COMMIT da primeira e
 * encontra aceito_em preenchido — recusada. Dois convites simultâneos
 * para o mesmo e-mail na mesma empresa: FOR UPDATE no pendente existente
 * serializa os dois administradores (buscarPendentePorEmailParaAtualizacao).
 *
 * DESFECHOS DE NEGÓCIO x ROLLBACK: como em login.service.js, o `throw` de
 * HttpError por desfecho de negócio (senha errada, cooldown) acontece FORA
 * do bloco que decide ROLLBACK — a tentativa negada é COMMITADA (é ela que
 * alimenta o cooldown). Só exceção genuína desfaz a transação.
 *
 * Situações de convite (EXPIRADO/CANCELADO/JA_UTILIZADO/INVALIDO) recebem
 * códigos DISTINTOS de propósito: aqui o token É o segredo — quem o tem
 * já é o destinatário; distinguir "por que este link não serve" não abre
 * enumeração de nada (diferente do login, onde a resposta é uniforme).
 */

const MINUTOS_PARA_MS = 60_000;
const TAMANHO_MAXIMO_IP = 45;
const TAMANHO_MAXIMO_DISPOSITIVO = 150;
const PERFIL_MASTER = 'MASTER';
const VIOLACAO_UNIQUE = '23505';
const CONSTRAINT_VINCULO = 'uq_usuarios_empresa_identidade';
const CONSTRAINT_IDENTIDADE_EMAIL = 'uq_identidades_email_lower';

const ACAO = Object.freeze({
  CRIADO: 'CONVITE_MASTER_CRIADO',
  CANCELADO: 'CONVITE_MASTER_CANCELADO',
  ACEITO: 'CONVITE_MASTER_ACEITO',
});

const MSG = Object.freeze({
  EMPRESA_NAO_ENCONTRADA: 'Empresa não encontrada',
  EMPRESA_INATIVA: 'Empresa inativa não pode receber convite',
  EMAIL_INVALIDO: 'E-mail inválido',
  JA_PENDENTE: 'Já existe um convite pendente para este e-mail nesta empresa',
  EMPRESA_INATIVA_ACEITE: 'Aceite indisponível: a empresa está inativa',
  NAO_ENCONTRADO: 'Convite não encontrado',
  NAO_CANCELAVEL: 'Convite já aceito ou já cancelado não pode ser cancelado',
  INVALIDO: 'Convite inválido',
  EXPIRADO: 'Convite expirado',
  CANCELADO: 'Convite cancelado',
  JA_UTILIZADO: 'Convite já utilizado',
  CREDENCIAIS: 'Senha inválida',
  COOLDOWN: 'Muitas tentativas. Tente novamente mais tarde',
  NOME_INVALIDO: 'Nome inválido',
  VINCULO_EXISTENTE: 'Esta identidade já possui vínculo nesta empresa',
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function prepararCampoOpcional(valor, tamanhoMaximo, nomeCampo) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new TypeError(`${nomeCampo} deve ser string ou ausente`);
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

function somarMinutos(data, minutos) {
  return new Date(data.getTime() + minutos * MINUTOS_PARA_MS);
}

const resumoEmpresa = (e) => ({ id: e.id, razaoSocial: e.razaoSocial });

/**
 * CONCORRÊNCIA NA CRIAÇÃO (correção pós-auditoria do Pacote 3, item 2):
 * `FOR UPDATE` trava um convite pendente que EXISTE, mas não trava a
 * AUSÊNCIA de convite — duas transações simultâneas para o mesmo
 * (empresa, e-mail) leriam "nenhum pendente" e inseririam duas linhas.
 * Solução coerente com o projeto (mesma de login.service.js): advisory
 * lock transacional por chave, derivado com `derivarAdvisoryLock64` a
 * partir do SHA-256 de rótulo || empresa || e-mail. A segunda transação
 * espera o COMMIT da primeira e, sob READ COMMITTED, sua consulta de
 * pendente já enxerga a linha recém-commitada -> 409. Não é segredo, por
 * isso SHA-256 simples, não HMAC.
 */
function lockCriacao(empresaId, emailNormalizado) {
  const digest = crypto.createHash('sha256').update(`CONVITE_MASTER_CRIACAO\n${empresaId}\n${emailNormalizado}`, 'utf8').digest('hex');
  return cooldown.derivarAdvisoryLock64(digest);
}

/** Empresa do convite precisa existir e estar ATIVA para o aceite (item 4). */
async function exigirEmpresaAtivaParaAceite(executor, empresaId) {
  const empresa = await empresaRepo.buscarDetalhesPorId(executor, empresaId);
  if (empresa === null || empresa.ativo !== true) {
    return { empresa, erro: HttpError.conflict('CONVITE_EMPRESA_INATIVA', MSG.EMPRESA_INATIVA_ACEITE) };
  }
  return { empresa, erro: null };
}

// ---------------------------------------------------------------------------
// Administrador da plataforma: criar / cancelar / consultar
// ---------------------------------------------------------------------------

/**
 * Cria o convite. Devolve o token EM CLARO uma única vez, para o
 * controller entregá-lo (entrega-convite.service.js) — nunca o persiste.
 *
 * @returns {Promise<{convite: object, token: string, empresa: object}>}
 */
async function criar(pool, { administradorId, empresaId, email, ip = null, dispositivo = null }) {
  exigirId(administradorId, 'identificador de administrador');
  exigirId(empresaId, 'identificador de empresa');
  const emailN = normalizarEmail(email);
  if (emailN === null) {
    throw HttpError.badRequest('CONVITE_EMAIL_INVALIDO', MSG.EMAIL_INVALIDO);
  }
  // Item 3: sem provedor de e-mail, produção é recusada AQUI — antes de
  // conectar, antes de gravar, antes de auditar.
  entregaConvite.exigirDisponivel();

  return emTransacao(pool, async (client) => {
    const empresa = await empresaRepo.buscarDetalhesPorId(client, empresaId);
    if (empresa === null) {
      throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', MSG.EMPRESA_NAO_ENCONTRADA);
    }
    if (empresa.ativo !== true) {
      throw HttpError.conflict('EMPRESA_INATIVA', MSG.EMPRESA_INATIVA);
    }

    // Item 2: serializa criações concorrentes para o mesmo (empresa, e-mail).
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockCriacao(empresaId, emailN)]);

    const pendente = await conviteRepo.buscarPendentePorEmailParaAtualizacao(client, empresaId, emailN);
    if (pendente !== null) {
      throw HttpError.conflict('CONVITE_JA_PENDENTE', MSG.JA_PENDENTE);
    }

    const agora = await buscarInstanteReal(client);
    const expiraEm = somarMinutos(agora, authConfig.conviteMaster.expiracaoMinutos);
    const tokenClaro = token.gerarTokenSessao();
    const tokenHash = token.hashTokenSessao(tokenClaro);

    const convite = await conviteRepo.criar(client, { empresaId, emailConvite: emailN, tokenHash, criadoPor: administradorId, expiraEm });

    await auditoriaPlataformaRepo.registrar(client, {
      administradorId, empresaAfetadaId: empresaId, acao: ACAO.CRIADO, referencia: convite.id, ip, dispositivo,
      contexto: { origem: 'painel_privado' },
      dadosNovos: { conviteId: convite.id, emailConvite: emailN, expiraEm },
    });

    return { convite, token: tokenClaro, empresa: resumoEmpresa(empresa) };
  });
}

async function cancelar(pool, { administradorId, empresaId, conviteId, ip = null, dispositivo = null }) {
  exigirId(administradorId, 'identificador de administrador');
  exigirId(empresaId, 'identificador de empresa');

  return emTransacao(pool, async (client) => {
    const cancelado = await conviteRepo.cancelar(client, empresaId, conviteId);
    if (cancelado === null) {
      const existente = await conviteRepo.buscarPorId(client, empresaId, conviteId);
      if (existente === null) {
        throw HttpError.notFound('CONVITE_NAO_ENCONTRADO', MSG.NAO_ENCONTRADO);
      }
      throw HttpError.conflict('CONVITE_NAO_CANCELAVEL', MSG.NAO_CANCELAVEL);
    }

    await auditoriaPlataformaRepo.registrar(client, {
      administradorId, empresaAfetadaId: empresaId, acao: ACAO.CANCELADO, referencia: cancelado.id, ip, dispositivo,
      contexto: { origem: 'painel_privado' },
      dadosNovos: { conviteId: cancelado.id, canceladoEm: cancelado.canceladoEm },
    });

    return cancelado;
  });
}

async function buscar(pool, { empresaId, conviteId }) {
  exigirId(empresaId, 'identificador de empresa');
  const convite = await conviteRepo.buscarPorId(pool, empresaId, conviteId);
  if (convite === null) {
    throw HttpError.notFound('CONVITE_NAO_ENCONTRADO', MSG.NAO_ENCONTRADO);
  }
  return convite;
}

async function listarPorEmpresa(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  const empresa = await empresaRepo.buscarDetalhesPorId(pool, empresaId);
  if (empresa === null) {
    throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', MSG.EMPRESA_NAO_ENCONTRADA);
  }
  return conviteRepo.listarPorEmpresa(pool, empresaId);
}

// ---------------------------------------------------------------------------
// Pessoa convidada: consultar / aceitar (sem sessão alguma)
// ---------------------------------------------------------------------------

function erroDaSituacao(convite) {
  const { SITUACAO } = conviteRepo;
  if (convite.situacao === SITUACAO.ACEITO) return HttpError.conflict('CONVITE_JA_UTILIZADO', MSG.JA_UTILIZADO);
  if (convite.situacao === SITUACAO.CANCELADO) return HttpError.conflict('CONVITE_CANCELADO', MSG.CANCELADO);
  if (convite.situacao === SITUACAO.EXPIRADO) return HttpError.conflict('CONVITE_EXPIRADO', MSG.EXPIRADO);
  return null;
}

/** Token em formato canônico -> hash; qualquer outra coisa é "convite inválido" (404), sem tocar o banco. */
function hashDoTokenOuNull(tokenClaro) {
  return token.tokenSessaoTemFormatoValido(tokenClaro) ? token.hashTokenSessao(tokenClaro) : null;
}

/**
 * Tela de aceite antes do envio do formulário: o que a pessoa precisa
 * saber (empresa, e-mail, prazo, e se já existe identidade — para exibir
 * "defina sua senha" ou "confirme sua senha atual"). Somente leitura;
 * não consome o convite.
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
  const { empresa, erro: erroEmpresa } = await exigirEmpresaAtivaParaAceite(pool, convite.empresaId);
  if (erroEmpresa !== null) {
    throw erroEmpresa;
  }
  const identidade = await identidadeRepo.buscarPorEmail(pool, convite.emailConvite);
  return {
    situacao: convite.situacao,
    empresa: resumoEmpresa(empresa),
    emailConvite: convite.emailConvite,
    expiraEm: convite.expiraEm,
    identidadeExistente: identidade !== null,
  };
}

/** Registra a falha e ativa o cooldown do maior nível cruzado (mesma lógica de login.service.tratarFalha). */
async function tratarFalha(client, { chaveCooldown, conviteId, motivo, ip, dispositivo }) {
  await tentativaRepo.registrarTentativa(client, { chaveCooldown, conviteId, sucesso: false, motivo, ip, dispositivo });

  const agora = await buscarInstanteReal(client);
  let duracaoEscolhida = null;
  for (const nivel of authConfig.cooldown.niveis) {
    const desde = somarMinutos(agora, -nivel.janelaMinutos);
    const total = await tentativaRepo.contarFalhasRecentes(client, chaveCooldown, desde);
    if (total >= nivel.falhas && (duracaoEscolhida === null || nivel.duracaoMinutos > duracaoEscolhida)) {
      duracaoEscolhida = nivel.duracaoMinutos;
    }
  }
  if (duracaoEscolhida !== null) {
    await tentativaRepo.registrarAtivacaoCooldown(client, {
      chaveCooldown, cooldownAte: somarMinutos(agora, duracaoEscolhida), conviteId, ip, dispositivo,
    });
  }
}

function traduzirViolacaoAceite(erro) {
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_VINCULO) {
    return HttpError.conflict('CONVITE_VINCULO_EXISTENTE', MSG.VINCULO_EXISTENTE);
  }
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_IDENTIDADE_EMAIL) {
    // Corrida rara: outra transação criou a identidade entre a leitura e o
    // INSERT (adendo v2.1 §5 item 1). Nada fica meio-criado (ROLLBACK); a
    // pessoa refaz o aceite, agora pelo caminho "identidade existente".
    return HttpError.conflict('CONVITE_IDENTIDADE_CONCORRENTE', 'Identidade criada concorrentemente; repita o aceite');
  }
  return erro;
}

/**
 * Resolve identidade (criando-a se não existir) e cria o vínculo MASTER.
 * Roda dentro da transação já com lock; devolve um desfecho de negócio em
 * vez de lançar, para que a tentativa negada seja COMMITADA.
 */
async function resolverAceite(client, { convite, nomeN, senha, chaveCooldown, ip, dispositivo }) {
  const credencial = await identidadeRepo.buscarCredencialPorEmail(client, convite.emailConvite);

  let identidadeId;
  let identidadeCriada;
  if (credencial === null) {
    const politica = passwordPolicy.validarPoliticaSenha(senha, { email: convite.emailConvite });
    if (!politica.ok) {
      return { tipo: 'SENHA_FORA_DA_POLITICA', detalhes: detalhesDePoliticaSenha(politica, 'body.senha') };
    }
    const senhaHash = await password.gerarHashSenha(senha);
    const identidade = await identidadeRepo.criar(client, { email: convite.emailConvite, senhaHash });
    identidadeId = identidade.id;
    identidadeCriada = true;
  } else {
    // Roda sempre que existe hash real, ativa ou não (CLAUDE.md §17).
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

  const usuario = await usuarioRepo.criar(client, { empresaId: convite.empresaId, nome: nomeN, perfil: PERFIL_MASTER, identidadeId });

  const aceito = await conviteRepo.marcarAceito(client, convite.id, { identidadeId, usuarioId: usuario.id });
  if (aceito === null) {
    // Só possível se o estado mudou sob o lock — nunca presume sucesso.
    throw new Error(`convite ${convite.id} deixou de ser pendente durante o aceite`);
  }

  await tentativaRepo.registrarTentativa(client, { chaveCooldown, conviteId: convite.id, sucesso: true, ip, dispositivo });

  // Trilha EMPRESARIAL, atribuída ao NOVO usuário — nunca ao administrador.
  await auditoriaRepo.registrar(client, {
    empresaId: convite.empresaId, usuarioId: usuario.id, acao: ACAO.ACEITO, referencia: convite.id, ip, dispositivo,
    contexto: { origem: 'aceite_convite_master', identidadeCriada, conviteCriadoPor: convite.criadoPor },
    dadosNovos: { usuarioId: usuario.id, perfil: PERFIL_MASTER, identidadeId },
  });

  const empresa = await empresaRepo.buscarDetalhesPorId(client, convite.empresaId);
  return {
    tipo: 'SUCESSO',
    resultado: {
      empresa: empresa === null ? { id: convite.empresaId, razaoSocial: null } : resumoEmpresa(empresa),
      usuario: { id: usuario.id, nome: usuario.nome, perfil: usuario.perfil },
      identidade: { id: identidadeId, email: convite.emailConvite },
      identidadeCriada,
      aceitoEm: aceito.aceitoEm,
    },
  };
}

/**
 * Aceita o convite. NÃO cria sessão nenhuma: o login global da pessoa é o
 * Pacote 4. Aqui só nascem a identidade (se nova) e o vínculo MASTER.
 */
async function aceitar(pool, { token: tokenClaro, nome, senha, ip = null, dispositivo = null }) {
  const tokenHash = hashDoTokenOuNull(tokenClaro);
  if (tokenHash === null) {
    throw HttpError.notFound('CONVITE_INVALIDO', MSG.INVALIDO);
  }
  if (typeof senha !== 'string' || senha.length === 0) {
    throw HttpError.badRequest('CONVITE_SENHA_INVALIDA', MSG.CREDENCIAIS);
  }
  const nomeN = typeof nome === 'string' ? nome.trim().normalize('NFC') : '';
  if (nomeN.length === 0 || Array.from(nomeN).length > usuarioRepo.TAMANHO_MAXIMO_NOME) {
    throw HttpError.badRequest('CONVITE_NOME_INVALIDO', MSG.NOME_INVALIDO);
  }
  const chaveCooldown = cooldown.gerarChaveCooldownConvite(tokenClaro);
  const ipP = prepararCampoOpcional(ip, TAMANHO_MAXIMO_IP, 'ip');
  const dispositivoP = prepararCampoOpcional(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO, 'dispositivo');

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
          // Item 4: convite criado com a empresa ativa não pode ser aceito
          // enquanto ela estiver inativa — nada é criado, nada conta para
          // o cooldown (não é falha de credencial).
          const { erro: erroEmpresa } = erroSituacao === null
            ? await exigirEmpresaAtivaParaAceite(client, convite.empresaId)
            : { erro: null };
          if (erroSituacao !== null || erroEmpresa !== null) {
            desfecho = { tipo: 'SITUACAO', erro: erroSituacao ?? erroEmpresa };
          } else {
            try {
              desfecho = await resolverAceite(client, { convite, nomeN, senha, chaveCooldown, ip: ipP, dispositivo: dispositivoP });
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

module.exports = { criar, cancelar, buscar, listarPorEmpresa, consultarPorToken, aceitar, ACAO, PERFIL_MASTER };
