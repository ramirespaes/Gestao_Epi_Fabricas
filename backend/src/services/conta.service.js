'use strict';

const { HttpError } = require('../errors/HttpError');
const { ipParaGravar, dispositivoParaGravar } = require('../utils/origem-requisicao');
const identidadeRepo = require('../repositories/identidade.repository');
const auditoriaIdentidadeRepo = require('../repositories/auditoria-identidade.repository');
const { temaValido, modoVisualValido } = require('../utils/preferencias-aparencia');

/**
 * Configurações — telefone e aparência da identidade autenticada.
 *
 * QUEM AGE vem da sessão global (controller), nunca do corpo: uma identidade
 * só altera a si mesma. A linha é travada (FOR UPDATE), o que mudou é
 * comparado com o gravado e só a mudança real gera auditoria
 * CONTA_ATUALIZADA — com os NOMES dos campos, nunca os valores (telefone é
 * dado pessoal; tema e modo visual não interessam à auditoria).
 */

const ACAO = 'CONTA_ATUALIZADA';

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

function exigirId(valor) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError('identificador de identidade inválido');
  }
}

/**
 * @param {import('pg').Pool} pool
 * @param {{identidadeId: number, telefone?: string|null, telefoneInformado?: boolean,
 *          tema?: string, modoVisual?: string, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{telefone: string|null, tema: string, modoVisual: string}>}
 */
async function atualizar(pool, dados) {
  const { identidadeId, telefone = null, telefoneInformado = false, tema, modoVisual } = dados;
  exigirId(identidadeId);
  if (tema !== undefined && !temaValido(tema)) {
    throw new TypeError('tema inválido');
  }
  if (modoVisual !== undefined && !modoVisualValido(modoVisual)) {
    throw new TypeError('modo visual inválido');
  }
  if (!telefoneInformado && tema === undefined && modoVisual === undefined) {
    throw new TypeError('nada a atualizar');
  }
  const origem = { ip: ipParaGravar(dados.ip ?? null), dispositivo: dispositivoParaGravar(dados.dispositivo ?? null) };

  return emTransacao(pool, async (client) => {
    const atual = await identidadeRepo.buscarPorIdParaAtualizacao(client, identidadeId);
    if (atual === null || !atual.ativo) {
      throw HttpError.unauthorized('SESSAO_INVALIDA', 'Sessão inválida ou expirada');
    }
    const campos = [];
    if (telefoneInformado && (atual.telefone ?? null) !== telefone) campos.push('telefone');
    if (tema !== undefined && atual.tema !== tema) campos.push('tema');
    if (modoVisual !== undefined && atual.modoVisual !== modoVisual) campos.push('modoVisual');
    if (campos.length === 0) {
      return { telefone: atual.telefone ?? null, tema: atual.tema, modoVisual: atual.modoVisual };
    }
    const conta = await identidadeRepo.atualizarConta(client, identidadeId, {
      telefone, telefoneInformado, tema: tema ?? null, modoVisual: modoVisual ?? null,
    });
    await auditoriaIdentidadeRepo.registrarDaIdentidade(client, {
      identidadeId, acao: ACAO, contexto: { origem: 'CONFIGURACOES', campos }, ...origem,
    });
    return conta;
  });
}

module.exports = { atualizar };
