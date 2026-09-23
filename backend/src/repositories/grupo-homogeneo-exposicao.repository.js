'use strict';

const { escaparCoringasLike } = require('../utils/like');

/**
 * Repositório de grupos homogêneos de exposição — GHE
 * (grupos_homogeneos_exposicao, migration 004). Bloco 9, Etapa B.
 *
 * Mesmo padrão de material.repository.js (Etapa A): executor por parâmetro,
 * validação de formato via exigir*, nenhuma regra de negócio, nenhuma
 * decisão de autorização (isso é do middleware de permissão por recurso,
 * `'employeeGroups'`, montado nas rotas). Propaga violações do PostgreSQL
 * sem traduzir — notadamente `uq_ghe_empresa_nome` (nome único por empresa,
 * comparação exata da migration 004) e `fk_funcionarios_ghe_mesma_empresa`
 * (um GHE referenciado por funcionário não pode ser apagado — e este
 * módulo, de propósito, não tem função de DELETE: GHE é inativado).
 *
 * empresaId é sempre o filtro de isolamento e nunca é opcional.
 */

// grupos_homogeneos_exposicao.nome VARCHAR(150), setor/funcao VARCHAR(100);
// descricao/riscos são TEXT (sem teto no banco) — mesmos limites da migration 004.
const TAMANHO_MAXIMO_NOME = 150;
const TAMANHO_MAXIMO_SETOR = 100;
const TAMANHO_MAXIMO_FUNCAO = 100;

const PROJECAO = 'id, empresa_id, nome, descricao, setor, funcao, riscos, ativo, criado_em, atualizado_em';

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
    throw new TypeError('nome de GHE inválido');
  }
}

function exigirTextoOpcional(valor, nome, tamanhoMaximo = Infinity) {
  if (valor !== null && (typeof valor !== 'string' || valor.length === 0 || valor.length > tamanhoMaximo)) {
    throw new TypeError(`${nome} deve ser string não vazia dentro do limite, ou null`);
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  nome: linha.nome,
  descricao: linha.descricao,
  setor: linha.setor,
  funcao: linha.funcao,
  riscos: linha.riscos,
  ativo: linha.ativo,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

/** Cria um GHE. `ativo` nasce true pelo DEFAULT da migration 004 e não é parâmetro. */
async function criar(executor, {
  empresaId, nome, descricao = null, setor = null, funcao = null, riscos = null,
}) {
  exigirEmpresa(empresaId);
  exigirNome(nome);
  exigirTextoOpcional(descricao, 'descrição');
  exigirTextoOpcional(setor, 'setor', TAMANHO_MAXIMO_SETOR);
  exigirTextoOpcional(funcao, 'função', TAMANHO_MAXIMO_FUNCAO);
  exigirTextoOpcional(riscos, 'riscos');

  const { rows } = await executor.query(
    `INSERT INTO grupos_homogeneos_exposicao (empresa_id, nome, descricao, setor, funcao, riscos)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${PROJECAO}`,
    [empresaId, nome, descricao, setor, funcao, riscos],
  );

  return mapear(rows[0]);
}

async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de GHE');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND id = $2`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/** Igual a buscarPorId, com FOR UPDATE (dentro de transação). */
async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de GHE');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Igual a buscarPorId, com FOR SHARE (dentro de transação) — leitura
 * travada para quem vai VINCULAR algo a este GHE e precisa que o estado
 * `ativo` lido continue verdadeiro até o COMMIT (correção pós-auditoria da
 * Etapa B, 23/09/2026).
 *
 * POR QUE FOR SHARE, E NÃO FOR UPDATE: várias vinculações concorrentes ao
 * MESMO GHE podem coexistir (share é compatível com share); o que precisa
 * ser excluído é a INATIVAÇÃO concorrente, que trava a linha com FOR
 * UPDATE (buscarPorIdParaAtualizacao) e cujo UPDATE toma FOR NO KEY UPDATE
 * — ambos conflitam com FOR SHARE e ficam esperando até o COMMIT/ROLLBACK
 * de quem vincula. No sentido inverso, uma vinculação que chegue durante
 * uma inativação espera o COMMIT dela e então relê a linha JÁ inativa
 * (READ COMMITTED reavalia a linha travada na versão mais recente), sendo
 * recusada pelo serviço.
 *
 * POR QUE A FK NÃO BASTA: a FK composta (migration 006) toma apenas FOR
 * KEY SHARE na linha do GHE, que NÃO conflita com o FOR NO KEY UPDATE de
 * um UPDATE de `ativo` (coluna não-chave). A FK garante existência e
 * mesma empresa; nunca garantiu `ativo`.
 *
 * ESCOPO DO LOCK: uma única linha, filtrada por empresa_id e id. Nenhum
 * outro GHE, nenhuma outra empresa, nenhuma linha de funcionarios.
 */
async function buscarPorIdParaVinculo(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de GHE');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM grupos_homogeneos_exposicao WHERE empresa_id = $1 AND id = $2 FOR SHARE`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Lista os GHE de uma empresa, paginados e ordenados por nome (sem
 * diferenciar maiúsculas). `busca` filtra por nome, como texto literal.
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
       FROM grupos_homogeneos_exposicao
      WHERE empresa_id = $1
        AND ($2::boolean IS NULL OR ativo = $2::boolean)
        AND ($3::text IS NULL OR nome ILIKE '%' || $3::text || '%')
      ORDER BY lower(nome), id
      LIMIT $4 OFFSET $5`,
    [empresaId, ativo, buscaEscapada, limite, deslocamento],
  );

  return rows.map((linha) => mapear(linha));
}

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
       FROM grupos_homogeneos_exposicao
      WHERE empresa_id = $1
        AND ($2::boolean IS NULL OR ativo = $2::boolean)
        AND ($3::text IS NULL OR nome ILIKE '%' || $3::text || '%')`,
    [empresaId, ativo, buscaEscapada],
  );

  return rows[0].total;
}

