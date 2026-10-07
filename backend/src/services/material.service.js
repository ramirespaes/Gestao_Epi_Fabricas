'use strict';

const { HttpError } = require('../errors/HttpError');
const materialRepo = require('../repositories/material.repository');
const loteRepo = require('../repositories/estoque-lote.repository');
const minimoRepo = require('../repositories/estoque-minimo.repository');
const tamanhoRepo = require('../repositories/material-tamanho.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const classificacao = require('../utils/classificacao-material');

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
const MSG_UNIDADE_NAO_EDITAVEL = 'A unidade de controle de um material existente não pode ser alterada';
const MSG_DADOS_INVALIDOS = 'Dados de material inválidos';
const MSG_TAMANHO_SALDO_INCOMPATIVEL = 'Há saldo em estoque incompatível com a nova exigência de tamanho';
const MSG_TAMANHO_MINIMOS_INCOMPATIVEIS = 'Há mínimos por tamanho cadastrados para este material: remova-os antes de mudar a exigência de tamanho';
// 12G-8 (migration 070): grade de tamanhos do material.
const MSG_GRADE_NAO_SE_APLICA = 'Material de tamanho único não tem grade de tamanhos';
const MSG_TAMANHO_GRADE_INCOMPATIVEL = 'Este material tem grade de tamanhos: apague a grade na mesma alteração para deixar de usar tamanho';
const MSG_GRADE_TAMANHO_EM_USO = 'Um tamanho que sai da grade ainda tem saldo em estoque, mínimo próprio ou solicitação em aberto';
const CARACTERE_CONTROLE = /\p{Cc}/u;
// Parte C2 (migration 039): índice único parcial do código interno por empresa.
const INDICE_CODIGO_INTERNO = 'uq_materiais_empresa_codigo_interno';
const MSG_CODIGO_INTERNO_DUPLICADO = 'Já existe um material com este código interno nesta empresa';

// Óculos de proteção: os dois tipos oficiais e o nome histórico, pelo tipo
// gravado, nunca pelo nome do material (classificacao-material.js, CHECKs da 071).
const MSG_OCULOS_OBRIGATORIO = 'Informe se os óculos de proteção são com grau';
const MSG_OCULOS_NAO_SE_APLICA = 'Óculos com grau só se aplica aos tipos de óculos de proteção';
// 12G-8 (migration 071): Categoria → Tipo e "Outros" com descrição própria.
const MSG_TIPO_FORA_DA_CATEGORIA = 'Este tipo não pertence à categoria do material';
const MSG_TIPO_DESCRICAO_OBRIGATORIA = 'Descreva o tipo quando ele é "Outros"';
const MSG_TIPO_DESCRICAO_NAO_SE_APLICA = 'A descrição do tipo só se aplica ao tipo "Outros"';

function recusarOculos(codigo, mensagem) {
  return HttpError.validacao([{ campo: 'body.oculosComGrau', codigo, mensagem }]);
}

function recusarClassificacao(campo, codigo, mensagem) {
  return HttpError.validacao([{ campo, codigo, mensagem }]);
}

/**
 * Tipo e descrição coerentes com a categoria final. A lista só é conferida
 * quando tipo ou categoria vêm na requisição: o legado fora das listas segue
 * editável nos demais campos. Devolve a descrição a gravar: {informado, valor}.
 */
function classificar({ categoriaFinal, tipoFinal, conferirLista, descricao, descricaoInformada, descricaoAnterior }) {
  if (conferirLista && tipoFinal !== null && !classificacao.tipoPermitido(categoriaFinal, tipoFinal)) {
    throw recusarClassificacao('body.tipo', 'TIPO_FORA_DA_CATEGORIA', MSG_TIPO_FORA_DA_CATEGORIA);
  }
  const descricaoFinal = descricaoInformada ? descricao : descricaoAnterior;
  if (tipoFinal === classificacao.OUTROS) {
    if (descricaoFinal === null) throw recusarClassificacao('body.tipoDescricao', 'TIPO_DESCRICAO_OBRIGATORIA', MSG_TIPO_DESCRICAO_OBRIGATORIA);
    return { informado: descricaoInformada, valor: descricaoFinal };
  }
  if (descricaoInformada && descricao !== null) {
    throw recusarClassificacao('body.tipoDescricao', 'TIPO_DESCRICAO_NAO_SE_APLICA', MSG_TIPO_DESCRICAO_NAO_SE_APLICA);
  }
  // Quem deixa de ser "Outros" não guarda descrição escondida.
  return { informado: descricaoAnterior !== null, valor: null };
}

function oculosComGrauValido(valor) {
  return valor === undefined || valor === null || typeof valor === 'boolean';
}

/** No cadastro, óculos de proteção sempre dizem se são com grau; outro tipo não diz nada. */
function oculosNoCadastro(tipo, valor) {
  if (classificacao.ehOculos(tipo)) {
    if (typeof valor !== 'boolean') throw recusarOculos('OCULOS_COM_GRAU_OBRIGATORIO', MSG_OCULOS_OBRIGATORIO);
    return valor;
  }
  if (valor !== undefined && valor !== null) throw recusarOculos('OCULOS_COM_GRAU_NAO_SE_APLICA', MSG_OCULOS_NAO_SE_APLICA);
  return null;
}

/**
 * Na edição, decido pelo tipo que o material terá depois dela. Óculos que
 * continuam óculos mantêm o valor quando nada vem, inclusive o NULL do
 * legado; quem passa a ser óculos precisa ser classificado; e quem deixa de
 * ser óculos perde a informação. Devolve o que gravar: {informado, valor}.
 */
function oculosNaEdicao(anterior, tipoFinal, informado, valor) {
  if (classificacao.ehOculos(tipoFinal)) {
    if (informado) {
      if (typeof valor !== 'boolean') throw recusarOculos('OCULOS_COM_GRAU_OBRIGATORIO', MSG_OCULOS_OBRIGATORIO);
      return { informado: true, valor };
    }
    if (!classificacao.ehOculos(anterior.tipo)) throw recusarOculos('OCULOS_COM_GRAU_OBRIGATORIO', MSG_OCULOS_OBRIGATORIO);
    return { informado: false, valor: null };
  }
  if (informado && valor !== null) throw recusarOculos('OCULOS_COM_GRAU_NAO_SE_APLICA', MSG_OCULOS_NAO_SE_APLICA);
  return { informado: anterior.oculosComGrau !== null && anterior.oculosComGrau !== undefined, valor: null };
}

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

function recusarGrade(campo, codigo, mensagem) {
  return HttpError.validacao([{ campo, codigo, mensagem }]);
}

/**
 * Grade no formato do tamanho do lote (aparado, NFC, 1 a 20, sem controle),
 * na ordem recebida e sem repetir sem diferenciar maiúsculas. A rota já
 * valida; esta é a defesa para qualquer outro chamador.
 */
function normalizarGrade(tamanhos) {
  if (!Array.isArray(tamanhos)) {
    throw new TypeError('grade deve ser uma lista');
  }
  if (tamanhos.length > tamanhoRepo.LIMITE_GRADE) {
    throw recusarGrade('body.tamanhos', 'TAMANHO_MAXIMO', 'Grade com tamanhos demais');
  }
  const vistos = new Set();
  return tamanhos.map((valor, indice) => {
    const texto = typeof valor === 'string' ? valor.trim().normalize('NFC') : '';
    const comprimento = Array.from(texto).length;
    if (comprimento === 0 || comprimento > tamanhoRepo.TAMANHO_MAXIMO || CARACTERE_CONTROLE.test(texto)) {
      throw recusarGrade(`body.tamanhos.${indice}`, 'TAMANHO_INVALIDO', 'Tamanho inválido');
    }
    if (vistos.has(texto.toUpperCase())) {
      throw recusarGrade(`body.tamanhos.${indice}`, 'TAMANHO_REPETIDO', 'Tamanho repetido na grade');
    }
    vistos.add(texto.toUpperCase());
    return texto;
  });
}

/** A grade nova não pode deixar de fora tamanho com saldo, mínimo próprio ou solicitação em aberto. */
async function conferirGradeEmUso(client, empresaId, materialId, grade) {
  if (grade.length === 0) return;
  const emUso = await tamanhoRepo.listarEmUso(client, empresaId, materialId);
  if (emUso.some((tamanho) => !grade.includes(tamanho))) {
    throw HttpError.conflict('MATERIAL_GRADE_TAMANHO_EM_USO', MSG_GRADE_TAMANHO_EM_USO);
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

/** Campo de texto opcional (tipo, fabricante e os da Parte C2): aparado; vazio equivale a null. */
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

// O prazo de uso é obrigatório. Só cadastro legado tem prazo nulo, e a edição
// não deixa apagá-lo.
function prazoUsoDiasValido(valor) {
  return Number.isInteger(valor) && valor > 0;
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

/** Dados do material gravados na auditoria — nunca mais do que isto. Sem CA: ele é do lote. */
const instantaneo = (material) => ({
  nome: material.nome,
  tipo: material.tipo,
  tipoDescricao: material.tipoDescricao ?? null,
  fabricante: material.fabricante,
  prazoUsoDias: material.prazoUsoDias,
  exigeTamanho: material.exigeTamanho,
  oculosComGrau: material.oculosComGrau ?? null,
  unidade: material.unidade,
  estoqueMinimo: material.estoqueMinimo,
  categoria: material.categoria,
  codigoInterno: material.codigoInterno,
  descricao: material.descricao,
  ativo: material.ativo,
  ...(material.tamanhos !== undefined ? { tamanhos: material.tamanhos } : {}),
});

/**
 * Cria um material na empresa do ator.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, atorId: number, nome: string, tipo?: string|null, fabricante?: string|null,
 *   prazoUsoDias: number, exigeTamanho: boolean, oculosComGrau?: boolean|null,
 *   unidade?: string, estoqueMinimo?: number, ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador. O
 *   material não tem CA: o CA e a validade são do lote, na entrada.
 */
async function criar(pool, {
  empresaId, atorId, nome, tipo = null, tipoDescricao = null, fabricante = null,
  prazoUsoDias = null, exigeTamanho = null, oculosComGrau, unidade, estoqueMinimo = 0,
  categoria = null, codigoInterno = null, descricao = null, tamanhos = [],
  ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  const nomeNormalizado = normalizarNome(nome);
  const categoriaNormalizada = normalizarTextoOpcional(categoria, materialRepo.TAMANHO_MAXIMO_CATEGORIA);
  const codigoInternoNormalizado = normalizarTextoOpcional(codigoInterno, materialRepo.TAMANHO_MAXIMO_CODIGO_INTERNO);
  const descricaoNormalizada = normalizarTextoOpcional(descricao, materialRepo.TAMANHO_MAXIMO_DESCRICAO);
  const tipoNormalizado = normalizarTextoOpcional(tipo, materialRepo.TAMANHO_MAXIMO_TIPO);
  const tipoDescricaoNormalizada = normalizarTextoOpcional(tipoDescricao, materialRepo.TAMANHO_MAXIMO_TIPO_DESCRICAO);
  const fabricanteNormalizado = normalizarTextoOpcional(fabricante, materialRepo.TAMANHO_MAXIMO_FABRICANTE);
  const unidadeNormalizada = normalizarUnidade(unidade);

  if (nomeNormalizado === null) {
    throw HttpError.badRequest('MATERIAL_NOME_INVALIDO', MSG_NOME_INVALIDO);
  }
  if (tipoNormalizado === undefined || tipoDescricaoNormalizada === undefined || fabricanteNormalizado === undefined
    || categoriaNormalizada === undefined || codigoInternoNormalizado === undefined || descricaoNormalizada === undefined) {
    throw HttpError.badRequest('MATERIAL_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }
  if (!prazoUsoDiasValido(prazoUsoDias) || typeof exigeTamanho !== 'boolean'
    || unidadeNormalizada === null || !estoqueMinimoValido(estoqueMinimo) || !oculosComGrauValido(oculosComGrau)) {
    throw HttpError.badRequest('MATERIAL_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }
  const descricaoTipo = classificar({
    categoriaFinal: categoriaNormalizada, tipoFinal: tipoNormalizado, conferirLista: true,
    descricao: tipoDescricaoNormalizada, descricaoInformada: true, descricaoAnterior: null,
  });
  const oculosNormalizado = oculosNoCadastro(tipoNormalizado, oculosComGrau);
  const grade = normalizarGrade(tamanhos);
  if (grade.length > 0 && exigeTamanho !== true) {
    throw recusarGrade('body.tamanhos', 'GRADE_NAO_SE_APLICA', MSG_GRADE_NAO_SE_APLICA);
  }

  return emTransacao(pool, async (client) => {
    let material;
    try {
      material = await materialRepo.criar(client, {
        empresaId,
        nome: nomeNormalizado,
        tipo: tipoNormalizado,
        tipoDescricao: descricaoTipo.valor,
        fabricante: fabricanteNormalizado,
        prazoUsoDias: prazoUsoDias ?? null,
        exigeTamanho,
        oculosComGrau: oculosNormalizado,
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
    if (grade.length > 0) {
      await tamanhoRepo.substituir(client, empresaId, material.id, grade);
    }
    material.tamanhos = grade;

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
  return { ...material, tamanhos: await tamanhoRepo.listarPorMaterial(pool, empresaId, materialId) };
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
  tipoDescricao, tipoDescricaoInformado = false,
  fabricante, fabricanteInformado = false,
  prazoUsoDias, prazoUsoDiasInformado = false,
  exigeTamanho,
  oculosComGrau, oculosComGrauInformado = false,
  unidade, estoqueMinimo,
  categoria, categoriaInformado = false,
  codigoInterno, codigoInternoInformado = false,
  descricao, descricaoInformado = false,
  tamanhos, tamanhosInformado = false,
  ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(materialId, 'identificador de material');

  const grade = tamanhosInformado ? normalizarGrade(tamanhos) : null;
  const tipoDescricaoNormalizada = tipoDescricaoInformado ? normalizarTextoOpcional(tipoDescricao, materialRepo.TAMANHO_MAXIMO_TIPO_DESCRICAO) : null;
  const categoriaNormalizada = categoriaInformado ? normalizarTextoOpcional(categoria, materialRepo.TAMANHO_MAXIMO_CATEGORIA) : null;
  const codigoInternoNormalizado = codigoInternoInformado
    ? normalizarTextoOpcional(codigoInterno, materialRepo.TAMANHO_MAXIMO_CODIGO_INTERNO) : null;
  const descricaoNormalizada = descricaoInformado ? normalizarTextoOpcional(descricao, materialRepo.TAMANHO_MAXIMO_DESCRICAO) : null;

  const alterarNome = nome !== undefined;
  const nomeNormalizado = alterarNome ? normalizarNome(nome) : null;
  const tipoNormalizado = tipoInformado ? normalizarTextoOpcional(tipo, materialRepo.TAMANHO_MAXIMO_TIPO) : null;
  const fabricanteNormalizado = fabricanteInformado
    ? normalizarTextoOpcional(fabricante, materialRepo.TAMANHO_MAXIMO_FABRICANTE) : null;

  // Unidade de controle imutável na edição (ajuste pós-melhoria C2,
  // 25/09/2026). A rota já a recusa no schema; esta é a defesa em
  // profundidade para qualquer outro chamador. Recusa antes de abrir
  // transação: nada é lido, gravado ou auditado.
  if (unidade !== undefined) {
    throw HttpError.badRequest('MATERIAL_UNIDADE_NAO_EDITAVEL', MSG_UNIDADE_NAO_EDITAVEL);
  }

  const nenhumCampo = !alterarNome && !tipoInformado && !tipoDescricaoInformado && !fabricanteInformado
    && !prazoUsoDiasInformado && exigeTamanho === undefined && estoqueMinimo === undefined
    && !categoriaInformado && !codigoInternoInformado && !descricaoInformado && !oculosComGrauInformado && !tamanhosInformado;

  return emTransacao(pool, async (client) => {
    if (nenhumCampo) {
      throw HttpError.badRequest('MATERIAL_SEM_ALTERACAO', MSG_SEM_ALTERACAO);
    }
    if (alterarNome && nomeNormalizado === null) {
      throw HttpError.badRequest('MATERIAL_NOME_INVALIDO', MSG_NOME_INVALIDO);
    }
    if ((tipoInformado && tipoNormalizado === undefined)
      || (tipoDescricaoInformado && tipoDescricaoNormalizada === undefined)
      || (fabricanteInformado && fabricanteNormalizado === undefined)
      || (prazoUsoDiasInformado && !prazoUsoDiasValido(prazoUsoDias))
      || (exigeTamanho !== undefined && typeof exigeTamanho !== 'boolean')
      || (estoqueMinimo !== undefined && !estoqueMinimoValido(estoqueMinimo))
      || (categoriaInformado && categoriaNormalizada === undefined)
      || (codigoInternoInformado && codigoInternoNormalizado === undefined)
      || (descricaoInformado && descricaoNormalizada === undefined)
      || (oculosComGrauInformado && !oculosComGrauValido(oculosComGrau))) {
      throw HttpError.badRequest('MATERIAL_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
    }

    const anterior = await materialRepo.buscarPorIdParaAtualizacao(client, empresaId, materialId);
    if (anterior === null) {
      throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', MSG_MATERIAL_NAO_ENCONTRADO);
    }
    // A primeira classificação do legado é livre. Depois, só troco se nenhum
    // lote com saldo ficar incompatível; saldo zero é histórico e não impede.
    // A trava do material acima segura entradas novas até o fim desta troca.
    const trocaClassificacao = exigeTamanho !== undefined && anterior.exigeTamanho !== null && anterior.exigeTamanho !== exigeTamanho;
    if (trocaClassificacao && await loteRepo.possuiSaldoIncompativel(client, empresaId, materialId, exigeTamanho)) {
      throw HttpError.conflict('MATERIAL_TAMANHO_SALDO_INCOMPATIVEL', MSG_TAMANHO_SALDO_INCOMPATIVEL);
    }
    // Sair de "exige tamanho" não pode deixar mínimo por tamanho para trás, e eu nunca apago configuração
    // sozinho. A gravação do mínimo lê este material FOR SHARE (gatilho da 067): a que chegou antes
    // termina primeiro, e a que chega depois da troca é recusada pelo próprio banco.
    if (trocaClassificacao && anterior.exigeTamanho === true && await minimoRepo.possuiOverrides(client, empresaId, materialId)) {
      throw HttpError.conflict('MATERIAL_TAMANHO_MINIMOS_INCOMPATIVEIS', MSG_TAMANHO_MINIMOS_INCOMPATIVEIS);
    }
    // Grade (12G-8): lida com o material já travado, a mesma trava que segura entradas e solicitações novas.
    const gradeAnterior = await tamanhoRepo.listarPorMaterial(client, empresaId, materialId);
    const exigeFinal = exigeTamanho !== undefined ? exigeTamanho : anterior.exigeTamanho;
    if (grade !== null && grade.length > 0 && exigeFinal !== true) {
      throw recusarGrade('body.tamanhos', 'GRADE_NAO_SE_APLICA', MSG_GRADE_NAO_SE_APLICA);
    }
    if (exigeFinal !== true && (grade !== null ? grade : gradeAnterior).length > 0) {
      throw HttpError.conflict('MATERIAL_TAMANHO_GRADE_INCOMPATIVEL', MSG_TAMANHO_GRADE_INCOMPATIVEL);
    }
    if (grade !== null) {
      await conferirGradeEmUso(client, empresaId, materialId, grade);
    }
    // Categoria → Tipo (12G-8): a lista vale para o estado final; o legado intocado não é reconferido.
    const tipoFinal = tipoInformado ? tipoNormalizado : anterior.tipo;
    const descricaoTipo = classificar({
      categoriaFinal: categoriaInformado ? categoriaNormalizada : anterior.categoria,
      tipoFinal,
      conferirLista: tipoInformado || categoriaInformado,
      descricao: tipoDescricaoNormalizada,
      descricaoInformada: tipoDescricaoInformado,
      descricaoAnterior: anterior.tipoDescricao ?? null,
    });
    const oculos = oculosNaEdicao(anterior, tipoFinal, oculosComGrauInformado, oculosComGrau);

    let atualizado;
    try {
      atualizado = await materialRepo.atualizar(client, empresaId, materialId, {
        nome: nomeNormalizado,
        tipo: tipoNormalizado, tipoInformado,
        tipoDescricao: descricaoTipo.valor, tipoDescricaoInformado: descricaoTipo.informado,
        fabricante: fabricanteNormalizado, fabricanteInformado,
        prazoUsoDias: prazoUsoDiasInformado ? prazoUsoDias : null, prazoUsoDiasInformado,
        unidade: null, // null = manter a unidade atual (nunca alterada pela edição)
        estoqueMinimo: estoqueMinimo ?? null,
        categoria: categoriaNormalizada, categoriaInformado,
        codigoInterno: codigoInternoNormalizado, codigoInternoInformado,
        descricao: descricaoNormalizada, descricaoInformado,
        exigeTamanho: exigeTamanho ?? null, // null = manter a classificação atual
        oculosComGrau: oculos.valor, oculosComGrauInformado: oculos.informado,
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
    // Depois do UPDATE: o gatilho da 070 já vê a classificação nova do material.
    if (grade !== null) {
      await tamanhoRepo.substituir(client, empresaId, materialId, grade);
    }
    atualizado.tamanhos = grade !== null ? grade : gradeAnterior;

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_ALTERACAO,
      referencia: String(materialId),
      ip,
      dispositivo,
      dadosAnteriores: instantaneo({ ...anterior, tamanhos: gradeAnterior }),
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
