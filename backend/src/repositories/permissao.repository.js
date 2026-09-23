'use strict';

/**
 * Repositório de permissões (RBAC).
 *
 * Dez consultas de leitura, cada uma sobre uma tabela distinta do desenho
 * já migrado: permissoes_recurso (acesso a página/módulo, por perfil),
 * permissoes_acao (autorização para uma ação de negócio específica, por
 * perfil), usuario_bloqueios (exceção individual negativa, por cima do
 * que o perfil permitiria), acoes (configuração da própria ação — ativa,
 * se exige SST, modo de autorização individual), vinculo_sst (participação
 * funcional na Segurança do Trabalho), usuario_autorizacoes (exceção
 * individual positiva, contraparte de usuario_bloqueios), grupos_acesso
 * (grupo principal do usuário, migration 020), grupo_permissoes_recurso e
 * grupo_permissoes_acao (permissões configuráveis por grupo, migration 021),
 * e usuario_permissoes_recurso (exceção individual de recurso, por cima do
 * que perfil e grupo permitiriam, migration 022).
 *
 * Este módulo não decide nada: não define default-allow nem default-deny,
 * não dá tratamento especial a nenhum perfil (MASTER incluído) e não
 * combina as consultas entre si — quem combina é a camada de autorização
 * (src/middleware/autorizacao.js). Ausência de registro em
 * permissoes_recurso/permissoes_acao/acoes/grupo_permissoes_recurso/
 * grupo_permissoes_acao/usuario_permissoes_recurso vira `null`, não `false`
 * nem `true` — a decisão de como interpretar `null` pertence a quem for
 * coordenar autorização, não ao repositório. Isso vale também para as
 * colunas tri-state de grupo_permissoes_recurso/grupo_permissoes_acao/
 * usuario_permissoes_recurso (NULL/true/false persistidos, devolvidos
 * exatamente como estão) e para o
 * estado `ativo` de um grupo: esta camada de leitura NUNCA decide o que um
 * grupo inativo significa para a autorização — só informa o estado bruto
 * (`ativo: false`), a interpretação (ex.: "FALSE do grupo continua negando,
 * TRUE não concede") é responsabilidade da camada de autorização
 * (src/middleware/autorizacao.js), que a implementa desde a Subetapa 3D —
 * nunca deste repositório. O mesmo vale para
 * usuario_permissoes_recurso: a existência de uma linha, ou de um campo
 * `true`/`false` dentro dela, não produz nenhum efeito de autorização nesta
 * subetapa — só passa a ser lida, exatamente como aconteceu com
 * grupo_permissoes_recurso/grupo_permissoes_acao na Subetapa 3C antes de a
 * Subetapa 3D integrá-las ao middleware.
 *
 * empresaId é sempre o filtro de isolamento e nunca é opcional, seguindo o
 * padrão já fixado em usuario.repository.js — com a única exceção de
 * buscarConfiguracaoAcao, que lê o catálogo `acoes` (migration 003),
 * compartilhado por todas as empresas; o que É por empresa é a PERMISSÃO
 * sobre a ação (permissoes_acao), nunca a ação em si. usuario_bloqueios não
 * tem coluna empresa_id própria: o filtro chega pelo JOIN com usuarios, do
 * mesmo jeito que estoque_tamanhos já faz (ver comentário da migration
 * 011). vinculo_sst, usuario_autorizacoes, grupo_permissoes_recurso,
 * grupo_permissoes_acao e usuario_permissoes_recurso (migrations
 * 018/019/021/022) já carregam empresa_id próprio, garantido por FK
 * composta contra concessão cruzada entre empresas — não precisam de JOIN
 * para o isolamento; buscarGrupoAcessoDoUsuario é a exceção, porque parte
 * de usuarios (que não tem empresa_id "próprio" de um grupo) e por isso faz
 * um JOIN explícito com grupos_acesso, repetindo o filtro de empresa mesmo
 * sabendo que a FK composta de 020 já impede a divergência — mesma
 * disciplina já usada em sessao.repository.js.
 *
 * IMPORTANTE: nada aqui confunde um grupo chamado "SST" com participação
 * real na SST. buscarGrupoAcessoDoUsuario/buscarPermissaoRecursoGrupo/
 * buscarPermissaoAcaoGrupo não têm nenhuma relação com usuarioIntegraSst —
 * são sistemas de dados totalmente independentes, mesmo que uma empresa
 * decida nomear um grupo "Administração SST". Só vinculo_sst determina
 * participação na SST.
 *
 * Sem INSERT/UPDATE/DELETE: esta etapa é somente leitura.
 */

