'use strict';

const { HttpError } = require('../errors/HttpError');
const materialRepo = require('../repositories/material.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Serviço de cadastro de materiais (Bloco 9, Etapa A).
 *
 * Cinco operações sobre materiais (migration 007): criar, buscar, listar,
 * alterar (campos do cadastro) e alterarEstado (inativar/reativar). As
 * três primeiras de escrita são transacionais e auditadas; buscar e listar
 * não gravam nada e não abrem transação.
 *
 * ARQUITETURA: mesmo padrão de grupo-acesso.service.js — `pool` por
 * parâmetro (nunca importa src/config/database.js), BEGIN/COMMIT explícito
 * com ROLLBACK em qualquer exceção, e módulos chamados por
 * `modulo.funcao(...)`, nunca desestruturados (permite mock.method nos
 * testes sem afetar produção).
 *
 * AUTORIZAÇÃO NÃO MORA AQUI, por decisão explícita do Bloco 9 (diferente
 * de grupo-acesso.service.js, que consulta autoridade-administrativa.js
 * internamente): materiais são um recurso de negócio comum, não uma
 * configuração de RBAC. Quem decide se o ator pode criar/visualizar/editar
 * é o middleware `criarExigirPermissaoRecurso('materials', operacao)`
 * (src/middleware/autorizacao.js, Bloco 8), montado nas rotas antes deste
 * serviço ser chamado — a mesma cadeia perfil -> grupo -> exceção
 * individual que protege qualquer outro recurso. Repetir a checagem aqui
 * criaria uma segunda fonte de decisão. O que este serviço garante é
 * ISOLAMENTO (empresaId sempre do contexto autenticado, nunca do corpo) e
 * INTEGRIDADE (validação de domínio, transação, auditoria) — nunca
 * autorização.
 *
 * MASTER NÃO TEM NENHUM CAMINHO ESPECIAL AQUI: como a autorização já
 * aconteceu no middleware antes deste módulo ser chamado, não há bypass
 * de perfil nenhum para reproduzir ou evitar neste arquivo — não existe
 * `if (perfil === 'MASTER')` em lugar nenhum deste serviço.
 *
 * SEM EXCLUSÃO FÍSICA: materiais são inativados, nunca apagados — mesma
 * decisão de grupo-acesso.service.js, aqui por instrução explícita do
 * Bloco 9 (preservar histórico de movimentações de estoque e auditoria).
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_CHECK = '23514';

const ACAO_AUDITORIA_CRIACAO = 'MATERIAL_CRIADO';
const ACAO_AUDITORIA_ALTERACAO = 'MATERIAL_ALTERADO';
const ACAO_AUDITORIA_INATIVACAO = 'MATERIAL_INATIVADO';
const ACAO_AUDITORIA_REATIVACAO = 'MATERIAL_REATIVADO';

const MSG_NOME_INVALIDO = 'Nome de material inválido';
const MSG_MATERIAL_NAO_ENCONTRADO = 'Material não encontrado';
const MSG_SEM_ALTERACAO = 'Nenhum campo para alterar';
const MSG_DADOS_INVALIDOS = 'Dados de material inválidos';
// Parte C2 (migration 039): índice único parcial do código interno por empresa.
const INDICE_CODIGO_INTERNO = 'uq_materiais_empresa_codigo_interno';
const MSG_CODIGO_INTERNO_DUPLICADO = 'Já existe um material com este código interno nesta empresa';

/** Traduz a violação do índice do código interno; qualquer outra violação segue o tratamento anterior. */
function traduzirViolacao(erro) {
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === INDICE_CODIGO_INTERNO) {
    return HttpError.conflict('MATERIAL_CODIGO_INTERNO_DUPLICADO', MSG_CODIGO_INTERNO_DUPLICADO);
  }
  return null;
}

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/** Nome: apara espaços das pontas, sem mexer em maiúsculas/acentos. */
function normalizarNome(nome) {
  if (typeof nome !== 'string') {
    return null;
  }
  const aparado = nome.trim();
  if (aparado.length === 0 || aparado.length > materialRepo.TAMANHO_MAXIMO_NOME) {
    return null;
  }
  return aparado;
}

