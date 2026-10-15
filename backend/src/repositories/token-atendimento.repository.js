'use strict';

/**
 * Atendimento temporário do funcionário no tablet (token_atendimentos, migration 086). Só estrutura de acesso: nenhuma regra de
 * negócio. Todo instante vem do relógio do BANCO (clock_timestamp) na própria instrução, para a decisão e o instante serem do
 * mesmo relógio. O token em claro nunca chega aqui: só o SHA-256 em hexadecimal.
 *
 * Executor por parâmetro; nunca o pool global.
 */

const HASH = /^[0-9a-f]{64}$/;
const MOTIVOS = Object.freeze(['SAIDA', 'INATIVIDADE', 'SUBSTITUIDO']);

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}
function exigirHash(valor) {
  if (typeof valor !== 'string' || !HASH.test(valor)) throw new TypeError('hash inválido');
}

/**
 * Trava a linha do tablet (a MESMA trava da ativação, da revogação e da rotação) e traz o que decide a validade da credencial
 * apresentada. É a primeira trava de toda escrita do atendimento.
 */
async function travarDispositivo(executor, empresaId, id) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(id, 'identificador de dispositivo');
  const { rows } = await executor.query(
    `SELECT d.id, d.empresa_id, d.credencial_hash, d.credencial_anterior_hash, d.revogado_em, e.ativo AS empresa_ativa
       FROM token_dispositivos d JOIN empresas e ON e.id = d.empresa_id
      WHERE d.empresa_id = $1 AND d.id = $2
        FOR UPDATE OF d`,
    [empresaId, id],
  );
  return rows[0] ?? null;
}

/**
 * Funcionário ATIVO da empresa, pelo tipo escolhido. CPF: igualdade com os 11 dígitos canônicos. Matrícula: igualdade EXATA, como a
 * unicidade (empresa, matrícula) do cadastro (sensível a caixa, sem converter em número). Sem fallback entre os tipos.
 */
async function buscarFuncionarioAtivo(executor, { empresaId, tipo, valor }) {
  exigirId(empresaId, 'identificador de empresa');
  if (typeof valor !== 'string' || valor.length === 0) throw new TypeError('identificador inválido');
  let sql;
  if (tipo === 'CPF') sql = "SELECT id, nome FROM funcionarios WHERE empresa_id = $1 AND cpf = $2 AND situacao = 'ATIVO'";
  else if (tipo === 'MATRICULA') sql = "SELECT id, nome FROM funcionarios WHERE empresa_id = $1 AND matricula = $2 AND situacao = 'ATIVO'";
  else throw new TypeError('tipo de identificador inválido');
  const { rows } = await executor.query(sql, [empresaId, valor]);
  return rows[0] ?? null;
}

// Tudo o que a validade precisa, medido numa leitura só. `anterior_a_reativacao`: um código de ativação do tablet foi CONSUMIDO
// (token_ativacoes.usado_em) depois do início do atendimento. O marcador é o consumo do código, e não o evento ATIVACAO: a Etapa C
// grava `usado_em` com clock_timestamp() DENTRO da trava do tablet, então ele respeita a ordem real das operações; o evento usa o
// now() de INÍCIO da transação e, se a recuperação já tinha começado e esperava a trava, ficava ANTERIOR a um atendimento criado
// antes de ela valer. Gerar o código sem consumi-lo (usado_em nulo) nem cancelá-lo não invalida nada; a rotação não consome código.
const SELECAO = `a.id, a.empresa_id, a.dispositivo_id, a.funcionario_id, a.expira_em,
       (a.expira_em <= clock_timestamp()) AS vencido,
       GREATEST(0, EXTRACT(EPOCH FROM (a.expira_em - clock_timestamp()))) AS restante_segundos,
       f.nome AS funcionario_nome, (f.situacao = 'ATIVO') AS funcionario_ativo,
       EXISTS (SELECT 1 FROM token_ativacoes ta
                WHERE ta.empresa_id = a.empresa_id AND ta.dispositivo_id = a.dispositivo_id
                  AND ta.usado_em IS NOT NULL AND ta.usado_em > a.iniciado_em) AS anterior_a_reativacao`;