// perfis.codigo e acoes.codigo não têm CHECK de formato no banco (só FK +
// VARCHAR(n)); o formato maiúsculo é contrato de aplicação, o mesmo usado
// por codigoCatalogo em src/schemas/campos.schema.js.
const FORMATO_PERFIL = /^[A-Z][A-Z0-9_]{0,19}$/;
const FORMATO_ACAO_CODIGO = /^[A-Z][A-Z0-9_]{0,59}$/;
// "recurso" usa os identificadores de página do frontend ('dashboard',
// 'materials', 'userAdmin'), não o formato maiúsculo do catálogo — não há
// CHECK correspondente na migration 009, só VARCHAR(60) NOT NULL.
const FORMATO_RECURSO = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;

function exigirEmpresa(empresaId) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

function exigirUsuario(usuarioId) {
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
    throw new TypeError('identificador de usuário inválido');
  }
}

function exigirPerfil(perfil) {
  if (typeof perfil !== 'string' || !FORMATO_PERFIL.test(perfil)) {
    throw new TypeError('perfil inválido');
  }
}

function exigirRecurso(recurso) {
  if (typeof recurso !== 'string' || !FORMATO_RECURSO.test(recurso)) {
    throw new TypeError('recurso inválido');
  }
}

function exigirAcaoCodigo(acaoCodigo) {
  if (typeof acaoCodigo !== 'string' || !FORMATO_ACAO_CODIGO.test(acaoCodigo)) {
    throw new TypeError('código de ação inválido');
  }
}

function exigirGrupoAcesso(grupoAcessoId) {
  if (!Number.isInteger(grupoAcessoId) || grupoAcessoId <= 0) {
    throw new TypeError('identificador de grupo de acesso inválido');
  }
}

/**
 * Busca a permissão de recurso (página/módulo) de um perfil, dentro de uma
 * empresa.
 *
 * Os quatro booleanos são devolvidos exatamente como persistidos: um
 * registro com `pode_visualizar = false` continua `false`, nunca é tratado
 * como ausente nem convertido para `true`. Só a ausência da linha vira
 * `null` — a distinção entre "negado explicitamente" e "sem regra" fica
 * preservada para quem chamar esta função.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {string} perfil código de perfis.codigo
 * @param {string} recurso identificador de página/módulo
 * @returns {Promise<{podeVisualizar: boolean, podeCriar: boolean, podeEditar: boolean, podeExcluir: boolean}|null>}
 */