/** Campo de texto opcional (tipo, fabricante, caNumero): aparado; vazio equivale a null. */
function normalizarTextoOpcional(valor, tamanhoMaximo) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new TypeError('campo de texto deve ser string ou null');
  }
  const aparado = valor.trim();
  if (aparado.length > tamanhoMaximo) {
    return undefined; // sinaliza inválido, distinto de null (vazio -> null)
  }
  return aparado.length === 0 ? null : aparado;
}

function normalizarUnidade(unidade) {
  if (unidade === undefined || unidade === null) {
    return 'unidade';
  }
  if (typeof unidade !== 'string') {
    return null;
  }
  const aparada = unidade.trim();
  if (aparada.length === 0 || aparada.length > materialRepo.TAMANHO_MAXIMO_UNIDADE) {
    return null;
  }
  return aparada;
}

function prazoUsoDiasValido(valor) {
  return valor === null || valor === undefined || (Number.isInteger(valor) && valor > 0);
}

function estoqueMinimoValido(valor) {
  return valor === undefined || (Number.isInteger(valor) && valor >= 0);
}

/**
 * Executa `operacao(client)` dentro de BEGIN/COMMIT, com ROLLBACK em
 * qualquer exceção — mesmo padrão de grupo-acesso.service.js.
 */
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

/** Dados do material gravados na auditoria — nunca mais do que isto. */
const instantaneo = (material) => ({
  nome: material.nome,
  tipo: material.tipo,
  fabricante: material.fabricante,
  caNumero: material.caNumero,
  caValidade: material.caValidade,
  prazoUsoDias: material.prazoUsoDias,
  unidade: material.unidade,
  estoqueMinimo: material.estoqueMinimo,
  categoria: material.categoria,
  codigoInterno: material.codigoInterno,
  descricao: material.descricao,
  ativo: material.ativo,
});

/**
 * Cria um material na empresa do ator.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, atorId: number, nome: string, tipo?: string|null, fabricante?: string|null,
 *   caNumero?: string|null, caValidade?: string|null, prazoUsoDias?: number|null, unidade?: string,
 *   estoqueMinimo?: number, ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 */
