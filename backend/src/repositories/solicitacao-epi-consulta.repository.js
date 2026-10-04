'use strict';

/**
 * Listagens do cabeçalho da solicitação de EPI (12E-1): minhas solicitações,
 * fila de decisão da SST e solicitações entregáveis. Só leitura, sempre pela
 * empresa. A linha traz o trabalhador por chave composta (nome, matrícula e
 * situação, nunca o CPF) e nenhum texto livre, chave ou hash; os itens, a
 * situação operacional e as quantidades são montados pelo serviço.
 *
 * Os predicados de status da fila e dos entregáveis são literais e iguais aos
 * dos índices parciais da 065 (idx_solicitacoes_epi_pendentes e
 * idx_solicitacoes_epi_aprovadas), para o planejador poder usá-los; a ordem de
 * cada lista é a do índice que a atende, com o id como desempate.
 */

const STATUS = Object.freeze(['PENDENTE', 'APROVADA', 'APROVADA_PARCIAL', 'REPROVADA', 'CANCELADA', 'ENTREGUE', 'ENCERRADA']);
const LIMITE_MAXIMO = 100;

const COLUNAS = `s.id, s.numero, s.status, s.solicitante_usuario_id, s.funcionario_id, s.quantidade_itens,
       s.criada_em, s.decidida_em, s.cancelada_em, s.entregue_em,
       f.nome AS trabalhador_nome, f.matricula AS trabalhador_matricula, f.ativo AS trabalhador_ativo`;
const ORIGEM = `FROM solicitacoes_epi s
       JOIN funcionarios f ON f.empresa_id = s.empresa_id AND f.id = s.funcionario_id`;

const FILTRO_MINHAS = `s.empresa_id = $1 AND s.solicitante_usuario_id = $2 AND ($3::text IS NULL OR s.status = $3::text)`;
const FILTRO_FILA = `s.empresa_id = $1 AND s.status = 'PENDENTE'`;
const FILTRO_ENTREGAVEIS = `s.empresa_id = $1 AND s.status IN ('APROVADA', 'APROVADA_PARCIAL')
        AND ($2::int IS NULL OR s.funcionario_id = $2::int)`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirStatusOpcional(status) {
  if (status !== null && !STATUS.includes(status)) throw new TypeError('status inválido');
}

function exigirPagina(pagina, limite) {
  if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('página inválida');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
}

const mapear = (l) => ({
  id: l.id,
  numero: l.numero,
  status: l.status,
  solicitanteUsuarioId: l.solicitante_usuario_id,
  funcionarioId: l.funcionario_id,
  quantidadeItens: l.quantidade_itens,
  criadaEm: l.criada_em,
  decididaEm: l.decidida_em,
  canceladaEm: l.cancelada_em,
  entregueEm: l.entregue_em,
  trabalhador: { nome: l.trabalhador_nome, matricula: l.trabalhador_matricula, ativo: l.trabalhador_ativo },
});

async function contar(executor, filtro, parametros) {
  const { rows } = await executor.query(`SELECT count(*)::int AS total FROM solicitacoes_epi s WHERE ${filtro}`, parametros);
  return Number(rows[0].total);
}

/**
 * Solicitações criadas pelo usuário (solicitante interno), das mais recentes
 * para as antigas; `status` opcional. Só esta lista lê a data do encerramento
 * (12F-1): na fila e nos entregáveis não há ENCERRADA.
 */
async function listarMinhas(executor, empresaId, solicitanteUsuarioId, { status = null, pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitanteUsuarioId, 'identificador de solicitante');
  exigirStatusOpcional(status);
  exigirPagina(pagina, limite);
  const { rows } = await executor.query(
    `SELECT ${COLUNAS}, s.encerrada_em
       ${ORIGEM}
      WHERE ${FILTRO_MINHAS}
      ORDER BY s.criada_em DESC, s.id DESC
      LIMIT $4 OFFSET $5`,
    [empresaId, solicitanteUsuarioId, status, limite, (pagina - 1) * limite],
  );
  return rows.map((l) => ({ ...mapear(l), encerradaEm: l.encerrada_em }));
}

