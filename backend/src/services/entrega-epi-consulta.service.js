'use strict';

const { HttpError } = require('../errors/HttpError');
const funcionarioRepo = require('../repositories/funcionario.repository');
const materialRepo = require('../repositories/material.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const fichaRepo = require('../repositories/ficha-epi.repository');
const entregaRepo = require('../repositories/entrega-epi.repository');
const itemRepo = require('../repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../repositories/entrega-epi-confirmacao.repository');
const contextoRepo = require('../repositories/entrega-epi-contexto.repository');
const { exigirDataOperacional } = require('../utils/data-operacional');
const { entregaPublica, fichaPublica, funcionarioAtualPublico } = require('./entrega-epi-publica');

/**
 * Leituras da entrega de EPI: o contexto para realizar uma entrega (10E) e a
 * ficha histórica (10F). Só consulta, sem transação e sem auditoria; a
 * gravação é de entrega-epi.service.js. Empresa sempre da sessão (quem
 * chama garante). Autorização é das rotas: REALIZAR_ENTREGA para o
 * contexto, epiFicha.visualizar para a ficha.
 *
 * Histórico sai dos snapshots das entregas; o cadastro atual do trabalhador
 * aparece separado, como `funcionarioAtual`, e nunca no lugar deles.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

const gheAtual = async (pool, empresaId, funcionario) => {
  if (funcionario.grupoHomogeneoId === null) return null;
  const ghe = await gheRepo.buscarPorId(pool, empresaId, funcionario.grupoHomogeneoId);
  return ghe === null ? null : { id: ghe.id, nome: ghe.nome };
};

// Trabalhador apto a receber EPI: existe na empresa e está ativo (mesmos códigos do serviço de gravação).
async function trabalhadorApto(pool, empresaId, funcionarioId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  const funcionario = await funcionarioRepo.buscarPorId(pool, empresaId, funcionarioId);
  if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Trabalhador não encontrado');
  if (funcionario.ativo !== true) throw HttpError.conflict('FUNCIONARIO_INATIVO', 'Trabalhador inativo não recebe EPI');
  return funcionario;
}

/** Trabalhadores ativos da empresa para seleção na entrega (nome e matrícula; nunca CPF na busca). */
async function localizarTrabalhadores(pool, { empresaId, busca = null, pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  const filtros = { busca };
  const [linhas, total] = await Promise.all([
    contextoRepo.listarFuncionarios(pool, empresaId, { ...filtros, pagina, limite }),
    contextoRepo.contarFuncionarios(pool, empresaId, filtros),
  ]);
  const funcionarios = linhas.map((f) => {
    const { ativo, ...publico } = funcionarioAtualPublico(f);
    return { ...publico, ghe: f.ghe };
  });
  return { funcionarios, total, pagina, limite };
}

/** Trabalhador pelo CPF exato da empresa, apto a receber EPI; o CPF só chega pelo corpo. */
async function localizarTrabalhadorPorCpf(pool, { empresaId, cpf }) {
  exigirId(empresaId, 'identificador de empresa');
  const funcionario = await funcionarioRepo.buscarPorCpf(pool, empresaId, cpf);
  if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Trabalhador não encontrado');
  if (funcionario.ativo !== true) throw HttpError.conflict('FUNCIONARIO_INATIVO', 'Trabalhador inativo não recebe EPI');
  const { ativo, ...publico } = funcionarioAtualPublico(funcionario);
  return { funcionario: { ...publico, ghe: await gheAtual(pool, empresaId, funcionario) } };
}

/** Contexto para iniciar a entrega: trabalhador (CPF mascarado), GHE atual e ficha existente. */
async function contextoDoTrabalhador(pool, { empresaId, funcionarioId }) {
  const funcionario = await trabalhadorApto(pool, empresaId, funcionarioId);
  const [ghe, ficha] = await Promise.all([
    gheAtual(pool, empresaId, funcionario),
    fichaRepo.buscarPorFuncionario(pool, empresaId, funcionarioId),
  ]);
  return { funcionario: funcionarioAtualPublico(funcionario), ghe, ficha: fichaPublica(ficha) };
}

/** Materiais ativos da empresa para seleção, com previsto_no_ghe pelo GHE do trabalhador. */
async function listarMateriaisDoContexto(pool, {
  empresaId, funcionarioId, busca = null, previstoNoGhe = null, pagina, limite,
}) {
  const funcionario = await trabalhadorApto(pool, empresaId, funcionarioId);
  const filtros = { gheId: funcionario.grupoHomogeneoId, busca, previstoNoGhe };
  const [materiais, total] = await Promise.all([
    contextoRepo.listarMateriais(pool, empresaId, { ...filtros, pagina, limite }),
    contextoRepo.contarMateriais(pool, empresaId, filtros),
  ]);
  return { funcionarioId, gheId: funcionario.grupoHomogeneoId, materiais, total, pagina, limite };
}

/** Lotes com saldo do material, com a situação do CA na data operacional; a escolha continua sendo do usuário. */
async function listarLotesDoContexto(pool, { empresaId, funcionarioId, materialId, hoje }) {
  exigirId(materialId, 'identificador de material');
  exigirDataOperacional(hoje);
  await trabalhadorApto(pool, empresaId, funcionarioId);
  const material = await materialRepo.buscarPorId(pool, empresaId, materialId);
  if (material === null) throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', 'Material não encontrado');
  const lotes = await contextoRepo.listarLotes(pool, empresaId, materialId, hoje);
  return {
    material: {
      id: material.id, nome: material.nome, ativo: material.ativo, exigeTamanho: material.exigeTamanho, oculosComGrau: material.oculosComGrau, prazoUsoDias: material.prazoUsoDias,
    },
    hoje,
    lotes,
  };
}

// ── Ficha (10F) ─────────────────────────────────────────────────────

async function fichaDaEmpresa(pool, empresaId, fichaId) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(fichaId, 'identificador de ficha');
  const ficha = await fichaRepo.buscarPorId(pool, empresaId, fichaId);
  if (ficha === null) throw HttpError.notFound('FICHA_NAO_ENCONTRADA', 'Ficha não encontrada');
  return ficha;
}

async function listarFichas(pool, { empresaId, pagina, limite, ...filtros }) {
  exigirId(empresaId, 'identificador de empresa');
  const [linhas, total] = await Promise.all([
    fichaRepo.listar(pool, empresaId, { ...filtros, pagina, limite }),
    fichaRepo.contar(pool, empresaId, filtros),
  ]);
  const fichas = linhas.map((l) => ({
    ...fichaPublica(l.ficha), funcionarioAtual: funcionarioAtualPublico(l.funcionarioAtual), resumo: l.resumo,
  }));
  return { fichas, total, pagina, limite };
}

/** Trabalhador pelo CPF exato da empresa e a ficha dele, se houver; a leitura nunca cria ficha. */
async function consultarFichaPorCpf(pool, { empresaId, cpf }) {
  exigirId(empresaId, 'identificador de empresa');
  const funcionario = await funcionarioRepo.buscarPorCpf(pool, empresaId, cpf);
  if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Trabalhador não encontrado');
  const ficha = await fichaRepo.buscarPorFuncionario(pool, empresaId, funcionario.id);
  return { funcionario: funcionarioAtualPublico(funcionario), ficha: fichaPublica(ficha) };
}

async function detalharFicha(pool, { empresaId, fichaId }) {
  const ficha = await fichaDaEmpresa(pool, empresaId, fichaId);
  const funcionario = await funcionarioRepo.buscarPorId(pool, empresaId, ficha.funcionarioId);
  const [ghe, resumo] = await Promise.all([
    gheAtual(pool, empresaId, funcionario),
    fichaRepo.resumo(pool, empresaId, ficha.id),
  ]);
  return {
    ficha: fichaPublica(ficha),
    funcionarioAtual: { ...funcionarioAtualPublico(funcionario), ghe },
    resumo,
  };
}

// Itens e confirmações das entregas da página, em duas consultas, sem multiplicar linhas.
async function comporEntregas(pool, empresaId, entregas, fichas) {
  const ids = entregas.map((e) => e.id);
  const [itens, confirmacoes] = await Promise.all([
    itemRepo.listarPorEntregas(pool, empresaId, ids),
    confirmacaoRepo.listarPorEntregas(pool, empresaId, ids),
  ]);
  const porEntrega = new Map(ids.map((id) => [id, []]));
  for (const item of itens) porEntrega.get(item.entregaId).push(item);
  const confirmacaoDe = new Map(confirmacoes.map((c) => [c.entregaId, c]));
  return entregas.map((entrega) => entregaPublica({
    entrega, ficha: fichas.get(entrega.fichaId), itens: porEntrega.get(entrega.id), confirmacao: confirmacaoDe.get(entrega.id) ?? null,
  }));
}

async function listarEntregasDaFicha(pool, {
  empresaId, fichaId, de = null, ate = null, pagina, limite,
}) {
  const ficha = await fichaDaEmpresa(pool, empresaId, fichaId);
  const periodo = { de, ate };
  const [entregas, total] = await Promise.all([
    entregaRepo.listarPorFicha(pool, empresaId, ficha.id, { ...periodo, pagina, limite }),
    entregaRepo.contarPorFicha(pool, empresaId, ficha.id, periodo),
  ]);
  return {
    ficha: { id: ficha.id, numero: ficha.numero, funcionarioId: ficha.funcionarioId },
    entregas: await comporEntregas(pool, empresaId, entregas, new Map([[ficha.id, ficha]])),
    total,
    pagina,
    limite,
  };
}

async function buscarEntrega(pool, { empresaId, entregaId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(entregaId, 'identificador de entrega');
  const entrega = await entregaRepo.buscarPorId(pool, empresaId, entregaId);
  if (entrega === null) throw HttpError.notFound('ENTREGA_NAO_ENCONTRADA', 'Entrega não encontrada');
  const ficha = await fichaRepo.buscarPorId(pool, empresaId, entrega.fichaId);
  const [publica] = await comporEntregas(pool, empresaId, [entrega], new Map([[ficha.id, ficha]]));
  return { entrega: publica };
}

module.exports = {
  localizarTrabalhadores,
  localizarTrabalhadorPorCpf,
  contextoDoTrabalhador,
  listarMateriaisDoContexto,
  listarLotesDoContexto,
  listarFichas,
  consultarFichaPorCpf,
  detalharFicha,
  listarEntregasDaFicha,
  buscarEntrega,
};