/**
 * Atualiza os campos do cadastro de um GHE da empresa informada. `ativo`
 * só muda pelas funções de estado do serviço. Para descricao/setor/funcao/
 * riscos, a flag `*Informado` distingue "não mexer" de "limpar para null".
 *
 * @returns {Promise<object|null>} GHE atualizado, ou null se não existe nesta empresa
 */
async function atualizar(executor, empresaId, id, {
  nome = null,
  descricao = null, descricaoInformado = false,
  setor = null, setorInformado = false,
  funcao = null, funcaoInformado = false,
  riscos = null, riscosInformado = false,
  ativo = null,
} = {}) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de GHE');
  if (nome !== null) {
    exigirNome(nome);
  }
  if (descricaoInformado) {
    exigirTextoOpcional(descricao, 'descrição');
  }
  if (setorInformado) {
    exigirTextoOpcional(setor, 'setor', TAMANHO_MAXIMO_SETOR);
  }
  if (funcaoInformado) {
    exigirTextoOpcional(funcao, 'função', TAMANHO_MAXIMO_FUNCAO);
  }
  if (riscosInformado) {
    exigirTextoOpcional(riscos, 'riscos');
  }
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('ativo deve ser booleano ou null');
  }

  const { rows } = await executor.query(
    `UPDATE grupos_homogeneos_exposicao
        SET nome = COALESCE($3, nome),
            descricao = CASE WHEN $4::boolean THEN $5 ELSE descricao END,
            setor = CASE WHEN $6::boolean THEN $7 ELSE setor END,
            funcao = CASE WHEN $8::boolean THEN $9 ELSE funcao END,
            riscos = CASE WHEN $10::boolean THEN $11 ELSE riscos END,
            ativo = COALESCE($12, ativo)
      WHERE empresa_id = $1 AND id = $2
      RETURNING ${PROJECAO}`,
    [
      empresaId, id, nome,
      descricaoInformado, descricao,
      setorInformado, setor,
      funcaoInformado, funcao,
      riscosInformado, riscos,
      ativo,
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
  TAMANHO_MAXIMO_SETOR,
  TAMANHO_MAXIMO_FUNCAO,
};
