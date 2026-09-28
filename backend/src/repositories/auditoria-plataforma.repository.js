'use strict';

const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');

/**
 * Repositório de auditoria da PLATAFORMA (logs_auditoria_plataforma,
 * migrations 029 e 048 — Autenticação Global, Pacote 2). Espelha
 * `auditoria.repository.js` (logs_auditoria) quase exatamente — mesma
 * disciplina de "só persiste o que recebe", mesma responsabilidade de quem
 * chama nunca incluir senha/hash/token/segredo em contexto/dados_*
 * (o banco também recusa, pela mesma função `logs_auditoria_bloquear_
 * dado_sensivel` reaproveitada na 029).
 *
 * Quem agiu (ator) e sobre quem (alvo) são colunas separadas. Cada função
 * fixa o próprio ator, e nenhuma aceita o tipo de ator de quem chama:
 *   registrar()              ADMINISTRADOR, com administrador_id obrigatório
 *   registrarOperacaoCli()   OPERACAO_CLI, sem administrador ator
 *   registrarEventoSistema() SISTEMA, sem administrador ator
 * O alvo (administrador_afetado_id) é opcional e nunca é o próprio ator.
 * `empresa_afetada_id` também é OPCIONAL.
 *
 * IP e User-Agent são cortados aqui no tamanho das colunas (45 e 150),
 * como em auditoria.repository.js (SEC-002). Operação de CLI e evento do
 * sistema não vêm de requisição e não os gravam.
 */

const ATOR = Object.freeze({ ADMINISTRADOR: 'ADMINISTRADOR', OPERACAO_CLI: 'OPERACAO_CLI', SISTEMA: 'SISTEMA' });

function exigirAdministrador(administradorId) {
  if (!Number.isInteger(administradorId) || administradorId <= 0) {
    throw new TypeError('identificador de administrador inválido');
  }
}

function exigirAlvoOpcional(alvoId, atorId) {
  if (alvoId === null) {
    return;
  }
  if (!Number.isInteger(alvoId) || alvoId <= 0) {
    throw new TypeError('identificador de administrador alvo inválido');
  }
  if (alvoId === atorId) {
    throw new TypeError('o alvo não pode ser o próprio administrador que agiu');
  }
}

function exigirEmpresaOpcional(empresaId) {
  if (empresaId !== null && (!Number.isInteger(empresaId) || empresaId <= 0)) {
    throw new TypeError('identificador de empresa afetada inválido');
  }
}

function exigirAcao(acao) {
  if (typeof acao !== 'string' || acao.length === 0 || acao.length > 60) {
    throw new TypeError('código de ação de auditoria inválido');
  }
}

function exigirObjetoOpcional(valor, nome) {
  if (valor === null) {
    return;
  }
  if (typeof valor !== 'object' || Array.isArray(valor)) {
    throw new TypeError(`${nome} deve ser um objeto ou null`);
  }
}

function recusarCampos(dados, campos) {
  for (const campo of campos) {
    if (Object.hasOwn(dados, campo)) {
      throw new TypeError('o ator desta auditoria é fixo e não vem de quem chama');
    }
  }
}

async function gravar(executor, ator, {
  administradorId,
  administradorAfetadoId,
  empresaAfetadaId,
  acao,
  referencia,
  descricao,
  ip,
  dispositivo,
  contexto,
  dadosAnteriores,
  dadosNovos,
}) {
  exigirAlvoOpcional(administradorAfetadoId, administradorId);
  exigirEmpresaOpcional(empresaAfetadaId);
  exigirAcao(acao);
  exigirObjetoOpcional(contexto, 'contexto');
  exigirObjetoOpcional(dadosAnteriores, 'dadosAnteriores');
  exigirObjetoOpcional(dadosNovos, 'dadosNovos');
  const ipGravado = ipParaGravar(ip);
  const dispositivoGravado = dispositivoParaGravar(dispositivo);

  const { rows } = await executor.query(
    `INSERT INTO logs_auditoria_plataforma
       (administrador_id, empresa_afetada_id, acao, referencia, descricao, ip, dispositivo, contexto, dados_anteriores, dados_novos,
        ator_tipo, administrador_afetado_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, criado_em`,
    [administradorId, empresaAfetadaId, acao, referencia, descricao, ipGravado, dispositivoGravado, contexto, dadosAnteriores, dadosNovos,
      ator, administradorAfetadoId],
  );

  return { id: rows[0].id, criadoEm: rows[0].criado_em };
}

/**
 * Grava a ação de um administrador. Propaga qualquer erro do PostgreSQL sem
 * traduzir — inclusive a rejeição por chave JSON sensível (erro de
 * programação do chamador, nunca um desfecho de negócio).
 *
 * @param {{query: Function}} executor
 * @param {{administradorId: number, administradorAfetadoId?: number|null,
 *          empresaAfetadaId?: number|null, acao: string,
 *          referencia?: string|null, descricao?: string|null, ip?: string|null,
 *          dispositivo?: string|null, contexto?: object|null,
 *          dadosAnteriores?: object|null, dadosNovos?: object|null}} dados
 * @returns {Promise<{id: string, criadoEm: Date}>}
 */
async function registrar(executor, dados) {
  recusarCampos(dados, ['atorTipo']);
  const {
    administradorId,
    administradorAfetadoId = null,
    empresaAfetadaId = null,
    acao,
    referencia = null,
    descricao = null,
    ip = null,
    dispositivo = null,
    contexto = null,
    dadosAnteriores = null,
    dadosNovos = null,
  } = dados;
  exigirAdministrador(administradorId);

  return gravar(executor, ATOR.ADMINISTRADOR, {
    administradorId, administradorAfetadoId, empresaAfetadaId, acao, referencia, descricao, ip, dispositivo, contexto, dadosAnteriores, dadosNovos,
  });
}

function semAtorHumano(ator) {
  return async (executor, dados) => {
    recusarCampos(dados, ['administradorId', 'atorTipo']);
    const {
      administradorAfetadoId = null,
      empresaAfetadaId = null,
      acao,
      referencia = null,
      descricao = null,
      contexto = null,
      dadosAnteriores = null,
      dadosNovos = null,
    } = dados;

    return gravar(executor, ator, {
      administradorId: null,
      administradorAfetadoId,
      empresaAfetadaId,
      acao,
      referencia,
      descricao,
      ip: null,
      dispositivo: null,
      contexto,
      dadosAnteriores,
      dadosNovos,
    });
  };
}

/** Operação executada por CLI: o CLI não identifica a pessoa que o rodou. */
const registrarOperacaoCli = semAtorHumano(ATOR.OPERACAO_CLI);

/** Evento da própria aplicação ou infraestrutura, sem ator humano. */
const registrarEventoSistema = semAtorHumano(ATOR.SISTEMA);

module.exports = { registrar, registrarOperacaoCli, registrarEventoSistema };
