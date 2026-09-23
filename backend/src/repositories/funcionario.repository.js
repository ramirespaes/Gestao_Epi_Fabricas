'use strict';

const { escaparCoringasLike } = require('../utils/like');

/**
 * Repositório de funcionários (funcionarios, migration 006). Bloco 9, Etapa B.
 *
 * Funcionário é o colaborador que RECEBE EPI — entidade distinta de
 * `usuarios` (contas de acesso ao sistema), como a própria migration 005
 * documenta. Nenhuma coluna, FK ou consulta aqui liga as duas tabelas, de
 * propósito.
 *
 * Mesmo padrão de material.repository.js: executor por parâmetro, validação
 * de formato via exigir*, nenhuma regra de negócio, nenhuma decisão de
 * autorização (middleware de recurso `'employeeHistory'`, nas rotas).
 * Propaga violações do PostgreSQL sem traduzir — `uq_funcionarios_empresa_
 * matricula`, `uq_funcionarios_empresa_cpf`, `chk_funcionarios_cpf_formato`
 * e `fk_funcionarios_ghe_mesma_empresa` (FK composta: um funcionário só se
 * vincula a GHE da própria empresa, garantido pelo banco). Interpretar
 * SQLSTATE/constraint é do serviço.
 *
 * SEM EXCLUSÃO FÍSICA: funcionário é inativado. Matrícula e CPF continuam
 * reservados mesmo inativo (decisão da migration 006).
 *
 * O CPF é recebido JÁ normalizado (11 dígitos) pela camada de serviço, que
 * usa utils/normalizacao.js; aqui só resta o contrato do banco. E só em
 * criar(): o CPF é IMUTÁVEL após o cadastro (decisão definitiva de
 * 2026-09-23) — atualizar() não tem a coluna no SET e recusa a chave
 * `cpf` com TypeError, de modo que não exista nesta aplicação SQL capaz
 * de alterar funcionarios.cpf.
 */

// VARCHAR(30) matricula/cracha, VARCHAR(150) nome, VARCHAR(11) cpf,
// VARCHAR(100) setor/funcao, VARCHAR(20) telefone — migration 006.
const TAMANHO_MAXIMO_MATRICULA = 30;
const TAMANHO_MAXIMO_NOME = 150;
const TAMANHO_MAXIMO_SETOR = 100;
const TAMANHO_MAXIMO_FUNCAO = 100;
const TAMANHO_MAXIMO_CRACHA = 30;
const TAMANHO_MAXIMO_TELEFONE = 20;
const CPF_FORMATO = /^[0-9]{11}$/;

const PROJECAO = `id, empresa_id, grupo_homogeneo_id, matricula, nome, cpf, data_nascimento,
  setor, funcao, cracha, telefone, ativo, criado_em, atualizado_em`;

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

function exigirIdOpcional(valor, nome) {
  if (valor !== null) {
    exigirId(valor, nome);
  }
}

function exigirTexto(valor, nome, tamanhoMaximo) {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > tamanhoMaximo) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirTextoOpcional(valor, nome, tamanhoMaximo) {
  if (valor !== null) {
    exigirTexto(valor, nome, tamanhoMaximo);
  }
}

function exigirCpf(cpf) {
  if (typeof cpf !== 'string' || !CPF_FORMATO.test(cpf)) {
    throw new TypeError('CPF deve ter exatamente 11 dígitos (já normalizado)');
  }
}

