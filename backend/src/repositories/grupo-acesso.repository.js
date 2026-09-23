'use strict';

/**
 * Repositório de grupos de acesso (grupos_acesso, migration 020):
 * criação, consulta pontual por id (inclusive travada, para uso
 * transacional), listagem por empresa e atualização de nome/descrição/
 * ativo.
 *
 * Usado exclusivamente pela camada de serviço de gestão de grupos
 * (src/services/grupo-acesso.service.js, Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3J). permissao.repository.js continua sendo a única fonte de
 * leitura da DECISÃO de autorização (buscarGrupoAcessoDoUsuario e as
 * permissões do grupo) e permanece intocado: este módulo é o lado
 * administrativo do cadastro, mesma separação já adotada entre
 * permissao.repository.js e autorizacao-individual.repository.js na
 * Subetapa 3I.
 *
 * Não decide nada: valida só o formato dos parâmetros (mesmo padrão
 * exigir*) e propaga qualquer violação de constraint do PostgreSQL —
 * notadamente o índice único funcional uq_grupos_acesso_empresa_nome_lower
 * (nome único por empresa, sem diferenciar maiúsculas) e a FK composta de
 * criado_por — sem traduzir. Interpretar SQLSTATE é do serviço.
 *
 * SEM EXCLUSÃO FÍSICA: não existe função de DELETE aqui, de propósito.
 * Grupos são inativados (ativo = false), nunca apagados — decisão já
 * registrada na própria migration 020, que por isso usa ON DELETE
 * RESTRICT na FK de usuarios.grupo_acesso_id.
 *
 * empresaId é sempre o filtro de isolamento e nunca é opcional: nenhuma
 * função aqui alcança um grupo de outra empresa, nem mesmo por id.
 */

// grupos_acesso.nome: VARCHAR(100) NOT NULL (migration 020).
const TAMANHO_MAXIMO_NOME = 100;

const PROJECAO = 'id, empresa_id, nome, descricao, ativo, criado_por, criado_em, atualizado_em';

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

/**
 * Nome já normalizado pela camada acima (sem espaços nas pontas, não
 * vazio). Aqui só resta o contrato do banco: string não vazia dentro de
 * VARCHAR(100).
 */
function exigirNome(nome) {
  if (typeof nome !== 'string' || nome.length === 0 || nome.length > TAMANHO_MAXIMO_NOME) {
    throw new TypeError('nome de grupo inválido');
  }
}

function exigirDescricaoOpcional(descricao) {
  if (descricao !== null && typeof descricao !== 'string') {
    throw new TypeError('descrição deve ser string ou null');
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  nome: linha.nome,
  descricao: linha.descricao,
  ativo: linha.ativo,
  criadoPor: linha.criado_por,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

/**
 * Cria um grupo. `ativo` nasce true pelo DEFAULT da migration 020 e não é
 * parâmetro: criar já inativo não é uma operação prevista.
 *
 * @param {{query: Function}} executor
 * @param {{empresaId: number, nome: string, descricao?: string|null, criadoPor: number}} dados
 */
async function criar(executor, { empresaId, nome, descricao = null, criadoPor }) {
  exigirEmpresa(empresaId);
  exigirNome(nome);
  exigirDescricaoOpcional(descricao);
  exigirId(criadoPor, 'identificador de criador');

  const { rows } = await executor.query(
    `INSERT INTO grupos_acesso (empresa_id, nome, descricao, criado_por)
     VALUES ($1, $2, $3, $4)
     RETURNING ${PROJECAO}`,
    [empresaId, nome, descricao, criadoPor],
  );

  return mapear(rows[0]);
}

/** Busca um grupo pelo id, restrito à empresa informada. */
async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de grupo');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM grupos_acesso WHERE empresa_id = $1 AND id = $2`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Igual a buscarPorId, mas com FOR UPDATE: dentro de uma transação,
 * impede que outra transação concorrente altere nome/descrição/ativo do
 * mesmo grupo enquanto esta decide o que gravar.
 */
async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de grupo');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM grupos_acesso WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Lista os grupos de uma empresa, ordenados por nome (comparação sem
 * diferenciar maiúsculas, a mesma do índice único da migration 020, para
 * que a ordem não dependa de acidente de digitação).
 *
 * @param {{ativo?: boolean|null}} filtro `ativo` null/ausente lista ativos
 *   E inativos; true ou false filtram explicitamente.
 */
async function listarPorEmpresa(executor, empresaId, { ativo = null } = {}) {
  exigirEmpresa(empresaId);
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('filtro ativo deve ser booleano ou null');
  }

  // $2 IS NULL desliga o filtro sem montar SQL dinâmico: a consulta é
  // sempre a mesma string, sempre parametrizada.
  const { rows } = await executor.query(
    `SELECT ${PROJECAO}
       FROM grupos_acesso
      WHERE empresa_id = $1 AND ($2::boolean IS NULL OR ativo = $2::boolean)
      ORDER BY lower(nome), id`,
    [empresaId, ativo],
  );

  return rows.map((linha) => mapear(linha));
}

/**
 * Atualiza nome, descrição e/ou ativo de um grupo da empresa informada.
 * Só esses três campos são alcançáveis: id, empresa_id, criado_por e
 * criado_em não aparecem em nenhum SET, nem por engano — atualizado_em é
 * responsabilidade da trigger da migration 020.
 *
 * Cada campo ausente em `campos` permanece como está (COALESCE com o
 * parâmetro NULL), o que também torna impossível apagar o nome passando
 * undefined. Para gravar descricao = NULL explicitamente existe
 * `descricaoInformada`, que distingue "não mexer" de "limpar".
 *
 * @param {{nome?: string, descricao?: string|null, descricaoInformada?: boolean, ativo?: boolean}} campos
 * @returns {Promise<object|null>} grupo já atualizado, ou null se não existia nesta empresa
 */
async function atualizar(executor, empresaId, id, {
  nome = null, descricao = null, descricaoInformada = false, ativo = null,
} = {}) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de grupo');
  if (nome !== null) {
    exigirNome(nome);
  }
  exigirDescricaoOpcional(descricao);
  if (typeof descricaoInformada !== 'boolean') {
    throw new TypeError('descricaoInformada deve ser booleano');
  }
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('ativo deve ser booleano ou null');
  }

  const { rows } = await executor.query(
    `UPDATE grupos_acesso
        SET nome = COALESCE($3, nome),
            descricao = CASE WHEN $5::boolean THEN $4 ELSE descricao END,
            ativo = COALESCE($6, ativo)
      WHERE empresa_id = $1 AND id = $2
      RETURNING ${PROJECAO}`,
    [empresaId, id, nome, descricao, descricaoInformada, ativo],
  );

  return mapear(rows[0]);
}

module.exports = {
  criar,
  buscarPorId,
  buscarPorIdParaAtualizacao,
  listarPorEmpresa,
  atualizar,
  TAMANHO_MAXIMO_NOME,
};
