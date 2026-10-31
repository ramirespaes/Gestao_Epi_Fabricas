'use strict';

/**
 * Repositório do histórico de situação do funcionário (`funcionario_situacoes`, migration 096) e das consultas que as regras
 * de data efetiva precisam (última data efetiva registrada; entregas posteriores a uma data).
 *
 * Mesmo padrão dos demais repositórios: executor por parâmetro, validação de formato (TypeError), nenhuma regra de negócio e
 * nenhuma decisão de autorização. A cronologia, os conflitos com entregas e a auditoria são do serviço (funcionario.service.js),
 * sob a trava do funcionário. Empresa, funcionário e ator chegam como inteiros do servidor, nunca do corpo da requisição.
 *
 * O instante do registro (`registrado_em`) é sempre o do servidor: a coluna nem aparece na lista do INSERT. A data efetiva é a
 * data civil informada pelo operador, trafega como texto AAAA-MM-DD e é devolvida nesse mesmo formato (to_char no próprio
 * PostgreSQL), nunca convertida em Date do Node.
 */

const DATA_CIVIL = /^\d{4}-\d{2}-\d{2}$/;

function exigirInteiroPositivo(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirDataCivil(valor, nome) {
  if (typeof valor !== 'string' || !DATA_CIVIL.test(valor)) {
    throw new TypeError(`${nome} inválida`);
  }
}

async function registrar(executor, {
  empresaId, funcionarioId, situacaoAnterior, situacaoNova, dataEfetiva, registradoPor,
}) {
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
  exigirInteiroPositivo(funcionarioId, 'identificador de funcionário');
  exigirInteiroPositivo(registradoPor, 'identificador de ator');
  if (typeof situacaoAnterior !== 'string' || typeof situacaoNova !== 'string') {
    throw new TypeError('situação inválida');
  }
  if (dataEfetiva !== null) {
    exigirDataCivil(dataEfetiva, 'data efetiva');
  }
  const { rows } = await executor.query(
    `INSERT INTO funcionario_situacoes (empresa_id, funcionario_id, situacao_anterior, situacao_nova, data_efetiva, registrado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, registrado_em`,
    [empresaId, funcionarioId, situacaoAnterior, situacaoNova, dataEfetiva, registradoPor],
  );
  return { id: rows[0].id, registradoEm: rows[0].registrado_em };
}

/** Última data efetiva já registrada do funcionário (texto AAAA-MM-DD) ou null: nenhuma data é inventada para o legado. */
async function buscarUltimaDataEfetiva(executor, empresaId, funcionarioId) {
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
  exigirInteiroPositivo(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query(
    `SELECT to_char(max(data_efetiva), 'YYYY-MM-DD') AS data_efetiva
       FROM funcionario_situacoes
      WHERE empresa_id = $1 AND funcionario_id = $2 AND data_efetiva IS NOT NULL`,
    [empresaId, funcionarioId],
  );
  return rows[0]?.data_efetiva ?? null;
}

/**
 * Primeira (mais antiga) data efetiva já registrada do funcionário (texto AAAA-MM-DD) ou null. Limite para a edição da admissão:
 * a admissão nunca pode passar a ser posterior a ela. Sem linha com data (legado), null: nenhuma data é inventada.
 */
async function buscarPrimeiraDataEfetiva(executor, empresaId, funcionarioId) {
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
  exigirInteiroPositivo(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query(
    `SELECT to_char(min(data_efetiva), 'YYYY-MM-DD') AS data_efetiva
       FROM funcionario_situacoes
      WHERE empresa_id = $1 AND funcionario_id = $2 AND data_efetiva IS NOT NULL`,
    [empresaId, funcionarioId],
  );
  return rows[0]?.data_efetiva ?? null;
}

/**
 * Entregas do funcionário com data operacional ESTRITAMENTE posterior à data efetiva (entregas diretas e por solicitação, pela
 * ficha do funcionário, na empresa). `data_operacional` já é a data civil de São Paulo gravada na entrega (CHECK da 058): nada
 * aqui converte fuso. O mesmo dia não conflita: a data não tem horário e o último dia de trabalho comporta entrega legítima.
 */
async function resumirEntregasPosteriores(executor, empresaId, funcionarioId, dataEfetiva) {
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
  exigirInteiroPositivo(funcionarioId, 'identificador de funcionário');
  exigirDataCivil(dataEfetiva, 'data efetiva');
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total,
            to_char(min(e.data_operacional), 'YYYY-MM-DD') AS primeira_em,
            to_char(max(e.data_operacional), 'YYYY-MM-DD') AS ultima_em
       FROM entregas_epi e
       JOIN fichas_epi f ON f.empresa_id = e.empresa_id AND f.id = e.ficha_id
      WHERE f.empresa_id = $1 AND f.funcionario_id = $2 AND e.data_operacional > $3::date`,
    [empresaId, funcionarioId, dataEfetiva],
  );
  const linha = rows[0] ?? {};
  return { total: Number(linha.total ?? 0), primeiraEm: linha.primeira_em ?? null, ultimaEm: linha.ultima_em ?? null };
}

module.exports = {
  registrar, buscarUltimaDataEfetiva, buscarPrimeiraDataEfetiva, resumirEntregasPosteriores,
};
