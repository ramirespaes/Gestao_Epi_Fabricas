'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { normalizarEmail } = require('../utils/normalizacao');
const identidadeRepo = require('../repositories/identidade.repository');
const sessaoGlobalRepo = require('../repositories/sessao-global.repository');
const loginTentativaGlobalRepo = require('../repositories/login-tentativa-global.repository');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const token = require('../security/token');

/**
 * Serviço de LOGIN GLOBAL do Portal do Cliente (Autenticação Global —
 * Pacote 4): e-mail + senha contra `identidades` (025), SEM CNPJ. É o
 * contrato definitivo do Portal (adendo v2.1 §1.2).
 *
 * Espelha `login-plataforma.service.js` — transação única, advisory lock
 * por chave, cooldown persistente de dois níveis (`authConfig.cooldown`,
 * sem variável nova), resistência a enumeração com hash fictício — trocando
 * administradores_plataforma por identidades, sessoes_plataforma por
 * sessoes_globais (035) e login_tentativas_plataforma por
 * login_tentativas_globais (036).
 *
 * A SENHA É VERIFICADA EXCLUSIVAMENTE CONTRA identidades.senha_hash — a
 * única credencial válida de uma identidade. usuarios.senha_hash não é lido
 * aqui em hipótese alguma (e o login legado, por sua vez, recusa vínculos
 * com identidade — login.service.js). Não existe segunda credencial.
 *
 * O QUE ESTE SERVIÇO NÃO FAZ: não lista vínculos, não escolhe empresa, não
 * cria sessão empresarial — isso é `contexto-empresarial.service.js`,
 * chamado pelo controller depois deste. Autenticar a pessoa e conceder
 * acesso a uma empresa são decisões separadas de propósito (planejamento
 * v2 §6.2).
 *
 * Repositórios e módulos de segurança sempre por namespace (nunca
 * desestruturados), para mock.method nos testes.
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

async function tratarFalha(client, { chaveCooldown, identidadeId, motivo, ip, dispositivo }) {
  await loginTentativaGlobalRepo.registrarTentativa(client, {
    chaveCooldown, identidadeId, sucesso: false, motivo, ip, dispositivo,
  });

  const agora = await buscarInstanteReal(client);

  let duracaoEscolhida = null;
  for (const nivel of authConfig.cooldown.niveis) {
    const desde = somarMinutos(agora, -nivel.janelaMinutos);
    const total = await loginTentativaGlobalRepo.contarFalhasRecentes(client, chaveCooldown, desde);
    if (total >= nivel.falhas && (duracaoEscolhida === null || nivel.duracaoMinutos > duracaoEscolhida)) {
      duracaoEscolhida = nivel.duracaoMinutos;
    }
  }

  if (duracaoEscolhida !== null) {
    const cooldownAte = somarMinutos(agora, duracaoEscolhida);
    await loginTentativaGlobalRepo.registrarAtivacaoCooldown(client, {
      chaveCooldown, cooldownAte, identidadeId, ip, dispositivo,
    });
  }
}

async function resolverCredencial(client, { emailNormalizado, senha, chaveCooldown, ip, dispositivo }) {
  const identidade = await identidadeRepo.buscarCredencialPorEmail(client, emailNormalizado);

  if (identidade === null) {
    await password.verificarSenhaContraFicticio(senha);
    await tratarFalha(client, {
      chaveCooldown, identidadeId: null, motivo: 'IDENTIDADE_INEXISTENTE', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  // Sempre que há hash real, verifica — ativa ou não (CLAUDE.md §17).
  const senhaOk = await password.verificarSenha(identidade.senhaHash, senha);

  if (!identidade.ativo) {
    await tratarFalha(client, {
      chaveCooldown, identidadeId: identidade.id, motivo: 'IDENTIDADE_INATIVA', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  if (!senhaOk) {
    await tratarFalha(client, {
      chaveCooldown, identidadeId: identidade.id, motivo: 'SENHA_INVALIDA', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  await loginTentativaGlobalRepo.registrarTentativa(client, {
    chaveCooldown, identidadeId: identidade.id, sucesso: true, ip, dispositivo,
  });

  const agoraSessao = await buscarInstanteReal(client);
  const expiraEm = somarMinutos(agoraSessao, authConfig.sessao.expiracaoMinutos);

  const tokenClaro = token.gerarTokenSessao();
  const tokenHash = token.hashTokenSessao(tokenClaro);

  const sessaoId = await sessaoGlobalRepo.criar(client, {
    identidadeId: identidade.id,
    tokenHash,
    expiraEm,
    ip,
    dispositivo,
  });

  return {
    tipo: 'SUCESSO',
    resultado: {
      identidade: { id: identidade.id, email: identidade.email },
      sessao: { id: sessaoId, expiraEm },
      token: tokenClaro,
    },
  };
}

/**
 * Autentica uma identidade global por e-mail e senha.
 *
 * @param {import('pg').Pool} pool
 * @param {{email: string, senha: string, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{identidade: {id:number, email:string}, sessao: {id:string, expiraEm:Date}, token: string}>}
 */
async function autenticar(pool, { email, senha, ip = null, dispositivo = null }) {
  let chaveCooldown;
  let emailNormalizado;
  try {
    chaveCooldown = cooldown.gerarChaveCooldownGlobal(email);
    emailNormalizado = normalizarEmail(email);
  } catch {
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

      const cooldownVigente = await loginTentativaGlobalRepo.buscarCooldownVigente(client, chaveCooldown);
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
    const retryAfterSegundos = Math.max(1, Math.ceil((desfecho.ativoAte.getTime() - Date.now()) / 1000));
    throw HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', MENSAGEM_COOLDOWN, { retryAfterSegundos });
  }

  throw HttpError.unauthorized('CREDENCIAIS_INVALIDAS', MENSAGEM_CREDENCIAIS_INVALIDAS);
}

module.exports = { autenticar };
