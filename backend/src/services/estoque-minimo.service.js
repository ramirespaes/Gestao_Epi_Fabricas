'use strict';

const { HttpError } = require('../errors/HttpError');
const materialRepo = require('../repositories/material.repository');
const minimoRepo = require('../repositories/estoque-minimo.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Configuração do mínimo de estoque por tamanho (12D-2, migration 067).
 *
 * O mínimo PADRÃO continua em materiais.estoque_minimo e vale para o tamanho
 * sem linha própria. Aqui se grava só a SOBRESCRITA por tamanho, apenas para
 * material que exige tamanho; o zero próprio é válido ("este tamanho não tem
 * mínimo") e remover a sobrescrita volta o tamanho a herdar o padrão (apaga a
 * linha, nunca grava zero).
 *
 * É configuração: não toma trava de par de estoque, e a ordem global de travas
 * da reserva (idempotência, solicitação, trabalhador, materiais, pares, lotes,
 * numeração) não muda. A gravação lê o material com FOR SHARE (a mesma trava do
 * gatilho da 067), então ela e a troca de `exige_tamanho` do cadastro (FOR
 * UPDATE) se serializam no material, nos dois sentidos, sem ciclo.
 *
 * Idempotência funcional: gravar o valor que já existe, ou remover o que não
 * existe, é uma operação válida que não muda nada e NÃO audita (`alterado:
 * false`), como inativar um material já inativo. A auditoria (só ids e números)
 * entra na mesma transação da alteração. Autorização é da rota
 * (materials.visualizar para ler, materials.editar para alterar); a empresa e o
 * ator vêm da sessão.
 */

const ACAO_DEFINIDO = 'ESTOQUE_MINIMO_DEFINIDO';
const ACAO_REMOVIDO = 'ESTOQUE_MINIMO_REMOVIDO';

const MSG_MATERIAL_NAO_ENCONTRADO = 'Material não encontrado';
const MSG_NAO_EXIGE_TAMANHO = 'Este material não usa tamanho: o mínimo dele é o padrão do cadastro';
const MSG_NAO_CLASSIFICADO = 'Defina no cadastro se o material exige tamanho antes de configurar o mínimo por tamanho';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`identificador de ${nome} inválido`);
  }
}

// Mesma forma dos lotes: texto de 1 a 20 caracteres, sem espaço nas pontas.
function exigirTamanho(tamanho) {
  if (typeof tamanho !== 'string' || tamanho.length === 0 || tamanho !== tamanho.trim() || Array.from(tamanho).length > minimoRepo.TAMANHO_MAXIMO) {
    throw new TypeError('tamanho inválido');
  }
}

function exigirMinimo(minimo) {
  if (!Number.isInteger(minimo) || minimo < 0 || minimo > 2147483647) {
    throw new TypeError('mínimo inválido');
  }
}

/** Mesmo padrão transacional de material.service.js e estoque.service.js. */
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

async function estadoDoMaterial(executor, empresaId, material) {
  const sobrescritas = await minimoRepo.listarPorMaterial(executor, empresaId, material.id);
  return {
    materialId: material.id,
    estoqueMinimoPadrao: material.estoqueMinimo,
    exigeTamanho: material.exigeTamanho,
    overrides: sobrescritas.map(({ tamanho, minimo }) => ({ tamanho, minimo })),
  };
}

// O material precisa existir na empresa; a leitura compartilhada o mantém como lido até o COMMIT.
async function materialTravado(client, empresaId, materialId) {
  const material = await materialRepo.buscarPorIdParaVinculo(client, empresaId, materialId);
  if (material === null) {
    throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
  }
  return material;
}

/**
 * O mínimo padrão do material e as sobrescritas por tamanho. Leitura: não abre
 * transação e não audita.
 *
 * @throws {HttpError} 404 quando o material não existe NESTA empresa
 */
async function consultar(pool, { empresaId, materialId }) {
  exigirId(empresaId, 'empresa');
  exigirId(materialId, 'material');
  const material = await materialRepo.buscarPorId(pool, empresaId, materialId);
  if (material === null) {
    throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
  }
  return estadoDoMaterial(pool, empresaId, material);
}

/**
 * Cria ou altera o mínimo próprio de um tamanho.
 *
 * @returns {Promise<{criado: boolean, alterado: boolean, materialId: number, estoqueMinimoPadrao: number, exigeTamanho: boolean|null, overrides: object[]}>}
 * @throws {HttpError} 404 material fora da empresa; 409 material que não exige tamanho ou ainda não classificado
 */
async function definir(pool, {
  empresaId, atorId, materialId, tamanho, minimo, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'empresa');
  exigirId(atorId, 'ator');
  exigirId(materialId, 'material');
  exigirTamanho(tamanho);
  exigirMinimo(minimo);

  return emTransacao(pool, async (client) => {
    const material = await materialTravado(client, empresaId, materialId);
    if (material.exigeTamanho === null || material.exigeTamanho === undefined) {
      throw HttpError.conflict('MATERIAL_TAMANHO_NAO_CLASSIFICADO', MSG_NAO_CLASSIFICADO);
    }
    if (material.exigeTamanho === false) {
      throw HttpError.conflict('MATERIAL_NAO_EXIGE_TAMANHO', MSG_NAO_EXIGE_TAMANHO);
    }

    const gravacao = await minimoRepo.gravar(client, empresaId, { materialId, tamanho, minimo });
    if (gravacao.alterado) {
      await auditoriaRepo.registrar(client, {
        empresaId,
        usuarioId: atorId,
        acao: ACAO_DEFINIDO,
        referencia: String(materialId),
        ip,
        dispositivo,
        contexto: {
          materialId, tamanho, minimoAnterior: gravacao.minimoAnterior, minimoNovo: gravacao.minimo,
        },
      });
    }
    return { criado: gravacao.criado, alterado: gravacao.alterado, ...await estadoDoMaterial(client, empresaId, material) };
  });
}

/**
 * Remove o mínimo próprio de um tamanho: ele volta a herdar o mínimo padrão do
 * material. Sem sobrescrita, não há o que remover: responde como sucesso, com
 * `alterado: false`, e não audita.
 *
 * @throws {HttpError} 404 material fora da empresa
 */
async function remover(pool, {
  empresaId, atorId, materialId, tamanho, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'empresa');
  exigirId(atorId, 'ator');
  exigirId(materialId, 'material');
  exigirTamanho(tamanho);

  return emTransacao(pool, async (client) => {
    const material = await materialTravado(client, empresaId, materialId);
    const remocao = await minimoRepo.removerComAnterior(client, empresaId, materialId, tamanho);
    if (remocao.removido) {
      await auditoriaRepo.registrar(client, {
        empresaId,
        usuarioId: atorId,
        acao: ACAO_REMOVIDO,
        referencia: String(materialId),
        ip,
        dispositivo,
        contexto: {
          materialId, tamanho, minimoAnterior: remocao.minimoAnterior, minimoEfetivoDepois: material.estoqueMinimo,
        },
      });
    }
    return { alterado: remocao.removido, ...await estadoDoMaterial(client, empresaId, material) };
  });
}

module.exports = {
  consultar, definir, remover, ACAO_DEFINIDO, ACAO_REMOVIDO,
};