async function contarMinhas(executor, empresaId, solicitanteUsuarioId, { status = null } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitanteUsuarioId, 'identificador de solicitante');
  exigirStatusOpcional(status);
  return contar(executor, FILTRO_MINHAS, [empresaId, solicitanteUsuarioId, status]);
}

/** Fila de decisão da SST: as PENDENTE da empresa, da mais antiga para a mais nova. */
async function listarFila(executor, empresaId, { pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirPagina(pagina, limite);
  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       ${ORIGEM}
      WHERE ${FILTRO_FILA}
      ORDER BY s.criada_em, s.id
      LIMIT $2 OFFSET $3`,
    [empresaId, limite, (pagina - 1) * limite],
  );
  return rows.map(mapear);
}

async function contarFila(executor, empresaId) {
  exigirId(empresaId, 'identificador de empresa');
  return contar(executor, FILTRO_FILA, [empresaId]);
}

/** Solicitações APROVADA e APROVADA_PARCIAL, na ordem da fila de cobertura (aprovação mais antiga primeiro); trabalhador opcional. */
async function listarEntregaveis(executor, empresaId, { funcionarioId = null, pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  if (funcionarioId !== null) exigirId(funcionarioId, 'identificador de funcionário');
  exigirPagina(pagina, limite);
  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       ${ORIGEM}
      WHERE ${FILTRO_ENTREGAVEIS}
      ORDER BY s.decidida_em, s.id
      LIMIT $3 OFFSET $4`,
    [empresaId, funcionarioId, limite, (pagina - 1) * limite],
  );
  return rows.map(mapear);
}

async function contarEntregaveis(executor, empresaId, { funcionarioId = null } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  if (funcionarioId !== null) exigirId(funcionarioId, 'identificador de funcionário');
  return contar(executor, FILTRO_ENTREGAVEIS, [empresaId, funcionarioId]);
}

// As encerráveis (12G-0) são as mesmas APROVADA e APROVADA_PARCIAL dos entregáveis: mesmo filtro, mesma ordem, mesmo
// índice parcial. Um nome próprio para cada uso, para a dependência ficar explícita.
const listarEncerraveis = listarEntregaveis;
const contarEncerraveis = contarEntregaveis;

/**
 * Dados de apresentação do detalhe (12G-0): o trabalhador, os materiais dos
 * itens e os usuários citados (quem solicitou, decidiu e encerrou), sempre pela
 * empresa e com colunas explícitas. Nunca CPF, e-mail, perfil, credencial nem
 * número de estoque. Só leitura, sem trava.
 */
async function dadosDeApresentacao(executor, empresaId, { funcionarioId, materialIds, usuarioIds }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  for (const id of [...materialIds, ...usuarioIds]) exigirId(id, 'identificador');
  const { rows: [funcionario] } = await executor.query(
    'SELECT id, nome, matricula, setor, funcao, ativo FROM funcionarios WHERE empresa_id = $1 AND id = $2',
    [empresaId, funcionarioId],
  );
  const { rows: materiais } = await executor.query(
    'SELECT id, nome, unidade FROM materiais WHERE empresa_id = $1 AND id = ANY($2::int[]) ORDER BY id',
    [empresaId, materialIds],
  );
  const { rows: usuarios } = await executor.query(
    'SELECT id, nome FROM usuarios WHERE empresa_id = $1 AND id = ANY($2::int[]) ORDER BY id',
    [empresaId, usuarioIds],
  );
  return { funcionario: funcionario ?? null, materiais, usuarios };
}

module.exports = {
  STATUS,
  LIMITE_MAXIMO,
  listarMinhas,
  contarMinhas,
  listarFila,
  contarFila,
  listarEntregaveis,
  contarEntregaveis,
  listarEncerraveis,
  contarEncerraveis,
  dadosDeApresentacao,
};
