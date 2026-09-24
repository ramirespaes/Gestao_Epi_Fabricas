'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { normalizarEmail } = require('../utils/normalizacao');
const administradorRepo = require('../repositories/administrador-plataforma.repository');
const sessaoRepo = require('../repositories/sessao-plataforma.repository');
const loginTentativaPlataformaRepo = require('../repositories/login-tentativa-plataforma.repository');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const token = require('../security/token');

/**
 * Serviço de login do Painel Privado da plataforma (Autenticação Global —
 * Pacote 2; correção final pós-auditoria independente de 23/09/2026, item
 * 1: "implementar proteção persistente contra tentativas repetidas por
 * identidade, aproveitando os padrões de cooldown já existentes no
 * projeto").
 *
 * Espelha `login.service.js` (Bloco 8, Incremento 5) na sua estrutura
 * central — transação única, advisory lock por chave, cooldown persistente
 * de dois níveis — com as simplificações já documentadas desde a primeira
 * versão deste serviço:
 *
 * - SEM CNPJ, sem resolução de empresa: "o login administrativo não pode
 *   depender da existência de uma empresa cadastrada" — só e-mail e senha,
 *   resolvidos direto contra `administradores_plataforma`. A chave de
 *   cooldown (`cooldown.gerarChaveCooldownPlataforma`) usa só o e-mail,
 *   com um rótulo de domínio ('PLATAFORMA') que a separa da chave de
 *   qualquer usuário empresarial com o mesmo e-mail.
 * - `authConfig.cooldown.niveis` é o MESMO usado pelo cliente — nenhuma
 *   variável de ambiente nova para este pacote, conforme instruído.
 * - O rate limit por IP (`limitadorPlataformaAutenticacao`, montado na
 *   rota) CONTINUA como proteção COMPLEMENTAR, nunca a única: o cooldown
 *   persistente por identidade, agora implementado aqui, é a defesa
 *   principal contra força bruta dirigida a uma conta específica.
 * - Resistência a enumeração preservada: `verificarSenhaContraFicticio`
 *   roda sempre que o e-mail não normaliza ou o administrador não existe,
 *   para que o tempo de resposta não distinga essas situações de uma
 *   senha incorreta.
 *
 * `administradorRepo`/`sessaoRepo`/`loginTentativaPlataformaRepo`/
 * `cooldown`/`password`/`token` são sempre chamados por namespace, nunca
 * desestruturados — mesma razão de login.service.js: permite mock.method
 * nos testes sem mudar o comportamento em produção.
 *
 * RESULTADO PÚBLICO: falha de credencial (e-mail inexistente, administrador
 * inativo, senha incorreta) produz sempre o MESMO
 * HttpError.unauthorized('CREDENCIAIS_INVALIDAS', ...); cooldown vigente no
 * início da tentativa produz HttpError.tooManyRequests('LOGIN_EM_COOLDOWN',
 * ..., {retryAfterSegundos}) — a PRÓPRIA tentativa que cruza o limiar ainda
 * recebe o 401 genérico, o 429 só aparece na tentativa seguinte.
 *
 * TRANSAÇÃO E RELÓGIO: mesma disciplina de login.service.js — os `throw`
 * de desfecho de negócio ficam FORA do bloco que decide ROLLBACK (uma
 * tentativa negada é um desfecho normal, termina em COMMIT, preservando a
 * linha de auditoria); só uma exceção genuína aciona ROLLBACK.
 * `clock_timestamp()`, nunca `now()`, para qualquer prazo calculado depois
 * de uma espera pelo advisory lock ou de uma verificação Argon2id.
 */

const MINUTOS_PARA_MS = 60_000;
const TAMANHO_MAXIMO_IP = 45;
const TAMANHO_MAXIMO_DISPOSITIVO = 150;
const MENSAGEM_CREDENCIAIS_INVALIDAS = 'E-mail ou senha inválidos';
const MENSAGEM_COOLDOWN = 'Muitas tentativas. Tente novamente mais tarde';

function prepararCampoOpcional(valor, tamanhoMaximo, nomeCampo) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new TypeError(`${nomeCampo} deve ser string ou ausente`);
  }
  return valor.length > tamanhoMaximo ? valor.slice(0, tamanhoMaximo) : valor;
}

/** Instante real do PostgreSQL, reavaliado a cada chamada — nunca o now() da transação. */
async function buscarInstanteReal(client) {
  const { rows } = await client.query('SELECT clock_timestamp() AS agora');
  return rows[0].agora;
}

function somarMinutos(data, minutos) {
  return new Date(data.getTime() + minutos * MINUTOS_PARA_MS);
}

/**
 * Registra a falha, conta falhas recentes em cada nível de cooldown
 * configurado e ativa o bloqueio de maior duração entre os limiares
 * cruzados, se algum for — mesma lógica de login.service.tratarFalha.
 */
async function tratarFalha(client, { chaveCooldown, administradorId, motivo, ip, dispositivo }) {
  await loginTentativaPlataformaRepo.registrarTentativa(client, {
    chaveCooldown, administradorId, sucesso: false, motivo, ip, dispositivo,
  });

  const agora = await buscarInstanteReal(client);

  let duracaoEscolhida = null;
  for (const nivel of authConfig.cooldown.niveis) {
    const desde = somarMinutos(agora, -nivel.janelaMinutos);
    const total = await loginTentativaPlataformaRepo.contarFalhasRecentes(client, chaveCooldown, desde);
    if (total >= nivel.falhas && (duracaoEscolhida === null || nivel.duracaoMinutos > duracaoEscolhida)) {
      duracaoEscolhida = nivel.duracaoMinutos;
    }
  }

  if (duracaoEscolhida !== null) {
    const cooldownAte = somarMinutos(agora, duracaoEscolhida);
    await loginTentativaPlataformaRepo.registrarAtivacaoCooldown(client, {
      chaveCooldown, cooldownAte, administradorId, ip, dispositivo,
    });
  }
}

