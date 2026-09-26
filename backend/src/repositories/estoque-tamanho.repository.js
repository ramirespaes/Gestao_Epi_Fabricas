'use strict';

/**
 * Repositório de saldos de estoque por tamanho (estoque_tamanhos, migration
 * 008). Bloco 9, Etapa A.
 *
 * estoque_tamanhos NÃO tem coluna empresa_id própria (decisão já registrada
 * no comentário da migration 008): o isolamento por empresa vem sempre de
 * material_id -> materiais.empresa_id, por isso toda função aqui recebe
 * empresaId e faz JOIN com materiais para filtrar — nunca lê ou trava uma
 * linha de estoque sem confirmar, na mesma consulta, que o material dono
 * pertence à empresa informada. `FOR UPDATE OF et` trava só a linha de
 * estoque_tamanhos, nunca a de materiais (que quem chama já pode ter
 * travado separadamente, em material.repository.js).
 *
 * Não decide nada: não calcula saldo resultante, não valida quantidade
 * negativa (isso é do serviço, antes de chamar `atualizarQuantidade`) e
 * propaga qualquer violação de constraint do PostgreSQL sem traduzir —
 * notadamente `chk_estoque_tamanhos_quantidade` (quantidade >= 0) e
 * `uq_estoque_tamanhos_material_tamanho`.
 *
 * ISOLAMENTO REFORÇADO TAMBÉM NA ESCRITA (correção pós-auditoria de
 * 23/09/2026): `criar` e `atualizarQuantidade` também recebem `empresaId`
 * e o aplicam na própria instrução SQL (`INSERT ... SELECT ... FROM
 * materiais WHERE ... AND empresa_id = $1` / `UPDATE ... FROM materiais
 * WHERE ... AND empresa_id = $1`), não só a leitura travada anterior
 * (`buscarPorMaterialTamanhoParaAtualizacao`). Isso é defesa em
 * profundidade: mesmo que um chamador futuro esqueça de reconfirmar o
 * dono do material antes de escrever, a escrita em si não alcança um
 * material de outra empresa. Nenhuma garantia transacional muda — as duas
 * funções continuam recebendo o mesmo `executor` (cliente já em
 * transação) de antes, e o `FOR UPDATE OF et` da leitura anterior
 * continua sendo o que serializa movimentações concorrentes.
 */

// estoque_tamanhos.tamanho VARCHAR(20) — mesmo teto da migration 008.
const TAMANHO_MAXIMO_TAMANHO = 20;

// estoque_tamanhos.quantidade é INTEGER (int4): defesa em profundidade,
// mesmo padrão de material.repository.js (correção pós-auditoria de
// 23/09/2026).
const LIMITE_INTEGER_POSTGRES = 2147483647;

const PROJECAO = 'id, material_id, tamanho, quantidade, criado_em, atualizado_em';

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

function exigirTamanho(tamanho) {
  if (typeof tamanho !== 'string' || tamanho.length === 0 || tamanho.length > TAMANHO_MAXIMO_TAMANHO) {
    throw new TypeError('tamanho inválido');
  }
}

