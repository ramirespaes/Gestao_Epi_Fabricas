'use strict';

const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');

/**
 * Trilha de auditoria da identidade global (logs_auditoria_identidade,
 * migration 064). Mesma disciplina de auditoria-plataforma.repository.js,
 * sem empresa: o evento é da identidade. Só insere; a tabela recusa
 * alteração, exclusão e chave JSON sensível.
 *
 * `identidadeId` é sempre a identidade afetada. Cada função fixa o próprio
 * ator, e nenhuma aceita o tipo de ator de quem chama:
 *   registrarDaIdentidade()   IDENTIDADE: a própria pessoa, autenticada
 *   registrarEventoSistema()  SISTEMA: fluxo sem sessão (pedido e uso do
 *                             link de redefinição)
 * As duas gravam IP e dispositivo: o fluxo sem sessão também vem de uma
 * requisição.
 *
 * O executor chega por parâmetro; o pool nunca é importado.
 */

const ATOR = Object.freeze({ IDENTIDADE: 'IDENTIDADE', SISTEMA: 'SISTEMA' });

function exigirIdentidade(identidadeId) {
  if (!Number.isInteger(identidadeId) || identidadeId <= 0) {
    throw new TypeError('identificador de identidade inválido');
  }
}

// Mesmo contrato das outras trilhas: VARCHAR(60) NOT NULL, sem formato próprio.
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

function comAtor(ator) {
  /**
   * Grava uma linha da trilha. Propaga qualquer erro do PostgreSQL sem
   * traduzir, inclusive a recusa de chave JSON sensível, que é erro de
   * programação de quem chama.
   *
   * @returns {Promise<{id: string, criadoEm: Date}>}
   */
  return async (executor, dados) => {
    if (Object.hasOwn(dados, 'atorTipo')) {
      throw new TypeError('o ator desta auditoria é fixo e não vem de quem chama');
    }
    const {
      identidadeId,
      acao,
      referencia = null,
      descricao = null,
      ip = null,
      dispositivo = null,
      contexto = null,
      dadosAnteriores = null,
      dadosNovos = null,
    } = dados;
    exigirIdentidade(identidadeId);
    exigirAcao(acao);
    exigirObjetoOpcional(contexto, 'contexto');
    exigirObjetoOpcional(dadosAnteriores, 'dadosAnteriores');
    exigirObjetoOpcional(dadosNovos, 'dadosNovos');
    const ipGravado = ipParaGravar(ip);
    const dispositivoGravado = dispositivoParaGravar(dispositivo);

    const { rows } = await executor.query(
      `INSERT INTO logs_auditoria_identidade
         (identidade_id, ator_tipo, acao, referencia, descricao, ip, dispositivo, contexto, dados_anteriores, dados_novos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, criado_em`,
      [identidadeId, ator, acao, referencia, descricao, ipGravado, dispositivoGravado, contexto, dadosAnteriores, dadosNovos],
    );
    return { id: rows[0].id, criadoEm: rows[0].criado_em };
  };
}

/** Ação da própria pessoa, autenticada. */
const registrarDaIdentidade = comAtor(ATOR.IDENTIDADE);

/** Evento de fluxo sem sessão, registrado pela aplicação. */
const registrarEventoSistema = comAtor(ATOR.SISTEMA);

module.exports = { registrarDaIdentidade, registrarEventoSistema };
