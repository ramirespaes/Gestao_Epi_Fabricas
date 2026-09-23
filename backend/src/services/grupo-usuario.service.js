'use strict';

const { HttpError } = require('../errors/HttpError');
const usuarioRepo = require('../repositories/usuario.repository');
const grupoRepo = require('../repositories/grupo-acesso.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const autoridade = require('./autoridade-administrativa');

/**
 * Serviço de vinculação de usuários aos grupos de acesso (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3L).
 *
 * Três operações sobre usuarios.grupo_acesso_id (coluna da migration 020):
 * vincular (que também transfere, por substituição), desvincular e listar
 * os usuários de um grupo. As duas de escrita são transacionais e
 * auditadas; a leitura não abre transação.
 *
 * Completa o trio administrativo dos grupos, cada um com seu escopo:
 * grupo-acesso.service (o cadastro do grupo), grupo-permissao.service (o
 * que o grupo permite) e este (quem pertence ao grupo). Nenhum deles
 * invade o do outro: aqui, a ÚNICA coluna escrita em todo o serviço é
 * usuarios.grupo_acesso_id.
 *
 * ARQUITETURA: mesmos padrões já aprovados — `pool` por parâmetro,
 * BEGIN/COMMIT com ROLLBACK em qualquer exceção, módulos chamados por
 * namespace, e a autoridade resolvida no ponto único compartilhado
 * (autoridade-administrativa.js), sem duplicar a regra: MASTER ativo da
 * própria empresa, com perfil RELIDO do banco sob FOR UPDATE. Nenhum
 * `isMaster`, nenhum `perfil` e nenhum identificador empresarial vindos do
 * chamador são aceitos como fonte de autoridade — empresaId e atorId DEVEM
 * vir da sessão autenticada.
 *
 * DUAS PROIBIÇÕES ESPECÍFICAS DESTA SUBETAPA, além da autoridade:
 *   - o ator NÃO altera o próprio grupo, nem para vincular nem para
 *     desvincular: mudar o alcance do próprio acesso é sempre operação de
 *     outra pessoa;
 *   - usuário de perfil MASTER NÃO recebe grupo. MASTER já tem autoridade
 *     empresarial própria e o middleware nem consulta grupo para ele
 *     (Subetapas 3D/3G); vinculá-lo criaria um vínculo sem efeito e
 *     enganoso.
 *
 * REGRA DE SUBSTITUIÇÃO: um usuário tem no máximo um grupo principal.
 * Vincular a outro grupo substitui o vínculo anterior — e nada além disso:
 * nenhuma configuração de nenhum dos dois grupos é lida, alterada ou
 * apagada.
 *
 * RETIRAR PODE AUMENTAR ACESSO: desvincular devolve o usuário ao piso do
 * perfil, respeitando exceções individuais e bloqueios. Se o grupo negava
 * algo (FALSE), retirar o usuário REMOVE essa negação e pode ampliar o que
 * ele alcança. Por isso a operação exige autoridade administrativa e o
 * registro de auditoria diz explicitamente que o piso do perfil volta a
 * valer. Desde a Subetapa 3Q, além do MASTER, também pode executá-la um
 * ADMINISTRADOR expressamente autorizado para ADMINISTRAR_VINCULOS_GRUPO
 * — autorização individual nominal, concedida pelo MASTER, que não lhe
 * dá nenhuma autoridade sobre grupos (3J) ou permissões (3K). A regra
 * vive inteira em autoridade-administrativa.js; este serviço só declara
 * qual ação administrativa está em jogo.
 *
 * GRUPOS INATIVOS: não recebem vínculo NOVO. Quem já estava vinculado
 * quando o grupo foi inativado permanece vinculado — e o MASTER pode
 * retirar ou transferir essas pessoas depois, inclusive para um grupo
 * ativo. Nada aqui reativa grupo nenhum: este serviço nunca escreve em
 * grupos_acesso.
 *
 * USUÁRIOS INATIVOS: não recebem vínculo novo e seus vínculos históricos
 * são preservados como estão. O estado `ativo` do usuário jamais é
 * alterado por este serviço — `ativo` sequer aparece no SET da função de
 * repositório usada aqui.
 *
 * USUÁRIOS NÃO SÃO FUNCIONÁRIOS, E NOME DE GRUPO É SÓ UM RÓTULO: vincular
 * alguém ao grupo chamado "Funcionários" não cria nada em `funcionarios`;
 * vincular ao grupo chamado "SST" não cria vinculo_sst (migration 018
 * segue sendo a única fonte de verdade da SST). Autorizações individuais
 * de ação (usuario_autorizacoes), exceções individuais de recurso
 * (usuario_permissoes_recurso) e bloqueios (usuario_bloqueios) não são
 * lidos nem tocados: continuam valendo exatamente como estavam.
 *
 * CONCORRÊNCIA: a linha do usuário é travada com FOR UPDATE e, quando há
 * grupo de destino, a linha do grupo também — nesta ordem (ator, usuário
 * afetado, grupo), a mesma dos demais serviços administrativos, para que
 * operações concorrentes se serializem em vez de se atropelarem.
 *
 * SEM MUDANÇA EFETIVA, SEM GRAVAÇÃO E SEM AUDITORIA: vincular alguém ao
 * grupo em que já está, ou desvincular quem já não tem grupo, devolve
 * `alterado: false` sem escrever nem auditar.
 *
 * REJEIÇÕES SEM RASTRO: qualquer recusa termina em ROLLBACK, sem gravar em
 * usuarios nem em logs_auditoria.
 *
 * LEITURA TAMBÉM PROTEGIDA (ajuste da Subetapa 3O): listarUsuariosDoGrupo
 * nasceu, na 3L, exigindo só a existência do grupo na empresa informada,
 * sem checar autoridade — correto para o estado da arquitetura na época,
 * quando nada consumia este serviço por HTTP. A Subetapa 3O expõe esta
 * função por rota (GET), e a mesma decisão já tomada para
 * grupo-acesso.service.js (3M) e grupo-permissao.service.js (3N) se
 * aplica aqui: consultar quem está vinculado a um grupo é informação
 * administrativa, então a leitura passa a exigir a mesma autoridade das
 * escritas, pela variante de leitura do ponto único
 * (autoridade-administrativa.js, sem FOR UPDATE). Ajuste mínimo e
 * documentado desta rodada, não uma reabertura da 3L: nenhuma das duas
 * operações de escrita muda, e a única mudança de contrato é o novo
 * parâmetro `atorId`, agora obrigatório na listagem.
 */

const ACAO_AUDITORIA_VINCULO = 'USUARIO_VINCULADO_A_GRUPO';
const ACAO_AUDITORIA_TRANSFERENCIA = 'USUARIO_TRANSFERIDO_DE_GRUPO';
const ACAO_AUDITORIA_DESVINCULO = 'USUARIO_DESVINCULADO_DE_GRUPO';

const MSG_NAO_AUTORIZADO = 'Sem autoridade para administrar vínculos de grupo';
const MSG_USUARIO_NAO_ENCONTRADO = 'Usuário não encontrado';
const MSG_GRUPO_NAO_ENCONTRADO = 'Grupo de acesso não encontrado';
const MSG_AUTOVINCULO = 'Não é possível alterar o próprio grupo de acesso';
const MSG_MASTER_SEM_GRUPO = 'Usuário MASTER não é vinculado a grupo de acesso';
const MSG_USUARIO_INATIVO = 'Usuário inativo não recebe alteração de vínculo de grupo';
const MSG_GRUPO_INATIVO = 'Grupo inativo não recebe novos vínculos';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/**
 * Executa `operacao(client)` dentro de BEGIN/COMMIT, com ROLLBACK em
 * qualquer exceção — HttpError de negócio incluído: uma recusa não deve
 * deixar nada gravado.
 */
async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }
}