/** O atendimento ABERTO deste tablet com este token. `travar` só dentro de transação que já tem a trava do tablet. */
async function buscarAbertoPorToken(executor, { empresaId, dispositivoId, tokenHash, travar = false }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  exigirHash(tokenHash);
  const { rows } = await executor.query(
    `SELECT ${SELECAO}
       FROM token_atendimentos a
       JOIN funcionarios f ON f.empresa_id = a.empresa_id AND f.id = a.funcionario_id
      WHERE a.token_hash = $1 AND a.empresa_id = $2 AND a.dispositivo_id = $3 AND a.encerrado_em IS NULL
      ${travar ? 'FOR UPDATE OF a' : ''}`,
    [tokenHash, empresaId, dispositivoId],
  );
  return rows[0] ?? null;
}

/** O atendimento aberto do tablet (no máximo um, pelo índice único parcial), travado. */
async function buscarAbertoDoDispositivoTravando(executor, { empresaId, dispositivoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  const { rows } = await executor.query(
    `SELECT a.id, a.funcionario_id, (a.expira_em <= clock_timestamp()) AS vencido
       FROM token_atendimentos a
      WHERE a.empresa_id = $1 AND a.dispositivo_id = $2 AND a.encerrado_em IS NULL
        FOR UPDATE OF a`,
    [empresaId, dispositivoId],
  );
  return rows[0] ?? null;
}

async function inserir(executor, { empresaId, dispositivoId, funcionarioId, tokenHash, inatividadeSegundos }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  exigirId(funcionarioId, 'identificador de funcionário');
  exigirHash(tokenHash);
  exigirId(inatividadeSegundos, 'prazo de inatividade');
  const { rows } = await executor.query(
    `INSERT INTO token_atendimentos (empresa_id, dispositivo_id, funcionario_id, token_hash, iniciado_em, expira_em)
     VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp() + make_interval(secs => $5::int))
     RETURNING id, expira_em`,
    [empresaId, dispositivoId, funcionarioId, tokenHash, inatividadeSegundos],
  );
  return rows[0];
}

/** Encerra o atendimento ainda aberto; false se ele já estava encerrado. */
async function encerrar(executor, { id, motivo }) {
  exigirId(Number(id), 'identificador de atendimento');
  if (!MOTIVOS.includes(motivo)) throw new TypeError('motivo de encerramento inválido');
  const { rowCount } = await executor.query(
    'UPDATE token_atendimentos SET encerrado_em = clock_timestamp(), motivo_encerramento = $2 WHERE id = $1 AND encerrado_em IS NULL',
    [id, motivo],
  );
  return rowCount === 1;
}

/** Reinicia os 60 s a partir de AGORA (relógio do banco), se ainda aberto e não vencido. Devolve o novo prazo ou null. */
async function renovar(executor, { id, inatividadeSegundos }) {
  exigirId(Number(id), 'identificador de atendimento');
  exigirId(inatividadeSegundos, 'prazo de inatividade');
  const { rows } = await executor.query(
    `UPDATE token_atendimentos SET expira_em = clock_timestamp() + make_interval(secs => $2::int)
      WHERE id = $1 AND encerrado_em IS NULL AND expira_em > clock_timestamp()
      RETURNING expira_em, GREATEST(0, EXTRACT(EPOCH FROM (expira_em - clock_timestamp()))) AS restante_segundos`,
    [id, inatividadeSegundos],
  );
  return rows[0] ?? null;
}

module.exports = {
  travarDispositivo,
  buscarFuncionarioAtivo,
  buscarAbertoPorToken,
  buscarAbertoDoDispositivoTravando,
  inserir,
  encerrar,
  renovar,
};
