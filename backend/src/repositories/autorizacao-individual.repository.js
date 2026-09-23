'use strict';

/**
 * Repositório administrativo de usuario_autorizacoes (migrations 019 e 023):
 * criação, consulta pontual por id (inclusive travada, para uso
 * transacional), enumeração de descendentes e exclusão.
 *
 * Contraparte de permissao.repository.js — que continua sendo a ÚNICA fonte
 * de leitura usada pela decisão de autorização (src/middleware/autorizacao.js)
 * e permanece somente-leitura, exatamente como se descreve. Este módulo é o
 * lado administrativo, usado exclusivamente pela camada de serviço de
 * concessão/revogação (src/services/autorizacao-individual.service.js,
 * Bloco 8, Incremento 8, Etapa 5A, Subetapa 3I). Separar os dois evita que
 * o repositório consultado a cada requisição autorizada ganhe funções de
 * escrita que nenhuma decisão de autorização precisa.
 *
 * Não decide nada: valida só o formato dos parâmetros (mesmo padrão exigir*
 * de permissao.repository.js) e propaga qualquer violação de constraint do
 * PostgreSQL (FK composta de origem, índices únicos parciais — migration
 * 023) sem traduzir. Interpretar qual SQLSTATE significa o quê é
 * responsabilidade do serviço, que sabe qual operação estava tentando.
 *
 * empresaId é sempre o filtro de isolamento e nunca é opcional — nenhuma
 * função aqui alcança uma autorização de outra empresa, nem mesmo por id.
 */

const FORMATO_ACAO_CODIGO = /^[A-Z][A-Z0-9_]{0,59}$/;

const PROJECAO = 'id, empresa_id, usuario_id, acao_codigo, motivo, autorizado_por, pode_delegar, origem_id, criado_em';

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

function exigirAcaoCodigo(acaoCodigo) {
  if (typeof acaoCodigo !== 'string' || !FORMATO_ACAO_CODIGO.test(acaoCodigo)) {
    throw new TypeError('código de ação inválido');
  }
}

function exigirMotivoOpcional(motivo) {
  if (motivo !== null && typeof motivo !== 'string') {
    throw new TypeError('motivo deve ser string ou null');
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  empresaId: linha.empresa_id,
  usuarioId: linha.usuario_id,
  acaoCodigo: linha.acao_codigo,
  motivo: linha.motivo,
  autorizadoPor: linha.autorizado_por,
  podeDelegar: linha.pode_delegar,
  origemId: linha.origem_id,
  criadoEm: linha.criado_em,
});

/**
 * Busca uma autorização pelo id, restrita à empresa informada.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} id
 */
async function buscarPorId(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de autorização');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM usuario_autorizacoes WHERE empresa_id = $1 AND id = $2`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Igual a buscarPorId, mas com FOR UPDATE: dentro de uma transação, impede
 * que outra transação concorrente revogue a linha (DELETE) ou altere
 * pode_delegar enquanto esta decide se delega ou revoga com base nela. Se a
 * linha já tiver sido removida por uma transação concorrente que commitou
 * antes, devolve null — a decisão que dependia dela simplesmente não
 * acontece.
 */
async function buscarPorIdParaAtualizacao(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de autorização');

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM usuario_autorizacoes WHERE empresa_id = $1 AND id = $2 FOR UPDATE`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

/**
 * Lista, TRAVANDO com FOR UPDATE, todas as autorizações de um usuário
 * para uma ação — diretas e delegadas, que coexistem legitimamente
 * desde os índices únicos parciais da migration 023.
 *
 * Existe para a verificação de autoridade administrativa (Subetapa 3Q,
 * src/services/autoridade-administrativa.js) e resolve exatamente a
 * mesma classe de corrida que buscarPorIdParaAtualizacao já resolvia
 * para a delegação (3I): quem decide agir com base numa autorização
 * precisa impedir que ela seja revogada entre a verificação e o COMMIT.
 * A revogação (excluir, abaixo) sempre passa por um FOR UPDATE na
 * mesma linha antes do DELETE, então travá-la aqui serializa as duas
 * operações — e a cascata da FK de origem (023), que também precisa
 * remover a linha, fica igualmente bloqueada.
 *
 * Por que não em permissao.repository.js, onde mora a consulta de
 * existência equivalente (usuarioTemAutorizacaoIndividual): aquele
 * módulo é lido pelo middleware a CADA requisição autorizada e não
 * pode ganhar leitura travada — um lock ali seria desastroso no
 * caminho quente e inútil fora de transação. A separação entre o lado
 * que DECIDE autorização e o lado ADMINISTRATIVO, estabelecida na 3I,
 * é justamente o que permite ter as duas variantes sem risco de trocar
 * uma pela outra.
 *
 * Só faz sentido dentro de uma transação; fora dela o lock é liberado
 * ao fim do próprio SELECT e a função vira uma consulta comum.
 *
 * @returns {Promise<Array<object>>} vazio quando não há autorização.
 */
async function listarPorUsuarioAcaoParaAtualizacao(executor, empresaId, usuarioId, acaoCodigo) {
  exigirEmpresa(empresaId);
  exigirId(usuarioId, 'identificador de usuário');
  exigirAcaoCodigo(acaoCodigo);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO}
       FROM usuario_autorizacoes
      WHERE empresa_id = $1 AND usuario_id = $2 AND acao_codigo = $3
      FOR UPDATE`,
    [empresaId, usuarioId, acaoCodigo],
  );

  return rows.map((linha) => mapear(linha));
}

