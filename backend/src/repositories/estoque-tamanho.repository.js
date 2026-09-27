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

module.exports = {
  listarPorMaterial,
  buscarPorMaterialTamanhoParaAtualizacao,
  criar,
  atualizarQuantidade,
  TAMANHO_MAXIMO_TAMANHO,
};
