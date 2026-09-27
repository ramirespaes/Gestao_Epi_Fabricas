'use strict';

const { escaparCoringasLike } = require('../utils/like');

/**
 * Repositório de materiais (materiais, migration 007): catálogo de EPIs de
 * uma empresa — cadastro, consulta pontual (inclusive travada, para uso
 * transacional), listagem paginada e atualização dos campos do cadastro.
 *
 * Bloco 9, Etapa A. Mesmo padrão dos demais repositórios do Bloco 8
 * (grupo-acesso.repository.js, em especial): executor por parâmetro (nunca
 * o pool global), validação de formato via exigir*, nenhuma regra de
 * negócio e nenhuma decisão de autorização — isso é inteiramente das rotas
 * (middleware de permissão por recurso, Bloco 8) e do serviço que usa este
 * módulo.
 *
 * SEM EXCLUSÃO FÍSICA: não existe função de DELETE aqui, por instrução
 * explícita do Bloco 9 — materiais são inativados (`ativo = false`), nunca
 * apagados, preservando o histórico de movimentações de estoque e de
 * auditoria que os referenciam.
 *
 * empresaId é sempre o filtro de isolamento e nunca é opcional: nenhuma
 * função aqui alcança um material de outra empresa, nem mesmo por id.
 */

// materiais.nome VARCHAR(150), tipo/fabricante VARCHAR(100), unidade
// VARCHAR(20) — mesmos tetos da migration 007.
const TAMANHO_MAXIMO_NOME = 150;
const TAMANHO_MAXIMO_TIPO = 100;
const TAMANHO_MAXIMO_FABRICANTE = 100;
const TAMANHO_MAXIMO_UNIDADE = 20;

// prazo_uso_dias e estoque_minimo são INTEGER (int4) no banco (migration
// 007): defesa em profundidade — o schema Zod já recusa acima deste teto,
// mas o repositório não confia nele sozinho, mesmo padrão de exigirNome
// etc. (correção pós-auditoria de 23/09/2026).
const LIMITE_INTEGER_POSTGRES = 2147483647;

// categoria, codigo_interno e descricao: migration 039 (Parte C2).
// O material não tem CA (E10): ca_numero e ca_validade ficam no banco só
// como histórico, fora da projeção, do INSERT e do UPDATE. O CA é do lote.
const PROJECAO = `id, empresa_id, nome, tipo, fabricante,
  prazo_uso_dias, unidade, estoque_minimo, categoria, codigo_interno, descricao, exige_tamanho, oculos_com_grau, ativo, criado_em, atualizado_em`;
const TAMANHO_MAXIMO_CATEGORIA = 30;
const TAMANHO_MAXIMO_CODIGO_INTERNO = 30;
const TAMANHO_MAXIMO_DESCRICAO = 500;

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirNome(nome) {
  if (typeof nome !== 'string' || nome.length === 0 || nome.length > TAMANHO_MAXIMO_NOME) {
    throw new TypeError('nome de material inválido');
  }
}

function exigirTextoOpcional(valor, nome, tamanhoMaximo) {
  if (valor !== null && (typeof valor !== 'string' || valor.length === 0 || valor.length > tamanhoMaximo)) {
    throw new TypeError(`${nome} deve ser string não vazia dentro do limite, ou null`);
  }
}

// escaparCoringasLike (correção pós-auditoria da Etapa A) vive em
// utils/like.js desde a Etapa B — mesma regra para materiais, GHE e
// funcionários. O termo continua indo sempre como parâmetro ($3).

// prazo_uso_dias: CHECK (prazo_uso_dias IS NULL OR prazo_uso_dias > 0), e teto do INTEGER do banco.
function exigirPrazoUsoDiasOpcional(valor) {
  if (valor !== null && (!Number.isInteger(valor) || valor <= 0 || valor > LIMITE_INTEGER_POSTGRES)) {
    throw new TypeError('prazo de uso em dias deve ser inteiro positivo dentro do teto do INTEGER, ou null');
  }
}