/**
 * Trava o usuário afetado e aplica as exigências comuns às duas operações
 * de escrita: existir NESTA empresa, não ser MASTER e estar ativo.
 *
 * O usuário inativo é recusado nas DUAS operações, não só ao vincular: a
 * subetapa manda preservar os vínculos históricos de quem está inativo, e
 * um usuário inativo não autentica (logo, seu vínculo não produz efeito
 * de acesso nenhum enquanto ele estiver assim). Reativá-lo é operação de
 * outro serviço; depois disso, o vínculo volta a poder ser administrado
 * normalmente.
 */
async function carregarUsuarioAdministravel(client, empresaId, usuarioId) {
  const usuario = await usuarioRepo.buscarVinculoGrupoParaAtualizacao(client, empresaId, usuarioId);
  if (usuario === null) {
    throw HttpError.notFound('USUARIO_NAO_ENCONTRADO', MSG_USUARIO_NAO_ENCONTRADO);
  }
  if (usuario.perfil === autoridade.PERFIL_MASTER) {
    throw HttpError.conflict('USUARIO_MASTER_SEM_GRUPO', MSG_MASTER_SEM_GRUPO);
  }
  if (usuario.ativo !== true) {
    throw HttpError.conflict('USUARIO_INATIVO', MSG_USUARIO_INATIVO);
  }
  return usuario;
}

/** Dados do vínculo gravados na auditoria — nada além disto. */
const instantaneo = (grupoAcessoId) => ({ grupoAcessoId });

/**
 * Vincula um usuário a um grupo de acesso da mesma empresa. Se ele já
 * pertencia a outro grupo, o vínculo anterior é SUBSTITUÍDO — nenhuma
 * configuração de nenhum dos dois grupos é alterada.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, atorId: number, usuarioId: number, grupoId: number,
 *          ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @returns {Promise<{usuarioId: number, grupoAnteriorId: number|null, grupoAtualId: number, alterado: boolean}>}
 */