function exigirQuantidade(quantidade) {
  if (!Number.isInteger(quantidade) || quantidade < 0 || quantidade > LIMITE_INTEGER_POSTGRES) {
    throw new TypeError('quantidade deve ser inteiro não negativo dentro do teto do INTEGER');
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  materialId: linha.material_id,
  tamanho: linha.tamanho,
  quantidade: linha.quantidade,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

/**
 * Lista os saldos de um material, restrito à empresa informada via JOIN.
 * Se o material não existir nesta empresa, devolve lista vazia — quem
 * chama já deve ter confirmado a existência do material antes (é o
 * serviço quem decide se isso vira 404).
 */
async function listarPorMaterial(executor, empresaId, materialId) {
  exigirEmpresa(empresaId);
  exigirId(materialId, 'identificador de material');

  const { rows } = await executor.query(
    `SELECT et.id, et.material_id, et.tamanho, et.quantidade, et.criado_em, et.atualizado_em
       FROM estoque_tamanhos et
       JOIN materiais m ON m.id = et.material_id
      WHERE m.empresa_id = $1 AND et.material_id = $2
      ORDER BY et.tamanho`,
    [empresaId, materialId],
  );

  return rows.map((linha) => mapear(linha));
}

/**
 * Busca o saldo de um material+tamanho específico, travado para
 * atualização (dentro de uma transação). `FOR UPDATE OF et` trava somente
 * a linha de estoque_tamanhos.
 */
async function buscarPorMaterialTamanhoParaAtualizacao(executor, empresaId, materialId, tamanho) {
  exigirEmpresa(empresaId);
  exigirId(materialId, 'identificador de material');
  exigirTamanho(tamanho);

  const { rows } = await executor.query(
    `SELECT et.id, et.material_id, et.tamanho, et.quantidade, et.criado_em, et.atualizado_em
       FROM estoque_tamanhos et
       JOIN materiais m ON m.id = et.material_id
      WHERE m.empresa_id = $1 AND et.material_id = $2 AND et.tamanho = $3
      FOR UPDATE OF et`,
    [empresaId, materialId, tamanho],
  );

  return mapear(rows[0]);
}

/**
 * Cria a linha de saldo para um material+tamanho ainda não cadastrado,
 * com a quantidade inicial informada. `uq_estoque_tamanhos_material_tamanho`
 * (migration 008) impede duplicidade — quem chama deve ter confirmado com
 * buscarPorMaterialTamanhoParaAtualizacao, na mesma transação, que a linha
 * ainda não existe.
 *
 * `empresaId` é aplicado na própria instrução (`INSERT ... SELECT ... FROM
 * materiais WHERE id = $2 AND empresa_id = $1`): se o material não
 * pertencer a esta empresa, nada é inserido e a função devolve `null` —
 * mesmo contrato de "não encontrado" das demais consultas deste módulo,
 * agora também na escrita.
 *
 * @returns {Promise<object|null>} o saldo criado, ou null se o material não pertence a esta empresa
 */
async function criar(executor, { empresaId, materialId, tamanho, quantidade }) {
  exigirEmpresa(empresaId);
  exigirId(materialId, 'identificador de material');
  exigirTamanho(tamanho);
  exigirQuantidade(quantidade);

  const { rows } = await executor.query(
    `INSERT INTO estoque_tamanhos (material_id, tamanho, quantidade)
     SELECT m.id, $3, $4
       FROM materiais m
      WHERE m.id = $2 AND m.empresa_id = $1
     RETURNING ${PROJECAO}`,
    [empresaId, materialId, tamanho, quantidade],
  );

  return mapear(rows[0]);
}

/**
 * Grava a nova quantidade de uma linha de saldo já existente, pelo seu id
 * (obtido de uma leitura travada anterior, na mesma transação). O CHECK
 * `chk_estoque_tamanhos_quantidade` (>= 0) é a última barreira do banco;
 * o serviço deve recusar antes uma quantidade negativa, com erro de
 * domínio claro.
 *
 * `empresaId` é aplicado na própria instrução (`UPDATE ... FROM materiais
 * WHERE ... AND empresa_id = $1`): se o saldo não pertencer, através do
 * material, a esta empresa, nada é atualizado e a função devolve `null`.
 *
 * @returns {Promise<object|null>} o saldo atualizado, ou null se não pertence a esta empresa
 */
async function atualizarQuantidade(executor, empresaId, id, quantidade) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de saldo de estoque');
  exigirQuantidade(quantidade);

  const { rows } = await executor.query(
    `UPDATE estoque_tamanhos et
        SET quantidade = $3
       FROM materiais m
      WHERE et.id = $2 AND et.material_id = m.id AND m.empresa_id = $1
      RETURNING et.id, et.material_id, et.tamanho, et.quantidade, et.criado_em, et.atualizado_em`,
    [empresaId, id, quantidade],
  );

  return mapear(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════
// Parte C3 — consulta agregada de itens disponíveis (somente leitura)
// ═══════════════════════════════════════════════════════════════════

const VALIDADES_CA = Object.freeze(['ok', 'expiring', 'expired']);

function exigirTextoFiltro(valor, nome) {
  if (valor !== null && valor !== undefined && typeof valor !== 'string') {
    throw new TypeError(`filtro ${nome} deve ser texto ou null`);
  }
}

function exigirFiltrosDisponiveis({ categoria = null, tipo = null, tamanho = null, validade = null, diasAlerta }) {
  exigirTextoFiltro(categoria, 'categoria');
  exigirTextoFiltro(tipo, 'tipo');
  exigirTextoFiltro(tamanho, 'tamanho');
  if (validade !== null && !VALIDADES_CA.includes(validade)) {
    throw new TypeError('filtro de validade inválido');
  }
  if (!Number.isInteger(diasAlerta) || diasAlerta < 1) {
    throw new TypeError('prazo de alerta da validade do CA inválido');
  }
}

/**
 * Situação da validade do CA, calculada no banco (a paginação depende do
 * filtro): sem data -> 'sem-validade'; antes de hoje -> 'expired'; de hoje
 * até hoje + diasAlerta -> 'expiring'; depois -> 'ok'. `$6` é o prazo de
 * alerta, sempre parâmetro.
 */
const CLASSIFICACAO_VALIDADE_CA = `CASE
          WHEN m.ca_validade IS NULL THEN 'sem-validade'
          WHEN m.ca_validade < CURRENT_DATE THEN 'expired'
          WHEN m.ca_validade <= CURRENT_DATE + $6::int THEN 'expiring'
          ELSE 'ok'
        END`;

// Mesma cláusula para listar e contar: isolamento por JOIN com materiais,
// só materiais ativos, só tamanhos efetivamente cadastrados (inclusive saldo 0).
const FILTRO_DISPONIVEIS = `FROM estoque_tamanhos et
       JOIN materiais m ON m.id = et.material_id
      WHERE m.empresa_id = $1
        AND m.ativo
        AND ($2::text IS NULL OR m.categoria = $2::text)
        AND ($3::text IS NULL OR m.tipo = $3::text)
        AND ($4::text IS NULL OR et.tamanho = $4::text)
        AND ($5::text IS NULL OR ${CLASSIFICACAO_VALIDADE_CA} = $5::text)`;

const paramsFiltro = (empresaId, f) => [empresaId, f.categoria ?? null, f.tipo ?? null, f.tamanho ?? null, f.validade ?? null, f.diasAlerta];

function dataIso(valor) {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) {
    const ano = valor.getFullYear();
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

/**
 * Lista material ativo × tamanho da empresa, paginado. Nesta etapa não
 * existe reserva: `disponivel` é igual a `saldo` (contrato preparado para
 * a reserva futura sem quebrar os clientes).
 */
async function listarDisponiveis(executor, empresaId, filtros = {}) {
  exigirEmpresa(empresaId);
  exigirFiltrosDisponiveis(filtros);
  const { pagina = 1, limite = 50 } = filtros;
  if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('página inválida');
  if (!Number.isInteger(limite) || limite < 1) throw new TypeError('limite inválido');

  const { rows } = await executor.query(
    `SELECT m.id AS material_id, m.nome AS material, m.codigo_interno, m.categoria, m.tipo,
            et.tamanho, et.quantidade, m.unidade, m.estoque_minimo, m.ca_validade,
            ${CLASSIFICACAO_VALIDADE_CA} AS validade
       ${FILTRO_DISPONIVEIS}
      ORDER BY lower(m.nome), m.id, et.tamanho
      LIMIT $7 OFFSET $8`,
    [...paramsFiltro(empresaId, filtros), limite, (pagina - 1) * limite],
  );

  return rows.map((l) => ({
    materialId: l.material_id,
    material: l.material,
    codigoInterno: l.codigo_interno ?? null,
    categoria: l.categoria ?? null,
    tipo: l.tipo ?? null,
    tamanho: l.tamanho,
    saldo: l.quantidade,
    disponivel: l.quantidade,
    unidade: l.unidade,
    estoqueMinimo: l.estoque_minimo,
    caValidade: dataIso(l.ca_validade),
    validade: l.validade,
  }));
}

/** Total para a paginação, com exatamente os mesmos filtros. */
async function contarDisponiveis(executor, empresaId, filtros = {}) {
  exigirEmpresa(empresaId);
  exigirFiltrosDisponiveis(filtros);
  const { rows } = await executor.query(`SELECT count(*)::int AS total ${FILTRO_DISPONIVEIS}`, paramsFiltro(empresaId, filtros));
  return rows[0] ? rows[0].total : 0;
}

/** Opções reais dos filtros: valores distintos da empresa, só de materiais ativos com tamanho cadastrado. */
async function listarFiltrosDisponiveis(executor, empresaId) {
  exigirEmpresa(empresaId);
  const { rows } = await executor.query(
    `SELECT array_agg(DISTINCT m.categoria ORDER BY m.categoria) FILTER (WHERE m.categoria IS NOT NULL) AS categorias,
            array_agg(DISTINCT m.tipo ORDER BY m.tipo) FILTER (WHERE m.tipo IS NOT NULL) AS tipos,
            array_agg(DISTINCT et.tamanho ORDER BY et.tamanho) AS tamanhos
       FROM estoque_tamanhos et
       JOIN materiais m ON m.id = et.material_id
      WHERE m.empresa_id = $1 AND m.ativo`,
    [empresaId],
  );
  const l = rows[0] || {};
  return { categorias: l.categorias || [], tipos: l.tipos || [], tamanhos: l.tamanhos || [] };
}

module.exports = {
  listarDisponiveis,
  contarDisponiveis,
  listarFiltrosDisponiveis,
  listarPorMaterial,
  buscarPorMaterialTamanhoParaAtualizacao,
  criar,
  atualizarQuantidade,
  TAMANHO_MAXIMO_TAMANHO,
};