// exige_tamanho: NULL só existe no material legado, ainda não classificado.
function exigirExigeTamanhoOpcional(valor) {
  if (valor !== null && typeof valor !== 'boolean') {
    throw new TypeError('exigência de tamanho deve ser booleana ou null');
  }
}

// oculos_com_grau: só óculos de proteção guardam valor; a regra é do serviço e do CHECK da 045.
function exigirOculosComGrauOpcional(valor) {
  if (valor !== null && typeof valor !== 'boolean') {
    throw new TypeError('óculos com grau deve ser booleano ou null');
  }
}

// estoque_minimo: CHECK (estoque_minimo >= 0), e teto do INTEGER do banco.
function exigirEstoqueMinimo(valor) {
  if (!Number.isInteger(valor) || valor < 0 || valor > LIMITE_INTEGER_POSTGRES) {
    throw new TypeError('estoque mínimo deve ser inteiro não negativo dentro do teto do INTEGER');
  }
}

function exigirUnidade(valor) {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > TAMANHO_MAXIMO_UNIDADE) {
    throw new TypeError('unidade inválida');
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  nome: linha.nome,
  tipo: linha.tipo,
  fabricante: linha.fabricante,
  prazoUsoDias: linha.prazo_uso_dias,
  unidade: linha.unidade,
  estoqueMinimo: linha.estoque_minimo,
  categoria: linha.categoria ?? null,
  codigoInterno: linha.codigo_interno ?? null,
  descricao: linha.descricao ?? null,
  exigeTamanho: linha.exige_tamanho ?? null,
  oculosComGrau: linha.oculos_com_grau ?? null,
  ativo: linha.ativo,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

/**
 * Cria um material. `ativo` nasce true pelo DEFAULT da migration 007 e não
 * é parâmetro: criar já inativo não é uma operação prevista.
 *
 * @param {{query: Function}} executor
 * @param {{empresaId: number, nome: string, tipo?: string|null, fabricante?: string|null,
 *   prazoUsoDias?: number|null, unidade?: string, estoqueMinimo?: number,
 *   exigeTamanho?: boolean|null, oculosComGrau?: boolean|null}} dados
 */
async function criar(executor, {
  empresaId, nome, tipo = null, fabricante = null,
  prazoUsoDias = null, unidade = 'unidade', estoqueMinimo = 0,
  categoria = null, codigoInterno = null, descricao = null, exigeTamanho = null, oculosComGrau = null,
}) {
  exigirEmpresa(empresaId);
  exigirNome(nome);
  exigirTextoOpcional(tipo, 'tipo', TAMANHO_MAXIMO_TIPO);
  exigirTextoOpcional(fabricante, 'fabricante', TAMANHO_MAXIMO_FABRICANTE);
  exigirPrazoUsoDiasOpcional(prazoUsoDias);
  exigirUnidade(unidade);
  exigirEstoqueMinimo(estoqueMinimo);
  exigirTextoOpcional(categoria, 'categoria', TAMANHO_MAXIMO_CATEGORIA);
  exigirTextoOpcional(codigoInterno, 'código interno', TAMANHO_MAXIMO_CODIGO_INTERNO);
  exigirTextoOpcional(descricao, 'descrição', TAMANHO_MAXIMO_DESCRICAO);
  exigirExigeTamanhoOpcional(exigeTamanho);
  exigirOculosComGrauOpcional(oculosComGrau);

  const { rows } = await executor.query(
    `INSERT INTO materiais (empresa_id, nome, tipo, fabricante, prazo_uso_dias, unidade, estoque_minimo, categoria, codigo_interno, descricao, exige_tamanho, oculos_com_grau)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${PROJECAO}`,
    [empresaId, nome, tipo, fabricante, prazoUsoDias, unidade, estoqueMinimo, categoria, codigoInterno, descricao, exigeTamanho, oculosComGrau],
  );

  return mapear(rows[0]);
}

/** Busca um material pelo id, restrito à empresa informada. */
async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de material');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM materiais WHERE empresa_id = $1 AND id = $2`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Igual a buscarPorId, mas com FOR UPDATE: dentro de uma transação, impede
 * que outra transação concorrente altere o cadastro do mesmo material
 * enquanto esta decide o que gravar.
 */
async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de material');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM materiais WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Igual a buscarPorId, com FOR SHARE (dentro de transação) — para quem vai
 * VINCULAR este material (matriz GHE × EPI, Parte C5) e precisa que o
 * `ativo` lido continue verdadeiro até o COMMIT. Mesmo raciocínio de
 * grupo-homogeneo-exposicao.repository.buscarPorIdParaVinculo: vínculos
 * concorrentes coexistem (share com share); a inativação concorrente
 * (buscarPorIdParaAtualizacao, FOR UPDATE) espera. A FK composta só toma
 * FOR KEY SHARE e nunca garantiu `ativo`.
 */
async function buscarPorIdParaVinculo(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de material');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM materiais WHERE empresa_id = $1 AND id = $2 FOR SHARE`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Lista os materiais de uma empresa, paginados e ordenados por nome
 * (comparação sem diferenciar maiúsculas).
 *
 * @param {{ativo?: boolean|null, busca?: string|null, pagina?: number, limite?: number}} filtro
 *   `ativo` null/ausente lista ativos E inativos; `busca` filtra por nome
 *   (contém, sem diferenciar maiúsculas); ausente/null desliga o filtro.
 */
async function listarPorEmpresa(executor, empresaId, {
  ativo = null, busca = null, pagina = 1, limite = 20,
} = {}) {
  exigirEmpresa(empresaId);
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('filtro ativo deve ser booleano ou null');
  }
  if (busca !== null && typeof busca !== 'string') {
    throw new TypeError('filtro de busca deve ser string ou null');
  }
  if (!Number.isInteger(pagina) || pagina < 1) {
    throw new TypeError('página inválida');
  }
  if (!Number.isInteger(limite) || limite < 1) {
    throw new TypeError('limite inválido');
  }

  const deslocamento = (pagina - 1) * limite;
  const buscaEscapada = busca === null ? null : escaparCoringasLike(busca);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO}
       FROM materiais
      WHERE empresa_id = $1
        AND ($2::boolean IS NULL OR ativo = $2::boolean)
        AND ($3::text IS NULL OR nome ILIKE '%' || $3::text || '%')
      ORDER BY lower(nome), id
      LIMIT $4 OFFSET $5`,
    [empresaId, ativo, buscaEscapada, limite, deslocamento],
  );

  return rows.map((linha) => mapear(linha));
}

/**
 * Conta os materiais de uma empresa sob o mesmo filtro de listarPorEmpresa,
 * para paginação (total de páginas no lado de quem chama).
 */
async function contarPorEmpresa(executor, empresaId, { ativo = null, busca = null } = {}) {
  exigirEmpresa(empresaId);
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('filtro ativo deve ser booleano ou null');
  }
  if (busca !== null && typeof busca !== 'string') {
    throw new TypeError('filtro de busca deve ser string ou null');
  }

  const buscaEscapada = busca === null ? null : escaparCoringasLike(busca);

  const { rows } = await executor.query(
    `SELECT count(*)::int AS total
       FROM materiais
      WHERE empresa_id = $1
        AND ($2::boolean IS NULL OR ativo = $2::boolean)
        AND ($3::text IS NULL OR nome ILIKE '%' || $3::text || '%')`,
    [empresaId, ativo, buscaEscapada],
  );

  return rows[0].total;
}

/**
 * Atualiza os campos do cadastro de um material da empresa informada.
 * `ativo` NÃO é alterável por aqui: inativar e reativar têm funções
 * próprias no serviço, para que a auditoria distinga a operação — mesma
 * decisão já tomada em grupo-acesso.repository.js.
 *
 * Cada campo ausente em `campos` permanece como está. Para os campos
 * opcionais do domínio (tipo, fabricante, prazoUsoDias, oculosComGrau e
 * os da Parte C2), a flag `*Informado` distingue "não mexer"
 * de "limpar para null" — mesmo mecanismo de `descricaoInformada` em
 * grupo-acesso.repository.js, repetido por campo.
 *
 * @returns {Promise<object|null>} material já atualizado, ou null se não existia nesta empresa
 */
async function atualizar(executor, empresaId, id, {
  nome = null,
  tipo = null, tipoInformado = false,
  fabricante = null, fabricanteInformado = false,
  prazoUsoDias = null, prazoUsoDiasInformado = false,
  unidade = null,
  estoqueMinimo = null,
  ativo = null,
  categoria = null, categoriaInformado = false,
  codigoInterno = null, codigoInternoInformado = false,
  descricao = null, descricaoInformado = false,
  exigeTamanho = null,
  oculosComGrau = null, oculosComGrauInformado = false,
} = {}) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de material');
  exigirExigeTamanhoOpcional(exigeTamanho);
  if (oculosComGrauInformado) {
    exigirOculosComGrauOpcional(oculosComGrau);
  }
  if (nome !== null) {
    exigirNome(nome);
  }
  if (tipoInformado) {
    exigirTextoOpcional(tipo, 'tipo', TAMANHO_MAXIMO_TIPO);
  }
  if (fabricanteInformado) {
    exigirTextoOpcional(fabricante, 'fabricante', TAMANHO_MAXIMO_FABRICANTE);
  }
  if (prazoUsoDiasInformado) {
    exigirPrazoUsoDiasOpcional(prazoUsoDias);
  }
  if (unidade !== null) {
    exigirUnidade(unidade);
  }
  if (estoqueMinimo !== null) {
    exigirEstoqueMinimo(estoqueMinimo);
  }
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('ativo deve ser booleano ou null');
  }
  if (categoriaInformado) {
    exigirTextoOpcional(categoria, 'categoria', TAMANHO_MAXIMO_CATEGORIA);
  }
  if (codigoInternoInformado) {
    exigirTextoOpcional(codigoInterno, 'código interno', TAMANHO_MAXIMO_CODIGO_INTERNO);
  }
  if (descricaoInformado) {
    exigirTextoOpcional(descricao, 'descrição', TAMANHO_MAXIMO_DESCRICAO);
  }

  const { rows } = await executor.query(
    `UPDATE materiais
        SET nome = COALESCE($3, nome),
            tipo = CASE WHEN $4::boolean THEN $5 ELSE tipo END,
            fabricante = CASE WHEN $6::boolean THEN $7 ELSE fabricante END,
            prazo_uso_dias = CASE WHEN $8::boolean THEN $9 ELSE prazo_uso_dias END,
            unidade = COALESCE($10, unidade),
            estoque_minimo = COALESCE($11, estoque_minimo),
            ativo = COALESCE($12, ativo),
            categoria = CASE WHEN $13::boolean THEN $14 ELSE categoria END,
            codigo_interno = CASE WHEN $15::boolean THEN $16 ELSE codigo_interno END,
            descricao = CASE WHEN $17::boolean THEN $18 ELSE descricao END,
            exige_tamanho = COALESCE($19::boolean, exige_tamanho),
            oculos_com_grau = CASE WHEN $20::boolean THEN $21::boolean ELSE oculos_com_grau END
      WHERE empresa_id = $1 AND id = $2
      RETURNING ${PROJECAO}`,
    [
      empresaId, id, nome,
      tipoInformado, tipo,
      fabricanteInformado, fabricante,
      prazoUsoDiasInformado, prazoUsoDias,
      unidade, estoqueMinimo, ativo,
      categoriaInformado, categoria,
      codigoInternoInformado, codigoInterno,
      descricaoInformado, descricao,
      exigeTamanho,
      oculosComGrauInformado, oculosComGrau,
    ],
  );

  return mapear(rows[0]);
}

module.exports = {
  criar,
  buscarPorId,
  buscarPorIdParaAtualizacao,
  buscarPorIdParaVinculo,
  listarPorEmpresa,
  contarPorEmpresa,
  atualizar,
  TAMANHO_MAXIMO_NOME,
  TAMANHO_MAXIMO_TIPO,
  TAMANHO_MAXIMO_FABRICANTE,
  TAMANHO_MAXIMO_UNIDADE,
  TAMANHO_MAXIMO_CATEGORIA,
  TAMANHO_MAXIMO_CODIGO_INTERNO,
  TAMANHO_MAXIMO_DESCRICAO,
};