/**
 * Resolve o administrador e a credencial dentro da transação já com o
 * advisory lock adquirido e sem cooldown vigente. Nunca lança para
 * representar uma credencial inválida — só propaga exceções genuinamente
 * inesperadas.
 */
async function resolverCredencial(client, { emailNormalizado, senha, chaveCooldown, ip, dispositivo }) {
  const administrador = await administradorRepo.buscarCredencialPorEmail(client, emailNormalizado);

  if (administrador === null) {
    await password.verificarSenhaContraFicticio(senha);
    await tratarFalha(client, {
      chaveCooldown, administradorId: null, motivo: 'ADMINISTRADOR_INEXISTENTE', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  // Roda sempre que existe um hash real, ativo ou não: reduz a diferença
  // de tempo observável entre "administrador inativo" e "senha incorreta"
  // (CLAUDE.md §17).
  const senhaOk = await password.verificarSenha(administrador.senhaHash, senha);

  if (!administrador.ativo) {
    await tratarFalha(client, {
      chaveCooldown, administradorId: administrador.id, motivo: 'ADMINISTRADOR_INATIVO', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  if (!senhaOk) {
    await tratarFalha(client, {
      chaveCooldown, administradorId: administrador.id, motivo: 'SENHA_INVALIDA', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  await loginTentativaPlataformaRepo.registrarTentativa(client, {
    chaveCooldown, administradorId: administrador.id, sucesso: true, ip, dispositivo,
  });

  // Capturado agora — depois do Argon2id e do registro da tentativa, não
  // antes: expira_em precisa refletir o instante real da criação da sessão.
  const agoraSessao = await buscarInstanteReal(client);
  const expiraEm = somarMinutos(agoraSessao, authConfig.sessao.expiracaoMinutos);

  const tokenClaro = token.gerarTokenSessao();
  const tokenHash = token.hashTokenSessao(tokenClaro);

  const sessaoId = await sessaoRepo.criar(client, {
    administradorId: administrador.id,
    tokenHash,
    expiraEm,
    ip,
    dispositivo,
  });

  return {
    tipo: 'SUCESSO',
    resultado: {
      administrador: { id: administrador.id, email: administrador.email },
      sessao: { id: sessaoId, expiraEm },
      token: tokenClaro,
    },
  };
}

/**
 * Autentica um administrador de plataforma por e-mail e senha.
 *
 * @param {import('pg').Pool} pool
 * @param {{email: string, senha: string, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{administrador: {id:number, email:string}, sessao: {id:string, expiraEm:Date}, token: string}>}
 */
async function autenticar(pool, { email, senha, ip = null, dispositivo = null }) {
  // Falha cedo, sem qualquer conexão, se o e-mail não for normalizável —
  // gerarChaveCooldownPlataforma já normaliza e valida internamente.
  let chaveCooldown;
  let emailNormalizado;
  try {
    chaveCooldown = cooldown.gerarChaveCooldownPlataforma(email);
    emailNormalizado = normalizarEmail(email);
  } catch {
    // Mesmo desfecho de "não encontrado": nunca revela que o formato
    // recebido foi rejeitado antes de qualquer consulta, e verifica contra
    // o hash fictício para não vazar timing.
    await password.verificarSenhaContraFicticio(senha);
    throw HttpError.unauthorized('CREDENCIAIS_INVALIDAS', MENSAGEM_CREDENCIAIS_INVALIDAS);
  }

  const ipPreparado = prepararCampoOpcional(ip, TAMANHO_MAXIMO_IP, 'ip');
  const dispositivoPreparado = prepararCampoOpcional(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO, 'dispositivo');

  const client = await pool.connect();
  let desfecho;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [cooldown.derivarAdvisoryLock64(chaveCooldown)]);

      const cooldownVigente = await loginTentativaPlataformaRepo.buscarCooldownVigente(client, chaveCooldown);
      if (cooldownVigente !== null) {
        desfecho = { tipo: 'COOLDOWN_ATIVO', ativoAte: cooldownVigente.ativoAte };
      } else {
        desfecho = await resolverCredencial(client, {
          emailNormalizado,
          senha,
          chaveCooldown,
          ip: ipPreparado,
          dispositivo: dispositivoPreparado,
        });
      }

      await client.query('COMMIT');
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }

  if (desfecho.tipo === 'SUCESSO') {
    return desfecho.resultado;
  }

  if (desfecho.tipo === 'COOLDOWN_ATIVO') {
    // Date.now() aqui é só uma dica de HTTP (Retry-After), calculada FORA
    // da transação já commitada — não é a fonte de nenhum prazo persistido.
    const retryAfterSegundos = Math.max(1, Math.ceil((desfecho.ativoAte.getTime() - Date.now()) / 1000));
    throw HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', MENSAGEM_COOLDOWN, { retryAfterSegundos });
  }

  throw HttpError.unauthorized('CREDENCIAIS_INVALIDAS', MENSAGEM_CREDENCIAIS_INVALIDAS);
}

module.exports = { autenticar };
