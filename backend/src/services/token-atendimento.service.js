'use strict';

const { HttpError } = require('../errors/HttpError');
const { authConfig } = require('../config/auth');
const { gerarTokenSessao, hashTokenSessao, tokenSessaoTemFormatoValido } = require('../security/token');
const atendimentoRepo = require('../repositories/token-atendimento.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Atendimento Token — atendimento temporário do funcionário no tablet (Etapa D). O tablet já foi autenticado pela credencial da
 * Etapa C (cookie gepi_tablet); este serviço decide só o atendimento. Empresa e tablet vêm SEMPRE do servidor (a credencial),
 * nunca do cliente. O funcionário é identificado por CPF ou MATRÍCULA (tipo explícito) e só se estiver ATIVO na empresa do tablet.
 *
 * PRAZO: 60 s de inatividade DESLIZANTES, sem teto absoluto, decididos pelo servidor com o relógio do banco (expira_em). Só a
 * atividade do funcionário (`atividade`) reinicia os 60 s; consultar o estado, polling e heartbeat NUNCA renovam e não escrevem,
 * exceto o fechamento por INATIVIDADE de um atendimento que de fato venceu.
 *
 * RECUSAR NÃO É ENCERRAR. A validade é derivada a cada pedido; o registro só é fechado por uma causa verdadeira:
 *   - vencido                       → fechado como INATIVIDADE (o prazo de inatividade realmente se esgotou);
 *   - funcionário deixou de ser ATIVO, ou o tablet foi reativado depois do início do atendimento → 401, SEM fechar o registro e
 *     SEM renovar (a 086 não tem motivo para essas causas e nenhum motivo falso é gravado); o registro vence em até 60 s ou é
 *     substituído por uma nova identificação válida (SUBSTITUIDO); a revogação do tablet o fecha como DISPOSITIVO_REVOGADO (Etapa B);
 *   - saída voluntária              → SAIDA;
 *   - nova identificação            → SUBSTITUIDO (ou INATIVIDADE, se o aberto já tinha vencido).
 *
 * CONCORRÊNCIA: toda escrita toma primeiro a trava da linha do tablet (a mesma da ativação e da revogação) e, depois, a do atendimento.
 * Sob a trava, a credencial que o pedido apresentou é conferida de novo: um pedido autenticado com a credencial ANTIGA que só
 * chega ao banco depois da recuperação do tablet é recusado (401), então a credencial antiga nunca abre nem opera atendimento.
 * Um atendimento iniciado antes da reativação do tablet é recusado mesmo com a credencial NOVA: a reativação é o CONSUMO do código de
 * ativação (token_ativacoes.usado_em, gravado pela Etapa C com clock_timestamp() sob a trava do tablet, então na ordem real), lido
 * sem tocar no código da Etapa C. O evento ATIVACAO não serve: o seu now() é o de início da transação (ver o repositório).
 *
 * A resposta de "atendimento inválido" é única (inexistente, de outro tablet ou empresa, encerrado, vencido, funcionário
 * inelegível, anterior à reativação): não revela se existiu, quem era nem por que acabou.
 */

const INATIVIDADE_SEGUNDOS = authConfig.atendimento.inatividadeSegundos;
const ACAO = Object.freeze({ INICIADO: 'TOKEN_ATENDIMENTO_INICIADO', ENCERRADO: 'TOKEN_ATENDIMENTO_ENCERRADO' });

const naoAutorizado = () => HttpError.unauthorized('DISPOSITIVO_NAO_AUTORIZADO', 'Dispositivo não autorizado');
const atendimentoInvalido = () => HttpError.unauthorized('ATENDIMENTO_INVALIDO', 'Atendimento inválido ou expirado');
const naoIdentificado = () => HttpError.notFound('FUNCIONARIO_NAO_IDENTIFICADO', 'Funcionário não identificado');

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

const primeiroNome = (nome) => String(nome).trim().split(/\s+/)[0];

/** A credencial apresentada ainda é a atual (ou a anterior, na carência) e o tablet segue ativo na empresa ativa. */
function credencialVale(tablet, credencialHash) {
  if (tablet === null || tablet.revogado_em !== null || tablet.empresa_ativa !== true) return false;
  return tablet.credencial_hash === credencialHash || tablet.credencial_anterior_hash === credencialHash;
}

function hashDoToken(token) {
  return tokenSessaoTemFormatoValido(token) ? hashTokenSessao(token) : null;
}

const resumo = (linha, restanteSegundos, expiraEm) => ({
  funcionario: { primeiroNome: primeiroNome(linha.funcionario_nome) },
  expiraEm,
  restanteSegundos: Math.floor(restanteSegundos),
});

async function auditarEncerramento(client, { empresaId, atendimentoId, dispositivoId, funcionarioId, motivo, ip, agente }) {
  await auditoriaRepo.registrar(client, {
    empresaId,
    usuarioId: null,
    acao: ACAO.ENCERRADO,
    referencia: String(atendimentoId),
    ip,
    dispositivo: agente,
    contexto: { motivo, dispositivoId, funcionarioId },
  });
}

/** Fecha como INATIVIDADE um atendimento aberto cujo prazo realmente venceu (sob a trava do atendimento). */
async function fecharVencido(client, linha, { ip, agente }) {
  const fechado = await atendimentoRepo.encerrar(client, { id: linha.id, motivo: 'INATIVIDADE' });
  if (fechado) {
    await auditarEncerramento(client, {
      empresaId: linha.empresa_id, atendimentoId: linha.id, dispositivoId: linha.dispositivo_id, funcionarioId: linha.funcionario_id, motivo: 'INATIVIDADE', ip, agente,
    });
  }
}

/**
 * Abre um atendimento. Devolve { atendimento, token }; o token em claro só existe nesta resposta (vai em Set-Cookie).
 * Tentativa não identificada ou barrada não escreve nada e não encerra o atendimento em curso.
 */
async function identificar(pool, { dispositivo, credencialHash, tipo, valor, ip = null, agente = null }) {
  const token = gerarTokenSessao();
  const resultado = await emTransacao(pool, async (client) => {
    const tablet = await atendimentoRepo.travarDispositivo(client, dispositivo.empresaId, dispositivo.id);
    if (!credencialVale(tablet, credencialHash)) return { negado: 'DISPOSITIVO' };
    const funcionario = await atendimentoRepo.buscarFuncionarioAtivo(client, { empresaId: tablet.empresa_id, tipo, valor });
    if (funcionario === null) return { negado: 'FUNCIONARIO' };

    const aberto = await atendimentoRepo.buscarAbertoDoDispositivoTravando(client, { empresaId: tablet.empresa_id, dispositivoId: tablet.id });
    if (aberto !== null) {
      const motivo = aberto.vencido ? 'INATIVIDADE' : 'SUBSTITUIDO';
      await atendimentoRepo.encerrar(client, { id: aberto.id, motivo });
      await auditarEncerramento(client, {
        empresaId: tablet.empresa_id, atendimentoId: aberto.id, dispositivoId: tablet.id, funcionarioId: aberto.funcionario_id, motivo, ip, agente,
      });
    }
    const criado = await atendimentoRepo.inserir(client, {
      empresaId: tablet.empresa_id, dispositivoId: tablet.id, funcionarioId: funcionario.id, tokenHash: hashTokenSessao(token), inatividadeSegundos: INATIVIDADE_SEGUNDOS,
    });
    await auditoriaRepo.registrar(client, {
      empresaId: tablet.empresa_id,
      usuarioId: null,
      acao: ACAO.INICIADO,
      referencia: String(criado.id),
      ip,
      dispositivo: agente,
      contexto: { tipoIdentificador: tipo, dispositivoId: tablet.id, funcionarioId: funcionario.id },
    });
    return { criado, funcionario };
  });

  if (resultado.negado === 'DISPOSITIVO') throw naoAutorizado();
  if (resultado.negado === 'FUNCIONARIO') throw naoIdentificado();
  return {
    token,
    atendimento: {
      funcionario: { primeiroNome: primeiroNome(resultado.funcionario.nome) },
      expiraEm: resultado.criado.expira_em,
      inatividadeSegundos: INATIVIDADE_SEGUNDOS,
    },
  };
}

/** Estado: só leitura. Nunca renova. Se venceu, fecha como INATIVIDADE (única escrita) e responde como inválido. */
async function estado(pool, { dispositivo, token, ip = null, agente = null }) {
  const tokenHash = hashDoToken(token);
  if (tokenHash === null) throw atendimentoInvalido();
  const filtro = { empresaId: dispositivo.empresaId, dispositivoId: dispositivo.id, tokenHash };
  const linha = await atendimentoRepo.buscarAbertoPorToken(pool, filtro);
  if (linha === null) throw atendimentoInvalido();

  if (linha.vencido) {
    await emTransacao(pool, async (client) => {
      const tablet = await atendimentoRepo.travarDispositivo(client, dispositivo.empresaId, dispositivo.id);
      if (tablet === null) return;
      const travada = await atendimentoRepo.buscarAbertoPorToken(client, { ...filtro, travar: true });
      if (travada !== null && travada.vencido) await fecharVencido(client, travada, { ip, agente });
    });
    throw atendimentoInvalido();
  }
  if (!linha.funcionario_ativo || linha.anterior_a_reativacao) throw atendimentoInvalido();
  return resumo(linha, Number(linha.restante_segundos), linha.expira_em);
}

/**
 * Operação de escrita sobre o atendimento aberto (atividade ou encerramento voluntário), sob a trava do tablet e do atendimento.
 * `aplicar(client, linha)` só roda com o atendimento válido e devolve o resultado da operação.
 */
async function operar(pool, { dispositivo, credencialHash, token, ip, agente }, aplicar) {
  const tokenHash = hashDoToken(token);
  if (tokenHash === null) throw atendimentoInvalido();
  const resultado = await emTransacao(pool, async (client) => {
    const tablet = await atendimentoRepo.travarDispositivo(client, dispositivo.empresaId, dispositivo.id);
    if (!credencialVale(tablet, credencialHash)) return { negado: 'DISPOSITIVO' };
    const linha = await atendimentoRepo.buscarAbertoPorToken(client, {
      empresaId: dispositivo.empresaId, dispositivoId: dispositivo.id, tokenHash, travar: true,
    });
    if (linha === null) return { negado: 'ATENDIMENTO' };
    if (linha.vencido) {
      await fecharVencido(client, linha, { ip, agente });
      return { negado: 'ATENDIMENTO' };
    }
    if (!linha.funcionario_ativo || linha.anterior_a_reativacao) return { negado: 'ATENDIMENTO' };
    return { ok: await aplicar(client, linha) };
  });
  if (resultado.negado === 'DISPOSITIVO') throw naoAutorizado();
  if (resultado.negado === 'ATENDIMENTO') throw atendimentoInvalido();
  return resultado.ok;
}

/** Interação válida do funcionário: reinicia INTEGRALMENTE os 60 s a partir de agora. */
function atividade(pool, entrada) {
  return operar(pool, entrada, async (client, linha) => {
    const renovado = await atendimentoRepo.renovar(client, { id: linha.id, inatividadeSegundos: INATIVIDADE_SEGUNDOS });
    // Sob a trava do atendimento e já verificado como não vencido: só falharia se o prazo vencesse neste instante.
    if (renovado === null) throw atendimentoInvalido();
    return resumo(linha, Number(renovado.restante_segundos), renovado.expira_em);
  });
}

/** Saída voluntária do funcionário. */
function encerrar(pool, entrada) {
  return operar(pool, entrada, async (client, linha) => {
    await atendimentoRepo.encerrar(client, { id: linha.id, motivo: 'SAIDA' });
    await auditarEncerramento(client, {
      empresaId: linha.empresa_id, atendimentoId: linha.id, dispositivoId: linha.dispositivo_id, funcionarioId: linha.funcionario_id, motivo: 'SAIDA', ip: entrada.ip, agente: entrada.agente,
    });
    return true;
  });
}

module.exports = { ACAO, INATIVIDADE_SEGUNDOS, identificar, estado, atividade, encerrar };
