'use strict';

const { HttpError } = require('../errors/HttpError');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const tipoRepo = require('../repositories/tipo-material.repository');
const gheTipoRepo = require('../repositories/ghe-tipo-material.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Serviço do vínculo GHE × tipo de material (evolução GHE / importação GHE-EPI, Incremento 3).
 *
 * Mesmo desenho de ghe-material.service.js: `pool` por parâmetro, transação explícita com ROLLBACK, auditoria na
 * MESMA transação da escrita, nenhuma decisão de autorização aqui (recurso `employeeGroups` nas rotas).
 *
 * Regras:
 *   - consultar: GHE da empresa (ativo ou não); a matriz traz os tipos ativos e os inativos já ligados;
 *   - definir (PUT idempotente): vínculo NOVO exige GHE e tipo ATIVOS; vínculo que JÁ existe pode ter a
 *     classificação corrigida mesmo com GHE ou tipo inativos, e a mesma classificação não escreve nem audita;
 *   - remover: exclusão física SÓ desta relação, permitida com GHE ou tipo inativos.
 * GHE ou tipo de outra empresa são indistinguíveis de inexistentes (404).
 *
 * Concorrência: GHE e tipo são lidos com FOR SHARE (a inativação concorrente espera o COMMIT; a FK composta garante
 * empresa, nunca `ativo`); depois o vínculo é travado com FOR UPDATE. A criação usa ON CONFLICT DO NOTHING: quem
 * perde a corrida relê o vínculo já gravado e segue como alteração (ou como no-op), então cada alteração auditada
 * parte do estado realmente persistido e a unicidade do banco nunca vira erro 500.
 */

const ACAO_VINCULO = 'GHE_TIPO_MATERIAL_VINCULADO';
const ACAO_ALTERACAO = 'GHE_TIPO_MATERIAL_ALTERADO';
const ACAO_DESVINCULO = 'GHE_TIPO_MATERIAL_DESVINCULADO';

const LIMITE_TENTATIVAS = 3;

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

const dadosDoVinculo = (gheId, tipoId, classificacao) => ({ grupoHomogeneoId: gheId, tipoMaterialId: tipoId, classificacao });

async function consultar(pool, { empresaId, gheId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');

  const ghe = await gheRepo.buscarPorId(pool, empresaId, gheId);
  if (ghe === null) {
    throw gheNaoEncontrado();
  }
  const tipos = await gheTipoRepo.listarMatriz(pool, empresaId, gheId);
  return { grupo: { id: ghe.id, nome: ghe.nome, ativo: ghe.ativo }, tipos };
}

async function definir(pool, {
  empresaId, atorId, gheId, tipoId, classificacao, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(gheId, 'identificador de GHE');
  exigirId(tipoId, 'identificador de tipo');

  return emTransacao(pool, async (client) => {
    const ghe = await gheRepo.buscarPorIdParaVinculo(client, empresaId, gheId);
    if (ghe === null) {
      throw gheNaoEncontrado();
    }
    const tipo = await tipoRepo.buscarPorIdParaVinculo(client, empresaId, tipoId);
    if (tipo === null) {
      throw HttpError.notFound('TIPO_MATERIAL_NAO_ENCONTRADO', 'Tipo de material não encontrado');
    }

    let existente = await gheTipoRepo.buscarParaAtualizacao(client, { empresaId, gheId, tipoId });

    // Vínculo novo: exige GHE e tipo ativos. Se outro pedido o criar entre a leitura e o INSERT, relê o existente
    // (travado) e segue como alteração ou no-op; a repetição só cobre o vínculo criado e removido nesse intervalo.
    for (let tentativa = 0; existente === null; tentativa += 1) {
      if (!ghe.ativo) {
        throw HttpError.conflict('GHE_INATIVO', 'GHE inativo não aceita novos vínculos');
      }
      if (!tipo.ativo) {
        throw HttpError.conflict('TIPO_MATERIAL_INATIVO', 'Tipo de material inativo não pode ser vinculado');
      }
      const criado = await gheTipoRepo.inserirSeAusente(client, { empresaId, gheId, tipoId, classificacao });
      if (criado !== null) {
        await auditoriaRepo.registrar(client, {
          empresaId, usuarioId: atorId, acao: ACAO_VINCULO, referencia: String(gheId), ip, dispositivo,
          dadosNovos: dadosDoVinculo(gheId, tipoId, classificacao),
        });
        return { vinculo: criado, criado: true, alterado: true };
      }
      existente = await gheTipoRepo.buscarParaAtualizacao(client, { empresaId, gheId, tipoId });
      if (existente === null && tentativa >= LIMITE_TENTATIVAS) {
        throw HttpError.internal(new Error('vínculo GHE × tipo instável durante a criação'));
      }
    }

    if (existente.classificacao === classificacao) {
      return { vinculo: existente, criado: false, alterado: false };
    }

    const atualizado = await gheTipoRepo.atualizarClassificacao(client, { empresaId, gheId, tipoId, classificacao });
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_ALTERACAO, referencia: String(gheId), ip, dispositivo,
      dadosAnteriores: dadosDoVinculo(gheId, tipoId, existente.classificacao),
      dadosNovos: dadosDoVinculo(gheId, tipoId, atualizado.classificacao),
    });
    return { vinculo: atualizado, criado: false, alterado: true };
  });
}

async function desvincular(pool, {
  empresaId, atorId, gheId, tipoId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(gheId, 'identificador de GHE');
  exigirId(tipoId, 'identificador de tipo');

  return emTransacao(pool, async (client) => {
    const ghe = await gheRepo.buscarPorId(client, empresaId, gheId);
    if (ghe === null) {
      throw gheNaoEncontrado();
    }
    const removido = await gheTipoRepo.remover(client, { empresaId, gheId, tipoId });
    if (removido === null) {
      throw HttpError.notFound('GHE_TIPO_MATERIAL_NAO_VINCULADO', 'Este tipo de material não está vinculado ao GHE');
    }

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_DESVINCULO, referencia: String(gheId), ip, dispositivo,
      dadosAnteriores: dadosDoVinculo(gheId, tipoId, removido.classificacao),
    });

    return { removido: true };
  });
}

module.exports = { consultar, definir, desvincular };