async function criar(pool, {
  empresaId, atorId, nome, tipo = null, fabricante = null, caNumero = null,
  caValidade = null, prazoUsoDias = null, unidade, estoqueMinimo = 0,
  categoria = null, codigoInterno = null, descricao = null,
  ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  const nomeNormalizado = normalizarNome(nome);
  const categoriaNormalizada = normalizarTextoOpcional(categoria, materialRepo.TAMANHO_MAXIMO_CATEGORIA);
  const codigoInternoNormalizado = normalizarTextoOpcional(codigoInterno, materialRepo.TAMANHO_MAXIMO_CODIGO_INTERNO);
  const descricaoNormalizada = normalizarTextoOpcional(descricao, materialRepo.TAMANHO_MAXIMO_DESCRICAO);
  const tipoNormalizado = normalizarTextoOpcional(tipo, materialRepo.TAMANHO_MAXIMO_TIPO);
  const fabricanteNormalizado = normalizarTextoOpcional(fabricante, materialRepo.TAMANHO_MAXIMO_FABRICANTE);
  const caNumeroNormalizado = normalizarTextoOpcional(caNumero, materialRepo.TAMANHO_MAXIMO_CA_NUMERO);
  const unidadeNormalizada = normalizarUnidade(unidade);

  if (nomeNormalizado === null) {
    throw HttpError.badRequest('MATERIAL_NOME_INVALIDO', MSG_NOME_INVALIDO);
  }
  if (tipoNormalizado === undefined || fabricanteNormalizado === undefined || caNumeroNormalizado === undefined
    || categoriaNormalizada === undefined || codigoInternoNormalizado === undefined || descricaoNormalizada === undefined) {
    throw HttpError.badRequest('MATERIAL_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }
  if (!prazoUsoDiasValido(prazoUsoDias) || unidadeNormalizada === null || !estoqueMinimoValido(estoqueMinimo)) {
    throw HttpError.badRequest('MATERIAL_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }

  return emTransacao(pool, async (client) => {
    let material;
    try {
      material = await materialRepo.criar(client, {
        empresaId,
        nome: nomeNormalizado,
        tipo: tipoNormalizado,
        fabricante: fabricanteNormalizado,
        caNumero: caNumeroNormalizado,
        caValidade,
        prazoUsoDias: prazoUsoDias ?? null,
        unidade: unidadeNormalizada,
        estoqueMinimo,
        categoria: categoriaNormalizada,
        codigoInterno: codigoInternoNormalizado,
        descricao: descricaoNormalizada,
      });
    } catch (erro) {
      const traduzido = traduzirViolacao(erro);
      if (traduzido !== null) {
        throw traduzido;
      }
      if (erro.code === VIOLACAO_CHECK) {
        throw HttpError.badRequest('MATERIAL_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
      }
      throw erro;
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_CRIACAO,
      referencia: String(material.id),
      ip,
      dispositivo,
      contexto: { criadoPor: atorId },
      dadosNovos: instantaneo(material),
    });

    return material;
  });
}

/**
 * Busca um material da empresa informada.
 *
 * Leitura: não abre transação e não audita. Estritamente isolada por
 * empresa: um id de outra empresa simplesmente não é encontrado.
 *
 * @throws {HttpError} 404 quando não existe NESTA empresa
 */
async function buscar(pool, { empresaId, materialId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(materialId, 'identificador de material');

  const material = await materialRepo.buscarPorId(pool, empresaId, materialId);
  if (material === null) {
    throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
  }
  return material;
}

/**
 * Lista os materiais da empresa, paginados.
 *
 * @returns {Promise<{materiais: Array<object>, total: number, pagina: number, limite: number}>}
 */
async function listar(pool, {
  empresaId, ativo = null, busca = null, pagina = 1, limite = 20,
}) {
  exigirId(empresaId, 'identificador de empresa');

  const [materiais, total] = await Promise.all([
    materialRepo.listarPorEmpresa(pool, empresaId, { ativo, busca, pagina, limite }),
    materialRepo.contarPorEmpresa(pool, empresaId, { ativo, busca }),
  ]);

  return { materiais, total, pagina, limite };
}

/**
 * Altera os campos do cadastro de um material. `ativo` NÃO é alterável por
 * aqui: inativar e reativar têm funções próprias.
 *
 * Cada campo ausente em `dados` permanece como está; para os campos
 * opcionais do domínio, `*Informado: true` distingue "não mexer" de
 * "limpar para null" — mesmo contrato do repositório.
 */
async function alterar(pool, {
  empresaId, atorId, materialId,
  nome, tipo, tipoInformado = false,
  fabricante, fabricanteInformado = false,
  caNumero, caNumeroInformado = false,
  caValidade, caValidadeInformado = false,
  prazoUsoDias, prazoUsoDiasInformado = false,
  unidade, estoqueMinimo,
  categoria, categoriaInformado = false,
  codigoInterno, codigoInternoInformado = false,
  descricao, descricaoInformado = false,
  ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(materialId, 'identificador de material');

  const categoriaNormalizada = categoriaInformado ? normalizarTextoOpcional(categoria, materialRepo.TAMANHO_MAXIMO_CATEGORIA) : null;
  const codigoInternoNormalizado = codigoInternoInformado
    ? normalizarTextoOpcional(codigoInterno, materialRepo.TAMANHO_MAXIMO_CODIGO_INTERNO) : null;
  const descricaoNormalizada = descricaoInformado ? normalizarTextoOpcional(descricao, materialRepo.TAMANHO_MAXIMO_DESCRICAO) : null;

  const alterarNome = nome !== undefined;
  const nomeNormalizado = alterarNome ? normalizarNome(nome) : null;
  const tipoNormalizado = tipoInformado ? normalizarTextoOpcional(tipo, materialRepo.TAMANHO_MAXIMO_TIPO) : null;
  const fabricanteNormalizado = fabricanteInformado
    ? normalizarTextoOpcional(fabricante, materialRepo.TAMANHO_MAXIMO_FABRICANTE) : null;
  const caNumeroNormalizado = caNumeroInformado
    ? normalizarTextoOpcional(caNumero, materialRepo.TAMANHO_MAXIMO_CA_NUMERO) : null;
  const unidadeNormalizada = unidade !== undefined ? normalizarUnidade(unidade) : null;

  const nenhumCampo = !alterarNome && !tipoInformado && !fabricanteInformado && !caNumeroInformado
    && !caValidadeInformado && !prazoUsoDiasInformado && unidade === undefined && estoqueMinimo === undefined
    && !categoriaInformado && !codigoInternoInformado && !descricaoInformado;

  return emTransacao(pool, async (client) => {
    if (nenhumCampo) {
      throw HttpError.badRequest('MATERIAL_SEM_ALTERACAO', MSG_SEM_ALTERACAO);
    }
    if (alterarNome && nomeNormalizado === null) {
      throw HttpError.badRequest('MATERIAL_NOME_INVALIDO', MSG_NOME_INVALIDO);
    }
    if ((tipoInformado && tipoNormalizado === undefined)
      || (fabricanteInformado && fabricanteNormalizado === undefined)
      || (caNumeroInformado && caNumeroNormalizado === undefined)
      || (unidade !== undefined && unidadeNormalizada === null)
      || (prazoUsoDiasInformado && !prazoUsoDiasValido(prazoUsoDias))
      || (estoqueMinimo !== undefined && !estoqueMinimoValido(estoqueMinimo))
      || (categoriaInformado && categoriaNormalizada === undefined)
      || (codigoInternoInformado && codigoInternoNormalizado === undefined)
      || (descricaoInformado && descricaoNormalizada === undefined)) {
      throw HttpError.badRequest('MATERIAL_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
    }

    const anterior = await materialRepo.buscarPorIdParaAtualizacao(client, empresaId, materialId);
    if (anterior === null) {
      throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
    }

    let atualizado;
    try {
      atualizado = await materialRepo.atualizar(client, empresaId, materialId, {
        nome: nomeNormalizado,
        tipo: tipoNormalizado, tipoInformado,
        fabricante: fabricanteNormalizado, fabricanteInformado,
        caNumero: caNumeroNormalizado, caNumeroInformado,
        caValidade: caValidadeInformado ? caValidade : null, caValidadeInformado,
        prazoUsoDias: prazoUsoDiasInformado ? prazoUsoDias : null, prazoUsoDiasInformado,
        unidade: unidadeNormalizada,
        estoqueMinimo: estoqueMinimo ?? null,
        categoria: categoriaNormalizada, categoriaInformado,
        codigoInterno: codigoInternoNormalizado, codigoInternoInformado,
        descricao: descricaoNormalizada, descricaoInformado,
      });
    } catch (erro) {
      const traduzido = traduzirViolacao(erro);
      if (traduzido !== null) {
        throw traduzido;
      }
      if (erro.code === VIOLACAO_UNIQUE || erro.code === VIOLACAO_CHECK) {
        throw HttpError.badRequest('MATERIAL_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
      }
      throw erro;
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_ALTERACAO,
      referencia: String(materialId),
      ip,
      dispositivo,
      dadosAnteriores: instantaneo(anterior),
      dadosNovos: instantaneo(atualizado),
    });

    return atualizado;
  });
}

/**
 * Muda o estado `ativo` de um material, auditando com a ação específica.
 * Idempotente: pedir o estado que o material já tem não grava nada e não
 * audita — devolve o material como está, com `alterado: false`.
 */
async function alterarEstado(pool, { empresaId, atorId, materialId, ativo, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(materialId, 'identificador de material');

  return emTransacao(pool, async (client) => {
    const anterior = await materialRepo.buscarPorIdParaAtualizacao(client, empresaId, materialId);
    if (anterior === null) {
      throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
    }

    if (anterior.ativo === ativo) {
      return { material: anterior, alterado: false };
    }

    const atualizado = await materialRepo.atualizar(client, empresaId, materialId, { ativo });

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ativo ? ACAO_AUDITORIA_REATIVACAO : ACAO_AUDITORIA_INATIVACAO,
      referencia: String(materialId),
      ip,
      dispositivo,
      dadosAnteriores: instantaneo(anterior),
      dadosNovos: instantaneo(atualizado),
    });

    return { material: atualizado, alterado: true };
  });
}

async function inativar(pool, { empresaId, atorId, materialId, ip = null, dispositivo = null }) {
  return alterarEstado(pool, { empresaId, atorId, materialId, ativo: false, ip, dispositivo });
}

async function reativar(pool, { empresaId, atorId, materialId, ip = null, dispositivo = null }) {
  return alterarEstado(pool, { empresaId, atorId, materialId, ativo: true, ip, dispositivo });
}

module.exports = {
  criar,
  buscar,
  listar,
  alterar,
  inativar,
  reativar,
};