async function buscarPermissaoRecurso(executor, empresaId, perfil, recurso) {
  exigirEmpresa(empresaId);
  exigirPerfil(perfil);
  exigirRecurso(recurso);

  const { rows } = await executor.query(
    `SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir
       FROM permissoes_recurso
      WHERE empresa_id = $1 AND perfil = $2 AND recurso = $3`,
    [empresaId, perfil, recurso],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return {
    podeVisualizar: linha.pode_visualizar,
    podeCriar: linha.pode_criar,
    podeEditar: linha.pode_editar,
    podeExcluir: linha.pode_excluir,
  };
}

/**
 * Busca a permissão de ação de negócio de um perfil, dentro de uma empresa.
 *
 * `permitido` é devolvido tal como persistido, `false` incluído. Só a
 * ausência de linha devolve `null`.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {string} perfil código de perfis.codigo
 * @param {string} acaoCodigo código de acoes.codigo
 * @returns {Promise<{permitido: boolean}|null>}
 */
async function buscarPermissaoAcao(executor, empresaId, perfil, acaoCodigo) {
  exigirEmpresa(empresaId);
  exigirPerfil(perfil);
  exigirAcaoCodigo(acaoCodigo);

  const { rows } = await executor.query(
    `SELECT permitido
       FROM permissoes_acao
      WHERE empresa_id = $1 AND perfil = $2 AND acao_codigo = $3`,
    [empresaId, perfil, acaoCodigo],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return { permitido: linha.permitido };
}

/**
 * Indica se um usuário específico tem bloqueio individual para uma ação,
 * dentro da empresa informada.
 *
 * usuario_bloqueios não tem empresa_id próprio; o isolamento vem do JOIN com
 * usuarios, filtrando por usuarios.empresa_id — não basta o usuario_id
 * bater, a linha de usuarios também precisa pertencer à empresa consultada.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} usuarioId
 * @param {string} acaoCodigo código de acoes.codigo
 * @returns {Promise<boolean>}
 */
async function usuarioTemBloqueio(executor, empresaId, usuarioId, acaoCodigo) {
  exigirEmpresa(empresaId);
  exigirUsuario(usuarioId);
  exigirAcaoCodigo(acaoCodigo);

  const { rows } = await executor.query(
    `SELECT 1
       FROM usuario_bloqueios ub
       JOIN usuarios u ON u.id = ub.usuario_id
      WHERE u.empresa_id = $1 AND ub.usuario_id = $2 AND ub.acao_codigo = $3`,
    [empresaId, usuarioId, acaoCodigo],
  );

  return rows.length > 0;
}

/**
 * Busca a configuração de autorização de uma ação no catálogo: se está
 * ativa, se exige participação na SST e o modo de autorização individual
 * (migration 017). Não é filtrada por empresa — o catálogo `acoes` é
 * compartilhado por todas as empresas; a PERMISSÃO sobre a ação (não a
 * ação em si) é o que é por empresa, e continua em buscarPermissaoAcao.
 *
 * @param {{query: Function}} executor
 * @param {string} acaoCodigo código de acoes.codigo
 * @returns {Promise<{ativo: boolean, exigeSst: boolean, modoAutorizacaoIndividual: string}|null>}
 */
async function buscarConfiguracaoAcao(executor, acaoCodigo) {
  exigirAcaoCodigo(acaoCodigo);

  const { rows } = await executor.query(
    'SELECT ativo, exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo = $1',
    [acaoCodigo],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return {
    ativo: linha.ativo,
    exigeSst: linha.exige_sst,
    modoAutorizacaoIndividual: linha.modo_autorizacao_individual,
  };
}

/**
 * Lista o catálogo de ações inteiro (migrations 003/017/024), ordenado
 * pelo código. Mesma tabela e mesmas colunas de buscarConfiguracaoAcao,
 * que lê UMA ação: as duas ficam juntas para que toda leitura de `acoes`
 * tenha um lugar só. Também não é filtrada por empresa, pela mesma razão
 * — o catálogo é compartilhado; o que é por empresa é a PERMISSÃO sobre
 * a ação.
 *
 * Existe desde a Subetapa 3T, quando a tela de permissões de grupo
 * precisou apresentar as opções configuráveis: sem isso, o frontend
 * teria de manter uma cópia manual dos códigos, que sairia de sincronia
 * na primeira migration a acrescentar ou desativar uma ação — foi
 * exatamente o que a 024 fez. `modoAutorizacaoIndividual` acompanha cada
 * linha porque a 3K só aceita conceder ou negar por grupo em ações
 * ALTERNATIVA: quem monta a tela precisa saber disso ANTES de oferecer a
 * opção.
 *
 * Continua sendo leitura pura: este módulo segue sem INSERT/UPDATE/DELETE.
 *
 * @returns {Promise<Array<{codigo: string, nome: string, descricao: string|null, ativo: boolean, exigeSst: boolean, modoAutorizacaoIndividual: string}>>}
 */
async function listarAcoes(executor) {
  const { rows } = await executor.query(
    `SELECT codigo, nome, descricao, ativo, exige_sst, modo_autorizacao_individual
       FROM acoes
      ORDER BY codigo`,
  );

  return rows.map((linha) => ({
    codigo: linha.codigo,
    nome: linha.nome,
    descricao: linha.descricao,
    ativo: linha.ativo,
    exigeSst: linha.exige_sst,
    modoAutorizacaoIndividual: linha.modo_autorizacao_individual,
  }));
}

/**
 * Indica se um usuário integra a Segurança do Trabalho (SST) na empresa
 * informada (migration 018). vinculo_sst já carrega empresa_id próprio,
 * garantido pela FK composta contra concessão cruzada entre empresas — não
 * precisa de JOIN com usuarios para o isolamento, diferente de
 * usuarioTemBloqueio.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} usuarioId
 * @returns {Promise<boolean>}
 */
async function usuarioIntegraSst(executor, empresaId, usuarioId) {
  exigirEmpresa(empresaId);
  exigirUsuario(usuarioId);

  const { rows } = await executor.query(
    'SELECT 1 FROM vinculo_sst WHERE empresa_id = $1 AND usuario_id = $2',
    [empresaId, usuarioId],
  );

  return rows.length > 0;
}

/**
 * Indica se um usuário tem autorização individual (positiva) para uma ação
 * específica, dentro da empresa informada (migration 019). Contraparte de
 * usuarioTemBloqueio: lá a existência da linha nega, aqui a existência da
 * linha concede — nunca sozinha, sempre combinada pela camada de
 * autorização com o modo (NENHUMA/ALTERNATIVA/OBRIGATORIA) daquela ação.
 * usuario_autorizacoes já carrega empresa_id próprio, mesma razão de
 * usuarioIntegraSst.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} usuarioId
 * @param {string} acaoCodigo código de acoes.codigo
 * @returns {Promise<boolean>}
 */
async function usuarioTemAutorizacaoIndividual(executor, empresaId, usuarioId, acaoCodigo) {
  exigirEmpresa(empresaId);
  exigirUsuario(usuarioId);
  exigirAcaoCodigo(acaoCodigo);

  const { rows } = await executor.query(
    'SELECT 1 FROM usuario_autorizacoes WHERE empresa_id = $1 AND usuario_id = $2 AND acao_codigo = $3',
    [empresaId, usuarioId, acaoCodigo],
  );

  return rows.length > 0;
}

/**
 * Busca o grupo de acesso principal de um usuário, dentro da empresa
 * informada (migration 020). Devolve `null` quando o usuário não tem grupo
 * (`usuarios.grupo_acesso_id IS NULL`) — nunca presume um grupo "padrão".
 *
 * O JOIN repete o filtro de empresa no próprio grupo (`g.empresa_id = $1`),
 * mesmo a FK composta de 020 já impedindo estruturalmente que um usuário
 * aponte para um grupo de outra empresa — mesma disciplina de "a leitura
 * não depende só da garantia do banco" já usada em sessao.repository.js.
 *
 * `ativo` é devolvido tal como persistido, sem nenhuma interpretação: esta
 * função não decide o que um grupo inativo significa para a autorização,
 * só informa o estado.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} usuarioId
 * @returns {Promise<{id: number, ativo: boolean}|null>}
 */
async function buscarGrupoAcessoDoUsuario(executor, empresaId, usuarioId) {
  exigirEmpresa(empresaId);
  exigirUsuario(usuarioId);

  const { rows } = await executor.query(
    `SELECT g.id, g.ativo
       FROM usuarios u
       JOIN grupos_acesso g ON g.id = u.grupo_acesso_id AND g.empresa_id = u.empresa_id
      WHERE u.empresa_id = $1 AND u.id = $2`,
    [empresaId, usuarioId],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return { id: linha.id, ativo: linha.ativo };
}

/**
 * Busca a permissão de recurso configurada para um grupo de acesso, dentro
 * da empresa informada (migration 021).
 *
 * Cada um dos quatro campos é tri-state e devolvido exatamente como
 * persistido — `null` (o grupo não tem opinião sobre aquela operação,
 * decisão cabe ao perfil), `true` (o grupo concede) ou `false` (o grupo
 * nega). Só a ausência da LINHA inteira (nenhuma configuração para este
 * grupo+recurso) devolve `null` no retorno geral da função — não confundir
 * com um campo individual sendo `null` dentro de uma linha existente.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} grupoAcessoId
 * @param {string} recurso identificador de página/módulo
 * @returns {Promise<{podeVisualizar: boolean|null, podeCriar: boolean|null, podeEditar: boolean|null, podeExcluir: boolean|null}|null>}
 */
async function buscarPermissaoRecursoGrupo(executor, empresaId, grupoAcessoId, recurso) {
  exigirEmpresa(empresaId);
  exigirGrupoAcesso(grupoAcessoId);
  exigirRecurso(recurso);

  const { rows } = await executor.query(
    `SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir
       FROM grupo_permissoes_recurso
      WHERE empresa_id = $1 AND grupo_acesso_id = $2 AND recurso = $3`,
    [empresaId, grupoAcessoId, recurso],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return {
    podeVisualizar: linha.pode_visualizar,
    podeCriar: linha.pode_criar,
    podeEditar: linha.pode_editar,
    podeExcluir: linha.pode_excluir,
  };
}

/**
 * Busca a permissão de ação de negócio configurada para um grupo de
 * acesso, dentro da empresa informada (migration 021).
 *
 * `permitido` é tri-state, devolvido exatamente como persistido — `null`
 * (o grupo não tem opinião, decisão cabe ao perfil), `true` (concede) ou
 * `false` (nega). Só a ausência da linha devolve `null` no retorno geral.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} grupoAcessoId
 * @param {string} acaoCodigo código de acoes.codigo
 * @returns {Promise<{permitido: boolean|null}|null>}
 */
async function buscarPermissaoAcaoGrupo(executor, empresaId, grupoAcessoId, acaoCodigo) {
  exigirEmpresa(empresaId);
  exigirGrupoAcesso(grupoAcessoId);
  exigirAcaoCodigo(acaoCodigo);

  const { rows } = await executor.query(
    `SELECT permitido
       FROM grupo_permissoes_acao
      WHERE empresa_id = $1 AND grupo_acesso_id = $2 AND acao_codigo = $3`,
    [empresaId, grupoAcessoId, acaoCodigo],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return { permitido: linha.permitido };
}

/**
 * Busca a exceção individual de permissão de recurso de um usuário, dentro
 * da empresa informada (migration 022) — o último elo da cadeia de
 * override desenhada para recurso (perfil -> grupo -> usuário).
 *
 * Mesmo contrato tri-state de buscarPermissaoRecursoGrupo, agora por
 * usuario_id em vez de grupo_acesso_id: cada um dos quatro campos é
 * devolvido exatamente como persistido — `null` (o usuário não tem exceção
 * naquela operação, decisão cabe a grupo/perfil), `true` (concede
 * individualmente) ou `false` (nega individualmente). Só a ausência da
 * LINHA inteira (nenhuma exceção para este usuário+recurso) devolve `null`
 * no retorno geral da função — não confundir com um campo individual sendo
 * `null` dentro de uma linha existente. usuario_permissoes_recurso já
 * carrega empresa_id próprio, garantido por FK composta contra concessão
 * cruzada entre empresas (mesma razão de usuarioIntegraSst/
 * buscarPermissaoRecursoGrupo) — não precisa de JOIN para o isolamento.
 *
 * @param {{query: Function}} executor
 * @param {number} empresaId
 * @param {number} usuarioId
 * @param {string} recurso identificador de página/módulo
 * @returns {Promise<{podeVisualizar: boolean|null, podeCriar: boolean|null, podeEditar: boolean|null, podeExcluir: boolean|null}|null>}
 */
async function buscarPermissaoRecursoIndividual(executor, empresaId, usuarioId, recurso) {
  exigirEmpresa(empresaId);
  exigirUsuario(usuarioId);
  exigirRecurso(recurso);

  const { rows } = await executor.query(
    `SELECT pode_visualizar, pode_criar, pode_editar, pode_excluir
       FROM usuario_permissoes_recurso
      WHERE empresa_id = $1 AND usuario_id = $2 AND recurso = $3`,
    [empresaId, usuarioId, recurso],
  );

  const linha = rows[0];
  if (linha === undefined) {
    return null;
  }

  return {
    podeVisualizar: linha.pode_visualizar,
    podeCriar: linha.pode_criar,
    podeEditar: linha.pode_editar,
    podeExcluir: linha.pode_excluir,
  };
}

module.exports = {
  buscarPermissaoRecurso,
  buscarPermissaoAcao,
  usuarioTemBloqueio,
  buscarConfiguracaoAcao,
  listarAcoes,
  usuarioIntegraSst,
  usuarioTemAutorizacaoIndividual,
  buscarGrupoAcessoDoUsuario,
  buscarPermissaoRecursoGrupo,
  buscarPermissaoAcaoGrupo,
  buscarPermissaoRecursoIndividual,
};