/**
 * Lista as autorizações de UM usuário, para a tela administrativa da
 * Subetapa 3V. Somente leitura, SEM FOR UPDATE — ao contrário de
 * listarPorUsuarioAcaoParaAtualizacao, que existe para decidir sob
 * transação. Confundir as duas seria pôr lock no caminho de consulta.
 *
 * TRAZ OS NOMES POR JUNÇÃO, e isso é decisão de produto, não conveniência:
 * a tela precisa mostrar "Ana Souza", "concedida por Master da Empresa"
 * e "Movimentar estoque" — e nem todo mundo que pode LER estas linhas
 * tem autoridade para chamar GET /api/usuarios (3U) ou
 * GET /api/catalogo/acoes (3T). Um delegador não-MASTER enxerga as
 * próprias autorizações mas pode não ter nenhuma das duas autoridades
 * administrativas; sem a junção, a tela dele cairia em identificadores
 * numéricos.
 *
 * As junções com `usuarios` casam também por empresa_id — não só por id.
 * A FK composta da migration 019 já garante isso no banco; repetir a
 * condição aqui faz com que um dia, se alguém afrouxar a FK, a consulta
 * continue não atravessando empresas.
 *
 * `concedidasPor`, quando informado, restringe às linhas concedidas por
 * aquela pessoa. É o que permite a um não-MASTER ver o que ELE concedeu
 * a terceiros — exatamente o conjunto que a 3I lhe permite revogar —
 * sem enxergar o resto das autorizações alheias.
 *
 * Também devolve o estado da AÇÃO no catálogo (nome, modo, exige_sst,
 * ativo). A tela usa isso para explicar, e não para decidir: quem decide
 * continua sendo o serviço, a cada operação.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} usuarioId
 * @param {{concedidasPor?: number|null}} [opcoes]
 * @returns {Promise<Array<object>>} vazio quando não há nada visível.
 */
async function listarPorUsuario(executor, empresaId, usuarioId, { concedidasPor = null } = {}) {
  exigirEmpresa(empresaId);
  exigirId(usuarioId, 'identificador de usuário');
  if (concedidasPor !== null) {
    exigirId(concedidasPor, 'identificador de concedente');
  }

  const { rows } = await executor.query(
    `SELECT a.id, a.empresa_id, a.usuario_id, a.acao_codigo, a.motivo,
            a.autorizado_por, a.pode_delegar, a.origem_id, a.criado_em,
            beneficiario.nome AS usuario_nome,
            concedente.nome   AS autorizado_por_nome,
            acao.nome         AS acao_nome,
            acao.ativo        AS acao_ativa,
            acao.exige_sst    AS acao_exige_sst,
            acao.modo_autorizacao_individual AS acao_modo
       FROM usuario_autorizacoes a
       JOIN usuarios beneficiario
         ON beneficiario.id = a.usuario_id AND beneficiario.empresa_id = a.empresa_id
       JOIN usuarios concedente
         ON concedente.id = a.autorizado_por AND concedente.empresa_id = a.empresa_id
       JOIN acoes acao ON acao.codigo = a.acao_codigo
      WHERE a.empresa_id = $1
        AND a.usuario_id = $2
        AND ($3::integer IS NULL OR a.autorizado_por = $3)
      ORDER BY acao.codigo, a.criado_em, a.id`,
    [empresaId, usuarioId, concedidasPor],
  );

  return rows.map((linha) => ({
    ...mapear(linha),
    usuarioNome: linha.usuario_nome,
    autorizadoPorNome: linha.autorizado_por_nome,
    acaoNome: linha.acao_nome,
    acaoAtiva: linha.acao_ativa,
    acaoExigeSst: linha.acao_exige_sst,
    acaoModo: linha.acao_modo,
  }));
}