async function vincular(pool, {
  empresaId, atorId, usuarioId, grupoId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');
  exigirId(grupoId, 'identificador de grupo');

  // Falha cedo, sem conexão: ninguém altera o próprio grupo.
  if (usuarioId === atorId) {
    throw HttpError.conflict('AUTOVINCULO_NAO_PERMITIDO', MSG_AUTOVINCULO);
  }

  return emTransacao(pool, async (client) => {
    await autoridade.exigirAutoridadeAdministrativa(client, empresaId, atorId, 'GRUPO_VINCULO_NAO_AUTORIZADO', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO);

    const usuario = await carregarUsuarioAdministravel(client, empresaId, usuarioId);

    // Grupo de outra empresa simplesmente não é encontrado: conhecer o id
    // não dá acesso nenhum. A FK composta da migration 020 impediria a
    // gravação de qualquer forma.
    const grupo = await grupoRepo.buscarPorIdParaAtualizacao(client, empresaId, grupoId);
    if (grupo === null) {
      throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', MSG_GRUPO_NAO_ENCONTRADO);
    }
    if (grupo.ativo !== true) {
      throw HttpError.conflict('GRUPO_INATIVO', MSG_GRUPO_INATIVO);
    }

    const grupoAnteriorId = usuario.grupoAcessoId;
    if (grupoAnteriorId === grupoId) {
      return { usuarioId, grupoAnteriorId, grupoAtualId: grupoId, alterado: false };
    }

    await usuarioRepo.atualizarGrupoAcesso(client, empresaId, usuarioId, grupoId);

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: grupoAnteriorId === null ? ACAO_AUDITORIA_VINCULO : ACAO_AUDITORIA_TRANSFERENCIA,
      referencia: String(usuarioId),
      ip,
      dispositivo,
      contexto: { usuarioAfetado: usuarioId, grupoAnteriorId, grupoAtualId: grupoId },
      dadosAnteriores: instantaneo(grupoAnteriorId),
      dadosNovos: instantaneo(grupoId),
    });

    return { usuarioId, grupoAnteriorId, grupoAtualId: grupoId, alterado: true };
  });
}

/**
 * Retira um usuário do grupo (grupo_acesso_id = NULL). Ele volta ao piso
 * do perfil, respeitando exceções individuais e bloqueios — que não são
 * tocados aqui.
 *
 * Funciona inclusive quando o grupo atual está inativo: é justamente como
 * o MASTER retira alguém de um grupo que foi desativado.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, atorId: number, usuarioId: number, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{usuarioId: number, grupoAnteriorId: number|null, grupoAtualId: null, alterado: boolean}>}
 */
async function desvincular(pool, {
  empresaId, atorId, usuarioId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');

  if (usuarioId === atorId) {
    throw HttpError.conflict('AUTOVINCULO_NAO_PERMITIDO', MSG_AUTOVINCULO);
  }

  return emTransacao(pool, async (client) => {
    await autoridade.exigirAutoridadeAdministrativa(client, empresaId, atorId, 'GRUPO_VINCULO_NAO_AUTORIZADO', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO);

    const usuario = await carregarUsuarioAdministravel(client, empresaId, usuarioId);

    const grupoAnteriorId = usuario.grupoAcessoId;
    if (grupoAnteriorId === null) {
      return { usuarioId, grupoAnteriorId: null, grupoAtualId: null, alterado: false };
    }

    await usuarioRepo.atualizarGrupoAcesso(client, empresaId, usuarioId, null);

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_DESVINCULO,
      referencia: String(usuarioId),
      ip,
      dispositivo,
      // Registrado explicitamente porque é a consequência que importa:
      // sair de um grupo que NEGAVA algo devolve esse acesso ao usuário.
      contexto: {
        usuarioAfetado: usuarioId,
        grupoAnteriorId,
        grupoAtualId: null,
        efeito: 'VOLTA_AO_PISO_DO_PERFIL',
      },
      dadosAnteriores: instantaneo(grupoAnteriorId),
      dadosNovos: instantaneo(null),
    });

    return { usuarioId, grupoAnteriorId, grupoAtualId: null, alterado: true };
  });
}

/**
 * Lista os usuários vinculados a um grupo da empresa autenticada, na
 * projeção pública (sem credencial). Inclui inativos: o vínculo deles
 * continua existindo e precisa ser visível para quem administra.
 *
 * Leitura: não abre transação, mas — desde a Subetapa 3O — exige a MESMA
 * autoridade administrativa das operações de escrita deste serviço,
 * pela variante de leitura do ponto único (autoridade-administrativa.js,
 * sem FOR UPDATE, porque nada será gravado). Continua estritamente
 * isolada por empresa.
 *
 * @param {{empresaId: number, atorId: number, grupoId: number}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @throws {HttpError} 403 sem autoridade; 404 quando o grupo não existe NESTA empresa
 */
async function listarUsuariosDoGrupo(pool, { empresaId, atorId, grupoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(grupoId, 'identificador de grupo');

  await autoridade.exigirAutoridadeAdministrativaLeitura(pool, empresaId, atorId, 'GRUPO_VINCULO_NAO_AUTORIZADO', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO);

  const grupo = await grupoRepo.buscarPorId(pool, empresaId, grupoId);
  if (grupo === null) {
    throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', MSG_GRUPO_NAO_ENCONTRADO);
  }

  return usuarioRepo.listarPorGrupoAcesso(pool, empresaId, grupoId);
}

module.exports = { vincular, desvincular, listarUsuariosDoGrupo };
