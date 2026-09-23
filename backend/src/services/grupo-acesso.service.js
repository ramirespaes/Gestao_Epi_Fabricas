'use strict';

const { HttpError } = require('../errors/HttpError');
const grupoRepo = require('../repositories/grupo-acesso.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const autoridade = require('./autoridade-administrativa');

/**
 * Serviço de gestão dos grupos de acesso (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3J).
 *
 * Seis operações sobre grupos_acesso (migration 020): criar, buscar,
 * listar, alterar (nome/descrição), inativar e reativar. As quatro de
 * escrita são transacionais e auditadas; as duas de leitura não gravam
 * nada e não abrem transação.
 *
 * ARQUITETURA: mesmo padrão de login.service.js e
 * autorizacao-individual.service.js — `pool` por parâmetro (nunca importa
 * src/config/database.js), BEGIN/COMMIT explícito com ROLLBACK em
 * qualquer exceção, e módulos chamados por `modulo.funcao(...)`, nunca
 * desestruturados (permite mock.method nos testes sem afetar produção).
 *
 * AUTORIDADE NUNCA CONFIADA DO CHAMADOR: toda operação de escrita recebe
 * o id de quem age e o da empresa, e os revalida contra o banco sob FOR
 * UPDATE — existência, `ativo` e `perfil` relidos, nunca um flag
 * "isMaster" recebido de fora. Nesta subetapa não há rota HTTP nem
 * controller; o contrato é que `empresaId` e `atorId` DEVEM vir do
 * contexto autenticado (sessão) de quem um dia chamar este serviço, nunca
 * de um formulário.
 *
 * AUTORIDADE ADMINISTRATIVA, CONCENTRADA NUM PONTO SÓ: a verificação
 * está em exigirAutoridadeAdministrativa() — um único ponto,
 * deliberadamente. Na 3J ela exigia MASTER ativo da própria empresa; na
 * Subetapa 3Q, ADMINISTRADORES expressamente autorizados pelo MASTER
 * passaram a poder gerenciar grupos, e a mudança aconteceu inteiramente
 * ali dentro (consulta à autorização individual da ação administrativa
 * correspondente, ADMINISTRAR_GRUPOS_ACESSO), sem tocar em nenhuma das
 * seis operações abaixo — exatamente a propriedade que a 3J criou ao
 * concentrar a regra. Continua valendo que nada aqui concede autoridade
 * a um ADMINISTRADOR só por ele ter esse perfil: sem uma autorização
 * individual nominal para ESTA ação, ele é recusado como qualquer outro
 * não-MASTER; e essa autorização não lhe dá autoridade sobre permissões
 * de grupo (3K) nem sobre vínculos (3L), que têm ações próprias.
 *
 * O QUE ESTE SERVIÇO NÃO FAZ, por decisão explícita da subetapa:
 *   - não exclui grupos fisicamente (não existe DELETE no repositório);
 *   - não toca grupo_permissoes_recurso, grupo_permissoes_acao nem
 *     usuarios.grupo_acesso_id: inativar um grupo NÃO apaga permissões
 *     nem desvincula usuários. A leitura de autorização já sabe lidar com
 *     grupo inativo (FALSE continua negando, TRUE deixa de conceder, NULL
 *     herda — middleware, Subetapa 3D), e é justamente por reativar poder
 *     restaurar concessões TRUE antes suspensas que a reativação exige a
 *     mesma autoridade da criação e é auditada;
 *   - não cria nada automaticamente. Um grupo chamado "SST" não cria
 *     vinculo_sst (só a tabela vinculo_sst, migration 018, determina
 *     participação na SST); um grupo chamado "Funcionários" não cria
 *     usuário nem funcionário. Nome de grupo é rótulo livre da empresa,
 *     sem nenhum significado especial para o backend;
 *   - não altera permissões de grupo, não vincula usuários a grupos, não
 *     expõe rotas HTTP — tudo isso é escopo de rodadas futuras.
 *
 * REJEIÇÕES SEM RASTRO: uma tentativa recusada termina em ROLLBACK e não
 * grava nada, nem em grupos_acesso nem em logs_auditoria. Só operações
 * que de fato aconteceram são auditadas, na mesma transação da escrita:
 * ou as duas gravam, ou nenhuma.
 */

const VIOLACAO_UNIQUE = '23505';

const ACAO_AUDITORIA_CRIACAO = 'GRUPO_ACESSO_CRIADO';
const ACAO_AUDITORIA_ALTERACAO = 'GRUPO_ACESSO_ALTERADO';
const ACAO_AUDITORIA_INATIVACAO = 'GRUPO_ACESSO_INATIVADO';
const ACAO_AUDITORIA_REATIVACAO = 'GRUPO_ACESSO_REATIVADO';

const MSG_NAO_AUTORIZADO = 'Sem autoridade para administrar grupos de acesso';
const MSG_NOME_INVALIDO = 'Nome de grupo inválido';
const MSG_NOME_EM_USO = 'Já existe um grupo com este nome nesta empresa';
const MSG_GRUPO_NAO_ENCONTRADO = 'Grupo de acesso não encontrado';
const MSG_SEM_ALTERACAO = 'Nenhum campo para alterar';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/**
 * Normaliza o nome antes de qualquer validação ou gravação: apenas apara
 * espaços das pontas, sem mexer em maiúsculas/minúsculas nem em acentos —
 * a empresa escolhe como o nome aparece. A unicidade sem diferenciar
 * maiúsculas é garantida pelo índice funcional da migration 020, não por
 * uma transformação do texto guardado.
 */
function normalizarNome(nome) {
  if (typeof nome !== 'string') {
    return null;
  }
  const aparado = nome.trim();
  if (aparado.length === 0 || aparado.length > grupoRepo.TAMANHO_MAXIMO_NOME) {
    return null;
  }
  return aparado;
}

/** Descrição opcional: aparada, e string vazia equivale a ausência (null). */
function normalizarDescricao(descricao) {
  if (descricao === null || descricao === undefined) {
    return null;
  }
  if (typeof descricao !== 'string') {
    throw new TypeError('descrição deve ser string ou null');
  }
  const aparada = descricao.trim();
  return aparada.length === 0 ? null : aparada;
}

/**
 * Autoridade administrativa: MASTER ativo da própria empresa, com perfil
 * relido do banco. A regra vive em src/services/autoridade-administrativa.js
 * desde a Subetapa 3K, quando a configuração de permissões de grupo passou
 * a precisar exatamente dela — continua sendo um ponto único de decisão,
 * agora compartilhado, que é o que permitirá acrescentar ADMINISTRADORES
 * expressamente autorizados sem alterar nenhuma operação.
 */
async function exigirAutoridadeAdministrativa(client, empresaId, atorId) {
  return autoridade.exigirAutoridadeAdministrativa(client, empresaId, atorId, 'GRUPO_NAO_AUTORIZADO', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.GRUPOS_ACESSO);
}

/**
 * Executa `operacao(client)` dentro de BEGIN/COMMIT, com ROLLBACK em
 * qualquer exceção — HttpError de negócio incluído, de propósito: uma
 * recusa não deve deixar nada gravado.
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

/** Dados do grupo gravados na auditoria — nunca mais do que isto. */
const instantaneo = (grupo) => ({
  nome: grupo.nome,
  descricao: grupo.descricao,
  ativo: grupo.ativo,
});

/**
 * Cria um grupo de acesso na empresa do ator.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, atorId: number, nome: string, descricao?: string|null, ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @returns {Promise<{id: number, empresaId: number, nome: string, descricao: string|null, ativo: boolean, criadoPor: number, criadoEm: Date, atualizadoEm: Date}>}
 */
async function criar(pool, {
  empresaId, atorId, nome, descricao = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  const nomeNormalizado = normalizarNome(nome);
  const descricaoNormalizada = normalizarDescricao(descricao);

  return emTransacao(pool, async (client) => {
    await exigirAutoridadeAdministrativa(client, empresaId, atorId);

    // Depois da autoridade: quem não pode administrar não recebe retorno
    // diferente por ter mandado um nome inválido.
    if (nomeNormalizado === null) {
      throw HttpError.badRequest('GRUPO_NOME_INVALIDO', MSG_NOME_INVALIDO);
    }

    let grupo;
    try {
      grupo = await grupoRepo.criar(client, {
        empresaId, nome: nomeNormalizado, descricao: descricaoNormalizada, criadoPor: atorId,
      });
    } catch (erro) {
      // uq_grupos_acesso_empresa_nome_lower: nome já usado NESTA empresa,
      // sem diferenciar maiúsculas — e continua reservado mesmo se o
      // grupo homônimo estiver inativo (migration 020).
      if (erro.code === VIOLACAO_UNIQUE) {
        throw HttpError.conflict('GRUPO_NOME_EM_USO', MSG_NOME_EM_USO);
      }
      throw erro;
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_CRIACAO,
      referencia: String(grupo.id),
      ip,
      dispositivo,
      contexto: { criadoPor: atorId },
      dadosNovos: instantaneo(grupo),
    });

    return grupo;
  });
}

/**
 * Busca um grupo da empresa informada.
 *
 * Leitura: não abre transação. Desde a Subetapa 3M exige a MESMA autoridade
 * administrativa das operações de escrita — a lista de grupos de uma
 * empresa e sua configuração são informação administrativa, e as rotas
 * HTTP precisavam dessa proteção também nas consultas. O critério é o
 * mesmo ponto único (autoridade-administrativa.js), na variante de leitura
 * (sem FOR UPDATE, porque nada será gravado). Continua estritamente
 * isolada por empresa: um id de outra empresa simplesmente não é
 * encontrado.
 *
 * @returns {Promise<object>} o grupo
 * @throws {HttpError} 403 sem autoridade; 404 quando não existe NESTA empresa
 */
async function buscar(pool, { empresaId, atorId, grupoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(grupoId, 'identificador de grupo');

  await autoridade.exigirAutoridadeAdministrativaLeitura(pool, empresaId, atorId, 'GRUPO_NAO_AUTORIZADO', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.GRUPOS_ACESSO);

  const grupo = await grupoRepo.buscarPorId(pool, empresaId, grupoId);
  if (grupo === null) {
    throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', MSG_GRUPO_NAO_ENCONTRADO);
  }
  return grupo;
}

/**
 * Lista os grupos da empresa. `ativo` omitido ou null devolve ativos E
 * inativos; true ou false filtram explicitamente. Exige a mesma autoridade
 * administrativa de buscar(), pela mesma razão (Subetapa 3M).
 *
 * @param {{empresaId: number, atorId: number, ativo?: boolean|null}} dados
 * @returns {Promise<Array<object>>}
 */
async function listar(pool, { empresaId, atorId, ativo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('filtro ativo deve ser booleano ou null');
  }

  await autoridade.exigirAutoridadeAdministrativaLeitura(pool, empresaId, atorId, 'GRUPO_NAO_AUTORIZADO', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.GRUPOS_ACESSO);

  return grupoRepo.listarPorEmpresa(pool, empresaId, { ativo });
}

/**
 * Altera nome e/ou descrição de um grupo. `ativo` NÃO é alterável por
 * aqui: inativar e reativar têm funções próprias, para que a auditoria
 * distinga a operação e para que a reativação — que pode restaurar
 * concessões TRUE antes suspensas — nunca aconteça de carona numa
 * renomeação.
 *
 * Campos ausentes permanecem como estão. `descricao: null` explícito
 * limpa a descrição; `descricao` ausente não a toca.
 *
 * @param {{empresaId: number, atorId: number, grupoId: number, nome?: string, descricao?: string|null, ip?: string|null, dispositivo?: string|null}} dados
 */
async function alterar(pool, {
  empresaId, atorId, grupoId, nome, descricao, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(grupoId, 'identificador de grupo');

  const alterarNome = nome !== undefined;
  const alterarDescricao = descricao !== undefined;
  const nomeNormalizado = alterarNome ? normalizarNome(nome) : null;
  const descricaoNormalizada = alterarDescricao ? normalizarDescricao(descricao) : null;

  return emTransacao(pool, async (client) => {
    await exigirAutoridadeAdministrativa(client, empresaId, atorId);

    if (!alterarNome && !alterarDescricao) {
      throw HttpError.badRequest('GRUPO_SEM_ALTERACAO', MSG_SEM_ALTERACAO);
    }
    if (alterarNome && nomeNormalizado === null) {
      throw HttpError.badRequest('GRUPO_NOME_INVALIDO', MSG_NOME_INVALIDO);
    }

    const anterior = await grupoRepo.buscarPorIdParaAtualizacao(client, empresaId, grupoId);
    if (anterior === null) {
      throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', MSG_GRUPO_NAO_ENCONTRADO);
    }

    let atualizado;
    try {
      atualizado = await grupoRepo.atualizar(client, empresaId, grupoId, {
        nome: nomeNormalizado,
        descricao: descricaoNormalizada,
        descricaoInformada: alterarDescricao,
      });
    } catch (erro) {
      if (erro.code === VIOLACAO_UNIQUE) {
        throw HttpError.conflict('GRUPO_NOME_EM_USO', MSG_NOME_EM_USO);
      }
      throw erro;
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_ALTERACAO,
      referencia: String(grupoId),
      ip,
      dispositivo,
      contexto: { camposAlterados: [...(alterarNome ? ['nome'] : []), ...(alterarDescricao ? ['descricao'] : [])] },
      dadosAnteriores: instantaneo(anterior),
      dadosNovos: instantaneo(atualizado),
    });

    return atualizado;
  });
}

/**
 * Muda o estado `ativo` de um grupo, auditando com a ação específica
 * (inativação ou reativação). Idempotente: pedir o estado que o grupo já
 * tem não grava nada e não audita — devolve o grupo como está, com
 * `alterado: false`.
 *
 * Nada além da coluna `ativo` é tocado: permissões do grupo
 * (grupo_permissoes_recurso/grupo_permissoes_acao) e vínculos de usuários
 * (usuarios.grupo_acesso_id) permanecem exatamente como estavam.
 */
async function alterarEstado(pool, { empresaId, atorId, grupoId, ativo, ip, dispositivo }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(grupoId, 'identificador de grupo');

  return emTransacao(pool, async (client) => {
    await exigirAutoridadeAdministrativa(client, empresaId, atorId);

    const anterior = await grupoRepo.buscarPorIdParaAtualizacao(client, empresaId, grupoId);
    if (anterior === null) {
      throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', MSG_GRUPO_NAO_ENCONTRADO);
    }

    if (anterior.ativo === ativo) {
      return { grupo: anterior, alterado: false };
    }

    const atualizado = await grupoRepo.atualizar(client, empresaId, grupoId, { ativo });

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ativo ? ACAO_AUDITORIA_REATIVACAO : ACAO_AUDITORIA_INATIVACAO,
      referencia: String(grupoId),
      ip,
      dispositivo,
      // Registrado explicitamente porque é a consequência que importa na
      // reativação: concessões TRUE do grupo, suspensas enquanto inativo,
      // voltam a valer para quem estiver vinculado a ele.
      contexto: { efeito: ativo ? 'CONCESSOES_DO_GRUPO_VOLTAM_A_VALER' : 'CONCESSOES_DO_GRUPO_SUSPENSAS' },
      dadosAnteriores: instantaneo(anterior),
      dadosNovos: instantaneo(atualizado),
    });

    return { grupo: atualizado, alterado: true };
  });
}

/**
 * Inativa um grupo. Não apaga permissões nem desvincula usuários: o grupo
 * continua existindo e vinculado, e a autorização passa a tratá-lo como
 * inativo (FALSE continua negando, TRUE deixa de conceder, NULL herda).
 *
 * @returns {Promise<{grupo: object, alterado: boolean}>}
 */
async function inativar(pool, { empresaId, atorId, grupoId, ip = null, dispositivo = null }) {
  return alterarEstado(pool, { empresaId, atorId, grupoId, ativo: false, ip, dispositivo });
}

/**
 * Reativa um grupo. Exige a mesma autoridade da criação e é auditada com
 * ação própria, justamente porque pode restaurar concessões TRUE que
 * estavam suspensas enquanto o grupo esteve inativo.
 *
 * @returns {Promise<{grupo: object, alterado: boolean}>}
 */
async function reativar(pool, { empresaId, atorId, grupoId, ip = null, dispositivo = null }) {
  return alterarEstado(pool, { empresaId, atorId, grupoId, ativo: true, ip, dispositivo });
}

module.exports = {
  criar,
  buscar,
  listar,
  alterar,
  inativar,
  reativar,
};
