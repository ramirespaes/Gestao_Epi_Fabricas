'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { normalizarCnpj, normalizarEmail } = require('../utils/normalizacao');
const empresaRepo = require('../repositories/empresa.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const sessaoRepo = require('../repositories/sessao.repository');
const loginTentativaRepo = require('../repositories/login-tentativa.repository');
const cooldown = require('../security/cooldown');
const password = require('../security/password');
const token = require('../security/token');

/**
 * Serviço de login real (Bloco 8, Incremento 5).
 *
 * Coordena identificação de empresa e usuário, verificação de credencial,
 * controle persistente de tentativas com cooldown, e criação de sessão —
 * tudo dentro de uma única transação PostgreSQL, serializada por chave via
 * advisory lock. Não implementa rotas HTTP, logout, troca de senha nem RBAC.
 *
 * ARQUITETURA: recebe `pool` por parâmetro, nunca importa
 * `src/config/database.js` diretamente — mesma regra dos repositórios
 * (`funcao(executor, ...)`), necessária para a futura evolução SaaS (pool
 * por empresa contratante). Os módulos de repositório e segurança são
 * chamados sempre por `modulo.funcao(...)`, nunca desestruturados em
 * constantes locais: import desestruturado copia a referência da função no
 * momento do require e fica imune a troca posterior via mock.method nos
 * testes.
 *
 * NORMALIZAÇÃO: cnpj/email chegam aqui já validados e normalizados pelo
 * schema Zod da rota (`src/schemas/auth.schema.js`). Este serviço não
 * repete essa normalização — `cooldown.gerarChaveCooldown` já normaliza e
 * valida internamente, lançando `TypeError` cedo, antes de qualquer conexão
 * com o banco, se algo chegar não normalizável.
 *
 * RESULTADO PÚBLICO:
 *   - falha de credencial (empresa inexistente/inativa, e-mail inexistente,
 *     usuário inativo, senha incorreta): todas produzem o MESMO
 *     HttpError.unauthorized('CREDENCIAIS_INVALIDAS', ...) — nenhuma delas é
 *     distinguível pelo cliente, para não permitir enumeração;
 *   - cooldown já vigente no início da tentativa:
 *     HttpError.tooManyRequests('LOGIN_EM_COOLDOWN', ..., {retryAfterSegundos}).
 *     A PRÓPRIA tentativa que cruza o limiar ainda recebe o 401 genérico —
 *     o 429 só aparece na tentativa seguinte, que encontra o cooldown já
 *     persistido;
 *   - sucesso: devolve {usuario, empresa, sessao, token}. `token` é a
 *     string em claro, só existe nesta chamada — nunca é persistida, e a
 *     decisão de emitir cookie fica para a camada HTTP (fora deste
 *     incremento).
 *
 * RELÓGIO: nenhum instante é capturado uma única vez logo após o advisory
 * lock para servir a todos os cálculos seguintes. A verificação Argon2id
 * (real ou fictícia) tem custo variável e conhecido de propósito (ver
 * src/security/password.js) — usar um instante anterior a ela para calcular
 * cooldown_ate ou expira_em encolheria esses prazos pelo tempo da própria
 * verificação, silenciosamente. Por isso `buscarInstanteReal` é chamado de
 * novo, cada vez, logo antes de cada cálculo que dele depende: uma vez após
 * registrar uma falha (para as janelas de 15/60 min e para cooldown_ate) e
 * uma vez após registrar um sucesso (para expira_em). Ambas usam
 * `clock_timestamp()` do próprio PostgreSQL, nunca `Date.now()` da
 * aplicação — `Date.now()` só aparece fora da transação, no cálculo de
 * Retry-After, que é uma dica de HTTP, não um prazo persistido.
 *
 * TRANSAÇÃO: os `throw` de HttpError para desfechos de negócio (credenciais
 * inválidas, cooldown vigente) ficam FORA do bloco try/catch que decide
 * ROLLBACK. Uma tentativa negada é um desfecho NORMAL da transação — termina
 * em COMMIT, preservando a linha de auditoria. Só uma exceção genuína
 * (erro de conexão, violação de constraint inesperada, hash corrompido,
 * falha ao criar a sessão) aciona o ROLLBACK — e, por não passar pelo ramo
 * de sucesso, nunca produz um retorno de login bem-sucedido.
 */

const MINUTOS_PARA_MS = 60_000;
const TAMANHO_MAXIMO_IP = 45; // sessoes.ip / login_tentativas.ip: VARCHAR(45)
const TAMANHO_MAXIMO_DISPOSITIVO = 150; // sessoes.dispositivo / login_tentativas.dispositivo: VARCHAR(150)
const MENSAGEM_CREDENCIAIS_INVALIDAS = 'CNPJ, e-mail ou senha inválidos';
const MENSAGEM_COOLDOWN = 'Muitas tentativas. Tente novamente mais tarde';

/**
 * Diferencia ausência de valor, string válida (truncada se necessário) e
 * tipo inválido. Nunca usa String(valor): um number, array ou object
 * recebido aqui é erro de contrato do chamador, não um valor a converter.
 */
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
 * configurado (authConfig.cooldown.niveis) e ativa o bloqueio de maior
 * duração entre os limiares cruzados, se algum for.
 */
async function tratarFalha(client, { chaveCooldown, empresaId, usuarioId, motivo, ip, dispositivo }) {
  await loginTentativaRepo.registrarTentativa(client, {
    chaveCooldown, empresaId, usuarioId, sucesso: false, motivo, ip, dispositivo,
  });

  const agora = await buscarInstanteReal(client);

  let duracaoEscolhida = null;
  for (const nivel of authConfig.cooldown.niveis) {
    const desde = somarMinutos(agora, -nivel.janelaMinutos);
    const total = await loginTentativaRepo.contarFalhasRecentes(client, chaveCooldown, desde);
    if (total >= nivel.falhas && (duracaoEscolhida === null || nivel.duracaoMinutos > duracaoEscolhida)) {
      duracaoEscolhida = nivel.duracaoMinutos;
    }
  }

  if (duracaoEscolhida !== null) {
    const cooldownAte = somarMinutos(agora, duracaoEscolhida);
    await loginTentativaRepo.registrarAtivacaoCooldown(client, {
      chaveCooldown, cooldownAte, empresaId, usuarioId, ip, dispositivo,
    });
  }
}

/**
 * Resolve empresa, usuário e credencial dentro da transação já com o
 * advisory lock adquirido e sem cooldown vigente. Devolve o desfecho da
 * tentativa: nunca lança para representar uma credencial inválida — só
 * propaga exceções genuinamente inesperadas (repositório, Argon2id
 * corrompido), que o chamador trata como erro transacional.
 */
async function resolverCredencial(client, { cnpjNormalizado, emailNormalizado, senha, chaveCooldown, ip, dispositivo }) {
  const empresa = await empresaRepo.buscarPorCnpj(client, cnpjNormalizado);

  if (empresa === null) {
    await password.verificarSenhaContraFicticio(senha);
    await tratarFalha(client, {
      chaveCooldown, empresaId: null, usuarioId: null, motivo: 'EMPRESA_INEXISTENTE', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  if (!empresa.ativo) {
    await password.verificarSenhaContraFicticio(senha);
    await tratarFalha(client, {
      chaveCooldown, empresaId: empresa.id, usuarioId: null, motivo: 'EMPRESA_INATIVA', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  const usuario = await usuarioRepo.buscarCredencialPorEmail(client, empresa.id, emailNormalizado);

  if (usuario === null) {
    await password.verificarSenhaContraFicticio(senha);
    await tratarFalha(client, {
      chaveCooldown, empresaId: empresa.id, usuarioId: null, motivo: 'EMAIL_INEXISTENTE', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  // Roda sempre que existe um hash real para conferir, ativo ou não: reduz
  // a diferença de tempo observável entre "usuário inativo" e "senha
  // incorreta". O hash fictício é reservado aos ramos acima, onde não há
  // hash real algum (CLAUDE.md, seção 17).
  const senhaOk = await password.verificarSenha(usuario.senha_hash, senha);

  if (!usuario.ativo) {
    await tratarFalha(client, {
      chaveCooldown, empresaId: empresa.id, usuarioId: usuario.id, motivo: 'USUARIO_INATIVO', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  if (!senhaOk) {
    await tratarFalha(client, {
      chaveCooldown, empresaId: empresa.id, usuarioId: usuario.id, motivo: 'SENHA_INVALIDA', ip, dispositivo,
    });
    return { tipo: 'CREDENCIAIS_INVALIDAS' };
  }

  await loginTentativaRepo.registrarTentativa(client, {
    chaveCooldown, empresaId: empresa.id, usuarioId: usuario.id, sucesso: true, ip, dispositivo,
  });

  // Capturado agora — depois do Argon2id e do registro da tentativa, não
  // antes: expira_em precisa refletir o instante real da criação da sessão.
  const agoraSessao = await buscarInstanteReal(client);
  const expiraEm = somarMinutos(agoraSessao, authConfig.sessao.expiracaoMinutos);

  const tokenClaro = token.gerarTokenSessao();
  const tokenHash = token.hashTokenSessao(tokenClaro);

  // Se criar() lançar (ex.: colisão de token_hash, falha de conexão), a
  // exceção propaga sem ser capturada aqui: o chamador aciona ROLLBACK, e
  // este desfecho de sucesso nunca chega a ser produzido.
  const sessaoId = await sessaoRepo.criar(client, {
    empresaId: empresa.id,
    usuarioId: usuario.id,
    tokenHash,
    expiraEm,
    autenticadoVia: 'SENHA',
    ip,
    dispositivo,
  });

  return {
    tipo: 'SUCESSO',
    resultado: {
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil },
      empresa: { id: empresa.id, nome: empresa.nome, cnpj: empresa.cnpj },
      sessao: { id: sessaoId, expiraEm },
      token: tokenClaro,
    },
  };
}

/**
 * Autentica um usuário por CNPJ, e-mail e senha.
 *
 * @param {import('pg').Pool} pool
 * @param {{cnpj: string, email: string, senha: string, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{usuario: object, empresa: object, sessao: {id: string, expiraEm: Date}, token: string}>}
 */
async function autenticar(pool, { cnpj, email, senha, ip = null, dispositivo = null }) {
  // Falha cedo, sem qualquer conexão, se cnpj/email não forem
  // normalizáveis — gerarChaveCooldown já normaliza e valida internamente.
  const chaveCooldown = cooldown.gerarChaveCooldown(cnpj, email);
  const cnpjNormalizado = normalizarCnpj(cnpj);
  const emailNormalizado = normalizarEmail(email);

  const ipPreparado = prepararCampoOpcional(ip, TAMANHO_MAXIMO_IP, 'ip');
  const dispositivoPreparado = prepararCampoOpcional(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO, 'dispositivo');

  const client = await pool.connect();
  let desfecho;
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [cooldown.derivarAdvisoryLock64(chaveCooldown)]);

      const cooldownVigente = await loginTentativaRepo.buscarCooldownVigente(client, chaveCooldown);
      if (cooldownVigente !== null) {
        desfecho = { tipo: 'COOLDOWN_ATIVO', ativoAte: cooldownVigente.ativoAte };
      } else {
        desfecho = await resolverCredencial(client, {
          cnpjNormalizado,
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