function exigirDataOpcional(valor, nome) {
  if (valor !== null && !(valor instanceof Date) && typeof valor !== 'string') {
    throw new TypeError(`${nome} deve ser data, string ou null`);
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  grupoHomogeneoId: linha.grupo_homogeneo_id,
  matricula: linha.matricula,
  nome: linha.nome,
  cpf: linha.cpf,
  dataNascimento: linha.data_nascimento,
  setor: linha.setor,
  funcao: linha.funcao,
  cracha: linha.cracha,
  telefone: linha.telefone,
  ativo: linha.ativo,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

/** Cria um funcionário. `ativo` nasce true pelo DEFAULT da migration 006 e não é parâmetro. */
async function criar(executor, {
  empresaId, matricula, nome, cpf, grupoHomogeneoId = null, dataNascimento = null,
  setor = null, funcao = null, cracha = null, telefone = null,
}) {
  exigirEmpresa(empresaId);
  exigirTexto(matricula, 'matrícula', TAMANHO_MAXIMO_MATRICULA);
  exigirTexto(nome, 'nome de funcionário', TAMANHO_MAXIMO_NOME);
  exigirCpf(cpf);
  exigirIdOpcional(grupoHomogeneoId, 'identificador de GHE');
  exigirDataOpcional(dataNascimento, 'data de nascimento');
  exigirTextoOpcional(setor, 'setor', TAMANHO_MAXIMO_SETOR);
  exigirTextoOpcional(funcao, 'função', TAMANHO_MAXIMO_FUNCAO);
  exigirTextoOpcional(cracha, 'crachá', TAMANHO_MAXIMO_CRACHA);
  exigirTextoOpcional(telefone, 'telefone', TAMANHO_MAXIMO_TELEFONE);

  const { rows } = await executor.query(
    `INSERT INTO funcionarios
       (empresa_id, grupo_homogeneo_id, matricula, nome, cpf, data_nascimento, setor, funcao, cracha, telefone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${PROJECAO}`,
    [empresaId, grupoHomogeneoId, matricula, nome, cpf, dataNascimento, setor, funcao, cracha, telefone],
  );

  return mapear(rows[0]);
}

async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de funcionário');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM funcionarios WHERE empresa_id = $1 AND id = $2`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/** Igual a buscarPorId, com FOR UPDATE (dentro de transação). */
async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de funcionário');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM funcionarios WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Lista os funcionários de uma empresa, paginados e ordenados por nome.
 * `busca` filtra por nome OU matrícula (texto literal, sem coringas);
 * `grupoHomogeneoId` filtra por GHE. Nenhum filtro por CPF: CPF não é
 * critério de busca livre (dado pessoal, CLAUDE.md §44).
 */
async function listarPorEmpresa(executor, empresaId, {
  ativo = null, busca = null, grupoHomogeneoId = null, pagina = 1, limite = 20,
} = {}) {
  exigirEmpresa(empresaId);
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('filtro ativo deve ser booleano ou null');
  }
  if (busca !== null && typeof busca !== 'string') {
    throw new TypeError('filtro de busca deve ser string ou null');
  }
  exigirIdOpcional(grupoHomogeneoId, 'identificador de GHE');
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
       FROM funcionarios
      WHERE empresa_id = $1
        AND ($2::boolean IS NULL OR ativo = $2::boolean)
        AND ($3::text IS NULL OR nome ILIKE '%' || $3::text || '%' OR matricula ILIKE '%' || $3::text || '%')
        AND ($4::integer IS NULL OR grupo_homogeneo_id = $4::integer)
      ORDER BY lower(nome), id
      LIMIT $5 OFFSET $6`,
    [empresaId, ativo, buscaEscapada, grupoHomogeneoId, limite, deslocamento],
  );

  return rows.map((linha) => mapear(linha));
}

async function contarPorEmpresa(executor, empresaId, { ativo = null, busca = null, grupoHomogeneoId = null } = {}) {
  exigirEmpresa(empresaId);
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('filtro ativo deve ser booleano ou null');
  }
  if (busca !== null && typeof busca !== 'string') {
    throw new TypeError('filtro de busca deve ser string ou null');
  }
  exigirIdOpcional(grupoHomogeneoId, 'identificador de GHE');

  const buscaEscapada = busca === null ? null : escaparCoringasLike(busca);

  const { rows } = await executor.query(
    `SELECT count(*)::int AS total
       FROM funcionarios
      WHERE empresa_id = $1
        AND ($2::boolean IS NULL OR ativo = $2::boolean)
        AND ($3::text IS NULL OR nome ILIKE '%' || $3::text || '%' OR matricula ILIKE '%' || $3::text || '%')
        AND ($4::integer IS NULL OR grupo_homogeneo_id = $4::integer)`,
    [empresaId, ativo, buscaEscapada, grupoHomogeneoId],
  );

  return rows[0].total;
}

/**
 * Atualiza o cadastro de um funcionário da empresa informada. `ativo` só
 * muda pelas funções de estado do serviço. Para os campos opcionais
 * (grupoHomogeneoId, dataNascimento, setor, funcao, cracha, telefone) a
 * flag `*Informado` distingue "não mexer" de "limpar para null" —
 * desvincular do GHE é `grupoHomogeneoId: null, grupoHomogeneoIdInformado: true`.
 *
 * `cpf` NÃO é aceito (imutável após o cadastro): a chave, com qualquer
 * valor, é recusada antes de consultar, e o UPDATE não tem cláusula para a
 * coluna — `cpf` só aparece na projeção RETURNING.
 *
 * @returns {Promise<object|null>} funcionário atualizado, ou null se não existe nesta empresa
 */
async function atualizar(executor, empresaId, id, campos = {}) {
  if (Object.hasOwn(campos, 'cpf')) {
    throw new TypeError('cpf não pode ser alterado após o cadastro');
  }
  const {
    matricula = null, nome = null,
    grupoHomogeneoId = null, grupoHomogeneoIdInformado = false,
    dataNascimento = null, dataNascimentoInformado = false,
    setor = null, setorInformado = false,
    funcao = null, funcaoInformado = false,
    cracha = null, crachaInformado = false,
    telefone = null, telefoneInformado = false,
    ativo = null,
  } = campos;
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de funcionário');
  if (matricula !== null) {
    exigirTexto(matricula, 'matrícula', TAMANHO_MAXIMO_MATRICULA);
  }
  if (nome !== null) {
    exigirTexto(nome, 'nome de funcionário', TAMANHO_MAXIMO_NOME);
  }
  if (grupoHomogeneoIdInformado) {
    exigirIdOpcional(grupoHomogeneoId, 'identificador de GHE');
  }
  if (dataNascimentoInformado) {
    exigirDataOpcional(dataNascimento, 'data de nascimento');
  }
  if (setorInformado) {
    exigirTextoOpcional(setor, 'setor', TAMANHO_MAXIMO_SETOR);
  }
  if (funcaoInformado) {
    exigirTextoOpcional(funcao, 'função', TAMANHO_MAXIMO_FUNCAO);
  }
  if (crachaInformado) {
    exigirTextoOpcional(cracha, 'crachá', TAMANHO_MAXIMO_CRACHA);
  }
  if (telefoneInformado) {
    exigirTextoOpcional(telefone, 'telefone', TAMANHO_MAXIMO_TELEFONE);
  }
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('ativo deve ser booleano ou null');
  }

  const { rows } = await executor.query(
    `UPDATE funcionarios
        SET matricula = COALESCE($3, matricula),
            nome = COALESCE($4, nome),
            grupo_homogeneo_id = CASE WHEN $5::boolean THEN $6 ELSE grupo_homogeneo_id END,
            data_nascimento = CASE WHEN $7::boolean THEN $8 ELSE data_nascimento END,
            setor = CASE WHEN $9::boolean THEN $10 ELSE setor END,
            funcao = CASE WHEN $11::boolean THEN $12 ELSE funcao END,
            cracha = CASE WHEN $13::boolean THEN $14 ELSE cracha END,
            telefone = CASE WHEN $15::boolean THEN $16 ELSE telefone END,
            ativo = COALESCE($17, ativo)
      WHERE empresa_id = $1 AND id = $2
      RETURNING ${PROJECAO}`,
    [
      empresaId, id, matricula, nome,
      grupoHomogeneoIdInformado, grupoHomogeneoId,
      dataNascimentoInformado, dataNascimento,
      setorInformado, setor,
      funcaoInformado, funcao,
      crachaInformado, cracha,
      telefoneInformado, telefone,
      ativo,
    ],
  );

  return mapear(rows[0]);
}

module.exports = {
  criar,
  buscarPorId,
  buscarPorIdParaAtualizacao,
  listarPorEmpresa,
  contarPorEmpresa,
  atualizar,
  TAMANHO_MAXIMO_MATRICULA,
  TAMANHO_MAXIMO_NOME,
  TAMANHO_MAXIMO_SETOR,
  TAMANHO_MAXIMO_FUNCAO,
  TAMANHO_MAXIMO_CRACHA,
  TAMANHO_MAXIMO_TELEFONE,
};
