'use strict';

const funcionarioRepo = require('../repositories/funcionario.repository');
const entregaContextoRepo = require('../repositories/entrega-epi-contexto.repository');
const contextoRepo = require('../repositories/solicitacao-epi-contexto.repository');
const { trabalhadorDoContexto, materialDoContexto } = require('./solicitacao-epi-publica');
const { HttpError } = require('../errors/HttpError');
const { exigirPodeReceberEpi } = require('../utils/situacao-funcionario');

/**
 * Contexto da nova solicitação de EPI (12G-0, L2), só leitura: o que quem pede
 * (recurso `request`, criar, decidido pela rota) precisa para escolher o
 * trabalhador e o material sem depender de outras permissões. A empresa vem da
 * sessão. O trabalhador sai sem CPF (a busca é por nome ou matrícula); o
 * material sai sem nenhum número de estoque. Cada lista e o seu total saem de
 * um retrato único do banco.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

async function emLeitura(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroLeitura) {
      await client.query('ROLLBACK');
      throw erroLeitura;
    }
  } finally {
    client.release();
  }
}

/** Trabalhadores ATIVOS da empresa por nome ou matrícula (a mesma busca do contexto da entrega), em ordem de nome. */
async function localizarTrabalhadores(pool, {
  empresaId, busca = null, pagina, limite,
}) {
  exigirId(empresaId, 'identificador de empresa');
  return emLeitura(pool, async (client) => {
    const linhas = await entregaContextoRepo.listarFuncionarios(client, empresaId, { busca, pagina, limite });
    const total = await entregaContextoRepo.contarFuncionarios(client, empresaId, { busca });
    return {
      funcionarios: linhas.map(trabalhadorDoContexto), total, pagina, limite,
    };
  });
}

/**
 * Materiais ativos para o trabalhador, com a previsão no GHE atual dele e as
 * sugestões de tamanho; o não classificado vem com exigeTamanho nulo (a
 * criação o recusa). O trabalhador
 * inexistente ou de outra empresa é "não encontrado"; o inativo não recebe EPI
 * (os mesmos códigos da criação).
 *
 * @throws {HttpError} 404 trabalhador fora da empresa; 409 trabalhador inativo
 */
async function listarMateriais(pool, {
  empresaId, funcionarioId, busca = null, previstoNoGhe = null, pagina, limite,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  return emLeitura(pool, async (client) => {
    const funcionario = await funcionarioRepo.buscarPorId(client, empresaId, funcionarioId);
    if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Trabalhador não encontrado');
    exigirPodeReceberEpi(funcionario);
    const filtros = { gheId: funcionario.grupoHomogeneoId, busca, previstoNoGhe };
    const materiais = await contextoRepo.listarMateriais(client, empresaId, { ...filtros, pagina, limite });
    const total = await contextoRepo.contarMateriais(client, empresaId, filtros);
    return {
      funcionarioId, materiais: materiais.map(materialDoContexto), total, pagina, limite,
    };
  });
}

module.exports = { localizarTrabalhadores, listarMateriais };
