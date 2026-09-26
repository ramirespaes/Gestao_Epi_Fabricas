'use strict';

const { HttpError } = require('../errors/HttpError');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const materialRepo = require('../repositories/material.repository');
const gheMaterialRepo = require('../repositories/ghe-material.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Serviço da matriz GHE × EPI (Bloco 9, Etapa C, Parte C5).
 *
 * Mesmo desenho de grupo-homogeneo-exposicao.service.js: `pool` por
 * parâmetro, transação explícita com ROLLBACK em qualquer exceção,
 * auditoria (logs_auditoria) na MESMA transação da escrita, e nenhuma
 * decisão de autorização aqui (recurso `employeeGroups` nas rotas).
 *
 * Regras (decisões do C5):
 *   - consultar: GHE da empresa (ativo ou não); vínculos existentes
 *     continuam visíveis mesmo com GHE/material inativos;
 *   - incluir: GHE e material existem NA EMPRESA DA SESSÃO e estão ATIVOS
 *     — lidos com FOR SHARE, para que uma inativação concorrente espere o
 *     COMMIT (a FK composta garante empresa, nunca `ativo`);
 *   - remover: exclusão física do vínculo, permitida mesmo com GHE ou
 *     material inativos.
 * GHE ou material de outra empresa são indistinguíveis de inexistentes (404).
 */

const VIOLACAO_UNIQUE = '23505';

const ACAO_VINCULO = 'GHE_MATERIAL_VINCULADO';
const ACAO_DESVINCULO = 'GHE_MATERIAL_DESVINCULADO';

const gheNaoEncontrado = () => HttpError.notFound('GHE_NAO_ENCONTRADO', 'GHE não encontrado');

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
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

async function consultar(pool, { empresaId, gheId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');

  const ghe = await gheRepo.buscarPorId(pool, empresaId, gheId);
  if (ghe === null) {
    throw gheNaoEncontrado();
  }
  const materiais = await gheMaterialRepo.listarMatriz(pool, empresaId, gheId);
  return { grupo: { id: ghe.id, nome: ghe.nome, ativo: ghe.ativo }, materiais };
}

async function vincular(pool, {
  empresaId, atorId, gheId, materialId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(gheId, 'identificador de GHE');
  exigirId(materialId, 'identificador de material');

  return emTransacao(pool, async (client) => {
    const ghe = await gheRepo.buscarPorIdParaVinculo(client, empresaId, gheId);
    if (ghe === null) {
      throw gheNaoEncontrado();
    }
    if (!ghe.ativo) {
      throw HttpError.conflict('GHE_INATIVO', 'GHE inativo não aceita novos vínculos');
    }
    const material = await materialRepo.buscarPorIdParaVinculo(client, empresaId, materialId);
    if (material === null) {
      throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', 'Material não encontrado');
    }
    if (!material.ativo) {
      throw HttpError.conflict('MATERIAL_INATIVO', 'Material inativo não pode ser vinculado');
    }

    let vinculo;
    try {
      vinculo = await gheMaterialRepo.inserir(client, { empresaId, gheId, materialId });
    } catch (erro) {
      if (erro.code === VIOLACAO_UNIQUE) {
        throw HttpError.conflict('GHE_MATERIAL_JA_VINCULADO', 'Este EPI já está vinculado ao GHE');
      }
      throw erro;
    }

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_VINCULO, referencia: String(gheId), ip, dispositivo,
      dadosNovos: { grupoHomogeneoId: gheId, materialId },
    });

    return vinculo;
  });
}

async function desvincular(pool, {
  empresaId, atorId, gheId, materialId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(gheId, 'identificador de GHE');
  exigirId(materialId, 'identificador de material');

  return emTransacao(pool, async (client) => {
    const ghe = await gheRepo.buscarPorId(client, empresaId, gheId);
    if (ghe === null) {
      throw gheNaoEncontrado();
    }
    const removido = await gheMaterialRepo.remover(client, { empresaId, gheId, materialId });
    if (!removido) {
      throw HttpError.notFound('GHE_MATERIAL_NAO_VINCULADO', 'Este EPI não está vinculado ao GHE');
    }

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_DESVINCULO, referencia: String(gheId), ip, dispositivo,
      dadosAnteriores: { grupoHomogeneoId: gheId, materialId },
    });

    return { removido: true };
  });
}

module.exports = { consultar, vincular, desvincular };