/**
 * Cria uma autorização: direta quando origemId é null, delegada quando
 * informado. Propaga violação de constraint (UNIQUE parcial, FK composta
 * de origem) sem traduzir.
 *
 * @param {{query: Function}} executor
 * @param {{empresaId: number, usuarioId: number, acaoCodigo: string, autorizadoPor: number, podeDelegar?: boolean, origemId?: number|null, motivo?: string|null}} dados
 */
async function criar(executor, {
  empresaId, usuarioId, acaoCodigo, autorizadoPor, podeDelegar = false, origemId = null, motivo = null,
}) {
  exigirEmpresa(empresaId);
  exigirId(usuarioId, 'identificador de usuário');
  exigirAcaoCodigo(acaoCodigo);
  exigirId(autorizadoPor, 'identificador de concedente');
  if (typeof podeDelegar !== 'boolean') {
    throw new TypeError('pode_delegar deve ser booleano');
  }
  if (origemId !== null) {
    exigirId(origemId, 'identificador de origem');
  }
  exigirMotivoOpcional(motivo);

  const { rows } = await executor.query(
    `INSERT INTO usuario_autorizacoes
       (empresa_id, usuario_id, acao_codigo, autorizado_por, pode_delegar, origem_id, motivo)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${PROJECAO}`,
    [empresaId, usuarioId, acaoCodigo, autorizadoPor, podeDelegar, origemId, motivo],
  );

  return mapear(rows[0]);
}

/**
 * Enumera, recursivamente, todos os descendentes de uma autorização — as
 * delegações que nascem dela, direta ou transitivamente. Usada só para
 * compor o registro de auditoria ANTES de excluir: a exclusão em cascata
 * (FK da migration 023) remove essas linhas sem deixar rastro consultável
 * depois. O filtro de empresa é repetido em cada nível da recursão,
 * mesmo a FK composta já impedindo que uma origem tenha descendentes de
 * outra empresa — a leitura não depende só da garantia do banco.
 *
 * @returns {Promise<Array<{id: number, usuarioId: number, acaoCodigo: string, autorizadoPor: number, podeDelegar: boolean, origemId: number}>>}
 */
async function listarDescendentes(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de autorização');

  const { rows } = await executor.query(
    `WITH RECURSIVE descendentes AS (
       SELECT id, usuario_id, acao_codigo, autorizado_por, pode_delegar, origem_id
         FROM usuario_autorizacoes
        WHERE empresa_id = $1 AND origem_id = $2
       UNION ALL
       SELECT f.id, f.usuario_id, f.acao_codigo, f.autorizado_por, f.pode_delegar, f.origem_id
         FROM usuario_autorizacoes f
         JOIN descendentes d ON f.origem_id = d.id
        WHERE f.empresa_id = $1
     )
     SELECT id, usuario_id, acao_codigo, autorizado_por, pode_delegar, origem_id
       FROM descendentes
      ORDER BY id`,
    [empresaId, id],
  );

  return rows.map((linha) => ({
    id: linha.id,
    usuarioId: linha.usuario_id,
    acaoCodigo: linha.acao_codigo,
    autorizadoPor: linha.autorizado_por,
    podeDelegar: linha.pode_delegar,
    origemId: linha.origem_id,
  }));
}

/**
 * Exclui uma autorização da empresa informada. A cascata sobre os
 * descendentes é responsabilidade exclusiva da FK da migration 023 — nada
 * aqui percorre a cadeia para apagar. Devolve a linha excluída, ou null se
 * não existia nesta empresa.
 */
async function excluir(executor, empresaId, id) {
  exigirEmpresa(empresaId);
  exigirId(id, 'identificador de autorização');

  const { rows } = await executor.query(
    `DELETE FROM usuario_autorizacoes WHERE empresa_id = $1 AND id = $2 RETURNING ${PROJECAO}`,
    [empresaId, id],
  );

  return mapear(rows[0]);
}

module.exports = {
  buscarPorId,
  buscarPorIdParaAtualizacao,
  listarPorUsuarioAcaoParaAtualizacao,
  listarPorUsuario,
  criar,
  listarDescendentes,
  excluir,
};
